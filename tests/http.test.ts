import { describe, it, expect } from "vitest";
import { extractSelfHostname, isSelfRequest } from "../src/http";

describe("extractSelfHostname (audit P0 #7)", () => {
  it("returns the lowercased hostname from a https URL", () => {
    expect(extractSelfHostname("https://api.cross-deck.com/v1")).toBe("api.cross-deck.com");
  });

  it("lowercases mixed-case hostnames", () => {
    expect(extractSelfHostname("https://API.Cross-Deck.COM/v1")).toBe("api.cross-deck.com");
  });

  it("works with custom regional / self-hosted base URLs", () => {
    expect(extractSelfHostname("https://crossdeck-eu.customer.example/v1")).toBe(
      "crossdeck-eu.customer.example",
    );
  });

  it("returns null on malformed input", () => {
    expect(extractSelfHostname("not-a-url")).toBeNull();
    expect(extractSelfHostname("")).toBeNull();
    expect(extractSelfHostname(undefined)).toBeNull();
    expect(extractSelfHostname(null)).toBeNull();
  });
});

describe("isSelfRequest (audit P0 #7)", () => {
  it("returns true when the request hostname matches", () => {
    expect(isSelfRequest("https://api.cross-deck.com/v1/events", "api.cross-deck.com")).toBe(true);
  });

  it("returns true on a custom baseUrl-derived hostname (regional / staging / self-hosted)", () => {
    expect(
      isSelfRequest(
        "https://crossdeck-eu.customer.example/v1/events",
        "crossdeck-eu.customer.example",
      ),
    ).toBe(true);
  });

  it("is case-insensitive on the request hostname", () => {
    expect(isSelfRequest("https://API.Cross-Deck.COM/v1/events", "api.cross-deck.com")).toBe(true);
  });

  it("is hostname-STRICT — substring matches do NOT count", () => {
    // Pre-fix `url.includes("api.cross-deck.com")` falsely matched
    // `https://api.cross-deck.com.attacker.example/...`. New impl
    // parses URL + compares hostname strictly.
    expect(
      isSelfRequest("https://api.cross-deck.com.attacker.example/v1/events", "api.cross-deck.com"),
    ).toBe(false);
    expect(isSelfRequest("https://evil-api.cross-deck.com/x", "api.cross-deck.com")).toBe(false);
  });

  it("returns false on a non-matching hostname", () => {
    expect(isSelfRequest("https://example.com/v1/events", "api.cross-deck.com")).toBe(false);
  });

  it("returns false when selfHostname is null / undefined (safe fall-through)", () => {
    expect(isSelfRequest("https://api.cross-deck.com/v1/events", null)).toBe(false);
    expect(isSelfRequest("https://api.cross-deck.com/v1/events", undefined)).toBe(false);
  });

  it("returns false on a malformed request URL (SDK only ever uses absolute URLs)", () => {
    expect(isSelfRequest("not-a-url", "api.cross-deck.com")).toBe(false);
    expect(isSelfRequest("/relative/path", "api.cross-deck.com")).toBe(false);
  });
});
