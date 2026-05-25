import { describe, it, expect } from "vitest";
import {
  CrossdeckError,
  crossdeckErrorFromResponse,
  parseRetryAfterHeader,
} from "../src/errors";

describe("CrossdeckError", () => {
  it("constructs with type / code / message / status / retryAfterMs", () => {
    const e = new CrossdeckError({
      type: "authentication_error",
      code: "invalid_api_key",
      message: "Bad key",
      status: 401,
      requestId: "req_abc",
      retryAfterMs: 1500,
    });
    expect(e.name).toBe("CrossdeckError");
    expect(e.type).toBe("authentication_error");
    expect(e.code).toBe("invalid_api_key");
    expect(e.message).toBe("Bad key");
    expect(e.status).toBe(401);
    expect(e.requestId).toBe("req_abc");
    expect(e.retryAfterMs).toBe(1500);
    expect(e).toBeInstanceOf(Error);
    expect(e).toBeInstanceOf(CrossdeckError);
  });
});

describe("crossdeckErrorFromResponse", () => {
  function res(status: number, body: unknown, headers: Record<string, string> = {}): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json", ...headers },
    });
  }

  it("parses the Stripe-style envelope", async () => {
    const e = await crossdeckErrorFromResponse(
      res(401, {
        error: {
          type: "authentication_error",
          code: "invalid_api_key",
          message: "Bad key",
          request_id: "req_xyz",
        },
      }),
    );
    expect(e.type).toBe("authentication_error");
    expect(e.code).toBe("invalid_api_key");
    expect(e.requestId).toBe("req_xyz");
    expect(e.status).toBe(401);
  });

  it("falls back to a generic shape when the body isn't envelope-shaped", async () => {
    const e = await crossdeckErrorFromResponse(res(500, { something: "else" }));
    expect(e.type).toBe("internal_error");
    expect(e.code).toBe("http_500");
    expect(e.status).toBe(500);
  });

  it("picks the right error type from status when no envelope", async () => {
    expect((await crossdeckErrorFromResponse(res(401, {}))).type).toBe("authentication_error");
    expect((await crossdeckErrorFromResponse(res(403, {}))).type).toBe("permission_error");
    expect((await crossdeckErrorFromResponse(res(429, {}))).type).toBe("rate_limit_error");
    expect((await crossdeckErrorFromResponse(res(400, {}))).type).toBe("invalid_request_error");
  });

  it("reads Retry-After header (delta-seconds form)", async () => {
    const e = await crossdeckErrorFromResponse(res(429, {}, { "Retry-After": "3" }));
    expect(e.retryAfterMs).toBe(3000);
  });
});

describe("parseRetryAfterHeader", () => {
  it("parses delta-seconds form", () => {
    expect(parseRetryAfterHeader("120")).toBe(120_000);
    expect(parseRetryAfterHeader("0.5")).toBe(500);
  });

  it("parses HTTP-date form (future)", () => {
    const future = new Date(Date.now() + 5000).toUTCString();
    const ms = parseRetryAfterHeader(future);
    expect(ms).toBeGreaterThan(3000);
    expect(ms).toBeLessThan(7000);
  });

  it("returns 0 for HTTP-date in the past", () => {
    const past = new Date(Date.now() - 10000).toUTCString();
    expect(parseRetryAfterHeader(past)).toBe(0);
  });

  it("returns undefined on garbage", () => {
    expect(parseRetryAfterHeader(null)).toBeUndefined();
    expect(parseRetryAfterHeader("")).toBeUndefined();
    expect(parseRetryAfterHeader("not-a-thing")).toBeUndefined();
    expect(parseRetryAfterHeader("-5")).toBeUndefined();
  });
});
