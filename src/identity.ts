/**
 * Identity persistence for the RN SDK.
 *
 * Two values are tracked, mirroring @cross-deck/web exactly:
 *
 *   anonymousId          — generated on first boot. Persists for the
 *                          install lifetime so pre-login events stay
 *                          attached to the same identity graph entry.
 *   crossdeckCustomerId  — populated after the first identify() or
 *                          getEntitlements() that resolves a customer.
 *                          Persisted so subsequent app launches read
 *                          entitlements directly without an alias call.
 *
 * RN-specific divergence from web:
 *
 *   - Storage is ASYNC. Hydration happens in `loadAll()` which
 *     `Crossdeck.init()` awaits before any track()/identify() can
 *     fire. Subsequent reads are SYNCHRONOUS from the in-memory
 *     cache; writes fan out to the async storage fire-and-forget.
 *     This matches RN's reality (AsyncStorage cannot be made sync)
 *     while preserving the web API shape.
 *
 *   - No cookie redundancy. The web SDK writes anonymousId to BOTH
 *     localStorage AND a 1st-party cookie because either can be
 *     wiped independently (ITP, clear-site-data). RN has only
 *     AsyncStorage; native iOS/Android SDKs can fall back to
 *     Keychain/KeyStore for reinstall-survival, but the JS layer
 *     cannot. Documented honestly — app uninstall means identity
 *     reset.
 */

import type { KeyValueStorage } from "./types";

const KEY_ANON = "anon_id";
const KEY_CDCUST = "cdcust_id";
const KEY_DEV_UID = "developer_user_id";

interface IdentityState {
  anonymousId: string;
  crossdeckCustomerId: string | null;
  developerUserId: string | null;
}

export class IdentityStore {
  private state: IdentityState | null = null;
  private loaded = false;

  constructor(
    private readonly storage: KeyValueStorage,
    private readonly prefix: string,
  ) {}

  /**
   * Hydrate from durable storage. `Crossdeck.init()` awaits this
   * before any track()/identify() can fire. If no anonymousId is
   * found we mint one and persist it.
   *
   * Safe to call multiple times — second+ calls are no-ops.
   */
  async loadAll(): Promise<void> {
    if (this.loaded) return;
    const [anon, cdcust, dev] = await Promise.all([
      this.storage.getItem(this.prefix + KEY_ANON),
      this.storage.getItem(this.prefix + KEY_CDCUST),
      this.storage.getItem(this.prefix + KEY_DEV_UID),
    ]);
    const anonymousId = anon ?? mintAnonymousId();
    this.state = {
      anonymousId,
      crossdeckCustomerId: cdcust ?? null,
      developerUserId: dev ?? null,
    };
    if (!anon) {
      // First-launch — persist the fresh anonymousId so the next
      // launch reads it back instead of minting a new one (which
      // would break identity-graph continuity).
      this.fireAndForget(
        this.storage.setItem(this.prefix + KEY_ANON, anonymousId),
      );
    }
    this.loaded = true;
  }

  /** Sync read — only valid after loadAll() has resolved. */
  get anonymousId(): string {
    this.ensureLoaded();
    return this.state!.anonymousId;
  }

  /** Sync read — null when no customer has been resolved yet. */
  get crossdeckCustomerId(): string | null {
    this.ensureLoaded();
    return this.state!.crossdeckCustomerId;
  }

  /** Sync read — null when identify() has not been called this install. */
  get developerUserId(): string | null {
    this.ensureLoaded();
    return this.state!.developerUserId;
  }

  /** Persist a newly-resolved Crossdeck customer ID. */
  setCrossdeckCustomerId(value: string): void {
    this.ensureLoaded();
    this.state!.crossdeckCustomerId = value;
    this.fireAndForget(
      this.storage.setItem(this.prefix + KEY_CDCUST, value),
    );
  }

  /** Persist the developer-supplied user ID across launches. */
  setDeveloperUserId(value: string | null): void {
    this.ensureLoaded();
    this.state!.developerUserId = value;
    if (value === null) {
      this.fireAndForget(this.storage.removeItem(this.prefix + KEY_DEV_UID));
    } else {
      this.fireAndForget(this.storage.setItem(this.prefix + KEY_DEV_UID, value));
    }
  }

  /**
   * Wipe persisted identity. Called by reset() — used when an
   * end-user logs out. After reset the SDK mints a new anonymousId
   * so the next pre-login session is a fresh customer in the
   * identity graph.
   */
  reset(): void {
    this.ensureLoaded();
    const fresh = mintAnonymousId();
    this.state = {
      anonymousId: fresh,
      crossdeckCustomerId: null,
      developerUserId: null,
    };
    this.fireAndForget(this.storage.removeItem(this.prefix + KEY_CDCUST));
    this.fireAndForget(this.storage.removeItem(this.prefix + KEY_DEV_UID));
    this.fireAndForget(this.storage.setItem(this.prefix + KEY_ANON, fresh));
  }

  private ensureLoaded(): void {
    if (!this.loaded) {
      throw new Error(
        "IdentityStore: loadAll() must complete before reading identity. " +
          "This is an internal SDK bug — please report.",
      );
    }
  }

  private fireAndForget(promise: Promise<unknown>): void {
    promise.catch(() => {
      // Best-effort persistence — the in-memory cache is authoritative
      // for this session. Silent failure here is documented behaviour
      // for AsyncStorage adapters that can throw under quota / IO
      // pressure.
    });
  }
}

/**
 * Generate an anonymousId. Crockford-ish base36 timestamp + random
 * suffix. Same shape Stripe / Segment / others use — sortable,
 * log-friendly, no PII.
 */
export function mintAnonymousId(): string {
  const ts = Date.now().toString(36);
  const rand = randomChars(10);
  return `anon_${ts}${rand}`;
}

/**
 * Generate a cryptographically-random short string. Uses
 * `crypto.getRandomValues` when available (Hermes 0.74+, modern JSC,
 * Node's webcrypto), else falls back to Math.random with a
 * time-tail.
 *
 * The fallback is safe here because anonymousId entropy doesn't
 * need to resist offline brute force; it needs to be
 * unique-with-overwhelming-probability across one device's lifetime.
 */
export function randomChars(count: number): string {
  const alphabet = "0123456789abcdefghijklmnopqrstuvwxyz";
  const out: string[] = [];
  const cryptoApi = (globalThis as {
    crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array };
  }).crypto;
  if (cryptoApi?.getRandomValues) {
    const buf = new Uint8Array(count);
    cryptoApi.getRandomValues(buf);
    for (let i = 0; i < count; i++) {
      out.push(alphabet[buf[i]! % alphabet.length] ?? "0");
    }
  } else {
    for (let i = 0; i < count; i++) {
      out.push(alphabet[Math.floor(Math.random() * alphabet.length)] ?? "0");
    }
  }
  return out.join("");
}
