import path from "node:path";
import { setTimeout as waitForTimer } from "node:timers/promises";
import { readFile } from "node:fs/promises";

import { resolveProductionLoadConfig } from "./production-load-config";
import { createProductionLoadControlClient } from "./production-load-control";
import {
  assertProductionLoadDecisionUnchanged,
  readApprovedProductionLoadDecision,
  writeProductionLoadReportExclusive,
  writeProductionLoadTerminalReceiptExclusive,
} from "./production-load-evidence";
import { runProductionFaultMatrix } from "./production-load-faults";
import { createProductionLoadHttpAdapter } from "./production-load-http";
import { runProductionLoadGate } from "./production-load-orchestrator";
import { buildProductionLoadGateReport } from "./production-load-reporting";
import { createProductionLoadSocketTransport } from "./production-load-socket";
import { runProductionLoadWorkload } from "./production-load-workload";

import type { ProductionLoadExecutionConfig } from "./production-load-config";
import type {
  ProductionLoadControlClient,
  ProductionLoadControlTransport,
  ProductionLoadSession,
} from "./production-load-control";
import type { ProductionLoadHttpAdapterOptions } from "./production-load-http";
import type {
  ProductionLoadGateExecution,
  ProductionLoadOrchestratorDependencies,
  RunProductionLoadGateInput,
} from "./production-load-orchestrator";
import type { ProductionLoadSocketOptions } from "./production-load-socket";
import type {
  ProductionLoadClock,
  ProductionLoadWorkloadAdapter,
} from "./production-load-workload";

const maximumTimerDelayMs = 60_000;
const productionLoadSignals = ["SIGINT", "SIGTERM"] as const;
const productionLoadEnvironmentKeys = new Set([
  "LOAD_MODE",
  "LOAD_ALLOW_REMOTE",
  "LOAD_BASE_URL",
  "LOAD_SCOPE",
  "LOAD_PROJECT",
  "LOAD_DISPOSABLE_FAULTS_CONFIRMED",
  "LOAD_EVIDENCE_ROOT",
  "LOAD_ACTIVE_RELEASE_PATH",
  "LOAD_CONTROL_SOCKET",
  "LOAD_REPORT_PATH",
  "LOAD_NUC_HOST_ID",
  "LOAD_RUNNER_VM_ID",
]);

export type ProductionLoadCliTransport = ProductionLoadControlTransport & {
  close?(): Promise<void> | void;
};

export type ProductionLoadCliSignalSource = {
  on(signal: (typeof productionLoadSignals)[number], listener: () => void): void;
  off(signal: (typeof productionLoadSignals)[number], listener: () => void): void;
};

type GateDependencies = ProductionLoadOrchestratorDependencies<ProductionLoadSession>;

export type ProductionLoadCliDependencies = GateDependencies & {
  resolveConfig(
    environment: NodeJS.ProcessEnv,
    repositoryRoot: string,
  ): ProductionLoadExecutionConfig;
  createSocketTransport(options: ProductionLoadSocketOptions): ProductionLoadCliTransport;
  createControlClient(transport: ProductionLoadControlTransport): ProductionLoadControlClient;
  createHttpAdapter(
    options: ProductionLoadHttpAdapterOptions,
  ): ProductionLoadWorkloadAdapter<ProductionLoadSession>;
  runGate(
    input: RunProductionLoadGateInput<ProductionLoadSession>,
  ): Promise<ProductionLoadGateExecution>;
};

export type RunProductionLoadCliInput = {
  readonly argv: readonly string[];
  readonly environment: NodeJS.ProcessEnv;
  readonly repositoryRoot: string;
  readonly signalSource: ProductionLoadCliSignalSource;
  readonly writeStdout: (message: string) => void;
  readonly writeStderr: (message: string) => void;
  readonly dependencies: ProductionLoadCliDependencies;
};

