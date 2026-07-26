# Task 9 Live Race Matrix — Implementation Readiness Snapshot

**Captured:** 2026-07-26T22:24:16.4504344+05:30

**Disposition:** `NO-GO`

This is a read-only snapshot of the shared worktree. It is not release
evidence and it does not freeze Tasks 5–8. Implement Task 9 only after each
dependency below is reviewed at a stable Git tree.

The authoritative design is:

- `2026-07-26-mail-delivery-live-race-matrix-v2.md`
- `2026-07-26-mail-delivery-live-race-matrix-v2-errata.md`

## Snapshot identities

| File | SHA-256 at capture |
| --- | --- |
| `drizzle/0067_mail_outbox_durable_replay_authority.sql` | `2ab31d2d2e84ee3e21e1b6bf9c7c0cbdb6f2e269f66729f46c3cffb8532761a` |
| `src/lib/notifications/postgres-outbox-store.ts` | `844c68be745a712dc65983f5ab9f23f8aab2ed517e04469ba49b077c3f17436c` |
| `integration/mail-delivery-races.integration.test.ts` | `9cd248c275f589c6ea252c019dcdd4695e3072e69abbdb224256130c404cac80` |

Any hash change invalidates the classifications below and requires this
readiness audit to be repeated.

## Dependency classification

| Dependency | State | Current evidence | Gate still required |
| --- | --- | --- | --- |
| Task 5 / 0067 replay identity and permanent hold | **Moving / partial** | Migration 0067 and its journal entry exist in the worktree. `delivery_hold_version = 'task7-v1'` and its insert/update guards are now present. The migration itself is untracked and `drizzle/meta/_journal.json` is modified. | Freeze the seven-state replay contract, conflict/source binding, all producer dispositions, hold invariants, role/catalog hashes, PG17/PG18 proof, and final reviewed bytes. |
| Task 6 / 0068 redaction and retention | **Missing** | The migration directory and journal end at 0067. No `test:mail-retention-redaction-0068:registration` package command exists. | Land and verify the final 0068 routine, cutoff predicate, immutable replay/correlation preservation, roles, registration, and PG17/PG18 evidence. |
| Task 7 / guarded TX2 runtime | **Missing core** | `beginProviderCall` starts a database transaction at `postgres-outbox-store.ts:1492`, returns after committing TX1, and `outbox-worker.ts:376` calls the provider outside that transaction. `finishAfterProvider` opens a later transaction at `postgres-outbox-store.ts:1777`. There is no `dispatchAfterProviderBoundary`, `finishGuardedDispatchUnknown`, or release-receipt footprint in the current source. | Land exact-byte TX2 with the same aggregate lock through provider settlement and terminal commit acknowledgement, bounded OAuth/send/watchdog behavior, dedicated pools, one-shot uncertainty settlement, and append-only delivery release. |
| Task 8 / roles, CI, restore, rollback | **Moving / partial** | Package and CI registrations currently cover 0063–0067. No final 0068 or Task 9 registration exists. Role/bootstrap/release files are concurrently modified by other lanes. | Freeze exact roles/capabilities, migration tail through 0068, restore verifier, exact-SHA rollback, and CI ordering before Task 9 registration. |

## Existing Task 9 baseline

`integration/mail-delivery-races.integration.test.ts` currently has 13
explicit integration scenarios covering part of claim, boundary, sweep, and
deletion ordering. It is useful baseline evidence, but not the final matrix.

The existing harness is not yet safe or exact enough for the 40-case run:

- `assertDisposableDatabase()` accepts `INTEGRATION_TEST=1` plus a database
  pathname regex; it does not bind the test to the launcher-created run ID,
  exact port, role, URL, and server identity.
- Setup truncates every public base table.
- `waitForAdvisoryWaiters()` accepts a count greater than or equal to the
  target; it does not prove the exact blocker/waiter PIDs, roles,
  application names, advisory key, wait event, and `pg_blocking_pids()`.
- Fault injection is not yet constrained to one exact transaction phase and
  backend identity.
- Cleanup removes the temporary directory and calls `pool.end()`, but it
  lacks the V2 resource registry, bounded child/process/client cleanup,
  zero-session/zero-lock proof, and deadlock-counter invariant.

These are implementation targets, not reasons to weaken the V2 contract.

## Implementation start rule

Task 9 may start only when one stable candidate proves all of the following:

1. the migration journal is contiguous through the final 0068;
2. Tasks 5–8 files are no longer changing;
3. the exact Task 5 hold and Task 7 release-receipt catalogs are present;
4. guarded TX2 and its uncertainty interfaces are present in production
   source;
5. the final role/bootstrap/restore/rollback verifiers recognize the same
   catalog;
6. the focused Task 5–8 registration and PG17/PG18 gates are green.

After that gate, implement the V2 plan in task order. Do not copy behavior
from scratch directories or make compatibility aliases for moving
interfaces.

## External evidence boundary

The Task 9 matrix uses fake provider HTTP. Even a complete green matrix
cannot prove live Gmail OAuth/send, NUC runtime, Cloudflare, Google Drive,
reboot, or supervised AC-cut behavior. Those remain separate external
evidence blockers.
