import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
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
});
