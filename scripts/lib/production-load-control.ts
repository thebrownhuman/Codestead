import type {
  ProductionLoadResourceBaseline,
  ProductionLoadResourceSample,
  ProductionLoadSeedPlan,
} from "../../src/lib/performance/load-report";
import type {
  ProductionFault,
  ProductionFaultAdapter,
  ProductionFaultInvariantEvidence,
  ProductionFaultPhase,
  ProductionFaultProbe,
} from "./production-load-faults";

export type ProductionLoadControlOperation =
  | "seed"
  | "baseline"
  | "sample"
  | "runner_observation"
  | "fault_reset"
  | "fault_probe"
  | "browser_journey"
  | "fault_inject_release"
  | "fault_invariants";

export type ProductionLoadControlTransport = {
  request(
    operation: ProductionLoadControlOperation,
    payload: unknown,
    signal?: AbortSignal,
  ): Promise<unknown>;
};

export type ProductionLoadSession = {
  readonly learnerId: string;
  readonly sessionHandle: string;
  readonly examSessionId: string;
  readonly examItemId: string;
  readonly examRevision: number;
};

export type ProductionRunnerObservation = {
  readonly runnerAdmissionMs: number;
  readonly runnerQueueWaitMs: number;
  readonly duplicateOfficialEffects: number;
};

export type ProductionLoadControlClient = ProductionFaultAdapter & {
  seed(plan: ProductionLoadSeedPlan): Promise<void>;
  authenticate(learner: ProductionLoadSeedPlan["learners"][number]): Promise<ProductionLoadSession>;
  captureBaseline(signal?: AbortSignal): Promise<ProductionLoadResourceBaseline>;
  sampleResources(signal: AbortSignal): Promise<ProductionLoadResourceSample>;
  runnerObservation(
    requestId: string,
    signal: AbortSignal,
  ): Promise<ProductionRunnerObservation>;
};

function fail(code: string): never {
  throw new Error(`Production load control failed: ${code}`);
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function finite(value: unknown, minimum = 0): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= minimum;
}

function integer(value: unknown, minimum = 0): value is number {
  return Number.isSafeInteger(value) && Number(value) >= minimum;
}

function aborted(signal?: AbortSignal): void {
  if (signal?.aborted) fail("aborted");
}

function parseAck(value: unknown, code: string): void {
  const item = record(value);
  if (!item || !exactKeys(item, ["ok"]) || item.ok !== true) fail(code);
}

const baselineKeys = [
  "oomKills",
  "thermalThrottleIncrements",
  "postgresDeadlocks",
] as const;

function parseBaseline(value: unknown): ProductionLoadResourceBaseline {
  const item = record(value);
  if (!item || !exactKeys(item, baselineKeys)
    || !integer(item.oomKills)
    || !integer(item.thermalThrottleIncrements)
    || !integer(item.postgresDeadlocks)) {
    fail("invalid_baseline");
  }
  return item as ProductionLoadResourceBaseline;
}

const resourceKeys = [
  "hostCpuPercent",
  "availableMemoryBytes",
  "rootFreeFraction",
  "rootFreeBytes",
  "diskReadBytes",
  "diskWriteBytes",
  "postgresConnections",
  "postgresMaxConnections",
  "postgresDeadlocks",
  "postgresLockWaitMs",
  "temperatureCelsius",
  "oomKills",
  "thermalThrottleIncrements",
  "runnerQueueDepth",
  "runnerQueueWaitMs",
  "runnerRunningJobs",
  "runnerVmCpuPercent",
  "runnerVmAvailableMemoryBytes",
  "unrelatedServicesHealthy",
] as const;

function parseResource(value: unknown): ProductionLoadResourceSample {
  const item = record(value);
  if (!item || !exactKeys(item, resourceKeys)
    || !finite(item.hostCpuPercent) || item.hostCpuPercent > 100
    || !integer(item.availableMemoryBytes)
    || !finite(item.rootFreeFraction) || item.rootFreeFraction > 1
    || !integer(item.rootFreeBytes)
    || !integer(item.diskReadBytes)
    || !integer(item.diskWriteBytes)
    || !integer(item.postgresConnections)
    || !integer(item.postgresMaxConnections, 1)
    || !integer(item.postgresDeadlocks)
    || !finite(item.postgresLockWaitMs)
    || !finite(item.temperatureCelsius)
    || !integer(item.oomKills)
    || !integer(item.thermalThrottleIncrements)
    || !integer(item.runnerQueueDepth)
    || !finite(item.runnerQueueWaitMs)
    || !integer(item.runnerRunningJobs)
    || !finite(item.runnerVmCpuPercent) || item.runnerVmCpuPercent > 100
    || !integer(item.runnerVmAvailableMemoryBytes)
    || typeof item.unrelatedServicesHealthy !== "boolean") {
    fail("invalid_sample");
  }
  return item as ProductionLoadResourceSample;
}

const probeKeys = [
  "componentHealthy",
  "queueDepth",
  "alertOrDeadLetterVisible",
  "unrelatedServicesHealthy",
  "runnerRunningJobs",
] as const;

function parseProbe(value: unknown): ProductionFaultProbe {
  const item = record(value);
  if (!item || !exactKeys(item, probeKeys)
    || typeof item.componentHealthy !== "boolean"
    || !integer(item.queueDepth)
    || typeof item.alertOrDeadLetterVisible !== "boolean"
    || typeof item.unrelatedServicesHealthy !== "boolean"
    || !integer(item.runnerRunningJobs)) {
    fail("invalid_fault_probe");
  }
  return item as ProductionFaultProbe;
}

