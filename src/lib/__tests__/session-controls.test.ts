import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  select: vi.fn(),
  update: vi.fn(),
  insert: vi.fn(),
  transaction: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({
  db: {
    select: mocks.select,
    update: mocks.update,
    insert: mocks.insert,
    transaction: mocks.transaction,
  },
}));

import {
  archiveAndDeleteSessions,
  archiveDeletedSession,
  archiveExpiredSessions,
  boundedUserAgent,
  createRevocationRequest,
  describeUserAgent,
  learnerExists,
  listSessionControls,
  revokeOneOwnedSession,
  sessionScopeFilter,
} from "../session-controls";

function selectLimit(rows: unknown[]) {
  return {
    from: vi.fn(() => ({
      where: vi.fn(() => ({
        orderBy: vi.fn(() => ({ limit: vi.fn(async () => rows) })),
        limit: vi.fn(async () => rows),
      })),
    })),
  };
}

function directTransaction(input: { rows: unknown[]; limited?: boolean }) {
  const values = vi.fn();
  const onConflictDoNothing = vi.fn(async () => undefined);
  values.mockReturnValue({ onConflictDoNothing });
  const whereDelete = vi.fn(async () => undefined);
  const whereUpdate = vi.fn(async () => undefined);
  const where = vi.fn(() => input.limited ? { limit: vi.fn(async () => input.rows) } : Promise.resolve(input.rows));
  const tx = {
    select: vi.fn(() => ({ from: vi.fn(() => ({ where })) })),
    insert: vi.fn(() => ({ values })),
    delete: vi.fn(() => ({ where: whereDelete })),
    update: vi.fn(() => ({ set: vi.fn(() => ({ where: whereUpdate })) })),
  };
  return { tx, values, onConflictDoNothing, whereDelete, whereUpdate };
}

const T0 = new Date("2026-07-12T12:00:00.000Z");
const activeRow = {
  id: "session-active",
  deviceLabel: null,
  userAgent: "Mozilla/5.0 Windows Chrome/126.0",
  createdAt: new Date("2026-07-10T12:00:00.000Z"),
  lastSeenAt: new Date("2026-07-12T11:00:00.000Z"),
  expiresAt: new Date("2026-07-20T12:00:00.000Z"),
  revokedAt: null,
  revocationReason: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.update.mockReturnValue({ set: vi.fn(() => ({ where: vi.fn(async () => undefined) })) });
});

describe("session metadata minimization", () => {
  it.each([
    ["Mozilla/5.0 (Windows NT 10.0) Chrome/126.0 Safari/537.36", "Chrome on Windows"],
    ["Mozilla/5.0 (Macintosh) Version/17.0 Safari/605.1.15", "Safari on macOS"],
    ["Mozilla/5.0 (X11; Linux x86_64) Firefox/128.0", "Firefox on Linux"],
    ["Mozilla/5.0 (iPhone) CriOS/126.0 Mobile/15E148 Safari/604.1", "Chrome on iOS/iPadOS"],
    ["Mozilla/5.0 (Windows NT 10.0) Edg/126.0", "Edge on Windows"],
    ["Mozilla/5.0 (Linux; Android 14) Chrome/126.0", "Chrome on Android"],
    ["Unrecognized Agent", "Browser on unknown OS"],
    [null, "Unknown browser"],
  ])("turns a raw agent into a bounded display label", (value, expected) => {
    expect(describeUserAgent(value)).toBe(expected);
  });

  it("removes control characters, truncates storage, and accepts missing agents", () => {
    expect(boundedUserAgent("Browser\r\nInjected\0value")).toBe("Browser  Injected value");
    expect(boundedUserAgent("x".repeat(700))).toHaveLength(512);
    expect(boundedUserAgent(undefined)).toBeNull();
  });

  it("does not include IP addresses, tokens, or device fingerprints in labels", () => {
    const label = describeUserAgent("Mozilla/5.0 Windows Chrome/126.0");
    expect(label).toBe("Chrome on Windows");
    expect(label).not.toMatch(/token|hash|\d+\.\d+\.\d+\.\d+/i);
  });

  it("builds both session-scope filters", () => {
    expect(sessionScopeFilter({ userId: "learner", currentSessionId: "current", scope: "all" })).toBeDefined();
    expect(sessionScopeFilter({ userId: "learner", currentSessionId: "current", scope: "others" })).toBeDefined();
  });
});

