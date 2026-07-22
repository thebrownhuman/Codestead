import { createHash } from "node:crypto";
import { chmod, lstat, unlink } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import path from "node:path";

import type {
  ProductionLoadFixtureBinding,
  ProductionLoadFixtureOperations,
} from "./production-load-fixture-runtime";

const MAXIMUM_MESSAGE_BYTES = 64 * 1024;
const hashPattern = /^[0-9a-f]{64}$/;
const vmIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const vmMacPattern = /^52:54:00:20:00:12$/;
const timestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const faultIds = new Set([
  "runner_service_restart",
  "app_container_restart",
  "email_worker_restart",
  "assessment_regrade_worker_restart",
  "project_review_correction_worker_restart",
  "exam_finalization_worker_restart",
  "practice_recovery_worker_restart",
  "rewards_worker_restart",
  "postgres_proxy_interruption",
  "tunnel_proxy_interruption",
  "fake_gmail_failure",
  "fake_ai_provider_failure",
  "fake_offsite_drive_failure",
  "quota_volume_near_full",
  "synthetic_stale_backup_alert",
] as const);

type FaultId = typeof faultIds extends Set<infer Value> ? Value & string : never;

export type ProductionLoadFixtureRuntimeDispatcher = {
  dispatch(body: Buffer, signal?: AbortSignal): Promise<Buffer>;
  close(): Promise<void>;
};

export type CreateProductionLoadFixtureRuntimeDispatcherOptions = {
  readonly operations: ProductionLoadFixtureOperations;
  readonly maximumConcurrentRequests: 2;
  readonly requestTimeoutMs: number;
};

function fail(): never {
  throw new Error("fixture_request_failed");
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length
    && actual.every((key, index) => key === keys[index]);
}

function canonical(value: unknown): Buffer {
  const output = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
  if (output.byteLength < 1 || output.byteLength > MAXIMUM_MESSAGE_BYTES) fail();
  return output;
}

function stableFailure(): Buffer {
  return canonical({ ok: false, result: null });
}

function parseCanonical(body: Buffer): Record<string, unknown> {
  if (!Buffer.isBuffer(body)
    || body.byteLength < 2
    || body.byteLength > MAXIMUM_MESSAGE_BYTES) fail();
  let value: unknown;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(body);
    if (text.includes("\0") || text.includes("\r") || !text.endsWith("\n")) fail();
    value = JSON.parse(text) as unknown;
  } catch {
    fail();
  }
  const item = record(value);
  if (!item || !body.equals(canonical(item))) fail();
  return item;
}

function fault(value: unknown): FaultId {
  if (typeof value !== "string" || !faultIds.has(value as FaultId)) fail();
  return value as FaultId;
}

function finite(value: unknown, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)
    || value < minimum || value > maximum) fail();
  return value;
}

function integer(value: unknown): number {
  const parsed = finite(value, 0, Number.MAX_SAFE_INTEGER);
  if (!Number.isSafeInteger(parsed)) fail();
  return parsed;
}

