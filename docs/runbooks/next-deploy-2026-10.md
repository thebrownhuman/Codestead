# Next NUC deploy (October 2026)

One ordered checklist for the next production deploy. It covers everything
merged to `main` since the last NUC deploy plus three PRs that should merge
first:

- [#198](https://github.com/thebrownhuman/Codestead/pull/198) PR6 stage 6a: Piston-only routing (`CODE_RUNNER_PROVIDER` now defaults to `piston` and fails closed).
- [#200](https://github.com/thebrownhuman/Codestead/pull/200) PostgreSQL-down alert timer.
- [#203](https://github.com/thebrownhuman/Codestead/pull/203) Migration 0074: least-privilege mail worker role.

**[OWNER]** marks steps the owner runs on the NUC. Everything else is a check
anyone can do from a browser or a laptop. Never paste secret values into a
terminal command, chat, PR, or log.

## What changed since the last deploy

Last recorded NUC deploy: `7a0dda4` (2026-10-05). Diff with
`git log --oneline 7a0dda4..<deploy-sha>`.

| Area | Change | Deploy impact |
| --- | --- | --- |
| Runner | #154 grading parity, #184 output/problems panel, interactive Piston image + terminal broker (flagged off), #198 Piston-only | Piston profile must be up first (step 3) |
| AI | #157 tutor fixes, learner model choice | Migration 0073 (auto) |
| Mail | #203 mail worker role | Migration 0074 + new secret (stage B) |
| Ops | #161 backup fail-closed, retention v6, #196 systemd `file:` URIs, #200 Postgres alert | Backup env var, reinstall systemd units, enable timer |
| Product | #180/#190 certificates, #188 SEO, #194 SQL practice (PGlite, browser only), #187 recovery limits, #185 export, UI fixes | Verify only |

Compose files: only `compose.yaml` matters. `compose.piston-interactive.yaml`
and `compose.interactive-runner.yaml` are for the flagged-off interactive
terminal; do not add them to this deploy.

## Why two stages

`redeploy-nuc.sh` runs `migrate` automatically whenever `drizzle/` changed.
0074 must run *after* a fenced `database-role-bootstrap` with
`REQUIRE_COMPLETE_MIGRATION_LEDGER=false`, so it cannot go through the script's
automatic migrate. Deploy in two stages:

- **Stage A**: last `main` commit *before* #203 (includes #198, #200, 0073). Normal script deploy.
- **Stage B**: the #203 merge commit. Manual 0074 ceremony, then the script.

Write the two SHAs down before starting:

```bash
SHA_A=<main commit with #198 and #200, before #203>
SHA_B=<#203 merge commit>
```

## 0. Pre-flight

1. **[OWNER]** Free disk (image builds need ~10 GB) and running containers:

   ```bash
   df -h / /var/lib/docker
   sudo docker compose -p learncoding ps
   ```

2. **[OWNER]** Fresh off-site backup and check it landed:

   ```bash
   sudo systemctl start learncoding-restic-backup.service
   sudo bash /opt/learncoding/scripts/backup/restic.sh snapshots
   ```

   The newest snapshot must be from the last few minutes. Do not continue if the backup failed.

3. **[OWNER]** Copy the env and secrets for rollback (the script also backs up `compose.env`):

   ```bash
   sudo cp -a /etc/learncoding/compose.env /etc/learncoding/compose.env.pre-2026-10
   sudo cp -a /etc/learncoding/backup.env /etc/learncoding/backup.env.pre-2026-10
   ```

## 1. New env vars and secrets

Names only. Values stay on the NUC.

| Name | Where | Stage | How |
| --- | --- | --- | --- |
| `RESTIC_UPLOADS_EXPECTED` | `/etc/learncoding/backup.env` | A | `false` while uploads are off (database-only), `true` once uploads are on. Missing value fails backups closed (#161). |
| `CODE_RUNNER_PROVIDER` | `/etc/learncoding/compose.env` | A | Must be `piston` (or absent: default is now `piston`). `legacy` no longer works for application routing. |
| `COMPOSE_PROFILES` | `/etc/learncoding/compose.env` | A | Must be `piston` or `uploads,piston`. |
| `PISTON_IMAGE` | `/etc/learncoding/compose.env` | A | Digest-pinned `codestead-piston@sha256:<64 hex>` (see `docs/runbooks/piston-kata.md`). |
| `database_mail_worker_url` (secret file) | `/etc/learncoding/secrets/` | B | Step B1. |

## 2. Install updated systemd units (stage A, after checkout)

Done after the checkout in step 4 so `/opt/learncoding` has the new files.

## 3. Piston up and healthy BEFORE stage A

6a removes the legacy path. If Piston is not running, every code run fails.

1. **[OWNER]** Confirm the env:

   ```bash
   sudo grep -E '^(COMPOSE_PROFILES|CODE_RUNNER_PROVIDER|PISTON_IMAGE)=' /etc/learncoding/compose.env
   ```

   Expect `COMPOSE_PROFILES=piston` (or `uploads,piston`), `CODE_RUNNER_PROVIDER=piston`, and a `@sha256:` `PISTON_IMAGE`.

2. **[OWNER]** Piston container healthy and executing:

   ```bash
   sudo docker compose -p learncoding ps piston
   docker run --rm --network learncoding_piston alpine:3.22@sha256:3e9b4b680bfc9fb5269227cffbd6d42be39fbf7c0b908123913864aa4447e764 wget -qO- --header content-type:application/json --post-data '{"language":"python","version":"3.14.8","files":[{"content":"print(6*7)"}]}' http://piston:2000/api/v2/execute
   curl -fsS https://code.shivanshmishra.in/health/runner
   ```

   Expect `42` in the output and `/health/runner` 200. If not, fix Piston first (`docs/runbooks/piston-kata.md`); do not deploy.

## 4. Stage A deploy

1. **[OWNER]** Set the backup env var (step 1), then deploy:

   ```bash
   sudo git -C /opt/learncoding fetch origin
   sudo git -C /opt/learncoding checkout --detach "$SHA_A"
   sudo bash /opt/learncoding/infra/ops/redeploy-nuc.sh "$SHA_A"
   ```

   The script builds the seven images, swaps `APP_*_IMAGE`, runs `migrate`
   (0073), restarts app + workers + `piston`, and waits for `/health/ready`.
   Use `--no-scan` only if Trivy blocks on a known, accepted finding.

2. **[OWNER]** Reinstall the systemd units changed by #196 and add the #200 Postgres check:

   ```bash
   sudo install -o root -g root -m 0644 /opt/learncoding/infra/systemd/learncoding-*.service /opt/learncoding/infra/systemd/learncoding-*.timer /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now learncoding-postgres-check.timer
   sudo systemctl start learncoding-postgres-check.service
   systemctl status --no-pager learncoding-postgres-check.service
   ```

   Expect the service `inactive (dead)` with `status=0/SUCCESS`.

3. Run the post-deploy checks (section 6). Fix anything before stage B.

**Rollback A** **[OWNER]**: the script prints the exact command. It restores
the `compose.env` backup and restarts the previous images. 0073 is additive
and is not reversed. Do not set `CODE_RUNNER_PROVIDER=legacy`: the 6a images
reject it; rolling back to the old images is the only way back to legacy.
Timer: `sudo systemctl disable --now learncoding-postgres-check.timer`.

## 5. Stage B: migration 0074 (mail worker role)

Source: #203 PR body and `docs/drafts/mail-worker-0074-nuc-deploy.md`. Mail
pauses during this stage; outbox rows wait and send afterwards.

Shorthand used below (run from `/opt/learncoding`):

```bash
cd /opt/learncoding
DC="sudo docker compose -p learncoding --env-file /etc/learncoding/compose.env -f compose.yaml"
```

B1. **[OWNER]** Create the new secret **before any Compose command at `SHA_B`**
(Compose refuses to start without it). File:
`/etc/learncoding/secrets/database_mail_worker_url`, containing one PostgreSQL
URL for user `learncoding_mail_worker` at `postgres:5432`, the existing
database name, and a new random password of at least 32 bytes. No trailing
newline. Owner `root:codestead-secrets`, mode `0440`. Do not reuse or edit
`database_worker_url`. Write it with an editor, not `echo`, so the password
stays out of shell history; then check without printing it:

```bash
sudo stat -c '%U:%G %a %s' /etc/learncoding/secrets/database_mail_worker_url
sudo tail -c1 /etc/learncoding/secrets/database_mail_worker_url | od -c | head -1
```

Expect `root:codestead-secrets 440`, and the last byte must not be `\n`.

B2. **[OWNER]** Check out `SHA_B` and build the new images (see open question 1):

```bash
sudo git -C /opt/learncoding checkout --detach "$SHA_B"
$DC --profile operations build database-role-bootstrap migrate mail-worker
$DC stop mail-worker
```

B3. **[OWNER]** Fenced bootstrap on the 0073 ledger, then migrate. Bootstrap must succeed first:

```bash
$DC --profile operations run --rm -e REQUIRE_COMPLETE_MIGRATION_LEDGER=false database-role-bootstrap
$DC --profile operations run --rm migrate
```

B4. **[OWNER]** Activate the role and verify boundaries:

```bash
$DC --profile operations run --rm -e REQUIRE_COMPLETE_MIGRATION_LEDGER=true database-role-bootstrap
$DC --profile operations run --rm database-negative-probes
$DC --profile operations run --rm database-boundary-verifier
```

B5. **[OWNER]** Normal script deploy at `SHA_B` (rebuilds reviewed images; its
migrate is a no-op now because 0074 is applied), then confirm mail worker health:

```bash
sudo bash /opt/learncoding/infra/ops/redeploy-nuc.sh "$SHA_B"
$DC ps mail-worker
```

**Rollback B** **[OWNER]**: if B3 or B4 fails, keep `mail-worker` stopped and
stop. Do not grant table-wide privileges, enable the role by hand, or point
mail at `database_worker_url`. To get mail back while debugging, return to
`SHA_A` images (`git checkout --detach "$SHA_A"` then
`redeploy-nuc.sh "$SHA_A"`) only if 0074 did **not** apply; once 0074 has
applied, ask before rolling back (see open question 2). Rolling back never
reverses a migration.

## 6. Post-deploy verification (after A, again after B)

| Check | How | Pass |
| --- | --- | --- |
| Health | `curl -fsS https://code.shivanshmishra.in/health/ready` and `/health/runner` | Both 200 |
| Containers | **[OWNER]** `sudo docker compose -p learncoding ps` | All `healthy`/`running` |
| Login | Sign in at `/login` with the owner account (password + MFA) | Dashboard loads |
| Code runs | Playground: run hello-world in each language (Python, JavaScript, Java, C, C++) | Correct output, no "runner unavailable" |
| Exam grading | Open a practice exercise with tests, submit | Tests run and grade |
| SQL practice | `/learn` → SQL practice; run `SELECT 1;` | Result table shows (runs in browser, no server) |
| Certificates | Open an existing `/verify/<id>` and download its PDF | Page shows no name unless portfolio is public; PDF opens |
| Mail (after B) | Trigger a password-reset email to the owner address | Email arrives; **[OWNER]** `sudo docker compose -p learncoding logs --since 10m mail-worker` shows a send, no auth errors |
| Postgres alert | **[OWNER]** `systemctl list-timers learncoding-postgres-check.timer` | Next run listed |
| Backup | **[OWNER]** next morning: `sudo bash /opt/learncoding/scripts/backup/restic.sh snapshots` | New nightly snapshot |
| Kuma | Uptime Kuma dashboard | All monitors green |

Record old and new SHAs, image refs, migrations (0073, 0074), and result in the
deploy log (`docs/runbooks/updates-and-rollback.md`).

## Open questions

1. **Stage B images.** #203's steps use `docker compose build`, while
   `redeploy-nuc.sh` builds reviewed images from a clean clone and pins them in
   `compose.env`. Should B2 instead build the reviewed operations/worker images
   first (e.g. `redeploy-nuc.sh` with a "no migrate" option, which it does not
   have today)? Until answered, B2 follows the PR body.
2. **Rollback after 0074.** Can `SHA_A` images run against a database with 0074
   applied (mail worker on the old shared secret)? The PR says never fall back
   to the shared secret, so this runbook treats "mail stopped" as the safe state.
3. **Last deploy SHA.** Memory and notes say `7a0dda4` (2026-10-05). If the NUC
   was redeployed later, check `/var/lib/learncoding/redeploy-nuc/deployed-revision`.
4. **#203 is a draft.** If it is not ready, ship stage A alone; it is complete
   without stage B.
