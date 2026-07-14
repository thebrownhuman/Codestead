import { createHash, randomBytes, randomUUID } from "node:crypto";

import {
  isExamEligibleItem,
  type AssessmentBank,
  type DeterministicAssessmentItem,
  type CourseManifest,
  type CourseModule,
} from "@/lib/content";

import {
  EXAM_POLICY_VERSION,
  type ExamFormSnapshot,
  type ExamItem,
  type ExamLanguage,
  type ExamResult,
} from "./contracts";
import { examDurationMinutes } from "./policy";

const LANGUAGE_BY_COURSE: Readonly<Record<string, ExamLanguage>> = {
  c: "c",
  cpp: "cpp",
  java: "java",
  python: "python",
  javascript: "javascript",
  react: "javascript",
  dsa: "cpp",
  ai: "python",
};

const STARTER_CODE: Readonly<Record<ExamLanguage, string>> = {
  c: "#include <stdio.h>\n\nint main(void) {\n    // Write your solution here.\n    return 0;\n}\n",
  cpp: "#include <iostream>\n\nint main() {\n    // Write your solution here.\n    return 0;\n}\n",
  java: "public class Main {\n    public static void main(String[] args) {\n        // Write your solution here.\n    }\n}\n",
  python: "# Write your solution here.\n",
  javascript: "// Write your solution here.\n",
};

function hashOrder(seed: string, value: string): string {
  return createHash("sha256").update(`${seed}:${value}`).digest("hex");
}

function shuffled<T extends { readonly id: string }>(values: readonly T[], seed: string): readonly T[] {
  return [...values].sort((left, right) =>
    hashOrder(seed, left.id).localeCompare(hashOrder(seed, right.id)),
  );
}

function outcomeFor(seed: string, skillId: string, outcomes: readonly string[]): string {
  if (outcomes.length === 0) return "Demonstrate the skill in a small, verifiable example.";
  const digest = createHash("sha256").update(`${seed}:${skillId}:outcome`).digest();
  return outcomes[digest[0]! % outcomes.length]!;
}

function itemKind(
  evidenceTypes: readonly string[],
  language: ExamLanguage | undefined,
): "short-answer" | "code" {
  return language !== undefined && evidenceTypes.some((type) =>
    type === "code" || type === "debug" || type === "test" || type === "artifact",
  )
    ? "code"
    : "short-answer";
}

function createItem(
  course: CourseManifest,
  courseModule: CourseModule,
  skill: CourseModule["skills"][number],
  index: number,
  seed: string,
  assessmentBanks: readonly AssessmentBank[],
): ExamItem {
  const eligibleItems = assessmentBanks
    .filter((bank) => bank.skillId === skill.id)
    .flatMap((bank) => bank.items
      .filter((item) => isExamEligibleItem(bank, item))
      .map((item) => ({ bank, item })));
  if (eligibleItems.length > 0) {
    const digest = createHash("sha256").update(`${seed}:${skill.id}:authored-item`).digest();
    const selected = eligibleItems[digest[0]! % eligibleItems.length]!;
    return createApprovedAuthoredItem(courseModule, selected.bank, selected.item, index, seed);
  }
  const language = LANGUAGE_BY_COURSE[course.id];
  const kind = itemKind(skill.evidence_types, language);
  const outcome = outcomeFor(seed, skill.id, skill.outcomes);
  const prompt = kind === "code"
    ? `Write a complete ${language?.toUpperCase()} program that demonstrates this authored outcome: ${outcome} Include a small input/output example and keep the behavior observable.`
    : `Explain and demonstrate this authored outcome in your own words: ${outcome} Include one concrete example and one boundary or failure case.`;
  return {
    id: `q${String(index + 1).padStart(2, "0")}-${createHash("sha256").update(`${seed}:${skill.id}`).digest("hex").slice(0, 10)}`,
    skillId: skill.id,
    clusterId: skill.id,
    title: skill.title,
    prompt,
    kind,
    points: 10,
    critical: courseModule.required && skill.status === "required",
    ...(kind === "code" && language !== undefined
      ? { language, starterCode: STARTER_CODE[language] }
      : {}),
    gradingEvidence: {
      kind: "pending-review",
      reason:
        "The curriculum declares the outcome and evidence mode but does not yet include a reviewed answer oracle or deterministic test bundle.",
    },
  };
}

function fillGapAnswers(item: Extract<DeterministicAssessmentItem, { kind: "fill-gap" }>): readonly string[] {
  let answers: readonly string[] = [""];
  for (const gap of item.gaps) {
    const accepted = item.answer.acceptedByGap[gap.id] ?? [];
    answers = answers.flatMap((prefix) => accepted.map((value) =>
      `${prefix}${prefix ? ";" : ""}${gap.id}=${value}`,
    ));
    if (answers.length > 64) {
      throw new Error(`Assessment item '${item.id}' expands to more than 64 exact answer forms.`);
    }
  }
  return answers;
}

