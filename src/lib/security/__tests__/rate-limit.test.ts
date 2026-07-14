import { afterEach, describe, expect, it, vi } from "vitest";

import {
  getRateLimitPolicy,
  hashRateLimitIdentity,
  PostgresRateLimitStore,
  rateLimitIp,
  sameRateLimitHash,
  type ConsumeInput,
  type ConsumeResult,
  type RateLimitPolicy,
  type RateLimitStore,
  withRateLimit,
} from "../rate-limit";

const SECRET = "a-test-only-rate-limit-secret-with-at-least-32-bytes";

class MemoryStore implements RateLimitStore {
  readonly values = new Map<string, number>();
  readonly observed: ConsumeInput[] = [];

  async consume(input: ConsumeInput): Promise<ConsumeResult> {
    this.observed.push(input);
    const windowMs = input.windowSeconds * 1_000;
    const start = Math.floor(input.now.getTime() / windowMs) * windowMs;
    const key = `${input.scope}:${input.keyHash}:${start}`;
    const count = Math.min((this.values.get(key) ?? 0) + 1, input.limit + 1);
    this.values.set(key, count);
    return { count, resetAt: new Date(start + windowMs) };
  }
}

function testPolicy(
  limit: number,
  windowSeconds = 60,
  failureMode: "closed" | "open" = "closed",
): RateLimitPolicy {
  return { name: "code_run_minute", limit, windowSeconds, failureMode };
}

afterEach(() => {
  delete process.env.RATE_LIMIT_OVERRIDES_JSON;
  delete process.env.RATE_LIMIT_TRUSTED_IP_HEADER;
  vi.restoreAllMocks();
});

