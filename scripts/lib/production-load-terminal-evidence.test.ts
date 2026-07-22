import { chmod, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  writeProductionLoadTerminalReceiptExclusive,
  type ProductionLoadTerminalReceipt,
} from "./production-load-evidence";

const temporaryRoots: string[] = [];

afterEach(async () => {
  for (const root of temporaryRoots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

function receipt(status: "FAIL" | "NOT_RUN" = "NOT_RUN"): ProductionLoadTerminalReceipt {
  return {
    schemaVersion: 1,
    generatedAt: "2026-07-19T12:00:00.000Z",
    status,
    stage: status === "NOT_RUN" ? "approval" : "workload",
    failureCode: status === "NOT_RUN" ? "decision_missing" : "resource_abort",
    candidate: {
      gitSha: "a".repeat(40),
      gitTree: "b".repeat(40),
      releaseManifestSha256: `sha256:${"1".repeat(64)}`,
      applicationImageRecordSha256: `sha256:${"c".repeat(64)}`,
      composeProject: "learncoding",
      composeWorkdir: "/opt/learncoding",
      publicOrigin: "https://learn.example.com",
      managedInventorySha256: `sha256:${"2".repeat(64)}`,
      firewallPolicySha256: `sha256:${"3".repeat(64)}`,
      runnerGuestReleaseSha256: `sha256:${"4".repeat(64)}`,
      runnerImageRecordSha256: `sha256:${"d".repeat(64)}`,
      nucHostId: "nuc-homelab:approved-host",
      runnerVmId: "123e4567-e89b-42d3-a456-426614174000",
      datasetId: "seed-20260715",
    },
    decisionSha256: status === "NOT_RUN" ? null : `sha256:${"e".repeat(64)}`,
  };
}

describe("production load terminal evidence", () => {
  it("publishes one canonical immutable NOT_RUN or FAIL receipt", async () => {
    const evidenceRoot = await mkdtemp(path.join(os.tmpdir(), "codestead-load-terminal-"));
    temporaryRoots.push(evidenceRoot);
    const value = receipt();

    const artifact = await writeProductionLoadTerminalReceiptExclusive({
      evidenceRoot,
      receipt: value,
    });

    const expected = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    expect(artifact.path).toBe(path.join(evidenceRoot, "load-gate-terminal.json"));
    expect(await readFile(artifact.path)).toEqual(expected);
    if (process.platform !== "win32") {
      expect((await stat(artifact.path)).mode & 0o777).toBe(0o440);
    }
    await expect(writeProductionLoadTerminalReceiptExclusive({
      evidenceRoot,
      receipt: value,
    })).rejects.toThrow(/exist|publish/i);
  });

  it("rejects malformed or secret-bearing terminal evidence before publication", async () => {
    const evidenceRoot = await mkdtemp(path.join(os.tmpdir(), "codestead-load-terminal-"));
    temporaryRoots.push(evidenceRoot);
    await chmod(evidenceRoot, 0o700);

    await expect(writeProductionLoadTerminalReceiptExclusive({
      evidenceRoot,
      receipt: {
        ...receipt("FAIL"),
        failureCode: "Authorization: Bearer should-not-persist",
      } as ProductionLoadTerminalReceipt,
    })).rejects.toThrow(/failure code|secret-bearing/i);
  });
});
