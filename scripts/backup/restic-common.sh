#!/usr/bin/env bash
# shellcheck disable=SC2034 # constants are consumed by the scripts sourcing this file
# Shared helpers for the restic -> Cloudflare R2 off-site backup path.
# Sourced by restic-backup.sh, restic-freshness.sh, restic-restore-test.sh and
# restic.sh. Secret values are read from the root-only backup.env and are only
# ever passed to containers by variable NAME (docker run -e NAME), so they never
# appear on a command line, in the journal, or in this script's output.

# Reviewed pin. The image index digest covers every platform; the amd64 release
# binary checksum is recorded so an operator can cross-check the version.
# restic 0.19.1: restic_0.19.1_linux_amd64.bz2 sha256
# f415415624dcc452f2a02b8c33641791a8c6d6d3b65bbb3543fcf9a25151585c
readonly RESTIC_VERSION=0.19.1
readonly RESTIC_IMAGE="restic/restic:0.19.1@sha256:136600b6ff6843d61d355f7f71f460a166429f35de6fd11b568fece3c9a4d510"

# Snapshots are grouped by this host name and tag, so retention never depends on
# the random hostname of a throwaway container.
readonly RESTIC_SNAPSHOT_HOST=codestead
readonly RESTIC_SNAPSHOT_TAG=codestead
readonly RESTIC_STAGE_PATH=/stage
readonly RESTIC_UPLOADS_PATH=/uploads
# Files written into the staged snapshot directory next to the dump.
readonly RESTIC_DUMP_NAME=database.dump
readonly RESTIC_MANIFEST_NAME=objects.manifest
readonly RESTIC_RECOVERY_POINT_NAME=recovery-point.json

# Retention: the one definition used by restic forget. It must match the
# disclosed 7 daily / 4 weekly / 12 monthly backup window.
readonly RESTIC_KEEP_DAILY=7
readonly RESTIC_KEEP_WEEKLY=4
readonly RESTIC_KEEP_MONTHLY=12

# stored_object.storage_key is "<64-hex owner segment>/<object id>".
readonly RESTIC_STORAGE_KEY_PATTERN='^[0-9a-f]{64}/[0-9A-Za-z-]{1,64}$'

restic_log() {
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2
}

restic_die() {
  restic_log "error: $*"
  exit 1
}

