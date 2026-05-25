/**
 * Public API surface for @cross-deck/react-native.
 *
 * Usage:
 *
 *   import { Crossdeck } from "@cross-deck/react-native";
 *
 *   Crossdeck.init({
 *     appId: "app_rn_xxx",
 *     publicKey: "cd_pub_live_…",
 *     environment: "production",
 *   });
 *
 *   await Crossdeck.identify("user_847");
 *   const ents = await Crossdeck.getEntitlements();
 *   if (Crossdeck.isEntitled("pro")) {
 *     showPro();
 *   }
 *   Crossdeck.track("paywall_shown", { variant: "v3" });
 *
 * Lifecycle:
 *
 *   - `init()` returns void but kicks off async hydration (identity,
 *     super-props, entitlement cache, persisted event queue) in the
 *     background. The returned `ready` promise is awaited internally
 *     by every async method (`identify`, `track`, `flush`,
 *     `getEntitlements`, etc.) so callers don't need to babysit it.
 *   - Sync methods (`isEntitled`, `getSuperProperties`,
 *     `diagnostics`) read in-memory state. Until `init()` has fired
 *     they return sensible empties (false, {}, the "not-started"
 *     diagnostics shape).
 *   - `reset()` is fully sync; identity/storage wipe fans out
 *     fire-and-forget to AsyncStorage.
 */

import { CrossdeckError } from "./errors";
import {
  HttpClient,
  DEFAULT_BASE_URL,
  SDK_NAME,
  SDK_VERSION,
  extractSelfHostname,
} from "./http";
import { IdentityStore, randomChars } from "./identity";
import { EntitlementCache, type EntitlementsListener } from "./entitlement-cache";
import { EventQueue, type QueuedEvent } from "./event-queue";
import { PersistentEventStore } from "./event-storage";
import { detectDefaultStorage, MemoryStorage } from "./storage";
import { collectDeviceInfo, type DeviceInfo } from "./device-info";
import { ConsoleDebugLogger, findSensitivePropertyKeys, type DebugLogger } from "./debug";
import { validateEventProperties } from "./event-validation";
import { SuperPropertyStore } from "./super-properties";
import { ConsentManager, scrubPiiFromProperties, type ConsentState } from "./consent";
import { BreadcrumbBuffer, type Breadcrumb } from "./breadcrumbs";
import {
  DEFAULT_ERROR_CAPTURE,
  ErrorTracker,
  type CapturedError,
  type ErrorCaptureConfig,
  type ErrorLevel,
} from "./error-capture";
import type {
  AliasResult,
  CrossdeckOptions,
  Diagnostics,
  EntitlementsListResponse,
  Environment,
  EventProperties,
  GroupTraits,
  HeartbeatResponse,
  IdentifyOptions,
  PublicEntitlement,
  PurchaseResult,
  Platform,
} from "./types";

interface InternalState {
  http: HttpClient;
  identity: IdentityStore;
  entitlements: EntitlementCache;
  events: EventQueue;
  errors: ErrorTracker | null;
  breadcrumbs: BreadcrumbBuffer;
  errorContext: Record<string, unknown>;
  errorTags: Record<string, string>;
  errorBeforeSend: ((err: CapturedError) => CapturedError | null) | null;
  superProps: SuperPropertyStore;
  consent: ConsentManager;
  scrubPii: boolean;
  deviceInfo: DeviceInfo;
  options: Required<
    Omit<
      CrossdeckOptions,
      "storage" | "sdkVersion" | "appVersion" | "debug" | "scrubPii" | "errorCapture"
    >
  > & {
    sdkVersion: string;
    appVersion: string | null;
  };
  debug: DebugLogger;
  developerUserId: string | null;
  lastServerTime: number | null;
  lastClientTime: number | null;
  /** Promise that resolves when async hydration completes. */
  ready: Promise<void>;
  /** True once init() has fully returned (synchronous portion done). */
  started: boolean;
  /** True once the async hydration in `ready` has completed. */
  hydrated: boolean;
}

export class CrossdeckClient {
  private state: InternalState | null = null;

