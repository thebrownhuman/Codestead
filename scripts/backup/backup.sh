#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
export LC_ALL=C

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"
load_backup_config

readonly QUIESCE_BUDGET_SECONDS=600
readonly -a REQUIRED_IMAGE_SERVICES=(
  app cloudflared exam-finalization-worker mail-worker migrate postgres
  practice-runner-recovery-worker project-review-correction-worker
  regrade-worker reward-worker
)
readonly -a OPTIONAL_IMAGE_SERVICES=(clamav scan-worker)

for command_name in age age-keygen docker find flock git gzip hostname realpath \
  sha256sum sync tar timeout; do
  require_command "$command_name"
done

: "${BACKUP_ROOT:?BACKUP_ROOT is required}"
: "${AGE_RECIPIENT_FILE:?AGE_RECIPIENT_FILE is required}"
: "${CREDENTIAL_MASTER_KEY_FILE:=/etc/learncoding/secrets/credential_master_key}"
: "${BACKUP_EPHEMERAL_ROOT:=/run}"
for configured_path in "$BACKUP_ROOT" "$REPO_ROOT" "$LEARN_DATA_ROOT" \
  "$COMPOSE_ENV_FILE" "$AGE_RECIPIENT_FILE" "$CREDENTIAL_MASTER_KEY_FILE" \
  "$BACKUP_STAGE_ROOT" "$BACKUP_EPHEMERAL_ROOT" "$BACKUP_LOCK_FILE"; do
  [[ "$configured_path" == /* ]] || die "backup configuration contains a non-absolute path"
done
[[ -z "${EMERGENCY_BACKUP_ROOT:-}" || "$EMERGENCY_BACKUP_ROOT" == /* ]] \
  || die "backup configuration contains a non-absolute path"

secure_directory() {
  local directory="$1" mode="$2" resolved
  if [[ -e "$directory" || -L "$directory" ]]; then
    [[ -d "$directory" && ! -L "$directory" ]] || return 1
    chmod "$mode" -- "$directory" || return 1
  else
    mkdir -m "$mode" -- "$directory" || return 1
  fi
  resolved="$(realpath -e -- "$directory")" || return 1
  [[ "$resolved" == "$directory" \
    && "$(stat -c '%a' -- "$directory")" == "${mode#0}" \
    && "$(stat -c '%u' -- "$directory")" == "$(id -u)" ]]
}

secure_ephemeral_parent() {
  local directory="$1" mode resolved
  if [[ -e "$directory" || -L "$directory" ]]; then
    [[ -d "$directory" && ! -L "$directory" \
      && "$(stat -c '%u' -- "$directory")" == "$(id -u)" ]] || return 1
    mode="$(stat -c '%a' -- "$directory")" || return 1
    (( (8#$mode & 0022) == 0 )) || return 1
  else
    mkdir -m 0700 -- "$directory" || return 1
  fi
  resolved="$(realpath -e -- "$directory")" || return 1
  [[ "$resolved" == "$directory" ]]
}

read_compose_env_value() {
  local requested="$1" line value="" matches=0
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" != *$'\r'* && "$line" != *$'\n'* ]] || return 1
    [[ -z "$line" || "$line" == \#* ]] && continue
    if [[ "$line" == "$requested="* ]]; then
      ((matches += 1))
      value="${line#*=}"
    fi
  done <"$COMPOSE_ENV_FILE"
  ((matches == 1)) || return 1
  printf '%s\n' "$value"
}

require_secure_regular_file "$COMPOSE_ENV_FILE" 640 "$(id -u)" \
  || die "Compose environment is missing or unsafe"
require_secure_regular_file "$AGE_RECIPIENT_FILE" 600 "$(id -u)" \
  || die "age recipient file is missing or unsafe"
[[ -s "$AGE_RECIPIENT_FILE" ]] || die "age recipient file is empty"
if grep -Eq 'AGE-SECRET-KEY-|AGE-PLUGIN-.+-' "$AGE_RECIPIENT_FILE"; then
  die "age recipient file contains private identity material"
fi
credential_key_owner="$(id -u)"
[[ "$CREDENTIAL_MASTER_KEY_FILE" != /etc/learncoding/secrets/credential_master_key ]] \
  || credential_key_owner=0
require_secure_regular_file "$CREDENTIAL_MASTER_KEY_FILE" 440 "$credential_key_owner" \
  || die "credential master key is missing or unsafe"

operations_image="$(read_compose_env_value APP_OPERATIONS_IMAGE)" \
  || die "APP_OPERATIONS_IMAGE is missing or ambiguous"
secrets_gid="$(read_compose_env_value SECRETS_GID)" \
  || die "SECRETS_GID is missing or ambiguous"
[[ "$operations_image" =~ ^[^@,[:space:]]+@sha256:[0-9a-f]{64}$ \
  && "$operations_image" != -* ]] \
  || die "APP_OPERATIONS_IMAGE is not an immutable digest"
[[ "$secrets_gid" =~ ^[1-9][0-9]*$ \
  && "$secrets_gid" -le 2147483647 ]] \
  || die "SECRETS_GID is invalid"
for mount_path in "$CREDENTIAL_MASTER_KEY_FILE" "$BACKUP_STAGE_ROOT"; do
  [[ "$mount_path" != *','* && "$mount_path" != *$'\n'* && "$mount_path" != *$'\r'* ]] \
    || die "backup mount path is unsafe"
done

[[ -f "$REPO_ROOT/compose.yaml" && ! -L "$REPO_ROOT/compose.yaml" ]] \
  || die "repository deployment files are missing"
repo_real="$(realpath -e -- "$REPO_ROOT")" || die "repository path is invalid"
git_top="$(git -C "$repo_real" rev-parse --show-toplevel 2>/dev/null)" \
  || die "installed release Git metadata is unavailable"
[[ "$(realpath -e -- "$git_top")" == "$repo_real" ]] \
  || die "installed release is not the exact Git worktree"
pre_commit="$(git -C "$repo_real" rev-parse --verify HEAD 2>/dev/null)" \
  || die "installed release commit is unavailable"
[[ "$pre_commit" =~ ^([0-9a-f]{40}|[0-9a-f]{64})$ ]] \
  || die "installed release commit is invalid"
source_host="$(hostname -s)"
[[ "$source_host" =~ ^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$ ]] \
  || die "source host name is unsafe"

backup_root="$(validated_root "$BACKUP_ROOT" "$FULL_BACKUP_MAGIC")"
full_dir="$backup_root/full"
state_dir="$backup_root/state"
protected_roots=("$repo_real" "$LEARN_DATA_ROOT" "$backup_root")
[[ -z "${EMERGENCY_BACKUP_ROOT:-}" ]] || protected_roots+=("$EMERGENCY_BACKUP_ROOT")
for protected_root in "${protected_roots[@]}"; do
  if path_is_within "$BACKUP_STAGE_ROOT" "$protected_root" \
    || path_is_within "$protected_root" "$BACKUP_STAGE_ROOT"; then
    die "backup staging root overlaps a protected root"
  fi
  if path_is_within "$BACKUP_EPHEMERAL_ROOT" "$protected_root" \
    || path_is_within "$protected_root" "$BACKUP_EPHEMERAL_ROOT"; then
    die "ephemeral-key root overlaps a protected root"
  fi
done
if path_is_within "$BACKUP_STAGE_ROOT" "$BACKUP_EPHEMERAL_ROOT" \
  || path_is_within "$BACKUP_EPHEMERAL_ROOT" "$BACKUP_STAGE_ROOT"; then
  die "backup staging and ephemeral-key roots overlap"
fi
secure_directory "$full_dir" 0700 || die "full backup directory is unsafe"
secure_directory "$state_dir" 0700 || die "backup state directory is unsafe"
secure_directory "$BACKUP_STAGE_ROOT" 0700 || die "backup staging root is unsafe"
secure_ephemeral_parent "$BACKUP_EPHEMERAL_ROOT" || die "ephemeral-key root is unsafe"
acquire_backup_lock

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
filename="learncoding-full-${timestamp}.tar.gz.age"
final_archive="$full_dir/$filename"
final_checksum="${final_archive}.sha256"
marker="$state_dir/local-last-success.env"
[[ ! -e "$final_archive" && ! -L "$final_archive" \
  && ! -e "$final_checksum" && ! -L "$final_checksum" ]] \
  || die "backup timestamp already exists"

stage="$(mktemp -d -- "$BACKUP_STAGE_ROOT/full.${timestamp}.XXXXXX")"
verify_dir="$(mktemp -d -- "$BACKUP_STAGE_ROOT/verify.${timestamp}.XXXXXX")"
ephemeral_dir="$(mktemp -d -- "$BACKUP_EPHEMERAL_ROOT/learncoding-backup.${timestamp}.XXXXXX")"
chmod 0700 -- "$stage" "$verify_dir" "$ephemeral_dir"
identity="$ephemeral_dir/identity.txt"
ephemeral_recipient="$ephemeral_dir/recipient.txt"
combined_recipients="$ephemeral_dir/recipients.txt"
tmp_archive=""
tmp_checksum=""
outer_plain="$stage/.plaintext-envelope.tar.gz"
phase=preflight
marker_committed=0
publication_commit_uncertain=0
archive_published=0
checksum_published=0
quiesce_started=0
resume_attempted=0
resumed=0
completed=0
deadline_seconds=0
declare -a captured_mutators=()

safe_remove_tree() {
  local target="${1:-}"
  [[ -n "$target" && -d "$target" && ! -L "$target" \
    && "$target" != "$BACKUP_STAGE_ROOT" \
    && "$(stat -c '%u' -- "$target" 2>/dev/null)" == "$(id -u)" ]] || return 1
  path_is_within "$target" "$BACKUP_STAGE_ROOT" || return 1
  find -P "$target" -mindepth 1 -delete 2>/dev/null || return 1
  rmdir -- "$target"
}

remove_ephemeral_material() {
  [[ -n "${ephemeral_dir:-}" && -d "$ephemeral_dir" && ! -L "$ephemeral_dir" \
    && "$ephemeral_dir" != "$BACKUP_EPHEMERAL_ROOT" \
    && "$(stat -c '%u' -- "$ephemeral_dir" 2>/dev/null)" == "$(id -u)" ]] || return 1
  path_is_within "$ephemeral_dir" "$BACKUP_EPHEMERAL_ROOT" || return 1
  rm -f -- "$identity" "$ephemeral_recipient" "$combined_recipients" 2>/dev/null || true
  find -P "$ephemeral_dir" -mindepth 1 -delete 2>/dev/null || return 1
  rmdir -- "$ephemeral_dir"
}

resume_captured() {
  resume_attempted=1
  log "backup phase=resuming"
  if resume_mutators captured_mutators; then
    resumed=1
    log "backup phase=resumed"
    return 0
  fi
  emit_alert critical backup_resume_failed \
    "backup publication state is retained but captured services did not resume"
  return 1
}

cleanup() {
  local original_status=$? cleanup_failed=0 resume_failed=0
  trap - EXIT

  remove_ephemeral_material || cleanup_failed=1
  if ((marker_committed == 0 && publication_commit_uncertain == 0)); then
    [[ -z "$tmp_archive" ]] || rm -f -- "$tmp_archive" 2>/dev/null || cleanup_failed=1
    [[ -z "$tmp_checksum" ]] || rm -f -- "$tmp_checksum" 2>/dev/null || cleanup_failed=1
    ((archive_published == 0)) || rm -f -- "$final_archive" 2>/dev/null || cleanup_failed=1
    ((checksum_published == 0)) || rm -f -- "$final_checksum" 2>/dev/null || cleanup_failed=1
  else
    [[ -z "$tmp_archive" ]] || rm -f -- "$tmp_archive" 2>/dev/null || cleanup_failed=1
    [[ -z "$tmp_checksum" ]] || rm -f -- "$tmp_checksum" 2>/dev/null || cleanup_failed=1
  fi

  if ((quiesce_started == 1 && resumed == 0)); then
    resume_captured || resume_failed=1
  fi
  safe_remove_tree "$verify_dir" || cleanup_failed=1
  safe_remove_tree "$stage" || cleanup_failed=1

  if ((original_status != 0)); then
    if ((marker_committed == 0)); then
      if ! enqueue_backup_status failure "$timestamp"; then
        emit_alert warning backup_report_not_queued \
          "backup failure status could not be queued; inspect protected operations logs"
      fi
      emit_alert critical backup_failed \
        "nightly encrypted backup failed; inspect protected operations logs"
    elif ((resume_failed == 0)); then
      emit_alert critical backup_post_commit_failed \
        "a verified local recovery point committed but a later operation failed"
    fi
    exit "$original_status"
  fi
  if ((resume_failed != 0 || cleanup_failed != 0)); then
    emit_alert critical backup_cleanup_failed \
      "backup cleanup or captured-service resume failed"
    exit 1
  fi
  exit 0
}
trap cleanup EXIT

remaining_seconds() {
  local remaining=$((deadline_seconds - SECONDS))
  ((remaining > 0)) || return 1
  printf '%s\n' "$remaining"
}

run_deadline() {
  local remaining
  remaining="$(remaining_seconds)" || return 124
  timeout --foreground --kill-after=15s "${remaining}s" "$@"
}

canonical_tar() {
  local output="$1" base="$2" mtime="$3"
  shift 3
  tar --sort=name --format=posix \
    --pax-option=delete=atime,delete=ctime \
    --owner=0 --group=0 --numeric-owner \
    --mode='u+rwX,go+rX,go-w' --mtime="$mtime" \
    --use-compress-program='gzip -n' --create --file "$output" \
    --directory "$base" "$@"
}

assert_safe_source_tree() {
  local source
  for source in "$@"; do
    [[ ! -L "$source" && ( -f "$source" || -d "$source" ) ]] || return 1
    if [[ -d "$source" ]] \
      && find -P "$source" -mindepth 1 ! -type f ! -type d -print -quit | grep -q .; then
      return 1
    fi
  done
}

capture_image_map() {
  local output_file="$1" bounded="$2" listing line service container_id image known
  local -a compose_args=(
    docker compose --env-file "$COMPOSE_ENV_FILE" -f "$REPO_ROOT/compose.yaml"
    ps -a --format '{{.Service}} {{.ID}}'
    "${REQUIRED_IMAGE_SERVICES[@]}" "${OPTIONAL_IMAGE_SERVICES[@]}"
  )
  if [[ "$bounded" == true ]]; then
    listing="$(run_deadline "${compose_args[@]}")" || return 1
  else
    listing="$("${compose_args[@]}")" || return 1
  fi
  : >"$output_file"
  declare -A seen_services=()
  while IFS= read -r line; do
    [[ -n "$line" ]] || continue
    read -r service container_id extra <<<"$line"
    [[ -z "${extra:-}" && "$service" =~ ^[a-z0-9-]+$ \
      && "$container_id" =~ ^[A-Za-z0-9_.-]+$ \
      && -z "${seen_services[$service]+x}" ]] || return 1
    known=0
    for allowed in "${REQUIRED_IMAGE_SERVICES[@]}" "${OPTIONAL_IMAGE_SERVICES[@]}"; do
      [[ "$service" != "$allowed" ]] || known=1
    done
    ((known == 1)) || return 1
    seen_services[$service]=1
    if [[ "$bounded" == true ]]; then
      image="$(run_deadline docker inspect --format '{{.Image}}' "$container_id")" || return 1
    else
      image="$(docker inspect --format '{{.Image}}' "$container_id")" || return 1
    fi
    [[ "$image" =~ ^sha256:[0-9a-f]{64}$ ]] || return 1
    printf '%s=%s\n' "$service" "$image" >>"$output_file"
  done <<<"$listing"
  for service in "${REQUIRED_IMAGE_SERVICES[@]}"; do
    [[ -n "${seen_services[$service]+x}" ]] || return 1
  done
  sort -o "$output_file" "$output_file"
}

validate_running_services() {
  local output="$1" service allowed candidate captured
  declare -A seen_running=()
  declare -A captured_set=()
  for captured in "${captured_mutators[@]}"; do
    captured_set[$captured]=1
  done
  while IFS= read -r service; do
    [[ -n "$service" ]] || continue
    [[ "$service" =~ ^[a-z0-9-]+$ && -z "${seen_running[$service]+x}" ]] || return 1
    seen_running[$service]=1
    case "$service" in
      postgres|clamav) ;;
      migrate|lifecycle|platform-seed|admin-bootstrap) return 1 ;;
      *)
        allowed=0
        for candidate in "${BACKUP_MUTATING_SERVICES[@]}"; do
          [[ "$service" != "$candidate" ]] || allowed=1
        done
        ((allowed == 1)) || return 1
        [[ -n "${captured_set[$service]+x}" ]] || return 1
        ;;
    esac
  done <<<"$output"
  for service in "${captured_mutators[@]}"; do
    [[ -n "${seen_running[$service]+x}" ]] || return 1
  done
}

tar_mtime="${timestamp:0:4}-${timestamp:4:2}-${timestamp:6:2} ${timestamp:9:2}:${timestamp:11:2}:${timestamp:13:2} UTC"
repo_sources=(
  "$REPO_ROOT/content" "$REPO_ROOT/drizzle" "$REPO_ROOT/infra"
  "$REPO_ROOT/docs/deployment.md" "$REPO_ROOT/docs/runbooks"
  "$REPO_ROOT/compose.yaml" "$REPO_ROOT/Dockerfile" "$REPO_ROOT/.dockerignore"
)
assert_safe_source_tree "${repo_sources[@]}" \
  || die "repository backup source contains an unsafe entry"
log "backup phase=repository-packaging"
if ! canonical_tar "$stage/repository.tar.gz" "$REPO_ROOT" "$tar_mtime" \
  --exclude='.git' --exclude='.env' --exclude='.env.*' \
  --exclude='infra/secrets' --exclude='infra/cloudflare/config.yml' \
  --exclude='*.pem' --exclude='*.key' --exclude='*credentials*.json' \
  --exclude='*.eml' --exclude='*.mbox' --exclude='*.pst' --exclude='*.ost' \
  .dockerignore Dockerfile compose.yaml content docs/deployment.md docs/runbooks drizzle infra \
  >/dev/null 2>&1; then
  die "repository packaging failed"
fi

probe_output_dir="$stage/probe-output"
mkdir -m 0700 -- "$probe_output_dir"
if [[ "$(id -u)" == 0 ]]; then
  chown 1000:"$secrets_gid" -- "$probe_output_dir"
fi
log "backup phase=credential-probe"
docker run --rm --pull never --network none --read-only --cap-drop ALL \
  --security-opt no-new-privileges --pids-limit 64 --memory 256m --cpus 0.5 \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=16m \
  --user 1000:1000 --group-add "$secrets_gid" \
  --mount "type=bind,src=$CREDENTIAL_MASTER_KEY_FILE,dst=/run/secrets/credential_master_key,readonly" \
  --mount "type=bind,src=$probe_output_dir,dst=/output" \
  --entrypoint node "$operations_image" \
  --import tsx /app/scripts/backup/create-credential-probe.ts \
  /output/credential-probe.json /run/secrets/credential_master_key \
  >/dev/null 2>&1
if [[ "$(id -u)" == 0 ]]; then
  [[ -f "$probe_output_dir/credential-probe.json" \
    && ! -L "$probe_output_dir/credential-probe.json" ]] \
    || die "credential probe output is unsafe"
  chown --no-dereference 0:0 -- "$probe_output_dir/credential-probe.json"
  chown 0:0 -- "$probe_output_dir"
fi
require_secure_regular_file "$probe_output_dir/credential-probe.json" 600 "$(id -u)" \
  || die "credential probe output is unsafe"
mv -T -- "$probe_output_dir/credential-probe.json" "$stage/credential-probe.json"
rmdir -- "$probe_output_dir"

pre_images="$stage/images.pre"
post_images="$stage/images.post"
capture_image_map "$pre_images" false || die "active container image inventory is invalid"
capture_running_mutators captured_mutators || die "running mutator capture failed"
running_before="$(compose_cmd ps --status running --services)" \
  || die "running service inventory failed"
validate_running_services "$running_before" \
  || die "a conflicting or unknown Compose service is running"

if ! age-keygen -o "$identity" >/dev/null 2>&1; then
  die "ephemeral age identity generation failed"
fi
chmod 0600 -- "$identity"
if ! age-keygen -y "$identity" >"$ephemeral_recipient" 2>/dev/null; then
  die "ephemeral age recipient derivation failed"
fi
chmod 0600 -- "$ephemeral_recipient"
cat -- "$AGE_RECIPIENT_FILE" "$ephemeral_recipient" >"$combined_recipients"
chmod 0600 -- "$combined_recipients"

deadline_seconds=$((SECONDS + QUIESCE_BUDGET_SECONDS))
quiesce_started=1
phase=quiescing
log "backup phase=quiescing"
quiesce_command='set -Eeuo pipefail; source "$1"; config="$2"; shift 2; BACKUP_CONFIG_FILE="$config"; load_backup_config; captured_for_child=("$@"); quiesce_mutators captured_for_child'
run_deadline bash -c "$quiesce_command" _ "$SCRIPT_DIR/common.sh" \
  "${BACKUP_CONFIG_FILE:-/etc/learncoding/backup.env}" "${captured_mutators[@]}"
phase=quiesced
log "backup phase=quiesced"

running_after="$(run_deadline docker compose --env-file "$COMPOSE_ENV_FILE" \
  -f "$REPO_ROOT/compose.yaml" ps --status running --services)" \
  || die "post-quiesce service confirmation failed"
while IFS= read -r service; do
  [[ -z "$service" || "$service" == postgres || "$service" == clamav ]] \
    || die "a mutating or unknown service remained running"
done <<<"$running_after"

snapshot_timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
database_version="$(run_deadline docker compose --env-file "$COMPOSE_ENV_FILE" \
  -f "$REPO_ROOT/compose.yaml" exec -T postgres postgres --version)" \
  || die "PostgreSQL version query failed"
database_version="${database_version//$'\r'/}"
database_version="${database_version//$'\n'/}"
[[ "$database_version" =~ ^postgres[[:space:]]+\(PostgreSQL\)[[:space:]]+17([.][0-9]+)?([[:space:]][A-Za-z0-9._+\(\)/:=-]+)*$ ]] \
  || die "PostgreSQL version is outside the reviewed major"

migration_rows="$stage/migrations.rows"
run_deadline docker compose --env-file "$COMPOSE_ENV_FILE" \
  -f "$REPO_ROOT/compose.yaml" exec -T postgres sh -ceu \
  'exec psql --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" --no-psqlrc --quiet --tuples-only --no-align --field-separator="|" --set=ON_ERROR_STOP=1 --command="SELECT id, hash, created_at FROM drizzle.__drizzle_migrations ORDER BY id"' \
  >"$migration_rows"
migration_count=0
migration_last_id=0
migration_last_created_at=0
while IFS='|' read -r migration_id migration_entry_hash migration_created extra; do
  [[ -n "$migration_id" ]] || continue
  [[ -z "${extra:-}" && "$migration_id" =~ ^[0-9]+$ \
    && "$migration_entry_hash" =~ ^[0-9a-f]+$ \
    && "$migration_created" =~ ^[0-9]+$ ]] \
    || die "migration state query returned unsafe data"
  ((migration_count += 1))
  migration_last_id="$migration_id"
  migration_last_created_at="$migration_created"
done <"$migration_rows"
migration_state_sha256="$(run_deadline sha256sum "$migration_rows")" \
  || die "migration state checksum failed"
migration_state_sha256="${migration_state_sha256%% *}"

log "backup phase=dumping"
run_deadline docker compose --env-file "$COMPOSE_ENV_FILE" \
  -f "$REPO_ROOT/compose.yaml" exec -T postgres sh -ceu \
  'exec pg_dump --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" --format=custom --compress=9 --no-owner --no-acl' \
  >"$stage/database.dump"
[[ -s "$stage/database.dump" ]] || die "PostgreSQL dump is empty"
phase=dump_complete
log "backup phase=dump_complete"

app_data_included=false
if [[ -e "$LEARN_DATA_ROOT/app-data" || -L "$LEARN_DATA_ROOT/app-data" ]]; then
  [[ -d "$LEARN_DATA_ROOT/app-data" && ! -L "$LEARN_DATA_ROOT/app-data" ]] \
    || die "application data root is unsafe"
  unsafe_app_entry="$(run_deadline find -P "$LEARN_DATA_ROOT/app-data" \
    -mindepth 1 ! -type f ! -type d -print -quit)" \
    || die "application data safety scan failed"
  [[ -z "$unsafe_app_entry" ]] || die "application data contains an unsafe entry"
  run_deadline tar --sort=name --format=posix \
    --pax-option=delete=atime,delete=ctime \
    --owner=0 --group=0 --numeric-owner --mode='u+rwX,go+rX,go-w' \
    --mtime="$tar_mtime" --use-compress-program='gzip -n' \
    --exclude='.env' --exclude='.env.*' --exclude='*.pem' --exclude='*.key' \
    --exclude='*credentials*.json' --exclude='*.eml' --exclude='*.mbox' \
    --exclude='*.pst' --exclude='*.ost' --exclude='*/mail/*' --exclude='*/email/*' \
    --exclude='*mail-backup*' --create --file "$stage/app-data.tar.gz" \
    --directory "$LEARN_DATA_ROOT" app-data >/dev/null 2>&1
  app_data_included=true
fi
phase=objects_complete
log "backup phase=objects_complete"

running_after_objects="$(run_deadline docker compose --env-file "$COMPOSE_ENV_FILE" \
  -f "$REPO_ROOT/compose.yaml" ps --status running --services)" \
  || die "post-capture service confirmation failed"
while IFS= read -r service; do
  [[ -z "$service" || "$service" == postgres || "$service" == clamav ]] \
    || die "a mutating or unknown service ran during recovery-point capture"
done <<<"$running_after_objects"

post_commit="$(run_deadline git -C "$repo_real" rev-parse --verify HEAD)" \
  || die "installed release commit recheck failed"
[[ "$post_commit" == "$pre_commit" ]] || die "installed release changed during backup"
capture_image_map "$post_images" true || die "container image inventory recheck failed"
cmp -s -- "$pre_images" "$post_images" || die "container image inventory changed during backup"

cat >"$stage/MANIFEST.txt" <<EOF
format=learncoding-backup-v1
created_utc=$timestamp
snapshot_utc=$snapshot_timestamp
source_host=$source_host
git_commit=$pre_commit
database_version=$database_version
migration_count=$migration_count
migration_last_id=$migration_last_id
migration_last_created_at=$migration_last_created_at
migration_state_sha256=$migration_state_sha256
app_data_included=$app_data_included
contains_secret_files=false
contains_email_exports=false
EOF
while IFS='=' read -r image_service image_id; do
  printf 'image_id.%s=%s\n' "$image_service" "$image_id" >>"$stage/MANIFEST.txt"
done <"$pre_images"

checksum_command='set -Eeuo pipefail; cd "$1"; if [[ "$2" == true ]]; then sha256sum --text database.dump repository.tar.gz app-data.tar.gz credential-probe.json MANIFEST.txt >SHA256SUMS; else sha256sum --text database.dump repository.tar.gz credential-probe.json MANIFEST.txt >SHA256SUMS; fi'
run_deadline bash -c "$checksum_command" _ "$stage" "$app_data_included"

outer_members=(MANIFEST.txt SHA256SUMS)
[[ "$app_data_included" != true ]] || outer_members+=(app-data.tar.gz)
outer_members+=(credential-probe.json database.dump repository.tar.gz)
run_deadline tar --sort=name --format=posix \
  --pax-option=delete=atime,delete=ctime \
  --owner=0 --group=0 --numeric-owner --mode='u=rw,go=' --mtime="$tar_mtime" \
  --use-compress-program='gzip -n' --create --file "$outer_plain" \
  --directory "$stage" "${outer_members[@]}"

tmp_archive="$(mktemp -- "$full_dir/.${filename}.tmp.XXXXXX")"
rm -f -- "$tmp_archive"
run_deadline age --encrypt --recipients-file "$combined_recipients" \
  --output "$tmp_archive" "$outer_plain" >/dev/null 2>&1
[[ -f "$tmp_archive" && ! -L "$tmp_archive" && -s "$tmp_archive" ]] \
  || die "encrypted candidate is empty"
chmod 0600 -- "$tmp_archive"
phase=encrypted
log "backup phase=encrypted"

verify_result="$(run_deadline bash "$SCRIPT_DIR/verify-archive.sh" \
  "$tmp_archive" "$identity" "$verify_dir")" \
  || die "candidate decrypt verification failed"
[[ "$verify_result" == archive_valid=true ]] \
  || die "candidate verifier returned an invalid acknowledgement"
phase=candidate_verified
log "backup phase=candidate_verified"

run_deadline sync -f -- "$tmp_archive"
ciphertext_hash="$(run_deadline sha256sum "$tmp_archive")" \
  || die "ciphertext checksum creation failed"
ciphertext_hash="${ciphertext_hash%% *}"
[[ "$ciphertext_hash" =~ ^[0-9a-f]{64}$ ]] || die "ciphertext checksum is invalid"
tmp_checksum="$(mktemp -- "$full_dir/.${filename}.sha256.tmp.XXXXXX")"
printf '%s  %s\n' "$ciphertext_hash" "$filename" >"$tmp_checksum"
chmod 0600 -- "$tmp_checksum"
run_deadline sync -f -- "$tmp_checksum"

run_deadline mv -T -- "$tmp_archive" "$final_archive"
tmp_archive=""
archive_published=1
run_deadline mv -T -- "$tmp_checksum" "$final_checksum"
tmp_checksum=""
checksum_published=1
require_secure_regular_file "$final_archive" 600 "$(id -u)" \
  || die "published archive metadata is unsafe"
require_secure_regular_file "$final_checksum" 600 "$(id -u)" \
  || die "published checksum metadata is unsafe"
published_sidecar="$(run_deadline cat -- "$final_checksum")" \
  || die "published checksum could not be read"
[[ "$published_sidecar" == "$ciphertext_hash  $filename" ]] \
  || die "published checksum content is invalid"
final_hash="$(run_deadline sha256sum "$final_archive")"
final_hash="${final_hash%% *}"
[[ "$final_hash" == "$ciphertext_hash" ]] || die "published archive hash changed"
run_deadline sync -f -- "$full_dir"
phase=files_published
log "backup phase=files_published"

completed_utc="$(date -u +%Y%m%dT%H%M%SZ)"
marker_command='set -Eeuo pipefail; source "$1"; write_success_marker "$2" "$3" "$4" "$5"'
if ! run_deadline bash -c "$marker_command" _ "$SCRIPT_DIR/common.sh" \
  "$marker" "$filename" "$completed_utc" "$ciphertext_hash"; then
  if read_success_marker "$marker" \
    && [[ "$SUCCESS_ARCHIVE" == "$filename" \
      && "$SUCCESS_COMPLETED_UTC" == "$completed_utc" \
      && "$SUCCESS_SHA256" == "$ciphertext_hash" ]]; then
    marker_committed=1
  elif [[ -e "$marker" || -L "$marker" ]]; then
    if ! read_success_marker "$marker"; then
      publication_commit_uncertain=1
    fi
  fi
  die "success marker durability failed"
fi
marker_committed=1
phase=marker_committed
log "backup phase=marker_committed"

log "backup phase=pruning"
run_deadline env BACKUP_LOCK_HELD=1 \
  BACKUP_CONFIG_FILE="${BACKUP_CONFIG_FILE:-/etc/learncoding/backup.env}" \
  bash "$SCRIPT_DIR/prune.sh"

resume_captured
if ! enqueue_backup_status success "$timestamp"; then
  emit_alert warning backup_report_not_queued \
    "backup success status could not be queued; inspect protected operations logs"
fi
emit_alert info backup_complete \
  "nightly encrypted backup completed and passed decrypt verification"
completed=1
log "backup phase=complete"
