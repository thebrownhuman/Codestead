import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { JobExecutor } from "../docker-executor.js";
import { RunnerService } from "../service.js";
import {
  RunnerStateJournal,
  parseRunnerState,
  type RunnerStateSnapshot,
  type RunnerStateStore,
} from "../state-journal.js";
import type { RunnerResult } from "../types.js";
import {
  jobRequest,
  runnerResult,
  testConfig,
} from "./fixtures.js";

const roots: string[] = [];
const nowMs = 1_750_000_000_000;
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function stateRoot(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "runner-journal-test-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

class ImmediateExecutor implements JobExecutor {
  calls = 0;
  readonly #result: RunnerResult;

  constructor(result: RunnerResult = runnerResult()) {
    this.#result = result;
  }

  async execute(
    _job: Parameters<JobExecutor["execute"]>[0],
    requestHash: string,
  ): Promise<RunnerResult> {
    this.calls += 1;
    return { ...this.#result, requestHash };
  }
}

class HangingExecutor implements JobExecutor {
  calls = 0;

  async execute(): Promise<RunnerResult> {
    this.calls += 1;
    return new Promise<RunnerResult>(() => undefined);
  }
}

class FailingStartStore implements RunnerStateStore {
  saves = 0;

  load(): RunnerStateSnapshot {
    return { schemaVersion: 1, jobs: [], idempotency: [] };
  }

  save(): void {
    this.saves += 1;
    if (this.saves === 3) {
      throw new Error("simulated fsync failure");
    }
  }
}

function activeSnapshot(): RunnerStateSnapshot {
  const hashOne = "a".repeat(64);
  const hashTwo = "b".repeat(64);
  return {
    schemaVersion: 1,
    jobs: [
      {
        jobId: "job-queued",
        submissionId: "submission-queued",
        correlationId: "correlation-queued",
        requestHash: hashOne,
        state: "QUEUED",
        createdAt: "2026-07-12T00:00:00.000Z",
      },
      {
        jobId: "job-running",
        submissionId: "submission-running",
        correlationId: "correlation-running",
        requestHash: hashTwo,
        state: "RUNNING",
        createdAt: "2026-07-12T00:00:00.000Z",
        startedAt: "2026-07-12T00:00:01.000Z",
      },
    ],
    idempotency: [
      {
        key: "idempotency-queued-0001",
        requestHash: hashOne,
        jobId: "job-queued",
        expiresAtMs: nowMs + 60_000,
      },
      {
        key: "idempotency-running-0001",
        requestHash: hashTwo,
        jobId: "job-running",
        expiresAtMs: nowMs + 60_000,
      },
    ],
  };
}

describe("runner state journal", () => {
  it("recovers queued and running jobs as durable retryable failures", () => {
    const root = stateRoot();
    const journal = new RunnerStateJournal(root);
    journal.save(activeSnapshot());

    const service = new RunnerService(
      testConfig({ stateRoot: root }),
      new ImmediateExecutor(),
      { clock: () => nowMs },
    );

    expect(service.getJob("job-queued")).toMatchObject({
      submissionId: "submission-queued",
      correlationId: "correlation-queued",
      requestHash: "a".repeat(64),
      state: "FAILED",
      error: {
        code: "RUNNER_RESTART_RECOVERED",
        retryable: true,
      },
    });
    expect(service.getJob("job-running")).toMatchObject({
      state: "FAILED",
      startedAt: "2026-07-12T00:00:01.000Z",
      error: {
        code: "RUNNER_RESTART_RECOVERED",
        retryable: true,
      },
    });

    const saved = journal.load();
    expect(saved.jobs.map((job) => job.state)).toEqual([
      "FAILED",
      "FAILED",
    ]);
    expect(saved.jobs[0]?.error?.code).toBe("RUNNER_RESTART_RECOVERED");
  });

  it("restores terminal results and their idempotent POST binding", async () => {
    const root = stateRoot();
    const config = testConfig({ stateRoot: root });
    const hash = "c".repeat(64);
    const key = "idempotency-terminal-0001";
    const request = jobRequest();
    const firstExecutor = new ImmediateExecutor();
    const first = new RunnerService(config, firstExecutor, {
      clock: () => nowMs,
      jobId: () => "job-terminal",
    });
    first.submit(request, key, hash);
    await flush();
    expect(first.getJob("job-terminal")?.state).toBe("COMPLETED");
    first.close();

    const secondExecutor = new ImmediateExecutor();
    const restored = new RunnerService(config, secondExecutor, {
      clock: () => nowMs,
    });
    expect(restored.getJob("job-terminal")).toMatchObject({
      state: "COMPLETED",
      result: { status: "ACCEPTED", requestHash: hash },
    });
    const replay = restored.submit(request, key, hash);
    expect(replay).toMatchObject({
      idempotencyHit: true,
      job: { jobId: "job-terminal", state: "COMPLETED" },
    });
    expect(secondExecutor.calls).toBe(0);
  });

  it("durably prunes an expired terminal job before a new submission", async () => {
    const root = stateRoot();
    let clock = nowMs;
    const config = testConfig({
      stateRoot: root,
      idempotencyTtlMs: 100,
    });
    const ids = ["job-expired", "job-fresh"];
    const service = new RunnerService(config, new ImmediateExecutor(), {
      clock: () => clock,
      jobId: () => ids.shift()!,
    });
    service.submit(
      jobRequest(),
      "idempotency-expired-0001",
      "1".repeat(64),
    );
    await flush();
    expect(service.getJob("job-expired")?.state).toBe("COMPLETED");

    clock += 101;
    service.submit(
      jobRequest("python", { submissionId: "submission-fresh" }),
      "idempotency-fresh-0001",
      "2".repeat(64),
    );
    expect(service.getJob("job-expired")).toBeUndefined();
    const saved = new RunnerStateJournal(root).load();
    expect(saved.jobs.map((job) => job.jobId)).toEqual(["job-fresh"]);
    expect(saved.idempotency.map((record) => record.jobId)).toEqual([
      "job-fresh",
    ]);
    await flush();
  });

  it("prunes an expired terminal job durably during restart", async () => {
    const root = stateRoot();
    let clock = nowMs;
    const config = testConfig({
      stateRoot: root,
      idempotencyTtlMs: 100,
    });
    const first = new RunnerService(config, new ImmediateExecutor(), {
      clock: () => clock,
      jobId: () => "job-expired-restart",
    });
    first.submit(
      jobRequest(),
      "idempotency-expired-restart",
      "3".repeat(64),
    );
    await flush();
    clock += 101;
    first.close();

    const restarted = new RunnerService(config, new ImmediateExecutor(), {
      clock: () => clock,
    });
    expect(restarted.getJob("job-expired-restart")).toBeUndefined();
    expect(new RunnerStateJournal(root).load()).toEqual({
      schemaVersion: 1,
      jobs: [],
      idempotency: [],
    });
  });

  it("retains an expired active binding through one crash recovery", async () => {
    const root = stateRoot();
    let clock = nowMs;
    const config = testConfig({
      stateRoot: root,
      idempotencyTtlMs: 100,
    });
    const hanging = new HangingExecutor();
    const first = new RunnerService(config, hanging, {
      clock: () => clock,
      jobId: () => "job-active-expired",
    });
    first.submit(
      jobRequest(),
      "idempotency-active-expired",
      "4".repeat(64),
    );
    await flush();
    expect(first.getJob("job-active-expired")?.state).toBe("RUNNING");
    expect(hanging.calls).toBe(1);

    clock += 101;
    const activeReplay = first.submit(
      jobRequest(),
      "idempotency-active-expired",
      "4".repeat(64),
    );
    expect(activeReplay).toMatchObject({
      idempotencyHit: true,
      job: { jobId: "job-active-expired", state: "RUNNING" },
    });
    expect(hanging.calls).toBe(1);
    first.close();

    const replacementExecutor = new ImmediateExecutor();
    const recovered = new RunnerService(config, replacementExecutor, {
      clock: () => clock,
    });
    expect(recovered.getJob("job-active-expired")).toMatchObject({
      state: "FAILED",
      error: {
        code: "RUNNER_RESTART_RECOVERED",
        retryable: true,
      },
    });
    const recoveredState = new RunnerStateJournal(root).load();
    expect(recoveredState.jobs).toHaveLength(1);
    expect(recoveredState.idempotency).toHaveLength(1);
    expect(recoveredState.idempotency[0]?.expiresAtMs).toBeGreaterThan(
      clock,
    );

    const recoveredReplay = recovered.submit(
      jobRequest(),
      "idempotency-active-expired",
      "4".repeat(64),
    );
    expect(recoveredReplay).toMatchObject({
      idempotencyHit: true,
      job: { jobId: "job-active-expired", state: "FAILED" },
    });
    expect(replacementExecutor.calls).toBe(0);
    expect(() =>
      recovered.submit(
        jobRequest("python", { correlationId: "changed-after-crash" }),
        "idempotency-active-expired",
        "5".repeat(64),
      ),
    ).toThrow(/different request/);

    clock += 101;
    recovered.close();
    const nextRestart = new RunnerService(config, new ImmediateExecutor(), {
      clock: () => clock,
    });
    expect(nextRestart.getJob("job-active-expired")).toBeUndefined();
    expect(new RunnerStateJournal(root).load()).toEqual({
      schemaVersion: 1,
      jobs: [],
      idempotency: [],
    });
  });

  it("journals no request bodies or execution-output canaries", async () => {
    const root = stateRoot();
    const hash = "d".repeat(64);
    const outputResult = runnerResult({
      status: "WRONG_ANSWER",
      compile: {
        status: "OK",
        exitCode: 0,
        stdout: "compiler-stdout-source-body-super-secret",
        stderr: "compiler-stderr-source-body-super-secret",
        wallTimeMs: 1,
      },
      run: {
        exitCode: 0,
        stdout: "run-stdout-hidden-stdin-secret",
        stderr: "run-stderr-hidden-stdin-secret",
        wallTimeMs: 2,
      },
      tests: [
        {
          id: "visible-case",
          visibility: "VISIBLE",
          category: "correctness",
          status: "FAILED",
          feedbackCode: "VISIBLE_WRONG_ANSWER",
          exitCode: 0,
          wallTimeMs: 2,
          actualStdout: "visible-actual-secret",
          expectedStdout: "visible-expected-secret",
          stderr: "visible-stderr-secret",
        },
        {
          id: "hidden-case",
          visibility: "HIDDEN",
          category: "correctness",
          status: "FAILED",
          feedbackCode: "HIDDEN_WRONG_ANSWER",
          exitCode: 0,
          wallTimeMs: 2,
          actualStdout: "hidden-actual-secret",
          expectedStdout: "hidden-expected-secret",
          stderr: "hidden-stderr-secret",
        },
      ],
      totals: { passed: 0, failed: 2, total: 2 },
    });
    const service = new RunnerService(
      testConfig({ stateRoot: root }),
      new ImmediateExecutor(outputResult),
      { clock: () => nowMs, jobId: () => "job-private" },
    );
    service.submit(
      jobRequest("python", {
        mode: "TEST",
        stdin: undefined,
        sourceFiles: [
          { path: "main.py", content: "source-body-super-secret" },
        ],
        tests: [
          {
            id: "visible-case",
            visibility: "VISIBLE",
            category: "correctness",
            stdin: "visible-stdin-secret",
            expectedStdout: "visible-expected-secret",
            comparison: "EXACT",
          },
          {
            id: "hidden-case",
            visibility: "HIDDEN",
            category: "correctness",
            stdin: "hidden-stdin-secret",
            expectedStdout: "hidden-expected-secret",
            comparison: "EXACT",
          },
        ],
        testBundleVersion: "bundle-1",
      }),
      "idempotency-private-0001",
      hash,
    );
    await flush();

    const live = service.getJob("job-private")?.result;
    expect(live?.compile.stderr).toBe(
      "compiler-stderr-source-body-super-secret",
    );
    expect(live?.run?.stdout).toBe("run-stdout-hidden-stdin-secret");
    expect(live?.tests[0]).toMatchObject({
      actualStdout: "visible-actual-secret",
      expectedStdout: "visible-expected-secret",
      stderr: "visible-stderr-secret",
    });

    const body = readFileSync(
      path.join(root, "runner-state-v1.json"),
      "utf8",
    );
    expect(body).toContain("job-private");
    expect(body).toContain(hash);
    expect(body).not.toContain("source-body-super-secret");
    expect(body).not.toContain("hidden-stdin-secret");
    expect(body).not.toContain("hidden-actual-secret");
    expect(body).not.toContain("hidden-expected-secret");
    expect(body).not.toContain("hidden-stderr-secret");
    expect(body).not.toContain("compiler-stdout-source-body-super-secret");
    expect(body).not.toContain("compiler-stderr-source-body-super-secret");
    expect(body).not.toContain("run-stdout-hidden-stdin-secret");
    expect(body).not.toContain("run-stderr-hidden-stdin-secret");
    expect(body).not.toContain("visible-stdin-secret");
    expect(body).not.toContain("visible-actual-secret");
    expect(body).not.toContain("visible-expected-secret");
    expect(body).not.toContain("visible-stderr-secret");
    const saved = JSON.parse(body) as RunnerStateSnapshot;
    expect(saved.jobs[0]?.result?.compile).toMatchObject({
      stdout: "",
      stderr: "",
    });
    expect(saved.jobs[0]?.result?.run).toMatchObject({
      stdout: "",
      stderr: "",
    });
    expect(saved.jobs[0]?.result?.tests[0]).toEqual({
      id: "visible-case",
      visibility: "VISIBLE",
      category: "correctness",
      status: "FAILED",
      feedbackCode: "VISIBLE_WRONG_ANSWER",
      exitCode: 0,
      wallTimeMs: 2,
    });
    expect(saved.jobs[0]?.result?.tests[1]).toEqual({
      id: "hidden-case",
      visibility: "HIDDEN",
      category: "correctness",
      status: "FAILED",
      feedbackCode: "HIDDEN_WRONG_ANSWER",
      exitCode: 0,
      wallTimeMs: 2,
    });

    service.close();
    const restarted = new RunnerService(
      testConfig({ stateRoot: root }),
      new ImmediateExecutor(),
      { clock: () => nowMs },
    );
    const recovered = restarted.getJob("job-private")?.result;
    expect(recovered?.compile).toMatchObject({ stdout: "", stderr: "" });
    expect(recovered?.run).toMatchObject({ stdout: "", stderr: "" });
    expect(recovered?.tests[0]).not.toHaveProperty("actualStdout");
    expect(recovered?.tests[0]).not.toHaveProperty("expectedStdout");
    expect(recovered?.tests[0]).not.toHaveProperty("stderr");
  });

  it("creates a private state file", () => {
    const root = stateRoot();
    const journal = new RunnerStateJournal(root);
    journal.save({ schemaVersion: 1, jobs: [], idempotency: [] });
    if (process.platform !== "win32") {
      expect(statSync(journal.filePath).mode & 0o777).toBe(0o600);
      expect(statSync(root).mode & 0o777).toBe(0o700);
    }
  });

  it("removes only safe stale job source directories before recovery", () => {
    const root = stateRoot();
    const tempRoot = stateRoot();
    const staleJob = path.join(tempRoot, "job-stale123");
    const nested = path.join(staleJob, "nested");
    mkdirSync(nested, { recursive: true, mode: 0o755 });
    writeFileSync(
      path.join(nested, "main.py"),
      "stale-source-canary-never-survives-restart",
      { encoding: "utf8", mode: 0o444 },
    );
    const unrelated = path.join(tempRoot, "operator-note");
    mkdirSync(unrelated, { mode: 0o700 });

    const service = new RunnerService(
      testConfig({ stateRoot: root, tempRoot }),
      new ImmediateExecutor(),
      { clock: () => nowMs },
    );
    expect(existsSync(staleJob)).toBe(false);
    expect(existsSync(unrelated)).toBe(true);
    expect(
      readFileSync(path.join(root, "runner-state-v1.json"), "utf8"),
    ).not.toContain("stale-source-canary-never-survives-restart");
    service.close();
  });

  it("caps journal arrays before parsing individual records", () => {
    expect(() =>
      parseRunnerState({
        schemaVersion: 1,
        jobs: new Array<null>(100_001).fill(null),
        idempotency: [],
      }),
    ).toThrow(/capped at 100000 records/);
    expect(() =>
      parseRunnerState({
        schemaVersion: 1,
        jobs: [],
        idempotency: new Array<null>(100_001).fill(null),
      }),
    ).toThrow(/capped at 100000 records/);

    const hash = "5".repeat(64);
    const tests = Array.from({ length: 101 }, (_, index) => ({
      id: `case-${index}`,
      visibility: "HIDDEN" as const,
      category: "correctness",
      status: "PASSED" as const,
      feedbackCode: "HIDDEN_PASS",
      exitCode: 0,
      wallTimeMs: 1,
    }));
    expect(() =>
      parseRunnerState({
        schemaVersion: 1,
        jobs: [
          {
            jobId: "job-too-many-tests",
            submissionId: "submission-too-many-tests",
            correlationId: "correlation-too-many-tests",
            requestHash: hash,
            state: "COMPLETED",
            createdAt: "2026-07-12T00:00:00.000Z",
            startedAt: "2026-07-12T00:00:01.000Z",
            finishedAt: "2026-07-12T00:00:02.000Z",
            result: runnerResult({
              requestHash: hash,
              tests,
              totals: { passed: 101, failed: 0, total: 101 },
            }),
          },
        ],
        idempotency: [],
      }),
    ).toThrow(/result.tests is capped at 100 records/);
  });

  it("rejects journal bytes over the load and save cap", () => {
    const loadRoot = stateRoot();
    const loadJournal = new RunnerStateJournal(loadRoot, {
      maximumFileBytes: 64,
    });
    writeFileSync(loadJournal.filePath, "x".repeat(65), {
      encoding: "utf8",
      mode: 0o600,
    });
    if (process.platform !== "win32") {
      chmodSync(loadJournal.filePath, 0o600);
    }
    expect(() => loadJournal.load()).toThrow(/exceeds its byte limit/);

    const saveJournal = new RunnerStateJournal(stateRoot(), {
      maximumFileBytes: 16,
    });
    expect(() =>
      saveJournal.save({ schemaVersion: 1, jobs: [], idempotency: [] }),
    ).toThrow(/exceeds its byte limit/);
  });

  it("accepts the complete public terminal-result shape", () => {
    const hash = "e".repeat(64);
    const fullResult = runnerResult({
      requestHash: hash,
      testBundleVersion: "bundle-visible-1",
      run: {
        exitCode: 0,
        stdout: "public stdout",
        stderr: "public stderr",
        wallTimeMs: 4,
      },
      tests: [
        {
          id: "visible-case",
          visibility: "VISIBLE",
          category: "correctness",
          status: "PASSED",
          feedbackCode: "VISIBLE_PASS",
          exitCode: 0,
          wallTimeMs: 3,
          actualStdout: "actual",
          expectedStdout: "expected",
          stderr: "diagnostic",
        },
      ],
      totals: { passed: 1, failed: 0, total: 1 },
    });
    const parsed = parseRunnerState({
      schemaVersion: 1,
      jobs: [
        {
          jobId: "job-completed",
          submissionId: "submission-completed",
          correlationId: "correlation-completed",
          requestHash: hash,
          state: "COMPLETED",
          createdAt: "2026-07-12T00:00:00.000Z",
          startedAt: "2026-07-12T00:00:01.000Z",
          finishedAt: "2026-07-12T00:00:02.000Z",
          result: fullResult,
        },
      ],
      idempotency: [],
    });
    expect(parsed.jobs[0]?.result).toEqual(fullResult);
  });

  it("rejects malformed state variants instead of partially loading", () => {
    const snapshot = activeSnapshot();
    const queued = snapshot.jobs[0]!;
    const binding = snapshot.idempotency[0]!;
    const empty = { schemaVersion: 1, jobs: [], idempotency: [] };
    const invalidStates: unknown[] = [
      null,
      { ...empty, unexpected: true },
      { ...empty, schemaVersion: 2 },
      {
        ...empty,
        jobs: [{ ...queued, submissionId: "" }],
      },
      {
        ...empty,
        jobs: [{ ...queued, jobId: "bad/job/id" }],
      },
      {
        ...empty,
        jobs: [{ ...queued, requestHash: "NOT-A-HASH" }],
      },
      {
        ...empty,
        jobs: [{ ...queued, state: "BROKEN" }],
      },
      {
        ...empty,
        jobs: [{ ...queued, createdAt: "not-a-date" }],
      },
      {
        ...snapshot,
        idempotency: [{ ...binding, key: "short" }],
      },
      {
        ...snapshot,
        idempotency: [{ ...binding, expiresAtMs: -1 }],
      },
      {
        ...empty,
        jobs: [
          {
            ...queued,
            startedAt: "2026-07-12T00:00:01.000Z",
          },
        ],
      },
      {
        ...empty,
        jobs: [{ ...queued, state: "RUNNING" }],
      },
      {
        ...empty,
        jobs: [
          {
            ...queued,
            state: "COMPLETED",
            startedAt: "2026-07-12T00:00:01.000Z",
            finishedAt: "2026-07-12T00:00:02.000Z",
          },
        ],
      },
      {
        ...empty,
        jobs: [
          {
            ...queued,
            state: "FAILED",
            finishedAt: "2026-07-12T00:00:02.000Z",
          },
        ],
      },
    ];
    for (const invalidState of invalidStates) {
      expect(() => parseRunnerState(invalidState)).toThrow(
        /runner state journal is invalid/,
      );
    }
  });

  it("removes a private stale atomic-write file at startup", () => {
    const root = stateRoot();
    const stale = path.join(root, ".runner-state-v1.json.stale.tmp");
    writeFileSync(stale, "{}", { encoding: "utf8", mode: 0o600 });
    if (process.platform !== "win32") {
      chmodSync(stale, 0o600);
    }
    new RunnerStateJournal(root);
    expect(existsSync(stale)).toBe(false);
  });

  it("fails closed before executor work when RUNNING cannot persist", async () => {
    const store = new FailingStartStore();
    const executor = new ImmediateExecutor();
    let fatalCalls = 0;
    const service = new RunnerService(testConfig(), executor, {
      clock: () => nowMs,
      jobId: () => "job-fsync-failure",
      stateStore: store,
      onFatalError: () => {
        fatalCalls += 1;
      },
    });
    service.submit(
      jobRequest(),
      "idempotency-fsync-failure",
      "f".repeat(64),
    );
    await flush();
    expect(executor.calls).toBe(0);
    expect(fatalCalls).toBe(1);
    expect(() => service.health()).toThrow(/unavailable/);
  });

  it("fails startup closed for corrupt JSON", () => {
    const root = stateRoot();
    const journal = new RunnerStateJournal(root);
    journal.save({ schemaVersion: 1, jobs: [], idempotency: [] });
    writeFileSync(journal.filePath, "{not-json", "utf8");
    if (process.platform !== "win32") {
      chmodSync(journal.filePath, 0o600);
    }
    expect(
      () =>
        new RunnerService(
          testConfig({ stateRoot: root }),
          new ImmediateExecutor(),
        ),
    ).toThrow(/not valid JSON/);
  });

  it("fails startup closed for a mismatched idempotency binding", () => {
    const root = stateRoot();
    const journal = new RunnerStateJournal(root);
    const snapshot = activeSnapshot();
    const mismatched = {
      ...snapshot,
      idempotency: [
        {
          ...snapshot.idempotency[0]!,
          requestHash: "f".repeat(64),
        },
      ],
    };
    writeFileSync(journal.filePath, JSON.stringify(mismatched), "utf8");
    if (process.platform !== "win32") {
      chmodSync(journal.filePath, 0o600);
    }
    expect(
      () =>
        new RunnerService(
          testConfig({ stateRoot: root }),
          new ImmediateExecutor(),
        ),
    ).toThrow(/binding does not match/);
  });

  it.runIf(process.platform !== "win32")(
    "fails startup closed for an unsafe state-file mode",
    () => {
      const root = stateRoot();
      const journal = new RunnerStateJournal(root);
      journal.save({ schemaVersion: 1, jobs: [], idempotency: [] });
      chmodSync(journal.filePath, 0o644);
      expect(
        () =>
          new RunnerService(
            testConfig({ stateRoot: root }),
            new ImmediateExecutor(),
          ),
      ).toThrow(/permissions must be 600/);
    },
  );
});
