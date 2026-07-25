import path from "node:path";

import { describe, expect, it } from "vitest";

type EnvironmentSource = Readonly<Record<string, string | undefined>>;

type EnvironmentHardeningModule = Readonly<{
  buildDisposableIntegrationRuntimeEnvironment?: (
    source: EnvironmentSource,
    input: Readonly<{
      taskHomeDirectory: string;
      databaseAppUrl: string;
      databaseMigratorUrl: string;
      databaseWorkerUrl: string;
      databaseOpsUrl: string;
      databaseBackupReporterUrl: string;
      databaseUrl: string;
      betterAuthSecret: string;
    }>,
  ) => NodeJS.ProcessEnv;
  createIntegrationOutputSanitizer?: (input: Readonly<{
    secrets: readonly string[];
    write: (value: string) => void;
  }>) => Readonly<{
    end: () => void;
    write: (value: string | Uint8Array) => void;
  }>;
  minimalNodeTestEnvironment: (
    source: EnvironmentSource,
  ) => NodeJS.ProcessEnv;
}>;

async function loadEnvironmentModule(): Promise<EnvironmentHardeningModule> {
  const environmentModulePath = "../lib/disposable-integration-environment";
  const runtimeModulePath = "../lib/disposable-integration-runtime";
  const [environment, runtime] = await Promise.all([
    import(/* @vite-ignore */ environmentModulePath),
    import(/* @vite-ignore */ runtimeModulePath),
  ]);
  return { ...environment, ...runtime } as EnvironmentHardeningModule;
}

const hostileAmbientEnvironment = Object.freeze({
  Path: "C:\\runtime\\bin",
  PATHEXT: ".COM;.EXE;.BAT;.CMD",
  SystemRoot: "C:\\Windows",
  WINDIR: "C:\\Windows",
  COMSPEC: "C:\\Windows\\System32\\cmd.exe",
  TEMP: "C:\\Temp",
  TMP: "C:\\Temp",
  TMPDIR: "/tmp",
  LANG: "en_US.UTF-8",
  LC_ALL: "C.UTF-8",
  TERM: "xterm-256color",
  CI: "true",
  GITHUB_ACTIONS: "true",
  HOME: "/home/runner-with-npmrc",
  USERPROFILE: "C:\\Users\\runner-with-npmrc",
  APPDATA: "C:\\Users\\runner-with-npmrc\\AppData\\Roaming",
  LOCALAPPDATA: "C:\\Users\\runner-with-npmrc\\AppData\\Local",
  NODE_OPTIONS: "--require=C:\\hostile\\ambient-hook.cjs",
  API_TOKEN: "ambient-api-token-canary",
  SESSION_SECRET: "ambient-session-secret-canary",
  SIGNING_KEY: "ambient-signing-key-canary",
  GOOGLE_APPLICATION_CREDENTIALS: "ambient-google-credential-canary",
  AWS_SECRET_ACCESS_KEY: "ambient-aws-secret-canary",
  AZURE_CLIENT_SECRET: "ambient-azure-secret-canary",
  CLOUDFLARE_API_TOKEN: "ambient-cloudflare-token-canary",
  HTTP_PROXY: "http://ambient-proxy.invalid",
  HTTPS_PROXY: "http://ambient-proxy.invalid",
  NO_PROXY: "ambient-no-proxy-canary",
  DATABASE_URL: "postgresql://ambient:database@wrong.invalid/ambient",
  DATABASE_APP_URL: "postgresql://ambient:app@wrong.invalid/ambient",
  DATABASE_MIGRATOR_URL: "postgresql://ambient:migrator@wrong.invalid/ambient",
  DATABASE_WORKER_URL: "postgresql://ambient:worker@wrong.invalid/ambient",
  DATABASE_OPS_URL: "postgresql://ambient:ops@wrong.invalid/ambient",
  DATABASE_BACKUP_REPORTER_URL:
    "postgresql://ambient:backup-reporter@wrong.invalid/ambient",
  PGHOST: "ambient-pg-host.invalid",
  PGPASSWORD: "ambient-pg-password-canary",
  POSTGRES_PASSWORD: "ambient-postgres-password-canary",
  npm_config_registry_token: "ambient-npm-token-canary",
} satisfies EnvironmentSource);