  /**
   * Boot the SDK. Returns void synchronously but kicks off async
   * hydration in the background. Callers can `await
   * Crossdeck.identify(...)` etc. directly — the SDK awaits its own
   * `ready` promise internally.
   *
   * Idempotent — calling init twice with the same options is a
   * no-op; calling with different options tears down the prior
   * tracker and replaces the configuration.
   */
  init(options: CrossdeckOptions): void {
    if (this.state) {
      // Re-init — tear down listeners (error tracker fetch wrap)
      // before reconstructing. Otherwise duplicate global handlers
      // pile up.
      try {
        this.state.errors?.uninstall();
      } catch {
        /* ignore */
      }
    }

    if (!options.publicKey || !options.publicKey.startsWith("cd_pub_")) {
      throw new CrossdeckError({
        type: "configuration_error",
        code: "invalid_public_key",
        message: "Crossdeck.init requires a publishable key starting with cd_pub_.",
      });
    }
    if (!options.appId) {
      throw new CrossdeckError({
        type: "configuration_error",
        code: "missing_app_id",
        message:
          "Crossdeck.init requires an appId. Find yours in the Crossdeck dashboard.",
      });
    }
    if (options.environment !== "production" && options.environment !== "sandbox") {
      throw new CrossdeckError({
        type: "configuration_error",
        code: "invalid_environment",
        message: 'Crossdeck.init requires environment: "production" | "sandbox".',
      });
    }
    const keyEnv = inferEnvFromKey(options.publicKey);
    if (keyEnv && keyEnv !== options.environment) {
      throw new CrossdeckError({
        type: "configuration_error",
        code: "environment_mismatch",
        message: `Crossdeck.init: environment "${options.environment}" disagrees with key prefix (${keyEnv}). Reconcile your Crossdeck.init({ environment }) with the publishable key prefix.`,
      });
    }

    const storage = options.storage ?? detectDefaultStorage();
    const persistIdentity = options.persistIdentity ?? true;
    const opts: InternalState["options"] = {
      appId: options.appId,
      publicKey: options.publicKey,
      environment: options.environment,
      baseUrl: options.baseUrl ?? DEFAULT_BASE_URL,
      persistIdentity,
      storagePrefix: options.storagePrefix ?? "crossdeck:",
      autoHeartbeat: options.autoHeartbeat ?? true,
      eventFlushBatchSize: options.eventFlushBatchSize ?? 20,
      eventFlushIntervalMs: options.eventFlushIntervalMs ?? 5000,
      sdkVersion: options.sdkVersion ?? SDK_VERSION,
      appVersion: options.appVersion ?? null,
      platform: options.platform ?? detectPlatform(),
      timeoutMs: options.timeoutMs ?? 15_000,
    };

    const debug = new ConsoleDebugLogger();
    debug.enabled = options.debug === true;

    const http = new HttpClient({
      publicKey: opts.publicKey,
      baseUrl: opts.baseUrl,
      sdkVersion: opts.sdkVersion,
      timeoutMs: opts.timeoutMs,
    });

    // Identity continuity. When persistIdentity is off (typical
    // during a strict-consent flow before opt-in) we fall back to
    // in-memory only and write nothing to AsyncStorage.
    const effectiveStorage = persistIdentity ? storage : new MemoryStorage();
    const identity = new IdentityStore(effectiveStorage, opts.storagePrefix);
    const entitlements = new EntitlementCache(
      effectiveStorage,
      opts.storagePrefix + "entitlements",
    );
    const persistentEvents = persistIdentity
      ? new PersistentEventStore({ storage: effectiveStorage, prefix: opts.storagePrefix })
      : null;

    const events = new EventQueue({
      http,
      batchSize: opts.eventFlushBatchSize,
      intervalMs: opts.eventFlushIntervalMs,
      envelope: () => ({
        appId: opts.appId,
        environment: opts.environment,
        sdk: { name: SDK_NAME, version: opts.sdkVersion },
      }),
      persistentStore: persistentEvents ?? undefined,
      onFirstFlushSuccess: () => {
        debug.emit(
          "sdk.first_event_sent",
          "First telemetry event received. View it in Live Events.",
          { appId: opts.appId, environment: opts.environment },
        );
      },
      onRetryScheduled: (info) => {
        debug.emit(
          "sdk.flush_retry_scheduled",
          `Event flush failed (${info.lastError}). Retrying in ${info.delayMs}ms (attempt ${info.consecutiveFailures}).`,
          { ...info },
        );
      },
      onPermanentFailure: (info) => {
        // Bank-grade rule: a permanent 4xx that's dropping events
        // MUST be loud regardless of debug mode. Pre-fix the queue
        // retried 4xx forever silently and the customer never knew
        // their key was revoked.
        const headline = `[crossdeck] Event batch DROPPED (status ${info.status}): ${info.lastError}. ${info.droppedCount} event(s) lost — check your publishable key + app config.`;
        // eslint-disable-next-line no-console
        console.error(headline);
        debug.emit("sdk.flush_permanent_failure", headline, { ...info });
      },
    });

    const deviceInfo: DeviceInfo = collectDeviceInfo({
      appVersion: opts.appVersion ?? undefined,
    });

    const superProps = new SuperPropertyStore(
      persistIdentity ? effectiveStorage : new MemoryStorage(),
      opts.storagePrefix,
    );

    const consent = new ConsentManager();
    const breadcrumbs = new BreadcrumbBuffer(50);

    this.state = {
      http,
      identity,
      entitlements,
      events,
      errors: null,
      breadcrumbs,
      errorContext: {},
      errorTags: {},
      errorBeforeSend: null,
      superProps,
      consent,
      scrubPii: options.scrubPii !== false,
      deviceInfo,
      options: opts,
      debug,
      developerUserId: null,
      lastServerTime: null,
      lastClientTime: null,
      started: false,
      hydrated: false,
      ready: Promise.resolve(),
    };

    // Error capture — install BEFORE async hydration so an error
    // during boot still surfaces. consented gate keeps reports
    // gated on `consent.errors`.
    const wantErrorCapture = options.errorCapture !== false;
    if (wantErrorCapture) {
      const tracker = new ErrorTracker({
        config: { ...DEFAULT_ERROR_CAPTURE, enabled: true },
        breadcrumbs,
        report: (err) => this.reportError(err),
        getContext: () => ({ ...this.state!.errorContext }),
        getTags: () => ({ ...this.state!.errorTags }),
        beforeSend: () => this.state!.errorBeforeSend,
        isConsented: () => this.state!.consent.errors,
        selfHostname: extractSelfHostname(opts.baseUrl),
      });
      this.state.errors = tracker;
      tracker.install();
    }

    debug.emit(
      "sdk.configured",
      `Crossdeck connected to ${opts.appId} in ${opts.environment} mode.`,
      {
        appId: opts.appId,
        environment: opts.environment,
        sdkVersion: opts.sdkVersion,
      },
    );

    // Kick off async hydration. Every public async method awaits
    // `state.ready` before reading identity / cache / queue state
    // so the caller can `await Crossdeck.identify(...)` immediately
    // after `Crossdeck.init(...)` without manual sequencing.
    this.state.ready = (async () => {
      await Promise.all([
        identity.loadAll(),
        superProps.loadAll(),
        entitlements.hydrate(),
        events.hydrate(),
      ]);
      this.state!.hydrated = true;
    })();
    this.state.started = true;

    if (opts.autoHeartbeat) {
      // Fire-and-forget — heartbeat failure shouldn't block init().
      void this.state.ready.then(() => this.heartbeat()).catch(() => undefined);
    }
  }

