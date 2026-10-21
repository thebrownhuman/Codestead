import { beforeAll, describe, expect, it } from "vitest";
import { FileSystemContentLoader } from "@/lib/content/loader";
import { aggregateArtifactHash, hashCurriculumValue } from "../hash";
import { computeReleaseEvidence, type ReleaseArtifact } from "../release-generation";

const loader = new FileSystemContentLoader();
let artifacts: ReleaseArtifact[];
let snapshot: Awaited<ReturnType<typeof loader.loadSnapshot>>;
const admin = "owner-admin";
const now = new Date("2026-10-07T12:00:00Z");
function contentHash(rows: ReleaseArtifact[]) {
  return aggregateArtifactHash(rows.map((row) => ({ artifactKey: row.artifact_key, artifactType: row.artifact_type, contentHash: row.content_hash })));
}
beforeAll(async () => {
  snapshot = await loader.loadSnapshot();
  const authored = await loader.loadAuthoredContentSet();
  const course = snapshot.courses.find((entry) => entry.id === "python") ?? snapshot.courses[0];
  artifacts = [{ artifact_key: course.id, artifact_type: "course_manifest", skill_key: null, content: course, content_hash: hashCurriculumValue(course) },
    ...authored.lessons.filter((entry) => entry.courseId === course.id).map((entry) => ({ artifact_key: entry.id, artifact_type: "authored_lesson", skill_key: entry.skillId, content: entry, content_hash: hashCurriculumValue(entry) })),
    ...authored.assessmentBanks.filter((entry) => entry.courseId === course.id).map((entry) => {
      // An explicitly approved TEST fixture; production draft flags are never changed.
      const approved = { ...entry, publication: { ...entry.publication, stage: "approved",
        reviewer: { id: "test-owner", displayName: "Test Owner", kind: "human", reviewedAt: now.toISOString(), reviewVersion: "1.0.0" } },
      items: entry.items.map((item) => ({ ...item, examEligibility: { ...item.examEligibility, eligible: true } })) };
      return { artifact_key: entry.id, artifact_type: "assessment_bank", skill_key: entry.skillId, content: approved, content_hash: hashCurriculumValue(approved) };
    })];
});
function compute(rows = artifacts) {
  return computeReleaseEvidence({ artifacts: rows, contentHash: contentHash(rows), snapshot, actorUserId: admin, now, notRunReason: "Live checks have not run pending grading parity." });
}
describe("computed release reports", () => {
  it("computes real coverage, DAG/mastery and exclusions while never claiming live checks passed", () => {
    const result = compute();
    expect(result.sourceCoverage.passed).toBe(true);
    expect(result.skillCoverage.passed).toBe(true);
    expect(result.dagMastery.passed).toBe(true);
    for (const name of ["codeExecution", "security", "webAccessibility", "languageParity"] as const) {
      expect(result[name]).toEqual({ status: "not_run", reason: "Live checks have not run pending grading parity.", acknowledgedBy: admin, acknowledgedAt: now.toISOString() });
    }
  });
  it("refuses corrupted content rather than manufacturing a pass", () => {
    expect(() => compute([{ ...artifacts[0], content_hash: "0".repeat(64) }, ...artifacts.slice(1)])).toThrow(/HASH/);
  });
  it("refuses incomplete skill coverage", () => {
    expect(() => compute(artifacts.filter((row) => row.artifact_type !== "assessment_bank"))).toThrow();
  });
  it("does not claim source coverage when a promised source has no artifact citation", () => {
    const course = structuredClone(snapshot.courses.find((entry) => entry.id === artifacts[0].artifact_key)!);
    const skill = course.modules[0].skills[0];
    const content = { ...course, authoritative_sources: [...course.authoritative_sources, { ...course.authoritative_sources[0], id: "test-uncovered-source" }],
      modules: [{ ...course.modules[0], skills: [{ ...skill, source_refs: [...skill.source_refs, "test-uncovered-source"] }, ...course.modules[0].skills.slice(1)] }, ...course.modules.slice(1)] };
    expect(() => compute([{ ...artifacts[0], content, content_hash: hashCurriculumValue(content) }, ...artifacts.slice(1)])).toThrow("SOURCE_COVERAGE_MISSING");
  });
  it("refuses a prerequisite cycle", () => {
    const course = structuredClone(snapshot.courses.find((entry) => entry.id === artifacts[0].artifact_key)!);
    const skill = course.modules[0].skills[0];
    const content = { ...course, modules: [{ ...course.modules[0], skills: [{ ...skill, prerequisites: [skill.id] }, ...course.modules[0].skills.slice(1)] }, ...course.modules.slice(1)] };
    expect(() => compute([{ ...artifacts[0], content, content_hash: hashCurriculumValue(content) }, ...artifacts.slice(1)])).toThrow();
  });
  it("refuses invalid exam forms", () => {
    const rows = artifacts.map((row) => {
      if (row.artifact_type !== "assessment_bank") return row;
      const content = { ...(row.content as object), items: [] };
      return { ...row, content, content_hash: hashCurriculumValue(content) };
    });
    expect(() => compute(rows)).toThrow();
  });
  it("publishes course content whose banks are all exam-ineligible", () => {
    const rows = artifacts.map((row) => {
      if (row.artifact_type !== "assessment_bank") return row;
      const bank = row.content as { items: Array<{ examEligibility: object }> };
      const content = { ...bank, items: bank.items.map((item) => ({ ...item, examEligibility: { ...item.examEligibility, eligible: false } })) };
      return { ...row, content, content_hash: hashCurriculumValue(content) };
    });
    const result = compute(rows);
    expect(result.skillCoverage.passed).toBe(true);
    expect(result.dagMastery.passed).toBe(true);
  });
  it("still builds exam forms only from eligible items", async () => {
    const { buildEquivalentExamForm } = await import("@/lib/exams/blueprint");
    const { parseCourseManifest } = await import("@/lib/content/schema");
    const course = parseCourseManifest(artifacts[0].content, artifacts[0].artifact_key);
    const banks = artifacts.filter((row) => row.artifact_type === "assessment_bank").map((row) => {
      const bank = row.content as { moduleId: string; items: Array<{ id: string; examEligibility: object }> };
      return { ...bank, items: bank.items.map((item) => ({ ...item, examEligibility: { ...item.examEligibility, eligible: false } })) };
    });
    const ineligibleIds = new Set(banks.flatMap((bank) => bank.items.map((item) => item.id)));
    const courseModule = course.modules[0];
    const form = buildEquivalentExamForm({ course, module: courseModule, catalogVersion: "published:test", now, seed: "s", formId: "f",
      assessmentBanks: banks.filter((bank) => bank.moduleId === courseModule.id) as never });
    expect(form.items.every((item) => item.gradingEvidence.kind === "pending-review")).toBe(true);
    expect(form.items.some((item) => ineligibleIds.has(item.id))).toBe(false);
  });
});
