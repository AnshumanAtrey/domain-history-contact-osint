/**
 * Politeness stack for web.archive.org.
 *
 * The critical insight, learned from WayTrace (MIT, (c) 2024-2026 thomashousset)
 * and worth restating because it is counter-intuitive: archive.org throttles by
 * DROPPING THE TCP CONNECTION, not by returning 429. So a scan sees "hundreds of
 * errors and zero 429s" and, if it keeps retrying, escalates into an IP block.
 * Connection errors must therefore feed the same backoff as a 429, and a genuine
 * connection refusal must NOT be retried at all - retrying only confirms the
 * block and deepens it.
 *
 * We start lower than WayTrace's 75/min because Apify datacenter egress IPs are
 * shared between customers and already partly throttled, so part of the budget is
 * spent before we make our first request.
 */

const START_RPM = 60;
const MIN_RPM = 30;
const MAX_RPM = 75;          // measured refusal point is ~105/min; stay well under
const INCREASE_STEP = 15;
const INCREASE_AFTER_MS = 90_000;
const DECREASE_FACTOR = 0.5;
const BURST = 6;

const SOFT_FAIL_THRESHOLD = 5;
const SOFT_FAIL_WINDOW_MS = 120_000;
const SOFT_COOLDOWN_MS = 180_000;
const HARD_FAIL_THRESHOLD = 2;
const HARD_COOLDOWN_BASE_MS = 120_000;
const HARD_COOLDOWN_MAX_MS = 1_800_000;
const HARD_STREAK_RESET_MS = 900_000;

/** Errors that mean "you are being throttled", despite not being an HTTP status. */
const THROTTLE_ERROR_CODES = new Set([
  'ECONNRESET', 'ECONNABORTED', 'EPIPE', 'ETIMEDOUT', 'ENOTFOUND',
  'EAI_AGAIN', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT',
]);

export function isThrottleError(err) {
  if (!err) return false;
  const code = err.code || err.cause?.code;
  if (code && THROTTLE_ERROR_CODES.has(code)) return true;
  const msg = String(err.message || '').toLowerCase();
  return msg.includes('socket hang up') || msg.includes('terminated')
    || msg.includes('aborted') || msg.includes('timeout');
}

/** A real IP block, as opposed to a transient blip. Never retry these. */
export function isConnectionRefused(err) {
  const code = err?.code || err?.cause?.code;
  return code === 'ECONNREFUSED' || err?.cause?.errno === -111 || err?.errno === -111;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class ArchiveLimiter {
  constructor({ log = console } = {}) {
    this.log = log;
    this.rpm = START_RPM;
    this.tokens = BURST;
    this.lastRefill = Date.now();
    this.lastAdjust = Date.now();
    this.pausedUntil = 0;
    this.softFails = [];
    this.hardStreak = 0;
    this.lastHardAt = 0;
    this.stats = { acquired: 0, throttles: 0, refusals: 0, waitedMs: 0 };
  }

  #refill() {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    this.tokens = Math.min(BURST, this.tokens + elapsed * (this.rpm / 60));
    this.lastRefill = now;
    // Additive increase after a clean stretch.
    if (now - this.lastAdjust > INCREASE_AFTER_MS && this.rpm < MAX_RPM) {
      this.rpm = Math.min(MAX_RPM, this.rpm + INCREASE_STEP);
      this.lastAdjust = now;
    }
  }

  /** Block until a request slot is available. Honours global pause and cooldowns. */
  async acquire() {
    for (;;) {
      const now = Date.now();
      if (this.pausedUntil > now) {
        const waitMs = this.pausedUntil - now;
        // A long pause must never be silent: a run once sat idle for minutes with
        // nothing in the log to say why.
        if (waitMs > 15_000 && !this.pauseAnnounced) {
          this.pauseAnnounced = true;
          this.log.info?.(`archive.org: waiting ${Math.round(waitMs / 1000)}s before the next request (throttle backoff)`);
        }
        this.stats.waitedMs += waitMs;
        await sleep(Math.min(waitMs, 5_000));
        continue;
      }
      this.pauseAnnounced = false;
      this.#refill();
      if (this.tokens >= 1) {
        this.tokens -= 1;
        this.stats.acquired += 1;
        // Up to 20% jitter so parallel workers do not thunder in lockstep.
        await sleep((60_000 / this.rpm) * (0.9 + Math.random() * 0.2) * 0.25);
        return;
      }
      const waitMs = ((1 - this.tokens) / (this.rpm / 60)) * 1000;
      this.stats.waitedMs += waitMs;
      await sleep(Math.min(Math.max(waitMs, 50), 5_000));
    }
  }

  /** Multiplicative decrease. Call on a 429 or any throttle-shaped error. */
  reportThrottle(retryAfterSec) {
    this.stats.throttles += 1;
    this.rpm = Math.max(MIN_RPM, Math.floor(this.rpm * DECREASE_FACTOR));
    this.lastAdjust = Date.now();
    // Honour Retry-After up to two minutes. Anything longer is archive.org saying
    // "not now"; the coverage report says UNKNOWN and the user re-runs later, which
    // beats a 10-minute silent wait inside a run they are paying for.
    const backoff = retryAfterSec
      ? Math.min(Math.max(retryAfterSec * 1000, 2_000), 120_000)
      : 5_000;
    this.pausedUntil = Math.max(this.pausedUntil, Date.now() + backoff);

    const now = Date.now();
    this.softFails = this.softFails.filter((t) => now - t < SOFT_FAIL_WINDOW_MS);
    this.softFails.push(now);
    if (this.softFails.length >= SOFT_FAIL_THRESHOLD) {
      this.pausedUntil = now + SOFT_COOLDOWN_MS;
      this.softFails = [];
      this.log.warning?.(`archive.org: ${SOFT_FAIL_THRESHOLD} failures in 2min, cooling down ${SOFT_COOLDOWN_MS / 1000}s`);
    }
  }

  /** Hard block. Escalating cooldown; the caller must stop, not retry. */
  reportRefusal() {
    const now = Date.now();
    this.stats.refusals += 1;
    if (now - this.lastHardAt > HARD_STREAK_RESET_MS) this.hardStreak = 0;
    this.hardStreak += 1;
    this.lastHardAt = now;
    this.rpm = MIN_RPM;
    if (this.hardStreak >= HARD_FAIL_THRESHOLD) {
      const cooldown = Math.min(HARD_COOLDOWN_BASE_MS * 2 ** (this.hardStreak - 1), HARD_COOLDOWN_MAX_MS);
      this.pausedUntil = now + cooldown;
      this.log.warning?.(`archive.org: connection refused (streak ${this.hardStreak}) - blocked, pausing ${cooldown / 1000}s`);
    }
  }

  get isHardBlocked() {
    return this.hardStreak >= HARD_FAIL_THRESHOLD && this.pausedUntil > Date.now();
  }
}
