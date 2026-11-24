import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  select: vi.fn(),
  transaction: vi.fn(),
  authorize: vi.fn(),
  audit: vi.fn(),
  auditInTransaction: vi.fn(),
  notify: vi.fn(),
}));

vi.mock("@/lib/http/authz", () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock("@/lib/db/client", () => ({ db: { select: mocks.select, transaction: mocks.transaction } }));
vi.mock("@/lib/security/privileged-access", () => ({ authorizePrivilegedAction: mocks.authorize }));
vi.mock("@/lib/security/audit-writer", () => ({
  writeAuditEvent: mocks.audit,
  writeAuditEventInTransaction: mocks.auditInTransaction,
}));
vi.mock("@/lib/session-notifications", () => ({ notifyRevocationDecision: mocks.notify }));
vi.mock("@/lib/session-controls", () => ({ boundedUserAgent: (value: string | null) => value }));

import { POST } from "../route";

const requestId = "5e000000-0000-4000-8000-000000000001";

/** A drizzle-like builder: every method chains, awaiting it yields `rows`. */
function query(rows: unknown) {
  const builder: unknown = new Proxy({}, {
    get(_target, property) {
      if (property === "then") {
        return (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
          Promise.resolve(rows).then(resolve, reject);
      }
      return () => builder;
    },
  });
  return builder;
}

function post(id: string, decision: "approved" | "rejected" = "approved") {
  return POST(
    new NextRequest(`https://learn.example.test/api/admin/session-revocation-requests/${id}/decision`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision, reason: "Learner confirmed the device is lost." }),
    }),
    { params: Promise.resolve({ id }) },
  );
}

describe("admin session-revocation decision route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.select.mockReset();
    mocks.transaction.mockReset();
    mocks.requireAdmin.mockResolvedValue({
      session: { user: { id: "admin-1" }, session: { id: "session-1" } },
      account: { role: "admin" },
      response: NextResponse.json({ error: "unauthorized" }, { status: 401 }),
    });
    mocks.authorize.mockReturnValue({ allowed: true });
    mocks.notify.mockResolvedValue(undefined);
  });

  it("answers 404 for a malformed request id without querying the uuid column", async () => {
    mocks.select.mockImplementation(() => {
      throw new Error("invalid input syntax for type uuid");
    });
    const response = await post("not-a-uuid");
    expect(response.status).toBe(404);
    expect(mocks.select).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("still looks up a well-formed request id", async () => {
    mocks.select
      .mockReturnValueOnce(query([{ mfaVerifiedAt: new Date() }]))
      .mockReturnValueOnce(query([]));
    const response = await post(requestId);
    expect(response.status).toBe(404);
    expect(mocks.select).toHaveBeenCalledTimes(2);
  });

  it("closes an approved request whose session is already gone instead of leaving it pending", async () => {
    const pending = {
      id: requestId,
      userId: "learner-1",
      sessionId: "session-gone",
      status: "pending",
      requestChannel: "authenticated",
      identityVerifiedAt: null,
      role: "learner",
    };
    mocks.select
      .mockReturnValueOnce(query([{ mfaVerifiedAt: new Date() }]))
      .mockReturnValueOnce(query([pending]));
    const set = vi.fn((patch: Record<string, unknown>) => {
      void patch;
      return query([{ id: requestId }]);
    });
    const tx = {
      // Locked request row, then the session lookup that finds nothing.
      select: vi.fn().mockReturnValueOnce(query([pending])).mockReturnValueOnce(query([])),
      insert: vi.fn(() => query([])),
      delete: vi.fn(() => query([])),
      update: vi.fn(() => ({ set })),
    };
    mocks.transaction.mockImplementation(async (callback) => callback(tx));

    const response = await post(requestId, "approved");

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      decision: "approved",
      sessionAlreadyEnded: true,
    });
    expect(set).toHaveBeenCalledWith(expect.objectContaining({
      status: "approved",
      decidedBy: "admin-1",
    }));
    // Nothing to archive or delete: the session row no longer exists.
    expect(tx.insert).not.toHaveBeenCalled();
    expect(tx.delete).not.toHaveBeenCalled();
    expect(mocks.auditInTransaction).toHaveBeenLastCalledWith(tx, expect.objectContaining({
      outcome: "success",
      metadata: expect.objectContaining({ decision: "approved", sessionAlreadyEnded: true }),
    }));
  });
});
