import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const repositoryRoot = process.cwd();
const migrationPath = resolve(
  repositoryRoot,
  "drizzle",
  "0064_mail_outbox_dispatch_binding.sql",
);
const snapshotPath = resolve(
  repositoryRoot,
  "drizzle",
  "meta",
  "0064_snapshot.json",
);
const harnessPath = resolve(
  repositoryRoot,
  "infra",
  "tests",
  "mail-dispatch-binding-0064.integration.mjs",
);
const pinnedIntegrationPath = resolve(
  repositoryRoot,
  "integration",
  "mail-dispatch-binding-0064.integration.test.ts",
);
const integrationRunnerPath = resolve(
  repositoryRoot,
  "scripts",
  "run-integration-tests.ts",
);
const migration = existsSync(migrationPath)
  ? readFileSync(migrationPath, "utf8")
  : "";
const normalizedMigration = migration.toLowerCase().replace(/\s+/gu, " ");

describe("0064 email outbox dispatch binding", () => {
  it("requires exact 0063/0064 registration once the shared ledger advances", () => {
    const journal = JSON.parse(
      readFileSync(
        resolve(repositoryRoot, "drizzle", "meta", "_journal.json"),
        "utf8",
      ),
    ) as {
      entries: Array<{
        idx: number;
        version: string;
        tag: string;
        breakpoints: boolean;
      }>;
    };
    const predecessor = journal.entries.find(({ idx }) => idx === 63);
    const binding = journal.entries.find(({ idx }) => idx === 64);
    const expectedPredecessor = {
      idx: 63,
      version: "7",
      tag: "0063_mail_outbox_redaction_fence_release",
      breakpoints: true,
    };
    const expectedBinding = {
      idx: 64,
      version: "7",
      tag: "0064_mail_outbox_dispatch_binding",
      breakpoints: true,
    };

    expect(existsSync(migrationPath)).toBe(true);
    if (predecessor === undefined && binding === undefined) {
      expect(journal.entries.at(-1)).toMatchObject({
        idx: 62,
        tag: "0062_mail_outbox_retention_redaction",
      });
      return;
    }

    // The isolated component may start at 0062, but once core registers 0063,
    // integration must atomically add the exact 0064 entry as its successor.
    expect(predecessor).toMatchObject(expectedPredecessor);
    expect(binding).toMatchObject(expectedBinding);
    expect(journal.entries.find(({ idx }) => idx === 62)).toMatchObject({
      idx: 62,
      tag: "0062_mail_outbox_retention_redaction",
    });
  });

  it("adds nullable no-default binding columns without rewriting legacy rows", () => {
    expect(normalizedMigration).toContain(
      'add column "dispatch_binding_version" text',
    );
    expect(normalizedMigration).toContain(
      'add column "dispatch_binding_sha256" text',
    );
    expect(normalizedMigration).not.toMatch(
      /dispatch_binding_(?:version|sha256)" text (?:not null|default)/u,
    );
    expect(normalizedMigration).not.toMatch(
      /update public\.email_outbox set dispatch_binding_/u,
    );
    expect(normalizedMigration).not.toContain("raw_mime");
    expect(normalizedMigration).not.toContain("oauth_token");
  });

  it("locks and rejects malformed predecessor provider state before DDL", () => {
    const lockIndex = normalizedMigration.indexOf(
      "lock table public.email_outbox in access exclusive mode",
    );
    const preflightIndex = normalizedMigration.indexOf(
      "email outbox provider state is invalid before dispatch binding migration",
    );
    const addColumnIndex = normalizedMigration.indexOf(
      'add column "dispatch_binding_version"',
    );

    expect(lockIndex).toBeGreaterThanOrEqual(0);
    expect(preflightIndex).toBeGreaterThan(lockIndex);
    expect(addColumnIndex).toBeGreaterThan(preflightIndex);
    expect(normalizedMigration).toContain(
      "provider_call_started is null and (adapter is not null or provider_message_id is not null)",
    );
    expect(normalizedMigration).toContain(
      "provider_call_started is not null and (adapter is null or adapter not in ('gmail', 'console'))",
    );
    expect(normalizedMigration).toContain(
      "status not in ('sending', 'sent', 'failed', 'quarantined')",
    );
    expect(normalizedMigration).toContain("errcode = '23514'");
  });

  it("validates the exact legacy-or-bound structural contract", () => {
    expect(normalizedMigration).toContain(
      'constraint "email_outbox_dispatch_binding_valid"',
    );
    expect(normalizedMigration).toContain(
      "validate constraint email_outbox_dispatch_binding_valid",
    );
    expect(normalizedMigration).toContain(
      "dispatch_binding_version = 'gmail-raw-v1'",
    );
    expect(normalizedMigration).toContain(
      "dispatch_binding_version = 'console-json-v1'",
    );
    expect(normalizedMigration).toContain(
      "dispatch_binding_sha256 ~ '^[0-9a-f]{64}$'",
    );
    expect(normalizedMigration).toContain(
      "provider_call_started is not null and status in ('sending', 'sent', 'failed', 'quarantined')",
    );
  });

  it("uses a separate global invoker trigger for the one legal arm transition", () => {
    expect(normalizedMigration).toContain(
      'create function "public"."enforce_email_outbox_dispatch_binding"()',
    );
    expect(normalizedMigration).toContain("security invoker");
    expect(normalizedMigration).toContain("set search_path = pg_catalog");
    expect(normalizedMigration).toContain(
      'create trigger "email_outbox_dispatch_binding_guard" before insert or update on public.email_outbox',
    );
    expect(normalizedMigration).not.toContain(
      'create trigger "email_outbox_dispatch_binding_guard" before insert or update of',
    );
    expect(normalizedMigration).toContain(
      "current_user <> 'learncoding_worker' or session_user <> 'learncoding_worker'",
    );
    expect(normalizedMigration).toContain("errcode = '42501'");
    expect(normalizedMigration).toContain("old.status = 'sending'");
    expect(normalizedMigration).toContain("new.status = 'sending'");
    expect(normalizedMigration).toContain(
      "old.lease_expires_at > pg_catalog.statement_timestamp()",
    );
    expect(normalizedMigration).toContain(
      "new.lease_expires_at >= pg_catalog.statement_timestamp() + interval '15 seconds'",
    );
    expect(normalizedMigration).toContain(
      "new.lease_expires_at <= pg_catalog.statement_timestamp() + interval '300 seconds'",
    );
    expect(normalizedMigration).toContain(
      "new.provider_call_started = pg_catalog.statement_timestamp()",
    );
  });

  it("owns and seals the trigger function and grants only worker column update", () => {
    expect(normalizedMigration).toContain(
      'alter function "public"."enforce_email_outbox_dispatch_binding"() owner to learncoding_owner',
    );
    expect(normalizedMigration).toContain(
      'revoke all on function "public"."enforce_email_outbox_dispatch_binding"() from public, learncoding_app, learncoding_worker, learncoding_migrator, learncoding_ops, learncoding_owner',
    );
    expect(normalizedMigration).toContain(
      'grant execute on function "public"."enforce_email_outbox_dispatch_binding"() to learncoding_owner',
    );
    expect(normalizedMigration).toContain(
      "revoke all ( dispatch_binding_version, dispatch_binding_sha256 ) on table public.email_outbox from public, learncoding_app, learncoding_worker, learncoding_migrator, learncoding_ops",
    );
    expect(normalizedMigration).toContain(
      "grant update ( dispatch_binding_version, dispatch_binding_sha256 ) on table public.email_outbox to learncoding_worker",
    );
    expect(normalizedMigration).not.toMatch(
      /grant insert \([^)]*dispatch_binding_/u,
    );
  });

  it("updates the Drizzle schema and descends from structural snapshot 0060", () => {
    const schema = readFileSync(
      resolve(repositoryRoot, "src", "lib", "db", "schema.ts"),
      "utf8",
    );
    const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8")) as {
      id: string;
      prevId: string;
      tables: {
        "public.email_outbox": {
          columns: Record<string, {
            type: string;
            notNull: boolean;
            default?: unknown;
          }>;
          checkConstraints: Record<string, { value: string }>;
        };
      };
    };

    expect(schema).toContain(
      'dispatchBindingVersion: text("dispatch_binding_version")',
    );
    expect(schema).toContain(
      'dispatchBindingSha256: text("dispatch_binding_sha256")',
    );
    expect(schema).toContain('"email_outbox_dispatch_binding_valid"');
    expect(snapshot.prevId).toBe(
      "d2a68a3d-c790-4f56-b83e-7c7ba0eb6d68",
    );
    expect(snapshot.id).not.toBe(snapshot.prevId);
    for (const columnName of [
      "dispatch_binding_version",
      "dispatch_binding_sha256",
    ]) {
      expect(snapshot.tables["public.email_outbox"].columns[columnName]).toEqual({
        name: columnName,
        type: "text",
        primaryKey: false,
        notNull: false,
      });
    }
    expect(
      snapshot.tables["public.email_outbox"].checkConstraints
        .email_outbox_dispatch_binding_valid.value,
    ).toContain("gmail-raw-v1");
  });

  it("covers production-pinned PostgreSQL 17 and targeted PostgreSQL 18", () => {
    expect(existsSync(harnessPath)).toBe(true);
    expect(existsSync(pinnedIntegrationPath)).toBe(true);
    const harness = readFileSync(harnessPath, "utf8");
    const pinnedIntegration = readFileSync(pinnedIntegrationPath, "utf8");
    const integrationRunner = readFileSync(integrationRunnerPath, "utf8");
    expect(harness).toContain("POSTGRES_MAJOR");
    expect(harness).toContain("POSTGRES_BIN");
    expect(harness).toContain("/^18$/u");
    expect(harness).toContain("0063_mail_outbox_redaction_fence_release");
    expect(harness).toContain("0064_mail_outbox_dispatch_binding");
    expect(pinnedIntegration).toContain(
      "0064 dispatch binding on production-pinned PostgreSQL 17",
    );
    expect(pinnedIntegration).toContain("DATABASE_WORKER_URL");
    expect(pinnedIntegration).toContain("DATABASE_OPS_URL");
    expect(integrationRunner).toContain(
      "postgres:17-alpine@sha256:742f40ea20b9ff2ff31db5458d127452988a2164df9e17441e191f3b72252193",
    );
    expect(harness).toContain("migration_rollback:pass");
    expect(harness).toContain("legacy_grandfather:pass");
    expect(harness).toContain("transition_matrix:pass");
    expect(harness).toContain("catalog_contract:pass");
    expect(harness).toContain("privilege_contract:pass");
    expect(harness).toContain("migration_replay:pass");
  });
});
