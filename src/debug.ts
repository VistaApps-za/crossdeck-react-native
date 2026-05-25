/**
 * Debug signal vocabulary per NorthStar §16.
 *
 * The SDK speaks a small fixed vocabulary of signals so the
 * dashboard's onboarding checklist can show "we saw your first event"
 * without parsing free-form console output. When debug mode is
 * enabled the signals also log to `console.info` so a developer
 * doing copy-paste integration sees actionable feedback live.
 *
 * Signal names are STABLE — adding new ones is fine, renaming is a
 * breaking change because the dashboard onboarding step keys off
 * them.
 */

export type DebugSignal =
  | "sdk.configured"
  | "sdk.first_event_sent"
  | "sdk.invalid_key"
  | "sdk.no_identity"
  | "sdk.entitlement_cache_used"
  | "sdk.purchase_evidence_sent"
  | "sdk.environment_mismatch"
  | "sdk.sensitive_property_warning"
  | "sdk.property_coerced"
  | "sdk.queue_persisted"
  | "sdk.queue_restored"
  | "sdk.flush_retry_scheduled"
  // Emitted when the queue drops a batch because the server returned
  // a permanent 4xx (key revoked, malformed batch, etc.). Always
  // loud, regardless of debug mode — see the console.error in
  // crossdeck.ts.
  | "sdk.flush_permanent_failure"
  | "sdk.consent_changed"
  | "sdk.consent_denied"
  | "sdk.pii_scrubbed";

export interface DebugContext {
  [key: string]: unknown;
}

/**
 * Names that almost always indicate PII or secret data. Used by
 * `track()` to warn the developer when a property key looks
 * dangerous. Per NorthStar §15 these are reject/warn-on-sight values;
 * we warn rather than reject because the developer might genuinely
 * want a property called e.g. "tokens_remaining".
 */
const SENSITIVE_KEY_PATTERNS: readonly RegExp[] = [
  /^email$/i,
  /^password$/i,
  /^token$/i,
  /^secret$/i,
  /^card$/i,
  /^phone$/i,
  /password/i,
  /credit_?card/i,
];

export function findSensitivePropertyKeys(
  properties: Record<string, unknown> | undefined,
): string[] {
  if (!properties) return [];
  const hits: string[] = [];
  for (const k of Object.keys(properties)) {
    if (SENSITIVE_KEY_PATTERNS.some((re) => re.test(k))) hits.push(k);
  }
  return hits;
}

export interface DebugLogger {
  enabled: boolean;
  emit(signal: DebugSignal, message: string, context?: DebugContext): void;
}

export class ConsoleDebugLogger implements DebugLogger {
  enabled = false;
  private seen = new Set<DebugSignal>();

  emit(signal: DebugSignal, message: string, context?: DebugContext): void {
    if (!this.enabled) return;
    // For one-shot signals (sdk.configured, sdk.first_event_sent,
    // sdk.environment_mismatch) suppress duplicates within a session
    // so a chatty app doesn't spam the console with the same message.
    if (ONCE_SIGNALS.has(signal)) {
      if (this.seen.has(signal)) return;
      this.seen.add(signal);
    }
    const ctx = context ? ` ${safeJson(context)}` : "";
    // eslint-disable-next-line no-console
    console.info(`[crossdeck:${signal}] ${message}${ctx}`);
  }
}

const ONCE_SIGNALS = new Set<DebugSignal>([
  "sdk.configured",
  "sdk.first_event_sent",
  "sdk.environment_mismatch",
]);

function safeJson(obj: unknown): string {
  try {
    return JSON.stringify(obj);
  } catch {
    return "[unserialisable context]";
  }
}
