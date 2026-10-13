#!/usr/bin/env bash
# Monthly restore test: read a sample of pack data, restore the latest snapshot
# out of the R2 restic repository, verify every uploaded object against the
# snapshot's manifest, restore the database dump into a throwaway PostgreSQL
# container (no network, tmpfs data dir, same pinned image as production), run
# sanity queries, then remove everything. Never touches the live database.
set -Eeuo pipefail
umask 077

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/backup/restic-common.sh
source "$script_dir/restic-common.sh"

restic_load_config
restic_prepare_dirs

postgres_image="$(sed -n 's/^POSTGRES_IMAGE=//p' "$COMPOSE_ENV_FILE" | tail -n 1)"
[[ "$postgres_image" =~ ^[a-z0-9./_-]+(:[A-Za-z0-9._-]+)?@sha256:[0-9a-f]{64}$ ]] \
  || restic_die "POSTGRES_IMAGE in compose.env must be digest-pinned"

work=""
container="learncoding-restore-test-$(date -u +%Y%m%d%H%M%S)-$$"
finished=0

on_exit() {
  local status=$?
  docker rm -f "$container" >/dev/null 2>&1 || true
  [[ -n "$work" ]] && rm -rf -- "$work"
  if ((status != 0 || !finished)); then
    restic_alert critical restic_restore_test_failed "restore test failed; inspect journalctl -u learncoding-restic-restore-test.service"
  fi
  exit "$status"
}
trap on_exit EXIT

work="$(mktemp -d -- "$RESTIC_STAGE_ROOT/learncoding-restic-restore.XXXXXX")"
chmod 0700 -- "$work"

restic_log "restic restore-test phase=check-data"
restic_run -- check --quiet --read-data-subset=10% \
  || restic_die "restic data check failed"

restic_log "restic restore-test phase=restore"
restored="$work/restored"
install -d -m 0700 -- "$restored"
# Restore the whole latest snapshot (dump, manifest, recovery point, objects).
# CHOWN/FOWNER let restic restore the original object ownership.
restic_run --cap-add CHOWN --cap-add FOWNER -v "$restored:/restore" -- \
  restore --host "$RESTIC_SNAPSHOT_HOST" --tag "$RESTIC_SNAPSHOT_TAG" --target /restore latest \
  || restic_die "could not restore the latest snapshot from the repository"
restored_stage="$restored${RESTIC_STAGE_PATH}"
restored_uploads="$restored${RESTIC_UPLOADS_PATH}"
dump="$restored_stage/$RESTIC_DUMP_NAME"
manifest="$restored_stage/$RESTIC_MANIFEST_NAME"
[[ -s "$dump" ]] || restic_die "restored database dump is empty"
[[ -f "$manifest" && -f "$restored_stage/$RESTIC_RECOVERY_POINT_NAME" ]] \
  || restic_die "restored snapshot has no object manifest or recovery point"
expected_sha="$(sed -n 's/^  "manifest_sha256": "\([0-9a-f]\{64\}\)".*/\1/p' "$restored_stage/$RESTIC_RECOVERY_POINT_NAME")"
[[ "$(sha256sum -- "$manifest" | cut -d' ' -f1)" == "$expected_sha" ]] \
  || restic_die "restored manifest does not match its recovery point"

restic_log "restic restore-test phase=objects"
objects=0
while read -r sha size key; do
  [[ "$key" =~ $RESTIC_STORAGE_KEY_PATTERN && "$size" =~ ^[0-9]+$ && "$sha" =~ ^[0-9a-f]{64}$ ]] \
    || restic_die "restored manifest has a malformed line"
  restic_verify_object "$restored_uploads" "$key" "$size" "$sha" \
    || restic_die "restored object does not match the manifest: $key"
  objects=$((objects + 1))
done <"$manifest"

restic_log "restic restore-test phase=postgres"
docker run -d --name "$container" --network none \
  --tmpfs /var/lib/postgresql/data:rw,size=4g \
  -e POSTGRES_HOST_AUTH_METHOD=trust \
  "$postgres_image" >/dev/null \
  || restic_die "could not start the throwaway PostgreSQL container"

ready=0
for _ in $(seq 1 60); do
  if docker exec "$container" pg_isready --username=postgres --quiet >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 2
done
((ready)) || restic_die "throwaway PostgreSQL did not become ready"

docker exec "$container" createdb --username=postgres restore_test \
  || restic_die "could not create the restore database"
docker exec -i "$container" pg_restore --username=postgres --dbname=restore_test \
  --no-owner --no-acl --exit-on-error <"$dump" \
  || restic_die "pg_restore failed"

query() {
  docker exec "$container" psql --username=postgres --dbname=restore_test \
    --no-psqlrc --tuples-only --no-align --set=ON_ERROR_STOP=1 --command="$1"
}
migrations="$(query 'SELECT count(*) FROM drizzle.__drizzle_migrations')" \
  || restic_die "restored database has no migration ledger"
tables="$(query "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public'")" \
  || restic_die "restored database table query failed"
[[ "$migrations" =~ ^[0-9]+$ && "$tables" =~ ^[0-9]+$ ]] && ((migrations > 0 && tables > 0)) \
  || restic_die "restored database failed its sanity check"

restic_mark last-restore-test-success
restic_write_metrics
finished=1
restic_log "restic restore-test complete migrations=$migrations public_tables=$tables objects=$objects"
