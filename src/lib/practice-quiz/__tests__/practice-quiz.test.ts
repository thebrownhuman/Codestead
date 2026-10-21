import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  isExamEligibleItem,
  parseAssessmentBank,
  type AssessmentBank,
  type McqAssessmentItem,
} from "@/lib/content";

import { loadBanksFrom, PRACTICE_BANKS_DIRECTORY } from "../load";
import { itemContentHash, validatePracticePools } from "../pool";
import { selectPracticeQuizItems } from "../select";

const reviewer = { id: "owner", displayName: "Owner", kind: "human" as const, reviewedAt: "2026-10-01T00:00:00.000Z" };

function mcq(id: string, skillId: string, overrides: Partial<McqAssessmentItem> = {}): McqAssessmentItem {
  return {
    id,
    skillId,
    title: `Item ${id}`,
    kind: "mcq",
    prompt: `Which option is right for ${id}?`,
    points: 2,
    evidenceLevel: "interpret",
    examEligibility: { eligible: false, rationale: "Fixture item for practice pool tests." },
    hints: ["Read every option carefully."],
    feedback: { correct: "Correct, well reasoned.", incorrect: "Not quite, try again." },
    rubric: { passPoints: 2, criteria: [{ id: "choice", description: "Selects the right option.", points: 2, critical: true }] },
    privateAuthorNotes: [],
    options: [{ id: "a", text: `Right for ${id}` }, { id: "b", text: "Wrong" }],
    answer: { correctOptionIds: ["a"], explanation: "Option a matches the definition." },
    ...overrides,
  };
}

function bank(id: string, skillId: string, items: McqAssessmentItem[], approved = false, moduleId = "m1"): AssessmentBank {
  return {
    $schema: "../../schema/assessment-bank.schema.json",
    format: "assessment-bank",
    schemaVersion: "1.0.0",
    id,
    courseId: "c1",
    courseVersion: "0.1.0",
    moduleId,
    skillId,
    title: `Bank ${id}`,
    publication: approved
      ? { stage: "approved", author: { id: "a", displayName: "A", kind: "human" }, authoredAt: "2026-10-01T00:00:00.000Z", aiAssisted: false, reviewer, changeSummary: "Approved fixture bank." }
      : { stage: "draft", author: { id: "a", displayName: "A", kind: "ai-assisted" }, authoredAt: "2026-10-01T00:00:00.000Z", aiAssisted: true, reviewer: null, changeSummary: "Draft fixture bank." },
    sourceRefs: ["src"],
    items,
  } as AssessmentBank;
}

const practice = (id: string, skillId: string) => mcq(id, skillId, { pool: "practice" });

describe("assessment item pool schema", () => {
  it("rejects a practice item marked exam-eligible", () => {
    const value = bank("b1", "s1", [mcq("s1.x", "s1", { pool: "practice", examEligibility: { eligible: true, rationale: "Trying to sneak in." } })], true);
    expect(() => parseAssessmentBank(value, "fixture")).toThrow(/Practice-pool items can never be exam-eligible/);
  });

  it("accepts items with no pool (exam by default) and explicit practice items", () => {
    expect(() => parseAssessmentBank(bank("b1", "s1", [mcq("s1.a", "s1"), practice("s1.b", "s1")]), "fixture")).not.toThrow();
  });
});

describe("isExamEligibleItem", () => {
  it("never treats a practice item as exam-eligible, even in an approved bank", () => {
    const item = mcq("s1.p", "s1", { pool: "practice", examEligibility: { eligible: true, rationale: "Bypassing the schema." } });
    expect(isExamEligibleItem(bank("b1", "s1", [item], true), item)).toBe(false);
  });

  it("keeps approved exam items eligible", () => {
    const item = mcq("s1.e", "s1", { examEligibility: { eligible: true, rationale: "Human approved exam item." } });
    expect(isExamEligibleItem(bank("b1", "s1", [item], true), item)).toBe(true);
  });
});

