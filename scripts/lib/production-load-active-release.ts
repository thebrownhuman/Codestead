import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { TextDecoder } from "node:util";

export const PRODUCTION_LOAD_ACTIVE_RELEASE_PATH =
  "/etc/learncoding/active-release.env";

export type ProductionLoadActiveReleaseArtifact = {
  readonly path: string;
  readonly byteLength: number;
  readonly sha256: string;
  readonly text: string;
};

export type ReadProductionLoadActiveReleaseOptions = {
  readonly activeReleasePath?: string;
  readonly requiredOwnerUid?: number;
  readonly requiredMode?: number | null;
};

const maximumActiveReleaseBytes = 64 * 1024;

function fail(code: string): never {
  throw new Error(`Production load active release failed: ${code}`);
}

function sameSnapshot(
  left: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number },
  right: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number },
): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

export async function readProductionLoadActiveRelease(
  options: ReadProductionLoadActiveReleaseOptions = {},
): Promise<ProductionLoadActiveReleaseArtifact> {
  const activeReleasePath = path.resolve(
    options.activeReleasePath ?? PRODUCTION_LOAD_ACTIVE_RELEASE_PATH,
  );
  if (!path.isAbsolute(activeReleasePath)
    || activeReleasePath === path.parse(activeReleasePath).root) {
    fail("invalid_path");
  }
  if (process.platform !== "win32") {
    let parent: string;
    try {
      parent = await realpath(path.dirname(activeReleasePath));
    } catch {
      fail("unsafe_file");
    }
    if (parent !== path.dirname(activeReleasePath)) fail("unsafe_file");
  }
  let metadata;
  try {
    metadata = await lstat(activeReleasePath);
  } catch {
    fail("unsafe_file");
  }
  const requiredMode = options.requiredMode === undefined
    ? (process.platform === "win32" ? null : 0o644)
    : options.requiredMode;
  const requiredOwnerUid = options.requiredOwnerUid === undefined && process.platform !== "win32"
    ? 0
    : options.requiredOwnerUid;
  if (metadata.isSymbolicLink()
    || !metadata.isFile()
    || metadata.nlink !== 1
    || (requiredMode !== null && (metadata.mode & 0o777) !== requiredMode)
    || (requiredOwnerUid !== undefined && metadata.uid !== requiredOwnerUid)
    || metadata.size <= 0
    || metadata.size > maximumActiveReleaseBytes) {
    fail("unsafe_file");
  }
  const noFollow = process.platform === "win32" ? 0 : (constants.O_NOFOLLOW ?? 0);
  let bytes: Buffer;
  try {
    const handle = await open(activeReleasePath, constants.O_RDONLY | noFollow);
    try {
      const before = await handle.stat();
      if (!sameSnapshot(metadata, before)) fail("file_changed");
      bytes = await handle.readFile();
      const after = await handle.stat();
      if (!sameSnapshot(before, after) || bytes.byteLength !== after.size) {
        fail("file_changed");
      }
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error instanceof Error
      && error.message.startsWith("Production load active release failed:")) {
      throw error;
    }
    fail("unsafe_file");
  }
  if (bytes.byteLength <= 0
    || bytes.byteLength > maximumActiveReleaseBytes
    || bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))) {
    fail("invalid_bytes");
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail("invalid_bytes");
  }
  if (!text.endsWith("\n") || text.includes("\r") || text.includes("\0")) {
    fail("invalid_bytes");
  }
  return {
    path: activeReleasePath,
    byteLength: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    text,
  };
}

export async function assertProductionLoadActiveReleaseUnchanged(
  artifact: ProductionLoadActiveReleaseArtifact,
  options: ReadProductionLoadActiveReleaseOptions = {},
): Promise<void> {
  const current = await readProductionLoadActiveRelease(options);
  if (current.path !== artifact.path
    || current.byteLength !== artifact.byteLength
    || current.sha256 !== artifact.sha256) {
    fail("active_release_changed");
  }
}
