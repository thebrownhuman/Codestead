import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { inspect } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

const LIVE_TX2_CONTEXT_PROBE = vi.hoisted(() => ({
  enabled: false,
  firstError: null as unknown,
  secondError: null as unknown,
}));

vi.mock("../mailer-transport-internal", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../mailer-transport-internal")>();
  return {
    ...actual,
    async sendPreparedEmail(
      ...args: Parameters<typeof actual.sendPreparedEmail>
    ) {
      if (!LIVE_TX2_CONTEXT_PROBE.enabled) {
        return actual.sendPreparedEmail(...args);
      }
      LIVE_TX2_CONTEXT_PROBE.enabled = false;
      const throwingContext = new Proxy(args[1] as object, {
        isExtensible() {
          throw new Error("adversarial live-TX2 context");
        },
      });
      try {
        await actual.sendPreparedEmail(
          args[0],
          throwingContext,
          args[2],
          args[3],
        );
      } catch (error) {
        LIVE_TX2_CONTEXT_PROBE.firstError = error;
      }
      try {
        await actual.sendPreparedEmail(...args);
      } catch (error) {
        LIVE_TX2_CONTEXT_PROBE.secondError = error;
      }
      return { providerId: "live-tx2-context-probe" };
    },
  };
});

import * as publicGuardedDispatch from "../guarded-prepared-dispatch";
import * as publicMailer from "../mailer";
import { captureMailTransportConfiguration } from "../mailer-transport-internal";
import {
  createMaterializedDispatch,
  createStoreBoundPreparedDispatchChannel,
  materializedDispatchEnvelope,
  preparedDispatchStoreView,
  type GuardedPreparedDispatch,
  type MaterializedDispatch,
  type PreparedDispatchRuntimePlan,
} from "../prepared-dispatch-materialization";
import {
  FatalProviderTransportError,
  classifyMailDeliveryError,
  isFatalProviderTransportError,
  type CommittedPreparedDispatchReceipt,
  type PostProviderExit,
} from "../provider-dispatch-contract";
import {
  dispatchEvidenceSha256,
  PROVIDER_EVIDENCE_VERSION,
} from "../dispatch-evidence";
import {
  OPAQUE_SHA256_PROVIDER_CORRELATION_VERSION,
  outboxCorrelationToken,
  outboxMessageId,
} from "../provider-correlation";
import {
  inspectMailDispatchRuntime,
  type MailDispatchStartupPool,
} from "../mail-dispatch-runtime-startup";
import {
  disarmMailDispatchHardWatchdog,
  startMailDispatchHardWatchdog,
  type ArmedMailDispatchHardWatchdog,
  type MailDispatchHardWatchdog,
} from "../mail-dispatch-hard-watchdog";
import {
  authorizeCommittedPreparedDispatch,
  captureMailDispatchApplicationOrigin,
  discardCommittedPreparedDispatchReceipt,
  discardGuardedPreparedDispatch,
  guardedDispatchResultSafeToDisarm,
  mailDispatchPreparedRuntimePlan,
  PostgresOutboxStore,
  releaseGuardedDispatchWatchdogClaim,
  type EmailOutboxPayload,
  type OutboxPgClient,
  type OutboxPgPool,
} from "../postgres-outbox-store";
import type {
  OutboxClaim,
  ProviderCallPermit,
  GuardedDispatchResult,
} from "../outbox-worker";

const OPERATION_ID = "22222222-2222-4222-8222-222222222222";
const OUTBOX_ID = "11111111-1111-4111-8111-111111111111";
const RECIPIENT = "learner@example.test";
const RUNTIME_PLAN: PreparedDispatchRuntimePlan = Object.freeze({
  timeouts: Object.freeze({
    oauthDeadlineMs: 20_000,
    guardedSendDeadlineMs: 20_000,
    providerAbortSettlementMs: 5_000,
  }),
});

function startupConfiguration(adapter: "console" | "gmail") {
  if (adapter === "gmail") {
    vi.stubEnv("GMAIL_CLIENT_ID", "startup-client");
    vi.stubEnv("GMAIL_CLIENT_SECRET", "startup-client-secret");
    vi.stubEnv("GMAIL_REFRESH_TOKEN", "startup-refresh-secret");
  }
  return captureMailTransportConfiguration(adapter);
}

type HarnessFixture = Readonly<{
  adapter: "console" | "gmail";
  claim: OutboxClaim<EmailOutboxPayload>;
}>;

const HARNESS_FIXTURES = new WeakMap<MaterializedDispatch, HarnessFixture>();
function materialize(
  adapter: "console" | "gmail",
  transportConfiguration = startupConfiguration(adapter),
  sequence = 2,
  runtimePlan: PreparedDispatchRuntimePlan = RUNTIME_PLAN,
): MaterializedDispatch {
  const operationId =
    sequence === 2 ? OPERATION_ID : "55555555-5555-4555-8555-555555555555";
  const outboxId =
    sequence === 2 ? OUTBOX_ID : "66666666-6666-4666-8666-666666666666";
  const claimToken =
    sequence === 2
      ? "33333333-3333-4333-8333-333333333332"
      : "33333333-3333-4333-8333-333333333335";
  const userId = `learner-${sequence}`;
  const recipient = sequence === 2 ? RECIPIENT : "other@example.test";
  const variables = Object.freeze({
    name: "Learner",
    url: `https://codestead.test/invitations/${sequence}`,
  });
  const materialized = createMaterializedDispatch({
    source: {
      applicationUrl: "https://codestead.test",
      outboxId,
      operationId,
      claimToken,
      claimOwner: "mail-worker:test",
      claimVersion: sequence,
      deliveryScopeKey: `a:${userId}`,
      recipient,
      template: "invitation",
      templateVersion: "1",
      variables,
    },
    adapter,
    from: "Codestead <mail@codestead.test>",
    messageId: outboxMessageId(operationId),
    runtimePlan,
    transportConfiguration,
  });
  HARNESS_FIXTURES.set(
    materialized,
    Object.freeze({
      adapter,
      claim: Object.freeze({
        phase: "pre-provider",
        id: outboxId,
        operationId,
        claimToken,
        claimOwner: "mail-worker:test",
        claimVersion: sequence,
        userId,
        deliveryScopeKey: `a:${userId}`,
        attempt: 1,
        leaseExpiresAt: new Date("2030-01-01T00:05:00.000Z"),
        payload: Object.freeze({
          userId,
          to: recipient,
          template: "invitation",
          templateVersion: "1",
          variables,
        }),
      }),
    }),
  );
  return materialized;
}

