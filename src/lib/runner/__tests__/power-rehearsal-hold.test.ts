import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  query: vi.fn(),
  release: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({
  pool: { connect: mocks.connect },
}));

import {
  holdRunnerDispatchForPowerRehearsal,
  RunnerPowerRehearsalError,
} from "../power-rehearsal-hold";

const input = {
  userId: "learner-one",
  requestId: "10000000-0000-4000-8000-000000000001",
  submissionId: "20000000-0000-4000-8000-000000000001",
  runnerJobId: "30000000-0000-4000-8000-000000000001",
  now: new Date("2026-07-20T12:00:00.000Z"),
};

function eventRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "40000000-0000-4000-8000-000000000001",
    state: "armed",
    learner_one_id: input.userId,
    learner_two_id: "learner-two",
    slot_one_request_id: null,
    slot_one_submission_id: null,
    slot_one_runner_job_id: null,
    slot_two_request_id: null,
    slot_two_submission_id: null,
    slot_two_runner_job_id: null,
    expires_at: new Date("2026-07-20T12:30:00.000Z"),
    ...overrides,
  };
}
function bindingRow(overrides: Record<string, unknown> = {}) {
  return {
    runner_job_id: input.runnerJobId,
    submission_id: input.submissionId,
    learner_user_id: input.userId,
    request_id: input.requestId,
    submission_type: "server_run",
    runner_status: "leased",
    submission_status: "leased",
    dispatch_request_present: true,
    recovery_state: "ready",
    remote_runner_job_id: null,
    ...overrides,
  };
}

function pristineDispatchQuery(statement: string) {
  if (statement.includes("pg_advisory_xact_lock")) return { rows: [], rowCount: 1 };
  if (statement.includes("from runner_job j join code_submission s")) return { rows: [bindingRow()], rowCount: 1 };
  return null;
}


