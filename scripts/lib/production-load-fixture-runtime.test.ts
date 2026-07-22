import { describe, expect, it, vi } from "vitest";

import type { ProductionLoadCandidate } from "../../src/lib/performance/load-report";
import {
  createProductionLoadFixtureRuntimeAdapter,
  type ProductionLoadFixtureOperations,
} from "./production-load-fixture-runtime";
import type { ProductionLoadTestControlRequest } from "./production-load-test-control-server";

const RUN_ID = `sha256:${"a".repeat(64)}`;
const DECISION_ID = `sha256:${"b".repeat(64)}`;
const VM_ID = "123e4567-e89b-42d3-a456-426614174000";
const VM_MAC = "52:54:00:20:00:12" as const;

function candidate(): ProductionLoadCandidate {
  return {
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
    runnerVmId: VM_ID,
    datasetId: "seed-20260715",
  };
}

function environment(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "test",
    LOAD_FIXTURE_PROFILE: "codestead-production-load-v1",
    LOAD_FIXTURE_APPROVED: "1",
    LOAD_FIXTURE_RUN_IDENTITY_SHA256: RUN_ID,
    LOAD_FIXTURE_ROOT: "/var/lib/learncoding-production-load-fixtures",
    LOAD_FIXTURE_RUNTIME_SOCKET:
      "/run/learncoding-production-load-fixtures/runtime.sock",
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
      hostCpuPercent: 12,
      availableMemoryBytes: 16 * 1024 ** 3,
      rootFreeFraction: 0.75,
      rootFreeBytes: 750_000_000_000,
      diskReadBytes: 1_000,
      diskWriteBytes: 2_000,
      temperatureCelsius: 54,
      oomKills: 0,
      thermalThrottleIncrements: 0,
    })),
    runnerVmTelemetry: vi.fn(async () => ({
      runnerVmCpuPercent: 17,
      runnerVmAvailableMemoryBytes: 6 * 1024 ** 3,
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

function context() {
  return {
    candidate: candidate(),
    candidateRunIdentitySha256: RUN_ID,
    decisionSha256: DECISION_ID,
    expectedUnrelatedInventorySha256: "c".repeat(64),
  } as const;
}

function target(control: string) {
  return { kind: "test-control" as const, control };
}

function mutation(
  action: "reset" | "inject-and-release",
  faultId: "postgres_proxy_interruption" | "fake_gmail_failure",
): ProductionLoadTestControlRequest {
  return {
    version: 1,
    action,
    faultId,
    target: target(faultId),
    project: "learncoding",
    runnerVmId: VM_ID,
    runnerVmMac: VM_MAC,
  };
}

describe("production load concrete fixture adapter", () => {
  it.each([
    ["LOAD_FIXTURE_PROFILE", undefined],
    ["LOAD_FIXTURE_PROFILE", "default"],
    ["LOAD_FIXTURE_APPROVED", "0"],
    ["LOAD_FIXTURE_RUN_IDENTITY_SHA256", `sha256:${"d".repeat(64)}`],
    ["LOAD_FIXTURE_ROOT", "/"],
    ["LOAD_FIXTURE_RUNTIME_SOCKET", "/run/docker.sock"],
  ] as const)("refuses an unsafe fixture configuration (%s)", async (name, value) => {
    const env = environment();
    if (value === undefined) delete env[name];
    else env[name] = value;
    const runtime = operations();
    await expect(createProductionLoadFixtureRuntimeAdapter({
      environment: env,
      context: context(),
      operations: runtime,
    })).rejects.toThrow(
      /^Production load fixture adapter failed: invalid_fixture_configuration$/,
    );
    expect(runtime.assertReady).not.toHaveBeenCalled();
  });

  it("binds readiness to the exact candidate, decision, fixture root, and run identity", async () => {
    const runtime = operations();
    await createProductionLoadFixtureRuntimeAdapter({
      environment: environment(),
      context: context(),
      operations: runtime,
    });
    expect(runtime.assertReady).toHaveBeenCalledWith({
      profile: "codestead-production-load-v1",
      project: "learncoding",
      fixtureRoot: "/var/lib/learncoding-production-load-fixtures",
      runtimeSocket: "/run/learncoding-production-load-fixtures/runtime.sock",
      candidate: candidate(),
      candidateRunIdentitySha256: RUN_ID,
      decisionSha256: DECISION_ID,
      expectedUnrelatedInventorySha256: "c".repeat(64),
    }, expect.any(AbortSignal));
  });

  it("delegates fixed telemetry without accepting request-supplied paths or commands", async () => {
    const runtime = operations();
    const adapter = await createProductionLoadFixtureRuntimeAdapter({
      environment: environment(), context: context(), operations: runtime,
    });
    const signal = new AbortController().signal;
    await expect(adapter.handle({
      version: 1,
      action: "host-telemetry",
      project: "learncoding",
    }, { requestId: "request-1", signal })).resolves.toMatchObject({
      availableMemoryBytes: 16 * 1024 ** 3,
    });
    await expect(adapter.handle({
      version: 1,
      action: "runner-vm-telemetry",
      runnerDomain: "codestead-runner",
      runnerVmId: VM_ID,
      runnerVmMac: VM_MAC,
    }, { requestId: "request-2", signal })).resolves.toEqual({
      runnerVmCpuPercent: 17,
      runnerVmAvailableMemoryBytes: 6 * 1024 ** 3,
    });
    expect(runtime.hostTelemetry).toHaveBeenCalledWith(expect.any(AbortSignal));
    expect(runtime.runnerVmTelemetry).toHaveBeenCalledWith(
      VM_ID, VM_MAC, expect.any(AbortSignal),
    );
  });

  it("maps only exact disposable fixture mutations and rechecks readiness", async () => {
    const runtime = operations();
    const adapter = await createProductionLoadFixtureRuntimeAdapter({
      environment: environment(), context: context(), operations: runtime,
    });
    const signal = new AbortController().signal;
    await expect(adapter.handle(mutation("reset", "postgres_proxy_interruption"), {
      requestId: "request-reset", signal,
    })).resolves.toBeNull();
    await expect(adapter.handle(mutation("inject-and-release", "fake_gmail_failure"), {
      requestId: "request-inject", signal,
    })).resolves.toBeNull();
    expect(runtime.reset).toHaveBeenCalledWith(
      "postgres_proxy_interruption", expect.any(AbortSignal),
    );
    expect(runtime.injectAndRelease).toHaveBeenCalledWith(
      "fake_gmail_failure", expect.any(AbortSignal),
    );
    expect(runtime.assertReady).toHaveBeenCalledTimes(3);
  });

  it("delegates real probe, browser, and invariant operations for every recovery class", async () => {
    const runtime = operations();
    const adapter = await createProductionLoadFixtureRuntimeAdapter({
      environment: environment(), context: context(), operations: runtime,
    });
    const signal = new AbortController().signal;
    const probe: ProductionLoadTestControlRequest = {
      version: 1,
      action: "probe",
      faultId: "quota_volume_near_full",
      target: target("quota_volume_near_full"),
      phase: "recovery",
      project: "learncoding",
      runnerVmId: VM_ID,
      runnerVmMac: VM_MAC,
    };
    await expect(adapter.handle(probe, { requestId: "probe", signal })).resolves.toEqual({
      componentHealthy: true,
      alertOrDeadLetterVisible: true,
    });
    await expect(adapter.handle({
      version: 1,
      action: "browser-journey",
      faultId: "quota_volume_near_full",
      stage: "recovered",
      project: "learncoding",
    }, { requestId: "browser", signal })).resolves.toEqual({
      ok: true,
      faultId: "quota_volume_near_full",
      stage: "recovered",
    });
    await expect(adapter.handle({
      ...probe,
      action: "invariant-evidence",
      target: target("quota_volume_near_full"),
    }, { requestId: "invariants", signal })).resolves.toMatchObject({
      acknowledgedMutationFailures: 0,
      secretLeakFindings: 0,
    });
  });

  it("fails closed before an operation when cancellation has already fired", async () => {
    const runtime = operations();
    const adapter = await createProductionLoadFixtureRuntimeAdapter({
      environment: environment(), context: context(), operations: runtime,
    });
    const controller = new AbortController();
    controller.abort(new Error("token=must-not-leak"));
    await expect(adapter.handle(mutation("reset", "postgres_proxy_interruption"), {
      requestId: "cancelled", signal: controller.signal,
    })).rejects.toThrow(/^Production load fixture adapter failed: aborted$/);
    expect(runtime.reset).not.toHaveBeenCalled();
  });

  it("closes the operations boundary exactly once", async () => {
    const runtime = operations();
    const adapter = await createProductionLoadFixtureRuntimeAdapter({
      environment: environment(), context: context(), operations: runtime,
    });
    await adapter.close?.();
    await adapter.close?.();
    expect(runtime.close).toHaveBeenCalledOnce();
  });
});
