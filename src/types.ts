/**
 * Public types for @cross-deck/react-native.
 *
 * Wire format is shared across every Crossdeck SDK (web, node, RN,
 * iOS, Android) — fields and nullability MUST match
 * backend/src/api/v1-types.ts and the corresponding types in
 * sdks/web + sdks/node. Drift here silently changes the dashboard's
 * understanding of what an event means.
 *
 * Where this SDK diverges from web:
 *   - `KeyValueStorage` is ASYNC. AsyncStorage is the RN primitive;
 *     shimming sync-over-async would either block the JS thread or
 *     invent stale reads. Every storage call awaits.
 *   - `AutoTrackOptions` is reserved for v1.1 (sessions + deep
 *     links). v1.0 does not auto-track anything — the developer wires
 *     `Crossdeck.track("screen.viewed", {...})` from their nav lib
 *     hook directly.
 *   - `Platform` defaults to "ios" or "android" via react-native's
 *     `Platform.OS` at boot. Caller can override for RN-Web /
 *     RN-macOS / desktop platforms.
 */

export type Environment = "production" | "sandbox";
export type Platform = "ios" | "android" | "web";

export type AuditRail = "apple" | "stripe" | "google" | "manual";

export interface PublicEntitlement {
  object: "entitlement";
  key: string;
  isActive: boolean;
  validUntil?: number | null;
  source: {
    rail: AuditRail;
    productId: string;
    subscriptionId: string;
  };
  updatedAt: number;
}

export interface EntitlementsListResponse {
  object: "list";
  data: PublicEntitlement[];
  crossdeckCustomerId: string;
  env: Environment;
}

export interface AliasResult {
  object: "alias_result";
  crossdeckCustomerId: string;
  linked: Array<
    | { type: "developer"; id: string }
    | { type: "anonymous"; id: string }
  >;
  mergePending: boolean;
  env: Environment;
}

export interface IngestResponse {
  object: "list";
  received: number;
  env: Environment;
}

export interface PurchaseResult {
  object: "purchase_result";
  crossdeckCustomerId: string;
  env: Environment;
  entitlements: PublicEntitlement[];
}

export interface HeartbeatResponse {
  object: "heartbeat";
  ok: true;
  projectId: string;
  appId: string;
  platform: Platform;
  env: Environment;
  serverTime: number;
}

/**
 * Configuration for `Crossdeck.init`.
 *
 * The required trio (appId, publicKey, environment) goes on the wire
 * envelope (NorthStar §13.1) so the backend can correlate events
 * with the specific app surface and reject mismatched env
 * declarations loudly (`env_mismatch`).
 */
