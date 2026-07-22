#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

fatal() {
  echo "fatal: $*" >&2
  exit 1
}

post_start=false
pre_privileged=false
case "$#" in
  0) ;;
  1)
    case "$1" in
      --post-start) post_start=true ;;
      --pre-privileged) pre_privileged=true ;;
      *) fatal "usage: validate-runtime.sh [--post-start|--pre-privileged]" ;;
    esac
    ;;
  *) fatal "usage: validate-runtime.sh [--post-start|--pre-privileged]" ;;
esac

readonly repo_root="${REPO_ROOT:-/opt/learncoding}"
readonly compose_env="${COMPOSE_ENV_FILE:-/etc/learncoding/compose.env}"
readonly validation_mode="${VALIDATION_MODE:-pilot}"

[[ -f "$repo_root/compose.yaml" ]] || fatal "compose.yaml missing"
[[ ! -L "$compose_env" ]] || fatal "compose environment file must not be a symlink: $compose_env"
[[ -f "$compose_env" ]] || fatal "compose environment file missing"

readonly trusted_stat_bin="/usr/bin/stat"
[[ -x "$trusted_stat_bin" ]] || fatal "trusted stat is missing: $trusted_stat_bin"
readonly trusted_realpath_bin="/usr/bin/realpath"
[[ -x "$trusted_realpath_bin" ]] || fatal "trusted realpath is missing: $trusted_realpath_bin"

compose_env_metadata="$("$trusted_stat_bin" -c '%u:%g:%a' -- "$compose_env")"
[[ "$compose_env_metadata" == "0:0:640" ]] || {
  fatal "compose environment file must be owned by root:root with mode 640: $compose_env"
}

resolved_docker_bin="$(type -P docker || true)"
[[ -n "$resolved_docker_bin" ]] || fatal "docker is missing"
readonly resolved_docker_bin
"$resolved_docker_bin" compose version >/dev/null
"$resolved_docker_bin" info >/dev/null
resolved_node_bin="$(type -P node || true)"
readonly resolved_node_bin
[[ -n "$resolved_node_bin" && -x "$resolved_node_bin" && ! -L "$resolved_node_bin" ]] \
  || fatal "trusted Node.js runtime is missing or unsafe"

image_is_digest_pinned() {
  local image="$1"
  [[ "$image" =~ ^[^@[:space:]]+@sha256:[0-9a-f]{64}$ ]]
}

validate_postgres_image_identity() {
  image_is_digest_pinned "${POSTGRES_IMAGE:-}" || fatal "POSTGRES_IMAGE must be pinned by sha256 digest"
  [[ "${POSTGRES_UID:-}" =~ ^[1-9][0-9]*$ ]] || fatal "POSTGRES_UID must be a canonical positive integer"
  [[ "${POSTGRES_GID:-}" =~ ^[1-9][0-9]*$ ]] || fatal "POSTGRES_GID must be a canonical positive integer"
  local postgres_config_user postgres_passwd_entry image_postgres_name image_postgres_password
  local image_postgres_uid image_postgres_gid image_postgres_gecos image_postgres_home
  local image_postgres_shell image_postgres_extra
  postgres_config_user="$("$resolved_docker_bin" image inspect --format '{{.Config.User}}' "$POSTGRES_IMAGE")" \
    || fatal "pinned PostgreSQL image identity cannot be inspected"
  postgres_passwd_entry="$(
    "$resolved_docker_bin" run --rm --pull never --network none --read-only \
      --cap-drop ALL --security-opt no-new-privileges \
      --entrypoint /usr/bin/getent "$POSTGRES_IMAGE" passwd postgres
  )" || fatal "pinned PostgreSQL image postgres identity cannot be inspected"
  IFS=: read -r image_postgres_name image_postgres_password image_postgres_uid \
    image_postgres_gid image_postgres_gecos image_postgres_home image_postgres_shell \
    image_postgres_extra <<<"$postgres_passwd_entry"
  [[ "$image_postgres_name" == postgres && -n "$image_postgres_password" \
    && "$image_postgres_uid" =~ ^[1-9][0-9]*$ && "$image_postgres_gid" =~ ^[1-9][0-9]*$ \
    && -n "$image_postgres_home" && -n "$image_postgres_shell" && -z "$image_postgres_extra" ]] \
    || fatal "pinned PostgreSQL image postgres identity is invalid"
  [[ "$POSTGRES_UID" == "$image_postgres_uid" && "$POSTGRES_GID" == "$image_postgres_gid" ]] \
    || fatal "POSTGRES_UID/POSTGRES_GID do not match the pinned PostgreSQL image"
  case "$postgres_config_user" in
    ""|postgres|"$image_postgres_uid"|"$image_postgres_uid:$image_postgres_gid") ;;
    *) fatal "pinned PostgreSQL image Config.User conflicts with its postgres identity" ;;
  esac
}

