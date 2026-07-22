import {
  PRODUCTION_LOAD_FAULT_MATRIX,
  PRODUCTION_LOAD_THRESHOLDS,
  assertProductionLoadEvidenceSafe,
  buildProductionLoadActions,
  buildProductionLoadSchedule,
  evaluateProductionLoadAbort,
  evaluateProductionLoadResult,
  evaluateProductionWorkloadTotals,
  percentile,
  type ProductionLoadCandidate,
  type ProductionLoadResourceBaseline,
  type ProductionLoadResultMetrics,
} from "../../src/lib/performance/load-report";
import type {
  ProductionFaultInvariantEvidence,
  ProductionFaultMatrixResult,
} from "./production-load-faults";
import type {
  ProductionLoadActionObservation,
  ProductionLoadHttpRequestObservation,
  ProductionLoadWorkloadResult,
} from "./production-load-workload";

export type ProductionLoadGateReport = {
  readonly schemaVersion: 1;
  readonly generatedAt: string;
  readonly decisionSha256: string;
  readonly candidate: ProductionLoadCandidate;
  readonly thresholds: typeof PRODUCTION_LOAD_THRESHOLDS;
  readonly baseline: ProductionLoadResourceBaseline;
  readonly metrics: ProductionLoadResultMetrics;
  readonly failures: readonly string[];
  readonly verdict: "PASS" | "FAIL";
  readonly workload: ProductionLoadWorkloadResult;
  readonly faultMatrix: ProductionFaultMatrixResult;
};

export type BuildProductionLoadGateReportInput = {
  readonly generatedAt: string;
  readonly decisionSha256: string;
  readonly candidate: ProductionLoadCandidate;
  readonly baseline: ProductionLoadResourceBaseline;
  readonly workload: ProductionLoadWorkloadResult;
  readonly faults: ProductionFaultMatrixResult;
};

const mutationKinds = new Set<ProductionLoadActionObservation["kind"]>([
  "review_completion",
  "quiz_completion",
  "draft_autosave",
  "exam_autosave",
  "code_job",
]);

