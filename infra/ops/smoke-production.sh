#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

fatal() {
  echo "fatal: $*" >&2
  exit 1
}

startup_wait=600
phase="full"
while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --phase)
      [[ "$#" -ge 2 ]] || fatal "--phase requires internal, public, or full"
      phase="$2"
      shift 2
      ;;
    --startup-wait)
      [[ "$#" -ge 2 ]] || fatal "--startup-wait requires a positive integer"
      startup_wait="$2"
      shift 2
      ;;
    *)
      fatal "unknown argument: $1"
      ;;
  esac
done

[[ "$startup_wait" =~ ^[1-9][0-9]*$ ]] || fatal "--startup-wait requires a positive integer"

[[ "$phase" == "internal" || "$phase" == "public" || "$phase" == "full" ]] || fatal "--phase requires internal, public, or full"
readonly compose_env="${COMPOSE_ENV_FILE:-/etc/learncoding/compose.env}"
readonly compose_file="${COMPOSE_FILE_PATH:-/opt/learncoding/compose.yaml}"

docker_bin="$(command -v docker || true)"
[[ -n "$docker_bin" ]] || fatal "docker is missing"
readonly docker_bin

timeout_bin="$(command -v timeout || true)"
[[ -n "$timeout_bin" ]] || fatal "GNU timeout is missing"
timeout_version="$($timeout_bin --version 2>/dev/null || true)"
[[ "$timeout_version" == *"GNU coreutils"* ]] || fatal "GNU timeout is required"
readonly timeout_bin

readonly deadline="$((SECONDS + startup_wait))"

run_compose() {
  local remaining="$((deadline - SECONDS))"
  (( remaining > 0 )) || return 124

  "$timeout_bin" --signal=KILL "${remaining}s" \
    "$docker_bin" compose --env-file "$compose_env" -f "$compose_file" "$@"
}

matches_exact_lines() {
  local actual="$1"
  shift
  local expected

  actual="$(printf '%s\n' "$actual" | tr -d '\r' | sed '/^[[:space:]]*$/d' | LC_ALL=C sort)"
  expected="$(printf '%s\n' "$@" | LC_ALL=C sort)"
  [[ "$actual" == "$expected" ]]
}

readonly -a pilot_services=(
  app
  cloudflared
  exam-finalization-worker
  file-erasure-worker
  mail-worker
  postgres
  practice-runner-recovery-worker
  project-review-correction-worker
  regrade-worker
  reward-worker
  runner-egress-gateway
)
readonly -a internal_running_services=(
  app
  exam-finalization-worker
  file-erasure-worker
  mail-worker
  postgres
  practice-runner-recovery-worker
  project-review-correction-worker
  regrade-worker
  reward-worker
  runner-egress-gateway
)
readonly -a public_running_services=(
  "${internal_running_services[@]}"
  cloudflared
)
readonly -a worker_services=(
  exam-finalization-worker
  file-erasure-worker
  mail-worker
  practice-runner-recovery-worker
  project-review-correction-worker
  regrade-worker
  reward-worker
)
readonly -a healthy_worker_lines=(
  exam-finalization-worker\|healthy
  file-erasure-worker\|healthy
  mail-worker\|healthy
  practice-runner-recovery-worker\|healthy
  project-review-correction-worker\|healthy
  regrade-worker\|healthy
  reward-worker\|healthy
)

configured_services="$(run_compose config --services)" || {
  fatal "unable to resolve the pilot service inventory"
}
matches_exact_lines "$configured_services" "${pilot_services[@]}" || {
  fatal "pilot service inventory drifted"
}

