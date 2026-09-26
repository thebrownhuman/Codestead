import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";

import { auth } from "@/lib/auth";
import { db, pool } from "@/lib/db/client";
import { auditEvent, authSessionHistory, session, user } from "@/lib/db/schema";
import {
  consumeSessionTakeoverBudget,
  hasActiveSession,
} from "@/lib/security/session-takeover";
import { SESSION_TAKEOVER_HEADER } from "@/lib/security/session-takeover-constants";
import { resetDisposableIntegrationDatabase } from "./support/reset-disposable-database";

const LEARNER_A = "session-takeover-learner-a";
const LEARNER_B = "session-takeover-learner-b";
const OLD_SESSION_A = "session-takeover-old-a";
const SESSION_B = "session-takeover-b";

type Hook = (...args: unknown[]) => Promise<unknown>;
const createSessionBefore = (auth.options as unknown as {
  databaseHooks: { session: { create: { before: Hook } } };
}).databaseHooks.session.create.before;

function assertDisposableDatabase() {
  const connectionString = process.env.DATABASE_URL ?? "";
  if (
    process.env.INTEGRATION_TEST !== "1" ||
    !/\/learncoding_integration(?:\?|$)/.test(connectionString)
  ) {
    throw new Error("Session takeover integration tests require the disposable database.");
  }
}

function hookContext(path: string, takeover: boolean) {
  return { path, headers: new Headers(takeover ? { [SESSION_TAKEOVER_HEADER]: "1" } : {}) };
}

async function seed(now = new Date()) {
  await db.insert(user).values(
    [LEARNER_A, LEARNER_B].map((id) => ({
      id,
      name: id,
      email: `${id}@integration.invalid`,
      emailVerified: true,
      role: "learner" as const,
      status: "active" as const,
      twoFactorEnabled: true,
    })),
  );
  await db.insert(session).values([
    {
      id: OLD_SESSION_A,
      userId: LEARNER_A,
      token: "session-takeover-old-a-token",
      expiresAt: new Date(now.getTime() + 60 * 60_000),
      deviceLabel: "Old laptop",
    },
    {
      id: SESSION_B,
      userId: LEARNER_B,
      token: "session-takeover-b-token",
      expiresAt: new Date(now.getTime() + 60 * 60_000),
      deviceLabel: "Unrelated browser",
    },
  ]);
}

describe("one-active-device takeover against Postgres", () => {
  beforeEach(async () => {
    assertDisposableDatabase();
    await resetDisposableIntegrationDatabase(pool);
    await seed();
  });

  afterAll(async () => {
    await resetDisposableIntegrationDatabase(pool);
  });

  it("blocks a second device without touching the existing session", async () => {
    await expect(
      createSessionBefore({ userId: LEARNER_A }, hookContext("/sign-in/email", false)),
    ).rejects.toMatchObject({ body: { code: "ACTIVE_SESSION_ELSEWHERE" } });
    await expect(
      createSessionBefore({ userId: LEARNER_A }, hookContext("/sign-in/email", true)),
    ).rejects.toMatchObject({ body: { code: "ACTIVE_SESSION_ELSEWHERE" } });
    expect(await hasActiveSession(LEARNER_A)).toBe(true);
  });

  it("revokes only the owner's old session after TOTP-confirmed takeover and audits it", async () => {
    await expect(
      createSessionBefore({ userId: LEARNER_A }, hookContext("/two-factor/verify-totp", true)),
    ).resolves.toBeUndefined();

    expect(await hasActiveSession(LEARNER_A)).toBe(false);
    expect(await hasActiveSession(LEARNER_B)).toBe(true);
    const [history] = await db
      .select({ endReason: authSessionHistory.endReason, revokedBy: authSessionHistory.revokedByUserId })
      .from(authSessionHistory)
      .where(eq(authSessionHistory.originalSessionId, OLD_SESSION_A));
    expect(history).toEqual({ endReason: "signed_in_elsewhere", revokedBy: LEARNER_A });
    const audits = await db
      .select({ outcome: auditEvent.outcome })
      .from(auditEvent)
      .where(and(eq(auditEvent.action, "session.takeover"), eq(auditEvent.subjectUserId, LEARNER_A)));
    expect(audits).toEqual([{ outcome: "success" }]);
  });

  it("enforces the per-account takeover budget", async () => {
    const results: boolean[] = [];
    for (let attempt = 0; attempt < 6; attempt += 1) {
      results.push(await consumeSessionTakeoverBudget(LEARNER_A));
    }
    expect(results).toEqual([true, true, true, true, true, false]);
    expect(await consumeSessionTakeoverBudget(LEARNER_B)).toBe(true);
  });
});
