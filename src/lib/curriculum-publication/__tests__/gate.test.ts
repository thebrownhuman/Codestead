import { describe, expect, it, vi } from "vitest";

import { evaluateCurriculumPublicationGate, unreviewedCurriculumWaived } from "../gate";
import { hashCurriculumValue } from "../hash";

const HEX64 = "a".repeat(64);
const DIGEST = `sha256:${HEX64}`;

function makeClient(responses: unknown[][]) {
  const queue = [...responses];
  return {
    query: vi.fn(async () => {
      const rows = queue.shift() ?? [];
      return { rows, command: "SELECT", rowCount: rows.length, oid: 0, fields: [] };
    }),
  };
}

function passedReport(extra: Record<string, unknown> = {}) {
  return { passed: true, reportHash: HEX64, ...extra };
}

function scopedReport(extra: Record<string, unknown> = {}) {
  return { status: "not_applicable", reportHash: HEX64, rationale: "not applicable in this fixture", ...extra };
}

function validChecklist() {
  const dimension = { passed: true, evidenceRef: "evidence-reference-value", note: "a sufficiently long review note" };
  return {
    technical: dimension,
    source: dimension,
    pedagogy: dimension,
    accessibility: dimension,
    security: dimension,
    answerOracle: dimension,
    exampleExecution: dimension,
  };
}

const validSkill = {
  id: "dsa.arrays",
  title: "Arrays",
  description: "Arrays fundamentals",
  outcomes: ["explain array indexing correctly"],
  prerequisites: [],
  evidence_types: ["concept-check"],
  status: "required",
  coverage_status: "covered",
  source_refs: ["src-1"],
};

const validManifest = {
  $schema: "schema",
  id: "dsa",
  title: "Data Structures",
  version: "1.0.0",
  status: "beta",
  release: "launch-1",
  summary: "A course covering the fundamentals of data structures thoroughly.",
  audience: {
    level: "beginner",
    assumed_knowledge: ["basic programming"],
    target_capability: "implement core data structures independently",
  },
  scope: {
    includes: ["arrays"],
    non_goals: ["advanced graph theory"],
  },
  authoritative_sources: [
    { id: "src-1", title: "Reference Source", url: "https://example.com", type: "standard", version_or_date: "2024" },
  ],
  runtime: {
    kind: "programming-language",
    language: "javascript",
    standard: "es2022",
    toolchain: ["node"],
    execution_environment: "node",
    file_extensions: [".js"],
    notes: ["note"],
  },
  modules: [
    {
      id: "m1",
      title: "Module One",
      description: "The first module of the course",
      required: true,
      prerequisites: [],
      skills: [validSkill],
    },
  ],
  exit_outcomes: ["exit outcome number one", "exit outcome number two"],
  coverage_summary: {
    required_skills: 1,
    elective_skills: 0,
    total_skills: 1,
    covered: 1,
    partial: 0,
    planned: 0,
  },
};

function manifestArtifact() {
  const content = validManifest;
  return {
    id: "artifact-manifest",
    artifact_key: "course-manifest",
    artifact_type: "course_manifest",
    skill_key: null,
    content,
    content_hash: hashCurriculumValue(content),
    publication_stage: "approved",
    review_status: "approved",
  };
}

function lessonArtifact() {
  const content: Record<string, unknown> = {
    publication: { stage: "approved", reviewer: { kind: "human" } },
  };
  return {
    id: "artifact-lesson",
    artifact_key: "lesson-arrays",
    artifact_type: "authored_lesson",
    skill_key: "dsa.arrays",
    content,
    content_hash: hashCurriculumValue(content),
    publication_stage: "approved",
    review_status: "approved",
  };
}

