import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import path from "node:path";
import { TextDecoder } from "node:util";

import { PRODUCTION_LOAD_FAULT_MATRIX } from "../../src/lib/performance/load-report";
import type {
  ProductionLoadFaultInvariantEvidence,
  ProductionLoadIsolationBackend,
} from "./production-load-host";

export type ProductionLoadLinuxCommand = {
  readonly executable: string;
  readonly cwd: string;
  readonly args: readonly string[];
  readonly timeoutMs: number;
  readonly maximumOutputBytes: number;
  readonly signal?: AbortSignal;
};

export type ProductionLoadLinuxCommandResult = {
  readonly exitCode: number;
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
  readonly timedOut: boolean;
  readonly outputOverflow?: boolean;
  readonly aborted?: boolean;
};

export type ProductionLoadLinuxCommandExecutor = (
  command: ProductionLoadLinuxCommand,
) => Promise<ProductionLoadLinuxCommandResult>;

export type ProductionLoadLinuxPathIdentity = {
  readonly kind: "file" | "directory" | "symbolic-link" | "other";
  readonly uid: number;
  readonly mode: number;
  readonly linkCount: number;
};

export type CreateProductionLoadLinuxIsolationBackendOptions = {
  readonly expectedRunnerVmId: string;
  readonly controlExecutable: string;
  readonly browserJourneyExecutable: string;
  readonly executor?: ProductionLoadLinuxCommandExecutor;
  readonly inspectPath?: (target: string) => Promise<ProductionLoadLinuxPathIdentity>;
  readonly platform?: NodeJS.Platform;
  readonly now?: () => Date;
};

type FaultId = Parameters<ProductionLoadIsolationBackend["resetFault"]>[0];

const PROJECT = "learncoding";
const REPOSITORY_ROOT = "/opt/learncoding";
const RUNNER_STATE_ROOT = "/var/lib/learncoding-runner";
const RUNNER_DOMAIN = "codestead-runner";
const RUNNER_NETWORK = "default";
const RUNNER_UNIT = "learncoding-runner.service";
const RUNNER_MAC = "52:54:00:20:00:12";
const DOCKER = "/usr/bin/docker";
const VIRSH = "/usr/bin/virsh";
const MAXIMUM_OUTPUT_BYTES = 64 * 1024;
const READ_TIMEOUT_MS = 10_000;
const MUTATION_TIMEOUT_MS = 60_000;
const BROWSER_TIMEOUT_MS = 120_000;
const vmIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const executablePattern = /^\/[A-Za-z0-9._/-]+$/;

const serviceTargets = {
  app_container_restart: "app",
  email_worker_restart: "mail-worker",
  assessment_regrade_worker_restart: "regrade-worker",
  project_review_correction_worker_restart: "project-review-correction-worker",
  exam_finalization_worker_restart: "exam-finalization-worker",
  practice_recovery_worker_restart: "practice-runner-recovery-worker",
  rewards_worker_restart: "reward-worker",
} as const satisfies Partial<Record<FaultId, string>>;

const testControlFaults = new Set<FaultId>([
  "postgres_proxy_interruption",
  "tunnel_proxy_interruption",
  "fake_gmail_failure",
  "fake_ai_provider_failure",
  "fake_offsite_drive_failure",
  "quota_volume_near_full",
  "synthetic_stale_backup_alert",
]);

const faultIds = new Set<FaultId>(PRODUCTION_LOAD_FAULT_MATRIX.map((fault) => fault.id));

