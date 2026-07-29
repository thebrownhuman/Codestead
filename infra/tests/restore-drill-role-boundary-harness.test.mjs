import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import * as harness from "./restore-drill-role-boundary.integration.mjs";
import {
  FAILURE_MARKER,
  MAX_SUBRUN_MS,
  NO_OPERATION_FAILURE,
  SUCCESS_MARKER,
  assertNoAmbientDatabaseEnvironment,
  assertNoLoopbackListener,
  assertPostmasterStopped,
  assertPrivateTemporaryRoot,
  buildBoundedPgConfig,
  buildCleanChildEnvironment,
  buildPostgresStartArguments,
  cleanupDisposableCluster,
  createBoundedRolePoolFactory,
  createTypeScriptLoader,
  createVerifierContextFile,
  createVerifierRunner,
  migrationMajorGuard,
  preserveOperationAndCleanupFailures,
  resolvePostgresSelection,
  validateDisposablePort,
  validatePostgresVersionOutput,
  validateSubrunTimeout,
} from "./restore-drill-role-boundary.integration.mjs";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(testDirectory, "../..");
const harnessPath = path.join(
  testDirectory,
  "restore-drill-role-boundary.integration.mjs",
);
const harnessSource = readFileSync(harnessPath, "utf8");

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

function recoverRecordedPid(pidFile, currentPid) {
  if (Number.isSafeInteger(currentPid) && currentPid > 0) return currentPid;
  if (!existsSync(pidFile)) return undefined;
  const text = readFileSync(pidFile, "utf8").trim();
  if (!/^[1-9][0-9]*$/u.test(text)) return undefined;
  const recoveredPid = Number(text);
  if (!Number.isSafeInteger(recoveredPid) || recoveredPid <= 0) {
    return undefined;
  }
  return recoveredPid;
}

test("native runtime selection requires exactly one non-empty unpadded selector", () => {
  assert.throws(
    () => resolvePostgresSelection({}),
    /exactly one of POSTGRES_17_BIN or POSTGRES_18_BIN/u,
  );
  assert.throws(
    () =>
      resolvePostgresSelection({
        POSTGRES_17_BIN: "/postgres/17/bin",
        POSTGRES_18_BIN: "/postgres/18/bin",
      }),
    /exactly one of POSTGRES_17_BIN or POSTGRES_18_BIN/u,
  );
  for (const value of ["", " ", " /postgres/17/bin", "/postgres/17/bin "]) {
    assert.throws(
      () => resolvePostgresSelection({ POSTGRES_17_BIN: value }),
      /selected PostgreSQL binary directory is invalid/u,
    );
  }
  assert.deepEqual(
    resolvePostgresSelection({ POSTGRES_17_BIN: "/postgres/17/bin" }),
    {
      binaryDirectory: "/postgres/17/bin",
      environmentKey: "POSTGRES_17_BIN",
      expectedMajor: 17,
    },
  );
  assert.deepEqual(
    resolvePostgresSelection({ POSTGRES_18_BIN: "C:\\PostgreSQL\\18\\bin" }),
    {
      binaryDirectory: "C:\\PostgreSQL\\18\\bin",
      environmentKey: "POSTGRES_18_BIN",
      expectedMajor: 18,
    },
  );
});

test("selected server version must be the exact requested major", () => {
  assert.equal(
    validatePostgresVersionOutput("postgres (PostgreSQL) 17.6\n", 17),
    "postgres (PostgreSQL) 17.6",
  );
  assert.equal(
    validatePostgresVersionOutput("postgres (PostgreSQL) 18beta2\n", 18),
    "postgres (PostgreSQL) 18beta2",
  );
  assert.equal(
    validatePostgresVersionOutput(
      "postgres (PostgreSQL) 17.6 (Ubuntu 17.6-1.pgdg24.04+1)\n",
      17,
    ),
    "postgres (PostgreSQL) 17.6 (Ubuntu 17.6-1.pgdg24.04+1)",
  );
  assert.equal(
    validatePostgresVersionOutput(
      "postgres (PostgreSQL) 18.1 (Windows x86-64)\r\n",
      18,
    ),
    "postgres (PostgreSQL) 18.1 (Windows x86-64)",
  );
  assert.throws(
    () => validatePostgresVersionOutput("postgres (PostgreSQL) 18.1\n", 17),
    /selected PostgreSQL binary major mismatch/u,
  );
  assert.throws(
    () => validatePostgresVersionOutput("not postgres\n", 18),
    /selected PostgreSQL binary major mismatch/u,
  );
});

test("disposable port validation rejects 5432 and invalid endpoints", () => {
  assert.equal(validateDisposablePort(31_337), 31_337);
  for (const port of [5432, 0, -1, 65_536, 1.5, Number.NaN]) {
    assert.throws(
      () => validateDisposablePort(port),
      /disposable PostgreSQL port is unsafe/u,
    );
  }
});

test("ambient libpq and database secrets are rejected instead of inherited", () => {
  const selected = { POSTGRES_17_BIN: "/postgres/17/bin" };
  assert.doesNotThrow(() =>
    assertNoAmbientDatabaseEnvironment({
      ...selected,
      CI: "true",
      SYSTEMROOT: "C:\\Windows",
    }),
  );
  for (const [name, value] of [
    ["PGPASSWORD", "ambient-password-canary"],
    ["PGSERVICE", "ambient-service-canary"],
    ["DATABASE_URL", "postgresql://ambient.invalid/database"],
    ["DATABASE_URL_FILE", "/ambient/database-url"],
    ["DATABASE_BOOTSTRAP_URL", "postgresql://ambient.invalid/bootstrap"],
    ["POSTGRES_PASSWORD", "ambient-password-canary"],
    ["NODE_OPTIONS", "--import=/ambient/code.mjs"],
    ["NODE_PATH", "/ambient/modules"],
  ]) {
    assert.throws(
      () =>
        assertNoAmbientDatabaseEnvironment({
          ...selected,
          [name]: value,
        }),
      new RegExp(`unsafe ambient environment variable: ${name}`, "u"),
    );
  }
});

test("child environments are allowlisted and never spread the ambient process", () => {
  const clean = buildCleanChildEnvironment({
    environment: {
      PATH: "ambient-path-canary",
      DATABASE_URL: "ambient-database-canary",
      PGPASSWORD: "ambient-password-canary",
      SystemRoot: "C:\\Windows",
      WINDIR: "C:\\Windows",
      ComSpec: "C:\\ambient\\attacker.exe",
    },
    pgPassFile: "C:\\private\\pgpass",
    temporaryRoot: "C:\\private\\restore",
  });
  assert.deepEqual(clean, {
    ...(process.platform === "win32"
      ? {
          ComSpec: "C:\\Windows\\System32\\cmd.exe",
          SystemRoot: "C:\\Windows",
          WINDIR: "C:\\Windows",
        }
      : {}),
    FORCE_COLOR: "0",
    LC_ALL: "C",
    NODE_ENV: "test",
    NODE_NO_WARNINGS: "1",
    PGPASSFILE: "C:\\private\\pgpass",
    PGCONNECT_TIMEOUT: "5",
    PGOPTIONS:
      "-c statement_timeout=45000 -c lock_timeout=10000 -c idle_in_transaction_session_timeout=45000",
    TEMP: "C:\\private\\restore",
    TMP: "C:\\private\\restore",
    TMPDIR: "C:\\private\\restore",
  });
  assert.equal(clean.PATH, undefined);
  assert.equal(clean.DATABASE_URL, undefined);
  assert.equal(clean.PGPASSWORD, undefined);
  assert.notEqual(clean.ComSpec, "C:\\ambient\\attacker.exe");
});

