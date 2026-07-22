import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { chmod, chown, lstat, unlink } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import path from "node:path";

const MAXIMUM_MESSAGE_BYTES = 64 * 1024;
const MAXIMUM_PEER_CREDENTIAL_BYTES = 256;
const PEER_CREDENTIAL_TIMEOUT_MS = 2_000;
const PEER_CREDENTIAL_HELPER =
  "/opt/learncoding/infra/ops/production-load-peer-credentials.py";
const PYTHON_INTERPRETER = "/usr/bin/python3.12";
export const PRODUCTION_LOAD_TEST_CONTROL_SOCKET =
  "/run/learncoding/codestead-production-load-test-control.sock";

const VM_MAC = "52:54:00:20:00:12";
const RUNNER_DOMAIN = "codestead-runner";
const RUNNER_UNIT = "learncoding-runner.service";
const REPOSITORY_ROOT = "/opt/learncoding";
const RUNNER_STATE_ROOT = "/var/lib/learncoding-runner";

const serviceTargets = {
  app_container_restart: "app",
  email_worker_restart: "mail-worker",
  assessment_regrade_worker_restart: "regrade-worker",
  project_review_correction_worker_restart: "project-review-correction-worker",
  exam_finalization_worker_restart: "exam-finalization-worker",
  practice_recovery_worker_restart: "practice-runner-recovery-worker",
  rewards_worker_restart: "reward-worker",
} as const;

const testControlFaultIds = new Set([
  "postgres_proxy_interruption",
  "tunnel_proxy_interruption",
  "fake_gmail_failure",
  "fake_ai_provider_failure",
  "fake_offsite_drive_failure",
  "quota_volume_near_full",
  "synthetic_stale_backup_alert",
] as const);

const faultIds = new Set([
  "runner_service_restart",
  ...Object.keys(serviceTargets),
  ...testControlFaultIds,
]);

const mutationFaultIds = new Set([
  "runner_service_restart",
  ...testControlFaultIds,
]);

const vmIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const runIdentityPattern = /^sha256:[0-9a-f]{64}$/;
const timestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

type FaultId = typeof faultIds extends Set<infer Value> ? Value & string : never;

type FaultTarget =
  | { readonly kind: "compose-service"; readonly service: string }
  | { readonly kind: "runner-service"; readonly domain: string; readonly unit: string }
  | { readonly kind: "test-control"; readonly control: string };

export type ProductionLoadTestControlRequest =
  | {
    readonly version: 1;
    readonly action: "isolation-status";
    readonly project: "learncoding";
    readonly repositoryRoot: typeof REPOSITORY_ROOT;
    readonly runnerStateRoot: typeof RUNNER_STATE_ROOT;
    readonly runnerVmId: string;
    readonly runnerVmMac: typeof VM_MAC;
  }
  | { readonly version: 1; readonly action: "host-telemetry"; readonly project: "learncoding" }
  | {
    readonly version: 1;
    readonly action: "runner-vm-telemetry";
    readonly runnerDomain: typeof RUNNER_DOMAIN;
    readonly runnerVmId: string;
    readonly runnerVmMac: typeof VM_MAC;
  }
  | {
    readonly version: 1;
    readonly action: "reset" | "inject-and-release" | "invariant-evidence";
    readonly faultId: FaultId;
    readonly target: FaultTarget;
    readonly project: "learncoding";
    readonly runnerVmId: string;
    readonly runnerVmMac: typeof VM_MAC;
  }
  | {
    readonly version: 1;
    readonly action: "probe";
    readonly faultId: FaultId;
    readonly target: FaultTarget;
    readonly phase: "baseline" | "recovery";
    readonly project: "learncoding";
    readonly runnerVmId: string;
    readonly runnerVmMac: typeof VM_MAC;
  }
  | {
    readonly version: 1;
    readonly action: "browser-journey";
    readonly faultId: FaultId;
    readonly stage: "steady" | "recovered";
    readonly project: "learncoding";
  };