run_authenticated_probe() {
  run_compose exec -T app node - >/dev/null 2>&1 <<'NODE'
import { randomUUID } from "node:crypto";
import pg from "pg";
import { makeSignature } from "better-auth/crypto";

const { Pool } = pg;
const baseUrl = "http://127.0.0.1:3000";
const requiredEnvironment = ["DATABASE_URL", "BETTER_AUTH_SECRET"];
for (const name of requiredEnvironment) {
  if (!process.env[name]) throw new Error("SMOKE_ENVIRONMENT_MISSING");
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const userId = randomUUID();
const sessionId = randomUUID();
const sessionToken = randomUUID() + randomUUID();
const email = "production-smoke-" + randomUUID() + "@invalid.example";
const requestId = randomUUID();
const cookieName = "__Secure-learncoding.session_token";
const smokeFixtureName = "Production smoke learner";
const smokeFixturePattern = "production-smoke-%@invalid.example";
const smokeAdvisoryLock = "4842763169497701941";
let fixtureClient = null;
let fixtureLockHeld = false;
let probeFailed = false;

function invariant(value, code) {
  if (!value) throw new Error(code);
}

async function cleanupSyntheticFixtures(client) {
  await client.query("BEGIN");
  try {
    await client.query(
      `DELETE FROM runner_job
       WHERE submission_id IN (
         SELECT submission.id
         FROM code_submission AS submission
         JOIN "user" AS smoke_user ON smoke_user.id = submission.user_id
         WHERE smoke_user.name = $1
           AND smoke_user.role = 'learner'
           AND smoke_user.email LIKE $2
       )`,
      [smokeFixtureName, smokeFixturePattern],
    );
    await client.query(
      `DELETE FROM code_submission
       WHERE user_id IN (
         SELECT id FROM "user"
         WHERE name = $1 AND role = 'learner' AND email LIKE $2
       )`,
      [smokeFixtureName, smokeFixturePattern],
    );
    await client.query(
      "DELETE FROM \"user\" WHERE name = $1 AND role = 'learner' AND email LIKE $2",
      [smokeFixtureName, smokeFixturePattern],
    );
    await client.query("COMMIT");
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], "SMOKE_FIXTURE_ROLLBACK_FAILED");
    }
    throw error;
  }
}

async function jsonRequest(path, init = {}) {
  const response = await fetch(baseUrl + path, {
    redirect: "manual",
    ...init,
  });
  const body = await response.json().catch(() => null);
  return { response, body };
}

