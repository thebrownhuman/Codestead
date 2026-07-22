import { createHash } from "node:crypto";

import { assertProductionLoadEvidenceSafe } from
  "../../src/lib/performance/load-report";
import type { ProductionLoadDisposableFixtureTopology } from
  "./production-load-disposable-runtime";
import type { ProductionLoadFixtureOperations } from
  "./production-load-fixture-runtime";

type FaultId = Parameters<ProductionLoadFixtureOperations["reset"]>[0];

export const PRODUCTION_LOAD_DISPOSABLE_FAULTS = [
  "postgres_proxy_interruption",
  "tunnel_proxy_interruption",
  "fake_gmail_failure",
  "fake_ai_provider_failure",
  "fake_offsite_drive_failure",
  "quota_volume_near_full",
  "synthetic_stale_backup_alert",
] as const satisfies readonly FaultId[];

export type ProductionLoadDisposableLifecycleReceipt = {
  readonly schemaVersion: 1;
  readonly profile: "codestead-production-load-disposable-lifecycle-v1";
  readonly generatedAt: string;
  readonly readiness: {
    readonly postgresRoundTrip: true;
    readonly providerStatuses: { readonly gmail: 204; readonly ai: 204; readonly drive: 204 };
    readonly authenticatedLearnerCount: 10;
    readonly authenticatedLearnerSetSha256: string;
    readonly runnerMaxConcurrentJobs: 2;
    readonly runnerQueuedJobsObserved: number;
  };
  readonly faults: readonly {
    readonly faultId: (typeof PRODUCTION_LOAD_DISPOSABLE_FAULTS)[number];
    readonly baselineHealthy: true;
    readonly baselineAlertVisible: false;
    readonly recoveryHealthy: true;
    readonly recoveryAlertVisible: true;
    readonly authenticatedJourneySteady: true;
    readonly authenticatedJourneyRecovered: true;
    readonly authenticatedJourneyLearnerCount: 10;
    readonly acknowledgedMutationFailures: 0;
    readonly runnerMaxConcurrentJobs: 2;
    readonly secretLeakFindings: 0;
  }[];
};

function fail(code: string): never {
  throw new Error(`Production load disposable lifecycle failed: ${code}`);
}

function learnerId(index: number): string {
  return `load-learner-${String(index + 1).padStart(2, "0")}`;
}

function validateReadiness(value: Awaited<ReturnType<
  ProductionLoadDisposableFixtureTopology["readinessEvidence"]
>>): void {
  const expected = Array.from({ length: 10 }, (_, index) => learnerId(index));
  if (value.postgresRoundTrip !== true
    || value.providerStatuses.gmail !== 204
    || value.providerStatuses.ai !== 204
    || value.providerStatuses.drive !== 204
    || value.authenticatedLearnerIds.length !== 10
    || value.authenticatedLearnerIds.some((learner, index) => learner !== expected[index])
    || new Set(value.authenticatedLearnerIds).size !== 10
    || value.runnerMaxConcurrentJobs !== 2
    || !Number.isSafeInteger(value.runnerQueuedJobsObserved)
    || value.runnerQueuedJobsObserved < 1) {
    fail("invalid_readiness_evidence");
  }
}

function timestamp(now: () => Date): string {
  const value = now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    fail("invalid_timestamp");
  }
  return value.toISOString();
}

export async function runProductionLoadDisposableLifecycle(options: {
  readonly topology: ProductionLoadDisposableFixtureTopology;
  readonly now?: () => Date;
  readonly signal?: AbortSignal;
}): Promise<ProductionLoadDisposableLifecycleReceipt> {
  const signal = options.signal ?? new AbortController().signal;
  if (signal.aborted) fail("aborted");
  const readiness = await options.topology.readinessEvidence(signal);
  validateReadiness(readiness);
  const faults: ProductionLoadDisposableLifecycleReceipt["faults"][number][] = [];

  for (const faultId of PRODUCTION_LOAD_DISPOSABLE_FAULTS) {
    if (signal.aborted) fail("aborted");
    await options.topology.reset(faultId, signal);
    const baseline = await options.topology.probe(faultId, "baseline", signal);
    if (baseline.componentHealthy !== true || baseline.alertOrDeadLetterVisible !== false) {
      fail("invalid_baseline_evidence");
    }
    await options.topology.browserJourney(faultId, "steady", signal);
    await options.topology.injectAndRelease(faultId, signal);
    const recovery = await options.topology.probe(faultId, "recovery", signal);
    if (recovery.componentHealthy !== true || recovery.alertOrDeadLetterVisible !== true) {
      fail("invalid_recovery_evidence");
    }
    await options.topology.browserJourney(faultId, "recovered", signal);
    const invariants = await options.topology.invariantEvidence(faultId, signal);
    if (invariants.acknowledgedMutationFailures !== 0
      || invariants.runnerMaxConcurrentJobs !== 2
      || invariants.secretLeakFindings !== 0) {
      fail("invalid_invariant_evidence");
    }
    faults.push({
      faultId,
      baselineHealthy: true,
      baselineAlertVisible: false,
      recoveryHealthy: true,
      recoveryAlertVisible: true,
      authenticatedJourneySteady: true,
      authenticatedJourneyRecovered: true,
      authenticatedJourneyLearnerCount: 10,
      acknowledgedMutationFailures: 0,
      runnerMaxConcurrentJobs: 2,
      secretLeakFindings: 0,
    });
  }

  const learnerBytes = Buffer.from(`${readiness.authenticatedLearnerIds.join("\n")}\n`, "utf8");
  return assertProductionLoadEvidenceSafe({
    schemaVersion: 1,
    profile: "codestead-production-load-disposable-lifecycle-v1",
    generatedAt: timestamp(options.now ?? (() => new Date())),
    readiness: {
      postgresRoundTrip: true,
      providerStatuses: { gmail: 204, ai: 204, drive: 204 },
      authenticatedLearnerCount: 10,
      authenticatedLearnerSetSha256:
        `sha256:${createHash("sha256").update(learnerBytes).digest("hex")}`,
      runnerMaxConcurrentJobs: 2,
      runnerQueuedJobsObserved: readiness.runnerQueuedJobsObserved,
    },
    faults,
  } satisfies ProductionLoadDisposableLifecycleReceipt);
}
