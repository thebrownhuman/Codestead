import { spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export type PinnedCurriculumLanguage = "java" | "python";

export const PINNED_CURRICULUM_RUNTIMES = Object.freeze({
  java: {
    tag: "learncoding/runtime-java:local",
    imageDigest: "sha256:bec0bd9af9f698dea650e80f26d79f412c8f4cc13aec335af58cd3bc6ec95a46",
    version: "Java SE 21",
    entrypoint: "Main.java",
  },
  python: {
    tag: "learncoding/runtime-python:local",
    imageDigest: "sha256:857294af16c8bbb1a8d5c792acc785283b0c99cf8dcb2be2955208f06a43d3a2",
    version: "Python 3.14",
    entrypoint: "main.py",
  },
} satisfies Record<PinnedCurriculumLanguage, {
  readonly tag: string;
  readonly imageDigest: string;
  readonly version: string;
  readonly entrypoint: string;
}>);

export function pinnedDockerAvailable(): boolean {
  return spawnSync("docker", ["info"], { stdio: "ignore", windowsHide: true }).status === 0;
}

export function normalizeProgramOutput(value: string): string {
  return value.replaceAll("\r\n", "\n").trim();
}

export async function executePinnedCurriculumReference(input: {
  readonly language: PinnedCurriculumLanguage;
  readonly imageReference: string;
  readonly source: string;
  readonly stdin: string;
  readonly timeLimitMs: number;
  readonly memoryLimitMb: number;
}): Promise<{
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}> {
  const runtime = PINNED_CURRICULUM_RUNTIMES[input.language];
  const directory = mkdtempSync(path.join(os.tmpdir(), `lc-authored-${input.language}-`));
  const file = path.join(directory, runtime.entrypoint);
  writeFileSync(file, input.source, { encoding: "utf8", mode: 0o444 });
  try {
    chmodSync(directory, 0o755);
    chmodSync(file, 0o444);
  } catch {
    // Docker Desktop owns bind-mount translation on Windows.
  }
  const name = `lc-authored-${input.language}-${process.pid}-${Math.random().toString(16).slice(2, 10)}`;
  const args = [
    "run", "--rm", "--interactive", "--name", name, "--pull", "never",
    "--network", "none", "--ipc", "none", "--log-driver", "none",
    "--read-only", "--init", "--stop-timeout", "1", "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges:true", "--pids-limit", "32",
    "--memory", `${input.memoryLimitMb}m`, "--memory-swap", `${input.memoryLimitMb}m`,
    "--cpus", "0.5", "--ulimit", "fsize=16777216:16777216",
    "--ulimit", "nofile=64:64",
    "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=16m,uid=65532,gid=65532,mode=0700",
    "--tmpfs", "/work:rw,exec,nosuid,nodev,size=16777216,uid=65532,gid=65532,mode=0700",
    "--user", "65532:65532", "--env", "HOME=/tmp", "--workdir", "/work",
    "--mount", `type=bind,src=${directory},dst=/input,readonly`, input.imageReference,
    "/opt/runner/execute", "--mode", "run", "--language", input.language,
    "--source-root", "/input", "--entrypoint", `/input/${runtime.entrypoint}`,
  ];

  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let timedOut = false;
    let settled = false;
    const cleanup = () => {
      spawnSync("docker", ["rm", "--force", name], { stdio: "ignore", windowsHide: true });
      rmSync(directory, { recursive: true, force: true });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
      spawnSync("docker", ["rm", "--force", name], { stdio: "ignore", windowsHide: true });
    }, Math.max(15_000, input.timeLimitMs * 5));
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      reject(error);
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      resolve({
        code,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        timedOut,
      });
    });
    child.stdin.end(input.stdin);
  });
}
