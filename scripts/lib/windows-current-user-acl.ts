import { spawnSync } from "node:child_process";
import path from "node:path";

import {
  minimalNodeTestEnvironment,
  type DisposableIntegrationEnvironmentSource,
} from "./disposable-integration-environment";
import { disposableIntegrationFailure } from
  "./disposable-integration-error";

const WINDOWS_ACL_TIMEOUT_MS = 5_000;
const CURRENT_USER_SID_PATTERN =
  /^"[^"\r\n]+","(S-1-\d+(?:-\d+){1,15})"\r?\n?$/u;

type WindowsAclPermission = "(OI)(CI)F" | "(R,W,D)";

export type WindowsAclCommandRunner = (
  input: Readonly<{
    command: string;
    args: readonly string[];
    environment: NodeJS.ProcessEnv;
    captureStdout: boolean;
  }>,
) => Readonly<{
  status: number | null;
  stdout: string;
}>;

const DEFAULT_COMMAND_RUNNER: WindowsAclCommandRunner = (input) => {
  const result = spawnSync(input.command, [...input.args], {
    encoding: "utf8",
    env: input.environment,
    stdio: input.captureStdout
      ? ["ignore", "pipe", "ignore"]
      : "ignore",
    timeout: WINDOWS_ACL_TIMEOUT_MS,
    windowsHide: true,
  });
  return {
    status: result.status,
    stdout: typeof result.stdout === "string" ? result.stdout : "",
  };
};

export function parseWindowsCurrentUserSid(output: string): string {
  const match = CURRENT_USER_SID_PATTERN.exec(output);
  if (match?.[1] === undefined) {
    throw disposableIntegrationFailure(
      "windows_current_user_sid_invalid",
    );
  }
  return match[1];
}

export function secureWindowsPathForCurrentUser(input: Readonly<{
  targetPath: string;
  permissions: WindowsAclPermission;
  failureCode: string;
  environment?: DisposableIntegrationEnvironmentSource;
  runCommand?: WindowsAclCommandRunner;
}>): void {
  const environment = minimalNodeTestEnvironment(
    input.environment ?? process.env,
  );
  const systemRoot = environment.SYSTEMROOT ?? environment.WINDIR
    ?? "C:\\Windows";
  const runCommand = input.runCommand ?? DEFAULT_COMMAND_RUNNER;
  const whoamiCommand = path.join(
    systemRoot,
    "System32",
    "whoami.exe",
  );
  const identityResult = runCommand({
    command: whoamiCommand,
    args: ["/user", "/fo", "csv", "/nh"],
    environment,
    captureStdout: true,
  });

  let sid: string;
  try {
    if (identityResult.status !== 0) {
      throw disposableIntegrationFailure(input.failureCode);
    }
    sid = parseWindowsCurrentUserSid(identityResult.stdout);
  } catch {
    throw disposableIntegrationFailure(input.failureCode);
  }

  const icaclsCommand = path.join(
    systemRoot,
    "System32",
    "icacls.exe",
  );
  for (const args of [
    [
      input.targetPath,
      "/inheritance:r",
      "/grant:r",
      `*${sid}:${input.permissions}`,
    ],
    [input.targetPath, "/verify"],
  ]) {
    const result = runCommand({
      command: icaclsCommand,
      args,
      environment,
      captureStdout: false,
    });
    if (result.status !== 0) {
      throw disposableIntegrationFailure(input.failureCode);
    }
  }
}
