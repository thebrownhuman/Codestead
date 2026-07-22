import { describe, expect, it, vi } from "vitest";

import type { ProductionLoadDisposableFixtureTopology } from
  "./lib/production-load-disposable-runtime";
import type { ProductionLoadFixtureRuntimeDispatcher } from
  "./lib/production-load-fixture-server";
import type { ProductionLoadFixtureOperations } from
  "./lib/production-load-fixture-runtime";
import {
  startProductionLoadDisposableFixtureRuntime,
  type ProductionLoadDisposableFixtureRuntimeDependencies,
} from "./start-production-load-fixture-runtime";

function dependencies() {
  const topology = { close: vi.fn(async () => undefined) } as unknown as
    ProductionLoadDisposableFixtureTopology;
  const operations = { close: vi.fn(async () => undefined) } as unknown as
    ProductionLoadFixtureOperations;
  const dispatcher = { close: vi.fn(async () => undefined) } as unknown as
    ProductionLoadFixtureRuntimeDispatcher;
  const server = { socketPath: "/run/learncoding-production-load-fixtures/runtime.sock",
    close: vi.fn(async () => undefined) };
  const values = {
    startTopology: vi.fn(async () => topology),
    createOperations: vi.fn(() => operations),
    createDispatcher: vi.fn(() => dispatcher),
    startUnixServer: vi.fn(async () => server),
  } satisfies ProductionLoadDisposableFixtureRuntimeDependencies;
  return { values, topology, operations, dispatcher, server };
}

describe("production load disposable fixture runtime entrypoint", () => {
  it("wires the real topology through a two-request dispatcher and private Unix server", async () => {
    const runtime = dependencies();
    const started = await startProductionLoadDisposableFixtureRuntime(runtime.values);

    expect(runtime.values.createOperations).toHaveBeenCalledWith({
      topology: runtime.topology,
    });
    expect(runtime.values.createDispatcher).toHaveBeenCalledWith({
      operations: runtime.operations,
      maximumConcurrentRequests: 2,
      requestTimeoutMs: 125_000,
    });
    expect(runtime.values.startUnixServer).toHaveBeenCalledWith({
      dispatcher: runtime.dispatcher,
      requestTimeoutMs: 125_000,
    });
    await started.close();
    await started.close();
    expect(runtime.server.close).toHaveBeenCalledTimes(1);
  });

  it("closes every created layer when Unix publication fails", async () => {
    const runtime = dependencies();
    runtime.values.startUnixServer.mockRejectedValueOnce(new Error("listen_failed"));
    await expect(startProductionLoadDisposableFixtureRuntime(runtime.values)).rejects.toThrow(
      "fixture_runtime_start_failed",
    );
    expect(runtime.dispatcher.close).toHaveBeenCalledTimes(1);
    expect(runtime.operations.close).toHaveBeenCalledTimes(1);
    expect(runtime.topology.close).toHaveBeenCalledTimes(1);
  });
});
