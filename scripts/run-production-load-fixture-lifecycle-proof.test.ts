import { describe, expect, it, vi } from "vitest";

import type { ProductionLoadDisposableFixtureTopology } from
  "./lib/production-load-disposable-runtime";
import {
  runProductionLoadFixtureLifecycleProof,
  type ProductionLoadFixtureLifecycleProofDependencies,
} from "./run-production-load-fixture-lifecycle-proof";

function dependencies() {
  const topology = { close: vi.fn(async () => undefined) } as unknown as
    ProductionLoadDisposableFixtureTopology;
  const receipt = {
    schemaVersion: 1 as const,
    profile: "codestead-production-load-disposable-lifecycle-v1" as const,
    generatedAt: "2026-07-20T12:00:00.000Z",
    readiness: {
      postgresRoundTrip: true as const,
      providerStatuses: { gmail: 204 as const, ai: 204 as const, drive: 204 as const },
      authenticatedLearnerCount: 10 as const,
      authenticatedLearnerSetSha256: `sha256:${"a".repeat(64)}`,
      runnerMaxConcurrentJobs: 2 as const,
      runnerQueuedJobsObserved: 2,
    },
    faults: [],
  };
  const values = {
    startTopology: vi.fn(async () => topology),
    runLifecycle: vi.fn(async () => receipt),
  } satisfies ProductionLoadFixtureLifecycleProofDependencies;
  return { values, topology, receipt };
}

describe("production load fixture lifecycle proof entrypoint", () => {
  it("runs the lifecycle and always closes its isolated topology", async () => {
    const fixture = dependencies();
    await expect(runProductionLoadFixtureLifecycleProof(fixture.values)).resolves.toBe(
      fixture.receipt,
    );
    expect(fixture.values.runLifecycle).toHaveBeenCalledWith({
      topology: fixture.topology,
    });
    expect(fixture.topology.close).toHaveBeenCalledTimes(1);
  });

  it("closes the topology and emits no dependency detail when the proof fails", async () => {
    const fixture = dependencies();
    fixture.values.runLifecycle.mockRejectedValueOnce(
      new Error("Authorization: Bearer must-not-leak"),
    );
    await expect(runProductionLoadFixtureLifecycleProof(fixture.values)).rejects.toThrow(
      /^production_load_fixture_lifecycle_failed$/,
    );
    expect(fixture.topology.close).toHaveBeenCalledTimes(1);
  });
});
