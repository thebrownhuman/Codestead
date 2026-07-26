import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  minimalNodeTestEnvironment,
  runWithValidatedRetentionOpsEnvironment,
} from "../lib/disposable-integration-environment";

const validEnvironment = () => ({
  INTEGRATION_TEST: "1",
  DATABASE_URL:
    "postgresql://learncoding_migrator:migrator-password@127.0.0.1:49152/learncoding_integration?options=-c+role%3Dlearncoding_owner",
  DATABASE_OPS_URL:
    "postgresql://learncoding_ops:ops-password@127.0.0.1:49152/learncoding_integration",
});

describe("disposable integration environment", () => {
  it("admits only the exact migrator-owner and ops loopback URLs", async () => {
    const environment = validEnvironment();
    const operation = vi.fn(async (urls: Readonly<{
      databaseUrl: string;
      databaseOpsUrl: string;
    }>) => urls);

    await expect(runWithValidatedRetentionOpsEnvironment(
      environment,
      operation,
    )).resolves.toEqual({
      databaseUrl: environment.DATABASE_URL,
      databaseOpsUrl: environment.DATABASE_OPS_URL,
    });
    expect(operation).toHaveBeenCalledOnce();
  });

  it.each([
    ["missing integration marker", (env: Record<string, string | undefined>) => {
      delete env.INTEGRATION_TEST;
    }],
    ["wrong integration marker", (env: Record<string, string | undefined>) => {
      env.INTEGRATION_TEST = "true";
    }],
    ["missing migrator URL", (env: Record<string, string | undefined>) => {
      delete env.DATABASE_URL;
    }],
    ["wrong migrator role", (env: Record<string, string | undefined>) => {
      env.DATABASE_URL = env.DATABASE_URL!.replace("learncoding_migrator", "learncoding_app");
    }],
    ["remote migrator host", (env: Record<string, string | undefined>) => {
      env.DATABASE_URL = env.DATABASE_URL!.replace("127.0.0.1", "postgres");
    }],
    ["wrong migrator database", (env: Record<string, string | undefined>) => {
      env.DATABASE_URL = env.DATABASE_URL!.replace("learncoding_integration", "learncoding");
    }],
    ["missing owner option", (env: Record<string, string | undefined>) => {
      env.DATABASE_URL = env.DATABASE_URL!.split("?")[0];
    }],
    ["extra migrator option", (env: Record<string, string | undefined>) => {
      env.DATABASE_URL += "&sslmode=disable";
    }],
    ["wrong assumed owner", (env: Record<string, string | undefined>) => {
      env.DATABASE_URL = env.DATABASE_URL!.replace("learncoding_owner", "learncoding_ops");
    }],
    ["missing ops URL", (env: Record<string, string | undefined>) => {
      delete env.DATABASE_OPS_URL;
    }],
    ["wrong ops role", (env: Record<string, string | undefined>) => {
      env.DATABASE_OPS_URL = env.DATABASE_OPS_URL!.replace("learncoding_ops", "learncoding_app");
    }],
    ["remote ops host", (env: Record<string, string | undefined>) => {
      env.DATABASE_OPS_URL = env.DATABASE_OPS_URL!.replace("127.0.0.1", "postgres");
    }],
    ["different ops port", (env: Record<string, string | undefined>) => {
      env.DATABASE_OPS_URL = env.DATABASE_OPS_URL!.replace(":49152", ":49153");
    }],
    ["unsafe ops option", (env: Record<string, string | undefined>) => {
      env.DATABASE_OPS_URL += "?options=-c+role%3Dlearncoding_owner";
    }],
  ])("rejects %s before any connect or query", async (_name, mutate) => {
    const environment: Record<string, string | undefined> = validEnvironment();
    mutate(environment);
    const connect = vi.fn();
    const query = vi.fn();

    await expect(runWithValidatedRetentionOpsEnvironment(
      environment,
      async () => {
        connect();
        query();
      },
    )).rejects.toThrow("disposable integration environment validation failed");
    expect(connect).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });

  it("passes only an explicit minimal platform environment to child tests", () => {
    const child = minimalNodeTestEnvironment({
      CI: "true",
      LANG: "C.UTF-8",
      SYSTEMROOT: "C:\\Windows",
      TEMP: "C:\\Temp",
      ARBITRARY_TOKEN: "token-canary",
      APP_SECRET: "secret-canary",
      SIGNING_KEY: "key-canary",
      SERVICE_CREDENTIAL: "credential-canary",
      CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE: "cloud-canary",
      HTTPS_PROXY: "proxy-canary",
      DATABASE_READONLY_URL: "database-canary",
      PGHOST: "postgres-canary",
      DELETION_TOMBSTONE_KEY: "deletion-tombstone-secret-canary",
      DELETION_TOMBSTONE_KEY_FILE: "deletion-tombstone-file-canary",
    });

    expect(child).toEqual({
      CI: "true",
      LANG: "C.UTF-8",
      SYSTEMROOT: "C:\\Windows",
      TEMP: "C:\\Temp",
    });
    expect(JSON.stringify(child)).not.toMatch(
      /token-canary|secret-canary|key-canary|credential-canary|cloud-canary|proxy-canary|database-canary|postgres-canary|deletion-tombstone-secret-canary|deletion-tombstone-file-canary/u,
    );
  });

  it("keeps the deletion tombstone capability out of migration and the general runner", async () => {
    const [migrationRunner, integrationRunner] = await Promise.all([
      readFile(
        path.resolve(process.cwd(), "scripts/migrate-production.mjs"),
        "utf8",
      ),
      readFile(
        path.resolve(process.cwd(), "scripts/run-integration-tests.ts"),
        "utf8",
      ),
    ]);
    const deletionCapability =
      /DELETION_TOMBSTONE_KEY(?:_FILE)?|deletion_tombstone_key/u;

    expect(migrationRunner).not.toMatch(deletionCapability);
    expect(integrationRunner).not.toMatch(deletionCapability);
  });
});