function bankArtifact() {
  const content: Record<string, unknown> = {
    publication: { stage: "approved", reviewer: { kind: "human" } },
    items: [{ id: "item1", kind: "code", examEligibility: { eligible: true } }],
  };
  return {
    id: "artifact-bank",
    artifact_key: "bank-arrays",
    artifact_type: "assessment_bank",
    skill_key: "dsa.arrays",
    content,
    content_hash: hashCurriculumValue(content),
    publication_stage: "approved",
    review_status: "approved",
  };
}

function reviewFor(
  artifact: { id: string; content_hash: string },
  reviewedItemIds: string[],
) {
  return {
    artifact_id: artifact.id,
    reviewer_kind: "human",
    decision: "approved",
    content_hash: artifact.content_hash,
    checklist: validChecklist(),
    reviewed_item_ids: reviewedItemIds,
  };
}

function fullHappyPathClient() {
  const manifest = manifestArtifact();
  const lesson = lessonArtifact();
  const bank = bankArtifact();
  const artifacts = [manifest, lesson, bank];
  const contentHash = (globalThis as { __aggregateHash?: string }).__aggregateHash;
  void contentHash;
  const version = {
    id: "course-version-1",
    stage: "draft",
    content_hash: "placeholder",
  };
  // Compute the aggregate hash the same way gate.ts does, then bind it to the version row.
  const aggregate = hashCurriculumValue(
    [...artifacts]
      .map(({ artifact_key, artifact_type, content_hash }) => ({ artifactKey: artifact_key, artifactType: artifact_type, contentHash: content_hash }))
      .sort((a, b) => (a.artifactKey < b.artifactKey ? -1 : a.artifactKey > b.artifactKey ? 1 : 0)),
  );
  version.content_hash = aggregate;

  const reviews = [
    reviewFor(manifest, [manifest.artifact_key]),
    reviewFor(lesson, [lesson.artifact_key]),
    reviewFor(bank, ["item1"]),
  ];

  const runtimeLessonRow = { slug: "dsa.arrays", content_status: "beta", block_count: 1 };
  const bundleRow = {
    item_id: "item1",
    harness_hash: HEX64,
    runtime_image_digest: DIGEST,
    verified_at: new Date("2024-01-01T00:00:00Z"),
  };

  const releaseEvidence = {
    schemaVersion: 1,
    generatedAt: "2024-01-01T00:00:00Z",
    generator: "release-evidence-generator",
    sourceCoverage: passedReport({ sourceRefs: ["src-1"] }),
    skillCoverage: passedReport({
      skillIds: ["dsa.arrays"],
      lessonArtifactKeys: [lesson.artifact_key],
      assessmentBankArtifactKeys: [bank.artifact_key],
    }),
    dagMastery: passedReport(),
    codeExecution: passedReport({ executedItemIds: ["item1"], runtimeImageDigests: [DIGEST] }),
    languageParity: scopedReport({ languages: [] }),
    webAccessibility: scopedReport(),
    security: passedReport(),
    exclusions: { reportHash: HEX64, items: [] },
  };
  const releaseRow = {
    evidence_version: 1,
    content_hash: version.content_hash,
    evidence: releaseEvidence,
    evidence_hash: hashCurriculumValue(releaseEvidence),
  };

  const client = makeClient([
    [version],
    artifacts,
    reviews,
    [runtimeLessonRow],
    [bundleRow],
    [releaseRow],
  ]);
  return { client, version, artifacts, manifest, lesson, bank };
}

