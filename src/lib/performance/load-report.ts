import path from "node:path";

import { deterministicUuid } from "../learning-service/ids";

export type RequestSample = {
  readonly durationMs: number;
  readonly ok: boolean;
  readonly status: number | null;
  readonly errorCode?: string;
};

export type LoadSummary = {
  readonly requests: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly errorRate: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly p99Ms: number;
  readonly maxMs: number;
  readonly statuses: Readonly<Record<string, number>>;
  readonly errors: Readonly<Record<string, number>>;
};

export type ProductionLoadPhase = "warmup" | "sustained" | "cooldown";

export type ProductionLoadMinute = {
  readonly ordinal: number;
  readonly phase: ProductionLoadPhase;
  readonly phaseMinute: number;
  readonly activeLearnerIds: readonly string[];
  readonly submitCode: boolean;
};

export type ProductionLoadSchedule = {
  readonly seed: "seed-20260715";
  readonly learners: readonly string[];
  readonly minutes: readonly ProductionLoadMinute[];
  readonly sustainedTotals: {
    readonly lessonReads: 1_200;
    readonly dashboardReads: 600;
    readonly reviewQuizCompletions: 600;
    readonly autosaves: 1_200;
    readonly codeJobs: 200;
  };
};

export const PRODUCTION_LOAD_THRESHOLDS = Object.freeze({
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
} as const);
const productionFaultIds = [
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
] as const;

export const PRODUCTION_LOAD_FAULT_MATRIX = Object.freeze(
  productionFaultIds.map((id) => Object.freeze({
    id,
    healthyBaselineMs: 120_000,
    faultMaxMs: 60_000,
    recoveryMaxMs: 300_000,
    invariantCheckMs: 120_000,
  })),
);


export type ProductionLoadCandidate = {
  readonly gitSha: string;
  readonly gitTree: string;
  readonly releaseManifestSha256: string;
  readonly applicationImageRecordSha256: string;
  readonly composeProject: "learncoding";
  readonly composeWorkdir: "/opt/learncoding";
  readonly publicOrigin: string;
  readonly managedInventorySha256: string;
  readonly firewallPolicySha256: string;
  readonly runnerGuestReleaseSha256: string;
  readonly runnerImageRecordSha256: string;
  readonly nucHostId: string;
  readonly runnerVmId: string;
  readonly datasetId: "seed-20260715";
};

export type ProductionLoadDecision = {
  readonly schemaVersion: 1;
  readonly scope: "codestead-project-only";
  readonly status: "approved";
  readonly approvedAt: string;
  readonly approvedBy: string;
  readonly approvalReason: string;
  readonly candidate: ProductionLoadCandidate;
  readonly thresholds: typeof PRODUCTION_LOAD_THRESHOLDS;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function assertExactFields(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value);
  if (actual.length !== expected.length || actual.some((field) => !expected.includes(field))) {
    throw new Error(`Production load decision ${label} contains unexpected or missing fields.`);
  }
}
function isFiniteNonNegative(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

function isNonNegativeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}



const productionCandidateFields = [
  "gitSha",
  "gitTree",
  "releaseManifestSha256",
  "applicationImageRecordSha256",
  "composeProject",
  "composeWorkdir",
  "publicOrigin",
  "managedInventorySha256",
  "firewallPolicySha256",
  "runnerGuestReleaseSha256",
  "runnerImageRecordSha256",
  "nucHostId",
  "runnerVmId",
  "datasetId",
] as const;

