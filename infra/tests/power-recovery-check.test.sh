#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
PATH=/usr/bin:/bin
export PATH

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
bash_bin=/usr/bin/bash
env_bin=/usr/bin/env
sha256_bin=/usr/bin/sha256sum
node_bin=/usr/bin/node
checker="$repo_root/infra/ops/check-recovery.sh"
checker_shebang='#!/usr/bin/env bash'
checker_reviewed_sha256='PENDING_REVIEW_WHEN_LATER_TASK_ASSET_LANDS'
tmp_base="$(cd /tmp && pwd -P)"
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

if [[ "$(/usr/bin/uname -s 2>/dev/null || true)" != Linux ]]; then
  echo 'FAIL: authoritative recovery checker contract requires Linux Bubblewrap containment' >&2
  exit 1
fi

if (( EUID != 0 )); then
  if command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then
    cleanup
    trap - EXIT
    exec sudo -n "$bash_bin" "$repo_root/infra/tests/power-recovery-check.test.sh"
  fi
  echo 'FAIL: power recovery checker contract requires passwordless sudo for root-owned fixture metadata' >&2
  exit 1
fi

fail() {
  echo "FAIL: $*" >&2
  exit 1
}
[[ -f "$node_bin" && -x "$node_bin" ]] || fail 'fixed /usr/bin/node is required for recovery JSON validation'

source_manipulates_path() {
  local source="$1"
  local line
  local path_token_regex='(^|[^A-Za-z0-9_])PATH([^A-Za-z0-9_]|$)'

  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" =~ ^[[:space:]]*(#|$) ]] && continue
    [[ "$line" =~ $path_token_regex ]] && return 0
  done <"$source"
  return 1
}

make_path_sealed_copy() {
  local source="$1"
  local destination="$2"
  local interpreter="$3"
  local expected_shebang="$4"
  local expected_sha256="$5"
  local command_root="${6:-}"
  local command_name

  verify_exact_reviewed_shell_source "$source" "$interpreter" "$expected_shebang" "$expected_sha256" || return 1

  {
    printf '#!%s\n' "$interpreter"
    if [[ -n "$command_root" ]]; then
      shift 6
      for command_name in "$@"; do
        [[ "$command_name" =~ ^[a-z][a-z0-9-]*$ ]] || return 1
        printf '%s() { %q/%s "$@"; }\n' "$command_name" "$command_root" "$command_name"
      done
    fi
    printf '%s\n' 'PATH=' 'readonly PATH'
    tail -n +2 "$source"
  } >"$destination"
  chmod 0700 "$destination"
}

sha256_file() {
  local source="$1"
  local digest_line
  local digest

  digest_line="$("$sha256_bin" -- "$source")" || return 1
  digest="${digest_line%% *}"
  [[ "$digest" =~ ^[0-9a-f]{64}$ ]] || return 1
  printf '%s' "$digest"
}

verify_exact_reviewed_shell_source() {
  local source="$1"
  local interpreter="$2"
  local expected_shebang="$3"
  local expected_sha256="$4"
  local first_line
  local shebang_count=0
  local line
  local actual_sha256

  [[ -f "$source" && ! -L "$source" ]] || return 1
  IFS= read -r first_line <"$source" || return 1
  [[ "$first_line" == "$expected_shebang" && "$first_line" != *$'\r'* ]] || return 1
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" != *$'\r'* ]] || return 1
    [[ "$line" == '#!'* ]] && shebang_count=$((shebang_count + 1))
  done <"$source"
  (( shebang_count == 1 )) || return 1
  [[ "$expected_sha256" =~ ^[0-9a-f]{64}$ ]] || return 1
  actual_sha256="$(sha256_file "$source")" || return 1
  [[ "$actual_sha256" == "$expected_sha256" ]] || return 1
  "$interpreter" -n "$source" >/dev/null 2>&1
}

