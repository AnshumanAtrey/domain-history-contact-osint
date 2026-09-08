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

export async function fetchArquivo(domain) {
  // Arquivo REJECTS url-shaped queries on textsearch by design - verified live, it
  // 400s with "use the CDX server API to search for URLs". So search the brand
  // token instead of the FQDN, which is the better investigative query anyway:
  // it finds pages that TALKED ABOUT the entity, not pages that linked to it.
  const brand = domain.replace(/^www\./, '').split('.')[0];
  const url = `https://arquivo.pt/textsearch?q=${encodeURIComponent(brand)}&maxItems=50`;
  // Full-text search across ~108M archived pages is genuinely slow and sometimes
  // times out. That is reported as a source status, never as a run failure.
  const { json } = await withRetry(() => httpGet(url, { timeoutMs: 60_000 }), { attempts: 2 });
  const items = json?.response_items || [];
  return {
    count: items.length,
    estimatedTotal: json?.estimated_nr_results ?? null,
    queryUsed: brand,
    sourceUrl: url,
    references: items.slice(0, 50).map((i) => ({
      title: i.title || null,
      originalUrl: i.originalURL || null,
      archiveUrl: i.linkToArchive || null,
      timestamp: i.tstamp || null,
      snippet: (i.snippet || '').replace(/<[^>]+>/g, '').slice(0, 300) || null,
    })),
    note: items.length
      ? 'Full-text archive hits: pages whose CONTENT mentioned this domain. Each carries an archive URL you can cite.'
      : 'No full-text archive references found. Arquivo.pt skews Portuguese-language and European crawls.',
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
 * Two behaviours worth encoding. First, the index server answers 404 when it
 * simply holds nothing for a domain, which is NOT a failure - reporting it as one
 * would tell the user a source broke when it actually answered "nothing here",
 * and the whole point of the coverage report is that distinction. Second, the
 * crawl id rolls forward every few weeks, so it is resolved from collinfo.json
 * rather than hardcoded, with a fallback if that lookup fails.
 */
let ccIndexListCache = null;

/**
 * Common Crawl keeps a separate index per crawl, and a DEAD domain only exists in
 * OLDER crawls - querying just the newest one returns nothing, which would make
 * this source useless for exactly the input this actor is built for. Verified:
 * theranos.com returns 0 rows from CC-MAIN-2026-34 but 5 rows from CC-MAIN-2025-13.
 * So sample a handful of indexes spread across the available history and merge.
 */
async function ccIndexes(limit = 4) {
  if (!ccIndexListCache) {
    try {
      const { json } = await httpGet('https://index.commoncrawl.org/collinfo.json', { timeoutMs: 20_000 });
      ccIndexListCache = (json || []).map((c) => c.id).filter(Boolean);
    } catch {
      ccIndexListCache = ['CC-MAIN-2026-34', 'CC-MAIN-2025-13', 'CC-MAIN-2023-14', 'CC-MAIN-2020-16'];
    }
  }
  const all = ccIndexListCache;
  if (all.length <= limit) return all;
  // Newest, then evenly spaced back through history.
  const picks = [all[0]];
  const step = (all.length - 1) / (limit - 1);
  for (let i = 1; i < limit; i += 1) picks.push(all[Math.min(all.length - 1, Math.round(i * step))]);
  return [...new Set(picks)];
}

export async function fetchCommonCrawl(domain) {
  const indexes = await ccIndexes();
  const rows = [];
  const queried = [];
  for (const index of indexes) {
    const url = `https://index.commoncrawl.org/${index}-index?url=${encodeURIComponent(`${domain}/*`)}&output=json&limit=100`;
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

  return {
    count: rows.length,
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
      : `No Common Crawl records for this domain across ${queried.length} crawl indexes (${queried.map((q) => q.index).join(', ')}).`,
  };
}
