import { afterAll, beforeEach, describe, expect, it } from "vitest";

import {
  AdminPlanServiceError,
  createLearnerPlanRevision,
  revertLearnerPlanRevision,
} from "@/lib/admin-plan/service";
import { notifyLearningPlanChanged } from "@/lib/admin-plan/notifications";
import { db, pool } from "@/lib/db/client";
import {
  course,
  courseVersion,
  emailOutbox,
  enrollment,
  notification,
  planRevision,
  user,
} from "@/lib/db/schema";

const ADMIN_ID = "plan-integration-admin";
const LEARNER_ID = "plan-integration-learner";
const OTHER_LEARNER_ID = "plan-integration-other";
const LEARNER_PUBLIC_ID = "81000000-0000-4000-8000-000000000001";
const OTHER_PUBLIC_ID = "81000000-0000-4000-8000-000000000002";
const COURSE_ID = "82000000-0000-4000-8000-000000000001";
const VERSION_ID = "82000000-0000-4000-8000-000000000002";
const ENROLLMENT_ID = "82000000-0000-4000-8000-000000000003";
const INITIAL_REVISION_ID = "82000000-0000-4000-8000-000000000004";
const NOW = new Date("2026-07-12T10:00:00.000Z");

const initialPlan = [
  {
    schemaVersion: 1, id: "variables", kind: "learn", trackId: "python",
    courseVersion: "1.0.0", moduleId: "python.core", skillId: "python.variables",
    title: "Variables", position: 0, required: true, prerequisites: [],
    evidenceTypes: ["code"], languageContext: "python", goalPriority: 10,
    prerequisiteCentrality: 2,
  },
  {
    schemaVersion: 1, id: "loops", kind: "learn", trackId: "python",
    courseVersion: "1.0.0", moduleId: "python.core", skillId: "python.loops",
    title: "Loops", position: 1, required: true, prerequisites: ["python.variables"],
    evidenceTypes: ["code"], languageContext: "python", goalPriority: 10,
    prerequisiteCentrality: 1,
  },
];

function assertDisposableDatabase() {
  const connectionString = process.env.DATABASE_URL ?? "";
  if (process.env.INTEGRATION_TEST !== "1" || !/\/learncoding_integration(?:\?|$)/.test(connectionString)) {
    throw new Error("Admin-plan integration tests require the disposable learncoding_integration database.");
  }
}

async function truncateApplicationTables() {
  assertDisposableDatabase();
  const result = await pool.query<{ table_name: string }>(`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
  `);
  if (!result.rows.length) return;
  const names = result.rows.map(({ table_name }) => `"${table_name.replaceAll('"', '""')}"`).join(", ");
  await pool.query(`TRUNCATE TABLE ${names} RESTART IDENTITY CASCADE`);
}

async function seedPlan() {
  await db.insert(user).values([
    { id: ADMIN_ID, publicId: "81000000-0000-4000-8000-000000000010", name: "Plan Admin", email: "plan-admin@integration.invalid", role: "admin", status: "active" },
    { id: LEARNER_ID, publicId: LEARNER_PUBLIC_ID, name: "Plan Learner", email: "plan-learner@integration.invalid", role: "learner", status: "active" },
    { id: OTHER_LEARNER_ID, publicId: OTHER_PUBLIC_ID, name: "Other Learner", email: "other-learner@integration.invalid", role: "learner", status: "active" },
  ]);
  await db.insert(course).values({
    id: COURSE_ID, slug: "plan-integration", title: "Plan Integration", summary: "Plan test", domain: "programming",
  });
  await db.insert(courseVersion).values({
    id: VERSION_ID, courseId: COURSE_ID, version: "1.0.0", stage: "beta",
    scopeStatement: "Integration plan scope", contentHash: "a".repeat(64),
  });
  await db.insert(enrollment).values({
    id: ENROLLMENT_ID, userId: LEARNER_ID, courseVersionId: VERSION_ID,
    implementationLanguage: "Python", status: "active", source: "diagnostic", startedAt: NOW,
  });
  await db.insert(planRevision).values({
    id: INITIAL_REVISION_ID, enrollmentId: ENROLLMENT_ID, revision: 1,
    parentId: null, source: "adaptive_initializer", reason: "Initial diagnostic plan.",
    policyVersion: "adaptive-learning-v1", createdBy: LEARNER_ID, plan: initialPlan, createdAt: NOW,
  });
}

