# Mail Delivery Live Race Matrix V2 - Execution Errata

This file is authoritative over every conflicting statement in:

- `2026-07-26-mail-delivery-live-race-matrix-v2.md`;
- `2026-07-26-mail-delivery-live-race-matrix-v2-errata.md`;
- `2026-07-26-mail-delivery-live-race-matrix-v2-readiness.md`.

The original V2 readiness snapshot is **invalidated**. Task 5 bytes changed
after it was captured. Preserve that file only as historical evidence that
Task 9 was not ready; do not refresh it while Program Tasks 5-8 are moving.

In this bundle, "Program Task 5-8" always means the upstream delivery
authority work. The six implementation sections in V2 are "Task 9 Work Item
1-6". This avoids the original Task 5/Task 6 naming collision.

## 1. Correct destructive-test authority

The client-supplied 12-hex run ID in V2 is insufficient and the SQL endpoint
comparison is not executable under Docker port mapping. The launcher maps
`127.0.0.1:<random-host-port>` to PostgreSQL's container-local port `5432`;
`inet_server_addr()` is a container address and `inet_server_port()` is
`5432`, not the URL endpoint.

Replace that design with a launcher-owned, server-bound authority:

1. Generate at least 128 random bits for `runNonce`.
2. Verify through Docker inspection that the exact container ID, immutable
   image digest, run label, database, and
   `127.0.0.1:<host-port>:5432` publication match the launcher record.
3. After PostgreSQL starts, use the disposable bootstrap superuser to create
   a test-only `codestead_test_control` schema and exactly one protected
   attestation row containing:
   - `run_nonce_sha256`;
   - `container_id_sha256`;
   - `database_oid`;
   - `database_name`;
   - `postmaster_started_at`;
   - `mapped_host_port`;
   - `server_port = 5432`.
4. Revoke all schema/table access from `PUBLIC` and every scenario role.
   Arbitrary custom GUCs are not authority because a session can set them.
5. Expose only reviewed test-only SECURITY DEFINER verifier/reset routines.
   Pin owner, `SECURITY DEFINER`, `search_path = pg_catalog, pg_temp`, body
   digest, signature, and exact ACL.
6. On the same connection used for reset, verify the protected attestation,
   current database OID/name, postmaster start, and nonce before mutation.
7. Pass the raw nonce only to the dedicated harness process. Logs and
   evidence may contain only its SHA-256.

Add these Task 9-owned files to Work Item 1:

- Modify: `scripts/lib/disposable-postgres-container.ts`
- Create: `scripts/lib/mail-race-reset-authority.mjs`
- Create: `scripts/lib/mail-race-reset-authority.d.mts`

### Login and effective role identity

Every connection projects:

```sql
select
  current_database() as database_name,
  session_user as session_role,
  current_user as effective_role,
  pg_backend_pid() as backend_pid,
  current_setting('application_name') as application_name,
  (
    select backend_start
    from pg_catalog.pg_stat_activity
    where pid = pg_backend_pid()
  ) as backend_start,
  pg_catalog.pg_postmaster_start_time() as postmaster_started_at,
  pg_catalog.inet_server_port() as server_port
```

Compare `session_user` with the URL username. For ordinary role URLs,
`current_user` must equal `session_user`. For the sole owner-assuming
migrator URL, require session role `learncoding_migrator` and effective role
`learncoding_owner`. Never compare the random host URL port with
`inet_server_port()`.

Freeze an actor capability matrix containing:

```text
actor -> URL -> session role -> effective role -> allowed operations
```

Scenario roles must lack owner, superuser, `TRUNCATE`, `CREATEDB`,
`CREATEROLE`, role-admin, and backend-termination powers. Only a
launcher-owned cleanup connection may terminate an exact registered backend.

### Reset authority

Delete the dynamic "all public tables + CASCADE" reset.

The launcher installs a frozen, schema-qualified relation inventory with a
reset flag and digest after the final 0069 migration. The protected reset
routine:

- revalidates the server attestation in the same transaction;
- requires the observed application relation inventory and digest to match;
- truncates exactly the reset-enabled allowlist, with every FK participant
  explicitly named;
