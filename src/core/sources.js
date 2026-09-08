/**
 * Per-source status tracking.
 *
 * The owner's hard requirement: a dead domain must return a SUCCESSFUL, populated,
 * explanatory result - never an empty dataset and never a failed run. It must say
 * exactly which sources produced data and which did not, and why.
 *
 * This also protects store ranking: Apify penalises actors below ~95% success
 * rate, and agenscrape/expired-website-checker sits at 0.0% as the live warning.
 * A dead domain is this actor's expected input, not an error condition.
 */

export const STATUS = {
  OK: 'ok',                    // queried, returned data
  EMPTY: 'empty',              // queried fine, genuinely nothing there
  FAILED: 'failed',            // errored
  SKIPPED: 'skipped',          // not applicable (e.g. live crawl on a dead domain)
  RATE_LIMITED: 'rate_limited',// we were throttled or blocked - NOT the same as empty
};

export class SourceRegistry {
  constructor() { this.records = new Map(); }

  /** Wrap a collector so its status, timing, error and yield are always recorded. */
  async run(name, label, fn, { skipIf = null } = {}) {
    if (skipIf) {
      this.records.set(name, {
        source: name, label, status: STATUS.SKIPPED, itemsFound: 0,
        durationMs: 0, error: null, note: skipIf, queriedAt: new Date().toISOString(),
      });
      return null;
    }
    const started = Date.now();
    try {
      const result = await fn();
      const count = countItems(result);
      this.records.set(name, {
        source: name,
        label,
        status: count > 0 ? STATUS.OK : STATUS.EMPTY,
        itemsFound: count,
        durationMs: Date.now() - started,
        error: null,
        note: count > 0 ? null : 'source responded but held no data for this domain',
        queriedAt: new Date().toISOString(),
      });
      return result;
    } catch (err) {
      const rateLimited = /429|rate.?limit|refused|blocked|throttl/i.test(String(err?.message || ''));
      this.records.set(name, {
        source: name,
        label,
        status: rateLimited ? STATUS.RATE_LIMITED : STATUS.FAILED,
        itemsFound: 0,
        durationMs: Date.now() - started,
        error: String(err?.message || err).slice(0, 300),
        note: rateLimited
          ? 'we were throttled - absence of data here does NOT mean the domain has none'
          : null,
        queriedAt: new Date().toISOString(),
      });
      return null;
    }
  }

  toArray() { return [...this.records.values()]; }

  counts() {
    const c = { ok: 0, empty: 0, failed: 0, skipped: 0, rate_limited: 0 };
    for (const r of this.records.values()) c[r.status] += 1;
    return c;
  }

  /** Plain-English explanation, so a sparse result is never mysterious. */
  explain() {
    const c = this.counts();
    const ok = this.toArray().filter((r) => r.status === STATUS.OK).map((r) => r.label);
    const limited = this.toArray().filter((r) => r.status === STATUS.RATE_LIMITED).map((r) => r.label);
    const parts = [];
    if (ok.length) parts.push(`Data came from: ${ok.join(', ')}.`);
    else parts.push('No source returned data for this domain.');
    if (c.empty) parts.push(`${c.empty} source(s) responded but hold nothing for this domain.`);
    if (limited.length) parts.push(`${limited.join(', ')} rate-limited us, so their data is unknown rather than absent.`);
    if (c.failed) parts.push(`${c.failed} source(s) errored.`);
    if (c.skipped) parts.push(`${c.skipped} source(s) were not applicable.`);
    return parts.join(' ');
  }
}

function countItems(r) {
  if (r == null) return 0;
  if (Array.isArray(r)) return r.length;
  if (typeof r === 'object') {
    if (typeof r.count === 'number') return r.count;
    const vals = Object.values(r).filter((v) => v != null && v !== '' && !(Array.isArray(v) && !v.length));
    return vals.length ? 1 : 0;
  }
  return r ? 1 : 0;
}
