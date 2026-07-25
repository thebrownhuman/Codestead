import path from "node:path";

import { describe, expect, it } from "vitest";

import { buildDisposableIntegrationRuntimeEnvironment } from
  "../lib/disposable-integration-runtime";

describe("disposable integration runtime home", () => {
  it("replaces every ambient profile/config discovery path with the fresh task home", () => {
    const taskHomeDirectory = path.resolve("task-home", "run123");
    const environment = buildDisposableIntegrationRuntimeEnvironment({
      Path: "C:\\runtime\\bin",
      FORCE_COLOR: "3",
      SystemRoot: "C:\\Windows",
      HOME: "C:\\ambient-home-canary",
      USERPROFILE: "C:\\ambient-profile-canary",
      APPDATA: "C:\\ambient-appdata-canary",
      LOCALAPPDATA: "C:\\ambient-local-appdata-canary",
      DOCKER_CONFIG: "C:\\ambient-docker-config-canary",
      XDG_CONFIG_HOME: "C:\\ambient-xdg-config-canary",
      NPM_CONFIG_USERCONFIG: "C:\\ambient-npmrc-canary",
      NPM_CONFIG_GLOBALCONFIG: "C:\\ambient-global-npmrc-canary",
      API_TOKEN: "ambient-token-canary",
    }, {
      taskHomeDirectory,
      databaseAppUrl: "postgresql://explicit-app",
      databaseMigratorUrl: "postgresql://explicit-migrator",
      databaseWorkerUrl: "postgresql://explicit-worker",
      databaseOpsUrl: "postgresql://explicit-ops",
      databaseBackupReporterUrl: "postgresql://explicit-reporter",
      databaseUrl: "postgresql://explicit-owner",
      betterAuthSecret: "explicit-integration-auth-secret",
    });

    expect(environment).toMatchObject({
      PATH: "C:\\runtime\\bin",
      NO_COLOR: "1",
      SYSTEMROOT: "C:\\Windows",
      HOME: taskHomeDirectory,
      USERPROFILE: taskHomeDirectory,
      APPDATA: path.join(taskHomeDirectory, "appdata"),
      LOCALAPPDATA: path.join(taskHomeDirectory, "local-appdata"),
      DOCKER_CONFIG: path.join(taskHomeDirectory, "docker"),
      XDG_CONFIG_HOME: path.join(taskHomeDirectory, "xdg-config"),
      XDG_CACHE_HOME: path.join(taskHomeDirectory, "xdg-cache"),
      XDG_DATA_HOME: path.join(taskHomeDirectory, "xdg-data"),
      NPM_CONFIG_GLOBALCONFIG: path.join(taskHomeDirectory, "global-npmrc"),
      NPM_CONFIG_USERCONFIG: path.join(taskHomeDirectory, ".npmrc"),
      NPM_CONFIG_CACHE: path.join(taskHomeDirectory, "npm-cache"),
    });
    expect(environment.FORCE_COLOR).toBeUndefined();
    expect(JSON.stringify(environment)).not.toMatch(
      /ambient-home-canary|ambient-profile-canary|ambient-appdata-canary|ambient-local-appdata-canary|ambient-docker-config-canary|ambient-xdg-config-canary|ambient-npmrc-canary|ambient-global-npmrc-canary|ambient-token-canary/u,
    );
  });
});
