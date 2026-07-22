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

Use an already prepared 2 TB `ext4` filesystem. The following procedure does **not** format a disk. Identify the dedicated backup filesystem by UUID, never by a changeable name such as `/dev/sdb`, and verify that the existing `/etc/fstab` has no entry for the target before appending anything:

```bash
set -Eeuo pipefail
sudo lsblk --fs --output NAME,SIZE,FSTYPE,UUID,MOUNTPOINTS
backup_uuid='REPLACE_WITH_THE_2TB_EXT4_UUID'
[[ "$backup_uuid" =~ ^[0-9A-Fa-f-]{8,}$ ]]
backup_device="/dev/disk/by-uuid/$backup_uuid"
sudo test -b "$backup_device"
[[ "$(lsblk -dnro FSTYPE "$backup_device")" == ext4 ]]
if sudo grep -nE '[[:space:]]/mnt/learncoding-backups[[:space:]]' /etc/fstab; then
  echo 'An /mnt/learncoding-backups entry already exists; stop and reconcile it.' >&2
  exit 1
fi
sudo install -d -o root -g root -m 0755 /mnt/learncoding-backups
sudo install -o root -g root -m 0600 /etc/fstab /etc/fstab.codestead-before-backup-disk
printf 'UUID=%s /mnt/learncoding-backups ext4 rw,nodev,nosuid,noexec,nofail,x-systemd.automount,x-systemd.device-timeout=10s 0 2\n' "$backup_uuid" \
  | sudo tee -a /etc/fstab >/dev/null
if ! sudo findmnt --verify --verbose; then
  sudo install -o root -g root -m 0644 \
    /etc/fstab.codestead-before-backup-disk /etc/fstab
  sudo systemctl daemon-reload
  exit 1
fi
sudo systemctl daemon-reload
sudo systemctl start "$(systemd-escape --path --suffix=automount /mnt/learncoding-backups)"
sudo stat /mnt/learncoding-backups >/dev/null
findmnt --target /mnt/learncoding-backups --output SOURCE,FSTYPE,OPTIONS
```

The duplicate-entry guard exits before modifying `/etc/fstab` if the mount target already exists. When no entry exists, the same paste-ready block retains a root-only rollback copy and appends exactly one UUID-based entry.

The guarded block restores `/etc/fstab.codestead-before-backup-disk`, reloads systemd, and exits before activating the mount if `findmnt --verify` fails. If that rollback command itself fails, stop and repair `/etc/fstab` from the root-only copy before rebooting. `nofail` keeps an absent removable disk from blocking boot, `x-systemd.automount` mounts it only when a backup unit needs it, and the ten-second device timeout bounds a missing-device wait. The backup units' `RequiresMountsFor=` contract then fails and alerts rather than silently writing backup data to the OS disk.

Only after the mount resolves to the dedicated physical disk should you initialize it and enable the timers:

```bash
findmnt /mnt/learncoding-backups
sudo bash /opt/learncoding/scripts/backup/init-backup-target.sh --full /mnt/learncoding-backups
sudo systemctl enable --now learncoding-backup.timer learncoding-backup-check.timer \
  learncoding-offsite-sync.timer learncoding-offsite-retention.timer learncoding-retention.timer
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

## Verified daily Google Drive recovery points

Create a dedicated least-privilege rclone remote and root-owned, non-symlink `/etc/learncoding/rclone.conf` with mode `0600`; follow rclone's maintained [Google Drive backend documentation](https://rclone.org/drive/). Set `RCLONE_REMOTE=gdrive:Codestead/backups` in `backup.env`. That is the recovery-point root, not its `full` child. Google Drive receives encrypted archives, checksum sidecars, immutable point attestations, and one verified `state/LAST_SUCCESS` pointer. It never receives plaintext, the rclone configuration, or either private identity.

`learncoding-offsite-sync.timer` runs daily at 04:15 UTC after the local backup window. Publication copies exactly the archive named by the local success marker, reads the bytes back, publishes its immutable attestation, and only then replaces the pointer. It never uses `sync`, purge, or broad deletion. `learncoding-offsite-retention.timer` runs at 05:15 UTC. It validates every committed triplet before moving only exact obsolete objects to Google Drive trash under the deterministic seven-daily, four-weekly, twelve-monthly union. A root-owned transaction journal makes an interrupted exact deletion reconcilable.

Test the complete path in order:

```bash
sudo systemctl start learncoding-offsite-sync.service
sudo systemctl start learncoding-offsite-retention.service
sudo systemctl status learncoding-offsite-sync.service learncoding-offsite-retention.service
sudo rclone lsf gdrive:Codestead/backups --recursive --files-only \
  --config /etc/learncoding/rclone.conf
sudo sed -n '1,15p' /mnt/learncoding-backups/state/offsite-retention-last-report.txt
```

The sanitized retention report must have `result=pass`, `pending_journal=false`, and safe root-only metadata. Never edit it, the pointer, an attestation, or a transaction journal. Never run an ad-hoc rclone delete, purge, cleanup, or sync against this path. Stop both offsite units and investigate if the pointer changes during retention, a triplet is partial, the listing contains an unexpected object, or a transaction cannot reconcile.

## Optional 32 GB emergency drive

Initialize a separate removable filesystem and keep it disconnected except during a supervised snapshot:

```bash
sudo bash /opt/learncoding/scripts/backup/init-backup-target.sh --emergency /media/learncoding-emergency
sudo EMERGENCY_BACKUP_ROOT=/media/learncoding-emergency \
  bash /opt/learncoding/scripts/backup/emergency-backup.sh
