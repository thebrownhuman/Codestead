import { createHash } from "node:crypto";

import type { AssessmentBank, DeterministicAssessmentItem } from "@/lib/content";

/** Practice quizzes are low-stakes; only items explicitly marked for the practice pool may appear. */
export function isPracticePoolItem(item: DeterministicAssessmentItem): boolean {
  return item.pool === "practice" && !item.examEligibility.eligible;
}

function questionBody(item: DeterministicAssessmentItem): unknown {
  switch (item.kind) {
    case "mcq":
      return { prompt: item.prompt, options: item.options.map((option) => option.text), answer: item.answer.correctOptionIds };
    case "trace":
      return { prompt: item.prompt, artifact: item.artifact, answer: item.answer.acceptedTraces };
    case "fill-gap":
      return { prompt: item.prompt, template: item.template, answer: item.answer.acceptedByGap };
    case "code":
      return { prompt: item.prompt, tests: item.tests.map((test) => [test.stdin, test.expectedStdout]) };
  }
}

/** Stable hash of what a learner sees and must answer, so renamed copies of an exam item are caught. */
export function itemContentHash(item: DeterministicAssessmentItem): string {
  const normalized = JSON.stringify(questionBody(item)).toLocaleLowerCase("en-US").replace(/\s+/g, "");
  return `sha256:${createHash("sha256").update(`${item.kind}:${normalized}`).digest("hex")}`;
}

export interface PracticePoolInput {
  readonly examBanks: readonly AssessmentBank[];
  readonly practiceBanks: readonly AssessmentBank[];
}

/**
 * Exam integrity check: the practice and exam pools must be disjoint. Returns human-readable issues;
 * an empty list means the pools are safe to serve.
 */
export function validatePracticePools({ examBanks, practiceBanks }: PracticePoolInput): readonly string[] {
  const issues: string[] = [];
  const examIds = new Map<string, string>();
  const examHashes = new Map<string, string>();
  for (const bank of examBanks) {
    for (const item of bank.items) {
      if (item.pool === "practice") {
        issues.push(`${bank.id}/${item.id}: practice-pool item found in an exam bank; move it to practice-banks.`);
      }
      examIds.set(item.id, bank.id);
      examHashes.set(itemContentHash(item), `${bank.id}/${item.id}`);
    }
  }
  const practiceIds = new Set<string>();
  for (const bank of practiceBanks) {
    for (const item of bank.items) {
      const label = `${bank.id}/${item.id}`;
      if (item.pool !== "practice") {
        issues.push(`${label}: practice-bank items must declare pool "practice".`);
      }
      if (item.examEligibility.eligible) {
        issues.push(`${label}: practice items can never be exam-eligible.`);
      }
      if (examIds.has(item.id)) {
        issues.push(`${label}: item id is also used by exam bank ${examIds.get(item.id)}.`);
      }
      const duplicate = examHashes.get(itemContentHash(item));
      if (duplicate) {
        issues.push(`${label}: question content duplicates exam item ${duplicate}.`);
      }
      if (practiceIds.has(item.id)) {
        issues.push(`${label}: duplicate practice item id.`);
      }
      practiceIds.add(item.id);
    }
  }
  return issues;
}
