import { createHash } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  captureMailDispatchApplicationOrigin,
  discardCommittedPreparedDispatchReceipt,
  mailDispatchApplicationUrl,
  mailDispatchPreparedRuntimePlan,
  PostgresOutboxStore,
  type EmailOutboxPayload,
} from "@/lib/notifications/postgres-outbox-store";
import {
  createMaterializedDispatch,
  materializedDispatchEnvelope,
} from "@/lib/notifications/guarded-prepared-dispatch";
import { inspectMailDispatchRuntime } from "@/lib/notifications/mail-dispatch-runtime-startup";
import { MAIL_DISPATCH_RUNTIME_BOOTSTRAP } from "@/lib/notifications/mail-dispatch-runtime-policy";
import { captureMailTransportConfiguration } from
  "@/lib/notifications/mailer-transport-internal";
import { outboxMessageId } from "@/lib/notifications/provider-correlation";
import { isProductionEmailTemplate } from
  "@/lib/notifications/template-authority-policy";
import type { OutboxClaim } from "@/lib/notifications/outbox-worker";

import { resetDisposableIntegrationDatabase } from "./support/reset-disposable-database";
import { withValidatedOwnerFaultInjection } from
  "./support/with-validated-owner-fault-injection";

const { Pool } = pg;
const ROW_PREFIX = "65000000-0000-4000-8000-";
const OPERATION_PREFIX = "65100000-0000-4000-8000-";
const SOURCE_PREFIX = "65200000-0000-4000-8000-";
const CLAIM_PREFIX = "65300000-0000-4000-8000-";
const INTEGRATION_MAIL_FROM = "Codestead <mail@codestead.test>";

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value)
    throw new Error(`${name} is required for the 0064 integration gate`);
  return value;
}

type DisposableDatabaseTopology = Readonly<{
  applicationUrl: string;
  opsUrl: string;
  ownerTarget: Readonly<{
    databaseApplicationUrl: string;
    databaseOwnerUrl: string;
  }>;
  workerUrl: string;
}>;

function parseDisposableRoleUrl(
  name: string,
  expectedUser: string,
  connectionString: string,
  expectedSearch: string,
) {
  let parsed: URL;
  try {
    parsed = new URL(connectionString);
  } catch {
    throw new Error(`${name} must be a valid disposable PostgreSQL URL.`);
  }
  if (
    parsed.protocol !== "postgresql:"
    || parsed.username !== expectedUser
    || parsed.password.length === 0
    || parsed.hostname !== "127.0.0.1"
    || parsed.port.length === 0
    || parsed.port === "5432"
    || parsed.pathname !== "/learncoding_integration"
    || parsed.search !== expectedSearch
    || parsed.hash !== ""
  ) {
    throw new Error(`${name} must select its exact disposable database role.`);
  }
  return parsed;
}

function validateDisposableDatabaseTopology(): DisposableDatabaseTopology {
  const canonicalApplicationUrl = requiredEnvironment("DATABASE_URL");
  const applicationUrl = requiredEnvironment("DATABASE_APP_URL");
  const workerUrl = requiredEnvironment("DATABASE_WORKER_URL");
  const opsUrl = requiredEnvironment("DATABASE_OPS_URL");
  const ownerUrl = requiredEnvironment("DATABASE_OWNER_URL");
  if (canonicalApplicationUrl !== applicationUrl) {
    throw new Error("DATABASE_URL must exactly match DATABASE_APP_URL.");
  }
  const application = parseDisposableRoleUrl(
    "DATABASE_APP_URL",
    "learncoding_app",
    applicationUrl,
    "",
  );
  const worker = parseDisposableRoleUrl(
    "DATABASE_WORKER_URL",
    "learncoding_worker",
    workerUrl,
    "",
  );
  const ops = parseDisposableRoleUrl(
    "DATABASE_OPS_URL",
    "learncoding_ops",
    opsUrl,
    "",
  );
  const owner = parseDisposableRoleUrl(
    "DATABASE_OWNER_URL",
    "learncoding_migrator",
    ownerUrl,
    "?options=-c+role%3Dlearncoding_owner",
  );
  for (const candidate of [worker, ops, owner]) {
    if (
      candidate.hostname !== application.hostname
      || candidate.port !== application.port
      || candidate.pathname !== application.pathname
    ) {
      throw new Error("0064 database roles must share one disposable target.");
    }
  }
  return Object.freeze({
    applicationUrl,
    opsUrl,
    ownerTarget: Object.freeze({
      databaseApplicationUrl: applicationUrl,
      databaseOwnerUrl: ownerUrl,
    }),
    workerUrl,
  });
}

