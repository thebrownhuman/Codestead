import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

import { PROTECTED_APPLICATION_TABLES } from "../../../../integration/helpers/truncate-application-tables";

const integrationRoot = resolve(process.cwd(), "integration");

function cleanupFunctionSource(path: string) {
  const source = readFileSync(path, "utf8");
  const sourceFile = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const cleanup = sourceFile.statements.find(
    (statement) =>
      ts.isFunctionDeclaration(statement) &&
      statement.name?.text === "truncateApplicationTables",
  );
  return {
    source,
    cleanup: cleanup?.getText(sourceFile) ?? null,
  };
}

describe("integration cleanup authority", () => {
  it("keeps the immutable 0065 authority and administrator guard", () => {
    expect(PROTECTED_APPLICATION_TABLES).toEqual([
      "backup_status_mail_authority",
      "backup_status_mail_admin_guard",
    ]);
  });

  it("routes every generic integration cleanup through the shared helper", () => {
    const paths = readdirSync(integrationRoot, { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isFile() && entry.name.endsWith(".integration.test.ts"),
      )
      .map((entry) => resolve(integrationRoot, entry.name));
    const cleanupFiles = paths
      .map((path) => ({ path, ...cleanupFunctionSource(path) }))
      .filter(({ cleanup }) => cleanup !== null);

    expect(cleanupFiles.length).toBeGreaterThan(30);
    for (const { path, source, cleanup } of cleanupFiles) {
      if (path.endsWith("mail-delivery-races.integration.test.ts")) {
        expect(cleanup).toContain("'backup_status_mail_authority'");
        expect(cleanup).toContain("'backup_status_mail_admin_guard'");
        continue;
      }

      expect(source).toContain('from "./helpers/truncate-application-tables"');
      expect(cleanup).toContain(
        "await truncateMutableApplicationTables(pool);",
      );
      expect(cleanup).not.toContain("information_schema.tables");
      expect(cleanup).not.toContain("TRUNCATE TABLE");
    }
  });
});
