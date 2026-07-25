# Backup-status mail authority integration

Migration `0065_backup_status_mail_authority.sql` is intentionally reserved after
the `0063` retention fence and `0064` guarded-dispatch binding migrations. The
shared Drizzle journal is not changed in the isolated lane; integration must add
0065 contiguously after those two predecessors.

The host backup scripts do not write `email_outbox`. They invoke the
`backup-status-reporter` one-shot service with only a validated run key and one
of the fixed outcomes `success` or `failure`. That service receives the
purpose-specific `learncoding_backup_reporter` URL through a mounted file. The
role has no table, sequence, type, ownership, membership, or default privilege.
Its only application capability is:

```sql
public.enqueue_backup_status_mail_authority(text, text)
```

The owner-owned, `SECURITY DEFINER`, `search_path=pg_catalog` routine selects
the sole active, unbanned administrator under locks. It derives the recipient,
account scope, fixed template/version/variables, operation ID, and idempotency
key. Same-run replay returns the original identifiers only when every durable
source and outbox field still agrees; otherwise it fails closed.

## Guarded-dispatch boundary

The `backup-status` template must not remain in a generic account-template
allowlist. In the guarded provider transaction, after the account-scope lock
and ordinary fence/payload checks, authorize this template only with:

```sql
select public.backup_status_mail_authorized($1::uuid)
```

Pass the candidate outbox ID. Invoke this predicate inside the same locked
transaction that decides whether the bounded provider callback may start. Do
not call it before the transaction or cache its result. A false result or SQL
error suppresses the send. There is no system-mail or generic-account fallback.
The predicate revalidates and locks the exact source, operation, outbox,
recipient, template, version, variables, idempotency key, account scope, admin
role/status/ban state, canonical email, and sole-admin invariant.

`0065` uses an `a:<admin-id>` delivery scope, so the `0063` account retention
and deletion fence can redact unresolved recipient PII and revoke authorization
without a special system-scope carve-out.

## Release and restore gates

Both migration-time grants and post-migration reconciliation are required.
Release and restore verification must fail closed unless:

- both application routines are owned by `learncoding_owner`;
- both are `SECURITY DEFINER` functions with the sole setting
  `search_path=pg_catalog`;
- only `learncoding_backup_reporter` can execute the enqueue routine;
- only `learncoding_worker` can execute the boundary predicate;
- neither runtime role has direct or column-level rights on the authority
  ledger, and the reporter has no rights on any application table.

The registered live harness runs first on the production-pinned PostgreSQL 17
toolchain and then on PostgreSQL 18. The isolated lane does not claim live Gmail
delivery, Google Drive state, NUC runtime, reboot, or power-loss evidence.

## Explicitly deferred

This lane removes all direct application-role DML from the new authority ledger,
but it does not close the repository-wide P3-2 finding: the existing bootstrap
still grants broad table DML to `learncoding_app` and `learncoding_ops` on other
application tables. Release hardening owns the per-table/per-column privilege
matrix. Until that lands and passes live role-boundary probes, compromise of
either broad role still carries modification/deletion risk outside this ledger.
