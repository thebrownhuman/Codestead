import { spawn } from "node:child_process";

export interface ProcessRequest {
  readonly command: string;
  readonly args: readonly string[];
  readonly stdin: string;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
}

export interface ProcessResult {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly wallTimeMs: number;
  readonly timedOut: boolean;
  readonly outputLimitExceeded: boolean;
}

export interface ProcessExecutor {
  run(request: ProcessRequest): Promise<ProcessResult>;
}

function appendBounded(
  chunks: Buffer[],
  chunk: Buffer,
  remaining: number,
): number {
  if (remaining <= 0) {
    return 0;
  }
  const accepted =
    chunk.length <= remaining ? chunk : chunk.subarray(0, remaining);
  if (accepted.length > 0) {
    chunks.push(accepted);
  }
  return accepted.length;
}

export class NodeProcessExecutor implements ProcessExecutor {
  run(request: ProcessRequest): Promise<ProcessResult> {
    if (!Number.isInteger(request.timeoutMs) || request.timeoutMs <= 0) {
      throw new RangeError("process timeout must be a positive integer");
    }
    if (
      !Number.isInteger(request.maxOutputBytes) ||
      request.maxOutputBytes <= 0
    ) {
      throw new RangeError("output limit must be a positive integer");
    }

    return new Promise<ProcessResult>((resolve, reject) => {
      const startedAt = performance.now();
      const child = spawn(request.command, [...request.args], {
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let outputBytes = 0;
      let timedOut = false;
      let outputLimitExceeded = false;
      let settled = false;

      const kill = (): void => {
        if (!child.killed) {
          child.kill("SIGKILL");
        }
      };
      const timer = setTimeout(() => {
        timedOut = true;
        kill();
      }, request.timeoutMs);
      timer.unref();

      const capture = (target: Buffer[], chunk: Buffer): void => {
        const remaining = request.maxOutputBytes - outputBytes;
        outputBytes += appendBounded(target, chunk, remaining);
        if (chunk.length > remaining && !outputLimitExceeded) {
          outputLimitExceeded = true;
          kill();
        }
      };

      child.stdout.on("data", (chunk: Buffer) => capture(stdout, chunk));
      child.stderr.on("data", (chunk: Buffer) => capture(stderr, chunk));
      child.once("error", (error) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        reject(error);
      });
      child.once("close", (exitCode, signal) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve({
          exitCode,
          signal,
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
          wallTimeMs: Math.max(0, performance.now() - startedAt),
          timedOut,
          outputLimitExceeded,
        });
      });

      child.stdin.end(request.stdin);
    });
  }
}
