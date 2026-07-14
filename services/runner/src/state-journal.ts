import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import path from "node:path";
import { RunnerError } from "./errors.js";
import type {
  JobState,
  NormalizedStatus,
  NormalizedTestResult,
  PublicJobRecord,
  RunnerResult,
} from "./types.js";

const SCHEMA_VERSION = 1;
const STATE_FILE = "runner-state-v1.json";
const TEMP_PREFIX = `.${STATE_FILE}.`;
const MAX_STATE_FILE_BYTES = 128 * 1_024 * 1_024;
const MAX_STATE_RECORDS = 100_000;
const MAX_RESULT_TESTS = 100;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SAFE_KEY = /^[A-Za-z0-9._:-]{16,200}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const IMAGE_DIGEST = /^sha256:[a-f0-9]{64}$/;
const SAFE_CODE = /^[A-Z0-9_]{1,128}$/;

export interface PersistedJobRecord {
  readonly jobId: string;
  readonly submissionId: string;
  readonly correlationId: string;
  readonly requestHash: string;
  readonly state: JobState;
  readonly createdAt: string;
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly result?: RunnerResult;
  readonly error?: PublicJobRecord["error"];
}

export interface PersistedIdempotencyRecord {
  readonly key: string;
  readonly requestHash: string;
  readonly jobId: string;
  readonly expiresAtMs: number;
}

export interface RunnerStateSnapshot {
  readonly schemaVersion: 1;
  readonly jobs: readonly PersistedJobRecord[];
  readonly idempotency: readonly PersistedIdempotencyRecord[];
}

export interface RunnerStateStore {
  load(): RunnerStateSnapshot;
  save(snapshot: RunnerStateSnapshot): void;
}

function invalid(detail: string): never {
  throw new RunnerError(
    "INFRASTRUCTURE_ERROR",
    `runner state journal is invalid: ${detail}`,
    500,
    true,
  );
}

function ioFailure(action: string): never {
  throw new RunnerError(
    "INFRASTRUCTURE_ERROR",
    `runner state journal could not ${action}`,
    500,
    true,
  );
}

function isErrno(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    invalid(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  name: string,
): void {
  const allowed = new Set([...required, ...optional]);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  const missing = required.filter(
    (key) => !Object.prototype.hasOwnProperty.call(value, key),
  );
  if (unknown.length > 0 || missing.length > 0) {
    invalid(`${name} has an unexpected shape`);
  }
}

function text(
  value: unknown,
  name: string,
  maximumBytes = 1_048_576,
  allowEmpty = false,
): string {
  if (
    typeof value !== "string" ||
    (!allowEmpty && value.length === 0) ||
    Buffer.byteLength(value, "utf8") > maximumBytes
  ) {
    invalid(`${name} is invalid`);
  }
  return value;
}

function id(value: unknown, name: string): string {
  const parsed = text(value, name, 128);
  if (!SAFE_ID.test(parsed)) {
    invalid(`${name} is invalid`);
  }
  return parsed;
}

function hash(value: unknown, name: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) {
    invalid(`${name} is invalid`);
  }
  return value;
}

function date(value: unknown, name: string): string {
  if (typeof value !== "string") {
    invalid(`${name} is invalid`);
  }
  const epoch = Date.parse(value);
  if (!Number.isFinite(epoch) || new Date(epoch).toISOString() !== value) {
    invalid(`${name} is invalid`);
  }
  return value;
}

function nonNegativeInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    invalid(`${name} is invalid`);
  }
  return value as number;
}

function nonNegativeNumber(value: unknown, name: string): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0
  ) {
    invalid(`${name} is invalid`);
  }
  return value;
}

function exitCode(value: unknown, name: string): number | null {
  if (value === null) {
    return null;
  }
  if (!Number.isInteger(value) || !Number.isSafeInteger(value)) {
    invalid(`${name} is invalid`);
  }
  return value as number;
}

function oneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  name: string,
): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    invalid(`${name} is invalid`);
  }
  return value as T;
}

function parseCompile(value: unknown): RunnerResult["compile"] {
  const parsed = object(value, "result.compile");
  exactKeys(
    parsed,
    ["status", "exitCode", "stdout", "stderr", "wallTimeMs"],
    [],
    "result.compile",
  );
  return {
    status: oneOf(
      parsed.status,
      [
        "OK",
        "COMPILE_ERROR",
        "TIMEOUT",
        "MEMORY_LIMIT",
        "OUTPUT_LIMIT",
        "INFRASTRUCTURE_ERROR",
      ] as const,
      "result.compile.status",
    ),
    exitCode: exitCode(parsed.exitCode, "result.compile.exitCode"),
    stdout: text(parsed.stdout, "result.compile.stdout", 1_048_576, true),
    stderr: text(parsed.stderr, "result.compile.stderr", 1_048_576, true),
    wallTimeMs: nonNegativeNumber(
      parsed.wallTimeMs,
      "result.compile.wallTimeMs",
    ),
  };
}

function parseRun(value: unknown): NonNullable<RunnerResult["run"]> {
  const parsed = object(value, "result.run");
  exactKeys(
    parsed,
    ["exitCode", "stdout", "stderr", "wallTimeMs"],
    [],
    "result.run",
  );
  return {
    exitCode: exitCode(parsed.exitCode, "result.run.exitCode"),
    stdout: text(parsed.stdout, "result.run.stdout", 1_048_576, true),
    stderr: text(parsed.stderr, "result.run.stderr", 1_048_576, true),
    wallTimeMs: nonNegativeNumber(parsed.wallTimeMs, "result.run.wallTimeMs"),
  };
}

function parseTest(
  value: unknown,
  index: number,
): NormalizedTestResult {
  const name = `result.tests[${index}]`;
  const parsed = object(value, name);
  const visibility = oneOf(
    parsed.visibility,
    ["VISIBLE", "HIDDEN"] as const,
    `${name}.visibility`,
  );
  exactKeys(
    parsed,
    [
      "id",
      "visibility",
      "category",
      "status",
      "feedbackCode",
      "exitCode",
      "wallTimeMs",
    ],
    visibility === "VISIBLE"
      ? ["actualStdout", "expectedStdout", "stderr"]
      : [],
    name,
  );
  const feedbackCode = text(parsed.feedbackCode, `${name}.feedbackCode`, 128);
  if (!SAFE_CODE.test(feedbackCode)) {
    invalid(`${name}.feedbackCode is invalid`);
  }
  const base = {
    id: id(parsed.id, `${name}.id`),
    visibility,
    category: text(parsed.category, `${name}.category`, 64),
    status: oneOf(
      parsed.status,
      [
        "PASSED",
        "FAILED",
        "RUNTIME_ERROR",
        "TIMEOUT",
        "MEMORY_LIMIT",
        "OUTPUT_LIMIT",
        "INFRASTRUCTURE_ERROR",
      ] as const,
      `${name}.status`,
    ),
    feedbackCode,
    exitCode: exitCode(parsed.exitCode, `${name}.exitCode`),
    wallTimeMs: nonNegativeNumber(parsed.wallTimeMs, `${name}.wallTimeMs`),
  } as const;
  if (visibility === "HIDDEN") {
    return base;
  }
  return {
    ...base,
    ...(parsed.actualStdout === undefined
      ? {}
      : {
          actualStdout: text(
            parsed.actualStdout,
            `${name}.actualStdout`,
            1_048_576,
            true,
          ),
        }),
    ...(parsed.expectedStdout === undefined
      ? {}
      : {
          expectedStdout: text(
            parsed.expectedStdout,
            `${name}.expectedStdout`,
            1_048_576,
            true,
          ),
        }),
    ...(parsed.stderr === undefined
      ? {}
      : {
          stderr: text(
            parsed.stderr,
            `${name}.stderr`,
            1_048_576,
            true,
          ),
        }),
  };
}