const productionDecisionFields = [
  "schemaVersion",
  "scope",
  "status",
  "approvedAt",
  "approvedBy",
  "approvalReason",
  "candidate",
  "thresholds",
] as const;
function assertProductionCandidateIdentities(candidate: ProductionLoadCandidate): void {
  const gitObject = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
  const sha256 = /^sha256:[0-9a-f]{64}$/;
  const boundedIdentifier = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/;

  if (!gitObject.test(candidate.gitSha)) {
    throw new Error("Production load candidate gitSha identity is invalid.");
  }
  if (!gitObject.test(candidate.gitTree)) {
    throw new Error("Production load candidate gitTree identity is invalid.");
  }
  const digestIdentities = [
    candidate.releaseManifestSha256,
    candidate.applicationImageRecordSha256,
    candidate.managedInventorySha256,
    candidate.firewallPolicySha256,
    candidate.runnerGuestReleaseSha256,
    candidate.runnerImageRecordSha256,
  ];
  if (digestIdentities.some((identity) => !sha256.test(identity))) {
    throw new Error("Production load candidate release identity is invalid.");
  }
  if (candidate.composeProject !== "learncoding"
    || candidate.composeWorkdir !== "/opt/learncoding") {
    throw new Error("Production load candidate Compose identity is invalid.");
  }
  if (!/^https:\/\/(?![0-9]{1,3}(?:\.[0-9]{1,3}){3}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(
    candidate.publicOrigin,
  )) {
    throw new Error("Production load candidate public origin is invalid.");
  }
  let publicOrigin: URL;
  try {
    publicOrigin = new URL(candidate.publicOrigin);
  } catch {
    throw new Error("Production load candidate public origin is invalid.");
  }
  if (publicOrigin.protocol !== "https:"
    || publicOrigin.origin !== candidate.publicOrigin
    || publicOrigin.username
    || publicOrigin.password) {
    throw new Error("Production load candidate public origin is invalid.");
  }
  if (!boundedIdentifier.test(candidate.nucHostId)
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(candidate.runnerVmId)) {
    throw new Error("Production load candidate host or VM identity is invalid.");
  }
  if (candidate.datasetId !== "seed-20260715") {
    throw new Error("Production load candidate dataset identity is invalid.");
  }
}

const productionActiveReleaseFields = [
  "SCHEMA_VERSION",
  "GIT_COMMIT",
  "GIT_TREE",
  "RELEASE_MANIFEST_SHA256",
  "APPLICATION_IMAGE_RECORD_SHA256",
  "COMPOSE_PROJECT",
  "COMPOSE_WORKDIR",
  "PUBLIC_ORIGIN",
  "MANAGED_INVENTORY_SHA256",
  "FIREWALL_POLICY_SHA256",
  "RUNNER_GUEST_RELEASE_SHA256",
  "RUNNER_RUNTIME_IMAGES_SHA256",
] as const;

export function buildProductionLoadCandidateFromActiveRelease(
  activeReleaseText: string,
  nucHostId: string,
  runnerVmId: string,
): ProductionLoadCandidate {
  if (!activeReleaseText.endsWith("\n") || activeReleaseText.includes("\r") || activeReleaseText.includes("\0")) {
    throw new Error("Production active-release state must be canonical LF text.");
  }
  const lines = activeReleaseText.slice(0, -1).split("\n");
  if (lines.length !== productionActiveReleaseFields.length) {
    throw new Error("Production active-release state contains unexpected or missing fields.");
  }
  const fields = new Map<string, string>();
  for (const [index, line] of lines.entries()) {
    const separator = line.indexOf("=");
    const key = separator > 0 ? line.slice(0, separator) : "";
    const value = separator > 0 ? line.slice(separator + 1) : "";
    if (key !== productionActiveReleaseFields[index] || !value || /\s/.test(value) || fields.has(key)) {
      throw new Error("Production active-release state is not canonical.");
    }
    fields.set(key, value);
  }
  if (fields.get("SCHEMA_VERSION") !== "1") {
    throw new Error("Production active-release state schema is unsupported.");
  }
  const provenanceHashFields = [
    "RELEASE_MANIFEST_SHA256",
    "APPLICATION_IMAGE_RECORD_SHA256",
    "MANAGED_INVENTORY_SHA256",
    "FIREWALL_POLICY_SHA256",
    "RUNNER_GUEST_RELEASE_SHA256",
    "RUNNER_RUNTIME_IMAGES_SHA256",
  ] as const;
  if (provenanceHashFields.some((field) => !/^[0-9a-f]{64}$/.test(fields.get(field)!))) {
    throw new Error("Production active-release provenance SHA256 identity is invalid.");
  }


  const candidate: ProductionLoadCandidate = {
    gitSha: fields.get("GIT_COMMIT")!,
    gitTree: fields.get("GIT_TREE")!,
    releaseManifestSha256: `sha256:${fields.get("RELEASE_MANIFEST_SHA256")!}`,
    applicationImageRecordSha256: `sha256:${fields.get("APPLICATION_IMAGE_RECORD_SHA256")!}`,
    composeProject: fields.get("COMPOSE_PROJECT")! as "learncoding",
    composeWorkdir: fields.get("COMPOSE_WORKDIR")! as "/opt/learncoding",
    publicOrigin: fields.get("PUBLIC_ORIGIN")!,
    managedInventorySha256: `sha256:${fields.get("MANAGED_INVENTORY_SHA256")!}`,
    firewallPolicySha256: `sha256:${fields.get("FIREWALL_POLICY_SHA256")!}`,
    runnerGuestReleaseSha256: `sha256:${fields.get("RUNNER_GUEST_RELEASE_SHA256")!}`,
    runnerImageRecordSha256: `sha256:${fields.get("RUNNER_RUNTIME_IMAGES_SHA256")!}`,
    nucHostId,
    runnerVmId,
    datasetId: "seed-20260715",
  };
  assertProductionCandidateIdentities(candidate);
  return candidate;
}



export function validateProductionLoadDecision(
  value: unknown,
  expectedCandidate: ProductionLoadCandidate,
): ProductionLoadDecision {
  if (!isRecord(value)) throw new Error("Production load decision must be an object.");
  assertProductionCandidateIdentities(expectedCandidate);
  assertExactFields(value, productionDecisionFields, "artifact");
  if (value.schemaVersion !== 1
    || value.scope !== "codestead-project-only"
    || value.status !== "approved") {
    throw new Error("Production load decision is not an approved schema-version-1 project decision.");
  }
  if (typeof value.approvedAt !== "string"
    || typeof value.approvedBy !== "string"
    || !value.approvedBy.trim()
    || typeof value.approvalReason !== "string"
    || !value.approvalReason.trim()) {
    throw new Error("Production load decision requires approval time, owner, and reason.");
  }
  const approvedAt = new Date(value.approvedAt);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.approvedAt)
    || !Number.isFinite(approvedAt.getTime())
    || approvedAt.toISOString() !== value.approvedAt) {
    throw new Error("Production load decision approval timestamp must be canonical UTC.");
  }

  if (!isRecord(value.candidate)) {
    throw new Error("Production load decision candidate is missing.");
  }
  assertExactFields(value.candidate, productionCandidateFields, "candidate fields");
  for (const field of productionCandidateFields) {
    if (value.candidate[field] !== expectedCandidate[field]) {
      throw new Error(`Production load decision candidate mismatch: ${field}.`);
    }
  }

  if (!isRecord(value.thresholds)) {
    throw new Error("Production load decision thresholds are missing.");
  }
  assertExactFields(value.thresholds, Object.keys(PRODUCTION_LOAD_THRESHOLDS), "threshold fields");
  for (const [name, expected] of Object.entries(PRODUCTION_LOAD_THRESHOLDS)) {
    if (value.thresholds[name] !== expected) {
      throw new Error(`Production load decision threshold mismatch: ${name}.`);
    }
  }

  return value as ProductionLoadDecision;
}

