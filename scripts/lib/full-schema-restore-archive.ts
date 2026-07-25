import { createHash } from "node:crypto";
import {
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";

type SignalName = "SIGINT" | "SIGTERM";

type ChildLaunch = Readonly<{
  args: readonly string[];
  command: string;
  environment: NodeJS.ProcessEnv;
  treeSupervised: boolean;
}>;

type TrackedChild = Readonly<{
  child: ChildProcessWithoutNullStreams;
  completeAndWait: (signal: SignalName) => Promise<void>;
}>;

export type FullSchemaRestoreChildController = Readonly<{
  hasActiveChild: () => boolean;
  spawnAndTrack: (
    spawnChild: () => ChildProcessWithoutNullStreams,
  ) => TrackedChild;
  terminateAndWait: (signal: SignalName) => Promise<void>;
  waitForTermination: () => Promise<void>;
}>;

export type FullSchemaArchiveChildResult = Readonly<{
  exitCode: number | null;
  failed: boolean;
  signalCode: NodeJS.Signals | null;
  stdout: Buffer;
}>;

export type FullSchemaRestoreArchiveEvidence = Readonly<{
  archiveSha256: string;
  tocSha256: string;
  sourceObjectContractSha256: string;
  sourceBindingSha256: string;
  aclEntryCount: number;
  routineAclEntryCount: number;
}>;

export type FullSchemaRestoreBuildChildLaunch = (input: Readonly<{
  args: readonly string[];
  command: string;
  environment: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}>) => ChildLaunch;

type SpawnProcess = (
  command: string,
  args: readonly string[],
  options: Readonly<{
    detached: boolean;
    env: NodeJS.ProcessEnv;
    stdio: ["pipe", "pipe", "pipe"];
    windowsHide: true;
  }>,
) => ChildProcessWithoutNullStreams;

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function deriveFullSchemaArchiveEvidence(input: Readonly<{
  archive: Buffer;
  toc: Buffer;
  sourceObjectContractSha256: string;
}>): FullSchemaRestoreArchiveEvidence {
  if (
    input.archive.length === 0
    || input.toc.length === 0
    || !/^[0-9a-f]{64}$/u.test(input.sourceObjectContractSha256)
  ) {
    throw new Error("full-schema restore archive ACL evidence failed");
  }
  const tocText = input.toc.toString("utf8");
  if (tocText.includes("\0") || tocText.includes("\uFFFD")) {
    throw new Error("full-schema restore archive ACL evidence failed");
  }
  const aclEntries = tocText
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) =>
      /^[0-9]+;\s+[0-9]+\s+[0-9]+\s+ACL\s+/u.test(line));
  const routineAclEntryCount = aclEntries.filter((line) =>
    /\sACL\s+\S+\s+(?:FUNCTION|PROCEDURE)\s+/u.test(line)).length;
  if (aclEntries.length === 0 || routineAclEntryCount === 0) {
    throw new Error("full-schema restore archive ACL evidence failed");
  }
  const archiveSha256 = sha256(input.archive);
  const tocSha256 = sha256(input.toc);
  return {
    archiveSha256,
    tocSha256,
    sourceObjectContractSha256: input.sourceObjectContractSha256,
    sourceBindingSha256: sha256([
      "full-schema-restore-archive-source-binding-v1",
      archiveSha256,
      tocSha256,
      input.sourceObjectContractSha256,
    ].join("\n")),
    aclEntryCount: aclEntries.length,
    routineAclEntryCount,
  };
}

function positiveBound(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error("full-schema restore archive arguments are invalid");
  }
  return value;
}

function validCommand(value: string): string {
  if (value.length === 0 || value.includes("\0")) {
    throw new Error("full-schema restore archive arguments are invalid");
  }
  return value;
}

