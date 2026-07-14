import path from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { ContentRepository } from "@/lib/content";

import {
  buildDsaLanguageRetestDraft,
  buildLearningPlan,
  dsaRunnerLanguage,
  isLanguageSpecificDsaSkill,
  normalizeDsaLanguage,
} from "../planner";

const repository = new ContentRepository({ contentRoot: path.resolve(process.cwd(), "content") });
let runtime: Awaited<ReturnType<typeof loadRuntime>>;

async function loadRuntime() {
  return Promise.all([repository.getSnapshot(), repository.getIndex(), repository.getGraph()]);
}

beforeAll(async () => {
  runtime = await loadRuntime();
});

describe("versioned learning plan compiler", () => {
  it("expands a selected DSA track through the chosen language prerequisite", () => {
    const result = buildLearningPlan(runtime[0], runtime[1], runtime[2], ["dsa"], "Python");

    expect(result.selectedTrackIds).toEqual(["dsa"]);
    expect(result.resolvedTrackIds).toEqual([
      "programming-foundations",
      "python",
      "dsa",
    ]);
    expect(result.drafts.map((draft) => draft.trackId)).toEqual(result.resolvedTrackIds);
    expect(result.drafts.map((draft) => draft.items.length)).toEqual([64, 80, 120]);
    expect(result.drafts.find((draft) => draft.trackId === "dsa")?.items.every(
      (item) => item.languageContext === "dsa:python",
    )).toBe(true);
  });

  it("keeps every track dependency before its consumer", () => {
    const result = buildLearningPlan(runtime[0], runtime[1], runtime[2], ["react"]);
    const positions = new Map(result.resolvedTrackIds.map((trackId, index) => [trackId, index]));

    expect(new Set(result.resolvedTrackIds)).toEqual(
      new Set(["programming-foundations", "html", "css", "javascript", "react"]),
    );
    for (const draft of result.drafts) {
      for (const prerequisite of draft.prerequisiteTrackIds) {
        expect(positions.get(prerequisite)).toBeLessThan(positions.get(draft.trackId)!);
      }
    }
  });

  it("emits diagnostics before learning items without deriving placement from self-report", () => {
    const result = buildLearningPlan(
      runtime[0],
      runtime[1],
      runtime[2],
      ["programming-foundations"],
    );
    const items = result.drafts[0]!.items;

    expect(items).toHaveLength(64);
    for (let index = 0; index < items.length; index += 2) {
      expect(items[index]).toMatchObject({ kind: "diagnostic", skillId: items[index + 1]!.skillId });
      expect(items[index + 1]?.kind).toBe("learn");
    }
    expect(items.every((item) => item.schemaVersion === 1)).toBe(true);
  });

  it("builds a language-switch revision with syntax retests only for implementation evidence", () => {
    const result = buildLearningPlan(runtime[0], runtime[1], runtime[2], ["dsa"], "C++");
    const base = result.drafts.find((draft) => draft.trackId === "dsa")!;
    const switched = buildDsaLanguageRetestDraft(base, "Java");
    const retests = switched.items.filter((item) => item.kind === "syntax_retest");

    expect(switched.implementationLanguage).toBe("Java");
    expect(retests.length).toBeGreaterThan(0);
    expect(retests.length).toBeLessThan(60);
    expect(retests.every((item) => item.languageContext === "dsa:java")).toBe(true);
    expect(retests.every((item) => item.goalPriority > 100)).toBe(true);
    for (const item of retests) {
      expect(isLanguageSpecificDsaSkill(runtime[1].skillById.get(item.skillId)!)).toBe(true);
    }
  });

  it("normalizes supported DSA language labels and rejects unknown tracks", () => {
    expect(normalizeDsaLanguage("cpp")).toBe("C++");
    expect(normalizeDsaLanguage("PY")).toBe("Python");
    expect(normalizeDsaLanguage("Ruby")).toBeNull();
    expect(() => buildLearningPlan(runtime[0], runtime[1], runtime[2], ["ruby"])).toThrow(
      /unknown selected track/i,
    );
    expect(() => buildLearningPlan(runtime[0], runtime[1], runtime[2], ["python", "python"]))
      .toThrow(/duplicate selected track/i);
  });

  it.each([
    ["C", "c"],
    ["C++", "cpp"],
    ["Java", "java"],
    ["Python", "python"],
  ] as const)("maps the canonical DSA language %s to runner slug %s", (language, runnerSlug) => {
    expect(dsaRunnerLanguage(language)).toBe(runnerSlug);
  });

  it("is deterministic for identical authored content and choices", () => {
    const first = buildLearningPlan(runtime[0], runtime[1], runtime[2], ["ai"], "Python");
    const second = buildLearningPlan(runtime[0], runtime[1], runtime[2], ["ai"], "Python");
    expect(second).toEqual(first);
  });
});
