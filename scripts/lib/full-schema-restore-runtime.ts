import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
} from "node:fs";
import path from "node:path";

type PostgresMajor = 17 | 18;

type ContainerInspection = Readonly<{
  id: string;
  name: string;
  purpose: string;
  run: string;
  restoreRole: string;
}>;

type RestoreContainer = Readonly<{
  start: () => void;
  cleanup: () => void;
}>;

function invalidArguments(): never {
  throw new Error("full-schema restore arguments are invalid");
}

export function parseFullSchemaRestorePostgresMajor(
  args: readonly string[],
): PostgresMajor {
  if (args.length === 0) return 17;
  if (args.length !== 1) return invalidArguments();
  if (args[0] === "--postgres-major=17") return 17;
  if (args[0] === "--postgres-major=18") return 18;
  return invalidArguments();
}

function validContainerName(value: string): boolean {
  return /^codestead-full-restore-(?:source|target)-[0-9a-f]{8,32}$/u
    .test(value);
}

function invalidContainerIdentity(): never {
  throw new Error("full-schema restore container identity is invalid");
}

export function requireOwnedRestoreContainerId(input: Readonly<{
  expectedName: string;
  expectedRole: "source" | "target";
  listedIds: string;
  inspection: ContainerInspection;
}>): string {
  const identifiers = input.listedIds
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const identifier = identifiers[0];
  if (
    !validContainerName(input.expectedName)
    || identifiers.length !== 1
    || identifier === undefined
    || !/^[0-9a-f]{64}$/u.test(identifier)
    || input.inspection.id !== identifier
    || input.inspection.name !== `/${input.expectedName}`
    || input.inspection.purpose !== "disposable-integration-test"
    || input.inspection.run !== input.expectedName
    || input.inspection.restoreRole !== input.expectedRole
  ) {
    return invalidContainerIdentity();
  }
  return identifier;
}

function requireIdentifier(value: string): string {
  if (!/^[0-9a-f]{64}$/u.test(value)) return invalidContainerIdentity();
  return value;
}

function requireDatabaseName(value: string): string {
  if (!/^learncoding_restore_(?:source|target)$/u.test(value)) {
    return invalidArguments();
  }
  return value;
}

function requirePostgresUser(value: string): string {
  if (value !== "learncoding_restore_it") return invalidArguments();
  return value;
}

export function buildPostgresArchiveCommands(input: Readonly<{
  dockerCommand: string;
  sourceContainerId: string;
  targetContainerId: string;
  sourceDatabase: string;
  targetDatabase: string;
  postgresUser: string;
}>) {
  if (input.dockerCommand !== "docker" && input.dockerCommand !== "docker.exe") {
    return invalidArguments();
  }
  const sourceId = requireIdentifier(input.sourceContainerId);
  const targetId = requireIdentifier(input.targetContainerId);
  const sourceDatabase = requireDatabaseName(input.sourceDatabase);
  const targetDatabase = requireDatabaseName(input.targetDatabase);
  if (sourceDatabase === targetDatabase) return invalidArguments();
  const postgresUser = requirePostgresUser(input.postgresUser);
  return {
    dump: {
      command: input.dockerCommand,
      args: [
        "exec",
        sourceId,
        "pg_dump",
        "--format=custom",
        "--compress=0",
        "--no-owner",
        "--no-password",
        `--username=${postgresUser}`,
        `--dbname=${sourceDatabase}`,
      ],
    },
    list: {
      command: input.dockerCommand,
      args: [
        "exec",
        "--interactive",
        targetId,
        "pg_restore",
        "--list",
        "--no-password",
      ],
    },
    restoreWithoutAcl: {
      command: input.dockerCommand,
      args: [
        "exec",
        "--interactive",
        targetId,
        "pg_restore",
        "--clean",
        "--if-exists",
        "--exit-on-error",
        "--single-transaction",
        "--no-owner",
        "--role=learncoding_owner",
        "--no-acl",
        "--no-password",
        `--username=${postgresUser}`,
        `--dbname=${targetDatabase}`,
      ],
    },
    restore: {
      command: input.dockerCommand,
      args: [
        "exec",
        "--interactive",
        targetId,
        "pg_restore",
        "--clean",
        "--if-exists",
        "--exit-on-error",
        "--single-transaction",
        "--no-owner",
        "--role=learncoding_owner",
        "--no-password",
        `--username=${postgresUser}`,
        `--dbname=${targetDatabase}`,
      ],
    },
  } as const;
}

