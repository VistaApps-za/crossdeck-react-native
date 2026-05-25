import { describe, it, expect } from "vitest";
import { validateEventProperties } from "../src/event-validation";

describe("validateEventProperties — primitives", () => {
  it("passes scalars through", () => {
    const out = validateEventProperties({ n: 42, s: "hi", b: true, z: null });
    expect(out.properties).toEqual({ n: 42, s: "hi", b: true, z: null });
    expect(out.warnings).toEqual([]);
  });

  it("drops functions / symbols / undefined", () => {
    const out = validateEventProperties({
      f: () => {},
      s: Symbol("x"),
      u: undefined,
      kept: 1,
    });
    expect(Object.keys(out.properties)).toEqual(["kept"]);
    expect(out.warnings.map((w) => w.kind).sort()).toEqual([
      "dropped_function",
      "dropped_symbol",
      "dropped_undefined",
    ]);
  });
});

describe("validateEventProperties — coercions", () => {
  it("coerces Date to ISO string", () => {
    const d = new Date("2026-05-24T12:00:00Z");
    const out = validateEventProperties({ when: d });
    expect(out.properties.when).toBe(d.toISOString());
  });

  it("coerces BigInt to string", () => {
    const out = validateEventProperties({ count: BigInt(42) });
    expect(out.properties.count).toBe("42");
  });

  it("coerces Error to { name, message, stack }", () => {
    const err = new Error("boom");
    const out = validateEventProperties({ err });
    expect(out.properties.err).toMatchObject({
      name: "Error",
      message: "boom",
    });
  });
});

describe("validateEventProperties — truncation + safety", () => {
  it("truncates strings over maxStringLength with an ellipsis", () => {
    const long = "x".repeat(2000);
    const out = validateEventProperties({ blob: long }, { maxStringLength: 50 });
    expect((out.properties.blob as string).length).toBe(50);
    expect((out.properties.blob as string).endsWith("…")).toBe(true);
  });

  it("replaces circular object refs with '[circular]'", () => {
    const obj: Record<string, unknown> = { name: "ref" };
    obj.self = obj;
    const out = validateEventProperties({ outer: obj });
    expect((out.properties.outer as { self: unknown }).self).toBe("[circular]");
  });

  it("does NOT flag a legitimate DAG — sibling sharing is fine (audit pattern)", () => {
    // Pre-Batch-E on web, the validator used a shared module-scope
    // WeakSet that added on visit but never removed. Two sibling
    // properties pointing at the SAME sub-object would have the
    // second visit trip the [circular] branch and silently lose
    // data. RN ships the ancestor-only stack (add-on-entry,
    // delete-on-exit) from day one.
    const shared = { email: "wes@pinet.co.za", plan: "pro" };
    const out = validateEventProperties({ owner: shared, member: shared });
    expect(out.properties.owner).toEqual({ email: "wes@pinet.co.za", plan: "pro" });
    expect(out.properties.member).toEqual({ email: "wes@pinet.co.za", plan: "pro" });
    expect(out.warnings.some((w) => w.kind === "circular_reference")).toBe(false);
  });

  it("does NOT flag a legitimate DAG across arrays", () => {
    const shared = { id: 42 };
    const out = validateEventProperties({ team: [shared, shared, { id: 7 }] });
    expect(out.properties.team).toEqual([{ id: 42 }, { id: 42 }, { id: 7 }]);
    expect(out.warnings.some((w) => w.kind === "circular_reference")).toBe(false);
  });

  it("caps deep nesting with '[depth-exceeded]'", () => {
    let leaf: unknown = "deep";
    for (let i = 0; i < 7; i++) leaf = { next: leaf };
    const out = validateEventProperties({ root: leaf });
    expect(JSON.stringify(out.properties)).toContain("[depth-exceeded]");
  });
});
