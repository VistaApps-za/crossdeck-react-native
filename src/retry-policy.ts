/**
 * Retry policy for the event-queue flush.
 *
 * Verbatim port of @cross-deck/web's retry-policy. After a failed
 * flush, the queue waits before re-attempting — otherwise a flapping
 * backend causes a hot loop, and a 429 "slow down" goes ignored.
 *
 * Policy:
 *   - Exponential backoff: `base * 2^attempts`, capped at `maxMs`.
 *   - Full jitter: result is multiplied by Math.random() so 100 SDK
 *     instances retrying the same downed endpoint don't all hammer
 *     at the same instant.
 *   - 429 / 503 `Retry-After`: ALWAYS honour the server-supplied
 *     delay when it's larger than our computed backoff. Capped at
 *     24h as a sanity guard against absurd values (server bug /
 *     HTTP-date clock-skew). The server knows its own capacity
 *     better than we do; ignoring it gets your IP blocked.
 *   - Reset on success.
 *
 * Pure: no state on the function, no timers. The EventQueue owns
 * timers; the policy owns the math.
 */

export interface RetryPolicyOptions {
  baseMs?: number;
  maxMs?: number;
  factor?: number;
  /** Number of consecutive failures before flagging diagnostics. Default 8. */
  failuresBeforeWarn?: number;
}

const DEFAULT_BASE = 1000;
const DEFAULT_MAX = 60_000;
const DEFAULT_FACTOR = 2;
const DEFAULT_WARN = 8;

export function computeNextDelay(
  attempts: number,
  retryAfterMs: number | undefined,
  options: RetryPolicyOptions = {},
  random: () => number = Math.random,
): number {
  const base = options.baseMs ?? DEFAULT_BASE;
  const max = options.maxMs ?? DEFAULT_MAX;
  const factor = options.factor ?? DEFAULT_FACTOR;
  const safeAttempts = Math.min(attempts, 30);
  const ceiling = Math.min(max, base * Math.pow(factor, safeAttempts));
  const jittered = ceiling * random();
  // Honour the server-supplied delay above our computed window, but
  // cap at 24h as a sanity guard (server bug / HTTP-date clock-skew
  // could produce absurd values that would wedge the queue for years
  // otherwise).
  if (retryAfterMs !== undefined) {
    const ABSOLUTE_MAX_MS = 24 * 60 * 60 * 1000;
    const honoured = Math.min(ABSOLUTE_MAX_MS, retryAfterMs);
    if (honoured > jittered) return honoured;
  }
  return Math.max(0, Math.round(jittered));
}

export class RetryPolicy {
  private attempts = 0;
  constructor(private readonly options: RetryPolicyOptions = {}) {}

  get consecutiveFailures(): number {
    return this.attempts;
  }

  get isWarning(): boolean {
    return this.attempts >= (this.options.failuresBeforeWarn ?? DEFAULT_WARN);
  }

  nextDelay(retryAfterMs?: number, random: () => number = Math.random): number {
    const delay = computeNextDelay(this.attempts, retryAfterMs, this.options, random);
    this.attempts += 1;
    return delay;
  }

  recordSuccess(): void {
    this.attempts = 0;
  }
}
