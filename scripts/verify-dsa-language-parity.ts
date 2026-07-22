import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  ContentRepository,
  DSA_PARITY_LANGUAGES,
  validateDsaLanguageParity,
  type CodeAssessmentItem,
} from "../src/lib/content";
import {
  LOCAL_RUNTIME_IDENTITY_LIMITATION,
  projectRuntimeIdentityEvidence,
  validateLocalRuntimeIdentity,
  type LocalRuntimeIdentityEvidence,
} from "./lib/local-runtime-identity";
import { verifyOrApplyDeterministicEvidence } from "./lib/deterministic-evidence";

type Language = "c" | "cpp" | "java" | "python";
const root = process.cwd();
const imageTags: Readonly<Record<Language, string>> = {
  c: "learncoding/runtime-c:local",
  cpp: "learncoding/runtime-cpp:local",
  java: "learncoding/runtime-java:local",
  python: "learncoding/runtime-python:local",
};

function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
function dockerAvailable(): boolean {
  return spawnSync("docker", ["info"], { stdio: "ignore", windowsHide: true }).status === 0;
}

async function execute(
  item: CodeAssessmentItem,
  stdin: string,
  imageReference: string,
): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  const language = item.runtime.language as Language;
  const directory = mkdtempSync(path.join(os.tmpdir(), `lc-dsa-${language}-`));
  const file = path.join(directory, item.runtime.entrypoint);
  writeFileSync(file, item.answer.referenceSolution, { encoding: "utf8", mode: 0o444 });
  try {
    chmodSync(directory, 0o755);
    chmodSync(file, 0o444);
  } catch {
    // Docker Desktop manages bind permissions.
  }
  const name = `lc-dsa-${language}-${process.pid}-${Math.random().toString(16).slice(2, 10)}`;
  const args = [
    "run", "--rm", "--interactive", "--name", name, "--pull", "never", "--network", "none",
    "--ipc", "none", "--log-driver", "none", "--read-only", "--init", "--stop-timeout", "1",
    "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true", "--pids-limit", "32",
    "--memory", `${item.runtime.memoryLimitMb}m`, "--memory-swap", `${item.runtime.memoryLimitMb}m`, "--cpus", "0.5",
    "--ulimit", "fsize=16777216:16777216", "--ulimit", "nofile=64:64",
    "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=16m,uid=65532,gid=65532,mode=0700",
    "--tmpfs", "/work:rw,exec,nosuid,nodev,size=16777216,uid=65532,gid=65532,mode=0700",
    "--user", "65532:65532", "--env", "HOME=/tmp", "--workdir", "/work",
    "--mount", `type=bind,src=${directory},dst=/input,readonly`, imageReference,
    "/opt/runner/execute", "--mode", "run", "--language", language,
    "--source-root", "/input", "--entrypoint", `/input/${item.runtime.entrypoint}`,
  ];
  return await new Promise((resolve, reject) => {
    const child = spawn("docker", args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
      spawnSync("docker", ["rm", "--force", name], { stdio: "ignore", windowsHide: true });
    }, Math.max(15_000, item.runtime.timeLimitMs * 5));
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rmSync(directory, { recursive: true, force: true });
      reject(error);
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      spawnSync("docker", ["rm", "--force", name], { stdio: "ignore", windowsHide: true });
      rmSync(directory, { recursive: true, force: true });
      resolve({
        code,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        timedOut,
      });
    });
    child.stdin.end(stdin);
  });
}

