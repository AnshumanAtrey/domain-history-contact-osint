import { test, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { fetchSnapshots } from '../src/collectors/wayback.js';
import { ArchiveLimiter } from '../src/core/ratelimit.js';

const silent = { info() {}, warning() {} };
afterEach(() => mock.restoreAll());

const answer = (body, status = 200) => mock.method(globalThis, 'fetch', () => Promise.resolve(new Response(body, { status })));
const crawl = () => fetchSnapshots('example.com', new ArchiveLimiter({ log: silent }), { maxPages: 3 });

test('an index that cannot be read fails: it must not read as "this domain was never archived"', async () => {
  const spy = answer('gone', 404);          // fails at once, no retry waits
  await assert.rejects(crawl(), /HTTP 404/);
  assert.equal(spy.mock.callCount(), 2, 'one try with each collapse mode, then it gives up');
});

test('a response that is not JSON fails the same way', async () => {
  answer('<html>Bad gateway</html>');
  await assert.rejects(crawl(), /unreadable response/);
});

test('an index that answers with nothing is genuinely empty', async () => {
  answer('');
  assert.deepEqual(await crawl(), []);
});

test('pages already read are kept when a later page cannot be read', async () => {
  const first = JSON.stringify([
    ['timestamp', 'original', 'statuscode', 'mimetype', 'digest'],
    ['20150101000000', 'https://example.com/about', '200', 'text/html', 'D1'],
    ['resume-key-that-is-longer-than-twenty'],
  ]);
  let calls = 0;
  mock.method(globalThis, 'fetch', () => {
    calls += 1;
    return Promise.resolve(calls === 1 ? new Response(first, { status: 200 }) : new Response('gone', { status: 404 }));
  });
  const rows = await crawl();
  assert.deepEqual(rows.map((r) => r.original), ['https://example.com/about']);
});
