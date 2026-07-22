import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import type { ProductionLoadCandidate } from "../../src/lib/performance/load-report";
import {
  createProductionLoadFixtureUnixOperations,
  type ProductionLoadFixtureExchange,
} from "./production-load-fixture-operations";
import type { ProductionLoadFixtureBinding } from "./production-load-fixture-runtime";

const RUN_ID = `sha256:${"a".repeat(64)}`;

function binding(): ProductionLoadFixtureBinding {
  const candidate: ProductionLoadCandidate = {
    gitSha: "1".repeat(40), gitTree: "2".repeat(40),
    releaseManifestSha256: `sha256:${"3".repeat(64)}`,
    applicationImageRecordSha256: `sha256:${"4".repeat(64)}`,
    composeProject: "learncoding", composeWorkdir: "/opt/learncoding",
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
    candidateRunIdentitySha256: RUN_ID,
    decisionSha256: `sha256:${"b".repeat(64)}`,
    expectedUnrelatedInventorySha256: "c".repeat(64),
  };
}

function canonical(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value) + "\n", "utf8");
}

describe("production load fixture Unix operations", () => {
  it("binds every request to one canonical approved fixture identity", async () => {
    const seen: Buffer[] = [];
    let digest = "";
    const exchange: ProductionLoadFixtureExchange = vi.fn(async (request) => {
      seen.push(request);
      const parsed = JSON.parse(request.toString("utf8"));
      if (parsed.action === "assert-ready") {
        digest = createHash("sha256").update(canonical(parsed.binding)).digest("hex");
        return canonical({ ok: true, result: { bindingSha256: digest, ready: true } });
      }
      return canonical({ ok: true, result: null });
    });
    const operations = createProductionLoadFixtureUnixOperations({ exchange });

    await operations.assertReady(binding(), new AbortController().signal);
    await operations.reset("fake_gmail_failure", new AbortController().signal);

    expect(JSON.parse(seen[0]!.toString("utf8"))).toEqual({
      version: 1,
      action: "assert-ready",
      binding: binding(),
    });
    expect(JSON.parse(seen[1]!.toString("utf8"))).toEqual({
      version: 1,
      action: "reset",
      bindingSha256: digest,
      faultId: "fake_gmail_failure",
    });
    expect(seen[1]!.toString("utf8")).not.toMatch(/password|authorization|cookie|token/i);
  });

  it("does not operate before readiness or after close", async () => {
    const exchange = vi.fn(async () => canonical({ ok: true, result: null }));
    const operations = createProductionLoadFixtureUnixOperations({ exchange });
    await expect(operations.reset(
      "fake_ai_provider_failure", new AbortController().signal,
    )).rejects.toThrow("fixture_not_ready");
    await operations.close();
    await expect(operations.assertReady(
      binding(), new AbortController().signal,
    )).rejects.toThrow("closed");
    expect(exchange).not.toHaveBeenCalled();
  });

  it("rejects noncanonical, oversized, extra-field, and wrong-binding responses", async () => {
    const invalid = [
      Buffer.from('{"ok": true,"result":null}\n'),
      canonical({ ok: true, result: null, secret: "must-not-escape" }),
      Buffer.alloc(64 * 1024 + 1, 0x61),
      canonical({ ok: true, result: { ready: true, bindingSha256: "d".repeat(64) } }),
    ];
    for (const response of invalid) {
      const operations = createProductionLoadFixtureUnixOperations({
        exchange: vi.fn(async () => response),
      });
      await expect(operations.assertReady(
        binding(), new AbortController().signal,
      )).rejects.toThrow(/fixture_operation_failed|binding_rejected/);
    }
  });

  it("validates telemetry, probe, browser, and invariant result schemas", async () => {
    const results = [
      { bindingSha256: "pending", ready: true },
      { hostCpuPercent: 2, availableMemoryBytes: 1024, rootFreeFraction: 0.8,
        rootFreeBytes: 2048, diskReadBytes: 1, diskWriteBytes: 2,
        temperatureCelsius: 45, oomKills: 0, thermalThrottleIncrements: 0 },
      { componentHealthy: true, alertOrDeadLetterVisible: false },
      null,
      { observedAt: "2026-07-20T00:00:00.000Z", acknowledgedMutationFailures: 0,
        runnerMaxConcurrentJobs: 2, secretLeakFindings: 0 },
    ];
    let index = 0;
    const exchange: ProductionLoadFixtureExchange = vi.fn(async (request) => {
      const requestValue = JSON.parse(request.toString("utf8"));
      const result = results[index++]!;
      if (requestValue.action === "assert-ready") {
        const bindingSha256 = createHash("sha256")
          .update(canonical(requestValue.binding)).digest("hex");
        return canonical({ ok: true, result: { ...result, bindingSha256 } });
      }
      return canonical({ ok: true, result });
    });
    const operations = createProductionLoadFixtureUnixOperations({ exchange });
    const signal = new AbortController().signal;
    await operations.assertReady(binding(), signal);
    await expect(operations.hostTelemetry(signal)).resolves.toMatchObject({
      availableMemoryBytes: 1024,
    });
    await expect(operations.probe(
      "tunnel_proxy_interruption", "baseline", signal,
    )).resolves.toEqual({ componentHealthy: true, alertOrDeadLetterVisible: false });
    await expect(operations.browserJourney(
      "tunnel_proxy_interruption", "steady", signal,
    )).resolves.toBeUndefined();
    await expect(operations.invariantEvidence(
      "tunnel_proxy_interruption", signal,
    )).resolves.toMatchObject({ runnerMaxConcurrentJobs: 2 });
  });

  it("fails closed on cancellation without exchanging bytes", async () => {
    const exchange = vi.fn(async () => canonical({ ok: true, result: null }));
    const operations = createProductionLoadFixtureUnixOperations({ exchange });
    const controller = new AbortController();
    controller.abort();
    await expect(operations.assertReady(binding(), controller.signal)).rejects.toThrow("aborted");
    expect(exchange).not.toHaveBeenCalled();
  });

  it("executes isolation, runner telemetry, and injection against the bound identity", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const exchange: ProductionLoadFixtureExchange = vi.fn(async (request) => {
      const value = JSON.parse(request.toString("utf8")) as Record<string, unknown>;
      seen.push(value);
      if (value.action === "assert-ready") {
        const bindingSha256 = createHash("sha256")
          .update(canonical(value.binding)).digest("hex");
        return canonical({ ok: true, result: { bindingSha256, ready: true } });
      }
      if (value.action === "isolation-status") {
        return canonical({ ok: true, result: {
          maintenanceWindowApproved: true, freshRecoveryPoint: true,
        } });
      }
      if (value.action === "runner-vm-telemetry") {
        return canonical({ ok: true, result: {
          runnerVmCpuPercent: 25, runnerVmAvailableMemoryBytes: 8_192,
        } });
      }
      return canonical({ ok: true, result: null });
    });
    const operations = createProductionLoadFixtureUnixOperations({ exchange });
    const signal = new AbortController().signal;
    await operations.assertReady(binding(), signal);
    await expect(operations.isolationStatus(signal)).resolves.toEqual({
      maintenanceWindowApproved: true, freshRecoveryPoint: true,
    });
    await expect(operations.runnerVmTelemetry(
      "123e4567-e89b-42d3-a456-426614174000", "52:54:00:20:00:12", signal,
    )).resolves.toEqual({ runnerVmCpuPercent: 25, runnerVmAvailableMemoryBytes: 8_192 });
    await expect(operations.injectAndRelease(
      "fake_ai_provider_failure", signal,
    )).resolves.toBeUndefined();
    expect(seen.map((request) => request.action)).toEqual([
      "assert-ready", "isolation-status", "runner-vm-telemetry", "inject-and-release",
    ]);
    expect(seen.slice(1).every((request) => typeof request.bindingSha256 === "string")).toBe(true);
  });

  it("rejects a different binding after readiness without exchanging it", async () => {
    const exchange: ProductionLoadFixtureExchange = vi.fn(async (request) => {
      const value = JSON.parse(request.toString("utf8")) as Record<string, unknown>;
      const bindingSha256 = createHash("sha256")
        .update(canonical(value.binding)).digest("hex");
      return canonical({ ok: true, result: { bindingSha256, ready: true } });
    });
    const operations = createProductionLoadFixtureUnixOperations({ exchange });
    const signal = new AbortController().signal;
    await operations.assertReady(binding(), signal);
    await expect(operations.assertReady({
      ...binding(), decisionSha256: `sha256:${"d".repeat(64)}`,
    }, signal)).rejects.toThrow("binding_rejected");
    expect(exchange).toHaveBeenCalledTimes(1);
  });

  it.each([
    "reset",
    "inject-and-release",
    "browser-journey",
  ] as const)("rejects a non-null %s response", async (action) => {
    const exchange: ProductionLoadFixtureExchange = vi.fn(async (request) => {
      const value = JSON.parse(request.toString("utf8")) as Record<string, unknown>;
      if (value.action === "assert-ready") {
        const bindingSha256 = createHash("sha256")
          .update(canonical(value.binding)).digest("hex");
        return canonical({ ok: true, result: { bindingSha256, ready: true } });
      }
      return canonical({ ok: true, result: { unexpected: true } });
    });
    const operations = createProductionLoadFixtureUnixOperations({ exchange });
    const signal = new AbortController().signal;
    await operations.assertReady(binding(), signal);
    const operation = action === "reset"
      ? operations.reset("fake_gmail_failure", signal)
      : action === "inject-and-release"
        ? operations.injectAndRelease("fake_gmail_failure", signal)
        : operations.browserJourney("fake_gmail_failure", "steady", signal);
    await expect(operation).rejects.toThrow("fixture_operation_failed");
  });

  it("stabilizes exchange rejection and in-flight abort failures", async () => {
    const rejectedExchange: ProductionLoadFixtureExchange = vi.fn(async (request) => {
      const value = JSON.parse(request.toString("utf8")) as Record<string, unknown>;
      if (value.action === "assert-ready") {
        const bindingSha256 = createHash("sha256")
          .update(canonical(value.binding)).digest("hex");
        return canonical({ ok: true, result: { bindingSha256, ready: true } });
      }
      throw new Error("provider-token=must-not-escape");
    });
    const rejected = createProductionLoadFixtureUnixOperations({ exchange: rejectedExchange });
    const signal = new AbortController().signal;
    await rejected.assertReady(binding(), signal);
    const rejection = rejected.hostTelemetry(signal);
    await expect(rejection).rejects.toThrow("fixture_operation_failed");
    await expect(rejection).rejects.not.toThrow(/provider|token/i);

    const controller = new AbortController();
    const abortedExchange: ProductionLoadFixtureExchange = vi.fn(async (request) => {
      const value = JSON.parse(request.toString("utf8")) as Record<string, unknown>;
      if (value.action === "assert-ready") {
        const bindingSha256 = createHash("sha256")
          .update(canonical(value.binding)).digest("hex");
        return canonical({ ok: true, result: { bindingSha256, ready: true } });
      }
      controller.abort();
      throw new Error("transport-secret=must-not-escape");
    });
    const aborted = createProductionLoadFixtureUnixOperations({ exchange: abortedExchange });
    await aborted.assertReady(binding(), controller.signal);
    await expect(aborted.reset(
      "fake_gmail_failure", controller.signal,
    )).rejects.toThrow("aborted");
  });

  it.each([
    ["isolation extra field", "isolation-status", {
      maintenanceWindowApproved: true, freshRecoveryPoint: true, extra: false,
    }],
    ["isolation flag type", "isolation-status", {
      maintenanceWindowApproved: true, freshRecoveryPoint: "yes",
    }],
    ["runner CPU bound", "runner-vm-telemetry", {
      runnerVmCpuPercent: 101, runnerVmAvailableMemoryBytes: 1,
    }],
    ["runner memory integer", "runner-vm-telemetry", {
      runnerVmCpuPercent: 1, runnerVmAvailableMemoryBytes: -1,
    }],
  ] as const)("rejects invalid %s schema", async (_name, action, result) => {
    const exchange: ProductionLoadFixtureExchange = vi.fn(async (request) => {
      const value = JSON.parse(request.toString("utf8")) as Record<string, unknown>;
      if (value.action === "assert-ready") {
        const bindingSha256 = createHash("sha256")
          .update(canonical(value.binding)).digest("hex");
        return canonical({ ok: true, result: { bindingSha256, ready: true } });
      }
      return canonical({ ok: true, result });
    });
    const operations = createProductionLoadFixtureUnixOperations({ exchange });
    const signal = new AbortController().signal;
    await operations.assertReady(binding(), signal);
    const operation = action === "isolation-status"
      ? operations.isolationStatus(signal)
      : operations.runnerVmTelemetry(
        "123e4567-e89b-42d3-a456-426614174000", "52:54:00:20:00:12", signal,
      );
    await expect(operation).rejects.toThrow("fixture_operation_failed");
  });
});