assert_source_identity_mutations() {
  local interpreter="$1"
  local expected_shebang="$2"
  local safe_source="$work/reviewed-source-safe.sh"
  local mutated_source="$work/reviewed-source-mutated.sh"
  local transformed="$work/reviewed-source-transformed.sh"
  local sentinel="$work/reviewed-source.sentinel"
  local safe_sha256
  local label
  local mutation

  printf '%s\n%s\n' "$expected_shebang" 'set -e' >"$safe_source"
  safe_sha256="$(sha256_file "$safe_source")" || fail 'could not hash reviewed source mutation baseline'
  printf '%s' unchanged >"$sentinel"
  while IFS='|' read -r label mutation; do
    printf '%s\n%s\n%s\n%s\n' "$expected_shebang" 'set -e' "$mutation" \
      'printf reached >"$SOURCE_IDENTITY_SENTINEL"' >"$mutated_source"
    rm -f -- "$transformed"
    if make_path_sealed_copy "$mutated_source" "$transformed" "$interpreter" "$expected_shebang" "$safe_sha256"; then
      fail "reviewed source identity accepted $label mutation"
    fi
    [[ ! -e "$transformed" && "$(<"$sentinel")" == unchanged ]] ||
      fail "reviewed source identity transformed or ran $label mutation"
  done <<'EOF'
dynamic-command-p|opt=-p; builtin command "$opt" -v cp
dynamic-hash-p|opt=-p; d=/usr/bin; hash "$opt" "$d/cp" cp
assembled-absolute|d=/usr/bin; target="$d/cp"; command -v "$target"
new-shell|d=/usr/bin; shell="$d/sh"; "$shell" -c 'command -v cp'
dynamic-source|verb=source; "$verb" "$DYNAMIC_HELPER"
dynamic-dot-source|verb=.; "$verb" "$DYNAMIC_HELPER"
dynamic-env|verb=env; "$verb" command -v cp
dynamic-builtin|verb=builtin; "$verb" command -p -v cp
dynamic-exec|verb=exec; "$verb" /usr/bin/sh -c 'command -v cp'
EOF

  printf '%s\n%s\n' '/usr/bin/cp -- "$SOURCE" "$DESTINATION"' 'set -e' >"$mutated_source"
  rm -f -- "$transformed"
  make_path_sealed_copy "$mutated_source" "$transformed" "$interpreter" "$expected_shebang" "$safe_sha256" &&
    fail 'reviewed source identity accepted a line-1 absolute command'
  [[ ! -e "$transformed" && "$(<"$sentinel")" == unchanged ]] || fail 'line-1 mutation escaped verification'
  printf '%s\n%s\n%s\n' "$expected_shebang" "$expected_shebang" 'set -e' >"$mutated_source"
  make_path_sealed_copy "$mutated_source" "$transformed" "$interpreter" "$expected_shebang" "$safe_sha256" &&
    fail 'reviewed source identity accepted duplicate shebangs'
  printf '%s\r\n%s\r\n' "$expected_shebang" 'set -e' >"$mutated_source"
  make_path_sealed_copy "$mutated_source" "$transformed" "$interpreter" "$expected_shebang" "$safe_sha256" &&
    fail 'reviewed source identity accepted CRLF source'
  rm -f -- "$work/reviewed-source-symlink.sh"
  ln -s "$safe_source" "$work/reviewed-source-symlink.sh"
  if [[ -L "$work/reviewed-source-symlink.sh" ]]; then
    make_path_sealed_copy "$work/reviewed-source-symlink.sh" "$transformed" "$interpreter" "$expected_shebang" "$safe_sha256" &&
      fail 'reviewed source identity accepted a symlink'
  fi
  rm -f -- "$work/reviewed-source-symlink.sh"
}

assert_path_mutation_defenses() {
  local interpreter="$1"
  local mutation_source="$work/path-mutation-source.sh"
  local sealed_mutation="$work/path-mutation-sealed.sh"
  local mutation_bin="$work/path-mutation-bin"
  local resolution="$work/path-mutation-resolution"
  local sentinel="$work/path-mutation-sentinel"
  local mutation
  local mutation_status
  local mutation_sha256

  mkdir -m 0700 "$mutation_bin"
  for mutation in \
    'PATH=/usr/bin:/bin' \
    'export PATH=/usr/bin:/bin' \
    'unset PATH' \
    'readonly PATH=/usr/bin:/bin'; do
    # command -v is a shell builtin; none of these probes executes cp.
    {
      printf '#!%s\n' "$interpreter"
      printf '%s\n' \
        'set -e' \
        "$mutation" \
        'command -v cp >"$PATH_MUTATION_RESOLUTION"' \
        'printf compromised >"$PATH_MUTATION_SENTINEL"'
    } >"$mutation_source"
    source_manipulates_path "$mutation_source" || fail "PATH static guard missed: $mutation"
    mutation_sha256="$(sha256_file "$mutation_source")" || fail 'could not hash PATH mutation source'
    rm -f -- "$sealed_mutation" "$resolution"
    make_path_sealed_copy "$mutation_source" "$sealed_mutation" "$interpreter" "#!$interpreter" "$mutation_sha256" ||
      fail 'could not create reviewed PATH mutation copy'
    printf '%s' unchanged >"$sentinel"
    set +e
    "$env_bin" -i PATH="$mutation_bin" PATH_MUTATION_RESOLUTION="$resolution" \
      PATH_MUTATION_SENTINEL="$sentinel" "$interpreter" "$sealed_mutation" \
      >"$work/path-mutation.stdout" 2>"$work/path-mutation.stderr"
    mutation_status=$?
    set -e

    (( mutation_status != 0 )) || fail "same-interpreter PATH mutation unexpectedly succeeded: $mutation"
    [[ ! -e "$resolution" ]] || fail "PATH mutation resolved a host executable before rejection: $mutation"
    [[ "$(<"$sentinel")" == unchanged ]] || fail "PATH mutation reached the outside sentinel: $mutation"
  done
}

verify_exact_reviewed_shell_source "$checker" "$bash_bin" "$checker_shebang" "$checker_reviewed_sha256" ||
  fail 'recovery checker source identity, shebang, regular-file, LF, syntax, or SHA is not reviewed'
assert_source_identity_mutations "$bash_bin" "$checker_shebang"
if source_manipulates_path "$checker"; then
  fail 'recovery checker may not reference or mutate the harness-owned PATH'
fi
assert_path_mutation_defenses "$bash_bin"
checker_under_test="$work/check-recovery.sealed.sh"
fake_bin="$work/bin"
checker_fake_commands=(id systemctl virsh docker curl date sleep stat realpath readlink cat mktemp rm \
  journalctl findmnt smartctl mount umount nft ping nc wget dd truncate touch tee ln rsync sudo ssh scp socat)
make_path_sealed_copy "$checker" "$checker_under_test" "$bash_bin" "$checker_shebang" "$checker_reviewed_sha256" \
  "$fake_bin" "${checker_fake_commands[@]}" || fail 'could not create reviewed recovery checker test copy'
