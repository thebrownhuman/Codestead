# Task 9 Live Race Matrix V2 - Authoritative Index

This is the entry point for Task 9. Read the bundle in this precedence order:

1. `2026-07-26-mail-delivery-live-race-matrix-v2-authority-amendment.md`;
2. this authority index;
3. `2026-07-26-mail-delivery-live-race-matrix-v2-execution-errata.md`;
4. `2026-07-26-mail-delivery-live-race-matrix-v2-errata.md`;
5. `2026-07-26-mail-delivery-live-race-matrix-v2.md`.

The readiness snapshot is historical and invalidated. The original plan and
original errata are audit history only.

The frozen design contains **40 top-level cases and 66 mandatory leaf
experiments per PostgreSQL major**. A top-level pass is valid only when all of
its leaf experiments pass.

## Final semantic overrides

### Transaction locks and acknowledgement uncertainty

Production currently uses a transaction-level one-bigint advisory lock.
Therefore it is held through provider settlement and **server transaction
end**, not through client receipt of COMMIT acknowledgement. Never claim it
remains blocked after the server commits.

The two-int synthetic phase gate (`objsubid = 2`) and the single-bigint
production authority lock (`objsubid = 1`) are distinct key spaces:

- the synthetic gate proves deterministic phase placement only;
- every lock-order case separately observes the real production key,
  transaction owner, contender, and waiter.

`commit-ack-lost` requires a loopback-only PostgreSQL protocol proxy for the
one uncertain client. The proxy forwards COMMIT, observes the server-side
`CommandComplete`/`ReadyForQuery`, and drops the client side before forwarding
those acknowledgement messages. An adapter that awaits COMMIT and then
throws proves only `commit-result-suppressed-after-success` and cannot satisfy
the live acknowledgement-loss case.

Capture the xid in the same transaction. After connection end:

- a committed case requires `pg_xact_status(xid8) = 'committed'`;
- an aborted case requires `pg_xact_status(xid8) = 'aborted'`;
- only then reacquire the real aggregate lock and inspect the exact row.

Add the proxy to Work Item 1:

- Create: `scripts/lib/postgres-race-proxy.mjs`
- Create: `scripts/lib/postgres-race-proxy.d.mts`

Every race transaction asserts `READ COMMITTED`. Observer polling is
autocommit or calls `pg_stat_clear_snapshot()` before every observation.
Assert database OID, backend start, lock mode, state, and the exact advisory
wait event in addition to the fields required by the execution errata.

### Exact fault and scheduling proof

Replace `faultConsumed: boolean` with `faultConsumeCount: number`; every leaf
requires `faultConsumeCount === 1`.

The no-sleep rule prohibits `pg_sleep`, `pg_sleep_for`, and `pg_sleep_until`.
Client yielding is allowed only to drive bounded catalog observation.

The actor inventory includes controller, observer, worker, reconciler,
deletion, retention, sweeper, finalizer, authority-writer, scheduler,
maintenance, reset, and cleanup. Every participant has an ordinal and the
encoded `application_name` is asserted to be at most 63 bytes.

### Physical provider attempts

Increment the mismatch-inclusive physical-attempt counter immediately when
the fake Gmail send endpoint receives a request, before parsing, digest
comparison, identity validation, or response selection. A malformed or
forged physical send is still a provider attempt and fails the case; it can
never disappear as `providerCalls = 0`.

The raw RFC Message-ID/correlation token is volatile test memory only. It is
never logged, serialized into evidence, or sent over IPC. Evidence records
only reviewed match codes and digests. The expected tuple and observed tuple
must be independently derived.

Use a sorted per-operation durable projection array plus scenario aggregates;
a one-row projection cannot prove multi-row claimant, deletion, or
reconciliation cases.

### Exact case outcomes

- `TX1-01` uses source revocation and ends in the final API's exact
  `suppressed` result. Account deletion is owned by `DEL-02`.
- `TX2-05` is implemented only after the child fixture exists. The production
  watchdog exits first; the parent containment watchdog must not fire.
- `DEADLINE-01` non-fail-stop leaves the exact frozen pre-Gmail terminal
  failure state, full TX1 evidence, zero Gmail calls, and zero TX2 initiation.
  Its OAuth-never-settles leaf uses the production fail-stop path.
- `DEADLINE-02` records one physical attempt, one abort, discarded
  synchronous/late 2xx, and exact committed quarantine. It has no
  never-settles leaf.
- `CRASH-02` records exactly one physical attempt.
- `CRASH-03` follows
  `sending -> explicit expiry/sweep -> quarantined -> one exact-match
reconciliation`.
- `SWEEP-03` freezes one exact loser result after the API freezes; an
  `A-or-B` assertion is not acceptable.
- `DEL-01` uses accepted sent mail; ambiguity/quarantine blocks deletion.

The checked-in case manifest is the source of truth. A registration test
imports it and byte-compares the generated top-level and leaf enums with the
checked-in JSON schema. Static JSON does not import JavaScript by itself.

### Candidate and command authority

The canonical authoritative checksum is
`2026-07-26-mail-delivery-live-race-matrix-v2-final.sha256`. It uses
repository-relative paths and is verified from the repository root before
implementation, before each major, and before release evidence is accepted.

Use:

- `npm.cmd run ...` only in Windows PowerShell documentation;
- `npm run ...` in Linux CI;
- no `.cmd` token inside package scripts.

Task 8 freezes and registers these exact dependency commands before Task 9:

- `test:migration-ledger`;
- `test:mail-retention-redaction-0068:registration`;
- `test:mail-retention-redaction-0068:pg17`;
- `test:mail-retention-redaction-0068:pg18`;
- `test:mail-guarded-delivery-0069:registration`;
- `test:mail-guarded-delivery-0069:pg17`;
- `test:mail-guarded-delivery-0069:pg18`;
- `test:database-role-boundaries`;
- `backup:restore-smoke`;
- `bash infra/tests/rollback-production.test.sh`.

Registration never substitutes for PG17/PG18 behavior.

The accepted Task 9 candidate is a clean detached commit created only after
Task 8 has registered the contiguous journal and reviewed ledger through
`0069_mail_outbox_guarded_delivery_authority` and all commands above pass.
Freeze all implementation and handoff bytes before matrix execution. Run the
pair from that one candidate and write evidence outside its worktree. Any
later tracked change produces a new tree and requires both majors again.

## Completion rule

Task 9 is complete only when:

- the Program Task 5-8 dependency manifest is frozen on one clean candidate;
- all 66 leaf experiments pass on PG17 and PG18;
- the exact pair verifier accepts `pg17.json`, `pg18.json`, and `pair.json`;
- cleanup, output-canary, candidate-identity, migration-catalog, role,
  restore, and rollback gates pass;
- the remaining Gmail/NUC/Cloudflare/Drive/reboot/AC-cut blockers are
  explicitly reported as external evidence, not repository completion.