function fail(code: string): never {
  throw new Error("Production load Linux backend failed: " + code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUint8Array(value: unknown): value is Uint8Array {
  return ArrayBuffer.isView(value)
    && Object.prototype.toString.call(value) === "[object Uint8Array]";
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length
    && actual.every((key, index) => key === keys[index]);
}

function validateConfiguredExecutable(value: string): void {
  if (!executablePattern.test(value)
    || path.posix.normalize(value) !== value
    || value === path.posix.parse(value).root
    || !value.startsWith(REPOSITORY_ROOT + "/infra/ops/")) {
    fail("invalid_configuration");
  }
}

function validateConfiguration(options: CreateProductionLoadLinuxIsolationBackendOptions): void {
  if (!vmIdPattern.test(options.expectedRunnerVmId)) fail("invalid_configuration");
  validateConfiguredExecutable(options.controlExecutable);
  validateConfiguredExecutable(options.browserJourneyExecutable);
  if (options.controlExecutable === options.browserJourneyExecutable) {
    fail("invalid_configuration");
  }
  const mapped = new Set<FaultId>([
    ...(Object.keys(serviceTargets) as FaultId[]),
    "runner_service_restart",
    ...testControlFaults,
  ]);
  if (mapped.size !== faultIds.size || [...faultIds].some((faultId) => !mapped.has(faultId))) {
    fail("invalid_configuration");
  }
}

async function defaultInspectPath(target: string): Promise<ProductionLoadLinuxPathIdentity> {
  const metadata = await lstat(target);
  const kind = metadata.isSymbolicLink()
    ? "symbolic-link"
    : metadata.isFile()
      ? "file"
      : metadata.isDirectory()
        ? "directory"
        : "other";
  return {
    kind,
    uid: metadata.uid,
    mode: metadata.mode & 0o777,
    linkCount: metadata.nlink,
  };
}

export const productionLoadLinuxCommandExecutor: ProductionLoadLinuxCommandExecutor = async (command) =>
  new Promise((resolve) => {
    execFile(
      command.executable,
      [...command.args],
      {
        cwd: command.cwd,
        encoding: "buffer",
        env: { LANG: "C", LC_ALL: "C", NODE_ENV: "production", PATH: "/usr/bin:/bin" },
        killSignal: "SIGKILL",
        maxBuffer: command.maximumOutputBytes,
        shell: false,
        timeout: command.timeoutMs,
        windowsHide: true,
        ...(command.signal ? { signal: command.signal } : {}),
      },
      (error, stdout, stderr) => {
        const failure = error as (Error & {
          readonly code?: string | number;
          readonly killed?: boolean;
        }) | null;
        const aborted = command.signal?.aborted === true
          || failure?.code === "ABORT_ERR"
          || failure?.name === "AbortError";
        resolve({
          exitCode: failure === null
            ? 0
            : typeof failure.code === "number"
              ? failure.code
              : 1,
          stdout: stdout ?? Buffer.alloc(0),
          stderr: stderr ?? Buffer.alloc(0),
          timedOut: failure?.killed === true && !aborted,
          outputOverflow: failure?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
          aborted,
        });
      },
    );
  });

function decode(bytes: Uint8Array): string {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (text.includes("\0") || text.includes("\r")) fail("invalid_output");
    return text;
  } catch {
    fail("invalid_output");
  }
}

function parseCanonicalObject(
  bytes: Uint8Array,
  keys: readonly string[],
): Record<string, unknown> {
  const text = decode(bytes);
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    fail("invalid_output");
  }
  if (!isRecord(value)
    || !exactKeys(value, keys)
    || JSON.stringify(value) + "\n" !== text) {
    fail("invalid_output");
  }
  return value;
}

function finiteNumber(value: unknown, minimum: number, maximum = Number.MAX_VALUE): number {
  if (typeof value !== "number"
    || !Number.isFinite(value)
    || value < minimum
    || value > maximum) {
    fail("invalid_output");
  }
  return value;
}

function nonNegativeInteger(value: unknown): number {
  const number = finiteNumber(value, 0, Number.MAX_SAFE_INTEGER);
  if (!Number.isSafeInteger(number)) fail("invalid_output");
  return number;
}

function canonicalTimestamp(value: unknown): string {
  if (typeof value !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    fail("invalid_output");
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    fail("invalid_output");
  }
  return value;
}

function assertFault(value: unknown): asserts value is FaultId {
  if (typeof value !== "string" || !faultIds.has(value as FaultId)) {
    fail("invalid_fault");
  }
}

function serviceFor(faultId: FaultId): string | null {
  return serviceTargets[faultId as keyof typeof serviceTargets] ?? null;
}

function assertIdentity(project: unknown, runnerVmId: unknown, expectedVmId: string): void {
  if (project !== PROJECT || runnerVmId !== expectedVmId) fail("identity_mismatch");
}

function composeArgs(operation: "restart" | "start", service: string): readonly string[] {
  const prefix = [
    "compose",
    "--project-name", PROJECT,
    "--project-directory", REPOSITORY_ROOT,
    "--file", REPOSITORY_ROOT + "/compose.yaml",
  ];
  return operation === "restart"
    ? [...prefix, "restart", "--no-deps", service]
    : [...prefix, "start", service];
}