function validateResult(action: string, raw: unknown): unknown {
  const item = record(raw);
  if (action === "runtime-health") {
    if (!item || !exactKeys(item, ["ready"]) || item.ready !== true) fail();
    return { ready: true };
  }
  if (action === "assert-ready") {
    if (!item || !exactKeys(item, ["bindingSha256", "ready"])
      || typeof item.bindingSha256 !== "string"
      || !hashPattern.test(item.bindingSha256)
      || item.ready !== true) fail();
    return { bindingSha256: item.bindingSha256, ready: true };
  }
  if (action === "reset" || action === "inject-and-release" || action === "browser-journey") {
    if (raw !== null) fail();
    return null;
  }
  if (action === "isolation-status") {
    if (!item || !exactKeys(item, ["maintenanceWindowApproved", "freshRecoveryPoint"])
      || typeof item.maintenanceWindowApproved !== "boolean"
      || typeof item.freshRecoveryPoint !== "boolean") fail();
    return {
      maintenanceWindowApproved: item.maintenanceWindowApproved,
      freshRecoveryPoint: item.freshRecoveryPoint,
    };
  }
  if (action === "host-telemetry") {
    const keys = [
      "hostCpuPercent", "availableMemoryBytes", "rootFreeFraction", "rootFreeBytes",
      "diskReadBytes", "diskWriteBytes", "temperatureCelsius", "oomKills",
      "thermalThrottleIncrements",
    ];
    if (!item || !exactKeys(item, keys)) fail();
    return {
      hostCpuPercent: finite(item.hostCpuPercent, 0, 100),
      availableMemoryBytes: integer(item.availableMemoryBytes),
      rootFreeFraction: finite(item.rootFreeFraction, 0, 1),
      rootFreeBytes: integer(item.rootFreeBytes),
      diskReadBytes: integer(item.diskReadBytes),
      diskWriteBytes: integer(item.diskWriteBytes),
      temperatureCelsius: finite(item.temperatureCelsius, -100, 250),
      oomKills: integer(item.oomKills),
      thermalThrottleIncrements: integer(item.thermalThrottleIncrements),
    };
  }
  if (action === "runner-vm-telemetry") {
    if (!item || !exactKeys(item, ["runnerVmCpuPercent", "runnerVmAvailableMemoryBytes"])) {
      fail();
    }
    return {
      runnerVmCpuPercent: finite(item.runnerVmCpuPercent, 0, 100),
      runnerVmAvailableMemoryBytes: integer(item.runnerVmAvailableMemoryBytes),
    };
  }
  if (action === "probe") {
    if (!item || !exactKeys(item, ["componentHealthy", "alertOrDeadLetterVisible"])
      || typeof item.componentHealthy !== "boolean"
      || typeof item.alertOrDeadLetterVisible !== "boolean") fail();
    return {
      componentHealthy: item.componentHealthy,
      alertOrDeadLetterVisible: item.alertOrDeadLetterVisible,
    };
  }
  if (action === "invariant-evidence") {
    if (!item || !exactKeys(item, [
      "observedAt", "acknowledgedMutationFailures", "runnerMaxConcurrentJobs",
      "secretLeakFindings",
    ])
      || typeof item.observedAt !== "string"
      || !timestampPattern.test(item.observedAt)
      || new Date(item.observedAt).toISOString() !== item.observedAt) fail();
    return {
      observedAt: item.observedAt,
      acknowledgedMutationFailures: integer(item.acknowledgedMutationFailures),
      runnerMaxConcurrentJobs: integer(item.runnerMaxConcurrentJobs),
      secretLeakFindings: integer(item.secretLeakFindings),
    };
  }
  fail();
}

function bindingDigest(value: unknown): { binding: ProductionLoadFixtureBinding; digest: string } {
  const item = record(value);
  if (!item || !exactKeys(item, [
    "profile", "project", "fixtureRoot", "runtimeSocket", "candidate",
    "candidateRunIdentitySha256", "decisionSha256",
    "expectedUnrelatedInventorySha256",
  ])) fail();
  const bytes = canonical(item);
  return {
    binding: item as ProductionLoadFixtureBinding,
    digest: createHash("sha256").update(bytes).digest("hex"),
  };
}

