import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { ProductionLoadExecutionConfig } from "./production-load-config";
import type {
  ProductionLoadControlClient,
  ProductionLoadControlTransport,
  ProductionLoadSession,
} from "./production-load-control";
import type { ProductionLoadGateExecution } from "./production-load-orchestrator";
import type { ProductionLoadWorkloadAdapter } from "./production-load-workload";
import {
  createProductionLoadWallClock,
  runProductionLoadCli,
  type ProductionLoadCliDependencies,
  type ProductionLoadCliSignalSource,
  type ProductionLoadCliTransport,
} from "./production-load-cli";
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
import { defaultProductionLoadCliDependencies } from "./production-load-cli";

const repositoryRoot = path.resolve("test-results", "production-load-cli");
const artifactHash = "a".repeat(64);

function productionConfig(): ProductionLoadExecutionConfig {
  const evidenceRoot = path.join(repositoryRoot, "evidence");
  return {
    mode: "production",
    allowRemote: true,
    baseUrl: new URL("https://codestead.example.test/"),
    scope: "codestead-project-only",
    project: "learncoding",
    disposableFaultsConfirmed: true,
    datasetId: "seed-20260715",
    repositoryRoot,
    evidenceRoot,
    activeReleasePath: path.join(repositoryRoot, "active-release.env"),
    controlSocket: path.join(repositoryRoot, "load-control.sock"),
    reportPath: path.join(evidenceRoot, "load-gate-report.json"),
    nucHostId: "nuc-ed25519-sha256-0123456789abcdef",
    runnerVmId: "57b9ab11-f3a4-4ea8-a58e-e73d951f9d11",
  };
}

function processEnvironment(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "test",
    LOAD_MODE: "production",
    LOAD_ALLOW_REMOTE: "1",
    LOAD_BASE_URL: "https://codestead.example.test",
    LOAD_SCOPE: "codestead-project-only",
    LOAD_PROJECT: "learncoding",
    LOAD_DISPOSABLE_FAULTS_CONFIRMED: "1",
    LOAD_EVIDENCE_ROOT: path.join(repositoryRoot, "evidence"),
    LOAD_ACTIVE_RELEASE_PATH: path.join(repositoryRoot, "active-release.env"),
    LOAD_CONTROL_SOCKET: path.join(repositoryRoot, "load-control.sock"),
    LOAD_NUC_HOST_ID: "nuc-ed25519-sha256-0123456789abcdef",
    LOAD_RUNNER_VM_ID: "57b9ab11-f3a4-4ea8-a58e-e73d951f9d11",
  };
}

function unavailable(name: string): () => Promise<never> {
  return async () => {
    throw new Error(`Unexpected ${name} call.`);
  };
}

function controlClient(): ProductionLoadControlClient {
  return {
    seed: unavailable("seed"),
    authenticate: unavailable("authenticate"),
    captureBaseline: unavailable("captureBaseline"),
    sampleResources: unavailable("sampleResources"),
    runnerObservation: unavailable("runnerObservation"),
    reset: unavailable("reset"),
    probe: unavailable("probe"),
    runAuthenticatedBrowserJourney: unavailable("browserJourney"),
    injectAndRelease: unavailable("injectAndRelease"),
    verifyInvariants: unavailable("verifyInvariants"),
  };
}

function workloadAdapter(): ProductionLoadWorkloadAdapter<ProductionLoadSession> {
  return {
    seed: unavailable("adapter.seed"),
    authenticate: unavailable("adapter.authenticate"),
    execute: unavailable("adapter.execute"),
    sampleResources: unavailable("adapter.sampleResources"),
  };
}

function gateExecution(
  config: ProductionLoadExecutionConfig,
  verdict: "PASS" | "FAIL" = "PASS",
): ProductionLoadGateExecution {
  return {
    verdict,
    candidate: {} as ProductionLoadGateExecution["candidate"],
    report: { verdict } as ProductionLoadGateExecution["report"],
    artifact: {
      path: config.reportPath,
      byteLength: 123,
      sha256: artifactHash,
    },
  };
}

class TestSignalSource implements ProductionLoadCliSignalSource {
  readonly listeners = new Map<NodeJS.Signals, Set<() => void>>();

  on(signal: "SIGINT" | "SIGTERM", listener: () => void): void {
    const listeners = this.listeners.get(signal) ?? new Set();
    listeners.add(listener);
    this.listeners.set(signal, listeners);
  }

