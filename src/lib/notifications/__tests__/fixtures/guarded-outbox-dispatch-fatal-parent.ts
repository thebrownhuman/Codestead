import { writeSync } from "node:fs";

import {
  disarmMailDispatchHardWatchdog,
  startMailDispatchHardWatchdog,
} from "../../mail-dispatch-hard-watchdog";
import { captureMailTransportConfiguration } from "../../mailer-transport-internal";
import {
  inspectMailDispatchRuntime,
  type MailDispatchStartupPool,
} from "../../mail-dispatch-runtime-startup";
import {
  createMaterializedDispatch,
  materializedDispatchEnvelope,
} from "../../prepared-dispatch-materialization";
import {
  authorizeCommittedPreparedDispatch,
  captureMailDispatchApplicationOrigin,
  mailDispatchPreparedRuntimePlan,
  PostgresOutboxStore,
  type EmailOutboxPayload,
  type OutboxPgClient,
  type OutboxPgPool,
} from "../../postgres-outbox-store";
import { outboxMessageId } from "../../provider-correlation";
import type { OutboxClaim } from "../../outbox-worker";

type Scenario =
  | "acquire-timeout"
  | "pre-provider-hang"
  | "post-init-arm-failure"
  | "provider-unsettled"
  | "unarmed-watchdog"
  | "already-claimed-watchdog";

const scenario = process.env.MAIL_DISPATCH_TX2_FATAL_SCENARIO as
  | Scenario
  | undefined;
if (
  !scenario
  || !([
    "acquire-timeout",
    "pre-provider-hang",
    "post-init-arm-failure",
    "provider-unsettled",
    "unarmed-watchdog",
    "already-claimed-watchdog",
  ] satisfies Scenario[]).includes(scenario)
) {
  process.exit(64);
}

const ID = "11111111-1111-4111-8111-111111111111";
const OPERATION_ID = "22222222-2222-4222-8222-222222222222";
const CLAIM_TOKEN = "33333333-3333-4333-8333-333333333333";
const USER_ID = "learner-1";
const DELIVERY_SCOPE_KEY = `a:${USER_ID}`;
const APP_URL = "https://codestead.test";
const PROVIDER_STARTED_AT = "2026-07-22 19:00:05.123456+00";
const PROVIDER_LEASE_EXPIRES_AT =
  "2026-07-22 19:05:05.123456+00";
const RELEASE_RECEIPT_SHA256 = "a".repeat(64);

function marker(value: string) {
  writeSync(1, `${value}\n`);
}

function compact(sql: string) {
  return sql.replace(/\s+/gu, " ").trim();
}

function fixtureRows<
  Row extends Record<string, unknown>,
>(...rows: Record<string, unknown>[]): Row[] {
  return rows as Row[];
}

type Authority = Readonly<{
  adapter: string;
  bindingVersion: string;
  bindingSha256: string;
  correlationVersion: string;
  evidenceVersion: string | null;
  evidenceSha256: string | null;
  requestBodySha256: string;
  requestBodyLength: number;
  releaseReceiptSha256: string;
}>;

let authority: Authority | undefined;

const claim: OutboxClaim<EmailOutboxPayload> = Object.freeze({
  phase: "pre-provider",
  id: ID,
  operationId: OPERATION_ID,
  claimToken: CLAIM_TOKEN,
  claimOwner: "mail-worker:fatal-fixture",
  claimVersion: 4,
  userId: USER_ID,
  deliveryScopeKey: DELIVERY_SCOPE_KEY,
  attempt: 2,
  leaseExpiresAt: new Date("2026-07-22T19:01:00.000Z"),
  payload: Object.freeze({
    userId: USER_ID,
    to: "learner@example.test",
    template: "invitation",
    templateVersion: "1",
    variables: Object.freeze({
      name: "Learner",
      url: `${APP_URL}/invitations/2`,
    }),
  }),
});

