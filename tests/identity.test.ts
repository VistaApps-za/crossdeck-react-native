import { describe, it, expect } from "vitest";
import { IdentityStore, mintAnonymousId, randomChars } from "../src/identity";
import { MemoryStorage } from "../src/storage";

describe("mintAnonymousId / randomChars", () => {
  it("mints an anon_xxx-shaped id", () => {
    expect(mintAnonymousId()).toMatch(/^anon_[a-z0-9]+$/);
  });

  it("randomChars produces lowercase alphanumeric of the requested length", () => {
    const s = randomChars(16);
    expect(s).toMatch(/^[a-z0-9]{16}$/);
  });

  it("two consecutive mints produce different ids", () => {
    expect(mintAnonymousId()).not.toBe(mintAnonymousId());
  });
});

describe("IdentityStore — hydrate + reads", () => {
  it("mints a fresh anonymousId on first launch + persists it", async () => {
    const storage = new MemoryStorage();
    const id = new IdentityStore(storage, "crossdeck:");
    await id.loadAll();
    const anon = id.anonymousId;
    expect(anon).toMatch(/^anon_/);
    // Persisted — second instance reads the same value back.
    const id2 = new IdentityStore(storage, "crossdeck:");
    await id2.loadAll();
    expect(id2.anonymousId).toBe(anon);
  });

  it("loads cdcust + developerUserId from storage on hydrate", async () => {
    const storage = new MemoryStorage();
    await storage.setItem("crossdeck:cdcust_id", "cdcust_xyz");
    await storage.setItem("crossdeck:developer_user_id", "user_42");
    const id = new IdentityStore(storage, "crossdeck:");
    await id.loadAll();
    expect(id.crossdeckCustomerId).toBe("cdcust_xyz");
    expect(id.developerUserId).toBe("user_42");
  });
});

describe("IdentityStore — mutations", () => {
  it("setCrossdeckCustomerId persists across instances", async () => {
    const storage = new MemoryStorage();
    const id = new IdentityStore(storage, "crossdeck:");
    await id.loadAll();
    id.setCrossdeckCustomerId("cdcust_abc");
    // fire-and-forget — give it a microtask to land.
    await new Promise((r) => setTimeout(r, 0));
    const id2 = new IdentityStore(storage, "crossdeck:");
    await id2.loadAll();
    expect(id2.crossdeckCustomerId).toBe("cdcust_abc");
  });

  it("setDeveloperUserId(null) removes the persisted value", async () => {
    const storage = new MemoryStorage();
    await storage.setItem("crossdeck:developer_user_id", "user_42");
    const id = new IdentityStore(storage, "crossdeck:");
    await id.loadAll();
    expect(id.developerUserId).toBe("user_42");
    id.setDeveloperUserId(null);
    await new Promise((r) => setTimeout(r, 0));
    expect(await storage.getItem("crossdeck:developer_user_id")).toBeNull();
  });

  it("reset() mints a fresh anonymousId + clears cdcust + dev uid", async () => {
    const storage = new MemoryStorage();
    const id = new IdentityStore(storage, "crossdeck:");
    await id.loadAll();
    const before = id.anonymousId;
    id.setCrossdeckCustomerId("cdcust_xyz");
    id.setDeveloperUserId("user_42");

    id.reset();
    expect(id.anonymousId).not.toBe(before);
    expect(id.crossdeckCustomerId).toBeNull();
    expect(id.developerUserId).toBeNull();
  });
});

describe("IdentityStore — guard", () => {
  it("throws on reads before loadAll()", () => {
    const storage = new MemoryStorage();
    const id = new IdentityStore(storage, "crossdeck:");
    expect(() => id.anonymousId).toThrow(/loadAll/);
  });
});
