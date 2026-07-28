import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { TextDecoder } from "node:util";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

class GitScanRootMismatchError extends Error {}

interface GitCommandError extends Error {
  readonly code?: string | number;
  readonly stderr?: Buffer | string;
}
const sensitivePathPattern =
  /(?:nvapi-|gh[pousr]_|sk-(?:proj-)?|AKIA[A-Z0-9]{16}|xox[baprs]-|(?:password|token|secret|api[_-]?key)[=_-][^/\\]{8,}|[A-Za-z0-9+_=-]{40,})/iu;

export function normalizeRepositoryPath(value: string): string {
  return path.sep === "\\" ? value.replaceAll("\\", "/") : value;
}

export function repositoryPathIdentityKey(
  value: string,
  platform: NodeJS.Platform = process.platform,
): string {
  return platform === "win32" ? value.toLowerCase() : value;
}

export function deduplicateGitTrackedPaths(
  values: readonly string[],
  platform: NodeJS.Platform = process.platform,
): readonly string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const identity = repositoryPathIdentityKey(value, platform);
    if (seen.has(identity)) continue;
    seen.add(identity);
    result.push(value);
  }
  return result;
}

export function decodeGitPathList(stdout: Buffer): readonly string[] {
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(stdout);
  } catch {
    throw new Error("Git tracked pathname output is not valid UTF-8.");
  }
  if (decoded.length > 0 && !decoded.endsWith("\0")) {
    throw new Error("Git tracked pathname output was truncated.");
  }
  return deduplicateGitTrackedPaths(decoded.split("\0").filter(Boolean));
}

function decodeGitText(output: Buffer, label: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(output);
  } catch {
    throw new Error(`${label} is not valid UTF-8.`);
  }
}

function decodeGitTopLevel(stdout: Buffer): string {
  const decoded = decodeGitText(stdout, "Git top-level output");
  const withoutLineFeed = decoded.endsWith("\n") ? decoded.slice(0, -1) : decoded;
  const topLevel = withoutLineFeed.endsWith("\r")
    ? withoutLineFeed.slice(0, -1)
    : withoutLineFeed;
  if (topLevel.length === 0 || /[\r\n]/u.test(topLevel)) {
    throw new Error("Git top-level output is ambiguous.");
  }
  return topLevel;
}

async function assertCanonicalGitTopLevel(root: string): Promise<void> {
  const { stdout } = await execFileAsync(
    "git",
    ["-C", root, "rev-parse", "--show-toplevel"],
    { encoding: "buffer", maxBuffer: 1024 * 1024 },
  );
  const topLevel = decodeGitTopLevel(stdout);
  const [canonicalRoot, canonicalTopLevel] = await Promise.all([
    realpath(root),
    realpath(topLevel),
  ]);
  if (
    repositoryPathIdentityKey(path.normalize(canonicalRoot)) !==
    repositoryPathIdentityKey(path.normalize(canonicalTopLevel))
  ) {
    throw new GitScanRootMismatchError(
      "The supplied scan root is not the Git top-level directory.",
    );
  }
}

function isExactNoRepositoryError(error: GitCommandError): boolean {
  if (error.code !== 128 || error.stderr === undefined) return false;
  const stderr = Buffer.isBuffer(error.stderr)
    ? decodeGitText(error.stderr, "Git standard error")
    : error.stderr;
  return (
    stderr.replace(/\r?\n$/u, "") ===
    "fatal: not a git repository (or any of the parent directories): .git"
  );
}
export function repositoryFindingPath(relativePath: string): string {
  if (!sensitivePathPattern.test(relativePath)) return relativePath;
  const digest = createHash("sha256").update(relativePath, "utf8").digest("hex");
  return `[redacted-path:sha256:${digest.slice(0, 16)}]`;
}

export function isGitMetadataPath(relativePath: string): boolean {
  const normalized = normalizeRepositoryPath(relativePath).replace(/^(?:\.\/)+/u, "");
  return normalized.split("/").some((segment) => segment.toLowerCase() === ".git");
}

export async function listGitTrackedRepositoryPaths(
  root: string,
): Promise<ReadonlySet<string>> {
  await assertCanonicalGitTopLevel(root);
  const { stdout } = await execFileAsync(
    "git",
    ["-C", root, "ls-files", "--cached", "-z"],
    { encoding: "buffer", maxBuffer: 64 * 1024 * 1024 },
  );
  return new Set(decodeGitPathList(stdout));
}

export async function tryListGitTrackedRepositoryPaths(
  root: string,
): Promise<ReadonlySet<string> | null> {
  try {
    return await listGitTrackedRepositoryPaths(root);
  } catch (error) {
    if (error instanceof GitScanRootMismatchError) return null;
    const gitError = error as GitCommandError;
    if (gitError.code === "ENOENT" || isExactNoRepositoryError(gitError)) {
      return null;
    }
    throw error;
  }
}