function exactAnswersFor(item: Exclude<DeterministicAssessmentItem, { kind: "code" }>): {
  readonly acceptedAnswers: readonly string[];
  readonly caseSensitive: boolean;
  readonly promptSuffix: string;
} {
  if (item.kind === "mcq") {
    const optionText = new Map(item.options.map((option) => [option.id, option.text]));
    return {
      acceptedAnswers: [
        item.answer.correctOptionIds.join(","),
        item.answer.correctOptionIds.map((id) => optionText.get(id) ?? id).join(","),
      ],
      caseSensitive: false,
      promptSuffix: `\n\nOptions:\n${item.options.map((option) => `${option.id}: ${option.text}`).join("\n")}\nAnswer with the option id.`,
    };
  }
  if (item.kind === "trace") {
    return {
      acceptedAnswers: item.answer.acceptedTraces,
      caseSensitive: item.answer.caseSensitive,
      promptSuffix: `\n\nArtifact:\n${item.artifact.join("\n")}`,
    };
  }
  return {
    acceptedAnswers: fillGapAnswers(item),
    caseSensitive: item.answer.caseSensitive,
    promptSuffix: `\n\n${item.template}\nAnswer as ${item.gaps.map((gap) => `${gap.id}=value`).join(";")}.`,
  };
}

function createApprovedAuthoredItem(
  courseModule: CourseModule,
  bank: AssessmentBank,
  item: DeterministicAssessmentItem,
  index: number,
  seed: string,
): ExamItem {
  const id = `q${String(index + 1).padStart(2, "0")}-${createHash("sha256")
    .update(`${seed}:${bank.id}:${item.id}`)
    .digest("hex")
    .slice(0, 10)}`;
  if (item.kind === "code") {
    if (item.runtime.engine !== "isolated-runner") {
      throw new Error(
        `Authoring-only browser item '${item.id}' cannot enter an official exam blueprint.`,
      );
    }
    if (!item.runtime.imageDigest) {
      throw new Error(`Official runner item '${item.id}' has no pinned runtime image digest.`);
    }
    return {
      id,
      skillId: item.skillId,
      clusterId: item.skillId,
      title: item.title,
      prompt: item.prompt,
      kind: "code",
      points: item.points,
      critical: courseModule.required,
      language: item.runtime.language,
      starterCode: item.starterCode,
      runtime: {
        version: item.runtime.version,
        imageDigest: item.runtime.imageDigest,
      },
      gradingEvidence: {
        kind: "runner-tests",
        bundleVersion: `${bank.schemaVersion}:${bank.id}`,
        tests: item.tests.map((test) => ({
          id: test.id,
          visibility: test.visibility === "hidden" ? "HIDDEN" : "VISIBLE",
          category: test.category,
          stdin: test.stdin,
          expectedStdout: test.expectedStdout,
          comparison: test.comparison === "exact" ? "EXACT" : "TRIMMED",
          critical: test.critical,
        })),
      },
    };
  }
  const exact = exactAnswersFor(item);
  return {
    id,
    skillId: item.skillId,
    clusterId: item.skillId,
    title: item.title,
    prompt: `${item.prompt}${exact.promptSuffix}`,
    kind: "short-answer",
    points: item.points,
    critical: courseModule.required,
    gradingEvidence: {
      kind: "exact-answer",
      acceptedAnswers: exact.acceptedAnswers,
      caseSensitive: exact.caseSensitive,
    },
  };
}

export function buildEquivalentExamForm(input: {
  readonly course: CourseManifest;
  readonly module: CourseModule;
  readonly catalogVersion: string;
  readonly now?: Date;
  readonly seed?: string;
  readonly formId?: string;
  readonly assessmentBanks?: readonly AssessmentBank[];
}): ExamFormSnapshot {
  if (input.module.skills.length === 0) {
    throw new Error("Cannot build an exam for a module without skills.");
  }
  const seed = input.seed ?? randomBytes(16).toString("hex");
  const orderedSkills = shuffled(input.module.skills, seed);
  const items = orderedSkills.map((skill, index) =>
    createItem(input.course, input.module, skill, index, seed, input.assessmentBanks ?? []),
  );
  const now = input.now ?? new Date();
  return {
    schemaVersion: 1,
    purpose: "formal-exam",
    formId: input.formId ?? randomUUID(),
    seed,
    courseId: input.course.id,
    courseTitle: input.course.title,
    moduleId: input.module.id,
    moduleTitle: input.module.title,
    contentVersion: `${input.catalogVersion}:${input.course.version}`,
    policyVersion: EXAM_POLICY_VERSION,
    durationMinutes: examDurationMinutes(items.length),
    generatedAt: now.toISOString(),
    instructions: [
      "Work independently. Tutor, lesson, and personal notes are unavailable inside the exam.",
      "Your latest successful autosave is the submission of record when the server deadline expires.",
      "Compile and run are available for code questions; output is shown without AI interpretation.",
      "Questions without reviewed answer or test evidence are finalized as pending review, never guessed.",
    ],
    integrityDisclosure: {
      version: "integrity-disclosure-v1",
      summary:
        "The exam records focus, visibility, paste count, fullscreen, navigation, and connection events for review. These signals never change a score automatically.",
      capturedEvents: [
        "Window focus and blur",
        "Tab visibility",
        "Paste character count (not clipboard content)",
        "Fullscreen enter and exit",
        "Navigation attempts",
        "Connection loss and restoration",
      ],
      notCaptured: [
        "Camera, microphone, screen contents, keystroke contents, or clipboard contents",
        "Automated guilt decisions or automatic score penalties",
      ],
    },
    items,
  };
}

