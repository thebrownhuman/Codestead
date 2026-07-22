# Logs and monitoring runbook

For ten invited users, reliable local checks and actionable alerts are more valuable than a large observability stack. Docker JSON logs rotate at 10 MB with five files per service. Systemd records service/timer state in journald.

## Daily health commands

```bash
sudo systemctl --failed
sudo systemctl status learncoding-compose.service
sudo systemctl list-timers 'learncoding-*'
sudo docker compose --env-file /etc/learncoding/compose.env -f /opt/learncoding/compose.yaml ps --all
sudo /usr/bin/bash /opt/learncoding/infra/ops/smoke-production.sh --startup-wait 600
sudo docker stats --no-stream
sudo journalctl -u learncoding-backup.service -u learncoding-backup-check.service --since '2 days ago'
df -h /srv/learncoding /mnt/learncoding-backups
```

The pilot inventory contains exactly eleven long-running services, all of which must be `running`: `app`, `cloudflared`, `exam-finalization-worker`, `file-erasure-worker`, `mail-worker`, `postgres`, `practice-runner-recovery-worker`, `project-review-correction-worker`, `regrade-worker`, `reward-worker`, and `runner-egress-gateway`. Successful one-shots are removed after the release record captures them. `clamav` and `scan-worker` must not appear in the pilot inventory; their presence means the uploads profile was activated unexpectedly.

The bounded smoke command above checks that inventory, migration completion, app readiness, `UPLOADS_ENABLED=false`, PostgreSQL durability, and tunnel health. Success stdout is exactly `production smoke passed`; any other result is a failed startup gate. The timeout is a startup deadline, not permission to continue waiting manually after a failure.

## Health endpoint semantics

`GET /health/live` checks only that the application process can respond. It never queries PostgreSQL, so a successful liveness response does not mean the service is ready for traffic.

`GET /health/ready` checks the application process and runs the bounded PostgreSQL `SELECT 1` probe. It returns HTTP 200 only when the database dependency is available; Compose and the production smoke gate use this endpoint. Both endpoints are unauthenticated, return only generic status JSON, and disable caching.

## Service logs

```bash
sudo docker compose --env-file /etc/learncoding/compose.env -f /opt/learncoding/compose.yaml logs --since 30m app
sudo docker compose --env-file /etc/learncoding/compose.env -f /opt/learncoding/compose.yaml logs --since 30m postgres cloudflared
sudo docker compose --env-file /etc/learncoding/compose.env -f /opt/learncoding/compose.yaml logs --since 30m file-erasure-worker
sudo docker compose --profile uploads --env-file /etc/learncoding/compose.env -f /opt/learncoding/compose.yaml logs --since 30m clamav scan-worker
sudo journalctl -u learncoding-compose.service --since today
sudo journalctl -u learncoding-backup.service --since '7 days ago'
```

Use narrow time windows. Do not paste raw logs into public issues. Review for session tokens, learner source code, email addresses, API-provider responses, and database values before sharing. Secrets must never be intentionally logged; treat any accidental value as compromised and rotate it.

The scanner emits only event names, aggregate outcome counts, duration, and stable error codes. It must never log filenames, storage keys, object IDs, hashes, file bytes, ClamAV signature names, or learner identity. Alert when `scanner_error` objects exist, pending objects age beyond five minutes, `leaseLost` repeatedly increases, the worker restarts, clamd is unhealthy, or virus definitions are stale. See the dedicated upload-scanning runbook for queries and recovery.

On the runner VM, query only its unit and Docker daemon logs. The runner should log IDs, outcomes, timing, limits, and image digests—not full submitted source or shared-secret headers.

## Backup and capacity alerts

`learncoding-backup-check.timer` runs every six hours. It alerts when:

- no local encrypted archive exists;
- the newest archive is older than 36 hours;
- a recent ciphertext checksum fails;
- the app or backup filesystem reaches 70% warning or 85% critical use;
- enabled offsite verification cannot validate a fresh, attested remote pointer.

The daily offsite publication and retention units also fail closed and trigger their unit failure alert when rclone exceeds its deadline or output bound, the remote pointer changes during a transaction, a committed triplet is partial, the deterministic retention journal cannot reconcile, or the final remote inventory differs. Review only the sanitized unit messages and root-only report; never attach rclone output or configuration to a ticket.

```bash
sudo systemctl status learncoding-offsite-sync.service learncoding-offsite-retention.service
sudo journalctl -u learncoding-offsite-sync.service -u learncoding-offsite-retention.service --since '2 days ago'
sudo sed -n '1,15p' /mnt/learncoding-backups/state/offsite-retention-last-report.txt
```

After each quarterly isolated restore, run the recovery-evidence verifier documented in the backup runbook. Alert on a missing or non-passing `recovery-evidence-verification.txt`; do not infer recovery readiness from archive presence alone.

The default alert destination is journald. A root-owned executable `/etc/learncoding/alert-hook` may deliver a notification. Its contract is three arguments: severity, stable event name, and a short message containing no secrets or learner data. The hook must set its own timeouts and must not attach logs, databases, mail files, or backup archives.

Test it without creating an outage:

```bash
sudo /etc/learncoding/alert-hook warning alert_test 'Codestead alert path test'
sudo journalctl -t learncoding-alert --since '5 minutes ago'
```

## Threshold response

- Backup age/checksum: follow the backup runbook immediately; do not prune manually.
- App disk above 85%: inspect `du -x` at one level, Docker image use, and PostgreSQL growth. Never delete PostgreSQL files directly.
- Memory pressure or repeated OOM: stop accepting code jobs, inspect `docker stats`, lower concurrency only at the product boundary (the runner is fixed at two), and plan hardware/resource changes.
- PostgreSQL unhealthy: preserve logs and storage, confirm disk and permissions, then use incident response. Do not repeatedly restart a corrupt database.
- Tunnel down: confirm origin app health first, then tunnel credentials/config and Cloudflare status.
- Outbox backlog: expected while delivery is disabled. Do not mark rows sent manually; communicate invites/resets through a separately verified channel.

## Log retention and privacy

Configure journald size/time caps appropriate to the NUC in `/etc/systemd/journald.conf.d/learncoding.conf`, then restart journald in a maintenance window. Keep enough history for incident analysis but avoid indefinite personal-data retention. Never solve disk pressure with broad recursive deletion; identify the specific bounded log store and use its supported vacuum or rotation mechanism.
