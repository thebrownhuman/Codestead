#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
sync_script="$repo_root/scripts/backup/offsite-sync.sh"
fetch_script="$repo_root/scripts/backup/fetch-offsite.sh"
check_script="$repo_root/scripts/backup/check-backups.sh"

fail() {
  printf 'offsite-recovery-test-failed: %s\n' "$1" >&2
  exit 1
}

[[ -f "$fetch_script" && ! -L "$fetch_script" ]] \
  || fail "verified offsite retrieval command is missing"
grep -Fq 'state/points/' "$sync_script" \
  || fail "offsite publication does not create immutable point attestations"
if grep -Eq '(^|[[:space:]])rclone[[:space:]]+sync([[:space:]]|$)' "$sync_script"; then
  fail "offsite publication still uses destructive directory synchronization"
fi

python3 - "$sync_script" "$fetch_script" <<'PY' \
  || fail "offsite entrypoints do not enforce one shared deadline and irreversible finalization"
from pathlib import Path
import sys

sync_text = Path(sys.argv[1]).read_text(encoding="utf-8")
fetch_text = Path(sys.argv[2]).read_text(encoding="utf-8")

for label, text in (("sync", sync_text), ("fetch", fetch_text)):
    if text.count("\nstart_rclone_service_budget\n") != 1:
        raise SystemExit(f"{label} must initialize the service budget exactly once")
    if "run_rclone_service_capture" not in text:
        raise SystemExit(f"{label} does not use budgeted capture")
    if "\nrun_rclone_capture " in text:
        raise SystemExit(f"{label} bypasses the service budget for captured output")
    if "verify_ciphertext_checksum_service_budget" not in text:
        raise SystemExit(f"{label} does not budget ciphertext verification")
    if "\nverify_ciphertext_checksum " in text:
        raise SystemExit(f"{label} still performs unbudgeted ciphertext verification")

sync_start = sync_text.index("\nstart_rclone_service_budget\n")
sync_first_remote = min(
    sync_text.index(token)
    for token in ("\nrun_rclone_bulk ", "\nrun_rclone_control ")
)
sync_finalize = sync_text.index("\nbegin_rclone_service_finalization\n")
sync_publish = sync_text.index("\n  pending_point=")
if not sync_start < sync_first_remote < sync_finalize < sync_publish:
    raise SystemExit("sync deadline/finalization call order is unsafe")
if "\nrun_rclone_control " in sync_text[sync_finalize:]:
    raise SystemExit("sync performs ordinary remote work after finalization")
if "run_rclone_finalization_control" in sync_text[:sync_finalize]:
    raise SystemExit("sync uses finalization reserve before the irreversible boundary")
if "run_backup_work_bulk" not in sync_text[:sync_finalize]:
    raise SystemExit("sync does not budget full-file comparison work")

fetch_start = fetch_text.index("\nstart_rclone_service_budget\n")
fetch_first_remote = fetch_text.index("\n  run_rclone_service_capture ")
fetch_finalize = fetch_text.index("\nbegin_rclone_service_finalization\n")
fetch_publish = fetch_text.index("\nrun_backup_finalization_control mv -T -- ")
if not fetch_start < fetch_first_remote < fetch_finalize < fetch_publish:
    raise SystemExit("fetch deadline/finalization call order is unsafe")
if any(token in fetch_text[fetch_finalize:] for token in (
    "run_rclone_control", "run_rclone_bulk", "run_rclone_service_capture"
)):
    raise SystemExit("fetch performs remote work after finalization")
PY

work="$(mktemp -d)"
trap 'rm -rf -- "$work"' EXIT
mkdir -m 0700 -p "$work/bin" "$work/remote" "$work/backup/full" \
  "$work/backup/state" "$work/stage" "$work/data" "$work/fetch"
printf '%s\n' LEARNCODING_BACKUP_V1 >"$work/backup/.learncoding-backup-root"
chmod 0600 "$work/backup/.learncoding-backup-root"

