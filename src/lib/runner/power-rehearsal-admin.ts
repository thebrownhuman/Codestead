import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import {
  writeAuditEventInTransaction,
  type AuditEventInput,
  type AuditTransaction,
} from "@/lib/security/audit-writer";
import { assertAuditMetadataSafe } from "@/lib/security/audit";
import { lockUserAuthority } from "@/lib/security/user-authority-lock";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const USER_ID_PATTERN = /^[A-Za-z0-9._:-]{1,255}$/;
const PRACTICE_TYPES = new Set(["server_compile", "server_run"]);
const MIN_EXPIRY_MINUTES = 5;
const MAX_EXPIRY_MINUTES = 120;

export type RunnerPowerRehearsalAdminErrorCode =
  | "INVALID_INPUT"
  | "ADMIN_REQUIRED"
  | "LEARNERS_REQUIRED"
  | "EVENT_NOT_FOUND"
  | "ACTIVE_EVENT_EXISTS"
  | "IDEMPOTENCY_CONFLICT"
  | "STATE_CONFLICT"
  | "EVENT_EXPIRED"
  | "HOLD_BINDING_INVALID"
  | "CONCURRENT_MODIFICATION";

export class RunnerPowerRehearsalAdminError extends Error {
  constructor(public readonly code: RunnerPowerRehearsalAdminErrorCode) {
    super(code);
    this.name = "RunnerPowerRehearsalAdminError";
  }
}

export type PowerRehearsalState = "armed" | "filled" | "released" | "aborted";

export type PowerRehearsalEventRecord = Readonly<{
  id: string;
  state: PowerRehearsalState;
  actorUserId: string;
  learnerOneId: string;
  learnerTwoId: string;
  reason: string;
  expiresAt: Date;
  slotOneRequestId: string | null;
  slotOneSubmissionId: string | null;
  slotOneRunnerJobId: string | null;
  slotTwoRequestId: string | null;
  slotTwoSubmissionId: string | null;
  slotTwoRunnerJobId: string | null;
  filledAt: Date | null;
  releasedAt: Date | null;
  abortedAt: Date | null;
  terminalCommandId: string | null;
  terminalCommandHash: string | null;
  createdAt: Date;
  updatedAt: Date;
}>;

export type PowerRehearsalUser = Readonly<{
  id: string;
  role: string | null;
  status: string;
}>;

export type PowerRehearsalBinding = Readonly<{
  runnerJobId: string;
  submissionId: string;
  learnerUserId: string;
  requestId: string;
  submissionType: string;
  runnerStatus: string;
  submissionStatus: string;
  dispatchRequestPresent: boolean;
  recoveryState: string | null;
  remoteRunnerJobId: string | null;
}>;

export type PowerRehearsalAdminTransaction = Readonly<{
  lockControl(): Promise<void>;
  lockAuthorities(userIds: string[]): Promise<void>;
  getUsers(userIds: string[]): Promise<PowerRehearsalUser[]>;
  getEvent(eventId: string): Promise<PowerRehearsalEventRecord | null>;
  getActiveEvent(): Promise<PowerRehearsalEventRecord | null>;
  insertEvent(record: PowerRehearsalEventRecord): Promise<PowerRehearsalEventRecord>;
  getBindings(runnerJobIds: string[]): Promise<PowerRehearsalBinding[]>;
  markRecoveryDue(runnerJobIds: string[], now: Date, code: string): Promise<number>;
  transitionEvent(input: {
    eventId: string;
    expectedStates: PowerRehearsalState[];
    state: "released" | "aborted";
    now: Date;
    commandId: string;
    commandHash: string;
  }): Promise<PowerRehearsalEventRecord | null>;
  writeAudit(input: AuditEventInput): Promise<unknown>;
}>;

export type PowerRehearsalAdminDependencies = Readonly<{
  transaction<T>(callback: (tx: PowerRehearsalAdminTransaction) => Promise<T>): Promise<T>;
}>;