export type ProductionLoadTestControlAdapter = {
  handle(
    request: ProductionLoadTestControlRequest,
    context: { readonly requestId: string; readonly signal: AbortSignal },
  ): Promise<unknown>;
  close?(): Promise<void>;
};

export type ProductionLoadTestControlAuthority = {
  readonly candidateRunIdentitySha256: string;
  readonly project: "learncoding";
  readonly runnerVmId: string;
  readonly runnerVmMac: typeof VM_MAC;
};

export type ProductionLoadPeerCredentials = {
  readonly pid: number;
  readonly uid: number;
  readonly gid: number;
};

export type ProductionLoadPeerCredentialResolver = (
  socket: Socket,
  signal: AbortSignal,
) => Promise<ProductionLoadPeerCredentials>;

export type ProductionLoadTestControlSocketStat = {
  readonly uid: number;
  readonly gid: number;
  readonly mode: number;
  readonly nlink: number;
  isDirectory(): boolean;
  isSocket(): boolean;
  isSymbolicLink(): boolean;
};

function fail(code: string): never {
  throw new Error(`Production load test control failed: ${code}`);
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length
    && actual.every((key, index) => key === keys[index]);
}

function canonical(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value) + "\n", "utf8");
}

function stableFailure(): Buffer {
  return canonical({ ok: false, result: null });
}

function targetFor(faultId: string): FaultTarget | null {
  const service = serviceTargets[faultId as keyof typeof serviceTargets];
  if (service) return { kind: "compose-service", service };
  if (faultId === "runner_service_restart") {
    return { kind: "runner-service", domain: RUNNER_DOMAIN, unit: RUNNER_UNIT };
  }
  if (testControlFaultIds.has(faultId as never)) {
    return { kind: "test-control", control: faultId };
  }
  return null;
}

function exactTarget(value: unknown, expected: FaultTarget): boolean {
  const item = record(value);
  if (!item) return false;
  if (expected.kind === "compose-service") {
    return exactKeys(item, ["kind", "service"])
      && item.kind === expected.kind && item.service === expected.service;
  }
  if (expected.kind === "runner-service") {
    return exactKeys(item, ["kind", "domain", "unit"])
      && item.kind === expected.kind
      && item.domain === expected.domain
      && item.unit === expected.unit;
  }
  return exactKeys(item, ["kind", "control"])
    && item.kind === expected.kind && item.control === expected.control;
}

