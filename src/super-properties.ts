/**
 * Super properties + group analytics — Mixpanel pattern.
 *
 * **Super properties** are key/value pairs the developer registers
 * ONCE via `Crossdeck.register({ plan: "pro" })` that get attached
 * to every subsequent event of that SDK instance. They're the
 * single most-used feature in Mixpanel-style analytics: "every event
 * from this user should have `plan` and `appVersion` on it" instead
 * of remembering to pass them on every track() call.
 *
 * **Groups** are organisational identifiers: a customer might
 * belong to an `org` ("acme"), a `team` ("design"), and a `plan`
 * ("enterprise"). Each event carries `$groups.{type}: id` so B2B
 * dashboards can pivot.
 *
 * Both surfaces live in this module because they share two traits:
 *   - They're set once, attached to every event automatically.
 *   - They persist across app launches via the same storage layer
 *     the SDK uses for identity.
 *
 * The store is reset on `Crossdeck.reset()` (logout) — both super
 * properties and groups are cleared because their lifetime is tied
 * to the identified user, not the SDK instance.
 *
 * RN-specific divergence from web:
 *
 *   - Storage is ASYNC. Hydration via `loadAll()` runs once during
 *     `Crossdeck.init()`; subsequent reads are sync from the
 *     in-memory cache, writes fan out to async storage
 *     fire-and-forget. Same pattern as IdentityStore.
 */

import type { KeyValueStorage } from "./types";

const KEY_SUPER = "super_props";
const KEY_GROUPS = "groups";

export class SuperPropertyStore {
  private superProps: Record<string, unknown> = {};
  private groups: Record<string, { id: string; traits?: Record<string, unknown> }> = {};
  private loaded = false;

  constructor(
    private readonly storage: KeyValueStorage,
    private readonly prefix: string,
  ) {}

  /**
   * Hydrate from durable storage. Called by Crossdeck.init() before
   * any track() can fire so super-props are present on the very
   * first event of the session. Safe to call multiple times — second+
   * calls are no-ops.
   */
  async loadAll(): Promise<void> {
    if (this.loaded) return;
    const [supersRaw, groupsRaw] = await Promise.all([
      this.storage.getItem(this.prefix + KEY_SUPER),
      this.storage.getItem(this.prefix + KEY_GROUPS),
    ]);
    this.superProps = parseJson<Record<string, unknown>>(supersRaw) ?? {};
    this.groups = parseJson(groupsRaw) ?? {};
    this.loaded = true;
  }

  // ---------- super properties ----------

  /**
   * Merge new keys into the super-property bag. Returns a snapshot
   * of the resulting bag. Values that are `null` are deleted (the
   * explicit "stop tracking this key" idiom — Mixpanel semantics).
   */
  register(props: Record<string, unknown>): Record<string, unknown> {
    for (const [k, v] of Object.entries(props)) {
      if (v === null) {
        delete this.superProps[k];
      } else if (v !== undefined) {
        this.superProps[k] = v;
      }
    }
    this.writeJson(this.prefix + KEY_SUPER, this.superProps);
    return { ...this.superProps };
  }

  /** Remove a single super-property key. Idempotent. */
  unregister(key: string): void {
    if (key in this.superProps) {
      delete this.superProps[key];
      this.writeJson(this.prefix + KEY_SUPER, this.superProps);
    }
  }

  /** Snapshot of the current super-property bag. */
  getSuperProperties(): Record<string, unknown> {
    return { ...this.superProps };
  }

  // ---------- groups ----------

  /**
   * Set a group membership. Passing `id: null` clears the
   * membership for that group type — the SDK stops attaching it to
   * events.
   */
  setGroup(type: string, id: string | null, traits?: Record<string, unknown>): void {
    if (id === null) {
      delete this.groups[type];
    } else {
      this.groups[type] = traits !== undefined ? { id, traits } : { id };
    }
    this.writeJson(this.prefix + KEY_GROUPS, this.groups);
  }

  /**
   * Snapshot of the current groups map, keyed by group type.
   * Returned shape mirrors what the SDK attaches to every event as
   * `$groups.{type}`.
   */
  getGroups(): Record<string, { id: string; traits?: Record<string, unknown> }> {
    return JSON.parse(JSON.stringify(this.groups));
  }

  /**
   * The flat `{ type: id }` projection used for event-attachment.
   * Stable for fast every-event merge — we don't want to JSON-clone
   * on each track() call.
   */
  getGroupIds(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [type, info] of Object.entries(this.groups)) {
      out[type] = info.id;
    }
    return out;
  }

  /** Wipe both bags. Called by Crossdeck.reset() (logout). */
  clear(): void {
    this.superProps = {};
    this.groups = {};
    void this.storage.removeItem(this.prefix + KEY_SUPER).catch(() => {});
    void this.storage.removeItem(this.prefix + KEY_GROUPS).catch(() => {});
  }

  private writeJson(key: string, value: unknown): void {
    let s: string;
    try {
      s = JSON.stringify(value);
    } catch {
      return;
    }
    void this.storage.setItem(key, s).catch(() => {
      // Best-effort — in-memory cache stays authoritative for this
      // session. Cross-launch persistence is lost on this one write
      // but the next register/setGroup will retry.
    });
  }
}

function parseJson<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}