# This branch deliberately runs before the environment is sourced and before
# any repository JavaScript is executed. It may parse the preparer, but cannot
# execute it. The root-owned one-link file and non-writable ancestry are the
# trust boundary for the later privileged invocation in the systemd unit.
if [[ "$pre_privileged" == true ]]; then
  readonly object_storage_preparer="$repo_root/infra/ops/prepare-object-storage.mjs"
  readonly postgres_storage_preparer="$repo_root/infra/ops/prepare-postgres-control-socket.sh"
  [[ -f "$object_storage_preparer" && ! -L "$object_storage_preparer" ]] || {
    fatal "object storage preparer is missing or unsafe"
  }
  [[ -f "$postgres_storage_preparer" && -x "$postgres_storage_preparer" && ! -L "$postgres_storage_preparer" ]] || {
    fatal "PostgreSQL storage preparer is missing or unsafe"
  }
  [[ "$($trusted_realpath_bin -e -- "$object_storage_preparer")" == "$object_storage_preparer" ]] || {
    fatal "object storage preparer path must be canonical"
  }
  object_storage_preparer_metadata="$($trusted_stat_bin -c '%u:%g:%a:%h' -- "$object_storage_preparer")" || {
    fatal "object storage preparer identity cannot be inspected"
  }
  [[ "$($trusted_realpath_bin -e -- "$postgres_storage_preparer")" == "$postgres_storage_preparer" ]] || {
    fatal "PostgreSQL storage preparer path must be canonical"
  }
  postgres_storage_preparer_metadata="$($trusted_stat_bin -c '%u:%g:%a:%h' -- "$postgres_storage_preparer")" || {
    fatal "PostgreSQL storage preparer identity cannot be inspected"
  }
  [[ "$object_storage_preparer_metadata" == "0:0:644:1" ]] || {
    fatal "object storage preparer must be root:root mode 644 with one link"
  }
  [[ "$postgres_storage_preparer_metadata" == "0:0:755:1" ]] || {
    fatal "PostgreSQL storage preparer must be root:root mode 755 with one link"
  }
  for trusted_directory in "$repo_root" "$repo_root/infra" "$repo_root/infra/ops"; do
    [[ -d "$trusted_directory" && ! -L "$trusted_directory" ]] || fatal "privileged preparer ancestry is unsafe"
    trusted_directory_metadata="$($trusted_stat_bin -c '%u:%a' -- "$trusted_directory")" || fatal
    IFS=: read -r trusted_directory_uid trusted_directory_mode trusted_directory_extra \
      <<<"$trusted_directory_metadata"
    [[ "$trusted_directory_uid" == 0 && -z "$trusted_directory_extra" ]] || {
      fatal "privileged preparer ancestry must be root-owned"
    }
    (( (8#$trusted_directory_mode & 8#022) == 0 )) || {
      fatal "privileged preparer ancestry must not be group/world writable"
    }
  done
  "$resolved_node_bin" --check "$object_storage_preparer" >/dev/null || {
    fatal "object storage preparer syntax validation failed"
  }
  /usr/bin/bash -n "$postgres_storage_preparer" >/dev/null || {
    fatal "PostgreSQL storage preparer syntax validation failed"
  }
  validate_postgres_image_identity
  echo "pre-privileged runtime validation passed"
  exit 0
fi

set -a
# shellcheck disable=SC1090
source "$compose_env"
set +a

[[ "$validation_mode" == "pilot" || "$validation_mode" == "operations" ]] || {
  fatal "VALIDATION_MODE must be pilot or operations"
}
[[ "${SECRETS_GID:-}" == "2000" ]] || fatal "SECRETS_GID must be 2000"
[[ "${DEPLOY_PLATFORM:-linux/amd64}" == "linux/amd64" ]] || {
  fatal "this NUC deployment is reviewed for linux/amd64 only"
}

readonly -a immutable_image_variables=(
  POSTGRES_IMAGE
  CLOUDFLARED_IMAGE
  APP_RUNTIME_IMAGE
  APP_TOOLING_IMAGE
  APP_WORKER_IMAGE
  APP_REGRADE_WORKER_IMAGE
  APP_PROJECT_REVIEW_WORKER_IMAGE
  APP_SCANNER_WORKER_IMAGE
  APP_OPERATIONS_IMAGE
)
for image_variable in "${immutable_image_variables[@]}"; do
  image_value="${!image_variable:-}"
  image_is_digest_pinned "$image_value" || {
    fatal "$image_variable must be pinned by sha256 digest"
  }
done
validate_postgres_image_identity

[[ "${APP_URL:-}" =~ ^https://[A-Za-z0-9.-]+(:[0-9]+)?$ ]] || {
  fatal "APP_URL must be one HTTPS origin without a path"
}
[[ "$APP_URL" != "https://learn.example.com" ]] || {
  fatal "APP_URL still contains the example hostname"
}
[[ "${SOURCE_CODE_URL:-}" =~ ^https://[^[:space:]]+$ ]] || {
  fatal "SOURCE_CODE_URL must be an HTTPS URL"
}
[[ "$SOURCE_CODE_URL" != "https://github.com/your-account/learncoding" ]] || {
  fatal "SOURCE_CODE_URL still contains the example repository"
}

# A production release supplies its exact verified Git revision. Only then is
# the separately generated seven-image record a mandatory preflight input.
# This keeps the generic operator-only validator usable before a release while
# making every release transaction fail closed on the reviewed projection.
if [[ -n "${APPLICATION_EXPECTED_SOURCE_REVISION:-}" ]]; then
  [[ "$APPLICATION_EXPECTED_SOURCE_REVISION" =~ ^[0-9a-f]{40}([0-9a-f]{24})?$ ]] || {
    fatal "APPLICATION_EXPECTED_SOURCE_REVISION must be an exact lowercase Git commit"
  }
  [[ "${APPLICATION_EXPECTED_SOURCE_TREE:-}" =~ ^[0-9a-f]{40}([0-9a-f]{24})?$ ]] || {
    fatal "APPLICATION_EXPECTED_SOURCE_TREE must be an exact lowercase Git tree object id"
  }
  readonly application_image_record_json="${APPLICATION_IMAGE_RECORD_JSON:-$repo_root/dist/application-images/application-images.json}"
  readonly application_image_record_env="${APPLICATION_IMAGE_RECORD_ENV:-$repo_root/dist/application-images/application-images.env}"
  readonly application_image_record_verifier="$repo_root/infra/ops/verify-application-image-record.mjs"
  [[ -f "$application_image_record_verifier" && ! -L "$application_image_record_verifier" ]] || {
    fatal "application image record verifier is missing or unsafe"
  }
  [[ -n "$resolved_node_bin" && -x "$resolved_node_bin" && ! -L "$resolved_node_bin" ]] || {
    fatal "trusted Node.js runtime is missing or unsafe"
  }
  application_image_record_result="$(
    "$resolved_node_bin" "$application_image_record_verifier" \
      "$application_image_record_json" "$application_image_record_env" "$compose_env" \
      "$SOURCE_CODE_URL" "$APPLICATION_EXPECTED_SOURCE_REVISION" \
      --expected-source-tree "$APPLICATION_EXPECTED_SOURCE_TREE"
  )" || fatal "application image record verification failed"
  application_image_record_result_pattern='^application-image-record-id=[0-9a-f]{64} application-image-record-sha256=[0-9a-f]{64}$'
  [[ "$application_image_record_result" =~ $application_image_record_result_pattern ]] || {
    fatal "application image record verifier returned a non-canonical result"
  }
  unset application_image_record_result_pattern
  unset application_image_record_result
elif [[ -n "${APPLICATION_EXPECTED_SOURCE_TREE:-}${APPLICATION_IMAGE_RECORD_JSON:-}${APPLICATION_IMAGE_RECORD_ENV:-}" ]]; then
  fatal "application image tree or record paths require APPLICATION_EXPECTED_SOURCE_REVISION"
fi

[[ "${MAIL_ADAPTER:-console}" == "console" || "${MAIL_ADAPTER:-}" == "gmail" ]] || {
  fatal "MAIL_ADAPTER must be console or gmail"
}

case "${UPLOADS_ENABLED:-}" in
  true)
    [[ "${COMPOSE_PROFILES:-}" == uploads ]] || {
      fatal "UPLOADS_ENABLED=true requires COMPOSE_PROFILES=uploads exactly"
    }
    image_is_digest_pinned "${CLAMAV_IMAGE:-}" || {
      fatal "CLAMAV_IMAGE must be pinned by sha256 digest when uploads are enabled"
    }
    ;;
  false)
    [[ -z "${COMPOSE_PROFILES:-}" ]] || {
      fatal "UPLOADS_ENABLED=false requires COMPOSE_PROFILES to be empty"
    }
    ;;
  *)
    fatal "UPLOADS_ENABLED must be literal true or false"
    ;;
