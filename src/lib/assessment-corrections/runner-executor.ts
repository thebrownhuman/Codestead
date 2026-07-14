import { createHash } from "node:crypto";

import type { ExamFormSnapshot, ExamRunnerResult } from "@/lib/exams/contracts";
import {
  admitRunnerJob,
  beginRunnerDispatch,
  hashRunnerAdmissionRequest,
  recordRunnerDispatch,
  refreshRunnerAdmission,
  RunnerAdmissionError,
  settleRunnerJob,
  type RunnerAdmission,
} from "@/lib/runner/admission";
import {
  configuredRunnerClient,
  RunnerClientError,
  RunnerIndeterminateError,
  runtimeByLanguage,
  type RunnerJobResponse,
  type RunnerLanguage,
} from "@/lib/runner/client";

import { AssessmentCorrectionError } from "./domain";

const EXECUTION_LIMITS = Object.freeze({
  wallTimeMs: 5_000,
  memoryMb: 128,
  cpuCount: 0.5,
  pids: 32,
  outputBytes: 65_536,
  fileBytes: 16_777_216,
});

export interface RegradeExecutionInput {
  readonly jobId: string;
  readonly jobAttemptCount: number;
  readonly runnerRequestGeneration: number;
  readonly correctionId: string;
  readonly attemptId: string;
  readonly userId: string;
  readonly itemId: string;
  readonly language: RunnerLanguage;
  readonly expectedRuntimeVersion: string;
  readonly sourceCode: string;
  readonly evidence: Extract<ExamFormSnapshot["items"][number]["gradingEvidence"], { kind: "runner-tests" }>;
  readonly expectedRuntimeImageDigest: string;
}

export interface RegradeExecutor {
  execute(input: RegradeExecutionInput): Promise<ExamRunnerResult>;
}

function stableId(prefix: string, value: string): string {
  return `${prefix}-${createHash("sha256").update(value).digest("hex").slice(0, 48)}`;
}

export function regradeRunnerAttemptKey(input: {
  readonly jobId: string;
  readonly runnerRequestGeneration: number;
  readonly itemId: string;
}) {
  return `${input.jobId}:runner-${input.runnerRequestGeneration}:${input.itemId}`;
}

export function regradeRunnerAdmissionRequestId(input: {
  readonly jobId: string;
  readonly runnerRequestGeneration: number;
  readonly itemId: string;
}) {
  return stableId("correction-admission", regradeRunnerAttemptKey(input));
}

function normalizeRunnerResult(
  job: RunnerJobResponse,
  sourceHash: string,
  fallbackRuntimeVersion: string,
  bundleVersion: string,
  startedAt: Date,
  finishedAt: Date,
): ExamRunnerResult {
  const raw = job.result;
  if (!raw || job.state !== "COMPLETED") {
    throw new AssessmentCorrectionError("RUNNER_INFRASTRUCTURE_FAILURE");
  }
  const compileStatus = new Set([
    "OK", "COMPILE_ERROR", "TIMEOUT", "MEMORY_LIMIT", "OUTPUT_LIMIT", "INFRASTRUCTURE_ERROR",
  ]).has(raw.compile.status) ? raw.compile.status as ExamRunnerResult["compile"]["status"] : "INFRASTRUCTURE_ERROR";
  const resultStatus = new Set([
    "COMPILE_ONLY", "ACCEPTED", "WRONG_ANSWER", "COMPILE_ERROR", "RUNTIME_ERROR",
    "TIMEOUT", "MEMORY_LIMIT", "OUTPUT_LIMIT", "INFRASTRUCTURE_ERROR",
  ]).has(raw.status) ? raw.status as ExamRunnerResult["status"] : "INFRASTRUCTURE_ERROR";
  return {
    status: resultStatus,
    requestHash: job.requestHash,
    sourceHash,
    runtimeVersion: raw.runtimeVersion || fallbackRuntimeVersion,
    imageDigest: raw.imageDigest,
    testBundleVersion: bundleVersion,
    compile: {
      status: compileStatus,
      exitCode: raw.compile.exitCode,
      stdout: raw.compile.stdout,
      stderr: raw.compile.stderr,
      wallTimeMs: 0,
    },
    ...(raw.run ? { run: { ...raw.run } } : {}),
    tests: raw.tests.map((test) => ({
      id: test.id,
      visibility: test.visibility === "HIDDEN" ? "HIDDEN" : "VISIBLE",
      category: test.category,
      status: new Set([
        "PASSED", "FAILED", "RUNTIME_ERROR", "TIMEOUT", "MEMORY_LIMIT", "OUTPUT_LIMIT", "INFRASTRUCTURE_ERROR",
      ]).has(test.status) ? test.status as ExamRunnerResult["tests"][number]["status"] : "INFRASTRUCTURE_ERROR",
      feedbackCode: test.feedbackCode,
      exitCode: null,
      wallTimeMs: 0,
    })),
    totals: raw.totals,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
  };
}

