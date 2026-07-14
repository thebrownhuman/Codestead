import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

import {
  ContentRepository,
  type AssessmentBank,
  type CodeAssessmentItem,
} from "../src/lib/content";
import {
  C_CPP_NEW_EXECUTABLE_SPECS,
  C_CPP_NON_CODE_FACETS,
  type CCppLanguage,
} from "./content-seeds/c-cpp-executable-tranche";

interface RuntimeImageRecord {
  readonly language: string;
  readonly digest: string;
  readonly reference: string;
}

interface RuntimeImages {
  readonly records: readonly RuntimeImageRecord[];
}

interface RuntimeInspectionRecord {
  readonly language: string;
  readonly tag: string;
  readonly imageId: string;
  readonly version: string;
  readonly harness: {
    readonly protocolVersion: number;
    readonly language: string;
    readonly compileThenRun: boolean;
    readonly shell: boolean;
  };
}

interface RuntimeInspection {
  readonly images: readonly RuntimeInspectionRecord[];
}

interface ExecutionResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

interface CaseResult {
  readonly itemId: string;
  readonly skillId: string;
  readonly language: string;
  readonly testId: string;
  readonly visibility: string;
  readonly category: string;
  readonly status: "passed" | "failed";
  readonly durationMs: number;
  readonly sourceHash: string;
  readonly failure?: string;
}

const root = process.cwd();
const imageTags: Readonly<Record<CCppLanguage, string>> = {
  c: "learncoding/runtime-c:local",
  cpp: "learncoding/runtime-cpp:local",
};
const expectedVersions: Readonly<Record<CCppLanguage, string>> = {
  c: "gcc (Alpine 14.2.0) 14.2.0",
  cpp: "g++ (Alpine 14.2.0) 14.2.0",
};
const contentVersions: Readonly<Record<CCppLanguage, string>> = {
  c: "C23 / GCC 14.2.0",
  cpp: "C++20 / G++ 14.2.0",
};
const allowedHeaders: Readonly<Record<CCppLanguage, ReadonlySet<string>>> = {
  c: new Set([
    "ctype.h", "errno.h", "inttypes.h", "limits.h", "stdbool.h", "stdint.h",
    "stdio.h", "stdlib.h", "string.h",
  ]),
  cpp: new Set([
    "algorithm", "array", "concepts", "cstdint", "functional", "iomanip",
    "iostream", "map", "memory", "numeric", "optional", "queue", "ranges",
    "stdexcept", "string", "type_traits", "utility", "variant", "vector",
  ]),
};

function hash(value: string): string {
  return "sha256:" + createHash("sha256").update(value).digest("hex");
}

function dockerAvailable(): boolean {
  return spawnSync("docker", ["info"], { stdio: "ignore", windowsHide: true }).status === 0;
}

function dockerImageId(tag: string): string | null {
  const result = spawnSync(
    "docker",
    ["image", "inspect", tag, "--format", "{{.Id}}"],
    { encoding: "utf8", windowsHide: true },
  );
  return result.status === 0 ? result.stdout.trim() : null;
}

function languageOf(item: CodeAssessmentItem): CCppLanguage {
  if (item.runtime.language === "c" || item.runtime.language === "cpp") {
    return item.runtime.language;
  }
  throw new Error(item.id + " does not use a C/C++ runtime.");
}