- never uses `CASCADE`;
- preserves migration and test-control relations;
- rejects an extra, missing, moved, or differently typed relation.

No scenario role receives direct reset privileges.

## 2. Exact backend topology and bounded execution

Application names include a participant instance and remain at most 63
bytes:

```text
cs-race:<run-short>:<case-id>:<actor>:<instance>
```

Repeated workers, reconcilers, and deletion actors must have different
instances.

Lock observation must include database OID, lock mode, `classid`, `objid`,
`objsubid`, blocker/waiter PID, backend start, session/effective role,
application name, wait event, and `pg_blocking_pids()`. Match every field to
registered identities. The synthetic phase gate and the production aggregate
authority lock are separate observations; a synthetic gate never proves that
the production lock is held.

Each guarded TX2 connection proves bounded settings whose ordering is:

```text
provider deadline
  < idle_in_transaction_session_timeout
  < production Task 7 hard watchdog
  < 40-second parent containment watchdog
```

Also set and verify finite `statement_timeout`, `lock_timeout`, and pool
acquire timeout. Pool capacity remains `concurrency + 2`, with a separate
reconciler reserve.

### Dedicated Vitest configuration

Add:

- `vitest.mail-delivery-races.config.ts`;
- `scripts/lib/mail-race-safe-reporter.mjs`.

The configuration includes only the two Task 9 integration files, uses
`fileParallelism: false` and `maxWorkers: 1`, and has a test timeout greater
than the 40-second containment plus 30-second cleanup budgets. It emits no
raw JSON or assertion values. The safe reporter emits only frozen
case/variant IDs and reviewed result codes.

Exclude both Task 9 files from the broad integration glob. Registration must
prove they execute exactly once through the matrix runner and cannot inherit
the current raw JSON reporter or 30-second timeout.

Use output canaries for recipient, URL, message bytes, token, SQL parameter,
database URL, password, and provider body. Scan captured stdout, stderr,
temporary reports, and uploaded artifacts; any canary is a failure.

## 3. Fail-closed cleanup

Do not release every gate first. In particular, never resolve a send,
deletion, file-erasure, or other irreversible-action gate merely to make
cleanup finish.

The resource registry stores separate `cancel`, `proceed`, and `destroy`
actions, exact backend identities, process handles plus start identity,
temporary roots, timers, signals, and provider-server handles. Cleanup uses
one monotonic 30-second deadline:

1. disarm fault injection;
2. cancel or terminate participants before irreversible gates;
3. roll back or destroy exact registered clients;
4. terminate and await exact child process trees;
5. only then release harmless observation gates;
6. bound every await by the remaining cleanup budget;
7. terminate a backend only when database, PID, backend start, session role,
   effective role, and application name all still match;
8. restore globals and remove only canonical registered temporary roots;
9. prove zero registered locks/waiters and the exact database-session
   baseline, not merely zero tagged application names;
10. prove the deadlock counter did not increase and close all pools boundedly.

A cleanup timeout fails the case and prevents accepted evidence.

## 4. Effective provider request and crash-surviving recorder

The effective request body is the body fetch would send after applying
`RequestInit` overrides:

```ts
async function effectiveRequestBytes(
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Uint8Array> {
  const effective = new Request(input, init);
  return new Uint8Array(await effective.arrayBuffer());
}
```

Do not inspect `input.body` before `init.body`; do not call `String(body)`.

Before TX1, capture the expected HTTP request-body SHA-256 and length from the
immutable prepared snapshot. Do not equate this HTTP JSON-body digest with
the durable Gmail RFC822 dispatch-binding digest. Prove the reviewed binding
and evidence tuple connects both to the same immutable prepared snapshot.

The fake Gmail/OAuth recorder is parent-owned and outlives worker children.
It atomically records the exact expected:

```text
(operationId, messageId, HTTP request SHA-256, HTTP request length,
 sent correlation SHA-256, sent evidence SHA-256)
```

before releasing the provider gate. It hashes and discards raw bytes. Fresh
workers reuse the same case/operation recorder, so a second attempt cannot
disappear with a killed process.

Record safe facts for abort observed/count, settlement count, late-result
discard, and request equality. Reconciliation fixtures must be derived from
the correlation actually observed in the recorded request, not from an
independently seeded lookup.

