import type { ProductionLoadCandidate } from "../../src/lib/performance/load-report";
import type {
  ProductionLoadTestControlAdapter,
  ProductionLoadTestControlRequest,
} from "./production-load-test-control-server";

export const PRODUCTION_LOAD_FIXTURE_PROFILE = "codestead-production-load-v1";
export const PRODUCTION_LOAD_FIXTURE_ROOT =
  "/var/lib/learncoding-production-load-fixtures";
export const PRODUCTION_LOAD_FIXTURE_RUNTIME_SOCKET =
  "/run/learncoding-production-load-fixtures/runtime.sock";

const hashPattern = /^sha256:[0-9a-f]{64}$/;
const rawHashPattern = /^[0-9a-f]{64}$/;
const requestIdPattern = /^[A-Za-z0-9._:-]{1,160}$/;

const fixtureFaults = new Set([
  "postgres_proxy_interruption",
  "tunnel_proxy_interruption",
  "fake_gmail_failure",
  "fake_ai_provider_failure",
  "fake_offsite_drive_failure",
  "quota_volume_near_full",
  "synthetic_stale_backup_alert",
] as const);

type FixtureFaultId = typeof fixtureFaults extends Set<infer Value>
  ? Value & string
  : never;

type FaultId = Extract<
  ProductionLoadTestControlRequest,
  { readonly action: "probe" }
>["faultId"];

export type ProductionLoadFixtureBinding = {
  readonly profile: typeof PRODUCTION_LOAD_FIXTURE_PROFILE;
  readonly project: "learncoding";
  readonly fixtureRoot: typeof PRODUCTION_LOAD_FIXTURE_ROOT;
  readonly runtimeSocket: typeof PRODUCTION_LOAD_FIXTURE_RUNTIME_SOCKET;
  readonly candidate: ProductionLoadCandidate;
  readonly candidateRunIdentitySha256: string;
  readonly decisionSha256: string;
  readonly expectedUnrelatedInventorySha256: string;
};

export type ProductionLoadFixtureOperations = {
  assertReady(binding: ProductionLoadFixtureBinding, signal: AbortSignal): Promise<void>;
  isolationStatus(signal: AbortSignal): Promise<{
    readonly maintenanceWindowApproved: boolean;
    readonly freshRecoveryPoint: boolean;
  }>;
  hostTelemetry(signal: AbortSignal): Promise<{
    readonly hostCpuPercent: number;
    readonly availableMemoryBytes: number;
    readonly rootFreeFraction: number;
    readonly rootFreeBytes: number;
    readonly diskReadBytes: number;
    readonly diskWriteBytes: number;
    readonly temperatureCelsius: number;
    readonly oomKills: number;
    readonly thermalThrottleIncrements: number;
  }>;
  runnerVmTelemetry(
    runnerVmId: string,
    runnerVmMac: string,
    signal: AbortSignal,
  ): Promise<{
    readonly runnerVmCpuPercent: number;
    readonly runnerVmAvailableMemoryBytes: number;
  }>;
  reset(faultId: FaultId, signal: AbortSignal): Promise<void>;
  injectAndRelease(faultId: FaultId, signal: AbortSignal): Promise<void>;
  probe(
    faultId: FaultId,
    phase: "baseline" | "recovery",
    signal: AbortSignal,
  ): Promise<{
    readonly componentHealthy: boolean;
    readonly alertOrDeadLetterVisible: boolean;
  }>;
  browserJourney(
    faultId: FaultId,
    stage: "steady" | "recovered",
    signal: AbortSignal,
  ): Promise<void>;
  invariantEvidence(faultId: FaultId, signal: AbortSignal): Promise<{
    readonly observedAt: string;
    readonly acknowledgedMutationFailures: number;
    readonly runnerMaxConcurrentJobs: number;
    readonly secretLeakFindings: number;
  }>;
  close(): Promise<void>;
};

export type CreateProductionLoadFixtureRuntimeAdapterOptions = {
  readonly environment: NodeJS.ProcessEnv;
  readonly context: {
    readonly candidate: ProductionLoadCandidate;
    readonly candidateRunIdentitySha256: string;
    readonly decisionSha256: string;
    readonly expectedUnrelatedInventorySha256: string;
  };
  readonly operations: ProductionLoadFixtureOperations;
};

function fail(code: string): never {
  throw new Error(`Production load fixture adapter failed: ${code}`);
}

function abort(signal: AbortSignal): void {
  if (signal.aborted) fail("aborted");
}

function isFixtureFault(value: string): value is FixtureFaultId {
  return fixtureFaults.has(value as FixtureFaultId);
}

