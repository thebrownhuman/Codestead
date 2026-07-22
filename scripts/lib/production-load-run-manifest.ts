import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { TextDecoder } from "node:util";

import type { ProductionLoadCandidate } from "../../src/lib/performance/load-report";

export const PRODUCTION_LOAD_RUN_MANIFEST_PATH =
  "/etc/learncoding/production-load-manifest.json";

export type ProductionLoadRunManifest = {
  readonly schemaVersion: 1;
  readonly decisionSha256: string;
  readonly candidate: ProductionLoadCandidate;
  readonly runnerVmId: string;
  readonly expectedUnrelatedInventorySha256: string;
  readonly validFrom: string;
  readonly validUntil: string;
};

export type ApprovedProductionLoadRunManifestArtifact = {
  readonly path: string;
  readonly byteLength: number;
  readonly sha256: string;
  readonly candidateRunIdentitySha256: string;
  readonly manifest: ProductionLoadRunManifest;
};

export type ValidateProductionLoadRunManifestOptions = {
  readonly value: unknown;
  readonly expectedCandidate: ProductionLoadCandidate;
  readonly expectedDecisionSha256: string;
  readonly now: Date;
  readonly validityMode?: "current" | "recovery";
};

export type ReadProductionLoadRunManifestOptions = Omit<
  ValidateProductionLoadRunManifestOptions,
  "value"
> & {
  readonly manifestPath?: string;
  readonly requiredOwnerUid?: number;
  readonly requiredMode?: number | null;
};

const maximumManifestBytes = 64 * 1024;
const manifestFields = [
  "schemaVersion",
  "decisionSha256",
  "candidate",
  "runnerVmId",
  "expectedUnrelatedInventorySha256",
  "validFrom",
  "validUntil",
] as const;
const candidateFields = [
  "gitSha",
  "gitTree",
  "releaseManifestSha256",
  "applicationImageRecordSha256",
  "composeProject",
  "composeWorkdir",
  "publicOrigin",
  "managedInventorySha256",
  "firewallPolicySha256",
  "runnerGuestReleaseSha256",
  "runnerImageRecordSha256",
  "nucHostId",
  "runnerVmId",
  "datasetId",
] as const;

function fail(code: string): never {
  throw new Error(`Production load run manifest failed: ${code}`);
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function exactOrderedKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value);
  return actual.length === expected.length
    && actual.every((field, index) => field === expected[index]);
}

function canonicalTimestamp(value: unknown): number {
  if (typeof value !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    fail("invalid_validity_window");
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    fail("invalid_validity_window");
  }
  return milliseconds;
}

export function validateProductionLoadRunManifest(
  options: ValidateProductionLoadRunManifestOptions,
): ProductionLoadRunManifest {
  const value = record(options.value);
  const expectedCandidate = options.expectedCandidate as unknown as Record<string, unknown>;
  const candidate = value ? record(value.candidate) : null;
  if (!value
    || !exactOrderedKeys(value, manifestFields)
    || value.schemaVersion !== 1
    || !candidate
    || !exactOrderedKeys(candidate, candidateFields)
    || !exactOrderedKeys(expectedCandidate, candidateFields)) {
    fail("invalid_schema");
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(options.expectedDecisionSha256)
    || value.decisionSha256 !== options.expectedDecisionSha256) {
    fail("decision_mismatch");
  }
  for (const field of candidateFields) {
    if (candidate[field] !== expectedCandidate[field]) fail("candidate_mismatch");
  }
  if (value.runnerVmId !== options.expectedCandidate.runnerVmId
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      String(value.runnerVmId),
    )) {
    fail("runner_vm_mismatch");
  }
  if (typeof value.expectedUnrelatedInventorySha256 !== "string"
    || !/^[0-9a-f]{64}$/.test(value.expectedUnrelatedInventorySha256)) {
    fail("invalid_unrelated_inventory");
  }
  const now = options.now.getTime();
  const validFrom = canonicalTimestamp(value.validFrom);
  const validUntil = canonicalTimestamp(value.validUntil);
  if (!Number.isFinite(now)
    || validUntil <= validFrom
    || validUntil - validFrom > 24 * 60 * 60 * 1_000
    || now < validFrom
    || ((options.validityMode ?? "current") === "current" && now > validUntil)) {
    fail("invalid_validity_window");
  }
  return value as ProductionLoadRunManifest;
}

function sameSnapshot(
  left: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number },
  right: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number },
): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

export async function readApprovedProductionLoadRunManifest(
  options: ReadProductionLoadRunManifestOptions,
): Promise<ApprovedProductionLoadRunManifestArtifact> {
  const manifestPath = path.resolve(options.manifestPath ?? PRODUCTION_LOAD_RUN_MANIFEST_PATH);
  if (!path.isAbsolute(manifestPath) || manifestPath === path.parse(manifestPath).root) {
    fail("invalid_path");
  }
  if (process.platform !== "win32") {
    let parent: string;
    try {
      parent = await realpath(path.dirname(manifestPath));
    } catch {
      fail("unsafe_file");
    }
    if (parent !== path.dirname(manifestPath)) fail("unsafe_file");
  }
  let metadata;
  try {
    metadata = await lstat(manifestPath);
  } catch {
    fail("unsafe_file");
  }
  const requiredMode = options.requiredMode === undefined
    ? (process.platform === "win32" ? null : 0o600)
    : options.requiredMode;
  const requiredOwnerUid = options.requiredOwnerUid === undefined && process.platform !== "win32"
    ? 0
    : options.requiredOwnerUid;
  if (metadata.isSymbolicLink()
    || !metadata.isFile()
    || metadata.nlink !== 1
    || (requiredMode !== null && (metadata.mode & 0o777) !== requiredMode)
    || (requiredOwnerUid !== undefined && metadata.uid !== requiredOwnerUid)
    || metadata.size <= 0
    || metadata.size > maximumManifestBytes) {
    fail("unsafe_file");
  }

  const noFollow = process.platform === "win32" ? 0 : (constants.O_NOFOLLOW ?? 0);
  let bytes: Buffer;
  try {
    const handle = await open(manifestPath, constants.O_RDONLY | noFollow);
    try {
      const before = await handle.stat();
      if (!sameSnapshot(metadata, before)) fail("file_changed");
      bytes = await handle.readFile();
      const after = await handle.stat();
      if (!sameSnapshot(before, after) || bytes.byteLength !== after.size) fail("file_changed");
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Production load run manifest failed:")) {
      throw error;
    }
    fail("unsafe_file");
  }
  if (bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))) fail("invalid_encoding");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail("invalid_encoding");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    fail("invalid_json");
  }
  if (`${JSON.stringify(parsed, null, 2)}\n` !== text) fail("noncanonical_json");
  const manifest = validateProductionLoadRunManifest({
    value: parsed,
    expectedCandidate: options.expectedCandidate,
    expectedDecisionSha256: options.expectedDecisionSha256,
    now: options.now,
    validityMode: options.validityMode,
  });
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return {
    path: manifestPath,
    byteLength: bytes.byteLength,
    sha256,
    candidateRunIdentitySha256: `sha256:${sha256}`,
    manifest,
  };
}

export async function assertProductionLoadRunManifestUnchanged(
  artifact: ApprovedProductionLoadRunManifestArtifact,
  options: ReadProductionLoadRunManifestOptions,
): Promise<void> {
  const current = await readApprovedProductionLoadRunManifest(options);
  if (current.path !== artifact.path
    || current.byteLength !== artifact.byteLength
    || current.sha256 !== artifact.sha256) {
    fail("manifest_changed");
  }
}
