import { randomBytes } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { access } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import pg from "pg";

import { runDatabaseRoleBootstrap } from "../../scripts/bootstrap-database-roles.mjs";
import { runProductionMigration } from "../../scripts/migrate-production.mjs";
import { verifyDatabaseRoleBoundaries } from "../../scripts/verify-database-role-boundaries.mjs";
import {
  REVIEWED_MIGRATION_LEDGER,
  REVIEWED_MIGRATION_LEDGER_SHA256,
} from "../../scripts/lib/reviewed-migration-ledger.mjs";

const { Client, Pool } = pg;

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "../..");
const temporaryPrefix = "codestead-restore-role-boundary-";
const ambientDatabaseNames = Object.freeze([
  "DATABASE_APP_URL",
  "DATABASE_BACKUP_REPORTER_URL",
  "DATABASE_BOOTSTRAP_URL",
  "DATABASE_MIGRATOR_URL",
  "DATABASE_OPS_URL",
  "DATABASE_OWNER_URL",
  "DATABASE_URL",
  "DATABASE_URL_FILE",
  "DATABASE_WORKER_URL",
  "NODE_OPTIONS",
  "NODE_PATH",
  "PGAPPNAME",
  "PGCHANNELBINDING",
  "PGCONNECT_TIMEOUT",
  "PGDATABASE",
  "PGHOST",
  "PGHOSTADDR",
  "PGOPTIONS",
  "PGPASSFILE",
  "PGPASSWORD",
  "PGPORT",
  "PGSERVICE",
  "PGSERVICEFILE",
  "PGSSLMODE",
  "PGUSER",
  "POSTGRES_PASSWORD",
]);

export const MAX_SUBRUN_MS = 60_000;
export const SUCCESS_MARKER = "restore_drill_role_boundary=PASS\n";
export const FAILURE_MARKER = "restore_drill_role_boundary=FAIL\n";
export const RESTORE_BOOTSTRAP_IDENTITY = "codestead_restore";

export const NO_OPERATION_FAILURE = Symbol("no restore operation failure");

export function formatRestoreDrillFailureDiagnostic(error) {
  const errorName =
    error instanceof Error && /^[A-Za-z][A-Za-z0-9]*$/u.test(error.name)
      ? error.name
      : "NonErrorFailure";
  const message =
    error instanceof Error && typeof error.message === "string"
      ? error.message
      : "unspecified failure";
  const redacted = message
    .replace(
      /\b(?:postgres|postgresql):\/\/[^\s"'<>]+/giu,
      "<redacted-database-url>",
    )
    .replace(
      /\b(?:credential|key|password|secret|token)\s*[:=]\s*[^\s,;]+/giu,
      "<redacted-sensitive-value>",
    )
    .replace(/[\u0000-\u001f\u007f-\u009f]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 512);
  return `restore_drill_role_boundary_error=${errorName}:${redacted || "unspecified failure"}\n`;
}

const DATABASE_CONNECT_TIMEOUT_MS = 5_000;
const DATABASE_OPERATION_TIMEOUT_MS = 45_000;
const DATABASE_LOCK_TIMEOUT_MS = 10_000;
const CHILD_TERMINATION_GRACE_MS = 1_000;
export function resolvePostgresSelection(environment) {
  const selected = [
    ["POSTGRES_17_BIN", 17],
    ["POSTGRES_18_BIN", 18],
  ].filter(([name]) => Object.hasOwn(environment, name));
  if (selected.length !== 1) {
    throw new Error(
      "exactly one of POSTGRES_17_BIN or POSTGRES_18_BIN is required",
    );
  }
  const [environmentKey, expectedMajor] = selected[0];
  const binaryDirectory = environment[environmentKey];
  if (
    typeof binaryDirectory !== "string" ||
    binaryDirectory.length === 0 ||
    binaryDirectory.trim() !== binaryDirectory ||
    binaryDirectory.includes("\0")
  ) {
    throw new Error("selected PostgreSQL binary directory is invalid");
  }
  return { binaryDirectory, environmentKey, expectedMajor };
}

export function validatePostgresVersionOutput(output, expectedMajor) {
  const normalized =
    typeof output === "string" ? output.replace(/\r?\n$/u, "") : "";
  const match =
    /^postgres \(PostgreSQL\) ([0-9]+)(?:(?:\.[0-9]+){1,2}|(?:beta|rc)[0-9]+|devel)(?: [^\r\n]+)?$/u.exec(
      normalized,
    );
  if (!match || Number(match[1]) !== expectedMajor) {
    throw new Error("selected PostgreSQL binary major mismatch");
  }
  return normalized;
}

export function validateDisposablePort(port) {
  if (!Number.isInteger(port) || port < 1 || port > 65_535 || port === 5432) {
    throw new Error("disposable PostgreSQL port is unsafe");
  }
  return port;
}

export function validateSubrunTimeout(timeoutMs) {
  if (
    !Number.isFinite(timeoutMs) ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > MAX_SUBRUN_MS
  ) {
    throw new Error("subrun timeout is unsafe");
  }
  return timeoutMs;
}

export function assertNoAmbientDatabaseEnvironment(environment) {
  for (const name of ambientDatabaseNames) {
    if (Object.hasOwn(environment, name)) {
      throw new Error(`unsafe ambient environment variable: ${name}`);
    }
  }
}

export function buildCleanChildEnvironment({
  environment,
  pgPassFile,
  temporaryRoot,
  additional = {},
}) {
  const child = {
    FORCE_COLOR: "0",
    LC_ALL: "C",
    NODE_ENV: "test",
    NODE_NO_WARNINGS: "1",
    PGCONNECT_TIMEOUT: "5",
    PGOPTIONS:
      "-c statement_timeout=45000 -c lock_timeout=10000 -c idle_in_transaction_session_timeout=45000",
    TEMP: temporaryRoot,
    TMP: temporaryRoot,
    TMPDIR: temporaryRoot,
  };
  if (pgPassFile !== undefined) {
    if (
      typeof pgPassFile !== "string" ||
      pgPassFile.length === 0 ||
      pgPassFile.includes("\0")
    ) {
      throw new Error("child pgpass path is unsafe");
    }
    child.PGPASSFILE = pgPassFile;
  }
  if (process.platform === "win32") {
    const systemRoot = environment.SystemRoot ?? environment.SYSTEMROOT;
    const windowsDirectory = environment.WINDIR ?? systemRoot;
    if (
      typeof systemRoot !== "string" ||
      typeof windowsDirectory !== "string" ||
      !path.win32.isAbsolute(systemRoot) ||
      !path.win32.isAbsolute(windowsDirectory) ||
      path.win32.normalize(systemRoot).toLowerCase() !==
        path.win32.normalize(windowsDirectory).toLowerCase() ||
      systemRoot.includes("\0") ||
      windowsDirectory.includes("\0")
    ) {
      throw new Error("Windows system environment is unsafe");
    }
    child.ComSpec = path.win32.join(systemRoot, "System32", "cmd.exe");
    child.SystemRoot = systemRoot;
    child.WINDIR = windowsDirectory;
  }
  for (const [name, value] of Object.entries(additional)) {
    if (
      !/^[A-Z][A-Z0-9_]*$/u.test(name) ||
      typeof value !== "string" ||
      value.includes("\0") ||
      Object.hasOwn(child, name) ||
      ambientDatabaseNames.includes(name) ||
      ["COMSPEC", "PATH", "SYSTEMROOT", "WINDIR"].includes(name)
    ) {
      throw new Error("child environment extension is unsafe");
    }
    child[name] = value;
  }
  return Object.fromEntries(
    Object.entries(child).sort(([left], [right]) => left.localeCompare(right)),
  );
}

export function assertPrivateTemporaryRoot(
  temporaryRoot,
  { expectedPrefix, temporaryParent },
) {
  const supplied = path.resolve(temporaryRoot);
  const suppliedMetadata = lstatSync(supplied);
  const parent = realpathSync(temporaryParent);
  const candidate = realpathSync(supplied);
  const metadata = lstatSync(candidate);
  if (
    candidate === parent ||
    suppliedMetadata.isSymbolicLink() ||
    path.dirname(candidate) !== parent ||
    !path.basename(candidate).startsWith(expectedPrefix) ||
    path.basename(candidate) === expectedPrefix ||
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    (process.platform !== "win32" && (metadata.mode & 0o777) !== 0o700)
  ) {
    throw new Error("temporary root is unsafe");
  }
  return candidate;
}

function connectOnce(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    let settled = false;
    const finish = (kind) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ kind });
    };
    socket.once("connect", () => finish("connected"));
    socket.once("error", (error) =>
      finish(error?.code === "ECONNREFUSED" ? "refused" : "unknown"),
    );
    socket.setTimeout(250, () => finish("unknown"));
  });
}

