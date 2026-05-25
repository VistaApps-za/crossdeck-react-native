/**
 * Storage adapters for SDK-persisted state on React Native.
 *
 * Two flavours:
 *   - AsyncStorage (default when @react-native-async-storage/async-storage
 *     resolves at runtime)
 *   - in-memory (fallback, or explicit when the host app already
 *     manages persistence — encrypted vaults, SecureStore, MMKV)
 *
 * RN does NOT ship localStorage. The SDK requires an ASYNC contract
 * here (Promise<string | null>) rather than the web SDK's sync one
 * because AsyncStorage is async and shimming sync-over-async would
 * either block the JS thread or invent stale reads. Every callsite
 * in this SDK awaits storage operations, so the cost is paid
 * honestly.
 *
 * Identity continuity caveats (documented honestly):
 *   1. AsyncStorage is cleared on app uninstall — there's no
 *      equivalent to Safari's "cleared site data but not the cookie"
 *      recovery. Native iOS/Android SDKs can reach Keychain/KeyStore
 *      for reinstall-survival; the JS SDK can't.
 *   2. AsyncStorage is unencrypted on disk. We never persist
 *      sensitive tokens — only the anonymousId, customerId, queued
 *      events, super-properties, and entitlement cache. If the host
 *      app needs encryption, pass a SecureStore-backed adapter.
 *   3. `persistIdentity: false` forces MemoryStorage so app shells
 *      that defer to a consent gate can postpone any disk write
 *      until the user opts in.
 */

import type { KeyValueStorage } from "./types";

/**
 * In-memory storage. Cleared when the JS context tears down (app
 * cold launch, dev-tools reload). Use when you want session-scoped
 * identity with no on-disk trace.
 */
export class MemoryStorage implements KeyValueStorage {
  private store = new Map<string, string>();
  async getItem(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }
  async setItem(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }
  async removeItem(key: string): Promise<void> {
    this.store.delete(key);
  }
}

/**
 * AsyncStorage-backed adapter. Resolves the underlying module lazily
 * via indirect require() so apps that opt out of persistence (or
 * are running in an environment that doesn't ship AsyncStorage —
 * Storybook snapshots, vitest under node) don't pay the import cost
 * or hit a hard module-not-found.
 *
 * Failures degrade silently to null/no-op rather than throwing — a
 * broken storage layer should look identical to "no value present"
 * to the rest of the SDK. The diagnostic surface
 * (`Crossdeck.diagnostics()`) is the right place to surface
 * persistence health.
 */
export class AsyncStorageAdapter implements KeyValueStorage {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private store: any | null;

  constructor() {
    this.store = loadAsyncStorage();
  }

  async getItem(key: string): Promise<string | null> {
    if (!this.store) return null;
    try {
      const v = await this.store.getItem(key);
      return typeof v === "string" ? v : null;
    } catch {
      return null;
    }
  }

  async setItem(key: string, value: string): Promise<void> {
    if (!this.store) return;
    try {
      await this.store.setItem(key, value);
    } catch {
      /* quota / IO error — silent */
    }
  }

  async removeItem(key: string): Promise<void> {
    if (!this.store) return;
    try {
      await this.store.removeItem(key);
    } catch {
      /* silent */
    }
  }

  get available(): boolean {
    return this.store !== null;
  }
}

/**
 * Pick the best-available default storage. AsyncStorage when it
 * loads, MemoryStorage otherwise. Caller can override via
 * `Crossdeck.init({ storage: ... })` for SecureStore / MMKV /
 * encrypted adapters.
 */
export function detectDefaultStorage(): KeyValueStorage {
  const adapter = new AsyncStorageAdapter();
  if (adapter.available) return adapter;
  return new MemoryStorage();
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function loadAsyncStorage(): any | null {
  try {
    // Indirect require() so static analyzers / bundlers don't choke
    // when AsyncStorage isn't installed. RN's Metro resolves this at
    // runtime only if the package is present.
    const req = (
      globalThis as { require?: (id: string) => unknown }
    ).require;
    if (typeof req !== "function") return null;
    const mod = req("@react-native-async-storage/async-storage") as
      | { default?: unknown }
      | undefined;
    if (!mod) return null;
    const candidate = (mod as { default?: unknown }).default ?? mod;
    if (
      candidate &&
      typeof (candidate as { getItem?: unknown }).getItem === "function"
    ) {
      return candidate;
    }
    return null;
  } catch {
    return null;
  }
}
