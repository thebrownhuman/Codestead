import { chmod, mkdir, readFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  checkWorkerHealthFile,
  createWorkerHealthReporter,
  type WorkerHealthRecord,
} from "./worker-health";

const createdDirectories: string[] = [];
const NOW = new Date("2026-07-19T10:00:00.000Z");

async function testDirectory() {
  const directory = join(tmpdir(), `codestead-worker-health-${crypto.randomUUID()}`);
  await mkdir(directory, { recursive: true });
  createdDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(createdDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function healthyRecord(overrides: Partial<WorkerHealthRecord> = {}): WorkerHealthRecord {
  return {
    schemaVersion: 1,
    worker: "mail-worker",
    pid: process.pid,
    sequence: 2,
    state: "healthy",
    startedAt: "2026-07-19T09:59:00.000Z",
    observedAt: "2026-07-19T09:59:55.000Z",
    lastSuccessAt: "2026-07-19T09:59:55.000Z",
    consecutiveFailures: 0,
    ...overrides,
  };
}

describe("production worker health contract", () => {
  it("publishes startup and advances the durable heartbeat only after a successful cycle", async () => {
    const directory = await testDirectory();
    const messages: string[] = [];
    const clock = vi.fn()
      .mockReturnValueOnce(new Date("2026-07-19T09:59:00.000Z"))
      .mockReturnValueOnce(new Date("2026-07-19T09:59:55.000Z"));
    const reporter = createWorkerHealthReporter({
      worker: "mail-worker",
      directory,
      pid: process.pid,
      now: clock,
      log: (message) => messages.push(message),
    });

    const startup = JSON.parse(await readFile(reporter.path, "utf8")) as WorkerHealthRecord;
    expect(startup).toMatchObject({
      schemaVersion: 1,
      worker: "mail-worker",
      pid: process.pid,
      sequence: 0,
      state: "starting",
      lastSuccessAt: null,
      consecutiveFailures: 0,
    });

    reporter.success();
    const healthy = JSON.parse(await readFile(reporter.path, "utf8")) as WorkerHealthRecord;
    expect(healthy).toMatchObject({
      sequence: 1,
      state: "healthy",
      observedAt: "2026-07-19T09:59:55.000Z",
      lastSuccessAt: "2026-07-19T09:59:55.000Z",
      consecutiveFailures: 0,
    });
    expect(messages.map((message) => JSON.parse(message).event)).toEqual([
      "worker.startup",
      "worker.success",
      "worker.heartbeat",
    ]);
    expect(messages.join("\n")).not.toMatch(/source|secret|credential|api.?key/i);
  });

  it("supports a production worker running as PID 1 in its container namespace", async () => {
    const directory = await testDirectory();
    const reporter = createWorkerHealthReporter({
      worker: "reward-worker",
      directory,
      pid: 1,
      now: () => NOW,
      log: () => undefined,
    });
    reporter.success();
    const record = JSON.parse(await readFile(reporter.path, "utf8")) as WorkerHealthRecord;
    expect(record).toMatchObject({ pid: 1, state: "healthy" });

    await expect(checkWorkerHealthFile({
      path: reporter.path,
      expectedWorker: "reward-worker",
      now: NOW,
      maxAgeMs: 60_000,
      maxConsecutiveFailures: 2,
      processExists: (pid) => pid === 1,
    })).resolves.toMatchObject({ pid: 1, state: "healthy" });
  });

  it("retains the last successful cycle during a bounded retry and rejects terminal failure", async () => {
    const directory = await testDirectory();
    const times = [
      "2026-07-19T09:59:00.000Z",
      "2026-07-19T09:59:30.000Z",
      "2026-07-19T09:59:40.000Z",
      "2026-07-19T09:59:50.000Z",
    ].map((value) => new Date(value));
    const reporter = createWorkerHealthReporter({
      worker: "reward-worker",
      directory,
      pid: process.pid,
      now: () => times.shift()!,
      log: () => undefined,
    });
    reporter.success();
    reporter.retry(new TypeError("must never be serialized"));

    await expect(checkWorkerHealthFile({
      path: reporter.path,
      expectedWorker: "reward-worker",
      now: NOW,
      maxAgeMs: 60_000,
      maxConsecutiveFailures: 2,
      processExists: () => true,
    })).resolves.toMatchObject({ state: "retrying", consecutiveFailures: 1 });

    reporter.terminalFailure(new Error("private detail"));
    await expect(checkWorkerHealthFile({
      path: reporter.path,
      expectedWorker: "reward-worker",
      now: NOW,
      maxAgeMs: 60_000,
      maxConsecutiveFailures: 2,
      processExists: () => true,
    })).rejects.toThrow(/terminal failure/i);
  });

  it.each([
    ["stale success", healthyRecord({ startedAt: "2026-07-19T09:49:00.000Z", observedAt: "2026-07-19T09:50:00.000Z", lastSuccessAt: "2026-07-19T09:50:00.000Z" }), /stale/i],
    ["future timestamp", healthyRecord({ observedAt: "2026-07-19T10:01:00.000Z", lastSuccessAt: "2026-07-19T10:01:00.000Z" }), /future/i],
    ["wrong worker", healthyRecord({ worker: "reward-worker" }), /worker identity/i],
    ["wrong process", healthyRecord({ pid: 999_999 }), /process/i],
    ["failed state", healthyRecord({ state: "failed" }), /terminal failure/i],
    ["too many retries", healthyRecord({ state: "retrying", consecutiveFailures: 3 }), /retry budget/i],
    ["retry before first success", healthyRecord({ state: "retrying", lastSuccessAt: null, consecutiveFailures: 1 }), /successful cycle/i],
  ] as const)("rejects %s", async (_name, record, message) => {
    const directory = await testDirectory();
    const path = join(directory, "status.json");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(path, `${JSON.stringify(record)}\n`, { mode: 0o600 });

    await expect(checkWorkerHealthFile({
      path,
      expectedWorker: "mail-worker",
      now: NOW,
      maxAgeMs: 60_000,
      maxConsecutiveFailures: 2,
      processExists: (pid) => pid === process.pid,
    })).rejects.toThrow(message);
  });

  it("rejects malformed, oversized, permissive, symlinked, and schema-expanded health files", async () => {
    const directory = await testDirectory();
    const path = join(directory, "status.json");
    const { writeFile } = await import("node:fs/promises");
    const check = () => checkWorkerHealthFile({
      path,
      expectedWorker: "mail-worker",
      now: NOW,
      maxAgeMs: 60_000,
      maxConsecutiveFailures: 2,
      processExists: () => true,
    });

    await writeFile(path, "not-json", { mode: 0o600 });
    await expect(check()).rejects.toThrow(/json/i);
    await writeFile(path, "x".repeat(4_097), { mode: 0o600 });
    await expect(check()).rejects.toThrow(/size/i);
    await writeFile(path, JSON.stringify({ ...healthyRecord(), unexpected: true }), { mode: 0o600 });
    await expect(check()).rejects.toThrow(/schema/i);

    if (process.platform !== "win32") {
      await chmod(path, 0o644);
      await expect(check()).rejects.toThrow(/mode/i);
      const target = join(directory, "target.json");
      await writeFile(target, JSON.stringify(healthyRecord()), { mode: 0o600 });
      const link = join(directory, "linked.json");
      await symlink(target, link);
      await expect(checkWorkerHealthFile({
        path: link,
        expectedWorker: "mail-worker",
        now: NOW,
        maxAgeMs: 60_000,
        maxConsecutiveFailures: 2,
        processExists: () => true,
      })).rejects.toThrow(/regular file/i);
    }
  });
});
