/**
 * Device + environment enrichment for React Native.
 *
 * Auto-attached to every event the SDK emits when the developer
 * opts into deviceInfo enrichment. Caller-supplied event properties
 * always override auto-detected ones.
 *
 * Privacy posture:
 *   - No fingerprinting (no canvas hashes, no font enumeration).
 *   - No precise geolocation (only timezone + locale, both of which
 *     the runtime exposes to every app anyway).
 *   - No IP collection — the backend logs the request IP for
 *     rate-limit purposes; it isn't stored on the event document.
 *   - All fields are typed enums or short strings; we never echo
 *     back raw User-Agent equivalents to avoid surfacing
 *     fingerprintable detail in dashboards.
 *
 * RN-specific sources:
 *   - `Platform.OS` for ios / android (web for RN-Web).
 *   - `Platform.Version` for OS version (number on Android, string
 *     on iOS).
 *   - `Platform.constants?.{Model,Brand,Manufacturer}` on Android
 *     (iOS doesn't expose without a native module).
 *   - `Dimensions.get("screen")` + `.get("window")` for screen size.
 *   - `Intl.DateTimeFormat().resolvedOptions()` for locale +
 *     timezone (Hermes 0.74+ supports the Intl API; older Hermes
 *     degrades to null silently).
 */

export interface DeviceInfo {
  os?: "ios" | "android" | "web" | "windows" | "macos" | string;
  osVersion?: string;
  model?: string;
  brand?: string;
  manufacturer?: string;
  isPad?: boolean;
  isTV?: boolean;
  locale?: string;
  timezone?: string;
  screenWidth?: number;
  screenHeight?: number;
  windowWidth?: number;
  windowHeight?: number;
  scale?: number;
  fontScale?: number;
  /** Caller-supplied. Set via Crossdeck.init({ appVersion: "1.2.3" }). */
  appVersion?: string;
}

/**
 * Collect every safe-to-attach environment field. Returns an empty
 * object outside an RN runtime — caller can pass appVersion via the
 * `extra` argument when running under vitest / node test fixtures.
 */
export function collectDeviceInfo(extra?: { appVersion?: string }): DeviceInfo {
  const info: DeviceInfo = {};
  if (extra?.appVersion) info.appVersion = extra.appVersion;

  // ----- Platform module (RN core) -----
  const Platform = loadPlatform();
  if (Platform) {
    info.os = Platform.OS;
    if (Platform.Version !== undefined) {
      info.osVersion = String(Platform.Version);
    }
    if (Platform.isPad) info.isPad = true;
    if (Platform.isTV) info.isTV = true;
    const c = Platform.constants;
    if (c && typeof c === "object") {
      if (typeof c.Model === "string") info.model = c.Model;
      if (typeof c.Brand === "string") info.brand = c.Brand;
      if (typeof c.Manufacturer === "string") info.manufacturer = c.Manufacturer;
    }
  }

  // ----- Dimensions module (RN core) -----
  const Dimensions = loadDimensions();
  if (Dimensions) {
    try {
      const screen = Dimensions.get("screen");
      if (screen) {
        info.screenWidth = screen.width;
        info.screenHeight = screen.height;
        if (screen.scale !== undefined) info.scale = screen.scale;
        if (screen.fontScale !== undefined) info.fontScale = screen.fontScale;
      }
    } catch {
      /* ignore */
    }
    try {
      const win = Dimensions.get("window");
      if (win) {
        info.windowWidth = win.width;
        info.windowHeight = win.height;
      }
    } catch {
      /* ignore */
    }
  }

  // ----- Locale + timezone via Intl (Hermes 0.74+ / modern JSC) -----
  try {
    const opts = Intl.DateTimeFormat().resolvedOptions();
    if (opts.locale) info.locale = opts.locale;
    if (opts.timeZone) info.timezone = opts.timeZone;
  } catch {
    /* runtime without Intl — leave both null */
  }

  return info;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function loadPlatform(): any | null {
  return safeRequire("react-native", "Platform");
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function loadDimensions(): any | null {
  return safeRequire("react-native", "Dimensions");
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function safeRequire(moduleId: string, named: string): any | null {
  try {
    const req = (
      globalThis as { require?: (id: string) => unknown }
    ).require;
    if (typeof req !== "function") return null;
    const mod = req(moduleId) as Record<string, unknown> | undefined;
    if (!mod) return null;
    return mod[named] ?? null;
  } catch {
    return null;
  }
}