type SafeSlot = Readonly<{
  bound: boolean;
  requestId?: string;
  submissionId?: string;
  runnerJobId?: string;
}>;

export type PowerRehearsalStatus = Readonly<{
  eventId: string;
  state: PowerRehearsalState;
  learnerOneId: string;
  learnerTwoId: string;
  expiresAt: string;
  filledAt: string | null;
  releasedAt: string | null;
  abortedAt: string | null;
  expired: boolean;
  slotOne: SafeSlot;
  slotTwo: SafeSlot;
  replayed: boolean;
  successfulRehearsal: false;
  recoveryJobsMadeDue?: number;
}>;

type DbEventRow = {
  id: string;
  state: PowerRehearsalState;
  actor_user_id: string;
  learner_one_id: string;
  learner_two_id: string;
  reason: string;
  expires_at: Date | string;
  slot_one_request_id: string | null;
  slot_one_submission_id: string | null;
  slot_one_runner_job_id: string | null;
  slot_two_request_id: string | null;
  slot_two_submission_id: string | null;
  slot_two_runner_job_id: string | null;
  filled_at: Date | string | null;
  released_at: Date | string | null;
  aborted_at: Date | string | null;
  terminal_command_id: string | null;
  terminal_command_hash: string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

type DbBindingRow = {
  runner_job_id: string;
  submission_id: string;
  learner_user_id: string;
  request_id: string;
  submission_type: string;
  runner_status: string;
  submission_status: string;
  dispatch_request_present: boolean;
  recovery_state: string | null;
  remote_runner_job_id: string | null;
};

function rows<T>(result: unknown): T[] {
  const candidate = result as { rows?: T[] };
  return Array.isArray(candidate?.rows) ? candidate.rows : [];
}

function asDate(value: Date | string) {
  return value instanceof Date ? value : new Date(value);
}

function asNullableDate(value: Date | string | null) {
  return value === null ? null : asDate(value);
}

function fromDbEvent(row: DbEventRow): PowerRehearsalEventRecord {
  return {
    id: row.id,
    state: row.state,
    actorUserId: row.actor_user_id,
    learnerOneId: row.learner_one_id,
    learnerTwoId: row.learner_two_id,
    reason: row.reason,
    expiresAt: asDate(row.expires_at),
    slotOneRequestId: row.slot_one_request_id,
    slotOneSubmissionId: row.slot_one_submission_id,
    slotOneRunnerJobId: row.slot_one_runner_job_id,
    slotTwoRequestId: row.slot_two_request_id,
    slotTwoSubmissionId: row.slot_two_submission_id,
    slotTwoRunnerJobId: row.slot_two_runner_job_id,
    filledAt: asNullableDate(row.filled_at),
    releasedAt: asNullableDate(row.released_at),
    abortedAt: asNullableDate(row.aborted_at),
    terminalCommandId: row.terminal_command_id,
    terminalCommandHash: row.terminal_command_hash,
    createdAt: asDate(row.created_at),
    updatedAt: asDate(row.updated_at),
  };
}

const EVENT_COLUMNS = sql.raw(`id,state,actor_user_id,learner_one_id,learner_two_id,reason,expires_at,
  slot_one_request_id,slot_one_submission_id,slot_one_runner_job_id,
  slot_two_request_id,slot_two_submission_id,slot_two_runner_job_id,
  filled_at,released_at,aborted_at,terminal_command_id,terminal_command_hash,created_at,updated_at`);

function postgresTransactionAdapter(tx: AuditTransaction): PowerRehearsalAdminTransaction {
  const eventFromResult = (result: unknown) => {
    const row = rows<DbEventRow>(result)[0];
    return row ? fromDbEvent(row) : null;
  };
  return {
    async lockControl() {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('runner-power-rehearsal:control'))`);
    },
    async lockAuthorities(userIds) {
      for (const userId of [...new Set(userIds)].sort()) {
        await lockUserAuthority(tx, userId);
      }
    },
    async getUsers(userIds) {
      const unique = [...new Set(userIds)].sort();
      let result: unknown;
      if (unique.length === 1) {
        result = await tx.execute(sql`select id,role,status from "user" where id = ${unique[0]} for update`);
      } else if (unique.length === 3) {
        result = await tx.execute(sql`select id,role,status from "user"
          where id in (${unique[0]},${unique[1]},${unique[2]}) order by id for update`);
      } else {
        throw new RunnerPowerRehearsalAdminError("INVALID_INPUT");
      }
      return rows<PowerRehearsalUser>(result);
    },
    async getEvent(eventId) {
      return eventFromResult(await tx.execute(sql`select ${EVENT_COLUMNS}
        from runner_power_rehearsal_event where id = ${eventId}::uuid for update`));
    },
    async getActiveEvent() {
      return eventFromResult(await tx.execute(sql`select ${EVENT_COLUMNS}
        from runner_power_rehearsal_event where state in ('armed','filled')
        order by created_at,id limit 1 for update`));
    },
    async insertEvent(record) {
      const result = await tx.execute(sql`insert into runner_power_rehearsal_event (
          id,state,actor_user_id,learner_one_id,learner_two_id,reason,expires_at,
          created_at,updated_at
        ) values (
          ${record.id}::uuid,'armed',${record.actorUserId},${record.learnerOneId},${record.learnerTwoId},
          ${record.reason},${record.expiresAt},${record.createdAt},${record.updatedAt}
        ) returning ${EVENT_COLUMNS}`);
      const inserted = eventFromResult(result);
      if (!inserted) throw new RunnerPowerRehearsalAdminError("CONCURRENT_MODIFICATION");
      return inserted;
    },
    async getBindings(runnerJobIds) {
      let result: unknown;
      if (runnerJobIds.length === 1) {
        result = await tx.execute(sql`select j.id runner_job_id,s.id submission_id,s.user_id learner_user_id,
            s.request_id,s.submission_type,j.status runner_status,s.status submission_status,
            (j.dispatch_request is not null) dispatch_request_present,j.recovery_state,
            j.lease_owner remote_runner_job_id
          from runner_job j join code_submission s on s.id = j.submission_id
          where j.id = ${runnerJobIds[0]}::uuid for update of j,s`);
      } else if (runnerJobIds.length === 2) {
        result = await tx.execute(sql`select j.id runner_job_id,s.id submission_id,s.user_id learner_user_id,
            s.request_id,s.submission_type,j.status runner_status,s.status submission_status,
            (j.dispatch_request is not null) dispatch_request_present,j.recovery_state,
            j.lease_owner remote_runner_job_id
          from runner_job j join code_submission s on s.id = j.submission_id
          where j.id in (${runnerJobIds[0]}::uuid,${runnerJobIds[1]}::uuid)
          order by j.id for update of j,s`);
      } else if (runnerJobIds.length === 0) {
        return [];
      } else {
        throw new RunnerPowerRehearsalAdminError("INVALID_INPUT");
      }
      return rows<DbBindingRow>(result).map((row) => ({
        runnerJobId: row.runner_job_id,
        submissionId: row.submission_id,
        learnerUserId: row.learner_user_id,
        requestId: row.request_id,
        submissionType: row.submission_type,
        runnerStatus: row.runner_status,
        submissionStatus: row.submission_status,
        dispatchRequestPresent: row.dispatch_request_present,
        recoveryState: row.recovery_state,
        remoteRunnerJobId: row.remote_runner_job_id,
      }));
    },
    async markRecoveryDue(runnerJobIds, now, code) {
      if (runnerJobIds.length === 0) return 0;
      let result: unknown;
      if (runnerJobIds.length === 1) {
        result = await tx.execute(sql`update runner_job
          set recovery_state = 'retry_wait',recovery_next_attempt_at = ${now},recovery_last_error_code = ${code}
          where id = ${runnerJobIds[0]}::uuid and status = 'leased'
            and dispatch_request is not null and recovery_state = 'ready' and lease_owner is null
          returning id`);
      } else if (runnerJobIds.length === 2) {
        result = await tx.execute(sql`update runner_job
          set recovery_state = 'retry_wait',recovery_next_attempt_at = ${now},recovery_last_error_code = ${code}
          where id in (${runnerJobIds[0]}::uuid,${runnerJobIds[1]}::uuid) and status = 'leased'
            and dispatch_request is not null and recovery_state = 'ready' and lease_owner is null
          returning id`);
      } else {
        throw new RunnerPowerRehearsalAdminError("INVALID_INPUT");
      }
      return rows<{ id: string }>(result).length;
    },
    async transitionEvent(input) {
      let result: unknown;
      if (input.state === "released" && input.expectedStates.length === 1 && input.expectedStates[0] === "filled") {
        result = await tx.execute(sql`update runner_power_rehearsal_event
          set state = 'released',released_at = ${input.now},terminal_command_id = ${input.commandId}::uuid,
              terminal_command_hash = ${input.commandHash},updated_at = ${input.now}
          where id = ${input.eventId}::uuid and state = 'filled' returning ${EVENT_COLUMNS}`);
      } else if (input.state === "aborted" && input.expectedStates.length === 2) {
        result = await tx.execute(sql`update runner_power_rehearsal_event
          set state = 'aborted',aborted_at = ${input.now},terminal_command_id = ${input.commandId}::uuid,
              terminal_command_hash = ${input.commandHash},updated_at = ${input.now}
          where id = ${input.eventId}::uuid and state in ('armed','filled') returning ${EVENT_COLUMNS}`);
      } else {
        throw new RunnerPowerRehearsalAdminError("INVALID_INPUT");
      }
      return eventFromResult(result);
    },
    writeAudit(input) {
      return writeAuditEventInTransaction(tx, input);
    },
  };
}

function productionDependencies(): PowerRehearsalAdminDependencies {
  return {
    transaction: (callback) => db.transaction((tx) => callback(postgresTransactionAdapter(tx))),
  };
}

function validateUserId(value: string) {
  return USER_ID_PATTERN.test(value);
}

function validateReason(value: string) {
  const trimmed = value.trim();
  if (trimmed.length < 20 || trimmed.length > 500 || /[\u0000-\u001f\u007f]/.test(trimmed)) {
    throw new RunnerPowerRehearsalAdminError("INVALID_INPUT");
  }
  try {
    assertAuditMetadataSafe({ justification: trimmed });
  } catch {
    throw new RunnerPowerRehearsalAdminError("INVALID_INPUT");
  }
  return trimmed;
}

function validateCommon(input: { actorUserId: string; eventId: string; now: Date }) {
  if (!validateUserId(input.actorUserId) || !UUID_PATTERN.test(input.eventId) || !Number.isFinite(input.now.getTime())) {
    throw new RunnerPowerRehearsalAdminError("INVALID_INPUT");
  }
}

function commandHash(action: "release" | "abort", input: {
  eventId: string;
  commandId: string;
  actorUserId: string;
  reason: string;
}) {
  return createHash("sha256").update(JSON.stringify({
    schemaVersion: 1,
    action,
    eventId: input.eventId,
    commandId: input.commandId,
    actorUserId: input.actorUserId,
    reason: input.reason,
  })).digest("hex");
}

function safeSlot(requestId: string | null, submissionId: string | null, runnerJobId: string | null): SafeSlot {
  if (requestId === null || submissionId === null || runnerJobId === null) return { bound: false };
  return { bound: true, requestId, submissionId, runnerJobId };
}

function safeStatus(
  event: PowerRehearsalEventRecord,
  now: Date,
  replayed: boolean,
  recoveryJobsMadeDue?: number,
): PowerRehearsalStatus {
  return {
    eventId: event.id,
    state: event.state,
    learnerOneId: event.learnerOneId,
    learnerTwoId: event.learnerTwoId,
    expiresAt: event.expiresAt.toISOString(),
    filledAt: event.filledAt?.toISOString() ?? null,
    releasedAt: event.releasedAt?.toISOString() ?? null,
    abortedAt: event.abortedAt?.toISOString() ?? null,
    expired: event.expiresAt.getTime() <= now.getTime(),
    slotOne: safeSlot(event.slotOneRequestId, event.slotOneSubmissionId, event.slotOneRunnerJobId),
    slotTwo: safeSlot(event.slotTwoRequestId, event.slotTwoSubmissionId, event.slotTwoRunnerJobId),
    replayed,
    successfulRehearsal: false,
    ...(recoveryJobsMadeDue === undefined ? {} : { recoveryJobsMadeDue }),
  };
}

function authorize(users: PowerRehearsalUser[], actorUserId: string, learnerIds: string[] = []) {
  const byId = new Map(users.map((entry) => [entry.id, entry]));
  const actor = byId.get(actorUserId);
  if (actor?.role !== "admin" || actor.status !== "active") {
    throw new RunnerPowerRehearsalAdminError("ADMIN_REQUIRED");
  }
  for (const learnerId of learnerIds) {
    const learner = byId.get(learnerId);
    if (learner?.role !== "learner" || learner.status !== "active") {
      throw new RunnerPowerRehearsalAdminError("LEARNERS_REQUIRED");
    }
  }
}

function boundSlots(event: PowerRehearsalEventRecord) {
  const candidates = [
    { slot: 1 as const, requestId: event.slotOneRequestId, submissionId: event.slotOneSubmissionId, runnerJobId: event.slotOneRunnerJobId, learnerUserId: event.learnerOneId },
    { slot: 2 as const, requestId: event.slotTwoRequestId, submissionId: event.slotTwoSubmissionId, runnerJobId: event.slotTwoRunnerJobId, learnerUserId: event.learnerTwoId },
  ];
  for (const candidate of candidates) {
    const count = [candidate.requestId, candidate.submissionId, candidate.runnerJobId].filter((value) => value !== null).length;
    if (count !== 0 && count !== 3) throw new RunnerPowerRehearsalAdminError("HOLD_BINDING_INVALID");
  }
  return candidates.filter((candidate) => candidate.runnerJobId !== null) as Array<{
    slot: 1 | 2;
    requestId: string;
    submissionId: string;
    runnerJobId: string;
    learnerUserId: string;
  }>;
}

function validateBindings(event: PowerRehearsalEventRecord, bindings: PowerRehearsalBinding[], requireTwo: boolean) {
  const expected = boundSlots(event);
  if ((requireTwo && expected.length !== 2) || bindings.length !== expected.length) {
    throw new RunnerPowerRehearsalAdminError("HOLD_BINDING_INVALID");
  }
  const byJob = new Map(bindings.map((binding) => [binding.runnerJobId, binding]));
  for (const slot of expected) {
    const binding = byJob.get(slot.runnerJobId);
    if (
      !binding
      || binding.submissionId !== slot.submissionId
      || binding.learnerUserId !== slot.learnerUserId
      || binding.requestId !== slot.requestId
      || !PRACTICE_TYPES.has(binding.submissionType)
      || binding.runnerStatus !== "leased"
      || binding.submissionStatus !== "leased"
      || !binding.dispatchRequestPresent
      || binding.recoveryState !== "ready"
      || binding.remoteRunnerJobId !== null
    ) throw new RunnerPowerRehearsalAdminError("HOLD_BINDING_INVALID");
  }
  return expected;
}

function exactArmReplay(event: PowerRehearsalEventRecord, input: {
  actorUserId: string;
  learnerOneId: string;
  learnerTwoId: string;
  reason: string;
  expiresInMinutes: number;
}) {
  return event.actorUserId === input.actorUserId
    && event.learnerOneId === input.learnerOneId
    && event.learnerTwoId === input.learnerTwoId
    && event.reason === input.reason
    && event.expiresAt.getTime() - event.createdAt.getTime() === input.expiresInMinutes * 60_000;
}

export function createRunnerPowerRehearsalAdmin(dependencies: PowerRehearsalAdminDependencies) {
  return {
    async arm(input: {
      actorUserId: string;
      eventId: string;
      learnerOneId: string;
      learnerTwoId: string;
      reason: string;
      expiresInMinutes: number;
      now?: Date;
    }) {
      const now = input.now ?? new Date();
      const reason = validateReason(input.reason);
      validateCommon({ ...input, now });
      if (
        !validateUserId(input.learnerOneId)
        || !validateUserId(input.learnerTwoId)
        || input.learnerOneId === input.learnerTwoId
        || input.actorUserId === input.learnerOneId
        || input.actorUserId === input.learnerTwoId
        || !Number.isSafeInteger(input.expiresInMinutes)
        || input.expiresInMinutes < MIN_EXPIRY_MINUTES
        || input.expiresInMinutes > MAX_EXPIRY_MINUTES
      ) throw new RunnerPowerRehearsalAdminError("INVALID_INPUT");
      const normalized = { ...input, reason, now };
      return dependencies.transaction(async (tx) => {
        await tx.lockControl();
        const authorityIds = [normalized.actorUserId, normalized.learnerOneId, normalized.learnerTwoId].sort();
        await tx.lockAuthorities(authorityIds);
        authorize(await tx.getUsers(authorityIds), normalized.actorUserId, [normalized.learnerOneId, normalized.learnerTwoId]);
        const existing = await tx.getEvent(normalized.eventId);
        if (existing) {
          if (!exactArmReplay(existing, normalized)) throw new RunnerPowerRehearsalAdminError("IDEMPOTENCY_CONFLICT");
          return safeStatus(existing, now, true);
        }
        if (await tx.getActiveEvent()) throw new RunnerPowerRehearsalAdminError("ACTIVE_EVENT_EXISTS");
        const record = await tx.insertEvent({
          id: normalized.eventId,
          state: "armed",
          actorUserId: normalized.actorUserId,
          learnerOneId: normalized.learnerOneId,
          learnerTwoId: normalized.learnerTwoId,
          reason: normalized.reason,
          expiresAt: new Date(now.getTime() + normalized.expiresInMinutes * 60_000),
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
          createdAt: now,
          updatedAt: now,
        });
        await tx.writeAudit({
          actorUserId: normalized.actorUserId,
          action: "runner.power_rehearsal.arm",
          resourceType: "runner_power_rehearsal_event",
          resourceId: normalized.eventId,
          reason: normalized.reason,
          outcome: "success",
          correlationId: normalized.eventId,
          metadata: {
            learnerOneId: normalized.learnerOneId,
            learnerTwoId: normalized.learnerTwoId,
            expiresAt: record.expiresAt.toISOString(),
            expiresInMinutes: normalized.expiresInMinutes,
            requiredSlots: 2,
          },
        });
        return safeStatus(record, now, false);
      });
    },

    async status(input: { actorUserId: string; eventId: string; now?: Date }) {
      const now = input.now ?? new Date();
      validateCommon({ ...input, now });
      return dependencies.transaction(async (tx) => {
        await tx.lockControl();
        await tx.lockAuthorities([input.actorUserId]);
        authorize(await tx.getUsers([input.actorUserId]), input.actorUserId);
        const event = await tx.getEvent(input.eventId);
        if (!event) throw new RunnerPowerRehearsalAdminError("EVENT_NOT_FOUND");
        return safeStatus(event, now, false);
      });
    },

    async release(input: {
      actorUserId: string;
      eventId: string;
      commandId: string;
      reason: string;
      now?: Date;
    }) {
      return terminalize("release", input);
    },

    async abort(input: {
      actorUserId: string;
      eventId: string;
      commandId: string;
      reason: string;
      now?: Date;
    }) {
      return terminalize("abort", input);
    },
  };

  async function terminalize(action: "release" | "abort", input: {
    actorUserId: string;
    eventId: string;
    commandId: string;
    reason: string;
    now?: Date;
  }) {
    const now = input.now ?? new Date();
    const reason = validateReason(input.reason);
    validateCommon({ ...input, now });
    if (!UUID_PATTERN.test(input.commandId)) throw new RunnerPowerRehearsalAdminError("INVALID_INPUT");
    const normalized = { ...input, reason, now };
    const hash = commandHash(action, normalized);
    return dependencies.transaction(async (tx) => {
      await tx.lockControl();
      await tx.lockAuthorities([normalized.actorUserId]);
      authorize(await tx.getUsers([normalized.actorUserId]), normalized.actorUserId);
      const event = await tx.getEvent(normalized.eventId);
      if (!event) throw new RunnerPowerRehearsalAdminError("EVENT_NOT_FOUND");
      const targetState = action === "release" ? "released" : "aborted";
      if (event.state === targetState) {
        if (event.terminalCommandId !== normalized.commandId || event.terminalCommandHash !== hash) {
          throw new RunnerPowerRehearsalAdminError("IDEMPOTENCY_CONFLICT");
        }
        return safeStatus(event, now, true, boundSlots(event).length);
      }
      if (event.state === "released" || event.state === "aborted") {
        throw new RunnerPowerRehearsalAdminError("STATE_CONFLICT");
      }
      if (action === "release" && event.state !== "filled") {
        throw new RunnerPowerRehearsalAdminError("STATE_CONFLICT");
      }
      if (action === "release" && event.expiresAt.getTime() <= now.getTime()) {
        throw new RunnerPowerRehearsalAdminError("EVENT_EXPIRED");
      }
      const expected = boundSlots(event);
      const bindings = await tx.getBindings(expected.map((slot) => slot.runnerJobId));
      validateBindings(event, bindings, action === "release");
      const code = action === "release" ? "POWER_REHEARSAL_RELEASED" : "POWER_REHEARSAL_ABORTED";
      const due = await tx.markRecoveryDue(expected.map((slot) => slot.runnerJobId), now, code);
      if (due !== expected.length) throw new RunnerPowerRehearsalAdminError("CONCURRENT_MODIFICATION");
      const transitioned = await tx.transitionEvent({
        eventId: normalized.eventId,
        expectedStates: action === "release" ? ["filled"] : ["armed", "filled"],
        state: targetState,
        now,
        commandId: normalized.commandId,
        commandHash: hash,
      });
      if (!transitioned) throw new RunnerPowerRehearsalAdminError("CONCURRENT_MODIFICATION");
      await tx.writeAudit({
        actorUserId: normalized.actorUserId,
        action: `runner.power_rehearsal.${action}`,
        resourceType: "runner_power_rehearsal_event",
        resourceId: normalized.eventId,
        reason: normalized.reason,
        outcome: action === "release" ? "success" : "failure",
        correlationId: normalized.commandId,
        metadata: {
          eventId: normalized.eventId,
          terminalCommandHash: hash,
          heldSlotCount: expected.length,
          runnerJobIds: expected.map((slot) => slot.runnerJobId),
          recoveryJobsMadeDue: due,
          successfulRehearsal: false,
        },
      });
      return safeStatus(transitioned, now, false, due);
    });
  }
}

const productionAdmin = createRunnerPowerRehearsalAdmin(productionDependencies());

export const armRunnerPowerRehearsal = productionAdmin.arm;
export const getRunnerPowerRehearsalStatus = productionAdmin.status;
export const releaseRunnerPowerRehearsal = productionAdmin.release;
export const abortRunnerPowerRehearsal = productionAdmin.abort;
