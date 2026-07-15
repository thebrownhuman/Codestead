#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
bash_bin="$(command -v bash)"
env_bin="$(command -v env)"
node_bin="$(command -v node)"
collector="$repo_root/infra/ops/capture-recovery-evidence.sh"
tmp_base="$(cd "${TMPDIR:-/tmp}" && pwd -P)"
work="$(mktemp -d "$tmp_base/power-evidence.XXXXXX")"
work="$(cd "$work" && pwd -P)"
[[ ! -L "$work" && "$work" == "$tmp_base"/* ]] || {
  echo 'FAIL: recovery evidence fixture escaped its verified temporary root' >&2
  exit 1
}
chmod 0700 "$work"
cleanup() {
  if [[ -n "${work:-}" && -d "$work" && ! -L "$work" && "$work" == "$tmp_base"/* ]]; then
    rm -rf -- "$work"
  fi
}
trap cleanup EXIT

if [[ ! -f "$collector" ]]; then
  echo 'power recovery evidence contract failed:' >&2
  echo '- missing later-task production asset: infra/ops/capture-recovery-evidence.sh' >&2
  exit 1
fi

if (( EUID != 0 )); then
  if command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then
    cleanup
    trap - EXIT
    exec sudo -n "$bash_bin" "$repo_root/infra/tests/power-evidence.test.sh"
  fi
  echo 'FAIL: power evidence contract requires passwordless sudo for root-owned fixture metadata' >&2
  exit 1
fi

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

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

  {
    printf '#!%s\n' "$interpreter"
    printf '%s\n' 'readonly PATH'
    tail -n +2 "$source"
  } >"$destination"
  chmod 0700 "$destination"
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

  for mutation in \
    'PATH=/usr/bin:/bin' \
    'export PATH=/usr/bin:/bin' \
    'unset PATH' \
    'readonly PATH=/usr/bin:/bin'; do
    printf '#!%s\n%s\n' "$interpreter" "$mutation" >"$mutation_source"
    source_manipulates_path "$mutation_source" || fail "PATH static guard missed: $mutation"
  done

  # command -v is a shell builtin; this mutation probe never executes cp.
  {
    printf '#!%s\n' "$interpreter"
    printf '%s\n' \
      'set -e' \
      'PATH=/usr/bin:/bin' \
      'command -v cp >"$PATH_MUTATION_RESOLUTION"' \
      'printf compromised >"$PATH_MUTATION_SENTINEL"'
  } >"$mutation_source"
  make_path_sealed_copy "$mutation_source" "$sealed_mutation" "$interpreter"
  mkdir -m 0700 "$mutation_bin"
  printf '%s' unchanged >"$sentinel"
  set +e
  "$env_bin" -i PATH="$mutation_bin" PATH_MUTATION_RESOLUTION="$resolution" \
    PATH_MUTATION_SENTINEL="$sentinel" "$interpreter" "$sealed_mutation" \
    >"$work/path-mutation.stdout" 2>"$work/path-mutation.stderr"
  mutation_status=$?
  set -e

  (( mutation_status != 0 )) || fail 'same-interpreter PATH mutation unexpectedly succeeded'
  [[ ! -e "$resolution" ]] || fail 'PATH mutation resolved a host executable before rejection'
  [[ "$(<"$sentinel")" == unchanged ]] || fail 'PATH mutation reached the outside sentinel after changing command lookup'
}

if source_manipulates_path "$collector"; then
  fail 'evidence collector may not reference or mutate the harness-owned PATH'
fi
assert_path_mutation_defenses "$bash_bin"
collector_under_test="$work/capture-recovery-evidence.sealed.sh"
make_path_sealed_copy "$collector" "$collector_under_test" "$bash_bin"
[[ "$(sed -n '2p' "$collector_under_test")" == 'readonly PATH' ]] ||
  fail 'evidence collector test copy did not seal PATH before the SUT body'

if tail -n +2 "$collector" | grep -Eq '/(usr/)?(s?bin|libexec)/[A-Za-z0-9_.+-]+'; then
  fail 'evidence collector hard-codes an executable path and can bypass the isolated fake PATH'
fi
if tail -n +2 "$collector" | grep -Eq '\$BASH([^A-Za-z0-9_]|$)|\$\{BASH([^A-Za-z0-9_]|$)|(^|[;&|({])[[:space:]]*(exec[[:space:]]+|command[[:space:]]+)?["'"'"']?/[A-Za-z0-9_.+/-]+|(^|[[:space:]])(if|then|while|until|do|else|!)[[:space:]]+(exec[[:space:]]+|command[[:space:]]+)?["'"'"']?/[A-Za-z0-9_.+/-]+'; then
  fail 'evidence collector can invoke an absolute executable or the ambient Bash interpreter outside the fake PATH'
fi
if tail -n +2 "$collector" | grep -Eq 'command[[:space:]]+-p|enable[[:space:]]+-f|hash[[:space:]]+-p|/dev/(tcp|udp)/'; then
  fail 'evidence collector can bypass fake command lookup'
fi
unsafe_absolute_redirects="$(tail -n +2 "$collector" | sed -E 's#(>>?&?|>\|)[[:space:]]*["'"'"']?/dev/null["'"'"']?([;&|)}[:space:]]|$)#\2#g' | grep -E '(>>?&?|>\|)[[:space:]]*["'"'"']?/' || true)"
if [[ -n "$unsafe_absolute_redirects" ]]; then
  fail 'evidence collector redirects output to an absolute path other than /dev/null'
fi
redirect_prefix_probe="$(printf '%s\n' 'printf unsafe >/dev/null.evil' | sed -E 's#(>>?&?|>\|)[[:space:]]*["'"'"']?/dev/null["'"'"']?([;&|)}[:space:]]|$)#\2#g' | grep -E '(>>?&?|>\|)[[:space:]]*["'"'"']?/' || true)"
[[ -n "$redirect_prefix_probe" ]] || fail 'evidence redirect guard accepted a /dev/null prefix sibling'
if tail -n +2 "$collector" | grep -Eq '(^|[;&|()[:space:]])(env|sh|bash|dash|zsh)([;&|()[:space:]]|$)|(^|[;&|()[:space:]])(eval|source)([;&|()[:space:]]|$)|(^|[;&|()[:space:]])\.[[:space:]]+/'; then
  fail 'evidence collector can spawn or source an uninstrumented shell command'
fi
if tail -n +2 "$collector" | grep -Eq '(^|[^<])<[[:space:]]*([^<(&]|$)'; then
  fail 'evidence collector contains an uninstrumented shell file read'
fi
if grep -Eiq '/etc/learncoding/secrets|/secrets/|runner_shared_secret|RUNNER_[A-Z0-9_]*SECRET' "$collector"; then
  fail 'evidence collector references a runner or application secret path'
fi
grep -Fq 'RECOVERY_EVIDENCE_TEST_ROOT' "$collector" || fail 'evidence collector is missing the single narrow test-root seam'
grep -Fq '/var/lib/learncoding/recovery-evidence' "$collector" || fail 'evidence collector changed the fixed production root'

host_root="$work/host-root"
evidence_root="$host_root/var/lib/learncoding/recovery-evidence"
fake_bin="$work/bin"
state_root="$work/state"
curl_root="$state_root/curl"
events="$work/events.log"
scenario_file="$state_root/scenario"
compose_env_path="$host_root/etc/learncoding/compose.env"
mkdir -m 0700 -p "$evidence_root" "$fake_bin" "$state_root" "$curl_root" "$host_root/proc/sys/kernel" \
  "$host_root/proc" "$host_root/var/lib/learncoding-runner" "$host_root/etc/learncoding/secrets" \
  "$host_root/var/lib/learncoding/backups"
chown -R 0:0 "$host_root"
chmod 0700 "$evidence_root"
printf '%s' '11111111-2222-3333-4444-555555555555' >"$host_root/proc/sys/kernel/random/boot_id"
printf '%s' '3723.14 100.00' >"$host_root/proc/uptime"
printf '%s' 'backup-20260715T120000Z-fixture' >"$host_root/var/lib/learncoding/backups/last-success"
: >"$compose_env_path"
chown 0:0 "$compose_env_path"
chmod 0640 "$compose_env_path"

secret_canary='EVIDENCE_SECRET_CANARY_867ec16a_DO_NOT_PRINT'
learner_canary='EVIDENCE_LEARNER_CANARY_learner@example.invalid'
learner_id_canary='EVIDENCE_LEARNER_ID_CANARY_5b7bdb4e'
source_canary='EVIDENCE_SOURCE_CANARY_private_source_text'
stdin_canary='EVIDENCE_STDIN_CANARY_3efeaa55'
http_body_canary='EVIDENCE_HTTP_BODY_CANARY_0c09407f'
http_header_canary='EVIDENCE_HTTP_HEADER_CANARY_239ff961'
smart_serial_canary='EVIDENCE_SMART_SERIAL_CANARY_S3CR3T42'
runner_journal_canary='EVIDENCE_RUNNER_JOURNAL_CANARY_c80386e0'
raw_command_canary='EVIDENCE_RAW_COMMAND_CANARY_cc4af739'
postgres_sql="SELECT name, setting FROM pg_settings WHERE name IN ('fsync', 'synchronous_commit', 'full_page_writes');"
printf '%s' "$runner_journal_canary" >"$host_root/var/lib/learncoding-runner/private-journal.json"
printf '%s' "$secret_canary" >"$host_root/etc/learncoding/secrets/runner_shared_secret"
chmod 0400 "$host_root/etc/learncoding/secrets/runner_shared_secret"

printf '#!%s\n' "$bash_bin" >"$fake_bin/fake-evidence-command"
cat >>"$fake_bin/fake-evidence-command" <<'FAKE'
set -Eeuo pipefail
umask 077

command_name="${0##*/}"
{
  printf '%q' "$command_name"
  for argument in "$@"; do printf ' %q' "$argument"; done
  printf '\n'
} >>"$FAKE_EVENTS"
scenario="$(<"$FAKE_SCENARIO_FILE")"

inside_host_root() {
  safe_under "$FAKE_HOST_ROOT" "$1"
}

inside_evidence_root() {
  safe_under "$FAKE_EVIDENCE_ROOT" "$1"
}

inside_curl_output_root() {
  local candidate="$1"
  local basename="${candidate##*/}"
  safe_under "$FAKE_CURL_ROOT" "$candidate" || {
    inside_evidence_root "$candidate" && [[ "$basename" == *tmp* ]]
  }
}

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

case "$command_name" in
  id)
    [[ "$#" == 1 && "$1" == -u ]] || exit 64
    printf '%s\n' "$EUID"
    ;;
  systemctl)
    case "${1:-}" in
      is-active)
        [[ "$#" == 2 && "$2" =~ ^(docker|libvirtd|learncoding-runner-firewall|learncoding-compose)\.service$ ]] || exit 64
        printf '%s\n' active
        ;;
      is-enabled)
        [[ "$#" == 2 && "$2" =~ ^learncoding-(backup|backup-check|retention|recovery-check)\.timer$ ]] || exit 64
        printf '%s\n' enabled
        ;;
      show)
        [[ "$#" == 4 && "$3" == --property=NRestarts && "$4" == --value ]] || exit 64
        [[ "$2" =~ ^learncoding-[A-Za-z0-9@_.-]+\.(service|timer)$ ]] || exit 64
        printf '%s\n' 1
        ;;
      *) exit 64 ;;
    esac
    ;;
  virsh)
    if [[ "${1:-}" == --version ]]; then printf '%s\n' '10.0.0-fixture'; exit 0; fi
    if [[ "${1:-}" == --connect && "${2:-}" == qemu:///system ]]; then shift 2; fi
    [[ "$#" == 2 ]] || exit 64
    case "${1:-}:${2:-}" in
      domstate:codestead-runner) printf '%s\n' running ;;
      dominfo:codestead-runner) printf '%s\n' 'Name: codestead-runner' 'Autostart: enable' ;;
      net-info:codestead-runner) printf '%s\n' 'Name: codestead-runner' 'Active: yes' 'Autostart: yes' ;;
      *) exit 64 ;;
    esac
    ;;
  docker)
    if [[ "$#" == 3 && "$1" == version && "$2" == --format && "$3" == '{{.Server.Version}}' ]]; then
      printf '%s\n' '29.6.1-fixture'
      exit 0
    fi
    if [[ "$#" == 1 && "$1" == info ]]; then exit 0; fi
    if [[ "$#" == 16 && "$1" == compose && "$2" == --env-file && "$3" == "$FAKE_COMPOSE_ENV" && \
      "$4" == -f && "$5" == "$FAKE_COMPOSE_FILE" && "$6" == exec && "$7" == -T && \
      "$8" == postgres && "$9" == psql && "${10}" == --username=learncoding && \
      "${11}" == --dbname=learncoding && "${12}" == --no-align && "${13}" == --tuples-only && \
      "${14}" == '--field-separator=|' && "${15}" == --command && "${16}" == "$FAKE_POSTGRES_SQL" ]]; then
      printf '%s\n' 'fsync|on' 'synchronous_commit|on' 'full_page_writes|on' 'data_checksums|on'
      exit 0
    fi
    if [[ "$#" == 3 && "$1" == ps && "$2" == --all && "$3" == --quiet ]]; then
      printf '%s\n' aaaaaaaaaaaa bbbbbbbbbbbb cccccccccccc dddddddddddd eeeeeeeeeeee
      printf 'private Docker diagnostic: %s %s %s %s\n' \
        "$FAKE_RAW_COMMAND_CANARY" "$FAKE_LEARNER_CANARY" "$FAKE_SOURCE_CANARY" "$FAKE_LEARNER_ID_CANARY" >&2
      exit 0
    fi
    if [[ "$#" == 4 && "$1" == inspect && "$2" == --format && \
      "$3" == '{{.Name}}|{{.State.Status}}|{{.RestartCount}}|{{.Image}}' ]]; then
      case "$4" in
        aaaaaaaaaaaa) printf '/learncoding-postgres|running|1|sha256:%s\n' "$(printf 'a%.0s' {1..64})" ;;
        bbbbbbbbbbbb) printf '/learncoding-app|running|0|sha256:%s\n' "$(printf 'b%.0s' {1..64})" ;;
        cccccccccccc) printf '/learncoding-mail-worker|running|0|sha256:%s\n' "$(printf 'c%.0s' {1..64})" ;;
        dddddddddddd) printf '/learncoding-reward-worker|running|0|sha256:%s\n' "$(printf 'd%.0s' {1..64})" ;;
        eeeeeeeeeeee) printf '/learncoding-cloudflared|running|0|sha256:%s\n' "$(printf 'e%.0s' {1..64})" ;;
        *) exit 64 ;;
      esac
      exit 0
    fi
    exit 64
    ;;
  curl)
    [[ "$#" == 11 && "$1" == --silent && "$2" == --show-error && "$3" == --fail && \
      "$4" == --max-time && "$5" == 10 && "$6" == --output && "$8" == --dump-header && \
      "${10}" == --url && "${11}" == https://pilot.example.test/health/ready ]] || exit 64
    output="$7"
    headers="$9"
    url="${11}"
    [[ "$url" == https://pilot.example.test/health/ready ]] || exit 97
    body="{\"status\":\"ok\",\"private\":\"$FAKE_HTTP_BODY_CANARY\"}"
    header="HTTP/2 200
x-private-fixture: $FAKE_HTTP_HEADER_CANARY"
    if [[ -n "$output" ]]; then
      inside_curl_output_root "$output" || exit 97
      printf '%s' "$body" >"$output"
    else
      printf '%s' "$body"
    fi
    if [[ -n "$headers" ]]; then
      inside_curl_output_root "$headers" || exit 97
      printf '%s\n' "$header" >"$headers"
    fi
    ;;
  journalctl)
    [[ "$#" == 0 ]] || exit 64
    printf '%s\n' "$FAKE_RUNNER_JOURNAL_CANARY"
    ;;
  findmnt)
    [[ "$#" == 5 && "$1" == --json && "$2" == --output && "$3" == TARGET,SOURCE,OPTIONS && \
      "$4" == --target && "$5" == /srv/learncoding ]] || exit 64
    printf '%s\n' '{"filesystems":[{"target":"/srv/learncoding","source":"UUID=fixture-data","options":"rw,nodev,nosuid"}]}'
    ;;
  smartctl)
    [[ "$#" == 3 && "$1" == --health && "$2" == --attributes && "$3" == /dev/nvme0n1 ]] || exit 64
    [[ "$scenario" != smart-fail ]] || exit 2
    printf '%s\n' \
      "Serial Number: $FAKE_SMART_SERIAL_CANARY" \
      'SMART overall-health self-assessment test result: PASSED' \
      'Critical Warning: 0x00' \
      'Media and Data Integrity Errors: 0'
    ;;
  date)
    case "$#:${1:-}:${2:-}" in
      '2:--utc:+%Y-%m-%dT%H:%M:%SZ') printf '%s\n' '2026-07-15T12:00:00Z' ;;
      '1:+%s:') printf '%s\n' 1784116800 ;;
      *) exit 64 ;;
    esac
    ;;
  git)
    [[ "$#" == 4 && "$1" == -C && "$2" == "$FAKE_REPO_ROOT" && "$3" == rev-parse && "$4" == HEAD ]] || exit 64
    printf '%s\n' '0123456789abcdef0123456789abcdef01234567'
    ;;
  uname)
    [[ "${1:-}" == -r ]] || exit 64
    printf '%s\n' '6.8.0-fixture'
    ;;
  mktemp)
    destination_hint="${!#}"
    tmpdir=
    expect_tmpdir=false
    for argument in "$@"; do
      if [[ "$expect_tmpdir" == true ]]; then tmpdir="$argument"; expect_tmpdir=false; continue; fi
      case "$argument" in
        -d) ;;
        -p|--tmpdir) expect_tmpdir=true ;;
        --tmpdir=*) tmpdir="${argument#--tmpdir=}" ;;
        -*) exit 64 ;;
        *) destination_hint="$argument" ;;
      esac
    done
    [[ "$expect_tmpdir" == false ]] || exit 64
    if [[ -n "$tmpdir" ]]; then
      inside_evidence_root "$tmpdir" || exit 97
      [[ -n "$destination_hint" && "$destination_hint" != */* && "$destination_hint" != . && "$destination_hint" != .. ]] || exit 97
      inside_evidence_root "$tmpdir/$destination_hint" || exit 97
    else
      inside_evidence_root "$destination_hint" || exit 97
    fi
    /usr/bin/mktemp "$@"
    ;;
  mv)
    args=("$@")
    [[ "${args[0]:-}" == -- ]] && args=("${args[@]:1}")
    (( ${#args[@]} == 2 )) || exit 64
    source_path="${args[0]}"
    destination_path="${args[1]}"
    inside_evidence_root "$source_path" && inside_evidence_root "$destination_path" || exit 97
    [[ "$(/usr/bin/dirname -- "$source_path")" == "$(/usr/bin/dirname -- "$destination_path")" ]] || exit 96
    /usr/bin/mv -- "$source_path" "$destination_path"
    ;;
  sync)
    sync_targets=()
    for argument in "$@"; do case "$argument" in -f|--file-system|--) ;; -*) exit 64 ;; *) sync_targets+=("$argument") ;; esac; done
    (( ${#sync_targets[@]} > 0 )) || exit 64
    for target in "${sync_targets[@]}"; do inside_evidence_root "$target" || exit 97; done
    ;;
  rm)
    rm_args=("$@")
    rm_targets=()
    for argument in "${rm_args[@]}"; do case "$argument" in --|-f) ;; -*) exit 64 ;; *) rm_targets+=("$argument") ;; esac; done
    (( ${#rm_targets[@]} > 0 )) || exit 64
    for target in "${rm_targets[@]}"; do
      inside_evidence_root "$target" || exit 97
      basename="${target##*/}"
      [[ "$basename" == .*tmp* || "$basename" == *.tmp.* ]] || exit 96
    done
    /usr/bin/rm "${rm_args[@]}"
    ;;
  cat)
    for path in "$@"; do
      [[ "$path" == -- ]] && continue
      [[ "$path" != *learncoding-runner* ]] || exit 97
      [[ "$path" != */secrets/* ]] || exit 97
      inside_host_root "$path" || exit 97
    done
    /usr/bin/cat "$@"
    ;;
  stat|realpath|readlink|sha256sum)
    read_targets=()
    expect_format=false
    for argument in "$@"; do
      if [[ "$expect_format" == true ]]; then expect_format=false; continue; fi
      case "$argument" in -c|--format|--printf) expect_format=true ;; --|-e|-f|-m|-n|-q|-s|-v|--check|--status|--strict|--format=*|--printf=*) ;; -*) exit 64 ;; *) read_targets+=("$argument") ;; esac
    done
    [[ "$expect_format" == false && ${#read_targets[@]} == 1 ]] || exit 64
    for target in "${read_targets[@]}"; do inside_host_root "$target" || exit 97; done
    "/usr/bin/$command_name" "$@"
    ;;
  chmod)
    chmod_args=("$@")
    [[ ${#chmod_args[@]} -ge 2 ]] || exit 64
    mode="${chmod_args[0]}"
    [[ "$mode" =~ ^[0-7]{3,4}$ ]] || exit 64
    for target in "${chmod_args[@]:1}"; do [[ "$target" == -- ]] || inside_evidence_root "$target" || exit 97; done
    /usr/bin/chmod "${chmod_args[@]}"
    ;;
  chown)
    chown_args=("$@")
    [[ ${#chown_args[@]} -ge 2 && "${chown_args[0]}" == 0:0 ]] || exit 64
    for target in "${chown_args[@]:1}"; do [[ "$target" == -- ]] || inside_evidence_root "$target" || exit 97; done
    ;;
  mkdir)
    mkdir_args=("$@")
    mkdir_targets=()
    expect_mode=false
    for argument in "${mkdir_args[@]}"; do
      if [[ "$expect_mode" == true ]]; then expect_mode=false; continue; fi
      case "$argument" in -p|--) ;; -m) expect_mode=true ;; -*) exit 64 ;; *) mkdir_targets+=("$argument") ;; esac
    done
    [[ "$expect_mode" == false && ${#mkdir_targets[@]} -gt 0 ]] || exit 64
    for target in "${mkdir_targets[@]}"; do inside_evidence_root "$target" || exit 97; done
    /usr/bin/mkdir "${mkdir_args[@]}"
    ;;
  mount|umount|wget|nc|ping|dd|truncate|touch|tee|ln|rsync|sudo|ssh|scp|socat|install)
    exit 97
    ;;
  *) exit 64 ;;
esac
FAKE
chmod 0755 "$fake_bin/fake-evidence-command"
for command_name in id systemctl virsh docker curl journalctl findmnt smartctl date git uname mktemp mv sync rm cat \
  stat realpath readlink sha256sum chmod chown mkdir \
  mount umount wget nc ping dd truncate touch tee ln rsync sudo ssh scp socat install; do
  cp "$fake_bin/fake-evidence-command" "$fake_bin/$command_name"
done

outside_sentinel="$work/outside-fake-roots.sentinel"
printf '%s' 'outside-fixture-sentinel-unchanged' >"$outside_sentinel"
printf '%s' success >"$scenario_file"
: >"$events"
set +e
"$env_bin" -i PATH="$fake_bin" FAKE_EVENTS="$events" FAKE_SCENARIO_FILE="$scenario_file" \
  FAKE_HOST_ROOT="$host_root" FAKE_EVIDENCE_ROOT="$evidence_root" FAKE_CURL_ROOT="$curl_root" \
  "$fake_bin/cat" -- "$outside_sentinel" >"$work/outside-read.stdout" 2>"$work/outside-read.stderr"
outside_read_status=$?
"$env_bin" -i PATH="$fake_bin" FAKE_EVENTS="$events" FAKE_SCENARIO_FILE="$scenario_file" \
  FAKE_HOST_ROOT="$host_root" FAKE_EVIDENCE_ROOT="$evidence_root" FAKE_CURL_ROOT="$curl_root" \
  "$fake_bin/cat" -- "$host_root/etc/learncoding/secrets/runner_shared_secret" \
  >"$work/secret-read.stdout" 2>"$work/secret-read.stderr"
secret_read_status=$?
PATH="$fake_bin" cp -- "$host_root/proc/uptime" "$outside_sentinel" >"$work/outside-write.stdout" 2>"$work/outside-write.stderr"
outside_write_status=$?
PATH="$fake_bin" evidence-contract-unknown-command >"$work/outside-unknown.stdout" 2>"$work/outside-unknown.stderr"
outside_unknown_status=$?
set -e
(( outside_read_status != 0 && secret_read_status != 0 && outside_write_status != 0 && outside_unknown_status != 0 )) ||
  fail 'fake-only evidence PATH allowed an unknown, secret/outside read, or outside write command'
[[ "$(<"$outside_sentinel")" == 'outside-fixture-sentinel-unchanged' ]] ||
  fail 'outside-fixture evidence sentinel was modified'
[[ ! -s "$work/secret-read.stdout" ]] || fail 'secret-read boundary returned secret bytes'

run_collector() {
  local scenario="$1"
  local phase="$2"
  local destination="$3"
  local prefix="$4"
  printf '%s' "$scenario" >"$scenario_file"
  : >"$events"
  set +e
  printf '%s' "$stdin_canary" | "$env_bin" -i \
    HOME="$work" \
    PATH="$fake_bin" \
    TMPDIR="$curl_root" \
    RECOVERY_EVIDENCE_TEST_ROOT="$host_root" \
    RECOVERY_PUBLIC_URL='https://pilot.example.test/health/ready' \
    FAKE_EVENTS="$events" \
    FAKE_SCENARIO_FILE="$scenario_file" \
    FAKE_HOST_ROOT="$host_root" \
    FAKE_EVIDENCE_ROOT="$evidence_root" \
    FAKE_CURL_ROOT="$curl_root" \
    FAKE_COMPOSE_ENV="$compose_env_path" \
    FAKE_COMPOSE_FILE="$repo_root/compose.yaml" \
    FAKE_POSTGRES_SQL="$postgres_sql" \
    FAKE_REPO_ROOT="$repo_root" \
    FAKE_SECRET_CANARY="$secret_canary" \
    FAKE_LEARNER_CANARY="$learner_canary" \
    FAKE_LEARNER_ID_CANARY="$learner_id_canary" \
    FAKE_SOURCE_CANARY="$source_canary" \
    FAKE_HTTP_BODY_CANARY="$http_body_canary" \
    FAKE_HTTP_HEADER_CANARY="$http_header_canary" \
    FAKE_SMART_SERIAL_CANARY="$smart_serial_canary" \
    FAKE_RUNNER_JOURNAL_CANARY="$runner_journal_canary" \
    FAKE_RAW_COMMAND_CANARY="$raw_command_canary" \
    "$bash_bin" "$collector_under_test" "$phase" "$destination" >"$prefix.stdout" 2>"$prefix.stderr"
  collector_status=$?
  set -e
  [[ "$(<"$outside_sentinel")" == 'outside-fixture-sentinel-unchanged' ]] ||
    fail 'evidence collector modified the outside-fixture sentinel'
}

assert_canaries_absent() {
  local prefix="$1"
  shift
  local file
  local canary
  for file in "$prefix.stdout" "$prefix.stderr" "$@"; do
    [[ -e "$file" ]] || continue
    for canary in "$secret_canary" "$learner_canary" "$learner_id_canary" "$source_canary" "$stdin_canary" \
      "$http_body_canary" "$http_header_canary" "$smart_serial_canary" "$runner_journal_canary" "$raw_command_canary"; do
      ! grep -Fq -- "$canary" "$file" || fail "privacy canary leaked through ${file##*/}: $canary"
    done
  done
}

