import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
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

import {
  createDisposableIntegrationTaskHome,
  parseWindowsWhoamiUserSid,
  type DisposableTaskHomeOperations,
} from "../lib/disposable-integration-task-home";

const WINDOWS_TOKEN_SID =
  "S-1-5-21-2586468174-2690564950-1710281196-1001";
const WINDOWS_SYSTEM_SID = "S-1-5-18";
const WINDOWS_ADMINISTRATORS_SID = "S-1-5-32-544";
const WINDOWS_FULL_CONTROL = 2_032_127;
const testRoots = new Set<string>();

type WindowsAclRuleSnapshot = Readonly<{
  sid: string;
  accessControlType: number;
  fileSystemRights: number;
  inheritanceFlags: number;
  propagationFlags: number;
  isInherited: boolean;
}>;

function fullControlRule(sid: string): WindowsAclRuleSnapshot {
  return {
    sid,
    accessControlType: 0,
    fileSystemRights: WINDOWS_FULL_CONTROL,
    inheritanceFlags: 3,
    propagationFlags: 0,
    isInherited: false,
  };
}

function aclSnapshot(input: Readonly<{
  protectedAcl?: boolean;
  rules?: readonly WindowsAclRuleSnapshot[];
}> = {}): string {
  return JSON.stringify({
    accessRulesProtected: input.protectedAcl ?? true,
    rules: input.rules ?? [
      fullControlRule(WINDOWS_TOKEN_SID),
      fullControlRule(WINDOWS_SYSTEM_SID),
      fullControlRule(WINDOWS_ADMINISTRATORS_SID),
    ],
  });
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
  aclOutput?: string;
  icaclsStatus?: number;
  powershellStatus?: number;
}> = {}): void {
  spawnSyncMock.mockImplementation((command: unknown) => {
    const executable = path.win32.basename(String(command)).toLowerCase();
    if (executable === "whoami.exe") {
      return commandResult(
        input.whoamiOutput
          ?? `"ACME, ""Ops""\\A,lice","${WINDOWS_TOKEN_SID}"\r\n`,
        input.whoamiStatus ?? 0,
      );
    }
    if (executable === "icacls.exe") {
      return commandResult("", input.icaclsStatus ?? 0);
    }
    if (executable === "powershell.exe") {
      return commandResult(
        input.aclOutput ?? aclSnapshot(),
        input.powershellStatus ?? 0,
      );
    }
    return commandResult("", 1);
  });
}

function makeTestRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "codestead-task-home-unit-"));
  testRoots.add(root);
  return root;
}

function captureWindowsHomeCreationFailure(
  input: Parameters<typeof setWindowsCommandResponses>[0],
): Readonly<{ failure: unknown; root: string }> {
  setWindowsCommandResponses(input);
  const root = makeTestRoot();
  let cleanup: (() => void) | undefined;
  let failure: unknown;
  try {
    const home = createDisposableIntegrationTaskHome({
      temporaryRoot: root,
      platform: "win32",
    });
    cleanup = home.cleanup;
  } catch (error) {
    failure = error;
  } finally {
    cleanup?.();
  }
  return { failure, root };
}

function fakeOperations(input: Readonly<{
  mode?: number;
  removalLeavesDirectory?: boolean;
}> = {}) {
  const root = path.resolve("task-home-root");
  const directory = path.join(
    root,
    "codestead-integration-home-unit123",
  );
  const existing = new Set<string>();
  const secureWindowsDirectory = vi.fn();
  const operations: DisposableTaskHomeOperations = {
    makeTemporaryDirectory: () => {
      existing.add(directory);
      return directory;
    },
    makeDirectory: (directoryPath) => {
      existing.add(directoryPath);
    },
    setDirectoryMode: vi.fn(),
    readDirectoryMode: () => input.mode ?? 0o700,
    isDirectory: (candidate) => existing.has(candidate),
    pathExists: (candidate) => existing.has(candidate),
    removeDirectory: (candidate) => {
      if (!input.removalLeavesDirectory) existing.delete(candidate);
    },
    secureWindowsDirectory,
  };
  return { directory, existing, operations, root, secureWindowsDirectory };
}