export async function assertNoLoopbackListener(
  port,
  {
    delay = (milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)),
    now = () => performance.now(),
    probe = connectOnce,
    stableChecks = 2,
    timeoutMs = 5_000,
  } = {},
) {
  validateDisposablePort(port);
  const boundedTimeout = validateSubrunTimeout(timeoutMs);
  if (!Number.isSafeInteger(stableChecks) || stableChecks < 2) {
    throw new Error("listener stability proof is unsafe");
  }
  const deadline = now() + boundedTimeout;
  let consecutiveRefusals = 0;
  let sawConnected = false;
  while (now() <= deadline) {
    const observation = await probe(port);
    if (observation?.kind === "refused") {
      consecutiveRefusals += 1;
      if (consecutiveRefusals >= stableChecks) return;
    } else {
      consecutiveRefusals = 0;
      if (observation?.kind === "connected") sawConnected = true;
    }
    const remaining = deadline - now();
    if (remaining <= 0) break;
    await delay(Math.min(25, remaining));
  }
  throw new Error(
    sawConnected
      ? "unexpected listener remains on disposable PostgreSQL port"
      : "listener absence could not be proven",
  );
}
export function preserveOperationAndCleanupFailures(
  operationFailure,
  cleanupFailures,
) {
  const operationFailed = operationFailure !== NO_OPERATION_FAILURE;
  if (!operationFailed && cleanupFailures.length === 0) {
    return { failed: false, failure: undefined };
  }
  if (!operationFailed && cleanupFailures.length === 1) {
    return { failed: true, failure: cleanupFailures[0] };
  }
  if (operationFailed && cleanupFailures.length === 0) {
    return { failed: true, failure: operationFailure };
  }
  if (!operationFailed) {
    return {
      failed: true,
      failure: new AggregateError(
        [...cleanupFailures],
        "restore role-boundary cleanup failed",
      ),
    };
  }
  return {
    failed: true,
    failure: new AggregateError(
      [operationFailure, ...cleanupFailures],
      "restore role-boundary cleanup failed",
      { cause: operationFailure },
    ),
  };
}

export async function runRestoreDrillLifecycle({
  cleanup,
  operation,
  releaseChildShutdown = () => undefined,
  signalSource = process,
  terminateActiveChildren,
  writeSuccess,
}) {
  for (const candidate of [
    cleanup,
    operation,
    releaseChildShutdown,
    terminateActiveChildren,
    writeSuccess,
    signalSource?.on,
    signalSource?.off,
  ]) {
    if (typeof candidate !== "function") {
      throw new Error("restore drill lifecycle dependency is invalid");
    }
  }
  let latchedSignal = null;
  let terminationPromise;
  let resolveSignal;
  const signalFired = new Promise((resolve) => {
    resolveSignal = resolve;
  });
  const handlers = new Map();
  const unregister = () => {
    for (const [signal, handler] of handlers) signalSource.off(signal, handler);
  };
  for (const signal of ["SIGINT", "SIGTERM"]) {
    const handler = () => {
      if (latchedSignal !== null) return;
      latchedSignal = signal;
      try {
        terminationPromise = Promise.resolve(terminateActiveChildren(signal));
      } catch (error) {
        terminationPromise = Promise.reject(error);
      }
      terminationPromise.catch(() => {});
      resolveSignal();
    };
    handlers.set(signal, handler);
    signalSource.on(signal, handler);
  }

  const operationPromise = Promise.resolve().then(operation);
  let operationSettled = false;
  const operationOutcome = operationPromise.then(
    () => {
      operationSettled = true;
      return { kind: "settled" };
    },
    (error) => {
      operationSettled = true;
      return { error, kind: "settled" };
    },
  );
  let operationFailure = NO_OPERATION_FAILURE;
  const cleanupFailures = [];
  let cleanupVerified = false;
  let terminationObserved = false;
  const awaitTermination = async () => {
    if (terminationObserved || terminationPromise === undefined) return;
    terminationObserved = true;
    try {
      await terminationPromise;
    } catch (error) {
      cleanupFailures.push(error);
    }
  };
  try {
    const first = await Promise.race([
      operationOutcome,
      signalFired.then(() => ({ kind: "signal" })),
    ]);
    if (first.kind === "signal") {
      await awaitTermination();
      let graceTimer;
      let settled;
      try {
        settled = await Promise.race([
          operationOutcome,
          new Promise((resolve) => {
            graceTimer = setTimeout(
              () => resolve({ kind: "timeout" }),
              CHILD_TERMINATION_GRACE_MS,
            );
          }),
        ]);
      } finally {
        if (graceTimer !== undefined) clearTimeout(graceTimer);
      }
      if (settled.kind === "timeout") {
        cleanupFailures.push(
          new Error("interrupted restore operation did not settle"),
        );
      } else if (Object.hasOwn(settled, "error")) {
        operationFailure = settled.error;
      }
    } else if (Object.hasOwn(first, "error")) {
      operationFailure = first.error;
    }

    try {
      await cleanup();
      cleanupVerified = true;
    } catch (error) {
      cleanupFailures.push(error);
    }
  } finally {
    unregister();
  }
  if (latchedSignal !== null) await awaitTermination();
  if (
    latchedSignal !== null &&
    operationSettled &&
    cleanupVerified &&
    cleanupFailures.length === 0
  ) {
    try {
      releaseChildShutdown();
    } catch (error) {
      cleanupFailures.push(error);
    }
  }
  if (latchedSignal !== null) {
    return {
      exitCode: latchedSignal === "SIGINT" ? 130 : 143,
      signal: latchedSignal,
    };
  }
  const final = preserveOperationAndCleanupFailures(
    operationFailure,
    cleanupFailures,
  );
  if (final.failed) throw final.failure;
  writeSuccess();
  return { exitCode: 0, signal: null };
}

