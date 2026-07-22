import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, open, realpath, unlink } from "node:fs/promises";
import path from "node:path";
import { TextDecoder } from "node:util";

import {
  assertProductionLoadEvidenceSafe,
  validateProductionLoadDecision,
  type ProductionLoadCandidate,
  type ProductionLoadDecision,
} from "../../src/lib/performance/load-report";

export type ReadProductionLoadDecisionOptions = {
  readonly evidenceRoot: string;
  readonly expectedCandidate: ProductionLoadCandidate;
  readonly requiredOwnerUid?: number;
  readonly requiredMode?: number | null;
};

export type ApprovedProductionLoadDecisionArtifact = {
  readonly path: string;
  readonly byteLength: number;
  readonly sha256: string;
  readonly decision: ProductionLoadDecision;
};

const maximumDecisionBytes = 64 * 1024;

function sameFile(
  left: { dev: number; ino: number },
  right: { dev: number; ino: number },
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameSnapshot(
  left: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number },
  right: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number },
): boolean {
  return sameFile(left, right)
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

export async function readApprovedProductionLoadDecision(
  options: ReadProductionLoadDecisionOptions,
): Promise<ApprovedProductionLoadDecisionArtifact> {
  const evidenceRoot = path.resolve(options.evidenceRoot);
  if (process.platform !== "win32" && await realpath(evidenceRoot) !== evidenceRoot) {
    throw new Error("Production load evidence root must not traverse a symbolic link.");
  }
  const decisionPath = path.join(evidenceRoot, "load-gate-decision.json");
  const metadata = await lstat(decisionPath);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error("Production load decision must be a regular file, not a symbolic link.");
  }
  const requiredMode = options.requiredMode === undefined
    ? (process.platform === "win32" ? null : 0o440)
    : options.requiredMode;
  if (requiredMode !== null && (metadata.mode & 0o777) !== requiredMode) {
    throw new Error(`Production load decision mode must be ${requiredMode.toString(8)}.`);
  }
  const requiredOwnerUid = options.requiredOwnerUid === undefined && process.platform !== "win32"
    ? 0
    : options.requiredOwnerUid;
  if (requiredOwnerUid !== undefined && metadata.uid !== requiredOwnerUid) {
    throw new Error("Production load decision owner is invalid.");
  }
  if (metadata.size <= 0 || metadata.size > maximumDecisionBytes) {
    throw new Error("Production load decision size is invalid.");
  }

  const noFollow = process.platform === "win32" ? 0 : (constants.O_NOFOLLOW ?? 0);
  const handle = await open(decisionPath, constants.O_RDONLY | noFollow);
  let bytes: Buffer;
  try {
    const before = await handle.stat();
    if (!sameFile(metadata, before)) {
      throw new Error("Production load decision changed while it was opened.");
    }
    bytes = await handle.readFile();
    const after = await handle.stat();
    if (!sameSnapshot(before, after) || bytes.byteLength !== after.size) {
      throw new Error("Production load decision changed while it was read.");
    }
  } finally {
    await handle.close();
  }

  if (bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))) {
    throw new Error("Production load decision must not contain a UTF-8 BOM.");
  }
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new Error("Production load decision must be valid JSON.");
  }
  if (`${JSON.stringify(parsed, null, 2)}\n` !== text) {
    throw new Error("Production load decision must be canonical two-space JSON with one LF.");
  }
  assertProductionLoadEvidenceSafe(parsed);
  const decision = validateProductionLoadDecision(parsed, options.expectedCandidate);
  return {
    path: decisionPath,
    byteLength: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    decision,
  };
}

export async function assertProductionLoadDecisionUnchanged(
  artifact: ApprovedProductionLoadDecisionArtifact,
  options: ReadProductionLoadDecisionOptions,
): Promise<void> {
  const current = await readApprovedProductionLoadDecision(options);
  if (current.path !== artifact.path
    || current.byteLength !== artifact.byteLength
    || current.sha256 !== artifact.sha256) {
    throw new Error("Production load decision changed after approval was loaded.");
  }
}

export type WriteProductionLoadReportOptions = {
  readonly evidenceRoot: string;
  readonly report: unknown;
};

export type ProductionLoadReportArtifact = {
  readonly path: string;
  readonly byteLength: number;
  readonly sha256: string;
};

