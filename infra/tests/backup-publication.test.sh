#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
verifier="$repo_root/scripts/backup/verify-archive.sh"
probe="$repo_root/scripts/backup/create-credential-probe.ts"
backup_controller="${BACKUP_SCRIPT_UNDER_TEST:-$repo_root/scripts/backup/backup.sh}"
test_group="${BACKUP_PUBLICATION_TEST_GROUP:-all}"

fail() {
  printf '%s\n' "$1" >&2
  exit 1
}

case "$test_group" in
  all|c1-key-exclusion|clamav-restart-lifecycle|m10-marker-monitor \
    |m1-transient-mutator|m2-marker-ambiguous|m2-marker-window \
    |m2-post-effect-renames|m3-budget-exhaustion|m3-hard-deadline \
    |m4-nested-schema|m5-provenance|m6-controller-verifier-failures \
    |m6-destination-safety|m6-production-canonical|m7-directory-safety \
    |m8-stale-sentinels|m9-bounded-event-audit|marker-writer-process-group \
    |migration-parser-deadline|minor-staging-cleanup \
    |monitor-cleanup-containment|postgres-continuity \
    |quiesce-event-lifecycle|strict-event-record|verifier \
    |immutable-event-checkpoints|immutable-event-checkpoint-parser \
    |event-parser-boundaries)
    ;;
  *)
    fail "unknown BACKUP_PUBLICATION_TEST_GROUP: $test_group"
    ;;
esac

[[ -f "$verifier" ]] || fail "verified publication is missing verify-archive.sh"
[[ -f "$probe" ]] || fail "verified publication is missing create-credential-probe.ts"
grep -Fq 'backup:credential-probe' "$repo_root/package.json" \
  || fail "verified publication is missing the credential-probe package command"
grep -Fq 'write_success_marker' "$repo_root/scripts/backup/backup.sh" \
  || fail "backup publication does not commit through the success marker"
grep -Fq 'verify-archive.sh' "$repo_root/scripts/backup/backup.sh" \
  || fail "backup publication does not decrypt-verify its candidate"
if grep -Fq 'offsite-sync.sh' "$repo_root/scripts/backup/backup.sh"; then
  fail "backup publication still performs inline offsite synchronization"
fi
/usr/bin/python3 - "$repo_root/scripts/backup/backup.sh" <<'PY'
import pathlib
import re
import sys

source = pathlib.Path(sys.argv[1]).read_text(encoding="utf-8")
pattern = re.compile(
    r"publication_commit_uncertain=1\s+"
    r"marker_validation_pending=1\s+"
    r"if ! run_deadline bash -c \"\$marker_command\".*?; then\s+"
    r"die \"success marker durability failed\"\s+"
    r"fi\s+marker_published=1\s+"
    r"close_event_monitor.*?\s+marker_validation_pending=0\s+"
    r"marker_committed=1\s+publication_commit_uncertain=0",
    re.DOTALL,
)
if not pattern.search(source):
    raise SystemExit(
        "marker publication is not audited through rename and directory durability"
    )
if not re.search(
    r'credential_inode_match="\$\(run_deadline find -P .*?'
    r'-samefile "\$CREDENTIAL_MASTER_KEY_FILE" -print -quit\)"',
    source,
    re.DOTALL,
):
    raise SystemExit("credential-key inode scan is not inside the shared deadline")
if re.search(
    r'find -P "\$LEARN_DATA_ROOT/app-data".*?-printf .*?\|\s*grep -Fqx',
    source,
    re.DOTALL,
):
    raise SystemExit("credential-key inode scan still uses an ambiguous unbounded pipeline")
if "--label com.centurylinklabs.watchtower.enable=false" not in source:
    raise SystemExit("backup monitor sentinels are not opted out of Watchtower")
if not re.search(
    r'docker compose .*?config --format json.*?compose_project_name',
    source,
    re.DOTALL,
):
    raise SystemExit("event monitor project filter is not derived from Compose config")
PY

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/bin" "$work/live-repo" "$work/live-data/app-data" \
  "$work/live-backups" "$work/stages" "$work/runtime"

cat >"$work/bin/age" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
mode="${1:-}"
shift
output=""
identity=""
recipients=""
while (($# > 1)); do
  case "$1" in
    --identity) identity="$2"; shift 2 ;;
    --output) output="$2"; shift 2 ;;
    --recipients-file) recipients="$2"; shift 2 ;;
    *) exit 64 ;;
  esac
done
[[ -n "$output" && $# -eq 1 ]] || exit 64
case "$mode" in
  --decrypt)
    [[ -n "$identity" && -f "$identity" ]] || exit 64
    if [[ "${TEST_REPLACE_VERIFY_DEST:-0}" == 1 ]]; then
      destination="$(dirname -- "$output")"
      mv -- "$destination" "${destination}.original"
      mkdir -m 0700 -- "$destination"
      printf '%s\n' preserve-replacement >"$destination/do-not-delete"
      printf '%s\n' preserve-lookalike >"$output"
      exit 75
    fi
    [[ "${TEST_AGE_DECRYPT_FAIL:-0}" != 1 ]] || exit 75
    if [[ -n "${TEST_CONTROLLER_ENVELOPE_MUTATION:-}" ]]; then
      "$TEST_ENVELOPE_MUTATOR" "$1" "$output" "$TEST_CONTROLLER_ENVELOPE_MUTATION"
    else
      cp -- "$1" "$output"
    fi
    ;;
  --encrypt)
    [[ -n "$recipients" && -f "$recipients" ]] || exit 64
    [[ "${TEST_AGE_ENCRYPT_FAIL:-0}" != 1 ]] || exit 76
    cp -- "$1" "$output"
    ;;
  *) exit 64 ;;
esac
EOF
cat >"$work/bin/mutate-envelope" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
input="$1"
output="$2"
mutation="$3"
if [[ "$mutation" == outer-list ]]; then
  printf '%s' not-a-tar-stream >"$output"
  exit 0
fi
root="$(mktemp -d)"
trap 'rm -rf -- "$root"' EXIT
tar -xzf "$input" -C "$root"
members=(MANIFEST.txt SHA256SUMS)
[[ ! -f "$root/app-data.tar.gz" ]] || members+=(app-data.tar.gz)
members+=(credential-probe.json database.dump repository.tar.gz)
case "$mutation" in
  unsafe-path)
    printf unsafe >"$root/unsafe-source"
    tar --absolute-names -C "$root" \
      --transform='s|^unsafe-source$|../escape|' -czf "$output" unsafe-source
    ;;
  unsafe-type)
    rm -f -- "$root/database.dump"
    mkdir "$root/database.dump"
    tar -C "$root" -czf "$output" "${members[@]}"
    ;;
  internal-checksum)
    printf tampered >>"$root/database.dump"
    tar -C "$root" -czf "$output" "${members[@]}"
    ;;
  manifest)
    sed -i 's/contains_secret_files=false/contains_secret_files=true/' \
      "$root/MANIFEST.txt"
    tar -C "$root" -czf "$output" "${members[@]}"
    ;;
  *) exit 64 ;;
esac
EOF
cat >"$work/bin/age-keygen" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
if [[ "${1:-}" == -y && -f "${2:-}" ]]; then
  printf '%s\n' age1ephemeralpublicationfixture
  exit 0
fi
[[ "${1:-}" == -o && -n "${2:-}" ]] || exit 64
printf '%s\n' AGE-SECRET-KEY-PUBLICATION-FIXTURE >"$2"
chmod 0600 "$2"
EOF
cat >"$work/bin/flock" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
cat >"$work/bin/python3" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
if [[ "${1:-}" == */run-managed-deadline.py ]]; then
  helper_path="$1"
  shift
  if [[ "${1:-}" == --request-stop ]]; then
    if [[ "${TEST_USE_REAL_MANAGED_DEADLINE:-0}" == 1 ]]; then
      [[ "$(uname -s)" == Linux ]] || exit 97
      if [[ -n "${TEST_REAL_STOP_REQUEST_REACHED:-}" ]]; then
        printf '%s\n' reached >"$TEST_REAL_STOP_REQUEST_REACHED"
        chmod 0600 -- "$TEST_REAL_STOP_REQUEST_REACHED"
      fi
      exec /usr/bin/python3 "$helper_path" "$@"
    fi
    helper_control_file="${2:?}"
    shift 2
    helper_request_timeout=""
    while (($# > 0)); do
      case "$1" in
        --expected-control-device|--expected-control-inode|--expected-supervisor-pid|--expected-supervisor-start)
          [[ "${2:-}" =~ ^[1-9][0-9]*$ ]] || exit 96
          shift 2
          ;;
        --request-timeout)
          helper_request_timeout="${2:-}"
          shift 2
          ;;
        *) exit 96 ;;
      esac
    done
    [[ "$helper_request_timeout" =~ ^[1-9][0-9]*$ ]] || exit 96
    [[ -s "$helper_control_file.request" ]] || exit 98
    helper_supervisor="$(<"$helper_control_file.request")"
    [[ "$helper_supervisor" =~ ^[1-9][0-9]*$ ]] || exit 98
    kill -TERM "$helper_supervisor" 2>/dev/null || exit 98
    for _ in $(seq 1 3000); do
      [[ ! -e "$helper_control_file" && ! -L "$helper_control_file" ]] && exit 0
      kill -0 "$helper_supervisor" 2>/dev/null || exit 98
      /usr/bin/sleep 0.01
    done
    exit 98
  fi
  helper_expected_parent=""
  helper_control_file=""
  while [[ "${1:-}" == --* ]]; do
    case "$1" in
      --expected-parent-pid)
        helper_expected_parent="${2:?}"
        shift 2
        ;;
      --control-file)
        helper_control_file="${2:?}"
        shift 2
        ;;
      *) exit 96 ;;
    esac
  done
  helper_duration="${1:?}"
  helper_grace="${2:?}"
  shift 2
  [[ "${1:-}" == -- ]] || exit 96
  shift
  [[ "$helper_duration" =~ ^[0-9]+([.][0-9]+)?$ \
    && "$helper_grace" =~ ^[0-9]+([.][0-9]+)?$ && $# -gt 0 ]] || exit 96
  if [[ "${TEST_USE_REAL_MANAGED_DEADLINE:-0}" == 1 ]]; then
    [[ "$(uname -s)" == Linux && "$helper_expected_parent" =~ ^[1-9][0-9]*$ ]] \
      || exit 97
    real_duration="$helper_duration"
    real_grace="$helper_grace"
    joined_command=" $* "
    if [[ "${TEST_MARKER_DESCENDANT_TIMEOUT:-0}" == 1 \
      && "$joined_command" == *write_success_marker* ]]; then
      printf '%s\n' observed >"${TEST_MARKER_TIMEOUT_OBSERVED:?}"
      real_duration=5
      real_grace=0.2
    elif [[ "${TEST_MIGRATION_PARSE_TIMEOUT:-0}" == 1 \
      && "$joined_command" == *migration-row-parser* ]]; then
      printf '%s\n' observed >"${TEST_MIGRATION_TIMEOUT_OBSERVED:?}"
      real_duration=1
      real_grace=0.2
    elif [[ "${TEST_MIGRATION_PRODUCER_HANG:-0}" == 1 \
      && "$joined_command" == *__drizzle_migrations* ]]; then
      printf '%s\n' observed >"${TEST_MIGRATION_TIMEOUT_OBSERVED:?}"
      real_duration=1
      real_grace=0.2
    fi
    real_options=(--expected-parent-pid "$helper_expected_parent")
    [[ -z "$helper_control_file" ]] \
      || real_options+=(--control-file "$helper_control_file")
    exec /usr/bin/python3 "$helper_path" "${real_options[@]}" \
      "$real_duration" "$real_grace" -- "$@"
  fi
  event_wait_nested=0
  event_wait_expected=""
  if [[ -z "$helper_control_file" \
    && "$helper_expected_parent" =~ ^[1-9][0-9]*$ && $# -eq 11 \
    && "$1" == bash && "$2" == -c && "$4" == event-wait \
    && "$3" == *'output="$1"'* && "$3" == *'expected="$2"'* \
    && "$3" == *'monitor_pid="$3"'* && "$3" == *'snapshot="$4"'* \
    && "$3" == *'max_bytes="$5"'* && "$3" == *'max_lines="$6"'* \
    && "$3" == *'lower="$7"'* \
    && "$5" == /* && "$7" =~ ^[1-9][0-9]*$ \
    && "$8" == "${5%/*}/.docker-events-wait" \
    && "$9" == 1048576 && "${10}" == 4096 \
    && "${11}" =~ ^[0-9]+$ ]]; then
    event_wait_nested=1
    event_wait_expected="$6"
  fi
  if [[ "${TEST_EVENT_WAIT_SHORT:-0}" == 1 \
    && "$event_wait_nested" == 1 ]]; then
    event_wait_observation_dir="${TEST_EVENT_STATE_DIR:-$(dirname -- "${BACKUP_CONFIG_FILE:?}")/event-monitor}"
    mkdir -p -- "$event_wait_observation_dir"
    event_wait_pipe_count="${event_wait_expected//[!|]/}"
    IFS='|' read -r event_wait_action event_wait_id event_wait_service \
      event_wait_repo event_wait_token event_wait_phase event_wait_signal \
      event_wait_exit event_wait_extra <<<"$event_wait_expected"
    [[ ${#event_wait_pipe_count} -eq 7 \
      && -z "${event_wait_extra:-}" \
      && "$event_wait_id" =~ ^[0-9a-f]{64}$ \
      && "$event_wait_service" == backup-monitor \
      && "$event_wait_repo" == /* \
      && "$event_wait_token" =~ ^[A-Za-z0-9.-]+$ \
      && -z "$event_wait_signal" && -z "$event_wait_exit" ]] || exit 96
    if [[ "${TEST_EVENT_WAIT_DECOY_ACTIVE:-0}" != 1 \
      && ! -e "$event_wait_observation_dir/event-wait-short-decoy-completed" ]]; then
      event_wait_decoy_id="$(printf '%s' checkpoint-2 | sha256sum | awk '{print $1}')"
      event_wait_decoy_record="destroy|$event_wait_decoy_id|backup-monitor|$event_wait_repo|$event_wait_token|checkpoint-2||"
      printf '%s\n' "$event_wait_decoy_record" \
        >"$event_wait_observation_dir/event-wait-short-checkpoint-2-decoy"
      if ! TEST_EVENT_WAIT_DECOY_ACTIVE=1 "$0" "$helper_path" \
        --expected-parent-pid "$BASHPID" 5 1 -- \
        bash -c '
          set -Eeuo pipefail
          output="$1"
          expected="$2"
          monitor_pid="$3"
          snapshot="$4"
          max_bytes="$5"
          max_lines="$6"
          lower="$7"
          [[ -n "$expected" && "$monitor_pid" =~ ^[1-9][0-9]*$ \
            && -n "$snapshot" && "$max_bytes" == 1048576 \
            && "$max_lines" == 4096 && "$lower" == 0 ]] || exit 96
          /usr/bin/sleep 0.8
          printf "%s\n" completed >"$output"
        ' event-wait \
        "$event_wait_observation_dir/event-wait-short-decoy-output" \
        "$event_wait_decoy_record" "$BASHPID" \
        "$event_wait_observation_dir/.docker-events-wait" 1048576 4096 0; then
        printf '%s\n' shortened \
          >"$event_wait_observation_dir/event-wait-short-decoy-shortened"
        exit 96
      fi
      printf '%s\n' completed \
        >"$event_wait_observation_dir/event-wait-short-decoy-completed"
    fi
    if [[ "$event_wait_action" == destroy \
      && "$event_wait_phase" == checkpoint-1 ]]; then
      printf '%s\n' "$event_wait_expected" \
        >>"$event_wait_observation_dir/event-wait-short-invocations"
      printf '%s\n' \
        'run-managed-deadline.py|expected-parent|no-control|bash|-c|event-wait|argc=11|max-bytes=1048576|max-lines=4096' \
        >"$event_wait_observation_dir/event-wait-short-managed-provenance"
      /usr/bin/date +%s%N \
        >"$event_wait_observation_dir/event-wait-short-started"
      helper_duration=0.5
      helper_grace=0.3
    fi
  fi
  if [[ -n "$helper_control_file" ]]; then
    exec bash -c '
      set -Eeuo pipefail
      set -m
      control="$1"
      duration="$2"
      grace="$3"
      shift 3
      "$@" &
      guardian=$!
      supervisor=$BASHPID
      monitor_ready="$(dirname -- "${BACKUP_CONFIG_FILE:?}")/event-monitor/ready"
      while [[ ! -s "$monitor_ready" ]]; do
        kill -0 "$guardian" 2>/dev/null || exit 97
        /usr/bin/sleep 0.01
      done
      supervisor_raw="$(<"/proc/$supervisor/stat")"
      guardian_raw="$(<"/proc/$guardian/stat")"
      supervisor_fields=( ${supervisor_raw##*) } )
      guardian_fields=( ${guardian_raw##*) } )
      [[ "${guardian_fields[2]}" == "$guardian" \
        && "${supervisor_fields[19]}" =~ ^[1-9][0-9]*$ \
        && "${guardian_fields[19]}" =~ ^[1-9][0-9]*$ ]] || exit 97
      endpoint=".managed-deadline-stop-00000000000000000000000000000000.sock"
      nonce="0000000000000000000000000000000000000000000000000000000000000000"
      printf "v1|%s|%s|%s|%s|%s|%s\n" \
        "$supervisor" "${supervisor_fields[19]}" "$guardian" \
        "${guardian_fields[19]}" "$endpoint" "$nonce" >"$control"
      chmod 0600 -- "$control"
      printf "%s\n" "$supervisor" >"$control.request"
      chmod 0600 -- "$control.request"
      cleanup_control() {
        rm -f -- "$control" "$control.request"
      }
      trap cleanup_control EXIT
      forward_term() {
        trap - TERM INT HUP
        kill -TERM -- "-$guardian" 2>/dev/null || true
        wait "$guardian" 2>/dev/null || true
        cleanup_control
        exit 143
      }
      trap forward_term TERM INT HUP
      wait "$guardian"
    ' managed-deadline-control "$helper_control_file" "$helper_duration" \
      "$helper_grace" "$@"
  fi
  exec timeout --kill-after="${helper_grace}s" "${helper_duration}s" \
    bash -c '
      helper_term_received=0
      trap '\''helper_term_received=1'\'' TERM
      helper_status=0
      "$@" || helper_status=$?
      if ((helper_term_received == 1)); then
        trap "" TERM
        while :; do /usr/bin/sleep 1; done
      fi
      exit "$helper_status"
    ' managed-deadline-fixture "$@"
fi
if [[ "${3:-}" == migration-row-parser \
  && "${TEST_MIGRATION_PARSER_FIXTURE:-0}" == 1 ]]; then
  [[ -s "${TEST_MIGRATION_PRODUCER_COMPLETE:?}" ]] || exit 97
  /usr/bin/date +%s%N >"${TEST_MIGRATION_PARSER_STARTED:?}"
  printf '%s\n' observed >"${TEST_MIGRATION_PARSER_OBSERVED:?}"
  if [[ "${TEST_MIGRATION_PARSER_HANG:-0}" == 1 ]]; then
    trap '' TERM
    printf '%s\n' "$BASHPID" >"${TEST_MIGRATION_PARSER_PID:?}"
    if [[ "${TEST_USE_REAL_MANAGED_DEADLINE:-0}" == 1 ]]; then
      record-linux-process-identity "$BASHPID" \
        "${TEST_PROCESS_GROUP_IDENTITY:?}"
    fi
    printf '%s\n' ready >"${TEST_MIGRATION_PARSER_READY:?}"
    exec >/dev/null 2>/dev/null
    while :; do /usr/bin/sleep 0.05; done
  fi
  if [[ -n "${TEST_MIGRATION_SUMMARY_CAPTURE:-}" ]]; then
    summary_temporary="$(/usr/bin/mktemp)"
    parser_error_temporary="$(/usr/bin/mktemp)"
    trap 'rm -f -- "$summary_temporary" "$parser_error_temporary"' EXIT
    parser_status=0
    /usr/bin/python3 "$@" >"$summary_temporary" 2>"$parser_error_temporary" \
      || parser_status=$?
    if ((parser_status != 0)); then
      cat -- "$parser_error_temporary" >"${TEST_MIGRATION_PARSER_ERROR:?}"
      cat -- "$parser_error_temporary" >&2
      exit "$parser_status"
    fi
    cat -- "$summary_temporary" >"$TEST_MIGRATION_SUMMARY_CAPTURE"
    cat -- "$summary_temporary"
    exit 0
  fi
fi
exec /usr/bin/python3 "$@"
EOF
cat >"$work/bin/record-linux-process-identity" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
pid="${1:?}"
record="${2:?}"
umask 077
exec /usr/bin/python3 - "$pid" "$record" <<'PY'
import os
import pathlib
import sys

pid = int(sys.argv[1])
record = pathlib.Path(sys.argv[2])
raw = pathlib.Path(f"/proc/{pid}/stat").read_text(encoding="ascii")
fields = raw[raw.rfind(")") + 2 :].split()
record.write_text(f"{pid}|{int(fields[2])}|{int(fields[19])}\n", encoding="ascii")
os.chmod(record, 0o600)
PY
EOF
cat >"$work/bin/assert-linux-group-absent" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
identity_file="${1:?}"
checked_file="${2:?}"
exec /usr/bin/python3 - "$identity_file" "$checked_file" <<'PY'
import os
import pathlib
import sys

identity_path = pathlib.Path(sys.argv[1])
checked_path = pathlib.Path(sys.argv[2])
pid_text, pgid_text, start_text = identity_path.read_text(
    encoding="ascii"
).strip().split("|")
pid = int(pid_text)
pgid = int(pgid_text)
start = int(start_text)

def identity(candidate: int) -> tuple[int, int]:
    raw = pathlib.Path(f"/proc/{candidate}/stat").read_text(encoding="ascii")
    fields = raw[raw.rfind(")") + 2 :].split()
    return int(fields[2]), int(fields[19])

try:
    live_pgid, live_start = identity(pid)
except FileNotFoundError:
    pass
else:
    if live_start == start:
        raise SystemExit(
            f"recorded process {pid}/{start} remains in PGID {live_pgid} at resume"
        )

for entry in pathlib.Path("/proc").iterdir():
    if not entry.name.isdecimal():
        continue
    try:
        live_pgid, live_start = identity(int(entry.name))
    except FileNotFoundError:
        continue
    if live_pgid == pgid:
        raise SystemExit(
            f"managed PGID {pgid} still contains {entry.name}/{live_start} at resume"
        )

checked_path.write_text("absent\n", encoding="ascii")
os.chmod(checked_path, 0o600)
PY
EOF
chmod 0755 "$work/bin/record-linux-process-identity" \
  "$work/bin/assert-linux-group-absent"
cat >"$work/bin/timeout" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
joined=" $* "
timeout_arguments=("$@")
timeout_foreground=0
timeout_duration=""
timeout_command=()
for ((timeout_index = 0; timeout_index < ${#timeout_arguments[@]}; timeout_index += 1)); do
  timeout_argument="${timeout_arguments[$timeout_index]}"
  case "$timeout_argument" in
    --foreground) timeout_foreground=1 ;;
    --kill-after=*) ;;
    -*) ;;
    *)
      timeout_duration="$timeout_argument"
      timeout_command=("${timeout_arguments[@]:$((timeout_index + 1))}")
      break
      ;;
  esac
done
[[ -n "$timeout_duration" && ${#timeout_command[@]} -gt 0 ]] || exit 96
short_timeout_options=(--kill-after=0.3s)
((timeout_foreground == 0)) || short_timeout_options=(--foreground "${short_timeout_options[@]}")
if [[ -n "${TEST_TIMEOUT_DEBUG_FILE:-}" ]]; then
  printf '%q ' "$@" >>"$TEST_TIMEOUT_DEBUG_FILE"
  printf '\n' >>"$TEST_TIMEOUT_DEBUG_FILE"
fi
if [[ "${TEST_INODE_SCAN_TERM_IGNORING_CHILD:-0}" == 1 \
  && "$joined" == *" find -P "* \
  && "$joined" == *" -samefile "* ]]; then
  duration="${timeout_duration%s}"
  [[ "$duration" =~ ^[0-9]+$ ]] || exit 96
  if ((duration > 580)); then
    printf '%s\n' "$duration" >"$TEST_TIMEOUT_GRACE_VIOLATION"
  fi
  /usr/bin/date +%s%N >"$TEST_HUNG_CHILD_STARTED"
  exec /usr/bin/timeout "${short_timeout_options[@]}" 0.2s \
    "${timeout_command[@]}"
fi
if [[ "${TEST_LATE_TERM_IGNORING_CHILD:-0}" == 1 \
  && "$joined" == *" sync -f "* \
  && "$joined" == *".sha256.tmp."* ]]; then
  duration="${timeout_duration%s}"
  [[ "$duration" =~ ^[0-9]+$ ]] || exit 96
  if ((duration > 580)); then
    printf '%s\n' "$duration" >"$TEST_TIMEOUT_GRACE_VIOLATION"
  fi
  /usr/bin/date +%s%N >"$TEST_HUNG_CHILD_STARTED"
  exec /usr/bin/timeout "${short_timeout_options[@]}" 0.2s \
    bash -c 'trap "" TERM; while :; do :; done'
fi
if [[ "${TEST_EVENT_LINE_LIMIT:-0}" == 1 \
  && "$joined" == *" event-wait "* \
  && "$joined" == *'|checkpoint-3||'* ]]; then
  event_line_limit_dir="${TEST_EVENT_STATE_DIR:-$(dirname -- "${BACKUP_CONFIG_FILE:?}")/event-monitor}"
  printf '%s\n' started >"$event_line_limit_dir/line-cap-wait-started"
  for _ in $(seq 1 1000); do
    [[ ! -e "$event_line_limit_dir/oversized-checkpoint-blocked" ]] || break
    /usr/bin/sleep 0.005
  done
  [[ -e "$event_line_limit_dir/oversized-checkpoint-blocked" ]] || exit 96
fi
event_audit_command=0
event_audit_index=-1
for ((argument_index = 0; argument_index < ${#timeout_arguments[@]}; argument_index += 1)); do
  argument="${timeout_arguments[$argument_index]}"
  if [[ "$argument" == event-audit ]]; then
    event_audit_command=1
    event_audit_index="$argument_index"
    break
  fi
done
if ((event_audit_command == 1)); then
  audit_observation_dir="${TEST_EVENT_STATE_DIR:-$(dirname -- "${BACKUP_CONFIG_FILE:?}")/event-monitor}"
  mkdir -p -- "$audit_observation_dir"
  audit_argument_count=$((${#timeout_arguments[@]} - event_audit_index))
  audit_max_bytes="${timeout_arguments[$((event_audit_index + 5))]:-}"
  audit_max_lines="${timeout_arguments[$((event_audit_index + 6))]:-}"
  [[ "$audit_argument_count" == 15 \
    && "$audit_max_bytes" == 1048576 \
    && "$audit_max_lines" == 4096 ]] || exit 96
  audit_count=0
  [[ ! -f "$audit_observation_dir/audit-invocation-count" ]] \
    || audit_count="$(<"$audit_observation_dir/audit-invocation-count")"
  ((audit_count += 1))
  printf '%s\n' "$audit_count" >"$audit_observation_dir/audit-invocation-count"
  audit_boundary="${timeout_arguments[$((event_audit_index + 4))]:-}"
  audit_expected_state="${timeout_arguments[$((event_audit_index + 9))]:-}"
  [[ "$audit_boundary" =~ ^[1-9][0-9]*$ \
    && "$audit_expected_state" =~ ^(active|closed)$ ]] || exit 96
  printf '%s\n' "$audit_boundary" \
    >"$audit_observation_dir/audit-$audit_count-boundary"
  printf '%s\n' "$audit_expected_state" \
    >"$audit_observation_dir/audit-$audit_count-state"
  if [[ "${TEST_CHECKPOINT_SCENARIO:-valid}" == post-boundary-oversize \
    && "$audit_count" == 1 ]]; then
    printf '%s\n' started >"$audit_observation_dir/event-audit-start"
    for _ in $(seq 1 1000); do
      [[ ! -e "$audit_observation_dir/oversized-tail-observed" ]] || break
      /usr/bin/sleep 0.005
    done
    [[ -e "$audit_observation_dir/oversized-tail-observed" ]] || exit 96
  fi
  if [[ "${TEST_REQUIRE_CLOSED_DRAIN_MARKER:-0}" == 1 \
    && "$audit_expected_state" == closed \
    && ! -e "$audit_observation_dir/closed-drain-tail-observed" ]]; then
    printf '%s\n' violation >"$audit_observation_dir/closed-audit-before-drain"
    exit 96
  fi
fi
if [[ "${TEST_EVENT_AUDIT_TERM_IGNORING_CHILD:-0}" == 1 \
  && "$event_audit_command" == 1 ]]; then
  audit_count=0
  [[ ! -f "${TEST_EVENT_AUDIT_TIMEOUT_STATE:?}" ]] \
    || audit_count="$(<"$TEST_EVENT_AUDIT_TIMEOUT_STATE")"
  ((audit_count += 1))
  printf '%s' "$audit_count" >"$TEST_EVENT_AUDIT_TIMEOUT_STATE"
  if ((audit_count >= 2)); then
    duration="${timeout_duration%s}"
    [[ "$duration" =~ ^[0-9]+$ ]] || exit 96
    if ((duration > 580)); then
      printf '%s\n' "$duration" >"$TEST_TIMEOUT_GRACE_VIOLATION"
    fi
    /usr/bin/date +%s%N >"$TEST_HUNG_CHILD_STARTED"
    exec /usr/bin/timeout "${short_timeout_options[@]}" 0.2s \
      bash -c 'trap "" TERM; while :; do :; done'
  fi
fi
migration_summary_command=0
for argument in "$@"; do
  [[ "$argument" != migration-summary ]] || migration_summary_command=1
done
if [[ "${TEST_MIGRATION_PARSE_TIMEOUT:-0}" == 1 \
  && "$joined" == *"migration-row-parser"* ]]; then
  printf '%s\n' observed >"${TEST_MIGRATION_TIMEOUT_OBSERVED:?}"
  exec /usr/bin/timeout "${short_timeout_options[@]}" 0.5s \
    "${timeout_command[@]}"
fi
if [[ "${TEST_MARKER_DESCENDANT_TIMEOUT:-0}" == 1 \
  && "$joined" == *"write_success_marker"* ]]; then
  printf '%s\n' observed >"${TEST_MARKER_TIMEOUT_OBSERVED:?}"
  exec /usr/bin/timeout "${short_timeout_options[@]}" 5s \
    "${timeout_command[@]}"
fi
if [[ "${TEST_TIMEOUT_EXHAUST:-0}" == 1 ]]; then
  count=0
  [[ ! -f "$TEST_TIMEOUT_STATE" ]] || count="$(<"$TEST_TIMEOUT_STATE")"
  if ((count > 0)) || [[ "$joined" == *" quiesce_mutators "* ]]; then
    ((count += 1))
    printf '%s' "$count" >"$TEST_TIMEOUT_STATE"
    ((count < 2)) || exit 124
  fi
fi
exec /usr/bin/timeout "$@"
EOF
cat >"$work/bin/find" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
joined=" $* "
if [[ "${TEST_INODE_SCAN_TERM_IGNORING_CHILD:-0}" == 1 \
  && "$joined" == *" -samefile "* ]]; then
  trap '' TERM
  while :; do :; done
fi
exec /usr/bin/find "$@"
EOF
cat >"$work/bin/rm" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
if [[ "${TEST_BLOCK_CANDIDATE_CLEANUP:-0}" == 1 \
  && " $* " == *".sha256.tmp."* ]]; then
  /usr/bin/sleep 3
fi
exec /usr/bin/rm "$@"
EOF
cat >"$work/bin/date" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
if [[ "${TEST_FIXED_BACKUP_TIME:-0}" == 1 && "${1:-}" == -u ]]; then
  case "${2:-}" in
    +%Y%m%dT%H%M%SZ) printf '%s\n' 20260715T010203Z; exit 0 ;;
    +%Y-%m-%dT%H:%M:%S.%NZ) printf '%s\n' 2026-07-15T01:02:03.000000000Z; exit 0 ;;
    +%Y-%m-%dT%H:%M:%SZ) printf '%s\n' 2026-07-15T01:02:03Z; exit 0 ;;
  esac
fi
exec /usr/bin/date "$@"
EOF
cat >"$work/bin/chmod" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
if [[ "${TEST_STAGE_CHMOD_FAIL:-0}" == 1 ]]; then
  for argument in "$@"; do
    if [[ "$argument" == */stage/full.* \
      || "$argument" == */stage/verify.* \
      || "$argument" == */runtime/b.* ]]; then
      exit 80
    fi
  done
fi
if [[ -n "${TEST_WATCH_CHMOD_PATH:-}" ]]; then
  for argument in "$@"; do
    if [[ "$argument" == "$TEST_WATCH_CHMOD_PATH" ]]; then
      printf '%s\n' "$argument" >"${TEST_CHMOD_MUTATION_FILE:?}"
    fi
  done
fi
exec /usr/bin/chmod "$@"
EOF
cat >"$work/bin/tar" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
joined=" $* "
if [[ "${TEST_REPOSITORY_TAR_FAIL:-0}" == 1 \
  && "$joined" == *repository.tar.gz* ]]; then
  exit 74
fi
if [[ "${TEST_APP_TAR_FAIL:-0}" == 1 \
  && "$joined" == *app-data.tar.gz* ]]; then
  exit 75
fi
if [[ "${TEST_EVENT_SCENARIO:-}" == boundary-object \
  && "$joined" == *app-data.tar.gz* ]]; then
  state_dir="${TEST_EVENT_STATE_DIR:-$(dirname -- "$BACKUP_CONFIG_FILE")/event-monitor}"
  printf '%s\n' "start|lifecycle|${TEST_EVENT_REPO_ROOT:?}||" \
    >>"$state_dir/actions"
fi
exec /usr/bin/tar "$@"
EOF
cat >"$work/bin/mktemp" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
if [[ "${TEST_SIDECAR_CREATE_FAIL:-0}" == 1 \
  && "$*" == *".sha256.tmp.XXXXXX"* ]]; then
  exit 74
fi
if [[ -n "${TEST_STAGE_MKTEMP_FAIL_AT:-}" && " $* " == *" -d "* \
  && ( "$*" == *"/full."* || "$*" == *"/verify."* \
    || "$*" == *"/b."* ) ]]; then
  count=0
  [[ ! -f "${TEST_STAGE_MKTEMP_STATE:?}" ]] \
    || count="$(<"$TEST_STAGE_MKTEMP_STATE")"
  ((count += 1))
  printf '%s' "$count" >"$TEST_STAGE_MKTEMP_STATE"
  if ((count == TEST_STAGE_MKTEMP_FAIL_AT)); then
    exit 79
  fi
fi
exec /usr/bin/mktemp "$@"
EOF
cat >"$work/bin/mv" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
destination="${@: -1}"
source_path="${@: -2:1}"
if [[ "${TEST_MARKER_STUBBORN_DESCENDANT:-0}" == 1 \
  && "$source_path" == */.local-last-success.env.tmp.* \
  && "$destination" == */backups/state/local-last-success.env ]]; then
  trap '' TERM
  printf '%s\n' "$BASHPID" >"${TEST_MARKER_DESCENDANT_PID:?}"
  if [[ "${TEST_USE_REAL_MANAGED_DEADLINE:-0}" == 1 ]]; then
    record-linux-process-identity "$BASHPID" \
      "${TEST_PROCESS_GROUP_IDENTITY:?}"
  fi
  cp -- "$source_path" "${TEST_MARKER_HELD_PAYLOAD:?}"
  printf '%s\n' ready >"${TEST_MARKER_DESCENDANT_READY:?}"
  while [[ ! -e "${TEST_MARKER_RELEASE_LATE_MV:?}" ]]; do
    /usr/bin/sleep 0.05
  done
  /usr/bin/mv -fT -- "$TEST_MARKER_HELD_PAYLOAD" "$destination"
  /usr/bin/date +%s%N >"${TEST_MARKER_LATE_EFFECT:?}"
  exit 0
fi
if [[ "${TEST_ARCHIVE_RENAME_POST_EFFECT_FAIL:-0}" == 1 \
  && "$destination" == */learncoding-full-*.tar.gz.age ]]; then
  /usr/bin/mv "$@"
  exit 74
fi
if [[ "${TEST_SIDECAR_RENAME_POST_EFFECT_FAIL:-0}" == 1 \
  && "$destination" == */learncoding-full-*.tar.gz.age.sha256 ]]; then
  /usr/bin/mv "$@"
  exit 75
fi
if [[ "${TEST_ARCHIVE_RENAME_FAIL:-0}" == 1 \
  && "$destination" == */learncoding-full-*.tar.gz.age ]]; then
  exit 74
fi
if [[ "${TEST_FULL_SIDECAR_RENAME_FAIL:-0}" == 1 \
  && "$destination" == */learncoding-full-*.tar.gz.age.sha256 ]]; then
  exit 75
fi
if [[ "${TEST_MARKER_RENAME_FAIL:-0}" == 1 \
  && "$destination" == */state/local-last-success.env ]]; then
  exit 76
fi
if [[ -n "${TEST_MARKER_WINDOW_EVENT_SERVICE:-}" \
  && "$destination" == */backups/state/local-last-success.env ]]; then
  state_dir="${TEST_EVENT_STATE_DIR:-$(dirname -- "$BACKUP_CONFIG_FILE")/event-monitor}"
  event_action=start
  [[ "$TEST_MARKER_WINDOW_EVENT_SERVICE" != postgres ]] || event_action=restart
  printf '%s\n' \
    "$event_action|$TEST_MARKER_WINDOW_EVENT_SERVICE|${TEST_EVENT_REPO_ROOT:?}||" \
    >>"$state_dir/actions"
fi
if [[ "${TEST_MARKER_ROLLBACK_FAIL:-0}" == 1 \
  && "$*" == *".local-last-success.env.rollback."* \
  && "$destination" == */backups/state/local-last-success.env ]]; then
  printf '%s\n' rollback-attempted \
    >"${TEST_MARKER_ROLLBACK_FAULT_OBSERVED:?}"
  exit 78
fi
exec /usr/bin/mv "$@"
EOF
cat >"$work/bin/sync" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
target="${@: -1}"
if [[ -n "${TEST_MARKER_CANDIDATE_SNAPSHOT:-}" \
  && "$target" == */backups/state \
  && ! -e "$TEST_MARKER_CANDIDATE_SNAPSHOT" ]]; then
  cp -- "$target/local-last-success.env" "$TEST_MARKER_CANDIDATE_SNAPSHOT"
fi
if [[ "${TEST_EVENT_SCENARIO:-}" == boundary-publication \
  && "$target" == */backups/full ]]; then
  state_dir="${TEST_EVENT_STATE_DIR:-$(dirname -- "$BACKUP_CONFIG_FILE")/event-monitor}"
  printf '%s\n' "start|lifecycle|${TEST_EVENT_REPO_ROOT:?}||" \
    >>"$state_dir/actions"
fi
if [[ "${TEST_POSTGRES_EVENT_BOUNDARY:-}" == pre-marker \
  && "$target" == */backups/full ]]; then
  state_dir="${TEST_EVENT_STATE_DIR:-$(dirname -- "$BACKUP_CONFIG_FILE")/event-monitor}"
  if [[ "${TEST_POSTGRES_EVENT_ACTION:?}" != none ]]; then
    if [[ "$TEST_POSTGRES_EVENT_ACTION" == exec_* ]]; then
      printf '%s\n' \
        "$TEST_POSTGRES_EVENT_ACTION|postgres|${TEST_EVENT_REPO_ROOT:?}|||${TEST_POSTGRES_EVENT_EXEC_ID:?}" \
        >>"$state_dir/actions"
    else
      printf '%s\n' \
        "$TEST_POSTGRES_EVENT_ACTION|postgres|${TEST_EVENT_REPO_ROOT:?}||" \
        >>"$state_dir/actions"
    fi
  fi
  [[ -z "${TEST_POSTGRES_STATE_FILE:-}" ]] \
    || printf '%s\n' "${TEST_POSTGRES_MUTATED_STATE:-healthy}" \
      >"$TEST_POSTGRES_STATE_FILE"
fi
if [[ "${TEST_MARKER_DIRECTORY_SYNC_FAIL:-0}" == 1 \
  && "$target" == */backups/state \
  && ! -e "${TEST_MARKER_EFFECT_RECORDED:?}" ]]; then
  printf '%s\n' marker-renamed >"$TEST_MARKER_EFFECT_RECORDED"
  exit 74
fi
if [[ "${TEST_MARKER_SIGNAL_AFTER_EFFECT:-0}" == 1 \
  && "$target" == */backups/state \
  && ! -e "${TEST_MARKER_EFFECT_RECORDED:?}" ]]; then
  printf '%s\n' marker-renamed >"$TEST_MARKER_EFFECT_RECORDED"
  marker_shell="$PPID"
  timeout_pid="$(/usr/bin/ps -o ppid= -p "$marker_shell" | tr -d ' ')"
  backup_pid="$(/usr/bin/ps -o ppid= -p "$timeout_pid" | tr -d ' ')"
  [[ "$backup_pid" =~ ^[0-9]+$ ]] || exit 96
  kill -TERM "$backup_pid"
  kill -TERM "$timeout_pid" 2>/dev/null || true
  exit 143
fi
exec /usr/bin/sync "$@"
EOF
cat >"$work/bin/env" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
if [[ "${TEST_PRUNE_FAIL:-0}" == 1 && "$*" == *"scripts/backup/prune.sh"* ]]; then
  exit 74
fi
exec /usr/bin/env "$@"
EOF
chmod 0755 "$work/bin/age" "$work/bin/age-keygen" "$work/bin/flock" \
  "$work/bin/python3" \
  "$work/bin/timeout" "$work/bin/find" "$work/bin/tar" "$work/bin/mktemp" "$work/bin/mv" \
  "$work/bin/sync" \
  "$work/bin/env" "$work/bin/rm" "$work/bin/date" "$work/bin/chmod" \
  "$work/bin/mutate-envelope"

# MSYS cannot represent the production 0640/0440 fixtures. This narrow adapter
# allows orchestration development only; the unchanged real-stat suite remains
# an Ubuntu acceptance gate.
cat >"$work/bin/stat" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
if [[ -n "${TEST_UNSAFE_DIRECTORY_PATH:-}" \
  && "${@: -1}" == "$TEST_UNSAFE_DIRECTORY_PATH" \
  && "$*" == *"%u"* ]]; then
  printf '%s\n' 2147483646
  exit 0
fi
if [[ "${OSTYPE:-}" == msys* && "$*" == *"%a"* ]]; then
  target="${@: -1}"
  case "$target" in
    */compose.env) printf '%s\n' 640; exit 0 ;;
    */credential-master-key) printf '%s\n' 440; exit 0 ;;
  esac