# The config is a root-owned shell file shared with scripts/backup/common.sh.
# Refuse it unless it is a regular, non-symlink file owned by the caller with
# mode 0600, because it holds the R2 key and the restic repository password.
restic_load_config() {
  local config_file="${BACKUP_CONFIG_FILE:-/etc/learncoding/backup.env}"
  [[ -f "$config_file" && ! -L "$config_file" ]] \
    || restic_die "backup config is missing or not a regular file"
  [[ "$(stat -c '%u %a' -- "$config_file")" == "$(id -u) 600" ]] \
    || restic_die "backup config must be owned by the service user with mode 0600"
  # shellcheck disable=SC1090
  source "$config_file"

  : "${REPO_ROOT:=/opt/learncoding}"
  : "${COMPOSE_ENV_FILE:=/etc/learncoding/compose.env}"
  : "${LEARN_DATA_ROOT:=/srv/learncoding}"
  : "${BACKUP_LOCK_FILE:=/run/lock/learncoding-backup.lock}"
  : "${ALERT_HOOK:=/etc/learncoding/alert-hook}"
  : "${RESTIC_STATE_DIR:=/var/lib/learncoding/restic}"
  : "${RESTIC_CACHE_DIR:=/var/cache/learncoding-restic}"
  # Not /var/tmp: the units use PrivateTmp, so dockerd could not see a staging
  # directory there when bind-mounting it into the restic container.
  : "${RESTIC_STAGE_ROOT:=$RESTIC_STATE_DIR}"
  : "${RESTIC_MAX_BACKUP_AGE_HOURS:=36}"
  : "${RESTIC_MAX_RESTORE_TEST_AGE_DAYS:=40}"
  : "${RESTIC_METRICS_TEXTFILE_DIR:=}"
  : "${AWS_DEFAULT_REGION:=auto}"
  # Whether the backup must include uploaded objects. Fail closed: a missing or
  # symlinked uploads directory is an error unless this is explicitly false.
  : "${RESTIC_UPLOADS_EXPECTED:=true}"
  [[ "$RESTIC_UPLOADS_EXPECTED" == true || "$RESTIC_UPLOADS_EXPECTED" == false ]] \
    || restic_die "RESTIC_UPLOADS_EXPECTED must be literal true or false"

  [[ "${RESTIC_REPOSITORY:-}" =~ ^s3:https://[A-Za-z0-9.-]+/[A-Za-z0-9._/-]+$ ]] \
    || restic_die "RESTIC_REPOSITORY must be an s3:https://<endpoint>/<bucket>/<path> URL"
  local password="${RESTIC_PASSWORD:-}"
  ((${#password} >= 24)) \
    || restic_die "RESTIC_PASSWORD must be set and at least 24 characters"
  [[ -n "${AWS_ACCESS_KEY_ID:-}" && -n "${AWS_SECRET_ACCESS_KEY:-}" ]] \
    || restic_die "AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY must be set"
  if [[ "$RESTIC_PASSWORD$AWS_ACCESS_KEY_ID$AWS_SECRET_ACCESS_KEY" == *REPLACE_* ]]; then
    restic_die "backup config still contains example placeholders"
  fi
  [[ "$RESTIC_MAX_BACKUP_AGE_HOURS" =~ ^[1-9][0-9]{0,3}$ \
    && "$RESTIC_MAX_RESTORE_TEST_AGE_DAYS" =~ ^[1-9][0-9]{0,2}$ ]] \
    || restic_die "restic freshness limits must be positive integers"
  export RESTIC_REPOSITORY RESTIC_PASSWORD AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_DEFAULT_REGION
}

restic_prepare_dirs() {
  install -d -m 0700 -- "$RESTIC_STATE_DIR" "$RESTIC_CACHE_DIR"
}

# Run restic in the pinned container. Extra docker arguments come before "--";
# restic arguments after it.
restic_run() {
  local docker_args=()
  while (($#)) && [[ "$1" != -- ]]; do
    docker_args+=("$1")
    shift
  done
  [[ "${1:-}" == -- ]] && shift
  docker run --rm -i \
    --hostname "$RESTIC_SNAPSHOT_HOST" \
    --cap-drop ALL --cap-add DAC_READ_SEARCH \
    --security-opt no-new-privileges \
    --read-only --tmpfs /tmp \
    -e RESTIC_REPOSITORY -e RESTIC_PASSWORD \
    -e AWS_ACCESS_KEY_ID -e AWS_SECRET_ACCESS_KEY -e AWS_DEFAULT_REGION \
    -e RESTIC_CACHE_DIR=/cache \
    -v "$RESTIC_CACHE_DIR:/cache" \
    "${docker_args[@]}" \
    "$RESTIC_IMAGE" "$@"
}

restic_compose() {
  docker compose --env-file "$COMPOSE_ENV_FILE" -f "$REPO_ROOT/compose.yaml" "$@"
}

# Print "<storage_key> <size_bytes> <sha256>" for every live stored_object row
# in a custom-format dump read on stdin. Reading the dump itself (not the live
# database) ties the object list to the exact pg_dump snapshot.
restic_referenced_objects() {
  restic_compose exec -T postgres pg_restore --data-only --table=stored_object --file=- \
    | awk -F'\t' '
      /^COPY [^ ]*stored_object \(/ {
        header = $0
        sub(/^[^(]*\(/, "", header)
        sub(/\) FROM stdin;$/, "", header)
        count = split(header, columns, /, /)
        for (i = 1; i <= count; i++) index_of[columns[i]] = i
        if (!("storage_key" in index_of) || !("size_bytes" in index_of) ||
            !("sha256" in index_of) || !("deleted_at" in index_of)) exit 3
        copying = 1
        next
      }
      copying && $0 == "\\." { copying = 0; done = 1; next }
      copying && $(index_of["deleted_at"]) == "\\N" {
        print $(index_of["storage_key"]), $(index_of["size_bytes"]), $(index_of["sha256"])
      }
      END { if (copying) exit 4 }
    '
}

# Verify one object file against its expected size and sha256. Returns 1 when
# the file is missing, not a regular file, or reached through a symlink, and 2
# when its bytes differ.
restic_verify_object() {
  local root="$1" key="$2" size="$3" sha="$4" file actual_size actual_sha
  file="$root/$key"
  [[ -f "$file" && ! -L "$file" && ! -L "$root/${key%%/*}" ]] || return 1
  actual_size="$(stat -c %s -- "$file")"
  actual_sha="$(sha256sum -- "$file" | cut -d' ' -f1)"
  [[ "$actual_size" == "$size" && "$actual_sha" == "$sha" ]] || return 2
}

# Record a UTC epoch second atomically.
restic_mark() {
  local name="$1" tmp
  tmp="$(mktemp -- "$RESTIC_STATE_DIR/.$name.XXXXXX")"
  date -u +%s >"$tmp"
  mv -f -- "$tmp" "$RESTIC_STATE_DIR/$name"
}

restic_read_mark() {
  local file="$RESTIC_STATE_DIR/$1" value
  [[ -f "$file" && ! -L "$file" ]] || return 1
  value="$(<"$file")"
  [[ "$value" =~ ^[0-9]{9,11}$ ]] || return 1
  printf '%s\n' "$value"
}

restic_alert() {
  local severity="$1" event="$2" message="$3"
  logger -p daemon.err -t learncoding-restic -- "severity=$severity event=$event $message" 2>/dev/null || true
  restic_log "alert severity=$severity event=$event $message"
  if [[ -x "$ALERT_HOOK" ]]; then
    "$ALERT_HOOK" "$severity" "$event" "$message" || restic_log "alert hook failed"
  fi
}

# Queue the generic administrator email through the existing least-privilege
# backup-status reporter. Delivery problems are logged and never change the
# caller's exit status.
restic_report_status() {
  local outcome="$1" run_key="$2" result
  if ! result="$(timeout 90 docker compose --env-file "$COMPOSE_ENV_FILE" \
    -f "$REPO_ROOT/compose.yaml" --profile operations run --rm --no-deps -T \
    --pull never \
    --env "BACKUP_REPORT_OUTCOME=$outcome" \
    --env "BACKUP_REPORT_RUN_KEY=$run_key" \
    backup-status-reporter 2>/dev/null)"; then
    restic_log "backup status report could not reach the application outbox"
    return 0
  fi
  result="${result//$'\r'/}"
  case "$result" in
    queued|existing) restic_log "backup status report $result" ;;
    *) restic_log "backup status report returned an invalid acknowledgement" ;;
  esac
}

# Optional node_exporter textfile metrics for Grafana. Written atomically.
restic_write_metrics() {
  [[ -n "$RESTIC_METRICS_TEXTFILE_DIR" && -d "$RESTIC_METRICS_TEXTFILE_DIR" ]] || return 0
  local backup restore tmp
  backup="$(restic_read_mark last-backup-success || echo 0)"
  restore="$(restic_read_mark last-restore-test-success || echo 0)"
  tmp="$(mktemp -- "$RESTIC_METRICS_TEXTFILE_DIR/.codestead_backup.XXXXXX")"
  {
    echo '# HELP codestead_backup_last_success_timestamp_seconds Last successful restic backup to R2.'
    echo '# TYPE codestead_backup_last_success_timestamp_seconds gauge'
    echo "codestead_backup_last_success_timestamp_seconds $backup"
    echo '# HELP codestead_backup_last_restore_test_timestamp_seconds Last successful restic restore test.'
    echo '# TYPE codestead_backup_last_restore_test_timestamp_seconds gauge'
    echo "codestead_backup_last_restore_test_timestamp_seconds $restore"
  } >"$tmp"
  chmod 0644 -- "$tmp"
  mv -f -- "$tmp" "$RESTIC_METRICS_TEXTFILE_DIR/codestead_backup.prom"
}
