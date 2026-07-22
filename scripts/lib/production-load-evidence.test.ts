import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { PRODUCTION_LOAD_THRESHOLDS, type ProductionLoadCandidate } from "../../src/lib/performance/load-report";
import {
  assertProductionLoadDecisionUnchanged,
  readApprovedProductionLoadDecision,
} from "./production-load-evidence";

const temporaryRoots: string[] = [];

afterEach(async () => {
  for (const root of temporaryRoots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

function candidate(): ProductionLoadCandidate {
  return {
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
  };
}

function approvedDecision(expectedCandidate: ProductionLoadCandidate) {
  return {
    schemaVersion: 1,
    scope: "codestead-project-only",
    status: "approved",
    approvedAt: "2026-07-19T12:00:00.000Z",
    approvedBy: "Codestead product owner",
    approvalReason: "Approved supervised pilot load and fault rehearsal.",
    candidate: expectedCandidate,
    thresholds: PRODUCTION_LOAD_THRESHOLDS,
  };
}

const candidateIdentityMismatches = [
  { field: "gitSha", approvedValue: "e".repeat(40) },
  { field: "gitTree", approvedValue: "f".repeat(40) },
  { field: "releaseManifestSha256", approvedValue: "sha256:" + "5".repeat(64) },
  { field: "applicationImageRecordSha256", approvedValue: "sha256:" + "e".repeat(64) },
  { field: "publicOrigin", approvedValue: "https://other.example.com" },
  { field: "managedInventorySha256", approvedValue: "sha256:" + "6".repeat(64) },
  { field: "firewallPolicySha256", approvedValue: "sha256:" + "7".repeat(64) },
  { field: "runnerGuestReleaseSha256", approvedValue: "sha256:" + "8".repeat(64) },
  { field: "runnerImageRecordSha256", approvedValue: "sha256:" + "e".repeat(64) },
  { field: "nucHostId", approvedValue: "nuc-homelab:other-host" },
  { field: "runnerVmId", approvedValue: "123e4567-e89b-42d3-a456-426614174001" },
] as const satisfies ReadonlyArray<{
  readonly field: keyof ProductionLoadCandidate;
  readonly approvedValue: string;
}>;

function candidateWithIdentityMismatch(
  expectedCandidate: ProductionLoadCandidate,
  field: keyof ProductionLoadCandidate,
  approvedValue: string,
): ProductionLoadCandidate {
  return {
    ...expectedCandidate,
    [field]: approvedValue,
  } as ProductionLoadCandidate;
}

describe("production load decision artifact", () => {
  it("reads an exact canonical approved decision and records its byte hash", async () => {
    const evidenceRoot = await mkdtemp(path.join(os.tmpdir(), "codestead-load-decision-"));
    temporaryRoots.push(evidenceRoot);
    const expectedCandidate = candidate();
    const bytes = Buffer.from(`${JSON.stringify(approvedDecision(expectedCandidate), null, 2)}\n`, "utf8");
    const decisionPath = path.join(evidenceRoot, "load-gate-decision.json");
    await writeFile(decisionPath, bytes, { flag: "wx", mode: 0o440 });
    await chmod(decisionPath, 0o440);

    const artifact = await readApprovedProductionLoadDecision({
      evidenceRoot,
      expectedCandidate,
      ...(typeof process.getuid === "function" ? { requiredOwnerUid: process.getuid() } : {}),
      ...(process.platform === "win32" ? { requiredMode: null } : {}),
    });

    expect(artifact.path).toBe(decisionPath);
    expect(artifact.byteLength).toBe(bytes.byteLength);
    expect(artifact.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(artifact.decision).toEqual(approvedDecision(expectedCandidate));
  });

  it.each(candidateIdentityMismatches)(
    "rejects a canonical approved decision whose $field differs from the current candidate",
    async ({ field, approvedValue }) => {
      const evidenceRoot = await mkdtemp(path.join(os.tmpdir(), "codestead-load-decision-"));
      temporaryRoots.push(evidenceRoot);
      const expectedCandidate = candidate();
      const approvedCandidate = candidateWithIdentityMismatch(expectedCandidate, field, approvedValue);
      const decisionPath = path.join(evidenceRoot, "load-gate-decision.json");
      await writeFile(
        decisionPath,
        JSON.stringify(approvedDecision(approvedCandidate), null, 2) + "\n",
        { flag: "wx", mode: 0o440 },
      );
      await chmod(decisionPath, 0o440);

      await expect(readApprovedProductionLoadDecision({
        evidenceRoot,
        expectedCandidate,
        ...(typeof process.getuid === "function" ? { requiredOwnerUid: process.getuid() } : {}),
        ...(process.platform === "win32" ? { requiredMode: null } : {}),
      })).rejects.toThrow("Production load decision candidate mismatch: " + field + ".");
    },
  );

  it.each(candidateIdentityMismatches)(
    "rejects a canonical replacement whose $field differs from the loaded candidate",
    async ({ field, approvedValue }) => {
      const evidenceRoot = await mkdtemp(path.join(os.tmpdir(), "codestead-load-decision-"));
      temporaryRoots.push(evidenceRoot);
      const expectedCandidate = candidate();
      const decisionPath = path.join(evidenceRoot, "load-gate-decision.json");
      await writeFile(
        decisionPath,
        JSON.stringify(approvedDecision(expectedCandidate), null, 2) + "\n",
        { flag: "wx", mode: 0o440 },
      );
      await chmod(decisionPath, 0o440);
      const options = {
        evidenceRoot,
        expectedCandidate,
        ...(typeof process.getuid === "function" ? { requiredOwnerUid: process.getuid() } : {}),
        ...(process.platform === "win32" ? { requiredMode: null } : {}),
      };
      const artifact = await readApprovedProductionLoadDecision(options);
      const approvedCandidate = candidateWithIdentityMismatch(expectedCandidate, field, approvedValue);

      await chmod(decisionPath, 0o640);
      await writeFile(
        decisionPath,
        JSON.stringify(approvedDecision(approvedCandidate), null, 2) + "\n",
      );
      await chmod(decisionPath, 0o440);

      await expect(assertProductionLoadDecisionUnchanged(artifact, options)).rejects.toThrow(
        "Production load decision candidate mismatch: " + field + ".",
      );
    },
  );
});

  it("rejects a decision artifact whose bytes change after approval is loaded", async () => {
    const evidenceModule = await import("./production-load-evidence");
    const assertUnchanged = Reflect.get(evidenceModule, "assertProductionLoadDecisionUnchanged");
    const evidenceRoot = await mkdtemp(path.join(os.tmpdir(), "codestead-load-decision-"));
    temporaryRoots.push(evidenceRoot);
    const expectedCandidate = candidate();
    const decisionPath = path.join(evidenceRoot, "load-gate-decision.json");
    const original = approvedDecision(expectedCandidate);
    await writeFile(decisionPath, `${JSON.stringify(original, null, 2)}\n`, { flag: "wx", mode: 0o440 });
    await chmod(decisionPath, 0o440);
    const options = {
      evidenceRoot,
      expectedCandidate,
      ...(typeof process.getuid === "function" ? { requiredOwnerUid: process.getuid() } : {}),
      ...(process.platform === "win32" ? { requiredMode: null } : {}),
    };
    const artifact = await readApprovedProductionLoadDecision(options);

    await chmod(decisionPath, 0o640);
    await writeFile(decisionPath, `${JSON.stringify({
      ...original,
      approvalReason: "Tampered after the run began.",
    }, null, 2)}\n`);
    await chmod(decisionPath, 0o440);

    expect(assertUnchanged).toBeTypeOf("function");
    await expect(assertUnchanged(artifact, options)).rejects.toThrow(/changed|hash/i);
  });
  it("rejects noncanonical decision JSON even when its values are approved", async () => {
    const evidenceRoot = await mkdtemp(path.join(os.tmpdir(), "codestead-load-decision-"));
    temporaryRoots.push(evidenceRoot);
    const expectedCandidate = candidate();
    const decisionPath = path.join(evidenceRoot, "load-gate-decision.json");
    await writeFile(decisionPath, `${JSON.stringify(approvedDecision(expectedCandidate))}\n`, { flag: "wx", mode: 0o440 });
    await chmod(decisionPath, 0o440);

    await expect(readApprovedProductionLoadDecision({
      evidenceRoot,
      expectedCandidate,
      ...(typeof process.getuid === "function" ? { requiredOwnerUid: process.getuid() } : {}),
      ...(process.platform === "win32" ? { requiredMode: null } : {}),
    })).rejects.toThrow(/canonical/i);
  });

  it("rejects a writable decision artifact on POSIX", async () => {
    if (process.platform === "win32") return;
    const evidenceRoot = await mkdtemp(path.join(os.tmpdir(), "codestead-load-decision-"));
    temporaryRoots.push(evidenceRoot);
    const expectedCandidate = candidate();
    const decisionPath = path.join(evidenceRoot, "load-gate-decision.json");
    await writeFile(decisionPath, `${JSON.stringify(approvedDecision(expectedCandidate), null, 2)}\n`, {
      flag: "wx",
      mode: 0o640,
    });
    await chmod(decisionPath, 0o640);

    await expect(readApprovedProductionLoadDecision({
      evidenceRoot,
      expectedCandidate,
      requiredOwnerUid: process.getuid!(),
    })).rejects.toThrow(/mode/i);
  });

  it("rejects a symbolic-link decision artifact on POSIX", async () => {
    if (process.platform === "win32") return;
    const evidenceRoot = await mkdtemp(path.join(os.tmpdir(), "codestead-load-decision-"));
    temporaryRoots.push(evidenceRoot);
    const expectedCandidate = candidate();
    const targetPath = path.join(evidenceRoot, "approved-target.json");
    await writeFile(targetPath, `${JSON.stringify(approvedDecision(expectedCandidate), null, 2)}\n`, {
      flag: "wx",
      mode: 0o440,
    });
    await chmod(targetPath, 0o440);
    await symlink(targetPath, path.join(evidenceRoot, "load-gate-decision.json"), "file");

    await expect(readApprovedProductionLoadDecision({
      evidenceRoot,
      expectedCandidate,
      requiredOwnerUid: process.getuid!(),
    })).rejects.toThrow(/regular file|symbolic link/i);
  });

  it("rejects a decision artifact owned by an unexpected UID on POSIX", async () => {
    if (process.platform === "win32") return;
    const evidenceRoot = await mkdtemp(path.join(os.tmpdir(), "codestead-load-decision-"));
    temporaryRoots.push(evidenceRoot);
    const expectedCandidate = candidate();
    const decisionPath = path.join(evidenceRoot, "load-gate-decision.json");
    await writeFile(decisionPath, `${JSON.stringify(approvedDecision(expectedCandidate), null, 2)}\n`, {
      flag: "wx",
      mode: 0o440,
    });
    await chmod(decisionPath, 0o440);

    await expect(readApprovedProductionLoadDecision({
      evidenceRoot,
      expectedCandidate,
      requiredOwnerUid: process.getuid!() + 1,
    })).rejects.toThrow(/owner/i);
  });


  it("publishes one canonical redacted report without overwriting prior evidence", async () => {
    const evidenceModule = await import("./production-load-evidence");
    const writeReport = Reflect.get(evidenceModule, "writeProductionLoadReportExclusive");
    const evidenceRoot = await mkdtemp(path.join(os.tmpdir(), "codestead-load-report-"));
    temporaryRoots.push(evidenceRoot);
    const report = {
      schemaVersion: 1,
      verdict: "NOT_RUN",
      candidate: candidate(),
      decisionSha256: "e".repeat(64),
      failures: ["external_nuc_gate_not_run"],
    } as const;

    expect(writeReport).toBeTypeOf("function");
    const artifact = await writeReport({ evidenceRoot, report });
    const expectedBytes = Buffer.from(`${JSON.stringify(report, null, 2)}\n`, "utf8");
    expect(artifact.path).toBe(path.join(evidenceRoot, "load-gate-report.json"));
    expect(artifact.byteLength).toBe(expectedBytes.byteLength);
    expect(artifact.sha256).toBe(createHash("sha256").update(expectedBytes).digest("hex"));
    expect(await readFile(artifact.path)).toEqual(expectedBytes);
    if (process.platform !== "win32") {
      expect((await stat(artifact.path)).mode & 0o777).toBe(0o440);
    }
    await expect(writeReport({ evidenceRoot, report })).rejects.toThrow(/exist|publish/i);
    expect(await readFile(artifact.path)).toEqual(expectedBytes);
  });

  it("rejects secret-bearing report data before creating any evidence file", async () => {
    const evidenceModule = await import("./production-load-evidence");
    const writeReport = Reflect.get(evidenceModule, "writeProductionLoadReportExclusive");
    const evidenceRoot = await mkdtemp(path.join(os.tmpdir(), "codestead-load-report-"));
    temporaryRoots.push(evidenceRoot);

    await expect(writeReport({
      evidenceRoot,
      report: { schemaVersion: 1, apiToken: "must-never-reach-disk" },
    })).rejects.toThrow(/secret-bearing field/i);
    expect(await readdir(evidenceRoot)).toEqual([]);
  });