fi
exec /usr/bin/stat "$@"
EOF
chmod 0755 "$work/bin/stat"

if [[ "${OSTYPE:-}" == msys* ]]; then
  cat >"$work/bin/git" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
if [[ " $* " == *" rev-parse --show-toplevel "* ]]; then
  value="$(/mingw64/bin/git "$@")"
  cygpath -u "$value"
  exit 0
fi
exec /mingw64/bin/git "$@"
EOF
  cat >"$work/bin/hostname" <<'EOF'
#!/usr/bin/env bash
[[ "${1:-}" == -s ]] || exit 64
printf '%s\n' publication-test
EOF
  chmod 0755 "$work/bin/git" "$work/bin/hostname"
fi

identity="$work/identity.txt"
printf '%s\n' AGE-SECRET-KEY-TEST-FIXTURE >"$identity"
chmod 0600 "$identity"

config="$work/backup.env"
cat >"$config" <<EOF
BACKUP_ROOT=$work/live-backups
EMERGENCY_BACKUP_ROOT=$work/emergency-backups
REPO_ROOT=$work/live-repo
LEARN_DATA_ROOT=$work/live-data
BACKUP_STAGE_ROOT=$work/stages
BACKUP_LOCK_FILE=$work/backup.lock
FILESYSTEM_WARN_PERCENT=70
FILESYSTEM_CRITICAL_PERCENT=85
EOF
chmod 0600 "$config"

readonly fixture_hash="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
readonly migration_hash="bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
readonly -a required_image_services=(
  app cloudflared exam-finalization-worker mail-worker migrate postgres
  practice-runner-recovery-worker project-review-correction-worker
  regrade-worker reward-worker
)

write_full_manifest() {
  local path="$1" app_data_included="${2:-false}"
  cat >"$path" <<EOF
format=learncoding-backup-v1
created_utc=20260715T010203Z
snapshot_utc=20260715T010204Z
source_host=backup-test
git_commit=0123456789abcdef0123456789abcdef01234567
database_version=postgres (PostgreSQL) 17.5
migration_count=2
migration_last_id=2
migration_last_created_at=2000
migration_state_sha256=$migration_hash
app_data_included=$app_data_included
contains_secret_files=false
contains_email_exports=false
EOF
  local service
  for service in "${required_image_services[@]}"; do
    printf 'image_id.%s=sha256:%s\n' "$service" "$fixture_hash" >>"$path"
  done
}

write_checksums() {
  local stage="$1" schema="$2" app_data_included="${3:-false}"
  case "$schema:$app_data_included" in
    full:false)
      (cd "$stage" && sha256sum --text \
        database.dump repository.tar.gz credential-probe.json MANIFEST.txt >SHA256SUMS)
      ;;
    full:true)
      (cd "$stage" && sha256sum --text \
        database.dump repository.tar.gz app-data.tar.gz credential-probe.json MANIFEST.txt >SHA256SUMS)
      ;;
    emergency:*)
      (cd "$stage" && sha256sum --text database.dump recovery-config.tar.gz MANIFEST.txt >SHA256SUMS)
      ;;
    *) return 1 ;;
  esac
}

make_safe_repository_tar() {
  local output="$1" root
  root="$(mktemp -d "$work/repository.XXXXXX")"
  mkdir -p "$root/content" "$root/drizzle" "$root/infra" "$root/docs/runbooks"
  printf lesson >"$root/content/lesson.json"
  printf migration >"$root/drizzle/0000.sql"
  printf unit >"$root/infra/unit.conf"
  printf deployment >"$root/docs/deployment.md"
  printf runbook >"$root/docs/runbooks/restore.md"
  printf compose >"$root/compose.yaml"
  printf docker >"$root/Dockerfile"
  printf ignore >"$root/.dockerignore"
  tar -C "$root" -czf "$output" \
    .dockerignore Dockerfile compose.yaml content drizzle docs infra
  rm -rf -- "$root"
}

make_full_archive() {
  local output="$1" mutation="${2:-none}" stage app_data_included=false
  local -a members=()
  stage="$(mktemp -d "$work/full-payload.XXXXXX")"
  printf database >"$stage/database.dump"
  make_safe_repository_tar "$stage/repository.tar.gz"
  printf '%s\n' '{"version":1,"fixture":true}' >"$stage/credential-probe.json"
  write_full_manifest "$stage/MANIFEST.txt" false

  case "$mutation" in
    secret-flag)
      sed -i 's/contains_secret_files=false/contains_secret_files=true/' "$stage/MANIFEST.txt"
      ;;
    email-flag)
      sed -i 's/contains_email_exports=false/contains_email_exports=true/' "$stage/MANIFEST.txt"
      ;;
    duplicate-manifest-key)
      printf '%s\n' 'source_host=second-host' >>"$stage/MANIFEST.txt"
      ;;
    unknown-manifest-key)
      printf '%s\n' 'future_field=unsafe' >>"$stage/MANIFEST.txt"
      ;;
    bad-commit)
      sed -i 's/git_commit=.*/git_commit=unknown/' "$stage/MANIFEST.txt"
      ;;
    bad-created-time)
      sed -i 's/created_utc=.*/created_utc=20260230T010203Z/' "$stage/MANIFEST.txt"
      ;;
    bad-snapshot-time)
      sed -i 's/snapshot_utc=.*/snapshot_utc=not-a-time/' "$stage/MANIFEST.txt"
      ;;
    bad-image-id)
      sed -i '0,/^image_id\./s/sha256:[0-9a-f]\{64\}/sha256:ABCDEF/' "$stage/MANIFEST.txt"
      ;;
    missing-image)
      sed -i '/^image_id\.reward-worker=/d' "$stage/MANIFEST.txt"
      ;;
    unknown-image)
      printf 'image_id.unknown-service=sha256:%s\n' "$fixture_hash" >>"$stage/MANIFEST.txt"
      ;;
    duplicate-image)
      printf 'image_id.app=sha256:%s\n' "$migration_hash" >>"$stage/MANIFEST.txt"
      ;;
    app-data-mismatch)
      sed -i 's/app_data_included=false/app_data_included=true/' "$stage/MANIFEST.txt"
      ;;
    missing-migration-state)
      sed -i '/^migration_state_sha256=/d' "$stage/MANIFEST.txt"
      ;;
    nested-traversal|nested-dot-component|nested-backslash)
      local nested_root
      nested_root="$(mktemp -d "$work/nested-unsafe.XXXXXX")"
      mkdir -p "$nested_root/content"
      printf escape >"$nested_root/content/item"
      case "$mutation" in
        nested-traversal) transform='s|content/item|../escape|' ;;
        nested-dot-component) transform='s|content/item|content/./item|' ;;
        nested-backslash) transform='s|content/item|content\\item|' ;;
      esac
      tar -C "$nested_root" --transform="$transform" \
        -czf "$stage/repository.tar.gz" content/item
      rm -rf -- "$nested_root"
      ;;
    nested-file-ancestor|nested-type-alias)
      local nested_root nested_tar
      nested_root="$(mktemp -d "$work/nested-conflict.XXXXXX")"
      nested_tar="$nested_root/repository.tar"
      printf ancestor >"$nested_root/ancestor"
      if [[ "$mutation" == nested-file-ancestor ]]; then
        printf child >"$nested_root/child"
        tar -C "$nested_root" -cf "$nested_tar" \
          --transform='s|^ancestor$|content|' ancestor
        tar -C "$nested_root" -rf "$nested_tar" \
          --transform='s|^child$|content/x|' child
      else
        mkdir "$nested_root/content"
        tar -C "$nested_root" -cf "$nested_tar" content
        tar -C "$nested_root" -rf "$nested_tar" \
          --transform='s|^ancestor$|content|' ancestor
      fi
      gzip -n <"$nested_tar" >"$stage/repository.tar.gz"
      rm -rf -- "$nested_root"
      ;;
    nested-fifo)
      local nested_root
      nested_root="$(mktemp -d "$work/nested-fifo.XXXXXX")"
      mkdir "$nested_root/content"
      mkfifo "$nested_root/content/pipe"
      tar -C "$nested_root" -czf "$stage/repository.tar.gz" content
      rm -rf -- "$nested_root"
      ;;
    nested-hardlink)
      local nested_root
      nested_root="$(mktemp -d "$work/nested-hardlink.XXXXXX")"
      mkdir "$nested_root/content"
      printf linked >"$nested_root/content/a"
      ln "$nested_root/content/a" "$nested_root/content/b"
      tar -C "$nested_root" -czf "$stage/repository.tar.gz" content/a content/b
      rm -rf -- "$nested_root"
      ;;
    nested-symlink|nested-device|nested-socket)
      /usr/bin/python3 - "$stage/repository.tar.gz" "$mutation" <<'PY'
import io
import tarfile
import sys

output, mutation = sys.argv[1:]
with tarfile.open(output, "w:gz") as archive:
    for name in ["content", "drizzle", "infra", "docs", "docs/runbooks"]:
        entry = tarfile.TarInfo(f"{name}/")
        entry.type = tarfile.DIRTYPE
        entry.mode = 0o755
        archive.addfile(entry)
    for name, value in {
        ".dockerignore": b"ignore",
        "Dockerfile": b"docker",
        "compose.yaml": b"compose",
        "content/lesson.json": b"lesson",
        "drizzle/0000.sql": b"migration",
        "infra/unit.conf": b"infra",
        "docs/deployment.md": b"deployment",
        "docs/runbooks/restore.md": b"runbook",
    }.items():
        entry = tarfile.TarInfo(name)
        entry.mode = 0o644
        entry.size = len(value)
        archive.addfile(entry, io.BytesIO(value))
    special = tarfile.TarInfo("content/special")
    special.mode = 0o644
    if mutation == "nested-symlink":
        special.type = tarfile.SYMTYPE
        special.linkname = "lesson.json"
    elif mutation == "nested-device":
        special.type = tarfile.CHRTYPE
        special.devmajor = 1
        special.devminor = 3
    else:
        special.type = b"s"
    archive.addfile(special)
PY
      ;;
    repository-file-wide-mode|repository-file-special-mode|repository-dir-wide-mode|repository-dir-special-mode)
      /usr/bin/python3 - "$stage/repository.tar.gz" "$mutation" <<'PY'
import io
import os
import tarfile
import tempfile
import sys

archive_path, mutation = sys.argv[1:]
target = "content/lesson.json" if "file" in mutation else "content"
mode = {
    "repository-file-wide-mode": 0o666,
    "repository-file-special-mode": 0o4755,
    "repository-dir-wide-mode": 0o777,
    "repository-dir-special-mode": 0o1777,
}[mutation]
fd, replacement = tempfile.mkstemp(dir=os.path.dirname(archive_path), suffix=".tar.gz")
os.close(fd)
try:
    with tarfile.open(archive_path, "r:gz") as source, tarfile.open(replacement, "w:gz") as output:
        for member in source.getmembers():
            if member.name.rstrip("/") == target:
                member.mode = mode
            extracted = source.extractfile(member) if member.isfile() else None
            output.addfile(member, extracted)
    os.replace(replacement, archive_path)
finally:
    if os.path.exists(replacement):
        os.unlink(replacement)
PY
      ;;
    repository-content-file|repository-compose-directory|repository-missing-drizzle|repository-secret-subtree)
      local nested_root
      nested_root="$(mktemp -d "$work/nested-schema.XXXXXX")"
      case "$mutation" in
        repository-content-file)
          printf content-is-not-a-directory >"$nested_root/content-source"
          tar -C "$nested_root" --transform='s|^content-source$|content|' \
            -czf "$stage/repository.tar.gz" content-source
          ;;
        repository-compose-directory)
          mkdir -p "$nested_root/compose.yaml"
          printf child >"$nested_root/compose.yaml/child"
          tar -C "$nested_root" -czf "$stage/repository.tar.gz" compose.yaml
          ;;
        repository-missing-drizzle|repository-secret-subtree)
          mkdir -p "$nested_root/content" "$nested_root/infra" "$nested_root/docs/runbooks"
          printf lesson >"$nested_root/content/lesson.json"
          printf infra >"$nested_root/infra/unit.conf"
          printf deployment >"$nested_root/docs/deployment.md"
          printf runbook >"$nested_root/docs/runbooks/restore.md"
          printf compose >"$nested_root/compose.yaml"
          printf docker >"$nested_root/Dockerfile"
          printf ignore >"$nested_root/.dockerignore"
          if [[ "$mutation" == repository-secret-subtree ]]; then
            mkdir -p "$nested_root/drizzle" "$nested_root/infra/secrets"
            printf migration >"$nested_root/drizzle/0000.sql"
            printf secret >"$nested_root/infra/secrets/master.key"
          fi
          members=(.dockerignore Dockerfile compose.yaml content docs infra)
          [[ "$mutation" != repository-secret-subtree ]] || members+=(drizzle)
          tar -C "$nested_root" -czf "$stage/repository.tar.gz" "${members[@]}"
          ;;
      esac
      rm -rf -- "$nested_root"
      ;;
    app-data-root-file)
      local app_root
      app_root="$(mktemp -d "$work/app-schema.XXXXXX")"
      printf app-data-is-not-a-directory >"$app_root/source"
      tar -C "$app_root" --transform='s|^source$|app-data|' \
        -czf "$stage/app-data.tar.gz" source
      rm -rf -- "$app_root"
      app_data_included=true
      sed -i 's/app_data_included=false/app_data_included=true/' "$stage/MANIFEST.txt"
      ;;
  esac

  write_checksums "$stage" full "$app_data_included"
  case "$mutation" in
    uppercase-checksum)
      while IFS= read -r checksum_line; do
        printf '%s%s\n' \
          "$(printf '%s' "${checksum_line:0:64}" | tr '[:lower:]' '[:upper:]')" \
          "${checksum_line:64}"
      done <"$stage/SHA256SUMS" >"$stage/SHA256SUMS.upper"
      mv "$stage/SHA256SUMS.upper" "$stage/SHA256SUMS"
      ;;
    duplicate-checksum)
      head -n 1 "$stage/SHA256SUMS" >>"$stage/SHA256SUMS"
      ;;
    bad-checksum-separator)
      sed -i '1s/  / */' "$stage/SHA256SUMS"
      ;;
    checksum-traversal)
      sed -i '1s/  database\.dump$/  ..\/database.dump/' "$stage/SHA256SUMS"
      ;;
    missing-probe)
      rm -f -- "$stage/credential-probe.json"
      sed -i '/  credential-probe\.json$/d' "$stage/SHA256SUMS"
      ;;
  esac

  if [[ "$mutation" == outer-reordered ]]; then
    tar -C "$stage" -czf "$output" \
      database.dump MANIFEST.txt SHA256SUMS credential-probe.json repository.tar.gz
  elif [[ "$mutation" == missing-probe ]]; then
    tar -C "$stage" -czf "$output" \
      MANIFEST.txt SHA256SUMS database.dump repository.tar.gz
  else
    members=(MANIFEST.txt SHA256SUMS)
    [[ "$app_data_included" != true ]] || members+=(app-data.tar.gz)
    members+=(credential-probe.json database.dump repository.tar.gz)
    tar -C "$stage" -czf "$output" "${members[@]}"
  fi
  rm -rf -- "$stage"
}

make_emergency_archive() {
  local output="$1" mutation="${2:-none}" stage root
  stage="$(mktemp -d "$work/emergency-payload.XXXXXX")"
  root="$(mktemp -d "$work/recovery-config.XXXXXX")"
  mkdir -p "$root/drizzle" "$root/infra/env" "$root/infra/systemd" "$root/docs/runbooks"
  printf database >"$stage/database.dump"
  printf compose >"$root/compose.yaml"
  printf docker >"$root/Dockerfile"
  printf ignore >"$root/.dockerignore"
  printf migration >"$root/drizzle/0000.sql"
  printf env >"$root/infra/env/example"
  printf unit >"$root/infra/systemd/backup.service"
  printf deployment >"$root/docs/deployment.md"
  printf runbook >"$root/docs/runbooks/restore.md"
  case "$mutation" in
    emergency-secret-subtree)
      mkdir -p "$root/infra/secrets"
      printf secret >"$root/infra/secrets/master.key"
      ;;
    emergency-missing-systemd)
      rm -rf -- "$root/infra/systemd"
      ;;
    emergency-drizzle-file)
      rm -rf -- "$root/drizzle"
      printf migration-is-not-a-directory >"$root/drizzle"
      ;;
  esac
  tar -C "$root" -czf "$stage/recovery-config.tar.gz" \
    .dockerignore Dockerfile compose.yaml drizzle docs infra
  rm -rf -- "$root"
  cat >"$stage/MANIFEST.txt" <<'EOF'
format=learncoding-emergency-v1
created_utc=20260715T010203Z
git_commit=0123456789abcdef0123456789abcdef01234567
scope=database-and-non-secret-recovery-config-only
contains_secret_files=false
contains_email_exports=false
EOF
  case "$mutation" in
    emergency-missing-commit) sed -i '/^git_commit=/d' "$stage/MANIFEST.txt" ;;
    emergency-bad-commit) sed -i 's/^git_commit=.*/git_commit=unknown/' "$stage/MANIFEST.txt" ;;
  esac
  if [[ "$mutation" == mixed-schema ]]; then
    printf '%s\n' '{"version":1}' >"$stage/credential-probe.json"
  fi
  write_checksums "$stage" emergency false
  if [[ "$mutation" == bad-internal-checksum ]]; then
    sed -i '1s/^[0-9a-f]/0/' "$stage/SHA256SUMS"
  fi
  local -a members=(MANIFEST.txt SHA256SUMS database.dump recovery-config.tar.gz)
  [[ "$mutation" != mixed-schema ]] || members+=(credential-probe.json)
  tar -C "$stage" -czf "$output" "${members[@]}"
  rm -rf -- "$stage"
}

verify_success() {
  local archive="$1" destination="$2" output
  local -a verifier_command=(bash)
  [[ "${BACKUP_TEST_TRACE_VERIFIER:-0}" != 1 ]] || verifier_command+=( -x )
  verifier_command+=("$verifier")
  output="$(PATH="$work/bin:$PATH" BACKUP_CONFIG_FILE="$config" \
    "${verifier_command[@]}" "$archive" "$identity" "$destination")"
  [[ "$output" == archive_valid=true ]] || fail "verifier emitted a noncanonical success result"
  [[ -f "$destination/MANIFEST.txt" && ! -e "$destination/.archive.plain.tmp" ]] \
    || fail "verifier did not leave only the validated extraction"
}

verify_failure() {
  local archive="$1" destination="$2"
  if PATH="$work/bin:$PATH" BACKUP_CONFIG_FILE="$config" \
    bash "$verifier" "$archive" "$identity" "$destination" >/dev/null 2>&1; then
    fail "verifier accepted an unsafe archive fixture"
  fi
  if [[ -d "$destination" ]] && find "$destination" -mindepth 1 -print -quit | grep -q .; then
    fail "verifier failure left extracted plaintext"
  fi
}

if [[ "$test_group" == all || "$test_group" == verifier \
  || "$test_group" == m4-nested-schema \
  || "$test_group" == m6-destination-safety ]]; then
full_archive="$work/full.tar.gz.age"
make_full_archive "$full_archive"
verify_success "$full_archive" "$work/full-verified"

emergency_archive="$work/emergency.tar.gz.age"
make_emergency_archive "$emergency_archive"
verify_success "$emergency_archive" "$work/emergency-verified"

for mutation in secret-flag email-flag duplicate-manifest-key unknown-manifest-key \
  bad-commit bad-created-time bad-snapshot-time bad-image-id missing-image \
  unknown-image duplicate-image app-data-mismatch missing-migration-state missing-probe \
  uppercase-checksum duplicate-checksum bad-checksum-separator checksum-traversal \
  nested-traversal nested-dot-component \
  nested-backslash nested-file-ancestor nested-type-alias nested-fifo \
  nested-hardlink nested-symlink nested-device nested-socket \
  repository-file-wide-mode repository-file-special-mode \
  repository-dir-wide-mode repository-dir-special-mode \
  repository-content-file repository-compose-directory \
  repository-missing-drizzle repository-secret-subtree app-data-root-file \
  outer-reordered; do
  candidate="$work/full-$mutation.tar.gz.age"
  make_full_archive "$candidate" "$mutation"
  verify_failure "$candidate" "$work/verify-$mutation"
done

for mutation in mixed-schema bad-internal-checksum emergency-secret-subtree \
  emergency-missing-systemd emergency-drizzle-file emergency-missing-commit \
  emergency-bad-commit; do
  candidate="$work/emergency-$mutation.tar.gz.age"
  make_emergency_archive "$candidate" "$mutation"
  verify_failure "$candidate" "$work/verify-emergency-$mutation"
done

# A duplicate outer member must fail even when both copies are regular files.
duplicate_stage="$(mktemp -d "$work/duplicate.XXXXXX")"
cp "$work/full-verified/"* "$duplicate_stage/"
tar -C "$duplicate_stage" -cf "$work/duplicate.tar" \
  MANIFEST.txt SHA256SUMS credential-probe.json database.dump repository.tar.gz
tar -C "$duplicate_stage" -rf "$work/duplicate.tar" database.dump
gzip -n <"$work/duplicate.tar" >"$work/duplicate-outer.tar.gz.age"
verify_failure "$work/duplicate-outer.tar.gz.age" "$work/verify-duplicate-outer"

printf 'not-a-tar-stream' >"$work/corrupt-outer.tar.gz.age"
verify_failure "$work/corrupt-outer.tar.gz.age" "$work/verify-corrupt-outer"

# Unsafe outer names and every representable non-regular type are rejected
# before extraction. Linux-only types remain active in the Ubuntu gate.
type_stage="$(mktemp -d "$work/type.XXXXXX")"
printf target >"$type_stage/target"
ln -s target "$type_stage/database.dump"
if [[ -L "$type_stage/database.dump" ]]; then
  tar -C "$type_stage" -czf "$work/symlink-outer.tar.gz.age" database.dump
  verify_failure "$work/symlink-outer.tar.gz.age" "$work/verify-symlink-outer"
fi

mkdir "$type_stage/directory"
tar -C "$type_stage" --transform='s|^directory|database.dump|' \
  -czf "$work/directory-outer.tar.gz.age" directory
verify_failure "$work/directory-outer.tar.gz.age" "$work/verify-directory-outer"

mkfifo "$type_stage/fifo"
tar -C "$type_stage" --transform='s|^fifo$|database.dump|' \
  -czf "$work/fifo-outer.tar.gz.age" fifo
verify_failure "$work/fifo-outer.tar.gz.age" "$work/verify-fifo-outer"

printf linked >"$type_stage/hardlink-source"
ln "$type_stage/hardlink-source" "$type_stage/hardlink-copy"
tar -C "$type_stage" --transform='s|^hardlink-source$|MANIFEST.txt|;s|^hardlink-copy$|database.dump|' \
  -czf "$work/hardlink-outer.tar.gz.age" hardlink-source hardlink-copy
