/**
 * Error capture for React Native.
 *
 * Catches every error source the RN runtime can hand us and ships
 * them as Crossdeck events. The pipeline reuses the analytics queue:
 *   - Same durable persistence (errors survive backgrounding /
 *     low-memory teardown)
 *   - Same exponential backoff (a flapping server doesn't flood
 *     errors past the rate limit)
 *   - Same Idempotency-Key (duplicate batches dedup server-side)
 *   - Same consent gate (`consent.errors`)
 *   - Same PII scrub on properties before they leave
 *
 * Error sources captured (each toggleable):
 *   1. `ErrorUtils.setGlobalHandler` — uncaught synchronous +
 *      unhandled promise rejections (RN wires both through the
 *      same global handler since RN 0.63+; older versions ship a
 *      separate `HermesInternal.enablePromiseRejectionTracker`).
 *   2. `globalThis.fetch` wrap — HTTP errors the app code didn't
 *      catch. 5xx + network failures fire.
 *   3. `Crossdeck.captureError(err)` — manual API for try/catch
 *      blocks.
 *   4. `Crossdeck.captureMessage(msg)` — non-error events you want
 *      to surface as issues.
 *
 * Defensive design rules:
 *   - The error handler must NEVER throw — if our own code crashes
 *     while reporting an error, we'd take down the host app's
 *     error handler too. Every callback is wrapped in try/swallow.
 *   - Recursion guard: a `_reporting` flag prevents the SDK from
 *     reporting its own errors recursively forever.
 *   - Rate limited per-fingerprint: max N reports per minute to
 *     defend against runaway loops (e.g. an error in setInterval).
 *   - Self-skip: requests to the configured `selfHostname` (derived
 *     from `baseUrl`) never trigger captureHttp — otherwise a
 *     Crossdeck-side outage would recurse (captureHttp → enqueue
 *     → /events → fail → captureHttp → ∞).
 */

import {
  parseStack,
  fingerprintError,
  type StackFrame,
} from "./stack-parser";
import type { BreadcrumbBuffer, Breadcrumb } from "./breadcrumbs";
import { isSelfRequest } from "./http";

export type ErrorLevel = "error" | "warning" | "info";

export interface CapturedError {
  /** When the error fired (epoch ms). */
  timestamp: number;
  kind:
    | "error.unhandled"
    | "error.unhandledrejection"
    | "error.handled"
    | "error.message"
    | "error.http";
  level: ErrorLevel;
  message: string;
  errorType: string | null;
  frames: StackFrame[];
  rawStack: string | null;
  filename: string | null;
  lineno: number | null;
  colno: number | null;
  fingerprint: string;
  breadcrumbs: Breadcrumb[];
  context: Record<string, unknown>;
  tags: Record<string, string>;
  http?: {
    url: string;
    method: string;
    status: number;
    statusText?: string;
  };
}

export interface ErrorCaptureConfig {
  enabled: boolean;
  /** Catch ErrorUtils.setGlobalHandler. Default true. */
  globalHandler: boolean;
  /** Wrap globalThis.fetch to capture 5xx + network failures. Default true. */
  wrapFetch: boolean;
  /** Drop errors matching these substrings or regexes. */
  ignoreErrors: Array<string | RegExp>;
  /** Sample rate, 0–1. 1.0 = send every error. */
  sampleRate: number;
  /** Maximum errors per fingerprint per minute. Default 5. */
  maxPerFingerprintPerMinute: number;
  /** Total cap per session, regardless of fingerprint. Default 100. */
  maxPerSession: number;
}

export const DEFAULT_ERROR_CAPTURE: ErrorCaptureConfig = {
  enabled: true,
  globalHandler: true,
  wrapFetch: true,
  ignoreErrors: [
    // Hermes promise-rejection wrapper boilerplate that's never
    // actionable for the app developer.
    "Possible Unhandled Promise Rejection (id: 0)",
  ],
  sampleRate: 1.0,
  maxPerFingerprintPerMinute: 5,
  maxPerSession: 100,
};