function parseRequest(
  body: Buffer,
  authority: ProductionLoadTestControlAuthority,
): ProductionLoadTestControlRequest {
  if (body.byteLength < 2 || body.byteLength > MAXIMUM_MESSAGE_BYTES) fail("invalid_request");
  let text: string;
  let value: unknown;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(body);
    if (text.includes("\0") || text.includes("\r") || !text.endsWith("\n")) {
      fail("invalid_request");
    }
    value = JSON.parse(text) as unknown;
  } catch {
    fail("invalid_request");
  }
  if (!Buffer.from(JSON.stringify(value) + "\n", "utf8").equals(body)) {
    fail("noncanonical_request");
  }
  const item = record(value);
  if (!item || item.version !== 1 || typeof item.action !== "string") {
    fail("invalid_request");
  }
  if (item.action === "host-telemetry") {
    if (!exactKeys(item, ["version", "action", "project"])
      || item.project !== authority.project) fail("unauthorized_request");
    return item as ProductionLoadTestControlRequest;
  }
  if (item.action === "isolation-status") {
    if (!exactKeys(item, [
      "version", "action", "project", "repositoryRoot", "runnerStateRoot",
      "runnerVmId", "runnerVmMac",
    ])
      || item.project !== authority.project
      || item.repositoryRoot !== REPOSITORY_ROOT
      || item.runnerStateRoot !== RUNNER_STATE_ROOT
      || item.runnerVmId !== authority.runnerVmId
      || item.runnerVmMac !== authority.runnerVmMac) fail("unauthorized_request");
    return item as ProductionLoadTestControlRequest;
  }
  if (item.action === "runner-vm-telemetry") {
    if (!exactKeys(item, [
      "version", "action", "runnerDomain", "runnerVmId", "runnerVmMac",
    ])
      || item.runnerDomain !== RUNNER_DOMAIN
      || item.runnerVmId !== authority.runnerVmId
      || item.runnerVmMac !== authority.runnerVmMac) fail("unauthorized_request");
    return item as ProductionLoadTestControlRequest;
  }
  if (item.action === "browser-journey") {
    if (!exactKeys(item, ["version", "action", "faultId", "stage", "project"])
      || typeof item.faultId !== "string"
      || !faultIds.has(item.faultId)
      || (item.stage !== "steady" && item.stage !== "recovered")
      || item.project !== authority.project) fail("unauthorized_request");
    return item as ProductionLoadTestControlRequest;
  }
  if (item.action !== "reset"
    && item.action !== "inject-and-release"
    && item.action !== "probe"
    && item.action !== "invariant-evidence") fail("invalid_action");
  const expectedKeys = item.action === "probe"
    ? ["version", "action", "faultId", "target", "phase", "project", "runnerVmId", "runnerVmMac"]
    : ["version", "action", "faultId", "target", "project", "runnerVmId", "runnerVmMac"];
  const expectedTarget = typeof item.faultId === "string" ? targetFor(item.faultId) : null;
  if (!exactKeys(item, expectedKeys)
    || typeof item.faultId !== "string"
    || !faultIds.has(item.faultId)
    || !expectedTarget
    || !exactTarget(item.target, expectedTarget)
    || item.project !== authority.project
    || item.runnerVmId !== authority.runnerVmId
    || item.runnerVmMac !== authority.runnerVmMac
    || (item.action === "probe" && item.phase !== "baseline" && item.phase !== "recovery")
    || ((item.action === "reset" || item.action === "inject-and-release")
      && !mutationFaultIds.has(item.faultId))) {
    fail("unauthorized_request");
  }
  return item as ProductionLoadTestControlRequest;
}

function safeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function finite(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === "number" && Number.isFinite(value)
    && value >= minimum && value <= maximum;
}

function validateResult(request: ProductionLoadTestControlRequest, value: unknown): unknown {
  if (request.action === "reset" || request.action === "inject-and-release") {
    if (value !== null) fail("invalid_result");
    return null;
  }
  const item = record(value);
  if (!item) fail("invalid_result");
  if (request.action === "isolation-status") {
    if (!exactKeys(item, ["maintenanceWindowApproved", "freshRecoveryPoint"])
      || typeof item.maintenanceWindowApproved !== "boolean"
      || typeof item.freshRecoveryPoint !== "boolean") fail("invalid_result");
  } else if (request.action === "host-telemetry") {
    if (!exactKeys(item, [
      "hostCpuPercent", "availableMemoryBytes", "rootFreeFraction", "rootFreeBytes",
      "diskReadBytes", "diskWriteBytes", "temperatureCelsius", "oomKills",
      "thermalThrottleIncrements",
    ])
      || !finite(item.hostCpuPercent, 0, 100)
      || !safeInteger(item.availableMemoryBytes)
      || !finite(item.rootFreeFraction, 0, 1)
      || !safeInteger(item.rootFreeBytes)
      || !safeInteger(item.diskReadBytes)
      || !safeInteger(item.diskWriteBytes)
      || !finite(item.temperatureCelsius, -100, 200)
      || !safeInteger(item.oomKills)
      || !safeInteger(item.thermalThrottleIncrements)) fail("invalid_result");
  } else if (request.action === "runner-vm-telemetry") {
    if (!exactKeys(item, ["runnerVmCpuPercent", "runnerVmAvailableMemoryBytes"])
      || !finite(item.runnerVmCpuPercent, 0, 100)
      || !safeInteger(item.runnerVmAvailableMemoryBytes)) fail("invalid_result");
  } else if (request.action === "probe") {
    if (!exactKeys(item, ["componentHealthy", "alertOrDeadLetterVisible"])
      || typeof item.componentHealthy !== "boolean"
      || typeof item.alertOrDeadLetterVisible !== "boolean") fail("invalid_result");
  } else if (request.action === "invariant-evidence") {
    if (!exactKeys(item, [
      "observedAt", "acknowledgedMutationFailures", "runnerMaxConcurrentJobs",
      "secretLeakFindings",
    ])
      || typeof item.observedAt !== "string"
      || !timestampPattern.test(item.observedAt)
      || new Date(item.observedAt).toISOString() !== item.observedAt
      || !safeInteger(item.acknowledgedMutationFailures)
      || !safeInteger(item.runnerMaxConcurrentJobs)
      || !safeInteger(item.secretLeakFindings)) fail("invalid_result");
  } else if (request.action === "browser-journey") {
    if (!exactKeys(item, ["ok", "faultId", "stage"])
      || item.ok !== true
      || item.faultId !== request.faultId
      || item.stage !== request.stage) fail("invalid_result");
  } else {
    fail("invalid_result");
  }
  return item;
}

