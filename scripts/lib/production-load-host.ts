import { createHash } from "node:crypto";

import pg from "pg";

import {
  buildProductionLoadSeedPlan,
  PRODUCTION_LOAD_FAULT_MATRIX,
  type ProductionLoadSeedPlan,
} from "../../src/lib/performance/load-report";
import type { ProductionLoadControlOperation } from "./production-load-control";

export type ProductionLoadDatabaseResult<T> = { readonly rows: readonly T[] };

export type ProductionLoadDatabaseSession = {
  query<T = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<ProductionLoadDatabaseResult<T>>;
};

export type ProductionLoadDatabase = ProductionLoadDatabaseSession & {
  transaction<T>(
    callback: (session: ProductionLoadDatabaseSession) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T>;
  close?(): Promise<void>;
};

type HostTelemetry = {
  readonly hostCpuPercent: number;
  readonly availableMemoryBytes: number;
  readonly rootFreeFraction: number;
  readonly rootFreeBytes: number;
  readonly diskReadBytes: number;
  readonly diskWriteBytes: number;
  readonly temperatureCelsius: number;
  readonly oomKills: number;
  readonly thermalThrottleIncrements: number;
};

type RunnerVmTelemetry = {
  readonly runnerVmCpuPercent: number;
  readonly runnerVmAvailableMemoryBytes: number;
};

type FaultProbe = {
  readonly componentHealthy: boolean;
  readonly alertOrDeadLetterVisible: boolean;
};

type ProductionFaultId = (typeof PRODUCTION_LOAD_FAULT_MATRIX)[number]["id"];

export type ProductionLoadFaultInvariantEvidence = {
  readonly source: "isolated-production-load-backend-v1";
  readonly faultId: ProductionFaultId;
  readonly project: "learncoding";
  readonly runnerVmId: string;
  readonly observedAt: string;
  readonly acknowledgedMutationFailures: number;
  readonly runnerMaxConcurrentJobs: number;
  readonly secretLeakFindings: number;
};

export type ProductionLoadSystemAdapter = {
  captureHost(signal?: AbortSignal): Promise<HostTelemetry>;
  captureRunnerVm(expectedVmId: string, signal?: AbortSignal): Promise<RunnerVmTelemetry>;
  unrelatedServicesHealthy(expectedProject: "learncoding", signal?: AbortSignal): Promise<boolean>;
  resetFault(
    faultId: ProductionFaultId,
    expectedProject: "learncoding",
    expectedVmId: string,
    signal?: AbortSignal,
  ): Promise<void>;
  probeFault(
    faultId: ProductionFaultId,
    phase: "baseline" | "recovery",
    expectedProject: "learncoding",
    expectedVmId: string,
    signal?: AbortSignal,
  ): Promise<FaultProbe>;
  injectAndReleaseFault(
    faultId: ProductionFaultId,
    expectedProject: "learncoding",
    expectedVmId: string,
    signal?: AbortSignal,
  ): Promise<void>;
  runBrowserJourney(
    faultId: ProductionFaultId,
    stage: "steady" | "recovered",
    signal?: AbortSignal,
  ): Promise<void>;
  captureFaultInvariantEvidence(
    faultId: ProductionFaultId,
    expectedProject: "learncoding",
    expectedVmId: string,
    signal?: AbortSignal,
  ): Promise<ProductionLoadFaultInvariantEvidence>;
  close?(): Promise<void>;
};
export type ProductionLoadHost = {
  handle(
    operation: ProductionLoadControlOperation,
    payload: unknown,
    signal?: AbortSignal,
  ): Promise<unknown>;
  close(): Promise<void>;
};

export type CreateProductionLoadHostOptions = {
  readonly project: "learncoding";
  readonly runnerVmId: string;
  readonly database: ProductionLoadDatabase;
  readonly system: ProductionLoadSystemAdapter;
  readonly signSessionToken: (token: string) => Promise<string>;
  readonly randomSessionToken: () => string;
  readonly now?: () => Date;
};

const faultIds = new Set<ProductionFaultId>(
  PRODUCTION_LOAD_FAULT_MATRIX.map((fault) => fault.id),
);

function fail(code: string): never {
  throw new Error(`Production load host failed: ${code}`);
}

function abortLoad(signal?: AbortSignal): void {
  if (signal?.aborted) fail("aborted");
}

type OperationOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: unknown };

async function settle<T>(promise: Promise<T>): Promise<OperationOutcome<T>> {
  try {
    return { ok: true, value: await promise };
  } catch (error) {
    return { ok: false, error };
  }
}

function outcomeValue<T>(outcome: OperationOutcome<T>): T {
  if (!outcome.ok) throw outcome.error;
  return outcome.value;
}

