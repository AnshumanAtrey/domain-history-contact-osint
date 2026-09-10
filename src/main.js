/**
 * domain-history-contact-osint
 *
 * Submit a domain. Get its history and its owner's contacts, with a citable
 * source URL and capture timestamp on every single finding.
 *
 * Design constraints that shaped this file:
 *  1. ONE input field that matters. Adoption across the sibling portfolio tracks
 *     inversely with field count (5 fields -> 1,704 users; 52 fields -> 3 users).
 *  2. A dead domain is the EXPECTED input, not an error. Every run must finish
 *     successfully with a populated, self-explaining report saying which sources
 *     answered and which did not. Apify penalises actors under ~95% success.
 *  3. Contacts are statements, never domain-level aggregates. One row per contact
 *     per source, each with its own provenance.
 *  4. Checkboxes control what APPEARS in the report. Collectors are only skipped
 *     when nothing that needs their data is ticked.
 */
import { Actor, log } from 'apify';
import * as cheerio from 'cheerio';
import pLimit from 'p-limit';

import { ArchiveLimiter } from './core/ratelimit.js';
import { ContactStore } from './core/provenance.js';
import { SourceRegistry, STATUS } from './core/sources.js';
import { sampleSnapshots, dedupeByDigest, normalizePath, DEPTH_PRESETS } from './core/sampler.js';
import * as wayback from './collectors/wayback.js';
import { fetchRdap } from './collectors/rdap.js';
import { fetchCerts } from './collectors/crtsh.js';
import { fetchLiveDns, fetchPassiveDns, geolocateIps } from './collectors/dns.js';
import { fetchDnsHistory as fetchStDnsHistory, fetchWhoisHistory as fetchStWhoisHistory } from './collectors/securitytrails.js';
import { fetchUrlscan, fetchArquivo, fetchGrepApp, fetchCommonCrawl } from './collectors/references.js';
import { extractEmails, extractPhones, extractIdentifiers, classifyEmail } from './extractors/contacts.js';
import { loadNer, extractDeclaredEntities, extractNamedEntities, classifyCandidates, visibleTextFallback } from './extractors/entities.js';
import { fetchWhoisHistory } from './collectors/whois-history.js';

await Actor.init();

const input = (await Actor.getInput()) || {};
const domains = String(input.domains || '')
  .split(/[\s,;]+/)
  .map((d) => d.trim().toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/.*$/, ''))
  .filter((d) => /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d));

const depth = ['quick', 'standard', 'deep'].includes(input.depth) ? input.depth : 'standard';
const pageCap = DEPTH_PRESETS[depth].cap;
const whoisHistoryApiKey = input.whoisHistoryApiKey?.trim() || null;
const securityTrailsApiKey = input.securityTrailsApiKey?.trim() || null;

/**
 * Sections the user asked for. Defaults to everything so "type domain, press
 * Start" is unchanged. The UI shows data-level labels, not tool names.
 */
const ALL_SECTIONS = ['contacts', 'ownership', 'subdomains', 'hosting', 'old_pages', 'server_tech', 'tracking_ids', 'mentions'];
const sections = new Set(
  Array.isArray(input.sections) && input.sections.length
    ? input.sections.filter((s) => ALL_SECTIONS.includes(s))
    : ALL_SECTIONS,
);
const want = (s) => sections.has(s);

/**
 * Collector gating derived from the section map.
 *
 * The rule: checkboxes decide what appears in the report. Internally we skip a
 * network call only when NOTHING that needs its data is ticked. Untick old_pages
 * and the run genuinely gets ~10x faster. Untick just contacts alone and the
 * report is cleaner but not faster, because contacts ride the archive fetch.
 *
 * needArchivePages: true when ANY of contacts, old_pages, server_tech, or
 *   tracking_ids is on, because all four are extracted from the same Wayback
 *   page bytes. When false, the 8-81s archive fetch is completely skipped.
 */
const needArchivePages = want('contacts') || want('old_pages') || want('server_tech') || want('tracking_ids');
const needRdap         = want('ownership') || want('contacts');  // RDAP contributes registrar abuse contacts
const needCerts        = want('subdomains');
const needPassiveDns   = want('hosting') || needArchivePages;    // passive DNS feeds lifespan for CC index selection too
const needUrlscan      = want('hosting') || want('mentions');
const needArquivo      = want('mentions');
const needGrepApp      = want('mentions') || want('contacts');   // grep.app finds emails in public code
const needCommonCrawl  = want('mentions');
const needWhoisHistory = (want('ownership') || want('contacts')) && !!whoisHistoryApiKey;
const needSecurityTrails = (want('ownership') || want('hosting') || want('contacts')) && !!securityTrailsApiKey;

if (!domains.length) {
  const msg = 'No valid domain found in the input. Enter a domain like example.com, one per line.';
  const scannedAt = new Date().toISOString();
  await Actor.setValue('OUTPUT', { domain: null, status: { state: 'invalid_input', plainEnglish: msg }, error: msg, scannedAt });
  await Actor.pushData({ type: 'summary', domain: null, value: msg, status: 'invalid_input', scannedAt });
  log.warning('No valid domains in input.');
  await Actor.exit();
}

log.info(`Scanning ${domains.length} domain(s) at depth "${depth}" (up to ${pageCap} archived pages each)`);
log.info(`Sections: ${[...sections].join(', ')}`);

