/**
 * People and organisations from a rendered page.
 *
 * Two layers, both platform-agnostic:
 *
 *  1. DECLARED. schema.org JSON-LD and microdata, <meta name="author">, and the
 *     copyright footer. The page states the type itself ("@type": "Person"), so
 *     there is nothing to guess. Every CMS - WordPress, Shopify, Squarespace,
 *     Wix, hand-rolled - emits some of this because search engines reward it.
 *
 *  2. NAMED-ENTITY RECOGNITION. A multilingual token-classification model over
 *     the page's visible text, line by line. innerText is what a human reads, in
 *     the order they read it, with hidden elements already gone. The model
 *     learned what names look like across ten languages; it does not need to be
 *     told that "Kosten" is a German noun or that "Anshuman" is a first name.
 *
 * What is deliberately absent: platform URL patterns (/author/ slugs), capitalised
 * word regexes, "not a person" word lists. Measured on youthgrowyouth.in the
 * previous heuristic layer needed three blocklists to reach 4 people with 0 false
 * positives - and then emitted "Kosten", "Buch" and "Rabatt" as people on the
 * first German page it saw. Each blocklist entry was a patch for one site that
 * guaranteed a different failure on the next. The model replaces all of them.
 *
 * Bake-off that picked the model (3 platforms, 13 ground-truth entities):
 *   compromise (rule-based, English lexicon)  - missed every non-Western name
 *   Xenova/bert-base-NER (English)            - 12/13 recall, 6/7 known false positives leaked
 *   Xenova/bert-base-multilingual-cased-ner-hrl - 12/13 recall, 1/7 leaked (a lone first name)
 * Same inference speed, 173MB quantized on disk, ~350MB RSS. The one miss was a
 * JSON-LD-declared organisation, which layer 1 catches.
 */
import { log } from 'apify';

export const NER_MODEL = 'Xenova/bert-base-multilingual-cased-ner-hrl';

/* ------------------------------------------------------------- filters ---- */

// Shape rules, not word lists. A person is at least two words; the model's own
// confidence does the rest. Threshold chosen from the bake-off: every leaked
// false positive scored below 0.9 or was a single token.
const PER_MIN_SCORE = 0.9;
const ORG_MIN_SCORE = 0.9;
const MAX_LINE_CHARS = 1500;       // a "line" longer than this is a wall of text; NER context window is 512 tokens
const BYLINE_MAX_CHARS = 150;      // "Name, Title, Company" is short; a biography paragraph is not

/**
 * Legal-form suffixes. An organisation carrying one is a legal entity even when
 * it stands alone on a line ("Theranos, Inc" in a footer), which is exactly the
 * case the nav-label rule below would otherwise discard.
 */
const LEGAL_SUFFIX_RE = /\b(inc|llc|llp|lp|ltd|limited|plc|corp|corporation|company|co|gmbh|ag|kg|kgaa|ug|se|e\.?v|sa|sas|sarl|sl|srl|spa|bv|nv|oy|ab|as|pty|pvt|kft|zrt|s\.?r\.?o|d\.?o\.?o|ltda|mbh)\b\.?/i;
const compact = (v) => v.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

/**
 * Job-title vocabulary for role attachment. This is a dictionary of titles, in
 * the same sense libphonenumber ships a dictionary of dialling codes - it is not
 * tuned to any site. A title on the same visible line as a name is that name's
 * role: "Geschäftsführer: Dirk Hünten, Michael Knippel" labels both.
 */
const ROLE_RE = new RegExp(String.raw`\b(` + [
  'CEO', 'CTO', 'CFO', 'COO', 'CMO', 'CIO', 'CISO', 'CPO', 'CRO',
  'co-?founders?', 'founders?', 'owners?', 'presidents?', 'vice[- ]presidents?', 'VP',
  'chair(?:man|woman|person)?', 'directors?', 'managing directors?', 'executive directors?',
  'general managers?', 'managers?', 'partners?', 'principals?', 'heads? of \\w+',
  'editors?(?:[- ]in[- ]chief)?', 'publishers?', 'webmasters?', 'administrators?', 'trustees?',
  // German
  'geschäftsführer(?:in)?', 'inhaber(?:in)?', 'vorstand', 'vorstandsvorsitzende[rn]?', 'vorsitzende[rn]?', 'prokurist(?:in)?',
  // French
  'gérante?s?', 'présidente?s?', 'directeur', 'directrice', 'fondateur', 'fondatrice', 'propriétaire',
  // Spanish / Portuguese / Italian
  'director general', 'gerente', 'fundador(?:a|es)?', 'propietario', 'amministratore', 'direttore', 'fondatore', 'titolare',
  // Dutch / Nordic
  'oprichter', 'eigenaar', 'grundare', 'verkställande direktör',
].join('|') + String.raw`)\b`, 'i');