type CapturedInspection = Readonly<{
  binding: Readonly<{
    bindingVersion: "gmail-raw-v1" | "console-json-v1";
    bindingSha256: string;
  }>;
  providerCorrelationVersion: string;
  providerEvidenceVersion: string | null;
  providerEvidenceSha256: string | null;
  providerRequestBodySha256: string;
  providerRequestBodyLength: number;
}>;

type Rows = Record<string, unknown>[];
type Step = Readonly<{
  name: string;
  contains: string;
  rows?: Rows | ((values: unknown[]) => Rows);
  reject?: Error;
}>;
type Call = Readonly<{ name: string; sql: string; values: unknown[] }>;

function compact(sql: string) {
  return sql.replace(/\s+/gu, " ").trim();
}

class ScriptedClient extends EventEmitter implements OutboxPgClient {
  readonly calls: Call[] = [];
  readonly releaseCalls: boolean[] = [];

  constructor(private readonly steps: Step[]) {
    super();
  }

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values: unknown[] = [],
  ) {
    const sql = compact(text);
    const step = this.steps.shift();
    expect(step, `Unexpected SQL: ${sql}`).toBeDefined();
    expect(sql.toLowerCase()).toContain(step!.contains.toLowerCase());
    this.calls.push({ name: step!.name, sql, values });
    if (step!.reject) throw step!.reject;
    const rows =
      typeof step!.rows === "function"
        ? step!.rows(values)
        : (step!.rows ?? []);
    return { rows: rows as Row[] };
  }

  release(destroy = false) {
    this.releaseCalls.push(destroy);
    if (destroy) queueMicrotask(() => this.emit("end"));
  }

  assertExhausted() {
    expect(this.steps, "Unconsumed scripted SQL").toEqual([]);
  }
}

class ScriptedPool implements OutboxPgPool, MailDispatchStartupPool {
  readonly options = Object.freeze({
    max: 3,
    connectionTimeoutMillis: 2_000,
    idleTimeoutMillis: 30_000,
  });
  private readonly clients: OutboxPgClient[] = [];

  enqueue(client: OutboxPgClient) {
    this.clients.push(client);
  }

  async connect() {
    const client = this.clients.shift();
    if (!client) throw new Error("Unexpected outbox database connection.");
    return client;
  }
}

function startupSteps(): Step[] {
  return [
    {
      name: "startup-begin",
      contains: "begin isolation level repeatable read read only",
    },
    {
      name: "startup-snapshot",
      contains: "current_setting('max_connections')",
      rows: [
        {
          max_connections: "89",
          admin_reserved_connections: "3",
          server_version_num: "170005",
        },
      ],
    },
    {
      name: "startup-authority",
      contains: "public.attest_email_outbox_delivery_release_lineage",
      rows: [
        {
          hold_catalog_present: true,
          hold_catalog_exact: true,
          delivery_release_capability_exact: true,
        },
      ],
    },
    { name: "startup-commit", contains: "commit" },
  ];
}

const PROVIDER_STARTED_AT = "2026-07-22 19:00:05.123456+00";
const PROVIDER_LEASE_EXPIRES_AT = "2026-07-22 19:05:05.123456+00";
const RELEASE_RECEIPT_SHA256 = "a".repeat(64);

type Authority = Readonly<{
  adapter: "console" | "gmail";
  bindingVersion: "gmail-raw-v1" | "console-json-v1";
  bindingSha256: string;
  correlationVersion: string;
  evidenceVersion: string | null;
  evidenceSha256: string | null;
  requestBodySha256: string;
  requestBodyLength: number;
  releaseReceiptSha256: string;
  providerCallStartedAt: string;
  leaseExpiresAt: string;
}>;

type BoundaryEntry = Readonly<{
  materialized: MaterializedDispatch;
  envelope: NonNullable<ReturnType<typeof materializedDispatchEnvelope>>;
  view: NonNullable<ReturnType<typeof preparedDispatchStoreView>>;
  fixture: HarnessFixture;
  permit: ProviderCallPermit;
  receipt: CommittedPreparedDispatchReceipt;
  authority: Authority;
  inspection: CapturedInspection;
}>;

type Watchdog = Readonly<{
  controller: MailDispatchHardWatchdog;
  armed: ArmedMailDispatchHardWatchdog;
}>;

const watchdogs = new Set<Watchdog>();

function text(value: unknown, name: string) {
  if (typeof value !== "string") {
    throw new Error(`Expected ${name} to be a string.`);
  }
  return value;
}

function nullableText(value: unknown, name: string) {
  if (value !== null && typeof value !== "string") {
    throw new Error(`Expected ${name} to be a nullable string.`);
  }
  return value;
}

function inspectionFromAuthority(authority: Authority): CapturedInspection {
  return Object.freeze({
    binding: Object.freeze({
      bindingVersion: authority.bindingVersion,
      bindingSha256: authority.bindingSha256,
    }),
    providerCorrelationVersion: authority.correlationVersion,
    providerEvidenceVersion: authority.evidenceVersion,
    providerEvidenceSha256: authority.evidenceSha256,
    providerRequestBodySha256: authority.requestBodySha256,
    providerRequestBodyLength: authority.requestBodyLength,
  });
}

async function createHarness() {
  vi.stubEnv("APP_URL", "https://codestead.test");
  const pool = new ScriptedPool();
  const startup = new ScriptedClient(startupSteps());
  pool.enqueue(startup);
  const startupInspection = await inspectMailDispatchRuntime(pool);
  startup.assertExhausted();
  expect(startup.calls.map(({ name }) => name)).toEqual([
    "startup-begin",
    "startup-snapshot",
    "startup-authority",
    "startup-commit",
  ]);
  expect(startup.releaseCalls).toEqual([false]);
  const applicationOrigin =
    captureMailDispatchApplicationOrigin(startupInspection);
  const store = new PostgresOutboxStore(
    pool,
    startupInspection,
    applicationOrigin,
  );
  return { pool, store };
}

