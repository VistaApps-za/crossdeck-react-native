/**
 * Breadcrumb ring buffer — context attached to every error report.
 *
 * Sentry / Datadog / Bugsnag all ship the same idea: keep a rolling
 * record of the last N "things the user did" (screen mounts, custom
 * events, network calls). When an error fires, attach the buffer so
 * the engineer reading the error can see exactly how the user got
 * into the broken state. The single most powerful debugging signal
 * in error monitoring — without breadcrumbs, errors are stack traces
 * with no story.
 *
 * Implementation: a circular buffer with a fixed cap. Old entries are
 * evicted as new ones arrive. The default cap (50) is enough to
 * cover ~5 minutes of typical user activity without ballooning the
 * error payload — Sentry uses 100 by default but the SDK is more
 * aggressive about size since we ship breadcrumbs over the wire with
 * every error, not as a separate batch.
 *
 * Privacy: breadcrumbs auto-emit from the same auto-tracking sources
 * as analytics events (when auto-track is on). Custom crumbs added
 * via Crossdeck.addBreadcrumb() pass through the same property
 * sanitiser as track() events.
 */

export type BreadcrumbCategory =
  | "navigation"
  | "ui.click"
  | "ui.input"
  | "http"
  | "console"
  | "custom"
  | "info";

export type BreadcrumbLevel = "debug" | "info" | "warning" | "error";

export interface Breadcrumb {
  /** epoch ms */
  timestamp: number;
  category: BreadcrumbCategory;
  level?: BreadcrumbLevel;
  /** Short human-readable description. */
  message?: string;
  /** Arbitrary key/value context for the crumb. */
  data?: Record<string, unknown>;
}

export class BreadcrumbBuffer {
  private items: Breadcrumb[] = [];
  constructor(private readonly maxSize: number = 50) {}

  add(crumb: Breadcrumb): void {
    this.items.push(crumb);
    if (this.items.length > this.maxSize) {
      this.items.shift();
    }
  }

  /** Defensive copy — caller can read freely without mutating buffer state. */
  snapshot(): Breadcrumb[] {
    return this.items.slice();
  }

  clear(): void {
    this.items = [];
  }

  get size(): number {
    return this.items.length;
  }
}
