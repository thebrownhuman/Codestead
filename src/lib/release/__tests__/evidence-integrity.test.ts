import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { verifyEvidenceIntegrity } from "../../../../scripts/lib/evidence-integrity";

const fixtures: string[] = [];

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "evidence-integrity-"));
  fixtures.push(root);
  await mkdir(path.join(root, "docs", "evidence"), { recursive: true });
  return root;
}

async function write(root: string, target: string, contents: string) {
  const absolute = path.join(root, target);
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, contents, "utf8");
}

function sha256(contents: string) {
  return createHash("sha256").update(contents).digest("hex");
}

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("evidence integrity verifier", () => {
  it("walks nested evidence and accepts existing links, paths, and current hashes", async () => {
    const root = await fixture();
    const source = "export const ready = true;\n";
    await write(root, "README.md", "[Guide](docs/guide.md#usage)\n");
    await write(root, "docs/guide.md", "# Usage\n");
    await write(root, "integration/example.integration.test.ts", source);
    await write(root, "docs/evidence/current.json", JSON.stringify({
      nested: [{ artifacts: [{ path: "integration/example.integration.test.ts", sha256: sha256(source) }] }],
    }));

    const report = await verifyEvidenceIntegrity({ root, markdownRoots: ["README.md", "docs"] });

    expect(report.issues).toEqual([]);
    expect(report.markdown.links).toBe(1);
    expect(report.evidence).toMatchObject({ files: 1, paths: 1, hashes: 1 });
  });

  it("rejects traversal and reports missing repository paths", async () => {
    const root = await fixture();
    await write(root, "docs/evidence/paths.json", JSON.stringify({
      artifacts: [
        { path: "docs/../../outside.json" },
        { path: "scripts/missing.ts" },
      ],
    }));

    const report = await verifyEvidenceIntegrity({ root, markdownRoots: [] });

    expect(report.issues).toEqual([
      expect.objectContaining({ kind: "INVALID_EVIDENCE_PATH", detail: "docs/../../outside.json" }),
      expect.objectContaining({ kind: "MISSING_EVIDENCE_PATH", detail: "scripts/missing.ts" }),
    ]);
  });

  it("reports stale hashes, missing links, and malformed encoded links", async () => {
    const root = await fixture();
    await write(root, "README.md", "[Missing](docs/missing.md) [Malformed](docs/%ZZ.md)\n");
    await write(root, "scripts/check.ts", "changed\n");
    await write(root, "docs/evidence/stale.json", JSON.stringify({
      artifactSha256: { "scripts/check.ts": "0".repeat(64) },
    }));

    const report = await verifyEvidenceIntegrity({ root, markdownRoots: ["README.md"] });

    expect(report.issues.map((issue) => issue.kind)).toEqual([
      "BROKEN_LINK",
      "BROKEN_LINK",
      "STALE_HASH",
    ]);
    expect(report.issues.find((issue) => issue.kind === "STALE_HASH")?.detail)
      .toContain(`actual=${sha256("changed\n")}`);
  });

  it("accepts a uniform CRLF checkout for Git-normalized text evidence", async () => {
    const root = await fixture();
    const canonical = "export const checked = true;\nexport const count = 2;\n";
    await write(root, "scripts/check.ts", canonical.replaceAll("\n", "\r\n"));
    await write(root, "docs/evidence/text.json", JSON.stringify({
      artifactSha256: { "scripts/check.ts": sha256(canonical) },
    }));

    const report = await verifyEvidenceIntegrity({ root, markdownRoots: [] });

    expect(report.issues).toEqual([]);
    expect(report.evidence.hashes).toBe(1);
  });

  it.each([
    ["infra/check.sh", "forced-LF deployment script"],
    ["docs/check.png", "binary asset"],
  ])("keeps %s byte-exact as a %s", async (target) => {
    const root = await fixture();
    const canonical = "first\nsecond\n";
    await write(root, target, canonical.replaceAll("\n", "\r\n"));
    await write(root, "docs/evidence/exact.json", JSON.stringify({
      artifactSha256: { [target]: sha256(canonical) },
    }));

    const report = await verifyEvidenceIntegrity({ root, markdownRoots: [] });

    expect(report.issues).toEqual([
      expect.objectContaining({
        kind: "STALE_HASH",
        detail: expect.stringContaining(`actual=${sha256(canonical.replaceAll("\n", "\r\n"))}`),
      }),
    ]);
  });

  it("checks recursive named path and Sha256 pairs without treating metadata as artifacts", async () => {
    const root = await fixture();
    const source = "export const checked = true;\n";
    await write(root, "scripts/check.ts", source);
    await write(root, "docs/evidence/named.json", JSON.stringify({
      implementation: {
        runnerClient: "scripts/check.ts",
        runnerClientSha256: "0".repeat(64),
        nested: {
          migration: "scripts/check.ts",
          migrationSha256: sha256(source),
        },
        generatedAt: "2026-07-14T00:00:00.000Z",
        generatedAtSha256: "f".repeat(64),
        externalReport: "https://example.test/report.json",
        externalReportSha256: "e".repeat(64),
      },
    }));

    const report = await verifyEvidenceIntegrity({ root, markdownRoots: [] });

    expect(report.issues).toEqual([
      expect.objectContaining({
        kind: "STALE_HASH",
        source: "docs/evidence/named.json",
        detail: expect.stringContaining("scripts/check.ts expected="),
      }),
    ]);
    expect(report.evidence.hashes).toBe(2);
  });

  it("reports malformed evidence JSON without aborting the remaining files", async () => {
    const root = await fixture();
    await write(root, "docs/evidence/bad.json", "{not-json");
    await write(root, "docs/evidence/good.json", JSON.stringify({ report: "docs/evidence/good.json" }));

    const report = await verifyEvidenceIntegrity({ root, markdownRoots: [] });

    expect(report.evidence.files).toBe(2);
    expect(report.issues).toEqual([
      expect.objectContaining({ kind: "INVALID_JSON", source: "docs/evidence/bad.json" }),
    ]);
  });
});
