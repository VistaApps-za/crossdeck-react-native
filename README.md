# @cross-deck/react-native

[![npm](https://img.shields.io/npm/v/@cross-deck/react-native.svg)](https://www.npmjs.com/package/@cross-deck/react-native)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Crossdeck's React Native SDK — **verified subscriptions, entitlements,
error capture, and product telemetry across iOS + Android JS apps in
one package**. Same SDK surface as [`@cross-deck/web`](https://github.com/VistaApps-za/crossdeck-web)
+ [`@cross-deck/node`](https://github.com/VistaApps-za/crossdeck-node)
— cross-platform teams write identical call-sites.

```ts
import { Crossdeck } from "@cross-deck/react-native";

Crossdeck.init({
  appId: "app_rn_xxx",
  publicKey: "cd_pub_live_…",
  environment: "production",
});

await Crossdeck.identify("user_847");
const ents = await Crossdeck.getEntitlements();
if (Crossdeck.isEntitled("pro")) showPro();
Crossdeck.track("paywall_shown", { variant: "v3" });
```

## Install

```sh
npm install @cross-deck/react-native @react-native-async-storage/async-storage
```

```sh
# Expo
npx expo install @cross-deck/react-native @react-native-async-storage/async-storage
```

`@react-native-async-storage/async-storage` is an **optional** peer
dependency. Without it the SDK falls back to in-memory storage
(identity + queue don't survive app restarts; events queued offline
are lost on cold launch). Install it for production.

## Three pillars in one SDK

| Pillar | Surface |
|---|---|
| Subscriptions & entitlements | `getEntitlements()`, `isEntitled(key)`, `listEntitlements()`, `onEntitlementsChange(listener)`, `syncPurchases({rail, signedTransactionInfo, purchaseToken})` |
| Behavioural analytics | `track(name, properties)`, `identify(userId, options)`, `register(props)`, `group(type, id, traits)`, `consent({...})` |
| Error capture | Auto: `ErrorUtils.setGlobalHandler` + `globalThis.fetch` wrap. Manual: `captureError(err)`, `captureMessage(msg)`, `setTag`, `setContext`, `addBreadcrumb`, `setErrorBeforeSend` |

## Bank-grade defaults

Every Crossdeck SDK ships these patterns by default:

- **Durable last-known-good entitlement cache.** A returning Pro
  customer reads as Pro on the FIRST `isEntitled()` after `init()`,
  even on a cold launch with no network. A Crossdeck outage can
  never fail a paying customer down to free.
- **Queue durability + Stripe-style Idempotency-Key reuse.** Events
  spliced for a flush persist to AsyncStorage with the in-flight
  batch attached, so an app crash mid-flight replays the batch on
  the next launch. Backend dedupes on `(projectId, eventId)`.
- **4xx hard-stop.** Permanent failures (401 key revoked, 400/422
  schema, 403 permission, 404 endpoint) drop the batch + fire
  `onPermanentFailure` + `console.error` regardless of debug mode.
  No silent infinite-retry-with-growing-backlog.
- **PII scrub default-on.** Email-shaped and card-number-shaped
  substrings rewritten to `<email>` / `<card>` (sentinel tokens
  match the backend's defence-in-depth scrubber). Recursive — nested
  `{user:{email:...}}` payloads ship scrubbed.
- **Error self-skip from baseUrl.** Requests to the SDK's own
  Crossdeck endpoint never trigger captureHttp — otherwise a
  Crossdeck outage would recurse forever.
- **Boot heartbeat.** Verifies the publishable key against the
  Crossdeck API the moment the SDK is constructed. The dashboard's
  "Verify install" check turns green within ~200ms.

## Init options

| Option | Default | Notes |
|---|---|---|
| `appId` | — | **Required.** From the Crossdeck dashboard. |
| `publicKey` | — | **Required.** `cd_pub_live_…` or `cd_pub_test_…`. |
| `environment` | — | **Required.** `"production"` or `"sandbox"`. Must match key prefix. |
| `baseUrl` | `https://api.cross-deck.com/v1` | Override for self-hosted setups. |
| `persistIdentity` | `true` | Set false to defer AsyncStorage writes until after a consent gate. |
| `storage` | AsyncStorage (auto-detected) | Pass a SecureStore / MMKV adapter for higher-security app shells. |
| `storagePrefix` | `"crossdeck:"` | Key namespace inside the storage adapter. |
| `autoHeartbeat` | `true` | Disable for CI / tests. |
| `eventFlushBatchSize` | `20` | Flush when buffer reaches this size. |
| `eventFlushIntervalMs` | `5000` | Idle interval before flushing a partial batch. |
| `appVersion` | — | Your app's version (e.g. `"1.2.3"`). Auto-attached to every event as `properties.appVersion`. |
| `platform` | auto-detected | Override the `Platform.OS` detection. |
| `timeoutMs` | `15000` | Per-request HTTP timeout. |
| `debug` | `false` | Verbose diagnostic logging via the §16 debug-signal vocabulary. |
| `scrubPii` | `true` | Disable only if your pipeline does its own PII redaction downstream. |
| `errorCapture` | `true` | Disable if you have a separate error tracker (Sentry, Bugsnag) and don't want duplicates. |

## Lifecycle

`init()` returns void but kicks off async hydration (identity, super-
props, entitlement cache, persisted event queue). Every async method
(`identify`, `track`, `flush`, `getEntitlements`, etc.) awaits the
internal `ready` promise — callers can fire methods immediately after
`init()` without manual sequencing.

Sync methods (`isEntitled`, `getSuperProperties`, `diagnostics`)
read in-memory state. Until `init()` has fired they return sensible
empties.

## Foreground/background lifecycle (v1.0)

v1.0 ships WITHOUT auto-session tracking. Wire your nav library's
listener into:

```ts
import { AppState } from "react-native";

AppState.addEventListener("change", (state) => {
  if (state === "background") {
    void Crossdeck.flush();
  }
});
```

Auto sessions + deep-link tracking land in v1.1 as opt-in
`autoTrack: { sessions, deepLinks }`.

## Diagnostics

```ts
Crossdeck.diagnostics();
// {
//   started: true,
//   anonymousId: "anon_1mqz3…",
//   crossdeckCustomerId: "cdcust_abc",
//   developerUserId: "user_847",
//   sdkVersion: "1.0.0",
//   baseUrl: "https://api.cross-deck.com/v1",
//   platform: "ios",
//   clock: { lastServerTime: 1779…, lastClientTime: 1779…, skewMs: 12 },
//   entitlements: { count: 2, lastUpdated: 1779…, stale: false, listenerErrors: 0 },
//   events: { buffered: 0, dropped: 0, inFlight: 0, lastFlushAt: 1779…, lastError: null, consecutiveFailures: 0, nextRetryAt: null }
// }
```

## Documentation

- [Full SDK reference](https://cross-deck.com/docs/react-native-sdk)
- [Identify users](https://cross-deck.com/docs/identify-users)
- [Track events](https://cross-deck.com/docs/track-events)
- [Entitlements gating](https://cross-deck.com/docs/entitlements)
- [Error capture](https://cross-deck.com/docs/errors)

## License

MIT © VistaApps (Pty) Ltd
