import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  parseWindowsCurrentUserSid,
  secureWindowsPathForCurrentUser,
  type WindowsAclCommandRunner,
} from "../lib/windows-current-user-acl";

const CURRENT_USER_SID =
  "S-1-5-21-2586468174-2690564950-1710281196-1001";

describe("Windows current-user ACL", () => {
  it("parses only one headerless whoami CSV record with a valid SID", () => {
    expect(parseWindowsCurrentUserSid(
      `"shivansh\\shivansh","${CURRENT_USER_SID}"\r\n`,
    )).toBe(CURRENT_USER_SID);

    for (const output of [
      "",
      "shivansh\\shivansh",
      `"shivansh\\shivansh","not-a-sid"\r\n`,
      `"shivansh\\shivansh","${CURRENT_USER_SID}","extra"\r\n`,
      `"shivansh\\shivansh","${CURRENT_USER_SID}"\r\nsecond line`,
    ]) {
      expect(() => parseWindowsCurrentUserSid(output)).toThrow(
        "windows_current_user_sid_invalid",
      );
    }
  });

  it("grants the exact SID instead of an ambiguous bare username", () => {
    const calls: Array<Readonly<{
      command: string;
      args: readonly string[];
      captureStdout: boolean;
    }>> = [];
    const runCommand: WindowsAclCommandRunner = vi.fn((input) => {
      calls.push({
        command: input.command,
        args: input.args,
        captureStdout: input.captureStdout,
      });
      return input.captureStdout
        ? {
            status: 0,
            stdout: `"shivansh\\shivansh","${CURRENT_USER_SID}"\r\n`,
          }
        : { status: 0, stdout: "" };
    });
    const targetPath = path.resolve("private-integration-home");

    secureWindowsPathForCurrentUser({
      targetPath,
      permissions: "(OI)(CI)F",
      failureCode: "task_home_windows_acl_failed",
      environment: { SYSTEMROOT: "C:\\Windows" },
      runCommand,
    });

    expect(calls).toEqual([
      {
        command: path.join(
          "C:\\Windows",
          "System32",
          "whoami.exe",
        ),
        args: ["/user", "/fo", "csv", "/nh"],
        captureStdout: true,
      },
      {
        command: path.join(
          "C:\\Windows",
          "System32",
          "icacls.exe",
        ),
        args: [
          targetPath,
          "/inheritance:r",
          "/grant:r",
          `*${CURRENT_USER_SID}:(OI)(CI)F`,
        ],
        captureStdout: false,
      },
      {
        command: path.join(
          "C:\\Windows",
          "System32",
          "icacls.exe",
        ),
        args: [targetPath, "/verify"],
        captureStdout: false,
      },
    ]);
    expect(JSON.stringify(calls)).not.toContain("Shivansh:(OI)(CI)F");
  });

  it("fails closed without exposing the target when identity or ACL commands fail", () => {
    const targetPath = path.resolve("secret-path-canary");
    for (const runCommand of [
      vi.fn(() => ({ status: 1, stdout: "" })),
      vi.fn((input: Parameters<WindowsAclCommandRunner>[0]) =>
        input.captureStdout
          ? { status: 0, stdout: "\"account\",\"invalid\"\r\n" }
          : { status: 0, stdout: "" }
      ),
      vi.fn((input: Parameters<WindowsAclCommandRunner>[0]) =>
        input.captureStdout
          ? {
              status: 0,
              stdout: `"account","${CURRENT_USER_SID}"\r\n`,
            }
          : { status: 1, stdout: "" }
      ),
    ] satisfies WindowsAclCommandRunner[]) {
      let failure: unknown;
      try {
        secureWindowsPathForCurrentUser({
          targetPath,
          permissions: "(R,W,D)",
          failureCode: "password_file_windows_acl_failed",
          environment: { SYSTEMROOT: "C:\\Windows" },
          runCommand,
        });
      } catch (error) {
        failure = error;
      }
      expect(String(failure)).toContain(
        "password_file_windows_acl_failed",
      );
      expect(String(failure)).not.toContain(targetPath);
      expect(failure).not.toHaveProperty("cause");
    }
  });
});
