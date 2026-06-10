/**
 * _diagnostic-telemetry.ts (React Native SDK)
 *
 * Single-fire reliability telemetry for the SDK. Carries the
 * `crossdeck.contract_failed` event ONE WAY to the Crossdeck
 * reliability endpoint — NEVER the customer's appId, NEVER the
 * customer's track() pipeline, NEVER visible in the customer's
 * dashboard.
 *
 * Why this exists
 * ───────────────────────────────────────────────────────────────────
 * Crossdeck is an independent controller for SDK Diagnostic
 * Telemetry (Privacy Policy §6, "Flow B"). The legitimate-interest
 * basis depends on the payload remaining diagnostic-only: no
 * end-user identifiers, no free-form text, no stack frames. The
 * schema-lock contract at
 * `contracts/diagnostics/contract-failed-payload-schema-lock.json`
 * fixes the wire shape; this module is the call site that has to
 * honour it.
 *
 * Why bypass the existing HttpClient
 * ───────────────────────────────────────────────────────────────────
 * The HttpClient is configured for the customer's project (their
 * API key, their endpoint). Routing reliability telemetry through
 * it would (a) bill against the customer's event quota and (b)
 * show individual contract failures in their dashboard, which is
 * neither the customer's nor Crossdeck's intent. A separate one-way
 * path is the structural guarantee.
 *
 * PROVISIONING NOTE
 * ───────────────────────────────────────────────────────────────────
 * The reliability endpoint URL + publishable key below are LITERAL
 * CONSTANTS shipped in the SDK. Until the reliability project is
 * minted, the placeholder values disable telemetry — the function
 * returns early without making a request. After provisioning, swap
 * the placeholders for the real values; the same values go into the
 * backend at backend/src/api/v1-sdk-diagnostic.ts.
 */

import { SDK_NAME, SDK_VERSION } from "./_version";

/** Reliability endpoint URL. Hardcoded — never read from config. */
export const DIAGNOSTIC_TELEMETRY_ENDPOINT =
  "https://api.cross-deck.com/v1/sdk/diagnostic";

/** Reliability project's publishable key. Hardcoded constant.
 *  Provisioned 2026-05-27 — Crossdeck reliability workspace
 *  (app_web_92b2d6a5728a4d). Every customer SDK's contract_failed
 *  events route here for Crossdeck-on-Crossdeck observability. */
export const DIAGNOSTIC_TELEMETRY_PUBLISHABLE_KEY =
  "cd_pub_live_9490e7aa029c432abf";

/**
 * Whether the telemetry is enabled. Disabled while the reliability
 * project is unprovisioned (placeholder key in place).
 */
export function isDiagnosticTelemetryEnabled(): boolean {
  return !DIAGNOSTIC_TELEMETRY_PUBLISHABLE_KEY.startsWith(
    "cd_pub_RELIABILITY_PLACEHOLDER",
  );
}

/**
 * The exhaustive set of fields the payload may contain — mirrors the
 * schema-lock contract.
 */
export const DIAGNOSTIC_TELEMETRY_ALLOWED_KEYS: ReadonlySet<string> = new Set([
  "contract_id",
  "sdk_version",
  "sdk_platform",
  "failure_reason",
  "run_context",
  "run_id",
  "test_file",
  "test_name",
  "device_class",
]);

/**
 * Fire-and-forget POST to the reliability endpoint. Returns
 * immediately. Never throws — failures are silently dropped so the
 * customer's app is not affected by reliability-endpoint
 * availability.
 *
 * React Native ships fetch from a global polyfill (whatwg-fetch on
 * Android, NSURLSession bridge on iOS). We never need a different
 * code path between the platforms — the only requirement is that
 * fetch exists; if it doesn't (custom runtime, jest without polyfill)
 * we silently drop.
 *
 * @param payload key/value map of payload fields. Keys not in
 *   {@link DIAGNOSTIC_TELEMETRY_ALLOWED_KEYS} are dropped before
 *   serialisation.
 */
export function filterDiagnosticPayload(
  payload: Record<string, string>,
): Record<string, string> {
  const filtered: Record<string, string> = {};
  for (const [k, v] of Object.entries(payload)) {
    if (DIAGNOSTIC_TELEMETRY_ALLOWED_KEYS.has(k) && typeof v === "string") {
      filtered[k] = v;
    }
  }
  return filtered;
}

export function sendDiagnosticTelemetry(
  payload: Record<string, string>,
): void {
  if (!isDiagnosticTelemetryEnabled()) return;
  const filtered = filterDiagnosticPayload(payload);
  if (Object.keys(filtered).length === 0) return;

  const body = JSON.stringify(filtered);
  const f = (globalThis as { fetch?: typeof fetch }).fetch;
  if (typeof f !== "function") return;

  try {
    void f(DIAGNOSTIC_TELEMETRY_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${DIAGNOSTIC_TELEMETRY_PUBLISHABLE_KEY}`,
        "Crossdeck-Sdk-Version": `${SDK_NAME}@${SDK_VERSION}`,
      },
      body,
    }).catch(() => {
      // Fire-and-forget; never propagate a rejection.
    });
  } catch {
    // Swallow synchronous throws.
  }
}
