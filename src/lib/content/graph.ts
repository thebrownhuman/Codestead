import { parseTrackPrerequisiteExpression } from "./track-prerequisites";
import type {
  AtomicSkill,
  ContentCatalog,
  ContentIndex,
  NodeEligibility,
  SkillStatus,
  TrackEligibility,
  TrackAccessState,
  TrackPrerequisiteGroup,
} from "./types";

export interface EligibleSkillOptions {
  readonly courseId?: string;
  readonly status?: SkillStatus | readonly SkillStatus[];
  readonly includeAchieved?: boolean;
}

export interface TrackAccessOptions {
  readonly adminPrerequisiteOverride?: boolean;
}

function asSet(values: Iterable<string>): ReadonlySet<string> {
  return values instanceof Set ? values : new Set(values);
}

function statusMatches(
  status: SkillStatus,
  expected?: SkillStatus | readonly SkillStatus[],
): boolean {
  if (!expected) return true;
  return Array.isArray(expected) ? expected.includes(status) : status === expected;
}

export class ContentGraph {
  private readonly trackById = new Map<string, ContentCatalog["tracks"][number]>();
  private readonly directNodePrerequisites = new Map<string, readonly string[]>();
  private readonly directNodeDependents = new Map<string, Set<string>>();

  constructor(
    private readonly catalog: ContentCatalog,
    private readonly index: ContentIndex,
  ) {
    for (const track of catalog.tracks) this.trackById.set(track.id, track);
    for (const [moduleId, courseModule] of index.moduleById) {
      this.directNodePrerequisites.set(moduleId, courseModule.prerequisites);
    }
    for (const [skillId, skill] of index.skillById) {
      const location = index.skillLocationById.get(skillId);
      const prerequisites = new Set([
        ...(location?.module.prerequisites ?? []),
        ...skill.prerequisites,
      ]);
      this.directNodePrerequisites.set(skillId, [...prerequisites]);
    }
    for (const [nodeId, prerequisites] of this.directNodePrerequisites) {
      for (const prerequisite of prerequisites) {
        const dependents = this.directNodeDependents.get(prerequisite) ?? new Set<string>();
        dependents.add(nodeId);
        this.directNodeDependents.set(prerequisite, dependents);
      }
    }
  }

  getTrackPrerequisiteGroups(trackId: string): readonly TrackPrerequisiteGroup[] {
    const track = this.trackById.get(trackId);
    if (!track) throw new RangeError(`Unknown catalog track '${trackId}'.`);
    return track.prerequisites.map((expression) => ({
      expression,
      alternatives: parseTrackPrerequisiteExpression(expression),
    }));
  }

  evaluateTrackEligibility(
    trackId: string,
    completedTrackIds: Iterable<string>,
  ): TrackEligibility {
    const completed = asSet(completedTrackIds);
    const groups = this.getTrackPrerequisiteGroups(trackId).map((group) => {
      const satisfiedBy = group.alternatives.find((alternative) => completed.has(alternative));
      return satisfiedBy ? { ...group, satisfiedBy } : group;
    });
    const missingGroups = groups.filter((group) => !group.satisfiedBy);
    return {
      trackId,
      eligible: missingGroups.length === 0,
      groups,
      missingGroups,
    };
  }

  getTrackAccessState(
    trackId: string,
    completedTrackIds: Iterable<string>,
    options: TrackAccessOptions = {},
  ): TrackAccessState {
    const track = this.trackById.get(trackId);
    if (!track) throw new RangeError(`Unknown catalog track '${trackId}'.`);
    const eligibility = this.evaluateTrackEligibility(trackId, completedTrackIds);
    const visible = track.gating.visibility === "listed";

    if (track.status === "retired") {
      return {
        ...eligibility,
        visible,
        access: "retired",
        canEnroll: false,
        adminOverrideApplied: false,
        reason: "This track is retired and does not accept new enrollments.",
      };
    }
    if (track.status === "coming-soon" || track.gating.enrollment === "blocked-until-published") {
      return {
        ...eligibility,
        visible,
        access: "coming-soon",
        canEnroll: false,
        adminOverrideApplied: false,
        reason: "Coming Soon: the scope brief is visible, but no learner content is published.",
      };
    }
    if (eligibility.eligible) {
      return {
        ...eligibility,
        visible,
        access: "available",
        canEnroll: true,
        adminOverrideApplied: false,
        reason: "All required track prerequisites are complete.",
      };
    }

    const adminOverrideApplied = Boolean(
      options.adminPrerequisiteOverride &&
      track.gating.admin_override === "prerequisites-only",
    );
    return {
      ...eligibility,
      visible,
      access: adminOverrideApplied ? "available" : "locked-prerequisites",
      canEnroll: adminOverrideApplied,
      adminOverrideApplied,
      reason: adminOverrideApplied
        ? "An audited administrator override bypasses prerequisites for this published track only."
        : "Complete the listed prerequisite tracks, or request an audited administrator override.",
    };
  }

  listEligibleTrackIds(
    completedTrackIds: Iterable<string>,
    includeCompleted = false,
  ): readonly string[] {
    const completed = asSet(completedTrackIds);
    return this.catalog.tracks
      .filter(
        (track) =>
          (includeCompleted || !completed.has(track.id)) &&
          this.getTrackAccessState(track.id, completed).canEnroll,
      )
      .map((track) => track.id);
  }