try {
  fixtureClient = await pool.connect();
  await fixtureClient.query(
    "SELECT pg_advisory_lock($1::bigint) AS locked",
    [smokeAdvisoryLock],
  );
  fixtureLockHeld = true;
  await cleanupSyntheticFixtures(fixtureClient);

  const migrations = await pool.query(
    "SELECT count(*)::int AS total, count(DISTINCT id)::int AS distinct_ids FROM drizzle.__drizzle_migrations",
  );
  invariant(
    Number(migrations.rows[0]?.total) > 0
      && migrations.rows[0]?.total === migrations.rows[0]?.distinct_ids,
    "MIGRATION_INVARIANT_FAILED",
  );

  const policies = await pool.query(
    "SELECT count(DISTINCT operation)::int AS total FROM provider_policy WHERE provider = 'nvidia_nim' AND enabled = true AND operation IN ('credential_validation', 'tutor')",
  );
  invariant(Number(policies.rows[0]?.total) === 2, "PROVIDER_POLICY_INVARIANT_FAILED");

  const achievement = await pool.query(
    "SELECT count(*)::int AS total FROM achievement WHERE slug = ANY($1::text[])",
    [[
      "first-independent-skill",
      "retained-one-week",
      "mastery-95",
      "project-evidence",
      "review-rhythm-8",
    ]],
  );
  invariant(Number(achievement.rows[0]?.total) === 5, "ACHIEVEMENT_INVARIANT_FAILED");

  const curriculum = await pool.query(
    "SELECT (SELECT count(*)::int FROM course) AS courses, (SELECT count(*)::int FROM module_project_template) AS projects",
  );
  invariant(
    Number(curriculum.rows[0]?.courses) > 0 && Number(curriculum.rows[0]?.projects) > 0,
    "CURRICULUM_INVARIANT_FAILED",
  );

  const admins = await pool.query(
    "SELECT count(*)::int AS total, min(lower(email)) AS email FROM \"user\" WHERE role = 'admin'",
  );
  invariant(Number(admins.rows[0]?.total) === 1, "ADMIN_COUNT_INVARIANT_FAILED");
  if (process.env.BOOTSTRAP_ADMIN_EMAIL) {
    invariant(
      admins.rows[0]?.email === process.env.BOOTSTRAP_ADMIN_EMAIL.toLowerCase(),
      "ADMIN_IDENTITY_INVARIANT_FAILED",
    );
  }

  await fixtureClient.query("BEGIN");
  try {
    await fixtureClient.query(
      "INSERT INTO \"user\" (id, name, email, email_verified, two_factor_enabled, role, status, must_change_password, adult_confirmed_at) VALUES ($1, $2, $3, true, true, 'learner', 'active', false, now())",
      [userId, smokeFixtureName, email],
    );
    await fixtureClient.query(
      "INSERT INTO learner_profile (user_id, onboarding_step, onboarding_completed_at) VALUES ($1, 'complete', now())",
      [userId],
    );
    await fixtureClient.query(
      "INSERT INTO session (id, expires_at, token, user_id, device_hash, device_label, mfa_verified_at) VALUES ($1, now() + interval '10 minutes', $2, $3, $4, 'production-smoke', now())",
      [sessionId, sessionToken, userId, "production-smoke-device"],
    );
    await fixtureClient.query(
      "INSERT INTO consent_record (user_id, purpose, policy_version, decision, data_categories, source, idempotency_key) VALUES ($1, 'server_code_execution', 'enrollment-disclosure-2026-07-12.v2', 'accepted', $2::jsonb, 'system_migration', $3)",
      [userId, JSON.stringify(["source-code", "standard-input", "test-results"]), "production-smoke-" + userId],
    );
    await fixtureClient.query("COMMIT");
  } catch (error) {
    await fixtureClient.query("ROLLBACK");
    throw error;
  }

  const signature = await makeSignature(sessionToken, process.env.BETTER_AUTH_SECRET);
  const cookie = cookieName + "=" + encodeURIComponent(sessionToken + "." + signature);
  const authenticatedHeaders = { cookie };

  const anonymousFiles = await jsonRequest("/api/files");
  invariant(anonymousFiles.response.status === 401, "ANONYMOUS_AUTH_INVARIANT_FAILED");

  const authenticatedSession = await jsonRequest("/api/auth/get-session", {
    headers: authenticatedHeaders,
  });
  invariant(
    authenticatedSession.response.status === 200
      && authenticatedSession.body?.user?.id === userId
      && authenticatedSession.body?.session?.id === sessionId,
    "AUTHENTICATED_SESSION_INVARIANT_FAILED",
  );

  const files = await jsonRequest("/api/files", { headers: authenticatedHeaders });
  invariant(
    files.response.status === 200
      && Array.isArray(files.body?.files)
      && files.body?.uploadsEnabled === false,
    "AUTHENTICATED_FILES_INVARIANT_FAILED",
  );

  const beforeUpload = await pool.query(
    "SELECT count(*)::int AS total FROM stored_object WHERE owner_user_id = $1",
    [userId],
  );
  const form = new FormData();
  form.append("file", new Blob(["production smoke"], { type: "text/plain" }), "smoke.txt");
  const upload = await jsonRequest("/api/files", {
    method: "POST",
    headers: authenticatedHeaders,
    body: form,
  });
  const afterUpload = await pool.query(
    "SELECT count(*)::int AS total FROM stored_object WHERE owner_user_id = $1",
    [userId],
  );
  invariant(
    upload.response.status === 503
      && upload.body?.code === "UPLOADS_DISABLED"
      && beforeUpload.rows[0]?.total === afterUpload.rows[0]?.total,
    "UPLOADS_DISABLED_INVARIANT_FAILED",
  );

  const availability = await jsonRequest("/api/code/run", { headers: authenticatedHeaders });
  invariant(
    availability.response.status === 200
      && availability.body?.available === true
      && Number(availability.body?.concurrency) === 2,
    "RUNNER_HEALTH_INVARIANT_FAILED",
  );

  const run = await jsonRequest("/api/code/run", {
    method: "POST",
    headers: { ...authenticatedHeaders, "content-type": "application/json" },
    body: JSON.stringify({
      language: "python",
      source: "print('codestead-production-smoke')",
      mode: "quick_run",
      clientRequestId: requestId,
    }),
  });
  invariant(
    run.response.status === 200
      && run.body?.status === "accepted"
      && run.body?.stdout === "codestead-production-smoke\n"
      && run.body?.stderr === ""
      && run.body?.exitCode === 0
      && run.body?.officialMasteryEvidence === false
      && /^sha256:[0-9a-f]{64}$/.test(run.body?.imageDigest ?? ""),
    "PYTHON_RUNNER_INVARIANT_FAILED",
  );

  await pool.query("DELETE FROM session WHERE id = $1", [sessionId]);
  const revoked = await jsonRequest("/api/files", { headers: authenticatedHeaders });
  invariant(revoked.response.status === 401, "SESSION_REVOCATION_INVARIANT_FAILED");

} catch {
  probeFailed = true;
} finally {
  let destroyClient = false;
  if (fixtureClient) {
    try {
      await cleanupSyntheticFixtures(fixtureClient);
    } catch {
      probeFailed = true;
      destroyClient = true;
    }
    if (fixtureLockHeld) {
      try {
        const unlocked = await fixtureClient.query(
          "SELECT pg_advisory_unlock($1::bigint) AS unlocked",
          [smokeAdvisoryLock],
        );
        invariant(unlocked.rows[0]?.unlocked === true, "SMOKE_ADVISORY_UNLOCK_FAILED");
      } catch {
        probeFailed = true;
        destroyClient = true;
      }
    }
    try {
      fixtureClient.release(destroyClient);
    } catch {
      probeFailed = true;
    }
  }
  try {
    await pool.end();
  } catch {
    probeFailed = true;
  }
}
if (probeFailed) {
  process.stderr.write("production authenticated smoke failed\n");
  process.exitCode = 1;
} else {
  process.stdout.write("production authenticated smoke passed\n");
}
NODE
}

