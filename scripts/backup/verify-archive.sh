#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
export LC_ALL=C

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"

phase=preflight
destination=""
destination_ready=0
destination_created=0
destination_identity=""
decrypted=""
verification_ok=0

cleanup_verification() {
  local status=$? current_destination_identity=""
  trap - EXIT
  if ((destination_ready == 1)); then
    current_destination_identity="$(
      stat -c '%d:%i:%u:%a' -- "$destination" 2>/dev/null
    )" || current_destination_identity=""
    if [[ -n "$destination_identity" \
      && "$current_destination_identity" == "$destination_identity" \
      && -d "$destination" && ! -L "$destination" ]]; then
      if [[ -n "$decrypted" && -f "$decrypted" ]]; then
        rm -f -- "$decrypted" 2>/dev/null || status=1
      fi
      if ((verification_ok == 0)); then
        find -P "$destination" -mindepth 1 -delete 2>/dev/null || status=1
        if ((destination_created == 1)); then
          rmdir -- "$destination" 2>/dev/null || status=1
        fi
      fi
    elif ((verification_ok == 0)); then
      status=1
    fi
  fi
  if ((verification_ok == 0)); then
    printf 'archive_verification_failed phase=%s\n' "$phase" >&2
    exit 1
  fi
  exit "$status"
}
trap cleanup_verification EXIT

verification_fail() {
  phase="$1"
  exit 1
}

