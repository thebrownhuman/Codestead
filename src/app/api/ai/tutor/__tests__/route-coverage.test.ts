import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  select: vi.fn(),
  transaction: vi.fn(),
  txInsert: vi.fn(),
  txValues: vi.fn(),
  txCreateReturning: vi.fn(),
  txUpdate: vi.fn(),
  txSet: vi.fn(),
  txWhere: vi.fn(),
  txUpdateReturning: vi.fn(),
  requireAuth: vi.fn(),
  gateClosedBookCapability: vi.fn(),
  withRateLimit: vi.fn(),
  executeProviderOperationIdempotently: vi.fn(),
  canonicalProviderOperationHash: vi.fn(),
  routeTutorRequest: vi.fn(),
  getCourse: vi.fn(),
  getSkillLocation: vi.fn(),
  getCurrentConsents: vi.fn(),
  isCurrentConsentAccepted: vi.fn(),
  consentPurposeForProvider: vi.fn(),
  parseMasterKey: vi.fn(),
  openCredential: vi.fn(),
  loadMentorRecommendation: vi.fn(),
  loadTutorStructuredMemory: vi.fn(),
  sanitizeTutorMemoryText: vi.fn(),
  recordProviderCredentialOutcome: vi.fn(),
  reserveFallbackBudget: vi.fn(),
  reconcileFallbackBudget: vi.fn(),
}));

const state = vi.hoisted(() => ({
  selectResults: [] as unknown[][],
  acceptedPurposes: new Set<string>(),
  createdRows: [] as unknown[],
  activeRows: [] as unknown[],
  persistedValues: [] as unknown[],
}));

vi.mock("@/lib/db/client", () => ({
  db: {
    select: mocks.select,
    transaction: mocks.transaction,
  },
}));
vi.mock("@/lib/http/authz", () => ({ requireAuth: mocks.requireAuth }));
vi.mock("@/lib/exams/capability-gate", () => ({ gateClosedBookCapability: mocks.gateClosedBookCapability }));
vi.mock("@/lib/security/rate-limit", () => ({ withRateLimit: mocks.withRateLimit }));
vi.mock("@/lib/ai/provider-operation-idempotency", () => {
  class ProviderOperationIdempotencyError extends Error {
    constructor(
      readonly code: "IDEMPOTENCY_KEY_REUSED" | "IDEMPOTENCY_WAIT_TIMEOUT" | "IDEMPOTENCY_RECEIPT_UNAVAILABLE",
      message: string,
    ) {
      super(message);
      this.name = "ProviderOperationIdempotencyError";
    }
  }
  return {
    ProviderOperationIdempotencyError,
    canonicalProviderOperationHash: mocks.canonicalProviderOperationHash,
    executeProviderOperationIdempotently: mocks.executeProviderOperationIdempotently,
  };
});
vi.mock("@/lib/ai/router", () => ({ routeTutorRequest: mocks.routeTutorRequest }));
vi.mock("@/lib/content", () => ({
  createContentRepository: () => ({
    getCourse: mocks.getCourse,
    getSkillLocation: mocks.getSkillLocation,
  }),
}));
vi.mock("@/lib/privacy/consent", () => ({
  getCurrentConsents: mocks.getCurrentConsents,
  isCurrentConsentAccepted: mocks.isCurrentConsentAccepted,
  consentPurposeForProvider: mocks.consentPurposeForProvider,
}));
vi.mock("@/lib/security/credential-vault", () => ({
  parseMasterKey: mocks.parseMasterKey,
  openCredential: mocks.openCredential,
}));
vi.mock("@/lib/ai/tutor-memory", () => ({
  TUTOR_MEMORY_LIMITS: {
    evidenceRows: 40,
    misconceptionTags: 8,
    goals: 8,
    goalChars: 240,
    selectedTracks: 12,
    summaryChars: 2_000,
    threadMessages: 6,
    threadMessageChars: 1_200,
    threadTotalChars: 4_800,
  },
  loadMentorRecommendation: mocks.loadMentorRecommendation,
  loadTutorStructuredMemory: mocks.loadTutorStructuredMemory,
  sanitizeTutorMemoryText: mocks.sanitizeTutorMemoryText,
  sanitizeTutorMemoryList: (value: unknown, limit: number, maximum: number) =>
    Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string").slice(0, limit).map((item) => item.slice(0, maximum))
      : [],
}));
vi.mock("@/lib/ai/provider-credential-outcome", () => ({
  providerCredentialUpdatedAtToken: "updated-at-token",
  recordProviderCredentialOutcome: mocks.recordProviderCredentialOutcome,
}));
vi.mock("@/lib/ai/fallback-budget", () => ({
  reserveFallbackBudget: mocks.reserveFallbackBudget,
  reconcileFallbackBudget: mocks.reconcileFallbackBudget,
}));

