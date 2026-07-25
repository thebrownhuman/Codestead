import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { inspect } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

const { spawnSyncMock } = vi.hoisted(() => ({
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

import { createDisposablePostgresPasswordFile } from
  "../lib/disposable-postgres-password-file";

const TOKEN_SID =
  "S-1-5-21-2586468174-2690564950-1710281196-1001";
const SYSTEM_SID = "S-1-5-18";
const ADMINISTRATORS_SID = "S-1-5-32-544";
const FULL_CONTROL = 2_032_127;
const READ_WRITE_DELETE = 1_245_599;
const PASSWORD_CANARY = "password-file-secret-canary";
const testRoots = new Set<string>();

type AclRule = Readonly<{
  sid: string;
  accessControlType: number;
  fileSystemRights: number;
  inheritanceFlags: number;
  propagationFlags: number;
  isInherited: boolean;
}>;

function rule(
  sid: string,
  fileSystemRights: number,
  inheritanceFlags: number,
): AclRule {
  return {
    sid,
    accessControlType: 0,
    fileSystemRights,
    inheritanceFlags,
    propagationFlags: 0,
    isInherited: false,
  };
}

function directoryRules(): readonly AclRule[] {
  return [
    rule(TOKEN_SID, FULL_CONTROL, 3),
    rule(SYSTEM_SID, FULL_CONTROL, 3),
    rule(ADMINISTRATORS_SID, FULL_CONTROL, 3),
  ];
}

function fileRules(): readonly AclRule[] {
  return [
    rule(TOKEN_SID, READ_WRITE_DELETE, 0),
    rule(SYSTEM_SID, FULL_CONTROL, 0),
    rule(ADMINISTRATORS_SID, FULL_CONTROL, 0),
  ];
}

function aclSnapshot(rules: readonly AclRule[]): string {
  return JSON.stringify({ accessRulesProtected: true, rules });
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

function setWindowsCommandResponses(input: Readonly<{
  whoamiOutput?: string;
  whoamiStatus?: number;
  icaclsStatus?: number;
  aclOutputs?: readonly string[];
  powershellStatus?: number;
}> = {}): void {
  let powershellIndex = 0;
  const aclOutputs = input.aclOutputs ?? [
    aclSnapshot(directoryRules()),
    aclSnapshot(fileRules()),
  ];
  spawnSyncMock.mockImplementation((command: unknown) => {
    const executable = path.win32.basename(String(command)).toLowerCase();
    if (executable === "whoami.exe") {
      return commandResult(
        input.whoamiOutput
          ?? `"ACME, ""Ops""\\A,lice","${TOKEN_SID}"\r\n`,
        input.whoamiStatus ?? 0,
      );
    }
    if (executable === "icacls.exe") {
      return commandResult("", input.icaclsStatus ?? 0);
    }
    if (executable === "powershell.exe") {
      const output = aclOutputs[powershellIndex] ?? "";
      powershellIndex += 1;
      return commandResult(output, input.powershellStatus ?? 0);
    }
    return commandResult("", 1);
  });
}

function makeTestRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "codestead-password-acl-unit-"));
  testRoots.add(root);
  return root;
}

function makeAlternateWindowsRoot(): string {
  const root = makeTestRoot();
  const executableCanaries = [
    path.join(root, "System32", "whoami.exe"),
    path.join(root, "System32", "icacls.exe"),
    path.join(
      root,
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    ),
  ];
  for (const executable of executableCanaries) {
    mkdirSync(path.dirname(executable), { recursive: true });
    writeFileSync(executable, "malicious-executable-canary", { flag: "wx" });
  }
  return root;
}

function renderedFailure(error: unknown): string {
  return [
    String(error),
    inspect(error),
    JSON.stringify(error),
    JSON.stringify(Object.entries(error as object)),
  ].join("\n");
}

function captureCreationFailure(
  input: Parameters<typeof setWindowsCommandResponses>[0],
): Readonly<{ failure: unknown; root: string }> {
  setWindowsCommandResponses(input);
  const root = makeTestRoot();
  let cleanup: (() => void) | undefined;
  let failure: unknown;
  try {
    const handle = createDisposablePostgresPasswordFile({
      password: PASSWORD_CANARY,
      temporaryRoot: root,
      platform: "win32",
    });
    cleanup = handle.cleanup;
  } catch (error) {
    failure = error;
  } finally {
    try {
      cleanup?.();
    } catch {
      // Unexpected success is asserted below; afterEach removes fixture state.
    }
  }
  return { failure, root };
}

afterEach(() => {
  spawnSyncMock.mockReset();
  vi.unstubAllEnvs();
  for (const root of testRoots) {
    rmSync(root, { force: true, recursive: true });
  }
  testRoots.clear();
});

describe("disposable PostgreSQL password-file Windows ACL", () => {
  it("rejects alternate SystemRoot executable canaries before spawn", () => {
    const alternateRoot = makeAlternateWindowsRoot();
    vi.stubEnv("SystemRoot", alternateRoot);
    const { failure, root } = captureCreationFailure({});

    expect(failure).toBeDefined();
    expect(spawnSyncMock).not.toHaveBeenCalled();
    expect(readdirSync(root)).toEqual([]);
    if (failure === undefined) return;
    const rendered = renderedFailure(failure);
    expect(rendered).toContain("password_file_windows_acl_failed");
    expect(rendered).not.toContain(PASSWORD_CANARY);
    expect(rendered).not.toContain(alternateRoot);
    expect(rendered).not.toContain("malicious-executable-canary");
  });

  it("grants exact token and administrative SIDs for directory and file", () => {
    vi.stubEnv("USERNAME", "ambient-username-canary");
    vi.stubEnv("USERDOMAIN", "ambient-domain-canary");
    vi.stubEnv("DATABASE_URL", "ambient-database-secret-canary");
    setWindowsCommandResponses();
    const root = makeTestRoot();
    const handle = createDisposablePostgresPasswordFile({
      password: PASSWORD_CANARY,
      temporaryRoot: root,
      platform: "win32",
    });

    try {
      type RecordedCommand = readonly [unknown, unknown, unknown];
      const calls = spawnSyncMock.mock.calls as unknown as RecordedCommand[];
      const callsFor = (executable: string) => calls.filter(
        (call) => path.win32.basename(String(call[0])).toLowerCase()
          === executable,
      );
      const whoamiCalls = callsFor("whoami.exe");
      const icaclsCalls = callsFor("icacls.exe");
      const powershellCalls = callsFor("powershell.exe");
      const grantCalls = icaclsCalls.filter((call) =>
        Array.isArray(call[1]) && call[1].includes("/grant:r")
      );
      const verifyCalls = icaclsCalls.filter((call) =>
        Array.isArray(call[1]) && call[1].includes("/verify")
      );

      expect(whoamiCalls).toHaveLength(2);
      expect(grantCalls).toHaveLength(2);
      expect(verifyCalls).toHaveLength(2);
      expect(powershellCalls).toHaveLength(2);
      if (
        whoamiCalls.length !== 2
        || grantCalls.length !== 2
        || verifyCalls.length !== 2
        || powershellCalls.length !== 2
      ) return;

      for (const call of whoamiCalls) {
        expect(call[1]).toEqual(["/user", "/fo", "csv", "/nh"]);
      }
      const directoryPath = path.dirname(handle.hostPath);
      expect(grantCalls.map((call) => call[1])).toEqual([
        [
          directoryPath,
          "/inheritance:r",
          "/grant:r",
          `*${TOKEN_SID}:(OI)(CI)F`,
          `*${SYSTEM_SID}:(OI)(CI)F`,
          `*${ADMINISTRATORS_SID}:(OI)(CI)F`,
        ],
        [
          handle.hostPath,
          "/inheritance:r",
          "/grant:r",
          `*${TOKEN_SID}:(R,W,D)`,
          `*${SYSTEM_SID}:F`,
          `*${ADMINISTRATORS_SID}:F`,
        ],
      ]);
      expect(verifyCalls.map((call) => call[1])).toEqual([
        [directoryPath, "/verify"],
        [handle.hostPath, "/verify"],
      ]);

      for (const call of powershellCalls) {
        const args = call[1] as readonly string[];
        expect(args.slice(0, 4)).toEqual([
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-EncodedCommand",
        ]);
        expect(args).toHaveLength(5);
        expect(args[4]).toMatch(/^[A-Za-z0-9+/=]+$/);
        expect(args.join(" ")).not.toContain(directoryPath);
      }

      for (const call of calls) {
        const options = call[2] as Readonly<{
          env?: NodeJS.ProcessEnv;
          timeout?: number;
          windowsHide?: boolean;
        }>;
        expect(options.timeout).toBe(5_000);
        expect(options.windowsHide).toBe(true);
        expect(options.env).not.toHaveProperty("USERNAME");
        expect(options.env).not.toHaveProperty("USERDOMAIN");
        expect(options.env).not.toHaveProperty("DATABASE_URL");
      }
      const renderedCalls = JSON.stringify(calls);
      expect(renderedCalls).not.toContain(PASSWORD_CANARY);
      expect(renderedCalls).not.toContain("ambient-username-canary");
      expect(renderedCalls).not.toContain("ambient-domain-canary");
      expect(renderedCalls).not.toContain("ambient-database-secret-canary");
      expect(JSON.stringify(grantCalls)).not.toContain("A,lice");
    } finally {
      try {
        handle.cleanup();
      } catch {
        // Preserve the primary command-contract assertion during the RED run.
      }
    }
    expect(existsSync(handle.hostPath)).toBe(false);
    expect(readdirSync(root)).toEqual([]);
  });

  it.each([
    {
      label: "an extra directory principal",
      outputs: [aclSnapshot([
        ...directoryRules(),
        rule("S-1-1-0", FULL_CONTROL, 3),
      ])],
    },
    {
      label: "an extra file principal",
      outputs: [aclSnapshot(directoryRules()), aclSnapshot([
        ...fileRules(),
        rule("S-1-1-0", READ_WRITE_DELETE, 0),
      ])],
    },
    {
      label: "overbroad token file rights",
      outputs: [aclSnapshot(directoryRules()), aclSnapshot([
        rule(TOKEN_SID, FULL_CONTROL, 0),
        rule(SYSTEM_SID, FULL_CONTROL, 0),
        rule(ADMINISTRATORS_SID, FULL_CONTROL, 0),
      ])],
    },
    {
      label: "a missing file administrator principal",
      outputs: [aclSnapshot(directoryRules()), aclSnapshot([
        rule(TOKEN_SID, READ_WRITE_DELETE, 0),
        rule(SYSTEM_SID, FULL_CONTROL, 0),
      ])],
    },
    {
      label: "an inherited file ACE",
      outputs: [aclSnapshot(directoryRules()), aclSnapshot([
        { ...fileRules()[0]!, isInherited: true },
        fileRules()[1]!,
        fileRules()[2]!,
      ])],
    },
    {
      label: "malformed file verifier output",
      outputs: [aclSnapshot(directoryRules()), "secret-acl-output-canary"],
    },
  ])("fails closed and cleans up for $label", ({ outputs }) => {
    const { failure, root } = captureCreationFailure({
      aclOutputs: outputs,
    });
    expect(failure).toBeDefined();
    if (failure === undefined) return;
    expect(readdirSync(root)).toEqual([]);
    const rendered = renderedFailure(failure);
    expect(rendered).toContain("password_file_windows_acl_failed");
    expect(rendered).not.toContain(PASSWORD_CANARY);
    expect(rendered).not.toContain("secret-acl-output-canary");
    expect(rendered).not.toContain(TOKEN_SID);
  });

  it("fails closed and cleans up when token SID lookup fails", () => {
    const { failure, root } = captureCreationFailure({
      whoamiOutput: "secret-identity-command-canary",
      whoamiStatus: 1,
    });
    expect(failure).toBeDefined();
    if (failure === undefined) return;
    expect(readdirSync(root)).toEqual([]);
    const rendered = renderedFailure(failure);
    expect(rendered).toContain("password_file_windows_acl_failed");
    expect(rendered).not.toContain(PASSWORD_CANARY);
    expect(rendered).not.toContain("secret-identity-command-canary");
  });
});
