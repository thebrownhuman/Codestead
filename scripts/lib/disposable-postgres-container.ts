import { spawnSync } from "node:child_process";

import {
  buildDockerIntegrationEnvironment,
  buildSafeIntegrationHostEnvironment,
} from "./disposable-integration-environment";

const PURPOSE_LABEL = "com.learncoding.purpose=disposable-integration-test";
const POSTGRES_DATA_DIRECTORY = "/var/lib/postgresql/data";
const POSTGRES_TMPFS =
  `${POSTGRES_DATA_DIRECTORY}:rw,nosuid,nodev,size=512m`;
const CONTAINER_LABEL_TEMPLATE =
  `com.learncoding.purpose={{ index .Config.Labels "com.learncoding.purpose" }}`;
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

export type DisposablePostgresContainer = Readonly<{
  cleanup: () => void;
  start: () => void;
}>;

type SignalName = "SIGINT" | "SIGTERM";

function failure(code: string): Error {
  return new Error(`Disposable PostgreSQL container failed: ${code}`);
}

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
  if (!Number.isSafeInteger(value) || value <= 0) throw failure(code);
  return value;
}

function requireContainerName(value: string): string {
  if (!/^[a-z0-9][a-z0-9_.-]{0,127}$/u.test(value)) {
    throw failure("invalid_container_name");
  }
  return value;
}

