import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { awardExamModuleMastery } from "@/lib/achievements/exam-mastery";
import { db, pool } from "@/lib/db/client";
import { achievement, emailOutbox, notification, user, userAchievement } from "@/lib/db/schema";

const LEARNER_ID = "exam-mastery-integration-learner";

function assertDisposableDatabase() {
  const connectionString = process.env.DATABASE_URL ?? "";
  if (process.env.INTEGRATION_TEST !== "1" || !/\/learncoding_integration(?:\?|$)/.test(connectionString)) {
    throw new Error("Exam mastery integration tests require the disposable learncoding_integration database.");
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

beforeEach(async () => {
  await truncateApplicationTables();
  await db.insert(user).values({
    id: LEARNER_ID,
    name: "Mastery Learner",
    email: "mastery@integration.invalid",
    status: "active",
    role: "learner",
  });
});

afterAll(async () => {
  await pool.end();
});

describe("real PostgreSQL exam mastery awards", () => {
  it("creates one private module badge and idempotent learner notifications", async () => {
    const input = {
      userId: LEARNER_ID,
      attemptId: "f2000000-0000-4000-8000-000000000001",
      courseId: "python",
      courseTitle: "Python",
      moduleId: "python.control-flow",
      moduleTitle: "Control flow",
      scorePercent: 97,
      criticalRequirementsMet: true,
    } as const;
    await expect(awardExamModuleMastery(input)).resolves.toMatchObject({ awarded: true });
    await expect(awardExamModuleMastery(input)).resolves.toEqual({
      awarded: false,
      reason: "ALREADY_AWARDED",
    });

    expect(await db.select().from(achievement)).toHaveLength(1);
    expect(await db.select().from(userAchievement)).toEqual([
      expect.objectContaining({
        userId: LEARNER_ID,
        evidenceId: `exam-attempt:${input.attemptId}`,
        visibility: "private",
        revokedAt: null,
      }),
    ]);
    expect(await db.select().from(notification)).toEqual([
      expect.objectContaining({ userId: LEARNER_ID, type: "mastery-awarded" }),
    ]);
    expect(await db.select().from(emailOutbox)).toEqual([
      expect.objectContaining({ userId: LEARNER_ID, template: "mastery-awarded" }),
    ]);
  });

  it("does not create evidence below the deterministic mastery threshold", async () => {
    await expect(awardExamModuleMastery({
      userId: LEARNER_ID,
      attemptId: "f2000000-0000-4000-8000-000000000002",
      courseId: "python",
      courseTitle: "Python",
      moduleId: "python.control-flow",
      moduleTitle: "Control flow",
      scorePercent: 94,
      criticalRequirementsMet: true,
    })).resolves.toMatchObject({ awarded: false });
    expect(await db.select().from(userAchievement)).toHaveLength(0);
  });
});
