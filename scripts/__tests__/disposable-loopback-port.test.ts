import { inspect } from "node:util";

import { describe, expect, it, vi } from "vitest";

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

async function loadLoopbackPortModule(): Promise<LoopbackPortModule | null> {
  const modulePath = "../lib/disposable-loopback-port";
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