function parseRunnerResult(
  value: unknown,
  expectedRequestHash: string,
): RunnerResult {
  const parsed = object(value, "result");
  exactKeys(
    parsed,
    [
      "status",
      "requestHash",
      "sourceHash",
      "runtimeVersion",
      "imageDigest",
      "compile",
      "tests",
      "totals",
      "startedAt",
      "finishedAt",
    ],
    ["testBundleVersion", "run"],
    "result",
  );
  const requestHash = hash(parsed.requestHash, "result.requestHash");
  if (requestHash !== expectedRequestHash) {
    invalid("result.requestHash does not match its job");
  }
  if (!Array.isArray(parsed.tests)) {
    invalid("result.tests must be an array");
  }
  if (parsed.tests.length > MAX_RESULT_TESTS) {
    invalid(`result.tests is capped at ${MAX_RESULT_TESTS} records`);
  }
  const tests = parsed.tests.map(parseTest);
  const totalsValue = object(parsed.totals, "result.totals");
  exactKeys(
    totalsValue,
    ["passed", "failed", "total"],
    [],
    "result.totals",
  );
  const totals = {
    passed: nonNegativeInteger(totalsValue.passed, "result.totals.passed"),
    failed: nonNegativeInteger(totalsValue.failed, "result.totals.failed"),
    total: nonNegativeInteger(totalsValue.total, "result.totals.total"),
  };
  if (
    totals.passed + totals.failed !== totals.total ||
    totals.total !== tests.length
  ) {
    invalid("result.totals does not match result.tests");
  }
  const imageDigest = text(parsed.imageDigest, "result.imageDigest", 71);
  if (!IMAGE_DIGEST.test(imageDigest)) {
    invalid("result.imageDigest is invalid");
  }
  return {
    status: oneOf(
      parsed.status,
      [
        "COMPILE_ONLY",
        "ACCEPTED",
        "WRONG_ANSWER",
        "COMPILE_ERROR",
        "RUNTIME_ERROR",
        "TIMEOUT",
        "MEMORY_LIMIT",
        "OUTPUT_LIMIT",
        "INFRASTRUCTURE_ERROR",
      ] satisfies readonly NormalizedStatus[],
      "result.status",
    ),
    requestHash,
    sourceHash: hash(parsed.sourceHash, "result.sourceHash"),
    runtimeVersion: text(parsed.runtimeVersion, "result.runtimeVersion", 128),
    imageDigest,
    ...(parsed.testBundleVersion === undefined
      ? {}
      : {
          testBundleVersion: id(
            parsed.testBundleVersion,
            "result.testBundleVersion",
          ),
        }),
    compile: parseCompile(parsed.compile),
    ...(parsed.run === undefined ? {} : { run: parseRun(parsed.run) }),
    tests,
    totals,
    startedAt: date(parsed.startedAt, "result.startedAt"),
    finishedAt: date(parsed.finishedAt, "result.finishedAt"),
  };
}

function parseError(value: unknown): NonNullable<PublicJobRecord["error"]> {
  const parsed = object(value, "job.error");
  exactKeys(parsed, ["code", "retryable"], [], "job.error");
  const code = text(parsed.code, "job.error.code", 128);
  if (!SAFE_CODE.test(code) || typeof parsed.retryable !== "boolean") {
    invalid("job.error is invalid");
  }
  return { code, retryable: parsed.retryable };
}