verify_failure "$work/hardlink-outer.tar.gz.age" "$work/verify-hardlink-outer"

printf unknown >"$type_stage/unknown.member"
tar -C "$type_stage" -czf "$work/unknown-outer.tar.gz.age" unknown.member
verify_failure "$work/unknown-outer.tar.gz.age" "$work/verify-unknown-outer"

control_name=$'control\tmember'
printf control >"$type_stage/$control_name"
tar -C "$type_stage" -czf "$work/control-outer.tar.gz.age" "$control_name"
verify_failure "$work/control-outer.tar.gz.age" "$work/verify-control-outer"

printf absolute >"$type_stage/absolute-source"
tar --absolute-names -C "$type_stage" \
  --transform='s|^absolute-source$|/absolute-member|' \
  -czf "$work/absolute-outer.tar.gz.age" absolute-source
verify_failure "$work/absolute-outer.tar.gz.age" "$work/verify-absolute-outer"

printf traversal >"$type_stage/traversal-source"
tar --absolute-names -C "$type_stage" \
  --transform='s|^traversal-source$|../traversal-member|' \
  -czf "$work/traversal-outer.tar.gz.age" traversal-source
verify_failure "$work/traversal-outer.tar.gz.age" "$work/verify-traversal-outer"

if /usr/bin/python3 - "$type_stage/socket" 2>/dev/null <<'PY'
import socket
import sys
s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
s.bind(sys.argv[1])
s.close()
PY
then
  if [[ -S "$type_stage/socket" ]]; then
    tar -C "$type_stage" --transform='s|^socket$|database.dump|' \
      -czf "$work/socket-outer.tar.gz.age" socket
    verify_failure "$work/socket-outer.tar.gz.age" "$work/verify-socket-outer"
  fi
fi

if [[ "$(id -u)" == 0 ]] && mknod "$type_stage/device" c 1 3 2>/dev/null; then
  tar -C "$type_stage" --transform='s|^device$|database.dump|' \
    -czf "$work/device-outer.tar.gz.age" device
  verify_failure "$work/device-outer.tar.gz.age" "$work/verify-device-outer"
fi

replacement_destination="$work/verify-replaced-destination"
if PATH="$work/bin:$PATH" TEST_REPLACE_VERIFY_DEST=1 BACKUP_CONFIG_FILE="$config" \
  bash "$verifier" "$full_archive" "$identity" "$replacement_destination" \
  >/dev/null 2>&1; then
  fail "verifier succeeded after its destination was replaced"
fi
[[ -f "$replacement_destination/do-not-delete" ]] \
  || fail "verifier cleanup deleted a replaced destination"
[[ -f "$replacement_destination/.archive.plain.tmp" \
  && "$(<"$replacement_destination/.archive.plain.tmp")" == preserve-lookalike ]] \
  || fail "verifier cleanup deleted a lookalike file in a replaced destination"
rm -rf -- "$replacement_destination" "${replacement_destination}.original"

mkdir -p "$work/emergency-backups"
if PATH="$work/bin:$PATH" BACKUP_CONFIG_FILE="$config" \
  bash "$verifier" "$full_archive" "$identity" \
  "$work/emergency-backups/verification" >/dev/null 2>&1; then
  fail "verifier accepted a destination inside the emergency backup root"
fi
[[ ! -e "$work/emergency-backups/verification" ]]

mkdir -p "$work/live-data"
if PATH="$work/bin:$PATH" BACKUP_CONFIG_FILE="$config" \
  bash "$verifier" "$full_archive" "$identity" \
  "$work/live-data/verification" >/dev/null 2>&1; then
  fail "verifier accepted a destination inside the live data root"
fi
[[ ! -e "$work/live-data/verification" ]]

# The destination must be disjoint in both directions, even when the protected
# descendant does not exist yet.
ancestor_config="$work/ancestor-destination.env"
cp "$config" "$ancestor_config"
sed -i "s|^LEARN_DATA_ROOT=.*|LEARN_DATA_ROOT=$work/verifier-ancestor-destination/live-data|" \
  "$ancestor_config"
if PATH="$work/bin:$PATH" BACKUP_CONFIG_FILE="$ancestor_config" \
  bash "$verifier" "$full_archive" "$identity" \
  "$work/verifier-ancestor-destination" >/dev/null 2>&1; then
  fail "verifier accepted a destination that is an ancestor of live data"
fi
[[ ! -e "$work/verifier-ancestor-destination" ]]

# A destination with a symlinked ancestor is not a canonically named protected
# extraction directory, even when the resolved target is otherwise disjoint.
mkdir "$work/verifier-safe-parent"
ln -s "$work/verifier-safe-parent" "$work/verifier-symlink-ancestor"
if [[ -L "$work/verifier-symlink-ancestor" ]]; then
  if PATH="$work/bin:$PATH" BACKUP_CONFIG_FILE="$config" \
    bash "$verifier" "$full_archive" "$identity" \
    "$work/verifier-symlink-ancestor/verification" >/dev/null 2>&1; then
    fail "verifier accepted a destination with a symlinked ancestor"
  fi
  [[ ! -e "$work/verifier-safe-parent/verification" ]]
fi

if [[ "$test_group" == m6-destination-safety ]]; then
  echo "backup-publication-m6-destination-tests-ok"
  exit 0
fi

canonical_fixture_hash() {
  local root="$1" output="$2" source="$1/source" stage="$1/stage"
  mkdir -p "$source/content" "$stage"
  printf fixed >"$source/content/item"
  tar --sort=name --format=posix --pax-option=delete=atime,delete=ctime \
    --owner=0 --group=0 --numeric-owner --mode='u+rwX,go+rX,go-w' \
    --mtime='2026-07-15 01:02:03 UTC' --use-compress-program='gzip -n' \
    --create --file "$stage/repository.tar.gz" --directory "$source" content
  printf fixed-database >"$stage/database.dump"
  printf '%s\n' '{"fixed":"sealed-probe"}' >"$stage/credential-probe.json"
  printf '%s\n' 'fixed-manifest' >"$stage/MANIFEST.txt"
  (cd "$stage" && sha256sum --text \
    database.dump repository.tar.gz credential-probe.json MANIFEST.txt >SHA256SUMS)
  tar --sort=name --format=posix --pax-option=delete=atime,delete=ctime \
    --owner=0 --group=0 --numeric-owner --mode='u=rw,go=' \
    --mtime='2026-07-15 01:02:03 UTC' --use-compress-program='gzip -n' \
    --create --file "$output" --directory "$stage" \
    MANIFEST.txt SHA256SUMS credential-probe.json database.dump repository.tar.gz
  sha256sum "$output" | awk '{print $1}'
}
canonical_one="$(canonical_fixture_hash "$work/canonical-one" "$work/canonical-one.envelope.tar.gz")"
canonical_two="$(canonical_fixture_hash "$work/canonical-two" "$work/canonical-two.envelope.tar.gz")"
[[ "$canonical_one" == "$canonical_two" ]] \
  || fail "fixed-input canonical packaging changed across source roots"
if [[ "$test_group" == m4-nested-schema ]]; then
  echo "backup-publication-m4-tests-ok"
  exit 0
fi
fi

# Exercise the full controller with exact fakes. GNU tar/gzip/checksum remain
# real so the candidate accepted by the verifier is the candidate published.
fixture_repo="$work/release"
mkdir -p "$fixture_repo/content" "$fixture_repo/drizzle" "$fixture_repo/infra" \
  "$fixture_repo/docs/runbooks"
printf lesson >"$fixture_repo/content/lesson.json"
printf migration >"$fixture_repo/drizzle/0000.sql"
printf infra >"$fixture_repo/infra/unit.conf"
printf deployment >"$fixture_repo/docs/deployment.md"
printf runbook >"$fixture_repo/docs/runbooks/recovery.md"
printf compose >"$fixture_repo/compose.yaml"
printf docker >"$fixture_repo/Dockerfile"
printf ignore >"$fixture_repo/.dockerignore"
git -C "$fixture_repo" init -q
git -C "$fixture_repo" config user.email backup-test@example.invalid
git -C "$fixture_repo" config user.name backup-test
git -C "$fixture_repo" add .
git -C "$fixture_repo" commit -qm fixture

cat >"$work/bin/docker" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
readonly image_hash="cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
readonly postgres_id="dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
readonly replacement_postgres_id="eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
container_id_for_service() {
  local service="$1"
  if [[ "$service" == postgres ]]; then
    printf '%s\n' "$postgres_id"
  else
    printf '%s' "$service" | sha256sum | awk '{print $1}'
  fi
}
service_for_container_id() {
  local candidate="$1" service expected
  for service in app cloudflared exam-finalization-worker mail-worker migrate \
    practice-runner-recovery-worker project-review-correction-worker \
    regrade-worker reward-worker clamav scan-worker lifecycle platform-seed \
    admin-bootstrap unknown-stopped-service; do
    expected="$(container_id_for_service "$service")"
    if [[ "$expected" == "$candidate"* || "$candidate" == "$expected"* ]]; then
      printf '%s\n' "$service"
      return 0
    fi
  done
  return 1
}
event_state_dir="${TEST_EVENT_STATE_DIR:-$(dirname -- "${BACKUP_CONFIG_FILE:?}")/event-monitor}"
mkdir -p -- "$event_state_dir"
touch "$event_state_dir/actions"
if [[ "${1:-}" == image && "${2:-}" == inspect ]]; then
  joined=" $* "
  [[ "$joined" == *" --format {{.Id}} "* \
    && "$joined" == *"registry.example.invalid/codestead/operations@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"* ]] \
    || exit 64
  printf 'sha256:%s\n' "$image_hash"
  exit 0
