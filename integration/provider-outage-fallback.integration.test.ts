import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const authMocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  requireAdmin: vi.fn(),
  gateClosedBookCapability: vi.fn(),
  withRateLimit: vi.fn(),
}));

vi.mock("@/lib/http/authz", () => ({
  requireAuth: authMocks.requireAuth,
  requireAdmin: authMocks.requireAdmin,
}));
vi.mock("@/lib/exams/capability-gate", () => ({
  gateClosedBookCapability: authMocks.gateClosedBookCapability,
}));
vi.mock("@/lib/security/rate-limit", () => ({
  withRateLimit: authMocks.withRateLimit,
}));

import { POST as tutorPost } from "@/app/api/ai/tutor/route";
import { POST as createFallbackGrant } from "@/app/api/admin/fallback-grants/route";
import { POST as revokeFallbackGrant } from "@/app/api/admin/fallback-grants/[id]/revoke/route";
import { POST as mutateConsent } from "@/app/api/privacy/consents/route";
import {
  reconcileFallbackBudget,
  reserveFallbackBudget,
} from "@/lib/ai/fallback-budget";
import { createFallbackGrantCommand } from "@/lib/ai/fallback-grants";
import { PostgresProviderOperationReceiptStore } from "@/lib/ai/provider-operation-idempotency";
import { createContentRepository, aggregateCourseProgress } from "@/lib/content";
import { deleteLearnerAccount } from "@/lib/data-lifecycle/deletion";
import { scoreExam } from "@/lib/domain/exam";
import { db, pool } from "@/lib/db/client";
import {
  adminFallbackGrant,
  adminFallbackReservation,
  auditEvent,
  chatMessage,
  consentRecord,
  emailOutbox,
  modelCall,
  notification,
  providerCredential,
  providerOperationReceipt,
  providerPolicy,
  session,
  user,
} from "@/lib/db/schema";
import { consentInsert, ENROLLMENT_DISCLOSURE_VERSION } from "@/lib/privacy/consent";
import { sealCredential } from "@/lib/security/credential-vault";
import { userAuthorityLockKey } from "@/lib/security/user-authority-lock";

const ADMIN_ID = "provider-outage-admin";
const LEARNER_ID = "provider-outage-learner";
const ADMIN_SESSION_ID = "provider-outage-admin-session";
const LEARNER_SESSION_ID = "provider-outage-learner-session";
const PREFERRED_ID = "81000000-0000-4000-8000-000000000001";
const SECONDARY_ID = "81000000-0000-4000-8000-000000000002";
const ADMIN_CREDENTIAL_ID = "81000000-0000-4000-8000-000000000003";
const CORRUPT_CREDENTIAL_ID = "81000000-0000-4000-8000-000000000004";
const STALE_GRANT_ID = "82000000-0000-4000-8000-000000000001";
const OVERLAPPING_GRANT_ID = "82000000-0000-4000-8000-000000000002";
const BUDGET_GRANT_ID = "82000000-0000-4000-8000-000000000003";
const masterKey = Buffer.alloc(32, 29);
const secrets = {
  preferred: "synthetic-preferred-provider-key-AAAA",
  secondary: "synthetic-secondary-provider-key-BBBB",
  fallback: "synthetic-admin-provider-key-CCCC",
} as const;

function assertDisposableDatabase() {
  const connectionString = process.env.DATABASE_URL ?? "";
  if (process.env.INTEGRATION_TEST !== "1" || !/\/learncoding_integration(?:\?|$)/.test(connectionString)) {
    throw new Error("Provider outage tests require the disposable learncoding_integration database.");
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

function sealedCredential(input: {
  id: string;
  userId: string;
  provider: "nvidia_nim" | "openai";
  secret: string;
}) {
  return sealCredential(input.secret, {
    credentialId: input.id,
    userId: input.userId,
    provider: input.provider,
    keyVersion: 1,
  }, masterKey);
}

function tutorRequest(requestId: string) {
  return new NextRequest("https://learn.test/api/ai/tutor", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      requestId,
      courseId: "python",
      skillId: "python.values.scalars",
      message: "Explain scalar values without using hidden tests.",
    }),
  });
}

function bearer(options: RequestInit | undefined) {
  const headers = options?.headers as Record<string, string> | undefined;
  return headers?.authorization?.replace(/^Bearer /, "") ?? "";
}

