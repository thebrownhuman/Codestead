import { drizzle } from "drizzle-orm/node-postgres";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { db, pool } from "@/lib/db/client";
import * as schema from "@/lib/db/schema";
import {
  emailOutbox,
  lostDeviceProof,
  session,
  user,
} from "@/lib/db/schema";
import {
  issueLostDeviceProof,
} from "@/lib/security/lost-device-recovery";
import {
  lockUserAuthorityOnPgClient,
} from "@/lib/security/user-authority-lock";

const LEARNER_ID = "lost-device-lock-order-learner";
const SESSION_ID = "lost-device-lock-order-session";
const LEARNER_EMAIL = "lost-device-lock-order@integration.invalid";
const GATE_LOCK_KEY = "integration:lost-device-proof:outbox-gate:v1";
const TRIGGER_NAME = "integration_pause_lost_device_outbox";
const FUNCTION_NAME = "integration_pause_lost_device_outbox";

type PoolClientWithProcessId = PoolClient & {
  readonly processID?: number;
};

type BackendIdentity = Readonly<{
  pid: number;
  databaseName: string;
  sessionUser: string;
  currentUser: string;
  applicationName: string;
}>;

type ExactQueryFragments = readonly [string, string, string];

function assertDisposableDatabase() {
  const connectionString = process.env.DATABASE_URL ?? "";
  const applicationConnectionString = process.env.DATABASE_APP_URL ?? "";
  if (
    process.env.INTEGRATION_TEST !== "1"
    || !/\/learncoding_integration(?:\?|$)/.test(connectionString)
    || !/\/learncoding_integration(?:\?|$)/.test(applicationConnectionString)
  ) {
    throw new Error(
      "Lost-device lock races require disposable owner and application-role databases.",
    );
  }
}

async function truncateApplicationTables() {
  assertDisposableDatabase();
  const tables = await pool.query<{ table_name: string }>(`
    select table_name
      from information_schema.tables
     where table_schema = 'public' and table_type = 'BASE TABLE'
  `);
  const names = tables.rows
    .map(({ table_name }) => `"${table_name.replaceAll('"', '""')}"`)
    .join(",");
  if (names) {
    await pool.query(`truncate table ${names} restart identity cascade`);
  }
}

async function seedActiveLearner(now: Date) {
  await db.insert(user).values({
    id: LEARNER_ID,
    name: "Lost Device Lock Learner",
    email: LEARNER_EMAIL,
    emailVerified: true,
    role: "learner",
    status: "active",
    banned: false,
  });
  await db.insert(session).values({
    id: SESSION_ID,
    userId: LEARNER_ID,
    token: "lost-device-lock-order-session-token",
    expiresAt: new Date(now.getTime() + 60 * 60_000),
  });
}

