import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ admit: vi.fn(), begin: vi.fn(), settle: vi.fn(), record: vi.fn() }));
vi.mock("@/lib/db/client", () => ({ pool: {}, db: {} }));
vi.mock("@/lib/runner/admission", async (original) => ({
  ...await original<typeof import("@/lib/runner/admission")>(),
  admitRunnerJob: mocks.admit, beginRunnerDispatch: mocks.begin,
  settleRunnerJob: mocks.settle, recordRunnerDispatch: mocks.record,
}));

import { configuredRegradeExecutor } from "../runner-executor";
import type { RunnerRequest } from "@/lib/runner/client";
import { IMAGE, languages, outcomes, score, tests, transport, withNativeRunnerBaseline, verdict, version } from "../../../../scripts/lib/provider-parity-fixtures";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.admit.mockResolvedValue({ submissionId: "submission", runnerJobId: "job", userId: "learner",
    requestId: "request", requestHash: "a".repeat(64), status: "queued", remoteJobId: null, result: null, duplicate: false });
  mocks.begin.mockResolvedValue({ replayed: false, remoteJobId: null });
  mocks.settle.mockResolvedValue({ replayed: false });
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

function input(provider: string, language: typeof languages[number]) {
  return { jobId: "job", jobAttemptCount: 0, runnerRequestGeneration: 1, correctionId: "correction",
    attemptId: "attempt", userId: "learner", itemId: "item", language, sourceCode: "source",
    expectedRuntimeVersion: version(provider, language), expectedRuntimeImageDigest: IMAGE,
    evidence: { kind: "runner-tests" as const, bundleVersion: "v1", tests } };
}

describe("grading correction provider parity", () => {
  for (const language of languages) {
    it.each(outcomes)(`${language} %s retains corrected verdicts and official scores`, async (outcome) => {
      transport("legacy", outcome);
      const legacy = await withNativeRunnerBaseline(() => configuredRegradeExecutor.execute(input("legacy", language)));
      const fetch = transport("piston", outcome);
      const piston = await configuredRegradeExecutor.execute(input("piston", language));
      expect(verdict(piston)).toEqual(verdict(legacy));
      expect(score(piston, language)).toEqual(score(legacy, language));
      expect(score(piston, language).officialScorePercent).toBe(outcome === "accepted" ? 100 : outcome === "wrong_answer" ? 50 : 0);
      expect(piston.testBundleVersion).toBe("v1");
      expect(fetch.mock.calls.every(([url]) => String(url).startsWith("http://piston:"))).toBe(true);
    });
  }

  it("rejects unsupported legacy correction pins before admission or execution", async () => {
    const fetch = transport("piston", "accepted");
    await expect(configuredRegradeExecutor.execute(input("legacy", "c")))
      .rejects.toMatchObject({ code: "RUNNER_RUNTIME_RETIRED" });
    expect(fetch).not.toHaveBeenCalled();
    expect(mocks.admit).not.toHaveBeenCalled();
  });

  it.each(["piston", "unknown"])("%s configuration errors do not use legacy", async (provider) => {
    const fetch = transport(provider, "accepted");
    vi.stubEnv(provider === "piston" ? "PISTON_URL" : "RUNNER_BASE_URL", "");
    await expect(configuredRegradeExecutor.execute(input(provider, "c")))
      .rejects.toMatchObject({ code: provider === "unknown" ? "RUNNER_RUNTIME_RETIRED" : "RUNNER_INFRASTRUCTURE_FAILURE" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["piston"])("%s still rejects correction evidence for another image digest", async (provider) => {
    transport(provider, "accepted");
    await expect(configuredRegradeExecutor.execute({ ...input(provider, "c"), expectedRuntimeImageDigest: `sha256:${"f".repeat(64)}` }))
      .rejects.toMatchObject({ code: "RUNNER_INFRASTRUCTURE_FAILURE" });
    expect(mocks.settle).toHaveBeenCalledWith(expect.objectContaining({ status: "failed" }));
  });

  it("never resumes a legacy correction job through Piston", async () => {
    mocks.begin.mockResolvedValue({ replayed: false, remoteJobId: "legacy-job" });
    const fetch = transport("piston", "accepted");
    await expect(configuredRegradeExecutor.execute(input("legacy", "python")))
      .rejects.toMatchObject({ code: "RUNNER_RUNTIME_RETIRED" });
    expect(fetch).not.toHaveBeenCalled();
    expect(mocks.begin).not.toHaveBeenCalled();
  });

});