/* --------------------------------------------------------- model loader --- */

let nerPipeline = null;
let nerFailed = false;

/**
 * Load the NER pipeline once per process. The model is pre-downloaded into
 * ./models at Docker build time; at runtime remote fetches are refused so a
 * cold container can never stall on a 173MB download. Returns null (and says
 * so once) if the model is unavailable, so extraction degrades to layer 1.
 */
export async function loadNer() {
  if (nerPipeline) return nerPipeline;
  if (nerFailed) return null;
  try {
    const { pipeline, env } = await import('@huggingface/transformers');
    env.cacheDir = process.env.NER_MODEL_DIR || './models';
    env.allowRemoteModels = process.env.NER_ALLOW_DOWNLOAD === '1';

    // onnxruntime sizes its thread pool from the HOST's core count; a container's
    // cgroup CPU quota is invisible to it. Measured on Apify at 2048MB (a 0.5-core
    // share): 1.47s per line against 12ms locally - 100x, from a dozen threads
    // fighting over half a vCPU. Apify's contract is one CPU per 4096MB, published
    // as APIFY_MEMORY_MBYTES, so size the pool from that. Unset locally: default.
    const memMb = Number(process.env.APIFY_MEMORY_MBYTES);
    const threads = memMb ? Math.max(1, Math.round(memMb / 4096)) : null;
    const t0 = Date.now();
    nerPipeline = await pipeline('token-classification', NER_MODEL, {
      dtype: 'q8',
      ...(threads ? { session_options: { intraOpNumThreads: threads, interOpNumThreads: 1 } } : {}),
    });
    log.info(`NER model ready in ${((Date.now() - t0) / 1000).toFixed(1)}s (${NER_MODEL}${threads ? `, ${threads} thread(s) for ${memMb}MB` : ''})`);
    return nerPipeline;
  } catch (err) {
    nerFailed = true;
    log.warning(`NER model unavailable, people/organisations limited to declared structured data: ${String(err.message).split('\n')[0]}`);
    return null;
  }
}

/* --------------------------------------------------- token aggregation --- */

/**
 * Model output is one label per WordPiece token: "Anshuman" "At" "##rey" may
 * come back B-PER, I-PER, O. Group subtokens into WORDS first (a "##" token
 * always belongs to the word before it, whatever the model said), label each
 * word by its first subtoken, then merge B-/I- runs into spans. An entity
 * boundary never falls inside a word, so the output is "Anshuman Atrey", never
 * "Anshuman At". This is Hugging Face's "first" aggregation strategy, which the
 * JS pipeline does not implement.
 *
 * Exported for tests.
 */
