import { readFileSync, readdirSync } from "node:fs";
import { relative, resolve } from "node:path";

import { describe, expect, it } from "vitest";

function productionTypeScriptFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      return entry.name === "__tests__"
        ? []
        : productionTypeScriptFiles(path);
    }
    return entry.isFile()
      && /\.[cm]?[jt]sx?$/u.test(entry.name)
      && !/\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(entry.name)
      ? [path]
      : [];
  });
}

describe("provider-correlation recovery import boundary", () => {
  it("keeps the legacy raw Message-ID formatter reachable only by Gmail reconciliation", () => {
    const repositoryRoot = process.cwd();
    const sources = [
      ...productionTypeScriptFiles(resolve(repositoryRoot, "src")),
      ...productionTypeScriptFiles(resolve(repositoryRoot, "scripts")),
    ].map((path) => ({
      path: relative(repositoryRoot, path).replaceAll("\\", "/"),
      source: readFileSync(path, "utf8"),
    }));

    expect(sources
      .filter(({ source }) =>
        source.includes("provider-correlation-reconciliation-internal"))
      .map(({ path }) => path)
      .sort()).toEqual([
      "src/lib/notifications/gmail-reconciliation.ts",
    ]);

    expect(sources
      .filter(({ source }) => source.includes("<codestead.outbox.${"))
      .map(({ path }) => path)
      .sort()).toEqual([
      "src/lib/notifications/provider-correlation-reconciliation-internal.ts",
    ]);
  });
});
