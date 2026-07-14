import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ connect: vi.fn() }));

vi.mock("@/lib/db/client", () => ({
  pool: { connect: mocks.connect },
}));

import {
  admitRunnerJob,
  beginRunnerDispatch,
  hashRunnerAdmissionRequest,
  isOfficialRunnerSubmissionType,
  recordRunnerDispatch,
  refreshRunnerAdmission,
  requireFreshRunnerMutation,
  RunnerAdmissionError,
  settleRunnerJob,
  type RunnerAdmission,
} from "../admission";
import type { RunnerRequest } from "../client";

const admission: RunnerAdmission = {
  submissionId: "10000000-0000-4000-8000-000000000001",
  runnerJobId: "20000000-0000-4000-8000-000000000001",
  userId: "learner-1",
  requestId: "official-request-1",
  requestHash: "a".repeat(64),
  submissionType: "exam_final_test",
  status: "queued",
  remoteJobId: null,
  result: null,
  runtimeImageDigest: "pending-runner-result",
  queuedAt: new Date("2026-07-13T00:00:00.000Z"),
  duplicate: false,
};

const dispatchRequest: RunnerRequest = {
  submissionId: admission.submissionId,
  correlationId: admission.requestId,
  language: "python",
  runtimeVersion: "Python 3.14",
  mode: "RUN",
  sourceFiles: [{ path: "main.py", content: "print(1)\n" }],
  entrypoint: "main.py",
  limits: { wallTimeMs: 5_000 },
};

function clientWith(query: ReturnType<typeof vi.fn>) {
  const client = { query, release: vi.fn() };
  mocks.connect.mockResolvedValueOnce(client);
  return client;
}

function validInput() {
  const sourceCode = "print(1)\n";
  return {
    userId: "learner-1",
    language: "python",
    sourceCode,
    sourceHash: "b".repeat(64),
    submissionType: "exam_final_test",
    requestId: "official-request-1",
    requestHash: "a".repeat(64),
    limits: { wallTimeMs: 5_000 },
    now: new Date("2026-07-13T00:00:00.000Z"),
  };
}

type AdmissionStatus = RunnerAdmission["status"];

function mutationClient(options: {
  submissionStatus?: AdmissionStatus;
  jobStatus?: AdmissionStatus;
  requestId?: string;
  requestHash?: string;
  remoteJobId?: string | null;
  dispatchRequest?: unknown;
  recoveryState?: string | null;
  submissionPresent?: boolean;
  jobPresent?: boolean;
  runnerUpdateCount?: number;
  submissionUpdateCount?: number;
} = {}) {
  mocks.connect.mockReset();
  const submissionStatus = options.submissionStatus ?? "queued";
  const jobStatus = options.jobStatus ?? submissionStatus;
  const query = vi.fn(async (statement: string, values?: unknown[]) => {
    void values;
    if (["begin", "commit", "rollback"].includes(statement)) return { rows: [], rowCount: 0 };
    if (statement.includes("pg_advisory_xact_lock")) return { rows: [], rowCount: 1 };
    if (statement.includes(`select status from "user"`)) {
      return { rows: [{ status: "active" }], rowCount: 1 };
    }
    if (statement.includes("select status,request_id,request_hash from code_submission")) {
      return {
        rows: options.submissionPresent === false ? [] : [{
          status: submissionStatus,
          request_id: options.requestId ?? admission.requestId,
          request_hash: options.requestHash ?? admission.requestHash,
        }],
        rowCount: options.submissionPresent === false ? 0 : 1,
      };
    }
    if (statement.includes("select status,lease_owner,dispatch_request,recovery_state from runner_job")) {
      return {
        rows: options.jobPresent === false ? [] : [{
          status: jobStatus,
          lease_owner: options.remoteJobId ?? null,
          dispatch_request: options.dispatchRequest ?? null,
          recovery_state: options.recoveryState ?? null,
        }],
        rowCount: options.jobPresent === false ? 0 : 1,
      };
    }
    if (statement.includes("update runner_job")) {
      return { rows: [], rowCount: options.runnerUpdateCount ?? 1 };
    }
    if (statement.includes("update code_submission")) {
      return { rows: [], rowCount: options.submissionUpdateCount ?? 1 };
    }
    throw new Error(`unexpected query: ${statement}`);
  });
  return { query, client: clientWith(query) };
}

