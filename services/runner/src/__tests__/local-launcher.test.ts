import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  acquireLocalRunnerOwnership,
  buildLocalRunnerEnvironment,
  parseEnvText,
} from "../local-launcher.js";
import { verifyInheritedProcessLock } from "../process-lock.js";

const roots: string[] = [];
const images = {
  RUNNER_IMAGE_C: `learncoding/c@sha256:${"1".repeat(64)}`,
  RUNNER_IMAGE_CPP: `learncoding/cpp@sha256:${"2".repeat(64)}`,
  RUNNER_IMAGE_JAVA: `learncoding/java@sha256:${"3".repeat(64)}`,
  RUNNER_IMAGE_PYTHON: `learncoding/python@sha256:${"4".repeat(64)}`,
  RUNNER_IMAGE_JAVASCRIPT: `learncoding/javascript@sha256:${"5".repeat(64)}`,
};

function root(): string {
  const value = mkdtempSync(path.join(os.tmpdir(), "runner-local-launcher-"));
  roots.push(value);
  return value;
}

afterEach(() => {
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true });
});

describe("development-only local runner launcher", () => {
  it("parses the small dotenv surface without evaluating shell syntax", () => {
    expect(parseEnvText([
      "# comment",
      "RUNNER_PORT=4100",
      "export RUNNER_SHARED_SECRET='literal-secret-with-#-and-$'",
      "RUNNER_DOCKER_BINARY=\"docker\\\\desktop\"",
    ].join("\n"))).toEqual({
      RUNNER_PORT: "4100",
      RUNNER_SHARED_SECRET: "literal-secret-with-#-and-$",
      RUNNER_DOCKER_BINARY: "docker\\desktop",
    });
    expect(() => parseEnvText("not an assignment")).toThrow(/line 1/i);
  });

  it("passes only OS and runner-specific values to the child service", () => {
    const stateRoot = path.join(root(), "state");
    const tempRoot = path.join(root(), "tmp");
    const env = buildLocalRunnerEnvironment({
      inheritedEnv: {
        PATH: "C:\\tools",
        DATABASE_URL: "must-not-reach-runner",
        NVIDIA_API_KEY: "must-not-reach-runner",
      },
      rootEnv: {
        RUNNER_SHARED_SECRET: "local-runner-secret-with-at-least-32-bytes",
        RUNNER_PORT: "4100",
        BETTER_AUTH_SECRET: "must-not-reach-runner",
      },
      imageEnv: images,
      stateRoot,
      tempRoot,
      lockFd: 3,
    });

    expect(env).toMatchObject({
      NODE_ENV: "production",
      PATH: "C:\\tools",
      RUNNER_SHARED_SECRET: "local-runner-secret-with-at-least-32-bytes",
      RUNNER_HOST: "127.0.0.1",
      RUNNER_PORT: "4100",
      RUNNER_MAX_CONCURRENCY: "2",
      RUNNER_STATE_ROOT: stateRoot,
      RUNNER_TEMP_ROOT: tempRoot,
      RUNNER_PROCESS_LOCK_HELD: "1",
      RUNNER_PROCESS_LOCK_FD: "3",
      ...images,
    });
    expect(env).not.toHaveProperty("DATABASE_URL");
    expect(env).not.toHaveProperty("NVIDIA_API_KEY");
    expect(env).not.toHaveProperty("BETTER_AUTH_SECRET");
  });

  it("fails closed when required secrets or pinned runtime records are absent", () => {
    const base = {
      inheritedEnv: {},
      rootEnv: { RUNNER_SHARED_SECRET: "local-runner-secret-with-at-least-32-bytes" },
      imageEnv: images,
      stateRoot: path.join(root(), "state"),
      tempRoot: path.join(root(), "tmp"),
      lockFd: 3,
    };
    expect(() => buildLocalRunnerEnvironment({
      ...base,
      rootEnv: {},
    })).toThrow(/shared secret/i);
    expect(() => buildLocalRunnerEnvironment({
      ...base,
      imageEnv: { ...images, RUNNER_IMAGE_PYTHON: "" },
    })).toThrow(/RUNNER_IMAGE_PYTHON/);
    expect(() => buildLocalRunnerEnvironment({
      ...base,
      inheritedEnv: {
        RUNNER_IMAGE_PYTHON: `attacker.invalid/python@sha256:${"f".repeat(64)}`,
      },
    })).toThrow(/cannot override the canonical/i);
  });

  it("owns one state directory at a time and passes the real lock descriptor contract", () => {
    const stateRoot = path.join(root(), "state");
    const first = acquireLocalRunnerOwnership(stateRoot);
    try {
      expect(() => acquireLocalRunnerOwnership(stateRoot)).toThrow(/already active/i);
      expect(() => verifyInheritedProcessLock(stateRoot, {
        RUNNER_PROCESS_LOCK_HELD: "1",
        RUNNER_PROCESS_LOCK_FD: String(first.lockFd),
      })).not.toThrow();
    } finally {
      first.release();
    }
    const second = acquireLocalRunnerOwnership(stateRoot);
    second.release();
  });

  it("recovers an owner marker left by a process that no longer exists", () => {
    const stateRoot = path.join(root(), "state");
    const initial = acquireLocalRunnerOwnership(stateRoot);
    initial.release();
    writeFileSync(path.join(stateRoot, ".runner-local-owner"), JSON.stringify({ pid: 2_147_483_647 }));

    const recovered = acquireLocalRunnerOwnership(stateRoot);
    recovered.release();
  });
});