run_runner_route_probe() {
  local app_route
  local gateway_route

  app_route="$(run_compose exec -T app ip -4 route get 172.29.41.2 2>/dev/null)" || return 1
  app_route="$(printf '%s\n' "$app_route" | tr -d '\r' | sed -e 's/[[:space:]]\+/ /g' -e 's/^ //' -e 's/ $//')"
  [[ "$app_route" =~ ^172\.29\.41\.2[[:space:]]+dev[[:space:]]+runner-client[[:space:]]+src[[:space:]]+172\.29\.41\.[0-9]+([[:space:]]|$) ]] || {
    return 1
  }

  gateway_route="$(run_compose exec -T runner-egress-gateway ip -4 route get 192.168.122.12 2>/dev/null)" || {
    return 1
  }
  gateway_route="$(printf '%s\n' "$gateway_route" | tr -d '\r' | sed -e 's/[[:space:]]\+/ /g' -e 's/^ //' -e 's/ $//')"
  [[ "$gateway_route" =~ ^192\.168\.122\.12[[:space:]]+via[[:space:]]+172\.29\.40\.1[[:space:]]+dev[[:space:]]+runner-egress[[:space:]]+src[[:space:]]+172\.29\.40\.2([[:space:]]|$) ]] || {
    return 1
  }
}

