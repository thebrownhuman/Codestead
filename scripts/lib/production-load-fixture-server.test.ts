import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import type { ProductionLoadCandidate } from "../../src/lib/performance/load-report";
import type {
  ProductionLoadFixtureBinding,
  ProductionLoadFixtureOperations,
} from "./production-load-fixture-runtime";
import { createProductionLoadFixtureRuntimeDispatcher } from "./production-load-fixture-server";

function canonical(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
}

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

function operations(): ProductionLoadFixtureOperations {
  return {
    assertReady: vi.fn(async () => undefined),
    isolationStatus: vi.fn(async () => ({
      maintenanceWindowApproved: true,
      freshRecoveryPoint: true,
    })),
    hostTelemetry: vi.fn(async () => ({
      hostCpuPercent: 1,
      availableMemoryBytes: 16 * 1024 ** 3,
      rootFreeFraction: 0.8,
      rootFreeBytes: 800_000_000_000,
      diskReadBytes: 1,
      diskWriteBytes: 2,
      temperatureCelsius: 42,
      oomKills: 0,
      thermalThrottleIncrements: 0,
    })),
    runnerVmTelemetry: vi.fn(async () => ({
      runnerVmCpuPercent: 2,
      runnerVmAvailableMemoryBytes: 7 * 1024 ** 3,
    })),
    reset: vi.fn(async () => undefined),
    injectAndRelease: vi.fn(async () => undefined),
    probe: vi.fn(async () => ({
      componentHealthy: true,
      alertOrDeadLetterVisible: true,
    })),
    browserJourney: vi.fn(async () => undefined),
    invariantEvidence: vi.fn(async () => ({
      observedAt: "2026-07-20T00:00:00.000Z",
      acknowledgedMutationFailures: 0,
      runnerMaxConcurrentJobs: 2,
      secretLeakFindings: 0,
    })),
    close: vi.fn(async () => undefined),
  };
}

