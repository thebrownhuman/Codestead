import { performance } from "node:perf_hooks";

import type { ProductionLoadAction } from "../../src/lib/performance/load-report";
import type {
  ProductionLoadActionObservation,
  ProductionLoadHttpRequestObservation,
  ProductionLoadWorkloadAdapter,
} from "./production-load-workload";
import type {
  ProductionLoadControlClient,
  ProductionLoadSession,
} from "./production-load-control";

export type ProductionLoadHttpAdapterOptions = {
  readonly baseUrl: URL;
  readonly control: ProductionLoadControlClient;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
  readonly requestTimeoutMs?: number;
};

type HttpResult = {
  readonly status: number | null;
  readonly ok: boolean;
  readonly body: Record<string, unknown> | null;
  readonly timedOut: boolean;
  readonly acknowledged: boolean;
};

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function uuid(value: unknown): value is string {
  return typeof value === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
}

function successfulStatus(status: number | null): boolean {
  return status !== null && status >= 200 && status < 300;
}

async function readBoundedJson(response: Response): Promise<Record<string, unknown> | null> {
  if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get("content-type") ?? "")) {
    await response.body?.cancel();
    return null;
  }
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > 1_048_576) return null;
  try {
    return record(JSON.parse(text) as unknown);
  } catch {
    return null;
  }
}

function observation(
  action: ProductionLoadAction,
  durationMs: number,
  result: HttpResult,
  acknowledged: boolean,
  httpRequests: readonly ProductionLoadHttpRequestObservation[],
  extras: Partial<Pick<
    ProductionLoadActionObservation,
    "duplicateOfficialEffects" | "runnerAdmissionMs" | "runnerQueueWaitMs"
  >> = {},
): ProductionLoadActionObservation {
  return {
    requestId: action.requestId,
    kind: action.kind,
    phase: action.phase,
    durationMs,
    ok: result.ok,
    status: result.status,
    acknowledged,
    duplicateOfficialEffects: extras.duplicateOfficialEffects ?? 0,
    httpRequests: Object.freeze(httpRequests.map((request) => Object.freeze({ ...request }))),
    ...(extras.runnerAdmissionMs === undefined
      ? {}
      : { runnerAdmissionMs: extras.runnerAdmissionMs }),
    ...(extras.runnerQueueWaitMs === undefined
      ? {}
      : { runnerQueueWaitMs: extras.runnerQueueWaitMs }),
  };
}

