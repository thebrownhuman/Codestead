# Data lifecycle, export, and account deletion

Policy version `2026-07-14.v4` is authoritative in `src/lib/data-lifecycle/policy.ts`. All cutoffs are calculated from one injected UTC timestamp. Changing a duration requires a new policy version, review of this runbook, a migration if storage classification changes, and updated tests. Version v4 adds account-lifetime certificate and public-portfolio records; version v3 added account-lifetime append-only project revision history and file metadata snapshots; version v2 added authoritative learner drafts and their idempotency receipts. Browser session cache remains outside retention authority and is never a backup.

## Retention categories

| Category | Launch retention | Automated action |
|---|---:|---|
| Raw tutor messages | 12 calendar months | Hard-delete in bounded batches; remove empty old threads |
| Completed/indeterminate `tutor.post` replay receipts | 12 calendar months | Hard-delete safe-response copies in bounded batches with the raw-chat cutoff; credential test/replace receipts remain administrator/security records |
| Raw code submissions and runner results | 12 calendar months | Hard-delete submission; runner jobs cascade |
| AI request ledger and `ai_request_attachment` objects | 12 calendar months | Delete bounded metadata rows/attachments; never delete provider usage evidence needed for billing before this cutoff |
| Token-free authentication/session and decided revocation history | 90 days | Delete; official exam/mastery evidence tables are deliberately outside this purge |
| Stale pending device-revocation requests | 90 days | Mark `expired`; do not delete in the same run |
| Administrator audit chain | At least 24 months | No automatic purge at launch; reports the older population as retained |
| `temporary` objects | 24 hours | Remove file, quota rows, and metadata |
| Quarantined, terminal scanner-error, or user-soft-deleted objects | 7 days | Remove file, quota rows, and metadata |
| Terminal sent/suppressed/failed email delivery records | 30 days | Delete delivery record |
| Mastery state and official evidence | Until administrator account deletion | Never touched by scheduled retention |

User uploads classified `user_upload` remain until user deletion or administrator account deletion. Future AI attachment writers must set `retention_class=ai_request_attachment`; temporary writers must set `temporary`. The database rejects unknown classes.

## Dry run and daily apply

Run a dry run before enabling the timer:

```bash
cd /opt/learncoding
docker compose --env-file /etc/learncoding/compose.env \
  -f /opt/learncoding/compose.yaml --profile operations run --rm --no-deps lifecycle \
  node --import tsx /app/scripts/data-lifecycle.ts retention --dry-run \
  --idempotency-key retention:2026-07-14.v4:YYYY-MM-DD:dry-run
```

Apply requires the exact reviewed policy version:

```bash
npm run lifecycle -- retention --apply --confirm 2026-07-14.v4 \
  --idempotency-key retention:2026-07-14.v4:YYYY-MM-DD:apply
```

The default key is policy/version/date/mode. Reusing a successful key returns the recorded report without deleting again. A running key fails closed; a failed key requires a new reviewed key. Every category reports eligible, physically deleted, retained, and `hasMore`; state-only changes such as expiring a request or marking a backup tombstone eligible for operator review use `transitioned` and keep `deleted=0`. Rerun with a new key when a bounded batch reports more. Failed object-file removal leaves metadata in place for retry.

The report category `tutorReplayReceipts` applies the raw-chat cutoff only to `provider_operation_receipt.action='tutor.post'`. Credential test/replacement receipts contain only an opaque canonical hash and safe result metadata; they follow the at-least-24-month administrator/security-record rule and have no automatic launch purge. Every receipt is owner-FK-cascaded during account deletion. A stale `processing` receipt is intentionally never auto-reclaimed because the provider may already have received the request; investigate it rather than risking a duplicate provider call.

`learncoding-retention.timer` runs the apply job daily at 03:45 UTC with jitter and persists across downtime. Inspect:

```bash
systemctl list-timers learncoding-retention.timer
journalctl -u learncoding-retention.service --since '2 days ago'
```

## Administrator export

Only an authenticated administrator can call:

```text
POST /api/admin/learners/{learnerId}/data-export
```

First establish fresh TOTP MFA through `/api/security/fresh-mfa`, then submit a UUID request ID, an 8-500 character reason, and optional bounds. The response is streamed NDJSON with `no-store` and attachment headers. Defaults are 5,000 records and 10 MiB; hard ceilings are 10,000 records and 20 MiB. The service rechecks that the actor is an active administrator and refuses deleted or deletion-pending targets. The manifest and footer are always reserved inside the byte ceiling and disclose truncation.