## 5. Corrected provider and crash semantics

- **TX2-01:** Immediately before physical initiation, lock and re-read the
  account/system/source/row fences, exact append-only release receipt, claim
  generation/owner/token/lease, and complete prepared
  dispatch/correlation/evidence tuple.
- **TX2-05:** The production Task 7 hard watchdog, not the test containment
  watchdog, terminates the worker after abort fails to settle. The parent
  observes that exit and proves its 40-second containment did not fire.
- **TX2-08:** After uncertain-client end, require
  `pg_xact_status(xid8) = 'committed'`, reacquire the same aggregate lock,
  and read the exact committed terminal row/provider ID. Terminal xid plus
  barrier release alone is not commit proof.
- **SWEEP-01:** This is finalizer-first, not "finalizer/reconciler-first".
  Ordinary public sent finalization is always rejected.
- **SWEEP-02:** First force post-initiation TX2 teardown/rollback and prove
  xid terminal plus the scope barrier free. Then expire and sweep. A late
  unbranded result loses; only module-issued one-shot guarded uncertainty or
  exact Gmail reconciliation may settle the successor fence.
- **SWEEP-04:** "First durable identity wins" applies only between valid
  branded authorities. Any later conflicting provider identity loses.
- **DEL-01:** Use one deletion-compatible terminal outcome, specifically an
  accepted sent result. Quarantine remains deletion-blocking.

The durable projection adds non-sensitive exact-equality facts:

```ts
rowIdMatchesExpected: boolean;
scopeMatchesExpected: boolean;
attemptCount: number;
claimTokenMatchesExpected: boolean;
claimOwnerMatchesExpected: boolean;
leaseMatchesExpected: boolean;
providerCallStartedMatchesExpected: boolean;
preparedRequestMatchesExpected: boolean;
releaseReceiptMatchesExpected: boolean;
```

### Crash protocol

Use a discriminated union:

```ts
type RaceChildMessage =
  | Readonly<{
      version: 1;
      caseId: "CRASH-01";
      phase: "TX1_RECEIPT_ISSUED";
      backendPid: number;
      claimVersion: number;
    }>
  | Readonly<{
      version: 1;
      caseId: "CRASH-02";
      phase: "SEND_STARTED";
      backendPid: number;
      claimVersion: number;
    }>
  | Readonly<{
      version: 1;
      caseId: "CRASH-03";
      phase: "GMAIL_2XX_PARSED";
      backendPid: number;
      claimVersion: number;
    }>;
```

`TX1_RECEIPT_ISSUED` occurs only after COMMIT ACK and after the opaque receipt
has escaped the TX1 wrapper. `SEND_STARTED` is the parent recorder's
full-request boundary, not a child-local "about to send" callback; therefore
CRASH-02 records exactly one provider attempt. CRASH-02/03 prove
`sending -> explicit expiry/sweep -> quarantined -> guarded uncertainty or
reconciliation`, never a direct ordinary finalization.

## 6. Forty top-level cases plus mandatory leaf variants

Keep the 40 top-level IDs, but do not call them 40 atomic experiments. Freeze
one structured manifest:

```ts
type MailRaceCase = Readonly<{
  id: string;
  sourceFile:
    | "integration/mail-delivery-races.integration.test.ts"
    | "integration/mail-dispatch-tx2-races.integration.test.ts";
  variantIds: readonly string[];
}>;
```

Every ordinary case has one leaf variant named `<ID>.default`. Replace that
single default with these exact multi-variant inventories:

```text
CLAIM-06.blocked-identity
CLAIM-06.unreleased-receipt
CLAIM-06.direct-hold-mutation

TX2-06.terminal-statement-error
TX2-06.client-loss

TX2-09.request-sha
TX2-09.request-length
TX2-09.operation-id
TX2-09.scope
TX2-09.authority-sha
TX2-09.correlation-sha
TX2-09.evidence-sha
TX2-09.release-receipt
TX2-09.provider-id
TX2-09.public-result
TX2-09.receipt-sequential-reuse
TX2-09.receipt-concurrent-reuse
TX2-09.used-guard-reuse
TX2-09.cross-runtime-reuse
TX2-09.discarded-guard-reuse
TX2-09.value-shaped-forgery

DEADLINE-01.timer-before-work
DEADLINE-01.over-deadline-sync-rejection
DEADLINE-01.abort-listener-sync-success-discard
DEADLINE-01.late-token-success-discard
DEADLINE-01.oauth-never-settles-fail-stop

DEADLINE-02.abort-settles-ambiguous
DEADLINE-02.abort-sync-2xx-discard
DEADLINE-02.abort-late-2xx-discard

RECON-02.multiple-matches
RECON-02.transport-timeout-abort
RECON-02.late-exact-match-discard
```

