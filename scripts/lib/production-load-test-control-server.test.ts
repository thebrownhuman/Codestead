import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  createProductionLoadTestControlDispatcher,
  startProductionLoadTestControlUnixServer,
  validateProductionLoadTestControlSocket,
  validateProductionLoadTestControlRuntimeDirectory,
  validateProductionLoadTestControlSocketDirectory,
  type ProductionLoadTestControlAdapter,
  type ProductionLoadTestControlRequest,
} from "./production-load-test-control-server";

const VM_ID = "57b9ab11-f3a4-4ea8-a58e-e73d951f9d11";
const RUN_ID = "sha256:" + "a".repeat(64);

function canonical(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value) + "\n", "utf8");
}

function testControlRequest(
  action: "inject-and-release" | "reset" = "inject-and-release",
  faultId = "fake_gmail_failure",
): Buffer {
  return canonical({
    version: 1,
    action,
    faultId,
    target: { kind: "test-control", control: faultId },
    project: "learncoding",
    runnerVmId: VM_ID,
    runnerVmMac: "52:54:00:20:00:12",
  });
}

function dispatcher(adapter: ProductionLoadTestControlAdapter, timeoutMs = 1_000) {
  return createProductionLoadTestControlDispatcher({
    adapter,
    authority: {
      candidateRunIdentitySha256: RUN_ID,
      project: "learncoding",
      runnerVmId: VM_ID,
      runnerVmMac: "52:54:00:20:00:12",
    },
    maximumConcurrentRequests: 2,
    requestTimeoutMs: timeoutMs,
  });
}

