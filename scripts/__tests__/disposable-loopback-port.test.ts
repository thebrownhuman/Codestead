import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { inspect } from "node:util";

import { describe, expect, it, vi } from "vitest";

import { DisposableIntegrationLifecycleError } from
  "../lib/disposable-integration-error";

type LoopbackListener = Readonly<{
  close: () => Promise<void>;
  port: number;
}>;

type OpenLoopbackListener = (
  input: Readonly<{ host: string; port: number }>,
) => Promise<LoopbackListener>;

type LoopbackPortModule = Readonly<{
  allocateDisposableLoopbackPort?: (
    input?: Readonly<{ openListener?: OpenLoopbackListener }>,
  ) => Promise<number>;
}>;

const nativeModulePath = "../lib/disposable-loopback-port.mjs";
const typedModulePath = "../lib/disposable-loopback-port.ts";

async function loadLoopbackPortModule(
  modulePath = typedModulePath,
): Promise<LoopbackPortModule | null> {
  try {
    return await import(/* @vite-ignore */ modulePath) as LoopbackPortModule;
  } catch {
    return null;
  }
}

function renderedFailure(error: unknown): string {
  return [
    String(error),
    inspect(error),
    JSON.stringify(error),
    JSON.stringify(Object.entries(error as object)),
  ].join("\n");
}

