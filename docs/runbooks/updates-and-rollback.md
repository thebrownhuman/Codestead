# Updates and rollback runbook

## Change policy

Change one risk domain at a time: application release, PostgreSQL image, `cloudflared` image, runner service, runtime language images, or host packages. Pin every third-party image by digest. Record the old and new Git commit, image references, migration list, operator, start/end time, and smoke-test result.

Never change PostgreSQL major versions by editing `POSTGRES_IMAGE` and restarting. Major upgrades require a separately rehearsed `pg_upgrade` or dump/restore procedure using the target version's official documentation.

## Before any application release

1. Read the diff, migration SQL, dependency lockfile changes, and content validation result.
2. Run repository tests and `node infra/tests/validate-static.mjs`.
3. Run `npm audit` as input to review, not as an automatic breaking-change upgrade command.
4. Start a manual encrypted backup and run the backup check:

   ```bash
   sudo systemctl start learncoding-backup.service
   sudo systemctl status learncoding-backup.service
   sudo systemctl start learncoding-backup-check.service
   ```

5. Confirm at least one older known-good archive and its offline identity exist.
6. Schedule a short family maintenance window. Stop assigning new runner work.

## Deploy

Install the reviewed tree at `/opt/learncoding`, then:

```bash
sudo REPO_ROOT=/opt/learncoding COMPOSE_ENV_FILE=/etc/learncoding/compose.env \
  bash /opt/learncoding/infra/ops/validate-runtime.sh
sudo systemctl reload learncoding-compose.service
sudo docker compose --env-file /etc/learncoding/compose.env -f /opt/learncoding/compose.yaml ps
sudo bash /opt/learncoding/infra/ops/smoke-production.sh --startup-wait 600
```

Before reload, explicitly pull or import every reviewed digest referenced by `/etc/learncoding/compose.env` and record its image identity. The systemd reload uses `--no-build --pull never`; a missing image must fail instead of building or implicitly acquiring an unreviewed artifact. The one-shot migration container must complete successfully before the app starts. Do not bypass it. Inspect `migrate`, `app`, `postgres`, and `cloudflared` logs, then run the learner smoke path described in the deployment guide. The later release-transaction work remains responsible for fully separating migration/seed/bootstrap from ordinary boot.

Recurring retention consumes the canonical `2026-07-14.v4` command from the Compose lifecycle service. Follow [Data lifecycle, export, and account deletion](data-lifecycle.md) for the authoritative invocation and idempotency rules rather than maintaining a second procedure here.

## Container and host updates

- Resolve a reviewed tag to an immutable digest, test that exact digest, update `compose.env`, validate, then reload the service.
- Update PostgreSQL and `cloudflared` separately so a regression has one likely cause.
- Refresh runner runtime images in a maintenance window. Pre-pull by digest, scan, run harness tests, then update all `RUNNER_IMAGE_*` values together only if compatibility requires it.
- Ubuntu security updates may run unattended. Review `/var/log/unattended-upgrades/` and reboot deliberately when `/var/run/reboot-required` exists. Verify Docker, Compose, the tunnel, timers, backups, and runner after reboot.

A controlled reboot, runner VM autostart proof, and supervised AC-loss rehearsal remain mandatory deployment evidence. A repository or static systemd check is not evidence that those external recovery gates or the 15-minute target passed.

Docker warns that convenience install scripts are for development. Keep Engine and Compose on the official apt repository and review major-version release notes before upgrading.

## Roll back application code

Rollback is safe only when the previous app understands the current schema.

1. Keep the failed release and logs for diagnosis.
2. Reinstall the prior reviewed tree/image reference without rewriting the database.
3. Run runtime validation and reload the Compose service.
4. Repeat smoke tests.

If a migration is incompatible, do not run handwritten reverse SQL against live data. Restore the pre-release dump into a new database named `learncoding_restore_*`, validate it, update a newly created `database_url` secret to that database during a maintenance outage, and restart. Retain the original database until the incident closes. The restore runbook deliberately refuses an in-place database overwrite.

## Roll back the runner

Stop the runner unit, restore the prior reviewed runner tree and pinned runtime digest set, rebuild `services/runner/dist`, then start it and run the isolation checklist. Never move the runner onto the NUC as a shortcut. If the shared secret may have entered logs or a compromised VM, rotate it on both sides before re-enabling submissions.

## Abort criteria

Abort or roll back if any migration fails, app health remains unhealthy after the start period, Cloudflare cannot reach the origin, login/session exclusivity changes unexpectedly, a learner can cross account boundaries, backup checks fail, runner limits differ, or direct host ports appear.
