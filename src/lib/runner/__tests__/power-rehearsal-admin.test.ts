import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  createRunnerPowerRehearsalAdmin,
  RunnerPowerRehearsalAdminError,
  type PowerRehearsalAdminDependencies,
  type PowerRehearsalAdminTransaction,
  type PowerRehearsalBinding,
  type PowerRehearsalEventRecord,
  type PowerRehearsalUser,
} from "../power-rehearsal-admin";

const ACTOR_ID = "admin-internal-1";
const LEARNER_ONE = "learner-internal-1";
const LEARNER_TWO = "learner-internal-2";
const EVENT_ID = "10000000-0000-4000-8000-000000000001";
const COMMAND_ID = "20000000-0000-4000-8000-000000000002";
const REQUEST_ONE = "30000000-0000-4000-8000-000000000003";
const REQUEST_TWO = "40000000-0000-4000-8000-000000000004";
const SUBMISSION_ONE = "50000000-0000-4000-8000-000000000005";
const SUBMISSION_TWO = "60000000-0000-4000-8000-000000000006";
const JOB_ONE = "70000000-0000-4000-8000-000000000007";
const JOB_TWO = "80000000-0000-4000-8000-000000000008";
const NOW = new Date("2026-07-20T10:00:00.000Z");
const REASON = "Supervised physical power-loss recovery rehearsal for the pilot release.";