assert_no_secret_or_runner_read() {
  ! grep -Eiq '/etc/learncoding/secrets|/secrets/|runner_shared_secret|RUNNER_[A-Z0-9_]*SECRET|/var/lib/learncoding-runner' "$events" ||
    fail 'evidence collector attempted a secret or runner-private read'
}

validate_evidence_json() {
  local file="$1"
  local phase="$2"
  EVIDENCE_FILE="$file" EXPECTED_PHASE="$phase" "$node_bin" <<'NODE'
const fs = require("node:fs");
const value = JSON.parse(fs.readFileSync(process.env.EVIDENCE_FILE, "utf8"));
const exactKeys = (object, expected) =>
  JSON.stringify(Object.keys(object ?? {}).sort()) === JSON.stringify([...expected].sort());
if (!exactKeys(value, [
  "backup", "bootId", "capturedAtUtc", "containers", "gitCommit", "mounts", "phase",
  "postgres", "recovery", "runner", "schemaVersion", "services", "smart", "uptimeSeconds", "versions",
])) process.exit(2);
if (value.schemaVersion !== 1 || value.phase !== process.env.EXPECTED_PHASE) process.exit(3);
if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value.capturedAtUtc)) process.exit(4);
if (!/^[0-9a-f]{40}$/.test(value.gitCommit) || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value.bootId)) process.exit(5);
if (!Number.isSafeInteger(value.uptimeSeconds) || value.uptimeSeconds < 0 || value.uptimeSeconds > 315576000) process.exit(6);
if (!exactKeys(value.services, ["compose", "docker", "firewall", "libvirt", "recoveryTimer"])) process.exit(7);
if (Object.values(value.services).some((entry) => typeof entry !== "boolean")) process.exit(8);
if (!exactKeys(value.containers, ["expected", "items", "running"]) || !Array.isArray(value.containers.items)) process.exit(9);
if (value.containers.items.length > 16) process.exit(10);
if (!Number.isSafeInteger(value.containers.expected) || !Number.isSafeInteger(value.containers.running) ||
    value.containers.expected < 0 || value.containers.running < 0 || value.containers.running > value.containers.expected ||
    value.containers.items.length !== value.containers.expected) process.exit(25);
