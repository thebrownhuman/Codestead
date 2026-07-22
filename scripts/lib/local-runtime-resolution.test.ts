import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runCurriculumRuntimePinSync } from "../sync-curriculum-runtime-pins";
import {
  projectRuntimeIdentityEvidence,
  validateLocalRuntimeIdentity,
  type InspectLocalRuntimeImage,
  type LocalRuntimeLanguage,
} from "./local-runtime-identity";

const sha = (character: string) => `sha256:${character.repeat(64)}`;
const languages = ["c", "cpp", "java", "javascript", "python"] as const;
const manifests = { c: sha("a"), cpp: sha("b"), java: sha("c"), javascript: sha("d"), python: sha("e") } as const;
const configs = { c: sha("f"), cpp: sha("1"), java: sha("2"), javascript: sha("3"), python: sha("4") } as const;

function tag(language: LocalRuntimeLanguage) { return `learncoding/runtime-${language}:local`; }
function reference(language: LocalRuntimeLanguage) { return `learncoding/runtime-${language}@${manifests[language]}`; }
function records() {
  return languages.map((language) => ({
    id: language,
    tag: tag(language),
    manifestDigest: manifests[language],
    configDigest: configs[language],
    reference: reference(language),
  }));
}
function inspection(language: LocalRuntimeLanguage, requested: string) {
  return {
    Id: manifests[language],
    Descriptor: { digest: manifests[language] },
    RepoTags: [tag(language)],
    RepoDigests: [reference(language)],
    requested,
  };
}
function goodInspector(): InspectLocalRuntimeImage {
  return (requested) => {
    const language = languages.find((candidate) => requested === tag(candidate) || requested === reference(candidate));
    if (!language) throw new Error(`unexpected image lookup ${requested}`);
    return inspection(language, requested);
  };
}

function goodConfigResolver() {
  return (requested: string) => {
    const language = languages.find((candidate) => requested === reference(candidate));
    if (!language) throw new Error(`unexpected archive lookup ${requested}`);
    return configs[language];
  };
}
const temporaryRoots: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "codestead-pin-command-"));
  temporaryRoots.push(root);
  await mkdir(path.join(root, "services", "runner", "dist"), { recursive: true });
  await mkdir(path.join(root, "scripts"), { recursive: true });
  await mkdir(path.join(root, "content", "authored", "assessment-banks"), { recursive: true });
  await writeFile(
    path.join(root, "services", "runner", "dist", "runtime-local-build-identities.json"),
    `${JSON.stringify({ schemaVersion: 1, records: records() }, null, 2)}\n`,
  );
  await writeFile(path.join(root, "scripts", "curriculum-runtime-pins.json"), `${JSON.stringify({
    schemaVersion: 1,
    records: languages.map((language) => ({ language, tag: tag(language), digest: manifests[language], reference: reference(language) })),
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

describe("independent local runtime resolution", () => {
  it("validates tag and exact-reference descriptor/Id pairs and projects the report schema", () => {
    const evidence = validateLocalRuntimeIdentity({
      manifest: { schemaVersion: 1, records: records() },
      expectations: [{ language: "c", tag: tag("c"), declaredContentDigest: manifests.c }],
      inspectImage: goodInspector(),
      resolveConfigDigest: goodConfigResolver(),
    }).c!;
    expect(projectRuntimeIdentityEvidence(evidence)).toEqual({
      tag: tag("c"),
      manifestDigest: manifests.c,
      configDigest: configs.c,
      immutableReference: reference("c"),
      tagDescriptorDigest: manifests.c,
      tagImageId: manifests.c,
      exactReferenceDescriptorDigest: manifests.c,
      exactReferenceImageId: manifests.c,
      independentlyValidated: true,
    });
  });

  it("continues to select the immutable reference if the mutable tag moves after validation", () => {
    let moved = false;
    const inspectImage: InspectLocalRuntimeImage = (requested) => {
      if (requested === tag("c") && moved) return { ...inspection("c", requested), Id: sha("9"), Descriptor: { digest: sha("9") } };
      return goodInspector()(requested);
    };
    const evidence = validateLocalRuntimeIdentity({
      manifest: { schemaVersion: 1, records: records() },
      expectations: [{ language: "c", tag: tag("c"), declaredContentDigest: manifests.c }],
      inspectImage,
      resolveConfigDigest: goodConfigResolver(),
    }).c!;
    moved = true;
    expect(evidence.immutableReference).toBe(reference("c"));
    expect(projectRuntimeIdentityEvidence(evidence).immutableReference).toBe(reference("c"));
  });
  it.each([
    ["tag", tag("c"), /tag descriptor for c.*recorded manifest/i],
    ["exact reference", reference("c"), /exact reference descriptor for c.*recorded manifest/i],
  ] as const)("rejects a %s that moves while the config archive is authenticated", (_kind, target, message) => {
    let targetInspections = 0;
    const inspectImage: InspectLocalRuntimeImage = (requested) => {
      if (requested === target && ++targetInspections === 2) {
        return { ...inspection("c", requested), Descriptor: { digest: sha("9") } };
      }
      return goodInspector()(requested);
    };
    expect(() => validateLocalRuntimeIdentity({
      manifest: { schemaVersion: 1, records: records() },
      expectations: [{ language: "c", tag: tag("c"), declaredContentDigest: manifests.c }],
      inspectImage,
      resolveConfigDigest: goodConfigResolver(),
    })).toThrow(message);
  });
});

describe.each(["--check", "--apply"] as const)("runtime pin command %s", (mode) => {
  it.each([
    ["stale manifest", (requested: string, base: InspectLocalRuntimeImage) => {
      if (requested === tag("c")) return { ...inspection("c", requested), Descriptor: { digest: sha("9") } };
      return base(requested);
    }, /tag descriptor for c.*recorded manifest/i],
    ["tampered config", (requested: string, base: InspectLocalRuntimeImage) => {
      if (requested === tag("c")) return { ...inspection("c", requested), Id: sha("9") };
      return base(requested);
    }, /tag image id for c.*neither.*manifest nor config/i],
    ["missing tag", (requested: string, base: InspectLocalRuntimeImage) => {
      if (requested === tag("c")) throw new Error("No such image");
      return base(requested);
    }, /failed to inspect current docker tag.*runtime-c:local/i],
    ["moved exact reference", (requested: string, base: InspectLocalRuntimeImage) => {
      if (requested === reference("c")) return { ...inspection("c", requested), Descriptor: { digest: sha("9") } };
      return base(requested);
    }, /exact reference descriptor for c.*recorded manifest/i],
  ] as const)("fails before writing for a %s", async (_label, mutate, message) => {
    const root = await fixtureRoot();
    const bank = path.join(root, "content", "authored", "assessment-banks", "all.json");
    const before = await readFile(bank, "utf8");
    const base = goodInspector();
    await expect(runCurriculumRuntimePinSync({
      argv: [mode],
      root,
      inspectImage: (requested) => mutate(requested, base),
      resolveConfigDigest: goodConfigResolver(),
      log: () => undefined,
    })).rejects.toThrow(message);
    expect(await readFile(bank, "utf8")).toBe(before);
  });
});
