/**
 * Stack-trace parser — normalises Hermes / JSC / V8 stack strings
 * into a common frame shape.
 *
 * Why hand-rolled, not stack-trace-js or error-stack-parser libraries:
 * those weigh 5–15 KB after minification and we'd be pulling in their
 * full feature matrix just for the parser. The patterns below cover
 * the four shapes any modern JS engine emits, totalling ~80 lines.
 *
 * The output frame shape mirrors what Sentry's `mechanism: { type:
 * 'generic' }` events ship, so future source-map symbolication on the
 * Crossdeck backend has a stable input to work against.
 *
 * Defensive: never throws. An unparseable line becomes a `raw` frame
 * with just the literal text. Engineers reading errors still get the
 * raw stack as fallback.
 */

export interface StackFrame {
  /** Function name, or "?" if anonymous / unparseable. */
  function: string;
  /** Source file URL the frame ran in. Empty when unknown. */
  filename: string;
  /** 1-indexed line number, or 0 when unknown. */
  lineno: number;
  /** 1-indexed column number, or 0 when unknown. */
  colno: number;
  /**
   * True when the frame is in the app's own code (best-effort:
   * detected by filename not being a known third-party path).
   * Helps the dashboard's "your code vs library code" view.
   */
  in_app: boolean;
  /** Raw line from the stack string for debugging when parse fails. */
  raw: string;
}

/**
 * Parse a stack string into an array of frames. Returns an empty
 * array when the input is unparseable — caller should always treat
 * the original `error.stack` as the source of truth for display.
 */
export function parseStack(stack: string | undefined | null): StackFrame[] {
  if (!stack || typeof stack !== "string") return [];
  const lines = stack.split("\n");
  const frames: StackFrame[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const frame = parseLine(trimmed);
    if (frame) frames.push(frame);
  }
  return frames;
}

function parseLine(line: string): StackFrame | null {
  // Hermes / V8 — with parens
  // Example:  at handleClick (/path/to/app.bundle:42:18)
  //           at Object.handleClick (.../app.bundle?platform=ios:42:18)
  let m = /^at\s+(.+?)\s+\((.+?):(\d+):(\d+)\)$/.exec(line);
  if (m) {
    return buildFrame({
      function: m[1]!,
      filename: m[2]!,
      lineno: parseInt(m[3]!, 10),
      colno: parseInt(m[4]!, 10),
      raw: line,
    });
  }

  // V8 — anonymous, no parens
  // Example:  at /path/to/app.bundle:42:18
  m = /^at\s+(.+?):(\d+):(\d+)$/.exec(line);
  if (m) {
    return buildFrame({
      function: "?",
      filename: m[1]!,
      lineno: parseInt(m[2]!, 10),
      colno: parseInt(m[3]!, 10),
      raw: line,
    });
  }

  // Hermes legacy / JSC — @-separator
  // Example:  handleClick@/path/to/app.bundle:42:18
  m = /^(.*?)@(.+?):(\d+):(\d+)$/.exec(line);
  if (m) {
    return buildFrame({
      function: m[1]! || "?",
      filename: m[2]!,
      lineno: parseInt(m[3]!, 10),
      colno: parseInt(m[4]!, 10),
      raw: line,
    });
  }

  // Header line (e.g. "TypeError: foo is not a function") — return
  // null so caller skips it.
  if (/^\w*Error/.test(line) || !line.includes(":")) {
    return null;
  }

  // Unparseable but plausibly a frame — keep it as raw.
  return {
    function: "?",
    filename: "",
    lineno: 0,
    colno: 0,
    in_app: true,
    raw: line,
  };
}

function buildFrame(input: {
  function: string;
  filename: string;
  lineno: number;
  colno: number;
  raw: string;
}): StackFrame {
  return {
    function: input.function || "?",
    filename: input.filename,
    lineno: Number.isFinite(input.lineno) ? input.lineno : 0,
    colno: Number.isFinite(input.colno) ? input.colno : 0,
    in_app: isInAppFrame(input.filename),
    raw: input.raw,
  };
}

/**
 * Best-effort "is this frame in the app's own code or a third-party
 * source we should de-emphasise in the UI".
 *
 * Out-of-app heuristics in the RN context: the React Native runtime
 * itself (node_modules/react-native/*), the SDK's own module, and
 * any vendored polyfill (Hermes intl, etc.).
 */
function isInAppFrame(filename: string): boolean {
  if (!filename) return true;
  if (/\/node_modules\/react-native\//.test(filename)) return false;
  if (/\bInitializeCore\.js$/.test(filename)) return false;
  if (/\b@cross-deck\/react-native\b/.test(filename)) return false;
  if (/\/node_modules\/@react-native\//.test(filename)) return false;
  if (/\/node_modules\/expo\//.test(filename)) return false;
  return true;
}

/**
 * Fingerprint an error for grouping. SHA-flavoured — we don't need
 * cryptographic strength, we need "two errors with the same call
 * site produce the same key". The Crossdeck backend may refine the
 * grouping further once source maps are uploaded.
 *
 * Input: the message + the first ≤3 in-app frames. When no frames
 * are available (cross-origin script error, non-Error throws,
 * unhandledrejection of a primitive), the optional `location`
 * fallback contributes filename:lineno:colno so otherwise-identical
 * "Unknown error" events from different call sites stay separate.
 *
 * Output: a short hex string usable as a Firestore doc id segment.
 */
export function fingerprintError(
  message: string,
  frames: StackFrame[],
  location?: {
    filename?: string | null;
    lineno?: number | null;
    colno?: number | null;
    errorType?: string | null;
  } | null,
): string {
  const inAppFrames = frames.filter((f) => f.in_app).slice(0, 3);
  const parts = [
    (message || "").slice(0, 200),
    ...inAppFrames.map((f) => `${f.function}@${f.filename}:${f.lineno}`),
  ];
  if (inAppFrames.length === 0 && location) {
    const loc = [
      location.errorType ?? "",
      location.filename ?? "",
      location.lineno ?? "",
      location.colno ?? "",
    ].join(":");
    if (loc !== ":::") parts.push(loc);
  }
  return djb2Hex(parts.join("|"));
}

/**
 * djb2 — small, fast non-cryptographic string hash. 32-bit output
 * encoded as 8-char hex. Stable across runtimes; deterministic.
 */
function djb2Hex(input: string): string {
  let h = 5381;
  for (let i = 0; i < input.length; i++) {
    h = ((h << 5) + h + input.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}
