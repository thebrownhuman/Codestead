import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const clientQuery = vi.fn();
  const release = vi.fn();
  const client = { query: clientQuery, release };
  return {
    client,
    clientQuery,
    poolConnect: vi.fn(async () => client),
    poolQuery: vi.fn(),
    release,
  };
});

vi.mock("@/lib/db/client", () => ({
  pool: {
    connect: mocks.poolConnect,
    query: mocks.poolQuery,
  },
}));

import { mentorEvidenceReadSchema } from "../contracts";
import {
  boundMentorEvidenceItemPayload,
  boundMentorEvidenceResponsePage,
  MAX_MENTOR_EVIDENCE_ITEM_BYTES,
  MentorEvidenceError,
  readMentorEvidence,
  redactSensitiveText,
  resolveMentorLearner,
  sanitizeExamAnswer,
  sanitizeExamResult,
  sanitizeRunnerResult,
  sanitizeStructuredEvidence,
} from "../evidence-reader";

describe("bounded mentor evidence contracts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.clientQuery.mockReset();
    mocks.poolConnect.mockReset().mockResolvedValue(mocks.client);
    mocks.poolQuery.mockReset();
  });

  const valid = {
    requestId: "10000000-0000-4000-8000-000000000001",
    category: "chats",
    purpose: "learning_support",
    reason: "Review the learner's loop misconception and plan focused remediation.",
    limit: 5,
  };

  it("requires an explicit category, purpose, reason, request id, and bounded page", () => {
    expect(mentorEvidenceReadSchema.safeParse(valid).success).toBe(true);
    for (const candidate of [
      { ...valid, requestId: "bad" },
      { ...valid, category: "provider_keys" },
      { ...valid, purpose: "curiosity" },
      { ...valid, reason: "too short" },
      { ...valid, limit: 11 },
      { ...valid, unexpected: true },
    ]) expect(mentorEvidenceReadSchema.safeParse(candidate).success).toBe(false);
  });

  it("redacts provider credentials, password phrases, bearer values, and IP addresses from free text", () => {
    const input = "nvapi-abcdefghijklmnopqrstuvwxyz password: hunter2 Bearer abcdefghijklmnop 192.168.1.22";
    const output = redactSensitiveText(input, 1_000).text;
    expect(output).not.toContain("nvapi-");
    expect(output).not.toContain("hunter2");
    expect(output).not.toContain("abcdefghijklmnop");
    expect(output).not.toContain("192.168.1.22");
    expect(output.match(/\[REDACTED\]/g)?.length).toBeGreaterThanOrEqual(4);
  });

  it("drops sensitive structured keys recursively and bounds arrays/depth", () => {
    const result = sanitizeStructuredEvidence({
      objective: "Build a bounded parser.",
      apiKey: "nvapi-abcdefghijklmnopqrstuvwxyz",
      nested: { sessionToken: "private", evidence: ["safe", { password: "private" }] },
    });
    expect(result).toEqual({
      objective: "Build a bounded parser.",
      nested: { evidence: ["safe", {}] },
    });
    expect(JSON.stringify(result)).not.toContain("private");
  });

  it("projects only learner answer fields and redacts secrets in text and code", () => {
    const answer = sanitizeExamAnswer({
      text: "Use token=abcdefghijklmnop safely",
      sourceCode: "const key = 'sk-abcdefghijklmnopqrstuv';",
      language: "javascript",
      expectedAnswer: "hidden reference",
      tests: [{ expected: "hidden" }],
    });
    expect(answer).toMatchObject({ language: "javascript" });
    expect(JSON.stringify(answer)).not.toContain("abcdefghijkl");
    expect(JSON.stringify(answer)).not.toContain("expectedAnswer");
    expect(JSON.stringify(answer)).not.toContain("tests");
  });

  it("projects official result fields without hidden form/test evidence", () => {
    const result = sanitizeExamResult({
      schemaVersion: 1,
      gradingStatus: "graded",
      outcome: "MASTERED",
      officialScorePercent: 97,
      earnedPoints: 97,
      possiblePoints: 100,
      pendingReviewItemIds: [],
      failedCriticalClusters: [],
      masteryBlockingCodingItems: [],
      compilationGatePassed: true,
      infrastructureFailure: false,
      finalizedAt: "2026-07-12T00:00:00.000Z",
      finalizedBy: "learner-submit",
      policyVersion: "formal-exam-v1",
      remediation: { required: false, targets: [] },
      form: { seed: "private", tests: ["hidden"] },
      referenceAnswer: "private",
    });
    expect(result).toMatchObject({ outcome: "MASTERED", officialScorePercent: 97 });
    expect(JSON.stringify(result)).not.toContain("seed");
    expect(JSON.stringify(result)).not.toContain("tests");
    expect(JSON.stringify(result)).not.toContain("referenceAnswer");
  });

  it("projects aggregate runner evidence but never individual or hidden tests and digests", () => {
    const result = sanitizeRunnerResult({
      status: "ACCEPTED",
      imageDigest: "sha256:private",
      requestHash: "private",
      compile: { status: "OK", exitCode: 0, stdout: "", stderr: "" },
      run: { exitCode: 0, stdout: "done", stderr: "" },
      totals: { passed: 12, failed: 0, total: 12 },
      tests: [{ visibility: "HIDDEN", expectedStdout: "private" }],
    });
    expect(result).toMatchObject({ status: "ACCEPTED", totals: { passed: 12, failed: 0, total: 12 } });
    const serialized = JSON.stringify(result);
    for (const forbidden of ["imageDigest", "requestHash", "tests", "expectedStdout", "HIDDEN"]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("bounds an oversized newest item before pagination and always emits a continuation cursor", () => {
    const newest = {
      id: "41000000-0000-4000-8000-000000000001",
      answers: Array.from({ length: 25 }, (_, index) => ({
        itemId: `large-${index}`,
        sourceCode: `${"x".repeat(16_000)} nvapi-abcdefghijklmnopqrstuvwxyz`,
      })),
      createdAt: "2026-07-12T12:00:00.000Z",
      _page: {
        id: "41000000-0000-4000-8000-000000000001",
        created_at: new Date("2026-07-12T12:00:00.000Z"),
      },
    };
    const olderSmall = {
      id: "41000000-0000-4000-8000-000000000002",
      answers: [{ itemId: "small", sourceCode: "print('ok')" }],
      createdAt: "2026-07-12T11:00:00.000Z",
      _page: {
        id: "41000000-0000-4000-8000-000000000002",
        created_at: new Date("2026-07-12T11:00:00.000Z"),
      },
    };

    const first = boundMentorEvidenceResponsePage([newest, olderSmall], 1);
    expect(first.items).toHaveLength(1);
    expect(first.items[0]).toMatchObject({
      id: newest.id,
      mentorPayloadTruncated: true,
      mentorPayloadByteLimit: MAX_MENTOR_EVIDENCE_ITEM_BYTES,
    });
    expect(first.responseBytes).toBeLessThanOrEqual(MAX_MENTOR_EVIDENCE_ITEM_BYTES + 2);
    expect(first).toMatchObject({ hasMore: true, truncatedItemCount: 1 });
    expect(first.nextCursor).toBeTruthy();
    expect(JSON.stringify(first.items)).not.toContain("nvapi-");

    const second = boundMentorEvidenceResponsePage([olderSmall], 1);
    expect(second.items).toEqual([expect.objectContaining({ id: olderSmall.id })]);
    expect(second).toMatchObject({ hasMore: false, nextCursor: null });
  });

  it("guarantees the item byte cap even for deeply nested multibyte evidence", () => {
    const bounded = boundMentorEvidenceItemPayload({
      id: "42000000-0000-4000-8000-000000000001",
      nested: Array.from({ length: 100 }, () => ({
        detail: String.fromCodePoint(0x1f9ea).repeat(40_000),
        authorization: "Bearer abcdefghijklmnop",
      })),
    });
    expect(bounded.truncated).toBe(true);
    expect(bounded.bytes).toBeLessThanOrEqual(MAX_MENTOR_EVIDENCE_ITEM_BYTES);
    expect(JSON.stringify(bounded.value)).not.toContain("abcdefghijklmnop");
  });

  it("size-limits a page of individually valid records and cursors from the last accepted record", () => {
    const makeItem = (index: number) => ({
      id: `43000000-0000-4000-8000-00000000000${index}`,
      content: "x".repeat(45_000),
      _page: {
        id: `43000000-0000-4000-8000-00000000000${index}`,
        created_at: new Date(`2026-07-12T0${4 - index}:00:00.000Z`),
      },
    });
    const items = [makeItem(1), makeItem(2), makeItem(3)];

    const page = boundMentorEvidenceResponsePage(items, 3);

    expect(page.items).toHaveLength(2);
    expect(page).toMatchObject({ hasMore: true, truncatedItemCount: 0 });
    expect(page.responseBytes).toBeLessThanOrEqual(124 * 1024);
    expect(Buffer.from(page.nextCursor!, "base64url").toString("utf8")).toBe(
      "2026-07-12T02:00:00.000Z|43000000-0000-4000-8000-000000000002",
    );
  });

  it("fails closed instead of advertising continuation without an accepted cursor row", () => {
    expect(() => boundMentorEvidenceResponsePage([{
      id: "44000000-0000-4000-8000-000000000001",
      _page: {
        id: "44000000-0000-4000-8000-000000000001",
        created_at: new Date("2026-07-12T01:00:00.000Z"),
      },
    }], 0)).toThrow("MENTOR_EVIDENCE_PAGINATION_INVARIANT");
  });

  it("uses the deterministic scalar fallback when adversarial object keys defeat every reduction profile", () => {
    const hugeKeys = Object.fromEntries(Array.from({ length: 100 }, (_, index) => [
      `${index}-${"k".repeat(800)}`,
      index % 2 === 0 ? `safe-${index}` : { nested: "discarded" },
    ]));
    const bounded = boundMentorEvidenceItemPayload({
      id: "45000000-0000-4000-8000-000000000001",
      authorization: "Bearer abcdefghijklmnop",
      ...hugeKeys,
    });

    expect(bounded).toMatchObject({ truncated: true });
    expect(bounded.bytes).toBeLessThanOrEqual(MAX_MENTOR_EVIDENCE_ITEM_BYTES);
    expect(bounded.value).toMatchObject({
      mentorPayloadTruncated: true,
      mentorPayloadByteLimit: MAX_MENTOR_EVIDENCE_ITEM_BYTES,
    });
    expect(JSON.stringify(bounded.value)).not.toContain("abcdefghijklmnop");
    expect(Object.keys(bounded.value).length).toBeLessThan(104);
  });

  it("covers null, scalar, array, depth, and invalid sanitizer inputs", () => {
    expect(sanitizeStructuredEvidence(undefined)).toBeNull();
    expect(sanitizeStructuredEvidence([1, true, null, undefined])).toEqual([1, true, null, null]);
    expect(sanitizeStructuredEvidence({ value: "deep" }, 7)).toBe("[depth limit]");
    expect(sanitizeStructuredEvidence(Array.from({ length: 60 }, (_, index) => index))).toHaveLength(50);
    expect(sanitizeExamAnswer(null)).toEqual({});
    expect(sanitizeExamAnswer({ text: 1, sourceCode: false, language: 2 })).toEqual({});
    expect(sanitizeExamAnswer({
      text: "t".repeat(8_001),
      sourceCode: "s".repeat(16_001),
      language: "l".repeat(50),
    })).toMatchObject({ textTruncated: true, sourceCodeTruncated: true, language: "l".repeat(40) });

    expect(sanitizeExamResult([])).toBeNull();
    expect(sanitizeExamResult({
      schemaVersion: 2,
      gradingStatus: 1,
      outcome: false,
      officialScorePercent: "100",
      earnedPoints: null,
      possiblePoints: undefined,
      pendingReviewItemIds: ["kept", 1],
      failedCriticalClusters: null,
      masteryBlockingCodingItems: "not-an-array",
      compilationGatePassed: "yes",
      infrastructureFailure: true,
      finalizedAt: 1,
      finalizedBy: null,
      policyVersion: false,
      remediation: { required: true, targets: ["target", false] },
    })).toEqual({
      schemaVersion: null,
      gradingStatus: null,
      outcome: null,
      officialScorePercent: null,
      earnedPoints: null,
      possiblePoints: null,
      pendingReviewItemIds: ["kept"],
      failedCriticalClusters: [],
      masteryBlockingCodingItems: [],
      compilationGatePassed: null,
      infrastructureFailure: true,
      finalizedAt: null,
      finalizedBy: null,
      policyVersion: null,
      remediation: { required: true, targets: ["target"] },
    });

    expect(sanitizeRunnerResult("invalid")).toBeNull();
    expect(sanitizeRunnerResult({
      status: 1,
      compile: { status: 1, exitCode: "0", stdout: null, stderr: "error" },
      run: { exitCode: "0", stdout: 1, stderr: "warning" },
      totals: { passed: "1", failed: null, total: false },
    })).toEqual({
      status: null,
      compile: { status: null, exitCode: null, stdout: "", stderr: "error" },
      run: { exitCode: null, stdout: "", stderr: "warning" },
      totals: { passed: null, failed: null, total: null },
    });
    expect(sanitizeRunnerResult({})).toEqual({ status: null, compile: null, run: null, totals: null });
  });

  it("resolves only the first active learner row and returns null when none exists", async () => {
    const learner = { id: "learner-1", public_id: "public-1", name: "Learner" };
    mocks.poolQuery.mockResolvedValueOnce({ rows: [learner] }).mockResolvedValueOnce({ rows: [] });

    await expect(resolveMentorLearner("public-1")).resolves.toEqual(learner);
    await expect(resolveMentorLearner("missing")).resolves.toBeNull();
    expect(mocks.poolQuery).toHaveBeenNthCalledWith(1, expect.stringContaining("role = 'learner'"), ["public-1"]);
  });

  it.each([
    "not-base64-cursor",
    Buffer.from("missing-separator", "utf8").toString("base64url"),
    Buffer.from("not-a-date|46000000-0000-4000-8000-000000000001", "utf8").toString("base64url"),
    Buffer.from("2026-07-12T00:00:00.000Z|not-a-uuid", "utf8").toString("base64url"),
  ])("rejects malformed cursor %s before opening a database connection", async (cursor) => {
    await expect(readMentorEvidence({
      learnerUserId: "learner-1",
      category: "chats",
      cursor,
      limit: 1,
    })).rejects.toEqual(expect.objectContaining({ code: "INVALID_CURSOR" }));
    expect(mocks.poolConnect).not.toHaveBeenCalled();
  });

  it("rolls back and releases when the learner disappears, preserving the domain error even if rollback fails", async () => {
    mocks.clientQuery.mockImplementation(async (statement: string) => {
      if (statement.startsWith("begin")) return { rows: [] };
      if (statement.startsWith("rollback")) throw new Error("rollback unavailable");
      if (statement.includes("select id from \"user\"")) return { rows: [] };
      throw new Error(`unexpected query: ${statement}`);
    });

    await expect(readMentorEvidence({
      learnerUserId: "missing",
      category: "chats",
      limit: 1,
    })).rejects.toEqual(expect.objectContaining({ code: "LEARNER_NOT_FOUND" }));
    expect(mocks.clientQuery).toHaveBeenCalledWith("rollback");
    expect(mocks.release).toHaveBeenCalledTimes(1);
  });

  it("reads bounded chat evidence with a valid keyset cursor", async () => {
    const cursorId = "47000000-0000-4000-8000-000000000009";
    const cursorAt = "2026-07-12T12:30:00.000Z";
    const cursor = Buffer.from(`${cursorAt}|${cursorId}`, "utf8").toString("base64url");
    const evidenceQuery = vi.fn();
    mocks.clientQuery.mockImplementation(async (statement: string, parameters?: unknown[]) => {
      if (statement.startsWith("begin") || statement === "commit") return { rows: [] };
      if (statement.includes("select id from \"user\"")) return { rows: [{ id: "learner-1" }] };
      if (statement.includes("from chat_message")) {
        evidenceQuery(parameters);
        return { rows: [
          {
            id: "47000000-0000-4000-8000-000000000001",
            thread_id: "thread-1",
            thread_title: "Mentor thread",
            role: "unexpected-role",
            content: `${"x".repeat(8_001)} token=abcdefghijklmnop`,
            curriculum_refs: ["unit-1", 2, "unit-2"],
            created_at: new Date("2026-07-12T12:00:00.000Z"),
          },
          {
            id: "47000000-0000-4000-8000-000000000002",
            thread_id: "thread-2",
            thread_title: "Older thread",
            role: "assistant",
            content: "older",
            curriculum_refs: null,
            created_at: new Date("2026-07-12T11:00:00.000Z"),
          },
        ] };
      }
      throw new Error(`unexpected query: ${statement}`);
    });

    const result = await readMentorEvidence({
      learnerUserId: "learner-1",
      category: "chats",
      cursor,
      limit: 1,
    });

    expect(result.items).toEqual([expect.objectContaining({
      role: "unknown",
      contentTruncated: true,
      curriculumRefs: ["unit-1", "unit-2"],
    })]);
    expect(result.page).toMatchObject({ limit: 1, hasMore: true, nextCursor: expect.any(String) });
    expect(result.safeguards).toMatchObject({
      hiddenAssessmentEvidenceIncluded: false,
      credentialOrSessionEvidenceIncluded: false,
      deviceOrIpEvidenceIncluded: false,
    });
    expect(evidenceQuery).toHaveBeenCalledWith([
      "learner-1",
      new Date(cursorAt),
      cursorId,
      8_001,
      2,
    ]);
    expect(mocks.release).toHaveBeenCalledTimes(1);
  });

  it("projects code submissions and aggregate runner output", async () => {
    mocks.clientQuery.mockImplementation(async (statement: string) => {
      if (statement.startsWith("begin") || statement === "commit") return { rows: [] };
      if (statement.includes("select id from \"user\"")) return { rows: [{ id: "learner-1" }] };
      if (statement.includes("from code_submission")) return { rows: [{
        id: "48000000-0000-4000-8000-000000000001",
        attempt_id: null,
        activity_id: "activity-1",
        language: "typescript-with-an-excessively-long-language-label",
        source_code: `${"s".repeat(16_001)} sk-abcdefghijklmnopqrstuv`,
        request_id: "practice-request-opaque-1",
        submission_type: "practice",
        submission_status: "completed",
        runner_job_id: "48000000-0000-4000-8000-000000000002",
        runner_status: "succeeded",
        recovery_state: "quarantined",
        recovery_attempt_count: 2,
        recovery_next_attempt_at: null,
        recovery_last_error_code: "PRACTICE_DISPATCH_SNAPSHOT_INVALID",
        remote_runner_job_id: "remote-practice-job-1",
        runner_result: {
          status: "ACCEPTED",
          compile: { status: "OK", exitCode: 0, stdout: "compiled", stderr: "" },
          run: { exitCode: 0, stdout: "done", stderr: "" },
          totals: { passed: 1, failed: 0, total: 1 },
        },
        created_at: new Date("2026-07-12T10:00:00.000Z"),
      }] };
      throw new Error(`unexpected query: ${statement}`);
    });

    const result = await readMentorEvidence({
      learnerUserId: "learner-1",
      category: "code_submissions",
      limit: 2,
    });

    expect(result.items).toEqual([expect.objectContaining({
      attemptId: null,
      activityId: "activity-1",
      sourceCodeTruncated: true,
      runnerRequestId: "practice-request-opaque-1",
      runnerJobId: "48000000-0000-4000-8000-000000000002",
      recoveryState: "quarantined",
      recoveryAttemptCount: 2,
      recoveryNextAttemptAt: null,
      recoveryLastErrorCode: "PRACTICE_DISPATCH_SNAPSHOT_INVALID",
      remoteRunnerJobId: "remote-practice-job-1",
      runnerResult: expect.objectContaining({ status: "ACCEPTED" }),
    })]);
    expect((result.items[0].language as string)).toHaveLength(40);
    expect(result.page).toMatchObject({ hasMore: false, nextCursor: null });
  });

  it("reads exam answers and integrity events while preserving bounded public fields", async () => {
    mocks.clientQuery.mockImplementation(async (statement: string) => {
      if (statement.startsWith("begin") || statement === "commit") return { rows: [] };
      if (statement.includes("select id from \"user\"")) return { rows: [{ id: "learner-1" }] };
      if (statement.includes("from exam_session es")) return { rows: [{
        id: "49000000-0000-4000-8000-000000000001",
        attempt_id: "49000000-0000-4000-8000-000000000002",
        kind: "formal_exam",
        attempt_number: 2,
        attempt_status: "submitted",
        session_status: "completed",
        integrity_review_state: "clear",
        server_started_at: new Date("2026-07-12T08:00:00.000Z"),
        submitted_at: null,
        result: { schemaVersion: 1, outcome: "MASTERED" },
        corrected: false,
        created_at: new Date("2026-07-12T08:00:00.000Z"),
      }] };
      if (statement.includes("with latest as")) return { rows: [
        {
          attempt_id: "49000000-0000-4000-8000-000000000002",
          id: "answer-1",
          item_key: "item-1",
          revision: 1,
          answer: { text: "answer" },
          saved_at: new Date("2026-07-12T08:10:00.000Z"),
          submitted_at: null,
        },
        {
          attempt_id: "49000000-0000-4000-8000-000000000002",
          id: "answer-2",
          item_key: "item-2",
          revision: 2,
          answer: { sourceCode: "print('ok')", language: "python" },
          saved_at: new Date("2026-07-12T08:20:00.000Z"),
          submitted_at: new Date("2026-07-12T08:30:00.000Z"),
        },
      ] };
      if (statement.includes("from exam_event e")) return { rows: [
        {
          exam_session_id: "49000000-0000-4000-8000-000000000001",
          id: "event-1",
          type: "focus_lost",
          occurred_at: new Date("2026-07-12T08:15:00.000Z"),
        },
        {
          exam_session_id: "49000000-0000-4000-8000-000000000001",
          id: "event-2",
          type: "focus_restored",
          occurred_at: new Date("2026-07-12T08:16:00.000Z"),
        },
      ] };
      throw new Error(`unexpected query: ${statement}`);
    });

    const result = await readMentorEvidence({ learnerUserId: "learner-1", category: "exams", limit: 1 });

    expect(result.items).toEqual([expect.objectContaining({
      startedAt: "2026-07-12T08:00:00.000Z",
      submittedAt: null,
      answers: [
        expect.objectContaining({ itemId: "item-1", submittedAt: null }),
        expect.objectContaining({ itemId: "item-2", submittedAt: "2026-07-12T08:30:00.000Z" }),
      ],
      integrityEvents: [
        expect.objectContaining({ type: "focus_lost" }),
        expect.objectContaining({ type: "focus_restored" }),
      ],
    })]);
  });

  it("avoids secondary exam queries when the requested page is empty", async () => {
    mocks.clientQuery.mockImplementation(async (statement: string) => {
      if (statement.startsWith("begin") || statement === "commit") return { rows: [] };
      if (statement.includes("select id from \"user\"")) return { rows: [{ id: "learner-1" }] };
      if (statement.includes("from exam_session es")) return { rows: [] };
      throw new Error(`unexpected query: ${statement}`);
    });

    const result = await readMentorEvidence({ learnerUserId: "learner-1", category: "exams", limit: 3 });

    expect(result.items).toEqual([]);
    expect(result.page).toEqual({ limit: 3, hasMore: false, nextCursor: null });
    expect(mocks.clientQuery).toHaveBeenCalledTimes(4);
  });

  it("projects projects with grouped reviews and empty review defaults", async () => {
    mocks.clientQuery.mockImplementation(async (statement: string) => {
      if (statement.startsWith("begin") || statement === "commit") return { rows: [] };
      if (statement.includes("select id from \"user\"")) return { rows: [{ id: "learner-1" }] };
      if (statement.includes("from project p")) return { rows: [
        {
          id: "50000000-0000-4000-8000-000000000001",
          title: "Project one",
          summary: "Summary one",
          status: "active",
          prd: { objective: "Build it", apiKey: "private" },
          created_at: new Date("2026-07-12T07:00:00.000Z"),
          updated_at: new Date("2026-07-12T07:30:00.000Z"),
        },
        {
          id: "50000000-0000-4000-8000-000000000002",
          title: "Project two",
          summary: "Summary two",
          status: "draft",
          prd: null,
          created_at: new Date("2026-07-12T06:00:00.000Z"),
          updated_at: new Date("2026-07-12T06:30:00.000Z"),
        },
      ] };
      if (statement.includes("from project_review r")) return { rows: [
        {
          project_id: "50000000-0000-4000-8000-000000000001",
          id: "review-1",
          analyzer_version: "v1",
          findings: [{ severity: "low" }],
          status: "complete",
          created_at: new Date("2026-07-12T07:10:00.000Z"),
        },
        {
          project_id: "50000000-0000-4000-8000-000000000001",
          id: "review-2",
          analyzer_version: "v2",
          findings: null,
          status: "complete",
          created_at: new Date("2026-07-12T07:20:00.000Z"),
        },
      ] };
      throw new Error(`unexpected query: ${statement}`);
    });

    const result = await readMentorEvidence({ learnerUserId: "learner-1", category: "projects", limit: 2 });

    expect(result.items).toEqual([
      expect.objectContaining({
        id: "50000000-0000-4000-8000-000000000001",
        prd: { objective: "Build it" },
        reviews: [expect.objectContaining({ id: "review-1" }), expect.objectContaining({ id: "review-2" })],
      }),
      expect.objectContaining({ id: "50000000-0000-4000-8000-000000000002", prd: null, reviews: [] }),
    ]);
  });

  it("avoids secondary project queries when the requested page is empty", async () => {
    mocks.clientQuery.mockImplementation(async (statement: string) => {
      if (statement.startsWith("begin") || statement === "commit") return { rows: [] };
      if (statement.includes("select id from \"user\"")) return { rows: [{ id: "learner-1" }] };
      if (statement.includes("from project p")) return { rows: [] };
      throw new Error(`unexpected query: ${statement}`);
    });

    const result = await readMentorEvidence({ learnerUserId: "learner-1", category: "projects", limit: 3 });

    expect(result.items).toEqual([]);
    expect(mocks.clientQuery).toHaveBeenCalledTimes(4);
  });

  it("projects weekly AI summaries without exposing internal outbox variables", async () => {
    mocks.clientQuery.mockImplementation(async (statement: string) => {
      if (statement.startsWith("begin") || statement === "commit") return { rows: [] };
      if (statement.includes("select id from \"user\"")) return { rows: [{ id: "learner-1" }] };
      if (statement.includes("from email_outbox e")) return { rows: [{
        id: "51000000-0000-4000-8000-000000000001",
        summary: "Weekly progress token=abcdefghijklmnop",
        status: "sent",
        created_at: new Date("2026-07-12T05:00:00.000Z"),
      }] };
      throw new Error(`unexpected query: ${statement}`);
    });

    const result = await readMentorEvidence({ learnerUserId: "learner-1", category: "ai_summaries", limit: 1 });

    expect(result.items).toEqual([expect.objectContaining({
      kind: "weekly_learning_summary",
      deliveryStatus: "sent",
      summary: expect.not.stringContaining("abcdefghijklmnop"),
    })]);
  });

  it("identifies mentor evidence domain errors", () => {
    expect(new MentorEvidenceError("INVALID_CURSOR")).toMatchObject({
      name: "MentorEvidenceError",
      message: "INVALID_CURSOR",
      code: "INVALID_CURSOR",
    });
  });
});
