#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
checker="$repo_root/infra/ops/check-recovery.sh"
tmp_base="$(cd "${TMPDIR:-/tmp}" && pwd -P)"
work="$(mktemp -d "$tmp_base/power-recovery-check.XXXXXX")"
work="$(cd "$work" && pwd -P)"
[[ ! -L "$work" && "$work" == "$tmp_base"/* ]] || {
  echo 'FAIL: recovery checker fixture escaped its verified temporary root' >&2
  exit 1
}
chmod 0700 "$work"
cleanup() {
  if [[ -n "${work:-}" && -d "$work" && ! -L "$work" && "$work" == "$tmp_base"/* ]]; then
    rm -rf -- "$work"
  fi
}
trap cleanup EXIT

if [[ ! -f "$checker" ]]; then
  echo 'power recovery checker contract failed:' >&2
  echo '- missing later-task production asset: infra/ops/check-recovery.sh' >&2
  exit 1
fi

if (( EUID != 0 )); then
  if command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then
    cleanup
    trap - EXIT
    exec sudo -n bash "$repo_root/infra/tests/power-recovery-check.test.sh"
  fi
  echo 'FAIL: power recovery checker contract requires passwordless sudo for root-owned fixture metadata' >&2
  exit 1
fi

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

if grep -Eq '/(usr/)?s?bin/(systemctl|virsh|docker|curl|date|sleep|journalctl|findmnt|smartctl|mount|umount|nft|ping|nc|wget|stat|realpath|readlink|cat)([[:space:]"'\'']|$)' "$checker"; then
  fail 'recovery checker hard-codes a host command path and can bypass the isolated fake PATH'
fi
grep -Fq 'RECOVERY_CHECK_TEST_ROOT' "$checker" || fail 'recovery checker is missing the single narrow test-root seam'
grep -Fq '/etc/learncoding/existing-containers.txt' "$checker" || fail 'recovery checker changed the protected production baseline path'

host_root="$work/host-root"
fake_bin="$work/bin"
state_root="$work/state"
events="$work/events.log"
scenario_file="$state_root/scenario"
clock_file="$state_root/clock"
runner_body_file="$state_root/runner-body"
runner_signature_file="$state_root/runner-signature"
runner_concurrency_body_file="$state_root/runner-concurrency-body"
runner_concurrency_signature_file="$state_root/runner-concurrency-signature"
runner_expired_body_file="$state_root/runner-expired-body"
runner_expired_signature_file="$state_root/runner-expired-signature"
baseline="$host_root/etc/learncoding/existing-containers.txt"
runner_secret_file="$host_root/etc/learncoding/secrets/runner_shared_secret"
mkdir -m 0700 -p "$fake_bin" "$state_root" "$host_root/etc/learncoding/secrets"
printf '%s\n' legacy-alpha legacy-bravo >"$baseline"
chown 0:0 "$baseline"
chmod 0600 "$baseline"

secret_canary='RECOVERY_SECRET_CANARY_0cbb4185_DO_NOT_PRINT'
learner_canary='RECOVERY_LEARNER_CANARY_learner@example.invalid'
source_canary='RECOVERY_SOURCE_CANARY_console_log_private'
stdin_canary='RECOVERY_STDIN_CANARY_32bc43ef'
http_body_canary='RECOVERY_HTTP_BODY_CANARY_00d1ce39'
http_header_canary='RECOVERY_HTTP_HEADER_CANARY_60a55377'
runner_output_canary='RECOVERY_RUNNER_OUTPUT_CANARY_9635fa2d'
runner_journal_canary='RECOVERY_RUNNER_JOURNAL_CANARY_9add3ec1'
raw_command_canary='RECOVERY_RAW_COMMAND_CANARY_e31db02f'
printf '%s' "fixture-runner-secret-at-least-32-bytes-$secret_canary" >"$runner_secret_file"
chown 0:0 "$runner_secret_file"
chmod 0440 "$runner_secret_file"
printf '%s' '{"status":"ok","queueDepth":0,"activeJobs":0,"concurrency":2,"generatedAtEpoch":1784116800}' >"$runner_body_file"
printf '%s' '{"status":"ok","queueDepth":0,"activeJobs":0,"concurrency":3,"generatedAtEpoch":1784116800}' >"$runner_concurrency_body_file"
printf '%s' '{"status":"ok","queueDepth":0,"activeJobs":0,"concurrency":2,"generatedAtEpoch":1784116200}' >"$runner_expired_body_file"

sign_runner_body() {
  local body_file="$1"
  local signature_file="$2"
  RUNNER_SECRET_FILE="$runner_secret_file" RUNNER_BODY_FILE="$body_file" \
    node -e '
    const fs = require("node:fs");
    const { createHash, createHmac } = require("node:crypto");
    const secret = fs.readFileSync(process.env.RUNNER_SECRET_FILE, "utf8");
    const body = fs.readFileSync(process.env.RUNNER_BODY_FILE, "utf8");
    const hash = createHash("sha256").update(body).digest("hex");
    process.stdout.write(`sha256=${createHmac("sha256", secret).update(`recovery-health-fixture-0001\n200\n${hash}`).digest("hex")}`);
  ' >"$signature_file"
}
sign_runner_body "$runner_body_file" "$runner_signature_file"
sign_runner_body "$runner_concurrency_body_file" "$runner_concurrency_signature_file"
sign_runner_body "$runner_expired_body_file" "$runner_expired_signature_file"

cat >"$fake_bin/fake-recovery-command" <<'FAKE'
#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

command_name="${0##*/}"
{
  printf '%q' "$command_name"
  for argument in "$@"; do printf ' %q' "$argument"; done
  printf '\n'
} >>"$FAKE_EVENTS"

scenario="$(<"$FAKE_SCENARIO_FILE")"
clock="$(<"$FAKE_CLOCK_FILE")"
delayed=false
if [[ "$scenario" == delayed && "$clock" -lt 30 ]]; then delayed=true; fi

case "$command_name" in
  date)
    [[ "$#" == 1 && "$1" == +%s ]] || exit 64
    printf '%s\n' "$((1784116800 + clock))"
    ;;
  sleep)
    [[ "$#" == 1 && "$1" == 10 ]] || exit 64
    if [[ "$scenario" == delayed || "$scenario" == permanent ]]; then
      next=$((clock + 10))
    else
      next=900
    fi
    (( next <= 900 )) || exit 98
    printf '%s' "$next" >"$FAKE_CLOCK_FILE"
    ;;
  systemctl)
    verb="${1:-}"
    unit="${2:-}"
    case "$verb" in
      is-active)
        if [[ "$delayed" == true ]]; then exit 3; fi
        if [[ "$scenario" == permanent && "$unit" == learncoding-compose.service ]]; then exit 3; fi
        if [[ "$scenario" == docker-down && "$unit" == docker.service ]]; then exit 3; fi
        if [[ "$scenario" == libvirt-down && "$unit" == libvirtd.service ]]; then exit 3; fi
        if [[ "$scenario" == firewall-down && "$unit" == learncoding-runner-firewall.service ]]; then exit 3; fi
        if [[ "$scenario" == timer-incomplete && "$unit" == *.timer ]]; then exit 3; fi
        case "$unit" in
          docker.service|libvirtd.service|learncoding-runner-firewall.service|learncoding-compose.service|learncoding-backup.timer|learncoding-backup-check.timer|learncoding-retention.timer|learncoding-recovery-check.timer)
            printf '%s\n' active ;;
          *) exit 64 ;;
        esac
        ;;
      is-enabled)
        if [[ "$scenario" == timer-incomplete && "$unit" == learncoding-retention.timer ]]; then printf '%s\n' disabled; exit 1; fi
        if [[ "$scenario" == timer-malformed && "$unit" == learncoding-retention.timer ]]; then printf '%s\n' 'enabled unexpected'; exit 0; fi
        case "$unit" in
          learncoding-backup.timer|learncoding-backup-check.timer|learncoding-retention.timer|learncoding-recovery-check.timer)
            printf '%s\n' enabled ;;
          *) exit 64 ;;
        esac
        ;;
      *) exit 64 ;;
    esac
    ;;
  virsh)
    if [[ "${1:-}" == --connect && "${2:-}" == qemu:///system ]]; then shift 2; fi
    case "${1:-}:${2:-}" in
      domstate:codestead-runner)
        if [[ "$scenario" == runner-inactive || "$delayed" == true ]]; then printf '%s\n' 'shut off'; else printf '%s\n' running; fi
        ;;
      dominfo:codestead-runner)
        autostart=enable
        [[ "$scenario" == runner-no-autostart ]] && autostart=disable
        printf '%s\n' 'Name: codestead-runner' "Autostart: $autostart"
        ;;
      net-info:codestead-runner)
        active=yes
        autostart=yes
        [[ "$scenario" == runner-network-inactive ]] && active=no
        [[ "$scenario" == runner-network-no-autostart ]] && autostart=no
        printf '%s\n' 'Name: codestead-runner' "Active: $active" "Autostart: $autostart"
        ;;
      *) exit 64 ;;
    esac
    ;;
  docker)
    joined=" $* "
    if [[ "$joined" == *' info '* || "${1:-}" == info ]]; then
      [[ "$delayed" == false && "$scenario" != docker-down ]] || exit 1
      exit 0
    fi
    if [[ "$joined" == *' pg_isready '* ]]; then
      [[ "$scenario" != postgres-unhealthy && "$delayed" == false ]] || exit 1
      printf '%s\n' 'accepting connections'
      exit 0
    fi
    if [[ "$joined" == *' pg_settings '* || "$joined" == *' synchronous_commit '* ]]; then
      case "$scenario" in
        postgres-fsync-off) printf '%s\n' 'fsync|off' 'synchronous_commit|on' 'full_page_writes|on' ;;
        postgres-sync-off) printf '%s\n' 'fsync|on' 'synchronous_commit|off' 'full_page_writes|on' ;;
        postgres-full-page-off) printf '%s\n' 'fsync|on' 'synchronous_commit|on' 'full_page_writes|off' ;;
        *) printf '%s\n' 'fsync|on' 'synchronous_commit|on' 'full_page_writes|on' ;;
      esac
      exit 0
    fi
    if [[ "$joined" == *' compose '* && "$joined" == *' ps '* ]]; then
      [[ "$delayed" == false ]] || exit 1
      case "$scenario" in
        worker-malformed) printf '%s\n' '{malformed-compose-status' ;;
        app-incomplete) printf '%s\n' '[{"Service":"postgres","State":"running","Health":"healthy"}]' ;;
        app-malformed) printf '%s\n' '[{"Service":"app","State":"mystery","Health":"healthy"}]' ;;
        worker-incomplete) printf '%s\n' '[{"Service":"app","State":"running","Health":"healthy"},{"Service":"mail-worker","State":"running","Health":"healthy"}]' ;;
        cloudflared-incomplete) printf '%s\n' '[{"Service":"app","State":"running","Health":"healthy"}]' ;;
        cloudflared-malformed) printf '%s\n' '[{"Service":"cloudflared","State":"running","Health":"unknown"}]' ;;
        *)
          printf '%s\n' "[{\"Service\":\"app\",\"State\":\"running\",\"Health\":\"healthy\"},{\"Service\":\"mail-worker\",\"State\":\"running\",\"Health\":\"healthy\"},{\"Service\":\"reward-worker\",\"State\":\"running\",\"Health\":\"healthy\"},{\"Service\":\"regrade-worker\",\"State\":\"running\",\"Health\":\"healthy\"},{\"Service\":\"exam-finalization-worker\",\"State\":\"running\",\"Health\":\"healthy\"},{\"Service\":\"practice-runner-recovery-worker\",\"State\":\"running\",\"Health\":\"healthy\"},{\"Service\":\"project-review-correction-worker\",\"State\":\"running\",\"Health\":\"healthy\"},{\"Service\":\"cloudflared\",\"State\":\"running\",\"Health\":\"healthy\",\"Ignored\":\"$FAKE_RAW_COMMAND_CANARY\"}]"
          ;;
      esac
      exit 0
    fi
    if [[ "$joined" == *' ps '* || "${1:-}" == ps ]]; then
      [[ "$delayed" == false ]] || { printf '%s\n' legacy-alpha; exit 0; }
      printf '%s\n' legacy-alpha
      [[ "$scenario" == existing-stopped ]] || printf '%s\n' legacy-bravo
      printf '%s\n' learncoding-postgres learncoding-app learncoding-mail-worker learncoding-reward-worker \
        learncoding-regrade-worker learncoding-exam-finalization-worker learncoding-practice-runner-recovery-worker \
        learncoding-project-review-correction-worker learncoding-cloudflared
      exit 0
    fi
    exit 64
    ;;
  curl)
    output=
    headers=
    url=
    while (( $# > 0 )); do
      case "$1" in
        --output|-o) output="$2"; shift 2 ;;
        --dump-header|-D) headers="$2"; shift 2 ;;
        http://*|https://*) url="$1"; shift ;;
        *) shift ;;
      esac
    done
    [[ -n "$url" ]] || exit 64
    body=
    header_text=
    if [[ "$url" == http://10.20.0.12:4100/healthz ]]; then
      case "$scenario" in
        runner-malformed) body='{malformed-json' ;;
        runner-concurrency) body="$(<"$FAKE_RUNNER_CONCURRENCY_BODY_FILE")" ;;
        runner-expired) body="$(<"$FAKE_RUNNER_EXPIRED_BODY_FILE")" ;;
        *) body="$(<"$FAKE_RUNNER_BODY_FILE")" ;;
      esac
      signature="$(<"$FAKE_RUNNER_SIGNATURE_FILE")"
      [[ "$scenario" == runner-concurrency ]] && signature="$(<"$FAKE_RUNNER_CONCURRENCY_SIGNATURE_FILE")"
      [[ "$scenario" == runner-expired ]] && signature="$(<"$FAKE_RUNNER_EXPIRED_SIGNATURE_FILE")"
      [[ "$scenario" == runner-tampered ]] && signature="sha256=$(printf '0%.0s' {1..64})"
      header_text="HTTP/1.1 200 OK