test("private temporary roots must be fresh canonical 0700 children", () => {
  const temporaryRoot = mkdtempSync(
    path.join(os.tmpdir(), "codestead-restore-role-test-"),
  );
  try {
    chmodSync(temporaryRoot, 0o700);
    assert.equal(
      assertPrivateTemporaryRoot(temporaryRoot, {
        expectedPrefix: "codestead-restore-role-test-",
        temporaryParent: os.tmpdir(),
      }),
      realpathSync(temporaryRoot),
    );
    assert.throws(
      () =>
        assertPrivateTemporaryRoot(os.tmpdir(), {
          expectedPrefix: "codestead-restore-role-test-",
          temporaryParent: os.tmpdir(),
        }),
      /temporary root is unsafe/u,
    );
    assert.throws(
      () =>
        assertPrivateTemporaryRoot(repositoryRoot, {
          expectedPrefix: "codestead-restore-role-test-",
          temporaryParent: os.tmpdir(),
        }),
      /temporary root is unsafe/u,
    );
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("subrun deadlines are positive and never exceed sixty seconds", () => {
  assert.equal(MAX_SUBRUN_MS, 60_000);
  assert.equal(validateSubrunTimeout(1), 1);
  assert.equal(validateSubrunTimeout(MAX_SUBRUN_MS), MAX_SUBRUN_MS);
  for (const timeoutMs of [0, -1, 60_001, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => validateSubrunTimeout(timeoutMs),
      /subrun timeout is unsafe/u,
    );
  }
});

test("listener proof observes an open socket and accepts it only after close", async () => {
  const server = createServer();
  let port;
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    port = validateDisposablePort(address.port);
    await assert.rejects(
      assertNoLoopbackListener(port, { timeoutMs: 1_000 }),
      /unexpected listener remains/u,
    );
  } finally {
    if (server.listening) {
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  }
  await assertNoLoopbackListener(port, { timeoutMs: 1_000 });
});

test("listener absence requires consecutive ECONNREFUSED evidence", async () => {
  const observations = [
    { kind: "unknown" },
    { kind: "refused" },
    { kind: "connected" },
    { kind: "refused" },
    { kind: "refused" },
  ];
  let clock = 0;
  await assertNoLoopbackListener(31_341, {
    delay: async () => {},
    now: () => clock++,
    probe: async () => observations.shift(),
    stableChecks: 2,
    timeoutMs: 100,
  });
  assert.deepEqual(observations, []);

  await assert.rejects(
    assertNoLoopbackListener(31_342, {
      delay: async () => {},
      now: () => (clock += 25),
      probe: async () => ({ kind: "unknown" }),
      stableChecks: 2,
      timeoutMs: 100,
    }),
    /listener absence could not be proven/u,
  );
});

test("cleanup proves stop, listener, PID, then removes the exact root", async () => {
  const calls = [];
  const state = {
    dataDirectory: "/private/root/data",
    port: 31_337,
    postmasterPid: 991_337,
    startAttempted: true,
    startCompleted: true,
    temporaryRoot: "/private/root",
  };
  const failures = await cleanupDisposableCluster(state, {
    assertNoListener: async (port) => calls.push(["listener", port]),
    assertPostmasterStopped: async (dataDirectory, pid) =>
      calls.push(["pid", dataDirectory, pid]),
    delay: async () => calls.push(["delay"]),
    readPostmasterPidIfPresent: async () => state.postmasterPid,
    removeTemporaryRoot: async (temporaryRoot) =>
      calls.push(["remove", temporaryRoot]),
    stopCluster: async (dataDirectory) => calls.push(["stop", dataDirectory]),
  });
  assert.deepEqual(failures, []);
  assert.deepEqual(calls, [
    ["stop", state.dataDirectory],
    ["listener", state.port],
    ["pid", state.dataDirectory, state.postmasterPid],
    ["delay"],
    ["listener", state.port],
    ["pid", state.dataDirectory, state.postmasterPid],
    ["remove", state.temporaryRoot],
  ]);
});

test("cleanup never removes evidence when listener or PID proof fails", async () => {
  for (const failingPhase of ["listener", "pid"]) {
    const calls = [];
    const sentinel = new Error(`${failingPhase}-failure`);
    const failures = await cleanupDisposableCluster(
      {
        dataDirectory: "/private/root/data",
        port: 31_338,
        postmasterPid: 991_338,
        startAttempted: true,
        startCompleted: true,
        temporaryRoot: "/private/root",
      },
      {
        assertNoListener: async () => {
          calls.push("listener");
          if (failingPhase === "listener") throw sentinel;
        },
        assertPostmasterStopped: async () => {
          calls.push("pid");
          if (failingPhase === "pid") throw sentinel;
        },
        removeTemporaryRoot: async () => calls.push("remove"),
        stopCluster: async () => calls.push("stop"),
      },
    );
    assert.ok(failures.includes(sentinel));
    assert.equal(calls.includes("remove"), false);
  }
});

test("primary and cleanup failures are both retained without masking", () => {
  const primary = new Error("primary");
  const cleanupOne = new Error("cleanup-one");
  const cleanupTwo = new Error("cleanup-two");
  assert.deepEqual(
    preserveOperationAndCleanupFailures(NO_OPERATION_FAILURE, []),
    { failed: false, failure: undefined },
  );
  assert.deepEqual(preserveOperationAndCleanupFailures(primary, []), {
    failed: true,
    failure: primary,
  });
  assert.deepEqual(
    preserveOperationAndCleanupFailures(NO_OPERATION_FAILURE, [cleanupOne]),
    { failed: true, failure: cleanupOne },
  );
  const combined = preserveOperationAndCleanupFailures(primary, [
    cleanupOne,
    cleanupTwo,
  ]);
  assert.equal(combined.failed, true);
  assert.ok(combined.failure instanceof AggregateError);
  assert.deepEqual(combined.failure.errors, [primary, cleanupOne, cleanupTwo]);
  assert.equal(combined.failure.cause, primary);

  const undefinedPrimary = preserveOperationAndCleanupFailures(undefined, []);
  assert.equal(undefinedPrimary.failed, true);
  assert.equal(undefinedPrimary.failure, undefined);
  const undefinedCleanup = preserveOperationAndCleanupFailures(
    NO_OPERATION_FAILURE,
    [undefined],
  );
  assert.equal(undefinedCleanup.failed, true);
  assert.equal(undefinedCleanup.failure, undefined);
  const primitiveCombined = preserveOperationAndCleanupFailures("primary", [
    null,
  ]);
  assert.equal(primitiveCombined.failed, true);
  assert.deepEqual(primitiveCombined.failure.errors, ["primary", null]);
  assert.equal(primitiveCombined.failure.cause, "primary");
});

test("native startup is TCP-only, logged, and bounded to the private data root", () => {
  const state = {
    dataDirectory: path.join(os.tmpdir(), "private restore", "data"),
    logFile: path.join(os.tmpdir(), "private restore", "postgres.log"),
    port: 31_339,
  };
  const args = buildPostgresStartArguments(state);
  assert.deepEqual(args.slice(0, 4), [
    "start",
    "--pgdata",
    state.dataDirectory,
    "--log",
  ]);
  assert.equal(args[4], state.logFile);
  assert.ok(args.includes("--wait"));
  assert.ok(args.includes("15"));
  const options = args[args.indexOf("--options") + 1];
  assert.equal(
    options,
    `-h 127.0.0.1 -p ${state.port} -c unix_socket_directories=`,
  );
  assert.doesNotMatch(options, /private restore/u);
  assert.doesNotMatch(options, /(?:^|\s)-k(?:\s|$)/u);
  assert.match(
    harnessSource,
    /buildPostgresStartArguments\(state\),\s*\{\s*environment: nativeEnvironment,\s*outputMode: process\.platform === "win32" \? "ignore" : "capture"/u,
  );
});

test("parent PostgreSQL clients and compatibility migration mode are bounded", () => {
  assert.deepEqual(buildBoundedPgConfig("postgresql://example.invalid/db"), {
    connectionString: "postgresql://example.invalid/db",
    connectionTimeoutMillis: 5_000,
    idle_in_transaction_session_timeout: 45_000,
    lock_timeout: 10_000,
    query_timeout: 45_000,
    statement_timeout: 45_000,
  });
  assert.deepEqual(migrationMajorGuard(17), {
    requiredPostgresMajor: 17,
  });
  assert.deepEqual(migrationMajorGuard(18), {});
  assert.throws(
    () => migrationMajorGuard(16),
    /unsupported PostgreSQL compatibility major/u,
  );
});

test("started cleanup requires a captured postmaster PID before root removal", () => {
  const temporaryRoot = mkdtempSync(
    path.join(os.tmpdir(), "codestead-postmaster-proof-"),
  );
  try {
    const dataDirectory = path.join(temporaryRoot, "data");
    assert.throws(
      () => assertPostmasterStopped(dataDirectory, undefined, true),
      /postmaster PID was not captured/u,
    );
    assert.doesNotThrow(() =>
      assertPostmasterStopped(dataDirectory, undefined, false),
    );
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("private-root validation rejects a same-prefix symlink or junction", (t) => {
  const parent = mkdtempSync(
    path.join(os.tmpdir(), "codestead-private-root-parent-"),
  );
  const target = path.join(parent, "codestead-private-root-target");
  const link = path.join(parent, "codestead-private-root-link");
  try {
    mkdirSync(target, { mode: 0o700 });
    chmodSync(target, 0o700);
    assert.equal(
      assertPrivateTemporaryRoot(target, {
        expectedPrefix: "codestead-private-root-",
        temporaryParent: parent,
      }),
      realpathSync(target),
    );
    try {
      symlinkSync(
        target,
        link,
        process.platform === "win32" ? "junction" : "dir",
      );
    } catch (error) {
      if (error?.code === "EPERM" || error?.code === "EACCES") {
        t.skip("symlink creation is unavailable on this Windows runner");
        return;
      }
      throw error;
    }
    assert.throws(
      () =>
        assertPrivateTemporaryRoot(link, {
          expectedPrefix: "codestead-private-root-",
          temporaryParent: parent,
        }),
      /temporary root is unsafe/u,
    );
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("verifier contexts are unique and the generated TS runner imports cleanly", () => {
  const temporaryRoot = mkdtempSync(
    path.join(os.tmpdir(), "codestead loader space-"),
  );
  try {
    chmodSync(temporaryRoot, 0o700);
    const first = createVerifierContextFile({
      connectionString: "postgresql://one:secret@127.0.0.1:31337/db",
      database: "db",
      operation: "install",
      temporaryRoot,
    });
    const second = createVerifierContextFile({
      connectionString: "postgresql://one:secret@127.0.0.1:31337/db",
      database: "db",
      operation: "install",
      temporaryRoot,
    });
    assert.notEqual(first, second);
    assert.equal(existsSync(first), true);
    assert.equal(existsSync(second), true);

    const loaderPath = createTypeScriptLoader(temporaryRoot);
    const { runnerPath } = createVerifierRunner(temporaryRoot);
    const environment = buildCleanChildEnvironment({
      environment: process.env,
      temporaryRoot,
    });
    const result = spawnSync(
      process.execPath,
      [
        "--experimental-loader",
        pathToFileURL(loaderPath).href,
        runnerPath,
        "probe",
      ],
      {
        cwd: repositoryRoot,
        encoding: "utf8",
        env: environment,
        maxBuffer: 1024 * 1024,
        timeout: 20_000,
        windowsHide: true,
      },
    );
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "restore_verifier_loader=PASS\n");
    assert.equal(result.stderr, "");
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("bounded role pool factory is callable at module scope", async () => {
  const connectionString =
    "postgresql://learncoding_ops:secret@127.0.0.1:31337/db";
  const factory = createBoundedRolePoolFactory({ ops: connectionString });
  assert.throws(
    () => factory({ role: "unexpected_role" }),
    /unknown database role/u,
  );
  const pool = factory({ role: "learncoding_ops" });
  try {
    assert.equal(typeof pool.connect, "function");
  } finally {
    await pool.end();
  }
});

test("bounded runner can ignore inherited child output without waiting for a detached descendant", async () => {
  await assert.rejects(
    harness.runBounded(process.execPath, [], { outputMode: "discard" }),
    /bounded child output mode is invalid/u,
  );
  const temporaryRoot = mkdtempSync(
    path.join(os.tmpdir(), "codestead ignored output-"),
  );
  const pidFile = path.join(temporaryRoot, "descendant.pid");
  let descendantPid;
  try {
    chmodSync(temporaryRoot, 0o700);
    const leader = String.raw`
      const { spawn } = require("node:child_process");
      const { writeFileSync } = require("node:fs");
      const descendant = spawn(
        process.execPath,
        ["--eval", "setTimeout(()=>{},15000)"],
        { detached: true, shell: false, stdio: ["ignore", "inherit", "inherit"], windowsHide: true },
      );
      descendant.once("spawn", () => {
        writeFileSync(process.argv[1], String(descendant.pid), {
          encoding: "utf8",
          flag: "wx",
          mode: 0o600,
        });
        descendant.unref();
      });
    `;
    const result = await harness.runBounded(
      process.execPath,
      ["--eval", leader, pidFile],
      {
        environment: buildCleanChildEnvironment({
          environment: process.env,
          temporaryRoot,
        }),
        outputMode: "ignore",
        timeoutMs: 3_000,
      },
    );
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
    assert.equal(existsSync(pidFile), true);
    descendantPid = Number(readFileSync(pidFile, "utf8").trim());
    assert.equal(Number.isSafeInteger(descendantPid), true);
    assert.equal(processIsAlive(descendantPid), true);
  } finally {
    descendantPid = recoverRecordedPid(pidFile, descendantPid);
    if (
      Number.isSafeInteger(descendantPid) &&
      descendantPid > 0 &&
      processIsAlive(descendantPid)
    ) {
      process.kill(descendantPid, "SIGKILL");
    }
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});
test("bounded runner terminates an inherited-stdio process tree before its hard grace", async () => {
  assert.equal(
    typeof harness.runBounded,
    "function",
    "runBounded must be exported for process-tree regression coverage",
  );
  const temporaryRoot = mkdtempSync(
    path.join(os.tmpdir(), "codestead tree settlement-"),
  );
  const pidFile = path.join(temporaryRoot, "descendant.pid");
  const leaderPidFile = path.join(temporaryRoot, "leader.pid");
  let descendantPid;
  let leaderPid;
  let observed;
  try {
    chmodSync(temporaryRoot, 0o700);
    const leader = String.raw`
      const { spawn } = require("node:child_process");
      const { writeFileSync } = require("node:fs");
      writeFileSync(process.argv[2], String(process.pid) + "\n", {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      const descendant = spawn(
        process.execPath,
        ["--eval", "const hold=setInterval(()=>{},1000);setTimeout(()=>{clearInterval(hold)},15000)"],
        { detached: process.platform === "win32", shell: false, stdio: ["ignore", "inherit", "inherit"], windowsHide: true },
      );
      descendant.once("spawn", () => {
        writeFileSync(process.argv[1], String(descendant.pid) + "\n", {
          encoding: "utf8",
          flag: "wx",
          mode: 0o600,
        });
      });
      setInterval(() => {}, 1000);
    `;
    observed = harness.runBounded(
      process.execPath,
      ["--eval", leader, pidFile, leaderPidFile],
      {
        environment: buildCleanChildEnvironment({
          environment: process.env,
          temporaryRoot,
        }),
        timeoutMs: 250,
      },
    );
    const outcome = await Promise.race([
      observed.then(
        () => ({ kind: "resolved" }),
        (error) => ({ error, kind: "rejected" }),
      ),
      delay(1_500).then(() => ({ kind: "hung" })),
    ]);
    const pidDeadline = Date.now() + 500;
    while (
      (!existsSync(pidFile) || !existsSync(leaderPidFile)) &&
      Date.now() < pidDeadline
    )
      await delay(10);
    assert.equal(existsSync(pidFile), true);
    assert.equal(existsSync(leaderPidFile), true);
    descendantPid = Number(readFileSync(pidFile, "utf8").trim());
    leaderPid = Number(readFileSync(leaderPidFile, "utf8").trim());
    assert.equal(Number.isSafeInteger(descendantPid), true);
    assert.equal(Number.isSafeInteger(leaderPid), true);
    assert.equal(outcome.kind, "rejected");
    assert.ok(outcome.error instanceof Error);
    assert.equal(outcome.error.message, "bounded child timed out");
    assert.equal(processIsAlive(descendantPid), false);
    assert.equal(processIsAlive(leaderPid), false);
  } finally {
    descendantPid = recoverRecordedPid(pidFile, descendantPid);
    leaderPid = recoverRecordedPid(leaderPidFile, leaderPid);
    if (
      Number.isSafeInteger(descendantPid) &&
      descendantPid > 0 &&
      processIsAlive(descendantPid)
    ) {
      process.kill(descendantPid, "SIGKILL");
    }
    if (
      Number.isSafeInteger(leaderPid) &&
      leaderPid > 0 &&
      processIsAlive(leaderPid)
    ) {
      process.kill(leaderPid, "SIGKILL");
    }
    if (observed !== undefined) {
      await Promise.race([observed.catch(() => {}), delay(500)]);
    }
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("bounded runner terminates the process tree on output overflow", async () => {
  const temporaryRoot = mkdtempSync(
    path.join(os.tmpdir(), "codestead tree overflow-"),
  );
  const pidFile = path.join(temporaryRoot, "descendant.pid");
  const leaderPidFile = path.join(temporaryRoot, "leader.pid");
  let descendantPid;
  let leaderPid;
  let observed;
  try {
    chmodSync(temporaryRoot, 0o700);
    const leader = String.raw`
      const { spawn } = require("node:child_process");
      const { writeFileSync } = require("node:fs");
      writeFileSync(process.argv[2], String(process.pid) + "\n", {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      const descendant = spawn(
        process.execPath,
        ["--eval", "const hold=setInterval(()=>{},1000);setTimeout(()=>{clearInterval(hold)},15000)"],
        { detached: process.platform === "win32", shell: false, stdio: ["ignore", "inherit", "inherit"], windowsHide: true },
      );
      descendant.once("spawn", () => {
        writeFileSync(process.argv[1], String(descendant.pid) + "\n", {
          encoding: "utf8",
          flag: "wx",
          mode: 0o600,
        });
        process.stdout.write(Buffer.alloc(5 * 1024 * 1024, 88));
      });
      setInterval(() => {}, 1000);
    `;
    observed = harness.runBounded(
      process.execPath,
      ["--eval", leader, pidFile, leaderPidFile],
      {
        environment: buildCleanChildEnvironment({
          environment: process.env,
          temporaryRoot,
        }),
        timeoutMs: 10_000,
      },
    );
    const outcome = await Promise.race([
      observed.then(
        () => ({ kind: "resolved" }),
        (error) => ({ error, kind: "rejected" }),
      ),
      delay(1_500).then(() => ({ kind: "hung" })),
    ]);
    const pidDeadline = Date.now() + 500;
    while (
      (!existsSync(pidFile) || !existsSync(leaderPidFile)) &&
      Date.now() < pidDeadline
    )
      await delay(10);
    assert.equal(existsSync(pidFile), true);
    assert.equal(existsSync(leaderPidFile), true);
    descendantPid = Number(readFileSync(pidFile, "utf8").trim());
    leaderPid = Number(readFileSync(leaderPidFile, "utf8").trim());
    assert.equal(Number.isSafeInteger(descendantPid), true);
    assert.equal(Number.isSafeInteger(leaderPid), true);
    assert.equal(outcome.kind, "rejected");
    assert.ok(outcome.error instanceof Error);
    assert.equal(outcome.error.message, "bounded child output limit exceeded");
    assert.equal(processIsAlive(descendantPid), false);
    assert.equal(processIsAlive(leaderPid), false);
  } finally {
    descendantPid = recoverRecordedPid(pidFile, descendantPid);
    leaderPid = recoverRecordedPid(leaderPidFile, leaderPid);
    if (
      Number.isSafeInteger(descendantPid) &&
      descendantPid > 0 &&
      processIsAlive(descendantPid)
    ) {
      process.kill(descendantPid, "SIGKILL");
    }
    if (
      Number.isSafeInteger(leaderPid) &&
      leaderPid > 0 &&
      processIsAlive(leaderPid)
    ) {
      process.kill(leaderPid, "SIGKILL");
    }
    if (observed !== undefined) {
      await Promise.race([observed.catch(() => {}), delay(500)]);
    }
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("signal lifecycle aborts once and cleans up before returning signal semantics", async () => {
  assert.equal(
    typeof harness.runRestoreDrillLifecycle,
    "function",
    "signal lifecycle runner must be exported",
  );
  const signalSource = new EventEmitter();
  const events = [];
  let rejectOperation;
  const operation = new Promise((_, reject) => {
    rejectOperation = reject;
  });
  const running = harness.runRestoreDrillLifecycle({
    cleanup: async () => {
      events.push("stop", "listener", "pid", "root");
    },
    operation: async () => operation,
    releaseChildShutdown: () => events.push("release"),
    signalSource,
    terminateActiveChildren: async (signal) => {
      events.push(`terminate:${signal}`);
      rejectOperation(new Error("interrupted"));
    },
    writeSuccess: () => events.push("pass"),
  });
  signalSource.emit("SIGTERM");
  signalSource.emit("SIGINT");
  const result = await Promise.race([
    running,
    delay(500).then(() => ({ exitCode: -1, signal: "hung" })),
  ]);
  assert.deepEqual(result, { exitCode: 143, signal: "SIGTERM" });
  assert.deepEqual(events, [
    "terminate:SIGTERM",
    "stop",
    "listener",
    "pid",
    "root",
    "release",
  ]);
  assert.equal(signalSource.listenerCount("SIGINT"), 0);
  assert.equal(signalSource.listenerCount("SIGTERM"), 0);
});

test("direct main routes cleanup and success through the signal lifecycle", () => {
  assert.match(
    harnessSource,
    /async function main\(\)[\s\S]*await runRestoreDrillLifecycle\(\{/u,
  );
  assert.match(
    harnessSource,
    /nativeExecutable\("pg_ctl"\),[\s\S]{0,500}shutdownLane: CLEANUP_BOUNDED_CHILD_LANE/u,
  );
  assert.match(
    harnessSource,
    /releaseChildShutdown: releaseBoundedChildShutdown/u,
  );
  assert.match(
    harnessSource,
    /if \(exitCode !== 0\) process\.stderr\.write\(FAILURE_MARKER\)/u,
  );
});

test("signal lifecycle preserves SIGINT semantics and writes success only after cleanup", async () => {
  const signalSource = new EventEmitter();
  const interrupted = [];
  let rejectOperation;
  const running = harness.runRestoreDrillLifecycle({
    cleanup: async () => interrupted.push("cleanup"),
    operation: async () =>
      new Promise((_, reject) => {
        rejectOperation = reject;
      }),
    signalSource,
    terminateActiveChildren: async (signal) => {
      interrupted.push(`terminate:${signal}`);
      rejectOperation(new Error("interrupted"));
    },
    writeSuccess: () => interrupted.push("pass"),
  });
  await Promise.resolve();
  signalSource.emit("SIGINT");
  assert.deepEqual(await running, { exitCode: 130, signal: "SIGINT" });
  assert.deepEqual(interrupted, ["terminate:SIGINT", "cleanup"]);

  const successEvents = [];
  assert.deepEqual(
    await harness.runRestoreDrillLifecycle({
      cleanup: async () => successEvents.push("cleanup"),
      operation: async () => successEvents.push("operation"),
      signalSource: new EventEmitter(),
      terminateActiveChildren: async () => successEvents.push("terminate"),
      writeSuccess: () => successEvents.push("pass"),
    }),
    { exitCode: 0, signal: null },
  );
  assert.deepEqual(successEvents, ["operation", "cleanup", "pass"]);
});

test("signal latched during unregister awaits termination before completion", async () => {
  const handlers = new Map();
  let injectSignal = true;
  const signalSource = {
    off(signal, handler) {
      if (handlers.get(signal) === handler) handlers.delete(signal);
      if (!injectSignal) return;
      injectSignal = false;
      handlers.get("SIGTERM")?.();
    },
    on(signal, handler) {
      handlers.set(signal, handler);
    },
  };
  const events = [];
  let releaseTermination;
  let signalTerminationStarted;
  const terminationStarted = new Promise((resolve) => {
    signalTerminationStarted = resolve;
  });
  const terminationBlocked = new Promise((resolve) => {
    releaseTermination = resolve;
  });
  const running = harness.runRestoreDrillLifecycle({
    cleanup: async () => events.push("cleanup"),
    operation: async () => events.push("operation"),
    signalSource,
    terminateActiveChildren: async () => {
      events.push("terminate:start");
      signalTerminationStarted();
      await terminationBlocked;
      events.push("terminate:end");
    },
    writeSuccess: () => events.push("pass"),
  });
  try {
    await terminationStarted;
    assert.equal(
      await Promise.race([
        running.then(() => "settled"),
        delay(30).then(() => "pending"),
      ]),
      "pending",
    );
    assert.deepEqual(events, ["operation", "cleanup", "terminate:start"]);
  } finally {
    releaseTermination();
  }
  assert.deepEqual(await running, { exitCode: 143, signal: "SIGTERM" });
  assert.deepEqual(events, [
    "operation",
    "cleanup",
    "terminate:start",
    "terminate:end",
  ]);
});

test("signal arriving during cleanup remains authoritative", async () => {
  const signalSource = new EventEmitter();
  const events = [];
  let releaseCleanup;
  let signalCleanupStarted;
  const cleanupStarted = new Promise((resolve) => {
    signalCleanupStarted = resolve;
  });
  const cleanupBlocked = new Promise((resolve) => {
    releaseCleanup = resolve;
  });
  const running = harness.runRestoreDrillLifecycle({
    cleanup: async () => {
      events.push("cleanup:start");
      signalCleanupStarted();
      await cleanupBlocked;
      events.push("cleanup:end");
    },
    operation: async () => events.push("operation"),
    signalSource,
    terminateActiveChildren: async (signal) => {
      events.push(`terminate:${signal}`);
    },
    writeSuccess: () => events.push("pass"),
  });
  await cleanupStarted;
  signalSource.emit("SIGTERM");
  releaseCleanup();
  assert.deepEqual(await running, { exitCode: 143, signal: "SIGTERM" });
  assert.deepEqual(events, [
    "operation",
    "cleanup:start",
    "terminate:SIGTERM",
    "cleanup:end",
  ]);
  assert.equal(signalSource.listenerCount("SIGINT"), 0);
  assert.equal(signalSource.listenerCount("SIGTERM"), 0);
});

test("failed child termination keeps the shutdown latch closed", async () => {
  const signalSource = new EventEmitter();
  const events = [];
  let rejectOperation;
  const operation = new Promise((_, reject) => {
    rejectOperation = reject;
  });
  const terminationFailure = new Error("child drain proof failed");
  const running = harness.runRestoreDrillLifecycle({
    cleanup: async () => events.push("cleanup"),
    operation: async () => operation,
    releaseChildShutdown: () => events.push("release"),
    signalSource,
    terminateActiveChildren: async () => {
      events.push("terminate");
      rejectOperation(new Error("interrupted"));
      throw terminationFailure;
    },
    writeSuccess: () => events.push("pass"),
  });
  signalSource.emit("SIGTERM");
  assert.deepEqual(await running, { exitCode: 143, signal: "SIGTERM" });
  assert.deepEqual(events, ["terminate", "cleanup"]);
});

test("interrupted-operation grace stays referenced in a then-style process", () => {
  const temporaryRoot = mkdtempSync(
    path.join(os.tmpdir(), "codestead signal watchdog-"),
  );
  try {
    chmodSync(temporaryRoot, 0o700);
    const probe = String.raw`
      Promise.all([
        import(process.argv[1]),
        import("node:events"),
      ]).then(([harness, { EventEmitter }]) => {
        const signalSource = new EventEmitter();
        harness.runRestoreDrillLifecycle({
          cleanup: async () => {
            process.stdout.write("cleanup\n");
          },
          operation: async () => new Promise(() => {}),
          signalSource,
          terminateActiveChildren: async (signal) => {
            process.stdout.write("terminate:" + signal + "\n");
          },
          writeSuccess: () => {
            process.stdout.write("PASS\n");
          },
        }).then(
          ({ exitCode, signal }) => {
            process.stdout.write("exit=" + exitCode + ":" + signal + "\n");
            process.exitCode = exitCode;
          },
          (error) => {
            process.stderr.write(String(error?.message) + "\n");
            process.exitCode = 8;
          },
        );
        setTimeout(() => signalSource.emit("SIGTERM"), 20);
      });
    `;
    const started = Date.now();
    const result = spawnSync(
      process.execPath,
      ["--eval", probe, pathToFileURL(harnessPath).href],
      {
        cwd: repositoryRoot,
        encoding: "utf8",
        env: buildCleanChildEnvironment({
          environment: process.env,
          temporaryRoot,
        }),
        maxBuffer: 1024 * 1024,
        timeout: 4_000,
        windowsHide: true,
      },
    );
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    assert.equal(result.status, 143);
    assert.equal(
      result.stdout,
      "terminate:SIGTERM\ncleanup\nexit=143:SIGTERM\n",
    );
    assert.equal(result.stdout.includes("PASS"), false);
    assert.equal(result.stderr, "");
    assert.equal(Date.now() - started >= 900, true);
  } finally {
    rmSync(temporaryRoot, { force: true, recursive: true });
  }
});

test("shutdown latch refuses a child registered after the first drain", () => {
  const temporaryRoot = mkdtempSync(
    path.join(os.tmpdir(), "codestead late child latch-"),
  );
  const pidFile = path.join(temporaryRoot, "late-child.pid");
  let lateChildPid;
  try {
    chmodSync(temporaryRoot, 0o700);
    const probe = String.raw`
      Promise.all([
        import(process.argv[1]),
        import("node:events"),
      ]).then(([harness, { EventEmitter }]) => {
        const signalSource = new EventEmitter();
        let releaseOperation;
        const firstDrainFinished = new Promise((resolve) => {
          releaseOperation = resolve;
        });
        const childProgram = "const {writeFileSync}=require('node:fs');writeFileSync(process.argv[1],String(process.pid),{encoding:'utf8',flag:'wx',mode:0o600});setInterval(()=>{},1000)";
        const lifecycle = harness.runRestoreDrillLifecycle({
          cleanup: async () => {
            process.stdout.write("cleanup\n");
          },
          operation: async () => {
            await firstDrainFinished;
            try {
              await harness.runBounded(
                process.execPath,
                ["--eval", childProgram, process.argv[2]],
                {
                  environment: harness.buildCleanChildEnvironment({
                    environment: process.env,
                    temporaryRoot: process.argv[3],
                  }),
                  timeoutMs: 3_000,
                },
              );
              process.stdout.write("operation=unexpected-success\n");
            } catch (error) {
              process.stdout.write("operation=" + error.message + "\n");
            }
          },
          signalSource,
          terminateActiveChildren: async (signal) => {
            await harness.terminateActiveBoundedChildren(signal);
            releaseOperation();
          },
          writeSuccess: () => {
            process.stdout.write("PASS\n");
          },
        });
        lifecycle.then(async ({ exitCode, signal }) => {
          await harness.terminateActiveBoundedChildren("test-cleanup");
          process.stdout.write("exit=" + exitCode + ":" + signal + "\n");
          process.exitCode = exitCode;
        }).catch((error) => {
          process.stderr.write(String(error?.message) + "\n");
          process.exitCode = 8;
        });
        setTimeout(() => signalSource.emit("SIGTERM"), 20);
      });
    `;
    const result = spawnSync(
      process.execPath,
      [
        "--eval",
        probe,
        pathToFileURL(harnessPath).href,
        pidFile,
        temporaryRoot,
      ],
      {
        cwd: repositoryRoot,
        encoding: "utf8",
        env: buildCleanChildEnvironment({
          environment: process.env,
          temporaryRoot,
        }),
        maxBuffer: 1024 * 1024,
        timeout: 4_000,
        windowsHide: true,
      },
    );
    lateChildPid = recoverRecordedPid(pidFile, lateChildPid);
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    assert.equal(result.status, 143);
    assert.equal(existsSync(pidFile), false);
    assert.match(
      result.stdout,
      /^operation=bounded child shutdown is active\ncleanup\nexit=143:SIGTERM\n$/u,
    );
    assert.equal((result.stdout.match(/^cleanup$/gmu) ?? []).length, 1);
    assert.equal(result.stdout.includes("PASS"), false);
    assert.equal(result.stderr, "");
  } finally {
    lateChildPid = recoverRecordedPid(pidFile, lateChildPid);
    if (
      Number.isSafeInteger(lateChildPid) &&
      lateChildPid > 0 &&
      processIsAlive(lateChildPid)
    ) {
      process.kill(lateChildPid, "SIGKILL");
    }
    rmSync(temporaryRoot, { force: true, recursive: true });
  }
});

test("postmaster PID reader accepts only canonical positive decimal text", () => {
  const temporaryRoot = mkdtempSync(
    path.join(os.tmpdir(), "codestead postmaster pid-"),
  );
  const dataDirectory = path.join(temporaryRoot, "data");
  const pidFile = path.join(dataDirectory, "postmaster.pid");
  try {
    chmodSync(temporaryRoot, 0o700);
    mkdirSync(dataDirectory, { mode: 0o700 });
    assert.equal(harness.readPostmasterPidIfPresent(dataDirectory), undefined);
    writeFileSync(pidFile, "4242\nignored metadata\n", {
      encoding: "utf8",
      mode: 0o600,
    });
    assert.equal(harness.readPostmasterPidIfPresent(dataDirectory), 4242);

    for (const malformed of [
      "0",
      "-1",
      "1e3",
      "0x10",
      "+42",
      "42.0",
      " 42",
      "42 ",
      "\uFEFF42",
      "9007199254740992",
      "",
    ]) {
      writeFileSync(pidFile, `${malformed}\n`, "utf8");
      assert.throws(
        () => harness.readPostmasterPidIfPresent(dataDirectory),
        /disposable PostgreSQL postmaster PID is invalid/u,
        `accepted malformed postmaster PID ${JSON.stringify(malformed)}`,
      );
    }
  } finally {
    rmSync(temporaryRoot, { force: true, recursive: true });
  }
});

test("postmaster PID reader tolerates an ENOENT existence race", () => {
  const temporaryRoot = mkdtempSync(
    path.join(os.tmpdir(), "codestead postmaster pid race-"),
  );
  const dataDirectory = path.join(temporaryRoot, "data");
  try {
    chmodSync(temporaryRoot, 0o700);
    mkdirSync(dataDirectory, { mode: 0o700 });
    writeFileSync(path.join(dataDirectory, "postmaster.pid"), "4242\n", {
      encoding: "utf8",
      mode: 0o600,
    });
    const missing = new Error("postmaster.pid disappeared");
    missing.code = "ENOENT";
    assert.equal(
      harness.readPostmasterPidIfPresent(dataDirectory, {
        fileExists: () => true,
        readFile: () => {
          throw missing;
        },
      }),
      undefined,
    );
  } finally {
    rmSync(temporaryRoot, { force: true, recursive: true });
  }
});

test("failed startup recovers a delayed PID and proves stable absence before removal", async () => {
  const state = {
    dataDirectory: "C:\\private\\data",
    port: 31_337,
    postmasterPid: undefined,
    startAttempted: true,
    temporaryRoot: "C:\\private",
  };
  const events = [];
  const recoveredPids = [undefined, 4242, 4242, undefined, undefined];
  let stopAttempts = 0;
  const failures = await cleanupDisposableCluster(
    state,
    {
      assertNoListener: async () => events.push("listener"),
      assertPostmasterStopped: async (_data, pid) => {
        events.push(`pid:${pid}`);
        assert.equal(pid, 4242);
        if (stopAttempts === 1) {
          throw new Error("late postmaster remains live");
        }
      },
      delay: async () => events.push("delay"),
      readPostmasterPidIfPresent: async () => {
        events.push("recover");
        return recoveredPids.shift();
      },
      removeTemporaryRoot: async () => events.push("root"),
      stopCluster: async () => {
        stopAttempts += 1;
        events.push(`stop:${stopAttempts}`);
        if (stopAttempts === 1) throw new Error("late start");
      },
    },
    { attempts: 3, stableChecks: 2 },
  );
  assert.deepEqual(failures, []);
  assert.equal(state.postmasterPid, 4242);
  assert.equal(stopAttempts >= 2, true);
  assert.equal(events.at(-1), "root");
  assert.equal(events.filter((event) => event === "root").length, 1);
  assert.equal(events.filter((event) => event === "pid:4242").length, 3);
});

test("cleanup preserves evidence when stable postmaster absence is not proven", async () => {
  let pidProofs = 0;
  let removals = 0;
  const failures = await cleanupDisposableCluster(
    {
      dataDirectory: "C:\\private\\data",
      port: 31_343,
      postmasterPid: 4242,
      startAttempted: true,
      temporaryRoot: "C:\\private",
    },
    {
      assertNoListener: async () => {},
      assertPostmasterStopped: async () => {
        pidProofs += 1;
        if (pidProofs % 2 === 0) throw new Error("unstable postmaster absence");
      },
      delay: async () => {},
      readPostmasterPidIfPresent: async () => 4242,
      removeTemporaryRoot: async () => {
        removals += 1;
      },
      stopCluster: async () => {},
    },
    { attempts: 3, stableChecks: 2 },
  );
  assert.equal(removals, 0);
  assert.equal(pidProofs >= 2, true);
  assert.equal(failures.length > 0, true);
});

test("cleanup preserves evidence when the recovered postmaster PID changes", async () => {
  let removals = 0;
  const recoveredPids = [5151, undefined, undefined, undefined];
  const failures = await cleanupDisposableCluster(
    {
      dataDirectory: "C:\\private\\data",
      port: 31_344,
      postmasterPid: 4242,
      startAttempted: true,
      temporaryRoot: "C:\\private",
    },
    {
      assertNoListener: async () => {},
      assertPostmasterStopped: async () => {},
      delay: async () => {},
      readPostmasterPidIfPresent: async () => recoveredPids.shift(),
      removeTemporaryRoot: async () => {
        removals += 1;
      },
      stopCluster: async () => {},
    },
    { attempts: 1, stableChecks: 2 },
  );
  assert.equal(removals, 0);
  assert.equal(failures.length, 1);
  assert.match(
    String(failures[0]?.message),
    /disposable PostgreSQL postmaster PID changed/u,
  );
});

test("cleanup preserves evidence when the postmaster PID cannot be read", async () => {
  let removals = 0;
  let reads = 0;
  const readFailure = new Error("postmaster PID file is unreadable");
  const failures = await cleanupDisposableCluster(
    {
      dataDirectory: "C:\\private\\data",
      port: 31_345,
      postmasterPid: 4242,
      startAttempted: true,
      temporaryRoot: "C:\\private",
    },
    {
      assertNoListener: async () => {},
      assertPostmasterStopped: async () => {},
      delay: async () => {},
      readPostmasterPidIfPresent: async () => {
        reads += 1;
        if (reads === 1) throw readFailure;
        return undefined;
      },
      removeTemporaryRoot: async () => {
        removals += 1;
      },
      stopCluster: async () => {},
    },
    { attempts: 1, stableChecks: 2 },
  );
  assert.equal(removals, 0);
  assert.deepEqual(failures, [readFailure]);
});

test("cleanup accepts stable absence after pg_ctl reports already stopped", async () => {
  const events = [];
  const stopFailure = new Error("pg_ctl: PID file does not exist");
  const failures = await cleanupDisposableCluster(
    {
      dataDirectory: "C:\\private\\data",
      port: 31_346,
      postmasterPid: 4242,
      startAttempted: true,
      temporaryRoot: "C:\\private",
    },
    {
      assertNoListener: async () => events.push("listener"),
      assertPostmasterStopped: async () => events.push("pid"),
      delay: async () => events.push("delay"),
      readPostmasterPidIfPresent: async () => undefined,
      removeTemporaryRoot: async () => events.push("root"),
      stopCluster: async () => {
        events.push("stop:error");
        throw stopFailure;
      },
    },
    { attempts: 1, stableChecks: 2 },
  );
  assert.deepEqual(failures, []);
  assert.deepEqual(events, [
    "stop:error",
    "listener",
    "pid",
    "delay",
    "listener",
    "pid",
    "root",
  ]);
});

test("bounded client lifecycle retains primary and close failures", async () => {
  assert.equal(
    typeof harness.runWithBoundedClient,
    "function",
    "bounded PostgreSQL client lifecycle helper must be exported",
  );
  const primary = new Error("authorization proof failed");
  const cleanup = new Error("client close failed");
  const client = {
    connect: async () => {},
    end: async () => {
      throw cleanup;
    },
  };
  await assert.rejects(
    harness.runWithBoundedClient(
      client,
      async () => {
        throw primary;
      },
      { connectMs: 50, endMs: 50, queryMs: 50 },
    ),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors, [primary, cleanup]);
      assert.equal(error.cause, primary);
      return true;
    },
  );
});

test("bounded client lifecycle contains connect, query, and close hangs", async () => {
  const successEvents = [];
  const successClient = {
    connect: async () => successEvents.push("connect"),
    end: async () => successEvents.push("end"),
  };
  assert.equal(
    await harness.runWithBoundedClient(
      successClient,
      async () => {
        successEvents.push("query");
        return "result";
      },
      { connectMs: 50, endMs: 50, queryMs: 50 },
    ),
    "result",
  );
  assert.deepEqual(successEvents, ["connect", "query", "end"]);

  for (const phase of ["connect", "query", "end"]) {
    let endCalls = 0;
    let destroyed = 0;
    const client = {
      connect: async () =>
        phase === "connect" ? new Promise(() => {}) : undefined,
      connection: {
        stream: {
          destroy: () => {
            destroyed += 1;
          },
        },
      },
      end: async () => {
        endCalls += 1;
        if (phase === "end") return new Promise(() => {});
      },
    };
    const operation = async () =>
      phase === "query" ? new Promise(() => {}) : undefined;
    await assert.rejects(
      Promise.race([
        harness.runWithBoundedClient(client, operation, {
          connectMs: 20,
          endMs: 20,
          queryMs: 20,
        }),
        delay(250).then(() => {
          throw new Error(`${phase} hard sentinel elapsed`);
        }),
      ]),
      new RegExp(`bounded PostgreSQL client ${phase} timed out`, "u"),
    );
    assert.equal(endCalls, 1);
    assert.equal(destroyed >= 1, true);
  }

  await assert.rejects(
    harness.runWithBoundedClient(
      {
        connect: async () => {
          throw new Error("unsafe budget reached client");
        },
        end: async () => {},
      },
      async () => {},
      { connectMs: 20_000, endMs: 20_001, queryMs: 20_000 },
    ),
    /bounded PostgreSQL client timeout budget is unsafe/u,
  );
});

test("bounded client watchdog stays referenced in a then-style process", () => {
  const temporaryRoot = mkdtempSync(
    path.join(os.tmpdir(), "codestead client watchdog-"),
  );
  try {
    chmodSync(temporaryRoot, 0o700);
    const probe = String.raw`
      const started = Date.now();
      import(process.argv[1]).then(({ runWithBoundedClient }) => {
        runWithBoundedClient(
          {
            connect: async () => {},
            connection: { stream: { destroy: () => {} } },
            end: async () => new Promise(() => {}),
          },
          async () => {},
          { connectMs: 50, endMs: 200, queryMs: 50 },
        ).then(
          () => {
            process.stdout.write("unexpected success\n");
          },
          (error) => {
            const primary = error instanceof AggregateError
              ? error.errors[0]
              : error;
            process.stdout.write(primary.message + "\n");
            process.stdout.write("elapsed=" + (Date.now() - started) + "\n");
            process.exitCode = 9;
          },
        );
      });
    `;
    const started = Date.now();
    const result = spawnSync(
      process.execPath,
      ["--eval", probe, pathToFileURL(harnessPath).href],
      {
        cwd: repositoryRoot,
        encoding: "utf8",
        env: buildCleanChildEnvironment({
          environment: process.env,
          temporaryRoot,
        }),
        maxBuffer: 1024 * 1024,
        timeout: 2_000,
        windowsHide: true,
      },
    );
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    assert.equal(result.status, 9);
    assert.match(
      result.stdout,
      /^bounded PostgreSQL client end timed out\nelapsed=[0-9]+\n$/u,
    );
    assert.equal(Date.now() - started >= 180, true);
    assert.equal(result.stderr, "");
  } finally {
    rmSync(temporaryRoot, { force: true, recursive: true });
  }
});

test("restore bootstrap identity matches production everywhere", () => {
  assert.equal(
    harness.RESTORE_BOOTSTRAP_IDENTITY,
    "codestead_restore",
    "restore bootstrap identity must match production",
  );
  assert.doesNotMatch(
    harnessSource,
    /(?:--username=postgres|username:\s*"postgres"|postgresUser:\s*"postgres"|expectedBootstrapUser:\s*"postgres"|:\*:postgres:)/u,
  );
  assert.equal(
    (harnessSource.match(/["']codestead_restore["']/gu) ?? []).length,
    1,
    "the restore identity must have one source literal",
  );
  const createdbArgumentBlocks = [
    ...harnessSource.matchAll(
      /nativeExecutable\("createdb"\),\s*\[([\s\S]*?)\],\s*\{/gu,
    ),
  ];
  assert.equal(
    createdbArgumentBlocks.length,
    2,
    "the harness must contain exactly two createdb calls",
  );
  for (const [, argumentBlock] of createdbArgumentBlocks) {
    assert.match(
      argumentBlock,
      /"--maintenance-db=postgres"/u,
      "each createdb call must name the maintenance database explicitly",
    );
  }
  const dropdbArgumentBlocks = [
    ...harnessSource.matchAll(
      /nativeExecutable\("dropdb"\),\s*\[([\s\S]*?)\],\s*\{/gu,
    ),
  ];
  assert.equal(dropdbArgumentBlocks.length, 1);
  assert.match(dropdbArgumentBlocks[0][1], /"--maintenance-db=postgres"/u);

  const temporaryRoot = mkdtempSync(
    path.join(os.tmpdir(), "codestead restore runner identity-"),
  );
  try {
    chmodSync(temporaryRoot, 0o700);
    const { runnerPath } = createVerifierRunner(temporaryRoot);
    const runnerSource = readFileSync(runnerPath, "utf8");
    assert.equal(
      (runnerSource.match(/["']codestead_restore["']/gu) ?? []).length,
      1,
    );
    assert.equal(
      (
        runnerSource.match(
          /expectedBootstrapUser:\s*restoreBootstrapIdentity/gu,
        ) ?? []
      ).length,
      2,
    );
    assert.doesNotMatch(
      runnerSource,
      /expectedBootstrapUser:\s*["']postgres["']/u,
    );
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("post-restore authority follows the shipped raw-ledger-before-repair sequence", () => {
  const proofStart = harnessSource.indexOf("async function runRestoreProof(");
  const proofEnd = harnessSource.indexOf("\nasync function main()", proofStart);
  assert.ok(proofStart >= 0 && proofEnd > proofStart);
  const proof = harnessSource.slice(proofStart, proofEnd);
  const postRestore = proof.slice(
    proof.indexOf('nativeExecutable("pg_restore")'),
  );
  const positions = {
    remove: postRestore.indexOf('operation: "remove"'),
    completeBootstrap: postRestore.indexOf(
      "requireCompleteMigrationLedger: true",
    ),
    restoreMode: postRestore.indexOf('bootstrapMode: "restored-no-acl"'),
    boundary: postRestore.indexOf("requireApplicationObjects: true"),
    install: postRestore.indexOf('operation: "install"'),
    verify: postRestore.indexOf('operation: "verify"'),
    ledgerProof: postRestore.indexOf(
      "restored migration ledger proof is invalid",
    ),
  };
  assert.equal(
    [...postRestore.matchAll(/operation: "install"/gu)].length,
    1,
    "authority must be installed exactly once after ACL reconciliation",
  );
  assert.equal(
    [...postRestore.matchAll(/operation: "verify"/gu)].length,
    1,
    "authority must be verified exactly once after ACL reconciliation",
  );
  assert.ok(
    Object.values(positions).every((position) => position >= 0),
    `missing reviewed restore sequence anchor: ${JSON.stringify(positions)}`,
  );
  assert.ok(
    positions.remove < positions.restoreMode &&
      positions.restoreMode < positions.completeBootstrap &&
      positions.completeBootstrap < positions.boundary &&
      positions.boundary < positions.install &&
      positions.install < positions.verify &&
      positions.verify < positions.ledgerProof,
    `restore sequence is unsafe: ${JSON.stringify(positions)}`,
  );
});

test("restored no-ACL bootstrap injects the disposable maintenance endpoint", () => {
  const proofStart = harnessSource.indexOf("async function runRestoreProof(");
  const restoredBootstrapStart = harnessSource.indexOf(
    "const restoredBootstrapPool = new Pool(",
    proofStart,
  );
  const restoredBootstrapEnd = harnessSource.indexOf(
    "await verifyDatabaseRoleBoundaries(",
    restoredBootstrapStart,
  );
  const restoredBootstrap = harnessSource.slice(
    restoredBootstrapStart,
    restoredBootstrapEnd,
  );

  assert.ok(proofStart >= 0);
  assert.ok(restoredBootstrapStart > proofStart);
  assert.ok(restoredBootstrapEnd > restoredBootstrapStart);
  assert.match(
    restoredBootstrap,
    /const restoredMaintenancePool = new Pool\(\{\s*\.\.\.buildBoundedPgConfig\(maintenanceUrl\),\s*max: 1,\s*\}\);/u,
  );
  assert.match(
    restoredBootstrap,
    /restoreMaintenancePool:\s*restoredMaintenancePool/u,
  );
});
test("static contract freezes real source, verifier, backup, and teardown wiring", () => {
  for (const token of [
    "runProductionMigration",
    "runDatabaseRoleBootstrap",
    "verifyDatabaseRoleBoundaries",
    "verifyDatabaseSchema",
    "installRestoreLedgerAuthority",
    "REVIEWED_MIGRATION_LEDGER",
    "REVIEWED_MIGRATION_LEDGER_SHA256",
    'path.join(repositoryRoot, "drizzle")',
    'nativeExecutable("pg_dump")',
    'nativeExecutable("pg_restore")',
    '"--format=custom"',
    '"--no-owner"',
    '"--no-acl"',
    '"--role=learncoding_owner"',
    '"--exit-on-error"',
    '"--data-checksums"',
    '"--encoding=UTF8"',
    '"--no-locale"',
    "data_checksums",
    "server_encoding",
    "restoredPreBootstrapPool",
    "requireApplicationObjects: false",
    "127.0.0.1",
    "validateDisposablePort",
    "assertNoLoopbackListener",
    "assertPostmasterStopped",
    "preserveOperationAndCleanupFailures",
    "scripts/verify-restored-backup.ts",
    "--experimental-loader",
  ]) {
    assert.ok(
      harnessSource.includes(token),
      `missing harness contract ${token}`,
    );
  }
  assert.doesNotMatch(harnessSource, /\b(?:docker|podman)\b/iu);
  assert.doesNotMatch(harnessSource, /\.\.\.process[.]env/u);
  assert.doesNotMatch(harnessSource, /\bshell\s*:\s*true/u);
  assert.doesNotMatch(harnessSource, /\bexec(?:File)?Sync\s*[(]/u);
  assert.ok(
    harnessSource.indexOf("cleanupDisposableCluster") <
      harnessSource.lastIndexOf("SUCCESS_MARKER"),
    "success marker must follow verified teardown",
  );
  const dumpIndex = harnessSource.indexOf('nativeExecutable("pg_dump")');
  const sourceDropIndex = harnessSource.indexOf('nativeExecutable("dropdb")');
  const targetCreateIndex = harnessSource.lastIndexOf(
    'nativeExecutable("createdb")',
  );
  assert.ok(
    dumpIndex >= 0 &&
      sourceDropIndex > dumpIndex &&
      targetCreateIndex > sourceDropIndex,
    "source database must be dropped after dump and before target bootstrap",
  );
});

test("CLI fails closed before filesystem or PostgreSQL work without a selector", () => {
  const environment = {
    FORCE_COLOR: "0",
    SystemRoot: process.env.SystemRoot,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    WINDIR: process.env.WINDIR,
  };
  const result = spawnSync(process.execPath, [harnessPath], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: Object.fromEntries(
      Object.entries(environment).filter(([, value]) => value !== undefined),
    ),
    maxBuffer: 1024 * 1024,
    timeout: 10_000,
    windowsHide: true,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  let selectorFailure;
  try {
    resolvePostgresSelection({});
  } catch (error) {
    selectorFailure = error;
  }
  assert.equal(
    result.stderr,
    FAILURE_MARKER +
      harness.formatRestoreDrillFailureDiagnostic(selectorFailure),
  );
  assert.equal(SUCCESS_MARKER, "restore_drill_role_boundary=PASS\n");
});

test("failure diagnostics redact URLs and named secret values", () => {
  const diagnostic = harness.formatRestoreDrillFailureDiagnostic(
    new Error(
      "probe postgresql://worker:super-secret@127.0.0.1:55432/db password=hunter2",
    ),
  );
  assert.match(diagnostic, /^restore_drill_role_boundary_error=Error:/u);
  assert.doesNotMatch(diagnostic, /super-secret|hunter2|worker/u);
  assert.match(diagnostic, /<redacted-database-url>/u);
  assert.match(diagnostic, /<redacted-sensitive-value>/u);
});
