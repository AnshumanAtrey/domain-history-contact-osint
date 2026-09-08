/**
 * Internet Archive CDX enumeration and raw snapshot retrieval.
 *
 * CDX params follow WayTrace (MIT, (c) 2024-2026 thomashousset). The single most
 * important one is `collapse=timestamp:6`: the CDX server sorts by urlkey, so
 * without it a budget is consumed entirely by thousands of homepage captures and
 * /contact is never reached. timestamp:6 keeps one capture per (URL, YYYY-MM),
 * preserving month-level change while exposing the whole URL surface.
 *
 * The `id_` replay modifier is mandatory for extraction: default replay URLs inject
 * the Wayback toolbar and rewrite every link, which pollutes regex output. `id_`
 * returns byte-original content. It also re-emits the dead origin server's own
 * response headers, prefixed `x-archive-orig-*`.
 */
import { httpGet, withRetry, RateLimited, HardBlocked } from './http.js';

const CDX = 'https://web.archive.org/cdx/search/cdx';
const FIELDS = 'timestamp,original,statuscode,mimetype,digest';

export function replayUrl(timestamp, original, mode = 'id_') {
  return `https://web.archive.org/web/${timestamp}${mode}/${original}`;
}

/** One cheap request to learn roughly how big this domain's archive is. */
export async function sizeProbe(domain, limiter) {
  const url = `${CDX}?url=${encodeURIComponent(`*.${domain}/*`)}&showNumPages=true`;
  const { body } = await withRetry(async () => {
    await limiter.acquire();
    return httpGet(url, { timeoutMs: 20_000, accept: 'text/plain', raw: true });
  }, { limiter, label: 'cdx size probe' });
  const pages = parseInt(String(body).trim(), 10);
  return Number.isFinite(pages) ? { pages, approxRecords: pages * 3000 } : { pages: 0, approxRecords: 0 };
}

/** Recover a truncated giant JSON payload by cutting at the last complete row. */
function salvageJson(raw) {
  const cut = raw.lastIndexOf('],');
  if (cut < 0) return null;
  try { return JSON.parse(`${raw.slice(0, cut)}]]`); } catch { return null; }
}

/** A lone long string as the final row is the resume key, not data. */
function stripResumeKey(rows) {
  if (!rows.length) return { rows, resumeKey: null };
  const last = rows[rows.length - 1];
  if (Array.isArray(last) && last.length === 1 && typeof last[0] === 'string' && last[0].length > 20) {
    return { rows: rows.slice(0, -1), resumeKey: last[0] };
  }
  return { rows, resumeKey: null };
}

export async function fetchSnapshots(domain, limiter, { serverLimit = 15_000, deadlineMs = 60_000, maxPages = 25 } = {}) {
  const started = Date.now();
  const out = [];
  let resumeKey = null;
  let collapse = 'timestamp:6';

  for (let page = 0; page < maxPages; page += 1) {
    if (Date.now() - started > deadlineMs) break;
    if (limiter.isHardBlocked) throw new HardBlocked('archive.org has blocked this IP');

    const p = new URLSearchParams();
    p.set('url', `*.${domain}/*`);
    p.set('output', 'json');
    p.set('fl', FIELDS);
    p.append('filter', 'statuscode:200');
    p.append('filter', 'mimetype:text/html');
    p.set('collapse', collapse);
    p.set('limit', String(serverLimit));
    p.set('showResumeKey', 'true');
    if (resumeKey) p.set('resumeKey', resumeKey);

    let rows;
    try {
      const { body } = await withRetry(async () => {
        await limiter.acquire();
        return httpGet(`${CDX}?${p}`, { timeoutMs: 45_000, raw: true });
      }, { limiter, label: 'cdx page' });
      if (!body.trim()) break;
      try { rows = JSON.parse(body); }
      catch { rows = salvageJson(body); if (!rows) break; }
    } catch (err) {
      if (err instanceof HardBlocked) throw err;
      // Fall back to the cheaper collapse once, then stop paginating.
      if (collapse === 'timestamp:6') { collapse = 'urlkey'; continue; }
      break;
    }

    const stripped = stripResumeKey(rows);
    let data = stripped.rows;
    resumeKey = stripped.resumeKey;
    if (data.length && Array.isArray(data[0]) && data[0][0] === 'timestamp') data = data.slice(1);

    for (const r of data) {
      if (!Array.isArray(r) || r.length < 5) continue;    // absorbs the stray empty row
      const [timestamp, original, statuscode, mimetype, digest] = r;
      if (!timestamp || !original) continue;
      out.push({ timestamp, original, statuscode, mimetype, digest });
    }
    if (!resumeKey) break;
  }
  return out;
}

/** Fetch byte-original archived content plus the dead origin's real headers. */
export async function fetchSnapshot(snapshot, limiter) {
  const url = replayUrl(snapshot.timestamp, snapshot.original, 'id_');
  try {
    const { res, body } = await withRetry(async () => {
      await limiter.acquire();
      return httpGet(url, { timeoutMs: 45_000, accept: 'text/html,*/*', raw: true });
    }, { limiter, attempts: 3, label: 'snapshot' });
    const originHeaders = {};
    for (const [k, v] of res.headers) {
      if (k.toLowerCase().startsWith('x-archive-orig-')) originHeaders[k.slice(15).toLowerCase()] = v;
    }
    return {
      snapshot,
      html: body.length > 10_000_000 ? body.slice(0, 10_000_000) : body,   // memory is billed
      originHeaders,
      archiveSrc: res.headers.get('x-archive-src') || null,
      mementoDatetime: res.headers.get('memento-datetime') || null,
      replayUrl: url,
      error: null,
    };
  } catch (err) {
    if (err instanceof RateLimited) { limiter.reportThrottle(err.retryAfterSec); return { snapshot, html: null, error: 'rate_limited', replayUrl: url }; }
    if (err instanceof HardBlocked) { limiter.reportRefusal(); return { snapshot, html: null, error: 'blocked', replayUrl: url }; }
    if (err.status === 404 || err.status === 410) return { snapshot, html: null, error: 'not_in_archive', replayUrl: url };
    return { snapshot, html: null, error: String(err.message).slice(0, 200), replayUrl: url };
  }
}