async function removeExactTemporaryRoot(temporaryRoot) {
  const candidate = assertPrivateTemporaryRoot(temporaryRoot, {
    expectedPrefix: temporaryPrefix,
    temporaryParent: os.tmpdir(),
  });
  rmSync(candidate, { force: false, recursive: true });
}

export async function cleanupDisposableCluster(
  state,
  dependencies,
  { attempts = 3, stableChecks = 2 } = {},
) {
  if (
    !Number.isSafeInteger(attempts) ||
    attempts < 1 ||
    attempts > 10 ||
    !Number.isSafeInteger(stableChecks) ||
    stableChecks < 2 ||
    stableChecks > 10
  ) {
    throw new Error("disposable PostgreSQL cleanup proof bounds are unsafe");
  }
  const delay =
    dependencies.delay ??
    ((milliseconds = 25) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const readPid =
    dependencies.readPostmasterPidIfPresent ??
    (async () => state.postmasterPid);
  const observedFailures = [];
  let unsafePidObservation = false;
  const capturePostmasterPid = (candidate) => {
    if (candidate === undefined) return;
    if (!Number.isSafeInteger(candidate) || candidate <= 0) {
      unsafePidObservation = true;
      throw new Error("disposable PostgreSQL recovered PID is invalid");
    }
    if (
      Number.isSafeInteger(state.postmasterPid) &&
      state.postmasterPid > 0 &&
      state.postmasterPid !== candidate
    ) {
      unsafePidObservation = true;
      throw new Error("disposable PostgreSQL postmaster PID changed");
    }
    state.postmasterPid = candidate;
  };
  const capturePidReadFailure = (error) => {
    if (error?.code === "ENOENT") return;
    unsafePidObservation = true;
    observedFailures.push(error);
  };

  let stableAbsence = false;
  for (let attempt = 0; attempt < attempts && !stableAbsence; attempt += 1) {
    try {
      capturePostmasterPid(await readPid(state.dataDirectory));
    } catch (error) {
      capturePidReadFailure(error);
    }

    let stopFailed = false;
    if (state.startAttempted) {
      try {
        await dependencies.stopCluster(state.dataDirectory);
      } catch (error) {
        observedFailures.push(error);
      }
    }

    try {
      capturePostmasterPid(await readPid(state.dataDirectory));
    } catch (error) {
      capturePidReadFailure(error);
      stopFailed = true;
    }
    if (stopFailed) {
      if (attempt + 1 < attempts) await delay(25);
      continue;
    }

    let consecutive = 0;
    while (consecutive < stableChecks) {
      try {
        if (state.startAttempted && state.port === undefined) {
          throw new Error(
            "disposable PostgreSQL listener port was not captured",
          );
        }
        if (state.port !== undefined) {
          await dependencies.assertNoListener(state.port);
        }
        await dependencies.assertPostmasterStopped(
          state.dataDirectory,
          state.postmasterPid,
          state.startAttempted,
        );
        consecutive += 1;
      } catch (error) {
        observedFailures.push(error);
        consecutive = 0;
        break;
      }
      if (consecutive < stableChecks) await delay(25);
    }
    stableAbsence = consecutive === stableChecks;
    if (!stableAbsence && attempt + 1 < attempts) await delay(25);
  }

  if (!stableAbsence || unsafePidObservation) return observedFailures;
  try {
    await dependencies.removeTemporaryRoot(state.temporaryRoot);
    return [];
  } catch (error) {
    return [error];
  }
}
function resolveNativeExecutable(selection, name) {
  const suffix = process.platform === "win32" ? ".exe" : "";
  return path.join(selection.binaryDirectory, `${name}${suffix}`);
}

export function buildBoundedPgConfig(connectionString) {
  if (
    typeof connectionString !== "string" ||
    connectionString.length === 0 ||
    connectionString.includes("\0")
  ) {
    throw new Error("database connection string is unsafe");
  }
  return {
    connectionString,
    connectionTimeoutMillis: DATABASE_CONNECT_TIMEOUT_MS,
    idle_in_transaction_session_timeout: DATABASE_OPERATION_TIMEOUT_MS,
    lock_timeout: DATABASE_LOCK_TIMEOUT_MS,
    query_timeout: DATABASE_OPERATION_TIMEOUT_MS,
    statement_timeout: DATABASE_OPERATION_TIMEOUT_MS,
  };
}

function destroyClientTransport(client) {
  try {
    client?.connection?.stream?.destroy();
  } catch {
    // The timeout remains the primary failure.
  }
}

async function runBoundedClientPhase(client, phase, timeoutMs, operation) {
  const boundedTimeout = validateSubrunTimeout(timeoutMs);
  const observed = Promise.resolve().then(operation);
  observed.catch(() => {});
  let timer;
  try {
    return await Promise.race([
      observed,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          destroyClientTransport(client);
          reject(new Error(`bounded PostgreSQL client ${phase} timed out`));
        }, boundedTimeout);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function runWithBoundedClient(
  client,
  operation,
  {
    connectMs = DATABASE_CONNECT_TIMEOUT_MS,
    endMs = DATABASE_CONNECT_TIMEOUT_MS,
    queryMs = DATABASE_OPERATION_TIMEOUT_MS,
  } = {},
) {
  if (
    typeof client?.connect !== "function" ||
    typeof client?.end !== "function" ||
    typeof operation !== "function"
  ) {
    throw new Error("bounded PostgreSQL client dependency is invalid");
  }
  for (const timeout of [connectMs, queryMs, endMs]) {
    validateSubrunTimeout(timeout);
  }
  if (connectMs + queryMs + endMs > MAX_SUBRUN_MS) {
    throw new Error("bounded PostgreSQL client timeout budget is unsafe");
  }

  let operationFailure = NO_OPERATION_FAILURE;
  let result;
  try {
    await runBoundedClientPhase(client, "connect", connectMs, () =>
      client.connect(),
    );
    result = await runBoundedClientPhase(client, "query", queryMs, () =>
      operation(client),
    );
  } catch (error) {
    operationFailure = error;
  }
  const cleanupFailures = [];
  try {
    await runBoundedClientPhase(client, "end", endMs, () => client.end());
  } catch (error) {
    cleanupFailures.push(error);
  }
  const final = preserveOperationAndCleanupFailures(
    operationFailure,
    cleanupFailures,
  );
  if (final.failed) throw final.failure;
  return result;
}

export function migrationMajorGuard(expectedMajor) {
  if (expectedMajor === 17) return { requiredPostgresMajor: 17 };
  if (expectedMajor === 18) return {};
  throw new Error("unsupported PostgreSQL compatibility major");
}

export function buildPostgresStartArguments(state) {
  validateDisposablePort(state.port);
  for (const candidate of [state.dataDirectory, state.logFile]) {
    if (
      typeof candidate !== "string" ||
      !path.isAbsolute(candidate) ||
      candidate.includes("\0")
    ) {
      throw new Error("disposable PostgreSQL path is unsafe");
    }
  }
  return [
    "start",
    "--pgdata",
    state.dataDirectory,
    "--log",
    state.logFile,
    "--options",
    `-h 127.0.0.1 -p ${state.port} -c unix_socket_directories=`,
    "--wait",
    "--timeout",
    "15",
  ];
}

const activeBoundedChildren = new Set();
const CLEANUP_BOUNDED_CHILD_LANE = Symbol("cleanup bounded child lane");
let boundedChildShutdownActive = false;

function releaseBoundedChildShutdown() {
  boundedChildShutdownActive = false;
}

function requireChildPid(child) {
  if (!Number.isSafeInteger(child.pid) || child.pid <= 0) {
    throw new Error("bounded child PID is invalid");
  }
  return child.pid;
}

function terminateOwnedChildTree(child, environment) {
  const pid = requireChildPid(child);
  if (process.platform === "win32") {
    const systemRoot = environment?.SystemRoot ?? environment?.SYSTEMROOT;
    if (
      typeof systemRoot !== "string" ||
      !path.win32.isAbsolute(systemRoot) ||
      systemRoot.includes("\0")
    ) {
      throw new Error("Windows child-tree terminator is unavailable");
    }
    const result = spawnSync(
      path.win32.join(systemRoot, "System32", "taskkill.exe"),
      ["/PID", String(pid), "/T", "/F"],
      {
        env: environment,
        shell: false,
        stdio: "ignore",
        timeout: CHILD_TERMINATION_GRACE_MS,
        windowsHide: true,
      },
    );
    if (result.error !== undefined || result.status !== 0) {
      throw new Error("bounded Windows child tree could not be terminated");
    }
    return { windowsTreeKilled: true };
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
  return { windowsTreeKilled: false };
}

function ownedChildTreeIsAbsent(child, termination) {
  if (process.platform === "win32") return termination.windowsTreeKilled;
  let pid;
  try {
    pid = requireChildPid(child);
  } catch {
    return false;
  }
  try {
    process.kill(-pid, 0);
    return false;
  } catch (error) {
    if (error?.code === "ESRCH") return true;
    throw error;
  }
}

export async function terminateActiveBoundedChildren(signal = "SIGTERM") {
  boundedChildShutdownActive = true;
  const snapshot = [...activeBoundedChildren];
  const results = await Promise.allSettled(
    snapshot.map((entry) => {
      try {
        return Promise.resolve(entry.terminate(signal));
      } catch (error) {
        return Promise.reject(error);
      }
    }),
  );
  const failures = results
    .filter((result) => result.status === "rejected")
    .map((result) => result.reason);
  if (activeBoundedChildren.size !== 0) {
    failures.push(new Error("bounded operation child registry did not drain"));
  }
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      "bounded operation child shutdown failed",
    );
  }
}
export async function runBounded(
  command,
  args,
  {
    cwd = repositoryRoot,
    environment,
    outputMode = "capture",
    shutdownLane,
    timeoutMs = MAX_SUBRUN_MS,
    stdin,
  } = {},
) {
  if (!["capture", "ignore"].includes(outputMode)) {
    throw new Error("bounded child output mode is invalid");
  }
  const captureOutput = outputMode === "capture";
  const cleanupLane = shutdownLane === CLEANUP_BOUNDED_CHILD_LANE;
  if (shutdownLane !== undefined && !cleanupLane) {
    throw new Error("bounded child shutdown lane is invalid");
  }
  if (boundedChildShutdownActive && !cleanupLane) {
    throw new Error("bounded child shutdown is active");
  }
  const boundedTimeout = validateSubrunTimeout(timeoutMs);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      detached: process.platform !== "win32",
      env: environment,
      shell: false,
      stdio: captureOutput
        ? ["pipe", "pipe", "pipe"]
        : ["pipe", "ignore", "ignore"],
      windowsHide: true,
    });
    const stdout = [];
    const stderr = [];
    let outputBytes = 0;
    let settled = false;
    let closed = false;
    let closeResult;
    let operationTimer;
    let terminationPoll;
    let terminationState;
    let resolveTermination;
    const terminationDone = new Promise((resolveDone) => {
      resolveTermination = resolveDone;
    });
    const maximumOutputBytes = 4 * 1024 * 1024;

    const clearTimers = () => {
      if (operationTimer !== undefined) clearTimeout(operationTimer);
      if (terminationPoll !== undefined) clearTimeout(terminationPoll);
    };
    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimers();
      activeBoundedChildren.delete(tracked);
      resolveTermination();
      callback(value);
    };
    const failureValue = () =>
      preserveOperationAndCleanupFailures(
        terminationState.primary,
        terminationState.cleanupFailures,
      ).failure;
    const destroyPipes = () => {
      child.stdin?.destroy();
      child.stdout?.destroy();
      child.stderr?.destroy();
    };
    const pollTermination = () => {
      if (settled || terminationState === undefined) return;
      let treeAbsent = false;
      try {
        treeAbsent = ownedChildTreeIsAbsent(child, terminationState.tree);
      } catch (error) {
        terminationState.proofFailure ??= error;
      }
      if (treeAbsent && closed) {
        if (terminationState.proofFailure !== undefined) {
          terminationState.cleanupFailures.push(terminationState.proofFailure);
        }
        settle(reject, failureValue());
        return;
      }
      if (performance.now() >= terminationState.deadline) {
        if (!treeAbsent) {
          terminationState.cleanupFailures.push(
            new Error("bounded child tree survived termination grace"),
          );
        }
        if (!closed) {
          terminationState.cleanupFailures.push(
            new Error("bounded child close exceeded termination grace"),
          );
        }
        if (terminationState.proofFailure !== undefined) {
          terminationState.cleanupFailures.push(terminationState.proofFailure);
        }
        destroyPipes();
        settle(reject, failureValue());
        return;
      }
      terminationPoll = setTimeout(pollTermination, 20);
    };
    const beginFailure = (primary) => {
      if (terminationState !== undefined || settled) return terminationDone;
      if (operationTimer !== undefined) clearTimeout(operationTimer);
      terminationState = {
        cleanupFailures: [],
        deadline: performance.now() + CHILD_TERMINATION_GRACE_MS,
        primary,
        tree: { windowsTreeKilled: false },
      };
      try {
        terminationState.tree = terminateOwnedChildTree(child, environment);
      } catch (error) {
        terminationState.cleanupFailures.push(error);
        try {
          child.kill("SIGKILL");
        } catch (fallbackError) {
          terminationState.cleanupFailures.push(fallbackError);
        }
      }
      pollTermination();
      return terminationDone;
    };
    const tracked = {
      terminate: (signal) =>
        beginFailure(
          new Error(
            `bounded restore role-boundary child interrupted by ${signal}`,
          ),
        ),
    };
    if (!cleanupLane) activeBoundedChildren.add(tracked);

    const capture = (target) => (chunk) => {
      if (terminationState !== undefined) return;
      outputBytes += chunk.length;
      if (outputBytes > maximumOutputBytes) {
        void beginFailure(new Error("bounded child output limit exceeded"));
        return;
      }
      target.push(chunk);
    };
    if (captureOutput) {
      child.stdout.on("data", capture(stdout));
      child.stderr.on("data", capture(stderr));
    }
    child.stdin.on("error", () => undefined);
    child.once("error", (error) => {
      if (terminationState === undefined) settle(reject, error);
    });
    operationTimer = setTimeout(() => {
      void beginFailure(new Error("bounded child timed out"));
    }, boundedTimeout);
    operationTimer.unref();
    child.once("close", (code, signal) => {
      closed = true;
      closeResult = {
        code,
        signal,
        stderr: Buffer.concat(stderr).toString("utf8"),
        stdout: Buffer.concat(stdout).toString("utf8"),
      };
      if (terminationState !== undefined) {
        pollTermination();
      } else if (signal !== null || code !== 0) {
        settle(reject, new Error("bounded restore role-boundary child failed"));
      } else {
        settle(resolve, closeResult);
      }
    });
    if (stdin === undefined) child.stdin.end();
    else child.stdin.end(stdin);
  });
}