const invariantKeys = [
  "acknowledgedMutationFailures",
  "duplicateOfficialEffects",
  "secretLeakFindings",
  "runnerMaxConcurrentJobs",
] as const;

function parseInvariants(value: unknown): ProductionFaultInvariantEvidence {
  const item = record(value);
  if (!item || !exactKeys(item, invariantKeys)
    || invariantKeys.some((key) => !integer(item[key]))) {
    fail("invalid_fault_invariants");
  }
  return item as ProductionFaultInvariantEvidence;
}

function parseRunnerObservation(value: unknown): ProductionRunnerObservation {
  const item = record(value);
  if (!item || !exactKeys(item, [
    "runnerAdmissionMs",
    "runnerQueueWaitMs",
    "duplicateOfficialEffects",
  ])
    || !finite(item.runnerAdmissionMs)
    || !finite(item.runnerQueueWaitMs)
    || !integer(item.duplicateOfficialEffects)) {
    fail("invalid_runner_observation");
  }
  return item as ProductionRunnerObservation;
}

function faultPayload(fault: ProductionFault) {
  return { faultId: fault.id };
}

export function createProductionLoadControlClient(
  transport: ProductionLoadControlTransport,
): ProductionLoadControlClient {
  const sessions = new Map<string, ProductionLoadSession>();

  return {
    async seed(plan) {
      if (plan.datasetId !== "seed-20260715"
        || plan.learners.length !== 10
        || plan.lessons.length !== 30
        || plan.prompts.length !== 50
        || plan.drafts.length !== 100
        || plan.providerCredentials.length !== 0) {
        fail("invalid_seed_plan");
      }
      const raw = record(await transport.request("seed", plan));
      if (!raw || !exactKeys(raw, ["sessions"]) || !Array.isArray(raw.sessions)
        || raw.sessions.length !== plan.learners.length) {
        fail("invalid_seed_sessions");
      }
      const expected = new Set(plan.learners.map((learner) => learner.alias));
      const next = new Map<string, ProductionLoadSession>();
      for (const candidate of raw.sessions) {
        const item = record(candidate);
        if (!item || !exactKeys(item, [
          "learnerId",
          "sessionHandle",
          "examSessionId",
          "examItemId",
          "examRevision",
        ])
          || typeof item.learnerId !== "string"
          || !expected.has(item.learnerId)
          || next.has(item.learnerId)
          || typeof item.sessionHandle !== "string"
          || item.sessionHandle.length < 48
          || item.sessionHandle.length > 4096
          || /[\r\n]/.test(item.sessionHandle)
          || !item.sessionHandle.startsWith("__Secure-learncoding.session_token=")
          || /(?:^|\s)bearer\s/i.test(item.sessionHandle)
          || typeof item.examSessionId !== "string"
          || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(item.examSessionId)
          || typeof item.examItemId !== "string"
          || !/^[A-Za-z0-9_.:-]{3,180}$/.test(item.examItemId)
          || !integer(item.examRevision)) {
          fail("invalid_seed_sessions");
        }
        next.set(item.learnerId, {
          learnerId: item.learnerId,
          sessionHandle: item.sessionHandle,
          examSessionId: item.examSessionId,
          examItemId: item.examItemId,
          examRevision: item.examRevision,
        });
      }
      if (next.size !== expected.size) fail("invalid_seed_sessions");
      sessions.clear();
      for (const [key, value] of next) sessions.set(key, value);
    },

    async authenticate(learner) {
      const session = sessions.get(learner.alias);
      if (!session) fail("session_not_seeded");
      return session;
    },

    async captureBaseline(signal) {
      aborted(signal);
      return parseBaseline(await transport.request("baseline", {}, signal));
    },

    async sampleResources(signal) {
      aborted(signal);
      return parseResource(await transport.request("sample", {}, signal));
    },

    async runnerObservation(requestId, signal) {
      aborted(signal);
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(requestId)) {
        fail("invalid_runner_request_id");
      }
      return parseRunnerObservation(await transport.request(
        "runner_observation",
        { requestId },
        signal,
      ));
    },

    async reset(fault, signal) {
      aborted(signal);
      parseAck(
        await transport.request("fault_reset", faultPayload(fault), signal),
        "invalid_fault_reset",
      );
    },

    async probe(fault, phase: ProductionFaultPhase, signal) {
      aborted(signal);
      return parseProbe(await transport.request(
        "fault_probe",
        { ...faultPayload(fault), phase },
        signal,
      ));
    },

    async runAuthenticatedBrowserJourney(fault, stage, signal) {
      aborted(signal);
      parseAck(
        await transport.request(
          "browser_journey",
          { ...faultPayload(fault), stage },
          signal,
        ),
        "invalid_browser_journey",
      );
    },

    async injectAndRelease(fault, signal) {
      aborted(signal);
      parseAck(
        await transport.request(
          "fault_inject_release",
          faultPayload(fault),
          signal,
        ),
        "invalid_fault_injection",
      );
    },

    async verifyInvariants(fault, signal) {
      aborted(signal);
      return parseInvariants(await transport.request(
        "fault_invariants",
        faultPayload(fault),
        signal,
      ));
    },
  };
}
