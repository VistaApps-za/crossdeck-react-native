# Changelog

All notable changes to `@cross-deck/react-native` will be documented
here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] — 2026-05-24

First public release. Built bank-grade from day one — every audit
pattern landed during the `@cross-deck/web` + `@cross-deck/node`
KPMG review is baked in. Three Crossdeck pillars in one SDK,
modelled on the shipping `@cross-deck/web` API surface so a
cross-platform team writes identical call-sites:

```ts
import { Crossdeck } from "@cross-deck/react-native";

Crossdeck.init({
  appId: "app_rn_xxx",
  publicKey: "cd_pub_live_…",
  environment: "production",
});

await Crossdeck.identify("user_847");
if (Crossdeck.isEntitled("pro")) showPro();
Crossdeck.track("paywall_shown", { variant: "v3" });
```

### Subscriptions & entitlements

- **Durable last-known-good entitlement cache.** `EntitlementCache.hydrate()`
  loads from AsyncStorage during `init()`, so `isEntitled()` is correct
  from the first call after `init()` resolves — no cold-start window
  where a returning Pro customer reads as free.
- **An outage can never fail a paying customer down to free.** A
  failed `getEntitlements()` never clears the cache; only a successful
  fetch replaces it. Each entitlement is still honoured against its
  own `validUntil`, so a timed-out trial still ends.
- **`onEntitlementsChange(listener)`** subscriber API for reactive UI
  binding — fires after `getEntitlements()` / `syncPurchases()` /
  `reset()`. Listener errors are swallowed (a buggy consumer can't
  crash the SDK or other listeners) and counted in `diagnostics()`.
- **`syncPurchases({ rail, signedTransactionInfo | purchaseToken })`**
  forwards Apple StoreKit 2 or Google Billing evidence for backend
  verification + entitlement projection.
- **`isEntitled(key)`** + **`listEntitlements()`** are synchronous
  reads of the in-memory cache. Subscribe via `onEntitlementsChange`
  for reactive bindings.

### Analytics

- **Bank-grade event queue.** `pendingBatch` slot keeps the in-flight
  batch with the SAME `Idempotency-Key` across retries (Stripe
  pattern) — backend dedupe on `(projectId, eventId)` handles the
  belt-and-suspenders. Persisted blob always carries
  `[...pendingBatch, ...buffer]` via AsyncStorage so an app crash
  mid-flight replays the in-flight batch on the next launch.
- **4xx hard-stop.** 400 / 401 / 403 / 404 / 422 etc. drop the batch
  loudly: `onPermanentFailure` callback + `console.error` regardless
  of debug mode + `dropped` counter increments. Pre-fix (web/node
  1.2.x and earlier) every error retried forever with the same key.
- **Exponential backoff with full jitter** on retryable failures
  (5xx / network / 408 / 429). Honours server `Retry-After` when
  bigger than the computed window, capped at 24h as a sanity guard.
- **Hard buffer cap (1000 events).** Past the cap we evict the
  OLDEST events and increment `dropped` so the developer can see the
  loss in `diagnostics()`.
- **Super properties** (`register` / `unregister`) and **groups**
  (`group(type, id, traits)`) — Mixpanel pattern, attached to every
  event automatically. Both cleared on `reset()`.

### Error capture

- **`ErrorUtils.setGlobalHandler`** chains in front of RN's default
  handler (the red-box developer overlay) so uncaught errors AND
  unhandled promise rejections are captured WITHOUT breaking the
  dev experience. Stack frames parsed via the Hermes / JSC / V8
  unified parser.
- **`globalThis.fetch` wrap** catches 5xx + network failures. The
  configured `selfHostname` (derived from `init({ baseUrl })`) is
  excluded so a Crossdeck-side outage doesn't recurse through its
  own fetch-wrap. Strict hostname compare (no substring matches —
  `api.cross-deck.com.attacker.example` doesn't falsely match).
- **Per-fingerprint rate limit** (5 per minute by default) defends
  against runaway loops. Per-session cap (100) bounds the worst
  case.
- **`captureError(err)` / `captureMessage(msg)`** manual API for
  try/catch blocks + soft signals.
- **`setErrorBeforeSend(hook)`** with the bank-grade getter contract
  — a hook installed AFTER `init()` fires on the next captured
  error. Pre-fix on web/node 1.2.x the hook was captured by value
  and silently inert if installed late.
- **Breadcrumb buffer (50 entries)** auto-populated by every
  `track()` call + every `fetch` request (with the self-skip
  filter). Attached to every error report.

### Privacy & compliance

- **PII scrub** — defensive regex pass over every string property
  value before flush. Email-shaped → `<email>`, card-number-shaped
  → `<card>` (sentinel tokens aligned with the backend so dashboard
  aggregation works across SDK-scrub and backend-scrub paths).
  **Recursive walk**: nested plain objects + arrays-of-objects are
  visited, so a `{user:{email:"x@y.com"}}` payload ships scrubbed.
- **`Crossdeck.consent({...})`** — three independent dimensions
  (analytics / marketing / errors), each defaulting to `true`
  (granted). `consent({analytics: false})` drops every subsequent
  `track()` silently.
- **`Crossdeck.forget()`** — GDPR / CCPA right to be forgotten.
  Calls `/v1/identity/forget` + wipes every local state surface.

### Diagnostics

- **`Crossdeck.diagnostics()`** — stable shape whether or not
  `init()` has been called. Returns identity (anonymousId,
  crossdeckCustomerId, developerUserId), clock skew (server vs
  client `Date.now()` at last heartbeat), entitlement cache
  freshness, queue stats (buffered, dropped, in-flight, last error,
  consecutive failures, next retry).
- **Boot heartbeat** verifies the publishable key against the
  Crossdeck API the moment the SDK is constructed. The dashboard's
  "Verify install" check turns green within ~200ms without the
  caller having to add an explicit call. Disable via
  `autoHeartbeat: false` for CI / tests.

### Cross-cutting

- **`SDK_VERSION` codegen'd from `package.json`** via
  `scripts/sync-sdk-versions.mjs` — the wire `Crossdeck-Sdk-Version`
  header can never drift from the published bundle. CI gate via
  `--check` mode catches drift before publish.
- **Identity continuity via AsyncStorage** (optional peer dep) with
  graceful in-memory fallback when AsyncStorage isn't installed
  (Storybook snapshots, vitest under node).
- **TypeScript-first** — strict mode, `noUncheckedIndexedAccess`,
  every public type exported.

### Coverage gaps explicitly deferred

- **Auto-track sessions + deep-links** (AppState lifecycle + Linking
  API) deferred to 1.1.0. v1.0 expects the developer to wire
  `Crossdeck.track("screen.viewed", {...})` from their nav lib's
  listener. Adding AppState + Linking properly is its own design
  decision (background-foreground policy, session timeout semantics,
  cold-start vs warm-start distinction).
- **Bundle-size budget gate** — RN apps don't have a per-byte CDN
  cost the way web does; size discipline is a v1.1 add.
