import type { PoolClient } from "pg";

import { pool } from "@/lib/db/client";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type RehearsalRow = Readonly<{
  id: string;
  state: "armed" | "filled";
  learner_one_id: string;
  learner_two_id: string;
  slot_one_request_id: string | null;
  slot_one_submission_id: string | null;
  slot_one_runner_job_id: string | null;
  slot_two_request_id: string | null;
  slot_two_submission_id: string | null;
  slot_two_runner_job_id: string | null;
  expires_at: Date;
}>;

type DispatchBindingRow = Readonly<{
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
}>;

export type RunnerPowerRehearsalErrorCode =
  | "INVALID_INPUT"
  | "SLOT_ALREADY_CLAIMED"
  | "HOLD_BINDING_INDETERMINATE"
  | "HOLD_PERSISTENCE_INDETERMINATE";

export class RunnerPowerRehearsalError extends Error {
  constructor(
    public readonly code: RunnerPowerRehearsalErrorCode,
    public readonly indeterminate: boolean,
  ) {
    super(code);
    this.name = "RunnerPowerRehearsalError";
  }
}

export type RunnerPowerRehearsalHold =
  | Readonly<{ held: false }>
  | Readonly<{
      held: true;
      eventId: string;
      slot: 1 | 2;
      filled: boolean;
      replayed: boolean;
      expired: boolean;
    }>;

function validate(input: {
  userId: string;
  requestId: string;
  submissionId: string;
  runnerJobId: string;
  now: Date;
}) {
  if (
    input.userId.length < 1
    || input.userId.length > 255
    || !UUID_PATTERN.test(input.requestId)
    || !UUID_PATTERN.test(input.submissionId)
    || !UUID_PATTERN.test(input.runnerJobId)
    || !Number.isFinite(input.now.getTime())
  ) throw new RunnerPowerRehearsalError("INVALID_INPUT", false);
}

function exactSlotMatch(
  row: RehearsalRow,
  slot: 1 | 2,
  input: { requestId: string; submissionId: string; runnerJobId: string },
) {
  const prefix = slot === 1 ? "slot_one" : "slot_two";
  return row[`${prefix}_request_id`] === input.requestId
    && row[`${prefix}_submission_id`] === input.submissionId
    && row[`${prefix}_runner_job_id`] === input.runnerJobId;
}

async function findEvent(client: PoolClient, userId: string) {
  const result = await client.query<RehearsalRow>(
    `select id,state,learner_one_id,learner_two_id,
            slot_one_request_id,slot_one_submission_id,slot_one_runner_job_id,
            slot_two_request_id,slot_two_submission_id,slot_two_runner_job_id,
            expires_at
       from runner_power_rehearsal_event
      where state in ('armed','filled')
        and ($1 = learner_one_id or $1 = learner_two_id)
      order by created_at desc,id
      limit 1
      for update`,
    [userId],
  );
  return result.rows[0] ?? null;
}

async function lockAndValidateDispatch(
  client: PoolClient,
  input: { userId: string; requestId: string; submissionId: string; runnerJobId: string },
) {
  const lockName = `practice-runner-recovery:${input.runnerJobId}`;
  await client.query("select pg_advisory_xact_lock(hashtext($1))", [lockName]);
  const result = await client.query<DispatchBindingRow>(
    `select j.id runner_job_id,s.id submission_id,s.user_id learner_user_id,
            s.request_id,s.submission_type,j.status runner_status,s.status submission_status,
            (j.dispatch_request is not null) dispatch_request_present,j.recovery_state,
            j.lease_owner remote_runner_job_id
       from runner_job j join code_submission s on s.id = j.submission_id
      where j.id = $1::uuid
      for update of j,s`,
    [input.runnerJobId],
  );
  const binding = result.rows[0];
  if (
    !binding
    || binding.runner_job_id !== input.runnerJobId
    || binding.submission_id !== input.submissionId
    || binding.learner_user_id !== input.userId
    || binding.request_id !== input.requestId
    || !["server_compile", "server_run"].includes(binding.submission_type)
    || binding.runner_status !== "leased"
    || binding.submission_status !== "leased"
    || !binding.dispatch_request_present
    || binding.recovery_state !== "ready"
    || binding.remote_runner_job_id !== null
  ) {
    throw new RunnerPowerRehearsalError("HOLD_BINDING_INDETERMINATE", true);
  }
}

/**
 * Claims the pre-authorized learner's single power-rehearsal slot after the
 * exact immutable dispatch snapshot is durable, but before any remote runner
 * request is attempted. An overdue event remains a hold instead of silently
 * dispatching; the operator must explicitly release or abort it.
 */
export async function holdRunnerDispatchForPowerRehearsal(input: {
  readonly userId: string;
  readonly requestId: string;
  readonly submissionId: string;
  readonly runnerJobId: string;
  readonly now?: Date;
}): Promise<RunnerPowerRehearsalHold> {
  const normalized = { ...input, now: input.now ?? new Date() };
  validate(normalized);
  const client = await pool.connect();
  let began = false;
  try {
    await client.query("begin");
    began = true;
    const event = await findEvent(client, normalized.userId);
    if (!event) {
      await client.query("commit");
      return { held: false };
    }
    const slot: 1 | 2 = event.learner_one_id === normalized.userId ? 1 : 2;
    const requestId = slot === 1 ? event.slot_one_request_id : event.slot_two_request_id;
    const expired = event.expires_at.getTime() <= normalized.now.getTime();
    if (requestId !== null) {
      if (!exactSlotMatch(event, slot, normalized)) {
        throw new RunnerPowerRehearsalError("SLOT_ALREADY_CLAIMED", false);
      }
      await lockAndValidateDispatch(client, normalized);
      await client.query("commit");
      return {
        held: true,
        eventId: event.id,
        slot,
        filled: event.state === "filled",
        replayed: true,
        expired,
      };
    }

    await lockAndValidateDispatch(client, normalized);

    const otherFilled = slot === 1
      ? event.slot_two_request_id !== null
      : event.slot_one_request_id !== null;
    const prefix = slot === 1 ? "one" : "two";
    const updated = await client.query<{ state: "armed" | "filled" }>(
      `update runner_power_rehearsal_event
          set slot_${prefix}_request_id = $2,
              slot_${prefix}_submission_id = $3::uuid,
              slot_${prefix}_runner_job_id = $4::uuid,
              state = case when ${otherFilled ? "true" : "false"} then 'filled' else state end,
              filled_at = case when ${otherFilled ? "true" : "false"} then $5 else filled_at end,
              updated_at = $5
        where id = $1::uuid
          and state in ('armed','filled')
          and slot_${prefix}_request_id is null
          and slot_${prefix}_submission_id is null
          and slot_${prefix}_runner_job_id is null
      returning state`,
      [event.id, normalized.requestId, normalized.submissionId, normalized.runnerJobId, normalized.now],
    );
    if (updated.rowCount !== 1 || !updated.rows[0]) {
      throw new RunnerPowerRehearsalError("HOLD_PERSISTENCE_INDETERMINATE", true);
    }
    await client.query("commit");
    return {
      held: true,
      eventId: event.id,
      slot,
      filled: updated.rows[0].state === "filled",
      replayed: false,
      expired,
    };
  } catch (error) {
    if (began) await client.query("rollback").catch(() => undefined);
    if (error instanceof RunnerPowerRehearsalError) throw error;
    throw new RunnerPowerRehearsalError("HOLD_PERSISTENCE_INDETERMINATE", true);
  } finally {
    client.release();
  }
}