export interface ErrorTrackerOptions {
  config: ErrorCaptureConfig;
  breadcrumbs: BreadcrumbBuffer;
  /** Called with each captured error. Forwards into the event queue. */
  report: (err: CapturedError) => void;
  /** Called to read the current developer-supplied context bag. */
  getContext: () => Record<string, unknown>;
  /** Called to read the current developer-supplied tag bag. */
  getTags: () => Record<string, string>;
  /**
   * Pre-send hook GETTER. The tracker invokes this on EVERY captured
   * error to resolve the current hook reference, then calls the
   * resolved function with the error (returning `null` to drop, or
   * a modified `CapturedError` to forward).
   *
   * Getter shape — not a static function — so
   * `setErrorBeforeSend()` can install or replace the hook after
   * `init()` without re-creating the tracker. Returning `null` from
   * the GETTER means "no hook configured" and the report goes
   * through unmodified.
   */
  beforeSend?: () => ((err: CapturedError) => CapturedError | null) | null;
  /**
   * Whether the consent dimension `errors` is currently granted.
   * Checked at capture time so a flip via Crossdeck.consent() takes
   * effect immediately.
   */
  isConsented: () => boolean;
  /**
   * The SDK's own backend hostname (derived from
   * `CrossdeckOptions.baseUrl` at construction time). Used to skip
   * captureHttp for our own requests. Null / omitted when extraction
   * fails (malformed URL) OR when the test harness doesn't supply
   * one — the tracker falls through to "capture everything" rather
   * than swallow.
   */
  selfHostname?: string | null;
}

export class ErrorTracker {
  private installed = false;
  private cleanups: Array<() => void> = [];
  private _reporting = false;
  private sessionCount = 0;
  private fingerprintWindow = new Map<string, number[]>();

  constructor(private readonly opts: ErrorTrackerOptions) {}

  install(): void {
    if (this.installed) return;
    if (!this.opts.config.enabled) return;

    if (this.opts.config.globalHandler) this.installGlobalHandler();
    if (this.opts.config.wrapFetch) this.installFetchWrap();

    this.installed = true;
  }

  uninstall(): void {
    for (const fn of this.cleanups.splice(0)) {
      try {
        fn();
      } catch {
        // ignore
      }
    }
    this.installed = false;
  }

  /**
   * Manual API. Either an Error instance or any unknown value (we
   * coerce). Returns silently — never throws.
   */
  captureError(
    error: unknown,
    options?: {
      context?: Record<string, unknown>;
      tags?: Record<string, string>;
      level?: ErrorLevel;
    },
  ): void {
    if (!this.opts.isConsented()) return;
    try {
      const captured = this.buildFromUnknown(
        error,
        "error.handled",
        options?.level ?? "error",
      );
      if (options?.context)
        captured.context = { ...captured.context, ...options.context };
      if (options?.tags) captured.tags = { ...captured.tags, ...options.tags };
      this.maybeReport(captured);
    } catch {
      // self-protection — never let our own code crash the caller.
    }
  }

  /**
   * Capture a non-error event as an issue. For "we hit a
   * soft-warning code path" / "deprecated API used" kinds of
   * signals. Pairs with Sentry's captureMessage().
   */
  captureMessage(message: string, level: ErrorLevel = "info"): void {
    if (!this.opts.isConsented()) return;
    try {
      const captured: CapturedError = {
        timestamp: Date.now(),
        kind: "error.message",
        level,
        message,
        errorType: null,
        frames: [],
        rawStack: null,
        filename: null,
        lineno: null,
        colno: null,
        fingerprint: fingerprintError(message, []),
        breadcrumbs: this.opts.breadcrumbs.snapshot(),
        context: this.opts.getContext(),
        tags: this.opts.getTags(),
      };
      this.maybeReport(captured);
    } catch {
      // swallow
    }
  }

  // ============================================================
  // Listener installation
  // ============================================================

  private installGlobalHandler(): void {
    // RN's `ErrorUtils` is a global polyfill that wraps every JS
    // execution context. `setGlobalHandler` lets us chain in front
    // of the default handler (RN's red-box developer overlay) so
    // we get every uncaught error AND the dev experience stays
    // intact.
    const g = globalThis as unknown as {
      ErrorUtils?: {
        getGlobalHandler?: () => (error: Error, isFatal?: boolean) => void;
        setGlobalHandler?: (
          handler: (error: Error, isFatal?: boolean) => void,
        ) => void;
      };
    };
    const ErrorUtils = g.ErrorUtils;
    if (!ErrorUtils?.setGlobalHandler || !ErrorUtils?.getGlobalHandler) return;

    const prior = ErrorUtils.getGlobalHandler();
    const handler = (error: Error, isFatal?: boolean): void => {
      if (!this._reporting && this.opts.isConsented()) {
        try {
          this._reporting = true;
          const captured = this.buildFromUnknown(
            error,
            "error.unhandled",
            isFatal ? "error" : "warning",
          );
          this.maybeReport(captured);
        } catch {
          // swallow
        } finally {
          this._reporting = false;
        }
      }
      // Always defer to the prior handler so RN's red-box / OS
      // crash reporter still fires. We're additive, not
      // replacement.
      if (prior) {
        try {
          prior(error, isFatal);
        } catch {
          // swallow
        }
      }
    };

    ErrorUtils.setGlobalHandler(handler);
    this.cleanups.push(() => {
      // Best-effort restore — if a later library wrapped us, leave
      // their wrapper in place (matches web's fetch-wrap policy).
      if (prior) ErrorUtils.setGlobalHandler!(prior);
    });
  }

