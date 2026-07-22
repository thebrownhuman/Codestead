import { describe, expect, it } from "vitest";

import {
  buildProductionLoadActions,
  buildProductionLoadSchedule,
  type ProductionLoadResourceSample,
} from "../../src/lib/performance/load-report";
import { runProductionLoadWorkload } from "./production-load-workload";

describe("production load workload orchestrator", () => {
  it("runs the exact 10/60/10 workload with 960 five-second resource samples", async () => {
    let now = Date.parse("2026-07-19T12:00:00.000Z");
    let seededCounts: Record<string, number> | null = null;
    let authenticated = 0;
    let sampled = 0;
    const healthySample: ProductionLoadResourceSample = {
      hostCpuPercent: 35,
      availableMemoryBytes: 16 * 1024 ** 3,
      rootFreeFraction: 0.5,
      rootFreeBytes: 400 * 1024 ** 3,
      diskReadBytes: 1_000,
      diskWriteBytes: 2_000,
      postgresConnections: 10,
      postgresMaxConnections: 100,
      postgresDeadlocks: 0,
      postgresLockWaitMs: 2,
      temperatureCelsius: 60,
      oomKills: 0,
      thermalThrottleIncrements: 0,
      runnerQueueDepth: 1,
      runnerQueueWaitMs: 25,
      runnerRunningJobs: 2,
      runnerVmCpuPercent: 40,
      runnerVmAvailableMemoryBytes: 6 * 1024 ** 3,
      unrelatedServicesHealthy: true,
    };
    const result = await runProductionLoadWorkload({
      clock: {
        now: () => now,
        waitUntil: async (target) => {
          expect(target).toBeGreaterThanOrEqual(now);
          now = target;
        },
      },
      baseline: { oomKills: 0, thermalThrottleIncrements: 0, postgresDeadlocks: 0 },
      adapter: {
        seed: async (plan) => {
          seededCounts = {
            learners: plan.learners.length,
            lessons: plan.lessons.length,
            prompts: plan.prompts.length,
            drafts: plan.drafts.length,
            providerCredentials: plan.providerCredentials.length,
          };
        },
        authenticate: async (learner) => {
          authenticated += 1;
          return { opaqueSessionMaterial: `must-not-leak-${learner.alias}` };
        },
        execute: async (action) => ({
          requestId: action.requestId,
          kind: action.kind,
          phase: action.phase,
          durationMs: 1,
          ok: true,
          status: 200,
          acknowledged: true,
          duplicateOfficialEffects: 0,
          httpRequests: [{
            sequence: 0,
            method: action.kind === "lesson_read" || action.kind === "dashboard_read" ? "GET" : "POST",
            route: "/synthetic-action",
            durationMs: 1,
            status: 200,
            ok: true,
            timedOut: false,
            mutation: action.kind !== "lesson_read" && action.kind !== "dashboard_read",
            acknowledged: action.kind !== "lesson_read" && action.kind !== "dashboard_read",
          }],
          ...(action.kind === "code_job" ? { runnerAdmissionMs: 1, runnerQueueWaitMs: 1 } : {}),
        }),
        sampleResources: async () => {
          sampled += 1;
          return healthySample;
        },
      },
    });

    expect(seededCounts).toEqual({
      learners: 10,
      lessons: 30,
      prompts: 50,
      drafts: 100,
      providerCredentials: 0,
    });
    expect(authenticated).toBe(10);
    expect(sampled).toBe(960);
    expect(result.resourceSamples).toHaveLength(960);
    expect(result.resourceSamples[0]).toMatchObject({
      sampleIndex: 0,
      scheduledOffsetMs: 0,
      observedAt: "2026-07-19T12:00:00.000Z",
      phase: "warmup",
      phaseMinute: 1,
    });
    expect(result.resourceSamples.at(-1)).toMatchObject({
      sampleIndex: 959,
      scheduledOffsetMs: 4_795_000,
      observedAt: "2026-07-19T13:19:55.000Z",
      phase: "cooldown",
      phaseMinute: 10,
    });
    expect(result.actions).toHaveLength(buildProductionLoadActions().length);
    expect(result.observedSustainedTotals).toEqual(buildProductionLoadSchedule().sustainedTotals);
    expect(result.abort).toEqual({ aborted: false });
    expect(result.startedAt).toBe("2026-07-19T12:00:00.000Z");
    expect(result.completedAt).toBe("2026-07-19T13:19:55.000Z");
    expect(JSON.stringify(result)).not.toMatch(/opaqueSessionMaterial|must-not-leak/);
  });
});

  it("aborts before the next minute after the first immediate resource guard violation", async () => {
    let now = Date.parse("2026-07-19T12:00:00.000Z");
    let executed = 0;
    const result = await runProductionLoadWorkload({
      clock: {
        now: () => now,
        waitUntil: async (target) => { now = target; },
      },
      baseline: { oomKills: 0, thermalThrottleIncrements: 0, postgresDeadlocks: 0 },
      adapter: {
        seed: async () => undefined,
        authenticate: async () => null,
        execute: async (action) => {
          executed += 1;
          return {
            requestId: action.requestId,
            kind: action.kind,
            phase: action.phase,
            durationMs: 1,
            ok: true,
            status: 200,
            acknowledged: true,
            duplicateOfficialEffects: 0,
            httpRequests: [{
              sequence: 0,
              method: action.kind === "lesson_read" || action.kind === "dashboard_read" ? "GET" : "POST",
              route: "/synthetic-action",
              durationMs: 1,
              status: 200,
              ok: true,
              timedOut: false,
              mutation: action.kind !== "lesson_read" && action.kind !== "dashboard_read",
              acknowledged: action.kind !== "lesson_read" && action.kind !== "dashboard_read",
            }],
          };
        },
        sampleResources: async () => ({
          hostCpuPercent: 35,
          availableMemoryBytes: 16 * 1024 ** 3,
          rootFreeFraction: 0.5,
          rootFreeBytes: 400 * 1024 ** 3,
          diskReadBytes: 1_000,
          diskWriteBytes: 2_000,
          postgresConnections: 10,
          postgresMaxConnections: 100,
          postgresDeadlocks: 0,
          postgresLockWaitMs: 2,
          temperatureCelsius: 90,
          oomKills: 0,
          thermalThrottleIncrements: 0,
          runnerQueueDepth: 1,
          runnerQueueWaitMs: 25,
          runnerRunningJobs: 2,
          runnerVmCpuPercent: 40,
          runnerVmAvailableMemoryBytes: 6 * 1024 ** 3,
          unrelatedServicesHealthy: true,
        }),
      },
    });

    expect(result.abort).toEqual({
      aborted: true,
      sampleIndex: 0,
      reason: "temperature_at_or_above_90_celsius",
    });
    expect(result.resourceSamples).toHaveLength(1);
    expect(result.actions).toHaveLength(0);
    expect(executed).toBe(0);
    expect(result.observedSustainedTotals).toEqual({
      lessonReads: 0,
      dashboardReads: 0,
      reviewQuizCompletions: 0,
      autosaves: 0,
      codeJobs: 0,
    });
    expect(result.completedAt).toBe("2026-07-19T12:00:00.000Z");
  });
