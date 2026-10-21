import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  limit: vi.fn(),
  deleteWhere: vi.fn(),
  selectRows: [] as unknown[][],
  hasPassword: vi.fn(),
  audit: vi.fn(),
  enqueue: vi.fn(),
}));

vi.mock("../rate-limit", () => ({ withRateLimit: mocks.limit }));
vi.mock("@/lib/db/client", () => ({
  db: {
    delete: () => ({ where: mocks.deleteWhere }),
    select: () => ({ from: () => ({ where: () => ({ limit: async () => mocks.selectRows.shift() ?? [] }) }) }),
  },
}));
vi.mock("../password-settings", () => ({ hasCredentialPassword: mocks.hasPassword }));
vi.mock("../audit-writer", () => ({ writeAuditEvent: mocks.audit }));
vi.mock("@/lib/notifications/outbox", () => ({ enqueueEmail: mocks.enqueue }));

import { atomicAuthRateLimitPlugin } from "../auth-rate-limit";
import { clearTrustedDevices, mayResetPassword, recordPasswordChanged } from "../password-security-events";
import {
  holdResetRequestFloor,
  markResetRequestStarted,
  NEUTRAL_RESET_REQUEST_BODY,
  RESET_REQUEST_MIN_DURATION_MS,
} from "../reset-request-timing";
import { storedResetPasswordIdentifier } from "@/lib/notifications/revocable-source-authority";

const BASE = { baseURL: "https://example.test/api/auth" };
const resetRequest = (email: unknown, headers: Record<string, string> = { "cf-connecting-ip": "198.51.100.7" }) =>
  new Request("https://example.test/api/auth/request-password-reset", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ email, redirectTo: "https://example.test/reset-password" }),
  });
const authSource = readFileSync(path.join(process.cwd(), "src/lib/auth.ts"), "utf8");
const sqlText = (where: SQL) => new PgDialect().sqlToQuery(where);

