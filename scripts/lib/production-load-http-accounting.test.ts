import { describe, expect, it, vi } from "vitest";

import {
  buildProductionLoadActions,
  type ProductionLoadAction,
} from "../../src/lib/performance/load-report";
import type {
  ProductionLoadControlClient,
  ProductionLoadSession,
} from "./production-load-control";
import { createProductionLoadHttpAdapter } from "./production-load-http";

const session: ProductionLoadSession = {
  learnerId: "synthetic-load-01",
  sessionHandle: "__Secure-learncoding.session_token=opaque-test-session",
  examSessionId: "6fd0d069-7da4-4864-8a66-c5a90d8a34c0",
  examItemId: "synthetic-exam-item",
  examRevision: 0,
};

function action(kind: ProductionLoadAction["kind"]): ProductionLoadAction {
  const match = buildProductionLoadActions().find((candidate) =>
    candidate.learnerId === session.learnerId
      && candidate.phase === "sustained"
      && candidate.kind === kind);
  if (!match) throw new Error(`Missing ${kind} action fixture.`);
  return match;
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function control(
  runnerObservation: ProductionLoadControlClient["runnerObservation"] = vi.fn(async () => ({
    runnerAdmissionMs: 12,
    runnerQueueWaitMs: 34,
    duplicateOfficialEffects: 0,
  })),
): ProductionLoadControlClient {
  return {
    seed: vi.fn(async () => undefined),
    authenticate: vi.fn(async () => session),
    captureBaseline: vi.fn(async () => ({
      oomKills: 0,
      thermalThrottleIncrements: 0,
      postgresDeadlocks: 0,
    })),
    sampleResources: vi.fn(async () => ({
      hostCpuPercent: 1,
      availableMemoryBytes: 16 * 1024 ** 3,
      rootFreeFraction: 0.5,
      rootFreeBytes: 100,
      diskReadBytes: 0,
      diskWriteBytes: 0,
      postgresConnections: 1,
      postgresMaxConnections: 100,
      postgresDeadlocks: 0,
      postgresLockWaitMs: 0,
      temperatureCelsius: 50,
      oomKills: 0,
      thermalThrottleIncrements: 0,
      runnerQueueDepth: 0,
      runnerQueueWaitMs: 0,
      runnerRunningJobs: 0,
      runnerVmCpuPercent: 1,
      runnerVmAvailableMemoryBytes: 4 * 1024 ** 3,
      unrelatedServicesHealthy: true,
    })),
    runnerObservation,
    reset: vi.fn(async () => undefined),
    probe: vi.fn(async () => ({
      componentHealthy: true,
      queueDepth: 0,
      alertOrDeadLetterVisible: true,
      unrelatedServicesHealthy: true,
      runnerRunningJobs: 0,
    })),
    runAuthenticatedBrowserJourney: vi.fn(async () => undefined),
    injectAndRelease: vi.fn(async () => undefined),
    verifyInvariants: vi.fn(async () => ({
      acknowledgedMutationFailures: 0,
      duplicateOfficialEffects: 0,
      secretLeakFindings: 0,
      runnerMaxConcurrentJobs: 2,
    })),
  };
}

describe("production load physical HTTP accounting", () => {
  it("records both assessment requests and retains the first acknowledgement when submit fails", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const route = new URL(String(input)).pathname;
      if (route === "/api/learning/attempts") {
        return json({
          state: "ready",
          attempt: { id: "4f58689c-6574-4e24-a770-29814296fe41" },
          activity: {
            slug: "synthetic-checkpoint",
            specification: { options: [{ id: "a", text: "A" }] },
          },
        }, 201);
      }
      return json({ error: "temporarily unavailable" }, 503);
    });
    const adapter = createProductionLoadHttpAdapter({
      baseUrl: new URL("https://codestead.example.test/"),
      control: control(),
      fetchImpl,
    });

    const result = await adapter.execute(
      action("review_completion"),
      session,
      new AbortController().signal,
    );

    expect(result).toMatchObject({
      ok: false,
      status: 503,
      acknowledged: true,
      httpRequests: [
        {
          sequence: 0,
          method: "POST",
          route: "/api/learning/attempts",
          status: 201,
          ok: true,
          timedOut: false,
          mutation: true,
          acknowledged: true,
        },
        {
          sequence: 1,
          method: "POST",
          route: "/api/learning/attempts/4f58689c-6574-4e24-a770-29814296fe41/submit",
          status: 503,
          ok: false,
          timedOut: false,
          mutation: true,
          acknowledged: false,
        },
      ],
    });
  });

  it("retains a 2xx mutation acknowledgement through malformed evidence and runner observation failure", async () => {
    const malformedAdapter = createProductionLoadHttpAdapter({
      baseUrl: new URL("https://codestead.example.test/"),
      control: control(),
      fetchImpl: vi.fn(async () => json({ wrong: true })),
    });
    const malformed = await malformedAdapter.execute(
      action("draft_autosave"),
      session,
      new AbortController().signal,
    );

    expect(malformed).toMatchObject({
      ok: false,
      status: 200,
      acknowledged: true,
      httpRequests: [{
        method: "PUT",
        route: "/api/drafts",
        status: 200,
        ok: true,
        timedOut: false,
        mutation: true,
        acknowledged: true,
      }],
    });

    const runnerAdapter = createProductionLoadHttpAdapter({
      baseUrl: new URL("https://codestead.example.test/"),
      control: control(vi.fn(async () => {
        throw new Error("runner observation unavailable");
      })),
      fetchImpl: vi.fn(async (_input, init) => json({
        requestId: JSON.parse(String(init?.body)).clientRequestId,
        status: "accepted",
      }, 202)),
    });
    const runner = await runnerAdapter.execute(
      action("code_job"),
      session,
      new AbortController().signal,
    );

    expect(runner).toMatchObject({
      ok: false,
      status: 202,
      acknowledged: true,
      httpRequests: [{
        method: "POST",
        route: "/api/code/run",
        status: 202,
        ok: true,
        timedOut: false,
        mutation: true,
        acknowledged: true,
      }],
    });
  });

  it("bounds response-body reads and retains the received acknowledgement when the body stalls", async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi.fn(async () => new Response(new ReadableStream({
        start() {
          // Keep the JSON body open until the request deadline aborts it.
        },
      }), {
        status: 202,
        headers: { "content-type": "application/json" },
      }));
      const adapter = createProductionLoadHttpAdapter({
        baseUrl: new URL("https://codestead.example.test/"),
        control: control(),
        fetchImpl,
        requestTimeoutMs: 250,
        now: () => 1_000,
      });

      const pending = adapter.execute(
        action("code_job"),
        session,
        new AbortController().signal,
      );
      await vi.advanceTimersByTimeAsync(250);

      await expect(pending).resolves.toMatchObject({
        ok: false,
        status: 202,
        acknowledged: true,
        httpRequests: [{
          method: "POST",
          route: "/api/code/run",
          status: 202,
          ok: false,
          timedOut: true,
          mutation: true,
          acknowledged: true,
        }],
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