function parseJob(value: unknown, index: number): PersistedJobRecord {
  const name = `jobs[${index}]`;
  const parsed = object(value, name);
  exactKeys(
    parsed,
    [
      "jobId",
      "submissionId",
      "correlationId",
      "requestHash",
      "state",
      "createdAt",
    ],
    ["startedAt", "finishedAt", "result", "error"],
    name,
  );
  const state = oneOf(
    parsed.state,
    ["QUEUED", "RUNNING", "COMPLETED", "FAILED"] as const,
    `${name}.state`,
  );
  const requestHash = hash(parsed.requestHash, `${name}.requestHash`);
  const base = {
    jobId: id(parsed.jobId, `${name}.jobId`),
    submissionId: id(parsed.submissionId, `${name}.submissionId`),
    correlationId: id(parsed.correlationId, `${name}.correlationId`),
    requestHash,
    state,
    createdAt: date(parsed.createdAt, `${name}.createdAt`),
  } as const;

  if (state === "QUEUED") {
    if (
      parsed.startedAt !== undefined ||
      parsed.finishedAt !== undefined ||
      parsed.result !== undefined ||
      parsed.error !== undefined
    ) {
      invalid(`${name} has fields incompatible with QUEUED`);
    }
    return base;
  }

  if (state === "RUNNING") {
    if (
      parsed.startedAt === undefined ||
      parsed.finishedAt !== undefined ||
      parsed.result !== undefined ||
      parsed.error !== undefined
    ) {
      invalid(`${name} has fields incompatible with RUNNING`);
    }
    return {
      ...base,
      startedAt: date(parsed.startedAt, `${name}.startedAt`),
    };
  }

  if (state === "COMPLETED") {
    if (
      parsed.startedAt === undefined ||
      parsed.finishedAt === undefined ||
      parsed.result === undefined ||
      parsed.error !== undefined
    ) {
      invalid(`${name} has fields incompatible with COMPLETED`);
    }
    return {
      ...base,
      startedAt: date(parsed.startedAt, `${name}.startedAt`),
      finishedAt: date(parsed.finishedAt, `${name}.finishedAt`),
      result: parseRunnerResult(parsed.result, requestHash),
    };
  }

  if (
    parsed.finishedAt === undefined ||
    parsed.result !== undefined ||
    parsed.error === undefined
  ) {
    invalid(`${name} has fields incompatible with FAILED`);
  }
  return {
    ...base,
    ...(parsed.startedAt === undefined
      ? {}
      : { startedAt: date(parsed.startedAt, `${name}.startedAt`) }),
    finishedAt: date(parsed.finishedAt, `${name}.finishedAt`),
    error: parseError(parsed.error),
  };
}

function parseIdempotency(
  value: unknown,
  index: number,
): PersistedIdempotencyRecord {
  const name = `idempotency[${index}]`;
  const parsed = object(value, name);
  exactKeys(
    parsed,
    ["key", "requestHash", "jobId", "expiresAtMs"],
    [],
    name,
  );
  const key = text(parsed.key, `${name}.key`, 200);
  if (!SAFE_KEY.test(key)) {
    invalid(`${name}.key is invalid`);
  }
  const expiresAtMs = nonNegativeInteger(
    parsed.expiresAtMs,
    `${name}.expiresAtMs`,
  );
  if (expiresAtMs === 0) {
    invalid(`${name}.expiresAtMs is invalid`);
  }
  return {
    key,
    requestHash: hash(parsed.requestHash, `${name}.requestHash`),
    jobId: id(parsed.jobId, `${name}.jobId`),
    expiresAtMs,
  };
}

