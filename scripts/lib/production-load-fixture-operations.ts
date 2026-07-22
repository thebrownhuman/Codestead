import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import { lstat } from "node:fs/promises";
import { createConnection } from "node:net";
import path from "node:path";

import type { ProductionLoadFixtureOperations } from "./production-load-fixture-runtime";

const FIXTURE_SOCKET = "/run/learncoding-production-load-fixtures/runtime.sock";
const MAXIMUM_MESSAGE_BYTES = 64 * 1024;
const EXCHANGE_TIMEOUT_MS = 125_000;
const hashPattern = /^[0-9a-f]{64}$/;
const timestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export type ProductionLoadFixtureExchange = (
  request: Buffer,
  signal: AbortSignal,
) => Promise<Buffer>;

export type CreateProductionLoadFixtureUnixOperationsOptions = {
  readonly exchange?: ProductionLoadFixtureExchange;
};

function fail(code: string): never {
  throw new Error(`Production load fixture operations failed: ${code}`);
}

function canonical(value: unknown): Buffer {
  const output = Buffer.from(JSON.stringify(value) + "\n", "utf8");
  if (output.byteLength > MAXIMUM_MESSAGE_BYTES) fail("request_too_large");
  return output;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return Object.keys(value).join(",") === expected.join(",");
}

function safeNumber(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === "number" && Number.isFinite(value)
    && value >= minimum && value <= maximum;
}

function safeInteger(value: unknown, maximum = Number.MAX_SAFE_INTEGER): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= maximum;
}

function parseCanonicalResponse(output: Buffer): unknown {
  if (!Buffer.isBuffer(output)
    || output.byteLength < 1
    || output.byteLength > MAXIMUM_MESSAGE_BYTES) fail("fixture_operation_failed");
  let value: unknown;
  try {
    value = JSON.parse(output.toString("utf8"));
  } catch {
    fail("fixture_operation_failed");
  }
  if (!output.equals(Buffer.from(JSON.stringify(value) + "\n", "utf8"))) {
    fail("fixture_operation_failed");
  }
  const envelope = record(value);
  if (!envelope || !exactKeys(envelope, ["ok", "result"]) || envelope.ok !== true) {
    fail("fixture_operation_failed");
  }
  return envelope.result;
}

function validateSocketStat(value: Stats, kind: "parent" | "socket") {
  if (value.uid !== 65_532 || value.gid !== 65_532 || value.isSymbolicLink()) {
    fail("fixture_operation_failed");
  }
  if (kind === "parent") {
    if (!value.isDirectory() || (value.mode & 0o777) !== 0o700) {
      fail("fixture_operation_failed");
    }
    return;
  }
  if (!value.isSocket() || value.nlink !== 1 || (value.mode & 0o777) !== 0o600) {
    fail("fixture_operation_failed");
  }
}

const exchangeUnix: ProductionLoadFixtureExchange = async (request, signal) => {
  if (signal.aborted) fail("aborted");
  if (request.byteLength < 1 || request.byteLength > MAXIMUM_MESSAGE_BYTES) {
    fail("fixture_operation_failed");
  }
  let parent;
  let socketStat;
  try {
    [parent, socketStat] = await Promise.all([
      lstat(path.posix.dirname(FIXTURE_SOCKET)),
      lstat(FIXTURE_SOCKET),
    ]);
  } catch {
    fail("fixture_operation_failed");
  }
  validateSocketStat(parent, "parent");
  validateSocketStat(socketStat, "socket");
  if (signal.aborted) fail("aborted");

  return new Promise<Buffer>((resolve, reject) => {
    const socket = createConnection(FIXTURE_SOCKET);
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const finish = (error?: Error, response?: Buffer) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      socket.destroy();
      if (error || !response) reject(new Error("fixture_operation_failed"));
      else resolve(response);
    };
    const onAbort = () => finish(new Error("aborted"));
    const timer = setTimeout(
      () => finish(new Error("fixture_operation_failed")),
      EXCHANGE_TIMEOUT_MS,
    );
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    socket.once("connect", () => socket.end(request));
    socket.on("data", (raw: Buffer | string) => {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      bytes += chunk.byteLength;
      if (bytes > MAXIMUM_MESSAGE_BYTES) {
        finish(new Error("fixture_operation_failed"));
        return;
      }
      chunks.push(chunk);
    });
    socket.once("end", () => finish(undefined, Buffer.concat(chunks, bytes)));
    socket.once("error", () => finish(new Error("fixture_operation_failed")));
  });
};

function validateIsolation(value: unknown) {
  const item = record(value);
  if (!item || !exactKeys(item, ["maintenanceWindowApproved", "freshRecoveryPoint"])
    || typeof item.maintenanceWindowApproved !== "boolean"
    || typeof item.freshRecoveryPoint !== "boolean") fail("fixture_operation_failed");
  return {
    maintenanceWindowApproved: item.maintenanceWindowApproved,
    freshRecoveryPoint: item.freshRecoveryPoint,
  };
}

