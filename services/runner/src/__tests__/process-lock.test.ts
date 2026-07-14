import {
  chmodSync,
  closeSync,
  mkdtempSync,
  openSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { verifyInheritedProcessLock } from "../process-lock.js";

const roots: string[] = [];

function root(): string {
  const value = mkdtempSync(path.join(os.tmpdir(), "runner-process-lock-"));
  roots.push(value);
  return value;
}

afterEach(() => {
  for (const value of roots.splice(0)) {
    rmSync(value, { recursive: true, force: true });
  }
});

describe("inherited runner process lock", () => {
  it("requires the launcher marker and inherited descriptor", () => {
    expect(() => verifyInheritedProcessLock(root(), {})).toThrow(
      /marker is missing/,
    );
    expect(() =>
      verifyInheritedProcessLock(root(), {
        RUNNER_PROCESS_LOCK_HELD: "1",
        RUNNER_PROCESS_LOCK_FD: "9999",
      }),
    ).toThrow(/descriptor could not be inspected/);
  });

  it("accepts an inherited descriptor matching the private lock file", () => {
    const stateRoot = root();
    const file = path.join(stateRoot, ".runner-process.lock");
    writeFileSync(file, "", { mode: 0o600 });
    if (process.platform !== "win32") {
      chmodSync(file, 0o600);
    }
    const descriptor = openSync(file, "a");
    try {
      expect(() =>
        verifyInheritedProcessLock(stateRoot, {
          RUNNER_PROCESS_LOCK_HELD: "1",
          RUNNER_PROCESS_LOCK_FD: String(descriptor),
        }),
      ).not.toThrow();
    } finally {
      closeSync(descriptor);
    }
  });

  it("rejects a descriptor for a different file", () => {
    const stateRoot = root();
    const lock = path.join(stateRoot, ".runner-process.lock");
    const other = path.join(stateRoot, "not-the-lock");
    writeFileSync(lock, "", { mode: 0o600 });
    writeFileSync(other, "", { mode: 0o600 });
    if (process.platform !== "win32") {
      chmodSync(lock, 0o600);
      chmodSync(other, 0o600);
    }
    const descriptor = openSync(other, "a");
    try {
      expect(() =>
        verifyInheritedProcessLock(stateRoot, {
          RUNNER_PROCESS_LOCK_HELD: "1",
          RUNNER_PROCESS_LOCK_FD: String(descriptor),
        }),
      ).toThrow(/does not match/);
    } finally {
      closeSync(descriptor);
    }
  });
});
