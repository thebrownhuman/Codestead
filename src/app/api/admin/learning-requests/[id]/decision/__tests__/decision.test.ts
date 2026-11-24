import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  select: vi.fn(),
  transaction: vi.fn(),
  enqueueEmail: vi.fn(),
  enqueueEmailInTransaction: vi.fn(),
  writeAuditEvent: vi.fn(),
  writeAuditEventInTransaction: vi.fn(),
  committed: vi.fn(),
}));
vi.mock("@/lib/http/authz", () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock("@/lib/db/client", () => ({ db: { select: mocks.select, transaction: mocks.transaction } }));
vi.mock("@/lib/notifications/outbox", () => ({
  enqueueEmail: mocks.enqueueEmail,
  enqueueEmailInTransaction: mocks.enqueueEmailInTransaction,
}));
vi.mock("@/lib/security/audit-writer", () => ({
  writeAuditEvent: mocks.writeAuditEvent,
  writeAuditEventInTransaction: mocks.writeAuditEventInTransaction,
}));
vi.mock("@/lib/security/privileged-access", () => ({
  authorizePrivilegedAction: () => ({ allowed: true }),
}));
vi.mock("@/lib/learning-requests/support-service", () => ({ fixSupportRequest: vi.fn() }));

import { POST } from "../route";

const id = "10000000-0000-4000-8000-000000000001";
const context = { params: Promise.resolve({ id }) };
const post = (body: unknown) => new NextRequest(
  `http://localhost:3000/api/admin/learning-requests/${id}/decision`,
  { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
);
const pending = { id, userId: "learner", subject: "Graphs", learnerName: "Lea", learnerEmail: "lea@example.test" };
const decision = { decision: "approved", reason: "Fits the roadmap well." };

function selectChain(rows: unknown[]) {
  const chain = {
    from: vi.fn(() => chain),
    innerJoin: vi.fn(() => chain),
    where: vi.fn(() => chain),
    limit: vi.fn(() => Object.assign(Promise.resolve(rows), { for: vi.fn(async () => rows) })),
  };
  return chain;
}

let tx: { select: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };

describe("admin learning-request decision", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAdmin.mockResolvedValue({
      session: { user: { id: "admin", role: "admin" }, session: { id: "session-1" } },
    });
    mocks.select.mockReturnValue(selectChain([{ mfaVerifiedAt: new Date() }]));
    const update = { set: vi.fn(() => update), where: vi.fn(async () => undefined) };
    tx = { select: vi.fn(() => selectChain([pending])), update: vi.fn(() => update) };
    // Mirrors a real transaction: the commit only happens when the callback resolves.
    mocks.transaction.mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) => {
      const result = await callback(tx);
      mocks.committed();
      return result;
    });
  });

  it("queues the learner email and audit event inside the decision transaction", async () => {
    const response = await POST(post(decision), context);

    expect(response.status).toBe(200);
    expect(mocks.committed).toHaveBeenCalledTimes(1);
    expect(mocks.enqueueEmailInTransaction).toHaveBeenCalledWith(tx, expect.objectContaining({
      to: pending.learnerEmail,
      userId: pending.userId,
      template: "learning-request-updated",
      idempotencySeed: `${id}:approved`,
    }));
    expect(mocks.writeAuditEventInTransaction).toHaveBeenCalledWith(tx, expect.objectContaining({
      action: "learning_request.approved",
      resourceId: id,
      subjectUserId: pending.userId,
    }));
    expect(mocks.enqueueEmail).not.toHaveBeenCalled();
    expect(mocks.writeAuditEvent).not.toHaveBeenCalled();
  });

  it.each([
    ["email", mocks.enqueueEmailInTransaction, mocks.enqueueEmail],
    ["audit event", mocks.writeAuditEventInTransaction, mocks.writeAuditEvent],
  ])("does not commit the decision when the %s cannot be written", async (_name, inTransaction, standalone) => {
    inTransaction.mockRejectedValueOnce(new Error("private SQL"));
    standalone.mockRejectedValueOnce(new Error("private SQL"));
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await POST(post(decision), context);

    expect(mocks.committed).not.toHaveBeenCalled();
    expect(response.status).toBe(503);
    expect(JSON.stringify(await response.json())).not.toContain("private SQL");
    expect(errorLog).toHaveBeenCalledExactlyOnceWith(JSON.stringify({
      event: "learning_request.decision_failed", requestId: id, decision: "approved", errorName: "Error",
    }));
    errorLog.mockRestore();
  });

  it("returns not found without side effects when the request is no longer pending", async () => {
    tx.select.mockReturnValue(selectChain([]));

    expect((await POST(post(decision), context)).status).toBe(404);
    expect(mocks.enqueueEmailInTransaction).not.toHaveBeenCalled();
    expect(mocks.writeAuditEventInTransaction).not.toHaveBeenCalled();
  });
});
