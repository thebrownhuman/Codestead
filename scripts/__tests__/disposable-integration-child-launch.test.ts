import { spawnSync } from "node:child_process";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { buildDisposableIntegrationChildLaunch } from
  "../lib/disposable-integration-child-launch";
import { buildDisposableToolEnvironment } from
  "../lib/disposable-tool-environment";

describe("disposable integration child launch", () => {
  it("keeps the direct detached process-group launch on POSIX", () => {
    const environment = {
      NODE_ENV: "test" as const,
      PATH: "/usr/bin",
    };
    expect(buildDisposableIntegrationChildLaunch({
      command: "/usr/bin/node",
      args: ["--test", "two words", 'a"b', "tail\\"],
      environment,
      platform: "linux",
    })).toEqual({
      command: "/usr/bin/node",
      args: ["--test", "two words", 'a"b', "tail\\"],
      environment,
      treeSupervised: false,
    });
  });

  it("uses a fixed PowerShell tree-wait supervisor on Windows", () => {
    const environment = {
      NODE_ENV: "test" as const,
      PATH: "C:\\runtime",
      SYSTEMROOT: "C:\\Windows",
    };
    const launch = buildDisposableIntegrationChildLaunch({
      command: "C:\\runtime\\node.exe",
      args: ["--test", "two words", 'a"b', "tail\\"],
      environment,
      platform: "win32",
    });

    expect(launch.command).toBe(
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    );
    expect(launch.args).toContain("-NoProfile");
    expect(launch.args).toContain("-NonInteractive");
    expect(launch.args.join(" ")).toContain("Start-Process");
    expect(launch.args.join(" ")).toContain("-Wait");
    expect(launch.args.join(" ")).not.toContain("C:\\runtime\\node.exe");
    expect(launch.treeSupervised).toBe(true);
    expect(
      Buffer.from(
        launch.environment.CODESTEAD_INTEGRATION_CHILD_COMMAND ?? "",
        "base64",
      ).toString("utf8"),
    ).toBe("C:\\runtime\\node.exe");
    expect(
      Buffer.from(
        launch.environment.CODESTEAD_INTEGRATION_CHILD_ARGUMENTS ?? "",
        "base64",
      ).toString("utf8"),
    ).toBe('--test "two words" "a\\"b" tail\\');
  });

  it.skipIf(process.platform !== "win32")(
    "does not let the Windows supervisor close before a detached descendant",
    () => {
      const taskHomeDirectory = path.resolve(
        "test-results",
        "disposable-supervisor-home",
      );
      const environment = buildDisposableToolEnvironment(
        process.env,
        taskHomeDirectory,
      );
      const rootScript = [
        'const { spawn } = require("node:child_process");',
        'process.stdout.write("supervisor-stdout-canary\\n");',
        'process.stderr.write("supervisor-stderr-canary\\n");',
        "const child = spawn(process.execPath, [",
        '  "--eval", "setTimeout(() => {}, 1500)",',
        "], { detached: true, stdio: \"ignore\" });",
        "child.unref();",
        "process.exitCode = 23;",
      ].join("\n");
      const launch = buildDisposableIntegrationChildLaunch({
        command: process.execPath,
        args: ["--eval", rootScript],
        environment,
        platform: "win32",
      });

      const startedAt = Date.now();
      const result = spawnSync(launch.command, [...launch.args], {
        encoding: "utf8",
        env: launch.environment,
        windowsHide: true,
      });
      const elapsedMs = Date.now() - startedAt;

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(23);
      expect(result.stdout).toContain("supervisor-stdout-canary");
      expect(result.stderr).toContain("supervisor-stderr-canary");
      expect(elapsedMs).toBeGreaterThanOrEqual(1_200);
    },
  );
});
