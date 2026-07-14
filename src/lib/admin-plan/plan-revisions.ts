export type AdminPlanItem = Record<string, unknown> & {
  id: string;
  skillId: string;
  title: string;
  position: number;
  prerequisites: string[];
};

export type AdminPlanOperation =
  | { type: "add"; itemId: string; fromRevision: number }
  | { type: "remove"; itemId: string }
  | { type: "move"; itemId: string; toPosition: number }
  | { type: "assign_remediation"; itemId: string; note: string }
  | {
      type: "set_override";
      itemId: string;
      mode: "prioritize" | "defer" | "unlock_requested";
      note: string;
    };

export type PlanHistorySource = Readonly<{
  revision: number;
  plan: readonly Record<string, unknown>[];
}>;

export type PlanDiffItem = Readonly<{
  id: string;
  skillId: string;
  title: string;
  fromPosition?: number;
  toPosition?: number;
}>;

export type PlanImpact = Readonly<{
  canApply: boolean;
  prerequisiteViolations: readonly Readonly<{
    itemId: string;
    itemTitle: string;
    prerequisiteSkillId: string;
    kind: "missing" | "ordered_after_dependent";
  }>[];
  downstreamAffected: readonly Readonly<{ skillId: string; title: string }>[];
  overrideRequests: readonly Readonly<{
    itemId: string;
    mode: string;
    prerequisitesEnforced: true;
  }>[];
  evidencePreserved: true;
  masteryMutation: false;
  prerequisiteBypass: false;
}>;

export type PlanChangePreview = Readonly<{
  plan: readonly AdminPlanItem[];
  diff: Readonly<{
    added: readonly PlanDiffItem[];
    removed: readonly PlanDiffItem[];
    moved: readonly PlanDiffItem[];
    changed: readonly PlanDiffItem[];
  }>;
  impact: PlanImpact;
}>;

export class AdminPlanValidationError extends Error {
  constructor(
    public readonly code:
      | "INVALID_PLAN"
      | "ITEM_NOT_FOUND"
      | "ITEM_ALREADY_PRESENT"
      | "SOURCE_REVISION_NOT_FOUND"
      | "INVALID_POSITION",
    message: string,
  ) {
    super(message);
  }
}

function planItem(value: unknown): AdminPlanItem | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.id !== "string" || !candidate.id ||
    typeof candidate.skillId !== "string" || !candidate.skillId ||
    typeof candidate.title !== "string" || !candidate.title ||
    !Number.isInteger(candidate.position) ||
    !Array.isArray(candidate.prerequisites) ||
    !candidate.prerequisites.every((item) => typeof item === "string" && item.length > 0)
  ) return null;
  return {
    ...candidate,
    id: candidate.id,
    skillId: candidate.skillId,
    title: candidate.title,
    position: candidate.position as number,
    prerequisites: [...candidate.prerequisites] as string[],
  };
}

export function parseAdminPlan(value: unknown): AdminPlanItem[] {
  if (!Array.isArray(value)) throw new AdminPlanValidationError("INVALID_PLAN", "The plan snapshot is not an array.");
  const items = value.map(planItem);
  if (items.some((item) => item === null)) {
    throw new AdminPlanValidationError("INVALID_PLAN", "The plan snapshot contains an invalid item.");
  }
  const result = items as AdminPlanItem[];
  if (new Set(result.map((item) => item.id)).size !== result.length) {
    throw new AdminPlanValidationError("INVALID_PLAN", "The plan snapshot contains duplicate item identifiers.");
  }
  return result
    .map((item) => ({ ...item, prerequisites: [...item.prerequisites] }))
    .sort((left, right) => left.position - right.position || left.id.localeCompare(right.id));
}

function renumber(items: readonly AdminPlanItem[]) {
  return items.map((item, position) => ({ ...item, prerequisites: [...item.prerequisites], position }));
}

