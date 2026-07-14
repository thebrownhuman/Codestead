import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

import { ContentRepository, validateDsaLanguageParity, type CodeAssessmentItem } from "../src/lib/content";

type Language = "c" | "cpp" | "java" | "python";
const root = process.cwd();
const imageTags: Readonly<Record<Language, string>> = {
  c: "learncoding/runtime-c:local", cpp: "learncoding/runtime-cpp:local",
  java: "learncoding/runtime-java:local", python: "learncoding/runtime-python:local",
};

function digest(value: string): string { return `sha256:${createHash("sha256").update(value).digest("hex")}`; }
function dockerAvailable(): boolean { return spawnSync("docker", ["info"], { stdio: "ignore", windowsHide: true }).status === 0; }
function imageId(tag: string): string | null {
  const result = spawnSync("docker", ["image", "inspect", tag, "--format", "{{.Id}}"], { encoding: "utf8", windowsHide: true });
  return result.status === 0 ? result.stdout.trim() : null;
}

async function execute(item: CodeAssessmentItem, stdin: string): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  const language = item.runtime.language as Language;
  const directory = mkdtempSync(path.join(os.tmpdir(), `lc-dsa-${language}-`));
  const file = path.join(directory, item.runtime.entrypoint);
  writeFileSync(file, item.answer.referenceSolution, { encoding: "utf8", mode: 0o444 });
  try { chmodSync(directory, 0o755); chmodSync(file, 0o444); } catch { /* Docker Desktop manages bind permissions. */ }
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
    "--mount", `type=bind,src=${directory},dst=/input,readonly`, imageTags[language],
    "/opt/runner/execute", "--mode", "run", "--language", language,
    "--source-root", "/input", "--entrypoint", `/input/${item.runtime.entrypoint}`,
  ];
  return await new Promise((resolve, reject) => {
    const child = spawn("docker", args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    const stdout: Buffer[] = [], stderr: Buffer[] = []; let timedOut = false, settled = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); spawnSync("docker", ["rm", "--force", name], { stdio: "ignore", windowsHide: true }); }, Math.max(15_000, item.runtime.timeLimitMs * 5));
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk)); child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", (error) => { if (settled) return; settled = true; clearTimeout(timer); rmSync(directory, { recursive: true, force: true }); reject(error); });
    child.once("close", (code) => { if (settled) return; settled = true; clearTimeout(timer); spawnSync("docker", ["rm", "--force", name], { stdio: "ignore", windowsHide: true }); rmSync(directory, { recursive: true, force: true }); resolve({ code, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8"), timedOut }); });
    child.stdin.end(stdin);
  });
}

async function main() {
  const repository = new ContentRepository({ contentRoot: path.join(root, "content") });
  const [course, authored] = await Promise.all([repository.getCourse("dsa"), repository.getAuthoredContentSet()]);
  if (!course) throw new Error("DSA course is missing.");
  const declared = course.modules.flatMap((module) => module.skills.map((skill) => skill.id));
  const banks = authored.assessmentBanks.filter((bank) => bank.courseId === "dsa");
  const structure = validateDsaLanguageParity(banks, declared);
  const items = banks.flatMap((bank) => bank.items).filter((item): item is CodeAssessmentItem => item.kind === "code" && item.parity !== undefined).sort((a,b)=>a.id.localeCompare(b.id));
  const structureOnly = process.argv.includes("--structure-only");
  const limitArgument = process.argv.find((argument) => argument.startsWith("--limit="));
  const limit = limitArgument ? Number.parseInt(limitArgument.split("=")[1]!, 10) : items.length;
  const selected = items.slice(0, limit);
  const imageEvidence: Record<string, { tag: string; expected: string; actual: string | null; matches: boolean }> = {};
  for (const language of ["c", "cpp", "java", "python"] as const) {
    const actual = structure.imageDigests[language] ? imageId(imageTags[language]) : null;
    imageEvidence[language] = { tag: imageTags[language], expected: structure.imageDigests[language], actual, matches: actual === structure.imageDigests[language] };
  }
  if (!structureOnly && !dockerAvailable()) throw new Error("Docker is unavailable; use --structure-only only when runtime execution is intentionally deferred.");
  if (!structureOnly && Object.values(imageEvidence).some((entry) => !entry.matches)) throw new Error(`Pinned DSA runtime image mismatch: ${JSON.stringify(imageEvidence)}`);

  const jobs = selected.flatMap((item) => item.tests.map((test) => ({ item, test })));
  const results: { itemId: string; skillId: string; language: string; visibility: string; status: "passed" | "failed"; durationMs: number; sourceHash: string; failure?: string }[] = [];
  let next = 0;
  async function worker() {
    for (;;) {
      const index = next++; if (index >= jobs.length) return;
      const { item, test } = jobs[index]!; const started = Date.now();
      try {
        const result = await execute(item, test.stdin);
        const actual = test.comparison === "trimmed" ? result.stdout.trim() : result.stdout;
        const expected = test.comparison === "trimmed" ? test.expectedStdout.trim() : test.expectedStdout;
        if (result.timedOut || result.code !== 0 || actual !== expected) throw new Error(result.timedOut ? "timeout" : result.code !== 0 ? `runner exit ${result.code}` : "stdout mismatch");
        results.push({ itemId: item.id, skillId: item.skillId, language: item.runtime.language, visibility: test.visibility, status: "passed", durationMs: Date.now()-started, sourceHash: digest(item.answer.referenceSolution) });
      } catch (error) {
        results.push({ itemId: item.id, skillId: item.skillId, language: item.runtime.language, visibility: test.visibility, status: "failed", durationMs: Date.now()-started, sourceHash: digest(item.answer.referenceSolution), failure: error instanceof Error ? error.message : String(error) });
      }
      if (results.length % 40 === 0 || results.length === jobs.length) console.log(`DSA parity runtime progress: ${results.length}/${jobs.length} cases.`);
    }
  }
  if (!structureOnly) await Promise.all([worker(), worker()]);
  const failures = results.filter((result) => result.status === "failed");
  const fullRuntimeRun = !structureOnly && selected.length === items.length;
  const report = { generatedAt: new Date().toISOString(), structure, selectedItems: selected.length, declaredItems: items.length, executedCases: results.length, passedCases: results.length-failures.length, failedCases: failures.length, fullRuntimeRun, externalProviderCalls: 0, imageEvidence, results, limitations: ["All content remains AI-assisted draft with zero exam eligibility.", "Numeric module-scoped contracts prove deterministic four-runtime equivalence, not human-reviewed pedagogy or idiomatic language quality.", "Local Docker image IDs are evidence for this workstation only; production KVM/NUC deployment remains open."] };
  const reportName = structureOnly
    ? "dsa-parity-structure-2026-07-12.json"
    : fullRuntimeRun
      ? "dsa-parity-runtime-2026-07-12.json"
      : "dsa-parity-sample-2026-07-12.json";
  const reportPath = path.join(root, "docs", "evidence", reportName);
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`DSA parity ${structureOnly ? "structure" : "runtime"} verification: ${structure.skillCount} skills, ${structure.itemCount} items, ${results.length} executed cases, ${failures.length} failures, full=${fullRuntimeRun}.`);
  if (failures.length || process.argv.includes("--check") && !structureOnly && !fullRuntimeRun) process.exitCode = 1;
}

main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
