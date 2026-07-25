import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  createConfiguredMaterializedDispatch,
  materializedDispatchEnvelope,
} = require("../../guarded-prepared-dispatch.ts");
const {
  startMailDispatchHardWatchdog,
} = require("../../mail-dispatch-hard-watchdog.ts");
const {
  inspectMailDispatchRuntime,
} = require("../../mail-dispatch-runtime-startup.ts");
const {
  authorizeCommittedPreparedDispatch,
  mailDispatchPreparedRuntimePlan,
  PostgresOutboxStore,
} = require("../../postgres-outbox-store.ts");
const {
  outboxMessageId,
} = require("../../provider-correlation.ts");
const OUTBOX_ID = "11111111-1111-4111-8111-111111111111";
const OPERATION_ID = "22222222-2222-4222-8222-222222222222";
const CLAIM_TOKEN = "33333333-3333-4333-8333-333333333333";
const USER_ID = "learner-1";
const DELIVERY_SCOPE_KEY = `a:${USER_ID}`;
const PROVIDER_STARTED_AT = "2026-07-25 06:00:00.123456+00";
const PROVIDER_LEASE_EXPIRES_AT = "2026-07-25 06:01:50.123456+00";

process.env.GMAIL_CLIENT_ID = "fixture-client";
process.env.GMAIL_CLIENT_SECRET = "fixture-secret";
process.env.GMAIL_REFRESH_TOKEN = "fixture-refresh";

const claim = Object.freeze({
  phase: "pre-provider",
  id: OUTBOX_ID,
  operationId: OPERATION_ID,
  claimToken: CLAIM_TOKEN,
  claimOwner: "mail-worker:test",
  claimVersion: 4,
  userId: USER_ID,
  deliveryScopeKey: DELIVERY_SCOPE_KEY,
  attempt: 2,
  leaseExpiresAt: new Date("2026-07-25T06:00:30.000Z"),
  payload: Object.freeze({
    userId: USER_ID,
    to: "learner@example.test",
    template: "verify-email",
    templateVersion: "1",
    variables: Object.freeze({
      name: "Learner",
      url: "http://localhost:3000/invitations/fixture",
    }),
  }),
});

function compact(sql) {
  return sql.replace(/\s+/gu, " ").trim();
}

function scopeRow() {
  return {
    id: OUTBOX_ID,
    user_id: USER_ID,
    operation_id: OPERATION_ID,
    delivery_scope_key: DELIVERY_SCOPE_KEY,
    claim_version: claim.claimVersion,
  };
}

class BoundaryClient {
  #step = 0;

  async query(text, values = []) {
    const sql = compact(text);
    const expected = [
      "begin",
      "pg_advisory_xact_lock",
      "for update",
      "account_not_active_at_provider_boundary",
      "set provider_call_started",
      "commit",
    ][this.#step];
    this.#step += 1;
    if (!expected || !sql.toLowerCase().includes(expected)) {
      throw new Error(`Unexpected TX1 query: ${sql}`);
    }

    if (expected === "for update") {
      return { rows: [scopeRow()] };
    }
    if (expected === "account_not_active_at_provider_boundary") {
      return { rows: [{ decision: "allowed" }] };
    }
    if (expected === "set provider_call_started") {
      return {
        rows: [{
          provider_call_started: PROVIDER_STARTED_AT,
          lease_expires_at: PROVIDER_LEASE_EXPIRES_AT,
          adapter: String(values[5]),
          dispatch_binding_version: String(values[18]),
          dispatch_binding_sha256: String(values[19]),
          provider_correlation_version: String(values[20]),
          provider_evidence_version: values[21],
          provider_evidence_sha256: values[22],
        }],
      };
    }
    return { rows: [] };
  }

  release() {
    if (this.#step !== 6) {
      throw new Error("TX1 released before its script was consumed.");
    }
  }
}

const boundaryClient = new BoundaryClient();
let connectCalls = 0;
const pool = {
  options: {
    max: 3,
    connectionTimeoutMillis: 2_000,
    idleTimeoutMillis: 30_000,
  },
  async query() {
    return {
      rows: [{
        max_connections: "200",
        admin_reserved_connections: "3",
        server_version_num: "170000",
      }],
    };
  },
  async connect() {
    connectCalls += 1;
    if (connectCalls === 1) return boundaryClient;
    process.stdout.write("FORBIDDEN_TX2_CONNECT\n");
    throw new Error("TX2 pool connection must not be attempted after drift.");
  },
};

globalThis.fetch = async (url) => {
  if (String(url) === "https://oauth2.googleapis.com/token") {
    return new Response('{"access_token":"fixture-access"}', { status: 200 });
  }
  process.stdout.write("FORBIDDEN_PROVIDER\n");
  throw new Error("Provider initiation must not occur after pool drift.");
};

const inspection = await inspectMailDispatchRuntime(pool);
const store = new PostgresOutboxStore(pool, inspection);
const runtimePlan = mailDispatchPreparedRuntimePlan(store);
if (!runtimePlan) throw new Error("Store runtime plan was not issued.");

const materialized = createConfiguredMaterializedDispatch({
  source: {
    applicationUrl: "http://localhost:3000",
    outboxId: claim.id,
    operationId: claim.operationId,
    claimToken: claim.claimToken,
    claimOwner: claim.claimOwner,
    claimVersion: claim.claimVersion,
    deliveryScopeKey: claim.deliveryScopeKey,
    recipient: claim.payload.to,
    template: claim.payload.template,
    templateVersion: claim.payload.templateVersion,
    variables: claim.payload.variables,
  },
  adapter: "gmail",
  from: "Codestead <mail@codestead.test>",
  messageId: outboxMessageId(claim.operationId),
  runtimePlan,
});
const envelope = materializedDispatchEnvelope(materialized);
if (!envelope) throw new Error("Materialized dispatch envelope was not issued.");

const boundary = await store.beginProviderCall(claim, {
  adapter: "gmail",
  envelope,
});
if (boundary.kind !== "applied") {
  throw new Error(`Expected applied provider boundary, got ${boundary.kind}.`);
}
const guarded = await authorizeCommittedPreparedDispatch(
  store,
  boundary.receipt,
);
const watchdog = await startMailDispatchHardWatchdog();
const armed = await watchdog.arm();

process.stdout.write("READY\n");
pool.options.max = 4;
await store.dispatchAfterProviderBoundary(
  boundary.permit,
  guarded,
  armed,
);
process.stdout.write("RESUMED\n");