esac

raw_secrets_dir="${SECRETS_DIR:-/etc/learncoding/secrets}"
[[ "$raw_secrets_dir" == /* ]] || fatal "secrets directory path must be absolute"

raw_path_components=()
IFS='/' read -r -a raw_path_components <<<"$raw_secrets_dir"
for component in "${raw_path_components[@]}"; do
  [[ "$component" != "." && "$component" != ".." ]] || {
    fatal "secrets directory path must be canonical"
  }
done

secrets_dir="$("$trusted_realpath_bin" --canonicalize-missing --no-symlinks -- "$raw_secrets_dir" 2>/dev/null)" || {
  fatal "secrets directory path is invalid"
}
[[ -n "$secrets_dir" ]] || fatal "secrets directory path is invalid"
readonly secrets_dir

reject_symlinked_path_components() {
  local path="$1"
  local component
  local current=
  local -a components=()

  IFS='/' read -r -a components <<<"$path"
  for component in "${components[@]}"; do
    [[ -n "$component" ]] || continue
    current="$current/$component"
    [[ ! -L "$current" ]] || fatal "secrets directory must not be a symlink: $path"
  done
}

reject_symlinked_path_components "$secrets_dir"
[[ -d "$secrets_dir" ]] || fatal "secrets directory missing: $secrets_dir"

secrets_dir_metadata="$("$trusted_stat_bin" -c '%u:%g:%a' -- "$secrets_dir")"
[[ "$secrets_dir_metadata" == "0:2000:750" ]] || {
  fatal "secrets directory must be owned by root:2000 with mode 750: $secrets_dir"
}

validate_secret_entry() {
  local file="$1"
  local metadata

  [[ ! -L "$file" ]] || fatal "secret must not be a symlink: $file"
  [[ -f "$file" ]] || fatal "secret entry must be a regular file: $file"
  metadata="$("$trusted_stat_bin" -c '%u:%g:%a:%h' -- "$file")"
  [[ "$metadata" == "0:2000:440:1" ]] || {
    fatal "secret must be owned by root:2000 with mode 440 and one link: $file"
  }
}

# BEGIN CLOUDFLARE CONFIG CONTRACT
validate_cloudflare_config_contract() {
  local config_path="$1"
  local expected_hostname="$2"
  local expected_tunnel_id="$3"
  local expected_credentials_path="$4"
  local component current= resolved metadata line variant index matches
  local -a components=() actual_lines=() expected_lines=()

  [[ "$config_path" == /* ]] || fatal "Cloudflare config path must be absolute"
  IFS='/' read -r -a components <<<"$config_path"
  for component in "${components[@]}"; do
    [[ -n "$component" ]] || continue
    [[ "$component" != "." && "$component" != ".." ]] || {
      fatal "Cloudflare config path must be canonical"
    }
    current="$current/$component"
    [[ ! -L "$current" ]] || fatal "Cloudflare config path must not contain symlinks"
  done
  [[ -f "$config_path" && ! -L "$config_path" ]] || {
    fatal "Cloudflare tunnel config must be a regular non-symlink file"
  }
  resolved="$("$trusted_realpath_bin" --canonicalize-existing --no-symlinks -- "$config_path" 2>/dev/null)" || {
    fatal "Cloudflare config path is invalid"
  }
  [[ "$resolved" == "$config_path" ]] || fatal "Cloudflare config path must be canonical"
  metadata="$("$trusted_stat_bin" -c '%u:%g:%a:%h' -- "$config_path")" || {
    fatal "Cloudflare config identity cannot be inspected"
  }
  [[ "$metadata" == "0:0:640:1" ]] || {
    fatal "Cloudflare config must be root:root mode 640 with one link"
  }

  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" != *$'\r'* && "$line" != *$'\t'* && "$line" != *' ' ]] || {
      fatal "Cloudflare config must use canonical whitespace"
    }
    [[ -z "$line" || "$line" == \#* ]] && continue
    actual_lines+=("$line")
  done <"$config_path"

  for variant in minimal full; do
    if [[ "$variant" == minimal ]]; then
      expected_lines=(
        "tunnel: $expected_tunnel_id"
        "credentials-file: $expected_credentials_path"
        "ingress:"
        "  - hostname: $expected_hostname"
        "    service: http://app:3000"
        "  - service: http_status:404"
      )
    else
      expected_lines=(
        "tunnel: $expected_tunnel_id"
        "credentials-file: $expected_credentials_path"
        "originRequest:"
        "  connectTimeout: 10s"
        "  tcpKeepAlive: 30s"
        "  noHappyEyeballs: false"
        "ingress:"
        "  - hostname: $expected_hostname"
        "    service: http://app:3000"
        "    originRequest:"
        "      httpHostHeader: $expected_hostname"
        "  - service: http_status:404"
      )
    fi
    [[ "${#actual_lines[@]}" -eq "${#expected_lines[@]}" ]] || continue
    matches=true
    for index in "${!expected_lines[@]}"; do
      if [[ "${actual_lines[$index]}" != "${expected_lines[$index]}" ]]; then
        matches=false
        break
      fi
    done
    [[ "$matches" == true ]] && return 0
  done

  fatal "Cloudflare config does not match the reviewed tunnel and ingress contract"
}
# END CLOUDFLARE CONFIG CONTRACT

shopt -s nullglob dotglob
secret_entries=("$secrets_dir"/*)
shopt -u nullglob dotglob
for file in "${secret_entries[@]}"; do
  validate_secret_entry "$file"
done

readonly -a required_secrets=(
  postgres_password
  database_url
  database_bootstrap_url
  database_migrator_url
  database_worker_url
  database_ops_url
  better_auth_secret
  lost_device_proof_key
  deletion_tombstone_key
  credential_master_key
  runner_shared_secret
  cloudflare_tunnel_credentials.json
)
readonly -a provider_placeholder_secrets=(
  google_client_secret
  gmail_client_id
  gmail_client_secret
  gmail_refresh_token
)

require_secret_file() {
  local name="$1"
  local file="$secrets_dir/$name"

  [[ ! -L "$file" ]] || fatal "secret must not be a symlink: $file"
  [[ -f "$file" ]] || fatal "required secret is missing: $file"
}

require_nonempty_secret() {
  local name="$1"
  local file="$secrets_dir/$name"

  require_secret_file "$name"
  [[ -s "$file" ]] || fatal "required secret is empty: $file"
}

for name in "${required_secrets[@]}"; do
  require_nonempty_secret "$name"
done
for name in "${provider_placeholder_secrets[@]}"; do
  require_secret_file "$name"
done
readonly database_secret_validator="$repo_root/infra/ops/validate-database-secrets.mjs"
[[ -f "$database_secret_validator" && ! -L "$database_secret_validator" ]] \
  || fatal "database secret validator is missing or unsafe"
database_secret_result="$(
  "$resolved_node_bin" "$database_secret_validator" \
    "${POSTGRES_USER:-learncoding}" "${POSTGRES_DB:-learncoding}" \
    "$secrets_dir/postgres_password" \
    "$secrets_dir/database_bootstrap_url" \
    "$secrets_dir/database_url" \
    "$secrets_dir/database_migrator_url" \
    "$secrets_dir/database_worker_url" \
    "$secrets_dir/database_ops_url"
)" || fatal "database secret topology validation failed"
[[ "$database_secret_result" == "database secret topology valid" ]] \
  || fatal "database secret validator returned a non-canonical result"
unset database_secret_result

readonly cloudflare_credential_pattern='^\{"AccountTag":"([a-f0-9]{32})","TunnelSecret":"([A-Za-z0-9+/]{43}=)","TunnelID":"([a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})"\}$'
cloudflare_credentials="$(<"$secrets_dir/cloudflare_tunnel_credentials.json")"
if [[ "$cloudflare_credentials" == *$'\n'* || ! "$cloudflare_credentials" =~ $cloudflare_credential_pattern ]]; then
  unset cloudflare_credentials BASH_REMATCH
  fatal 'cloudflare tunnel credentials must contain only canonical AccountTag, TunnelSecret, and TunnelID fields'
fi
cloudflare_tunnel_secret="${BASH_REMATCH[2]}"
cloudflare_credentials_tunnel_id="${BASH_REMATCH[3]}"
decoded_cloudflare_secret_bytes="$(printf '%s' "$cloudflare_tunnel_secret" | base64 --decode 2>/dev/null | wc -c)" || {
  unset cloudflare_credentials cloudflare_tunnel_secret BASH_REMATCH
  fatal 'cloudflare tunnel credentials contain an invalid TunnelSecret'
}
canonical_cloudflare_tunnel_secret="$(printf '%s' "$cloudflare_tunnel_secret" | base64 --decode 2>/dev/null | base64 --wrap=0)" || {
  unset cloudflare_credentials cloudflare_tunnel_secret decoded_cloudflare_secret_bytes BASH_REMATCH
  fatal 'cloudflare tunnel credentials contain an invalid TunnelSecret'
}
unset cloudflare_credentials BASH_REMATCH
[[ "$decoded_cloudflare_secret_bytes" -eq 32 && "$canonical_cloudflare_tunnel_secret" == "$cloudflare_tunnel_secret" ]] || {
  unset cloudflare_tunnel_secret decoded_cloudflare_secret_bytes canonical_cloudflare_tunnel_secret
  fatal 'cloudflare tunnel credentials contain an invalid TunnelSecret'
}
unset cloudflare_tunnel_secret decoded_cloudflare_secret_bytes canonical_cloudflare_tunnel_secret

secret_non_whitespace_count() {
  local file="$1"
  tr -d '[:space:]' <"$file" | wc -c
}

for name in better_auth_secret lost_device_proof_key deletion_tombstone_key runner_shared_secret; do
  meaningful_characters="$(secret_non_whitespace_count "$secrets_dir/$name")"
  [[ "$meaningful_characters" -ge 32 ]] || {
    fatal "$name must contain at least 32 non-whitespace characters"
  }
done

decoded_key_bytes="$(tr -d '\r\n ' <"$secrets_dir/credential_master_key" | base64 --decode 2>/dev/null | wc -c)" || {
  fatal "credential_master_key is not valid base64"
}
[[ "$decoded_key_bytes" -eq 32 ]] || fatal "credential_master_key must decode to 32 bytes"

if [[ -n "${GOOGLE_CLIENT_ID:-}" ]]; then
  require_nonempty_secret google_client_secret
elif [[ -s "$secrets_dir/google_client_secret" ]]; then
  fatal "google_client_secret must be empty when GOOGLE_CLIENT_ID is empty"
fi

if [[ "${MAIL_ADAPTER:-console}" == "gmail" ]]; then
  for name in gmail_client_id gmail_client_secret gmail_refresh_token; do
    require_nonempty_secret "$name"
  done
else
  for name in gmail_client_id gmail_client_secret gmail_refresh_token; do
    [[ ! -s "$secrets_dir/$name" ]] || {
      fatal "$name must be empty when Gmail delivery is disabled"
    }
  done
fi

case "${REQUIRE_BOOTSTRAP_ADMIN_SECRET:-false}" in
  true)
    require_nonempty_secret bootstrap_admin_password
    bootstrap_characters="$(secret_non_whitespace_count "$secrets_dir/bootstrap_admin_password")"
    [[ "$bootstrap_characters" -ge 16 ]] || {
      fatal "bootstrap_admin_password must contain at least 16 non-whitespace characters"
    }
    ;;
  false)
    [[ ! -e "$secrets_dir/bootstrap_admin_password" && ! -L "$secrets_dir/bootstrap_admin_password" ]] || {
      fatal "bootstrap_admin_password must be absent unless explicitly required"
    }
    ;;
  *) fatal "REQUIRE_BOOTSTRAP_ADMIN_SECRET must be literal true or false" ;;
esac

readonly cloudflare_container_credential_path=/run/secrets/cloudflare_tunnel_credentials
cloudflare_hostname="${APP_URL#https://}"
[[ "$cloudflare_hostname" != *:* ]] || fatal "Cloudflare APP_URL hostname must not include a port"
cloudflare_config="${CLOUDFLARE_CONFIG_FILE:-/etc/learncoding/cloudflare/config.yml}"
validate_cloudflare_config_contract \
  "$cloudflare_config" "$cloudflare_hostname" "$cloudflare_credentials_tunnel_id" \
  "$cloudflare_container_credential_path"
unset cloudflare_credentials_tunnel_id

declare -a render_command=("$resolved_docker_bin" compose --env-file "$compose_env" -f "$repo_root/compose.yaml")
if [[ "$validation_mode" == operations ]]; then
  render_command+=(--profile operations)
fi
render_command+=(config)
rendered_content="$("${render_command[@]}")" || {
  fatal "could not render trusted Compose stack"
}

declare -A rendered_services=()
declare -A rendered_images=()
declare -A rendered_restarts=()
declare -A rendered_stop_periods=()
current_section=
current_service=
current_network=
declare -A rendered_runner_urls=()
declare -A rendered_runner_client_members=()
runner_gateway_upstream_seen=false
runner_gateway_egress_seen=false
runner_gateway_source_seen=false
runner_client_subnet_seen=false
runner_client_internal_seen=false
runner_subnet_seen=false
runner_bridge_seen=false
postgres_fsync_seen=false
postgres_synchronous_commit_seen=false
postgres_full_page_writes_seen=false
cloudflared_secret_source_seen=false
cloudflared_secret_target=

is_known_service() {
  case "$1" in
    postgres|app|mail-worker|reward-worker|regrade-worker|exam-finalization-worker|practice-runner-recovery-worker|project-review-correction-worker|file-erasure-worker|scan-worker|cloudflared|runner-egress-gateway|database-role-bootstrap|database-negative-probes|database-boundary-verifier|migrate|lifecycle|platform-seed|admin-bootstrap|clamav) return 0 ;;
    *) return 1 ;;
  esac
}

is_long_running_service() {
  case "$1" in
    postgres|app|mail-worker|reward-worker|regrade-worker|exam-finalization-worker|practice-runner-recovery-worker|project-review-correction-worker|scan-worker|file-erasure-worker|cloudflared|runner-egress-gateway|clamav) return 0 ;;
    *) return 1 ;;
  esac
}

is_one_shot_service() {
  case "$1" in
    database-role-bootstrap|database-negative-probes|database-boundary-verifier|migrate|lifecycle|platform-seed|admin-bootstrap) return 0 ;;
    *) return 1 ;;
  esac
}

is_runner_client() {
  case "$1" in
    app|regrade-worker|exam-finalization-worker|practice-runner-recovery-worker) return 0 ;;
    *) return 1 ;;
  esac
}

while IFS= read -r line; do
  case "$line" in
    services:)
      current_section=services
      current_service=
      current_network=
      continue
      ;;
    networks:)
      current_section=networks
      current_service=
      current_network=
      continue
      ;;
    volumes:|secrets:|configs:)
      current_section=other
      current_service=
      current_network=
      continue
      ;;
  esac

  if [[ "$current_section" == services && "$line" =~ ^[[:space:]]{2}([a-z0-9-]+):$ ]]; then
    current_service="${BASH_REMATCH[1]}"
    is_known_service "$current_service" || fatal "rendered Compose contains an unexpected service"
    [[ -z "${rendered_services[$current_service]:-}" ]] || fatal "rendered Compose contains a duplicate service"
    rendered_services["$current_service"]=1
    continue
  fi

  if [[ "$current_section" == networks && "$line" =~ ^[[:space:]]{2}([a-z0-9-]+):$ ]]; then
    current_network="${BASH_REMATCH[1]}"
    continue
  fi

  if [[ "$current_section" == services && -n "$current_service" ]]; then
    if [[ "$line" =~ ^[[:space:]]{4}ports:$ ]]; then
      fatal "trusted Compose stack must not publish host ports"
    fi
    if [[ "$line" =~ ^[[:space:]]{4}image:[[:space:]]+([^[:space:]]+)$ ]]; then
      rendered_images["$current_service"]="${BASH_REMATCH[1]}"
      image_is_digest_pinned "${BASH_REMATCH[1]}" || {
        fatal "rendered Compose services must use immutable sha256 image references"
      }
    fi
    if [[ "$line" =~ ^[[:space:]]{4}restart:[[:space:]]+([^[:space:]]+)$ ]]; then
      rendered_restarts["$current_service"]="${BASH_REMATCH[1]}"
    fi
    if [[ "$line" =~ ^[[:space:]]{4}stop_grace_period:[[:space:]]+([^[:space:]]+)$ ]]; then
      rendered_stop_periods["$current_service"]="${BASH_REMATCH[1]}"
    fi
    if [[ "$line" =~ ^[[:space:]]{6}RUNNER_BASE_URL:[[:space:]]+([^[:space:]]+)$ ]]; then
      is_runner_client "$current_service" && [[ "${BASH_REMATCH[1]}" == "http://runner-egress-gateway:4100" ]] || {
        fatal "runner client URL must be exactly http://runner-egress-gateway:4100"
      }
      [[ -z "${rendered_runner_urls[$current_service]:-}" ]] || fatal "rendered runner client URL must be unique per service"
      rendered_runner_urls["$current_service"]=1
    fi
    if [[ "$line" =~ ^[[:space:]]{6}RUNNER_GATEWAY_UPSTREAM:[[:space:]]+([^[:space:]]+)$ ]]; then
      [[ "$current_service" == runner-egress-gateway && "${BASH_REMATCH[1]}" == "http://192.168.122.12:4100" ]] || {
        fatal "runner gateway upstream must be exactly http://192.168.122.12:4100"
      }
      [[ "$runner_gateway_upstream_seen" == false ]] || fatal "runner gateway upstream must be unique"
      runner_gateway_upstream_seen=true
    fi
    if [[ "$line" =~ ^[[:space:]]{6}(-[[:space:]]+runner-client|runner-client:([[:space:]]+null)?)$ ]]; then
      if [[ "$current_service" != runner-egress-gateway ]]; then
        is_runner_client "$current_service" || fatal "rendered runner-client consumers exceed the reviewed allowlist"
      fi
      [[ -z "${rendered_runner_client_members[$current_service]:-}" ]] || fatal "rendered runner-client membership must be unique per service"
      rendered_runner_client_members["$current_service"]=1
    fi
    if [[ "$line" =~ ^[[:space:]]{6}(-[[:space:]]+runner-egress|runner-egress:([[:space:]]+null)?)$ ]]; then
      [[ "$current_service" == runner-egress-gateway ]] || fatal "runner-egress must be attached only to runner-egress-gateway"
      [[ "$runner_gateway_egress_seen" == false ]] || fatal "runner gateway egress membership must be unique"
      runner_gateway_egress_seen=true
    fi
    if [[ "$current_service" == runner-egress-gateway && "$line" =~ ^[[:space:]]{8}ipv4_address:[[:space:]]+([^[:space:]]+)$ ]]; then
      case "${BASH_REMATCH[1]}" in
        172.29.41.2) ;;
        172.29.40.2) runner_gateway_source_seen=true ;;
        *) fatal "runner gateway fixed addresses must be exactly 172.29.41.2 and 172.29.40.2" ;;
      esac
    fi
    if [[ "$current_service" == cloudflared && "$line" == "      - source: cloudflare_tunnel_credentials" ]]; then
      [[ "$cloudflared_secret_source_seen" == false ]] || {
        fatal "rendered cloudflared credentials secret must be unique"
      }
      cloudflared_secret_source_seen=true
      continue
    fi
    if [[ "$current_service" == cloudflared && "$cloudflared_secret_source_seen" == true && \
      -z "$cloudflared_secret_target" && "$line" =~ ^[[:space:]]{8}target:[[:space:]]+([^[:space:]]+)$ ]]; then
      cloudflared_secret_target="/run/secrets/${BASH_REMATCH[1]}"
    fi
    if [[ "$current_service" == postgres ]]; then
      [[ "$line" =~ ^[[:space:]]{6}-[[:space:]]+fsync=on$ ]] && postgres_fsync_seen=true
      [[ "$line" =~ ^[[:space:]]{6}-[[:space:]]+synchronous_commit=on$ ]] && postgres_synchronous_commit_seen=true
      [[ "$line" =~ ^[[:space:]]{6}-[[:space:]]+full_page_writes=on$ ]] && postgres_full_page_writes_seen=true
    fi
  fi

  if [[ "$current_section" == networks && "$current_network" == runner-egress ]]; then
    if [[ "$line" =~ ^[[:space:]]{6}com\.docker\.network\.bridge\.name:[[:space:]]+([^[:space:]]+)$ ]]; then
      [[ "${BASH_REMATCH[1]}" == cdst-run0 ]] || fatal "runner-egress bridge must be exactly cdst-run0"
      runner_bridge_seen=true
    fi
    if [[ "$line" =~ ^[[:space:]]{8}-[[:space:]]+subnet:[[:space:]]+([^[:space:]]+)$ ]]; then
      [[ "${BASH_REMATCH[1]}" == "172.29.40.0/24" ]] || {
        fatal "runner-egress subnet must be exactly 172.29.40.0/24"
      }
      runner_subnet_seen=true
    fi
  fi

  if [[ "$current_section" == networks && "$current_network" == runner-client ]]; then
    if [[ "$line" =~ ^[[:space:]]{4}internal:[[:space:]]+([^[:space:]]+)$ ]]; then
      [[ "${BASH_REMATCH[1]}" == true ]] || fatal "runner-client network must be internal"
      runner_client_internal_seen=true
    fi
    if [[ "$line" =~ ^[[:space:]]{8}-[[:space:]]+subnet:[[:space:]]+([^[:space:]]+)$ ]]; then
      [[ "${BASH_REMATCH[1]}" == "172.29.41.0/24" ]] || fatal "runner-client subnet must be exactly 172.29.41.0/24"
      runner_client_subnet_seen=true
    fi
  fi
done <<<"$rendered_content"

for service in postgres app mail-worker reward-worker regrade-worker exam-finalization-worker \
  practice-runner-recovery-worker project-review-correction-worker file-erasure-worker cloudflared runner-egress-gateway; do
  [[ -n "${rendered_services[$service]:-}" ]] || fatal "rendered Compose pilot service inventory is incomplete"
done

if [[ "$validation_mode" == operations ]]; then
  for service in database-role-bootstrap database-negative-probes database-boundary-verifier \
    migrate lifecycle platform-seed admin-bootstrap; do
    [[ -n "${rendered_services[$service]:-}" ]] || {
      fatal "rendered Compose operations service inventory is incomplete"
    }
  done
fi

for service in "${!rendered_services[@]}"; do
  [[ -n "${rendered_images[$service]:-}" ]] || fatal "rendered Compose service is missing an image"
  if [[ "$service" == cloudflared ]]; then
    [[ "${rendered_restarts[$service]:-}" == on-failure:5 ]] || {
      fatal "rendered cloudflared must use restart on-failure:5"
    }
  elif is_long_running_service "$service"; then
    [[ "${rendered_restarts[$service]:-}" == unless-stopped ]] || {
      fatal "rendered internal long-running services must restart unless-stopped"
    }
  elif is_one_shot_service "$service"; then
    [[ "${rendered_restarts[$service]:-}" == no || "${rendered_restarts[$service]:-}" == '"no"' ]] || {
      fatal "rendered one-shot services must use restart no"
    }
  fi
done

for service in app regrade-worker exam-finalization-worker practice-runner-recovery-worker; do
  [[ -n "${rendered_runner_urls[$service]:-}" ]] || fatal "runner client URL must be exactly http://runner-egress-gateway:4100"
  [[ -n "${rendered_runner_client_members[$service]:-}" ]] || fatal "every runner client must attach to runner-client"
done
[[ -n "${rendered_runner_client_members[runner-egress-gateway]:-}" ]] || fatal "runner gateway must attach to runner-client"
[[ "$runner_gateway_upstream_seen" == true ]] || fatal "runner gateway upstream must be exactly http://192.168.122.12:4100"
[[ "$runner_gateway_egress_seen" == true ]] || fatal "runner gateway must be the sole runner-egress consumer"
[[ "$runner_gateway_source_seen" == true ]] || fatal "runner gateway runner-egress address must be exactly 172.29.40.2"
[[ "$runner_client_subnet_seen" == true ]] || fatal "runner-client subnet must be exactly 172.29.41.0/24"
[[ "$runner_client_internal_seen" == true ]] || fatal "runner-client network must be internal"
[[ "$runner_subnet_seen" == true ]] || fatal "runner-egress subnet must be exactly 172.29.40.0/24"
[[ "$runner_bridge_seen" == true ]] || fatal "runner-egress bridge must be exactly cdst-run0"
[[ "$postgres_fsync_seen" == true && "$postgres_synchronous_commit_seen" == true && "$postgres_full_page_writes_seen" == true ]] || {
  fatal "rendered PostgreSQL command must enforce fsync=on, synchronous_commit=on, and full_page_writes=on"
}
[[ "$cloudflared_secret_source_seen" == true && \
  "$cloudflared_secret_target" == "$cloudflare_container_credential_path" ]] || {
  fatal "rendered cloudflared secret target must match the reviewed credentials-file path"
}

[[ "${rendered_stop_periods[postgres]:-}" == 2m || "${rendered_stop_periods[postgres]:-}" == 2m0s ]] || {
  fatal "rendered PostgreSQL stop budget must be exactly two minutes"
}
for service in app mail-worker reward-worker regrade-worker exam-finalization-worker \
  practice-runner-recovery-worker project-review-correction-worker scan-worker file-erasure-worker; do
  [[ -z "${rendered_services[$service]:-}" || "${rendered_stop_periods[$service]:-}" == 1m || "${rendered_stop_periods[$service]:-}" == 1m0s ]] || {
    fatal "rendered database-mutating service stop budget must be exactly one minute"
  }
done
[[ "${rendered_stop_periods[cloudflared]:-}" == 30s ]] || {
  fatal "rendered cloudflared stop budget must be exactly thirty seconds"
}
[[ "${rendered_stop_periods[runner-egress-gateway]:-}" == 15s ]] || {
  fatal "rendered runner gateway stop budget must be exactly fifteen seconds"
}


if [[ "$post_start" == true ]]; then
  readonly timeout_bin="${resolved_docker_bin%/*}/timeout"
  [[ -x "$timeout_bin" ]] || fatal "timeout is missing beside Docker"
  readonly postgres_probe_sql="SELECT name, setting FROM pg_settings WHERE name IN ('fsync', 'synchronous_commit', 'full_page_writes');"
  postgres_settings="$(
    "$timeout_bin" 30s "$resolved_docker_bin" compose --env-file "$compose_env" \
      -f "$repo_root/compose.yaml" exec -T postgres psql --host=/run/learncoding-postgres \
      --username="${POSTGRES_USER:-learncoding}" --dbname="${POSTGRES_DB:-learncoding}" \
      --no-psqlrc --quiet --no-align --tuples-only '--field-separator=|' \
      --command "$postgres_probe_sql"
  )" || fatal "bounded live PostgreSQL durability probe failed"

  live_fsync=
  live_synchronous_commit=
  live_full_page_writes=
  while IFS='|' read -r setting value extra; do
    [[ -z "$extra" ]] || fatal "live PostgreSQL durability settings must be exactly on/on/on"
    case "$setting" in
      fsync) [[ -z "$live_fsync" ]] || fatal "live PostgreSQL durability settings must be exactly on/on/on"; live_fsync="$value" ;;
      synchronous_commit) [[ -z "$live_synchronous_commit" ]] || fatal "live PostgreSQL durability settings must be exactly on/on/on"; live_synchronous_commit="$value" ;;
      full_page_writes) [[ -z "$live_full_page_writes" ]] || fatal "live PostgreSQL durability settings must be exactly on/on/on"; live_full_page_writes="$value" ;;
      *) fatal "live PostgreSQL durability settings must be exactly on/on/on" ;;
    esac
  done <<<"$postgres_settings"
  [[ "$live_fsync" == on && "$live_synchronous_commit" == on && "$live_full_page_writes" == on ]] || {
    fatal "live PostgreSQL durability settings must be exactly on/on/on"
  }
fi

for directory in \
  "${LEARN_DATA_ROOT:-/srv/learncoding}/postgres" \
  "${LEARN_DATA_ROOT:-/srv/learncoding}/next-cache" \
  "${LEARN_DATA_ROOT:-/srv/learncoding}/app-data"; do
  [[ -d "$directory" ]] || fatal "data directory missing: $directory"
done

echo "runtime validation passed"