async function withOptionalSignal<T>(
  signal: AbortSignal | undefined,
  withoutSignal: () => Promise<T>,
  withSignal: (value: AbortSignal) => Promise<T>,
): Promise<T> {
  abortLoad(signal);
  try {
    const result = await (signal ? withSignal(signal) : withoutSignal());
    abortLoad(signal);
    return result;
  } catch (error) {
    abortLoad(signal);
    throw error;
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function emptyPayload(value: unknown): void {
  const item = record(value);
  if (!item || !exactKeys(item, [])) fail("invalid_payload");
}

function stableUuid(label: string): string {
  const bytes = Buffer.from(createHash("sha256").update(`codestead-load\0${label}`).digest().subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function finiteNumber(value: unknown, code: string, minimum = 0): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < minimum) fail(code);
  return parsed;
}

function integer(value: unknown, code: string, minimum = 0): number {
  const parsed = finiteNumber(value, code, minimum);
  if (!Number.isSafeInteger(parsed)) fail(code);
  return parsed;
}

function validateFaultInvariantEvidence(
  value: unknown,
  expectedFaultId: ProductionFaultId,
  expectedProject: "learncoding",
  expectedVmId: string,
  now: Date,
): ProductionLoadFaultInvariantEvidence {
  const item = record(value);
  if (!item || !exactKeys(item, [
    "source",
    "faultId",
    "project",
    "runnerVmId",
    "observedAt",
    "acknowledgedMutationFailures",
    "runnerMaxConcurrentJobs",
    "secretLeakFindings",
  ])
    || item.source !== "isolated-production-load-backend-v1"
    || item.faultId !== expectedFaultId
    || item.project !== expectedProject
    || item.runnerVmId !== expectedVmId
    || typeof item.observedAt !== "string") {
    fail("invalid_invariant_evidence");
  }
  const observedAtMs = Date.parse(item.observedAt);
  if (!Number.isFinite(observedAtMs)
    || new Date(observedAtMs).toISOString() !== item.observedAt
    || !Number.isFinite(now.getTime())) {
    fail("invalid_invariant_evidence");
  }
  const ageMs = now.getTime() - observedAtMs;
  if (ageMs < 0) fail("invalid_invariant_evidence");
  if (ageMs > 30_000) fail("stale_invariant_evidence");
  for (const key of [
    "acknowledgedMutationFailures",
    "runnerMaxConcurrentJobs",
    "secretLeakFindings",
  ] as const) {
    if (typeof item[key] !== "number"
      || !Number.isSafeInteger(item[key])
      || item[key] < 0) {
      fail("invalid_invariant_evidence");
    }
  }
  return item as ProductionLoadFaultInvariantEvidence;
}

function validateHostTelemetry(value: HostTelemetry): HostTelemetry {
  const item = record(value);
  const keys = [
    "hostCpuPercent", "availableMemoryBytes", "rootFreeFraction", "rootFreeBytes",
    "diskReadBytes", "diskWriteBytes", "temperatureCelsius", "oomKills",
    "thermalThrottleIncrements",
  ];
  if (!item || !exactKeys(item, keys)) fail("invalid_host_telemetry");
  const hostCpuPercent = finiteNumber(item.hostCpuPercent, "invalid_host_telemetry");
  const rootFreeFraction = finiteNumber(item.rootFreeFraction, "invalid_host_telemetry");
  if (hostCpuPercent > 100 || rootFreeFraction > 1) fail("invalid_host_telemetry");
  return {
    hostCpuPercent,
    availableMemoryBytes: integer(item.availableMemoryBytes, "invalid_host_telemetry"),
    rootFreeFraction,
    rootFreeBytes: integer(item.rootFreeBytes, "invalid_host_telemetry"),
    diskReadBytes: integer(item.diskReadBytes, "invalid_host_telemetry"),
    diskWriteBytes: integer(item.diskWriteBytes, "invalid_host_telemetry"),
    temperatureCelsius: finiteNumber(item.temperatureCelsius, "invalid_host_telemetry"),
    oomKills: integer(item.oomKills, "invalid_host_telemetry"),
    thermalThrottleIncrements: integer(item.thermalThrottleIncrements, "invalid_host_telemetry"),
  };
}

function validateRunnerVmTelemetry(value: RunnerVmTelemetry): RunnerVmTelemetry {
  const item = record(value);
  if (!item || !exactKeys(item, ["runnerVmCpuPercent", "runnerVmAvailableMemoryBytes"])) {
    fail("invalid_runner_vm_telemetry");
  }
  const cpu = finiteNumber(item.runnerVmCpuPercent, "invalid_runner_vm_telemetry");
  if (cpu > 100) fail("invalid_runner_vm_telemetry");
  return {
    runnerVmCpuPercent: cpu,
    runnerVmAvailableMemoryBytes: integer(
      item.runnerVmAvailableMemoryBytes,
      "invalid_runner_vm_telemetry",
    ),
  };
}

function validateSeedPlan(value: unknown): ProductionLoadSeedPlan {
  let actual: string;
  try {
    actual = JSON.stringify(value);
  } catch {
    fail("invalid_seed_plan");
  }
  if (actual !== JSON.stringify(buildProductionLoadSeedPlan())) fail("invalid_seed_plan");
  return value as ProductionLoadSeedPlan;
}

async function queryPostgresTelemetry(
  database: ProductionLoadDatabaseSession,
  signal?: AbortSignal,
) {
  abortLoad(signal);
  const stats = await database.query<{
    connections: unknown;
    deadlocks: unknown;
    lock_wait_ms: unknown;
  }>(`select
       numbackends as connections,
       deadlocks,
       coalesce((
         select percentile_cont(0.95) within group (
           order by extract(epoch from (clock_timestamp() - query_start)) * 1000
         ) from pg_stat_activity where wait_event_type = 'Lock'
       ), 0) as lock_wait_ms
     from pg_stat_database where datname = current_database()`);
  abortLoad(signal);
  const maximum = await database.query<{ max_connections: unknown }>(
    "select current_setting('max_connections')::int as max_connections",
  );
  abortLoad(signal);
  const row = stats.rows[0];
  const max = maximum.rows[0];
  if (!row || !max) fail("postgres_telemetry_unavailable");
  return {
    postgresConnections: integer(row.connections, "invalid_postgres_telemetry"),
    postgresMaxConnections: integer(max.max_connections, "invalid_postgres_telemetry", 1),
    postgresDeadlocks: integer(row.deadlocks, "invalid_postgres_telemetry"),
    postgresLockWaitMs: finiteNumber(row.lock_wait_ms, "invalid_postgres_telemetry"),
  };
}

async function queryRunnerTelemetry(
  database: ProductionLoadDatabaseSession,
  signal?: AbortSignal,
) {
  abortLoad(signal);
  const result = await database.query<{
    queue_depth: unknown;
    running_jobs: unknown;
    oldest_queue_wait_ms: unknown;
    max_observed_queue_wait_ms: unknown;
  }>(`select
       count(*) filter (where status = 'queued')::int as queue_depth,
       count(*) filter (where status in ('leased','running'))::int as running_jobs,
       coalesce(max(extract(epoch from (clock_timestamp() - queued_at)) * 1000)
         filter (where status = 'queued'), 0) as oldest_queue_wait_ms,
       coalesce(max(extract(epoch from (started_at - queued_at)) * 1000), 0)
         as max_observed_queue_wait_ms
     from runner_job`);
  abortLoad(signal);
  const row = result.rows[0];
  if (!row) fail("runner_telemetry_unavailable");
  return {
    runnerQueueDepth: integer(row.queue_depth, "invalid_runner_telemetry"),
    runnerQueueWaitMs: finiteNumber(row.oldest_queue_wait_ms, "invalid_runner_telemetry"),
    runnerRunningJobs: integer(row.running_jobs, "invalid_runner_telemetry"),
  };
}

function blueprint(now: Date) {
  return {
    schemaVersion: 1,
    purpose: "formal-exam",
    formId: stableUuid("exam-form"),
    seed: "seed-20260715",
    courseId: "synthetic-load",
    courseTitle: "Synthetic load",
    moduleId: "synthetic-load-module",
    moduleTitle: "Synthetic load module",
    contentVersion: "seed-20260715",
    policyVersion: "formal-exam-v1",
    durationMinutes: 180,
    generatedAt: now.toISOString(),
    instructions: ["Synthetic load fixture; do not use as learning evidence."],
    integrityDisclosure: {
      version: "synthetic-load-v1",
      summary: "Synthetic load integrity fixture.",
      capturedEvents: [],
      notCaptured: [],
    },
    items: [{
      id: "synthetic-exam-item",
      skillId: "python.toolchain.repl",
      clusterId: "synthetic-load",
      title: "Synthetic load item",
      prompt: "Persist a synthetic autosave.",
      kind: "short-answer",
      points: 1,
      critical: false,
      gradingEvidence: { kind: "exact-answer", acceptedAnswers: ["ok"], caseSensitive: false },
    }],
  };
}

async function seedDatabase(
  options: CreateProductionLoadHostOptions,
  plan: ProductionLoadSeedPlan,
  signal?: AbortSignal,
) {
  abortLoad(signal);
  const now = options.now?.() ?? new Date();
  if (!Number.isFinite(now.getTime())) fail("invalid_clock");
  const sessions: Array<{
    learnerId: string;
    sessionHandle: string;
    examSessionId: string;
    examItemId: string;
    examRevision: number;
  }> = [];
  const seenTokens = new Set<string>();
  try {
    await options.database.transaction(async (rawDatabase) => {
      const db: ProductionLoadDatabaseSession = {
        async query<T>(text: string, values: readonly unknown[] = []) {
          abortLoad(signal);
          const result = await rawDatabase.query<T>(text, values);
          abortLoad(signal);
          return result;
        },
      };
      await db.query("select pg_advisory_xact_lock($1::bigint)", ["6081241526994772101"]);
      const namespaceUsers = await db.query<{ id: string; email: string }>(
        "select id, lower(email) as email from \"user\" where id = any($1::text[]) or lower(email) = any($2::text[]) /* production_load_namespace */",
        [plan.learners.map((learner) => learner.id), plan.learners.map((learner) => learner.email)],
      );
      const expectedById = new Map(plan.learners.map((learner) => [learner.id, learner.email]));
      const expectedByEmail = new Map(plan.learners.map((learner) => [learner.email, learner.id]));
      for (const existing of namespaceUsers.rows) {
        if (expectedById.get(existing.id) !== existing.email
          || expectedByEmail.get(existing.email) !== existing.id) {
          fail("seed_namespace_collision");
        }
      }
      await db.query("delete from \"user\" where id = any($1::text[]) and lower(email) = any($2::text[])", [
        plan.learners.map((learner) => learner.id),
        plan.learners.map((learner) => learner.email),
      ]);

      const courseId = stableUuid("course");
      const namespaceCourses = await db.query<{ id: string }>(
        "select id from course where slug = $1 /* production_load_namespace_course */",
        ["synthetic-load"],
      );
      if (namespaceCourses.rows.some((course) => course.id !== courseId)) {
        fail("seed_namespace_collision");
      }
      await db.query("delete from course where id = $1 and slug = $2", [courseId, "synthetic-load"]);
      const versionId = stableUuid("course-version");
      const moduleId = stableUuid("course-module");
      const contentHash = createHash("sha256").update("seed-20260715").digest("hex");
      await db.query("insert into course (id, slug, title, summary, domain) values ($1,$2,$3,$4,$5)", [courseId, "synthetic-load", "Synthetic load", "Release-gate fixture", "synthetic"]);
      await db.query("insert into course_version (id, course_id, version, stage, scope_statement, content_hash) values ($1,$2,$3,'beta',$4,$5)", [versionId, courseId, "seed-20260715", "Synthetic release-gate fixture only", contentHash]);
      await db.query("insert into course_module (id, course_version_id, slug, title, objective, position, estimated_minutes) values ($1,$2,$3,$4,$5,$6,$7)", [moduleId, versionId, "synthetic-load", "Synthetic load", "Exercise bounded load paths", 1, 180]);
      for (const lesson of plan.lessons) {
        await db.query("insert into lesson (id, module_id, slug, title, objective, estimated_minutes, difficulty, position, content_status) values ($1,$2,$3,$4,$5,$6,$7,$8,'beta')", [lesson.id, moduleId, lesson.slug, `Synthetic lesson ${lesson.position}`, "Exercise one bounded read", 5, "beginner", lesson.position]);
      }
      for (const prompt of plan.prompts) {
        await db.query("insert into activity (id, lesson_id, slug, type, instructions, specification, difficulty, max_points) values ($1,$2,$3,$4,$5,$6::jsonb,$7,$8)", [prompt.id, prompt.lessonId, `synthetic-${prompt.kind}-${prompt.position}-${prompt.id.slice(0, 8)}`, prompt.kind, "Synthetic release-gate prompt", JSON.stringify({ options: [{ id: "ok", text: "OK" }], answer: "ok" }), "beginner", 1]);
      }

      for (const learner of plan.learners) {
        const token = options.randomSessionToken();
        if (!/^[A-Za-z0-9_-]{64,512}$/.test(token) || seenTokens.has(token)) fail("invalid_session_token_source");
        seenTokens.add(token);
        const sessionId = stableUuid(`session:${learner.id}`);
        const examAttemptId = stableUuid(`exam-attempt:${learner.id}`);
        const examSessionId = stableUuid(`exam-session:${learner.id}`);
        await db.query("insert into \"user\" (id, name, email, email_verified, two_factor_enabled, role, status, must_change_password, adult_confirmed_at) values ($1,$2,$3,true,true,'learner','active',false,$4)", [learner.id, learner.alias, learner.email, now]);
        await db.query("insert into learner_profile (user_id, onboarding_step, onboarding_completed_at, public_alias) values ($1,'complete',$2,$3)", [learner.id, now, learner.alias]);
        await db.query("insert into session (id, expires_at, token, user_id, device_hash, device_label, mfa_verified_at) values ($1,$2,$3,$4,$5,$6,$7)", [sessionId, new Date(now.getTime() + 6 * 60 * 60 * 1000), token, learner.id, `synthetic-load-${learner.id}`, "production-load", now]);
        await db.query("insert into consent_record (user_id, purpose, policy_version, decision, data_categories, source, idempotency_key) values ($1,$2,$3,'accepted',$4::jsonb,'system_migration',$5)", [learner.id, "server_code_execution", "enrollment-disclosure-2026-07-12.v2", JSON.stringify(["source-code", "standard-input", "test-results"]), `synthetic-load-${learner.id}`]);
        for (const draft of plan.drafts.filter((item) => item.learnerId === learner.id)) {
          await db.query("insert into learner_draft (id, user_id, kind, course_id, skill_id, language, content, row_version) values ($1,$2,$3,$4,$5,$6,$7,1)", [draft.id, learner.id, draft.kind, draft.courseId, draft.skillId, draft.language, "# synthetic release-gate draft\n"]);
        }
        await db.query("insert into attempt (id, user_id, kind, status, policy_version, content_version, started_at) values ($1,$2,'exam','in_progress',$3,$4,$5)", [examAttemptId, learner.id, "formal-exam-v1", "seed-20260715", now]);
        await db.query("insert into exam_session (id, attempt_id, user_id, status, server_started_at, server_deadline_at, last_heartbeat_at) values ($1,$2,$3,'active',$4,$5,$4)", [examSessionId, examAttemptId, learner.id, now, new Date(now.getTime() + 3 * 60 * 60 * 1000)]);
        await db.query("insert into response (attempt_id, item_key, revision, answer, source, saved_at) values ($1,$2,1,$3::jsonb,'server',$4)", [examAttemptId, "__exam_blueprint_v1__", JSON.stringify(blueprint(now)), now]);
        const signature = await options.signSessionToken(token);
        abortLoad(signal);
        if (!signature || /[\r\n]/.test(signature)) fail("invalid_session_signature");
        sessions.push({
          learnerId: learner.alias,
          sessionHandle: `__Secure-learncoding.session_token=${encodeURIComponent(`${token}.${signature}`)}`,
          examSessionId,
          examItemId: "synthetic-exam-item",
          examRevision: 0,
        });
      }
    }, signal);
  } catch {
    abortLoad(signal);
    fail("seed_failed");
  }
  abortLoad(signal);
  return { sessions };
}

function faultPayload(payload: unknown): ProductionFaultId {
  const item = record(payload);
  if (!item || !exactKeys(item, ["faultId"]) || !faultIds.has(item.faultId as ProductionFaultId)) {
    fail("invalid_fault");
  }
  return item.faultId as ProductionFaultId;
}

function faultPhasePayload(payload: unknown): { faultId: ProductionFaultId; phase: "baseline" | "recovery" } {
  const item = record(payload);
  if (!item || !exactKeys(item, ["faultId", "phase"]) || !faultIds.has(item.faultId as ProductionFaultId) || (item.phase !== "baseline" && item.phase !== "recovery")) {
    fail("invalid_payload");
  }
  return { faultId: item.faultId as ProductionFaultId, phase: item.phase };
}

function browserPayload(payload: unknown): { faultId: ProductionFaultId; stage: "steady" | "recovered" } {
  const item = record(payload);
  if (!item || !exactKeys(item, ["faultId", "stage"]) || !faultIds.has(item.faultId as ProductionFaultId) || (item.stage !== "steady" && item.stage !== "recovered")) {
    fail("invalid_payload");
  }
  return { faultId: item.faultId as ProductionFaultId, stage: item.stage };
}

export function createProductionLoadHost(
  options: CreateProductionLoadHostOptions,
): ProductionLoadHost {
  if (options.project !== "learncoding") fail("invalid_project");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(options.runnerVmId)) {
    fail("invalid_runner_vm_id");
  }

  const sample = async (signal?: AbortSignal) => {
    abortLoad(signal);
    try {
      const [hostResult, postgresResult, runnerResult, runnerVmResult, healthResult] = await Promise.all([
        settle(withOptionalSignal(
          signal,
          () => options.system.captureHost(),
          (value) => options.system.captureHost(value),
        ).then(validateHostTelemetry)),
        settle(queryPostgresTelemetry(options.database, signal)),
        settle(queryRunnerTelemetry(options.database, signal)),
        settle(withOptionalSignal(
          signal,
          () => options.system.captureRunnerVm(options.runnerVmId),
          (value) => options.system.captureRunnerVm(options.runnerVmId, value),
        ).then(validateRunnerVmTelemetry)),
        settle(withOptionalSignal(
          signal,
          () => options.system.unrelatedServicesHealthy(options.project),
          (value) => options.system.unrelatedServicesHealthy(options.project, value),
        )),
      ]);
      abortLoad(signal);
      const host = outcomeValue(hostResult);
      const postgres = outcomeValue(postgresResult);
      const runner = outcomeValue(runnerResult);
      const runnerVm = outcomeValue(runnerVmResult);
      const unrelatedServicesHealthy = outcomeValue(healthResult);
      if (typeof unrelatedServicesHealthy !== "boolean") fail("invalid_unrelated_service_health");
      return { ...host, ...postgres, ...runner, ...runnerVm, unrelatedServicesHealthy };
    } catch (error) {
      abortLoad(signal);
      if (error instanceof Error && error.message.startsWith("Production load host failed:")) throw error;
      fail("telemetry_failed");
    }
  };

  return {
    async handle(operation, payload, signal) {
      abortLoad(signal);
      if (operation === "seed") return seedDatabase(options, validateSeedPlan(payload), signal);
      if (operation === "baseline") {
        emptyPayload(payload);
        const current = await sample(signal);
        return { oomKills: current.oomKills, thermalThrottleIncrements: current.thermalThrottleIncrements, postgresDeadlocks: current.postgresDeadlocks };
      }
      if (operation === "sample") {
        emptyPayload(payload);
        return sample(signal);
      }
      if (operation === "runner_observation") {
        const item = record(payload);
        if (!item || !exactKeys(item, ["requestId"]) || typeof item.requestId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(item.requestId)) fail("invalid_request_id");
        const result = await options.database.query<{ admission_ms: unknown; queue_wait_ms: unknown; duplicate_official_effects: unknown }>(`select
             coalesce(extract(epoch from (job.queued_at - submission.created_at)) * 1000, 0) as admission_ms,
             coalesce(extract(epoch from (job.started_at - job.queued_at)) * 1000, 0) as queue_wait_ms,
             greatest(count(*) over (partition by submission.user_id, submission.request_id) - 1, 0)::int as duplicate_official_effects
           from code_submission submission join runner_job job on job.submission_id = submission.id
          where submission.request_id = $1 limit 1`, [item.requestId]);
        abortLoad(signal);
        const row = result.rows[0];
        if (!row) fail("runner_observation_unavailable");
        return { runnerAdmissionMs: finiteNumber(row.admission_ms, "invalid_runner_observation"), runnerQueueWaitMs: finiteNumber(row.queue_wait_ms, "invalid_runner_observation"), duplicateOfficialEffects: integer(row.duplicate_official_effects, "invalid_runner_observation") };
      }
      if (operation === "fault_reset") {
        const faultId = faultPayload(payload);
        await withOptionalSignal(
          signal,
          () => options.system.resetFault(faultId, options.project, options.runnerVmId),
          (value) => options.system.resetFault(faultId, options.project, options.runnerVmId, value),
        );
        abortLoad(signal);
        return { ok: true };
      }
      if (operation === "fault_probe") {
        const parsed = faultPhasePayload(payload);
        const [probeResult, queueResult, healthResult] = await Promise.all([
          settle(withOptionalSignal(
            signal,
            () => options.system.probeFault(parsed.faultId, parsed.phase, options.project, options.runnerVmId),
            (value) => options.system.probeFault(parsed.faultId, parsed.phase, options.project, options.runnerVmId, value),
          )),
          settle(queryRunnerTelemetry(options.database, signal)),
          settle(withOptionalSignal(
            signal,
            () => options.system.unrelatedServicesHealthy(options.project),
            (value) => options.system.unrelatedServicesHealthy(options.project, value),
          )),
        ]);
        abortLoad(signal);
        const probe = outcomeValue(probeResult);
        const queue = outcomeValue(queueResult);
        const unrelatedServicesHealthy = outcomeValue(healthResult);
        if (typeof probe.componentHealthy !== "boolean" || typeof probe.alertOrDeadLetterVisible !== "boolean" || typeof unrelatedServicesHealthy !== "boolean") fail("invalid_fault_probe");
        return { componentHealthy: probe.componentHealthy, queueDepth: queue.runnerQueueDepth, alertOrDeadLetterVisible: probe.alertOrDeadLetterVisible, unrelatedServicesHealthy, runnerRunningJobs: queue.runnerRunningJobs };
      }
      if (operation === "browser_journey") {
        const parsed = browserPayload(payload);
        await withOptionalSignal(
          signal,
          () => options.system.runBrowserJourney(parsed.faultId, parsed.stage),
          (value) => options.system.runBrowserJourney(parsed.faultId, parsed.stage, value),
        );
        abortLoad(signal);
        return { ok: true };
      }
      if (operation === "fault_inject_release") {
        const faultId = faultPayload(payload);
        await withOptionalSignal(
          signal,
          () => options.system.injectAndReleaseFault(faultId, options.project, options.runnerVmId),
          (value) => options.system.injectAndReleaseFault(faultId, options.project, options.runnerVmId, value),
        );
        abortLoad(signal);
        return { ok: true };
      }
      if (operation === "fault_invariants") {
        const faultId = faultPayload(payload);
        let rawEvidence: ProductionLoadFaultInvariantEvidence;
        try {
          rawEvidence = await withOptionalSignal(
            signal,
            () => options.system.captureFaultInvariantEvidence(
              faultId, options.project, options.runnerVmId,
            ),
            (value) => options.system.captureFaultInvariantEvidence(
              faultId, options.project, options.runnerVmId, value,
            ),
          );
        } catch {
          abortLoad(signal);
          fail("invalid_invariant_evidence");
        }
        abortLoad(signal);
        const evidence = validateFaultInvariantEvidence(
          rawEvidence,
          faultId,
          options.project,
          options.runnerVmId,
          options.now?.() ?? new Date(),
        );
        const result = await options.database.query<{ duplicate_official_effects: unknown }>(`select
             coalesce((select sum(duplicate_count - 1)::int from (
               select count(*)::int as duplicate_count
                 from code_submission
                group by user_id, request_id
               having count(*) > 1
             ) load_invariant_duplicates), 0)::int as duplicate_official_effects
             /* load_invariant */`);
        abortLoad(signal);
        const row = result.rows[0];
        if (!row) fail("invariant_evidence_unavailable");
        return {
          acknowledgedMutationFailures: evidence.acknowledgedMutationFailures,
          duplicateOfficialEffects: integer(
            row.duplicate_official_effects,
            "invalid_invariant_evidence",
          ),
          secretLeakFindings: evidence.secretLeakFindings,
          runnerMaxConcurrentJobs: evidence.runnerMaxConcurrentJobs,
        };
      }      fail("invalid_operation");
    },
    async close() {
      await Promise.all([options.system.close?.(), options.database.close?.()]);
    },
  };
}

export function createFailClosedProductionLoadSystemAdapter(): ProductionLoadSystemAdapter {
  const unavailable = async (): Promise<never> => fail("system_adapter_not_configured");
  return {
    captureHost: unavailable,
    captureRunnerVm: unavailable,
    unrelatedServicesHealthy: unavailable,
    resetFault: unavailable,
    probeFault: unavailable,
    injectAndReleaseFault: unavailable,
    runBrowserJourney: unavailable,
    captureFaultInvariantEvidence: unavailable,
  };
}

export type ProductionLoadIsolationSnapshot = {
  readonly composeProject: string;
  readonly runnerVmId: string;
  readonly runnerVmMac: string;
  readonly repositoryRoot: string;
  readonly runnerStateRoot: string;
  readonly maintenanceWindowApproved: boolean;
  readonly freshRecoveryPoint: boolean;
  readonly unrelatedInventorySha256: string;
};

export type ProductionLoadIsolationBackend = ProductionLoadSystemAdapter & {
  inspectIsolation(signal?: AbortSignal): Promise<ProductionLoadIsolationSnapshot>;
};

export type GuardedProductionLoadSystemOptions = {
  readonly expectedProject: "learncoding";
  readonly expectedRunnerVmId: string;
  readonly expectedUnrelatedInventorySha256: string;
  readonly backend: ProductionLoadIsolationBackend;
};

export function createGuardedProductionLoadSystemAdapter(
  options: GuardedProductionLoadSystemOptions,
): ProductionLoadSystemAdapter {
  if (options.expectedProject !== "learncoding"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(options.expectedRunnerVmId)
    || !/^[0-9a-f]{64}$/.test(options.expectedUnrelatedInventorySha256)) {
    fail("invalid_isolation_configuration");
  }
  const inspect = async (code: string, signal?: AbortSignal) => {
    abortLoad(signal);
    let value: ProductionLoadIsolationSnapshot;
    try {
      value = await withOptionalSignal(
        signal,
        () => options.backend.inspectIsolation(),
        (current) => options.backend.inspectIsolation(current),
      );
    } catch {
      abortLoad(signal);
      fail(code);
    }
    abortLoad(signal);
    const item = record(value);
    if (!item || !exactKeys(item, [
      "composeProject", "runnerVmId", "runnerVmMac", "repositoryRoot",
      "runnerStateRoot", "maintenanceWindowApproved", "freshRecoveryPoint",
      "unrelatedInventorySha256",
    ])
      || value.composeProject !== options.expectedProject
      || value.runnerVmId !== options.expectedRunnerVmId
      || value.runnerVmMac.toLowerCase() !== "52:54:00:20:00:12"
      || value.repositoryRoot !== "/opt/learncoding"
      || value.runnerStateRoot !== "/var/lib/learncoding-runner"
      || value.maintenanceWindowApproved !== true
      || value.freshRecoveryPoint !== true
      || value.unrelatedInventorySha256 !== options.expectedUnrelatedInventorySha256) {
      fail(code);
    }
  };
  const exactIdentity = (project: "learncoding", vmId: string) => {
    if (project !== options.expectedProject || vmId !== options.expectedRunnerVmId) {
      fail("isolation_identity_mismatch");
    }
  };
  const guardedMutation = async (
    project: "learncoding",
    vmId: string,
    signal: AbortSignal | undefined,
    mutation: () => Promise<void>,
  ) => {
    exactIdentity(project, vmId);
    await inspect("isolation_precondition_failed", signal);
    await mutation();
    abortLoad(signal);
    await inspect("isolation_postcondition_failed", signal);
  };
  return {
    async captureHost(signal) {
      await inspect("isolation_precondition_failed", signal);
      return withOptionalSignal(signal, () => options.backend.captureHost(), (value) => options.backend.captureHost(value));
    },
    async captureRunnerVm(vmId, signal) {
      exactIdentity(options.expectedProject, vmId);
      await inspect("isolation_precondition_failed", signal);
      return withOptionalSignal(signal, () => options.backend.captureRunnerVm(vmId), (value) => options.backend.captureRunnerVm(vmId, value));
    },
    async unrelatedServicesHealthy(project, signal) {
      exactIdentity(project, options.expectedRunnerVmId);
      await inspect("isolation_precondition_failed", signal);
      return withOptionalSignal(signal, () => options.backend.unrelatedServicesHealthy(project), (value) => options.backend.unrelatedServicesHealthy(project, value));
    },
    resetFault(faultId, project, vmId, signal) {
      return guardedMutation(project, vmId, signal, () => withOptionalSignal(signal, () => options.backend.resetFault(faultId, project, vmId), (value) => options.backend.resetFault(faultId, project, vmId, value)));
    },
    async probeFault(faultId, phase, project, vmId, signal) {
      exactIdentity(project, vmId);
      await inspect("isolation_precondition_failed", signal);
      return withOptionalSignal(signal, () => options.backend.probeFault(faultId, phase, project, vmId), (value) => options.backend.probeFault(faultId, phase, project, vmId, value));
    },
    injectAndReleaseFault(faultId, project, vmId, signal) {
      return guardedMutation(project, vmId, signal, () => withOptionalSignal(signal, () => options.backend.injectAndReleaseFault(faultId, project, vmId), (value) => options.backend.injectAndReleaseFault(faultId, project, vmId, value)));
    },
    async runBrowserJourney(faultId, stage, signal) {
      await inspect("isolation_precondition_failed", signal);
      return withOptionalSignal(signal, () => options.backend.runBrowserJourney(faultId, stage), (value) => options.backend.runBrowserJourney(faultId, stage, value));
    },
    async captureFaultInvariantEvidence(faultId, project, vmId, signal) {
      exactIdentity(project, vmId);
      await inspect("isolation_precondition_failed", signal);
      return withOptionalSignal(signal, () => options.backend.captureFaultInvariantEvidence(faultId, project, vmId), (value) => options.backend.captureFaultInvariantEvidence(faultId, project, vmId, value));
    },
    close: options.backend.close ? () => options.backend.close!() : undefined,
  };
}
export type ProductionLoadPgClient = {
  query<T = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ readonly rows: readonly T[] }>;
  release(): void;
};