export type ProductionLoadResourceSample = {
  readonly hostCpuPercent: number;
  readonly availableMemoryBytes: number;
  readonly rootFreeFraction: number;
  readonly rootFreeBytes: number;
  readonly diskReadBytes: number;
  readonly diskWriteBytes: number;
  readonly postgresConnections: number;
  readonly postgresMaxConnections: number;
  readonly postgresDeadlocks: number;
  readonly postgresLockWaitMs: number;
  readonly temperatureCelsius: number;
  readonly oomKills: number;
  readonly thermalThrottleIncrements: number;
  readonly runnerQueueDepth: number;
  readonly runnerQueueWaitMs: number;
  readonly runnerRunningJobs: number;
  readonly runnerVmCpuPercent: number;
  readonly runnerVmAvailableMemoryBytes: number;
  readonly unrelatedServicesHealthy: boolean;
};

export type ProductionLoadResourceBaseline = {
  readonly oomKills: number;
  readonly thermalThrottleIncrements: number;
  readonly postgresDeadlocks: number;
};

export type ProductionLoadAbortDecision =
  | { readonly aborted: false }
  | {
    readonly aborted: true;
    readonly sampleIndex: number;
    readonly reason: string;
  };

export function evaluateProductionLoadAbort(
  samples: readonly ProductionLoadResourceSample[],
  baseline: ProductionLoadResourceBaseline,
): ProductionLoadAbortDecision {
  if (!isNonNegativeInteger(baseline.oomKills)
    || !isNonNegativeInteger(baseline.thermalThrottleIncrements)
    || !isNonNegativeInteger(baseline.postgresDeadlocks)) {
    return { aborted: true, sampleIndex: 0, reason: "invalid_resource_baseline" };
  }
  let consecutiveLowMemory = 0;
  let consecutiveLowRootCapacity = 0;
  for (const [sampleIndex, sample] of samples.entries()) {
    if (!Number.isFinite(sample.hostCpuPercent)
      || sample.hostCpuPercent < 0
      || sample.hostCpuPercent > 100
      || !isFiniteNonNegative(sample.rootFreeBytes)
      || !isFiniteNonNegative(sample.diskReadBytes)
      || !isFiniteNonNegative(sample.diskWriteBytes)
      || !isNonNegativeInteger(sample.postgresConnections)
      || !Number.isSafeInteger(sample.postgresMaxConnections)
      || sample.postgresMaxConnections <= 0
      || !isNonNegativeInteger(sample.postgresDeadlocks)
      || !isFiniteNonNegative(sample.postgresLockWaitMs)
      || !isNonNegativeInteger(sample.runnerQueueDepth)
      || !isFiniteNonNegative(sample.runnerQueueWaitMs)
      || !Number.isFinite(sample.runnerVmCpuPercent)
      || sample.runnerVmCpuPercent < 0
      || sample.runnerVmCpuPercent > 100
      || !isFiniteNonNegative(sample.runnerVmAvailableMemoryBytes)) {
      return { aborted: true, sampleIndex, reason: "invalid_resource_sample" };
    }
    if (!isFiniteNonNegative(sample.availableMemoryBytes)
      || !Number.isFinite(sample.rootFreeFraction)
      || sample.rootFreeFraction < 0
      || sample.rootFreeFraction > 1
      || !Number.isFinite(sample.temperatureCelsius)
      || !isNonNegativeInteger(sample.oomKills)
      || !isNonNegativeInteger(sample.thermalThrottleIncrements)
      || !isNonNegativeInteger(sample.runnerRunningJobs)
      || typeof sample.unrelatedServicesHealthy !== "boolean") {
      return { aborted: true, sampleIndex, reason: "invalid_resource_sample" };
    }
    const immediateReason =
      sample.temperatureCelsius >= PRODUCTION_LOAD_THRESHOLDS.maxTemperatureCelsius
        ? "temperature_at_or_above_90_celsius"
        : sample.oomKills > baseline.oomKills
          ? "new_oom_kill"
          : sample.thermalThrottleIncrements > baseline.thermalThrottleIncrements
            ? "new_thermal_throttle"
            : sample.runnerRunningJobs > PRODUCTION_LOAD_THRESHOLDS.maxConcurrentRunnerJobs
              ? "third_concurrent_runner_job"
              : !sample.unrelatedServicesHealthy
                ? "unrelated_service_regression"
                : null;
    if (immediateReason) {
      return { aborted: true, sampleIndex, reason: immediateReason };
    }
    consecutiveLowMemory = sample.availableMemoryBytes < PRODUCTION_LOAD_THRESHOLDS.minAvailableMemoryBytes
      ? consecutiveLowMemory + 1
      : 0;
    if (consecutiveLowMemory >= 2) {
      return {
        aborted: true,
        sampleIndex,
        reason: "available_memory_below_8_gib_twice",
      };
    }
    consecutiveLowRootCapacity = sample.rootFreeFraction < PRODUCTION_LOAD_THRESHOLDS.minRootFreeFraction
      ? consecutiveLowRootCapacity + 1
      : 0;
    if (consecutiveLowRootCapacity >= 2) {
      return {
        aborted: true,
        sampleIndex,
        reason: "root_capacity_below_15_percent_twice",
      };
    }
  }
  return { aborted: false };
}

