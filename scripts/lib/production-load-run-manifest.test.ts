import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { ProductionLoadCandidate } from "../../src/lib/performance/load-report";
import {
  assertProductionLoadRunManifestUnchanged,
  readApprovedProductionLoadRunManifest,
  validateProductionLoadRunManifest,
} from "./production-load-run-manifest";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function candidate(): ProductionLoadCandidate {
  return {
    gitSha: "a".repeat(40),
    gitTree: "b".repeat(40),
    releaseManifestSha256: `sha256:${"1".repeat(64)}`,
    applicationImageRecordSha256: `sha256:${"2".repeat(64)}`,
    composeProject: "learncoding",
    composeWorkdir: "/opt/learncoding",
    publicOrigin: "https://learn.example.com",
    managedInventorySha256: `sha256:${"3".repeat(64)}`,
    firewallPolicySha256: `sha256:${"4".repeat(64)}`,
    runnerGuestReleaseSha256: `sha256:${"5".repeat(64)}`,
    runnerImageRecordSha256: `sha256:${"6".repeat(64)}`,
    nucHostId: "nuc-homelab:approved-host",
    runnerVmId: "123e4567-e89b-42d3-a456-426614174000",
    datasetId: "seed-20260715",
  };
}

function manifest(expected = candidate()) {
  return {
    schemaVersion: 1,
    decisionSha256: `sha256:${"d".repeat(64)}`,
    candidate: expected,
    runnerVmId: expected.runnerVmId,
    expectedUnrelatedInventorySha256: "e".repeat(64),
    validFrom: "2026-07-20T00:00:00.000Z",
    validUntil: "2026-07-20T08:00:00.000Z",
  };
}

describe("production load approved run manifest", () => {
  it("binds a current run to the approved decision, full candidate, VM, and unrelated inventory", () => {
    expect(validateProductionLoadRunManifest({
      value: manifest(),
      expectedCandidate: candidate(),
      expectedDecisionSha256: `sha256:${"d".repeat(64)}`,
      now: new Date("2026-07-20T04:00:00.000Z"),
    })).toEqual(manifest());
  });

  it.each([
    ["decision", { decisionSha256: `sha256:${"f".repeat(64)}` }],
    ["runner", { runnerVmId: "123e4567-e89b-42d3-a456-426614174001" }],
    ["inventory", { expectedUnrelatedInventorySha256: "f".repeat(63) }],
    ["expired", { validUntil: "2026-07-20T03:59:59.999Z" }],
    ["future", { validFrom: "2026-07-20T04:00:00.001Z" }],
    ["overlong", { validUntil: "2026-07-21T00:00:00.001Z" }],
  ])("rejects a mismatched or unsafe %s binding", (_label, override) => {
    expect(() => validateProductionLoadRunManifest({
      value: { ...manifest(), ...override },
      expectedCandidate: candidate(),
      expectedDecisionSha256: `sha256:${"d".repeat(64)}`,
      now: new Date("2026-07-20T04:00:00.000Z"),
    })).toThrow(/^Production load run manifest failed: /);
  });

  it("rejects missing, extra, reordered, or changed candidate fields", () => {
    const approved = manifest();
    expect(() => validateProductionLoadRunManifest({
      value: { ...approved, extra: true },
      expectedCandidate: candidate(),
      expectedDecisionSha256: approved.decisionSha256,
      now: new Date("2026-07-20T04:00:00.000Z"),
    })).toThrow(/invalid_schema/);
    expect(() => validateProductionLoadRunManifest({
      value: { ...approved, candidate: { ...approved.candidate, gitSha: "f".repeat(40) } },
      expectedCandidate: candidate(),
      expectedDecisionSha256: approved.decisionSha256,
      now: new Date("2026-07-20T04:00:00.000Z"),
    })).toThrow(/candidate_mismatch/);
  });

  it("allows an expired manifest only for identity-bound boot recovery", () => {
    expect(validateProductionLoadRunManifest({
      value: manifest(), expectedCandidate: candidate(),
      expectedDecisionSha256: `sha256:${"d".repeat(64)}`,
      now: new Date("2026-07-20T09:00:00.000Z"), validityMode: "recovery",
    })).toEqual(manifest());
    expect(() => validateProductionLoadRunManifest({
      value: manifest(), expectedCandidate: candidate(),
      expectedDecisionSha256: `sha256:${"d".repeat(64)}`,
      now: new Date("2026-07-19T23:59:59.999Z"), validityMode: "recovery",
    })).toThrow(/invalid_validity_window/);
  });

  it("reads only canonical, single-link manifest bytes and returns their journal identity", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codestead-run-manifest-"));
    roots.push(root);
    const manifestPath = path.join(root, "production-load-manifest.json");
    const bytes = `${JSON.stringify(manifest(), null, 2)}\n`;
    await writeFile(manifestPath, bytes, { flag: "wx", mode: 0o600 });
    await chmod(manifestPath, 0o600);

    const artifact = await readApprovedProductionLoadRunManifest({
      manifestPath,
      expectedCandidate: candidate(),
      expectedDecisionSha256: `sha256:${"d".repeat(64)}`,
      now: new Date("2026-07-20T04:00:00.000Z"),
      requiredMode: process.platform === "win32" ? null : 0o600,
      ...(typeof process.getuid === "function" ? { requiredOwnerUid: process.getuid() } : {}),
    });

    expect(artifact.path).toBe(manifestPath);
    expect(artifact.byteLength).toBe(Buffer.byteLength(bytes));
    expect(artifact.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(artifact.candidateRunIdentitySha256).toBe(`sha256:${artifact.sha256}`);
    expect(artifact.manifest).toEqual(manifest());
  });

  it("detects a canonical replacement after approval was loaded", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codestead-run-manifest-"));
    roots.push(root);
    const manifestPath = path.join(root, "production-load-manifest.json");
    await writeFile(manifestPath, `${JSON.stringify(manifest(), null, 2)}\n`, {
      flag: "wx", mode: 0o600,
    });
    await chmod(manifestPath, 0o600);
    const options = {
      manifestPath, expectedCandidate: candidate(),
      expectedDecisionSha256: `sha256:${"d".repeat(64)}`,
      now: new Date("2026-07-20T04:00:00.000Z"),
      requiredMode: process.platform === "win32" ? null : 0o600,
      ...(typeof process.getuid === "function" ? { requiredOwnerUid: process.getuid() } : {}),
    };
    const artifact = await readApprovedProductionLoadRunManifest(options);
    await writeFile(manifestPath, `${JSON.stringify({
      ...manifest(), validUntil: "2026-07-20T08:00:00.001Z",
    }, null, 2)}\n`);
    await expect(assertProductionLoadRunManifestUnchanged(artifact, options)).rejects.toThrow(
      /manifest_changed/,
    );
  });

  it("rejects a symbolic-link manifest", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codestead-run-manifest-"));
    roots.push(root);
    const target = path.join(root, "target.json");
    const manifestPath = path.join(root, "production-load-manifest.json");
    await writeFile(target, `${JSON.stringify(manifest(), null, 2)}\n`);
    await symlink(target, manifestPath, "file");

    await expect(readApprovedProductionLoadRunManifest({
      manifestPath,
      expectedCandidate: candidate(),
      expectedDecisionSha256: `sha256:${"d".repeat(64)}`,
      now: new Date("2026-07-20T04:00:00.000Z"),
      requiredMode: null,
    })).rejects.toThrow(/unsafe_file/);
  });
});
