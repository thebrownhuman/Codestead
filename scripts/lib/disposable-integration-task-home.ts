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
import { tmpdir } from "node:os";
import path from "node:path";

import { minimalNodeTestEnvironment } from
  "./disposable-integration-environment";
import { disposableIntegrationFailure } from
  "./disposable-integration-error";

const TASK_HOME_MODE = 0o700;
const WINDOWS_ACL_TIMEOUT_MS = 5_000;
const WINDOWS_SID_MAX_IDENTIFIER_AUTHORITY = 281_474_976_710_655n;
const WINDOWS_SID_MAX_SUB_AUTHORITY = 4_294_967_295n;
const WINDOWS_SID_MAX_SUB_AUTHORITIES = 15;
const WINDOWS_SYSTEM_SID = "S-1-5-18";
const WINDOWS_ADMINISTRATORS_SID = "S-1-5-32-544";
const WINDOWS_FULL_CONTROL = 2_032_127;
const WINDOWS_DIRECTORY_INHERITANCE_FLAGS = 3;
const WINDOWS_COMMAND_MAX_BUFFER = 64 * 1_024;
const WINDOWS_ACL_SNAPSHOT_MAX_LENGTH = 64 * 1_024;
const WHOAMI_OUTPUT_MAX_LENGTH = 4_096;

function failWindowsAcl(): never {
  throw disposableIntegrationFailure("task_home_windows_acl_failed");
}

function isCanonicalDecimal(value: string): boolean {
  return /^(?:0|[1-9][0-9]*)$/.test(value);
}

function isCanonicalWindowsSid(value: string): boolean {
  const components = value.split("-");
  const subAuthorities = components.slice(3);
  if (
    components[0] !== "S"
    || components[1] !== "1"
    || !isCanonicalDecimal(components[2] ?? "")
    || subAuthorities.length < 1
    || subAuthorities.length > WINDOWS_SID_MAX_SUB_AUTHORITIES
    || subAuthorities.some((component) => !isCanonicalDecimal(component))
  ) {
    return false;
  }
  return BigInt(components[2]!) <= WINDOWS_SID_MAX_IDENTIFIER_AUTHORITY
    && subAuthorities.every(
      (component) => BigInt(component) <= WINDOWS_SID_MAX_SUB_AUTHORITY,
    );
}

export function parseWindowsWhoamiUserSid(output: string): string {
  if (output.length === 0 || output.length > WHOAMI_OUTPUT_MAX_LENGTH) {
    failWindowsAcl();
  }
  const record = output.endsWith("\r\n")
    ? output.slice(0, -2)
    : output.endsWith("\n") ? output.slice(0, -1) : output;
  const match = /^"(?:""|[^"\r\n])*","([^"\r\n]+)"$/.exec(record);
  const sid = match?.[1];
  if (sid === undefined || !isCanonicalWindowsSid(sid)) failWindowsAcl();
  return sid;
}

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactlyKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length
    && actual.every((key, index) => key === sortedExpected[index]);
}

function expectedWindowsAclSids(userSid: string): readonly string[] {
  return [...new Set([
    userSid,
    WINDOWS_SYSTEM_SID,
    WINDOWS_ADMINISTRATORS_SID,
  ])];
}

function validatedWindowsSystemRoot(): string {
  const value = process.env.SYSTEMROOT ?? process.env.SystemRoot
    ?? "C:\\Windows";
  const normalized = path.win32.normalize(value);
  const root = path.win32.parse(normalized).root;
  if (
    value.includes("\0")
    || !path.win32.isAbsolute(value)
    || !/^[A-Za-z]:\\$/.test(root)
    || normalized === root
  ) {
    failWindowsAcl();
  }
  return normalized;
}

function runWindowsCommand(
  command: string,
  args: readonly string[],
): string {
  const result = spawnSync(command, [...args], {
    encoding: "utf8",
    env: minimalNodeTestEnvironment(process.env),
    maxBuffer: WINDOWS_COMMAND_MAX_BUFFER,
    shell: false,
    stdio: ["ignore", "pipe", "ignore"],
    timeout: WINDOWS_ACL_TIMEOUT_MS,
    windowsHide: true,
  });
  if (result.status !== 0 || typeof result.stdout !== "string") {
    failWindowsAcl();
  }
  return result.stdout;
}