class FixtureClient implements OutboxPgClient {
  constructor(private readonly phase: "tx1" | "tx2") {}

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values: unknown[] = [],
  ) {
    const sql = compact(text);
    const transactionMarker =
      sql === "begin" || sql.startsWith("begin; set local ")
        ? "begin"
        : sql === "commit" || sql === "rollback"
          ? sql
          : null;
    if (transactionMarker) {
      marker(
        `${this.phase.toUpperCase()}_${transactionMarker.toUpperCase()}`,
      );
    }
    if (
      this.phase === "tx2"
      && scenario === "pre-provider-hang"
      && sql === "begin"
    ) {
      marker("PRE_PROVIDER_QUERY_STARTED");
      return await new Promise<Readonly<{ rows: Row[] }>>(() => {});
    }
    if (
      this.phase === "tx2"
      && scenario === "post-init-arm-failure"
      && sql.includes("set local transaction_timeout = '60000ms'")
    ) {
      marker("POST_INIT_ARM_FAILED");
      throw new Error("Injected post-init timeout-arm failure.");
    }
    if (sql === "begin" || sql === "commit" || sql === "rollback") {
      return { rows: [] as Row[] };
    }
    if (sql.includes("set local ")) return { rows: [] as Row[] };
    if (sql.includes("pg_advisory_xact_lock")) {
      return { rows: [] as Row[] };
    }
    if (
      this.phase === "tx1"
      && sql.includes(
        "select id::text, user_id, operation_id::text, delivery_scope_key",
      )
    ) {
      return {
        rows: fixtureRows<Row>({
          id: claim.id,
          user_id: claim.userId,
          operation_id: claim.operationId,
          delivery_scope_key: claim.deliveryScopeKey,
          claim_version: claim.claimVersion,
        }),
      };
    }
    if (sql.includes("select case")) {
      return { rows: fixtureRows<Row>({ decision: "allowed" }) };
    }
    if (
      this.phase === "tx1"
      && sql.includes("update public.email_outbox as outbox")
    ) {
      const adapter = values[5];
      const requestBodyLength = values[24];
      if (
        typeof adapter !== "string"
        || typeof requestBodyLength !== "number"
      ) {
        throw new Error("Invalid TX1 fixture authority.");
      }
      authority = Object.freeze({
        adapter,
        bindingVersion: String(values[18]),
        bindingSha256: String(values[19]),
        correlationVersion: String(values[20]),
        evidenceVersion:
          values[21] === null ? null : String(values[21]),
        evidenceSha256:
          values[22] === null ? null : String(values[22]),
        requestBodySha256: String(values[23]),
        requestBodyLength,
        releaseReceiptSha256: RELEASE_RECEIPT_SHA256,
      });
      return {
        rows: fixtureRows<Row>({
          provider_call_started: PROVIDER_STARTED_AT,
          lease_expires_at: PROVIDER_LEASE_EXPIRES_AT,
          dispatch_binding_version: authority.bindingVersion,
          dispatch_binding_sha256: authority.bindingSha256,
          provider_correlation_version: authority.correlationVersion,
          provider_evidence_version: authority.evidenceVersion,
          provider_evidence_sha256: authority.evidenceSha256,
          provider_request_body_sha256: authority.requestBodySha256,
          provider_request_body_length: authority.requestBodyLength,
          release_receipt_sha256: authority.releaseReceiptSha256,
        }),
      };
    }
    if (
      this.phase === "tx2"
      && sql.includes("pg_catalog.pg_current_xact_id()")
    ) {
      if (!authority) throw new Error("TX1 authority was not captured.");
      return {
        rows: fixtureRows<Row>({
          id: claim.id,
          user_id: claim.userId,
          operation_id: claim.operationId,
          delivery_scope_key: claim.deliveryScopeKey,
          claim_version: claim.claimVersion,
          to_email: claim.payload.to,
          template: claim.payload.template,
          template_version: claim.payload.templateVersion,
          variables: claim.payload.variables,
          claim_token: claim.claimToken,
          claim_owner: claim.claimOwner,
          attempt_count: claim.attempt,
          lease_expires_at: PROVIDER_LEASE_EXPIRES_AT,
          adapter: authority.adapter,
          provider_call_started: PROVIDER_STARTED_AT,
          transaction_id: "42",
          dispatch_binding_version: authority.bindingVersion,
          dispatch_binding_sha256: authority.bindingSha256,
          provider_correlation_version: authority.correlationVersion,
          provider_evidence_version: authority.evidenceVersion,
          provider_evidence_sha256: authority.evidenceSha256,
          provider_request_body_sha256: authority.requestBodySha256,
          provider_request_body_length: authority.requestBodyLength,
          release_receipt_sha256: authority.releaseReceiptSha256,
        }),
      };
    }
    if (
      this.phase === "tx2"
      && sql.includes("select 1 from public.email_outbox")
    ) {
      return { rows: fixtureRows<Row>({ authorized: 1 }) };
    }
    throw new Error(`Unexpected ${this.phase} fixture query: ${sql}`);
  }

  release(destroy = false) {
    marker(
      `${this.phase.toUpperCase()}_RELEASE_${destroy ? "TRUE" : "FALSE"}`,
    );
  }
}

