import { createHash, createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { vi } from "vitest";
import * as examRunner from "@/lib/runner/exam-client";
import { RunnerClient } from "@/lib/runner/client";

import { DockerJobExecutor } from "../../services/runner/src/docker-executor";
import { processResult, testConfig } from "../../services/runner/src/__tests__/fixtures";
import { validateJobRequest } from "../../services/runner/src/validation";
import type { ExamFormSnapshot, ExamRunnerResult } from "@/lib/exams/contracts";
import { gradeExamSubmission } from "@/app/api/exams/_lib/policy";
import { runtimeByLanguage, serializeRunnerRequest, type RunnerLanguage, type RunnerRequest } from "@/lib/runner/client";
import { PISTON_RUNTIMES } from "@/lib/runner/piston-client";

export const IMAGE = `sha256:${"a".repeat(64)}`;
const SECRET = "provider-parity-test-secret-at-least-32-bytes";
export const languages = Object.keys(runtimeByLanguage) as RunnerLanguage[];
export const outcomes = ["accepted", "wrong_answer", "runtime_error", "timeout", "memory_limit", "output_limit"] as const;
export type Outcome = typeof outcomes[number] | "compile_error";

export const tests = [
  { id: "visible", visibility: "VISIBLE" as const, category: "functional", stdin: "visible\n", expectedStdout: "ok\n", comparison: "EXACT" as const, critical: false },
  { id: "hidden", visibility: "HIDDEN" as const, category: "edge", stdin: "hidden\n", expectedStdout: "ok\n", comparison: "TRIMMED" as const, critical: true },
];

export function version(provider: string, language: RunnerLanguage) {
  return provider === "piston" ? PISTON_RUNTIMES[language].label : runtimeByLanguage[language].version;
}

function stage(outcome: Outcome, hidden: boolean) {
  const base = { stdout: "ok\n", stderr: "", code: 0, signal: null as NodeJS.Signals | null, status: null as string | null };
  if (outcome === "wrong_answer") return { ...base, stdout: hidden ? "wrong\n" : "ok\n" };
  if (outcome === "runtime_error") return { ...base, stdout: "", code: 3, status: "RE" };
  if (outcome === "timeout") return { ...base, stdout: "", code: null, signal: "SIGKILL" as const, status: "TO" };
  if (outcome === "memory_limit") return { ...base, stdout: "", code: 137, signal: "SIGKILL" as const };
  if (outcome === "output_limit") return { ...base, stdout: "", code: 1, status: "OL" };
  return base;
}

/** Real legacy grading/aggregation, with process outcomes injected (no Docker).
 * Real HMAC/trust client and real Piston adapter, with HTTP stages injected.
 * This proves caller/normalization parity, not live toolchain equivalence.
 */
export function transport(provider: string, outcome: Outcome, persistedRequest?: RunnerRequest, imageDigest = IMAGE) {
  vi.stubEnv("CODE_RUNNER_PROVIDER", provider);
  vi.stubEnv("RUNNER_BASE_URL", "http://legacy:4100");
  vi.stubEnv("RUNNER_SHARED_SECRET", SECRET);
  vi.stubEnv("PISTON_URL", "http://piston:2000");
  vi.stubEnv("PISTON_IMAGE", imageDigest);
  const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    if (String(url).startsWith("http://legacy:")) {
      const request = init?.body ? JSON.parse(String(init.body)) as RunnerRequest : persistedRequest!;
      const root = await mkdtemp(path.join(os.tmpdir(), "provider-parity-"));
      try {
        const config = testConfig({ tempRoot: root });
        const configured = { ...config, runtimes: { ...config.runtimes,
          [request.language]: { ...config.runtimes[request.language], imageDigest } } };
        let compiled = false;
        const executor = new DockerJobExecutor(configured, {
          async run(process) {
            if (process.args[0] === "rm") return processResult();
            if (!compiled) {
              compiled = true;
              return processResult(outcome === "compile_error" ? { exitCode: 1, stderr: "compile failed" } : {});
            }
            const value = stage(outcome, process.stdin === "hidden\n");
            return processResult({ stdout: value.stdout, stderr: value.stderr, exitCode: value.code,
              signal: value.signal, timedOut: value.status === "TO", outputLimitExceeded: value.status === "OL" });
          },
        }, () => 1_000);
        const hash = createHash("sha256").update(serializeRunnerRequest(request)).digest("hex");
        const result = await executor.execute(validateJobRequest(request, configured), hash);
        const jobId = init?.method === "GET" ? String(url).split("/").at(-1)! : "legacy-job";
        const raw = JSON.stringify({ jobId, submissionId: request.submissionId,
          correlationId: request.correlationId, requestHash: hash, state: "COMPLETED", queuePosition: null, result });
        const requestId = (init?.headers as Record<string, string>)["x-request-id"];
        const signature = createHmac("sha256", SECRET).update(`${requestId}\n200\n${createHash("sha256").update(raw).digest("hex")}`).digest("hex");
        return new Response(raw, { headers: { "x-runner-response-signature": `sha256=${signature}` } });
      } finally {
        if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith("provider-parity-")) throw new Error("Invalid fixture root");
        await rm(root, { recursive: true, force: true });
      }
    }
    if (!String(url).startsWith("http://piston:")) throw new Error(`Unexpected URL ${String(url)}`);
    const request = JSON.parse(String(init?.body)) as { files: Array<{ name: string }>; stdin: string };
    const compile = { stdout: "", stderr: outcome === "compile_error" ? "compile failed" : "", code: outcome === "compile_error" ? 1 : 0, signal: null, status: null };
    const checker = request.files[0]?.name.startsWith("__codestead_check");
    return Response.json({ compile: checker ? undefined : compile, run: checker ? compile : stage(outcome, request.stdin === "hidden\n") });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

export function score(result: ExamRunnerResult, language: RunnerLanguage) {
  const form: ExamFormSnapshot = {
    schemaVersion: 1, formId: "form", seed: "seed", courseId: "course", courseTitle: "Course",
    moduleId: "module", moduleTitle: "Module", contentVersion: "v1", policyVersion: "formal-exam-v1",
    durationMinutes: 10, generatedAt: "2026-10-01T00:00:00Z", instructions: [],
    integrityDisclosure: { version: "v1", summary: "events", capturedEvents: [], notCaptured: [] },
    items: [{ id: "item", skillId: "skill", clusterId: "cluster", title: "Code", prompt: "Code",
      kind: "code", points: 100, critical: true, language,
      gradingEvidence: { kind: "runner-tests", bundleVersion: "v1", tests } }],
  };
  return gradeExamSubmission({ form, answers: { item: { sourceCode: "source", language } },
    runnerResults: { item: result }, finalizedAt: "2026-10-01T00:00:00Z", finalizedBy: "learner-submit" });
}

export function verdict(result: ExamRunnerResult) {
  return { status: result.status, compile: result.compile.status, tests: result.tests, totals: result.totals };
}

/** Test-only oracle retained until 6b; never enables native production routing. */
export async function withNativeRunnerBaseline<T>(operation: () => Promise<T>): Promise<T> {
  const baseline = vi.spyOn(examRunner, "configuredExamRunnerClient")
    .mockImplementationOnce(() => new RunnerClient("http://legacy:4100", SECRET) as unknown as ReturnType<typeof examRunner.configuredExamRunnerClient>);
  try { return await operation(); }
  finally { baseline.mockRestore(); }
}

export async function nativePracticeBaseline(request: RunnerRequest, outcome: Outcome) {
  transport("legacy", outcome);
  const job = await new RunnerClient("http://legacy:4100", SECRET).submit(request, "native-baseline");
  if (!job.result) throw new Error("Missing native baseline result");
  return job.result;
}