function powershellAclSnapshotArguments(
  directoryPath: string,
): readonly string[] {
  const encodedPath = Buffer.from(directoryPath, "utf8").toString("base64");
  const script = [
    "$ErrorActionPreference='Stop'",
    "[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)",
    "$target=[System.Text.Encoding]::UTF8.GetString("+
      `[Convert]::FromBase64String('${encodedPath}'))`,
    "$acl=Get-Acl -LiteralPath $target -ErrorAction Stop",
    "$rules=@($acl.GetAccessRules($true,$true,"+
      "[System.Security.Principal.SecurityIdentifier])|ForEach-Object{"+
      "[PSCustomObject]@{"+
      "sid=$_.IdentityReference.Value;"+
      "accessControlType=[int]$_.AccessControlType;"+
      "fileSystemRights=[int]$_.FileSystemRights;"+
      "inheritanceFlags=[int]$_.InheritanceFlags;"+
      "propagationFlags=[int]$_.PropagationFlags;"+
      "isInherited=[bool]$_.IsInherited}})",
    "$snapshot=[PSCustomObject]@{"+
      "accessRulesProtected=[bool]$acl.AreAccessRulesProtected;"+
      "rules=$rules}",
    "$json=$snapshot|ConvertTo-Json -Compress -Depth 4",
    "[Console]::Out.Write($json)",
  ].join(";");
  return [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-EncodedCommand",
    Buffer.from(script, "utf16le").toString("base64"),
  ];
}

function assertExactWindowsDirectoryAcl(
  output: string,
  userSid: string,
): void {
  if (
    output.length === 0
    || output.length > WINDOWS_ACL_SNAPSHOT_MAX_LENGTH
  ) {
    failWindowsAcl();
  }
  let value: unknown;
  try {
    value = JSON.parse(output.trim());
  } catch {
    failWindowsAcl();
  }
  if (
    !isRecord(value)
    || !hasExactlyKeys(value, ["accessRulesProtected", "rules"])
    || value.accessRulesProtected !== true
    || !Array.isArray(value.rules)
  ) {
    failWindowsAcl();
  }

  const expectedSids = expectedWindowsAclSids(userSid);
  const expectedSidSet = new Set(expectedSids);
  if (value.rules.length !== expectedSids.length) failWindowsAcl();
  const seenSids = new Set<string>();
  const ruleKeys = [
    "accessControlType",
    "fileSystemRights",
    "inheritanceFlags",
    "isInherited",
    "propagationFlags",
    "sid",
  ];
  for (const candidate of value.rules) {
    if (!isRecord(candidate) || !hasExactlyKeys(candidate, ruleKeys)) {
      failWindowsAcl();
    }
    const sid = candidate.sid;
    if (
      typeof sid !== "string"
      || !isCanonicalWindowsSid(sid)
      || !expectedSidSet.has(sid)
      || seenSids.has(sid)
      || candidate.accessControlType !== 0
      || candidate.fileSystemRights !== WINDOWS_FULL_CONTROL
      || candidate.inheritanceFlags !== WINDOWS_DIRECTORY_INHERITANCE_FLAGS
      || candidate.propagationFlags !== 0
      || candidate.isInherited !== false
    ) {
      failWindowsAcl();
    }
    seenSids.add(sid);
  }
  if (seenSids.size !== expectedSidSet.size) failWindowsAcl();
}

function secureWindowsDirectory(directoryPath: string): void {
  const systemRoot = validatedWindowsSystemRoot();
  const whoami = path.win32.join(systemRoot, "System32", "whoami.exe");
  const icacls = path.win32.join(systemRoot, "System32", "icacls.exe");
  const powershell = path.win32.join(
    systemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const userSid = parseWindowsWhoamiUserSid(runWindowsCommand(
    whoami,
    ["/user", "/fo", "csv", "/nh"],
  ));
  const aclSids = expectedWindowsAclSids(userSid);
  runWindowsCommand(icacls, [
    directoryPath,
    "/inheritance:r",
    "/grant:r",
    ...aclSids.map((sid) => `*${sid}:(OI)(CI)F`),
  ]);
  runWindowsCommand(icacls, [directoryPath, "/verify"]);
  const snapshot = runWindowsCommand(
    powershell,
    powershellAclSnapshotArguments(directoryPath),
  );
  assertExactWindowsDirectoryAcl(snapshot, userSid);
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