describe("production load test-control protocol", () => {
  it("authorizes one canonical root request and gives the adapter a run-bound request id", async () => {
    const handle = vi.fn(async () => ({
      hostCpuPercent: 4.5,
      availableMemoryBytes: 1024,
      rootFreeFraction: 0.8,
      rootFreeBytes: 2048,
      diskReadBytes: 3,
      diskWriteBytes: 4,
      temperatureCelsius: 51,
      oomKills: 0,
      thermalThrottleIncrements: 0,
    }));
    const body = canonical({ version: 1, action: "host-telemetry", project: "learncoding" });

    await expect(dispatcher({ handle }).dispatch({ body, peerUid: 0 })).resolves.toEqual(
      canonical({
        ok: true,
        result: {
          hostCpuPercent: 4.5,
          availableMemoryBytes: 1024,
          rootFreeFraction: 0.8,
          rootFreeBytes: 2048,
          diskReadBytes: 3,
          diskWriteBytes: 4,
          temperatureCelsius: 51,
          oomKills: 0,
          thermalThrottleIncrements: 0,
        },
      }),
    );
    expect(handle).toHaveBeenCalledWith(
      { version: 1, action: "host-telemetry", project: "learncoding" },
      expect.objectContaining({
        requestId: createHash("sha256").update(RUN_ID + "\0").update(body).digest("hex"),
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("revalidates approved run authority before and after every adapter call", async () => {
    const handle = vi.fn(async () => ({
      hostCpuPercent: 4.5, availableMemoryBytes: 1024, rootFreeFraction: 0.8,
      rootFreeBytes: 2048, diskReadBytes: 3, diskWriteBytes: 4,
      temperatureCelsius: 51, oomKills: 0, thermalThrottleIncrements: 0,
    }));
    const assertAuthority = vi.fn(async () => {
      throw new Error("decision changed; token=must-not-escape");
    });
    const service = createProductionLoadTestControlDispatcher({
      adapter: { handle },
      authority: {
        candidateRunIdentitySha256: RUN_ID,
        project: "learncoding", runnerVmId: VM_ID,
        runnerVmMac: "52:54:00:20:00:12",
      },
      assertAuthority,
      maximumConcurrentRequests: 2,
      requestTimeoutMs: 1_000,
    });

    const response = await service.dispatch({
      body: canonical({ version: 1, action: "host-telemetry", project: "learncoding" }),
      peerUid: 0,
    });
    expect(response).toEqual(canonical({ ok: false, result: null }));
    expect(handle).not.toHaveBeenCalled();
    expect(assertAuthority).toHaveBeenCalledTimes(1);
    expect(response.toString("utf8")).not.toMatch(/decision|token/i);
  });

  it("rejects non-root peers, noncanonical bytes, wrong identity, target drift, and extra fields", async () => {
    const handle = vi.fn(async () => null);
    const dispatch = dispatcher({ handle }).dispatch;
    const invalid = [
      { body: testControlRequest(), peerUid: 1000 },
      { body: Buffer.from(testControlRequest().toString("utf8").replaceAll(":", ": ")), peerUid: 0 },
      { body: canonical({
        version: 1,
        action: "inject-and-release",
        faultId: "fake_gmail_failure",
        target: { kind: "test-control", control: "fake_ai_provider_failure" },
        project: "learncoding",
        runnerVmId: VM_ID,
        runnerVmMac: "52:54:00:20:00:12",
      }), peerUid: 0 },
      { body: canonical({
        version: 1,
        action: "inject-and-release",
        faultId: "fake_gmail_failure",
        target: { kind: "test-control", control: "fake_gmail_failure" },
        project: "other",
        runnerVmId: VM_ID,
        runnerVmMac: "52:54:00:20:00:12",
      }), peerUid: 0 },
      { body: canonical({
        version: 1,
        action: "host-telemetry",
        project: "learncoding",
        authorization: "Bearer do-not-log",
      }), peerUid: 0 },
      { body: Buffer.alloc(64 * 1024 + 1, 0x61), peerUid: 0 },
    ];

    for (const request of invalid) {
      await expect(dispatch(request)).resolves.toEqual(canonical({ ok: false, result: null }));
    }
    expect(handle).not.toHaveBeenCalled();
  });

  it("makes mutation retries idempotent until the opposite transition succeeds", async () => {
    const seen: string[] = [];
    const handle = vi.fn(async (request: ProductionLoadTestControlRequest) => {
      seen.push(request.action);
      return null;
    });
    const dispatch = dispatcher({ handle }).dispatch;

    await dispatch({ body: testControlRequest("inject-and-release"), peerUid: 0 });
    await dispatch({ body: testControlRequest("inject-and-release"), peerUid: 0 });
    await dispatch({ body: testControlRequest("reset"), peerUid: 0 });
    await dispatch({ body: testControlRequest("reset"), peerUid: 0 });
    await dispatch({ body: testControlRequest("inject-and-release"), peerUid: 0 });

    expect(seen).toEqual(["inject-and-release", "reset", "inject-and-release"]);
  });

  it("coalesces concurrent duplicate mutations under one request id", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const handle = vi.fn(async () => {
      await blocked;
      return null;
    });
    const dispatch = dispatcher({ handle }).dispatch;
    const request = { body: testControlRequest(), peerUid: 0 };

    const first = dispatch(request);
    const second = dispatch(request);
    await Promise.resolve();
    expect(handle).toHaveBeenCalledTimes(1);
    release();
    await expect(Promise.all([first, second])).resolves.toEqual([
      canonical({ ok: true, result: null }),
      canonical({ ok: true, result: null }),
    ]);
  });

  it("serializes opposite transitions for the same fault until the adapter settles", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const handle = vi.fn(async (request: ProductionLoadTestControlRequest) => {
      if (request.action === "inject-and-release") await blocked;
      return null;
    });
    const dispatch = dispatcher({ handle }).dispatch;
    const inject = dispatch({
      body: testControlRequest("inject-and-release"), peerUid: 0,
    });
    await Promise.resolve();

    await expect(dispatch({
      body: testControlRequest("reset"), peerUid: 0,
    })).resolves.toEqual(canonical({ ok: false, result: null }));
    expect(handle).toHaveBeenCalledTimes(1);

    release();
    await expect(inject).resolves.toEqual(canonical({ ok: true, result: null }));
    await expect(dispatch({
      body: testControlRequest("reset"), peerUid: 0,
    })).resolves.toEqual(canonical({ ok: true, result: null }));
    expect(handle).toHaveBeenCalledTimes(2);
  });

  it("does not replay an adapter-rejected injection but permits its safe reset", async () => {
    const handle = vi.fn(async (request: ProductionLoadTestControlRequest) => {
      if (request.action === "inject-and-release") throw new Error("secret");
      return null;
    });
    const dispatch = dispatcher({ handle }).dispatch;

    await expect(dispatch({ body: testControlRequest(), peerUid: 0 })).resolves.toEqual(
      canonical({ ok: false, result: null }),
    );
    await expect(dispatch({ body: testControlRequest(), peerUid: 0 })).resolves.toEqual(
      canonical({ ok: false, result: null }),
    );
    await expect(dispatch({ body: testControlRequest("reset"), peerUid: 0 })).resolves.toEqual(
      canonical({ ok: true, result: null }),
    );
    expect(handle).toHaveBeenCalledTimes(2);
  });

  it("blocks injection after an indeterminate reset while allowing the reset retry", async () => {
    let resetAttempts = 0;
    const handle = vi.fn(async (request: ProductionLoadTestControlRequest) => {
      if (request.action === "reset" && resetAttempts++ === 0) throw new Error("unknown");
      return null;
    });
    const dispatch = dispatcher({ handle }).dispatch;

    await dispatch({ body: testControlRequest("reset"), peerUid: 0 });
    await expect(dispatch({ body: testControlRequest(), peerUid: 0 })).resolves.toEqual(
      canonical({ ok: false, result: null }),
    );
    await expect(dispatch({ body: testControlRequest("reset"), peerUid: 0 })).resolves.toEqual(
      canonical({ ok: true, result: null }),
    );
    await expect(dispatch({ body: testControlRequest(), peerUid: 0 })).resolves.toEqual(
      canonical({ ok: true, result: null }),
    );
    expect(handle).toHaveBeenCalledTimes(3);
  });

  it("does not replay an indeterminate mutation after its caller deadline", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const handle = vi.fn(async () => {
      await blocked;
      return null;
    });
    const dispatch = dispatcher({ handle }, 25).dispatch;
    const request = { body: testControlRequest(), peerUid: 0 };

    await expect(dispatch(request)).resolves.toEqual(canonical({ ok: false, result: null }));
    await expect(dispatch(request)).resolves.toEqual(canonical({ ok: false, result: null }));
    expect(handle).toHaveBeenCalledTimes(1);
    release();
  });

  it("bounds concurrency and propagates deadline cancellation without releasing a slot early", async () => {
    let aborted = false;
    const handle = vi.fn(async (_request: ProductionLoadTestControlRequest, context) => {
      await new Promise<void>((resolve) => {
        context.signal.addEventListener("abort", () => {
          aborted = true;
          resolve();
        }, { once: true });
      });
      throw new Error("provider-secret=must-not-escape");
    });
    const service = createProductionLoadTestControlDispatcher({
      adapter: { handle },
      authority: {
        candidateRunIdentitySha256: RUN_ID,
        project: "learncoding",
        runnerVmId: VM_ID,
        runnerVmMac: "52:54:00:20:00:12",
      },
      maximumConcurrentRequests: 1,
      requestTimeoutMs: 25,
    });
    const first = service.dispatch({
      body: canonical({ version: 1, action: "host-telemetry", project: "learncoding" }),
      peerUid: 0,
    });
    await Promise.resolve();
    await expect(service.dispatch({
      body: canonical({ version: 1, action: "host-telemetry", project: "learncoding" }),
      peerUid: 0,
    })).resolves.toEqual(canonical({ ok: false, result: null }));
    const response = await first;
    expect(aborted).toBe(true);
    expect(response).toEqual(canonical({ ok: false, result: null }));
    expect(response.toString("utf8")).not.toMatch(/provider|secret/i);
  });

  it("validates the exact browser request and response without accepting URLs or credentials", async () => {
    const handle = vi.fn(async () => ({
      ok: true,
      faultId: "fake_ai_provider_failure",
      stage: "recovered",
    }));
    const body = canonical({
      version: 1,
      action: "browser-journey",
      faultId: "fake_ai_provider_failure",
      stage: "recovered",
      project: "learncoding",
    });

    await expect(dispatcher({ handle }).dispatch({ body, peerUid: 0 })).resolves.toEqual(
      canonical({
        ok: true,
        result: { ok: true, faultId: "fake_ai_provider_failure", stage: "recovered" },
      }),
    );
    expect(body.toString("utf8")).not.toMatch(/https?:|cookie|token|password|authorization/i);
  });

  it.each([
    {
      name: "fixed isolation roots and VM identity",
      request: {
        version: 1, action: "isolation-status", project: "learncoding",
        repositoryRoot: "/opt/learncoding",
        runnerStateRoot: "/var/lib/learncoding-runner",
        runnerVmId: VM_ID, runnerVmMac: "52:54:00:20:00:12",
      },
      result: { maintenanceWindowApproved: true, freshRecoveryPoint: false },
    },
    {
      name: "runner VM telemetry",
      request: {
        version: 1, action: "runner-vm-telemetry", runnerDomain: "codestead-runner",
        runnerVmId: VM_ID, runnerVmMac: "52:54:00:20:00:12",
      },
      result: { runnerVmCpuPercent: 12.5, runnerVmAvailableMemoryBytes: 4096 },
    },
    {
      name: "baseline compose-service probe",
      request: {
        version: 1, action: "probe", faultId: "app_container_restart",
        target: { kind: "compose-service", service: "app" }, phase: "baseline",
        project: "learncoding", runnerVmId: VM_ID, runnerVmMac: "52:54:00:20:00:12",
      },
      result: { componentHealthy: true, alertOrDeadLetterVisible: false },
    },
    {
      name: "recovery runner-service probe",
      request: {
        version: 1, action: "probe", faultId: "runner_service_restart",
        target: {
          kind: "runner-service", domain: "codestead-runner",
          unit: "learncoding-runner.service",
        },
        phase: "recovery", project: "learncoding",
        runnerVmId: VM_ID, runnerVmMac: "52:54:00:20:00:12",
      },
      result: { componentHealthy: false, alertOrDeadLetterVisible: true },
    },
    {
      name: "test-control invariant evidence",
      request: {
        version: 1, action: "invariant-evidence", faultId: "fake_offsite_drive_failure",
        target: { kind: "test-control", control: "fake_offsite_drive_failure" },
        project: "learncoding", runnerVmId: VM_ID, runnerVmMac: "52:54:00:20:00:12",
      },
      result: {
        observedAt: "2026-07-20T00:00:00.000Z", acknowledgedMutationFailures: 0,
        runnerMaxConcurrentJobs: 2, secretLeakFindings: 0,
      },
    },
  ])("accepts the canonical $name contract", async ({ request, result }) => {
    const handle = vi.fn(async () => result);
    await expect(dispatcher({ handle }).dispatch({
      body: canonical(request), peerUid: 0,
    })).resolves.toEqual(canonical({ ok: true, result }));
    expect(handle).toHaveBeenCalledWith(request, expect.objectContaining({
      requestId: expect.stringMatching(/^[0-9a-f]{64}$/),
      signal: expect.any(AbortSignal),
    }));
  });

  it.each([
    [
      "mutation result must be null",
      testControlRequest(),
      { unexpected: true },
    ],
    [
      "isolation result must be an exact object",
      canonical({
        version: 1, action: "isolation-status", project: "learncoding",
        repositoryRoot: "/opt/learncoding", runnerStateRoot: "/var/lib/learncoding-runner",
        runnerVmId: VM_ID, runnerVmMac: "52:54:00:20:00:12",
      }),
      { maintenanceWindowApproved: true, freshRecoveryPoint: false, extra: false },
    ],
    [
      "isolation flags must be boolean",
      canonical({
        version: 1, action: "isolation-status", project: "learncoding",
        repositoryRoot: "/opt/learncoding", runnerStateRoot: "/var/lib/learncoding-runner",
        runnerVmId: VM_ID, runnerVmMac: "52:54:00:20:00:12",
      }),
      { maintenanceWindowApproved: "yes", freshRecoveryPoint: false },
    ],
    [
      "status result must be an object",
      canonical({
        version: 1, action: "isolation-status", project: "learncoding",
        repositoryRoot: "/opt/learncoding", runnerStateRoot: "/var/lib/learncoding-runner",
        runnerVmId: VM_ID, runnerVmMac: "52:54:00:20:00:12",
      }),
      null,
    ],
    [
      "runner CPU must be bounded",
      canonical({
        version: 1, action: "runner-vm-telemetry", runnerDomain: "codestead-runner",
        runnerVmId: VM_ID, runnerVmMac: "52:54:00:20:00:12",
      }),
      { runnerVmCpuPercent: 101, runnerVmAvailableMemoryBytes: 1024 },
    ],
    [
      "runner memory must be a nonnegative safe integer",
      canonical({
        version: 1, action: "runner-vm-telemetry", runnerDomain: "codestead-runner",
        runnerVmId: VM_ID, runnerVmMac: "52:54:00:20:00:12",
      }),
      { runnerVmCpuPercent: 1, runnerVmAvailableMemoryBytes: -1 },
    ],
    [
      "probe health must be boolean",
      canonical({
        version: 1, action: "probe", faultId: "runner_service_restart",
        target: { kind: "runner-service", domain: "codestead-runner", unit: "learncoding-runner.service" },
        phase: "baseline", project: "learncoding",
        runnerVmId: VM_ID, runnerVmMac: "52:54:00:20:00:12",
      }),
      { componentHealthy: 1, alertOrDeadLetterVisible: false },
    ],
    [
      "probe visibility must be boolean",
      canonical({
        version: 1, action: "probe", faultId: "runner_service_restart",
        target: { kind: "runner-service", domain: "codestead-runner", unit: "learncoding-runner.service" },
        phase: "baseline", project: "learncoding",
        runnerVmId: VM_ID, runnerVmMac: "52:54:00:20:00:12",
      }),
      { componentHealthy: true, alertOrDeadLetterVisible: 0 },
    ],
    [
      "invariant timestamp must be canonical",
      canonical({
        version: 1, action: "invariant-evidence", faultId: "fake_gmail_failure",
        target: { kind: "test-control", control: "fake_gmail_failure" },
        project: "learncoding", runnerVmId: VM_ID, runnerVmMac: "52:54:00:20:00:12",
      }),
      { observedAt: "not-a-time", acknowledgedMutationFailures: 0,
        runnerMaxConcurrentJobs: 2, secretLeakFindings: 0 },
    ],
    [
      "invariant counters must be safe integers",
      canonical({
        version: 1, action: "invariant-evidence", faultId: "fake_gmail_failure",
        target: { kind: "test-control", control: "fake_gmail_failure" },
        project: "learncoding", runnerVmId: VM_ID, runnerVmMac: "52:54:00:20:00:12",
      }),
      { observedAt: "2026-07-20T00:00:00.000Z", acknowledgedMutationFailures: -1,
        runnerMaxConcurrentJobs: 2, secretLeakFindings: 0 },
    ],
    [
      "browser result must match the requested journey",
      canonical({
        version: 1, action: "browser-journey", faultId: "fake_ai_provider_failure",
        stage: "steady", project: "learncoding",
      }),
      { ok: true, faultId: "fake_gmail_failure", stage: "steady" },
    ],
  ] as const)("fails closed when %s", async (_name, body, result) => {
    const handle = vi.fn(async () => result);
    await expect(dispatcher({ handle }).dispatch({ body, peerUid: 0 })).resolves.toEqual(
      canonical({ ok: false, result: null }),
    );
  });

  it("fails closed when authority is revoked after the adapter returns", async () => {
    const assertAuthority = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("revoked secret=must-not-escape"));
    const handle = vi.fn(async () => ({
      hostCpuPercent: 1, availableMemoryBytes: 1, rootFreeFraction: 1,
      rootFreeBytes: 1, diskReadBytes: 0, diskWriteBytes: 0,
      temperatureCelsius: 20, oomKills: 0, thermalThrottleIncrements: 0,
    }));
    const service = createProductionLoadTestControlDispatcher({
      adapter: { handle },
      authority: {
        candidateRunIdentitySha256: RUN_ID, project: "learncoding",
        runnerVmId: VM_ID, runnerVmMac: "52:54:00:20:00:12",
      },
      assertAuthority, maximumConcurrentRequests: 2, requestTimeoutMs: 1_000,
    });
    const response = await service.dispatch({
      body: canonical({ version: 1, action: "host-telemetry", project: "learncoding" }),
      peerUid: 0,
    });
    expect(response).toEqual(canonical({ ok: false, result: null }));
    expect(handle).toHaveBeenCalledTimes(1);
    expect(assertAuthority).toHaveBeenCalledTimes(2);
    expect(response.toString("utf8")).not.toMatch(/revoked|secret/i);
  });

  it("honors pre-aborted and adapter-time cancellation", async () => {
    const preAborted = new AbortController();
    preAborted.abort();
    const untouched = vi.fn(async () => null);
    await expect(dispatcher({ handle: untouched }).dispatch({
      body: testControlRequest(), peerUid: 0, signal: preAborted.signal,
    })).resolves.toEqual(canonical({ ok: false, result: null }));
    expect(untouched).not.toHaveBeenCalled();

    const duringAdapter = new AbortController();
    const handle = vi.fn(async () => {
      duringAdapter.abort();
      return null;
    });
    await expect(dispatcher({ handle }).dispatch({
      body: testControlRequest("reset"), peerUid: 0, signal: duringAdapter.signal,
    })).resolves.toEqual(canonical({ ok: false, result: null }));
    expect(handle).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["concurrency", { maximumConcurrentRequests: 0, requestTimeoutMs: 1 }],
    ["concurrency", { maximumConcurrentRequests: 3, requestTimeoutMs: 1 }],
    ["timeout", { maximumConcurrentRequests: 1, requestTimeoutMs: 0 }],
    ["timeout", { maximumConcurrentRequests: 1, requestTimeoutMs: 125_001 }],
  ] as const)("rejects out-of-range %s configuration", (_name, limits) => {
    expect(() => createProductionLoadTestControlDispatcher({
      adapter: { async handle() { return null; } },
      authority: {
        candidateRunIdentitySha256: RUN_ID, project: "learncoding",
        runnerVmId: VM_ID, runnerVmMac: "52:54:00:20:00:12",
      },
      ...limits,
    })).toThrow(/invalid_(?:concurrency|timeout)/);
  });

  it.each([
    canonical({ version: 1, action: "unknown", project: "learncoding" }),
    canonical({
      version: 1, action: "probe", faultId: "runner_service_restart",
      target: { kind: "runner-service", domain: "codestead-runner", unit: "learncoding-runner.service" },
      phase: "during", project: "learncoding", runnerVmId: VM_ID,
      runnerVmMac: "52:54:00:20:00:12",
    }),
  ])("rejects invalid action or probe phase before the adapter", async (body) => {
    const handle = vi.fn(async () => null);
    await expect(dispatcher({ handle }).dispatch({ body, peerUid: 0 })).resolves.toEqual(
      canonical({ ok: false, result: null }),
    );
    expect(handle).not.toHaveBeenCalled();
  });

  it.each([
    Buffer.alloc(0),
    Buffer.from("{}", "utf8"),
    Buffer.from("{}\r\n", "utf8"),
    Buffer.from("{\"version\":1,\u0000\"action\":\"host-telemetry\"}\n", "utf8"),
    canonical(null),
    canonical([]),
    canonical({ version: 2, action: "host-telemetry", project: "learncoding" }),
    canonical({ version: 1, action: null, project: "learncoding" }),
    canonical({
      version: 1, action: "probe", faultId: "fake_gmail_failure", target: null,
      phase: "baseline", project: "learncoding", runnerVmId: VM_ID,
      runnerVmMac: "52:54:00:20:00:12",
    }),
    canonical({
      version: 1, action: "probe", faultId: "unknown_fault",
      target: { kind: "test-control", control: "unknown_fault" },
      phase: "baseline", project: "learncoding", runnerVmId: VM_ID,
      runnerVmMac: "52:54:00:20:00:12",
    }),
    canonical({
      version: 1, action: "isolation-status", project: "learncoding",
      repositoryRoot: "/tmp/wrong", runnerStateRoot: "/var/lib/learncoding-runner",
      runnerVmId: VM_ID, runnerVmMac: "52:54:00:20:00:12",
    }),
    canonical({
      version: 1, action: "runner-vm-telemetry", runnerDomain: "wrong-domain",
      runnerVmId: VM_ID, runnerVmMac: "52:54:00:20:00:12",
    }),
    canonical({
      version: 1, action: "browser-journey", faultId: "fake_ai_provider_failure",
      stage: "during", project: "learncoding",
    }),
  ])("rejects malformed request framing and envelopes", async (body) => {
    const handle = vi.fn(async () => null);
    await expect(dispatcher({ handle }).dispatch({ body, peerUid: 0 })).resolves.toEqual(
      canonical({ ok: false, result: null }),
    );
    expect(handle).not.toHaveBeenCalled();
  });
});

describe("production load test-control filesystem authority", () => {
  const directory = {
    uid: 0, gid: 991, mode: 0o40750, nlink: 2,
    isDirectory: () => true, isSocket: () => false, isSymbolicLink: () => false,
  };
  const runtimeDirectory = {
    uid: 0, gid: 0, mode: 0o40755, nlink: 2,
    isDirectory: () => true, isSocket: () => false, isSymbolicLink: () => false,
  };
  const socket = {
    uid: 0, gid: 0, mode: 0o140600, nlink: 1,
    isDirectory: () => false, isSocket: () => true, isSymbolicLink: () => false,
  };

  it("accepts only the fixed root-owned private directory and root-only socket", () => {
    expect(() => validateProductionLoadTestControlSocketDirectory(directory, 991)).not.toThrow();
    expect(() => validateProductionLoadTestControlRuntimeDirectory(runtimeDirectory)).not.toThrow();
    expect(() => validateProductionLoadTestControlSocket(socket)).not.toThrow();
    for (const value of [
      { ...directory, uid: 1000 },
      { ...directory, gid: 992 },
      { ...directory, mode: 0o40770 },
      { ...directory, isSymbolicLink: () => true },
    ]) expect(() => validateProductionLoadTestControlSocketDirectory(value, 991)).toThrow();
    for (const value of [
      { ...runtimeDirectory, uid: 1000 },
      { ...runtimeDirectory, gid: 991 },
      { ...runtimeDirectory, mode: 0o40775 },
      { ...runtimeDirectory, isSymbolicLink: () => true },
    ]) expect(() => validateProductionLoadTestControlRuntimeDirectory(value)).toThrow();
    for (const value of [
      { ...socket, uid: 1000 },
      { ...socket, gid: 991 },
      { ...socket, mode: 0o140660 },
      { ...socket, nlink: 2 },
      { ...socket, isSymbolicLink: () => true },
    ]) expect(() => validateProductionLoadTestControlSocket(value)).toThrow();
  });
});

describe("production load test-control Unix listener boundary", () => {
  const authority = {
    candidateRunIdentitySha256: RUN_ID,
    project: "learncoding" as const,
    runnerVmId: VM_ID,
    runnerVmMac: "52:54:00:20:00:12" as const,
  };
  const adapter: ProductionLoadTestControlAdapter = {
    async handle() { return null; },
  };

  it.each([
    ["win32", 0, 0, "linux_root_required"],
    ["linux", 1000, 0, "linux_root_required"],
    ["linux", 0, 1000, "linux_root_required"],
  ] as const)("rejects runtime %s uid=%i gid=%i before touching a socket", async (
    platform, uid, gid, code,
  ) => {
    await expect(startProductionLoadTestControlUnixServer({
      socketPath: "/run/learncoding/codestead-production-load-test-control.sock",
      socketParentGid: 991,
      authority,
      adapter,
      platform,
      uid,
      gid,
    })).rejects.toThrow(code);
  });

  it.each([
    "relative.sock",
    "/",
    "/tmp/bad\n.sock",
    "/run/learncoding/other.sock",
  ])(
    "rejects unsafe socket path %s before filesystem access",
    async (socketPath) => {
      await expect(startProductionLoadTestControlUnixServer({
        socketPath,
        socketParentGid: 991,
        authority,
        adapter,
        platform: "linux", uid: 0, gid: 0,
      })).rejects.toThrow("invalid_socket_path");
    },
  );
});
