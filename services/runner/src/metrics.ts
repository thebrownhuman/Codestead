export class RunnerMetrics {
  jobsSubmitted = 0;
  jobsCompleted = 0;
  jobsFailed = 0;
  authFailures = 0;
  idempotencyHits = 0;
  queueRejected = 0;
  executionsTimedOut = 0;
  executionsOutputLimited = 0;
  readonly startedAtMs: number;

  constructor(startedAtMs = Date.now()) {
    this.startedAtMs = startedAtMs;
  }

  render(queueDepth: number, active: number, nowMs = Date.now()): string {
    const uptime = Math.max(0, (nowMs - this.startedAtMs) / 1_000);
    const lines = [
      "# HELP runner_uptime_seconds Process uptime.",
      "# TYPE runner_uptime_seconds gauge",
      `runner_uptime_seconds ${uptime}`,
      "# HELP runner_queue_depth Jobs waiting in FIFO order.",
      "# TYPE runner_queue_depth gauge",
      `runner_queue_depth ${queueDepth}`,
      "# HELP runner_active_jobs Currently executing jobs.",
      "# TYPE runner_active_jobs gauge",
      `runner_active_jobs ${active}`,
      "# TYPE runner_jobs_submitted_total counter",
      `runner_jobs_submitted_total ${this.jobsSubmitted}`,
      "# TYPE runner_jobs_completed_total counter",
      `runner_jobs_completed_total ${this.jobsCompleted}`,
      "# TYPE runner_jobs_failed_total counter",
      `runner_jobs_failed_total ${this.jobsFailed}`,
      "# TYPE runner_auth_failures_total counter",
      `runner_auth_failures_total ${this.authFailures}`,
      "# TYPE runner_idempotency_hits_total counter",
      `runner_idempotency_hits_total ${this.idempotencyHits}`,
      "# TYPE runner_queue_rejected_total counter",
      `runner_queue_rejected_total ${this.queueRejected}`,
      "# TYPE runner_execution_timeouts_total counter",
      `runner_execution_timeouts_total ${this.executionsTimedOut}`,
      "# TYPE runner_execution_output_limits_total counter",
      `runner_execution_output_limits_total ${this.executionsOutputLimited}`,
      "",
    ];
    return lines.join("\n");
  }
}
