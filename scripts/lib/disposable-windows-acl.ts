import { spawnSync } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";

import { minimalNodeTestEnvironment } from
  "./disposable-integration-environment";
import { disposableIntegrationFailure } from
  "./disposable-integration-error";

const WINDOWS_ACL_TIMEOUT_MS = 5_000;
const WINDOWS_SID_MAX_IDENTIFIER_AUTHORITY = 281_474_976_710_655n;
const WINDOWS_SID_MAX_SUB_AUTHORITY = 4_294_967_295n;
const WINDOWS_SID_MAX_SUB_AUTHORITIES = 15;
const WINDOWS_SYSTEM_SID = "S-1-5-18";
const WINDOWS_ADMINISTRATORS_SID = "S-1-5-32-544";
const WINDOWS_FULL_CONTROL = 2_032_127;
const WINDOWS_READ_WRITE_DELETE = 1_245_599;
const WINDOWS_DIRECTORY_INHERITANCE_FLAGS = 3;
const WINDOWS_COMMAND_MAX_BUFFER = 64 * 1_024;
const WINDOWS_ACL_SNAPSHOT_MAX_LENGTH = 64 * 1_024;
const WHOAMI_OUTPUT_MAX_LENGTH = 4_096;
// Local Windows harness support is intentionally C:\Windows-only. Production
// deploys on Linux; never derive these executable trust anchors from ambient
// Windows environment variables.
const PINNED_WINDOWS_ROOT = "C:\\Windows";
const PINNED_WINDOWS_WHOAMI =
  "C:\\Windows\\System32\\whoami.exe";
const PINNED_WINDOWS_ICACLS =
  "C:\\Windows\\System32\\icacls.exe";
const PINNED_WINDOWS_POWERSHELL =
  "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";

const PINNED_WINDOWS_PATHS = Object.freeze([
  {
    path: PINNED_WINDOWS_ROOT,
    kind: "directory",
  },
  {
    path: PINNED_WINDOWS_WHOAMI,
    kind: "file",
  },
  {
    path: PINNED_WINDOWS_ICACLS,
    kind: "file",
  },
  {
    path: PINNED_WINDOWS_POWERSHELL,
    kind: "file",
  },
] as const);

type WindowsAclFailureCode =
  | "task_home_windows_acl_failed"
  | "password_file_windows_acl_failed";

export type DisposableWindowsAclKind = "directory" | "file";

type WindowsAclPrincipal = Readonly<{
  sid: string;
  permission: string;
  fileSystemRights: number;
  inheritanceFlags: number;
}>;

