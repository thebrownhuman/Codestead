import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir, userInfo } from "node:os";
import path from "node:path";

import { minimalNodeTestEnvironment } from
  "./disposable-integration-environment";
import { disposableIntegrationFailure } from
  "./disposable-integration-error";

const TASK_HOME_MODE = 0o700;
const WINDOWS_ACL_TIMEOUT_MS = 5_000;

export type DisposableTaskHomeOperations = Readonly<{
  makeTemporaryDirectory: (prefix: string) => string;
  makeDirectory: (directoryPath: string, mode: number) => void;
  setDirectoryMode: (directoryPath: string, mode: number) => void;
  readDirectoryMode: (directoryPath: string) => number;
  isDirectory: (directoryPath: string) => boolean;
  pathExists: (directoryPath: string) => boolean;
  removeDirectory: (directoryPath: string) => void;
  secureWindowsDirectory: (directoryPath: string) => void;
}>;

export type DisposableIntegrationTaskHome = Readonly<{
  path: string;
  cleanup: () => void;
}>;

function secureWindowsDirectory(directoryPath: string): void {
  const systemRoot = process.env.SYSTEMROOT ?? process.env.SystemRoot
    ?? "C:\\Windows";
  const command = path.join(systemRoot, "System32", "icacls.exe");
  const username = userInfo().username;
  for (const args of [
    [
      directoryPath,
      "/inheritance:r",
      "/grant:r",
      `${username}:(OI)(CI)F`,
    ],
    [directoryPath, "/verify"],
  ]) {
    const result = spawnSync(command, args, {
      env: minimalNodeTestEnvironment(process.env),
      stdio: "ignore",
      timeout: WINDOWS_ACL_TIMEOUT_MS,
      windowsHide: true,
    });
    if (result.status !== 0) {
      throw disposableIntegrationFailure("task_home_windows_acl_failed");
    }
  }
}

const DEFAULT_OPERATIONS: DisposableTaskHomeOperations = {
  makeTemporaryDirectory: (prefix) => mkdtempSync(prefix),
  makeDirectory: (directoryPath, mode) => mkdirSync(directoryPath, {
    mode,
  }),
  setDirectoryMode: (directoryPath, mode) => chmodSync(directoryPath, mode),
  readDirectoryMode: (directoryPath) => statSync(directoryPath).mode & 0o777,
  isDirectory: (directoryPath) => {
    try {
      return lstatSync(directoryPath).isDirectory();
    } catch {
      return false;
    }
  },
  pathExists: (directoryPath) => existsSync(directoryPath),
  removeDirectory: (directoryPath) => rmSync(directoryPath, {
    force: true,
    recursive: true,
    maxRetries: 0,
  }),
  secureWindowsDirectory,
};

export function createDisposableIntegrationTaskHome(
  input: Readonly<{
    temporaryRoot?: string;
    platform?: NodeJS.Platform;
    operations?: DisposableTaskHomeOperations;
  }> = {},
): DisposableIntegrationTaskHome {
  const operations = input.operations ?? DEFAULT_OPERATIONS;
  const platform = input.platform ?? process.platform;
  const temporaryRoot = path.resolve(input.temporaryRoot ?? tmpdir());
  const prefix = path.join(temporaryRoot, "codestead-integration-home-");
  let directoryPath: string | undefined;
  let cleanupArmed = false;

  const cleanup = (): void => {
    if (!cleanupArmed) return;
    let removalFailed = false;
    try {
      if (directoryPath !== undefined) {
        operations.removeDirectory(directoryPath);
      }
    } catch {
      removalFailed = true;
    }
    if (
      directoryPath !== undefined
      && operations.pathExists(directoryPath)
    ) {
      removalFailed = true;
    }
    if (removalFailed) {
      throw disposableIntegrationFailure("task_home_still_present");
    }
    cleanupArmed = false;
  };

  try {
    directoryPath = operations.makeTemporaryDirectory(prefix);
    cleanupArmed = true;
    if (
      path.dirname(directoryPath) !== temporaryRoot
      || !path.basename(directoryPath).startsWith(
        "codestead-integration-home-",
      )
    ) {
      throw disposableIntegrationFailure("task_home_invalid");
    }
    operations.setDirectoryMode(directoryPath, TASK_HOME_MODE);
    if (platform === "win32") {
      operations.secureWindowsDirectory(directoryPath);
    } else if (
      operations.readDirectoryMode(directoryPath) !== TASK_HOME_MODE
    ) {
      throw disposableIntegrationFailure("task_home_mode_invalid");
    }
    if (!operations.isDirectory(directoryPath)) {
      throw disposableIntegrationFailure("task_home_invalid");
    }
    const temporaryDirectory = path.join(directoryPath, "tmp");
    operations.makeDirectory(temporaryDirectory, TASK_HOME_MODE);
    operations.setDirectoryMode(temporaryDirectory, TASK_HOME_MODE);
    if (platform === "win32") {
      operations.secureWindowsDirectory(temporaryDirectory);
    } else if (
      operations.readDirectoryMode(temporaryDirectory) !== TASK_HOME_MODE
    ) {
      throw disposableIntegrationFailure(
        "task_home_temp_mode_invalid",
      );
    }
    if (!operations.isDirectory(temporaryDirectory)) {
      throw disposableIntegrationFailure(
        "task_home_temp_invalid",
      );
    }
  } catch {
    try {
      cleanup();
    } catch {
      throw disposableIntegrationFailure(
        "task_home_create_and_cleanup_failed",
      );
    }
    throw disposableIntegrationFailure("task_home_create_failed");
  }

  return {
    path: directoryPath,
    cleanup,
  };
}
