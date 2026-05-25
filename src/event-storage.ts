/**
 * Durable event-queue persistence.
 *
 * Why this exists: the in-memory event-queue is fragile. Three
 * failure modes lose data without durable persistence:
 *
 *   1. App backgrounding under iOS / Android low-memory pressure
 *      where the OS reclaims the JS context before the queue can
 *      flush.
 *   2. App crash before the queue's idle-flush timer fires.
 *   3. Network down for longer than the user's session — events
 *      queued while offline disappear when the process tears down.
 *
 * Stripe / Segment / PostHog all persist queued events to a durable
 * store (localStorage on web, AsyncStorage on RN, IndexedDB for
 * very large queues) and replay them on the next boot. We do the
 * same here with AsyncStorage as the default backing store.
 *
 * Failure modes handled gracefully:
 *   - Storage throws (quota exceeded, IO error) → silent degrade
 *     to in-memory only. The SDK keeps working; the durability
 *     guarantee is best-effort.
 *   - Persisted blob unparseable on next boot (manual corruption,
 *     schema drift) → drop silently, fresh empty queue. Don't crash
 *     the consumer app on a bad storage value.
 *
 * The storage key is `${prefix}queue.v1` to leave room for future
 * format migrations.
 *
 * RN-specific divergence from web:
 *
 *   - All reads/writes are async. `load()` is awaited once at
 *     boot from `EventQueue.hydrate()`; subsequent saves are
 *     debounced via microtask + fire-and-forget. The web SDK can
 *     do sync localStorage writes; we cannot.
 */

import type { KeyValueStorage } from "./types";
import type { QueuedEvent } from "./event-queue";

export interface PersistentEventStoreOptions {
  storage: KeyValueStorage;
  prefix: string;
}

/**
 * Wire format for persisted batches. Versioned so a future change to
 * QueuedEvent shape can be detected + ignored cleanly.
 */
interface PersistedQueue {
  version: 1;
  events: QueuedEvent[];
}

export class PersistentEventStore {
  private readonly key: string;
  private writeScheduled = false;
  // Pending snapshot captured on the most recent save() call. A
  // debounced microtask picks up the latest ref when it fires, so
  // bursts of enqueue() calls coalesce into one persistence write.
  private pendingSnapshot: QueuedEvent[] | null = null;

  constructor(private readonly options: PersistentEventStoreOptions) {
    this.key = `${options.prefix}queue.v1`;
  }

  /**
   * Read the persisted queue on boot. Returns an empty array (with
   * no warning) when nothing is stored, the blob is malformed, or
   * storage is unavailable. Caller is responsible for treating
   * duplicates from the persisted queue as the SAME events
   * (eventId-based dedup on the backend).
   */
  async load(): Promise<QueuedEvent[]> {
    let raw: string | null;
    try {
      raw = await this.options.storage.getItem(this.key);
    } catch {
      return [];
    }
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw) as PersistedQueue;
      if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.events)) {
        return [];
      }
      return parsed.events;
    } catch {
      // Corrupt blob — drop silently. Next save() overwrites.
      return [];
    }
  }

  /**
   * Schedule a write of the current buffer. Debounced via microtask
   * so a burst of enqueue() calls coalesces into one persistence
   * write. Writes are best-effort: if storage throws (quota / IO),
   * we swallow and rely on the in-memory buffer.
   */
  save(snapshot: readonly QueuedEvent[]): void {
    // Defensive copy so a later mutation of the buffer doesn't
    // change what we're about to persist.
    this.pendingSnapshot = snapshot.slice();
    if (this.writeScheduled) return;
    this.writeScheduled = true;
    queueMicrotask(() => this.flushWrite());
  }

  /** Wipe the persisted blob. Used by reset() (logout). */
  async clear(): Promise<void> {
    this.pendingSnapshot = null;
    this.writeScheduled = false;
    try {
      await this.options.storage.removeItem(this.key);
    } catch {
      // ignore
    }
  }

  private flushWrite(): void {
    this.writeScheduled = false;
    const snapshot = this.pendingSnapshot;
    this.pendingSnapshot = null;
    if (snapshot === null) return;

    if (snapshot.length === 0) {
      void this.options.storage.removeItem(this.key).catch(() => {});
      return;
    }

    const blob: PersistedQueue = { version: 1, events: snapshot };
    let serialised: string;
    try {
      serialised = JSON.stringify(blob);
    } catch {
      return;
    }
    void this.options.storage.setItem(this.key, serialised).catch(() => {
      // Quota exceeded / IO error — silent degrade. The in-memory
      // buffer is still authoritative; we just lose cross-launch
      // durability for this batch.
    });
  }
}
