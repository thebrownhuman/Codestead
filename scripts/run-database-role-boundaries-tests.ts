import { spawnSync as nodeSpawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

type EnvironmentSanitizer = (
  environment: NodeJS.ProcessEnv,
) => NodeJS.ProcessEnv;

type SpawnSync = (
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
  minimalNodeTestEnvironment?: EnvironmentSanitizer;
  spawnSync?: SpawnSync;
}>;

async function loadEnvironmentSanitizer(): Promise<EnvironmentSanitizer> {
  const modulePath = "./lib/disposable-integration-environment";
  const module = await import(
    /* @vite-ignore */ modulePath
  ) as { minimalNodeTestEnvironment?: EnvironmentSanitizer };
  if (typeof module.minimalNodeTestEnvironment !== "function") {
    throw new Error("database role-boundary test sanitizer is unavailable");
  }
  return module.minimalNodeTestEnvironment;
}

export async function runDatabaseRoleBoundaryTests(
  dependencies: LauncherDependencies = {},
): Promise<number> {
  const environment = dependencies.environment ?? process.env;
  const sanitizeEnvironment = dependencies.minimalNodeTestEnvironment
    ?? await loadEnvironmentSanitizer();
  const spawnSync = dependencies.spawnSync ?? nodeSpawnSync;
  const result = spawnSync(
    process.execPath,
    [
      "--test",
      fileURLToPath(new URL("./database-role-boundaries.test.mjs", import.meta.url)),
    ],
    {
      env: sanitizeEnvironment(environment),
      stdio: "inherit",
      windowsHide: true,
    },
  );
  if (result.error) {
    process.stderr.write("database role-boundary tests failed to start\n");
    return 1;
  }
  return result.status ?? 1;
}

const isMain = process.argv[1] !== undefined
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (isMain) {
  try {
    process.exitCode = await runDatabaseRoleBoundaryTests();
  } catch {
    process.stderr.write("database role-boundary test launcher failed\n");
    process.exitCode = 1;
  }
}
