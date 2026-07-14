# Storage reconciliation and capacity runbook

This job closes the durable-storage accounting loop for `DAT-002`. It compares active `stored_object` rows with protected object bytes, checks exact size and SHA-256 integrity, compares active database usage with `quota_ledger`, checks each learner's 2–3 GiB policy limit, inventories missing/deleted-retained/orphan entries, and classifies object-volume utilization at 70/85/95 percent.

The generated JSON is deliberately aggregate-only. It never contains original filenames, content hashes, storage keys, filesystem paths, user IDs, public IDs, names, or email addresses. Do not add these values to console output, monitoring labels, tickets, or the administrator projection.

## Preconditions

- PostgreSQL migrations are current and the application database is healthy.
- `OBJECT_STORAGE_PATH` is an absolute path to the mounted object volume.
- `STORAGE_RECONCILIATION_REPORT_DIR` is an absolute, non-symlink path on a protected operator volume and is not equal to or nested beneath `OBJECT_STORAGE_PATH`. Files are created with mode `0600`; the directory is created with mode `0700`.
- Run as the same restricted operating-system identity that reads the object store. Root privileges are not required.
- Confirm no restore, bulk import, or manual object-store maintenance is in progress.

## Dry run (default)

Run this before every apply:

```bash
OBJECT_STORAGE_PATH=/var/lib/learncoding/objects \
STORAGE_RECONCILIATION_REPORT_DIR=/var/lib/learncoding/reports/storage \
npm run storage:reconcile
```

`--dry-run` is accepted but optional. The job reads every active object through the same no-follow, root-confined verifier used by the malware scanner. It hashes content locally and emits only aggregate counts. It never calls an AI provider or external network service.

Exit codes:

- `0`: healthy, or an apply completed with no remaining findings;
- `2`: safe findings exist and require operator attention;
- `1`: invalid invocation, unavailable root/database/capacity data, or incomplete apply.

The console prints only status, mode, active-object count, total finding count, and confirmation that a report was written. It never prints the report directory.

## Apply

Apply mode requires both flags and the exact policy confirmation:

```bash
npm run storage:reconcile -- \
  --apply \
  --confirm=storage-reconciliation-2026-07.v1
```

Apply is intentionally narrow:

1. It marks active rows with missing, changed, or invalid-key bytes as `scanner_error` using safe codes (`file_missing`, `file_changed`, or `path_invalid`). That fails download closed while preserving the original size/hash metadata for investigation.
2. It takes the same per-learner PostgreSQL advisory lock used by upload reservation, recalculates committed active bytes and ledger totals, and inserts an idempotent `reconcile_adjustment` delta when they differ.
3. It re-reads ledger state before completing the report. Concurrent changes that cannot be safely reconciled are counted as `APPLY_CONFLICT`; they are not overwritten.

Apply never changes a learner's configured quota, never rewrites database size/hash from disk, and never deletes or moves unknown or soft-deleted files. Quota outside 2–3 GiB or usage above quota is a finding for deliberate administrator review.

## Finding codes and response

| Code | Meaning | Required response |
|---|---|---|
| `MISSING_FILE` | Active database row has no verified physical object | Fail closed, inspect backup/object-volume health, restore by immutable object ID through a restricted session, then re-scan. Do not fabricate an empty file. |
| `INTEGRITY_MISMATCH` | Size or content digest differs | Treat as an integrity incident. Preserve evidence, restore from a verified backup or delete through the application after owner/admin review, then re-scan. |
| `INVALID_STORAGE_KEY` | Database key violates the two-segment confined format | Treat as database corruption or unsafe import. Do not use the value as a path. |
| `INSPECTION_ERROR` | A file or directory could not be safely inspected | Verify mount permissions and filesystem health; rerun. The job does not change that object automatically. |
| `ORPHAN_FILESYSTEM_ENTRY` | Physical entry has no current database record | Do not delete automatically. Investigate interrupted upload/import/restore activity and record a restricted incident if needed. |
| `DELETED_FILE_RETAINED` | Soft-deleted database object still has bytes | Review deletion/retention processing. The reconciliation job reports but does not erase it. |
| `LEDGER_DRIFT` | Ledger sum differs from active database-object bytes | Dry-run reports it; confirmed apply inserts an idempotent adjustment after a fresh locked calculation. |
| `USAGE_EXCEEDS_QUOTA` | Active usage is above the learner's configured limit | Stop new uploads (already fail-closed), inspect prior quota/import activity, and choose an audited quota or deletion action. |
| `QUOTA_OUT_OF_POLICY` | Configured quota is outside 2–3 GiB | Correct through the versioned administrator quota control; the job does not clamp it. |
| `UNOWNED_ACTIVE_OBJECT` | Active durable object has no learner owner | Determine whether it is legitimate shared/application data and move it to the declared non-learner accounting class through reviewed maintenance. |
| `CAPACITY_WARNING` | Object volume is at least 70% used | Forecast growth and verify retention/backup headroom. |
| `CAPACITY_CRITICAL` | Object volume is at least 85% used | Pause nonessential imports, notify the operator, and prepare capacity/retention action. |
| `CAPACITY_EMERGENCY` | Object volume is at least 95% used | Stop new uploads at the operational layer, protect PostgreSQL and backup headroom, and execute the disk-capacity incident runbook. |
| `APPLY_CONFLICT` | A row or idempotent adjustment changed during apply | Rerun dry-run; never force an update from stale observations. |

## Scheduling and evidence

Schedule one dry run nightly and after every restore/import. Alert on exit `1` or `2`, report age over 26 hours, any capacity band above `NORMAL`, any integrity finding, and any remaining ledger drift. Retain aggregate reports with other operational evidence according to the log/backup policy; they contain no learner identifiers.

The code exposes `toAdminStorageReconciliationSummary` for a future aggregate dashboard card. This release does not persist a "latest report" database row because that requires a separately reviewed migration. Until then, the protected machine-readable report and operator alert are authoritative.

The administrator quota route already uses its request UUID for audit correlation and email idempotency, but the quota mutation itself has no durable replay record; an exact network retry is therefore resolved by optimistic-version conflict rather than replay. The post-0018 migration owner will add a dedicated quota-change idempotency record. Do not overload `quota_ledger` with privileged-request payloads.

Verification commands:

```bash
npx vitest run src/lib/storage/__tests__/reconciliation.test.ts
npm run test:integration
npm run typecheck
npm run lint
npm run audit:release
```

The real integration fixture uses disposable PostgreSQL and a temporary filesystem. It proves ledger repair, fail-closed status changes, redaction, and that orphan/deleted-retained files remain untouched. A production clamd/EICAR exercise, delivered capacity alert, and restore of a real missing object remain deployment evidence rather than unit-test claims.
