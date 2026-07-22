import { describe, expect, it, vi } from "vitest";

import {
  buildProductionLoadActions,
  buildProductionLoadSeedPlan,
  type ProductionLoadAction,
} from "../../src/lib/performance/load-report";
import {
  createProductionLoadHttpAdapter,
} from "./production-load-http";
import type {
  ProductionLoadControlClient,
  ProductionLoadSession,
} from "./production-load-control";

const session: ProductionLoadSession = {
  learnerId: "synthetic-load-01",
  sessionHandle: "__Secure-learncoding.session_token=opaque-synthetic-load-session-value",
  examSessionId: "6fd0d069-7da4-4864-8a66-c5a90d8a34c0",
  examItemId: "synthetic-exam-item",
  examRevision: 0,
};

function control(): ProductionLoadControlClient {
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
    runnerObservation: vi.fn(async () => ({
      runnerAdmissionMs: 12,
      runnerQueueWaitMs: 34,
      duplicateOfficialEffects: 0,
    })),
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

function action(kind: ProductionLoadAction["kind"], occurrence = 1): ProductionLoadAction {
  const found = buildProductionLoadActions().find((candidate) =>
    candidate.learnerId === "synthetic-load-01"
      && candidate.phase === "sustained"
      && candidate.kind === kind
      && candidate.occurrence === occurrence);
  if (!found) throw new Error(`Missing action fixture for ${kind}.`);
  return found;
}

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("production authenticated HTTP workload adapter", () => {
  it("executes every frozen action through the real application boundary without leaking sessions", async () => {
    const requests: { url: string; init?: RequestInit }[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, init });
      if (url.endsWith("/api/learning/attempts")) {
        return json({
          state: "ready",
          attempt: { id: "4f58689c-6574-4e24-a770-29814296fe41" },
          activity: {
            slug: "synthetic-checkpoint",
            specification: { options: [{ id: "a", text: "A" }, { id: "b", text: "B" }] },
          },
          idempotent: false,
        }, 201);
      }
      if (url.includes("/api/learning/attempts/") && url.endsWith("/submit")) {
        return json({ state: "graded", idempotent: false });
      }
      if (url.endsWith("/api/drafts")) {
        const body = JSON.parse(String(init?.body)) as { expectedRowVersion: number };
        return json({ committedRowVersion: body.expectedRowVersion + 1, replayed: false });
      }
      if (url.includes("/api/exams/") && url.endsWith("/autosave")) {
        const body = JSON.parse(String(init?.body)) as { baseRevision: number };
        return json({ saved: { revision: body.baseRevision + 1, replayed: false } });
      }
      if (url.endsWith("/api/code/run")) {
        return json({ requestId: JSON.parse(String(init?.body)).clientRequestId, status: "accepted" });
      }
      return new Response("<html>ok</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    });
    let tick = 0;
    const gate = control();
    const adapter = createProductionLoadHttpAdapter({
      baseUrl: new URL("https://codestead.example.test/"),
      control: gate,
      fetchImpl,
      now: () => {
        tick += 10;
        return tick;
      },
    });
    const signal = new AbortController().signal;

    await adapter.seed(buildProductionLoadSeedPlan());
    const authenticated = await adapter.authenticate(buildProductionLoadSeedPlan().learners[0]!);
    const observations = [];
    for (const kind of [
      "lesson_read",
      "dashboard_read",
      "review_completion",
      "quiz_completion",
      "draft_autosave",
      "exam_autosave",
      "code_job",
    ] as const) {
      observations.push(await adapter.execute(action(kind), authenticated, signal));
    }

    expect(observations.every((entry) => entry.ok && entry.acknowledged)).toBe(true);
    expect(observations.find((entry) => entry.kind === "code_job")).toMatchObject({
      runnerAdmissionMs: 12,
      runnerQueueWaitMs: 34,
      duplicateOfficialEffects: 0,
    });
    expect(JSON.stringify(observations)).not.toMatch(/session_token|opaque-synthetic|cookie|authorization/i);
    expect(requests.map((entry) => new URL(entry.url).pathname)).toEqual([
      "/courses/python/skills/python.toolchain.repl",
      "/learn",
      "/api/learning/attempts",
      "/api/learning/attempts/4f58689c-6574-4e24-a770-29814296fe41/submit",
      "/api/learning/attempts",
      "/api/learning/attempts/4f58689c-6574-4e24-a770-29814296fe41/submit",
      "/api/drafts",
      "/api/exams/6fd0d069-7da4-4864-8a66-c5a90d8a34c0/autosave",
      "/api/code/run",
    ]);
    expect(requests.every((entry) =>
      new Headers(entry.init?.headers).get("cookie") === session.sessionHandle)).toBe(true);
  });

  it("advances draft and exam revisions only from validated acknowledgements", async () => {
    const draftVersions: number[] = [];
    const examVersions: number[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (url.endsWith("/api/drafts")) {
        draftVersions.push(Number(body.expectedRowVersion));
        return json({ committedRowVersion: Number(body.expectedRowVersion) + 1, replayed: false });
      }
      examVersions.push(Number(body.baseRevision));
      return json({ saved: { revision: Number(body.baseRevision) + 1, replayed: false } });
    });
    const adapter = createProductionLoadHttpAdapter({
      baseUrl: new URL("https://codestead.example.test/"),
      control: control(),
      fetchImpl,
    });
    const signal = new AbortController().signal;

    await adapter.execute(action("draft_autosave"), session, signal);
    await adapter.execute({ ...action("draft_autosave"), requestId: "9ed04017-ae6c-41f4-b839-0ac4e457e3d5" }, session, signal);
    await adapter.execute(action("exam_autosave"), session, signal);
    await adapter.execute({ ...action("exam_autosave"), requestId: "e2cb9bf1-55ee-4c99-9dbf-b98cbe8b8fa0" }, session, signal);

    expect(draftVersions).toEqual([0, 1]);
    expect(examVersions).toEqual([0, 1]);
  });

  it("fails an action truthfully on malformed success, HTTP failure, timeout, or mismatched runner request", async () => {
    const responses: Array<Response | Error> = [
      json({ wrong: true }),
      json({ error: "conflict" }, 409),
      new DOMException("timed out", "TimeoutError"),
      json({ requestId: "3a58772a-5e5e-4aca-a62e-13fe0c5baff3", status: "accepted" }),
    ];
    const fetchImpl = vi.fn(async () => {
      const next = responses.shift()!;
      if (next instanceof Error) throw next;
      return next;
    });
    const adapter = createProductionLoadHttpAdapter({
      baseUrl: new URL("https://codestead.example.test/"),
      control: control(),
      fetchImpl,
    });
    const signal = new AbortController().signal;

    const malformed = await adapter.execute(action("draft_autosave"), session, signal);
    const conflict = await adapter.execute(action("exam_autosave"), session, signal);
    const timeout = await adapter.execute(action("lesson_read"), session, signal);
    const mismatch = await adapter.execute(action("code_job"), session, signal);

    expect([malformed, conflict, timeout, mismatch].map((entry) => ({
      ok: entry.ok,
      status: entry.status,
      acknowledged: entry.acknowledged,
    }))).toEqual([
      { ok: false, status: 200, acknowledged: true },
      { ok: false, status: 409, acknowledged: false },
      { ok: false, status: null, acknowledged: false },
      { ok: false, status: 200, acknowledged: true },
    ]);
  });

  it("treats every redirect as an authentication-boundary failure", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, {
      status: 302,
      headers: { location: "/login" },
    }));
    const adapter = createProductionLoadHttpAdapter({
      baseUrl: new URL("https://codestead.example.test/"),
      control: control(),
      fetchImpl,
    });

    const result = await adapter.execute(
      action("dashboard_read"),
      session,
      new AbortController().signal,
    );

    expect(result).toMatchObject({
      ok: false,
      status: 302,
      acknowledged: false,
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      expect.any(URL),
      expect.objectContaining({ redirect: "manual" }),
    );
  });

  it("aborts and fails a request that exceeds its own bounded deadline", async () => {
    vi.useFakeTimers();
    try {
      let requestSignal: AbortSignal | undefined;
      const fetchImpl = vi.fn((_input: string | URL | Request, init?: RequestInit) => {
        requestSignal = init?.signal ?? undefined;
        return new Promise<Response>((_resolve, reject) => {
          requestSignal?.addEventListener("abort", () => reject(requestSignal?.reason), {
            once: true,
          });
        });
      });
      const adapter = createProductionLoadHttpAdapter({
        baseUrl: new URL("https://codestead.example.test/"),
        control: control(),
        fetchImpl,
        requestTimeoutMs: 250,
        now: () => 1_000,
      });

      const pending = adapter.execute(action("lesson_read"), session, new AbortController().signal);
      await vi.advanceTimersByTimeAsync(250);
      await expect(pending).resolves.toMatchObject({
        ok: false,
        status: null,
        acknowledged: false,
      });
      expect(requestSignal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