describe("runner admission policy", () => {
  it("hashes canonical request content independently of object key order", () => {
    const left = hashRunnerAdmissionRequest({
      language: "python",
      limits: { memoryMb: 128, wallTimeMs: 5_000 },
      tests: [{ id: "visible", stdin: "" }],
    });
    const reordered = hashRunnerAdmissionRequest({
      tests: [{ stdin: "", id: "visible" }],
      limits: { wallTimeMs: 5_000, memoryMb: 128 },
      language: "python",
    });
    const changed = hashRunnerAdmissionRequest({
      language: "python",
      limits: { memoryMb: 128, wallTimeMs: 5_001 },
      tests: [{ id: "visible", stdin: "" }],
    });

    expect(left).toMatch(/^[a-f0-9]{64}$/);
    expect(reordered).toBe(left);
    expect(changed).not.toBe(left);
  });

  it("applies the one-slot policy only to official runner work", () => {
    expect(isOfficialRunnerSubmissionType("exam_final_test")).toBe(true);
    expect(isOfficialRunnerSubmissionType("assessment_correction_regrade")).toBe(true);
    expect(isOfficialRunnerSubmissionType("server_run")).toBe(false);
    expect(isOfficialRunnerSubmissionType("server_compile")).toBe(false);
  });

  it("fails closed when a dispatch or settlement loses to terminal truth", () => {
    expect(() => requireFreshRunnerMutation({ replayed: false })).not.toThrow();
    expect(() => requireFreshRunnerMutation({ replayed: true })).toThrowError(
      expect.objectContaining<Partial<RunnerAdmissionError>>({
        code: "TERMINAL_REPLAY",
        retryable: false,
      }),
    );
  });

  it("validates input before opening a database connection", async () => {
    mocks.connect.mockReset();
    await expect(admitRunnerJob({ ...validInput(), requestId: "bad/id" }))
      .rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it("takes the global user-authority lock first and refuses a non-active user", async () => {
    mocks.connect.mockReset();
    const query = vi.fn(async (statement: string, values?: unknown[]) => {
      if (statement === "begin" || statement === "rollback") return { rows: [], rowCount: 0 };
      if (statement.includes("pg_advisory_xact_lock")) return { rows: [], rowCount: 1 };
      if (statement.includes(`select status from "user"`)) {
        return { rows: [{ status: "deletion_pending" }], rowCount: 1 };
      }
      throw new Error(`unexpected query: ${statement} ${String(values)}`);
    });
    const client = clientWith(query);

    await expect(admitRunnerJob(validInput())).rejects.toMatchObject({ code: "USER_NOT_ACTIVE" });

    expect(query.mock.calls[1]?.[1]).toEqual(["user-authority:learner-1"]);
    expect(query.mock.calls.some(([, values]) =>
      Array.isArray(values) && values[0] === "runner-learner:learner-1")).toBe(false);
    expect(query.mock.calls.at(-1)?.[0]).toBe("rollback");
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("rejects malformed hashes, limits, priorities, timestamps, and empty source before DB access", async () => {
    const invalidInputs = [
      { ...validInput(), userId: "" },
      { ...validInput(), sourceHash: "not-a-hash" },
      { ...validInput(), language: "" },
      { ...validInput(), submissionType: "" },
      { ...validInput(), sourceCode: "" },
      { ...validInput(), now: new Date(Number.NaN) },
      { ...validInput(), priority: -1 },
      { ...validInput(), priority: 10_001 },
      { ...validInput(), priority: 1.5 },
      { ...validInput(), limits: { wallTimeMs: 0 } },
      { ...validInput(), limits: { wallTimeMs: Number.POSITIVE_INFINITY } },
    ];

    for (const input of invalidInputs) {
      mocks.connect.mockReset();
      await expect(admitRunnerJob(input)).rejects.toMatchObject({ code: "INVALID_INPUT" });
      expect(mocks.connect).not.toHaveBeenCalled();
    }
  });

  it.each([
    "queued",
    "leased",
    "running",
    "succeeded",
    "failed",
    "timed_out",
    "cancelled",
  ] as const)("replays an exact %s admission without inserting duplicate work", async (status) => {
    mocks.connect.mockReset();
    const query = vi.fn(async (statement: string) => {
      if (["begin", "commit"].includes(statement) || statement.includes("pg_advisory_xact_lock")) {
        return { rows: [], rowCount: 0 };
      }
      if (statement.includes(`select status from "user"`)) {
        return { rows: [{ status: "active" }], rowCount: 1 };
      }
      if (statement.includes("from code_submission s")) return { rows: [], rowCount: 0 };
      if (statement.includes("from code_submission where user_id")) {
        return { rows: [{
          id: admission.submissionId,
          user_id: admission.userId,
          request_id: admission.requestId,
          request_hash: admission.requestHash,
          submission_type: admission.submissionType,
          status,
          runtime_image_digest: "sha256:runtime",
        }], rowCount: 1 };
      }
      if (statement.includes("from runner_job where submission_id")) {
        return { rows: [{
          id: admission.runnerJobId,
          status,
          lease_owner: "remote-job-1",
          result: status === "succeeded" ? { status: "ACCEPTED" } : null,
          queued_at: admission.queuedAt,
        }], rowCount: 1 };
      }
      throw new Error(`unexpected query: ${statement}`);
    });
    clientWith(query);

    await expect(admitRunnerJob(validInput())).resolves.toMatchObject({
      submissionId: admission.submissionId,
      runnerJobId: admission.runnerJobId,
      status,
      duplicate: true,
      remoteJobId: "remote-job-1",
    });
    expect(query.mock.calls.some(([statement]) => String(statement).includes("insert into"))).toBe(false);
  });

  it("rejects idempotency hash reuse and linked status drift", async () => {
    for (const mismatch of ["hash", "status"] as const) {
      mocks.connect.mockReset();
      const query = vi.fn(async (statement: string) => {
        if (statement === "begin" || statement === "rollback" || statement.includes("pg_advisory_xact_lock")) {
          return { rows: [], rowCount: 0 };
        }
        if (statement.includes(`select status from "user"`)) return { rows: [{ status: "active" }], rowCount: 1 };
        if (statement.includes("from code_submission s")) return { rows: [], rowCount: 0 };
        if (statement.includes("from code_submission where user_id")) {
          return { rows: [{
            id: admission.submissionId,
            user_id: admission.userId,
            request_id: admission.requestId,
            request_hash: mismatch === "hash" ? "c".repeat(64) : admission.requestHash,
            submission_type: admission.submissionType,
            status: "queued",
            runtime_image_digest: "pending-runner-result",
          }], rowCount: 1 };
        }
        if (statement.includes("from runner_job where submission_id")) {
          return { rows: [{
            id: admission.runnerJobId,
            status: mismatch === "status" ? "leased" : "queued",
            lease_owner: null,
            result: null,
            queued_at: admission.queuedAt,
          }], rowCount: 1 };
        }
        throw new Error(`unexpected query: ${statement}`);
      });
      clientWith(query);

      await expect(admitRunnerJob(validInput())).rejects.toMatchObject({
        code: mismatch === "hash" ? "IDEMPOTENCY_MISMATCH" : "WRITE_CONFLICT",
      });
      expect(query.mock.calls.at(-1)?.[0]).toBe("rollback");
    }
  });

  it("fails closed when an existing submission has no linked runner job", async () => {
    mocks.connect.mockReset();
    const query = vi.fn(async (statement: string) => {
      if (statement === "begin" || statement === "rollback" || statement.includes("pg_advisory_xact_lock")) {
        return { rows: [], rowCount: 0 };
      }
      if (statement.includes(`select status from "user"`)) return { rows: [{ status: "active" }], rowCount: 1 };
      if (statement.includes("from code_submission s")) return { rows: [], rowCount: 0 };
      if (statement.includes("from code_submission where user_id")) {
        return { rows: [{
          id: admission.submissionId,
          user_id: admission.userId,
          request_id: admission.requestId,
          request_hash: admission.requestHash,
          submission_type: admission.submissionType,
          status: "queued",
          runtime_image_digest: "pending-runner-result",
        }], rowCount: 1 };
      }
      if (statement.includes("from runner_job where submission_id")) return { rows: [], rowCount: 0 };
      throw new Error(`unexpected query: ${statement}`);
    });
    clientWith(query);

    await expect(admitRunnerJob(validInput())).rejects.toMatchObject({ code: "WRITE_CONFLICT" });
  });

  it("reports the active official submission when the one-slot capacity is busy", async () => {
    mocks.connect.mockReset();
    const query = vi.fn(async (statement: string) => {
      if (statement === "begin" || statement === "rollback" || statement.includes("pg_advisory_xact_lock")) {
        return { rows: [], rowCount: 0 };
      }
      if (statement.includes(`select status from "user"`)) return { rows: [{ status: "active" }], rowCount: 1 };
      if (statement.includes("from code_submission s")) return { rows: [], rowCount: 0 };
      if (statement.includes("from code_submission where user_id") && statement.includes("request_id")) {
        return { rows: [], rowCount: 0 };
      }
      if (statement.includes("submission_type in") && statement.includes("status in")) {
        return { rows: [{ id: "active-official-1" }], rowCount: 1 };
      }
      throw new Error(`unexpected query: ${statement}`);
    });
    clientWith(query);

    await expect(admitRunnerJob(validInput())).rejects.toMatchObject({
      code: "OFFICIAL_CAPACITY_BUSY",
      retryable: true,
      activeSubmissionId: "active-official-1",
    });
  });

  it("creates a new queued admission only after stale and capacity checks", async () => {
    mocks.connect.mockReset();
    const query = vi.fn(async (statement: string) => {
      if (["begin", "commit"].includes(statement) || statement.includes("pg_advisory_xact_lock")) {
        return { rows: [], rowCount: 0 };
      }
      if (statement.includes(`select status from "user"`)) return { rows: [{ status: "active" }], rowCount: 1 };
      if (statement.includes("from code_submission s")) return { rows: [], rowCount: 0 };
      if (statement.includes("from code_submission where user_id") && statement.includes("request_id")) {
        return { rows: [], rowCount: 0 };
      }
      if (statement.includes("submission_type in") && statement.includes("status in")) {
        return { rows: [], rowCount: 0 };
      }
      if (statement.includes("insert into code_submission") || statement.includes("insert into runner_job")) {
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`unexpected query: ${statement}`);
    });
    clientWith(query);

    await expect(admitRunnerJob(validInput())).resolves.toMatchObject({
      userId: admission.userId,
      requestId: admission.requestId,
      status: "queued",
      remoteJobId: null,
      runtimeImageDigest: "pending-runner-result",
      duplicate: false,
    });
    const statements = query.mock.calls.map(([statement]) => String(statement));
    expect(statements.findIndex((statement) => statement.includes("from code_submission s")))
      .toBeLessThan(statements.findIndex((statement) => statement.includes("insert into code_submission")));
    expect(statements.at(-1)).toBe("commit");
  });

  it("terminally reconciles a stale undispatched official job before admitting replacement work", async () => {
    mocks.connect.mockReset();
    const staleSubmissionId = "30000000-0000-4000-8000-000000000001";
    const staleJobId = "40000000-0000-4000-8000-000000000001";
    const query = vi.fn(async (statement: string, values?: unknown[]) => {
      if (["begin", "commit"].includes(statement) || statement.includes("pg_advisory_xact_lock")) {
        return { rows: [], rowCount: 0 };
      }
      if (statement.includes(`select status from "user"`)) return { rows: [{ status: "active" }], rowCount: 1 };
      if (statement.includes("from code_submission s")) {
        return { rows: [{ submission_id: staleSubmissionId, runner_job_id: staleJobId }], rowCount: 1 };
      }
      if (statement.includes("update runner_job")) {
        expect(values?.[0]).toBe(staleJobId);
        expect(JSON.parse(String(values?.[1]))).toMatchObject({ error: "OFFICIAL_DISPATCH_STALE" });
        return { rows: [], rowCount: 1 };
      }
      if (statement.includes("update code_submission")) {
        expect(values?.[0]).toBe(staleSubmissionId);
        return { rows: [], rowCount: 1 };
      }
      if (statement.includes("from code_submission where user_id") && statement.includes("request_id")) {
        return { rows: [], rowCount: 0 };
      }
      if (statement.includes("submission_type in") && statement.includes("status in")) return { rows: [], rowCount: 0 };
      if (statement.includes("insert into")) return { rows: [], rowCount: 1 };
      throw new Error(`unexpected query: ${statement}`);
    });
    clientWith(query);

    await expect(admitRunnerJob(validInput())).resolves.toMatchObject({ status: "queued", duplicate: false });
  });

  it.each([
    { runnerCount: 0, submissionCount: 1 },
    { runnerCount: 1, submissionCount: 0 },
  ])("fails closed when stale reconciliation loses a CAS: %j", async ({ runnerCount, submissionCount }) => {
    mocks.connect.mockReset();
    const query = vi.fn(async (statement: string) => {
      if (statement === "begin" || statement === "rollback" || statement.includes("pg_advisory_xact_lock")) {
        return { rows: [], rowCount: 0 };
      }
      if (statement.includes(`select status from "user"`)) return { rows: [{ status: "active" }], rowCount: 1 };
      if (statement.includes("from code_submission s")) {
        return { rows: [{ submission_id: "stale-submission", runner_job_id: "stale-job" }], rowCount: 1 };
      }
      if (statement.includes("update runner_job")) return { rows: [], rowCount: runnerCount };
      if (statement.includes("update code_submission")) return { rows: [], rowCount: submissionCount };
      throw new Error(`unexpected query: ${statement}`);
    });
    clientWith(query);

    await expect(admitRunnerJob(validInput())).rejects.toMatchObject({ code: "WRITE_CONFLICT" });
    expect(query.mock.calls.at(-1)?.[0]).toBe("rollback");
  });

  it("maps the official uniqueness constraint to retryable capacity pressure", async () => {
    mocks.connect.mockReset();
    const query = vi.fn(async (statement: string) => {
      if (statement === "begin" || statement === "rollback" || statement.includes("pg_advisory_xact_lock")) {
        return { rows: [], rowCount: 0 };
      }
      if (statement.includes(`select status from "user"`)) return { rows: [{ status: "active" }], rowCount: 1 };
      if (statement.includes("from code_submission s")) return { rows: [], rowCount: 0 };
      if (statement.includes("from code_submission where user_id") && statement.includes("request_id")) {
        return { rows: [], rowCount: 0 };
      }
      if (statement.includes("submission_type in") && statement.includes("status in")) return { rows: [], rowCount: 0 };
      if (statement.includes("insert into code_submission")) {
        throw { constraint: "code_submission_one_active_official_user" };
      }
      throw new Error(`unexpected query: ${statement}`);
    });
    clientWith(query);

    await expect(admitRunnerJob(validInput())).rejects.toMatchObject({
      code: "OFFICIAL_CAPACITY_BUSY",
      retryable: true,
    });
  });

  it("refreshes exact durable truth and preserves the original conflict if rollback also fails", async () => {
    mocks.connect.mockReset();
    const successQuery = vi.fn(async (statement: string) => {
      if (["begin", "commit"].includes(statement) || statement.includes("pg_advisory_xact_lock")) {
        return { rows: [], rowCount: 0 };
      }
      if (statement.includes("from code_submission where user_id")) {
        return { rows: [{
          id: admission.submissionId,
          user_id: admission.userId,
          request_id: admission.requestId,
          request_hash: admission.requestHash,
          submission_type: admission.submissionType,
          status: "running",
          runtime_image_digest: "pending-runner-result",
        }], rowCount: 1 };
      }
      if (statement.includes("from runner_job where submission_id")) {
        return { rows: [{
          id: admission.runnerJobId,
          status: "running",
          lease_owner: "remote-job-1",
          result: null,
          queued_at: admission.queuedAt,
        }], rowCount: 1 };
      }
      throw new Error(`unexpected query: ${statement}`);
    });
    clientWith(successQuery);
    await expect(refreshRunnerAdmission(admission)).resolves.toMatchObject({
      status: "running",
      remoteJobId: "remote-job-1",
      duplicate: true,
    });

    mocks.connect.mockReset();
    const rollbackFailure = new Error("rollback unavailable");
    const conflictQuery = vi.fn(async (statement: string) => {
      if (statement === "begin" || statement.includes("pg_advisory_xact_lock")) return { rows: [], rowCount: 0 };
      if (statement.includes("from code_submission where user_id")) return { rows: [], rowCount: 0 };
      if (statement === "rollback") throw rollbackFailure;
      throw new Error(`unexpected query: ${statement}`);
    });
    const client = clientWith(conflictQuery);
    await expect(refreshRunnerAdmission(admission)).rejects.toMatchObject({ code: "WRITE_CONFLICT" });
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("persists the leased indeterminate boundary before remote dispatch", async () => {
    mocks.connect.mockReset();
    const query = vi.fn(async (statement: string, values?: unknown[]) => {
      void values;
      if (["begin", "commit"].includes(statement)) return { rows: [], rowCount: 0 };
      if (statement.includes("pg_advisory_xact_lock")) return { rows: [], rowCount: 1 };
      if (statement.includes(`select status from "user"`)) {
        return { rows: [{ status: "active" }], rowCount: 1 };
      }
      if (statement.includes("from code_submission") && statement.includes("for update")) {
        return { rows: [{ status: "queued", request_id: admission.requestId, request_hash: admission.requestHash }], rowCount: 1 };
      }
      if (statement.includes("from runner_job") && statement.includes("for update")) {
        return { rows: [{ status: "queued", lease_owner: null }], rowCount: 1 };
      }
      if (statement.includes("update runner_job") || statement.includes("update code_submission")) {
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`unexpected query: ${statement}`);
    });
    clientWith(query);

    await expect(beginRunnerDispatch({ admission })).resolves.toEqual({ replayed: false, remoteJobId: null });
    const runnerUpdate = query.mock.calls.find(([statement]) => String(statement).includes("update runner_job"));
    expect(runnerUpdate?.[1]?.[1]).toBe("leased");
  });

  it.each([
    ["queued", "leased"],
    ["leased", "leased"],
    ["running", "running"],
  ] as const)("begins %s dispatch as %s and persists the immutable request snapshot", async (status, expectedStatus) => {
    const { query } = mutationClient({ submissionStatus: status });

    await expect(beginRunnerDispatch({
      admission: { ...admission, status },
      dispatchRequest,
      now: new Date("2026-07-13T00:01:00.000Z"),
    })).resolves.toEqual({ replayed: false, remoteJobId: null });

    const runnerUpdate = query.mock.calls.find(([statement]) => String(statement).includes("update runner_job"));
    expect(runnerUpdate?.[1]?.[1]).toBe(expectedStatus);
    expect(JSON.parse(String(runnerUpdate?.[1]?.[3]))).toEqual(dispatchRequest);
  });

  it("accepts only an exactly matching persisted dispatch snapshot", async () => {
    mutationClient({ submissionStatus: "leased", dispatchRequest });
    await expect(beginRunnerDispatch({
      admission: { ...admission, status: "leased" },
      dispatchRequest,
    })).resolves.toMatchObject({ replayed: false });

    mutationClient({
      submissionStatus: "leased",
      dispatchRequest: { ...dispatchRequest, entrypoint: "different.py" },
    });
    await expect(beginRunnerDispatch({
      admission: { ...admission, status: "leased" },
      dispatchRequest,
    })).rejects.toMatchObject({ code: "IDEMPOTENCY_MISMATCH" });

    mutationClient({ submissionStatus: "leased", dispatchRequest: { invalid: 1n } });
    await expect(beginRunnerDispatch({
      admission: { ...admission, status: "leased" },
      dispatchRequest,
    })).rejects.toMatchObject({ code: "WRITE_CONFLICT" });
  });

  it("rejects invalid dispatch timestamps, bindings, serialization, and oversized snapshots before DB access", async () => {
    const cyclic = { ...dispatchRequest } as RunnerRequest & { self?: unknown };
    cyclic.self = cyclic;
    const oversized: RunnerRequest = {
      ...dispatchRequest,
      sourceFiles: [{ path: "main.py", content: "x".repeat(1_048_577) }],
    };
    const cases = [
      { admission, now: new Date(Number.NaN) },
      { admission, dispatchRequest: { ...dispatchRequest, submissionId: "wrong-submission" } },
      { admission, dispatchRequest: cyclic },
      { admission, dispatchRequest: oversized },
    ];

    for (const input of cases) {
      mocks.connect.mockReset();
      await expect(beginRunnerDispatch(input)).rejects.toMatchObject({ code: "INVALID_INPUT" });
      expect(mocks.connect).not.toHaveBeenCalled();
    }
  });

  it.each([
    "succeeded",
    "failed",
    "timed_out",
    "cancelled",
  ] as const)("replays terminal %s dispatch without mutating either side", async (status) => {
    const { query } = mutationClient({
      submissionStatus: status,
      remoteJobId: "remote-terminal-1",
    });

    await expect(beginRunnerDispatch({ admission: { ...admission, status } }))
      .resolves.toEqual({ replayed: true, remoteJobId: "remote-terminal-1" });
    expect(query.mock.calls.some(([statement]) => String(statement).includes("update runner_job"))).toBe(false);
    expect(query.mock.calls.at(-1)?.[0]).toBe("commit");
  });

  it.each([
    { runnerUpdateCount: 0, submissionUpdateCount: 1 },
    { runnerUpdateCount: 1, submissionUpdateCount: 0 },
  ])("rolls back begin-dispatch CAS failures: %j", async (counts) => {
    const { query } = mutationClient({ submissionStatus: "queued", ...counts });

    await expect(beginRunnerDispatch({ admission, dispatchRequest }))
      .rejects.toMatchObject({ code: "WRITE_CONFLICT" });
    expect(query.mock.calls.at(-1)?.[0]).toBe("rollback");
  });

  it.each([
    ["missing submission", { submissionPresent: false }],
    ["missing runner job", { jobPresent: false }],
    ["request id drift", { requestId: "different-request" }],
    ["request hash drift", { requestHash: "d".repeat(64) }],
    ["status drift", { submissionStatus: "queued" as const, jobStatus: "leased" as const }],
  ] as const)("fails closed on locked admission %s", async (_label, options) => {
    mutationClient(options);
    await expect(beginRunnerDispatch({ admission })).rejects.toMatchObject({ code: "WRITE_CONFLICT" });
  });

  it("rejects a dispatch that tries to replace an immutable remote job id", async () => {
    mocks.connect.mockReset();
    const query = vi.fn(async (statement: string) => {
      if (statement === "begin" || statement === "rollback" || statement.includes("pg_advisory_xact_lock")) {
        return { rows: [], rowCount: 0 };
      }
      if (statement.includes("from code_submission")) {
        return { rows: [{ status: "running", request_id: admission.requestId, request_hash: admission.requestHash }], rowCount: 1 };
      }
      if (statement.includes("from runner_job")) {
        return { rows: [{ status: "running", lease_owner: "remote-job-a" }], rowCount: 1 };
      }
      throw new Error(`unexpected query: ${statement}`);
    });
    clientWith(query);

    await expect(recordRunnerDispatch({
      admission: { ...admission, status: "running", remoteJobId: "remote-job-a" },
      remoteJobId: "remote-job-b",
      status: "running",
    })).rejects.toMatchObject({ code: "REMOTE_JOB_ID_MISMATCH" });
    expect(query.mock.calls.some(([statement]) => String(statement).startsWith("update runner_job"))).toBe(false);
  });

  it("rejects malformed remote dispatch identifiers before DB access", async () => {
    mocks.connect.mockReset();
    await expect(recordRunnerDispatch({
      admission,
      remoteJobId: "invalid/job",
      status: "queued",
    })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it.each([
    ["queued", "queued", "queued"],
    ["leased", "queued", "queued"],
    ["leased", "running", "running"],
    ["running", "queued", "running"],
  ] as const)("records remote dispatch from %s with %s signal as %s", async (currentStatus, signal, expectedStatus) => {
    const { query } = mutationClient({ submissionStatus: currentStatus });

    await expect(recordRunnerDispatch({
      admission: { ...admission, status: currentStatus },
      remoteJobId: "remote-job-1",
      status: signal,
      now: new Date("2026-07-13T00:02:00.000Z"),
    })).resolves.toEqual({ replayed: false });

    const updates = query.mock.calls.filter(([statement]) => String(statement).includes("update "));
    expect(updates).toHaveLength(2);
    expect(updates[0]?.[1]?.[1]).toBe(expectedStatus);
    expect(updates[1]?.[1]?.[1]).toBe(expectedStatus);
    expect(updates[0]?.[1]?.[2]).toBe("remote-job-1");
  });

  it.each([
    "succeeded",
    "failed",
    "timed_out",
    "cancelled",
  ] as const)("replays terminal %s remote dispatch without mutation", async (status) => {
    const { query } = mutationClient({
      submissionStatus: status,
      remoteJobId: "remote-job-1",
    });

    await expect(recordRunnerDispatch({
      admission: { ...admission, status, remoteJobId: "remote-job-1" },
      remoteJobId: "remote-job-1",
      status: "running",
    })).resolves.toEqual({ replayed: true });
    expect(query.mock.calls.some(([statement]) => String(statement).includes("update runner_job"))).toBe(false);
  });

  it.each([
    { runnerUpdateCount: 0, submissionUpdateCount: 1 },
    { runnerUpdateCount: 1, submissionUpdateCount: 0 },
  ])("rolls back remote-dispatch CAS failures: %j", async (counts) => {
    const { query } = mutationClient({ submissionStatus: "leased", ...counts });
    await expect(recordRunnerDispatch({
      admission: { ...admission, status: "leased" },
      remoteJobId: "remote-job-1",
      status: "running",
    })).rejects.toMatchObject({ code: "WRITE_CONFLICT" });
    expect(query.mock.calls.at(-1)?.[0]).toBe("rollback");
  });

  it("requires exact remote identity even when settlement finds terminal truth", async () => {
    mocks.connect.mockReset();
    const query = vi.fn(async (statement: string) => {
      if (statement === "begin" || statement === "rollback" || statement.includes("pg_advisory_xact_lock")) {
        return { rows: [], rowCount: 0 };
      }
      if (statement.includes("from code_submission")) {
        return { rows: [{ status: "succeeded", request_id: admission.requestId, request_hash: admission.requestHash }], rowCount: 1 };
      }
      if (statement.includes("from runner_job")) {
        return { rows: [{ status: "succeeded", lease_owner: "remote-job-a" }], rowCount: 1 };
      }
      throw new Error(`unexpected query: ${statement}`);
    });
    clientWith(query);

    await expect(settleRunnerJob({
      admission: { ...admission, status: "running", remoteJobId: "remote-job-a" },
      status: "succeeded",
      remoteJobId: "remote-job-b",
      runtimeImageDigest: "sha256:trusted",
      result: { status: "ACCEPTED" },
    })).rejects.toMatchObject({ code: "REMOTE_JOB_ID_MISMATCH" });
  });

  it("validates settlement time, digest, remote id, and required identity before DB access", async () => {
    const base: Parameters<typeof settleRunnerJob>[0] = {
      admission,
      status: "succeeded",
      remoteJobId: "remote-job-1",
      runtimeImageDigest: "sha256:trusted",
      result: { status: "ACCEPTED" },
    };
    const invalidCases: Array<{
      input: Parameters<typeof settleRunnerJob>[0];
      code: string;
    }> = [
      { input: { ...base, completedAt: new Date(Number.NaN) }, code: "INVALID_INPUT" },
      { input: { ...base, runtimeImageDigest: "" }, code: "INVALID_INPUT" },
      { input: { ...base, remoteJobId: "invalid/job" }, code: "INVALID_INPUT" },
      { input: { ...base, remoteJobId: null }, code: "REMOTE_JOB_ID_MISMATCH" },
    ];

    for (const candidate of invalidCases) {
      mocks.connect.mockReset();
      await expect(settleRunnerJob(candidate.input)).rejects.toMatchObject({ code: candidate.code });
      expect(mocks.connect).not.toHaveBeenCalled();
    }
  });

  it.each([
    "queued",
    "leased",
    "running",
  ] as const)("settles active %s work atomically", async (status) => {
    const { query } = mutationClient({ submissionStatus: status });
    const completedAt = new Date("2026-07-13T00:03:00.000Z");

    await expect(settleRunnerJob({
      admission: { ...admission, status },
      status: "succeeded",
      remoteJobId: "remote-job-1",
      runtimeImageDigest: "sha256:trusted",
      result: { status: "ACCEPTED" },
      completedAt,
    })).resolves.toEqual({ replayed: false });

    const runnerUpdate = query.mock.calls.find(([statement]) => String(statement).includes("update runner_job"));
    const submissionUpdate = query.mock.calls.find(([statement]) => String(statement).includes("update code_submission"));
    expect(runnerUpdate?.[1]?.slice(1, 4)).toEqual([
      "succeeded",
      "remote-job-1",
      JSON.stringify({ status: "ACCEPTED" }),
    ]);
    expect(submissionUpdate?.[1]?.slice(1)).toEqual(["succeeded", "sha256:trusted"]);
  });

  it("allows a local failed settlement without a remote id", async () => {
    mutationClient({ submissionStatus: "leased" });
    await expect(settleRunnerJob({
      admission: { ...admission, status: "leased" },
      status: "failed",
      runtimeImageDigest: "runner-local-failure",
      result: { error: "RUNNER_UNAVAILABLE" },
    })).resolves.toEqual({ replayed: false });
  });

  it.each([
    "succeeded",
    "failed",
    "timed_out",
    "cancelled",
  ] as const)("replays terminal %s settlement with exact remote identity", async (status) => {
    const { query } = mutationClient({
      submissionStatus: status,
      remoteJobId: "remote-job-1",
    });

    await expect(settleRunnerJob({
      admission: { ...admission, status, remoteJobId: "remote-job-1" },
      status: "failed",
      remoteJobId: "remote-job-1",
      runtimeImageDigest: "sha256:trusted",
      result: { error: "already terminal" },
    })).resolves.toEqual({ replayed: true });
    expect(query.mock.calls.some(([statement]) => String(statement).includes("update runner_job"))).toBe(false);
  });

  it("rejects adding a remote id to terminal local-only truth", async () => {
    mutationClient({ submissionStatus: "failed", remoteJobId: null });
    await expect(settleRunnerJob({
      admission: { ...admission, status: "failed" },
      status: "failed",
      remoteJobId: "late-remote-job",
      runtimeImageDigest: "runner-local-failure",
      result: { error: "already terminal" },
    })).rejects.toMatchObject({ code: "REMOTE_JOB_ID_MISMATCH" });
  });

  it.each([
    { runnerUpdateCount: 0, submissionUpdateCount: 1 },
    { runnerUpdateCount: 1, submissionUpdateCount: 0 },
  ])("rolls back settlement CAS failures: %j", async (counts) => {
    const { query } = mutationClient({ submissionStatus: "running", remoteJobId: "remote-job-1", ...counts });
    await expect(settleRunnerJob({
      admission: { ...admission, status: "running", remoteJobId: "remote-job-1" },
      status: "succeeded",
      remoteJobId: "remote-job-1",
      runtimeImageDigest: "sha256:trusted",
      result: { status: "ACCEPTED" },
    })).rejects.toMatchObject({ code: "WRITE_CONFLICT" });
    expect(query.mock.calls.at(-1)?.[0]).toBe("rollback");
  });

  it.each(["record", "settle"] as const)("enforces the quarantine fence for %s mutations", async (operation) => {
    const { query } = mutationClient({
      submissionStatus: "leased",
      recoveryState: "quarantined",
    });

    const promise = operation === "record"
      ? recordRunnerDispatch({
          admission: { ...admission, status: "leased" },
          remoteJobId: "remote-job-1",
          status: "running",
        })
      : settleRunnerJob({
          admission: { ...admission, status: "leased" },
          status: "failed",
          runtimeImageDigest: "runner-local-failure",
          result: { error: "blocked" },
        });
    await expect(promise).rejects.toMatchObject({ code: "RECOVERY_QUARANTINED" });
    expect(query.mock.calls.some(([statement]) => String(statement).includes("update runner_job"))).toBe(false);
  });

  it("rejects a quarantined admission before any dispatch mutation can cross the durable fence", async () => {
    mocks.connect.mockReset();
    const query = vi.fn(async (statement: string) => {
      if (statement === "begin" || statement === "rollback" || statement.includes("pg_advisory_xact_lock")) {
        return { rows: [], rowCount: 0 };
      }
      if (statement.includes("select status from \"user\"")) {
        return { rows: [{ status: "active" }], rowCount: 1 };
      }
      if (statement.includes("from code_submission")) {
        return { rows: [{ status: "leased", request_id: admission.requestId, request_hash: admission.requestHash }], rowCount: 1 };
      }
      if (statement.includes("from runner_job")) {
        return { rows: [{
          status: "leased",
          lease_owner: null,
          dispatch_request: null,
          recovery_state: "quarantined",
        }], rowCount: 1 };
      }
      throw new Error(`unexpected query: ${statement}`);
    });
    clientWith(query);

    await expect(beginRunnerDispatch({ admission: { ...admission, status: "leased" } }))
      .rejects.toMatchObject({ code: "RECOVERY_QUARANTINED" });
    expect(query.mock.calls.some(([statement]) => String(statement).startsWith("update runner_job"))).toBe(false);
  });
});