function materializeForStore(
  store: PostgresOutboxStore,
  adapter: "console" | "gmail",
  transportConfiguration = startupConfiguration(adapter),
  sequence = 2,
) {
  return materialize(
    adapter,
    transportConfiguration,
    sequence,
    mailDispatchPreparedRuntimePlan(store),
  );
}

function tx1Steps(
  fixture: HarnessFixture,
  captured: { authority?: Authority },
): Step[] {
  const claim = fixture.claim;
  return [
    { name: "tx1-begin", contains: "begin" },
    { name: "tx1-scope-lock", contains: "pg_advisory_xact_lock" },
    {
      name: "tx1-fence",
      contains:
        "select id::text, user_id, operation_id::text, delivery_scope_key",
      rows: [
        {
          id: claim.id,
          user_id: claim.userId,
          operation_id: claim.operationId,
          delivery_scope_key: claim.deliveryScopeKey,
          claim_version: claim.claimVersion,
        },
      ],
    },
    {
      name: "tx1-authority-unlocked",
      contains: "select case",
      rows: [{ decision: "allowed" }],
    },
    {
      name: "tx1-authority-locked",
      contains: "select case",
      rows: [{ decision: "allowed" }],
    },
    {
      name: "tx1-arm",
      contains: "update public.email_outbox as outbox",
      rows: (values) => {
        const adapter = text(values[5], "adapter");
        if (adapter !== "console" && adapter !== "gmail") {
          throw new Error("Expected a supported adapter.");
        }
        const bindingVersion = text(values[18], "binding version");
        if (
          bindingVersion !== "console-json-v1" &&
          bindingVersion !== "gmail-raw-v1"
        ) {
          throw new Error("Expected a supported binding version.");
        }
        if (
          typeof values[24] !== "number" ||
          !Number.isSafeInteger(values[24])
        ) {
          throw new Error("Expected an exact request-body length.");
        }
        const authority: Authority = Object.freeze({
          adapter,
          bindingVersion,
          bindingSha256: text(values[19], "binding digest"),
          correlationVersion: text(values[20], "correlation version"),
          evidenceVersion: nullableText(values[21], "evidence version"),
          evidenceSha256: nullableText(values[22], "evidence digest"),
          requestBodySha256: text(values[23], "request-body digest"),
          requestBodyLength: values[24],
          releaseReceiptSha256: RELEASE_RECEIPT_SHA256,
          providerCallStartedAt: PROVIDER_STARTED_AT,
          leaseExpiresAt: PROVIDER_LEASE_EXPIRES_AT,
        });
        captured.authority = authority;
        return [
          {
            provider_call_started: authority.providerCallStartedAt,
            lease_expires_at: authority.leaseExpiresAt,
            dispatch_binding_version: authority.bindingVersion,
            dispatch_binding_sha256: authority.bindingSha256,
            provider_correlation_version: authority.correlationVersion,
            provider_evidence_version: authority.evidenceVersion,
            provider_evidence_sha256: authority.evidenceSha256,
            provider_request_body_sha256: authority.requestBodySha256,
            provider_request_body_length: authority.requestBodyLength,
            release_receipt_sha256: authority.releaseReceiptSha256,
          },
        ];
      },
    },
    { name: "tx1-commit", contains: "commit" },
  ];
}

async function armMaterialized(
  harness: Awaited<ReturnType<typeof createHarness>>,
  materialized: MaterializedDispatch,
): Promise<BoundaryEntry> {
  const fixture = HARNESS_FIXTURES.get(materialized);
  if (!fixture) throw new Error("Expected a real materialized fixture.");
  const envelope = materializedDispatchEnvelope(materialized);
  if (!envelope) throw new Error("Expected a materialized envelope.");
  const view = preparedDispatchStoreView(envelope);
  if (!view) throw new Error("Expected a prepared store view.");
  const captured: { authority?: Authority } = {};
  const tx1 = new ScriptedClient(tx1Steps(fixture, captured));
  harness.pool.enqueue(tx1);
  const result = await harness.store.beginProviderCall(fixture.claim, {
    adapter: fixture.adapter,
    envelope,
  });
  expect(result.kind).toBe("applied");
  if (result.kind !== "applied" || !captured.authority) {
    throw new Error("Expected committed TX1 provider authority.");
  }
  tx1.assertExhausted();
  expect(tx1.releaseCalls).toEqual([false]);
  return Object.freeze({
    materialized,
    envelope,
    view,
    fixture,
    permit: result.permit,
    receipt: result.receipt,
    authority: captured.authority,
    inspection: inspectionFromAuthority(captured.authority),
  });
}

function liveRow(entry: BoundaryEntry) {
  const claim = entry.fixture.claim;
  const authority = entry.authority;
  return {
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
    lease_expires_at: authority.leaseExpiresAt,
    adapter: authority.adapter,
    provider_call_started: authority.providerCallStartedAt,
    transaction_id: "42",
    dispatch_binding_version: authority.bindingVersion,
    dispatch_binding_sha256: authority.bindingSha256,
    provider_correlation_version: authority.correlationVersion,
    provider_evidence_version: authority.evidenceVersion,
    provider_evidence_sha256: authority.evidenceSha256,
    provider_request_body_sha256: authority.requestBodySha256,
    provider_request_body_length: authority.requestBodyLength,
    release_receipt_sha256: authority.releaseReceiptSha256,
  };
}