/**
 * Output layout. The default dataset is the contacts table: one row per contact
 * per source, then one summary row per domain, so a run is never empty. The full
 * report (registration, DNS and hosting history, certificates, archived pages,
 * tracking IDs, mentions, coverage) is the run's OUTPUT record - Console shows it
 * on the Output tab - and REPORT-<domain> for multi-domain runs. No named storages
 * are opened, so the Actor runs under limited permissions, which Store search and
 * the MCP index require before a new Actor has usage.
 */
const reports = [];
let browser = null;
let browserUnavailable = false;

// One model load per process (~0.6s warm). Null when unavailable; entity
// extraction then degrades to declared structured data and says so once.
const ner = want('contacts') && needArchivePages ? await loadNer() : null;

/**
 * Render HTML so inline JS executes, WITHOUT spending another archive request.
 *
 * setContent runs the page's own inline scripts and JSON hydration blobs against
 * bytes we already hold, so JS-injected contacts are recovered without a second
 * fetch. That matters because archive.org is the rate-limited resource here, not
 * the CPU - naive `if_` re-navigation would halve throughput against a hard limit.
 *
 * Returns { html, text }: the rendered DOM for the parsers, and innerText - what a
 * human actually reads, hidden elements gone, one visual line per line - for the
 * entity model. Both come from the same page session; nothing is fetched twice.
 *
 * Rendering is strictly a BONUS pass. Every failure path returns null, and a
 * browser that cannot launch at all is latched off rather than retried, so it can
 * never take down the extraction stage. Learned the hard way: launchPlaywright
 * sitting outside the try block let a local browser failure abort the whole
 * archived-pages source after 3 of 30 pages, discarding their extraction.
 */
async function renderPage(html) {
  if (browserUnavailable) return null;
  try {
    if (!browser) {
      const { launchPlaywright } = await import('crawlee');
      browser = await launchPlaywright({ launchOptions: { headless: true } });
    }
  } catch (err) {
    browserUnavailable = true;
    log.warning(`Headless rendering unavailable, continuing with raw archived bytes only: ${String(err.message).split('\n')[0]}`);
    return null;
  }
  let page = null;
  try {
    page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: 15_000 });
    await page.waitForTimeout(400);
    const [rendered, text] = await Promise.all([
      page.content(),
      page.evaluate(() => document.body?.innerText || ''),
    ]);
    return { html: rendered, text };
  } catch {
    return null;
  } finally {
    if (page) await page.close().catch(() => {});
  }
}

