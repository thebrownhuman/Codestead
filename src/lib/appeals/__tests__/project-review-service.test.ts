import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ connect: vi.fn() }));

vi.mock("@/lib/db/client", () => ({ pool: { connect: mocks.connect } }));

import {
  ProjectReviewAppealError,
  submitProjectReviewAppeal,
} from "../project-review-service";

const input = {
  userId: "learner-user",
  projectId: "10000000-0000-4000-8000-000000000001",
  projectReviewId: "10000000-0000-4000-8000-000000000002",
  clientRequestId: "10000000-0000-4000-8000-000000000003",
  category: "project_finding" as const,
  reason: "The secret finding points to a documented test fixture.",
  now: new Date("2026-07-12T10:00:00.000Z"),
};

const review = {
  review_id: input.projectReviewId,
  commit_sha: "abc123immutable",
  analyzer_version: "static-review-v1",
  rubric_version: "static-project-review-rubric-v1",
  model_call_id: null,
  analysis_provenance: {
    schemaVersion: 1,
    analysisMode: "deterministic_static",
    aiUsed: false,
    promptVersion: null,
    provider: null,
    model: null,
    modelCallId: null,
    rubricVersion: "static-project-review-rubric-v1",
    repositoryExecution: "none",
    runnerTemplateId: null,
  },
  findings: [{ rule: "secret-scan", file: "src/test.ts", line: 4 }],
  findings_hash: null,
  review_status: "complete",
  review_created_at: new Date("2026-07-12T09:00:00.000Z"),
  project_id: input.projectId,
  project_title: "Portfolio API",
  github_url: "https://github.com/example/project",
  github_commit_sha: "abc123immutable",
};

describe("project-review appeal service", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    [{ clientRequestId: "not-a-uuid" }, "INVALID_REQUEST_ID"],
    [{ reason: "too short" }, "INVALID_REASON"],
    [{ now: new Date(Number.NaN) }, "INVALID_TIME"],
  ])("validates %o before opening a transaction", async (override, code) => {
    await expect(submitProjectReviewAppeal({ ...input, ...override }))
      .rejects.toMatchObject({ code });
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it("creates one immutable submission event and notifies active administrators", async () => {
    const query = vi.fn(async (statement: string, values?: unknown[]) => {
      void values;
      if (statement === "begin" || statement.startsWith("select pg_advisory")) return { rows: [] };
      if (statement.includes("from project_review pr")) return { rows: [review] };
      if (statement.includes("where user_id = $1 and submission_request_id")) return { rows: [] };
      if (statement.startsWith("select id from appeal")) return { rows: [] };
      if (statement.startsWith("insert into appeal\n")) {
        return { rows: [{ id: "20000000-0000-4000-8000-000000000001" }] };
      }
      if (statement.startsWith("insert into appeal_event")) return { rows: [] };
      if (statement.startsWith("insert into notification")) return { rows: [] };
      if (statement === "commit") return { rows: [] };
      throw new Error(`Unexpected query: ${statement}`);
    });
    const release = vi.fn();
    mocks.connect.mockResolvedValue({ query, release });

    const result = await submitProjectReviewAppeal(input);
    expect(result).toMatchObject({ accepted: true, duplicate: false });
    expect(result.evidenceHash).toMatch(/^[0-9a-f]{64}$/);
    const appealInsert = query.mock.calls.find(([statement]) => String(statement).startsWith("insert into appeal\n"));
    const evidence = JSON.parse(String(appealInsert?.[1]?.[5]));
    expect(evidence.review).toMatchObject({
      commitSha: "abc123immutable",
      analyzerVersion: "static-review-v1",
      findings: review.findings,
    });
    expect(query.mock.calls.some(([statement]) => String(statement).startsWith("insert into appeal_event"))).toBe(true);
    expect(query.mock.calls.some(([statement]) => String(statement).startsWith("insert into notification"))).toBe(true);
    expect(query.mock.calls.some(([statement]) => /update project|update project_review/i.test(String(statement)))).toBe(false);
    expect(release).toHaveBeenCalledOnce();
  });

  it("replays the same request without inserting another appeal or event", async () => {
    const query = vi.fn(async (statement: string, values?: unknown[]) => {
      void values;
      if (statement === "begin" || statement.startsWith("select pg_advisory")) return { rows: [] };
      if (statement.includes("from project_review pr")) return { rows: [review] };
      if (statement.includes("where user_id = $1 and submission_request_id")) {
        return { rows: [{
          id: "20000000-0000-4000-8000-000000000001",
          project_review_id: input.projectReviewId,
          category: input.category,
          reason: input.reason,
          evidence_hash: "a".repeat(64),
        }] };
      }
      if (statement === "commit") return { rows: [] };
      throw new Error(`Unexpected query: ${statement}`);
    });
    mocks.connect.mockResolvedValue({ query, release: vi.fn() });
    await expect(submitProjectReviewAppeal(input)).resolves.toMatchObject({
      duplicate: true,
      evidenceHash: "a".repeat(64),
    });
    expect(query.mock.calls.some(([statement]) => String(statement).startsWith("insert into"))).toBe(false);
  });

  it("does not disclose whether another learner owns the requested review", async () => {
    const query = vi.fn(async (statement: string, values?: unknown[]) => {
      void values;
      if (statement === "begin" || statement.startsWith("select pg_advisory") || statement === "rollback") return { rows: [] };
      if (statement.includes("from project_review pr")) return { rows: [] };
      throw new Error(`Unexpected query: ${statement}`);
    });
    const release = vi.fn();
    mocks.connect.mockResolvedValue({ query, release });
    const submission = submitProjectReviewAppeal(input);
    await expect(submission).rejects.toBeInstanceOf(ProjectReviewAppealError);
    await expect(submission).rejects.toMatchObject({ code: "REVIEW_NOT_FOUND" });
    expect(query).toHaveBeenCalledWith("rollback");
    expect(release).toHaveBeenCalledOnce();
  });
});