export function createProductionLoadWallClock(
  lifecycleSignal: AbortSignal,
): ProductionLoadClock {
  return {
    now: () => Date.now(),

    async waitUntil(targetEpochMs, operationSignal) {
      if (!Number.isSafeInteger(targetEpochMs) || targetEpochMs < 0) {
        throw new Error("Production load wall clock target is invalid.");
      }
      const signal = AbortSignal.any([lifecycleSignal, operationSignal]);
      try {
        while (true) {
          if (signal.aborted) throw new Error("aborted");
          const remainingMs = targetEpochMs - Date.now();
          if (remainingMs <= 0) return;
          await waitForTimer(Math.min(remainingMs, maximumTimerDelayMs), undefined, {
            signal,
          });
        }
      } catch {
        if (signal.aborted) {
          throw new Error("Production load wall clock aborted.");
        }
        throw new Error("Production load wall clock wait failed.");
      }
    },
  };
}

function withLifecycleSignal(
  lifecycleSignal: AbortSignal,
  operationSignal?: AbortSignal,
): AbortSignal {
  return operationSignal === undefined
    ? lifecycleSignal
    : AbortSignal.any([lifecycleSignal, operationSignal]);
}

function abortableTransport(
  transport: ProductionLoadControlTransport,
  lifecycleSignal: AbortSignal,
): ProductionLoadControlTransport {
  return {
    request: (operation, payload, signal) => transport.request(
      operation,
      payload,
      withLifecycleSignal(lifecycleSignal, signal),
    ),
  };
}

function abortableAdapter(
  adapter: ProductionLoadWorkloadAdapter<ProductionLoadSession>,
  lifecycleSignal: AbortSignal,
): ProductionLoadWorkloadAdapter<ProductionLoadSession> {
  return {
    seed: (plan) => adapter.seed(plan),
    authenticate: (learner) => adapter.authenticate(learner),
    execute: (action, session, signal) => adapter.execute(
      action,
      session,
      withLifecycleSignal(lifecycleSignal, signal),
    ),
    sampleResources: (signal) => adapter.sampleResources(
      withLifecycleSignal(lifecycleSignal, signal),
    ),
  };
}

export const defaultProductionLoadCliDependencies: ProductionLoadCliDependencies = Object.freeze({
  resolveConfig: resolveProductionLoadConfig,
  createSocketTransport: createProductionLoadSocketTransport,
  createControlClient: createProductionLoadControlClient,
  createHttpAdapter: createProductionLoadHttpAdapter,
  runGate: runProductionLoadGate,
  readActiveRelease: (activeReleasePath) => readFile(activeReleasePath, "utf8"),
  readDecision: readApprovedProductionLoadDecision,
  assertDecisionUnchanged: assertProductionLoadDecisionUnchanged,
  runWorkload: runProductionLoadWorkload,
  runFaultMatrix: runProductionFaultMatrix,
  buildReport: buildProductionLoadGateReport,
  writeReport: writeProductionLoadReportExclusive,
  writeTerminalReceipt: writeProductionLoadTerminalReceiptExclusive,
});

