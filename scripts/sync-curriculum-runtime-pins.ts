import { randomUUID } from "node:crypto";
import { readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  type InspectLocalRuntimeImage,
  type LocalRuntimeExpectation,
  type LocalRuntimeLanguage,
  type ResolveLocalRuntimeConfigDigest,
  validateLocalRuntimeIdentity,
} from "./lib/local-runtime-identity";
import {
  syncAssessmentBankRuntimePinText,
  syncPinnedCurriculumRuntimeSource,
} from "./lib/curriculum-runtime-pin-sync";

const languages = ["c", "cpp", "java", "javascript", "python"] as const;
const canonicalExpectations: readonly LocalRuntimeExpectation[] = languages.map((language) => ({
  language,
  tag: `learncoding/runtime-${language}:local`,
}));

export interface CurriculumRuntimePinSyncOptions {
  readonly argv?: readonly string[];
  readonly root?: string;
  readonly inspectImage?: InspectLocalRuntimeImage;
  readonly resolveConfigDigest?: ResolveLocalRuntimeConfigDigest;
  readonly log?: (message: string) => void;
}

async function atomicWrite(file: string, value: string): Promise<void> {
  const staging = `${file}.staging-${process.pid}-${randomUUID()}`;
  await writeFile(staging, value, "utf8");
  await rename(staging, file);
}

export async function runCurriculumRuntimePinSync(
  options: CurriculumRuntimePinSyncOptions = {},
): Promise<void> {
  const argv = options.argv ?? process.argv.slice(2);
  const root = options.root ?? process.cwd();
  const log = options.log ?? console.log;
  const apply = argv.includes("--apply");
  const check = argv.includes("--check");
  if (apply === check || argv.some((argument) => argument !== "--apply" && argument !== "--check")) {
    throw new Error("Choose exactly one mode: --apply or --check.");
  }

  const identityPath = path.join(root, "services", "runner", "dist", "runtime-local-build-identities.json");
  const pinnedSourcePath = path.join(root, "scripts", "pinned-curriculum-runtime.ts");
  const canonicalPinsPath = path.join(root, "scripts", "curriculum-runtime-pins.json");
  const banksRoot = path.join(root, "content", "authored", "assessment-banks");

  const identity = JSON.parse(await readFile(identityPath, "utf8")) as unknown;
  // This validation is deliberately the first stateful gate. The handoff does not
  // provide its own expected digest: Docker resolves both the canonical mutable tag
  // and the handoff's exact repository@manifest reference independently.
  const evidence = validateLocalRuntimeIdentity({
    manifest: identity,
    expectations: canonicalExpectations,
    inspectImage: options.inspectImage,
    resolveConfigDigest: options.resolveConfigDigest,
  });
  const digests = Object.fromEntries(languages.map((language) => {
    const record = evidence[language];
    if (!record) throw new Error(`Validated local build identity is missing ${language}.`);
    return [language, record.recordedLocalDigest];
  })) as Readonly<Record<LocalRuntimeLanguage, string>>;
  const canonicalPins = `${JSON.stringify({
    schemaVersion: 1,
    records: languages.map((language) => ({
      language,
      tag: evidence[language]!.tag,
      digest: evidence[language]!.recordedLocalDigest,
      reference: evidence[language]!.immutableReference,
    })),
  }, null, 2)}\n`;
  const canonicalPinsBefore = await readFile(canonicalPinsPath, "utf8");
  const canonicalPinsChanged = canonicalPinsBefore !== canonicalPins;

  const counts: Record<LocalRuntimeLanguage, number> = { c: 0, cpp: 0, java: 0, javascript: 0, python: 0 };
  const changedBanks: Array<{ readonly file: string; readonly value: string }> = [];
  const files = (await readdir(banksRoot)).filter((file) => file.endsWith(".json")).sort();
  for (const file of files) {
    const target = path.join(banksRoot, file);
    const before = await readFile(target, "utf8");
    const result = syncAssessmentBankRuntimePinText(before, digests);
    for (const language of languages) counts[language] += result.matchedByLanguage[language];
    if (result.changed) changedBanks.push({ file: target, value: result.value });
  }
  for (const language of languages) {
    if (counts[language] < 1) throw new Error(`No authored isolated-runner code items were found for ${language}.`);
  }

  const pinnedBefore = await readFile(pinnedSourcePath, "utf8");
  const pinned = syncPinnedCurriculumRuntimeSource(pinnedBefore, digests);
  const staleFiles = changedBanks.length + Number(pinned.changed) + Number(canonicalPinsChanged);
  if (check && staleFiles > 0) {
    throw new Error(`${staleFiles} curriculum runtime pin files are stale; run npm run curriculum:runtime-pins:apply after a verified runtime build.`);
  }
  if (apply) {
    for (const changed of changedBanks) await atomicWrite(changed.file, changed.value);
    if (pinned.changed) await atomicWrite(pinnedSourcePath, pinned.value);
    if (canonicalPinsChanged) await atomicWrite(canonicalPinsPath, canonicalPins);
  }

  const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
  log(`Curriculum runtime pins ${apply ? "synchronized" : "verified"}: ${total} items across ${files.length} banks; c=${counts.c}, cpp=${counts.cpp}, java=${counts.java}, javascript=${counts.javascript}, python=${counts.python}; changed=${staleFiles}.`);
}

const isDirectExecution = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isDirectExecution) {
  runCurriculumRuntimePinSync().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