function exactTestControlTarget(
  request: Extract<
    ProductionLoadTestControlRequest,
    { readonly action: "reset" | "inject-and-release" | "probe" | "invariant-evidence" }
  >,
): boolean {
  return request.target.kind !== "test-control"
    || request.target.control === request.faultId;
}

function validateConfiguration(
  environment: NodeJS.ProcessEnv,
  context: CreateProductionLoadFixtureRuntimeAdapterOptions["context"],
): ProductionLoadFixtureBinding {
  const expectedInventory = context.expectedUnrelatedInventorySha256;
  if (environment.LOAD_FIXTURE_PROFILE !== PRODUCTION_LOAD_FIXTURE_PROFILE
    || environment.LOAD_FIXTURE_APPROVED !== "1"
    || environment.LOAD_FIXTURE_RUN_IDENTITY_SHA256
      !== context.candidateRunIdentitySha256
    || environment.LOAD_FIXTURE_ROOT !== PRODUCTION_LOAD_FIXTURE_ROOT
    || environment.LOAD_FIXTURE_RUNTIME_SOCKET
      !== PRODUCTION_LOAD_FIXTURE_RUNTIME_SOCKET
    || !hashPattern.test(context.candidateRunIdentitySha256)
    || !hashPattern.test(context.decisionSha256)
    || !rawHashPattern.test(expectedInventory)
    || context.candidate.composeProject !== "learncoding"
    || context.candidate.composeWorkdir !== "/opt/learncoding"
    || context.candidate.datasetId !== "seed-20260715") {
    fail("invalid_fixture_configuration");
  }
  return {
    profile: PRODUCTION_LOAD_FIXTURE_PROFILE,
    project: "learncoding",
    fixtureRoot: PRODUCTION_LOAD_FIXTURE_ROOT,
    runtimeSocket: PRODUCTION_LOAD_FIXTURE_RUNTIME_SOCKET,
    candidate: context.candidate,
    candidateRunIdentitySha256: context.candidateRunIdentitySha256,
    decisionSha256: context.decisionSha256,
    expectedUnrelatedInventorySha256: expectedInventory,
  };
}

export async function createProductionLoadFixtureRuntimeAdapter(
  options: CreateProductionLoadFixtureRuntimeAdapterOptions,
): Promise<ProductionLoadTestControlAdapter> {
  const binding = validateConfiguration(options.environment, options.context);
  const startup = new AbortController();
  await options.operations.assertReady(binding, startup.signal).catch(() => {
    fail("fixture_not_ready");
  });
  let closed = false;
  let closePromise: Promise<void> | undefined;

  const ready = async (signal: AbortSignal): Promise<void> => {
    abort(signal);
    if (closed) fail("closed");
    try {
      await options.operations.assertReady(binding, signal);
    } catch {
      abort(signal);
      fail("fixture_not_ready");
    }
    abort(signal);
  };

  return {
    async handle(request, context) {
      if (!requestIdPattern.test(context.requestId)) fail("invalid_request");
      await ready(context.signal);
      abort(context.signal);
      try {
        if (request.action === "isolation-status") {
          return await options.operations.isolationStatus(context.signal);
        }
        if (request.action === "host-telemetry") {
          return await options.operations.hostTelemetry(context.signal);
        }
        if (request.action === "runner-vm-telemetry") {
          return await options.operations.runnerVmTelemetry(
            request.runnerVmId,
            request.runnerVmMac,
            context.signal,
          );
        }
        if (request.action === "browser-journey") {
          await options.operations.browserJourney(
            request.faultId,
            request.stage,
            context.signal,
          );
          return { ok: true, faultId: request.faultId, stage: request.stage };
        }
        if (!exactTestControlTarget(request)) fail("invalid_request");
        if (request.action === "reset") {
          if (!isFixtureFault(request.faultId)) fail("unsupported_mutation");
          await options.operations.reset(request.faultId, context.signal);
          return null;
        }
        if (request.action === "inject-and-release") {
          if (!isFixtureFault(request.faultId)) fail("unsupported_mutation");
          await options.operations.injectAndRelease(request.faultId, context.signal);
          return null;
        }
        if (request.action === "probe") {
          return await options.operations.probe(
            request.faultId,
            request.phase,
            context.signal,
          );
        }
        return await options.operations.invariantEvidence(
          request.faultId,
          context.signal,
        );
      } catch (error) {
        if (error instanceof Error
          && error.message.startsWith("Production load fixture adapter failed:")) {
          throw error;
        }
        abort(context.signal);
        fail("operation_failed");
      } finally {
        abort(context.signal);
      }
    },
    close() {
      closePromise ??= (async () => {
        closed = true;
        try {
          await options.operations.close();
        } catch {
          fail("close_failed");
        }
      })();
      return closePromise;
    },
  };
}