  /**
   * Wrap globalThis.fetch so failed HTTP requests get
   * auto-captured. We do NOT call 4xx an "error" (those are often
   * expected — auth required, validation failed). Only 5xx +
   * network failures fire.
   */
  private installFetchWrap(): void {
    const origFetch = globalThis.fetch;
    if (typeof origFetch !== "function") return;
    const tracker = this;
    const wrapped: typeof fetch = async (
      ...args: Parameters<typeof fetch>
    ): Promise<Response> => {
      const input = args[0];
      const init = args[1] ?? {};
      const url =
        typeof input === "string" ? input : (input as Request)?.url ?? "";
      const method = (init.method || "GET").toUpperCase();
      const start = Date.now();

      // Skip self-requests for breadcrumbs too — an error report's
      // crumb trail showing "POST https://api.cross-deck.com/v1/events"
      // entries is noise the engineer doesn't care about.
      if (!isSelfRequest(url, tracker.opts.selfHostname)) {
        tracker.opts.breadcrumbs.add({
          timestamp: start,
          category: "http",
          message: `${method} ${url}`,
          data: { url, method },
        });
      }

      try {
        const response = await origFetch(...args);
        if (response.status >= 500 && tracker.opts.isConsented()) {
          if (!isSelfRequest(url, tracker.opts.selfHostname)) {
            tracker.captureHttp({
              url,
              method,
              status: response.status,
              statusText: response.statusText,
            });
          }
        }
        return response;
      } catch (err) {
        // Genuine network failure (DNS, connection refused).
        if (
          tracker.opts.isConsented() &&
          !isSelfRequest(url, tracker.opts.selfHostname)
        ) {
          tracker.captureHttp({
            url,
            method,
            status: 0,
            statusText: err instanceof Error ? err.message : "network error",
          });
        }
        throw err;
      }
    };
    globalThis.fetch = wrapped;
    this.cleanups.push(() => {
      // Only restore if we're still the active wrapper. If another
      // observability tool installed AFTER us, leave their wrapper
      // in place.
      if (globalThis.fetch === wrapped) globalThis.fetch = origFetch;
    });
  }

  // ============================================================
  // Build + report
  // ============================================================

  private buildFromUnknown(
    value: unknown,
    kind: CapturedError["kind"],
    level: ErrorLevel,
  ): CapturedError {
    const coerced = coerceErrorPayload(value);
    const isErrorInstance = value instanceof Error;
    const rawStack = isErrorInstance ? (value as Error).stack ?? null : null;
    const frames = parseStack(rawStack);
    const context = this.opts.getContext();
    if (coerced.extras) {
      context.__error_extras = coerced.extras;
    }
    return {
      timestamp: Date.now(),
      kind,
      level,
      message: coerced.message,
      errorType: coerced.errorType,
      frames,
      rawStack,
      filename: frames[0]?.filename ?? null,
      lineno: frames[0]?.lineno ?? null,
      colno: frames[0]?.colno ?? null,
      fingerprint: fingerprintError(coerced.message, frames, {
        errorType: coerced.errorType,
      }),
      breadcrumbs: this.opts.breadcrumbs.snapshot(),
      context,
      tags: this.opts.getTags(),
    };
  }

  private captureHttp(info: {
    url: string;
    method: string;
    status: number;
    statusText?: string;
  }): void {
    try {
      const message = `HTTP ${info.status} ${info.method} ${info.url}`;
      const captured: CapturedError = {
        timestamp: Date.now(),
        kind: "error.http",
        level: "error",
        message,
        errorType: "HTTPError",
        frames: [],
        rawStack: null,
        filename: info.url,
        lineno: null,
        colno: null,
        fingerprint: fingerprintError(
          `HTTP ${info.status} ${info.method}`,
          [],
          { filename: info.url, errorType: "HTTPError" },
        ),
        breadcrumbs: this.opts.breadcrumbs.snapshot(),
        context: this.opts.getContext(),
        tags: this.opts.getTags(),
        http: info,
      };
      this.maybeReport(captured);
    } catch {
      // swallow
    }
  }

  // ============================================================
  // Reporting pipeline — filter / sample / rate-limit / send
  // ============================================================

