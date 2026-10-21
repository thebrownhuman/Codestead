import { PgDialect } from "drizzle-orm/pg-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  process.env.BETTER_AUTH_SECRET ??= "coverage-test-secret-with-at-least-32-bytes";
  return { limit: vi.fn(), select: vi.fn(), update: vi.fn(), insert: vi.fn(), transaction: vi.fn(), enqueue: vi.fn(), activation: vi.fn(), bootstrap: vi.fn(), archive: vi.fn(), resetSource: vi.fn(), poolQuery: vi.fn(), mayReset: vi.fn(), resetVariables: vi.fn(), requireVariables: vi.fn(), options: undefined as unknown };
});
vi.mock("better-auth", () => ({ betterAuth: (options: unknown) => { mocks.options = options; return { options }; } }));
vi.mock("better-auth/api", async (original) => ({ ...await original<typeof import("better-auth/api")>(), createAuthMiddleware: (handler: unknown) => handler }));
vi.mock("better-auth/adapters/drizzle", () => ({ drizzleAdapter: () => ({}) }));
vi.mock("better-auth/next-js", () => ({ nextCookies: () => ({}) }));
vi.mock("better-auth/plugins", () => ({ admin: () => ({}), twoFactor: () => ({}) }));
vi.mock("@/lib/db/client", () => ({ db: mocks, pool: { query: mocks.poolQuery } }));
vi.mock("@/lib/security/password-security-events", () => ({ mayResetPassword: mocks.mayReset, clearTrustedDevices: vi.fn(), recordPasswordChanged: vi.fn() }));
vi.mock("@/lib/security/rate-limit", async (original) => ({ ...await original<typeof import("@/lib/security/rate-limit")>(), withRateLimit: mocks.limit }));
vi.mock("@/lib/notifications/outbox", () => ({ enqueueEmail: mocks.enqueue }));
vi.mock("@/lib/security/activation-context", () => ({ currentActivationAuthorization: mocks.activation, currentBootstrapAuthorization: mocks.bootstrap }));
vi.mock("@/lib/session-controls", () => ({ archiveDeletedSession: mocks.archive, archiveExpiredSessions: vi.fn(), boundedUserAgent: (value: string) => value.slice(0, 200), describeUserAgent: () => "Firefox on Linux" }));
vi.mock("@/lib/notifications/revocable-source-authority", async (original) => ({ ...await original<typeof import("@/lib/notifications/revocable-source-authority")>(), loadResetPasswordVerificationSource: mocks.resetSource, createResetPasswordSourceVariables: mocks.resetVariables, requireRevocableSourceVariables: mocks.requireVariables }));
import "@/lib/auth";

type Hook = (...args: unknown[]) => Promise<unknown>;
const options = () => mocks.options as {
  emailAndPassword: { sendResetPassword: Hook }; emailVerification: { sendVerificationEmail: Hook };
  databaseHooks: { user: { create: { before: Hook; after: Hook } }; session: { create: { after: Hook }; delete: { before: Hook } } };
};
const now = new Date("2026-10-01T12:00:00Z");
const activation = { email: "learner@example.test", consumedAt: now.toISOString(), invitationId: "invite-1" };
const session = { id: "session-1", userId: "owner", userAgent: "Firefox", createdAt: now, updatedAt: now, expiresAt: new Date(now.getTime() + 60000) };
const write = { set: vi.fn(), where: vi.fn(), values: vi.fn(), onConflictDoNothing: vi.fn() };
const select = { from: vi.fn(), where: vi.fn(), limit: vi.fn() };