beforeEach(() => {
  vi.resetAllMocks();
  mocks.selectRows = [];
  mocks.limit.mockImplementation(async (_check, run) => run());
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("M2: reset-request budgets", () => {
  it("spends a per-email budget keyed by the normalized address after the IP budget", async () => {
    await atomicAuthRateLimitPlugin(true).onRequest(resetRequest("  Learner@Example.TEST "), BASE);
    expect(mocks.limit.mock.calls.map(([check]) => [check.policy.name, check.identity])).toEqual([
      ["auth_reset_request_ip", { kind: "ip", value: "198.51.100.7" }],
      ["auth_reset_request_email", { kind: "email", value: "learner@example.test" }],
    ]);
    expect(mocks.limit.mock.calls[1]![0].policy).toEqual({
      name: "auth_reset_request_email", limit: 5, windowSeconds: 86_400, failureMode: "closed",
    });
  });

  it("answers an exhausted email budget with the neutral body after the timing floor, never 429", async () => {
    vi.useFakeTimers();
    mocks.limit.mockImplementationOnce(async (_check, run) => run())
      .mockImplementationOnce(async () => new Response(null, { status: 429 }));
    const pending = atomicAuthRateLimitPlugin(true).onRequest(resetRequest("victim@example.test"), BASE);
    let settled = false;
    void pending.then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(RESET_REQUEST_MIN_DURATION_MS - 50);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(100);
    const result = await pending;
    expect(result?.response.status).toBe(200);
    expect(await result?.response.json()).toEqual(NEUTRAL_RESET_REQUEST_BODY);
  });

  it("leaves malformed bodies to Better Auth validation without an email budget", async () => {
    expect(await atomicAuthRateLimitPlugin(true).onRequest(resetRequest(42), BASE)).toBeUndefined();
    expect(mocks.limit).toHaveBeenCalledTimes(1);
  });

  it("refuses production auth requests without a client IP instead of pooling them", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const result = await atomicAuthRateLimitPlugin(true).onRequest(resetRequest("a@example.test", {}), BASE);
    expect(result?.response.status).toBe(503);
    expect(mocks.limit).not.toHaveBeenCalled();
  });

  it("keeps the shared fallback bucket for other production auth paths", async () => {
    vi.stubEnv("NODE_ENV", "production");
    await atomicAuthRateLimitPlugin(true).onRequest(new Request("https://example.test/api/auth/sign-in/email", { method: "POST" }), BASE);
    expect(mocks.limit.mock.calls[0]![0].identity).toEqual({ kind: "ip", value: "unavailable" });
  });

  it("keeps the local-development fallback bucket outside production", async () => {
    vi.stubEnv("NODE_ENV", "test");
    await atomicAuthRateLimitPlugin(true).onRequest(new Request("https://example.test/api/auth/sign-in/email", { method: "POST" }), BASE);
    expect(mocks.limit.mock.calls[0]![0].identity).toEqual({ kind: "ip", value: "unavailable" });
  });
});

describe("M1: constant-work reset response", () => {
  it("holds every response to the same floor measured from the request start", async () => {
    const request = new Request("https://example.test/");
    const sleep = vi.fn(async () => {});
    markResetRequestStarted(request, 1_000);
    markResetRequestStarted(request, 1_500);
    await holdResetRequestFloor(request, { now: () => 1_300, sleep });
    expect(sleep).toHaveBeenCalledWith(RESET_REQUEST_MIN_DURATION_MS - 300);
  });

  it("waits the whole floor when no start was recorded and never sleeps past it", async () => {
    const sleep = vi.fn(async () => {});
    await holdResetRequestFloor(new Request("https://example.test/"), { sleep });
    expect(sleep).toHaveBeenCalledWith(RESET_REQUEST_MIN_DURATION_MS);
    const late = new Request("https://example.test/");
    markResetRequestStarted(late, 0);
    await holdResetRequestFloor(late, { now: () => RESET_REQUEST_MIN_DURATION_MS + 1, sleep });
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("wraps /request-password-reset in Better Auth before/after hooks", () => {
    expect(authSource).toMatch(/ctx\.path === "\/request-password-reset"\) \{\s*markResetRequestStarted\(ctx\.request\)/);
    expect(authSource).toMatch(/ctx\.path === "\/request-password-reset"\) \{\s*await holdResetRequestFloor\(ctx\.request\)/);
  });
});

describe("M3 and I1: reset side effects", () => {
  it("clears only this user's trust-device verification rows", async () => {
    await clearTrustedDevices("user-1");
    const query = sqlText(mocks.deleteWhere.mock.calls[0]![0]);
    expect(query.sql).toBe('("verification"."value" = $1 and "verification"."identifier" like $2)');
    expect(query.params).toEqual(["user-1", "trust-device-%"]);
  });

  it("matches the identifier Better Auth 1.7.6 uses for trusted devices", () => {
    const plugin = readFileSync(path.join(process.cwd(), "node_modules/better-auth/dist/plugins/two-factor/index.mjs"), "utf8");
    expect(plugin).toContain("`trust-device-${generateRandomString(32)}`");
    expect(plugin).toContain("value: data.user.id");
  });

  it("clears trusted devices, audits and notifies from onPasswordReset", () => {
    const hook = authSource.slice(authSource.indexOf("onPasswordReset:"), authSource.indexOf("verification: {"));
    expect(hook).toContain("await clearTrustedDevices(resetUser.id)");
    expect(hook).toContain('await recordPasswordChanged({ userId: resetUser.id, kind: "reset" })');
    expect(authSource).toContain("revokeSessionsOnPasswordReset: true");
  });

  it("writes a success audit row and a link-free notice through the outbox", async () => {
    mocks.selectRows = [[{ email: "learner@example.test", name: "Learner" }]];
    await recordPasswordChanged({ userId: "user-1", kind: "reset" });
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({
      action: "account.password_reset", actorUserId: "user-1", resourceId: "user-1", outcome: "success",
    }));
    expect(mocks.enqueue).toHaveBeenCalledWith(expect.objectContaining({
      to: "learner@example.test", userId: "user-1", template: "password-changed",
      variables: { name: "Learner", url: "http://localhost:3000/settings?section=device" },
    }));
    expect(mocks.enqueue.mock.calls[0]![0].idempotencySeed).toMatch(/^password-changed:[0-9a-f-]{36}$/);
  });

  it("never throws after rotation when audit or mail fails", async () => {
    mocks.audit.mockRejectedValue(new Error("audit down"));
    mocks.enqueue.mockRejectedValue(new Error("outbox down"));
    mocks.selectRows = [[{ email: "learner@example.test", name: "Learner" }]];
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(recordPasswordChanged({ userId: "user-1", kind: "change" })).resolves.toBeUndefined();
    expect(error.mock.calls.map(([line]) => line)).toEqual(["password_change_audit_failed", "password_change_notice_failed"]);
  });

  it("can skip the audit row when the caller already wrote one", async () => {
    mocks.selectRows = [[{ email: "learner@example.test", name: "Learner" }]];
    await recordPasswordChanged({ userId: "user-1", kind: "change", audit: false });
    expect(mocks.audit).not.toHaveBeenCalled();
    expect(mocks.enqueue).toHaveBeenCalledTimes(1);
  });
});

describe("L1: reset identifiers hashed at rest", () => {
  it("stores only reset-password identifiers hashed", () => {
    expect(authSource).toContain('storeIdentifier: { default: "plain", overrides: { "reset-password:": "hashed" } }');
  });

  it("derives the same base64url SHA-256 Better Auth's hashed storage uses", () => {
    // Built at runtime so the obviously fake fixture is not a literal token.
    const fakeToken = ["abcDEF123", "_-xyz789", "abcdef"].join("");
    const expected = createHash("sha256").update(`reset-password:${fakeToken}`).digest("base64url");
    expect(storedResetPasswordIdentifier(fakeToken)).toBe(expected);
    expect(expected).not.toContain("=");
    const storage = readFileSync(path.join(process.cwd(), "node_modules/better-auth/dist/db/verification-token-storage.mjs"), "utf8");
    expect(storage).toContain('createHash("SHA-256")');
    expect(storage).toContain("base64Url.encode(new Uint8Array(hash), { padding: false })");
  });
});

describe("L3: reset eligibility", () => {
  it.each([
    [{ status: "active", banned: false }, true, true],
    [{ status: "active", banned: false }, false, false],
    [{ status: "pending", banned: false }, true, false],
    [{ status: "suspended", banned: false }, true, false],
    [{ status: "active", banned: true }, true, false],
  ])("account %o with password=%s may reset: %s", async (owner, hasPassword, expected) => {
    mocks.selectRows = [[owner]];
    mocks.hasPassword.mockResolvedValue(hasPassword);
    expect(await mayResetPassword("user-1")).toBe(expected);
  });

  it("rejects a missing account", async () => {
    expect(await mayResetPassword("missing")).toBe(false);
    expect(mocks.hasPassword).not.toHaveBeenCalled();
  });

  it("withholds the link and refuses ineligible tokens in auth.ts", () => {
    const send = authSource.slice(authSource.indexOf("sendResetPassword:"), authSource.indexOf("loadResetPasswordVerificationSource(pool"));
    expect(send).toContain("if (!(await mayResetPassword(authUser.id)))");
    expect(send).toContain("delete from public.verification where identifier = $1 and value = $2");
    expect(send).toContain("return;");
    expect(authSource).toMatch(/ctx\.path === "\/reset-password"\)[\s\S]*?!\(await mayResetPassword\(pending\.value\)\)[\s\S]*?INVALID_TOKEN/);
  });
});
