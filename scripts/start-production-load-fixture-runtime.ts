import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  createProductionLoadDisposableFixtureOperations,
  type ProductionLoadDisposableFixtureTopology,
} from "./lib/production-load-disposable-runtime";
import { startProductionLoadDisposableFixtureTopology } from
  "./lib/production-load-disposable-topology";
import {
  createProductionLoadFixtureRuntimeDispatcher,
  startProductionLoadFixtureRuntimeUnixServer,
  type ProductionLoadFixtureRuntimeDispatcher,
} from "./lib/production-load-fixture-server";
import type { ProductionLoadFixtureOperations } from
  "./lib/production-load-fixture-runtime";

type FixtureUnixServer = {
  readonly socketPath: string;
  close(): Promise<void>;
};

export type ProductionLoadDisposableFixtureRuntimeDependencies = {
  readonly startTopology: () => Promise<ProductionLoadDisposableFixtureTopology>;
  readonly createOperations: (options: {
    readonly topology: ProductionLoadDisposableFixtureTopology;
  }) => ProductionLoadFixtureOperations;
  readonly createDispatcher: (options: {
    readonly operations: ProductionLoadFixtureOperations;
    readonly maximumConcurrentRequests: 2;
    readonly requestTimeoutMs: number;
  }) => ProductionLoadFixtureRuntimeDispatcher;
  readonly startUnixServer: (options: {
    readonly dispatcher: ProductionLoadFixtureRuntimeDispatcher;
    readonly requestTimeoutMs: number;
  }) => Promise<FixtureUnixServer>;
};

const defaults: ProductionLoadDisposableFixtureRuntimeDependencies = {
  startTopology: startProductionLoadDisposableFixtureTopology,
  createOperations: createProductionLoadDisposableFixtureOperations,
  createDispatcher: createProductionLoadFixtureRuntimeDispatcher,
  startUnixServer: startProductionLoadFixtureRuntimeUnixServer,
};

export async function startProductionLoadDisposableFixtureRuntime(
  dependencies: ProductionLoadDisposableFixtureRuntimeDependencies = defaults,
): Promise<{ readonly socketPath: string; close(): Promise<void> }> {
  let topology: ProductionLoadDisposableFixtureTopology | null = null;
  let operations: ProductionLoadFixtureOperations | null = null;
  let dispatcher: ProductionLoadFixtureRuntimeDispatcher | null = null;
  try {
    topology = await dependencies.startTopology();
    operations = dependencies.createOperations({ topology });
    dispatcher = dependencies.createDispatcher({
      operations,
      maximumConcurrentRequests: 2,
      requestTimeoutMs: 125_000,
    });
    const server = await dependencies.startUnixServer({
      dispatcher,
      requestTimeoutMs: 125_000,
    });
    let closePromise: Promise<void> | null = null;
    return {
      socketPath: server.socketPath,
      close() {
        closePromise ??= server.close();
        return closePromise;
      },
    };
  } catch {
    await Promise.allSettled([
      dispatcher?.close(),
      operations?.close(),
      topology?.close(),
    ]);
    throw new Error("fixture_runtime_start_failed");
  }
}

async function main(): Promise<void> {
  if (process.platform !== "linux"
    || process.getuid?.() !== 65_532
    || process.getgid?.() !== 65_532
    || process.env.NODE_ENV !== "production") {
    throw new Error("fixture_runtime_start_failed");
  }
  const runtime = await startProductionLoadDisposableFixtureRuntime();
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    void runtime.close().then(
      () => undefined,
      () => { process.exitCode = 1; },
    );
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  process.stdout.write("production load disposable fixture runtime ready\n");
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath && fileURLToPath(import.meta.url) === invokedPath) {
  void main().catch(() => {
    process.stderr.write("production load disposable fixture runtime failed\n");
    process.exitCode = 1;
  });
}