async function allocateDisposablePort() {
  const server = net.createServer();
  let operationFailure = NO_OPERATION_FAILURE;
  let port;
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("unable to allocate a disposable PostgreSQL port");
    }
    port = validateDisposablePort(address.port);
  } catch (error) {
    operationFailure = error;
  }
  const cleanupFailures = [];
  if (server.listening) {
    try {
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    } catch (error) {
      cleanupFailures.push(error);
    }
  }
  const final = preserveOperationAndCleanupFailures(
    operationFailure,
    cleanupFailures,
  );
  if (final.failed) throw final.failure;
  await assertNoLoopbackListener(port, { timeoutMs: 1_000 });
  return port;
}

function databaseUrl({ database, password, port, username }) {
  return `postgresql://${encodeURIComponent(username)}:${encodeURIComponent(
    password,
  )}@127.0.0.1:${port}/${encodeURIComponent(database)}`;
}

function canonicalRoleUrl({ database, password, username }) {
  return `postgresql://${encodeURIComponent(username)}:${encodeURIComponent(
    password,
  )}@postgres:5432/${encodeURIComponent(database)}`;
}

function rolePasswords() {
  const password = () => randomBytes(32).toString("hex");
  return Object.freeze({
    bootstrap: password(),
    app: password(),
    migrator: password(),
    worker: password(),
    ops: password(),
    backupReporter: password(),
  });
}