export function aggregateTokens(tokens) {
  const words = [];
  for (const t of tokens) {
    if (t.word.startsWith('##') && words.length) words[words.length - 1].text += t.word.slice(2);
    else words.push({ text: t.word, entity: t.entity, score: t.score });
  }
  const spans = [];
  let cur = null;
  for (const w of words) {
    if (w.entity === 'O') { if (cur) spans.push(cur); cur = null; continue; }
    const dash = w.entity.indexOf('-');
    const bi = w.entity.slice(0, dash);
    const label = w.entity.slice(dash + 1);
    if (cur && cur.label === label && bi === 'I') {
      cur.text += ` ${w.text}`; cur.score += w.score; cur.n += 1;
    } else {
      if (cur) spans.push(cur);
      cur = { label, text: w.text, score: w.score, n: 1 };
    }
  }
  if (cur) spans.push(cur);
  return spans.map((s) => ({
    label: s.label,
    // The tokenizer pads punctuation with spaces: "Amazon . com", "Co . KG" - undo
    // it. The space AFTER a dot goes only before a lowercase TLD-shaped token, so
    // "Amazon.com" closes up and "Co. KG" keeps its space.
    text: s.text.replace(/\s+([.,'’])/g, '$1').replace(/\.\s+(?=[a-z]{2,4}\b)/g, '.')
      .replace(/\s*&\s*/g, ' & ').replace(/\s*-\s*/g, '-').trim(),
    score: s.score / s.n,
  }));
}

/* ---------------------------------------------------- layer 2: NER text --- */

/**
 * Named entities from visible text.
 *
 * `lineCache` is shared across every page of one domain. Archived pages of the
 * same site repeat their header, nav and footer verbatim, so most lines have
 * been seen before; those are answered from the cache and still recorded as
 * sightings on the new page, which is what provenance requires. Only genuinely
 * new lines cost an inference.
 *
 * @param {string} text            innerText of the rendered page (or a block-aware fallback)
 * @param {object} ner             pipeline from loadNer()
 * @param {Map<string, object[]>} lineCache
 * @returns {Promise<object[]>}    [{ type, name, method: 'ner', score, role, worksFor, context }]
 */
export async function extractNamedEntities(text, ner, lineCache) {
  const out = [];
  if (!text || !ner) return out;

  const lines = text.split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter((l) => l.length >= 3);
  for (const line of lines) {
    let ents = lineCache.get(line);
    if (!ents) {
      ents = [];
      try {
        const tokens = await ner(line.slice(0, MAX_LINE_CHARS), { ignore_labels: [] });
        const spans = aggregateTokens(tokens).map((s) => ({ ...s, text: s.text.replace(/[™®©]/g, '').trim() }));
        const orgsOnLine = spans.filter((s) => s.label === 'ORG' && s.score >= ORG_MIN_SCORE).sort((a, b) => b.score - a.score);
        const role = line.match(ROLE_RE)?.[1] || null;
        // A company named next to a person in a short byline is their employer. The
        // same name inside a biography paragraph is just something the paragraph
        // mentions - measured: "Elizabeth Holmes @Stanford University" from a bio
        // that said she left Stanford. Bylines only.
        const worksFor = line.length <= BYLINE_MAX_CHARS ? orgsOnLine[0]?.text || null : null;
        for (const s of spans) {
          if (s.label === 'PER' && s.score >= PER_MIN_SCORE && isPersonShaped(s.text)) {
            ents.push({
              type: 'person', name: s.text, method: 'ner', score: s.score,
              role, worksFor, context: line.slice(0, 200),
            });
          } else if (s.label === 'ORG' && s.score >= ORG_MIN_SCORE && isOrgShaped(s.text) && !isNavLabel(s.text, line)) {
            ents.push({ type: 'organization', name: s.text, method: 'ner', score: s.score, context: line.slice(0, 200) });
          }
        }
      } catch (err) {
        log.debug(`NER line failed: ${String(err.message).slice(0, 100)}`);
      }
      lineCache.set(line, ents);
    }
    out.push(...ents);
  }
  return out;
}

function isPersonShaped(s) {
  if (s.length < 4 || s.length > 80) return false;
  if (/\d|[@/:]/.test(s)) return false;
  return s.split(/\s+/).length >= 2;           // one token is a first name or a noun, not a person
}

function isOrgShaped(s) {
  if (s.length < 2 || s.length > 120) return false;
  return !/[@/:]|https?/.test(s);
}

/**
 * An ORG the model found on a LABEL line is a menu item, button or heading, not
 * a company: "Our Company Press Privacy Policy Twitter" is one innerText line
 * when footer links render inline, and every chunk of it scores as ORG. Prose
 * has lowercase words ("partnered with Oracle Corporation in 2009"); labels are
 * Title Case or CAPS throughout. That difference is structural, not lexical.
 * A legal entity is exempt - "Theranos, Inc" alone in a footer is the owner -
 * but only with a name in front of the suffix, so a bare "INC" is still a label.
 */
const PROSE_WORD_RE = /(?:^|\s)[a-zß-ÿ][\p{L}]{2,}/u;
function isNavLabel(orgText, line) {
  if (LEGAL_SUFFIX_RE.test(orgText) && orgText.split(/\s+/).length >= 2) return false;
  return !PROSE_WORD_RE.test(line);
}

/* --------------------------------------------- layer 1: declared entities -- */

const PERSON_TYPES = new Set(['person']);
const ORG_TYPES = new Set([
  'organization', 'corporation', 'localbusiness', 'educationalorganization', 'governmentorganization',
  'ngo', 'sportsorganization', 'airline', 'medicalorganization', 'newsmediaorganization',
  'performinggroup', 'project', 'researchorganization', 'onlinebusiness', 'store', 'restaurant',
  'professionalservice', 'financialservice', 'consortium', 'fundingagency', 'librarysystem',
  'workersunion', 'politicalparty', 'cooperative',
]);

function hasType(typeField, set) {
  if (!typeField) return false;
  const arr = Array.isArray(typeField) ? typeField : [typeField];
  return arr.some((t) => set.has(String(t).toLowerCase().replace(/^(schema:|https?:\/\/schema\.org\/)/, '')));
}
const str = (v) => (typeof v === 'string' ? v.trim() : null);
const nameOf = (v) => (typeof v === 'string' ? v.trim() : str(v?.name) || str(v?.['@id']));

/**
 * The copyright footer is the single most universal ownership statement on the
 * web: "© 2015 Theranos, Inc. All rights reserved." Every commercial platform
 * renders one. One pattern covers ©, (c), "Copyright", an optional year range,
 * and stops at the rights sentence in English, German, French or Spanish.
 */
const COPYRIGHT_RE = /(?:©|\(c\)|copyright)\s*(?:\d{4}\s*(?:[--]\s*\d{4})?\s*)?(?:by\s+)?([^\n©|]{2,90}?)\s*(?:\.|,|\||-|-|all rights|alle rechte|tous droits|todos los derechos|$)/gim;

/**
 * Declared people and organisations: JSON-LD, microdata, meta author, copyright.
 *
 * @param {import('cheerio').CheerioAPI} $
 * @param {string} text  visible text (for the copyright line)
 * @returns {object[]}   [{ type, name, method, role, worksFor, url, sameAs, image, alternateName }]
 */
export function extractDeclaredEntities($, text) {
  const out = [];
  const person = (name, extras) => { if (name && name.length >= 2 && name.length <= 80) out.push({ type: 'person', name, ...extras }); };
  const org = (raw, extras) => {
    const name = raw?.replace(/[™®©]/g, '').trim();
    if (name && name.length >= 2 && name.length <= 120) out.push({ type: 'organization', name, ...extras });
  };

  // JSON-LD - walk everything, including @graph arrays and nested author/publisher objects.
  $('script[type="application/ld+json"]').each((_, el) => {
    let data;
    try { data = JSON.parse($(el).contents().text()); } catch { return; }
    // Pass 1: @id -> name. WordPress SEO plugins write worksFor: {"@id": ".../#organization"}
    // and put the organisation's name on a sibling node; resolve the reference.
    const byId = new Map();
    const index = (o) => {
      if (!o || typeof o !== 'object') return;
      if (Array.isArray(o)) { o.forEach(index); return; }
      if (str(o['@id']) && str(o.name)) byId.set(o['@id'], str(o.name));
      for (const v of Object.values(o)) if (typeof v === 'object') index(v);
    };
    index(data);
    const ref = (v) => { const n = nameOf(v); return (n && byId.get(n)) || n; };

    const walk = (o) => {
      if (!o || typeof o !== 'object') return;
      if (Array.isArray(o)) { o.forEach(walk); return; }
      if (hasType(o['@type'], PERSON_TYPES) && str(o.name)) {
        person(str(o.name), {
          method: 'json-ld',
          role: str(o.jobTitle) || (o.hasOccupation ? nameOf(o.hasOccupation) : null),
          worksFor: ref(o.worksFor) || ref(o.affiliation) || ref(o.memberOf),
          url: str(o.url) || str(o['@id']),
          sameAs: o.sameAs || null,
          image: str(o.image) || str(o.image?.url) || null,
        });
      } else if (hasType(o['@type'], ORG_TYPES) && str(o.name)) {
        org(str(o.name), {
          method: 'json-ld',
          alternateName: str(o.alternateName) || str(o.legalName),
          url: str(o.url) || str(o['@id']),
          sameAs: o.sameAs || null,
        });
        for (const key of ['founder', 'founders', 'employee', 'employees', 'member', 'members']) {
          const list = o[key] ? (Array.isArray(o[key]) ? o[key] : [o[key]]) : [];
          for (const p of list) {
            const n = nameOf(p);
            if (n && !hasType(p?.['@type'], ORG_TYPES)) {
              person(n, {
                method: 'json-ld',
                role: str(p?.jobTitle) || (key.startsWith('founder') ? 'Founder' : null),
                worksFor: str(o.name),
                url: str(p?.url) || null,
              });
            }
          }
        }
      }
      // Untyped "author": "Jane Doe" on an Article - could be a person or "Reuters".
      // Emitted as a candidate; the model decides downstream.
      if (typeof o.author === 'string' && o.author.trim()) out.push({ type: 'candidate', name: o.author.trim(), method: 'json-ld-author' });
      for (const v of Object.values(o)) if (typeof v === 'object') walk(v);
    };
    walk(data);
  });

  // Microdata
  $('[itemtype*="schema.org/Person" i]').each((_, el) => {
    const n = $(el).find('[itemprop="name"]').first().text().trim();
    person(n, {
      method: 'microdata',
      role: $(el).find('[itemprop="jobTitle"]').first().text().trim() || null,
      url: $(el).find('[itemprop="url"]').first().attr('href') || null,
    });
  });
  $('[itemtype*="schema.org/Organization" i], [itemtype*="schema.org/LocalBusiness" i]').each((_, el) => {
    const n = $(el).find('[itemprop="name"]').first().text().trim();
    org(n, { method: 'microdata', url: $(el).find('[itemprop="url"]').first().attr('href') || null });
  });

  // <meta name="author">, <a rel="author">. Untyped, so these go through NER downstream
  // to decide person vs organisation; here they are emitted as candidates.
  const authorMeta = $('meta[name="author" i]').attr('content')?.trim();
  if (authorMeta) out.push({ type: 'candidate', name: authorMeta, method: 'meta-author' });
  $('a[rel~="author" i]').each((_, el) => {
    const n = $(el).text().trim();
    if (n) out.push({ type: 'candidate', name: n, method: 'rel-author', url: $(el).attr('href') || null });
  });

  // Copyright footer
  if (text) {
    for (const m of text.matchAll(COPYRIGHT_RE)) {
      const n = m[1].replace(/\s+/g, ' ').trim();
      if (n && /[A-Za-zÀ-ÿ]{2}/.test(n) && !/^(all|alle|tous|todos)\b/i.test(n)) {
        org(n, { method: 'copyright-notice' });
      }
    }
  }

  return out;
}

/**
 * Resolve untyped candidates (meta author, rel=author) with the model: one
 * inference each, cached with the rest of the lines.
 */
export async function classifyCandidates(candidates, ner, lineCache) {
  const out = [];
  for (const c of candidates) {
    const ents = await extractNamedEntities(c.name, ner, lineCache);
    const hit = ents.find((e) => e.name.toLowerCase() === c.name.toLowerCase()) || ents[0];
    if (hit) out.push({ ...hit, method: c.method, url: c.url || null });
  }
  return out;
}

/**
 * Block-aware text fallback for when headless rendering is unavailable. Cheerio's
 * .text() concatenates "HomeAboutContact"; inserting newlines at block
 * boundaries keeps nav items on separate lines so the model sees them as such.
 */
export function visibleTextFallback($) {
  const $c = $.root().clone();
  $c.find('script, style, svg, noscript, template, head').remove();
  $c.find('br, p, div, li, h1, h2, h3, h4, h5, h6, tr, td, th, dd, dt, section, article, header, footer, nav, address, blockquote, figcaption')
    .after('\n');
  return $c.text().replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n');
}
