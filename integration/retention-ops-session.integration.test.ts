import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { runWithValidatedRetentionOpsEnvironment } from
  "../scripts/lib/disposable-integration-environment";
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
import { inspectMailDispatchRuntime } from
  "@/lib/notifications/mail-dispatch-runtime-startup";
import { MAIL_DISPATCH_RUNTIME_BOOTSTRAP } from
  "@/lib/notifications/mail-dispatch-runtime-policy";
import { captureMailTransportConfiguration } from
  "@/lib/notifications/mailer-transport-internal";
import { outboxMessageId } from "@/lib/notifications/provider-correlation";
import { isProductionEmailTemplate } from
  "@/lib/notifications/template-authority-policy";
import type { OutboxClaim } from "@/lib/notifications/outbox-worker";
import { resetDisposableIntegrationDatabase } from
  "./support/reset-disposable-database";
import { withValidatedOwnerFaultInjection } from
  "./support/with-validated-owner-fault-injection";

type DatabaseIdentity = Readonly<{
  current_user: string;
  session_user: string;
  current_database: string;
}>;

const INTEGRATION_APPLICATION_URL = "http://localhost:3000";
const INTEGRATION_MAIL_FROM = "Codestead <mail@codestead.test>";

function fixtureIdempotencyKey(label: string) {
  return createHash("sha256")
    .update(`retention-savepoint:${label}`, "utf8")
    .digest("hex");
}

function genuineBoundaryInput(
  store: PostgresOutboxStore,
  applicationUrl: string,
  claim: OutboxClaim<EmailOutboxPayload>,
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
    adapter: "console",
    from: INTEGRATION_MAIL_FROM,
    messageId: outboxMessageId(claim.operationId),
    runtimePlan: mailDispatchPreparedRuntimePlan(store),
    transportConfiguration: captureMailTransportConfiguration("console"),
  });
  const envelope = materializedDispatchEnvelope(materialized);
  if (!envelope) throw new Error("Expected a genuine prepared envelope.");
  return Object.freeze({ adapter: "console" as const, envelope });
}

