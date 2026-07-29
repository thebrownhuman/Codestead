import {
  spawn as nodeSpawn,
  type ChildProcess,
} from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  createDisposableIntegrationChildController,
  type DisposableIntegrationChildController,
  type DisposableIntegrationTrackedChild,
} from "./lib/disposable-integration-child-controller";
import {
  buildDisposableIntegrationChildLaunch,
} from "./lib/disposable-integration-child-launch";
import { minimalNodeTestEnvironment } from "./lib/disposable-integration-environment";

type SpawnRunner = (
  command: string,
  args: readonly string[],
  options: Readonly<{
    detached: boolean;
    env: NodeJS.ProcessEnv;
    stdio: "inherit";
    windowsHide: true;
  }>,
) => Pick<
  ChildProcess,
  "exitCode" | "kill" | "once" | "pid" | "signalCode"
>;

type ChildControllerFactory = (
  input: Readonly<{
    forceTimeoutMs: number;
    gracefulTimeoutMs: number;
  }>,
) => DisposableIntegrationChildController;

type LauncherDependencies = Readonly<{
  buildChildLaunch?: typeof buildDisposableIntegrationChildLaunch;
  createChildController?: ChildControllerFactory;
  environment?: NodeJS.ProcessEnv;
  spawn?: SpawnRunner;
  deadlineMs?: number;
  heartbeatMs?: number;
  terminationGraceMs?: number;
  log?: (message: string) => void;
  logError?: (message: string) => void;
}>;

export type DatabaseRoleBoundaryTestLane = Readonly<{
  deadlineMs?: number;
  id: string;
  file: string;
  namePattern?: string;
}>;

const scriptsDirectory = path.dirname(fileURLToPath(import.meta.url));
const manifestTest = path.resolve(
  scriptsDirectory,
  "database-runtime-capabilities.test.mjs",
);
const bootstrapTest = path.resolve(
  scriptsDirectory,
  "bootstrap-database-runtime-capabilities.test.mjs",
);
const verifierTest = path.resolve(
  scriptsDirectory,
  "verify-database-runtime-capabilities.test.mjs",
);
const boundaryTest = path.resolve(
  scriptsDirectory,
  "database-role-boundaries.test.mjs",
);

const lane = (
  id: string,
  file: string,
  namePattern?: string,
  deadlineMs?: number,
): DatabaseRoleBoundaryTestLane =>
  Object.freeze({
    id,
    file,
    ...(namePattern === undefined ? {} : { namePattern }),
    ...(deadlineMs === undefined ? {} : { deadlineMs }),
  });

export const DATABASE_ROLE_BOUNDARY_TEST_LANES = Object.freeze([
  lane(
    "manifest-inventory",
    manifestTest,
    "^(?:publishes |pins |rejects unreviewed |exports deeply |the declaration |models normalized |schema validation |canonicalization )",
  ),
  lane(
    "manifest-diff",
    manifestTest,
    "^(?:diff reports |inventory planning |diff detects |comparable catalogs )",
  ),
  lane(
    "manifest-metadata",
    manifestTest,
    "^comparable catalog metadata ",
  ),
  lane(
    "manifest-reconciliation",
    manifestTest,
    "^(?:predecessor allowance |contracted policy |planner rejects |table privilege revocation |missing physical |known extra physical )",
  ),
  lane(
    "manifest-phase",
    manifestTest,
    "^(?:phase resolution |structured reconciliation )",
  ),
  lane(
    "bootstrap-missing-grants",
    bootstrapTest,
    "^missing direct grants render exact per-object SQL and converge$",
    90_000,
  ),
  lane(
    "bootstrap-core",
    bootstrapTest,
    "^(?:phase authority |phase seals |catalog observation |normalizes |reconciliation is |SQL recorder |table revoke |unknown inventory|a missing physical |schema-local default ACL cleanup |ownership repair enumerates )",
  ),
  lane(
    "bootstrap-catalog",
    bootstrapTest,
    "^(?:ownership repair is |ownership repair narrowly |foundation verification accepts |foundation establishment |foundation verification rejects |current verification |current read-only verification |current reconciliation )",
  ),
  lane("standalone-verifier", verifierTest),
  lane("role-boundary", boundaryTest),
]);

const defaultSpawn: SpawnRunner = (command, args, options) =>
  nodeSpawn(command, [...args], options);

function laneArguments(testLane: DatabaseRoleBoundaryTestLane): string[] {
  return [
    "--experimental-test-isolation=none",
    "--test",
    ...(testLane.namePattern === undefined
      ? []
      : [`--test-name-pattern=${testLane.namePattern}`]),
    testLane.file,
  ];
}