describe("session control persistence branches", () => {
  it("lists live/history states, removes duplicates, sorts, and marks the current session", async () => {
    const revoked = {
      ...activeRow,
      id: "session-revoked",
      deviceLabel: "Known laptop",
      lastSeenAt: new Date("2026-07-12T10:00:00.000Z"),
      revokedAt: new Date("2026-07-12T10:30:00.000Z"),
      revocationReason: "admin_revoked",
    };
    const expired = {
      ...activeRow,
      id: "session-expired",
      lastSeenAt: new Date("2026-07-11T10:00:00.000Z"),
      expiresAt: new Date("2026-07-12T11:59:59.000Z"),
    };
    const history = [
      {
        id: "session-active",
        deviceLabel: "duplicate",
        userAgent: null,
        createdAt: activeRow.createdAt,
        lastSeenAt: activeRow.lastSeenAt,
        expiresAt: activeRow.expiresAt,
        endedAt: T0,
        endReason: "admin_revoked",
      },
      {
        id: "history-expired",
        deviceLabel: null,
        userAgent: null,
        createdAt: activeRow.createdAt,
        lastSeenAt: new Date("2026-07-09T12:00:00.000Z"),
        expiresAt: new Date("2026-07-10T12:00:00.000Z"),
        endedAt: new Date("2026-07-10T12:00:00.000Z"),
        endReason: "expired",
      },
      {
        id: "history-revoked",
        deviceLabel: "Old browser",
        userAgent: null,
        createdAt: activeRow.createdAt,
        lastSeenAt: new Date("2026-07-08T12:00:00.000Z"),
        expiresAt: new Date("2026-07-20T12:00:00.000Z"),
        endedAt: new Date("2026-07-08T12:00:00.000Z"),
        endReason: "learner_logout",
      },
    ];
    mocks.select
      .mockReturnValueOnce(selectLimit([activeRow, revoked, expired]))
      .mockReturnValueOnce(selectLimit(history))
      .mockReturnValueOnce(selectLimit([{ id: "request-1", status: "pending" }]));

    const result = await listSessionControls("learner", activeRow.id, T0);
    expect(result.sessions.map((row) => [row.id, row.state, row.current])).toEqual([
      ["session-active", "active", true],
      ["session-revoked", "revoked", false],
      ["session-expired", "expired", false],
      ["history-expired", "expired", false],
      ["history-revoked", "revoked", false],
    ]);
    expect(result.sessions[0]?.deviceLabel).toBe("Chrome on Windows");
    expect(result.sessions[1]?.deviceLabel).toBe("Known laptop");
    expect(result.sessions[3]?.deviceLabel).toBe("Unknown browser");
    expect(result.revocationRequests).toEqual([{ id: "request-1", status: "pending" }]);
  });

  it("returns early when archive scopes contain no sessions", async () => {
    const fake = directTransaction({ rows: [] });
    mocks.transaction.mockImplementation(async (work) => work(fake.tx));
    await expect(archiveAndDeleteSessions({
      userId: "learner", actorUserId: "learner", currentSessionId: "current",
      scope: "others", reason: "learner_logout_others", now: T0,
    })).resolves.toEqual([]);
    expect(fake.tx.insert).not.toHaveBeenCalled();

    const expired = directTransaction({ rows: [] });
    mocks.transaction.mockImplementationOnce(async (work) => work(expired.tx));
    await expect(archiveExpiredSessions("learner", T0)).resolves.toBe(0);
    expect(expired.tx.insert).not.toHaveBeenCalled();
  });

  it("archives scoped sessions with expired/self-request decisions", async () => {
    const rows = [
      activeRow,
      { ...activeRow, id: "expired", expiresAt: new Date(T0.getTime() - 1) },
    ];
    const fake = directTransaction({ rows });
    mocks.transaction.mockImplementation(async (work) => work(fake.tx));
    await expect(archiveAndDeleteSessions({
      userId: "learner", actorUserId: "learner", currentSessionId: "current",
      scope: "all", reason: "learner_logout", now: T0,
    })).resolves.toEqual(["session-active", "expired"]);
    const archived = fake.values.mock.calls[0]?.[0] as Array<Record<string, unknown>>;
    expect(archived.map((row) => row.endReason)).toEqual(["learner_logout", "expired"]);
    expect(fake.whereDelete).toHaveBeenCalledOnce();
    expect(fake.whereUpdate).toHaveBeenCalledOnce();
  });

  it("archives administrator revocation with the administrator decision branch", async () => {
    const fake = directTransaction({ rows: [activeRow] });
    mocks.transaction.mockImplementation(async (work) => work(fake.tx));
    await archiveAndDeleteSessions({
      userId: "learner", actorUserId: "admin", currentSessionId: "current",
      scope: "others", reason: "admin_revoked", now: T0,
    });
    expect(fake.tx.update).toHaveBeenCalledOnce();
  });

  it("archives and deletes all expired rows", async () => {
    const fake = directTransaction({ rows: [{ ...activeRow, id: "expired", expiresAt: T0 }] });
    mocks.transaction.mockImplementation(async (work) => work(fake.tx));
    await expect(archiveExpiredSessions("learner", T0)).resolves.toBe(1);
    const archived = fake.values.mock.calls[0]?.[0] as Array<Record<string, unknown>>;
    expect(archived[0]).toMatchObject({ endReason: "expired" });
    expect(archived[0]).not.toHaveProperty("revokedByUserId");
    expect(fake.whereDelete).toHaveBeenCalledOnce();
  });

  it("archives a Better Auth deleted row with bounded defaults", async () => {
    const values = vi.fn();
    const onConflictDoNothing = vi.fn(async () => undefined);
    values.mockReturnValue({ onConflictDoNothing });
    mocks.insert.mockReturnValue({ values });
    await archiveDeletedSession({
      id: "deleted", userId: "learner", userAgent: "Agent\r\nInjected",
      createdAt: activeRow.createdAt, expiresAt: activeRow.expiresAt,
      endReason: "learner_logout", now: T0,
    });
    expect(values).toHaveBeenCalledWith(expect.objectContaining({
      originalSessionId: "deleted",
      lastSeenAt: activeRow.createdAt,
      userAgent: "Agent  Injected",
      endedAt: T0,
    }));
  });

  it("returns false for an unowned session and archives both learner/admin revocations", async () => {
    const missing = directTransaction({ rows: [], limited: true });
    mocks.transaction.mockImplementationOnce(async (work) => work(missing.tx));
    await expect(revokeOneOwnedSession({
      userId: "learner", sessionId: "missing", actorUserId: "learner",
      reason: "learner_logout", now: T0,
    })).resolves.toBe(false);
    expect(missing.tx.insert).not.toHaveBeenCalled();

    for (const actorUserId of ["learner", "admin"]) {
      const fake = directTransaction({ rows: [activeRow], limited: true });
      mocks.transaction.mockImplementationOnce(async (work) => work(fake.tx));
      await expect(revokeOneOwnedSession({
        userId: "learner", sessionId: activeRow.id, actorUserId,
        reason: actorUserId === "learner" ? "learner_logout" : "admin_revoked", now: T0,
      })).resolves.toBe(true);
      expect(fake.tx.insert).toHaveBeenCalledOnce();
      expect(fake.whereDelete).toHaveBeenCalledOnce();
      expect(fake.whereUpdate).toHaveBeenCalledOnce();
    }
  });

  it("handles revocation-request ownership, creation, conflict replay, and missing replay", async () => {
    mocks.select.mockReturnValueOnce(selectLimit([]));
    await expect(createRevocationRequest({ userId: "learner", sessionId: "missing", reason: "Lost device" }))
      .resolves.toBeNull();

    const returning = vi.fn(async () => [{ id: "created-request" }]);
    mocks.select.mockReturnValueOnce(selectLimit([{ id: "owned" }]));
    mocks.insert.mockReturnValueOnce({
      values: vi.fn(() => ({ onConflictDoNothing: vi.fn(() => ({ returning })) })),
    });
    await expect(createRevocationRequest({ userId: "learner", sessionId: "owned", reason: "Lost device" }))
      .resolves.toBe("created-request");

    mocks.select
      .mockReturnValueOnce(selectLimit([{ id: "owned" }]))
      .mockReturnValueOnce(selectLimit([{ id: "existing-request" }]));
    mocks.insert.mockReturnValueOnce({
      values: vi.fn(() => ({ onConflictDoNothing: vi.fn(() => ({ returning: vi.fn(async () => []) })) })),
    });
    await expect(createRevocationRequest({ userId: "learner", sessionId: "owned", reason: "Lost device" }))
      .resolves.toBe("existing-request");

    mocks.select
      .mockReturnValueOnce(selectLimit([{ id: "owned" }]))
      .mockReturnValueOnce(selectLimit([]));
    mocks.insert.mockReturnValueOnce({
      values: vi.fn(() => ({ onConflictDoNothing: vi.fn(() => ({ returning: vi.fn(async () => []) })) })),
    });
    await expect(createRevocationRequest({ userId: "learner", sessionId: "owned", reason: "Lost device" }))
      .resolves.toBeNull();
  });

  it("checks learner existence without leaking the selected record", async () => {
    mocks.select.mockReturnValueOnce(selectLimit([{ id: "learner" }])).mockReturnValueOnce(selectLimit([]));
    await expect(learnerExists("learner")).resolves.toBe(true);
    await expect(learnerExists("missing")).resolves.toBe(false);
  });
});
