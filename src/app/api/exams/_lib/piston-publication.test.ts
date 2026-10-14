import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ admit: vi.fn(), begin: vi.fn(), settle: vi.fn(), record: vi.fn() }));
vi.mock("@/lib/db/client", () => ({ db: {}, pool: {} }));
vi.mock("@/lib/runner/admission", async (original) => ({
  ...await original<typeof import("@/lib/runner/admission")>(),
  admitRunnerJob: mocks.admit, beginRunnerDispatch: mocks.begin,
  settleRunnerJob: mocks.settle, recordRunnerDispatch: mocks.record,
}));

import { ContentRepository, type AssessmentBank, type CourseManifest, type CourseModule } from "@/lib/content";
import { PISTON_EXAM_PIN_REVISION, pistonExamImageDigest, publishedExamPinRevision, retainEquivalentExamRuntimePins } from "@/lib/exams/piston-publication-pins";
import type { ExamFormSnapshot } from "@/lib/exams/contracts";
import { runtimeByLanguage, type RunnerLanguage } from "@/lib/runner/client";
import { PISTON_RUNTIMES } from "@/lib/runner/piston-client";
import { configuredExamRunnerClient, pinnedPistonImageDigest } from "@/lib/runner/exam-client";
import legacyPins from "../../../../../scripts/curriculum-runtime-pins.json";
import { languages, outcomes, score, tests, transport, withNativeRunnerBaseline, verdict } from "../../../../../scripts/lib/provider-parity-fixtures";
import { buildEquivalentExamForm, verifyEquivalentFormParity } from "./blueprint";
import { executeExamCode } from "./service";

// Any digest-pinned deployment: the pin follows the running PISTON_IMAGE.
const DEPLOYED = `sha256:${"d".repeat(64)}`;

let course: CourseManifest;
let courseModule: CourseModule;
let bank: AssessmentBank;
beforeAll(async () => {
  const repository = new ContentRepository();
  course = (await repository.getCourse("programming-foundations"))!;
  const state = (await repository.getModule("pf.state"))!;
  courseModule = { ...state, skills: state.skills.filter((skill) => skill.id === "pf.state.variables") };
  bank = (await repository.listAssessmentBanks({ skillId: "pf.state.variables" }))[0]!;
});
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("PISTON_IMAGE", `codestead-piston@${DEPLOYED}`);
  mocks.admit.mockResolvedValue({ submissionId: "submission", runnerJobId: "job", userId: "learner",
    requestId: "request", requestHash: "a".repeat(64), submissionType: "exam_final_test", status: "queued",
    remoteJobId: null, result: null, runtimeImageDigest: "pending", queuedAt: new Date(), duplicate: false });
  mocks.begin.mockResolvedValue({ replayed: false, remoteJobId: null });
  mocks.settle.mockResolvedValue({ replayed: false });
  mocks.record.mockResolvedValue({ replayed: false });
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

function reviewedBank(language: RunnerLanguage): AssessmentBank {
  const code = bank.items.find((item) => item.kind === "code")!;
  if (code.kind !== "code" || code.runtime.engine !== "isolated-runner") throw new Error("Missing code fixture");
  return { ...bank, publication: { ...bank.publication, stage: "approved", reviewer: {
    id: "test-human", displayName: "Test Human", kind: "human", reviewedAt: "2026-10-03T00:00:00Z", reviewVersion: "1.0.0",
  } }, items: [{ ...code,
    tests: tests.map((test) => ({ ...test, category: test.critical ? "boundary" : "normal", visibility: test.visibility === "HIDDEN" ? "hidden" : "visible",
      comparison: test.comparison === "EXACT" ? "exact" : "trimmed" })),
    runtime: { ...code.runtime, language, version: runtimeByLanguage[language].version,
      imageDigest: legacyPins.records.find((pin) => pin.language === language)!.digest },
    examEligibility: { eligible: true, rationale: "Human reviewed deterministic publication migration fixture." },
  }] };
}

function form(source: AssessmentBank, piston = false): ExamFormSnapshot {
  return buildEquivalentExamForm({ course, module: courseModule, catalogVersion: "published:reviewed-version",
    assessmentBanks: [source], runtimePinRevision: piston ? PISTON_EXAM_PIN_REVISION : undefined });
}