beforeEach(async () => {
  await truncateApplicationTables();
  process.env.CREDENTIAL_MASTER_KEY = masterKey.toString("base64");
  authMocks.requireAuth.mockResolvedValue({
    session: {
      user: { id: LEARNER_ID, name: "Outage Learner" },
      session: { id: LEARNER_SESSION_ID },
    },
    account: { role: "learner" },
    response: null,
  });
  authMocks.requireAdmin.mockResolvedValue({
    session: {
      user: { id: ADMIN_ID, name: "Outage Admin" },
      session: { id: ADMIN_SESSION_ID },
    },
    account: { role: "admin" },
    response: null,
  });
  authMocks.gateClosedBookCapability.mockResolvedValue({ allowed: true });
  authMocks.withRateLimit.mockImplementation(async (_policy, callback) => callback());

  const now = new Date();
  await db.insert(user).values([
    {
      id: ADMIN_ID,
      name: "Outage Admin",
      email: "provider-outage-admin@integration.invalid",
      emailVerified: true,
      role: "admin",
      status: "active",
    },
    {
      id: LEARNER_ID,
      name: "Outage Learner",
      email: "provider-outage-learner@integration.invalid",
      emailVerified: true,
      role: "learner",
      status: "active",
    },
  ]);
  await db.insert(session).values([
    {
      id: ADMIN_SESSION_ID,
      expiresAt: new Date(now.getTime() + 60 * 60_000),
      token: "synthetic-admin-session-token",
      userId: ADMIN_ID,
      mfaVerifiedAt: now,
    },
    {
      id: LEARNER_SESSION_ID,
      expiresAt: new Date(now.getTime() + 60 * 60_000),
      token: "synthetic-learner-session-token",
      userId: LEARNER_ID,
    },
  ]);
  await db.insert(providerPolicy).values([
    {
      provider: "nvidia_nim",
      operation: "tutor",
      model: "offline/nim-model",
      priority: 20,
      maxInputTokens: 16_000,
      maxOutputTokens: 200,
      timeoutMs: 5_000,
    },
    {
      provider: "openai",
      operation: "tutor",
      model: "offline/fallback-model",
      priority: 1,
      maxInputTokens: 16_000,
      maxOutputTokens: 200,
      timeoutMs: 5_000,
    },
  ]);
  const preferred = sealedCredential({
    id: PREFERRED_ID,
    userId: LEARNER_ID,
    provider: "nvidia_nim",
    secret: secrets.preferred,
  });
  const secondary = sealedCredential({
    id: SECONDARY_ID,
    userId: LEARNER_ID,
    provider: "nvidia_nim",
    secret: secrets.secondary,
  });
  const fallback = sealedCredential({
    id: ADMIN_CREDENTIAL_ID,
    userId: ADMIN_ID,
    provider: "openai",
    secret: secrets.fallback,
  });
  await db.insert(providerCredential).values([
    {
      id: SECONDARY_ID,
      userId: LEARNER_ID,
      provider: "nvidia_nim",
      label: "Secondary learner key",
      ...secondary,
      isPreferred: false,
      status: "active",
      createdAt: new Date("2026-07-12T09:00:00.000Z"),
    },
    {
      id: PREFERRED_ID,
      userId: LEARNER_ID,
      provider: "nvidia_nim",
      label: "Preferred learner key",
      ...preferred,
      isPreferred: true,
      status: "active",
      createdAt: new Date("2026-07-12T10:00:00.000Z"),
    },
    {
      id: ADMIN_CREDENTIAL_ID,
      userId: ADMIN_ID,
      provider: "openai",
      label: "Administrator fallback key",
      ...fallback,
      status: "active",
    },
  ]);
  await db.insert(consentRecord).values([
    consentInsert({
      userId: LEARNER_ID,
      purpose: "external_ai_routing",
      decision: "accepted",
      source: "onboarding",
      requestId: "outage-external-routing",
    }),
    consentInsert({
      userId: LEARNER_ID,
      purpose: "provider:nvidia_nim",
      decision: "accepted",
      source: "settings",
      requestId: "outage-provider-nim",
    }),
    consentInsert({
      userId: LEARNER_ID,
      purpose: "admin_fallback_ai",
      decision: "accepted",
      source: "settings",
      requestId: "outage-admin-fallback",
    }),
  ]);
  // This deliberately simulates stale/malicious grant data for a destination
  // the learner has not consented to. The tutor route must never transmit it.
  await db.insert(adminFallbackGrant).values({
    id: STALE_GRANT_ID,
    learnerId: LEARNER_ID,
    credentialId: ADMIN_CREDENTIAL_ID,
    provider: "openai",
    model: "offline/fallback-model",
    tokenBudget: 50_000,
    rupeeBudgetPaise: 50_000,
    inputPaisePerMillionTokens: 10_000,
    outputPaisePerMillionTokens: 20_000,
    startsAt: new Date(now.getTime() - 60_000),
    expiresAt: new Date(now.getTime() + 60 * 60_000),
    grantedBy: ADMIN_ID,
  });
});

