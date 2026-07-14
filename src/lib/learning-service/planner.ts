import {
  parseTrackPrerequisiteExpression,
  type AtomicSkill,
  type ContentGraph,
  type ContentIndex,
  type ContentSnapshot,
  type DsaParityLanguage,
} from "@/lib/content";

import type {
  DsaLanguage,
  LearningPlanItem,
  PlanResolution,
  TrackPlanDraft,
} from "./types";
import { LEARNING_PLAN_SCHEMA_VERSION } from "./types";

export const DSA_LANGUAGES: readonly DsaLanguage[] = ["C", "C++", "Java", "Python"];

const DSA_LANGUAGE_TRACK: Readonly<Record<DsaLanguage, DsaParityLanguage>> = {
  C: "c",
  "C++": "cpp",
  Java: "java",
  Python: "python",
};

const LANGUAGE_SPECIFIC_EVIDENCE = new Set([
  "code",
  "debug",
  "test",
  "artifact",
  "performance",
  "project",
]);

export function normalizeDsaLanguage(value: string | null | undefined): DsaLanguage | null {
  if (!value) return null;
  const normalized = value.trim().toLocaleLowerCase("en-US");
  if (normalized === "c") return "C";
  if (normalized === "c++" || normalized === "cpp") return "C++";
  if (normalized === "java") return "Java";
  if (normalized === "python" || normalized === "py") return "Python";
  return null;
}

export function dsaRunnerLanguage(language: DsaLanguage): DsaParityLanguage {
  return DSA_LANGUAGE_TRACK[language];
}

export function isLanguageSpecificDsaSkill(skill: AtomicSkill): boolean {
  return skill.evidence_types.some((type) => LANGUAGE_SPECIFIC_EVIDENCE.has(type));
}

export function languageContextForSkill(
  trackId: string,
  _skill: AtomicSkill,
  dsaLanguage: DsaLanguage | null,
): string {
  if (trackId !== "dsa") return "conceptual";
  return dsaLanguage ? `dsa:${dsaLanguage.toLocaleLowerCase("en-US")}` : "dsa:unselected";
}

function assertSelectedTracks(snapshot: ContentSnapshot, selectedTrackIds: readonly string[]): void {
  const tracks = new Map(snapshot.catalog.tracks.map((track) => [track.id, track]));
  const seen = new Set<string>();
  for (const trackId of selectedTrackIds) {
    const track = tracks.get(trackId);
    if (!track) throw new RangeError(`Unknown selected track '${trackId}'.`);
    if (
      track.manifest_kind !== "course" ||
      !["beta", "verified"].includes(track.status) ||
      track.gating.enrollment !== "prerequisite-gated"
    ) {
      throw new RangeError(`Track '${trackId}' is visible in the roadmap but is not published for enrollment.`);
    }
    if (seen.has(trackId)) throw new Error(`Duplicate selected track '${trackId}'.`);
    seen.add(trackId);
  }
}

function resolveTrackOrder(
  snapshot: ContentSnapshot,
  selectedTrackIds: readonly string[],
  dsaLanguage: DsaLanguage | null,
): { readonly trackIds: readonly string[]; readonly warnings: readonly string[] } {
  const tracks = new Map(snapshot.catalog.tracks.map((track) => [track.id, track]));
  const selected = new Set(selectedTrackIds);
  const resolved: string[] = [];
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const warnings: string[] = [];

  const visit = (trackId: string): void => {
    if (visited.has(trackId)) return;
    if (visiting.has(trackId)) throw new Error(`Track prerequisite cycle at '${trackId}'.`);
    const track = tracks.get(trackId);
    if (!track) throw new RangeError(`Unknown prerequisite track '${trackId}'.`);
    visiting.add(trackId);
    for (const expression of track.prerequisites) {
      const alternatives = parseTrackPrerequisiteExpression(expression);
      const selectedAlternative = alternatives.find((candidate) => selected.has(candidate));
      const languageAlternative =
        trackId === "dsa" && dsaLanguage
          ? alternatives.find((candidate) => candidate === DSA_LANGUAGE_TRACK[dsaLanguage])
          : undefined;
      const candidate = selectedAlternative ?? languageAlternative ?? alternatives[0]!;
      if (!selectedAlternative && !languageAlternative && alternatives.length > 1) {
        warnings.push(
          `Prerequisite '${expression}' for '${trackId}' defaulted to '${candidate}'.`,
        );
      }
      visit(candidate);
    }
    visiting.delete(trackId);
    visited.add(trackId);
    resolved.push(trackId);
  };

  for (const trackId of selectedTrackIds) visit(trackId);
  return { trackIds: resolved, warnings };
}

