import { describe, expect, it } from "vitest";

import {
  AdminPlanValidationError,
  analyzeAdminPlanChange,
  applyAdminPlanOperations,
  parseAdminPlan,
} from "../plan-revisions";

function item(id: string, skillId: string, position: number, prerequisites: string[] = []) {
  return {
    schemaVersion: 1,
    id,
    kind: "learn",
    trackId: "python",
    courseVersion: "1.0.0",
    moduleId: "python.core",
    skillId,
    title: skillId.replaceAll(".", " "),
    position,
    required: true,
    prerequisites,
    evidenceTypes: ["code"],
    languageContext: "python",
    goalPriority: 10,
    prerequisiteCentrality: 1,
  };
}

const base = [
  item("variables-learn", "python.variables", 0),
  item("loops-learn", "python.loops", 1, ["python.variables"]),
  item("functions-learn", "python.functions", 2, ["python.loops"]),
];

describe("administrator plan revision analysis", () => {
  it("records remediation and override metadata without changing mastery or prerequisite policy", () => {
    const preview = applyAdminPlanOperations({
      basePlan: base,
      history: [{ revision: 1, plan: base }],
      actorUserId: "admin-1",
      effectiveAt: "2026-07-12T10:00:00.000Z",
      operations: [
        { type: "assign_remediation", itemId: "loops-learn", note: "Repeat loop tracing before new material." },
        { type: "set_override", itemId: "functions-learn", mode: "unlock_requested", note: "Learner requested an earlier preview." },
      ],
    });

    expect(preview.impact.canApply).toBe(true);
    expect(preview.impact.evidencePreserved).toBe(true);
    expect(preview.impact.masteryMutation).toBe(false);
    expect(preview.impact.prerequisiteBypass).toBe(false);
    expect(preview.impact.overrideRequests).toEqual([{
      itemId: "functions-learn",
      mode: "unlock_requested",
      prerequisitesEnforced: true,
    }]);
    expect(preview.plan[1].adminRemediation).toMatchObject({
      assigned: true,
      assignedBy: "admin-1",
      evidencePreserved: true,
    });
    expect(preview.plan[2].adminOverride).toMatchObject({
      masteryUnaffected: true,
      prerequisitesEnforced: true,
    });
    expect(preview.plan.every((entry) => (
      entry.adminRevision as Record<string, unknown>
    ).prerequisitesEnforced === true)).toBe(true);
    expect(preview.plan[0].adminRevision).toMatchObject({
      actorUserId: "admin-1",
      effectiveAt: "2026-07-12T10:00:00.000Z",
      operationTypes: ["assign_remediation", "set_override"],
      masteryUnaffected: true,
    });
    expect(preview.diff.changed.map((entry) => entry.id)).toEqual(["loops-learn", "functions-learn"]);
  });

  it("previews downstream effects and rejects moving a prerequisite after its dependent", () => {
    const preview = applyAdminPlanOperations({
      basePlan: base,
      history: [],
      actorUserId: "admin-1",
      effectiveAt: "2026-07-12T10:00:00.000Z",
      operations: [{ type: "move", itemId: "variables-learn", toPosition: 3 }],
    });

    expect(preview.impact.canApply).toBe(false);
    expect(preview.impact.prerequisiteViolations).toContainEqual(expect.objectContaining({
      itemId: "loops-learn",
      prerequisiteSkillId: "python.variables",
      kind: "ordered_after_dependent",
    }));
    expect(preview.impact.downstreamAffected.map((entry) => entry.skillId)).toEqual([
      "python.functions",
      "python.loops",
    ]);
  });

  it("detects a removed prerequisite while allowing a leaf removal", () => {
    const blocked = applyAdminPlanOperations({
      basePlan: base,
      history: [],
      actorUserId: "admin-1",
      effectiveAt: "2026-07-12T10:00:00.000Z",
      operations: [{ type: "remove", itemId: "loops-learn" }],
    });
    expect(blocked.impact.canApply).toBe(false);
    expect(blocked.impact.prerequisiteViolations).toContainEqual(expect.objectContaining({
      itemId: "functions-learn",
      kind: "missing",
    }));

    const allowed = applyAdminPlanOperations({
      basePlan: base,
      history: [],
      actorUserId: "admin-1",
      effectiveAt: "2026-07-12T10:00:00.000Z",
      operations: [{ type: "remove", itemId: "functions-learn" }],
    });
    expect(allowed.impact.canApply).toBe(true);
    expect(allowed.diff.removed).toEqual([expect.objectContaining({ id: "functions-learn" })]);
  });

  it("restores only an item from a bound historical revision", () => {
    const current = base.slice(0, 2);
    const restored = applyAdminPlanOperations({
      basePlan: current,
      history: [{ revision: 1, plan: base }],
      actorUserId: "admin-1",
      effectiveAt: "2026-07-12T10:00:00.000Z",
      operations: [{ type: "add", itemId: "functions-learn", fromRevision: 1 }],
    });
    expect(restored.impact.canApply).toBe(true);
    expect(restored.plan.map((entry) => entry.id)).toEqual([
      "variables-learn", "loops-learn", "functions-learn",
    ]);
    expect(restored.diff.added).toEqual([expect.objectContaining({ id: "functions-learn" })]);

    expect(() => applyAdminPlanOperations({
      basePlan: current,
      history: [{ revision: 1, plan: base }],
      actorUserId: "admin-1",
      effectiveAt: "2026-07-12T10:00:00.000Z",
      operations: [{ type: "add", itemId: "unknown", fromRevision: 1 }],
    })).toThrowError(AdminPlanValidationError);
  });

  it("fails closed for malformed plans, duplicate ids, missing items, and invalid destinations", () => {
    expect(() => parseAdminPlan({})).toThrow(/not an array/i);
    expect(() => parseAdminPlan([{ id: "only-id" }])).toThrow(/invalid item/i);
    expect(() => parseAdminPlan([base[0], base[0]])).toThrow(/duplicate/i);
    expect(() => applyAdminPlanOperations({
      basePlan: base,
      history: [],
      actorUserId: "admin-1",
      effectiveAt: "2026-07-12T10:00:00.000Z",
      operations: [{ type: "remove", itemId: "missing" }],
    })).toThrow(/not found/i);
    expect(() => applyAdminPlanOperations({
      basePlan: base,
      history: [],
      actorUserId: "admin-1",
      effectiveAt: "2026-07-12T10:00:00.000Z",
      operations: [{ type: "move", itemId: "loops-learn", toPosition: 99 }],
    })).toThrow(/outside/i);
    expect(() => applyAdminPlanOperations({
      basePlan: base,
      history: [],
      actorUserId: "admin-1",
      effectiveAt: "2026-07-12T10:00:00.000Z",
      operations: [{ type: "add", itemId: "functions-learn", fromRevision: 1 }],
    })).toThrow(/already present/i);
  });

  it("treats unknown external prerequisites as unchanged scope rather than granting a bypass", () => {
    const external = [item("advanced", "python.advanced", 0, ["external.foundation"] )];
    const result = analyzeAdminPlanChange(external, external);
    expect(result.impact.canApply).toBe(true);
    expect(result.impact.prerequisiteBypass).toBe(false);
  });
});
