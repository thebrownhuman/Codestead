# Backup and restore runbook

The design uses PostgreSQL custom-format dumps plus curriculum, non-secret deployment configuration, and application data. A stream is encrypted with `age`, then the ciphertext receives a SHA-256 checksum. Plaintext staging is mode 0700 and removed after each run. The backup drive and Google Drive receive encrypted archives only. Capacity monitoring warns at 70% utilization and becomes critical at 85%, leaving recovery headroom before the filesystem is exhausted.

Secret files, Cloudflare credentials, OAuth tokens, rclone configuration, the `age` private identity, and email/mailbox export formats are excluded. The database dump can contain application-encrypted credential ciphertext; the application master key is deliberately separate and never backed up here.

`age` documents recipients files and offline identities in its [official repository](https://github.com/FiloSottile/age). PostgreSQL documents custom dumps and safe restore behavior in [pg_dump](https://www.postgresql.org/docs/current/app-pgdump.html) and [pg_restore](https://www.postgresql.org/docs/current/app-pgrestore.html).

## One-time key ceremony

On an offline administrator machine, install `age`, disconnect networking, and generate an identity:

```bash
umask 077
age-keygen -o learncoding-age-identity.txt
age-keygen -y learncoding-age-identity.txt > learncoding-age-recipient.txt
```

Store two offline copies of the identity separately. Print or copy its recipient fingerprint into the operations record. Transfer only `learncoding-age-recipient.txt` to `/etc/learncoding/backup-age-recipient.txt` on the NUC. Anyone with the public recipient can encrypt; only the offline identity can decrypt. Loss of every identity copy makes backups unrecoverable.

## Initialize the dedicated local target

Mount the 2 TB filesystem at `/mnt/learncoding-backups` by stable UUID in `/etc/fstab`, verify it with `findmnt`, then initialize it. The script refuses the OS filesystem and targets smaller than 1.5 TB by default.

```bash
findmnt /mnt/learncoding-backups
sudo bash /opt/learncoding/scripts/backup/init-backup-target.sh --full /mnt/learncoding-backups
sudo systemctl enable --now learncoding-backup.timer learncoding-backup-check.timer
sudo systemctl list-timers 'learncoding-backup*'
```

The nightly timer runs around 02:15 with randomized delay. Retention keeps the newest restore point in each of seven UTC days, four ISO weeks, and twelve UTC months. Never edit the root marker or point the script at an arbitrary directory to force deletion.

## First backup

```bash
sudo systemctl start learncoding-backup.service
sudo systemctl status learncoding-backup.service
sudo systemctl start learncoding-backup-check.service
sudo journalctl -u learncoding-backup.service --since '30 minutes ago'
```

Confirm one `.tar.gz.age` and matching `.sha256` exist. Do not decrypt it on the production filesystem merely to inspect it; use the restore drill.

Every nightly run also attempts to enqueue one idempotent `backup-status` email for the single active administrator. The message contains only a generic success or failure summary and never includes an archive name, filesystem path, checksum, log, database value, or encryption material. The ordinary mail worker delivers the outbox row. Check queue status and template name only:

```bash
sudo docker compose --env-file /etc/learncoding/compose.env \
  -f /opt/learncoding/compose.yaml exec -T postgres \
  sh -ceu 'exec psql --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" \
  --command="select template,status,attempt_count,created_at from email_outbox where template='"'"'backup-status'"'"' order by created_at desc limit 5"'
```

If PostgreSQL or Docker is the cause of a backup failure, the script cannot safely enqueue an email into that unavailable database. The systemd journal and root-owned alert hook remain the independent fallback, and the backup keeps its original failure exit code. A missing or inactive administrator also emits a warning instead of redirecting the report to another address.

## Optional weekly Google Drive copy

Create a least-privilege rclone remote and root-owned `/etc/learncoding/rclone.conf`; follow rclone's maintained [Google Drive backend documentation](https://rclone.org/drive/). Set a dedicated path such as `gdrive:Codestead/backups/full`, then enable `ENABLE_RCLONE_OFFSITE=1` in `backup.env`. The Sunday backup runs `rclone sync` with checksums and a deletion cap. Google Drive never receives plaintext or the private identity.

Test with a forced copy and read-only listing:

```bash
sudo FORCE_OFFSITE_SYNC=1 bash /opt/learncoding/scripts/backup/offsite-sync.sh
sudo rclone lsf gdrive:Codestead/backups/full --config /etc/learncoding/rclone.conf
```

Set `CHECK_OFFSITE=1` only after the remote is stable. A local backup remains primary; a sync service is not a substitute for restore testing.

## Optional 32 GB emergency drive

Initialize a separate removable filesystem and keep it disconnected except during a supervised snapshot:

```bash
sudo bash /opt/learncoding/scripts/backup/init-backup-target.sh --emergency /media/learncoding-emergency
sudo EMERGENCY_BACKUP_ROOT=/media/learncoding-emergency \
  bash /opt/learncoding/scripts/backup/emergency-backup.sh
```

It retains three encrypted snapshots containing only the database and non-secret recovery configuration. It omits curriculum media and app data so a 32 GB device remains practical. It still requires the offline identity to restore.

## Safe staged restore

Never restore into the live database or `/srv/learncoding`. Attach one offline identity read-only, choose a brand-new empty staging directory, and use a database name beginning `learncoding_restore_`:

```bash
sudo AGE_IDENTITY_FILE=/media/offline-key/learncoding-age-identity.txt \
  bash /opt/learncoding/scripts/backup/restore.sh \
  /mnt/learncoding-backups/full/learncoding-full-YYYYMMDDTHHMMSSZ.tar.gz.age \
  --destination /srv/learncoding-restore/incident-YYYYMMDD \
  --restore-db learncoding_restore_incident_YYYYMMDD
```

The script verifies the external checksum, rejects path traversal and link entries, authenticates/decrypts with `age`, verifies internal checksums, and refuses existing/nonempty destinations or databases. It does not unpack the nested repository/app-data tarballs and does not switch application traffic.

Validate the restored database using read-only queries and a temporarily configured test app. Compare learner/account/progress row counts at aggregate level, run migrations only if the recovery plan calls for them, and complete the smoke path. Switching production requires a written incident decision, a new `database_url` secret pointing to the validated restore database, maintenance downtime, and a restart. Keep the original database untouched until closure.

## Quarterly restore drill

Attach the offline identity and run the manual unit:

```bash
sudo systemctl start learncoding-restore-drill.service
sudo systemctl status learncoding-restore-drill.service
sudo ls -l /mnt/learncoding-backups/restore-reports/
```

The drill restores the latest dump into a temporary `learncoding_restore_drill_*` database, checks that public tables exist, writes a data-free signed-by-checksum report, drops the temporary database, and removes staging. Remove `AGE_IDENTITY_FILE` from runtime configuration and detach the identity afterward. Investigate every failed drill before trusting newer backups.

## Failure handling

- A failed nightly job leaves no final archive name until encryption completes; inspect the unit log and free space, then rerun.
- A checksum failure is a critical incident. Preserve the file, stop offsite sync/pruning, and test the next older archive.
- A stale backup usually means timer, mount, PostgreSQL health, or capacity failure.
- If the target mount disappears, the marker check prevents writing into an ordinary directory on the OS disk.
- Never use `docker compose down -v`, delete PostgreSQL files, edit a dump, or bypass checksum/identity checks during recovery.
