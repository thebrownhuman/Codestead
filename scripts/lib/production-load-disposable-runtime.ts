import { createHash } from "node:crypto";

import type {
  ProductionLoadFixtureBinding,
  ProductionLoadFixtureOperations,
} from "./production-load-fixture-runtime";

type FaultId = Parameters<ProductionLoadFixtureOperations["reset"]>[0];
type FaultPhase = Parameters<ProductionLoadFixtureOperations["probe"]>[1];
type BrowserStage = Parameters<ProductionLoadFixtureOperations["browserJourney"]>[1];

export type ProductionLoadDisposableFixtureReadinessEvidence = {
  readonly postgresRoundTrip: boolean;
  readonly providerStatuses: {
    readonly gmail: number;
    readonly ai: number;
    readonly drive: number;
  };
  readonly authenticatedLearnerIds: readonly string[];
  readonly runnerMaxConcurrentJobs: number;
  readonly runnerQueuedJobsObserved: number;
};

export type ProductionLoadDisposableFixtureTopology = {
  readinessEvidence(signal: AbortSignal): Promise<
    ProductionLoadDisposableFixtureReadinessEvidence
  >;
  reset(faultId: FaultId, signal: AbortSignal): Promise<void>;
  injectAndRelease(faultId: FaultId, signal: AbortSignal): Promise<void>;
  probe(faultId: FaultId, phase: FaultPhase, signal: AbortSignal): Promise<{
    readonly componentHealthy: boolean;
    readonly alertOrDeadLetterVisible: boolean;
  }>;
  browserJourney(
    faultId: FaultId,
    stage: BrowserStage,
    signal: AbortSignal,
  ): Promise<void>;
  invariantEvidence(faultId: FaultId, signal: AbortSignal): Promise<{
    readonly acknowledgedMutationFailures: number;
    readonly runnerMaxConcurrentJobs: number;
    readonly secretLeakFindings: number;
  }>;
  close(): Promise<void>;
};

export type CreateProductionLoadDisposableFixtureOperationsOptions = {
  readonly topology: ProductionLoadDisposableFixtureTopology;
  readonly now?: () => Date;
};

const learnerPattern = /^load-learner-(?:0[1-9]|10)$/;

function fail(code: string): never {
  throw new Error(`Production load disposable runtime failed: ${code}`);
}

function abort(signal: AbortSignal): void {
  if (signal.aborted) fail("aborted");
}

function safeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function bindingDigest(binding: ProductionLoadFixtureBinding): string {
  return createHash("sha256")
    .update(Buffer.from(`${JSON.stringify(binding)}\n`, "utf8"))
    .digest("hex");
}

function validateReadiness(
  evidence: ProductionLoadDisposableFixtureReadinessEvidence,
): void {
  const learners = evidence.authenticatedLearnerIds;
  if (evidence.postgresRoundTrip !== true
    || evidence.providerStatuses.gmail !== 204
    || evidence.providerStatuses.ai !== 204
    || evidence.providerStatuses.drive !== 204
    || !Array.isArray(learners)
    || learners.length !== 10
    || new Set(learners).size !== 10
    || learners.some((learner) => !learnerPattern.test(learner))
    || evidence.runnerMaxConcurrentJobs !== 2
    || !Number.isSafeInteger(evidence.runnerQueuedJobsObserved)
    || evidence.runnerQueuedJobsObserved < 1) {
    fail("fixture_not_ready");
  }
}

function validateProbe(value: {
  readonly componentHealthy: boolean;
  readonly alertOrDeadLetterVisible: boolean;
}): void {
  if (typeof value.componentHealthy !== "boolean"
    || typeof value.alertOrDeadLetterVisible !== "boolean") {
    fail("invalid_probe_evidence");
  }
}

function validateInvariants(value: {
  readonly acknowledgedMutationFailures: number;
  readonly runnerMaxConcurrentJobs: number;
  readonly secretLeakFindings: number;
}): void {
  if (!safeInteger(value.acknowledgedMutationFailures)
    || value.runnerMaxConcurrentJobs !== 2
    || !safeInteger(value.secretLeakFindings)) {
    fail("invalid_invariant_evidence");
  }
}

export function createProductionLoadDisposableFixtureOperations(
  options: CreateProductionLoadDisposableFixtureOperationsOptions,
): ProductionLoadFixtureOperations {
  const now = options.now ?? (() => new Date());
  let boundDigest: string | null = null;
  let ready = false;
  let closed = false;
  let closePromise: Promise<void> | null = null;

  const assertAvailable = (signal: AbortSignal) => {
    abort(signal);
    if (closed) fail("closed");
  };
  const assertReady = (signal: AbortSignal) => {
    assertAvailable(signal);
    if (!ready || boundDigest === null) fail("fixture_not_ready");
  };

  return {
    async assertReady(binding, signal) {
      assertAvailable(signal);
      const digest = bindingDigest(binding);
      if (boundDigest !== null && boundDigest !== digest) fail("binding_rejected");
      let evidence: ProductionLoadDisposableFixtureReadinessEvidence;
      try {
        evidence = await options.topology.readinessEvidence(signal);
      } catch {
        abort(signal);
        fail("fixture_not_ready");
      }
      abort(signal);
      validateReadiness(evidence);
      boundDigest = digest;
      ready = true;
    },

    async isolationStatus(signal) {
      assertReady(signal);
      return { maintenanceWindowApproved: true, freshRecoveryPoint: true };
    },

    async hostTelemetry(signal) {
      assertReady(signal);
      fail("external_host_telemetry_required");
    },

    async runnerVmTelemetry(_runnerVmId, _runnerVmMac, signal) {
      assertReady(signal);
      fail("external_runner_telemetry_required");
    },

    async reset(faultId, signal) {
      assertReady(signal);
      await options.topology.reset(faultId, signal);
      abort(signal);
    },

    async injectAndRelease(faultId, signal) {
      assertReady(signal);
      await options.topology.injectAndRelease(faultId, signal);
      abort(signal);
    },

    async probe(faultId, phase, signal) {
      assertReady(signal);
      const value = await options.topology.probe(faultId, phase, signal);
      abort(signal);
      validateProbe(value);
      return value;
    },

    async browserJourney(faultId, stage, signal) {
      assertReady(signal);
      await options.topology.browserJourney(faultId, stage, signal);
      abort(signal);
    },

    async invariantEvidence(faultId, signal) {
      assertReady(signal);
      const value = await options.topology.invariantEvidence(faultId, signal);
      abort(signal);
      validateInvariants(value);
      const observedAt = now();
      if (!(observedAt instanceof Date) || !Number.isFinite(observedAt.getTime())) {
        fail("invalid_clock");
      }
      return { observedAt: observedAt.toISOString(), ...value };
    },

    close() {
      closePromise ??= (async () => {
        closed = true;
        ready = false;
        await options.topology.close();
      })();
      return closePromise;
    },
  };
}
