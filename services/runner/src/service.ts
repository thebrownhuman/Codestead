import { randomUUID } from "node:crypto";
import type { RunnerConfig } from "./config.js";
import type { JobExecutor } from "./docker-executor.js";
import { RunnerError } from "./errors.js";
import {
  IdempotencyStore,
  type IdempotencyRecord,
} from "./idempotency.js";
import { RunnerMetrics } from "./metrics.js";
import { FifoWorkQueue } from "./queue.js";
import {
  projectRunnerResult,
  RunnerStateJournal,
  validatePublicRunnerResult,
  type PersistedIdempotencyRecord,
  type PersistedJobRecord,
  type RunnerStateSnapshot,
  type RunnerStateStore,
} from "./state-journal.js";
import { prepareRunnerTempRoot } from "./temp-root.js";
import type { PublicJobRecord, RunnerResult } from "./types.js";
import {
  validateJobRequest,
  type ValidatedJob,
} from "./validation.js";

export interface SubmitResult {
  readonly job: PublicJobRecord;
  readonly idempotencyHit: boolean;
}

interface RunnerServiceOptions {
  readonly clock?: () => number;
  readonly jobId?: () => string;
  readonly metrics?: RunnerMetrics;
  readonly stateStore?: RunnerStateStore;
  readonly onFatalError?: (error: Error) => void;
}

export class RunnerService {
  readonly #config: RunnerConfig;
  readonly #executor: JobExecutor;
  readonly #queue: FifoWorkQueue<RunnerResult>;
  readonly #idempotency: IdempotencyStore<string>;
  readonly #jobs = new Map<string, PersistedJobRecord>();
  readonly #clock: () => number;
  readonly #jobId: () => string;
  readonly #stateStore: RunnerStateStore;
  readonly #onFatalError: ((error: Error) => void) | undefined;
  #unavailable: Error | undefined;
  #closed = false;
  readonly metrics: RunnerMetrics;

