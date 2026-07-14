import path from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import {
  ContentRepository,
  type AssessmentBank,
  type CourseManifest,
  type CourseModule,
  type DeterministicAssessmentItem,
} from "@/lib/content";

import { buildEquivalentExamForm, verifyEquivalentFormParity } from "./blueprint";
import { toPublicExamForm } from "./contracts";

let course: CourseManifest;
let programModule: CourseModule;
let stateModule: CourseModule;
let programBank: AssessmentBank;
let variablesBank: AssessmentBank;

beforeAll(async () => {
  const repository = new ContentRepository({ contentRoot: path.resolve(process.cwd(), "content") });
  course = (await repository.getCourse("programming-foundations"))!;
  programModule = (await repository.getModule("pf.computing"))!;
  stateModule = (await repository.getModule("pf.state"))!;
  programBank = (await repository.listAssessmentBanks({ skillId: "pf.computing.program" }))[0]!;
  variablesBank = (await repository.listAssessmentBanks({ skillId: "pf.state.variables" }))[0]!;
});

function oneSkill(module: CourseModule, skillId: string): CourseModule {
  return { ...module, skills: module.skills.filter((skill) => skill.id === skillId) };
}

function approvedBank(
  bank: AssessmentBank,
  items: readonly DeterministicAssessmentItem[],
): AssessmentBank {
  return {
    ...bank,
    publication: {
      ...bank.publication,
      stage: "approved",
      reviewer: {
        id: "test-human-reviewer",
        displayName: "Test Human Reviewer",
        kind: "human",
        reviewedAt: "2026-07-12T06:00:00.000Z",
        reviewVersion: bank.schemaVersion,
      },
    },
    items: items.map((item) => ({
      ...item,
      examEligibility: {
        eligible: true,
        rationale: "Human-reviewed deterministic test fixture approved for formal exam evidence.",
      },
    })) as readonly DeterministicAssessmentItem[],
  };
}

describe("formal exam authored evidence", () => {
  it("keeps committed AI-assisted draft banks pending review", () => {
    const form = buildEquivalentExamForm({
      course,
      module: oneSkill(programModule, "pf.computing.program"),
      catalogVersion: "test",
      seed: "draft-is-not-approved",
      assessmentBanks: [programBank],
    });

    expect(form.items).toHaveLength(1);
    expect(form.items[0]?.gradingEvidence).toMatchObject({ kind: "pending-review" });
  });

  it("uses a human-approved deterministic MCQ oracle and removes it from the public form", () => {
    const mcq = programBank.items.find((item) => item.kind === "mcq")!;
    const form = buildEquivalentExamForm({
      course,
      module: oneSkill(programModule, "pf.computing.program"),
      catalogVersion: "test",
      seed: "approved-exact-answer",
      assessmentBanks: [approvedBank(programBank, [mcq])],
    });

    expect(form.items[0]?.gradingEvidence).toMatchObject({
      kind: "exact-answer",
      acceptedAnswers: expect.arrayContaining(["algorithm"]),
      caseSensitive: false,
    });
    const publicJson = JSON.stringify(toPublicExamForm(form));
    expect(publicJson).not.toContain("gradingEvidence");
    expect(publicJson).not.toContain("acceptedAnswers");
    expect(publicJson).not.toContain(form.seed);
  });

  it("carries approved visible and hidden runner tests only in server grading evidence", () => {
    const code = variablesBank.items.find((item) => item.kind === "code")!;
    const form = buildEquivalentExamForm({
      course,
      module: oneSkill(stateModule, "pf.state.variables"),
      catalogVersion: "test",
      seed: "approved-code-tests",
      assessmentBanks: [approvedBank(variablesBank, [code])],
    });
    const evidence = form.items[0]?.gradingEvidence;

    expect(evidence?.kind).toBe("runner-tests");
    if (evidence?.kind === "runner-tests") {
      expect(evidence.tests.some((test) => test.visibility === "VISIBLE")).toBe(true);
      expect(evidence.tests.some((test) => test.visibility === "HIDDEN")).toBe(true);
      expect(evidence.tests).toHaveLength(3);
    }
    expect(form.items[0]?.runtime).toEqual({
      version: code.runtime.version,
      imageDigest: code.runtime.engine === "isolated-runner" ? code.runtime.imageDigest : undefined,
    });
    const changedRuntime = {
      ...form,
      formId: "runtime-parity-candidate",
      seed: "runtime-parity-candidate",
      items: form.items.map((item) => ({
        ...item,
        id: `fresh-${item.id}`,
        runtime: item.runtime ? { ...item.runtime, imageDigest: `sha256:${"f".repeat(64)}` } : undefined,
      })),
    };
    expect(verifyEquivalentFormParity(form, changedRuntime).issues).toContain("BLUEPRINT_MISMATCH");
    const publicJson = JSON.stringify(toPublicExamForm(form));
    expect(publicJson).not.toContain("counter-hidden-zero");
    expect(publicJson).not.toContain("expectedStdout");
    expect(publicJson).toContain("verificationAvailable");
  });
});