function sameMetadata(left: AdminPlanItem, right: AdminPlanItem) {
  return JSON.stringify(left.adminRemediation ?? null) === JSON.stringify(right.adminRemediation ?? null) &&
    JSON.stringify(left.adminOverride ?? null) === JSON.stringify(right.adminOverride ?? null);
}

function changedSkillIds(base: readonly AdminPlanItem[], next: readonly AdminPlanItem[]) {
  const baseById = new Map(base.map((item) => [item.id, item]));
  const nextById = new Map(next.map((item) => [item.id, item]));
  const result = new Set<string>();
  for (const item of base) {
    const other = nextById.get(item.id);
    if (!other || other.position !== item.position || !sameMetadata(item, other)) result.add(item.skillId);
  }
  for (const item of next) if (!baseById.has(item.id)) result.add(item.skillId);
  return result;
}

function downstream(
  changed: ReadonlySet<string>,
  catalog: readonly AdminPlanItem[],
) {
  const affected = new Set<string>();
  const queue = [...changed];
  while (queue.length) {
    const prerequisite = queue.shift()!;
    for (const item of catalog) {
      if (!item.prerequisites.includes(prerequisite) || affected.has(item.skillId)) continue;
      affected.add(item.skillId);
      queue.push(item.skillId);
    }
  }
  const titleBySkill = new Map(catalog.map((item) => [item.skillId, item.title]));
  return [...affected].sort().map((skillId) => ({ skillId, title: titleBySkill.get(skillId) ?? skillId }));
}

export function analyzeAdminPlanChange(
  baseValue: unknown,
  nextValue: unknown,
  historicalValues: readonly unknown[] = [],
): Omit<PlanChangePreview, "plan"> {
  const base = parseAdminPlan(baseValue);
  const next = parseAdminPlan(nextValue);
  const historical = historicalValues.flatMap((value) => parseAdminPlan(value));
  const catalog = [...base, ...next, ...historical];
  const knownSkills = new Set(catalog.map((item) => item.skillId));
  const positionsBySkill = new Map<string, number[]>();
  for (const item of next) {
    const positions = positionsBySkill.get(item.skillId) ?? [];
    positions.push(item.position);
    positionsBySkill.set(item.skillId, positions);
  }
  const prerequisiteViolations: Array<PlanImpact["prerequisiteViolations"][number]> = [];
  for (const item of next) {
    for (const prerequisiteSkillId of item.prerequisites) {
      if (!knownSkills.has(prerequisiteSkillId)) continue;
      const prerequisitePositions = positionsBySkill.get(prerequisiteSkillId);
      if (!prerequisitePositions?.length) {
        prerequisiteViolations.push({
          itemId: item.id,
          itemTitle: item.title,
          prerequisiteSkillId,
          kind: "missing",
        });
      } else if (Math.max(...prerequisitePositions) >= item.position) {
        prerequisiteViolations.push({
          itemId: item.id,
          itemTitle: item.title,
          prerequisiteSkillId,
          kind: "ordered_after_dependent",
        });
      }
    }
  }

  const baseById = new Map(base.map((item) => [item.id, item]));
  const nextById = new Map(next.map((item) => [item.id, item]));
  const toDiff = (item: AdminPlanItem, positions: Partial<PlanDiffItem> = {}): PlanDiffItem => ({
    id: item.id,
    skillId: item.skillId,
    title: item.title,
    ...positions,
  });
  const added = next.filter((item) => !baseById.has(item.id)).map((item) => toDiff(item, { toPosition: item.position }));
  const removed = base.filter((item) => !nextById.has(item.id)).map((item) => toDiff(item, { fromPosition: item.position }));
  const moved = next.flatMap((item) => {
    const before = baseById.get(item.id);
    return before && before.position !== item.position
      ? [toDiff(item, { fromPosition: before.position, toPosition: item.position })]
      : [];
  });
  const changed = next.flatMap((item) => {
    const before = baseById.get(item.id);
    return before && !sameMetadata(before, item) ? [toDiff(item)] : [];
  });
  const overrideRequests = next.flatMap((item) => {
    const override = item.adminOverride;
    if (typeof override !== "object" || override === null || Array.isArray(override)) return [];
    const mode = (override as Record<string, unknown>).mode;
    return typeof mode === "string"
      ? [{ itemId: item.id, mode, prerequisitesEnforced: true as const }]
      : [];
  });
  const changedSkills = changedSkillIds(base, next);
  return {
    diff: { added, removed, moved, changed },
    impact: {
      canApply: prerequisiteViolations.length === 0,
      prerequisiteViolations,
      downstreamAffected: downstream(changedSkills, catalog),
      overrideRequests,
      evidencePreserved: true,
      masteryMutation: false,
      prerequisiteBypass: false,
    },
  };
}

