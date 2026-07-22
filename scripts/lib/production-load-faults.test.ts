import { describe, expect, it } from "vitest";

import { PRODUCTION_LOAD_FAULT_MATRIX } from "../../src/lib/performance/load-report";
import {
  runProductionFaultMatrix,
  type ProductionFaultAdapter,
  type ProductionFaultProbe,
} from "./production-load-faults";

const healthyProbe: ProductionFaultProbe = {
  componentHealthy: true,
  queueDepth: 0,
  alertOrDeadLetterVisible: true,
  unrelatedServicesHealthy: true,
  runnerRunningJobs: 2,
};

describe("production fault matrix orchestrator", () => {
  it("runs all fifteen project-scoped faults in the frozen order and timing windows", async () => {
    let now = Date.parse("2026-07-19T14:00:00.000Z");
    let releasedAt = now;
    const events: string[] = [];
    const adapter: ProductionFaultAdapter = {
      reset: async (fault) => {
        events.push(`reset:${fault.id}`);
      },
      probe: async (fault, phase) => {
        if (phase === "baseline") return healthyProbe;
        const elapsed = now - releasedAt;
        return {
          ...healthyProbe,
          componentHealthy: elapsed >= 15_000,
          queueDepth: elapsed >= 20_000 ? 0 : 3,
        };
      },
      runAuthenticatedBrowserJourney: async (fault, stage) => {
        events.push(`browser:${stage}:${fault.id}`);
      },
      injectAndRelease: async (fault) => {
        events.push(`inject:${fault.id}`);
        now += 30_000;
        releasedAt = now;
      },
      verifyInvariants: async () => ({
        acknowledgedMutationFailures: 0,
        duplicateOfficialEffects: 0,
        secretLeakFindings: 0,
        runnerMaxConcurrentJobs: 2,
      }),
    };

    const result = await runProductionFaultMatrix({
      scope: "codestead-project-only",
      clock: {
        now: () => now,
        waitUntil: async (target) => {
          expect(target).toBeGreaterThanOrEqual(now);
          now = target;
        },
      },
      adapter,
    });

    expect(result.startedAt).toBe("2026-07-19T14:00:00.000Z");
    expect(result.completedAt).toBe("2026-07-19T16:22:30.000Z");
    expect(result.cases).toHaveLength(15);
    expect(result.cases.map((entry) => entry.faultId)).toEqual(
      PRODUCTION_LOAD_FAULT_MATRIX.map((fault) => fault.id),
    );
    for (const entry of result.cases) {
      expect(entry).toMatchObject({
        passed: true,
        healthyBaselineMs: 120_000,
        baselineSamples: 24,
        faultDurationMs: 30_000,
        componentRecoveryMs: 15_000,
        queueDrainMs: 20_000,
        alertOrDeadLetterVisibilityMs: 30_000,
        invariantCheckMs: 120_000,
        steadyBrowserJourneyPassed: true,
        recoveredBrowserJourneyPassed: true,
        invariants: {
          acknowledgedMutationFailures: 0,
          duplicateOfficialEffects: 0,
          secretLeakFindings: 0,
          runnerMaxConcurrentJobs: 2,
        },
      });
    }
    expect(events.filter((event) => event.startsWith("reset:"))).toEqual(
      PRODUCTION_LOAD_FAULT_MATRIX.map((fault) => `reset:${fault.id}`),
    );
    expect(events.indexOf("reset:app_container_restart")).toBeGreaterThan(
      events.indexOf("browser:recovered:runner_service_restart"),
    );
    expect(JSON.stringify(result)).not.toMatch(/password|token|cookie|authorization/i);
  });

  it("fails closed on a fault held beyond sixty seconds and stops the matrix", async () => {
    let now = Date.parse("2026-07-19T14:00:00.000Z");
    const injected: string[] = [];
    const adapter: ProductionFaultAdapter = {
      reset: async () => undefined,
      probe: async () => healthyProbe,
      runAuthenticatedBrowserJourney: async () => undefined,
      injectAndRelease: async (fault) => {
        injected.push(fault.id);
        now += 60_001;
      },
      verifyInvariants: async () => ({
        acknowledgedMutationFailures: 0,
        duplicateOfficialEffects: 0,
        secretLeakFindings: 0,
        runnerMaxConcurrentJobs: 2,
      }),
    };

    await expect(runProductionFaultMatrix({
      scope: "codestead-project-only",
      clock: {
        now: () => now,
        waitUntil: async (target) => { now = target; },
      },
      adapter,
    })).rejects.toThrow(/fault_duration_exceeded:runner_service_restart/);
    expect(injected).toEqual(["runner_service_restart"]);
  });

  it("fails closed on baseline safety regression or authoritative invariant damage", async () => {
    let now = Date.parse("2026-07-19T14:00:00.000Z");
    await expect(runProductionFaultMatrix({
      scope: "codestead-project-only",
      clock: {
        now: () => now,
        waitUntil: async (target) => { now = target; },
      },
      adapter: {
        reset: async () => undefined,
        probe: async () => ({ ...healthyProbe, unrelatedServicesHealthy: false }),
        runAuthenticatedBrowserJourney: async () => undefined,
        injectAndRelease: async () => undefined,
        verifyInvariants: async () => ({
          acknowledgedMutationFailures: 0,
          duplicateOfficialEffects: 0,
          secretLeakFindings: 0,
          runnerMaxConcurrentJobs: 2,
        }),
      },
    })).rejects.toThrow(/unrelated_service_regression:runner_service_restart/);

    now = Date.parse("2026-07-19T14:00:00.000Z");
    await expect(runProductionFaultMatrix({
      scope: "codestead-project-only",
      clock: {
        now: () => now,
        waitUntil: async (target) => { now = target; },
      },
      adapter: {
        reset: async () => undefined,
        probe: async () => healthyProbe,
        runAuthenticatedBrowserJourney: async () => undefined,
        injectAndRelease: async () => undefined,
        verifyInvariants: async () => ({
          acknowledgedMutationFailures: 0,
          duplicateOfficialEffects: 1,
          secretLeakFindings: 0,
          runnerMaxConcurrentJobs: 2,
        }),
      },
    })).rejects.toThrow(/duplicate_official_effect:runner_service_restart/);
  });
});