function execute(snapshot: ExamFormSnapshot) {
  const item = snapshot.items[0]!;
  if (!item.runtime || item.gradingEvidence.kind !== "runner-tests") throw new Error("Missing runner pins");
  return executeExamCode({ userId: "learner", attemptId: snapshot.formId, sessionId: "session", itemId: item.id,
    language: item.language as RunnerLanguage, sourceCode: "source", mode: "TEST",
    tests: item.gradingEvidence.tests.map(({ id, visibility, category, stdin, expectedStdout, comparison }) =>
      ({ id, visibility, category, stdin, expectedStdout, comparison })),
    testBundleVersion: item.gradingEvidence.bundleVersion, expectedRuntimeVersion: item.runtime.version,
    expectedRuntimeImageDigest: item.runtime.imageDigest, idempotencySeed: "finalization", submissionType: "exam_final_test" });
}

describe("reviewed published exam pin migration", () => {
  for (const provider of ["piston"] as const) {
    it.each(languages)(`${provider}: %s new published forms keep the selected pins and grade successfully`, async (language) => {
      const source = reviewedBank(language);
      const legacyRuntime = source.items[0]!.kind === "code" ? source.items[0]!.runtime : undefined;
      if (!legacyRuntime || legacyRuntime.engine !== "isolated-runner" || !legacyRuntime.imageDigest) throw new Error("Missing fixture pin");
      const fetch = transport(provider, "accepted", undefined,
        provider === "piston" ? DEPLOYED : legacyRuntime.imageDigest);
      vi.stubEnv("PISTON_IMAGE", `codestead-piston@${DEPLOYED}`);
      const snapshot = buildEquivalentExamForm({ course, module: courseModule,
        catalogVersion: "published:reviewed-version", assessmentBanks: [source],
        runtimePinRevision: publishedExamPinRevision() });
      expect(snapshot.items[0]!.runtime).toEqual({ version: PISTON_RUNTIMES[language].label, imageDigest: DEPLOYED });
      expect(source.items[0]!.kind === "code" && source.items[0]!.runtime).toEqual(legacyRuntime);
      const result = await execute(snapshot);
      expect(result.status).toBe("ACCEPTED");
      expect(score(result, language).officialScorePercent).toBe(100);
      expect(fetch.mock.calls.every(([url]) => String(url).startsWith(`http://${provider}:`))).toBe(true);
    });
  }

  for (const language of languages) {
    it.each(outcomes)(`${language} %s: new Piston forms and immutable legacy attempts retain identical grading`, async (outcome) => {
      const source = reviewedBank(language);
      const sourceBefore = JSON.stringify(source);
      const legacy = form(source);
      const legacyBefore = JSON.stringify(legacy);
      const piston = form(source, true);
      expect(piston.items[0]!.runtime).toEqual({ version: PISTON_RUNTIMES[language].label, imageDigest: DEPLOYED });
      expect(piston.items[0]!.gradingEvidence).toEqual(legacy.items[0]!.gradingEvidence);
      expect(JSON.stringify(source)).toBe(sourceBefore);

      transport("legacy", outcome, undefined, legacy.items[0]!.runtime!.imageDigest);
      const original = await withNativeRunnerBaseline(() => execute(legacy));
      const pistonFetch = transport("piston", outcome, undefined, DEPLOYED);
      vi.stubEnv("PISTON_IMAGE", `codestead-piston@${DEPLOYED}`);
      const migrated = await execute(piston);
      expect(verdict(migrated)).toEqual(verdict(original));
      expect(score(migrated, language)).toEqual(score(original, language));
      expect(score(migrated, language).officialScorePercent).toBe(outcome === "accepted" ? 100 : outcome === "wrong_answer" ? 50 : 0);
      expect(pistonFetch.mock.calls.every(([url]) => String(url).startsWith("http://piston:"))).toBe(true);

      const legacyFetch = transport("piston", outcome, undefined, legacy.items[0]!.runtime!.imageDigest);
      await expect(execute(legacy)).rejects.toMatchObject({ code: "RUNNER_RUNTIME_RETIRED" });
      expect(legacyFetch).not.toHaveBeenCalled();
      expect(JSON.stringify(legacy)).toBe(legacyBefore);
    });
  }

  it("preserves exact runtime parity for legacy retakes and rechecks across either rollout direction", () => {
    const source = reviewedBank("python");
    const legacy = form(source);
    const piston = form(source, true);
    expect(verifyEquivalentFormParity(legacy, piston).equivalent).toBe(false);
    const retained = retainEquivalentExamRuntimePins(legacy, piston);
    expect(verifyEquivalentFormParity(legacy, retained).equivalent).toBe(true);
    expect(retained.items[0]!.runtime).toEqual(legacy.items[0]!.runtime);
    expect(verifyEquivalentFormParity(piston, retainEquivalentExamRuntimePins(piston, form(source))).equivalent).toBe(true);
    const modified = { ...piston, items: piston.items.map((item) => ({ ...item, points: item.points + 1 })) };
    expect(verifyEquivalentFormParity(legacy, retainEquivalentExamRuntimePins(legacy, modified)).equivalent).toBe(false);
  });

  it("rejects unreviewed image pins rather than silently adopting the new runtime", () => {
    const source = reviewedBank("python");
    const code = source.items[0]!;
    if (code.kind !== "code" || code.runtime.engine !== "isolated-runner") throw new Error("Code required");
    const unknown = { ...source, items: [{ ...code, runtime: { ...code.runtime, imageDigest: `sha256:${"f".repeat(64)}` } }] };
    expect(() => form(unknown, true)).toThrow("outside the reviewed runtime pin migration");
    expect(() => buildEquivalentExamForm({ course, module: courseModule, catalogVersion: "filesystem",
      assessmentBanks: [source], runtimePinRevision: PISTON_EXAM_PIN_REVISION })).toThrow("reviewed publication");
  });

  it("requires explicit Piston rollout and a digest-pinned deployed image before new forms can use the revision", () => {
    vi.stubEnv("CODE_RUNNER_PROVIDER", "legacy");
    vi.stubEnv("PISTON_IMAGE", "");
    expect(() => publishedExamPinRevision()).toThrow("must be piston");
    vi.stubEnv("CODE_RUNNER_PROVIDER", "piston");
    vi.stubEnv("PISTON_URL", "http://piston:2000");
    for (const image of ["", "codestead-piston:latest", "codestead-piston@sha256:short"]) {
      vi.stubEnv("PISTON_IMAGE", image);
      expect(() => publishedExamPinRevision()).toThrow("pinned image manifest");
      expect(() => pistonExamImageDigest()).toThrow("pinned image manifest");
    }
    for (const digest of [DEPLOYED, `sha256:${"e".repeat(64)}`]) {
      vi.stubEnv("PISTON_IMAGE", `codestead-piston@${digest}`);
      expect(publishedExamPinRevision()).toBe(PISTON_EXAM_PIN_REVISION);
      expect(pistonExamImageDigest()).toBe(digest);
    }
    vi.stubEnv("PISTON_URL", "");
    expect(() => publishedExamPinRevision()).toThrow("configured endpoint");
    vi.stubEnv("CODE_RUNNER_PROVIDER", "unknown");
    expect(() => publishedExamPinRevision()).toThrow("must be piston");
  });

  it("pins new forms to whichever image is deployed and fails closed without one", () => {
    const source = reviewedBank("python");
    const other = `sha256:${"e".repeat(64)}`;
    vi.stubEnv("PISTON_IMAGE", `codestead-piston@${other}`);
    expect(form(source, true).items[0]!.runtime!.imageDigest).toBe(other);
    vi.stubEnv("PISTON_IMAGE", "");
    expect(() => form(source, true)).toThrow("pinned image manifest");
  });

  it("keeps a stored Piston pin from an earlier deployment when a retake is built on legacy", () => {
    const source = reviewedBank("python");
    const piston = form(source, true);
    vi.stubEnv("PISTON_IMAGE", `codestead-piston@sha256:${"e".repeat(64)}`);
    const retained = retainEquivalentExamRuntimePins(piston, form(source));
    expect(retained.items[0]!.runtime).toEqual(piston.items[0]!.runtime);
  });

  it("rejects malformed image references and unknown pinned Piston labels without a provider switch", () => {
    for (const image of ["codestead-piston:latest", `codestead@extra@${DEPLOYED}`, "sha256:short"]) {
      expect(() => pinnedPistonImageDigest(image)).toThrow("pinned image manifest");
    }
    expect(() => configuredExamRunnerClient({ language: "python", expectedRuntimeVersion: "Python unknown (Piston)" }))
      .toThrow("unsupported or retired");
  });
});
