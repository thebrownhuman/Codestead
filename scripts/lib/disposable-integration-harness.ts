import type { DisposableIntegrationEnvironmentSource } from
  "./disposable-integration-environment";
import {
  createDisposablePostgresContainer,
  installDisposablePostgresSignalHandlers,
  POSTGRES_17_INTEGRATION_IMAGE,
  POSTGRES_18_INTEGRATION_IMAGE,
  runWithDisposablePostgresContainer,
  type DisposablePostgresContainer,
} from "./disposable-postgres-container";
import {
  createDisposableIntegrationTaskHome,
  type DisposableIntegrationTaskHome,
} from "./disposable-integration-task-home";
import { disposableIntegrationFailure } from
  "./disposable-integration-error";

type SignalName = "SIGINT" | "SIGTERM";

export type DisposablePostgresImageSelection = Readonly<{
  image: string;
  major: 17 | 18;
}>;

export function resolveDisposablePostgresImage(
  requestedImage: string | undefined,
): DisposablePostgresImageSelection {
  if (requestedImage === undefined) {
    return { image: POSTGRES_17_INTEGRATION_IMAGE, major: 17 };
  }
  if (requestedImage === POSTGRES_17_INTEGRATION_IMAGE) {
    return { image: requestedImage, major: 17 };
  }
  if (requestedImage === POSTGRES_18_INTEGRATION_IMAGE) {
    return { image: requestedImage, major: 18 };
  }
  throw disposableIntegrationFailure("invalid_postgres_image");
}

type HarnessProcessTarget = Readonly<{
  on: (signal: SignalName, listener: () => void) => void;
  exit: (code: number) => void;
}>;

type ContainerInput = Parameters<typeof createDisposablePostgresContainer>[0];
type SignalInput = Parameters<
  typeof installDisposablePostgresSignalHandlers
>[0];

export type DisposableIntegrationHarnessContext = Readonly<{
  container: DisposablePostgresContainer;
  image: string;
  postgresMajor: 17 | 18;
  taskHomeDirectory: string;
}>;

export async function runWithDisposableIntegrationHarness<T>(
  input: Readonly<{
    dockerCommand: string;
    containerName: string;
    requestedImage?: string;
    port: number;
    database: string;
    username: string;
    password: string;
    sourceEnvironment: DisposableIntegrationEnvironmentSource;
    processTarget: HarnessProcessTarget;
    writeError: (message: string) => void;
    terminateActiveChildren: (signal: SignalName) => Promise<void>;
    createTaskHome?: () => DisposableIntegrationTaskHome;
    createContainer?: (input: ContainerInput) => DisposablePostgresContainer;
    installSignalHandlers?: (input: SignalInput) => void;
  }>,
  operation: (
    context: DisposableIntegrationHarnessContext,
  ) => Promise<T>,
): Promise<T> {
  const selection = resolveDisposablePostgresImage(input.requestedImage);
  const createTaskHome =
    input.createTaskHome ?? createDisposableIntegrationTaskHome;
  const createContainer =
    input.createContainer ?? createDisposablePostgresContainer;
  const installSignalHandlers =
    input.installSignalHandlers ?? installDisposablePostgresSignalHandlers;

  let taskHome: DisposableIntegrationTaskHome;
  try {
    taskHome = createTaskHome();
  } catch {
    throw disposableIntegrationFailure("harness_task_home_create_failed");
  }

  let container: DisposablePostgresContainer;
  try {
    container = createContainer({
      dockerCommand: input.dockerCommand,
      containerName: input.containerName,
      image: selection.image,
      port: input.port,
      database: input.database,
      username: input.username,
      password: input.password,
      taskHomeDirectory: taskHome.path,
      sourceEnvironment: input.sourceEnvironment,
    });
    installSignalHandlers({
      container,
      cleanupRuntime: taskHome.cleanup,
      processTarget: input.processTarget,
      writeError: input.writeError,
      terminateActiveChildren: input.terminateActiveChildren,
    });
  } catch {
    try {
      taskHome.cleanup();
    } catch {
      throw disposableIntegrationFailure(
        "harness_setup_and_home_cleanup_failed",
      );
    }
    throw disposableIntegrationFailure("harness_setup_failed");
  }

  let operationFailed = false;
  let result: T | undefined;
  try {
    result = await runWithDisposablePostgresContainer(
      container,
      () => operation({
        container,
        image: selection.image,
        postgresMajor: selection.major,
        taskHomeDirectory: taskHome.path,
      }),
    );
  } catch (error) {
    process.stderr.write(
      `[pg17-proof-harness] ${
        error instanceof Error ? error.message : "operation failed"
      }\n`,
    );
    operationFailed = true;
  }

  let homeCleanupFailed = false;
  try {
    taskHome.cleanup();
  } catch {
    homeCleanupFailed = true;
  }

  if (operationFailed && homeCleanupFailed) {
    throw disposableIntegrationFailure(
      "harness_operation_and_home_cleanup_failed",
    );
  }
  if (operationFailed) {
    throw disposableIntegrationFailure("harness_operation_failed");
  }
  if (homeCleanupFailed) {
    throw disposableIntegrationFailure("harness_home_cleanup_failed");
  }
  return result as T;
}