export function applyAdminPlanOperations(input: {
  basePlan: unknown;
  history: readonly PlanHistorySource[];
  operations: readonly AdminPlanOperation[];
  actorUserId: string;
  effectiveAt: string;
}): PlanChangePreview {
  const base = renumber(parseAdminPlan(input.basePlan));
  let next: AdminPlanItem[] = base.map((item) => ({ ...item, prerequisites: [...item.prerequisites] }));
  for (const operation of input.operations) {
    if (operation.type === "add") {
      if (next.some((item) => item.id === operation.itemId)) {
        throw new AdminPlanValidationError("ITEM_ALREADY_PRESENT", "The selected plan item is already present.");
      }
      const source = input.history.find((revision) => revision.revision === operation.fromRevision);
      if (!source) throw new AdminPlanValidationError("SOURCE_REVISION_NOT_FOUND", "The source revision was not found.");
      const item = parseAdminPlan(source.plan).find((candidate) => candidate.id === operation.itemId);
      if (!item) throw new AdminPlanValidationError("ITEM_NOT_FOUND", "The selected item was not present in the source revision.");
      next.push({ ...item, position: next.length });
      next = renumber(next);
      continue;
    }
    const index = next.findIndex((item) => item.id === operation.itemId);
    if (index < 0) throw new AdminPlanValidationError("ITEM_NOT_FOUND", "The selected plan item was not found.");
    if (operation.type === "remove") {
      next.splice(index, 1);
      next = renumber(next);
    } else if (operation.type === "move") {
      if (!Number.isInteger(operation.toPosition) || operation.toPosition < 1 || operation.toPosition > next.length) {
        throw new AdminPlanValidationError("INVALID_POSITION", "The destination position is outside this plan.");
      }
      const [item] = next.splice(index, 1);
      next.splice(operation.toPosition - 1, 0, item);
      next = renumber(next);
    } else if (operation.type === "assign_remediation") {
      next[index] = {
        ...next[index],
        adminRemediation: {
          assigned: true,
          note: operation.note,
          assignedBy: input.actorUserId,
          effectiveAt: input.effectiveAt,
          evidencePreserved: true,
        },
      };
    } else {
      next[index] = {
        ...next[index],
        adminOverride: {
          mode: operation.mode,
          note: operation.note,
          requestedBy: input.actorUserId,
          effectiveAt: input.effectiveAt,
          prerequisitesEnforced: true,
          masteryUnaffected: true,
        },
      };
    }
  }
  const analysis = analyzeAdminPlanChange(base, next, input.history.map((item) => item.plan));
  const revisionContext = {
    actorUserId: input.actorUserId,
    effectiveAt: input.effectiveAt,
    operationTypes: input.operations.map((operation) => operation.type),
    evidencePreserved: true,
    masteryUnaffected: true,
    prerequisitesEnforced: true,
  } as const;
  return {
    plan: next.map((item) => ({ ...item, adminRevision: revisionContext })),
    ...analysis,
  };
}
