# Mail worker role: NUC deployment

Run from the deployment checkout containing the approved 0074 release. The
existing database must have the reviewed migration ledger through 0073. Keep
the existing database secrets. The owner creates the new secret on the NUC;
do not put its contents in a terminal command, shell history, logs, or a PR.

1. Before running any new Compose service, create
   `${SECRETS_DIR:-/etc/learncoding/secrets}/database_mail_worker_url`. It must
   contain a PostgreSQL URL for `learncoding_mail_worker` at `postgres:5432`,
   using the existing database name and a unique password of at least 32 bytes.
   Write only the URL, without a trailing newline or whitespace.
   Set owner/group to `root:codestead-secrets`, mode `0440`, matching the other
   database secrets. Do not reuse `database_worker_url` or replace that file.
2. Build the new operations, migration, and worker images. Stop the mail worker
   and arrange the same maintenance window used for database role bootstrap:
   the existing authentication fence also drains the other managed logins.

   ```sh
   docker compose --profile operations build database-role-bootstrap migrate mail-worker
   docker compose stop mail-worker
   ```
3. Run the canonical bootstrap with the incomplete-ledger setting. On the
   reviewed 0073 prefix this prepares `learncoding_mail_worker` as NOLOGIN,
   with no password, memberships, or object privileges. It must succeed before
   running the migration; 0074 independently checks this fenced state.

   ```sh
   docker compose --profile operations run --rm -e REQUIRE_COMPLETE_MIGRATION_LEDGER=false database-role-bootstrap
   docker compose --profile operations run --rm migrate
   ```
4. Reconcile the complete reviewed ledger, exact runtime inventory, routine
   definitions, and column ACLs. Only this successful activation installs the
   new SCRAM password and enables the mail login. Run both boundary checks.

   ```sh
   docker compose --profile operations run --rm -e REQUIRE_COMPLETE_MIGRATION_LEDGER=true database-role-bootstrap
   docker compose --profile operations run --rm database-negative-probes
   docker compose --profile operations run --rm database-boundary-verifier
   ```
5. After all checks pass, recreate the mail worker so its `/run/secrets/database_url`
   comes from `database_mail_worker_url`. Check its Compose health status. Resume
   other services paused for maintenance according to the deployment runbook.

   ```sh
   docker compose up -d --no-deps --force-recreate mail-worker
   docker compose ps mail-worker
   ```

If migration, activation, attestation, or a boundary check fails, keep the mail
worker stopped. Resolve the reported contract failure before retrying. Do not
grant table-wide privileges, enable the role manually, or fall back to the
shared worker secret.

Compose/env changes: add `database_mail_worker_url` and
`DATABASE_MAIL_WORKER_URL_FILE` to the operations bootstrap and verifier
services; change only the mail worker's database secret source to the new
secret, keeping its target `database_url`. Other worker services retain their
existing database secret source.
