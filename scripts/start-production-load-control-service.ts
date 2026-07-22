import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  createProductionLoadControlServiceDependencies,
  installProductionLoadControlSignalHandlers,
  recoverProductionLoadControlService,
  startProductionLoadControlService,
  type ProductionLoadControlServiceDependencies,
  type ProductionLoadSignalEmitter,
  type StartProductionLoadControlServiceOptions,
} from "./lib/production-load-control-service";
import { readProductionLoadSystemdCredential } from "./lib/production-load-systemd-credentials";

export type ProductionLoadControlEntrypointOptions = {
  readonly environment?: NodeJS.ProcessEnv;
  readonly argv?: readonly string[];
  readonly signals?: ProductionLoadSignalEmitter;
  readonly dependencies?: ProductionLoadControlServiceDependencies;
  readonly startService?: typeof startProductionLoadControlService;
  readonly recoverService?: typeof recoverProductionLoadControlService;
};

function fail(code: string): never {
  throw new Error(`Production load control entrypoint failed: ${code}`);
}

export async function runProductionLoadControlServiceEntrypoint(
  options: ProductionLoadControlEntrypointOptions = {},
): Promise<void> {
  const environment = options.environment ?? process.env;
  const argv = options.argv ?? process.argv.slice(2);
  if (argv.length > 1
    || (argv.length === 1 && argv[0] !== "--recover-only")) {
    fail("invalid_arguments");
  }
  const dependencies = options.dependencies
    ?? createProductionLoadControlServiceDependencies((name) =>
      readProductionLoadSystemdCredential({ environment, name }));
  const serviceOptions: StartProductionLoadControlServiceOptions = {
    environment,
    repositoryRoot: "/opt/learncoding",
    dependencies,
  };
  if (argv[0] === "--recover-only") {
    await (options.recoverService ?? recoverProductionLoadControlService)(serviceOptions);
    return;
  }
  const service = await (options.startService ?? startProductionLoadControlService)(serviceOptions);
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
  void runProductionLoadControlServiceEntrypoint().catch(() => {
    process.stderr.write("Production load control service failed.\n");
    process.exitCode = 1;
  });
}