function runLane(
  testLane: DatabaseRoleBoundaryTestLane,
  {
    buildChildLaunch,
    spawn,
    environment,
    deadlineMs,
    heartbeatMs,
    terminationGraceMs,
    log,
    logError,
    createChildController,
  }: Required<LauncherDependencies>,
): Promise<number> {
  log(`database-role-boundary lane START ${testLane.id}`);
  return new Promise((resolve) => {
    let settled = false;
    let deadline: NodeJS.Timeout | undefined = undefined;
    let heartbeat: NodeJS.Timeout | undefined = undefined;
    let terminationRequested = false;
    let childFailed = false;
    let finalization: Promise<void> | undefined;
    const settle = (status: number, marker: "PASS" | "FAIL" | "TIMEOUT") => {
      if (settled) return;
      settled = true;
      if (deadline !== undefined) clearTimeout(deadline);
      if (heartbeat !== undefined) clearInterval(heartbeat);
      const message = `database-role-boundary lane ${marker} ${testLane.id}`;
      if (marker === "PASS") log(message);
      else logError(message);
      resolve(status);
    };

    let tracked: DisposableIntegrationTrackedChild<
      ReturnType<SpawnRunner>
    >;
    try {
      const controller = createChildController({
        forceTimeoutMs: terminationGraceMs,
        gracefulTimeoutMs: terminationGraceMs,
      });
      const launch = buildChildLaunch({
        command: process.execPath,
        args: laneArguments(testLane),
        environment,
      });
      tracked = controller.spawnAndTrack(() =>
        spawn(launch.command, launch.args, {
          detached: launch.detached,
          env: launch.environment,
          stdio: "inherit",
          windowsHide: true,
        })
      );
    } catch {
      settle(1, "FAIL");
      return;
    }
    const { child } = tracked;
    const finalize = (
      status: number,
      marker: "PASS" | "FAIL" | "TIMEOUT",
    ): Promise<void> => {
      if (finalization !== undefined) return finalization;
      if (deadline !== undefined) clearTimeout(deadline);
      if (heartbeat !== undefined) clearInterval(heartbeat);
      finalization = Promise.resolve()
        .then(() => tracked.completeAndWait("SIGTERM"))
        .then(
        () => {
          settle(status, marker);
        },
        () => {
          settle(1, "FAIL");
        },
        );
      return finalization;
    };

    heartbeat = setInterval(() => {
      log(`database-role-boundary lane HEARTBEAT ${testLane.id}`);
    }, heartbeatMs);
    heartbeat.unref();
    deadline = setTimeout(() => {
      terminationRequested = true;
      void finalize(1, childFailed ? "FAIL" : "TIMEOUT");
    }, testLane.deadlineMs ?? deadlineMs);
    deadline.unref();

    child.once("error", () => {
      childFailed = true;
    });
    child.once("close", (status) => {
      if (terminationRequested) {
        void finalize(1, childFailed ? "FAIL" : "TIMEOUT");
        return;
      }
      const exitStatus = typeof status === "number" ? status : 1;
      void finalize(
        childFailed ? 1 : exitStatus,
        !childFailed && exitStatus === 0 ? "PASS" : "FAIL",
      );
    });
  });
}

export async function runDatabaseRoleBoundaryTests(
  dependencies: LauncherDependencies = {},
): Promise<number> {
  const sanitizedEnvironment = minimalNodeTestEnvironment(
    dependencies.environment ?? process.env,
  );
  const options: Required<LauncherDependencies> = {
    buildChildLaunch:
      dependencies.buildChildLaunch ?? buildDisposableIntegrationChildLaunch,
    createChildController: dependencies.createChildController
      ?? createDisposableIntegrationChildController,
    environment: sanitizedEnvironment,
    spawn: dependencies.spawn ?? defaultSpawn,
    deadlineMs: dependencies.deadlineMs ?? 60_000,
    heartbeatMs: dependencies.heartbeatMs ?? 15_000,
    terminationGraceMs: dependencies.terminationGraceMs ?? 5_000,
    log: dependencies.log ?? console.log,
    logError: dependencies.logError ?? console.error,
  };
  const statuses = await Promise.all(
    DATABASE_ROLE_BOUNDARY_TEST_LANES.map((testLane) =>
      runLane(testLane, options),
    ),
  );
  return statuses.find((status) => status !== 0) ?? 0;
}

const isMain =
  process.argv[1] !== undefined &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (isMain) {
  void runDatabaseRoleBoundaryTests().then(
    (status) => {
      process.exitCode = status;
    },
    () => {
      console.error("Database role-boundary test launcher failed.");
      process.exitCode = 1;
    },
  );
}
