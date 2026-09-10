/**
 * Inbound references - who else mentioned this domain.
 *
 * This replaces SEO backlink data deliberately. Ahrefs/Majestic/Semrush are
 * sales-gated and expensive, and a domain-authority score tells an investigator
 * nothing. What DOES help is "which page said what about this domain, and here is
 * the URL" - which these three keyless sources provide, each with a citable link.
 *
 * Arquivo.pt is the sleeper: it is the only free web archive with full-text search
 * over archived CONTENT, so it can find pages that mentioned a domain even after
 * both the domain and the referring page are gone.
 */
import { httpGet, withRetry, UA } from './http.js';

export async function fetchUrlscan(domain) {
  const url = `https://urlscan.io/api/v1/search/?q=domain%3A${encodeURIComponent(domain)}&size=100`;
  const { json } = await withRetry(() => httpGet(url, { timeoutMs: 25_000 }), { attempts: 2 });
  const results = json?.results || [];
  return {
    count: results.length,
    total: json?.total ?? results.length,
    sourceUrl: url,
    scans: results.slice(0, 50).map((r) => ({
      scanUrl: r.result || null,
      pageUrl: r.page?.url || null,
      ip: r.page?.ip || null,
      server: r.page?.server || null,
      country: r.page?.country || null,
      asn: r.page?.asn || null,
      asnname: r.page?.asnname || null,
      time: r.task?.time || null,
      screenshot: r.screenshot || null,
    })),
    note: results.length
      ? 'urlscan stores the rendered DOM of each scan, so these are recoverable page states even now the site is down.'
      : 'No urlscan submissions for this domain.',
  };
}

/**
 * Arquivo.pt - full-text mentions of the domain, plus Arquivo's OWN archive of it.
 *
 * Two hard-won details, both verified live.
 *
 * 1. QUERY SHAPE. textsearch 400s on a bare url-shaped query ("please use the CDX
 *    server API to search for URLs"). The original workaround was to strip the TLD
 *    and search the brand token - which is catastrophic when the brand token is an
 *    ordinary word. Measured on emojis.cafe: q=emojis returned 10 results out of an
 *    estimated 1,825,447, and ZERO of them mentioned the domain. The report filled
 *    with Bitmoji tutorials and Portuguese news, and scored the source "ok".
 *    QUOTING the FQDN bypasses the URL rejection and searches the literal string.
 *    Measured: q="theranos.com" -> 10 items, 10 of 10 mention the domain (100%
 *    precision vs 0%); q="emojis.cafe" -> 0 items, an honest empty.
 *
 * 2. The 400 message names the right endpoint for the other half of the job. The
 *    CDX API returns Arquivo's own archived captures, which is a SECOND web archive
 *    behind a different rate limiter than archive.org - the one resource this actor
 *    actually contends for. Verified: theranos.com returns real captures there.
 *
 * Results are gated on actually containing the domain, and anything that does not
 * is counted in `discarded` rather than quietly dropped.
 */