function planItemsForCourse(
  snapshot: ContentSnapshot,
  index: ContentIndex,
  graph: ContentGraph,
  trackId: string,
  selectedTrackIds: ReadonlySet<string>,
  dsaLanguage: DsaLanguage | null,
): readonly LearningPlanItem[] {
  const course = index.courseById.get(trackId);
  if (!course) throw new RangeError(`Course manifest '${trackId}' was not indexed.`);
  const items: LearningPlanItem[] = [];
  let position = 0;
  for (const courseSection of course.modules) {
    for (const skill of courseSection.skills) {
      const common = {
        schemaVersion: LEARNING_PLAN_SCHEMA_VERSION,
        trackId,
        courseVersion: course.version,
        moduleId: courseSection.id,
        skillId: skill.id,
        title: skill.title,
        required: skill.status === "required",
        prerequisites: graph.getTransitivePrerequisiteSkillIds(skill.id),
        evidenceTypes: skill.evidence_types,
        languageContext: languageContextForSkill(trackId, skill, dsaLanguage),
        goalPriority: selectedTrackIds.has(trackId) ? 10 : 5,
        prerequisiteCentrality: graph.getTransitiveDependents(skill.id).length,
      } as const;
      items.push({
        ...common,
        id: `${trackId}:${skill.id}:diagnostic:${common.languageContext}`,
        kind: "diagnostic",
        position: position++,
      });
      items.push({
        ...common,
        id: `${trackId}:${skill.id}:learn:${common.languageContext}`,
        kind: "learn",
        position: position++,
      });
    }
  }
  return items;
}

export function buildLearningPlan(
  snapshot: ContentSnapshot,
  index: ContentIndex,
  graph: ContentGraph,
  selectedTrackIds: readonly string[],
  dsaLanguageInput?: string | null,
): PlanResolution {
  assertSelectedTracks(snapshot, selectedTrackIds);
  if (!selectedTrackIds.length) {
    return { selectedTrackIds: [], resolvedTrackIds: [], drafts: [], warnings: [] };
  }
  const dsaLanguage = normalizeDsaLanguage(dsaLanguageInput);
  const resolution = resolveTrackOrder(snapshot, selectedTrackIds, dsaLanguage);
  const selected = new Set(selectedTrackIds);
  const trackById = new Map(snapshot.catalog.tracks.map((track) => [track.id, track]));
  const resolvedIndex = new Map(resolution.trackIds.map((trackId, position) => [trackId, position]));
  const drafts: TrackPlanDraft[] = resolution.trackIds.map((trackId) => {
    const track = trackById.get(trackId)!;
    const prerequisiteTrackIds = track.prerequisites.map((expression) => {
      const alternatives = parseTrackPrerequisiteExpression(expression);
      return [...alternatives].sort(
        (left, right) =>
          (resolvedIndex.get(right) ?? -1) - (resolvedIndex.get(left) ?? -1),
      )[0]!;
    });
    return {
      trackId,
      manifestVersion: index.courseById.get(trackId)!.version,
      implementationLanguage: trackId === "dsa" ? dsaLanguage : null,
      prerequisiteTrackIds,
      items: planItemsForCourse(snapshot, index, graph, trackId, selected, dsaLanguage),
    };
  });
  const warnings = [...resolution.warnings];
  if (selected.has("dsa") && !dsaLanguage) {
    warnings.push("DSA implementation language is unset; language-specific evidence remains blocked.");
  }
  return {
    selectedTrackIds: [...selectedTrackIds],
    resolvedTrackIds: resolution.trackIds,
    drafts,
    warnings,
  };
}

export function buildDsaLanguageRetestDraft(
  draft: TrackPlanDraft,
  language: DsaLanguage,
): TrackPlanDraft {
  if (draft.trackId !== "dsa") throw new Error("Language retests apply only to the DSA track.");
  const learnItems = draft.items.filter((item) => item.kind === "learn");
  const updated = learnItems.map((item, position) => ({
    ...item,
    id: `dsa:${item.skillId}:learn:dsa:${language.toLocaleLowerCase("en-US")}`,
    languageContext:
      item.languageContext === "conceptual"
        ? "conceptual"
        : `dsa:${language.toLocaleLowerCase("en-US")}`,
    position,
  }));
  const syntaxRetests = updated
    .filter((item) => item.evidenceTypes.some((type) => LANGUAGE_SPECIFIC_EVIDENCE.has(type)))
    .map((item, offset) => ({
      ...item,
      id: `dsa:${item.skillId}:syntax_retest:${item.languageContext}`,
      kind: "syntax_retest" as const,
      position: updated.length + offset,
      goalPriority: item.goalPriority + 100,
    }));
  return {
    ...draft,
    implementationLanguage: language,
    items: [...updated, ...syntaxRetests],
  };
}