for (const item of value.containers.items) {
  if (!exactKeys(item, ["imageId", "name", "restartCount", "status"])) process.exit(11);
  if (!/^[a-z0-9][a-z0-9_.-]{0,63}$/.test(item.name) || !/^sha256:[0-9a-f]{64}$/.test(item.imageId)) process.exit(12);
  if (!Number.isSafeInteger(item.restartCount) || item.restartCount < 0 || item.restartCount > 1000000) process.exit(13);
  if (!new Set(["running", "exited", "paused", "restarting"]).has(item.status)) process.exit(26);
}
if (value.containers.running !== value.containers.items.filter((item) => item.status === "running").length) process.exit(34);
if (!exactKeys(value.runner, ["domainActive", "domainAutostart", "networkActive", "networkAutostart"])) process.exit(14);
if (Object.values(value.runner).some((entry) => typeof entry !== "boolean")) process.exit(27);
if (!Array.isArray(value.mounts) || value.mounts.length < 1 || value.mounts.length > 3) process.exit(15);
const allowedMountTargets = new Set(["/etc/learncoding", "/opt/learncoding", "/srv/learncoding"]);
const observedMountTargets = new Set();
for (const mount of value.mounts) {
  if (!exactKeys(mount, ["options", "source", "target"])) process.exit(16);
  for (const field of ["options", "source", "target"]) {
    if (typeof mount[field] !== "string" || mount[field].length < 1 || mount[field].length > 256 || /[\r\n\0]/u.test(mount[field])) process.exit(28);
  }
  if (!allowedMountTargets.has(mount.target) || observedMountTargets.has(mount.target) ||
      !/^\/(?:etc|opt|srv)\/learncoding$/u.test(mount.target) ||
      !/^[A-Za-z0-9_.,=:/+-]+$/u.test(mount.source) || !/^[A-Za-z0-9_.,=:/+-]+$/u.test(mount.options)) process.exit(29);
  observedMountTargets.add(mount.target);
}
if (!exactKeys(value.postgres, ["checksums", "durability", "healthy"])) process.exit(17);
if (!exactKeys(value.postgres.durability, ["fsync", "fullPageWrites", "synchronousCommit"])) process.exit(18);
if (Object.values(value.postgres.durability).some((entry) => entry !== "on")) process.exit(19);
if (typeof value.postgres.checksums !== "boolean" || typeof value.postgres.healthy !== "boolean") process.exit(30);
if (!exactKeys(value.smart, ["criticalWarnings", "healthy", "mediaErrors"])) process.exit(20);
if (typeof value.smart.healthy !== "boolean" || !Number.isSafeInteger(value.smart.criticalWarnings) ||
    !Number.isSafeInteger(value.smart.mediaErrors) || value.smart.criticalWarnings < 0 ||
    value.smart.criticalWarnings > 255 || value.smart.mediaErrors < 0 || value.smart.mediaErrors > 1000000000) process.exit(31);
