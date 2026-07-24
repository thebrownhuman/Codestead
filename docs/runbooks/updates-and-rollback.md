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

Fetch and detach the exact reviewed commit before invoking the transaction. Replace the value below with the 40-hex commit that passed review and CI; never deploy `main`, `HEAD`, a shortened SHA, or an uncommitted working tree as the release identity.

```bash
CODESTEAD_RELEASE_COMMIT='REPLACE_WITH_REVIEWED_40_HEX_COMMIT'
printf '%s\n' "$CODESTEAD_RELEASE_COMMIT" | grep -Eq '^[0-9a-f]{40}$'
test -z "$(sudo git -C /opt/learncoding status --porcelain=v1 --untracked-files=all)"
sudo git -C /opt/learncoding fetch --depth=1 --no-tags origin "$CODESTEAD_RELEASE_COMMIT"
sudo git -C /opt/learncoding checkout --detach "$CODESTEAD_RELEASE_COMMIT"
test "$(sudo git -C /opt/learncoding rev-parse HEAD)" = "$CODESTEAD_RELEASE_COMMIT"
CODESTEAD_RELEASE_TREE="$(sudo git -C /opt/learncoding rev-parse 'HEAD^{tree}')"
printf '%s\n' "$CODESTEAD_RELEASE_TREE" | grep -Eq '^[0-9a-f]{40}$'
test -z "$(sudo git -C /opt/learncoding status --porcelain=v1 --untracked-files=all)"
sudo test "$(stat -c '%U:%G' /opt/learncoding)" = root:root
printf 'release_commit=%s\nrelease_tree=%s\n' "$CODESTEAD_RELEASE_COMMIT" "$CODESTEAD_RELEASE_TREE"
unset CODESTEAD_RELEASE_COMMIT CODESTEAD_RELEASE_TREE
```

Then run the reviewed release transaction:

```bash
sudo test ! -e /etc/learncoding/secrets/bootstrap_admin_password
sudo REPO_ROOT=/opt/learncoding \
  COMPOSE_ENV_FILE=/etc/learncoding/compose.env \
  COMPOSE_FILE_PATH=/opt/learncoding/compose.yaml \
  bash /opt/learncoding/infra/ops/release-production.sh --acquire-images
sudo docker compose --env-file /etc/learncoding/compose.env -f /opt/learncoding/compose.yaml ps
```

Before invoking the transaction, verify `/opt/learncoding` is a clean root-owned checkout at the reviewed `HEAD` and `/var/lib/learncoding/releases` is `root:root` mode `0700`. The host checkout keeps `.git`; it is not the Git-less runner-guest artifact described in the runner isolation runbook. Before Docker or database mutation, the transaction pins one commit, derives its tree from that commit, and uses `package-release-tree.py --verify-source-manifest` to regenerate and byte-compare the complete manifest for that exact Git tree plus both canonical application files and both canonical runtime files. Missing, extra, stale, malformed, tampered, or concurrently changed evidence fails closed. Explicit rollback repeats the same clean-checkout and complete-manifest gate before it touches Docker. With `--acquire-images`, the transaction pulls only the exact reviewed lowercase digest references and records each acquisition before any container or database mutation. For an audited offline import, omit the option; every image must already resolve locally. Never supply `RELEASE_GIT_COMMIT`; the transaction derives and records the verified checkout itself. Every Compose mutation still uses `--no-build --pull never`.

The transaction stops the tunnel before candidate mutation, records both current and previous Git revisions and image identities, migrates and seeds, starts the internal services, and runs authenticated session/upload/database/runner probes. It exposes the tunnel only after internal smoke passes, then verifies the exact public HTTPS origin and security headers. Any post-start failure re-stops the tunnel and leaves a failed release record. Before the first production release after a Docker Compose upgrade, run `REQUIRE_COMPOSE_MAJOR=5 bash infra/tests/compose-release-cli-contract.test.sh`; the NUC pilot lifecycle was validated against Compose v5.3.1.

Do not pass `--bootstrap-admin` during an ordinary update. That flag is reserved for the one initial administrator bootstrap and requires the temporary file-backed password secret.

No automatic schema rollback is attempted or claimed. Automatic application restore is disabled by default. Supplying `--schema-backward-compatible` is an explicit operator assertion that the prior application understands the already-migrated schema; it may restore only the exact recorded local images. Automatic restore is never attempted after the new `/etc/learncoding/active-release.env` commit marker becomes visible; a later evidence or audit-pointer failure quarantines the tunnel and requires the explicit rollback command, which republishes matching prior runtime evidence. The transaction and rollback tool never reverse SQL. If compatibility is uncertain, restore a verified database recovery point instead.

The mail store transition is a stricter boundary. Follow [Mail outbox store cutover](mail-outbox-cutover.md). `--mail-store-cutover` cannot be combined with `--schema-backward-compatible`; a record with `STORE_CUTOVER=true` is forward-only and the rollback tool will not restore its legacy claimant. Later fenced releases may roll back only to the exact reviewed previous fenced artifact.

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

1. Keep the failed release and logs for diagnosis. Find its absolute record path and verify `status.env`, `git-commit.txt`, `previous-git-commit.txt`, `previous-release-id.txt`, `previous-running-images.tsv`, and `previous-runtime.override.yaml`.
2. Confirm through migration review and staging evidence that the prior application is backward compatible with the current schema.
3. Run the recorded rollback exactly:

   ```bash
   failed_record=/var/lib/learncoding/releases/<FAILED_RELEASE_ID>
   sudo REPO_ROOT=/opt/learncoding \
     COMPOSE_ENV_FILE=/etc/learncoding/compose.env \
     COMPOSE_FILE_PATH=/opt/learncoding/compose.yaml \
     RELEASE_RECORD_ROOT=/var/lib/learncoding/releases \
     bash /opt/learncoding/infra/ops/rollback-production.sh \
       --release-record "$failed_record" \
       --schema-backward-compatible
   ```

4. The rollback command refuses missing or changed evidence, mutable/missing images, and any build or pull. It stops the tunnel, restores app/workers, runs internal smoke, starts the tunnel, then runs public smoke. A failure re-quarantines the tunnel and preserves the deployed-release pointer.

If a migration is incompatible, do not run handwritten reverse SQL against live data. Restore the pre-release dump into a new database named `learncoding_restore_*`, validate it, update a newly created `database_url` secret to that database during a maintenance outage, and restart. Retain the original database until the incident closes. The restore runbook deliberately refuses an in-place database overwrite.

## Roll back the runner

Use **Exact runner rollback** in [Runner isolation](runner-isolation.md#exact-runner-rollback) unchanged. It validates both manifest digests, the retained root-owned tree, the prior pin record, the five immutable runtime references, the rebuilt runtime evidence, firewall activation, and service readiness before code execution returns. Do not hand-rebuild from a branch or start around a failed installer; keep code execution disabled while lessons, authentication, and progress remain available.

Never move the runner onto the trusted NUC as a shortcut. If the shared secret may have entered logs or a compromised VM, rotate it on both sides before re-enabling submissions.

## Abort criteria

Abort or roll back if any migration fails, app health remains unhealthy after the start period, Cloudflare cannot reach the origin, login/session exclusivity changes unexpectedly, a learner can cross account boundaries, backup checks fail, runner limits differ, or direct host ports appear.