function roleConfiguration(database, passwords) {
  return Object.freeze({
    postgresUser: RESTORE_BOOTSTRAP_IDENTITY,
    postgresDatabase: database,
    databaseBootstrapUrl: canonicalRoleUrl({
      database,
      password: passwords.bootstrap,
      username: RESTORE_BOOTSTRAP_IDENTITY,
    }),
    databaseAppUrl: canonicalRoleUrl({
      database,
      password: passwords.app,
      username: "learncoding_app",
    }),
    databaseMigratorUrl: canonicalRoleUrl({
      database,
      password: passwords.migrator,
      username: "learncoding_migrator",
    }),
    databaseWorkerUrl: canonicalRoleUrl({
      database,
      password: passwords.worker,
      username: "learncoding_worker",
    }),
    databaseOpsUrl: canonicalRoleUrl({
      database,
      password: passwords.ops,
      username: "learncoding_ops",
    }),
    databaseBackupReporterUrl: canonicalRoleUrl({
      database,
      password: passwords.backupReporter,
      username: "learncoding_backup_reporter",
    }),
  });
}

function actualRoleUrls(database, passwords, port) {
  return Object.freeze({
    bootstrap: databaseUrl({
      database,
      password: passwords.bootstrap,
      port,
      username: RESTORE_BOOTSTRAP_IDENTITY,
    }),
    app: databaseUrl({
      database,
      password: passwords.app,
      port,
      username: "learncoding_app",
    }),
    migrator: databaseUrl({
      database,
      password: passwords.migrator,
      port,
      username: "learncoding_migrator",
    }),
    worker: databaseUrl({
      database,
      password: passwords.worker,
      port,
      username: "learncoding_worker",
    }),
    ops: databaseUrl({
      database,
      password: passwords.ops,
      port,
      username: "learncoding_ops",
    }),
    backupReporter: databaseUrl({
      database,
      password: passwords.backupReporter,
      port,
      username: "learncoding_backup_reporter",
    }),
  });
}

export function createBoundedRolePoolFactory(actualUrls) {
  const keyByRole = Object.freeze({
    learncoding_app: "app",
    learncoding_backup_reporter: "backupReporter",
    learncoding_migrator: "migrator",
    learncoding_ops: "ops",
    learncoding_worker: "worker",
  });
  return ({ role }) => {
    const key = keyByRole[role];
    const connectionString = key === undefined ? undefined : actualUrls[key];
    if (connectionString === undefined) {
      throw new Error("restore verifier requested an unknown database role");
    }
    return new Pool({ ...buildBoundedPgConfig(connectionString), max: 1 });
  };
}

