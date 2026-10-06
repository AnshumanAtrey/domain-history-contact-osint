import { test, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { setDeadline, msLeft, expired, cap, deadlineFor, DeadlineReached, FINISH_RESERVE_MS } from '../src/core/clock.js';
import { httpGet, withRetry } from '../src/collectors/http.js';
import { ArchiveLimiter } from '../src/core/ratelimit.js';
import { SourceRegistry, STATUS, incomplete } from '../src/core/sources.js';
import { fetchSnapshots } from '../src/collectors/wayback.js';
import { fetchArquivo } from '../src/collectors/references.js';
import { readOrder } from '../src/core/sampler.js';

const silent = { info() {}, warning() {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
afterEach(() => { setDeadline(null); mock.restoreAll(); });

/** A server that accepts requests and never answers them. */
async function hangingServer() {
  const server = http.createServer(() => {});
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}/`, close: () => { server.closeAllConnections(); server.close(); } };
}

/** fetch that answers by URL, and hangs (until aborted) where `hang` matches. */
function fakeFetch({ hang = [], answer = {} }) {
  return mock.method(globalThis, 'fetch', (url, { signal } = {}) => {
    const u = String(url);
    if (hang.some((h) => u.includes(h))) {
      return new Promise((_, reject) => signal?.addEventListener('abort', () => reject(signal.reason)));
    }
    const key = Object.keys(answer).find((k) => u.includes(k));
    return Promise.resolve(new Response(key ? answer[key] : '', { status: 200 }));
  });
}

test('no deadline means no limit', () => {
  setDeadline(null);
  assert.equal(msLeft(), Infinity);
  assert.equal(expired(), false);
  assert.equal(cap(30_000), 30_000);
});

test('cap never exceeds what the run has left, and is never negative', () => {
  setDeadline(Date.now() + 5_000);
  assert.ok(cap(30_000) <= 5_000 && cap(30_000) > 4_000);
  assert.equal(cap(1_000), 1_000);
  setDeadline(Date.now() - 1);
  assert.equal(cap(30_000), 0);
  assert.equal(expired(), true);
});

test('stages stop a fixed reserve before the platform does, a smaller one on short runs', () => {
  const now = Date.now();
  assert.equal(deadlineFor(Number.NaN, now), null);
  assert.equal(deadlineFor(now + 300_000, now), now + 300_000 - FINISH_RESERVE_MS);   // the quality check: 5 minutes
  assert.equal(deadlineFor(now + 60_000, now), now + 60_000 - 15_000);                // a quarter of a short run
  assert.equal(deadlineFor(now - 1_000, now), now - 1_000);                           // already past: no reserve to take
});

test('a request that would wait for ever is cut at the deadline, not at its own timeout', async () => {
  const server = await hangingServer();
  try {
    setDeadline(Date.now() + 300);
    const t0 = Date.now();
    await assert.rejects(httpGet(server.url, { timeoutMs: 30_000 }), DeadlineReached);
    assert.ok(Date.now() - t0 < 1_500, `took ${Date.now() - t0} ms`);
  } finally { server.close(); }
});

test('a deadline that is not a whole number of ms still caps requests (the reserve is a quarter of a short run)', async () => {
  // Regression: cap() returned a fraction, AbortSignal.timeout threw ERR_OUT_OF_RANGE, and every
  // request made while the deadline was nearer than its own timeout failed at once.
  const server = await hangingServer();
  try {
    setDeadline(deadlineFor(Date.now() + 1_001));          // a quarter of 1,001 ms is a fraction
    assert.equal(Number.isInteger(cap(45_000)), true);
    const t0 = Date.now();
    await assert.rejects(httpGet(server.url, { timeoutMs: 45_000 }), DeadlineReached);
    assert.ok(Date.now() - t0 < 1_500, `took ${Date.now() - t0} ms`);
    setDeadline(Date.now() + 400.6);
    assert.equal(Number.isInteger(cap(45_000)), true);
    await assert.rejects(httpGet(server.url, { timeoutMs: 45_000 }), DeadlineReached);
  } finally { server.close(); }
});

test('with the deadline already past, nothing is sent', async () => {
  const spy = fakeFetch({});
  setDeadline(Date.now() - 1);
  await assert.rejects(httpGet('https://example.invalid/'), DeadlineReached);
  assert.equal(spy.mock.callCount(), 0);
});

test('a retry is not attempted when the run has no time left for it', async () => {
  const server = await hangingServer();
  try {
    setDeadline(Date.now() + 400);
    let calls = 0;
    const t0 = Date.now();
    await assert.rejects(
      withRetry(() => { calls += 1; return httpGet(server.url, { timeoutMs: 30_000 }); }, { attempts: 4 }),
      DeadlineReached,
    );
    assert.equal(calls, 1);                                  // 4 x 30 s without the clock
    assert.ok(Date.now() - t0 < 1_500);
  } finally { server.close(); }
});

test('the archive limiter refuses a cooldown the run cannot wait out', async () => {
  const limiter = new ArchiveLimiter({ log: silent });
  limiter.pausedUntil = Date.now() + 120_000;                // a throttle cooldown
  setDeadline(Date.now() + 5_000);
  const t0 = Date.now();
  await assert.rejects(limiter.acquire(), DeadlineReached);
  assert.ok(Date.now() - t0 < 500, 'it must fail at once, not sleep until the platform kills the run');
});

test('a source cut by the clock is time_limited, which counts as incomplete and is never called empty', async () => {
  const sources = new SourceRegistry();
  await sources.run('arquivo', 'Arquivo.pt', async () => { throw new DeadlineReached('Arquivo'); });
  await sources.run('crtsh', 'crt.sh', async () => { throw new Error('HTTP 500 on crt.sh'); });
  await sources.run('rdap', 'RDAP', async () => [1, 2]);
  const by = Object.fromEntries(sources.toArray().map((r) => [r.source, r]));
  assert.equal(by.arquivo.status, STATUS.TIME_LIMITED);
  assert.match(by.arquivo.note, /does NOT mean the domain has none/);
  assert.equal(incomplete(by.arquivo), true);
  assert.equal(incomplete(by.crtsh), true);
  assert.equal(incomplete(by.rdap), false);
  assert.equal(sources.counts().time_limited, 1);
  assert.match(sources.explain(), /Arquivo\.pt did not finish before the run's time limit/);
});

test('a collector that calls fetch itself is still seen as out of time when the clock aborted it', async () => {
  const sources = new SourceRegistry();
  setDeadline(Date.now() + 50);
  await sources.run('grepapp', 'grep.app', async () => { await sleep(120); throw new DOMException('The operation was aborted due to timeout', 'TimeoutError'); });
  assert.equal(sources.toArray()[0].status, STATUS.TIME_LIMITED);
});

test('an empty answer that arrives after the deadline is not trusted as empty', async () => {
  // Live and passive DNS swallow their own errors, so a request the clock cut comes back as "nothing".
  const sources = new SourceRegistry();
  setDeadline(Date.now() + 80);
  await sources.run('passive_dns', 'Passive DNS', async () => { await sleep(120); return { count: 0 }; });
  const [rec] = sources.toArray();
  assert.equal(rec.status, STATUS.TIME_LIMITED);
  assert.equal(incomplete(rec), true);
});

test('an empty answer with time to spare is still empty', async () => {
  const sources = new SourceRegistry();
  setDeadline(Date.now() + 60_000);
  await sources.run('passive_dns', 'Passive DNS', async () => ({ count: 0 }));
  assert.equal(sources.toArray()[0].status, STATUS.EMPTY);
});

test('a wrapped error that surfaces after the deadline is time_limited, not failed', async () => {
  const sources = new SourceRegistry();
  setDeadline(Date.now() + 60);
  await sources.run('commoncrawl', 'Common Crawl', async () => { await sleep(100); throw new Error('Common Crawl index server unreachable across all 5 crawls queried (x)'); });
  assert.equal(sources.toArray()[0].status, STATUS.TIME_LIMITED);
});

test('a real failure with time to spare stays failed', async () => {
  const sources = new SourceRegistry();
  setDeadline(Date.now() + 60_000);
  await sources.run('crtsh', 'crt.sh', async () => { throw new Error('HTTP 500 on crt.sh'); });
  assert.equal(sources.toArray()[0].status, STATUS.FAILED);
});

test('a source still running at the deadline is abandoned, and its late answer does not rewrite the report', async () => {
  const sources = new SourceRegistry();
  const late = sources.run('urlscan', 'urlscan.io', async () => { await sleep(60); return [1]; });
  sources.abandon('urlscan', 'urlscan.io', Date.now() - 1_000);
  await late;
  const [rec] = sources.toArray();
  assert.equal(rec.status, STATUS.TIME_LIMITED);
  assert.equal(sources.counts().ok, 0);
});

test('sources are listed in pipeline order whatever order they finish in', async () => {
  const sources = new SourceRegistry();
  await sources.run('wayback_pages', 'pages', async () => [1]);
  await sources.run('rdap', 'rdap', async () => [1]);
  await sources.run('live_dns', 'live', async () => [1]);
  await sources.run('commoncrawl', 'cc', async () => [1]);
  assert.deepEqual(sources.toArray().map((r) => r.source), ['live_dns', 'rdap', 'commoncrawl', 'wayback_pages']);
});

const cdxRow = (ts, path) => [ts, `https://example.com/${path}`, '200', 'text/html', `D${ts}`];

test('the CDX crawl keeps the pages it already read when the clock runs out mid-way', async () => {
  const header = ['timestamp', 'original', 'statuscode', 'mimetype', 'digest'];
  const first = JSON.stringify([header, cdxRow('20150101000000', 'about'), cdxRow('20150201000000', 'contact'), ['resume-key-that-is-longer-than-twenty']]);
  let calls = 0;
  mock.method(globalThis, 'fetch', (url, { signal } = {}) => {
    calls += 1;
    if (calls === 1) return Promise.resolve(new Response(first, { status: 200 }));
    return new Promise((_, reject) => signal?.addEventListener('abort', () => reject(signal.reason)));   // page 2 never answers
  });
  setDeadline(Date.now() + 700);
  const t0 = Date.now();
  const rows = await fetchSnapshots('example.com', new ArchiveLimiter({ log: silent }), { maxPages: 3 });
  assert.deepEqual(rows.map((r) => r.original), ['https://example.com/about', 'https://example.com/contact']);
  assert.ok(Date.now() - t0 < 2_500);
});

test('the CDX crawl fails as out of time, not as empty, when nothing arrived before the clock ran out', async () => {
  fakeFetch({ hang: ['web.archive.org'] });
  setDeadline(Date.now() + 300);
  await assert.rejects(fetchSnapshots('example.com', new ArchiveLimiter({ log: silent }), {}), DeadlineReached);
});

test('Arquivo keeps the captures when its slow full-text half is cut by the clock', async () => {
  const capture = JSON.stringify({ url: 'http://example.com/', timestamp: '20150101000000', status: '200', mime: 'text/html' });
  fakeFetch({ hang: ['arquivo.pt/textsearch'], answer: { 'arquivo.pt/wayback/cdx': capture } });
  setDeadline(Date.now() + 500);
  const out = await fetchArquivo('example.com');
  assert.equal(out.captureCount, 1);
  assert.equal(out.mentionCount, 0);
  assert.equal(out.errors.length, 1);                         // the search half said why it is missing
});

test('Arquivo reports out of time, not unreachable, when both halves ran out of clock', async () => {
  fakeFetch({ hang: ['arquivo.pt'] });
  setDeadline(Date.now() + 300);
  await assert.rejects(fetchArquivo('example.com'), DeadlineReached);
});

test('pages most likely to name people are read first, oldest first within each class', () => {
  const page = (path, ts) => ({ original: `https://example.com${path}`, timestamp: ts });
  const sampled = [
    page('/products/widget', '20120101000000'),
    page('/', '20120601000000'),
    page('/team', '20180101000000'),
    page('/contact', '20140101000000'),
    page('/pricing', '20130101000000'),
  ];
  assert.deepEqual(readOrder(sampled).map((p) => new URL(p.original).pathname), ['/contact', '/team', '/', '/products/widget', '/pricing']);
  assert.equal(sampled[0].original, 'https://example.com/products/widget', 'the report order must not change');
});
