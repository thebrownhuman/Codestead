#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"
load_backup_config
for command_name in cmp date flock od python3 rclone sed sha256sum sort stat; do
  require_command "$command_name"
done

: "${BACKUP_ROOT:?BACKUP_ROOT is required}"
require_secure_rclone_config \
  || die "rclone config must be a root-owned, non-symlink mode-0600 file"
validate_rclone_remote || die "RCLONE_REMOTE is invalid"
backup_root="$(validated_root "$BACKUP_ROOT" "$FULL_BACKUP_MAGIC")"
acquire_backup_lock

install -d -m 0700 "$BACKUP_STAGE_ROOT"
stage="$(mktemp -d -- "$BACKUP_STAGE_ROOT/offsite-retention.XXXXXX")"
chmod 0700 -- "$stage"
cleanup() {
  local status=$?
  trap - EXIT
  rm -rf --one-file-system -- "$stage"
  exit "$status"
}
trap cleanup EXIT

remote_base="${RCLONE_REMOTE%/}"
readonly archive_pattern='^learncoding-full-[0-9]{8}T[0-9]{6}Z\.tar\.gz\.age$'
declare -A present=() protected=() point_sha=()
declare -a committed=() journal_paths=() pending_journal_paths=() obsolete=()
declare -a trashed_archives=()
pointer_archive=""
pointer_sha=""
pointer_snapshot="$stage/pointer.env"

download_remote() {
  local remote="$1" destination="$2"
  rm -f -- "$destination"
  run_rclone copyto "$remote" "$destination" || return 1
  [[ -f "$destination" && ! -L "$destination" ]] || return 1
  chmod 0600 -- "$destination"
}

