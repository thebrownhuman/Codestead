import { readFileSync, readdirSync } from "node:fs";
import { relative, resolve } from "node:path";

import { describe, expect, it } from "vitest";

function productionTypeScriptFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      return entry.name === "__tests__" ? [] : productionTypeScriptFiles(path);
    }
    return entry.isFile() && /\.[cm]?tsx?$/u.test(entry.name) ? [path] : [];
  });
}

describe("production email outbox writer inventory", () => {
  it("keeps every direct writer explicit and account-scoped", () => {
    const sourceRoot = resolve(process.cwd(), "src");
    const writers = productionTypeScriptFiles(sourceRoot)
      .map((path) => ({
        path,
        relativePath: relative(sourceRoot, path).replaceAll("\\", "/"),
        source: readFileSync(path, "utf8"),
      }))
      .filter(({ source }) =>
        source.includes("insert into email_outbox") || source.includes(".insert(emailOutbox)"),
      )
      .sort((left, right) => left.relativePath.localeCompare(right.relativePath));

    expect(writers.map(({ relativePath }) => relativePath)).toEqual([
      "lib/admin-credentials/service.ts",
      "lib/appeals/admin-service.ts",
      "lib/assessment-corrections/worker.ts",
      "lib/data-lifecycle/deletion.ts",
      "lib/notifications/inactivity.ts",
      "lib/notifications/outbox.ts",
    ]);

    for (const writer of writers.filter(({ source }) => source.includes("insert into email_outbox"))) {
      const statements = [...writer.source.matchAll(/insert into email_outbox([\s\S]*?)on conflict/giu)];
      expect(statements.length, writer.relativePath).toBeGreaterThan(0);
      for (const statement of statements) {
        expect(statement[1], writer.relativePath).toContain("delivery_scope_key");
        expect(statement[0], writer.relativePath).toMatch(/'a:'\s*\|\|\s*\$\d/u);
      }
    }

    const credentialWriter = writers.find(({ relativePath }) =>
      relativePath === "lib/admin-credentials/service.ts");
    expect(credentialWriter?.source).toMatch(
      /\.insert\(emailOutbox\)[\s\S]{0,300}?deliveryScopeKey:\s*`a:\$\{target\.userId\}`/u,
    );
    const centralWriter = writers.find(({ relativePath }) =>
      relativePath === "lib/notifications/outbox.ts");
    expect(centralWriter?.source).toContain("deliveryScopeKey: systemProducer");
  });
});