describe("disposable loopback port allocator", () => {
  it("imports and uses the canonical module in an actual Node process", () => {
    const probePath = path.resolve(
      process.cwd(),
      "scripts/__tests__/disposable-loopback-port-native-probe.mjs",
    );
    const result = spawnSync(process.execPath, [probePath], {
      encoding: "utf8",
      windowsHide: true,
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
    const probe = JSON.parse(result.stdout) as {
      deterministicPort: number;
      events: string[];
      kernelAssignedPort: number;
      modulePath: string;
    };
    expect(probe.deterministicPort).toBe(54_321);
    expect(probe.events).toEqual([
      "open:127.0.0.1:0:5432",
      "close:5432",
      "open:127.0.0.1:0:54321",
      "close:54321",
    ]);
    expect(probe.kernelAssignedPort).not.toBe(5432);
    expect(probe.modulePath).toMatch(/disposable-loopback-port\.mjs$/u);
  });

  it("keeps native ESM and typed TypeScript surfaces behaviorally aligned", async () => {
    const nativeModule = await loadLoopbackPortModule(nativeModulePath);
    const typedModule = await loadLoopbackPortModule(typedModulePath);
    expect(typeof nativeModule?.allocateDisposableLoopbackPort).toBe(
      "function",
    );
    expect(typeof typedModule?.allocateDisposableLoopbackPort).toBe(
      "function",
    );
    if (
      !nativeModule?.allocateDisposableLoopbackPort
      || !typedModule?.allocateDisposableLoopbackPort
    ) return;

    const exercise = async (allocatorModule: LoopbackPortModule) => {
      const events: string[] = [];
      const assignedPorts = [5432, 54_321];
      const port = await allocatorModule.allocateDisposableLoopbackPort?.({
        openListener: async (input) => {
          const assignedPort = assignedPorts.shift();
          if (assignedPort === undefined) throw new Error("unexpected allocation");
          events.push(`open:${input.host}:${input.port}:${assignedPort}`);
          return {
            port: assignedPort,
            close: async () => {
              events.push(`close:${assignedPort}`);
            },
          };
        },
      });
      return { events, port };
    };

    await expect(exercise(nativeModule)).resolves.toEqual(
      await exercise(typedModule),
    );
  });

  it("preserves shared lifecycle failure identity across both surfaces", async () => {
    const nativeModule = await loadLoopbackPortModule(nativeModulePath);
    const typedModule = await loadLoopbackPortModule(typedModulePath);
    expect(typeof nativeModule?.allocateDisposableLoopbackPort).toBe(
      "function",
    );
    expect(typeof typedModule?.allocateDisposableLoopbackPort).toBe(
      "function",
    );
    if (
      !nativeModule?.allocateDisposableLoopbackPort
      || !typedModule?.allocateDisposableLoopbackPort
    ) return;

    const exerciseFailure = async (allocatorModule: LoopbackPortModule) => {
      try {
        await allocatorModule.allocateDisposableLoopbackPort?.({
          openListener: async () => ({
            port: 54_321,
            close: async () => {
              throw new Error("raw-close-canary");
            },
          }),
        });
      } catch (error) {
        return error;
      }
      return undefined;
    };
    const failures = await Promise.all([
      exerciseFailure(nativeModule),
      exerciseFailure(typedModule),
    ]);
    for (const failure of failures) {
      expect(failure).toBeInstanceOf(DisposableIntegrationLifecycleError);
    }
  });

  it("keeps the typed surface as an explicit thin native-module re-export", async () => {
    const source = await readFile(
      "scripts/lib/disposable-loopback-port.ts",
      "utf8",
    );
    expect(source).toContain('"./disposable-loopback-port.mjs"');
    expect(source).not.toContain("node:net");
    expect(source).not.toContain("MAXIMUM_ALLOCATION_ATTEMPTS");
  });

  it("closes rejected 5432 before retrying a kernel-assigned loopback port", async () => {
    const allocatorModule = await loadLoopbackPortModule();
    expect(typeof allocatorModule?.allocateDisposableLoopbackPort)
      .toBe("function");
    if (!allocatorModule?.allocateDisposableLoopbackPort) return;

    const assignedPorts = [5432, 54_321];
    const events: string[] = [];
    const openListener = vi.fn<OpenLoopbackListener>(async (input) => {
      const port = assignedPorts.shift();
      if (port === undefined) throw new Error("unexpected allocation");
      events.push(`open:${input.host}:${input.port}:${port}`);
      return {
        port,
        close: async () => {
          events.push(`close:${port}`);
        },
      };
    });

    await expect(allocatorModule.allocateDisposableLoopbackPort({
      openListener,
    })).resolves.toBe(54_321);
    expect(events).toEqual([
      "open:127.0.0.1:0:5432",
      "close:5432",
      "open:127.0.0.1:0:54321",
      "close:54321",
    ]);
    expect(openListener).toHaveBeenCalledTimes(2);
  });

  it("fails with a fixed error after bounded 5432 allocations and closes all listeners", async () => {
    const allocatorModule = await loadLoopbackPortModule();
    expect(typeof allocatorModule?.allocateDisposableLoopbackPort)
      .toBe("function");
    if (!allocatorModule?.allocateDisposableLoopbackPort) return;

    const close = vi.fn(async () => undefined);
    const openListener = vi.fn<OpenLoopbackListener>(async (input) => {
      expect(input).toEqual({ host: "127.0.0.1", port: 0 });
      return { port: 5432, close };
    });
    let failure: unknown;
    try {
      await allocatorModule.allocateDisposableLoopbackPort({ openListener });
    } catch (error) {
      failure = error;
    }

    expect(openListener).toHaveBeenCalledTimes(8);
    expect(close).toHaveBeenCalledTimes(8);
    expect(renderedFailure(failure)).toContain(
      "disposable_loopback_port_allocation_failed",
    );
    expect(failure).not.toHaveProperty("cause");
    expect(failure).not.toHaveProperty("errors");
  });

  it("fails closed without exposing a raw listener-close error", async () => {
    const allocatorModule = await loadLoopbackPortModule();
    expect(typeof allocatorModule?.allocateDisposableLoopbackPort)
      .toBe("function");
    if (!allocatorModule?.allocateDisposableLoopbackPort) return;

    let failure: unknown;
    try {
      await allocatorModule.allocateDisposableLoopbackPort({
        openListener: async () => ({
          port: 54_321,
          close: async () => {
            throw new Error("raw-loopback-close-canary");
          },
        }),
      });
    } catch (error) {
      failure = error;
    }

    const rendered = renderedFailure(failure);
    expect(rendered).toContain("disposable_loopback_port_allocation_failed");
    expect(rendered).not.toContain("raw-loopback-close-canary");
  });
});
