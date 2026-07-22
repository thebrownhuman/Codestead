import { createHash } from "node:crypto";

import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  return {
    admitRunnerJob: vi.fn(),
    beginRunnerDispatch: vi.fn(),
    holdRunnerDispatchForPowerRehearsal: vi.fn(),
    recordRunnerDispatch: vi.fn(),
    refreshRunnerAdmission: vi.fn(),
    settleRunnerJob: vi.fn(),
    requireAuth: vi.fn(),
    gateClosedBookCapability: vi.fn(),
    withRateLimit: vi.fn(),
    hasCurrentConsent: vi.fn(),
    configuredRunnerClient: vi.fn(),
    checkAvailability: vi.fn(),
    submit: vi.fn(),
    waitForJob: vi.fn(),
    waitFrom: vi.fn(),
  };
});

vi.mock("@/lib/http/authz", () => ({ requireAuth: mocks.requireAuth }));
vi.mock("@/lib/exams/capability-gate", () => ({
  gateClosedBookCapability: mocks.gateClosedBookCapability,
}));
vi.mock("@/lib/security/rate-limit", () => ({ withRateLimit: mocks.withRateLimit }));
vi.mock("@/lib/privacy/consent", () => ({ hasCurrentConsent: mocks.hasCurrentConsent }));
vi.mock("@/lib/runner/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/runner/client")>();
  return { ...actual, configuredRunnerClient: mocks.configuredRunnerClient };
});
vi.mock("@/lib/runner/admission", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/runner/admission")>();
  return {
    ...actual,
    admitRunnerJob: mocks.admitRunnerJob,
    beginRunnerDispatch: mocks.beginRunnerDispatch,
    recordRunnerDispatch: mocks.recordRunnerDispatch,
    refreshRunnerAdmission: mocks.refreshRunnerAdmission,
    settleRunnerJob: mocks.settleRunnerJob,
  };
});
vi.mock("@/lib/runner/power-rehearsal-hold", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/runner/power-rehearsal-hold")>();
  return { ...actual, holdRunnerDispatchForPowerRehearsal: mocks.holdRunnerDispatchForPowerRehearsal };
});


import { GET, POST } from "../route";
import { RunnerAdmissionError } from "@/lib/runner/admission";
import { RunnerIndeterminateError, runtimeByLanguage } from "@/lib/runner/client";
import { practiceAdmissionRequestHash } from "@/lib/runner/practice-dispatch";
import { RunnerPowerRehearsalError } from "@/lib/runner/power-rehearsal-hold";

const CLIENT_REQUEST_ID = "10000000-0000-4000-8000-000000000001";
const SOURCE = "name = input()\nprint(f'Hello, {name}!')\n";
const SOURCE_HASH = createHash("sha256").update(SOURCE).digest("hex");
const ADMISSION = {
  submissionId: "20000000-0000-4000-8000-000000000001",
  runnerJobId: "20000000-0000-4000-8000-000000000002",
  userId: "learner-1",
  requestId: CLIENT_REQUEST_ID,
  requestHash: practiceAdmissionRequestHash({
    userId: "learner-1",
    requestId: CLIENT_REQUEST_ID,
    language: "python",
    sourceHash: SOURCE_HASH,
    stdin: "Ada\n",
    mode: "quick_run",
    runtimeVersion: runtimeByLanguage.python.version,
    entrypoint: runtimeByLanguage.python.entrypoint,
    submissionType: "server_run",
  }),
  submissionType: "server_run",
  status: "queued" as const,
  remoteJobId: null,
  result: null,
  runtimeImageDigest: "pending-runner-result",
  queuedAt: new Date("2026-07-12T00:00:00.000Z"),
  duplicate: false,
};

const result = {
  status: "ACCEPTED",
  imageDigest: "sha256:python-image",
  runtimeVersion: "Python 3.14",
  compile: { status: "OK", stdout: "", stderr: "", exitCode: 0 },
  run: { stdout: "Hello, Ada!\n", stderr: "", exitCode: 0, wallTimeMs: 12 },
  tests: [],
  totals: { passed: 0, failed: 0, total: 0 },
};