function validateAuthority(authority: ProductionLoadTestControlAuthority): void {
  if (!runIdentityPattern.test(authority.candidateRunIdentitySha256)
    || authority.project !== "learncoding"
    || !vmIdPattern.test(authority.runnerVmId)
    || authority.runnerVmMac !== VM_MAC) fail("invalid_authority");
}

export function validateProductionLoadTestControlRuntimeDirectory(
  value: ProductionLoadTestControlSocketStat,
): void {
  if (!value.isDirectory()
    || value.isSymbolicLink()
    || value.uid !== 0
    || value.gid !== 0
    || value.nlink < 2
    || (value.mode & 0o022) !== 0
    || (value.mode & 0o100) === 0) {
    fail("unsafe_runtime_directory");
  }
}

export function validateProductionLoadTestControlSocketDirectory(
  value: ProductionLoadTestControlSocketStat,
  expectedGid: number,
): void {
  if (!Number.isSafeInteger(expectedGid) || expectedGid < 0
    || !value.isDirectory()
    || value.isSymbolicLink()
    || value.uid !== 0
    || value.gid !== expectedGid
    || value.nlink < 2
    || (value.mode & 0o027) !== 0) fail("unsafe_socket_parent");
}

export function validateProductionLoadTestControlSocket(
  value: ProductionLoadTestControlSocketStat,
): void {
  if (!value.isSocket()
    || value.isSymbolicLink()
    || value.uid !== 0
    || value.gid !== 0
    || value.nlink !== 1
    || (value.mode & 0o777) !== 0o600) fail("unsafe_socket");
}