`TX2-05` alone owns the never-settling Gmail fail-stop; do not duplicate it
under DEADLINE-02. Each leaf injects one fault, emits one safe record per
PostgreSQL major, and is independently required by registration and evidence.

Only the two integration files emit mandatory per-major records. Unit tests
are supporting gates and cannot satisfy a matrix case. The registration test
imports the structured manifest and proves the checked-in JSON schema
contains the exact same top-level and leaf enums.

## 7. Candidate-bound evidence in an executable order

The original order could never emit accepted evidence: it required a clean
candidate before committing its own implementation and attempted to record a
commit in the commit that would create it.

Use this order:

1. Commit the authoritative design bundle.
2. Complete Task 9 implementation and all handoff source changes.
3. Commit and freeze one candidate.
4. Create a clean detached checkout/worktree of that candidate.
5. Derive `commit = HEAD` and `tree = HEAD^{tree}`. Prove clean tracked,
   index, untracked, ignored-output policy, and submodule state before and
   after each major.
6. One orchestrator runs PG17 and then PG18 without permitting a checkout or
   source change. Write evidence outside the candidate worktree.
7. Require exactly `pg17.json`, `pg18.json`, and `pair.json`.
8. The pair verifier requires majors `{17,18}`, identical commit/tree, Node
   version, dependency-manifest digest, migration catalog digest, structured
   case manifest, and complete ordered leaf set; it requires the distinct
   approved PG17/PG18 image digests.
9. Publish handoff/evidence inventory in a separate attestation commit or CI
   artifact that names the verified candidate. That attestation commit is
   not itself a verified release candidate. Any source change requires both
   major runs again.

The start gate consumes one clean candidate dependency manifest with exact
hashes for:

- 0067, 0068, and 0069 SQL, the exact journal and reviewed-ledger entries,
  and every checked-in snapshot required by the final Drizzle metadata chain;
- producer inventory and replay/hold/release contracts;
- guarded TX2, provider, reconciler, and watchdog runtime;
- role/bootstrap/catalog verifier;
- restore and exact-SHA rollback contracts;
- disposable launcher/reset/cleanup code;
- V2, both errata files, and the authoritative checksum.

All Program Task 5-8 proofs and both major runs name the same manifest
digest.

Evidence records SQL-derived `server_version_num`, exact migration tail
`0069_mail_outbox_guarded_delivery_authority`, and the complete
applied-migration catalog digest. Per leaf it records only reviewed codes for
projection match, provider-attempt count, exact lock topology, fault
consumption, xid outcome where relevant, and cleanup status. This is a
candidate-bound pass ledger; it is not live Gmail or hardware evidence.

## 8. CI and dependency gates

Run both the final 0068 and 0069 static registration commands and each
migration's behavioral PG17 and PG18 commands. Also run the exact migration
ledger, database-role, restore, and rollback commands frozen by Task 8. The
earlier V2 erratum must not replace behavioral proof with registration.

Use a dedicated matrix job whose timeout is derived from:

```text
leaf experiment count * per-case bound * 2 majors + setup/cleanup margin
```

The current 20-minute broad integration-job limit is not accepted evidence.
Upload the exact three-file pair only after every candidate-bound adjacent
gate succeeds. A one-major glob upload is forbidden.

Commit and verify this design bundle before implementation. The old readiness
snapshot remains invalidated until one clean, complete Program Task 5-8
candidate exists.

## 9. External evidence remains separate

Nothing in this matrix proves live Gmail OAuth/send, NUC runtime, Cloudflare,
Google Drive, reboot, or supervised AC-cut behavior. Those remain explicit
external evidence blockers.
