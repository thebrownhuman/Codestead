import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

import {
  configuredPracticeRunnerClient,
  isTrustedRunnerJob,
  RunnerClient,
  runtimeByLanguage,
  type RunnerLanguage,
  type RunnerRequest,
} from "../client";
import { PISTON_RUNTIMES, PistonRunnerClient } from "../piston-client";
import { PRACTICE_LIMITS } from "../practice-dispatch";
import { DockerJobExecutor } from "../../../../services/runner/src/docker-executor";
import { validateJobRequest } from "../../../../services/runner/src/validation";
import { jobRequest, processResult, testConfig } from "../../../../services/runner/src/__tests__/fixtures";

const IMAGE = "codestead-piston:test@sha256:" + "a".repeat(64);
const languages: RunnerLanguage[] = ["c", "cpp", "java", "python", "javascript"];

type PistonStage = {
  stdout?: string;
  stderr?: string;
  code?: number | null;
  signal?: string | null;
  status?: string | null;
  message?: string | null;
  memory?: number;
  wall_time?: number;
};
type PistonCall = {
  language: string;
  version: string;
  files: Array<{ name: string; content: string }>;
  stdin: string;
  run_timeout: number;
  compile_timeout: number;
  run_memory_limit: number;
};

function stage(overrides: PistonStage = {}) {
  return {
    stdout: "",
    stderr: "",
    code: 0,
    signal: null,
    status: null,
    message: null,
    memory: 1000,
    wall_time: 5,
    ...overrides,
  };
}

function fakePiston(handler: (call: PistonCall) => { compile?: PistonStage; run: PistonStage } | Response) {
  const calls: PistonCall[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/api/v2/runtimes")) {
      return Response.json(Object.values(PISTON_RUNTIMES).map((runtime) => ({
        language: runtime.language,
        version: runtime.version,
        aliases: [],
      })));
    }
    const call = JSON.parse(String(init?.body)) as PistonCall;
    calls.push(call);
    const outcome = handler(call);
    if (outcome instanceof Response) return outcome;
    return Response.json({
      language: call.language,
      version: call.version,
      ...(outcome.compile ? { compile: stage(outcome.compile) } : {}),
      run: stage(outcome.run),
    });
  });
  return { calls, fetchImpl: fetchImpl as unknown as typeof fetch };
}

function request(language: RunnerLanguage, mode: RunnerRequest["mode"] = "RUN", extra: Partial<RunnerRequest> = {}): RunnerRequest {
  const runtime = runtimeByLanguage[language];
  return {
    submissionId: "11111111-1111-4111-8111-111111111111",
    correlationId: "practice:22222222-2222-4222-8222-222222222222",
    language,
    runtimeVersion: runtime.version,
    mode,
    sourceFiles: [{ path: runtime.entrypoint, content: "source" }],
    entrypoint: runtime.entrypoint,
    stdin: "x\n",
    limits: { ...PRACTICE_LIMITS },
    ...extra,
  };
}

function client(fetchImpl: typeof fetch) {
  return new PistonRunnerClient("http://piston:2000", IMAGE, fetchImpl);
}

const isCheckCall = (call: PistonCall) => call.files[0]?.name.startsWith("__codestead_check");

