import { describe, it, expect } from "vitest";
import { computeNextDelay, RetryPolicy } from "../src/retry-policy";

describe("computeNextDelay — backoff math", () => {
  it("scales exponentially with attempts (deterministic RNG = 1)", () => {
    const r = () => 1;
    expect(computeNextDelay(0, undefined, { baseMs: 1000, factor: 2 }, r)).toBe(1000);
    expect(computeNextDelay(1, undefined, { baseMs: 1000, factor: 2 }, r)).toBe(2000);
    expect(computeNextDelay(2, undefined, { baseMs: 1000, factor: 2 }, r)).toBe(4000);
    expect(computeNextDelay(3, undefined, { baseMs: 1000, factor: 2 }, r)).toBe(8000);
  });

  it("clamps at maxMs", () => {
    const d = computeNextDelay(10, undefined, { baseMs: 1000, factor: 2, maxMs: 5000 }, () => 1);
    expect(d).toBe(5000);
  });

  it("Retry-After is honoured ABOVE maxMs (server is the authority — audit P1 #8)", () => {
    // Pre-Batch-E on web, the policy clamped server-supplied
    // Retry-After to maxMs (60s default). RN bakes the unclamped
    // contract from day one.
    const d = computeNextDelay(0, 120_000, { baseMs: 1000, maxMs: 60_000 }, () => 1);
    expect(d).toBe(120_000);
  });

  it("Retry-After is capped at an absolute 24h sanity guard", () => {
    const day = 24 * 60 * 60 * 1000;
    const d = computeNextDelay(0, day * 10, { baseMs: 1000, maxMs: 60_000 }, () => 1);
    expect(d).toBe(day);
  });

  it("ignores Retry-After when smaller than computed window (we wait longer)", () => {
    const d = computeNextDelay(4, 100, { baseMs: 1000, factor: 2 }, () => 1);
    expect(d).toBe(16000);
  });

  it("attempts past 30 don't overflow Infinity", () => {
    const d = computeNextDelay(1000, undefined, { baseMs: 1, maxMs: 60_000 }, () => 1);
    expect(d).toBe(60_000);
  });
});

describe("RetryPolicy", () => {
  it("tracks consecutive failures", () => {
    const p = new RetryPolicy({ baseMs: 100 });
    expect(p.consecutiveFailures).toBe(0);
    p.nextDelay(undefined, () => 1);
    p.nextDelay(undefined, () => 1);
    expect(p.consecutiveFailures).toBe(2);
  });

  it("recordSuccess resets the counter", () => {
    const p = new RetryPolicy({ baseMs: 100 });
    p.nextDelay(undefined, () => 1);
    p.recordSuccess();
    expect(p.consecutiveFailures).toBe(0);
  });

  it("flips isWarning past the failuresBeforeWarn threshold", () => {
    const p = new RetryPolicy({ baseMs: 1, failuresBeforeWarn: 3 });
    p.nextDelay(undefined, () => 1);
    p.nextDelay(undefined, () => 1);
    expect(p.isWarning).toBe(false);
    p.nextDelay(undefined, () => 1);
    expect(p.isWarning).toBe(true);
  });
});
