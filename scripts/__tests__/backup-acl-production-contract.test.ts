import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const read = (relativePath: string) =>
  readFileSync(path.resolve(process.cwd(), relativePath), "utf8");

describe("production backup ACL contract", () => {
  it.each([
    "scripts/backup/backup.sh",
    "scripts/backup/emergency-backup.sh",
  ])("%s preserves ACLs while omitting source ownership", (file) => {
    const source = read(file);
    const dump = source.split(/\r?\n/u)
      .find((line) => line.includes("exec pg_dump"));

    expect(dump).toContain("--no-owner");
    expect(dump).not.toContain("--no-acl");
  });

  it.each([
    "scripts/backup/restore.sh",
    "scripts/backup/restore-drill-isolated.sh",
  ])("%s restores ACLs through the exact controlled owner", (file) => {
    const source = read(file);
    const restore = source.split(/\r?\n/u)
      .find((line) => line.includes("exec pg_restore"));

    expect(restore).toContain("--no-owner");
    expect(restore).toContain("--role=learncoding_owner");
    expect(restore).not.toContain("--no-acl");
    expect(source).toContain("pg_catalog.pg_authid");
    expect(source).toContain("role.rolname = 'learncoding_owner'");
    expect(source).toContain("role.role_settings_empty");
    expect(source).toContain("pg_catalog.pg_auth_members");
    expect(source).toContain("membership.inherit_option");
    expect(source).toContain("membership.set_option");
    expect(source).toContain("'learncoding_backup_reporter'");
    expect(source).toContain("role.membership_contract_exact");
  });

  it("creates the manual restore database under the controlled owner", () => {
    const source = read("scripts/backup/restore.sh");
    const create = source.split(/\r?\n/u)
      .find((line) => line.includes("'createdb "));

    expect(create).toContain("--owner=learncoding_owner");
  });

  it("documents pre-repair ACL verification and PUBLIC EXECUTE risk", () => {
    const runbook = read("docs/runbooks/backup-and-restore.md");

    expect(runbook).toContain("ACLs are preserved");
    expect(runbook).toContain("PUBLIC `EXECUTE`");
    expect(runbook).toContain("before any post-restore role reconciliation");
  });
});
