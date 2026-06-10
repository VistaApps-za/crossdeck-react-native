/**
 * Local event queue + batched flush.
 *
 * Why a queue: track() is called from hot paths (button taps, screen
 * mounts) and shouldn't block the UI on a network round-trip. Events
 * go into a local buffer, flushed in bursts.
 *
 * Flush triggers:
 *   - Buffer reaches batchSize (default 20) → flush immediately.
 *   - intervalMs of inactivity (default 5000ms) → flush idle batch.
 *   - flush() called explicitly (e.g. when the app is backgrounding).
 *
 * Bank-grade durability + idempotency contract:
 *
 *   - `pendingBatch` slot. Events spliced for the current flush sit
 *     here until the server confirms them. On a retryable failure
 *     the same batch is re-attempted with the SAME
 *     `Idempotency-Key` so the backend can short-circuit duplicate
 *     work (Stripe pattern). On success the slot clears + buffer
 *     drains.
 *
 *   - `persistAll()`. Persisted blob always carries
 *     `[...pendingBatch, ...buffer]` so an app crash mid-flight
 *     replays the in-flight batch on the next launch. The backend
 *     dedupes via Firestore create-only on (projectId, eventId), so
 *     re-sending events that may have already landed is safe.
 *
 *   - Exponential backoff with full jitter (see retry-policy.ts) on
 *     network / 5xx / 408 / 429 failures. Honours server
 *     `Retry-After` when bigger than the computed window.
 *
 *   - 4xx hard-stop (`isPermanent4xx`). 400 / 401 / 403 / 404 / 422
 *     etc. drop the batch loudly: `onPermanentFailure` callback +
 *     `console.error` regardless of debug mode + `dropped` counter
 *     increments. Pre-fix every error retried forever with the same
 *     key, silently growing the backlog while customers thought
 *     events were landing.
 *
 *   - Hard buffer cap (1000 events). Past the cap we evict the
 *     OLDEST events and increment `dropped` so the developer can
 *     see the loss in `diagnostics()`.
 */

import type { HttpClient } from "./http";
import type { CrossdeckError } from "./errors";
import type { EventProperties, IngestResponse } from "./types";
import { RetryPolicy, type RetryPolicyOptions } from "./retry-policy";
import type { PersistentEventStore } from "./event-storage";
import { randomChars } from "./identity";

const HARD_BUFFER_CAP = 1000;

/**
 * Standardised device/platform context — §4 of the Event Envelope spec v1.
 * Promoted out of `properties` so the four SDKs share one named object
 * rather than each inlining device fields into the event payload.
 *
 * Common fields (all platforms): os, osVersion, appVersion, sdkName,
 * sdkVersion, locale, timezone.
 * RN-specific: deviceModel (mapped from Platform.constants.Model or Brand).
 */
export interface EventContext {
  os?: string;
  osVersion?: string;
  appVersion?: string;
  sdkName: string;
  sdkVersion: string;
  locale?: string;
  timezone?: string;
  /** React Native / Apple / Android — device model string. */
  deviceModel?: string;
}

export interface QueuedEvent {
  eventId: string;
  name: string;
  timestamp: number;
  /** Per-session monotonic sequence number (spec §3). */
  seq: number;
  /** Standardised device/platform context (spec §4). */
  context: EventContext;
  properties: EventProperties;
  // identity hint — at least anonymousId is always set
  developerUserId?: string;
  anonymousId?: string;
  crossdeckCustomerId?: string;
}

export interface BatchEnvelope {
  /** Integer schema version. Always 1 for this generation of the wire format. */
  envelopeVersion: 1;
  appId: string;
  environment: "production" | "sandbox";
  sdk: { name: string; version: string };
}

