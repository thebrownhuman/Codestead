import { createHash } from "node:crypto";
import { renameSync, rmSync, symlinkSync } from "node:fs";
import { link, mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { verifyOrApplyDeterministicEvidence } from "./deterministic-evidence";

const repositoryRoot = process.cwd();
const temporaryDirectories: string[] = [];
const timestamp = "2026-07-22T05:00:00.000Z";
const laterTimestamp = "2026-07-22T06:00:00.000Z";
const relativePath = "docs/evidence/deterministic-evidence-test.json";
const verifierScripts = [
  "scripts/verify-api-auth-surface.ts",
  "scripts/verify-import-boundaries.ts",
  "scripts/verify-ai-code-tasks.ts",
  "scripts/verify-c-cpp-executable-tranche.ts",
  "scripts/verify-dsa-language-parity.ts",
  "scripts/verify-java-python-code-tasks.ts",
  "scripts/verify-web-executable-tranche.ts",
] as const;

function buildEvidence(generatedAt: string) {
  return { schemaVersion: 1, generatedAt, value: "current" };
}

function bytes(generatedAt: string): string {
  return `${JSON.stringify(buildEvidence(generatedAt), null, 2)}\n`;
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "codestead-deterministic-evidence-"));
  temporaryDirectories.push(root);
  const evidenceRoot = path.join(root, "docs", "evidence");
  await mkdir(evidenceRoot, { recursive: true });
  const target = path.join(root, relativePath);
  return { root, evidenceRoot, target };
}

function options(root: string, argv: readonly string[] = []) {
  return {
    root,
    argv,
    relativePath,
    buildEvidence,
    applyCommand: "npm run evidence:test -- --apply",
    trustedDirectory: "exclusive-writer",
  } as const;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, {
    recursive: true,
    force: true,
  })));
});

