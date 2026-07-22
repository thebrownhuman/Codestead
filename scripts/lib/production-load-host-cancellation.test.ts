import { describe, expect, it, vi } from "vitest";

import { PRODUCTION_LOAD_FAULT_MATRIX } from "../../src/lib/performance/load-report";
import {
  createFailClosedProductionLoadSystemAdapter,
  createGuardedProductionLoadSystemAdapter,
  createProductionLoadHost,
  type ProductionLoadDatabase,
  type ProductionLoadIsolationBackend,
} from "./production-load-host";

const VM_ID = "57b9ab11-f3a4-4ea8-a58e-e73d951f9d11";
const INVENTORY_SHA = "a".repeat(64);

function unusedDatabase(): ProductionLoadDatabase {
  return {
    async query() {
      throw new Error("unexpected database query");
    },
    async transaction(callback) {
      return callback(this);
    },
  };
}

function hostOptions(database: ProductionLoadDatabase, system = createFailClosedProductionLoadSystemAdapter()) {
  return {
    project: "learncoding" as const,
    runnerVmId: VM_ID,
    database,
    system,
    signSessionToken: async () => "signature",
    randomSessionToken: () => "x".repeat(72),
  };
}

describe("production load host cancellation", () => {
  it("passes the request signal into system mutations and returns only a stable abort error", async () => {
    let observedSignal: AbortSignal | undefined;
    const resetFault = vi.fn(async (
      _faultId: unknown,
      _project: unknown,
      _runnerVmId: unknown,
      signal?: AbortSignal,
    ) => {
      observedSignal = signal;
      if (!signal) return;
      await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => {
        reject(new Error("credential=must-not-leak"));
      }, { once: true }));
    });
    const host = createProductionLoadHost(hostOptions(unusedDatabase(), {
      ...createFailClosedProductionLoadSystemAdapter(),
      resetFault,
    }));
    const controller = new AbortController();
    const faultId = PRODUCTION_LOAD_FAULT_MATRIX[0]!.id;

    const pending = host.handle("fault_reset", { faultId }, controller.signal);
    await vi.waitFor(() => expect(resetFault).toHaveBeenCalledOnce());
    controller.abort(new Error("postgresql://user:secret@db/private"));

    await expect(pending).rejects.toThrow(/^Production load host failed: aborted$/);
    expect(observedSignal).toBe(controller.signal);
  });

  it("keeps an uncancellable PostgreSQL query in flight until its bounded driver deadline settles", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const query = vi.fn(async () => {
      await blocked;
      return {
        rows: [{ admission_ms: 25, queue_wait_ms: 120, duplicate_official_effects: 0 }],
      };
    });
    const database: ProductionLoadDatabase = {
      async query<T>() {
        const result = await query();
        return {
          rows: result.rows as unknown as readonly T[],
        };
      },
      async transaction(callback) {
        return callback(this);
      },
    };
    const host = createProductionLoadHost(hostOptions(database));
    const controller = new AbortController();

    let settled = false;
    const pending = host.handle("runner_observation", {
      requestId: "9ed04017-ae6c-41f4-b839-0ac4e457e3d5",
    }, controller.signal);
    void pending.then(() => { settled = true; }, () => { settled = true; });
    await vi.waitFor(() => expect(query).toHaveBeenCalledOnce());
    controller.abort(new Error("secret reason"));
    await Promise.resolve();
    await Promise.resolve();

    expect(settled).toBe(false);
    release();
    await expect(pending).rejects.toThrow(/^Production load host failed: aborted$/);
  });

  it("threads the same signal through guarded preconditions, mutation, and postconditions", async () => {
    const inspectIsolation = vi.fn(async () => ({
      composeProject: "learncoding" as const,
      runnerVmId: VM_ID,
      runnerVmMac: "52:54:00:20:00:12",
      repositoryRoot: "/opt/learncoding",
      runnerStateRoot: "/var/lib/learncoding-runner",
      maintenanceWindowApproved: true,
      freshRecoveryPoint: true,
      unrelatedInventorySha256: INVENTORY_SHA,
    }));
    const resetFault = vi.fn(async () => undefined);
    const backend: ProductionLoadIsolationBackend = {
      ...createFailClosedProductionLoadSystemAdapter(),
      inspectIsolation,
      resetFault,
    };
    const guarded = createGuardedProductionLoadSystemAdapter({
      expectedProject: "learncoding",
      expectedRunnerVmId: VM_ID,
      expectedUnrelatedInventorySha256: INVENTORY_SHA,
      backend,
    });
    const signal = new AbortController().signal;
    const faultId = PRODUCTION_LOAD_FAULT_MATRIX[0]!.id;

    await guarded.resetFault(faultId, "learncoding", VM_ID, signal);

    expect(inspectIsolation).toHaveBeenNthCalledWith(1, signal);
    expect(resetFault).toHaveBeenCalledWith(faultId, "learncoding", VM_ID, signal);
    expect(inspectIsolation).toHaveBeenNthCalledWith(2, signal);
  });
});
