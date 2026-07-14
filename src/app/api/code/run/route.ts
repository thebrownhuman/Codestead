import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { requireAuth } from "@/lib/http/authz";
import { gateClosedBookCapability } from "@/lib/exams/capability-gate";
import { withRateLimit } from "@/lib/security/rate-limit";
import { hasCurrentConsent } from "@/lib/privacy/consent";
import {
  admitRunnerJob,
  beginRunnerDispatch,
  recordRunnerDispatch,
  refreshRunnerAdmission,
  RunnerAdmissionError,
  settleRunnerJob,
  type RunnerAdmission,
} from "@/lib/runner/admission";
import {
  configuredRunnerClient,
  RunnerIndeterminateError,
  runtimeByLanguage,
  type RunnerLanguage,
} from "@/lib/runner/client";
import {
  buildBoundPracticeRunnerRequest,
  practiceAdmissionRequestHash,
  PRACTICE_LIMITS,
} from "@/lib/runner/practice-dispatch";

const bodySchema = z.object({
  language: z.enum(["c", "cpp", "java", "python", "javascript"]),
  source: z.string().min(1).max(131_072),
  stdin: z.string().max(16_384).optional(),
  skillId: z.string().min(3).max(180).optional(),
  mode: z.enum(["compile", "quick_run"]).default("quick_run"),
  clientRequestId: z.string().uuid(),
}).strict();

const practiceOnlyEvidence = {
  officialMasteryEvidence: false,
  notice: "This practice run never awards or changes official mastery.",
} as const;

function storedPracticeResult(admission: RunnerAdmission) {
  const result = admission.result;
  if (admission.status === "succeeded" && result && typeof result.status === "string") {
    const compile = result.compile && typeof result.compile === "object"
      ? result.compile as Record<string, unknown>
      : {};
    const run = result.run && typeof result.run === "object"
      ? result.run as Record<string, unknown>
      : null;
    return NextResponse.json({
      requestId: admission.requestId,
      submissionId: admission.submissionId,
      status: result.status.toLowerCase(),
      stdout: run?.stdout ?? compile.stdout ?? "",
      stderr: run?.stderr ?? compile.stderr ?? "",
      exitCode: run?.exitCode ?? compile.exitCode ?? null,
      runtimeVersion: result.runtimeVersion,
      imageDigest: result.imageDigest,
      totals: result.totals,
      tests: result.tests,
      queue: { initialState: "completed", position: null },
      replayed: true,
      ...practiceOnlyEvidence,
    });
  }
  const savedError = result && typeof result.error === "string" ? result.error : null;
  if (["RUNNER_OFFLINE", "RUNNER_UNHEALTHY", "RUNNER_NOT_CONFIGURED"].includes(savedError ?? "")) {
    const offline = savedError === "RUNNER_OFFLINE";
    return NextResponse.json({
      requestId: admission.requestId,
      submissionId: admission.submissionId,
      status: offline ? "offline" : "unavailable",
      code: savedError,
      retryable: savedError !== "RUNNER_NOT_CONFIGURED",
      indeterminate: false,
      error: offline
        ? "This saved attempt ended before dispatch because the isolated runner was offline."
        : "This saved attempt ended before dispatch because the isolated runner was unavailable.",
      replayed: true,
      ...practiceOnlyEvidence,
    }, { status: 503 });
  }
  return NextResponse.json({
    requestId: admission.requestId,
    submissionId: admission.submissionId,
    status: "infrastructure_error",
    error: "The saved runner attempt did not produce a trusted result.",
    replayed: true,
    ...practiceOnlyEvidence,
  }, { status: 502 });
}

export async function GET() {
  const authz = await requireAuth();
  if (!authz.session) return authz.response;
  let client;
  try {
    client = configuredRunnerClient();
  } catch {
    return NextResponse.json({
      status: "unavailable",
      code: "RUNNER_NOT_CONFIGURED",
      retryable: false,
    }, { status: 503, headers: { "Cache-Control": "private, no-store" } });
  }
  const availability = await client.checkAvailability();
  return NextResponse.json(availability, {
    status: availability.available ? 200 : 503,
    headers: { "Cache-Control": "private, no-store" },
  });
}