import { ProviderError } from "@/lib/ai/types";
import { POST } from "../route";

const THREAD_ID = "10000000-0000-4000-8000-000000000001";
const REQUEST_ID = "20000000-0000-4000-8000-000000000001";
const CREDENTIAL_ID = "30000000-0000-4000-8000-000000000001";
const FALLBACK_CREDENTIAL_ID = "40000000-0000-4000-8000-000000000001";
const originalMasterKey = process.env.CREDENTIAL_MASTER_KEY;
const originalNimModel = process.env.NVIDIA_NIM_TUTOR_MODEL;

const course = {
  id: "python",
  version: "2026.07",
  title: "Python Foundations",
  runtime: { language: "python" },
};
const location = {
  course: { id: "python" },
  module: { id: "python.values" },
  skill: {
    id: "python.values.scalars",
    title: "Scalar values",
    outcomes: ["Explain scalar values", "Use scalar values"],
  },
};
const credential = {
  id: CREDENTIAL_ID,
  userId: "learner-1",
  provider: "nvidia_nim",
  ciphertext: "ciphertext",
  wrappedDataKey: "wrapped-key",
  wrapIv: "wrap-iv",
  dataIv: "data-iv",
  authTag: "auth-tag",
  keyVersion: 3,
  updatedAtToken: "2026-07-12T10:00:00.000000Z",
  lastFour: "WXYZ",
  isPreferred: true,
};
const nimPolicy = {
  id: "policy-nim",
  provider: "nvidia_nim",
  operation: "tutor",
  model: "test/nim-model",
  priority: 2,
  enabled: true,
  maxInputTokens: 16_000,
  maxOutputTokens: 1_000,
  timeoutMs: 20_000,
  createdAt: new Date("2026-07-12T00:00:00.000Z"),
  updatedAt: new Date("2026-07-12T00:00:00.000Z"),
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function selectBuilder(rows: unknown[]) {
  const builder: Record<string, ReturnType<typeof vi.fn>> = {};
  builder.from = vi.fn(() => builder);
  builder.where = vi.fn(() => builder);
  builder.limit = vi.fn(async () => rows);
  builder.orderBy = vi.fn(() => builder);
  builder.innerJoin = vi.fn(() => builder);
  builder.then = vi.fn((
    resolve: (value: unknown[]) => unknown,
    reject: (reason?: unknown) => unknown,
  ) => Promise.resolve(rows).then(resolve, reject));
  return builder;
}

function tutorRequest(overrides: Record<string, unknown> = {}) {
  return new NextRequest("https://learn.test/api/ai/tutor", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      requestId: REQUEST_ID,
      courseId: course.id,
      skillId: location.skill.id,
      message: "Explain scalar values.",
      threadId: THREAD_ID,
      ...overrides,
    }),
  });
}

function queueExecution(input: {
  threadId?: string;
  ownedStatus?: string;
  profile?: Record<string, unknown> | null;
  credentials?: unknown[];
  policies?: unknown[];
  fallbackRows?: unknown[];
} = {}) {
  const threadId = Object.hasOwn(input, "threadId") ? input.threadId : THREAD_ID;
  if (threadId) state.selectResults.push(input.ownedStatus === "missing" ? [] : [{
    id: threadId,
    status: input.ownedStatus ?? "active",
  }]);
  state.selectResults.push(
    input.profile === null ? [] : [input.profile ?? {}],
    input.credentials ?? [credential],
    input.policies ?? [nimPolicy],
  );
  if (state.acceptedPurposes.has("admin_fallback_ai")) {
    state.selectResults.push(input.fallbackRows ?? []);
  }
}

