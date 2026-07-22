import { describe, expect, it } from "vitest";

import {
  PRODUCTION_LOAD_FAULT_MATRIX,
  buildProductionLoadActions,
  buildProductionLoadSchedule,
  type ProductionLoadCandidate,
  type ProductionLoadResourceBaseline,
} from "../../src/lib/performance/load-report";
import type { ProductionFaultMatrixResult } from "./production-load-faults";
import {
  buildProductionLoadGateReport,
} from "./production-load-reporting";
import type {
  ProductionLoadActionObservation,
  ProductionLoadResourceObservation,
  ProductionLoadWorkloadResult,
} from "./production-load-workload";

const startedAtMs = Date.parse("2026-07-19T12:00:00.000Z");

function buildPassingWorkload(): ProductionLoadWorkloadResult {
  const schedule = buildProductionLoadSchedule();
  const actions: ProductionLoadActionObservation[] = buildProductionLoadActions(schedule).map((action) => ({
    requestId: action.requestId,
    kind: action.kind,
    phase: action.phase,
    durationMs: action.kind === "code_job" ? 150 : 25,
    ok: true,
    status: action.kind === "code_job" ? 202 : 200,
    acknowledged: true,
    duplicateOfficialEffects: 0,
    httpRequests: Array.from({
      length: action.kind === "review_completion" || action.kind === "quiz_completion" ? 2 : 1,
    }, (_, sequence) => {
      const mutation = action.kind !== "lesson_read" && action.kind !== "dashboard_read";
      return {
        sequence,
        method: mutation ? "POST" as const : "GET" as const,
        route: `/synthetic/${action.kind}/${sequence}`,
        durationMs: 10,
        status: action.kind === "code_job" ? 202 : 200,
        ok: true,
        timedOut: false,
        mutation,
        acknowledged: mutation,
      };
    }),
    ...(action.kind === "code_job"
      ? { runnerAdmissionMs: 100, runnerQueueWaitMs: 500 }
      : {}),
  }));
  const resourceSamples: ProductionLoadResourceObservation[] = Array.from(
    { length: 960 },
    (_, sampleIndex) => {
      const minute = schedule.minutes[Math.floor(sampleIndex / 12)]!;
      const scheduledOffsetMs = sampleIndex * 5_000;
      return {
        sampleIndex,
        scheduledOffsetMs,
        observedAt: new Date(startedAtMs + scheduledOffsetMs).toISOString(),
        phase: minute.phase,
        phaseMinute: minute.phaseMinute,
        hostCpuPercent: 35,
        availableMemoryBytes: 16 * 1024 ** 3,
        rootFreeFraction: 0.5,
        rootFreeBytes: 400 * 1024 ** 3,
        diskReadBytes: sampleIndex * 1_000,
        diskWriteBytes: sampleIndex * 2_000,
        postgresConnections: 10,
        postgresMaxConnections: 100,
        postgresDeadlocks: 5,
        postgresLockWaitMs: 2,
        temperatureCelsius: 60,
        oomKills: 3,
        thermalThrottleIncrements: 7,
        runnerQueueDepth: 1,
        runnerQueueWaitMs: 500,
        runnerRunningJobs: 2,
        runnerVmCpuPercent: 40,
        runnerVmAvailableMemoryBytes: 6 * 1024 ** 3,
        unrelatedServicesHealthy: true,
      };
    },
  );
  return {
    startedAt: new Date(startedAtMs).toISOString(),
    completedAt: new Date(startedAtMs + 4_795_000).toISOString(),
    actions,
    resourceSamples,
    observedSustainedTotals: schedule.sustainedTotals,
    abort: { aborted: false },
  };
}

function buildPassingFaults(): ProductionFaultMatrixResult {
  return {
    scope: "codestead-project-only",
    startedAt: "2026-07-19T14:00:00.000Z",
    completedAt: "2026-07-19T16:22:30.000Z",
    cases: PRODUCTION_LOAD_FAULT_MATRIX.map((fault) => ({
      faultId: fault.id,
      passed: true,
      healthyBaselineMs: fault.healthyBaselineMs,
      baselineSamples: 24,
      faultDurationMs: 30_000,
      componentRecoveryMs: 15_000,
      queueDrainMs: 20_000,
      alertOrDeadLetterVisibilityMs: 30_000,
      invariantCheckMs: fault.invariantCheckMs,
      steadyBrowserJourneyPassed: true,
      recoveredBrowserJourneyPassed: true,
      invariants: {
        acknowledgedMutationFailures: 0,
        duplicateOfficialEffects: 0,
        secretLeakFindings: 0,
        runnerMaxConcurrentJobs: 2,
      },
    })),
  };
}

const candidate: ProductionLoadCandidate = {
  gitSha: "a".repeat(40),
  gitTree: "b".repeat(40),
  releaseManifestSha256: `sha256:${"1".repeat(64)}`,
  applicationImageRecordSha256: `sha256:${"c".repeat(64)}`,
  composeProject: "learncoding",
  composeWorkdir: "/opt/learncoding",
  publicOrigin: "https://learn.example.com",
  managedInventorySha256: `sha256:${"2".repeat(64)}`,
  firewallPolicySha256: `sha256:${"3".repeat(64)}`,
  runnerGuestReleaseSha256: `sha256:${"4".repeat(64)}`,
  runnerImageRecordSha256: `sha256:${"d".repeat(64)}`,
  nucHostId: "nuc-homelab:approved-host",
  runnerVmId: "123e4567-e89b-42d3-a456-426614174000",
  datasetId: "seed-20260715",
};
const baseline: ProductionLoadResourceBaseline = {
  oomKills: 3,
  thermalThrottleIncrements: 7,
  postgresDeadlocks: 5,
};

