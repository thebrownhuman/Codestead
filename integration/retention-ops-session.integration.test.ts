import { afterAll, describe, expect, it } from "vitest";
import { Pool as PgPool } from "pg";

import { pool } from "@/lib/db/client";
import { runRetention } from "@/lib/data-lifecycle/retention";

type DatabaseIdentity = Readonly<{
  current_user: string;
  session_user: string;
}>;

const integrationRetentionPool = new PgPool({
  application_name: "codestead_integration_retention_ops_proof",
  connectionString: process.env.DATABASE_OPS_URL,
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

afterAll(async () => {
  await Promise.all([
    pool.end(),
    integrationRetentionPool.end(),
  ]);
});

describe("retention ops-session integration", () => {
  it("runs migration-guarded retention through the disposable ops session", async () => {
    const [migrationIdentity, retentionIdentity] = await Promise.all([
      pool.query<DatabaseIdentity>("select current_user, session_user"),
      integrationRetentionPool.query<DatabaseIdentity>("select current_user, session_user"),
    ]);
    expect(migrationIdentity.rows[0]).toEqual({
      current_user: "learncoding_owner",
      session_user: "learncoding_migrator",
    });
    expect(retentionIdentity.rows[0]).toEqual({
      current_user: "learncoding_ops",
      session_user: "learncoding_ops",
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
  });
});
