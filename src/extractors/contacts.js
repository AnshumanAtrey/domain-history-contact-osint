/**
 * Contact extraction from HTML.
 *
 * The de-obfuscation branches and false-positive filter lists are ported from
 * WayTrace (MIT, (c) 2024-2026 thomashousset), whose author measured the numbers
 * that justify them. Two worth quoting because they are not obvious:
 *
 *  - Obfuscation defeats naive harvesters at scale: HTML numeric entities blocked
 *    95% of real harvesters, HTML-comment splitting blocked 99%. A plain regex
 *    over raw HTML loses most of a real corpus.
 *  - Phone regexes are worse: 709 SVG-coordinate false matches were observed on a
 *    single 210-page corpus before script/style/svg were stripped in a fresh parse.
 *
 * Everything emitted here carries the source URL and capture timestamp of the page
 * it came from, because that is the product.
 */
import { parsePhoneNumberFromString } from 'libphonenumber-js';
import * as cheerio from 'cheerio';

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,24}/g;

/** Local-part substrings that mean "this is not a real address". */
const EMAIL_EXCLUDE = [
  'noreply', 'no-reply', 'donotreply', 'example', 'test@', 'user@', 'your',
  'name@', 'sample', 'placeholder', 'changeme', 'youremail', 'yourname',
  'email@', 'firstname', 'lastname', 'someone', 'admin@admin',
];
const EMAIL_PLACEHOLDER_DOMAINS = new Set([
  'example.com', 'example.org', 'example.net', 'email.com', 'domain.com',
  'test.com', 'mail.com', 'yourdomain.com', 'yourcompany.com', 'company.com',
  'acme.com', 'localhost', 'sentry.io', 'w3.org',
]);
/** Kills the lodash@4.17.15-<hash>.js class of garbage every naive regex emits. */
const ASSET_EXTENSIONS = /\.(js|mjs|cjs|ts|tsx|jsx|css|scss|map|json|woff2?|ttf|eot|wasm|min|html?|php|xml|svg|png|jpe?g|gif|webp|ico|pdf)$/i;
const SEMVER_DOMAIN_RE = /^\d+\.\d+/;
const JSON_ESCAPE_LEAK_RE = /^u00[0-9a-f]{2}/i;

const GENERIC_LOCAL_PARTS = new Set([
  'info', 'contact', 'support', 'hello', 'team', 'office', 'marketing', 'press',
  'sales', 'admin', 'help', 'enquiries', 'enquiry', 'mail', 'hr', 'careers',
  'jobs', 'recruiting', 'dpo', 'privacy', 'legal', 'billing', 'accounts',
]);

export function isEmailExcluded(email) {
  const e = email.toLowerCase();
  const [local, domain] = e.split('@');
  if (!local || !domain) return true;
  if (EMAIL_EXCLUDE.some((x) => e.includes(x))) return true;
  if (EMAIL_PLACEHOLDER_DOMAINS.has(domain)) return true;
  if (ASSET_EXTENSIONS.test(domain)) return true;
  if (SEMVER_DOMAIN_RE.test(domain)) return true;
  if (JSON_ESCAPE_LEAK_RE.test(local)) return true;
  if (local.length > 64 || domain.length > 253) return true;
  if (/[^a-z0-9.@_%+-]/.test(e)) return true;
  return false;
}

/** A named individual is a far stronger lead than info@ - flag it. */
export function classifyEmail(email) {
  const local = email.toLowerCase().split('@')[0];
  if (GENERIC_LOCAL_PARTS.has(local)) return { kind: 'role', confidence: 'medium' };
  if (local.includes('.') || local.includes('-') || local.includes('_')) {
    return { kind: 'individual', confidence: 'high' };
  }
  return { kind: 'unknown', confidence: 'medium' };
}

/**
 * Cloudflare Scrape Shield email obfuscation.
 * First byte of the hex blob is the XOR key; the rest is the address.
 */
