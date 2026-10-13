# Off-site backups: restic to Cloudflare R2

Every night the NUC dumps PostgreSQL and backs up uploaded objects to a [restic](https://restic.readthedocs.io/) repository in a Cloudflare R2 bucket. This is the active backup path. The older age/Google Drive pipeline in [backup-and-restore.md](backup-and-restore.md) stays parked, because there is no local backup drive until about December 2026.

| What | How |
|------|-----|
| Database | `pg_dump --format=custom` in the `postgres` container. It is the same dump command the existing backup uses. The script checks the dump's table of contents before uploading it. |
| Uploads | `/srv/learncoding/app-data/objects`, mounted read-only. `RESTIC_UPLOADS_EXPECTED` (default `true`) is the expected scope: a missing or symlinked directory then fails the backup and alerts. Set it to `false` only for a database-only deployment; the backup still fails if the database references any uploaded object. |
| Recovery point | The snapshot's `/stage` holds `database.dump`, `objects.manifest` (`<sha256> <size> <storage_key>` for every live `stored_object` row in that dump) and `recovery-point.json` (dump start/end time, scope, object count, manifest sha256). Each listed object must exist with the size and sha256 the database recorded, or the backup fails. App writes are not paused; a file deleted between the dump and the scan fails the run. After upload the same metadata plus the snapshot id is written to `/var/lib/learncoding/restic/recovery-point.json`. |
| Encryption | restic encrypts everything client-side with the repository password, so R2 only sees ciphertext. |
| Retention | `forget --prune` keeps 7 daily, 4 weekly and 12 monthly snapshots (`--host codestead --tag codestead`); the counts are `RESTIC_KEEP_*` in `scripts/backup/restic-common.sh`. |
| Integrity | `restic check` runs nightly. The monthly restore test also reads 10% of the pack data. |
| Restore test | Monthly. It restores the whole latest snapshot, checks the manifest against `recovery-point.json`, verifies every listed object's size and sha256, then restores the dump into a throwaway PostgreSQL container (no network, tmpfs data dir, same pinned image) and runs sanity queries. Snapshots made before the manifest existed fail this test until the next nightly backup. |
| Alerting | A failure alerts through `learncoding-alert@` plus the alert hook, journald tag `learncoding-restic`, and the backup-status admin email. A stale state also alerts: no successful backup for more than 36h, or no successful restore test for more than 40 days. |
| Tooling | restic `0.19.1`, run as `restic/restic:0.19.1@sha256:136600b6…` (pinned in `scripts/backup/restic-common.sh`). Nothing is installed on the host. |

Files:
- `scripts/backup/restic-backup.sh`, `restic-freshness.sh`, `restic-restore-test.sh`, `restic.sh` (operator wrapper), and `restic-common.sh`.
- `infra/systemd/learncoding-restic-{backup,freshness,restore-test}.{service,timer}`.
- Tests: `infra/tests/restic-backup.test.sh`.

## 1. Owner: create the R2 bucket and token (one time)

1. In the Cloudflare dashboard, go to **R2 Object Storage → Create bucket**.
   - Name it `codestead-backups` and set the location to Automatic.
   - Leave public access **off**.
2. Go to **R2 → Manage R2 API Tokens → Create API token**.
   - Permissions: **Object Read & Write**.
   - Scope: **Apply to specific buckets only → `codestead-backups`**.
   - TTL: forever, or your rotation policy.
3. Copy these values. The secret is shown only once.
   - **Access Key ID** becomes `AWS_ACCESS_KEY_ID`.
   - **Secret Access Key** becomes `AWS_SECRET_ACCESS_KEY`.
   - The S3 endpoint `https://<ACCOUNT_ID>.r2.cloudflarestorage.com` goes into `RESTIC_REPOSITORY`.
4. Generate the restic repository password. Store it in your password manager **before** using it:
   ```bash
   openssl rand -base64 33
   ```
   **If this password is lost, every backup is unrecoverable.** Cloudflare cannot recover it.
5. Optional hardening: once backups run, add an R2 lifecycle rule that aborts incomplete multipart uploads after 7 days. Do **not** add object-expiry rules. restic's `forget --prune` owns deletion, and expiring pack files behind its back corrupts the repository.

## 2. Install on the NUC

Run these on the NUC shell (`ssh homelab`), after the commit containing these files is deployed to `/opt/learncoding`.

```bash
sudo install -o root -g root -m 0600 /dev/null /etc/learncoding/backup.env.new
sudo test -f /etc/learncoding/backup.env && sudo cp /etc/learncoding/backup.env /etc/learncoding/backup.env.new
sudoedit /etc/learncoding/backup.env.new
```

Add the restic block from `infra/env/backup.env.example` and replace every `REPLACE_` value.

If uploads are not used (no `/srv/learncoding/app-data/objects` directory), set `RESTIC_UPLOADS_EXPECTED=false` in the backup env before the first run. Otherwise the backup fails closed on the missing directory. Check with `sudo test -d /srv/learncoding/app-data/objects && echo uploads-present`.

Keep the file root-owned with mode `0600`; the scripts refuse anything else, a symlink, or a leftover placeholder. Then move it into place:

```bash
sudo install -o root -g root -m 0600 /etc/learncoding/backup.env.new /etc/learncoding/backup.env
sudo rm /etc/learncoding/backup.env.new
```

Install the units (`install-systemd.sh` copies every unit in `infra/systemd/`), initialize the repository once, then run each job by hand before enabling the timers:

```bash
sudo bash /opt/learncoding/infra/ops/install-systemd.sh
sudo bash /opt/learncoding/scripts/backup/restic.sh init
sudo systemctl start learncoding-restic-backup.service
sudo bash /opt/learncoding/scripts/backup/restic.sh snapshots
sudo systemctl start learncoding-restic-restore-test.service
sudo systemctl start learncoding-restic-freshness.service
sudo systemctl enable --now learncoding-restic-backup.timer \
  learncoding-restic-freshness.timer learncoding-restic-restore-test.timer
systemctl list-timers 'learncoding-restic*'
```

The restore test needs a snapshot that contains the object manifest. On the first install, and after upgrading from a version without it, run one new backup (the manual start above, or the next nightly run) before the first restore test. Otherwise the restore test fails with "restored snapshot has no object manifest or recovery point".

Do not run `install-systemd.sh --enable`. It also enables the parked drive and Google Drive timers.

Optional Grafana: if node_exporter's textfile collector is in use, set `RESTIC_METRICS_TEXTFILE_DIR` to its directory. Then alert on:
- `time() - codestead_backup_last_success_timestamp_seconds > 129600` (36h).
- `time() - codestead_backup_last_restore_test_timestamp_seconds > 3456000` (40d).

Without node_exporter, alert on journald lines tagged `learncoding-restic` that contain `event=restic_backup_stale` or `event=restic_backup_failed`.

## 3. Daily operation

- Logs are quiet on success (restic runs with `--quiet`). Read failures only:
  ```bash
  journalctl -u learncoding-restic-backup.service -p warning --since -2d
  ```
- State lives in `/var/lib/learncoding/restic/` as the epoch files `last-backup-success` and `last-restore-test-success`. Never edit them to silence an alert.
- The backup shares `/run/lock/learncoding-backup.lock` with the mail outbox cutover. During a cutover, a nightly run waits for up to 1h instead of dumping mid-transaction.
- Check usage and snapshots:
  ```bash
  sudo bash /opt/learncoding/scripts/backup/restic.sh stats --mode raw-data
  sudo bash /opt/learncoding/scripts/backup/restic.sh snapshots
  ```

## 4. Restore

Never restore over the live database or `/srv/learncoding` in place. Restore to new locations, validate, then make a written cut-over decision. See [incident-response.md](incident-response.md).

**Database, into a new database next to the live one:**

```bash
sudo install -d -m 0700 /var/lib/learncoding/restic/restore
sudo bash /opt/learncoding/scripts/backup/restic.sh snapshots
sudo bash /opt/learncoding/scripts/backup/restic.sh dump --host codestead --tag codestead \
  latest /stage/database.dump | sudo tee /var/lib/learncoding/restic/restore/database.dump >/dev/null
cd /opt/learncoding
sudo docker compose --env-file /etc/learncoding/compose.env -f compose.yaml exec -T postgres \
  sh -ceu 'createdb --host=/run/learncoding-postgres --username="$POSTGRES_USER" learncoding_restore_YYYYMMDD'
sudo docker compose --env-file /etc/learncoding/compose.env -f compose.yaml exec -T postgres \
  sh -ceu 'pg_restore --host=/run/learncoding-postgres --username="$POSTGRES_USER" --dbname=learncoding_restore_YYYYMMDD --no-owner --no-acl --exit-on-error' \
  < /var/lib/learncoding/restic/restore/database.dump
```

Replace `latest` with a snapshot ID to pick an older point. After the restore:
1. Validate with read-only queries.
2. Re-run the role bootstrap and migrations only if the recovery plan calls for it.
3. Switch `database_url` only after a written incident decision.
4. Delete the plaintext dump afterwards: `sudo rm -rf /var/lib/learncoding/restic/restore`.

**Uploads, into an empty directory:**

```bash
sudo install -d -m 0700 /var/lib/learncoding/restic/restore-uploads
sudo RESTIC_RESTORE_TARGET=/var/lib/learncoding/restic/restore-uploads \
  bash /opt/learncoding/scripts/backup/restic.sh restore latest \
  --host codestead --tag codestead --include /uploads --target /restore
```

Files land in `restore-uploads/uploads/` with their original ownership. Copy them back with the app stopped.

**Disaster recovery on a new machine.** You need:
- This repository.
- Docker.
- The four values from your password manager: the R2 key ID, the R2 secret, the endpoint, and the restic password.

Recreate `/etc/learncoding/backup.env`, then run `restic.sh snapshots` and follow the steps above. The application credential master key is **not** in these backups by design (see [backup-and-restore.md](backup-and-restore.md)). Keep it in your password manager too, or stored AI provider keys cannot be decrypted after a rebuild.

## 5. Failure handling

| Symptom | Action |
|---------|--------|
| `pg_dump failed` / `table-of-contents check` | Check postgres health (`docker compose ps postgres`) and disk space. Nothing was uploaded. Rerun the service. |
| `restic backup failed` | Check network egress from the NUC to `*.r2.cloudflarestorage.com` and that the token is still valid. |
| `repository is already locked` | Another run, or a crashed one, holds the lock. List locks with `restic.sh list locks`. Only after confirming no restic container is running (`docker ps --filter ancestor=restic/restic`), run `restic.sh unlock`. |
| `restic check failed` | Stop the timers. Run `restic.sh check --read-data` and **do not prune** until it is understood. |
| `restic_backup_stale` | The timer did not run or kept failing. Check `systemctl list-timers` and the service journal. |
| Restore test failed | Treat it as an incident: the backups may not be restorable. Run the steps in section 4 manually and compare. |

Rotate the R2 token by creating a new token, updating `backup.env`, running `restic.sh snapshots`, and then deleting the old token. Rotate the restic password with `restic.sh key add` followed by `restic.sh key remove <old-id>`. Store the new password first.