class StartupFixtureClient implements OutboxPgClient {
  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
  ) {
    const sql = compact(text);
    if (
      sql.includes("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY")
      || sql === "COMMIT"
      || sql === "ROLLBACK"
    ) {
      return { rows: [] as Row[] };
    }
    if (sql.includes("current_setting('max_connections')")) {
      return {
        rows: fixtureRows<Row>({
          max_connections: "89",
          admin_reserved_connections: "3",
          server_version_num: "170005",
        }),
      };
    }
    if (sql.includes("hold_column")) {
      return {
        rows: fixtureRows<Row>({
          hold_catalog_present: true,
          hold_catalog_exact: true,
          delivery_release_capability_exact: true,
        }),
      };
    }
    throw new Error(`Unexpected startup fixture query: ${sql}`);
  }

  release() {}
}

class FixturePool implements OutboxPgPool, MailDispatchStartupPool {
  readonly options = Object.freeze({
    max: 3,
    connectionTimeoutMillis: 2_000,
    idleTimeoutMillis: 30_000,
  });
  private connection = 0;


  async connect(): Promise<OutboxPgClient> {
    this.connection += 1;
    if (this.connection === 1) return new StartupFixtureClient();
    if (this.connection === 2) return new FixtureClient("tx1");
    marker("TX2_CONNECT");
    if (
      scenario === "acquire-timeout"
      || scenario === "already-claimed-watchdog"
    ) {
      return await new Promise<OutboxPgClient>(() => {});
    }
    return new FixtureClient("tx2");
  }
}

type ConsoleCallback = (error?: Error | null) => void;
function fixtureWrite(
  chunk: string | Uint8Array,
  callback?: ConsoleCallback,
): boolean;
function fixtureWrite(
  chunk: string | Uint8Array,
  encoding?: BufferEncoding,
  callback?: ConsoleCallback,
): boolean;
function fixtureWrite(
  _chunk: string | Uint8Array,
  encodingOrCallback?: BufferEncoding | ConsoleCallback,
  callback?: ConsoleCallback,
) {
  marker("PROVIDER_START");
  if (scenario !== "provider-unsettled") {
    const settle =
      typeof encodingOrCallback === "function"
        ? encodingOrCallback
        : callback;
    settle?.();
  }
  return true;
}

process.stdout.write = fixtureWrite;
process.on("uncaughtException", () => marker("UNCAUGHT"));
process.on("unhandledRejection", () => marker("UNHANDLED"));

async function main() {
  const pool = new FixturePool();
  const inspection = await inspectMailDispatchRuntime(pool);
  const origin = captureMailDispatchApplicationOrigin(inspection);
  const store = new PostgresOutboxStore(pool, inspection, origin);
  const materialized = createMaterializedDispatch({
    source: {
      applicationUrl: APP_URL,
      outboxId: claim.id,
      operationId: claim.operationId,
      claimToken: claim.claimToken,
      claimOwner: claim.claimOwner,
      claimVersion: claim.claimVersion,
      deliveryScopeKey: claim.deliveryScopeKey,
      recipient: claim.payload.to,
      template: "invitation",
      templateVersion: claim.payload.templateVersion,
      variables: claim.payload.variables,
    },
    adapter: "console",
    from: "Codestead <mail@codestead.test>",
    messageId: outboxMessageId(claim.operationId),
    runtimePlan: mailDispatchPreparedRuntimePlan(store),
    transportConfiguration: captureMailTransportConfiguration("console"),
  });
  const envelope = materializedDispatchEnvelope(materialized);
  if (!envelope) throw new Error("Expected a prepared fixture envelope.");
  const boundary = await store.beginProviderCall(claim, {
    adapter: "console",
    envelope,
  });
  if (boundary.kind !== "applied") {
    throw new Error("Expected committed fixture authority.");
  }
  const guarded = await authorizeCommittedPreparedDispatch(
    store,
    boundary.receipt,
  );
  marker("READY");

  const watchdog = await startMailDispatchHardWatchdog();
  const armed = await watchdog.arm();

  try {
    if (scenario === "unarmed-watchdog") {
      await disarmMailDispatchHardWatchdog(armed);
      marker("WATCHDOG_DISARMED");
      await store.dispatchAfterProviderBoundary(
        boundary.permit,
        guarded,
        armed,
      );
    } else if (scenario === "already-claimed-watchdog") {
      void store.dispatchAfterProviderBoundary(
        boundary.permit,
        guarded,
        armed,
      );
      marker("FIRST_DISPATCH_PENDING");
      await store.dispatchAfterProviderBoundary(
        boundary.permit,
        guarded,
        armed,
      );
    } else {
      await store.dispatchAfterProviderBoundary(
        boundary.permit,
        guarded,
        armed,
      );
    }
    marker("SURVIVED");
  } catch {
    marker("CATCH");
  } finally {
    marker("FINALLY");
  }
}

void main().catch(() => {
  marker("TOP_LEVEL_FAILED");
  process.exitCode = 70;
});
