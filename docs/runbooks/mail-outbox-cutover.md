# Mail outbox store cutover

This is a two-release, forward-only production change. It stages only the fenced `PostgresOutboxStore` claimant in a dual-write compatibility artifact, then uses migration `0059_mail_delivery_scope_contract.sql` to close the delivery-scope expansion window. The claimant mode stays fenced across both releases; the phase marker and authenticated release evidence control the forward transition.

Do not combine the two releases. Record both reviewed Git SHAs, image digests, release IDs, and the operator UTC window before starting.

## Phase 1: dual-write compatibility

The first exact artifact must contain only the reviewed fenced worker and fail closed unless its exact mode is selected, while every production outbox writer populates both the legacy fields and `delivery_scope_key`.

Set:

```dotenv
MAIL_OUTBOX_PHASE=dual-write-v1
OUTBOX_WORKER_MODE=fenced-postgres-v1
```

Deploy normally, without `--mail-store-cutover` and without claiming schema backward compatibility:

```bash
sudo bash /opt/learncoding/infra/ops/release-production.sh --acquire-images
```

Retain the completed release record. Its `mail-outbox-contract.env` must name `dual-write-v1`, `fenced-postgres-v1`, and `STORE_CUTOVER=false`. Soak this exact artifact through real invitation, password-reset, account-deletion, backup-status, and scheduled-notification writes. Verify every newly inserted row has the expected account (`a:`) or registered system (`s:`) scope. Resolve writer omissions before continuing.

Do not set `MAIL_ADAPTER=console` to pause delivery: the console adapter consumes rows and records successful delivery. Do not run `npm run worker:email -- --once`; that entry point combines scheduling and claiming and is not a cutover tool.

## Coordinate the host backup writer

The backup service can enqueue `backup-status` mail directly and is outside Compose. Stop new timer starts and wait for any running backup to finish:

```bash
sudo systemctl stop learncoding-backup.timer
sudo systemctl is-active learncoding-backup.service
sudo flock -n /run/lock/learncoding-backup.lock true
```

Continue only when the service reports `inactive` and the nonblocking lock probe succeeds. Do not hold the probe lock while launching the release. The release independently validates and exclusively holds the exact pre-provisioned `/run/lock/learncoding-backup.lock` from before mutator shutdown until the transaction exits. Stopping the timer is operator coordination; the shared lock is the mechanical writer fence.

Take and verify the pre-cutover encrypted recovery point before stopping the timer. Record its success marker; do not start a new backup inside the cutover window.

## Phase 2: fenced store cutover

The candidate artifact must retain the same fenced worker and exact claimant mode; only the reviewed phase and schema contract advance. Set:

```dotenv
MAIL_OUTBOX_PHASE=store-v1
OUTBOX_WORKER_MODE=fenced-postgres-v1
```

Run:

```bash
sudo bash /opt/learncoding/infra/ops/release-production.sh \
  --acquire-images \
  --mail-store-cutover
```

`--mail-store-cutover` and `--schema-backward-compatible` are mutually exclusive. The transaction permits this transition only from the currently linked, completed `dual-write-v1` release whose contract records the same fenced claimant. It then:

1. quarantines public ingress;
2. acquires the trusted host backup writer lock;
3. stops every Compose database mutator and starts PostgreSQL alone;
4. proves there are zero residual restricted sessions, zero `sending` rows, zero unexpired active leases, and zero active rows that crossed the provider-call boundary;
5. runs the migration job, including 0059 catch-up;
6. proves `delivery_scope_key` is `NOT NULL`, the scope check is present and validated, the immutability trigger is enabled, and there are zero null or invalid account/system/orphan scopes;
7. starts the candidate services, whose only mail claimant is `fenced-postgres-v1`; and
8. publishes the release/runtime evidence before clearing quarantine.

The post-0059 query accepts orphan (`o:`) scopes only for terminal `sent`, `failed`, `suppressed`, or `quarantined` history. A pending or sending orphan fails closed.

## Evidence and acceptance

Inspect the new record under `/var/lib/learncoding/releases`:

```bash
sudo cat /var/lib/learncoding/releases/RELEASE_ID/mail-outbox-contract.env
sudo grep -E 'mail-outbox-(host-backup-fence|drain|0059-catch-up)' \
  /var/lib/learncoding/releases/RELEASE_ID/stages.tsv
sudo sed -n '1,8p' /var/lib/learncoding/releases/RELEASE_ID/status.env
```

Require `MAIL_OUTBOX_PHASE=store-v1`, `OUTBOX_WORKER_MODE=fenced-postgres-v1`, `STORE_CUTOVER=true`, and a completed result. Confirm worker health, then send one uniquely identifiable invitation and one reset email. Inspect statuses, attempts, adapter, and provider message IDs; do not print recipients, variables, tokens, or message bodies.

Re-enable the timer only after acceptance:

```bash
sudo systemctl enable --now learncoding-backup.timer
sudo systemctl start learncoding-backup-check.service
sudo systemctl list-timers learncoding-backup.timer
```

## Failure and rollback boundary

Any failed gate keeps the tunnel quarantined and never starts the candidate mail worker. Do not manually clear leases, rewrite provider-boundary rows, replay quarantined mail, or start any mail claimant outside the release transaction.

Once the cutover transaction may have run 0059, the pre-cutover dual-write artifact is not a rollback target. The release record has `STORE_CUTOVER=true`, and `rollback-production.sh` refuses it even when `--schema-backward-compatible` is supplied. Repair forward with a reviewed fenced artifact or restore the verified pre-cutover recovery point while ingress and the mail worker remain stopped.

A later `store-v1` release may use the ordinary explicit rollback tool only to restore the exact pinned previous `store-v1`/`fenced-postgres-v1` artifact whose schema compatibility was reviewed. Generic schema compatibility never overrides a cutover marker.
