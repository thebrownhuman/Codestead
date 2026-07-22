import { describe, expect, it, vi } from "vitest";

import type { ProductionLoadDisposableFixtureTopology } from
  "./production-load-disposable-runtime";
import {
  PRODUCTION_LOAD_DISPOSABLE_FAULTS,
  runProductionLoadDisposableLifecycle,
} from "./production-load-disposable-lifecycle";

const learners = Array.from(
  { length: 10 },
  (_, index) => `load-learner-${String(index + 1).padStart(2, "0")}`,
);

function topology(overrides: Partial<ProductionLoadDisposableFixtureTopology> = {}) {
  return {
    readinessEvidence: vi.fn(async () => ({
      postgresRoundTrip: true,
      providerStatuses: { gmail: 204, ai: 204, drive: 204 } as const,
      authenticatedLearnerIds: learners,
      runnerMaxConcurrentJobs: 2,
      runnerQueuedJobsObserved: 2,
    })),
    reset: vi.fn(async () => undefined),
    injectAndRelease: vi.fn(async () => undefined),
    probe: vi.fn(async (_faultId, phase) => ({
      componentHealthy: true,
      alertOrDeadLetterVisible: phase === "recovery",
    })),
    browserJourney: vi.fn(async () => undefined),
    invariantEvidence: vi.fn(async () => ({
      acknowledgedMutationFailures: 0,
      runnerMaxConcurrentJobs: 2,
      secretLeakFindings: 0,
    })),
    close: vi.fn(async () => undefined),
    ...overrides,
  } satisfies ProductionLoadDisposableFixtureTopology;
}

describe("production load disposable lifecycle proof", () => {
  it("runs all seven faults after real ten-learner and two-slot readiness", async () => {
    const fixture = topology();
    const receipt = await runProductionLoadDisposableLifecycle({
      topology: fixture,
      now: () => new Date("2026-07-20T12:00:00.000Z"),
    });

    expect(receipt).toEqual({
      schemaVersion: 1,
      profile: "codestead-production-load-disposable-lifecycle-v1",
      generatedAt: "2026-07-20T12:00:00.000Z",
      readiness: {
        postgresRoundTrip: true,
        providerStatuses: { gmail: 204, ai: 204, drive: 204 },
        authenticatedLearnerCount: 10,
        authenticatedLearnerSetSha256:
          "sha256:f122b8a5546574f39d920d14f7b2a29d3c55f84321706c99e00ea1655ff7c11d",
        runnerMaxConcurrentJobs: 2,
        runnerQueuedJobsObserved: 2,
      },
      faults: PRODUCTION_LOAD_DISPOSABLE_FAULTS.map((faultId) => ({
        faultId,
        baselineHealthy: true,
        baselineAlertVisible: false,
        recoveryHealthy: true,
        recoveryAlertVisible: true,
        authenticatedJourneySteady: true,
        authenticatedJourneyRecovered: true,
        authenticatedJourneyLearnerCount: 10,
        acknowledgedMutationFailures: 0,
        runnerMaxConcurrentJobs: 2,
        secretLeakFindings: 0,
      })),
    });
    for (const faultId of PRODUCTION_LOAD_DISPOSABLE_FAULTS) {
      expect(fixture.reset).toHaveBeenCalledWith(faultId, expect.any(AbortSignal));
      expect(fixture.injectAndRelease).toHaveBeenCalledWith(
        faultId, expect.any(AbortSignal),
      );
      expect(fixture.probe).toHaveBeenCalledWith(
        faultId, "baseline", expect.any(AbortSignal),
      );
      expect(fixture.probe).toHaveBeenCalledWith(
        faultId, "recovery", expect.any(AbortSignal),
      );
      expect(fixture.browserJourney).toHaveBeenCalledWith(
        faultId, "steady", expect.any(AbortSignal),
      );
      expect(fixture.browserJourney).toHaveBeenCalledWith(
        faultId, "recovered", expect.any(AbortSignal),
      );
    }
  });

  it("fails closed when readiness, recovery, or timestamp evidence is fabricated", async () => {
    await expect(runProductionLoadDisposableLifecycle({
      topology: topology({
        readinessEvidence: vi.fn(async () => ({
          postgresRoundTrip: true,
          providerStatuses: { gmail: 204, ai: 204, drive: 204 },
          authenticatedLearnerIds: learners.slice(0, 9),
          runnerMaxConcurrentJobs: 2,
          runnerQueuedJobsObserved: 2,
        })),
      }),
    })).rejects.toThrow("invalid_readiness_evidence");

    await expect(runProductionLoadDisposableLifecycle({
      topology: topology({
        probe: vi.fn(async (_faultId, phase) => ({
          componentHealthy: phase === "baseline",
          alertOrDeadLetterVisible: phase === "recovery",
        })),
      }),
    })).rejects.toThrow("invalid_recovery_evidence");

    await expect(runProductionLoadDisposableLifecycle({
      topology: topology(),
      now: () => new Date(Number.NaN),
    })).rejects.toThrow("invalid_timestamp");
  });
});
