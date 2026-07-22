import {
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { isAbsolute, join } from "node:path";

const HEALTH_FILE_NAME = "status.json";
const MAX_HEALTH_FILE_BYTES = 4_096;
const FUTURE_CLOCK_SKEW_MS = 5_000;
const RECORD_KEYS = [
  "consecutiveFailures",
  "lastSuccessAt",
  "observedAt",
  "pid",
  "schemaVersion",
  "sequence",
  "startedAt",
  "state",
  "worker",
] as const;

export type WorkerHealthState = "starting" | "healthy" | "retrying" | "failed";

export interface WorkerHealthRecord {
  schemaVersion: 1;
  worker: string;
  pid: number;
  sequence: number;
  state: WorkerHealthState;
  startedAt: string;
  observedAt: string;
  lastSuccessAt: string | null;
  consecutiveFailures: number;
}

interface ReporterOptions {
  worker: string;
  directory?: string;
  pid?: number;
  now?: () => Date;
  log?: (message: string) => void;
}

interface HealthCheckOptions {
  path: string;
  expectedWorker: string;
  now?: Date;
  maxAgeMs: number;
  maxConsecutiveFailures: number;
  processExists?: (pid: number) => boolean;
}

function fail(message: string): never {
  throw new Error(`Worker health ${message}.`);
}

function assertWorkerId(worker: string) {
  if (!/^[a-z][a-z0-9-]{2,63}$/.test(worker)) fail("worker identity is invalid");
}

function canonicalTimestamp(value: unknown, field: string) {
  if (typeof value !== "string") fail(`${field} is invalid`);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    fail(`${field} is invalid`);
  }
  return parsed;
}

function assertSafeDirectory(directory: string) {
  if (!isAbsolute(directory)) fail("directory must be absolute");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const metadata = lstatSync(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) fail("directory is not a real directory");
  if (process.platform !== "win32") {
    if ((metadata.mode & 0o777) !== 0o700) fail("directory mode must be 0700");
    if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) {
      fail("directory owner is invalid");
    }
  }
}