async function syncDirectory(directory: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await open(directory, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function writeProductionLoadReportExclusive(
  options: WriteProductionLoadReportOptions,
): Promise<ProductionLoadReportArtifact> {
  assertProductionLoadEvidenceSafe(options.report);
  const evidenceRoot = path.resolve(options.evidenceRoot);
  if (process.platform !== "win32" && await realpath(evidenceRoot) !== evidenceRoot) {
    throw new Error("Production load evidence root must not traverse a symbolic link.");
  }
  const bytes = Buffer.from(`${JSON.stringify(options.report, null, 2)}\n`, "utf8");
  if (bytes.byteLength <= 0 || bytes.byteLength > 16 * 1024 * 1024) {
    throw new Error("Production load report size is invalid.");
  }
  const reportPath = path.join(evidenceRoot, "load-gate-report.json");
  const temporaryPath = path.join(
    evidenceRoot,
    `.load-gate-report.${process.pid}.${randomUUID()}.tmp`,
  );
  const handle = await open(temporaryPath, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.chmod(0o440);
  } finally {
    await handle.close();
  }

  try {
    await link(temporaryPath, reportPath);
    await unlink(temporaryPath);
    await syncDirectory(evidenceRoot);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    const code = error && typeof error === "object" && "code" in error
      ? String(error.code)
      : "unknown";
    throw new Error(`Production load report publication failed (${code}).`, { cause: error });
  }

  return {
    path: reportPath,
    byteLength: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

export type ProductionLoadTerminalReceipt = {
  readonly schemaVersion: 1;
  readonly generatedAt: string;
  readonly status: "FAIL" | "NOT_RUN";
  readonly stage:
    | "active_release"
    | "approval"
    | "baseline"
    | "workload"
    | "fault_matrix"
    | "report"
    | "publication";
  readonly failureCode: string;
  readonly candidate: ProductionLoadCandidate | null;
  readonly decisionSha256: string | null;
};

export async function writeProductionLoadTerminalReceiptExclusive(options: {
  readonly evidenceRoot: string;
  readonly receipt: ProductionLoadTerminalReceipt;
}): Promise<ProductionLoadReportArtifact> {
  const receipt = assertProductionLoadEvidenceSafe(options.receipt);
  const expectedKeys = [
    "schemaVersion",
    "generatedAt",
    "status",
    "stage",
    "failureCode",
    "candidate",
    "decisionSha256",
  ].sort();
  if (Object.keys(receipt).sort().join("\0") !== expectedKeys.join("\0")
    || receipt.schemaVersion !== 1
    || !["FAIL", "NOT_RUN"].includes(receipt.status)
    || ![
      "active_release",
      "approval",
      "baseline",
      "workload",
      "fault_matrix",
      "report",
      "publication",
    ].includes(receipt.stage)
    || !/^[a-z0-9_]{3,80}$/.test(receipt.failureCode)
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(receipt.generatedAt)
    || new Date(receipt.generatedAt).toISOString() !== receipt.generatedAt
    || (receipt.decisionSha256 !== null
      && !/^sha256:[0-9a-f]{64}$/.test(receipt.decisionSha256))) {
    throw new Error("Production load terminal receipt contains an invalid field or failure code.");
  }

  const evidenceRoot = path.resolve(options.evidenceRoot);
  if (process.platform !== "win32" && await realpath(evidenceRoot) !== evidenceRoot) {
    throw new Error("Production load evidence root must not traverse a symbolic link.");
  }
  const bytes = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  if (bytes.byteLength <= 0 || bytes.byteLength > 1024 * 1024) {
    throw new Error("Production load terminal receipt size is invalid.");
  }
  const receiptPath = path.join(evidenceRoot, "load-gate-terminal.json");
  const temporaryPath = path.join(
    evidenceRoot,
    `.load-gate-terminal.${process.pid}.${randomUUID()}.tmp`,
  );
  const handle = await open(temporaryPath, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.chmod(0o440);
  } finally {
    await handle.close();
  }
  try {
    await link(temporaryPath, receiptPath);
    await unlink(temporaryPath);
    await syncDirectory(evidenceRoot);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    const code = error && typeof error === "object" && "code" in error
      ? String(error.code)
      : "unknown";
    throw new Error(`Production load terminal receipt publication failed (${code}).`, {
      cause: error,
    });
  }
  return {
    path: receiptPath,
    byteLength: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}
