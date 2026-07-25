import { spawnSync } from "node:child_process";

import type { DisposableIntegrationEnvironmentSource } from
  "./disposable-integration-environment";
import {
  DisposableIntegrationLifecycleError,
  disposableIntegrationFailure,
} from
  "./disposable-integration-error";
import {
  createDisposablePostgresPasswordFile,
  type DisposablePostgresPasswordFile,
} from "./disposable-postgres-password-file";
import { buildDisposableToolEnvironment } from
  "./disposable-tool-environment";

const PURPOSE_LABEL = "com.learncoding.purpose=disposable-integration-test";
const RUN_LABEL_KEY = "com.learncoding.integration-run";
export const POSTGRES_17_INTEGRATION_IMAGE =
  "postgres:17-alpine@sha256:742f40ea20b9ff2ff31db5458d127452988a2164df9e17441e191f3b72252193";
export const POSTGRES_18_INTEGRATION_IMAGE =
  "postgres:18-alpine@sha256:9a8afca54e7861fd90fab5fdf4c42477a6b1cb7d293595148e674e0a3181de15";
const APPROVED_POSTGRES_IMAGES = new Set([
  POSTGRES_17_INTEGRATION_IMAGE,
  POSTGRES_18_INTEGRATION_IMAGE,
]);
const POSTGRES_DATA_DIRECTORY = "/var/lib/postgresql/data";
const POSTGRES_TMPFS =
  `${POSTGRES_DATA_DIRECTORY}:rw,nosuid,nodev,size=512m`;
const CONTAINER_LABEL_TEMPLATE =
  `${RUN_LABEL_KEY}={{ index .Config.Labels "${RUN_LABEL_KEY}" }}`;
const CONTAINER_VOLUMES_TEMPLATE =
  "{{range .Mounts}}{{if eq .Type \"volume\"}}{{println .Name}}{{end}}{{end}}";

export type DisposableDockerInvocation = Readonly<{
  command: string;
  args: readonly string[];
  environment: NodeJS.ProcessEnv;
  timeoutMs: number;
}>;

export type DisposableDockerCommandResult = Readonly<{
  status: number | null;
  stdout?: string;
  stderr?: string;
  errorCode?: string;
}>;

export type DisposablePostgresIdentity = Readonly<{
  containerId: string;
  port: number;
  database: string;
  username: string;
}>;

export type DisposablePostgresContainer = Readonly<{
  cleanup: () => void;
  getIdentity: () => DisposablePostgresIdentity;
  start: () => void;
}>;

type SignalName = "SIGINT" | "SIGTERM";

function nonEmptyLines(value: string | undefined): readonly string[] {
  return (value ?? "")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function escapeFilterPattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function requirePositiveTimeout(value: number, code: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw disposableIntegrationFailure(code);
  }
  return value;
}

function requireContainerName(value: string): string {
  if (!/^[a-z0-9][a-z0-9_.-]{0,127}$/u.test(value)) {
    throw disposableIntegrationFailure("invalid_container_name");
  }
  return value;
}

function requireContainerId(value: string): string {
  if (!/^[a-f0-9]{64}$/u.test(value)) {
    throw disposableIntegrationFailure("invalid_container_id");
  }
  return value;
}

function requireAnonymousVolumeName(value: string): string {
  if (!/^[a-f0-9]{64}$/u.test(value)) {
    throw disposableIntegrationFailure("invalid_anonymous_volume_name");
  }
  return value;
}

function requirePostgresImage(value: string): string {
  if (!APPROVED_POSTGRES_IMAGES.has(value)) {
    throw disposableIntegrationFailure("invalid_postgres_image");
  }
  return value;
}

const SAFE_CONTAINER_CLEANUP_CODES = new Set([
  "container_probe_failed",
  "container_probe_ambiguous",
  "invalid_container_id",
  "container_identity_probe_failed",
  "container_identity_mismatch",
  "container_volume_probe_failed",
  "invalid_anonymous_volume_name",
  "volume_probe_failed",
  "volume_probe_ambiguous",
  "volume_remove_failed",
  "volume_still_present",
  "container_remove_failed",
  "container_still_present",
  "container_id_probe_failed",
]);

function safeContainerCleanupCode(error: unknown): string {
  return error instanceof DisposableIntegrationLifecycleError
      && SAFE_CONTAINER_CLEANUP_CODES.has(error.code)
    ? error.code
    : "container_cleanup_failed";
}