function createApplicationPool(applicationName: string) {
  return new Pool({
    connectionString: process.env.DATABASE_APP_URL,
    application_name: applicationName,
    max: 1,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
}

async function identifyBackend(
  client: PoolClient,
  applicationName: string,
): Promise<BackendIdentity> {
  const connectionString = process.env.DATABASE_APP_URL;
  if (!connectionString) {
    throw new Error("Lost-device lock races require DATABASE_APP_URL.");
  }
  const processId = (client as PoolClientWithProcessId).processID;
  if (!Number.isSafeInteger(processId)) {
    throw new Error("Lost-device race client has no PostgreSQL processID.");
  }
  await client.query("select set_config('application_name',$1,false)", [
    applicationName,
  ]);
  await client.query("select set_config('lock_timeout','5000',false)");
  await client.query("select set_config('statement_timeout','10000',false)");
  const result = await client.query<BackendIdentity>(`
    select pg_backend_pid()::integer "pid",
           current_database()::text "databaseName",
           session_user::text "sessionUser",
           current_user::text "currentUser",
           current_setting('application_name')::text "applicationName"
  `);
  const identity = result.rows[0];
  const parsed = new URL(connectionString);
  const expectedRole = decodeURIComponent(parsed.username);
  const expectedDatabase = decodeURIComponent(parsed.pathname.slice(1));
  if (
    !identity
    || identity.pid !== processId
    || identity.databaseName !== expectedDatabase
    || identity.sessionUser !== expectedRole
    || identity.currentUser !== expectedRole
    || identity.applicationName !== applicationName
  ) {
    throw new Error("Lost-device race backend identity did not match its restricted pool.");
  }
  return identity;
}

async function identifyPoolBackend(
  databasePool: Pool,
  applicationName: string,
) {
  const client = await databasePool.connect();
  try {
    return await identifyBackend(client, applicationName);
  } finally {
    client.release();
  }
}

async function waitForExactBlockedQuery(
  observer: PoolClient,
  waiting: BackendIdentity,
  blocker: BackendIdentity,
  fragments: ExactQueryFragments,
) {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const blocked = await observer.query<{ pid: number }>(`
      select activity.pid
        from pg_stat_activity activity
       where activity.pid=$1
         and activity.backend_type='client backend'
         and activity.datname=$2
         and activity.usename=$3
         and activity.application_name=$4
         and activity.state='active'
         and activity.wait_event_type='Lock'
         and activity.query ilike $5
         and activity.query ilike $6
         and activity.query ilike $7
         and $8::integer = any(pg_blocking_pids(activity.pid))
    `, [
      waiting.pid,
      waiting.databaseName,
      waiting.sessionUser,
      waiting.applicationName,
      ...fragments,
      blocker.pid,
    ]);
    if (blocked.rows[0]?.pid === waiting.pid) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  const diagnostics = await observer.query<{
    pid: number;
    state: string | null;
    waitEventType: string | null;
    waitEvent: string | null;
    blockers: number[];
    query: string | null;
  }>(`
    select pid,state,wait_event_type "waitEventType",wait_event "waitEvent",
           pg_blocking_pids(pid) blockers,left(query,300) query
      from pg_stat_activity
     where pid=$1
  `, [waiting.pid]);
  throw new Error(
    `Lost-device backend did not reach the expected lock: ${JSON.stringify(diagnostics.rows)}`,
  );
}

async function beginAndLockSourceBoundary(
  client: PoolClient,
  requestId: string,
) {
  await client.query("begin");
  await lockUserAuthorityOnPgClient(client, LEARNER_ID);
  await client.query(`
    select id
      from "user"
     where id=$1
       and lower(email)=lower($2)
       and role='learner'
       and status='active'
       and email_verified=true
       and banned=false
     for share
  `, [LEARNER_ID, LEARNER_EMAIL]);
  await client.query(`
    select id
      from session
     where id=$1
       and user_id=$2
       and revoked_at is null
     for share
  `, [SESSION_ID, LEARNER_ID]);
  await client.query(`
    select id
      from lost_device_proof
     where id=$1
       and user_id=$2
       and session_id=$3
       and consumed_at is null
     for share
  `, [requestId, LEARNER_ID, SESSION_ID]);
  await client.query(`
    select id
      from email_outbox
     where user_id=$1
       and template='lost-device-proof'
       and variables->>'recoveryRequestId'=$2
     for update
  `, [LEARNER_ID, requestId]);
}

async function installOutboxGate() {
  await pool.query(`drop trigger if exists ${TRIGGER_NAME} on email_outbox`);
  await pool.query(`drop function if exists ${FUNCTION_NAME}()`);
  await pool.query(`
    create function ${FUNCTION_NAME}()
    returns trigger
    language plpgsql
    as $function$
    begin
      if new.template = 'lost-device-proof' then
        perform pg_catalog.pg_advisory_xact_lock(
          pg_catalog.hashtext('${GATE_LOCK_KEY}')::pg_catalog.int8
        );
      end if;
      return new;
    end
    $function$
  `);
  await pool.query(`
    create trigger ${TRIGGER_NAME}
    before insert on email_outbox
    for each row execute function ${FUNCTION_NAME}()
  `);
}

async function removeOutboxGate() {
  await pool.query(`drop trigger if exists ${TRIGGER_NAME} on email_outbox`);
  await pool.query(`drop function if exists ${FUNCTION_NAME}()`);
}

async function assertSingleProofAndOutbox(requestId: string) {
  const proofRows = await db.select({ id: lostDeviceProof.id }).from(lostDeviceProof);
  const outboxRows = await db
    .select({
      template: emailOutbox.template,
      variables: emailOutbox.variables,
    })
    .from(emailOutbox);
  expect(proofRows).toEqual([{ id: requestId }]);
  expect(outboxRows).toHaveLength(1);
  expect(outboxRows[0]).toMatchObject({
    template: "lost-device-proof",
    variables: { recoveryRequestId: requestId },
  });
}

beforeEach(async () => {
  await removeOutboxGate();
  await truncateApplicationTables();
});

afterAll(async () => {
  await removeOutboxGate();
  await pool.end();
});

describe("lost-device proof canonical lock order", () => {
  it("survives boundary-first and producer-first same-proof P/O races without duplicates", async () => {
    const now = new Date("2026-07-25T05:00:00.000Z");
    await seedActiveLearner(now);
    const initial = await issueLostDeviceProof(LEARNER_EMAIL, now);
    expect(initial).not.toBeNull();

    const producerPool = createApplicationPool("codestead.lost-device.producer");
    const boundaryPool = createApplicationPool("codestead.lost-device.boundary");
    const observerPool = createApplicationPool("codestead.lost-device.observer");
    const gatePool = createApplicationPool("codestead.lost-device.gate");
    const boundaryClient = await boundaryPool.connect();
    const observerClient = await observerPool.connect();
    const gateClient = await gatePool.connect();
    const producerDatabase = drizzle(producerPool, { schema });
    let gateHeld = false;
    let producerAttempt: ReturnType<typeof issueLostDeviceProof> | null = null;
    let boundaryAttempt: Promise<void> | null = null;
    try {
      const producerIdentity = await identifyPoolBackend(
        producerPool,
        "codestead.lost-device.producer",
      );
      const boundaryIdentity = await identifyBackend(
        boundaryClient,
        "codestead.lost-device.boundary",
      );
      await identifyBackend(observerClient, "codestead.lost-device.observer");
      const gateIdentity = await identifyBackend(
        gateClient,
        "codestead.lost-device.gate",
      );

      // Boundary-first: the producer must stop at A, before it can reach U/P/O.
      await beginAndLockSourceBoundary(boundaryClient, initial!.requestId);
      producerAttempt = issueLostDeviceProof(LEARNER_EMAIL, now, producerDatabase);
      await waitForExactBlockedQuery(
        observerClient,
        producerIdentity,
        boundaryIdentity,
        [
          "%pg_catalog.pg_advisory_xact_lock%",
          "%pg_catalog.hashtext%",
          "%::pg_catalog.int8%",
        ],
      );
      await boundaryClient.query("rollback");
      expect(await producerAttempt).toEqual(initial);
      producerAttempt = null;
      await assertSingleProofAndOutbox(initial!.requestId);

      // Producer-first: pause its O insert after it owns A/U/request/session/P.
      // A canonical boundary can only wait at A, so it cannot invert P/O.
      await installOutboxGate();
      await gateClient.query(
        "select pg_catalog.pg_advisory_lock(pg_catalog.hashtext($1)::pg_catalog.int8)",
        [GATE_LOCK_KEY],
      );
      gateHeld = true;
      producerAttempt = issueLostDeviceProof(LEARNER_EMAIL, now, producerDatabase);
      await waitForExactBlockedQuery(
        observerClient,
        producerIdentity,
        gateIdentity,
        [
          '%insert into "email_outbox"%',
          "%on conflict%",
          "%do nothing%",
        ],
      );

      boundaryAttempt = beginAndLockSourceBoundary(
        boundaryClient,
        initial!.requestId,
      );
      await waitForExactBlockedQuery(
        observerClient,
        boundaryIdentity,
        producerIdentity,
        [
          "%pg_catalog.pg_advisory_xact_lock%",
          "%pg_catalog.hashtext%",
          "%::pg_catalog.int8%",
        ],
      );
      await gateClient.query(
        "select pg_catalog.pg_advisory_unlock(pg_catalog.hashtext($1)::pg_catalog.int8)",
        [GATE_LOCK_KEY],
      );
      gateHeld = false;

      expect(await producerAttempt).toEqual(initial);
      producerAttempt = null;
      await boundaryAttempt;
      boundaryAttempt = null;
      await boundaryClient.query("rollback");
      await assertSingleProofAndOutbox(initial!.requestId);
    } finally {
      if (gateHeld) {
        await gateClient.query(
          "select pg_catalog.pg_advisory_unlock(pg_catalog.hashtext($1)::pg_catalog.int8)",
          [GATE_LOCK_KEY],
        ).catch(() => undefined);
      }
      await boundaryClient.query("rollback").catch(() => undefined);
      if (producerAttempt) await producerAttempt.catch(() => undefined);
      if (boundaryAttempt) await boundaryAttempt.catch(() => undefined);
      await removeOutboxGate().catch(() => undefined);
      boundaryClient.release();
      observerClient.release();
      gateClient.release();
      await Promise.all([
        producerPool.end(),
        boundaryPool.end(),
        observerPool.end(),
        gatePool.end(),
      ]);
    }
  });
});