export type ProductionLoadResultMetrics = {
  readonly normalHttp5xxTimeoutRate: number;
  readonly acknowledgedMutationFailures: number;
  readonly nonRunnerP95Ms: number;
  readonly nonRunnerP99Ms: number;
  readonly runnerAdmissionP95Ms: number;
  readonly runnerQueueWaitP95Ms: number;
  readonly runnerQueueWaitMaxMs: number;
  readonly componentRecoveryMaxMs: number;
  readonly queueDrainMaxMs: number;
  readonly alertVisibilityMaxMs: number;
  readonly postgresConnectionsPeak: number;
  readonly postgresMaxConnections: number;
  readonly postgresLockWaitP95Ms: number;
  readonly deadlocks: number;
  readonly duplicateOfficialEffects: number;
  readonly secretLeakFindings: number;
  readonly runnerMaxConcurrentJobs: number;
};

export function evaluateProductionLoadResult(
  metrics: ProductionLoadResultMetrics,
): { readonly passed: boolean; readonly failures: readonly string[] } {
  const failures: string[] = [];
  const failWhen = (condition: boolean, code: string) => {
    if (condition) failures.push(code);
  };
  const metricValidation = [
    ["normal_http_5xx_timeout_rate", metrics.normalHttp5xxTimeoutRate, "fraction"],
    ["acknowledged_mutation_failures", metrics.acknowledgedMutationFailures, "count"],
    ["non_runner_p95_ms", metrics.nonRunnerP95Ms, "number"],
    ["non_runner_p99_ms", metrics.nonRunnerP99Ms, "number"],
    ["runner_admission_p95_ms", metrics.runnerAdmissionP95Ms, "number"],
    ["runner_queue_wait_p95_ms", metrics.runnerQueueWaitP95Ms, "number"],
    ["runner_queue_wait_max_ms", metrics.runnerQueueWaitMaxMs, "number"],
    ["component_recovery_max_ms", metrics.componentRecoveryMaxMs, "number"],
    ["queue_drain_max_ms", metrics.queueDrainMaxMs, "number"],
    ["alert_visibility_max_ms", metrics.alertVisibilityMaxMs, "number"],
    ["postgres_connections_peak", metrics.postgresConnectionsPeak, "count"],
    ["postgres_max_connections", metrics.postgresMaxConnections, "positive_count"],
    ["postgres_lock_wait_p95_ms", metrics.postgresLockWaitP95Ms, "number"],
    ["deadlocks", metrics.deadlocks, "count"],
    ["duplicate_official_effects", metrics.duplicateOfficialEffects, "count"],
    ["secret_leak_findings", metrics.secretLeakFindings, "count"],
    ["runner_max_concurrent_jobs", metrics.runnerMaxConcurrentJobs, "count"],
  ] as const;
  for (const [name, value, kind] of metricValidation) {
    const valid = kind === "fraction"
      ? isFiniteNonNegative(value) && value <= 1
      : kind === "count"
        ? isNonNegativeInteger(value)
        : kind === "positive_count"
          ? Number.isSafeInteger(value) && value > 0
          : isFiniteNonNegative(value);
    failWhen(!valid, `invalid_metric_${name}`);
  }


  failWhen(
    metrics.normalHttp5xxTimeoutRate > PRODUCTION_LOAD_THRESHOLDS.normalHttpFailureRateMax,
    "normal_http_5xx_timeout_rate",
  );
  failWhen(
    metrics.acknowledgedMutationFailures > PRODUCTION_LOAD_THRESHOLDS.acknowledgedMutationFailuresMax,
    "acknowledged_mutation_failure",
  );
  failWhen(metrics.nonRunnerP95Ms > PRODUCTION_LOAD_THRESHOLDS.nonRunnerP95Ms, "non_runner_p95");
  failWhen(metrics.nonRunnerP99Ms > PRODUCTION_LOAD_THRESHOLDS.nonRunnerP99Ms, "non_runner_p99");
  failWhen(metrics.runnerAdmissionP95Ms > PRODUCTION_LOAD_THRESHOLDS.runnerAdmissionP95Ms, "runner_admission_p95");
  failWhen(metrics.runnerQueueWaitP95Ms > PRODUCTION_LOAD_THRESHOLDS.runnerQueueWaitP95Ms, "runner_queue_wait_p95");
  failWhen(metrics.runnerQueueWaitMaxMs > PRODUCTION_LOAD_THRESHOLDS.runnerQueueWaitMaxMs, "runner_queue_wait_max");
  failWhen(metrics.componentRecoveryMaxMs > PRODUCTION_LOAD_THRESHOLDS.componentRecoveryMaxMs, "component_recovery");
  failWhen(metrics.queueDrainMaxMs > PRODUCTION_LOAD_THRESHOLDS.queueDrainMaxMs, "queue_drain");
  failWhen(metrics.alertVisibilityMaxMs > PRODUCTION_LOAD_THRESHOLDS.alertVisibilityMaxMs, "alert_visibility");
  failWhen(
    metrics.postgresMaxConnections <= 0
      || metrics.postgresConnectionsPeak / metrics.postgresMaxConnections
        >= PRODUCTION_LOAD_THRESHOLDS.postgresConnectionsFractionMax,
    "postgres_connection_headroom",
  );
  failWhen(metrics.postgresLockWaitP95Ms > PRODUCTION_LOAD_THRESHOLDS.postgresLockWaitP95Ms, "postgres_lock_wait_p95");
  failWhen(metrics.deadlocks > PRODUCTION_LOAD_THRESHOLDS.deadlocksMax, "postgres_deadlock");
  failWhen(metrics.duplicateOfficialEffects > 0, "duplicate_official_effect");
  failWhen(metrics.secretLeakFindings > 0, "secret_leak_finding");
  failWhen(
    metrics.runnerMaxConcurrentJobs > PRODUCTION_LOAD_THRESHOLDS.maxConcurrentRunnerJobs,
    "runner_concurrency_exceeded",
  );

  return { passed: failures.length === 0, failures };
}

