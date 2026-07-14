import { describe, expect, it } from "vitest";

import { adminPlanRequestHash, type AdminPlanIdempotencyInput } from "../idempotency";

const base: AdminPlanIdempotencyInput = {
  kind: "revise",
  actorUserId: "admin-1",
  learnerPublicId: "learner-public-1",
  enrollmentId: "83000000-0000-4000-8000-000000000001",
  expectedRevision: 2,
  reason: "Prioritize loops after mentor review.",
  effectiveAt: "2026-07-14T00:00:00.000Z",
  policyVersion: "admin-plan-revision-2026-07-12.v1",
  operations: [{ type: "set_override", itemId: "loops", mode: "prioritize", note: "Review first." }],
};

describe("adminPlanRequestHash", () => {
  it("is deterministic and independent of object key insertion order", () => {
    const reordered = {
      operations: base.kind === "revise" ? base.operations : [],
      policyVersion: base.policyVersion,
      effectiveAt: base.effectiveAt,
      reason: base.reason,
      expectedRevision: base.expectedRevision,
      enrollmentId: base.enrollmentId,
      learnerPublicId: base.learnerPublicId,
      actorUserId: base.actorUserId,
      kind: "revise" as const,
    };
    expect(adminPlanRequestHash(reordered)).toBe(adminPlanRequestHash(base));
    expect(adminPlanRequestHash(base)).toMatch(/^[0-9a-f]{64}$/);
  });

  it.each([
    ["actor", { ...base, actorUserId: "admin-2" }],
    ["learner", { ...base, learnerPublicId: "learner-public-2" }],
    ["enrollment", { ...base, enrollmentId: "83000000-0000-4000-8000-000000000002" }],
    ["expected revision", { ...base, expectedRevision: 3 }],
    ["reason", { ...base, reason: "A different reason." }],
    ["effective time", { ...base, effectiveAt: "2026-07-14T00:00:01.000Z" }],
    ["operation", { ...base, operations: [{ type: "remove" as const, itemId: "loops" }] }],
    ["action", {
      kind: "revert" as const,
      actorUserId: base.actorUserId,
      learnerPublicId: base.learnerPublicId,
      enrollmentId: base.enrollmentId,
      expectedRevision: base.expectedRevision,
      reason: base.reason,
      effectiveAt: base.effectiveAt,
      policyVersion: base.policyVersion,
      targetRevision: 1,
    }],
  ])("changes when %s changes", (_label, changed) => {
    expect(adminPlanRequestHash(changed)).not.toBe(adminPlanRequestHash(base));
  });

  it("rejects values that cannot be represented as canonical JSON", () => {
    expect(() => adminPlanRequestHash({ ...base, expectedRevision: Number.NaN })).toThrow(/non-finite/);
  });
});
