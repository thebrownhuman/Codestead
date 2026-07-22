import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  assertLoadTarget,
  percentile,
  resolveLoadReportPath,
  summarizeLoad,
} from "../load-report";

const productionCandidateIdentity = {
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
} as const;

describe("load evidence helpers", () => {
  it("uses nearest-rank percentiles without mutating samples", () => {
    const values = [100, 10, 50, 20];
    expect(percentile(values, 0.5)).toBe(20);
    expect(percentile(values, 0.95)).toBe(100);
    expect(values).toEqual([100, 10, 50, 20]);
    expect(() => percentile(values, 1.1)).toThrow(/between zero and one/i);
  });

  it("summarizes latency, failures, statuses, and bounded error codes", () => {
    expect(summarizeLoad([
      { durationMs: 10, ok: true, status: 200 },
      { durationMs: 20, ok: false, status: 503, errorCode: "http_503" },
      { durationMs: 30, ok: false, status: null, errorCode: "timeout" },
      { durationMs: 40, ok: true, status: 204 },
    ])).toEqual({
      requests: 4,
      succeeded: 2,
      failed: 2,
      errorRate: 0.5,
      p50Ms: 20,
      p95Ms: 40,
      p99Ms: 40,
      maxMs: 40,
      statuses: { "200": 1, "204": 1, "503": 1, none: 1 },
      errors: { http_503: 1, timeout: 1 },
    });
  });

  it("refuses accidental remote or credential-bearing targets", () => {
    expect(assertLoadTarget("http://127.0.0.1:3000/").href).toBe("http://127.0.0.1:3000/");
    expect(() => assertLoadTarget("https://learn.example.com")).toThrow(/explicit/i);
    expect(assertLoadTarget("https://learn.example.com", true).hostname).toBe("learn.example.com");
    expect(() => assertLoadTarget("http://user:secret@localhost:3000")).toThrow(/credentials/i);
    expect(() => assertLoadTarget("file:///tmp/app")).toThrow(/HTTP/i);
  });

  it("allows evidence/report output only under the two documented local roots", () => {
    const root = path.resolve("synthetic-workspace");
    expect(resolveLoadReportPath(root)).toBeNull();
    expect(resolveLoadReportPath(root, "docs/evidence/load.json")).toBe(path.join(root, "docs", "evidence", "load.json"));
    expect(resolveLoadReportPath(root, "test-results/load.json")).toBe(path.join(root, "test-results", "load.json"));
    expect(() => resolveLoadReportPath(root, "../outside.json")).toThrow(/must stay under/i);
    expect(() => resolveLoadReportPath(root, "docs/evidence/../../.env")).toThrow(/must stay under/i);
  });

  it("builds the fixed seed-20260715 ten-learner 10/60/10 workload", async () => {
    const loadReport = await import("../load-report");
    const buildSchedule = Reflect.get(loadReport, "buildProductionLoadSchedule");

    expect(buildSchedule).toBeTypeOf("function");
    const schedule = buildSchedule();

    expect(schedule.seed).toBe("seed-20260715");
    expect(schedule.learners).toHaveLength(10);
    expect(schedule.minutes).toHaveLength(80);
    expect(schedule.minutes.filter((minute: { phase: string }) => minute.phase === "warmup")).toHaveLength(10);
    expect(schedule.minutes.filter((minute: { phase: string }) => minute.phase === "sustained")).toHaveLength(60);
    expect(schedule.minutes.filter((minute: { phase: string }) => minute.phase === "cooldown")).toHaveLength(10);
    expect(schedule.sustainedTotals).toEqual({
      lessonReads: 1_200,
      dashboardReads: 600,
      reviewQuizCompletions: 600,
      autosaves: 1_200,
      codeJobs: 200,
    });
    expect(schedule.minutes
      .filter((minute: { phase: string; submitCode: boolean }) => minute.phase === "sustained" && minute.submitCode))
      .toHaveLength(20);
    expect(schedule.minutes
      .filter((minute: { phase: string; submitCode: boolean }) => minute.phase === "cooldown" && minute.submitCode))
      .toHaveLength(0);
  });

  it("freezes every product-owner-approved production load threshold", async () => {
    const loadReport = await import("../load-report");
    const thresholds = Reflect.get(loadReport, "PRODUCTION_LOAD_THRESHOLDS");

    expect(thresholds).toEqual({
      normalHttpFailureRateMax: 0.005,
      acknowledgedMutationFailuresMax: 0,
      nonRunnerP95Ms: 2_000,
      nonRunnerP99Ms: 5_000,
      runnerAdmissionP95Ms: 2_000,
      runnerQueueWaitP95Ms: 60_000,
      runnerQueueWaitMaxMs: 120_000,
      componentRecoveryMaxMs: 300_000,
      queueDrainMaxMs: 600_000,
      alertVisibilityMaxMs: 60_000,
      postgresConnectionsFractionMax: 0.8,
      postgresLockWaitP95Ms: 1_000,
      deadlocksMax: 0,
      oomKillsMax: 0,
      thermalThrottleIncrementsMax: 0,
      minAvailableMemoryBytes: 8_589_934_592,
      minRootFreeFraction: 0.15,
      maxTemperatureCelsius: 90,
      maxConcurrentRunnerJobs: 2,
    });
    expect(Object.isFrozen(thresholds)).toBe(true);
  });

  it("accepts only an explicitly approved decision bound to the exact release candidate", async () => {
    const loadReport = await import("../load-report");
    const validateDecision = Reflect.get(loadReport, "validateProductionLoadDecision");
    const thresholds = Reflect.get(loadReport, "PRODUCTION_LOAD_THRESHOLDS");

    const candidate = {
      gitSha: "a".repeat(40),
      gitTree: "b".repeat(40),
      ...productionCandidateIdentity,
    } as const;

    const decision = {
      schemaVersion: 1,
      scope: "codestead-project-only",
      status: "approved",
      approvedAt: "2026-07-19T12:00:00.000Z",
      approvedBy: "Codestead product owner",
      approvalReason: "Approved supervised pilot load and fault rehearsal.",
      candidate,
      thresholds,
    };

    expect(validateDecision).toBeTypeOf("function");
    expect(validateDecision(decision, candidate)).toEqual(decision);
  });
  it("rejects unexpected fields that could smuggle secrets into an approval artifact", async () => {
    const loadReport = await import("../load-report");
    const validateDecision = Reflect.get(loadReport, "validateProductionLoadDecision");
    const thresholds = Reflect.get(loadReport, "PRODUCTION_LOAD_THRESHOLDS");

    const candidate = {
      gitSha: "a".repeat(40),
      gitTree: "b".repeat(40),
      ...productionCandidateIdentity,
    } as const;

    const decision = {
      schemaVersion: 1,
      scope: "codestead-project-only",
      status: "approved",
      approvedAt: "2026-07-19T12:00:00.000Z",
      approvedBy: "Codestead product owner",
      approvalReason: "Approved supervised pilot load and fault rehearsal.",
      candidate,
      thresholds,
      providerApiToken: "must-never-enter-evidence",
    };

    expect(() => validateDecision(decision, candidate)).toThrow(/unexpected/i);
  });
  it("rejects malformed release identities even when the decision repeats them", async () => {
    const loadReport = await import("../load-report");
    const validateDecision = Reflect.get(loadReport, "validateProductionLoadDecision");
    const thresholds = Reflect.get(loadReport, "PRODUCTION_LOAD_THRESHOLDS");

    const candidate = {
      gitSha: "not-a-git-sha",
      gitTree: "b".repeat(40),
      ...productionCandidateIdentity,
    } as const;
    const decision = {
      schemaVersion: 1,
      scope: "codestead-project-only",
      status: "approved",
      approvedAt: "2026-07-19T12:00:00.000Z",
      approvedBy: "Codestead product owner",
      approvalReason: "Approved supervised pilot load and fault rehearsal.",
      candidate,
      thresholds,
    };

    expect(() => validateDecision(decision, candidate)).toThrow(/gitSha|identity/i);
  });
  it("aborts after two consecutive samples below eight GiB available memory", async () => {
    const loadReport = await import("../load-report");
    const evaluateAbort = Reflect.get(loadReport, "evaluateProductionLoadAbort");

    const baseline = { oomKills: 0, thermalThrottleIncrements: 0, postgresDeadlocks: 0 };
    const common = {
      hostCpuPercent: 35,
      rootFreeFraction: 0.5,
      rootFreeBytes: 400_000_000_000,
      diskReadBytes: 1_000,
      diskWriteBytes: 2_000,
      postgresConnections: 10,
      postgresMaxConnections: 100,
      postgresDeadlocks: 0,
      postgresLockWaitMs: 2,
      runnerQueueDepth: 1,
      runnerQueueWaitMs: 25,
      runnerVmCpuPercent: 40,
      runnerVmAvailableMemoryBytes: 6_000_000_000,
      temperatureCelsius: 60,
      oomKills: 0,
      thermalThrottleIncrements: 0,
      runnerRunningJobs: 2,
      unrelatedServicesHealthy: true,
    };
    const samples = [
      { ...common, availableMemoryBytes: 8_589_934_591 },
      { ...common, availableMemoryBytes: 8_000_000_000 },
    ];

    expect(evaluateAbort).toBeTypeOf("function");
    expect(evaluateAbort(samples, baseline)).toEqual({
      aborted: true,
      sampleIndex: 1,
      reason: "available_memory_below_8_gib_twice",
    });
  });
  it("aborts immediately for temperature, OOM, throttle, third-runner, or unrelated-service regressions", async () => {
    const loadReport = await import("../load-report");
    const evaluateAbort = Reflect.get(loadReport, "evaluateProductionLoadAbort");
    const baseline = { oomKills: 5, thermalThrottleIncrements: 7, postgresDeadlocks: 0 };
    const healthy = {
      hostCpuPercent: 35,
      availableMemoryBytes: 10_000_000_000,
      rootFreeFraction: 0.5,
      rootFreeBytes: 400_000_000_000,
      diskReadBytes: 1_000,
      diskWriteBytes: 2_000,
      postgresConnections: 10,
      postgresMaxConnections: 100,
      postgresDeadlocks: 0,
      postgresLockWaitMs: 2,
      runnerQueueDepth: 1,
      runnerQueueWaitMs: 25,
      runnerVmCpuPercent: 40,
      runnerVmAvailableMemoryBytes: 6_000_000_000,
      temperatureCelsius: 60,
      oomKills: 5,
      thermalThrottleIncrements: 7,
      runnerRunningJobs: 2,
      unrelatedServicesHealthy: true,
    };
    const cases = [
      { sample: { ...healthy, temperatureCelsius: 90 }, reason: "temperature_at_or_above_90_celsius" },
      { sample: { ...healthy, oomKills: 6 }, reason: "new_oom_kill" },
      { sample: { ...healthy, thermalThrottleIncrements: 8 }, reason: "new_thermal_throttle" },
      { sample: { ...healthy, runnerRunningJobs: 3 }, reason: "third_concurrent_runner_job" },
      { sample: { ...healthy, unrelatedServicesHealthy: false }, reason: "unrelated_service_regression" },
    ];

    for (const testCase of cases) {
      expect(evaluateAbort([testCase.sample], baseline)).toEqual({
        aborted: true,
        sampleIndex: 0,
        reason: testCase.reason,
      });
    }
  });
  it("requires two consecutive low-root-capacity samples and resets the streak after recovery", async () => {
    const loadReport = await import("../load-report");
    const evaluateAbort = Reflect.get(loadReport, "evaluateProductionLoadAbort");
    const baseline = { oomKills: 0, thermalThrottleIncrements: 0, postgresDeadlocks: 0 };
    const common = {
      hostCpuPercent: 35,
      availableMemoryBytes: 10_000_000_000,
      rootFreeBytes: 400_000_000_000,
      diskReadBytes: 1_000,
      diskWriteBytes: 2_000,
      postgresConnections: 10,
      postgresMaxConnections: 100,
      postgresDeadlocks: 0,
      postgresLockWaitMs: 2,
      runnerQueueDepth: 1,
      runnerQueueWaitMs: 25,
      runnerVmCpuPercent: 40,
      runnerVmAvailableMemoryBytes: 6_000_000_000,
      temperatureCelsius: 60,
      oomKills: 0,
      thermalThrottleIncrements: 0,
      runnerRunningJobs: 2,
      unrelatedServicesHealthy: true,
    };
    const samples = [
      { ...common, rootFreeFraction: 0.14 },
      { ...common, rootFreeFraction: 0.16 },
      { ...common, rootFreeFraction: 0.149 },
      { ...common, rootFreeFraction: 0.10 },
    ];

    expect(evaluateAbort(samples, baseline)).toEqual({
      aborted: true,
      sampleIndex: 3,
      reason: "root_capacity_below_15_percent_twice",
    });
  });
  it("passes a complete load result only when every approved metric is inside its boundary", async () => {
    const loadReport = await import("../load-report");
    const evaluateResult = Reflect.get(loadReport, "evaluateProductionLoadResult");
    const metrics = {
      normalHttp5xxTimeoutRate: 0.005,
      acknowledgedMutationFailures: 0,
      nonRunnerP95Ms: 2_000,
      nonRunnerP99Ms: 5_000,
      runnerAdmissionP95Ms: 2_000,
      runnerQueueWaitP95Ms: 60_000,
      runnerQueueWaitMaxMs: 120_000,
      componentRecoveryMaxMs: 300_000,
      queueDrainMaxMs: 600_000,
      alertVisibilityMaxMs: 60_000,
      postgresConnectionsPeak: 79,
      postgresMaxConnections: 100,
      postgresLockWaitP95Ms: 1_000,
      deadlocks: 0,
      duplicateOfficialEffects: 0,
      secretLeakFindings: 0,
      runnerMaxConcurrentJobs: 2,
    };

    expect(evaluateResult).toBeTypeOf("function");
    expect(evaluateResult(metrics)).toEqual({ passed: true, failures: [] });
  });
  it("reports every load-result threshold violation with stable non-sensitive codes", async () => {
    const loadReport = await import("../load-report");
    const evaluateResult = Reflect.get(loadReport, "evaluateProductionLoadResult");
    const metrics = {
      normalHttp5xxTimeoutRate: 0.006,
      acknowledgedMutationFailures: 1,
      nonRunnerP95Ms: 2_001,
      nonRunnerP99Ms: 5_001,
      runnerAdmissionP95Ms: 2_001,
      runnerQueueWaitP95Ms: 60_001,
      runnerQueueWaitMaxMs: 120_001,
      componentRecoveryMaxMs: 300_001,
      queueDrainMaxMs: 600_001,
      alertVisibilityMaxMs: 60_001,
      postgresConnectionsPeak: 80,
      postgresMaxConnections: 100,
      postgresLockWaitP95Ms: 1_001,
      deadlocks: 1,
      duplicateOfficialEffects: 1,
      secretLeakFindings: 1,
      runnerMaxConcurrentJobs: 3,
    };

    expect(evaluateResult(metrics)).toEqual({
      passed: false,
      failures: [
        "normal_http_5xx_timeout_rate",
        "acknowledged_mutation_failure",
        "non_runner_p95",
        "non_runner_p99",
        "runner_admission_p95",
        "runner_queue_wait_p95",
        "runner_queue_wait_max",
        "component_recovery",
        "queue_drain",
        "alert_visibility",
        "postgres_connection_headroom",
        "postgres_lock_wait_p95",
        "postgres_deadlock",
        "duplicate_official_effect",
        "secret_leak_finding",
        "runner_concurrency_exceeded",
      ],
    });
  });
  it("freezes the complete ordered project-safe fault matrix and time budgets", async () => {
    const loadReport = await import("../load-report");
    const faultMatrix = Reflect.get(loadReport, "PRODUCTION_LOAD_FAULT_MATRIX");

    expect(faultMatrix.map((fault: { id: string }) => fault.id)).toEqual([
      "runner_service_restart",
      "app_container_restart",
      "email_worker_restart",
      "assessment_regrade_worker_restart",
      "project_review_correction_worker_restart",
      "exam_finalization_worker_restart",
      "practice_recovery_worker_restart",
      "rewards_worker_restart",
      "postgres_proxy_interruption",
      "tunnel_proxy_interruption",
      "fake_gmail_failure",
      "fake_ai_provider_failure",
      "fake_offsite_drive_failure",
      "quota_volume_near_full",
      "synthetic_stale_backup_alert",
    ]);
    for (const fault of faultMatrix) {
      expect(fault).toMatchObject({
        healthyBaselineMs: 120_000,
        faultMaxMs: 60_000,
        recoveryMaxMs: 300_000,
        invariantCheckMs: 120_000,
      });
    }
    expect(Object.isFrozen(faultMatrix)).toBe(true);
  });
  it("rejects non-canonical approval timestamps and nested approval-artifact fields", async () => {
    const loadReport = await import("../load-report");
    const validateDecision = Reflect.get(loadReport, "validateProductionLoadDecision");
    const thresholds = Reflect.get(loadReport, "PRODUCTION_LOAD_THRESHOLDS");
    const candidate = {
      gitSha: "a".repeat(40),
      gitTree: "b".repeat(40),
      ...productionCandidateIdentity,
    } as const;
    const baseDecision = {
      schemaVersion: 1,
      scope: "codestead-project-only",
      status: "approved",
      approvedAt: "2026-07-19T12:00:00.000Z",
      approvedBy: "Codestead product owner",
      approvalReason: "Approved supervised pilot load and fault rehearsal.",
      candidate,
      thresholds,
    };

    expect(() => validateDecision({ ...baseDecision, approvedAt: "yesterday" }, candidate))
      .toThrow(/timestamp/i);
    expect(() => validateDecision({
      ...baseDecision,
      candidate: { ...candidate, apiToken: "must-not-enter-evidence" },
    }, candidate)).toThrow(/candidate.*fields/i);
    expect(() => validateDecision({
      ...baseDecision,
      thresholds: { ...thresholds, relaxedAfterRun: true },
    }, candidate)).toThrow(/threshold.*fields/i);
  });

  it("fails closed for non-finite or negative result metrics", async () => {
    const loadReport = await import("../load-report");
    const evaluateResult = Reflect.get(loadReport, "evaluateProductionLoadResult");
    const valid = {
      normalHttp5xxTimeoutRate: 0,
      acknowledgedMutationFailures: 0,
      nonRunnerP95Ms: 100,
      nonRunnerP99Ms: 200,
      runnerAdmissionP95Ms: 100,
      runnerQueueWaitP95Ms: 1_000,
      runnerQueueWaitMaxMs: 2_000,
      componentRecoveryMaxMs: 1_000,
      queueDrainMaxMs: 1_000,
      alertVisibilityMaxMs: 1_000,
      postgresConnectionsPeak: 1,
      postgresMaxConnections: 100,
      postgresLockWaitP95Ms: 1,
      deadlocks: 0,
      duplicateOfficialEffects: 0,
      secretLeakFindings: 0,
      runnerMaxConcurrentJobs: 2,
    };

    expect(evaluateResult({ ...valid, nonRunnerP95Ms: Number.NaN })).toEqual({
      passed: false,
      failures: ["invalid_metric_non_runner_p95_ms"],
    });
    expect(evaluateResult({ ...valid, acknowledgedMutationFailures: -1 })).toEqual({
      passed: false,
      failures: ["invalid_metric_acknowledged_mutation_failures"],
    });
    expect(evaluateResult({ ...valid, normalHttp5xxTimeoutRate: 1.1 })).toEqual({
      passed: false,
      failures: ["invalid_metric_normal_http_5xx_timeout_rate", "normal_http_5xx_timeout_rate"],
    });
  });

  it("aborts on malformed resource telemetry instead of treating it as healthy", async () => {
    const loadReport = await import("../load-report");
    const evaluateAbort = Reflect.get(loadReport, "evaluateProductionLoadAbort");
    const sample = {
      hostCpuPercent: 35,
      availableMemoryBytes: Number.NaN,
      rootFreeFraction: 0.5,
      rootFreeBytes: 400_000_000_000,
      diskReadBytes: 1_000,
      diskWriteBytes: 2_000,
      postgresConnections: 10,
      postgresMaxConnections: 100,
      postgresDeadlocks: 0,
      postgresLockWaitMs: 2,
      runnerQueueDepth: 1,
      runnerQueueWaitMs: 25,
      runnerVmCpuPercent: 40,
      runnerVmAvailableMemoryBytes: 6_000_000_000,
      temperatureCelsius: 60,
      oomKills: 0,
      thermalThrottleIncrements: 0,
      runnerRunningJobs: 2,
      unrelatedServicesHealthy: true,
    };

    expect(evaluateAbort([sample], { oomKills: 0, thermalThrottleIncrements: 0, postgresDeadlocks: 0 })).toEqual({
      aborted: true,
      sampleIndex: 0,
      reason: "invalid_resource_sample",
    });
  });

  it("expands the fixed schedule into the exact authenticated action totals", async () => {
    const loadReport = await import("../load-report");
    const buildSchedule = Reflect.get(loadReport, "buildProductionLoadSchedule");
    const buildActions = Reflect.get(loadReport, "buildProductionLoadActions");

    expect(buildActions).toBeTypeOf("function");
    const schedule = buildSchedule();
    const actions = buildActions(schedule);
    const sustained = actions.filter((action: { phase: string }) => action.phase === "sustained");
    const count = (kind: string) => sustained.filter((action: { kind: string }) => action.kind === kind).length;

    expect(count("lesson_read")).toBe(1_200);
    expect(count("dashboard_read")).toBe(600);
    expect(count("review_completion")).toBe(300);
    expect(count("quiz_completion")).toBe(300);
    expect(count("draft_autosave")).toBe(600);
    expect(count("exam_autosave")).toBe(600);
    expect(count("code_job")).toBe(200);
    expect(actions.filter((action: { phase: string; kind: string }) => action.phase === "cooldown" && action.kind === "code_job"))
      .toHaveLength(0);
    expect(actions.filter((action: { ordinal: number }) => action.ordinal === 1)).toHaveLength(6);
    expect(actions.filter((action: { ordinal: number }) => action.ordinal === 71)).toHaveLength(54);
  });

  it("requires a complete five-second resource sample cadence", async () => {
    const loadReport = await import("../load-report");
    const buildOffsets = Reflect.get(loadReport, "buildProductionSamplingOffsets");

    expect(buildOffsets).toBeTypeOf("function");
    const offsets = buildOffsets(80 * 60 * 1_000);
    expect(offsets).toHaveLength(960);
    expect(offsets[0]).toBe(0);
    expect(offsets.at(-1)).toBe(4_795_000);
    expect(offsets.every((value: number, index: number) => value === index * 5_000)).toBe(true);
    expect(() => buildOffsets(80 * 60 * 1_000 - 1)).toThrow(/five-second/i);
  });

  it("refuses secret-bearing fields and values in load evidence", async () => {
    const loadReport = await import("../load-report");
    const assertSafe = Reflect.get(loadReport, "assertProductionLoadEvidenceSafe");

    expect(assertSafe).toBeTypeOf("function");
    expect(assertSafe({ schemaVersion: 1, verdict: "NOT_RUN", failures: ["decision_missing"] }))
      .toEqual({ schemaVersion: 1, verdict: "NOT_RUN", failures: ["decision_missing"] });
    expect(() => assertSafe({ learner: { sessionToken: "opaque" } })).toThrow(/secret-bearing field/i);
    for (const unsafe of [
      { operatorEmail: "owner@example.com" },
      { databaseUrl: "postgres://admin:secret@db/app" },
      { totpSeed: "JBSWY3DPEHPK3PXP" },
      { recoveryCode: "correct-horse-battery-staple" },
      { backupIdentity: "drive:private-folder" },
    ]) {
      expect(() => assertSafe(unsafe)).toThrow(/secret-bearing (field|value)/i);
    }
    expect(() => assertSafe({ note: "postgres://admin:secret@db/app" }))
      .toThrow(/secret-bearing value/i);
    expect(() => assertSafe({ note: "Authorization: Bearer abc123" })).toThrow(/secret-bearing value/i);
    expect(() => assertSafe({ note: "nvapi-not-real-but-still-forbidden" })).toThrow(/secret-bearing value/i);
  });

  it("builds exactly ten synthetic accounts, thirty lessons, fifty prompts, and one hundred drafts", async () => {
    const loadReport = await import("../load-report");
    const buildSeedPlan = Reflect.get(loadReport, "buildProductionLoadSeedPlan");

    expect(buildSeedPlan).toBeTypeOf("function");
    const plan = buildSeedPlan();
    expect(plan.datasetId).toBe("seed-20260715");
    expect(plan.learners).toHaveLength(10);
    expect(plan.lessons).toHaveLength(30);
    expect(plan.prompts).toHaveLength(50);
    expect(plan.drafts).toHaveLength(100);
    expect(plan.providerCredentials).toEqual([]);
    expect(new Set(plan.learners.map((learner: { id: string }) => learner.id)).size).toBe(10);
    expect(new Set(plan.lessons.map((lesson: { id: string }) => lesson.id)).size).toBe(30);
    expect(new Set(plan.prompts.map((prompt: { id: string }) => prompt.id)).size).toBe(50);
    expect(new Set(plan.drafts.map((draft: { id: string }) => draft.id)).size).toBe(100);
    for (const learner of plan.learners) {
      expect(learner.email).toMatch(/^synthetic-load-\d{2}@example\.invalid$/);
      expect(plan.prompts.filter((prompt: { learnerId: string }) => prompt.learnerId === learner.id)).toHaveLength(5);
      expect(plan.drafts.filter((draft: { learnerId: string }) => draft.learnerId === learner.id)).toHaveLength(10);
    }
    expect(JSON.stringify(plan)).not.toMatch(/password|apiKey|credentialValue|accessToken/i);
  });

  it("fails when observed sustained totals differ from the frozen workload", async () => {
    const loadReport = await import("../load-report");
    const buildSchedule = Reflect.get(loadReport, "buildProductionLoadSchedule");
    const evaluateTotals = Reflect.get(loadReport, "evaluateProductionWorkloadTotals");
    const expected = buildSchedule().sustainedTotals;

    expect(evaluateTotals).toBeTypeOf("function");
    expect(evaluateTotals(expected)).toEqual({ passed: true, failures: [] });
    expect(evaluateTotals({
      ...expected,
      lessonReads: expected.lessonReads - 1,
      codeJobs: expected.codeJobs + 1,
    })).toEqual({
      passed: false,
      failures: ["workload_total_lesson_reads", "workload_total_code_jobs"],
    });
    expect(evaluateTotals({ ...expected, autosaves: Number.NaN })).toEqual({
      passed: false,
      failures: ["workload_total_autosaves"],
    });
  });

  it("derives the approved candidate from the exact active-release state", async () => {
    const loadReport = await import("../load-report");
    const buildCandidate = Reflect.get(loadReport, "buildProductionLoadCandidateFromActiveRelease");
    const activeRelease = [
      "SCHEMA_VERSION=1",
      `GIT_COMMIT=${"a".repeat(40)}`,
      `GIT_TREE=${"b".repeat(40)}`,
      `RELEASE_MANIFEST_SHA256=${"1".repeat(64)}`,
      `APPLICATION_IMAGE_RECORD_SHA256=${"c".repeat(64)}`,
      "COMPOSE_PROJECT=learncoding",
      "COMPOSE_WORKDIR=/opt/learncoding",
      "PUBLIC_ORIGIN=https://learn.example.com",
      `MANAGED_INVENTORY_SHA256=${"2".repeat(64)}`,
      `FIREWALL_POLICY_SHA256=${"3".repeat(64)}`,
      `RUNNER_GUEST_RELEASE_SHA256=${"4".repeat(64)}`,
      `RUNNER_RUNTIME_IMAGES_SHA256=${"d".repeat(64)}`,
      "",
    ].join("\n");

    expect(buildCandidate).toBeTypeOf("function");
    expect(buildCandidate(
      activeRelease,
      "nuc-homelab:approved-host",
      "123e4567-e89b-42d3-a456-426614174000",
    )).toEqual({
      gitSha: "a".repeat(40),
      gitTree: "b".repeat(40),
      ...productionCandidateIdentity,
    });
  });

  it("binds approval identity to public-origin drift", async () => {
    const loadReport = await import("../load-report");
    const buildCandidate = Reflect.get(loadReport, "buildProductionLoadCandidateFromActiveRelease");
    const validateDecision = Reflect.get(loadReport, "validateProductionLoadDecision");
    const thresholds = Reflect.get(loadReport, "PRODUCTION_LOAD_THRESHOLDS");
    const activeRelease = [
      "SCHEMA_VERSION=1",
      `GIT_COMMIT=${"a".repeat(40)}`,
      `GIT_TREE=${"b".repeat(40)}`,
      `RELEASE_MANIFEST_SHA256=${"1".repeat(64)}`,
      `APPLICATION_IMAGE_RECORD_SHA256=${"c".repeat(64)}`,
      "COMPOSE_PROJECT=learncoding",
      "COMPOSE_WORKDIR=/opt/learncoding",
      "PUBLIC_ORIGIN=https://learn.example.com",
      `MANAGED_INVENTORY_SHA256=${"2".repeat(64)}`,
      `FIREWALL_POLICY_SHA256=${"3".repeat(64)}`,
      `RUNNER_GUEST_RELEASE_SHA256=${"4".repeat(64)}`,
      `RUNNER_RUNTIME_IMAGES_SHA256=${"d".repeat(64)}`,
      "",
    ].join("\n");
    const approvedCandidate = buildCandidate(
      activeRelease,
      "nuc-homelab:approved-host",
      "123e4567-e89b-42d3-a456-426614174000",
    );
    const decision = {
      schemaVersion: 1,
      scope: "codestead-project-only",
      status: "approved",
      approvedAt: "2026-07-19T12:00:00.000Z",
      approvedBy: "product-owner",
      approvalReason: "approved maintenance window",
      candidate: approvedCandidate,
      thresholds,
    };

    const changedOrigins = activeRelease.replace(
      "PUBLIC_ORIGIN=https://learn.example.com",
      "PUBLIC_ORIGIN=https://other.example.com",
    );
    const changedCandidate = buildCandidate(
      changedOrigins,
      "nuc-homelab:approved-host",
      "123e4567-e89b-42d3-a456-426614174000",
    );

    expect(changedCandidate).not.toEqual(approvedCandidate);
    expect(() => validateDecision(decision, changedCandidate)).toThrow(/candidate mismatch/i);
  });

  const candidateActiveRelease = [
    "SCHEMA_VERSION=1",
    "GIT_COMMIT=" + "a".repeat(40),
    "GIT_TREE=" + "b".repeat(40),
    "RELEASE_MANIFEST_SHA256=" + "1".repeat(64),
    "APPLICATION_IMAGE_RECORD_SHA256=" + "c".repeat(64),
    "COMPOSE_PROJECT=learncoding",
    "COMPOSE_WORKDIR=/opt/learncoding",
    "PUBLIC_ORIGIN=https://learn.example.com",
    "MANAGED_INVENTORY_SHA256=" + "2".repeat(64),
    "FIREWALL_POLICY_SHA256=" + "3".repeat(64),
    "RUNNER_GUEST_RELEASE_SHA256=" + "4".repeat(64),
    "RUNNER_RUNTIME_IMAGES_SHA256=" + "d".repeat(64),
    "",
  ].join("\n");
  const candidateBuildInput = {
    activeRelease: candidateActiveRelease,
    nucHostId: "nuc-homelab:approved-host",
    runnerVmId: "123e4567-e89b-42d3-a456-426614174000",
  } as const;
  const mutateActiveRelease = (field: string, value: string) =>
    candidateActiveRelease.replace(new RegExp("^" + field + "=.*$", "m"), field + "=" + value);
  const validCandidateDrifts = [
    ["Git commit", "gitSha", { ...candidateBuildInput, activeRelease: mutateActiveRelease("GIT_COMMIT", "e".repeat(40)) }, "e".repeat(40)],
    ["Git tree", "gitTree", { ...candidateBuildInput, activeRelease: mutateActiveRelease("GIT_TREE", "f".repeat(40)) }, "f".repeat(40)],
    ["release manifest digest", "releaseManifestSha256", { ...candidateBuildInput, activeRelease: mutateActiveRelease("RELEASE_MANIFEST_SHA256", "5".repeat(64)) }, "sha256:" + "5".repeat(64)],
    ["application image record digest", "applicationImageRecordSha256", { ...candidateBuildInput, activeRelease: mutateActiveRelease("APPLICATION_IMAGE_RECORD_SHA256", "6".repeat(64)) }, "sha256:" + "6".repeat(64)],
    ["managed inventory digest", "managedInventorySha256", { ...candidateBuildInput, activeRelease: mutateActiveRelease("MANAGED_INVENTORY_SHA256", "7".repeat(64)) }, "sha256:" + "7".repeat(64)],
    ["firewall policy digest", "firewallPolicySha256", { ...candidateBuildInput, activeRelease: mutateActiveRelease("FIREWALL_POLICY_SHA256", "8".repeat(64)) }, "sha256:" + "8".repeat(64)],
    ["runner guest release digest", "runnerGuestReleaseSha256", { ...candidateBuildInput, activeRelease: mutateActiveRelease("RUNNER_GUEST_RELEASE_SHA256", "9".repeat(64)) }, "sha256:" + "9".repeat(64)],
    ["runner image record digest", "runnerImageRecordSha256", { ...candidateBuildInput, activeRelease: mutateActiveRelease("RUNNER_RUNTIME_IMAGES_SHA256", "e".repeat(64)) }, "sha256:" + "e".repeat(64)],
    ["public origin", "publicOrigin", { ...candidateBuildInput, activeRelease: mutateActiveRelease("PUBLIC_ORIGIN", "https://other.example.com") }, "https://other.example.com"],
    ["NUC host", "nucHostId", { ...candidateBuildInput, nucHostId: "nuc-homelab:approved-host-2" }, "nuc-homelab:approved-host-2"],
    ["runner VM", "runnerVmId", { ...candidateBuildInput, runnerVmId: "123e4567-e89b-42d3-a456-426614174001" }, "123e4567-e89b-42d3-a456-426614174001"],
  ] as const;

  it.each(validCandidateDrifts)(
    "changes the candidate and rejects the old decision when %s drifts",
    async (_label, candidateField, input, expectedValue) => {
      const loadReport = await import("../load-report");
      const buildCandidate = Reflect.get(loadReport, "buildProductionLoadCandidateFromActiveRelease");
      const validateDecision = Reflect.get(loadReport, "validateProductionLoadDecision");
      const thresholds = Reflect.get(loadReport, "PRODUCTION_LOAD_THRESHOLDS");
      const approvedCandidate = buildCandidate(
        candidateBuildInput.activeRelease,
        candidateBuildInput.nucHostId,
        candidateBuildInput.runnerVmId,
      );
      const decision = {
        schemaVersion: 1,
        scope: "codestead-project-only",
        status: "approved",
        approvedAt: "2026-07-19T12:00:00.000Z",
        approvedBy: "product-owner",
        approvalReason: "approved maintenance window",
        candidate: approvedCandidate,
        thresholds,
      };
      const changedCandidate = buildCandidate(
        input.activeRelease,
        input.nucHostId,
        input.runnerVmId,
      );

      expect(changedCandidate[candidateField]).toBe(expectedValue);
      expect(changedCandidate).not.toEqual(approvedCandidate);
      expect(() => validateDecision(decision, changedCandidate)).toThrow(
        new RegExp("candidate mismatch: " + candidateField, "i"),
      );
    },
  );

  it.each([
    ["unsupported schema", mutateActiveRelease("SCHEMA_VERSION", "2"), /schema/i],
    ["changed Compose project", mutateActiveRelease("COMPOSE_PROJECT", "other"), /compose/i],
    ["changed Compose workdir", mutateActiveRelease("COMPOSE_WORKDIR", "/srv/learncoding"), /compose/i],
    [
      "reordered fields",
      candidateActiveRelease.replace(
        "GIT_COMMIT=" + "a".repeat(40) + "\nGIT_TREE=" + "b".repeat(40),
        "GIT_TREE=" + "b".repeat(40) + "\nGIT_COMMIT=" + "a".repeat(40),
      ),
      /canonical/i,
    ],
    [
      "missing field",
      candidateActiveRelease.replace("PUBLIC_ORIGIN=https://learn.example.com\n", ""),
      /unexpected|missing/i,
    ],
    ["unexpected field", candidateActiveRelease + "EXTRA_FIELD=value\n", /unexpected|missing/i],
    ["CRLF line endings", candidateActiveRelease.replaceAll("\n", "\r\n"), /canonical LF/i],
    ["missing final LF", candidateActiveRelease.slice(0, -1), /canonical LF/i],
    ["whitespace in a value", mutateActiveRelease("COMPOSE_PROJECT", "learn coding"), /canonical/i],
    ["embedded NUL", mutateActiveRelease("COMPOSE_PROJECT", "learncoding\0"), /canonical LF/i],
  ])("rejects %s during candidate construction", async (_label, changedActiveRelease, expectedError) => {
    const loadReport = await import("../load-report");
    const buildCandidate = Reflect.get(loadReport, "buildProductionLoadCandidateFromActiveRelease");

    expect(() => buildCandidate(
      changedActiveRelease,
      candidateBuildInput.nucHostId,
      candidateBuildInput.runnerVmId,
    )).toThrow(expectedError);
  });

  it.each([
    ["gitSha", "e".repeat(40)],
    ["gitTree", "f".repeat(40)],
    ["releaseManifestSha256", "sha256:" + "5".repeat(64)],
    ["applicationImageRecordSha256", "sha256:" + "6".repeat(64)],
    ["composeProject", "other"],
    ["composeWorkdir", "/srv/learncoding"],
    ["publicOrigin", "https://other.example.com"],
    ["managedInventorySha256", "sha256:" + "7".repeat(64)],
    ["firewallPolicySha256", "sha256:" + "8".repeat(64)],
    ["runnerGuestReleaseSha256", "sha256:" + "9".repeat(64)],
    ["runnerImageRecordSha256", "sha256:" + "e".repeat(64)],
    ["nucHostId", "nuc-homelab:approved-host-2"],
    ["runnerVmId", "123e4567-e89b-42d3-a456-426614174001"],
    ["datasetId", "seed-20260716"],
  ] as const)("rejects a decision-side %s candidate mutation", async (candidateField, changedValue) => {
    const loadReport = await import("../load-report");
    const buildCandidate = Reflect.get(loadReport, "buildProductionLoadCandidateFromActiveRelease");
    const validateDecision = Reflect.get(loadReport, "validateProductionLoadDecision");
    const thresholds = Reflect.get(loadReport, "PRODUCTION_LOAD_THRESHOLDS");
    const approvedCandidate = buildCandidate(
      candidateBuildInput.activeRelease,
      candidateBuildInput.nucHostId,
      candidateBuildInput.runnerVmId,
    );
    const changedCandidate = {
      ...approvedCandidate,
      [candidateField]: changedValue,
    };
    const changedDecision = {
      schemaVersion: 1,
      scope: "codestead-project-only",
      status: "approved",
      approvedAt: "2026-07-19T12:00:00.000Z",
      approvedBy: "product-owner",
      approvalReason: "approved maintenance window",
      candidate: changedCandidate,
      thresholds,
    };

    expect(changedCandidate).not.toEqual(approvedCandidate);
    expect(() => validateDecision(changedDecision, approvedCandidate)).toThrow(
      new RegExp("candidate mismatch: " + candidateField, "i"),
    );
  });

  it("accepts SHA-256 Git commit and tree identities from the release producer", async () => {
    const loadReport = await import("../load-report");
    const buildCandidate = Reflect.get(loadReport, "buildProductionLoadCandidateFromActiveRelease");
    const activeRelease = [
      "SCHEMA_VERSION=1",
      `GIT_COMMIT=${"a".repeat(64)}`,
      `GIT_TREE=${"b".repeat(64)}`,
      `RELEASE_MANIFEST_SHA256=${"1".repeat(64)}`,
      `APPLICATION_IMAGE_RECORD_SHA256=${"c".repeat(64)}`,
      "COMPOSE_PROJECT=learncoding",
      "COMPOSE_WORKDIR=/opt/learncoding",
      "PUBLIC_ORIGIN=https://learn.example.com",
      `MANAGED_INVENTORY_SHA256=${"2".repeat(64)}`,
      `FIREWALL_POLICY_SHA256=${"3".repeat(64)}`,
      `RUNNER_GUEST_RELEASE_SHA256=${"4".repeat(64)}`,
      `RUNNER_RUNTIME_IMAGES_SHA256=${"d".repeat(64)}`,
      "",
    ].join("\n");

    expect(() => buildCandidate(
      activeRelease,
      "nuc-homelab:approved-host",
      "123e4567-e89b-42d3-a456-426614174000",
    ))
      .not.toThrow();
  });

  it("rejects a malformed provenance hash in otherwise matching active-release state", async () => {
    const loadReport = await import("../load-report");
    const buildCandidate = Reflect.get(loadReport, "buildProductionLoadCandidateFromActiveRelease");
    const activeRelease = [
      "SCHEMA_VERSION=1",
      `GIT_COMMIT=${"a".repeat(40)}`,
      `GIT_TREE=${"b".repeat(40)}`,
      "RELEASE_MANIFEST_SHA256=not-a-sha256",
      `APPLICATION_IMAGE_RECORD_SHA256=${"c".repeat(64)}`,
      "COMPOSE_PROJECT=learncoding",
      "COMPOSE_WORKDIR=/opt/learncoding",
      "PUBLIC_ORIGIN=https://learn.example.com",
      `MANAGED_INVENTORY_SHA256=${"2".repeat(64)}`,
      `FIREWALL_POLICY_SHA256=${"3".repeat(64)}`,
      `RUNNER_GUEST_RELEASE_SHA256=${"4".repeat(64)}`,
      `RUNNER_RUNTIME_IMAGES_SHA256=${"d".repeat(64)}`,
      "",
    ].join("\n");

    expect(() => buildCandidate(
      activeRelease,
      "nuc-homelab:approved-host",
      "123e4567-e89b-42d3-a456-426614174000",
    ))
      .toThrow(/provenance|sha256/i);
  });

  it.each([
    "https://localhost",
    "https://127.0.0.1",
    "https://learn.example.com:8443",
    "https://learn.example.com.",
    "https://Learn.example.com",
  ])("rejects noncanonical production origin %s", async (publicOrigin) => {
    const loadReport = await import("../load-report");
    const buildCandidate = Reflect.get(loadReport, "buildProductionLoadCandidateFromActiveRelease");
    const activeRelease = [
      "SCHEMA_VERSION=1",
      `GIT_COMMIT=${"a".repeat(40)}`,
      `GIT_TREE=${"b".repeat(40)}`,
      `RELEASE_MANIFEST_SHA256=${"1".repeat(64)}`,
      `APPLICATION_IMAGE_RECORD_SHA256=${"c".repeat(64)}`,
      "COMPOSE_PROJECT=learncoding",
      "COMPOSE_WORKDIR=/opt/learncoding",
      `PUBLIC_ORIGIN=${publicOrigin}`,
      `MANAGED_INVENTORY_SHA256=${"2".repeat(64)}`,
      `FIREWALL_POLICY_SHA256=${"3".repeat(64)}`,
      `RUNNER_GUEST_RELEASE_SHA256=${"4".repeat(64)}`,
      `RUNNER_RUNTIME_IMAGES_SHA256=${"d".repeat(64)}`,
      "",
    ].join("\n");

    expect(() => buildCandidate(
      activeRelease,
      "nuc-homelab:approved-host",
      "123e4567-e89b-42d3-a456-426614174000",
    )).toThrow(/public origin/i);
  });

  it("uses stable unique UUID idempotency keys for every authenticated mutation action", async () => {
    const loadReport = await import("../load-report");
    const buildActions = Reflect.get(loadReport, "buildProductionLoadActions");
    const actions = buildActions();
    const requestIds = actions.map((action: { requestId: string }) => action.requestId);

    expect(requestIds.every((requestId: string) =>
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(requestId),
    )).toBe(true);
    expect(new Set(requestIds).size).toBe(requestIds.length);
    expect(buildActions()).toEqual(actions);
  });

});