beforeEach(async () => {
  await truncateApplicationTables();
  await seedPlan();
});

afterAll(async () => {
  await pool.end();
});

describe("real PostgreSQL administrator plan revisions", () => {
  it("atomically retries a partial delivery failure without duplicate learner notices", async () => {
    const input = {
      learnerUserId: LEARNER_ID,
      courseTitle: "Plan Integration",
      revision: 2,
      action: "updated" as const,
      idempotencySeed: "83000000-0000-4000-8000-000000000020",
    };
    try {
      await pool.query(`
        create function fail_plan_change_notification() returns trigger
        language plpgsql as $$
        begin
          if new.type = 'learning-plan-changed' then
            raise exception 'forced notification failure';
          end if;
          return new;
        end;
        $$;
        create trigger fail_plan_change_notification
        before insert on notification
        for each row execute function fail_plan_change_notification();
      `);
      await expect(notifyLearningPlanChanged(input)).rejects.toThrow(/notification/i);
      expect(await db.select().from(emailOutbox)).toHaveLength(0);
      expect(await db.select().from(notification)).toHaveLength(0);
    } finally {
      await pool.query("drop trigger if exists fail_plan_change_notification on notification");
      await pool.query("drop function if exists fail_plan_change_notification() cascade");
    }

    await notifyLearningPlanChanged(input);
    await notifyLearningPlanChanged(input);
    expect(await db.select().from(emailOutbox)).toHaveLength(1);
    expect(await db.select().from(notification)).toHaveLength(1);
  });

  it("serializes concurrent notification replays into exactly one durable delivery pair", async () => {
    const input = {
      learnerUserId: LEARNER_ID,
      courseTitle: "Plan Integration",
      revision: 2,
      action: "reverted" as const,
      idempotencySeed: "83000000-0000-4000-8000-000000000021",
    };
    await Promise.all(Array.from({ length: 8 }, () => notifyLearningPlanChanged(input)));

    expect(await db.select().from(emailOutbox)).toHaveLength(1);
    expect(await db.select().from(notification)).toHaveLength(1);
  });

  it("binds the learner, appends/idempotently replays, serializes conflicts, and reverts without rewriting history", async () => {
    const requestId = "83000000-0000-4000-8000-000000000001";
    const input = {
      actorUserId: ADMIN_ID,
      learnerPublicId: LEARNER_PUBLIC_ID,
      enrollmentId: ENROLLMENT_ID,
      requestId,
      expectedRevision: 1,
      reason: "Assign loop remediation after mentor review.",
      effectiveAt: NOW.toISOString(),
      operations: [{
        type: "assign_remediation" as const,
        itemId: "loops",
        note: "Repeat loop tracing before the next assessment.",
      }],
      now: NOW,
    };
    const created = await createLearnerPlanRevision(input);
    expect(created.created).toBe(true);
    expect(created.revision).toMatchObject({ revision: 2, parentId: INITIAL_REVISION_ID, source: "admin" });
    const replay = await createLearnerPlanRevision(input);
    expect(replay).toMatchObject({ created: false, replayed: true, revision: { id: requestId, revision: 2 } });
    await expect(createLearnerPlanRevision({
      ...input,
      reason: "Reuse the UUID with a changed mentor reason.",
    })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    await expect(createLearnerPlanRevision({
      ...input,
      operations: [{ type: "remove", itemId: "loops" }],
    })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    await expect(createLearnerPlanRevision({
      ...input,
      requestId: INITIAL_REVISION_ID,
    })).rejects.toMatchObject({ code: "IDEMPOTENCY_UNVERIFIABLE" });
    const rowsAfterReplay = await db.select().from(planRevision);
    expect(rowsAfterReplay).toHaveLength(2);
    expect(rowsAfterReplay.find((row) => row.revision === 1)?.plan).toEqual(initialPlan);
    expect(rowsAfterReplay.find((row) => row.revision === 2)?.plan[1]).toMatchObject({
      adminRemediation: { evidencePreserved: true, assignedBy: ADMIN_ID },
    });

    await expect(createLearnerPlanRevision({ ...input, learnerPublicId: OTHER_PUBLIC_ID, requestId: "83000000-0000-4000-8000-000000000009" }))
      .rejects.toMatchObject({ code: "ENROLLMENT_NOT_FOUND" });

    const concurrent = await Promise.allSettled([
      createLearnerPlanRevision({
        ...input,
        requestId: "83000000-0000-4000-8000-000000000002",
        expectedRevision: 2,
        reason: "Record the first mentor prioritization directive.",
        operations: [{ type: "set_override", itemId: "loops", mode: "prioritize", note: "Prioritize after the assigned remediation." }],
      }),
      createLearnerPlanRevision({
        ...input,
        requestId: "83000000-0000-4000-8000-000000000003",
        expectedRevision: 2,
        reason: "Record the competing mentor defer directive.",
        operations: [{ type: "set_override", itemId: "loops", mode: "defer", note: "Defer until the next mentor checkpoint." }],
      }),
    ]);
    expect(concurrent.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejection = concurrent.find((result) => result.status === "rejected") as PromiseRejectedResult;
    expect(rejection.reason).toBeInstanceOf(AdminPlanServiceError);
    expect(rejection.reason).toMatchObject({ code: "VERSION_CONFLICT" });

    const latestRows = await db.select().from(planRevision);
    expect(latestRows).toHaveLength(3);
    const latest = latestRows.find((row) => row.revision === 3)!;
    const revert = await revertLearnerPlanRevision({
      actorUserId: ADMIN_ID,
      learnerPublicId: LEARNER_PUBLIC_ID,
      enrollmentId: ENROLLMENT_ID,
      requestId: "83000000-0000-4000-8000-000000000004",
      expectedRevision: 3,
      targetRevision: 1,
      reason: "Restore the initial sequence after mentor review.",
      effectiveAt: NOW.toISOString(),
      now: NOW,
    });
    expect(revert).toMatchObject({ created: true, revision: { revision: 4, parentId: latest.id, source: "admin_revert" } });
    await expect(revertLearnerPlanRevision({
      actorUserId: ADMIN_ID,
      learnerPublicId: LEARNER_PUBLIC_ID,
      enrollmentId: ENROLLMENT_ID,
      requestId: "83000000-0000-4000-8000-000000000004",
      expectedRevision: 3,
      targetRevision: 2,
      reason: "Restore a different revision with the same request UUID.",
      effectiveAt: NOW.toISOString(),
      now: NOW,
    })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    const finalRows = await db.select().from(planRevision);
    expect(finalRows).toHaveLength(4);
    expect(finalRows.find((row) => row.revision === 1)?.plan).toEqual(initialPlan);
    expect(finalRows.find((row) => row.revision === 4)?.plan).toEqual(
      initialPlan.map((item) => expect.objectContaining(item)),
    );
    expect(finalRows.find((row) => row.revision === 4)?.plan[0]).toMatchObject({
      adminRevision: {
        operationTypes: ["revert"],
        targetRevision: 1,
        masteryUnaffected: true,
        prerequisitesEnforced: true,
      },
    });
  });

  it("rejects a prerequisite-breaking move and future activation without appending a row", async () => {
    await expect(createLearnerPlanRevision({
      actorUserId: ADMIN_ID,
      learnerPublicId: LEARNER_PUBLIC_ID,
      enrollmentId: ENROLLMENT_ID,
      requestId: "83000000-0000-4000-8000-000000000005",
      expectedRevision: 1,
      reason: "Test the prerequisite guard before moving variables.",
      effectiveAt: NOW.toISOString(),
      operations: [{ type: "move", itemId: "variables", toPosition: 2 }],
      now: NOW,
    })).rejects.toMatchObject({ code: "PREREQUISITE_VIOLATION" });
    await expect(createLearnerPlanRevision({
      actorUserId: ADMIN_ID,
      learnerPublicId: LEARNER_PUBLIC_ID,
      enrollmentId: ENROLLMENT_ID,
      requestId: "83000000-0000-4000-8000-000000000006",
      expectedRevision: 1,
      reason: "Attempt a future scheduled activation safely.",
      effectiveAt: new Date(NOW.getTime() + 60_000).toISOString(),
      operations: [{ type: "remove", itemId: "loops" }],
      now: NOW,
    })).rejects.toMatchObject({ code: "FUTURE_EFFECTIVE_AT" });
    expect(await db.select().from(planRevision)).toHaveLength(1);
  });
});
