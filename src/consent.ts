/**
 * Consent gating + PII scrub.
 *
 * Three consent dimensions (GDPR / CCPA-grade kill switches), each
 * defaulting to "granted" but runtime-overridable via
 * `Crossdeck.consent({...})`:
 *
 *   analytics  — track(), identify(), auto-emissions. Off → events
 *                drop silently, no network calls fire.
 *   marketing  — paid-traffic click IDs and referrer URL. Off → these
 *                get scrubbed before they ever land in the event bag.
 *   errors     — error capture. Off → no error.* events emitted.
 *
 * No `respectDnt` option on React Native — there's no `navigator` or
 * Do-Not-Track header equivalent in the RN runtime. The developer is
 * responsible for wiring whatever consent mechanism their app uses
 * (App Tracking Transparency on iOS, custom UI elsewhere) into
 * `Crossdeck.consent({...})` calls.
 *
 * PII scrub: defence-in-depth regex pass over every string property
 * value. Sentinel tokens (`<email>`, `<card>`) match the backend's
 * scrub (backend/src/api/lib/scrub.ts) so the same event scrubbed at
 * SDK or backend layers carries the same dashboard-aggregation key.
 * Recursive — nested plain objects + arrays-of-objects are walked,
 * so a `{user:{email:"x@y.com"}}` payload ships scrubbed.
 */

export interface ConsentState {
  analytics: boolean;
  marketing: boolean;
  errors: boolean;
}

const ALL_GRANTED: ConsentState = {
  analytics: true,
  marketing: true,
  errors: true,
};

export class ConsentManager {
  private state: ConsentState = { ...ALL_GRANTED };

  /**
   * Merge new dimensions onto the current state. Returns the resulting
   * snapshot.
   */
  set(partial: Partial<ConsentState>): ConsentState {
    for (const k of Object.keys(partial) as Array<keyof ConsentState>) {
      const v = partial[k];
      if (typeof v === "boolean") this.state[k] = v;
    }
    return { ...this.state };
  }

  get(): ConsentState {
    return { ...this.state };
  }

  get analytics(): boolean {
    return this.state.analytics;
  }
  get marketing(): boolean {
    return this.state.marketing;
  }
  get errors(): boolean {
    return this.state.errors;
  }
}

// ============================================================
// PII scrubbing
// ============================================================

/**
 * Email-shaped pattern. Reasonably restrictive — matches RFC 5322's
 * "obs-local-part" common case (the practical 99% of emails).
 */
const EMAIL_PATTERN =
  /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

/**
 * Card-number-shaped pattern. Matches sequences of 13-19 digits
 * separated by space or hyphen — the format every payment form
 * accepts. Anchored on a digit at both ends so trailing separators
 * aren't pulled into the match.
 */
const CARD_PATTERN = /\b\d(?:[ -]?\d){12,18}\b/g;

// Sentinel tokens — aligned with backend/src/api/lib/scrub.ts which
// uses <email>, <card>, <uuid>, <cdcust>, <crossdeck_secret_key>,
// <aws_access_key>. Mismatched tokens between SDK and backend
// scrubbers would split dashboard aggregation (same event arriving
// via two paths carries two different sentinels).
const REPLACEMENT_EMAIL = "<email>";
const REPLACEMENT_CARD = "<card>";

/**
 * Scrub a single string value: replace email-shaped substrings with
 * `<email>` and card-number-shaped substrings with `<card>`. Returns
 * the original string when nothing matched.
 *
 * Implementation note: `.replace()` is called unconditionally rather
 * than gating on `.test()`. The /g regexes are module-level so
 * `.test()` carries `lastIndex` state between calls — a prior match
 * leaves `lastIndex` mid-string and the next `.test()` can falsely
 * return false on a string that DOES match. `.replace(/g)` always
 * scans the full string regardless of `lastIndex`.
 */
export function scrubPii(value: string): string {
  if (!value) return value;
  return value
    .replace(EMAIL_PATTERN, REPLACEMENT_EMAIL)
    .replace(CARD_PATTERN, REPLACEMENT_CARD);
}

/**
 * Walk an event's properties and replace PII-shaped strings in place.
 * Returns a new object with strings scrubbed; non-string values pass
 * through unchanged.
 *
 * Defensive copy — the input is never altered. Caller can pass the
 * result straight to the queue.
 *
 * Recursive: nested plain objects + arrays are walked. Without this,
 * an event like `{user:{email:"wes@…"}}` would ship the email
 * unscrubbed because the top-level value is an object, not a string.
 * Every captured-error report ships nested `frames[]` / `breadcrumbs[]`
 * / `context{}` / `http{}` shapes through here — this is the SDK's
 * #1 PII protection beyond the SDK boundary.
 *
 * Date / Map / Set / Error / class instances pass through untouched
 * (those are the validateEventProperties sanitiser's job — this is
 * the PII regex pass only).
 */
export function scrubPiiFromProperties(
  properties: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(properties)) {
    out[k] = scrubValue(properties[k]);
  }
  return out;
}

function scrubValue(v: unknown): unknown {
  if (typeof v === "string") return scrubPii(v);
  if (Array.isArray(v)) return v.map(scrubValue);
  if (v && typeof v === "object" && (v as object).constructor === Object) {
    // Plain objects only — Date, Map, Set, Error, RegExp, class
    // instances are left untouched so we don't accidentally mutate
    // an Error's `message` and confuse downstream error reporting.
    return scrubPiiFromProperties(v as Record<string, unknown>);
  }
  return v;
}