export async function fetchArquivo(domain) {
  const needle = domain.toLowerCase();
  const phrase = `"${domain}"`;
  const url = `https://arquivo.pt/textsearch?q=${encodeURIComponent(phrase)}&maxItems=50`;

  let items = [];
  let estimatedTotal = null;
  let textSearchError = null;
  try {
    // Full-text search across ~108M archived pages is genuinely slow and sometimes
    // times out. That is reported as a source status, never as a run failure.
    const { json } = await withRetry(() => httpGet(url, { timeoutMs: 60_000 }), { attempts: 2 });
    items = json?.response_items || [];
    estimatedTotal = json?.estimated_nr_results ?? null;
  } catch (err) { textSearchError = String(err.message).slice(0, 150); }

  const mentions = items
    .map((i) => ({
      title: i.title || null,
      originalUrl: i.originalURL || null,
      archiveUrl: i.linkToArchive || null,
      timestamp: i.tstamp || null,
      snippet: (i.snippet || '').replace(/<[^>]+>/g, '').slice(0, 300) || null,
    }))
    .filter((r) => `${r.title || ''} ${r.originalUrl || ''} ${r.snippet || ''} ${r.archiveUrl || ''}`
      .toLowerCase().includes(needle));
  const discarded = items.length - mentions.length;

  // Arquivo's own captures of the domain - a second archive, separate rate limiter.
  let captures = [];
  let cdxError = null;
  const cdxUrl = `https://arquivo.pt/wayback/cdx?url=${encodeURIComponent(`${domain}/*`)}&output=json&limit=200`;
  try {
    const { body } = await withRetry(() => httpGet(cdxUrl, { timeoutMs: 45_000, raw: true }), { attempts: 2 });
    captures = String(body).trim().split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean)
      .map((r) => ({
        url: r.url || null,
        timestamp: r.timestamp || null,
        status: r.status || null,
        mime: r.mime || null,
        replayUrl: r.timestamp && r.url ? `https://arquivo.pt/wayback/${r.timestamp}/${r.url}` : null,
      }));
  } catch (err) { cdxError = String(err.message).slice(0, 150); }

  // Same rule as Common Crawl: if neither half answered, we know nothing about
  // this domain's presence in Arquivo - that is not the same as it holding none.
  if (textSearchError && cdxError) {
    throw new Error(`Arquivo.pt unreachable on both full-text and CDX - data is UNKNOWN, not absent (${textSearchError})`);
  }

  return {
    count: mentions.length + captures.length,
    mentionCount: mentions.length,
    captureCount: captures.length,
    estimatedTotal,
    queryUsed: phrase,
    discarded,
    discardedNote: discarded
      ? `${discarded} full-text result(s) were returned but did not contain "${domain}", so they were dropped rather than padding the report.`
      : null,
    sourceUrl: url,
    cdxSourceUrl: cdxUrl,
    errors: [textSearchError, cdxError].filter(Boolean),
    references: mentions.slice(0, 50),
    captures: captures.slice(0, 100),
    note: (mentions.length || captures.length)
      ? 'Arquivo.pt hits. `references` are pages whose CONTENT names this domain; `captures` are Arquivo\'s own archived copies of it, which is a second archive independent of archive.org.'
      : 'No Arquivo.pt references or captures. Arquivo skews Portuguese-language and European crawls.',
  };
}

/**
 * Public code search for the domain.
 *
 * grep.app's plain REST endpoint now sits behind a Vercel security checkpoint and
 * returns 429 with a JS challenge - verified live. Its MCP endpoint is open, needs
 * no auth, and answers JSON-RPC over SSE. Verified: searching "@theranos.com"
 * returned press@ and investorrelations@ addresses out of public repos, for a
 * company that dissolved in 2018. Config files and mail settings leak real
 * addresses and they never expire.
 */
export async function fetchGrepApp(domain) {
  const endpoint = 'https://mcp.grep.app';
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'User-Agent': UA,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'searchGitHub', arguments: { query: `@${domain}` } },
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const e = new Error(`HTTP ${res.status} on ${endpoint}`);
    e.status = res.status;
    throw e;
  }
  const raw = await res.text();

  // SSE framing: one or more "data: {json}" lines. Take the first parseable one.
  let payload = null;
  for (const line of raw.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    try { payload = JSON.parse(line.slice(5).trim()); break; } catch { /* keep looking */ }
  }
  if (!payload) { try { payload = JSON.parse(raw); } catch { payload = null; } }

  const blocks = payload?.result?.content || [];
  const text = blocks.map((b) => b.text || '').join('\n');

  // The tool returns human-shaped text blocks; parse the fields it emits.
  const refs = [];
  for (const chunk of text.split(/\n(?=Repository:\s)/)) {
    if (!/Repository:/.test(chunk)) continue;
    const repo = /Repository:\s*(\S+)/.exec(chunk)?.[1] || null;
    const path = /Path:\s*(\S+)/.exec(chunk)?.[1] || null;
    const url = /URL:\s*(\S+)/.exec(chunk)?.[1] || null;
    const license = /License:\s*(\S+)/.exec(chunk)?.[1] || null;
    const snippet = chunk.split(/Snippets:/)[1]?.replace(/^-+ Snippet.*$/gm, '').trim().slice(0, 400) || null;
    refs.push({ repo, path, url, license, snippet });
  }

  return {
    count: refs.length,
    sourceUrl: `${endpoint} (searchGitHub "@${domain}")`,
    codeReferences: refs.slice(0, 30),
    rawText: text.slice(0, 4000),
    note: refs.length
      ? 'Public source code mentioning this domain. Config files and mail settings often name real addresses that outlive the site.'
      : 'No public code references this domain.',
  };
}

/**
 * Common Crawl index - a second, unrate-limited URL universe.
 *
 * Three behaviours worth encoding.
 *
 * First, the index server answers 404 when it simply holds nothing for a domain,
 * which is NOT a failure - reporting it as one would tell the user a source broke
 * when it actually answered "nothing here", and the whole point of the coverage
 * report is that distinction.
 *
 * Second, the crawl id rolls forward every few weeks, so it is resolved from
 * collinfo.json rather than hardcoded, with a fallback if that lookup fails.
 *
 * Third - and this was the real defect - Common Crawl keeps a SEPARATE index per
 * crawl, and a crawl only contains pages that existed when it ran. Sampling
 * "newest plus three spread evenly across all of history" asks the wrong years:
 * measured on emojis.cafe, which lived 2024-04 to 2025-05, the actor queried
 * CC-MAIN-2026-34, 2021-43, 2017-47 and 2008-2009 and hit none of the 20+ indexes
 * covering its actual lifespan. So when the domain's lifespan is known - and by
 * this point in the pipeline it is, from Wayback captures and certificate dates -
 * the indexes are chosen from inside that window instead.
 */
let ccIndexListCache = null;

// Best-effort only, used when collinfo.json is unreachable. Spanning years matters
// more than being exhaustive: a wrong id 404s, which is recorded as `empty`.
const FALLBACK_INDEXES = [
  'CC-MAIN-2026-34', 'CC-MAIN-2025-13', 'CC-MAIN-2024-33', 'CC-MAIN-2023-14',
  'CC-MAIN-2021-43', 'CC-MAIN-2020-16', 'CC-MAIN-2017-47', 'CC-MAIN-2008-2009',
];

