import path from "node:path";
import { inspect } from "node:util";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  lstatSyncMock,
  realpathNativeMock,
  spawnSyncMock,
} = vi.hoisted(() => ({
  lstatSyncMock: vi.fn(),
  realpathNativeMock: vi.fn(),
  spawnSyncMock: vi.fn(),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("node:child_process")
  >();
  return {
    ...actual,
    default: { ...actual, spawnSync: spawnSyncMock },
    spawnSync: spawnSyncMock,
  };
});

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const realpathSyncMock = Object.assign(vi.fn(), {
    native: realpathNativeMock,
  });
  return {
    ...actual,
    default: {
      ...actual,
      lstatSync: lstatSyncMock,
      realpathSync: realpathSyncMock,
    },
    lstatSync: lstatSyncMock,
    realpathSync: realpathSyncMock,
  };
});

import { secureDisposableWindowsPath } from
  "../lib/disposable-windows-acl";

const WINDOWS_ROOT = "C:\\Windows";
const WHOAMI_PATH = "C:\\Windows\\System32\\whoami.exe";
const ICACLS_PATH = "C:\\Windows\\System32\\icacls.exe";
const POWERSHELL_PATH =
  "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
const TARGET_PATH = "C:\\Temp\\disposable-acl-target";
const TOKEN_SID =
  "S-1-5-21-2586468174-2690564950-1710281196-1001";
const FULL_CONTROL = 2_032_127;

function fakeStats(kind: "directory" | "file") {
  return {
    isDirectory: () => kind === "directory",
    isFile: () => kind === "file",
  };
}

function sameWindowsPath(left: string, right: string): boolean {
  return path.win32.normalize(left).toLowerCase()
    === path.win32.normalize(right).toLowerCase();
}

function defaultStats(candidate: unknown) {
  return fakeStats(sameWindowsPath(String(candidate), WINDOWS_ROOT)
    ? "directory"
    : "file");
}

function commandResult(stdout = "", status = 0) {
  return {
    pid: 1234,
    output: [null, stdout, ""],
    stdout,
    stderr: "",
    status,
    signal: null,
  };
}

function aclSnapshot(): string {
  const rule = (sid: string) => ({
    sid,
    accessControlType: 0,
    fileSystemRights: FULL_CONTROL,
    inheritanceFlags: 3,
    propagationFlags: 0,
    isInherited: false,
  });
  return JSON.stringify({
    accessRulesProtected: true,
    rules: [
      rule(TOKEN_SID),
      rule("S-1-5-18"),
      rule("S-1-5-32-544"),
    ],
  });
}

function configureSuccessfulCommands(): void {
  spawnSyncMock.mockImplementation((command: unknown) => {
    const executable = path.win32.basename(String(command)).toLowerCase();
    if (executable === "whoami.exe") {
      return commandResult(`"ACME\\alice","${TOKEN_SID}"\r\n`);
    }
    if (executable === "icacls.exe") return commandResult();
    if (executable === "powershell.exe") {
      return commandResult(aclSnapshot());
    }
    return commandResult("", 1);
  });
}

function secureTarget(): void {
  secureDisposableWindowsPath({
    targetPath: TARGET_PATH,
    kind: "directory",
    failureCode: "task_home_windows_acl_failed",
  });
}

function captureFailure(): unknown {
  try {
    secureTarget();
  } catch (error) {
    return error;
  }
  return undefined;
}

function renderedFailure(error: unknown): string {
  return [
    String(error),
    inspect(error),
    JSON.stringify(error),
    JSON.stringify(Object.entries(error as object)),
  ].join("\n");
}

beforeEach(() => {
  vi.stubEnv("SYSTEMROOT", WINDOWS_ROOT);
  realpathNativeMock.mockImplementation((candidate: unknown) =>
    String(candidate)
  );
  lstatSyncMock.mockImplementation(defaultStats);
  configureSuccessfulCommands();
});

afterEach(() => {
  spawnSyncMock.mockReset();
  realpathNativeMock.mockReset();
  lstatSyncMock.mockReset();
  vi.unstubAllEnvs();
});

describe("disposable Windows ACL executable trust root", () => {
  it("natively validates the pinned root and files before exact-path spawn", () => {
    secureTarget();

    const trustedPaths = [
      WINDOWS_ROOT,
      WHOAMI_PATH,
      ICACLS_PATH,
      POWERSHELL_PATH,
    ];
    expect(realpathNativeMock.mock.calls.map(([candidate]) => candidate))
      .toEqual(trustedPaths);
    expect(lstatSyncMock.mock.calls.map(([candidate]) => candidate))
      .toEqual(trustedPaths);

    type RecordedCommand = readonly [unknown, unknown, unknown];
    const calls = spawnSyncMock.mock.calls as unknown as RecordedCommand[];
    expect(calls.map(([command]) => command)).toEqual([
      WHOAMI_PATH,
      ICACLS_PATH,
      ICACLS_PATH,
      POWERSHELL_PATH,
    ]);
    for (const call of calls) {
      const options = call[2] as Readonly<{ env?: NodeJS.ProcessEnv }>;
      expect(options.env).toMatchObject({
        SYSTEMROOT: WINDOWS_ROOT,
        WINDIR: WINDOWS_ROOT,
      });
      expect(options.env).not.toHaveProperty("SystemRoot");
    }
  });

  it.each([
    { label: "the Windows root", subject: WINDOWS_ROOT },
    { label: "whoami", subject: WHOAMI_PATH },
    { label: "icacls", subject: ICACLS_PATH },
    { label: "PowerShell", subject: POWERSHELL_PATH },
  ])("fails closed before spawn when $label realpath is redirected", ({
    subject,
  }) => {
    realpathNativeMock.mockImplementation((candidate: unknown) =>
      sameWindowsPath(String(candidate), subject)
        ? "C:\\redirected-executable-canary"
        : String(candidate)
    );

    const failure = captureFailure();

    expect(failure).toBeDefined();
    expect(spawnSyncMock).not.toHaveBeenCalled();
    const rendered = renderedFailure(failure);
    expect(rendered).toContain("task_home_windows_acl_failed");
    expect(rendered).not.toContain("redirected-executable-canary");
  });

  it.each([
    { label: "the Windows root is not a directory", subject: WINDOWS_ROOT },
    { label: "whoami is not a file", subject: WHOAMI_PATH },
    { label: "icacls is not a file", subject: ICACLS_PATH },
    { label: "PowerShell is not a file", subject: POWERSHELL_PATH },
  ])("fails closed before spawn when $label", ({ subject }) => {
    lstatSyncMock.mockImplementation((candidate: unknown) => {
      if (!sameWindowsPath(String(candidate), subject)) {
        return defaultStats(candidate);
      }
      return fakeStats(sameWindowsPath(subject, WINDOWS_ROOT)
        ? "file"
        : "directory");
    });

    const failure = captureFailure();

    expect(failure).toBeDefined();
    expect(spawnSyncMock).not.toHaveBeenCalled();
    expect(renderedFailure(failure)).toContain(
      "task_home_windows_acl_failed",
    );
  });

  it("fails closed without reflecting a native filesystem exception", () => {
    realpathNativeMock.mockImplementation(() => {
      throw new Error("secret-realpath-exception-canary");
    });

    const failure = captureFailure();

    expect(failure).toBeDefined();
    expect(spawnSyncMock).not.toHaveBeenCalled();
    const rendered = renderedFailure(failure);
    expect(rendered).toContain("task_home_windows_acl_failed");
    expect(rendered).not.toContain("secret-realpath-exception-canary");
  });
});
