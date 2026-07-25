import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

type LauncherModule = Readonly<{
  runDatabaseRoleBoundaryTests: (dependencies: Readonly<{
    environment: NodeJS.ProcessEnv;
    minimalNodeTestEnvironment: (environment: NodeJS.ProcessEnv) => NodeJS.ProcessEnv;
    spawnSync: (
      command: string,
      args: readonly string[],
      options: Readonly<Record<string, unknown>>,
    ) => Readonly<{ status: number | null; error?: Error }>;
  }>) => Promise<number>;
}>;

async function loadLauncher(): Promise<LauncherModule | null> {
  const modulePath = "../run-database-role-boundaries-tests";
  try {
    return await import(/* @vite-ignore */ modulePath) as LauncherModule;
  } catch {
    return null;
  }
}

describe("database role-boundary test launcher", () => {
  it("registers the standalone launcher without duplicating the integration runner", async () => {
    const packageJson = JSON.parse(
      await readFile("package.json", "utf8"),
    ) as { scripts: Record<string, string> };

    expect(packageJson.scripts["test:database-role-boundaries"]).toBe(
      "tsx scripts/run-database-role-boundaries-tests.ts",
    );
    expect(packageJson.scripts["test:integration"]).toBe(
      "tsx scripts/run-integration-tests.ts",
    );
  });

  it("passes one fixed test target only the shared sanitizer output", async () => {
    const launcher = await loadLauncher();
    expect(launcher).not.toBeNull();
    if (!launcher) return;

    const environment = {
      CI: "true",
      LANG: "C.UTF-8",
      SYSTEMROOT: "C:\\Windows",
      TEMP: "C:\\Temp",
      ARBITRARY_TOKEN: "token-canary",
      APP_SECRET: "secret-canary",
      SIGNING_KEY: "key-canary",
      SERVICE_CREDENTIAL: "credential-canary",
      AWS_SECRET_ACCESS_KEY: "cloud-secret-canary",
      CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE: "cloud-file-canary",
      HTTPS_PROXY: "proxy-canary",
      DATABASE_READONLY_URL: "alternate-database-canary",
      DATABASE_URL_FILE: "alternate-database-file-canary",
      PGHOST: "pg-host-canary",
      PGPORT: "pg-port-canary",
      PGUSER: "pg-user-canary",
      PGPASSWORD: "pg-password-canary",
      PGOPTIONS: "pg-options-canary",
    };
    const sanitizedEnvironment = {
      CI: environment.CI,
      LANG: environment.LANG,
      SYSTEMROOT: environment.SYSTEMROOT,
      TEMP: environment.TEMP,
    };
    const minimalNodeTestEnvironment = vi.fn(() => sanitizedEnvironment);
    const spawnSync = vi.fn(() => ({ status: 0 }));

    await expect(launcher.runDatabaseRoleBoundaryTests({
      environment,
      minimalNodeTestEnvironment,
      spawnSync,
    })).resolves.toBe(0);

    expect(minimalNodeTestEnvironment).toHaveBeenCalledWith(environment);
    expect(spawnSync).toHaveBeenCalledWith(
      process.execPath,
      [
        "--test",
        fileURLToPath(new URL("../database-role-boundaries.test.mjs", import.meta.url)),
      ],
      {
        env: sanitizedEnvironment,
        stdio: "inherit",
        windowsHide: true,
      },
    );
    expect(JSON.stringify(spawnSync.mock.calls)).not.toMatch(
      /token-canary|secret-canary|key-canary|credential-canary|cloud-|proxy-canary|alternate-database|pg-/u,
    );
  });
});
