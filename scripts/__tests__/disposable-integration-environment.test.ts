import { describe, expect, it } from "vitest";

type IntegrationEnvironmentModule = Readonly<{
  buildDockerIntegrationEnvironment: (
    source: NodeJS.ProcessEnv,
    password: string,
  ) => NodeJS.ProcessEnv;
  buildNpmIntegrationEnvironment: (
    source: NodeJS.ProcessEnv,
    input: Readonly<{
      databaseUrl: string;
      betterAuthSecret: string;
    }>,
  ) => NodeJS.ProcessEnv;
  buildSafeIntegrationHostEnvironment: (
    source: NodeJS.ProcessEnv,
  ) => NodeJS.ProcessEnv;
  createIntegrationOutputSanitizer: (input: Readonly<{
    secrets: readonly string[];
    write: (value: string) => void;
  }>) => Readonly<{
    end: () => void;
    write: (value: string | Uint8Array) => void;
  }>;
}>;

async function loadEnvironmentModule(): Promise<IntegrationEnvironmentModule | null> {
  const modulePath = "../lib/disposable-integration-environment";
  try {
    return await import(/* @vite-ignore */ modulePath) as IntegrationEnvironmentModule;
  } catch {
    return null;
  }
}

const hostileAmbientEnvironment = Object.freeze({
  Path: "C:\\runtime\\bin",
  PATHEXT: ".COM;.EXE;.BAT;.CMD",
  SystemRoot: "C:\\Windows",
  WINDIR: "C:\\Windows",
  COMSPEC: "C:\\Windows\\System32\\cmd.exe",
  TEMP: "C:\\Temp",
  TMP: "C:\\Temp",
  USERPROFILE: "C:\\Users\\runner",
  APPDATA: "C:\\Users\\runner\\AppData\\Roaming",
  LOCALAPPDATA: "C:\\Users\\runner\\AppData\\Local",
  HOME: "/home/runner",
  TMPDIR: "/tmp",
  LANG: "en_US.UTF-8",
  LC_ALL: "C.UTF-8",
  TERM: "xterm-256color",
  CI: "true",
  GITHUB_ACTIONS: "true",
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
  PGHOST: "ambient-pg-host.invalid",
  PGPASSWORD: "ambient-pg-password-canary",
  POSTGRES_PASSWORD: "ambient-postgres-password-canary",
  npm_config_registry_token: "ambient-npm-token-canary",
} satisfies NodeJS.ProcessEnv);

describe("disposable integration child environment", () => {
  it("copies only the canonical cross-platform host allowlist", async () => {
    const environment = await loadEnvironmentModule();
    expect(environment).not.toBeNull();
    if (!environment) return;

    expect(
      environment.buildSafeIntegrationHostEnvironment(hostileAmbientEnvironment),
    ).toEqual({
      PATH: "C:\\runtime\\bin",
      PATHEXT: ".COM;.EXE;.BAT;.CMD",
      SYSTEMROOT: "C:\\Windows",
      WINDIR: "C:\\Windows",
      COMSPEC: "C:\\Windows\\System32\\cmd.exe",
      TEMP: "C:\\Temp",
      TMP: "C:\\Temp",
      USERPROFILE: "C:\\Users\\runner",
      APPDATA: "C:\\Users\\runner\\AppData\\Roaming",
      LOCALAPPDATA: "C:\\Users\\runner\\AppData\\Local",
      HOME: "/home/runner",
      TMPDIR: "/tmp",
      LANG: "en_US.UTF-8",
      LC_ALL: "C.UTF-8",
      TERM: "xterm-256color",
      CI: "true",
      GITHUB_ACTIONS: "true",
    });
  });

  it("adds only the explicit Docker password and npm test values", async () => {
    const environment = await loadEnvironmentModule();
    expect(environment).not.toBeNull();
    if (!environment) return;

    const password = "explicit-postgres-password-canary";
    const databaseUrl =
      `postgresql://learncoding_it:${password}@127.0.0.1:54321/learncoding_integration`;
    const betterAuthSecret = "explicit-better-auth-secret-canary";

    expect(
      environment.buildDockerIntegrationEnvironment(
        hostileAmbientEnvironment,
        password,
      ),
    ).toEqual({
      ...environment.buildSafeIntegrationHostEnvironment(hostileAmbientEnvironment),
      POSTGRES_PASSWORD: password,
    });
    expect(
      environment.buildNpmIntegrationEnvironment(hostileAmbientEnvironment, {
        databaseUrl,
        betterAuthSecret,
      }),
    ).toEqual({
      ...environment.buildSafeIntegrationHostEnvironment(hostileAmbientEnvironment),
      DATABASE_URL: databaseUrl,
      DATABASE_POOL_SIZE: "8",
      NODE_ENV: "test",
      BETTER_AUTH_SECRET: betterAuthSecret,
      INTEGRATION_TEST: "1",
    });
  });

  it("redacts exact secrets even when child output splits them across chunks", async () => {
    const environment = await loadEnvironmentModule();
    expect(environment).not.toBeNull();
    if (!environment) return;

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