function rounded(value: number): number {
  return Math.round(value * 100) / 100;
}

export function percentile(values: readonly number[], fraction: number): number {
  if (!values.length) return 0;
  if (!Number.isFinite(fraction) || fraction < 0 || fraction > 1) {
    throw new RangeError("Percentile fraction must be between zero and one.");
  }
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(fraction * sorted.length) - 1);
  return rounded(sorted[index] ?? 0);
}

export function summarizeLoad(samples: readonly RequestSample[]): LoadSummary {
  const durations = samples.map((sample) => sample.durationMs);
  const statuses: Record<string, number> = {};
  const errors: Record<string, number> = {};
  let succeeded = 0;
  for (const sample of samples) {
    if (sample.ok) succeeded += 1;
    const status = sample.status === null ? "none" : String(sample.status);
    statuses[status] = (statuses[status] ?? 0) + 1;
    if (sample.errorCode) errors[sample.errorCode] = (errors[sample.errorCode] ?? 0) + 1;
  }
  const failed = samples.length - succeeded;
  return {
    requests: samples.length,
    succeeded,
    failed,
    errorRate: samples.length ? rounded(failed / samples.length) : 0,
    p50Ms: percentile(durations, 0.5),
    p95Ms: percentile(durations, 0.95),
    p99Ms: percentile(durations, 0.99),
    maxMs: rounded(Math.max(0, ...durations)),
    statuses,
    errors,
  };
}

