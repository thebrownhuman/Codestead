#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
pruner="$repo_root/scripts/backup/prune-offsite.sh"

fail() {
  printf 'offsite-retention-test-failed: %s\n' "$1" >&2
  exit 1
}

[[ -f "$pruner" && ! -L "$pruner" ]] \
  || fail "independent offsite retention command is missing"
if grep -Eq 'run_rclone[[:space:]]+(sync|purge|cleanup|delete)([[:space:]]|$)' "$pruner"; then
  fail "offsite retention contains a forbidden broad mutation command"
fi

work="$(mktemp -d)"
trap 'rm -rf -- "$work"' EXIT
mkdir -m 0700 -p "$work/bin" "$work/remote" "$work/trash" \
  "$work/backup/full" "$work/backup/state" "$work/stage" "$work/data"
printf '%s\n' LEARNCODING_BACKUP_V1 >"$work/backup/.learncoding-backup-root"
chmod 0600 "$work/backup/.learncoding-backup-root"

cat >"$work/bin/rclone" <<'RCLONE'
#!/usr/bin/env bash
set -Eeuo pipefail
operation="${1:-}"
shift || true
map_active() {
  local value="$1"
  if [[ "$value" == fake:* ]]; then
    value="${value#fake:}"
    printf '%s/%s\n' "$FAKE_REMOTE_ROOT" "${value#/}"
  else
    printf '%s\n' "$value"
  fi
}
relative_active() {
  local value
  value="$(map_active "$1")"
  value="${value#"$FAKE_REMOTE_ROOT"/}"
  printf '%s\n' "$value"
}
printf '%s\n' "$operation $*" >>"$FAKE_RCLONE_LOG"
case "$operation" in
  copyto)
    source_path="$(map_active "$1")"
    destination_path="$(map_active "$2")"
    mkdir -p -- "$(dirname -- "$destination_path")"
    cp -- "$source_path" "$destination_path"
    if [[ "${FAKE_AMBIGUOUS_OPERATION:-}" == copyto \
      && "$2" == fake:*/state/retention/.*.pending \
      && ! -e "${FAKE_FAULT_SENTINEL:-/nonexistent}" ]]; then
      : >"$FAKE_FAULT_SENTINEL"
      exit 75
    fi
    ;;
  moveto)
    source_path="$(map_active "$1")"
    destination_path="$(map_active "$2")"
    if [[ "${FAKE_FAIL_MOVE_BEFORE_EFFECT:-0}" == 1 \
      && "$2" == fake:*/state/retention/*.journal ]]; then
      exit 75
    fi
    mkdir -p -- "$(dirname -- "$destination_path")"
    mv -- "$source_path" "$destination_path"
    if [[ "${FAKE_AMBIGUOUS_OPERATION:-}" == moveto \
      && "$2" == fake:*/state/retention/*.journal \
      && ! -e "${FAKE_FAULT_SENTINEL:-/nonexistent}" ]]; then
      : >"$FAKE_FAULT_SENTINEL"
      exit 75
    fi
    ;;
  lsf)
    target="$1"
    target_path="$(map_active "$target")"
    trashed=0
    for argument in "$@"; do
      [[ "$argument" != --drive-trashed-only=true ]] || trashed=1
    done
    if ((trashed)); then
      target_relative="$(relative_active "$target")"
      trash_target="$FAKE_TRASH_ROOT/$target_relative"
      [[ -d "$trash_target" ]] \
        && find "$trash_target" -type f -printf '%P\n' | LC_ALL=C sort
      exit 0
    fi
    if [[ -f "$target_path" ]]; then
      basename -- "$target_path"
    elif [[ -d "$target_path" ]]; then
      find "$target_path" -type f -printf '%P\n' | LC_ALL=C sort
    fi
    ;;
  deletefile)
    target="$1"
    shift
    found_trash_flag=0
    for argument in "$@"; do
      [[ "$argument" != --drive-use-trash=true ]] || found_trash_flag=1
    done
    ((found_trash_flag)) || exit 91
    if [[ "${FAKE_FAIL_BEFORE_DELETE_ONCE:-0}" == 1 \
      && ! -e "${FAKE_FAULT_SENTINEL:-/nonexistent}" ]]; then
      : >"$FAKE_FAULT_SENTINEL"
      exit 75
    fi
    source_path="$(map_active "$target")"
    relative="$(relative_active "$target")"
    [[ -f "$source_path" ]] || exit 3
    destination_path="$FAKE_TRASH_ROOT/$relative"
    mkdir -p -- "$(dirname -- "$destination_path")"
    mv -- "$source_path" "$destination_path"
    if [[ "${FAKE_AMBIGUOUS_OPERATION:-}" == deletefile \
      && ! -e "${FAKE_FAULT_SENTINEL:-/nonexistent}" ]]; then
      : >"$FAKE_FAULT_SENTINEL"
      exit 75
    fi
    ;;
  *) exit 64 ;;
esac
RCLONE
chmod 0700 "$work/bin/rclone"

config="$work/backup.env"
rclone_config="$work/rclone.conf"
printf '[fake]\ntype = local\n' >"$rclone_config"
chmod 0600 "$rclone_config"
cat >"$config" <<EOF
REPO_ROOT=$repo_root
COMPOSE_ENV_FILE=$work/compose.env
LEARN_DATA_ROOT=$work/data
BACKUP_ROOT=$work/backup
BACKUP_STAGE_ROOT=$work/stage
BACKUP_LOCK_FILE=$work/backup.lock
RCLONE_REMOTE=fake:/codestead/backups
RCLONE_CONFIG=$rclone_config
FILESYSTEM_WARN_PERCENT=70
FILESYSTEM_CRITICAL_PERCENT=99
EOF
chmod 0600 "$config"

add_obsolete_point() {
  local timestamp="$1" archive hash
  archive="learncoding-full-$timestamp.tar.gz.age"
  printf 'adversarial-ciphertext-%s\n' "$timestamp" >"$remote_base/full/$archive"
  hash="$(sha256sum "$remote_base/full/$archive" | awk '{print $1}')"
  printf '%s  %s\n' "$hash" "$archive" >"$remote_base/full/$archive.sha256"
  cat >"$remote_base/state/points/$archive.env" <<EOF
SUCCESS_ARCHIVE=$archive
SUCCESS_COMPLETED_UTC=$timestamp
SUCCESS_SHA256=$hash
EOF
  printf '%s\n' "$archive"
}

remote_base="$work/remote/codestead/backups"
mkdir -m 0700 -p "$remote_base/full" "$remote_base/state/points" \
  "$remote_base/state/retention"
archives=()
for month_offset in $(seq 0 14); do
  timestamp="$(date -u -d "2026-07-15 01:02:03 UTC -$month_offset months" +%Y%m%dT%H%M%SZ)"
  archive="learncoding-full-$timestamp.tar.gz.age"
  archives+=("$archive")
  printf 'ciphertext-%s\n' "$month_offset" >"$remote_base/full/$archive"
  hash="$(sha256sum "$remote_base/full/$archive" | awk '{print $1}')"
  printf '%s  %s\n' "$hash" "$archive" >"$remote_base/full/$archive.sha256"
  cat >"$remote_base/state/points/$archive.env" <<EOF
SUCCESS_ARCHIVE=$archive
SUCCESS_COMPLETED_UTC=$timestamp
SUCCESS_SHA256=$hash
EOF
done
cp "$remote_base/state/points/${archives[0]}.env" "$remote_base/state/LAST_SUCCESS"
cp "$remote_base/state/LAST_SUCCESS" "$work/pointer-before"

# Complete but unattested upload debris must never be selected or deleted.
debris="learncoding-full-20200101T000000Z.tar.gz.age"
printf debris >"$remote_base/full/$debris"
printf '%064d  %s\n' 0 "$debris" >"$remote_base/full/$debris.sha256"

run_env=(
  "PATH=$work/bin:$PATH"
  "FAKE_REMOTE_ROOT=$work/remote"
  "FAKE_TRASH_ROOT=$work/trash"
  "FAKE_RCLONE_LOG=$work/rclone.log"
  "BACKUP_CONFIG_FILE=$config"
)
env "${run_env[@]}" bash "$pruner"

cmp -s "$remote_base/state/LAST_SUCCESS" "$work/pointer-before" \
  || fail "retention changed the verified publication pointer"
[[ -f "$remote_base/full/$debris" && -f "$remote_base/full/$debris.sha256" ]] \
  || fail "retention deleted unattested upload debris"
[[ -z "$(find "$remote_base/state/retention" -type f -print -quit)" ]] \
  || fail "successful retention left a pending transaction journal"

active_committed=0
trashed_committed=0
for archive in "${archives[@]}"; do
  if [[ -f "$remote_base/state/points/$archive.env" ]]; then
    ((active_committed+=1))
    [[ -f "$remote_base/full/$archive" && -f "$remote_base/full/$archive.sha256" ]] \
      || fail "retention left a partial active recovery point"
  else
    ((trashed_committed+=1))
    [[ -f "$work/trash/codestead/backups/full/$archive" \
      && -f "$work/trash/codestead/backups/full/$archive.sha256" \
      && -f "$work/trash/codestead/backups/state/points/$archive.env" ]] \
      || fail "retention did not trash the complete obsolete triplet"
  fi
done
[[ "$active_committed" -eq 12 && "$trashed_committed" -eq 3 ]] \
  || fail "retention did not preserve the deterministic twelve-month union"

report="$work/backup/state/offsite-retention-last-report.txt"
[[ -f "$report" && ! -L "$report" && "$(stat -c '%a:%u' "$report")" == 600:0 ]] \
  || fail "sanitized retention report metadata is unsafe"
grep -Fxq 'result=pass' "$report" || fail "retention report is not passing"
grep -Fxq 'policy=7-daily-4-weekly-12-monthly' "$report" \
  || fail "retention report omitted its exact policy"
if grep -Eiq '(token|credential|config=|drive_id|ciphertext_sha)' "$report"; then
  fail "retention report contains forbidden sensitive fields"
fi

while IFS= read -r line; do
  [[ "$line" != deletefile* ]] || [[ "$line" == *'--drive-use-trash=true'* ]] \
    || fail "retention delete omitted explicit Google Drive trash semantics"
done <"$work/rclone.log"
if grep -Eq '^(sync|purge|cleanup|delete) ' "$work/rclone.log"; then
  fail "retention invoked a forbidden broad remote mutation"
fi

delete_count_before="$(grep -c '^deletefile ' "$work/rclone.log" || true)"
env "${run_env[@]}" bash "$pruner"
delete_count_after="$(grep -c '^deletefile ' "$work/rclone.log" || true)"
[[ "$delete_count_after" -eq "$delete_count_before" ]] \
  || fail "idempotent retention rerun trashed additional objects"
reported_after_retry="$(sed -n 's/^trashed_recovery_points=//p' "$report")"
[[ "$(tr ',' '\n' <<<"$reported_after_retry" | sed '/^$/d' | wc -l)" -eq 3 ]] \
  || fail "idempotent retention report omitted previously trashed recovery points"

fault_index=0
for operation in copyto moveto deletefile; do
  ((fault_index+=1))
  timestamp="$(printf '199%01d0101T000000Z' "$fault_index")"
  fault_archive="$(add_obsolete_point "$timestamp")"
  fault_sentinel="$work/fault-$operation"
  env "${run_env[@]}" \
    "FAKE_AMBIGUOUS_OPERATION=$operation" \
    "FAKE_FAULT_SENTINEL=$fault_sentinel" \
    bash "$pruner" \
    || fail "retention did not reconcile an ambiguous $operation result"
  [[ -f "$fault_sentinel" ]] || fail "ambiguous $operation fault was not exercised"
  [[ ! -e "$remote_base/full/$fault_archive" \
    && ! -e "$remote_base/full/$fault_archive.sha256" \
    && ! -e "$remote_base/state/points/$fault_archive.env" ]] \
    || fail "ambiguous $operation reconciliation left an active recovery-point object"
  [[ -f "$work/trash/codestead/backups/full/$fault_archive" \
    && -f "$work/trash/codestead/backups/full/$fault_archive.sha256" \
    && -f "$work/trash/codestead/backups/state/points/$fault_archive.env" ]] \
    || fail "ambiguous $operation reconciliation did not trash the complete triplet"
done

crash_archive="$(add_obsolete_point 19800101T000000Z)"
crash_sentinel="$work/fault-before-delete"
if env "${run_env[@]}" FAKE_FAIL_BEFORE_DELETE_ONCE=1 \
  "FAKE_FAULT_SENTINEL=$crash_sentinel" bash "$pruner" >/dev/null 2>&1; then
  fail "pre-delete crash fixture unexpectedly completed"
fi
[[ "$(find "$remote_base/state/retention" -type f -name '*.journal' | wc -l)" -eq 1 ]] \
  || fail "pre-delete crash did not retain one committed reconciliation journal"
env "${run_env[@]}" bash "$pruner" \
  || fail "retention did not reconcile the prior committed journal"
tr ',' '\n' < <(sed -n 's/^trashed_recovery_points=//p' "$report") \
  | grep -Fxq "$crash_archive" \
  || fail "reconciled prior journal target was omitted from the retention report"

pending_crash_archive="$(add_obsolete_point 19700101T000000Z)"
if env "${run_env[@]}" FAKE_FAIL_MOVE_BEFORE_EFFECT=1 \
  bash "$pruner" >/dev/null 2>&1; then
  fail "pending-journal crash fixture unexpectedly completed"
fi
[[ "$(find "$remote_base/state/retention" -type f -name '.*.pending' | wc -l)" -eq 1 \
  && "$(find "$remote_base/state/retention" -type f -name '*.journal' | wc -l)" -eq 0 ]] \
  || fail "post-upload crash did not leave exactly one recoverable pending journal"
env "${run_env[@]}" bash "$pruner" \
  || fail "retention did not reconcile the pending journal after a process crash"
tr ',' '\n' < <(sed -n 's/^trashed_recovery_points=//p' "$report") \
  | grep -Fxq "$pending_crash_archive" \
  || fail "pending-journal crash target was omitted from the retention report"

# A malformed attestation must fail before any new remote mutation.
printf malformed >"$remote_base/state/points/learncoding-full-20210101T000000Z.tar.gz.age.env"
mutation_count_before="$(awk '$1 == "moveto" || $1 == "deletefile" || ($1 == "copyto" && $3 ~ /^fake:/) { count += 1 } END { print count + 0 }' "$work/rclone.log")"
if env "${run_env[@]}" bash "$pruner" >/dev/null 2>&1; then
  fail "retention accepted malformed committed state"
fi
mutation_count_after="$(awk '$1 == "moveto" || $1 == "deletefile" || ($1 == "copyto" && $3 ~ /^fake:/) { count += 1 } END { print count + 0 }' "$work/rclone.log")"
[[ "$mutation_count_after" -eq "$mutation_count_before" ]] \
  || fail "malformed preflight state caused a remote mutation"

echo offsite-retention-tests-ok