export function createProductionLoadTestControlDispatcher(options: {
  readonly adapter: ProductionLoadTestControlAdapter;
  readonly authority: ProductionLoadTestControlAuthority;
  readonly assertAuthority?: () => Promise<void>;
  readonly maximumConcurrentRequests: number;
  readonly requestTimeoutMs: number;
}) {
  validateAuthority(options.authority);
  if (!Number.isSafeInteger(options.maximumConcurrentRequests)
    || options.maximumConcurrentRequests < 1
    || options.maximumConcurrentRequests > 2) fail("invalid_concurrency");
  if (!Number.isSafeInteger(options.requestTimeoutMs)
    || options.requestTimeoutMs < 1
    || options.requestTimeoutMs > 125_000) fail("invalid_timeout");
  let active = 0;
  const inFlight = new Map<string, Promise<Buffer>>();
  const faultInFlight = new Map<string, string>();
  const mutationState = new Map<string, {
    readonly action: "reset" | "inject-and-release";
    readonly response: Buffer;
    readonly outcome: "success" | "indeterminate";
  }>();

  const execute = (
    request: ProductionLoadTestControlRequest,
    requestId: string,
    callerSignal?: AbortSignal,
    onSettled?: () => void,
  ): Promise<Buffer> => {
    const mutationFaultId = request.action === "reset"
      || request.action === "inject-and-release" ? request.faultId : null;
    const controller = new AbortController();
    const relay = () => controller.abort();
    callerSignal?.addEventListener("abort", relay, { once: true });
    if (callerSignal?.aborted) relay();
    const deadline = setTimeout(relay, options.requestTimeoutMs);
    deadline.unref();
    const operation = (async () => {
      try {
        if (controller.signal.aborted) fail("aborted");
        await options.assertAuthority?.();
        if (controller.signal.aborted) fail("aborted");
        const raw = await options.adapter.handle(request, {
          requestId,
          signal: controller.signal,
        });
        if (controller.signal.aborted) fail("aborted");
        const result = validateResult(request, raw);
        await options.assertAuthority?.();
        const response = canonical({ ok: true, result });
        if (request.action === "reset" || request.action === "inject-and-release") {
          mutationState.set(request.faultId, {
            action: request.action,
            response,
            outcome: "success",
          });
        }
        return response;
      } catch {
        const response = stableFailure();
        if (mutationFaultId !== null
          && (request.action === "reset" || request.action === "inject-and-release")) {
          mutationState.set(mutationFaultId, {
            action: request.action,
            response,
            outcome: "indeterminate",
          });
        }
        return response;
      } finally {
        clearTimeout(deadline);
        callerSignal?.removeEventListener("abort", relay);
      }
    })();
    const failure = stableFailure();
    let failIndeterminate: (() => void) | undefined;
    const deadlineResponse = new Promise<Buffer>((resolve) => {
      failIndeterminate = () => {
        if (mutationFaultId !== null && (request.action === "reset" || request.action === "inject-and-release")) {
          mutationState.set(mutationFaultId, {
            action: request.action,
            response: failure,
            outcome: "indeterminate",
          });
        }
        resolve(failure);
      };
      if (controller.signal.aborted) {
        failIndeterminate();
        return;
      }
      controller.signal.addEventListener("abort", failIndeterminate, { once: true });
    });
    void operation.finally(() => {
      active -= 1;
      if (failIndeterminate) {
        controller.signal.removeEventListener("abort", failIndeterminate);
      }
      onSettled?.();
    });
    return Promise.race([operation, deadlineResponse]);
  };

  const dispatch = async (input: {
    readonly body: Buffer;
    readonly peerUid: number;
    readonly signal?: AbortSignal;
  }): Promise<Buffer> => {
    if (input.peerUid !== 0) return stableFailure();
    let request: ProductionLoadTestControlRequest;
    try {
      request = parseRequest(input.body, options.authority);
    } catch {
      return stableFailure();
    }
    const requestId = createHash("sha256")
      .update(options.authority.candidateRunIdentitySha256 + "\0")
      .update(input.body)
      .digest("hex");
    const mutationFaultId = request.action === "reset"
      || request.action === "inject-and-release" ? request.faultId : null;
    if (mutationFaultId !== null) {
      const existing = inFlight.get(requestId);
      if (existing) return existing;
      if (faultInFlight.has(mutationFaultId)) return stableFailure();
      const state = mutationState.get(mutationFaultId);
      if (state?.action === request.action) {
        if (state.outcome === "success" || request.action === "inject-and-release") {
          return state.response;
        }
      } else if (request.action === "inject-and-release"
        && state?.action === "reset"
        && state.outcome === "indeterminate") {
        return stableFailure();
      }
    }
    if (active >= options.maximumConcurrentRequests) return stableFailure();
    active += 1;
    const pending = execute(request, requestId, input.signal, () => {
      if (mutationFaultId === null) return;
      if (faultInFlight.get(mutationFaultId) === requestId) {
        faultInFlight.delete(mutationFaultId);
      }
      if (inFlight.get(requestId) === pending) inFlight.delete(requestId);
    });
    if (mutationFaultId !== null) {
      inFlight.set(requestId, pending);
      faultInFlight.set(mutationFaultId, requestId);
    }
    return pending;
  };

  return { dispatch };
}