  /**
   * Link the anonymous device to a developer-supplied user ID.
   * Caches the resolved Crossdeck customer for follow-up calls.
   *
   * Accepts an optional `traits` bag — profile data (name, plan,
   * signupDate, role) persisted on the Crossdeck customer record.
   */
  async identify(userId: string, options?: IdentifyOptions): Promise<AliasResult> {
    const s = this.requireStarted();
    if (!userId) {
      throw new CrossdeckError({
        type: "invalid_request_error",
        code: "missing_user_id",
        message: "identify(userId) requires a non-empty userId.",
      });
    }
    await s.ready;

    if (!s.consent.analytics) {
      s.debug.emit(
        "sdk.consent_denied",
        "identify() skipped — consent denied for analytics.",
      );
      return {
        object: "alias_result",
        crossdeckCustomerId: s.identity.crossdeckCustomerId ?? "",
        linked: [],
        mergePending: false,
        env: s.options.environment,
      };
    }

    const traitsValidation =
      options?.traits !== undefined
        ? validateEventProperties(options.traits)
        : null;
    const traits =
      traitsValidation && Object.keys(traitsValidation.properties).length > 0
        ? traitsValidation.properties
        : undefined;

    const body: Record<string, unknown> = {
      userId,
      anonymousId: s.identity.anonymousId,
    };
    if (options?.email) body.email = options.email;
    if (traits) body.traits = traits;
    const result = await s.http.request<AliasResult>("POST", "/identity/alias", {
      body,
    });

    // A different user identifying on this device — the prior
    // user's durable entitlement cache must not leak to them.
    // Bank-grade unconditional clear when the resolved cdcust
    // differs from the in-memory snapshot OR when the cache is
    // non-empty under an unknown identity (Batch C audit fix
    // ported from web).
    const priorCdcust = s.identity.crossdeckCustomerId;
    const cacheHasEntries = s.entitlements.list().length > 0;
    if (
      (priorCdcust &&
        result.crossdeckCustomerId &&
        priorCdcust !== result.crossdeckCustomerId) ||
      (!priorCdcust && cacheHasEntries)
    ) {
      s.entitlements.clear();
    }
    s.identity.setCrossdeckCustomerId(result.crossdeckCustomerId);
    s.identity.setDeveloperUserId(userId);
    s.developerUserId = userId;
    return result;
  }

