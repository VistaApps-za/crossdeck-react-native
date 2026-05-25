/**
 * @cross-deck/react-native — public entry point.
 *
 * The default export is a singleton `Crossdeck` instance. Most apps
 * want exactly one client; instantiate `CrossdeckClient` directly if
 * you need isolated instances (e.g. one per tenant in a multi-tenant
 * RN shell).
 */

export { Crossdeck, CrossdeckClient } from "./crossdeck";
export { CrossdeckError, parseRetryAfterHeader } from "./errors";
export { MemoryStorage, AsyncStorageAdapter } from "./storage";
export { SDK_NAME, SDK_VERSION, DEFAULT_BASE_URL } from "./http";
export { scrubPii, scrubPiiFromProperties } from "./consent";

export type {
  CrossdeckOptions,
  IdentifyOptions,
  GroupTraits,
  EventProperties,
  KeyValueStorage,
  PublicEntitlement,
  EntitlementsListResponse,
  AliasResult,
  PurchaseResult,
  HeartbeatResponse,
  Diagnostics,
  Environment,
  Platform,
  AuditRail,
} from "./types";
export type { ConsentState } from "./consent";
export type { DeviceInfo } from "./device-info";
export type { CrossdeckErrorType, CrossdeckErrorPayload } from "./errors";
export type { Breadcrumb, BreadcrumbCategory, BreadcrumbLevel } from "./breadcrumbs";
export type { CapturedError, ErrorLevel } from "./error-capture";
export type { StackFrame } from "./stack-parser";
export type { EntitlementsListener } from "./entitlement-cache";