function validPeerCredentialInteger(value: unknown, allowZero: boolean): value is number {
  return Number.isSafeInteger(value)
    && (allowZero ? (value as number) >= 0 : (value as number) > 0)
    && (value as number) <= 0x7fff_ffff;
}

export function parseProductionLoadPeerCredentials(
  output: Buffer,
): ProductionLoadPeerCredentials {
  if (!Buffer.isBuffer(output)
    || output.byteLength < 1
    || output.byteLength > MAXIMUM_PEER_CREDENTIAL_BYTES) {
    fail("invalid_peer_credentials");
  }
  let value: unknown;
  try {
    value = JSON.parse(output.toString("utf8"));
  } catch {
    fail("invalid_peer_credentials");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("invalid_peer_credentials");
  }
  const candidate = value as Record<string, unknown>;
  if (Object.keys(candidate).join(",") !== "pid,uid,gid"
    || !validPeerCredentialInteger(candidate.pid, false)
    || !validPeerCredentialInteger(candidate.uid, true)
    || !validPeerCredentialInteger(candidate.gid, true)) {
    fail("invalid_peer_credentials");
  }
  const credentials = {
    pid: candidate.pid,
    uid: candidate.uid,
    gid: candidate.gid,
  };
  if (!output.equals(Buffer.from(JSON.stringify(credentials) + "\n", "utf8"))) {
    fail("invalid_peer_credentials");
  }
  return credentials;
}

async function validatePeerCredentialExecutable(
  target: string,
  executable: boolean,
): Promise<void> {
  let stat;
  try {
    stat = await lstat(target);
  } catch {
    fail("peer_credentials_unavailable");
  }
  if (!stat.isFile()
    || stat.isSymbolicLink()
    || stat.uid !== 0
    || stat.gid !== 0
    || stat.nlink !== 1
    || (stat.mode & 0o022) !== 0
    || (executable && (stat.mode & 0o111) === 0)) {
    fail("peer_credentials_unavailable");
  }
}

export function collectProductionLoadPeerCredentialsOnChildClose(
  child: ChildProcess,
  signal: AbortSignal,
): Promise<ProductionLoadPeerCredentials> {
  return new Promise<ProductionLoadPeerCredentials>((resolve, reject) => {
    let settled = false;
    let outputBytes = 0;
    let errorBytes = 0;
    const chunks: Buffer[] = [];
    const rejectStable = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error("peer_credentials_unavailable"));
    };
    const onAbort = () => {
      child.kill("SIGKILL");
      rejectStable();
    };
    const timer = setTimeout(onAbort, PEER_CREDENTIAL_TIMEOUT_MS);
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    };

    if (!child.stdout || !child.stderr) {
      rejectStable();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    child.stdout.on("data", (raw: Buffer | string) => {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      outputBytes += chunk.byteLength;
      if (outputBytes > MAXIMUM_PEER_CREDENTIAL_BYTES) {
        child.kill("SIGKILL");
        rejectStable();
        return;
      }
      chunks.push(chunk);
    });
    child.stderr.on("data", (raw: Buffer | string) => {
      errorBytes += Buffer.byteLength(raw);
      child.kill("SIGKILL");
      rejectStable();
    });
    child.once("error", rejectStable);
    child.once("close", (code, exitSignal) => {
      if (settled) return;
      if (code !== 0 || exitSignal !== null || errorBytes !== 0) {
        rejectStable();
        return;
      }
      try {
        const credentials = parseProductionLoadPeerCredentials(
          Buffer.concat(chunks, outputBytes),
        );
        settled = true;
        cleanup();
        resolve(credentials);
      } catch {
        rejectStable();
      }
    });
  });
}