  /**
   * Register super-properties — Mixpanel pattern. Once set, every
   * subsequent event of THIS SDK instance carries these keys on its
   * properties bag automatically.
   */
  register(properties: Record<string, unknown>): Record<string, unknown> {
    const s = this.requireStarted();
    const validation = validateEventProperties(properties);
    return s.superProps.register(validation.properties);
  }

  /** Remove a single super-property key. Idempotent. */
  unregister(key: string): void {
    const s = this.requireStarted();
    s.superProps.unregister(key);
  }

  /** Snapshot of the current super-property bag. */
  getSuperProperties(): Record<string, unknown> {
    if (!this.state) return {};
    return this.state.superProps.getSuperProperties();
  }

  /**
   * Associate the current user with a group (org, team, account).
   * Mixpanel / Segment "Group Analytics" pattern.
   */
  group(type: string, id: string | null, traits?: GroupTraits): void {
    const s = this.requireStarted();
    if (!type) {
      throw new CrossdeckError({
        type: "invalid_request_error",
        code: "missing_group_type",
        message: "group(type, id) requires a non-empty type.",
      });
    }
    const sanitisedTraits = traits
      ? validateEventProperties(traits).properties
      : undefined;
    s.superProps.setGroup(type, id, sanitisedTraits);
  }

  /** Snapshot of the current groups map keyed by type. */
  getGroups(): Record<string, { id: string; traits?: Record<string, unknown> }> {
    if (!this.state) return {};
    return this.state.superProps.getGroups();
  }

  /** Update consent state. See `ConsentState` for the dimensions. */
  consent(state: Partial<ConsentState>): ConsentState {
    const s = this.requireStarted();
    const next = s.consent.set(state);
    s.debug.emit("sdk.consent_changed", "Consent state updated.", { ...next });
    return next;
  }

  /** Snapshot of the current consent state. */
  consentStatus(): ConsentState {
    if (!this.state) {
      return { analytics: true, marketing: true, errors: true };
    }
    return this.state.consent.get();
  }

  // ============================================================
  // Error capture surface
  // ============================================================

  /** Manually capture an error from a try/catch block. */
  captureError(
    error: unknown,
    options?: {
      context?: Record<string, unknown>;
      tags?: Record<string, string>;
      level?: ErrorLevel;
    },
  ): void {
    if (!this.state?.errors) return;
    this.state.errors.captureError(error, options);
  }

  /** Capture a non-error event you want to surface as an issue. */
  captureMessage(message: string, level: ErrorLevel = "info"): void {
    if (!this.state?.errors) return;
    this.state.errors.captureMessage(message, level);
  }

  setTag(key: string, value: string): void {
    if (!this.state) return;
    this.state.errorTags[key] = value;
  }

  setTags(tags: Record<string, string>): void {
    if (!this.state) return;
    Object.assign(this.state.errorTags, tags);
  }

  setContext(name: string, data: Record<string, unknown>): void {
    if (!this.state) return;
    this.state.errorContext[name] = data;
  }

  addBreadcrumb(crumb: Breadcrumb): void {
    if (!this.state) return;
    this.state.breadcrumbs.add(crumb);
  }

