import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ connect: vi.fn(), compute: vi.fn(), snapshot: vi.fn(), gate: vi.fn() }));
vi.mock("@/lib/db/client", () => ({ pool: { connect: mocks.connect } }));
vi.mock("@/lib/content/loader", () => ({ FileSystemContentLoader: class { loadSnapshot = mocks.snapshot; } }));
vi.mock("../release-generation", () => ({ computeReleaseEvidence: mocks.compute, NOT_RUN_REPORTS: ["codeExecution", "security", "webAccessibility", "languageParity"] }));
vi.mock("../gate", () => ({ evaluateCurriculumPublicationGate: mocks.gate }));
import { generateCurriculumReleaseEvidence } from "../admin-service";
import { aggregateArtifactHash, hashCurriculumValue } from "../hash";
const content = { test: "immutable content" };
const artifacts = [{ artifact_key: "course", artifact_type: "course_manifest", skill_key: null, content, content_hash: hashCurriculumValue(content) }];
const hash = aggregateArtifactHash(artifacts.map((row) => ({ artifactKey: row.artifact_key, artifactType: row.artifact_type, contentHash: row.content_hash })));
const input = { actorUserId: "admin", courseVersionId: "e1000000-0000-4000-8000-000000000001", requestId: "f1000000-0000-4000-8000-000000000001", expectedVersion: 1, expectedContentHash: hash, acknowledgeNotRun: true as const, notRunReason: "Live checks are deferred.", reason: "Owner accepts deferred beta checks." };
let prior: Record<string, unknown> | undefined;
let role: string;
let storedHash: string;
let queries: string[];
let inTransaction: boolean;
let revision: number;
beforeEach(() => {
  vi.clearAllMocks(); prior = undefined; role = "admin"; storedHash = hash; queries = []; inTransaction = false; revision = 1;
  mocks.snapshot.mockResolvedValue({});
  mocks.compute.mockImplementation(() => {
    expect(inTransaction).toBe(false);
    return { generator: "codestead-server-release-checks-v1", codeExecution: { status: "not_run", reason: input.notRunReason }, security: { status: "not_run", reason: input.notRunReason }, webAccessibility: { status: "not_run", reason: input.notRunReason }, languageParity: { status: "not_run", reason: input.notRunReason } };
  });
  mocks.gate.mockResolvedValue({ allowed: true, issues: [] });
  mocks.connect.mockResolvedValue({ release: vi.fn(), query: vi.fn(async (sql: string, args: unknown[] = []) => {
    const normalized = sql.replace(/\s+/g, " ").trim(); queries.push(normalized);
    if (normalized === "begin") inTransaction = true;
    if (normalized === "commit" || normalized === "rollback") inTransaction = false;
    let rows: unknown[] = [];
    if (normalized.includes('from "user"')) rows = [{ role, status: "active" }];
    else if (normalized.startsWith("select") && normalized.includes("from course_version")) rows = [{ course_id: "course", content_hash: storedHash, stage: "verified", publication_revision: revision }];
    else if (normalized.includes("from curriculum_artifact")) rows = artifacts;
    else if (normalized.includes("join curriculum_publication_event")) rows = prior ? [prior] : [];
    else if (normalized.includes("coalesce(max(evidence_version)")) rows = [{ version: 1 }];
    else if (normalized.startsWith("insert into curriculum_release_evidence")) {
      prior = { submitted_by: args[1], content_hash: args[4], evidence: JSON.parse(String(args[5])), evidence_hash: args[6], evidence_version: 1, reason: input.reason, event_evidence: { resultingVersion: 2, expectedVersion: 1 } };
    }
    else if (normalized.startsWith("update course_version")) revision += 1;
    return { rows, rowCount: 1 };
  }) });
});
describe("release generation service", () => {
  it("computes before the transaction and writes evidence plus its audit event atomically", async () => {
    const result = await generateCurriculumReleaseEvidence(input);
    expect(result.evidenceVersion).toBe(1);
    expect(queries.some((sql) => sql.startsWith("insert into curriculum_release_evidence"))).toBe(true);
    expect(queries.some((sql) => sql.includes("'evidence_submitted'"))).toBe(true);
    expect(queries.at(-1)).toBe("commit");
  });
  it("replays without duplicate evidence or renewed acknowledgement", async () => {
    await generateCurriculumReleaseEvidence(input);
    const first = prior;
    const replay = await generateCurriculumReleaseEvidence(input);
    expect(replay.replayed).toBe(true); expect(prior).toBe(first);
    expect(queries.filter((sql) => sql.startsWith("insert into curriculum_release_evidence"))).toHaveLength(1);
  });
  it("refuses an expected content hash mismatch", async () => {
    storedHash = "0".repeat(64);
    await expect(generateCurriculumReleaseEvidence(input)).rejects.toThrow("CONTENT_HASH_MISMATCH");
    expect(mocks.compute).not.toHaveBeenCalled();
  });
  it("rechecks the hash under the publication lock after checks ran", async () => {
    const compute = mocks.compute.getMockImplementation()!;
    mocks.compute.mockImplementationOnce(() => { const result = compute(); storedHash = "0".repeat(64); return result; });
    await expect(generateCurriculumReleaseEvidence(input)).rejects.toThrow("CONTENT_HASH_MISMATCH");
    expect(queries.at(-1)).toBe("rollback");
    expect(queries.some((sql) => sql.startsWith("insert into curriculum_release_evidence"))).toBe(false);
  });
  it("rejects an idempotency key reused with a different acknowledgement reason", async () => {
    await generateCurriculumReleaseEvidence(input);
    await expect(generateCurriculumReleaseEvidence({ ...input, notRunReason: "A different deferred-check reason." })).rejects.toThrow("IDEMPOTENCY_MISMATCH");
    expect(queries.filter((sql) => sql.startsWith("insert into curriculum_release_evidence"))).toHaveLength(1);
  });
  it("rolls the evidence write back when the publication gate rejects the course", async () => {
    mocks.gate.mockResolvedValueOnce({ allowed: false, issues: [{ code: "HUMAN_REVIEW_MISSING" }] });
    await expect(generateCurriculumReleaseEvidence({ ...input, targetStage: "beta" })).rejects.toThrow("PUBLICATION_GATE_BLOCKED");
    expect(queries.at(-1)).toBe("rollback");
    expect(queries.filter((sql) => sql === "commit")).toHaveLength(0);
  });
  it("rejects non-admins", async () => {
    role = "learner";
    await expect(generateCurriculumReleaseEvidence(input)).rejects.toThrow("ADMIN_REQUIRED");
    expect(mocks.compute).not.toHaveBeenCalled();
  });
  it("rejects an unacknowledged request", async () => {
    await expect(generateCurriculumReleaseEvidence({ ...input, acknowledgeNotRun: false } as never)).rejects.toThrow("INVALID_REQUEST");
  });
  it("creates evidence and publishes on the same transaction when requested", async () => {
    await generateCurriculumReleaseEvidence({ ...input, targetStage: "beta" });
    expect(queries.filter((sql) => sql === "begin")).toHaveLength(1);
    expect(queries.filter((sql) => sql === "commit")).toHaveLength(1);
    expect(queries.some((sql) => sql.startsWith("insert into curriculum_publication_pointer"))).toBe(true);
  });
});