export const resolveProductionLoadPeerCredentials:
ProductionLoadPeerCredentialResolver = async (socket, signal) => {
  if (signal.aborted || socket.destroyed) fail("peer_credentials_unavailable");
  await Promise.all([
    validatePeerCredentialExecutable(PYTHON_INTERPRETER, true),
    validatePeerCredentialExecutable(PEER_CREDENTIAL_HELPER, false),
  ]);
  if (signal.aborted || socket.destroyed) fail("peer_credentials_unavailable");

  let child: ChildProcess;
  try {
    child = spawn(PYTHON_INTERPRETER, [PEER_CREDENTIAL_HELPER], {
      cwd: REPOSITORY_ROOT,
      env: { LANG: "C", LC_ALL: "C", NODE_ENV: "production", PATH: "/usr/bin:/bin" },
      shell: false,
      windowsHide: true,
      stdio: [socket, "pipe", "pipe"],
    });
  } catch {
    fail("peer_credentials_unavailable");
  }
  return collectProductionLoadPeerCredentialsOnChildClose(child, signal);
};

export async function runProductionLoadTestControlAfterPeerAuthorization<T>(options: {
  readonly socket: Socket;
  readonly signal: AbortSignal;
  readonly resolvePeerCredentials: ProductionLoadPeerCredentialResolver;
  readonly authorized: (peerUid: 0) => Promise<T> | T;
}): Promise<T> {
  let credentials: ProductionLoadPeerCredentials;
  try {
    if (options.signal.aborted) fail("peer_unauthorized");
    credentials = await options.resolvePeerCredentials(options.socket, options.signal);
    if (options.signal.aborted
      || !validPeerCredentialInteger(credentials.pid, false)
      || !validPeerCredentialInteger(credentials.uid, true)
      || !validPeerCredentialInteger(credentials.gid, true)
      || credentials.uid !== 0) {
      fail("peer_unauthorized");
    }
  } catch {
    fail("peer_unauthorized");
  }
  return options.authorized(credentials.uid as 0);
}

type StartProductionLoadTestControlUnixServerOptions = {
  readonly socketPath: string;
  readonly socketParentGid: number;
  readonly authority: ProductionLoadTestControlAuthority;
  readonly adapter: ProductionLoadTestControlAdapter;
  readonly platform?: NodeJS.Platform;
  readonly assertAuthority?: () => Promise<void>;
  readonly uid?: number;
  readonly gid?: number;
  readonly maximumConcurrentRequests?: number;
  readonly requestTimeoutMs?: number;
  readonly resolvePeerCredentials?: ProductionLoadPeerCredentialResolver;
};

function safeSocketPath(value: string): string {
  if (value !== PRODUCTION_LOAD_TEST_CONTROL_SOCKET
    || !path.posix.isAbsolute(value)
    || path.posix.normalize(value) !== value
    || /[\0\r\n]/.test(value)) fail("invalid_socket_path");
  return value;
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
      if (error.code === "ECONNREFUSED" || error.code === "ENOENT") resolve(false);
      else reject(error);
    });
  });
}