function terminalRow(entry: BoundaryEntry, values: unknown[]) {
  const claim = entry.fixture.claim;
  const authority = entry.authority;
  const kind = text(values[14], "terminal kind");
  return {
    status: kind,
    claim_version:
      kind === "quarantined" ? claim.claimVersion + 1 : claim.claimVersion,
    user_id: claim.userId,
    delivery_scope_key: claim.deliveryScopeKey,
    adapter: authority.adapter,
    provider_message_id: values[15],
    provider_call_started: authority.providerCallStartedAt,
    sent_at: kind === "sent" ? "2026-07-22 19:00:06.123456+00" : null,
    quarantined_at:
      kind === "quarantined" ? "2026-07-22 19:00:06.123456+00" : null,
    last_error_code: values[16],
    claim_token: null,
    claim_owner: null,
    lease_expires_at: null,
    dispatch_binding_version: authority.bindingVersion,
    dispatch_binding_sha256: authority.bindingSha256,
    provider_correlation_version: authority.correlationVersion,
    provider_evidence_version: authority.evidenceVersion,
    provider_evidence_sha256: authority.evidenceSha256,
    provider_request_body_sha256: authority.requestBodySha256,
    provider_request_body_length: authority.requestBodyLength,
    release_receipt_sha256: authority.releaseReceiptSha256,
  };
}

function successfulTx2Steps(entry: BoundaryEntry): Step[] {
  return [
    { name: "tx2-begin", contains: "begin" },
    { name: "tx2-lock-timeout", contains: "set local lock_timeout" },
    {
      name: "tx2-statement-timeout",
      contains: "set local statement_timeout",
    },
    {
      name: "tx2-idle-zero",
      contains: "set local idle_in_transaction_session_timeout = '0'",
    },
    {
      name: "tx2-transaction-zero",
      contains: "set local transaction_timeout = '0'",
    },
    { name: "tx2-scope-lock", contains: "pg_advisory_xact_lock" },
    {
      name: "tx2-live-fence",
      contains: "pg_catalog.pg_current_xact_id()",
      rows: [liveRow(entry)],
    },
    {
      name: "tx2-authority",
      contains: "select case",
      rows: [{ decision: "allowed" }],
    },
    {
      name: "tx2-final-fence",
      contains: "select 1 from public.email_outbox",
      rows: [{ authorized: 1 }],
    },
    {
      name: "tx2-transaction-finite",
      contains: "set local transaction_timeout = '60000ms'",
    },
    {
      name: "tx2-idle-finite",
      contains: "set local idle_in_transaction_session_timeout = '60000ms'",
    },
    {
      name: "tx2-terminal",
      contains: "update public.email_outbox",
      rows: (values) => [terminalRow(entry, values)],
    },
    { name: "tx2-commit", contains: "commit" },
  ];
}

async function createWatchdog(): Promise<Watchdog> {
  const controller = await startMailDispatchHardWatchdog();
  const armed = await controller.arm();
  const watchdog = Object.freeze({ controller, armed });
  watchdogs.add(watchdog);
  return watchdog;
}

async function disarmSafeResult(
  store: PostgresOutboxStore,
  watchdog: Watchdog,
  result: GuardedDispatchResult,
) {
  expect(guardedDispatchResultSafeToDisarm(store, watchdog.armed, result)).toBe(
    true,
  );
  await disarmMailDispatchHardWatchdog(watchdog.armed);
  expect(releaseGuardedDispatchWatchdogClaim(store, watchdog.armed)).toBe(true);
  await watchdog.controller.close();
  watchdogs.delete(watchdog);
}

async function dispatchBoundary(
  harness: Awaited<ReturnType<typeof createHarness>>,
  entry: BoundaryEntry,
  guarded: GuardedPreparedDispatch,
): Promise<PostProviderExit> {
  const tx2 = new ScriptedClient(successfulTx2Steps(entry));
  harness.pool.enqueue(tx2);
  const watchdog = await createWatchdog();
  const result = await harness.store.dispatchAfterProviderBoundary(
    entry.permit,
    guarded,
    watchdog.armed,
  );
  await disarmSafeResult(harness.store, watchdog, result);
  tx2.assertExhausted();
  expect(tx2.releaseCalls).toEqual([false]);
  if (result.kind !== "applied") {
    throw new Error("Expected real TX2 persistence to apply.");
  }
  return result.exit;
}

type ConsoleWriteCallback = (error?: Error | null) => void;

function immediateConsoleWrite() {
  function implementation(
    chunk: string | Uint8Array,
    callback?: ConsoleWriteCallback,
  ): boolean;
  function implementation(
    chunk: string | Uint8Array,
    encoding?: BufferEncoding,
    callback?: ConsoleWriteCallback,
  ): boolean;
  function implementation(
    _chunk: string | Uint8Array,
    encodingOrCallback?: BufferEncoding | ConsoleWriteCallback,
    callback?: ConsoleWriteCallback,
  ) {
    const writeCallback =
      typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
    writeCallback?.();
    return true;
  }
  return vi.spyOn(process.stdout, "write").mockImplementation(implementation);
}

function gmailFetch() {
  return vi.fn<typeof fetch>(async (url) =>
    String(url) === "https://oauth2.googleapis.com/token"
      ? new Response('{"access_token":"oauth-access-token"}', { status: 200 })
      : new Response('{"id":"gmail-provider-id"}', { status: 200 }),
  );
}