describe("disposable integration environment hardening", () => {
  it("passes only canonical runtime keys and never profile or credential discovery paths", async () => {
    const environment = await loadEnvironmentModule();

    expect(
      environment.minimalNodeTestEnvironment(hostileAmbientEnvironment),
    ).toEqual({
      PATH: "C:\\runtime\\bin",
      PATHEXT: ".COM;.EXE;.BAT;.CMD",
      SYSTEMROOT: "C:\\Windows",
      WINDIR: "C:\\Windows",
      COMSPEC: "C:\\Windows\\System32\\cmd.exe",
      TEMP: "C:\\Temp",
      TMP: "C:\\Temp",
      TMPDIR: "/tmp",
      LANG: "en_US.UTF-8",
      LC_ALL: "C.UTF-8",
      TERM: "xterm-256color",
      CI: "true",
      GITHUB_ACTIONS: "true",
    });
  });

  it("prefers an exact canonical key and rejects ambiguous case variants", async () => {
    const environment = await loadEnvironmentModule();

    expect(environment.minimalNodeTestEnvironment({
      Path: "C:\\variant",
      PATH: "C:\\exact",
    })).toEqual({ PATH: "C:\\exact" });
    expect(() => environment.minimalNodeTestEnvironment({
      Path: "C:\\first",
      pAtH: "C:\\second",
    })).toThrow("disposable integration environment validation failed");
  });

  it("adds only explicit disposable database values to the minimal child environment", async () => {
    const environment = await loadEnvironmentModule();
    expect(typeof environment.buildDisposableIntegrationRuntimeEnvironment)
      .toBe("function");
    if (!environment.buildDisposableIntegrationRuntimeEnvironment) return;

    const explicit = {
      taskHomeDirectory: process.cwd(),
      databaseAppUrl: "postgresql://explicit-app",
      databaseMigratorUrl: "postgresql://explicit-migrator",
      databaseWorkerUrl: "postgresql://explicit-worker",
      databaseOpsUrl: "postgresql://explicit-ops",
      databaseBackupReporterUrl: "postgresql://explicit-backup-reporter",
      databaseUrl: "postgresql://explicit-owner",
      betterAuthSecret: "explicit-integration-auth-secret",
    };
    expect(
      environment.buildDisposableIntegrationRuntimeEnvironment(
        hostileAmbientEnvironment,
        explicit,
      ),
    ).toMatchObject({
      ...environment.minimalNodeTestEnvironment(hostileAmbientEnvironment),
      TEMP: path.join(explicit.taskHomeDirectory, "tmp"),
      TMP: path.join(explicit.taskHomeDirectory, "tmp"),
      TMPDIR: path.join(explicit.taskHomeDirectory, "tmp"),
      DATABASE_APP_URL: explicit.databaseAppUrl,
      DATABASE_MIGRATOR_URL: explicit.databaseMigratorUrl,
      DATABASE_WORKER_URL: explicit.databaseWorkerUrl,
      DATABASE_OPS_URL: explicit.databaseOpsUrl,
      DATABASE_BACKUP_REPORTER_URL: explicit.databaseBackupReporterUrl,
      DATABASE_URL: explicit.databaseUrl,
      DATABASE_POOL_SIZE: "8",
      NODE_ENV: "test",
      BETTER_AUTH_SECRET: explicit.betterAuthSecret,
      INTEGRATION_TEST: "1",
    });
  });

  it("redacts exact secrets even when output splits them across chunks", async () => {
    const environment = await loadEnvironmentModule();
    expect(typeof environment.createIntegrationOutputSanitizer).toBe("function");
    if (!environment.createIntegrationOutputSanitizer) return;

    const output: string[] = [];
    const password = "split-password-canary";
    const databaseUrl =
      `postgresql://learncoding_it:${password}@127.0.0.1:54321/learncoding_integration`;
    const sanitizer = environment.createIntegrationOutputSanitizer({
      secrets: [password, databaseUrl, "integration-auth-secret-canary"],
      write: (value) => output.push(value),
    });

    sanitizer.write("migration output split-pass");
    sanitizer.write(Buffer.from(
      "word-canary\nDATABASE_URL=postgresql://learncoding_it:split-password-",
    ));
    sanitizer.write(
      "canary@127.0.0.1:54321/learncoding_integration\nauth=integration-auth-",
    );
    sanitizer.write("secret-canary\ncomplete");
    sanitizer.end();

    const rendered = output.join("");
    expect(rendered).toContain("migration output [REDACTED]");
    expect(rendered).toContain("DATABASE_URL=[REDACTED]");
    expect(rendered).toContain("auth=[REDACTED]");
    expect(rendered).toContain("complete");
    expect(rendered).not.toContain(password);
    expect(rendered).not.toContain(databaseUrl);
    expect(rendered).not.toContain("integration-auth-secret-canary");
  });
});
