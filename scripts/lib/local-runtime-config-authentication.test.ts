import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runCurriculumRuntimePinSync } from "../sync-curriculum-runtime-pins";
import {
  parseDockerArchiveConfigPath,
  validateLocalRuntimeIdentity,
  verifyDockerArchiveConfigBytes,
  type InspectLocalRuntimeImage,
  type LocalRuntimeLanguage,
  type ResolveLocalRuntimeConfigDigest,
} from "./local-runtime-identity";

const sha = (character: string) => `sha256:${character.repeat(64)}`;
const languages = ["c", "cpp", "java", "javascript", "python"] as const;
const manifests = { c: sha("a"), cpp: sha("b"), java: sha("c"), javascript: sha("d"), python: sha("e") } as const;
const configs = { c: sha("f"), cpp: sha("1"), java: sha("2"), javascript: sha("3"), python: sha("4") } as const;

function tag(language: LocalRuntimeLanguage): string {
  return `learncoding/runtime-${language}:local`;
}
function reference(language: LocalRuntimeLanguage): string {
  return `learncoding/runtime-${language}@${manifests[language]}`;
}
function records(forgedConfig = false) {
  return languages.map((language) => ({
    id: language,
    tag: tag(language),
    manifestDigest: manifests[language],
    configDigest: forgedConfig && language === "c" ? sha("9") : configs[language],
    reference: reference(language),
  }));
}
function inspection(language: LocalRuntimeLanguage) {
  return {
    Id: manifests[language],
    Descriptor: { digest: manifests[language] },
    RepoTags: [tag(language)],
    RepoDigests: [reference(language)],
  };
}
const inspectImage: InspectLocalRuntimeImage = (requested) => {
  const language = languages.find((candidate) => requested === tag(candidate) || requested === reference(candidate));
  if (!language) throw new Error(`unexpected image lookup ${requested}`);
  return inspection(language);
};
const resolveConfigDigest: ResolveLocalRuntimeConfigDigest = (requested) => {
  const language = languages.find((candidate) => requested === reference(candidate));
  if (!language) throw new Error(`unexpected archive lookup ${requested}`);
  return configs[language];
};

describe("Docker archive config authentication", () => {
  it("accepts one safe Docker archive config path and authenticates its exact bytes", () => {
    const bytes = Buffer.from('{"architecture":"amd64","config":{},"os":"linux"}');
    const expected = createHash("sha256").update(bytes).digest("hex");
    const configPath = `${expected}.json`;
    expect(parseDockerArchiveConfigPath([{ Config: configPath, RepoTags: null, Layers: [] }])).toBe(configPath);
    expect(verifyDockerArchiveConfigBytes(configPath, bytes)).toBe(`sha256:${expected}`);
  });

  it("accepts the Docker 29 OCI-layout config path and authenticates its exact bytes", () => {
    const bytes = Buffer.from('{"architecture":"amd64","config":{},"os":"linux"}');
    const expected = createHash("sha256").update(bytes).digest("hex");
    const configPath = `blobs/sha256/${expected}`;
    expect(parseDockerArchiveConfigPath([{ Config: configPath, RepoTags: null, Layers: [] }])).toBe(configPath);
    expect(verifyDockerArchiveConfigBytes(configPath, bytes)).toBe(`sha256:${expected}`);
  });
  it.each([
    ["path traversal", [{ Config: "../escape.json", RepoTags: null, Layers: [] }], /safe sha256 config filename/i],
    ["multiple entries", [
      { Config: `${"a".repeat(64)}.json`, RepoTags: null, Layers: [] },
      { Config: `${"b".repeat(64)}.json`, RepoTags: null, Layers: [] },
    ], /exactly one image entry/i],
  ])("rejects malicious archive metadata: %s", (_name, archiveManifest, message) => {
    expect(() => parseDockerArchiveConfigPath(archiveManifest)).toThrow(message);
  });

  it("rejects config bytes whose digest does not match the archive filename", () => {
    expect(() => verifyDockerArchiveConfigBytes(
      `${"a".repeat(64)}.json`,
      Buffer.from('{"tampered":true}'),
    )).toThrow(/config bytes do not match.*filename/i);
  });

  it("rejects a forged handoff config when Docker exposes the valid manifest as Id", () => {
    expect(() => validateLocalRuntimeIdentity({
      manifest: { schemaVersion: 1, records: records(true) },
      expectations: [{ language: "c", tag: tag("c"), declaredContentDigest: manifests.c }],
      inspectImage,
      resolveConfigDigest,
    })).toThrow(/archive-derived config digest for c does not match the recorded config digest/i);
  });
});

const temporaryRoots: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "codestead-forged-config-"));
  temporaryRoots.push(root);
  await mkdir(path.join(root, "services", "runner", "dist"), { recursive: true });
  await mkdir(path.join(root, "scripts"), { recursive: true });
  await mkdir(path.join(root, "content", "authored", "assessment-banks"), { recursive: true });
  await writeFile(
    path.join(root, "services", "runner", "dist", "runtime-local-build-identities.json"),
    `${JSON.stringify({ schemaVersion: 1, records: records(true) }, null, 2)}\n`,
  );
  await writeFile(path.join(root, "scripts", "curriculum-runtime-pins.json"), `${JSON.stringify({
    schemaVersion: 1,
    records: languages.map((language) => ({
      language,
      tag: tag(language),
      digest: manifests[language],
      reference: reference(language),
    })),
  }, null, 2)}\n`);
  await writeFile(path.join(root, "scripts", "pinned-curriculum-runtime.ts"), `export const X = {
  java: { imageDigest: "${manifests.java}" },
  python: { imageDigest: "${manifests.python}" },
};
`);
  await writeFile(path.join(root, "content", "authored", "assessment-banks", "all.json"), `${JSON.stringify({
    items: languages.map((language) => ({
      kind: "code",
      runtime: { engine: "isolated-runner", language, imageDigest: manifests[language] },
    })),
  }, null, 2)}\n`);
  return root;
}

describe.each(["--check", "--apply"] as const)("forged config command rejection %s", (mode) => {
  it("fails before changing the bank, canonical pins, or pinned source", async () => {
    const root = await fixtureRoot();
    const files = [
      path.join(root, "content", "authored", "assessment-banks", "all.json"),
      path.join(root, "scripts", "curriculum-runtime-pins.json"),
      path.join(root, "scripts", "pinned-curriculum-runtime.ts"),
    ];
    const before = await Promise.all(files.map((file) => readFile(file, "utf8")));
    await expect(runCurriculumRuntimePinSync({
      argv: [mode],
      root,
      inspectImage,
      resolveConfigDigest,
      log: () => undefined,
    })).rejects.toThrow(/archive-derived config digest for c does not match the recorded config digest/i);
    await expect(Promise.all(files.map((file) => readFile(file, "utf8")))).resolves.toEqual(before);
  });
});