x-request-id: recovery-health-fixture-0001
x-runner-response-signature: $signature
x-runner-debug: $FAKE_RUNNER_OUTPUT_CANARY"
    else
      [[ "$url" == https://pilot.example.test/health/ready ]] || exit 97
      [[ "$scenario" != public-fail && "$delayed" == false ]] || exit 22
      if [[ "$scenario" == public-origin ]]; then
        body="{\"status\":\"wrong-origin\",\"ignored\":\"$FAKE_HTTP_BODY_CANARY\"}"
      else
        body="{\"status\":\"ok\",\"ignored\":\"$FAKE_HTTP_BODY_CANARY\"}"
      fi
      if [[ "$scenario" == public-headers ]]; then
        header_text="HTTP/2 200
x-fixture-private: $FAKE_HTTP_HEADER_CANARY"
      else
        header_text="HTTP/2 200
strict-transport-security: max-age=31536000
content-security-policy: default-src 'self'
x-content-type-options: nosniff
x-fixture-private: $FAKE_HTTP_HEADER_CANARY"
      fi
    fi
    if [[ -n "$output" ]]; then printf '%s' "$body" >"$output"; else printf '%s' "$body"; fi
    if [[ -n "$headers" ]]; then printf '%s\n' "$header_text" >"$headers"; fi
    ;;
  stat|realpath|readlink|cat)
    target="${!#}"
    [[ "$target" == "$FAKE_HOST_ROOT"/* || "$target" == "$FAKE_STATE_ROOT"/* ]] || exit 97
    "/usr/bin/$command_name" "$@"
    ;;
  journalctl|findmnt|smartctl|mount|umount|nft|ping|nc|wget)
    printf '%s\n' "$FAKE_RUNNER_JOURNAL_CANARY" >&2
    exit 97
    ;;
  *) exit 64 ;;
esac
FAKE
chmod 0755 "$fake_bin/fake-recovery-command"
for command_name in systemctl virsh docker curl date sleep stat realpath readlink cat \
  journalctl findmnt smartctl mount umount nft ping nc wget; do
  cp "$fake_bin/fake-recovery-command" "$fake_bin/$command_name"
done

run_checker() {
  local scenario="$1"
  local prefix="$2"
  printf '%s' "$scenario" >"$scenario_file"
  printf '%s' 0 >"$clock_file"
  : >"$events"
  set +e
  printf '%s' "$stdin_canary" | env -i \
    HOME="$work" \
    PATH="$fake_bin:/usr/bin:/bin" \
    RECOVERY_CHECK_TEST_ROOT="$host_root" \
    RECOVERY_PUBLIC_URL='https://pilot.example.test/health/ready' \
    RUNNER_BASE_URL='http://10.20.0.12:4100' \
    RUNNER_SHARED_SECRET_FILE="$runner_secret_file" \
    FAKE_EVENTS="$events" \
    FAKE_SCENARIO_FILE="$scenario_file" \
    FAKE_STATE_ROOT="$state_root" \
    FAKE_HOST_ROOT="$host_root" \
    FAKE_CLOCK_FILE="$clock_file" \
    FAKE_RUNNER_BODY_FILE="$runner_body_file" \
    FAKE_RUNNER_SIGNATURE_FILE="$runner_signature_file" \
    FAKE_RUNNER_CONCURRENCY_BODY_FILE="$runner_concurrency_body_file" \
    FAKE_RUNNER_CONCURRENCY_SIGNATURE_FILE="$runner_concurrency_signature_file" \
    FAKE_RUNNER_EXPIRED_BODY_FILE="$runner_expired_body_file" \
    FAKE_RUNNER_EXPIRED_SIGNATURE_FILE="$runner_expired_signature_file" \
    FAKE_HTTP_BODY_CANARY="$http_body_canary" \
    FAKE_HTTP_HEADER_CANARY="$http_header_canary" \
    FAKE_RUNNER_OUTPUT_CANARY="$runner_output_canary" \
    FAKE_RUNNER_JOURNAL_CANARY="$runner_journal_canary" \
    FAKE_RAW_COMMAND_CANARY="$raw_command_canary" \
    bash "$checker" >"$prefix.stdout" 2>"$prefix.stderr"
  checker_status=$?
  set -e
}

validate_json_contract() {
  local output_file="$1"
  local expected_recovered="$2"
  local expected_timeout="$3"
  local line_count
  line_count="$(grep -cve '^[[:space:]]*$' "$output_file" || true)"
  [[ "$line_count" == 1 ]] || fail "checker must emit exactly one final JSON object: ${output_file##*/}"
  EXPECTED_RECOVERED="$expected_recovered" EXPECTED_TIMEOUT="$expected_timeout" OUTPUT_FILE="$output_file" node <<'NODE'
const fs = require("node:fs");
const allowed = [
  "appHealthy", "cloudflaredHealthy", "dockerHealthy", "elapsedSeconds",
  "existingContainersExpected", "existingContainersRunning", "firewallHealthy",
  "libvirtHealthy", "postgresDurable", "postgresHealthy", "publicHttpsHealthy",
  "recovered", "runnerHealthy", "schemaVersion", "timedOut", "timersHealthy", "workersHealthy",
].sort();
const value = JSON.parse(fs.readFileSync(process.env.OUTPUT_FILE, "utf8"));
if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(allowed)) process.exit(2);
if (value.schemaVersion !== 1) process.exit(3);
for (const key of allowed.filter((key) => key.endsWith("Healthy") || key === "postgresDurable" || key === "recovered" || key === "timedOut")) {
  if (typeof value[key] !== "boolean") process.exit(4);
}
for (const key of ["elapsedSeconds", "existingContainersExpected", "existingContainersRunning"]) {
  if (!Number.isSafeInteger(value[key]) || value[key] < 0) process.exit(5);
}
if (value.recovered !== (process.env.EXPECTED_RECOVERED === "true")) process.exit(6);
if (value.timedOut !== (process.env.EXPECTED_TIMEOUT === "true")) process.exit(7);
if (value.elapsedSeconds > 900) process.exit(8);
if (value.existingContainersRunning > value.existingContainersExpected) process.exit(9);
if (value.recovered && (value.existingContainersExpected !== 2 || value.existingContainersRunning !== 2)) process.exit(10);
NODE
}