export function parseRunnerState(value: unknown): RunnerStateSnapshot {
  const parsed = object(value, "journal");
  exactKeys(
    parsed,
    ["schemaVersion", "jobs", "idempotency"],
    [],
    "journal",
  );
  if (parsed.schemaVersion !== SCHEMA_VERSION) {
    invalid("schemaVersion is unsupported");
  }
  if (!Array.isArray(parsed.jobs) || !Array.isArray(parsed.idempotency)) {
    invalid("jobs and idempotency must be arrays");
  }
  if (
    parsed.jobs.length > MAX_STATE_RECORDS ||
    parsed.idempotency.length > MAX_STATE_RECORDS
  ) {
    invalid(`jobs and idempotency are capped at ${MAX_STATE_RECORDS} records`);
  }
  const jobs = parsed.jobs.map(parseJob);
  const idempotency = parsed.idempotency.map(parseIdempotency);
  const jobsById = new Map<string, PersistedJobRecord>();
  for (const job of jobs) {
    if (jobsById.has(job.jobId)) {
      invalid("job IDs must be unique");
    }
    jobsById.set(job.jobId, job);
  }
  const keys = new Set<string>();
  const boundJobs = new Set<string>();
  for (const record of idempotency) {
    if (keys.has(record.key) || boundJobs.has(record.jobId)) {
      invalid("idempotency bindings must be unique");
    }
    keys.add(record.key);
    boundJobs.add(record.jobId);
    const job = jobsById.get(record.jobId);
    if (job === undefined || job.requestHash !== record.requestHash) {
      invalid("idempotency binding does not match its job");
    }
  }
  for (const job of jobs) {
    if (
      (job.state === "QUEUED" || job.state === "RUNNING") &&
      !boundJobs.has(job.jobId)
    ) {
      invalid("active job is missing its idempotency binding");
    }
  }
  return { schemaVersion: SCHEMA_VERSION, jobs, idempotency };
}

export function validatePublicRunnerResult(
  result: RunnerResult,
  expectedRequestHash: string,
): RunnerResult {
  const projected: RunnerResult = {
    status: result.status,
    requestHash: result.requestHash,
    sourceHash: result.sourceHash,
    runtimeVersion: result.runtimeVersion,
    imageDigest: result.imageDigest,
    ...(result.testBundleVersion === undefined
      ? {}
      : { testBundleVersion: result.testBundleVersion }),
    compile: {
      status: result.compile.status,
      exitCode: result.compile.exitCode,
      stdout: result.compile.stdout,
      stderr: result.compile.stderr,
      wallTimeMs: result.compile.wallTimeMs,
    },
    ...(result.run === undefined
      ? {}
      : {
          run: {
            exitCode: result.run.exitCode,
            stdout: result.run.stdout,
            stderr: result.run.stderr,
            wallTimeMs: result.run.wallTimeMs,
          },
        }),
    tests: result.tests.map((test) => {
      const base = {
        id: test.id,
        visibility: test.visibility,
        category: test.category,
        status: test.status,
        feedbackCode: test.feedbackCode,
        exitCode: test.exitCode,
        wallTimeMs: test.wallTimeMs,
      } as const;
      return test.visibility === "HIDDEN"
        ? base
        : {
            ...base,
            ...(test.actualStdout === undefined
              ? {}
              : { actualStdout: test.actualStdout }),
            ...(test.expectedStdout === undefined
              ? {}
              : { expectedStdout: test.expectedStdout }),
            ...(test.stderr === undefined ? {} : { stderr: test.stderr }),
          };
    }),
    totals: {
      passed: result.totals.passed,
      failed: result.totals.failed,
      total: result.totals.total,
    },
    startedAt: result.startedAt,
    finishedAt: result.finishedAt,
  };
  return parseRunnerResult(projected, expectedRequestHash);
}

export function projectRunnerResult(
  result: RunnerResult,
  expectedRequestHash: string,
): RunnerResult {
  const publicResult = validatePublicRunnerResult(
    result,
    expectedRequestHash,
  );
  const recoveryResult: RunnerResult = {
    ...publicResult,
    compile: {
      ...publicResult.compile,
      stdout: "",
      stderr: "",
    },
    ...(publicResult.run === undefined
      ? {}
      : {
          run: {
            ...publicResult.run,
            stdout: "",
            stderr: "",
          },
        }),
    tests: publicResult.tests.map((test) => ({
      id: test.id,
      visibility: test.visibility,
      category: test.category,
      status: test.status,
      feedbackCode: test.feedbackCode,
      exitCode: test.exitCode,
      wallTimeMs: test.wallTimeMs,
    })),
  };
  return parseRunnerResult(recoveryResult, expectedRequestHash);
}

