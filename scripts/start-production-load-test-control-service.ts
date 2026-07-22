import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  installProductionLoadControlSignalHandlers,
  type ProductionLoadSignalEmitter,
} from "./lib/production-load-control-service";
import {
  createProductionLoadFixtureRuntimeAdapter,
  type ProductionLoadFixtureOperations,
} from "./lib/production-load-fixture-runtime";
import {
  createProductionLoadFixtureUnixOperations,
} from "./lib/production-load-fixture-operations";
import {
  createProductionLoadTestControlServiceDependencies,
  startProductionLoadTestControlService,
  type ProductionLoadTestControlServiceDependencies,
  type StartProductionLoadTestControlServiceOptions,
  type ProductionLoadTestControlAdapterContext,
} from "./lib/production-load-test-control-service";
import type { ProductionLoadTestControlAdapter } from "./lib/production-load-test-control-server";

export type ProductionLoadTestControlEntrypointOptions = {
  readonly environment?: NodeJS.ProcessEnv;
  readonly argv?: readonly string[];
  readonly signals?: ProductionLoadSignalEmitter;
  readonly dependencies?: ProductionLoadTestControlServiceDependencies;
  readonly startService?: typeof startProductionLoadTestControlService;
};

function fail(code: string): never {
  throw new Error(`Production load test-control entrypoint failed: ${code}`);
}

export type ProductionLoadTestControlRuntimeAdapterDependencies = {
  createOperations(): ProductionLoadFixtureOperations;
  createAdapter: typeof createProductionLoadFixtureRuntimeAdapter;
};

export async function createProductionLoadTestControlRuntimeAdapter(options: {
  readonly environment: NodeJS.ProcessEnv;
  readonly context: ProductionLoadTestControlAdapterContext;
  readonly dependencies?: ProductionLoadTestControlRuntimeAdapterDependencies;
}): Promise<ProductionLoadTestControlAdapter> {
  const dependencies = options.dependencies ?? {
    createOperations: createProductionLoadFixtureUnixOperations,
    createAdapter: createProductionLoadFixtureRuntimeAdapter,
  };
  const operations = dependencies.createOperations();
  return dependencies.createAdapter({
    environment: {
      ...options.environment,
      LOAD_FIXTURE_RUN_IDENTITY_SHA256:
        options.context.candidateRunIdentitySha256,
    },
    context: options.context,
    operations,
  });
}

export async function runProductionLoadTestControlServiceEntrypoint(
  options: ProductionLoadTestControlEntrypointOptions = {},
): Promise<void> {
  const environment = options.environment ?? process.env;
  const argv = options.argv ?? process.argv.slice(2);
  if (argv.length !== 0) fail("invalid_arguments");
  const dependencies = options.dependencies
    ?? createProductionLoadTestControlServiceDependencies(
      (context) => createProductionLoadTestControlRuntimeAdapter({
        environment,
        context,
      }),
    );
  const serviceOptions: StartProductionLoadTestControlServiceOptions = {
    environment,
    repositoryRoot: "/opt/learncoding",
    dependencies,
  };
  const service = await (options.startService ?? startProductionLoadTestControlService)(
    serviceOptions,
  );
  const installed = installProductionLoadControlSignalHandlers({
    service,
    signals: options.signals ?? process,
  });
  try {
    await installed.done;
  } finally {
    installed.remove();
  }
}

const currentModulePath = fileURLToPath(import.meta.url);
const launchedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (launchedPath === currentModulePath) {
  void runProductionLoadTestControlServiceEntrypoint().catch(() => {
    process.stderr.write("Production load test-control service failed.\n");
    process.exitCode = 1;
  });
}
