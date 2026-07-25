import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  rmSync,
  rmdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  DisposableIntegrationLifecycleError,
  disposableIntegrationFailure,
} from
  "./disposable-integration-error";
import { secureWindowsPathForCurrentUser } from
  "./windows-current-user-acl";

const PASSWORD_FILE_NAME = "postgres-password";
const PASSWORD_FILE_MODE = 0o600;
const PASSWORD_CONTAINER_PATH = "/run/secrets/postgres-password";
const SAFE_PASSWORD_FILE_CREATION_CODES = new Set([
  "password_file_windows_acl_failed",
  "password_directory_invalid",
  "password_file_mode_invalid",
  "password_file_invalid",
]);

export type DisposablePasswordFileOperations = Readonly<{
  makeTemporaryDirectory: (prefix: string) => string;
  writeExclusiveFile: (
    filePath: string,
    content: string,
    mode: number,
  ) => void;
  setFileMode: (filePath: string, mode: number) => void;
  readFileMode: (filePath: string) => number;
  isFile: (filePath: string) => boolean;
  pathExists: (filePath: string) => boolean;
  removeFile: (filePath: string) => void;
  removeDirectory: (directoryPath: string) => void;
  secureWindowsPath: (
    targetPath: string,
    kind: "directory" | "file",
  ) => void;
}>;

export type DisposablePostgresPasswordFile = Readonly<{
  hostPath: string;
  containerPath: string;
  cleanup: () => void;
}>;

function secureWindowsPath(
  targetPath: string,
  kind: "directory" | "file",
): void {
  const permissions = kind === "directory"
    ? "(OI)(CI)F"
    : "(R,W,D)";
  secureWindowsPathForCurrentUser({
    targetPath,
    permissions,
    failureCode: "password_file_windows_acl_failed",
  });
}

const DEFAULT_OPERATIONS: DisposablePasswordFileOperations = {
  makeTemporaryDirectory: (prefix) => mkdtempSync(prefix),
  writeExclusiveFile: (filePath, content, mode) => {
    writeFileSync(filePath, content, {
      encoding: "utf8",
      flag: "wx",
      mode,
    });
  },
  setFileMode: (filePath, mode) => chmodSync(filePath, mode),
  readFileMode: (filePath) => statSync(filePath).mode & 0o777,
  isFile: (filePath) => {
    try {
      return lstatSync(filePath).isFile();
    } catch {
      return false;
    }
  },
  pathExists: (filePath) => existsSync(filePath),
  removeFile: (filePath) => rmSync(filePath, { force: true }),
  removeDirectory: (directoryPath) => rmdirSync(directoryPath),
  secureWindowsPath,
};

export function createDisposablePostgresPasswordFile(input: Readonly<{
  password: string;
  temporaryRoot?: string;
  platform?: NodeJS.Platform;
  operations?: DisposablePasswordFileOperations;
}>): DisposablePostgresPasswordFile {
  const operations = input.operations ?? DEFAULT_OPERATIONS;
  const platform = input.platform ?? process.platform;
  const temporaryRoot = path.resolve(input.temporaryRoot ?? tmpdir());
  const prefix = path.join(temporaryRoot, "codestead-postgres-it-");
  let directoryPath: string | undefined;
  let passwordFilePath: string | undefined;
  let cleanupArmed = false;

  const cleanupPaths = (): void => {
    if (!cleanupArmed) return;
    let fileRemovalFailed = false;
    let directoryRemovalFailed = false;

    if (passwordFilePath !== undefined) {
      try {
        operations.removeFile(passwordFilePath);
      } catch {
        fileRemovalFailed = true;
      }
      if (operations.pathExists(passwordFilePath)) {
        fileRemovalFailed = true;
      }
    }

    if (directoryPath !== undefined) {
      try {
        operations.removeDirectory(directoryPath);
      } catch {
        directoryRemovalFailed = true;
      }
      if (operations.pathExists(directoryPath)) {
        directoryRemovalFailed = true;
      }
    }

    if (fileRemovalFailed) {
      throw disposableIntegrationFailure("password_file_still_present");
    }
    if (directoryRemovalFailed) {
      throw disposableIntegrationFailure("password_directory_still_present");
    }
    cleanupArmed = false;
  };

  try {
    directoryPath = operations.makeTemporaryDirectory(prefix);
    cleanupArmed = true;
    if (
      path.dirname(directoryPath) !== temporaryRoot
      || !path.basename(directoryPath).startsWith("codestead-postgres-it-")
    ) {
      throw disposableIntegrationFailure("password_directory_invalid");
    }
    if (platform === "win32") {
      operations.secureWindowsPath(directoryPath, "directory");
    }

    passwordFilePath = path.join(directoryPath, PASSWORD_FILE_NAME);
    operations.writeExclusiveFile(
      passwordFilePath,
      input.password,
      PASSWORD_FILE_MODE,
    );
    operations.setFileMode(passwordFilePath, PASSWORD_FILE_MODE);
    if (platform === "win32") {
      operations.secureWindowsPath(passwordFilePath, "file");
    } else if (operations.readFileMode(passwordFilePath) !== PASSWORD_FILE_MODE) {
      throw disposableIntegrationFailure("password_file_mode_invalid");
    }
    if (!operations.isFile(passwordFilePath)) {
      throw disposableIntegrationFailure("password_file_invalid");
    }
  } catch (error) {
    const code = error instanceof DisposableIntegrationLifecycleError
        && SAFE_PASSWORD_FILE_CREATION_CODES.has(error.code)
      ? error.code
      : "password_file_create_failed";
    try {
      cleanupPaths();
    } catch {
      throw disposableIntegrationFailure(
        "password_file_create_and_cleanup_failed",
      );
    }
    throw disposableIntegrationFailure(code);
  }

  const hostPath = passwordFilePath;
  if (hostPath === undefined) {
    throw disposableIntegrationFailure("password_file_create_failed");
  }
  return {
    hostPath,
    containerPath: PASSWORD_CONTAINER_PATH,
    cleanup: cleanupPaths,
  };
}