  /**
   * Install a pre-send hook for errors. Return null to drop, or a
   * modified `CapturedError` to scrub / rewrite. Sentry's
   * beforeSend pattern — the only way to redact app-specific PII
   * (auth tokens in URLs, etc.) before the report leaves the
   * device.
   */
  setErrorBeforeSend(
    hook: ((err: CapturedError) => CapturedError | null) | null,
  ): void {
    if (!this.state) return;
    this.state.errorBeforeSend = hook;
  }

  private reportError(err: CapturedError): void {
    const properties: EventProperties = {
      fingerprint: err.fingerprint,
      level: err.level,
      errorType: err.errorType,
      message: err.message,
      stack: err.rawStack ?? undefined,
      frames: err.frames,
      filename: err.filename ?? undefined,
      lineno: err.lineno ?? undefined,
      colno: err.colno ?? undefined,
      tags: err.tags,
      context: err.context,
      breadcrumbs: err.breadcrumbs,
      http: err.http,
    };
    for (const k of Object.keys(properties)) {
      if (properties[k] === undefined) delete properties[k];
    }
    this.track(err.kind, properties);
  }

  /**
   * GDPR/CCPA right to be forgotten. Calls
   * `/v1/identity/forget` to schedule server-side deletion, then
   * wipes all local state (identity, entitlements, queue,
   * super-props, breadcrumbs).
   */
  async forget(): Promise<void> {
    const s = this.requireStarted();
    await s.ready;
    const identityQuery = this.identityQueryParams();
    try {
      await s.http.request<{ object: "forgot" }>("POST", "/identity/forget", {
        body: { ...identityQuery },
      });
    } catch (err) {
      s.debug.emit(
        "sdk.consent_denied",
        `forget() server call failed (${err instanceof Error ? err.message : String(err)}). Local state wiped anyway.`,
      );
    }
    this.reset();
  }

  /**
   * Read the current customer's active entitlements from the
   * server. Updates the local cache so subsequent `isEntitled()`
   * calls answer synchronously.
   */
  async getEntitlements(): Promise<PublicEntitlement[]> {
    const s = this.requireStarted();
    await s.ready;
    const query = this.identityQueryParams();
    let result: EntitlementsListResponse;
    try {
      result = await s.http.request<EntitlementsListResponse>(
        "GET",
        "/entitlements",
        { query },
      );
    } catch (err) {
      s.entitlements.markRefreshFailed();
      throw err;
    }
    if (result.crossdeckCustomerId) {
      s.identity.setCrossdeckCustomerId(result.crossdeckCustomerId);
    }
    s.entitlements.setFromList(result.data);
    return result.data;
  }

  /**
   * Synchronous read from the durable local cache — answers from
   * last-known-good. The cache hydrates from device storage during
   * init() so a returning paying customer reads true even before
   * the session's first network round-trip. Returns false for a
   * genuinely new install that has never completed a
   * `getEntitlements()`, or for an entitlement past its own
   * `validUntil`.
   */
  isEntitled(key: string): boolean {
    if (!this.state) return false;
    return this.state.entitlements.isEntitled(key);
  }

  /** Snapshot of the local entitlement cache. */
  listEntitlements(): PublicEntitlement[] {
    if (!this.state) return [];
    return this.state.entitlements.list();
  }

  /**
   * Subscribe to entitlement-cache changes. Returns an idempotent
   * unsubscribe fn. The listener fires AFTER `getEntitlements()`
   * warms the cache, after `syncPurchases()` delivers fresh
   * entitlements, and on `reset()` to fire the empty-cache state
   * for logout flows.
   *
   * Listener errors are swallowed (a buggy consumer must not crash
   * the SDK or other listeners).
   */
  onEntitlementsChange(listener: EntitlementsListener): () => void {
    const s = this.requireStarted();
    return s.entitlements.subscribe(listener);
  }

