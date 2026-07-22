import { describe, expect, it, vi } from "vitest";

import {
  PRODUCTION_LOAD_FAULT_MATRIX,
  buildProductionLoadSeedPlan,
} from "../../src/lib/performance/load-report";
import {
  createProductionLoadControlClient,
  type ProductionLoadControlTransport,
} from "./production-load-control";

const resource = {
  hostCpuPercent: 25,
  availableMemoryBytes: 16 * 1024 ** 3,
  rootFreeFraction: 0.5,
  rootFreeBytes: 500 * 1024 ** 3,
  diskReadBytes: 100,
  diskWriteBytes: 200,
  postgresConnections: 10,
  postgresMaxConnections: 100,
  postgresDeadlocks: 0,
  postgresLockWaitMs: 4,
  temperatureCelsius: 55,
  oomKills: 0,
  thermalThrottleIncrements: 0,
  runnerQueueDepth: 1,
  runnerQueueWaitMs: 20,
  runnerRunningJobs: 2,
  runnerVmCpuPercent: 30,
  runnerVmAvailableMemoryBytes: 4 * 1024 ** 3,
  unrelatedServicesHealthy: true,
} as const;

const baseline = {
  oomKills: 0,
  thermalThrottleIncrements: 0,
  postgresDeadlocks: 0,
} as const;

const faultProbe = {
  componentHealthy: true,
  queueDepth: 0,
  alertOrDeadLetterVisible: true,
  unrelatedServicesHealthy: true,
  runnerRunningJobs: 0,
} as const;

const invariants = {
  acknowledgedMutationFailures: 0,
  duplicateOfficialEffects: 0,
  secretLeakFindings: 0,
  runnerMaxConcurrentJobs: 2,
} as const;

const examFixture = {
  examSessionId: "6fd0d069-7da4-4864-8a66-c5a90d8a34c0",
  examItemId: "synthetic-exam-item",
  examRevision: 0,
} as const;

function scriptedTransport() {
  const request = vi.fn<ProductionLoadControlTransport["request"]>(async (operation, payload) => {
    if (operation === "seed") {
      const plan = payload as ReturnType<typeof buildProductionLoadSeedPlan>;
      return {
        sessions: plan.learners.map((learner) => ({
          learnerId: learner.alias,
          sessionHandle: `__Secure-learncoding.session_token=opaque-${learner.alias}`,
          ...examFixture,
        })),
      };
    }
    if (operation === "baseline") return baseline;
    if (operation === "sample") return resource;
    if (operation === "runner_observation") return {
      runnerAdmissionMs: 10,
      runnerQueueWaitMs: 20,
      duplicateOfficialEffects: 0,
    };
    if (operation === "fault_probe") return faultProbe;
    if (operation === "fault_invariants") return invariants;
    return { ok: true };
  });
  return { request };
}

describe("production load control protocol", () => {
  it("seeds the exact no-provider dataset and keeps opaque sessions out of evidence-facing results", async () => {
    const transport = scriptedTransport();
    const client = createProductionLoadControlClient(transport);
    const plan = buildProductionLoadSeedPlan();

    await client.seed(plan);

    expect(transport.request).toHaveBeenCalledWith("seed", plan);
    expect(await client.authenticate(plan.learners[0]!)).toEqual({
      learnerId: "synthetic-load-01",
      sessionHandle: expect.stringMatching(/^__Secure-learncoding\.session_token=opaque-/),
      ...examFixture,
    });
    await expect(client.authenticate({
      id: "missing",
      alias: "synthetic-load-99",
      email: "missing@example.invalid",
    })).rejects.toThrow("Production load control failed: session_not_seeded");
  });

  it("strictly validates baseline and five-second resource telemetry", async () => {
    const transport = scriptedTransport();
    const client = createProductionLoadControlClient(transport);

    await expect(client.captureBaseline()).resolves.toEqual(baseline);
    await expect(client.sampleResources(new AbortController().signal)).resolves.toEqual(resource);

    transport.request.mockResolvedValueOnce({ ...resource, unexpected: true });
    await expect(client.sampleResources(new AbortController().signal)).rejects.toThrow(
      "Production load control failed: invalid_sample",
    );
  });

  it("returns strict runner admission and queue evidence by opaque request id", async () => {
    const client = createProductionLoadControlClient(scriptedTransport());
    await expect(client.runnerObservation(
      "7f8b46d5-dd2f-42d9-8bd2-e45c046031d3",
      new AbortController().signal,
    )).resolves.toEqual({
      runnerAdmissionMs: 10,
      runnerQueueWaitMs: 20,
      duplicateOfficialEffects: 0,
    });
  });

  it("maps each fault operation without passing authentication material", async () => {
    const transport = scriptedTransport();
    const client = createProductionLoadControlClient(transport);
    const fault = PRODUCTION_LOAD_FAULT_MATRIX[0]!;
    const signal = new AbortController().signal;

    await client.reset(fault, signal);
    await expect(client.probe(fault, "baseline", signal)).resolves.toEqual(faultProbe);
    await client.runAuthenticatedBrowserJourney(fault, "steady", signal);
    await client.injectAndRelease(fault, signal);
    await expect(client.verifyInvariants(fault, signal)).resolves.toEqual(invariants);

    const serializedCalls = JSON.stringify(transport.request.mock.calls);
    expect(serializedCalls).not.toMatch(/session_token|authorization|bearer|cookie/i);
    expect(transport.request.mock.calls.map(([operation]) => operation)).toEqual([
      "fault_reset",
      "fault_probe",
      "browser_journey",
      "fault_inject_release",
      "fault_invariants",
    ]);
  });

  it("rejects malformed, duplicate, or secret-shaped session handles without echoing them", async () => {
    const plan = buildProductionLoadSeedPlan();
    const secret = "Bearer should-never-appear-in-an-error";
    const transport: ProductionLoadControlTransport = {
      request: vi.fn(async () => ({
        sessions: [
          ...plan.learners.slice(0, 9).map((learner) => ({
            learnerId: learner.alias,
            sessionHandle: `opaque-${learner.alias}`,
            ...examFixture,
          })),
          {
            learnerId: plan.learners[0]!.alias,
            sessionHandle: secret,
            ...examFixture,
          },
        ],
      })),
    };
    const client = createProductionLoadControlClient(transport);

    let message = "";
    try {
      await client.seed(plan);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toBe("Production load control failed: invalid_seed_sessions");
    expect(message).not.toContain(secret);
  });
});