  off(signal: "SIGINT" | "SIGTERM", listener: () => void): void {
    this.listeners.get(signal)?.delete(listener);
  }

  emit(signal: "SIGINT" | "SIGTERM"): void {
    for (const listener of this.listeners.get(signal) ?? []) listener();
  }
}

function dependencies(options: {
  readonly config?: ProductionLoadExecutionConfig;
  readonly transport?: ProductionLoadCliTransport;
  readonly control?: ProductionLoadControlClient;
  readonly adapter?: ProductionLoadWorkloadAdapter<ProductionLoadSession>;
  readonly runGate?: ProductionLoadCliDependencies["runGate"];
} = {}): ProductionLoadCliDependencies {
  const config = options.config ?? productionConfig();
  const transport = options.transport ?? {
    request: unavailable("transport.request") as ProductionLoadControlTransport["request"],
  };
  const control = options.control ?? controlClient();
  const adapter = options.adapter ?? workloadAdapter();
  return {
    resolveConfig: vi.fn(() => config),
    createSocketTransport: vi.fn(() => transport),
    createControlClient: vi.fn(() => control),
    createHttpAdapter: vi.fn(() => adapter),
    runGate: options.runGate ?? vi.fn(async () => gateExecution(config)),
    readActiveRelease: unavailable("readActiveRelease"),
    readDecision: unavailable("readDecision"),
    assertDecisionUnchanged: unavailable("assertDecisionUnchanged"),
    runWorkload: unavailable("runWorkload"),
    runFaultMatrix: unavailable("runFaultMatrix"),
    buildReport: () => {
      throw new Error("Unexpected buildReport call.");
    },
    writeReport: unavailable("writeReport"),
    writeTerminalReceipt: unavailable("writeTerminalReceipt"),
  };
}

