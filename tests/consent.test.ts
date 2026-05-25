import { describe, it, expect } from "vitest";
import { scrubPii, scrubPiiFromProperties, ConsentManager } from "../src/consent";

describe("scrubPii — string utility", () => {
  it("replaces an email-shaped substring with <email>", () => {
    expect(scrubPii("contact me at wes@pinet.co.za")).toBe("contact me at <email>");
  });

  it("replaces a card-number-shaped sequence with <card>", () => {
    expect(scrubPii("card 4242 4242 4242 4242 charged")).toBe("card <card> charged");
  });

  it("scrubs multiple emails in one string", () => {
    expect(scrubPii("from a@x.com to b@y.com")).toBe("from <email> to <email>");
  });

  it("preserves trailing whitespace around scrubbed sequences", () => {
    expect(scrubPii("4242 4242 4242 4242 today")).toBe("<card> today");
  });

  it("returns the original string when nothing matched", () => {
    const input = "no pii here";
    expect(scrubPii(input)).toBe(input);
  });

  it("is regex-safe across consecutive calls (no lastIndex carry-over)", () => {
    scrubPii("a@b.com");
    expect(scrubPii("c@d.com")).toBe("<email>");
  });
});

describe("scrubPiiFromProperties — recursive walk", () => {
  it("scrubs top-level string values", () => {
    expect(
      scrubPiiFromProperties({
        url: "/users/wes@pinet.co.za/profile",
        plan: "pro",
      }),
    ).toEqual({ url: "/users/<email>/profile", plan: "pro" });
  });

  it("scrubs strings inside arrays", () => {
    expect(scrubPiiFromProperties({ emails: ["a@x.com", "b@y.com"] })).toEqual({
      emails: ["<email>", "<email>"],
    });
  });

  it("recurses into nested plain objects (P0 audit pattern)", () => {
    // Pre-Batch-A on web/node, the walk was top-level only. Every
    // captured-error event ships nested `frames[]` / `breadcrumbs[]`
    // / `context{}` / `http{}` through this scrubber. RN bakes the
    // recursive walk from day one.
    const out = scrubPiiFromProperties({
      request: { url: "/users/wes@pinet.co.za/", method: "GET" },
      user: { email: "wes@pinet.co.za" },
    });
    expect((out.request as { url: string }).url).toBe("/users/<email>/");
    expect((out.user as { email: string }).email).toBe("<email>");
  });

  it("recurses into nested arrays of objects", () => {
    const out = scrubPiiFromProperties({
      breadcrumbs: [
        { message: "wes@pinet.co.za signed in" },
        { message: "no pii here" },
      ],
    });
    const crumbs = out.breadcrumbs as Array<{ message: string }>;
    expect(crumbs[0]!.message).toBe("<email> signed in");
    expect(crumbs[1]!.message).toBe("no pii here");
  });

  it("leaves class instances + Date / Map / Error untouched", () => {
    const date = new Date();
    const map = new Map([["k", "wes@pinet.co.za"]]);
    const err = new Error("contact: wes@pinet.co.za");
    const out = scrubPiiFromProperties({ when: date, m: map, err });
    expect(out.when).toBe(date);
    expect(out.m).toBe(map);
    expect(out.err).toBe(err);
    // The Error's own message stays intact — mutating it would
    // corrupt downstream error reporting (we don't own it).
    expect((out.err as Error).message).toBe("contact: wes@pinet.co.za");
  });

  it("does not mutate the caller's input", () => {
    const input = { url: "/users/wes@pinet.co.za/" };
    scrubPiiFromProperties(input);
    expect(input.url).toBe("/users/wes@pinet.co.za/");
  });
});

describe("ConsentManager", () => {
  it("starts with everything granted", () => {
    const c = new ConsentManager();
    expect(c.get()).toEqual({ analytics: true, marketing: true, errors: true });
  });

  it("merges partial state", () => {
    const c = new ConsentManager();
    c.set({ marketing: false });
    expect(c.get()).toEqual({ analytics: true, marketing: false, errors: true });
  });

  it("ignores non-boolean values", () => {
    const c = new ConsentManager();
    c.set({ analytics: "false" as unknown as boolean });
    expect(c.analytics).toBe(true);
  });

  it("can be flipped back on by another set()", () => {
    const c = new ConsentManager();
    c.set({ analytics: false });
    c.set({ analytics: true });
    expect(c.analytics).toBe(true);
  });
});