export interface EventQueueConfig {
  http: HttpClient;
  batchSize: number;
  intervalMs: number;
  /**
   * Returns the NorthStar §13.1 envelope to attach to each batch
   * POST. It's a function (not a value) so a future config swap can
   * update the envelope without re-instantiating the queue.
   */
  envelope: () => BatchEnvelope;
  /** Schedule a function to run after `ms` ms. Default: setTimeout. */
  scheduler?: (fn: () => void, ms: number) => () => void;
  /** Called when the SDK drops events because the buffer is full. */
  onDrop?: (dropped: number) => void;
  /** Called once after the first successful flush — drives the §16 "First event sent" signal. */
  onFirstFlushSuccess?: () => void;
  /**
   * Durable persistence. When supplied, every buffer mutation is
   * written through to the store; on `hydrate()`, persisted events
   * are loaded back into the buffer.
   */
  persistentStore?: PersistentEventStore;
  /** Retry policy overrides for failed flushes. */
  retry?: RetryPolicyOptions;
  /**
   * Called whenever an item is added to the buffer or removed by a
   * successful flush. Exposed so the host SDK can surface live
   * queue stats via `diagnostics()` without polling.
   */
  onBufferChange?: (size: number) => void;
  /**
   * Surface for the SDK's debug logger to record retry scheduling +
   * persistence events. Fired async — never throws.
   */
  onRetryScheduled?: (info: {
    delayMs: number;
    consecutiveFailures: number;
    retryAfterMs?: number;
    lastError: string;
  }) => void;
  /**
   * Fired when the queue DROPS a batch because the server returned
   * a permanent 4xx (anything except 408 / 429). The host SDK
   * should surface this loudly — pre-fix the queue retried 4xx
   * errors forever with the same Idempotency-Key, silently growing
   * the backlog while the customer thought events were landing.
   * Common causes:
   *   - 401: publishable key revoked / rotated
   *   - 403: lacking permission for the project
   *   - 400/422: malformed batch (schema mismatch, oversized event)
   *   - 404: endpoint doesn't exist (typo'd baseUrl)
   */
  onPermanentFailure?: (info: {
    status: number;
    droppedCount: number;
    lastError: string;
  }) => void;
}

export interface EventQueueStats {
  buffered: number;
  dropped: number;
  inFlight: number;
  lastFlushAt: number;
  lastError: string | null;
  /** Consecutive flush failures since the last success. */
  consecutiveFailures: number;
  /** Set when the next flush is scheduled by the retry policy. */
  nextRetryAt: number | null;
}

export class EventQueue {
  private buffer: QueuedEvent[] = [];
  /**
   * In-flight events that have been spliced from `buffer` for the
   * current batch but haven't yet been confirmed (success or
   * permanent failure). On a retry-driven re-flush we re-use this
   * slot alongside `pendingBatchId` so the Stripe-style
   * `Idempotency-Key` is preserved across retries of the SAME
   * logical batch.
   */
  private pendingBatch: QueuedEvent[] | null = null;
  private pendingBatchId: string | null = null;
  private dropped = 0;
  private inFlight = 0;
  private lastFlushAt = 0;
  private lastError: string | null = null;
  private cancelTimer: (() => void) | null = null;
  private firstFlushFired = false;
  private nextRetryAt: number | null = null;
  private readonly retry: RetryPolicy;
  private readonly persistent: PersistentEventStore | null;

  constructor(private readonly cfg: EventQueueConfig) {
    this.retry = new RetryPolicy(cfg.retry ?? {});
    this.persistent = cfg.persistentStore ?? null;
  }

  /**
   * Async hydration. Called by `Crossdeck.init()` before any
   * track() call can fire so the persisted queue is rehydrated +
   * an idle flush is scheduled for it. RN-specific: the web SDK
   * does this synchronously in its constructor (localStorage is
   * sync); we can't.
   */
  async hydrate(): Promise<void> {
    if (!this.persistent) return;
    const restored = await this.persistent.load();
    if (restored.length === 0) return;
    if (restored.length > HARD_BUFFER_CAP) {
      this.dropped += restored.length - HARD_BUFFER_CAP;
      this.buffer = restored.slice(restored.length - HARD_BUFFER_CAP);
    } else {
      this.buffer = restored;
    }
    this.cfg.onBufferChange?.(this.buffer.length);
    // Schedule an immediate idle flush so rehydrated events land
    // on the next tick — even if no new track() call comes in.
    this.scheduleIdleFlush();
  }

