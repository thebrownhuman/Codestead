import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  ContentRepository,
  type CodeAssessmentItem,
} from "../src/lib/content";
import {
  JAVA_PYTHON_CODE_TASKS,
  type JavaPythonCodeTask,
} from "./content-seeds/java-python-code-tasks";
import {
  projectRuntimeIdentityEvidence,
  validateLocalRuntimeIdentity,
  type LocalRuntimeIdentityEvidence,
} from "./lib/local-runtime-identity";
import { verifyOrApplyDeterministicEvidence } from "./lib/deterministic-evidence";
import {
  executePinnedCurriculumReference,
  normalizeProgramOutput,
  PINNED_CURRICULUM_RUNTIMES,
  pinnedDockerAvailable,

  type PinnedCurriculumLanguage,
} from "./pinned-curriculum-runtime";

const root = process.cwd();

const FOUNDATIONS_CODE_TASKS = {
  "pf.state.variables": {
    prompt: "Complete the Python program so it reads an integer start value, adds 3 to the same named state, doubles that updated value, and prints only the final integer.",
    starterCode: "value = int(input())\n# Update value twice, then print it.\n",
    referenceSolution: "value = int(input())\nvalue = value + 3\nvalue = value * 2\nprint(value)\n",
    explanation: "Assignment first stores start plus three; the next expression reads that updated state, doubles it, and output exposes the final value.",
    tests: [
      { stdin: "4\n", expectedStdout: "14\n", category: "normal" },
      { stdin: "0\n", expectedStdout: "6\n", category: "boundary" },
      { stdin: "-5\n", expectedStdout: "-4\n", category: "boundary" },
    ],
  },
} as const satisfies Readonly<Record<string, JavaPythonCodeTask>>;

const PINNED_LANGUAGE_CODE_TASKS = {
  ...JAVA_PYTHON_CODE_TASKS,
  ...FOUNDATIONS_CODE_TASKS,
} as const satisfies Readonly<Record<string, JavaPythonCodeTask>>;