export function createProductionLoadHttpAdapter(
  options: ProductionLoadHttpAdapterOptions,
): ProductionLoadWorkloadAdapter<ProductionLoadSession> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => performance.now());
  const baseUrl = new URL(options.baseUrl.origin);
  const draftRevisions = new Map<string, number>();
  const examRevisions = new Map<string, number>();
  const requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
  if (!Number.isSafeInteger(requestTimeoutMs)
    || requestTimeoutMs < 1
    || requestTimeoutMs > 60_000) {
    throw new Error("Production load HTTP request timeout must be between 1 and 60000 ms.");
  }

  const request = async (
    path: string,
    session: ProductionLoadSession,
    parentSignal: AbortSignal,
    observations: ProductionLoadHttpRequestObservation[],
    init: RequestInit = {},
    expectJson = false,
  ): Promise<HttpResult> => {
    const target = new URL(path, baseUrl);
    if (target.origin !== baseUrl.origin || target.search || target.hash) {
      throw new Error("Production load HTTP route must be a same-origin path without query or fragment.");
    }
    const rawMethod = (init.method ?? "GET").toUpperCase();
    if (rawMethod !== "GET" && rawMethod !== "POST" && rawMethod !== "PUT") {
      throw new Error("Production load HTTP method is not allowlisted.");
    }
    const method: ProductionLoadHttpRequestObservation["method"] = rawMethod;
    const requestStarted = now();
    if (!Number.isFinite(requestStarted)) {
      throw new Error("Production load HTTP adapter clock is invalid.");
    }

    const controller = new AbortController();
    let timedOut = false;
    let responseStatus: number | null = null;
    const abortFromParent = () => {
      if (!controller.signal.aborted) {
        controller.abort(parentSignal.reason ?? new DOMException(
          "Production load request aborted.",
          "AbortError",
        ));
      }
    };
    if (parentSignal.aborted) abortFromParent();
    else parentSignal.addEventListener("abort", abortFromParent, { once: true });

    let rejectOnAbort: () => void = () => undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      rejectOnAbort = () => reject(controller.signal.reason ?? new DOMException(
        "Production load request aborted.",
        "AbortError",
      ));
      if (controller.signal.aborted) rejectOnAbort();
      else controller.signal.addEventListener("abort", rejectOnAbort, { once: true });
    });
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort(new DOMException(
        "Production load request timed out.",
        "TimeoutError",
      ));
    }, requestTimeoutMs);

    let result: HttpResult;
    try {
      result = await Promise.race([
        (async (): Promise<HttpResult> => {
          const response = await fetchImpl(target, {
            ...init,
            redirect: "manual",
            cache: "no-store",
            headers: {
              accept: expectJson ? "application/json" : "text/html,application/xhtml+xml",
              cookie: session.sessionHandle,
              ...init.headers,
            },
            signal: controller.signal,
          });
          responseStatus = Number.isInteger(response.status)
            && response.status >= 100
            && response.status <= 599
            ? response.status
            : null;
          const acknowledged = method !== "GET" && successfulStatus(responseStatus);
          if (!expectJson) {
            await response.body?.cancel();
            return {
              status: responseStatus,
              ok: successfulStatus(responseStatus),
              body: null,
              timedOut: false,
              acknowledged,
            };
          }
          const body = await readBoundedJson(response);
          return {
            status: responseStatus,
            ok: successfulStatus(responseStatus) && body !== null,
            body,
            timedOut: false,
            acknowledged,
          };
        })(),
        aborted,
      ]);
    } catch {
      result = {
        status: responseStatus,
        ok: false,
        body: null,
        timedOut,
        acknowledged: method !== "GET" && successfulStatus(responseStatus),
      };
    } finally {
      clearTimeout(timeout);
      parentSignal.removeEventListener("abort", abortFromParent);
      controller.signal.removeEventListener("abort", rejectOnAbort);
    }

    const requestCompleted = now();
    if (!Number.isFinite(requestCompleted) || requestCompleted < requestStarted) {
      throw new Error("Production load HTTP adapter clock is invalid.");
    }
    observations.push({
      sequence: observations.length,
      method,
      route: target.pathname,
      durationMs: requestCompleted - requestStarted,
      status: result.status,
      ok: successfulStatus(result.status) && !result.timedOut,
      timedOut: result.timedOut,
      mutation: method !== "GET",
      acknowledged: result.acknowledged,
    });
    return result;
  };

  const jsonRequest = (
    path: string,
    session: ProductionLoadSession,
    signal: AbortSignal,
    observations: ProductionLoadHttpRequestObservation[],
    method: "POST" | "PUT",
    body: Record<string, unknown>,
  ) => request(path, session, signal, observations, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }, true);

  const executeAssessment = async (
    action: ProductionLoadAction,
    session: ProductionLoadSession,
    signal: AbortSignal,
    observations: ProductionLoadHttpRequestObservation[],
  ): Promise<HttpResult> => {
    const created = await jsonRequest(
      "/api/learning/attempts",
      session,
      signal,
      observations,
      "POST",
      {
        idempotencyKey: `load-${action.requestId}`,
        skillId: "python.toolchain.repl",
        kind: action.kind === "quiz_completion" ? "quiz" : "practice",
      },
    );
    const attempt = record(created.body?.attempt);
    const activity = record(created.body?.activity);
    const specification = record(activity?.specification);
    const firstOption = Array.isArray(specification?.options)
      ? record(specification.options[0])
      : null;
    if (!created.ok
      || created.body?.state !== "ready"
      || !attempt
      || !uuid(attempt.id)
      || typeof activity?.slug !== "string"
      || !/^[A-Za-z0-9_.:-]{3,180}$/.test(activity.slug)
      || typeof firstOption?.id !== "string"
      || firstOption.id.length > 160) {
      return { ...created, ok: false };
    }
    const submitted = await jsonRequest(
      `/api/learning/attempts/${attempt.id}/submit`,
      session,
      signal,
      observations,
      "POST",
      {
        itemKey: activity.slug,
        responseRevision: 1,
        answer: { value: firstOption.id },
        assistanceLevel: "A0",
        solutionRevealed: false,
      },
    );
    return {
      ...submitted,
      ok: submitted.ok && submitted.body?.state === "graded",
    };
  };

  return {
    seed: (plan) => options.control.seed(plan),
    authenticate: (learner) => options.control.authenticate(learner),
    sampleResources: (signal) => options.control.sampleResources(signal),

    async execute(action, session, signal) {
      const started = now();
      const httpRequests: ProductionLoadHttpRequestObservation[] = [];
      let result: HttpResult = {
        status: null, ok: false, body: null, timedOut: false, acknowledged: false,
      };
      let acknowledged = false;
      let duplicateOfficialEffects = 0;
      let runnerAdmissionMs: number | undefined;
      let runnerQueueWaitMs: number | undefined;

      if (action.kind === "lesson_read") {
        result = await request(
          "/courses/python/skills/python.toolchain.repl",
          session,
          signal,
          httpRequests,
        );
        acknowledged = result.ok;
      } else if (action.kind === "dashboard_read") {
        result = await request("/learn", session, signal, httpRequests);
        acknowledged = result.ok;
      } else if (action.kind === "review_completion" || action.kind === "quiz_completion") {
        result = await executeAssessment(action, session, signal, httpRequests);
        acknowledged = result.ok;
      } else if (action.kind === "draft_autosave") {
        const expectedRowVersion = draftRevisions.get(session.learnerId) ?? 0;
        result = await jsonRequest("/api/drafts", session, signal, httpRequests, "PUT", {
          kind: "code",
          courseId: "python",
          skillId: "free-playground",
          language: "python",
          content: `# production load ${action.requestId}\nprint("ok")\n`,
          expectedRowVersion,
          requestId: action.requestId,
        });
        const committed = result.body?.committedRowVersion;
        const replayed = result.body?.replayed;
        result = {
          ...result,
          ok: result.ok
            && committed === expectedRowVersion + 1
            && typeof replayed === "boolean",
        };
        if (result.ok) {
          draftRevisions.set(session.learnerId, committed as number);
          acknowledged = true;
        }
      } else if (action.kind === "exam_autosave") {
        const baseRevision = examRevisions.get(session.learnerId) ?? session.examRevision;
        result = await jsonRequest(
          `/api/exams/${session.examSessionId}/autosave`,
          session,
          signal,
          httpRequests,
          "PUT",
          {
            clientMutationId: action.requestId,
            itemId: session.examItemId,
            baseRevision,
            answer: {
              text: `production load ${action.requestId}`,
            },
          },
        );
        const saved = record(result.body?.saved);
        result = {
          ...result,
          ok: result.ok
            && saved?.revision === baseRevision + 1
            && typeof saved.replayed === "boolean",
        };
        if (result.ok) {
          examRevisions.set(session.learnerId, saved!.revision as number);
          acknowledged = true;
        }
      } else if (action.kind === "code_job") {
        result = await jsonRequest("/api/code/run", session, signal, httpRequests, "POST", {
          language: "python",
          source: `print("production-load-${action.requestId}")`,
          skillId: "python.toolchain.repl",
          mode: "quick_run",
          clientRequestId: action.requestId,
        });
        result = {
          ...result,
          ok: result.ok
            && result.body?.requestId === action.requestId
            && typeof result.body?.status === "string",
        };
        if (result.ok) {
          try {
            const runner = await options.control.runnerObservation(action.requestId, signal);
            runnerAdmissionMs = runner.runnerAdmissionMs;
            runnerQueueWaitMs = runner.runnerQueueWaitMs;
            duplicateOfficialEffects = runner.duplicateOfficialEffects;
            acknowledged = true;
          } catch {
            result = { ...result, ok: false };
          }
        }
      }
      if (httpRequests.some((requestObservation) => requestObservation.acknowledged)) {
        acknowledged = true;
      }

      const completed = now();
      if (!Number.isFinite(started) || !Number.isFinite(completed) || completed < started) {
        throw new Error("Production load HTTP adapter clock is invalid.");
      }
      return observation(
        action,
        completed - started,
        result,
        acknowledged,
        httpRequests,
        {
          duplicateOfficialEffects,
          ...(runnerAdmissionMs === undefined ? {} : { runnerAdmissionMs }),
          ...(runnerQueueWaitMs === undefined ? {} : { runnerQueueWaitMs }),
        },
      );
    },
  };
}