function projectRecoverySnapshot(
  snapshot: RunnerStateSnapshot,
): RunnerStateSnapshot {
  return {
    schemaVersion: SCHEMA_VERSION,
    jobs: snapshot.jobs.map((job) =>
      job.result === undefined
        ? job
        : {
            ...job,
            result: projectRunnerResult(job.result, job.requestHash),
          },
    ),
    idempotency: snapshot.idempotency,
  };
}

function verifyOwnedMode(
  stats: Stats,
  expectedMode: number,
  name: string,
): void {
  if (process.platform === "win32") {
    return;
  }
  if ((stats.mode & 0o7777) !== expectedMode) {
    invalid(`${name} permissions must be ${expectedMode.toString(8)}`);
  }
  const uid = process.getuid?.();
  if (uid !== undefined && stats.uid !== uid) {
    invalid(`${name} must be owned by the runner user`);
  }
}

export class RunnerStateJournal implements RunnerStateStore {
  readonly #root: string;
  readonly #file: string;
  readonly #maximumFileBytes: number;

  constructor(
    stateRoot: string,
    options: { readonly maximumFileBytes?: number } = {},
  ) {
    this.#root = path.resolve(stateRoot);
    if (path.dirname(this.#root) === this.#root) {
      invalid("state root must not be a filesystem root");
    }
    this.#file = path.join(this.#root, STATE_FILE);
    this.#maximumFileBytes =
      options.maximumFileBytes ?? MAX_STATE_FILE_BYTES;
    if (
      !Number.isSafeInteger(this.#maximumFileBytes) ||
      this.#maximumFileBytes <= 0 ||
      this.#maximumFileBytes > MAX_STATE_FILE_BYTES
    ) {
      invalid("maximum state file bytes must be a positive integer");
    }
    this.ensureRoot();
    this.cleanupTemporaryFiles();
  }

  get filePath(): string {
    return this.#file;
  }

  load(): RunnerStateSnapshot {
    let before: Stats;
    try {
      before = lstatSync(this.#file);
    } catch (error) {
      if (isErrno(error, "ENOENT")) {
        return { schemaVersion: SCHEMA_VERSION, jobs: [], idempotency: [] };
      }
      ioFailure("inspect its state file");
    }
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.nlink !== 1
    ) {
      invalid("state file must be a regular file");
    }
    verifyOwnedMode(before, 0o600, "state file");

    let descriptor: number | undefined;
    try {
      descriptor = openSync(
        this.#file,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
      );
      const after = fstatSync(descriptor);
      if (
        !after.isFile() ||
        after.dev !== before.dev ||
        after.ino !== before.ino
      ) {
        invalid("state file changed while it was opened");
      }
      if (after.size > this.#maximumFileBytes) {
        invalid("state file exceeds its byte limit");
      }
      const body = readFileSync(descriptor, "utf8");
      let value: unknown;
      try {
        value = JSON.parse(body) as unknown;
      } catch {
        invalid("state file is not valid JSON");
      }
      return parseRunnerState(value);
    } catch (error) {
      if (error instanceof RunnerError) {
        throw error;
      }
      ioFailure("read its state file");
    } finally {
      if (descriptor !== undefined) {
        closeSync(descriptor);
      }
    }
    return invalid("state file could not be loaded");
  }

  save(snapshot: RunnerStateSnapshot): void {
    const safeSnapshot = projectRecoverySnapshot(
      parseRunnerState(snapshot),
    );
    let projectedBytes = Buffer.byteLength(
      '{"schemaVersion":1,"jobs":[],"idempotency":[]}\n',
      "utf8",
    );
    if (projectedBytes > this.#maximumFileBytes) {
      invalid("state file exceeds its byte limit");
    }
    for (const records of [
      safeSnapshot.jobs,
      safeSnapshot.idempotency,
    ] as const) {
      for (const [index, record] of records.entries()) {
        projectedBytes += Buffer.byteLength(
          JSON.stringify(record),
          "utf8",
        );
        if (index > 0) {
          projectedBytes += 1;
        }
        if (projectedBytes > this.#maximumFileBytes) {
          invalid("state file exceeds its byte limit");
        }
      }
    }
    const serialized = `${JSON.stringify(safeSnapshot)}\n`;
    if (Buffer.byteLength(serialized, "utf8") > this.#maximumFileBytes) {
      invalid("state file exceeds its byte limit");
    }
    this.ensureRoot();
    this.verifyExistingStateFile();
    const temporary = path.join(
      this.#root,
      `${TEMP_PREFIX}${process.pid}.${randomUUID()}.tmp`,
    );
    let descriptor: number | undefined;
    let renamed = false;
    try {
      descriptor = openSync(
        temporary,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          (constants.O_NOFOLLOW ?? 0),
        0o600,
      );
      if (process.platform !== "win32") {
        fchmodSync(descriptor, 0o600);
      }
      writeFileSync(descriptor, serialized, "utf8");
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      renameSync(temporary, this.#file);
      renamed = true;
      this.syncDirectory();
    } catch (error) {
      if (error instanceof RunnerError) {
        throw error;
      }
      ioFailure("persist state atomically");
    } finally {
      if (descriptor !== undefined) {
        closeSync(descriptor);
      }
      if (!renamed) {
        try {
          unlinkSync(temporary);
        } catch (error) {
          if (!isErrno(error, "ENOENT")) {
            // The original persistence failure remains the actionable error.
          }
        }
      }
    }
  }

  private ensureRoot(): void {
    try {
      mkdirSync(this.#root, { recursive: true, mode: 0o700 });
      const stats = lstatSync(this.#root);
      if (!stats.isDirectory() || stats.isSymbolicLink()) {
        invalid("state root must be a directory, not a symlink");
      }
      verifyOwnedMode(stats, 0o700, "state root");
    } catch (error) {
      if (error instanceof RunnerError) {
        throw error;
      }
      ioFailure("prepare its state root");
    }
  }

  private verifyExistingStateFile(): void {
    try {
      const stats = lstatSync(this.#file);
      if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1) {
        invalid("state file must be a regular file");
      }
      verifyOwnedMode(stats, 0o600, "state file");
    } catch (error) {
      if (isErrno(error, "ENOENT")) {
        return;
      }
      if (error instanceof RunnerError) {
        throw error;
      }
      ioFailure("inspect its state file");
    }
  }

  private cleanupTemporaryFiles(): void {
    let entries: string[];
    try {
      entries = readdirSync(this.#root);
    } catch {
      ioFailure("inspect its state root");
    }
    for (const entry of entries) {
      if (!entry.startsWith(TEMP_PREFIX) || !entry.endsWith(".tmp")) {
        continue;
      }
      const candidate = path.join(this.#root, entry);
      try {
        const stats = lstatSync(candidate);
        if (
          !stats.isFile() ||
          stats.isSymbolicLink() ||
          stats.nlink !== 1
        ) {
          invalid("temporary state entries must be regular files");
        }
        verifyOwnedMode(stats, 0o600, "temporary state file");
        unlinkSync(candidate);
      } catch (error) {
        if (error instanceof RunnerError) {
          throw error;
        }
        ioFailure("remove a stale temporary state file");
      }
    }
  }

  private syncDirectory(): void {
    if (process.platform === "win32") {
      return;
    }
    let descriptor: number | undefined;
    try {
      descriptor = openSync(
        this.#root,
        constants.O_RDONLY | (constants.O_DIRECTORY ?? 0),
      );
      fsyncSync(descriptor);
    } catch {
      ioFailure("fsync its state directory");
    } finally {
      if (descriptor !== undefined) {
        closeSync(descriptor);
      }
    }
  }
}
