import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock("@/lib/db/client", () => ({ pool: { query: mocks.query } }));

import {
  createLearnerExport,
  encodeExportLine,
  EXPORT_EXCLUDED_DATA,
  EXPORT_SCHEMA_VERSION,
  exportBounds,
} from "../export";

describe("bounded safe export contract", () => {
  beforeEach(() => vi.clearAllMocks());

  it("explicitly excludes every secret and hidden-assessment category", () => {
    const serialized = EXPORT_EXCLUDED_DATA.join(" ").toLowerCase();
    for (const term of ["credential", "password", "mfa", "session token", "hidden test", "backup"]) {
      expect(serialized).toContain(term);
    }
  });

  it("encodes one JSON object per line without executable framing", () => {
    const line = encodeExportLine({ type: "record", data: { value: "</script>" } });
    expect(line.endsWith("\n")).toBe(true);
    expect(JSON.parse(line)).toEqual({ type: "record", data: { value: "</script>" } });
  });

  it("enforces hard server-side record and byte ceilings", () => {
    expect(exportBounds({})).toEqual({ maxRecords: 5_000, maxBytes: 10 * 1_024 * 1_024 });
    expect(() => exportBounds({ maxRecords: 10_001 })).toThrow();
    expect(() => exportBounds({ maxBytes: 20 * 1_024 * 1_024 + 1 })).toThrow();
    expect(() => exportBounds({ maxBytes: 1_023 })).toThrow();
  });

  it("rejects malformed request ids and timestamps before touching the database", async () => {
    await expect(createLearnerExport({
      learnerId: "learner-1",
      actorUserId: "admin-1",
      requestId: "------------------------------------",
    })).rejects.toThrow(/uuid/i);
    await expect(createLearnerExport({
      learnerId: "learner-1",
      actorUserId: "admin-1",
      requestId: "81000000-0000-4000-8000-000000000001",
      now: new Date(Number.NaN),
    })).rejects.toThrow(/timestamp/i);
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it("streams an authorized allowlisted manifest, record, and truthful footer", async () => {
    mocks.query.mockImplementation(async (statement: string) => {
      if (statement.includes("insert into data_lifecycle_run")) return { rows: [{ id: "run-1" }] };
      if (statement.includes('from "user" u left join learner_profile')) {
        return { rows: [{ data: { id: "learner-1", name: "Learner" } }] };
      }
      return { rows: [] };
    });
    const exported = await createLearnerExport({
      learnerId: "learner-1",
      actorUserId: "admin-1",
      requestId: "81000000-0000-4000-8000-000000000002",
      now: new Date("2026-07-12T00:00:00.000Z"),
      maxRecords: 10,
      maxBytes: 16_384,
    });
    const text = await new Response(exported.stream).text();
    const metrics = await exported.completion;
    const lines = text.trim().split("\n").map((line) => JSON.parse(line));

    expect(lines.map((line) => line.type)).toEqual(["manifest", "record", "footer"]);
    expect(lines[1]).toMatchObject({ category: "profile", data: { id: "learner-1" } });
    expect(lines[2]).toMatchObject({ records: 1, truncated: false, completed: true });
    expect(metrics).toMatchObject({ runId: "run-1", records: 1, truncated: false, completed: true });
    expect(mocks.query).toHaveBeenCalledWith(
      expect.stringContaining("set status = 'succeeded'"),
      expect.any(Array),
    );
  });

  it("exports authoritative drafts and their content-free idempotency history", async () => {
    mocks.query.mockImplementation(async (statement: string) => {
      if (statement.includes("insert into data_lifecycle_run")) return { rows: [{ id: "run-drafts" }] };
      if (statement.includes("from learner_draft d where")) {
        return { rows: [{ data: { id: "draft-1", content: "answer = 42", rowVersion: 2 } }] };
      }
      if (statement.includes("from learner_draft_mutation m")) {
        return { rows: [{ data: { requestId: "request-1", expectedRowVersion: 1, resultingRowVersion: 2 } }] };
      }
      return { rows: [] };
    });
    const exported = await createLearnerExport({
      learnerId: "learner-1",
      actorUserId: "admin-1",
      requestId: "81000000-0000-4000-8000-000000000010",
      maxRecords: 10,
      maxBytes: 16_384,
    });
    const lines = (await new Response(exported.stream).text()).trim().split("\n").map((line) => JSON.parse(line));
    await exported.completion;
    expect(lines[0]).toMatchObject({ type: "manifest", schemaVersion: EXPORT_SCHEMA_VERSION });
    expect(lines.filter((line) => line.type === "record")).toEqual([
      expect.objectContaining({ category: "learnerDrafts", data: expect.objectContaining({ content: "answer = 42" }) }),
      expect.objectContaining({ category: "learnerDraftMutationHistory", data: expect.objectContaining({ requestId: "request-1" }) }),
    ]);
  });

  it("exports only owner-bound safe daily-review allocation and outcome fields", async () => {
    const statements: string[] = [];
    mocks.query.mockImplementation(async (statement: string) => {
      if (statement.includes("insert into data_lifecycle_run")) return { rows: [{ id: "run-daily-review" }] };
      if (statement.includes("from daily_review_session s")) {
        statements.push(statement);
        return { rows: [{ data: {
          id: "session-1",
          localDate: "2026-07-14",
          status: "completed",
          questionCount: 5,
          completedCount: 5,
        } }] };
      }
      if (statement.includes("from daily_review_item i")) {
        statements.push(statement);
        return { rows: [{ data: {
          id: "item-1",
          sessionId: "session-1",
          position: 1,
          skillId: "python.variables.binding",
          priorityReason: "lowest_confidence",
          status: "answered",
          passed: true,
        } }] };
      }
      return { rows: [] };
    });

    const exported = await createLearnerExport({
      learnerId: "learner-1",
      actorUserId: "admin-1",
      requestId: "81000000-0000-4000-8000-000000000016",
      maxRecords: 20,
      maxBytes: 32_768,
    });
    const lines = (await new Response(exported.stream).text()).trim().split("\n").map((line) => JSON.parse(line));
    await exported.completion;

    expect(lines[0]).toMatchObject({ type: "manifest", schemaVersion: EXPORT_SCHEMA_VERSION });
    expect(lines).toContainEqual(expect.objectContaining({
      category: "dailyReviewSessions",
      data: expect.objectContaining({ localDate: "2026-07-14", completedCount: 5 }),
    }));
    expect(lines).toContainEqual(expect.objectContaining({
      category: "dailyReviewItems",
      data: expect.objectContaining({ skillId: "python.variables.binding", passed: true }),
    }));
    expect(statements).toHaveLength(2);
    expect(statements[0]).toContain("where s.user_id = $1");
    expect(statements[1]).toContain("where i.user_id = $1");
    for (const statement of statements) {
      expect(statement).not.toMatch(/answer_text|answer_payload|hidden_test|prompt_text|provider_credential|email|device_hash|session_token/);
    }
  });

  it("uses the authoritative export timestamp when deciding whether battle results are sealed", async () => {
    const snapshot = new Date("2026-07-14T12:00:00.000Z");
    const battleSubmissionCalls: Array<{ statement: string; parameters: unknown[] }> = [];
    mocks.query.mockImplementation(async (statement: string, parameters: unknown[]) => {
      if (statement.includes("insert into data_lifecycle_run")) return { rows: [{ id: "run-battle-sealing" }] };
      if (statement.includes("from coding_battle_submission submission")) {
        battleSubmissionCalls.push({ statement, parameters });
      }
      return { rows: [] };
    });

    const exported = await createLearnerExport({
      learnerId: "learner-1",
      actorUserId: "admin-1",
      requestId: "81000000-0000-4000-8000-000000000011",
      now: snapshot,
      maxRecords: 10,
      maxBytes: 16_384,
    });
    await new Response(exported.stream).text();
    await exported.completion;

    expect(battleSubmissionCalls).toHaveLength(1);
    expect(battleSubmissionCalls[0]?.statement).toContain("battle.reveal_at <= $4::timestamptz");
    expect(battleSubmissionCalls[0]?.statement).not.toContain("now()");
    expect(battleSubmissionCalls[0]?.parameters).toEqual(["learner-1", 11, 0, snapshot]);
  });

  it("exports explicit smart-reminder choices and owner-bound dispatch evidence", async () => {
    const statements: string[] = [];
    mocks.query.mockImplementation(async (statement: string) => {
      if (statement.includes("insert into data_lifecycle_run")) return { rows: [{ id: "run-reminders" }] };
      if (statement.includes("from notification_preference p where")) {
        statements.push(statement);
        return { rows: [{ data: { dailyStudyEnabled: true, learningEmailEnabled: false } }] };
      }
      if (statement.includes("from smart_reminder_dispatch d where")) {
        statements.push(statement);
        return { rows: [{ data: {
          id: "dispatch-1",
          kind: "daily_study",
          localPeriodKey: "2026-07-14",
          evidence: { noMeaningfulActivityToday: true },
        } }] };
      }
      return { rows: [] };
    });

    const exported = await createLearnerExport({
      learnerId: "learner-1",
      actorUserId: "admin-1",
      requestId: "81000000-0000-4000-8000-000000000020",
      maxRecords: 20,
      maxBytes: 32_768,
    });
    const lines = (await new Response(exported.stream).text()).trim().split("\n").map((line) => JSON.parse(line));
    await exported.completion;

    expect(lines).toContainEqual(expect.objectContaining({
      category: "notificationPreferences",
      data: expect.objectContaining({ dailyStudyEnabled: true, learningEmailEnabled: false }),
    }));
    expect(lines).toContainEqual(expect.objectContaining({
      category: "smartReminderDispatches",
      data: expect.objectContaining({ kind: "daily_study", localPeriodKey: "2026-07-14" }),
    }));
    expect(statements).toHaveLength(2);
    expect(statements.every((statement) => statement.includes("user_id = $1"))).toBe(true);
  });

  it("exports owner-bound reward history without internal idempotency hashes", async () => {
    const statements: string[] = [];
    mocks.query.mockImplementation(async (statement: string) => {
      if (statement.includes("insert into data_lifecycle_run")) return { rows: [{ id: "run-rewards" }] };
      if (statement.includes("from reward_ledger r")
        || statement.includes("from reward_operation_receipt r")
        || statement.includes("from reward_reconciliation_job j")) {
        statements.push(statement);
        return { rows: [{ data: { policyVersion: "reward-ledger-2026-07.v1", xpDelta: 20 } }] };
      }
      return { rows: [] };
    });
    const exported = await createLearnerExport({
      learnerId: "learner-1",
      actorUserId: "admin-1",
      requestId: "81000000-0000-4000-8000-000000000017",
      maxRecords: 20,
      maxBytes: 32_768,
    });
    const lines = (await new Response(exported.stream).text()).trim().split("\n").map((line) => JSON.parse(line));
    await exported.completion;
    expect(lines.map((line) => line.category).filter(Boolean)).toEqual([
      "rewardLedger",
      "rewardOperationHistory",
      "rewardReconciliationHistory",
    ]);
    expect(statements).toHaveLength(3);
    for (const statement of statements) {
      expect(statement).toMatch(/where [rj]\.user_id = \$1/);
      expect(statement).not.toMatch(/request_hash|input_hash/);
      expect(statement).not.toMatch(/lease_token|lease_expires_at/);
    }
  });

  it("exports safe official replay metadata without hidden-runner-derived request hashes", async () => {
    let codeStatement = "";
    mocks.query.mockImplementation(async (statement: string) => {
      if (statement.includes("insert into data_lifecycle_run")) return { rows: [{ id: "run-code" }] };
      if (statement.includes("from code_submission s")) {
        codeStatement = statement;
        return { rows: [{ data: {
          id: "submission-1",
          requestId: "exam-admission-opaque",
          runnerJob: { id: "job-1", status: "failed" },
        } }] };
      }
      return { rows: [] };
    });
    const exported = await createLearnerExport({
      learnerId: "learner-1",
      actorUserId: "admin-1",
      requestId: "81000000-0000-4000-8000-000000000014",
      maxRecords: 10,
      maxBytes: 16_384,
    });
    const lines = (await new Response(exported.stream).text()).trim().split("\n").map((line) => JSON.parse(line));
    await exported.completion;

    expect(lines).toContainEqual(expect.objectContaining({
      category: "codeSubmissions",
      data: expect.objectContaining({
        requestId: "exam-admission-opaque",
        runnerJob: { id: "job-1", status: "failed" },
      }),
    }));
    const exportedSubmission = lines.find((line) => line.category === "codeSubmissions")?.data;
    expect(exportedSubmission).not.toHaveProperty("requestHash");
    expect(codeStatement).toContain("left join runner_job j on j.submission_id = s.id");
    expect(codeStatement).toContain("'requestId', s.request_id");
    expect(codeStatement).not.toMatch(/request_hash|requestHash/);
    expect(codeStatement).not.toMatch(/j\.result|j\.lease_owner|j\.limits|dispatch_request/);
  });

  it("never selects hidden-test-derived correction, form, snapshot, runner, or decision digests", async () => {
    let correctionStatement = "";
    mocks.query.mockImplementation(async (statement: string) => {
      if (statement.includes("insert into data_lifecycle_run")) return { rows: [{ id: "run-correction" }] };
      if (statement.includes("from assessment_correction_impact i")) {
        correctionStatement = statement;
        return { rows: [{ data: {
          correctionId: "correction-1",
          status: "completed",
          correctedResult: { outcome: "PASSED" },
        } }] };
      }
      return { rows: [] };
    });
    const exported = await createLearnerExport({
      learnerId: "learner-1",
      actorUserId: "admin-1",
      requestId: "81000000-0000-4000-8000-000000000015",
      maxRecords: 10,
      maxBytes: 16_384,
    });
    const lines = (await new Response(exported.stream).text()).trim().split("\n").map((line) => JSON.parse(line));
    await exported.completion;

    expect(lines).toContainEqual(expect.objectContaining({
      category: "assessmentCorrections",
      data: expect.objectContaining({ correctionId: "correction-1", status: "completed" }),
    }));
    for (const forbidden of [
      "faulty_evidence_hash",
      "replacement_evidence_hash",
      "form_hash",
      "snapshot_hash",
      "runner_evidence_hash",
      "decision_evidence_hash",
    ]) expect(correctionStatement).not.toContain(forbidden);
  });

  it("exports learner-owned project revisions and metadata snapshots without file bytes", async () => {
    let fileStatement = "";
    mocks.query.mockImplementation(async (statement: string) => {
      if (statement.includes("insert into data_lifecycle_run")) return { rows: [{ id: "run-project-revisions" }] };
      if (statement.includes("from project_revision r join project p")) {
        return { rows: [{ data: { id: "revision-1", sequence: 1, changeSummary: "Built the first slice." } }] };
      }
      if (statement.includes("from project_revision_object f")) {
        fileStatement = statement;
        return { rows: [{ data: { revisionId: "revision-1", originalName: "main.py", binaryIncluded: false } }] };
      }
      return { rows: [] };
    });
    const exported = await createLearnerExport({
      learnerId: "learner-1",
      actorUserId: "admin-1",
      requestId: "81000000-0000-4000-8000-000000000012",
      maxRecords: 10,
      maxBytes: 16_384,
    });
    const lines = (await new Response(exported.stream).text()).trim().split("\n").map((line) => JSON.parse(line));
    await exported.completion;
    expect(lines).toContainEqual(expect.objectContaining({
      category: "projectRevisions",
      data: expect.objectContaining({ sequence: 1 }),
    }));
    expect(lines).toContainEqual(expect.objectContaining({
      category: "projectRevisionFiles",
      data: expect.objectContaining({ originalName: "main.py", binaryIncluded: false }),
    }));
    expect(fileStatement).toContain("join project p on p.id = r.project_id");
    expect(fileStatement).toContain("where p.user_id = $1");
    expect(fileStatement).not.toMatch(/storage_key|binary_data|file_bytes/);
  });

  it("exports exam reliability and project-correction evidence without worker or administrator identities", async () => {
    const statements: string[] = [];
    mocks.query.mockImplementation(async (statement: string) => {
      if (statement.includes("insert into data_lifecycle_run")) return { rows: [{ id: "run-reliability" }] };
      statements.push(statement);
      if (statement.includes("from exam_reexam_grant g")) return { rows: [{ data: { id: "grant-1", evidenceHash: "a".repeat(64), administratorIdentityIncluded: false } }] };
      if (statement.includes("from exam_mastery_recheck r")) return { rows: [{ data: { id: "recheck-1", status: "completed" } }] };
      if (statement.includes("from project_review_correction c join")) return { rows: [{ data: { id: "correction-1", sourceFindingsHash: "b".repeat(64), workerIdentityIncluded: false } }] };
      if (statement.includes("from project_review_correction_event e")) return { rows: [{ data: { id: "event-1", actorIdentityIncluded: false } }] };
      if (statement.includes("from project_review_effective e")) return { rows: [{ data: { projectId: "project-1", findingsHash: "c".repeat(64) } }] };
      return { rows: [] };
    });
    const exported = await createLearnerExport({
      learnerId: "learner-1",
      actorUserId: "admin-1",
      requestId: "81000000-0000-4000-8000-000000000013",
      maxRecords: 20,
      maxBytes: 64_000,
    });
    const lines = (await new Response(exported.stream).text()).trim().split("\n").map((line) => JSON.parse(line));
    await exported.completion;
    const categories = lines.filter((line) => line.type === "record").map((line) => line.category);
    expect(categories).toEqual(expect.arrayContaining([
      "examReexamGrants", "examMasteryRechecks", "projectReviewCorrections",
      "projectReviewCorrectionEvents", "projectReviewEffective",
    ]));
    const examGrantSql = statements.find((statement) => statement.includes("from exam_reexam_grant g"))!;
    const correctionSql = statements.find((statement) => statement.includes("from project_review_correction c join"))!;
    const eventSql = statements.find((statement) => statement.includes("from project_review_correction_event e"))!;
    expect(examGrantSql).not.toMatch(/granted_by_user_id/);
    expect(correctionSql).not.toMatch(/requested_by|lease_owner|lease_expires_at|requestedBy/);
    expect(eventSql).not.toMatch(/actor_user_id|request_id/);
    expect(correctionSql).toMatch(/source_provenance|result_provenance|source_findings_hash|result_findings_hash/);
    expect(correctionSql).not.toMatch(/'evidence',\s*c\.evidence\s*[,)]/);
    expect(correctionSql).toMatch(/'authority', jsonb_build_object\([\s\S]*?'adminReasonHash'/);
    expect(correctionSql).toContain("'administratorIdentityIncluded', false");
    expect(correctionSql).toContain("'evidenceHashVerifiableFromExport', false");
  });

  it("exports owned chat lifecycle and safe per-message provider provenance without credential material", async () => {
    let chatStatement = "";
    mocks.query.mockImplementation(async (statement: string) => {
      if (statement.includes("insert into data_lifecycle_run")) return { rows: [{ id: "run-chat" }] };
      if (statement.includes("from chat_message m")) {
        chatStatement = statement;
        return { rows: [{ data: {
          id: "message-1",
          threadStatus: "archived",
          provider: "nvidia_nim",
          model: "test/model",
          credentialSource: "learner",
        } }] };
      }
      return { rows: [] };
    });
    const exported = await createLearnerExport({
      learnerId: "learner-1",
      actorUserId: "admin-1",
      requestId: "81000000-0000-4000-8000-000000000011",
      maxRecords: 10,
      maxBytes: 16_384,
    });
    const lines = (await new Response(exported.stream).text()).trim().split("\n").map((line) => JSON.parse(line));
    await exported.completion;
    expect(lines).toContainEqual(expect.objectContaining({
      category: "chatMessages",
      data: expect.objectContaining({
        threadStatus: "archived",
        provider: "nvidia_nim",
        model: "test/model",
        credentialSource: "learner",
      }),
    }));
    expect(chatStatement).toContain("where t.user_id = $1");
    expect(chatStatement).toContain("left join model_call mc");
    expect(chatStatement).not.toMatch(/ciphertext|wrapped_data_key|auth_tag|last_four/);
  });

  it("exports owner-bound certificate and public-portfolio history without operation hashes", async () => {
    const statements: string[] = [];
    mocks.query.mockImplementation(async (statement: string) => {
      if (statement.includes("insert into data_lifecycle_run")) return { rows: [{ id: "run-public-proof" }] };
      if (
        statement.includes("from public_portfolio p where")
        || statement.includes("from public_portfolio_event e")
        || statement.includes("from public_portfolio_project where")
        || statement.includes("from public_portfolio_project_snapshot snapshot")
        || statement.includes("from course_certificate certificate")
        || statement.includes("from certificate_operation_receipt receipt")
      ) {
        statements.push(statement);
        const data = statement.includes("certificate_operation_receipt")
          ? { requestId: "request-1", inputHashIncluded: false }
          : { id: "owned-public-proof" };
        return { rows: [{ data }] };
      }
      return { rows: [] };
    });
    const exported = await createLearnerExport({
      learnerId: "learner-1",
      actorUserId: "admin-1",
      requestId: "81000000-0000-4000-8000-000000000018",
      maxRecords: 20,
      maxBytes: 64_000,
    });
    const lines = (await new Response(exported.stream).text()).trim().split("\n").map((line) => JSON.parse(line));
    await exported.completion;
    expect(lines[0]).toMatchObject({ type: "manifest", schemaVersion: EXPORT_SCHEMA_VERSION });
    expect(lines.map((line) => line.category).filter(Boolean)).toEqual([
      "publicPortfolio",
      "publicPortfolioHistory",
      "publicPortfolioSelections",
      "publicPortfolioProjectSnapshots",
      "courseCertificates",
      "certificateOperationHistory",
    ]);
    expect(statements).toHaveLength(6);
    expect(statements.every((statement) => statement.includes("user_id = $1"))).toBe(true);
    const snapshot = statements.find((statement) => statement.includes("public_portfolio_project_snapshot"))!;
    expect(snapshot).toContain("'portfolioVersion', snapshot.portfolio_version");
    expect(snapshot).toContain("'sourceProjectUpdatedAt', snapshot.source_project_updated_at");
    const receipt = statements.find((statement) => statement.includes("certificate_operation_receipt"))!;
    expect(receipt).toContain("'inputHashIncluded', false");
    expect(receipt).not.toMatch(/'inputHash'|receipt\.input_hash/);
  });

  it("exports module-project provenance and safe start receipts without the canonical input hash", async () => {
    const statements: string[] = [];
    mocks.query.mockImplementation(async (statement: string) => {
      if (statement.includes("insert into data_lifecycle_run")) return { rows: [{ id: "run-module-project" }] };
      if (statement.includes("from project p where p.user_id") || statement.includes("from module_project_start_receipt receipt")) {
        statements.push(statement);
        return { rows: [{ data: statement.includes("module_project_start_receipt")
          ? { requestId: "request-1", inputHashIncluded: false }
          : { id: "project-1", assignmentTemplateId: "template-1" } }] };
      }
      return { rows: [] };
    });
    const exported = await createLearnerExport({
      learnerId: "learner-1",
      actorUserId: "admin-1",
      requestId: "81000000-0000-4000-8000-000000000019",
      maxRecords: 20,
      maxBytes: 64_000,
    });
    const lines = (await new Response(exported.stream).text()).trim().split("\n").map((line) => JSON.parse(line));
    await exported.completion;
    expect(lines[0]).toMatchObject({ type: "manifest", schemaVersion: EXPORT_SCHEMA_VERSION });
    expect(lines.map((line) => line.category).filter(Boolean)).toEqual(["projects", "moduleProjectStartHistory"]);
    const projectStatement = statements.find((statement) => statement.includes("from project p where"))!;
    expect(projectStatement).toContain("'assignmentProvenance', p.assignment_provenance");
    const receiptStatement = statements.find((statement) => statement.includes("module_project_start_receipt"))!;
    expect(receiptStatement).toContain("where receipt.user_id = $1");
    expect(receiptStatement).toContain("'inputHashIncluded', false");
    expect(receiptStatement).not.toMatch(/receipt\.input_hash|'inputHash'/);
  });

  it("reserves the footer inside a tight byte limit and marks omitted data truncated", async () => {
    mocks.query.mockImplementation(async (statement: string) => {
      if (statement.includes("insert into data_lifecycle_run")) return { rows: [{ id: "run-2" }] };
      if (statement.includes('from "user" u left join learner_profile')) {
        return { rows: [{ data: { bio: "x".repeat(2_000) } }] };
      }
      return { rows: [] };
    });
    const exported = await createLearnerExport({
      learnerId: "10000000-0000-4000-8000-000000000001",
      actorUserId: "admin-1",
      requestId: "81000000-0000-4000-8000-000000000003",
      maxRecords: 1_000,
      maxBytes: 1_024,
    });
    const text = await new Response(exported.stream).text();
    const metrics = await exported.completion;
    const lines = text.trim().split("\n").map((line) => JSON.parse(line));

    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(1_024);
    expect(lines.map((line) => line.type)).toEqual(["manifest", "footer"]);
    expect(lines.at(-1)).toMatchObject({ records: 0, truncated: true });
    expect(metrics.truncated).toBe(true);
  });

  it("detects records in a later category when the record ceiling is reached", async () => {
    mocks.query.mockImplementation(async (statement: string) => {
      if (statement.includes("insert into data_lifecycle_run")) return { rows: [{ id: "run-3" }] };
      if (statement.includes('from "user" u left join learner_profile')) {
        return { rows: [{ data: { id: "learner-1" } }] };
      }
      if (statement.includes("from enrollment e")) return { rows: [{ data: { id: "enrollment-1" } }] };
      return { rows: [] };
    });
    const exported = await createLearnerExport({
      learnerId: "learner-1",
      actorUserId: "admin-1",
      requestId: "81000000-0000-4000-8000-000000000004",
      maxRecords: 1,
      maxBytes: 16_384,
    });
    await new Response(exported.stream).text();
    await expect(exported.completion).resolves.toMatchObject({ records: 1, truncated: true });
  });

  it("fails closed for an unauthorized/duplicate claim and records stream failures safely", async () => {
    mocks.query.mockResolvedValueOnce({ rows: [] });
    await expect(createLearnerExport({
      learnerId: "learner-1",
      actorUserId: "learner-1",
      requestId: "81000000-0000-4000-8000-000000000005",
    })).rejects.toThrow(/not authorized/i);

    mocks.query.mockReset().mockImplementation(async (statement: string) => {
      if (statement.includes("insert into data_lifecycle_run")) return { rows: [{ id: "run-failed" }] };
      if (statement.includes("update data_lifecycle_run")) return { rows: [] };
      throw new Error("synthetic query failure");
    });
    const exported = await createLearnerExport({
      learnerId: "learner-1",
      actorUserId: "admin-1",
      requestId: "81000000-0000-4000-8000-000000000006",
    });
    const completion = expect(exported.completion).rejects.toThrow("synthetic query failure");
    await expect(new Response(exported.stream).text()).rejects.toThrow("synthetic query failure");
    await completion;
    expect(mocks.query).toHaveBeenCalledWith(
      expect.stringContaining("EXPORT_STREAM_FAILED"),
      expect.any(Array),
    );
  });
});
