import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const read = (relative: string) =>
  readFileSync(resolve(process.cwd(), relative), "utf8");

const bootstrap = read("scripts/bootstrap-database-roles.mjs");
const validator = read("infra/ops/validate-database-secrets.mjs");
const ceremony = read("infra/ops/create-database-secrets.sh");
const compose = read("compose.yaml");
const boundaryVerifier = read("scripts/verify-database-role-boundaries.mjs");
const entrypoint = read("infra/docker/entrypoint.sh");
const dockerfile = read("Dockerfile");
const backupCommon = read("scripts/backup/common.sh");
const secrets = read("infra/secrets/README.md");

describe("dedicated backup-status reporter role contract", () => {
  it("creates and validates one independent fixed-role credential", () => {
    expect(validator).toContain(
      'backupReporter: "learncoding_backup_reporter"',
    );
    expect(validator).toContain("databaseBackupReporterUrl");
    expect(ceremony).toContain("database_backup_reporter_url");
    expect(ceremony).toContain("backup_reporter_password");
    expect(ceremony).toContain(
      "postgresql://learncoding_backup_reporter:$backup_reporter_password@postgres:5432/learncoding",
    );
    expect(ceremony).toMatch(
      /unset[\s\S]*backup_reporter_password/u,
    );
    expect(secrets).toContain("`database_backup_reporter_url`");
    expect(secrets).toContain("`learncoding_backup_reporter`");
  });

  it("bootstraps the reporter as a no-inherit login with no table or sequence rights", () => {
    expect(bootstrap).toContain(
      'const BACKUP_REPORTER_ROLE = "learncoding_backup_reporter"',
    );
    expect(bootstrap).toContain(
      '["backupReporter", "databaseBackupReporterUrl", BACKUP_REPORTER_ROLE]',
    );
    expect(bootstrap).toContain(
      "create role learncoding_backup_reporter login",
    );
    expect(bootstrap).toMatch(
      /alter role learncoding_backup_reporter login nosuperuser nocreatedb nocreaterole\s+noinherit noreplication nobypassrls/u,
    );
    expect(bootstrap).toMatch(
      /grant connect on database %i to[\s\S]*learncoding_backup_reporter/iu,
    );
    expect(bootstrap).toMatch(
      /grant usage on schema public to[\s\S]*learncoding_backup_reporter/iu,
    );
    expect(bootstrap).toMatch(
      /revoke all on all tables in schema public from[\s\S]*learncoding_backup_reporter/iu,
    );
    expect(bootstrap).toMatch(
      /revoke all on all sequences in schema public from[\s\S]*learncoding_backup_reporter/iu,
    );
    expect(bootstrap).not.toMatch(
      /grant (?:select|insert|update|delete|truncate|references|trigger)[^\n]*learncoding_backup_reporter/iu,
    );
    expect(bootstrap).not.toMatch(
      /grant (?:usage|select|update) on (?:all )?sequences[^\n]*learncoding_backup_reporter/iu,
    );
  });

  it("reconciles only the reporter enqueue and worker predicate routines", () => {
    expect(bootstrap).toContain(
      "public.enqueue_backup_status_mail_authority(text,text)",
    );
    expect(bootstrap).toContain(
      "grant execute on function public.enqueue_backup_status_mail_authority(text, text) to learncoding_backup_reporter",
    );
    expect(bootstrap).toContain(
      "public.backup_status_mail_authorized(uuid)",
    );
    expect(bootstrap).toContain(
      "grant execute on function public.backup_status_mail_authorized(uuid) to learncoding_worker",
    );
    expect(bootstrap).toContain("routine_security_exact");
    expect(bootstrap).toContain(
      "owner_role.rolname is distinct from 'learncoding_owner'",
    );
    expect(bootstrap).toContain("p.prosecdef is distinct from true");
    expect(bootstrap).toContain("array['search_path=pg_catalog']::text[]");
    expect(boundaryVerifier).toContain(
      "public.enqueue_backup_status_mail_authority(text,text)",
    );
    expect(boundaryVerifier).toContain(
      "public.backup_status_mail_authorized(uuid)",
    );
    expect(boundaryVerifier).toContain(
      "owner_role.rolname = 'learncoding_owner'",
    );
    expect(boundaryVerifier).toContain("p.prosecdef");
    expect(boundaryVerifier).toContain("array['search_path=pg_catalog']::text[]");
    expect(boundaryVerifier).toContain("routines_exact");
  });

  it("mounts the reporter secret only into bootstrap and the one-shot reporter", () => {
    expect(compose).toContain(
      "DATABASE_BACKUP_REPORTER_URL_FILE: /run/secrets/database_backup_reporter_url",
    );
    expect(compose).toContain("source: database_backup_reporter_url");
    expect(compose).toContain("backup-status-reporter:");
    expect(compose).toMatch(/backup-status-reporter:[\s\S]*entrypoint: \[\]/u);
    expect(compose).toMatch(
      /backup-status-reporter:[\s\S]*command: \["node", "\/app\/scripts\/backup\/enqueue-backup-status\.mjs"\][\s\S]*restart: "no"/u,
    );
    expect(dockerfile).toContain(
      "scripts/backup/enqueue-backup-status.mjs ./scripts/backup/enqueue-backup-status.mjs",
    );
    expect(entrypoint).toMatch(/DATABASE_BACKUP_REPORTER_URL\s*\\/u);
  });

  it("host backup reporting invokes only the one-shot restricted service", () => {
    const functionSource = backupCommon.match(
      /enqueue_backup_status\(\) \{[\s\S]*?\n\}/u,
    )?.[0] ?? "";
    expect(functionSource).toContain("backup-status-reporter");
    expect(functionSource).toContain("BACKUP_REPORT_RUN_KEY");
    expect(functionSource).toContain("BACKUP_REPORT_OUTCOME");
    expect(functionSource).not.toContain("POSTGRES_USER");
    expect(functionSource).not.toContain("POSTGRES_PASSWORD");
    expect(functionSource).not.toContain("email_outbox");
    expect(functionSource).not.toContain("INSERT INTO");
    expect(functionSource).not.toContain("psql");
  });
});
