import {
  buildProductionLoadActions,
  buildProductionLoadSchedule,
  buildProductionLoadSeedPlan,
  evaluateProductionLoadAbort,
  evaluateProductionWorkloadTotals,
  type ProductionLoadAbortDecision,
  type ProductionLoadAction,
  type ProductionLoadMinute,
  type ProductionLoadResourceBaseline,
  type ProductionLoadResourceSample,
  type ProductionLoadSeedPlan,
  type ProductionWorkloadTotals,
} from "../../src/lib/performance/load-report";

export type ProductionLoadHttpRequestObservation = {
  readonly sequence: number;
  readonly method: "GET" | "POST" | "PUT";
  readonly route: string;
  readonly durationMs: number;
  readonly status: number | null;
  readonly ok: boolean;
  readonly timedOut: boolean;
  readonly mutation: boolean;
  readonly acknowledged: boolean;
};

export type ProductionLoadActionObservation = {
  readonly requestId: string;
  readonly kind: ProductionLoadAction["kind"];
  readonly phase: ProductionLoadAction["phase"];
  readonly durationMs: number;
  readonly ok: boolean;
  readonly status: number | null;
  readonly acknowledged: boolean;
  readonly duplicateOfficialEffects: number;
  readonly httpRequests: readonly ProductionLoadHttpRequestObservation[];
  readonly runnerAdmissionMs?: number;
  readonly runnerQueueWaitMs?: number;
};

export type ProductionLoadResourceObservation = ProductionLoadResourceSample & {
  readonly sampleIndex: number;
  readonly scheduledOffsetMs: number;
  readonly observedAt: string;
  readonly phase: ProductionLoadMinute["phase"];
  readonly phaseMinute: number;
};

export type ProductionLoadClock = {
  now(): number;
  waitUntil(targetEpochMs: number, signal: AbortSignal): Promise<void>;
};

export type ProductionLoadWorkloadAdapter<Session> = {
  seed(plan: ProductionLoadSeedPlan): Promise<void>;
  authenticate(learner: ProductionLoadSeedPlan["learners"][number]): Promise<Session>;
  execute(
    action: ProductionLoadAction,
    session: Session,
    signal: AbortSignal,
  ): Promise<ProductionLoadActionObservation>;
  sampleResources(signal: AbortSignal): Promise<ProductionLoadResourceSample>;
};

export type RunProductionLoadWorkloadInput<Session> = {
  readonly clock: ProductionLoadClock;
  readonly baseline: ProductionLoadResourceBaseline;
  readonly adapter: ProductionLoadWorkloadAdapter<Session>;
};

export type ProductionLoadWorkloadResult = {
  readonly startedAt: string;
  readonly completedAt: string;
  readonly actions: readonly ProductionLoadActionObservation[];
  readonly resourceSamples: readonly ProductionLoadResourceObservation[];
  readonly observedSustainedTotals: ProductionWorkloadTotals;
  readonly abort: ProductionLoadAbortDecision;
};

