import { describe, expect, it } from "vitest";

import {
  manifestDigestMap,
  syncAssessmentBankRuntimePins,
  syncAssessmentBankRuntimePinText,
  syncPinnedCurriculumRuntimeSource,
} from "./curriculum-runtime-pin-sync";

const digest = (character: string) => `sha256:${character.repeat(64)}`;
const digests = { c: digest("a"), cpp: digest("b"), java: digest("c"), javascript: digest("d"), python: digest("e") } as const;

describe("curriculum runtime pin sync", () => {
  it("updates only isolated-runner code items and reports language coverage", () => {
    const source = { items: [
      { kind: "code", runtime: { engine: "isolated-runner", language: "python", imageDigest: digest("f") }, title: "keep" },
      { kind: "code", runtime: { engine: "browser", language: "javascript" } },
      { kind: "mcq", runtime: { engine: "isolated-runner", language: "c", imageDigest: digest("f") } },
    ] };
    const result = syncAssessmentBankRuntimePins(source, digests);
    expect(result.changed).toBe(true);
    expect(result.matchedByLanguage.python).toBe(1);
    expect(result.matchedByLanguage.c).toBe(0);
    expect(result.value).toEqual({ items: [
      { kind: "code", runtime: { engine: "isolated-runner", language: "python", imageDigest: digests.python }, title: "keep" },
      source.items[1], source.items[2],
    ] });
    expect(source.items[0]!.runtime.imageDigest).toBe(digest("f"));
  });

  it("changes only digest bytes in a compact CRLF-authored bank", () => {
    const old = digest("f");
    const source = `{\r\n "format":"assessment-bank", "items":[{\r\n  "kind":"code", "runtime":{ "engine":"isolated-runner", "language":"python", "imageDigest":"${old}" }, "title":"keep  spacing"\r\n }]\r\n}\r\n`;
    const expected = source.replace(old, digests.python);
    const result = syncAssessmentBankRuntimePinText(source, digests);
    expect(result.value).toBe(expected);
    expect(result.changed).toBe(true);
    expect(result.matchedByLanguage.python).toBe(1);
    expect(syncAssessmentBankRuntimePinText(expected, digests)).toMatchObject({ value: expected, changed: false });
  });

  it("is idempotent and fails closed on invalid isolated-runner metadata", () => {
    expect(syncAssessmentBankRuntimePins({ items: [
      { kind: "code", runtime: { engine: "isolated-runner", language: "c", imageDigest: digests.c } },
    ] }, digests).changed).toBe(false);
    expect(() => syncAssessmentBankRuntimePins({ items: [
      { kind: "code", runtime: { engine: "isolated-runner", language: "ruby", imageDigest: digest("f") } },
    ] }, digests)).toThrow(/unsupported isolated-runner language.*ruby/i);
  });

  it("updates the two generator constants exactly once and is idempotent", () => {
    const source = `export const X = {\n  java: {\n    imageDigest: "${digest("f")}",\n  },\n  python: {\n    imageDigest: "${digest("f")}",\n  },\n};\n`;
    const first = syncPinnedCurriculumRuntimeSource(source, digests);
    expect(first.changed).toBe(true);
    expect(first.value).toContain(digests.java);
    expect(first.value).toContain(digests.python);
    expect(syncPinnedCurriculumRuntimeSource(first.value, digests).changed).toBe(false);
  });

  it("projects every validated manifest digest by language", () => {
    const records = Object.entries(digests).map(([id, manifestDigest], index) => ({
      id, tag: `learncoding/runtime-${id}:local`, manifestDigest,
      configDigest: digest(String(index + 1)), reference: `learncoding/runtime-${id}@${manifestDigest}`,
    }));
    expect(manifestDigestMap(records as never)).toEqual(digests);
  });
});