async function prepareSocketPath(socketPath: string, parentGid: number): Promise<void> {
  let runtimeDirectory;
  try {
    runtimeDirectory = await lstat("/run");
  } catch {
    fail("unsafe_runtime_directory");
  }
  validateProductionLoadTestControlRuntimeDirectory(runtimeDirectory);
  let parent;
  try {
    parent = await lstat(path.dirname(socketPath));
  } catch {
    fail("unsafe_socket_parent");
  }
  validateProductionLoadTestControlSocketDirectory(parent, parentGid);
  let existing;
  try {
    existing = await lstat(socketPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    fail("unsafe_socket");
  }
  validateProductionLoadTestControlSocket(existing);
  let active = false;
  try {
    active = await socketIsActive(socketPath);
  } catch {
    fail("unsafe_socket");
  }
  if (active) fail("socket_in_use");
  try {
    await unlink(socketPath);
  } catch {
    fail("unsafe_socket");
  }
}

export async function startProductionLoadTestControlUnixServer(
  options: StartProductionLoadTestControlUnixServerOptions,
): Promise<{ readonly socketPath: string; close(): Promise<void> }> {
  const platform = options.platform ?? process.platform;
  const uid = options.uid ?? process.getuid?.() ?? -1;
  const gid = options.gid ?? process.getgid?.() ?? -1;
  if (platform !== "linux" || uid !== 0 || gid !== 0) fail("linux_root_required");
  const socketPath = safeSocketPath(options.socketPath);
  if (!Number.isSafeInteger(options.socketParentGid) || options.socketParentGid < 0) {
    fail("invalid_socket_parent_gid");
  }
  const maximumConcurrentRequests = options.maximumConcurrentRequests ?? 2;
  const requestTimeoutMs = options.requestTimeoutMs ?? 125_000;
  const peerCredentialResolver = options.resolvePeerCredentials
    ?? resolveProductionLoadPeerCredentials;
  const dispatcher = createProductionLoadTestControlDispatcher({
    adapter: options.adapter,
    authority: options.authority,
    maximumConcurrentRequests,
    ...(options.assertAuthority ? { assertAuthority: options.assertAuthority } : {}),
    requestTimeoutMs,
  });
  await prepareSocketPath(socketPath, options.socketParentGid);

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
    let responseStarted = false;
    socket.pause();
    const finish = () => {
      sockets.delete(socket);
      controllers.delete(controller);
    };
    const abort = () => controller.abort();
    socket.setTimeout(requestTimeoutMs, () => {
      abort();
      socket.destroy();
    });
    socket.once("error", abort);
    socket.once("close", () => {
      if (!requestEnded || (responseStarted && !socket.writableFinished)) abort();
      finish();
    });
    void runProductionLoadTestControlAfterPeerAuthorization({
      socket,
      signal: controller.signal,
      resolvePeerCredentials: peerCredentialResolver,
      authorized: (peerUid) => {
        if (closing || socket.destroyed || controller.signal.aborted) {
          fail("peer_unauthorized");
        }
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
          responseStarted = true;
          void dispatcher.dispatch({
            body: Buffer.concat(chunks, bytes),
            peerUid,
            signal: controller.signal,
          }).then(
            (response) => {
              if (!socket.destroyed) socket.end(response);
            },
            () => {
              if (!socket.destroyed) socket.end(stableFailure());
            },
          );
        });
        socket.resume();
      },
    }).catch(() => {
      abort();
      if (!socket.destroyed) socket.end(stableFailure());
    });
  });
  server.maxConnections = maximumConcurrentRequests;

  try {
    await listen(server, socketPath);
    await chown(socketPath, 0, 0);
    await chmod(socketPath, 0o600);
    const parent = await lstat(path.dirname(socketPath));
    validateProductionLoadTestControlSocketDirectory(parent, options.socketParentGid);
    const created = await lstat(socketPath);
    validateProductionLoadTestControlSocket(created);
    let closed = false;
    return {
      socketPath,
      async close() {
        if (closed) return;
        closed = true;
        closing = true;
        for (const controller of controllers) controller.abort();
        for (const socket of sockets) socket.destroy();
        await closeServer(server);
        try {
          const current = await lstat(socketPath);
          if (current.isSocket()
            && !current.isSymbolicLink()
            && current.uid === 0
            && current.gid === 0
            && current.nlink === 1
            && current.dev === created.dev
            && current.ino === created.ino) {
            await unlink(socketPath);
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") fail("shutdown_failed");
        }
        try {
          await options.adapter.close?.();
        } catch {
          fail("shutdown_failed");
        }
      },
    };
  } catch {
    for (const controller of controllers) controller.abort();
    for (const socket of sockets) socket.destroy();
    await closeServer(server).catch(() => undefined);
    try {
      const current = await lstat(socketPath);
      if (current.isSocket()
        && !current.isSymbolicLink()
        && current.uid === 0
        && current.gid === 0
        && current.nlink === 1
        && (current.mode & 0o777) === 0o600) {
        await unlink(socketPath);
      }
    } catch {
      // Stable startup failure below deliberately contains no filesystem detail.
    }
    fail("listen_failed");
  }
}