describe("legacy job budget parity", () => {
  const testCase = (visibility: "VISIBLE" | "HIDDEN", expectedStdout = "ok") => ({
    id: "budget", visibility, category: "NORMAL" as const, stdin: "", expectedStdout, comparison: "EXACT" as const,
  });
  it.each(["VISIBLE", "HIDDEN"] as const)("budgets %s stderr before grading", async (visibility) => {
    const piston = fakePiston((call) => ({ run: isCheckCall(call) ? {} : { stdout: "ok", stderr: "x".repeat(65_536) } }));
    const job = await client(piston.fetchImpl).submit(request("python", "TEST", { tests: [testCase(visibility)] }), "budget");
    expect(job.result?.status).toBe("OUTPUT_LIMIT");
    expect(job.result?.tests[0].status).toBe("OUTPUT_LIMIT");
    if (visibility === "HIDDEN") expect(job.result?.tests[0]).not.toHaveProperty("stderr");
  });
  it("shares output across multiple tests", async () => {
    const output = "x".repeat(40_000);
    const piston = fakePiston((call) => ({ run: isCheckCall(call) ? {} : { stdout: output } }));
    const job = await client(piston.fetchImpl).submit(request("python", "TEST", { tests: [testCase("VISIBLE", output), { ...testCase("HIDDEN", output), id: "second" }] }), "budget");
    expect(job.result?.tests.map((test) => test.status)).toEqual(["PASSED", "OUTPUT_LIMIT"]);
  });
  it("never grades an empty display projection as empty stdout", async () => {
    const piston = fakePiston((call) => ({ run: isCheckCall(call) ? {} : { stdout: "wrong output" } }));
    const job = await client(piston.fetchImpl).submit(request("python", "TEST", { limits: { ...PRACTICE_LIMITS, outputBytes: 1 }, tests: [testCase("VISIBLE", "")] }), "budget");
    expect(job.result?.status).toBe("OUTPUT_LIMIT");
  });
  it("clamps each run to the remaining reported run budget", async () => {
    let now = 1000;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      const piston = fakePiston(() => { now += 1000; return { run: { stdout: "ok", wall_time: 1000 } }; });
      await client(piston.fetchImpl).submit(request("python", "TEST", { limits: { ...PRACTICE_LIMITS, wallTimeMs: 2500 }, tests: [testCase("VISIBLE"), { ...testCase("HIDDEN"), id: "second" }] }), "budget");
      expect(piston.calls.map((call) => [call.run_timeout, call.compile_timeout])).toEqual([[2500, 10000], [1500, 10000], [500, 10000]]);
    } finally { clock.mockRestore(); }
  });
  it.each(["java", "cpp"] as const)("accepts five %s tests despite repeated compilation and transport time", async (language) => {
    let now = 1000;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      const piston = fakePiston(() => {
        now += 1700;
        return { compile: { wall_time: 1500 }, run: { stdout: "ok", wall_time: 50 } };
      });
      const tests = Array.from({ length: 5 }, (_, index) => ({ ...testCase("HIDDEN"), id: `test-${index}` }));
      const job = await client(piston.fetchImpl).submit(request(language, "TEST", { tests }), "budget");
      expect(job.result?.status).toBe("ACCEPTED");
      expect(job.result?.totals.passed).toBe(5);
      expect(piston.calls).toHaveLength(6);
      expect(piston.calls.every((call) => call.compile_timeout === 10000)).toBe(true);
    } finally { clock.mockRestore(); }
  });
  it("times out when reported runs exceed the budget even with a stationary clock", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
    try {
      const piston = fakePiston(() => ({ run: { stdout: "ok", wall_time: 1000 } }));
      const tests = Array.from({ length: 3 }, (_, index) => ({ ...testCase("VISIBLE"), id: `test-${index}` }));
      const job = await client(piston.fetchImpl).submit(request("python", "TEST", { limits: { ...PRACTICE_LIMITS, wallTimeMs: 2500 }, tests }), "budget");
      expect(job.result?.tests.map((test) => test.status)).toEqual(["PASSED", "TIMEOUT", "TIMEOUT"]);
      expect(piston.calls.map((call) => call.run_timeout)).toEqual([2500, 1500, 500]);
    } finally { clock.mockRestore(); }
  });
  it.each([
    { stdout: "😀".repeat(20), expected: "", status: null, result: "OUTPUT_LIMIT" },
    { stdout: "\n<output truncated>", expected: "\n<output truncated>", status: null, result: "ACCEPTED" },
    { stdout: "x".repeat(100), expected: "", status: "TO", result: "TIMEOUT" },
  ])("keeps grading independent of projection: $result / $status", async ({ stdout, expected, status, result }) => {
    const piston = fakePiston((call) => ({ run: isCheckCall(call) ? {} : { stdout, status } }));
    const job = await client(piston.fetchImpl).submit(request("python", "TEST", { limits: { ...PRACTICE_LIMITS, outputBytes: 24 }, tests: [testCase("VISIBLE", expected)] }), "budget");
    expect(job.result?.status).toBe(result);
    expect(JSON.stringify(job.result?.tests[0])).not.toContain("\uFFFD");
  });
  it("charges compile output to the job budget", async () => {
    const piston = fakePiston((call) => ({ run: isCheckCall(call) ? { stdout: "x".repeat(65_535) } : { stdout: "ok" } }));
    const job = await client(piston.fetchImpl).submit(request("python", "TEST", { tests: [testCase("HIDDEN")] }), "budget");
    expect(job.result?.status).toBe("OUTPUT_LIMIT");
  });
  it("reports compile output overflow before compile success", async () => {
    const piston = fakePiston(() => ({ run: { stderr: "x".repeat(65_537) } }));
    const job = await client(piston.fetchImpl).submit(request("python", "COMPILE"), "budget");
    expect(job.result?.status).toBe("OUTPUT_LIMIT");
    expect(piston.calls).toHaveLength(1);
  });
  it("budgets repeated native compilation without exposing hidden diagnostics", async () => {
    let calls = 0;
    const piston = fakePiston(() => ({ compile: calls++ === 0 ? {} : { stderr: "hidden diagnostic".repeat(4096) }, run: { stdout: "ok" } }));
    const job = await client(piston.fetchImpl).submit(request("c", "TEST", { tests: [testCase("HIDDEN")] }), "budget");
    expect(job.result?.status).toBe("OUTPUT_LIMIT");
    expect(JSON.stringify(job)).not.toContain("hidden diagnostic");
  });
  it("stops dispatching when reported run time exhausts the budget, ahead of output exhaustion", async () => {
    let now = 1000;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      const piston = fakePiston((call) => {
        if (!isCheckCall(call)) now += 3000;
        return { run: isCheckCall(call) ? {} : { stdout: "x".repeat(65_537), wall_time: 3000 } };
      });
      const job = await client(piston.fetchImpl).submit(request("python", "TEST", { limits: { ...PRACTICE_LIMITS, wallTimeMs: 2500 }, tests: [testCase("VISIBLE"), { ...testCase("HIDDEN"), id: "second" }] }), "budget");
      expect(job.result?.tests.map((test) => test.status)).toEqual(["TIMEOUT", "TIMEOUT"]);
      expect(piston.calls).toHaveLength(2);
    } finally { clock.mockRestore(); }
  });
  it.each(["VISIBLE", "HIDDEN"] as const)("matches DockerJobExecutor output accounting for %s tests", async (visibility) => {
    const tests = [testCase(visibility), { ...testCase(visibility), id: "second" }];
    const config = testConfig();
    let step = 0;
    const legacy = await new DockerJobExecutor(config, {
      async run(call) {
        if (call.args[0] === "rm") return processResult();
        if (step++ === 0) return processResult();
        return processResult({ stdout: "ok", stderr: "x".repeat(65_536), outputLimitExceeded: 65_538 > call.maxOutputBytes });
      },
    }).execute(validateJobRequest(jobRequest("python", { mode: "TEST", stdin: undefined, testBundleVersion: "budget-1", tests, limits: PRACTICE_LIMITS }), config), "a".repeat(64));
    const piston = fakePiston((call) => ({ run: isCheckCall(call) ? {} : { stdout: "ok", stderr: "x".repeat(65_536) } }));
    const job = await client(piston.fetchImpl).submit(request("python", "TEST", { tests }), "budget");
    expect(job.result?.status).toBe(legacy.status);
    expect(job.result?.tests.map((test) => [test.status, test.feedbackCode])).toEqual(legacy.tests.map((test) => [test.status, test.feedbackCode]));
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

it("uses the exact runtime inventory recorded in the reviewed image lock", () => {
  const lock = JSON.parse(readFileSync("infra/piston/image-inputs.lock.json", "utf8"));
  expect(PISTON_RUNTIMES).toEqual(lock.runtimes);
});

it.each(["c", "cpp", "java"] as const)("rejects a missing %s compile stage instead of fabricating OK", async (language) => {
  const piston = fakePiston(() => ({ run: { code: 0 } }));
  await expect(client(piston.fetchImpl).submit(request(language), "id"))
    .rejects.toMatchObject({ code: "PISTON_RESPONSE_UNTRUSTED" });
});

it("uses Java's real compile stage and never sends the old source-launcher shim", async () => {
  const piston = fakePiston(() => ({ compile: { code: 1, stderr: "javac error" }, run: { code: 0 } }));
  const job = await client(piston.fetchImpl).submit(request("java"), "id");
  expect(job.result?.status).toBe("COMPILE_ERROR");
  expect(job.result?.compile.stderr).toBe("javac error");
  expect(job.result?.run).toBeUndefined();
  expect(piston.calls).toHaveLength(1);
  expect(piston.calls[0]?.files).toEqual([{ name: "Main.java", content: "source" }]);
});

describe("Piston practice runner client", () => {
  it.each(languages)("returns a trusted legacy-shaped ACCEPTED result for %s", async (language) => {
    const piston = fakePiston((call) => isCheckCall(call)
      ? { run: { code: 0 } }
      : { ...(["c", "cpp", "java"].includes(language) ? { compile: { code: 0 } } : {}), run: { stdout: "x\nhello\n" } });
    const runnerRequest = request(language);
    const job = await client(piston.fetchImpl).submit(runnerRequest, "33333333-3333-4333-8333-333333333333");

    expect(job.state).toBe("COMPLETED");
    expect(job.result?.status).toBe("ACCEPTED");
    expect(job.result?.run).toMatchObject({ stdout: "x\nhello\n", stderr: "", exitCode: 0 });
    expect(job.result?.imageDigest).toBe(IMAGE);
    expect(isTrustedRunnerJob(job, runnerRequest)).toBe(true);
    const runCall = piston.calls.at(-1)!;
    expect(runCall).toMatchObject({
      language: PISTON_RUNTIMES[language].language,
      version: PISTON_RUNTIMES[language].version,
      stdin: "x\n",
      run_memory_limit: PRACTICE_LIMITS.memoryMb * 1024 * 1024,
    });
    expect(runCall.run_timeout).toBeLessThanOrEqual(PRACTICE_LIMITS.wallTimeMs);
    expect(runCall.files.map((file) => file.content)).toContain("source");
  });

  it.each([
    ["c", { compile: { code: 1, stderr: "/box/submission/main.c:1: error: x undeclared" }, run: { code: null } }],
    ["cpp", { compile: { code: 1, stderr: "/box/submission/main.cpp:1: error" }, run: { code: null } }],
  ] as const)("maps a %s compiler failure to COMPILE_ERROR without running", async (language, outcome) => {
    const piston = fakePiston(() => outcome);
    const job = await client(piston.fetchImpl).submit(request(language), "id");
    expect(job.result?.status).toBe("COMPILE_ERROR");
    expect(job.result?.compile.status).toBe("COMPILE_ERROR");
    expect(job.result?.compile.stderr).not.toContain("/box/submission");
    expect(job.result?.compile.stderr).toContain("<workspace>");
    expect(job.result?.run).toBeUndefined();
  });

  it.each(["python", "javascript"] as const)(
    "checks %s syntax first and reports COMPILE_ERROR without running the program",
    async (language) => {
      const piston = fakePiston((call) => isCheckCall(call)
        ? { run: { code: 1, stderr: "SyntaxError: invalid syntax" } }
        : { run: { stdout: "should not run" } });
      const job = await client(piston.fetchImpl).submit(request(language), "id");
      expect(job.result?.status).toBe("COMPILE_ERROR");
      expect(job.result?.compile).toMatchObject({ status: "COMPILE_ERROR", exitCode: 1 });
      expect(job.result?.compile.stderr).toContain("SyntaxError");
      expect(piston.calls).toHaveLength(1);
      expect(piston.calls[0]!.files.some((file) => file.content === "source")).toBe(true);
    },
  );

  it.each([
    [{ status: "TO", code: null, signal: "SIGKILL" }, "TIMEOUT"],
    [{ status: "RE", code: 137 }, "MEMORY_LIMIT"],
    [{ status: "OL", code: null, signal: "SIGKILL", stdout: "y".repeat(100) }, "OUTPUT_LIMIT"],
    [{ status: "EL", code: null, signal: "SIGKILL" }, "OUTPUT_LIMIT"],
    [{ status: "RE", code: 3, stderr: "boom" }, "RUNTIME_ERROR"],
    [{ status: "XX", code: null, message: "internal" }, "INFRASTRUCTURE_ERROR"],
  ] as const)("maps Piston run outcome %j to %s", async (outcome, expected) => {
    const piston = fakePiston((call) => isCheckCall(call) ? { run: { code: 0 } } : { run: outcome });
    const runnerRequest = request("python");
    const job = await client(piston.fetchImpl).submit(runnerRequest, "id");
    expect(job.result?.status).toBe(expected);
    expect(isTrustedRunnerJob(job, runnerRequest)).toBe(true);
  });

  it("caps combined output at the requested byte limit on our side", async () => {
    const piston = fakePiston((call) => isCheckCall(call)
      ? { run: { code: 0 } }
      : { run: { stdout: "o".repeat(70_000), stderr: "e".repeat(70_000) } });
    const runnerRequest = request("python");
    const job = await client(piston.fetchImpl).submit(runnerRequest, "id");
    const run = job.result!.run!;
    expect(Buffer.byteLength(run.stdout) + Buffer.byteLength(run.stderr)).toBeLessThanOrEqual(PRACTICE_LIMITS.outputBytes);
    expect(job.result?.status).toBe("OUTPUT_LIMIT");
    expect(isTrustedRunnerJob(job, runnerRequest)).toBe(true);
  });

  it("compiles only in COMPILE mode", async () => {
    const piston = fakePiston((call) => isCheckCall(call) ? { run: { code: 0 } } : { run: { stdout: "ran" } });
    const job = await client(piston.fetchImpl).submit(request("python", "COMPILE"), "id");
    expect(job.result?.status).toBe("COMPILE_ONLY");
    expect(job.result?.run).toBeUndefined();
    expect(piston.calls.every(isCheckCall)).toBe(true);
  });

  it("grades TEST mode in the app, sending only each test's stdin", async () => {
    const piston = fakePiston((call) => isCheckCall(call)
      ? { run: { code: 0 } }
      : { run: { stdout: call.stdin === "1\n" ? "2\n" : "wrong\n" } });
    const tests = [
      { id: "t1", visibility: "VISIBLE" as const, category: "basic", stdin: "1\n", expectedStdout: "2\n", comparison: "EXACT" as const },
      { id: "t2", visibility: "HIDDEN" as const, category: "edge", stdin: "5\n", expectedStdout: "10", comparison: "TRIMMED" as const },
    ];
    const runnerRequest = request("python", "TEST", { tests, stdin: undefined });
    const job = await client(piston.fetchImpl).submit(runnerRequest, "id");

    expect(job.result?.status).toBe("WRONG_ANSWER");
    expect(job.result?.totals).toEqual({ passed: 1, failed: 1, total: 2 });
    expect(job.result?.tests.map((test) => [test.id, test.status, test.feedbackCode])).toEqual([
      ["t1", "PASSED", "VISIBLE_PASS"],
      ["t2", "FAILED", "HIDDEN_WRONG_ANSWER"],
    ]);
    expect(job.result?.tests[1]).not.toHaveProperty("expectedStdout");
    expect(piston.calls.flatMap((call) => [call.stdin, ...call.files.map((file) => file.content)]).join("\n")).not.toContain("10");
    expect(isTrustedRunnerJob(job, runnerRequest)).toBe(true);
  });

  it("fails closed on a Piston HTTP error instead of inventing a result", async () => {
    const piston = fakePiston(() => new Response(JSON.stringify({ message: "runtime is unknown" }), { status: 400 }));
    await expect(client(piston.fetchImpl).submit(request("python"), "id")).rejects.toMatchObject({
      code: "PISTON_REQUEST_REJECTED",
      retryable: false,
    });
  });

  it("fails closed when Piston is unreachable", async () => {
    const fetchImpl = vi.fn(async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch;
    await expect(client(fetchImpl).submit(request("python"), "id")).rejects.toMatchObject({ code: "PISTON_UNREACHABLE" });
  });

  it("rejects an oversized or malformed Piston response", async () => {
    const big = fakePiston(() => new Response("x".repeat(3 * 1024 * 1024), { status: 200 }));
    await expect(client(big.fetchImpl).submit(request("python"), "id")).rejects.toMatchObject({ code: "PISTON_RESPONSE_UNTRUSTED" });
    const bad = fakePiston(() => Response.json({ run: { stdout: 5 } }));
    await expect(client(bad.fetchImpl).submit(request("python"), "id")).rejects.toMatchObject({ code: "PISTON_RESPONSE_UNTRUSTED" });
  });

  it("aborts a Piston call that outlives our own deadline", async () => {
    const fetchImpl = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
    })) as unknown as typeof fetch;
    const shortDeadline = new PistonRunnerClient("http://piston:2000", IMAGE, fetchImpl, 50);
    await expect(shortDeadline.submit(request("python"), "id")).rejects.toMatchObject({ code: "PISTON_TIMEOUT" });
  });

  it("reports availability from the installed runtimes", async () => {
    const ok = fakePiston(() => ({ run: {} }));
    await expect(client(ok.fetchImpl).checkAvailability()).resolves.toMatchObject({ available: true, status: "available" });

    const missing = vi.fn(async () => Response.json([{ language: "python", version: "3.12.0" }])) as unknown as typeof fetch;
    await expect(client(missing).checkAvailability()).resolves.toEqual({ available: false, status: "unavailable", code: "RUNNER_UNHEALTHY" });

    const down = vi.fn(async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch;
    await expect(client(down).checkAvailability()).resolves.toEqual({ available: false, status: "offline", code: "RUNNER_OFFLINE" });
  });

  it("re-executes when asked to reconcile a job id it never stored", async () => {
    const piston = fakePiston((call) => isCheckCall(call) ? { run: { code: 0 } } : { run: { stdout: "again" } });
    const runnerRequest = request("python");
    const job = await client(piston.fetchImpl).waitForJob("piston:previous", runnerRequest);
    expect(job.jobId).toBe("piston:previous");
    expect(job.result?.run?.stdout).toBe("again");
  });
});

describe("practice runner provider selection", () => {
  it("defaults to Piston and never uses the configured legacy endpoint", () => {
    vi.stubEnv("CODE_RUNNER_PROVIDER", "");
    vi.stubEnv("RUNNER_BASE_URL", "http://runner:4100");
    vi.stubEnv("RUNNER_SHARED_SECRET", "s".repeat(40));
    vi.stubEnv("PISTON_URL", "http://piston:2000");
    vi.stubEnv("PISTON_IMAGE", IMAGE);
    expect(configuredPracticeRunnerClient()).toBeInstanceOf(PistonRunnerClient);
  });

  it("selects Piston only when explicitly configured", () => {
    vi.stubEnv("CODE_RUNNER_PROVIDER", "piston");
    vi.stubEnv("PISTON_URL", "http://piston:2000");
    vi.stubEnv("PISTON_IMAGE", IMAGE);
    expect(configuredPracticeRunnerClient()).toBeInstanceOf(PistonRunnerClient);
  });

  it("fails closed instead of falling back to legacy when Piston is selected but not configured", () => {
    vi.stubEnv("CODE_RUNNER_PROVIDER", "piston");
    vi.stubEnv("PISTON_URL", "");
    vi.stubEnv("PISTON_IMAGE", "");
    vi.stubEnv("RUNNER_BASE_URL", "http://runner:4100");
    vi.stubEnv("RUNNER_SHARED_SECRET", "s".repeat(40));
    expect(() => configuredPracticeRunnerClient()).toThrow(/Piston/);
  });

  it.each(["legacy", "judge0"])("rejects unsupported provider %s", (provider) => {
    vi.stubEnv("CODE_RUNNER_PROVIDER", provider);
    expect(() => configuredPracticeRunnerClient()).toThrow(/CODE_RUNNER_PROVIDER/);
  });
});