```

It retains three encrypted snapshots containing only the database and non-secret recovery configuration. It omits curriculum media and app data so a 32 GB device remains practical. It still requires the offline identity to restore.

## Separate credential and identity recovery kit

A normal backup deliberately omits the credential master key and backup private identity. Generate a second `age` identity offline for the recovery kit, keep its private half off the NUC, and install only its public recipient at `/etc/learncoding/recovery-kit-recipient.txt` with root ownership and mode `0600`. The two recipients must be distinct.

Prepare root-owned mode-`0600` metadata with exactly these non-secret fields: `CLOUDFLARE_ACCOUNT`, `CLOUDFLARE_TUNNEL`, `CLOUDFLARE_HOSTNAME`, `CLOUDFLARE_RECOVERY_PROCEDURE`, `GMAIL_OAUTH_PROJECT`, `GMAIL_ACCOUNT`, `GMAIL_REAUTHORIZATION_PROCEDURE`, `GIT_COMMIT`, `IMAGE_IDS`, and `IDENTITY_STORAGE_LOCATION`. Procedures identify how to reissue credentials; never paste a credential, token, private key, or provider API key into this file.

During a supervised ceremony, attach both offline identities read-only, point `AGE_IDENTITY_FILE` and `RECOVERY_KIT_VERIFY_IDENTITY_FILE` at their mode-`0600` files, then create one byte-identical encrypted kit on every initialized destination:

```bash
sudo bash /opt/learncoding/scripts/backup/create-recovery-kit.sh \
  /mnt/learncoding-backups /media/learncoding-emergency
sudo find /mnt/learncoding-backups/recovery-kits -maxdepth 1 -type f -printf '%f\n'
```

Creation validates and packages the application credential master key, backup private identity, recovery instructions, manifest, and internal checksums; encrypts them once to the distinct recovery-kit recipient; verifies the result when the verification identity is attached; then atomically copies the same ciphertext and sidecar to each destination. Plaintext staging is removed on success and failure. Detach both private identities and remove their temporary paths from `backup.env` immediately afterward. Repeat the ceremony after rotating the credential master key, backup identity, recovery-kit identity, or material recovery metadata.

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

`learncoding-restore-drill-reminder.timer` runs a read-only freshness check every day and alerts when the latest checksum-bound passing report is more than 2,160 hours (90 days) old. It never attaches identities or starts a restore. The real drill remains supervised and manual.

The drill is manual and isolated. It never targets the live Compose database, publishes no host port, uses an internal-only temporary PostgreSQL network and volume, and removes both after the smoke test. Before starting, attach the backup and recovery-kit private identities read-only, select the immutable operations image digest from the reviewed release, and create a root-owned mode-`0600` incident record. The incident time models when recoverable data became unavailable; the recorded time is when the operator wrote the record.

```bash
incident="$(date -u +%Y%m%dT%H%M%SZ)"
sudo install -o root -g root -m 0600 /dev/null /etc/learncoding/restore-incident.env
sudo /usr/bin/bash -ceu 'printf "INCIDENT_UTC=%s\nRECORDED_UTC=%s\n" \
  "$1" "$(date -u +%Y%m%dT%H%M%SZ)" > /etc/learncoding/restore-incident.env' -- "$incident"
# Set AGE_IDENTITY_FILE, RECOVERY_KIT_IDENTITY_FILE, RESTORE_INCIDENT_RECORD,
# and an immutable RESTORE_OPERATIONS_IMAGE=name@sha256:<64 hex> in backup.env.
sudo systemctl start learncoding-restore-drill.service
sudo systemctl status learncoding-restore-drill.service
sudo ls -l /mnt/learncoding-backups/restore-reports/
```

A failed or overdue reminder is a release and operations blocker; complete the supervised drill and confirm `systemctl status learncoding-restore-drill-reminder.service` returns success.

The drill fetches the exact attested offsite point, verifies and decrypts both the backup and the separately encrypted recovery kit, validates archive path safety, restores PostgreSQL in the isolated stack, verifies required schema and application objects, and proves an application-encrypted credential probe can be recovered with the restored master key. It measures the 24-hour RPO from the recorded incident chronology and the four-hour RTO with a monotonic clock. Only after the temporary Compose project, volume, and work directory are gone does it publish a root-only, data-free passing report and checksum. A failure report has no passing checksum. Remove all temporary identity and incident paths from configuration and detach private media afterward.

Immediately after a fresh retention transaction and passing drill, create the sanitized cross-check:

```bash
sudo bash /opt/learncoding/scripts/backup/verify-recovery-evidence.sh \
  --output /mnt/learncoding-backups/state/recovery-evidence-verification.txt
sudo cat /mnt/learncoding-backups/state/recovery-evidence-verification.txt
```

The verifier is read-only. It independently checks remote listing digests, the pointer/attestation byte match, every active committed triplet, exact preserved debris, deterministic retention buckets, exact trashed triplets, and the latest checksum-bound restore report. It re-reads the remote listing and pointer before committing a short sanitized result. The retention report must be no more than six hours old. Any inventory change, stale report, malformed file, failed recovery objective, or missing cleanup evidence prevents output replacement.

## Failure handling

- A failed nightly job leaves no final archive name until encryption completes; inspect the unit log and free space, then rerun.
- A checksum failure is a critical incident. Preserve the file, stop offsite sync/pruning, and test the next older archive.
- A stale backup usually means timer, mount, PostgreSQL health, or capacity failure.
- If the target mount disappears, the marker check prevents writing into an ordinary directory on the OS disk.
- Never use `docker compose down -v`, delete PostgreSQL files, edit a dump, or bypass checksum/identity checks during recovery.