fi
if [[ "${1:-}" == inspect ]]; then
  joined=" $* "
  inspect_target="${@: -1}"
  if [[ ( "$inspect_target" == "$postgres_id" \
      || "$inspect_target" == "$replacement_postgres_id" ) \
    && "$joined" == *".State.Running"* ]]; then
    postgres_state=healthy
    [[ -z "${TEST_POSTGRES_STATE_FILE:-}" \
      || ! -f "$TEST_POSTGRES_STATE_FILE" ]] \
      || postgres_state="$(<"$TEST_POSTGRES_STATE_FILE")"
    if [[ "$postgres_state" == missing ]]; then
      exit 1
    fi
    if [[ "$postgres_state" == changed ]]; then
      [[ "$inspect_target" == "$replacement_postgres_id" ]] || exit 1
      inspect_id="$replacement_postgres_id"
      postgres_state=healthy
    else
      [[ "$inspect_target" == "$postgres_id" ]] || exit 1
      inspect_id="$postgres_id"
    fi
    running=true
    status=running
    health=healthy
    case "$postgres_state" in
      healthy) ;;
      stopped) running=false; status=exited; health=unhealthy ;;
      paused) status=paused ;;
      unhealthy) health=unhealthy ;;
      *) exit 64 ;;
    esac
    inspect_repo="${TEST_EVENT_REPO_ROOT:-}"
    if [[ -z "$inspect_repo" ]]; then
      inspect_repo="$(sed -n 's/^REPO_ROOT=//p' "${BACKUP_CONFIG_FILE:?}")"
    fi
    [[ "$inspect_repo" == /* ]] || exit 64
    printf '%s|%s|%s|%s|%s|%s|%s\n' \
      "$inspect_id" "$running" "$status" "$health" learncoding \
      "$inspect_repo" postgres
    exit 0
  fi
  if [[ "$joined" == *'.State.Running'* \
    && "$joined" == *'com.docker.compose.project.working_dir'* \
    && "$inspect_target" =~ ^[0-9a-f]{12,64}$ ]]; then
    inspect_service="$(service_for_container_id "$inspect_target")" || exit 1
    inspect_full_id="$(container_id_for_service "$inspect_service")"
    inspect_running=true
    if [[ -n "${TEST_RUNNING_STATE:-}" && -f "$TEST_RUNNING_STATE" ]]; then
      grep -Fxq "$inspect_service" "$TEST_RUNNING_STATE" \
        || inspect_running=false
    elif [[ " ${TEST_RUNNING_SERVICES:-postgres app cloudflared} " \
      != *" $inspect_service "* ]]; then
      inspect_running=false
    fi
    inspect_repo="${TEST_EVENT_REPO_ROOT:-}"
    [[ -n "$inspect_repo" ]] \
      || inspect_repo="$(sed -n 's/^REPO_ROOT=//p' "${BACKUP_CONFIG_FILE:?}")"
    printf '%s|%s|%s|%s|%s\n' "$inspect_full_id" "$inspect_running" \
      learncoding "$inspect_repo" "$inspect_service"
    exit 0
  fi
  if [[ "$joined" == *"3333333333333333333333333333333333333333333333333333333333333333"* \
    && "$joined" == *".Config.Image"* ]]; then
    status=created
    name=/codestead-backup-monitor-20260714T010203Z-start-4242
    configured_image="registry.example.invalid/codestead/operations@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    runtime_image="sha256:$image_hash"
    project=learncoding
    workdir="${TEST_EVENT_REPO_ROOT:?}"
    service=backup-monitor
    token=20260714T010203Z.4242.aaaaaaaaaaaa
    phase=start
    watchtower=false
    case "${TEST_STALE_SENTINEL:-}" in
      bad-image) configured_image="registry.example.invalid/unrelated@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" ;;
      bad-runtime-image) runtime_image=sha256:not-an-image-id ;;
      running) status=running ;;
      bad-name) name=/unrelated-container ;;
      wrong-project) project=unrelated ;;
      wrong-workdir) workdir=/unrelated/release ;;
      wrong-service) service=app ;;
      missing-token) token= ;;
      bad-phase) phase=middle ;;
      missing-watchtower) watchtower= ;;
      true-watchtower) watchtower=true ;;
      checkpoint-valid)
        name=/codestead-backup-monitor-20260714T010203Z-checkpoint-7-4242
        phase=checkpoint-7
        ;;
      checkpoint-zero)
        name=/codestead-backup-monitor-20260714T010203Z-checkpoint-0-4242
        phase=checkpoint-0
        ;;
      checkpoint-leading-zero)
        name=/codestead-backup-monitor-20260714T010203Z-checkpoint-01-4242
        phase=checkpoint-01
        ;;
      checkpoint-phase-mismatch)
        name=/codestead-backup-monitor-20260714T010203Z-checkpoint-7-4242
        phase=checkpoint-8
        ;;
      checkpoint-wrong-token)
        name=/codestead-backup-monitor-20260714T010203Z-checkpoint-7-4242
        phase=checkpoint-7
        token=20260714T010203Z.4243.aaaaaaaaaaaa
        ;;
    esac
    printf '%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s\n' \
      "3333333333333333333333333333333333333333333333333333333333333333" \
      "$configured_image" "$runtime_image" "$status" "$name" "$project" \
      "$workdir" "$service" "$token" "$phase" "$watchtower"
    exit 0
  fi
  printf 'sha256:%s\n' "$image_hash"
  exit 0
fi
if [[ "${1:-}" == events ]]; then
  joined=" $* "
  printf '%s\n' "$joined" >"$event_state_dir/events-argv"
  [[ "$joined" == *" --filter type=container "* \
    && "$joined" == *" --filter label=com.docker.compose.project=learncoding "* \
    && "$joined" == *" --filter label=com.docker.compose.project.working_dir="* \
    && "$joined" == *" --filter event=create "* \
    && "$joined" == *" --filter event=destroy "* \
    && "$joined" == *" --filter event=start "* \
    && "$joined" == *" --filter event=restart "* \
    && "$joined" == *" --filter event=unpause "* \
    && "$joined" == *" --since "* \
    && "$joined" != *" --until "* \
    && "$joined" == *" --format "* \
    && "$joined" == *'{{.Action}}'* \
    && "$joined" == *'{{.ID}}'* \
    && "$joined" == *'"signal"'* \
    && "$joined" == *'"exitCode"'* ]] || {
      printf '%s\n' invalid-argv >"$event_state_dir/events-error"
      exit 64
    }
  if [[ "${TEST_REQUIRE_COMPLETE_EVENT_FILTERS:-0}" == 1 ]]; then
    for required_action in die kill oom pause rename stop update health_status; do
      [[ "$joined" == *" --filter event=$required_action "* ]] || {
        printf '%s\n' "missing-event-filter:$required_action" \
          >"$event_state_dir/events-error"
        exit 64
      }
    done
  fi
  if [[ "${TEST_REQUIRE_EXEC_POLICY:-0}" == 1 ]]; then
    for excluded_action in exec_create exec_start exec_die; do
      [[ "$joined" != *" --filter event=$excluded_action "* ]] || {
        printf '%s\n' "unexpected-exec-filter:$excluded_action" \
          >"$event_state_dir/events-error"
        exit 64
      }
    done
  fi
  declare -A subscribed_actions=()
  for argument in "$@"; do
    case "$argument" in
      event=*) subscribed_actions["${argument#event=}"]=1 ;;
    esac
  done
  expected_repo=""
  for argument in "$@"; do
    case "$argument" in
      label=com.docker.compose.project.working_dir=*)
        expected_repo="${argument#*working_dir=}"
        ;;
    esac
  done
  [[ "$expected_repo" == /* ]] || exit 64
  printf '%s' "$expected_repo" >"$event_state_dir/repo"
  emitted_bytes="$event_state_dir/emitted-bytes"
  : >"$emitted_bytes"
  emit_full_record() {
    local record="$1"
    printf '%s\n' "$record"
    printf '%s\n' "$record" >>"$emitted_bytes"
  }
  emit_partial_record() {
    local record="$1"
    printf '%s' "$record"
    printf '%s' "$record" >>"$emitted_bytes"
  }
  emit_oversized_tail() {
    head -c 1048577 /dev/zero | tr '\0' x | tee -a "$emitted_bytes"
  }
  fixture_checkpoint_id() {
    printf '%s' "$1" | sha256sum | awk '{print $1}'
  }
  emit_parser_fixture_record() {
    emit_full_record "$1"
    printf '%s\n' observed >"$event_state_dir/parser-fixture-observed"
  }
  if [[ "${TEST_CHECKPOINT_SCENARIO:-valid}" == closed-tail-post-boundary ]]; then
    trap '
      forbidden_id="$(container_id_for_service app)"
      emit_full_record "kill|$forbidden_id|app|$expected_repo|||15|"
      printf "%s\n" observed >"$event_state_dir/closed-drain-tail-observed"
      exit 143
    ' TERM
  fi
  printf '%s\n' ready >"$event_state_dir/ready"
  cursor=0
  while :; do
    if [[ -e "$event_state_dir/lose-monitor" ]]; then
      exit 70
    fi
    mapfile -t actions <"$event_state_dir/actions"
    while ((cursor < ${#actions[@]})); do
      action_line="${actions[$cursor]}"
      ((cursor += 1))
      case "$action_line" in
        RAW_FULL:*)
          emit_full_record "${action_line#RAW_FULL:}"
          printf '%s\n' observed >"$event_state_dir/raw-full-observed"
          continue
          ;;
        RAW_NO_LF:*)
          emit_partial_record "${action_line#RAW_NO_LF:}"
          wc -c <"$emitted_bytes" >"$event_state_dir/raw-no-lf-size"
          printf '%s\n' observed >"$event_state_dir/raw-no-lf-observed"
          continue
          ;;
        RAW_LF)
          printf '\n'
          printf '\n' >>"$emitted_bytes"
          wc -c <"$emitted_bytes" >"$event_state_dir/raw-lf-size"
          printf '%s\n' observed >"$event_state_dir/raw-lf-observed"
          continue
          ;;
        RAW_OVERSIZE_AFTER_AUDIT)
          for _ in $(seq 1 1000); do
            [[ ! -e "$event_state_dir/event-audit-start" ]] \
              || break
            /usr/bin/sleep 0.005
          done
          [[ -e "$event_state_dir/event-audit-start" ]] || exit 72
          emit_oversized_tail
          printf '%s\n' observed >"$event_state_dir/oversized-tail-observed"
          continue
          ;;
      esac
      IFS='|' read -r action field_two field_three field_four field_five \
        field_six field_seven field_eight extra \
        <<<"$action_line"
      [[ -z "${extra:-}" ]] || exit 71
      if [[ "$field_two" =~ ^[0-9a-f]{64}$ ]]; then
        exec_id="$field_two"
        service="$field_three"
        action_repo="$field_four"
        token="$field_five"
        phase="$field_six"
        event_signal="$field_seven"
        exit_code="$field_eight"
      else
        service="$field_two"
        action_repo="$field_three"
        token="$field_four"
        phase="$field_five"
        exec_id="$field_six"
        [[ "$exec_id" =~ ^[0-9a-f]{64}$ ]] \
          || exec_id="$(container_id_for_service "$service")"
        event_signal=""
        exit_code=""
        [[ "$action" != kill ]] || event_signal=15
        [[ "$action" != die ]] || exit_code=0
      fi
      record_suffix=""
      if [[ "${TEST_QUIESCE_EVENT_SCENARIO:-}" == ninth-empty-field \
        && "$action" == kill && "$service" == app ]]; then
        record_suffix='|'
      fi
      # The real daemon applies the exact release-label filters server-side.
      [[ "$action_repo" == "$expected_repo" ]] || continue
      action_filter="${action%%:*}"
      [[ -n "${subscribed_actions[$action_filter]+x}" ]] || continue
      if [[ "${TEST_EVENT_LINE_LIMIT:-0}" == 1 \
        && "${TEST_EVENT_SCENARIO:-}" == oversized-log \
        && "$action" == create && "$service" == backup-monitor \
        && "$phase" == checkpoint-3 ]]; then
        printf '%s\n' observed >"$event_state_dir/oversized-checkpoint-blocked"
        while :; do :; done
      fi
      if [[ "$service" == backup-monitor && "$phase" == checkpoint-1 ]]; then
        fixture_id="$(fixture_checkpoint_id checkpoint-fixture)"
        case "${TEST_CHECKPOINT_RECORD_MUTATION:-}:$action" in
          duplicate-number:create)
            emit_parser_fixture_record \
              "create|$fixture_id|backup-monitor|$action_repo|$token|checkpoint-1||"
            emit_parser_fixture_record \
              "destroy|$fixture_id|backup-monitor|$action_repo|$token|checkpoint-1||"
            ;;
          skipped-number:create)
            emit_parser_fixture_record \
              "create|$fixture_id|backup-monitor|$action_repo|$token|checkpoint-2||"
            emit_parser_fixture_record \
              "destroy|$fixture_id|backup-monitor|$action_repo|$token|checkpoint-2||"
            ;;
          checkpoint-zero:create)
            emit_parser_fixture_record \
              "create|$fixture_id|backup-monitor|$action_repo|$token|checkpoint-0||"
            emit_parser_fixture_record \
              "destroy|$fixture_id|backup-monitor|$action_repo|$token|checkpoint-0||"
            ;;
          checkpoint-leading-zero:create)
            emit_parser_fixture_record \
              "create|$fixture_id|backup-monitor|$action_repo|$token|checkpoint-01||"
            emit_parser_fixture_record \
              "destroy|$fixture_id|backup-monitor|$action_repo|$token|checkpoint-01||"
            ;;
          destroy-before-create:create)
            emit_parser_fixture_record \
              "destroy|$fixture_id|backup-monitor|$action_repo|$token|checkpoint-1||"
            ;;
          overlap-next-create:destroy)
            emit_parser_fixture_record \
              "create|$fixture_id|backup-monitor|$action_repo|$token|checkpoint-2||"
            ;;
          destroy-id-mismatch:destroy)
            emit_parser_fixture_record \
              "destroy|$fixture_id|backup-monitor|$action_repo|$token|checkpoint-1||"
            ;;
          wrong-token:destroy)
            emit_parser_fixture_record \
              "destroy|$exec_id|backup-monitor|$action_repo|wrong.token|checkpoint-1||"
            ;;
          wrong-repo:destroy)
            emit_parser_fixture_record \
              "destroy|$exec_id|backup-monitor|/wrong/repository|$token|checkpoint-1||"
            ;;
          wrong-service:destroy)
            emit_parser_fixture_record \
              "destroy|$exec_id|backup-monitor-other|$action_repo|$token|checkpoint-1||"
            ;;
          signal-field:destroy)
            emit_parser_fixture_record \
              "destroy|$exec_id|backup-monitor|$action_repo|$token|checkpoint-1|15|"
            ;;
          extra-field:destroy)
            emit_parser_fixture_record \
              "destroy|$exec_id|backup-monitor|$action_repo|$token|checkpoint-1|||extra"
            ;;
          structural-overlap:destroy)
            emit_parser_fixture_record \
              "create|$fixture_id|backup-monitor|$action_repo|$token|quiesce-open||"
            ;;
        esac
      elif [[ "$service" == backup-monitor && "$phase" == checkpoint-2 \
        && "$action" == create \
        && "${TEST_CHECKPOINT_RECORD_MUTATION:-}" == out-of-order-number ]]; then
        fixture_id="$(fixture_checkpoint_id checkpoint-fixture)"
        emit_parser_fixture_record \
          "create|$fixture_id|backup-monitor|$action_repo|$token|checkpoint-1||"
        emit_parser_fixture_record \
          "destroy|$fixture_id|backup-monitor|$action_repo|$token|checkpoint-1||"
      fi
      printf -v emitted_record '%s|%s|%s|%s|%s|%s|%s|%s' \
        "$action" "$exec_id" "$service" "$action_repo" "$token" "$phase" \
        "$event_signal" "$exit_code$record_suffix"
      emit_full_record "$emitted_record"
      if [[ "$action" == destroy && "$service" == backup-monitor \
        && ( "$phase" == end \
          || "$phase" =~ ^checkpoint-[1-9][0-9]*$ ) ]]; then
        wc -c <"$emitted_bytes" \
          >"$event_state_dir/emitted-$phase-boundary"
      fi
    done
    if [[ "${TEST_CHECKPOINT_SCENARIO:-valid}" == closed-tail-post-boundary \
      && -s "$event_state_dir/emitted-end-boundary" ]]; then
      printf '%s\n' ready >"$event_state_dir/closed-drain-wait-ready"
      # Keep the fake Docker stream inside Bash while it awaits the stop. An
      # external sleep in this process group can make Bash print a synthetic
      # "Terminated" job diagnostic even though the TERM trap succeeds.
      while :; do :; done
    else
      /usr/bin/sleep 0.01
    fi
  done
fi
if [[ "${1:-}" == create ]]; then
  shift
  repo="" token="" phase="" service="" name=""
  joined=" $* "
  [[ "$joined" == *" --pull=never "* \
    && "$joined" == *" --network none "* \
    && "$joined" == *" --read-only "* \
    && "$joined" == *" --cap-drop ALL "* \
    && "$joined" == *" --security-opt no-new-privileges "* \
    && "$joined" == *" --label com.centurylinklabs.watchtower.enable=false "* ]] || exit 64
  while (($#)); do
    case "$1" in
      --name) name="$2"; shift 2 ;;
      --label)
        case "$2" in
          com.docker.compose.project=learncoding) ;;
          com.centurylinklabs.watchtower.enable=false) ;;
          com.docker.compose.project.working_dir=*) repo="${2#*=}" ;;
          com.docker.compose.service=*) service="${2#*=}" ;;
          com.codestead.backup.monitor.token=*) token="${2#*=}" ;;
          com.codestead.backup.monitor.phase=*) phase="${2#*=}" ;;
        esac
        shift 2
        ;;
      --pull=never|--network|--cap-drop|--security-opt|--pids-limit|--memory|--cpus)
        if [[ "$1" == --pull=never ]]; then shift; else shift 2; fi
        ;;
      --read-only) shift ;;
      *) shift ;;
    esac
  done
  [[ "$service" == backup-monitor \
    && "$phase" =~ ^(start|quiesce-open|quiesce-close|end|checkpoint-[1-9][0-9]*)$ \
    && "$token" =~ ^[A-Za-z0-9.-]+$ && "$repo" == /* \
    && "$name" =~ ^codestead-backup-monitor- ]] || exit 64
  id=""
  if [[ "$phase" == start ]]; then
    id="1111111111111111111111111111111111111111111111111111111111111111"
  elif [[ "$phase" == quiesce-open ]]; then
    id="4444444444444444444444444444444444444444444444444444444444444444"
  elif [[ "$phase" == quiesce-close ]]; then
    id="5555555555555555555555555555555555555555555555555555555555555555"
  elif [[ "$phase" == end ]]; then
    id="2222222222222222222222222222222222222222222222222222222222222222"
  else
    id="$(printf '%s' "$phase" | sha256sum | awk '{print $1}')"
  fi
  if [[ "$phase" =~ ^checkpoint-[1-9][0-9]*$ ]]; then
    case "${TEST_CHECKPOINT_SCENARIO:-valid}" in
      checkpoint-reuse-id)
        id="$(printf '%s' checkpoint-1 | sha256sum | awk '{print $1}')"
        ;;
      checkpoint-reuse-structural-id)
        id=1111111111111111111111111111111111111111111111111111111111111111
        ;;
    esac
  fi
  printf '%s|%s|%s|%s\n' "$repo" "$token" "$phase" "$name" >"$event_state_dir/$id"
  if [[ "${TEST_CHECKPOINT_SCENARIO:-valid}" == forbidden-pre-boundary \
    && "$phase" == checkpoint-1 ]]; then
    forbidden_id="$(container_id_for_service app)"
    printf '%s\n' "RAW_FULL:kill|$forbidden_id|app|$repo|||15|" \
      >>"$event_state_dir/actions"
  elif [[ "${TEST_CHECKPOINT_SCENARIO:-valid}" == torn-post-boundary \
    && "$phase" == quiesce-open ]]; then
    printf '%s\n' RAW_LF >>"$event_state_dir/actions"
  fi
  printf '%s\n' "create|$id|backup-monitor|$repo|$token|$phase||" \
    >>"$event_state_dir/actions"
  if [[ "$phase" == quiesce-close \
    && "${TEST_QUIESCE_EVENT_SCENARIO:-valid}" == after-close ]]; then
    out_of_phase_id="$(container_id_for_service app)"
    printf '%s\n' "kill|$out_of_phase_id|app|$repo|||15|" \
      >>"$event_state_dir/actions"
  fi
  printf '%s\n' "$id"
  exit 0
fi
if [[ "${1:-}" == rm ]]; then
  shift
  [[ "${1:-}" == -f || "${1:-}" == --force ]] && shift
  id="${1:-}"
  if [[ "$id" == 3333333333333333333333333333333333333333333333333333333333333333 ]]; then
    printf '%s\n' removed >"$event_state_dir/stale-removed"
    printf '%s\n' "$id"
    exit 0
  fi
  [[ -f "$event_state_dir/$id" ]] || exit 64
  IFS='|' read -r repo token phase name <"$event_state_dir/$id"
  if [[ "$phase" == checkpoint-1 ]]; then
    printf '%s\n' \
      "destroy|$id|backup-monitor|$repo|$token|$phase||" \
      >"$event_state_dir/checkpoint-1-destroy-record"
  fi
  if [[ "${TEST_CHECKPOINT_SCENARIO:-valid}" == destroy-no-lf \
    && "$phase" == checkpoint-1 \
    && ! -e "$event_state_dir/destroy-no-lf-injected" ]]; then
    printf '%s\n' injected >"$event_state_dir/destroy-no-lf-injected"
    printf '%s\n' \
      "RAW_NO_LF:destroy|$id|backup-monitor|$repo|$token|$phase||" \
      >>"$event_state_dir/actions"
    printf '%s\n' "$id"
    exit 0
  fi
  if [[ "${TEST_CHECKPOINT_SCENARIO:-valid}" == wait-substring \
    && "$phase" == checkpoint-1 \
    && ! -e "$event_state_dir/wait-substring-injected" ]]; then
    printf '%s\n' injected >"$event_state_dir/wait-substring-injected"
    printf '%s\n' \
      "RAW_FULL:prefix-destroy|$id|backup-monitor|$repo|$token|$phase||" \
      >>"$event_state_dir/actions"
    printf '%s\n' "$id"
    exit 0
  fi
  if [[ "${TEST_CHECKPOINT_SCENARIO:-valid}" == wait-duplicate \
    && "$phase" == checkpoint-1 \
    && ! -e "$event_state_dir/wait-duplicate-injected" ]]; then
    printf '%s\n' injected >"$event_state_dir/wait-duplicate-injected"
    printf '%s\n' \
      "destroy|$id|backup-monitor|$repo|$token|$phase||" \
      "destroy|$id|backup-monitor|$repo|$token|$phase||" \
      >>"$event_state_dir/actions"
    printf '%s\n' "$id"
    exit 0
  fi
  if [[ "${TEST_CHECKPOINT_SCENARIO:-valid}" == closed-tail-pre-boundary \
    && "$phase" == end ]]; then
    forbidden_id="$(container_id_for_service app)"
    printf '%s\n' "RAW_FULL:kill|$forbidden_id|app|$repo|||15|" \
      >>"$event_state_dir/actions"
  fi
  if [[ "${TEST_CHECKPOINT_SCENARIO:-valid}" == checkpoint-blank-record \
    && "$phase" == checkpoint-1 ]]; then
    printf '%s\n' 'RAW_FULL:' >>"$event_state_dir/actions"
  fi
  printf '%s\n' "destroy|$id|backup-monitor|$repo|$token|$phase||" \
    >>"$event_state_dir/actions"
  if [[ "${TEST_CHECKPOINT_SCENARIO:-valid}" == complete-post-boundary \
    && "$phase" == checkpoint-1 ]]; then
    forbidden_id="$(container_id_for_service app)"
    printf '%s\n' "RAW_FULL:kill|$forbidden_id|app|$repo|||15|" \
      >>"$event_state_dir/actions"
    for _ in $(seq 1 1000); do
      [[ ! -e "$event_state_dir/raw-full-observed" ]] || break
      /usr/bin/sleep 0.005
    done
    [[ -e "$event_state_dir/raw-full-observed" ]] || exit 72
  elif [[ "${TEST_CHECKPOINT_SCENARIO:-valid}" == post-boundary-oversize \
    && "$phase" == checkpoint-1 ]]; then
    printf '%s\n' RAW_OVERSIZE_AFTER_AUDIT >>"$event_state_dir/actions"
  fi
  if [[ "${TEST_CHECKPOINT_SCENARIO:-valid}" == torn-post-boundary \
    && "$phase" == checkpoint-1 ]]; then
    forbidden_id="$(container_id_for_service app)"
    printf '%s\n' "RAW_NO_LF:kill|$forbidden_id|app|$repo|||15|" \
      >>"$event_state_dir/actions"
  fi
  if [[ "$phase" == start \
    && "${TEST_QUIESCE_EVENT_SCENARIO:-valid}" == before-open ]]; then
    before_open_id="$(container_id_for_service app)"
    printf '%s\n' "kill|$before_open_id|app|$repo|||15|" \
      >>"$event_state_dir/actions"
  fi
  rm -f -- "$event_state_dir/$id"
  printf '%s\n' "$id"
  exit 0
fi
if [[ "${1:-}" == ps ]]; then
  joined=" $* "
  [[ "$joined" == *" -a "* && "$joined" == *" --format "* ]] || exit 64
  by_reserved_name=0
  by_exact_labels=0
  [[ "$joined" != *" --filter name=^codestead-backup-monitor- "* ]] \
    || by_reserved_name=1
  if [[ "$joined" == *" --filter label=com.docker.compose.project=learncoding "* \
    && "$joined" == *" --filter label=com.docker.compose.project.working_dir="* \
    && "$joined" == *" --filter label=com.docker.compose.service=backup-monitor "* \
    && "$joined" == *" --filter label=com.centurylinklabs.watchtower.enable=false "* ]]; then
    by_exact_labels=1
  fi
  ((by_reserved_name == 1 || by_exact_labels == 1)) || exit 64
  scenario="${TEST_STALE_SENTINEL:-}"
  if ((by_reserved_name == 1)); then
    case "$scenario" in
      valid|bad-image|bad-runtime-image|running|wrong-project|wrong-workdir|wrong-service|missing-token|bad-phase|missing-watchtower|true-watchtower|checkpoint-valid|checkpoint-zero|checkpoint-leading-zero|checkpoint-phase-mismatch|checkpoint-wrong-token)
        printf '%s\n' 3333333333333333333333333333333333333333333333333333333333333333
        ;;
      unrelated|bad-name)
        printf '%s\n' name-filtered >"$event_state_dir/unrelated-filtered"
        ;;
    esac
  else
    # Model the daemon's old label-prefilter behavior: malformed reserved-name
    # containers disappear before inspect and therefore expose the regression.
    case "$scenario" in
      valid|bad-image|bad-runtime-image|running|bad-name|missing-token|bad-phase|checkpoint-valid|checkpoint-zero|checkpoint-leading-zero|checkpoint-phase-mismatch|checkpoint-wrong-token)
        printf '%s\n' 3333333333333333333333333333333333333333333333333333333333333333
        ;;
      unrelated|wrong-project|wrong-workdir|wrong-service|missing-watchtower|true-watchtower)
        printf '%s\n' label-filtered >"$event_state_dir/unrelated-filtered"
        ;;
    esac
  fi
  exit 0
fi
if [[ "${1:-}" == run ]]; then
  [[ "${TEST_PROBE_FAIL:-0}" != 1 ]] || exit 73
  output_source=""
  joined=" $* "
  for required in \
    '--rm' '--pull never' '--network none' '--read-only' '--cap-drop ALL' \
    '--security-opt no-new-privileges' '--pids-limit 64' '--memory 256m' \
    '--cpus 0.5' '--user 1000:1000' '--group-add 2000' '--entrypoint node' \
    '--tmpfs /tmp:rw,noexec,nosuid,nodev,size=16m' \
    'registry.example.invalid/codestead/operations@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' \
    '/app/scripts/backup/create-credential-probe.ts' \
    '/run/secrets/credential_master_key'; do
    [[ "$joined" == *" $required "* ]] || exit 64
  done
  [[ "$joined" != *" --env "* && "$joined" != *" --env-file "* \
    && "$joined" != *database_url* && "$joined" != *cloudflare* \
    && "$joined" != *rclone* && "$joined" != *oauth* ]] || exit 65
  mount_count=0
  for argument in "$@"; do
    case "$argument" in
      type=bind,src=*,dst=/output)
        ((mount_count += 1))
        output_source="${argument#type=bind,src=}"
        output_source="${output_source%,dst=/output}"
        ;;
      type=bind,src=*,dst=/run/secrets/credential_master_key,readonly)
        ((mount_count += 1))
        ;;
      type=bind,*) exit 66 ;;
    esac
  done
  [[ "$mount_count" -eq 2 && -n "$output_source" && -d "$output_source" ]] || exit 64
  printf '%s\n' '{"version":1,"context":{},"sealed":{},"plaintextSha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}' \
    >"$output_source/credential-probe.json"
  chmod 0600 "$output_source/credential-probe.json"
  printf '%s\n' credential-probe >&2
  exit 0
fi
[[ "${1:-}" == compose ]] || exit 64
shift
while (($#)); do
  case "$1" in
    --env-file|-f) shift 2 ;;
    *) break ;;
  esac
done
command="${1:-}"
shift || true
case "$command" in
  config)
    [[ " $* " == *" --format json "* ]] || exit 64
    if [[ "${TEST_COMPOSE_PROJECT_MISMATCH:-0}" == 1 ]]; then
      printf '%s\n' '{"name":"other-project"}'
    else
      printf '%s\n' '{"name":"learncoding"}'
    fi
    exit 0
    ;;
  ps)
    if [[ "${TEST_POSTGRES_EVENT_BOUNDARY:-}" == post-dump \
      && -s "${TEST_POSTGRES_DUMP_COMPLETE:-/nonexistent}" \
      && ! -e "${TEST_POSTGRES_BOUNDARY_INJECTED:-/nonexistent}" ]]; then
      if [[ "${TEST_POSTGRES_EVENT_ACTION:?}" != none ]]; then
        printf '%s\n' \
          "$TEST_POSTGRES_EVENT_ACTION|postgres|${TEST_EVENT_REPO_ROOT:?}||" \
          >>"$event_state_dir/actions"
      fi
      [[ -z "${TEST_POSTGRES_STATE_FILE:-}" ]] \
        || printf '%s\n' "${TEST_POSTGRES_MUTATED_STATE:-healthy}" \
          >"$TEST_POSTGRES_STATE_FILE"
      /usr/bin/date +%s%N >"${TEST_POSTGRES_BOUNDARY_INJECTED:?}"
    fi
    if [[ " $* " == *" --status running "* ]]; then
      if [[ "${TEST_NEW_MUTATOR_AFTER_CAPTURE:-0}" == 1 ]]; then
        query_count=0
        [[ ! -f "$TEST_RUNNING_QUERY_STATE" ]] \
          || query_count="$(<"$TEST_RUNNING_QUERY_STATE")"
        ((query_count += 1))
        printf '%s' "$query_count" >"$TEST_RUNNING_QUERY_STATE"
        if ((query_count == 1)); then
          running_services="postgres app cloudflared"
        else
          running_services="postgres app reward-worker cloudflared"
        fi
      else
        postgres_state=healthy
        [[ -z "${TEST_POSTGRES_STATE_FILE:-}" \
          || ! -f "$TEST_POSTGRES_STATE_FILE" ]] \
          || postgres_state="$(<"$TEST_POSTGRES_STATE_FILE")"
        if [[ -n "${TEST_RUNNING_STATE:-}" && -f "$TEST_RUNNING_STATE" ]]; then
          running_services="$(tr '\n' ' ' <"$TEST_RUNNING_STATE")"
        else
          running_services="${TEST_RUNNING_SERVICES:-postgres app cloudflared}"
        fi
        if [[ "$postgres_state" == stopped || "$postgres_state" == missing \
          || "$postgres_state" == paused ]]; then
          running_services="$(printf '%s\n' "$running_services" \
            | tr ' ' '\n' | grep -vx postgres | tr '\n' ' ')"
        fi
      fi
      if [[ " $* " == *" --services "* ]]; then
        printf '%s\n' "$running_services" | tr ' ' '\n'
      elif [[ " $* " == *" --format "* ]]; then
        while IFS= read -r running_service; do
          [[ -n "$running_service" ]] || continue
          printf '%s %s\n' "$running_service" \
            "$(container_id_for_service "$running_service")"
        done < <(printf '%s\n' "$running_services" | tr ' ' '\n')
      else
        exit 64
      fi
      exit 0
    fi
    if [[ " $* " == *" -a --format "* ]]; then
      include_unknown=0
      if [[ "${TEST_UNKNOWN_CREATED_SERVICE:-0}" == 1 \
        && " $* " != *" app "* ]]; then
        include_unknown=1
      fi
      for service in app cloudflared exam-finalization-worker mail-worker migrate postgres \
        practice-runner-recovery-worker project-review-correction-worker regrade-worker reward-worker; do
        if [[ "$service" == postgres ]]; then
          postgres_state=healthy
          [[ -z "${TEST_POSTGRES_STATE_FILE:-}" \
            || ! -f "$TEST_POSTGRES_STATE_FILE" ]] \
            || postgres_state="$(<"$TEST_POSTGRES_STATE_FILE")"
          [[ "$postgres_state" != missing ]] || continue
          current_postgres_id="$postgres_id"
          if [[ "$postgres_state" == changed ]]; then
            current_postgres_id="$replacement_postgres_id"
          fi
          printf '%s %s\n' "$service" "$current_postgres_id"
        else
          printf '%s %s\n' "$service" "$(container_id_for_service "$service")"
        fi
      done
      if [[ -n "${TEST_CREATED_OPTIONAL_SERVICE:-}" ]]; then
        printf '%s %s\n' "$TEST_CREATED_OPTIONAL_SERVICE" \
          "$(container_id_for_service "$TEST_CREATED_OPTIONAL_SERVICE")"
      fi
      ((include_unknown == 0)) || printf '%s %s\n' unknown-stopped-service \
        "$(container_id_for_service unknown-stopped-service)"
      exit 0
    fi
    exit 64
    ;;
  stop)
    printf '%s\n' quiesce >&2
    [[ " $* " != *" postgres "* ]] || exit 65
    [[ "${TEST_QUIESCE_FAIL:-0}" != 1 ]] || exit 75
    [[ -s "$event_state_dir/repo" ]] || exit 64
    quiesce_repo="$(<"$event_state_dir/repo")"
    quiesce_scenario="${TEST_QUIESCE_EVENT_SCENARIO:-valid}"
    quiesce_services=()
    quiesce_ids=()
    for quiesce_service in "$@"; do
      [[ "$quiesce_service" != --timeout && "$quiesce_service" != 60 ]] \
        || continue
      quiesce_services+=("$quiesce_service")
      quiesce_ids+=("$(container_id_for_service "$quiesce_service")")
    done
    for quiesce_action in kill die stop; do
      for quiesce_service_index in "${!quiesce_services[@]}"; do
        quiesce_service="${quiesce_services[$quiesce_service_index]}"
        quiesce_event_service="$quiesce_service"
        quiesce_id="${quiesce_ids[$quiesce_service_index]}"
        quiesce_event_repo="$quiesce_repo"
        emitted_action="$quiesce_action"
        event_signal=""
        exit_code=""
        record_suffix=""
        [[ "$emitted_action" != kill ]] || event_signal=15
        [[ "$emitted_action" != die ]] || exit_code=0
        if ((quiesce_service_index == 0)); then
          case "$quiesce_scenario" in
            missing)
              [[ "$quiesce_action" != stop ]] || continue
              ;;
            wrong-order)
              [[ "$quiesce_action" != kill ]] || emitted_action=die
              [[ "$quiesce_action" != die ]] || emitted_action=kill
              event_signal=""
              exit_code=""
              [[ "$emitted_action" != kill ]] || event_signal=15
              [[ "$emitted_action" != die ]] || exit_code=0
              ;;
            wrong-id)
              quiesce_id="0000000000000000000000000000000000000000000000000000000000000000"
              ;;
            wrong-service) quiesce_event_service=reward-worker ;;
            wrong-workdir) quiesce_event_repo=/wrong/release ;;
            signal-9)
              [[ "$quiesce_action" != kill ]] || event_signal=9
              ;;
            exit-code)
              [[ "$quiesce_action" != die ]] || exit_code=137
              ;;
            ninth-empty-field)
              [[ "$quiesce_action" != kill ]] || record_suffix='|'
              ;;
          esac
        fi
        printf '%s\n' \
          "$emitted_action|$quiesce_id|$quiesce_event_service|$quiesce_event_repo|||$event_signal|$exit_code$record_suffix" \
          >>"$event_state_dir/actions"
        if ((quiesce_service_index == 0)) \
          && [[ "$quiesce_action" == kill ]]; then
          case "$quiesce_scenario" in
            extra)
              printf '%s\n' \
                "pause|$quiesce_id|$quiesce_event_service|$quiesce_event_repo||||" \
                >>"$event_state_dir/actions"
              ;;
            repeated)
              printf '%s\n' \
                "kill|$quiesce_id|$quiesce_event_service|$quiesce_event_repo|||15|" \
                >>"$event_state_dir/actions"
              ;;
          esac
        fi
      done
      if [[ "$quiesce_scenario" == partial-failure \
        && "$quiesce_action" == kill ]]; then
        exit 75
      fi
    done
    case "$quiesce_scenario" in
      postgres)
        printf '%s\n' "kill|$postgres_id|postgres|$quiesce_repo|||15|" \
          >>"$event_state_dir/actions"
        ;;
      start|restart)
        quiesce_injected_id="$(container_id_for_service app)"
        printf '%s\n' \
          "$quiesce_scenario|$quiesce_injected_id|app|$quiesce_repo||||" \
          >>"$event_state_dir/actions"
        ;;
    esac
    if [[ -n "${TEST_RUNNING_STATE:-}" ]]; then
      printf '%s\n' postgres >"$TEST_RUNNING_STATE"
      if [[ " ${TEST_RUNNING_SERVICES:-} " == *" clamav "* ]]; then
        printf '%s\n' clamav >>"$TEST_RUNNING_STATE"
      fi
    fi
    exit 0
    ;;
  up)
    if [[ "${TEST_USE_REAL_MANAGED_DEADLINE:-0}" == 1 \
      && -n "${TEST_RESUME_ABSENT_IDENTITY:-}" ]]; then
      assert-linux-group-absent "$TEST_RESUME_ABSENT_IDENTITY" \
        "${TEST_RESUME_GROUP_CHECKED:?}"
    fi
    if [[ -n "${TEST_FIRST_RESUME_EVENT:-}" \
      && ! -e "$TEST_FIRST_RESUME_EVENT" ]]; then
      /usr/bin/date +%s%N >"$TEST_FIRST_RESUME_EVENT"
    fi
    printf 'resume:%s\n' "${*: -1}" >&2
    [[ "${TEST_RESUME_FAIL:-0}" != 1 ]] || exit 76
    exit 0
    ;;
  exec)
    joined="$*"
    if [[ "$joined" == *pg_dump* ]]; then
      printf '%s\n' dump >&2
      [[ "${TEST_DUMP_FAIL:-0}" != 1 ]] || exit 77
      case "${TEST_EVENT_SCENARIO:-}" in
        oversized-log)
          storm_id="$(container_id_for_service clamav)"
          for ((storm_line = 0; storm_line < 5000; storm_line += 1)); do
            printf '%s\n' \
              "restart|$storm_id|clamav|${TEST_EVENT_REPO_ROOT:?}||||" \
              >>"$event_state_dir/actions"
          done
          ;;
        overflow-mutator)
          printf '%s\n' "start|lifecycle|${TEST_EVENT_REPO_ROOT:?}||" \
            >>"$event_state_dir/actions"
          for _ in $(seq 1 300); do
            printf '%s\n' "restart|clamav|${TEST_EVENT_REPO_ROOT:?}||" \
              >>"$event_state_dir/actions"
          done
          ;;
        monitor-loss) printf '%s\n' lost >"$event_state_dir/lose-monitor" ;;
        postgres-restart)
          printf '%s\n' "restart|postgres|${TEST_EVENT_REPO_ROOT:?}||" \
            >>"$event_state_dir/actions"
          ;;
        unrelated-project)
          printf '%s\n' 'start|lifecycle|/unrelated/release||' \
            >>"$event_state_dir/actions"
          ;;
        clamav-restart)
          for clamav_action in stop kill die start restart 'health_status: healthy'; do
            printf '%s\n' "$clamav_action|clamav|${TEST_EVENT_REPO_ROOT:?}||" \
              >>"$event_state_dir/actions"
          done
          [[ -z "${TEST_RUNNING_STATE:-}" ]] \
            || printf '%s\n' postgres clamav >"$TEST_RUNNING_STATE"
          ;;
        clamav-restart-incomplete)
          for clamav_action in stop kill die start restart; do
            printf '%s\n' "$clamav_action|clamav|${TEST_EVENT_REPO_ROOT:?}||" \
              >>"$event_state_dir/actions"
          done
          ;;
        clamav-restart-overlong)
          for _ in $(seq 1 9); do
            printf '%s\n' "stop|clamav|${TEST_EVENT_REPO_ROOT:?}||" \
              >>"$event_state_dir/actions"
          done
          printf '%s\n' \
            "start|clamav|${TEST_EVENT_REPO_ROOT:?}||" \
            "health_status: healthy|clamav|${TEST_EVENT_REPO_ROOT:?}||" \
            >>"$event_state_dir/actions"
          ;;
        unattributed-postgres-exec)
          printf '%s\n' "exec_start|postgres|${TEST_EVENT_REPO_ROOT:?}||" \
            >>"$event_state_dir/actions"
          ;;
      esac
      printf '%s' synthetic-postgresql-custom-dump
      [[ -z "${TEST_POSTGRES_DUMP_COMPLETE:-}" ]] \
        || /usr/bin/date +%s%N >"$TEST_POSTGRES_DUMP_COMPLETE"
    elif [[ "$joined" == *"postgres --version"* ]]; then
      printf '%s\n' 'postgres (PostgreSQL) 17.5'
    elif [[ "$joined" == *"__drizzle_migrations"* ]]; then
      [[ "${TEST_MIGRATION_FAIL:-0}" != 1 ]] || exit 78
      if [[ "${TEST_MIGRATION_PRODUCER_HANG:-0}" == 1 ]]; then
        trap '' TERM
        printf '%s\n' "$BASHPID" >"${TEST_MIGRATION_PRODUCER_PID:?}"
        record-linux-process-identity "$BASHPID" \
          "${TEST_PROCESS_GROUP_IDENTITY:?}"
        printf '%s\n' ready >"${TEST_MIGRATION_PRODUCER_READY:?}"
        while :; do /usr/bin/sleep 0.05; done
      fi
      if [[ "${TEST_MIGRATION_LARGE_COUNT:-0}" =~ ^[1-9][0-9]*$ ]]; then
        /usr/bin/python3 - "$TEST_MIGRATION_LARGE_COUNT" <<'PY'
import sys
row_hash = "b" * 64
output = sys.stdout.buffer
for row_id in range(1, int(sys.argv[1]) + 1):
    output.write(f"{row_id}|{row_hash}|{1000 + row_id}\n".encode("ascii"))
PY
      else
        printf '%s\n' \
          "1|aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa|1000" \
          "2|bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb|2000"
      fi
      [[ -z "${TEST_MIGRATION_PRODUCER_COMPLETE:-}" ]] \
        || /usr/bin/date +%s%N >"$TEST_MIGRATION_PRODUCER_COMPLETE"
    elif [[ "$joined" == *email_outbox* ]]; then
      printf '%s\n' queued
    else
      exit 64
    fi
    ;;
  *) exit 64 ;;
esac
EOF
chmod 0755 "$work/bin/docker"

compose_env="$work/compose.env"
cat >"$compose_env" <<EOF
APP_OPERATIONS_IMAGE=registry.example.invalid/codestead/operations@sha256:$fixture_hash
SECRETS_GID=2000
EOF
chmod 0640 "$compose_env"
recipient="$work/recipient.txt"
printf '%s\n' age1offlinepublicationfixture >"$recipient"
chmod 0600 "$recipient"
master_key="$work/credential-master-key"
node -e "process.stdout.write(Buffer.alloc(32, 9).toString('base64'))" >"$master_key"
chmod 0440 "$master_key"

make_backup_case() {
  local case_name="$1" case_repo="${2:-$fixture_repo}"
  local case_root case_ephemeral_root marker old_name old_hash
  case_root="$work/$case_name"
  case_ephemeral_root="$case_root/runtime"
  if [[ "${TEST_USE_REAL_MANAGED_DEADLINE:-0}" == 1 ]]; then
    case_ephemeral_root="$work/runtime"
  fi
  mkdir -p "$case_root/backups/full" "$case_root/backups/state" \
    "$case_root/data/app-data" "$case_root/stage" "$case_root/runtime"
  chmod 0700 "$case_root/backups/full" "$case_root/backups/state" \
    "$case_root/stage" "$case_root/runtime"
  printf '%s\n' LEARNCODING_BACKUP_V1 >"$case_root/backups/.learncoding-backup-root"
  chmod 0600 "$case_root/backups/.learncoding-backup-root"
  printf object >"$case_root/data/app-data/object"
  old_name=learncoding-full-20260701T000000Z.tar.gz.age
  printf old-ciphertext >"$case_root/backups/full/$old_name"
  old_hash="$(sha256sum "$case_root/backups/full/$old_name" | awk '{print $1}')"
  printf '%s  %s\n' "$old_hash" "$old_name" >"$case_root/backups/full/$old_name.sha256"
  chmod 0600 "$case_root/backups/full/$old_name" "$case_root/backups/full/$old_name.sha256"
  marker="$case_root/backups/state/local-last-success.env"
  cat >"$marker" <<EOF
SUCCESS_ARCHIVE=$old_name
SUCCESS_COMPLETED_UTC=20260701T000001Z
SUCCESS_SHA256=$old_hash
EOF
  chmod 0600 "$marker"
  cat >"$case_root/backup.env" <<EOF
BACKUP_ROOT=$case_root/backups
REPO_ROOT=$case_repo
COMPOSE_ENV_FILE=$compose_env
LEARN_DATA_ROOT=$case_root/data
BACKUP_STAGE_ROOT=$case_root/stage
BACKUP_EPHEMERAL_ROOT=$case_ephemeral_root
BACKUP_LOCK_FILE=$case_root/backup.lock
AGE_RECIPIENT_FILE=$recipient
CREDENTIAL_MASTER_KEY_FILE=$master_key
FILESYSTEM_WARN_PERCENT=70
FILESYSTEM_CRITICAL_PERCENT=85
EOF
  chmod 0600 "$case_root/backup.env"
  printf '%s\n' "$case_root"
}

phase_line() {
  local phase="$1" log_file="$2"
  grep -n -m1 "phase=$phase" "$log_file" | cut -d: -f1
}

assert_recorded_process_dead() {
  local pid_file="$1" identity_file="$2" label="$3" pid attempt checked
  [[ -s "$pid_file" ]] \
    || fail "$label fixture did not record its descendant PID"
  pid="$(<"$pid_file")"
  [[ "$pid" =~ ^[1-9][0-9]*$ ]] \
    || fail "$label fixture recorded an invalid descendant PID"
  [[ -s "$identity_file" ]] || return 0
  for attempt in $(seq 1 100); do
    checked="$work/.group-absence.$BASHPID.$attempt"
    rm -f -- "$checked"
    if "$work/bin/assert-linux-group-absent" "$identity_file" "$checked" \
      2>/dev/null; then
      rm -f -- "$checked"
      return 0
    fi
    rm -f -- "$checked"
    /usr/bin/sleep 0.02
  done
  fail "$label exact PID/PGID/start identity remained after its deadline"
}

configured_case_ephemeral_root() {
  local case_root="$1"
  if [[ "${TEST_USE_REAL_MANAGED_DEADLINE:-0}" == 1 ]]; then
    printf '%s\n' "$work/runtime"
  else
    printf '%s\n' "$case_root/runtime"
  fi
}

assert_case_protected_roots_empty() {
  local label="$1" case_root="$2" runtime_root
  runtime_root="$(configured_case_ephemeral_root "$case_root")"
  if [[ -n "$(find -P "$case_root/stage" "$runtime_root" \
    -mindepth 1 -print -quit)" ]]; then
    find -P "$case_root/stage" "$runtime_root" -mindepth 1 -maxdepth 3 \
      -print >&2
    fail "$label left plaintext or protected runtime material"
  fi
}

last_precommit_failure_case=""
run_precommit_failure_case() {
  local label="$1" expect_resume="$2" case_root archive_count checksum_count
  local old_archive old_checksum
  local controller_status=0 wall_seconds="${TEST_CASE_WALL_SECONDS:-120}"
  shift 2
  [[ "$wall_seconds" =~ ^[1-9][0-9]*$ ]] \
    || fail "$label has an invalid wall timeout"
  case_root="$(make_backup_case "publication-$label-failure")"
  last_precommit_failure_case="$case_root"
  cp "$case_root/backups/state/local-last-success.env" "$case_root/old-marker"
  old_archive="$case_root/backups/full/learncoding-full-20260701T000000Z.tar.gz.age"
  old_checksum="$old_archive.sha256"
  cp -- "$old_archive" "$case_root/old-archive"
  cp -- "$old_checksum" "$case_root/old-checksum"
  /usr/bin/timeout --kill-after=5s "${wall_seconds}s" \
    /usr/bin/env PATH="$work/bin:$PATH" \
    TEST_RUNNING_STATE="$case_root/running-state" \
    BACKUP_CONFIG_FILE="$case_root/backup.env" "$@" \
    bash "$backup_controller" \
    >"$case_root/stdout" 2>"$case_root/log" || controller_status=$?
  if ((controller_status == 0)); then
    fail "backup succeeded after injected $label failure"
  fi
  if ((controller_status == 124 || controller_status == 137)); then
    sed -n '1,160p' "$case_root/log" >&2
    fail "$label exceeded its ${wall_seconds}s wall timeout"
  fi
  cmp -s "$case_root/old-marker" "$case_root/backups/state/local-last-success.env" \
    || fail "$label failure changed the previous success marker"
  cmp -s "$case_root/old-archive" "$old_archive" \
    || fail "$label failure changed the previous recovery archive"
  cmp -s "$case_root/old-checksum" "$old_checksum" \
    || fail "$label failure changed the previous recovery checksum"
  archive_count="$(find "$case_root/backups/full" -maxdepth 1 -type f \
    -name 'learncoding-full-*.tar.gz.age' | wc -l | tr -d ' ')"
  [[ "$archive_count" == 1 ]] || fail "$label failure left a candidate final archive"
  checksum_count="$(find "$case_root/backups/full" -maxdepth 1 -type f \
    -name 'learncoding-full-*.tar.gz.age.sha256' | wc -l | tr -d ' ')"
  [[ "$checksum_count" == 1 ]] || fail "$label failure left a candidate final sidecar"
  [[ -z "$(find "$case_root/backups" -type f -name '.*.tmp.*' -print -quit)" ]] \
    || fail "$label failure left a publication or marker temporary"
  if [[ "$expect_resume" == true ]]; then
    if ! grep -Fq 'resume:app' "$case_root/log"; then
      sed -n '1,120p' "$case_root/log" >&2
      find "$case_root/event-monitor" -maxdepth 1 -type f -print -exec sed -n '1,80p' {} \; \
        >&2 2>/dev/null || true
      fail "$label failure did not resume the captured app"
    fi
  fi
  if grep -Eq 'phase=(marker_committed|pruning|complete)|offsite-sync|event=backup_complete' \
    "$case_root/log"; then
    fail "$label failure emitted a post-commit, offsite, or success event"
  fi
  if grep -Fq "$master_key" "$case_root/log" \
    || grep -Fq "$(<"$master_key")" "$case_root/log" \
    || grep -Fq "$(<"$recipient")" "$case_root/log" \
    || grep -Fq 'AGE-SECRET-KEY-' "$case_root/log"; then
    fail "$label failure leaked key or recipient material"
  fi
}

assert_precommit_failure() {
  local label="$1" expect_resume="$2" case_root
  shift 2
  run_precommit_failure_case "$label" "$expect_resume" "$@"
  case_root="$last_precommit_failure_case"
  assert_case_protected_roots_empty "$label failure" "$case_root"
}

assert_protected_entry() {
  local label="$1" entry="$2" expected_kind="$3" expected_mode="$4"
  local entry_mode entry_owner expected_owner
  expected_owner="$(id -u)"
  [[ ! -L "$entry" ]] || fail "$label retained a protected symlink: $entry"
  case "$expected_kind" in
    directory) [[ -d "$entry" ]] || fail "$label omitted protected directory: $entry" ;;
    file) [[ -f "$entry" ]] || fail "$label omitted protected file: $entry" ;;
    *) fail "$label has an invalid protected-entry assertion" ;;
  esac
  entry_mode="$(stat -c '%a' -- "$entry")"
  entry_owner="$(stat -c '%u' -- "$entry")"
  [[ "$entry_mode" =~ ^[0-7]{3,4}$ && "$entry_owner" == "$expected_owner" ]] \
    || fail "$label retained an unsafe protected entry: $entry ($entry_mode/$entry_owner)"
  if [[ "${OSTYPE:-}" == msys* ]]; then
    (( (8#$entry_mode & 0022) == 0 )) \
      || fail "$label retained a writable protected entry: $entry ($entry_mode)"
  else
    [[ "$entry_mode" == "$expected_mode" ]] \
      || fail "$label retained a wrong-mode protected entry: $entry ($entry_mode)"
  fi
}

assert_exact_protected_names() {
  local label="$1" directory="$2"
  local index
  shift 2
  local -a expected_names=("$@") actual_names=()
  mapfile -t actual_names < <(find -P "$directory" -mindepth 1 -maxdepth 1 \
    -printf '%f\n' | sort)
  [[ ${#actual_names[@]} -eq ${#expected_names[@]} ]] \
    || fail "$label retained an unexpected protected entry count in $directory"
  for ((index = 0; index < ${#expected_names[@]}; index += 1)); do
    [[ "${actual_names[$index]}" == "${expected_names[$index]}" ]] \
      || fail "$label retained an unexpected protected entry in $directory"
  done
}

assert_monitor_loss_protected_retention() {
  local case_root stage_dir="" verify_dir="" ephemeral_dir="" retained basename
  local containment_alert_count critical_alert_count
  local -a stage_entries=() runtime_entries=()
  local -a full_files=(
    .marker-before app-data.tar.gz credential-probe.json database.dump
    docker-events.log docker-events.stderr images.pre mutators.expected
    repository.tar.gz
  )
  local -a ephemeral_files=(identity.txt recipient.txt recipients.txt)

  run_precommit_failure_case event-monitor-monitor-loss true \
    TEST_EVENT_SCENARIO=monitor-loss TEST_EVENT_REPO_ROOT="$fixture_repo"
  case_root="$last_precommit_failure_case"
  grep -Fq \
    'fatal: quiesced backup transaction failed: release-scoped Docker event continuity failed during recovery-point capture' \
    "$case_root/log" \
    || fail "monitor-loss did not fail at the expected continuity audit"
  containment_alert_count="$(grep -Fc \
    'alert severity=critical event=backup_monitor_containment_failed message=backup monitor containment could not be proved; publication and protected staging were preserved' \
    "$case_root/log" || true)"
  critical_alert_count="$(grep -Fc 'alert severity=critical' "$case_root/log" || true)"
  [[ "$containment_alert_count" == 1 && "$critical_alert_count" == 1 \
    && "$(grep -Fxc 'resume:app' "$case_root/log" || true)" == 1 ]] \
    || fail "monitor-loss did not emit the exact containment alert after one app resume"
  if grep -Eq 'event=(backup_cleanup_failed|backup_failed|backup_post_commit_failed)' \
    "$case_root/log"; then
    fail "monitor-loss emitted a generic cleanup or backup alert"
  fi

  assert_protected_entry monitor-loss "$case_root/stage" directory 700
  assert_protected_entry monitor-loss "$case_root/runtime" directory 700
  mapfile -t stage_entries < <(find -P "$case_root/stage" -mindepth 1 \
    -maxdepth 1 -printf '%p\n' | sort)
  [[ ${#stage_entries[@]} -eq 2 ]] \
    || fail "monitor-loss did not retain exactly two protected staging directories"
  for retained in "${stage_entries[@]}"; do
    basename="${retained##*/}"
    if [[ "$basename" =~ ^full\.[0-9]{8}T[0-9]{6}Z\.[A-Za-z0-9]{6}$ ]]; then
      [[ -z "$stage_dir" ]] || fail "monitor-loss retained duplicate full staging"
      stage_dir="$retained"
    elif [[ "$basename" =~ ^verify\.[0-9]{8}T[0-9]{6}Z\.[A-Za-z0-9]{6}$ ]]; then
      [[ -z "$verify_dir" ]] || fail "monitor-loss retained duplicate verify staging"
      verify_dir="$retained"
    else
      fail "monitor-loss retained an unexpected staging path: $basename"
    fi
  done
  [[ -n "$stage_dir" && -n "$verify_dir" ]] \
    || fail "monitor-loss omitted a protected staging directory"
  assert_protected_entry monitor-loss "$stage_dir" directory 700
  assert_protected_entry monitor-loss "$verify_dir" directory 700
  assert_exact_protected_names monitor-loss "$stage_dir" "${full_files[@]}"
  assert_exact_protected_names monitor-loss "$verify_dir"
  for retained in "${full_files[@]}"; do
    assert_protected_entry monitor-loss "$stage_dir/$retained" file 600
  done

  mapfile -t runtime_entries < <(find -P "$case_root/runtime" -mindepth 1 \
    -maxdepth 1 -printf '%p\n' | sort)
  [[ ${#runtime_entries[@]} -eq 1 ]] \
    || fail "monitor-loss did not retain exactly one protected runtime directory"
  ephemeral_dir="${runtime_entries[0]}"
  basename="${ephemeral_dir##*/}"
  [[ "$basename" =~ ^b\.[A-Za-z0-9]{6}$ ]] \
    || fail "monitor-loss retained an unexpected runtime path: $basename"
  assert_protected_entry monitor-loss "$ephemeral_dir" directory 700
  assert_exact_protected_names monitor-loss "$ephemeral_dir" \
    "${ephemeral_files[@]}"
  for retained in "${ephemeral_files[@]}"; do
    assert_protected_entry monitor-loss "$ephemeral_dir/$retained" file 600
  done
}

checkpoint_phase_id() {
  printf '%s' "$1" | sha256sum | awk '{print $1}'
}

assert_normal_checkpoint_pair() {
  local label="$1" case_root="$2" sequence="$3"
  local emitted="$case_root/event-monitor/emitted-bytes" phase id action count
  local expected_token
  phase="checkpoint-$sequence"
  id="$(checkpoint_phase_id "$phase")"
  [[ -f "$emitted" ]] || fail "$label omitted the emitted-byte mirror"
  expected_token="$(awk -F'|' '
    $1 == "create" && $3 == "backup-monitor" && $6 == "start" { print $5; exit }
  ' "$emitted")"
  [[ "$expected_token" =~ ^[A-Za-z0-9.-]+$ ]] \
    || fail "$label omitted its authenticated start token"
  for action in create destroy; do
    count="$(awk -F'|' -v action="$action" -v id="$id" -v phase="$phase" \
      -v token="$expected_token" '
      $1 == action && $2 == id && $3 == "backup-monitor" \
        && $5 == token && $6 == phase { count += 1 }
      END { print count + 0 }
    ' "$emitted")"
    [[ "$count" == 1 ]] \
      || fail "$label did not emit exactly one normal $action $phase record"
  done
}

assert_no_normal_checkpoint_create() {
  local label="$1" case_root="$2" sequence="$3"
  local emitted="$case_root/event-monitor/emitted-bytes" phase id count
  phase="checkpoint-$sequence"
  id="$(checkpoint_phase_id "$phase")"
  [[ -f "$emitted" ]] || fail "$label omitted the emitted-byte mirror"
  count="$(awk -F'|' -v id="$id" -v phase="$phase" '
    $1 == "create" && $2 == id && $3 == "backup-monitor" && $6 == phase { count += 1 }
    END { print count + 0 }
  ' "$emitted")"
  [[ "$count" == 0 ]] \
    || fail "$label crossed its expected checkpoint failure bound"
}

assert_checkpoint_failure_specific() {
  local label="$1" expect_resume="$2" expected_error="$3"
  local highest_checkpoint="$4" case_root sequence
  shift 4
  assert_precommit_failure "$label" "$expect_resume" "$@"
  case_root="$last_precommit_failure_case"
  grep -Fq "fatal: $expected_error" "$case_root/log" \
    || {
      sed -n '1,160p' "$case_root/log" >&2
      fail "$label did not fail at the expected checkpoint audit stage"
    }
  for ((sequence = 1; sequence <= highest_checkpoint; sequence += 1)); do
    assert_normal_checkpoint_pair "$label" "$case_root" "$sequence"
  done
  assert_no_normal_checkpoint_create "$label" "$case_root" \
    "$((highest_checkpoint + 1))"
  if grep -Eq 'backup_monitor_containment_failed|backup_cleanup_failed' \
    "$case_root/log"; then
    sed -n '1,160p' "$case_root/log" >&2
    fail "$label checkpoint rejection was masked by containment cleanup"
  fi
}

assert_checkpoint_boundary_binding() {
  local label="$1" case_root="$2" audit_index="$3" phase="$4"
  local emitted_boundary_file audit_boundary_file emitted boundary_byte
  emitted_boundary_file="$case_root/event-monitor/emitted-$phase-boundary"
  audit_boundary_file="$case_root/event-monitor/audit-$audit_index-boundary"
  [[ -s "$emitted_boundary_file" && -s "$audit_boundary_file" ]] \
    || fail "$label omitted its emitted or audited $phase boundary"
  emitted="$(<"$emitted_boundary_file")"
  [[ "$emitted" =~ ^[1-9][0-9]*$ \
    && "$(<"$audit_boundary_file")" == "$emitted" ]] \
    || fail "$label did not audit the exact exclusive $phase boundary"
  boundary_byte="$(dd if="$case_root/event-monitor/emitted-bytes" bs=1 \
    skip=$((emitted - 1)) count=1 status=none \
    | od -An -t u1 | tr -d '[:space:]')"
  [[ "$boundary_byte" == 10 ]] \
    || fail "$label checkpoint boundary did not end in a complete newline"
}

run_checkpoint_success_case() {
  local label="$1" case_root="$2" controller_status=0
  shift 2
  /usr/bin/timeout --kill-after=5s 120s \
    /usr/bin/env PATH="$work/bin:$PATH" \
    TEST_RUNNING_STATE="$case_root/running-state" \
    BACKUP_CONFIG_FILE="$case_root/backup.env" "$@" \
    bash "$backup_controller" \
    >"$case_root/stdout" 2>"$case_root/log" || controller_status=$?
  if ((controller_status != 0)); then
    sed -n '1,160p' "$case_root/log" >&2
    if ((controller_status == 124 || controller_status == 137)); then
      fail "$label exceeded its 120s wall timeout"
    fi
    fail "$label rejected valid immutable event checkpoints"
  fi
}

assert_torn_checkpoint_case() {
  assert_checkpoint_failure_specific event-checkpoint-torn-post-boundary \
    true 'quiesced backup transaction failed: captured mutator stop lifecycle failed closed' 2 \
    TEST_CHECKPOINT_SCENARIO=torn-post-boundary \
    TEST_EVENT_REPO_ROOT="$fixture_repo"
  [[ -s "$last_precommit_failure_case/event-monitor/raw-no-lf-observed" \
    && -s "$last_precommit_failure_case/event-monitor/raw-lf-observed" ]] \
    || fail "torn event did not pass one boundary then complete before the next"
  assert_checkpoint_boundary_binding event-checkpoint-torn-post-boundary \
    "$last_precommit_failure_case" 1 checkpoint-1
  torn_boundary="$(<"$last_precommit_failure_case/event-monitor/emitted-checkpoint-1-boundary")"
  torn_no_lf_size="$(<"$last_precommit_failure_case/event-monitor/raw-no-lf-size")"
  torn_lf_size="$(<"$last_precommit_failure_case/event-monitor/raw-lf-size")"
  torn_second_boundary="$(<"$last_precommit_failure_case/event-monitor/audit-2-boundary")"
  ((torn_boundary < torn_no_lf_size \
    && torn_no_lf_size < torn_lf_size \
    && torn_lf_size <= torn_second_boundary)) \
    || fail "torn event was not partial after audit-1 and complete before audit-2"
  torn_partial_byte="$(dd if="$last_precommit_failure_case/event-monitor/emitted-bytes" \
    bs=1 skip=$((torn_no_lf_size - 1)) count=1 status=none \
    | od -An -t u1 | tr -d '[:space:]')"
  torn_completed_byte="$(dd if="$last_precommit_failure_case/event-monitor/emitted-bytes" \
    bs=1 skip=$((torn_lf_size - 1)) count=1 status=none \
    | od -An -t u1 | tr -d '[:space:]')"
  [[ "$torn_partial_byte" != 10 && "$torn_completed_byte" == 10 ]] \
    || fail "torn event newline transition was not byte-exact"
}

assert_exact_short_wait_fixture() {
  local label="$1" case_root="$2"
  local short_wait_invocations exact_destroy_record decoy_record provenance
  local action container_id service event_repo token phase event_signal exit_code extra
  local expected_checkpoint_one_id expected_checkpoint_two_id expected_decoy
  short_wait_invocations="$case_root/event-monitor/event-wait-short-invocations"
  exact_destroy_record="$case_root/event-monitor/checkpoint-1-destroy-record"
  decoy_record="$case_root/event-monitor/event-wait-short-checkpoint-2-decoy"
  provenance="$case_root/event-monitor/event-wait-short-managed-provenance"
  [[ -s "$short_wait_invocations" && -s "$exact_destroy_record" \
    && -s "$decoy_record" && -s "$provenance" \
    && -s "$case_root/event-monitor/event-wait-short-decoy-completed" \
    && ! -e "$case_root/event-monitor/event-wait-short-decoy-shortened" ]] \
    || fail "$label omitted exact managed-deadline or decoy provenance"
  [[ "$(wc -l <"$short_wait_invocations" | tr -d ' ')" == 1 ]] \
    || fail "$label shortened more than one event-wait invocation"
  cmp -s -- "$short_wait_invocations" "$exact_destroy_record" \
    || fail "$label did not shorten the exact fixture checkpoint-1 destroy wait"
  IFS='|' read -r action container_id service event_repo token phase \
    event_signal exit_code extra <"$exact_destroy_record"
  expected_checkpoint_one_id="$(checkpoint_phase_id checkpoint-1)"
  [[ -z "${extra:-}" && "$action" == destroy \
    && "$container_id" == "$expected_checkpoint_one_id" \
    && "$service" == backup-monitor && "$event_repo" == "$fixture_repo" \
    && "$token" =~ ^[A-Za-z0-9.-]+$ && "$phase" == checkpoint-1 \
    && -z "$event_signal" && -z "$exit_code" ]] \
    || fail "$label recorded a noncanonical fixture checkpoint-1 destroy"
  expected_checkpoint_two_id="$(checkpoint_phase_id checkpoint-2)"
  expected_decoy="destroy|$expected_checkpoint_two_id|backup-monitor|$event_repo|$token|checkpoint-2||"
  [[ "$(<"$decoy_record")" == "$expected_decoy" ]] \
    || fail "$label checkpoint-2 destroy decoy lost exact fixture provenance"
  grep -Fxq \
    'run-managed-deadline.py|expected-parent|no-control|bash|-c|event-wait|argc=11|max-bytes=1048576|max-lines=4096' \
    "$provenance" \
    || fail "$label did not prove exact nested managed-deadline argv"
}

assert_checkpoint_wait_cases() {
  local checkpoint_short_wait_started checkpoint_short_wait_elapsed wait_scenario
  checkpoint_short_wait_started="$SECONDS"
  assert_precommit_failure event-checkpoint-destroy-no-lf false \
    TEST_CHECKPOINT_SCENARIO=destroy-no-lf TEST_EVENT_WAIT_SHORT=1 \
    TEST_EVENT_REPO_ROOT="$fixture_repo"
  checkpoint_short_wait_elapsed=$((SECONDS - checkpoint_short_wait_started))
  [[ ! -e "$last_precommit_failure_case/event-monitor/event-wait-short-decoy-shortened" ]] \
    || fail "checkpoint-2 destroy decoy was incorrectly shortened"
  [[ -s "$last_precommit_failure_case/event-monitor/raw-no-lf-observed" \
    && -s "$last_precommit_failure_case/event-monitor/destroy-no-lf-injected" \
    && -s "$last_precommit_failure_case/event-monitor/event-wait-short-started" ]] \
    || fail "non-newline checkpoint destroy fixture did not reach the monitor"
  assert_exact_short_wait_fixture non-newline-checkpoint-destroy \
    "$last_precommit_failure_case"
  ((checkpoint_short_wait_elapsed <= 30)) \
    || fail "non-newline checkpoint wait exceeded its bounded wall time"
  [[ ! -e "$last_precommit_failure_case/event-monitor/audit-invocation-count" ]] \
    || fail "non-newline checkpoint destroy reached the event audit"

  for wait_scenario in wait-substring wait-duplicate; do
    checkpoint_short_wait_started="$SECONDS"
    assert_precommit_failure "event-checkpoint-$wait_scenario" false \
      TEST_CHECKPOINT_SCENARIO="$wait_scenario" TEST_EVENT_WAIT_SHORT=1 \
      TEST_EVENT_REPO_ROOT="$fixture_repo"
    checkpoint_short_wait_elapsed=$((SECONDS - checkpoint_short_wait_started))
    [[ ! -e "$last_precommit_failure_case/event-monitor/event-wait-short-decoy-shortened" ]] \
      || fail "$wait_scenario checkpoint-2 destroy decoy was incorrectly shortened"
    [[ -s "$last_precommit_failure_case/event-monitor/$wait_scenario-injected" \
      && -s "$last_precommit_failure_case/event-monitor/event-wait-short-started" ]] \
      || fail "$wait_scenario checkpoint wait fixture was not observed"
    assert_exact_short_wait_fixture "$wait_scenario" \
      "$last_precommit_failure_case"
    [[ ! -e "$last_precommit_failure_case/event-monitor/audit-invocation-count" ]] \
      || fail "$wait_scenario checkpoint wait reached the event audit"
    ((checkpoint_short_wait_elapsed <= 30)) \
      || fail "$wait_scenario checkpoint wait exceeded its bounded wall time"
  done
}

assert_checkpoint_close_cases() {
  local closed_tail_case closed_boundary closed_emitted_bytes
  local closed_pre_boundary_case
  closed_tail_case="$(make_backup_case publication-closed-tail-after-boundary)"
  run_checkpoint_success_case closed-tail-after-boundary "$closed_tail_case" \
    TEST_CHECKPOINT_SCENARIO=closed-tail-post-boundary \
    TEST_REQUIRE_CLOSED_DRAIN_MARKER=1 TEST_EVENT_REPO_ROOT="$fixture_repo"
  [[ -s "$closed_tail_case/event-monitor/closed-drain-wait-ready" \
    && -s "$closed_tail_case/event-monitor/closed-drain-tail-observed" \
    && ! -e "$closed_tail_case/event-monitor/closed-audit-before-drain" \
    && "$(<"$closed_tail_case/event-monitor/audit-5-state")" == closed ]] \
    || fail "closed audit did not run after the supervisor drain tail"
  assert_checkpoint_boundary_binding closed-tail-after-boundary \
    "$closed_tail_case" 5 end
  closed_boundary="$(<"$closed_tail_case/event-monitor/emitted-end-boundary")"
  closed_emitted_bytes="$(wc -c <"$closed_tail_case/event-monitor/emitted-bytes" | tr -d ' ')"
  ((closed_emitted_bytes > closed_boundary)) \
    || fail "closed drain tail was not emitted after captured end B"

  assert_checkpoint_failure_specific closed-tail-before-boundary true \
    'quiesced backup transaction failed: release-scoped Docker event continuity failed after marker durability' 4 \
    TEST_CHECKPOINT_SCENARIO=closed-tail-pre-boundary \
    TEST_EVENT_REPO_ROOT="$fixture_repo"
  closed_pre_boundary_case="$last_precommit_failure_case"
  [[ -s "$closed_pre_boundary_case/event-monitor/raw-full-observed" \
    && "$(<"$closed_pre_boundary_case/event-monitor/audit-5-state")" == closed ]] \
    || fail "pre-boundary closed-tail fixture did not reach the closed audit"
  assert_checkpoint_boundary_binding closed-tail-before-boundary \
    "$closed_pre_boundary_case" 5 end
}

assert_checkpoint_emitted_mutation_case() {
  assert_checkpoint_failure_specific event-checkpoint-emitted-wrong-token false \
    'release-scoped Docker event continuity failed during identity capture' 1 \
    TEST_CHECKPOINT_RECORD_MUTATION=wrong-token \
    TEST_EVENT_REPO_ROOT="$fixture_repo"
  [[ -s "$last_precommit_failure_case/event-monitor/parser-fixture-observed" ]] \
    || fail "emitted-byte parser mutation did not reach the monitor"
}

assert_budget_exhaustion_resumes() {
  local budget_case
  budget_case="$(make_backup_case publication-budget-exhaustion)"
  cp "$budget_case/backups/state/local-last-success.env" "$budget_case/old-marker"
  if PATH="$work/bin:$PATH" TEST_TIMEOUT_EXHAUST=1 \
    TEST_TIMEOUT_STATE="$budget_case/timeout-state" \
    TEST_RUNNING_STATE="$budget_case/running-state" \
    BACKUP_CONFIG_FILE="$budget_case/backup.env" \
    bash "$backup_controller" \
    >"$budget_case/stdout" 2>"$budget_case/log"; then
    fail "backup succeeded after the quiesce deadline was exhausted"
  fi
  cmp -s "$budget_case/old-marker" \
    "$budget_case/backups/state/local-last-success.env" \
    || fail "budget exhaustion changed the previous success marker"
  grep -Fq 'resume:app' "$budget_case/log" \
    || fail "budget exhaustion did not immediately attempt resume"
  if grep -Eq 'phase=(files_published|marker_committed|pruning|complete)' \
    "$budget_case/log"; then
    fail "budget exhaustion continued into publication"
  fi
  [[ "$(find "$budget_case/backups/full" -maxdepth 1 -type f \
    -name 'learncoding-full-*.age' | wc -l | tr -d ' ')" == 1 ]]
}

assert_preflight_failure() {
  local label="$1" case_root="$2" archive_count
  shift 2
  cp "$case_root/backups/state/local-last-success.env" "$case_root/old-marker"
  if /usr/bin/env PATH="$work/bin:$PATH" \
    TEST_RUNNING_STATE="$case_root/running-state" \
    BACKUP_CONFIG_FILE="$case_root/backup.env" "$@" \
    bash "$backup_controller" \
    >"$case_root/stdout" 2>"$case_root/log"; then
    fail "backup accepted unsafe preflight fixture: $label"
  fi
  cmp -s "$case_root/old-marker" "$case_root/backups/state/local-last-success.env" \
    || fail "$label preflight failure changed the previous success marker"
  archive_count="$(find "$case_root/backups/full" -maxdepth 1 -type f \
    -name 'learncoding-full-*.tar.gz.age' | wc -l | tr -d ' ')"
  [[ "$archive_count" == 1 ]] || fail "$label preflight failure left a candidate final archive"
  [[ -z "$(find "$case_root/backups" -type f -name '.*.tmp.*' -print -quit)" ]] \
    || fail "$label preflight failure left a publication temporary"
  [[ -z "$(find "$case_root/stage" "$case_root/runtime" -mindepth 1 -print -quit)" ]] \
    || fail "$label preflight failure left plaintext or ephemeral key material"
  if grep -Eq '(^|[[:space:]])(quiesce|dump)$|phase=(quiesced|dump_complete|marker_committed|pruning|complete)' \
    "$case_root/log"; then
    fail "$label preflight failure crossed the snapshot/publication boundary"
  fi
}

assert_rejected_directory_was_not_chmodded() {
  local label="$1" case_root="$2" watched_path="$3" mutation_file="$4"
  shift 4
  if /usr/bin/env PATH="$work/bin:$PATH" \
    TEST_WATCH_CHMOD_PATH="$watched_path" \
    TEST_CHMOD_MUTATION_FILE="$mutation_file" \
    TEST_RUNNING_STATE="$case_root/running-state" \
    BACKUP_CONFIG_FILE="$case_root/backup.env" "$@" \
    bash "$backup_controller" \
    >"$case_root/stdout" 2>"$case_root/log"; then
    fail "backup accepted unsafe directory fixture: $label"
  fi
  [[ ! -e "$mutation_file" ]] \
    || fail "$label was chmodded before its ownership/canonical safety was validated"
  if grep -Eq '(^|[[:space:]])(quiesce|dump)$|phase=(quiesced|dump_complete|marker_committed|pruning|complete)' \
    "$case_root/log"; then
    fail "$label crossed the snapshot/publication boundary"
  fi
}

assert_incremental_stage_cleanup() {
  local label="$1" case_root
  shift
  case_root="$(make_backup_case "publication-$label")"
  if /usr/bin/env PATH="$work/bin:$PATH" \
    TEST_STAGE_MKTEMP_STATE="$case_root/stage-mktemp-state" \
    TEST_RUNNING_STATE="$case_root/running-state" \
    BACKUP_CONFIG_FILE="$case_root/backup.env" "$@" \
    bash "$backup_controller" \
    >"$case_root/stdout" 2>"$case_root/log"; then
    fail "backup succeeded after injected $label staging failure"
  fi
  [[ -z "$(find "$case_root/stage" "$case_root/runtime" \
    -mindepth 1 -print -quit)" ]] \
    || fail "$label staging failure left an incrementally created directory"
  if grep -Eq '(^|[[:space:]])(quiesce|dump)$|phase=(quiesced|dump_complete|files_published|marker_committed|pruning|complete)' \
    "$case_root/log"; then
    fail "$label staging failure crossed the snapshot/publication boundary"
  fi
}

if [[ "$test_group" == minor-staging-cleanup ]]; then
  assert_incremental_stage_cleanup stage-second-create \
    TEST_STAGE_MKTEMP_FAIL_AT=2
  assert_incremental_stage_cleanup stage-chmod TEST_STAGE_CHMOD_FAIL=1
  echo "backup-publication-minor-staging-cleanup-tests-ok"
  exit 0
fi

if [[ "$test_group" == all || "$test_group" == immutable-event-checkpoints \
  || "$test_group" == immutable-event-checkpoint-parser \
  || "$test_group" == event-parser-boundaries ]]; then
  checkpoint_parser="$work/checkpoint-event-audit-parser.sh"
  wait_parser="$work/checkpoint-event-wait-parser.sh"
  parser_caps="$work/checkpoint-event-parser-caps"
  node - "$backup_controller" "$checkpoint_parser" "$wait_parser" \
    "$parser_caps" <<'EOF' \
    || fail "current event monitor parsers or caps could not be extracted"
const fs = require('node:fs');
const source = fs.readFileSync(process.argv[2], 'utf8').replaceAll('\r\n', '\n');

function extractParser(functionName, commandLabel, requiredFragments) {
  const functionStart = source.indexOf(`${functionName}() {`);
  const commandMarker = "  run_deadline bash -c '\n";
  const commandStart = source.indexOf(commandMarker, functionStart);
  const bodyStart = commandStart + commandMarker.length;
  const commandEnd = source.indexOf(`\n  ' ${commandLabel} `, bodyStart);
  if (functionStart < 0 || commandStart < functionStart || commandEnd < bodyStart) {
    throw new Error(`could not locate ${functionName} embedded parser`);
  }
  const body = source.slice(bodyStart, commandEnd).replaceAll("'\\''", "'");
  if (!requiredFragments.every((fragment) => body.includes(fragment))) {
    throw new Error(`${functionName} parser identity changed`);
  }
  return body;
}

const auditBody = extractParser(
  'audit_event_monitor',
  'event-audit',
  ['checkpoint_open=0', 'done <"$snapshot"'],
);
const waitBody = extractParser(
  'wait_for_event_monitor_line',
  'event-wait',
  ['while :; do', 'done <"$snapshot"'],
);
const auditInvocationStart = source.indexOf(
  "  ' event-audit ",
  source.indexOf('audit_event_monitor() {'),
);
const auditInvocationEnd = source.indexOf(
  '\n    || return 1',
  auditInvocationStart,
);
const auditInvocation = source.slice(auditInvocationStart, auditInvocationEnd);
const expectedAuditInvocation = [
  "  ' event-audit \"$event_monitor_output\" \"$snapshot\" \"$live_snapshot\" \\",
  '    "$audit_boundary" "$MAX_EVENT_LOG_BYTES" "$MAX_EVENT_LOG_LINES" \\',
  '    "$repo_real" "$event_monitor_token" "$expected_state" \\',
  '    "$MAX_CLAMAV_RESTART_EVENTS" "$expected_mutator_map" \\',
  '    "$quiesce_event_phase" "$expected_clamav_id" \\',
  '    "$event_checkpoint_sequence" \\',
].join('\n');
if (auditInvocation !== expectedAuditInvocation) {
  throw new Error('event audit production invocation wiring is not canonical');
}
const bytesMatch = source.match(/^readonly MAX_EVENT_LOG_BYTES=([0-9]+)$/m);
const linesMatch = source.match(/^readonly MAX_EVENT_LOG_LINES=([0-9]+)$/m);
if (!bytesMatch || !linesMatch) throw new Error('event parser caps are not canonical');
fs.writeFileSync(process.argv[3], `${auditBody}\n`, { mode: 0o700 });
fs.writeFileSync(process.argv[4], `${waitBody}\n`, { mode: 0o700 });
fs.writeFileSync(
  process.argv[5],
  `${bytesMatch[1]}\n${linesMatch[1]}\n`,
  { mode: 0o600 },
);
EOF
  mapfile -t parser_cap_values <"$parser_caps"
  [[ ${#parser_cap_values[@]} -eq 2 \
    && "${parser_cap_values[0]}" == 1048576 \
    && "${parser_cap_values[1]}" == 4096 ]] \
    || fail "event monitor parser caps are not exactly 1048576 bytes/4096 lines"
  parser_max_bytes="${parser_cap_values[0]}"
  parser_max_lines="${parser_cap_values[1]}"
  parser_repo=/release
  parser_token=20260717T010203Z.4242.aaaaaaaaaaaa
  parser_start_id=1111111111111111111111111111111111111111111111111111111111111111
  parser_open_id=2222222222222222222222222222222222222222222222222222222222222222
  parser_checkpoint_one=3333333333333333333333333333333333333333333333333333333333333333
  parser_checkpoint_two=4444444444444444444444444444444444444444444444444444444444444444
  parser_foreign_id=5555555555555555555555555555555555555555555555555555555555555555
  parser_mutator_map="$work/checkpoint-parser-mutators"
  : >"$parser_mutator_map"

  write_checkpoint_parser_log() {
    local label="$1"
    shift
    checkpoint_parser_log="$work/checkpoint-parser-$label.log"
    printf '%s\n' "$@" >"$checkpoint_parser_log"
  }

  run_checkpoint_parser() {
    local label="$1" log="$2" quiesce_phase="$3" expected_sequence="$4"
    local boundary snapshot live_snapshot
    boundary="$(wc -c <"$log" | tr -d ' ')"
    snapshot="$work/checkpoint-parser-$label.snapshot"
    live_snapshot="$work/checkpoint-parser-$label.live"
    /usr/bin/timeout --kill-after=1s 5s bash "$checkpoint_parser" \
      "$log" "$snapshot" "$live_snapshot" "$boundary" 1048576 4096 \
      "$parser_repo" "$parser_token" active 8 "$parser_mutator_map" \
      "$quiesce_phase" "" "$expected_sequence"
  }

  expect_checkpoint_parser_rejection() {
    local label="$1" quiesce_phase="$2" expected_sequence="$3"
    if run_checkpoint_parser "$label" "$checkpoint_parser_log" \
      "$quiesce_phase" "$expected_sequence"; then
      fail "immutable checkpoint parser accepted $label"
    fi
  }

  start_create="create|$parser_start_id|backup-monitor|$parser_repo|$parser_token|start||"
  start_destroy="destroy|$parser_start_id|backup-monitor|$parser_repo|$parser_token|start||"
  checkpoint_one_create="create|$parser_checkpoint_one|backup-monitor|$parser_repo|$parser_token|checkpoint-1||"
  checkpoint_one_destroy="destroy|$parser_checkpoint_one|backup-monitor|$parser_repo|$parser_token|checkpoint-1||"
  checkpoint_two_create="create|$parser_checkpoint_two|backup-monitor|$parser_repo|$parser_token|checkpoint-2||"
  checkpoint_two_destroy="destroy|$parser_checkpoint_two|backup-monitor|$parser_repo|$parser_token|checkpoint-2||"
  open_create="create|$parser_open_id|backup-monitor|$parser_repo|$parser_token|quiesce-open||"
  open_destroy="destroy|$parser_open_id|backup-monitor|$parser_repo|$parser_token|quiesce-open||"

  direct_parser_status=0
  direct_parser_error=""
  direct_parser_result=""
  direct_wait_expected="$checkpoint_one_destroy"
  direct_audit_close_id=6666666666666666666666666666666666666666666666666666666666666666
  direct_audit_clamav_id=7777777777777777777777777777777777777777777777777777777777777777

  assert_direct_parser_status() {
    local label="$1" expected_status="$2"
    if [[ "$direct_parser_status" != "$expected_status" ]]; then
      [[ ! -s "$direct_parser_error" ]] \
        || sed -n '1,80p' "$direct_parser_error" >&2
      fail "$label returned $direct_parser_status instead of $expected_status"
    fi
  }

  run_direct_wait_parser() {
    local label="$1" output="$2"
    local snapshot="$work/direct-wait-$label.snapshot"
    direct_parser_result="$work/direct-wait-$label.result"
    direct_parser_error="$work/direct-wait-$label.error"
    direct_parser_status=0
    /usr/bin/timeout --kill-after=1s 5s bash "$wait_parser" \
      "$output" "$direct_wait_expected" "$BASHPID" "$snapshot" \
      "$parser_max_bytes" "$parser_max_lines" 0 \
      >"$direct_parser_result" 2>"$direct_parser_error" \
      || direct_parser_status=$?
  }

  write_direct_wait_line_fixture() {
    local label="$1" total_lines="$2" filler_lines
    direct_wait_output="$work/direct-wait-$label.log"
    filler_lines=$((total_lines - 1))
    awk -v count="$filler_lines" \
      'BEGIN { for (line = 0; line < count; line += 1) print "x" }' \
      >"$direct_wait_output"
    printf '%s\n' "$direct_wait_expected" >>"$direct_wait_output"
    [[ "$(wc -l <"$direct_wait_output" | tr -d ' ')" == "$total_lines" ]] \
      || fail "$label did not create an exact complete-line wait fixture"
  }

  write_direct_wait_byte_fixture() {
    local label="$1" target_bytes="$2" current_bytes filler_bytes
    direct_wait_output="$work/direct-wait-$label.log"
    printf '%s\n' "$direct_wait_expected" >"$direct_wait_output"
    current_bytes="$(wc -c <"$direct_wait_output" | tr -d ' ')"
    filler_bytes=$((target_bytes - current_bytes))
    ((filler_bytes >= 1)) || fail "$label has no room for a complete filler line"
    head -c "$((filler_bytes - 1))" /dev/zero \
      | tr '\0' x >>"$direct_wait_output"
    printf '\n' >>"$direct_wait_output"
    [[ "$(wc -c <"$direct_wait_output" | tr -d ' ')" == "$target_bytes" \
      && "$(wc -l <"$direct_wait_output" | tr -d ' ')" == 2 ]] \
      || fail "$label did not create an exact complete-byte wait fixture"
  }

  run_direct_audit_parser() {
    local label="$1" output="$2" mutator_map="$3" quiesce_phase="$4"
    local expected_clamav_id="$5" boundary snapshot live_snapshot
    boundary="$(wc -c <"$output" | tr -d ' ')"
    snapshot="$work/direct-audit-$label.snapshot"
    live_snapshot="$work/direct-audit-$label.live"
    direct_parser_result="$work/direct-audit-$label.result"
    direct_parser_error="$work/direct-audit-$label.error"
    direct_parser_status=0
    /usr/bin/timeout --kill-after=1s 5s bash "$checkpoint_parser" \
      "$output" "$snapshot" "$live_snapshot" "$boundary" \
      "$parser_max_bytes" "$parser_max_lines" "$parser_repo" \
      "$parser_token" active 8 "$mutator_map" "$quiesce_phase" \
      "$expected_clamav_id" 1 \
      >"$direct_parser_result" 2>"$direct_parser_error" \
      || direct_parser_status=$?
  }

  write_direct_audit_line_fixture() {
    local label="$1" mutator_count="$2" include_clamav="$3"
    local expected_lines="$4" service_padding_length="${5:-0}"
    local extra_padded_services="${6:-0}" clamav_exit_code="${7:-0}"
    local mutator_index mutator_id mutator_service service_padding
    printf -v service_padding '%*s' "$service_padding_length" ''
    service_padding="${service_padding// /x}"
    direct_audit_output="$work/direct-audit-$label.log"
    direct_audit_mutator_map="$work/direct-audit-$label.mutators"
    direct_audit_expected_clamav_id=""
    {
      printf '%s\n' "$start_create" "$start_destroy" \
        "$open_create" "$open_destroy"
      for ((mutator_index = 1; mutator_index <= mutator_count; mutator_index += 1)); do
        printf -v mutator_id '%064x' "$((1000 + mutator_index))"
        mutator_service="worker-$mutator_index$service_padding"
        ((mutator_index > extra_padded_services)) || mutator_service+='x'
        printf '%s\n' "$mutator_service|$mutator_id" >&3
        printf '%s\n' \
          "kill|$mutator_id|$mutator_service|$parser_repo|||15|" \
          "die|$mutator_id|$mutator_service|$parser_repo||||0" \
          "stop|$mutator_id|$mutator_service|$parser_repo||||"
      done
      if [[ "$include_clamav" == true ]]; then
        direct_audit_expected_clamav_id="$direct_audit_clamav_id"
        printf '%s\n' \
          "stop|$direct_audit_clamav_id|clamav|$parser_repo||||" \
          "kill|$direct_audit_clamav_id|clamav|$parser_repo|||15|" \
          "die|$direct_audit_clamav_id|clamav|$parser_repo||||$clamav_exit_code" \
          "start|$direct_audit_clamav_id|clamav|$parser_repo||||" \
          "health_status: healthy|$direct_audit_clamav_id|clamav|$parser_repo||||"
      fi
      printf '%s\n' \
        "create|$direct_audit_close_id|backup-monitor|$parser_repo|$parser_token|quiesce-close||" \
        "destroy|$direct_audit_close_id|backup-monitor|$parser_repo|$parser_token|quiesce-close||" \
        "$checkpoint_one_create" "$checkpoint_one_destroy"
    } 3>"$direct_audit_mutator_map" >"$direct_audit_output"
    [[ "$(wc -l <"$direct_audit_output" | tr -d ' ')" == "$expected_lines" ]] \
      || fail "$label did not create an exact semantic audit line fixture"
  }

  write_direct_audit_byte_fixture() {
    local label="$1" target_bytes="$2" base_bytes padding_bytes
    local padding_per_service extra_padded_services exit_extra clamav_exit_code
    write_direct_audit_line_fixture "$label-base" 1361 true 4096
    base_bytes="$(wc -c <"$direct_audit_output" | tr -d ' ')"
    padding_bytes=$((target_bytes - base_bytes))
    ((padding_bytes >= 0)) || fail "$label base audit fixture exceeded its byte target"
    padding_per_service=$((padding_bytes / (3 * 1361)))
    padding_bytes=$((padding_bytes - padding_per_service * 3 * 1361))
    extra_padded_services=$((padding_bytes / 3))
    exit_extra=$((padding_bytes % 3))
    printf -v clamav_exit_code '%*s' "$((exit_extra + 1))" ''
    clamav_exit_code="${clamav_exit_code// /7}"
    write_direct_audit_line_fixture "$label" 1361 true 4096 \
      "$padding_per_service" "$extra_padded_services" "$clamav_exit_code"
    [[ "$(wc -c <"$direct_audit_output" | tr -d ' ')" == "$target_bytes" \
      && "$(wc -l <"$direct_audit_output" | tr -d ' ')" == 4096 ]] \
      || fail "$label did not create an exact semantic audit byte fixture"
  }

  assert_audit_invocation_mutation_rejected() {
    local label="$1" original="$2" replacement="$3"
    local mutated_controller="$work/audit-invocation-$label.sh"
    local mutation_output="$work/audit-invocation-$label.output"
    local mutation_error="$work/audit-invocation-$label.error"
    local mutation_status=0
    node - "$backup_controller" "$mutated_controller" "$original" \
      "$replacement" <<'EOF' \
      || fail "$label audit invocation mutation could not be created"
const fs = require('node:fs');
const [sourcePath, destinationPath, original, replacement] = process.argv.slice(2);
const source = fs.readFileSync(sourcePath, 'utf8');
if (source.split(original).length !== 2) {
  throw new Error('audit invocation mutation target is not unique');
}
fs.writeFileSync(destinationPath, source.replace(original, replacement), {
  mode: 0o700,
});
EOF
    BACKUP_SCRIPT_UNDER_TEST="$mutated_controller" \
      BACKUP_PUBLICATION_TEST_GROUP=event-parser-boundaries \
      bash "$0" >"$mutation_output" 2>"$mutation_error" \
      || mutation_status=$?
    ((mutation_status != 0)) \
      || fail "$label audit invocation mutation was accepted"
    grep -Fq 'event audit production invocation wiring is not canonical' \
      "$mutation_error" \
      || fail "$label audit invocation mutation failed for the wrong reason"
  }

  if [[ "$test_group" == event-parser-boundaries ]]; then
    assert_audit_invocation_mutation_rejected swapped-audit-caps \
      '"$audit_boundary" "$MAX_EVENT_LOG_BYTES" "$MAX_EVENT_LOG_LINES"' \
      '"$audit_boundary" "$MAX_EVENT_LOG_LINES" "$MAX_EVENT_LOG_BYTES"'
    assert_audit_invocation_mutation_rejected literal-audit-byte-cap \
      '"$audit_boundary" "$MAX_EVENT_LOG_BYTES" "$MAX_EVENT_LOG_LINES"' \
      '"$audit_boundary" "1048576" "$MAX_EVENT_LOG_LINES"'
    write_direct_wait_line_fixture wait-lines-accepted 4096
    wait_lines_boundary="$(wc -c <"$direct_wait_output" | tr -d ' ')"
    run_direct_wait_parser wait-lines-accepted "$direct_wait_output"
    assert_direct_parser_status wait-lines-accepted 0
    [[ "$(tr -d '[:space:]' <"$direct_parser_result")" == "$wait_lines_boundary" ]] \
      || fail "wait parser did not accept all 4096 complete lines"

    write_direct_wait_line_fixture wait-lines-rejected 4097
    run_direct_wait_parser wait-lines-rejected "$direct_wait_output"
    assert_direct_parser_status wait-lines-rejected 77

    write_direct_wait_byte_fixture wait-bytes-accepted 1048576
    wait_expected_boundary="$(printf '%s\n' "$direct_wait_expected" \
      | wc -c | tr -d ' ')"
    run_direct_wait_parser wait-bytes-accepted "$direct_wait_output"
    assert_direct_parser_status wait-bytes-accepted 0
    [[ "$(tr -d '[:space:]' <"$direct_parser_result")" == "$wait_expected_boundary" ]] \
      || fail "wait parser did not accept exactly 1048576 live bytes"

    write_direct_wait_byte_fixture wait-bytes-rejected 1048577
    run_direct_wait_parser wait-bytes-rejected "$direct_wait_output"
    assert_direct_parser_status wait-bytes-rejected 72
    echo "backup-publication-event-wait-parser-boundaries-ok"

    write_direct_audit_line_fixture audit-lines-accepted 1361 true 4096
    run_direct_audit_parser audit-lines-accepted "$direct_audit_output" \
      "$direct_audit_mutator_map" 2 "$direct_audit_expected_clamav_id"
    assert_direct_parser_status audit-lines-accepted 0

    write_direct_audit_line_fixture audit-lines-rejected 1363 false 4097
    run_direct_audit_parser audit-lines-rejected "$direct_audit_output" \
      "$direct_audit_mutator_map" 2 "$direct_audit_expected_clamav_id"
    assert_direct_parser_status audit-lines-rejected 73

    write_direct_audit_byte_fixture audit-bytes-accepted 1048576
    run_direct_audit_parser audit-bytes-accepted "$direct_audit_output" \
      "$direct_audit_mutator_map" 2 "$direct_audit_expected_clamav_id"
    assert_direct_parser_status audit-bytes-accepted 0

    write_direct_audit_byte_fixture audit-bytes-rejected 1048577
    run_direct_audit_parser audit-bytes-rejected "$direct_audit_output" \
      "$direct_audit_mutator_map" 2 "$direct_audit_expected_clamav_id"
    assert_direct_parser_status audit-bytes-rejected 72
    echo "backup-publication-event-audit-parser-boundaries-ok"
    echo "backup-publication-event-parser-boundary-tests-ok"
    exit 0
  fi

  write_checkpoint_parser_log valid "$start_create" "$start_destroy" \
    "$checkpoint_one_create" "$checkpoint_one_destroy"
  run_checkpoint_parser valid "$checkpoint_parser_log" 0 1 \
    || fail "immutable checkpoint parser rejected its valid baseline"

  write_checkpoint_parser_log nested-structural "$start_create" "$start_destroy" \
    "$open_create" "$checkpoint_one_create" "$checkpoint_one_destroy" "$open_destroy"
  expect_checkpoint_parser_rejection nested-structural 1 1

  write_checkpoint_parser_log reused-structural-id "$start_create" "$start_destroy" \
    "create|$parser_start_id|backup-monitor|$parser_repo|$parser_token|checkpoint-1||" \
    "destroy|$parser_start_id|backup-monitor|$parser_repo|$parser_token|checkpoint-1||"
  expect_checkpoint_parser_rejection reused-structural-id 0 1

  write_checkpoint_parser_log reused-checkpoint-id "$start_create" "$start_destroy" \
    "$checkpoint_one_create" "$checkpoint_one_destroy" \
    "create|$parser_checkpoint_one|backup-monitor|$parser_repo|$parser_token|checkpoint-2||" \
    "destroy|$parser_checkpoint_one|backup-monitor|$parser_repo|$parser_token|checkpoint-2||"
  expect_checkpoint_parser_rejection reused-checkpoint-id 0 2

  write_checkpoint_parser_log blank-complete-record "$start_create" "$start_destroy" \
    "" "$checkpoint_one_create" "$checkpoint_one_destroy"
  expect_checkpoint_parser_rejection blank-complete-record 0 1

  write_checkpoint_parser_log duplicate-number "$start_create" "$start_destroy" \
    "$checkpoint_one_create" "$checkpoint_one_destroy" \
    "create|$parser_checkpoint_two|backup-monitor|$parser_repo|$parser_token|checkpoint-1||" \
    "destroy|$parser_checkpoint_two|backup-monitor|$parser_repo|$parser_token|checkpoint-1||"
  expect_checkpoint_parser_rejection duplicate-number 0 2

  write_checkpoint_parser_log skipped-number "$start_create" "$start_destroy" \
    "$checkpoint_two_create" "$checkpoint_two_destroy"
  expect_checkpoint_parser_rejection skipped-number 0 1

  write_checkpoint_parser_log out-of-order-number "$start_create" "$start_destroy" \
    "$checkpoint_one_create" "$checkpoint_one_destroy" \
    "create|$parser_checkpoint_two|backup-monitor|$parser_repo|$parser_token|checkpoint-3||" \
    "destroy|$parser_checkpoint_two|backup-monitor|$parser_repo|$parser_token|checkpoint-3||"
  expect_checkpoint_parser_rejection out-of-order-number 0 2

  for malformed_phase in checkpoint-0 checkpoint-01; do
    write_checkpoint_parser_log "$malformed_phase" "$start_create" "$start_destroy" \
      "create|$parser_checkpoint_one|backup-monitor|$parser_repo|$parser_token|$malformed_phase||" \
      "destroy|$parser_checkpoint_one|backup-monitor|$parser_repo|$parser_token|$malformed_phase||"
    expect_checkpoint_parser_rejection "$malformed_phase" 0 1
  done

  write_checkpoint_parser_log destroy-before-create "$start_create" "$start_destroy" \
    "$checkpoint_one_destroy" "$checkpoint_one_create"
  expect_checkpoint_parser_rejection destroy-before-create 0 1

  write_checkpoint_parser_log overlapping-create "$start_create" "$start_destroy" \
    "$checkpoint_one_create" "$checkpoint_two_create" \
    "$checkpoint_one_destroy" "$checkpoint_two_destroy"
  expect_checkpoint_parser_rejection overlapping-create 0 2

  write_checkpoint_parser_log mismatched-destroy-id "$start_create" "$start_destroy" \
    "$checkpoint_one_create" \
    "destroy|$parser_foreign_id|backup-monitor|$parser_repo|$parser_token|checkpoint-1||"
  expect_checkpoint_parser_rejection mismatched-destroy-id 0 1

  declare -a malformed_checkpoint_records=(
    "destroy|$parser_checkpoint_one|backup-monitor|$parser_repo|wrong.token|checkpoint-1||"
    "destroy|$parser_checkpoint_one|backup-monitor|/wrong/repository|$parser_token|checkpoint-1||"
    "destroy|$parser_checkpoint_one|backup-monitor-other|$parser_repo|$parser_token|checkpoint-1||"
    "destroy|$parser_checkpoint_one|backup-monitor|$parser_repo|$parser_token|checkpoint-1|15|"
    "destroy|$parser_checkpoint_one|backup-monitor|$parser_repo|$parser_token|checkpoint-1|||extra"
  )
  declare -a malformed_checkpoint_labels=(
    wrong-token wrong-repo wrong-service signal-field extra-field
  )
  for ((parser_index = 0; parser_index < ${#malformed_checkpoint_records[@]}; parser_index += 1)); do
    parser_label="${malformed_checkpoint_labels[$parser_index]}"
    write_checkpoint_parser_log "$parser_label" "$start_create" "$start_destroy" \
      "$checkpoint_one_create" "${malformed_checkpoint_records[$parser_index]}" \
      "$checkpoint_one_destroy"
    expect_checkpoint_parser_rejection "$parser_label" 0 1
  done

  write_checkpoint_parser_log exact-prefix "$start_create" "$start_destroy" \
    "$checkpoint_one_create" "$checkpoint_one_destroy"
  exact_prefix_boundary="$(wc -c <"$checkpoint_parser_log" | tr -d ' ')"
  printf '%s\n' \
    "kill|$parser_foreign_id|app|$parser_repo|||15|" \
    >>"$checkpoint_parser_log"
  checkpoint_parser_snapshot="$work/checkpoint-parser-exact-prefix.snapshot"
  checkpoint_parser_live="$work/checkpoint-parser-exact-prefix.live"
  /usr/bin/timeout --kill-after=1s 5s bash "$checkpoint_parser" \
    "$checkpoint_parser_log" "$checkpoint_parser_snapshot" \
    "$checkpoint_parser_live" "$exact_prefix_boundary" 1048576 4096 \
    "$parser_repo" "$parser_token" active 8 "$parser_mutator_map" 0 "" 1 \
    || fail "immutable checkpoint parser did not honor exact exclusive B"

  write_checkpoint_parser_log missing-final-lf "$start_create" "$start_destroy" \
    "$checkpoint_one_create"
  printf '%s' "$checkpoint_one_destroy" >>"$checkpoint_parser_log"
  expect_checkpoint_parser_rejection missing-final-lf 0 1

  write_checkpoint_parser_log oversized-live-tail "$start_create" "$start_destroy" \
    "$checkpoint_one_create" "$checkpoint_one_destroy"
  oversized_prefix_boundary="$(wc -c <"$checkpoint_parser_log" | tr -d ' ')"
  head -c 1048577 /dev/zero | tr '\0' x >>"$checkpoint_parser_log"
  checkpoint_parser_snapshot="$work/checkpoint-parser-oversized.snapshot"
  checkpoint_parser_live="$work/checkpoint-parser-oversized.live"
  if /usr/bin/timeout --kill-after=1s 5s bash "$checkpoint_parser" \
    "$checkpoint_parser_log" "$checkpoint_parser_snapshot" \
    "$checkpoint_parser_live" "$oversized_prefix_boundary" 1048576 4096 \
    "$parser_repo" "$parser_token" active 8 "$parser_mutator_map" 0 "" 1; then
    fail "immutable checkpoint parser ignored its independent whole-live cap"
  fi

  if [[ "$test_group" == immutable-event-checkpoint-parser ]]; then
    echo "backup-publication-immutable-event-checkpoint-parser-tests-ok"
    exit 0
  fi
fi

if [[ "$test_group" == all || "$test_group" == immutable-event-checkpoints ]]; then
  checkpoint_test_only="${BACKUP_CHECKPOINT_TEST_ONLY:-all}"
  case "$checkpoint_test_only" in
    all) ;;
    torn-post-boundary)
      assert_torn_checkpoint_case
      echo "backup-publication-immutable-event-checkpoint-torn-tests-ok"
      exit 0
      ;;
    wait-guards)
      assert_checkpoint_wait_cases
      echo "backup-publication-immutable-event-checkpoint-wait-tests-ok"
      exit 0
      ;;
    close-boundary)
      assert_checkpoint_close_cases
      echo "backup-publication-immutable-event-checkpoint-close-tests-ok"
      exit 0
      ;;
    emitted-mutation)
      assert_checkpoint_emitted_mutation_case
      echo "backup-publication-immutable-event-checkpoint-emitted-mutation-tests-ok"
      exit 0
      ;;
    *) fail "unknown immutable checkpoint test filter: $checkpoint_test_only" ;;
  esac
  checkpoint_success_case="$(make_backup_case publication-immutable-checkpoints)"
  cp -- "$checkpoint_success_case/backups/state/local-last-success.env" \
    "$checkpoint_success_case/old-marker"
  run_checkpoint_success_case immutable-checkpoint-baseline \
    "$checkpoint_success_case" \
    TEST_CHECKPOINT_SCENARIO=valid TEST_EVENT_REPO_ROOT="$fixture_repo"
  node - "$checkpoint_success_case/event-monitor/emitted-bytes" <<'EOF' \
    || fail "valid checkpoint sentinels were not unique, ordered, and complete"
const fs = require('node:fs');
const lines = fs.readFileSync(process.argv[2], 'utf8').trimEnd().split('\n');
const records = lines.map((line) => line.split('|'));
const checkpoints = lines
  .map((line) => line.split('|'))
  .filter((fields) => fields[2] === 'backup-monitor'
    && /^checkpoint-[1-9][0-9]*$/.test(fields[5]));
if (checkpoints.length !== 8) process.exit(1);
const ids = new Set();
for (let sequence = 1; sequence <= 4; sequence += 1) {
  const create = checkpoints[(sequence - 1) * 2];
  const destroy = checkpoints[(sequence - 1) * 2 + 1];
  if (create[0] !== 'create' || destroy[0] !== 'destroy'
      || create[5] !== `checkpoint-${sequence}`
      || destroy[5] !== create[5] || destroy[1] !== create[1]
      || ids.has(create[1])) process.exit(1);
  ids.add(create[1]);
}
const monitorCreates = records.filter((fields) => fields[0] === 'create'
  && fields[2] === 'backup-monitor');
if (new Set(monitorCreates.map((fields) => fields[1])).size !== monitorCreates.length) {
  process.exit(1);
}
EOF
  for checkpoint_sequence in 1 2 3 4; do
    assert_normal_checkpoint_pair immutable-checkpoint-baseline \
      "$checkpoint_success_case" "$checkpoint_sequence"
    assert_checkpoint_boundary_binding immutable-checkpoint-baseline \
      "$checkpoint_success_case" "$checkpoint_sequence" \
      "checkpoint-$checkpoint_sequence"
  done
  assert_checkpoint_boundary_binding immutable-checkpoint-baseline \
    "$checkpoint_success_case" 5 end

  stale_checkpoint_case="$(make_backup_case publication-stale-checkpoint-valid)"
  run_checkpoint_success_case valid-stale-checkpoint "$stale_checkpoint_case" \
    TEST_STALE_SENTINEL=checkpoint-valid TEST_CHECKPOINT_SCENARIO=valid \
    TEST_EVENT_REPO_ROOT="$fixture_repo"
  [[ -s "$stale_checkpoint_case/event-monitor/stale-removed" ]] \
    || fail "valid stale checkpoint sentinel was not reconciled"

  assert_checkpoint_failure_specific event-checkpoint-forbidden-pre-boundary \
    false 'release-scoped Docker event continuity failed during identity capture' 1 \
    TEST_CHECKPOINT_SCENARIO=forbidden-pre-boundary \
    TEST_EVENT_REPO_ROOT="$fixture_repo"
  [[ -s "$last_precommit_failure_case/event-monitor/raw-full-observed" ]] \
    || fail "forbidden pre-boundary event fixture did not reach the monitor"

  assert_checkpoint_failure_specific event-checkpoint-complete-post-boundary \
    true 'quiesced backup transaction failed: captured mutator stop lifecycle failed closed' 2 \
    TEST_CHECKPOINT_SCENARIO=complete-post-boundary \
    TEST_EVENT_REPO_ROOT="$fixture_repo"
  complete_post_boundary_case="$last_precommit_failure_case"
  [[ -s "$complete_post_boundary_case/event-monitor/raw-full-observed" ]] \
    || fail "complete post-boundary event did not reach the monitor"
  assert_checkpoint_boundary_binding event-checkpoint-complete-post-boundary \
    "$complete_post_boundary_case" 1 checkpoint-1
  complete_checkpoint_boundary="$(<"$complete_post_boundary_case/event-monitor/emitted-checkpoint-1-boundary")"
  complete_emitted_bytes="$(wc -c <"$complete_post_boundary_case/event-monitor/emitted-bytes" | tr -d ' ')"
  ((complete_emitted_bytes > complete_checkpoint_boundary)) \
    || fail "complete post-boundary event was not emitted after exclusive B"
  post_boundary_byte="$(dd if="$complete_post_boundary_case/event-monitor/emitted-bytes" \
    bs=1 skip="$complete_checkpoint_boundary" count=1 status=none \
    | od -An -t u1 | tr -d '[:space:]')"
  [[ "$post_boundary_byte" == 107 ]] \
    || fail "complete post-boundary event did not begin immediately after B"

  assert_checkpoint_failure_specific event-checkpoint-post-boundary-oversize \
    false 'release-scoped Docker event continuity failed during identity capture' 1 \
    TEST_CHECKPOINT_SCENARIO=post-boundary-oversize \
    TEST_EVENT_REPO_ROOT="$fixture_repo"
  oversized_checkpoint_case="$last_precommit_failure_case"
  [[ -s "$oversized_checkpoint_case/event-monitor/oversized-tail-observed" ]] \
    || fail "post-boundary oversized tail did not reach the monitor"
  assert_checkpoint_boundary_binding event-checkpoint-post-boundary-oversize \
    "$oversized_checkpoint_case" 1 checkpoint-1
  oversized_live_bytes="$(wc -c <"$oversized_checkpoint_case/event-monitor/emitted-bytes" | tr -d ' ')"
  ((oversized_live_bytes > 1048576)) \
    || fail "post-boundary oversized tail did not exceed the whole-live cap"

  assert_torn_checkpoint_case

  assert_checkpoint_wait_cases

  assert_checkpoint_failure_specific event-checkpoint-blank-record false \
    'release-scoped Docker event continuity failed during identity capture' 1 \
    TEST_CHECKPOINT_SCENARIO=checkpoint-blank-record \
    TEST_EVENT_REPO_ROOT="$fixture_repo"

  assert_checkpoint_emitted_mutation_case

  assert_checkpoint_close_cases

  for malformed_checkpoint in checkpoint-zero checkpoint-leading-zero \
    checkpoint-phase-mismatch checkpoint-wrong-token; do
    malformed_checkpoint_case="$(make_backup_case \
      "publication-stale-$malformed_checkpoint")"
    assert_preflight_failure "stale-$malformed_checkpoint" \
      "$malformed_checkpoint_case" \
      TEST_STALE_SENTINEL="$malformed_checkpoint" \
      TEST_EVENT_REPO_ROOT="$fixture_repo"
    [[ ! -e "$malformed_checkpoint_case/event-monitor/stale-removed" ]] \
      || fail "malformed stale checkpoint sentinel was removed"
  done
  if [[ "$test_group" == immutable-event-checkpoints ]]; then
    echo "backup-publication-immutable-event-checkpoint-tests-ok"
    exit 0
  fi
fi

if [[ "$test_group" == all || "$test_group" == m7-directory-safety ]]; then
  unsafe_owner_case="$(make_backup_case publication-unsafe-directory-owner)"
  assert_rejected_directory_was_not_chmodded unsafe-directory-owner \
    "$unsafe_owner_case" "$unsafe_owner_case/backups/full" \
    "$unsafe_owner_case/chmod-mutation" \
    TEST_UNSAFE_DIRECTORY_PATH="$unsafe_owner_case/backups/full"

  alias_case="$(make_backup_case publication-noncanonical-directory-alias)"
  mkdir -p -- "$alias_case/alias-parent"
  chmod 0700 -- "$alias_case/alias-parent"
  alias_stage="$alias_case/alias-parent/../stage"
  sed -i "s|^BACKUP_STAGE_ROOT=.*|BACKUP_STAGE_ROOT=$alias_stage|" \
    "$alias_case/backup.env"
  assert_rejected_directory_was_not_chmodded noncanonical-directory-alias \
    "$alias_case" "$alias_stage" "$alias_case/chmod-mutation"
fi

if [[ "$test_group" == m7-directory-safety ]]; then
  echo "backup-publication-m7-directory-safety-tests-ok"
  exit 0
fi

if [[ "$test_group" == m6-production-canonical ]]; then
  canonical_repo_one="$work/production-canonical-release-one"
  canonical_repo_two="$work/production-canonical-release-two"
  cp -a -- "$fixture_repo" "$canonical_repo_one"
  cp -a -- "$fixture_repo" "$canonical_repo_two"
  [[ "$(git -C "$canonical_repo_one" rev-parse HEAD)" == \
    "$(git -C "$canonical_repo_two" rev-parse HEAD)" ]] \
    || fail "independent canonical repositories do not share the same commit"
  canonical_controller_one="$(make_backup_case production-canonical-one "$canonical_repo_one")"
  canonical_controller_two="$(make_backup_case production-canonical-two "$canonical_repo_two")"
  for canonical_case in "$canonical_controller_one" "$canonical_controller_two"; do
    if ! PATH="$work/bin:$PATH" TEST_FIXED_BACKUP_TIME=1 \
      TEST_RUNNING_STATE="$canonical_case/running-state" \
      BACKUP_CONFIG_FILE="$canonical_case/backup.env" \
      bash "$backup_controller" \
      >"$canonical_case/stdout" 2>"$canonical_case/log"; then
      sed -n '1,80p' "$canonical_case/log" >&2
      fail "production canonical controller fixture failed"
    fi
  done
  canonical_name_one="$(sed -n 's/^SUCCESS_ARCHIVE=//p' \
    "$canonical_controller_one/backups/state/local-last-success.env")"
  canonical_name_two="$(sed -n 's/^SUCCESS_ARCHIVE=//p' \
    "$canonical_controller_two/backups/state/local-last-success.env")"
  [[ "$canonical_name_one" == "$canonical_name_two" ]] \
    || fail "production canonical controller changed the fixed-input filename"
  cmp -s \
    "$canonical_controller_one/backups/full/$canonical_name_one" \
    "$canonical_controller_two/backups/full/$canonical_name_two" \
    || fail "production canonical packaging changed across backup/data roots"
  echo "backup-publication-m6-canonical-tests-ok"
  exit 0
fi

if [[ "$test_group" == all || "$test_group" == c1-key-exclusion ]]; then
  repository_key_case="$(make_backup_case publication-key-inside-repository)"
  repository_key_repo="$repository_key_case/release"
  cp -a -- "$fixture_repo" "$repository_key_repo"
  cp -- "$master_key" "$repository_key_repo/content/credential-master-key"
  chmod 0440 "$repository_key_repo/content/credential-master-key"
  sed -i \
    -e "s|^REPO_ROOT=.*|REPO_ROOT=$repository_key_repo|" \
    -e "s|^CREDENTIAL_MASTER_KEY_FILE=.*|CREDENTIAL_MASTER_KEY_FILE=$repository_key_repo/content/credential-master-key|" \
    "$repository_key_case/backup.env"
  assert_preflight_failure key-inside-repository "$repository_key_case"

  app_data_key_case="$(make_backup_case publication-key-inside-app-data)"
  cp -- "$master_key" "$app_data_key_case/data/app-data/credential-master-key"
  chmod 0440 "$app_data_key_case/data/app-data/credential-master-key"
  sed -i \
    "s|^CREDENTIAL_MASTER_KEY_FILE=.*|CREDENTIAL_MASTER_KEY_FILE=$app_data_key_case/data/app-data/credential-master-key|" \
    "$app_data_key_case/backup.env"
  assert_preflight_failure key-inside-app-data "$app_data_key_case"

  hardlink_key_case="$(make_backup_case publication-key-hardlink-in-app-data)"
  if ! ln -- "$master_key" "$hardlink_key_case/data/app-data/key-hardlink"; then
    fail "could not create the credential-key hardlink regression fixture"
  fi
  [[ "$(stat -c '%h' -- "$master_key")" -gt 1 ]] \
    || fail "credential-key hardlink fixture did not share an inode"
  assert_preflight_failure key-hardlink-in-app-data "$hardlink_key_case"
  rm -f -- "$hardlink_key_case/data/app-data/key-hardlink"
fi

if [[ "$test_group" == c1-key-exclusion ]]; then
  echo "backup-publication-c1-tests-ok"
  exit 0
fi

if [[ "$test_group" == all || "$test_group" == m5-provenance ]]; then
  dirty_release_case="$(make_backup_case publication-dirty-release)"
  dirty_release_repo="$dirty_release_case/release"
  cp -a -- "$fixture_repo" "$dirty_release_repo"
  printf dirty >>"$dirty_release_repo/content/lesson.json"
  sed -i "s|^REPO_ROOT=.*|REPO_ROOT=$dirty_release_repo|" \
    "$dirty_release_case/backup.env"
  assert_preflight_failure dirty-reviewed-release "$dirty_release_case"

  untracked_release_case="$(make_backup_case publication-untracked-included-release)"
  untracked_release_repo="$untracked_release_case/release"
  cp -a -- "$fixture_repo" "$untracked_release_repo"
  printf unreviewed >"$untracked_release_repo/infra/untracked.conf"
  sed -i "s|^REPO_ROOT=.*|REPO_ROOT=$untracked_release_repo|" \
    "$untracked_release_case/backup.env"
  assert_preflight_failure untracked-included-release "$untracked_release_case"

  ignored_release_case="$(make_backup_case publication-ignored-included-release)"
  ignored_release_repo="$ignored_release_case/release"
  cp -a -- "$fixture_repo" "$ignored_release_repo"
  printf '%s\n' infra/ignored.conf >>"$ignored_release_repo/.git/info/exclude"
  printf ignored-but-packaged >"$ignored_release_repo/infra/ignored.conf"
  sed -i "s|^REPO_ROOT=.*|REPO_ROOT=$ignored_release_repo|" \
    "$ignored_release_case/backup.env"
  assert_preflight_failure ignored-untracked-included-release "$ignored_release_case"

  unknown_created_case="$(make_backup_case publication-unknown-created-service)"
  assert_preflight_failure unknown-stopped-created-service "$unknown_created_case" \
    TEST_UNKNOWN_CREATED_SERVICE=1
fi

if [[ "$test_group" == m5-provenance ]]; then
  echo "backup-publication-m5-tests-ok"
  exit 0
fi

if [[ "$test_group" == strict-event-record ]]; then
  assert_precommit_failure quiesce-event-ninth-empty-field true \
    TEST_QUIESCE_EVENT_SCENARIO=ninth-empty-field \
    TEST_EVENT_REPO_ROOT="$fixture_repo"
  echo "backup-publication-strict-event-record-tests-ok"
  exit 0
fi

if [[ "$test_group" == monitor-cleanup-containment ]]; then
  assert_precommit_failure quiesce-event-extra true \
    TEST_QUIESCE_EVENT_SCENARIO=extra \
    TEST_EVENT_REPO_ROOT="$fixture_repo"
  echo "backup-publication-monitor-cleanup-containment-tests-ok"
  exit 0
fi

if [[ "$test_group" == quiesce-event-lifecycle ]]; then
  quiesce_success_case="$(make_backup_case publication-quiesce-event-lifecycle)"
  cp -- "$quiesce_success_case/backups/state/local-last-success.env" \
    "$quiesce_success_case/old-marker"
  if ! PATH="$work/bin:$PATH" \
    TEST_QUIESCE_EVENT_SCENARIO=valid \
    TEST_EVENT_REPO_ROOT="$fixture_repo" \
    TEST_RUNNING_STATE="$quiesce_success_case/running-state" \
    BACKUP_CONFIG_FILE="$quiesce_success_case/backup.env" \
    bash "$backup_controller" \
    >"$quiesce_success_case/stdout" 2>"$quiesce_success_case/log"; then
    sed -n '1,120p' "$quiesce_success_case/log" >&2
    fail "backup rejected the exact captured-container quiesce lifecycle"
  fi
  if [[ "${TEST_USE_REAL_MANAGED_DEADLINE:-0}" == 1 ]]; then
    [[ -s "${TEST_REAL_STOP_REQUEST_REACHED:?}" ]] \
      || fail "real controller success omitted authenticated stop-request reach"
    grep -Fq 'backup_monitor_containment_failed' "$quiesce_success_case/log" \
      && fail "real controller success masked a monitor containment failure"
    [[ -z "$(find "$quiesce_success_case/event-monitor" -maxdepth 1 \
      \( -name '*.control' -o -name '.managed-deadline-stop-*.sock' \) \
      -print -quit)" ]] \
      || fail "real controller success retained protected stop metadata"
    assert_case_protected_roots_empty "real controller success" "$quiesce_success_case"
  fi
  if cmp -s "$quiesce_success_case/old-marker" \
    "$quiesce_success_case/backups/state/local-last-success.env"; then
    fail "exact quiesce lifecycle did not commit a recovery point"
  fi
  grep -Fq '{{.ID}}' "$quiesce_success_case/event-monitor/events-argv" \
    || fail "Docker event subscription omitted the full container ID"
  for quiesce_service in cloudflared app; do
    quiesce_id="$(printf '%s' "$quiesce_service" | sha256sum | awk '{print $1}')"
    for quiesce_action in kill die stop; do
      expected_signal=""
      expected_exit=""
      [[ "$quiesce_action" != kill ]] || expected_signal=15
      [[ "$quiesce_action" != die ]] || expected_exit=0
      [[ "$(grep -Fxc \
        "$quiesce_action|$quiesce_id|$quiesce_service|$fixture_repo|||$expected_signal|$expected_exit" \
        "$quiesce_success_case/event-monitor/actions")" == 1 ]] \
        || fail "fake Compose stop omitted or repeated $quiesce_action for $quiesce_service/$quiesce_id"
    done
  done
  start_destroy_line="$(grep -n -m1 \
    '^destroy|[0-9a-f]\{64\}|backup-monitor|.*|start|' \
    "$quiesce_success_case/event-monitor/actions" | cut -d: -f1)"
  first_quiesce_action_line="$(grep -n -m1 \
    -E '^(kill|die|stop)\|[0-9a-f]{64}\|(cloudflared|app)\|' \
    "$quiesce_success_case/event-monitor/actions" | cut -d: -f1)"
  quiesce_create_line="$(grep -n -m1 \
    '^create|[0-9a-f]\{64\}|backup-monitor|.*|quiesce-close|' \
    "$quiesce_success_case/event-monitor/actions" | cut -d: -f1)"
  last_quiesce_action_line="$(grep -n \
    -E '^(kill|die|stop)\|[0-9a-f]{64}\|(cloudflared|app)\|' \
    "$quiesce_success_case/event-monitor/actions" | tail -n1 | cut -d: -f1)"
  [[ "$start_destroy_line" =~ ^[0-9]+$ \
    && "$first_quiesce_action_line" =~ ^[0-9]+$ \
    && "$quiesce_create_line" =~ ^[0-9]+$ \
    && "$last_quiesce_action_line" =~ ^[0-9]+$ \
    && "$start_destroy_line" -lt "$first_quiesce_action_line" \
    && "$last_quiesce_action_line" -lt "$quiesce_create_line" ]] \
    || fail "quiesce lifecycle was not causally bracketed by monitor sentinels"

  for quiesce_rejection in missing extra repeated wrong-order wrong-id \
    wrong-service wrong-workdir before-open after-close postgres start restart \
    signal-9 exit-code ninth-empty-field partial-failure; do
    quiesce_expect_resume=true
    [[ "$quiesce_rejection" != before-open ]] || quiesce_expect_resume=false
    assert_precommit_failure "quiesce-event-$quiesce_rejection" \
      "$quiesce_expect_resume" \
      TEST_QUIESCE_EVENT_SCENARIO="$quiesce_rejection" \
      TEST_EVENT_REPO_ROOT="$fixture_repo"
  done
  echo "backup-publication-quiesce-event-lifecycle-tests-ok"
  exit 0
fi

if [[ "$test_group" == all || "$test_group" == m1-transient-mutator ]]; then
  project_mismatch_case="$(make_backup_case publication-event-monitor-project-mismatch)"
  assert_preflight_failure event-monitor-project-mismatch "$project_mismatch_case" \
    TEST_COMPOSE_PROJECT_MISMATCH=1
fi

if [[ "$test_group" == all || "$test_group" == m1-transient-mutator \
  || "$test_group" == m8-stale-sentinels ]]; then
  for stale_rejection in bad-image bad-runtime-image running wrong-project \
    wrong-workdir wrong-service missing-token bad-phase missing-watchtower \
    true-watchtower; do
    stale_rejection_case="$(make_backup_case "publication-stale-sentinel-$stale_rejection")"
    assert_preflight_failure "stale-sentinel-$stale_rejection" "$stale_rejection_case" \
      TEST_STALE_SENTINEL="$stale_rejection" TEST_EVENT_REPO_ROOT="$fixture_repo"
    [[ ! -e "$stale_rejection_case/event-monitor/stale-removed" ]] \
      || fail "unsafe stale sentinel $stale_rejection was removed"
  done

  for stale_allowed in valid unrelated; do
    stale_allowed_case="$(make_backup_case "publication-stale-sentinel-$stale_allowed")"
    cp "$stale_allowed_case/backups/state/local-last-success.env" \
      "$stale_allowed_case/old-marker"
    if ! PATH="$work/bin:$PATH" \
      TEST_STALE_SENTINEL="$stale_allowed" TEST_EVENT_REPO_ROOT="$fixture_repo" \
      TEST_RUNNING_STATE="$stale_allowed_case/running-state" \
      BACKUP_CONFIG_FILE="$stale_allowed_case/backup.env" \
      bash "$backup_controller" \
      >"$stale_allowed_case/stdout" 2>"$stale_allowed_case/log"; then
      sed -n '1,100p' "$stale_allowed_case/log" >&2
      fail "backup rejected $stale_allowed stale-sentinel reconciliation"
    fi
    if cmp -s "$stale_allowed_case/old-marker" \
      "$stale_allowed_case/backups/state/local-last-success.env"; then
      fail "$stale_allowed stale-sentinel reconciliation did not commit"
    fi
    if [[ "$stale_allowed" == valid ]]; then
      [[ -s "$stale_allowed_case/event-monitor/stale-removed" ]] \
        || fail "exact stale sentinel was not removed"
    else
      [[ -s "$stale_allowed_case/event-monitor/unrelated-filtered" \
        && ! -e "$stale_allowed_case/event-monitor/stale-removed" ]] \
        || fail "unrelated sentinel was not filtered without removal"
    fi
    if find "$stale_allowed_case/event-monitor" -maxdepth 1 -type f \
      -regextype posix-extended -regex '.*/[0-9a-f]{64}' -print -quit | grep -q .; then
      fail "$stale_allowed stale-sentinel run accumulated a sentinel container"
    fi
  done

  if [[ "$test_group" == m8-stale-sentinels ]]; then
    echo "backup-publication-m8-stale-sentinel-tests-ok"
    exit 0
  fi

  for event_failure in overflow-mutator postgres-restart \
    boundary-object boundary-publication; do
    assert_precommit_failure "event-monitor-$event_failure" true \
      TEST_EVENT_SCENARIO="$event_failure" TEST_EVENT_REPO_ROOT="$fixture_repo"
  done
  assert_monitor_loss_protected_retention

  for allowed_event in unrelated-project clamav-restart; do
    allowed_running_services='postgres app cloudflared'
    [[ "$allowed_event" != clamav-restart ]] \
      || allowed_running_services='postgres app cloudflared clamav'
    allowed_case="$(make_backup_case "publication-event-monitor-$allowed_event")"
    cp "$allowed_case/backups/state/local-last-success.env" "$allowed_case/old-marker"
    if ! PATH="$work/bin:$PATH" \
      TEST_EVENT_SCENARIO="$allowed_event" TEST_EVENT_REPO_ROOT="$fixture_repo" \
      TEST_RUNNING_SERVICES="$allowed_running_services" \
      TEST_RUNNING_STATE="$allowed_case/running-state" \
      BACKUP_CONFIG_FILE="$allowed_case/backup.env" \
      bash "$backup_controller" \
      >"$allowed_case/stdout" 2>"$allowed_case/log"; then
      sed -n '1,100p' "$allowed_case/log" >&2
      fail "event monitor rejected allowed $allowed_event activity"
    fi
    if cmp -s "$allowed_case/old-marker" \
      "$allowed_case/backups/state/local-last-success.env"; then
      fail "allowed $allowed_event activity did not commit a recovery point"
    fi
    grep -Fq 'phase=marker_committed' "$allowed_case/log" \
      || fail "allowed $allowed_event activity did not cross the marker boundary"
    [[ -z "$(find "$allowed_case/stage" "$allowed_case/runtime" \
      -mindepth 1 -print -quit)" ]] \
      || fail "allowed $allowed_event activity left protected temporary material"
  done
fi

if [[ "$test_group" == m1-transient-mutator ]]; then
  echo "backup-publication-m1-event-monitor-tests-ok"
  exit 0
fi

if [[ "$test_group" == clamav-restart-lifecycle ]]; then
  assert_precommit_failure event-monitor-clamav-incomplete true \
    TEST_EVENT_SCENARIO=clamav-restart-incomplete \
    TEST_EVENT_REPO_ROOT="$fixture_repo"
  assert_precommit_failure event-monitor-clamav-overlong true \
    TEST_EVENT_SCENARIO=clamav-restart-overlong \
    TEST_EVENT_REPO_ROOT="$fixture_repo"
  clamav_case="$(make_backup_case publication-event-monitor-clamav-lifecycle)"
  cp "$clamav_case/backups/state/local-last-success.env" "$clamav_case/old-marker"
  if ! PATH="$work/bin:$PATH" \
    TEST_EVENT_SCENARIO=clamav-restart TEST_EVENT_REPO_ROOT="$fixture_repo" \
    TEST_RUNNING_SERVICES='postgres app cloudflared clamav' \
    TEST_RUNNING_STATE="$clamav_case/running-state" \
    BACKUP_CONFIG_FILE="$clamav_case/backup.env" \
    bash "$backup_controller" \
    >"$clamav_case/stdout" 2>"$clamav_case/log"; then
    sed -n '1,100p' "$clamav_case/log" >&2
    fail "event monitor rejected a bounded healthy ClamAV restart lifecycle"
  fi
  if cmp -s "$clamav_case/old-marker" \
    "$clamav_case/backups/state/local-last-success.env"; then
    fail "healthy ClamAV restart lifecycle did not commit a recovery point"
  fi
  grep -Fq 'phase=marker_committed' "$clamav_case/log" \
    || fail "healthy ClamAV restart lifecycle did not cross the marker boundary"
  echo "backup-publication-clamav-restart-lifecycle-tests-ok"
  exit 0
fi

if [[ "$test_group" == postgres-continuity ]]; then
  if [[ "${TEST_SKIP_EXEC_POLICY_STATIC:-0}" != 1 ]]; then
    grep -Fq 'requires root/Docker-socket exclusivity during' "$backup_controller" \
      || fail "PostgreSQL exec policy does not document the trusted administrator boundary"
  fi
  for event_case in \
    'post-dump|create' 'post-dump|destroy' 'post-dump|die' \
    'post-dump|kill' 'post-dump|oom' 'post-dump|pause' \
    'post-dump|rename' 'pre-marker|stop' 'pre-marker|update' \
    'pre-marker|restart' 'pre-marker|start' 'pre-marker|unpause' \
    'pre-marker|health_status: unhealthy'; do
    IFS='|' read -r event_boundary event_action <<<"$event_case"
    event_label="${event_boundary}-${event_action//[^a-zA-Z0-9]/-}"
    event_case_root="$work/publication-postgres-$event_label-failure"
    state_path="$event_case_root/postgres-state"
    assert_precommit_failure "postgres-$event_label" true \
      TEST_POSTGRES_EVENT_BOUNDARY="$event_boundary" \
      TEST_POSTGRES_EVENT_ACTION="$event_action" \
      TEST_POSTGRES_MUTATED_STATE=healthy \
      TEST_POSTGRES_STATE_FILE="$state_path" \
      TEST_POSTGRES_DUMP_COMPLETE="$event_case_root/dump-complete" \
      TEST_POSTGRES_BOUNDARY_INJECTED="$event_case_root/boundary-injected" \
      TEST_EVENT_REPO_ROOT="$fixture_repo"
    [[ "$(<"$state_path")" == healthy ]] \
      || fail "PostgreSQL $event_label event-only fixture changed container state"
    if [[ "$event_boundary" == post-dump ]]; then
      [[ -s "$event_case_root/dump-complete" \
        && -s "$event_case_root/boundary-injected" ]] \
        || fail "PostgreSQL $event_label was not injected by the post-dump command"
      node - "$event_case_root/dump-complete" \
        "$event_case_root/boundary-injected" <<'EOF'
const fs = require("node:fs");
const [dumpPath, injectedPath] = process.argv.slice(2);
const dumped = BigInt(fs.readFileSync(dumpPath, "utf8").trim());
const injected = BigInt(fs.readFileSync(injectedPath, "utf8").trim());
if (injected < dumped) process.exit(1);
EOF
    fi
  done
  for state_case in post-dump:missing post-dump:paused post-dump:changed \
    pre-marker:stopped pre-marker:unhealthy; do
    IFS=: read -r state_boundary mutated_state <<<"$state_case"
    state_label="${state_boundary}-${mutated_state}"
    state_case_root="$work/publication-postgres-state-$state_label-failure"
    state_path="$state_case_root/postgres-state"
    assert_precommit_failure "postgres-state-$state_label" true \
      TEST_POSTGRES_EVENT_BOUNDARY="$state_boundary" \
      TEST_POSTGRES_EVENT_ACTION=none \
      TEST_POSTGRES_MUTATED_STATE="$mutated_state" \
      TEST_POSTGRES_STATE_FILE="$state_path" \
      TEST_POSTGRES_DUMP_COMPLETE="$state_case_root/dump-complete" \
      TEST_POSTGRES_BOUNDARY_INJECTED="$state_case_root/boundary-injected" \
      TEST_EVENT_REPO_ROOT="$fixture_repo"
    [[ "$(<"$state_path")" == "$mutated_state" ]] \
      || fail "PostgreSQL $state_label state-only fixture was not applied"
  done
  filter_case="$(make_backup_case publication-postgres-complete-event-filters)"
  cp "$filter_case/backups/state/local-last-success.env" "$filter_case/old-marker"
  if ! PATH="$work/bin:$PATH" TEST_REQUIRE_COMPLETE_EVENT_FILTERS=1 \
    TEST_REQUIRE_EXEC_POLICY=1 \
    TEST_EVENT_SCENARIO=unattributed-postgres-exec \
    TEST_EVENT_REPO_ROOT="$fixture_repo" \
    TEST_RUNNING_STATE="$filter_case/running-state" \
    BACKUP_CONFIG_FILE="$filter_case/backup.env" \
    bash "$backup_controller" \
    >"$filter_case/stdout" 2>"$filter_case/log"; then
    fail "backup did not subscribe to the complete continuity event set"
  fi
  cmp -s "$filter_case/old-marker" \
    "$filter_case/backups/state/local-last-success.env" \
    && fail "trusted-admin exec policy fixture did not complete"
  if grep -Eq -- '--filter event=exec_(create|start|die)' \
    "$filter_case/event-monitor/events-argv"; then
    fail "trusted-admin policy subscribed to unauthenticated exec events"
  fi
  echo "backup-publication-postgres-continuity-tests-ok"
  exit 0
fi

if [[ "$test_group" == all || "$test_group" == m2-post-effect-renames ]]; then
  assert_precommit_failure archive-rename-post-effect true \
    TEST_ARCHIVE_RENAME_POST_EFFECT_FAIL=1
  assert_precommit_failure sidecar-rename-post-effect true \
    TEST_SIDECAR_RENAME_POST_EFFECT_FAIL=1
fi

if [[ "$test_group" == m2-post-effect-renames ]]; then
  echo "backup-publication-m2-tests-ok"
  exit 0
fi

assert_marker_post_effect_rolled_back() {
  local label="$1" case_root effect_file archive_count sidecar_count
  local resume_line alert_line
  shift
  case_root="$(make_backup_case "publication-marker-$label")"
  cp "$case_root/backups/state/local-last-success.env" "$case_root/old-marker"
  effect_file="$case_root/marker-effect"
  if /usr/bin/env PATH="$work/bin:$PATH" \
    TEST_MARKER_EFFECT_RECORDED="$effect_file" \
    TEST_EVENT_REPO_ROOT="$fixture_repo" \
    TEST_RUNNING_STATE="$case_root/running-state" \
    BACKUP_CONFIG_FILE="$case_root/backup.env" "$@" \
    bash "$backup_controller" \
    >"$case_root/stdout" 2>"$case_root/log"; then
    fail "backup reported success after marker $label uncertainty"
  fi
  [[ -s "$effect_file" ]] \
    || fail "marker $label fixture did not perform the authoritative rename"
  cmp -s "$case_root/old-marker" \
    "$case_root/backups/state/local-last-success.env" \
    || fail "marker $label uncertainty did not durably restore the prior marker"
  archive_count="$(find "$case_root/backups/full" -maxdepth 1 -type f \
    -name 'learncoding-full-*.tar.gz.age' | wc -l | tr -d ' ')"
  sidecar_count="$(find "$case_root/backups/full" -maxdepth 1 -type f \
    -name 'learncoding-full-*.tar.gz.age.sha256' | wc -l | tr -d ' ')"
  [[ "$archive_count" == 1 && "$sidecar_count" == 1 ]] \
    || fail "marker $label uncertainty left archive/sidecar counts $archive_count/$sidecar_count"
  grep -Fq 'resume:app' "$case_root/log" \
    || fail "marker $label uncertainty did not resume the captured app"
  resume_line="$(grep -n -m1 'resume:app' "$case_root/log" | cut -d: -f1)"
  alert_line="$(grep -n -m1 'event=backup_failed' "$case_root/log" \
    | cut -d: -f1)"
  [[ "$resume_line" =~ ^[0-9]+$ && "$alert_line" =~ ^[0-9]+$ \
    && "$resume_line" -lt "$alert_line" ]] \
    || fail "marker $label uncertainty did not resume before reconciliation reporting"
  [[ -z "$(find "$case_root/stage" "$case_root/runtime" \
    -mindepth 1 -print -quit)" ]] \
    || fail "marker $label uncertainty left plaintext or ephemeral material"
}

assert_marker_post_effect_ambiguous() {
  local label="$1" case_root effect_file rollback_fault candidate_snapshot
  local marker_name marker_hash old_name old_hash archive_count sidecar_count
  shift
  case_root="$(make_backup_case "publication-marker-$label")"
  cp "$case_root/backups/state/local-last-success.env" "$case_root/old-marker"
  old_name="$(sed -n 's/^SUCCESS_ARCHIVE=//p' "$case_root/old-marker")"
  old_hash="$(sed -n 's/^SUCCESS_SHA256=//p' "$case_root/old-marker")"
  cp -- "$case_root/backups/full/$old_name" "$case_root/old-archive"
  cp -- "$case_root/backups/full/$old_name.sha256" "$case_root/old-sidecar"
  effect_file="$case_root/marker-effect"
  rollback_fault="$case_root/rollback-fault"
  candidate_snapshot="$case_root/candidate-marker"
  if /usr/bin/env PATH="$work/bin:$PATH" \
    TEST_MARKER_EFFECT_RECORDED="$effect_file" \
    TEST_MARKER_ROLLBACK_FAULT_OBSERVED="$rollback_fault" \
    TEST_MARKER_CANDIDATE_SNAPSHOT="$candidate_snapshot" \
    TEST_EVENT_REPO_ROOT="$fixture_repo" \
    TEST_RUNNING_STATE="$case_root/running-state" \
    BACKUP_CONFIG_FILE="$case_root/backup.env" "$@" \
    bash "$backup_controller" \
    >"$case_root/stdout" 2>"$case_root/log"; then
    fail "backup reported success after ambiguous marker $label failure"
  fi
  [[ -s "$effect_file" ]] || fail "ambiguous marker $label had no rename effect"
  [[ -s "$rollback_fault" ]] \
    || fail "ambiguous marker $label did not fire the rollback fault"
  [[ -s "$candidate_snapshot" ]] \
    || fail "ambiguous marker $label did not capture the renamed candidate marker"
  cmp -s "$candidate_snapshot" \
    "$case_root/backups/state/local-last-success.env" \
    || fail "ambiguous marker $label did not retain the renamed candidate marker"
  if cmp -s "$case_root/old-marker" \
    "$case_root/backups/state/local-last-success.env"; then
    fail "ambiguous marker $label silently restored the prior marker"
  fi
  marker_name="$(sed -n 's/^SUCCESS_ARCHIVE=//p' \
    "$candidate_snapshot")"
  marker_hash="$(sed -n 's/^SUCCESS_SHA256=//p' \
    "$candidate_snapshot")"
  [[ "$marker_name" =~ ^learncoding-full-[0-9]{8}T[0-9]{6}Z\.tar\.gz\.age$ \
    && "$marker_hash" =~ ^[0-9a-f]{64}$ \
    && -f "$case_root/backups/full/$marker_name" \
    && -f "$case_root/backups/full/$marker_name.sha256" ]] \
    || fail "ambiguous marker $label did not preserve the candidate pair"
  [[ "$(sha256sum "$case_root/backups/full/$marker_name" | awk '{print $1}')" \
    == "$marker_hash" ]] \
    || fail "ambiguous marker $label retained a candidate with the wrong digest"
  grep -Fxq "$marker_hash  $marker_name" \
    "$case_root/backups/full/$marker_name.sha256" \
    || fail "ambiguous marker $label retained a mismatched candidate sidecar"
  archive_count="$(find "$case_root/backups/full" -maxdepth 1 -type f \
    -name 'learncoding-full-*.tar.gz.age' | wc -l | tr -d ' ')"
  sidecar_count="$(find "$case_root/backups/full" -maxdepth 1 -type f \
    -name 'learncoding-full-*.tar.gz.age.sha256' | wc -l | tr -d ' ')"
  [[ "$archive_count" == 2 && "$sidecar_count" == 2 ]] \
    || fail "ambiguous marker $label pair counts were $archive_count/$sidecar_count"
  cmp -s "$case_root/old-archive" "$case_root/backups/full/$old_name" \
    && cmp -s "$case_root/old-sidecar" \
      "$case_root/backups/full/$old_name.sha256" \
    || fail "ambiguous marker $label changed the prior archive pair"
  [[ "$(sha256sum "$case_root/backups/full/$old_name" | awk '{print $1}')" \
    == "$old_hash" ]] \
    || fail "ambiguous marker $label invalidated the prior archive digest"
  if grep -Eq 'phase=(marker_committed|pruning|complete)|event=backup_complete' \
    "$case_root/log"; then
    fail "ambiguous marker $label was reported as authoritative"
  fi
  grep -Fq 'resume:app' "$case_root/log" \
    || fail "ambiguous marker $label did not resume the captured app"
  [[ -z "$(find "$case_root/stage" "$case_root/runtime" \
    -mindepth 1 -print -quit)" ]] \
    || fail "ambiguous marker $label left protected temporary material"
}

if [[ "$test_group" == all || "$test_group" == m2-marker-window \
  || "$test_group" == m2-marker-ambiguous ]]; then
  if [[ "$test_group" != m2-marker-ambiguous ]]; then
  assert_marker_post_effect_rolled_back directory-sync-failure \
    TEST_MARKER_DIRECTORY_SYNC_FAIL=1
  assert_marker_post_effect_rolled_back signal-after-rename \
    TEST_MARKER_SIGNAL_AFTER_EFFECT=1
  assert_marker_post_effect_rolled_back event-directory-sync-failure \
    TEST_MARKER_WINDOW_EVENT_SERVICE=lifecycle \
    TEST_MARKER_DIRECTORY_SYNC_FAIL=1
  assert_marker_post_effect_rolled_back event-signal-after-rename \
    TEST_MARKER_WINDOW_EVENT_SERVICE=postgres \
    TEST_MARKER_SIGNAL_AFTER_EFFECT=1
  fi
  assert_marker_post_effect_ambiguous event-directory-sync-rollback-failure \
    TEST_MARKER_WINDOW_EVENT_SERVICE=lifecycle \
    TEST_MARKER_DIRECTORY_SYNC_FAIL=1 TEST_MARKER_ROLLBACK_FAIL=1
fi

if [[ "$test_group" == m2-marker-window \
  || "$test_group" == m2-marker-ambiguous ]]; then
  echo "backup-publication-m2-marker-window-tests-ok"
  exit 0
fi

if [[ "$test_group" == all || "$test_group" == m10-marker-monitor ]]; then
  for marker_window_service in lifecycle postgres; do
    assert_precommit_failure "marker-monitor-$marker_window_service" true \
      TEST_MARKER_WINDOW_EVENT_SERVICE="$marker_window_service" \
      TEST_EVENT_REPO_ROOT="$fixture_repo"
  done
fi

if [[ "$test_group" == m10-marker-monitor ]]; then
  echo "backup-publication-m10-marker-monitor-tests-ok"
  exit 0
fi

if [[ "$test_group" == all || "$test_group" == m3-hard-deadline ]]; then
inode_deadline_case="$(make_backup_case publication-inode-scan-first-resume-deadline)"
cp "$inode_deadline_case/backups/state/local-last-success.env" \
  "$inode_deadline_case/old-marker"
if PATH="$work/bin:$PATH" \
  TEST_INODE_SCAN_TERM_IGNORING_CHILD=1 \
  TEST_BLOCK_CANDIDATE_CLEANUP=1 \
  TEST_HUNG_CHILD_STARTED="$inode_deadline_case/hung-child-started" \
  TEST_FIRST_RESUME_EVENT="$inode_deadline_case/first-resume-event" \
  TEST_TIMEOUT_GRACE_VIOLATION="$inode_deadline_case/timeout-grace-violation" \
  TEST_EVENT_REPO_ROOT="$fixture_repo" \
  TEST_RUNNING_STATE="$inode_deadline_case/running-state" \
  BACKUP_CONFIG_FILE="$inode_deadline_case/backup.env" \
  bash "$backup_controller" \
  >"$inode_deadline_case/stdout" 2>"$inode_deadline_case/log"; then
  fail "backup succeeded after the credential-key inode scan ignored TERM"
fi
[[ -s "$inode_deadline_case/hung-child-started" \
  && -s "$inode_deadline_case/first-resume-event" ]] \
  || fail "inode-deadline fixture did not record the hung scan and first resume"
[[ ! -e "$inode_deadline_case/timeout-grace-violation" ]] \
  || fail "inode scan received a timeout outside the 600-second ceiling"
node - "$inode_deadline_case/hung-child-started" \
  "$inode_deadline_case/first-resume-event" <<'EOF'
const fs = require("node:fs");
const [startedPath, resumedPath] = process.argv.slice(2);
const started = BigInt(fs.readFileSync(startedPath, "utf8").trim());
const resumed = BigInt(fs.readFileSync(resumedPath, "utf8").trim());
if (resumed < started || resumed - started > 2_000_000_000n) process.exit(1);
EOF
cmp -s "$inode_deadline_case/old-marker" \
  "$inode_deadline_case/backups/state/local-last-success.env" \
  || fail "inode-deadline failure changed the previous success marker"
grep -Fq 'resume:app' "$inode_deadline_case/log" \
  || fail "inode-deadline failure did not attempt app resume"
[[ "$(find "$inode_deadline_case/backups/full" -maxdepth 1 -type f \
  -name 'learncoding-full-*.tar.gz.age' | wc -l | tr -d ' ')" == 1 ]] \
  || fail "inode-deadline failure left a candidate final archive"
[[ -z "$(find "$inode_deadline_case/stage" "$inode_deadline_case/runtime" \
  -mindepth 1 -print -quit)" ]] \
  || fail "inode-deadline failure left plaintext or ephemeral key material"

hard_deadline_case="$(make_backup_case publication-hard-first-resume-deadline)"
cp "$hard_deadline_case/backups/state/local-last-success.env" \
  "$hard_deadline_case/old-marker"
if PATH="$work/bin:$PATH" \
  TEST_LATE_TERM_IGNORING_CHILD=1 \
  TEST_BLOCK_CANDIDATE_CLEANUP=1 \
  TEST_HUNG_CHILD_STARTED="$hard_deadline_case/hung-child-started" \
  TEST_FIRST_RESUME_EVENT="$hard_deadline_case/first-resume-event" \
  TEST_TIMEOUT_GRACE_VIOLATION="$hard_deadline_case/timeout-grace-violation" \
  TEST_RUNNING_STATE="$hard_deadline_case/running-state" \
  BACKUP_CONFIG_FILE="$hard_deadline_case/backup.env" \
  bash "$backup_controller" \
  >"$hard_deadline_case/stdout" 2>"$hard_deadline_case/log"; then
  fail "backup succeeded after a late-stage TERM-ignoring child exceeded its command budget"
fi
[[ -s "$hard_deadline_case/hung-child-started" \
  && -s "$hard_deadline_case/first-resume-event" ]] \
  || fail "hard-deadline fixture did not record the hung child and first resume"
if [[ -e "$hard_deadline_case/timeout-grace-violation" ]]; then
  fail "deadline passed kill grace outside the 600-second ceiling"
fi
node - "$hard_deadline_case/hung-child-started" \
  "$hard_deadline_case/first-resume-event" <<'EOF'
const fs = require("node:fs");
const [startedPath, resumedPath] = process.argv.slice(2);
const started = BigInt(fs.readFileSync(startedPath, "utf8").trim());
const resumed = BigInt(fs.readFileSync(resumedPath, "utf8").trim());
if (resumed < started || resumed - started > 2_000_000_000n) process.exit(1);
EOF
cmp -s "$hard_deadline_case/old-marker" \
  "$hard_deadline_case/backups/state/local-last-success.env" \
  || fail "hard-deadline failure changed the previous success marker"
grep -Fq 'resume:app' "$hard_deadline_case/log" \
  || fail "hard-deadline failure did not attempt app resume"
[[ "$(find "$hard_deadline_case/backups/full" -maxdepth 1 -type f \
  -name 'learncoding-full-*.tar.gz.age' | wc -l | tr -d ' ')" == 1 ]] \
  || fail "hard-deadline failure left a candidate final archive"
[[ -z "$(find "$hard_deadline_case/stage" "$hard_deadline_case/runtime" \
  -mindepth 1 -print -quit)" ]] \
  || fail "hard-deadline failure left plaintext or ephemeral key material"
fi

if [[ "$test_group" == m3-hard-deadline ]]; then
  echo "backup-publication-m3-tests-ok"
  exit 0
fi

if [[ "$test_group" == marker-writer-process-group ]]; then
  marker_group_case="$(make_backup_case publication-marker-writer-process-group)"
  marker_group_marker="$marker_group_case/backups/state/local-last-success.env"
  cp -- "$marker_group_marker" "$marker_group_case/old-marker"
  old_marker_name="$(sed -n 's/^SUCCESS_ARCHIVE=//p' \
    "$marker_group_case/old-marker")"
  cp -- "$marker_group_case/backups/full/$old_marker_name" \
    "$marker_group_case/old-archive"
  cp -- "$marker_group_case/backups/full/$old_marker_name.sha256" \
    "$marker_group_case/old-sidecar"
  marker_group_status=0
  PATH="$work/bin:$PATH" \
    TEST_MARKER_DESCENDANT_TIMEOUT=1 \
    TEST_MARKER_TIMEOUT_OBSERVED="$marker_group_case/timeout-observed" \
    TEST_MARKER_STUBBORN_DESCENDANT=1 \
    TEST_MARKER_HELD_PAYLOAD="$marker_group_case/held-marker" \
    TEST_MARKER_DESCENDANT_PID="$marker_group_case/descendant-pid" \
    TEST_MARKER_DESCENDANT_READY="$marker_group_case/descendant-ready" \
    TEST_MARKER_RELEASE_LATE_MV="$marker_group_case/release-late-mv" \
    TEST_MARKER_LATE_EFFECT="$marker_group_case/late-effect" \
    TEST_PROCESS_GROUP_IDENTITY="$marker_group_case/group.identity" \
    TEST_RESUME_ABSENT_IDENTITY="$marker_group_case/group.identity" \
    TEST_RESUME_GROUP_CHECKED="$marker_group_case/resume-group-checked" \
    TEST_FIRST_RESUME_EVENT="$marker_group_case/first-resume-event" \
    TEST_EVENT_REPO_ROOT="$fixture_repo" \
    TEST_RUNNING_STATE="$marker_group_case/running-state" \
    BACKUP_CONFIG_FILE="$marker_group_case/backup.env" \
    bash "$backup_controller" \
    >"$marker_group_case/stdout" 2>"$marker_group_case/log" \
    || marker_group_status=$?
  if [[ ! -s "$marker_group_case/timeout-observed" \
    || ! -s "$marker_group_case/descendant-pid" \
    || ! -s "$marker_group_case/descendant-ready" \
    || ! -s "$marker_group_case/held-marker" ]]; then
    sed -n '1,160p' "$marker_group_case/log" >&2
    for marker_evidence in timeout-observed descendant-pid descendant-ready held-marker; do
      if [[ -e "$marker_group_case/$marker_evidence" ]]; then
        printf '%s=%s-bytes\n' "$marker_evidence" \
          "$(wc -c <"$marker_group_case/$marker_evidence" | tr -d ' ')" >&2
      else
        printf '%s=missing\n' "$marker_evidence" >&2
      fi
    done
    fail "marker deadline fixture omitted timeout, PID, or payload evidence"
  fi
  ((marker_group_status != 0)) \
    || fail "backup succeeded after the marker writer exceeded its deadline"

  # Cleanup has already restored the prior marker and removed the candidate.
  # Releasing a foreground-timeout orphan now deterministically recreates the
  # dangling candidate marker that a process-group timeout must prevent.
  : >"$marker_group_case/release-late-mv"
  /usr/bin/sleep 0.5
  assert_recorded_process_dead "$marker_group_case/descendant-pid" \
    "$marker_group_case/group.identity" "timed-out marker writer"
  /usr/bin/sleep 0.2
  [[ ! -e "$marker_group_case/late-effect" ]] \
    || fail "timed-out marker writer mutated the marker after controller cleanup"
  cmp -s "$marker_group_case/old-marker" "$marker_group_marker" \
    || fail "timed-out marker writer changed the restored marker after cleanup"
  cmp -s "$marker_group_case/old-archive" \
    "$marker_group_case/backups/full/$old_marker_name" \
    && cmp -s "$marker_group_case/old-sidecar" \
      "$marker_group_case/backups/full/$old_marker_name.sha256" \
    || fail "timed-out marker writer changed the prior archive pair"
  [[ "$(find "$marker_group_case/backups/full" -maxdepth 1 -type f \
    -name 'learncoding-full-*.tar.gz.age' | wc -l | tr -d ' ')" == 1 \
    && "$(find "$marker_group_case/backups/full" -maxdepth 1 -type f \
      -name 'learncoding-full-*.tar.gz.age.sha256' | wc -l | tr -d ' ')" == 1 ]] \
    || fail "timed-out marker writer recreated a candidate archive pair"
  grep -Fq 'resume:app' "$marker_group_case/log" \
    || fail "marker writer deadline failure did not resume the captured app"
  if [[ "${TEST_USE_REAL_MANAGED_DEADLINE:-0}" == 1 ]]; then
    [[ -s "$marker_group_case/group.identity" \
      && -s "$marker_group_case/resume-group-checked" \
      && -s "$marker_group_case/first-resume-event" ]] \
      || fail "real marker helper omitted identity or exact-resume absence evidence"
    ! grep -Fq 'backup_monitor_containment_failed' "$marker_group_case/log" \
      || fail "marker deadline assertion was masked by monitor containment failure"
  fi
  assert_case_protected_roots_empty "marker writer deadline failure" "$marker_group_case"
  echo "backup-publication-marker-writer-process-group-tests-ok"
  exit 0
fi

if [[ "$test_group" == migration-parser-deadline ]]; then
  migration_deadline_case="$(make_backup_case publication-migration-parser-deadline)"
  cp "$migration_deadline_case/backups/state/local-last-success.env" \
    "$migration_deadline_case/old-marker"
  migration_status=0
  PATH="$work/bin:$PATH" \
    TEST_MIGRATION_PARSER_FIXTURE=1 \
    TEST_MIGRATION_PARSER_HANG=1 \
    TEST_MIGRATION_PARSE_TIMEOUT=1 \
    TEST_MIGRATION_PRODUCER_COMPLETE="$migration_deadline_case/producer-complete" \
    TEST_MIGRATION_PARSER_STARTED="$migration_deadline_case/parser-started" \
    TEST_MIGRATION_PARSER_OBSERVED="$migration_deadline_case/parser-observed" \
    TEST_MIGRATION_PARSER_PID="$migration_deadline_case/parser-pid" \
    TEST_MIGRATION_PARSER_READY="$migration_deadline_case/parser-ready" \
    TEST_MIGRATION_TIMEOUT_OBSERVED="$migration_deadline_case/timeout-observed" \
    TEST_PROCESS_GROUP_IDENTITY="$migration_deadline_case/group.identity" \
    TEST_RESUME_ABSENT_IDENTITY="$migration_deadline_case/group.identity" \
    TEST_RESUME_GROUP_CHECKED="$migration_deadline_case/resume-group-checked" \
    TEST_FIRST_RESUME_EVENT="$migration_deadline_case/first-resume-event" \
    TEST_EVENT_REPO_ROOT="$fixture_repo" \
    TEST_RUNNING_STATE="$migration_deadline_case/running-state" \
    BACKUP_CONFIG_FILE="$migration_deadline_case/backup.env" \
    bash "$backup_controller" \
    >"$migration_deadline_case/stdout" 2>"$migration_deadline_case/log" \
    || migration_status=$?
  assert_recorded_process_dead "$migration_deadline_case/parser-pid" \
    "$migration_deadline_case/group.identity" "timed-out migration parser"
  [[ -s "$migration_deadline_case/timeout-observed" ]] \
    || fail "migration parser did not execute inside the shared deadline runner"
  if ((migration_status == 0)); then
    fail "backup succeeded after the migration parser exceeded its reserved deadline"
  fi
  [[ -s "$migration_deadline_case/producer-complete" \
    && -s "$migration_deadline_case/parser-observed" \
    && -s "$migration_deadline_case/parser-started" \
    && -s "$migration_deadline_case/parser-ready" \
    && -s "$migration_deadline_case/first-resume-event" ]] \
    || fail "migration parser deadline fixture omitted producer/parser/resume evidence"
  node - "$migration_deadline_case/producer-complete" \
    "$migration_deadline_case/parser-started" \
    "$migration_deadline_case/first-resume-event" <<'EOF'
const fs = require("node:fs");
const [producerPath, startedPath, resumedPath] = process.argv.slice(2);
const produced = BigInt(fs.readFileSync(producerPath, "utf8").trim());
const started = BigInt(fs.readFileSync(startedPath, "utf8").trim());
const resumed = BigInt(fs.readFileSync(resumedPath, "utf8").trim());
if (started < produced || resumed < started || resumed - started > 2_000_000_000n) {
  console.error(
    `migration parser timing evidence was invalid: produced=${produced} started=${started} resumed=${resumed}`,
  );
  process.exit(1);
}
EOF
  cmp -s "$migration_deadline_case/old-marker" \
    "$migration_deadline_case/backups/state/local-last-success.env" \
    || fail "migration parser deadline failure changed the previous marker"
  grep -Fq 'resume:app' "$migration_deadline_case/log" \
    || fail "migration parser deadline failure did not resume captured app"
  if [[ "${TEST_USE_REAL_MANAGED_DEADLINE:-0}" == 1 ]]; then
    [[ -s "$migration_deadline_case/group.identity" \
      && -s "$migration_deadline_case/resume-group-checked" ]] \
      || fail "real parser helper omitted identity or exact-resume absence evidence"
    ! grep -Fq 'backup_monitor_containment_failed' "$migration_deadline_case/log" \
      || fail "parser deadline assertion was masked by monitor containment failure"
  fi
  assert_case_protected_roots_empty "migration parser deadline failure" "$migration_deadline_case"

  if [[ "${TEST_USE_REAL_MANAGED_DEADLINE:-0}" == 1 ]]; then
    migration_producer_case="$(make_backup_case publication-migration-producer-deadline)"
    cp "$migration_producer_case/backups/state/local-last-success.env" \
      "$migration_producer_case/old-marker"
    migration_producer_status=0
    PATH="$work/bin:$PATH" \
      TEST_MIGRATION_PRODUCER_HANG=1 \
      TEST_MIGRATION_PRODUCER_PID="$migration_producer_case/producer-pid" \
      TEST_MIGRATION_PRODUCER_READY="$migration_producer_case/producer-ready" \
      TEST_MIGRATION_TIMEOUT_OBSERVED="$migration_producer_case/timeout-observed" \
      TEST_PROCESS_GROUP_IDENTITY="$migration_producer_case/group.identity" \
      TEST_RESUME_ABSENT_IDENTITY="$migration_producer_case/group.identity" \
      TEST_RESUME_GROUP_CHECKED="$migration_producer_case/resume-group-checked" \
      TEST_FIRST_RESUME_EVENT="$migration_producer_case/first-resume-event" \
      TEST_EVENT_REPO_ROOT="$fixture_repo" \
      TEST_RUNNING_STATE="$migration_producer_case/running-state" \
      BACKUP_CONFIG_FILE="$migration_producer_case/backup.env" \
      bash "$backup_controller" \
      >"$migration_producer_case/stdout" 2>"$migration_producer_case/log" \
      || migration_producer_status=$?
    assert_recorded_process_dead "$migration_producer_case/producer-pid" \
      "$migration_producer_case/group.identity" "timed-out migration producer"
    ((migration_producer_status != 0)) \
      || fail "backup succeeded after the migration producer exceeded its deadline"
    [[ -s "$migration_producer_case/timeout-observed" \
      && -s "$migration_producer_case/group.identity" \
      && -s "$migration_producer_case/producer-ready" \
      && -s "$migration_producer_case/resume-group-checked" \
      && -s "$migration_producer_case/first-resume-event" ]] \
      || fail "migration producer deadline omitted timeout/identity/resume evidence"
    cmp -s "$migration_producer_case/old-marker" \
      "$migration_producer_case/backups/state/local-last-success.env" \
      || fail "migration producer deadline failure changed the previous marker"
    grep -Fq 'resume:app' "$migration_producer_case/log" \
      || fail "migration producer deadline failure did not resume captured app"
    assert_case_protected_roots_empty "migration producer deadline failure" "$migration_producer_case"
    ! grep -Fq 'backup_monitor_containment_failed' "$migration_producer_case/log" \
      || fail "producer deadline assertion was masked by monitor containment failure"
  fi

  migration_large_case="$(make_backup_case publication-migration-large-summary)"
  cp "$migration_large_case/backups/state/local-last-success.env" \
    "$migration_large_case/old-marker"
  if ! PATH="$work/bin:$PATH" \
    TEST_MIGRATION_PARSER_FIXTURE=1 \
    TEST_MIGRATION_LARGE_COUNT=50000 \
    TEST_MIGRATION_PRODUCER_COMPLETE="$migration_large_case/producer-complete" \
    TEST_MIGRATION_PARSER_STARTED="$migration_large_case/parser-started" \
    TEST_MIGRATION_PARSER_OBSERVED="$migration_large_case/parser-observed" \
    TEST_MIGRATION_SUMMARY_CAPTURE="$migration_large_case/summary" \
    TEST_MIGRATION_PARSER_ERROR="$migration_large_case/parser-error" \
    TEST_EVENT_REPO_ROOT="$fixture_repo" \
    TEST_RUNNING_STATE="$migration_large_case/running-state" \
    BACKUP_CONFIG_FILE="$migration_large_case/backup.env" \
    bash "$backup_controller" \
    >"$migration_large_case/stdout" 2>"$migration_large_case/log"; then
    sed -n '1,100p' "$migration_large_case/log" >&2
    for evidence in producer-complete parser-started parser-observed parser-error summary; do
      if [[ -e "$migration_large_case/$evidence" ]]; then
        printf '%s=' "$evidence" >&2
        head -c 300 -- "$migration_large_case/$evidence" >&2
        printf '\n' >&2
      else
        printf '%s=missing\n' "$evidence" >&2
      fi
    done
    fail "bounded migration summary rejected a valid large result"
  fi
  [[ -s "$migration_large_case/producer-complete" \
    && -s "$migration_large_case/parser-started" \
    && -s "$migration_large_case/parser-observed" \
    && -s "$migration_large_case/summary" ]] \
    || fail "large migration summary omitted producer/parser evidence"
  summary_bytes="$(wc -c <"$migration_large_case/summary" | tr -d ' ')"
  summary_lines="$(wc -l <"$migration_large_case/summary" | tr -d ' ')"
  [[ "$summary_bytes" =~ ^[0-9]+$ && "$summary_bytes" -le 160 \
    && "$summary_lines" == 1 ]] \
    || fail "migration parent received an unbounded summary: ${summary_bytes} bytes/${summary_lines} lines"
  summary_value="$(<"$migration_large_case/summary")"
  [[ "$summary_value" =~ ^50000\|50000\|51000\|[0-9a-f]{64}$ ]] \
    || fail "migration parent received a noncanonical fixed summary"
  if cmp -s "$migration_large_case/old-marker" \
    "$migration_large_case/backups/state/local-last-success.env"; then
    fail "large migration summary did not commit a recovery point"
  fi
  migration_large_archive="$(find "$migration_large_case/backups/full" \
    -maxdepth 1 -type f -name 'learncoding-full-*.tar.gz.age' \
    -printf '%T@ %p\n' | sort -nr | head -n1 | cut -d' ' -f2-)"
  tar -xOzf "$migration_large_archive" MANIFEST.txt \
    >"$migration_large_case/manifest"
  grep -Fxq 'migration_count=50000' "$migration_large_case/manifest" \
    && grep -Fxq 'migration_last_id=50000' "$migration_large_case/manifest" \
    && grep -Fxq 'migration_last_created_at=51000' "$migration_large_case/manifest" \
    || fail "large migration summary was not transferred into the manifest"
  if grep -Eq '^[0-9]+\|[0-9a-f]{64}\|[0-9]+$' \
    "$migration_large_case/stdout" "$migration_large_case/log"; then
    fail "raw migration rows escaped the deadline child"
  fi
  echo "backup-publication-migration-parser-deadline-tests-ok"
  exit 0
fi

if [[ "$test_group" == m3-budget-exhaustion ]]; then
  assert_budget_exhaustion_resumes
  echo "backup-publication-m3-budget-exhaustion-tests-ok"
  exit 0
fi

if [[ "$test_group" == all || "$test_group" == m9-bounded-event-audit ]]; then
  audit_deadline_case="$(make_backup_case publication-event-audit-deadline)"
  cp "$audit_deadline_case/backups/state/local-last-success.env" \
    "$audit_deadline_case/old-marker"
  if PATH="$work/bin:$PATH" \
    TEST_EVENT_AUDIT_TERM_IGNORING_CHILD=1 \
    TEST_EVENT_AUDIT_TIMEOUT_STATE="$audit_deadline_case/audit-timeout-state" \
    TEST_BLOCK_CANDIDATE_CLEANUP=1 \
    TEST_HUNG_CHILD_STARTED="$audit_deadline_case/hung-child-started" \
    TEST_FIRST_RESUME_EVENT="$audit_deadline_case/first-resume-event" \
    TEST_TIMEOUT_GRACE_VIOLATION="$audit_deadline_case/timeout-grace-violation" \
    TEST_TIMEOUT_DEBUG_FILE="$audit_deadline_case/timeout-debug" \
    TEST_EVENT_REPO_ROOT="$fixture_repo" \
    TEST_RUNNING_STATE="$audit_deadline_case/running-state" \
    BACKUP_CONFIG_FILE="$audit_deadline_case/backup.env" \
    bash "$backup_controller" \
    >"$audit_deadline_case/stdout" 2>"$audit_deadline_case/log"; then
    fail "backup succeeded when the bounded event audit ignored TERM"
  fi
  if [[ ! -s "$audit_deadline_case/hung-child-started" \
    || ! -s "$audit_deadline_case/first-resume-event" ]]; then
    sed -n '1,160p' "$audit_deadline_case/log" >&2
    find "$audit_deadline_case/event-monitor" -maxdepth 1 -type f \
      -print -exec sed -n '1,80p' {} \; >&2 2>/dev/null || true
    sed -n '1,120p' "$audit_deadline_case/timeout-debug" >&2 2>/dev/null || true
    fail "event-audit deadline fixture omitted the hung audit or first resume"
  fi
  [[ ! -e "$audit_deadline_case/timeout-grace-violation" ]] \
    || fail "event audit received a timeout outside the 600-second ceiling"
  node - "$audit_deadline_case/hung-child-started" \
    "$audit_deadline_case/first-resume-event" <<'EOF'
const fs = require("node:fs");
const [startedPath, resumedPath] = process.argv.slice(2);
const started = BigInt(fs.readFileSync(startedPath, "utf8").trim());
const resumed = BigInt(fs.readFileSync(resumedPath, "utf8").trim());
if (resumed < started || resumed - started > 2_000_000_000n) process.exit(1);
EOF
  cmp -s "$audit_deadline_case/old-marker" \
    "$audit_deadline_case/backups/state/local-last-success.env" \
    || fail "event-audit deadline failure changed the previous success marker"
  grep -Fq 'resume:app' "$audit_deadline_case/log" \
    || fail "event-audit deadline failure did not attempt app resume first"

  assert_precommit_failure event-audit-oversized true \
    TEST_EVENT_LINE_LIMIT=1 TEST_EVENT_SCENARIO=oversized-log \
    TEST_EVENT_REPO_ROOT="$fixture_repo"
  oversized_event_case="$last_precommit_failure_case"
  [[ -s "$oversized_event_case/event-monitor/line-cap-wait-started" \
    && -s "$oversized_event_case/event-monitor/oversized-checkpoint-blocked" ]] \
    || fail "oversized event fixture did not block before checkpoint 3"
  [[ "$(<"$oversized_event_case/event-monitor/audit-invocation-count")" == 2 \
    && ! -e "$oversized_event_case/event-monitor/audit-3-boundary" \
    && ! -e "$oversized_event_case/event-monitor/audit-3-state" ]] \
    || fail "oversized event log reached semantic audit instead of failing in checkpoint wait"
  oversized_event_lines="$(wc -l \
    <"$oversized_event_case/event-monitor/emitted-bytes" | tr -d ' ')"
  oversized_event_bytes="$(wc -c \
    <"$oversized_event_case/event-monitor/emitted-bytes" | tr -d ' ')"
  [[ "$oversized_event_lines" =~ ^[0-9]+$ \
    && "$oversized_event_bytes" =~ ^[0-9]+$ ]] \
    || fail "oversized event fixture produced nonnumeric bounds"
  ((oversized_event_lines > 4096 && oversized_event_bytes <= 1048576)) \
    || fail "oversized event fixture did not isolate the complete-line limit"
  if grep -Fq '|checkpoint-3||' \
    "$oversized_event_case/event-monitor/emitted-bytes"; then
    fail "oversized event fixture emitted checkpoint 3 before line-cap rejection"
  fi
fi

if [[ "$test_group" == m9-bounded-event-audit ]]; then
  echo "backup-publication-m9-bounded-event-audit-tests-ok"
  exit 0
fi

for controller_mutation in outer-list unsafe-path unsafe-type internal-checksum manifest; do
  assert_precommit_failure "controller-$controller_mutation" true \
    TEST_CONTROLLER_ENVELOPE_MUTATION="$controller_mutation" \
    TEST_ENVELOPE_MUTATOR="$work/bin/mutate-envelope"
done

if [[ "$test_group" == m6-controller-verifier-failures ]]; then
  echo "backup-publication-m6-controller-tests-ok"
  exit 0
fi

success_case="$(make_backup_case publication-success)"
if ! PATH="$work/bin:$PATH" TEST_CREATED_OPTIONAL_SERVICE=lifecycle \
  TEST_RUNNING_STATE="$success_case/running-state" \
  BACKUP_CONFIG_FILE="$success_case/backup.env" \
  bash "$backup_controller" >"$success_case/stdout" 2>"$success_case/log"; then
  sed -n '1,80p' "$success_case/log" >&2
  fail "valid full publication fixture failed"
fi
for phase in quiesced dump_complete objects_complete encrypted candidate_verified \
  files_published marker_committed pruning resuming resumed; do
  [[ -n "$(phase_line "$phase" "$success_case/log")" ]] \
    || fail "successful publication omitted phase=$phase"
done
previous=0
for phase in quiesced dump_complete objects_complete encrypted candidate_verified \
  files_published marker_committed pruning resuming resumed; do
  current="$(phase_line "$phase" "$success_case/log")"
  (( current > previous )) || fail "successful publication phase order is unsafe"
  previous="$current"
done
success_marker="$success_case/backups/state/local-last-success.env"
success_name="$(sed -n 's/^SUCCESS_ARCHIVE=//p' "$success_marker")"
success_hash="$(sed -n 's/^SUCCESS_SHA256=//p' "$success_marker")"
[[ "$success_name" =~ ^learncoding-full-[0-9]{8}T[0-9]{6}Z\.tar\.gz\.age$ ]]
[[ "$success_hash" == "$(sha256sum "$success_case/backups/full/$success_name" | awk '{print $1}')" ]]
[[ -f "$success_case/backups/full/$success_name.sha256" ]]
[[ "$(<"$success_case/backups/full/$success_name.sha256")" == "$success_hash  $success_name" ]] \
  || fail "successful publication wrote a noncanonical ciphertext sidecar"
if [[ "${OSTYPE:-}" != msys* ]]; then
  [[ "$(stat -c '%a' "$success_marker")" == 600 ]]
  [[ "$(stat -c '%a' "$success_case/backups/full/$success_name")" == 600 ]]
  [[ "$(stat -c '%a' "$success_case/backups/full/$success_name.sha256")" == 600 ]]
fi
[[ -z "$(find "$success_case/stage" "$success_case/runtime" -mindepth 1 -print -quit)" ]]
grep -Fq 'resume:cloudflared' "$success_case/log" \
  || fail "cloudflared was not resumed last"
if grep -Eq 'resume:(postgres|reward-worker|regrade-worker|mail-worker)' "$success_case/log"; then
  fail "successful publication resumed a service absent from the captured set"
fi
[[ "$(grep -c '^resume:' "$success_case/log")" == 2 ]] \
  || fail "successful publication did not resume exactly the captured set"
if grep -Eq 'stop.*postgres|offsite-sync' "$success_case/log"; then
  fail "successful publication stopped PostgreSQL or invoked offsite sync"
fi

for conflicting_service in migrate lifecycle platform-seed admin-bootstrap unknown-service; do
  conflict_case="$(make_backup_case "publication-conflict-$conflicting_service")"
  cp "$conflict_case/backups/state/local-last-success.env" "$conflict_case/old-marker"
  if PATH="$work/bin:$PATH" \
    TEST_RUNNING_SERVICES="postgres app $conflicting_service cloudflared" \
    TEST_RUNNING_STATE="$conflict_case/running-state" \
    BACKUP_CONFIG_FILE="$conflict_case/backup.env" \
    bash "$backup_controller" \
    >"$conflict_case/stdout" 2>"$conflict_case/log"; then
    fail "backup accepted running conflict $conflicting_service"
  fi
  cmp -s "$conflict_case/old-marker" "$conflict_case/backups/state/local-last-success.env" \
    || fail "$conflicting_service conflict changed the previous success marker"
  if grep -Fxq dump "$conflict_case/log"; then
    fail "$conflicting_service conflict reached the database dump"
  fi
done

race_case="$(make_backup_case publication-mutator-race)"
cp "$race_case/backups/state/local-last-success.env" "$race_case/old-marker"
if PATH="$work/bin:$PATH" TEST_NEW_MUTATOR_AFTER_CAPTURE=1 \
  TEST_RUNNING_QUERY_STATE="$race_case/running-query-state" \
  BACKUP_CONFIG_FILE="$race_case/backup.env" \
  bash "$backup_controller" >"$race_case/stdout" 2>"$race_case/log"; then
  fail "backup accepted a mutator that started after running-set capture"
fi
cmp -s "$race_case/old-marker" "$race_case/backups/state/local-last-success.env" \
  || fail "mutator-race failure changed the previous success marker"
if grep -Fxq dump "$race_case/log"; then
  fail "mutator-race failure reached the database dump"
fi

assert_precommit_failure repository-packaging false TEST_REPOSITORY_TAR_FAIL=1
assert_precommit_failure probe false TEST_PROBE_FAIL=1
assert_precommit_failure quiesce true TEST_QUIESCE_FAIL=1
assert_precommit_failure migration-query true TEST_MIGRATION_FAIL=1
assert_precommit_failure dump true TEST_DUMP_FAIL=1
assert_precommit_failure object-packaging true TEST_APP_TAR_FAIL=1
assert_precommit_failure encryption true TEST_AGE_ENCRYPT_FAIL=1
assert_precommit_failure decryption true TEST_AGE_DECRYPT_FAIL=1
assert_precommit_failure sidecar-creation true TEST_SIDECAR_CREATE_FAIL=1
assert_precommit_failure archive-rename true TEST_ARCHIVE_RENAME_FAIL=1
assert_precommit_failure sidecar-rename true TEST_FULL_SIDECAR_RENAME_FAIL=1
assert_precommit_failure marker-write true TEST_MARKER_RENAME_FAIL=1

assert_budget_exhaustion_resumes

prune_case="$(make_backup_case publication-prune-failure)"
cp "$prune_case/backups/state/local-last-success.env" "$prune_case/old-marker"
if PATH="$work/bin:$PATH" TEST_PRUNE_FAIL=1 \
  TEST_RUNNING_STATE="$prune_case/running-state" \
  BACKUP_CONFIG_FILE="$prune_case/backup.env" \
  bash "$backup_controller" >"$prune_case/stdout" 2>"$prune_case/log"; then
  fail "backup reported success after post-marker prune failure"
fi
if cmp -s "$prune_case/old-marker" "$prune_case/backups/state/local-last-success.env"; then
  fail "post-marker prune failure rolled back the valid publication"
fi
prune_name="$(sed -n 's/^SUCCESS_ARCHIVE=//p' "$prune_case/backups/state/local-last-success.env")"
[[ -f "$prune_case/backups/full/$prune_name" \
  && -f "$prune_case/backups/full/$prune_name.sha256" ]] \
  || fail "post-marker prune failure removed the committed recovery point"
grep -Fq 'resume:app' "$prune_case/log" \
  || fail "post-marker prune failure did not resume the captured app"
grep -Fq 'event=backup_post_commit_failed' "$prune_case/log" \
  || fail "post-marker prune failure omitted the fixed post-commit alert"

resume_case="$(make_backup_case publication-resume-failure)"
cp "$resume_case/backups/state/local-last-success.env" "$resume_case/old-marker"
if PATH="$work/bin:$PATH" TEST_RESUME_FAIL=1 \
  TEST_RUNNING_STATE="$resume_case/running-state" \
  BACKUP_CONFIG_FILE="$resume_case/backup.env" \
  bash "$backup_controller" >"$resume_case/stdout" 2>"$resume_case/log"; then
  fail "backup reported success after resume failure"
fi
if cmp -s "$resume_case/old-marker" "$resume_case/backups/state/local-last-success.env"; then
  fail "post-marker resume failure rolled back the valid publication"
fi
resume_name="$(sed -n 's/^SUCCESS_ARCHIVE=//p' "$resume_case/backups/state/local-last-success.env")"
[[ -f "$resume_case/backups/full/$resume_name" && -f "$resume_case/backups/full/$resume_name.sha256" ]]

# The probe package command writes a sealed, reopenable schema without storing
# the random plaintext, and safely replaces only regular outputs.
probe_key="$work/probe-master-key"
node -e "process.stdout.write(Buffer.alloc(32, 7).toString('base64'))" >"$probe_key"
chmod 0440 "$probe_key"
probe_output="$work/credential-probe.json"
probe_log="$(cd "$repo_root" && npm run --silent backup:credential-probe -- "$probe_output" "$probe_key")"
[[ "$probe_log" == credential_probe_created=true ]] \
  || fail "credential probe emitted a noncanonical result"
cp "$probe_output" "$work/first-credential-probe.json"
probe_log="$(cd "$repo_root" && npm run --silent backup:credential-probe -- "$probe_output" "$probe_key")"
[[ "$probe_log" == credential_probe_created=true ]] \
  || fail "credential probe atomic replacement emitted a noncanonical result"
if cmp -s "$work/first-credential-probe.json" "$probe_output"; then
  fail "credential probe replacement reused random plaintext"
fi
[[ -z "$(find "$work" -maxdepth 1 -type f \
  -name '.credential-probe.json.tmp.*' -print -quit)" ]] \
  || fail "credential probe replacement left a temporary"
if [[ "${OSTYPE:-}" != msys* ]]; then
  [[ "$(stat -c '%a' "$probe_output")" == 600 ]] \
    || fail "credential probe output mode is not 0600"
fi
node --import tsx --input-type=module - "$probe_output" "$probe_key" <<'EOF'
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import credentialVault from "./src/lib/security/credential-vault.ts";

const { openCredential, parseMasterKey } = credentialVault;

const [outputPath, keyPath] = process.argv.slice(2);
const value = JSON.parse(await readFile(outputPath, "utf8"));
const expectedKeys = ["context", "plaintextSha256", "sealed", "version"];
if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(expectedKeys)) process.exit(2);
if ("plaintext" in value || value.version !== 1) process.exit(3);
const expectedContext = {
  credentialId: "00000000-0000-4000-8000-000000000001",
  userId: "backup-recovery-probe",
  provider: "nvidia_nim",
  keyVersion: 1,
};
if (JSON.stringify(value.context) !== JSON.stringify(expectedContext)) process.exit(5);
const expectedSealedKeys = [
  "authTag", "ciphertext", "dataIv", "keyVersion", "lastFour", "wrapIv", "wrappedDataKey",
];
if (JSON.stringify(Object.keys(value.sealed).sort()) !== JSON.stringify(expectedSealedKeys)) process.exit(6);
if (!/^[0-9a-f]{64}$/.test(value.plaintextSha256) || value.sealed.keyVersion !== 1) process.exit(7);
const master = parseMasterKey((await readFile(keyPath, "utf8")).trim());
try {
  const plaintext = openCredential(value.sealed, value.context, master);
  const actual = createHash("sha256").update(plaintext, "utf8").digest("hex");
  if (actual !== value.plaintextSha256) process.exit(4);
  if (!/^[A-Za-z0-9_-]{43}$/.test(plaintext) || value.sealed.lastFour !== plaintext.slice(-4)) process.exit(8);
} finally {
  master.fill(0);
}
EOF