export function assertLoadTarget(value: string, allowRemote = false): URL {
  const target = new URL(value);
  if (!['http:', 'https:'].includes(target.protocol)) {
    throw new Error("Load target must use HTTP or HTTPS.");
  }
  const loopback = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
  if (!allowRemote && !loopback.has(target.hostname)) {
    throw new Error("Remote load targets require explicit LOAD_ALLOW_REMOTE=1 authorization.");
  }
  if (target.username || target.password) {
    throw new Error("Do not place credentials in the load-test URL.");
  }
  target.pathname = target.pathname.replace(/\/$/, "");
  target.search = "";
  target.hash = "";
  return target;
}

export function resolveLoadReportPath(root: string, configured?: string | null): string | null {
  const value = configured?.trim();
  if (!value) return null;
  const absolute = path.resolve(root, value);
  const allowedRoots = [path.resolve(root, "docs", "evidence"), path.resolve(root, "test-results")];
  if (!allowedRoots.some((allowed) => absolute === allowed || absolute.startsWith(`${allowed}${path.sep}`))) {
    throw new Error("LOAD_REPORT_PATH must stay under docs/evidence or test-results.");
  }
  return absolute;
}

export function buildProductionLoadSchedule(): ProductionLoadSchedule {
  const learners = Array.from(
    { length: 10 },
    (_, index) => `synthetic-load-${String(index + 1).padStart(2, "0")}`,
  );
  const minutes: ProductionLoadMinute[] = [];

  for (let phaseMinute = 1; phaseMinute <= 10; phaseMinute += 1) {
    minutes.push({
      ordinal: minutes.length + 1,
      phase: "warmup",
      phaseMinute,
      activeLearnerIds: learners.slice(0, phaseMinute),
      submitCode: phaseMinute % 3 === 0,
    });
  }
  for (let phaseMinute = 1; phaseMinute <= 60; phaseMinute += 1) {
    minutes.push({
      ordinal: minutes.length + 1,
      phase: "sustained",
      phaseMinute,
      activeLearnerIds: learners,
      submitCode: phaseMinute % 3 === 0,
    });
  }
  for (let phaseMinute = 1; phaseMinute <= 10; phaseMinute += 1) {
    minutes.push({
      ordinal: minutes.length + 1,
      phase: "cooldown",
      phaseMinute,
      activeLearnerIds: learners.slice(0, 10 - phaseMinute),
      submitCode: false,
    });
  }

  return {
    seed: "seed-20260715",
    learners,
    minutes,
    sustainedTotals: {
      lessonReads: 1_200,
      dashboardReads: 600,
      reviewQuizCompletions: 600,
      autosaves: 1_200,
      codeJobs: 200,
    },
  };
}

