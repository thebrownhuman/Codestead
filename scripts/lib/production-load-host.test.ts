import { describe, expect, it, vi } from "vitest";

import {
  buildProductionLoadSeedPlan,
  PRODUCTION_LOAD_FAULT_MATRIX,
} from "../../src/lib/performance/load-report";
import {
  createProductionLoadHost,
  type ProductionLoadDatabase,
  type ProductionLoadDatabaseSession,
  type ProductionLoadSystemAdapter,
} from "./production-load-host";

const NOW = "2026-07-19T12:00:00.000Z";

function database(options: { failOn?: string } = {}) {
  const queries: Array<{ text: string; values: readonly unknown[] }> = [];
  const session: ProductionLoadDatabaseSession = {
    async query<T>(text: string, values: readonly unknown[] = []) {
      queries.push({ text, values });
      if (options.failOn && text.includes(options.failOn)) {
        throw new Error("postgres password=must-not-leak");
      }
      if (text.includes("pg_stat_database")) {
        return { rows: [{ connections: 7, deadlocks: 2, lock_wait_ms: 11 }] as T[] };
      }
      if (text.includes("current_setting('max_connections')")) {
        return { rows: [{ max_connections: 100 }] as T[] };
      }
      if (text.includes("runner_job") && text.includes("queue_depth")) {
        return { rows: [{ queue_depth: 3, running_jobs: 2, oldest_queue_wait_ms: 1500, max_observed_queue_wait_ms: 1700 }] as T[] };
      }
      if (text.includes("load_invariant")) {
        return { rows: [{ acknowledged_mutation_failures: 0, duplicate_official_effects: 0, runner_max_concurrent_jobs: 2 }] as T[] };
      }
      if (text.includes("code_submission") && text.includes("request_id")) {
        return { rows: [{ admission_ms: 25, queue_wait_ms: 120, duplicate_official_effects: 0 }] as T[] };
      }
      return { rows: [] as T[] };
    },
  };
  const db: ProductionLoadDatabase = {
    async transaction<T>(callback: (client: ProductionLoadDatabaseSession) => Promise<T>) {
      await session.query("BEGIN");
      try {
        const result = await callback(session);
        await session.query("COMMIT");
        return result;
      } catch (error) {
        await session.query("ROLLBACK");
        throw error;
      }
    },
    query: session.query,
  };
  return { db, queries };
}

function system(): ProductionLoadSystemAdapter {
  return {
    captureHost: vi.fn(async () => ({
      hostCpuPercent: 17,
      availableMemoryBytes: 16 * 1024 ** 3,
      rootFreeFraction: 0.7,
      rootFreeBytes: 700 * 1024 ** 3,
      diskReadBytes: 100,
      diskWriteBytes: 200,
      temperatureCelsius: 54,
      oomKills: 4,
      thermalThrottleIncrements: 5,
    })),
    captureRunnerVm: vi.fn(async () => ({
      runnerVmCpuPercent: 9,
      runnerVmAvailableMemoryBytes: 3 * 1024 ** 3,
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
      observedAt: NOW,
      acknowledgedMutationFailures: 0,
      runnerMaxConcurrentJobs: 2,
      secretLeakFindings: 0,
    })),
  };
}

const validOptions = {
  project: "learncoding" as const,
  runnerVmId: "57b9ab11-f3a4-4ea8-a58e-e73d951f9d11",
  signSessionToken: async (token: string) => `sig-${token.slice(0, 12)}`,
  randomSessionToken: () => "x".repeat(72),
  now: () => new Date(NOW),
};