function renderedFailure(error: unknown): string {
  return [
    String(error),
    inspect(error),
    JSON.stringify(error),
    JSON.stringify(Object.entries(error as object)),
  ].join("\n");
}

afterEach(() => {
  spawnSyncMock.mockReset();
  vi.unstubAllEnvs();
  for (const root of testRoots) {
    rmSync(root, { force: true, recursive: true });
  }
  testRoots.clear();
});

describe("disposable integration task home", () => {
  const tokenSid = "S-1-5-21-2586468174-2690564950-1710281196-1001";

  it.each([
    {
      label: "a domain-qualified account",
      output: `"ACME\\alice","${tokenSid}"\r\n`,
    },
    {
      label: "commas and escaped quotes in the account field",
      output: `"ACME, ""Ops""\\A,lice","${tokenSid}"\n`,
    },
  ])("extracts the token SID without resolving $label", ({ output }) => {
    expect(parseWindowsWhoamiUserSid(output)).toBe(tokenSid);
  });

  it.each([
    {
      label: "unquoted account data",
      output: `ACME\\alice,"${tokenSid}"\r\n`,
    },
    {
      label: "an extra CSV field",
      output: `"ACME\\alice","${tokenSid}","extra"\r\n`,
    },
    {
      label: "multiple CSV records",
      output: `"ACME\\alice","${tokenSid}"\r\n"ACME\\bob","${tokenSid}"`,
    },
    {
      label: "ACL syntax appended to the SID",
      output: `"secret-domain-canary\\alice","${tokenSid}:(OI)(CI)F"`,
    },
    {
      label: "a non-canonical SID component",
      output: '"ACME\\alice","S-1-5-21-0001"',
    },
    {
      label: "an oversized SID sub-authority",
      output: '"ACME\\alice","S-1-5-4294967296"',
    },
    {
      label: "an oversized SID identifier authority",
      output: '"ACME\\alice","S-1-281474976710656-1"',
    },
    {
      label: "too many SID sub-authorities",
      output: `"ACME\\alice","S-1-5-${Array(16).fill("1").join("-")}"`,
    },
  ])("rejects $label without reflecting identity data", ({ output }) => {
    let failure: unknown;
    try {
      parseWindowsWhoamiUserSid(output);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeDefined();
    if (failure === undefined) return;
    const rendered = renderedFailure(failure);
    expect(rendered).toContain("task_home_windows_acl_failed");
    expect(rendered).not.toContain("secret-domain-canary");
    expect(rendered).not.toContain(tokenSid);
  });

  it("grants only exact current-token and administrative SIDs", () => {
    vi.stubEnv("USERNAME", "ambient-username-canary");
    vi.stubEnv("USERDOMAIN", "ambient-domain-canary");
    vi.stubEnv("DATABASE_URL", "ambient-database-secret-canary");
    setWindowsCommandResponses();
    const root = makeTestRoot();
    const home = createDisposableIntegrationTaskHome({
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
      const targets = [home.path, path.join(home.path, "tmp")];
      expect(grantCalls.map((call) => call[1])).toEqual(targets.map(
        (target) => [
          target,
          "/inheritance:r",
          "/grant:r",
          `*${WINDOWS_TOKEN_SID}:(OI)(CI)F`,
          `*${WINDOWS_SYSTEM_SID}:(OI)(CI)F`,
          `*${WINDOWS_ADMINISTRATORS_SID}:(OI)(CI)F`,
        ],
      ));
      expect(verifyCalls.map((call) => call[1])).toEqual(
        targets.map((target) => [target, "/verify"]),
      );

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
        expect(args.join(" ")).not.toContain(home.path);
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
      expect(renderedCalls).not.toContain("ambient-username-canary");
      expect(renderedCalls).not.toContain("ambient-domain-canary");
      expect(renderedCalls).not.toContain("ambient-database-secret-canary");
      expect(JSON.stringify(grantCalls)).not.toContain("A,lice");
    } finally {
      home.cleanup();
    }
    expect(existsSync(home.path)).toBe(false);
  });

  it.each([
    {
      label: "an unprotected DACL",
      output: aclSnapshot({ protectedAcl: false }),
    },
    {
      label: "an extra broad principal",
      output: aclSnapshot({
        rules: [
          fullControlRule(WINDOWS_TOKEN_SID),
          fullControlRule(WINDOWS_SYSTEM_SID),
          fullControlRule(WINDOWS_ADMINISTRATORS_SID),
          fullControlRule("S-1-1-0"),
        ],
      }),
    },
    {
      label: "a missing Administrators principal",
      output: aclSnapshot({
        rules: [
          fullControlRule(WINDOWS_TOKEN_SID),
          fullControlRule(WINDOWS_SYSTEM_SID),
        ],
      }),
    },
    {
      label: "a deny ACE",
      output: aclSnapshot({
        rules: [
          { ...fullControlRule(WINDOWS_TOKEN_SID), accessControlType: 1 },
          fullControlRule(WINDOWS_SYSTEM_SID),
          fullControlRule(WINDOWS_ADMINISTRATORS_SID),
        ],
      }),
    },
    {
      label: "non-full-control rights",
      output: aclSnapshot({
        rules: [
          { ...fullControlRule(WINDOWS_TOKEN_SID), fileSystemRights: 1 },
          fullControlRule(WINDOWS_SYSTEM_SID),
          fullControlRule(WINDOWS_ADMINISTRATORS_SID),
        ],
      }),
    },
    {
      label: "an inherited ACE",
      output: aclSnapshot({
        rules: [
          { ...fullControlRule(WINDOWS_TOKEN_SID), isInherited: true },
          fullControlRule(WINDOWS_SYSTEM_SID),
          fullControlRule(WINDOWS_ADMINISTRATORS_SID),
        ],
      }),
    },
    {
      label: "malformed verifier output",
      output: "secret-acl-verifier-canary",
    },
  ])("fails closed and cleans up for $label", ({ output }) => {
    const { failure, root } = captureWindowsHomeCreationFailure({
      aclOutput: output,
    });
    expect(failure).toBeDefined();
    if (failure === undefined) return;
    expect(readdirSync(root)).toEqual([]);
    const rendered = renderedFailure(failure);
    expect(rendered).toContain("task_home_create_failed");
    expect(rendered).not.toContain("secret-acl-verifier-canary");
    expect(rendered).not.toContain(WINDOWS_TOKEN_SID);
  });

  it("fails closed and cleans up when token SID lookup fails", () => {
    const { failure, root } = captureWindowsHomeCreationFailure({
      whoamiOutput: "secret-identity-command-canary",
      whoamiStatus: 1,
    });
    expect(failure).toBeDefined();
    if (failure === undefined) return;
    expect(readdirSync(root)).toEqual([]);
    const rendered = renderedFailure(failure);
    expect(rendered).toContain("task_home_create_failed");
    expect(rendered).not.toContain("secret-identity-command-canary");
  });

  it("creates a private POSIX home and verifies exact cleanup", () => {
    const fake = fakeOperations();
    const home = createDisposableIntegrationTaskHome({
      temporaryRoot: fake.root,
      platform: "linux",
      operations: fake.operations,
    });

    expect(home.path).toBe(fake.directory);
    expect(fake.operations.setDirectoryMode).toHaveBeenCalledWith(
      fake.directory,
      0o700,
    );
    home.cleanup();
    expect(fake.existing).not.toContain(fake.directory);
  });

  it("uses a private Windows ACL when POSIX mode bits are not meaningful", () => {
    const fake = fakeOperations({ mode: 0o777 });
    const home = createDisposableIntegrationTaskHome({
      temporaryRoot: fake.root,
      platform: "win32",
      operations: fake.operations,
    });
    expect(fake.secureWindowsDirectory).toHaveBeenCalledWith(fake.directory);
    home.cleanup();
  });

  it("fails closed when directory deletion cannot be verified", () => {
    const fake = fakeOperations({ removalLeavesDirectory: true });
    const home = createDisposableIntegrationTaskHome({
      temporaryRoot: fake.root,
      platform: "linux",
      operations: fake.operations,
    });
    let failure: unknown;
    try {
      home.cleanup();
    } catch (error) {
      failure = error;
    }
    const rendered = renderedFailure(failure);
    expect(rendered).toContain("task_home_still_present");
    expect(rendered).not.toContain(fake.directory);
    expect(failure).not.toHaveProperty("cause");
    expect(failure).not.toHaveProperty("errors");
  });
});