for (const domain of domains) {
  const started = Date.now();
  const sources = new SourceRegistry();
  const contacts = new ContactStore();
  const lineCache = new Map();     // visible-text line -> entities; shared nav/footer is inferred once per domain
  const limiter = new ArchiveLimiter({ log });
  log.info(`=== ${domain}`);

  // ── 1. Live state ─ always runs, everything downstream branches on this ──
  const live = await sources.run('live_dns', 'Live DNS', () => fetchLiveDns(domain));
  const hosted = !!live?.hosted;
  const liveStatus = live?.state || 'unknown';
  const regionHint = domain.split('.').pop().length === 2 ? domain.split('.').pop().toUpperCase() : undefined;

  // ── 2. Registration, certificates, passive DNS ──────────────────────────
  const rdap = needRdap
    ? await sources.run('rdap', 'RDAP registration', () => fetchRdap(domain, want('contacts') ? contacts : null))
    : await sources.run('rdap', 'RDAP registration', null, { skipIf: 'Section not selected' });

  const whoisHistory = needWhoisHistory
    ? await sources.run('whois_history', 'WHOIS history (Whoxy)', () => fetchWhoisHistory(domain, whoisHistoryApiKey, want('contacts') ? contacts : null))
    : await sources.run('whois_history', 'WHOIS history (Whoxy)', null, { skipIf: whoisHistoryApiKey ? 'Section not selected' : 'No Whoxy API key provided' });

  const certs = needCerts
    ? await sources.run('crtsh', 'Certificate transparency (crt.sh)', () => fetchCerts(domain, want('contacts') ? contacts : null))
    : await sources.run('crtsh', 'Certificate transparency (crt.sh)', null, { skipIf: 'Section not selected' });

  const pdns = needPassiveDns
    ? await sources.run('passive_dns', 'Passive DNS history', () => fetchPassiveDns(domain))
    : await sources.run('passive_dns', 'Passive DNS history', null, { skipIf: 'Section not selected' });

  // SecurityTrails: DNS history + WHOIS history (BYOK, free 2500 queries/month)
  const stDns = needSecurityTrails && want('hosting')
    ? await sources.run('securitytrails_dns', 'SecurityTrails DNS history', () => fetchStDnsHistory(domain, securityTrailsApiKey))
    : await sources.run('securitytrails_dns', 'SecurityTrails DNS history', null, { skipIf: securityTrailsApiKey ? 'Section not selected' : 'No SecurityTrails API key' });

  const stWhois = needSecurityTrails && (want('ownership') || want('contacts'))
    ? await sources.run('securitytrails_whois', 'SecurityTrails WHOIS history', () => fetchStWhoisHistory(domain, securityTrailsApiKey, want('contacts') ? contacts : null))
    : await sources.run('securitytrails_whois', 'SecurityTrails WHOIS history', null, { skipIf: securityTrailsApiKey ? 'Section not selected' : 'No SecurityTrails API key' });

  // IP geolocation - free, no key, enriches the historical IPs we already found
  const ipGeo = (want('hosting') && pdns?.historicalIps?.length)
    ? await sources.run('ip_geolocation', 'IP geolocation (ip-api.com)', () => geolocateIps(pdns.historicalIps))
    : await sources.run('ip_geolocation', 'IP geolocation (ip-api.com)', null, { skipIf: want('hosting') ? 'No historical IPs to geolocate' : 'Section not selected' });

  // ── 3. Inbound references ───────────────────────────────────────────────
  const urlscan = needUrlscan
    ? await sources.run('urlscan', 'urlscan.io submissions', () => fetchUrlscan(domain))
    : await sources.run('urlscan', 'urlscan.io submissions', null, { skipIf: 'Section not selected' });

  const arquivo = needArquivo
    ? await sources.run('arquivo', 'Arquivo.pt full-text archive', () => fetchArquivo(domain))
    : await sources.run('arquivo', 'Arquivo.pt full-text archive', null, { skipIf: 'Section not selected' });

  const codeRefs = needGrepApp
    ? await sources.run('grepapp', 'Public code search (grep.app)', () => fetchGrepApp(domain))
    : await sources.run('grepapp', 'Public code search (grep.app)', null, { skipIf: 'Section not selected' });

  // Emails hiding in public code are real contacts - harvest them with provenance.
  if (want('contacts') && codeRefs?.rawText) {
    const re = new RegExp(`[A-Za-z0-9._%+-]+@${domain.replace(/\./g, '\\.')}`, 'gi');
    for (const m of new Set(codeRefs.rawText.match(re) || [])) {
      const ref = codeRefs.codeReferences.find((c) => (c.snippet || '').includes(m));
      contacts.add({
        type: 'email',
        value: m.toLowerCase(),
        sourceType: 'grepapp',
        sourceUrl: ref?.url || codeRefs.sourceUrl,
        extractionMethod: 'code-search',
        confidence: classifyEmail(m).confidence,
        context: ref ? `${ref.repo}/${ref.path}` : 'public code',
      });
    }
  }

  // ── 4. The archive layer ────────────────────────────────────────────────
  let snapshots = [];
  const cdx = needArchivePages
    ? await sources.run('wayback_cdx', 'Wayback CDX index', async () => {
      snapshots = await wayback.fetchSnapshots(domain, limiter, {
        serverLimit: depth === 'deep' ? 15_000 : 5_000,
        deadlineMs: depth === 'deep' ? 120_000 : 60_000,
        maxPages: depth === 'deep' ? 10 : 3,
      });
      return snapshots;
    })
    : await sources.run('wayback_cdx', 'Wayback CDX index', null, { skipIf: 'No archive-dependent section selected' });

  const deduped = dedupeByDigest(snapshots);
  const sampled = sampleSnapshots(deduped, pageCap);
  if (needArchivePages) log.info(`  archive: ${snapshots.length} captures -> ${deduped.length} deduped -> ${sampled.length} sampled`);

  const stamps = deduped.map((s) => s.timestamp).sort();

  /**
   * When was this domain actually alive? Wayback captures, certificate dates and
   * RDAP events each bound it. Common Crawl keeps one index per crawl and a crawl
   * only holds pages that existed when it ran, so this window decides which
   * indexes are worth asking - without it the actor queried 2008, 2017, 2021 and
   * 2026 for a domain that lived 2024-2025, and concluded it had no records.
   */
  const lifespan = (() => {
    const years = [];
    if (stamps.length) years.push(Number(stamps[0].slice(0, 4)), Number(stamps[stamps.length - 1].slice(0, 4)));
    for (const d of [certs?.firstCertificate, certs?.lastCertificate]) {
      const y = d && Number(String(d).slice(0, 4));
      if (y) years.push(y);
    }
    for (const e of rdap?.events || []) {
      const y = e?.date && Number(String(e.date).slice(0, 4));
      if (y) years.push(y);
    }
    const thisYear = new Date().getFullYear();
    const valid = years.filter((y) => Number.isFinite(y) && y >= 1990 && y <= thisYear + 5);
    if (!valid.length) return null;
    return { fromYear: Math.min(...valid), toYear: Math.min(Math.max(...valid), thisYear) };
  })();

  const cc = needCommonCrawl
    ? await sources.run('commoncrawl', 'Common Crawl index', () => fetchCommonCrawl(domain, lifespan))
    : await sources.run('commoncrawl', 'Common Crawl index', null, { skipIf: 'Section not selected' });

  let pagesFetched = 0; let pagesBlocked = 0; let pagesFailed = 0; let pagesRendered = 0;
  const timing = { fetch: 0, render: 0, extract: 0, entities: 0 };   // ms, summed across the 3 parallel workers
  const identifiers = new Map();
  const originServers = new Set();

  if (needArchivePages && sampled.length) {
    const limit = pLimit(3);                       // archive.org politeness, not CPU
    await sources.run('wayback_pages', 'Archived page contents', async () => {
      const results = await Promise.all(sampled.map((s) => limit(async () => {
        if (limiter.isHardBlocked) { pagesBlocked += 1; return null; }
        let t = performance.now();
        const page = await wayback.fetchSnapshot(s, limiter);
        timing.fetch += performance.now() - t;
        if (page.error === 'blocked' || page.error === 'rate_limited') { pagesBlocked += 1; return null; }
        if (!page.html) { pagesFailed += 1; return null; }
        pagesFetched += 1;

        if (page.originHeaders?.server) originServers.add(page.originHeaders.server);

        // Parse the byte-original bytes, then the rendered DOM as a second pass.
        const variants = [{ html: page.html, method: 'raw' }];
        t = performance.now();
        const rendered = await renderPage(page.html);
        timing.render += performance.now() - t;
        if (rendered?.html && rendered.html !== page.html) { pagesRendered += 1; variants.push({ html: rendered.html, method: 'rendered' }); }

        t = performance.now();
        let $last = null;
        for (const v of variants) {
          const $ = cheerio.load(v.html);
          $last = $;
          if (want('contacts')) {
            for (const [email, meta] of extractEmails(v.html, $)) {
              const cls = classifyEmail(email);
              contacts.add({
                type: 'email', value: email, sourceType: 'wayback',
                sourceUrl: s.original, snapshotTimestamp: s.timestamp, replayUrl: page.replayUrl,
                extractionMethod: v.method === 'rendered' ? `${meta.method}+rendered` : meta.method,
                confidence: cls.confidence, context: meta.context,
              });
            }
            for (const [, ph] of extractPhones(v.html, $, regionHint)) {
              contacts.add({
                type: 'phone', value: ph.value, key: ph.value.replace(/\D/g, ''), sourceType: 'wayback',
                sourceUrl: s.original, snapshotTimestamp: s.timestamp, replayUrl: page.replayUrl,
                extractionMethod: v.method === 'rendered' ? `${ph.method}+rendered` : ph.method,
                confidence: ph.confidence, context: ph.context,
              });
            }
          }
          if (want('tracking_ids')) {
            for (const [id, kind] of extractIdentifiers(v.html)) {
              if (!identifiers.has(id)) {
                identifiers.set(id, { kind, sourceUrl: s.original, snapshotTimestamp: s.timestamp, replayUrl: page.replayUrl });
              }
            }
          }
        }
        timing.extract += performance.now() - t;

        // People and organisations: once per page, on the best text we have.
        // Emails and phones run on both variants because de-obfuscation wants
        // raw bytes; names do not hide in entities, so the rendered DOM's
        // innerText is strictly better and the raw parse is only the fallback.
        t = performance.now();
        if (want('contacts') && $last) {
          const text = rendered?.text || visibleTextFallback($last);
          const declared = extractDeclaredEntities($last, text);
          const found = [
            ...declared.filter((e) => e.type !== 'candidate'),
            ...await classifyCandidates(declared.filter((e) => e.type === 'candidate'), ner, lineCache),
            ...await extractNamedEntities(text, ner, lineCache),
          ];
          for (const e of found) {
            contacts.add({
              type: e.type,
              value: e.name,
              sourceType: 'wayback',
              sourceUrl: s.original,
              snapshotTimestamp: s.timestamp,
              replayUrl: page.replayUrl,
              extractionMethod: e.method,
              confidence: e.method === 'ner' ? (e.score >= 0.97 ? 'high' : 'medium') : 'high',
              context: {
                role: e.role || null,
                worksFor: e.worksFor || null,
                profileUrl: e.url || null,
                sameAs: e.sameAs || null,
                alternateName: e.alternateName || null,
                image: e.image || null,
                snippet: e.context || null,      // the visible line the model read - citable evidence
              },
            });
          }
        }
        timing.entities += performance.now() - t;
        return true;
      })));
      return results.filter(Boolean);
    });
  }

  // ── 5. Cross-page entity filters ─────────────────────────────────────────
  // (a) A name found as both person and organisation is an organisation.
  // (b) A one-word organisation the model saw exactly once is a mention, not an
  //     owner - "Shopify" inside a blog post. The site's own name repeats in the
  //     header and footer of every page, so frequency separates the two without
  //     a word list. Declared (JSON-LD, microdata, copyright) organisations are
  //     exempt: the page said so.
  // (c) The same name spelled with and without spaces is one entity.
  if (pagesFetched) {
    const sec = (ms) => `${(ms / 1000).toFixed(1)}s`;
    log.info(`  page time (summed over 3 workers): fetch ${sec(timing.fetch)}, render ${sec(timing.render)}, emails/phones/ids ${sec(timing.extract)}, people/orgs ${sec(timing.entities)}`
      + (ner ? ` (${lineCache.size} unique lines inferred)` : ''));
  }
  contacts.dedupeBySpelling('person');
  contacts.dedupeBySpelling('organization');
  const orgKeys = new Set();
  for (const rec of contacts.entries.values()) {
    if (rec.type === 'organization') orgKeys.add(rec.value.toLowerCase());
  }
  for (const [key, rec] of contacts.entries) {
    if (rec.type === 'person' && orgKeys.has(rec.value.toLowerCase())) { contacts.entries.delete(key); continue; }
    if (rec.type === 'organization' && !rec.value.includes(' ') && rec.occurrences < 2
      && rec.sightings.every((s) => s.extractionMethod === 'ner')) {
      contacts.entries.delete(key);
    }
  }

  // ── 6. Assemble the sectioned report ────────────────────────────────────
  const summary = contacts.summary();
  const sourceCounts = sources.counts();

  // ── Status block (always present) ───────────────────────────────────────
  const firstSeen = stamps[0] || certs?.firstCertificate || null;
  const lastSeen = stamps[stamps.length - 1] || certs?.lastCertificate || null;

  const report = {
    domain,
    scannedAt: new Date().toISOString(),
    depth,

    status: {
      state: liveStatus,
      plainEnglish: live?.stateExplained || 'DNS could not be reached, so the live state is unknown rather than absent.',
      isDead: !hosted,
      delegated: !!live?.delegated,
      acceptsMail: !!live?.hasMail,
      aliveFrom: firstSeen ? `${firstSeen.slice(0, 4)}-${firstSeen.slice(4, 6)}-${firstSeen.slice(6, 8)}` : null,
      aliveUntil: lastSeen ? `${lastSeen.slice(0, 4)}-${lastSeen.slice(4, 6)}-${lastSeen.slice(6, 8)}` : null,
    },

    youAskedFor: [...sections],
  };

  // ── Build each section only if ticked ───────────────────────────────────
  const results = {};
  const coverage = {};

  // Contacts
  if (want('contacts')) {
    const rows = contacts.toRows(domain);
    const items = [];
    for (const [, r] of contacts.entries) {
      const primary = r.sightings[0] || {};

      const item = {
        type: r.type,
        value: r.value,
        method: primary.extractionMethod || null,
        seenOn: primary.snapshotTimestamp
          ? `${primary.snapshotTimestamp.slice(0, 4)}-${primary.snapshotTimestamp.slice(4, 6)}-${primary.snapshotTimestamp.slice(6, 8)}`
          : null,
        proof: primary.replayUrl || primary.sourceUrl || null,
        confidence: r.confidence,
        occurrences: r.occurrences,
      };

      // For person/org types, the structured metadata (role, worksFor, url, sameAs)
      // may come from any sighting - JSON-LD on page 17 might have worksFor while
      // page 1 (processed first) only had the heuristic. Scan ALL sightings and
      // keep the first non-null value for each field.
      if (r.type === 'person' || r.type === 'organization') {
        const merged = {};
        for (const s of r.sightings) {
          if (typeof s.context === 'object' && s.context && !Array.isArray(s.context)) {
            for (const [k, v] of Object.entries(s.context)) {
              if (v != null && merged[k] == null) merged[k] = v;
            }
          }
        }
        if (r.type === 'person') {
          item.role = merged.role || null;
          item.worksFor = merged.worksFor || null;
          item.profileUrl = merged.profileUrl || null;
          item.sameAs = merged.sameAs || null;
          item.image = merged.image || null;
        } else {
          item.alternateName = merged.alternateName || null;
          item.url = merged.profileUrl || null;
          item.sameAs = merged.sameAs || null;
        }
        item.snippet = merged.snippet || null;

        // Is this entity part of the site, or something the site wrote about?
        // Declared structured data is direct evidence. Otherwise page spread
        // decides, with different bars: a person on 3 pages or carrying a job
        // title is staff (people are the product - over-include). An organisation
        // must sit in the frame of half the pages, because a board member's bio
        // names five companies and that bio is replicated on three URLs - the
        // site's own name is in the footer of every one. No word list.
        const pages = new Set(r.sightings.map((s) => s.sourceUrl)).size;
        const declared = r.sightings.some((s) => ['json-ld', 'microdata', 'meta-author', 'rel-author'].includes(s.extractionMethod));
        item.pagesSeenOn = pages;
        item.relation = declared
          || (r.type === 'person' ? (pages >= 3 || !!merged.role) : (pages >= Math.min(3, pagesFetched) && pages >= pagesFetched / 2))
          ? 'site' : 'mention';
      } else {
        // email / phone - context is a plain string (surrounding text, @type)
        const contextStr = Array.isArray(primary.context)
          ? primary.context.join(', ')
          : (typeof primary.context === 'string' ? primary.context : null);
        item.context = contextStr || null;
      }

      items.push(item);
    }
    // Site-level entities first, then by how often they were seen. Emails and
    // phones have no relation and sort among the site entities.
    const REL = { site: 0, mention: 1 };
    items.sort((a, b) => (REL[a.relation] ?? 0) - (REL[b.relation] ?? 0) || b.occurrences - a.occurrences);
    results.contacts = {
      found: summary.total,
      breakdown: summary.byType,
      relationExplained: 'site = part of the site itself: declared in its structured data, or (people) seen on 3+ pages or carrying a job title, or (organisations) present on at least half the pages, as a footer name is. mention = appears in the site\'s content, such as a company named in an article or a biography.',
      items,
    };
    // Provenance rows are the dataset. One row is one citable claim. People and
    // organisations also carry role, employer, relation and the evidence line, so
    // the table alone answers "who ran this" without opening the report.
    const byKey = new Map(items.map((i) => [`${i.type}|${i.value.toLowerCase()}`, i]));
    for (const row of rows) {
      const i = byKey.get(`${row.type}|${row.value.toLowerCase()}`);
      if (i && (row.type === 'person' || row.type === 'organization')) {
        Object.assign(row, {
          role: i.role ?? null, worksFor: i.worksFor ?? null, relation: i.relation ?? null,
          pagesSeenOn: i.pagesSeenOn ?? null, snippet: i.snippet ?? null,
        });
      }
    }
    if (rows.length) await Actor.pushData(rows);

    const contactSources = ['wayback_pages', 'rdap', 'grepapp', 'crtsh', 'whois_history', 'securitytrails_whois'];
    const relevant = sources.toArray().filter((s) => contactSources.includes(s.source));
    const anyFailed = relevant.some((s) => s.status === STATUS.RATE_LIMITED || s.status === STATUS.FAILED);
    coverage.contacts = {
      status: anyFailed ? 'incomplete' : 'complete',
      note: anyFailed
        ? 'Some sources were unreachable. Missing contacts here are UNKNOWN, not absent - re-run later.'
        : (summary.total ? null : 'All sources responded, genuinely no contacts found.'),
    };
  }

  // Ownership
  if (want('ownership')) {
    const ownershipData = rdap
      ? {
        status: rdap.status,
        registrar: rdap.registrar || null,
        registrantOrg: rdap.registrantOrg || null,
        registrantName: rdap.registrantName || null,
        registrantRedacted: rdap.registrantRedacted ?? null,
        abuseEmail: rdap.abuseEmail || null,
        abusePhone: rdap.abusePhone || null,
        events: rdap.events || [],
        nameservers: rdap.nameservers || [],
        domainStatus: rdap.domainStatus || [],
        secureDNS: rdap.secureDNS ?? null,
        proof: rdap.sourceUrl || null,
        plainEnglish: rdap.status === 'not_registered'
          ? 'This domain is not currently registered. For a dropped domain, the only surviving record is paid WHOIS history.'
          : rdap.status === 'no_rdap_for_tld'
            ? rdap.note
            : (rdap.registrantRedacted
              ? 'Registrant details are redacted (GDPR). The registrar abuse contact is the guaranteed reachable address.'
              : `Registered to ${rdap.registrantOrg || rdap.registrantName || 'unknown'}.`),
      }
      : { status: 'unavailable', plainEnglish: 'RDAP lookup failed or was skipped.' };

    // WHOIS history - pre-GDPR registrant data
    if (whoisHistory?.count) {
      ownershipData.whoisHistory = {
        recordCount: whoisHistory.count,
        records: whoisHistory.records,
        note: whoisHistory.note,
        sourceUrl: whoisHistory.sourceUrl,
      };
      // Update plainEnglish when WHOIS history fills the RDAP gap
      if (rdap?.registrantRedacted || rdap?.status === 'not_registered') {
        const firstRec = whoisHistory.records.find((r) => r.registrant?.name || r.registrant?.company);
        if (firstRec) {
          ownershipData.plainEnglish += ` WHOIS history recovered ${whoisHistory.count} record(s) - `
            + `registrant: ${firstRec.registrant.name || firstRec.registrant.company || 'unknown'}.`;
        }
      }
    } else if (whoisHistoryApiKey) {
      ownershipData.whoisHistory = { recordCount: 0, note: 'No WHOIS history records found for this domain.' };
    }
    // else: no key provided, omit whoisHistory entirely

    // SecurityTrails WHOIS history (free 2500/month)
    if (stWhois?.count) {
      ownershipData.securityTrailsWhois = {
        recordCount: stWhois.count,
        records: stWhois.records,
        note: stWhois.note,
        sourceUrl: stWhois.sourceUrl,
      };
      // Fill the RDAP gap if Whoxy didn't already
      if (!ownershipData.whoisHistory?.recordCount && (rdap?.registrantRedacted || rdap?.status === 'not_registered')) {
        const firstRec = stWhois.records.find((r) => r.registrant?.name || r.registrant?.organization);
        if (firstRec) {
          ownershipData.plainEnglish += ` SecurityTrails recovered ${stWhois.count} WHOIS record(s) - `
            + `registrant: ${firstRec.registrant.name || firstRec.registrant.organization || 'unknown'}.`;
        }
      }
    } else if (securityTrailsApiKey) {
      ownershipData.securityTrailsWhois = { recordCount: 0, note: 'No WHOIS history in SecurityTrails.' };
    }

    results.ownership = ownershipData;

    const src = sources.toArray().find((s) => s.source === 'rdap');
    const whSrc = sources.toArray().find((s) => s.source === 'whois_history');
    const stSrc = sources.toArray().find((s) => s.source === 'securitytrails_whois');
    const rdapOk = src?.status === STATUS.OK || src?.status === STATUS.EMPTY;
    const whOk = !whSrc || whSrc.status === STATUS.OK || whSrc.status === STATUS.EMPTY || whSrc.status === STATUS.SKIPPED;
    const stOk = !stSrc || stSrc.status === STATUS.OK || stSrc.status === STATUS.EMPTY || stSrc.status === STATUS.SKIPPED;
    coverage.ownership = {
      status: rdapOk && whOk && stOk ? 'complete' : 'incomplete',
      note: !rdapOk ? 'RDAP errored. Re-run.'
        : (!whOk ? 'WHOIS history errored. Check your Whoxy API key.'
          : (!stOk ? 'SecurityTrails errored. Check your API key.' : null)),
    };
  }

  // Subdomains
  if (want('subdomains')) {
    results.subdomains = certs
      ? {
        found: certs.hostnameCount || 0,
        certificatesAnalysed: certs.count,
        firstCertificate: certs.firstCertificate,
        lastCertificate: certs.lastCertificate,
        items: certs.uniqueHostnames?.slice(0, 200) || [],
        issuers: certs.issuers,
        proof: certs.sourceUrl,
        plainEnglish: certs.hostnameCount
          ? `${certs.hostnameCount} hostnames found across ${certs.count} certificates. Certificates outlive domains, so these are historical fact.`
          : 'No certificate transparency records.',
      }
      : { found: 0, items: [], plainEnglish: 'Certificate transparency lookup was unavailable.' };

    const src = sources.toArray().find((s) => s.source === 'crtsh');
    coverage.subdomains = {
      status: src?.status === STATUS.OK || src?.status === STATUS.EMPTY ? 'complete' : 'incomplete',
      note: src?.status === STATUS.FAILED ? 'crt.sh errored. Re-run.' : null,
    };
  }

  // Hosting
  if (want('hosting')) {
    const scans = urlscan?.scans || [];
    const latestScan = scans[0] || {};
    results.hosting = {
      currentDns: live ? {
        records: live.records || {},
        vendorTokens: live.vendorTokens || [],
      } : null,
      lastKnownIp: latestScan.ip || (pdns?.historicalIps?.[0]?.ip) || null,
      provider: latestScan.asnname
        ? `${latestScan.asnname} (${latestScan.asn || 'unknown ASN'})`
        : null,
      country: latestScan.country || null,
      screenshots: scans.filter((s) => s.screenshot).map((s) => s.screenshot).slice(0, 10),
      urlscans: scans.slice(0, 20),
      dnsHistory: {
        historicalNameservers: pdns?.historicalNameservers || [],
        historicalIps: (pdns?.historicalIps || []).map((r) => {
          const geo = ipGeo instanceof Map ? ipGeo.get(r.ip) : null;
          return geo ? { ...r, ...geo } : r;
        }),
        historicalCnames: pdns?.historicalCnames || [],
        discoveredSubdomains: pdns?.discoveredSubdomains || [],
        // SecurityTrails dated DNS records (when API key provided)
        ...(stDns?.count ? {
          securityTrails: {
            aRecords: stDns.aRecords,
            nsRecords: stDns.nsRecords,
            sourceUrl: stDns.sourceUrl,
          },
        } : {}),
      },
      confirmedBy: [
        ...(urlscan?.count ? ['urlscan'] : []),
        ...(pdns?.count ? ['passive DNS'] : []),
        ...(ipGeo instanceof Map && ipGeo.size ? ['ip-api.com geolocation'] : []),
        ...(stDns?.count ? ['SecurityTrails'] : []),
      ],
      proof: urlscan?.sourceUrl || null,
      plainEnglish: (() => {
        const firstIp = latestScan.ip || pdns?.historicalIps?.[0]?.ip;
        if (!firstIp) return 'No hosting information found.';
        const geo = ipGeo instanceof Map ? ipGeo.get(firstIp) : null;
        const loc = geo ? `${geo.city || ''}, ${geo.country || ''}`.replace(/^, /, '') : null;
        const isp = geo?.isp || latestScan.asnname || null;
        return `Last known IP ${firstIp}`
          + (isp ? ` (${isp})` : '')
          + (loc ? ` in ${loc}` : (latestScan.country ? ` in ${latestScan.country}` : ''))
          + '.';
      })(),
    };

    const hostSources = ['urlscan', 'passive_dns', 'securitytrails_dns', 'ip_geolocation'];
    const relevant = sources.toArray().filter((s) => hostSources.includes(s.source));
    const anyFailed = relevant.some((s) => s.status === STATUS.RATE_LIMITED || s.status === STATUS.FAILED);
    coverage.hosting = {
      status: anyFailed ? 'incomplete' : 'complete',
      note: anyFailed ? 'Some hosting sources were unreachable. Re-run later.' : null,
    };
  }

  // Old pages
  if (want('old_pages')) {
    results.old_pages = {
      found: pagesFetched,
      capturesInArchive: snapshots.length,
      afterDedupe: deduped.length,
      sampled: sampled.length,
      rendered: pagesRendered,
      renderingAvailable: !browserUnavailable,
      blocked: pagesBlocked,
      failed: pagesFailed,
      coveringYears: [...new Set(stamps.map((t) => t.slice(0, 4)))],
      firstSeen: stamps[0] || null,
      lastSeen: stamps[stamps.length - 1] || null,
      priorityPages: [...new Set(sampled.map((s) => normalizePath(s.original)))]
        .filter((p) => /contact|about|team|staff|imprint|impressum|careers|management|board/.test(p)),
      items: sampled.slice(0, 50).map((s) => ({
        url: s.original,
        savedOn: s.timestamp
          ? `${s.timestamp.slice(0, 4)}-${s.timestamp.slice(4, 6)}-${s.timestamp.slice(6, 8)}`
          : null,
        openIt: wayback.replayUrl(s.timestamp, s.original, 'mp_'),
      })),
      plainEnglish: pagesBlocked
        ? `archive.org blocked or throttled ${pagesBlocked} page fetch(es). Missing data here is UNKNOWN, not absent - re-run later.`
        : (pagesFetched
          ? `${pagesFetched} archived pages recovered, covering ${[...new Set(stamps.map((t) => t.slice(0, 4)))].join(', ')}.`
          : 'No archived pages found for this domain.'),
    };

    const src = sources.toArray().find((s) => s.source === 'wayback_pages');
    const cdxSrc = sources.toArray().find((s) => s.source === 'wayback_cdx');
    const anyFailed = [src, cdxSrc].some((s) => s?.status === STATUS.RATE_LIMITED || s?.status === STATUS.FAILED);
    coverage.old_pages = {
      status: pagesBlocked ? 'incomplete' : (anyFailed ? 'incomplete' : 'complete'),
      note: pagesBlocked
        ? `${pagesBlocked} page(s) were throttled. This is UNKNOWN, not absent.`
        : null,
    };
  }

  // Server tech
  if (want('server_tech')) {
    results.server_tech = {
      found: originServers.size,
      items: [...originServers],
      plainEnglish: originServers.size
        ? 'Recovered from archived response headers, which preserve the dead origin server\'s own Server header.'
        : (needArchivePages
          ? 'No origin server headers found in the archived pages.'
          : 'Archive pages were not fetched (no archive-dependent section selected).'),
    };
    coverage.server_tech = {
      status: originServers.size || !pagesBlocked ? 'complete' : 'incomplete',
      note: originServers.size ? null : (pagesBlocked ? 'Some pages were blocked - server info may exist but could not be read.' : 'checked and genuinely empty'),
    };
  }

  // Tracking IDs
  if (want('tracking_ids')) {
    const idList = [...identifiers.entries()].map(([value, m]) => ({
      value,
      kind: m.kind,
      foundIn: m.sourceUrl,
      seenOn: m.snapshotTimestamp
        ? `${m.snapshotTimestamp.slice(0, 4)}-${m.snapshotTimestamp.slice(4, 6)}-${m.snapshotTimestamp.slice(6, 8)}`
        : null,
      proof: m.replayUrl || null,
    }));
    results.tracking_ids = {
      found: idList.length,
      items: idList,
      whyEmpty: !idList.length
        ? (pagesBlocked
          ? 'Some archived pages were blocked, so analytics IDs may exist but could not be read.'
          : 'No analytics or ad IDs were present in the saved pages. Genuinely absent, not blocked.')
        : null,
      plainEnglish: idList.length
        ? 'Analytics and ad IDs survive the domain\'s death. Reverse-lookup them to find other domains the same owner ran.'
        : null,
    };
    coverage.tracking_ids = {
      status: !pagesBlocked ? 'complete' : 'incomplete',
      note: !idList.length
        ? (pagesBlocked ? 'Pages blocked - IDs are unknown, not absent.' : 'checked and genuinely empty')
        : null,
    };
  }

  // Mentions
  if (want('mentions')) {
    results.mentions = {
      urlscan: urlscan ? {
        count: urlscan.count,
        total: urlscan.total,
        scans: urlscan.scans?.slice(0, 20),
        sourceUrl: urlscan.sourceUrl,
      } : null,
      arquivo: arquivo ? {
        mentionCount: arquivo.mentionCount,
        captureCount: arquivo.captureCount,
        estimatedTotal: arquivo.estimatedTotal,
        queryUsed: arquivo.queryUsed,
        discarded: arquivo.discarded,
        discardedNote: arquivo.discardedNote,
        references: arquivo.references,
        captures: arquivo.captures,
        sourceUrl: arquivo.sourceUrl,
        cdxSourceUrl: arquivo.cdxSourceUrl,
      } : null,
      publicCode: codeRefs ? {
        count: codeRefs.count,
        references: codeRefs.codeReferences,
      } : null,
      commonCrawl: cc ? {
        count: cc.count,
        indexSelection: cc.indexSelection,
        indexesQueried: cc.indexesQueried,
        urls: cc.urls?.slice(0, 50),
      } : null,
      plainEnglish: [urlscan?.count, arquivo?.mentionCount, arquivo?.captureCount, codeRefs?.count, cc?.count]
        .filter((n) => n > 0).length
        ? 'Other places on the internet that mention or archived this domain.'
        : 'No external mentions found.',
    };

    const mentionSources = ['urlscan', 'arquivo', 'grepapp', 'commoncrawl'];
    const relevant = sources.toArray().filter((s) => mentionSources.includes(s.source));
    const failedOrLimited = relevant.filter((s) => s.status === STATUS.RATE_LIMITED || s.status === STATUS.FAILED);
    coverage.mentions = {
      status: failedOrLimited.length ? 'incomplete' : 'complete',
      note: failedOrLimited.length
        ? `${failedOrLimited.map((s) => s.label).join(', ')} - unreachable. This is UNKNOWN, not absent. Re-run.`
        : null,
    };
  }

  report.results = results;

  // ── Coverage report (always present) ────────────────────────────────────
  const completeSections = Object.values(coverage).filter((c) => c.status === 'complete').length;
  const totalSections = Object.keys(coverage).length;

  report.coverage = {
    plainEnglish: completeSections === totalSections
      ? `All ${totalSections} sections came back complete.`
      : `${completeSections} of ${totalSections} sections complete. ${totalSections - completeSections} section(s) have gaps - check the notes for which to re-run.`,
    bySection: coverage,
  };

  // Raw source-level detail for power users and debugging
  report.sourcesDetail = {
    ok: sourceCounts.ok,
    empty: sourceCounts.empty,
    failed: sourceCounts.failed,
    skipped: sourceCounts.skipped,
    rateLimited: sourceCounts.rate_limited,
    explanation: sources.explain(),
    sources: sources.toArray(),
  };

  report.durationMs = Date.now() - started;

  const reportKey = `REPORT-${domain.replace(/[^A-Za-z0-9.-]/g, '_')}`;
  await Actor.setValue(reportKey, report);
  reports.push(report);
  // The summary row closes this domain's block in the contacts table and carries
  // the coverage verdict, so an investigator reading the table alone sees whether
  // "no contacts" means checked-and-empty or a throttled source.
  await Actor.pushData({
    type: 'summary',
    domain,
    value: `${summary.total} contact(s). ${report.coverage.plainEnglish}`,
    confidence: null,
    sourceType: 'report',
    sourceUrl: null,
    snapshotTimestamp: null,
    extractionMethod: null,
    occurrences: summary.total,
    firstSeen: report.status.aliveFrom,
    lastSeen: report.status.aliveUntil,
    status: liveStatus,
    reportKey,
    scannedAt: report.scannedAt,
    durationMs: report.durationMs,
  });

  log.info(`  ${domain}: ${summary.total} contacts, `
    + `${sourceCounts.ok} sources ok / ${sourceCounts.empty} empty / ${sourceCounts.failed} failed / ${sourceCounts.rate_limited} rate-limited / ${sourceCounts.skipped} skipped`);
}

// OUTPUT is what Console's Output tab renders: the report itself for the usual
// single-domain run, the list of reports for a batch.
await Actor.setValue('OUTPUT', reports.length === 1 ? reports[0] : { domains: reports });
if (browser) await browser.close().catch(() => {});
await Actor.exit();