describe("production load gate report", () => {
  it("derives a PASS only from the exact workload, cadence, telemetry, and fault evidence", () => {
    const report = buildProductionLoadGateReport({
      generatedAt: "2026-07-19T17:00:00.000Z",
      decisionSha256: `sha256:${"e".repeat(64)}`,
      candidate,
      baseline,
      workload: buildPassingWorkload(),
      faults: buildPassingFaults(),
    });

    expect(report.verdict).toBe("PASS");
    expect(report.failures).toEqual([]);
    expect(report.metrics).toEqual({
      normalHttp5xxTimeoutRate: 0,
      acknowledgedMutationFailures: 0,
      nonRunnerP95Ms: 10,
      nonRunnerP99Ms: 10,
      runnerAdmissionP95Ms: 100,
      runnerQueueWaitP95Ms: 500,
      runnerQueueWaitMaxMs: 500,
      componentRecoveryMaxMs: 15_000,
      queueDrainMaxMs: 20_000,
      alertVisibilityMaxMs: 30_000,
      postgresConnectionsPeak: 10,
      postgresMaxConnections: 100,
      postgresLockWaitP95Ms: 2,
      deadlocks: 0,
      duplicateOfficialEffects: 0,
      secretLeakFindings: 0,
      runnerMaxConcurrentJobs: 2,
    });
    expect(report.workload.actions).toHaveLength(buildProductionLoadActions().length);
    expect(report.workload.resourceSamples).toHaveLength(960);
    expect(report.faultMatrix.cases).toHaveLength(15);
    expect(JSON.stringify(report)).not.toMatch(/password|cookie|authorization|bearer/i);
  });

  it("fails closed for missing runner latency, broken cadence, action failure, or a new deadlock", () => {
    const workload = buildPassingWorkload();
    const firstCodeIndex = workload.actions.findIndex((action) => action.kind === "code_job");
    const codeAction = workload.actions[firstCodeIndex]!;
    const { runnerAdmissionMs: _removed, ...missingAdmission } = codeAction;
    void _removed;
    const actions = [...workload.actions];
    actions[firstCodeIndex] = missingAdmission;
    actions[0] = { ...actions[0]!, ok: false, status: 400 };
    const resourceSamples = [...workload.resourceSamples];
    resourceSamples[1] = {
      ...resourceSamples[1]!,
      scheduledOffsetMs: 5_001,
    };
    resourceSamples[resourceSamples.length - 1] = {
      ...resourceSamples.at(-1)!,
      postgresDeadlocks: 6,
    };

    const report = buildProductionLoadGateReport({
      generatedAt: "2026-07-19T17:00:00.000Z",
      decisionSha256: `sha256:${"e".repeat(64)}`,
      candidate,
      baseline,
      workload: { ...workload, actions, resourceSamples },
      faults: buildPassingFaults(),
    });

    expect(report.verdict).toBe("FAIL");
    expect(report.failures).toEqual(expect.arrayContaining([
      "runner_observation_missing_latency",
      "resource_sample_cadence",
      "unexpected_action_failure",
      "postgres_deadlock",
    ]));
  });
  it("fails closed when retained invariant evidence reports damage", () => {
    const faults = buildPassingFaults();
    const cases = [...faults.cases];
    cases[0] = {
      ...cases[0]!,
      invariants: {
        acknowledgedMutationFailures: 1,
        duplicateOfficialEffects: 1,
        secretLeakFindings: 1,
        runnerMaxConcurrentJobs: 3,
      },
    };

    const report = buildProductionLoadGateReport({
      generatedAt: "2026-07-19T17:00:00.000Z",
      decisionSha256: `sha256:${"e".repeat(64)}`,
      candidate,
      baseline,
      workload: buildPassingWorkload(),
      faults: { ...faults, cases },
    });

    expect(report.verdict).toBe("FAIL");
    expect(report.failures).toEqual(expect.arrayContaining([
      "acknowledged_mutation_failure",
      "duplicate_official_effect",
      "secret_leak_finding",
      "runner_concurrency_exceeded",
    ]));
    expect(report.metrics).toMatchObject({
      acknowledgedMutationFailures: 1,
      duplicateOfficialEffects: 1,
      secretLeakFindings: 1,
      runnerMaxConcurrentJobs: 3,
    });
  });

  it("uses physical HTTP requests as the failure-rate denominator and preserves partial mutation acknowledgement", () => {
    const workload = buildPassingWorkload();
    const actionIndex = workload.actions.findIndex((action) => action.kind === "review_completion");
    const original = workload.actions[actionIndex]!;
    const httpRequests = [...original.httpRequests];
    httpRequests[1] = {
      ...httpRequests[1]!,
      status: 503,
      ok: false,
      acknowledged: false,
    };
    const actions = [...workload.actions];
    actions[actionIndex] = {
      ...original,
      durationMs: httpRequests.reduce((total, request) => total + request.durationMs, 0),
      status: 503,
      ok: false,
      acknowledged: true,
      httpRequests,
    };
    const physicalRequestCount = actions.reduce(
      (total, action) => total + action.httpRequests.length,
      0,
    );

    const report = buildProductionLoadGateReport({
      generatedAt: "2026-07-19T17:00:00.000Z",
      decisionSha256: `sha256:${"e".repeat(64)}`,
      candidate,
      baseline,
      workload: { ...workload, actions },
      faults: buildPassingFaults(),
    });

    expect(report.verdict).toBe("FAIL");
    expect(report.metrics.normalHttp5xxTimeoutRate).toBeCloseTo(1 / physicalRequestCount, 12);
    expect(report.metrics.acknowledgedMutationFailures).toBe(1);
    expect(report.failures).toEqual(expect.arrayContaining([
      "unexpected_action_failure",
      "acknowledged_mutation_failure",
    ]));
  });
});