export async function runFullSchemaArchiveChild(input: Readonly<{
  command: string;
  args: readonly string[];
  environment: NodeJS.ProcessEnv;
  stdin?: Buffer;
  maxStdoutBytes: number;
  timeoutMs: number;
  controller: FullSchemaRestoreChildController;
  buildChildLaunch: FullSchemaRestoreBuildChildLaunch;
  spawnProcess?: SpawnProcess;
}>): Promise<FullSchemaArchiveChildResult> {
  const maxStdoutBytes = positiveBound(input.maxStdoutBytes);
  const timeoutMs = positiveBound(input.timeoutMs);
  const launch = input.buildChildLaunch({
    args: input.args.map(validCommand),
    command: validCommand(input.command),
    environment: input.environment,
  });
  const spawnProcess = input.spawnProcess ?? ((
    command,
    args,
    options,
  ) => spawn(command, [...args], options));
  const tracked = input.controller.spawnAndTrack(() => spawnProcess(
    launch.command,
    launch.args,
    {
      detached: process.platform !== "win32"
        && !launch.treeSupervised,
      env: launch.environment,
      stdio: ["pipe", "pipe", "pipe"] as const,
      windowsHide: true,
    },
  ));
  const { child } = tracked;
  const chunks: Buffer[] = [];
  let capturedBytes = 0;
  let failed = false;
  let settled = false;
  let resolveSettled: () => void = () => undefined;
  const childSettled = new Promise<void>((resolve) => {
    resolveSettled = resolve;
  });
  let requestTermination: () => void = () => undefined;
  const terminationRequested = new Promise<void>((resolve) => {
    requestTermination = () => {
      failed = true;
      resolve();
    };
  });
  const settle = () => {
    if (settled) return;
    settled = true;
    resolveSettled();
  };

  const captureStdout = (value: Buffer | string) => {
    const chunk = Buffer.isBuffer(value)
      ? value
      : Buffer.from(value, "utf8");
    const remaining = Math.max(0, maxStdoutBytes - capturedBytes);
    if (chunk.length > remaining) {
      if (remaining > 0) chunks.push(chunk.subarray(0, remaining));
      chunk.subarray(remaining).fill(0);
      capturedBytes = maxStdoutBytes;
      requestTermination();
      return;
    }
    chunks.push(chunk);
    capturedBytes += chunk.length;
  };
  let stdinErrorActive = true;
  const handleStdinError = () => {
    if (stdinErrorActive) requestTermination();
  };

  child.stdout.on("data", captureStdout);
  child.stdin.on("error", handleStdinError);
  child.stderr.resume();
  child.once("error", () => {
    failed = true;
    settle();
  });
  child.once("close", settle);

  try {
    if (input.stdin === undefined) child.stdin.end();
    else child.stdin.end(input.stdin);
  } catch {
    requestTermination();
  }

  const timer = setTimeout(() => {
    requestTermination();
  }, timeoutMs);
  try {
    await Promise.race([childSettled, terminationRequested]);
    await tracked.completeAndWait("SIGTERM");
    const stdout = Buffer.concat(chunks, capturedBytes);
    for (const chunk of chunks) chunk.fill(0);
    return {
      exitCode: child.exitCode,
      failed,
      signalCode: child.signalCode,
      stdout,
    };
  } catch {
    child.stdout.removeListener("data", captureStdout);
    for (const chunk of chunks) chunk.fill(0);
    for (const stream of [child.stdin, child.stdout, child.stderr]) {
      try {
        stream.destroy();
      } catch {
        // The fixed archive-child failure below remains authoritative.
      }
    }
    try {
      child.unref();
    } catch {
      // The fixed archive-child failure below remains authoritative.
    }
    throw new Error("full-schema restore archive child failed");
  } finally {
    stdinErrorActive = false;
    clearTimeout(timer);
  }
}

export function requireSuccessfulFullSchemaArchiveDump(
  result: FullSchemaArchiveChildResult,
): Buffer {
  if (
    result.failed
    || result.exitCode !== 0
    || result.signalCode !== null
    || result.stdout.length === 0
  ) {
    result.stdout.fill(0);
    throw new Error("full-schema restore dump failed");
  }
  return result.stdout;
}

export async function runFullSchemaArchiveDump(input: Readonly<{
  command: string;
  args: readonly string[];
  environment: NodeJS.ProcessEnv;
  maxStdoutBytes: number;
  timeoutMs: number;
  controller: FullSchemaRestoreChildController;
  buildChildLaunch: FullSchemaRestoreBuildChildLaunch;
}>): Promise<Buffer> {
  const result = await runFullSchemaArchiveChild(input);
  return requireSuccessfulFullSchemaArchiveDump(result);
}

export async function runFullSchemaArchiveList(input: Readonly<{
  command: string;
  args: readonly string[];
  environment: NodeJS.ProcessEnv;
  archive: Buffer;
  maxStdoutBytes: number;
  timeoutMs: number;
  controller: FullSchemaRestoreChildController;
  buildChildLaunch: FullSchemaRestoreBuildChildLaunch;
}>): Promise<Buffer> {
  const result = await runFullSchemaArchiveChild({
    command: input.command,
    args: input.args,
    environment: input.environment,
    stdin: input.archive,
    maxStdoutBytes: input.maxStdoutBytes,
    timeoutMs: input.timeoutMs,
    controller: input.controller,
    buildChildLaunch: input.buildChildLaunch,
  });
  if (
    result.failed
    || result.exitCode !== 0
    || result.signalCode !== null
    || result.stdout.length === 0
  ) {
    result.stdout.fill(0);
    throw new Error("full-schema restore archive list failed");
  }
  return result.stdout;
}

export async function runFullSchemaArchiveRestore(input: Readonly<{
  command: string;
  args: readonly string[];
  environment: NodeJS.ProcessEnv;
  archive: Buffer;
  maxStdoutBytes: number;
  timeoutMs: number;
  controller: FullSchemaRestoreChildController;
  buildChildLaunch: FullSchemaRestoreBuildChildLaunch;
}>): Promise<void> {
  const result = await runFullSchemaArchiveChild({
    command: input.command,
    args: input.args,
    environment: input.environment,
    stdin: input.archive,
    maxStdoutBytes: input.maxStdoutBytes,
    timeoutMs: input.timeoutMs,
    controller: input.controller,
    buildChildLaunch: input.buildChildLaunch,
  });
  result.stdout.fill(0);
  if (
    result.failed
    || result.exitCode !== 0
    || result.signalCode !== null
  ) {
    throw new Error("full-schema restore archive restore failed");
  }
}