function blueprintDescriptor(form: ExamFormSnapshot) {
  return form.items
    .map((item) => ({
      skillId: item.skillId,
      clusterId: item.clusterId,
      kind: item.kind,
      points: item.points,
      critical: item.critical,
      evidenceKind: item.gradingEvidence.kind,
      bundleVersion: item.gradingEvidence.kind === "runner-tests"
        ? item.gradingEvidence.bundleVersion
        : null,
      runtimeVersion: item.runtime?.version ?? null,
      runtimeImageDigest: item.runtime?.imageDigest ?? null,
    }))
    .sort((left, right) =>
      left.skillId.localeCompare(right.skillId) ||
      left.clusterId.localeCompare(right.clusterId),
    );
}

function blueprintHash(form: ExamFormSnapshot): string {
  return createHash("sha256").update(JSON.stringify(blueprintDescriptor(form))).digest("hex");
}

export interface EquivalentFormParityReport {
  readonly equivalent: boolean;
  readonly sourceBlueprintHash: string;
  readonly candidateBlueprintHash: string;
  readonly issues: readonly string[];
}

/**
 * Retakes fail closed unless their immutable reviewed version and calibrated
 * structural blueprint match the prior form while identifiers and seed are
 * fresh. Prompts/oracles remain server-only and are represented by hashes.
 */
export function verifyEquivalentFormParity(
  source: ExamFormSnapshot,
  candidate: ExamFormSnapshot,
): EquivalentFormParityReport {
  const issues: string[] = [];
  if (source.courseId !== candidate.courseId || source.moduleId !== candidate.moduleId) {
    issues.push("MODULE_MISMATCH");
  }
  if (source.contentVersion !== candidate.contentVersion) issues.push("CONTENT_VERSION_MISMATCH");
  if (source.policyVersion !== candidate.policyVersion) issues.push("POLICY_VERSION_MISMATCH");
  if (source.durationMinutes !== candidate.durationMinutes) issues.push("DURATION_MISMATCH");
  if (source.formId === candidate.formId) issues.push("FORM_ID_REUSED");
  if (source.seed === candidate.seed) issues.push("SEED_REUSED");
  const sourceBlueprintHash = blueprintHash(source);
  const candidateBlueprintHash = blueprintHash(candidate);
  if (sourceBlueprintHash !== candidateBlueprintHash) issues.push("BLUEPRINT_MISMATCH");
  if (candidate.items.some((item) => item.gradingEvidence.kind === "pending-review")) {
    issues.push("UNREVIEWED_EVIDENCE");
  }
  return {
    equivalent: issues.length === 0,
    sourceBlueprintHash,
    candidateBlueprintHash,
    issues,
  };
}

export function buildTargetedMasteryRecheckForm(input: {
  readonly sourceForm: ExamFormSnapshot;
  readonly sourceResult: ExamResult;
  readonly candidateForm: ExamFormSnapshot;
  readonly now?: Date;
  readonly formId?: string;
}): ExamFormSnapshot {
  const targets = input.sourceResult.masteryRecheck;
  if (input.sourceResult.outcome !== "PASSED" || !targets?.required) {
    throw new Error("A targeted mastery recheck requires a protected prior pass.");
  }
  const parity = verifyEquivalentFormParity(input.sourceForm, input.candidateForm);
  if (!parity.equivalent) {
    throw new Error(`Targeted recheck parity failed: ${parity.issues.join(",")}`);
  }
  const sourceTargets = input.sourceForm.items.filter((item) =>
    targets.clusterIds.includes(item.clusterId) || targets.codingItemIds.includes(item.id)
  );
  const skillIds = new Set(sourceTargets.map((item) => item.skillId));
  const items = input.candidateForm.items.filter((item) => skillIds.has(item.skillId));
  if (items.length === 0 || items.length >= input.sourceForm.items.length || items.length !== skillIds.size) {
    throw new Error("A mastery recheck must cover every target exactly once and remain shorter than the source form.");
  }
  if (items.some((item) => item.gradingEvidence.kind === "pending-review")) {
    throw new Error("A mastery recheck cannot use unreviewed grading evidence.");
  }
  return {
    ...input.candidateForm,
    purpose: "mastery-recheck",
    formId: input.formId ?? randomUUID(),
    durationMinutes: examDurationMinutes(items.length),
    generatedAt: (input.now ?? new Date()).toISOString(),
    instructions: [
      "This shorter closed-book form rechecks only mastery targets from a prior passing exam.",
      "Your prior passing result cannot be lowered by this recheck.",
      ...input.candidateForm.instructions,
    ],
    items,
  };
}
