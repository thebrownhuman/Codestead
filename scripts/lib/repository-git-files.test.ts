import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import {
  decodeGitPathList,
  deduplicateGitTrackedPaths,
  resolveTrackedRegularRepositoryFile,
  tryListGitTrackedRepositoryPaths,
} from "./repository-git-files";

const temporaryDirectories: string[] = [];
const execFileAsync = promisify(execFile);

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((root) => rm(root, { force: true, recursive: true })),
  );
});

describe("Git repository path identity", () => {
  it("preserves backslashes emitted as literal Git pathname bytes", () => {
    expect(
      decodeGitPathList(Buffer.from("ordinary.txt\0literal\\name.txt\0", "utf8")),
    ).toEqual(["ordinary.txt", "literal\\name.txt"]);
  });

  it("fails closed when Git emits a pathname that is not valid UTF-8", () => {
    expect(() =>
      decodeGitPathList(Buffer.from([0x62, 0x61, 0x64, 0xff, 0x00])),
    ).toThrow(/valid UTF-8/u);
  });

  it("deduplicates tracked paths case-insensitively on Windows only", () => {
    expect(
      deduplicateGitTrackedPaths(["Src/File.ts", "src/file.ts"], "win32"),
    ).toEqual(["Src/File.ts"]);
    expect(
      deduplicateGitTrackedPaths(["Src/File.ts", "src/file.ts"], "linux"),
    ).toEqual(["Src/File.ts", "src/file.ts"]);
  });

  it("refuses to traverse a symlink while resolving a tracked file", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "codestead-git-path-"));
    temporaryDirectories.push(root);
    const outside = await mkdtemp(path.join(tmpdir(), "codestead-git-path-outside-"));
    temporaryDirectories.push(outside);
    await writeFile(path.join(outside, "secret.txt"), "outside\n", "utf8");
    await mkdir(path.join(root, "safe"));
    await symlink(outside, path.join(root, "safe", "link"), "junction");

    await expect(
      resolveTrackedRegularRepositoryFile(root, "safe/link/secret.txt"),
    ).rejects.toThrow(/symbolic link/u);
  });

  it("treats a nested scan root as Git-free instead of trusting its ancestor", async () => {
    const repository = await mkdtemp(path.join(tmpdir(), "codestead-git-parent-"));
    temporaryDirectories.push(repository);
    await execFileAsync("git", ["init", "--quiet", repository]);
    const nestedRoot = path.join(repository, "archive");
    await mkdir(nestedRoot);

    await expect(tryListGitTrackedRepositoryPaths(nestedRoot)).resolves.toBeNull();
  });

  it("rethrows exit 128 errors that are not the exact no-repository error", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "codestead-invalid-gitfile-"));
    temporaryDirectories.push(root);
    await writeFile(path.join(root, ".git"), "not a valid gitfile\n", "utf8");

    await expect(tryListGitTrackedRepositoryPaths(root)).rejects.toMatchObject({
      code: 128,
    });
  });
});
