import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { scanRepositoryForSecrets } from "./repository-secret-scan";

const execFileAsync = promisify(execFile);
const temporaryRepositories: string[] = [];

async function temporaryRepository() {
  const root = await mkdtemp(path.join(tmpdir(), "codestead-secret-scan-"));
  temporaryRepositories.push(root);
  await execFileAsync("git", ["init", "--quiet", root]);
  await writeFile(path.join(root, ".gitignore"), ".env\n.env.*\n", "utf8");
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryRepositories.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("repository secret scan file selection", () => {
  it("scans a force-tracked environment file and returns redacted metadata", async () => {
    const root = await temporaryRepository();
    const canary = ["nvapi", "-", "A".repeat(40)].join("");
    await writeFile(path.join(root, ".env.production"), `NVIDIA_API_KEY=${canary}\n`, "utf8");
    await execFileAsync("git", ["-C", root, "add", "--force", ".env.production"]);

    const findings = await scanRepositoryForSecrets(root);

    expect(findings).toEqual([
      { path: ".env.production", detector: "nvidia-api-key", line: 1 },
    ]);
    expect(JSON.stringify(findings)).not.toContain(canary);
  });

  it("ignores an untracked local environment file while scanning ordinary files", async () => {
    const root = await temporaryRepository();
    const ignoredCanary = ["nvapi", "-", "B".repeat(40)].join("");
    const detectedCanary = ["nvapi", "-", "C".repeat(40)].join("");
    await writeFile(path.join(root, ".env.local"), `NVIDIA_API_KEY=${ignoredCanary}\n`, "utf8");
    await mkdir(path.join(root, "src"));
    await writeFile(path.join(root, "src", "fixture.txt"), `${detectedCanary}\n`, "utf8");

    const findings = await scanRepositoryForSecrets(root);

    expect(findings).toEqual([
      { path: "src/fixture.txt", detector: "nvidia-api-key", line: 1 },
    ]);
    expect(JSON.stringify(findings)).not.toContain(ignoredCanary);
    expect(JSON.stringify(findings)).not.toContain(detectedCanary);
  });

  it.each(["test-artifacts", "playwright-report"])(
    "ignores generated artifact directory %s",
    async (directoryName) => {
      const root = await temporaryRepository();
      const canary = ["nvapi", "-", "D".repeat(40)].join("");
      const artifactDirectory = path.join(root, directoryName);
      await mkdir(artifactDirectory);
      await writeFile(
        path.join(artifactDirectory, "generated.txt"),
        `${canary}\n`,
        "utf8",
      );

      const findings = await scanRepositoryForSecrets(root);

      expect(findings).toEqual([]);
    },
  );

  it("keeps a nested source directory with a generated-artifact name in scope", async () => {
    const root = await temporaryRepository();
    const canary = ["nvapi", "-", "E".repeat(40)].join("");
    const nestedSourceDirectory = path.join(root, "src", "test-artifacts");
    await mkdir(nestedSourceDirectory, { recursive: true });
    await writeFile(path.join(nestedSourceDirectory, "source.txt"), `${canary}\n`, "utf8");

    const findings = await scanRepositoryForSecrets(root);

    expect(findings).toEqual([
      { path: "src/test-artifacts/source.txt", detector: "nvidia-api-key", line: 1 },
    ]);
  });

  it("scans a force-tracked file inside a generated artifact root", async () => {
    const root = await temporaryRepository();
    const canary = ["nvapi", "-", "F".repeat(40)].join("");
    const artifactDirectory = path.join(root, "test-artifacts");
    await mkdir(artifactDirectory);
    await writeFile(path.join(artifactDirectory, "tracked.txt"), `${canary}\n`, "utf8");
    await execFileAsync("git", [
      "-C",
      root,
      "add",
      "--force",
      "test-artifacts/tracked.txt",
    ]);

    const findings = await scanRepositoryForSecrets(root);

    expect(findings).toEqual([
      { path: "test-artifacts/tracked.txt", detector: "nvidia-api-key", line: 1 },
    ]);
  });
  it.each([
    "coverage",
    "dist",
    "node_modules",
    ".next",
    ".next-e2e-3100",
    "public/monaco",
  ])("rescans a tracked candidate inside excluded root %s", async (directoryName) => {
    const root = await temporaryRepository();
    const canary = ["nvapi", "-", "G".repeat(40)].join("");
    const directory = path.join(root, ...directoryName.split("/"));
    await mkdir(directory, { recursive: true });
    const relativePath = `${directoryName}/tracked.txt`;
    await writeFile(path.join(root, ...relativePath.split("/")), `${canary}\n`, "utf8");
    await execFileAsync("git", ["-C", root, "add", "--force", relativePath]);

    await expect(scanRepositoryForSecrets(root)).resolves.toEqual([
      { path: relativePath, detector: "nvidia-api-key", line: 1 },
    ]);
  });

  it("scans a local environment file in a Git-free source archive", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "codestead-secret-archive-"));
    temporaryRepositories.push(root);
    const canary = ["nvapi", "-", "H".repeat(40)].join("");
    await writeFile(path.join(root, ".env.production"), `NVIDIA_API_KEY=${canary}\n`, "utf8");

    await expect(scanRepositoryForSecrets(root)).resolves.toEqual([
      { path: ".env.production", detector: "nvidia-api-key", line: 1 },
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
    const canary = ["nvapi", "-", "I".repeat(40)].join("");
    await writeFile(path.join(root, relativePath), `${canary}\n`, "utf8");

    await expect(scanRepositoryForSecrets(root)).resolves.toEqual([
      { path: relativePath, detector: "nvidia-api-key", line: 1 },
    ]);
  });

  it("scans secrets beyond the former two-mebibyte cutoff", async () => {
    const root = await temporaryRepository();
    const canary = ["nvapi", "-", "J".repeat(40)].join("");
    const prefix = `${"x".repeat(2 * 1024 * 1024 + 32)}\n`;
    await writeFile(path.join(root, "large.txt"), `${prefix}${canary}\n`, "utf8");

    await expect(scanRepositoryForSecrets(root)).resolves.toEqual([
      { path: "large.txt", detector: "nvidia-api-key", line: 2 },
    ]);
  });

  it("decodes a UTF-16LE BOM before scanning a tracked environment file", async () => {
    const root = await temporaryRepository();
    const canary = ["nvapi", "-", "K".repeat(40)].join("");
    const utf16 = Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from(`NVIDIA_API_KEY=${canary}\r\n`, "utf16le"),
    ]);
    await writeFile(path.join(root, ".env.production"), utf16);
    await execFileAsync("git", ["-C", root, "add", "--force", ".env.production"]);

    await expect(scanRepositoryForSecrets(root)).resolves.toEqual([
      { path: ".env.production", detector: "nvidia-api-key", line: 1 },
    ]);
  });

  it("hashes a potentially secret-bearing filename in findings", async () => {
    const root = await temporaryRepository();
    const pathCanary = ["nvapi", "-", "L".repeat(40)].join("");
    const contentCanary = ["nvapi", "-", "M".repeat(40)].join("");
    const relativePath = `${pathCanary}.txt`;
    await writeFile(path.join(root, relativePath), `${contentCanary}\n`, "utf8");

    const findings = await scanRepositoryForSecrets(root);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      detector: "nvidia-api-key",
      line: 1,
    });
    expect(findings[0]?.path).toMatch(/^\[redacted-path:sha256:[a-f0-9]{16}\]$/u);
    expect(JSON.stringify(findings)).not.toContain(pathCanary);
    expect(JSON.stringify(findings)).not.toContain(contentCanary);
  });

  it("ignores .git metadata files below an archive root", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "codestead-secret-dot-git-"));
    temporaryRepositories.push(root);
    const metadata = path.join(root, "metadata");
    await mkdir(metadata);
    const canary = ["nvapi", "-", "N".repeat(40)].join("");
    await writeFile(path.join(metadata, ".git"), `${canary}\n`, "utf8");
    await writeFile(path.join(root, "source.txt"), "ordinary\n", "utf8");

    await expect(scanRepositoryForSecrets(root)).resolves.toEqual([]);
  });

  it("does not follow an untracked directory symlink", async () => {
    const root = await temporaryRepository();
    const outside = await mkdtemp(path.join(tmpdir(), "codestead-secret-outside-"));
    temporaryRepositories.push(outside);
    const canary = ["nvapi", "-", "P".repeat(40)].join("");
    await writeFile(path.join(outside, "secret.txt"), `${canary}\n`, "utf8");
    await symlink(outside, path.join(root, "linked"), "junction");

    await expect(scanRepositoryForSecrets(root)).resolves.toEqual([]);
  });
  it("treats a nested archive under an ancestor repository as Git-free", async () => {
    const repository = await temporaryRepository();
    const archiveRoot = path.join(repository, "archive");
    await mkdir(archiveRoot);
    const canary = ["nvapi", "-", "Q".repeat(40)].join("");
    await writeFile(
      path.join(archiveRoot, ".env.production"),
      `NVIDIA_API_KEY=${canary}\n`,
      "utf8",
    );

    await expect(scanRepositoryForSecrets(archiveRoot)).resolves.toEqual([
      { path: ".env.production", detector: "nvidia-api-key", line: 1 },
    ]);
  });

  it("keeps generated and dependency roots excluded in a Git-free archive", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "codestead-secret-archive-skips-"));
    temporaryRepositories.push(root);
    const ignoredCanary = ["nvapi", "-", "R".repeat(40)].join("");
    const sourceCanary = ["nvapi", "-", "S".repeat(40)].join("");
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
      await writeFile(path.join(directory, "ignored.txt"), `${ignoredCanary}\n`, "utf8");
    }
    await mkdir(path.join(root, "src"));
    await writeFile(path.join(root, "src", "source.txt"), `${sourceCanary}\n`, "utf8");

    await expect(scanRepositoryForSecrets(root)).resolves.toEqual([
      { path: "src/source.txt", detector: "nvidia-api-key", line: 1 },
    ]);
  });

  it("fails closed when an indexed regular file is missing", async () => {
    const root = await temporaryRepository();
    const trackedPath = path.join(root, "missing.txt");
    await writeFile(trackedPath, "ordinary\n", "utf8");
    await execFileAsync("git", ["-C", root, "add", "missing.txt"]);
    await rm(trackedPath);

    await expect(scanRepositoryForSecrets(root)).rejects.toThrow(
      /missing or is not a regular file/u,
    );
  });


});
