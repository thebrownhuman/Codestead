import { readFileSync, readdirSync } from "node:fs";
import { relative, resolve } from "node:path";

import { describe, expect, it } from "vitest";

function productionFiles(directory: string, fileNamePattern: RegExp): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      return entry.name === "__tests__" ? [] : productionFiles(path, fileNamePattern);
    }
    return entry.isFile() && fileNamePattern.test(entry.name) ? [path] : [];
  });
}

describe("production email outbox writer inventory", () => {
  it("keeps every direct writer explicit and account-scoped", () => {
    const repositoryRoot = process.cwd();
    const writers = [
      ...productionFiles(resolve(repositoryRoot, "src"), /\.[cm]?tsx?$/u),
      ...productionFiles(resolve(repositoryRoot, "scripts"), /\.(?:[cm]?tsx?|sh)$/u),
    ]
      .map((path) => ({
        path,
        relativePath: relative(repositoryRoot, path).replaceAll("\\", "/"),
        source: readFileSync(path, "utf8"),
      }))
      .filter(({ source }) =>
        /insert\s+into\s+email_outbox/iu.test(source) || source.includes(".insert(emailOutbox)"),
      )
      .sort((left, right) => left.relativePath.localeCompare(right.relativePath));

    expect(writers.map(({ relativePath }) => relativePath)).toEqual([
      "scripts/backup/common.sh",
      "src/lib/admin-credentials/service.ts",
      "src/lib/appeals/admin-service.ts",
      "src/lib/assessment-corrections/worker.ts",
      "src/lib/data-lifecycle/deletion.ts",
      "src/lib/notifications/inactivity.ts",
      "src/lib/notifications/outbox.ts",
    ]);

    for (const writer of writers.filter(({ source }) => /insert\s+into\s+email_outbox/iu.test(source))) {
      const statements = [...writer.source.matchAll(/insert into email_outbox([\s\S]*?)on conflict/giu)];
      expect(statements.length, writer.relativePath).toBeGreaterThan(0);
      for (const statement of statements) {
        expect(statement[1], writer.relativePath).toContain("delivery_scope_key");
        expect(statement[0], writer.relativePath).toMatch(
          /'a:'\s*\|\|\s*(?:\$\d+|[a-z_][a-z0-9_.]*)/iu,
        );
      }
    }

    const credentialWriter = writers.find(({ relativePath }) =>
      relativePath === "src/lib/admin-credentials/service.ts");
    expect(credentialWriter?.source).toMatch(
      /\.insert\(emailOutbox\)[\s\S]{0,300}?deliveryScopeKey:\s*`a:\$\{target\.userId\}`/u,
    );
    const centralWriter = writers.find(({ relativePath }) =>
      relativePath === "src/lib/notifications/outbox.ts");
    expect(centralWriter?.source).toContain("deliveryScopeKey: systemProducer");

    const backupStatusWriter = writers.find(({ relativePath }) =>
      relativePath === "scripts/backup/common.sh");
    expect(backupStatusWriter?.source).toMatch(
      /insert into email_outbox\s*\(\s*operation_id,\s*user_id,\s*delivery_scope_key,/iu,
    );
    expect(backupStatusWriter?.source).toMatch(
      /select\s+gen_random_uuid\(\),\s+id,\s+'a:'\s*\|\|\s*id,/iu,
    );
  });
});