describe("production load disposable fixture runtime dispatcher", () => {
  it("binds the first readiness proof to one exact canonical run identity", async () => {
    const runtime = operations();
    const dispatcher = createProductionLoadFixtureRuntimeDispatcher({
      operations: runtime,
      maximumConcurrentRequests: 2,
      requestTimeoutMs: 1_000,
    });
    const fixture = binding();
    const bindingSha256 = createHash("sha256").update(canonical(fixture)).digest("hex");

    await expect(dispatcher.dispatch(canonical({
      version: 1,
      action: "assert-ready",
      binding: fixture,
    }))).resolves.toEqual(canonical({
      ok: true,
      result: { bindingSha256, ready: true },
    }));
    await expect(dispatcher.dispatch(canonical({
      version: 1,
      action: "isolation-status",
      bindingSha256,
    }))).resolves.toEqual(canonical({
      ok: true,
      result: { maintenanceWindowApproved: true, freshRecoveryPoint: true },
    }));
    expect(runtime.assertReady).toHaveBeenCalledWith(fixture, expect.any(AbortSignal));
  });

  it("rejects operations before binding and rejects changed, noncanonical, or extra-field input", async () => {
    const runtime = operations();
    const dispatcher = createProductionLoadFixtureRuntimeDispatcher({
      operations: runtime,
      maximumConcurrentRequests: 2,
      requestTimeoutMs: 1_000,
    });
    const failed = canonical({ ok: false, result: null });
    await expect(dispatcher.dispatch(canonical({
      version: 1, action: "reset", bindingSha256: "d".repeat(64),
      faultId: "fake_gmail_failure",
    }))).resolves.toEqual(failed);
    await expect(dispatcher.dispatch(Buffer.from(
      '{"version": 1,"action":"runtime-health"}\n',
    ))).resolves.toEqual(failed);
    await expect(dispatcher.dispatch(canonical({
      version: 1, action: "runtime-health", extra: true,
    }))).resolves.toEqual(failed);
    expect(runtime.reset).not.toHaveBeenCalled();
  });

  it("exposes only a detail-free health receipt before the run is bound", async () => {
    const dispatcher = createProductionLoadFixtureRuntimeDispatcher({
      operations: operations(),
      maximumConcurrentRequests: 2,
      requestTimeoutMs: 1_000,
    });
    await expect(dispatcher.dispatch(canonical({
      version: 1, action: "runtime-health",
    }))).resolves.toEqual(canonical({
      ok: true, result: { ready: true },
    }));
  });

  it("enforces two active requests, a deadline, and caller cancellation", async () => {
    const runtime = operations();
    const dispatcher = createProductionLoadFixtureRuntimeDispatcher({
      operations: runtime,
      maximumConcurrentRequests: 2,
      requestTimeoutMs: 30,
    });
    const fixture = binding();
    const bindRequest = canonical({
      version: 1, action: "assert-ready", binding: fixture,
    });
    const bindingSha256 = createHash("sha256").update(canonical(fixture)).digest("hex");
    await expect(dispatcher.dispatch(bindRequest)).resolves.toEqual(canonical({
      ok: true, result: { bindingSha256, ready: true },
    }));

    const blockers: Array<() => void> = [];
    runtime.isolationStatus = vi.fn((signal) => new Promise<{
      maintenanceWindowApproved: boolean;
      freshRecoveryPoint: boolean;
    }>((resolve, reject) => {
      const abort = () => reject(new Error("aborted"));
      signal.addEventListener("abort", abort, { once: true });
      blockers.push(() => {
        signal.removeEventListener("abort", abort);
        resolve({ maintenanceWindowApproved: true, freshRecoveryPoint: true });
      });
    }));
    const request = canonical({
      version: 1, action: "isolation-status", bindingSha256,
    });
    const first = dispatcher.dispatch(request);
    const second = dispatcher.dispatch(request);
    await expect(dispatcher.dispatch(request)).resolves.toEqual(
      canonical({ ok: false, result: null }),
    );
    await expect(first).resolves.toEqual(canonical({ ok: false, result: null }));
    await expect(second).resolves.toEqual(canonical({ ok: false, result: null }));
    expect(blockers).toHaveLength(2);

    const controller = new AbortController();
    const cancelled = dispatcher.dispatch(request, controller.signal);
    controller.abort();
    await expect(cancelled).resolves.toEqual(canonical({ ok: false, result: null }));
  });

  it("does not release a slot until an aborted operation has actually settled", async () => {
    const runtime = operations();
    const dispatcher = createProductionLoadFixtureRuntimeDispatcher({
      operations: runtime,
      maximumConcurrentRequests: 2,
      requestTimeoutMs: 20,
    });
    const fixture = binding();
    const bindingSha256 = createHash("sha256").update(canonical(fixture)).digest("hex");
    await dispatcher.dispatch(canonical({
      version: 1, action: "assert-ready", binding: fixture,
    }));

    const releases: Array<() => void> = [];
    runtime.isolationStatus = vi.fn(() => new Promise<{
      maintenanceWindowApproved: boolean;
      freshRecoveryPoint: boolean;
    }>((resolve) => {
      releases.push(() => resolve({
        maintenanceWindowApproved: true,
        freshRecoveryPoint: true,
      }));
    }));
    const request = canonical({
      version: 1, action: "isolation-status", bindingSha256,
    });
    const failed = canonical({ ok: false, result: null });
    const first = dispatcher.dispatch(request);
    const second = dispatcher.dispatch(request);
    await expect(first).resolves.toEqual(failed);
    await expect(second).resolves.toEqual(failed);
    await expect(dispatcher.dispatch(request)).resolves.toEqual(failed);
    expect(runtime.isolationStatus).toHaveBeenCalledTimes(2);

    for (const release of releases) release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    runtime.isolationStatus = vi.fn(async () => ({
      maintenanceWindowApproved: true,
      freshRecoveryPoint: true,
    }));
    await expect(dispatcher.dispatch(request)).resolves.toEqual(canonical({
      ok: true,
      result: {
        maintenanceWindowApproved: true,
        freshRecoveryPoint: true,
      },
    }));
  });
});
