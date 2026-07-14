import { createHash, randomUUID } from "node:crypto";
import { and, asc, desc, eq, gt, isNull, lte, sql } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import {
  AUTHORED_TUTOR_FALLBACK_MESSAGE,
  BUDDY_TUTOR_PROMPT_VERSION,
  buildTutorMessages,
  contextManifest,
} from "@/lib/ai/context";
import {
  reconcileFallbackBudget,
  reserveFallbackBudget,
} from "@/lib/ai/fallback-budget";
import { routeTutorRequest, type ProviderCandidate } from "@/lib/ai/router";
import {
  loadMentorRecommendation,
  loadTutorStructuredMemory,
  sanitizeTutorMemoryText,
} from "@/lib/ai/tutor-memory";
import {
  recordProviderCredentialOutcome,
  providerCredentialUpdatedAtToken,
  type ProviderCredentialSnapshot,
} from "@/lib/ai/provider-credential-outcome";
import {
  canonicalProviderOperationHash,
  executeProviderOperationIdempotently,
  ProviderOperationIdempotencyError,
} from "@/lib/ai/provider-operation-idempotency";
import { createContentRepository } from "@/lib/content";
import { db } from "@/lib/db/client";
import {
  adminFallbackGrant,
  chatMessage,
  chatThread,
  learnerProfile,
  modelCall,
  providerCredential,
  providerPolicy,
} from "@/lib/db/schema";
import { requireAuth } from "@/lib/http/authz";
import { gateClosedBookCapability } from "@/lib/exams/capability-gate";
import {
  consentPurposeForProvider,
  getCurrentConsents,
  isCurrentConsentAccepted,
} from "@/lib/privacy/consent";
import { openCredential, parseMasterKey } from "@/lib/security/credential-vault";
import { withRateLimit } from "@/lib/security/rate-limit";
import {
  containsCredentialOrHiddenEvidence,
  containsExposedCredentialVariant,
} from "@/lib/security/sensitive-text";

const requestSchema = z.object({
  requestId: z.uuid(),
  courseId: z.string().regex(/^[a-z][a-z0-9-]*$/),
  skillId: z.string().min(3).max(180),
  message: z.string().trim().min(1).max(8_000),
  threadId: z.uuid().optional(),
});

const noStore = {
  "Cache-Control": "private, no-store, max-age=0, must-revalidate",
  Pragma: "no-cache",
  "X-Content-Type-Options": "nosniff",
} as const;

async function safeResponseSnapshot(response: Response) {
  const body = await response.clone().json().catch(() => ({
    error: AUTHORED_TUTOR_FALLBACK_MESSAGE,
    degraded: true,
  })) as Record<string, unknown>;
  return { status: response.status, body };
}

async function safeTutorExecution(execute: () => Promise<Response>) {
  try {
    return await safeResponseSnapshot(await execute());
  } catch {
    return {
      status: 503,
      body: { error: AUTHORED_TUTOR_FALLBACK_MESSAGE, degraded: true },
    };
  }
}

type EncryptedRow = {
  id: string;
  userId: string;
  provider: ProviderCandidate["provider"];
  ciphertext: string;
  wrappedDataKey: string;
  wrapIv: string;
  dataIv: string;
  authTag: string;
  keyVersion: number;
  updatedAtToken: string;
  lastFour: string;
  isPreferred: boolean;
};

function decrypt(row: EncryptedRow, master: Buffer) {
  return openCredential(
    row,
    {
      credentialId: row.id,
      userId: row.userId,
      provider: row.provider,
      keyVersion: row.keyVersion,
    },
    master,
  );
}

