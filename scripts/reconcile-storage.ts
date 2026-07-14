import { randomUUID } from "node:crypto";
import { lstat, mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { objectStorageRoot } from "../src/lib/storage/object-root";
import { NodeStorageReconciliationInspector } from "../src/lib/storage/reconciliation-filesystem";
import {
  PostgresStorageReconciliationRepository,
  reconcileStorage,
  STORAGE_RECONCILIATION_APPLY_CONFIRMATION,
  STORAGE_RECONCILIATION_POLICY_VERSION,
  StorageReconciliationError,
} from "../src/lib/storage/reconciliation";

interface Arguments {
  readonly mode: "dry-run" | "apply";
  readonly confirmation?: string;
  readonly runId: string;
}

function parseArguments(values: readonly string[]): Arguments {
  let mode: Arguments["mode"] = "dry-run";
  let confirmation: string | undefined;
  let runId: string = randomUUID();
  for (const value of values) {
    if (value === "--dry-run") mode = "dry-run";
    else if (value === "--apply") mode = "apply";
    else if (value.startsWith("--confirm=")) confirmation = value.slice("--confirm=".length);
    else if (value.startsWith("--run-id=")) runId = value.slice("--run-id=".length);
    else throw new StorageReconciliationError("INVALID_REQUEST");
  }
  if (mode === "dry-run" && confirmation !== undefined) {
    throw new StorageReconciliationError("INVALID_REQUEST");
  }
  return { mode, confirmation, runId };
}

function reportDirectory() {
  const configured = process.env.STORAGE_RECONCILIATION_REPORT_DIR;
  if (!configured) return path.join(process.cwd(), "var", "reports", "storage-reconciliation");
  if (!path.isAbsolute(configured)) throw new StorageReconciliationError("INVALID_REQUEST");
  return configured;
}

async function writeReport(runId: string, value: unknown) {
  const directory = path.resolve(reportDirectory());
  const objectRoot = path.resolve(objectStorageRoot());
  const relativeToObjects = path.relative(objectRoot, directory);
  if (
    relativeToObjects === "" ||
    (!relativeToObjects.startsWith("..") && !path.isAbsolute(relativeToObjects))
  ) {
    throw new StorageReconciliationError("INVALID_REQUEST");
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const directoryEntry = await lstat(directory);
  if (!directoryEntry.isDirectory() || directoryEntry.isSymbolicLink()) {
    throw new StorageReconciliationError("INVALID_REQUEST");
  }
  const temporary = path.join(directory, "." + runId + ".tmp");
  const destination = path.join(directory, runId + ".json");
  await writeFile(temporary, JSON.stringify(value, null, 2) + "\n", {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  await rename(temporary, destination);
}

async function main() {
  let args: Arguments;
  try {
    args = parseArguments(process.argv.slice(2));
  } catch (error) {
    const code = error instanceof StorageReconciliationError ? error.code : "INVALID_REQUEST";
    console.error("Storage reconciliation failed: " + code + ".");
    process.exitCode = 1;
    return;
  }
  try {
    const report = await reconcileStorage({
      repository: new PostgresStorageReconciliationRepository(),
      inspector: new NodeStorageReconciliationInspector(),
      root: objectStorageRoot(),
      mode: args.mode,
      confirmation: args.confirmation,
      runId: args.runId,
    });
    await writeReport(args.runId, report);
    console.log(
      "Storage reconciliation complete: status=" + report.status +
      ", mode=" + report.mode +
      ", activeObjects=" + report.summary.activeObjects +
      ", findings=" + Object.values(report.issueCounts).reduce((sum, count) => sum + count, 0) +
      ", report=written.",
    );
    if (report.status === "FINDINGS" || report.status === "APPLIED_WITH_FINDINGS") process.exitCode = 2;
    if (report.status === "APPLY_INCOMPLETE") process.exitCode = 1;
  } catch (error) {
    const code = error instanceof StorageReconciliationError ? error.code : "UNEXPECTED_FAILURE";
    const failure = {
      schemaVersion: "1.0.0",
      policyVersion: STORAGE_RECONCILIATION_POLICY_VERSION,
      runId: args.runId,
      mode: args.mode,
      generatedAt: new Date().toISOString(),
      status: "FAILED",
      errorCode: code,
      privacy: {
        containsFilenames: false,
        containsHashes: false,
        containsStorageKeysOrPaths: false,
        containsLearnerIdentifiers: false,
      },
    };
    await writeReport(args.runId, failure).catch(() => undefined);
    console.error("Storage reconciliation failed: " + code + ". A redacted failure report was attempted.");
    process.exitCode = 1;
  }
}

void main();

// Printed in the runbook and intentionally not inferred from environment state.
export const APPLY_CONFIRMATION = STORAGE_RECONCILIATION_APPLY_CONFIRMATION;