beforeEach(async () => {
  vi.stubEnv("DATABASE_URL", "postgresql://app:password@localhost/codestead");
  vi.resetModules();
  await import("@/lib/auth");
  vi.resetAllMocks();
  for (const method of [write.set, write.values, select.from, select.where]) method.mockReturnValue(method === select.from || method === select.where ? select : write);
  select.limit.mockResolvedValue([]); mocks.select.mockReturnValue(select); mocks.update.mockReturnValue(write); mocks.insert.mockReturnValue(write);
  mocks.transaction.mockImplementation(async (callback) => callback(mocks));
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("authentication account and session lifecycle", () => {
  it.each([
    ["development", undefined, "memory"],
    ["test", "", "memory"],
    ["development", "   ", "memory"],
    ["development", "postgresql://app:password@localhost/codestead", "database"],
    ["test", "postgresql://app:password@localhost/codestead", "database"],
    ["production", "postgresql://app:password@localhost/codestead", "database"],
    ["production", undefined, "database"],
    ["production", "", "database"],
    ["production", "   ", "database"],
  ])("requires %s atomic admission with DATABASE_URL=%s when storage is %s", async (environment, databaseUrl, storage) => {
    vi.stubEnv("NODE_ENV", environment);
    vi.stubEnv("DATABASE_URL", databaseUrl);
    vi.stubEnv("AUTH_REQUIRED", "false");
    vi.resetModules();
    const { auth } = await import("@/lib/auth");
    expect(auth.options.rateLimit?.storage).toBe("memory");
    mocks.limit.mockImplementation(async (_check, admitted) => admitted());
    const plugin = auth.options.plugins?.find(plugin => plugin.id === "atomic-auth-rate-limit") as {
      onRequest(request: Request, context: { baseURL: string }): Promise<unknown>;
    };
    expect(plugin).toBeDefined();
    await plugin.onRequest(new Request("http://localhost:3000/api/auth/sign-in/email", { headers: { "cf-connecting-ip": "198.51.100.9" } }), { baseURL: "http://localhost:3000/api/auth" });
    expect(mocks.limit).toHaveBeenCalledTimes(storage === "database" ? 1 : 0);
    if (storage === "database") expect(mocks.limit.mock.calls[0][0].policy.failureMode).toBe("closed");
  });
  it("delegates sensitive budgets to atomic admission instead of the secondary memory limiter", () => {
    const configured = mocks.options as { rateLimit: { customRules: Record<string, unknown> } };
    expect(configured.rateLimit.customRules).toEqual({
      "/sign-in/email": false, "/sign-up/email": false, "/two-factor/verify-totp": false,
    });
  });
  it("resolves auth IP budgets only from the trusted Cloudflare header", () => {
    const configured = mocks.options as { advanced: { ipAddress?: { ipAddressHeaders?: string[] } } };
    expect(configured.advanced.ipAddress?.ipAddressHeaders).toEqual(["cf-connecting-ip"]);
  });
  it("preserves every database-free auth custom budget and window", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("DATABASE_URL", undefined);
    vi.resetModules();
    await import("@/lib/auth");
    const configured = mocks.options as { rateLimit: unknown };
    expect(configured.rateLimit).toMatchObject({
      enabled: true, window: 60, max: 100,
      customRules: {
        "/sign-in/email": { window: 60, max: 8 },
        "/sign-up/email": { window: 600, max: 3 },
        "/two-factor/verify-totp": { window: 60, max: 6 },
      },
    });
  });
  it.each([undefined, { ...activation, email: "another@example.test" }])("refuses account creation without matching activation authority", async (authority) => {
    mocks.activation.mockReturnValue(authority);
    expect(await options().databaseHooks.user.create.before({ email: "LEARNER@example.test" })).toBe(false);
    expect(mocks.select).not.toHaveBeenCalled();
  });
  it("binds creation to the consumed invitation and refuses a missing invitation", async () => {
    mocks.activation.mockReturnValue(activation);
    const hook = options().databaseHooks.user.create.before;
    expect(await hook({ email: "LEARNER@example.test" })).toBe(false);
    select.limit.mockResolvedValue([{ id: "invite-1" }]);
    expect(await hook({ email: "LEARNER@example.test" })).toEqual({ data: { mustChangePassword: false } });
    const filter = new PgDialect().sqlToQuery(select.where.mock.calls[1][0]);
    expect(filter.params).toEqual(["invite-1", activation.email, now.toISOString(), now.toISOString()]);
    expect(filter.sql).toContain('"expires_at" >');
  });
  it("requires scoped bootstrap authorization even for the configured administrator address", async () => {
    vi.stubEnv("BOOTSTRAP_ADMIN_EMAIL", "ADMIN@example.test");
    mocks.bootstrap.mockReturnValue(null);
    expect(await options().databaseHooks.user.create.before({ email: "admin@example.test" })).toBe(false);
    mocks.bootstrap.mockReturnValue("admin@example.test");
    expect(await options().databaseHooks.user.create.before({ email: "ADMIN@example.test" })).toBeUndefined();
    expect(mocks.activation).not.toHaveBeenCalled();
  });
  it("creates the learner profile idempotently in a transaction", async () => {
    await options().databaseHooks.user.create.after({ id: "owner" });
    expect(mocks.transaction).toHaveBeenCalledTimes(1);
    expect(write.values).toHaveBeenCalledWith({ userId: "owner" });
    expect(write.onConflictDoNothing).toHaveBeenCalledOnce();
  });
  it.each([undefined, "https://learning.example.test"])("labels a new device and queues the security notification using app URL %s", async (appUrl) => {
    vi.stubEnv("APP_URL", appUrl);
    select.limit.mockResolvedValue([{ email: "learner@example.test", name: "Ada" }]);
    await options().databaseHooks.session.create.after(session);
    expect(write.set).toHaveBeenCalledWith({ deviceLabel: "Firefox on Linux", userAgent: "Firefox", lastSeenAt: expect.any(Date) });
    expect(write.values).toHaveBeenCalledWith(expect.objectContaining({ userId: "owner", type: "new-device", actionUrl: "/settings?section=device" }));
    expect(mocks.enqueue).toHaveBeenCalledWith({ to: "learner@example.test", userId: "owner", template: "new-device", idempotencySeed: session.id, variables: { name: "Ada", device: "Firefox on Linux", url: `${appUrl ?? "http://localhost:3000"}/settings?section=device` } });
  });
  it("does not send a new-device message without a matching owner", async () => {
    await options().databaseHooks.session.create.after(session);
    expect(write.set).toHaveBeenCalledOnce(); expect(mocks.enqueue).not.toHaveBeenCalled(); expect(mocks.insert).not.toHaveBeenCalled();
  });
  it("keeps successful sign-in usable when notification infrastructure fails", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    select.limit.mockResolvedValue([{ email: "learner@example.test", name: "Ada" }]);
    mocks.enqueue.mockRejectedValue(new Error("private provider token"));
    await expect(options().databaseHooks.session.create.after(session)).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith("New-device security notification could not be queued.");
    expect(JSON.stringify(log.mock.calls)).not.toContain("private provider token");
  });
  it.each([
    ["/sign-out", "learner_logout", "Firefox"],
    ["/reset-password", "password_reset", null],
    ["/revoke-sessions", "learner_logout_others", undefined],
    [undefined, "learner_logout_others", 42],
  ])("archives deleted sessions for %s", async (path, endReason, deviceLabel) => {
    await options().databaseHooks.session.delete.before({ ...session, deviceLabel }, path ? { path } : undefined);
    expect(mocks.archive).toHaveBeenCalledWith({ ...session, deviceLabel: typeof deviceLabel === "string" ? deviceLabel : null, endReason });
  });
});