async function main(): Promise<void> {
  const repository = new ContentRepository({ contentRoot: path.join(root, "content") });
  const [course, authored] = await Promise.all([
    repository.getCourse("dsa"),
    repository.getAuthoredContentSet(),
  ]);
  if (!course) throw new Error("DSA course is missing.");
  const declared = course.modules.flatMap((module) => module.skills.map((skill) => skill.id));
  const banks = authored.assessmentBanks.filter((bank) => bank.courseId === "dsa");
  const structure = validateDsaLanguageParity(banks, declared);
  const items = banks
    .flatMap((bank) => bank.items)
    .filter((item): item is CodeAssessmentItem => item.kind === "code" && item.parity !== undefined)
    .sort((left, right) => left.id.localeCompare(right.id));
  const structureOnly = process.argv.includes("--structure-only");
  const limitArguments = process.argv.filter((argument) => /^--limit/.test(argument));
  if (limitArguments.length > 1 || (limitArguments[0] !== undefined && !/^--limit=[1-9]\d*$/.test(limitArguments[0]))) {
    throw new Error("--limit must be provided once as a positive integer.");
  }
  const limit = limitArguments[0] ? Number.parseInt(limitArguments[0].slice("--limit=".length), 10) : items.length;
  const selected = items.slice(0, limit);

  let runtimeIdentities: Readonly<Record<string, LocalRuntimeIdentityEvidence>> = {};
  let imageEvidence: Readonly<Record<string, unknown>> = Object.fromEntries(
    DSA_PARITY_LANGUAGES.map((language) => [language, {
      tag: imageTags[language],
      manifestDigest: structure.imageDigests[language],
      configDigest: null,
      immutableReference: null,
      tagDescriptorDigest: null,
      tagImageId: null,
      exactReferenceDescriptorDigest: null,
      exactReferenceImageId: null,
      independentlyValidated: false,
    }]),
  );
  if (!structureOnly) {
    if (!dockerAvailable()) {
      throw new Error("Docker is unavailable; use --structure-only only when runtime execution is intentionally deferred.");
    }
    const runtimeManifestPath = path.join(root, "services", "runner", "dist", "runtime-local-build-identities.json");
    const runtimeManifest = JSON.parse(await readFile(runtimeManifestPath, "utf8")) as unknown;
    runtimeIdentities = validateLocalRuntimeIdentity({
      manifest: runtimeManifest,
      expectations: DSA_PARITY_LANGUAGES.map((language) => ({
        language,
        tag: imageTags[language],
        declaredContentDigest: structure.imageDigests[language],
      })),
    });
    imageEvidence = Object.fromEntries(DSA_PARITY_LANGUAGES.map((language) => {
      const runtimeIdentity = runtimeIdentities[language];
      if (!runtimeIdentity) throw new Error(`Validated local runtime identity is missing for ${language}.`);
      return [language, projectRuntimeIdentityEvidence(runtimeIdentity)];
    }));
  }

  const jobs = selected.flatMap((item) => item.tests.map((test) => ({ item, test })));
  const results: Array<{
    itemId: string;
    skillId: string;
    language: string;
    visibility: string;
    status: "passed" | "failed";
    durationMs: number;
    sourceHash: string;
    failure?: string;
  }> = [];
  let next = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const index = next++;
      if (index >= jobs.length) return;
      const { item, test } = jobs[index]!;
      const started = Date.now();
      try {
        const runtimeIdentity = runtimeIdentities[item.runtime.language];
        if (!runtimeIdentity) throw new Error(`Validated local runtime identity is missing for ${item.runtime.language}.`);
        const result = await execute(item, test.stdin, runtimeIdentity.immutableReference);
        const actual = test.comparison === "trimmed" ? result.stdout.trim() : result.stdout;
        const expected = test.comparison === "trimmed" ? test.expectedStdout.trim() : test.expectedStdout;
        if (result.timedOut || result.code !== 0 || actual !== expected) {
          throw new Error(result.timedOut ? "timeout" : result.code !== 0 ? `runner exit ${result.code}` : "stdout mismatch");
        }
        results.push({
          itemId: item.id,
          skillId: item.skillId,
          language: item.runtime.language,
          visibility: test.visibility,
          status: "passed",
          durationMs: Date.now() - started,
          sourceHash: digest(item.answer.referenceSolution),
        });
      } catch (error) {
        results.push({
          itemId: item.id,
          skillId: item.skillId,
          language: item.runtime.language,
          visibility: test.visibility,
          status: "failed",
          durationMs: Date.now() - started,
          sourceHash: digest(item.answer.referenceSolution),
          failure: error instanceof Error ? error.message : String(error),
        });
      }
      if (results.length % 40 === 0 || results.length === jobs.length) {
        console.log(`DSA parity runtime progress: ${results.length}/${jobs.length} cases.`);
      }
    }
  }
  if (!structureOnly) await Promise.all([worker(), worker()]);
  const failures = results.filter((result) => result.status === "failed");
  const fullRuntimeRun = !structureOnly && selected.length === items.length;
  const buildEvidence = (generatedAt: string) => ({
    generatedAt,
    structure,
    selectedItems: selected.length,
    declaredItems: items.length,
    executedCases: results.length,
    passedCases: results.length - failures.length,
    failedCases: failures.length,
    fullRuntimeRun,
    externalProviderCalls: 0,
    imageEvidence,
    results,
    limitations: [
      "All content remains AI-assisted draft with zero exam eligibility.",
      "Numeric module-scoped contracts prove deterministic four-runtime equivalence, not human-reviewed pedagogy or idiomatic language quality.",
      LOCAL_RUNTIME_IDENTITY_LIMITATION,
      "Local Docker execution does not prove production KVM/NUC deployment, isolation, recovery, or capacity.",
    ],
  });
  const reportName = structureOnly
    ? "dsa-parity-structure-2026-07-12.json"
    : fullRuntimeRun
      ? "dsa-parity-runtime-2026-07-12.json"
      : "dsa-parity-sample-2026-07-12.json";
  await verifyOrApplyDeterministicEvidence({
    argv: process.argv.slice(2),
    root,
    trustedDirectory: "exclusive-writer",
    relativePath: path.join("docs", "evidence", reportName),
    buildEvidence,
    applyCommand: structureOnly
      ? "npm run dsa:parity:structure:apply"
      : fullRuntimeRun
        ? "npm run dsa:parity:evidence:apply"
        : `npm run dsa:parity:evidence:apply -- --limit=${selected.length}`,
    allowArgument: (argument) => argument === "--structure-only" || /^--limit=[1-9]\d*$/.test(argument),
  });
  console.log(`DSA parity ${structureOnly ? "structure" : "runtime"} verification: ${structure.skillCount} skills, ${structure.itemCount} items, ${results.length} executed cases, ${failures.length} failures, full=${fullRuntimeRun}.`);
  if (failures.length || (process.argv.includes("--check") && !structureOnly && !fullRuntimeRun)) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
