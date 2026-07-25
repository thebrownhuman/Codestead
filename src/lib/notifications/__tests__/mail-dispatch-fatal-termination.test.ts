// @vitest-environment node

import { spawn } from "node:child_process";
import path from "node:path";

import { describe, expect, it } from "vitest";

const fixture = path.resolve(
  process.cwd(),
  "src/lib/notifications/__tests__/fixtures/mail-dispatch-fatal-termination.mjs",
);

function startFixture(mode: string) {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", fixture, mode],
    {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const close = new Promise<Readonly<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  return {
    child,
    close,
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

async function waitForEntry(run: ReturnType<typeof startFixture>) {
  const startedAt = performance.now();
  while (!run.stdout().includes("ENTER\n")) {
    if (performance.now() - startedAt > 2_000) {
      throw new Error("Fatal termination fixture did not start.");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function closeWithin(
  run: ReturnType<typeof startFixture>,
  timeoutMs: number,
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      run.close,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          run.child.kill("SIGKILL");
          reject(new Error("Fatal termination fixture did not close."));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

describe("mail dispatch fatal termination", () => {
  it("uses the import-captured native main-thread exit with an exact status and no cleanup bytes", async () => {
    const run = startFixture("native-hostile");
    const result = await closeWithin(run, 2_000);

    expect(result).toEqual({ code: 1, signal: null });
    expect(run.stdout()).toBe("ENTER\n");
    expect(run.stderr()).toBe("");
  });

  it.each([
    "really-exit-returns",
    "really-exit-throws",
    "really-exit-unavailable",
  ])(
    "falls through a %s primitive to the import-captured raw numeric SIGKILL",
    async (mode) => {
      const run = startFixture(mode);
      const result = await closeWithin(run, 2_000);

      expect(run.stdout()).toBe("ENTER\n");
      expect(run.stderr()).toBe("");
      if (process.platform === "win32") {
        expect(result).toEqual({ code: 1, signal: null });
      } else {
        expect(result).toEqual({ code: null, signal: "SIGKILL" });
      }
    },
  );

  it("skips reallyExit in a worker and raw-kills the whole process", async () => {
    const run = startFixture("worker");
    const result = await closeWithin(run, 2_000);

    expect(run.stdout()).toBe("ENTER\n");
    expect(run.stderr()).toBe("");
    if (process.platform === "win32") {
      expect(result).toEqual({ code: 1, signal: null });
    } else {
      expect(result).toEqual({ code: null, signal: "SIGKILL" });
    }
  });

  it.each([
    "park",
    "kill-returns",
    "kill-throws",
    "kill-unavailable",
    "atomics-mutated",
    "atomics-returns",
    "atomics-throws",
    "atomics-unavailable",
    "shared-array-buffer-throws",
  ])(
    "uses the preallocated non-returning park when native termination cannot complete for %s",
    async (mode) => {
      const run = startFixture(mode);
      await waitForEntry(run);
      let closed = false;
      void run.close.then(() => {
        closed = true;
      });

      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(closed).toBe(false);
      expect(run.stdout()).toBe("ENTER\n");
      expect(run.stderr()).toBe("");

      run.child.kill("SIGKILL");
      await closeWithin(run, 2_000);
      expect(run.stdout()).not.toContain("RESUMED");
    },
  );
});
