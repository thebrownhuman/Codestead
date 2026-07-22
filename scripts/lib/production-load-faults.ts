import {
  PRODUCTION_LOAD_FAULT_MATRIX,
  PRODUCTION_LOAD_THRESHOLDS,
  buildProductionSamplingOffsets,
} from "../../src/lib/performance/load-report";
import type { ProductionLoadClock } from "./production-load-workload";

export type ProductionFault = (typeof PRODUCTION_LOAD_FAULT_MATRIX)[number];
export type ProductionFaultPhase = "baseline" | "recovery";

export type ProductionFaultProbe = {
  readonly componentHealthy: boolean;
  readonly queueDepth: number;
  readonly alertOrDeadLetterVisible: boolean;
  readonly unrelatedServicesHealthy: boolean;
  readonly runnerRunningJobs: number;
};

export type ProductionFaultInvariantEvidence = {
  readonly acknowledgedMutationFailures: number;
  readonly duplicateOfficialEffects: number;
  readonly secretLeakFindings: number;
  readonly runnerMaxConcurrentJobs: number;
};

export type ProductionFaultAdapter = {
  reset(fault: ProductionFault, signal: AbortSignal): Promise<void>;
  probe(
    fault: ProductionFault,
    phase: ProductionFaultPhase,
    signal: AbortSignal,
  ): Promise<ProductionFaultProbe>;
  runAuthenticatedBrowserJourney(
    fault: ProductionFault,
    stage: "steady" | "recovered",
    signal: AbortSignal,
  ): Promise<void>;
  injectAndRelease(fault: ProductionFault, signal: AbortSignal): Promise<void>;
  verifyInvariants(
    fault: ProductionFault,
    signal: AbortSignal,
  ): Promise<ProductionFaultInvariantEvidence>;
};

export type ProductionFaultCaseResult = {
  readonly faultId: ProductionFault["id"];
  readonly passed: true;
  readonly healthyBaselineMs: number;
  readonly baselineSamples: number;
  readonly faultDurationMs: number;
  readonly componentRecoveryMs: number;
  readonly queueDrainMs: number;
  readonly alertOrDeadLetterVisibilityMs: number;
  readonly invariantCheckMs: number;
  readonly steadyBrowserJourneyPassed: true;
  readonly recoveredBrowserJourneyPassed: true;
  readonly invariants: ProductionFaultInvariantEvidence;
};

export type ProductionFaultMatrixResult = {
  readonly scope: "codestead-project-only";
  readonly startedAt: string;
  readonly completedAt: string;
  readonly cases: readonly ProductionFaultCaseResult[];
};

export type RunProductionFaultMatrixInput = {
  readonly scope: "codestead-project-only";
  readonly clock: ProductionLoadClock;
  readonly adapter: ProductionFaultAdapter;
};

function safeClockNow(clock: ProductionLoadClock, minimum = 0): number {
  const value = clock.now();
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error("Production fault gate failed: invalid_clock");
  }
  return value;
}

function fail(controller: AbortController, code: string, fault: ProductionFault): never {
  controller.abort(code);
  throw new Error(`Production fault gate failed: ${code}:${fault.id}`);
}

function validateProbe(
  probe: ProductionFaultProbe,
  controller: AbortController,
  fault: ProductionFault,
): void {
  if (typeof probe.componentHealthy !== "boolean"
    || !Number.isSafeInteger(probe.queueDepth)
    || probe.queueDepth < 0
    || typeof probe.alertOrDeadLetterVisible !== "boolean"
    || typeof probe.unrelatedServicesHealthy !== "boolean"
    || !Number.isSafeInteger(probe.runnerRunningJobs)
    || probe.runnerRunningJobs < 0) {
    fail(controller, "invalid_probe", fault);
  }
  if (!probe.unrelatedServicesHealthy) {
    fail(controller, "unrelated_service_regression", fault);
  }
  if (probe.runnerRunningJobs > PRODUCTION_LOAD_THRESHOLDS.maxConcurrentRunnerJobs) {
    fail(controller, "runner_concurrency_exceeded", fault);
  }
}