  /**
   * Queue a telemetry event. Returns immediately — the network
   * round-trip happens in the background. Call `flush()` to force
   * an immediate send (e.g. when the app is backgrounding).
   *
   * RN-specific contract: identity hydration is async (AsyncStorage),
   * so a `track()` call fired in the same tick as `init()` reaches
   * the identity store before `loadAll()` has resolved. We defer the
   * post-validation portion via `s.ready.then(...)` in that case so
   * the event lands AFTER hydration with the right identity hint
   * stamped. Common-case `track()` after hydration runs entirely
   * synchronously.
   */
  track(name: string, properties?: EventProperties): void {
    const s = this.requireStarted();
    if (!name) {
      throw new CrossdeckError({
        type: "invalid_request_error",
        code: "missing_event_name",
        message: "track(name) requires a non-empty name.",
      });
    }
    if (!s.hydrated) {
      void s.ready.then(() => this.trackPostHydration(s, name, properties));
      return;
    }
    this.trackPostHydration(s, name, properties);
  }

  /**
   * The body of `track()` — everything after the synchronous
   * validation. Split out so the public `track()` can defer this
   * portion until async identity hydration completes (RN-specific —
   * see `track()` jsdoc).
   */
  private trackPostHydration(
    s: InternalState,
    name: string,
    properties?: EventProperties,
  ): void {
    // Consent gate. error.* events gate on consent.errors; everything
    // else gates on consent.analytics.
    const isError = name.startsWith("error.");
    const consentGateOk = isError ? s.consent.errors : s.consent.analytics;
    if (!consentGateOk) {
      if (s.debug.enabled) {
        s.debug.emit(
          "sdk.consent_denied",
          `Dropped event "${name}" — consent denied.`,
        );
      }
      return;
    }

    // PII property-name warning (debug mode only).
    if (s.debug.enabled && properties) {
      const flagged = findSensitivePropertyKeys(properties);
      if (flagged.length > 0) {
        s.debug.emit(
          "sdk.sensitive_property_warning",
          `Event "${name}" has potentially sensitive property names: ${flagged.join(", ")}. Crossdeck is privacy-first — avoid sending PII unless intentional.`,
          { eventName: name, flagged },
        );
      }
    }

    // §16 "No identity" — only emit once per session.
    if (
      s.debug.enabled &&
      !s.developerUserId &&
      !s.identity.crossdeckCustomerId
    ) {
      s.debug.emit(
        "sdk.no_identity",
        "Using anonymous user until identify(userId) is called.",
      );
    }

    // Validate + coerce caller-supplied properties.
    const validation = validateEventProperties(properties);
    if (s.debug.enabled && validation.warnings.length > 0) {
      for (const w of validation.warnings) {
        s.debug.emit(
          "sdk.property_coerced",
          `Event "${name}" property ${JSON.stringify(w.key)} was ${w.kind.replace(/_/g, " ")} during validation.`,
          { eventName: name, key: w.key, kind: w.kind },
        );
      }
    }

    // Enrichment layer order (later wins on key conflict):
    //   1. Device info
    //   2. Super properties
    //   3. Group memberships
    //   4. Caller-supplied properties (sanitised)
    const enriched: EventProperties = { ...s.deviceInfo };
    const supers = s.superProps.getSuperProperties();
    for (const k of Object.keys(supers)) {
      if (!(k in enriched)) enriched[k] = supers[k];
    }
    const groupIds = s.superProps.getGroupIds();
    if (Object.keys(groupIds).length > 0) {
      enriched.$groups = groupIds;
    }
    Object.assign(enriched, validation.properties);

    // PII scrub — defensive regex pass before the event lands in
    // the queue.
    const finalProperties = s.scrubPii
      ? scrubPiiFromProperties(enriched)
      : enriched;

    const event: QueuedEvent = {
      eventId: this.mintEventId(),
      name,
      timestamp: Date.now(),
      properties: finalProperties,
    };
    Object.assign(event, this.identityHintForEvent());
    s.events.enqueue(event);

    // Breadcrumb emission — every analytics event becomes a
    // breadcrumb so error reports carry the context of what the
    // user was doing just before the crash. Don't emit a breadcrumb
    // for error events themselves (circular).
    if (!isError) {
      const category = name.startsWith("page.") || name.startsWith("screen.")
        ? "navigation"
        : name.startsWith("element.") || name === "session.started"
          ? "ui.click"
          : "custom";
      s.breadcrumbs.add({
        timestamp: event.timestamp,
        category,
        message: name,
        data: properties ? { ...properties } : undefined,
      });
    }
  }

  /** Force-flush queued events. Useful from AppState background transitions. */
  async flush(): Promise<void> {
    const s = this.requireStarted();
    await s.ready;
    await s.events.flush();
  }

