/**
 * The run's wall clock.
 *
 * The platform stops a run at ACTOR_TIMEOUT_AT, and Apify's daily quality check sets that
 * to five minutes. A run stopped there writes nothing, because the contacts table and the
 * report are assembled last. So every wait in this actor asks the clock how long it may
 * take, and the stages stop FINISH_RESERVE_MS before the platform would, which leaves time
 * to write what was found.
 *
 * One process is one run, so the deadline is module state: http.js and the archive limiter
 * read it and no collector needs it passed in.
 */

/** Time kept back for assembling the report, writing the rows and exiting. */
export const FINISH_RESERVE_MS = 40_000;

let deadlineAt = null;    // epoch ms; null means no limit (a local run has no platform timeout)

/** A wait was cut short because the run's time ran out, not because a server failed. */
export class DeadlineReached extends Error {
  constructor(what = 'the request') {
    super(`run time budget reached before ${what} finished`);
    this.name = 'DeadlineReached';
  }
}

/** The caller stopped waiting: everything else was done and this source is an extra. Not the source's fault. */
export class StoppedWaiting extends Error {
  constructor(what = 'the request') {
    super(`stopped waiting for ${what}: everything else in the scan was done`);
    this.name = 'StoppedWaiting';
  }
}

export function setDeadline(atMs) {
  deadlineAt = Number.isFinite(atMs) ? atMs : null;
}

export function msLeft() {
  return deadlineAt === null ? Infinity : deadlineAt - Date.now();
}

export function expired() {
  return msLeft() <= 0;
}

/** `ms`, or what the run has left when that is shorter. A whole number of ms, never negative:
 *  AbortSignal.timeout throws on a fraction, and the deadline is one whenever the reserve is. */
export function cap(ms) {
  return Math.max(0, Math.floor(Math.min(ms, msLeft())));
}

/** An AbortSignal that fires after `ms` or at the deadline, whichever comes first. */
export function timeoutSignal(ms) {
  return AbortSignal.timeout(cap(ms));
}

/**
 * When the stages must stop, given the platform's hard stop (epoch ms, or NaN when there
 * is none). The reserve shrinks for very short timeouts so a 60 s run still does some work.
 */
export function deadlineFor(platformStopAt, now = Date.now()) {
  if (!Number.isFinite(platformStopAt)) return null;
  return Math.floor(platformStopAt - Math.min(FINISH_RESERVE_MS, Math.max(platformStopAt - now, 0) * 0.25));
}