function storedRegradeRunnerResult(admission: RunnerAdmission): ExamRunnerResult | null {
  const stored = admission.result;
  if (
    (admission.status !== "succeeded" && admission.status !== "timed_out")
    || !stored
    || typeof stored.status !== "string"
    || typeof stored.requestHash !== "string"
    || typeof stored.sourceHash !== "string"
    || typeof stored.runtimeVersion !== "string"
    || typeof stored.imageDigest !== "string"
    || typeof stored.compile !== "object"
    || !Array.isArray(stored.tests)
    || typeof stored.totals !== "object"
  ) return null;
  return stored as unknown as ExamRunnerResult;
}

async function reconcileRegradeRunnerResult(admission: RunnerAdmission) {
  const refreshed = await refreshRunnerAdmission(admission);
  const result = storedRegradeRunnerResult(refreshed);
  if (result) return result;
  if (["queued", "leased", "running"].includes(refreshed.status)) {
    throw new AssessmentCorrectionError("RUNNER_INDETERMINATE");
  }
  throw new AssessmentCorrectionError("RUNNER_CAPACITY_BUSY");
}

async function reconcileAfterRegradePersistenceAmbiguity(admission: RunnerAdmission) {
  try {
    return await reconcileRegradeRunnerResult(admission);
  } catch (error) {
    if (
      error instanceof AssessmentCorrectionError
      && (error.code === "RUNNER_INDETERMINATE" || error.code === "RUNNER_CAPACITY_BUSY")
    ) {
      throw error;
    }
    throw new AssessmentCorrectionError("RUNNER_INDETERMINATE");
  }
}

