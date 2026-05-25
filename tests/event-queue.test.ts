import { describe, it, expect, vi } from "vitest";
import { EventQueue, type QueuedEvent } from "../src/event-queue";
import { PersistentEventStore } from "../src/event-storage";
import { MemoryStorage } from "../src/storage";
import { CrossdeckError } from "../src/errors";

function fakeEvent(name: string): QueuedEvent {
  return {
    eventId: `evt_${name}_${Math.random().toString(36).slice(2)}`,
    name,
    timestamp: Date.now(),
    properties: {},
    anonymousId: "anon_test",
  };
}

function fakeHttp(behaviour: "ok" | "fail" = "ok") {
  return {
    request: vi.fn().mockImplementation(async () => {
      if (behaviour === "fail") throw new Error("network down");
      return { object: "list", received: 0, env: "production" };
    }),
  };
}

const TEST_ENVELOPE = () => ({
  appId: "app_rn_test",
  environment: "sandbox" as const,
  sdk: { name: "@cross-deck/react-native", version: "0.1.0-test" },
});

describe("EventQueue — basic", () => {
  it("flushes immediately when batchSize is reached", async () => {
    const http = fakeHttp("ok");
    const q = new EventQueue({
      http: http as never,
      batchSize: 3,
      intervalMs: 10_000,
      envelope: TEST_ENVELOPE,
      scheduler: () => () => {},
    });
    q.enqueue(fakeEvent("a"));
    q.enqueue(fakeEvent("b"));
    expect(http.request).toHaveBeenCalledTimes(0);
    q.enqueue(fakeEvent("c"));
    await new Promise((r) => setTimeout(r, 0));
    expect(http.request).toHaveBeenCalledTimes(1);
    const body = http.request.mock.calls[0]![2].body as { events: QueuedEvent[] };
    expect(body.events.length).toBe(3);
  });

  it("envelope includes environment for backend env_mismatch defence", async () => {
    const http = fakeHttp("ok");
    const q = new EventQueue({
      http: http as never,
      batchSize: 1,
      intervalMs: 10_000,
      envelope: TEST_ENVELOPE,
      scheduler: () => () => {},
    });
    q.enqueue(fakeEvent("a"));
    await new Promise((r) => setTimeout(r, 0));
    const body = http.request.mock.calls[0]![2].body as { environment: string };
    expect(body.environment).toBe("sandbox");
  });
});

describe("EventQueue — durability + Idempotency-Key reuse (audit P0 #4)", () => {
  it("keeps the batch in the pendingBatch slot on retryable failure (NOT re-buffered)", async () => {
    const http = fakeHttp("fail");
    const q = new EventQueue({
      http: http as never,
      batchSize: 2,
      intervalMs: 10_000,
      envelope: TEST_ENVELOPE,
      scheduler: () => () => {},
    });
    q.enqueue(fakeEvent("a"));
    q.enqueue(fakeEvent("b"));
    await new Promise((r) => setTimeout(r, 0));
    // Events live in pendingBatch (`inFlight`), not in the outer
    // `buffered` count. The Idempotency-Key is preserved across
    // retries.
    expect(q.getStats().buffered).toBe(0);
    expect(q.getStats().inFlight).toBe(2);
    expect(q.pendingIdempotencyKey).toMatch(/^batch_/);
  });

  it("retried flush of the SAME batch reuses the SAME Idempotency-Key (Stripe pattern)", async () => {
    let attempt = 0;
    const http = {
      request: vi.fn().mockImplementation(async () => {
        attempt += 1;
        if (attempt === 1) throw new Error("network down");
        return { object: "list", received: 0, env: "production" };
      }),
    };
    let triggerRetry: (() => void) | null = null;
    const q = new EventQueue({
      http: http as never,
      batchSize: 1,
      intervalMs: 10_000,
      envelope: TEST_ENVELOPE,
      scheduler: (fn) => {
        triggerRetry = fn;
        return () => {};
      },
    });
    q.enqueue(fakeEvent("a"));
    await new Promise((r) => setTimeout(r, 10));
    const firstKey = http.request.mock.calls[0]![2].idempotencyKey as string;
    expect(firstKey).toMatch(/^batch_/);
    expect(q.pendingIdempotencyKey).toBe(firstKey);
    triggerRetry!();
    await new Promise((r) => setTimeout(r, 10));
    const secondKey = http.request.mock.calls[1]![2].idempotencyKey as string;
    expect(secondKey).toBe(firstKey);
    // After success the slot clears so the NEXT logical batch gets
    // a fresh key.
    expect(q.pendingIdempotencyKey).toBeNull();
  });

  it("persists [...pendingBatch, ...buffer] so a crash mid-flight replays the in-flight batch", async () => {
    const storage = new MemoryStorage();
    const http = fakeHttp("fail");
    const q = new EventQueue({
      http: http as never,
      batchSize: 2,
      intervalMs: 10_000,
      envelope: TEST_ENVELOPE,
      scheduler: () => () => {},
      persistentStore: new PersistentEventStore({ storage, prefix: "cd:" }),
    });
    q.enqueue(fakeEvent("a"));
    q.enqueue(fakeEvent("b"));
    await new Promise((r) => setTimeout(r, 0));
    // Network failed; persisted blob must STILL contain both events
    // so a crash here gets a replay on next boot.
    const persisted = await new PersistentEventStore({ storage, prefix: "cd:" }).load();
    expect(persisted.length).toBe(2);
    expect(persisted.map((e) => e.name)).toEqual(["a", "b"]);
  });
});

