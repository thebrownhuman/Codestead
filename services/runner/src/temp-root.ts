import {
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  rmSync,
  type Stats,
} from "node:fs";
import path from "node:path";
import { RunnerError } from "./errors.js";

function unsafe(message: string): never {
  throw new RunnerError(
    "INFRASTRUCTURE_ERROR",
    `runner temporary root ${message}`,
    500,
    true,
  );
}

function verifyOwnedPrivate(stats: Stats, name: string): void {
  if (process.platform === "win32") {
    return;
  }
  if ((stats.mode & 0o022) !== 0) {
    unsafe(`${name} grants group or other write access`);
  }
  const uid = process.getuid?.();
  if (uid !== undefined && stats.uid !== uid) {
    unsafe(`${name} is not owned by the runner user`);
  }
}

function verifyTree(candidate: string): void {
  const stats = lstatSync(candidate);
  if (stats.isSymbolicLink()) {
    unsafe("contains a symlink in a stale job directory");
  }
  verifyOwnedPrivate(stats, "stale job entry");
  if (stats.isFile()) {
    return;
  }
  if (!stats.isDirectory()) {
    unsafe("contains a non-file entry in a stale job directory");
  }
  for (const entry of readdirSync(candidate)) {
    verifyTree(path.join(candidate, entry));
  }
}

export function prepareRunnerTempRoot(tempRoot: string): number {
  const root = path.resolve(tempRoot);
  if (path.dirname(root) === root) {
    unsafe("must not be a filesystem root");
  }
  try {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const rootStats = lstatSync(root);
    if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
      unsafe("must be a directory, not a symlink");
    }
    if (
      process.platform !== "win32" &&
      (rootStats.mode & 0o7777) !== 0o700
    ) {
      unsafe("permissions must be 700");
    }
    verifyOwnedPrivate(rootStats, "directory");

    let removed = 0;
    for (const entry of readdirSync(root)) {
      if (!entry.startsWith("job-")) {
        continue;
      }
      const candidate = path.join(root, entry);
      const relative = path.relative(root, candidate);
      if (
        relative.startsWith("..") ||
        path.isAbsolute(relative) ||
        relative.includes(path.sep)
      ) {
        unsafe("contains an invalid stale job path");
      }
      const stats = lstatSync(candidate);
      if (!stats.isDirectory() || stats.isSymbolicLink()) {
        unsafe("job-* entries must be owned directories, not symlinks");
      }
      verifyOwnedPrivate(stats, "stale job directory");
      verifyTree(candidate);
      rmSync(candidate, { recursive: true, force: false });
      removed += 1;
    }
    if (removed > 0 && process.platform !== "win32") {
      const descriptor = openSync(
        root,
        constants.O_RDONLY | (constants.O_DIRECTORY ?? 0),
      );
      try {
        fsyncSync(descriptor);
      } finally {
        closeSync(descriptor);
      }
    }
    return removed;
  } catch (error) {
    if (error instanceof RunnerError) {
      throw error;
    }
    return unsafe("could not be prepared safely");
  }
}