  enqueue(event: QueuedEvent): void {
    this.buffer.push(event);
    if (this.buffer.length > HARD_BUFFER_CAP) {
      const overflow = this.buffer.length - HARD_BUFFER_CAP;
      this.buffer.splice(0, overflow);
      this.dropped += overflow;
      this.cfg.onDrop?.(overflow);
    }
    this.cfg.onBufferChange?.(this.buffer.length);
    this.persistAll();
    if (this.buffer.length >= this.cfg.batchSize) {
      void this.flush();
    } else {
      this.scheduleIdleFlush();
    }
  }

  /**
   * Flush the buffer to /v1/events. Resolves when the network call
   * completes (success or failure).
   *
   * Three terminal states from one call:
   *   - 2xx success: pendingBatch cleared, persisted state collapses
   *     to just `buffer` (any new events that arrived during
   *     in-flight).
   *   - 4xx permanent (except 408/429): pendingBatch DROPPED,
   *     `dropped` increments, `onPermanentFailure` fires. The server
   *     is telling us our request is malformed / key revoked / no
   *     permission — retrying with the same key forever just grows
   *     the queue.
   *   - 5xx / network / 408 / 429: pendingBatch + batchId stay;
   *     backoff schedules a retry; the next `flush()` re-uses both.
   */
  async flush(): Promise<IngestResponse | null> {
    // Resume an in-flight batch retry path: if we already have a
    // pending batch (prior flush failed, retry timer / caller is
    // re-invoking), re-attempt with the SAME batchId. Stripe
    // Idempotency-Key reuse contract.
    let batch: QueuedEvent[];
    let batchId: string;
    if (this.pendingBatch !== null && this.pendingBatchId !== null) {
      batch = this.pendingBatch;
      batchId = this.pendingBatchId;
    } else {
      if (this.buffer.length === 0) return null;
      batch = this.buffer.splice(0);
      batchId = this.mintBatchId();
      this.pendingBatch = batch;
      this.pendingBatchId = batchId;
      this.inFlight += batch.length;
      this.cfg.onBufferChange?.(this.buffer.length);
      // Persisted state continues to include this batch via
      // persistAll() until the server confirms it — that's the
      // durability fix.
      this.persistAll();
    }
    this.cancelTimerIfSet();
    this.nextRetryAt = null;

    try {
      const env = this.cfg.envelope();
      const result = await this.cfg.http.request<IngestResponse>("POST", "/events", {
        body: {
          envelopeVersion: env.envelopeVersion,
          appId: env.appId,
          environment: env.environment,
          sdk: env.sdk,
          events: batch,
        },
        idempotencyKey: batchId,
      });
      this.lastFlushAt = Date.now();
      this.lastError = null;
      this.inFlight -= batch.length;
      this.pendingBatch = null;
      this.pendingBatchId = null;
      this.retry.recordSuccess();
      // Persisted blob collapses to just `buffer` (which may include
      // new enqueues that arrived while this batch was in flight).
      this.persistAll();
      if (!this.firstFlushFired) {
        this.firstFlushFired = true;
        this.cfg.onFirstFlushSuccess?.();
      }
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.lastError = message;

      // Permanent failures (4xx except 408/429) are NOT retryable.
      // Drop the batch loudly.
      if (isPermanent4xx(err)) {
        const droppedCount = batch.length;
        this.pendingBatch = null;
        this.pendingBatchId = null;
        this.inFlight -= droppedCount;
        this.dropped += droppedCount;
        this.persistAll();
        this.cfg.onDrop?.(droppedCount);
        this.cfg.onPermanentFailure?.({
          status: (err as { status?: number }).status ?? 0,
          droppedCount,
          lastError: message,
        });
        return null;
      }

      // Retryable failure. pendingBatch + pendingBatchId stay set;
      // the next scheduler-driven flush re-uses both. Persisted
      // state is unchanged from the entry path — it still includes
      // `[...pendingBatch, ...buffer]`.
      const retryAfterMs = extractRetryAfterMs(err);
      const delay = this.retry.nextDelay(retryAfterMs);
      this.scheduleRetry(delay);
      this.cfg.onRetryScheduled?.({
        delayMs: delay,
        consecutiveFailures: this.retry.consecutiveFailures,
        retryAfterMs,
        lastError: message,
      });
      return null;
    }
  }