  getDirectPrerequisites(nodeId: string): readonly string[] {
    this.assertKnownNode(nodeId);
    return [...(this.directNodePrerequisites.get(nodeId) ?? [])];
  }

  getDirectDependents(nodeId: string): readonly string[] {
    this.assertKnownNode(nodeId);
    return [...(this.directNodeDependents.get(nodeId) ?? [])].sort();
  }

  getTransitiveDependents(nodeId: string): readonly string[] {
    this.assertKnownNode(nodeId);
    const result = new Set<string>();
    const pending = [...(this.directNodeDependents.get(nodeId) ?? [])];
    while (pending.length) {
      const current = pending.pop()!;
      if (result.has(current)) continue;
      result.add(current);
      pending.push(...(this.directNodeDependents.get(current) ?? []));
    }
    return [...result].sort();
  }

  getTransitivePrerequisiteSkillIds(nodeId: string): readonly string[] {
    this.assertKnownNode(nodeId);
    const result = new Set<string>();
    const visitedNodes = new Set<string>();

    const visitRequirement = (requirementId: string): void => {
      if (visitedNodes.has(requirementId)) return;
      visitedNodes.add(requirementId);
      const skill = this.index.skillById.get(requirementId);
      if (skill) {
        result.add(skill.id);
        for (const prerequisite of this.getDirectPrerequisites(skill.id)) {
          visitRequirement(prerequisite);
        }
        return;
      }
      const courseModule = this.index.moduleById.get(requirementId);
      if (!courseModule) return;
      for (const prerequisite of courseModule.prerequisites) visitRequirement(prerequisite);
      for (const skillId of this.index.requiredSkillIdsByModule.get(courseModule.id) ?? []) {
        visitRequirement(skillId);
      }
    };

    for (const prerequisite of this.getDirectPrerequisites(nodeId)) {
      visitRequirement(prerequisite);
    }
    return [...result].sort();
  }

  evaluateNodeEligibility(
    nodeId: string,
    achievedSkillIds: Iterable<string>,
  ): NodeEligibility {
    this.assertKnownNode(nodeId);
    const achieved = asSet(achievedSkillIds);
    const directPrerequisites = this.getDirectPrerequisites(nodeId);
    const satisfiedPrerequisites: string[] = [];
    const missingPrerequisites: string[] = [];

    for (const prerequisite of directPrerequisites) {
      if (this.requirementSatisfied(prerequisite, achieved)) {
        satisfiedPrerequisites.push(prerequisite);
      } else {
        missingPrerequisites.push(prerequisite);
      }
    }

    const expandedMissing = new Set<string>();
    for (const prerequisite of missingPrerequisites) {
      this.expandMissingRequirement(prerequisite, achieved, expandedMissing, new Set());
    }

    return {
      nodeId,
      eligible: missingPrerequisites.length === 0,
      directPrerequisites,
      satisfiedPrerequisites: satisfiedPrerequisites.sort(),
      missingPrerequisites: missingPrerequisites.sort(),
      expandedMissingSkillIds: [...expandedMissing].sort(),
    };
  }

  listEligibleSkills(
    achievedSkillIds: Iterable<string>,
    options: EligibleSkillOptions = {},
  ): readonly AtomicSkill[] {
    const achieved = asSet(achievedSkillIds);
    const result: AtomicSkill[] = [];
    for (const [skillId, skill] of this.index.skillById) {
      const location = this.index.skillLocationById.get(skillId)!;
      if (options.courseId && location.course.id !== options.courseId) continue;
      if (!statusMatches(skill.status, options.status)) continue;
      if (!options.includeAchieved && achieved.has(skillId)) continue;
      if (this.evaluateNodeEligibility(skillId, achieved).eligible) result.push(skill);
    }
    return result.sort((left, right) => left.id.localeCompare(right.id));
  }

  private requirementSatisfied(
    requirementId: string,
    achieved: ReadonlySet<string>,
  ): boolean {
    if (achieved.has(requirementId)) return true;
    if (this.index.skillById.has(requirementId)) return false;
    const requiredSkills = this.index.requiredSkillIdsByModule.get(requirementId);
    return Boolean(requiredSkills?.length) && requiredSkills!.every((skillId) => achieved.has(skillId));
  }

  private expandMissingRequirement(
    requirementId: string,
    achieved: ReadonlySet<string>,
    result: Set<string>,
    visiting: Set<string>,
  ): void {
    if (visiting.has(requirementId) || this.requirementSatisfied(requirementId, achieved)) return;
    visiting.add(requirementId);
    if (this.index.skillById.has(requirementId)) {
      result.add(requirementId);
      for (const prerequisite of this.getDirectPrerequisites(requirementId)) {
        this.expandMissingRequirement(prerequisite, achieved, result, visiting);
      }
    } else {
      const courseModule = this.index.moduleById.get(requirementId);
      if (courseModule) {
        for (const prerequisite of courseModule.prerequisites) {
          this.expandMissingRequirement(prerequisite, achieved, result, visiting);
        }
        for (const skillId of this.index.requiredSkillIdsByModule.get(courseModule.id) ?? []) {
          this.expandMissingRequirement(skillId, achieved, result, visiting);
        }
      }
    }
    visiting.delete(requirementId);
  }

  private assertKnownNode(nodeId: string): void {
    if (!this.index.skillById.has(nodeId) && !this.index.moduleById.has(nodeId)) {
      throw new RangeError(`Unknown curriculum node '${nodeId}'.`);
    }
  }
}