  constructor(
    config: RunnerConfig,
    executor: JobExecutor,
    options: RunnerServiceOptions = {},
  ) {
    this.#config = config;
    this.#executor = executor;
    this.#queue = new FifoWorkQueue<RunnerResult>(
      config.concurrency,
      config.maxQueueDepth,
    );
    this.#idempotency = new IdempotencyStore<string>(
      config.idempotencyTtlMs,
      config.idempotencyCapacity,
    );
    this.#clock = options.clock ?? Date.now;
    this.#jobId = options.jobId ?? randomUUID;
    this.metrics = options.metrics ?? new RunnerMetrics(this.#clock());
    this.#onFatalError = options.onFatalError;
    prepareRunnerTempRoot(config.tempRoot);
    this.#stateStore =
      options.stateStore ?? new RunnerStateJournal(config.stateRoot);

      const loaded = this.#stateStore.load();
      const startupNowMs = this.#clock();
      const recoveredAt = new Date(startupNowMs).toISOString();
      const bindingByJob = new Map(
        loaded.idempotency.map((record) => [record.jobId, record]),
      );
      const retainedJobIds = new Set<string>();
      const recoveredActiveJobIds = new Set<string>();
      for (const job of loaded.jobs) {
        const binding = bindingByJob.get(job.jobId);
        const active = job.state === "QUEUED" || job.state === "RUNNING";
        if (
          !active &&
          (binding === undefined || binding.expiresAtMs <= startupNowMs)
        ) {
          continue;
        }
        const recovered: PersistedJobRecord = active
          ? {
              ...job,
              state: "FAILED",
              finishedAt: recoveredAt,
              error: {
                code: "RUNNER_RESTART_RECOVERED",
                retryable: true,
              },
            }
          : job;
        this.#jobs.set(recovered.jobId, recovered);
        retainedJobIds.add(recovered.jobId);
        if (active) {
          recoveredActiveJobIds.add(recovered.jobId);
        }
      }
      this.#idempotency.restore(
        loaded.idempotency
          .filter((record) => retainedJobIds.has(record.jobId))
          .map((record) => ({
            key: record.key,
            requestHash: record.requestHash,
            value: record.jobId,
            expiresAtMs: recoveredActiveJobIds.has(record.jobId)
              ? Math.max(
                  record.expiresAtMs,
                  startupNowMs + config.idempotencyTtlMs,
                )
              : record.expiresAtMs,
          })),
      );

      // This creates the initial 0600 journal and durably records restart
      // recovery and retention pruning before HTTP intake can begin.
    this.#stateStore.save(this.snapshot());
  }

  close(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
  }

  get queueDepth(): number {
    return this.#queue.depth;
  }

  get activeJobs(): number {
    return this.#queue.active;
  }

  submit(
    rawRequest: unknown,
    idempotencyKey: string,
    requestHash: string,
  ): SubmitResult {
    this.assertAvailable();
    if (!/^[a-f0-9]{64}$/.test(requestHash)) {
      throw new RunnerError(
        "BAD_REQUEST",
        "request hash must be lowercase SHA-256 hex",
        400,
      );
    }
    const nowMs = this.#clock();
    this.pruneExpiredTerminalJobs(nowMs);
    const existing = this.#idempotency.lookup(
      idempotencyKey,
      requestHash,
      nowMs,
      false,
    );
    if (existing !== undefined) {
      this.metrics.idempotencyHits += 1;
      const job = this.getJob(existing.value);
      if (job === undefined) {
        throw new RunnerError(
          "INFRASTRUCTURE_ERROR",
          "idempotent job record is unavailable",
          500,
          true,
        );
      }
      return { job, idempotencyHit: true };
    }

    // Existing durable bindings are resolved before this validation so a
    // replay survives runtime/image policy changes made after submission.
    const validated = validateJobRequest(rawRequest, this.#config);
    let result;
    try {
      result = this.#idempotency.getOrCreate(
        idempotencyKey,
        requestHash,
        () =>
          this.createJob(
            validated,
            idempotencyKey,
            requestHash,
            nowMs,
          ),
        nowMs,
        false,
      );
    } catch (error) {
      if (error instanceof RunnerError && error.code === "QUEUE_FULL") {
        this.metrics.queueRejected += 1;
      }
      throw error;
    }

    if (result.hit) {
      this.metrics.idempotencyHits += 1;
    }
    const job = this.getJob(result.value);
    if (job === undefined) {
      throw new RunnerError(
        "INFRASTRUCTURE_ERROR",
        "idempotent job record is unavailable",
        500,
        true,
      );
    }
    return { job, idempotencyHit: result.hit };
  }

  getJob(jobId: string): PublicJobRecord | undefined {
    this.assertAvailable();
    const stored = this.#jobs.get(jobId);
    if (stored === undefined) {
      return undefined;
    }
    return {
      jobId: stored.jobId,
      submissionId: stored.submissionId,
      correlationId: stored.correlationId,
      requestHash: stored.requestHash,
      state: stored.state,
      queuePosition:
        stored.state === "QUEUED" ? this.#queue.positionOf(jobId) : null,
      createdAt: stored.createdAt,
      ...(stored.startedAt === undefined
        ? {}
        : { startedAt: stored.startedAt }),
      ...(stored.finishedAt === undefined
        ? {}
        : { finishedAt: stored.finishedAt }),
      ...(stored.result === undefined ? {} : { result: stored.result }),
      ...(stored.error === undefined ? {} : { error: stored.error }),
    };
  }

  health(): {
    readonly status: "ok";
    readonly queueDepth: number;
    readonly activeJobs: number;
    readonly concurrency: number;
  } {
    this.assertAvailable();
    return {
      status: "ok",
      queueDepth: this.queueDepth,
      activeJobs: this.activeJobs,
      concurrency: this.#config.concurrency,
    };
  }

  private createJob(
    validated: ValidatedJob,
    idempotencyKey: string,
    requestHash: string,
    nowMs: number,
  ): string {
    if (!this.#queue.hasCapacity) {
      throw new RunnerError(
        "QUEUE_FULL",
        "runner queue is full",
        429,
        true,
      );
    }
    const jobId = this.#jobId();
    if (this.#jobs.has(jobId)) {
      throw new RunnerError(
        "INFRASTRUCTURE_ERROR",
        "runner generated a duplicate job ID",
        500,
        true,
      );
    }
    const initial: PersistedJobRecord = {
      jobId,
      submissionId: validated.request.submissionId,
      correlationId: validated.request.correlationId,
      requestHash,
      state: "QUEUED",
      createdAt: new Date(nowMs).toISOString(),
    };
    const binding: PersistedIdempotencyRecord = {
      key: idempotencyKey,
      requestHash,
      jobId,
      expiresAtMs: nowMs + this.#config.idempotencyTtlMs,
    };

    // The queue schedules work on a microtask. Persisting first means a crash
    // at any following instruction still leaves a recoverable idempotent job.
    this.persist(this.snapshot(initial, binding));
    this.#jobs.set(jobId, initial);

    let enqueued;
    try {
      enqueued = this.#queue.enqueue(
        jobId,
        () => this.#executor.execute(validated, requestHash),
        () => this.startJob(jobId),
      );
    } catch (error) {
      this.#jobs.delete(jobId);
      this.persist(this.snapshot());
      throw error;
    }

    this.metrics.jobsSubmitted += 1;
    void enqueued.completion.then(
      (executionResult) => this.completeJob(jobId, executionResult),
      (error: unknown) => this.failJob(jobId, error),
    );

    return jobId;
  }

  private startJob(jobId: string): void {
    this.assertAvailable();
    const current = this.#jobs.get(jobId);
    if (current === undefined || current.state !== "QUEUED") {
      throw new RunnerError(
        "INFRASTRUCTURE_ERROR",
        "queued job record is unavailable",
        500,
        true,
      );
    }
    const running: PersistedJobRecord = {
      ...current,
      state: "RUNNING",
      startedAt: new Date(this.#clock()).toISOString(),
    };
    this.persist(this.snapshot(running));
    this.#jobs.set(jobId, running);
  }

  private completeJob(jobId: string, executionResult: RunnerResult): void {
    if (this.#unavailable !== undefined || this.#closed) {
      return;
    }
    const current = this.#jobs.get(jobId);
    if (current === undefined || current.state !== "RUNNING") {
      return;
    }
    let result: RunnerResult;
    try {
      result = validatePublicRunnerResult(
        executionResult,
        current.requestHash,
      );
    } catch {
      this.failJob(
        jobId,
        new RunnerError(
          "INFRASTRUCTURE_ERROR",
          "executor returned an invalid result",
          500,
          true,
        ),
      );
      return;
    }
    const completed: PersistedJobRecord = {
      ...current,
      state: "COMPLETED",
      finishedAt: new Date(this.#clock()).toISOString(),
      result,
    };
    try {
      this.persist(this.snapshot(completed));
    } catch {
      return;
    }
    this.#jobs.set(jobId, completed);
    if (result.status === "INFRASTRUCTURE_ERROR") {
      this.metrics.jobsFailed += 1;
    } else {
      this.metrics.jobsCompleted += 1;
    }
    if (result.status === "TIMEOUT") {
      this.metrics.executionsTimedOut += 1;
    }
    if (result.status === "OUTPUT_LIMIT") {
      this.metrics.executionsOutputLimited += 1;
    }
  }

  private failJob(jobId: string, error: unknown): void {
    if (this.#unavailable !== undefined || this.#closed) {
      return;
    }
    const current = this.#jobs.get(jobId);
    if (current === undefined || current.state !== "RUNNING") {
      return;
    }
    const code =
      error instanceof RunnerError ? error.code : "INFRASTRUCTURE_ERROR";
    const retryable =
      error instanceof RunnerError ? error.retryable : true;
    const failed: PersistedJobRecord = {
      ...current,
      state: "FAILED",
      finishedAt: new Date(this.#clock()).toISOString(),
      error: { code, retryable },
    };
    try {
      this.persist(this.snapshot(failed));
    } catch {
      return;
    }
    this.#jobs.set(jobId, failed);
    this.metrics.jobsFailed += 1;
  }

  private snapshot(
    upsert?: PersistedJobRecord,
    extraBinding?: PersistedIdempotencyRecord,
  ): RunnerStateSnapshot {
    return this.snapshotFrom(
      [...this.#jobs.values()],
      this.#idempotency.snapshot(),
      upsert,
      extraBinding,
    );
  }

  private snapshotFrom(
    currentJobs: readonly PersistedJobRecord[],
    currentBindings: readonly IdempotencyRecord<string>[],
    upsert?: PersistedJobRecord,
    extraBinding?: PersistedIdempotencyRecord,
  ): RunnerStateSnapshot {
    const jobs = [...currentJobs];
    if (upsert !== undefined) {
      const index = jobs.findIndex((job) => job.jobId === upsert.jobId);
      if (index === -1) {
        jobs.push(upsert);
      } else {
        jobs[index] = upsert;
      }
    }
    const idempotency: PersistedIdempotencyRecord[] =
      currentBindings.map((record) => ({
        key: record.key,
        requestHash: record.requestHash,
        jobId: record.value,
        expiresAtMs: record.expiresAtMs,
      }));
    if (extraBinding !== undefined) {
      idempotency.push(extraBinding);
    }
    const recoveryJobs = jobs.map((job): PersistedJobRecord =>
      job.result === undefined
        ? job
        : {
            ...job,
            result: projectRunnerResult(job.result, job.requestHash),
          },
    );
    return { schemaVersion: 1, jobs: recoveryJobs, idempotency };
  }

  private pruneExpiredTerminalJobs(nowMs: number): void {
    const bindings = this.#idempotency.snapshot();
    const retainedBindings = bindings.filter((record) => {
      const job = this.#jobs.get(record.value);
      return (
        job !== undefined &&
        (job.state === "QUEUED" ||
          job.state === "RUNNING" ||
          record.expiresAtMs > nowMs)
      );
    });
    const retainedJobIds = new Set(
      retainedBindings.map((record) => record.value),
    );
    const retainedJobs = [...this.#jobs.values()].filter(
      (job) =>
        job.state === "QUEUED" ||
        job.state === "RUNNING" ||
        retainedJobIds.has(job.jobId),
    );
    if (
      retainedBindings.length === bindings.length &&
      retainedJobs.length === this.#jobs.size
    ) {
      return;
    }

    this.persist(this.snapshotFrom(retainedJobs, retainedBindings));
    const retainedKeys = new Set(
      retainedBindings.map((record) => record.key),
    );
    for (const record of bindings) {
      if (!retainedKeys.has(record.key)) {
        this.#idempotency.delete(record.key);
      }
    }
    for (const jobId of this.#jobs.keys()) {
      if (!retainedJobIds.has(jobId)) {
        this.#jobs.delete(jobId);
      }
    }
  }

  private persist(snapshot: RunnerStateSnapshot): void {
    try {
      this.#stateStore.save(snapshot);
    } catch (error) {
      const fatal =
        error instanceof Error
          ? error
          : new Error("runner state persistence failed");
      if (this.#unavailable === undefined) {
        this.#unavailable = fatal;
        try {
          this.#onFatalError?.(fatal);
        } catch {
          // The service remains fail-closed even if a supervisor hook fails.
        }
      }
      throw new RunnerError(
        "INFRASTRUCTURE_ERROR",
        "runner state persistence failed",
        500,
        true,
      );
    }
  }

  private assertAvailable(): void {
    if (this.#unavailable !== undefined || this.#closed) {
      throw new RunnerError(
        "INFRASTRUCTURE_ERROR",
        "runner is unavailable after a state persistence failure",
        503,
        true,
      );
    }
  }
}
