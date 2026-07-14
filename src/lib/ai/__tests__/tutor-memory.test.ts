import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("@/lib/db/client", () => ({ pool: { query: mocks.query } }));

import {
  loadMentorRecommendation,
  loadTutorStructuredMemory,
  sanitizeTutorMemoryList,
  sanitizeTutorMemoryText,
  TUTOR_MEMORY_LIMITS,
} from "../tutor-memory";

const THREAD = "51000000-0000-4000-8000-000000000001";
const CONCEPT = "52000000-0000-4000-8000-000000000001";
const ENROLLMENT = "53000000-0000-4000-8000-000000000001";
const NOW = new Date("2026-07-12T10:00:00.000Z");
const FAKE_NVIDIA_KEY = ["nvapi", "-", "abcdefghijklmnopqrstuvwxyz123456"].join("");
const FAKE_OPENAI_KEY = ["sk", "-", "abcdefghijklmnopqrstuvwxyz123456"].join("");

function evidence(id: string, itemVariantId: string, misconceptionTags: string[]) {
  return {
    id,
    evidence_type: JSON.stringify({
      version: 1,
      origin: "deterministic_spec",
      skillId: "python.values.scalars",
      itemVariantId,
      evidenceLevel: "E3",
      assistanceLevel: "A0",
      correct: false,
      learningOpportunity: true,
      solutionRevealed: false,
      misconceptionTags,
      languageContext: "python",
    }),
    source_type: "deterministic_attempt",
    source_id: id,
    score: 0,
    weight: 1,
    critical_criterion: "core",
    validity: "valid",
    policy_version: "learning-v1",
    recorded_by: "adaptive-deterministic-engine",
    recorded_at: NOW,
  };
}

function masteryRow() {
  return {
    concept_id: CONCEPT,
    slug: "python.values.scalars",
    user_id: "learner-1",
    enrollment_id: ENROLLMENT,
    language_context: "python",
    score: 0.62,
    confidence: 0.71,
    status: "practicing",
    critical_requirements_met: false,
    last_evidence_at: NOW,
    last_practiced_at: NOW,
    next_review_at: null,
    row_version: "3",
  };
}

