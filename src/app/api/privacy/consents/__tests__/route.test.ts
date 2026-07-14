import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  ENROLLMENT_DISCLOSURE_VERSION,
  type CurrentConsent,
} from "@/lib/privacy/consent";

const mocks = vi.hoisted(() => {
  const returning = vi.fn();
  const onConflictDoNothing = vi.fn(() => ({ returning }));
  const values = vi.fn(() => ({ onConflictDoNothing }));
  const insert = vi.fn(() => ({ values }));
  const accountRows = [] as Array<{ status: string }>;
  const limit = vi.fn(async () => accountRows);
  const where = vi.fn(() => ({ limit }));
  const from = vi.fn(() => ({ where }));
  const select = vi.fn(() => ({ from }));
  return {
    returning,
    onConflictDoNothing,
    values,
    insert,
    transaction: vi.fn(),
    execute: vi.fn(),
    accountRows,
    select,
    requireAuth: vi.fn(),
    getCurrentConsents: vi.fn(),
    writeAuditEvent: vi.fn(),
    withdrawCohortProfileForConsent: vi.fn(),
  };
});

vi.mock("@/lib/db/client", () => ({
  db: { insert: mocks.insert, transaction: mocks.transaction },
}));
vi.mock("@/lib/http/authz", () => ({ requireAuth: mocks.requireAuth }));
vi.mock("@/lib/privacy/consent", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/privacy/consent")>();
  return {
    ...original,
    getCurrentConsents: mocks.getCurrentConsents,
    getCurrentConsentsFrom: mocks.getCurrentConsents,
  };
});
vi.mock("@/lib/security/audit-writer", () => ({ writeAuditEvent: mocks.writeAuditEvent }));
vi.mock("@/lib/social/profile-service", () => ({ withdrawCohortProfileForConsent: mocks.withdrawCohortProfileForConsent }));
vi.mock("@/lib/security/rate-limit", () => ({
  withRateLimit: vi.fn(async (_checks, handler: () => Promise<Response>) => handler()),
}));

import { GET, POST } from "../route";

