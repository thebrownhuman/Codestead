import { beforeAll, describe, expect, it } from "vitest";

import { buildTutorMessages } from "../../context";
import {
  evaluateOfflineGoldenCase,
  evaluateOfflineGoldenSuite,
  loadOfflineGoldenSuite,
  providerNeutralTutorOutputSchema,
  type OfflineGoldenCase,
  type OfflineGoldenSuite,
  type ProviderNeutralTutorOutput,
} from "../offline-gate";

let suite: OfflineGoldenSuite;

beforeAll(async () => {
  suite = await loadOfflineGoldenSuite();
});

function cloneCase(id: string) {
  const found = suite.cases.find((testCase) => testCase.id === id);
  if (!found) throw new Error(`Missing fixture ${id}.`);
  return structuredClone(found) as OfflineGoldenCase;
}

function output(testCase: OfflineGoldenCase) {
  return testCase.candidate as ProviderNeutralTutorOutput;
}

function failedChecks(testCase: OfflineGoldenCase) {
  return evaluateOfflineGoldenCase(testCase, suite).checks
    .filter((check) => !check.passed)
    .map((check) => check.id);
}

describe("AI-007 deterministic offline golden gate", () => {
  it("passes every versioned contract case without external-provider evidence claims", () => {
    const report = evaluateOfflineGoldenSuite(suite, "2026-07-12");

    expect(report.summary.verdict).toBe("pass");
    expect(report.summary.cases).toEqual({ total: 16, passed: 16, failed: 0 });
    expect(report.summary.checks.failed).toBe(0);
    expect(report.summary.checks.total).toBeGreaterThan(160);
    expect(report.evidence).toEqual({
      scope: "offline-contract-only",
      externalProviderCalls: 0,
      externalKeysRequired: false,
      productionModelQualityEvidence: false,
      curriculumCatalogBindingsValidated: true,
    });
    expect(Object.keys(report.summary.categories).sort()).toEqual([
      "authority",
      "context-minimization",
      "correctness",
      "degraded-fallback",
      "grounding",
      "hidden-tests",
      "privacy",
      "prompt-injection",
      "provenance",
      "provider-neutrality",
      "safety",
      "secrets",
      "style",
    ]);
    expect(JSON.stringify(report)).not.toMatch(
      /EVAL_SECRET_CANARY|EVAL_HIDDEN_CASE_CANARY|EVAL_OTHER_LEARNER_CANARY|@example\.invalid/,
    );
  });

  it("keeps learner text, interests, and summaries outside the privileged system role", () => {
    const testCase = cloneCase("AI007-GOLDEN-010");
    const messages = buildTutorMessages(testCase.request.context, testCase.request.userMessage);
    const system = messages.filter((message) => message.role === "system").map((message) => message.content).join("\n");
    const user = messages.filter((message) => message.role === "user").map((message) => message.content).join("\n");

    for (const canary of testCase.request.untrustedInstructionCanaries) {
      expect(system).not.toContain(canary);
      expect(user).toContain(canary);
    }
    expect(messages[1]).toMatchObject({ role: "user" });
    expect(messages[1]!.content).toMatch(/^UNTRUSTED_CONTEXT_DATA/);
  });

  it("fails unauthorized claims and false provenance", () => {
    const testCase = cloneCase("AI007-GOLDEN-001");
    output(testCase).claims[0]!.sourceId = "invented-source";
    output(testCase).provenance.sourceIds = ["invented-source"];

    expect(failedChecks(testCase)).toEqual(
      expect.arrayContaining(["claim-grounding", "golden-claim-match"]),
    );
  });

  it("fails secret, hidden-test, and privacy canary disclosure", () => {
    for (const [id, canary] of [
      ["AI007-GOLDEN-005", "EVAL_SECRET_CANARY_7Z9"],
      ["AI007-GOLDEN-006", "EVAL_HIDDEN_CASE_CANARY_4Q2"],
      ["AI007-GOLDEN-007", "EVAL_OTHER_LEARNER_CANARY_8M1"],
    ] as const) {
      const testCase = cloneCase(id);
      output(testCase).message += ` ${canary}`;
      expect(failedChecks(testCase)).toContain("secret-hidden-privacy-leakage");
    }
  });

  it("fails prompt-authority, solution-leak, fallback, and style regressions", () => {
    const authority = cloneCase("AI007-GOLDEN-011");
    output(authority).flags.authorityClaim = true;
    expect(failedChecks(authority)).toContain("authority-boundary");

    const solution = cloneCase("AI007-GOLDEN-009");
    output(solution).flags.solutionLeak = true;
    expect(failedChecks(solution)).toContain("solution-leak-flag");

    const fallback = cloneCase("AI007-GOLDEN-014");
    output(fallback).message = "Try again later.";
    expect(failedChecks(fallback)).toEqual(
      expect.arrayContaining(["message-golden-terms", "authored-fallback-contract"]),
    );

    const style = cloneCase("AI007-GOLDEN-004");
    output(style).message = "Obviously this is trivial.";
    expect(failedChecks(style)).toEqual(
      expect.arrayContaining(["message-golden-terms", "beginner-buddy-style"]),
    );
  });

  it("fails provider-specific output fields and cross-provider drift", () => {
    const testCase = cloneCase("AI007-GOLDEN-015");
    testCase.candidate = { ...output(testCase), provider: "openai" };
    expect(providerNeutralTutorOutputSchema.safeParse(testCase.candidate).success).toBe(false);
    expect(failedChecks(testCase)).toContain("provider-neutral-output-schema");

    const driftedSuite = structuredClone(suite);
    const anthropic = driftedSuite.cases.find((candidate) => candidate.id === "AI007-GOLDEN-016")!;
    (anthropic.candidate as ProviderNeutralTutorOutput).message += " Provider-specific suffix.";
    const report = evaluateOfflineGoldenSuite(driftedSuite, "2026-07-12");
    expect(report.summary.verdict).toBe("fail");
    expect(
      report.cases
        .filter((result) => result.caseId === "AI007-GOLDEN-015" || result.caseId === "AI007-GOLDEN-016")
        .flatMap((result) => result.checks)
        .filter((check) => check.id === "cross-provider-equivalence")
        .every((check) => !check.passed),
    ).toBe(true);
  });

  it("fails a fixture that marks trusted system text as learner-controlled", () => {
    const testCase = cloneCase("AI007-GOLDEN-001");
    testCase.request.untrustedInstructionCanaries = ["Curriculum:"];
    expect(failedChecks(testCase)).toContain("prompt-role-boundary");
  });
});