Export schema 6 uses field allowlists and excludes provider credential material (including ciphertext), password/OAuth fields, MFA/recovery data, live session tokens/IP/device fingerprints, notification bodies/action URLs, internal audit reasons, hidden tests/grading keys/internal exam blueprints, other users, and backup material. Learner-visible plans, answers, progress, sessions, achievements, reviews, requests, chat, code, opaque runner admission request ID/hash, and safe runner job state/times are included; runner result bodies, remote job identifiers, limits, and hidden per-test evidence are not added by the admission export projection. Code/chat/JSON fields have per-record caps. Binary uploads are not embedded; safe metadata is included and files remain downloadable through their normal authorization path. Every request has pre-stream and completion/failure audit events plus a lifecycle-run record.

## Administrator account deletion

Only an authenticated administrator with fresh TOTP MFA can call:

```text
POST /api/admin/learners/{learnerId}/delete-account
```

The body requires a UUID request ID, a recorded reason, and exact confirmation `DELETE`. The service independently verifies that the actor is an active administrator and the target is a learner. It serializes against all user authority and runner admission. A proven pre-dispatch queued row may be cancelled without execution; any leased/running or remotely identified job blocks deletion until its official worker or the practice recovery worker reaches terminal truth. Only then does deletion move the learner to `deletion_pending` and revoke sessions.

Primary erasure uses a durable three-stage protocol. First, one database transaction removes learner rows and object metadata, inserts one idempotent `storage.file_erasure.v1` job per object, and stores a non-final `file_erasure_pending` lifecycle checkpoint. Only after that transaction commits may a worker resolve the allowlisted `<owner>/<object UUID>` path and call `unlink`; `ENOENT` is terminal success, other errors are hashed and retryable, and expired leases are crash-recoverable. Finally, a second serialized transaction verifies every queued job is durable-success, pseudonymizes the minimal user row, publishes the tombstone/final report, queues the former-address notification, and purges the short-lived object keys. Therefore a rollback can never restore metadata for bytes already removed, and no API/report claims completion while an unlink is pending or failed. Deleting each terminal owned `code_submission` still cascades its unique `runner_job` and immutable practice recovery snapshot before the account row is pseudonymized.

The deletion report and `account_deletion_tombstone` contain only a keyed identity hash, policy version, aggregate counts, explicit database/file-erasure completion, and backup status. They do not contain the old email/name, secrets, code, chat, filenames, or object keys. A failed file removal stops completion and leaves the account locked in `deletion_pending`; replay the exact request ID after fixing storage permissions. A process crash may leave the run `running` at `file_erasure_pending`; the exact request safely resumes it because the per-run advisory lock, row lease and idempotency key prevent duplicate destructive work.

Scheduled retention uses the same queue. Its object metadata deletion and checkpoint commit before unlink; the global retention advisory lock proves a crashed `running` checkpoint is abandoned, and a failed checkpoint can be replayed with the same reviewed idempotency key. A retention report is changed to `succeeded` and its opaque queue rows are purged in one transaction only after all file jobs are terminal-success.

## Backup truthfulness

Primary deletion does **not** erase older encrypted backup archives. The tombstone starts as `awaiting_retention_expiry` and records a conservative `backup_retention_until` 12 calendar months after deletion, matching the maximum monthly restore-point window. The existing 7 daily / 4 weekly / 12 monthly backup policy continues normally.

Report tombstones with:

```bash
npm run lifecycle -- backup-expiry-report
```

`retentionWindowElapsed=true` means only that the minimum window elapsed. It does not prove erasure. An operator must inspect every configured local disk, emergency set, and offsite repository and document the result before any future workflow may change status to `verified_expired`. This release deliberately has no command that silently makes that claim.

## Recovery and review

- Never edit a lifecycle-run report or tombstone by hand.
- Preserve failed run IDs and error codes; do not put raw error messages, email, keys, code, or filenames in reports.
- Restore drills may temporarily reintroduce data deleted after the selected restore point. Isolate drills, do not reconnect them to production ingress/mail/providers, and destroy the drill database afterward.
- After restoring production from an older archive, rerun retention with a new key and reconcile every deletion tombstone before reopening access.
- Quarterly, inspect an export fixture for excluded fields, run a deletion fixture in disposable PostgreSQL/object storage, and attach the output of the backup-expiry report to the operations review.