export interface CrossdeckOptions {
  /** Crossdeck App ID issued in the dashboard (e.g. "app_rn_xxx"). Required. */
  appId: string;
  /** Crossdeck publishable key (cd_pub_…). Required. */
  publicKey: string;
  /**
   * Explicit environment declaration. Required. Must match the key
   * prefix:
   *   cd_pub_test_…  → "sandbox"
   *   cd_pub_live_…  → "production"
   *
   * Mismatch is rejected at init so a typo'd key can't silently
   * route production telemetry into sandbox dashboards.
   */
  environment: Environment;
  /**
   * Override the API base URL. Default https://api.cross-deck.com/v1.
   * Useful for self-hosted setups or the local emulator (e.g.
   * `http://localhost:5001/crossdeck-47d8f/us-east4/v1`).
   *
   * Note: when overridden, the SDK's error-capture self-skip pivot
   * is derived from THIS URL's hostname (not the default), so a
   * staging / regional / self-hosted relay never recurses through
   * its own fetch-wrap.
   */
  baseUrl?: string;
  /**
   * Persist anonymousId + crossdeckCustomerId across app launches.
   * Default true — writes to AsyncStorage if available, otherwise
   * MemoryStorage (session-only). Set false during a strict-consent
   * flow to defer any disk write until the user opts in.
   */
  persistIdentity?: boolean;
  /**
   * Storage adapter. Defaults to AsyncStorage when available, else
   * in-memory. Pass a custom adapter (SecureStore / MMKV / encrypted
   * vault) for higher-security app shells.
   */
  storage?: KeyValueStorage;
  /** Storage key prefix for SDK-persisted state. Default "crossdeck:". */
  storagePrefix?: string;
  /**
   * Send a heartbeat to /v1/sdk/heartbeat on init(). Default true.
   * Disable for high-frequency boot scenarios (CI scripts, tests).
   */
  autoHeartbeat?: boolean;
  /** Max events buffered before forced flush. Default 20. */
  eventFlushBatchSize?: number;
  /** Idle ms after the last track() before flushing. Default 5000. */
  eventFlushIntervalMs?: number;
  /** Override the SDK version reported on heartbeats. Default: package version. */
  sdkVersion?: string;
  /**
   * Your app's version (e.g. "1.2.3"). Auto-attached to every event
   * as `properties.appVersion` so dashboards can slice by build.
   */
  appVersion?: string;
  /**
   * Force-override the runtime platform reported on the wire
   * envelope. Default: react-native's `Platform.OS`, normalised to
   * `"ios"` / `"android"`. Anything else maps to `"web"` so backend
   * validators don't reject.
   */
  platform?: Platform;
  /**
   * Per-request timeout in ms. Default 15000. A captive portal or
   * hung connection would otherwise inherit the runtime's default
   * (5+ minutes) and stall the queue.
   */
  timeoutMs?: number;
  /**
   * Enable verbose diagnostic logging via the NorthStar §16
   * debug-signal vocabulary. Default false. Equivalent to calling
   * `Crossdeck.setDebugMode(true)` after init.
   */
  debug?: boolean;
  /**
   * Scrub PII-shaped strings (email addresses, card numbers) from
   * event property values before they leave the SDK. Default true.
   * Disable only if your pipeline does its own PII redaction
   * downstream and you need raw strings on the wire.
   */
  scrubPii?: boolean;
  /**
   * Auto-capture uncaught errors + unhandled promise rejections +
   * 5xx fetch failures. Default true. Set false if you have a
   * separate error tracker (Sentry, Bugsnag) and don't want
   * duplicates.
   */
  errorCapture?: boolean;
}

/**
 * Pluggable persistence. Async to allow AsyncStorage / SecureStore /
 * MMKV / encrypted vaults. The SDK awaits every storage operation.
 */
export interface KeyValueStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

/**
 * Identity hint + profile traits passed to identify().
 *
 * `traits` is a free-form bag of profile data (name, plan, signupDate,
 * teamRole, etc.) that gets persisted on the Crossdeck customer
 * record and attached to every subsequent event of the identified
 * user as `$user.<key>` properties for dashboard filtering.
 *
 * Like event properties, traits are validated at the SDK boundary —
 * functions/symbols/undefined dropped, Date / BigInt / Error
 * coerced, strings > 1024 chars truncated.
 */
export interface IdentifyOptions {
  email?: string;
  traits?: Record<string, unknown>;
}

/**
 * Group context — Mixpanel-style. Identifies a customer's membership
 * in an organisational entity (org, account, team, workspace) so
 * B2B dashboards can answer "how is account X using my product".
 *
 * Attached to every event as `$groups.<type>` until cleared via
 * `Crossdeck.group(type, null)`. Multiple types can coexist (e.g.
 * `org` + `team`) — the SDK keeps a map keyed by type.
 */
export interface GroupTraits {
  [key: string]: unknown;
}

/** Properties payload for track(). Arbitrary key/value, JSON-serialisable, ≤ 8 KB. */
export type EventProperties = Record<string, unknown>;

/**
 * Diagnostic snapshot returned by `Crossdeck.diagnostics()`. Stable
 * shape whether or not `init()` has been called — callers don't need
 * to narrow on `started` to read `events` or `entitlements`.
 * Pre-init values are sensible empties.
 */
export interface Diagnostics {
  started: boolean;
  anonymousId: string | null;
  crossdeckCustomerId: string | null;
  developerUserId: string | null;
  sdkVersion: string | null;
  baseUrl: string | null;
  platform: Platform | null;
  clock: {
    lastServerTime: number | null;
    lastClientTime: number | null;
    skewMs: number | null;
  };
  entitlements: {
    count: number;
    lastUpdated: number;
    stale: boolean;
    listenerErrors: number;
  };
  events: {
    buffered: number;
    dropped: number;
    inFlight: number;
    lastFlushAt: number;
    lastError: string | null;
    consecutiveFailures: number;
    nextRetryAt: number | null;
  };
}