export async function POST(request: NextRequest) {
  const authz = await requireAuth();
  if (!authz.session) return authz.response;
  const examGate = await gateClosedBookCapability(authz.session.user.id, "ai_tutor");
  if (!examGate.allowed) {
    return NextResponse.json(
      { error: examGate.message, code: examGate.code },
      { status: examGate.status, headers: { "Cache-Control": "private, no-store" } },
    );
  }
  const body = requestSchema.safeParse(await request.json().catch(() => null));
  if (!body.success) {
    return NextResponse.json(
      { error: "A request ID, course, skill, and message are required.", code: "INVALID_REQUEST" },
      { status: 400, headers: noStore },
    );
  }
  // Redact once before hashing, provider transmission, or chat persistence.
  const learnerMessage = sanitizeTutorMemoryText(body.data.message, 8_000);
  const receiptInput = {
    ownerUserId: authz.session.user.id,
    action: "tutor.post" as const,
    requestId: body.data.requestId,
    inputHash: canonicalProviderOperationHash({
      courseId: body.data.courseId,
      skillId: body.data.skillId,
      message: learnerMessage.text,
      threadId: body.data.threadId ?? null,
    }),
  };

  try {
    const result = await executeProviderOperationIdempotently({
      ...receiptInput,
      execute: () => safeTutorExecution(() => withRateLimit(
    [
      { policy: "ai_tutor_minute", identity: { kind: "user", value: authz.session.user.id } },
      { policy: "ai_tutor_day", identity: { kind: "user", value: authz.session.user.id } },
    ],
    async () => {
  const repository = createContentRepository();
  const [course, location] = await Promise.all([
    repository.getCourse(body.data.courseId),
    repository.getSkillLocation(body.data.skillId),
  ]);
  if (!course || !location || location.course.id !== course.id) {
    return NextResponse.json({ error: "Published curriculum context not found." }, { status: 404 });
  }

  const requestedThreadId = body.data.threadId;
  if (requestedThreadId) {
    const [ownedThread] = await db
      .select({ id: chatThread.id, status: chatThread.status })
      .from(chatThread)
      .where(and(eq(chatThread.id, requestedThreadId), eq(chatThread.userId, authz.session.user.id)))
      .limit(1);
    if (!ownedThread || ownedThread.status === "deleted") {
      return NextResponse.json(
        { error: "Tutor thread not found.", code: "THREAD_NOT_FOUND" },
        { status: 404, headers: { "Cache-Control": "private, no-store" } },
      );
    }
    if (ownedThread.status !== "active") {
      return NextResponse.json(
        { error: "Reopen this archived thread before sending another message.", code: "THREAD_ARCHIVED" },
        { status: 409, headers: { "Cache-Control": "private, no-store" } },
      );
    }
  }

  const [[profile], currentConsents, encryptedOwnCredentials] = await Promise.all([
    db
      .select()
      .from(learnerProfile)
      .where(eq(learnerProfile.userId, authz.session.user.id))
      .limit(1),
    getCurrentConsents(authz.session.user.id),
    db
    .select({
      id: providerCredential.id,
      userId: providerCredential.userId,
      provider: providerCredential.provider,
      ciphertext: providerCredential.ciphertext,
      wrappedDataKey: providerCredential.wrappedDataKey,
      wrapIv: providerCredential.wrapIv,
      dataIv: providerCredential.dataIv,
      authTag: providerCredential.authTag,
      keyVersion: providerCredential.keyVersion,
      updatedAtToken: providerCredentialUpdatedAtToken,
      lastFour: providerCredential.lastFour,
      isPreferred: providerCredential.isPreferred,
    })
    .from(providerCredential)
    .where(
      and(
        eq(providerCredential.userId, authz.session.user.id),
        eq(providerCredential.status, "active"),
      ),
    )
    .orderBy(desc(providerCredential.isPreferred), asc(providerCredential.createdAt)),
  ]);
  if (!isCurrentConsentAccepted(currentConsents, "external_ai_routing")) {
    return NextResponse.json(
      { error: "Accept the current external-AI disclosure before using Codestead." },
      { status: 409 },
    );
  }
  const ownCredentials = (encryptedOwnCredentials as EncryptedRow[]).filter((credential) => {
    const purpose = consentPurposeForProvider(credential.provider);
    return purpose ? isCurrentConsentAccepted(currentConsents, purpose) : false;
  });

  if (!ownCredentials.some((credential) => credential.provider === "nvidia_nim")) {
    return NextResponse.json(
      { error: "Add and validate your required NVIDIA NIM key before using Codestead." },
      { status: 409 },
    );
  }

  const policies = await db
    .select()
    .from(providerPolicy)
    .where(and(eq(providerPolicy.operation, "tutor"), eq(providerPolicy.enabled, true)))
    .orderBy(asc(providerPolicy.priority));
  const policyByProvider = new Map<string, (typeof policies)[number]>();
  const policyByProviderModel = new Map<string, (typeof policies)[number]>();
  for (const policy of policies) {
    if (!policyByProvider.has(policy.provider)) policyByProvider.set(policy.provider, policy);
    policyByProviderModel.set(`${policy.provider}\u0000${policy.model}`, policy);
  }
  if (!policyByProvider.has("nvidia_nim")) {
    const defaultNimPolicy: (typeof policies)[number] = {
      id: randomUUID(),
      provider: "nvidia_nim",
      operation: "tutor",
      model: process.env.NVIDIA_NIM_TUTOR_MODEL ?? "meta/llama-3.1-8b-instruct",
      priority: 1,
      enabled: true,
      maxInputTokens: 16_000,
      maxOutputTokens: 1_500,
      timeoutMs: 30_000,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    policyByProvider.set("nvidia_nim", defaultNimPolicy);
    policyByProviderModel.set(`nvidia_nim\u0000${defaultNimPolicy.model}`, defaultNimPolicy);
  }

  const fallbackNow = new Date();
  const fallbackRows = isCurrentConsentAccepted(currentConsents, "admin_fallback_ai") ? await db
    .select({
      grantId: adminFallbackGrant.id,
      learnerId: adminFallbackGrant.learnerId,
      model: adminFallbackGrant.model,
      tokenBudget: adminFallbackGrant.tokenBudget,
      tokensUsed: adminFallbackGrant.tokensUsed,
      rupeeBudgetPaise: adminFallbackGrant.rupeeBudgetPaise,
      rupeesUsedPaise: adminFallbackGrant.rupeesUsedPaise,
      inputPaisePerMillionTokens: adminFallbackGrant.inputPaisePerMillionTokens,
      outputPaisePerMillionTokens: adminFallbackGrant.outputPaisePerMillionTokens,
      startsAt: adminFallbackGrant.startsAt,
      expiresAt: adminFallbackGrant.expiresAt,
      createdAt: adminFallbackGrant.createdAt,
      id: providerCredential.id,
      userId: providerCredential.userId,
      provider: providerCredential.provider,
      ciphertext: providerCredential.ciphertext,
      wrappedDataKey: providerCredential.wrappedDataKey,
      wrapIv: providerCredential.wrapIv,
      dataIv: providerCredential.dataIv,
      authTag: providerCredential.authTag,
      keyVersion: providerCredential.keyVersion,
      updatedAtToken: providerCredentialUpdatedAtToken,
      lastFour: providerCredential.lastFour,
      isPreferred: providerCredential.isPreferred,
    })
    .from(adminFallbackGrant)
    .innerJoin(providerCredential, eq(providerCredential.id, adminFallbackGrant.credentialId))
    .where(
      and(
        eq(adminFallbackGrant.learnerId, authz.session.user.id),
        eq(adminFallbackGrant.status, "active"),
        isNull(adminFallbackGrant.revokedAt),
        eq(adminFallbackGrant.provider, providerCredential.provider),
        lte(adminFallbackGrant.startsAt, fallbackNow),
        gt(adminFallbackGrant.expiresAt, fallbackNow),
        eq(providerCredential.status, "active"),
        sql`${adminFallbackGrant.tokensUsed} < ${adminFallbackGrant.tokenBudget}`,
        sql`${adminFallbackGrant.rupeesUsedPaise} < ${adminFallbackGrant.rupeeBudgetPaise}`,
        gt(adminFallbackGrant.inputPaisePerMillionTokens, 0),
        gt(adminFallbackGrant.outputPaisePerMillionTokens, 0),
      ),
    )
    .orderBy(
      asc(adminFallbackGrant.expiresAt),
      asc(adminFallbackGrant.createdAt),
      asc(adminFallbackGrant.id),
    )
    .limit(32) : [];
  const consentedFallbackRows = fallbackRows.filter((row) => {
    const purpose = consentPurposeForProvider(row.provider);
    return purpose ? isCurrentConsentAccepted(currentConsents, purpose) : false;
  });
  const dedupedFallbackRows = [] as typeof consentedFallbackRows;
  const fallbackDestinations = new Set<string>();
  for (const row of consentedFallbackRows) {
    const destination = `${row.id}\u0000${row.model}`;
    if (fallbackDestinations.has(destination)) continue;
    fallbackDestinations.add(destination);
    dedupedFallbackRows.push(row);
    if (dedupedFallbackRows.length >= 16) break;
  }
  const credentialSnapshots = new Map<string, ProviderCredentialSnapshot>(
    [...ownCredentials, ...dedupedFallbackRows].map((credential) => [credential.id, {
      id: credential.id,
      userId: credential.userId,
      keyVersion: credential.keyVersion,
      updatedAtToken: credential.updatedAtToken,
    }]),
  );

  const configuredMaster = process.env.CREDENTIAL_MASTER_KEY;
  if (!configuredMaster) return NextResponse.json({ error: "AI credential vault is unavailable." }, { status: 503 });
  const master = parseMasterKey(configuredMaster);
  const secretBuffers: string[] = [];
  const candidates: ProviderCandidate[] = [];
  try {
    for (const credential of ownCredentials) {
      const policy = policyByProvider.get(credential.provider);
      if (!policy) continue;
      let key: string;
      try {
        key = decrypt(credential, master);
      } catch {
        continue;
      }
      secretBuffers.push(key);
      candidates.push({
        ownerUserId: credential.userId,
        credentialId: credential.id,
        provider: credential.provider,
        apiKey: key,
        model: policy.model,
        maxOutputTokens: policy.maxOutputTokens,
        timeoutMs: policy.timeoutMs,
        source: "learner",
      });
    }
    for (const row of dedupedFallbackRows) {
      const policy = policyByProviderModel.get(`${row.provider}\u0000${row.model}`);
      if (!policy) continue;
      let key: string;
      try {
        key = decrypt(row as EncryptedRow, master);
      } catch {
        continue;
      }
      secretBuffers.push(key);
      candidates.push({
        ownerUserId: row.userId,
        credentialId: row.id,
        provider: row.provider,
        apiKey: key,
        model: row.model,
        maxOutputTokens: policy.maxOutputTokens,
        timeoutMs: policy.timeoutMs,
        source: "admin_fallback",
        fallbackGrantId: row.grantId,
        fallbackStartsAt: row.startsAt,
        fallbackExpiresAt: row.expiresAt,
        fallbackTokensRemaining: row.tokenBudget - row.tokensUsed,
        fallbackCostRemainingPaise: row.rupeeBudgetPaise - row.rupeesUsedPaise,
        fallbackInputPaisePerMillionTokens: row.inputPaisePerMillionTokens,
        fallbackOutputPaisePerMillionTokens: row.outputPaisePerMillionTokens,
      });
    }
    candidates.sort((left, right) => {
      const sourceOrder = Number(left.source === "admin_fallback") -
        Number(right.source === "admin_fallback");
      if (sourceOrder !== 0) return sourceOrder;
      const leftPriority = policyByProviderModel.get(`${left.provider}\u0000${left.model}`)?.priority ?? 999;
      const rightPriority = policyByProviderModel.get(`${right.provider}\u0000${right.model}`)?.priority ?? 999;
      return leftPriority - rightPriority;
    });

    const implementationLanguage = course.id === "dsa"
      ? profile?.dsaLanguage ?? "cpp"
      : course.runtime.language;
    const [structuredMemory, mentorRecommendation] = await Promise.all([
      loadTutorStructuredMemory({
        userId: authz.session.user.id,
        skillId: location.skill.id,
        preferredLanguage: implementationLanguage,
        selectedThreadId: requestedThreadId,
      }),
      loadMentorRecommendation(authz.session.user.id),
    ]);
    const tutorContext = {
      learnerId: authz.session.user.id,
      displayName: authz.session.user.name,
      course: { slug: course.id, version: course.version, title: course.title },
      lesson: {
        slug: location.skill.id,
        title: location.skill.title,
        objective: location.skill.outcomes.join(" "),
      },
      currentConcepts: [
        structuredMemory.currentConcept,
      ],
      activeMisconceptionTags: [...structuredMemory.activeMisconceptionTags],
      implementationLanguage,
      analogyPreference:
        profile?.analogyFrequency === "frequent"
          ? ("frequent" as const)
          : profile?.analogyFrequency === "neutral"
            ? ("neutral" as const)
            : ("helpful" as const),
      confirmedInterests: (profile?.analogyInterests ?? [])
        .filter((interest) => interest.confirmed)
        .map((interest) => interest.label)
        .slice(0, 5),
      learnerGoals: profile?.learningGoals ?? [],
      selectedTracks: profile?.selectedTracks ?? [],
      learningPreferences: {
        selfReportedLevel: profile?.selfReportedLevel,
        preferredSessionMinutes: profile?.preferredSessionMinutes,
        weeklyGoalMinutes: profile?.weeklyGoalMinutes,
      },
      recentRelevantSummary: structuredMemory.recentRelevantSummary ?? undefined,
      selectedThreadTail: structuredMemory.selectedThreadTail,
      evidenceRowsConsidered: structuredMemory.evidenceRowsConsidered,
      evidenceRowsCapped: structuredMemory.evidenceRowsCapped,
    };
    const messages = buildTutorMessages(tutorContext, learnerMessage.text);
    const tutorContextManifest = contextManifest(tutorContext);
    const routed = await routeTutorRequest({
      learnerId: authz.session.user.id,
      candidates,
      allowedProviders: [...new Set(
        [...ownCredentials, ...dedupedFallbackRows].map((credential) => credential.provider),
      )],
      messages,
      onFailure: async (failure) => {
        const snapshot = credentialSnapshots.get(failure.credentialId);
        if (snapshot) {
          await recordProviderCredentialOutcome({
            snapshot,
            outcome: { kind: "failure", code: failure.code },
          });
        }
      },
      reserveFallback: async (reservation) => reserveFallbackBudget({
        reservationId: reservation.reservationId,
        grantId: reservation.grantId,
        learnerId: authz.session.user.id,
        credentialId: reservation.credentialId,
        provider: reservation.provider,
        model: reservation.model,
        tokens: reservation.reservationTokens,
        costPaise: reservation.reservationCostPaise,
      }),
      reconcileFallback: async (reservation) => reconcileFallbackBudget({
        reservationId: reservation.reservationId,
        grantId: reservation.grantId,
        learnerId: authz.session.user.id,
        reservedTokens: reservation.reservationTokens,
        reservedCostPaise: reservation.reservationCostPaise,
        actualTokens: reservation.actualTokens,
        actualCostPaise: reservation.actualCostPaise,
      }),
    });
    const routedCredentialSnapshot = credentialSnapshots.get(routed.credentialId);
    if (
      containsCredentialOrHiddenEvidence(routed.result.content)
      || containsExposedCredentialVariant(routed.result.content, secretBuffers)
    ) {
      if (routedCredentialSnapshot) {
        await recordProviderCredentialOutcome({
          snapshot: routedCredentialSnapshot,
          outcome: { kind: "failure", code: "BAD_RESPONSE" },
        }).catch(() => undefined);
      }
      throw new Error("Provider response failed the credential and hidden-evidence boundary.");
    }
    if (routedCredentialSnapshot) {
      await recordProviderCredentialOutcome({
        snapshot: routedCredentialSnapshot,
        outcome: { kind: "success" },
      });
    }

    const callId = randomUUID();
    const persistedAt = new Date();
    const persistence = await db.transaction(async (tx) => {
      let threadId = requestedThreadId;
      let appendRejected = false;
      let persistedThread: { id: string; title: string; status: string; updatedAt: Date } | null = null;
      await tx.insert(modelCall).values({
        id: callId,
        userId: authz.session.user.id,
        credentialId: routed.credentialId,
        provider: routed.result.provider,
        model: routed.result.model,
        operation: "tutor",
        promptVersion: BUDDY_TUTOR_PROMPT_VERSION,
        contextManifest: { ...tutorContextManifest, credentialSource: routed.source },
        inputTokens: routed.result.inputTokens,
        outputTokens: routed.result.outputTokens,
        latencyMs: routed.result.latencyMs,
        status: "succeeded",
        requestHash: createHash("sha256").update(learnerMessage.text).digest("hex"),
        responseHash: createHash("sha256").update(routed.result.content).digest("hex"),
      });

      if (threadId) {
        // The conditional update is the server-authoritative append gate. In
        // PostgreSQL it takes a row lock and rechecks the active predicate
        // after a concurrent archive commits, so an archived thread can never
        // receive a later message even if it was active during preflight.
        const [activeThread] = await tx
          .update(chatThread)
          .set({ updatedAt: persistedAt })
          .where(and(
            eq(chatThread.id, threadId),
            eq(chatThread.userId, authz.session.user.id),
            eq(chatThread.status, "active"),
          ))
          .returning({
            id: chatThread.id,
            title: chatThread.title,
            status: chatThread.status,
            updatedAt: chatThread.updatedAt,
          });
        if (!activeThread) appendRejected = true;
        else persistedThread = activeThread;
      } else {
        const [created] = await tx
          .insert(chatThread)
          .values({
            userId: authz.session.user.id,
            title: `${course.title}: ${location.skill.title}`,
          })
          .returning({
            id: chatThread.id,
            title: chatThread.title,
            status: chatThread.status,
            updatedAt: chatThread.updatedAt,
          });
        if (!created) throw new Error("Tutor thread creation failed.");
        threadId = created.id;
        persistedThread = created;
      }

      if (!appendRejected) {
        await tx.insert(chatMessage).values([
          {
            threadId: threadId!,
            role: "user",
            content: learnerMessage.text,
            curriculumRefs: [course.id, location.module.id, location.skill.id],
          },
          {
            threadId: threadId!,
            role: "assistant",
            content: routed.result.content,
            modelCallId: callId,
            curriculumRefs: [course.id, location.module.id, location.skill.id],
          },
        ]);
      }
      return { threadId, appendRejected, persistedThread };
    });

    if (persistence.appendRejected) {
      return NextResponse.json(
        { error: "This tutor thread was archived in another tab. Reopen it before sending again.", code: "THREAD_ARCHIVED" },
        { status: 409, headers: { "Cache-Control": "private, no-store" } },
      );
    }

    return NextResponse.json(
      {
        content: routed.result.content,
        threadId: persistence.threadId,
        thread: persistence.persistedThread ? {
          id: persistence.persistedThread.id,
          title: persistence.persistedThread.title,
          status: persistence.persistedThread.status,
          updatedAt: persistence.persistedThread.updatedAt.toISOString(),
        } : undefined,
        provider: routed.result.provider,
        model: routed.result.model,
        source: routed.source,
        callId,
        contextManifest: tutorContextManifest,
        mentorRecommendation,
        acceptedMessage: learnerMessage.text,
        messageSanitized: learnerMessage.redacted || learnerMessage.truncated,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    // Provider and vault details stay server-side. The authored fallback is
    // the only learner-visible outage message, even for normalized failures.
    void error;
    return NextResponse.json(
      { error: AUTHORED_TUTOR_FALLBACK_MESSAGE, degraded: true },
      { status: 503 },
    );
  } finally {
    master.fill(0);
    // JavaScript strings cannot be reliably zeroed; keep their lifetime bounded to this request.
    secretBuffers.fill("");
      }
    },
  )),
    });
    return NextResponse.json(result.body, {
      status: result.status,
      headers: { ...noStore, "X-Idempotent-Replay": result.replayed ? "true" : "false" },
    });
  } catch (error) {
    if (error instanceof ProviderOperationIdempotencyError) {
      return NextResponse.json(
        {
          error: error.message,
          code: error.code,
          ...(error.code === "IDEMPOTENCY_WAIT_TIMEOUT" ? { retryable: true } : {}),
        },
        {
          status: error.code === "IDEMPOTENCY_KEY_REUSED" ? 409 : 503,
          headers: noStore,
        },
      );
    }
    return NextResponse.json(
      { error: AUTHORED_TUTOR_FALLBACK_MESSAGE, degraded: true },
      { status: 503, headers: noStore },
    );
  }
}