export type ProductionLoadActionKind =
  | "lesson_read"
  | "dashboard_read"
  | "review_completion"
  | "quiz_completion"
  | "draft_autosave"
  | "exam_autosave"
  | "code_job";

export type ProductionLoadAction = {
  readonly ordinal: number;
  readonly phase: ProductionLoadPhase;
  readonly phaseMinute: number;
  readonly learnerId: string;
  readonly kind: ProductionLoadActionKind;
  readonly occurrence: number;
  readonly requestId: string;
};

export function buildProductionLoadActions(
  schedule: ProductionLoadSchedule = buildProductionLoadSchedule(),
): readonly ProductionLoadAction[] {
  const actions: ProductionLoadAction[] = [];
  for (const minute of schedule.minutes) {
    for (const learnerId of minute.activeLearnerIds) {
      const reviewKind: ProductionLoadActionKind = minute.phaseMinute % 2 === 1
        ? "review_completion"
        : "quiz_completion";
      const specifications: readonly (readonly [ProductionLoadActionKind, number])[] = [
        ["lesson_read", 1],
        ["lesson_read", 2],
        ["dashboard_read", 1],
        [reviewKind, 1],
        ["draft_autosave", 1],
        ["exam_autosave", 1],
        ...(minute.submitCode ? [["code_job", 1] as const] : []),
      ];
      for (const [kind, occurrence] of specifications) {
        actions.push({
          ordinal: minute.ordinal,
          phase: minute.phase,
          phaseMinute: minute.phaseMinute,
          learnerId,
          kind,
          occurrence,
          requestId: deterministicUuid(schedule.seed, `${minute.ordinal}:${learnerId}:${kind}:${occurrence}`),
        });
      }
    }
  }
  return actions;
}

export function buildProductionSamplingOffsets(durationMs: number): readonly number[] {
  const intervalMs = 5_000;
  if (!Number.isSafeInteger(durationMs) || durationMs <= 0 || durationMs % intervalMs !== 0) {
    throw new Error("Production load duration must be a positive whole five-second interval.");
  }
  return Array.from({ length: durationMs / intervalMs }, (_, index) => index * intervalMs);
}

const permittedSensitiveEvidenceFields = new Set(["secretleakfindings"]);
const sensitiveEvidenceFieldFragments = [
  "password",
  "passwd",
  "token",
  "email",
  "cookie",
  "authorization",
  "credential",
  "apikey",
  "privatekey",
  "clientsecret",
  "sharedsecret",
  "sessionid",
  "sessiontoken",
  "databaseurl",
  "dburl",
  "connectionstring",
  "totp",
  "recoverycode",
  "backupidentity",
  "backupkey",
] as const;
const sensitiveEvidenceValue =
  /authorization\s*:\s*bearer\s+|(?:^|\s)bearer\s+[A-Za-z0-9._~+\/-]{8,}|(?:^|\s)nvapi-[A-Za-z0-9_-]+|(?:^|\s)(?:sk-|21st_sk_)[A-Za-z0-9_-]{8,}|(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/|\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b|otpauth:\/\/|totp(?:\s+seed)?\s*[:=]|recovery\s*code\s*[:=]|-----BEGIN [A-Z ]*PRIVATE KEY-----/i;

export function assertProductionLoadEvidenceSafe<T>(value: T): T {
  const seen = new WeakSet<object>();
  const visit = (node: unknown): void => {
    if (node === null || typeof node === "boolean") return;
    if (typeof node === "number") {
      if (!Number.isFinite(node)) throw new Error("Load evidence contains a non-finite number.");
      return;
    }
    if (typeof node === "string") {
      if (sensitiveEvidenceValue.test(node)) {
        throw new Error("Load evidence contains a secret-bearing value.");
      }
      return;
    }
    if (typeof node !== "object") {
      throw new Error("Load evidence contains a non-JSON value.");
    }
    if (seen.has(node)) throw new Error("Load evidence contains a cyclic value.");
    seen.add(node);
    if (Array.isArray(node)) {
      for (const entry of node) visit(entry);
      return;
    }
    const prototype = Object.getPrototypeOf(node);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error("Load evidence contains a non-plain object.");
    }
    for (const [key, entry] of Object.entries(node)) {
      const normalizedKey = key.replace(/[-_]/g, "").toLowerCase();
      if (!permittedSensitiveEvidenceFields.has(normalizedKey)
        && sensitiveEvidenceFieldFragments.some((fragment) => normalizedKey.includes(fragment))) {
        throw new Error("Load evidence contains a secret-bearing field.");
      }
      visit(entry);
    }
  };
  visit(value);
  return value;
}