function targetArgs(faultId: FaultId): readonly string[] {
  const service = serviceFor(faultId);
  if (service !== null) return ["compose-service", service];
  if (faultId === "runner_service_restart") {
    return ["runner-service", RUNNER_DOMAIN, RUNNER_UNIT];
  }
  if (testControlFaults.has(faultId)) return ["test-control", faultId];
  fail("invalid_fault");
}

function controlArgs(
  operation: string,
  faultId: FaultId,
  expectedVmId: string,
): readonly string[] {
  return [
    operation,
    faultId,
    ...targetArgs(faultId),
    "--project", PROJECT,
    "--runner-vm-id", expectedVmId,
    "--runner-vm-mac", RUNNER_MAC,
  ];
}

type Inventory = {
  readonly digest: string;
  readonly healthy: boolean;
};

function parseInventory(bytes: Uint8Array): Inventory {
  const text = decode(bytes);
  if (text === "") {
    return {
      digest: createHash("sha256").update("[]").digest("hex"),
      healthy: true,
    };
  }
  if (!text.endsWith("\n")) fail("invalid_output");
  const lines = text.slice(0, -1).split("\n");
  if (lines.length > 256 || lines.some((line) => line.length === 0)) fail("invalid_output");
  const unrelated: Array<{ readonly id: string; readonly name: string }> = [];
  const seenIds = new Set<string>();
  const seenNames = new Set<string>();
  let healthy = true;
  for (const line of lines) {
    let raw: unknown;
    try {
      raw = JSON.parse(line) as unknown;
    } catch {
      fail("invalid_output");
    }
    if (!isRecord(raw)
      || typeof raw.ID !== "string"
      || !/^[0-9a-f]{64}$/.test(raw.ID)
      || typeof raw.Names !== "string"
      || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(raw.Names)
      || typeof raw.Labels !== "string"
      || raw.Labels.length > 16_384
      || typeof raw.State !== "string"
      || typeof raw.Status !== "string"
      || raw.Status.length > 512
      || seenIds.has(raw.ID)
      || seenNames.has(raw.Names)) {
      fail("invalid_output");
    }
    seenIds.add(raw.ID);
    seenNames.add(raw.Names);
    const projectOwned = raw.Labels.split(",").includes(
      "com.docker.compose.project=" + PROJECT,
    );
    if (!projectOwned) {
      unrelated.push({ id: raw.ID, name: raw.Names });
      if (raw.State !== "running" || /\(unhealthy\)/i.test(raw.Status)) healthy = false;
    }
  }
  unrelated.sort((left, right) =>
    left.id.localeCompare(right.id) || left.name.localeCompare(right.name));
  return {
    digest: createHash("sha256").update(JSON.stringify(unrelated)).digest("hex"),
    healthy,
  };
}

function parseRunnerInterface(bytes: Uint8Array): string {
  const text = decode(bytes);
  if (!text.endsWith("\n")) fail("invalid_output");
  const lines = text.trimEnd().split("\n");
  if (lines.length !== 3) fail("invalid_output");
  const header = lines[0]!.trim().split(/\s+/);
  const separator = lines[1]!.trim();
  const row = lines[2]!.trim().split(/\s+/);
  if (header.join("\0") !== ["Interface", "Type", "Source", "Model", "MAC"].join("\0")
    || !/^-{5,}$/.test(separator)
    || row.length !== 5
    || !/^vnet[0-9]+$/.test(row[0]!)
    || row[1] !== "network"
    || row[2] !== RUNNER_NETWORK
    || row[3] !== "virtio"
    || row[4]?.toLowerCase() !== RUNNER_MAC) {
    fail("invalid_output");
  }
  return RUNNER_MAC;
}

