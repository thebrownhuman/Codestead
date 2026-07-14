import type {
  AssessmentBank,
  AuthoredContentSet,
  AuthoredLesson,
  CodeAssessmentItem,
  ContentReviewer,
  DeterministicAssessmentItem,
  LearnerAssessmentBank,
  LearnerAssessmentItem,
} from "./authored-types";
import type { ContentIndex } from "./types";

export type AuthoredContentIssueCode =
  | "duplicate-authored-id"
  | "duplicate-lesson-skill"
  | "duplicate-bank-skill"
  | "unknown-authored-skill"
  | "authored-course-mismatch"
  | "authored-course-version-mismatch"
  | "authored-module-mismatch"
  | "unknown-authored-source";

export interface AuthoredContentIssue {
  readonly code: AuthoredContentIssueCode;
  readonly entryId: string;
  readonly message: string;
}

export class AuthoredContentIntegrityError extends Error {
  constructor(readonly issues: readonly AuthoredContentIssue[]) {
    super(`Authored content integrity failed: ${issues.map((issue) => issue.message).join("; ")}`);
    this.name = "AuthoredContentIntegrityError";
  }
}

function validateEntryMapping(
  entry: AuthoredLesson | AssessmentBank,
  index: ContentIndex,
  issues: AuthoredContentIssue[],
): void {
  const location = index.skillLocationById.get(entry.skillId);
  if (!location) {
    issues.push({
      code: "unknown-authored-skill",
      entryId: entry.id,
      message: `${entry.id} maps to unknown skill '${entry.skillId}'.`,
    });
    return;
  }
  if (location.course.id !== entry.courseId) {
    issues.push({
      code: "authored-course-mismatch",
      entryId: entry.id,
      message: `${entry.id} declares course '${entry.courseId}', expected '${location.course.id}'.`,
    });
  }
  if (location.course.version !== entry.courseVersion) {
    issues.push({
      code: "authored-course-version-mismatch",
      entryId: entry.id,
      message: `${entry.id} targets course version '${entry.courseVersion}', expected '${location.course.version}'.`,
    });
  }
  if (location.module.id !== entry.moduleId) {
    issues.push({
      code: "authored-module-mismatch",
      entryId: entry.id,
      message: `${entry.id} declares module '${entry.moduleId}', expected '${location.module.id}'.`,
    });
  }
  const sourceIds = new Set(location.course.authoritative_sources.map((source) => source.id));
  const sourceRefs = entry.format === "authored-lesson"
    ? entry.sources.map((source) => source.sourceRef)
    : entry.sourceRefs;
  for (const sourceRef of sourceRefs) {
    if (!sourceIds.has(sourceRef)) {
      issues.push({
        code: "unknown-authored-source",
        entryId: entry.id,
        message: `${entry.id} references source '${sourceRef}' outside course '${entry.courseId}'.`,
      });
    }
  }
}

/**
 * Validates authored artifacts against the authoritative manifest index. This
 * is intentionally fail-closed: one bad mapping rejects the entire authored
 * set instead of silently dropping or reassigning content.
 */
export function validateAuthoredContentSet(
  content: AuthoredContentSet,
  index: ContentIndex,
): AuthoredContentSet {
  const issues: AuthoredContentIssue[] = [];
  const ids = new Set<string>();
  const lessonSkills = new Set<string>();
  const bankSkills = new Set<string>();
  for (const entry of [...content.lessons, ...content.assessmentBanks]) {
    if (ids.has(entry.id)) {
      issues.push({
        code: "duplicate-authored-id",
        entryId: entry.id,
        message: `Duplicate authored entry id '${entry.id}'.`,
      });
    }
    ids.add(entry.id);
    validateEntryMapping(entry, index, issues);
  }
  for (const lesson of content.lessons) {
    if (lessonSkills.has(lesson.skillId)) {
      issues.push({
        code: "duplicate-lesson-skill",
        entryId: lesson.id,
        message: `More than one authored lesson maps to '${lesson.skillId}'.`,
      });
    }
    lessonSkills.add(lesson.skillId);
  }
  for (const bank of content.assessmentBanks) {
    if (bankSkills.has(bank.skillId)) {
      issues.push({
        code: "duplicate-bank-skill",
        entryId: bank.id,
        message: `More than one assessment bank maps to '${bank.skillId}'.`,
      });
    }
    bankSkills.add(bank.skillId);
  }
  if (issues.length > 0) throw new AuthoredContentIntegrityError(issues);
  return Object.freeze({
    lessons: Object.freeze([...content.lessons]),
    assessmentBanks: Object.freeze([...content.assessmentBanks]),
  });
}

export function hasHumanReview(
  publication: { readonly reviewer: ContentReviewer | null; readonly stage: string },
): publication is { readonly reviewer: ContentReviewer; readonly stage: "approved" | "published" | "retired" } {
  return publication.reviewer?.kind === "human" &&
    (publication.stage === "approved" || publication.stage === "published" || publication.stage === "retired");
}

export function isExamEligibleItem(
  bank: AssessmentBank,
  item: DeterministicAssessmentItem,
): boolean {
  return item.examEligibility.eligible &&
    (bank.publication.stage === "approved" || bank.publication.stage === "published") &&
    hasHumanReview(bank.publication);
}

export interface LearnerPayloadOptions {
  /** Explicit editorial preview; defaults to published content only. */
  readonly allowUnpublishedPreview?: boolean;
}

function assertLearnerVisible(stage: string, options: LearnerPayloadOptions): void {
  if (stage !== "published" && !options.allowUnpublishedPreview) {
    throw new RangeError("Unpublished authored content is not learner-visible without explicit preview mode.");
  }
}

export function toLearnerLessonPayload(
  lesson: AuthoredLesson,
  options: LearnerPayloadOptions = {},
): AuthoredLesson {
  assertLearnerVisible(lesson.publication.stage, options);
  return lesson;
}

function toLearnerAssessmentItem(item: DeterministicAssessmentItem): LearnerAssessmentItem {
  const {
    answer: _answer,
    rubric: _rubric,
    feedback: _feedback,
    privateAuthorNotes: _notes,
    misconceptionMappings: _misconceptions,
    ...safe
  } = item;
  void _answer;
  void _rubric;
  void _feedback;
  void _notes;
  void _misconceptions;
  if (item.kind !== "code") return safe as LearnerAssessmentItem;
  const tests = (safe as Omit<CodeAssessmentItem, "answer" | "rubric" | "feedback" | "privateAuthorNotes" | "misconceptionMappings">)
    .tests.filter((test) => test.visibility === "visible");
  return { ...safe, tests } as LearnerAssessmentItem;
}

/** Never returns answer keys, misconception mappings, rubrics, private notes, feedback, or hidden tests. */
export function toLearnerAssessmentBank(
  bank: AssessmentBank,
  options: LearnerPayloadOptions = {},
): LearnerAssessmentBank {
  assertLearnerVisible(bank.publication.stage, options);
  return {
    id: bank.id,
    schemaVersion: bank.schemaVersion,
    courseId: bank.courseId,
    moduleId: bank.moduleId,
    skillId: bank.skillId,
    title: bank.title,
    provenance: {
      stage: bank.publication.stage,
      aiAssisted: bank.publication.aiAssisted,
      reviewRequired: !hasHumanReview(bank.publication),
    },
    items: bank.items.map(toLearnerAssessmentItem),
  };
}