export type ProductionLoadPgPool = {
  connect(): Promise<ProductionLoadPgClient>;
  query<T = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ readonly rows: readonly T[] }>;
  end(): Promise<void>;
};

export type ProductionLoadPgPoolFactory = (
  options: Record<string, unknown>,
) => ProductionLoadPgPool;

function databaseFail(code: string): never {
  throw new Error(`Production load database failed: ${code}`);
}

function databaseFromPool(pool: ProductionLoadPgPool): ProductionLoadDatabase {
  return {
    async query<T>(text: string, values: readonly unknown[] = []) {
      try {
        return await pool.query<T>(text, [...values]);
      } catch {
        databaseFail("query_failed");
      }
    },
    async transaction<T>(
      callback: (session: ProductionLoadDatabaseSession) => Promise<T>,
      signal?: AbortSignal,
    ) {
      if (signal?.aborted) databaseFail("transaction_failed");
      let client: ProductionLoadPgClient;
      try {
        client = await pool.connect();
      } catch {
        databaseFail("connection_failed");
      }
      try {
        await client.query("BEGIN");
        if (signal?.aborted) throw new Error("cancelled");
        const session: ProductionLoadDatabaseSession = {
          query: (text, values = []) => client.query(text, [...values]),
        };
        const result = await callback(session);
        if (signal?.aborted) throw new Error("cancelled");
        await client.query("COMMIT");
        return result;
      } catch {
        await client.query("ROLLBACK").catch(() => undefined);
        databaseFail("transaction_failed");
      } finally {
        client.release();
      }
    },
    async close() {
      try {
        await pool.end();
      } catch {
        databaseFail("close_failed");
      }
    },
  };
}

function decodeDatabaseUrlComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    databaseFail("invalid_database_url");
  }
}

export function createPostgresProductionLoadDatabase(
  connectionString: string,
  poolFactory: ProductionLoadPgPoolFactory = (options) => new pg.Pool(options) as ProductionLoadPgPool,
): ProductionLoadDatabase {
  let target: URL;
  try {
    target = new URL(connectionString);
  } catch {
    databaseFail("invalid_database_url");
  }
  const loopback = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
  if (target.protocol !== "postgresql:"
    || !target.pathname || target.pathname === "/"
    || target.hash
    || !loopback.has(target.hostname)
    || (target.search !== "" && target.search !== "?sslmode=require")) {
    databaseFail("invalid_database_url");
  }
  const pool = poolFactory({
    connectionString,
    max: 2,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 10_000,
    statement_timeout: 5_000,
    query_timeout: 6_000,
    lock_timeout: 2_000,
    idle_in_transaction_session_timeout: 30_000,
    allowExitOnIdle: false,
  });
  return databaseFromPool(pool);
}

export function createUnixSocketProductionLoadDatabase(
  connectionString: string,
  poolFactory: ProductionLoadPgPoolFactory = (options) => new pg.Pool(options) as ProductionLoadPgPool,
): ProductionLoadDatabase {
  let target: URL;
  try {
    target = new URL(connectionString);
  } catch {
    databaseFail("invalid_database_url");
  }
  if (target.protocol !== "postgresql:"
    || target.hostname !== "postgres"
    || target.port !== "5432"
    || !target.username
    || !target.password
    || !target.pathname
    || target.pathname === "/"
    || target.search
    || target.hash) {
    databaseFail("invalid_database_url");
  }
  const user = decodeDatabaseUrlComponent(target.username);
  const password = decodeDatabaseUrlComponent(target.password);
  const database = decodeDatabaseUrlComponent(target.pathname.slice(1));
  if (!user || !password || !database || /[\0\r\n]/.test(user + password + database)) {
    databaseFail("invalid_database_url");
  }
  return databaseFromPool(poolFactory({
    host: "/run/learncoding-postgres",
    port: 5432,
    user,
    password,
    database,
    max: 2,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 10_000,
    statement_timeout: 5_000,
    query_timeout: 6_000,
    lock_timeout: 2_000,
    idle_in_transaction_session_timeout: 30_000,
    allowExitOnIdle: false,
  }));
}