assert_private_result() {
  local prefix="$1"
  local canary
  for canary in "$secret_canary" "$learner_canary" "$source_canary" "$stdin_canary" \
    "$http_body_canary" "$http_header_canary" "$runner_output_canary" "$runner_journal_canary" "$raw_command_canary"; do
    ! grep -Fq -- "$canary" "$prefix.stdout" || fail "checker leaked a canary to stdout: $canary"
    ! grep -Fq -- "$canary" "$prefix.stderr" || fail "checker leaked a canary to stderr: $canary"
    ! grep -Fq -- "$canary" "$events" || fail "fake event log captured private command data: $canary"
  done
  for private_name in legacy-alpha legacy-bravo; do
    ! grep -Fq -- "$private_name" "$prefix.stdout" || fail 'checker emitted a baseline container name'
    ! grep -Fq -- "$private_name" "$prefix.stderr" || fail 'checker echoed an unsafe baseline container name'
  done
  ! grep -Eq '/var/lib/learncoding-runner|journalctl[^\n]*learncoding-runner([[:space:].]|$)' "$events" ||
    fail 'checker attempted to inspect runner state or journal data'
  [[ ! -s "$prefix.stderr" ]] || fail "checker emitted progress or raw command output: $(<"$prefix.stderr")"
}

expect_result() {
  local scenario="$1"
  local expected_status="$2"
  local expected_recovered="$3"
  local expected_timeout="$4"
  local prefix="$work/result-$scenario"
  run_checker "$scenario" "$prefix"
  if [[ "$expected_status" == zero ]]; then
    (( checker_status == 0 )) || fail "$scenario returned $checker_status, expected zero"
  else
    (( checker_status != 0 )) || fail "$scenario returned zero, expected nonzero"
  fi
  validate_json_contract "$prefix.stdout" "$expected_recovered" "$expected_timeout"
  assert_private_result "$prefix"
}