[[ $# -eq 3 ]] || verification_fail invocation
archive="$1"
identity="$2"
destination="$3"
[[ "$archive" == /* && "$identity" == /* && "$destination" == /* ]] \
  || verification_fail paths
[[ -f "$archive" && ! -L "$archive" && -s "$archive" ]] \
  || verification_fail ciphertext
require_secure_regular_file "$identity" 600 "$(id -u)" \
  || verification_fail identity

config_file="${BACKUP_CONFIG_FILE:-/etc/learncoding/backup.env}"
require_secure_regular_file "$config_file" 600 "$(id -u)" \
  || verification_fail configuration
# The root-controlled backup configuration is already the common backup API.
# shellcheck disable=SC1090
source "$config_file"
: "${REPO_ROOT:=/opt/learncoding}"
: "${LEARN_DATA_ROOT:=/srv/learncoding}"
: "${BACKUP_ROOT:?BACKUP_ROOT is required}"

for command_name in age find realpath sha256sum tar; do
  command -v "$command_name" >/dev/null 2>&1 || verification_fail tooling
done

destination_canonical="$(realpath -m -- "$destination" 2>/dev/null)" \
  || verification_fail destination
[[ "$destination_canonical" == "$destination" ]] \
  || verification_fail destination

protected_roots=("$REPO_ROOT" "$LEARN_DATA_ROOT" "$BACKUP_ROOT")
if [[ -n "${EMERGENCY_BACKUP_ROOT:-}" ]]; then
  protected_roots+=("$EMERGENCY_BACKUP_ROOT")
fi
for live_root in "${protected_roots[@]}"; do
  [[ "$live_root" == /* ]] || verification_fail configuration
  if path_is_within "$destination" "$live_root" \
    || path_is_within "$live_root" "$destination"; then
    verification_fail destination
  fi
done

if [[ -e "$destination" || -L "$destination" ]]; then
  [[ -d "$destination" && ! -L "$destination" ]] || verification_fail destination
  [[ "$(stat -c '%a' -- "$destination" 2>/dev/null)" == 700 \
    && "$(stat -c '%u' -- "$destination" 2>/dev/null)" == "$(id -u)" ]] \
    || verification_fail destination
  [[ -z "$(find -P "$destination" -mindepth 1 -print -quit 2>/dev/null)" ]] \
    || verification_fail destination
else
  mkdir -m 0700 -- "$destination" 2>/dev/null || verification_fail destination
  destination_created=1
fi
destination_ready=1
destination_identity="$(stat -c '%d:%i:%u:%a' -- "$destination" 2>/dev/null)" \
  || verification_fail destination
decrypted="$destination/.archive.plain.tmp"

phase=decrypt
if ! age --decrypt --identity "$identity" --output "$decrypted" "$archive" \
  >/dev/null 2>&1; then
  verification_fail decrypt
fi
[[ -f "$decrypted" && ! -L "$decrypted" && -s "$decrypted" ]] \
  || verification_fail decrypt
chmod 0600 -- "$decrypted" 2>/dev/null || verification_fail decrypt

declare -A outer_seen=()
declare -a outer_names=() outer_verbose=()
phase=outer-list
outer_names_output="$(
  tar --list --file "$decrypted" --absolute-names --quoting-style=escape 2>/dev/null
)" || verification_fail outer-list
outer_verbose_output="$(
  tar --list --verbose --file "$decrypted" --absolute-names --quoting-style=escape 2>/dev/null
)" || verification_fail outer-list
mapfile -t outer_names <<<"$outer_names_output"
mapfile -t outer_verbose <<<"$outer_verbose_output"
((${#outer_names[@]} > 0 && ${#outer_names[@]} == ${#outer_verbose[@]})) \
  || verification_fail outer-list
for index in "${!outer_names[@]}"; do
  name="${outer_names[$index]}"
  [[ "$name" =~ ^(database\.dump|repository\.tar\.gz|app-data\.tar\.gz|credential-probe\.json|recovery-config\.tar\.gz|MANIFEST\.txt|SHA256SUMS)$ ]] \
    || verification_fail outer-member
  [[ -z "${outer_seen[$name]+x}" ]] || verification_fail outer-duplicate
  outer_seen[$name]=1
  [[ "${outer_verbose[$index]:0:1}" == - ]] || verification_fail outer-type
  permissions="${outer_verbose[$index]:0:10}"
  [[ "$permissions" != *x* && "$permissions" != *s* && "$permissions" != *t* ]] \
    || verification_fail outer-mode
done

phase=extract
if ! tar --extract --file "$decrypted" --directory "$destination" \
  --no-same-owner --no-same-permissions --keep-old-files \
  >/dev/null 2>&1; then
  verification_fail extract
fi
rm -f -- "$decrypted" || verification_fail cleanup
decrypted=""
[[ -f "$destination/MANIFEST.txt" && ! -L "$destination/MANIFEST.txt" \
  && -f "$destination/SHA256SUMS" && ! -L "$destination/SHA256SUMS" ]] \
  || verification_fail schema

phase=manifest
mapfile -t manifest_lines <"$destination/MANIFEST.txt" || verification_fail manifest
((${#manifest_lines[@]} > 0)) || verification_fail manifest
if LC_ALL=C grep -q '[^ -~]' "$destination/MANIFEST.txt"; then
  verification_fail manifest
fi
declare -A manifest_values=() image_values=()
declare -a image_order=()
for line in "${manifest_lines[@]}"; do
  [[ "$line" == *=* ]] || verification_fail manifest
  key="${line%%=*}"
  value="${line#*=}"
  [[ -n "$key" && -n "$value" ]] || verification_fail manifest
  if [[ "$key" == image_id.* ]]; then
    service="${key#image_id.}"
    [[ "$service" =~ ^[a-z0-9-]+$ && -z "${image_values[$service]+x}" ]] \
      || verification_fail manifest
    image_values[$service]="$value"
    image_order+=("$service")
  else
    [[ "$key" =~ ^[a-z_][a-z0-9_]*$ && -z "${manifest_values[$key]+x}" ]] \
      || verification_fail manifest
    manifest_values[$key]="$value"
  fi
done
format="${manifest_values[format]:-}"

require_manifest_key() {
  [[ -n "${manifest_values[$1]+x}" ]] || verification_fail manifest
}

validate_timestamp() {
  _valid_compact_utc_timestamp "$1" || verification_fail manifest
}

declare -a checksum_members=() expected_outer_names=()
case "$format" in
  learncoding-backup-v1)
    readonly -a full_keys=(
      format created_utc snapshot_utc source_host git_commit database_version
      migration_count migration_last_id migration_last_created_at
      migration_state_sha256 app_data_included contains_secret_files
      contains_email_exports
    )
    ((${#manifest_values[@]} == ${#full_keys[@]})) || verification_fail manifest
    for key in "${full_keys[@]}"; do require_manifest_key "$key"; done
    validate_timestamp "${manifest_values[created_utc]}"
    validate_timestamp "${manifest_values[snapshot_utc]}"
    [[ "${manifest_values[source_host]}" =~ ^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$ ]] \
      || verification_fail manifest
    [[ "${manifest_values[git_commit]}" =~ ^([0-9a-f]{40}|[0-9a-f]{64})$ ]] \
      || verification_fail manifest
    [[ "${manifest_values[database_version]}" =~ ^postgres[[:space:]]+\(PostgreSQL\)[[:space:]]+17([.][0-9]+)?([[:space:]][A-Za-z0-9._+\(\)/:=-]+)*$ ]] \
      || verification_fail manifest
    for key in migration_count migration_last_id migration_last_created_at; do
      [[ "${manifest_values[$key]}" =~ ^[0-9]+$ ]] || verification_fail manifest
    done
    [[ "${manifest_values[migration_state_sha256]}" =~ ^[0-9a-f]{64}$ ]] \
      || verification_fail manifest
    [[ "${manifest_values[app_data_included]}" == true \
      || "${manifest_values[app_data_included]}" == false ]] \
      || verification_fail manifest
    [[ "${manifest_values[contains_secret_files]}" == false \
      && "${manifest_values[contains_email_exports]}" == false ]] \
      || verification_fail manifest

    readonly -a required_services=(
      app cloudflared exam-finalization-worker mail-worker migrate postgres
      practice-runner-recovery-worker project-review-correction-worker
      regrade-worker reward-worker
    )
    readonly -a optional_services=(
      clamav scan-worker lifecycle platform-seed admin-bootstrap
    )
    for service in "${image_order[@]}"; do
      known=0
      for allowed in "${required_services[@]}" "${optional_services[@]}"; do
        [[ "$service" != "$allowed" ]] || known=1
      done
      ((known == 1)) || verification_fail manifest
      [[ "${image_values[$service]}" =~ ^sha256:[0-9a-f]{64}$ ]] \
        || verification_fail manifest
    done
    for service in "${required_services[@]}"; do
      [[ -n "${image_values[$service]+x}" ]] || verification_fail manifest
    done
    sorted_images="$(printf '%s\n' "${image_order[@]}" | sort)"
    [[ "$sorted_images" == "$(printf '%s\n' "${image_order[@]}")" ]] \
      || verification_fail manifest

    [[ -n "${outer_seen[database.dump]+x}" \
      && -n "${outer_seen[repository.tar.gz]+x}" \
      && -n "${outer_seen[credential-probe.json]+x}" \
      && -n "${outer_seen[MANIFEST.txt]+x}" \
      && -n "${outer_seen[SHA256SUMS]+x}" ]] || verification_fail schema
    checksum_members=(database.dump repository.tar.gz)
    if [[ "${manifest_values[app_data_included]}" == true ]]; then
      [[ ${#outer_seen[@]} -eq 6 && -n "${outer_seen[app-data.tar.gz]+x}" ]] \
        || verification_fail schema
      checksum_members+=(app-data.tar.gz)
      expected_outer_names=(
        MANIFEST.txt SHA256SUMS app-data.tar.gz credential-probe.json
        database.dump repository.tar.gz
      )
    else
      [[ ${#outer_seen[@]} -eq 5 && -z "${outer_seen[app-data.tar.gz]+x}" ]] \
        || verification_fail schema
      expected_outer_names=(
        MANIFEST.txt SHA256SUMS credential-probe.json database.dump
        repository.tar.gz
      )
    fi
    checksum_members+=(credential-probe.json MANIFEST.txt)
    ;;
  learncoding-emergency-v1)
    readonly -a emergency_keys=(
      format created_utc git_commit scope contains_secret_files
      contains_email_exports
    )
    ((${#manifest_values[@]} == ${#emergency_keys[@]} && ${#image_values[@]} == 0)) \
      || verification_fail manifest
    for key in "${emergency_keys[@]}"; do require_manifest_key "$key"; done
    validate_timestamp "${manifest_values[created_utc]}"
    [[ "${manifest_values[git_commit]}" =~ ^([0-9a-f]{40}|[0-9a-f]{64})$ \
      && "${manifest_values[scope]}" == database-and-non-secret-recovery-config-only \
      && "${manifest_values[contains_secret_files]}" == false \
      && "${manifest_values[contains_email_exports]}" == false ]] \
      || verification_fail manifest
    [[ ${#outer_seen[@]} -eq 4 \
      && -n "${outer_seen[database.dump]+x}" \
      && -n "${outer_seen[recovery-config.tar.gz]+x}" \
      && -n "${outer_seen[MANIFEST.txt]+x}" \
      && -n "${outer_seen[SHA256SUMS]+x}" ]] || verification_fail schema
    checksum_members=(database.dump recovery-config.tar.gz MANIFEST.txt)
    expected_outer_names=(
      MANIFEST.txt SHA256SUMS database.dump recovery-config.tar.gz
    )
    ;;
  *) verification_fail manifest ;;
esac

((${#outer_names[@]} == ${#expected_outer_names[@]})) || verification_fail schema
for index in "${!expected_outer_names[@]}"; do
  [[ "${outer_names[$index]}" == "${expected_outer_names[$index]}" ]] \
    || verification_fail schema
done

phase=checksums
mapfile -t checksum_lines <"$destination/SHA256SUMS" || verification_fail checksums
((${#checksum_lines[@]} == ${#checksum_members[@]})) || verification_fail checksums
for index in "${!checksum_members[@]}"; do
  line="${checksum_lines[$index]}"
  [[ ${#line} -gt 66 ]] || verification_fail checksums
  checksum_hash="${line:0:64}"
  checksum_separator="${line:64:2}"
  checksum_name="${line:66}"
  [[ "$checksum_hash" =~ ^[0-9a-f]{64}$ \
    && "$checksum_separator" == "  " \
    && "$checksum_name" == "${checksum_members[$index]}" ]] \
    || verification_fail checksums
done
if ! (cd "$destination" && sha256sum --check --strict --quiet SHA256SUMS) \
  >/dev/null 2>&1; then
  verification_fail checksums
fi

validate_nested_archive() {
  local nested="$1" schema="$2" nested_name nested_canonical nested_index nested_type
  local nested_permissions nested_lower nested_basename
  local nested_parent
  local nested_names_output nested_verbose_output
  local -a nested_names=() nested_verbose=()
  local -A nested_seen=() nested_types=() nested_has_descendants=()
  nested_names_output="$(
    tar --list --gzip --file "$nested" --absolute-names --quoting-style=escape 2>/dev/null
  )" || return 1
  nested_verbose_output="$(
    tar --list --verbose --gzip --file "$nested" --absolute-names --quoting-style=escape 2>/dev/null
  )" || return 1
  mapfile -t nested_names <<<"$nested_names_output"
  mapfile -t nested_verbose <<<"$nested_verbose_output"
  ((${#nested_names[@]} > 0 && ${#nested_names[@]} == ${#nested_verbose[@]})) || return 1
  for nested_index in "${!nested_names[@]}"; do
    nested_name="${nested_names[$nested_index]}"
    [[ "$nested_name" =~ ^[A-Za-z0-9._+@:/-]+/?$ \
      && "$nested_name" != *\\* \
      && "$nested_name" != /* \
      && "$nested_name" != ./* \
      && "$nested_name" != *"//"* \
      && "$nested_name" != */./* \
      && "$nested_name" != */. \
      && "$nested_name" != ".." \
      && "$nested_name" != ../* \
      && "$nested_name" != */../* \
      && "$nested_name" != */.. ]] || return 1
    nested_type="${nested_verbose[$nested_index]:0:1}"
    [[ "$nested_type" == - || "$nested_type" == d ]] || return 1
    nested_permissions="${nested_verbose[$nested_index]:0:10}"
    if [[ "$nested_type" == d ]]; then
      [[ "$nested_permissions" == drwxr-xr-x ]] || return 1
    else
      [[ "$nested_permissions" == -rw-r--r-- \
        || "$nested_permissions" == -rwxr-xr-x ]] || return 1
    fi
    if [[ "$nested_type" == d ]]; then
      [[ "$nested_name" == */ ]] || return 1
    else
      [[ "$nested_name" != */ ]] || return 1
    fi
    nested_canonical="${nested_name%/}"
    [[ -n "$nested_canonical" && -z "${nested_seen[$nested_canonical]+x}" ]] || return 1
    if [[ "$nested_type" == - && -n "${nested_has_descendants[$nested_canonical]+x}" ]]; then
      return 1
    fi
    nested_parent="$nested_canonical"
    while [[ "$nested_parent" == */* ]]; do
      nested_parent="${nested_parent%/*}"
      if [[ -n "${nested_types[$nested_parent]+x}" \
        && "${nested_types[$nested_parent]}" != d ]]; then
        return 1
      fi
    done
    nested_seen[$nested_canonical]=1
    nested_types[$nested_canonical]="$nested_type"
    nested_parent="$nested_canonical"
    while [[ "$nested_parent" == */* ]]; do
      nested_parent="${nested_parent%/*}"
      nested_has_descendants[$nested_parent]=1
    done
    nested_lower="${nested_canonical,,}"
    nested_basename="${nested_lower##*/}"
    case "$nested_basename" in
      .env|.env.*|*.pem|*.key|*credentials*.json|*.eml|*.mbox|*.pst|*.ost)
        return 1
        ;;
    esac
    case "/$nested_lower/" in
      */infra/secrets/*|*/infra/cloudflare/config.yml/*|*/mail/*|*/email/*|*mail-backup*)
        return 1
        ;;
    esac
    case "$schema" in
      repository)
        case "$nested_canonical" in
          .dockerignore|Dockerfile|compose.yaml|content|content/*|drizzle|drizzle/*|\
          infra|infra/*|docs|docs/deployment.md|docs/runbooks|docs/runbooks/*) ;;
          *) return 1 ;;
        esac
        ;;
      app-data)
        case "$nested_canonical" in
          app-data|app-data/*) ;;
          *) return 1 ;;
        esac
        ;;
      recovery)
        case "$nested_canonical" in
          .dockerignore|Dockerfile|compose.yaml|drizzle|drizzle/*|docs|\
          docs/deployment.md|docs/runbooks|docs/runbooks/*|infra|infra/env|\
          infra/env/*|infra/systemd|infra/systemd/*) ;;
          *) return 1 ;;
        esac
        ;;
      *) return 1 ;;
    esac
  done
  case "$schema" in
    repository)
      [[ "${nested_types[.dockerignore]:-}" == - \
        && "${nested_types[Dockerfile]:-}" == - \
        && "${nested_types[compose.yaml]:-}" == - \
        && "${nested_types[content]:-}" == d \
        && "${nested_types[drizzle]:-}" == d \
        && "${nested_types[infra]:-}" == d \
        && "${nested_types[docs/deployment.md]:-}" == - \
        && "${nested_types[docs/runbooks]:-}" == d ]] || return 1
      ;;
    app-data)
      [[ "${nested_types[app-data]:-}" == d ]] || return 1
      ;;
    recovery)
      [[ "${nested_types[.dockerignore]:-}" == - \
        && "${nested_types[Dockerfile]:-}" == - \
        && "${nested_types[compose.yaml]:-}" == - \
        && "${nested_types[drizzle]:-}" == d \
        && "${nested_types[infra/env]:-}" == d \
        && "${nested_types[infra/systemd]:-}" == d \
        && "${nested_types[docs/deployment.md]:-}" == - \
        && "${nested_types[docs/runbooks]:-}" == d ]] || return 1
      ;;
  esac
}

phase=nested-archives
case "$format" in
  learncoding-backup-v1)
    validate_nested_archive "$destination/repository.tar.gz" repository \
      || verification_fail nested-archives
    if [[ "${manifest_values[app_data_included]}" == true ]]; then
      validate_nested_archive "$destination/app-data.tar.gz" app-data \
        || verification_fail nested-archives
    fi
    ;;
  learncoding-emergency-v1)
    validate_nested_archive "$destination/recovery-config.tar.gz" recovery \
      || verification_fail nested-archives
    ;;
esac

verification_ok=1
printf '%s\n' archive_valid=true