export const configuredRegradeExecutor: RegradeExecutor = {
  async execute(input) {
    const runtime = runtimeByLanguage[input.language];
    const sourceHash = createHash("sha256").update(input.sourceCode).digest("hex");
    const queuedAt = new Date();
    const attemptKey = regradeRunnerAttemptKey(input);
    const requestId = regradeRunnerAdmissionRequestId(input);
    const request = {
      submissionId: stableId("correction-submission", attemptKey),
      correlationId: stableId("correction-correlation", input.correctionId),
      language: input.language,
      runtimeVersion: input.expectedRuntimeVersion,
      mode: "TEST" as const,
      sourceFiles: [{ path: runtime.entrypoint, content: input.sourceCode }],
      entrypoint: runtime.entrypoint,
      tests: input.evidence.tests.map((test) => ({
        id: test.id,
        visibility: test.visibility,
        category: test.category,
        stdin: test.stdin,
        expectedStdout: test.expectedStdout,
        comparison: test.comparison,
      })),
      testBundleVersion: input.evidence.bundleVersion,
      limits: { ...EXECUTION_LIMITS },
    };
    const requestHash = hashRunnerAdmissionRequest({
      schemaVersion: 1,
      userId: input.userId,
      attemptId: input.attemptId,
      itemId: input.itemId,
      correctionId: input.correctionId,
      expectedRuntimeImageDigest: input.expectedRuntimeImageDigest,
      sourceHash,
      request,
    });
    let admission: RunnerAdmission;
    try {
      admission = await admitRunnerJob({
        userId: input.userId,
        attemptId: input.attemptId,
        language: input.language,
        sourceCode: input.sourceCode,
        sourceHash,
        submissionType: "assessment_correction_regrade",
        requestId,
        requestHash,
        limits: EXECUTION_LIMITS,
        now: queuedAt,
      });
    } catch (error) {
      if (error instanceof RunnerAdmissionError && error.code === "OFFICIAL_CAPACITY_BUSY") {
        throw new AssessmentCorrectionError("RUNNER_CAPACITY_BUSY");
      }
      if (error instanceof RunnerAdmissionError && error.code === "IDEMPOTENCY_MISMATCH") {
        throw new AssessmentCorrectionError("IDEMPOTENCY_MISMATCH");
      }
      if (error instanceof RunnerAdmissionError && error.code === "USER_NOT_ACTIVE") {
        throw new AssessmentCorrectionError("LEARNER_NOT_ACTIVE");
      }
      throw error;
    }
    if (admission.duplicate && !["queued", "leased", "running"].includes(admission.status)) {
      const replay = storedRegradeRunnerResult(admission);
      if (replay) return replay;
      throw new AssessmentCorrectionError("RUNNER_CAPACITY_BUSY");
    }
    let remoteJobId = admission.remoteJobId;
    let trustedRemoteResponseReceived = false;
    let trustedTerminalResponseReceived = false;
    try {
      const client = configuredRunnerClient();
      const idempotencyKey = stableId("correction-idempotency", attemptKey);
      const dispatchBoundary = await beginRunnerDispatch({ admission });
      if (dispatchBoundary.replayed) return reconcileRegradeRunnerResult(admission);
      const submitted = dispatchBoundary.remoteJobId
        ? await client.waitForJob(dispatchBoundary.remoteJobId, request)
        : await client.submit(request, idempotencyKey);
      trustedRemoteResponseReceived = true;
      remoteJobId = dispatchBoundary.remoteJobId ?? submitted.jobId;
      if (!dispatchBoundary.remoteJobId && (submitted.state === "QUEUED" || submitted.state === "RUNNING")) {
        let dispatch;
        try {
          dispatch = await recordRunnerDispatch({
            admission,
            remoteJobId: submitted.jobId,
            status: submitted.state === "QUEUED" ? "queued" : "running",
          });
        } catch (error) {
          if (error instanceof RunnerAdmissionError && error.code === "REMOTE_JOB_ID_MISMATCH") {
            throw new AssessmentCorrectionError("RUNNER_INDETERMINATE");
          }
          return reconcileAfterRegradePersistenceAmbiguity(admission);
        }
        if (dispatch.replayed) return reconcileRegradeRunnerResult(admission);
      }
      const completed = !dispatchBoundary.remoteJobId
        && (submitted.state === "QUEUED" || submitted.state === "RUNNING")
        ? await client.waitFrom(submitted, request)
        : submitted;
      trustedTerminalResponseReceived = completed.state === "COMPLETED" || completed.state === "FAILED";
      const completedAt = new Date();
      const result = normalizeRunnerResult(
        completed,
        sourceHash,
        input.expectedRuntimeVersion,
        input.evidence.bundleVersion,
        queuedAt,
        completedAt,
      );
      if (
        result.runtimeVersion !== input.expectedRuntimeVersion
        || result.imageDigest !== input.expectedRuntimeImageDigest
      ) {
        throw new AssessmentCorrectionError("RUNNER_INFRASTRUCTURE_FAILURE");
      }
      const status = result.status === "TIMEOUT" ? "timed_out"
        : result.status === "INFRASTRUCTURE_ERROR" ? "failed"
          : "succeeded";
      let settlement;
      try {
        settlement = await settleRunnerJob({
          admission,
          status,
          remoteJobId: completed.jobId,
          result: JSON.parse(JSON.stringify(result)) as Record<string, unknown>,
          runtimeImageDigest: result.imageDigest,
          startedAt: queuedAt,
          completedAt,
        });
      } catch {
        return reconcileAfterRegradePersistenceAmbiguity(admission);
      }
      if (settlement.replayed) return reconcileRegradeRunnerResult(admission);
      return result;
    } catch (error) {
      const unresolvedReplay = admission.duplicate
        && !trustedRemoteResponseReceived
        && (admission.status === "leased" || admission.status === "running" || admission.remoteJobId !== null);
      const remoteIdentityMismatch = error instanceof RunnerAdmissionError
        && error.code === "REMOTE_JOB_ID_MISMATCH";
      if (error instanceof RunnerAdmissionError && error.code === "USER_NOT_ACTIVE") {
        throw new AssessmentCorrectionError("LEARNER_NOT_ACTIVE");
      }
      const correctionIndeterminate = error instanceof AssessmentCorrectionError
        && error.code === "RUNNER_INDETERMINATE";
      if (error instanceof RunnerIndeterminateError || correctionIndeterminate || unresolvedReplay || remoteIdentityMismatch) {
        throw new AssessmentCorrectionError("RUNNER_INDETERMINATE");
      }
      const terminalReplay = error instanceof RunnerAdmissionError && error.code === "TERMINAL_REPLAY";
      if (terminalReplay) return reconcileAfterRegradePersistenceAmbiguity(admission);
      const capacityBusy = error instanceof RunnerClientError
        && (error.code === "QUEUE_FULL" || error.status === 429);
      const knownTerminalFailure = trustedTerminalResponseReceived
        && error instanceof AssessmentCorrectionError
        && error.code === "RUNNER_INFRASTRUCTURE_FAILURE";
      if (trustedRemoteResponseReceived && !knownTerminalFailure) {
        throw new AssessmentCorrectionError("RUNNER_INDETERMINATE");
      }
      try {
        const failed = await settleRunnerJob({
          admission,
          status: "failed",
          result: { error: capacityBusy ? "RUNNER_CAPACITY_BUSY" : error instanceof Error ? error.name : "RUNNER_FAILURE" },
          runtimeImageDigest: "runner-infrastructure-error",
          remoteJobId,
          startedAt: queuedAt,
          completedAt: new Date(),
        });
        if (failed.replayed) return reconcileAfterRegradePersistenceAmbiguity(admission);
      } catch {
        return reconcileAfterRegradePersistenceAmbiguity(admission);
      }
      if (capacityBusy) throw new AssessmentCorrectionError("RUNNER_CAPACITY_BUSY");
      throw error instanceof AssessmentCorrectionError
        ? error
        : new AssessmentCorrectionError("RUNNER_INFRASTRUCTURE_FAILURE");
    }
  },
};
