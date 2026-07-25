import {
  spawn,
  spawnSync,
  type ChildProcess,
} from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { buildDisposableIntegrationChildLaunch } from
  "../lib/disposable-integration-child-launch";
import { createDisposableIntegrationChildController } from
  "../lib/disposable-integration-child-controller";
import { buildDisposableToolEnvironment } from
  "../lib/disposable-tool-environment";

const CHILD_FIXTURE_DEADLINE_MS = 8_000;
const CHILD_FIXTURE_GRACEFUL_CLEANUP_MS = 2_000;
const CHILD_FIXTURE_FORCE_CLEANUP_MS = 2_000;

type ChildResult = Readonly<{
  code: number | null;
  signal: NodeJS.Signals | null;
}>;

function waitForChildResult(
  child: ChildProcess,
  timeoutMs: number,
): Promise<ChildResult> {
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      clearTimeout(timeout);
      child.off("error", onError);
      child.off("close", onClose);
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const onClose = (
      code: number | null,
      signal: NodeJS.Signals | null,
    ): void => {
      cleanup();
      resolve({ code, signal });
    };
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("bounded child fixture deadline exceeded"));
    }, timeoutMs);
    timeout.unref();
    child.once("error", onError);
    child.once("close", onClose);
  });
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

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

  it("keeps the executable proof bounded and independent of ambient npm", () => {
    const source = readFileSync(
      path.resolve(
        process.cwd(),
        "scripts",
        "__tests__",
        "disposable-integration-child-launch.test.ts",
      ),
      "utf8",
    );
    for (const forbidden of [
      "npm_" + "execpath",
      "npm-" + "cli.js",
    ]) {
      expect(source).not.toContain(forbidden);
    }
    for (const required of [
      "createDisposableIntegration" + "ChildController",
      "CHILD_FIXTURE_" + "DEADLINE_MS",
      "hasActive" + "Child",
    ]) {
      expect(source).toContain(required);
    }
  });

  it.skipIf(process.platform !== "win32")(
    "executes the exact npm-shaped target and reaps its process tree",
    async () => {
      const fixtureRoot = mkdtempSync(
        path.join(tmpdir(), "codestead-child-launch-fixture-"),
      );
      mkdirSync(path.join(fixtureRoot, "tmp"));
      const controller = createDisposableIntegrationChildController({
        gracefulTimeoutMs: CHILD_FIXTURE_GRACEFUL_CLEANUP_MS,
        forceTimeoutMs: CHILD_FIXTURE_FORCE_CLEANUP_MS,
      });

      try {
        const target = "integration/daily-review.integration.test.ts";
        const artifactPath = path.join(
          fixtureRoot,
          "runner result artifact.json",
        );
        const fixturePath = path.join(fixtureRoot, "npm-shaped-fixture.cjs");
        writeFileSync(fixturePath, [
          'const { writeFileSync } = require("node:fs");',
          "const [verb, scriptName, separator, artifactPath, target] =",
          "  process.argv.slice(2);",
          "writeFileSync(artifactPath, JSON.stringify({",
          "  argv: process.argv.slice(2),",
          "  cwd: process.cwd(),",
          "  pid: process.pid,",
          "  targetExecuted:",
          '    verb === "run"',
          '    && scriptName === "canary"',
          '    && separator === "--"',
          `    && target === ${JSON.stringify(target)},`,
          '}), "utf8");',
          "process.exitCode = 37;",
        ].join("\n"), "utf8");
        const environment = buildDisposableToolEnvironment(
          process.env,
          fixtureRoot,
        );
        const launch = buildDisposableIntegrationChildLaunch({
          command: process.execPath,
          args: [
            fixturePath,
            "run",
            "canary",
            "--",
            artifactPath,
            target,
          ],
          environment,
          platform: "win32",
        });
        const tracked = controller.spawnAndTrack(() => (
          spawn(
            launch.command,
            [...launch.args],
            {
              cwd: fixtureRoot,
              detached: launch.detached,
              env: launch.environment,
              stdio: "ignore",
              windowsHide: true,
            },
          )
        ));
        const supervisorPid = tracked.child.pid;
        if (supervisorPid === undefined) {
          throw new Error("child supervisor pid unavailable");
        }
        const result = await waitForChildResult(
          tracked.child,
          CHILD_FIXTURE_DEADLINE_MS,
        );
        await tracked.completeAndWait("SIGTERM");

        expect(result).toEqual({
          code: 37,
          signal: null,
        });
        expect(controller.hasActiveChild()).toBe(false);
        expect(launch.detached).toBe(false);
        expect(existsSync(artifactPath)).toBe(true);
        const artifact = JSON.parse(readFileSync(
          artifactPath,
          "utf8",
        )) as {
          argv: string[];
          cwd: string;
          pid: number;
          targetExecuted: boolean;
        };
        const fixturePid = artifact.pid;
        expect(artifact).toEqual({
          argv: ["run", "canary", "--", artifactPath, target],
          cwd: fixtureRoot,
          pid: expect.any(Number),
          targetExecuted: true,
        });
        expect(supervisorPid).toEqual(expect.any(Number));
        expect(isProcessAlive(supervisorPid)).toBe(false);
        expect(isProcessAlive(fixturePid)).toBe(false);
      } finally {
        if (controller.hasActiveChild()) {
          await controller.terminateAndWait("SIGTERM");
        }
        rmSync(fixtureRoot, {
          force: true,
          maxRetries: 0,
          recursive: true,
        });
      }
      expect(existsSync(fixtureRoot)).toBe(false);
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
