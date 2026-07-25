// @vitest-environment node

import { spawn } from "node:child_process";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { guardedDispatchResultSafeToDisarm } from "../postgres-outbox-store";

const fixture = path.resolve(
  process.cwd(),
  "src/lib/notifications/__tests__/fixtures/guarded-outbox-worker-failstop.mjs",
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
  return { child, exit, stdout: () => stdout, stderr: () => stderr };
}

async function exitWithin(run: ReturnType<typeof startFixture>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      run.exit,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("Guarded worker fail-stop fixture did not exit.")),
          3_000,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

describe("guarded outbox worker fail-stop", () => {
  it.each([
    ["discard-guard-false", "ENTER\n"],
    ["dispatch-sync-throw", "ENTER\nDISPATCH_INVOKED\n"],
    ["hostile-dispatch-result", "ENTER\nDISPATCH_RETURNED\n"],
  ] as const)("hard-exits without cleanup for %s", async (mode, output) => {
    const run = startFixture(mode);
    const result = await exitWithin(run);

    expect(result).toEqual({ code: 1, signal: null });
    expect(run.stdout()).toBe(output);
    expect(run.stderr()).toBe("");
    expect(run.stdout()).not.toContain("RESUMED");
    expect(run.stdout()).not.toContain("FORBIDDEN_");
  });

  it("does not expose raw claim or recipient identifiers", async () => {
    const run = startFixture("hostile-dispatch-result");
    await exitWithin(run);

    expect(run.stdout()).not.toContain("11111111-1111-4111-8111-111111111111");
    expect(run.stdout()).not.toContain("22222222-2222-4222-8222-222222222222");
    expect(run.stdout()).not.toContain("learner@integration.invalid");
    expect(run.stderr()).toBe("");
  });
});

describe("guarded dispatch result validator", () => {
  it("returns false for a hostile Proxy without reading or reflecting it", () => {
    let observations = 0;
    const hostile = new Proxy({}, {
      get() {
        observations += 1;
        throw new Error("property read");
      },
      getOwnPropertyDescriptor() {
        observations += 1;
        throw new Error("descriptor read");
      },
      getPrototypeOf() {
        observations += 1;
        throw new Error("prototype read");
      },
      isExtensible() {
        observations += 1;
        throw new Error("extensibility read");
      },
      ownKeys() {
        observations += 1;
        throw new Error("key reflection");
      },
    });

    expect(guardedDispatchResultSafeToDisarm(
      Object.freeze({}),
      Object.freeze({}) as never,
      hostile as never,
    )).toBe(false);
    expect(observations).toBe(0);
  });
});