refresh_listing() {
  local listing="$stage/active-listing" line
  present=()
  journal_paths=()
  pending_journal_paths=()
  rm -f -- "$listing"
  run_rclone_capture "$listing" "$RCLONE_OUTPUT_LIMIT_BYTES" \
    lsf "$remote_base" --recursive --files-only \
    || die "active offsite listing failed or exceeded its bound"
  LC_ALL=C sort -o "$listing" "$listing"
  [[ ! -s "$listing" || "$(wc -l <"$listing")" -le 10000 ]] \
    || die "active offsite listing contains too many objects"
  if [[ -s "$listing" && -n "$(uniq -d "$listing" | head -n 1)" ]]; then
    die "active offsite listing contains duplicate paths"
  fi
  while IFS= read -r line; do
    [[ -n "$line" && "$line" != /* && "$line" != *'..'* \
      && "$line" != *$'\n'* && "$line" != *$'\r'* ]] \
      || die "active offsite listing contains an unsafe path"
    case "$line" in
      state/LAST_SUCCESS|full/learncoding-full-*.tar.gz.age|full/learncoding-full-*.tar.gz.age.sha256|state/points/learncoding-full-*.tar.gz.age.env)
        ;;
      state/.LAST_SUCCESS.pending-*|state/points/.learncoding-full-*.tar.gz.age.pending-*)
        ;;
      state/retention/*.journal)
        [[ "${line#state/retention/}" =~ ^[0-9a-f]{32}\.journal$ ]] \
          || die "retention journal name is malformed"
        journal_paths+=("$line")
        ;;
      state/retention/.*.pending)
        [[ "${line#state/retention/}" =~ ^\.[0-9a-f]{32}\.pending$ ]] \
          || die "pending retention journal name is malformed"
        pending_journal_paths+=("$line")
        ;;
      *) die "active offsite listing contains an unexpected object" ;;
    esac
    present["$line"]=1
  done <"$listing"
}

load_pointer() {
  [[ -n "${present[state/LAST_SUCCESS]+x}" ]] \
    || die "offsite success pointer is missing"
  download_remote "$remote_base/state/LAST_SUCCESS" "$pointer_snapshot" \
    || die "offsite success pointer could not be downloaded"
  read_success_marker "$pointer_snapshot" || die "offsite success pointer is invalid"
  pointer_archive="$SUCCESS_ARCHIVE"
  pointer_sha="$SUCCESS_SHA256"
  pointer_hash="$(sha256sum "$pointer_snapshot" | awk '{print $1}')"
}

load_committed_points() {
  local allow_partial="${1:-}" path archive local_point local_sidecar
  local attested_archive attested_sha sidecar_hash sidecar_name sidecar_extra
  committed=()
  point_sha=()
  for path in "${!present[@]}"; do
    [[ "$path" == state/points/learncoding-full-*.tar.gz.age.env ]] || continue
    archive="${path#state/points/}"
    archive="${archive%.env}"
    [[ "$archive" =~ $archive_pattern ]] || die "point attestation name is malformed"
    local_point="$stage/point-${archive}.env"
    download_remote "$remote_base/$path" "$local_point" \
      || die "point attestation could not be downloaded"
    read_success_marker "$local_point" || die "point attestation is invalid"
    attested_archive="$SUCCESS_ARCHIVE"
    attested_sha="$SUCCESS_SHA256"
    [[ "$attested_archive" == "$archive" ]] \
      || die "point attestation archive does not match its name"
    if [[ "$archive" != "$allow_partial" ]]; then
      [[ -n "${present[full/$archive]+x}" \
        && -n "${present[full/$archive.sha256]+x}" ]] \
        || die "committed offsite recovery point is incomplete"
      local_sidecar="$stage/sidecar-${archive}"
      download_remote "$remote_base/full/$archive.sha256" "$local_sidecar" \
        || die "committed offsite sidecar could not be downloaded"
      [[ "$(wc -l <"$local_sidecar")" -eq 1 ]] \
        || die "committed offsite sidecar is malformed"
      read -r sidecar_hash sidecar_name sidecar_extra <"$local_sidecar"
      [[ -z "${sidecar_extra:-}" && "$sidecar_hash" == "$attested_sha" \
        && "$sidecar_name" == "$archive" ]] \
        || die "committed offsite sidecar conflicts with its attestation"
    fi
    committed+=("$archive")
    point_sha["$archive"]="$attested_sha"
  done
  if [[ -n "$allow_partial" && -z "${point_sha[$allow_partial]+x}" ]]; then
    committed+=("$allow_partial")
  fi
  [[ -n "${point_sha[$pointer_archive]+x}" \
    && "${point_sha[$pointer_archive]}" == "$pointer_sha" ]] \
    || die "offsite pointer lacks a byte-consistent committed attestation"
  pointer_attestation="$stage/point-${pointer_archive}.env"
  cmp -s -- "$pointer_snapshot" "$pointer_attestation" \
    || die "offsite pointer differs from its immutable point attestation"
  mapfile -t committed < <(printf '%s\n' "${committed[@]}" | LC_ALL=C sort -r -u)
}

calculate_protected() {
  local archive timestamp day week month
  local daily_count=0 weekly_count=0 monthly_count=0
  declare -A daily_seen=() weekly_seen=() monthly_seen=()
  protected=()
  protected["$pointer_archive"]=1
  daily_buckets=()
  weekly_buckets=()
  monthly_buckets=()
  for archive in "${committed[@]}"; do
    timestamp="${archive#learncoding-full-}"
    timestamp="${timestamp%.tar.gz.age}"
    _valid_compact_utc_timestamp "$timestamp" \
      || die "committed recovery point timestamp is invalid"
    day="${timestamp:0:8}"
    week="$(date -u -d \
      "${timestamp:0:4}-${timestamp:4:2}-${timestamp:6:2} ${timestamp:9:2}:${timestamp:11:2}:${timestamp:13:2} UTC" +%G-W%V)" \
      || die "committed recovery point week could not be calculated"
    month="${timestamp:0:6}"
    if ((daily_count < 7)) && [[ -z "${daily_seen[$day]+x}" ]]; then
      daily_seen["$day"]="$archive"
      daily_buckets+=("$day:$archive")
      protected["$archive"]=1
      ((daily_count+=1))
    fi
    if ((weekly_count < 4)) && [[ -z "${weekly_seen[$week]+x}" ]]; then
      weekly_seen["$week"]="$archive"
      weekly_buckets+=("$week:$archive")
      protected["$archive"]=1
      ((weekly_count+=1))
    fi
    if ((monthly_count < 12)) && [[ -z "${monthly_seen[$month]+x}" ]]; then
      monthly_seen["$month"]="$archive"
      monthly_buckets+=("$month:$archive")
      protected["$archive"]=1
      ((monthly_count+=1))
    fi
  done
  protected_file="$stage/protected"
  printf '%s\n' "${!protected[@]}" | LC_ALL=C sort >"$protected_file"
  protected_hash="$(sha256sum "$protected_file" | awk '{print $1}')"
}

parse_journal() {
  local file="$1" version_line target_line sha_line point_line pointer_line protected_line created_line extra
  IFS= read -r version_line <"$file" || return 1
  IFS= read -r target_line < <(sed -n '2p' "$file") || return 1
  IFS= read -r sha_line < <(sed -n '3p' "$file") || return 1
  IFS= read -r point_line < <(sed -n '4p' "$file") || return 1
  IFS= read -r pointer_line < <(sed -n '5p' "$file") || return 1
  IFS= read -r protected_line < <(sed -n '6p' "$file") || return 1
  IFS= read -r created_line < <(sed -n '7p' "$file") || return 1
  extra="$(sed -n '8p' "$file")"
  [[ "$version_line" == VERSION=1 && -z "$extra" ]] || return 1
  journal_target="${target_line#TARGET_ARCHIVE=}"
  journal_sha="${sha_line#TARGET_SHA256=}"
  journal_point="${point_line#POINT_PATH=}"
  journal_pointer_hash="${pointer_line#POINTER_SHA256=}"
  journal_protected_hash="${protected_line#PROTECTED_SHA256=}"
  journal_created="${created_line#CREATED_UTC=}"
  [[ "$target_line" == TARGET_ARCHIVE=* && "$journal_target" =~ $archive_pattern \
    && "$sha_line" == TARGET_SHA256=* && "$journal_sha" =~ ^[0-9a-f]{64}$ \
    && "$point_line" == "POINT_PATH=state/points/$journal_target.env" \
    && "$journal_pointer_hash" =~ ^[0-9a-f]{64}$ \
    && "$journal_protected_hash" =~ ^[0-9a-f]{64}$ \
    && "$created_line" == CREATED_UTC=* ]] || return 1
  _valid_compact_utc_timestamp "$journal_created"
}

remote_object_exists() {
  local object="$1" listing="$stage/exact-listing.$RANDOM" expected
  rm -f -- "$listing"
  run_rclone_capture "$listing" "$RCLONE_OUTPUT_LIMIT_BYTES" \
    lsf "$remote_base/$object" --files-only --max-depth 1 || return 2
  expected="$(basename -- "$object")"
  mapfile -t exact_entries < <(sed '/^$/d' "$listing")
  case "${#exact_entries[@]}" in
    0) return 1 ;;
    1)
      [[ "${exact_entries[0]}" == "$expected" ]] || return 2
      return 0
      ;;
    *) return 2 ;;
  esac
}

verify_remote_bytes() {
  local object="$1" expected="$2" destination="$3"
  download_remote "$remote_base/$object" "$destination" \
    || die "remote transaction object could not be downloaded"
  cmp -s -- "$expected" "$destination" \
    || die "remote transaction object differs from the reviewed local bytes"
}

publish_journal() {
  local local_journal="$1" pending_object="$2" journal_object="$3"
  local pending_status final_status attempt copy_status move_status
  remote_object_exists "$journal_object" || final_status=$?
  final_status="${final_status:-0}"
  remote_object_exists "$pending_object" || pending_status=$?
  pending_status="${pending_status:-0}"
  if ((final_status == 0)); then
    ((pending_status == 1)) \
      || die "journal publication has duplicate or conflicting remote states"
    verify_remote_bytes "$journal_object" "$local_journal" "$stage/journal-existing"
    return 0
  fi
  ((final_status == 1)) \
    || die "journal publication state is ambiguous"
  if ((pending_status == 2)); then
    die "pending journal publication state is ambiguous"
  fi
  if ((pending_status == 1)); then
    for attempt in 1 2; do
      copy_status=0
      run_rclone copyto "$local_journal" "$remote_base/$pending_object" \
        || copy_status=$?
      pending_status=0
      remote_object_exists "$pending_object" || pending_status=$?
      if ((pending_status == 0)); then
        break
      fi
      ((pending_status == 1 && attempt == 1)) || \
        die "retention journal upload could not be reconciled exactly"
      ((copy_status != 0)) \
        || die "successful journal upload did not publish an exact object"
    done
  fi
  verify_remote_bytes "$pending_object" "$local_journal" "$stage/journal-pending"
  for attempt in 1 2; do
    assert_pointer_unchanged
    move_status=0
    run_rclone moveto "$remote_base/$pending_object" "$remote_base/$journal_object" \
      || move_status=$?
    final_status=0
    pending_status=0
    remote_object_exists "$journal_object" || final_status=$?
    remote_object_exists "$pending_object" || pending_status=$?
    if ((final_status == 0 && pending_status == 1)); then
      verify_remote_bytes "$journal_object" "$local_journal" "$stage/journal-committed"
      return 0
    fi
    if ((final_status == 1 && pending_status == 0 && attempt == 1)); then
      ((move_status != 0)) \
        || die "successful journal move left only the pending object"
      continue
    fi
    die "retention journal move could not be reconciled exactly"
  done
}

trash_remote_object() {
  local object="$1" before_status=0 after_status=0 delete_status=0
  remote_object_exists "$object" || before_status=$?
  ((before_status == 0)) \
    || die "exact offsite trash target is missing or ambiguous; journal retained"
  assert_pointer_unchanged
  run_rclone deletefile "$remote_base/$object" --drive-use-trash=true \
    || delete_status=$?
  remote_object_exists "$object" || after_status=$?
  case "$after_status" in
    1) return 0 ;;
    0)
      ((delete_status != 0)) \
        || die "successful offsite trash operation left the object active; journal retained"
      die "failed offsite trash operation left the object active; journal retained"
      ;;
    *) die "offsite trash result is ambiguous; journal retained" ;;
  esac
}

assert_pointer_unchanged() {
  local current="$stage/pointer-current.$RANDOM"
  download_remote "$remote_base/state/LAST_SUCCESS" "$current" \
    || die "offsite pointer could not be re-read before mutation"
  cmp -s -- "$pointer_snapshot" "$current" \
    || die "offsite pointer changed during retention"
}

reconcile_journal() {
  local journal_remote="$1" target="$2" object exists_status
  [[ "$target" != "$pointer_archive" && -z "${protected[$target]+x}" ]] \
    || die "retention journal targets a protected recovery point"
  assert_pointer_unchanged
  for object in "full/$target" "full/$target.sha256" "state/points/$target.env"; do
    exists_status=0
    remote_object_exists "$object" || exists_status=$?
    case "$exists_status" in
      0)
        trash_remote_object "$object"
        ;;
      1) ;;
      *) die "exact offsite object state is ambiguous; journal retained" ;;
    esac
  done
  assert_pointer_unchanged
  trash_remote_object "$journal_remote"
}

# Reconcile at most one pre-existing transaction before new selection.
for reconciliation_pass in 1 2; do
  refresh_listing
  transaction_count=$((${#journal_paths[@]} + ${#pending_journal_paths[@]}))
  ((transaction_count <= 1)) || die "multiple pending retention transactions are ambiguous"
  load_pointer
  pending_target=""
  pending_journal=""
  pending_object=""
  if ((${#journal_paths[@]} == 1)); then
    pending_journal="${journal_paths[0]}"
    local_journal="$stage/pending.journal"
    download_remote "$remote_base/$pending_journal" "$local_journal" \
      || die "pending retention journal could not be downloaded"
    parse_journal "$local_journal" || die "pending retention journal is malformed"
    pending_target="$journal_target"
  elif ((${#pending_journal_paths[@]} == 1)); then
    pending_object="${pending_journal_paths[0]}"
    transaction_id="${pending_object#state/retention/.}"
    transaction_id="${transaction_id%.pending}"
    pending_journal="state/retention/$transaction_id.journal"
    local_journal="$stage/pending.journal"
    download_remote "$remote_base/$pending_object" "$local_journal" \
      || die "pending retention upload could not be downloaded"
    parse_journal "$local_journal" || die "pending retention upload is malformed"
    pending_target="$journal_target"
  fi
  load_committed_points "$pending_target"
  if [[ -n "$pending_target" && -z "${point_sha[$pending_target]+x}" ]]; then
    point_sha["$pending_target"]="$journal_sha"
  fi
  calculate_protected
  if [[ -z "$pending_journal" ]]; then
    break
  fi
  [[ "$journal_sha" == "${point_sha[$pending_target]}" \
    && "$journal_pointer_hash" == "$pointer_hash" \
    && "$journal_protected_hash" == "$protected_hash" ]] \
    || die "pending retention journal no longer matches verified state"
  if [[ -n "$pending_object" ]]; then
    publish_journal "$local_journal" "$pending_object" "$pending_journal"
  fi
  reconcile_journal "$pending_journal" "$pending_target"
  ((reconciliation_pass == 1)) \
    || die "retention journal reconciliation did not converge"
done

obsolete=()
for candidate in "${committed[@]}"; do
  [[ -n "${protected[$candidate]+x}" ]] || obsolete+=("$candidate")
done
mapfile -t obsolete < <(printf '%s\n' "${obsolete[@]}" | sed '/^$/d' | LC_ALL=C sort)

for target in "${obsolete[@]}"; do
  assert_pointer_unchanged
  run_id="$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
  [[ "$run_id" =~ ^[0-9a-f]{32}$ ]] || die "retention run id generation failed"
  journal="$stage/$run_id.journal"
  created_utc="$(date -u +%Y%m%dT%H%M%SZ)"
  cat >"$journal" <<EOF
VERSION=1
TARGET_ARCHIVE=$target
TARGET_SHA256=${point_sha[$target]}
POINT_PATH=state/points/$target.env
POINTER_SHA256=$pointer_hash
PROTECTED_SHA256=$protected_hash
CREATED_UTC=$created_utc
EOF
  chmod 0600 -- "$journal"
  journal_remote="state/retention/$run_id.journal"
  pending_remote="state/retention/.$run_id.pending"
  publish_journal "$journal" "$pending_remote" "$journal_remote"
  reconcile_journal "$journal_remote" "$target"
done

active_final="$stage/active-final"
trash_final="$stage/trash-final"
run_rclone_capture "$active_final" "$RCLONE_OUTPUT_LIMIT_BYTES" \
  lsf "$remote_base" --recursive --files-only \
  || die "final active offsite listing failed"
run_rclone_capture "$trash_final" "$RCLONE_OUTPUT_LIMIT_BYTES" \
  lsf "$remote_base" --recursive --files-only --drive-trashed-only=true \
  || die "final trashed offsite listing failed"
LC_ALL=C sort -o "$active_final" "$active_final"
LC_ALL=C sort -o "$trash_final" "$trash_final"
if [[ -s "$trash_final" && -n "$(uniq -d "$trash_final" | head -n 1)" ]]; then
  die "final trashed offsite listing contains duplicate paths"
fi
declare -A trashed_members=() trashed_candidates=()
while IFS= read -r trashed_path; do
  [[ -n "$trashed_path" && "$trashed_path" != /* && "$trashed_path" != *'..'* \
    && "$trashed_path" != *$'\n'* && "$trashed_path" != *$'\r'* ]] \
    || die "final trashed offsite listing contains an unsafe path"
  trashed_archive=""
  case "$trashed_path" in
    full/learncoding-full-*.tar.gz.age)
      trashed_archive="${trashed_path#full/}"
      ;;
    full/learncoding-full-*.tar.gz.age.sha256)
      trashed_archive="${trashed_path#full/}"
      trashed_archive="${trashed_archive%.sha256}"
      ;;
    state/points/learncoding-full-*.tar.gz.age.env)
      trashed_archive="${trashed_path#state/points/}"
      trashed_archive="${trashed_archive%.env}"
      ;;
    state/retention/*.journal)
      [[ "${trashed_path#state/retention/}" =~ ^[0-9a-f]{32}\.journal$ ]] \
        || die "trashed retention journal name is malformed"
      continue
      ;;
    *) die "final trashed offsite listing contains an unexpected object" ;;
  esac
  [[ "$trashed_archive" =~ $archive_pattern ]] \
    || die "trashed recovery-point object name is malformed"
  trashed_members["$trashed_path"]=1
  trashed_candidates["$trashed_archive"]=1
done <"$trash_final"
trashed_archives=()
if ((${#trashed_candidates[@]} > 0)); then
  mapfile -t trashed_archives < <(printf '%s\n' "${!trashed_candidates[@]}" | LC_ALL=C sort)
fi
for trashed_archive in "${trashed_archives[@]}"; do
  for required_trash_path in \
    "full/$trashed_archive" "full/$trashed_archive.sha256" \
    "state/points/$trashed_archive.env"; do
    [[ -n "${trashed_members[$required_trash_path]+x}" ]] \
      || die "trashed recovery-point triplet is incomplete"
  done
done
active_digest="$(sha256sum "$active_final" | awk '{print $1}')"
trash_digest="$(sha256sum "$trash_final" | awk '{print $1}')"
declare -A final_expected=()
declare -a preserved_debris=()
final_expected["state/LAST_SUCCESS"]=1
active_committed_count=0
while IFS= read -r final_path; do
  [[ "$final_path" == state/points/learncoding-full-*.tar.gz.age.env ]] || continue
  final_archive="${final_path#state/points/}"
  final_archive="${final_archive%.env}"
  [[ "$final_archive" =~ $archive_pattern && -n "${point_sha[$final_archive]+x}" ]] \
    || die "final active listing contains an unverified attestation"
  for expected_path in \
    "full/$final_archive" \
    "full/$final_archive.sha256" \
    "state/points/$final_archive.env"; do
    grep -Fxq -- "$expected_path" "$active_final" \
      || die "final active committed recovery point is incomplete"
    final_expected["$expected_path"]=1
  done
  ((active_committed_count+=1))
done <"$active_final"
((active_committed_count > 0)) \
  || die "final active listing contains no committed recovery point"
[[ -n "${final_expected[state/points/$pointer_archive.env]+x}" ]] \
  || die "final active listing no longer contains the pointer recovery point"
while IFS= read -r final_path; do
  [[ -n "$final_path" && "$final_path" != /* && "$final_path" != *'..'* \
    && "$final_path" != *$'\n'* && "$final_path" != *$'\r'* ]] \
    || die "final active offsite listing contains an unsafe path"
  if [[ -n "${final_expected[$final_path]+x}" ]]; then
    continue
  fi
  case "$final_path" in
    full/learncoding-full-*.tar.gz.age|full/learncoding-full-*.tar.gz.age.sha256|state/.LAST_SUCCESS.pending-*|state/points/.learncoding-full-*.tar.gz.age.pending-*)
      preserved_debris+=("$final_path")
      ;;
    *) die "final active offsite listing contains an unexpected object" ;;
  esac
done <"$active_final"
completed_utc="$(date -u +%Y%m%dT%H%M%SZ)"
report="$backup_root/state/offsite-retention-last-report.txt"
temporary="$(mktemp -- "$backup_root/state/.offsite-retention-report.XXXXXX")"
join_csv() { local IFS=,; printf '%s' "$*"; }
cat >"$temporary" <<EOF
version=1
run_id=$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')
completed_utc=$completed_utc
pointer_archive=$pointer_archive
policy=7-daily-4-weekly-12-monthly
active_listing_sha256=$active_digest
trashed_listing_sha256=$trash_digest
active_committed_count=$active_committed_count
trashed_recovery_points=$(join_csv "${trashed_archives[@]}")
daily_buckets=$(join_csv "${daily_buckets[@]}")
weekly_buckets=$(join_csv "${weekly_buckets[@]}")
monthly_buckets=$(join_csv "${monthly_buckets[@]}")
preserved_debris=$(join_csv "${preserved_debris[@]}")
pending_journal=false
result=pass
EOF
chmod 0600 -- "$temporary"
sync -f -- "$temporary"
mv -fT -- "$temporary" "$report"
sync -f -- "$backup_root/state"
emit_alert info offsite_retention_complete \
  "verified offsite retention transaction completed"