afterAll(async () => {
  delete process.env.CREDENTIAL_MASTER_KEY;
  vi.unstubAllGlobals();
  await pool.end();
});

describe("offline provider outage and administrator fallback journey", () => {
  it("fails over learner keys, blocks an unconsented destination, grants bounded fallback, then revokes it without disabling learning", async () => {
    await db.insert(providerCredential).values({
      id: CORRUPT_CREDENTIAL_ID,
      userId: LEARNER_ID,
      provider: "nvidia_nim",
      label: "Corrupt synthetic learner key",
      ciphertext: "corrupt-ciphertext",
      wrappedDataKey: "corrupt-wrapped-key",
      wrapIv: "corrupt-wrap-iv",
      dataIv: "corrupt-data-iv",
      authTag: "corrupt-auth-tag",
      lastFour: "BAD0",
      status: "active",
      isPreferred: false,
      createdAt: new Date("2026-07-12T08:00:00.000Z"),
    });
    const providerCalls: Array<{ url: string; options: RequestInit }> = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, options?: RequestInit) => {
      const url = String(input);
      const captured = { url, options: options ?? {} };
      providerCalls.push(captured);
      const key = bearer(options);
      if (key === secrets.preferred || key === secrets.secondary) {
        return new Response(JSON.stringify({ error: { message: `never expose ${key}` } }), {
          status: 503,
          headers: { "content-type": "application/json" },
        });
      }
      if (key === secrets.fallback) {
        return new Response(JSON.stringify({
          id: "offline-fallback-response",
          model: "offline/fallback-model",
          choices: [{ message: { content: "A scalar stores one value." }, finish_reason: "stop" }],
          usage: { prompt_tokens: 120, completion_tokens: 30 },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`Unexpected synthetic provider key for ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const unavailable = await tutorPost(tutorRequest("83000000-0000-4000-8000-000000000001"));
    const unavailableBody = await unavailable.json();
    expect(unavailable.status).toBe(503);
    expect(unavailableBody).toEqual({
      error: "Codestead is unavailable right now. Your authored lesson and deterministic practice are still available. You can keep learning while AI recovers.",
      degraded: true,
    });
    expect(providerCalls.map(({ options }) => bearer(options))).toEqual([
      secrets.preferred,
      secrets.secondary,
    ]);
    expect(providerCalls.some(({ url }) => url.startsWith("https://api.openai.com"))).toBe(false);
    expect(JSON.stringify(unavailableBody)).not.toContain(secrets.preferred);
    expect(JSON.stringify(unavailableBody)).not.toContain(secrets.secondary);
    expect(JSON.stringify(unavailableBody)).not.toContain(secrets.fallback);
    for (const { options } of providerCalls) {
      expect(String(options.body)).not.toContain("synthetic-");
    }
    const safeRetry = await tutorPost(tutorRequest("83000000-0000-4000-8000-000000000001"));
    expect(safeRetry.status).toBe(503);
    expect(safeRetry.headers.get("x-idempotent-replay")).toBe("true");
    expect(await safeRetry.json()).toEqual(unavailableBody);
    expect(providerCalls).toHaveLength(2);

    // Canonical authored content, deterministic exam scoring, and progress
    // aggregation remain usable while every permitted provider is down.
    const repository = createContentRepository();
    const [lesson, banks, pythonCourse] = await Promise.all([
      repository.compileLessonBlueprint("python.values.scalars"),
      repository.listAssessmentBanks({ skillId: "python.values.scalars" }),
      repository.getCourse("python"),
    ]);
    expect(lesson.blocks.length).toBeGreaterThan(0);
    expect(banks.length).toBeGreaterThan(0);
    expect(scoreExam({
      criteria: [{
        itemId: "offline-item",
        criterionId: "offline-criterion",
        clusterId: "offline-cluster",
        kind: "CONCEPT",
        earnedPoints: 10,
        possiblePoints: 10,
        critical: true,
      }],
      codingItems: [],
      singleProject: false,
    }).outcome).toBe("MASTERED");
    expect(aggregateCourseProgress(pythonCourse!, [{
      skillId: "python.values.scalars",
      stage: "PASSED",
    }])).toMatchObject({ started: 1, completed: 1 });
    expect(providerCalls).toHaveLength(2);

    await db.insert(consentRecord).values(consentInsert({
      userId: LEARNER_ID,
      purpose: "provider:openai",
      decision: "accepted",
      source: "settings",
      requestId: "outage-provider-openai",
    }));
    const staleRevoke = await revokeFallbackGrant(
      new NextRequest(`https://learn.test/api/admin/fallback-grants/${STALE_GRANT_ID}/revoke`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          reason: "Retire the stale unconsented fallback destination.",
          requestId: "86000000-0000-4000-8000-000000000001",
        }),
      }),
      { params: Promise.resolve({ id: STALE_GRANT_ID }) },
    );
    expect(staleRevoke.status).toBe(200);

    const incompleteGrant = await createFallbackGrant(new NextRequest(
      "https://learn.test/api/admin/fallback-grants",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          learnerId: LEARNER_ID,
          credentialId: ADMIN_CREDENTIAL_ID,
          tokenBudget: 20_000,
          expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
          reason: "Prove incomplete fallback grants are rejected.",
          requestId: "86000000-0000-4000-8000-000000000002",
        }),
      },
    ));
    expect(incompleteGrant.status).toBe(400);

    const grantCommand = {
      learnerId: LEARNER_ID,
      credentialId: ADMIN_CREDENTIAL_ID,
      model: "offline/fallback-model",
      tokenBudget: 20_000,
      rupeeBudgetPaise: 10_000,
      inputPaisePerMillionTokens: 10_000,
      outputPaisePerMillionTokens: 20_000,
      expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      reason: "Fund one bounded outage fallback for this learner.",
    };
    const createGrantRequest = (requestId: string, overrides: Record<string, unknown> = {}) =>
      createFallbackGrant(new NextRequest("https://learn.test/api/admin/fallback-grants", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...grantCommand, ...overrides, requestId }),
      }));
    const competingCreates = await Promise.all([
      createGrantRequest("86000000-0000-4000-8000-000000000003"),
      createGrantRequest("86000000-0000-4000-8000-000000000006"),
    ]);
    expect(competingCreates.map((response) => response.status).sort()).toEqual([201, 409]);
    const grantResponse = competingCreates.find((response) => response.status === 201)!;
    const conflictResponse = competingCreates.find((response) => response.status === 409)!;
    expect(await conflictResponse.json()).toMatchObject({ code: "ACTIVE_GRANT_CONFLICT" });
    expect(grantResponse.status).toBe(201);
    const grantBody = await grantResponse.json();
    expect(grantBody.grant).toMatchObject({
      learnerId: LEARNER_ID,
      credentialId: ADMIN_CREDENTIAL_ID,
      model: "offline/fallback-model",
      tokenBudget: 20_000,
      rupeeBudgetPaise: 10_000,
      inputPaisePerMillionTokens: 10_000,
      outputPaisePerMillionTokens: 20_000,
    });
    const grantId = grantBody.grant.id as string;
    const winningRequestId = grantBody.grant.id
      ? (grantResponse === competingCreates[0]
          ? "86000000-0000-4000-8000-000000000003"
          : "86000000-0000-4000-8000-000000000006")
      : "";
    const grantReplay = await createGrantRequest(winningRequestId);
    expect(grantReplay.status).toBe(201);
    expect(grantReplay.headers.get("x-idempotent-replay")).toBe("true");
    expect(await grantReplay.json()).toEqual(grantBody);
    const changedGrantReplay = await createGrantRequest(winningRequestId, { tokenBudget: 20_001 });
    expect(changedGrantReplay.status).toBe(409);
    expect(await changedGrantReplay.json()).toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
    // Simulate an overlapping legacy row that predates the command-level
    // active-destination guard. Routing must deduplicate credential+model so
    // one learner request can reserve and charge only one grant.
    await db.insert(adminFallbackGrant).values({
      id: OVERLAPPING_GRANT_ID,
      learnerId: LEARNER_ID,
      credentialId: ADMIN_CREDENTIAL_ID,
      provider: "openai",
      model: "offline/fallback-model",
      tokenBudget: 20_000,
      rupeeBudgetPaise: 10_000,
      inputPaisePerMillionTokens: 10_000,
      outputPaisePerMillionTokens: 20_000,
      startsAt: new Date(Date.now() - 60_000),
      expiresAt: new Date(Date.now() + 2 * 60 * 60_000),
      grantedBy: ADMIN_ID,
      createRequestId: "86000000-0000-4000-8000-000000000008",
    });

    providerCalls.length = 0;
    const recovered = await tutorPost(tutorRequest("83000000-0000-4000-8000-000000000002"));
    const recoveredBody = await recovered.json();
    expect(recovered.status).toBe(200);
    expect(recoveredBody).toMatchObject({
      content: "A scalar stores one value.",
      provider: "openai",
      model: "offline/fallback-model",
      source: "admin_fallback",
    });
    expect(providerCalls.map(({ options }) => bearer(options))).toEqual([
      secrets.preferred,
      secrets.secondary,
      secrets.fallback,
    ]);
    const fallbackBody = JSON.parse(String(providerCalls[2]?.options.body)) as { model: string };
    expect(fallbackBody.model).toBe("offline/fallback-model");
    for (const { options } of providerCalls) {
      expect(String(options.body)).not.toContain("synthetic-");
    }

    const [chargedGrant] = await db
      .select({
        tokensUsed: adminFallbackGrant.tokensUsed,
        rupeesUsedPaise: adminFallbackGrant.rupeesUsedPaise,
      })
      .from(adminFallbackGrant)
      .where(eq(adminFallbackGrant.id, grantId));
    expect(chargedGrant).toEqual({ tokensUsed: 150, rupeesUsedPaise: 2 });
    expect((await db.select({
      tokensUsed: adminFallbackGrant.tokensUsed,
      rupeesUsedPaise: adminFallbackGrant.rupeesUsedPaise,
    }).from(adminFallbackGrant).where(eq(adminFallbackGrant.id, OVERLAPPING_GRANT_ID)))[0])
      .toEqual({ tokensUsed: 0, rupeesUsedPaise: 0 });
    expect(await db.select().from(adminFallbackReservation).where(
      eq(adminFallbackReservation.grantId, grantId),
    )).toEqual([
      expect.objectContaining({
        status: "reconciled",
        actualTokens: 150,
        actualPaise: 2,
      }),
    ]);
    expect(await db.select().from(modelCall)).toEqual([
      expect.objectContaining({ provider: "openai", model: "offline/fallback-model" }),
    ]);
    expect(JSON.stringify(await db.select().from(chatMessage))).not.toContain("synthetic-");

    const revokeRequest = (reason: string) => revokeFallbackGrant(
      new NextRequest(`https://learn.test/api/admin/fallback-grants/${grantId}/revoke`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          reason,
          requestId: "86000000-0000-4000-8000-000000000004",
        }),
      }),
      { params: Promise.resolve({ id: grantId }) },
    );
    const revokeReason = "End the temporary outage fallback immediately.";
    const revokeResponse = await revokeRequest(revokeReason);
    expect(revokeResponse.status).toBe(200);
    expect((await revokeRequest(revokeReason)).headers.get("x-idempotent-replay")).toBe("true");
    const changedRevoke = await revokeRequest("End the temporary outage fallback for a changed reason.");
    expect(changedRevoke.status).toBe(409);
    expect(await changedRevoke.json()).toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
    const overlapRevoke = await revokeFallbackGrant(
      new NextRequest(`https://learn.test/api/admin/fallback-grants/${OVERLAPPING_GRANT_ID}/revoke`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          reason: "Retire the overlapping legacy fallback row.",
          requestId: "86000000-0000-4000-8000-000000000009",
        }),
      }),
      { params: Promise.resolve({ id: OVERLAPPING_GRANT_ID }) },
    );
    expect(overlapRevoke.status).toBe(200);
    expect(await db.select().from(auditEvent)).toHaveLength(4);
    expect(await db.select().from(notification)).toHaveLength(4);
    expect(await db.select().from(emailOutbox)).toHaveLength(4);

    providerCalls.length = 0;
    const afterRevocation = await tutorPost(tutorRequest("83000000-0000-4000-8000-000000000003"));
    expect(afterRevocation.status).toBe(503);
    const revokedBody = await afterRevocation.json();
    expect(revokedBody).toMatchObject({ degraded: true });
    expect(providerCalls.map(({ options }) => bearer(options))).toEqual([
      secrets.preferred,
      secrets.secondary,
    ]);
    expect(JSON.stringify(revokedBody)).not.toContain("never expose");
    expect(await db.select().from(adminFallbackReservation).where(
      eq(adminFallbackReservation.grantId, grantId),
    )).toHaveLength(1);
  });

  it("serializes concurrent token and rupee reservations and makes reconciliation idempotent", async () => {
    const grantId = BUDGET_GRANT_ID;
    await db.insert(consentRecord).values(consentInsert({
      userId: LEARNER_ID,
      purpose: "provider:openai",
      decision: "accepted",
      source: "settings",
      requestId: "outage-provider-openai-budget",
    }));
    await db.insert(adminFallbackGrant).values({
      id: grantId,
      learnerId: LEARNER_ID,
      credentialId: ADMIN_CREDENTIAL_ID,
      provider: "openai",
      model: "offline/fallback-model",
      tokenBudget: 1_000,
      rupeeBudgetPaise: 500,
      inputPaisePerMillionTokens: 10_000,
      outputPaisePerMillionTokens: 20_000,
      startsAt: new Date(Date.now() - 60_000),
      expiresAt: new Date(Date.now() + 60 * 60_000),
      grantedBy: ADMIN_ID,
      createRequestId: "86000000-0000-4000-8000-000000000010",
    });
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, index) => reserveFallbackBudget({
        reservationId: `84000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
        grantId,
        learnerId: LEARNER_ID,
        credentialId: ADMIN_CREDENTIAL_ID,
        provider: "openai",
        model: "offline/fallback-model",
        tokens: 200,
        costPaise: 100,
      })),
    );
    expect(results.filter(Boolean)).toHaveLength(5);
    const successfulIndex = results.findIndex(Boolean);
    const reservationId = `84000000-0000-4000-8000-${String(successfulIndex).padStart(12, "0")}`;
    const reconciliation = {
      reservationId,
      grantId,
      learnerId: LEARNER_ID,
      reservedTokens: 200,
      reservedCostPaise: 100,
      actualTokens: 50,
      actualCostPaise: 25,
    };
    await reconcileFallbackBudget(reconciliation);
    await reconcileFallbackBudget(reconciliation);
    let [grant] = await db.select({
      tokensUsed: adminFallbackGrant.tokensUsed,
      rupeesUsedPaise: adminFallbackGrant.rupeesUsedPaise,
    }).from(adminFallbackGrant).where(eq(adminFallbackGrant.id, grantId));
    expect(grant).toEqual({ tokensUsed: 850, rupeesUsedPaise: 425 });

    const revokeResponse = await revokeFallbackGrant(
      new NextRequest(`https://learn.test/api/admin/fallback-grants/${grantId}/revoke`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          reason: "End the concurrency-test fallback grant.",
          requestId: "86000000-0000-4000-8000-000000000005",
        }),
      }),
      { params: Promise.resolve({ id: grantId }) },
    );
    expect(revokeResponse.status).toBe(200);
    await expect(reserveFallbackBudget({
      reservationId: "85000000-0000-4000-8000-000000000001",
      grantId,
      learnerId: LEARNER_ID,
      credentialId: ADMIN_CREDENTIAL_ID,
      provider: "openai",
      model: "offline/fallback-model",
      tokens: 1,
      costPaise: 1,
    })).resolves.toBe(false);
    [grant] = await db.select({
      tokensUsed: adminFallbackGrant.tokensUsed,
      rupeesUsedPaise: adminFallbackGrant.rupeesUsedPaise,
    }).from(adminFallbackGrant).where(eq(adminFallbackGrant.id, grantId));
    expect(grant).toEqual({ tokensUsed: 850, rupeesUsedPaise: 425 });
  });

  it("rejects a mismatched provider-reported model and conservatively closes the full reservation", async () => {
    await db.insert(consentRecord).values(consentInsert({
      userId: LEARNER_ID,
      purpose: "provider:openai",
      decision: "accepted",
      source: "settings",
      requestId: "outage-model-mismatch-openai-consent",
    }));
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, options?: RequestInit) => {
      const key = bearer(options);
      if (key === secrets.preferred || key === secrets.secondary) {
        return new Response(JSON.stringify({ error: { message: "synthetic outage" } }), {
          status: 503,
          headers: { "content-type": "application/json" },
        });
      }
      if (key === secrets.fallback) {
        return new Response(JSON.stringify({
          id: "offline-mismatched-model",
          model: "unexpected/provider-model",
          choices: [{ message: { content: "Must not be accepted." }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`Unexpected synthetic provider key for ${String(input)}`);
    }));

    const response = await tutorPost(tutorRequest("83000000-0000-4000-8000-000000000099"));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ degraded: true });
    const [reservation] = await db.select().from(adminFallbackReservation);
    expect(reservation).toMatchObject({
      status: "reconciled",
      actualTokens: reservation!.reservedTokens,
      actualPaise: reservation!.reservedPaise,
    });
    expect((await db.select({
      tokensUsed: adminFallbackGrant.tokensUsed,
      rupeesUsedPaise: adminFallbackGrant.rupeesUsedPaise,
    }).from(adminFallbackGrant).where(eq(adminFallbackGrant.id, STALE_GRANT_ID)))[0]).toEqual({
      tokensUsed: reservation!.reservedTokens,
      rupeesUsedPaise: reservation!.reservedPaise,
    });
    expect(await db.select().from(modelCall)).toHaveLength(0);
  });

  it("linearizes consent withdrawal against fallback reservation", async () => {
    const changeConsent = (decision: "accepted" | "withdrawn", requestId: string) =>
      mutateConsent(new NextRequest("https://learn.test/api/privacy/consents", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          requestId,
          purpose: "provider:openai",
          decision,
          policyVersion: ENROLLMENT_DISCLOSURE_VERSION,
        }),
      }));
    expect((await changeConsent("accepted", "87000000-0000-4000-8000-000000000001")).status).toBe(200);

    const blocker = await pool.connect();
    try {
      await blocker.query("begin");
      await blocker.query("select pg_advisory_xact_lock(hashtext($1))", [
        userAuthorityLockKey(LEARNER_ID),
      ]);
      const reservationFirst = reserveFallbackBudget({
        reservationId: "87000000-0000-4000-8000-000000000010",
        grantId: STALE_GRANT_ID,
        learnerId: LEARNER_ID,
        credentialId: ADMIN_CREDENTIAL_ID,
        provider: "openai",
        model: "offline/fallback-model",
        tokens: 10,
        costPaise: 5,
      });
      await new Promise((resolve) => setTimeout(resolve, 25));
      const withdrawalSecond = changeConsent("withdrawn", "87000000-0000-4000-8000-000000000002");
      await new Promise((resolve) => setTimeout(resolve, 25));
      await blocker.query("commit");
      expect(await reservationFirst).toBe(true);
      expect((await withdrawalSecond).status).toBe(200);
    } finally {
      await blocker.query("rollback").catch(() => undefined);
      blocker.release();
    }
    await expect(reserveFallbackBudget({
      reservationId: "87000000-0000-4000-8000-000000000011",
      grantId: STALE_GRANT_ID,
      learnerId: LEARNER_ID,
      credentialId: ADMIN_CREDENTIAL_ID,
      provider: "openai",
      model: "offline/fallback-model",
      tokens: 1,
      costPaise: 1,
    })).resolves.toBe(false);

    expect((await changeConsent("accepted", "87000000-0000-4000-8000-000000000003")).status).toBe(200);
    const secondBlocker = await pool.connect();
    try {
      await secondBlocker.query("begin");
      await secondBlocker.query("select pg_advisory_xact_lock(hashtext($1))", [
        userAuthorityLockKey(LEARNER_ID),
      ]);
      const withdrawalFirst = changeConsent("withdrawn", "87000000-0000-4000-8000-000000000004");
      await new Promise((resolve) => setTimeout(resolve, 25));
      const reservationSecond = reserveFallbackBudget({
        reservationId: "87000000-0000-4000-8000-000000000012",
        grantId: STALE_GRANT_ID,
        learnerId: LEARNER_ID,
        credentialId: ADMIN_CREDENTIAL_ID,
        provider: "openai",
        model: "offline/fallback-model",
        tokens: 1,
        costPaise: 1,
      });
      await new Promise((resolve) => setTimeout(resolve, 25));
      await secondBlocker.query("commit");
      expect((await withdrawalFirst).status).toBe(200);
      expect(await reservationSecond).toBe(false);
    } finally {
      await secondBlocker.query("rollback").catch(() => undefined);
      secondBlocker.release();
    }
    expect(await db.select().from(adminFallbackReservation)).toHaveLength(1);
  });

  it.each(["consent", "reservation", "grant", "receipt"] as const)(
    "serializes account deletion before a concurrent %s authority mutation",
    async (scenario) => {
      await db.insert(consentRecord).values(consentInsert({
        userId: LEARNER_ID,
        purpose: "provider:openai",
        decision: "accepted",
        source: "settings",
        requestId: `deletion-race-${scenario}-provider-consent`,
      }));
      if (scenario === "grant") {
        await db.insert(providerPolicy).values({
          provider: "openai",
          operation: "tutor",
          model: "offline/deletion-race-model",
          priority: 2,
          maxInputTokens: 16_000,
          maxOutputTokens: 200,
          timeoutMs: 5_000,
        });
      }

      const blocker = await pool.connect();
      const previousDeletionKey = process.env.DELETION_TOMBSTONE_KEY;
      process.env.DELETION_TOMBSTONE_KEY = "provider-outage-deletion-key-that-is-long-enough";
      try {
        await blocker.query("begin");
        await blocker.query("select pg_advisory_xact_lock(hashtext($1))", [
          userAuthorityLockKey(LEARNER_ID),
        ]);
        const suffix = scenario === "consent"
          ? "1"
          : scenario === "reservation"
            ? "2"
            : scenario === "grant"
              ? "3"
              : "4";
        const deletion = deleteLearnerAccount({
          actorUserId: ADMIN_ID,
          learnerId: LEARNER_ID,
          requestId: `88000000-0000-4000-8000-00000000000${suffix}`,
          reason: `Delete the learner while ${scenario} authority is queued.`,
          objectStorageRoot: "C:/synthetic-provider-outage-objects",
        });
        await new Promise((resolve) => setTimeout(resolve, 25));

        const operation = scenario === "consent"
          ? mutateConsent(new NextRequest("https://learn.test/api/privacy/consents", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                requestId: "88000000-0000-4000-8000-000000000011",
                purpose: "provider:openai",
                decision: "withdrawn",
                policyVersion: ENROLLMENT_DISCLOSURE_VERSION,
              }),
            }))
          : scenario === "reservation"
            ? reserveFallbackBudget({
                reservationId: "88000000-0000-4000-8000-000000000012",
                grantId: STALE_GRANT_ID,
                learnerId: LEARNER_ID,
                credentialId: ADMIN_CREDENTIAL_ID,
                provider: "openai",
                model: "offline/fallback-model",
                tokens: 10,
                costPaise: 5,
              })
            : scenario === "grant"
              ? createFallbackGrantCommand({
                  actorUserId: ADMIN_ID,
                  learnerId: LEARNER_ID,
                  credentialId: ADMIN_CREDENTIAL_ID,
                  model: "offline/deletion-race-model",
                  tokenBudget: 1_000,
                  rupeeBudgetPaise: 500,
                  inputPaisePerMillionTokens: 10_000,
                  outputPaisePerMillionTokens: 20_000,
                  expiresAt: new Date(Date.now() + 60 * 60_000),
                  reason: "Attempt a grant while learner deletion owns authority.",
                  requestId: "88000000-0000-4000-8000-000000000013",
                })
              : new PostgresProviderOperationReceiptStore().acquire({
                  ownerUserId: LEARNER_ID,
                  action: "tutor.post",
                  requestId: "88000000-0000-4000-8000-000000000014",
                  inputHash: "f".repeat(64),
                }).catch((error: unknown) => error);
        await new Promise((resolve) => setTimeout(resolve, 25));
        await blocker.query("commit");

        const [report, outcome] = await Promise.all([deletion, operation]);
        expect(report.primaryStoreDeletionComplete).toBe(true);
        if (scenario === "consent") {
          const response = outcome as Response;
          expect(response.status).toBe(409);
          expect(await response.json()).toMatchObject({ code: "ACCOUNT_UNAVAILABLE" });
        } else if (scenario === "reservation") {
          expect(outcome).toBe(false);
        } else if (scenario === "grant") {
          expect(outcome).toMatchObject({ ok: false, code: "LEARNER_OR_CREDENTIAL_NOT_FOUND" });
        } else {
          expect(outcome).toMatchObject({ code: "IDEMPOTENCY_RECEIPT_UNAVAILABLE" });
        }
        expect((await db.select({ status: user.status }).from(user).where(
          eq(user.id, LEARNER_ID),
        ))[0]?.status).toBe("deleted");
        expect(await db.select().from(consentRecord).where(eq(consentRecord.userId, LEARNER_ID))).toHaveLength(0);
        expect(await db.select().from(adminFallbackReservation).where(
          eq(adminFallbackReservation.learnerId, LEARNER_ID),
        )).toHaveLength(0);
        expect(await db.select().from(adminFallbackGrant).where(
          eq(adminFallbackGrant.learnerId, LEARNER_ID),
        )).toHaveLength(0);
        expect(await db.select().from(providerOperationReceipt).where(
          eq(providerOperationReceipt.ownerUserId, LEARNER_ID),
        )).toHaveLength(0);
      } finally {
        await blocker.query("rollback").catch(() => undefined);
        blocker.release();
        if (previousDeletionKey === undefined) delete process.env.DELETION_TOMBSTONE_KEY;
        else process.env.DELETION_TOMBSTONE_KEY = previousDeletionKey;
      }
    },
  );
});
