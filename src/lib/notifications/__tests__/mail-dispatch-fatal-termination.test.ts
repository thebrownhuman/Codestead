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
  const exit = new Promise<Readonly<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  return {
    child,
    exit,
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

async function exitWithin(
  run: ReturnType<typeof startFixture>,
  timeoutMs: number,
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      run.exit,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("Fatal termination fixture did not exit.")),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

describe("mail dispatch fatal termination", () => {
  it("exits synchronously with the fixed failure status", async () => {
    const run = startFixture("exit");
    const result = await exitWithin(run, 2_000);

    expect(result).toEqual({ code: 1, signal: null });
    expect(run.stdout()).toBe("ENTER\n");
    expect(run.stderr()).toBe("");
  });

  it.each([
    "park",
    "exit-returns",
    "exit-throws",
    "shared-array-buffer-throws",
    "atomics-wait-throws",
  ])(
    "never resumes cleanup for %s",
    async (mode) => {
      const run = startFixture(mode);
      await waitForEntry(run);
      let exited = false;
      void run.exit.then(() => {
        exited = true;
      });

      const observationMs =
        mode === "shared-array-buffer-throws"
        || mode === "atomics-wait-throws"
          ? 20
          : 150;
      await new Promise((resolve) => setTimeout(resolve, observationMs));
      expect(exited).toBe(false);
      expect(run.stdout()).toBe("ENTER\n");
      expect(run.stderr()).toBe("");

      run.child.kill("SIGKILL");
      await exitWithin(run, 2_000);
      expect(run.stdout()).not.toContain("RESUMED");
    },
  );
});
