import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { buildDisposableIntegrationChildLaunch } from
  "../lib/disposable-integration-child-launch";
import { createDisposableIntegrationTaskHome } from
  "../lib/disposable-integration-task-home";
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
      detached: true,
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
    expect(launch.detached).toBe(false);
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
    "executes the exact npm target from the requested cwd and propagates its status",
    async () => {
      const home = createDisposableIntegrationTaskHome();
      try {
        const target = "integration/daily-review.integration.test.ts";
        const artifactPath = path.join(
          home.path,
          "runner result artifact.json",
        );
        const packagePath = path.join(home.path, "package.json");
        const canaryPath = path.join(home.path, "canary.cjs");
        writeFileSync(packagePath, JSON.stringify({
          private: true,
          scripts: { canary: "node canary.cjs" },
        }), "utf8");
        writeFileSync(canaryPath, [
          'const { writeFileSync } = require("node:fs");',
          "const [artifactPath, target] = process.argv.slice(2);",
          "writeFileSync(artifactPath, JSON.stringify({",
          "  argv: process.argv.slice(2),",
          "  cwd: process.cwd(),",
          `  targetExecuted: target === ${JSON.stringify(target)},`,
          '}), "utf8");',
          "process.exitCode = 37;",
        ].join("\n"), "utf8");
        const npmCli = process.env.npm_execpath ?? path.join(
          path.dirname(process.execPath),
          "node_modules",
          "npm",
          "bin",
          "npm-cli.js",
        );
        const environment = buildDisposableToolEnvironment(
          process.env,
          home.path,
        );
        const launch = buildDisposableIntegrationChildLaunch({
          command: process.execPath,
          args: [
            npmCli,
            "run",
            "canary",
            "--",
            artifactPath,
            target,
          ],
          environment,
          platform: "win32",
        });
        const result = await new Promise<{
          code: number | null;
          signal: NodeJS.Signals | null;
        }>((resolve, reject) => {
          const child = spawn(
            launch.command,
            [...launch.args],
            {
              cwd: home.path,
              detached: launch.detached,
              env: launch.environment,
              stdio: "ignore",
              windowsHide: true,
            },
          );
          child.once("error", reject);
          child.once("close", (code, signal) => {
            resolve({ code, signal });
          });
        });

        expect(result).toEqual({
          code: 37,
          signal: null,
        });
        expect(launch.detached).toBe(false);
        expect(existsSync(artifactPath)).toBe(true);
        expect(JSON.parse(readFileSync(artifactPath, "utf8"))).toEqual({
          argv: [artifactPath, target],
          cwd: home.path,
          targetExecuted: true,
        });
      } finally {
        home.cleanup();
      }
    },
  );

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
