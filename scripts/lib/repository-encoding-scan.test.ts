import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { scanRepositoryForMojibake } from "./repository-encoding-scan";

const execFileAsync = promisify(execFile);
const temporaryRepositories: string[] = [];

async function temporaryRepository() {
  const root = await mkdtemp(path.join(tmpdir(), "codestead-encoding-scan-"));
  temporaryRepositories.push(root);
  await execFileAsync("git", ["init", "--quiet", root]);
  return root;
}

afterEach(async () => {
  await Promise.all(
    temporaryRepositories.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

describe("repository encoding scan file selection", () => {
  it("ignores an untracked artifact root but scans a nested source directory", async () => {
    const root = await temporaryRepository();
    await mkdir(path.join(root, "test-artifacts"));
    await writeFile(path.join(root, "test-artifacts", "generated.txt"), "\uFFFD\n", "utf8");
    await mkdir(path.join(root, "src", "test-artifacts"), { recursive: true });
    await writeFile(path.join(root, "src", "test-artifacts", "source.txt"), "\uFFFD\n", "utf8");

    await expect(scanRepositoryForMojibake(root)).resolves.toEqual([
      "src/test-artifacts/source.txt:1",
    ]);
  });

  it("scans a force-tracked file inside a generated artifact root", async () => {
    const root = await temporaryRepository();
    await mkdir(path.join(root, "playwright-report"));
    await writeFile(path.join(root, "playwright-report", "tracked.txt"), "\uFFFD\n", "utf8");
    await execFileAsync("git", [
      "-C",
      root,
      "add",
      "--force",
      "playwright-report/tracked.txt",
    ]);

    await expect(scanRepositoryForMojibake(root)).resolves.toEqual([
      "playwright-report/tracked.txt:1",
    ]);
  });
  it.each(["coverage", "node_modules", ".next", ".next-e2e-3100"])(
    "rescans a tracked candidate inside excluded root %s",
    async (directoryName) => {
      const root = await temporaryRepository();
      const directory = path.join(root, directoryName);
      await mkdir(directory, { recursive: true });
      const relativePath = `${directoryName}/tracked.txt`;
      await writeFile(path.join(root, ...relativePath.split("/")), "\uFFFD\n", "utf8");
      await execFileAsync("git", ["-C", root, "add", "--force", relativePath]);

      await expect(scanRepositoryForMojibake(root)).resolves.toEqual([
        `${relativePath}:1`,
      ]);
    },
  );

  it("scans a Git-free source archive", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "codestead-encoding-archive-"));
    temporaryRepositories.push(root);
    await writeFile(path.join(root, "README.md"), "\uFFFD\n", "utf8");

    await expect(scanRepositoryForMojibake(root)).resolves.toEqual([
      "README.md:1",
    ]);
  });

  it.each([
    "module.mts",
    "terraform.tfvars",
    "codestead.service",
    "codestead.timer",
    "worker.py",
    "backup.sh",
    "Dockerfile",
  ])("scans text candidate %s", async (relativePath) => {
    const root = await temporaryRepository();
    await writeFile(path.join(root, relativePath), "\uFFFD\n", "utf8");

    await expect(scanRepositoryForMojibake(root)).resolves.toEqual([
      `${relativePath}:1`,
    ]);
  });

  it("scans beyond the former two-mebibyte boundary", async () => {
    const root = await temporaryRepository();
    const prefix = `${"x".repeat(2 * 1024 * 1024 + 32)}\n`;
    await writeFile(path.join(root, "large.txt"), `${prefix}\uFFFD\n`, "utf8");

    await expect(scanRepositoryForMojibake(root)).resolves.toEqual([
      "large.txt:2",
    ]);
  });

  it.each(["\u00e2\u201a\u00ac", "\u00f0\u0178\u02dc\u20ac"])(
    "detects common mojibake sequence %s",
    async (sequence) => {
      const root = await temporaryRepository();
      await writeFile(path.join(root, "source.txt"), `${sequence}\n`, "utf8");

      await expect(scanRepositoryForMojibake(root)).resolves.toEqual([
        "source.txt:1",
      ]);
    },
  );

  it("hashes a potentially secret-bearing filename in failures", async () => {
    const pathCanary = ["nvapi", "-", "O".repeat(40)].join("");
    const root = await temporaryRepository();
    await writeFile(path.join(root, `${pathCanary}.txt`), "\uFFFD\n", "utf8");

    const failures = await scanRepositoryForMojibake(root);

    expect(failures).toEqual([
      expect.stringMatching(/^\[redacted-path:sha256:[a-f0-9]{16}\]:1$/u),
    ]);
    expect(JSON.stringify(failures)).not.toContain(pathCanary);
  });

  it("ignores .git metadata files below an archive root", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "codestead-encoding-dot-git-"));
    temporaryRepositories.push(root);
    const metadata = path.join(root, "metadata");
    await mkdir(metadata);
    await writeFile(path.join(metadata, ".git"), "\uFFFD\n", "utf8");
    await writeFile(path.join(root, "source.txt"), "ordinary\n", "utf8");

    await expect(scanRepositoryForMojibake(root)).resolves.toEqual([]);
  });

  it("does not follow an untracked directory symlink", async () => {
    const root = await temporaryRepository();
    const outside = await mkdtemp(path.join(tmpdir(), "codestead-encoding-outside-"));
    temporaryRepositories.push(outside);
    await writeFile(path.join(outside, "source.txt"), "\uFFFD\n", "utf8");
    await symlink(outside, path.join(root, "linked"), "junction");

    await expect(scanRepositoryForMojibake(root)).resolves.toEqual([]);
  });
  it("keeps generated and dependency roots excluded in a Git-free archive", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "codestead-encoding-archive-skips-"));
    temporaryRepositories.push(root);
    for (const directoryName of [
      "coverage",
      "dist",
      "node_modules",
      "playwright-report",
      "test-artifacts",
      "test-results",
      ".next",
      ".next-e2e-3100",
    ]) {
      const directory = path.join(root, directoryName);
      await mkdir(directory);
      await writeFile(path.join(directory, "ignored.txt"), "\uFFFD\n", "utf8");
    }
    await mkdir(path.join(root, "src"));
    await writeFile(path.join(root, "src", "source.txt"), "\uFFFD\n", "utf8");

    await expect(scanRepositoryForMojibake(root)).resolves.toEqual([
      "src/source.txt:1",
    ]);
  });

  it("fails closed when an indexed regular file is missing", async () => {
    const root = await temporaryRepository();
    const trackedPath = path.join(root, "missing.txt");
    await writeFile(trackedPath, "ordinary\n", "utf8");
    await execFileAsync("git", ["-C", root, "add", "missing.txt"]);
    await rm(trackedPath);

    await expect(scanRepositoryForMojibake(root)).rejects.toThrow(
      /missing or is not a regular file/u,
    );
  });

});