function completedJob(overrides: Record<string, unknown> = {}) {
  return {
    jobId: "runner-job-1",
    submissionId: "runner-submission",
    correlationId: "runner-correlation",
    requestHash: "request-hash",
    state: "COMPLETED",
    queuePosition: null,
    result,
    ...overrides,
  };
}

function request(overrides: Record<string, unknown> = {}) {
  return new NextRequest("https://learn.test/api/code/run", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      language: "python",
      source: SOURCE,
      stdin: "Ada\n",
      skillId: "python.input-output",
      mode: "quick_run",
      clientRequestId: CLIENT_REQUEST_ID,
      ...overrides,
    }),
  });
}

describe("general practice code runner route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.admitRunnerJob.mockResolvedValue(ADMISSION);
    mocks.beginRunnerDispatch.mockResolvedValue({ replayed: false, remoteJobId: null });
    mocks.holdRunnerDispatchForPowerRehearsal.mockResolvedValue({ held: false });
    mocks.recordRunnerDispatch.mockResolvedValue({ replayed: false });
    mocks.refreshRunnerAdmission.mockResolvedValue({
      ...ADMISSION,
      duplicate: true,
      status: "failed",
      result: { error: "TERMINAL_WITHOUT_TRUSTED_RESULT" },
    });
    mocks.settleRunnerJob.mockResolvedValue({ replayed: false });
    mocks.requireAuth.mockResolvedValue({
      session: { user: { id: "learner-1" }, session: { id: "session-1" } },
      response: null,
    });
    mocks.gateClosedBookCapability.mockResolvedValue({ allowed: true });
    mocks.withRateLimit.mockImplementation(async (_rules, callback: () => Promise<Response>) => callback());
    mocks.hasCurrentConsent.mockResolvedValue(true);
    mocks.configuredRunnerClient.mockReturnValue({
      checkAvailability: mocks.checkAvailability,
      submit: mocks.submit,
      waitForJob: mocks.waitForJob,
      waitFrom: mocks.waitFrom,
    });
    mocks.checkAvailability.mockResolvedValue({
      available: true,
      status: "available",
      queueDepth: 0,
      activeJobs: 0,
      concurrency: 2,
    });
    mocks.submit.mockResolvedValue(completedJob());
  });

  it("reports authenticated runner readiness without exposing configuration", async () => {
    const response = await GET();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    await expect(response.json()).resolves.toEqual({
      available: true,
      status: "available",
      queueDepth: 0,
      activeJobs: 0,
      concurrency: 2,
    });
  });

  it("reports an offline runner through authenticated readiness", async () => {
    mocks.checkAvailability.mockResolvedValueOnce({
      available: false,
      status: "offline",
      code: "RUNNER_OFFLINE",
    });

    const response = await GET();

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      available: false,
      status: "offline",
      code: "RUNNER_OFFLINE",
    });
  });

  it("reports missing runner configuration through authenticated readiness", async () => {
    mocks.configuredRunnerClient.mockImplementationOnce(() => {
      throw new Error("missing configuration");
    });

    const response = await GET();

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      status: "unavailable",
      code: "RUNNER_NOT_CONFIGURED",
      retryable: false,
    });
    expect(mocks.checkAvailability).not.toHaveBeenCalled();
  });

  it("protects runner readiness behind authentication", async () => {
    mocks.requireAuth.mockResolvedValueOnce({
      session: null,
      response: NextResponse.json({ error: "Authentication required." }, { status: 401 }),
    });

    const response = await GET();

    expect(response.status).toBe(401);
    expect(mocks.configuredRunnerClient).not.toHaveBeenCalled();
  });

  it("rejects an anonymous caller before exam state, rate limits, consent, or storage", async () => {
    mocks.requireAuth.mockResolvedValueOnce({
      session: null,
      response: NextResponse.json({ error: "Authentication required." }, { status: 401 }),
    });

    const response = await POST(request());

    expect(response.status).toBe(401);
    expect(mocks.gateClosedBookCapability).not.toHaveBeenCalled();
    expect(mocks.withRateLimit).not.toHaveBeenCalled();
    expect(mocks.admitRunnerJob).not.toHaveBeenCalled();
  });

  it("fails closed during a timed exam before consuming a runner budget", async () => {
    mocks.gateClosedBookCapability.mockResolvedValueOnce({
      allowed: false,
      status: 423,
      code: "EXAM_CAPABILITY_LOCKED",
      message: "General code runs are locked while the exam is active.",
    });

    const response = await POST(request());

    expect(response.status).toBe(423);
    await expect(response.json()).resolves.toMatchObject({ code: "EXAM_CAPABILITY_LOCKED" });
    expect(mocks.gateClosedBookCapability).toHaveBeenCalledWith("learner-1", "general_code_runner");
    expect(mocks.withRateLimit).not.toHaveBeenCalled();
    expect(mocks.admitRunnerJob).not.toHaveBeenCalled();
  });

  it.each([
    ["mastery flag", { officialMasteryEvidence: true }],
    ["mastery mutation", { masteryAwarded: true }],
    ["attempt target", { attemptId: "20000000-0000-4000-8000-000000000001" }],
    ["learner identity", { userId: "other-learner" }],
    ["runner limits", { limits: { wallTimeMs: 60_000 } }],
    ["test cases", { tests: [{ id: "forged", expectedStdout: "pass" }] }],
    ["privileged mode", { mode: "TEST" }],
  ])("strictly rejects a client-supplied %s field before consent or persistence", async (_label, tamper) => {
    const response = await POST(request(tamper));

    expect(response.status).toBe(400);
    expect(mocks.hasCurrentConsent).not.toHaveBeenCalled();
    expect(mocks.admitRunnerJob).not.toHaveBeenCalled();
    expect(mocks.configuredRunnerClient).not.toHaveBeenCalled();
  });

  it("requires the browser request id instead of creating a hidden server UUID", async () => {
    const response = await POST(request({ clientRequestId: undefined }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringMatching(/client request id/i),
    });
    expect(mocks.hasCurrentConsent).not.toHaveBeenCalled();
    expect(mocks.admitRunnerJob).not.toHaveBeenCalled();
    expect(mocks.configuredRunnerClient).not.toHaveBeenCalled();
  });

  it("requires the current server-execution consent before saving source", async () => {
    mocks.hasCurrentConsent.mockResolvedValueOnce(false);

    const response = await POST(request());

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      requestId: CLIENT_REQUEST_ID,
      error: expect.stringMatching(/server-execution disclosure/i),
    });
    expect(mocks.hasCurrentConsent).toHaveBeenCalledWith("learner-1", "server_code_execution");
    expect(mocks.admitRunnerJob).not.toHaveBeenCalled();
  });

  it("commits local admission before configuring or calling the remote runner", async () => {
    let resolveAdmission!: (value: typeof ADMISSION) => void;
    mocks.admitRunnerJob.mockImplementationOnce(() => new Promise((resolve) => {
      resolveAdmission = resolve;
    }));

    const pending = POST(request());
    await vi.waitFor(() => expect(mocks.admitRunnerJob).toHaveBeenCalledOnce());
    expect(mocks.configuredRunnerClient).not.toHaveBeenCalled();
    expect(mocks.submit).not.toHaveBeenCalled();

    resolveAdmission(ADMISSION);
    await expect(pending).resolves.toMatchObject({ status: 200 });
    expect(mocks.submit).toHaveBeenCalledOnce();
  });

  it("rejects a changed payload under a reused request id without a remote call", async () => {
    mocks.admitRunnerJob.mockRejectedValueOnce(new RunnerAdmissionError("IDEMPOTENCY_MISMATCH"));

    const response = await POST(request());

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      code: "IDEMPOTENCY_MISMATCH",
      retryable: false,
    });
    expect(mocks.configuredRunnerClient).not.toHaveBeenCalled();
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  it("rejects admission after account deletion as non-retryable", async () => {
    mocks.admitRunnerJob.mockRejectedValueOnce(new RunnerAdmissionError("USER_NOT_ACTIVE"));

    const response = await POST(request());

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      code: "USER_NOT_ACTIVE",
      retryable: false,
      officialMasteryEvidence: false,
    });
    expect(mocks.configuredRunnerClient).not.toHaveBeenCalled();
  });

  it("constructs a bounded Python quick-run request and stores only practice evidence", async () => {
    const response = await POST(request());
    const body = await response.json();

    expect(response.status).toBe(200);
    const admissionInput = mocks.admitRunnerJob.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(admissionInput).toMatchObject({
      userId: "learner-1",
      language: "python",
      sourceCode: SOURCE,
      sourceHash: createHash("sha256").update(SOURCE).digest("hex"),
      submissionType: "server_run",
      requestId: CLIENT_REQUEST_ID,
      requestHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(admissionInput).not.toHaveProperty("attemptId");
    expect(admissionInput).not.toHaveProperty("activityId");
    expect(admissionInput).not.toHaveProperty("testBundleId");

    expect(mocks.submit).toHaveBeenCalledWith({
      submissionId: ADMISSION.submissionId,
      correlationId: expect.any(String),
      language: "python",
      runtimeVersion: "Python 3.14",
      mode: "RUN",
      sourceFiles: [{ path: "main.py", content: SOURCE }],
      entrypoint: "main.py",
      stdin: "Ada\n",
      limits: {
        wallTimeMs: 5_000,
        memoryMb: 128,
        cpuCount: 0.5,
        pids: 32,
        outputBytes: 65_536,
        fileBytes: 16_777_216,
      },
    }, CLIENT_REQUEST_ID);
    expect(mocks.beginRunnerDispatch).toHaveBeenCalledWith({
      admission: ADMISSION,
      dispatchRequest: expect.objectContaining({
        submissionId: ADMISSION.submissionId,
        correlationId: expect.any(String),
        language: "python",
        runtimeVersion: "Python 3.14",
        mode: "RUN",
        sourceFiles: [{ path: "main.py", content: SOURCE }],
        entrypoint: "main.py",
        stdin: "Ada\n",
      }),
    });
    expect(mocks.waitFrom).not.toHaveBeenCalled();
    expect(mocks.recordRunnerDispatch).toHaveBeenCalledWith({
      admission: ADMISSION,
      status: "running",
      remoteJobId: "runner-job-1",
    });
    expect(mocks.settleRunnerJob).toHaveBeenCalledWith(expect.objectContaining({
      admission: ADMISSION,
      status: "succeeded",
      result,
      completedAt: expect.any(Date),
      runtimeImageDigest: "sha256:python-image",
    }));
    expect(body).toMatchObject({
      requestId: CLIENT_REQUEST_ID,
      submissionId: ADMISSION.submissionId,
      status: "accepted",
      stdout: "Hello, Ada!\n",
      runtimeVersion: "Python 3.14",
      imageDigest: "sha256:python-image",
      queue: { initialState: "completed", position: null },
      officialMasteryEvidence: false,
      notice: expect.stringMatching(/never awards.*mastery/i),
    });
    expect(body).not.toHaveProperty("masteryAwarded");
    expect(body).not.toHaveProperty("attemptId");
  });

  it("marks saved source failed when the isolated runner is not configured", async () => {
    mocks.configuredRunnerClient.mockImplementationOnce(() => {
      throw new Error("missing configuration");
    });

    const response = await POST(request());
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(mocks.admitRunnerJob).toHaveBeenCalledOnce();
    expect(mocks.settleRunnerJob).toHaveBeenCalledWith(expect.objectContaining({
      admission: ADMISSION,
      status: "failed",
      result: { error: "RUNNER_NOT_CONFIGURED" },
    }));
    expect(mocks.recordRunnerDispatch).not.toHaveBeenCalled();
    expect(body).toMatchObject({
      status: "unavailable",
      code: "RUNNER_NOT_CONFIGURED",
      retryable: false,
      indeterminate: false,
      officialMasteryEvidence: false,
    });
  });

  it.each(["c", "cpp", "java", "python", "javascript"])(
    "does not dispatch %s source when the isolated runner is definitely offline",
    async (language) => {
      mocks.checkAvailability.mockResolvedValueOnce({
        available: false,
        status: "offline",
        code: "RUNNER_OFFLINE",
      });

      const response = await POST(request({ language }));

      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toMatchObject({
        requestId: CLIENT_REQUEST_ID,
        status: "offline",
        code: "RUNNER_OFFLINE",
        retryable: true,
        indeterminate: false,
        error: expect.stringMatching(/no code was dispatched/i),
      });
      expect(mocks.beginRunnerDispatch).not.toHaveBeenCalled();
      expect(mocks.submit).not.toHaveBeenCalled();
      expect(mocks.recordRunnerDispatch).not.toHaveBeenCalled();
      expect(mocks.settleRunnerJob).toHaveBeenCalledWith(expect.objectContaining({
        status: "failed",
        result: { error: "RUNNER_OFFLINE" },
      }));
    },
  );

  it("reports an unhealthy runner distinctly from a network-offline runner", async () => {
    mocks.checkAvailability.mockResolvedValueOnce({
      available: false,
      status: "unavailable",
      code: "RUNNER_UNHEALTHY",
    });

    const response = await POST(request());

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      status: "unavailable",
      code: "RUNNER_UNHEALTHY",
      indeterminate: false,
    });
    expect(mocks.beginRunnerDispatch).not.toHaveBeenCalled();
  });

  it("replays a definite saved offline result without turning it indeterminate", async () => {
    mocks.admitRunnerJob.mockResolvedValueOnce({
      ...ADMISSION,
      duplicate: true,
      status: "failed",
      result: { error: "RUNNER_OFFLINE" },
    });

    const response = await POST(request());

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      status: "offline",
      code: "RUNNER_OFFLINE",
      retryable: true,
      indeterminate: false,
      replayed: true,
    });
    expect(mocks.configuredRunnerClient).not.toHaveBeenCalled();
    expect(mocks.beginRunnerDispatch).not.toHaveBeenCalled();
  });

  it("preserves an active duplicate admission when readiness is offline", async () => {
    mocks.admitRunnerJob.mockResolvedValueOnce({
      ...ADMISSION,
      duplicate: true,
      status: "running",
      remoteJobId: "known-remote-job",
    });
    mocks.checkAvailability.mockResolvedValueOnce({
      available: false,
      status: "offline",
      code: "RUNNER_OFFLINE",
    });

    const response = await POST(request());

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      status: "offline",
      code: "RUNNER_INDETERMINATE",
      availabilityCode: "RUNNER_OFFLINE",
      indeterminate: true,
    });
    expect(mocks.beginRunnerDispatch).not.toHaveBeenCalled();
    expect(mocks.settleRunnerJob).not.toHaveBeenCalled();
  });

  it("fails safely when the runner call throws and preserves no mastery-shaped response", async () => {
    mocks.submit.mockRejectedValueOnce(new Error("bad signature or unavailable"));

    const response = await POST(request());
    const body = await response.json();

    expect(response.status).toBe(502);
    expect(mocks.settleRunnerJob).toHaveBeenCalledWith(expect.objectContaining({
      admission: ADMISSION,
      status: "failed",
      result: { error: "RUNNER_FAILURE" },
    }));
    expect(mocks.recordRunnerDispatch).not.toHaveBeenCalled();
    expect(body).toMatchObject({
      status: "infrastructure_error",
      officialMasteryEvidence: false,
      error: expect.stringMatching(/trusted result/i),
    });
    expect(body).not.toHaveProperty("masteryAwarded");
  });

  it("records bounded queue state and then durable completed runner evidence", async () => {
    mocks.submit.mockResolvedValueOnce(completedJob({
      jobId: "queued-runner-job",
      state: "QUEUED",
      queuePosition: 2,
      result: undefined,
    }));
    mocks.waitFrom.mockResolvedValueOnce(completedJob());

    const response = await POST(request());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mocks.recordRunnerDispatch).toHaveBeenCalledWith({
      admission: ADMISSION,
      status: "queued",
      remoteJobId: "queued-runner-job",
    });
    expect(mocks.waitFrom).toHaveBeenCalledWith(
      expect.objectContaining({ state: "QUEUED", jobId: "queued-runner-job" }),
      expect.objectContaining({ language: "python", mode: "RUN" }),
    );
    expect(mocks.settleRunnerJob).toHaveBeenCalledWith(expect.objectContaining({
      admission: ADMISSION,
      status: "succeeded",
    }));
    expect(body).toMatchObject({
      status: "accepted",
      queue: { initialState: "queued", position: 2 },
      officialMasteryEvidence: false,
    });
  });

  it("persists the exact dispatch snapshot before durably holding an armed power-rehearsal request", async () => {
    mocks.holdRunnerDispatchForPowerRehearsal.mockResolvedValueOnce({
      held: true,
      eventId: "40000000-0000-4000-8000-000000000001",
      slot: 1,
      filled: false,
      replayed: false,
      expired: false,
    });

    const response = await POST(request());

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual(expect.objectContaining({
      requestId: CLIENT_REQUEST_ID,
      submissionId: ADMISSION.submissionId,
      status: "rehearsal_held",
      code: "RUNNER_POWER_REHEARSAL_HELD",
      retryable: true,
      indeterminate: false,
      replayed: false,
      officialMasteryEvidence: false,
    }));
    expect(mocks.holdRunnerDispatchForPowerRehearsal).toHaveBeenCalledWith({
      userId: ADMISSION.userId,
      requestId: ADMISSION.requestId,
      submissionId: ADMISSION.submissionId,
      runnerJobId: ADMISSION.runnerJobId,
    });
    expect(mocks.beginRunnerDispatch).toHaveBeenCalledWith({
      admission: ADMISSION,
      dispatchRequest: expect.objectContaining({
        submissionId: ADMISSION.submissionId,
        language: "python",
        mode: "RUN",
      }),
    });
    expect(mocks.beginRunnerDispatch.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.holdRunnerDispatchForPowerRehearsal.mock.invocationCallOrder[0]!,
    );
    expect(mocks.submit).not.toHaveBeenCalled();
    expect(mocks.waitForJob).not.toHaveBeenCalled();
    expect(mocks.recordRunnerDispatch).not.toHaveBeenCalled();
    expect(mocks.settleRunnerJob).not.toHaveBeenCalled();
  });

  it("never terminalizes a job when rehearsal-hold persistence is uncertain", async () => {
    mocks.holdRunnerDispatchForPowerRehearsal.mockRejectedValueOnce(
      new RunnerPowerRehearsalError("HOLD_PERSISTENCE_INDETERMINATE", true),
    );

    const response = await POST(request());

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      requestId: CLIENT_REQUEST_ID,
      submissionId: ADMISSION.submissionId,
      code: "RUNNER_REHEARSAL_HOLD_INDETERMINATE",
      retryable: true,
      indeterminate: true,
    });
    expect(mocks.submit).not.toHaveBeenCalled();
    expect(mocks.settleRunnerJob).not.toHaveBeenCalled();
  });
  it("never terminalizes a new admission when dispatch-snapshot commit acknowledgement is uncertain", async () => {
    mocks.beginRunnerDispatch.mockRejectedValueOnce(new Error("snapshot commit acknowledgement lost"));

    const response = await POST(request());

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      requestId: CLIENT_REQUEST_ID,
      submissionId: ADMISSION.submissionId,
      code: "RUNNER_LOCAL_PERSISTENCE_INDETERMINATE",
      retryable: true,
      indeterminate: true,
    });
    expect(mocks.holdRunnerDispatchForPowerRehearsal).not.toHaveBeenCalled();
    expect(mocks.submit).not.toHaveBeenCalled();
    expect(mocks.waitForJob).not.toHaveBeenCalled();
    expect(mocks.settleRunnerJob).not.toHaveBeenCalled();
  });


  it("stops polling when dispatch discovers that the ledger is already terminal", async () => {
    mocks.submit.mockResolvedValueOnce(completedJob({
      jobId: "late-runner-job",
      state: "QUEUED",
      queuePosition: 1,
      result: undefined,
    }));
    mocks.recordRunnerDispatch.mockResolvedValueOnce({ replayed: true });
    mocks.settleRunnerJob.mockResolvedValue({ replayed: true });

    const response = await POST(request());

    expect(response.status).toBe(502);
    expect(mocks.waitFrom).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({
      status: "infrastructure_error",
      officialMasteryEvidence: false,
    });
  });

  it("keeps the same admission active when the signed remote outcome is indeterminate", async () => {
    mocks.submit.mockRejectedValueOnce(new RunnerIndeterminateError(
      "RUNNER_REQUEST_INDETERMINATE",
      null,
    ));

    const response = await POST(request());

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      requestId: CLIENT_REQUEST_ID,
      submissionId: ADMISSION.submissionId,
      code: "RUNNER_REQUEST_INDETERMINATE",
      retryable: true,
      indeterminate: true,
      officialMasteryEvidence: false,
    });
    expect(mocks.beginRunnerDispatch).toHaveBeenCalledOnce();
    expect(mocks.settleRunnerJob).not.toHaveBeenCalled();
  });

  it("never terminally settles a persisted leased admission when dispatch recovery fails before a remote id is known", async () => {
    const ambiguousAdmission = {
      ...ADMISSION,
      duplicate: true,
      status: "leased" as const,
      remoteJobId: null,
    };
    mocks.admitRunnerJob.mockResolvedValueOnce(ambiguousAdmission);
    mocks.beginRunnerDispatch.mockRejectedValueOnce(new Error("snapshot commit acknowledgement lost"));

    const response = await POST(request());

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      requestId: CLIENT_REQUEST_ID,
      submissionId: ADMISSION.submissionId,
      code: "RUNNER_LOCAL_PERSISTENCE_INDETERMINATE",
      retryable: true,
      indeterminate: true,
    });
    expect(mocks.submit).not.toHaveBeenCalled();
    expect(mocks.waitForJob).not.toHaveBeenCalled();
    expect(mocks.settleRunnerJob).not.toHaveBeenCalled();
  });

  it("resumes a known immutable remote job with GET and never submits a second job", async () => {
    const resumedAdmission = {
      ...ADMISSION,
      duplicate: true,
      status: "running" as const,
      remoteJobId: "known-remote-job",
    };
    mocks.admitRunnerJob.mockResolvedValueOnce(resumedAdmission);
    mocks.beginRunnerDispatch.mockResolvedValueOnce({ replayed: false, remoteJobId: "known-remote-job" });
    mocks.waitForJob.mockResolvedValueOnce(completedJob({ jobId: "known-remote-job" }));

    const response = await POST(request());

    expect(response.status).toBe(200);
    expect(mocks.submit).not.toHaveBeenCalled();
    expect(mocks.holdRunnerDispatchForPowerRehearsal).not.toHaveBeenCalled();
    expect(mocks.waitForJob).toHaveBeenCalledWith(
      "known-remote-job",
      expect.objectContaining({ language: "python", mode: "RUN" }),
    );
    expect(mocks.recordRunnerDispatch).not.toHaveBeenCalled();
    expect(mocks.settleRunnerJob).toHaveBeenCalledWith(expect.objectContaining({
      admission: resumedAdmission,
      remoteJobId: "known-remote-job",
      status: "succeeded",
    }));
  });

  it("keeps the admission active when remote idempotency returns a different job identity", async () => {
    mocks.submit.mockResolvedValueOnce(completedJob({
      jobId: "unexpected-remote-job",
      state: "QUEUED",
      result: undefined,
    }));
    mocks.recordRunnerDispatch.mockRejectedValueOnce(new RunnerAdmissionError("REMOTE_JOB_ID_MISMATCH"));

    const response = await POST(request());

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      code: "REMOTE_JOB_ID_MISMATCH",
      retryable: true,
      officialMasteryEvidence: false,
    });
    expect(mocks.waitFrom).not.toHaveBeenCalled();
    expect(mocks.settleRunnerJob).not.toHaveBeenCalled();
  });

  it("keeps the same admission active when recording a signed queued response has uncertain persistence", async () => {
    mocks.submit.mockResolvedValueOnce(completedJob({
      jobId: "accepted-queued-job",
      state: "QUEUED",
      queuePosition: 1,
      result: undefined,
    }));
    mocks.recordRunnerDispatch.mockRejectedValueOnce(new Error("connection reset after commit"));

    const response = await POST(request());

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      code: "RUNNER_LOCAL_PERSISTENCE_INDETERMINATE",
      requestId: CLIENT_REQUEST_ID,
      retryable: true,
      indeterminate: true,
    });
    expect(mocks.waitFrom).not.toHaveBeenCalled();
    expect(mocks.settleRunnerJob).not.toHaveBeenCalled();
  });

  it("does not overwrite a trusted completed response when terminal settlement persistence is uncertain", async () => {
    mocks.settleRunnerJob.mockRejectedValueOnce(new Error("commit acknowledgement lost"));

    const response = await POST(request());

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      code: "RUNNER_LOCAL_PERSISTENCE_INDETERMINATE",
      requestId: CLIENT_REQUEST_ID,
      retryable: true,
      indeterminate: true,
    });
    expect(mocks.settleRunnerJob).toHaveBeenCalledOnce();
  });

  it("returns the persisted winning result when terminal settlement loses its CAS", async () => {
    mocks.settleRunnerJob.mockResolvedValue({ replayed: true });
    mocks.refreshRunnerAdmission.mockResolvedValueOnce({
      ...ADMISSION,
      duplicate: true,
      status: "succeeded",
      result,
      runtimeImageDigest: result.imageDigest,
    });

    const response = await POST(request());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ status: "accepted", replayed: true });
    expect(mocks.settleRunnerJob).toHaveBeenCalledOnce();
    expect(mocks.refreshRunnerAdmission).toHaveBeenCalledWith(ADMISSION);
  });

  it("persists a terminal runner failure and returns non-authoritative infrastructure evidence", async () => {
    mocks.submit.mockResolvedValueOnce(completedJob({
      state: "FAILED",
      queuePosition: null,
      result: undefined,
      error: { code: "QUEUE_CAPACITY", retryable: true },
    }));

    const response = await POST(request());
    const body = await response.json();

    expect(response.status).toBe(502);
    expect(mocks.recordRunnerDispatch).not.toHaveBeenCalled();
    expect(mocks.settleRunnerJob).toHaveBeenCalledWith(expect.objectContaining({
      admission: ADMISSION,
      status: "failed",
      result: { error: "QUEUE_CAPACITY" },
      runtimeImageDigest: "runner-infrastructure-error",
    }));
    expect(body).toMatchObject({
      status: "infrastructure_error",
      error: "QUEUE_CAPACITY",
      queue: { initialState: "failed", position: null },
      officialMasteryEvidence: false,
    });
  });
});