function validateInvariants(
  evidence: ProductionFaultInvariantEvidence,
  controller: AbortController,
  fault: ProductionFault,
): void {
  const entries = Object.values(evidence);
  if (entries.some((value) => !Number.isSafeInteger(value) || value < 0)) {
    fail(controller, "invalid_invariant_evidence", fault);
  }
  if (evidence.acknowledgedMutationFailures > 0) {
    fail(controller, "acknowledged_mutation_failure", fault);
  }
  if (evidence.duplicateOfficialEffects > 0) {
    fail(controller, "duplicate_official_effect", fault);
  }
  if (evidence.secretLeakFindings > 0) {
    fail(controller, "secret_leak_finding", fault);
  }
  if (evidence.runnerMaxConcurrentJobs > PRODUCTION_LOAD_THRESHOLDS.maxConcurrentRunnerJobs) {
    fail(controller, "runner_concurrency_exceeded", fault);
  }
}

export async function runProductionFaultMatrix(
  input: RunProductionFaultMatrixInput,
): Promise<ProductionFaultMatrixResult> {
  if (input.scope !== "codestead-project-only") {
    throw new Error("Production fault gate failed: invalid_scope");
  }
  const startedAtMs = safeClockNow(input.clock);
  const controller = new AbortController();
  const results: ProductionFaultCaseResult[] = [];

  for (const fault of PRODUCTION_LOAD_FAULT_MATRIX) {
    try {
      await input.adapter.reset(fault, controller.signal);
    } catch {
      fail(controller, "clean_reset_failed", fault);
    }

    const baselineStartedAtMs = safeClockNow(input.clock, startedAtMs);
    const baselineOffsets = buildProductionSamplingOffsets(fault.healthyBaselineMs);
    for (const offsetMs of baselineOffsets) {
      await input.clock.waitUntil(baselineStartedAtMs + offsetMs, controller.signal);
      let probe: ProductionFaultProbe;
      try {
        probe = await input.adapter.probe(fault, "baseline", controller.signal);
      } catch {
        fail(controller, "baseline_probe_failed", fault);
      }
      validateProbe(probe, controller, fault);
      if (!probe.componentHealthy) fail(controller, "unhealthy_baseline", fault);
    }
    await input.clock.waitUntil(
      baselineStartedAtMs + fault.healthyBaselineMs,
      controller.signal,
    );

    try {
      await input.adapter.runAuthenticatedBrowserJourney(
        fault,
        "steady",
        controller.signal,
      );
    } catch {
      fail(controller, "steady_browser_journey_failed", fault);
    }

    const faultStartedAtMs = safeClockNow(input.clock, baselineStartedAtMs);
    try {
      await input.adapter.injectAndRelease(fault, controller.signal);
    } catch {
      fail(controller, "fault_injection_failed", fault);
    }
    const faultReleasedAtMs = safeClockNow(input.clock, faultStartedAtMs);
    const faultDurationMs = faultReleasedAtMs - faultStartedAtMs;
    if (faultDurationMs > fault.faultMaxMs) {
      fail(controller, "fault_duration_exceeded", fault);
    }

    let componentRecoveredAtMs: number | null = null;
    let queueDrainedAtMs: number | null = null;
    let signalVisibleAtMs: number | null = null;
    let recoveredBrowserJourneyPassed = false;
    let invariantsVerified = false;
    let verifiedInvariants: ProductionFaultInvariantEvidence | null = null;
    const invariantEndMs = fault.recoveryMaxMs + fault.invariantCheckMs;

    for (
      let elapsedMs = 0;
      elapsedMs <= PRODUCTION_LOAD_THRESHOLDS.queueDrainMaxMs;
      elapsedMs += 5_000
    ) {
      const targetMs = faultReleasedAtMs + elapsedMs;
      await input.clock.waitUntil(targetMs, controller.signal);
      let probe: ProductionFaultProbe;
      try {
        probe = await input.adapter.probe(fault, "recovery", controller.signal);
      } catch {
        fail(controller, "recovery_probe_failed", fault);
      }
      validateProbe(probe, controller, fault);
      const observedAtMs = safeClockNow(input.clock, targetMs);

      if (probe.alertOrDeadLetterVisible && signalVisibleAtMs === null) {
        signalVisibleAtMs = observedAtMs;
      }
      if (probe.componentHealthy && componentRecoveredAtMs === null) {
        componentRecoveredAtMs = observedAtMs;
        try {
          await input.adapter.runAuthenticatedBrowserJourney(
            fault,
            "recovered",
            controller.signal,
          );
          recoveredBrowserJourneyPassed = true;
        } catch {
          fail(controller, "recovered_browser_journey_failed", fault);
        }
      }
      if (probe.queueDepth === 0 && queueDrainedAtMs === null) {
        queueDrainedAtMs = observedAtMs;
      }

      if (signalVisibleAtMs === null
        && observedAtMs - faultStartedAtMs >= PRODUCTION_LOAD_THRESHOLDS.alertVisibilityMaxMs) {
        fail(controller, "alert_or_dead_letter_visibility_exceeded", fault);
      }
      if (elapsedMs === fault.recoveryMaxMs && componentRecoveredAtMs === null) {
        fail(controller, "component_recovery_exceeded", fault);
      }
      if (elapsedMs >= fault.recoveryMaxMs
        && elapsedMs <= invariantEndMs
        && !probe.componentHealthy) {
        fail(controller, "component_unhealthy_during_invariants", fault);
      }
      if (elapsedMs === invariantEndMs) {
        let invariantEvidence: ProductionFaultInvariantEvidence;
        try {
          invariantEvidence = await input.adapter.verifyInvariants(fault, controller.signal);
        } catch {
          fail(controller, "invariant_verification_failed", fault);
        }
        validateInvariants(invariantEvidence, controller, fault);
        verifiedInvariants = invariantEvidence;
        invariantsVerified = true;
      }

      if (elapsedMs >= invariantEndMs
        && queueDrainedAtMs !== null
        && signalVisibleAtMs !== null
        && componentRecoveredAtMs !== null
        && invariantsVerified) {
        break;
      }
      if (elapsedMs === PRODUCTION_LOAD_THRESHOLDS.queueDrainMaxMs
        && queueDrainedAtMs === null) {
        fail(controller, "queue_drain_exceeded", fault);
      }
    }

    if (componentRecoveredAtMs === null
      || queueDrainedAtMs === null
      || signalVisibleAtMs === null
      || !recoveredBrowserJourneyPassed
      || !invariantsVerified
      || verifiedInvariants === null) {
      fail(controller, "incomplete_fault_evidence", fault);
    }

    results.push({
      faultId: fault.id,
      passed: true,
      healthyBaselineMs: fault.healthyBaselineMs,
      baselineSamples: baselineOffsets.length,
      faultDurationMs,
      componentRecoveryMs: componentRecoveredAtMs - faultReleasedAtMs,
      queueDrainMs: queueDrainedAtMs - faultReleasedAtMs,
      alertOrDeadLetterVisibilityMs: signalVisibleAtMs - faultStartedAtMs,
      invariantCheckMs: fault.invariantCheckMs,
      steadyBrowserJourneyPassed: true,
      recoveredBrowserJourneyPassed: true,
      invariants: verifiedInvariants,
    });
  }

  return {
    scope: "codestead-project-only",
    startedAt: new Date(startedAtMs).toISOString(),
    completedAt: new Date(safeClockNow(input.clock, startedAtMs)).toISOString(),
    cases: results,
  };
}