  /**
   * Forward purchase evidence to the backend for verification +
   * entitlement projection. RN apps typically wire this from
   * `react-native-iap` callbacks for Apple StoreKit 2 + Google
   * Billing receipts.
   */
  async syncPurchases(input: {
    rail?: "apple" | "google";
    signedTransactionInfo?: string;
    signedRenewalInfo?: string;
    purchaseToken?: string;
    appAccountToken?: string;
  }): Promise<PurchaseResult> {
    const s = this.requireStarted();
    await s.ready;
    const rail = input.rail ?? "apple";
    if (rail === "apple" && !input.signedTransactionInfo) {
      throw new CrossdeckError({
        type: "invalid_request_error",
        code: "missing_signed_transaction_info",
        message:
          "syncPurchases (apple) requires a signedTransactionInfo string from StoreKit 2.",
      });
    }
    if (rail === "google" && !input.purchaseToken) {
      throw new CrossdeckError({
        type: "invalid_request_error",
        code: "missing_purchase_token",
        message:
          "syncPurchases (google) requires a purchaseToken string from Google Billing.",
      });
    }
    const result = await s.http.request<PurchaseResult>("POST", "/purchases/sync", {
      // Spread input FIRST so the explicit `rail` default below wins
      // — `{ ...input, rail }` puts the default last so an explicit
      // `rail: undefined` from the caller doesn't override.
      body: { ...input, rail },
    });
    s.identity.setCrossdeckCustomerId(result.crossdeckCustomerId);
    s.entitlements.setFromList(result.entitlements);
    s.debug.emit(
      "sdk.purchase_evidence_sent",
      `${rail === "apple" ? "StoreKit" : "Google Billing"} purchase evidence forwarded. Waiting for backend verification.`,
      { rail },
    );
    return result;
  }

  /** Toggle verbose diagnostic logging. */
  setDebugMode(enabled: boolean): void {
    const s = this.requireStarted();
    s.debug.enabled = enabled;
    if (enabled) {
      s.debug.emit(
        "sdk.configured",
        `Debug mode enabled for ${s.options.appId} in ${s.options.environment} mode.`,
        { appId: s.options.appId, environment: s.options.environment },
      );
    }
  }

  /**
   * Send the boot heartbeat. Called automatically by init() unless
   * `autoHeartbeat: false`. Captures clock skew between client and
   * server for diagnostics.
   */
  async heartbeat(): Promise<HeartbeatResponse> {
    const s = this.requireStarted();
    await s.ready;
    const result = await s.http.request<HeartbeatResponse>("GET", "/sdk/heartbeat");
    if (typeof result?.serverTime === "number" && Number.isFinite(result.serverTime)) {
      s.lastServerTime = result.serverTime;
      s.lastClientTime = Date.now();
    }
    return result;
  }

  /**
   * Wipe persisted identity + entitlement cache + super-props +
   * breadcrumbs + queue. Use on logout. The next pre-login session
   * generates a fresh anonymousId and starts a new identity-graph
   * entry.
   */
  reset(): void {
    if (!this.state) return;
    if (this.state.developerUserId) {
      try {
        this.track("user.signed_out", { auto: true });
      } catch {
        /* defensive — reset() must be bulletproof for logout flows */
      }
    }
    this.state.identity.reset();
    this.state.entitlements.clear();
    this.state.events.reset();
    this.state.superProps.clear();
    this.state.breadcrumbs.clear();
    this.state.errorContext = {};
    this.state.errorTags = {};
    this.state.developerUserId = null;
    // Null clock-skew snapshot on reset — these values belong to
    // the pre-logout session.
    this.state.lastServerTime = null;
    this.state.lastClientTime = null;
  }