  /** Cancel any pending timer and clear in-memory state. Wipes durable store too. */
  reset(): void {
    this.cancelTimerIfSet();
    this.nextRetryAt = null;
    this.buffer = [];
    this.pendingBatch = null;
    this.pendingBatchId = null;
    this.dropped = 0;
    this.inFlight = 0;
    this.lastError = null;
    this.retry.recordSuccess();
    void this.persistent?.clear();
    this.cfg.onBufferChange?.(0);
    // Note: we deliberately do NOT reset firstFlushFired — the
    // "First event sent" signal is a one-time onboarding moment per
    // SDK instance lifetime, not per-identity.
  }

  getStats(): EventQueueStats {
    return {
      buffered: this.buffer.length,
      dropped: this.dropped,
      inFlight: this.inFlight,
      lastFlushAt: this.lastFlushAt,
      lastError: this.lastError,
      consecutiveFailures: this.retry.consecutiveFailures,
      nextRetryAt: this.nextRetryAt,
    };
  }

  /**
   * The Idempotency-Key of the in-flight pending batch (if any).
   * Exposed for testing the Stripe-style retry-reuse contract.
   */
  get pendingIdempotencyKey(): string | null {
    return this.pendingBatchId;
  }

  // ---------- internal ----------

  private persistAll(): void {
    if (!this.persistent) return;
    if (this.pendingBatch === null) {
      this.persistent.save(this.buffer);
      return;
    }
    this.persistent.save([...this.pendingBatch, ...this.buffer]);
  }

  private scheduleIdleFlush(): void {
    this.cancelTimerIfSet();
    const sched = this.cfg.scheduler ?? defaultScheduler;
    this.cancelTimer = sched(() => {
      void this.flush();
    }, this.cfg.intervalMs);
  }

  private scheduleRetry(delayMs: number): void {
    this.cancelTimerIfSet();
    this.nextRetryAt = Date.now() + delayMs;
    const sched = this.cfg.scheduler ?? defaultScheduler;
    this.cancelTimer = sched(() => {
      void this.flush();
    }, delayMs);
  }

  private cancelTimerIfSet(): void {
    if (this.cancelTimer) {
      this.cancelTimer();
      this.cancelTimer = null;
    }
  }

  private mintBatchId(): string {
    return `batch_${Date.now().toString(36)}${randomChars(10)}`;
  }
}

function extractRetryAfterMs(err: unknown): number | undefined {
  if (err && typeof err === "object" && "retryAfterMs" in err) {
    const v = (err as CrossdeckError).retryAfterMs;
    return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
  }
  return undefined;
}

/**
 * True when the error represents a permanent 4xx response that
 * SHOULDN'T be retried. Excludes 408 Request Timeout and 429 Too
 * Many Requests — both indicate transient state where the SAME
 * request (with the SAME Idempotency-Key) can succeed on a retry.
 *
 * Anything that isn't a CrossdeckError-shaped object with a numeric
 * status field returns false (network errors / fetch failures fall
 * here — those ARE retryable). Conservative default: only flag as
 * permanent when we have strong evidence from the server.
 */
function isPermanent4xx(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const status = (err as { status?: unknown }).status;
  if (typeof status !== "number" || !Number.isFinite(status)) return false;
  if (status < 400 || status >= 500) return false;
  if (status === 408 || status === 429) return false;
  return true;
}

function defaultScheduler(fn: () => void, ms: number): () => void {
  const id = setTimeout(fn, ms);
  // setTimeout on Hermes supports .unref() on newer versions; the
  // typeof check is defensive for older runtimes that don't.
  if (typeof (id as unknown as { unref?: () => void }).unref === "function") {
    try {
      (id as unknown as { unref: () => void }).unref();
    } catch {
      // ignore — unref is best-effort
    }
  }
  return () => clearTimeout(id);
}
