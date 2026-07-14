export const COURSE_STATUSES = [
  "coming-soon",
  "beta",
  "verified",
  "retired",
] as const;

export type CourseStatus = (typeof COURSE_STATUSES)[number];

export const CATALOG_MANIFEST_KINDS = ["course", "roadmap"] as const;
export type CatalogManifestKind = (typeof CATALOG_MANIFEST_KINDS)[number];

export const TRACK_ENROLLMENT_POLICIES = [
  "prerequisite-gated",
  "blocked-until-published",
] as const;
export type TrackEnrollmentPolicy = (typeof TRACK_ENROLLMENT_POLICIES)[number];

export const TRACK_ADMIN_OVERRIDE_POLICIES = ["prerequisites-only", "disabled"] as const;
export type TrackAdminOverridePolicy = (typeof TRACK_ADMIN_OVERRIDE_POLICIES)[number];

export const SKILL_STATUSES = ["required", "elective"] as const;
export type SkillStatus = (typeof SKILL_STATUSES)[number];

export const COVERAGE_STATUSES = ["covered", "partial", "planned"] as const;
export type CoverageStatus = (typeof COVERAGE_STATUSES)[number];

export const EVIDENCE_TYPES = [
  "concept-check",
  "trace",
  "code",
  "debug",
  "test",
  "explain",
  "transfer",
  "project",
  "visual",
  "design",
  "artifact",
  "performance",
  "review",
] as const;

export type ContentEvidenceType = (typeof EVIDENCE_TYPES)[number];

export const RUNTIME_KINDS = [
  "conceptual",
  "programming-language",
  "markup",
  "styling",
  "library",
  "tooling",
  "multi-language",
] as const;

export type RuntimeKind = (typeof RUNTIME_KINDS)[number];

export interface CatalogTrack {
  readonly id: string;
  readonly title: string;
  readonly category: string;
  readonly manifest: string;
  readonly manifest_kind: CatalogManifestKind;
  readonly status: CourseStatus;
  readonly release: string;
  readonly prerequisites: readonly string[];
  readonly gating: {
    readonly visibility: "listed";
    readonly enrollment: TrackEnrollmentPolicy;
    readonly admin_override: TrackAdminOverridePolicy;
  };
  readonly summary: string;
}

export interface RoadmapTrackManifest {
  readonly $schema: string;
  readonly format: "roadmap-track";
  readonly schema_version: "1.0.0";
  readonly id: string;
  readonly title: string;
  readonly status: "coming-soon";
  readonly release: string;
  readonly prerequisites: readonly string[];
  readonly scope_brief: string;
  readonly planned_scope: readonly string[];
  readonly non_goals: readonly string[];
  readonly approval: {
    readonly state: "approved-for-roadmap-only";
    readonly required_role: "admin";
    readonly decision_ref: string;
  };
  readonly publication: {
    readonly learner_content_available: false;
    readonly authored_lessons: 0;
    readonly assessment_banks: 0;
    readonly exam_eligible_items: 0;
    readonly requires_separate_verified_release: true;
  };
}

export interface RecommendedPath {
  readonly id: string;
  readonly tracks: readonly string[];
}

export interface CatalogGovernance {
  readonly live_ai_course_generation: boolean;
  readonly publication_flow: readonly string[];
  readonly missing_promised_topic: string;
  readonly new_extension: string;
}

export interface ContentCatalog {
  readonly version: string;
  readonly release: string;
  readonly status: CourseStatus;
  readonly description: string;
  readonly status_policy: Readonly<Record<CourseStatus, string>>;
  readonly tracks: readonly CatalogTrack[];
  readonly recommended_paths: readonly RecommendedPath[];
  readonly governance: CatalogGovernance;
}

export interface CourseAudience {
  readonly level: string;
  readonly assumed_knowledge: readonly string[];
  readonly target_capability: string;
}

export interface CourseScope {
  readonly includes: readonly string[];
  readonly non_goals: readonly string[];
}

export type SourceType =
  | "standard"
  | "specification"
  | "official-docs"
  | "curriculum"
  | "security-guidance"
  | "accessibility-standard"
  | "research";

export interface ContentSource {
  readonly id: string;
  readonly title: string;
  readonly url: string;
  readonly type: SourceType;
  readonly version_or_date: string;
}

export interface CourseRuntime {
  readonly kind: RuntimeKind;
  readonly language: string;
  readonly standard: string;
  readonly toolchain: readonly string[];
  readonly execution_environment: string;
  readonly file_extensions: readonly string[];
  readonly notes: readonly string[];
}

export interface AtomicSkill {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly outcomes: readonly string[];
  readonly prerequisites: readonly string[];
  readonly evidence_types: readonly ContentEvidenceType[];
  readonly status: SkillStatus;
  readonly coverage_status: CoverageStatus;
  readonly source_refs: readonly string[];
}

