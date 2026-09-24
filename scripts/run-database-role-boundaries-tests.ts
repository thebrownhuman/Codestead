import {
  spawn as nodeSpawn,
  type ChildProcess,
} from "node:child_process";
import os from "node:os";
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
  maxConcurrency?: number;
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
    240_000,
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
  }: Required<Omit<LauncherDependencies, "maxConcurrency">>,
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
  const { maxConcurrency: requestedConcurrency, ...launchDependencies } = dependencies;
  // Every lane is CPU-bound and has a wall-clock deadline, so running more lanes
  // than cores starves them into false timeouts on small CI runners.
  const maxConcurrency = Math.max(
    1,
    Math.floor(requestedConcurrency ?? os.availableParallelism()),
  );
  const options: Required<Omit<LauncherDependencies, "maxConcurrency">> = {
    buildChildLaunch:
      launchDependencies.buildChildLaunch ?? buildDisposableIntegrationChildLaunch,
    createChildController: launchDependencies.createChildController
      ?? createDisposableIntegrationChildController,
    environment: sanitizedEnvironment,
    spawn: launchDependencies.spawn ?? defaultSpawn,
    // Hang guard, not a speed target: the slowest lanes take ~40s alone on a fast
    // desktop and 2-3x longer on shared CI runners.
    deadlineMs: launchDependencies.deadlineMs ?? 180_000,
    heartbeatMs: launchDependencies.heartbeatMs ?? 15_000,
    terminationGraceMs: launchDependencies.terminationGraceMs ?? 5_000,
    log: launchDependencies.log ?? console.log,
    logError: launchDependencies.logError ?? console.error,
  };
  const statuses = new Array<number>(DATABASE_ROLE_BOUNDARY_TEST_LANES.length);
  let nextLane = 0;
  const worker = async () => {
    while (nextLane < DATABASE_ROLE_BOUNDARY_TEST_LANES.length) {
      const index = nextLane;
      nextLane += 1;
      statuses[index] = await runLane(DATABASE_ROLE_BOUNDARY_TEST_LANES[index], options);
    }
  };
  await Promise.all(Array.from(
    { length: Math.min(maxConcurrency, DATABASE_ROLE_BOUNDARY_TEST_LANES.length) },
    worker,
  ));
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
