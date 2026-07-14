import path from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import {
  ContentRepository,
  type AssessmentBank,
  type DeterministicAssessmentItem,
} from "@/lib/content";

import {
  isReviewedAuthoredActivity,
  reviewedAuthoredActivitySpecification,
} from "../publication-binding";

let draftBank: AssessmentBank;

beforeAll(async () => {
  const content = new ContentRepository({ contentRoot: path.resolve(process.cwd(), "content") });
  draftBank = (await content.listAssessmentBanks({ skillId: "pf.computing.program" }))[0]!;
});

function approvedBank(item: DeterministicAssessmentItem): AssessmentBank {
  return {
    ...draftBank,
    publication: {
      ...draftBank.publication,
      stage: "approved",
      reviewer: {
        id: "binding-human-reviewer",
        displayName: "Binding Human Reviewer",
        kind: "human",
        reviewedAt: "2026-07-12T07:00:00.000Z",
        reviewVersion: draftBank.schemaVersion,
      },
    },
    items: [{
      ...item,
      examEligibility: {
        eligible: true,
        rationale: "The deterministic item was independently reviewed for this publication-binding test.",
      },
    }] as readonly DeterministicAssessmentItem[],
  };
}

describe("reviewed activity publication binding", () => {
  it("accepts only an exact item in a human-approved, exam-eligible bank", () => {
    const item = draftBank.items[0]!;
    const reviewed = approvedBank(item);
    expect(isReviewedAuthoredActivity(
      { authoredItemId: item.id },
      reviewed as unknown as Record<string, unknown>,
    )).toBe(true);
    expect(isReviewedAuthoredActivity(
      { authoredItemId: "forged-item" },
      reviewed as unknown as Record<string, unknown>,
    )).toBe(false);
  });

  it("derives prompt, options, and grader only from the reviewed item", () => {
    const item = draftBank.items.find((candidate) => candidate.kind === "mcq")!;
    const reviewed = approvedBank(item);
    const bound = reviewedAuthoredActivitySpecification({
      authoredItemId: item.id,
      prompt: "Forged prompt",
      options: [{ id: "forged", text: "Forged option" }],
      grading: { kind: "choice", acceptedAnswers: ["forged"] },
    }, reviewed as unknown as Record<string, unknown>, item.skillId);

    expect(bound).toMatchObject({
      authoredItemId: item.id,
      prompt: item.prompt,
      options: item.options,
      grading: {
        correctOptionIds: item.answer.correctOptionIds,
      },
    });
    expect(JSON.stringify(bound)).not.toContain("Forged");
  });

  it("derives misconception probes only from the reviewed item", () => {
    const source = draftBank.items.find((candidate) => candidate.kind === "trace")!;
    const item = {
      ...source,
      misconceptionMappings: [{
        tag: "program.layer-confusion",
        answers: ["source code"],
      }],
    } as DeterministicAssessmentItem;
    const reviewed = approvedBank(item);
    const bound = reviewedAuthoredActivitySpecification({
      authoredItemId: item.id,
      grading: {
        kind: "exact",
        acceptedAnswers: ["forged answer"],
        misconceptions: [{ tag: "forged.tag", answers: ["forged probe"] }],
      },
    }, reviewed as unknown as Record<string, unknown>, item.skillId);

    expect(bound).toMatchObject({
      grading: {
        kind: "exact",
        acceptedAnswers: source.answer.acceptedTraces,
        misconceptions: [{
          tag: "program.layer-confusion",
          answers: ["source code"],
        }],
      },
    });
    expect(JSON.stringify(bound)).not.toMatch(/forged answer|forged\.tag|forged probe/);
  });

  it("rejects a reviewed item bound to a different concept skill", () => {
    const item = draftBank.items[0]!;
    expect(isReviewedAuthoredActivity(
      { authoredItemId: item.id },
      approvedBank(item) as unknown as Record<string, unknown>,
      "different.skill",
    )).toBe(false);
  });

  it("rejects draft, unbound, and malformed activity evidence", () => {
    const item = draftBank.items[0]!;
    expect(isReviewedAuthoredActivity(
      { authoredItemId: item.id },
      draftBank as unknown as Record<string, unknown>,
    )).toBe(false);
    expect(isReviewedAuthoredActivity(
      {},
      approvedBank(item) as unknown as Record<string, unknown>,
    )).toBe(false);
    expect(isReviewedAuthoredActivity(
      { authoredItemId: item.id },
      { items: [{ id: item.id, examEligibility: { eligible: true } }] },
    )).toBe(false);
  });
});