describe("authentication email callbacks", () => {
  beforeEach(() => { mocks.mayReset.mockResolvedValue(true); });
  it("withdraws the token and sends nothing for an ineligible account", async () => {
    mocks.mayReset.mockResolvedValue(false);
    await options().emailAndPassword.sendResetPassword({ token: "opaque-token", url: "https://example.test/reset", user: { id: "owner", name: "Ada", email: "learner@example.test" } });
    expect(mocks.poolQuery).toHaveBeenCalledWith("delete from public.verification where identifier = $1 and value = $2", [expect.not.stringContaining("opaque-token"), "owner"]);
    expect(mocks.resetSource).not.toHaveBeenCalled();
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });
  it("refuses a reset email whose verification source is missing", async () => {
    mocks.resetSource.mockResolvedValue(null);
    await expect(options().emailAndPassword.sendResetPassword({ token: "opaque-token", url: "https://example.test/reset", user: { id: "owner", name: "Ada", email: "learner@example.test" } })).rejects.toMatchObject({ code: "RESET_PASSWORD_SOURCE_UNAVAILABLE" });
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });
  it.each([undefined, "https://learning.example.test"])("queues a reset bound to its authoritative verification using %s", async (appUrl) => {
    vi.stubEnv("APP_URL", appUrl); mocks.resetSource.mockResolvedValue("verification-1");
    mocks.resetVariables.mockReturnValue({ source: "fixture" }); mocks.requireVariables.mockReturnValue({ resetUrl: "https://example.test/reset" });
    await options().emailAndPassword.sendResetPassword({ token: "opaque-token", url: "https://example.test/reset", user: { id: "owner", name: "Ada", email: "learner@example.test" } });
    expect(mocks.resetVariables).toHaveBeenCalledWith({ applicationUrl: appUrl ?? "http://localhost:3000", name: "Ada", token: "opaque-token", url: "https://example.test/reset", verificationId: "verification-1" });
    expect(mocks.enqueue).toHaveBeenCalledWith({ to: "learner@example.test", userId: "owner", template: "reset-password", variables: { resetUrl: "https://example.test/reset" }, idempotencySeed: "reset-password:verification-1" });
  });
  it("queues verification with a deterministic event identity", async () => {
    const input = { token: "verification-token", url: "https://example.test/verify", user: { id: "owner", name: "Ada", email: "learner@example.test" } };
    await options().emailVerification.sendVerificationEmail(input);
    await options().emailVerification.sendVerificationEmail(input);
    expect(mocks.enqueue).toHaveBeenCalledWith(expect.objectContaining({ to: input.user.email, template: "verify-email", variables: { name: "Ada", url: input.url }, idempotencySeed: expect.any(String) }));
    expect(mocks.enqueue.mock.calls[0][0].idempotencySeed).toBe(mocks.enqueue.mock.calls[1][0].idempotencySeed);
  });
});