function sourceHash(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function asPinnedLanguage(value: string): PinnedCurriculumLanguage {
  if (value === "java" || value === "python") return value;
  throw new Error(`Unsupported Java/Python authored language: ${value}`);
}

function equalTests(item: CodeAssessmentItem, task: JavaPythonCodeTask) {
  if (item.tests.length !== task.tests.length) return false;
  return item.tests.every((test, index) => {
    const expected = task.tests[index];
    return expected !== undefined &&
      test.stdin === expected.stdin &&
      test.expectedStdout === expected.expectedStdout &&
      test.category === expected.category &&
      test.comparison === "trimmed" &&
      test.visibility === (index === 0 ? "visible" : "hidden");
  });
}

async function main(): Promise<void> {
  const authored = await new ContentRepository({ contentRoot: path.join(root, "content") })
    .getAuthoredContentSet();
  const allCodeItems = authored.assessmentBanks
    .flatMap((bank) => bank.items)
    .filter((item): item is CodeAssessmentItem => item.kind === "code");
  const tasks = Object.entries(PINNED_LANGUAGE_CODE_TASKS).sort(([left], [right]) => left.localeCompare(right));
  const issues: string[] = [];
  const matched: Array<{ skillId: string; item: CodeAssessmentItem }> = [];

  for (const [skillId, task] of tasks) {
    const candidates = allCodeItems.filter((item) => item.skillId === skillId);
    if (candidates.length !== 1) {
      issues.push(`${skillId}: expected exactly one authored code item, received ${candidates.length}`);
      continue;
    }
    const item = candidates[0]!;
    if (item.runtime.engine !== "isolated-runner") {
      issues.push(`${skillId}: runtime is not the isolated runner`);
      continue;
    }
    const language = asPinnedLanguage(item.runtime.language);
    const expectedRuntime = PINNED_CURRICULUM_RUNTIMES[language];
    if (item.runtime.version !== expectedRuntime.version) issues.push(`${skillId}: runtime version mismatch`);
    if (item.runtime.entrypoint !== expectedRuntime.entrypoint) issues.push(`${skillId}: entrypoint mismatch`);
    if (item.runtime.imageDigest !== expectedRuntime.imageDigest) issues.push(`${skillId}: image digest mismatch`);
    if (item.answer.referenceSolution !== task.referenceSolution) issues.push(`${skillId}: reference solution drift`);
    if (!equalTests(item, task)) issues.push(`${skillId}: visible/hidden test contract drift`);
    if (item.examEligibility.eligible) issues.push(`${skillId}: unreviewed item is exam eligible`);
    matched.push({ skillId, item });
  }
  if (issues.length) throw new Error(`Java/Python authored runtime structure failed:\n${issues.join("\n")}`);

  const structureOnly = process.argv.includes("--structure-only");
  const limitArguments = process.argv.filter((argument) => /^--limit/.test(argument));
  if (limitArguments.length > 1 || (limitArguments[0] !== undefined && !/^--limit=[1-9]\d*$/.test(limitArguments[0]))) {
    throw new Error("--limit must be provided once as a positive integer.");
  }
  const limit = limitArguments[0] ? Number.parseInt(limitArguments[0].slice("--limit=".length), 10) : matched.length;
  const selected = matched.slice(0, limit);
  const workerArguments = process.argv.filter((argument) => /^--workers/.test(argument));
  if (workerArguments.length > 1 || (workerArguments[0] !== undefined && !/^--workers=[1-8]$/.test(workerArguments[0]))) {
    throw new Error("--workers must be provided once from 1 through 8.");
  }
  const workerCount = workerArguments[0] ? Number.parseInt(workerArguments[0].slice("--workers=".length), 10) : 2;

  let runtimeIdentities: Readonly<Record<string, LocalRuntimeIdentityEvidence>> = {};
  let imageEvidence: Readonly<Record<string, unknown>> = Object.fromEntries(
    (["java", "python"] as const).map((language) => [language, {
      tag: PINNED_CURRICULUM_RUNTIMES[language].tag,
      manifestDigest: PINNED_CURRICULUM_RUNTIMES[language].imageDigest,
      configDigest: null,
      immutableReference: null,
      tagDescriptorDigest: null,
      tagImageId: null,
      exactReferenceDescriptorDigest: null,
      exactReferenceImageId: null,
      independentlyValidated: false,
    }]),
  );
  if (!structureOnly && !pinnedDockerAvailable()) {
    throw new Error("Docker is unavailable; --structure-only is permitted only when runtime execution is intentionally deferred.");
  }
  if (!structureOnly) {
    const runtimeManifest = JSON.parse(await readFile(
      path.join(root, "services", "runner", "dist", "runtime-local-build-identities.json"),
      "utf8",
    )) as unknown;
    runtimeIdentities = validateLocalRuntimeIdentity({
      manifest: runtimeManifest,
      expectations: (["java", "python"] as const).map((language) => ({
        language,
        tag: PINNED_CURRICULUM_RUNTIMES[language].tag,
        declaredContentDigest: PINNED_CURRICULUM_RUNTIMES[language].imageDigest,
      })),
    });
    imageEvidence = Object.fromEntries((["java", "python"] as const).map((language) => {
      const runtimeIdentity = runtimeIdentities[language];
      if (!runtimeIdentity) throw new Error(`Validated local runtime identity is missing for ${language}.`);
      return [language, projectRuntimeIdentityEvidence(runtimeIdentity)];
    }));
  }

  const jobs = selected.flatMap(({ skillId, item }) => item.tests.map((test) => ({ skillId, item, test })));
  const results: Array<{
    skillId: string;
    itemId: string;
    testId: string;
    language: string;
    visibility: string;
    status: "passed" | "failed";
    durationMs: number;
    sourceHash: string;
    failure?: string;
  }> = [];
  let cursor = 0;
  async function worker() {
    for (;;) {
      const index = cursor++;
      if (index >= jobs.length) return;
      const { skillId, item, test } = jobs[index]!;
      const started = Date.now();
      try {
        if (item.runtime.engine !== "isolated-runner") throw new Error("runtime changed after validation");
        const language = asPinnedLanguage(item.runtime.language);
        const runtimeIdentity = runtimeIdentities[language];
        if (!runtimeIdentity) throw new Error(`Validated local runtime identity is missing for ${language}.`);
        const executed = await executePinnedCurriculumReference({
          language,
          imageReference: runtimeIdentity.immutableReference,
          source: item.answer.referenceSolution,
          stdin: test.stdin,
          timeLimitMs: item.runtime.timeLimitMs,
          memoryLimitMb: item.runtime.memoryLimitMb,
        });
        const actual = normalizeProgramOutput(executed.stdout);
        const expected = normalizeProgramOutput(test.expectedStdout);
        if (executed.timedOut || executed.code !== 0 || actual !== expected) {
          throw new Error(executed.timedOut ? "timeout" : executed.code !== 0 ? `runner exit ${executed.code}` : "stdout mismatch");
        }
        results.push({
          skillId,
          itemId: item.id,
          testId: test.id,
          language: item.runtime.language,
          visibility: test.visibility,
          status: "passed",
          durationMs: Date.now() - started,
          sourceHash: sourceHash(item.answer.referenceSolution),
        });
      } catch (error) {
        results.push({
          skillId,
          itemId: item.id,
          testId: test.id,
          language: item.runtime.engine === "isolated-runner" ? item.runtime.language : "invalid",
          visibility: test.visibility,
          status: "failed",
          durationMs: Date.now() - started,
          sourceHash: sourceHash(item.answer.referenceSolution),
          failure: error instanceof Error ? error.message : String(error),
        });
      }
      if (results.length % 20 === 0 || results.length === jobs.length) {
        console.log(`Java/Python pinned-runtime progress: ${results.length}/${jobs.length} cases.`);
      }
    }
  }
  if (!structureOnly) await Promise.all(Array.from({ length: workerCount }, () => worker()));
  results.sort((left, right) => left.itemId.localeCompare(right.itemId) || left.testId.localeCompare(right.testId));
  const failures = results.filter((result) => result.status === "failed");
  const fullRuntimeRun = !structureOnly && selected.length === matched.length;
  const buildEvidence = (generatedAt: string) => ({
    schemaVersion: 1,
    generatedAt,
    scope: "Programming Foundations, Java 21 and Python 3.14 authored code-task pinned-runtime evidence",
    status: failures.length === 0 && fullRuntimeRun ? "verified" : structureOnly ? "structure-only" : "failed-or-partial",
    counts: {
      javaTasks: matched.filter(({ item }) => item.runtime.engine === "isolated-runner" && item.runtime.language === "java").length,
      pythonTasks: matched.filter(({ skillId }) => skillId.startsWith("python.")).length,
      foundationTasks: matched.filter(({ skillId }) => skillId.startsWith("pf.")).length,
      selectedTasks: selected.length,
      declaredTasks: matched.length,
      executedCases: results.length,
      passedCases: results.length - failures.length,
      failedCases: failures.length,
    },
    fullRuntimeRun,
    externalProviderCalls: 0,
    imageEvidence,
    results,
    limitations: [
      "All items remain AI-assisted drafts with null human reviewer and zero formal-exam eligibility.",
      "Local Docker image IDs prove this workstation run only; production KVM/NUC deployment and CVE clearance remain separate gates.",
    ],
  });
  const reportName = structureOnly
    ? "java-python-executable-structure-2026-07-12.json"
    : fullRuntimeRun
      ? "java-python-executable-runtime-2026-07-12.json"
      : "java-python-executable-sample-2026-07-12.json";
  await verifyOrApplyDeterministicEvidence({
    argv: process.argv.slice(2),
    root,
    trustedDirectory: "exclusive-writer",
    relativePath: path.join("docs", "evidence", reportName),
    buildEvidence,
    applyCommand: structureOnly
      ? "npm run java-python:executable:structure:apply"
      : fullRuntimeRun
        ? "npm run java-python:executable:evidence:apply"
        : `npm run java-python:executable:evidence:apply -- --limit=${selected.length}`,
    allowArgument: (argument) => argument === "--structure-only" || /^--limit=[1-9]\d*$/.test(argument) || /^--workers=[1-8]$/.test(argument),
  });
  console.log(`Foundations/Java/Python ${structureOnly ? "structure" : "runtime"} verification: ${matched.length} tasks, ${results.length} cases, ${failures.length} failures, full=${fullRuntimeRun}.`);
  if (failures.length || (process.argv.includes("--check") && !structureOnly && !fullRuntimeRun)) {
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
