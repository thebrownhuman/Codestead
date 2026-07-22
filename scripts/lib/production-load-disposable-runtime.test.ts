import { describe, expect, it, vi } from "vitest";

import type { ProductionLoadCandidate } from "../../src/lib/performance/load-report";
import type { ProductionLoadFixtureBinding } from "./production-load-fixture-runtime";
import {
  createProductionLoadDisposableFixtureOperations,
  type ProductionLoadDisposableFixtureTopology,
} from "./production-load-disposable-runtime";

function binding(): ProductionLoadFixtureBinding {
  const candidate: ProductionLoadCandidate = {
    gitSha: "1".repeat(40),
    gitTree: "2".repeat(40),
    releaseManifestSha256: `sha256:${"3".repeat(64)}`,
    applicationImageRecordSha256: `sha256:${"4".repeat(64)}`,
    composeProject: "learncoding",
    composeWorkdir: "/opt/learncoding",
    publicOrigin: "https://learn.example.test",
    managedInventorySha256: `sha256:${"5".repeat(64)}`,
    firewallPolicySha256: `sha256:${"6".repeat(64)}`,
    runnerGuestReleaseSha256: `sha256:${"7".repeat(64)}`,
    runnerImageRecordSha256: `sha256:${"8".repeat(64)}`,
    nucHostId: "nuc-homelab:approved-host",
    runnerVmId: "123e4567-e89b-42d3-a456-426614174000",
    datasetId: "seed-20260715",
  };
  return {
    profile: "codestead-production-load-v1",
    project: "learncoding",
    fixtureRoot: "/var/lib/learncoding-production-load-fixtures",
    runtimeSocket: "/run/learncoding-production-load-fixtures/runtime.sock",
    candidate,
    candidateRunIdentitySha256: `sha256:${"a".repeat(64)}`,
    decisionSha256: `sha256:${"b".repeat(64)}`,
    expectedUnrelatedInventorySha256: "c".repeat(64),
  };
}

function topology(overrides: Partial<ProductionLoadDisposableFixtureTopology> = {}) {
  const learners = Array.from({ length: 10 }, (_, index) =>
    `load-learner-${String(index + 1).padStart(2, "0")}`);
  return {
    readinessEvidence: vi.fn(async () => ({
      postgresRoundTrip: true,
      providerStatuses: { gmail: 204, ai: 204, drive: 204 } as const,
      authenticatedLearnerIds: learners,
      runnerMaxConcurrentJobs: 2,
      runnerQueuedJobsObserved: 2,
    })),
    reset: vi.fn(async () => undefined),
    injectAndRelease: vi.fn(async () => undefined),
    probe: vi.fn(async () => ({ componentHealthy: true, alertOrDeadLetterVisible: true })),
    browserJourney: vi.fn(async () => undefined),
    invariantEvidence: vi.fn(async () => ({
      acknowledgedMutationFailures: 0,
      runnerMaxConcurrentJobs: 2,
      secretLeakFindings: 0,
    })),
    close: vi.fn(async () => undefined),
    ...overrides,
  } satisfies ProductionLoadDisposableFixtureTopology;
}

describe("production load disposable fixture operations", () => {
  it("binds one run to ten authenticated learners and measured two-slot backpressure", async () => {
    const fixture = topology();
    const operations = createProductionLoadDisposableFixtureOperations({
      topology: fixture,
      now: () => new Date("2026-07-20T00:00:00.000Z"),
    });
    const signal = new AbortController().signal;
    const run = binding();

    await expect(operations.assertReady(run, signal)).resolves.toBeUndefined();
    await expect(operations.assertReady(run, signal)).resolves.toBeUndefined();
    expect(fixture.readinessEvidence).toHaveBeenCalledTimes(2);
    await expect(operations.isolationStatus(signal)).resolves.toEqual({
      maintenanceWindowApproved: true,
      freshRecoveryPoint: true,
    });
    await expect(operations.invariantEvidence(
      "fake_ai_provider_failure",
      signal,
    )).resolves.toEqual({
      observedAt: "2026-07-20T00:00:00.000Z",
      acknowledgedMutationFailures: 0,
      runnerMaxConcurrentJobs: 2,
      secretLeakFindings: 0,
    });
  });

  it("drives reset, real release, health probes, and authenticated journeys", async () => {
    const fixture = topology();
    const operations = createProductionLoadDisposableFixtureOperations({ topology: fixture });
    const signal = new AbortController().signal;
    await operations.assertReady(binding(), signal);

    await operations.reset("fake_gmail_failure", signal);
    await operations.injectAndRelease("fake_gmail_failure", signal);
    await expect(operations.probe(
      "fake_gmail_failure", "recovery", signal,
    )).resolves.toEqual({ componentHealthy: true, alertOrDeadLetterVisible: true });
    await operations.browserJourney("fake_gmail_failure", "recovered", signal);
    await operations.close();

    expect(fixture.reset).toHaveBeenCalledWith("fake_gmail_failure", signal);
    expect(fixture.injectAndRelease).toHaveBeenCalledWith("fake_gmail_failure", signal);
    expect(fixture.browserJourney).toHaveBeenCalledWith(
      "fake_gmail_failure", "recovered", signal,
    );
    expect(fixture.close).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["nine learners", { authenticatedLearnerIds: Array.from({ length: 9 }, (_, i) => `l-${i}`) }],
    ["duplicate learner", { authenticatedLearnerIds: Array(10).fill("same") }],
    ["third runner", { runnerMaxConcurrentJobs: 3 }],
    ["no queue", { runnerQueuedJobsObserved: 0 }],
    ["provider leak", { providerStatuses: { gmail: 204, ai: 503, drive: 204 } }],
  ])("fails closed for invalid readiness evidence: %s", async (_label, changed) => {
    const good = await topology().readinessEvidence(new AbortController().signal);
    const fixture = topology({ readinessEvidence: vi.fn(async () => ({ ...good, ...changed })) });
    const operations = createProductionLoadDisposableFixtureOperations({ topology: fixture });
    await expect(operations.assertReady(
      binding(), new AbortController().signal,
    )).rejects.toThrow("fixture_not_ready");
  });

  it("rejects a changed binding and never fabricates external host or VM telemetry", async () => {
    const operations = createProductionLoadDisposableFixtureOperations({ topology: topology() });
    const signal = new AbortController().signal;
    const first = binding();
    await operations.assertReady(first, signal);
    await expect(operations.assertReady({
      ...first,
      decisionSha256: `sha256:${"d".repeat(64)}`,
    }, signal)).rejects.toThrow("binding_rejected");
    await expect(operations.hostTelemetry(signal)).rejects.toThrow(
      "external_host_telemetry_required",
    );
    await expect(operations.runnerVmTelemetry(
      first.candidate.runnerVmId,
      "52:54:00:20:00:12",
      signal,
    )).rejects.toThrow("external_runner_telemetry_required");
  });
});