cat >"$work/bin/rclone" <<'RCLONE'
#!/usr/bin/env bash
set -Eeuo pipefail
operation="${1:-}"
shift || true
map_path() {
  local value="$1"
  if [[ "$value" == fake:* ]]; then
    value="${value#fake:}"
    printf '%s/%s\n' "$FAKE_REMOTE_ROOT" "${value#/}"
  else
    printf '%s\n' "$value"
  fi
}
case "$operation" in
  copyto)
    source_path="$(map_path "$1")"
    destination_path="$(map_path "$2")"
    mkdir -p -- "$(dirname -- "$destination_path")"
    if [[ "${FAKE_PARTIAL_ARCHIVE_TIMEOUT:-0}" == 1 \
      && "$destination_path" == "$FAKE_REMOTE_ROOT"/*/full/*.tar.gz.age ]]; then
      head -c 1 -- "$source_path" >"$destination_path"
      sleep 8
      exit 75
    fi
    if [[ "${FAKE_BULK_SLEEP_SECONDS:-0}" =~ ^[1-9][0-9]*$ \
      && ( "$source_path" == */full/*.tar.gz.age \
        || "$destination_path" == */full/*.tar.gz.age ) ]]; then
      sleep "$FAKE_BULK_SLEEP_SECONDS"
    fi
    cp -- "$source_path" "$destination_path"
    ;;
  moveto)
    source_path="$(map_path "$1")"
    destination_path="$(map_path "$2")"
    mkdir -p -- "$(dirname -- "$destination_path")"
    mv -- "$source_path" "$destination_path"
    ;;
  lsf)
    target="$(map_path "$1")"
    [[ -e "$target" ]] || exit 0
    entry="$(basename -- "$target")"
    printf '%s\n' "$entry"
    if [[ -n "${FAKE_DUPLICATE_TARGET:-}" && "$target" == "$FAKE_DUPLICATE_TARGET" ]]; then
      printf '%s\n' "$entry"
    fi
    ;;
  size)
    target="$(map_path "$1")"
    printf '{"count":1,"bytes":%s}\n' "$(stat -c '%s' -- "$target")"
    ;;
  cat)
    cat -- "$(map_path "$1")"
    ;;
  *)
    printf 'unsupported fake rclone operation: %s\n' "$operation" >&2
    exit 64
    ;;
esac
RCLONE
chmod 0700 "$work/bin/rclone"

archive="learncoding-full-$(date -u +%Y%m%dT%H%M%SZ).tar.gz.age"
printf 'ciphertext-fixture\n' >"$work/backup/full/$archive"
archive_hash="$(sha256sum "$work/backup/full/$archive" | awk '{print $1}')"
printf '%s  %s\n' "$archive_hash" "$archive" >"$work/backup/full/$archive.sha256"
chmod 0600 "$work/backup/full/$archive" "$work/backup/full/$archive.sha256"
completed="$(date -u +%Y%m%dT%H%M%SZ)"
cat >"$work/backup/state/local-last-success.env" <<EOF
SUCCESS_ARCHIVE=$archive
SUCCESS_COMPLETED_UTC=$completed
SUCCESS_SHA256=$archive_hash
EOF
chmod 0600 "$work/backup/state/local-last-success.env"

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
MAX_OFFSITE_AGE_HOURS=30
FILESYSTEM_WARN_PERCENT=70
FILESYSTEM_CRITICAL_PERCENT=99
CHECK_OFFSITE=1
EOF
chmod 0600 "$config"

run_env=(
  "PATH=$work/bin:$PATH"
  "FAKE_REMOTE_ROOT=$work/remote"
  "BACKUP_CONFIG_FILE=$config"
)

tight_bulk_env=(
  "${run_env[@]}"
  "RCLONE_CONTROL_TIMEOUT_SECONDS=8"
  "RCLONE_MIN_BULK_BYTES_PER_SECOND=1048576"
  "RCLONE_BULK_OVERHEAD_SECONDS=8"
  "RCLONE_SERVICE_BUDGET_SECONDS=40"
  "RCLONE_SERVICE_RESERVE_SECONDS=10"
  "RCLONE_OPERATION_GRACE_SECONDS=1"
)

partial_started=$SECONDS
if env "${tight_bulk_env[@]}" "FAKE_PARTIAL_ARCHIVE_TIMEOUT=1" \
  bash "$sync_script" >/dev/null 2>&1; then
  fail "partial remote archive write did not time out"
fi
if ((SECONDS - partial_started >= 12)); then
  fail "partial remote archive write exceeded its size-derived bulk deadline"
fi
[[ -f "$work/remote/codestead/backups/full/$archive" ]] \
  || fail "timeout fixture did not create a partial remote archive"
[[ ! -e "$work/remote/codestead/backups/state/LAST_SUCCESS" \
  && ! -e "$work/remote/codestead/backups/state/points/$archive.env" \
  && ! -e "$work/backup/state/offsite-last-success.env" ]] \
  || fail "timed-out partial upload advanced a success marker"
rm -rf -- "$work/remote/codestead"

env "${tight_bulk_env[@]}" "FAKE_BULK_SLEEP_SECONDS=2" bash "$sync_script"
point_path="$work/remote/codestead/backups/state/points/$archive.env"
pointer_path="$work/remote/codestead/backups/state/LAST_SUCCESS"
[[ -f "$point_path" && -f "$pointer_path" ]] \
  || fail "verified publication omitted remote point metadata"
cmp -s "$point_path" "$pointer_path" \
  || fail "remote pointer differs from immutable point attestation"
cmp -s "$work/backup/state/offsite-last-success.env" "$point_path" \
  || fail "local offsite acknowledgement differs from verified remote bytes"

cp "$point_path" "$work/original-point"
sleep 1
env "${run_env[@]}" bash "$sync_script"
cmp -s "$point_path" "$work/original-point" \
  || fail "same-point retry refreshed immutable attestation time"

env "${run_env[@]}" bash "$fetch_script" "$work/fetch" >"$work/fetch-output"
[[ "$(<"$work/fetch-output")" == "$work/fetch/$archive" ]] \
  || fail "fetch output was not the exact verified archive path"
cmp -s "$work/fetch/$archive" "$work/backup/full/$archive" \
  || fail "fetched archive differs from the published local bytes"
cmp -s "$work/fetch/$archive.sha256" "$work/backup/full/$archive.sha256" \
  || fail "fetched sidecar differs from the published local bytes"

newer_archive="learncoding-full-$(date -u -d '+1 second' +%Y%m%dT%H%M%SZ).tar.gz.age"
printf 'newer-local-only-ciphertext\n' >"$work/backup/full/$newer_archive"
newer_hash="$(sha256sum "$work/backup/full/$newer_archive" | awk '{print $1}')"
printf '%s  %s\n' "$newer_hash" "$newer_archive" \
  >"$work/backup/full/$newer_archive.sha256"
chmod 0600 "$work/backup/full/$newer_archive" "$work/backup/full/$newer_archive.sha256"
if env "${run_env[@]}" bash "$check_script" >/dev/null 2>&1; then
  fail "local health check accepted an uncommitted newer recovery-point pair"
fi
rm -f -- "$work/backup/full/$newer_archive" "$work/backup/full/$newer_archive.sha256"
env "${run_env[@]}" bash "$check_script" \
  || fail "fresh marker-anchored local and offsite recovery point was rejected"

cp "$work/backup/state/local-last-success.env" "$work/local-marker"
sed 's/^SUCCESS_SHA256=.*/SUCCESS_SHA256=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/' \
  "$work/local-marker" >"$work/backup/state/local-last-success.env"
chmod 0600 "$work/backup/state/local-last-success.env"
if env "${run_env[@]}" bash "$check_script" >/dev/null 2>&1; then
  fail "local health check accepted a marker hash that differs from its sidecar"
fi
cp "$work/local-marker" "$work/backup/state/local-last-success.env"
chmod 0600 "$work/backup/state/local-last-success.env"
rm -f -- "$work/backup/state/local-last-success.env"
if env "${run_env[@]}" bash "$check_script" >/dev/null 2>&1; then
  fail "local health check accepted an archive without the strict success marker"
fi
cp "$work/local-marker" "$work/backup/state/local-last-success.env"
chmod 0600 "$work/backup/state/local-last-success.env"

printf tampered >>"$work/remote/codestead/backups/full/$archive"
mkdir -m 0700 "$work/tampered-fetch"
if env "${run_env[@]}" bash "$fetch_script" "$work/tampered-fetch" \
  >/dev/null 2>&1; then
  fail "fetch accepted tampered remote ciphertext"
fi
[[ -z "$(find "$work/tampered-fetch" -mindepth 1 -print -quit)" ]] \
  || fail "failed fetch left unverified bytes in its destination"
cp "$work/backup/full/$archive" "$work/remote/codestead/backups/full/$archive"

cp "$point_path" "$work/pointer-before-conflict"
sed 's/^SUCCESS_SHA256=.*/SUCCESS_SHA256=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/' \
  "$point_path" >"$work/conflicting-point"
mv "$work/conflicting-point" "$point_path"
if env "${run_env[@]}" bash "$sync_script" >/dev/null 2>&1; then
  fail "publication accepted a conflicting immutable attestation"
fi
cmp -s "$pointer_path" "$work/pointer-before-conflict" \
  || fail "failed conflicting publication changed the remote pointer"
cp "$work/original-point" "$point_path"

mkdir -m 0700 "$work/duplicate-fetch"
duplicate_env=(
  "${run_env[@]}"
  "FAKE_DUPLICATE_TARGET=$point_path"
)
if env "${duplicate_env[@]}" bash "$fetch_script" "$work/duplicate-fetch" >/dev/null 2>&1; then
  fail "fetch accepted duplicate immutable point-attestation names"
fi
[[ -z "$(find "$work/duplicate-fetch" -mindepth 1 -print -quit)" ]] \
  || fail "duplicate-name fetch left unverified bytes in its destination"
if env "${duplicate_env[@]}" bash "$check_script" >/dev/null 2>&1; then
  fail "health check accepted duplicate immutable point-attestation names"
fi

chmod 0644 "$rclone_config"
if env "${run_env[@]}" bash "$sync_script" >/dev/null 2>&1; then
  fail "publication accepted a group-readable rclone config"
fi
chmod 0600 "$rclone_config"
mv "$rclone_config" "$work/rclone-target"
ln -s "$work/rclone-target" "$rclone_config"
if env "${run_env[@]}" bash "$fetch_script" "$work/unused" >/dev/null 2>&1; then
  fail "retrieval accepted a symlinked rclone config"
fi

echo offsite-recovery-tests-ok