const DISPOSABLE_DATABASES = validateDisposableDatabaseTopology();
function fixture(number: number) {
  const tail = String(number).padStart(12, "0");
  return {
    id: `${ROW_PREFIX}${tail}`,
    operationId: `${OPERATION_PREFIX}${tail}`,
    sourceId: `${SOURCE_PREFIX}${tail}`,
    claimToken: `${CLAIM_PREFIX}${tail}`,
    suffix: String(number),
    userId: `dispatch-binding-user-${number}`,
    email: `dispatch-${number}@integration.invalid`,
    idempotencyKey: createHash("sha256")
      .update(`dispatch-binding-pg17:${number}`, "utf8")
      .digest("hex"),
  } as const;
}

function armSql(
  row: ReturnType<typeof fixture>,
  input: Readonly<{
    adapter: string;
    version: string | null;
    digest: string | null;
    leaseSeconds?: number;
    extraAssignments?: readonly string[];
  }>,
) {
  const extra = input.extraAssignments?.length
    ? `${input.extraAssignments.join(",\n       ")},\n       `
    : "";
  return `
    UPDATE public.email_outbox
       SET ${extra}provider_call_started = pg_catalog.statement_timestamp(),
           adapter = $2::text,
           dispatch_binding_version = $3::text,
           dispatch_binding_sha256 = $4::text,
           provider_correlation_version = 'opaque-sha256-v1',
           provider_evidence_version = CASE
             WHEN $2::text = 'gmail' THEN 'gmail-header-evidence-v1'
             ELSE NULL
           END,
           provider_evidence_sha256 = CASE
             WHEN $2::text = 'gmail' THEN repeat('f', 64)
             ELSE NULL
           END,
           provider_request_body_sha256 = repeat('e', 64),
           provider_request_body_length = 1,
           lease_expires_at = pg_catalog.statement_timestamp()
             + ($5::integer * interval '1 second'),
           updated_at = pg_catalog.statement_timestamp()
     WHERE id = $1::uuid
  `;
}