export function createProductionLoadFixtureRuntimeDispatcher(
  options: CreateProductionLoadFixtureRuntimeDispatcherOptions,
): ProductionLoadFixtureRuntimeDispatcher {
  if (options.maximumConcurrentRequests !== 2
    || !Number.isSafeInteger(options.requestTimeoutMs)
    || options.requestTimeoutMs < 1
    || options.requestTimeoutMs > 125_000) fail();
  let active = 0;
  let closed = false;
  let bindingSha256: string | null = null;
  let bindingInFlight = false;
  const controllers = new Set<AbortController>();

  const invoke = async (request: Record<string, unknown>, signal: AbortSignal): Promise<unknown> => {
    if (request.version !== 1 || typeof request.action !== "string") fail();
    const action = request.action;
    if (action === "runtime-health") {
      if (!exactKeys(request, ["version", "action"])) fail();
      return { ready: true };
    }
    if (action === "assert-ready") {
      if (!exactKeys(request, ["version", "action", "binding"]) || bindingInFlight) fail();
      const resolved = bindingDigest(request.binding);
      if (bindingSha256 !== null && bindingSha256 !== resolved.digest) fail();
      bindingInFlight = true;
      try {
        await options.operations.assertReady(resolved.binding, signal);
        bindingSha256 = resolved.digest;
        return { bindingSha256: resolved.digest, ready: true };
      } finally {
        bindingInFlight = false;
      }
    }
    if (bindingSha256 === null
      || typeof request.bindingSha256 !== "string"
      || request.bindingSha256 !== bindingSha256) fail();

    if (action === "isolation-status") {
      if (!exactKeys(request, ["version", "action", "bindingSha256"])) fail();
      return options.operations.isolationStatus(signal);
    }
    if (action === "host-telemetry") {
      if (!exactKeys(request, ["version", "action", "bindingSha256"])) fail();
      return options.operations.hostTelemetry(signal);
    }
    if (action === "runner-vm-telemetry") {
      if (!exactKeys(request, [
        "version", "action", "bindingSha256", "runnerVmId", "runnerVmMac",
      ]) || typeof request.runnerVmId !== "string" || !vmIdPattern.test(request.runnerVmId)
        || typeof request.runnerVmMac !== "string" || !vmMacPattern.test(request.runnerVmMac)) {
        fail();
      }
      return options.operations.runnerVmTelemetry(
        request.runnerVmId,
        request.runnerVmMac,
        signal,
      );
    }
    if (action === "reset" || action === "inject-and-release") {
      if (!exactKeys(request, [
        "version", "action", "bindingSha256", "faultId",
      ])) fail();
      const faultId = fault(request.faultId);
      if (action === "reset") {
        await options.operations.reset(faultId, signal);
      } else {
        await options.operations.injectAndRelease(faultId, signal);
      }
      return null;
    }
    if (action === "probe") {
      if (!exactKeys(request, [
        "version", "action", "bindingSha256", "faultId", "phase",
      ]) || (request.phase !== "baseline" && request.phase !== "recovery")) fail();
      return options.operations.probe(fault(request.faultId), request.phase, signal);
    }
    if (action === "browser-journey") {
      if (!exactKeys(request, [
        "version", "action", "bindingSha256", "faultId", "stage",
      ]) || (request.stage !== "steady" && request.stage !== "recovered")) fail();
      await options.operations.browserJourney(fault(request.faultId), request.stage, signal);
      return null;
    }
    if (action === "invariant-evidence") {
      if (!exactKeys(request, [
        "version", "action", "bindingSha256", "faultId",
      ])) fail();
      return options.operations.invariantEvidence(fault(request.faultId), signal);
    }
    fail();
  };

  return {
    async dispatch(body, callerSignal) {
      if (closed || active >= options.maximumConcurrentRequests) return stableFailure();
      active += 1;
      const controller = new AbortController();
      controllers.add(controller);
      const relay = () => controller.abort();
      callerSignal?.addEventListener("abort", relay, { once: true });
      if (callerSignal?.aborted) relay();
      const timer = setTimeout(relay, options.requestTimeoutMs);
      timer.unref();
      let operationSettled = false;
      const releaseSlot = () => {
        if (operationSettled) return;
        operationSettled = true;
        controllers.delete(controller);
        active -= 1;
      };
      const operation = (async () => {
        try {
          if (controller.signal.aborted) fail();
          const request = parseCanonical(body);
          const result = await invoke(request, controller.signal);
          if (controller.signal.aborted) fail();
          return canonical({ ok: true, result: validateResult(request.action as string, result) });
        } catch {
          return stableFailure();
        }
      })().finally(releaseSlot);
      let removeAbortListener: () => void = () => undefined;
      const aborted = new Promise<Buffer>((resolve) => {
        const onAbort = () => resolve(stableFailure());
        removeAbortListener = () => controller.signal.removeEventListener("abort", onAbort);
        if (controller.signal.aborted) onAbort();
        else controller.signal.addEventListener("abort", onAbort, { once: true });
      });
      try {
        return await Promise.race([operation, aborted]);
      } finally {
        clearTimeout(timer);
        removeAbortListener();
        callerSignal?.removeEventListener("abort", relay);
      }
    },
    async close() {
      if (closed) return;
      closed = true;
      for (const controller of controllers) controller.abort();
      await options.operations.close();
    },
  };
}