export async function POST(request: NextRequest) {
  const authz = await requireAuth();
  if (!authz.session) return authz.response;
  const examGate = await gateClosedBookCapability(authz.session.user.id, "general_code_runner");
  if (!examGate.allowed) {
    return NextResponse.json(
      { error: examGate.message, code: examGate.code },
      { status: examGate.status, headers: { "Cache-Control": "private, no-store" } },
    );
  }
  return withRateLimit(
    [
      { policy: "code_run_minute", identity: { kind: "user", value: authz.session.user.id } },
      { policy: "code_run_hour", identity: { kind: "user", value: authz.session.user.id } },
    ],
    async () => {
  const rawBody = await request.json().catch(() => null) as unknown;
  const body = bodySchema.safeParse(rawBody);
  if (!body.success) {
    const suppliedRequestId = rawBody && typeof rawBody === "object" && !Array.isArray(rawBody)
      ? z.string().uuid().safeParse((rawBody as Record<string, unknown>).clientRequestId)
      : null;
    return NextResponse.json(
      {
        ...(suppliedRequestId?.success ? { requestId: suppliedRequestId.data } : {}),
        error: "Language, bounded source code, and a client request id are required.",
      },
      { status: 400 },
    );
  }
  const requestId = body.data.clientRequestId;
  if (!(await hasCurrentConsent(authz.session.user.id, "server_code_execution"))) {
    return NextResponse.json(
      { requestId, error: "Accept the current server-execution disclosure before running code." },
      { status: 409 },
    );
  }

  const language = body.data.language as RunnerLanguage;
  const runtime = runtimeByLanguage[language];
  const sourceHash = createHash("sha256").update(body.data.source).digest("hex");
  const submissionType = body.data.mode === "compile" ? "server_compile" : "server_run";
  const requestHash = practiceAdmissionRequestHash({
    userId: authz.session.user.id,
    requestId,
    language,
    sourceHash,
    stdin: body.data.stdin,
    mode: body.data.mode,
    runtimeVersion: runtime.version,
    entrypoint: runtime.entrypoint,
    submissionType,
  });
  let admission: RunnerAdmission;
  try {
    admission = await admitRunnerJob({
      userId: authz.session.user.id,
      language,
      sourceCode: body.data.source,
      sourceHash,
      submissionType,
      requestId,
      requestHash,
      limits: PRACTICE_LIMITS,
    });
  } catch (error) {
    if (error instanceof RunnerAdmissionError && error.code === "IDEMPOTENCY_MISMATCH") {
      return NextResponse.json({
        requestId,
        error: "This request id was already used for different code-run input.",
        code: error.code,
        retryable: false,
        ...practiceOnlyEvidence,
      }, { status: 409 });
    }
    if (error instanceof RunnerAdmissionError && error.code === "USER_NOT_ACTIVE") {
      return NextResponse.json({
        requestId,
        error: "This learner account is not active and cannot start runner work.",
        code: error.code,
        retryable: false,
        ...practiceOnlyEvidence,
      }, { status: 409 });
    }
    return NextResponse.json({
      requestId,
      error: "The runner admission queue is temporarily unavailable.",
      code: error instanceof RunnerAdmissionError ? error.code : "RUNNER_ADMISSION_FAILED",
      retryable: true,
      indeterminate: true,
      ...practiceOnlyEvidence,
    }, { status: 503 });
  }
  if (admission.duplicate && !["queued", "leased", "running"].includes(admission.status)) {
    return storedPracticeResult(admission);
  }

  let client;
  try {
    client = configuredRunnerClient();
  } catch {
    if (admission.duplicate && (admission.status !== "queued" || admission.remoteJobId !== null)) {
      return NextResponse.json({
        requestId,
        submissionId: admission.submissionId,
        status: "unavailable",
        code: "RUNNER_INDETERMINATE",
        availabilityCode: "RUNNER_NOT_CONFIGURED",
        retryable: true,
        indeterminate: true,
        error: "The existing runner job could not be reconciled yet. Retry this same request id.",
        ...practiceOnlyEvidence,
      }, { status: 503 });
    }
    const settlement = await settleRunnerJob({
      admission,
      status: "failed",
      runtimeImageDigest: "runner-infrastructure-error",
      result: { error: "RUNNER_NOT_CONFIGURED" },
    }).catch(() => null);
    if (settlement === null) {
      return NextResponse.json({
        requestId,
        submissionId: admission.submissionId,
        status: "infrastructure_error",
        code: "RUNNER_SETTLEMENT_INDETERMINATE",
        retryable: true,
        indeterminate: true,
        error: "The saved runner attempt could not be reconciled yet. Retry this same request id.",
        ...practiceOnlyEvidence,
      }, { status: 503 });
    }
    if (settlement.replayed) {
      return storedPracticeResult(await refreshRunnerAdmission(admission));
    }
    return NextResponse.json(
      {
        requestId,
        submissionId: admission.submissionId,
        status: "unavailable",
        code: "RUNNER_NOT_CONFIGURED",
        retryable: false,
        indeterminate: false,
        error: "The isolated runner is not configured. Your source was saved, but no code was dispatched.",
        ...practiceOnlyEvidence,
      },
      { status: 503 },
    );
  }

  const availability = await client.checkAvailability();
  if (!availability.available) {
    if (admission.duplicate && (admission.status !== "queued" || admission.remoteJobId !== null)) {
      return NextResponse.json({
        requestId,
        submissionId: admission.submissionId,
        status: availability.status,
        code: "RUNNER_INDETERMINATE",
        availabilityCode: availability.code,
        retryable: true,
        indeterminate: true,
        error: "The existing runner job cannot be reconciled while the isolated runner is offline. Retry this same request id after it starts.",
        ...practiceOnlyEvidence,
      }, { status: 503 });
    }
    const settlement = await settleRunnerJob({
      admission,
      status: "failed",
      runtimeImageDigest: "runner-infrastructure-error",
      result: { error: availability.code },
    }).catch(() => null);
    if (settlement === null) {
      return NextResponse.json({
        requestId,
        submissionId: admission.submissionId,
        status: "infrastructure_error",
        code: "RUNNER_SETTLEMENT_INDETERMINATE",
        retryable: true,
        indeterminate: true,
        error: "The saved runner attempt could not be reconciled yet. Retry this same request id.",
        ...practiceOnlyEvidence,
      }, { status: 503 });
    }
    if (settlement.replayed) {
      return storedPracticeResult(await refreshRunnerAdmission(admission));
    }
    return NextResponse.json({
      requestId,
      submissionId: admission.submissionId,
      status: availability.status,
      code: availability.code,
      retryable: true,
      indeterminate: false,
      error: availability.status === "offline"
        ? "The isolated runner is offline. Your source was saved, but no code was dispatched."
        : "The isolated runner health check failed. Your source was saved, but no code was dispatched.",
      ...practiceOnlyEvidence,
    }, { status: 503 });
  }

  let remoteJobId = admission.remoteJobId;
  // Once a known remote identity exists, or the runner has returned a signed
  // job response, a local DB/commit error cannot safely be converted into a
  // terminal failure. The same admission/request id must reconcile it.
  let remoteBoundaryCrossed = admission.status !== "queued" || admission.remoteJobId !== null;
  try {
    const runnerRequest = buildBoundPracticeRunnerRequest({
      admission,
      language,
      runtimeVersion: runtime.version,
      entrypoint: runtime.entrypoint,
      sourceCode: body.data.source,
      sourceHash,
      stdin: body.data.stdin,
      mode: body.data.mode,
    });
    const dispatchBoundary = await beginRunnerDispatch({ admission, dispatchRequest: runnerRequest });
    if (dispatchBoundary.replayed) {
      return storedPracticeResult(await refreshRunnerAdmission(admission));
    }
    const submitted = dispatchBoundary.remoteJobId
      ? await client.waitForJob(dispatchBoundary.remoteJobId, runnerRequest)
      : await client.submit(runnerRequest, requestId);
    remoteBoundaryCrossed = true;
    remoteJobId = dispatchBoundary.remoteJobId ?? submitted.jobId;
    if (!dispatchBoundary.remoteJobId) {
      const initialJobStatus = submitted.state === "QUEUED"
        ? "queued"
        : submitted.state === "FAILED"
          ? "failed"
          : "running";
      if (initialJobStatus !== "failed") {
        const dispatch = await recordRunnerDispatch({
          admission,
          remoteJobId: submitted.jobId,
          status: initialJobStatus,
        });
        if (dispatch.replayed) {
          return storedPracticeResult(await refreshRunnerAdmission(admission));
        }
      }
    }
    const completed = !dispatchBoundary.remoteJobId
      && (submitted.state === "QUEUED" || submitted.state === "RUNNING")
      ? await client.waitFrom(submitted, runnerRequest)
      : submitted;
    const result = completed.result;
    const succeeded = completed.state === "COMPLETED" && Boolean(result);
    const settlement = await settleRunnerJob({
      admission,
      status: succeeded ? "succeeded" : "failed",
      runtimeImageDigest: result?.imageDigest ?? "runner-infrastructure-error",
      result: result ?? { error: completed.error?.code ?? "UNKNOWN" },
      remoteJobId: completed.jobId,
      completedAt: new Date(),
    });
    if (settlement.replayed) {
      return storedPracticeResult(await refreshRunnerAdmission(admission));
    }
    if (!result) {
      return NextResponse.json({
        requestId,
        status: "infrastructure_error",
        error: completed.error?.code ?? "Runner failed.",
        queue: {
          initialState: submitted.state.toLowerCase(),
          position: submitted.queuePosition,
        },
        ...practiceOnlyEvidence,
      }, { status: 502 });
    }
    return NextResponse.json({
      requestId,
      submissionId: admission.submissionId,
      status: result.status.toLowerCase(),
      stdout: result.run?.stdout ?? result.compile.stdout,
      stderr: result.run?.stderr ?? result.compile.stderr,
      exitCode: result.run?.exitCode ?? result.compile.exitCode,
      runtimeVersion: result.runtimeVersion,
      imageDigest: result.imageDigest,
      totals: result.totals,
      tests: result.tests,
      queue: {
        initialState: submitted.state.toLowerCase(),
        position: submitted.queuePosition,
      },
      ...practiceOnlyEvidence,
    });
  } catch (error) {
    if (
      error instanceof RunnerIndeterminateError
      || (error instanceof RunnerAdmissionError && error.code === "REMOTE_JOB_ID_MISMATCH")
      || remoteBoundaryCrossed
    ) {
      return NextResponse.json(
        {
          submissionId: admission.submissionId,
          requestId,
          status: "infrastructure_error",
          code: error instanceof RunnerIndeterminateError || error instanceof RunnerAdmissionError
            ? error.code
            : "RUNNER_LOCAL_PERSISTENCE_INDETERMINATE",
          retryable: true,
          indeterminate: true,
          error: "The runner outcome is not known yet. Retry this same request id to reconcile it.",
          ...practiceOnlyEvidence,
        },
        { status: 503 },
      );
    }
    if (error instanceof RunnerAdmissionError && error.code === "USER_NOT_ACTIVE") {
      return NextResponse.json({
        requestId,
        submissionId: admission.submissionId,
        status: "infrastructure_error",
        code: error.code,
        retryable: false,
        error: "This learner account is not active and cannot dispatch runner work.",
        ...practiceOnlyEvidence,
      }, { status: 409 });
    }
    const failedSettlement = await settleRunnerJob({
      admission,
      status: "failed",
      runtimeImageDigest: "runner-infrastructure-error",
      result: { error: "RUNNER_FAILURE" },
      remoteJobId,
    }).catch(() => null);
    if (failedSettlement === null) {
      return NextResponse.json({
        requestId,
        submissionId: admission.submissionId,
        status: "infrastructure_error",
        code: "RUNNER_SETTLEMENT_INDETERMINATE",
        retryable: true,
        indeterminate: true,
        error: "The runner result could not be reconciled yet. Retry this same request id.",
        ...practiceOnlyEvidence,
      }, { status: 503 });
    }
    if (failedSettlement.replayed) {
      return storedPracticeResult(await refreshRunnerAdmission(admission));
    }
    return NextResponse.json(
      {
        requestId,
        submissionId: admission.submissionId,
        status: "infrastructure_error",
        error: "The isolated runner did not return a trusted result. Your source is saved.",
        ...practiceOnlyEvidence,
      },
      { status: 502 },
    );
      }
    },
  );
}
