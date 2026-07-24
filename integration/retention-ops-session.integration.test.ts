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
});