describe("production load client CLI", () => {
  it("uses wall-clock time and aborts a pending bounded wait", async () => {
    const controller = new AbortController();
    const clock = createProductionLoadWallClock(controller.signal);
    const before = Date.now();

    expect(clock.now()).toBeGreaterThanOrEqual(before);
    expect(clock.now()).toBeLessThanOrEqual(Date.now());

    const waiting = clock.waitUntil(
      Date.now() + 24 * 60 * 60 * 1_000,
      new AbortController().signal,
    );
    controller.abort("operator_signal");

    await expect(waiting).rejects.toThrow("Production load wall clock aborted.");
  });

  it("assembles the socket, control client, HTTP adapter, and gate against the resolved config", async () => {
    const config = productionConfig();
    const transport: ProductionLoadCliTransport = {
      request: unavailable("transport.request") as ProductionLoadControlTransport["request"],
      close: vi.fn(async () => undefined),
    };
    const control = controlClient();
    const adapter = workloadAdapter();
    const runGate = vi.fn(async (...gateArguments: Parameters<ProductionLoadCliDependencies["runGate"]>) => {
      expect(gateArguments).toHaveLength(1);
      return gateExecution(config);
    });
    const injected = dependencies({ config, transport, control, adapter, runGate });
    const environment = processEnvironment();
    const signalSource = new TestSignalSource();
    const stdout: string[] = [];
    const stderr: string[] = [];

    const exitCode = await runProductionLoadCli({
      argv: [],
      environment,
      repositoryRoot,
      signalSource,
      writeStdout: (message) => stdout.push(message),
      writeStderr: (message) => stderr.push(message),
      dependencies: injected,
    });

    expect(exitCode).toBe(0);
    expect(injected.resolveConfig).toHaveBeenCalledWith(environment, repositoryRoot);
    expect(injected.createSocketTransport).toHaveBeenCalledWith({
      socketPath: config.controlSocket,
    });
    const controlTransport = vi.mocked(injected.createControlClient).mock.calls[0]?.[0];
    expect(controlTransport).toBeDefined();
    expect(controlTransport).not.toBe(transport);
    expect(injected.createHttpAdapter).toHaveBeenCalledWith({
      baseUrl: config.baseUrl,
      control,
    });

    const gateInput = runGate.mock.calls[0]?.[0];
    expect(gateInput?.config).toBe(config);
    expect(gateInput?.control).toBe(control);
    expect(gateInput?.adapter).not.toBe(adapter);
    expect(gateInput?.clock.now()).toBeLessThanOrEqual(Date.now());
    expect(gateInput?.dependencies).toMatchObject({
      readActiveRelease: injected.readActiveRelease,
      readDecision: injected.readDecision,
      assertDecisionUnchanged: injected.assertDecisionUnchanged,
      runWorkload: injected.runWorkload,
      runFaultMatrix: injected.runFaultMatrix,
      buildReport: injected.buildReport,
      writeReport: injected.writeReport,
    });
    expect(stdout).toEqual([
      `${JSON.stringify({
        verdict: "PASS",
        artifactPath: config.reportPath,
        artifactSha256: `sha256:${artifactHash}`,
      })}\n`,
    ]);
    expect(stderr).toEqual([]);
    expect(transport.close).toHaveBeenCalledOnce();
    expect(signalSource.listeners.get("SIGINT")?.size ?? 0).toBe(0);
    expect(signalSource.listeners.get("SIGTERM")?.size ?? 0).toBe(0);
  });

  it("does no work and emits only a sanitized NOT_RUN verdict when config resolution fails", async () => {
    const injected = dependencies();
    const secret = "session=must-not-be-logged";
    injected.resolveConfig = vi.fn(() => {
      throw new Error(secret);
    });
    const stdout: string[] = [];
    const stderr: string[] = [];

    const exitCode = await runProductionLoadCli({
      argv: [],
      environment: processEnvironment(),
      repositoryRoot,
      signalSource: new TestSignalSource(),
      writeStdout: (message) => stdout.push(message),
      writeStderr: (message) => stderr.push(message),
      dependencies: injected,
    });

    expect(exitCode).toBe(1);
    expect(injected.createSocketTransport).not.toHaveBeenCalled();
    expect(injected.createControlClient).not.toHaveBeenCalled();
    expect(injected.createHttpAdapter).not.toHaveBeenCalled();
    expect(injected.runGate).not.toHaveBeenCalled();
    expect(stdout).toEqual([`${JSON.stringify({ verdict: "NOT_RUN" })}\n`]);
    expect(stderr).toEqual([]);
    expect(`${stdout.join("")} ${stderr.join("")}`).not.toContain(secret);
  });

  it.each([
    {
      name: "argv",
      argv: ["--target=https://secret.example.test"],
      environment: processEnvironment(),
      secret: "secret.example.test",
    },
    {
      name: "legacy smoke knob",
      argv: [],
      environment: { ...processEnvironment(), LOAD_CONCURRENCY: "10" },
      secret: "10",
    },
    {
      name: "secret-bearing load knob",
      argv: [],
      environment: { ...processEnvironment(), LOAD_PRIVATE_TOKEN: "do-not-log-me" },
      secret: "do-not-log-me",
    },
  ])("rejects unsupported $name without resolving config or logging input", async ({
    argv,
    environment,
    secret,
  }) => {
    const injected = dependencies();
    const stdout: string[] = [];
    const stderr: string[] = [];

    const exitCode = await runProductionLoadCli({
      argv,
      environment,
      repositoryRoot,
      signalSource: new TestSignalSource(),
      writeStdout: (message) => stdout.push(message),
      writeStderr: (message) => stderr.push(message),
      dependencies: injected,
    });

    expect(exitCode).toBe(1);
    expect(injected.resolveConfig).not.toHaveBeenCalled();
    expect(injected.createSocketTransport).not.toHaveBeenCalled();
    expect(injected.runGate).not.toHaveBeenCalled();
    expect(stdout).toEqual([`${JSON.stringify({ verdict: "NOT_RUN" })}\n`]);
    expect(stderr).toEqual([]);
    expect(`${stdout.join("")} ${stderr.join("")}`).not.toContain(secret);
  });

  it("exits nonzero when the published report verdict is FAIL", async () => {
    const config = productionConfig();
    const injected = dependencies({
      config,
      runGate: vi.fn(async () => gateExecution(config, "FAIL")),
    });
    const stdout: string[] = [];
    const stderr: string[] = [];

    const exitCode = await runProductionLoadCli({
      argv: [],
      environment: processEnvironment(),
      repositoryRoot,
      signalSource: new TestSignalSource(),
      writeStdout: (message) => stdout.push(message),
      writeStderr: (message) => stderr.push(message),
      dependencies: injected,
    });

    expect(exitCode).toBe(1);
    expect(stdout).toEqual([
      `${JSON.stringify({
        verdict: "FAIL",
        artifactPath: config.reportPath,
        artifactSha256: `sha256:${artifactHash}`,
      })}\n`,
    ]);
    expect(stderr).toEqual([]);
  });

  it.each(["FAIL", "NOT_RUN"] as const)(
    "publishes only the sanitized %s terminal receipt identity when the gate stops",
    async (status) => {
      const config = productionConfig();
      const terminalPath = path.join(config.evidenceRoot, "load-gate-terminal.json");
      const terminalHash = "b".repeat(64);
      const secret = "socket failure contained session=must-not-leak";
      const writeTerminalReceipt = vi.fn(async () => ({
        path: terminalPath,
        byteLength: 321,
        sha256: terminalHash,
      }));
      const runGate: ProductionLoadCliDependencies["runGate"] = vi.fn(async (gateInput) => {
        await gateInput.dependencies.writeTerminalReceipt({
          evidenceRoot: config.evidenceRoot,
          receipt: {
            schemaVersion: 1,
            generatedAt: "2026-07-20T00:00:00.000Z",
            status,
            stage: "approval",
            failureCode: "decision_unavailable",
            candidate: null,
            decisionSha256: null,
          },
        });
        throw new Error(secret);
      });
      const injected = dependencies({ config, runGate });
      injected.writeTerminalReceipt = writeTerminalReceipt;
      const stdout: string[] = [];
      const stderr: string[] = [];

      const exitCode = await runProductionLoadCli({
        argv: [],
        environment: processEnvironment(),
        repositoryRoot,
        signalSource: new TestSignalSource(),
        writeStdout: (message) => stdout.push(message),
        writeStderr: (message) => stderr.push(message),
        dependencies: injected,
      });

      expect(exitCode).toBe(1);
      expect(stdout).toEqual([
        `${JSON.stringify({
          verdict: status,
          artifactPath: terminalPath,
          artifactSha256: `sha256:${terminalHash}`,
        })}\n`,
      ]);
      expect(stderr).toEqual([]);
      expect(`${stdout.join("")} ${stderr.join("")}`).not.toContain(secret);
    },
  );

  it("fails closed without exposing an error when the socket factory is unavailable", async () => {
    const injected = dependencies();
    const secret = "connect /private/socket token=must-not-leak";
    injected.createSocketTransport = vi.fn(() => {
      throw new Error(secret);
    });
    const stdout: string[] = [];
    const stderr: string[] = [];

    const exitCode = await runProductionLoadCli({
      argv: [],
      environment: processEnvironment(),
      repositoryRoot,
      signalSource: new TestSignalSource(),
      writeStdout: (message) => stdout.push(message),
      writeStderr: (message) => stderr.push(message),
      dependencies: injected,
    });

    expect(exitCode).toBe(1);
    expect(injected.createControlClient).not.toHaveBeenCalled();
    expect(injected.runGate).not.toHaveBeenCalled();
    expect(stdout).toEqual([`${JSON.stringify({ verdict: "NOT_RUN" })}\n`]);
    expect(stderr).toEqual([]);
    expect(`${stdout.join("")} ${stderr.join("")}`).not.toContain(secret);
  });

  it("aborts active client work, closes transport once, and removes signal listeners", async () => {
    const config = productionConfig();
    const signalSource = new TestSignalSource();
    const transport: ProductionLoadCliTransport = {
      request: unavailable("transport.request") as ProductionLoadControlTransport["request"],
      close: vi.fn(async () => undefined),
    };
    const adapter = workloadAdapter();
    let observedSignal: AbortSignal | null = null;
    adapter.sampleResources = vi.fn(async (signal: AbortSignal): Promise<never> => new Promise<never>((_resolve, reject) => {
      observedSignal = signal;
      const fail = () => reject(new Error("session=signal-error-must-not-leak"));
      if (signal.aborted) fail();
      else signal.addEventListener("abort", fail, { once: true });
    }));
    let markGateStarted: () => void = () => undefined;
    const gateStarted = new Promise<void>((resolve) => {
      markGateStarted = resolve;
    });
    const runGate: ProductionLoadCliDependencies["runGate"] = vi.fn(async (gateInput) => {
      markGateStarted();
      await gateInput.adapter.sampleResources(new AbortController().signal);
      throw new Error("unreachable");
    });
    const injected = dependencies({ config, transport, adapter, runGate });
    const stdout: string[] = [];
    const stderr: string[] = [];

    const running = runProductionLoadCli({
      argv: [],
      environment: processEnvironment(),
      repositoryRoot,
      signalSource,
      writeStdout: (message) => stdout.push(message),
      writeStderr: (message) => stderr.push(message),
      dependencies: injected,
    });
    await gateStarted;
    signalSource.emit("SIGTERM");

    await expect(running).resolves.toBe(1);
    expect((observedSignal as AbortSignal | null)?.aborted).toBe(true);
    expect(transport.close).toHaveBeenCalledOnce();
    expect(signalSource.listeners.get("SIGINT")?.size ?? 0).toBe(0);
    expect(signalSource.listeners.get("SIGTERM")?.size ?? 0).toBe(0);
    expect(stdout).toEqual([`${JSON.stringify({ verdict: "NOT_RUN" })}\n`]);
    expect(stderr).toEqual([]);
    expect(`${stdout.join("")} ${stderr.join("")}`).not.toContain("signal-error");
  });

  it("fails closed and omits an invalid artifact path or hash", async () => {
    const config = productionConfig();
    const secret = "session=artifact-must-not-leak";
    const invalidExecution: ProductionLoadGateExecution = {
      ...gateExecution(config),
      artifact: {
        path: `${config.reportPath}\r\n${secret}`,
        byteLength: 123,
        sha256: "not-a-sha256",
      },
    };
    const injected = dependencies({
      config,
      runGate: vi.fn(async () => invalidExecution),
    });
    const stdout: string[] = [];
    const stderr: string[] = [];

    const exitCode = await runProductionLoadCli({
      argv: [],
      environment: processEnvironment(),
      repositoryRoot,
      signalSource: new TestSignalSource(),
      writeStdout: (message) => stdout.push(message),
      writeStderr: (message) => stderr.push(message),
      dependencies: injected,
    });

    expect(exitCode).toBe(1);
    expect(stdout).toEqual([`${JSON.stringify({ verdict: "FAIL" })}\n`]);
    expect(stderr).toEqual([]);
    expect(`${stdout.join("")} ${stderr.join("")}`).not.toContain(secret);
  });

it("binds the default CLI dependency set to the production implementations", () => {
  expect(defaultProductionLoadCliDependencies).toMatchObject({
    resolveConfig: resolveProductionLoadConfig,
    createSocketTransport: createProductionLoadSocketTransport,
    createControlClient: createProductionLoadControlClient,
    createHttpAdapter: createProductionLoadHttpAdapter,
    runGate: runProductionLoadGate,
    readDecision: readApprovedProductionLoadDecision,
    assertDecisionUnchanged: assertProductionLoadDecisionUnchanged,
    runWorkload: runProductionLoadWorkload,
    runFaultMatrix: runProductionFaultMatrix,
    buildReport: buildProductionLoadGateReport,
    writeReport: writeProductionLoadReportExclusive,
    writeTerminalReceipt: writeProductionLoadTerminalReceiptExclusive,
  });
  expect(defaultProductionLoadCliDependencies.readActiveRelease).toEqual(expect.any(Function));
});

  it("cannot report PASS after an operator signal even if the gate dependency returns", async () => {
    const config = productionConfig();
    const signalSource = new TestSignalSource();
    let markStarted: () => void = () => undefined;
    let releaseGate: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const released = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const runGate: ProductionLoadCliDependencies["runGate"] = vi.fn(async () => {
      markStarted();
      await released;
      return gateExecution(config);
    });
    const injected = dependencies({ config, runGate });
    const stdout: string[] = [];
    const stderr: string[] = [];

    const running = runProductionLoadCli({
      argv: [],
      environment: processEnvironment(),
      repositoryRoot,
      signalSource,
      writeStdout: (message) => stdout.push(message),
      writeStderr: (message) => stderr.push(message),
      dependencies: injected,
    });
    await started;
    signalSource.emit("SIGINT");
    releaseGate();

    await expect(running).resolves.toBe(1);
    expect(stdout).toEqual([`${JSON.stringify({ verdict: "FAIL" })}\n`]);
    expect(stderr).toEqual([]);
    expect(signalSource.listeners.get("SIGINT")?.size ?? 0).toBe(0);
    expect(signalSource.listeners.get("SIGTERM")?.size ?? 0).toBe(0);
  });
});
