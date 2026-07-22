import { describe, expect, it, vi } from "vitest";

import {
  createProductionLoadLinuxIsolationBackend,
  productionLoadLinuxCommandExecutor,
  type ProductionLoadLinuxCommand,
  type ProductionLoadLinuxCommandResult,
  type ProductionLoadLinuxPathIdentity,
} from "./production-load-linux-backend";

const VM_ID = "57b9ab11-f3a4-4ea8-a58e-e73d951f9d11";
const CONTROL = "/opt/learncoding/infra/ops/production-load-control.py";
const BROWSER = "/opt/learncoding/infra/ops/production-load-browser-journey.py";

function trustedIdentity(target: string): ProductionLoadLinuxPathIdentity {
  const file = ["/usr/bin/docker", "/usr/bin/virsh", CONTROL, BROWSER].includes(target);
  return { kind: file ? "file" : "directory", uid: 0, mode: 0o755, linkCount: 1 };
}

function createBackend(executor: (command: ProductionLoadLinuxCommand) => Promise<ProductionLoadLinuxCommandResult>) {
  return createProductionLoadLinuxIsolationBackend({
    expectedRunnerVmId: VM_ID,
    controlExecutable: CONTROL,
    browserJourneyExecutable: BROWSER,
    executor,
    inspectPath: async (target) => trustedIdentity(target),
    platform: "linux",
  });
}

describe("production load Linux command cancellation", () => {
  it("passes the request signal into the command executor and redacts abort reasons", async () => {
    let observedSignal: AbortSignal | undefined;
    const executor = vi.fn(async (command: ProductionLoadLinuxCommand) => {
      observedSignal = command.signal;
      if (!command.signal) {
        return {
          exitCode: 1,
          stdout: Buffer.alloc(0),
          stderr: Buffer.alloc(0),
          timedOut: false,
        };
      }
      await new Promise<void>((resolve) => command.signal?.addEventListener("abort", () => resolve(), {
        once: true,
      }));
      return {
        exitCode: 1,
        stdout: Buffer.alloc(0),
        stderr: Buffer.from("credential=must-not-leak"),
        timedOut: false,
        aborted: true,
      };
    });
    const backend = createBackend(executor);
    const controller = new AbortController();

    const pending = backend.captureHost(controller.signal);
    await vi.waitFor(() => expect(executor).toHaveBeenCalledOnce());
    controller.abort(new Error("postgresql://user:secret@db/private"));

    await expect(pending).rejects.toThrow(
      /^Production load Linux backend failed: command_aborted$/,
    );
    expect(observedSignal).toBe(controller.signal);
  });

  it("rejects a pre-aborted request before inspecting paths or starting a command", async () => {
    const executor = vi.fn();
    const inspectPath = vi.fn(async (target: string) => trustedIdentity(target));
    const backend = createProductionLoadLinuxIsolationBackend({
      expectedRunnerVmId: VM_ID,
      controlExecutable: CONTROL,
      browserJourneyExecutable: BROWSER,
      executor,
      inspectPath,
      platform: "linux",
    });
    const controller = new AbortController();
    controller.abort(new Error("secret reason"));

    await expect(backend.captureHost(controller.signal)).rejects.toThrow(
      /^Production load Linux backend failed: command_aborted$/,
    );
    expect(inspectPath).not.toHaveBeenCalled();
    expect(executor).not.toHaveBeenCalled();
  });

  it("uses execFile AbortSignal cancellation with SIGKILL and distinguishes it from timeout", async () => {
    const controller = new AbortController();
    const pending = productionLoadLinuxCommandExecutor({
      executable: process.execPath,
      cwd: process.cwd(),
      args: ["-e", "setInterval(() => {}, 1000)"],
      timeoutMs: 10_000,
      maximumOutputBytes: 1024,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 50).unref();

    const result = await pending;
    expect(result).toMatchObject({
      exitCode: 1,
      timedOut: false,
      aborted: true,
    });
    expect(ArrayBuffer.isView(result.stdout)).toBe(true);
    expect(ArrayBuffer.isView(result.stderr)).toBe(true);
    expect(Object.prototype.toString.call(result.stdout)).toBe("[object Uint8Array]");
    expect(Object.prototype.toString.call(result.stderr)).toBe("[object Uint8Array]");
    expect(result.stdout.byteLength + result.stderr.byteLength).toBe(0);
  });
});