async function ccIndexList() {
  if (!ccIndexListCache) {
    try {
      const { json } = await httpGet('https://index.commoncrawl.org/collinfo.json', { timeoutMs: 20_000 });
      const ids = (json || []).map((c) => c.id).filter(Boolean);
      ccIndexListCache = ids.length ? { ids, viaFallback: false } : { ids: FALLBACK_INDEXES, viaFallback: true };
    } catch {
      ccIndexListCache = { ids: FALLBACK_INDEXES, viaFallback: true };
    }
  }
  return ccIndexListCache;
}

/** Newest, oldest, and evenly spaced picks between them. */
function spread(list, limit) {
  if (list.length <= limit) return [...list];
  const picks = [];
  const step = (list.length - 1) / (limit - 1);
  for (let i = 0; i < limit; i += 1) picks.push(list[Math.round(i * step)]);
  return [...new Set(picks)];
}

const indexYear = (id) => Number(/CC-MAIN-(\d{4})/.exec(id)?.[1]) || null;

/**
 * Pick indexes overlapping the domain's lifespan, with a year of slack on each
 * side - a crawl labelled year N contains pages fetched close to the end of N-1,
 * and a domain can outlive its last archive capture.
 */
function pickIndexes(all, lifespan, limit) {
  if (!lifespan?.fromYear || !lifespan?.toYear) {
    return { picks: spread(all, limit), strategy: 'spread_across_history' };
  }
  const from = lifespan.fromYear - 1;
  const to = lifespan.toYear + 1;
  const inLife = all.filter((id) => { const y = indexYear(id); return y && y >= from && y <= to; });
  if (!inLife.length) return { picks: spread(all, limit), strategy: 'spread_across_history_no_lifespan_match' };
  return { picks: spread(inLife, limit), strategy: 'matched_to_domain_lifespan' };
}

export async function fetchCommonCrawl(domain, lifespan = null) {
  const { ids, viaFallback } = await ccIndexList();
  const limit = lifespan?.fromYear ? 5 : 4;
  const { picks, strategy } = pickIndexes(ids, lifespan, limit);

  const rows = [];
  const queried = [];
  const deadline = Date.now() + 120_000;   // never let a slow index server run the clock out

  for (const index of picks) {
    const url = `https://index.commoncrawl.org/${index}-index?url=${encodeURIComponent(`${domain}/*`)}&output=json&limit=100`;
    if (Date.now() > deadline) {
      queried.push({ index, status: 'skipped', rows: 0, sourceUrl: url, error: 'index budget exhausted before this crawl was queried' });
      continue;
    }
    try {
      const { body } = await httpGet(url, { timeoutMs: 40_000, raw: true });
      const parsed = String(body).trim().split('\n').filter(Boolean)
        .map((l) => { try { return JSON.parse(l); } catch { return null; } })
        .filter(Boolean);
      rows.push(...parsed.map((r) => ({ ...r, ccIndex: index })));
      queried.push({ index, status: 'ok', rows: parsed.length, sourceUrl: url });
    } catch (err) {
      // 404 means this crawl holds nothing for the domain. That is an answer, not a failure.
      queried.push({
        index,
        status: err.status === 404 ? 'empty' : 'failed',
        rows: 0,
        sourceUrl: url,
        error: err.status === 404 ? null : String(err.message).slice(0, 140),
      });
    }
  }

  // A source that could not be reached has NOT told us the domain is absent from
  // it. Returning count:0 here would score it "empty" - the single distinction
  // this actor's coverage report exists to preserve. Verified live: the whole
  // index.commoncrawl.org host was returning empty replies, and every index came
  // back failed while the source still reported as an honest zero.
  const answered = queried.filter((q) => q.status === 'ok' || q.status === 'empty').length;
  if (queried.length && !answered) {
    const reason = queried.find((q) => q.error)?.error || 'unreachable';
    throw new Error(`Common Crawl index server unreachable across all ${queried.length} crawls queried - data is UNKNOWN, not absent (${reason})`);
  }

  return {
    count: rows.length,
    indexSelection: {
      strategy,
      lifespanUsed: lifespan?.fromYear ? `${lifespan.fromYear}-${lifespan.toYear}` : null,
      indexesAvailable: ids.length,
      indexListViaFallback: viaFallback,
    },
    indexesQueried: queried,
    urls: rows.slice(0, 150).map((r) => ({
      ccIndex: r.ccIndex,
      url: r.url, timestamp: r.timestamp, status: r.status,
      mime: r.mime, digest: r.digest,
      // These three make the WARC record byte-addressable for a later body fetch.
      warcFilename: r.filename, warcOffset: r.offset, warcLength: r.length,
    })),
    note: rows.length
      ? 'Common Crawl is free and unrate-limited, and its WARC records hold the original response headers and body. Byte offsets are included so bodies can be fetched directly.'
      : `No Common Crawl records for this domain across ${queried.length} crawl indexes (${queried.map((q) => q.index).join(', ')}), selected by: ${strategy}.`,
  };
}
