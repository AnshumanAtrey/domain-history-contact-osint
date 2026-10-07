/** Shared fetch helper: timeouts, a real UA, and throttle-aware error shaping. */
import { isThrottleError, isConnectionRefused } from '../core/ratelimit.js';
import { cap, msLeft, expired, DeadlineReached, StoppedWaiting } from '../core/clock.js';

export const UA = 'domain-history-contact-osint/0.1 (+https://apify.com/anshumanatrey/domain-history-contact-osint)';

export class RateLimited extends Error {
  constructor(msg, retryAfterSec) { super(msg); this.name = 'RateLimited'; this.retryAfterSec = retryAfterSec; }
}
export class HardBlocked extends Error {
  constructor(msg) { super(msg); this.name = 'HardBlocked'; }
}

export async function httpGet(url, { timeoutMs = 30_000, headers = {}, accept = 'application/json', raw = false, signal = null } = {}) {
  if (signal?.aborted) throw new StoppedWaiting(url);
  if (expired()) throw new DeadlineReached(url);
  const timeout = AbortSignal.timeout(cap(timeoutMs));   // never past the run's deadline
  let res;
  try {
    res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: accept, ...headers },
      signal: signal ? AbortSignal.any([timeout, signal]) : timeout,   // `signal`: the caller may stop waiting
      redirect: 'follow',
    });
  } catch (err) {
    if (signal?.aborted) throw new StoppedWaiting(url);
    // The run's clock aborted it, not the server: not a throttle signal, and not worth a retry.
    if (msLeft() < 100) throw new DeadlineReached(url);
    if (isConnectionRefused(err)) throw new HardBlocked(`connection refused: ${url}`);
    if (isThrottleError(err)) throw new RateLimited(`throttled (${err.code || err.message}): ${url}`);
    throw err;
  }
  if (res.status === 429 || res.status === 503) {
    const ra = Number(res.headers.get('retry-after')) || null;
    throw new RateLimited(`HTTP ${res.status} on ${url}`, ra);
  }
  if (!res.ok) {
    const e = new Error(`HTTP ${res.status} on ${url}`);
    e.status = res.status;
    throw e;
  }
  // The abort signal also covers the body, so a slow body is cut at the deadline too.
  const read = () => res.text().catch((err) => {
    throw signal?.aborted ? new StoppedWaiting(url) : (msLeft() < 100 ? new DeadlineReached(url) : err);
  });
  if (raw) return { res, body: await read() };
  const text = await read();
  if (!text.trim()) return { res, json: null, body: text };
  try { return { res, json: JSON.parse(text), body: text }; }
  catch { return { res, json: null, body: text }; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Retry a throttled request with backoff, feeding the limiter so the whole run
 * slows down rather than just this one call.
 *
 * archive.org 503s aggressively - measured live it returned 200 then 503 twice on
 * consecutive requests from a single IP. A 503 here is a throttle signal, not an
 * outage, so it must be waited out, not surfaced as a failure. On Apify this is
 * worse still: datacenter egress IPs are shared between customers, so part of the
 * budget is already spent before the actor makes its first request.
 */
export async function withRetry(fn, { limiter, attempts = 4, label = 'request' } = {}) {
  let lastErr;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (err instanceof DeadlineReached || err instanceof StoppedWaiting) throw err;   // out of time, or no longer wanted
      if (err instanceof HardBlocked) { limiter?.reportRefusal(); throw err; }
      if (err instanceof RateLimited) {
        limiter?.reportThrottle(err.retryAfterSec);
        const wait = err.retryAfterSec
          ? Math.min(err.retryAfterSec * 1000, 60_000)
          : Math.min(2_000 * 2 ** attempt, 30_000) * (0.9 + Math.random() * 0.2);
        if (attempt < attempts - 1) { await sleep(cap(wait)); continue; }
      }
      if (err.status === 404 || err.status === 410) throw err;   // definitive, do not retry
      if (attempt < attempts - 1) { await sleep(cap(1_000 * 2 ** attempt)); continue; }
      throw err;
    }
  }
  throw lastErr;
}