describe("rate-limit decisions", () => {
  it("allows exactly the configured boundary and then returns a complete 429 response", async () => {
    const store = new MemoryStore();
    const now = () => new Date("2026-07-12T00:00:10.000Z");
    let calls = 0;
    const invoke = () => withRateLimit(
      { policy: testPolicy(3), identity: { kind: "user", value: "user-1" } },
      async () => {
        calls += 1;
        return new Response("ok", { status: 200 });
      },
      { store, now, secret: SECRET },
    );

    expect((await invoke()).status).toBe(200);
    expect((await invoke()).headers.get("RateLimit-Remaining")).toBe("1");
    const lastAllowed = await invoke();
    expect(lastAllowed.status).toBe(200);
    expect(lastAllowed.headers.get("RateLimit-Remaining")).toBe("0");
    const blocked = await invoke();
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("Retry-After")).toBe("50");
    expect(blocked.headers.get("RateLimit-Limit")).toBe("3");
    expect(blocked.headers.get("RateLimit-Remaining")).toBe("0");
    expect(blocked.headers.get("RateLimit-Policy")).toBe("3;w=60");
    expect(blocked.headers.get("X-RateLimit-Reset")).toBe("1783814460");
    expect(await blocked.json()).toMatchObject({ code: "RATE_LIMITED" });
    expect(calls).toBe(3);
  });

  it("resets at the exact fixed-window boundary", async () => {
    const store = new MemoryStore();
    let nowMs = Date.parse("2026-07-12T00:00:59.999Z");
    const invoke = () => withRateLimit(
      { policy: testPolicy(1), identity: { kind: "user", value: "boundary-user" } },
      async () => new Response("ok"),
      { store, now: () => new Date(nowMs), secret: SECRET },
    );
    expect((await invoke()).status).toBe(200);
    expect((await invoke()).status).toBe(429);
    nowMs += 1;
    const nextWindow = await invoke();
    expect(nextWindow.status).toBe(200);
    expect(nextWindow.headers.get("RateLimit-Reset")).toBe("60");
  });

  it("enforces the limit under concurrent calls", async () => {
    const store = new MemoryStore();
    let completed = 0;
    const results = await Promise.all(
      Array.from({ length: 50 }, () => withRateLimit(
        { policy: testPolicy(7), identity: { kind: "user", value: "same-user" } },
        async () => {
          completed += 1;
          return new Response("ok");
        },
        { store, now: () => new Date(0), secret: SECRET },
      )),
    );
    expect(results.filter((response) => response.status === 200)).toHaveLength(7);
    expect(results.filter((response) => response.status === 429)).toHaveLength(43);
    expect(completed).toBe(7);
  });

  it("isolates users and scopes while normalizing email case", () => {
    const first = hashRateLimitIdentity("access_request_email", "email", " Buddy@Example.com ", SECRET);
    const normalized = hashRateLimitIdentity("access_request_email", "email", "buddy@example.com", SECRET);
    const otherUser = hashRateLimitIdentity("access_request_email", "email", "other@example.com", SECRET);
    const otherScope = hashRateLimitIdentity("access_request_ip", "email", "buddy@example.com", SECRET);
    expect(sameRateLimitHash(first, normalized)).toBe(true);
    expect(first).not.toBe(otherUser);
    expect(first).not.toBe(otherScope);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
  });

  it("never passes the raw identity to persistence", async () => {
    const store = new MemoryStore();
    const raw = "private.user@example.com";
    await withRateLimit(
      { policy: testPolicy(2), identity: { kind: "email", value: raw } },
      async () => new Response("ok"),
      { store, now: () => new Date(0), secret: SECRET },
    );
    expect(store.observed).toHaveLength(1);
    expect(JSON.stringify(store.observed[0])).not.toContain(raw);
    expect(store.observed[0].keyHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("fails closed without running expensive work when persistence fails", async () => {
    const store: RateLimitStore = { consume: vi.fn().mockRejectedValue(new Error("database unavailable")) };
    const handler = vi.fn(async () => new Response("should not run"));
    const response = await withRateLimit(
      { policy: testPolicy(2, 60, "closed"), identity: { kind: "user", value: "user" } },
      handler,
      { store, now: () => new Date(0), secret: SECRET },
    );
    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("30");
    expect(await response.json()).toMatchObject({ code: "RATE_LIMIT_UNAVAILABLE" });
    expect(handler).not.toHaveBeenCalled();
  });

  it("supports an explicit fail-open policy for non-critical future endpoints", async () => {
    const store: RateLimitStore = { consume: vi.fn().mockRejectedValue(new Error("database unavailable")) };
    const response = await withRateLimit(
      { policy: testPolicy(2, 60, "open"), identity: { kind: "user", value: "user" } },
      async () => new Response("ok", { status: 201 }),
      { store, now: () => new Date(0), secret: SECRET },
    );
    expect(response.status).toBe(201);
  });

  it("does not run a later window or handler after an earlier check blocks", async () => {
    const store = new MemoryStore();
    const checks = [
      { policy: testPolicy(1), identity: { kind: "user" as const, value: "user" } },
      { policy: { ...testPolicy(10), name: "code_run_hour" as const }, identity: { kind: "user" as const, value: "user" } },
    ];
    await withRateLimit(checks, async () => new Response("ok"), { store, now: () => new Date(0), secret: SECRET });
    const blocked = await withRateLimit(checks, async () => new Response("bad"), { store, now: () => new Date(0), secret: SECRET });
    expect(blocked.status).toBe(429);
    expect(store.observed.filter((item) => item.scope === "code_run_hour")).toHaveLength(1);
  });
});

describe("configuration and proxy identities", () => {
  it("accepts bounded known-policy overrides", () => {
    process.env.RATE_LIMIT_OVERRIDES_JSON = JSON.stringify({ ai_tutor_minute: { limit: 8, windowSeconds: 120 } });
    expect(getRateLimitPolicy("ai_tutor_minute")).toMatchObject({ limit: 8, windowSeconds: 120 });
  });

  it("rejects unknown or unsafe overrides", () => {
    process.env.RATE_LIMIT_OVERRIDES_JSON = JSON.stringify({ made_up: { limit: 1 } });
    expect(() => getRateLimitPolicy("ai_tutor_minute")).toThrow(/Unknown/);
    process.env.RATE_LIMIT_OVERRIDES_JSON = JSON.stringify({ ai_tutor_minute: { limit: 0 } });
    expect(() => getRateLimitPolicy("ai_tutor_minute")).toThrow(/Invalid/);
  });

  it("fails a wrapped request closed when policy configuration is malformed", async () => {
    process.env.RATE_LIMIT_OVERRIDES_JSON = "not-json";
    const handler = vi.fn(async () => new Response("unsafe"));
    const response = await withRateLimit(
      { policy: "ai_tutor_minute", identity: { kind: "user", value: "user" } },
      handler,
      { store: new MemoryStore(), secret: SECRET },
    );
    expect(response.status).toBe(503);
    expect(handler).not.toHaveBeenCalled();
  });

  it("uses only a valid explicitly trusted address header", () => {
    process.env.RATE_LIMIT_TRUSTED_IP_HEADER = "cf-connecting-ip";
    expect(rateLimitIp(new Request("https://app.test", { headers: { "cf-connecting-ip": "203.0.113.9", "x-forwarded-for": "198.51.100.2" } }))).toBe("203.0.113.9");
    expect(rateLimitIp(new Request("https://app.test", { headers: { "cf-connecting-ip": "spoofed", "x-forwarded-for": "203.0.113.4" } }))).toBe("unavailable");
    expect(rateLimitIp(new Request("https://app.test", { headers: { "x-forwarded-for": "203.0.113.4" } }))).toBe("unavailable");
    process.env.RATE_LIMIT_TRUSTED_IP_HEADER = "invalid header";
    expect(rateLimitIp(new Request("https://app.test"))).toBe("unavailable");
  });
});

describe("PostgresRateLimitStore", () => {
  it("uses an atomic upsert and bounded cleanup", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ request_count: 2 }] })
      .mockResolvedValueOnce({ rows: [] });
    const store = new PostgresRateLimitStore({ query });
    const result = await store.consume({
      scope: "code_run_minute",
      keyHash: "a".repeat(64),
      limit: 10,
      windowSeconds: 60,
      now: new Date("2026-07-12T00:00:10Z"),
    });
    expect(result).toEqual({ count: 2, resetAt: new Date("2026-07-12T00:01:00Z") });
    expect(query.mock.calls[0][0]).toContain("ON CONFLICT (scope, key_hash, window_start)");
    expect(query.mock.calls[0][0]).toContain("LEAST(api_rate_limit_window.request_count + 1, $5)");
    expect(query.mock.calls[0][1]).toEqual(expect.arrayContaining(["code_run_minute", "a".repeat(64), 11]));
    expect(query.mock.calls[1][0]).toContain("LIMIT $2");
    expect(query.mock.calls[1][1][1]).toBe(500);
  });

  it("keeps enforcement valid when opportunistic cleanup fails", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ request_count: 1 }] })
      .mockRejectedValueOnce(new Error("cleanup unavailable"));
    const store = new PostgresRateLimitStore({ query });
    await expect(store.consume({
      scope: "ai_tutor_minute",
      keyHash: "b".repeat(64),
      limit: 20,
      windowSeconds: 60,
      now: new Date("2026-07-12T00:00:10Z"),
    })).resolves.toMatchObject({ count: 1 });
    expect(console.warn).toHaveBeenCalledWith("rate_limit_cleanup_failed");
  });

  it("rejects malformed database results", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const store = new PostgresRateLimitStore({ query }, Number.POSITIVE_INFINITY);
    await expect(store.consume({
      scope: "exam_run_user",
      keyHash: "c".repeat(64),
      limit: 20,
      windowSeconds: 60,
      now: new Date(0),
    })).rejects.toThrow(/valid value/);
  });
});
