import pg, { type PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { runRetention } from "../src/lib/data-lifecycle/retention";
import {
  PostgresOutboxStore,
  type OutboxPgPool,
} from "../src/lib/notifications/postgres-outbox-store";

const { Pool } = pg;
const OLD = "2026-06-01T00:00:00.000Z";
const NOW = new Date("2026-07-25T00:00:00.000Z");
const ROW_PREFIX = "67000000-0000-4000-8000-";
const OPERATION_PREFIX = "67100000-0000-4000-8000-";
const SOURCE_PREFIX = "67200000-0000-4000-8000-";
const CLAIM_PREFIX = "67300000-0000-4000-8000-";

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for the mail retention privacy gate`);
  return value;
}

type AuthorityShape = "released" | "active" | "partial";

function fixture(
  number: number,
  adapter: "gmail" | "console",
  shape: AuthorityShape,
  receipt: "none" | "full" | "incomplete" = "none",
) {
  const suffix = String(number).padStart(12, "0");
  return {
    id: `${ROW_PREFIX}${suffix}`,
    operationId: `${OPERATION_PREFIX}${suffix}`,
    sourceId: `${SOURCE_PREFIX}${suffix}`,
    claimToken: `${CLAIM_PREFIX}${suffix}`,
    recipient: `privacy-${number}@integration.invalid`,
    adapter,
    bindingVersion: adapter === "gmail" ? "gmail-raw-v1" : "console-json-v1",
    digest: (adapter === "gmail" ? "a" : "b").repeat(64),
    shape,
    receipt,
    providerMessageId: receipt === "none" ? null : `provider-${number}`,
    sentAt: receipt === "full" ? OLD : null,
  } as const;
}

describe("mail retention privacy policy on PostgreSQL 17", () => {
  const owner = new Pool({
    connectionString: requiredEnvironment("DATABASE_URL"),
    max: 2,
  });
  const worker = new Pool({
    connectionString: requiredEnvironment("DATABASE_WORKER_URL"),
    max: 2,
  });
  const ops = new Pool({
    connectionString: requiredEnvironment("DATABASE_OPS_URL"),
    max: 1,
  });
  const store = new PostgresOutboxStore(worker as unknown as OutboxPgPool);
  const insertedIds = new Set<string>();
  const runKeys = new Set<string>();

  async function insertAuthority(row: ReturnType<typeof fixture>) {
    insertedIds.add(row.id);
    const setup = await owner.connect();
    try {
      await setup.query("BEGIN");
      await setup.query(
        `
        INSERT INTO public.email_outbox (
          id, operation_id, user_id, delivery_scope_key, to_email, template,
          template_version, variables, idempotency_key, status,
          next_attempt_at, created_at, updated_at
        ) VALUES (
          $1::uuid,
          $2::uuid,
          NULL,
          's:' || $2::uuid::text,
          $3::text,
          'access-request-admin',
          '1',
          pg_catalog.jsonb_build_object(
            '_mailOperationId', $2::uuid::text,
            '_mailRecipient', $3::text,
            '_mailProducer', 'access-request-admin',
            '_mailSourceId', $4::uuid::text
          ),
          'retention-privacy-pg17-' || $5::text,
          'pending',
          pg_catalog.statement_timestamp(),
          pg_catalog.statement_timestamp(),
          pg_catalog.statement_timestamp()
        )
        `,
        [row.id, row.operationId, row.recipient, row.sourceId, row.id],
      );
      await setup.query(
        `
        UPDATE public.email_outbox
           SET status = 'sending',
               attempt_count = 1,
               claim_token = $2::uuid,
               claim_owner = 'mail-retention-privacy-pg17',
               claim_version = 1,
               lease_expires_at = pg_catalog.statement_timestamp() + interval '120 seconds',
               last_error_code = NULL,
               updated_at = pg_catalog.statement_timestamp()
         WHERE id = $1::uuid
        `,
        [row.id, row.claimToken],
      );
      await setup.query("COMMIT");
    } catch (error) {
      await setup.query("ROLLBACK");
      throw error;
    } finally {
      setup.release();
    }

    await worker.query(
      `
      UPDATE public.email_outbox
         SET provider_call_started = pg_catalog.statement_timestamp(),
             adapter = $2::text,
             dispatch_binding_version = $3::text,
             dispatch_binding_sha256 = $4::text,
             lease_expires_at = pg_catalog.statement_timestamp() + interval '120 seconds',
             updated_at = pg_catalog.statement_timestamp()
       WHERE id = $1::uuid
      `,
      [row.id, row.adapter, row.bindingVersion, row.digest],
    );

    await owner.query(
      `
      UPDATE public.email_outbox
         SET status = 'quarantined',
             claim_version = 2,
             claim_token = CASE
               WHEN $3::text IN ('active', 'partial') THEN $2::uuid
               ELSE NULL
             END,
             claim_owner = CASE
               WHEN $3::text = 'active' THEN 'mail-retention-privacy-pg17'
               ELSE NULL
             END,
             lease_expires_at = CASE
               WHEN $3::text = 'active'
                 THEN pg_catalog.statement_timestamp() + interval '300 seconds'
               ELSE NULL
             END,
             provider_message_id = $4::text,
             sent_at = $5::timestamptz,
             quarantined_at = $6::timestamptz,
             last_error_code = 'ABANDONED_POST_PROVIDER_BOUNDARY',
             updated_at = $6::timestamptz
       WHERE id = $1::uuid
      `,
      [
        row.id,
        row.claimToken,
        row.shape,
        row.providerMessageId,
        row.sentAt,
        OLD,
      ],
    );
  }

  async function rewriteAsLegacyOpaqueScope(row: ReturnType<typeof fixture>) {
    const setup = await owner.connect();
    try {
      await setup.query("BEGIN");
      await setup.query(
        `
        ALTER TABLE public.email_outbox
          DISABLE TRIGGER email_outbox_payload_immutable
        `,
      );
      const rewritten = await setup.query(
        `
        UPDATE public.email_outbox
           SET delivery_scope_key = 'o:' || $2::uuid::text
         WHERE id = $1::uuid
        `,
        [row.id, row.operationId],
      );
      expect(rewritten.rowCount).toBe(1);
      await setup.query(
        `
        ALTER TABLE public.email_outbox
          ENABLE TRIGGER email_outbox_payload_immutable
        `,
      );
      await setup.query("COMMIT");
    } catch (error) {
      await setup.query("ROLLBACK");
      throw error;
    } finally {
      setup.release();
    }
  }

  beforeAll(async () => {
    const result = await owner.query<{ version: string }>(
      "SELECT pg_catalog.current_setting('server_version_num') AS version",
    );
    expect(Number(result.rows[0]?.version)).toBeGreaterThanOrEqual(170_000);
    expect(Number(result.rows[0]?.version)).toBeLessThan(180_000);
  });

  afterEach(async () => {
    if (insertedIds.size > 0) {
      await owner.query(
        "DELETE FROM public.email_outbox WHERE id = ANY($1::uuid[])",
        [[...insertedIds]],
      );
      insertedIds.clear();
    }
    if (runKeys.size > 0) {
      await owner.query(
        "DELETE FROM public.data_lifecycle_run WHERE idempotency_key = ANY($1::text[])",
        [[...runKeys]],
      );
      runKeys.clear();
    }
  });

  afterAll(async () => {
    await Promise.all([owner.end(), worker.end(), ops.end()]);
  });

  it("gives each current or allowed historical old quarantine one privacy disposition", async () => {
    const gmailUnresolved = fixture(320, "gmail", "released");
    const consoleReleased = fixture(321, "console", "released");
    const gmailFullReceipt = fixture(322, "gmail", "released", "full");
    const gmailIncompleteReceipt = fixture(323, "gmail", "released", "incomplete");
    const consoleActive = fixture(324, "console", "active");
    const consolePartial = fixture(325, "console", "partial");
    const legacyOpaqueScope = fixture(326, "gmail", "released");
    const gmailMalformedClaim = fixture(327, "gmail", "partial");
    await Promise.all([
      insertAuthority(gmailUnresolved),
      insertAuthority(consoleReleased),
      insertAuthority(gmailFullReceipt),
      insertAuthority(gmailIncompleteReceipt),
      insertAuthority(consoleActive),
      insertAuthority(consolePartial),
      insertAuthority(legacyOpaqueScope),
      insertAuthority(gmailMalformedClaim),
    ]);
    await rewriteAsLegacyOpaqueScope(legacyOpaqueScope);

    const idempotencyKey = "retention:privacy-pg17:2026-07-25";
    runKeys.add(idempotencyKey);
    const report = await runRetention({
      idempotencyKey,
      dryRun: false,
      batchSize: 100,
      now: NOW,
    }, {
      acquireClient: async () => await ops.connect() as unknown as PoolClient,
      processFileErasures: async () => ({
        total: 0,
        removed: 0,
        alreadyAbsent: 0,
        failed: 0,
        pending: 0,
        complete: true,
      }),
    });

    expect(report).toMatchObject({
      outcome: "completed_with_errors",
      requiresRetry: true,
      categories: {
        terminalEmailDeliveryRecords: { eligible: 1, deleted: 1 },
        nonExternalConsoleDeliveryQuarantines: { eligible: 1, deleted: 1 },
        unresolvedEmailDeliveryAuthority: { eligible: 1, transitioned: 1 },
        unresolvedEmailDeliveryAuthorityMalformed: { eligible: 1, retained: 1 },
        unclassifiedEmailDeliveryAuthorityBlocked: { eligible: 1, retained: 1 },
        unclassifiedEmailDeliveryAuthorityRepairRequired: {
          eligible: 3,
          retained: 3,
        },
      },
    });
    expect([
      "terminalEmailDeliveryRecords",
      "nonExternalConsoleDeliveryQuarantines",
      "unresolvedEmailDeliveryAuthority",
      "unresolvedEmailDeliveryAuthorityMalformed",
      "unclassifiedEmailDeliveryAuthorityBlocked",
      "unclassifiedEmailDeliveryAuthorityRepairRequired",
    ].reduce(
      (total, category) => total + (report.categories[category]?.eligible ?? 0),
      0,
    )).toBe(8);

    const rows = await owner.query<{
      id: string;
      status: string;
      to_email: string;
      delivery_scope_key: string;
      variables: Record<string, string>;
      claim_token: string | null;
      claim_owner: string | null;
      lease_expires_at: Date | null;
      provider_message_id: string | null;
      sent_at: Date | null;
    }>(
      `
      SELECT id::text, status::text, to_email, delivery_scope_key, variables,
             claim_token::text, claim_owner, lease_expires_at, provider_message_id, sent_at
        FROM public.email_outbox
       WHERE id = ANY($1::uuid[])
       ORDER BY id
      `,
      [[
        gmailUnresolved.id,
        consoleReleased.id,
        gmailFullReceipt.id,
        gmailIncompleteReceipt.id,
        consoleActive.id,
        consolePartial.id,
        legacyOpaqueScope.id,
        gmailMalformedClaim.id,
      ]],
    );
    const byId = new Map(rows.rows.map((row) => [row.id, row]));

    expect(byId.has(consoleReleased.id)).toBe(false);
    expect(byId.has(gmailFullReceipt.id)).toBe(false);
    expect(byId.get(gmailUnresolved.id)).toMatchObject({
      status: "quarantined",
      to_email: `redacted+${gmailUnresolved.id}@invalid.local`,
      provider_message_id: null,
      sent_at: null,
      claim_token: null,
      claim_owner: null,
      lease_expires_at: null,
    });
    expect(byId.get(gmailUnresolved.id)?.variables).toMatchObject({
      _mailOperationId: gmailUnresolved.operationId,
      _mailRecipient: `redacted+${gmailUnresolved.id}@invalid.local`,
      _mailProducer: "access-request-admin",
      _mailSourceId: gmailUnresolved.sourceId,
    });
    expect(byId.get(gmailIncompleteReceipt.id)).toMatchObject({
      status: "quarantined",
      to_email: gmailIncompleteReceipt.recipient,
      provider_message_id: gmailIncompleteReceipt.providerMessageId,
      sent_at: null,
    });
    expect(byId.get(legacyOpaqueScope.id)).toMatchObject({
      status: "quarantined",
      to_email: legacyOpaqueScope.recipient,
      delivery_scope_key: `o:${legacyOpaqueScope.operationId}`,
      provider_message_id: null,
      sent_at: null,
    });
    expect(byId.get(gmailMalformedClaim.id)).toMatchObject({
      status: "quarantined",
      to_email: gmailMalformedClaim.recipient,
      claim_token: gmailMalformedClaim.claimToken,
      claim_owner: null,
      lease_expires_at: null,
      provider_message_id: null,
      sent_at: null,
    });
    expect(byId.get(consoleActive.id)).toMatchObject({
      status: "quarantined",
      to_email: consoleActive.recipient,
      claim_token: consoleActive.claimToken,
      claim_owner: "mail-retention-privacy-pg17",
      lease_expires_at: expect.any(Date),
    });
    expect(byId.get(consolePartial.id)).toMatchObject({
      status: "quarantined",
      to_email: consolePartial.recipient,
      claim_token: consolePartial.claimToken,
      claim_owner: null,
      lease_expires_at: null,
    });

    const candidate = await store.findGmailReconciliationFence({
      operationId: gmailUnresolved.operationId,
    });
    expect(candidate.kind).toBe("ready");
    if (candidate.kind !== "ready") {
      throw new Error("Expected redacted Gmail authority to remain reconcilable");
    }
    await expect(store.finalizeGmailReconciliation({
      fence: candidate.fence,
      providerMessageId: "gmail-redacted-late-finalizer",
    })).resolves.toEqual({ kind: "applied" });

    const finalized = await owner.query<{
      status: string;
      to_email: string;
      provider_message_id: string | null;
      sent_at: Date | null;
      quarantined_at: Date | null;
      last_error_code: string | null;
    }>(
      `
      SELECT status::text, to_email, provider_message_id, sent_at,
             quarantined_at, last_error_code
        FROM public.email_outbox
       WHERE id = $1::uuid
      `,
      [gmailUnresolved.id],
    );
    expect(finalized.rows[0]).toMatchObject({
      status: "sent",
      to_email: `redacted+${gmailUnresolved.id}@invalid.local`,
      provider_message_id: "gmail-redacted-late-finalizer",
      sent_at: expect.any(Date),
      quarantined_at: null,
      last_error_code: null,
    });
  });
});