printf malformed >"$work/bad-probe-key"
chmod 0440 "$work/bad-probe-key"
if (cd "$repo_root" && npm run --silent backup:credential-probe -- \
  "$work/bad-probe.json" "$work/bad-probe-key") >/dev/null 2>&1; then
  fail "credential probe accepted a malformed master key"
fi
[[ ! -e "$work/bad-probe.json" ]] || fail "failed credential probe left a partial output"

cp "$probe_output" "$work/probe-before-failed-replacement.json"
if (cd "$repo_root" && npm run --silent backup:credential-probe -- \
  "$probe_output" "$work/bad-probe-key") >/dev/null 2>&1; then
  fail "credential probe replaced a valid output with a malformed-key result"
fi
cmp -s "$work/probe-before-failed-replacement.json" "$probe_output" \
  || fail "failed credential probe replacement changed the previous output"

mkdir "$work/probe-directory-output"
if (cd "$repo_root" && npm run --silent backup:credential-probe -- \
  "$work/probe-directory-output" "$probe_key") >/dev/null 2>&1; then
  fail "credential probe accepted a directory output"
fi
[[ -d "$work/probe-directory-output" ]]

ln -s "$probe_key" "$work/probe-symlink-key"
if [[ -L "$work/probe-symlink-key" ]]; then
  if (cd "$repo_root" && npm run --silent backup:credential-probe -- \
    "$work/probe-from-symlink-key.json" "$work/probe-symlink-key") >/dev/null 2>&1; then
    fail "credential probe accepted a symlinked master key"
  fi
  [[ ! -e "$work/probe-from-symlink-key.json" ]]
fi

printf sentinel >"$work/probe-symlink-target"
ln -s "$work/probe-symlink-target" "$work/probe-symlink-output"
if [[ -L "$work/probe-symlink-output" ]]; then
  if (cd "$repo_root" && npm run --silent backup:credential-probe -- \
    "$work/probe-symlink-output" "$probe_key") >/dev/null 2>&1; then
    fail "credential probe accepted a symlink output"
  fi
  [[ "$(cat "$work/probe-symlink-target")" == sentinel ]] \
    || fail "credential probe modified a symlink target"
else
  # Git Bash without Windows symlink privileges copies the target. The real
  # symlink assertion remains mandatory and unchanged on Ubuntu.
  rm -f -- "$work/probe-symlink-output"
fi

echo "backup-publication-tests-ok"