describe("validatePracticePools", () => {
  it("passes for disjoint pools", () => {
    expect(validatePracticePools({ examBanks: [bank("e", "s1", [mcq("s1.e", "s1")])], practiceBanks: [bank("p", "s1", [practice("s1.p", "s1")])] })).toEqual([]);
  });

  it("flags shared ids, copied content, missing pool marker, and practice items in exam banks", () => {
    const exam = mcq("s1.e", "s1");
    const issues = validatePracticePools({
      examBanks: [bank("e", "s1", [exam, practice("s1.stray", "s1")])],
      practiceBanks: [bank("p", "s1", [
        practice("s1.e", "s1"),
        { ...practice("s1.copy", "s1"), prompt: exam.prompt, options: exam.options },
        mcq("s1.nomark", "s1"),
      ])],
    });
    expect(issues.join("\n")).toMatch(/practice-pool item found in an exam bank/);
    expect(issues.join("\n")).toMatch(/item id is also used by exam bank/);
    expect(issues.join("\n")).toMatch(/duplicates exam item e\/s1.e/);
    expect(issues.join("\n")).toMatch(/must declare pool "practice"/);
  });

  it("hashes ignore whitespace and case", () => {
    const a = mcq("x", "s1");
    expect(itemContentHash(a)).toBe(itemContentHash({ ...a, id: "y", prompt: `  ${a.prompt.toUpperCase()} ` }));
  });
});

describe("selectPracticeQuizItems", () => {
  const banks = [
    bank("p1", "s1", [practice("s1.a", "s1"), practice("s1.b", "s1"), practice("s1.c", "s1")]),
    bank("p2", "s2", [practice("s2.a", "s2")]),
    bank("e1", "s1", [mcq("s1.exam", "s1"), mcq("s1.ok", "s1", { examEligibility: { eligible: true, rationale: "Human approved exam item." } })], true),
    bank("other", "s3", [practice("s3.a", "s3")], false, "m2"),
  ];
  const base = { banks, courseId: "c1", moduleId: "m1", userId: "u1", attemptNumber: 1, runnerEnabled: false };

  it("returns only practice-pool items from the requested module", () => {
    const ids = selectPracticeQuizItems(base).map((selected) => selected.item.id);
    expect(ids.every((id) => id.endsWith(".a") || id.endsWith(".b") || id.endsWith(".c"))).toBe(true);
    expect(ids).not.toContain("s1.exam");
    expect(ids).not.toContain("s1.ok");
    expect(ids).not.toContain("s3.a");
  });

  it("takes up to two items per skill when the module has fewer than three skills", () => {
    const selected = selectPracticeQuizItems(base);
    expect(selected.filter((entry) => entry.item.skillId === "s1")).toHaveLength(2);
    expect(selected.filter((entry) => entry.item.skillId === "s2")).toHaveLength(1);
  });

  it("is deterministic for the same attempt and reshuffles across retries", () => {
    const first = selectPracticeQuizItems(base).map((entry) => entry.item.id);
    expect(selectPracticeQuizItems(base).map((entry) => entry.item.id)).toEqual(first);
    const retries = new Set(Array.from({ length: 12 }, (_, index) =>
      selectPracticeQuizItems({ ...base, attemptNumber: index + 1 }).map((entry) => entry.item.id).join(",")));
    expect(retries.size).toBeGreaterThan(1);
  });

  it("returns nothing for a module without practice items", () => {
    expect(selectPracticeQuizItems({ ...base, moduleId: "none" })).toEqual([]);
  });
});

describe("authored practice banks", () => {
  it("are disjoint from the exam banks", async () => {
    const contentDir = path.resolve(process.cwd(), "content");
    const [examBanks, practiceBanks] = await Promise.all([
      loadBanksFrom(contentDir, "authored/assessment-banks"),
      loadBanksFrom(contentDir, PRACTICE_BANKS_DIRECTORY),
    ]);
    expect(practiceBanks.length).toBeGreaterThan(0);
    expect(validatePracticePools({ examBanks, practiceBanks })).toEqual([]);
  });
});