function event(overrides: Partial<PowerRehearsalEventRecord> = {}): PowerRehearsalEventRecord {
  return {
    id: EVENT_ID,
    state: "armed",
    actorUserId: ACTOR_ID,
    learnerOneId: LEARNER_ONE,
    learnerTwoId: LEARNER_TWO,
    reason: REASON,
    expiresAt: new Date("2026-07-20T10:30:00.000Z"),
    slotOneRequestId: null,
    slotOneSubmissionId: null,
    slotOneRunnerJobId: null,
    slotTwoRequestId: null,
    slotTwoSubmissionId: null,
    slotTwoRunnerJobId: null,
    filledAt: null,
    releasedAt: null,
    abortedAt: null,
    terminalCommandId: null,
    terminalCommandHash: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function filledEvent(overrides: Partial<PowerRehearsalEventRecord> = {}) {
  return event({
    state: "filled",
    slotOneRequestId: REQUEST_ONE,
    slotOneSubmissionId: SUBMISSION_ONE,
    slotOneRunnerJobId: JOB_ONE,
    slotTwoRequestId: REQUEST_TWO,
    slotTwoSubmissionId: SUBMISSION_TWO,
    slotTwoRunnerJobId: JOB_TWO,
    filledAt: new Date("2026-07-20T10:02:00.000Z"),
    ...overrides,
  });
}

function binding(slot: 1 | 2, overrides: Partial<PowerRehearsalBinding> = {}): PowerRehearsalBinding {
  const first = slot === 1;
  return {
    runnerJobId: first ? JOB_ONE : JOB_TWO,
    submissionId: first ? SUBMISSION_ONE : SUBMISSION_TWO,
    learnerUserId: first ? LEARNER_ONE : LEARNER_TWO,
    requestId: first ? REQUEST_ONE : REQUEST_TWO,
    submissionType: "server_run",
    runnerStatus: "leased",
    submissionStatus: "leased",
    dispatchRequestPresent: true,
    recoveryState: "ready",
    remoteRunnerJobId: null,
    ...overrides,
  };
}

function user(id: string, role: "admin" | "learner", status = "active"): PowerRehearsalUser {
  return { id, role, status };
}

function createHarness() {
  const state = {
    users: [
      user(ACTOR_ID, "admin"),
      user(LEARNER_ONE, "learner"),
      user(LEARNER_TWO, "learner"),
    ],
    current: null as PowerRehearsalEventRecord | null,
    active: null as PowerRehearsalEventRecord | null,
    bindings: [binding(1), binding(2)],
    markedDue: 0,
    inserted: null as PowerRehearsalEventRecord | null,
    transitioned: null as PowerRehearsalEventRecord | null,
    auditInputs: [] as Array<Record<string, unknown>>,
    rollback: false,
    commit: false,
  };
  const tx: PowerRehearsalAdminTransaction = {
    lockControl: vi.fn(async () => undefined),
    lockAuthorities: vi.fn(async () => undefined),
    getUsers: vi.fn(async () => state.users),
    getEvent: vi.fn(async () => state.current),
    getActiveEvent: vi.fn(async () => state.active),
    insertEvent: vi.fn(async (record) => {
      state.inserted = record;
      state.current = record;
      return record;
    }),
    getBindings: vi.fn(async () => state.bindings),
    markRecoveryDue: vi.fn(async (ids) => {
      state.markedDue = ids.length;
      return ids.length;
    }),
    transitionEvent: vi.fn(async (input) => {
      if (!state.current || !input.expectedStates.includes(state.current.state)) return null;
      const next = event({
        ...state.current,
        state: input.state,
        updatedAt: input.now,
        releasedAt: input.state === "released" ? input.now : state.current.releasedAt,
        abortedAt: input.state === "aborted" ? input.now : state.current.abortedAt,
        terminalCommandId: input.commandId,
        terminalCommandHash: input.commandHash,
      });
      state.current = next;
      state.transitioned = next;
      return next;
    }),
    writeAudit: vi.fn(async (input) => {
      state.auditInputs.push(input as Record<string, unknown>);
    }),
  };
  const dependencies: PowerRehearsalAdminDependencies = {
    transaction: vi.fn(async (callback) => {
      try {
        const result = await callback(tx);
        state.commit = true;
        return result;
      } catch (error) {
        state.rollback = true;
        throw error;
      }
    }),
  };
  return { admin: createRunnerPowerRehearsalAdmin(dependencies), dependencies, state, tx };
}

async function expectCode(promise: Promise<unknown>, code: string) {
  await expect(promise).rejects.toMatchObject({
    name: "RunnerPowerRehearsalAdminError",
    code,
  });
}

describe("runner power-rehearsal administrator controller", () => {
  let harness: ReturnType<typeof createHarness>;

  beforeEach(() => {
    harness = createHarness();
  });

  it.each([
    ["malformed event", { eventId: "not-a-uuid" }],
    ["duplicate learners", { learnerTwoId: LEARNER_ONE }],
    ["short reason", { reason: "too short" }],
    ["long reason", { reason: "x".repeat(501) }],
    ["too-short expiry", { expiresInMinutes: 4 }],
    ["too-long expiry", { expiresInMinutes: 121 }],
    ["fractional expiry", { expiresInMinutes: 5.5 }],
    ["invalid clock", { now: new Date(Number.NaN) }],
  ])("rejects invalid arm input: %s", async (_label, override) => {
    await expectCode(harness.admin.arm({
      actorUserId: ACTOR_ID,
      eventId: EVENT_ID,
      learnerOneId: LEARNER_ONE,
      learnerTwoId: LEARNER_TWO,
      reason: REASON,
      expiresInMinutes: 30,
      now: NOW,
      ...override,
    }), "INVALID_INPUT");
    expect(harness.dependencies.transaction).not.toHaveBeenCalled();
  });

  it.each([5, 120])("accepts the bounded expiry endpoint %i minutes", async (expiresInMinutes) => {
    const result = await harness.admin.arm({
      actorUserId: ACTOR_ID,
      eventId: EVENT_ID,
      learnerOneId: LEARNER_ONE,
      learnerTwoId: LEARNER_TWO,
      reason: REASON,
      expiresInMinutes,
      now: NOW,
    });
    expect(result.expiresAt).toBe(new Date(NOW.getTime() + expiresInMinutes * 60_000).toISOString());
  });

  it.each([
    ["missing actor", [user(LEARNER_ONE, "learner"), user(LEARNER_TWO, "learner")]],
    ["learner actor", [user(ACTOR_ID, "learner"), user(LEARNER_ONE, "learner"), user(LEARNER_TWO, "learner")]],
    ["suspended admin", [user(ACTOR_ID, "admin", "suspended"), user(LEARNER_ONE, "learner"), user(LEARNER_TWO, "learner")]],
  ])("blocks vertical privilege escalation: %s", async (_label, users) => {
    harness.state.users = users;
    await expectCode(harness.admin.arm({
      actorUserId: ACTOR_ID,
      eventId: EVENT_ID,
      learnerOneId: LEARNER_ONE,
      learnerTwoId: LEARNER_TWO,
      reason: REASON,
      expiresInMinutes: 30,
      now: NOW,
    }), "ADMIN_REQUIRED");
    expect(harness.tx.insertEvent).not.toHaveBeenCalled();
  });

  it.each([
    ["missing learner", [user(ACTOR_ID, "admin"), user(LEARNER_ONE, "learner")]],
    ["admin target", [user(ACTOR_ID, "admin"), user(LEARNER_ONE, "learner"), user(LEARNER_TWO, "admin")]],
    ["pending learner", [user(ACTOR_ID, "admin"), user(LEARNER_ONE, "learner"), user(LEARNER_TWO, "learner", "pending")]],
  ])("blocks horizontal authority misuse: %s", async (_label, users) => {
    harness.state.users = users;
    await expectCode(harness.admin.arm({
      actorUserId: ACTOR_ID,
      eventId: EVENT_ID,
      learnerOneId: LEARNER_ONE,
      learnerTwoId: LEARNER_TWO,
      reason: REASON,
      expiresInMinutes: 30,
      now: NOW,
    }), "LEARNERS_REQUIRED");
  });

  it("arms exactly two distinct active learners and appends the audit event in the transaction", async () => {
    const result = await harness.admin.arm({
      actorUserId: ACTOR_ID,
      eventId: EVENT_ID,
      learnerOneId: LEARNER_ONE,
      learnerTwoId: LEARNER_TWO,
      reason: REASON,
      expiresInMinutes: 30,
      now: NOW,
    });
    expect(result).toMatchObject({
      eventId: EVENT_ID,
      state: "armed",
      learnerOneId: LEARNER_ONE,
      learnerTwoId: LEARNER_TWO,
      replayed: false,
      expired: false,
    });
    expect(harness.tx.lockControl).toHaveBeenCalledTimes(1);
    expect(harness.tx.lockAuthorities).toHaveBeenCalledWith([ACTOR_ID, LEARNER_ONE, LEARNER_TWO].sort());
    expect(harness.state.auditInputs).toHaveLength(1);
    expect(harness.state.auditInputs[0]).toMatchObject({
      actorUserId: ACTOR_ID,
      action: "runner.power_rehearsal.arm",
      resourceId: EVENT_ID,
      correlationId: EVENT_ID,
      reason: REASON,
    });
    expect(harness.state.commit).toBe(true);
  });

  it("replays the exact arm command but rejects changed semantics and another active event", async () => {
    harness.state.current = event();
    await expect(harness.admin.arm({
      actorUserId: ACTOR_ID,
      eventId: EVENT_ID,
      learnerOneId: LEARNER_ONE,
      learnerTwoId: LEARNER_TWO,
      reason: REASON,
      expiresInMinutes: 30,
      now: NOW,
    })).resolves.toMatchObject({ replayed: true });
    expect(harness.tx.insertEvent).not.toHaveBeenCalled();
    expect(harness.tx.writeAudit).not.toHaveBeenCalled();

    harness = createHarness();
    harness.state.current = event();
    await expectCode(harness.admin.arm({
      actorUserId: ACTOR_ID,
      eventId: EVENT_ID,
      learnerOneId: LEARNER_TWO,
      learnerTwoId: LEARNER_ONE,
      reason: REASON,
      expiresInMinutes: 30,
      now: NOW,
    }), "IDEMPOTENCY_CONFLICT");

    harness = createHarness();
    harness.state.active = event({ id: "90000000-0000-4000-8000-000000000009" });
    await expectCode(harness.admin.arm({
      actorUserId: ACTOR_ID,
      eventId: EVENT_ID,
      learnerOneId: LEARNER_ONE,
      learnerTwoId: LEARNER_TWO,
      reason: REASON,
      expiresInMinutes: 30,
      now: NOW,
    }), "ACTIVE_EVENT_EXISTS");
  });

  it.each(["armed", "released", "aborted"] as const)("rejects release from state %s", async (state) => {
    harness.state.current = state === "armed" ? event() : filledEvent({ state });
    await expectCode(harness.admin.release({
      actorUserId: ACTOR_ID,
      eventId: EVENT_ID,
      commandId: COMMAND_ID,
      reason: REASON,
      now: NOW,
    }), state === "released" ? "IDEMPOTENCY_CONFLICT" : "STATE_CONFLICT");
  });

  it("rejects release after expiry and requires an explicit abort", async () => {
    harness.state.current = filledEvent({ expiresAt: new Date(NOW.getTime() - 1) });
    await expectCode(harness.admin.release({
      actorUserId: ACTOR_ID,
      eventId: EVENT_ID,
      commandId: COMMAND_ID,
      reason: REASON,
      now: NOW,
    }), "EVENT_EXPIRED");
    expect(harness.tx.markRecoveryDue).not.toHaveBeenCalled();
  });

  it.each([
    ["missing binding", [binding(1)]],
    ["wrong learner", [binding(1), binding(2, { learnerUserId: LEARNER_ONE })]],
    ["wrong submission", [binding(1), binding(2, { submissionId: SUBMISSION_ONE })]],
    ["wrong request", [binding(1), binding(2, { requestId: REQUEST_ONE })]],
    ["official submission", [binding(1), binding(2, { submissionType: "exam_final_test" })]],
    ["terminal row", [binding(1), binding(2, { runnerStatus: "completed", submissionStatus: "completed" })]],
    ["status mismatch", [binding(1), binding(2, { runnerStatus: "running" })]],
    ["snapshot missing", [binding(1), binding(2, { dispatchRequestPresent: false })]],
    ["remote dispatch crossed", [binding(1), binding(2, { remoteRunnerJobId: "remote-1" })]],
  ])("fails closed on %s", async (_label, bindings) => {
    harness.state.current = filledEvent();
    harness.state.bindings = bindings;
    await expectCode(harness.admin.release({
      actorUserId: ACTOR_ID,
      eventId: EVENT_ID,
      commandId: COMMAND_ID,
      reason: REASON,
      now: NOW,
    }), "HOLD_BINDING_INVALID");
    expect(harness.tx.markRecoveryDue).not.toHaveBeenCalled();
  });

  it("releases exactly two durable held rows to recovery and audits atomically", async () => {
    harness.state.current = filledEvent();
    const result = await harness.admin.release({
      actorUserId: ACTOR_ID,
      eventId: EVENT_ID,
      commandId: COMMAND_ID,
      reason: REASON,
      now: NOW,
    });
    expect(result).toMatchObject({ state: "released", recoveryJobsMadeDue: 2, replayed: false });
    expect(harness.tx.markRecoveryDue).toHaveBeenCalledWith([JOB_ONE, JOB_TWO], NOW, "POWER_REHEARSAL_RELEASED");
    expect(harness.state.auditInputs[0]).toMatchObject({
      action: "runner.power_rehearsal.release",
      resourceId: EVENT_ID,
      correlationId: COMMAND_ID,
      outcome: "success",
    });
  });

  it.each([
    ["empty", event(), []],
    ["partial", event({ slotOneRequestId: REQUEST_ONE, slotOneSubmissionId: SUBMISSION_ONE, slotOneRunnerJobId: JOB_ONE }), [binding(1)]],
    ["full", filledEvent(), [binding(1), binding(2)]],
  ])("aborts an %s hold without counting it as a successful rehearsal", async (_label, current, bindings) => {
    harness.state.current = current;
    harness.state.bindings = bindings;
    const result = await harness.admin.abort({
      actorUserId: ACTOR_ID,
      eventId: EVENT_ID,
      commandId: COMMAND_ID,
      reason: REASON,
      now: NOW,
    });
    expect(result).toMatchObject({
      state: "aborted",
      recoveryJobsMadeDue: bindings.length,
      successfulRehearsal: false,
      replayed: false,
    });
    expect(harness.state.auditInputs[0]).toMatchObject({
      action: "runner.power_rehearsal.abort",
      correlationId: COMMAND_ID,
      outcome: "failure",
    });
  });

  it("rolls back the state transition and due writes when immutable audit append fails", async () => {
    harness.state.current = filledEvent();
    vi.mocked(harness.tx.writeAudit).mockRejectedValueOnce(new Error("audit chain unavailable"));
    await expect(harness.admin.release({
      actorUserId: ACTOR_ID,
      eventId: EVENT_ID,
      commandId: COMMAND_ID,
      reason: REASON,
      now: NOW,
    })).rejects.toThrow("audit chain unavailable");
    expect(harness.state.rollback).toBe(true);
    expect(harness.state.commit).toBe(false);
  });

  it("fails closed when compare-and-set loses a concurrent transition", async () => {
    harness.state.current = filledEvent();
    vi.mocked(harness.tx.transitionEvent).mockResolvedValueOnce(null);
    await expectCode(harness.admin.release({
      actorUserId: ACTOR_ID,
      eventId: EVENT_ID,
      commandId: COMMAND_ID,
      reason: REASON,
      now: NOW,
    }), "CONCURRENT_MODIFICATION");
  });

  it("returns safe status identifiers and never exposes email, reason, source, or credentials", async () => {
    harness.state.current = filledEvent();
    const result = await harness.admin.status({ actorUserId: ACTOR_ID, eventId: EVENT_ID, now: NOW });
    const serialized = JSON.stringify(result);
    expect(result).toMatchObject({ eventId: EVENT_ID, state: "filled", expired: false });
    expect(serialized).not.toMatch(/email|reason|source|api.?key|secret|token|password|credential/i);
    expect(serialized).not.toContain(REASON);
  });

  it("replays only an exact terminal command and rejects changed semantics", async () => {
    harness.state.current = filledEvent();
    const first = await harness.admin.release({
      actorUserId: ACTOR_ID,
      eventId: EVENT_ID,
      commandId: COMMAND_ID,
      reason: REASON,
      now: NOW,
    });
    harness.state.current = harness.state.transitioned;
    const replay = await harness.admin.release({
      actorUserId: ACTOR_ID,
      eventId: EVENT_ID,
      commandId: COMMAND_ID,
      reason: REASON,
      now: new Date(NOW.getTime() + 1_000),
    });
    expect(first.replayed).toBe(false);
    expect(replay).toMatchObject({ replayed: true, recoveryJobsMadeDue: 2 });
    expect(harness.tx.writeAudit).toHaveBeenCalledTimes(1);

    await expectCode(harness.admin.release({
      actorUserId: ACTOR_ID,
      eventId: EVENT_ID,
      commandId: COMMAND_ID,
      reason: "A different but sufficiently detailed release justification for the same command.",
      now: NOW,
    }), "IDEMPOTENCY_CONFLICT");
  });

  it("exports typed errors without reflecting attacker-controlled input", () => {
    const error = new RunnerPowerRehearsalAdminError("INVALID_INPUT");
    expect(error.message).toBe("INVALID_INPUT");
    expect(error).not.toHaveProperty("input");
  });
});