if (!exactKeys(value.backup, ["lastSuccessfulId"])) process.exit(21);
if (typeof value.backup.lastSuccessfulId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.backup.lastSuccessfulId)) process.exit(32);
if (!exactKeys(value.recovery, ["elapsedSeconds", "recovered", "timedOut"])) process.exit(22);
if (!Number.isSafeInteger(value.recovery.elapsedSeconds) || value.recovery.elapsedSeconds < 0 || value.recovery.elapsedSeconds > 900 ||
    typeof value.recovery.recovered !== "boolean" || typeof value.recovery.timedOut !== "boolean") process.exit(33);
if (value.recovery.recovered && value.recovery.timedOut) process.exit(35);
if (!exactKeys(value.versions, ["docker", "hostKernel", "libvirt"])) process.exit(23);
if (Object.values(value.versions).some((entry) => typeof entry !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/u.test(entry))) process.exit(24);
NODE
}

assert_published() {
  local phase="$1"
  local name="$2"
  local prefix="$3"
  local json="$evidence_root/$name"
  local sidecar="$json.sha256"
  (( collector_status == 0 )) || fail "$phase evidence collection failed: $(<"$prefix.stderr")"
  for file in "$json" "$sidecar"; do
    [[ -f "$file" && ! -L "$file" ]] || fail "published evidence is not a regular non-symlink: $file"
    [[ "$(stat -c '%u:%g:%a' -- "$file")" == '0:0:600' ]] || fail "published evidence metadata is not root:root 0600: $file"
  done
  validate_evidence_json "$json" "$phase"
  sidecar_line="$(<"$sidecar")"
  [[ "$sidecar_line" =~ ^[0-9a-f]{64}[[:space:]][[:space:]]${name//./\.}$ ]] || fail 'checksum sidecar must name only the final basename'
  [[ "$sidecar_line" != *'/var/'* && "$sidecar_line" != *"$host_root"* ]] || fail 'checksum sidecar embedded an absolute path'
  (cd "$evidence_root" && sha256sum --check -- "$name.sha256" >/dev/null) || fail 'checksum does not verify the exact final JSON bytes'
  assert_canaries_absent "$prefix" "$json" "$sidecar" "$events"
  assert_no_secret_or_runner_read
  [[ ! -s "$prefix.stderr" ]] || fail 'successful evidence collection emitted raw stderr output'
  if find "$evidence_root" -maxdepth 1 -type f \( -name '*.tmp*' -o -name '.*.tmp*' \) -print -quit | grep -q .; then
    fail 'temporary evidence file remained after successful publication'
  fi
  mv_events="$(grep -c '^mv ' "$events" || true)"
  (( mv_events >= 2 )) || fail 'JSON and checksum were not atomically renamed from same-directory temporaries'
  sync_events="$(grep -c '^sync ' "$events" || true)"
  (( sync_events >= 2 )) || fail 'JSON and checksum temporaries were not flushed before publication'
  first_sync_line="$(grep -n '^sync ' "$events" | head -n 1 | cut -d: -f1)"
  first_mv_line="$(grep -n '^mv ' "$events" | head -n 1 | cut -d: -f1)"
  (( first_sync_line < first_mv_line )) || fail 'evidence was renamed before its temporary bytes were flushed'
}

run_collector success pre '/var/lib/learncoding/recovery-evidence/pre.json' "$work/pre"
assert_published pre pre.json "$work/pre"
run_collector success post '/var/lib/learncoding/recovery-evidence/post.json' "$work/post"
assert_published post post.json "$work/post"

expect_rejected_before_collection() {
  local label="$1"
  local phase="$2"
  local destination="$3"
  local prefix="$work/rejected-$label"
  run_collector invalid "$phase" "$destination" "$prefix"
  (( collector_status != 0 )) || fail "$label unexpectedly succeeded"
  assert_canaries_absent "$prefix" "$events"
  assert_no_secret_or_runner_read
  if grep -Eq '^(systemctl|virsh|docker|curl|journalctl|findmnt|smartctl|date|git|uname) ' "$events"; then
    fail "$label collected host evidence before rejecting its destination"
  fi
}

expect_rejected_before_collection bad-phase during '/var/lib/learncoding/recovery-evidence/bad.json'
expect_rejected_before_collection relative pre 'relative.json'
expect_rejected_before_collection traversal pre '/var/lib/learncoding/recovery-evidence/../escape.json'
expect_rejected_before_collection dot-alias pre '/var/lib/learncoding/recovery-evidence/./dot.json'
expect_rejected_before_collection prefix-sibling pre '/var/lib/learncoding/recovery-evidence-sibling/out.json'

mkdir -m 0600 "$evidence_root/non-regular.json"
expect_rejected_before_collection non-regular-destination pre '/var/lib/learncoding/recovery-evidence/non-regular.json'
rmdir "$evidence_root/non-regular.json"

mkdir -m 0600 "$evidence_root/non-regular-sidecar.json.sha256"
expect_rejected_before_collection non-regular-sidecar pre '/var/lib/learncoding/recovery-evidence/non-regular-sidecar.json'
rmdir "$evidence_root/non-regular-sidecar.json.sha256"

printf '%s' 'outside' >"$work/outside.json"
ln -s "$work/outside.json" "$evidence_root/symlink.json"
expect_rejected_before_collection symlink-destination pre '/var/lib/learncoding/recovery-evidence/symlink.json'
rm -- "$evidence_root/symlink.json"

ln -s "$work/outside.json" "$evidence_root/symlink-sidecar.json.sha256"
expect_rejected_before_collection symlink-sidecar pre '/var/lib/learncoding/recovery-evidence/symlink-sidecar.json'
rm -- "$evidence_root/symlink-sidecar.json.sha256"

mkdir -m 0700 "$evidence_root/component.real"
ln -s "$evidence_root/component.real" "$evidence_root/component"
expect_rejected_before_collection symlink-component pre '/var/lib/learncoding/recovery-evidence/component/out.json'
rm -- "$evidence_root/component"
rmdir "$evidence_root/component.real"

mv "$evidence_root" "$evidence_root.real"
ln -s "$evidence_root.real" "$evidence_root"
expect_rejected_before_collection symlink-root pre '/var/lib/learncoding/recovery-evidence/root-link.json'
rm -- "$evidence_root"
mv "$evidence_root.real" "$evidence_root"

learncoding_state_root="$host_root/var/lib/learncoding"
mv "$learncoding_state_root" "$learncoding_state_root.real"
ln -s "$learncoding_state_root.real" "$learncoding_state_root"
expect_rejected_before_collection symlink-parent-component pre '/var/lib/learncoding/recovery-evidence/parent-link.json'
rm -- "$learncoding_state_root"
mv "$learncoding_state_root.real" "$learncoding_state_root"

chown 65534:65534 "$evidence_root"
expect_rejected_before_collection non-root-owned-root pre '/var/lib/learncoding/recovery-evidence/wrong-owner.json'
chown 0:0 "$evidence_root"
chmod 0700 "$evidence_root"

run_collector smart-fail post '/var/lib/learncoding/recovery-evidence/interrupted.json' "$work/interrupted"
(( collector_status != 0 )) || fail 'collector published evidence after a collection command failed'
[[ ! -e "$evidence_root/interrupted.json" && ! -e "$evidence_root/interrupted.json.sha256" ]] ||
  fail 'collector published a partial result after failure'
if find "$evidence_root" -maxdepth 1 \( -name '*interrupted*tmp*' -o -name '.*interrupted*' \) -print -quit | grep -q .; then
  fail 'collector left its exact publication temporary after failure'
fi
assert_canaries_absent "$work/interrupted" "$events"
assert_no_secret_or_runner_read

echo 'power-evidence-tests-ok'