function requireVolumeName(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/u.test(value)) {
    throw failure("invalid_volume_name");
  }
  return value;
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
  sourceEnvironment: NodeJS.ProcessEnv;
  execute?: (
    invocation: DisposableDockerInvocation,
  ) => DisposableDockerCommandResult;
  commandTimeoutMs?: number;
  cleanupTimeoutMs?: number;
}>): DisposablePostgresContainer {
  const execute = input.execute ?? executeDisposableDockerCommand;
  const containerName = requireContainerName(input.containerName);
  const escapedContainerName = escapeFilterPattern(containerName);
  const commandTimeoutMs = requirePositiveTimeout(
    input.commandTimeoutMs ?? 30_000,
    "invalid_command_timeout",
  );
  const cleanupTimeoutMs = requirePositiveTimeout(
    input.cleanupTimeoutMs ?? 5_000,
    "invalid_cleanup_timeout",
  );
  const hostEnvironment = buildSafeIntegrationHostEnvironment(
    input.sourceEnvironment,
  );
  const dockerEnvironment = buildDockerIntegrationEnvironment(
    input.sourceEnvironment,
    input.password,
  );
  const capturedVolumes = new Set<string>();
  let cleanupArmed = false;

  const invoke = (
    args: readonly string[],
    timeoutMs: number,
    environment: NodeJS.ProcessEnv = hostEnvironment,
  ): DisposableDockerCommandResult => {
    try {
      return execute({
        command: input.dockerCommand,
        args,
        environment,
        timeoutMs,
      });
    } catch {
      return { status: null, errorCode: "EXECUTOR_THROW" };
    }
  };

  const exactContainerId = (timeoutMs: number): string | null => {
    const result = invoke([
      "container",
      "ls",
      "--all",
      "--quiet",
      "--filter",
      `name=^/${escapedContainerName}$`,
    ], timeoutMs);
    if (result.status !== 0) throw failure("container_probe_failed");
    const identifiers = nonEmptyLines(result.stdout);
    if (identifiers.length > 1) throw failure("container_probe_ambiguous");
    return identifiers[0] ?? null;
  };

  const verifyContainerIdentity = (timeoutMs: number): void => {
    const result = invoke([
      "container",
      "inspect",
      "--format",
      CONTAINER_LABEL_TEMPLATE,
      containerName,
    ], timeoutMs);
    if (result.status !== 0) throw failure("container_identity_probe_failed");
    if (result.stdout?.trim() !== PURPOSE_LABEL) {
      throw failure("container_identity_mismatch");
    }
  };

  const captureContainerVolumes = (timeoutMs: number): void => {
    const result = invoke([
      "container",
      "inspect",
      "--format",
      CONTAINER_VOLUMES_TEMPLATE,
      containerName,
    ], timeoutMs);
    if (result.status !== 0) throw failure("container_volume_probe_failed");
    for (const name of nonEmptyLines(result.stdout)) {
      capturedVolumes.add(requireVolumeName(name));
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
    if (result.status !== 0) throw failure("volume_probe_failed");
    const names = nonEmptyLines(result.stdout);
    if (names.some((candidate) => candidate !== name)) {
      throw failure("volume_probe_ambiguous");
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
    if (result.status !== 0 && exactVolumePresent(name)) {
      throw failure("volume_remove_failed");
    }
    if (exactVolumePresent(name)) {
      throw failure("volume_still_present");
    }
  };

  const cleanup = (): void => {
    if (!cleanupArmed) return;

    const existingContainerId = exactContainerId(cleanupTimeoutMs);
    if (existingContainerId !== null) {
      verifyContainerIdentity(cleanupTimeoutMs);
      captureContainerVolumes(cleanupTimeoutMs);
      const removeResult = invoke([
        "container",
        "rm",
        "--force",
        "--volumes",
        containerName,
      ], cleanupTimeoutMs);
      const remainingContainerId = exactContainerId(cleanupTimeoutMs);
      if (removeResult.status !== 0 && remainingContainerId !== null) {
        throw failure("container_remove_failed");
      }
      if (remainingContainerId !== null) {
        throw failure("container_still_present");
      }
    }

    for (const name of capturedVolumes) {
      removeCapturedVolume(name);
    }
    capturedVolumes.clear();
    cleanupArmed = false;
  };

  const failStart = (primaryFailure: Error): never => {
    try {
      cleanup();
    } catch (cleanupFailure) {
      throw new AggregateError(
        [primaryFailure, cleanupFailure],
        "Disposable PostgreSQL container failed: start_and_cleanup_failed",
      );
    }
    throw primaryFailure;
  };

  const start = (): void => {
    if (cleanupArmed) throw failure("container_already_started");
    const versionResult = invoke([
      "version",
      "--format",
      "{{.Server.Version}}",
    ], commandTimeoutMs);
    if (versionResult.status !== 0) throw failure("docker_unavailable");

    cleanupArmed = true;
    const runResult = invoke([
      "run",
      "--detach",
      "--rm",
      "--name",
      containerName,
      "--label",
      PURPOSE_LABEL,
      "--publish",
      `127.0.0.1:${input.port}:5432`,
      "--tmpfs",
      POSTGRES_TMPFS,
      "--env",
      `POSTGRES_DB=${input.database}`,
      "--env",
      `POSTGRES_USER=${input.username}`,
      "--env",
      `PGDATA=${POSTGRES_DATA_DIRECTORY}`,
      "--env",
      "POSTGRES_PASSWORD",
      input.image,
    ], commandTimeoutMs, dockerEnvironment);
    if (runResult.status !== 0) {
      failStart(failure("docker_run_failed"));
    }

    try {
      if (exactContainerId(commandTimeoutMs) === null) {
        throw failure("container_missing_after_start");
      }
      verifyContainerIdentity(commandTimeoutMs);
      captureContainerVolumes(commandTimeoutMs);
    } catch (error) {
      failStart(
        error instanceof Error
          ? error
          : failure("container_start_verification_failed"),
      );
    }
  };

  return { cleanup, start };
}

export function installDisposablePostgresSignalHandlers(input: Readonly<{
  container: DisposablePostgresContainer;
  processTarget: Readonly<{
    once: (signal: SignalName, listener: () => void) => void;
    exit: (code: number) => void;
  }>;
  writeError: (message: string) => void;
}>): void {
  const install = (signal: SignalName, exitCode: number) => {
    input.processTarget.once(signal, () => {
      try {
        input.container.cleanup();
        input.processTarget.exit(exitCode);
      } catch {
        input.writeError(
          "Disposable PostgreSQL container failed: signal_cleanup_failed",
        );
        input.processTarget.exit(1);
      }
    });
  };
  install("SIGINT", 130);
  install("SIGTERM", 143);
}

export async function runWithDisposablePostgresContainer<T>(
  container: DisposablePostgresContainer,
  operation: () => Promise<T>,
): Promise<T> {
  let primaryFailure: unknown;
  try {
    container.start();
    return await operation();
  } catch (error) {
    primaryFailure = error;
    throw error;
  } finally {
    try {
      container.cleanup();
    } catch (cleanupFailure) {
      if (primaryFailure !== undefined) {
        throw new AggregateError(
          [primaryFailure, cleanupFailure],
          "Disposable PostgreSQL container failed: operation_and_cleanup_failed",
        );
      }
      throw cleanupFailure;
    }
  }
}