describe("EventQueue — 4xx hard-stop (audit P0 #6)", () => {
  function fake4xx(status: number, code: string) {
    return {
      request: vi.fn().mockRejectedValue(
        new CrossdeckError({
          type: "invalid_request_error",
          code,
          message: `HTTP ${status}`,
          status,
        }),
      ),
    };
  }

  it("drops the batch and fires onPermanentFailure on 401 (key revoked)", async () => {
    const http = fake4xx(401, "invalid_api_key");
    const drops: number[] = [];
    const perm: Array<{ status: number; droppedCount: number; lastError: string }> = [];
    const q = new EventQueue({
      http: http as never,
      batchSize: 2,
      intervalMs: 10_000,
      envelope: TEST_ENVELOPE,
      scheduler: () => () => {},
      onDrop: (n) => drops.push(n),
      onPermanentFailure: (info) => perm.push(info),
    });
    q.enqueue(fakeEvent("a"));
    q.enqueue(fakeEvent("b"));
    await new Promise((r) => setTimeout(r, 0));
    expect(drops).toEqual([2]);
    expect(perm).toEqual([{ status: 401, droppedCount: 2, lastError: "HTTP 401" }]);
    expect(q.getStats().nextRetryAt).toBeNull();
    expect(q.getStats().consecutiveFailures).toBe(0);
    expect(q.getStats().dropped).toBe(2);
    expect(q.pendingIdempotencyKey).toBeNull();
  });

  it("drops on 400 (malformed batch)", async () => {
    const http = fake4xx(400, "invalid_event");
    const perm: Array<{ status: number }> = [];
    const q = new EventQueue({
      http: http as never,
      batchSize: 1,
      intervalMs: 10_000,
      envelope: TEST_ENVELOPE,
      scheduler: () => () => {},
      onPermanentFailure: (info) => perm.push({ status: info.status }),
    });
    q.enqueue(fakeEvent("a"));
    await new Promise((r) => setTimeout(r, 0));
    expect(perm).toEqual([{ status: 400 }]);
  });

  it("RETAINS the batch on 408 (transient timeout — retryable)", async () => {
    const http = fake4xx(408, "request_timeout");
    const perm: Array<unknown> = [];
    const q = new EventQueue({
      http: http as never,
      batchSize: 1,
      intervalMs: 10_000,
      envelope: TEST_ENVELOPE,
      scheduler: () => () => {},
      onPermanentFailure: (info) => perm.push(info),
    });
    q.enqueue(fakeEvent("a"));
    await new Promise((r) => setTimeout(r, 0));
    expect(perm).toEqual([]);
    expect(q.getStats().nextRetryAt).not.toBeNull();
    expect(q.getStats().inFlight).toBe(1);
  });

  it("RETAINS the batch on 429 (rate-limited — retryable, honours Retry-After)", async () => {
    const http = {
      request: vi.fn().mockRejectedValue(
        new CrossdeckError({
          type: "rate_limit_error",
          code: "rate_limited",
          message: "slow",
          status: 429,
          retryAfterMs: 2_500,
        }),
      ),
    };
    let lastDelay = 0;
    const q = new EventQueue({
      http: http as never,
      batchSize: 1,
      intervalMs: 10_000,
      envelope: TEST_ENVELOPE,
      scheduler: (_fn, ms) => {
        lastDelay = ms;
        return () => {};
      },
    });
    q.enqueue(fakeEvent("a"));
    await new Promise((r) => setTimeout(r, 0));
    expect(lastDelay).toBe(2_500);
  });

  it("RETAINS the batch on a plain network error (no status — retryable)", async () => {
    const http = fakeHttp("fail");
    const perm: Array<unknown> = [];
    const q = new EventQueue({
      http: http as never,
      batchSize: 1,
      intervalMs: 10_000,
      envelope: TEST_ENVELOPE,
      scheduler: () => () => {},
      onPermanentFailure: (info) => perm.push(info),
    });
    q.enqueue(fakeEvent("a"));
    await new Promise((r) => setTimeout(r, 0));
    expect(perm).toEqual([]);
    expect(q.getStats().nextRetryAt).not.toBeNull();
    expect(q.getStats().inFlight).toBe(1);
  });
});