export interface CourseModule {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly required: boolean;
  readonly prerequisites: readonly string[];
  readonly skills: readonly AtomicSkill[];
}

export interface CoverageSummary {
  readonly required_skills: number;
  readonly elective_skills: number;
  readonly total_skills: number;
  readonly covered: number;
  readonly partial: number;
  readonly planned: number;
}

export interface CourseManifest {
  readonly $schema: string;
  readonly id: string;
  readonly title: string;
  readonly version: string;
  readonly status: CourseStatus;
  readonly release: string;
  readonly summary: string;
  readonly audience: CourseAudience;
  readonly scope: CourseScope;
  readonly authoritative_sources: readonly ContentSource[];
  readonly runtime: CourseRuntime;
  readonly modules: readonly CourseModule[];
  readonly exit_outcomes: readonly string[];
  readonly coverage_summary: CoverageSummary;
}

export interface ContentSnapshot {
  readonly contentRoot: string;
  readonly catalog: ContentCatalog;
  readonly courses: readonly CourseManifest[];
  readonly manifestPaths: Readonly<Record<string, string>>;
  readonly roadmapTracks: readonly RoadmapTrackManifest[];
  readonly roadmapManifestPaths: Readonly<Record<string, string>>;
  readonly loadedAtMs: number;
}

export interface SkillLocation {
  readonly course: CourseManifest;
  readonly module: CourseModule;
  readonly skill: AtomicSkill;
}

export interface ContentIndex {
  readonly courseById: ReadonlyMap<string, CourseManifest>;
  readonly moduleById: ReadonlyMap<string, CourseModule>;
  readonly skillById: ReadonlyMap<string, AtomicSkill>;
  readonly moduleCourseById: ReadonlyMap<string, CourseManifest>;
  readonly skillLocationById: ReadonlyMap<string, SkillLocation>;
  readonly requiredSkillIdsByModule: ReadonlyMap<string, readonly string[]>;
}

export type ContentSearchKind = "course" | "module" | "skill";

export interface ContentListOptions {
  readonly status?: CourseStatus | readonly CourseStatus[];
  readonly release?: string;
  readonly category?: string;
}

export interface ContentSearchOptions {
  readonly kinds?: readonly ContentSearchKind[];
  readonly courseIds?: readonly string[];
  readonly status?: CourseStatus | readonly CourseStatus[];
  readonly limit?: number;
}

export interface ContentSearchResult {
  readonly kind: ContentSearchKind;
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly courseId: string;
  readonly moduleId?: string;
  readonly score: number;
  readonly matchedFields: readonly string[];
}

export interface TrackPrerequisiteGroup {
  readonly expression: string;
  readonly alternatives: readonly string[];
  readonly satisfiedBy?: string;
}

export interface TrackEligibility {
  readonly trackId: string;
  readonly eligible: boolean;
  readonly groups: readonly TrackPrerequisiteGroup[];
  readonly missingGroups: readonly TrackPrerequisiteGroup[];
}

export type TrackAccessKind =
  | "available"
  | "locked-prerequisites"
  | "coming-soon"
  | "retired";

export interface TrackAccessState extends TrackEligibility {
  readonly visible: boolean;
  readonly access: TrackAccessKind;
  readonly canEnroll: boolean;
  readonly adminOverrideApplied: boolean;
  readonly reason: string;
}

export interface NodeEligibility {
  readonly nodeId: string;
  readonly eligible: boolean;
  readonly directPrerequisites: readonly string[];
  readonly satisfiedPrerequisites: readonly string[];
  readonly missingPrerequisites: readonly string[];
  readonly expandedMissingSkillIds: readonly string[];
}

export const CONTENT_PROGRESS_STAGES = [
  "UNSEEN",
  "DIAGNOSTIC",
  "LEARNING",
  "GUIDED_PRACTICE",
  "INDEPENDENT_PRACTICE",
  "EXAM_READY",
  "PASSED",
  "MASTERED",
  "REVIEW_DUE",
  "REMEDIATION",
] as const;

export type ContentProgressStage = (typeof CONTENT_PROGRESS_STAGES)[number];

export interface SkillProgressInput {
  readonly skillId: string;
  readonly stage: ContentProgressStage;
  readonly masteryProbability?: number;
}

export interface ProgressCounts {
  readonly total: number;
  readonly required: number;
  readonly elective: number;
  readonly started: number;
  readonly completed: number;
  readonly mastered: number;
  readonly reviewDue: number;
  readonly requiredCompleted: number;
  readonly requiredMastered: number;
  readonly completionPercent: number;
  readonly masteryPercent: number;
  readonly stageCounts: Readonly<Record<ContentProgressStage, number>>;
}

export interface ModuleProgressSummary extends ProgressCounts {
  readonly moduleId: string;
}

export interface CourseProgressSummary extends ProgressCounts {
  readonly courseId: string;
  readonly modules: readonly ModuleProgressSummary[];
  readonly complete: boolean;
}