grep -Fxq 'PATH=' "$checker_under_test" && grep -Fxq 'readonly PATH' "$checker_under_test" ||
  fail 'recovery checker test copy did not seal PATH before the SUT body'
checker_under_test_sha256="$(sha256_file "$checker_under_test")" || fail 'could not hash transformed recovery checker'
verify_exact_reviewed_shell_source "$checker_under_test" "$bash_bin" "#!$bash_bin" "$checker_under_test_sha256" ||
  fail 'transformed recovery checker identity is not verified'

if tail -n +2 "$checker" | grep -Eq '/(usr/)?(s?bin|libexec)/[A-Za-z0-9_.+-]+'; then
  fail 'recovery checker hard-codes an executable path and can bypass the isolated fake PATH'
fi
if tail -n +2 "$checker" | grep -Eq '\$BASH([^A-Za-z0-9_]|$)|\$\{BASH([^A-Za-z0-9_]|$)|(^|[;&|({])[[:space:]]*(exec[[:space:]]+|command[[:space:]]+)?["'"'"']?/[A-Za-z0-9_.+/-]+|(^|[[:space:]])(if|then|while|until|do|else|!)[[:space:]]+(exec[[:space:]]+|command[[:space:]]+)?["'"'"']?/[A-Za-z0-9_.+/-]+'; then
  fail 'recovery checker can invoke an absolute executable or the ambient Bash interpreter outside the fake PATH'
fi
if tail -n +2 "$checker" | grep -Eq 'command[[:space:]]+-p|enable[[:space:]]+-f|hash[[:space:]]+-p|/dev/(tcp|udp)/'; then
  fail 'recovery checker can bypass fake command lookup'
fi
unsafe_absolute_redirects="$(tail -n +2 "$checker" | sed -E 's#(>>?&?|>\|)[[:space:]]*["'"'"']?/dev/null["'"'"']?([;&|)}[:space:]]|$)#\2#g' | grep -E '(>>?&?|>\|)[[:space:]]*["'"'"']?/' || true)"
if [[ -n "$unsafe_absolute_redirects" ]]; then
  fail 'recovery checker redirects output to an absolute path other than /dev/null'
fi
redirect_prefix_probe="$(printf '%s\n' 'printf unsafe >/dev/null.evil' | sed -E 's#(>>?&?|>\|)[[:space:]]*["'"'"']?/dev/null["'"'"']?([;&|)}[:space:]]|$)#\2#g' | grep -E '(>>?&?|>\|)[[:space:]]*["'"'"']?/' || true)"
[[ -n "$redirect_prefix_probe" ]] || fail 'recovery redirect guard accepted a /dev/null prefix sibling'
if tail -n +2 "$checker" | grep -Eq '(^|[;&|()[:space:]])(env|sh|bash|dash|zsh)([;&|()[:space:]]|$)|(^|[;&|()[:space:]])(eval|source)([;&|()[:space:]]|$)|(^|[;&|()[:space:]])\.[[:space:]]+/'; then
  fail 'recovery checker can spawn or source an uninstrumented shell command'
fi
if tail -n +2 "$checker" | grep -Eq '(^|[^<])<[[:space:]]*([^<(&]|$)'; then
  fail 'recovery checker contains an uninstrumented shell file read'
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
curl_root="$state_root/curl"
baseline="$host_root/etc/learncoding/existing-containers.txt"
compose_env_path="$host_root/etc/learncoding/compose.env"
runner_secret_file="$host_root/etc/learncoding/secrets/runner_shared_secret"
postgres_sql="SELECT name, setting FROM pg_settings WHERE name IN ('fsync', 'synchronous_commit', 'full_page_writes');"
mkdir -m 0700 -p "$fake_bin" "$state_root" "$curl_root" "$host_root/etc/learncoding/secrets"
printf '%s\n' legacy-alpha legacy-bravo >"$baseline"
chown 0:0 "$baseline"
chmod 0600 "$baseline"
: >"$compose_env_path"
chown 0:0 "$compose_env_path"
chmod 0640 "$compose_env_path"

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
    "$node_bin" -e '
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

printf '#!%s\n' "$bash_bin" >"$fake_bin/fake-recovery-command"
cat >>"$fake_bin/fake-recovery-command" <<'FAKE'
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

