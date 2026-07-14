#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"
load_backup_config
require_command docker
require_command sha256sum

: "${BACKUP_ROOT:?BACKUP_ROOT is required}"
root="$(validated_root "$BACKUP_ROOT" "$FULL_BACKUP_MAGIC")"
latest="$(find "$root/full" -maxdepth 1 -type f -name 'learncoding-full-*.tar.gz.age' -printf '%f\n' | sort -r | head -n 1)"
[[ -n "$latest" ]] || die "there is no backup to drill"

work_parent="${RESTORE_DRILL_WORK_ROOT:-/var/tmp}"
install -d -m 0700 "$work_parent"
work="$(mktemp -d "$work_parent/learncoding-restore-drill.XXXXXX")"
touch "$work/.learncoding-restore-drill"
database="learncoding_restore_drill_$(date -u +%Y%m%dT%H%M%SZ)"
cleanup() {
  local rc=$?
  trap - EXIT
  compose_cmd exec -T postgres sh -ceu 'dropdb --username="$POSTGRES_USER" --if-exists "$1"' _ "$database" >/dev/null 2>&1 || true
  resolved="$(realpath -e -- "$work" 2>/dev/null || true)"
  if [[ -n "$resolved" && "$resolved" == "$work_parent"/learncoding-restore-drill.* && -f "$resolved/.learncoding-restore-drill" ]]; then
    rm -rf --one-file-system -- "$resolved"
  fi
  exit "$rc"
}
trap cleanup EXIT

"$SCRIPT_DIR/restore.sh" "$root/full/$latest" --destination "$work/extracted" --restore-db "$database"
table_count="$(compose_cmd exec -T postgres sh -ceu \
  'psql --username="$POSTGRES_USER" --dbname="$1" -tAc "SELECT count(*) FROM information_schema.tables WHERE table_schema = '\''public'\''"' _ "$database" \
  | tr -dc '0-9')"
[[ "$table_count" =~ ^[0-9]+$ ]] && (( table_count > 0 )) || die "restore drill found no public tables"

report="$root/restore-reports/restore-drill-$(date -u +%Y%m%dT%H%M%SZ).txt"
cat >"$report" <<EOF
result=pass
archive=$latest
checked_utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)
public_table_count=$table_count
live_database_modified=false
EOF
(cd "$(dirname -- "$report")" && sha256sum "$(basename -- "$report")") >"${report}.sha256"
chmod 0600 "$report" "${report}.sha256"
emit_alert info restore_drill_complete "isolated restore drill completed successfully"
log "restore drill passed; report: $report"
