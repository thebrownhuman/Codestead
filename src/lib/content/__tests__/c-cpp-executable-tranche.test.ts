import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  C_CPP_NEW_EXECUTABLE_SPECS,
  C_CPP_NON_CODE_FACETS,
} from "../../../../scripts/content-seeds/c-cpp-executable-tranche";
import { C_CPP_TRANCHE_SEEDS } from "../../../../scripts/content-seeds/c-cpp-tranche";
import type { CodeAssessmentItem } from "../authored-types";
import { ContentRepository } from "../repository";
import { runtimeByLanguage } from "../../runner/client";

const contentRoot = path.resolve(process.cwd(), "content");

async function loadTranche() {
  const repository = new ContentRepository({ contentRoot });
  const [cCourse, cppCourse, authored] = await Promise.all([
    repository.getCourse("c"),
    repository.getCourse("cpp"),
    repository.getAuthoredContentSet(),
  ]);
  const courses = [cCourse!, cppCourse!];
  const declared = courses.flatMap((course) =>
    course.modules.flatMap((courseModule) => courseModule.skills.map((skill) => skill.id)),
  );
  const banks = authored.assessmentBanks.filter(
    (bank) => bank.courseId === "c" || bank.courseId === "cpp",
  );
  return { declared, banks };
}

describe("C and C++ executable tranche", () => {
  it("classifies every declared skill exactly once as executable or justified non-code", async () => {
    const { declared, banks } = await loadTranche();
    const bankBySkill = new Map(banks.map((bank) => [bank.skillId, bank]));

    expect(declared).toHaveLength(76);
    expect(Object.keys(C_CPP_NEW_EXECUTABLE_SPECS)).toHaveLength(54);
    expect(Object.keys(C_CPP_NON_CODE_FACETS)).toHaveLength(10);
    expect(new Set([
      ...Object.keys(C_CPP_NEW_EXECUTABLE_SPECS),
      ...Object.keys(C_CPP_NON_CODE_FACETS),
    ]).size).toBe(64);

    let executable = 0;
    for (const skillId of declared) {
      const bank = bankBySkill.get(skillId)!;
      const codeItems = bank.items.filter((item) => item.kind === "code");
      const nonCodeReason = C_CPP_NON_CODE_FACETS[skillId];
      expect(Boolean(nonCodeReason)).not.toBe(codeItems.length === 1);
      if (nonCodeReason) {
        expect(codeItems).toHaveLength(0);
        expect(nonCodeReason.length).toBeGreaterThan(80);
      } else {
        expect(codeItems).toHaveLength(1);
        executable += 1;
      }
      if (C_CPP_NEW_EXECUTABLE_SPECS[skillId]) expect(codeItems).toHaveLength(1);
    }
    expect(executable).toBe(66);
  });

  it("pins all 66 reference tasks and their 199 exact visible/hidden cases", async () => {
    const { banks } = await loadTranche();
    const runtimeImages = JSON.parse(
      await readFile(
        path.resolve("docs/evidence/container-security/runner/runtime-images.json"),
        "utf8",
      ),
    ) as { records: Array<{ language: string; digest: string }> };
    const digestByLanguage = new Map(
      runtimeImages.records.map((record) => [record.language, record.digest]),
    );
    const codeItems = banks
      .flatMap((bank) => bank.items)
      .filter((item): item is CodeAssessmentItem => item.kind === "code");
    const tests = codeItems.flatMap((item) => item.tests);

    expect(codeItems).toHaveLength(66);
    expect(codeItems.filter((item) => item.runtime.language === "c")).toHaveLength(31);
    expect(codeItems.filter((item) => item.runtime.language === "cpp")).toHaveLength(35);
    expect(tests).toHaveLength(199);
    expect(tests.filter((test) => test.visibility === "visible")).toHaveLength(66);
    expect(tests.filter((test) => test.visibility === "hidden")).toHaveLength(133);
    expect(tests.filter((test) => test.visibility === "hidden" && test.category === "boundary")).toHaveLength(120);

    for (const item of codeItems) {
      const language = item.runtime.language as "c" | "cpp";
      expect(item.runtime).toMatchObject({
        engine: "isolated-runner",
        language,
        version: runtimeByLanguage[language].version,
        imageDigest: digestByLanguage.get(language),
        entrypoint: language === "c" ? "main.c" : "main.cpp",
        timeLimitMs: 2_000,
        memoryLimitMb: 128,
      });
      expect(item.tests.every((test) => test.comparison === "exact" && test.critical)).toBe(true);
      expect(item.tests.some((test) => test.visibility === "visible")).toBe(true);
      expect(item.tests.some((test) => test.visibility === "hidden" && test.category === "boundary")).toBe(true);
      expect(item.answer.referenceSolution).toContain("main");
      expect(item.privateAuthorNotes.join(" ")).toContain("network=none");
      expect(item.examEligibility.eligible).toBe(false);
    }
  });

  it("preserves the original misconception MCQ and checkpoint fill item for every skill", async () => {
    const { banks } = await loadTranche();
    for (const bank of banks) {
      const seed = C_CPP_TRANCHE_SEEDS[bank.skillId as keyof typeof C_CPP_TRANCHE_SEEDS];
      const mcq = bank.items.find((item) => item.kind === "mcq");
      const fill = bank.items.find((item) => item.kind === "fill-gap");
      expect(mcq?.id).toBe(bank.skillId + ".mcq.misconception");
      expect(fill?.id).toBe(bank.skillId + ".fill.checkpoint");
      expect(mcq?.kind).toBe("mcq");
      expect(fill?.kind).toBe("fill-gap");
      if (mcq?.kind === "mcq") {
        expect(mcq.prompt).toContain(seed.misconception);
        expect(mcq.answer.correctOptionIds).toEqual(["correct-rule"]);
        expect(mcq.answer.explanation).toBe(seed.correction);
        expect(mcq.options.find((option) => option.id === "correct-rule")?.text).toBe(seed.correction);
      }
      if (fill?.kind === "fill-gap") {
        expect(fill.template).toBe(seed.correction.replace(seed.checkpoint, "{{key-rule}}"));
        expect(fill.answer.acceptedByGap["key-rule"]).toEqual([seed.checkpoint]);
        expect(fill.answer.explanation).toBe(seed.correction);
      }
    }
  });

  it("keeps every bank and item AI-assisted, human-unreviewed, and exam-ineligible", async () => {
    const { banks } = await loadTranche();
    for (const bank of banks) {
      expect(bank.publication).toMatchObject({
        stage: "draft",
        aiAssisted: true,
        reviewer: null,
        author: { kind: "ai-assisted" },
      });
      expect(bank.items.every((item) => item.examEligibility.eligible === false)).toBe(true);
    }
  });
});