safe_under() {
  local root="$1"
  local candidate="$2"
  local relative
  local cursor
  local component
  local -a components=()
  [[ "$candidate" == "$root" || "$candidate" == "$root"/* ]] || return 1
  relative="${candidate#"$root"}"
  relative="${relative#/}"
  [[ "/$relative/" != *'/../'* && "/$relative/" != *'/./'* && "$relative" != *'//'* ]] || return 1
  cursor="$root"
  [[ ! -L "$cursor" ]] || return 1
  IFS='/' read -r -a components <<<"$relative"
  for component in "${components[@]}"; do
    [[ -n "$component" && "$component" != . && "$component" != .. ]] || return 1
    cursor="$cursor/$component"
    [[ ! -L "$cursor" ]] || return 1
  done
}

emit_compose_status() {
  local first=true
  local service
  local state
  printf '['
  for service in app mail-worker reward-worker regrade-worker exam-finalization-worker \
    practice-runner-recovery-worker project-review-correction-worker cloudflared; do
    [[ "$scenario" != app-incomplete || "$service" != app ]] || continue
    [[ "$scenario" != worker-incomplete || "$service" != reward-worker ]] || continue
    [[ "$scenario" != cloudflared-incomplete || "$service" != cloudflared ]] || continue
    state=running
    [[ "$scenario" != app-malformed || "$service" != app ]] || state=mystery
    [[ "$scenario" != worker-malformed || "$service" != mail-worker ]] || state=mystery
    [[ "$scenario" != cloudflared-malformed || "$service" != cloudflared ]] || state=mystery
    [[ "$first" == true ]] || printf ','
    first=false
    case "$service" in
      app)
        printf '{"Service":"%s","State":"%s","Health":"healthy","IgnoredLearner":"%s"}' \
          "$service" "$state" "$FAKE_LEARNER_CANARY"
        ;;
      mail-worker)
        printf '{"Service":"%s","State":"%s","Health":"healthy","IgnoredSource":"%s"}' \
          "$service" "$state" "$FAKE_SOURCE_CANARY"
        ;;
      cloudflared)
        printf '{"Service":"%s","State":"%s","Health":"healthy","Ignored":"%s"}' \
          "$service" "$state" "$FAKE_RAW_COMMAND_CANARY"
        ;;
      *) printf '{"Service":"%s","State":"%s","Health":"healthy"}' "$service" "$state" ;;
    esac
  done
  printf ']\n'
}

case "$command_name" in
  id)
    [[ "$#" == 1 && "$1" == -u ]] || exit 64
    printf '%s\n' "$EUID"
    ;;
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
        [[ "$#" == 2 ]] || exit 64
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
        [[ "$#" == 2 ]] || exit 64
        if [[ "$scenario" == timer-incomplete && "$unit" == learncoding-retention.timer ]]; then printf '%s\n' disabled; exit 1; fi
        if [[ "$scenario" == timer-malformed && "$unit" == learncoding-retention.timer ]]; then printf '%s\n' 'enabled unexpected'; exit 0; fi
        case "$unit" in
          learncoding-backup.timer|learncoding-backup-check.timer|learncoding-retention.timer|learncoding-recovery-check.timer)
            printf '%s\n' enabled ;;
          *) exit 64 ;;
        esac
        ;;
      show)
        [[ "$#" == 4 && "${3:-}" == --property=Persistent && "${4:-}" == --value && "$unit" == *.timer ]] || exit 64
        if [[ "$scenario" == timer-not-persistent && "$unit" == learncoding-retention.timer ]]; then
          printf '%s\n' no
        else
          printf '%s\n' yes
        fi
        ;;
      *) exit 64 ;;
    esac
    ;;
  virsh)
    if [[ "${1:-}" == --connect && "${2:-}" == qemu:///system ]]; then shift 2; fi
    [[ "$#" == 2 ]] || exit 64
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
    if [[ "$#" == 1 && "$1" == info ]]; then
      [[ "$delayed" == false && "$scenario" != docker-down ]] || exit 1
      exit 0
    fi
    if [[ "$#" == 11 && "$1" == compose && "$2" == --env-file && "$3" == "$FAKE_COMPOSE_ENV" && \
      "$4" == -f && "$5" == "$FAKE_COMPOSE_FILE" && "$6" == exec && "$7" == -T && \
      "$8" == postgres && "$9" == pg_isready && "${10}" == --username=learncoding && \
      "${11}" == --dbname=learncoding ]]; then
      [[ "$scenario" != postgres-unhealthy && "$delayed" == false ]] || exit 1
      printf '%s\n' 'accepting connections'
      exit 0
    fi
    if [[ "$#" == 16 && "$1" == compose && "$2" == --env-file && "$3" == "$FAKE_COMPOSE_ENV" && \
      "$4" == -f && "$5" == "$FAKE_COMPOSE_FILE" && "$6" == exec && "$7" == -T && \
      "$8" == postgres && "$9" == psql && "${10}" == --username=learncoding && \
      "${11}" == --dbname=learncoding && "${12}" == --no-align && "${13}" == --tuples-only && \
      "${14}" == '--field-separator=|' && "${15}" == --command && "${16}" == "$FAKE_POSTGRES_SQL" ]]; then
      case "$scenario" in
        postgres-fsync-off) printf '%s\n' 'fsync|off' 'synchronous_commit|on' 'full_page_writes|on' ;;
        postgres-sync-off) printf '%s\n' 'fsync|on' 'synchronous_commit|off' 'full_page_writes|on' ;;
        postgres-full-page-off) printf '%s\n' 'fsync|on' 'synchronous_commit|on' 'full_page_writes|off' ;;
        *) printf '%s\n' 'fsync|on' 'synchronous_commit|on' 'full_page_writes|on' ;;
      esac
      exit 0
    fi
    if [[ "$#" == 8 && "$1" == compose && "$2" == --env-file && "$3" == "$FAKE_COMPOSE_ENV" && \
      "$4" == -f && "$5" == "$FAKE_COMPOSE_FILE" && "$6" == ps && "$7" == --format && "$8" == json ]]; then
      [[ "$delayed" == false ]] || exit 1
      emit_compose_status
      exit 0
    fi
    if [[ "$#" == 3 && "$1" == ps && "$2" == --format && "$3" == '{{.Names}}' ]]; then
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
    [[ "$#" == 11 && "$1" == --silent && "$2" == --show-error && "$3" == --fail && \
      "$4" == --max-time && "$5" == 10 && "$6" == --output && "$8" == --dump-header && \
      "${10}" == --url ]] || exit 64
    output="$7"
    headers="$9"
    url="${11}"
    safe_under "$FAKE_CURL_ROOT" "$output" && safe_under "$FAKE_CURL_ROOT" "$headers" || exit 97
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
      if [[ "$scenario" == runner-unsigned ]]; then
        header_text="HTTP/1.1 200 OK
x-request-id: recovery-health-fixture-0001
x-runner-debug: $FAKE_RUNNER_OUTPUT_CANARY"
      else
        header_text="HTTP/1.1 200 OK
x-request-id: recovery-health-fixture-0001
x-runner-response-signature: $signature
x-runner-debug: $FAKE_RUNNER_OUTPUT_CANARY"
      fi
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
    printf '%s' "$body" >"$output"
    printf '%s\n' "$header_text" >"$headers"
    ;;
  stat|realpath|readlink|cat)
    targets=()
    expect_format=false
    for argument in "$@"; do
      if [[ "$expect_format" == true ]]; then expect_format=false; continue; fi
      case "$argument" in -c|--format|--printf) expect_format=true ;; --|-e|-f|-m|-n|-q|-s|-v|--format=*|--printf=*) ;; -*) exit 64 ;; *) targets+=("$argument") ;; esac
    done
    [[ "$expect_format" == false && ${#targets[@]} == 1 ]] || exit 64
    for target in "${targets[@]}"; do
      safe_under "$FAKE_HOST_ROOT" "$target" || safe_under "$FAKE_STATE_ROOT" "$target" || exit 97
    done
    "/usr/bin/$command_name" "$@"
    ;;
  mktemp)
    mktemp_args=("$@")
    template="${!#}"
    safe_under "$FAKE_CURL_ROOT" "$template" || exit 97
    expect_tmpdir=false
    for argument in "${mktemp_args[@]:0:${#mktemp_args[@]}-1}"; do
      if [[ "$expect_tmpdir" == true ]]; then safe_under "$FAKE_CURL_ROOT" "$argument" || exit 97; expect_tmpdir=false; continue; fi
      case "$argument" in
        -d) ;;
        -p|--tmpdir) expect_tmpdir=true ;;
        --tmpdir=*) safe_under "$FAKE_CURL_ROOT" "${argument#*=}" || exit 97 ;;
        -*) exit 64 ;;
        *) exit 64 ;;
      esac
    done
    [[ "$expect_tmpdir" == false ]] || exit 64
    /usr/bin/mktemp "${mktemp_args[@]}"
    ;;
  rm)
    rm_args=("$@")
    rm_targets=()
    for argument in "${rm_args[@]}"; do case "$argument" in --|-f) ;; -*) exit 64 ;; *) rm_targets+=("$argument") ;; esac; done
    (( ${#rm_targets[@]} > 0 )) || exit 64
    for target in "${rm_targets[@]}"; do safe_under "$FAKE_CURL_ROOT" "$target" || exit 97; done
    /usr/bin/rm "${rm_args[@]}"
    ;;
  journalctl|findmnt|smartctl|mount|umount|nft|ping|nc|wget|dd|truncate|touch|tee|ln|rsync|sudo|ssh|scp|socat)
    printf '%s\n' "$FAKE_RUNNER_JOURNAL_CANARY" >&2
    exit 97
    ;;
  *) exit 64 ;;
esac
FAKE
chmod 0755 "$fake_bin/fake-recovery-command"
for command_name in id systemctl virsh docker curl date sleep stat realpath readlink cat mktemp rm \
  journalctl findmnt smartctl mount umount nft ping nc wget dd truncate touch tee ln rsync sudo ssh scp socat; do
  cp "$fake_bin/fake-recovery-command" "$fake_bin/$command_name"
done
fake_recovery_sha256="$(sha256_file "$fake_bin/fake-recovery-command")" || fail 'could not hash strict recovery fake command'
for command_name in "${checker_fake_commands[@]}"; do
  verify_exact_reviewed_shell_source "$fake_bin/$command_name" "$bash_bin" "#!$bash_bin" "$fake_recovery_sha256" ||
    fail "recovery fake command identity is not verified: $command_name"
done

outside_sentinel="$work/outside-fake-roots.sentinel"
printf '%s' 'outside-fixture-sentinel-unchanged' >"$outside_sentinel"
set +e
PATH="$fake_bin" "$fake_bin/cat" -- "$outside_sentinel" >"$work/outside-read.stdout" 2>"$work/outside-read.stderr"
outside_read_status=$?
PATH="$fake_bin" cp -- "$baseline" "$outside_sentinel" >"$work/outside-write.stdout" 2>"$work/outside-write.stderr"
outside_write_status=$?
PATH="$fake_bin" recovery-contract-unknown-command >"$work/outside-unknown.stdout" 2>"$work/outside-unknown.stderr"
outside_unknown_status=$?
set -e
(( outside_read_status != 0 && outside_write_status != 0 && outside_unknown_status != 0 )) ||
  fail 'fake-only recovery PATH allowed an unknown, outside read, or outside write command'
[[ "$(<"$outside_sentinel")" == 'outside-fixture-sentinel-unchanged' ]] ||
  fail 'outside-fixture recovery sentinel was modified'

verify_fixed_outer_binary() {
  local binary="$1"
  local regular_only="${2:-false}"
  local metadata owner group mode mode_value
  [[ "$binary" == /usr/bin/* && -f "$binary" && -x "$binary" ]] || return 1
  [[ "$regular_only" != true || ! -L "$binary" ]] || return 1
  metadata="$(/usr/bin/stat -L -c '%u:%g:%a' -- "$binary")" || return 1
  IFS=: read -r owner group mode <<<"$metadata"
  [[ "$owner" == 0 && "$group" == 0 && "$mode" =~ ^[0-7]{3,4}$ ]] || return 1
  mode_value=$((8#$mode))
  (( (mode_value & 8#022) == 0 ))
}

assert_containment_gate_mutations() {
  local sentinel="$work/containment-gate.sentinel"
  local rejected="$work/rejected-bwrap"
  local candidate="$work/containment-candidate"
  local status
  printf '%s' unchanged >"$sentinel"
  printf '#!%s\n%s\n' "$bash_bin" 'exit 77' >"$rejected"
  printf '#!%s\nprintf reached >%q\n' "$bash_bin" "$sentinel" >"$candidate"
  chmod 0700 "$rejected" "$candidate"
  verify_fixed_outer_binary "$work/missing-bwrap" true && fail 'missing Bubblewrap dependency was accepted'
  set +e
  "$env_bin" -i PATH= "$rejected" --unshare-user --unshare-pid --unshare-net -- "$candidate" >/dev/null 2>&1
  status=$?
  set -e
  [[ "$status" == 77 && "$(<"$sentinel")" == unchanged ]] ||
    fail 'rejected containment reached the recovery checker sentinel'
}

prepare_linux_containment() {
  local entry="$work/namespace-entry.sh"
  local empty="$work/namespace-empty"
  local repo_mask="$work/namespace-repo-mask"
  local outside="/tmp/learncoding-recovery-check-outside-$$"
  local binary probe_status

  [[ "$(/usr/bin/uname -s 2>/dev/null || true)" == Linux && "$EUID" == 0 ]] ||
    fail 'authoritative recovery checker contract requires Ubuntu/Linux root with Bubblewrap user/mount/PID/network containment'
  for binary in /usr/bin/stat /usr/bin/uname /usr/bin/bash /usr/bin/env /usr/bin/sha256sum \
    /usr/bin/timeout /usr/bin/prlimit /usr/bin/setpriv /usr/bin/node; do
    verify_fixed_outer_binary "$binary" false || fail "containment dependency is not fixed root-owned and non-writable: $binary"
  done
  verify_fixed_outer_binary /usr/bin/bwrap true ||
    fail '/usr/bin/bwrap must be a regular root-owned non-writable authoritative test dependency'

  mkdir -m 0700 -p "$empty/$(basename -- "$work")" "$repo_mask"
  : >"$repo_mask/compose.yaml"
  {
    printf '%s\n' '#!/usr/bin/bash'
    printf 'readonly containment_work=%q\nreadonly containment_outside=%q\nreadonly containment_repo=%q\n' \
      "$work" "$outside" "$repo_root"
    cat <<'EOF'
set -Eeuo pipefail
[[ "$EUID" == 0 && "$$" == 1 ]] || exit 90
capability_set_count=0 no_new_privs=
while IFS=$'\t ' read -r key value _; do
  case "$key" in
    CapEff:|CapPrm:|CapInh:|CapBnd:|CapAmb:) [[ "$value" =~ ^0+$ ]] || exit 91; capability_set_count=$((capability_set_count + 1)) ;;
    Groups:) [[ -z "${value:-}" ]] || exit 91 ;;
    NoNewPrivs:) no_new_privs="$value" ;;
  esac
done </proc/self/status
[[ "$capability_set_count" == 5 && "$no_new_privs" == 1 ]] || exit 91
interface_count=0
while IFS= read -r line; do
  case "$line" in *:*) interface="${line%%:*}"; interface="${interface//[[:space:]]/}"; [[ "$interface" == lo ]] || exit 92; interface_count=$((interface_count + 1)) ;; esac
done </proc/net/dev
[[ "$interface_count" == 1 ]] || exit 92
[[ ! -e /run/docker.sock && ! -e /run/libvirt/libvirt-sock && ! -e /dev/kvm ]] || exit 93
[[ ! -e /etc/passwd && ! -e /etc/learncoding && ! -e /root/.ssh && ! -e /var/lib/learncoding ]] || exit 94
[[ ! -e "$containment_repo/.env" && ! -e "$containment_repo/.git" ]] || exit 94
if { : >"$containment_outside"; } 2>/dev/null; then exit 95; fi
: >"$containment_work/.namespace-write-probe"
exec "$@"
EOF
  } >"$entry"
  chmod 0700 "$entry"
  containment_entry="$entry"
  containment_entry_sha256="$(sha256_file "$entry")" || fail 'could not hash namespace entry'
  verify_exact_reviewed_shell_source "$entry" /usr/bin/bash '#!/usr/bin/bash' "$containment_entry_sha256" ||
    fail 'namespace entry identity is not verified'

  containment_command=(
    /usr/bin/timeout --signal=KILL --kill-after=5s 45s
    /usr/bin/prlimit --nproc=64:64 --nofile=128:128 --core=0:0 --cpu=30:30 --
    /usr/bin/setpriv --clear-groups
    /usr/bin/bwrap --die-with-parent --new-session --unshare-user --uid 0 --gid 0
    --unshare-pid --unshare-net --unshare-ipc --unshare-uts --disable-userns
    --cap-drop ALL --as-pid-1 --ro-bind / /
    --ro-bind "$empty" /etc --ro-bind "$empty" /home --ro-bind "$empty" /root --ro-bind "$empty" /run
    --ro-bind "$empty" /srv --ro-bind "$empty" /mnt --ro-bind "$empty" /media --ro-bind "$empty" /opt
    --ro-bind "$empty" /var/lib --ro-bind "$empty" /var/backups --ro-bind "$empty" /var/log --ro-bind "$empty" /tmp
    --ro-bind "$repo_mask" "$repo_root" --ro-bind "$repo_root/compose.yaml" "$repo_root/compose.yaml"
    --bind "$work" "$work"
    --ro-bind "$empty" "$empty" --ro-bind "$repo_mask" "$repo_mask"
    --ro-bind "$fake_bin" "$fake_bin"
    --ro-bind "$entry" "$entry" --ro-bind "$checker_under_test" "$checker_under_test"
    --proc /proc --dev /dev --chdir "$work" --
    /usr/bin/setpriv --no-new-privs --bounding-set=-all --inh-caps=-all --ambient-caps=-all
    /usr/bin/bash "$entry"
  )
  set +e
  /usr/bin/env -i PATH= HOME="$work" "${containment_command[@]}" /usr/bin/bash -c ':' >/dev/null 2>"$work/containment-preflight.stderr"
  probe_status=$?
  set -e
  (( probe_status == 0 )) || fail 'Bubblewrap containment preflight or mandatory user namespace was rejected'
  [[ -f "$work/.namespace-write-probe" && ! -e "$outside" ]] || fail 'containment did not prove fixture-only writes'
}

assert_recovery_execution_identity() {
  local command_name
  verify_exact_reviewed_shell_source "$checker" "$bash_bin" "$checker_shebang" "$checker_reviewed_sha256" ||
    fail 'recovery checker source changed after transformation'
  verify_exact_reviewed_shell_source "$checker_under_test" "$bash_bin" "#!$bash_bin" "$checker_under_test_sha256" ||
    fail 'transformed recovery checker changed before execution'
  verify_exact_reviewed_shell_source "$containment_entry" /usr/bin/bash '#!/usr/bin/bash' "$containment_entry_sha256" ||
    fail 'namespace entry changed before recovery checker execution'
  for command_name in "${checker_fake_commands[@]}"; do
    verify_exact_reviewed_shell_source "$fake_bin/$command_name" "$bash_bin" "#!$bash_bin" "$fake_recovery_sha256" ||
      fail "recovery fake command changed before execution: $command_name"
  done
  verify_fixed_outer_binary /usr/bin/bwrap true || fail 'Bubblewrap changed before recovery checker execution'
}

assert_containment_gate_mutations
prepare_linux_containment

run_checker() {
  local scenario="$1"
  local prefix="$2"
  printf '%s' "$scenario" >"$scenario_file"
  printf '%s' 0 >"$clock_file"
  : >"$events"
  set +e
  assert_recovery_execution_identity
  printf '%s' "$stdin_canary" | /usr/bin/env -i \
    HOME="$work" \
    PATH= \
    TMPDIR="$curl_root" \
    RECOVERY_CHECK_TEST_ROOT="$host_root" \
    RECOVERY_PUBLIC_URL='https://pilot.example.test/health/ready' \
    RUNNER_BASE_URL='http://10.20.0.12:4100' \
    RUNNER_SHARED_SECRET_FILE="$runner_secret_file" \
    FAKE_EVENTS="$events" \
    FAKE_SCENARIO_FILE="$scenario_file" \
    FAKE_STATE_ROOT="$state_root" \
    FAKE_HOST_ROOT="$host_root" \
    FAKE_CURL_ROOT="$curl_root" \
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
    FAKE_LEARNER_CANARY="$learner_canary" \
    FAKE_SOURCE_CANARY="$source_canary" \
    FAKE_COMPOSE_ENV="$compose_env_path" \
    FAKE_COMPOSE_FILE="$repo_root/compose.yaml" \
    FAKE_POSTGRES_SQL="$postgres_sql" \
    "${containment_command[@]}" /usr/bin/bash "$checker_under_test" >"$prefix.stdout" 2>"$prefix.stderr"
  checker_status=$?
  set -e
  [[ "$(<"$outside_sentinel")" == 'outside-fixture-sentinel-unchanged' ]] ||
    fail 'recovery checker modified the outside-fixture sentinel'
}

validate_json_contract() {
  local output_file="$1"
  local expected_recovered="$2"
  local expected_timeout="$3"
  local expected_elapsed="$4"
  local expected_health_map="$5"
  local expected_count="$6"
  local running_count="$7"
  local line_count
  line_count="$(grep -cve '^[[:space:]]*$' "$output_file" || true)"
  [[ "$line_count" == 1 ]] || fail "checker must emit exactly one final JSON object: ${output_file##*/}"
  EXPECTED_RECOVERED="$expected_recovered" EXPECTED_TIMEOUT="$expected_timeout" \
    EXPECTED_ELAPSED="$expected_elapsed" EXPECTED_HEALTH_MAP="$expected_health_map" \
    EXPECTED_COUNT="$expected_count" RUNNING_COUNT="$running_count" \
    OUTPUT_FILE="$output_file" "$node_bin" <<'NODE'
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
if (value.existingContainersExpected !== Number(process.env.EXPECTED_COUNT) ||
    value.existingContainersRunning !== Number(process.env.RUNNING_COUNT)) process.exit(10);
if (value.elapsedSeconds !== Number(process.env.EXPECTED_ELAPSED)) process.exit(11);
const healthKeys = allowed.filter((key) => key.endsWith("Healthy") || key === "postgresDurable");
const expectedHealth = Object.fromEntries((process.env.EXPECTED_HEALTH_MAP ?? "").split(",").filter(Boolean).map((entry) => {
  const [key, raw] = entry.split("=");
  if (raw !== "true" && raw !== "false") process.exit(12);
  return [key, raw === "true"];
}));
if (JSON.stringify(Object.keys(expectedHealth).sort()) !== JSON.stringify([...healthKeys].sort())) process.exit(13);
for (const key of healthKeys) {
  if (value[key] !== expectedHealth[key]) process.exit(14);
}
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
  local expected_elapsed="$5"
  local expected_health_map="$6"
  local expected_count="$7"
  local running_count="$8"
  local prefix="$work/result-$scenario"
  run_checker "$scenario" "$prefix"
  if [[ "$expected_status" == zero ]]; then
    (( checker_status == 0 )) || fail "$scenario returned $checker_status, expected zero"
  else
    (( checker_status != 0 )) || fail "$scenario returned zero, expected nonzero"
  fi
  validate_json_contract "$prefix.stdout" "$expected_recovered" "$expected_timeout" "$expected_elapsed" \
    "$expected_health_map" "$expected_count" "$running_count"
  assert_private_result "$prefix"
}

health_keys=(
  appHealthy cloudflaredHealthy dockerHealthy firewallHealthy libvirtHealthy postgresDurable
  postgresHealthy publicHttpsHealthy runnerHealthy timersHealthy workersHealthy
)
health_map_with_false() {
  local false_keys=",${1:-},"
  local key
  local separator=
  for key in "${health_keys[@]}"; do
    printf '%s%s=%s' "$separator" "$key" "$([[ "$false_keys" == *",$key,"* ]] && printf false || printf true)"
    separator=,
  done
}
all_true_health_map="$(health_map_with_false '')"
all_false_health_map='appHealthy=false,cloudflaredHealthy=false,dockerHealthy=false,firewallHealthy=false,libvirtHealthy=false,postgresDurable=false,postgresHealthy=false,publicHttpsHealthy=false,runnerHealthy=false,timersHealthy=false,workersHealthy=false'

expect_result immediate zero true false 0 "$all_true_health_map" 2 2
expect_result delayed zero true false 30 "$all_true_health_map" 2 2
[[ "$(<"$clock_file")" == 30 ]] || fail 'delayed recovery did not use the virtual monotonic clock'

expect_result permanent nonzero false true 900 "$(health_map_with_false appHealthy)" 2 2
[[ "$(<"$clock_file")" == 900 ]] || fail 'permanent failure did not stop exactly at the 900-second bound'
last_sleep="$(grep '^sleep ' "$events" | tail -n 1)"
[[ "$last_sleep" == 'sleep 10' ]] || fail 'permanent failure used an unexpected polling sleep'

for scenario in \
  docker-down libvirt-down firewall-down public-fail public-headers public-origin existing-stopped \
  runner-inactive runner-no-autostart runner-network-inactive runner-network-no-autostart \
  runner-malformed runner-unsigned runner-expired runner-tampered runner-concurrency \
  postgres-unhealthy postgres-fsync-off postgres-sync-off postgres-full-page-off app-incomplete app-malformed \
  worker-incomplete worker-malformed cloudflared-incomplete cloudflared-malformed timer-incomplete timer-malformed timer-not-persistent; do
  expected_false=
  case "$scenario" in
    docker-down) expected_false=dockerHealthy ;;
    libvirt-down) expected_false=libvirtHealthy ;;
    firewall-down) expected_false=firewallHealthy ;;
    public-*) expected_false=publicHttpsHealthy ;;
    runner-*) expected_false=runnerHealthy ;;
    postgres-unhealthy) expected_false=postgresHealthy ;;
    postgres-*) expected_false=postgresDurable ;;
    app-*) expected_false=appHealthy ;;
    worker-*) expected_false=workersHealthy ;;
    cloudflared-*) expected_false=cloudflaredHealthy ;;
    timer-*) expected_false=timersHealthy ;;
  esac
  expected_count=2
  running_count=2
  [[ "$scenario" != existing-stopped ]] || running_count=1
  expect_result "$scenario" nonzero false true 900 "$(health_map_with_false "$expected_false")" \
    "$expected_count" "$running_count"