function parseHostTelemetry(bytes: Uint8Array) {
  const keys = [
    "hostCpuPercent",
    "availableMemoryBytes",
    "rootFreeFraction",
    "rootFreeBytes",
    "diskReadBytes",
    "diskWriteBytes",
    "temperatureCelsius",
    "oomKills",
    "thermalThrottleIncrements",
  ] as const;
  const value = parseCanonicalObject(bytes, keys);
  return {
    hostCpuPercent: finiteNumber(value.hostCpuPercent, 0, 100),
    availableMemoryBytes: nonNegativeInteger(value.availableMemoryBytes),
    rootFreeFraction: finiteNumber(value.rootFreeFraction, 0, 1),
    rootFreeBytes: nonNegativeInteger(value.rootFreeBytes),
    diskReadBytes: nonNegativeInteger(value.diskReadBytes),
    diskWriteBytes: nonNegativeInteger(value.diskWriteBytes),
    temperatureCelsius: finiteNumber(value.temperatureCelsius, -100, 200),
    oomKills: nonNegativeInteger(value.oomKills),
    thermalThrottleIncrements: nonNegativeInteger(value.thermalThrottleIncrements),
  };
}

function parseRunnerTelemetry(bytes: Uint8Array) {
  const value = parseCanonicalObject(
    bytes,
    ["runnerVmCpuPercent", "runnerVmAvailableMemoryBytes"],
  );
  return {
    runnerVmCpuPercent: finiteNumber(value.runnerVmCpuPercent, 0, 100),
    runnerVmAvailableMemoryBytes: nonNegativeInteger(value.runnerVmAvailableMemoryBytes),
  };
}

function parseProbe(bytes: Uint8Array) {
  const value = parseCanonicalObject(
    bytes,
    ["componentHealthy", "alertOrDeadLetterVisible"],
  );
  if (typeof value.componentHealthy !== "boolean"
    || typeof value.alertOrDeadLetterVisible !== "boolean") {
    fail("invalid_output");
  }
  return {
    componentHealthy: value.componentHealthy,
    alertOrDeadLetterVisible: value.alertOrDeadLetterVisible,
  };
}