export const PRODUCTION_LOAD_FIXTURE_RUNTIME_INTERNAL_SOCKET =
  "/run/learncoding-production-load-fixtures/runtime.sock";

const FIXTURE_RUNTIME_UID = 65_532;
const FIXTURE_RUNTIME_GID = 65_532;

export type ProductionLoadFixtureRuntimeSocketStat = {
  readonly uid: number;
  readonly gid: number;
  readonly mode: number;
  readonly nlink: number;
  readonly dev: number;
  readonly ino: number;
  isDirectory(): boolean;
  isSocket(): boolean;
  isSymbolicLink(): boolean;
};

function unixFail(code: string): never {
  throw new Error(`Production load fixture Unix server failed: ${code}`);
}

export function validateProductionLoadFixtureRuntimeSocketParent(
  value: ProductionLoadFixtureRuntimeSocketStat,
): void {
  if (!value.isDirectory()
    || value.isSymbolicLink()
    || value.uid !== FIXTURE_RUNTIME_UID
    || value.gid !== FIXTURE_RUNTIME_GID
    || value.nlink < 1
    || (value.mode & 0o777) !== 0o700) {
    unixFail("unsafe_runtime_socket_parent");
  }
}

export function validateProductionLoadFixtureRuntimeSocket(
  value: ProductionLoadFixtureRuntimeSocketStat,
): void {
  if (!value.isSocket()
    || value.isSymbolicLink()
    || value.uid !== FIXTURE_RUNTIME_UID
    || value.gid !== FIXTURE_RUNTIME_GID
    || value.nlink !== 1
    || (value.mode & 0o777) !== 0o600
    || !Number.isSafeInteger(value.dev)
    || value.dev < 0
    || !Number.isSafeInteger(value.ino)
    || value.ino <= 0) {
    unixFail("unsafe_runtime_socket");
  }
}

function listen(server: Server, socketPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(socketPath);
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

function socketIsActive(socketPath: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      socket.destroy();
      if (error.code === "ENOENT" || error.code === "ECONNREFUSED") resolve(false);
      else reject(error);
    });
  });
}

