import type { AssessmentBank, CodeAssessmentItem } from "./authored-types";

export const DSA_PARITY_LANGUAGES = ["c", "cpp", "java", "python"] as const;
export type DsaParityLanguage = (typeof DSA_PARITY_LANGUAGES)[number];

export interface DsaParityIssue {
  readonly skillId: string;
  readonly message: string;
}

export class DsaParityError extends Error {
  constructor(readonly issues: readonly DsaParityIssue[]) {
    super(`DSA parity validation failed: ${issues.map((issue) => `${issue.skillId}: ${issue.message}`).join("; ")}`);
    this.name = "DsaParityError";
  }
}

export interface DsaParitySummary {
  readonly skillCount: number;
  readonly itemCount: number;
  readonly visibleTestCount: number;
  readonly hiddenTestCount: number;
  readonly examEligibleItemCount: number;
  readonly imageDigests: Readonly<Record<DsaParityLanguage, string>>;
}

function parityItems(bank: AssessmentBank): readonly CodeAssessmentItem[] {
  return bank.items.filter(
    (item): item is CodeAssessmentItem => item.kind === "code" && item.parity !== undefined,
  );
}

function normalizedTests(item: CodeAssessmentItem): string {
  return JSON.stringify(item.tests.map(({ visibility, category, stdin, expectedStdout, comparison, critical }) => ({
    visibility, category, stdin, expectedStdout, comparison, critical,
  })));
}

export function validateDsaLanguageParity(
  banks: readonly AssessmentBank[],
  declaredSkillIds: readonly string[],
): DsaParitySummary {
  const issues: DsaParityIssue[] = [];
  const bankBySkill = new Map(banks.map((bank) => [bank.skillId, bank]));
  const imageDigests = {} as Record<DsaParityLanguage, string>;
  let itemCount = 0, visibleTestCount = 0, hiddenTestCount = 0, examEligibleItemCount = 0;

  for (const skillId of declaredSkillIds) {
    const bank = bankBySkill.get(skillId);
    if (!bank) { issues.push({ skillId, message: "missing assessment bank" }); continue; }
    const items = parityItems(bank);
    itemCount += items.length;
    const byLanguage = new Map(items.map((item) => [item.runtime.language, item]));
    if (items.length !== DSA_PARITY_LANGUAGES.length || byLanguage.size !== DSA_PARITY_LANGUAGES.length) {
      issues.push({ skillId, message: `expected exactly ${DSA_PARITY_LANGUAGES.length} unique language items, found ${items.length}/${byLanguage.size}` });
    }
    const baseline = byLanguage.get("c");
    for (const language of DSA_PARITY_LANGUAGES) {
      const item = byLanguage.get(language);
      if (!item) { issues.push({ skillId, message: `missing ${language} parity item` }); continue; }
      const visible = item.tests.filter((test) => test.visibility === "visible").length;
      const hidden = item.tests.filter((test) => test.visibility === "hidden").length;
      visibleTestCount += visible; hiddenTestCount += hidden;
      if (!visible || !hidden) issues.push({ skillId, message: `${language} requires visible and hidden tests` });
      if (item.runtime.language !== language || item.parity?.language !== language) issues.push({ skillId, message: `${language} runtime/parity language mismatch` });
      if (item.examEligibility.eligible) examEligibleItemCount += 1;
      if (!item.runtime.imageDigest) issues.push({ skillId, message: `${language} has no pinned runtime digest` });
      else if (imageDigests[language] && imageDigests[language] !== item.runtime.imageDigest) issues.push({ skillId, message: `${language} uses inconsistent runtime digests` });
      else imageDigests[language] = item.runtime.imageDigest;
      if (!item.starterCode.trim() || !item.answer.referenceSolution.trim()) issues.push({ skillId, message: `${language} lacks starter/reference source` });
      if (baseline && (item.parity?.parityId !== baseline.parity?.parityId || item.parity?.testContractHash !== baseline.parity?.testContractHash || normalizedTests(item) !== normalizedTests(baseline))) {
        issues.push({ skillId, message: `${language} contract/tests differ from the C parity baseline` });
      }
    }
    if (bank.publication.stage !== "draft" || !bank.publication.aiAssisted || bank.publication.reviewer !== null) issues.push({ skillId, message: "parity bank must remain an AI-assisted unreviewed draft" });
  }
  for (const bank of banks) if (!declaredSkillIds.includes(bank.skillId)) issues.push({ skillId: bank.skillId, message: "bank is not mapped to a declared DSA skill" });
  if (examEligibleItemCount) issues.push({ skillId: "dsa", message: `${examEligibleItemCount} parity items are incorrectly exam eligible` });
  if (issues.length) throw new DsaParityError(issues);
  return { skillCount: declaredSkillIds.length, itemCount, visibleTestCount, hiddenTestCount, examEligibleItemCount, imageDigests };
}
