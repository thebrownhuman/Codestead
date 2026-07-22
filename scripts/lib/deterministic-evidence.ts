import { randomUUID } from "node:crypto";
import type { BigIntStats } from "node:fs";
import { lstat, open, realpath, rename, rm } from "node:fs/promises";
import path from "node:path";

export type DeterministicEvidenceMode = "apply" | "check";

export interface DeterministicEvidenceInvocation {
  readonly mode: DeterministicEvidenceMode;
  readonly target: string;
}

export interface DeterministicEvidenceOptions<T> {
  readonly argv?: readonly string[];
  readonly root?: string;
  readonly relativePath: string;
  readonly buildEvidence: (generatedAt: string) => T;
  readonly applyCommand: string;
  /** Caller asserts docs/evidence is controlled by one trusted build writer. */
  readonly trustedDirectory: "exclusive-writer";
  readonly allowArgument?: (argument: string) => boolean;
  readonly allowOutputOverride?: boolean;
  readonly now?: () => Date;
}

interface TargetIdentity {
  readonly device: bigint;
  readonly inode: bigint;
  readonly modifiedNs: bigint;
  readonly size: bigint;
}

interface DirectoryIdentity {
  readonly device: bigint;
  readonly inode: bigint;
}

interface SafeEvidenceTarget {
  readonly path: string;
  readonly identity: TargetIdentity | null;
  readonly directoryPath: string;
  readonly directoryRealPath: string;
  readonly directoryIdentity: DirectoryIdentity;
}

const canonicalTimestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function serialized(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function validGeneratedAt(value: unknown): value is string {
  if (typeof value !== "string" || !canonicalTimestamp.test(value)) return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

function identityOf(stats: BigIntStats): TargetIdentity {
  return {
    device: stats.dev,
    inode: stats.ino,
    modifiedNs: stats.mtimeNs,
    size: stats.size,
  };
}

function directoryIdentityOf(stats: BigIntStats): DirectoryIdentity {
  return { device: stats.dev, inode: stats.ino };
}

function sameDirectoryIdentity(left: DirectoryIdentity, right: DirectoryIdentity): boolean {
  return left.device === right.device && left.inode === right.inode;
}

function sameIdentity(left: TargetIdentity | null, right: TargetIdentity | null): boolean {
  if (left === null || right === null) return left === right;
  return left.device === right.device
    && left.inode === right.inode
    && left.modifiedNs === right.modifiedNs
    && left.size === right.size;
}

async function regularFileIdentity(target: string): Promise<TargetIdentity | null> {
  const stats = await lstat(target, { bigint: true }).catch((error: unknown) => {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    if (code === "ENOENT") return null;
    throw error;
  });
  if (stats === null) return null;
  if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1n) {
    throw new Error(`Evidence target must be a single-link regular file: ${target}`);
  }
  return identityOf(stats);
}

async function evidenceTarget(
  root: string,
  relativePath: string,
  outputOverride: string | undefined,
): Promise<SafeEvidenceTarget> {
  const evidenceRoot = path.resolve(root, "docs", "evidence");
  const evidenceRootStats = await lstat(evidenceRoot, { bigint: true });
  if (!evidenceRootStats.isDirectory() || evidenceRootStats.isSymbolicLink()) {
    throw new Error("docs/evidence must be a real directory, not a symlink.");
  }
  const expectedEvidenceRoot = await realpath(evidenceRoot);
  const target = path.resolve(root, outputOverride ?? relativePath);
  const targetParent = await realpath(path.dirname(target));
  if (targetParent !== expectedEvidenceRoot || path.extname(target).toLowerCase() !== ".json") {
    throw new Error("Evidence output must be a direct .json child of docs/evidence.");
  }
  return {
    path: target,
    identity: await regularFileIdentity(target),
    directoryPath: evidenceRoot,
    directoryRealPath: expectedEvidenceRoot,
    directoryIdentity: directoryIdentityOf(evidenceRootStats),
  };
}

async function assertEvidenceDirectoryUnchanged(target: SafeEvidenceTarget): Promise<void> {
  const stats = await lstat(target.directoryPath, { bigint: true }).catch(() => null);
  const actualRealPath = stats === null ? null : await realpath(target.directoryPath).catch(() => null);
  if (
    stats === null
    || !stats.isDirectory()
    || stats.isSymbolicLink()
    || actualRealPath !== target.directoryRealPath
    || !sameDirectoryIdentity(target.directoryIdentity, directoryIdentityOf(stats))
  ) {
    throw new Error(`Evidence directory changed during verification: ${target.directoryPath}`);
  }
}

export async function verifyOrApplyDeterministicEvidence<T>(
  options: DeterministicEvidenceOptions<T>,
): Promise<DeterministicEvidenceInvocation> {
  const argv = options.argv ?? process.argv.slice(2);
  const root = options.root ?? process.cwd();
  const applyCount = argv.filter((argument) => argument === "--apply").length;
  const checkCount = argv.filter((argument) => argument === "--check").length;
  const outputArguments = argv.filter((argument) => argument.startsWith("--output="));
  const unknown = argv.filter((argument) => (
    argument !== "--apply"
    && argument !== "--check"
    && !argument.startsWith("--output=")
    && !options.allowArgument?.(argument)
  ));
  if (applyCount > 1 || checkCount > 1 || (applyCount && checkCount) || outputArguments.length > 1 || unknown.length) {
    throw new Error("Choose at most one evidence mode (--check or --apply) and provide only supported arguments.");
  }
  const mode: DeterministicEvidenceMode = applyCount === 1 ? "apply" : "check";
  if (mode === "apply" && options.trustedDirectory !== "exclusive-writer") {
    throw new Error("Apply requires an exclusive trusted evidence directory; portable Node cannot provide openat/renameat namespace isolation.");
  }
  const outputOverride = outputArguments[0]?.slice("--output=".length);
  if (outputOverride !== undefined && (!options.allowOutputOverride || mode !== "apply" || outputOverride.length === 0)) {
    throw new Error("--output is supported only together with --apply for this evidence generator.");
  }
  const safeTarget = await evidenceTarget(root, options.relativePath, outputOverride);
  const target = safeTarget.path;

  if (mode === "check") {
    let before: string;
    let targetHandle: Awaited<ReturnType<typeof open>> | null = null;
    try {
      targetHandle = await open(target, "r");
      const openedStats = await targetHandle.stat({ bigint: true });
      if (!openedStats.isFile() || openedStats.nlink !== 1n) {
        throw new Error(`Evidence target must be a single-link regular file: ${target}`);
      }
      const openedIdentity = identityOf(openedStats);
      if (!sameIdentity(safeTarget.identity, openedIdentity)) {
        throw new Error(`Evidence artifact changed before verification: ${target}`);
      }
      before = await targetHandle.readFile({ encoding: "utf8" });
      const afterHandleRead = identityOf(await targetHandle.stat({ bigint: true }));
      if (!sameIdentity(openedIdentity, afterHandleRead)) {
        throw new Error(`Evidence artifact changed during verification: ${target}`);
      }
    } catch (error: unknown) {
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
      if (code === "ENOENT") {
        throw new Error(`Missing evidence artifact ${target}; regenerate it with ${options.applyCommand}.`);
      }
      throw error;
    } finally {
      await targetHandle?.close();
    }
    let stored: unknown;
    try {
      stored = JSON.parse(before) as unknown;
    } catch {
      throw new Error(`Malformed evidence artifact ${target}; regenerate it with ${options.applyCommand}.`);
    }
    const generatedAt = stored && typeof stored === "object" && "generatedAt" in stored
      ? (stored as { readonly generatedAt?: unknown }).generatedAt
      : undefined;
    if (!validGeneratedAt(generatedAt)) {
      throw new Error(`Evidence artifact ${target} has an invalid generatedAt; regenerate it with ${options.applyCommand}.`);
    }
    const expected = serialized(options.buildEvidence(generatedAt));
    if (before !== expected) {
      throw new Error(`Stale evidence artifact ${target}; regenerate it with ${options.applyCommand}.`);
    }
    const afterRead = await regularFileIdentity(target);
    if (!sameIdentity(safeTarget.identity, afterRead)) {
      throw new Error(`Evidence artifact changed during verification: ${target}`);
    }
    return { mode, target };
  }

  const now = (options.now ?? (() => new Date()))();
  const generatedAt = now.toISOString();
  if (!validGeneratedAt(generatedAt)) throw new Error("Evidence clock did not produce a canonical UTC timestamp.");
  const bytes = serialized(options.buildEvidence(generatedAt));
  await assertEvidenceDirectoryUnchanged(safeTarget);
  const staging = path.join(path.dirname(target), `.${path.basename(target)}.staging-${process.pid}-${randomUUID()}`);
  let stagingIdentity: TargetIdentity | null = null;
  try {
    const stagingHandle = await open(staging, "wx", 0o600);
    try {
      const openedStats = await stagingHandle.stat({ bigint: true });
      if (!openedStats.isFile() || openedStats.nlink !== 1n) {
        throw new Error(`Evidence staging target must be a single-link regular file: ${staging}`);
      }
      const openedIdentity = identityOf(openedStats);
      await assertEvidenceDirectoryUnchanged(safeTarget);
      const openedPathIdentity = await regularFileIdentity(staging);
      if (!sameIdentity(openedIdentity, openedPathIdentity)) {
        throw new Error(`Evidence staging path changed before write: ${staging}`);
      }
      await stagingHandle.writeFile(bytes, { encoding: "utf8" });
      await stagingHandle.sync();
      const writtenStats = await stagingHandle.stat({ bigint: true });
      if (!writtenStats.isFile() || writtenStats.nlink !== 1n) {
        throw new Error(`Evidence staging target changed during write: ${staging}`);
      }
      stagingIdentity = identityOf(writtenStats);
    } finally {
      await stagingHandle.close();
    }
    await assertEvidenceDirectoryUnchanged(safeTarget);
    const stagedPathIdentity = await regularFileIdentity(staging);
    if (!sameIdentity(stagingIdentity, stagedPathIdentity)) {
      throw new Error(`Evidence staging path changed after write: ${staging}`);
    }
    const beforeRename = await regularFileIdentity(target);
    if (!sameIdentity(safeTarget.identity, beforeRename)) {
      throw new Error(`Evidence artifact changed during apply: ${target}`);
    }
    await rename(staging, target);
    await assertEvidenceDirectoryUnchanged(safeTarget);
    const afterRename = await regularFileIdentity(target);
    if (stagingIdentity === null || !sameIdentity(stagingIdentity, afterRename)) {
      throw new Error(`Evidence artifact identity changed after apply: ${target}`);
    }
  } finally {
    await rm(staging, { force: true }).catch(() => undefined);
  }
  return { mode, target };
}