export async function runProductionLoadWorkload<Session>(
  input: RunProductionLoadWorkloadInput<Session>,
): Promise<ProductionLoadWorkloadResult> {
  const startedAtMs = input.clock.now();
  if (!Number.isSafeInteger(startedAtMs) || startedAtMs < 0) {
    throw new Error("Production load clock returned an invalid start time.");
  }
  const schedule = buildProductionLoadSchedule();
  const seedPlan = buildProductionLoadSeedPlan();
  await input.adapter.seed(seedPlan);

  const sessions = new Map<string, Session>();
  for (const learnerAlias of schedule.learners) {
    const learner = seedPlan.learners.find((candidate) => candidate.alias === learnerAlias);
    if (!learner) throw new Error(`Production load seed omitted learner ${learnerAlias}.`);
    sessions.set(learnerAlias, await input.adapter.authenticate(learner));
  }

  const actionsByMinute = new Map<number, ProductionLoadAction[]>();
  for (const action of buildProductionLoadActions(schedule)) {
    const minuteActions = actionsByMinute.get(action.ordinal) ?? [];
    minuteActions.push(action);
    actionsByMinute.set(action.ordinal, minuteActions);
  }
  const observations: ProductionLoadActionObservation[] = [];
  const resourceSamples: ProductionLoadResourceObservation[] = [];
  const controller = new AbortController();
  let abort: ProductionLoadAbortDecision = { aborted: false };

  const collectResourceSample = async (
    minute: ProductionLoadMinute,
    scheduledAtMs: number,
  ): Promise<ProductionLoadAbortDecision> => {
    const sample = await input.adapter.sampleResources(controller.signal);
    const observedAtMs = input.clock.now();
    if (!Number.isSafeInteger(observedAtMs) || observedAtMs < scheduledAtMs) {
      throw new Error("Production load clock regressed while collecting resource telemetry.");
    }
    const observation: ProductionLoadResourceObservation = {
      ...sample,
      sampleIndex: resourceSamples.length,
      scheduledOffsetMs: scheduledAtMs - startedAtMs,
      observedAt: new Date(observedAtMs).toISOString(),
      phase: minute.phase,
      phaseMinute: minute.phaseMinute,
    };
    resourceSamples.push(observation);
    return evaluateProductionLoadAbort(resourceSamples, input.baseline);
  };

  for (const minute of schedule.minutes) {
    const minuteStartMs = startedAtMs + (minute.ordinal - 1) * 60_000;
    await input.clock.waitUntil(minuteStartMs, controller.signal);
    abort = await collectResourceSample(minute, minuteStartMs);
    if (abort.aborted) {
      controller.abort(abort.reason);
      break;
    }

    const actionPromises = (actionsByMinute.get(minute.ordinal) ?? []).map(async (action) => {
      const session = sessions.get(action.learnerId);
      if (session === undefined) {
        throw new Error(`Production load session is missing for ${action.learnerId}.`);
      }
      const observation = await input.adapter.execute(action, session, controller.signal);
      if (observation.requestId !== action.requestId
        || observation.kind !== action.kind
        || observation.phase !== action.phase) {
        throw new Error("Production load adapter returned a mismatched action observation.");
      }
      return observation;
    });
    const settledActions = Promise.allSettled(actionPromises);

    for (let sampleInMinute = 1; sampleInMinute < 12; sampleInMinute += 1) {
      const scheduledAtMs = minuteStartMs + sampleInMinute * 5_000;
      await input.clock.waitUntil(scheduledAtMs, controller.signal);
      abort = await collectResourceSample(minute, scheduledAtMs);
      if (abort.aborted) {
        controller.abort(abort.reason);
        break;
      }
    }

    const settled = await settledActions;
    for (const result of settled) {
      if (result.status === "rejected") {
        if (!abort.aborted) throw result.reason;
      } else {
        observations.push(result.value);
      }
    }
    if (abort.aborted) break;
  }

  const sustained = observations.filter((observation) => observation.phase === "sustained");
  const observedSustainedTotals: ProductionWorkloadTotals = {
    lessonReads: sustained.filter((observation) => observation.kind === "lesson_read").length,
    dashboardReads: sustained.filter((observation) => observation.kind === "dashboard_read").length,
    reviewQuizCompletions: sustained.filter((observation) =>
      observation.kind === "review_completion" || observation.kind === "quiz_completion").length,
    autosaves: sustained.filter((observation) =>
      observation.kind === "draft_autosave" || observation.kind === "exam_autosave").length,
    codeJobs: sustained.filter((observation) => observation.kind === "code_job").length,
  };
  if (!abort.aborted && !evaluateProductionWorkloadTotals(observedSustainedTotals).passed) {
    throw new Error("Production load orchestrator did not issue the frozen sustained workload.");
  }

  return {
    startedAt: new Date(startedAtMs).toISOString(),
    completedAt: new Date(input.clock.now()).toISOString(),
    actions: observations,
    resourceSamples,
    observedSustainedTotals,
    abort,
  };
}