describe("power rehearsal runner hold", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.connect.mockResolvedValue({ query: mocks.query, release: mocks.release });
    mocks.query.mockImplementation(async (statement: string) => {
      if (statement === "begin" || statement === "commit" || statement === "rollback") {
        return { rows: [], rowCount: 0 };
      }
      throw new Error(`Unexpected SQL: ${statement}`);
    });
  });

  it("continues normally when no rehearsal is armed for the learner", async () => {
    mocks.query.mockImplementation(async (statement: string) => {
      if (statement === "begin" || statement === "commit") return { rows: [], rowCount: 0 };
      if (statement.includes("from runner_power_rehearsal_event")) return { rows: [], rowCount: 0 };
      throw new Error(`Unexpected SQL: ${statement}`);
    });

    await expect(holdRunnerDispatchForPowerRehearsal(input)).resolves.toEqual({ held: false });
    expect(mocks.query).toHaveBeenCalledWith("commit");
    expect(mocks.release).toHaveBeenCalledOnce();
  });

  it("atomically claims the learner slot and reports whether both slots are filled", async () => {
    mocks.query.mockImplementation(async (statement: string, params?: unknown[]) => {
      if (statement === "begin" || statement === "commit") return { rows: [], rowCount: 0 };
      if (statement.includes("from runner_power_rehearsal_event")) return { rows: [eventRow()], rowCount: 1 };
      const dispatchResult = pristineDispatchQuery(statement);
      if (dispatchResult) return dispatchResult;
      if (statement.includes("update runner_power_rehearsal_event")) {
        expect(params).toEqual([
          eventRow().id,
          input.requestId,
          input.submissionId,
          input.runnerJobId,
          input.now,
        ]);
        return { rows: [{ state: "armed" }], rowCount: 1 };
      }
      throw new Error(`Unexpected SQL: ${statement}`);
    });

    await expect(holdRunnerDispatchForPowerRehearsal(input)).resolves.toEqual({
      held: true,
      eventId: eventRow().id,
      slot: 1,
      filled: false,
      replayed: false,
      expired: false,
    });
  });
  it("takes the recovery advisory lock and validates the exact pristine dispatch before binding the slot", async () => {
    mocks.query.mockImplementation(async (statement: string) => {
      if (statement === "begin" || statement === "commit") return { rows: [], rowCount: 0 };
      if (statement.includes("from runner_power_rehearsal_event")) return { rows: [eventRow()], rowCount: 1 };
      if (statement.includes("pg_advisory_xact_lock")) return { rows: [], rowCount: 1 };
      if (statement.includes("from runner_job j join code_submission s")) {
        return { rows: [bindingRow()], rowCount: 1 };
      }
      if (statement.includes("update runner_power_rehearsal_event")) {
        return { rows: [{ state: "armed" }], rowCount: 1 };
      }
      throw new Error(`Unexpected SQL: ${statement}`);
    });

    await expect(holdRunnerDispatchForPowerRehearsal(input)).resolves.toMatchObject({ held: true });

    const statements = mocks.query.mock.calls.map(([statement]) => String(statement));
    const lockIndex = statements.findIndex((statement) => statement.includes("pg_advisory_xact_lock"));
    const validationIndex = statements.findIndex((statement) =>
      statement.includes("from runner_job j join code_submission s"));
    const bindIndex = statements.findIndex((statement) =>
      statement.includes("update runner_power_rehearsal_event"));
    expect(lockIndex).toBeGreaterThan(-1);
    expect(validationIndex).toBeGreaterThan(lockIndex);
    expect(bindIndex).toBeGreaterThan(validationIndex);
  });


  it("treats an exact retry as held without mutating or dispatching it", async () => {
    mocks.query.mockImplementation(async (statement: string) => {
      if (statement === "begin" || statement === "commit") return { rows: [], rowCount: 0 };
      if (statement.includes("from runner_power_rehearsal_event")) {
        return { rows: [eventRow({
          slot_one_request_id: input.requestId,
          slot_one_submission_id: input.submissionId,
          slot_one_runner_job_id: input.runnerJobId,
        })], rowCount: 1 };
      }
      const dispatchResult = pristineDispatchQuery(statement);
      if (dispatchResult) return dispatchResult;
      throw new Error(`Unexpected SQL: ${statement}`);
    });

    await expect(holdRunnerDispatchForPowerRehearsal(input)).resolves.toMatchObject({
      held: true,
      slot: 1,
      replayed: true,
    });
    expect(mocks.query.mock.calls.some(([sql]) => String(sql).includes("update runner_power_rehearsal_event"))).toBe(false);
  });

  it("fails closed when the learner slot already belongs to a different request", async () => {
    mocks.query.mockImplementation(async (statement: string) => {
      if (statement === "begin" || statement === "rollback") return { rows: [], rowCount: 0 };
      if (statement.includes("from runner_power_rehearsal_event")) {
        return { rows: [eventRow({
          slot_one_request_id: "50000000-0000-4000-8000-000000000001",
          slot_one_submission_id: "50000000-0000-4000-8000-000000000002",
          slot_one_runner_job_id: "50000000-0000-4000-8000-000000000003",
        })], rowCount: 1 };
      }
      throw new Error(`Unexpected SQL: ${statement}`);
    });

    await expect(holdRunnerDispatchForPowerRehearsal(input)).rejects.toMatchObject({
      code: "SLOT_ALREADY_CLAIMED",
      indeterminate: false,
    });
    expect(mocks.query).toHaveBeenCalledWith("rollback");
  });

  it("holds instead of silently dispatching when the operator window has expired", async () => {
    mocks.query.mockImplementation(async (statement: string) => {
      if (statement === "begin" || statement === "commit") return { rows: [], rowCount: 0 };
      if (statement.includes("from runner_power_rehearsal_event")) {
        return { rows: [eventRow({ expires_at: new Date("2026-07-20T11:59:59.000Z") })], rowCount: 1 };
      }
      const dispatchResult = pristineDispatchQuery(statement);
      if (dispatchResult) return dispatchResult;
      if (statement.includes("update runner_power_rehearsal_event")) return { rows: [{ state: "armed" }], rowCount: 1 };
      throw new Error(`Unexpected SQL: ${statement}`);
    });

    await expect(holdRunnerDispatchForPowerRehearsal(input)).resolves.toMatchObject({
      held: true,
      expired: true,
    });
  });

  it("marks commit uncertainty as indeterminate so callers never terminalize a possibly held job", async () => {
    mocks.query.mockImplementation(async (statement: string) => {
      if (statement === "begin") return { rows: [], rowCount: 0 };
      if (statement.includes("from runner_power_rehearsal_event")) return { rows: [eventRow()], rowCount: 1 };
      const dispatchResult = pristineDispatchQuery(statement);
      if (dispatchResult) return dispatchResult;
      if (statement.includes("update runner_power_rehearsal_event")) return { rows: [{ state: "armed" }], rowCount: 1 };
      if (statement === "commit") throw new Error("connection reset after commit");
      if (statement === "rollback") return { rows: [], rowCount: 0 };
      throw new Error(`Unexpected SQL: ${statement}`);
    });

    await expect(holdRunnerDispatchForPowerRehearsal(input)).rejects.toSatisfy((error: unknown) => {
      return error instanceof RunnerPowerRehearsalError
        && error.code === "HOLD_PERSISTENCE_INDETERMINATE"
        && error.indeterminate;
    });
  });
});