async function prepareFixtureRuntimeSocket(
  socketPath: string,
  inspect: (target: string) => Promise<ProductionLoadFixtureRuntimeSocketStat>,
): Promise<void> {
  if (socketPath !== PRODUCTION_LOAD_FIXTURE_RUNTIME_INTERNAL_SOCKET
    || path.posix.normalize(socketPath) !== socketPath) {
    unixFail("invalid_runtime_socket_path");
  }
  let parent: ProductionLoadFixtureRuntimeSocketStat;
  try {
    parent = await inspect(path.posix.dirname(socketPath));
  } catch {
    unixFail("unsafe_runtime_socket_parent");
  }
  validateProductionLoadFixtureRuntimeSocketParent(parent);
  let existing: ProductionLoadFixtureRuntimeSocketStat;
  try {
    existing = await inspect(socketPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    unixFail("unsafe_runtime_socket");
  }
  validateProductionLoadFixtureRuntimeSocket(existing);
  if (await socketIsActive(socketPath).catch(() => unixFail("unsafe_runtime_socket"))) {
    unixFail("runtime_socket_in_use");
  }
  await unlink(socketPath).catch(() => unixFail("unsafe_runtime_socket"));
}

export async function startProductionLoadFixtureRuntimeUnixServer(options: {
  readonly dispatcher: ProductionLoadFixtureRuntimeDispatcher;
  readonly socketPath?: string;
  readonly requestTimeoutMs?: number;
  readonly platform?: NodeJS.Platform;
  readonly uid?: number;
  readonly gid?: number;
  readonly inspect?: (
    target: string,
  ) => Promise<ProductionLoadFixtureRuntimeSocketStat>;
}): Promise<{ readonly socketPath: string; close(): Promise<void> }> {
  const platform = options.platform ?? process.platform;
  const uid = options.uid ?? process.getuid?.() ?? -1;
  const gid = options.gid ?? process.getgid?.() ?? -1;
  const socketPath = options.socketPath ?? PRODUCTION_LOAD_FIXTURE_RUNTIME_INTERNAL_SOCKET;
  const requestTimeoutMs = options.requestTimeoutMs ?? 125_000;
  const inspect = options.inspect ?? lstat;
  if (platform !== "linux" || uid !== FIXTURE_RUNTIME_UID || gid !== FIXTURE_RUNTIME_GID) {
    unixFail("dedicated_identity_required");
  }
  if (!Number.isSafeInteger(requestTimeoutMs)
    || requestTimeoutMs < 1
    || requestTimeoutMs > 125_000) unixFail("invalid_timeout");
  await prepareFixtureRuntimeSocket(socketPath, inspect);

  let closing = false;
  const sockets = new Set<Socket>();
  const controllers = new Set<AbortController>();
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    if (closing) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    const controller = new AbortController();
    controllers.add(controller);
    const chunks: Buffer[] = [];
    let bytes = 0;
    let requestEnded = false;
    const abort = () => controller.abort();
    socket.setTimeout(requestTimeoutMs, () => {
      abort();
      socket.destroy();
    });
    socket.once("error", abort);
    socket.once("close", () => {
      if (!requestEnded) abort();
      sockets.delete(socket);
      controllers.delete(controller);
    });
    socket.on("data", (raw: Buffer | string) => {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      bytes += chunk.byteLength;
      if (bytes > MAXIMUM_MESSAGE_BYTES) {
        abort();
        socket.end(stableFailure());
        return;
      }
      chunks.push(chunk);
    });
    socket.once("end", () => {
      requestEnded = true;
      if (bytes > MAXIMUM_MESSAGE_BYTES) return;
      void options.dispatcher.dispatch(
        Buffer.concat(chunks, bytes),
        controller.signal,
      ).then(
        (response) => { if (!socket.destroyed) socket.end(response); },
        () => { if (!socket.destroyed) socket.end(stableFailure()); },
      );
    });
  });
  server.maxConnections = 2;

  try {
    await listen(server, socketPath);
    await chmod(socketPath, 0o600);
    const created = await inspect(socketPath);
    validateProductionLoadFixtureRuntimeSocket(created);
    let closePromise: Promise<void> | null = null;
    return {
      socketPath,
      close() {
        closePromise ??= (async () => {
          closing = true;
          for (const controller of controllers) controller.abort();
          for (const socket of sockets) socket.destroy();
          await closeServer(server);
          await options.dispatcher.close();
          try {
            const current = await inspect(socketPath);
            if (current.isSocket()
              && current.dev === created.dev
              && current.ino === created.ino) {
              await unlink(socketPath);
            }
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
        })();
        return closePromise;
      },
    };
  } catch (error) {
    closing = true;
    for (const controller of controllers) controller.abort();
    for (const socket of sockets) socket.destroy();
    if (server.listening) await closeServer(server).catch(() => undefined);
    try {
      const current = await inspect(socketPath);
      if (current.isSocket()) await unlink(socketPath);
    } catch (cleanupError) {
      if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") {
        throw cleanupError;
      }
    }
    throw error;
  }
}