export function createProductionLoadLinuxIsolationBackend(
  options: CreateProductionLoadLinuxIsolationBackendOptions,
): ProductionLoadIsolationBackend {
  validateConfiguration(options);
  const platform = options.platform ?? process.platform;
  const execute = options.executor ?? productionLoadLinuxCommandExecutor;
  const inspectPath = options.inspectPath ?? defaultInspectPath;
  const now = options.now ?? (() => new Date());

  const ensureLinux = (): void => {
    if (platform !== "linux") fail("linux_only");
  };
  const abortCommand = (signal?: AbortSignal): void => {
    if (signal?.aborted) fail("command_aborted");
  };

  const ensureTrustedPath = async (
    target: string,
    finalKind: "directory" | "executable",
    signal?: AbortSignal,
  ): Promise<void> => {
    const components = target.slice(1).split("/");
    let current = "";
    for (const [index, component] of components.entries()) {
      abortCommand(signal);
      current += "/" + component;
      let identity: ProductionLoadLinuxPathIdentity;
      try {
        identity = await inspectPath(current);
      } catch {
        abortCommand(signal);
        fail("unsafe_executable");
      }
      abortCommand(signal);
      const final = index === components.length - 1;
      const executable = final && finalKind === "executable";
      if (identity.kind === "symbolic-link"
        || !Number.isSafeInteger(identity.uid)
        || identity.uid !== 0
        || !Number.isSafeInteger(identity.mode)
        || identity.mode < 0
        || identity.mode > 0o777
        || (identity.mode & 0o022) !== 0
        || !Number.isSafeInteger(identity.linkCount)
        || identity.linkCount < 1
        || identity.kind !== (executable ? "file" : "directory")
        || (identity.kind === "directory" && (identity.mode & 0o100) === 0)
        || (executable && (identity.linkCount !== 1 || (identity.mode & 0o100) === 0))) {
        fail("unsafe_executable");
      }
    }
  };

  const run = async (
    executable: string,
    args: readonly string[],
    timeoutMs = READ_TIMEOUT_MS,
    maximumOutputBytes = MAXIMUM_OUTPUT_BYTES,
    signal?: AbortSignal,
  ): Promise<Uint8Array> => {
    ensureLinux();
    abortCommand(signal);
    await ensureTrustedPath(REPOSITORY_ROOT, "directory", signal);
    await ensureTrustedPath(executable, "executable", signal);
    abortCommand(signal);
    if (args.some((argument) =>
      typeof argument !== "string"
      || argument.length === 0
      || argument.length > 1024
      || argument.includes("\0"))) {
      fail("invalid_configuration");
    }
    let result: ProductionLoadLinuxCommandResult;
    try {
      result = await execute({
        executable,
        cwd: REPOSITORY_ROOT,
        args: [...args],
        timeoutMs,
        maximumOutputBytes,
        ...(signal ? { signal } : {}),
      });
    } catch {
      abortCommand(signal);
      fail("command_execution_failed");
    }
    abortCommand(signal);
    if (!Number.isSafeInteger(result.exitCode)
      || result.exitCode < 0
      || !isUint8Array(result.stdout)
      || !isUint8Array(result.stderr)
      || typeof result.timedOut !== "boolean"
      || (result.aborted !== undefined && typeof result.aborted !== "boolean")) {
      fail("command_result_invalid");
    }
    if (result.aborted === true) fail("command_aborted");
    if (result.outputOverflow === true
      || result.stdout.byteLength > maximumOutputBytes
      || result.stderr.byteLength > maximumOutputBytes
      || result.stdout.byteLength + result.stderr.byteLength > maximumOutputBytes) {
      fail("command_output_limit");
    }
    if (result.timedOut) fail("command_timeout");
    if (result.exitCode !== 0) fail("command_failed");
    if (result.stderr.byteLength !== 0) fail("command_stderr");
    return result.stdout;
  };

  const readInventory = async (signal?: AbortSignal): Promise<Inventory> =>
    parseInventory(await run(
      DOCKER,
      ["ps", "--no-trunc", "--format", "{{json .}}"],
      READ_TIMEOUT_MS,
      MAXIMUM_OUTPUT_BYTES,
      signal,
    ));

  const mutate = async (
    operation: "reset" | "inject-and-release",
    faultIdValue: unknown,
    project: unknown,
    runnerVmId: unknown,
    signal?: AbortSignal,
  ): Promise<void> => {
    abortCommand(signal);
    assertFault(faultIdValue);
    assertIdentity(project, runnerVmId, options.expectedRunnerVmId);
    const service = serviceFor(faultIdValue);
    const output = service === null
      ? await run(
        options.controlExecutable,
        controlArgs(operation, faultIdValue, options.expectedRunnerVmId),
        MUTATION_TIMEOUT_MS,
        MAXIMUM_OUTPUT_BYTES,
        signal,
      )
      : await run(
        DOCKER,
        composeArgs(operation === "reset" ? "start" : "restart", service),
        MUTATION_TIMEOUT_MS,
        MAXIMUM_OUTPUT_BYTES,
        signal,
      );
    abortCommand(signal);
    if (output.byteLength !== 0) fail("invalid_output");
  };

  return {
    async inspectIsolation(signal) {
      ensureLinux();
      const uuidText = decode(await run(
        VIRSH,
        ["--connect", "qemu:///system", "domuuid", RUNNER_DOMAIN],
        READ_TIMEOUT_MS,
        4096,
        signal,
      ));
      if (uuidText !== options.expectedRunnerVmId + "\n") fail("invalid_output");
      const runnerVmMac = parseRunnerInterface(await run(
        VIRSH,
        ["--connect", "qemu:///system", "domiflist", RUNNER_DOMAIN],
        READ_TIMEOUT_MS,
        8192,
        signal,
      ));
      const inventory = await readInventory(signal);
      const status = parseCanonicalObject(
        await run(
          options.controlExecutable,
          [
            "isolation-status",
            "--project", PROJECT,
            "--repository-root", REPOSITORY_ROOT,
            "--runner-state-root", RUNNER_STATE_ROOT,
            "--runner-vm-id", options.expectedRunnerVmId,
            "--runner-vm-mac", RUNNER_MAC,
          ],
          READ_TIMEOUT_MS,
          MAXIMUM_OUTPUT_BYTES,
          signal,
        ),
        ["maintenanceWindowApproved", "freshRecoveryPoint"],
      );
      if (status.maintenanceWindowApproved !== true || status.freshRecoveryPoint !== true) {
        fail("invalid_output");
      }
      return {
        composeProject: PROJECT,
        runnerVmId: options.expectedRunnerVmId,
        runnerVmMac,
        repositoryRoot: REPOSITORY_ROOT,
        runnerStateRoot: RUNNER_STATE_ROOT,
        maintenanceWindowApproved: true,
        freshRecoveryPoint: true,
        unrelatedInventorySha256: inventory.digest,
      };
    },

    async captureHost(signal) {
      return parseHostTelemetry(await run(
        options.controlExecutable,
        ["host-telemetry", "--project", PROJECT],
        READ_TIMEOUT_MS,
        MAXIMUM_OUTPUT_BYTES,
        signal,
      ));
    },

    async captureRunnerVm(runnerVmId, signal) {
      assertIdentity(PROJECT, runnerVmId, options.expectedRunnerVmId);
      return parseRunnerTelemetry(await run(
        options.controlExecutable,
        [
          "runner-vm-telemetry",
          "--runner-domain", RUNNER_DOMAIN,
          "--runner-vm-id", options.expectedRunnerVmId,
          "--runner-vm-mac", RUNNER_MAC,
        ],
        READ_TIMEOUT_MS,
        MAXIMUM_OUTPUT_BYTES,
        signal,
      ));
    },

    async unrelatedServicesHealthy(project, signal) {
      assertIdentity(project, options.expectedRunnerVmId, options.expectedRunnerVmId);
      return (await readInventory(signal)).healthy;
    },

    resetFault(faultId, project, runnerVmId, signal) {
      return mutate("reset", faultId, project, runnerVmId, signal);
    },

    async probeFault(faultIdValue, phase, project, runnerVmId, signal) {
      assertFault(faultIdValue);
      assertIdentity(project, runnerVmId, options.expectedRunnerVmId);
      if (phase !== "baseline" && phase !== "recovery") fail("invalid_fault");
      return parseProbe(await run(
        options.controlExecutable,
        [
          "probe",
          faultIdValue,
          ...targetArgs(faultIdValue),
          "--phase", phase,
          "--project", PROJECT,
          "--runner-vm-id", options.expectedRunnerVmId,
          "--runner-vm-mac", RUNNER_MAC,
        ],
        READ_TIMEOUT_MS,
        MAXIMUM_OUTPUT_BYTES,
        signal,
      ));
    },

    injectAndReleaseFault(faultId, project, runnerVmId, signal) {
      return mutate("inject-and-release", faultId, project, runnerVmId, signal);
    },

    async runBrowserJourney(faultIdValue, stage, signal) {
      assertFault(faultIdValue);
      if (stage !== "steady" && stage !== "recovered") fail("invalid_fault");
      const value = parseCanonicalObject(
        await run(
          options.browserJourneyExecutable,
          [
            "--fault-id", faultIdValue,
            "--stage", stage,
            "--project", PROJECT,
          ],
          BROWSER_TIMEOUT_MS,
          MAXIMUM_OUTPUT_BYTES,
          signal,
        ),
        ["ok", "faultId", "stage"],
      );
      if (value.ok !== true || value.faultId !== faultIdValue || value.stage !== stage) {
        fail("invalid_output");
      }
    },

    async captureFaultInvariantEvidence(
      faultIdValue,
      project,
      runnerVmId,
      signal,
    ): Promise<ProductionLoadFaultInvariantEvidence> {
      assertFault(faultIdValue);
      assertIdentity(project, runnerVmId, options.expectedRunnerVmId);
      const value = parseCanonicalObject(
        await run(
          options.controlExecutable,
          [
            "invariant-evidence",
            faultIdValue,
            ...targetArgs(faultIdValue),
            "--project", PROJECT,
            "--runner-vm-id", options.expectedRunnerVmId,
            "--runner-vm-mac", RUNNER_MAC,
          ],
          READ_TIMEOUT_MS,
          MAXIMUM_OUTPUT_BYTES,
          signal,
        ),
        [
          "observedAt",
          "acknowledgedMutationFailures",
          "runnerMaxConcurrentJobs",
          "secretLeakFindings",
        ],
      );
      const observedAt = canonicalTimestamp(value.observedAt);
      const current = now();
      if (!Number.isFinite(current.getTime())
        || current.getTime() - Date.parse(observedAt) < 0
        || current.getTime() - Date.parse(observedAt) > 30_000) {
        fail("invalid_output");
      }
      return {
        source: "isolated-production-load-backend-v1",
        faultId: faultIdValue,
        project: PROJECT,
        runnerVmId: options.expectedRunnerVmId,
        observedAt,
        acknowledgedMutationFailures: nonNegativeInteger(
          value.acknowledgedMutationFailures,
        ),
        runnerMaxConcurrentJobs: nonNegativeInteger(value.runnerMaxConcurrentJobs),
        secretLeakFindings: nonNegativeInteger(value.secretLeakFindings),
      };
    },
  };
}
