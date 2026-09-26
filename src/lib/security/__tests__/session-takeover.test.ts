import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  process.env.BETTER_AUTH_SECRET ??= "session-takeover-test-secret-with-32-bytes";
  return {
  activeRows: [] as unknown[],
  select: vi.fn(),
  update: vi.fn(),
  archiveExpiredSessions: vi.fn(async () => undefined),
  archiveAndDeleteSessions: vi.fn(async () => ["old-session"]),
  writeAuditEvent: vi.fn(async () => undefined),
  withRateLimit: vi.fn(async (_check: unknown, handler: () => Promise<Response>) => handler()),
  };
});

vi.mock("better-auth", () => ({ betterAuth: (options: unknown) => ({ options }) }));
vi.mock("better-auth/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("better-auth/api")>()),
  createAuthMiddleware: (handler: unknown) => handler,
}));
vi.mock("better-auth/adapters/drizzle", () => ({ drizzleAdapter: () => ({}) }));
vi.mock("better-auth/next-js", () => ({ nextCookies: () => ({}) }));
vi.mock("better-auth/plugins", () => ({ admin: () => ({}), twoFactor: () => ({}) }));
vi.mock("@/lib/db/client", () => ({
  db: { select: mocks.select, update: mocks.update },
  pool: {},
}));
vi.mock("@/lib/session-controls", () => ({
  archiveAndDeleteSessions: mocks.archiveAndDeleteSessions,
  archiveDeletedSession: vi.fn(),
  archiveExpiredSessions: mocks.archiveExpiredSessions,
  boundedUserAgent: (value: string | null) => value,
  describeUserAgent: () => "Browser",
}));
vi.mock("@/lib/security/audit-writer", () => ({ writeAuditEvent: mocks.writeAuditEvent }));
vi.mock("@/lib/security/rate-limit", () => ({ withRateLimit: mocks.withRateLimit }));

import { auth } from "@/lib/auth";
import { SESSION_TAKEOVER_HEADER } from "@/lib/security/session-takeover-constants";

type Hook = (...args: unknown[]) => Promise<unknown>;
const options = (auth as unknown as {
  options: {
    hooks: { before: Hook; after: Hook };
    databaseHooks: { session: { create: { before: Hook } } };
  };
}).options;
const createSessionBefore = options.databaseHooks.session.create.before;

function headers(takeover: boolean) {
  return new Headers(takeover ? { [SESSION_TAKEOVER_HEADER]: "1" } : {});
}

function endpointContext(input: { path: string; takeover?: boolean; newSession?: unknown }) {
  return {
    path: input.path,
    headers: headers(input.takeover ?? false),
    getSignedCookie: vi.fn(async () => "pending-challenge"),
    context: {
      secret: "test-secret",
      newSession: input.newSession ?? null,
      createAuthCookie: () => ({ name: "learncoding.two_factor" }),
      internalAdapter: {
        findVerificationValue: vi.fn(async () => ({
          value: "learner-1",
          expiresAt: new Date(Date.now() + 60_000),
        })),
      },
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.activeRows = [];
  mocks.select.mockImplementation(() => ({
    from: () => ({ where: () => ({ limit: async () => mocks.activeRows }) }),
  }));
  mocks.update.mockImplementation(() => ({ set: () => ({ where: async () => undefined }) }));
  mocks.withRateLimit.mockImplementation(async (_check, handler) => handler());
});

describe("one-active-device session creation", () => {
  it("allows the first device", async () => {
    await expect(
      createSessionBefore({ userId: "learner-1" }, { path: "/sign-in/email", headers: headers(false) }),
    ).resolves.toBeUndefined();
    expect(mocks.archiveAndDeleteSessions).not.toHaveBeenCalled();
  });

  it("blocks a second device with a clear, typed error on password sign-in", async () => {
    mocks.activeRows = [{ id: "old-session" }];
    await expect(
      createSessionBefore({ userId: "learner-1" }, { path: "/sign-in/email", headers: headers(false) }),
    ).rejects.toMatchObject({
      body: { code: "ACTIVE_SESSION_ELSEWHERE", message: "You're signed in on another device." },
    });
    expect(mocks.archiveAndDeleteSessions).not.toHaveBeenCalled();
  });

  it("ignores the takeover header outside the TOTP endpoint", async () => {
    mocks.activeRows = [{ id: "old-session" }];
    for (const path of ["/sign-in/email", "/two-factor/verify-backup-code", "/callback/:id"]) {
      await expect(
        createSessionBefore({ userId: "learner-1" }, { path, headers: headers(true) }),
      ).rejects.toMatchObject({ body: { code: "ACTIVE_SESSION_ELSEWHERE" } });
    }
    expect(mocks.archiveAndDeleteSessions).not.toHaveBeenCalled();
  });

  it("revokes the old device and audits success once TOTP verification creates the session", async () => {
    mocks.activeRows = [{ id: "old-session" }];
    await expect(
      createSessionBefore(
        { userId: "learner-1" },
        { path: "/two-factor/verify-totp", headers: headers(true) },
      ),
    ).resolves.toBeUndefined();
    expect(mocks.archiveAndDeleteSessions).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "learner-1",
        actorUserId: "learner-1",
        scope: "all",
        reason: "signed_in_elsewhere",
      }),
    );
    expect(mocks.writeAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ action: "session.takeover", outcome: "success", subjectUserId: "learner-1" }),
    );
  });
});

