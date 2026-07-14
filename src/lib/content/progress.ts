import type {
  AtomicSkill,
  CatalogProgressSummary,
  ContentIndex,
  ContentProgressStage,
  ContentSnapshot,
  CourseManifest,
  CourseModule,
  CourseProgressSummary,
  ModuleProgressSummary,
  ProgressCounts,
  SkillProgressInput,
} from "./types";
import { CONTENT_PROGRESS_STAGES } from "./types";

export type ProgressInputCollection =
  | readonly SkillProgressInput[]
  | ReadonlyMap<string, SkillProgressInput>
  | Readonly<Record<string, SkillProgressInput>>;

const COMPLETION_STAGES = new Set<ContentProgressStage>([
  "PASSED",
  "MASTERED",
  "REVIEW_DUE",
]);
const MASTERY_STAGES = new Set<ContentProgressStage>(["MASTERED", "REVIEW_DUE"]);

function emptyStageCounts(): Record<ContentProgressStage, number> {
  return Object.fromEntries(
    CONTENT_PROGRESS_STAGES.map((stage) => [stage, 0]),
  ) as Record<ContentProgressStage, number>;
}

function percentage(numerator: number, denominator: number): number {
  if (!denominator) return 100;
  return Math.round((numerator / denominator) * 10_000) / 100;
}

export function toProgressMap(
  progress: ProgressInputCollection,
): ReadonlyMap<string, SkillProgressInput> {
  if (progress instanceof Map) return progress;
  const result = new Map<string, SkillProgressInput>();
  if (Array.isArray(progress)) {
    for (const entry of progress) result.set(entry.skillId, entry);
    return result;
  }
  for (const entry of Object.values(progress)) result.set(entry.skillId, entry);
  return result;
}

export function isCompletionStage(stage: ContentProgressStage): boolean {
  return COMPLETION_STAGES.has(stage);
}

export function isMasteryStage(stage: ContentProgressStage): boolean {
  return MASTERY_STAGES.has(stage);
}

export function achievedSkillIdsFromProgress(
  progress: ProgressInputCollection,
): ReadonlySet<string> {
  const achieved = new Set<string>();
  for (const entry of toProgressMap(progress).values()) {
    if (isCompletionStage(entry.stage)) achieved.add(entry.skillId);
  }
  return achieved;
}

function aggregateSkills(
  skills: readonly AtomicSkill[],
  progress: ReadonlyMap<string, SkillProgressInput>,
): ProgressCounts {
  const stageCounts = emptyStageCounts();
  let started = 0;
  let completed = 0;
  let mastered = 0;
  let reviewDue = 0;
  let requiredCompleted = 0;
  let requiredMastered = 0;

  for (const skill of skills) {
    const stage = progress.get(skill.id)?.stage ?? "UNSEEN";
    stageCounts[stage] += 1;
    if (stage !== "UNSEEN") started += 1;
    if (isCompletionStage(stage)) {
      completed += 1;
      if (skill.status === "required") requiredCompleted += 1;
    }
    if (isMasteryStage(stage)) {
      mastered += 1;
      if (skill.status === "required") requiredMastered += 1;
    }
    if (stage === "REVIEW_DUE") reviewDue += 1;
  }

  const required = skills.filter((skill) => skill.status === "required").length;
  const elective = skills.length - required;
  return {
    total: skills.length,
    required,
    elective,
    started,
    completed,
    mastered,
    reviewDue,
    requiredCompleted,
    requiredMastered,
    completionPercent: percentage(requiredCompleted, required),
    masteryPercent: percentage(requiredMastered, required),
    stageCounts,
  };
}

export function aggregateModuleProgress(
  module: CourseModule,
  progressInput: ProgressInputCollection,
): ModuleProgressSummary {
  return {
    moduleId: module.id,
    ...aggregateSkills(module.skills, toProgressMap(progressInput)),
  };
}

export function aggregateCourseProgress(
  course: CourseManifest,
  progressInput: ProgressInputCollection,
): CourseProgressSummary {
  const progress = toProgressMap(progressInput);
  const skills = course.modules.flatMap((module) => module.skills);
  const counts = aggregateSkills(skills, progress);
  return {
    courseId: course.id,
    ...counts,
    modules: course.modules.map((module) => ({
      moduleId: module.id,
      ...aggregateSkills(module.skills, progress),
    })),
    complete: counts.requiredCompleted === counts.required,
  };
}

export function deriveCompletedTrackIds(
  snapshot: ContentSnapshot,
  progressInput: ProgressInputCollection,
): readonly string[] {
  const progress = toProgressMap(progressInput);
  return snapshot.courses
    .filter((course) => aggregateCourseProgress(course, progress).complete)
    .map((course) => course.id);
}

export function aggregateCatalogProgress(
  snapshot: ContentSnapshot,
  index: ContentIndex,
  progressInput: ProgressInputCollection,
): CatalogProgressSummary {
  const progress = toProgressMap(progressInput);
  const allSkills = snapshot.courses.flatMap((course) =>
    course.modules.flatMap((module) => module.skills),
  );
  const counts = aggregateSkills(allSkills, progress);
  const courses = snapshot.courses.map((course) => aggregateCourseProgress(course, progress));
  const unknownSkillIds = [...progress.keys()]
    .filter((skillId) => !index.skillById.has(skillId))
    .sort();
  return {
    ...counts,
    courses,
    completedTrackIds: courses
      .filter((course) => course.complete)
      .map((course) => course.courseId),
    unknownSkillIds,
  };
}