function request(body: Record<string, unknown>) {
  return new NextRequest("https://learn.test/api/privacy/consents", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function current(purpose: string, decision: "accepted" | "withdrawn" = "accepted") {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    purpose,
    decision,
    policyVersion: ENROLLMENT_DISCLOSURE_VERSION,
    dataCategories: ["safe-category"],
    occurredAt: new Date("2026-07-12T00:00:00.000Z"),
  } satisfies CurrentConsent;
}

const base = {
  requestId: "11111111-1111-4111-8111-111111111111",
  policyVersion: ENROLLMENT_DISCLOSURE_VERSION,
};

describe("privacy consent API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.returning.mockReset().mockResolvedValue([{ id: "record-1", purpose: "admin_fallback_ai" }]);
    mocks.requireAuth.mockResolvedValue({
      session: { user: { id: "learner-1" }, session: { id: "session-1" } },
      response: null,
    });
    mocks.getCurrentConsents.mockResolvedValue(new Map());
    mocks.writeAuditEvent.mockResolvedValue({ correlationId: "c", eventHash: "h" });
    mocks.withdrawCohortProfileForConsent.mockResolvedValue({ withdrawn: true, replayed: false });
    mocks.accountRows.splice(0, mocks.accountRows.length, { status: "active" });
    mocks.transaction.mockImplementation(async (callback) => callback({
      execute: mocks.execute,
      insert: mocks.insert,
      select: mocks.select,
    }));
  });

  it("returns versioned disclosures and only safe current-decision metadata", async () => {
    mocks.getCurrentConsents.mockResolvedValue(new Map([
      ["provider:nvidia_nim", current("provider:nvidia_nim")],
    ]));
    const response = await GET();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    const body = await response.json();
    expect(body.policyVersion).toBe(ENROLLMENT_DISCLOSURE_VERSION);
    expect(body.requiredDisclosures.length).toBeGreaterThanOrEqual(6);
    expect(body.current["provider:nvidia_nim"]).toMatchObject({
      decision: "accepted",
      currentVersionAccepted: true,
    });
    expect(JSON.stringify(body)).not.toMatch(/"(?:ciphertext|apiKey|email|wrappedDataKey|authTag|secret)"\s*:/i);
  });

  it("rejects malformed, unknown, stale-version, and core-disclosure mutations", async () => {
    for (const body of [
      { ...base, purpose: "unknown", decision: "accepted" },
      { ...base, purpose: "cohort_profile", decision: "maybe" },
      { ...base, policyVersion: "old.v1", purpose: "cohort_profile", decision: "accepted" },
    ]) {
      expect((await POST(request(body))).status).toBe(400);
    }
    const core = await POST(request({ ...base, purpose: "retention_policy", decision: "withdrawn" }));
    expect(core.status).toBe(409);
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it("requires cohort consent before leaderboard participation", async () => {
    mocks.getCurrentConsents.mockResolvedValue(new Map([
      ["cohort_profile", current("cohort_profile", "withdrawn")],
    ]));
    const response = await POST(request({ ...base, purpose: "leaderboard", decision: "accepted" }));
    expect(response.status).toBe(409);
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it("records an append-only optional decision and a safe audit event", async () => {
    const response = await POST(request({
      ...base,
      purpose: "admin_fallback_ai",
      decision: "accepted",
    }));
    expect(response.status).toBe(200);
    expect(mocks.values).toHaveBeenCalledWith([
      expect.objectContaining({
        userId: "learner-1",
        purpose: "admin_fallback_ai",
        decision: "accepted",
        source: "settings",
      }),
    ]);
    expect(mocks.onConflictDoNothing).toHaveBeenCalled();
    expect(mocks.writeAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      actorUserId: "learner-1",
      subjectUserId: "learner-1",
      action: "consent.accepted",
      outcome: "success",
      metadata: expect.objectContaining({ replayed: false }),
    }));
  });

  it("rejects a consent append when deletion has made the account unavailable", async () => {
    mocks.accountRows.splice(0, mocks.accountRows.length, { status: "deletion_pending" });
    const response = await POST(request({
      ...base,
      purpose: "admin_fallback_ai",
      decision: "withdrawn",
    }));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "ACCOUNT_UNAVAILABLE" });
    expect(mocks.insert).not.toHaveBeenCalled();
    expect(mocks.writeAuditEvent).not.toHaveBeenCalled();
  });

  it("cascades cohort withdrawal to leaderboard without deleting history", async () => {
    const response = await POST(request({
      ...base,
      purpose: "cohort_profile",
      decision: "withdrawn",
    }));
    expect(response.status).toBe(200);
    const rows = (mocks.values.mock.calls as unknown as Array<[unknown]>)[0]?.[0] as Array<{
      purpose: string;
      decision: string;
    }>;
    expect(rows).toHaveLength(2);
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ purpose: "cohort_profile", decision: "withdrawn" }),
      expect.objectContaining({ purpose: "leaderboard", decision: "withdrawn" }),
    ]));
    expect(mocks.withdrawCohortProfileForConsent).toHaveBeenCalledWith(expect.objectContaining({
      userId: "learner-1",
      consentRequestId: base.requestId,
    }));
  });

  it("reports an idempotent replay without duplicating the audit semantics", async () => {
    mocks.returning.mockResolvedValueOnce([]);
    const response = await POST(request({
      ...base,
      purpose: "provider:nvidia_nim",
      decision: "withdrawn",
    }));
    expect(await response.json()).toMatchObject({ replayed: true, effectiveForFutureProcessing: true });
    expect(mocks.writeAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      outcome: "success",
      metadata: expect.objectContaining({ replayed: true }),
    }));
  });
});
