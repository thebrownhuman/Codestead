import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  runProductionLoadDisposableLifecycle,
  type ProductionLoadDisposableLifecycleReceipt,
} from "./lib/production-load-disposable-lifecycle";
import type { ProductionLoadDisposableFixtureTopology } from
  "./lib/production-load-disposable-runtime";
import { startProductionLoadDisposableFixtureTopology } from
  "./lib/production-load-disposable-topology";

export type ProductionLoadFixtureLifecycleProofDependencies = {
  readonly startTopology: () => Promise<ProductionLoadDisposableFixtureTopology>;
  readonly runLifecycle: (options: {
    readonly topology: ProductionLoadDisposableFixtureTopology;
  }) => Promise<ProductionLoadDisposableLifecycleReceipt>;
};

const defaults: ProductionLoadFixtureLifecycleProofDependencies = {
  startTopology: startProductionLoadDisposableFixtureTopology,
  runLifecycle: runProductionLoadDisposableLifecycle,
};

export async function runProductionLoadFixtureLifecycleProof(
  dependencies: ProductionLoadFixtureLifecycleProofDependencies = defaults,
): Promise<ProductionLoadDisposableLifecycleReceipt> {
  let topology: ProductionLoadDisposableFixtureTopology | null = null;
  try {
    topology = await dependencies.startTopology();
    const receipt = await dependencies.runLifecycle({ topology });
    await topology.close();
    topology = null;
    return receipt;
  } catch {
    await topology?.close().catch(() => undefined);
    throw new Error("production_load_fixture_lifecycle_failed");
  }
}

async function main(): Promise<void> {
  if (process.argv.length !== 2
    || process.platform !== "linux"
    || process.getuid?.() !== 65_532
    || process.getgid?.() !== 65_532
    || process.env.NODE_ENV !== "production") {
    throw new Error("production_load_fixture_lifecycle_failed");
  }
  const receipt = await runProductionLoadFixtureLifecycleProof();
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath && fileURLToPath(import.meta.url) === invokedPath) {
  void main().catch(() => {
    process.stderr.write("production load fixture lifecycle failed\n");
    process.exitCode = 1;
  });
}