type FullSchemaRestoreTaskRootFileSystem = Readonly<{
  chmodSync: (target: string, mode: number) => void;
  mkdirSync: (
    target: string,
    options: Readonly<{ mode: number }>,
  ) => void;
  mkdtempSync: (prefix: string) => string;
  realpathSync: (target: string) => string;
  rmSync: (
    target: string,
    options: Readonly<{ recursive: true; force: false }>,
  ) => void;
}>;

const DEFAULT_TASK_ROOT_FILE_SYSTEM: FullSchemaRestoreTaskRootFileSystem = {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
};

export function createSafeFullSchemaRestoreTaskRoot(input: Readonly<{
  temporaryDirectory: string;
  ownTaskRoot: (cleanup: () => void) => void;
  fileSystem?: FullSchemaRestoreTaskRootFileSystem;
}>): Readonly<{
  root: string;
  sourceHome: string;
  targetHome: string;
  cleanup: () => void;
}> {
  const fileSystem = input.fileSystem ?? DEFAULT_TASK_ROOT_FILE_SYSTEM;
  const temporaryRoot = fileSystem.realpathSync(
    input.temporaryDirectory,
  );
  let root: string | undefined;
  let cleanup: (() => void) | undefined;
  try {
    root = fileSystem.mkdtempSync(
      path.join(temporaryRoot, "codestead-full-restore-"),
    );
    let cleaned = false;
    cleanup = () => {
      if (cleaned) return;
      const resolved = fileSystem.realpathSync(root!);
      if (
        path.dirname(resolved) !== temporaryRoot
        || !path.basename(resolved).startsWith(
          "codestead-full-restore-",
        )
      ) {
        throw new Error(
          "full-schema restore temporary root is invalid",
        );
      }
      fileSystem.rmSync(resolved, {
        recursive: true,
        force: false,
      });
      cleaned = true;
    };

    // This is the first statement after the first filesystem mutation.
    // It installs signal ownership before chmod/mkdir/container setup.
    input.ownTaskRoot(cleanup);
    fileSystem.chmodSync(root, 0o700);
    const sourceHome = path.join(root, "source-home");
    const targetHome = path.join(root, "target-home");
    fileSystem.mkdirSync(sourceHome, { mode: 0o700 });
    fileSystem.mkdirSync(targetHome, { mode: 0o700 });
    return { root, sourceHome, targetHome, cleanup };
  } catch {
    if (cleanup !== undefined) {
      try {
        cleanup();
      } catch {
        // The fixed setup failure below remains authoritative.
      }
    } else if (root !== undefined) {
      try {
        fileSystem.rmSync(root, { recursive: true, force: false });
      } catch {
        // The fixed setup failure below remains authoritative.
      }
    }
    throw new Error("full-schema restore task-root setup failed");
  }
}

export async function runWithRestoreContainerPair<T>(input: Readonly<{
  source: RestoreContainer;
  target: RestoreContainer;
  operation: () => Promise<T>;
}>): Promise<T> {
  let operationFailed = false;
  let result: T | undefined;
  try {
    input.source.start();
    input.target.start();
    result = await input.operation();
  } catch {
    operationFailed = true;
  }

  let cleanupFailed = false;
  for (const container of [input.target, input.source]) {
    try {
      container.cleanup();
    } catch {
      cleanupFailed = true;
    }
  }

  if (operationFailed && cleanupFailed) {
    throw new Error("full-schema restore operation and cleanup failed");
  }
  if (operationFailed) {
    throw new Error("full-schema restore operation failed");
  }
  if (cleanupFailed) {
    throw new Error("full-schema restore cleanup failed");
  }
  return result as T;
}

export async function runWithRestoreTaskRoot<T>(input: Readonly<{
  cleanup: () => void;
  operation: () => Promise<T>;
}>): Promise<T> {
  let operationFailed = false;
  let result: T | undefined;
  try {
    result = await input.operation();
  } catch {
    operationFailed = true;
  }

  let cleanupFailed = false;
  try {
    input.cleanup();
  } catch {
    cleanupFailed = true;
  }

  if (operationFailed && cleanupFailed) {
    throw new Error(
      "full-schema restore task operation and cleanup failed",
    );
  }
  if (operationFailed) {
    throw new Error("full-schema restore task operation failed");
  }
  if (cleanupFailed) {
    throw new Error("full-schema restore task cleanup failed");
  }
  return result as T;
}
