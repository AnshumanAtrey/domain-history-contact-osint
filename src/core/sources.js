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

import { DeadlineReached, StoppedWaiting, msLeft } from './clock.js';

export const STATUS = {
  OK: 'ok',                    // queried, returned data
  EMPTY: 'empty',              // queried fine, genuinely nothing there
  FAILED: 'failed',            // errored
  SKIPPED: 'skipped',          // not applicable (e.g. live crawl on a dead domain)
  RATE_LIMITED: 'rate_limited',// we were throttled or blocked - NOT the same as empty
  TIME_LIMITED: 'time_limited',// the run's time ran out first - NOT the same as empty either
};

/** True when a source gave us nothing it can vouch for: its silence means unknown, not absent. */
export const incomplete = (rec) => [STATUS.FAILED, STATUS.RATE_LIMITED, STATUS.TIME_LIMITED].includes(rec?.status);

const TIME_NOTE = 'the run ran out of time before this source answered - absence of data here does NOT mean the domain has none. Raise the run timeout (Input > Run options) to read it';
const WAIT_NOTE = 'it had not answered when everything else in the scan was done, and the run does not wait for an extra - absence of data here does NOT mean the domain has none. Re-run later';

// Sources finish in whatever order the network allows; the report lists them in pipeline order.
const ORDER = [
  'live_dns', 'rdap', 'whois_history', 'crtsh', 'passive_dns', 'securitytrails_dns', 'securitytrails_whois',
  'ip_geolocation', 'urlscan', 'arquivo', 'grepapp', 'wayback_cdx', 'commoncrawl', 'wayback_pages',
];
const rank = (name) => { const i = ORDER.indexOf(name); return i < 0 ? ORDER.length : i; };

export class SourceRegistry {
  constructor({ log = null } = {}) {
    this.records = new Map();
    this.abandoned = new Set();
    this.log = log;
  }

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
    const done = (rec) => {
      if (this.abandoned.has(name)) return;   // the report already says this one ran out of time
      this.records.set(name, rec);
      // One line per source with its own clock: when a run is cut short, this is the timeline.
      this.log?.info(`  source ${name}: ${rec.status}${rec.itemsFound ? ` (${rec.itemsFound})` : ''} in ${(rec.durationMs / 1000).toFixed(1)}s`);
    };
    try {
      const result = await fn();
      const count = countItems(result);
      // Nothing, arriving once the clock was out, may be the clock's doing: a collector that swallows its
      // own errors (live DNS, passive DNS) answers "nothing" when its requests were cut. Not trusted as empty.
      const cutShort = count === 0 && msLeft() < 50;
      done({
        source: name,
        label,
        status: cutShort ? STATUS.TIME_LIMITED : (count > 0 ? STATUS.OK : STATUS.EMPTY),
        itemsFound: count,
        durationMs: Date.now() - started,
        error: null,
        note: cutShort ? TIME_NOTE : (count > 0 ? null : 'source responded but held no data for this domain'),
        queriedAt: new Date().toISOString(),
      });
      return result;
    } catch (err) {
      // Whatever failed once the run's clock was out failed because of it, as far as anyone can tell: a
      // collector that calls fetch itself sees the clock's abort as a plain timeout error, and one that
      // wraps its errors (Common Crawl) hides the cause in the message.
      const notWaited = err instanceof StoppedWaiting;
      const outOfTime = notWaited || err instanceof DeadlineReached || msLeft() < 50;
      const rateLimited = !outOfTime && /429|rate.?limit|refused|blocked|throttl/i.test(String(err?.message || ''));
      done({
        source: name,
        label,
        status: outOfTime ? STATUS.TIME_LIMITED : (rateLimited ? STATUS.RATE_LIMITED : STATUS.FAILED),
        itemsFound: 0,
        durationMs: Date.now() - started,
        error: String(err?.message || err).slice(0, 300),
        note: outOfTime
          ? (notWaited ? WAIT_NOTE : TIME_NOTE)
          : (rateLimited
            ? 'we were throttled - absence of data here does NOT mean the domain has none'
            : null),
        queriedAt: new Date().toISOString(),
      });
      return null;
    }
  }

  /** Record a source that was still running when the run's time ended. */
  abandon(name, label, startedAt) {
    if (this.records.has(name)) return;
    this.abandoned.add(name);
    this.log?.warning(`  source ${name}: still running when the run time budget ended, reported as time_limited`);
    this.records.set(name, {
      source: name, label, status: STATUS.TIME_LIMITED, itemsFound: 0,
      durationMs: Date.now() - startedAt, error: 'still running when the run time budget ended',
      note: TIME_NOTE,
      queriedAt: new Date().toISOString(),
    });
  }

  toArray() { return [...this.records.values()].sort((a, b) => rank(a.source) - rank(b.source)); }

  counts() {
    const c = { ok: 0, empty: 0, failed: 0, skipped: 0, rate_limited: 0, time_limited: 0 };
    for (const r of this.records.values()) c[r.status] += 1;
    return c;
  }

  /** Plain-English explanation, so a sparse result is never mysterious. */
  explain() {
    const c = this.counts();
    const ok = this.toArray().filter((r) => r.status === STATUS.OK).map((r) => r.label);
    const limited = this.toArray().filter((r) => r.status === STATUS.RATE_LIMITED).map((r) => r.label);
    const late = this.toArray().filter((r) => r.status === STATUS.TIME_LIMITED).map((r) => r.label);
    const parts = [];
    if (ok.length) parts.push(`Data came from: ${ok.join(', ')}.`);
    else parts.push('No source returned data for this domain.');
    if (c.empty) parts.push(`${c.empty} source(s) responded but hold nothing for this domain.`);
    if (limited.length) parts.push(`${limited.join(', ')} rate-limited us, so their data is unknown rather than absent.`);
    if (late.length) parts.push(`${late.join(', ')} did not answer in the time it was given, so their data is unknown rather than absent.`);
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
