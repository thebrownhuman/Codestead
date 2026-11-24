import { describe, expect, it } from "vitest";

import {
  examFinalizationRetryDelayMs,
  isExamFinalizationTerminal,
  MAX_EXAM_FINALIZATION_ATTEMPTS,
} from "./finalization-worker-policy";

describe("exam finalization worker policy", () => {
  it("uses bounded deterministic exponential retry delays", () => {
    expect(examFinalizationRetryDelayMs(1)).toBe(5_000);
    expect(examFinalizationRetryDelayMs(2)).toBe(10_000);
    expect(examFinalizationRetryDelayMs(8)).toBe(600_000);
    expect(examFinalizationRetryDelayMs(100)).toBe(600_000);
  });

  it("never returns a zero or negative retry for recovered rows", () => {
    expect(examFinalizationRetryDelayMs(0)).toBe(5_000);
    expect(examFinalizationRetryDelayMs(-5)).toBe(5_000);
  });
});

describe("exam finalization terminal decision", () => {
  it("retries an indeterminate runner without bumping the generation, but not forever", () => {
    expect(isExamFinalizationTerminal({ errorCode: "RUNNER_INDETERMINATE", attemptCount: 1, runnerRequestGeneration: 0 })).toBe(false);
    expect(isExamFinalizationTerminal({
      errorCode: "RUNNER_INDETERMINATE",
      attemptCount: MAX_EXAM_FINALIZATION_ATTEMPTS,
      runnerRequestGeneration: 0,
    })).toBe(true);
  });

  it("stops other errors once the runner generation budget is spent", () => {
    expect(isExamFinalizationTerminal({ errorCode: "RUNNER_FAILED", attemptCount: 3, runnerRequestGeneration: 9 })).toBe(false);
    expect(isExamFinalizationTerminal({ errorCode: "RUNNER_FAILED", attemptCount: 3, runnerRequestGeneration: 10 })).toBe(true);
    expect(isExamFinalizationTerminal({ errorCode: "LEARNER_NOT_ACTIVE", attemptCount: 1, runnerRequestGeneration: 0 })).toBe(true);
  });
});