export type ProductionLoadSeedPlan = {
  readonly datasetId: "seed-20260715";
  readonly learners: readonly {
    readonly id: string;
    readonly alias: string;
    readonly email: string;
  }[];
  readonly lessons: readonly {
    readonly id: string;
    readonly slug: string;
    readonly position: number;
  }[];
  readonly prompts: readonly {
    readonly id: string;
    readonly learnerId: string;
    readonly lessonId: string;
    readonly kind: "review" | "quiz";
    readonly position: number;
  }[];
  readonly drafts: readonly {
    readonly id: string;
    readonly learnerId: string;
    readonly courseId: "synthetic-load";
    readonly skillId: string;
    readonly kind: "lesson" | "code";
    readonly language: "python" | null;
  }[];
  readonly providerCredentials: readonly [];
};

export function buildProductionLoadSeedPlan(): ProductionLoadSeedPlan {
  const datasetId = "seed-20260715" as const;
  const learners = Array.from({ length: 10 }, (_, index) => {
    const alias = `synthetic-load-${String(index + 1).padStart(2, "0")}`;
    return {
      id: deterministicUuid(datasetId, `learner:${alias}`),
      alias,
      email: `${alias}@example.invalid`,
    };
  });
  const lessons = Array.from({ length: 30 }, (_, index) => ({
    id: deterministicUuid(datasetId, `lesson:${index + 1}`),
    slug: `synthetic-load-lesson-${String(index + 1).padStart(2, "0")}`,
    position: index + 1,
  }));
  const prompts = learners.flatMap((learner, learnerIndex) =>
    Array.from({ length: 5 }, (_, promptIndex) => {
      const lesson = lessons[(learnerIndex * 5 + promptIndex) % lessons.length]!;
      const position = promptIndex + 1;
      return {
        id: deterministicUuid(datasetId, `prompt:${learner.alias}:${position}`),
        learnerId: learner.id,
        lessonId: lesson.id,
        kind: position % 2 === 1 ? "review" as const : "quiz" as const,
        position,
      };
    }),
  );
  const drafts = learners.flatMap((learner, learnerIndex) =>
    Array.from({ length: 10 }, (_, draftIndex) => {
      const lesson = lessons[(learnerIndex * 10 + draftIndex) % lessons.length]!;
      const kind = draftIndex % 2 === 0 ? "lesson" as const : "code" as const;
      return {
        id: deterministicUuid(datasetId, `draft:${learner.alias}:${draftIndex + 1}`),
        learnerId: learner.id,
        courseId: "synthetic-load" as const,
        skillId: lesson.id,
        kind,
        language: kind === "code" ? "python" as const : null,
      };
    }),
  );

  return {
    datasetId,
    learners,
    lessons,
    prompts,
    drafts,
    providerCredentials: [],
  };
}

export type ProductionWorkloadTotals = {
  readonly lessonReads: number;
  readonly dashboardReads: number;
  readonly reviewQuizCompletions: number;
  readonly autosaves: number;
  readonly codeJobs: number;
};

export function evaluateProductionWorkloadTotals(observed: ProductionWorkloadTotals): {
  readonly passed: boolean;
  readonly failures: readonly string[];
} {
  const expected = buildProductionLoadSchedule().sustainedTotals;
  const checks = [
    ["lessonReads", "workload_total_lesson_reads"],
    ["dashboardReads", "workload_total_dashboard_reads"],
    ["reviewQuizCompletions", "workload_total_review_quiz_completions"],
    ["autosaves", "workload_total_autosaves"],
    ["codeJobs", "workload_total_code_jobs"],
  ] as const;
  const failures = checks.flatMap(([key, failure]) =>
    isNonNegativeInteger(observed[key]) && observed[key] === expected[key] ? [] : [failure],
  );
  return { passed: failures.length === 0, failures };
}