expect_result immediate zero true false
expect_result delayed zero true false
[[ "$(<"$clock_file")" == 30 ]] || fail 'delayed recovery did not use the virtual monotonic clock'

expect_result permanent nonzero false true
[[ "$(<"$clock_file")" == 900 ]] || fail 'permanent failure did not stop exactly at the 900-second bound'
last_sleep="$(grep '^sleep ' "$events" | tail -n 1)"
[[ "$last_sleep" == 'sleep 10' ]] || fail 'permanent failure used an unexpected polling sleep'

for scenario in \
  docker-down libvirt-down firewall-down public-fail public-headers public-origin existing-stopped \
  runner-inactive runner-no-autostart runner-network-inactive runner-network-no-autostart \
  runner-malformed runner-expired runner-tampered runner-concurrency \
  postgres-unhealthy postgres-fsync-off postgres-sync-off postgres-full-page-off app-incomplete app-malformed \
  worker-incomplete worker-malformed cloudflared-incomplete cloudflared-malformed timer-incomplete timer-malformed; do
  expect_result "$scenario" nonzero false true
done
EXISTING_STOPPED_FILE="$work/result-existing-stopped.stdout" node <<'NODE'
const fs = require("node:fs");
const value = JSON.parse(fs.readFileSync(process.env.EXISTING_STOPPED_FILE, "utf8"));
if (value.existingContainersExpected !== 2 || value.existingContainersRunning !== 1) process.exit(1);
NODE

cp "$baseline" "$work/baseline.saved"
chmod 0644 "$baseline"
expect_result baseline-mode nonzero false false
cp "$work/baseline.saved" "$baseline"
chown 0:0 "$baseline"
chmod 0600 "$baseline"

printf '%s\n' 'invalid name with spaces' >"$baseline"
chmod 0600 "$baseline"
expect_result baseline-malformed nonzero false false
cp "$work/baseline.saved" "$baseline"
chown 0:0 "$baseline"
chmod 0600 "$baseline"

mv "$baseline" "$baseline.real"
ln -s "$baseline.real" "$baseline"
expect_result baseline-symlink nonzero false false
rm -- "$baseline"
mv "$baseline.real" "$baseline"

chown 65534:65534 "$baseline"
expect_result baseline-owner nonzero false false
chown 0:0 "$baseline"
chmod 0600 "$baseline"

echo 'power-recovery-check-tests-ok'