export function executeDisposableDockerCommand(
  invocation: DisposableDockerInvocation,
): DisposableDockerCommandResult {
  const result = spawnSync(invocation.command, [...invocation.args], {
    encoding: "utf8",
    env: invocation.environment,
    maxBuffer: 1024 * 1024,
    timeout: invocation.timeoutMs,
    windowsHide: true,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    errorCode: (result.error as NodeJS.ErrnoException | undefined)?.code,
  };
}

export function createDisposablePostgresContainer(input: Readonly<{
  dockerCommand: string;
  containerName: string;
  image: string;
  port: number;
  database: string;
  username: string;
  password: string;
  taskHomeDirectory: string;
  sourceEnvironment: DisposableIntegrationEnvironmentSource;
  createPasswordFile?: (password: string) => DisposablePostgresPasswordFile;
  execute?: (
    invocation: DisposableDockerInvocation,
  ) => DisposableDockerCommandResult;
  commandTimeoutMs?: number;
  cleanupTimeoutMs?: number;
}>): DisposablePostgresContainer {
  const execute = input.execute ?? executeDisposableDockerCommand;
  const createPasswordFile =
    input.createPasswordFile
    ?? ((password: string) => createDisposablePostgresPasswordFile({ password }));
  const containerName = requireContainerName(input.containerName);
  const escapedContainerName = escapeFilterPattern(containerName);
  const runLabel = `${RUN_LABEL_KEY}=${containerName}`;
  const image = requirePostgresImage(input.image);
  const commandTimeoutMs = requirePositiveTimeout(
    input.commandTimeoutMs ?? 30_000,
    "invalid_command_timeout",
  );
  const cleanupTimeoutMs = requirePositiveTimeout(
    input.cleanupTimeoutMs ?? 5_000,
    "invalid_cleanup_timeout",
  );
  const toolEnvironment = buildDisposableToolEnvironment(
    input.sourceEnvironment,
    input.taskHomeDirectory,
  );
  const capturedVolumes = new Set<string>();
  let expectedContainerId: string | undefined;
  let containerCleanupArmed = false;
  let passwordFile: DisposablePostgresPasswordFile | undefined;
  let passwordCleanupArmed = false;

  const invoke = (
    args: readonly string[],
    timeoutMs: number,
  ): DisposableDockerCommandResult => {
    try {
      return execute({
        command: input.dockerCommand,
        args,
        environment: toolEnvironment,
        timeoutMs,
      });
    } catch {
      return { status: null };
    }
  };

  const exactContainerId = (timeoutMs: number): string | null => {
    const result = invoke([
      "container",
      "ls",
      "--all",
      "--quiet",
      "--no-trunc",
      "--filter",
      `name=^/${escapedContainerName}$`,
    ], timeoutMs);
    if (result.status !== 0) {
      throw disposableIntegrationFailure("container_probe_failed");
    }
    const identifiers = nonEmptyLines(result.stdout);
    if (identifiers.length > 1) {
      throw disposableIntegrationFailure("container_probe_ambiguous");
    }
    const identifier = identifiers[0];
    return identifier === undefined ? null : requireContainerId(identifier);
  };

  const exactContainerIdPresent = (
    containerId: string,
    timeoutMs: number,
  ): boolean => {
    const result = invoke([
      "container",
      "ls",
      "--all",
      "--quiet",
      "--no-trunc",
      "--filter",
      `id=${containerId}`,
    ], timeoutMs);
    if (result.status !== 0) {
      throw disposableIntegrationFailure("container_id_probe_failed");
    }
    const identifiers = nonEmptyLines(result.stdout);
    for (const identifier of identifiers) {
      if (requireContainerId(identifier) !== containerId) {
        throw disposableIntegrationFailure("container_probe_ambiguous");
      }
    }
    return identifiers.includes(containerId);
  };

  const verifyContainerIdentity = (
    containerId: string,
    timeoutMs: number,
  ): void => {
    const result = invoke([
      "container",
      "inspect",
      "--format",
      CONTAINER_LABEL_TEMPLATE,
      containerId,
    ], timeoutMs);
    if (result.status !== 0) {
      throw disposableIntegrationFailure("container_identity_probe_failed");
    }
    if (result.stdout?.trim() !== runLabel) {
      throw disposableIntegrationFailure("container_identity_mismatch");
    }
  };

  const captureContainerVolumes = (
    containerId: string,
    timeoutMs: number,
  ): void => {
    const result = invoke([
      "container",
      "inspect",
      "--format",
      CONTAINER_VOLUMES_TEMPLATE,
      containerId,
    ], timeoutMs);
    if (result.status !== 0) {
      throw disposableIntegrationFailure("container_volume_probe_failed");
    }
    for (const name of nonEmptyLines(result.stdout)) {
      capturedVolumes.add(requireAnonymousVolumeName(name));
    }
  };

  const exactVolumePresent = (name: string): boolean => {
    const escapedName = escapeFilterPattern(name);
    const result = invoke([
      "volume",
      "ls",
      "--quiet",
      "--filter",
      `name=^${escapedName}$`,
    ], cleanupTimeoutMs);
    if (result.status !== 0) {
      throw disposableIntegrationFailure("volume_probe_failed");
    }
    const names = nonEmptyLines(result.stdout);
    if (names.some((candidate) => candidate !== name)) {
      throw disposableIntegrationFailure("volume_probe_ambiguous");
    }
    return names.includes(name);
  };

  const removeCapturedVolume = (name: string): void => {
    if (!exactVolumePresent(name)) return;
    const result = invoke([
      "volume",
      "rm",
      "--force",
      name,
    ], cleanupTimeoutMs);
    const remains = exactVolumePresent(name);
    if (result.status !== 0 && remains) {
      throw disposableIntegrationFailure("volume_remove_failed");
    }
    if (remains) {
      throw disposableIntegrationFailure("volume_still_present");
    }
  };

  const cleanupContainer = (): void => {
    if (!containerCleanupArmed) return;
    const existingContainerId = exactContainerId(cleanupTimeoutMs);
    let containerIdToClean = existingContainerId;
    if (expectedContainerId !== undefined) {
      if (
        existingContainerId !== null
        && existingContainerId !== expectedContainerId
      ) {
        throw disposableIntegrationFailure("container_identity_mismatch");
      }
      if (
        containerIdToClean === null
        && exactContainerIdPresent(expectedContainerId, cleanupTimeoutMs)
      ) containerIdToClean = expectedContainerId;
    } else if (existingContainerId !== null) {
      expectedContainerId = existingContainerId;
    }
    if (containerIdToClean !== null) {
      verifyContainerIdentity(containerIdToClean, cleanupTimeoutMs);
      captureContainerVolumes(containerIdToClean, cleanupTimeoutMs);
      const removeResult = invoke([
        "container",
        "rm",
        "--force",
        "--volumes",
        containerIdToClean,
      ], cleanupTimeoutMs);
      const containerRemains = exactContainerIdPresent(
        containerIdToClean,
        cleanupTimeoutMs,
      );
      if (removeResult.status !== 0 && containerRemains) {
        throw disposableIntegrationFailure("container_remove_failed");
      }
      if (containerRemains) {
        throw disposableIntegrationFailure("container_still_present");
      }
    }

    for (const name of capturedVolumes) {
      removeCapturedVolume(name);
    }
    capturedVolumes.clear();
    expectedContainerId = undefined;
    containerCleanupArmed = false;
  };

  const cleanupPasswordFile = (): void => {
    if (!passwordCleanupArmed) return;
    try {
      passwordFile?.cleanup();
    } catch {
      throw disposableIntegrationFailure("password_cleanup_failed");
    }
    passwordCleanupArmed = false;
    passwordFile = undefined;
  };

  const cleanup = (): void => {
    let containerFailureCode: string | undefined;
    let passwordCleanupFailed = false;
    try {
      cleanupContainer();
    } catch (error) {
      containerFailureCode = safeContainerCleanupCode(error);
    }
    try {
      cleanupPasswordFile();
    } catch {
      passwordCleanupFailed = true;
    }

    if (containerFailureCode !== undefined && passwordCleanupFailed) {
      throw disposableIntegrationFailure(
        "container_and_password_cleanup_failed",
      );
    }
    if (containerFailureCode !== undefined) {
      throw disposableIntegrationFailure(containerFailureCode);
    }
    if (passwordCleanupFailed) {
      throw disposableIntegrationFailure("password_cleanup_failed");
    }
  };

  const failStart = (code: string): never => {
    try {
      cleanup();
    } catch {
      throw disposableIntegrationFailure("start_and_cleanup_failed");
    }
    throw disposableIntegrationFailure(code);
  };

  const start = (): void => {
    if (containerCleanupArmed || passwordCleanupArmed) {
      throw disposableIntegrationFailure("container_already_started");
    }
    const versionResult = invoke([
      "version",
      "--format",
      "{{.Server.Version}}",
    ], commandTimeoutMs);
    if (versionResult.status !== 0) {
      throw disposableIntegrationFailure("docker_unavailable");
    }

    try {
      passwordFile = createPasswordFile(input.password);
      passwordCleanupArmed = true;
    } catch {
      throw disposableIntegrationFailure("password_file_create_failed");
    }
    containerCleanupArmed = true;

    const runResult = invoke([
      "run",
      "--detach",
      "--rm",
      "--name",
      containerName,
      "--label",
      PURPOSE_LABEL,
      "--label",
      runLabel,
      "--publish",
      `127.0.0.1:${input.port}:5432`,
      "--tmpfs",
      POSTGRES_TMPFS,
      "--mount",
      `type=bind,source=${passwordFile.hostPath},target=${passwordFile.containerPath},readonly`,
      "--env",
      `POSTGRES_DB=${input.database}`,
      "--env",
      `POSTGRES_USER=${input.username}`,
      "--env",
      `PGDATA=${POSTGRES_DATA_DIRECTORY}`,
      "--env",
      `POSTGRES_PASSWORD_FILE=${passwordFile.containerPath}`,
      image,
    ], commandTimeoutMs);
    if (runResult.status !== 0) failStart("docker_run_failed");

    try {
      const runIdentifiers = nonEmptyLines(runResult.stdout);
      if (runIdentifiers.length !== 1) {
        throw disposableIntegrationFailure("invalid_container_id");
      }
      expectedContainerId = requireContainerId(runIdentifiers[0]!);
      const namedContainerId = exactContainerId(commandTimeoutMs);
      if (namedContainerId !== expectedContainerId) {
        throw disposableIntegrationFailure("container_identity_mismatch");
      }
      verifyContainerIdentity(expectedContainerId, commandTimeoutMs);
      captureContainerVolumes(expectedContainerId, commandTimeoutMs);
    } catch {
      failStart("container_start_verification_failed");
    }
  };

  const getIdentity = (): DisposablePostgresIdentity => {
    if (expectedContainerId === undefined || !containerCleanupArmed) {
      throw disposableIntegrationFailure("container_identity_unavailable");
    }
    return {
      containerId: expectedContainerId,
      port: input.port,
      database: input.database,
      username: input.username,
    };
  };

  return { cleanup, getIdentity, start };
}

export function installDisposablePostgresSignalHandlers(input: Readonly<{
  container: DisposablePostgresContainer;
  processTarget: Readonly<{
    on: (signal: SignalName, listener: () => void) => void;
    exit: (code: number) => void;
  }>;
  cleanupRuntime?: () => void;
  terminateActiveChildren: (signal: SignalName) => Promise<void>;
  writeError: (message: string) => void;
}>): void {
  let handlingSignal = false;
  const finishSignal = (
    exitCode: number,
    childTerminationFailed: boolean,
  ) => {
    let cleanupFailed = false;
    try {
      input.container.cleanup();
    } catch {
      cleanupFailed = true;
    }
    try {
      input.cleanupRuntime?.();
    } catch {
      cleanupFailed = true;
    }

    if (childTerminationFailed) {
      input.writeError(
        "Disposable integration failed: signal_child_termination_failed",
      );
      input.processTarget.exit(1);
      return;
    }
    if (cleanupFailed) {
      input.writeError(
        "Disposable integration failed: signal_cleanup_failed",
      );
      input.processTarget.exit(1);
      return;
    }
    input.processTarget.exit(exitCode);
  };

  const install = (signal: SignalName, exitCode: number) => {
    input.processTarget.on(signal, () => {
      if (handlingSignal) return;
      handlingSignal = true;
      void (async () => {
        let childTerminationFailed = false;
        try {
          await input.terminateActiveChildren(signal);
        } catch {
          childTerminationFailed = true;
        }
        finishSignal(exitCode, childTerminationFailed);
      })();
    });
  };
  install("SIGINT", 130);
  install("SIGTERM", 143);
}

export async function runWithDisposablePostgresContainer<T>(
  container: Pick<DisposablePostgresContainer, "cleanup" | "start">,
  operation: () => Promise<T>,
): Promise<T> {
  let primaryFailed = false;
  let result: T | undefined;
  try {
    container.start();
    result = await operation();
  } catch {
    primaryFailed = true;
  }

  let cleanupFailed = false;
  try {
    container.cleanup();
  } catch {
    cleanupFailed = true;
  }

  if (
    primaryFailed
    && cleanupFailed
  ) {
    throw disposableIntegrationFailure("operation_and_cleanup_failed");
  }
  if (primaryFailed) {
    throw disposableIntegrationFailure("operation_failed");
  }
  if (cleanupFailed) {
    throw disposableIntegrationFailure("cleanup_failed");
  }
  return result as T;
}
