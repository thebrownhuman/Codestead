import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { verifyEvidenceIntegrity } from "../../../../scripts/lib/evidence-integrity";

const fixtures: string[] = [];
const sourcePath = "src/lib/example.ts";
const evidencePath = "docs/evidence/historical.json";
const original = "export const version = 1;\n";
const changed = "export const version = 2;\n";

function sha256(contents: string) {
  return createHash("sha256").update(contents).digest("hex");
}

function git(root: string, ...args: string[]) {
  return execFileSync("git", [
    "-c", "core.autocrlf=false", "-c", "user.name=fixture", "-c", "user.email=fixture@example.test",
    "-c", "commit.gpgsign=false", ...args,
  ], { cwd: root, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } }).trim();
}

async function write(root: string, target: string, contents: string) {
  const absolute = path.join(root, target);
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, contents, "utf8");
}

async function repository() {
  const root = await mkdtemp(path.join(os.tmpdir(), "evidence-source-commit-"));
  fixtures.push(root);
  git(root, "init", "--quiet", "--initial-branch=main");
  await write(root, sourcePath, original);
  git(root, "add", ".");
  git(root, "commit", "--quiet", "-m", "proof run");
  const proofCommit = git(root, "rev-parse", "HEAD");
  await write(root, sourcePath, changed);
  git(root, "commit", "--quiet", "-am", "later change");
  return { root, proofCommit };
}

async function anchored(root: string, sourceCommit: unknown, hash = sha256(original), target = sourcePath) {
  await write(root, evidencePath, JSON.stringify({
    sourceCommit,
    note: "Hashes are anchored at sourceCommit.",
    artifacts: [{ path: target, sha256: hash }],
  }));
}

async function verify(root: string) {
  return verifyEvidenceIntegrity({ root, markdownRoots: [] });
}

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("commit-anchored evidence", () => {
  it("checks anchored pins against the source commit, not the working tree", async () => {
    const { root, proofCommit } = await repository();
    await anchored(root, proofCommit);
    const report = await verify(root);
    expect(report.issues).toEqual([]);
    expect(report.evidence.hashes).toBe(1);
  });

  it("rejects unanchored source pins and still reports stale working-tree hashes", async () => {
    const { root } = await repository();
    await write(root, evidencePath, JSON.stringify({ artifacts: [{ path: sourcePath, sha256: sha256(original) }] }));
    const report = await verify(root);
    expect(report.issues).toEqual([
      expect.objectContaining({ kind: "STALE_HASH", source: evidencePath, detail: expect.stringContaining(sourcePath) }),
      expect.objectContaining({ kind: "UNANCHORED_SOURCE_PIN", source: evidencePath, detail: expect.stringContaining(sourcePath) }),
    ]);
  });

  it("reports a pin that does not match the anchored commit", async () => {
    const { root, proofCommit } = await repository();
    await anchored(root, proofCommit, sha256(changed));
    const report = await verify(root);
    expect(report.issues).toEqual([
      expect.objectContaining({
        kind: "STALE_HASH",
        source: evidencePath,
        detail: expect.stringContaining(`${sourcePath}@${proofCommit}`),
      }),
    ]);
  });

  it("reports a path that does not exist at the anchored commit", async () => {
    const { root, proofCommit } = await repository();
    await write(root, "src/lib/added-later.ts", original);
    git(root, "add", ".");
    git(root, "commit", "--quiet", "-m", "add file");
    await anchored(root, proofCommit, sha256(original), "src/lib/added-later.ts");
    const report = await verify(root);
    expect(report.issues.length).toBeGreaterThan(0);
    for (const issue of report.issues) {
      expect(issue).toEqual({
        kind: "MISSING_EVIDENCE_PATH", source: evidencePath, detail: `src/lib/added-later.ts@${proofCommit}`,
      });
    }
  });

  it("never accepts a tree where an anchored blob is required", async () => {
    const { root, proofCommit } = await repository();
    await anchored(root, proofCommit, sha256(original), "src/lib");
    // Fails closed exactly as before the ls-tree cache: `cat-file blob` refuses a non-blob.
    expect((await verify(root)).issues).toEqual([
      expect.objectContaining({ kind: "INVALID_JSON", source: evidencePath, detail: expect.stringContaining("cat-file blob") }),
    ]);
  });

  it("never accepts a gitlink where an anchored blob is required", async () => {
    const { root, proofCommit } = await repository();
    git(root, "update-index", "--add", "--cacheinfo", `160000,${proofCommit},src/lib/vendored`);
    git(root, "commit", "--quiet", "-m", "gitlink");
    const gitlinkCommit = git(root, "rev-parse", "HEAD");
    await anchored(root, gitlinkCommit, sha256(original), "src/lib/vendored");
    // Fails closed exactly as before the ls-tree cache: `cat-file blob` refuses a non-blob.
    expect((await verify(root)).issues).toEqual([
      expect.objectContaining({ kind: "INVALID_JSON", source: evidencePath, detail: expect.stringContaining("cat-file blob") }),
    ]);
  });

  it("reports an anchored path missing at its commit even when it exists in the working tree", async () => {
    const { root, proofCommit } = await repository();
    await write(root, "src/lib/untracked.ts", original);
    await anchored(root, proofCommit, sha256(original), "src/lib/untracked.ts");
    const report = await verify(root);
    expect(report.issues).toContainEqual({
      kind: "MISSING_EVIDENCE_PATH", source: evidencePath, detail: `src/lib/untracked.ts@${proofCommit}`,
    });
  });

  it("fails closed on a malformed source commit", async () => {
    const { root, proofCommit } = await repository();
    for (const value of [proofCommit.slice(0, 12), proofCommit.toUpperCase(), "HEAD", 42]) {
      await anchored(root, value);
      const report = await verify(root);
      expect(report.issues).toEqual([expect.objectContaining({ kind: "INVALID_SOURCE_COMMIT", source: evidencePath })]);
    }
  });

  it("fails closed when the source commit is not available, as in a shallow clone", async () => {
    const { root } = await repository();
    await anchored(root, "0".repeat(40));
    const report = await verify(root);
    expect(report.issues).toEqual([
      expect.objectContaining({ kind: "SOURCE_COMMIT_UNAVAILABLE", source: evidencePath, detail: expect.stringMatching(/fetch.*history/i) }),
    ]);
  });

  it("fails closed when the source commit is not an ancestor of HEAD", async () => {
    const { root } = await repository();
    git(root, "checkout", "--quiet", "--orphan", "elsewhere");
    git(root, "commit", "--quiet", "-m", "unrelated history");
    const unrelated = git(root, "rev-parse", "HEAD");
    git(root, "checkout", "--quiet", "main");
    await anchored(root, unrelated);
    const report = await verify(root);
    expect(report.issues).toEqual([
      expect.objectContaining({ kind: "SOURCE_COMMIT_NOT_ANCESTOR", source: evidencePath }),
    ]);
  });

  it("fails closed when an anchored record is verified outside a git repository", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "evidence-source-commit-nogit-"));
    fixtures.push(root);
    await write(root, sourcePath, original);
    await anchored(root, "a".repeat(40));
    const report = await verify(root);
    expect(report.issues).toEqual([expect.objectContaining({ kind: "SOURCE_COMMIT_UNAVAILABLE", source: evidencePath })]);
  });
});
