import { describe, expect, it, vi } from "vitest";

import { buildProductionLoadSeedPlan } from "../../src/lib/performance/load-report";
import {
  createGuardedProductionLoadSystemAdapter,
  createProductionLoadHost,
  type ProductionLoadDatabase,
  type ProductionLoadDatabaseSession,
  type ProductionLoadIsolationBackend,
} from "./production-load-host";

const VM_ID = "57b9ab11-f3a4-4ea8-a58e-e73d951f9d11";
const INVENTORY = "a".repeat(64);

function isolation(overrides: Partial<Awaited<ReturnType<ProductionLoadIsolationBackend["inspectIsolation"]>>> = {}) {
  return {
    composeProject: "learncoding",
    runnerVmId: VM_ID,
    runnerVmMac: "52:54:00:20:00:12",
    repositoryRoot: "/opt/learncoding",
    runnerStateRoot: "/var/lib/learncoding-runner",
    maintenanceWindowApproved: true,
    freshRecoveryPoint: true,
    unrelatedInventorySha256: INVENTORY,
    ...overrides,
  };
}

function backend(): ProductionLoadIsolationBackend {
  return {
    inspectIsolation: vi.fn(async () => isolation()),
    captureHost: vi.fn(async () => ({
      hostCpuPercent: 1, availableMemoryBytes: 16 * 1024 ** 3,
      rootFreeFraction: 0.5, rootFreeBytes: 100, diskReadBytes: 0,
      diskWriteBytes: 0, temperatureCelsius: 50, oomKills: 0,
      thermalThrottleIncrements: 0,
    })),
    captureRunnerVm: vi.fn(async () => ({ runnerVmCpuPercent: 1, runnerVmAvailableMemoryBytes: 1024 })),
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
      observedAt: "2026-07-19T12:00:00.000Z",
      acknowledgedMutationFailures: 0,
      runnerMaxConcurrentJobs: 2,
      secretLeakFindings: 0,
    })),
  };
}

describe("production load project isolation guard", () => {
  it("permits a project-scoped mutation only after the exact identity and recovery preconditions pass", async () => {
    const delegate = backend();
    const guarded = createGuardedProductionLoadSystemAdapter({
      expectedProject: "learncoding",
      expectedRunnerVmId: VM_ID,
      expectedUnrelatedInventorySha256: INVENTORY,
      backend: delegate,
    });

    await guarded.injectAndReleaseFault("app_container_restart", "learncoding", VM_ID);

    expect(delegate.inspectIsolation).toHaveBeenCalledTimes(2);
    expect(delegate.injectAndReleaseFault).toHaveBeenCalledWith(
      "app_container_restart", "learncoding", VM_ID,
    );
  });

  it("guards and delegates the exact read-only invariant evidence identity", async () => {
    const delegate = backend();
    const guarded = createGuardedProductionLoadSystemAdapter({
      expectedProject: "learncoding",
      expectedRunnerVmId: VM_ID,
      expectedUnrelatedInventorySha256: INVENTORY,
      backend: delegate,
    });

    await guarded.captureFaultInvariantEvidence("app_container_restart", "learncoding", VM_ID);

    expect(delegate.inspectIsolation).toHaveBeenCalledOnce();
    expect(delegate.captureFaultInvariantEvidence).toHaveBeenCalledWith(
      "app_container_restart", "learncoding", VM_ID,
    );
  });
  it.each([
    ["composeProject", "other"],
    ["runnerVmId", "0fda0388-a0e5-410b-ac5e-9feb25f1daf2"],
    ["runnerVmMac", "52:54:00:00:00:01"],
    ["repositoryRoot", "/"],
    ["runnerStateRoot", "/tmp/runner"],
    ["maintenanceWindowApproved", false],
    ["freshRecoveryPoint", false],
    ["unrelatedInventorySha256", "b".repeat(64)],
  ] as const)("refuses mutation when %s drifts", async (field, value) => {
    const delegate = backend();
    vi.mocked(delegate.inspectIsolation).mockResolvedValue(isolation({ [field]: value }));
    const guarded = createGuardedProductionLoadSystemAdapter({
      expectedProject: "learncoding", expectedRunnerVmId: VM_ID,
      expectedUnrelatedInventorySha256: INVENTORY, backend: delegate,
    });

    await expect(guarded.injectAndReleaseFault(
      "app_container_restart", "learncoding", VM_ID,
    )).rejects.toThrow(/isolation_precondition_failed/);
    expect(delegate.injectAndReleaseFault).not.toHaveBeenCalled();
  });

  it("refuses a mutation if unrelated inventory changes after fault release", async () => {
    const delegate = backend();
    vi.mocked(delegate.inspectIsolation)
      .mockResolvedValueOnce(isolation())
      .mockResolvedValueOnce(isolation({ unrelatedInventorySha256: "b".repeat(64) }));
    const guarded = createGuardedProductionLoadSystemAdapter({
      expectedProject: "learncoding", expectedRunnerVmId: VM_ID,
      expectedUnrelatedInventorySha256: INVENTORY, backend: delegate,
    });

    await expect(guarded.injectAndReleaseFault(
      "app_container_restart", "learncoding", VM_ID,
    )).rejects.toThrow(/isolation_postcondition_failed/);
  });
});

function collisionDatabase(existing: { id: string; email: string }[] = []) {
  const statements: string[] = [];
  const session: ProductionLoadDatabaseSession = {
    async query<T>(text: string) {
      statements.push(text);
      if (text.includes("production_load_namespace")) return { rows: existing as T[] };
      return { rows: [] as T[] };
    },
  };
  const database: ProductionLoadDatabase = {
    query: session.query,
    async transaction<T>(callback: (client: ProductionLoadDatabaseSession) => Promise<T>) {
      statements.push("BEGIN");
      try {
        const result = await callback(session);
        statements.push("COMMIT");
        return result;
      } catch (error) {
        statements.push("ROLLBACK");
        throw error;
      }
    },
  };
  return { database, statements };
}

describe("production load seed namespace", () => {
  it("refuses an existing identity whose id/email pair is outside the exact synthetic namespace before deletion", async () => {
    const plan = buildProductionLoadSeedPlan();
    const { database, statements } = collisionDatabase([{
      id: plan.learners[0]!.id,
      email: "real-person@example.com",
    }]);
    const host = createProductionLoadHost({
      project: "learncoding", runnerVmId: VM_ID, database,
      system: createGuardedProductionLoadSystemAdapter({
        expectedProject: "learncoding", expectedRunnerVmId: VM_ID,
        expectedUnrelatedInventorySha256: INVENTORY, backend: backend(),
      }),
      signSessionToken: async () => "signature",
      randomSessionToken: () => "x".repeat(72),
    });

    await expect(host.handle("seed", plan)).rejects.toThrow(/seed_failed/);
    expect(statements.some((statement) => /^delete from/i.test(statement))).toBe(false);
    expect(statements.at(-1)).toBe("ROLLBACK");
  });
});