export interface CatalogProgressSummary extends ProgressCounts {
  readonly courses: readonly CourseProgressSummary[];
  readonly completedTrackIds: readonly string[];
  readonly unknownSkillIds: readonly string[];
}

export interface LessonBlueprintSourceLink {
  readonly id: string;
  readonly title: string;
  readonly url: string;
  readonly versionOrDate: string;
}

export interface WorkedExampleSpecification {
  readonly runtimeLabel: string;
  readonly artifactType: string;
  readonly goal: string;
  readonly startingState: string;
  readonly requiredSteps: readonly string[];
  readonly validationRequirements: readonly string[];
  readonly expectedEvidence: readonly string[];
  readonly executableContent: null;
  readonly authoredExampleRequired: true;
}

export type ActivityMode = "trace" | "check" | "code" | "transfer";
export type ActivityApplicability = "required" | "recommended" | "author-review";

interface LessonBlueprintBlockBase {
  readonly id: string;
  readonly title: string;
  readonly authoringStatus: "blueprint-draft";
}

export interface ObjectiveBlock extends LessonBlueprintBlockBase {
  readonly kind: "objective";
  readonly outcomes: readonly string[];
  readonly evidenceTypes: readonly ContentEvidenceType[];
}

export interface MentalModelBlock extends LessonBlueprintBlockBase {
  readonly kind: "mental-model";
  readonly plainLanguageSeed: string;
  readonly canonicalTerms: readonly string[];
  readonly authorPrompt: string;
}

export interface ExplanationSeedBlock extends LessonBlueprintBlockBase {
  readonly kind: "source-linked-explanation-seed";
  readonly seed: string;
  readonly sources: readonly LessonBlueprintSourceLink[];
  readonly quotationAllowed: false;
}

export interface WorkedExampleBlock extends LessonBlueprintBlockBase {
  readonly kind: "worked-example-specification";
  readonly specification: WorkedExampleSpecification;
}

export interface MisconceptionPromptsBlock extends LessonBlueprintBlockBase {
  readonly kind: "misconception-prompts";
  readonly prompts: readonly string[];
  readonly confirmedMisconceptions: readonly string[];
  readonly authorConfirmationRequired: true;
}

export interface ActivitySpecificationBlock extends LessonBlueprintBlockBase {
  readonly kind:
    | "activity-trace"
    | "activity-check"
    | "activity-code"
    | "activity-transfer";
  readonly mode: ActivityMode;
  readonly applicability: ActivityApplicability;
  readonly promptSeed: string;
  readonly acceptanceSignals: readonly string[];
  readonly neutralContextRequired: boolean;
}

export interface AnalogySlotBlock extends LessonBlueprintBlockBase {
  readonly kind: "analogy-slot";
  readonly enabledByDefault: false;
  readonly approvedAnalogyIds: readonly string[];
  readonly userConfirmationRequired: true;
  readonly canonicalLessonMustStandAlone: true;
  readonly limitationsRequired: true;
}

export interface RecapBlock extends LessonBlueprintBlockBase {
  readonly kind: "recap";
  readonly prompts: readonly string[];
  readonly delayedReviewRequired: true;
}

export interface AccessibilityTextBlock extends LessonBlueprintBlockBase {
  readonly kind: "accessibility-text";
  readonly textAlternativeSeed: string;
  readonly requirements: readonly string[];
}

export type LessonBlueprintBlock =
  | ObjectiveBlock
  | MentalModelBlock
  | ExplanationSeedBlock
  | WorkedExampleBlock
  | MisconceptionPromptsBlock
  | ActivitySpecificationBlock
  | AnalogySlotBlock
  | RecapBlock
  | AccessibilityTextBlock;

export const REQUIRED_LESSON_BLUEPRINT_BLOCK_KINDS = [
  "objective",
  "mental-model",
  "source-linked-explanation-seed",
  "worked-example-specification",
  "misconception-prompts",
  "activity-trace",
  "activity-check",
  "activity-code",
  "activity-transfer",
  "analogy-slot",
  "recap",
  "accessibility-text",
] as const;

export type RequiredLessonBlueprintBlockKind =
  (typeof REQUIRED_LESSON_BLUEPRINT_BLOCK_KINDS)[number];

export interface AuthoredFallbackLessonBlueprint {
  readonly id: string;
  readonly courseId: string;
  readonly courseVersion: string;
  readonly moduleId: string;
  readonly skillId: string;
  readonly title: string;
  readonly runtime: CourseRuntime;
  readonly provenance: {
    readonly compiler: "deterministic-authored-fallback-v1";
    readonly contentStatus: "blueprint-draft";
    readonly canonicalContent: false;
    readonly editorialReviewRequired: true;
    readonly notice: string;
  };
  readonly blocks: readonly LessonBlueprintBlock[];
}