function failWindowsAcl(code: WindowsAclFailureCode): never {
  throw disposableIntegrationFailure(code);
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

export function parseWindowsWhoamiUserSid(
  output: string,
  failureCode: WindowsAclFailureCode = "task_home_windows_acl_failed",
): string {
  if (output.length === 0 || output.length > WHOAMI_OUTPUT_MAX_LENGTH) {
    failWindowsAcl(failureCode);
  }
  const record = output.endsWith("\r\n")
    ? output.slice(0, -2)
    : output.endsWith("\n") ? output.slice(0, -1) : output;
  const match = /^"(?:""|[^"\r\n])*","([^"\r\n]+)"$/.exec(record);
  const sid = match?.[1];
  if (sid === undefined || !isCanonicalWindowsSid(sid)) {
    failWindowsAcl(failureCode);
  }
  return sid;
}

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

function windowsAclPrincipals(
  userSid: string,
  kind: DisposableWindowsAclKind,
): readonly WindowsAclPrincipal[] {
  const principals = new Map<string, WindowsAclPrincipal>();
  const add = (
    sid: string,
    permission: string,
    fileSystemRights: number,
    inheritanceFlags: number,
  ): void => {
    principals.set(sid, {
      sid,
      permission,
      fileSystemRights,
      inheritanceFlags,
    });
  };
  if (kind === "directory") {
    for (const sid of [
      userSid,
      WINDOWS_SYSTEM_SID,
      WINDOWS_ADMINISTRATORS_SID,
    ]) {
      add(
        sid,
        "(OI)(CI)F",
        WINDOWS_FULL_CONTROL,
        WINDOWS_DIRECTORY_INHERITANCE_FLAGS,
      );
    }
  } else {
    add(userSid, "(R,W,D)", WINDOWS_READ_WRITE_DELETE, 0);
    add(WINDOWS_SYSTEM_SID, "F", WINDOWS_FULL_CONTROL, 0);
    add(WINDOWS_ADMINISTRATORS_SID, "F", WINDOWS_FULL_CONTROL, 0);
  }
  return [...principals.values()];
}

function isSamePinnedWindowsPath(
  value: string,
  expected: string,
): boolean {
  if (
    value.length === 0
    || value.includes("\0")
    || !path.win32.isAbsolute(value)
  ) {
    return false;
  }
  return path.win32.resolve(value).toLowerCase()
    === path.win32.resolve(expected).toLowerCase();
}

function assertPinnedWindowsExecutableTrust(
  code: WindowsAclFailureCode,
): void {
  try {
    const ambientSystemRoots = Object.entries(process.env).flatMap(
      ([name, value]) =>
        name.toUpperCase() === "SYSTEMROOT" && value !== undefined
          ? [value]
          : [],
    );
    if (ambientSystemRoots.some(
      (value) => !isSamePinnedWindowsPath(value, PINNED_WINDOWS_ROOT),
    )) {
      failWindowsAcl(code);
    }

    for (const trustedPath of PINNED_WINDOWS_PATHS) {
      const resolved = realpathSync.native(trustedPath.path);
      const stats = lstatSync(trustedPath.path);
      const expectedKind = trustedPath.kind === "directory"
        ? stats.isDirectory()
        : stats.isFile();
      if (
        !isSamePinnedWindowsPath(resolved, trustedPath.path)
        || !expectedKind
      ) {
        failWindowsAcl(code);
      }
    }
  } catch {
    failWindowsAcl(code);
  }
}

function pinnedWindowsCommandEnvironment(
  code: WindowsAclFailureCode,
): NodeJS.ProcessEnv {
  try {
    return {
      ...minimalNodeTestEnvironment(process.env),
      SYSTEMROOT: PINNED_WINDOWS_ROOT,
      WINDIR: PINNED_WINDOWS_ROOT,
    };
  } catch {
    failWindowsAcl(code);
  }
}

function runWindowsCommand(
  command: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
  code: WindowsAclFailureCode,
): string {
  const result = (() => {
    try {
      return spawnSync(command, [...args], {
        encoding: "utf8",
        env: environment,
        maxBuffer: WINDOWS_COMMAND_MAX_BUFFER,
        shell: false,
        stdio: ["ignore", "pipe", "ignore"],
        timeout: WINDOWS_ACL_TIMEOUT_MS,
        windowsHide: true,
      });
    } catch {
      failWindowsAcl(code);
    }
  })();
  if (result.status !== 0 || typeof result.stdout !== "string") {
    failWindowsAcl(code);
  }
  return result.stdout;
}

function powershellAclSnapshotArguments(
  targetPath: string,
): readonly string[] {
  const encodedPath = Buffer.from(targetPath, "utf8").toString("base64");
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

function assertExactWindowsAcl(
  output: string,
  principals: readonly WindowsAclPrincipal[],
  code: WindowsAclFailureCode,
): void {
  if (
    output.length === 0
    || output.length > WINDOWS_ACL_SNAPSHOT_MAX_LENGTH
  ) {
    failWindowsAcl(code);
  }
  let value: unknown;
  try {
    value = JSON.parse(output.trim());
  } catch {
    failWindowsAcl(code);
  }
  if (
    !isRecord(value)
    || !hasExactlyKeys(value, ["accessRulesProtected", "rules"])
    || value.accessRulesProtected !== true
    || !Array.isArray(value.rules)
    || value.rules.length !== principals.length
  ) {
    failWindowsAcl(code);
  }

  const expected = new Map(principals.map((principal) => [
    principal.sid,
    principal,
  ]));
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
      failWindowsAcl(code);
    }
    const sid = candidate.sid;
    const principal = typeof sid === "string" ? expected.get(sid) : undefined;
    if (
      principal === undefined
      || !isCanonicalWindowsSid(sid as string)
      || seenSids.has(sid as string)
      || candidate.accessControlType !== 0
      || candidate.fileSystemRights !== principal.fileSystemRights
      || candidate.inheritanceFlags !== principal.inheritanceFlags
      || candidate.propagationFlags !== 0
      || candidate.isInherited !== false
    ) {
      failWindowsAcl(code);
    }
    seenSids.add(sid as string);
  }
  if (seenSids.size !== expected.size) failWindowsAcl(code);
}

export function secureDisposableWindowsPath(input: Readonly<{
  targetPath: string;
  kind: DisposableWindowsAclKind;
  failureCode: WindowsAclFailureCode;
}>): void {
  assertPinnedWindowsExecutableTrust(input.failureCode);
  const environment = pinnedWindowsCommandEnvironment(input.failureCode);
  const userSid = parseWindowsWhoamiUserSid(runWindowsCommand(
    PINNED_WINDOWS_WHOAMI,
    ["/user", "/fo", "csv", "/nh"],
    environment,
    input.failureCode,
  ), input.failureCode);
  const principals = windowsAclPrincipals(userSid, input.kind);
  runWindowsCommand(PINNED_WINDOWS_ICACLS, [
    input.targetPath,
    "/inheritance:r",
    "/grant:r",
    ...principals.map(
      (principal) => `*${principal.sid}:${principal.permission}`,
    ),
  ], environment, input.failureCode);
  runWindowsCommand(
    PINNED_WINDOWS_ICACLS,
    [input.targetPath, "/verify"],
    environment,
    input.failureCode,
  );
  const snapshot = runWindowsCommand(
    PINNED_WINDOWS_POWERSHELL,
    powershellAclSnapshotArguments(input.targetPath),
    environment,
    input.failureCode,
  );
  assertExactWindowsAcl(snapshot, principals, input.failureCode);
}