export async function resolveTrackedRegularRepositoryFile(
  root: string,
  relativePath: string,
): Promise<string> {
  const segments = relativePath.split("/");
  if (
    relativePath.length === 0 ||
    relativePath.startsWith("/") ||
    /^[A-Za-z]:\//u.test(relativePath) ||
    relativePath.includes("\0") ||
    (process.platform === "win32" && relativePath.includes("\\")) ||
    segments.some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new Error(`Unsafe Git-tracked repository path: ${repositoryFindingPath(relativePath)}`);
  }

  let absolute = root;
  for (const [index, segment] of segments.entries()) {
    absolute = path.join(absolute, segment);
    let metadata;
    try {
      metadata = await lstat(absolute);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(
          `Git-tracked path is missing or is not a regular file: ${repositoryFindingPath(relativePath)}`,
        );
      }
      throw new Error(
        `Unable to inspect Git-tracked repository path: ${repositoryFindingPath(relativePath)}`,
      );
    }
    if (metadata.isSymbolicLink()) {
      throw new Error(
        `Refusing to traverse symbolic link for Git-tracked path: ${repositoryFindingPath(relativePath)}`,
      );
    }
    const leaf = index === segments.length - 1;
    if (leaf) {
      if (metadata.isFile()) return absolute;
      throw new Error(
        `Git-tracked path is missing or is not a regular file: ${repositoryFindingPath(relativePath)}`,
      );
    }
    if (!metadata.isDirectory()) {
      throw new Error(
        `Git-tracked path is missing or is not a regular file: ${repositoryFindingPath(relativePath)}`,
      );
    }
  }

  throw new Error(
    `Git-tracked path is missing or is not a regular file: ${repositoryFindingPath(relativePath)}`,
  );
}

interface DecoderSelection {
  readonly decoder: TextDecoder;
  readonly offset: number;
}

function selectTextDecoder(prefix: Buffer): DecoderSelection {
  if (prefix.length >= 3 && prefix[0] === 0xef && prefix[1] === 0xbb && prefix[2] === 0xbf) {
    return { decoder: new TextDecoder("utf-8", { fatal: true }), offset: 3 };
  }
  if (prefix.length >= 2 && prefix[0] === 0xff && prefix[1] === 0xfe) {
    return { decoder: new TextDecoder("utf-16le", { fatal: true }), offset: 2 };
  }
  if (prefix.length >= 2 && prefix[0] === 0xfe && prefix[1] === 0xff) {
    return { decoder: new TextDecoder("utf-16be", { fatal: true }), offset: 2 };
  }
  return { decoder: new TextDecoder("utf-8", { fatal: true }), offset: 0 };
}

export async function visitDecodedTextLines(
  absolutePath: string,
  relativePath: string,
  visitor: (line: string, lineNumber: number) => void,
): Promise<void> {
  let prefix = Buffer.alloc(0);
  let decoder: TextDecoder | null = null;
  let pendingText = "";
  let lineNumber = 0;

  const appendDecodedText = (decoded: string) => {
    pendingText += decoded;
    let newlineIndex = pendingText.indexOf("\n");
    while (newlineIndex >= 0) {
      const rawLine = pendingText.slice(0, newlineIndex);
      lineNumber += 1;
      visitor(rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine, lineNumber);
      pendingText = pendingText.slice(newlineIndex + 1);
      newlineIndex = pendingText.indexOf("\n");
    }
  };

  try {
    for await (const rawChunk of createReadStream(absolutePath)) {
      let chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
      if (decoder === null) {
        prefix = Buffer.concat([prefix, chunk]);
        if (prefix.length < 3) continue;
        const selection = selectTextDecoder(prefix);
        decoder = selection.decoder;
        chunk = prefix.subarray(selection.offset);
        prefix = Buffer.alloc(0);
      }
      appendDecodedText(decoder.decode(chunk, { stream: true }));
    }

    if (decoder === null) {
      const selection = selectTextDecoder(prefix);
      decoder = selection.decoder;
      appendDecodedText(decoder.decode(prefix.subarray(selection.offset), { stream: true }));
    }
    appendDecodedText(decoder.decode());
    if (pendingText.length > 0) {
      lineNumber += 1;
      visitor(
        pendingText.endsWith("\r") ? pendingText.slice(0, -1) : pendingText,
        lineNumber,
      );
    }
  } catch {
    throw new Error(
      `Unable to safely decode repository text candidate: ${repositoryFindingPath(relativePath)}`,
    );
  }
}