function validateHostTelemetry(value: unknown) {
  const item = record(value);
  const keys = ["hostCpuPercent", "availableMemoryBytes", "rootFreeFraction",
    "rootFreeBytes", "diskReadBytes", "diskWriteBytes", "temperatureCelsius",
    "oomKills", "thermalThrottleIncrements"] as const;
  if (!item || !exactKeys(item, keys)
    || !safeNumber(item.hostCpuPercent, 0, 100)
    || !safeInteger(item.availableMemoryBytes)
    || !safeNumber(item.rootFreeFraction, 0, 1)
    || !safeInteger(item.rootFreeBytes)
    || !safeInteger(item.diskReadBytes)
    || !safeInteger(item.diskWriteBytes)
    || !safeNumber(item.temperatureCelsius, -100, 250)
    || !safeInteger(item.oomKills)
    || !safeInteger(item.thermalThrottleIncrements)) fail("fixture_operation_failed");
  return item as ReturnType<ProductionLoadFixtureOperations["hostTelemetry"]> extends Promise<infer T>
    ? T : never;
}

function validateRunnerTelemetry(value: unknown) {
  const item = record(value);
  if (!item || !exactKeys(item, ["runnerVmCpuPercent", "runnerVmAvailableMemoryBytes"])
    || !safeNumber(item.runnerVmCpuPercent, 0, 100)
    || !safeInteger(item.runnerVmAvailableMemoryBytes)) fail("fixture_operation_failed");
  return {
    runnerVmCpuPercent: item.runnerVmCpuPercent,
    runnerVmAvailableMemoryBytes: item.runnerVmAvailableMemoryBytes,
  };
}

function validateProbe(value: unknown) {
  const item = record(value);
  if (!item || !exactKeys(item, ["componentHealthy", "alertOrDeadLetterVisible"])
    || typeof item.componentHealthy !== "boolean"
    || typeof item.alertOrDeadLetterVisible !== "boolean") fail("fixture_operation_failed");
  return {
    componentHealthy: item.componentHealthy,
    alertOrDeadLetterVisible: item.alertOrDeadLetterVisible,
  };
}

function validateInvariants(value: unknown) {
  const item = record(value);
  if (!item || !exactKeys(item, ["observedAt", "acknowledgedMutationFailures",
    "runnerMaxConcurrentJobs", "secretLeakFindings"])
    || typeof item.observedAt !== "string" || !timestampPattern.test(item.observedAt)
    || !safeInteger(item.acknowledgedMutationFailures)
    || item.runnerMaxConcurrentJobs !== 2
    || !safeInteger(item.secretLeakFindings)) fail("fixture_operation_failed");
  return {
    observedAt: item.observedAt,
    acknowledgedMutationFailures: item.acknowledgedMutationFailures,
    runnerMaxConcurrentJobs: 2,
    secretLeakFindings: item.secretLeakFindings,
  };
}

export function createProductionLoadFixtureUnixOperations(
  options: CreateProductionLoadFixtureUnixOperationsOptions = {},
): ProductionLoadFixtureOperations {
  const exchange = options.exchange ?? exchangeUnix;
  let bindingSha256: string | null = null;
  let closed = false;

  const call = async (request: unknown, signal: AbortSignal): Promise<unknown> => {
    if (closed) fail("closed");
    if (signal.aborted) fail("aborted");
    let output: Buffer;
    try {
      output = await exchange(canonical(request), signal);
    } catch {
      if (signal.aborted) fail("aborted");
      fail("fixture_operation_failed");
    }
    if (signal.aborted) fail("aborted");
    return parseCanonicalResponse(output);
  };

  const readyDigest = () => {
    if (!bindingSha256) fail("fixture_not_ready");
    return bindingSha256;
  };

  return {
    async assertReady(binding, signal) {
      if (closed) fail("closed");
      const digest = createHash("sha256").update(canonical(binding)).digest("hex");
      if (bindingSha256 && bindingSha256 !== digest) fail("binding_rejected");
      const value = record(await call({ version: 1, action: "assert-ready", binding }, signal));
      if (!value || !exactKeys(value, ["bindingSha256", "ready"])
        || value.bindingSha256 !== digest || value.ready !== true
        || !hashPattern.test(digest)) fail("binding_rejected");
      bindingSha256 = digest;
    },
    async isolationStatus(signal) {
      return validateIsolation(await call({
        version: 1, action: "isolation-status", bindingSha256: readyDigest(),
      }, signal));
    },
    async hostTelemetry(signal) {
      return validateHostTelemetry(await call({
        version: 1, action: "host-telemetry", bindingSha256: readyDigest(),
      }, signal));
    },
    async runnerVmTelemetry(runnerVmId, runnerVmMac, signal) {
      return validateRunnerTelemetry(await call({
        version: 1, action: "runner-vm-telemetry", bindingSha256: readyDigest(),
        runnerVmId, runnerVmMac,
      }, signal));
    },
    async reset(faultId, signal) {
      const value = await call({
        version: 1, action: "reset", bindingSha256: readyDigest(), faultId,
      }, signal);
      if (value !== null) fail("fixture_operation_failed");
    },
    async injectAndRelease(faultId, signal) {
      const value = await call({
        version: 1, action: "inject-and-release", bindingSha256: readyDigest(), faultId,
      }, signal);
      if (value !== null) fail("fixture_operation_failed");
    },
    async probe(faultId, phase, signal) {
      return validateProbe(await call({
        version: 1, action: "probe", bindingSha256: readyDigest(), faultId, phase,
      }, signal));
    },
    async browserJourney(faultId, stage, signal) {
      const value = await call({
        version: 1, action: "browser-journey", bindingSha256: readyDigest(), faultId, stage,
      }, signal);
      if (value !== null) fail("fixture_operation_failed");
    },
    async invariantEvidence(faultId, signal) {
      return validateInvariants(await call({
        version: 1, action: "invariant-evidence", bindingSha256: readyDigest(), faultId,
      }, signal));
    },
    async close() {
      closed = true;
    },
  };
}