  /**
   * Diagnostic snapshot. Stable shape regardless of whether
   * init() has been called — callers don't need to narrow on
   * `started` to access `events` or `entitlements`.
   */
  diagnostics(): Diagnostics {
    if (!this.state) {
      return {
        started: false,
        anonymousId: null,
        crossdeckCustomerId: null,
        developerUserId: null,
        sdkVersion: null,
        baseUrl: null,
        platform: null,
        clock: { lastServerTime: null, lastClientTime: null, skewMs: null },
        entitlements: { count: 0, lastUpdated: 0, stale: false, listenerErrors: 0 },
        events: {
          buffered: 0,
          dropped: 0,
          inFlight: 0,
          lastFlushAt: 0,
          lastError: null,
          consecutiveFailures: 0,
          nextRetryAt: null,
        },
      };
    }
    const s = this.state;
    const skewMs =
      s.lastServerTime !== null && s.lastClientTime !== null
        ? s.lastClientTime - s.lastServerTime
        : null;
    return {
      started: true,
      anonymousId: s.hydrated ? s.identity.anonymousId : null,
      crossdeckCustomerId: s.hydrated ? s.identity.crossdeckCustomerId : null,
      developerUserId: s.developerUserId,
      sdkVersion: s.options.sdkVersion,
      baseUrl: s.options.baseUrl,
      platform: s.options.platform,
      clock: {
        lastServerTime: s.lastServerTime,
        lastClientTime: s.lastClientTime,
        skewMs,
      },
      entitlements: {
        count: s.hydrated ? s.entitlements.list().length : 0,
        lastUpdated: s.hydrated ? s.entitlements.freshness : 0,
        stale: s.hydrated ? s.entitlements.isStale : false,
        listenerErrors: s.entitlements.listenerErrors,
      },
      events: s.events.getStats(),
    };
  }

  // ---------- private helpers ----------

  private requireStarted(): InternalState {
    if (!this.state) {
      throw new CrossdeckError({
        type: "configuration_error",
        code: "not_initialized",
        message:
          "Call Crossdeck.init({ appId, publicKey, environment }) before any other method.",
      });
    }
    return this.state;
  }

  /**
   * Build the identity query for /v1/entitlements. Priority:
   *   crossdeckCustomerId > developerUserId > anonymousId
   */
  private identityQueryParams(): Record<string, string | undefined> {
    const s = this.requireStarted();
    if (s.identity.crossdeckCustomerId) {
      return { customerId: s.identity.crossdeckCustomerId };
    }
    if (s.developerUserId) return { userId: s.developerUserId };
    return { anonymousId: s.identity.anonymousId };
  }

  /**
   * Embed every known identity axis on the event. Send everything we
   * know; let the warehouse count by whichever axis matches the
   * question. Each field is at most 32 bytes — sending three on
   * every event costs ~80 bytes per request.
   */
  private identityHintForEvent(): Pick<
    QueuedEvent,
    "developerUserId" | "anonymousId" | "crossdeckCustomerId"
  > {
    const s = this.requireStarted();
    const hint: Pick<
      QueuedEvent,
      "developerUserId" | "anonymousId" | "crossdeckCustomerId"
    > = {
      anonymousId: s.identity.anonymousId,
    };
    if (s.developerUserId) hint.developerUserId = s.developerUserId;
    if (s.identity.crossdeckCustomerId) {
      hint.crossdeckCustomerId = s.identity.crossdeckCustomerId;
    }
    return hint;
  }

  private mintEventId(): string {
    const ts = Date.now().toString(36);
    return `evt_${ts}${randomChars(8)}`;
  }
}

/**
 * Default singleton — most consumers want one SDK instance per app.
 * Creating extra instances is fine; just `new CrossdeckClient()`.
 */
export const Crossdeck = new CrossdeckClient();

// ============================================================
// Internal helpers
// ============================================================

/**
 * Derive the env from a publishable key prefix.
 *   cd_pub_test_… → "sandbox"
 *   cd_pub_live_… → "production"
 *   cd_pub_…       → null (legacy / unprefixed — env can't be inferred)
 */
function inferEnvFromKey(publicKey: string): Environment | null {
  if (publicKey.startsWith("cd_pub_test_")) return "sandbox";
  if (publicKey.startsWith("cd_pub_live_")) return "production";
  return null;
}

/**
 * Best-effort runtime platform detection via react-native's
 * `Platform.OS`. Returns "web" as the safe default in non-RN
 * runtimes (vitest under node, Storybook, etc.) so backend
 * validators don't reject.
 */
function detectPlatform(): Platform {
  try {
    const req = (globalThis as { require?: (id: string) => unknown }).require;
    if (typeof req !== "function") return "web";
    const mod = req("react-native") as { Platform?: { OS?: string } } | undefined;
    const os = mod?.Platform?.OS;
    if (os === "ios" || os === "android" || os === "web") return os;
    return "web";
  } catch {
    return "web";
  }
}