function providerSuccess(credentialId = CREDENTIAL_ID, source: "learner" | "admin_fallback" = "learner") {
  return {
    credentialId,
    source,
    result: {
      provider: "nvidia_nim",
      model: "test/nim-model",
      content: "A scalar stores one value.",
      finishReason: "stop",
      inputTokens: 40,
      outputTokens: 20,
      latencyMs: 25,
      requestId: "provider-request-1",
    },
  };
}

describe("tutor route durable execution coverage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.selectResults.length = 0;
    state.persistedValues.length = 0;
    state.acceptedPurposes.clear();
    state.acceptedPurposes.add("external_ai_routing");
    state.acceptedPurposes.add("provider:nvidia_nim");
    state.createdRows = [{
      id: THREAD_ID,
      title: "Python Foundations: Scalar values",
      status: "active",
      updatedAt: new Date("2026-07-12T10:15:00.000Z"),
    }];
    state.activeRows = [...state.createdRows];

    process.env.CREDENTIAL_MASTER_KEY = Buffer.alloc(32, 7).toString("base64");
    delete process.env.NVIDIA_NIM_TUTOR_MODEL;
    mocks.requireAuth.mockResolvedValue({
      session: { user: { id: "learner-1", name: "Asha" } },
      response: null,
    });
    mocks.gateClosedBookCapability.mockResolvedValue({ allowed: true });
    mocks.withRateLimit.mockImplementation(async (_policies, callback) => callback());
    mocks.canonicalProviderOperationHash.mockReturnValue("a".repeat(64));
    mocks.executeProviderOperationIdempotently.mockImplementation(async (input) => ({
      ...(await input.execute()),
      replayed: false,
    }));
    mocks.getCourse.mockResolvedValue(course);
    mocks.getSkillLocation.mockResolvedValue(location);
    mocks.getCurrentConsents.mockResolvedValue(new Map());
    mocks.isCurrentConsentAccepted.mockImplementation((_current, purpose) => state.acceptedPurposes.has(purpose));
    mocks.consentPurposeForProvider.mockImplementation((provider) =>
      ["nvidia_nim", "openai"].includes(provider) ? `provider:${provider}` : null);
    mocks.parseMasterKey.mockReturnValue(Buffer.alloc(32, 9));
    mocks.openCredential.mockImplementation((row) => `decrypted-${row.id}`);
    mocks.sanitizeTutorMemoryText.mockImplementation((value: string, maximum: number) => {
      const redacted = /nvapi-[A-Za-z0-9_-]{16,}/.test(value);
      const text = value.replace(/nvapi-[A-Za-z0-9_-]{16,}/g, "[REDACTED]").slice(0, maximum);
      return { text, redacted, truncated: text.length < value.length && !redacted };
    });
    mocks.loadTutorStructuredMemory.mockResolvedValue({
      currentConcept: {
        slug: location.skill.id,
        mastery: 0.45,
        confidence: 0.6,
        status: "learning",
        languageContext: "python",
        criticalRequirementsMet: false,
        lastEvidenceAt: null,
        persisted: true,
      },
      activeMisconceptionTags: ["assignment-vs-equality"],
      evidenceRowsConsidered: 2,
      evidenceRowsCapped: false,
      recentRelevantSummary: null,
      selectedThreadTail: null,
    });
    mocks.loadMentorRecommendation.mockResolvedValue({
      state: "ready",
      policyVersion: "personalized-mentor-v1",
      dailyChallenge: {
        skillId: location.skill.id,
        skillTitle: location.skill.title,
        reason: "lowest_confidence",
        reasonText: "This is the lowest-confidence skill in the bounded verified evidence window.",
        instruction: "Trace one small example.",
        targetMinutes: 10,
        source: "stored_verified_evidence",
      },
      learningSignal: {
        pace: "insufficient_evidence",
        confidence: "developing",
        evidence: { verifiedMasteryRows: 1, verifiedRecentAttempts: 1, lookbackDays: 30 },
      },
      encouragement: "One focused rep is enough.",
      planSuggestion: null,
      authority: {
        officialPlanChanged: false,
        officialPlanRevisionId: null,
        statement: "Codestead cannot change the official roadmap.",
      },
      contextPolicy: {
        ownerBound: true,
        included: ["verified concept mastery"],
        explicitlyExcluded: ["provider keys", "hidden tests", "other learners"],
        caps: {},
      },
    });
    mocks.routeTutorRequest.mockResolvedValue(providerSuccess());
    mocks.recordProviderCredentialOutcome.mockResolvedValue(undefined);
    mocks.reserveFallbackBudget.mockResolvedValue(true);
    mocks.reconcileFallbackBudget.mockResolvedValue(undefined);

    mocks.select.mockImplementation(() => selectBuilder(state.selectResults.shift() ?? []));
    mocks.txCreateReturning.mockImplementation(async () => state.createdRows);
    mocks.txUpdateReturning.mockImplementation(async () => state.activeRows);
    mocks.txValues.mockImplementation((values: unknown) => {
      state.persistedValues.push(values);
      if (Array.isArray(values) || (isRecord(values) && "operation" in values)) {
        return Promise.resolve();
      }
      return { returning: mocks.txCreateReturning };
    });
    mocks.txInsert.mockImplementation(() => ({ values: mocks.txValues }));
    mocks.txWhere.mockImplementation(() => ({ returning: mocks.txUpdateReturning }));
    mocks.txSet.mockImplementation(() => ({ where: mocks.txWhere }));
    mocks.txUpdate.mockImplementation(() => ({ set: mocks.txSet }));
    mocks.transaction.mockImplementation(async (callback) => callback({
      insert: mocks.txInsert,
      update: mocks.txUpdate,
    }));
  });

  afterEach(() => {
    if (originalMasterKey === undefined) delete process.env.CREDENTIAL_MASTER_KEY;
    else process.env.CREDENTIAL_MASTER_KEY = originalMasterKey;
    if (originalNimModel === undefined) delete process.env.NVIDIA_NIM_TUTOR_MODEL;
    else process.env.NVIDIA_NIM_TUTOR_MODEL = originalNimModel;
  });

  it.each([
    [null, location],
    [course, null],
    [course, { ...location, course: { id: "javascript" } }],
  ])("rejects missing or cross-course published context", async (resolvedCourse, resolvedLocation) => {
    mocks.getCourse.mockResolvedValueOnce(resolvedCourse);
    mocks.getSkillLocation.mockResolvedValueOnce(resolvedLocation);
    const response = await POST(tutorRequest({ threadId: undefined }));
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Published curriculum context not found." });
    expect(mocks.select).not.toHaveBeenCalled();
  });

  it("requires external routing consent before decrypting any credential", async () => {
    state.acceptedPurposes.delete("external_ai_routing");
    queueExecution();
    const response = await POST(tutorRequest());
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "Accept the current external-AI disclosure before using Codestead." });
    expect(mocks.openCredential).not.toHaveBeenCalled();
  });

  it("filters unrecognized or unconsented credentials and still requires an owned NIM key", async () => {
    queueExecution({
      credentials: [
        { ...credential, id: "unknown-credential", provider: "unknown_provider" },
        { ...credential, id: "openai-credential", provider: "openai" },
      ],
    });
    const response = await POST(tutorRequest());
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "Add and validate your required NVIDIA NIM key before using Codestead.",
    });
    expect(mocks.openCredential).not.toHaveBeenCalled();
  });

  it("returns a safe vault-unavailable response after installing the default NIM policy", async () => {
    delete process.env.CREDENTIAL_MASTER_KEY;
    process.env.NVIDIA_NIM_TUTOR_MODEL = "configured/default-nim";
    queueExecution({ policies: [] });
    const response = await POST(tutorRequest());
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "AI credential vault is unavailable." });
    expect(mocks.parseMasterKey).not.toHaveBeenCalled();
  });

  it("redacts once, routes eligible learner/fallback credentials, records CAS outcomes, and persists an active append", async () => {
    state.acceptedPurposes.add("provider:openai");
    state.acceptedPurposes.add("admin_fallback_ai");
    const fallbackRow = {
      ...credential,
      id: FALLBACK_CREDENTIAL_ID,
      userId: "admin-1",
      provider: "openai",
      grantId: "fallback-grant-1",
      learnerId: "learner-1",
      model: "test/nim-model",
      tokenBudget: 2_000,
      tokensUsed: 250,
      rupeeBudgetPaise: 10_000,
      rupeesUsedPaise: 100,
      inputPaisePerMillionTokens: 100_000,
      outputPaisePerMillionTokens: 200_000,
      startsAt: new Date("2026-07-11T00:00:00.000Z"),
      expiresAt: new Date("2026-07-13T00:00:00.000Z"),
      isPreferred: false,
    };
    const openAiPolicy = { ...nimPolicy, id: "policy-openai", provider: "openai", priority: 1 };
    queueExecution({
      profile: {
        analogyFrequency: "frequent",
        analogyInterests: [{ label: "cricket", confirmed: true }, { label: "music", confirmed: false }],
        learningGoals: ["Build confidence"],
        selectedTracks: ["python"],
        selfReportedLevel: "beginner",
        preferredSessionMinutes: 25,
        weeklyGoalMinutes: 120,
      },
      policies: [nimPolicy, openAiPolicy],
      fallbackRows: [fallbackRow, { ...fallbackRow, id: "ignored-fallback", provider: "unknown_provider" }],
    });
    mocks.loadTutorStructuredMemory.mockResolvedValueOnce({
      currentConcept: {
        slug: location.skill.id,
        mastery: 0.45,
        confidence: 0.6,
        status: "learning",
        languageContext: "python",
        criticalRequirementsMet: false,
        lastEvidenceAt: null,
        persisted: true,
      },
      activeMisconceptionTags: ["assignment-vs-equality"],
      evidenceRowsConsidered: 2,
      evidenceRowsCapped: false,
      recentRelevantSummary: { text: "Practice scalars", createdAt: "2026-07-11T00:00:00.000Z" },
      selectedThreadTail: null,
    });
    mocks.routeTutorRequest.mockImplementationOnce(async (input) => {
      expect(input.candidates).toHaveLength(2);
      expect(input.candidates.map((candidate: { source: string }) => candidate.source)).toEqual([
        "learner",
        "admin_fallback",
      ]);
      expect(input.allowedProviders).toEqual(["nvidia_nim", "openai"]);
      expect(JSON.stringify(input.messages)).toContain("[REDACTED]");
      expect(JSON.stringify(input.messages)).not.toContain("nvapi-");
      await input.onFailure({
        credentialId: "unknown-credential",
        provider: "openai",
        code: "UNAVAILABLE",
      });
      await input.onFailure({
        credentialId: FALLBACK_CREDENTIAL_ID,
        provider: "openai",
        code: "RATE_LIMIT",
      });
      await input.reserveFallback({
        reservationId: "50000000-0000-4000-8000-000000000001",
        grantId: "fallback-grant-1",
        credentialId: FALLBACK_CREDENTIAL_ID,
        provider: "openai",
        model: "test/nim-model",
        reservationTokens: 120,
        reservationCostPaise: 30,
      });
      await input.reconcileFallback({
        reservationId: "50000000-0000-4000-8000-000000000001",
        grantId: "fallback-grant-1",
        credentialId: FALLBACK_CREDENTIAL_ID,
        provider: "openai",
        model: "test/nim-model",
        reservationTokens: 120,
        reservationCostPaise: 30,
        actualTokens: 60,
        actualCostPaise: 12,
      });
      return providerSuccess(FALLBACK_CREDENTIAL_ID, "admin_fallback");
    });

    const response = await POST(tutorRequest({
      message: "Explain nvapi-ABCDEFGHIJKLMNOPQRST without exposing it.",
    }));
    expect(response.status).toBe(200);
    expect(response.headers.get("x-idempotent-replay")).toBe("false");
    expect(await response.json()).toMatchObject({
      content: "A scalar stores one value.",
      threadId: THREAD_ID,
      source: "admin_fallback",
      acceptedMessage: "Explain [REDACTED] without exposing it.",
      messageSanitized: true,
      thread: { id: THREAD_ID, status: "active" },
      mentorRecommendation: {
        state: "ready",
        dailyChallenge: { source: "stored_verified_evidence" },
        authority: { officialPlanChanged: false },
      },
    });
    expect(mocks.recordProviderCredentialOutcome).toHaveBeenCalledWith(expect.objectContaining({
      outcome: { kind: "failure", code: "RATE_LIMIT" },
    }));
    expect(mocks.recordProviderCredentialOutcome).toHaveBeenCalledWith(expect.objectContaining({
      outcome: { kind: "success" },
    }));
    expect(mocks.reserveFallbackBudget).toHaveBeenCalledWith({
      reservationId: "50000000-0000-4000-8000-000000000001",
      grantId: "fallback-grant-1",
      learnerId: "learner-1",
      credentialId: FALLBACK_CREDENTIAL_ID,
      provider: "openai",
      model: "test/nim-model",
      tokens: 120,
      costPaise: 30,
    });
    expect(mocks.reconcileFallbackBudget).toHaveBeenCalledWith(expect.objectContaining({
      actualTokens: 60,
      actualCostPaise: 12,
    }));
    expect(JSON.stringify(state.persistedValues)).not.toContain("nvapi-");
    expect(JSON.stringify(state.persistedValues)).not.toContain("decrypted-");
  });

  it("treats a lost active-thread compare-and-set as an archived-tab conflict and skips chat messages", async () => {
    queueExecution();
    state.activeRows = [];
    const response = await POST(tutorRequest());
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "THREAD_ARCHIVED" });
    expect(state.persistedValues.some(Array.isArray)).toBe(false);
  });

  it("creates a new DSA thread with defaults and reports an unsanitized message accurately", async () => {
    const dsaCourse = { ...course, id: "dsa", title: "Data Structures", runtime: { language: "typescript" } };
    const dsaLocation = {
      ...location,
      course: { id: "dsa" },
      module: { id: "dsa.arrays" },
      skill: { ...location.skill, id: "dsa.arrays.basics", title: "Array basics" },
    };
    mocks.getCourse.mockResolvedValueOnce(dsaCourse);
    mocks.getSkillLocation.mockResolvedValueOnce(dsaLocation);
    queueExecution({ threadId: undefined, profile: { analogyFrequency: "neutral" }, policies: [] });
    state.createdRows = [{
      id: THREAD_ID,
      title: "Data Structures: Array basics",
      status: "active",
      updatedAt: new Date("2026-07-12T10:20:00.000Z"),
    }];

    const response = await POST(tutorRequest({
      threadId: undefined,
      courseId: "dsa",
      skillId: "dsa.arrays.basics",
      message: "Explain array indexing.",
    }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      acceptedMessage: "Explain array indexing.",
      messageSanitized: false,
      thread: { title: "Data Structures: Array basics" },
    });
    expect(mocks.loadTutorStructuredMemory).toHaveBeenCalledWith(expect.objectContaining({
      preferredLanguage: "cpp",
      selectedThreadId: undefined,
    }));
    expect(mocks.loadMentorRecommendation).toHaveBeenCalledWith("learner-1");
    expect(state.persistedValues.some(Array.isArray)).toBe(true);
  });

  it("converts a failed new-thread insert into a durable authored fallback", async () => {
    queueExecution({ threadId: undefined, profile: null });
    state.createdRows = [];
    const response = await POST(tutorRequest({ threadId: undefined }));
    expect(response.status).toBe(503);
    expect(response.headers.get("x-idempotent-replay")).toBe("false");
    expect(await response.json()).toMatchObject({ degraded: true });
    expect(state.persistedValues.some(Array.isArray)).toBe(false);
  });

  it("returns only the authored outage response for normalized and unexpected provider errors", async () => {
    queueExecution({ profile: null });
    mocks.routeTutorRequest.mockRejectedValueOnce(new ProviderError("Provider key secret-XYZ timed out.", "TIMEOUT"));
    const providerFailure = await POST(tutorRequest());
    expect(providerFailure.status).toBe(503);
    const providerPayload = await providerFailure.json();
    expect(providerPayload).toMatchObject({ degraded: true });
    expect(JSON.stringify(providerPayload)).not.toContain("secret-XYZ");

    queueExecution({ profile: null });
    mocks.routeTutorRequest.mockRejectedValueOnce(new Error("secret internal transport detail"));
    const unexpected = await POST(tutorRequest());
    expect(unexpected.status).toBe(503);
    const payload = await unexpected.json();
    expect(payload).toMatchObject({ degraded: true });
    expect(JSON.stringify(payload)).not.toContain("transport detail");
  });

  it.each([
    ["21st", `21st_sk_${"A1b2".repeat(8)}`, "learner"],
    ["NVIDIA", `nvapi-${"A1b2".repeat(8)}`, "learner"],
    ["AWS", `AKIA${"A".repeat(16)}`, "learner"],
    ["Slack", `xoxb-${"1234567890-abcdef"}`, "learner"],
    ["labelled custom", "access token=abcdefghijklmnop", "admin_fallback"],
  ] as const)("rejects a provider response containing a %s credential without persistence", async (
    _label,
    candidate,
    source,
  ) => {
    if (source === "admin_fallback") {
      state.acceptedPurposes.add("admin_fallback_ai");
      queueExecution({
        fallbackRows: [{
          ...credential,
          id: FALLBACK_CREDENTIAL_ID,
          userId: "admin-1",
          grantId: "fallback-grant-1",
          learnerId: "learner-1",
          model: "test/nim-model",
          tokenBudget: 2_000,
          tokensUsed: 0,
          rupeeBudgetPaise: 10_000,
          rupeesUsedPaise: 0,
          inputPaisePerMillionTokens: 100_000,
          outputPaisePerMillionTokens: 200_000,
          startsAt: new Date("2026-07-11T00:00:00.000Z"),
          expiresAt: new Date("2026-07-13T00:00:00.000Z"),
        }],
      });
    } else {
      queueExecution();
    }
    mocks.routeTutorRequest.mockResolvedValueOnce({
      ...providerSuccess(source === "admin_fallback" ? FALLBACK_CREDENTIAL_ID : CREDENTIAL_ID, source),
      result: {
        ...providerSuccess().result,
        content: `Unsafe echoed material: ${candidate}`,
      },
    });

    const response = await POST(tutorRequest());
    expect(response.status).toBe(503);
    const payload = await response.json();
    expect(payload).toEqual({ error: expect.any(String), degraded: true });
    expect(JSON.stringify(payload)).not.toContain(candidate);
    expect(JSON.stringify(state.persistedValues)).not.toContain(candidate);
    expect(state.persistedValues).toHaveLength(0);
    expect(mocks.recordProviderCredentialOutcome).toHaveBeenCalledWith(expect.objectContaining({
      outcome: { kind: "failure", code: "BAD_RESPONSE" },
    }));
    expect(mocks.recordProviderCredentialOutcome).not.toHaveBeenCalledWith(expect.objectContaining({
      outcome: { kind: "success" },
    }));
  });

  it("rejects an echoed prefixless admin-fallback credential and never persists it", async () => {
    const prefixlessCredential = "Q7w9Er2Ty4Ui6Op8As0Df3Gh";
    state.acceptedPurposes.add("admin_fallback_ai");
    queueExecution({
      fallbackRows: [{
        ...credential,
        id: FALLBACK_CREDENTIAL_ID,
        userId: "admin-1",
        grantId: "fallback-grant-1",
        learnerId: "learner-1",
        model: "test/nim-model",
        tokenBudget: 2_000,
        tokensUsed: 0,
        rupeeBudgetPaise: 10_000,
        rupeesUsedPaise: 0,
        inputPaisePerMillionTokens: 100_000,
        outputPaisePerMillionTokens: 200_000,
        startsAt: new Date("2026-07-11T00:00:00.000Z"),
        expiresAt: new Date("2026-07-13T00:00:00.000Z"),
      }],
    });
    mocks.openCredential.mockImplementation((row) => row.id === FALLBACK_CREDENTIAL_ID
      ? prefixlessCredential
      : `decrypted-${row.id}`);
    mocks.routeTutorRequest.mockResolvedValueOnce({
      ...providerSuccess(FALLBACK_CREDENTIAL_ID, "admin_fallback"),
      result: { ...providerSuccess().result, content: `Echo: ${prefixlessCredential}` },
    });

    const response = await POST(tutorRequest());
    expect(response.status).toBe(503);
    const payload = await response.json();
    expect(JSON.stringify(payload)).not.toContain(prefixlessCredential);
    expect(JSON.stringify(state.persistedValues)).not.toContain(prefixlessCredential);
    expect(state.persistedValues).toHaveLength(0);
    expect(mocks.recordProviderCredentialOutcome).toHaveBeenCalledWith(expect.objectContaining({
      outcome: { kind: "failure", code: "BAD_RESPONSE" },
    }));
  });
});
