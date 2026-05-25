/**
 * HTTP transport for the SDK. Single fetch wrapper used by every
 * endpoint call. Adds the Bearer token and SDK version header, parses
 * responses, normalises errors to CrossdeckError.
 *
 * Uses RN's native `fetch` (Hermes 0.74+ ships it; older RN shims it
 * via the same Polyfill module React Native registers in
 * InitializeCore). No axios, no fetch-shim transitive deps.
 */

import { CrossdeckError, crossdeckErrorFromResponse } from "./errors";
import { SDK_NAME, SDK_VERSION } from "./_version";

export { SDK_NAME, SDK_VERSION };

export const DEFAULT_BASE_URL = "https://api.cross-deck.com/v1";
export const DEFAULT_TIMEOUT_MS = 15_000;

export interface HttpClientConfig {
  publicKey: string;
  baseUrl: string;
  sdkVersion: string;
  /**
   * Default request timeout in ms. Per-call `options.timeoutMs`
   * overrides. Caller's `options.timeoutMs: 0` disables the timeout
   * entirely (useful for tests that intentionally hang).
   *
   * Stripe-grade default: 15s. Long enough that a slow-3G mobile
   * keeps the request alive; short enough that a captive portal or
   * a hung connection doesn't sit forever. Without this, fetch()
   * inherits the runtime's default (which on Hermes can be 5+
   * minutes) and a single bad network can lock up the entire event
   * queue.
   */
  timeoutMs?: number;
}

export interface HttpRequestOptions {
  body?: unknown;
  query?: Record<string, string | undefined>;
  /**
   * Per-request timeout override (ms). Defaults to the client's
   * `timeoutMs` (15s). Pass 0 to disable the timeout entirely —
   * only sensible for tests.
   */
  timeoutMs?: number;
  /**
   * Stripe-style idempotency key. When set, the SDK adds
   * `Idempotency-Key: <value>` to the request. Reuses the SAME key
   * across retries of the SAME logical operation so the server can
   * short-circuit duplicate work without per-event dedup.
   *
   * The SDK supplies this for every batch flush — see `event-queue.ts`.
   */
  idempotencyKey?: string;
}

export class HttpClient {
  constructor(private readonly config: HttpClientConfig) {}

  /**
   * Issue a request. `path` is relative to the configured baseUrl
   * ("/entitlements", "/identity/alias", etc.).
   *
   * Throws CrossdeckError on:
   *   - Network failure (`type: "network_error"`)
   *   - Non-2xx response (typed from the body envelope)
   *   - JSON parse failure on a 2xx (treated as `internal_error`)
   */
  async request<T>(
    method: "GET" | "POST",
    path: string,
    options: HttpRequestOptions = {},
  ): Promise<T> {
    const url = this.buildUrl(path, options.query);

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.config.publicKey}`,
      "Crossdeck-Sdk-Version": `${SDK_NAME}@${this.config.sdkVersion}`,
      Accept: "application/json",
    };
    if (options.idempotencyKey) {
      // Stripe pattern: same key on retries → server can
      // short-circuit duplicate work without inspecting the body.
      headers["Idempotency-Key"] = options.idempotencyKey;
    }
    // Body is always a JSON-serialised string when present. We avoid
    // the BodyInit DOM type so the SDK doesn't need lib.dom in
    // tsconfig — RN's fetch accepts string bodies in every supported
    // engine (Hermes 0.74+, JSC, Node test runtimes).
    let bodyInit: string | undefined;
    if (options.body !== undefined) {
      headers["Content-Type"] = "application/json";
      bodyInit = JSON.stringify(options.body);
    }

    // ----- Abort timeout -----
    // Wire up an AbortController so a stuck connection (captive
    // portal, satellite link, DNS hang) doesn't lock the queue
    // forever. Per-call `timeoutMs: 0` disables, otherwise fall back
    // to client default (15s).
    const effectiveTimeout =
      options.timeoutMs ?? this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const controller =
      typeof AbortController !== "undefined" && effectiveTimeout > 0
        ? new AbortController()
        : null;
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    if (controller && effectiveTimeout > 0) {
      timeoutHandle = setTimeout(() => controller.abort(), effectiveTimeout);
    }

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers,
        body: bodyInit,
        signal: controller?.signal,
      });
    } catch (err) {
      const aborted = controller?.signal?.aborted === true;
      throw new CrossdeckError({
        type: "network_error",
        code: aborted ? "request_timeout" : "fetch_failed",
        message: aborted
          ? `Request to ${path} aborted after ${effectiveTimeout}ms`
          : err instanceof Error
            ? err.message
            : "fetch failed",
      });
    } finally {
      if (timeoutHandle !== null) clearTimeout(timeoutHandle);
    }

    if (!response.ok) {
      throw await crossdeckErrorFromResponse(response);
    }

    // 204 No Content — return undefined cast as T (callers that
    // don't expect a body shouldn't read it).
    if (response.status === 204) return undefined as T;

    try {
      return (await response.json()) as T;
    } catch {
      throw new CrossdeckError({
        type: "internal_error",
        code: "invalid_json_response",
        message: "Server returned a 2xx with an unparseable body.",
        requestId: response.headers.get("x-request-id") ?? undefined,
        status: response.status,
      });
    }
  }

  /** Exposed for the error-capture self-skip wiring. */
  get baseUrl(): string {
    return this.config.baseUrl;
  }

  private buildUrl(path: string, query?: Record<string, string | undefined>): string {
    const base = this.config.baseUrl.replace(/\/+$/, "");
    const cleanPath = path.startsWith("/") ? path : `/${path}`;
    let url = base + cleanPath;
    if (query) {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(query)) {
        if (typeof v === "string" && v.length > 0) params.append(k, v);
      }
      const qs = params.toString();
      if (qs) url += (url.includes("?") ? "&" : "?") + qs;
    }
    return url;
  }
}

/**
 * Extract the hostname from a URL string for use as the
 * `selfHostname` field on the ErrorTracker. Returns null on
 * malformed input. Lowercased for case-insensitive comparison
 * (`Api.Cross-Deck.com` and `api.cross-deck.com` are the same host).
 */
export function extractSelfHostname(baseUrl: string | undefined | null): string | null {
  if (!baseUrl || typeof baseUrl !== "string") return null;
  try {
    return new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * True when the request URL targets the SDK's own backend hostname.
 * Used by the fetch wrapper to skip captureHttp on Crossdeck's own
 * requests — otherwise a Crossdeck-side outage would recurse
 * (captureHttp → enqueue → /events → fail → captureHttp → …).
 *
 * Strict hostname compare (not substring) so a path like
 * `https://api.cross-deck.com.attacker.example/...` doesn't falsely
 * match `api.cross-deck.com`. Falls back to `false` on malformed
 * URLs — the SDK only ever uses absolute URLs, so a relative URL
 * can't be the SDK's own request.
 */
export function isSelfRequest(
  requestUrl: string,
  selfHostname: string | null | undefined,
): boolean {
  if (!selfHostname || !requestUrl) return false;
  try {
    return new URL(requestUrl).hostname.toLowerCase() === selfHostname;
  } catch {
    return false;
  }
}