function fsyncDirectory(directory: string) {
  if (process.platform === "win32") return;
  const descriptor = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function writeAtomic(path: string, directory: string, record: WorkerHealthRecord) {
  const payload = `${JSON.stringify(record)}\n`;
  if (Buffer.byteLength(payload) > MAX_HEALTH_FILE_BYTES) fail("record exceeded its size limit");
  const temporary = join(directory, `.${HEALTH_FILE_NAME}.${record.pid}.${randomUUID()}.tmp`);
  let descriptor: number | undefined;
  let renamed = false;
  try {
    descriptor = openSync(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    writeFileSync(descriptor, payload, { encoding: "utf8" });
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, path);
    renamed = true;
    fsyncDirectory(directory);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (!renamed) {
      try {
        unlinkSync(temporary);
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      }
    }
  }
}

function errorCode(error: unknown) {
  if (!(error instanceof Error)) return "UNKNOWN";
  return /^[A-Za-z][A-Za-z0-9_.-]{0,79}$/.test(error.name) ? error.name : "ERROR";
}

export function createWorkerHealthReporter(options: ReporterOptions) {
  assertWorkerId(options.worker);
  const directory = options.directory ?? "/tmp/codestead-worker-health";
  const pid = options.pid ?? process.pid;
  const now = options.now ?? (() => new Date());
  const log = options.log ?? ((message: string) => console.info(message));
  if (!Number.isSafeInteger(pid) || pid < 1) fail("process id is invalid");
  assertSafeDirectory(directory);
  const path = join(directory, HEALTH_FILE_NAME);
  const startedAt = now().toISOString();
  let sequence = 0;
  let lastSuccessAt: string | null = null;
  let consecutiveFailures = 0;

  const publish = (state: WorkerHealthState, observedAt: string) => {
    const record: WorkerHealthRecord = {
      schemaVersion: 1,
      worker: options.worker,
      pid,
      sequence,
      state,
      startedAt,
      observedAt,
      lastSuccessAt,
      consecutiveFailures,
    };
    writeAtomic(path, directory, record);
    return record;
  };

  publish("starting", startedAt);
  log(JSON.stringify({ event: "worker.startup", worker: options.worker, pid, sequence }));

  return {
    path,
    get consecutiveFailures() {
      return consecutiveFailures;
    },
    success() {
      const observedAt = now().toISOString();
      sequence += 1;
      lastSuccessAt = observedAt;
      consecutiveFailures = 0;
      const record = publish("healthy", observedAt);
      log(JSON.stringify({ event: "worker.success", worker: options.worker, pid, sequence }));
      log(JSON.stringify({ event: "worker.heartbeat", worker: options.worker, pid, sequence }));
      return record;
    },
    retry(error: unknown) {
      const observedAt = now().toISOString();
      sequence += 1;
      consecutiveFailures += 1;
      const record = publish("retrying", observedAt);
      log(JSON.stringify({
        event: "worker.retry",
        worker: options.worker,
        pid,
        sequence,
        consecutiveFailures,
        code: errorCode(error),
      }));
      return record;
    },
    terminalFailure(error: unknown) {
      const observedAt = now().toISOString();
      sequence += 1;
      const record = publish("failed", observedAt);
      log(JSON.stringify({
        event: "worker.terminal_failure",
        worker: options.worker,
        pid,
        sequence,
        consecutiveFailures,
        code: errorCode(error),
      }));
      return record;
    },
  };
}

function defaultProcessExists(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function parseRecord(raw: string): WorkerHealthRecord {
  let candidate: unknown;
  try {
    candidate = JSON.parse(raw);
  } catch {
    fail("file is not valid JSON");
  }
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) fail("schema is invalid");
  const record = candidate as Record<string, unknown>;
  if (Object.keys(record).sort().join("\n") !== [...RECORD_KEYS].sort().join("\n")) {
    fail("schema is invalid");
  }
  if (record.schemaVersion !== 1) fail("schema version is invalid");
  if (typeof record.worker !== "string") fail("worker identity is invalid");
  assertWorkerId(record.worker);
  if (!Number.isSafeInteger(record.pid) || (record.pid as number) < 1) fail("process id is invalid");
  if (!Number.isSafeInteger(record.sequence) || (record.sequence as number) < 0) fail("sequence is invalid");
  if (!["starting", "healthy", "retrying", "failed"].includes(record.state as string)) fail("state is invalid");
  if (!Number.isSafeInteger(record.consecutiveFailures) || (record.consecutiveFailures as number) < 0) {
    fail("failure count is invalid");
  }
  if (record.lastSuccessAt !== null && typeof record.lastSuccessAt !== "string") {
    fail("lastSuccessAt is invalid");
  }
  return record as unknown as WorkerHealthRecord;
}

export async function checkWorkerHealthFile(options: HealthCheckOptions) {
  if (!isAbsolute(options.path)) fail("file path must be absolute");
  assertWorkerId(options.expectedWorker);
  if (!Number.isSafeInteger(options.maxAgeMs) || options.maxAgeMs < 1_000) fail("maximum age is invalid");
  if (!Number.isSafeInteger(options.maxConsecutiveFailures) || options.maxConsecutiveFailures < 0) {
    fail("retry budget is invalid");
  }
  const metadata = lstatSync(options.path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) fail("path is not a regular file");
  if (metadata.size < 2 || metadata.size > MAX_HEALTH_FILE_BYTES) fail("file size is invalid");
  if (process.platform !== "win32") {
    if ((metadata.mode & 0o777) !== 0o600) fail("file mode must be 0600");
    if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) fail("file owner is invalid");
  }
  const record = parseRecord(readFileSync(options.path, "utf8"));
  if (record.worker !== options.expectedWorker) fail("worker identity does not match");
  const processExists = options.processExists ?? defaultProcessExists;
  if (!processExists(record.pid)) fail("worker process is not running");
  if (record.state === "failed") fail("record reports terminal failure");
  if (record.state === "starting") fail("worker has not completed a successful cycle");
  if (record.state === "retrying" && record.consecutiveFailures > options.maxConsecutiveFailures) {
    fail("retry budget was exceeded");
  }
  if (!record.lastSuccessAt) fail("worker has no successful cycle");

  const now = options.now ?? new Date();
  if (!Number.isFinite(now.getTime())) fail("check time is invalid");
  const startedAt = canonicalTimestamp(record.startedAt, "startedAt");
  const observedAt = canonicalTimestamp(record.observedAt, "observedAt");
  const lastSuccessAt = canonicalTimestamp(record.lastSuccessAt, "lastSuccessAt");
  if (startedAt > observedAt || lastSuccessAt > observedAt) fail("timestamp order is invalid");
  if (observedAt.getTime() > now.getTime() + FUTURE_CLOCK_SKEW_MS) fail("timestamp is in the future");
  if (now.getTime() - observedAt.getTime() > options.maxAgeMs) fail("heartbeat is stale");
  if (now.getTime() - lastSuccessAt.getTime() > options.maxAgeMs) fail("successful cycle is stale");
  return record;
}