describe("bounded tutor structured memory", () => {
  beforeEach(() => vi.clearAllMocks());

  it("loads owner/current-skill mastery, valid active misconception tags, and the latest safe summary for a new thread", async () => {
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes("from concept c")) return { rows: [masteryRow()] };
      if (sql.includes("from email_outbox")) {
        return { rows: [{
          summary: `Practice scalar values. api key: ${FAKE_NVIDIA_KEY}`,
          created_at: NOW,
        }] };
      }
      if (sql.includes("from mastery_evidence")) {
        return { rows: [
          evidence("54000000-0000-4000-8000-000000000002", "variant-b", ["assignment.equality"]),
          evidence("54000000-0000-4000-8000-000000000001", "variant-a", ["assignment.equality"]),
        ] };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    });

    const memory = await loadTutorStructuredMemory({
      userId: "learner-1",
      skillId: "python.values.scalars",
      preferredLanguage: "python",
    });
    expect(memory.currentConcept).toMatchObject({
      slug: "python.values.scalars",
      mastery: 0.62,
      confidence: 0.71,
      status: "practicing",
      persisted: true,
    });
    expect(memory.activeMisconceptionTags).toEqual(["assignment.equality"]);
    expect(memory.evidenceRowsConsidered).toBe(2);
    expect(memory.recentRelevantSummary).toMatchObject({
      source: "email_outbox.weekly-summary",
      text: expect.stringContaining("[REDACTED]"),
    });
    expect(JSON.stringify(memory)).not.toContain("nvapi-");
    expect(memory.selectedThreadTail).toBeNull();
    expect(mocks.query.mock.calls.some(([sql]) => String(sql).includes("chat_message"))).toBe(false);
  });

  it("caps and redacts the selected owner-active thread tail without changing message roles into model roles", async () => {
    const tailRows = Array.from({ length: 7 }, (_, index) => ({
      id: `55000000-0000-4000-8000-00000000000${index + 1}`,
      role: index % 2 ? "assistant" as const : "user" as const,
      content: index === 0
        ? `newest password: hunter2 ${"x".repeat(2_000)}`
        : `tail-message-${index} ${"y".repeat(900)}`,
      content_length: index === 0 ? 2_030 : 915,
      created_at: new Date(NOW.getTime() - index * 1_000),
    }));
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes("from concept c")) return { rows: [] };
      if (sql.includes("from email_outbox")) return { rows: [] };
      if (sql.includes("from chat_message")) return { rows: tailRows };
      throw new Error(`Unexpected SQL: ${sql}`);
    });

    const memory = await loadTutorStructuredMemory({
      userId: "learner-1",
      skillId: "python.values.scalars",
      preferredLanguage: "python",
      selectedThreadId: THREAD,
    });
    expect(memory.currentConcept).toMatchObject({ persisted: false, status: "unseen", mastery: 0 });
    expect(memory.selectedThreadTail?.messages.length).toBeGreaterThan(0);
    expect(memory.selectedThreadTail?.messages.length).toBeLessThanOrEqual(TUTOR_MEMORY_LIMITS.threadMessages);
    expect(memory.selectedThreadTail?.truncated).toBe(true);
    expect(memory.selectedThreadTail?.messages.reduce((total, message) => total + message.content.length, 0))
      .toBeLessThanOrEqual(TUTOR_MEMORY_LIMITS.threadTotalChars);
    expect(JSON.stringify(memory.selectedThreadTail)).not.toContain("hunter2");
    expect(memory.selectedThreadTail?.messages.at(-1)?.content).toContain("newest");
    const tailSql = mocks.query.mock.calls.find(([sql]) => String(sql).includes("from chat_message"));
    expect(tailSql?.[0]).toContain("t.user_id = $2 and t.status = 'active'");
    expect(tailSql?.[0]).toContain("m.role in ('user','assistant')");
    expect(tailSql?.[1]).toEqual([
      THREAD,
      "learner-1",
      TUTOR_MEMORY_LIMITS.threadMessageChars + 1,
      TUTOR_MEMORY_LIMITS.threadMessages + 1,
    ]);
  });

  it("enforces the evidence, misconception-tag, and weekly-summary caps", async () => {
    const evidenceRows = Array.from({ length: TUTOR_MEMORY_LIMITS.evidenceRows + 1 }, (_, index) =>
      evidence(
        `56000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
        `variant-${index}`,
        [`bounded.tag${Math.floor(index / 2)}`],
      ));
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes("from concept c")) return { rows: [masteryRow()] };
      if (sql.includes("from email_outbox")) return { rows: [{ summary: "s".repeat(3_000), created_at: NOW }] };
      if (sql.includes("from mastery_evidence")) return { rows: evidenceRows };
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    const memory = await loadTutorStructuredMemory({
      userId: "learner-1",
      skillId: "python.values.scalars",
      preferredLanguage: "python",
    });
    expect(memory.evidenceRowsConsidered).toBe(TUTOR_MEMORY_LIMITS.evidenceRows);
    expect(memory.evidenceRowsCapped).toBe(true);
    expect(memory.activeMisconceptionTags.length).toBeLessThanOrEqual(TUTOR_MEMORY_LIMITS.misconceptionTags);
    expect(memory.recentRelevantSummary).toMatchObject({ truncated: true });
    expect(memory.recentRelevantSummary?.text.length).toBeLessThanOrEqual(TUTOR_MEMORY_LIMITS.summaryChars);
  });

  it("returns no tail when the owner-active query finds no selected thread and rejects invalid identifiers", async () => {
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes("from concept c") || sql.includes("from email_outbox") || sql.includes("from chat_message")) {
        return { rows: [] };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    await expect(loadTutorStructuredMemory({
      userId: "learner-1",
      skillId: "python.values.scalars",
      preferredLanguage: "python",
      selectedThreadId: THREAD,
    })).resolves.toMatchObject({ selectedThreadTail: null });
    await expect(loadTutorStructuredMemory({
      userId: "learner-1",
      skillId: "python.values.scalars",
      preferredLanguage: "python",
      selectedThreadId: "not-a-uuid",
    })).rejects.toThrow(/thread is invalid/i);
  });

  it("sanitizes and bounds every free-text list entry", () => {
    const secret = FAKE_OPENAI_KEY;
    expect(sanitizeTutorMemoryText(secret, 40).text).not.toContain("sk-");
    const values = sanitizeTutorMemoryList([secret, "x".repeat(500), 42], 2, 40);
    expect(values).toHaveLength(2);
    expect(values.every((value) => value.length <= 40)).toBe(true);
    expect(JSON.stringify(values)).not.toContain("sk-");
  });

  it("loads mentor evidence through owner predicates and excludes unverified attempts and plan mutation authority", async () => {
    const owner = "learner-1";
    const mentorEvidence = [
      { ...evidence("57000000-0000-4000-8000-000000000001", "variant-a", ["assignment.equality"]), concept_id: CONCEPT, enrollment_id: ENROLLMENT, language_context: "python" },
      { ...evidence("57000000-0000-4000-8000-000000000002", "variant-b", ["assignment.equality"]), concept_id: CONCEPT, enrollment_id: ENROLLMENT, language_context: "python" },
    ];
    mocks.query.mockImplementation(async (sql: string, parameters?: unknown[]) => {
      expect(parameters?.[0]).toBe(owner);
      if (sql.includes("from concept_mastery cm")) return { rows: [{ ...masteryRow(), title: `Scalar values api_key='${FAKE_NVIDIA_KEY}'` }] };
      if (sql.includes("from mastery_evidence me") && !sql.includes("join lateral")) return { rows: mentorEvidence };
      if (sql.includes("from attempt a")) return { rows: [{
        user_id: owner,
        skill_id: "python.values.scalars",
        occurred_at: NOW,
        score: 0.4,
        passed: false,
        assistance_level: "A1",
        solution_revealed: false,
        source_type: "deterministic_attempt",
        validity: "valid",
      }] };
      if (sql.includes("from plan_revision pr")) return { rows: [{
        id: "58000000-0000-4000-8000-000000000001",
        user_id: owner,
        plan: [{ schemaVersion: 1, kind: "learn", skillId: "python.values.scalars" }],
      }] };
      throw new Error(`Unexpected SQL: ${sql}`);
    });

    const recommendation = await loadMentorRecommendation(owner, new Date("2026-07-12T12:00:00.000Z"));
    expect(recommendation).toMatchObject({
      state: "ready",
      dailyChallenge: { skillId: "python.values.scalars", reason: "confirmed_misconception" },
      learningSignal: { evidence: { verifiedMasteryRows: 1, verifiedRecentAttempts: 1 } },
      authority: {
        officialPlanChanged: false,
        officialPlanRevisionId: "58000000-0000-4000-8000-000000000001",
      },
    });
    expect(JSON.stringify(recommendation)).not.toContain("nvapi-");
    const sqlText = mocks.query.mock.calls.map(([sql]) => String(sql)).join("\n");
    expect(sqlText).toContain("where cm.user_id = $1");
    expect(sqlText).toContain("where me.user_id = $1");
    expect(sqlText).toContain("where a.user_id = $1");
    expect(sqlText).toContain("where e.user_id = $1");
    expect(sqlText).not.toContain("provider_credential");
    expect(sqlText).not.toContain("hidden");
    expect(sqlText).not.toContain("chat_message");
  });
});
