import { describe, expect, it } from "vitest";

import { runWithValidatedRetentionOpsEnvironment } from
  "../scripts/lib/disposable-integration-environment";

type DatabaseIdentity = Readonly<{
  current_user: string;
  session_user: string;
  current_database: string;
}>;

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
          const identitySql = `
            select current_user, session_user, current_database()
          `;
          const [migrationIdentity, retentionIdentity] = await Promise.all([
            pool.query<DatabaseIdentity>(identitySql),
            integrationRetentionPool.query<DatabaseIdentity>(identitySql),
          ]);
          expect(migrationIdentity.rows[0]).toEqual({
            current_user: "learncoding_owner",
            session_user: "learncoding_migrator",
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
      async ({ databaseUrl, databaseOpsUrl }) => {
        const [{ Pool: PgPool }, retention] = await Promise.all([
          import("pg"),
          import("@/lib/data-lifecycle/retention"),
        ]);
        const ownerPool = new PgPool({
          application_name: "codestead_integration_retention_abort_owner",
          connectionString: databaseUrl,
          max: 1,
        });
        const opsPool = new PgPool({
          application_name: "codestead_integration_retention_abort_ops",
          connectionString: databaseOpsUrl,
          max: 1,
        });
        const runKey = "retention:integration:real-savepoint-abort";
        const userId = "retention-savepoint-integration-user";
        const unresolvedId = "63800000-0000-4000-8000-000000000001";
        const terminalId = "63800000-0000-4000-8000-000000000002";
        const tombstoneId = "63800000-0000-4000-8000-000000000003";
        let redactorReplaced = false;
        let checkpointObserved = false;

        try {
          await ownerPool.query(`
            begin;
            insert into public."user" (
              id, name, email, email_verified, status, created_at, updated_at
            ) values (
              '${userId}',
              'Retention Savepoint User',
              'retention-savepoint@example.invalid',
              true,
              'active',
              '2025-01-01T00:00:00Z'::timestamptz,
              '2025-01-01T00:00:00Z'::timestamptz
            );
            insert into public.email_outbox (
              id, user_id, to_email, template, template_version, variables,
              idempotency_key, operation_id, delivery_scope_key, status,
              provider_call_started, adapter, quarantined_at,
              last_error_code, created_at, updated_at
            ) values (
              '${unresolvedId}',
              '${userId}',
              'unresolved-savepoint@example.invalid',
              'weekly-summary',
              '1',
              '{"secret":"must-remain"}'::jsonb,
              'retention-savepoint-unresolved',
              '63810000-0000-4000-8000-000000000001',
              'a:${userId}',
              'quarantined',
              '2025-01-02T00:00:00Z'::timestamptz,
              'gmail',
              '2025-01-03T00:00:00Z'::timestamptz,
              'GMAIL_RESULT_UNKNOWN',
              '2025-01-01T00:00:00Z'::timestamptz,
              '2025-01-04T00:00:00Z'::timestamptz
            );
            insert into public.email_outbox (
              id, user_id, to_email, template, template_version, variables,
              idempotency_key, operation_id, delivery_scope_key, status,
              sent_at, created_at, updated_at
            ) values (
              '${terminalId}',
              '${userId}',
              'terminal-savepoint@example.invalid',
              'weekly-summary',
              '1',
              '{}'::jsonb,
              'retention-savepoint-terminal',
              '63810000-0000-4000-8000-000000000002',
              'a:${userId}',
              'sent',
              '2025-01-03T00:00:00Z'::timestamptz,
              '2025-01-01T00:00:00Z'::timestamptz,
              '2025-01-04T00:00:00Z'::timestamptz
            );
            insert into public.account_deletion_tombstone (
              id, user_id, identity_hash, policy_version,
              primary_deletion_completed_at, backup_retention_until,
              backup_status, report, created_at, updated_at
            ) values (
              '${tombstoneId}',
              '${userId}',
              '${"a".repeat(64)}',
              'retention-savepoint-integration-v1',
              '2026-07-10T00:00:00Z'::timestamptz,
              '2026-07-11T00:00:00Z'::timestamptz,
              'awaiting_retention_expiry',
              '{}'::jsonb,
              '2026-07-10T00:00:00Z'::timestamptz,
              '2026-07-10T00:00:00Z'::timestamptz
            );
            commit;
          `);
          await ownerPool.query(`
            begin;
            alter function public.redact_unresolved_email_outbox_authority(
              timestamp with time zone, integer
            ) rename to redact_unresolved_email_outbox_authority_savepoint_base;
            create function public.redact_unresolved_email_outbox_authority(
              cutoff_at timestamp with time zone,
              batch_limit integer
            ) returns table (
              disposition text,
              eligible bigint,
              transitioned bigint
            )
            language plpgsql
            security definer
            set search_path = pg_catalog
            as $abort$
            begin
              perform 1 / 0;
              return;
            end
            $abort$;
            alter function public.redact_unresolved_email_outbox_authority(
              timestamp with time zone, integer
            ) owner to learncoding_owner;
            revoke all on function
              public.redact_unresolved_email_outbox_authority(
                timestamp with time zone, integer
              )
              from public, learncoding_app, learncoding_worker,
                   learncoding_migrator, learncoding_ops;
            grant execute on function
              public.redact_unresolved_email_outbox_authority(
                timestamp with time zone, integer
              ) to learncoding_ops;
            commit;
          `);
          redactorReplaced = true;

          const report = await retention.runRetention({
            idempotencyKey: runKey,
            dryRun: false,
            batchSize: 10,
            now: new Date("2026-07-12T00:00:00.000Z"),
          }, {
            acquireClient: () => opsPool.connect(),
            processFileErasures: async ({ lifecycleRunId }) => {
              const checkpoint = await ownerPool.query<{
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
                await ownerPool.query(
                  `select id from public.email_outbox where id = $1`,
                  [terminalId],
                ),
              ).toMatchObject({ rowCount: 0 });
              expect(
                await ownerPool.query(
                  `select to_email, variables, status,
                          provider_call_started, provider_message_id
                     from public.email_outbox
                    where id = $1`,
                  [unresolvedId],
                ),
              ).toMatchObject({
                rows: [{
                  to_email: "unresolved-savepoint@example.invalid",
                  variables: { secret: "must-remain" },
                  status: "quarantined",
                  provider_call_started: expect.any(Date),
                  provider_message_id: null,
                }],
              });
              expect(
                await ownerPool.query(
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
          const persisted = await ownerPool.query<{
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
          try {
            if (redactorReplaced) {
              await ownerPool.query(`
                begin;
                drop function public.redact_unresolved_email_outbox_authority(
                  timestamp with time zone, integer
                );
                alter function
                  public.redact_unresolved_email_outbox_authority_savepoint_base(
                    timestamp with time zone, integer
                  ) rename to redact_unresolved_email_outbox_authority;
                commit;
              `);
            }
          } finally {
            await ownerPool.query(
              `begin;
               delete from public.data_lifecycle_run
                where idempotency_key = $1;
               delete from public.account_deletion_tombstone where id = $2;
               delete from public.email_outbox where id in ($3, $4);
               delete from public."user" where id = $5;
               commit;`,
              [runKey, tombstoneId, unresolvedId, terminalId, userId],
            ).catch(() => undefined);
            await Promise.all([
              ownerPool.end(),
              opsPool.end(),
            ]);
          }
        }
      },
    );
  });
});