afterEach(() => {
  LIVE_TX2_CONTEXT_PROBE.enabled = false;
  LIVE_TX2_CONTEXT_PROBE.firstError = null;
  LIVE_TX2_CONTEXT_PROBE.secondError = null;
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("exact-byte prepared-dispatch wrapper", () => {
  it("keeps every public capability handle empty and guarded authority internals private", () => {
    const materialized = materialize("gmail");
    const envelope = materializedDispatchEnvelope(materialized)!;
    const view = preparedDispatchStoreView(envelope)!;

    for (const handle of [materialized, envelope, view]) {
      expect(Object.isFrozen(handle)).toBe(true);
      expect(Reflect.ownKeys(handle)).toEqual([]);
      expect(Object.getOwnPropertyDescriptors(handle)).toEqual({});
      expect({ ...handle }).toEqual({});
      expect(JSON.stringify(handle)).toBe("{}");
      expect(inspect(handle, { showHidden: true })).not.toContain(RECIPIENT);
      expect(inspect(handle, { showHidden: true })).not.toContain(OPERATION_ID);
    }
    expect(
      Reflect.ownKeys(publicMailer)
        .filter((key): key is string => typeof key === "string")
        .sort(),
    ).toEqual([
      "MailDeliveryError",
      "classifyMailDeliveryError",
      "prepareEmail",
    ]);
    expect(JSON.stringify(publicMailer)).toBe("{}");
    for (const name of [
      "authorizeCommittedPreparedDispatch",
      "authorizePreparedEmail",
      "consumeMaterializedGmailPreparation",
      "createStoreBoundPreparedDispatchChannel",
      "dispatchBinding",
      "dispatchGuardedPrepared",
      "issueMaterializedGmailPreparation",
      "prepareEmail",
      "preparedEmailBindingMatches",
      "sendEmail",
      "sendPreparedEmail",
    ]) {
      expect(publicGuardedDispatch).not.toHaveProperty(name);
    }
    for (const name of [
      "authorizeCommittedPreparedDispatch",
      "authorizePreparedEmail",
      "consumeMaterializedGmailPreparation",
      "createStoreBoundPreparedDispatchChannel",
      "dispatchBinding",
      "dispatchGuardedPrepared",
      "issueMaterializedGmailPreparation",
      "preparedEmailBindingMatches",
      "sendEmail",
      "sendPreparedEmail",
    ]) {
      expect(publicMailer).not.toHaveProperty(name);
    }
  });

  it("restricts the one-shot Gmail preparation capability to the trusted production importer", () => {
    const workspaceDirectory = process.cwd();
    const guardedNames = [
      "consumeMaterializedGmailPreparation",
      "issueMaterializedGmailPreparation",
    ];
    const pending = [
      join(workspaceDirectory, "scripts"),
      join(workspaceDirectory, "src"),
    ];
    const productionFiles: string[] = [];
    while (pending.length > 0) {
      const directory = pending.pop()!;
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== "__tests__") pending.push(path);
        } else if (
          entry.isFile() &&
          /\.[cm]?[jt]s$/u.test(entry.name) &&
          !/\.(?:spec|test|typecheck)\.[cm]?[jt]s$/u.test(entry.name)
        ) {
          productionFiles.push(path);
        }
      }
    }
    const productionImporters = productionFiles
      .filter(
        (path) => !path.endsWith(join("notifications", "prepared-dispatch.ts")),
      )
      .filter((path) => {
        const source = readFileSync(path, "utf8");
        return guardedNames.some((name) => source.includes(name));
      })
      .map((path) => relative(workspaceDirectory, path).replaceAll("\\", "/"))
      .sort();

    expect(productionImporters).toEqual([
      "src/lib/notifications/prepared-dispatch-materialization.ts",
    ]);
  });

  it("generates exactly one canonical random evidence header and binds its final bytes and digest", async () => {
    const fetchMock = gmailFetch();
    vi.stubGlobal("fetch", fetchMock);
    const harness = await createHarness();
    const materialized = materializeForStore(harness.store, "gmail");
    const entry = await armMaterialized(harness, materialized);
    const inspection = entry.inspection;

    expect(inspection.binding.bindingVersion).toBe("gmail-raw-v1");
    expect(inspection.providerCorrelationVersion).toBe(
      OPAQUE_SHA256_PROVIDER_CORRELATION_VERSION,
    );
    expect(inspection.providerEvidenceVersion).toBe(PROVIDER_EVIDENCE_VERSION);
    expect(inspection.providerEvidenceSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(inspection).not.toHaveProperty("requestBody");
    expect(inspection).not.toHaveProperty("eventBytes");

    const guarded = await authorizeCommittedPreparedDispatch(
      harness.store,
      entry.receipt,
    );
    expect(Reflect.ownKeys(guarded)).toEqual([]);
    expect(Object.getOwnPropertyDescriptors(guarded)).toEqual({});
    const result = await dispatchBoundary(harness, entry, guarded);
    expect(result).toEqual({
      kind: "sent",
      providerMessageId: "gmail-provider-id",
    });
    expect(Object.isFrozen(result)).toBe(true);

    const [, sendOptions] = fetchMock.mock.calls[1] as [string, RequestInit];
    const requestBody = String(sendOptions.body);
    expect(inspection.providerRequestBodySha256).toBe(
      createHash("sha256").update(requestBody, "utf8").digest("hex"),
    );
    expect(inspection.providerRequestBodyLength).toBe(
      Buffer.byteLength(requestBody, "utf8"),
    );
    expect(JSON.stringify(inspection)).not.toContain(requestBody);
    const raw = (JSON.parse(requestBody) as { raw: string }).raw;
    const rfc822 = Buffer.from(raw, "base64url").toString("utf8");
    const evidenceHeaders = rfc822
      .split("\r\n")
      .filter((line) => /^x-codestead-dispatch-evidence:/iu.test(line));
    expect(evidenceHeaders).toHaveLength(1);
    const match = evidenceHeaders[0]!.match(
      /^X-Codestead-Dispatch-Evidence: v1\.([A-Za-z0-9_-]{43})$/u,
    );
    expect(match).not.toBeNull();
    const evidenceToken = match![1]!;
    expect(Buffer.from(evidenceToken, "base64url")).toHaveLength(32);
    expect(Buffer.from(evidenceToken, "base64url").toString("base64url")).toBe(
      evidenceToken,
    );
    expect(inspection.binding.bindingSha256).toBe(
      createHash("sha256").update(rfc822, "utf8").digest("hex"),
    );
    expect(inspection.providerEvidenceSha256).toBe(
      dispatchEvidenceSha256({
        operationId: OPERATION_ID,
        providerCorrelationVersion: OPAQUE_SHA256_PROVIDER_CORRELATION_VERSION,
        providerCorrelationToken: outboxCorrelationToken(OPERATION_ID),
        dispatchBindingVersion: "gmail-raw-v1",
        adapterPayloadSha256: inspection.binding.bindingSha256,
        providerEvidenceVersion: PROVIDER_EVIDENCE_VERSION,
        evidenceToken,
      }),
    );
    expect(
      JSON.stringify({ materialized: entry!.materialized, inspection }),
    ).not.toContain(evidenceToken);
  });

  it("keeps console evidence null and emits only its frozen safe event", async () => {
    const write = immediateConsoleWrite();
    const harness = await createHarness();
    const entry = await armMaterialized(
      harness,
      materializeForStore(harness.store, "console"),
    );
    const inspection = entry.inspection;
    expect(inspection.binding.bindingVersion).toBe("console-json-v1");
    expect(inspection.providerEvidenceVersion).toBeNull();
    expect(inspection.providerEvidenceSha256).toBeNull();

    const guarded = await authorizeCommittedPreparedDispatch(
      harness.store,
      entry.receipt,
    );
    await expect(
      dispatchBoundary(harness, entry, guarded),
    ).resolves.toMatchObject({ kind: "sent" });
    expect(write).toHaveBeenCalledOnce();
    const requestBody = String(write.mock.calls[0]![0]);
    expect(requestBody).toBe(
      '{"event":"email.console_delivery","template":"invitation"}\n',
    );
    expect(inspection.providerRequestBodySha256).toBe(
      createHash("sha256").update(requestBody, "utf8").digest("hex"),
    );
    expect(inspection.providerRequestBodyLength).toBe(
      Buffer.byteLength(requestBody, "utf8"),
    );
    expect(inspection).not.toHaveProperty("requestBody");
  });

  it("rejects cross-store and replayed committed authority before OAuth", async () => {
    const fetchMock = gmailFetch();
    vi.stubGlobal("fetch", fetchMock);
    const first = await createHarness();
    const entry = await armMaterialized(
      first,
      materializeForStore(first.store, "gmail"),
    );
    const second = await createHarness();

    await expect(
      authorizeCommittedPreparedDispatch(second.store, entry.receipt),
    ).rejects.toThrow("Committed prepared dispatch receipt is invalid.");
    expect(fetchMock).not.toHaveBeenCalled();

    const guarded = await authorizeCommittedPreparedDispatch(
      first.store,
      entry.receipt,
    );
    expect(fetchMock).toHaveBeenCalledOnce();
    fetchMock.mockClear();
    await expect(
      authorizeCommittedPreparedDispatch(first.store, entry.receipt),
    ).rejects.toThrow("Committed prepared dispatch receipt is invalid.");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(
      discardGuardedPreparedDispatch(first.store, entry.permit, guarded),
    ).toBe(true);
  });

  it("rejects a prototype-forged store owner before any provider callback", () => {
    const write = immediateConsoleWrite();
    const fetchMock = gmailFetch();
    vi.stubGlobal("fetch", fetchMock);
    const forgedStore = Object.create(PostgresOutboxStore.prototype);

    expect(() =>
      Reflect.apply(createStoreBoundPreparedDispatchChannel, undefined, [
        forgedStore,
        RUNTIME_PLAN,
      ]),
    ).toThrow("Prepared dispatch channel owner is invalid.");
    expect(write).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("burns a genuine seal before a throwing wrong-context check and rejects correct replay", async () => {
    const write = immediateConsoleWrite();
    const harness = await createHarness();
    const entry = await armMaterialized(
      harness,
      materializeForStore(harness.store, "console"),
    );
    const guarded = await authorizeCommittedPreparedDispatch(
      harness.store,
      entry.receipt,
    );
    LIVE_TX2_CONTEXT_PROBE.enabled = true;

    const exit = await dispatchBoundary(harness, entry, guarded);

    expect(exit).toEqual({
      kind: "sent",
      providerMessageId: "live-tx2-context-probe",
    });
    expect(
      isFatalProviderTransportError(LIVE_TX2_CONTEXT_PROBE.firstError),
    ).toBe(true);
    expect(
      isFatalProviderTransportError(LIVE_TX2_CONTEXT_PROBE.secondError),
    ).toBe(true);
    expect(write).not.toHaveBeenCalled();
  });
  it("ignores genuine-store method replacement and consumes the real receipt once", async () => {
    const write = immediateConsoleWrite();
    const harness = await createHarness();
    const entryA = await armMaterialized(
      harness,
      materializeForStore(harness.store, "console", undefined, 2),
    );
    const entryB = await armMaterialized(
      harness,
      materializeForStore(harness.store, "console", undefined, 5),
    );
    const replacedAccepts = vi.fn(() => true);
    const replacedConsumer = vi.fn(() =>
      Object.freeze({
        envelope: entryB.envelope,
        permit: entryA.permit,
        view: entryB.view,
      }),
    );
    Object.defineProperties(harness.store, {
      acceptsPreparedDispatchChannelBinding: {
        configurable: true,
        value: replacedAccepts,
      },
      consumeCommittedPreparedDispatchReceipt: {
        configurable: true,
        value: replacedConsumer,
      },
    });

    const guarded = await authorizeCommittedPreparedDispatch(
      harness.store,
      entryA.receipt,
    );
    expect(replacedAccepts).not.toHaveBeenCalled();
    expect(replacedConsumer).not.toHaveBeenCalled();
    Reflect.deleteProperty(
      harness.store,
      "acceptsPreparedDispatchChannelBinding",
    );
    Reflect.deleteProperty(
      harness.store,
      "consumeCommittedPreparedDispatchReceipt",
    );

    await expect(
      authorizeCommittedPreparedDispatch(harness.store, entryA.receipt),
    ).rejects.toThrow("Committed prepared dispatch receipt is invalid.");
    expect(
      discardGuardedPreparedDispatch(harness.store, entryA.permit, guarded),
    ).toBe(true);
    expect(
      discardCommittedPreparedDispatchReceipt(
        harness.store,
        entryB.permit,
        entryB.receipt,
      ),
    ).toBe(true);
    expect(write).not.toHaveBeenCalled();
  });

  it("preserves a real receipt after a wrong-permit discard attempt", async () => {
    const write = immediateConsoleWrite();
    const harness = await createHarness();
    const entryA = await armMaterialized(
      harness,
      materializeForStore(harness.store, "console", undefined, 2),
    );
    const entryB = await armMaterialized(
      harness,
      materializeForStore(harness.store, "console", undefined, 5),
    );

    expect(
      discardCommittedPreparedDispatchReceipt(
        harness.store,
        entryB.permit,
        entryA.receipt,
      ),
    ).toBe(false);
    const guarded = await authorizeCommittedPreparedDispatch(
      harness.store,
      entryA.receipt,
    );
    expect(
      discardGuardedPreparedDispatch(harness.store, entryA.permit, guarded),
    ).toBe(true);
    expect(
      discardCommittedPreparedDispatchReceipt(
        harness.store,
        entryB.permit,
        entryB.receipt,
      ),
    ).toBe(true);
    expect(write).not.toHaveBeenCalled();
  });
  it("burns a committed receipt and envelope before OAuth on the first stop gate", async () => {
    const fetchMock = gmailFetch();
    vi.stubGlobal("fetch", fetchMock);
    const harness = await createHarness();
    const entry = await armMaterialized(
      harness,
      materializeForStore(harness.store, "gmail"),
    );

    expect(
      discardCommittedPreparedDispatchReceipt(
        harness.store,
        entry.permit,
        entry.receipt,
      ),
    ).toBe(true);
    expect(
      discardCommittedPreparedDispatchReceipt(
        harness.store,
        entry.permit,
        entry.receipt,
      ),
    ).toBe(false);
    await expect(
      authorizeCommittedPreparedDispatch(harness.store, entry.receipt),
    ).rejects.toThrow("Committed prepared dispatch receipt is invalid.");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(preparedDispatchStoreView(entry.envelope)).toBeNull();
  });
  it("binds every guard to the exact permit and burns it without send on stop", async () => {
    const configuration = startupConfiguration("gmail");
    const fetchMock = gmailFetch();
    vi.stubGlobal("fetch", fetchMock);
    const harness = await createHarness();
    const entryA = await armMaterialized(
      harness,
      materializeForStore(harness.store, "gmail", configuration, 2),
    );
    const entryB = await armMaterialized(
      harness,
      materializeForStore(harness.store, "gmail", configuration, 5),
    );
    const guardA = await authorizeCommittedPreparedDispatch(
      harness.store,
      entryA.receipt,
    );
    const guardB = await authorizeCommittedPreparedDispatch(
      harness.store,
      entryB.receipt,
    );
    fetchMock.mockClear();

    expect(
      discardGuardedPreparedDispatch(harness.store, entryB.permit, guardA),
    ).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();

    await expect(
      dispatchBoundary(harness, entryA, guardA),
    ).resolves.toMatchObject({ kind: "sent" });
    expect(fetchMock).toHaveBeenCalledOnce();
    fetchMock.mockClear();

    expect(
      discardGuardedPreparedDispatch(harness.store, entryB.permit, guardB),
    ).toBe(true);
    expect(
      discardGuardedPreparedDispatch(harness.store, entryB.permit, guardB),
    ).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses startup-captured credentials after ambient environment mutation", async () => {
    vi.stubEnv("GMAIL_CLIENT_ID", "original-client");
    vi.stubEnv("GMAIL_CLIENT_SECRET", "original-secret");
    vi.stubEnv("GMAIL_REFRESH_TOKEN", "original-refresh");
    const configuration = captureMailTransportConfiguration("gmail");
    vi.stubEnv("GMAIL_CLIENT_ID", "attacker-client");
    vi.stubEnv("GMAIL_CLIENT_SECRET", "attacker-secret");
    vi.stubEnv("GMAIL_REFRESH_TOKEN", "attacker-refresh");
    const fetchMock = gmailFetch();
    vi.stubGlobal("fetch", fetchMock);
    const harness = await createHarness();
    const entry = await armMaterialized(
      harness,
      materializeForStore(harness.store, "gmail", configuration),
    );
    const guarded = await authorizeCommittedPreparedDispatch(
      harness.store,
      entry.receipt,
    );
    const [, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = String(options.body);
    expect(body).toContain("client_id=original-client");
    expect(body).toContain("client_secret=original-secret");
    expect(body).toContain("refresh_token=original-refresh");
    expect(body).not.toContain("attacker");
    expect(
      discardGuardedPreparedDispatch(harness.store, entry.permit, guarded),
    ).toBe(true);
  });

  it.each([
    ["non-string", { id: 42 }],
    ["whitespace", { id: " gmail-id " }],
    ["blank", { id: "" }],
    ["oversize", { id: "x".repeat(513) }],
  ])(
    "quarantines an invalid resolved provider result (%s)",
    async (_case, body) => {
      const fetchMock = vi.fn<typeof fetch>(async (url) =>
        String(url) === "https://oauth2.googleapis.com/token"
          ? new Response('{"access_token":"oauth-access-token"}', {
              status: 200,
            })
          : ({ ok: true, json: async () => body } as Response),
      );
      vi.stubGlobal("fetch", fetchMock);
      const harness = await createHarness();
      const entry = await armMaterialized(
        harness,
        materializeForStore(harness.store, "gmail"),
      );
      const guarded = await authorizeCommittedPreparedDispatch(
        harness.store,
        entry.receipt,
      );
      await expect(dispatchBoundary(harness, entry, guarded)).resolves.toEqual({
        kind: "quarantined",
        code: "PROVIDER_OUTCOME_INVALID",
      });
    },
  );

  it("rejects a throwing provider-id accessor without invoking it", async () => {
    let reads = 0;
    const body = {};
    Object.defineProperty(body, "id", {
      enumerable: true,
      get() {
        reads += 1;
        throw new Error("recipient-and-raw-canary");
      },
    });
    const fetchMock = vi.fn<typeof fetch>(async (url) =>
      String(url) === "https://oauth2.googleapis.com/token"
        ? new Response('{"access_token":"oauth-access-token"}', { status: 200 })
        : ({ ok: true, json: async () => body } as Response),
    );
    vi.stubGlobal("fetch", fetchMock);
    const harness = await createHarness();
    const entry = await armMaterialized(
      harness,
      materializeForStore(harness.store, "gmail"),
    );
    const guarded = await authorizeCommittedPreparedDispatch(
      harness.store,
      entry.receipt,
    );
    const outcome = await dispatchBoundary(harness, entry, guarded);
    expect(outcome).toEqual({
      kind: "quarantined",
      code: "PROVIDER_OUTCOME_INVALID",
    });
    expect(reads).toBe(0);
    expect(inspect(outcome, { showHidden: true })).not.toContain("canary");
  });

  it("classifies generic settled rejection and forged fatal identities as UNKNOWN", async () => {
    const secretError = new Error(
      `${OPERATION_ID}:${RECIPIENT}:${Buffer.from(OPERATION_ID).toString("base64url")}`,
    );
    let sendFailure: unknown = secretError;
    const fetchMock = vi.fn<typeof fetch>(async (url) => {
      if (String(url) === "https://oauth2.googleapis.com/token") {
        return new Response('{"access_token":"oauth-access-token"}', {
          status: 200,
        });
      }
      throw sendFailure;
    });
    vi.stubGlobal("fetch", fetchMock);
    const first = await createHarness();
    const entry = await armMaterialized(
      first,
      materializeForStore(first.store, "gmail"),
    );
    const guarded = await authorizeCommittedPreparedDispatch(
      first.store,
      entry.receipt,
    );
    const outcome = await dispatchBoundary(first, entry, guarded);
    expect(outcome).toEqual({
      kind: "quarantined",
      code: "PROVIDER_OUTCOME_UNKNOWN",
    });
    const exposed = `${JSON.stringify(outcome)}\n${inspect(outcome, { showHidden: true })}`;
    expect(exposed).not.toContain(OPERATION_ID);
    expect(exposed).not.toContain(RECIPIENT);
    for (const spoof of [
      Object.create(FatalProviderTransportError.prototype),
      Object.assign(new Error("spoof"), {
        name: "FatalProviderTransportError",
      }),
    ]) {
      sendFailure = spoof;
      const spoofed = await createHarness();
      const spoofedEntry = await armMaterialized(
        spoofed,
        materializeForStore(spoofed.store, "gmail"),
      );
      const spoofedGuard = await authorizeCommittedPreparedDispatch(
        spoofed.store,
        spoofedEntry.receipt,
      );
      await expect(
        dispatchBoundary(spoofed, spoofedEntry, spoofedGuard),
      ).resolves.toEqual({
        kind: "quarantined",
        code: "PROVIDER_OUTCOME_UNKNOWN",
      });
    }
  });

  it("arms the OAuth timer before fetch and discards synchronous abort-listener success", async () => {
    vi.useFakeTimers();
    let timerWasArmed = false;
    const fetchMock = vi.fn<typeof fetch>((_url, init) => {
      timerWasArmed = vi.getTimerCount() > 0;
      return new Promise<Response>((resolve) => {
        init?.signal?.addEventListener(
          "abort",
          () => {
            resolve(
              new Response('{"access_token":"late-token"}', { status: 200 }),
            );
          },
          { once: true },
        );
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const harness = await createHarness();
    const entry = await armMaterialized(
      harness,
      materializeForStore(harness.store, "gmail"),
    );
    let outcome: unknown = "pending";
    void authorizeCommittedPreparedDispatch(harness.store, entry.receipt).then(
      (value) => {
        outcome = value;
      },
      (error: unknown) => {
        outcome = error;
      },
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(timerWasArmed).toBe(true);
    await vi.advanceTimersByTimeAsync(14_999);
    expect(outcome).toBe("pending");
    await vi.advanceTimersByTimeAsync(1);
    expect(outcome).toBeInstanceOf(Error);
    expect(classifyMailDeliveryError(outcome)).toEqual({
      kind: "definitely-rejected",
      code: "GMAIL_OAUTH_FAILED",
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("rejects synchronous invocation completion beyond the monotonic cutoff before timer delivery", async () => {
    let monotonicNow = 0;
    vi.spyOn(performance, "now").mockImplementation(() => monotonicNow);
    const fetchMock = vi.fn<typeof fetch>(() => {
      monotonicNow = 15_001;
      return Promise.resolve(
        new Response('{"access_token":"over-deadline-token"}', { status: 200 }),
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const harness = await createHarness();
    const entry = await armMaterialized(
      harness,
      materializeForStore(harness.store, "gmail"),
    );

    const error = await authorizeCommittedPreparedDispatch(
      harness.store,
      entry.receipt,
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(classifyMailDeliveryError(error)).toEqual({
      kind: "definitely-rejected",
      code: "GMAIL_OAUTH_FAILED",
    });
  });

  it("discards a delivery success resolved synchronously by the TX2 deadline abort", async () => {
    const fetchMock = gmailFetch();
    vi.stubGlobal("fetch", fetchMock);
    const harness = await createHarness();
    const entry = await armMaterialized(
      harness,
      materializeForStore(harness.store, "gmail"),
    );
    const guarded = await authorizeCommittedPreparedDispatch(
      harness.store,
      entry.receipt,
    );
    const tx2 = new ScriptedClient(successfulTx2Steps(entry));
    harness.pool.enqueue(tx2);
    const watchdog = await createWatchdog();
    fetchMock.mockClear();
    vi.useFakeTimers();
    fetchMock.mockImplementation(
      (_url, init) =>
        new Promise<Response>((resolve) => {
          init?.signal?.addEventListener(
            "abort",
            () => {
              resolve(
                new Response('{"id":"must-not-be-accepted"}', { status: 200 }),
              );
            },
            { once: true },
          );
        }),
    );

    const delivery = harness.store.dispatchAfterProviderBoundary(
      entry.permit,
      guarded,
      watchdog.armed,
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(20_000);
    const result = await delivery;
    expect(result).toEqual({
      kind: "applied",
      exit: {
        kind: "quarantined",
        code: "GMAIL_DELIVERY_AMBIGUOUS",
      },
    });
    vi.useRealTimers();
    await disarmSafeResult(harness.store, watchdog, result);
    tx2.assertExhausted();
    expect(tx2.releaseCalls).toEqual([false]);
  });
});