function writePrivateFile(filePath, contents) {
  writeFileSync(filePath, contents, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  chmodSync(filePath, 0o600);
}

export function createTypeScriptLoader(temporaryRoot) {
  const loaderPath = path.join(temporaryRoot, "typescript-loader.mjs");
  const typescriptPath = path.join(
    repositoryRoot,
    "node_modules",
    "typescript",
    "lib",
    "typescript.js",
  );
  const source = `
    import { access, readFile } from "node:fs/promises";
    import { fileURLToPath, pathToFileURL } from "node:url";
    import ts from ${JSON.stringify(pathToFileURL(typescriptPath).href)};
    const sourceRoot = ${JSON.stringify(path.join(repositoryRoot, "src"))};
    async function firstExisting(candidates) {
      for (const candidate of candidates) {
        try { await access(candidate); return pathToFileURL(candidate).href; }
        catch {}
      }
      return undefined;
    }
    export async function resolve(specifier, context, nextResolve) {
      if (specifier.startsWith("@/")) {
        const base = sourceRoot + "/" + specifier.slice(2);
        const resolved = await firstExisting([base + ".ts", base + ".tsx", base + "/index.ts"]);
        if (resolved) return { shortCircuit: true, url: resolved };
      }
      if (specifier.startsWith(".") && !/[.]\\w+$/u.test(specifier)) {
        const base = fileURLToPath(new URL(specifier, context.parentURL));
        const resolved = await firstExisting([
          base + ".ts",
          base + ".tsx",
          base + "/index.ts",
        ]);
        if (resolved) return { shortCircuit: true, url: resolved };
      }
      return nextResolve(specifier, context);
    }
    export async function load(url, context, nextLoad) {
      if (url.endsWith(".ts") || url.endsWith(".tsx")) {
        const input = await readFile(new URL(url), "utf8");
        const output = ts.transpileModule(input, {
          compilerOptions: {
            jsx: ts.JsxEmit.ReactJSX,
            module: ts.ModuleKind.ESNext,
            moduleResolution: ts.ModuleResolutionKind.Bundler,
            target: ts.ScriptTarget.ES2022,
          },
          fileName: new URL(url).pathname,
          reportDiagnostics: false,
        }).outputText;
        return { format: "module", shortCircuit: true, source: output };
      }
      return nextLoad(url, context);
    }
  `;
  writePrivateFile(loaderPath, source);
  return loaderPath;
}

export function createVerifierRunner(temporaryRoot) {
  const runnerPath = path.join(temporaryRoot, "restore-verifier-runner.mjs");
  const verifierPath = path.join(
    repositoryRoot,
    "scripts/verify-restored-backup.ts",
  );
  const source = `
    import { readFile } from "node:fs/promises";
    const verifier = await import(${JSON.stringify(pathToFileURL(verifierPath).href)});
    const operation = process.argv[2];
    const restoreBootstrapIdentity = ${JSON.stringify(RESTORE_BOOTSTRAP_IDENTITY)};
    if (operation === "probe") {
      process.stdout.write("restore_verifier_loader=PASS\\n");
    } else {
      const context = JSON.parse(await readFile(process.argv[3], "utf8"));
      const result = await verifier.runWithRestoreDatabaseClient(
        context.connectionString,
        async (client) => {
          if (operation === "install") {
            return verifier.installRestoreLedgerAuthority(client, {
              expectedBootstrapUser: restoreBootstrapIdentity,
              expectedDatabase: context.database,
              requireLedger: true,
            });
          }
          if (operation === "remove") {
            return verifier.removeRestoreLedgerAuthorityBeforeBootstrap(client, {
              expectedBootstrapUser: restoreBootstrapIdentity,
              expectedDatabase: context.database,
            });
          }
          if (operation === "verify") {
            return verifier.verifyDatabaseSchema(client);
          }
          throw new Error("restore verifier operation is invalid");
        },
      );
      process.stdout.write(JSON.stringify(result) + "\\n");
    }
  `;
  writePrivateFile(runnerPath, source);
  return { runnerPath, verifierPath };
}

export function createVerifierContextFile({
  connectionString,
  database,
  operation,
  temporaryRoot,
}) {
  if (
    !["install", "remove", "verify"].includes(operation) ||
    typeof connectionString !== "string" ||
    connectionString.length === 0 ||
    connectionString.includes("\0") ||
    typeof database !== "string" ||
    !/^[a-z_][a-z0-9_]{0,62}$/u.test(database)
  ) {
    throw new Error("restore verifier context is unsafe");
  }
  const contextPath = path.join(
    temporaryRoot,
    `restore-verifier-${operation}-${randomBytes(16).toString("hex")}.json`,
  );
  writePrivateFile(
    contextPath,
    `${JSON.stringify({ connectionString, database })}\n`,
  );
  return contextPath;
}

async function runVerifierOperation({
  childEnvironment,
  connectionString,
  database,
  loaderPath,
  operation,
  runnerPath,
  temporaryRoot,
}) {
  const contextPath = createVerifierContextFile({
    connectionString,
    database,
    operation,
    temporaryRoot,
  });
  let operationFailure = NO_OPERATION_FAILURE;
  let parsed;
  try {
    const result = await runBounded(
      process.execPath,
      [
        "--experimental-loader",
        pathToFileURL(loaderPath).href,
        runnerPath,
        operation,
        contextPath,
      ],
      { environment: childEnvironment },
    );
    parsed = JSON.parse(result.stdout);
  } catch (error) {
    operationFailure = error;
  }
  const cleanupFailures = [];
  try {
    unlinkSync(contextPath);
  } catch (error) {
    cleanupFailures.push(error);
  }
  const final = preserveOperationAndCleanupFailures(
    operationFailure,
    cleanupFailures,
  );
  if (final.failed) throw final.failure;
  return parsed;
}

export function assertPostmasterStopped(
  dataDirectory,
  postmasterPid,
  startAttempted = false,
) {
  if (
    startAttempted &&
    (!Number.isInteger(postmasterPid) || postmasterPid <= 0)
  ) {
    throw new Error("disposable PostgreSQL postmaster PID was not captured");
  }
  if (Number.isInteger(postmasterPid) && postmasterPid > 0) {
    try {
      process.kill(postmasterPid, 0);
      throw new Error("disposable PostgreSQL postmaster remains");
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
  }
  const pidPath = path.join(dataDirectory, "postmaster.pid");
  if (existsSync(pidPath)) {
    throw new Error("disposable PostgreSQL postmaster PID file remains");
  }
}

async function waitForListener(port, timeoutMs = 10_000) {
  const deadline = Date.now() + validateSubrunTimeout(timeoutMs);
  do {
    if ((await connectOnce(port)).kind === "connected") return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  } while (Date.now() < deadline);
  throw new Error("disposable PostgreSQL listener did not start");
}

function readPostmasterPid(dataDirectory, readFile = readFileSync) {
  const pidText = readFile(
    path.join(dataDirectory, "postmaster.pid"),
    "utf8",
  ).split(/\r?\n/u)[0];
  if (!/^[1-9][0-9]*$/u.test(pidText)) {
    throw new Error("disposable PostgreSQL postmaster PID is invalid");
  }
  const postmasterPid = Number(pidText);
  if (!Number.isSafeInteger(postmasterPid) || postmasterPid <= 0) {
    throw new Error("disposable PostgreSQL postmaster PID is invalid");
  }
  return postmasterPid;
}

export function readPostmasterPidIfPresent(
  dataDirectory,
  { fileExists = existsSync, readFile = readFileSync } = {},
) {
  if (typeof fileExists !== "function" || typeof readFile !== "function") {
    throw new Error("postmaster PID reader dependency is invalid");
  }
  const pidPath = path.join(dataDirectory, "postmaster.pid");
  if (!fileExists(pidPath)) return undefined;
  try {
    return readPostmasterPid(dataDirectory, readFile);
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

async function assertServerConfiguration(connectionString, expectedMajor) {
  const client = new Client(buildBoundedPgConfig(connectionString));
  const row = await runWithBoundedClient(client, async (connectedClient) => {
    const result = await connectedClient.query(`
      select pg_catalog.current_setting('server_version_num') server_version_num,
             pg_catalog.current_setting('data_checksums') data_checksums,
             pg_catalog.current_setting('server_encoding') server_encoding
    `);
    if (result.rows.length !== 1) {
      throw new Error("disposable PostgreSQL settings are invalid");
    }
    return result.rows[0];
  });
  const versionNumber = row?.server_version_num;
  if (
    typeof versionNumber !== "string" ||
    !/^[1-9][0-9]{4,7}$/u.test(versionNumber) ||
    Math.floor(Number.parseInt(versionNumber, 10) / 10_000) !== expectedMajor ||
    row.data_checksums !== "on" ||
    row.server_encoding !== "UTF8"
  ) {
    throw new Error("disposable PostgreSQL configuration is invalid");
  }
}
async function runRestoreProof(
  selection,
  state,
  { nativeEnvironment, verifierEnvironment },
) {
  const nativeExecutable = (name) => resolveNativeExecutable(selection, name);
  const passwords = rolePasswords();
  const sourceDatabase = "learncoding_restore_source";
  const restoredDatabase = "learncoding_restore_target";
  const pgPassFile = path.join(state.temporaryRoot, "pgpass");
  const passwordFile = path.join(state.temporaryRoot, "bootstrap-password");
  const dumpPath = path.join(state.temporaryRoot, "source.dump");
  const loaderPath = createTypeScriptLoader(state.temporaryRoot);
  const { runnerPath } = createVerifierRunner(state.temporaryRoot);
  const sourceActual = actualRoleUrls(sourceDatabase, passwords, state.port);
  const restoredActual = actualRoleUrls(
    restoredDatabase,
    passwords,
    state.port,
  );
  const sourceCanonical = roleConfiguration(sourceDatabase, passwords);
  const restoredCanonical = roleConfiguration(restoredDatabase, passwords);
  const migrationsFolder = path.join(repositoryRoot, "drizzle");

  writePrivateFile(passwordFile, `${passwords.bootstrap}\n`);
  writePrivateFile(
    pgPassFile,
    `127.0.0.1:${state.port}:*:${RESTORE_BOOTSTRAP_IDENTITY}:${passwords.bootstrap}\n`,
  );

  await runBounded(
    nativeExecutable("initdb"),
    [
      "--auth-host=scram-sha-256",
      "--auth-local=scram-sha-256",
      "--data-checksums",
      "--encoding=UTF8",
      "--no-locale",
      `--pgdata=${state.dataDirectory}`,
      `--pwfile=${passwordFile}`,
      `--username=${RESTORE_BOOTSTRAP_IDENTITY}`,
    ],
    { environment: nativeEnvironment },
  );
  unlinkSync(passwordFile);
  const control = nativeExecutable("pg_ctl");
  state.startAttempted = true;
  await runBounded(control, buildPostgresStartArguments(state), {
    environment: nativeEnvironment,
    outputMode: process.platform === "win32" ? "ignore" : "capture",
  });
  state.postmasterPid = readPostmasterPid(state.dataDirectory);
  state.startCompleted = true;
  await waitForListener(state.port);

  const maintenanceUrl = databaseUrl({
    database: "postgres",
    password: passwords.bootstrap,
    port: state.port,
    username: RESTORE_BOOTSTRAP_IDENTITY,
  });
  await assertServerConfiguration(maintenanceUrl, selection.expectedMajor);
  await runBounded(
    nativeExecutable("createdb"),
    [
      "--host=127.0.0.1",
      `--port=${state.port}`,
      `--username=${RESTORE_BOOTSTRAP_IDENTITY}`,
      "--maintenance-db=postgres",
      sourceDatabase,
    ],
    { environment: nativeEnvironment },
  );

  const sourceBootstrapPool = new Pool({
    ...buildBoundedPgConfig(sourceActual.bootstrap),
    max: 1,
  });
  const sourceClusterAdministrationPool = new Pool({
    ...buildBoundedPgConfig(maintenanceUrl),
    max: 1,
  });
  await runDatabaseRoleBootstrap({
    ...sourceCanonical,
    lockTimeoutMs: DATABASE_LOCK_TIMEOUT_MS,
    pool: sourceBootstrapPool,
    clusterAdministrationPool: sourceClusterAdministrationPool,
    requireCompleteMigrationLedger: false,
  });
  const migrationPool = new Pool({
    ...buildBoundedPgConfig(sourceActual.migrator),
    max: 1,
  });
  await runProductionMigration({
    ...migrationMajorGuard(selection.expectedMajor),
    migrationsFolder,
    pool: migrationPool,
  });
  const sourceReconcilePool = new Pool({
    ...buildBoundedPgConfig(sourceActual.bootstrap),
    max: 1,
  });
  const sourceReconcileClusterAdministrationPool = new Pool({
    ...buildBoundedPgConfig(maintenanceUrl),
    max: 1,
  });
  await runDatabaseRoleBootstrap({
    ...sourceCanonical,
    lockTimeoutMs: DATABASE_LOCK_TIMEOUT_MS,
    pool: sourceReconcilePool,
    clusterAdministrationPool:
      sourceReconcileClusterAdministrationPool,
    requireCompleteMigrationLedger: true,
  });
  await verifyDatabaseRoleBoundaries({
    ...sourceCanonical,
    lockTimeoutMs: DATABASE_LOCK_TIMEOUT_MS,
    poolFactory: createBoundedRolePoolFactory(sourceActual),
    requireApplicationObjects: true,
  });

  await runBounded(
    nativeExecutable("pg_dump"),
    [
      "--format=custom",
      "--no-owner",
      "--no-acl",
      "--host=127.0.0.1",
      `--port=${state.port}`,
      `--username=${RESTORE_BOOTSTRAP_IDENTITY}`,
      `--file=${dumpPath}`,
      sourceDatabase,
    ],
    { environment: nativeEnvironment },
  );
  await runBounded(
    nativeExecutable("dropdb"),
    [
      "--host=127.0.0.1",
      `--port=${state.port}`,
      `--username=${RESTORE_BOOTSTRAP_IDENTITY}`,
      "--maintenance-db=postgres",
      sourceDatabase,
    ],
    { environment: nativeEnvironment },
  );
  await runBounded(
    nativeExecutable("createdb"),
    [
      "--host=127.0.0.1",
      `--port=${state.port}`,
      `--username=${RESTORE_BOOTSTRAP_IDENTITY}`,
      "--maintenance-db=postgres",
      restoredDatabase,
    ],
    { environment: nativeEnvironment },
  );

  const restoredPreBootstrapPool = new Pool({
    ...buildBoundedPgConfig(restoredActual.bootstrap),
    max: 1,
  });
  const restoredPreClusterAdministrationPool = new Pool({
    ...buildBoundedPgConfig(maintenanceUrl),
    max: 1,
  });
  await runDatabaseRoleBootstrap({
    ...restoredCanonical,
    lockTimeoutMs: DATABASE_LOCK_TIMEOUT_MS,
    pool: restoredPreBootstrapPool,
    clusterAdministrationPool: restoredPreClusterAdministrationPool,
    requireCompleteMigrationLedger: false,
  });
  await verifyDatabaseRoleBoundaries({
    ...restoredCanonical,
    lockTimeoutMs: DATABASE_LOCK_TIMEOUT_MS,
    poolFactory: createBoundedRolePoolFactory(restoredActual),
    requireApplicationObjects: false,
  });

  await runBounded(
    nativeExecutable("pg_restore"),
    [
      "--exit-on-error",
      "--no-owner",
      "--no-acl",
      "--role=learncoding_owner",
      "--host=127.0.0.1",
      `--port=${state.port}`,
      `--username=${RESTORE_BOOTSTRAP_IDENTITY}`,
      `--dbname=${restoredDatabase}`,
      dumpPath,
    ],
    { environment: nativeEnvironment },
  );

  await runVerifierOperation({
    childEnvironment: verifierEnvironment,
    connectionString: restoredActual.bootstrap,
    database: restoredDatabase,
    loaderPath,
    operation: "remove",
    runnerPath,
    temporaryRoot: state.temporaryRoot,
  });

  const restoredBootstrapPool = new Pool({
    ...buildBoundedPgConfig(restoredActual.bootstrap),
    max: 1,
  });
  const restoredMaintenancePool = new Pool({
    ...buildBoundedPgConfig(maintenanceUrl),
    max: 1,
  });
  await runDatabaseRoleBootstrap({
    ...restoredCanonical,
    bootstrapMode: "restored-no-acl",
    lockTimeoutMs: DATABASE_LOCK_TIMEOUT_MS,
    pool: restoredBootstrapPool,
    requireCompleteMigrationLedger: true,
    restoreMaintenancePool: restoredMaintenancePool,
  });
  await verifyDatabaseRoleBoundaries({
    ...restoredCanonical,
    lockTimeoutMs: DATABASE_LOCK_TIMEOUT_MS,
    poolFactory: createBoundedRolePoolFactory(restoredActual),
    requireApplicationObjects: true,
  });
  await runVerifierOperation({
    childEnvironment: verifierEnvironment,
    connectionString: restoredActual.bootstrap,
    database: restoredDatabase,
    loaderPath,
    operation: "install",
    runnerPath,
    temporaryRoot: state.temporaryRoot,
  });
  const verification = await runVerifierOperation({
    childEnvironment: verifierEnvironment,
    connectionString: restoredActual.ops,
    database: restoredDatabase,
    loaderPath,
    operation: "verify",
    runnerPath,
    temporaryRoot: state.temporaryRoot,
  });
  if (
    verification.appliedMigrationCount !== REVIEWED_MIGRATION_LEDGER.length ||
    verification.migrationLedgerSha256 !== REVIEWED_MIGRATION_LEDGER_SHA256
  ) {
    throw new Error("restored migration ledger proof is invalid");
  }

  const opsClient = new Client(buildBoundedPgConfig(restoredActual.ops));
  await runWithBoundedClient(opsClient, async (connectedClient) => {
    await assert.rejects(
      connectedClient.query(
        "select hash from drizzle.__drizzle_migrations limit 1",
      ),
      (error) => error?.code === "42501",
    );
    await assert.rejects(
      connectedClient.query(
        "update drizzle.__drizzle_migrations set hash = hash where false",
      ),
      (error) => error?.code === "42501",
    );
  });
}

async function main() {
  const state = {
    dataDirectory: undefined,
    logFile: undefined,
    port: undefined,
    postmasterPid: undefined,
    startAttempted: false,
    startCompleted: false,
    temporaryRoot: undefined,
  };
  let nativeExecutable;
  let nativeEnvironment;
  const result = await runRestoreDrillLifecycle({
    cleanup: async () => {
      if (state.temporaryRoot === undefined) return;
      const cleanupFailures = await cleanupDisposableCluster(state, {
        assertNoListener: assertNoLoopbackListener,
        assertPostmasterStopped,
        readPostmasterPidIfPresent,
        removeTemporaryRoot: removeExactTemporaryRoot,
        stopCluster: async (dataDirectory) => {
          if (!state.startAttempted || !existsSync(dataDirectory)) return;
          if (
            nativeEnvironment === undefined ||
            nativeExecutable === undefined
          ) {
            throw new Error("native cleanup environment is unavailable");
          }
          await runBounded(
            nativeExecutable("pg_ctl"),
            [
              "stop",
              "--pgdata",
              dataDirectory,
              "--mode=immediate",
              "--wait",
              "--timeout",
              "15",
            ],
            {
              environment: nativeEnvironment,
              shutdownLane: CLEANUP_BOUNDED_CHILD_LANE,
            },
          );
        },
      });
      const final = preserveOperationAndCleanupFailures(
        NO_OPERATION_FAILURE,
        cleanupFailures,
      );
      if (final.failed) throw final.failure;
    },
    operation: async () => {
      assertNoAmbientDatabaseEnvironment(process.env);
      const selection = resolvePostgresSelection(process.env);
      nativeExecutable = (name) => resolveNativeExecutable(selection, name);
      const temporaryRoot = mkdtempSync(
        path.join(os.tmpdir(), temporaryPrefix),
      );
      state.dataDirectory = path.join(temporaryRoot, "data");
      state.logFile = path.join(temporaryRoot, "postgres.log");
      state.temporaryRoot = temporaryRoot;
      chmodSync(temporaryRoot, 0o700);
      const canonicalRoot = assertPrivateTemporaryRoot(temporaryRoot, {
        expectedPrefix: temporaryPrefix,
        temporaryParent: os.tmpdir(),
      });
      state.dataDirectory = path.join(canonicalRoot, "data");
      state.logFile = path.join(canonicalRoot, "postgres.log");
      state.temporaryRoot = canonicalRoot;
      state.port = await allocateDisposablePort();
      const pgPassFile = path.join(canonicalRoot, "pgpass");
      nativeEnvironment = buildCleanChildEnvironment({
        environment: process.env,
        pgPassFile,
        temporaryRoot: canonicalRoot,
      });
      const verifierEnvironment = buildCleanChildEnvironment({
        environment: process.env,
        temporaryRoot: canonicalRoot,
      });
      const version = await runBounded(
        nativeExecutable("postgres"),
        ["--version"],
        { environment: nativeEnvironment, timeoutMs: 10_000 },
      );
      validatePostgresVersionOutput(version.stdout, selection.expectedMajor);
      await access(path.join(repositoryRoot, "drizzle"));
      await runRestoreProof(selection, state, {
        nativeEnvironment,
        verifierEnvironment,
      });
    },
    releaseChildShutdown: releaseBoundedChildShutdown,
    signalSource: process,
    terminateActiveChildren: terminateActiveBoundedChildren,
    writeSuccess: () => process.stdout.write(SUCCESS_MARKER),
  });
  return result;
}
export function invokedAsMain(argument = process.argv[1]) {
  if (argument === undefined) return false;
  try {
    return (
      realpathSync(path.resolve(argument)) ===
      realpathSync(fileURLToPath(import.meta.url))
    );
  } catch {
    return false;
  }
}

if (invokedAsMain()) {
  main().then(
    ({ exitCode }) => {
      if (exitCode !== 0) process.stderr.write(FAILURE_MARKER);
      process.exitCode = exitCode;
    },
    (error) => {
      process.stderr.write(FAILURE_MARKER);
      process.stderr.write(formatRestoreDrillFailureDiagnostic(error));
      process.exitCode = 1;
    },
  );
}