export function decodeCloudflareEmail(hex) {
  try {
    const key = parseInt(hex.slice(0, 2), 16);
    let out = '';
    for (let i = 2; i < hex.length; i += 2) {
      out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16) ^ key);
    }
    return /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,24}$/.test(out) ? out : null;
  } catch { return null; }
}

const OBFUSCATED_TLD_WHITELIST = new Set([
  'com', 'org', 'net', 'edu', 'gov', 'io', 'co', 'uk', 'de', 'fr', 'za', 'ng',
  'ke', 'gh', 'info', 'biz', 'me', 'us', 'ca', 'au', 'in', 'eu',
]);

/** Extract emails via five independent branches, each tagged with its method. */
export function extractEmails(html, $) {
  const found = new Map();   // email -> {method, context}
  const push = (raw, method, context) => {
    if (!raw) return;
    const e = raw.trim().toLowerCase().replace(/^mailto:/, '').split('?')[0];
    if (!e || isEmailExcluded(e)) return;
    if (!found.has(e)) found.set(e, { method, context: context?.slice(0, 160) || null });
  };

  // 1. mailto: hrefs - explicit intent, highest confidence
  $('a[href^="mailto:" i]').each((_, el) => push($(el).attr('href'), 'mailto-href', $(el).text()));

  // 2. Cloudflare protected addresses
  $('[data-cfemail]').each((_, el) => {
    const d = decodeCloudflareEmail($(el).attr('data-cfemail') || '');
    if (d) push(d, 'cloudflare-xor', $(el).parent().text());
  });
  for (const m of html.matchAll(/\/cdn-cgi\/l\/email-protection#([0-9a-fA-F]+)/g)) {
    const d = decodeCloudflareEmail(m[1]);
    if (d) push(d, 'cloudflare-xor', null);
  }

  // 3. structured data (JSON-LD) - survives archiving and is rarely obfuscated
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const walk = (o) => {
        if (!o || typeof o !== 'object') return;
        if (typeof o.email === 'string') push(o.email, 'json-ld', o['@type'] || 'json-ld');
        for (const v of Object.values(o)) if (typeof v === 'object') walk(v);
      };
      walk(JSON.parse($(el).contents().text()));
    } catch { /* malformed JSON-LD is common; ignore */ }
  });

  // 4. plain regex, then again after entity-unescaping to catch &#64; / &#x40;
  for (const m of html.matchAll(EMAIL_RE)) push(m[0], 'regex', null);
  const unescaped = html
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/<!--.*?-->/gs, '');                        // comment-splitting defeats 99% of harvesters
  for (const m of unescaped.matchAll(EMAIL_RE)) push(m[0], 'regex-unescaped', null);

  // 5. textual [at]/[dot] obfuscation.
  //
  // This branch is the easiest one to get wrong. A permissive pattern turns
  // ordinary prose into addresses - measured on a real corpus it produced
  // "located@theranos.com" from the sentence "located at theranos.com", and
  // "applic@ions.in" out of the single word "applications" because an
  // unanchored "at" matched mid-word.
  //
  // Two rules fix it:
  //  a) `at` and `dot` must be whole words (\b anchored), never word fragments.
  //  b) At least ONE separator must be an EXPLICIT obfuscation marker - bracketed
  //     at/dot, or the word "dot" spelled out. Bare "X at Y.com" is prose, not
  //     obfuscation, so it is rejected. "press [at] realco [dot] com" survives.
  const visible = $('body').length ? $('body').text() : $.root().text();
  const AT = String.raw`(\s*[\[({]\s*at\s*[\])}]\s*|\s+\bat\b\s+|\s*@\s*)`;
  const DOT = String.raw`(\s*[\[({]\s*dot\s*[\])}]\s*|\s+\bdot\b\s+|\s*\.\s*)`;
  const OBF = new RegExp(String.raw`([A-Za-z0-9._%+-]{2,64})${AT}([A-Za-z0-9-]{2,63}(?:\.[A-Za-z0-9-]{2,63})*)${DOT}([A-Za-z]{2,24})`, 'gi');
  for (const m of visible.matchAll(OBF)) {
    const [, local, atSep, dom, dotSep, tld] = m;
    if (!OBFUSCATED_TLD_WHITELIST.has(tld.toLowerCase())) continue;
    const explicit = /[[({]/.test(atSep) || /[[({]/.test(dotSep) || /\bdot\b/i.test(dotSep);
    if (!explicit) continue;                 // prose, not an obfuscated address
    push(`${local}@${dom}.${tld}`, 'obfuscated-at-dot', m[0]);
  }

  // Comment-splitting ("frag<!--x-->mented@co.com") makes the RAW regex see the
  // truncated tail "mented@co.com" while the comment-stripped pass sees the true
  // "fragmented@co.com". Drop any candidate whose local part is a strict suffix of
  // another candidate on the same domain - it is a fragment, not an address.
  for (const e of [...found.keys()]) {
    const [local, domain] = e.split('@');
    for (const other of found.keys()) {
      if (other === e) continue;
      const [oLocal, oDomain] = other.split('@');
      if (oDomain === domain && oLocal.length > local.length && oLocal.endsWith(local)) {
        found.delete(e);
        break;
      }
    }
  }

  return found;
}

/* ---------------------------------------------------------------- phones ---- */

const PHONE_CONTEXT_KEYWORDS = /(phone|tel|fax|call|mobile|cell|whatsapp|viber|contact|hotline|numero|num[eé]ro|joindre|appeler|ligne|accueil|standard|toll.?free|support)/i;
const PHONE_CONTEXT_WINDOW = 80;
const PHONE_REJECT = [
  /^\d{4}[-/]\d{2}[-/]\d{2}$/,        // dates
  /^\d{8}$/,                          // YYYYMMDD
  /^\d+\.\d+\.\d+/,                   // IP / semver
  /^\d{16,}$/,                        // long bare digits
  /\d+px$/i,                          // CSS
  /^-?\d+\.\d{4,}$/,                  // GPS decimals
  /^(19|20)\d{2}\d{4,}$/,             // year-prefixed IDs
];
const PHONE_CANDIDATE = /(?<![.\d/@])(\+\d[\d\s().-]{6,20}|\(\d{2,4}\)\s*[\d\s.-]{5,15}|\d[\d\s.-]{6,18}\d)(?![\d.])/g;

export function extractPhones(html, $, regionHint) {
  const found = new Map();
  const push = (raw, method, context) => {
    if (!raw) return;
    const cleaned = String(raw).replace(/^tel:/i, '').trim();
    if (cleaned.includes('.') && !cleaned.startsWith('+')) return;   // '.' is almost always a version/coord
    const digits = cleaned.replace(/\D/g, '');
    if (digits.length < 7 || digits.length > 15) return;
    if (PHONE_REJECT.some((re) => re.test(cleaned))) return;
    let value = cleaned; let conf = 'medium'; let region = null;
    try {
      const p = parsePhoneNumberFromString(cleaned, regionHint);
      if (p?.isValid()) { value = p.number; region = p.country || null; conf = 'high'; }
      else if (!cleaned.startsWith('+')) conf = 'low';
    } catch { /* keep the raw candidate */ }
    // Key on E.164 when the number parses, so "011 636 9111" and "+27 11 636 9111"
    // collapse to one contact instead of two. Falls back to a trimmed digit string.
    const key = value.startsWith('+') ? value.replace(/\D/g, '') : digits.replace(/^0+/, '');
    const existing = found.get(key);
    if (!existing) {
      found.set(key, { value, method, region, confidence: conf, context: context?.slice(0, 160) || null });
    } else if (conf === 'high' && existing.confidence !== 'high') {
      found.set(key, { value, method, region, confidence: conf, context: context?.slice(0, 160) || null });
    }
  };

  // High-confidence paths that bypass the regex - the markup states intent
  $('a[href^="tel:" i]').each((_, el) => push($(el).attr('href'), 'tel-href', $(el).text()));
  for (const attr of ['data-phone', 'data-tel', 'data-telephone', 'data-mobile']) {
    $(`[${attr}]`).each((_, el) => push($(el).attr(attr), `attr-${attr}`, null));
  }
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const walk = (o) => {
        if (!o || typeof o !== 'object') return;
        if (typeof o.telephone === 'string') push(o.telephone, 'json-ld', o['@type'] || 'json-ld');
        for (const v of Object.values(o)) if (typeof v === 'object') walk(v);
      };
      walk(JSON.parse($(el).contents().text()));
    } catch { /* ignore */ }
  });

  // Regex path over a FRESH parse with script/style/svg removed - without this,
  // SVG path coordinates alone produce hundreds of false matches per corpus.
  const $clean = cheerio.load(html);
  $clean('script, style, svg, noscript, template, code, pre').remove();

  // Context is evaluated PER BLOCK, not over one flat string. A flat 80-char
  // window bleeds across element boundaries: measured locally, a bare number in
  // its own <p> was wrongly accepted because the PREVIOUS paragraph ended with
  // "call us on ...". Blocks keep the keyword and the number in the same breath.
  const blocks = [];
  const root = $clean('body').length ? $clean('body') : $clean.root();
  root.find('p, li, td, th, div, span, address, footer, section, h1, h2, h3, h4, dd, dt, a')
    .each((_, el) => {
      const t = $clean(el).clone().children().remove().end().text();
      if (t && t.trim()) blocks.push(t);
    });
  const whole = root.text();
  if (!blocks.length) blocks.push(whole);

  for (const text of blocks) {
    for (const m of text.matchAll(PHONE_CANDIDATE)) {
      const cand = m[1];
      const selfEvident = cand.trim().startsWith('+') || cand.includes('(');
      if (selfEvident) { push(cand, 'regex-explicit', text.slice(0, 80)); continue; }
      const before = text.slice(Math.max(0, m.index - PHONE_CONTEXT_WINDOW), m.index);
      if (PHONE_CONTEXT_KEYWORDS.test(before)) push(cand, 'regex-context-gated', before.slice(-60));
    }
  }
  return found;
}

/* ----------------------------------------------------- embedded identifiers -- */

/**
 * Analytics / ad / pixel IDs.
 *
 * The highest-leverage pivot in this whole problem space and the one the research
 * critic found completely missing from a 250-tool inventory. These IDs are baked
 * into the archived HTML bytes, so they survive the domain's death perfectly -
 * proven live: yikyakapp.com (dead since 2017) yielded UA-46824978-4 from a 2016
 * snapshot, which reverse-resolves to every other domain the same owner ran.
 */
const ID_PATTERNS = [
  [/\bUA-\d{4,10}-\d{1,4}\b/g, 'google-analytics-ua'],
  [/\bG-[A-Z0-9]{8,12}\b/g, 'google-analytics-ga4'],
  [/\bGTM-[A-Z0-9]{4,10}\b/g, 'google-tag-manager'],
  [/\bpub-\d{10,20}\b/g, 'google-adsense'],
  [/\bAW-\d{6,14}\b/g, 'google-ads'],
  [/cdn\.segment\.com\/analytics\.js\/v1\/([A-Za-z0-9]{8,40})/g, 'segment-write-key'],
  [/optimizely\.com\/js\/(\d{6,12})/g, 'optimizely-project'],
  [/connect\.facebook\.net\/[^"']*?\/fbevents\.js/g, 'facebook-pixel-present'],
  [/fbq\(\s*['"]init['"]\s*,\s*['"](\d{10,20})['"]/g, 'facebook-pixel-id'],
  [/\bhotjar\D{0,20}(\d{5,9})\b/gi, 'hotjar-site'],
  [/mixpanel\.init\(\s*['"]([a-f0-9]{24,40})['"]/g, 'mixpanel-token'],
  [/\byandex[_-]?metrika\D{0,20}(\d{5,10})\b/gi, 'yandex-metrika'],
];

export function extractIdentifiers(html) {
  const found = new Map();
  for (const [re, kind] of ID_PATTERNS) {
    for (const m of html.matchAll(re)) {
      const value = m[1] || m[0];
      if (!found.has(value)) found.set(value, kind);
    }
  }
  return found;
}