describe("retention ops-session integration", () => {
  it("runs migration-guarded retention through the disposable ops session", async () => {
    await runWithValidatedRetentionOpsEnvironment(
      process.env,
      async ({ databaseOpsUrl }) => {
        const [{ Pool: PgPool }, { pool }, { runRetention }] = await Promise.all([
          import("pg"),
          import("@/lib/db/client"),
          import("@/lib/data-lifecycle/retention"),
        ]);
        const integrationRetentionPool = new PgPool({
          application_name: "codestead_integration_retention_ops_proof",
          connectionString: databaseOpsUrl,
          max: 1,
        });
        const integrationRetentionDependencies = {
          acquireClient: () => integrationRetentionPool.connect(),
          processFileErasures: async () => ({
            total: 0,
            removed: 0,
            alreadyAbsent: 0,
            failed: 0,
            pending: 0,
            complete: true,
          }),
        } as const;

        try {
          await resetDisposableIntegrationDatabase(pool);
          const identitySql = `
            select current_user, session_user, current_database()
          `;
          const [applicationIdentity, retentionIdentity] = await Promise.all([
            pool.query<DatabaseIdentity>(identitySql),
            integrationRetentionPool.query<DatabaseIdentity>(identitySql),
          ]);
          expect(applicationIdentity.rows[0]).toEqual({
            current_user: "learncoding_app",
            session_user: "learncoding_app",
            current_database: "learncoding_integration",
          });

          expect(retentionIdentity.rows[0]).toEqual({
            current_user: "learncoding_ops",
            session_user: "learncoding_ops",
            current_database: "learncoding_integration",
          });

          const report = await runRetention({
            idempotencyKey: "retention:integration:ops-session",
            dryRun: false,
            now: new Date("2026-07-12T00:00:00.000Z"),
          }, integrationRetentionDependencies);
          expect(report).toMatchObject({
            dryRun: false,
            replayed: false,
          });
          expect(report.categories.unresolvedEmailDeliveryAuthority).toMatchObject({
            eligible: 0,
            transitioned: 0,
          });
        } finally {
          await Promise.all([
            pool.end(),
            integrationRetentionPool.end(),
          ]);
        }
      },
    );
  });

  it("recovers the retention transaction after a real redaction statement abort", async () => {
    await runWithValidatedRetentionOpsEnvironment(
      process.env,
      async ({
        databaseAppUrl,
        databaseOwnerTarget,
        databaseWorkerUrl,
        databaseOpsUrl,
      }) => {
        const [{ Pool: PgPool }, retention] = await Promise.all([
          import("pg"),
          import("@/lib/data-lifecycle/retention"),
        ]);
        const appPool = new PgPool({
          application_name: "codestead_integration_retention_abort_app",
          connectionString: databaseAppUrl,
          max: 1,
        });
        const workerPool = new PgPool({
          application_name: "codestead_integration_retention_abort_worker",
          connectionString: databaseWorkerUrl,
          max: MAIL_DISPATCH_RUNTIME_BOOTSTRAP.poolMaximumConnections,
          connectionTimeoutMillis:
            MAIL_DISPATCH_RUNTIME_BOOTSTRAP.poolAcquireTimeoutMs,
          idleTimeoutMillis:
            MAIL_DISPATCH_RUNTIME_BOOTSTRAP.poolIdleTimeoutMs,
        });
        const opsPool = new PgPool({
          application_name: "codestead_integration_retention_abort_ops",
          connectionString: databaseOpsUrl,
          max: 1,
        });
        const runKey = "retention:integration:real-savepoint-abort";
        const unresolvedUserId = "retention-savepoint-unresolved-user";
        const terminalUserId = "retention-savepoint-terminal-user";
        const unresolvedId = "63800000-0000-4000-8000-000000000001";
        const terminalId = "63800000-0000-4000-8000-000000000002";
        const tombstoneId = "63800000-0000-4000-8000-000000000003";
        const unresolvedOperationId = "63810000-0000-4000-8000-000000000001";
        const terminalOperationId = "63810000-0000-4000-8000-000000000002";
        const unresolvedClaimToken = "63820000-0000-4000-8000-000000000001";
        const terminalClaimToken = "63820000-0000-4000-8000-000000000002";
        const previousApplicationUrl = process.env.APP_URL;
        let checkpointObserved = false;

        try {
          await resetDisposableIntegrationDatabase(appPool);
          process.env.APP_URL = INTEGRATION_APPLICATION_URL;

          const appSetupClient = await appPool.connect();
          try {
            await appSetupClient.query("BEGIN");
            await appSetupClient.query(
              `insert into public."user" (
                 id, name, email, email_verified, status
               ) values
                 ($1, 'Retention Unresolved User', $2, true, 'active'),
                 ($3, 'Retention Terminal User', $4, true, 'active')`,
              [
                unresolvedUserId,
                "unresolved-savepoint@example.invalid",
                terminalUserId,
                "terminal-savepoint@example.invalid",
              ],
            );
            await appSetupClient.query(
              `insert into public.account_deletion_tombstone (
                 id, user_id, identity_hash, policy_version,
                 primary_deletion_completed_at, backup_retention_until,
                 backup_status, report, created_at, updated_at
               ) values (
                 $1::uuid, $2, $3,
                 'retention-savepoint-integration-v1',
                 pg_catalog.statement_timestamp(),
                 pg_catalog.statement_timestamp(),
                 'awaiting_retention_expiry', '{}'::jsonb,
                 pg_catalog.statement_timestamp(),
                 pg_catalog.statement_timestamp()
               )`,
              [tombstoneId, unresolvedUserId, "a".repeat(64)],
            );
            await appSetupClient.query("COMMIT");
          } catch (error) {
            await appSetupClient.query("ROLLBACK");
            throw error;
          } finally {
            appSetupClient.release();
          }

          const appClient = await appPool.connect();
          try {
            await appClient.query("BEGIN");
            for (const fixture of [
              {
                id: unresolvedId,
                operationId: unresolvedOperationId,
                userId: unresolvedUserId,
                recipient: "unresolved-savepoint@example.invalid",
                provider: "Unresolved retention provider",
                key: fixtureIdempotencyKey("unresolved"),
              },
              {
                id: terminalId,
                operationId: terminalOperationId,
                userId: terminalUserId,
                recipient: "terminal-savepoint@example.invalid",
                provider: "Terminal retention provider",
                key: fixtureIdempotencyKey("terminal"),
              },
            ] as const) {
              await appClient.query(
                `insert into public.email_outbox (
                   id, operation_id, user_id, delivery_scope_key, to_email,
                   template, template_version, variables, idempotency_key,
                   idempotency_authority_version, status, next_attempt_at
                 ) values (
                   $1::uuid, $2::uuid, $3, 'a:' || $3, $4,
                   'credential-changed', '1',
                   pg_catalog.jsonb_build_object('provider', $5::text),
                   $6, 'event-v1-native', 'pending',
                   pg_catalog.transaction_timestamp()
                 )`,
                [
                  fixture.id,
                  fixture.operationId,
                  fixture.userId,
                  fixture.recipient,
                  fixture.provider,
                  fixture.key,
                ],
              );
              const released = await appClient.query(
                `select release.release_receipt_sha256
                   from public.release_email_outbox_delivery(
                     $1::uuid,
                     $2::uuid,
                     $3::text,
                     (
                       select outbox.idempotency_original_payload_sha256
                         from public.email_outbox as outbox
                        where outbox.id = $1::uuid
                     ),
                     'task7-v1'
                   ) as release`,
                [fixture.id, fixture.operationId, fixture.key],
              );
              expect(released).toMatchObject({ rowCount: 1 });
            }
            await appClient.query("COMMIT");
          } catch (error) {
            await appClient.query("ROLLBACK");
            throw error;
          } finally {
            appClient.release();
          }

          const inspection = await inspectMailDispatchRuntime(workerPool);
          const applicationOrigin = captureMailDispatchApplicationOrigin(
            inspection,
          );
          const applicationUrl = mailDispatchApplicationUrl(applicationOrigin);
          const outboxStore = new PostgresOutboxStore(
            workerPool,
            inspection,
            applicationOrigin,
          );
          const finishFixture = async (
            expectedId: string,
            claimToken: string,
            exit:
              | Readonly<{ kind: "quarantined"; code: string }>
              | Readonly<{ kind: "failed"; code: string }>,
          ) => {
            let stage = "claim";
            try {
              const claim = await outboxStore.claimNext({
                owner: "retention-savepoint-worker",
                token: claimToken,
                leaseMs: 60_000,
              });
              expect(claim?.id).toBe(expectedId);
              if (!claim) throw new Error("Expected a released outbox claim.");
              stage = "provider-boundary";
              const boundary = await outboxStore.beginProviderCall(
                claim,
                genuineBoundaryInput(outboxStore, applicationUrl, claim),
              );
              expect(boundary.kind).toBe("applied");
              if (boundary.kind !== "applied") {
                throw new Error("Expected provider boundary authority.");
              }
              stage = "receipt-discard";
              expect(discardCommittedPreparedDispatchReceipt(
                outboxStore,
                boundary.permit,
                boundary.receipt,
              )).toBe(true);
              stage = "terminal-finish";
              await expect(
                outboxStore.finishAfterProvider(boundary.permit, exit),
              ).resolves.toEqual({ kind: "applied" });
            } catch (error) {
              throw new Error(
                `Retention fixture ${expectedId} failed during ${stage}.`,
                { cause: error },
              );
            }
          };

          await finishFixture(unresolvedId, unresolvedClaimToken, {
            kind: "quarantined",
            code: "PROVIDER_OUTCOME_UNKNOWN",
          });
          await finishFixture(terminalId, terminalClaimToken, {
            kind: "failed",
            code: "MAIL_PRE_SEND_REJECTED",
          });
          const terminalStates = await appPool.query<{
            id: string;
            status: string;
            provider_call_started: Date | null;
            adapter: string | null;
            quarantined_at: Date | null;
            last_error_code: string | null;
          }>(
            `select id::text, status::text, provider_call_started, adapter,
                    quarantined_at, last_error_code
               from public.email_outbox
              where id in ($1::uuid, $2::uuid)
              order by id`,
            [unresolvedId, terminalId],
          );
          expect(terminalStates.rows).toEqual([
            {
              id: unresolvedId,
              status: "quarantined",
              provider_call_started: expect.any(Date),
              adapter: "console",
              quarantined_at: expect.any(Date),
              last_error_code: "PROVIDER_OUTCOME_UNKNOWN",
            },
            {
              id: terminalId,
              status: "failed",
              provider_call_started: expect.any(Date),
              adapter: "console",
              quarantined_at: null,
              last_error_code: "MAIL_PRE_SEND_REJECTED",
            },
          ]);

          const report = await withValidatedOwnerFaultInjection({
            databaseTarget: databaseOwnerTarget,
            context: "Retention-redaction",
            installSql: [
              `create function public.integration_fail_retention_redaction()
               returns trigger
               language plpgsql
               set search_path = pg_catalog
               as $retention_abort$
               begin
                 if old.id = '63800000-0000-4000-8000-000000000001'::pg_catalog.uuid then
                   raise exception 'forced retention redaction failure'
                     using errcode = 'P0001';
                 end if;
                 return new;
               end
               $retention_abort$`,
              `create trigger aa_integration_fail_retention_redaction
               before update of to_email, variables on public.email_outbox
               for each row
               execute function public.integration_fail_retention_redaction()`,
            ],
            cleanupSql: [
              `drop trigger if exists aa_integration_fail_retention_redaction
                 on public.email_outbox`,
              "drop function if exists public.integration_fail_retention_redaction()",
            ],
            run: () => retention.runRetention({
            idempotencyKey: runKey,
            dryRun: false,
            batchSize: 10,
            now: new Date("2099-01-01T00:00:00.000Z"),
          }, {
            acquireClient: () => opsPool.connect(),
            processFileErasures: async ({ lifecycleRunId }) => {
              const checkpoint = await appPool.query<{
                status: string;
                report: Record<string, unknown>;
              }>(
                `select status, report
                   from public.data_lifecycle_run
                  where id = $1`,
                [lifecycleRunId],
              );
              expect(checkpoint.rows[0]).toMatchObject({
                status: "running",
                report: {
                  phase: "file_erasure_pending",
                  categories: {
                    unresolvedEmailDeliveryAuthority: {
                      outcome: "failed",
                      failureCode:
                        retention.EMAIL_OUTBOX_REDACTION_RETRYABLE,
                    },
                    terminalEmailDeliveryRecords: {
                      eligible: 1,
                      deleted: 1,
                    },
                    backupExpiryEligibility: {
                      eligible: 1,
                      transitioned: 1,
                    },
                  },
                },
              });
              expect(
                await appPool.query(
                  `select id from public.email_outbox where id = $1`,
                  [terminalId],
                ),
              ).toMatchObject({ rowCount: 0 });
              expect(
                await appPool.query(
                  `select to_email, variables, status,
                          provider_call_started, provider_message_id
                     from public.email_outbox
                    where id = $1`,
                  [unresolvedId],
                ),
              ).toMatchObject({
                rows: [{
                  to_email: "unresolved-savepoint@example.invalid",
                  variables: { provider: "Unresolved retention provider" },
                  status: "quarantined",
                  provider_call_started: expect.any(Date),
                  provider_message_id: null,
                }],
              });
              expect(
                await appPool.query(
                  `select backup_status
                     from public.account_deletion_tombstone
                    where id = $1`,
                  [tombstoneId],
                ),
              ).toMatchObject({
                rows: [{
                  backup_status: "eligible_for_operator_verification",
                }],
              });
              checkpointObserved = true;
              return {
                total: 0,
                removed: 0,
                alreadyAbsent: 0,
                failed: 0,
                pending: 0,
                complete: true,
              };
            },
          }),
          });

          expect(checkpointObserved).toBe(true);
          expect(report).toMatchObject({
            dryRun: false,
            outcome: "completed_with_errors",
            requiresRetry: true,
            replayed: false,
            objectFiles: { removed: 0, alreadyAbsent: 0, failed: 0 },
            categories: {
              unresolvedEmailDeliveryAuthority: {
                eligible: 0,
                deleted: 0,
                retained: 0,
                transitioned: 0,
                hasMore: true,
                outcome: "failed",
                failureCode: retention.EMAIL_OUTBOX_REDACTION_RETRYABLE,
              },
              unresolvedEmailDeliveryAuthorityBlocked: {
                outcome: "failed",
                failureCode: retention.EMAIL_OUTBOX_REDACTION_RETRYABLE,
              },
              unresolvedEmailDeliveryAuthorityMalformed: {
                outcome: "failed",
                failureCode: retention.EMAIL_OUTBOX_REDACTION_RETRYABLE,
              },
              terminalEmailDeliveryRecords: {
                eligible: 1,
                deleted: 1,
                retained: 0,
                hasMore: false,
              },
              backupExpiryEligibility: {
                eligible: 1,
                transitioned: 1,
                hasMore: false,
              },
            },
          });
          const persisted = await appPool.query<{
            status: string;
            error_code: string | null;
            report: Record<string, unknown>;
          }>(
            `select status, error_code, report
               from public.data_lifecycle_run
              where idempotency_key = $1`,
            [runKey],
          );
          expect(persisted.rows[0]).toEqual({
            status: "succeeded",
            error_code: retention.EMAIL_OUTBOX_REDACTION_RETRYABLE,
            report,
          });
        } finally {
          await resetDisposableIntegrationDatabase(appPool)
            .catch(() => undefined);
          if (previousApplicationUrl === undefined) delete process.env.APP_URL;
          else process.env.APP_URL = previousApplicationUrl;
          await Promise.all([
            appPool.end(),
            workerPool.end(),
            opsPool.end(),
          ]);
        }
      },
    );
  });
});
