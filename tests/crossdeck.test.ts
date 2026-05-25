/**
 * End-to-end tests for the public Crossdeck client. Stubs fetch
 * globally + uses MemoryStorage so the SDK exercises its full code
 * path under vitest's node environment (no RN runtime needed).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { CrossdeckClient } from "../src/crossdeck";
import { CrossdeckError } from "../src/errors";
import { MemoryStorage } from "../src/storage";

const ORIG_FETCH = globalThis.fetch;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function newClient(opts: Partial<Parameters<CrossdeckClient["init"]>[0]> = {}) {
  const c = new CrossdeckClient();
  c.init({
    appId: "app_rn_test",
    publicKey: "cd_pub_test_001",
    environment: "sandbox",
    storage: new MemoryStorage(),
    autoHeartbeat: false,
    errorCapture: false,
    ...opts,
  });
  return c;
}

beforeEach(() => {
  globalThis.fetch = ORIG_FETCH;
});
afterEach(() => {
  globalThis.fetch = ORIG_FETCH;
});

describe("init — validation", () => {
  it("rejects an invalid publishable key prefix", () => {
    const c = new CrossdeckClient();
    expect(() =>
      c.init({
        appId: "app_rn_test",
        publicKey: "sk_xxxx" as never,
        environment: "sandbox",
      }),
    ).toThrowError(CrossdeckError);
  });

  it("requires a publishable key", () => {
    const c = new CrossdeckClient();
    expect(() =>
      c.init({
        appId: "app_rn_test",
        publicKey: "" as never,
        environment: "sandbox",
      }),
    ).toThrowError(CrossdeckError);
  });

  it("requires appId", () => {
    const c = new CrossdeckClient();
    expect(() =>
      c.init({
        appId: "" as never,
        publicKey: "cd_pub_test_001",
        environment: "sandbox",
      }),
    ).toThrowError(CrossdeckError);
  });

  it("rejects environment mismatch with key prefix", () => {
    const c = new CrossdeckClient();
    expect(() =>
      c.init({
        appId: "app_rn_test",
        publicKey: "cd_pub_live_xxxx",
        environment: "sandbox",
      }),
    ).toThrowError(CrossdeckError);
  });
});

describe("identify — entitlement-cache leak guard (audit P0 #5)", () => {
  it("clears the cache when a DIFFERENT cdcust resolves", async () => {
    const c = newClient();
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, {
          object: "alias_result",
          crossdeckCustomerId: "cdcust_A",
          linked: [],
          mergePending: false,
          env: "sandbox",
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          object: "list",
          data: [
            {
              object: "entitlement",
              key: "pro",
              isActive: true,
              validUntil: null,
              source: { rail: "stripe", productId: "p", subscriptionId: "s" },
              updatedAt: 1700000000,
            },
          ],
          crossdeckCustomerId: "cdcust_A",
          env: "sandbox",
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          object: "alias_result",
          crossdeckCustomerId: "cdcust_B",
          linked: [],
          mergePending: false,
          env: "sandbox",
        }),
      ) as unknown as typeof fetch;
    await c.identify("user_A");
    await c.getEntitlements();
    expect(c.isEntitled("pro")).toBe(true);
    await c.identify("user_B");
    // Cache cleared — cdcust_A's pro entitlement must NOT leak to user_B.
    expect(c.isEntitled("pro")).toBe(false);
  });

  it("clears the cache when priorCdcust is null but cache has entries", async () => {
    const storage = new MemoryStorage();
    // Pre-populate the entitlement cache WITHOUT a cdcust (the
    // partial-wipe scenario from audit P0 #5).
    await storage.setItem(
      "crossdeck:entitlements",
      JSON.stringify({
        v: 1,
        entitlements: [
          {
            object: "entitlement",
            key: "pro",
            isActive: true,
            validUntil: null,
            source: { rail: "stripe", productId: "p_prior", subscriptionId: "s_prior" },
            updatedAt: 1700000000,
          },
        ],
        lastUpdated: 1700000000,
      }),
    );
    const c = newClient({ storage });
    // Wait for hydration (init() kicks off async).
    await c.diagnostics(); // sync; just to settle
    await new Promise((r) => setTimeout(r, 20));
    expect(c.isEntitled("pro")).toBe(true);

    globalThis.fetch = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        object: "alias_result",
        crossdeckCustomerId: "cdcust_new_user",
        linked: [],
        mergePending: false,
        env: "sandbox",
      }),
    ) as unknown as typeof fetch;
    await c.identify("user_new");
    expect(c.isEntitled("pro")).toBe(false);
  });
});

describe("track — PII scrub default-on", () => {
  it("scrubs email-shaped + card-shaped substrings in event property values", async () => {
    const c = newClient();
    const fetchSpy = vi
      .fn()
      .mockResolvedValue(jsonResponse(202, { object: "list", received: 1, env: "sandbox" }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    c.track("page_viewed_custom", {
      url: "/users/wes@pinet.co.za/edit",
      title: "Edit wes@pinet.co.za",
    });
    await c.flush();
    const eventsCall = fetchSpy.mock.calls.find(([url]) =>
      String(url).includes("/events"),
    );
    const body = JSON.parse((eventsCall![1] as RequestInit).body as string);
    expect(body.events[0].properties.url).toBe("/users/<email>/edit");
    expect(body.events[0].properties.title).toBe("Edit <email>");
  });

  it("scrubPii: false in init disables the redaction", async () => {
    const c = newClient({ scrubPii: false });
    const fetchSpy = vi
      .fn()
      .mockResolvedValue(jsonResponse(202, { object: "list", received: 1, env: "sandbox" }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    c.track("page_viewed_custom", { url: "/users/wes@pinet.co.za/edit" });
    await c.flush();
    const eventsCall = fetchSpy.mock.calls.find(([url]) =>
      String(url).includes("/events"),
    );
    const body = JSON.parse((eventsCall![1] as RequestInit).body as string);
    expect(body.events[0].properties.url).toBe("/users/wes@pinet.co.za/edit");
  });
});

describe("reset", () => {
  it("clears clock-skew snapshot", async () => {
    const c = newClient();
    globalThis.fetch = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        object: "heartbeat",
        ok: true,
        projectId: "proj_x",
        appId: "app_rn_test",
        platform: "ios",
        env: "sandbox",
        serverTime: 1_700_000_000_000,
      }),
    ) as unknown as typeof fetch;
    await c.heartbeat();
    expect(c.diagnostics().clock.lastServerTime).toBe(1_700_000_000_000);
    expect(c.diagnostics().clock.lastClientTime).not.toBeNull();
    c.reset();
    expect(c.diagnostics().clock.lastServerTime).toBeNull();
    expect(c.diagnostics().clock.lastClientTime).toBeNull();
    expect(c.diagnostics().clock.skewMs).toBeNull();
  });
});

describe("diagnostics", () => {
  it("returns started:false with stable empty shape before init()", () => {
    const c = new CrossdeckClient();
    const d = c.diagnostics();
    expect(d.started).toBe(false);
    expect(d.anonymousId).toBeNull();
    expect(d.events.buffered).toBe(0);
    expect(d.entitlements.count).toBe(0);
  });
});
