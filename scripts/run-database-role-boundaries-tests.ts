import { spawnSync as nodeSpawnSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { minimalNodeTestEnvironment } from "./lib/disposable-integration-environment";

type SpawnSyncRunner = (
  command: string,
  args: readonly string[],
  options: Readonly<{
    env: NodeJS.ProcessEnv;
    stdio: "inherit";
    windowsHide: true;
  }>,
) => Readonly<{
  status: number | null;
  error?: Error;
}>;

type LauncherDependencies = Readonly<{
  environment?: NodeJS.ProcessEnv;
  spawnSync?: SpawnSyncRunner;
}>;

const defaultSpawnSync: SpawnSyncRunner = (command, args, options) =>
  nodeSpawnSync(command, [...args], options);

export function runDatabaseRoleBoundaryTests(
  dependencies: LauncherDependencies = {},
): number {
  const result = (dependencies.spawnSync ?? defaultSpawnSync)(
    process.execPath,
    [
      "--test",
      path.resolve(process.cwd(), "scripts/database-role-boundaries.test.mjs"),
    ],
    {
      env: minimalNodeTestEnvironment(
        dependencies.environment ?? process.env,
      ),
      stdio: "inherit",
      windowsHide: true,
    },
  );

  if (result.error) {
    console.error("Database role-boundary tests could not be started.");
    return 1;
  }
  return result.status ?? 1;
}

const isMain = process.argv[1] !== undefined
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (isMain) {
  process.exitCode = runDatabaseRoleBoundaryTests();
}
