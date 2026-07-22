import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ProductionLoadSystemAdapter } from "./production-load-host";
import {
  createJournaledProductionLoadSystemAdapter,
} from "./production-load-journaled-system";

const VM_ID = "57b9ab11-f3a4-4ea8-a58e-e73d951f9d11";
const RUN_ID = `sha256:${"a".repeat(64)}`;
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function privateRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "codestead-journaled-system-"));
  roots.push(root);
  if (process.platform !== "win32") await chmod(root, 0o700);
  return root;
}

function delegate(overrides: Partial<ProductionLoadSystemAdapter> = {}): ProductionLoadSystemAdapter {
  return {
    captureHost: vi.fn(async () => ({
      hostCpuPercent: 1,
      availableMemoryBytes: 16 * 1024 ** 3,
      rootFreeFraction: 0.5,
      rootFreeBytes: 1_000,
      diskReadBytes: 0,
      diskWriteBytes: 0,
      temperatureCelsius: 45,
      oomKills: 0,
      thermalThrottleIncrements: 0,
    })),
    captureRunnerVm: vi.fn(async () => ({
      runnerVmCpuPercent: 1,
      runnerVmAvailableMemoryBytes: 4 * 1024 ** 3,
    })),
    unrelatedServicesHealthy: vi.fn(async () => true),
    resetFault: vi.fn(async () => undefined),
    probeFault: vi.fn(async () => ({ componentHealthy: true, alertOrDeadLetterVisible: true })),
    injectAndReleaseFault: vi.fn(async () => undefined),
    runBrowserJourney: vi.fn(async () => undefined),
    captureFaultInvariantEvidence: vi.fn(async (faultId, project, runnerVmId) => ({
      source: "isolated-production-load-backend-v1" as const,
      faultId,
      project,
      runnerVmId,
      observedAt: "2026-07-20T04:05:06.007Z",
      acknowledgedMutationFailures: 0,
      runnerMaxConcurrentJobs: 2,
      secretLeakFindings: 0,
    })),
    ...overrides,
  };
}

async function create(overrides: Partial<ProductionLoadSystemAdapter> = {}) {
  const journalRoot = await privateRoot();
  const inner = delegate(overrides);
  const journalAccess = {
    journalRoot,
    project: "learncoding" as const,
    runnerVmId: VM_ID,
    candidateRunIdentitySha256: RUN_ID,
  };
  return {
    inner,
    journalRoot,
    ...createJournaledProductionLoadSystemAdapter({
      delegate: inner,
      journalAccess,
      now: () => new Date("2026-07-20T04:05:06.007Z"),
    }),
  };
}

describe("journaled production load system adapter", () => {
  it("durably publishes fault intent before mutation and clears it only after success", async () => {
    let bytesDuringMutation = "";
    const setup = await create({
      async injectAndReleaseFault() {
        bytesDuringMutation = await readFile(
          path.join(setup.journalRoot, "production-load-fault-journal.json"),
          "utf8",
        );
      },
    });

    await setup.system.injectAndReleaseFault("app_container_restart", "learncoding", VM_ID);

    expect(bytesDuringMutation).toContain('"faultId": "app_container_restart"');
    await expect(readFile(
      path.join(setup.journalRoot, "production-load-fault-journal.json"),
    )).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves active evidence when mutation fails", async () => {
    const setup = await create({
      injectAndReleaseFault: vi.fn(async () => {
        throw new Error("sensitive backend detail");
      }),
    });

    await expect(setup.system.injectAndReleaseFault(
      "runner_service_restart",
      "learncoding",
      VM_ID,
    )).rejects.toThrow("Production load journaled system failed: mutation_failed");

    const bytes = await readFile(
      path.join(setup.journalRoot, "production-load-fault-journal.json"),
      "utf8",
    );
    expect(bytes).toContain('"faultId": "runner_service_restart"');
    expect(bytes).not.toContain("sensitive backend detail");
  });

  it("recovers an interrupted mutation before listen only after reset and health verification", async () => {
    const setup = await create();
    vi.mocked(setup.inner.injectAndReleaseFault).mockRejectedValueOnce(new Error("crash"));
    await expect(setup.system.injectAndReleaseFault(
      "email_worker_restart",
      "learncoding",
      VM_ID,
    )).rejects.toThrow(/mutation_failed/);

    await expect(setup.recoverBeforeListen()).resolves.toEqual({ status: "recovered" });

    expect(setup.inner.resetFault).toHaveBeenCalledWith(
      "email_worker_restart",
      "learncoding",
      VM_ID,
    );
    expect(setup.inner.probeFault).toHaveBeenCalledWith(
      "email_worker_restart",
      "recovery",
      "learncoding",
      VM_ID,
    );
    expect(setup.inner.unrelatedServicesHealthy).toHaveBeenCalledWith("learncoding");
  });

  it("preserves interrupted evidence when startup recovery is not healthy", async () => {
    const setup = await create({
      injectAndReleaseFault: vi.fn(async () => { throw new Error("crash"); }),
      probeFault: vi.fn(async () => ({ componentHealthy: false, alertOrDeadLetterVisible: true })),
    });
    await expect(setup.system.injectAndReleaseFault(
      "app_container_restart",
      "learncoding",
      VM_ID,
    )).rejects.toThrow(/mutation_failed/);

    await expect(setup.recoverBeforeListen()).rejects.toThrow(
      "Production load journaled system failed: recovery_verification_failed",
    );
    await expect(readFile(
      path.join(setup.journalRoot, "production-load-fault-journal.json"),
    )).resolves.toBeInstanceOf(Buffer);
  });

  it("serializes concurrent fault mutations so only one active journal exists", async () => {
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const setup = await create({
      async injectAndReleaseFault(faultId) {
        events.push(`start:${faultId}`);
        if (faultId === "app_container_restart") await firstBlocked;
        events.push(`end:${faultId}`);
      },
    });

    const first = setup.system.injectAndReleaseFault("app_container_restart", "learncoding", VM_ID);
    await vi.waitFor(() => expect(events).toEqual(["start:app_container_restart"]));
    const second = setup.system.injectAndReleaseFault("email_worker_restart", "learncoding", VM_ID);
    await Promise.resolve();
    expect(events).toEqual(["start:app_container_restart"]);
    releaseFirst();

    await Promise.all([first, second]);
    expect(events).toEqual([
      "start:app_container_restart",
      "end:app_container_restart",
      "start:email_worker_restart",
      "end:email_worker_restart",
    ]);
  });

  it("refuses identities outside the configured project and runner VM before journaling", async () => {
    const setup = await create();

    await expect(setup.system.injectAndReleaseFault(
      "app_container_restart",
      "learncoding",
      "0fda0388-a0e5-410b-ac5e-9feb25f1daf2",
    )).rejects.toThrow("Production load journaled system failed: identity_mismatch");
    expect(setup.inner.injectAndReleaseFault).not.toHaveBeenCalled();
  });
});
