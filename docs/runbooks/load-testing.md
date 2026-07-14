# Load and capacity testing

The repository includes a safe read-only smoke harness for repeatable HTTP latency evidence. It is deliberately not a substitute for the required Ubuntu NUC, PostgreSQL, two-runner-job, AI first-token, thermal, OOM, disk, and integrity test.

## Local baseline

Start a production-like application on loopback, then run:

```bash
LOAD_BASE_URL=http://127.0.0.1:3000 \
LOAD_CONCURRENCY=10 \
LOAD_REQUESTS_PER_SCENARIO=50 \
LOAD_P95_LIMIT_MS=1500 \
LOAD_REPORT_PATH=test-results/load-smoke.json \
npm run test:load:smoke
```

The harness warms each route once (up to `LOAD_WARMUP_TIMEOUT_MS`, default 60 seconds), then measures landing, catalog, learning home, roadmap, and review projections. A failed warm-up fails that scenario without creating a request storm. It records request counts, status/error aggregates, p50/p95/p99/max latency, platform, and exact thresholds without response bodies, cookies, or learner data. `LOAD_REPORT_PATH` fails closed outside `docs/evidence` or `test-results` and refuses to overwrite an existing report. Remote targets fail closed unless the operator explicitly sets `LOAD_ALLOW_REMOTE=1`; never run against a service you do not own.

For authenticated staging, provide a short-lived synthetic-account cookie through `LOAD_COOKIE` only in the process environment. Never put it in command history, reports, repository files, or chat. Revoke the session immediately after the run.

## Required NUC release drill

1. Use synthetic learners and a clean production-like database; never copy real learner data.
2. Hold ten active learner journeys while submitting exactly two hostile-but-bounded runner jobs and queueing additional jobs.
3. Measure normal API, practice submission, official runner queue/execution, and AI first-token p50/p95/p99 separately.
4. Record CPU frequency/temperature, memory, swap/OOM, disk I/O/capacity, PostgreSQL connections/locks, runner queue depth, container restarts, errors, and data-integrity checks.
5. Inject runner, provider, email, and database-reconnect failures; prove no duplicate official evidence, lost autosave, budget overspend, or secret/hidden-test leakage.
6. Bind the signed report to application/runtime image digests, migration head, content version, configuration hash, date, and operator.

The private pilot cannot claim `NFR-PERF-001` or `NFR-PERF-002` complete until the target NUC report exists.