describe("deterministic evidence check/apply contract", () => {
  it.each([
    { argv: [] as readonly string[] },
    { argv: ["--check"] as readonly string[] },
  ])("keeps matching evidence bytes and mtime unchanged for argv=$argv", async ({ argv }) => {
    const setup = await fixture();
    const original = bytes(timestamp);
    await writeFile(setup.target, original, "utf8");
    const fixedTime = new Date("2026-07-22T04:00:00.000Z");
    await utimes(setup.target, fixedTime, fixedTime);
    const before = await stat(setup.target);

    const result = await verifyOrApplyDeterministicEvidence(options(setup.root, argv));

    const after = await stat(setup.target);
    expect(result).toEqual({ mode: "check", target: setup.target });
    expect(await readFile(setup.target, "utf8")).toBe(original);
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });

  it("fails closed without modifying stale, malformed, invalid-timestamp, or missing evidence", async () => {
    const setup = await fixture();
    const cases = [
      { name: "stale", value: `${JSON.stringify({ ...buildEvidence(timestamp), value: "old" }, null, 2)}\n`, error: /stale evidence artifact.*--apply/is },
      { name: "malformed", value: "{not-json\n", error: /malformed evidence artifact.*--apply/is },
      { name: "invalid timestamp", value: `${JSON.stringify(buildEvidence("2026-07-22"), null, 2)}\n`, error: /invalid generatedAt.*--apply/is },
    ];
    for (const testCase of cases) {
      await writeFile(setup.target, testCase.value, "utf8");
      const before = sha256(await readFile(setup.target, "utf8"));
      await expect(verifyOrApplyDeterministicEvidence(options(setup.root))).rejects.toThrow(testCase.error);
      expect(sha256(await readFile(setup.target, "utf8")), testCase.name).toBe(before);
    }
    await rm(setup.target);
    await expect(verifyOrApplyDeterministicEvidence(options(setup.root))).rejects.toThrow(/missing evidence artifact.*--apply/is);
    await expect(stat(setup.target)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("requires the caller to assert an exclusive trusted evidence directory before apply", async () => {
    const setup = await fixture();
    await writeFile(setup.target, bytes(timestamp), "utf8");
    await expect(verifyOrApplyDeterministicEvidence({
      ...options(setup.root, ["--apply"]),
      trustedDirectory: undefined as never,
    })).rejects.toThrow(/exclusive trusted evidence directory/i);
  });

  it("writes atomically only in apply mode and changes the timestamp only on an intentional apply", async () => {
    const setup = await fixture();
    await writeFile(setup.target, bytes(timestamp), "utf8");

    const first = await verifyOrApplyDeterministicEvidence({
      ...options(setup.root, ["--apply"]),
      now: () => new Date(laterTimestamp),
    });

    expect(first).toEqual({ mode: "apply", target: setup.target });
    expect(await readFile(setup.target, "utf8")).toBe(bytes(laterTimestamp));
    expect((await readdir(setup.evidenceRoot)).filter((file) => file.includes(".staging-"))).toEqual([]);
    await verifyOrApplyDeterministicEvidence(options(setup.root, ["--check"]));
  });

  it("rejects ambiguous, duplicate, unknown, and unsafe output arguments", async () => {
    const setup = await fixture();
    await writeFile(setup.target, bytes(timestamp), "utf8");
    const invalid = [
      ["--apply", "--check"],
      ["--apply", "--apply"],
      ["--check", "--check"],
      ["--unknown"],
      ["--output=docs/evidence/other.json"],
    ];
    for (const argv of invalid) {
      await expect(verifyOrApplyDeterministicEvidence(options(setup.root, argv))).rejects.toThrow();
    }

    const outside = path.join(setup.root, "outside.json");
    await expect(verifyOrApplyDeterministicEvidence({
      ...options(setup.root, ["--apply", `--output=${outside}`]),
      allowOutputOverride: true,
    })).rejects.toThrow(/direct \.json child of docs\/evidence/i);

    const output = "docs/evidence/other.json";
    await verifyOrApplyDeterministicEvidence({
      ...options(setup.root, ["--apply", `--output=${output}`]),
      allowOutputOverride: true,
      now: () => new Date(timestamp),
    });
    expect(await readFile(path.join(setup.root, output), "utf8")).toBe(bytes(timestamp));
  });

  it("rejects hard-linked evidence targets", async () => {
    const setup = await fixture();
    await writeFile(setup.target, bytes(timestamp), "utf8");
    await link(setup.target, path.join(setup.evidenceRoot, "alias.json"));

    await expect(verifyOrApplyDeterministicEvidence(options(setup.root))).rejects.toThrow(/single-link regular file/i);
  });

  it("rejects an evidence-directory swap before apply without writing through it", async () => {
    const setup = await fixture();
    await writeFile(setup.target, bytes(timestamp), "utf8");
    const originalEvidenceRoot = `${setup.evidenceRoot}-original`;
    const outside = path.join(setup.root, "outside");
    await mkdir(outside);
    let swapped = false;
    try {
      await expect(verifyOrApplyDeterministicEvidence({
        ...options(setup.root, ["--apply"]),
        buildEvidence: (generatedAt) => {
          renameSync(setup.evidenceRoot, originalEvidenceRoot);
          symlinkSync(outside, setup.evidenceRoot, "junction");
          swapped = true;
          return buildEvidence(generatedAt);
        },
        now: () => new Date(laterTimestamp),
      })).rejects.toThrow(/evidence directory changed/i);
      await expect(stat(path.join(outside, path.basename(setup.target)))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      if (swapped) {
        rmSync(setup.evidenceRoot, { recursive: true, force: true });
        renameSync(originalEvidenceRoot, setup.evidenceRoot);
      }
    }
  });

  it("permits only explicitly delegated verifier-specific arguments", async () => {
    const setup = await fixture();
    await writeFile(setup.target, bytes(timestamp), "utf8");
    await verifyOrApplyDeterministicEvidence({
      ...options(setup.root, ["--check", "--structure-only", "--limit=2"]),
      allowArgument: (argument) => argument === "--structure-only" || /^--limit=[1-9]\d*$/.test(argument),
    });
    for (const invalid of ["--workers=2", "--limit=2junk", "--limit=2=extra", "--limit=0"]) {
      await expect(verifyOrApplyDeterministicEvidence({
        ...options(setup.root, ["--check", invalid]),
        allowArgument: (argument) => argument === "--structure-only" || /^--limit=[1-9]\d*$/.test(argument),
      })).rejects.toThrow(/supported arguments/i);
    }
  });

  it("routes all seven generators through the helper without direct volatile evidence writes", async () => {
    for (const relative of verifierScripts) {
      const source = await readFile(path.join(repositoryRoot, relative), "utf8");
      expect(source.match(/verifyOrApplyDeterministicEvidence/g)?.length, relative).toBeGreaterThanOrEqual(2);
      expect(source, relative).not.toMatch(/generatedAt:\s*new Date\(\)\.toISOString\(\)/);
      expect(source, relative).not.toMatch(/await writeFile\(reportPath/);
      expect(source, relative).not.toMatch(/argument\.startsWith\("--(?:limit|workers)="\)/);
      expect(source, relative).toContain('trustedDirectory: "exclusive-writer"');
    }
    const helperSource = await readFile(path.join(repositoryRoot, "scripts/lib/deterministic-evidence.ts"), "utf8");
    expect(helperSource).toMatch(/await stagingHandle\.sync\(\)/);
    expect(helperSource).toMatch(/sameIdentity\(stagingIdentity, afterRename\)/);
    const packageJson = JSON.parse(await readFile(path.join(repositoryRoot, "package.json"), "utf8")) as {
      readonly scripts: Readonly<Record<string, string>>;
    };
    for (const script of [
      "security:api-surface",
      "architecture:check",
      "dsa:parity:check",
      "c-cpp:executable:check",
      "java-python:executable:check",
      "ai-code:executable:check",
      "web:executable:check",
    ]) {
      expect(packageJson.scripts[script], script).toMatch(/(?:^|\s)--check(?:\s|$)/);
    }
    const applyScripts = [
      "security:api-surface:apply",
      "architecture:apply",
      "dsa:parity:structure:apply",
      "dsa:parity:evidence:apply",
      "c-cpp:executable:structure:apply",
      "c-cpp:executable:evidence:apply",
      "java-python:executable:structure:apply",
      "java-python:executable:evidence:apply",
      "ai-code:executable:structure:apply",
      "ai-code:executable:evidence:apply",
      "web:executable:structure:apply",
      "web:executable:evidence:apply",
    ] as const;
    const verifierSources = await Promise.all(verifierScripts.map((relative) =>
      readFile(path.join(repositoryRoot, relative), "utf8"),
    ));
    const combinedVerifierSources = verifierSources.join("\n");
    for (const script of applyScripts) {
      expect(packageJson.scripts[script], script).toMatch(/(?:^|\s)--apply(?:\s|$)/);
      expect(packageJson.scripts[script], script).not.toMatch(/(?:^|\s)--check(?:\s|$)/);
      expect(combinedVerifierSources, script).toContain(`npm run ${script}`);
    }
  });
});
