# Incident response runbook

This runbook favors containment and preservation over rapid destructive cleanup. Record times in UTC, operator actions, affected accounts/services, and evidence locations. Never paste credentials, learner source, database rows, raw auth cookies, or backup archives into chat or tickets.

## Severity

- Critical: suspected secret/database/admin compromise, cross-account access, runner escape, ransomware, corrupted live database, lost NUC/backup device, or public database/runner exposure.
- High: persistent login failure, unavailable app with no workaround, failed/stale backups, repeated runner isolation-control failure, or tunnel credential misuse.
- Moderate: one broken lesson/release, expected outbox backlog, or capacity warning with safe headroom.

## First 15 minutes

1. Note detection time and symptom. Preserve narrow relevant logs.
2. Contain the smallest boundary that stops harm:
   - web compromise: stop `cloudflared`, then app if needed;
   - runner suspicion: disconnect the runner VM NIC at the hypervisor and disable submissions;
   - stolen admin session: revoke sessions and disable the account through a known-good admin path;
   - public port: remove the binding/firewall rule and verify externally.
3. Do not delete containers, volumes, databases, logs, or suspected files. Do not run broad cleanup tools.
4. Confirm local encrypted backup state without initiating prune/offsite sync. A post-compromise backup may be useful evidence but is not automatically trustworthy.
5. Notify the family owner using a separate verified channel. Share scope and actions, not secret material.

## Secret-specific containment

Rotate independent secrets separately:

- `runner_shared_secret`: replace on NUC and a newly trusted runner VM, then restart both sides.
- Cloudflare tunnel credential: revoke/reissue in Cloudflare, install the new JSON, restart tunnel, and review routes/DNS/access policy.
- Google OAuth secret: rotate in Google Cloud, install the new value, restart app, and review redirect origins.
- Better Auth secret: rotation invalidates existing signed material; plan forced re-login and verify database sessions are revoked as required.
- PostgreSQL password: create/alter safely inside PostgreSQL, atomically replace both `postgres_password` and `database_url`, then restart. Avoid exposing it in process arguments or logs.
- `credential_master_key`: do not simply replace it. Existing encrypted provider credentials become unreadable. Implement and test a re-wrap migration using old and new keys, or revoke/delete stored credentials and ask owners to re-enter them.
- `age` identity: if disclosed, create a new identity/recipient, immediately produce new backups under the new recipient, replace offsite archives according to the retention decision, and treat every old archive as exposed.
- rclone credential: revoke it at the provider, replace root-owned config, and review remote activity/deletions.

## Scenario guides

### Runner escape or VM compromise

Disconnect the VM at the hypervisor, rotate the shared secret on the NUC, retain a snapshot as hostile evidence if useful, and rebuild from scratch. Follow the runner isolation runbook. Check the NUC for connections outside the expected runner API and verify that no trusted secret ever existed on the VM.

### Web/app compromise

Stop public ingress:

```bash
sudo docker compose --env-file /etc/learncoding/compose.env -f /opt/learncoding/compose.yaml stop cloudflared
```

If active harm continues, stop `app` and `mail-worker` but leave PostgreSQL untouched. Capture image digests, Git commit, container inspect metadata, and bounded logs. Rebuild application images from a reviewed clean commit; do not patch a suspected running container. Rotate any secret the app process could read.

### Database corruption

Stop app writes, preserve PostgreSQL logs and the data volume, and take a separately labeled encrypted forensic dump only if `pg_dump` still succeeds. Restore the latest known-good archive into a new `learncoding_restore_*` database. Validate it before switching the database URL. Never delete or overwrite the original cluster during diagnosis.

### Lost or stolen hardware

Revoke Cloudflare tunnel, OAuth, rclone, runner, and any provider credentials accessible to that device. Invalidate sessions and rotate auth/database secrets as risk warrants. Full-disk encryption reduces offline exposure but does not replace revocation. If a backup drive was stolen, ciphertext remains protected only while the `age` identity is separate and uncompromised.

### Backup failure or ransomware

Disable prune and offsite sync so damage is not mirrored. Disconnect removable backup media. Verify checksums from newest to older without decrypting on the affected host. Rebuild a clean trusted host, attach one offline identity, and perform a staged restore. Treat post-detection archives as untrusted until investigated.

## Recovery and closure

Recovery requires all relevant smoke tests, access-boundary tests, fresh secret inventory, healthy backup check, and a successful new restore drill. Monitor closely for at least 48 hours. Record root cause, data/account impact, rotations, restored archive, residual risk, and preventive actions. Inform affected learners plainly if their personal data or credentials may have been exposed.

Do not close an incident merely because the app responds again.