function genuineBoundaryInput(
  store: PostgresOutboxStore,
  applicationUrl: string,
  claim: OutboxClaim<EmailOutboxPayload>,
  adapter: "console" | "gmail",
) {
  if (!isProductionEmailTemplate(claim.payload.template)) {
    throw new Error("Expected a production email template.");
  }
  const materialized = createMaterializedDispatch({
    source: {
      applicationUrl,
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
    adapter,
    from: INTEGRATION_MAIL_FROM,
    messageId: outboxMessageId(claim.operationId),
    runtimePlan: mailDispatchPreparedRuntimePlan(store),
    transportConfiguration: captureMailTransportConfiguration(adapter),
  });
  const envelope = materializedDispatchEnvelope(materialized);
  if (!envelope) throw new Error("Expected a genuine prepared envelope.");
  return Object.freeze({ adapter, envelope });
}
describe("0064 dispatch binding on production-pinned PostgreSQL 17", () => {

  const worker = new Pool({
    connectionString: DISPOSABLE_DATABASES.workerUrl,
    max: MAIL_DISPATCH_RUNTIME_BOOTSTRAP.poolMaximumConnections,
    connectionTimeoutMillis:
      MAIL_DISPATCH_RUNTIME_BOOTSTRAP.poolAcquireTimeoutMs,
    idleTimeoutMillis: MAIL_DISPATCH_RUNTIME_BOOTSTRAP.poolIdleTimeoutMs,
  });
  const application = new Pool({
    connectionString: DISPOSABLE_DATABASES.applicationUrl,
    max: 2,
  });
  const ops = new Pool({
    connectionString: DISPOSABLE_DATABASES.opsUrl,
    max: 1,
  });

  let outboxStore: PostgresOutboxStore;
  let preparedApplicationUrl: string;

  async function insertAndClaim(row: ReturnType<typeof fixture>) {
    const setupClient = await application.connect();
    try {
      await setupClient.query("BEGIN");
      await setupClient.query(
        `
        INSERT INTO public."user" (
          id, name, email, email_verified, role, status, banned,
          must_change_password
        ) VALUES (
          $1::text, $2::text, $3::text, true, 'learner', 'active', false,
          false
        )
      `,
        [row.userId, `Dispatch binding ${row.suffix}`, row.email],
      );
      await setupClient.query(
        `
        INSERT INTO public.email_outbox (
          id, operation_id, user_id, delivery_scope_key, to_email, template,
          template_version, variables, idempotency_key,
          idempotency_authority_version, status, next_attempt_at
        ) VALUES (
          $1::uuid,
          $2::uuid,
          $3::text,
          'a:' || $3::text,
          $4::text,
          'credential-changed',
          '1',
          pg_catalog.jsonb_build_object('provider', '0064 integration'),
          $5::text,
          'event-v1-native',
          'pending',
          pg_catalog.transaction_timestamp()
        )
      `,
        [
          row.id,
          row.operationId,
          row.userId,
          row.email,
          row.idempotencyKey,
        ],
      );
      await setupClient.query(
        `
        SELECT released.release_receipt_sha256
          FROM public.release_email_outbox_delivery(
            $1::uuid,
            $2::uuid,
            $3::text,
            (
              SELECT outbox.idempotency_original_payload_sha256
                FROM public.email_outbox AS outbox
               WHERE outbox.id = $1::uuid
            ),
            'task7-v1'
          ) AS released
      `,
        [row.id, row.operationId, row.idempotencyKey],
      );
      await setupClient.query("COMMIT");
    } catch (error) {
      await setupClient.query("ROLLBACK");
      throw error;
    } finally {
      setupClient.release();
    }
    const claim = await outboxStore.claimNext({
      owner: "mail-dispatch-0064-pg17",
      token: row.claimToken,
      leaseMs: 30_000,
    });
    expect(claim?.id).toBe(row.id);
    if (!claim) throw new Error("Expected a released outbox claim.");
    return claim;
  }
  async function arm(
    row: ReturnType<typeof fixture>,
    input: Parameters<typeof armSql>[1],
  ) {
    return worker.query(armSql(row, input), [
      row.id,
      input.adapter,
      input.version,
      input.digest,
      input.leaseSeconds ?? 120,
    ]);
  }

  beforeAll(async () => {
    const identity = await application.query<{
      version: string;
      effective_role: string;
      session_role: string;
    }>(`
      SELECT pg_catalog.current_setting('server_version_num') version,
             current_user::text effective_role,
             session_user::text session_role
    `);
    expect(Number(identity.rows[0]?.version)).toBeGreaterThanOrEqual(170_000);
    expect(Number(identity.rows[0]?.version)).toBeLessThan(180_000);
    expect(identity.rows[0]).toMatchObject({
      effective_role: "learncoding_app",
      session_role: "learncoding_app",
    });
    const inspection = await inspectMailDispatchRuntime(worker);
    const applicationOrigin = captureMailDispatchApplicationOrigin(inspection);
    preparedApplicationUrl = mailDispatchApplicationUrl(applicationOrigin);
    outboxStore = new PostgresOutboxStore(
      worker,
      inspection,
      applicationOrigin,
    );
  });

  beforeEach(async () => {
    await resetDisposableIntegrationDatabase(application);
  });

  afterAll(async () => {
    await Promise.all([
      worker.end(),
      application.end(),
      ops.end(),
    ]);
  });

  it("proves the exact post-migration catalog and direct ACL contract", async () => {
    const opsIdentity = await ops.query<{
      effective_role: string;
      session_role: string;
      database_name: string;
    }>(`
      SELECT current_user::text AS effective_role,
             session_user::text AS session_role,
             current_database()::text AS database_name
    `);
    expect(opsIdentity.rows).toEqual([{
      effective_role: "learncoding_ops",
      session_role: "learncoding_ops",
      database_name: "learncoding_integration",
    }]);

    const opsAuthority = await ops.query<{
      disposition: string;
      eligible: string;
      transitioned: string;
    }>(`
      SELECT disposition::text,
             eligible::text AS eligible,
             transitioned::text AS transitioned
        FROM public.redact_quarantined_email_outbox_authority_v2(
          '2000-01-01T00:00:00Z'::timestamptz,
          0
        )
       ORDER BY CASE disposition
         WHEN 'eligible' THEN 1
         WHEN 'blocked' THEN 2
         ELSE 3
       END
    `);
    expect(opsAuthority.rows).toEqual([
      { disposition: "eligible", eligible: "0", transitioned: "0" },
      { disposition: "blocked", eligible: "0", transitioned: "0" },
      { disposition: "malformed", eligible: "0", transitioned: "0" },
    ]);

    await expect(ops.query(`
      UPDATE ONLY public.email_outbox
         SET to_email = 'forbidden@integration.invalid'
       WHERE false
    `)).rejects.toMatchObject({ code: "42501" });
    const routine = await application.query<{
      owner: string;
      prosecdef: boolean;
      proconfig: string[] | null;
      grantee: string;
      privilege_type: string;
      is_grantable: boolean;
    }>(`
      SELECT pg_catalog.pg_get_userbyid(proc.proowner) owner,
             proc.prosecdef,
             proc.proconfig,
             CASE WHEN acl.grantee = 0
               THEN 'PUBLIC'
               ELSE pg_catalog.pg_get_userbyid(acl.grantee)
             END grantee,
             acl.privilege_type,
             acl.is_grantable
        FROM pg_catalog.pg_proc proc
        CROSS JOIN LATERAL pg_catalog.aclexplode(
          coalesce(
            proc.proacl,
            pg_catalog.acldefault('f', proc.proowner)
          )
        ) acl
       WHERE proc.oid =
         'public.enforce_email_outbox_dispatch_binding()'::pg_catalog.regprocedure
       ORDER BY grantee, privilege_type, is_grantable
    `);
    expect(routine.rows).toEqual([
      {
        owner: "learncoding_owner",
        prosecdef: false,
        proconfig: ["search_path=pg_catalog"],
        grantee: "learncoding_owner",
        privilege_type: "EXECUTE",
        is_grantable: false,
      },
    ]);

    const columns = await application.query<{
      name: string;
      type: string;
      not_null: boolean;
      generated: string;
      default_expression: string | null;
      grantee: string;
      privilege_type: string;
      is_grantable: boolean;
    }>(`
      SELECT attribute.attname name,
             pg_catalog.format_type(
               attribute.atttypid,
               attribute.atttypmod
             ) type,
             attribute.attnotnull not_null,
             attribute.attgenerated generated,
             pg_catalog.pg_get_expr(
               default_value.adbin,
               default_value.adrelid
             ) default_expression,
             CASE WHEN acl.grantee = 0
               THEN 'PUBLIC'
               ELSE pg_catalog.pg_get_userbyid(acl.grantee)
             END grantee,
             acl.privilege_type,
             acl.is_grantable
        FROM pg_catalog.pg_attribute attribute
        LEFT JOIN pg_catalog.pg_attrdef default_value
          ON default_value.adrelid = attribute.attrelid
         AND default_value.adnum = attribute.attnum
        CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) acl
       WHERE attribute.attrelid =
         'public.email_outbox'::pg_catalog.regclass
         AND attribute.attname IN (
           'dispatch_binding_version',
           'dispatch_binding_sha256'
         )
       ORDER BY name, grantee, privilege_type, is_grantable
    `);
    expect(columns.rows).toEqual([
      {
        name: "dispatch_binding_sha256",
        type: "text",
        not_null: false,
        generated: "",
        default_expression: null,
        grantee: "learncoding_worker",
        privilege_type: "UPDATE",
        is_grantable: false,
      },
      {
        name: "dispatch_binding_version",
        type: "text",
        not_null: false,
        generated: "",
        default_expression: null,
        grantee: "learncoding_worker",
        privilege_type: "UPDATE",
        is_grantable: false,
      },
    ]);

    const trigger = await application.query<{
      tgenabled: string;
      tgtype: number;
      tgqual: string | null;
      tgnargs: number;
      tgattr: string;
      function_name: string;
      constraint_validated: boolean;
    }>(`
      SELECT trigger.tgenabled,
             trigger.tgtype::integer,
             trigger.tgqual::text,
             trigger.tgnargs::integer,
             trigger.tgattr::text,
             function_data.proname::text function_name,
             constraint_data.convalidated constraint_validated
        FROM pg_catalog.pg_trigger trigger
        JOIN pg_catalog.pg_proc function_data
          ON function_data.oid = trigger.tgfoid
        JOIN pg_catalog.pg_constraint constraint_data
          ON constraint_data.conrelid = trigger.tgrelid
         AND constraint_data.conname =
           'email_outbox_dispatch_binding_valid'
       WHERE trigger.tgrelid =
         'public.email_outbox'::pg_catalog.regclass
         AND trigger.tgname = 'email_outbox_dispatch_binding_guard'
         AND NOT trigger.tgisinternal
    `);
    expect(trigger.rows).toEqual([
      {
        tgenabled: "A",
        tgtype: 23,
        tgqual: null,
        tgnargs: 0,
        tgattr: "",
        function_name: "enforce_email_outbox_dispatch_binding",
        constraint_validated: true,
      },
    ]);
  });

  it("accepts only exact one-shot Gmail/console arms and denies old-code shapes", async () => {
    const gmail = fixture(210);
    const consoleRow = fixture(211);
    const gmailClaim = await insertAndClaim(gmail);
    const consoleClaim = await insertAndClaim(consoleRow);
    const materializationLeases = await application.query<{
      id: string;
      lease_exact: boolean;
      provider_absent: boolean;
    }>(
      `SELECT id::text,
              lease_expires_at = updated_at + interval '30 seconds'
                AS lease_exact,
              provider_call_started IS NULL AS provider_absent
         FROM public.email_outbox
        WHERE id IN ($1::uuid, $2::uuid)
        ORDER BY id`,
      [gmail.id, consoleRow.id],
    );
    expect(materializationLeases.rows).toEqual([
      { id: gmail.id, lease_exact: true, provider_absent: true },
      { id: consoleRow.id, lease_exact: true, provider_absent: true },
    ]);

    const gmailBoundary = await outboxStore.beginProviderCall(
      gmailClaim,
      genuineBoundaryInput(
        outboxStore,
        preparedApplicationUrl,
        gmailClaim,
        "gmail",
      ),
    );
    expect(gmailBoundary.kind).toBe("applied");
    if (gmailBoundary.kind !== "applied") {
      throw new Error("Expected a Gmail provider boundary.");
    }
    expect(discardCommittedPreparedDispatchReceipt(
      outboxStore,
      gmailBoundary.permit,
      gmailBoundary.receipt,
    )).toBe(true);

    const consoleBoundary = await outboxStore.beginProviderCall(
      consoleClaim,
      genuineBoundaryInput(
        outboxStore,
        preparedApplicationUrl,
        consoleClaim,
        "console",
      ),
    );
    expect(consoleBoundary.kind).toBe("applied");
    if (consoleBoundary.kind !== "applied") {
      throw new Error("Expected a console provider boundary.");
    }
    expect(discardCommittedPreparedDispatchReceipt(
      outboxStore,
      consoleBoundary.permit,
      consoleBoundary.receipt,
    )).toBe(true);
    const readProviderBindings = () => application.query<{
      id: string;
      status: string;
      attempt_count: number;
      claim_token: string;
      claim_owner: string;
      claim_version: number;
      provider_call_started: string;
      lease_expires_at: string;
      adapter: string;
      dispatch_binding_version: string;
      dispatch_binding_sha256: string;
      provider_correlation_version: string;
      provider_evidence_version: string | null;
      provider_evidence_sha256: string | null;
      provider_request_body_sha256: string;
      provider_request_body_length: string;
      provider_message_id: string | null;
      updated_at: string;
      provider_lease_exact: boolean;
    }>(
      `SELECT id::text, status::text, attempt_count,
              claim_token::text, claim_owner, claim_version,
              provider_call_started::text, lease_expires_at::text,
              adapter, dispatch_binding_version, dispatch_binding_sha256,
              provider_correlation_version, provider_evidence_version,
              provider_evidence_sha256, provider_request_body_sha256,
              provider_request_body_length::text, provider_message_id,
              updated_at::text,
              lease_expires_at =
                provider_call_started + interval '110 seconds'
                AS provider_lease_exact
         FROM public.email_outbox
        WHERE id IN ($1::uuid, $2::uuid)
        ORDER BY id`,
      [gmail.id, consoleRow.id],
    );
    const providerBindings = await readProviderBindings();
    expect(providerBindings.rows).toMatchObject([
      {
        id: gmail.id,
        status: "sending",
        adapter: "gmail",
        dispatch_binding_version: "gmail-raw-v1",
        dispatch_binding_sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        provider_correlation_version: "opaque-sha256-v1",
        provider_evidence_version: "gmail-header-evidence-v1",
        provider_evidence_sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        provider_request_body_sha256:
          expect.stringMatching(/^[0-9a-f]{64}$/),
        provider_message_id: null,
        provider_lease_exact: true,
      },
      {
        id: consoleRow.id,
        status: "sending",
        adapter: "console",
        dispatch_binding_version: "console-json-v1",
        dispatch_binding_sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        provider_correlation_version: "opaque-sha256-v1",
        provider_evidence_version: null,
        provider_evidence_sha256: null,
        provider_request_body_sha256:
          expect.stringMatching(/^[0-9a-f]{64}$/),
        provider_message_id: null,
        provider_lease_exact: true,
      },
    ]);
    for (const [claim, adapter] of [
      [gmailClaim, "gmail"],
      [consoleClaim, "console"],
    ] as const) {
      await expect(outboxStore.beginProviderCall(
        claim,
        genuineBoundaryInput(
          outboxStore,
          preparedApplicationUrl,
          claim,
          adapter,
        ),
      )).resolves.toEqual({ kind: "lost" });
    }
    expect((await readProviderBindings()).rows).toEqual(
      providerBindings.rows,
    );

    const invalidCases = [
      ["gmail", "gmail-raw-v1", null, 30],
      ["gmail", null, "a".repeat(64), 30],
      ["gmail", "console-json-v1", "a".repeat(64), 30],
      ["console", "gmail-raw-v1", "a".repeat(64), 30],
      ["gmail", "gmail-raw-v1", "A".repeat(64), 30],
      ["gmail", "gmail-raw-v1", "g".repeat(64), 30],
      ["gmail", "gmail-raw-v1", "a".repeat(63), 30],
      ["gmail", "gmail-raw-v1", "a".repeat(65), 30],
      ["gmail", "gmail-raw-v1", "a".repeat(64), 14],
      ["gmail", "gmail-raw-v1", "a".repeat(64), 301],
    ] as const;
    for (const [index, testCase] of invalidCases.entries()) {
      const row = fixture(220 + index);
      await insertAndClaim(row);
      await expect(
        arm(row, {
          adapter: testCase[0],
          version: testCase[1],
          digest: testCase[2],
          leaseSeconds: testCase[3],
        }),
      ).rejects.toMatchObject({ code: "23514" });
    }

    const prebinding = fixture(240);
    await insertAndClaim(prebinding);
    await expect(
      worker.query(
        `
      UPDATE public.email_outbox
         SET dispatch_binding_version = 'gmail-raw-v1',
             dispatch_binding_sha256 = $2::text
       WHERE id = $1::uuid
    `,
        [prebinding.id, "a".repeat(64)],
      ),
    ).rejects.toMatchObject({
      code: "23514",
    });
  });

  it("enforces direct worker identity, state immutability, and negative privileges", async () => {
    const stateAttempt = fixture(251);
    await insertAndClaim(stateAttempt);

    await withValidatedOwnerFaultInjection({
      databaseTarget: DISPOSABLE_DATABASES.ownerTarget,
      context: "0064-dispatch-identity-probe",
      installSql: [
        `CREATE TABLE public.integration_dispatch_binding_identity_probe (
           id uuid PRIMARY KEY,
           user_id text,
           to_email text NOT NULL,
           template text NOT NULL,
           template_version text NOT NULL,
           variables jsonb NOT NULL,
           idempotency_key text NOT NULL,
           operation_id uuid NOT NULL,
           delivery_scope_key text NOT NULL,
           status text NOT NULL,
           attempt_count integer NOT NULL,
           claim_token uuid,
           claim_owner text,
           claim_version integer NOT NULL,
           lease_expires_at timestamp with time zone,
           provider_call_started timestamp with time zone,
           adapter text,
           provider_message_id text,
           dispatch_binding_version text,
           dispatch_binding_sha256 text,
           next_attempt_at timestamp with time zone NOT NULL,
           sent_at timestamp with time zone,
           quarantined_at timestamp with time zone,
           last_error_code text,
           created_at timestamp with time zone NOT NULL,
           updated_at timestamp with time zone NOT NULL
         )`,
        `CREATE TRIGGER integration_dispatch_binding_identity_probe
         BEFORE INSERT OR UPDATE
         ON public.integration_dispatch_binding_identity_probe
         FOR EACH ROW
         EXECUTE FUNCTION public.enforce_email_outbox_dispatch_binding()`,
        `GRANT SELECT, INSERT, UPDATE, DELETE
         ON TABLE public.integration_dispatch_binding_identity_probe
         TO learncoding_app`,
      ],
      cleanupSql: [
        `REVOKE ALL
         ON TABLE public.integration_dispatch_binding_identity_probe
         FROM learncoding_app`,
        "DROP TABLE IF EXISTS public.integration_dispatch_binding_identity_probe",
      ],
      run: async () => {
        const identityProbe = fixture(250);
        await application.query(
          `INSERT INTO public.integration_dispatch_binding_identity_probe (
             id, user_id, to_email, template, template_version, variables,
             idempotency_key, operation_id, delivery_scope_key, status,
             attempt_count, claim_token, claim_owner, claim_version,
             lease_expires_at, next_attempt_at, created_at, updated_at
           ) VALUES (
             $1::uuid, NULL, $2::text, 'access-request-admin', '1', '{}'::jsonb,
             $3::text, $4::uuid, 's:' || $4::uuid::text, 'sending',
             1, $5::uuid, '0064-identity-probe', 1,
             pg_catalog.statement_timestamp() + interval '300 seconds',
             pg_catalog.statement_timestamp(),
             pg_catalog.statement_timestamp(),
             pg_catalog.statement_timestamp()
           )`,
          [
            identityProbe.id,
            `dispatch-${identityProbe.suffix}@integration.invalid`,
            identityProbe.idempotencyKey,
            identityProbe.operationId,
            identityProbe.claimToken,
          ],
        );
        await expect(
          application.query(
            `UPDATE public.integration_dispatch_binding_identity_probe
                SET provider_call_started = pg_catalog.statement_timestamp(),
                    adapter = 'gmail',
                    dispatch_binding_version = 'gmail-raw-v1',
                    dispatch_binding_sha256 = $2::text,
                    lease_expires_at =
                      pg_catalog.statement_timestamp() + interval '120 seconds',
                    updated_at = pg_catalog.statement_timestamp()
              WHERE id = $1::uuid`,
            [identityProbe.id, "a".repeat(64)],
          ),
        ).rejects.toMatchObject({
          code: "42501",
          message: "email outbox dispatch arm requires worker identity",
        });
        await expect(
          application.query(
            `SELECT provider_call_started, adapter,
                    dispatch_binding_version, dispatch_binding_sha256
               FROM public.integration_dispatch_binding_identity_probe
              WHERE id = $1::uuid`,
            [identityProbe.id],
          ),
        ).resolves.toMatchObject({
          rows: [{
            provider_call_started: null,
            adapter: null,
            dispatch_binding_version: null,
            dispatch_binding_sha256: null,
          }],
        });
      },
    });
    await expect(
      arm(stateAttempt, {
        adapter: "gmail",
        version: "gmail-raw-v1",
        digest: "a".repeat(64),
        extraAssignments: ["attempt_count = attempt_count + 1"],
      }),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      worker.query(
        "UPDATE public.email_outbox SET to_email = $2 WHERE id = $1::uuid",
        [stateAttempt.id, "forbidden@integration.invalid"],
      ),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      worker.query("DELETE FROM public.email_outbox WHERE id = $1::uuid", [
        stateAttempt.id,
      ]),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      worker.query(
        `
      INSERT INTO public.email_outbox (
        operation_id, user_id, delivery_scope_key, to_email, template,
        template_version, variables, idempotency_key,
        dispatch_binding_version, dispatch_binding_sha256
      ) VALUES (
        $1::uuid, NULL, 's:' || $1::uuid::text, $2::text,
        'access-request-admin', '1',
        pg_catalog.jsonb_build_object(
          '_mailOperationId', $1::uuid::text,
          '_mailRecipient', $2::text,
          '_mailProducer', 'access-request-admin',
          '_mailSourceId', $3::uuid::text
        ),
        'dispatch-binding-pg17-worker-insert',
        NULL, NULL
      )
    `,
        [
          `${OPERATION_PREFIX}000000000298`,
          "insert-binding@integration.invalid",
          `${SOURCE_PREFIX}000000000298`,
        ],
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("rejects forged quarantine aging after a genuine provider boundary", async () => {
    const redactionRow = fixture(262);
    const redactionClaim = await insertAndClaim(redactionRow);
    const redactionBoundary = await outboxStore.beginProviderCall(
      redactionClaim,
      genuineBoundaryInput(
        outboxStore,
        preparedApplicationUrl,
        redactionClaim,
        "gmail",
      ),
    );
    expect(redactionBoundary.kind).toBe("applied");
    if (redactionBoundary.kind !== "applied") {
      throw new Error("Expected a redaction provider boundary.");
    }
    expect(discardCommittedPreparedDispatchReceipt(
      outboxStore,
      redactionBoundary.permit,
      redactionBoundary.receipt,
    )).toBe(true);
    const beforeForgery = await application.query<{
      status: string;
      to_email: string;
      dispatch_binding_version: string;
      dispatch_binding_sha256: string;
      quarantined_at: Date | null;
      updated_at: Date;
    }>(
      `SELECT status, to_email, dispatch_binding_version,
              dispatch_binding_sha256, quarantined_at, updated_at
         FROM public.email_outbox
        WHERE id = $1::uuid`,
      [redactionRow.id],
    );
    await expect(
      worker.query(
        `
        UPDATE public.email_outbox
           SET status = 'quarantined',
               claim_token = NULL,
               claim_owner = NULL,
               lease_expires_at = NULL,
               quarantined_at =
                 pg_catalog.statement_timestamp() - interval '31 days',
               last_error_code = 'GMAIL_RESULT_UNKNOWN',
               updated_at =
                 pg_catalog.statement_timestamp() - interval '31 days'
         WHERE id = $1::uuid
      `,
        [redactionRow.id],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    const afterForgery = await application.query<{
      status: string;
      to_email: string;
      dispatch_binding_version: string;
      dispatch_binding_sha256: string;
      quarantined_at: Date | null;
      updated_at: Date;
    }>(
      `SELECT status, to_email, dispatch_binding_version,
              dispatch_binding_sha256, quarantined_at, updated_at
         FROM public.email_outbox
        WHERE id = $1::uuid`,
      [redactionRow.id],
    );
    expect(afterForgery.rows).toEqual(beforeForgery.rows);
    expect(afterForgery.rows[0]).toMatchObject({
      status: "sending",
      to_email: `dispatch-${redactionRow.suffix}@integration.invalid`,
      dispatch_binding_version: "gmail-raw-v1",
      dispatch_binding_sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      quarantined_at: null,
    });
  });
});