function assertStandardOnly(item: CodeAssessmentItem): void {
  const language = languageOf(item);
  const includes = [...item.answer.referenceSolution.matchAll(/^\s*#include\s*([<"])([^>"]+)[>"]/gm)];
  for (const include of includes) {
    if (include[1] !== "<") throw new Error(item.id + " uses a local/package include: " + include[2]);
    if (!allowedHeaders[language].has(include[2]!)) {
      throw new Error(item.id + " uses a non-allowlisted header: " + include[2]);
    }
  }
  const forbidden = [/\bsystem\s*\(/, /\bpopen\s*\(/, /\bfork\s*\(/, /\bexec[a-z]*\s*\(/, /<sys\/socket\.h>/];
  for (const pattern of forbidden) {
    if (pattern.test(item.answer.referenceSolution)) {
      throw new Error(item.id + " contains a forbidden process or network primitive: " + pattern.source);
    }
  }
}

async function execute(item: CodeAssessmentItem, stdin: string): Promise<ExecutionResult> {
  const language = languageOf(item);
  const directory = mkdtempSync(path.join(os.tmpdir(), "lc-c-cpp-" + language + "-"));
  const file = path.join(directory, item.runtime.entrypoint);
  writeFileSync(file, item.answer.referenceSolution, { encoding: "utf8", mode: 0o444 });
  try {
    chmodSync(directory, 0o755);
    chmodSync(file, 0o444);
  } catch {
    // Docker Desktop owns bind permission translation on Windows.
  }
  const name = "lc-c-cpp-" + language + "-" + process.pid + "-" + Math.random().toString(16).slice(2, 10);
  const args = [
    "run", "--rm", "--interactive", "--name", name, "--pull", "never",
    "--network", "none", "--ipc", "none", "--log-driver", "none", "--read-only",
    "--init", "--stop-timeout", "1", "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges:true", "--pids-limit", "32",
    "--memory", item.runtime.memoryLimitMb + "m",
    "--memory-swap", item.runtime.memoryLimitMb + "m", "--cpus", "0.5",
    "--ulimit", "fsize=16777216:16777216", "--ulimit", "nofile=64:64",
    "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=16m,uid=65532,gid=65532,mode=0700",
    "--tmpfs", "/work:rw,exec,nosuid,nodev,size=16777216,uid=65532,gid=65532,mode=0700",
    "--user", "65532:65532", "--env", "HOME=/tmp", "--workdir", "/work",
    "--mount", "type=bind,src=" + directory + ",dst=/input,readonly",
    imageTags[language], "/opt/runner/execute", "--mode", "run", "--language", language,
    "--source-root", "/input", "--entrypoint", "/input/" + item.runtime.entrypoint,
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

function assertBankDraft(bank: AssessmentBank): void {
  if (bank.publication.stage !== "draft" || !bank.publication.aiAssisted || bank.publication.reviewer !== null) {
    throw new Error(bank.id + " is not an AI-assisted, human-unreviewed draft.");
  }
  if (bank.items.some((item) => item.examEligibility.eligible)) {
    throw new Error(bank.id + " contains an exam-eligible draft item.");
  }
}

async function main(): Promise<void> {
  const repository = new ContentRepository({ contentRoot: path.join(root, "content") });
  const [cCourse, cppCourse, authored, runtimeImages, runtimeInspection] = await Promise.all([
    repository.getCourse("c"),
    repository.getCourse("cpp"),
    repository.getAuthoredContentSet(),
    readFile(path.join(root, "services", "runner", "dist", "runtime-images.json"), "utf8").then((value) => JSON.parse(value) as RuntimeImages),
    readFile(path.join(root, "services", "runner", "dist", "runtime-inspection.json"), "utf8").then((value) => JSON.parse(value) as RuntimeInspection),
  ]);
  if (!cCourse || !cppCourse) throw new Error("C or C++ course is missing.");
  const courses = [cCourse, cppCourse];
  const declaredSkills = courses.flatMap((course) =>
    course.modules.flatMap((courseModule) =>
      courseModule.skills.map((skill) => ({ courseId: course.id as CCppLanguage, skill })),
    ),
  );
  const banks = authored.assessmentBanks.filter((bank) => bank.courseId === "c" || bank.courseId === "cpp");
  const bankBySkill = new Map(banks.map((bank) => [bank.skillId, bank]));
  const digestByLanguage = new Map(
    runtimeImages.records.map((record) => [record.language, record.digest]),
  );
  const inspectionByLanguage = new Map(
    runtimeInspection.images.map((record) => [record.language, record]),
  );
  const codeItems: CodeAssessmentItem[] = [];
  const skillCoverage: Array<Record<string, unknown>> = [];

  for (const { courseId, skill } of declaredSkills) {
    const bank = bankBySkill.get(skill.id);
    if (!bank) throw new Error("Missing assessment bank for " + skill.id);
    assertBankDraft(bank);
    const items = bank.items.filter((item): item is CodeAssessmentItem => item.kind === "code");
    const nonCodeReason = C_CPP_NON_CODE_FACETS[skill.id];
    if (nonCodeReason) {
      if (items.length !== 0) throw new Error(skill.id + " has code despite non-code classification.");
      skillCoverage.push({
        skillId: skill.id,
        language: courseId,
        classification: "non-code",
        rationale: nonCodeReason,
        requiredPlatformFacet: nonCodeReason.includes("sanitizer") || nonCodeReason.includes("Sanitizer")
          ? "sanitizer-instrumented diagnostic runner"
          : nonCodeReason.includes("build") || nonCodeReason.includes("header")
            ? "multi-file artifact and build grader"
            : "translation/diagnostic capture grader",
      });
      continue;
    }
    if (items.length !== 1) throw new Error(skill.id + " must have exactly one executable code item.");
    const item = items[0]!;
    const expectedDigest = digestByLanguage.get(courseId);
    if (item.runtime.language !== courseId) throw new Error(item.id + " language does not match course.");
    if (item.runtime.version !== contentVersions[courseId]) throw new Error(item.id + " has unpinned version metadata.");
    if (item.runtime.imageDigest !== expectedDigest) throw new Error(item.id + " digest does not match the runtime manifest.");
    if (item.tests.some((test) => test.comparison !== "exact")) throw new Error(item.id + " uses non-exact output comparison.");
    if (!item.tests.some((test) => test.visibility === "visible")) throw new Error(item.id + " lacks a visible case.");
    if (!item.tests.some((test) => test.visibility === "hidden" && test.category === "boundary")) {
      throw new Error(item.id + " lacks a hidden boundary case.");
    }
    assertStandardOnly(item);
    codeItems.push(item);
    const facet = C_CPP_NEW_EXECUTABLE_SPECS[skill.id]?.facet ??
      item.privateAuthorNotes.find((note) => note.startsWith("Executable facet:"))?.slice("Executable facet:".length).trim() ??
      "retained bounded executable application";
    skillCoverage.push({
      skillId: skill.id,
      language: courseId,
      classification: "executable",
      codeItemId: item.id,
      facet,
      caseCount: item.tests.length,
      visibleCases: item.tests.filter((test) => test.visibility === "visible").length,
      hiddenCases: item.tests.filter((test) => test.visibility === "hidden").length,
      hiddenBoundaryCases: item.tests.filter((test) => test.visibility === "hidden" && test.category === "boundary").length,
      sourceHash: hash(item.answer.referenceSolution),
    });
  }
  if (skillCoverage.length !== declaredSkills.length) throw new Error("Skill coverage report is incomplete.");
  if (banks.length !== declaredSkills.length) throw new Error("Unexpected C/C++ authored bank count.");

  const structureOnly = process.argv.includes("--structure-only");
  const limitArgument = process.argv.find((argument) => argument.startsWith("--limit="));
  const limit = limitArgument ? Number.parseInt(limitArgument.split("=")[1]!, 10) : codeItems.length;
  if (!Number.isInteger(limit) || limit < 1) throw new Error("--limit must be a positive integer.");
  const selected = codeItems.sort((left, right) => left.id.localeCompare(right.id)).slice(0, limit);
  const workerArgument = process.argv.find((argument) => argument.startsWith("--workers="));
  const workerCount = workerArgument ? Number.parseInt(workerArgument.split("=")[1]!, 10) : 2;
  if (!Number.isInteger(workerCount) || workerCount < 1 || workerCount > 8) throw new Error("--workers must be from 1 through 8.");
  const imageEvidence = Object.fromEntries(
    (["c", "cpp"] as const).map((language) => {
      const expectedDigest = digestByLanguage.get(language) ?? "missing";
      const inspection = inspectionByLanguage.get(language);
      const actualImageId = dockerImageId(imageTags[language]);
      return [language, {
        tag: imageTags[language],
        expectedDigest,
        actualImageId,
        digestMatches: actualImageId === expectedDigest,
        expectedCompilerVersion: expectedVersions[language],
        inspectedCompilerVersion: inspection?.version ?? null,
        compilerVersionMatches: inspection?.version === expectedVersions[language],
        harness: inspection?.harness ?? null,
      }];
    }),
  );
  if (!structureOnly && !dockerAvailable()) {
    throw new Error("Docker is unavailable; --structure-only is permitted only when runtime execution is intentionally deferred.");
  }
  if (!structureOnly && Object.values(imageEvidence).some((entry) => !entry.digestMatches || !entry.compilerVersionMatches)) {
    throw new Error("Pinned C/C++ runtime evidence mismatch: " + JSON.stringify(imageEvidence));
  }

  const jobs = selected.flatMap((item) => item.tests.map((test) => ({ item, test })));
  const results: CaseResult[] = [];
  let next = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const index = next++;
      if (index >= jobs.length) return;
      const { item, test } = jobs[index]!;
      const started = Date.now();
      try {
        const execution = await execute(item, test.stdin);
        if (execution.timedOut) throw new Error("timeout");
        if (execution.code !== 0) {
          throw new Error("runner exit " + execution.code + "; stderr=" + execution.stderr.slice(0, 500));
        }
        if (execution.stdout !== test.expectedStdout) {
          throw new Error("exact stdout mismatch; expected=" + JSON.stringify(test.expectedStdout) + "; actual=" + JSON.stringify(execution.stdout));
        }
        results.push({
          itemId: item.id,
          skillId: item.skillId,
          language: item.runtime.language,
          testId: test.id,
          visibility: test.visibility,
          category: test.category,
          status: "passed",
          durationMs: Date.now() - started,
          sourceHash: hash(item.answer.referenceSolution),
        });
      } catch (error) {
        results.push({
          itemId: item.id,
          skillId: item.skillId,
          language: item.runtime.language,
          testId: test.id,
          visibility: test.visibility,
          category: test.category,
          status: "failed",
          durationMs: Date.now() - started,
          sourceHash: hash(item.answer.referenceSolution),
          failure: error instanceof Error ? error.message : String(error),
        });
      }
      if (results.length % 20 === 0 || results.length === jobs.length) {
        console.log("C/C++ runtime progress: " + results.length + "/" + jobs.length + " cases.");
      }
    }
  }
  if (!structureOnly) await Promise.all(Array.from({ length: workerCount }, () => worker()));
  results.sort((left, right) => left.itemId.localeCompare(right.itemId) || left.testId.localeCompare(right.testId));
  const failures = results.filter((result) => result.status === "failed");
  const fullRuntimeRun = !structureOnly && selected.length === codeItems.length;
  const totalCases = codeItems.reduce((sum, item) => sum + item.tests.length, 0);
  const visibleCases = codeItems.reduce((sum, item) => sum + item.tests.filter((test) => test.visibility === "visible").length, 0);
  const hiddenCases = totalCases - visibleCases;
  const hiddenBoundaryCases = codeItems.reduce(
    (sum, item) => sum + item.tests.filter((test) => test.visibility === "hidden" && test.category === "boundary").length,
    0,
  );
  const report = {
    schemaVersion: "1.0.0",
    generatedAt: new Date().toISOString(),
    scope: "C23 and C++20 executable authored curriculum evidence",
    status: failures.length === 0 && fullRuntimeRun ? "verified" : structureOnly ? "structure-only" : "failed-or-partial",
    counts: {
      declaredSkills: declaredSkills.length,
      executableSkills: codeItems.length,
      justifiedNonCodeSkills: declaredSkills.length - codeItems.length,
      newExecutableSpecs: Object.keys(C_CPP_NEW_EXECUTABLE_SPECS).length,
      retainedExecutableSpecs: codeItems.length - Object.keys(C_CPP_NEW_EXECUTABLE_SPECS).length,
      totalCases,
      visibleCases,
      hiddenCases,
      hiddenBoundaryCases,
      selectedItems: selected.length,
      executedCases: results.length,
      passedCases: results.length - failures.length,
      failedCases: failures.length,
    },
    executionPolicy: {
      network: "none",
      packageInstallation: "prohibited",
      dependencies: "language standard library only; allowlisted headers checked statically",
      sourceMount: "read-only",
      rootFilesystem: "read-only",
      capabilities: "all dropped",
      noNewPrivileges: true,
      concurrency: workerCount,
      comparison: "exact stdout",
      externalProviderCalls: 0,
    },
    fullRuntimeRun,
    imageEvidence,
    languageCounts: {
      c: {
        skills: declaredSkills.filter((entry) => entry.courseId === "c").length,
        executable: codeItems.filter((item) => item.runtime.language === "c").length,
        cases: codeItems.filter((item) => item.runtime.language === "c").reduce((sum, item) => sum + item.tests.length, 0),
      },
      cpp: {
        skills: declaredSkills.filter((entry) => entry.courseId === "cpp").length,
        executable: codeItems.filter((item) => item.runtime.language === "cpp").length,
        cases: codeItems.filter((item) => item.runtime.language === "cpp").reduce((sum, item) => sum + item.tests.length, 0),
      },
    },
    skillCoverage,
    results,
    remainingGaps: [
      "All C/C++ lessons and assessment items remain AI-assisted drafts with no human technical, standards, pedagogy, accessibility, or assessment review; formal exam eligibility remains false.",
      "Ten tooling-oriented skills require translation/diagnostic capture, multi-file build artifact grading, or sanitizer-instrumented execution before executable evidence would be honest.",
      "The verifier proves local digest-pinned Docker behavior, not production NUC deployment, KVM-strength isolation, backup recovery, or operational capacity.",
      "Exact-output cases establish deterministic behavior for each declared executable facet; they do not by themselves prove code style, explanation quality, absence of every undefined behavior, or complete skill mastery.",
    ],
  };
  const reportName = structureOnly
    ? "c-cpp-executable-structure-2026-07-12.json"
    : fullRuntimeRun
      ? "c-cpp-executable-runtime-2026-07-12.json"
      : "c-cpp-executable-sample-2026-07-12.json";
  const reportPath = path.join(root, "docs", "evidence", reportName);
  await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n", "utf8");
  console.log(
    "C/C++ executable verification: " + declaredSkills.length + " skills, " + codeItems.length +
      " executable, " + totalCases + " declared cases, " + results.length +
      " executed, " + failures.length + " failures, full=" + fullRuntimeRun + ".",
  );
  if (failures.length || (process.argv.includes("--check") && !structureOnly && !fullRuntimeRun)) {
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