describe("production load host", () => {
  it("fails closed unless the exact Compose project and VM identity are bound", () => {
    const { db } = database();
    expect(() => createProductionLoadHost({ ...validOptions, project: "other" as "learncoding", database: db, system: system() })).toThrow(/invalid_project/);
    expect(() => createProductionLoadHost({ ...validOptions, runnerVmId: "not-a-uuid", database: db, system: system() })).toThrow(/invalid_runner_vm_id/);
  });

  it("seeds the exact synthetic curriculum, prompts, drafts, users and auth-compatible exam sessions in one parameterized transaction", async () => {
    const { db, queries } = database();
    const host = createProductionLoadHost({
      ...validOptions,
      database: db,
      system: system(),
      randomSessionToken: (() => {
        let index = 0;
        return () => `${String(++index).padStart(2, "0")}${"x".repeat(70)}`;
      })(),
    });

    const result = await host.handle("seed", buildProductionLoadSeedPlan());
    const sessions = (result as { sessions: Array<Record<string, unknown>> }).sessions;

    expect(sessions).toHaveLength(10);
    expect(sessions.every((entry) => typeof entry.sessionHandle === "string" && entry.sessionHandle.startsWith("__Secure-learncoding.session_token=") && typeof entry.examSessionId === "string" && entry.examItemId === "synthetic-exam-item")).toBe(true);
    expect(queries[0]?.text).toBe("BEGIN");
    expect(queries.at(-1)?.text).toBe("COMMIT");
    expect(queries.filter((entry) => /insert into lesson\b/i.test(entry.text))).toHaveLength(30);
    expect(queries.filter((entry) => /insert into activity\b/i.test(entry.text))).toHaveLength(50);
    expect(queries.filter((entry) => /insert into learner_draft\b/i.test(entry.text))).toHaveLength(100);
    expect(queries.filter((entry) => /insert into "user"/i.test(entry.text))).toHaveLength(10);
    expect(queries.filter((entry) => /insert into exam_session\b/i.test(entry.text))).toHaveLength(10);
    expect(queries.every((entry) => !entry.text.includes("@example.invalid") && !entry.text.includes("__Secure-learncoding") && !entry.text.includes("xxxxxxxx"))).toBe(true);
  });

  it("rolls back and emits a stable error without database or session secrets", async () => {
    const { db, queries } = database({ failOn: "insert into learner_draft" });
    const host = createProductionLoadHost({ ...validOptions, database: db, system: system() });
    await expect(host.handle("seed", buildProductionLoadSeedPlan())).rejects.toThrow("Production load host failed: seed_failed");
    expect(queries.at(-1)?.text).toBe("ROLLBACK");
  });

  it("collects complete host, PostgreSQL, runner, VM and unrelated-service telemetry", async () => {
    const { db } = database();
    const hostSystem = system();
    const host = createProductionLoadHost({ ...validOptions, database: db, system: hostSystem });

    await expect(host.handle("baseline", {})).resolves.toEqual({ oomKills: 4, thermalThrottleIncrements: 5, postgresDeadlocks: 2 });
    await expect(host.handle("sample", {})).resolves.toEqual({
      hostCpuPercent: 17, availableMemoryBytes: 16 * 1024 ** 3, rootFreeFraction: 0.7,
      rootFreeBytes: 700 * 1024 ** 3, diskReadBytes: 100, diskWriteBytes: 200,
      postgresConnections: 7, postgresMaxConnections: 100, postgresDeadlocks: 2,
      postgresLockWaitMs: 11, temperatureCelsius: 54, oomKills: 4,
      thermalThrottleIncrements: 5, runnerQueueDepth: 3, runnerQueueWaitMs: 1500,
      runnerRunningJobs: 2, runnerVmCpuPercent: 9,
      runnerVmAvailableMemoryBytes: 3 * 1024 ** 3, unrelatedServicesHealthy: true,
    });
    expect(hostSystem.captureRunnerVm).toHaveBeenCalledWith(validOptions.runnerVmId);
    expect(hostSystem.unrelatedServicesHealthy).toHaveBeenCalledWith("learncoding");
  });

  it("strictly validates and delegates every fault, browser and invariant operation", async () => {
    const { db, queries } = database();
    const hostSystem = system();
    const host = createProductionLoadHost({ ...validOptions, database: db, system: hostSystem });
    const fault = PRODUCTION_LOAD_FAULT_MATRIX[0]!;

    await expect(host.handle("fault_reset", { faultId: fault.id })).resolves.toEqual({ ok: true });
    await expect(host.handle("fault_probe", { faultId: fault.id, phase: "recovery" })).resolves.toEqual({ componentHealthy: true, queueDepth: 3, alertOrDeadLetterVisible: true, unrelatedServicesHealthy: true, runnerRunningJobs: 2 });
    await expect(host.handle("browser_journey", { faultId: fault.id, stage: "steady" })).resolves.toEqual({ ok: true });
    await expect(host.handle("fault_inject_release", { faultId: fault.id })).resolves.toEqual({ ok: true });
    await expect(host.handle("fault_invariants", { faultId: fault.id })).resolves.toEqual({ acknowledgedMutationFailures: 0, duplicateOfficialEffects: 0, secretLeakFindings: 0, runnerMaxConcurrentJobs: 2 });

    expect(hostSystem.resetFault).toHaveBeenCalledWith(fault.id, "learncoding", validOptions.runnerVmId);
    expect(hostSystem.injectAndReleaseFault).toHaveBeenCalledWith(fault.id, "learncoding", validOptions.runnerVmId);
    expect(hostSystem.runBrowserJourney).toHaveBeenCalledWith(fault.id, "steady");
    expect(hostSystem.captureFaultInvariantEvidence).toHaveBeenCalledWith(fault.id, "learncoding", validOptions.runnerVmId);
    const invariantQuery = queries.find((query) => query.text.includes("load_invariant"));
    expect(invariantQuery?.text).not.toMatch(/acknowledged_mutation_failures|runner_max_concurrent_jobs/);
  });

  it.each([
    ["missing freshness", {
      source: "isolated-production-load-backend-v1",
      faultId: PRODUCTION_LOAD_FAULT_MATRIX[0]!.id,
      project: "learncoding",
      runnerVmId: validOptions.runnerVmId,
      acknowledgedMutationFailures: 0,
      runnerMaxConcurrentJobs: 2,
      secretLeakFindings: 0,
    }, "invalid_invariant_evidence"],
    ["stale freshness", {
      source: "isolated-production-load-backend-v1",
      faultId: PRODUCTION_LOAD_FAULT_MATRIX[0]!.id,
      project: "learncoding",
      runnerVmId: validOptions.runnerVmId,
      observedAt: "2026-07-19T11:59:29.999Z",
      acknowledgedMutationFailures: 0,
      runnerMaxConcurrentJobs: 2,
      secretLeakFindings: 0,
    }, "stale_invariant_evidence"],
    ["future freshness", {
      source: "isolated-production-load-backend-v1",
      faultId: PRODUCTION_LOAD_FAULT_MATRIX[0]!.id,
      project: "learncoding",
      runnerVmId: validOptions.runnerVmId,
      observedAt: "2026-07-19T12:00:00.001Z",
      acknowledgedMutationFailures: 0,
      runnerMaxConcurrentJobs: 2,
      secretLeakFindings: 0,
    }, "invalid_invariant_evidence"],
    ["wrong provenance", {
      source: "untrusted",
      faultId: PRODUCTION_LOAD_FAULT_MATRIX[0]!.id,
      project: "learncoding",
      runnerVmId: validOptions.runnerVmId,
      observedAt: NOW,
      acknowledgedMutationFailures: 0,
      runnerMaxConcurrentJobs: 2,
      secretLeakFindings: 0,
    }, "invalid_invariant_evidence"],
    ["malformed counters", {
      source: "isolated-production-load-backend-v1",
      faultId: PRODUCTION_LOAD_FAULT_MATRIX[0]!.id,
      project: "learncoding",
      runnerVmId: validOptions.runnerVmId,
      observedAt: NOW,
      acknowledgedMutationFailures: -1,
      runnerMaxConcurrentJobs: 2.5,
    }, "invalid_invariant_evidence"],
  ])("rejects %s instead of inferring invariant success", async (_label, evidence, errorCode) => {
    const { db } = database();
    const hostSystem = system();
    vi.mocked(hostSystem.captureFaultInvariantEvidence).mockResolvedValue(evidence as never);
    const host = createProductionLoadHost({ ...validOptions, database: db, system: hostSystem });

    await expect(host.handle("fault_invariants", {
      faultId: PRODUCTION_LOAD_FAULT_MATRIX[0]!.id,
    })).rejects.toThrow(errorCode);
  });

  it("rejects unknown, extra, malformed, or unconfigured operations without side effects", async () => {
    const { db } = database();
    const hostSystem = system();
    const host = createProductionLoadHost({ ...validOptions, database: db, system: hostSystem });

    await expect(host.handle("fault_reset", { faultId: "host_docker_restart" })).rejects.toThrow(/invalid_fault/);
    await expect(host.handle("fault_probe", { faultId: PRODUCTION_LOAD_FAULT_MATRIX[0]!.id, phase: "recovery", extra: true })).rejects.toThrow(/invalid_payload/);
    await expect(host.handle("runner_observation", { requestId: "bad" })).rejects.toThrow(/invalid_request_id/);
    await expect(host.handle("unknown" as never, {})).rejects.toThrow(/invalid_operation/);
    expect(hostSystem.resetFault).not.toHaveBeenCalled();
  });

  it("returns only redacted runner timing and duplicate-effect evidence", async () => {
    const { db } = database();
    const host = createProductionLoadHost({ ...validOptions, database: db, system: system() });
    await expect(host.handle("runner_observation", { requestId: "9ed04017-ae6c-41f4-b839-0ac4e457e3d5" })).resolves.toEqual({ runnerAdmissionMs: 25, runnerQueueWaitMs: 120, duplicateOfficialEffects: 0 });
  });
});