export async function runProductionLoadCli(
  input: RunProductionLoadCliInput,
): Promise<number> {
  const unsupportedEnvironment = Object.keys(input.environment).some((name) => {
    const canonicalName = name.toUpperCase();
    return canonicalName.startsWith("LOAD_")
      && !productionLoadEnvironmentKeys.has(canonicalName);
  });
  if (input.argv.length !== 0 || unsupportedEnvironment) {
    input.writeStdout(`${JSON.stringify({ verdict: "NOT_RUN" })}\n`);
    return 1;
  }

  let config: ProductionLoadExecutionConfig;
  try {
    config = input.dependencies.resolveConfig(
      input.environment,
      input.repositoryRoot,
    );
  } catch {
    input.writeStdout(`${JSON.stringify({ verdict: "NOT_RUN" })}\n`);
    return 1;
  }

  type PublicVerdict = "PASS" | "FAIL" | "NOT_RUN";
  type PublicOutcome = {
    readonly verdict: PublicVerdict;
    readonly artifactPath?: string;
    readonly artifactSha256?: string;
  };
  const artifactOutcome = (
    verdict: PublicVerdict,
    artifact: { readonly path: string; readonly sha256: string } | null,
    expectedPath: string,
  ): PublicOutcome => {
    if (artifact
      && artifact.path === expectedPath
      && !/[\0\r\n]/.test(artifact.path)
      && /^[0-9a-f]{64}$/.test(artifact.sha256)) {
      return {
        verdict,
        artifactPath: artifact.path,
        artifactSha256: `sha256:${artifact.sha256}`,
      };
    }
    if (verdict === "PASS") return { verdict: "FAIL" };
    return { verdict };
  };

  const controller = new AbortController();
  const clock = createProductionLoadWallClock(controller.signal);
  let terminalStatus: "FAIL" | "NOT_RUN" | null = null;
  let terminalArtifact: { readonly path: string; readonly sha256: string } | null = null;
  let outcome: PublicOutcome = { verdict: "NOT_RUN" };
  let closeResource: (() => Promise<void>) | null = null;

  try {
    const transport = input.dependencies.createSocketTransport({
      socketPath: config.controlSocket,
    });
    let closePromise: Promise<void> | null = null;
    const closeOnce = () => {
      closePromise ??= Promise.resolve()
        .then(() => transport.close?.())
        .then(() => undefined);
      return closePromise;
    };
    closeResource = closeOnce;
    const stop = () => {
      if (!controller.signal.aborted) controller.abort("operator_signal");
      void closeOnce().catch(() => undefined);
    };

    const control = input.dependencies.createControlClient(
      abortableTransport(transport, controller.signal),
    );
    const adapter = input.dependencies.createHttpAdapter({
      baseUrl: config.baseUrl,
      control,
    });
    const registeredSignals: (typeof productionLoadSignals)[number][] = [];
    let execution: ProductionLoadGateExecution;
    try {
      for (const signal of productionLoadSignals) {
        input.signalSource.on(signal, stop);
        registeredSignals.push(signal);
      }
      execution = await input.dependencies.runGate({
        config,
        control,
        adapter: abortableAdapter(adapter, controller.signal),
        clock,
        dependencies: {
          readActiveRelease: input.dependencies.readActiveRelease,
          readDecision: input.dependencies.readDecision,
          assertDecisionUnchanged: input.dependencies.assertDecisionUnchanged,
          runWorkload: input.dependencies.runWorkload,
          runFaultMatrix: input.dependencies.runFaultMatrix,
          buildReport: input.dependencies.buildReport,
          writeReport: input.dependencies.writeReport,
          async writeTerminalReceipt(request) {
            terminalStatus = request.receipt.status;
            const artifact = await input.dependencies.writeTerminalReceipt(request);
            terminalArtifact = artifact;
            return artifact;
          },
        },
      });
    } finally {
      for (const signal of registeredSignals) input.signalSource.off(signal, stop);
    }

    const verdict = execution.verdict === "PASS" && execution.report.verdict === "PASS"
      ? "PASS"
      : "FAIL";
    outcome = artifactOutcome(verdict, execution.artifact, config.reportPath);
    if (controller.signal.aborted) {
      outcome = { verdict: "FAIL" };
    }
  } catch {
    outcome = terminalStatus === null
      ? { verdict: "NOT_RUN" }
      : artifactOutcome(
        terminalStatus,
        terminalArtifact,
        path.join(config.evidenceRoot, "load-gate-terminal.json"),
      );
  } finally {
    if (closeResource) {
      try {
        await closeResource();
      } catch {
        outcome = { verdict: "FAIL" };
      }
    }
  }

  input.writeStdout(`${JSON.stringify(outcome)}\n`);
  return outcome.verdict === "PASS" ? 0 : 1;
}

export async function runProductionLoadCliFromProcess(
  dependencies: ProductionLoadCliDependencies = defaultProductionLoadCliDependencies,
): Promise<number> {
  const signalSource: ProductionLoadCliSignalSource = {
    on(signal, listener) {
      process.on(signal, listener);
    },
    off(signal, listener) {
      process.off(signal, listener);
    },
  };
  return runProductionLoadCli({
    argv: process.argv.slice(2),
    environment: process.env,
    repositoryRoot: process.cwd(),
    signalSource,
    writeStdout: (message) => {
      process.stdout.write(message);
    },
    writeStderr: (message) => {
      process.stderr.write(message);
    },
    dependencies,
  });
}