describe("second-factor request guard", () => {
  it("refuses before the code is checked when another device is active and no takeover was requested", async () => {
    mocks.activeRows = [{ id: "old-session" }];
    const ctx = endpointContext({ path: "/two-factor/verify-totp" });
    await expect(options.hooks.before(ctx)).rejects.toMatchObject({
      body: { code: "ACTIVE_SESSION_ELSEWHERE" },
    });
  });

  it("also protects single-use recovery codes from being burned", async () => {
    mocks.activeRows = [{ id: "old-session" }];
    const ctx = endpointContext({ path: "/two-factor/verify-backup-code", takeover: true });
    await expect(options.hooks.before(ctx)).rejects.toMatchObject({
      body: { code: "ACTIVE_SESSION_ELSEWHERE" },
    });
    expect(mocks.withRateLimit).not.toHaveBeenCalled();
  });

  it("lets a takeover attempt reach TOTP verification within the per-account budget", async () => {
    mocks.activeRows = [{ id: "old-session" }];
    const ctx = endpointContext({ path: "/two-factor/verify-totp", takeover: true });
    await expect(options.hooks.before(ctx)).resolves.toBeUndefined();
    expect(mocks.withRateLimit).toHaveBeenCalledWith(
      { policy: "session_takeover_user", identity: { kind: "user", value: "learner-1" } },
      expect.any(Function),
    );
  });

  it("rate-limits takeover attempts and audits the refusal", async () => {
    mocks.withRateLimit.mockResolvedValueOnce(new Response(null, { status: 429 }));
    const ctx = endpointContext({ path: "/two-factor/verify-totp", takeover: true });
    await expect(options.hooks.before(ctx)).rejects.toMatchObject({
      body: { code: "SESSION_TAKEOVER_RATE_LIMITED" },
    });
    expect(mocks.writeAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ action: "session.takeover", outcome: "failure", reason: "rate_limited" }),
    );
  });

  it("does nothing without a pending password-verified challenge", async () => {
    mocks.activeRows = [{ id: "old-session" }];
    const ctx = endpointContext({ path: "/two-factor/verify-totp" });
    ctx.getSignedCookie.mockResolvedValueOnce(null as unknown as string);
    await expect(options.hooks.before(ctx)).resolves.toBeUndefined();
  });

  it("audits a wrong takeover code", async () => {
    const ctx = endpointContext({ path: "/two-factor/verify-totp", takeover: true });
    await options.hooks.after(ctx);
    expect(mocks.writeAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ action: "session.takeover", outcome: "failure", reason: "invalid_code" }),
    );
  });

  it("does not audit ordinary wrong codes as takeover failures", async () => {
    const ctx = endpointContext({ path: "/two-factor/verify-totp" });
    await options.hooks.after(ctx);
    expect(mocks.writeAuditEvent).not.toHaveBeenCalled();
  });
});
