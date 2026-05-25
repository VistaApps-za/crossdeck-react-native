/**
 * Stripe-style error wrapper for @cross-deck/react-native.
 *
 * Wire shape is shared with @cross-deck/web and @cross-deck/node so
 * cross-platform catch blocks read identically:
 *
 *   try {
 *     await Crossdeck.identify("user_847");
 *   } catch (err) {
 *     if (err instanceof CrossdeckError && err.code === "invalid_api_key") { … }
 *   }
 *
 * Retry-After parsing is identical to web — the event queue's retry
 * policy honours the server-supplied delay when it exceeds the
 * computed backoff (a 429 `Retry-After: 120` wins over a base+jitter
 * of 800ms, capped at 24h as a sanity guard).
 */

export type CrossdeckErrorType =
  | "authentication_error"
  | "permission_error"
  | "invalid_request_error"
  | "rate_limit_error"
  | "internal_error"
  | "network_error"
  | "configuration_error";

export interface CrossdeckErrorPayload {
  type: CrossdeckErrorType;
  code: string;
  message: string;
  /** Server-issued request ID. Echoed in support tickets. */
  requestId?: string;
  /** HTTP status code if the error came from an API response. */
  status?: number;
  /**
   * Server-suggested wait (in milliseconds) before retrying. Populated
   * from the `Retry-After` response header on 429 / 503. Consumers MUST
   * honour this — the server is telling you the safe rate.
   */
  retryAfterMs?: number;
}

export class CrossdeckError extends Error {
  public readonly type: CrossdeckErrorType;
  public readonly code: string;
  public readonly requestId?: string;
  public readonly status?: number;
  public readonly retryAfterMs?: number;

  constructor(payload: CrossdeckErrorPayload) {
    super(payload.message);
    this.name = "CrossdeckError";
    this.type = payload.type;
    this.code = payload.code;
    this.requestId = payload.requestId;
    this.status = payload.status;
    this.retryAfterMs = payload.retryAfterMs;
    // Restore prototype chain — needed when downlevelled past ES2015
    // (Hermes pre-0.74, Babel transpiled targets).
    Object.setPrototypeOf(this, CrossdeckError.prototype);
  }
}

/**
 * Build a CrossdeckError from a non-OK fetch Response. Reads the
 * Stripe-style envelope `{ error: { type, code, message, request_id } }`.
 * Falls back to a generic shape if the body isn't valid JSON.
 */
export async function crossdeckErrorFromResponse(
  res: Response,
): Promise<CrossdeckError> {
  const requestId = res.headers.get("x-request-id") ?? undefined;
  const retryAfterMs = parseRetryAfterHeader(res.headers.get("retry-after"));
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  const envelope = (body as {
    error?: Partial<CrossdeckErrorPayload> & { request_id?: string };
  })?.error;
  if (envelope && typeof envelope.type === "string" && typeof envelope.code === "string") {
    return new CrossdeckError({
      type: envelope.type as CrossdeckErrorType,
      code: envelope.code,
      message: envelope.message ?? `HTTP ${res.status}`,
      requestId: envelope.request_id ?? requestId,
      status: res.status,
      retryAfterMs,
    });
  }
  return new CrossdeckError({
    type: typeMapForStatus(res.status),
    code: `http_${res.status}`,
    message: `HTTP ${res.status} ${res.statusText || ""}`.trim(),
    requestId,
    status: res.status,
    retryAfterMs,
  });
}

/**
 * Parse the `Retry-After` header per RFC 7231 §7.1.3. Two forms:
 *   - delta-seconds: "Retry-After: 120"  → 120_000 ms
 *   - HTTP-date:     "Retry-After: Wed, 21 Oct 2026 07:28:00 GMT"
 *                    → max(0, target - now) ms
 *
 * Returns undefined when the header is missing, malformed, or in the past.
 */
export function parseRetryAfterHeader(value: string | null): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    const secs = Number(trimmed);
    if (!Number.isFinite(secs) || secs < 0) return undefined;
    return Math.round(secs * 1000);
  }
  if (!/[a-zA-Z,/:]/.test(trimmed)) return undefined;
  const target = Date.parse(trimmed);
  if (!Number.isFinite(target)) return undefined;
  const delta = target - Date.now();
  return delta > 0 ? delta : 0;
}

function typeMapForStatus(status: number): CrossdeckErrorType {
  if (status === 401) return "authentication_error";
  if (status === 403) return "permission_error";
  if (status === 429) return "rate_limit_error";
  if (status >= 400 && status < 500) return "invalid_request_error";
  return "internal_error";
}
