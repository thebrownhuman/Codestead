import { buildEquivalentExamForm } from "@/lib/exams/blueprint";
import { validateAuthoredContentSet } from "@/lib/content/authored";
import { parseAssessmentBank, parseAuthoredLesson } from "@/lib/content/authored-schema";
import { validateContentSet } from "@/lib/content/integrity";
import { ContentGraph } from "@/lib/content/graph";
import { parseCourseManifest } from "@/lib/content/schema";
import type { ContentSnapshot } from "@/lib/content/types";
import { evaluateExamReadiness } from "@/lib/domain/mastery";

import { curriculumReleaseEvidenceSchema, type CurriculumReleaseEvidence } from "./contracts";
import { aggregateArtifactHash, hashCurriculumValue } from "./hash";

export const NOT_RUN_REPORTS = ["codeExecution", "security", "webAccessibility", "languageParity"] as const;
export interface ReleaseArtifact {
  artifact_key: string;
  artifact_type: string;
  skill_key: string | null;
  content: unknown;
  content_hash: string;
}

/** Pure checks over the immutable version; no remote execution or database writes. */
export function computeReleaseEvidence(input: {
  artifacts: readonly ReleaseArtifact[]; contentHash: string; snapshot: ContentSnapshot;
  actorUserId: string; now: Date; notRunReason: string;
}): CurriculumReleaseEvidence {
  const { artifacts, contentHash, snapshot } = input;
  if (artifacts.some((row) => hashCurriculumValue(row.content) !== row.content_hash)
    || aggregateArtifactHash(artifacts.map((row) => ({ artifactKey: row.artifact_key, artifactType: row.artifact_type, contentHash: row.content_hash }))) !== contentHash) {
    throw new Error("CONTENT_HASH_MISMATCH");
  }
  const manifests = artifacts.filter((row) => row.artifact_type === "course_manifest");
  if (manifests.length !== 1) throw new Error("MANIFEST_CARDINALITY");
  const course = parseCourseManifest(manifests[0].content, manifests[0].artifact_key);
  // Use the real catalog and other manifests for cross-course prerequisites.
  // Replace only this course with the immutable database version being checked.
  const courses = [...snapshot.courses.filter((entry) => entry.id !== course.id), course];
  const index = validateContentSet(snapshot.catalog, courses, { roadmapManifests: snapshot.roadmapTracks });
  const lessonRows = artifacts.filter((row) => row.artifact_type === "authored_lesson");
  const bankRows = artifacts.filter((row) => row.artifact_type === "assessment_bank");
  if (artifacts.length !== 1 + lessonRows.length + bankRows.length) throw new Error("UNKNOWN_ARTIFACT_TYPE");
  const lessons = lessonRows.map((row) => parseAuthoredLesson(row.content, row.artifact_key));
  const banks = bankRows.map((row) => parseAssessmentBank(row.content, row.artifact_key));
  if (banks.some((bank) => bank.items.some((item) => !item.examEligibility.eligible))) throw new Error("EXAM_ITEM_INELIGIBLE");
  validateAuthoredContentSet({ lessons, assessmentBanks: banks }, index);
  const skills = course.modules.flatMap((entry) => entry.skills);
  for (const skill of skills) {
    if (lessons.filter((entry) => entry.skillId === skill.id).length !== 1
      || banks.filter((entry) => entry.skillId === skill.id).length !== 1) throw new Error("SKILL_COVERAGE_MISSING");
    const cited = new Set([
      ...lessons.filter((entry) => entry.skillId === skill.id).flatMap((entry) => entry.sources.map((citation) => citation.sourceRef)),
      ...banks.filter((entry) => entry.skillId === skill.id).flatMap((entry) => entry.sourceRefs),
    ]);
    if (skill.source_refs.some((reference) => !cited.has(reference))) throw new Error("SOURCE_COVERAGE_MISSING");
  }
  for (const [rows, entries] of [[lessonRows, lessons], [bankRows, banks]] as const) {
    if (entries.some((entry, position) => entry.courseId !== course.id || rows[position].skill_key !== entry.skillId)) throw new Error("ARTIFACT_IDENTITY_MISMATCH");
  }
  // This builds the actual deterministic forms; it does not execute their code.
  const forms = course.modules.map((module) => buildEquivalentExamForm({
    course, module, catalogVersion: `published:${contentHash}`, now: input.now,
    seed: `release-evidence:${contentHash}:${module.id}`,
    formId: `release-evidence:${module.id}`,
    assessmentBanks: banks.filter((bank) => bank.moduleId === module.id),
  }));
  if (forms.some((form) => form.items.length === 0 || form.items.some((item) => item.gradingEvidence.kind === "pending-review"))) throw new Error("EXAM_FORM_INVALID");
  const graph = new ContentGraph(snapshot.catalog, index);
  const graphChecks = skills.map((skill) => {
    const empty = graph.evaluateNodeEligibility(skill.id, []);
    const achieved = graph.evaluateNodeEligibility(skill.id, index.skillById.keys());
    if (empty.eligible !== (empty.directPrerequisites.length === 0) || !achieved.eligible) throw new Error("DAG_MASTERY_INVALID");
    return { skillId: skill.id, empty, achieved };
  });
  // A policy check using explicit synthetic inputs, not learner mastery evidence.
  const masteryChecks = [0, 1].map((masteryProbability) => evaluateExamReadiness({ masteryProbability, evidence: [], activeMisconceptions: [] }));
  if (masteryChecks.some((check) => check.eligible)) throw new Error("DAG_MASTERY_INVALID");
  const report = (check: string, result: unknown) => ({ passed: true as const,
    reportHash: hashCurriculumValue({ check, contentHash, result }) });
  const notRun = { status: "not_run" as const, reason: input.notRunReason,
    acknowledgedBy: input.actorUserId, acknowledgedAt: input.now.toISOString() };
  const sourceRefs = [...new Set(skills.flatMap((skill) => skill.source_refs))].sort();
  const skillCoverage = { skillIds: skills.map((skill) => skill.id),
    lessonArtifactKeys: lessonRows.map((row) => row.artifact_key), assessmentBankArtifactKeys: bankRows.map((row) => row.artifact_key) };
  // Exclusions are schema-validated manifest non-goals, not invented security assurances.
  const exclusions = [...course.scope.non_goals];
  return curriculumReleaseEvidenceSchema.parse({
    schemaVersion: 1, generatedAt: input.now.toISOString(), generator: "codestead-server-release-checks-v1",
    sourceCoverage: { ...report("validateContentSet + validateAuthoredContentSet: source references", sourceRefs), sourceRefs },
    skillCoverage: { ...report("exact immutable skill coverage", skillCoverage), ...skillCoverage },
    dagMastery: report("validateContentSet + ContentGraph: prerequisite DAG; evaluateExamReadiness: synthetic no-evidence boundaries; buildEquivalentExamForm: skill coverage", {
      nodes: skills.map((skill) => ({ id: skill.id, prerequisites: skill.prerequisites, evidenceTypes: skill.evidence_types })),
      formHashes: forms.map((form) => hashCurriculumValue(form)),
      graphChecks, masteryChecks,
    }),
    codeExecution: notRun, security: notRun, webAccessibility: notRun, languageParity: notRun,
    exclusions: { reportHash: hashCurriculumValue({ check: "parseCourseManifest: declared non-goals", contentHash, items: exclusions }), items: exclusions },
  });
}