run_public_probe() {
  run_compose exec -T app node - >/dev/null 2>&1 <<'NODE'
const publicUrl = new URL(process.env.APP_URL ?? "");
if (publicUrl.protocol !== "https:" || publicUrl.pathname !== "/" || publicUrl.search || publicUrl.hash) {
  throw new Error("PUBLIC_ORIGIN_INVALID");
}

const response = await fetch(new URL("/health/ready", publicUrl), { redirect: "manual" });
const body = await response.json().catch(() => null);
const responseUrl = new URL(response.url);
const exactOrigin = responseUrl.origin === publicUrl.origin && responseUrl.pathname === "/health/ready";
const has = (name, expected) => (response.headers.get(name) ?? "").toLowerCase().includes(expected);

if (
  response.status !== 200
  || !exactOrigin
  || body?.status !== "ready"
  || !has("content-type", "application/json")
  || !has("cache-control", "no-store")
  || !has("strict-transport-security", "max-age=31536000")
  || !has("content-security-policy", "frame-ancestors 'none'")
  || !has("content-security-policy", "upgrade-insecure-requests")
  || !has("x-content-type-options", "nosniff")
  || !has("x-frame-options", "deny")
  || !has("referrer-policy", "strict-origin-when-cross-origin")
  || !response.headers.get("permissions-policy")
) {
  throw new Error("PUBLIC_HTTPS_INVARIANT_FAILED");
}
process.stdout.write("production public smoke passed\n");
NODE
}

probe_once() {
  local all_services
  local active_services
  local durability
  local tunnel_health
  local worker_health
  local -a expected_running

  all_services="$(run_compose ps --all --services 2>/dev/null)" || return 1
  matches_exact_lines "$all_services" "${pilot_services[@]}" || return 1

  active_services="$(run_compose ps --services --status running 2>/dev/null)" || return 1
  if [[ "$phase" == "internal" ]]; then
    expected_running=("${internal_running_services[@]}")
  else
    expected_running=("${public_running_services[@]}")
  fi
  matches_exact_lines "$active_services" "${expected_running[@]}" || return 1

  worker_health="$(run_compose ps --all --format '{{.Service}}|{{.Health}}' \
    "${worker_services[@]}" 2>/dev/null)" || return 1
  matches_exact_lines "$worker_health" "${healthy_worker_lines[@]}" || return 1

  run_compose exec -T app node -e \
    "fetch('http://127.0.0.1:3000/health/ready', { redirect: 'manual' }).then((response) => { if (response.status !== 200) process.exit(1); }).catch(() => process.exit(1));" \
    >/dev/null 2>&1 || return 1

  run_compose exec -T app node -e \
    'if (process.env.UPLOADS_ENABLED !== "false") process.exit(1);' \
    >/dev/null 2>&1 || return 1

  # shellcheck disable=SC2016 # PostgreSQL variables expand inside the container shell.
  durability="$(run_compose exec -T postgres sh -ceu \
    'exec psql --host=/run/learncoding-postgres --no-psqlrc --tuples-only --no-align --set=ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --command "show fsync; show synchronous_commit; show full_page_writes;"' \
    2>/dev/null)" || return 1
  durability="$(printf '%s\n' "$durability" | tr -d '\r' | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' -e '/^$/d')"
  [[ "$durability" == $'on\non\non' ]] || return 1

  if [[ "$phase" != "internal" ]]; then
    tunnel_health="$(run_compose ps --all --format '{{.Health}}' cloudflared 2>/dev/null)" || return 1
    tunnel_health="$(printf '%s\n' "$tunnel_health" | tr -d '\r' | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
    [[ "$tunnel_health" == "healthy" ]] || return 1
  fi
}

infrastructure_ready=false
while (( SECONDS < deadline )); do
  if probe_once; then
    infrastructure_ready=true
    break
  fi

  remaining="$((deadline - SECONDS))"
  (( remaining > 0 )) || break
  sleep 1
done

[[ "$infrastructure_ready" == "true" ]] || fatal "production smoke failed before the startup deadline"

run_runner_route_probe || fatal "runner route proof failed"

if [[ "$phase" == "internal" || "$phase" == "full" ]]; then
  run_authenticated_probe || fatal "authenticated application smoke failed"
fi

if [[ "$phase" == "public" || "$phase" == "full" ]]; then
  run_public_probe || fatal "public HTTPS smoke failed"
fi

printf '%s\n' "production smoke passed"