describe("evaluateCurriculumPublicationGate", () => {
  it("reports COURSE_VERSION_MISSING when the candidate does not exist", async () => {
    const client = makeClient([[]]);
    const report = await evaluateCurriculumPublicationGate({
      courseVersionId: "missing",
      targetStage: "beta",
      client,
    });
    expect(report.allowed).toBe(false);
    expect(report.currentStage).toBe("missing");
    expect(report.issues).toEqual([
      { code: "COURSE_VERSION_MISSING", message: "The publication candidate does not exist." },
    ]);
    expect(report.reportHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("flags an invalid stage transition for beta targets", async () => {
    const client = makeClient([
      [{ id: "v1", stage: "beta", content_hash: hashCurriculumValue([]) }],
      [],
      [],
      [],
      [],
      [],
    ]);
    const report = await evaluateCurriculumPublicationGate({
      courseVersionId: "v1",
      targetStage: "beta",
      client,
    });
    expect(report.issues.some((issue) => issue.code === "INVALID_STAGE_TRANSITION")).toBe(true);
  });

  it("flags an invalid stage transition for verified targets", async () => {
    const client = makeClient([
      [{ id: "v1", stage: "draft", content_hash: hashCurriculumValue([]) }],
      [],
      [],
      [],
      [],
      [],
    ]);
    const report = await evaluateCurriculumPublicationGate({
      courseVersionId: "v1",
      targetStage: "verified",
      client,
    });
    expect(report.issues.some((issue) => issue.code === "INVALID_STAGE_TRANSITION")).toBe(true);
  });

  it("flags artifact hash mismatches and unapproved stages", async () => {
    const artifact = {
      id: "a1",
      artifact_key: "k1",
      artifact_type: "authored_lesson",
      skill_key: "dsa.arrays",
      content: { a: 1 },
      content_hash: "not-the-real-hash",
      publication_stage: "draft",
      review_status: "pending",
    };
    const client = makeClient([
      [{ id: "v1", stage: "draft", content_hash: hashCurriculumValue([]) }],
      [artifact],
      [],
      [],
      [],
      [],
    ]);
    const report = await evaluateCurriculumPublicationGate({
      courseVersionId: "v1",
      targetStage: "beta",
      client,
    });
    expect(report.issues.some((issue) => issue.code === "ARTIFACT_HASH_MISMATCH")).toBe(true);
    expect(report.issues.some((issue) => issue.code === "ARTIFACT_STAGE_UNAPPROVED")).toBe(true);
    expect(report.issues.some((issue) => issue.code === "CONTENT_HASH_MISMATCH")).toBe(true);
    expect(report.issues.some((issue) => issue.code === "MANIFEST_CARDINALITY")).toBe(true);
  });

  it("flags a manifest that fails schema validation", async () => {
    const badManifest = {
      id: "bad-manifest",
      artifact_key: "course-manifest",
      artifact_type: "course_manifest",
      skill_key: null,
      content: { not: "a valid manifest" },
      content_hash: hashCurriculumValue({ not: "a valid manifest" }),
      publication_stage: "approved",
      review_status: "approved",
    };
    const version = {
      id: "v1",
      stage: "draft",
      content_hash: hashCurriculumValue([
        { artifactKey: badManifest.artifact_key, artifactType: badManifest.artifact_type, contentHash: badManifest.content_hash },
      ]),
    };
    const client = makeClient([[version], [badManifest], [], [], [], []]);
    const report = await evaluateCurriculumPublicationGate({
      courseVersionId: "v1",
      targetStage: "beta",
      client,
    });
    expect(report.issues.some((issue) => issue.code === "MANIFEST_INVALID")).toBe(true);
  });

  it("flags a missing human review as HUMAN_REVIEW_MISSING", async () => {
    const manifest = manifestArtifact();
    const version = {
      id: "v1",
      stage: "draft",
      content_hash: hashCurriculumValue([
        { artifactKey: manifest.artifact_key, artifactType: manifest.artifact_type, contentHash: manifest.content_hash },
      ]),
    };
    const client = makeClient([[version], [manifest], [], [], [], []]);
    const report = await evaluateCurriculumPublicationGate({
      courseVersionId: "v1",
      targetStage: "beta",
      client,
    });
    expect(report.issues.some((issue) => issue.code === "HUMAN_REVIEW_MISSING")).toBe(true);
  });

  it("flags REVIEW_HASH_MISMATCH when the review is bound to a stale content hash", async () => {
    const manifest = manifestArtifact();
    const version = {
      id: "v1",
      stage: "draft",
      content_hash: hashCurriculumValue([
        { artifactKey: manifest.artifact_key, artifactType: manifest.artifact_type, contentHash: manifest.content_hash },
      ]),
    };
    const review = reviewFor(manifest, [manifest.artifact_key]);
    review.content_hash = "stale-hash";
    const client = makeClient([[version], [manifest], [review], [], [], []]);
    const report = await evaluateCurriculumPublicationGate({
      courseVersionId: "v1",
      targetStage: "beta",
      client,
    });
    expect(report.issues.some((issue) => issue.code === "REVIEW_HASH_MISMATCH")).toBe(true);
  });

  it("flags REVIEW_CHECKLIST_INCOMPLETE when a dimension did not pass", async () => {
    const manifest = manifestArtifact();
    const version = {
      id: "v1",
      stage: "draft",
      content_hash: hashCurriculumValue([
        { artifactKey: manifest.artifact_key, artifactType: manifest.artifact_type, contentHash: manifest.content_hash },
      ]),
    };
    const review = reviewFor(manifest, [manifest.artifact_key]);
    review.checklist = { ...validChecklist(), security: { ...validChecklist().security, passed: false } };
    const client = makeClient([[version], [manifest], [review], [], [], []]);
    const report = await evaluateCurriculumPublicationGate({
      courseVersionId: "v1",
      targetStage: "beta",
      client,
    });
    expect(report.issues.some((issue) => issue.code === "REVIEW_CHECKLIST_INCOMPLETE")).toBe(true);
  });

  it("flags ITEM_REVIEW_INCOMPLETE when reviewed item ids do not match", async () => {
    const manifest = manifestArtifact();
    const version = {
      id: "v1",
      stage: "draft",
      content_hash: hashCurriculumValue([
        { artifactKey: manifest.artifact_key, artifactType: manifest.artifact_type, contentHash: manifest.content_hash },
      ]),
    };
    const review = reviewFor(manifest, ["wrong-item-id"]);
    const client = makeClient([[version], [manifest], [review], [], [], []]);
    const report = await evaluateCurriculumPublicationGate({
      courseVersionId: "v1",
      targetStage: "beta",
      client,
    });
    expect(report.issues.some((issue) => issue.code === "ITEM_REVIEW_INCOMPLETE")).toBe(true);
  });

  it("flags AUTHORED_PUBLICATION_UNREVIEWED when the authored file lacks reviewed metadata", async () => {
    const lesson = lessonArtifact();
    lesson.content = { publication: { stage: "draft", reviewer: null } };
    lesson.content_hash = hashCurriculumValue(lesson.content);
    const version = {
      id: "v1",
      stage: "draft",
      content_hash: hashCurriculumValue([
        { artifactKey: lesson.artifact_key, artifactType: lesson.artifact_type, contentHash: lesson.content_hash },
      ]),
    };
    const review = reviewFor(lesson, [lesson.artifact_key]);
    const client = makeClient([[version], [lesson], [review], [], [], []]);
    const report = await evaluateCurriculumPublicationGate({
      courseVersionId: "v1",
      targetStage: "beta",
      client,
    });
    expect(report.issues.some((issue) => issue.code === "AUTHORED_PUBLICATION_UNREVIEWED")).toBe(true);
  });

  it("flags ITEM_EXAM_INELIGIBLE for exam-ineligible bank items", async () => {
    const bank = bankArtifact();
    bank.content = {
      publication: { stage: "approved", reviewer: { kind: "human" } },
      items: [{ id: "item1", kind: "code", examEligibility: { eligible: false } }],
    };
    bank.content_hash = hashCurriculumValue(bank.content);
    const version = {
      id: "v1",
      stage: "draft",
      content_hash: hashCurriculumValue([
        { artifactKey: bank.artifact_key, artifactType: bank.artifact_type, contentHash: bank.content_hash },
      ]),
    };
    const review = reviewFor(bank, ["item1"]);
    const client = makeClient([[version], [bank], [review], [], [], []]);
    const report = await evaluateCurriculumPublicationGate({
      courseVersionId: "v1",
      targetStage: "beta",
      client,
    });
    expect(report.issues.some((issue) => issue.code === "ITEM_EXAM_INELIGIBLE")).toBe(true);
  });

  it("flags RELEASE_EVIDENCE_MISSING when no release row exists", async () => {
    const { client } = fullHappyPathClient();
    // Drop the release row queued last by re-queuing everything except it.
    const emptyReleaseClient = makeClient([]);
    void emptyReleaseClient;
    const manifest = manifestArtifact();
    const version = {
      id: "v1",
      stage: "draft",
      content_hash: hashCurriculumValue([
        { artifactKey: manifest.artifact_key, artifactType: manifest.artifact_type, contentHash: manifest.content_hash },
      ]),
    };
    const review = reviewFor(manifest, [manifest.artifact_key]);
    const noReleaseClient = makeClient([[version], [manifest], [review], [], [], []]);
    void client;
    const report = await evaluateCurriculumPublicationGate({
      courseVersionId: "v1",
      targetStage: "beta",
      client: noReleaseClient,
    });
    expect(report.issues.some((issue) => issue.code === "RELEASE_EVIDENCE_MISSING")).toBe(true);
  });

  it("allows publication with zero issues on a fully compliant fixture", async () => {
    const { client, version } = fullHappyPathClient();
    const report = await evaluateCurriculumPublicationGate({
      courseVersionId: version.id,
      targetStage: "beta",
      client,
    });
    expect(report.issues).toEqual([]);
    expect(report.allowed).toBe(true);
    expect(report.summary).toEqual({
      promisedSkills: 1,
      artifacts: 3,
      approvedArtifacts: 3,
      codeItems: 1,
      runtimeLessons: 1,
      releaseEvidenceVersion: 1,
    });
  });

  it("flags RUNTIME_LESSON_MISSING when no runtime lesson row matches a promised skill", async () => {
    const { client } = fullHappyPathClient();
    void client;
    const manifest = manifestArtifact();
    const lesson = lessonArtifact();
    const bank = bankArtifact();
    const artifacts = [manifest, lesson, bank];
    const version = {
      id: "v1",
      stage: "draft",
      content_hash: hashCurriculumValue(
        artifacts.map(({ artifact_key, artifact_type, content_hash }) => ({
          artifactKey: artifact_key,
          artifactType: artifact_type,
          contentHash: content_hash,
        })).sort((a, b) => (a.artifactKey < b.artifactKey ? -1 : a.artifactKey > b.artifactKey ? 1 : 0)),
      ),
    };
    const reviews = [
      reviewFor(manifest, [manifest.artifact_key]),
      reviewFor(lesson, [lesson.artifact_key]),
      reviewFor(bank, ["item1"]),
    ];
    const noRuntimeLessonClient = makeClient([[version], artifacts, reviews, [], [], []]);
    const report = await evaluateCurriculumPublicationGate({
      courseVersionId: "v1",
      targetStage: "beta",
      client: noRuntimeLessonClient,
    });
    expect(report.issues.some((issue) => issue.code === "RUNTIME_LESSON_MISSING")).toBe(true);
  });
});

describe("unreviewedCurriculumWaived", () => {
  it("is false outside development", () => {
    expect(unreviewedCurriculumWaived({ NODE_ENV: "test", ALLOW_UNREVIEWED_CURRICULUM: "true" })).toBe(false);
  });

  it("is false when the flag is unset even in development", () => {
    expect(unreviewedCurriculumWaived({ NODE_ENV: "development" })).toBe(false);
  });

  it("is true only in development with the explicit flag", () => {
    expect(
      unreviewedCurriculumWaived({ NODE_ENV: "development", ALLOW_UNREVIEWED_CURRICULUM: "true" }),
    ).toBe(true);
  });
});
