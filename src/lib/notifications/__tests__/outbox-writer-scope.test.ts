import { readFileSync, readdirSync } from "node:fs";
import { relative, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const DIRECT_OUTBOX_INSERT =
  /insert\s+into\s+(?:(?:"public"|public)\s*\.\s*)?(?:"email_outbox"|email_outbox\b)/iu;
const PRODUCTION_SOURCE_FILE = /\.(?:[cm]?[jt]sx?|sh)$/u;
const TEST_PATH =
  /(?:^|\/)(?:__fixtures__|__tests__|fixtures|test|tests)(?:\/|$)|\.(?:spec|test)\.[^/]+$/iu;

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
      ...productionFiles(resolve(repositoryRoot, "src"), PRODUCTION_SOURCE_FILE),
      ...productionFiles(resolve(repositoryRoot, "scripts"), PRODUCTION_SOURCE_FILE),
    ]
      .map((path) => ({
        path,
        relativePath: relative(repositoryRoot, path).replaceAll("\\", "/"),
        source: readFileSync(path, "utf8"),
      }))
      .filter(({ relativePath }) => !TEST_PATH.test(relativePath))
      .filter(({ source }) =>
        DIRECT_OUTBOX_INSERT.test(source) || source.includes(".insert(emailOutbox)"),
      )
      .sort((left, right) => left.relativePath.localeCompare(right.relativePath));

    expect(writers.map(({ relativePath }) => relativePath)).toEqual([

      "src/lib/appeals/admin-service.ts",
      "src/lib/assessment-corrections/worker.ts",
      "src/lib/data-lifecycle/deletion.ts",
      "src/lib/notifications/inactivity.ts",
      "src/lib/notifications/outbox.ts",
    ]);

    for (const writer of writers.filter(({ source }) => DIRECT_OUTBOX_INSERT.test(source))) {
      const statements = [
        ...writer.source.matchAll(
          /insert into\s+(?:(?:"public"|public)\s*\.\s*)?(?:"email_outbox"|email_outbox\b)([\s\S]*?)on conflict/giu,
        ),
      ];
      expect(statements.length, writer.relativePath).toBeGreaterThan(0);
      for (const statement of statements) {
        expect(statement[1], writer.relativePath).toContain("delivery_scope_key");
        if (writer.relativePath !== "src/lib/notifications/outbox.ts") {
          expect(statement[0], writer.relativePath).toMatch(
            /'a:'\s*\|\|\s*(?:\$\d+|[a-z_][a-z0-9_.]*)/iu,
          );
        }
      }
    }

    const credentialSource = readFileSync(
      resolve(repositoryRoot, "src/lib/admin-credentials/service.ts"),
      "utf8",
    );
    expect(credentialSource).not.toMatch(DIRECT_OUTBOX_INSERT);
    expect(credentialSource).not.toContain(".insert(emailOutbox)");
    expect(credentialSource).toMatch(
      /await enqueueEmailInTransaction\(tx,\s*\{/u,
    );
    const centralWriter = writers.find(({ relativePath }) =>
      relativePath === "src/lib/notifications/outbox.ts");
    expect(centralWriter?.source).toContain("deliveryScopeKey: systemProducer");
    expect(centralWriter?.source).toContain(
      ": `a:${accountInput!.userId}`",
    );
    expect(centralWriter?.source).toContain("${row.deliveryScopeKey}");

    const backupShell = readFileSync(
      resolve(repositoryRoot, "scripts/backup/common.sh"),
      "utf8",
    );
    const backupStatusReporter = readFileSync(
      resolve(repositoryRoot, "scripts/backup/enqueue-backup-status.mjs"),
      "utf8",
    );
    expect(backupShell).not.toMatch(DIRECT_OUTBOX_INSERT);
    expect(backupStatusReporter).not.toMatch(DIRECT_OUTBOX_INSERT);
    expect(backupStatusReporter).toContain(
      "from public.enqueue_backup_status_mail_authority($1::text, $2::text)",
    );
  });
});
