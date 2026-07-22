import path from "node:path";

import { describe, expect, it } from "vitest";

import { resolveProductionLoadConfig } from "./production-load-config";

const root = path.resolve("test-results", "production-load-config");

function validEnvironment(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "test",
    LOAD_MODE: "production",
    LOAD_ALLOW_REMOTE: "1",
    LOAD_BASE_URL: "https://codestead.example.test",
    LOAD_SCOPE: "codestead-project-only",
    LOAD_PROJECT: "learncoding",
    LOAD_DISPOSABLE_FAULTS_CONFIRMED: "1",
    LOAD_EVIDENCE_ROOT: path.join(root, "evidence"),
    LOAD_ACTIVE_RELEASE_PATH: path.join(root, "active-release.env"),
    LOAD_CONTROL_SOCKET: path.join(root, "codestead-load-control.sock"),
    LOAD_NUC_HOST_ID: "nuc-ed25519-sha256-0123456789abcdef",
    LOAD_RUNNER_VM_ID: "57b9ab11-f3a4-4ea8-a58e-e73d951f9d11",
  };
}

describe("production load execution configuration", () => {
  it("binds the fixed scope, project, identities, control command, and exclusive report path", () => {
    const config = resolveProductionLoadConfig(validEnvironment(), process.cwd());

    expect(config.mode).toBe("production");
    expect(config.allowRemote).toBe(true);
    expect(config.baseUrl.href).toBe("https://codestead.example.test/");
    expect(config.scope).toBe("codestead-project-only");
    expect(config.project).toBe("learncoding");
    expect(config.disposableFaultsConfirmed).toBe(true);
    expect(config.datasetId).toBe("seed-20260715");
    expect(config.nucHostId).toBe("nuc-ed25519-sha256-0123456789abcdef");
    expect(config.runnerVmId).toBe("57b9ab11-f3a4-4ea8-a58e-e73d951f9d11");
    expect(config.evidenceRoot).toBe(path.resolve(root, "evidence"));
    expect(config.activeReleasePath).toBe(path.resolve(root, "active-release.env"));
    expect(config.controlSocket).toBe(path.resolve(root, "codestead-load-control.sock"));
    expect(config.reportPath).toBe(path.resolve(root, "evidence", "load-gate-report.json"));
  });

  it.each([
    ["LOAD_MODE", undefined],
    ["LOAD_MODE", "smoke"],
    ["LOAD_ALLOW_REMOTE", undefined],
    ["LOAD_ALLOW_REMOTE", "0"],
    ["LOAD_SCOPE", "disposable-only"],
    ["LOAD_PROJECT", "other-project"],
    ["LOAD_DISPOSABLE_FAULTS_CONFIRMED", "0"],
    ["LOAD_NUC_HOST_ID", "nuc host"],
    ["LOAD_RUNNER_VM_ID", "not-a-uuid"],
  ] as const)("fails closed for invalid %s=%s", (name, value) => {
    const environment = validEnvironment();
    if (value === undefined) delete environment[name];
    else environment[name] = value;

    expect(() => resolveProductionLoadConfig(environment, process.cwd())).toThrow(
      /Production load configuration failed/,
    );
  });

  it.each([
    "https://user:secret@codestead.example.test",
    "https://codestead.example.test/load?token=secret",
    "https://codestead.example.test/load#secret",
    "file:///tmp/codestead",
  ])("rejects unsafe or ambiguous production target %s", (target) => {
    const environment = validEnvironment();
    environment.LOAD_BASE_URL = target;

    expect(() => resolveProductionLoadConfig(environment, process.cwd())).toThrow(
      /Production load configuration failed/,
    );
  });

  it.each([
    "LOAD_EVIDENCE_ROOT",
    "LOAD_ACTIVE_RELEASE_PATH",
    "LOAD_CONTROL_SOCKET",
  ] as const)("requires absolute operational path %s", (name) => {
    const environment = validEnvironment();
    environment[name] = "relative/path";

    expect(() => resolveProductionLoadConfig(environment, process.cwd())).toThrow(
      /Production load configuration failed/,
    );
  });

  it("rejects a report path outside the exact evidence root", () => {
    const environment = validEnvironment();
    environment.LOAD_REPORT_PATH = path.join(root, "elsewhere", "report.json");

    expect(() => resolveProductionLoadConfig(environment, process.cwd())).toThrow(
      /Production load configuration failed/,
    );
  });

  it("rejects inherited smoke authentication material in production mode", () => {
    const environment = validEnvironment();
    environment.LOAD_COOKIE = "session=must-not-enter-production-mode";

    expect(() => resolveProductionLoadConfig(environment, process.cwd())).toThrow(
      /Production load configuration failed/,
    );
  });
});