  private maybeReport(err: CapturedError): void {
    if (this.sessionCount >= this.opts.config.maxPerSession) return;
    if (this.shouldIgnore(err)) return;
    if (!this.passesSample(err)) return;
    if (!this.passesRateLimit(err)) return;

    // beforeSend hook — last chance to scrub or drop. Resolve the
    // current hook through the getter on every call so a hook
    // installed via `setErrorBeforeSend()` AFTER init() takes effect
    // on THIS error, not just future ones.
    let finalErr: CapturedError | null = err;
    const hook = this.opts.beforeSend?.();
    if (hook) {
      try {
        finalErr = hook(err);
      } catch {
        // A buggy beforeSend hook must NOT swallow the error
        // report. Fall back to the original.
        finalErr = err;
      }
      if (!finalErr) return;
    }

    this.sessionCount += 1;
    try {
      this.opts.report(finalErr);
    } catch {
      // swallow — report() failure is best-effort.
    }
  }

  private shouldIgnore(err: CapturedError): boolean {
    for (const pat of this.opts.config.ignoreErrors) {
      if (typeof pat === "string" && err.message.includes(pat)) return true;
      if (pat instanceof RegExp && pat.test(err.message)) return true;
    }
    return false;
  }

  private passesSample(err: CapturedError): boolean {
    if (this.opts.config.sampleRate >= 1) return true;
    if (this.opts.config.sampleRate <= 0) return false;
    // Deterministic per-fingerprint sampling — a given user always
    // either always sends a given error or never does, no flapping.
    const hashByte = parseInt(err.fingerprint.slice(0, 2), 16);
    return hashByte / 255 < this.opts.config.sampleRate;
  }

  private passesRateLimit(err: CapturedError): boolean {
    const windowMs = 60_000;
    const now = Date.now();
    const max = this.opts.config.maxPerFingerprintPerMinute;
    const arr = this.fingerprintWindow.get(err.fingerprint) ?? [];
    const fresh = arr.filter((t) => now - t < windowMs);
    if (fresh.length >= max) {
      this.fingerprintWindow.set(err.fingerprint, fresh);
      return false;
    }
    fresh.push(now);
    this.fingerprintWindow.set(err.fingerprint, fresh);
    return true;
  }
}

// ============================================================
// Unknown-value coercion
// ============================================================

interface CoercedPayload {
  message: string;
  errorType: string | null;
  extras: Record<string, unknown> | null;
}

function coerceErrorPayload(v: unknown): CoercedPayload {
  if (v === null) return { message: "(thrown: null)", errorType: null, extras: null };
  if (v === undefined) return { message: "(thrown: undefined)", errorType: null, extras: null };
  if (typeof v === "string") return { message: v, errorType: null, extras: null };
  if (typeof v === "number" || typeof v === "boolean" || typeof v === "bigint") {
    return { message: String(v), errorType: typeof v, extras: null };
  }
  if (typeof v === "symbol") {
    return { message: v.toString(), errorType: "symbol", extras: null };
  }
  if (typeof v === "function") {
    return {
      message: `(thrown function: ${v.name || "anonymous"})`,
      errorType: "function",
      extras: null,
    };
  }

  if (v instanceof Error) {
    const errorType = v.name || v.constructor?.name || "Error";
    const message =
      typeof v.message === "string" && v.message.length > 0
        ? v.message
        : errorType;
    const extras: Record<string, unknown> = {};
    for (const key of ["code", "status", "statusCode", "errno", "cause"] as const) {
      const val = (v as unknown as Record<string, unknown>)[key];
      if (val !== undefined && typeof val !== "function") {
        extras[key] = safeClone(val);
      }
    }
    for (const key of Object.keys(v)) {
      if (key === "message" || key === "stack" || key === "name" || key === "cause") continue;
      if (key in extras) continue;
      const val = (v as unknown as Record<string, unknown>)[key];
      if (typeof val === "function") continue;
      extras[key] = safeClone(val);
    }
    return {
      message,
      errorType,
      extras: Object.keys(extras).length > 0 ? extras : null,
    };
  }

  // Plain object — try JSON, fall back to "[Object]".
  try {
    const s = JSON.stringify(v);
    return {
      message: s && s.length < 200 ? s : "[Object]",
      errorType: (v as { constructor?: { name?: string } })?.constructor?.name ?? "Object",
      extras: null,
    };
  } catch {
    return { message: "[Object]", errorType: "Object", extras: null };
  }
}

function safeClone(v: unknown): unknown {
  if (v == null) return v;
  const t = typeof v;
  if (t === "string" || t === "number" || t === "boolean") return v;
  if (t === "bigint") return String(v);
  try {
    const s = JSON.stringify(v);
    return s === undefined ? String(v) : JSON.parse(s);
  } catch {
    return String(v);
  }
}