function isCanonicalUtc(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function finiteNonNegative(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

function nonNegativeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

const httpRequestEvidenceKeys = [
  "acknowledged",
  "durationMs",
  "method",
  "mutation",
  "ok",
  "route",
  "sequence",
  "status",
  "timedOut",
].sort();

function validHttpRequestEvidence(
  value: unknown,
  sequence: number,
): value is ProductionLoadHttpRequestObservation {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const request = value as Record<string, unknown>;
  const actualKeys = Object.keys(request).sort();
  const methodValid = request.method === "GET" || request.method === "POST" || request.method === "PUT";
  const mutation = request.method === "POST" || request.method === "PUT";
  const statusValid = request.status === null
    || (Number.isSafeInteger(request.status)
      && Number(request.status) >= 100
      && Number(request.status) <= 599);
  const successfulStatus = typeof request.status === "number"
    && request.status >= 200
    && request.status < 300;
  return actualKeys.length === httpRequestEvidenceKeys.length
    && actualKeys.every((key, index) => key === httpRequestEvidenceKeys[index])
    && request.sequence === sequence
    && methodValid
    && typeof request.route === "string"
    && /^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]{1,511}$/.test(request.route)
    && typeof request.durationMs === "number"
    && finiteNonNegative(request.durationMs)
    && statusValid
    && typeof request.timedOut === "boolean"
    && request.mutation === mutation
    && request.ok === (successfulStatus && !request.timedOut)
    && request.acknowledged === (mutation && successfulStatus);
}

function validFaultInvariantEvidence(
  value: unknown,
): value is ProductionFaultInvariantEvidence {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  const expectedKeys = [
    "acknowledgedMutationFailures",
    "duplicateOfficialEffects",
    "secretLeakFindings",
    "runnerMaxConcurrentJobs",
  ].sort();
  const actualKeys = Object.keys(item).sort();
  return actualKeys.length === expectedKeys.length
    && actualKeys.every((key, index) => key === expectedKeys[index])
    && expectedKeys.every((key) => nonNegativeInteger(item[key] as number));
}

function maxOrZero(values: readonly number[]): number {
  return values.length ? Math.max(...values) : 0;
}

export function buildProductionLoadGateReport(
  input: BuildProductionLoadGateReportInput,
): ProductionLoadGateReport {
  if (!isCanonicalUtc(input.generatedAt)) {
    throw new Error("Production load report generatedAt must be canonical UTC.");
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(input.decisionSha256)) {
    throw new Error("Production load report decision identity is invalid.");
  }

  const failures: string[] = [];
  const addFailure = (code: string) => {
    if (!failures.includes(code)) failures.push(code);
  };
  const expectedActions = buildProductionLoadActions();
  const actions = input.workload.actions;
  const physicalRequests: ProductionLoadHttpRequestObservation[] = [];
  const nonRunnerRequestDurations: number[] = [];
  if (actions.length !== expectedActions.length) addFailure("workload_action_contract");
  for (let index = 0; index < Math.min(actions.length, expectedActions.length); index += 1) {
    const observed = actions[index]!;
    const expected = expectedActions[index]!;
    if (observed.requestId !== expected.requestId
      || observed.kind !== expected.kind
      || observed.phase !== expected.phase
      || !finiteNonNegative(observed.durationMs)
      || typeof observed.ok !== "boolean"
      || (observed.status !== null
        && (!Number.isSafeInteger(observed.status) || observed.status < 100 || observed.status > 599))
      || typeof observed.acknowledged !== "boolean"
      || !nonNegativeInteger(observed.duplicateOfficialEffects)) {
      addFailure("workload_action_contract");
    }
    const expectedRequestCount = observed.kind === "review_completion"
      || observed.kind === "quiz_completion"
      ? 2
      : 1;
    const requestEvidence = Array.isArray(observed.httpRequests)
      ? observed.httpRequests
      : [];
    if (requestEvidence.length !== expectedRequestCount) {
      addFailure("workload_action_contract");
    }
    let requestDurationTotal = 0;
    for (const [requestIndex, request] of requestEvidence.entries()) {
      if (!validHttpRequestEvidence(request, requestIndex)) {
        addFailure("workload_action_contract");
        continue;
      }
      physicalRequests.push(request);
      requestDurationTotal += request.durationMs;
      if (observed.kind !== "code_job") {
        nonRunnerRequestDurations.push(request.durationMs);
      }
    }
    const lastRequest = requestEvidence.at(-1);
    const requestAcknowledged = requestEvidence.some((request) => request.acknowledged === true);
    const expectedAcknowledged = mutationKinds.has(observed.kind)
      ? requestAcknowledged
      : observed.ok;
    if ((lastRequest !== undefined && observed.status !== lastRequest.status)
      || (finiteNonNegative(observed.durationMs) && observed.durationMs < requestDurationTotal)
      || (observed.ok && requestEvidence.some((request) => request.ok !== true))
      || observed.acknowledged !== expectedAcknowledged) {
      addFailure("workload_action_contract");
    }
    if (!observed.ok) addFailure("unexpected_action_failure");
  }

  const runnerActions = actions.filter((action) => action.kind === "code_job");
  const runnerAdmissionValues: number[] = [];
  const runnerQueueWaitValues: number[] = [];
  for (const action of runnerActions) {
    if (!finiteNonNegative(action.runnerAdmissionMs ?? Number.NaN)
      || !finiteNonNegative(action.runnerQueueWaitMs ?? Number.NaN)) {
      addFailure("runner_observation_missing_latency");
      continue;
    }
    runnerAdmissionValues.push(action.runnerAdmissionMs!);
    runnerQueueWaitValues.push(action.runnerQueueWaitMs!);
  }

  const schedule = buildProductionLoadSchedule();
  const expectedOffsets = Array.from({ length: 960 }, (_, index) => index * 5_000);
  const workloadStartedAtMs = Date.parse(input.workload.startedAt);
  if (!isCanonicalUtc(input.workload.startedAt)
    || !isCanonicalUtc(input.workload.completedAt)
    || !Number.isFinite(workloadStartedAtMs)
    || input.workload.resourceSamples.length !== expectedOffsets.length) {
    addFailure("resource_sample_cadence");
  }
  for (let index = 0; index < input.workload.resourceSamples.length; index += 1) {
    const sample = input.workload.resourceSamples[index]!;
    const expectedOffset = expectedOffsets[index];
    const minute = schedule.minutes[Math.floor(index / 12)];
    const observedAtMs = Date.parse(sample.observedAt);
    if (expectedOffset === undefined
      || minute === undefined
      || sample.sampleIndex !== index
      || sample.scheduledOffsetMs !== expectedOffset
      || sample.phase !== minute.phase
      || sample.phaseMinute !== minute.phaseMinute
      || !isCanonicalUtc(sample.observedAt)
      || !Number.isFinite(observedAtMs)
      || observedAtMs < workloadStartedAtMs + expectedOffset
      || observedAtMs > workloadStartedAtMs + expectedOffset + 5_000) {
      addFailure("resource_sample_cadence");
      break;
    }
  }

  const recomputedAbort = evaluateProductionLoadAbort(
    input.workload.resourceSamples,
    input.baseline,
  );
  if (recomputedAbort.aborted) addFailure(`resource_abort_${recomputedAbort.reason}`);
  if (input.workload.abort.aborted) addFailure("workload_aborted");

  for (const code of evaluateProductionWorkloadTotals(
    input.workload.observedSustainedTotals,
  ).failures) {
    addFailure(code);
  }

  const postgresMaxValues = input.workload.resourceSamples.map(
    (sample) => sample.postgresMaxConnections,
  );
  if (new Set(postgresMaxValues).size > 1) addFailure("postgres_max_connections_changed");
  const deadlockPeak = maxOrZero(input.workload.resourceSamples.map(
    (sample) => sample.postgresDeadlocks,
  ));
  let deadlocks = deadlockPeak - input.baseline.postgresDeadlocks;
  if (!nonNegativeInteger(deadlocks)) {
    addFailure("postgres_deadlock_counter_regressed");
    deadlocks = Number.MAX_SAFE_INTEGER;
  }

  if (input.faults.scope !== "codestead-project-only"
    || input.faults.cases.length !== PRODUCTION_LOAD_FAULT_MATRIX.length) {
    addFailure("fault_matrix_contract");
  }
  const invariantEvidence: ProductionFaultInvariantEvidence[] = [];
  for (let index = 0; index < Math.min(
    input.faults.cases.length,
    PRODUCTION_LOAD_FAULT_MATRIX.length,
  ); index += 1) {
    const observed = input.faults.cases[index]!;
    const expected = PRODUCTION_LOAD_FAULT_MATRIX[index]!;
    const invariantsValid = validFaultInvariantEvidence(observed.invariants);
    if (observed.faultId !== expected.id
      || observed.passed !== true
      || observed.healthyBaselineMs !== expected.healthyBaselineMs
      || observed.baselineSamples !== 24
      || observed.faultDurationMs > expected.faultMaxMs
      || observed.componentRecoveryMs > expected.recoveryMaxMs
      || observed.queueDrainMs > PRODUCTION_LOAD_THRESHOLDS.queueDrainMaxMs
      || observed.alertOrDeadLetterVisibilityMs > PRODUCTION_LOAD_THRESHOLDS.alertVisibilityMaxMs
      || observed.invariantCheckMs !== expected.invariantCheckMs
      || !observed.steadyBrowserJourneyPassed
      || !observed.recoveredBrowserJourneyPassed
      || !invariantsValid) {
      addFailure("fault_matrix_contract");
    }
    if (invariantsValid) invariantEvidence.push(observed.invariants);
  }

  const invariantAcknowledgedMutationFailures = maxOrZero(invariantEvidence.map(
    (entry) => entry.acknowledgedMutationFailures,
  ));
  const invariantDuplicateOfficialEffects = maxOrZero(invariantEvidence.map(
    (entry) => entry.duplicateOfficialEffects,
  ));
  const invariantSecretLeakFindings = maxOrZero(invariantEvidence.map(
    (entry) => entry.secretLeakFindings,
  ));
  const invariantRunnerMaxConcurrentJobs = maxOrZero(invariantEvidence.map(
    (entry) => entry.runnerMaxConcurrentJobs,
  ));

  const serverOrTimeoutFailures = physicalRequests.filter(
    (request) => request.timedOut || request.status === null || request.status >= 500,
  ).length;
  const metrics: ProductionLoadResultMetrics = {
    normalHttp5xxTimeoutRate: physicalRequests.length
      ? serverOrTimeoutFailures / physicalRequests.length
      : 1,
    acknowledgedMutationFailures: Math.max(
      actions.filter((action) => mutationKinds.has(action.kind) && action.acknowledged && !action.ok).length,
      invariantAcknowledgedMutationFailures,
    ),
    nonRunnerP95Ms: percentile(nonRunnerRequestDurations, 0.95),
    nonRunnerP99Ms: percentile(nonRunnerRequestDurations, 0.99),
    runnerAdmissionP95Ms: percentile(runnerAdmissionValues, 0.95),
    runnerQueueWaitP95Ms: percentile(runnerQueueWaitValues, 0.95),
    runnerQueueWaitMaxMs: maxOrZero(runnerQueueWaitValues),
    componentRecoveryMaxMs: maxOrZero(input.faults.cases.map(
      (entry) => entry.componentRecoveryMs,
    )),
    queueDrainMaxMs: maxOrZero(input.faults.cases.map((entry) => entry.queueDrainMs)),
    alertVisibilityMaxMs: maxOrZero(input.faults.cases.map(
      (entry) => entry.alertOrDeadLetterVisibilityMs,
    )),
    postgresConnectionsPeak: maxOrZero(input.workload.resourceSamples.map(
      (sample) => sample.postgresConnections,
    )),
    postgresMaxConnections: postgresMaxValues.length ? Math.min(...postgresMaxValues) : 0,
    postgresLockWaitP95Ms: percentile(input.workload.resourceSamples.map(
      (sample) => sample.postgresLockWaitMs,
    ), 0.95),
    deadlocks,
    duplicateOfficialEffects: Math.max(
      actions.reduce((total, action) => total + action.duplicateOfficialEffects, 0),
      invariantDuplicateOfficialEffects,
    ),
    secretLeakFindings: invariantSecretLeakFindings,
    runnerMaxConcurrentJobs: Math.max(
      maxOrZero(input.workload.resourceSamples.map((sample) => sample.runnerRunningJobs)),
      invariantRunnerMaxConcurrentJobs,
    ),
  };
  for (const code of evaluateProductionLoadResult(metrics).failures) addFailure(code);

  const report: ProductionLoadGateReport = {
    schemaVersion: 1,
    generatedAt: input.generatedAt,
    decisionSha256: input.decisionSha256,
    candidate: input.candidate,
    thresholds: PRODUCTION_LOAD_THRESHOLDS,
    baseline: input.baseline,
    metrics,
    failures,
    verdict: failures.length === 0 ? "PASS" : "FAIL",
    workload: input.workload,
    faultMatrix: input.faults,
  };
  return assertProductionLoadEvidenceSafe(report);
}
