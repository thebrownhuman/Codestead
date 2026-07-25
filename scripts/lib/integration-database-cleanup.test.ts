import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";

import {
  createIntegrationDatabaseCleaner,
  createUniqueBackupStatusRunKeyFactory,
  planIntegrationDatabaseCleanup,
  PROTECTED_INTEGRATION_TABLES,
} from "./integration-database-cleanup";

const disposableEnvironment = {
  DATABASE_URL:
    "postgresql://learncoding_app:secret@127.0.0.1:5432/learncoding_integration",
  INTEGRATION_TEST: "1",
} as const;

type Query = Pick<Pool, "query">["query"];

function queryFixture(tableNames: readonly string[]) {
  const calls: Array<Readonly<{
    text: string;
    values?: readonly unknown[];
  }>> = [];
  const query = vi.fn(async (
    text: string,
    values?: readonly unknown[],
  ) => {
    calls.push({ text, ...(values ? { values } : {}) });
    if (/information_schema\.tables/u.test(text)) {
      return {
        rows: tableNames.map((tableName) => ({ table_name: tableName })),
      };
    }
    if (/^\s*TRUNCATE TABLE/u.test(text)) {
      return { rows: [] };
    }
    throw new Error(`Unexpected cleanup fixture query: ${text}`);
  }) as unknown as Query;
  return {
    calls,
    queryable: { query } as Pick<Pool, "query">,
  };
}

async function integrationSources() {
  const integrationDirectory = path.resolve(process.cwd(), "integration");
  const names = await readdir(integrationDirectory);
  return Promise.all(
    names
      .filter((name) => name.endsWith(".integration.test.ts"))
      .map(async (name) => ({
        name,
        source: await readFile(path.join(integrationDirectory, name), "utf8"),
      })),
  );
}

describe("protected integration database cleanup", () => {
  it("freezes the complete protected-table manifest", () => {
    expect(PROTECTED_INTEGRATION_TABLES).toEqual([
      "backup_status_mail_authority",
      "backup_status_mail_admin_guard",
    ]);
  });

  it("excludes authority state and the singleton guard without cascade", () => {
    expect(planIntegrationDatabaseCleanup([
      "user",
      "backup_status_mail_admin_guard",
      "email_outbox",
      "backup_status_mail_authority",
      'quoted"name',
    ])).toBe(
      'TRUNCATE TABLE public."email_outbox", public."quoted""name", '
      + 'public."user" RESTART IDENTITY',
    );
  });

  it.each([
    {
      missing: "backup_status_mail_authority",
      tables: ["backup_status_mail_admin_guard", "user"],
    },
    {
      missing: "backup_status_mail_admin_guard",
      tables: ["backup_status_mail_authority", "user"],
    },
  ])("fails closed when $missing is absent", ({ missing, tables }) => {
    expect(() => planIntegrationDatabaseCleanup(tables))
      .toThrow(`Protected integration table manifest mismatch: missing ${missing}`);
  });

  it("queries the catalog before truncating only ordinary application tables", async () => {
    const fixture = queryFixture([
      "user",
      "backup_status_mail_authority",
      "backup_status_mail_admin_guard",
      "email_outbox",
    ]);
    const cleanup = createIntegrationDatabaseCleaner(
      fixture.queryable,
      disposableEnvironment,
    );

    await cleanup();

    expect(fixture.calls).toHaveLength(2);
    expect(fixture.calls[0]?.text).toMatch(/information_schema\.tables/u);
    expect(fixture.calls[1]?.text).toBe(
      'TRUNCATE TABLE public."email_outbox", public."user" RESTART IDENTITY',
    );
  });

  it("does not issue a mutation when the protected schema is incomplete", async () => {
    const fixture = queryFixture([
      "backup_status_mail_authority",
      "email_outbox",
    ]);
    const cleanup = createIntegrationDatabaseCleaner(
      fixture.queryable,
      disposableEnvironment,
    );

    await expect(cleanup()).rejects.toThrow(
      "Protected integration table manifest mismatch",
    );
    expect(fixture.calls).toHaveLength(1);
  });

  it.each([
    {},
    { INTEGRATION_TEST: "1" },
    {
      INTEGRATION_TEST: "1",
      DATABASE_URL: "postgresql://localhost/learncoding",
    },
    {
      INTEGRATION_TEST: "0",
      DATABASE_URL: "postgresql://localhost/learncoding_integration",
    },
  ])("refuses unsafe cleanup environment %#", async (environment) => {
    const fixture = queryFixture([
      "backup_status_mail_authority",
      "backup_status_mail_admin_guard",
      "user",
    ]);
    const cleanup = createIntegrationDatabaseCleaner(
      fixture.queryable,
      environment,
    );

    await expect(cleanup()).rejects.toThrow(
      "Integration cleanup requires the disposable learncoding_integration database",
    );
    expect(fixture.calls).toHaveLength(0);
  });

  it("allocates unique valid run keys within one persistent integration run", () => {
    const nextRunKey = createUniqueBackupStatusRunKeyFactory(
      new Date("2026-07-25T05:15:00.900Z"),
    );

    expect([
      nextRunKey(),
      nextRunKey(),
      nextRunKey(),
    ]).toEqual([
      "20260725T051500Z",
      "20260725T051501Z",
      "20260725T051502Z",
    ]);
  });

  it("requires final 0065 composition to use unique reporter run keys", async () => {
    const [migration, backupStatusIntegration] = await Promise.all([
      readFile(
        path.resolve(
          process.cwd(),
          "drizzle",
          "0065_backup_status_mail_authority.sql",
        ),
        "utf8",
      ),
      readFile(
        path.resolve(
          process.cwd(),
          "integration",
          "backup-status-outbox.integration.test.ts",
        ),
        "utf8",
      ),
    ]);
    const finalGuardCoreIsComposed =
      /CREATE TABLE "public"\."backup_status_mail_admin_guard"/u
        .test(migration);
    if (!finalGuardCoreIsComposed) {
      expect(migration).toContain(
        'CREATE TABLE "public"."backup_status_mail_authority"',
      );
      return;
    }

    expect(backupStatusIntegration).toContain(
      "createUniqueBackupStatusRunKeyFactory",
    );
    expect(backupStatusIntegration).toContain("enqueueBackupStatus");
    expect(backupStatusIntegration).not.toContain("productionOutboxSql");
    expect(backupStatusIntegration).not.toMatch(/\.repeat\(64\)/u);
  });

  it("requires all integration cleanup callers to use the shared helper", async () => {
    const sources = await integrationSources();
    const dynamicCatalogCallers = sources
      .filter(({ source }) =>
        /information_schema\.tables[\s\S]{0,200}table_type\s*=\s*['"]BASE TABLE/iu
          .test(source)
      )
      .map(({ name }) => name);
    const rawTruncateCallers = sources
      .filter(({ source }) => /\btruncate\s+table\b/iu.test(source))
      .map(({ name }) => name);
    const localSafetyWrappers = sources
      .filter(({ source }) => /function assertDisposableDatabase\(\)/u.test(source))
      .map(({ name }) => name);
    const helperCallers = sources
      .filter(({ source }) => /createIntegrationDatabaseCleaner/u.test(source));

    expect(dynamicCatalogCallers).toEqual([]);
    expect(rawTruncateCallers).toEqual([]);
    expect(localSafetyWrappers).toEqual([]);
    expect(helperCallers).toHaveLength(39);
  });
});