done
EXISTING_STOPPED_FILE="$work/result-existing-stopped.stdout" "$node_bin" <<'NODE'
const fs = require("node:fs");
const value = JSON.parse(fs.readFileSync(process.env.EXISTING_STOPPED_FILE, "utf8"));
if (value.existingContainersExpected !== 2 || value.existingContainersRunning !== 1) process.exit(1);
NODE

cp "$baseline" "$work/baseline.saved"
chmod 0644 "$baseline"
expect_result baseline-mode nonzero false false 0 "$all_false_health_map" 0 0
cp "$work/baseline.saved" "$baseline"
chown 0:0 "$baseline"
chmod 0600 "$baseline"

printf '%s\n' 'invalid name with spaces' >"$baseline"
chmod 0600 "$baseline"
expect_result baseline-malformed nonzero false false 0 "$all_false_health_map" 0 0
cp "$work/baseline.saved" "$baseline"
chown 0:0 "$baseline"
chmod 0600 "$baseline"

mv "$baseline" "$baseline.real"
ln -s "$baseline.real" "$baseline"
expect_result baseline-symlink nonzero false false 0 "$all_false_health_map" 0 0
rm -- "$baseline"
mv "$baseline.real" "$baseline"

chown 65534:65534 "$baseline"
expect_result baseline-owner nonzero false false 0 "$all_false_health_map" 0 0
chown 0:0 "$baseline"
chmod 0600 "$baseline"

echo 'power-recovery-check-tests-ok'
