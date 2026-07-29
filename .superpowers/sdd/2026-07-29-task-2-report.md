# Task 2 Report - Closed-World Database Capability Manifest

Date: 2026-07-29
Branch: `main`
Accepted base: `5fa486f37433a9c1d7beae1c67109bbb315e3d10`
Candidate commit: pending final staging and commit

## Result

Task 2 implements the repository-scoped closed-world database capability
framework for the exact reviewed `0069` state. It replaces blanket runtime
authority with a finite checked-in policy, independently observed by bootstrap
and standalone verification. Future `0070` and `0071` policies are represented
but unavailable, so they cannot execute or grant authority before their
migrations exist.

This result does not claim that the later identity split, `0070`
expand/prepare, `0071` contract/scrub, or live PostgreSQL release proofs are
complete. Those remain later tasks in the accepted closure plan.

## Immutable manifest facts

- Schema version: `1`.
- Current phase: `0069-current`.
- Required ledger tail:
  `0069_mail_outbox_guarded_delivery_authority`.
- Required migration:
  `drizzle/0069_mail_outbox_guarded_delivery_authority.sql`.
- Canonical manifest fingerprint:
  `fa4f5ef2b8f0c1e00f7118b4ea48f3b5c006be6eda0b81c1f498051f324ef86a`.
- Exact inventory: 128 tables / 1,492 columns total, comprising 127 public
  tables / 1,489 public columns and the three-column Drizzle migration table.
- Other inventory: two schemas, one Drizzle sequence, 141 user-defined types
  including the Drizzle row type, and 76 signature-aware public routines.
- Managed authority: six roles, one membership, 3,213 exact grants, seven
  physical default-ACL rows, and 28 default-ACL tuples.
- Grant breakdown: eight database, eight schema, 2,493 table, 51 column,
  three sequence, 561 type, and 89 routine grants.
- Physical-column provenance:
  `drizzle/meta/0069_public_column_attnums.json`.
- Physical-column semantic digest:
  `b64e0934d046eb1cc4b1609ffbaf309cccdc2fa12fd4154ace19c9f63a0859af`.
- Physical-column source-file SHA-256:
  `f34e1e4a931ed3d0c05baba1ecb0dd9d6e06dc3b466c661f5ef0b426f19a21c7`.

The provenance is explicit: the `0069` snapshot contributes 125 public tables
/ 1,480 columns, migration `0065` contributes two tables / nine columns, and
the Drizzle internal contract contributes its table, three columns, and
sequence.

## Design and authority boundaries

`scripts/database-runtime-capabilities.mjs` is a dependency leaf. It owns the
deeply frozen JSON-domain policies, strict validation, code-point
canonicalization, newline-terminated SHA-256 fingerprinting, exact diffing,
phase resolution, predecessor classification, and structured reconciliation
planning. It does not import `pg`, read the environment, execute SQL, or depend
on either catalog adapter.

The manifest has a complete strict TypeScript declaration for all 19 runtime
exports. A compile-only contract imports and exercises every export and nested
result with `skipLibCheck: false`; an AST parity test rejects missing runtime
values and unsafe `any`.

Bootstrap and the standalone verifier import the same immutable manifest but
independently:

- observe and normalize PostgreSQL catalogs;
- validate exact OID/name pairs, PUBLIC OID zero, complete ACL envelopes and
  raw rowsets, ownership, membership options/effective paths, physical
  default-ACL rows, and full object/column inventories;
- reject duplicate raw object/column/default-ACL rows, non-contiguous
  `WITH ORDINALITY` evidence, and any NULL sentinel mixed with populated ACL
  rows before semantic normalization;
- bind policy to the exact ordered reviewed ledger identity; and
- reject unknown roles, objects, columns, schemas, types, routines, grantors,
  grant options, defaults, and future phases.

Bootstrap renders quoted per-object reconciliation actions. It re-reads and
compares the complete catalog before commit rather than trusting successful
`GRANT` command status. Ownership repair emits only mismatched-object DDL and
is zero-DDL after convergence.

Credential evidence is read through the bootstrap/superuser connection from
boolean-only `pg_authid` projections and never returns verifier bytes or
credential material. Application and bootstrap URLs are distinct, named, and
wired through the shipped entrypoint, Compose, restore drill, and source/
restored backup checks.

The role-boundary launcher runs 145 tests in ten fixed asynchronous lanes:

- manifest: 24 tests partitioned `9 / 6 / 1 / 6 / 2`;
- bootstrap adapter: 23 tests partitioned `1 / 11 / 11`;
- standalone verifier: 12 tests;
- database role-boundary suite: 86 tests.

All 145 declarations across the four registered files must be static, runnable,
unique, and match exactly one lane. The AST inventory rejects `.skip`, `.todo`,
`.only`, computed/optional registrations, escaped aliases, shadowing,
nesting/control flow, dynamic titles/callbacks, and duplicate titles.

Nine lanes retain a 60-second deadline. The single
`bootstrap-missing-grants` lane has a 90-second deadline because it performs
fourteen complete reconciliations of the 3,213-grant catalog. Every running
lane emits a 15-second heartbeat and uses a sanitized environment, fixed
redacted logs, deterministic exit propagation, and same-process Node test
isolation. Windows lanes run beneath the fixed PowerShell
`Start-Process -Wait` tree supervisor; timed cleanup requires successful
`taskkill /T /F` and supervisor closure. The launcher withholds PASS, FAIL, and
TIMEOUT until `completeAndWait` finishes.

The repository-wide outbox-writer inventory retains its 2 MiB per-file limit
and now has an explicit 80 MiB aggregate limit. Per-file and aggregate
violations have distinct failure codes. The full 2,129-file scan remains
included; no manifest, migration, evidence, or source directory was excluded.

## RED-to-GREEN evidence

Representative test-first closures:

1. Blanket current/future `GRANT ... ON ALL TABLES/SEQUENCES` and broad default
   ACL authority were rejected before the finite manifest implementation.
2. Catalogs with unknown table/column keys initially compared equal; strict
   comparable-catalog validation now rejects both before diff or planning.
3. Contradictory raw OID/name evidence and incoherent NULL ACL envelopes were
   accepted by early adapters; both adapters now reject the hostile matrices.
4. Same-phase ledger-tail drift initially compared equal; exact ledger
   identity is now part of every phase seal.
5. The initial declaration exposed only two of 19 runtime values; parity and
   compile-only contracts now cover the complete surface.
6. Comparable catalog metadata was accepted even when its schema version,
   contract, phase, availability, ledger, or provenance was forged. A
   separate bounded lane now proves all six fields are bound before diffing or
   planning.
7. The original role launcher exceeded the interactive ceiling. Its first
   candidate failed on uncovered and hidden test registrations, and its
   timeout path could settle before a child tree was reaped. Exhaustive AST
   partition tests and the shared process-tree barrier close both failures.
8. Managed-role sessions originally authenticated before the shared
   administration lock. The verifier now acquires the lock with the bootstrap
   identity, destroys the pre-lock migrator session, freshly authenticates all
   five managed roles under one deadline, and performs no evidence, catalog,
   or privilege probe until every fresh session has a trusted search path.
   Timeout, late checkout, and late cleanup-failure regressions are green.
9. The writer scan reported a 64 MiB aggregate overflow as a per-file error.
   RED tests proved the wrong code and old bound; the corrected 80 MiB bounded
   scan passes without excluding security-relevant files.
10. The strict restore-ledger flag was accidentally applied to pre-bootstrap
    authority removal as well as installation. The resolver is now split:
    removal accepts the reviewed compose default `false`, while installation
    alone requires exact `true`.
11. The authentication-gate transaction originally reset settings and
    committed the owner-to-migrator membership before an exact membership
    reread. It now commits only a safe `NOLOGIN`/`PASSWORD NULL` quarantine;
    topology reconciliation and activation occur after the authentication
    horizon and are followed by the exact full-catalog verification. An
    activation failure leaves the intentional `NOLOGIN`/null-password
    quarantine without partial topology authority, and a clean rerun
    reconverges to the exact active topology.
12. The launcher originally bypassed the existing Windows tree supervisor.
    It now composes the reviewed supervisor with the child controller and
    fails closed if launch construction or checked tree termination fails.
13. Early registration discovery counted only a subset of the proof suite and
    accepted skipped/qualified/dynamic declarations. The closed AST inventory
    now proves all `24 + 23 + 12 + 86 = 145` declarations are runnable exactly
    once across the ten lanes.
14. Exact duplicate catalog rows, gapped ordinals, and a NULL sentinel beside
    populated ACL entries could be erased during `Map` normalization. Focused
    RED tests failed for a duplicate bootstrap column row and verifier ordinal
    drift; both independent adapters now reject all nine rowset adversaries in
    current and foundation paths for their exact failure reason.
15. The standalone unknown-schema test used a malformed `pg_database` source
    row and did not prove closed-world rejection. It now injects valid
    `pg_namespace` and `pg_class` extras, while both exact-current adapters pin
    the same reviewed manifest fingerprint.
16. The writer CLI previously reported a hard-coded catalog proof it had not
    executed. The false claim was removed; the shipped CLI now reports only
    `runtime:5:delegated:1:static-pass`.


No production guard was weakened to make a stale fixture pass.

## Final Docker-free GREEN evidence

| Gate | Result |
|---|---:|
| Exact ten-lane database role command | 145/145 passed, exit 0, 61.3 s |
| Launcher registration/supervision contract | 9/9 passed, exit 0, 62.8 s |
| Shared child-tree controller suites | 9/9 passed |
| Shared manifest | 24/24 passed |
| Bootstrap capability adapter | 23/23 passed, exit 0, 116.4 s serial |
| Standalone capability verifier | 12/12 passed, exit 0, 42.3 s |
| Database role-boundary suite | 86/86 passed |
| Bootstrap/transaction Vitest | 72/72 passed |
| Least-privilege static | 12/12 passed |
| Mail 0064/0066/0067/0068 role contracts | 57/57 passed |
| Mail 0069 role contract | 5/5 passed |
| Writer inventory tests + complete scan | 29/29; `runtime:5:delegated:1:static-pass` |
| Migration ledger | 24/24 plus registration sentinel |
| Mail 0068 registration | 10/10 plus registration sentinel |
| Mail 0069 registration | 13/13 plus 0069 and backup-CI sentinels |
| Provider-correlation 0066 / durable-replay 0067 registration | both sentinels passed |
| Restore role-boundary registration | 45/45 passed |
| 0069 release/rollback | 13/13 passed |
| Authenticated runtime database wiring | 4/4 passed |
| Restored-backup authority/core | 61/61 passed |
| Restore compose/source contract | passed |
| Typecheck | exit 0, 4.0 s |
| Lint | exit 0, no warnings/errors, 22.4 s |
| Production build | exit 0, 31.9 s |
| Working diff check | exit 0 |

All commands were bounded. One earlier oversubscribed bare `npm test` run
produced 4,980 passes, one embedded-launcher failure, and 11 skips under
resource contention; it is not a valid or counted green result. A subsequent
`maxWorkers=2` attempt was invalid/timed out and is also uncounted. The
official sequence runs the standalone launcher first and then coverage with
`--maxWorkers=2`. The authoritative current-byte launcher run above passed all
145 tests; its heavy lane passed in 60.0 seconds within the reviewed 90-second
bound. No stalled or unknown result is counted as green.

## Scope

The change contains:

- the manifest, strict declaration, tests, physical-column provenance,
  bootstrap adapter, standalone verifier, and integration-only,
  policy-derived catalog fixture;
- integration into bootstrap, role verification, authenticated runtime,
  restored-backup checks, disposable integration adapters, and tests;
- Docker image copy and Compose/restore wiring required so shipped and recovery
  consumers can import the same policy and verifier;
- exact static, CI, launcher, migration-ledger, mail-role, restore, and
  rollback contract updates required by the new closed-world catalog queries;
  and
- bounded launcher and writer-inventory reliability corrections found by the
  final Task 2 gates.

Ignored implementation artifacts under `.superpowers/sdd/patches/` are not
part of the candidate and must not be staged.

## Limitations and later dependencies

- No live PG17/PG18 catalog or migration run was performed because Docker must
  remain off and the installed Windows PostgreSQL service/port 5432 must not
  be touched. Static inventory and mock catalog evidence do not replace later
  disposable-cluster gates.
- `0070` and `0071` remain deliberately unavailable. Task 2 does not register
  their migrations or grant their future authority.
- The 76 routine signatures and the physical-column provenance are checked-in
  static-replay artifacts. The column artifact has pinned semantic and
  source-file digests, but neither artifact independently re-derives live
  PostgreSQL 17/18 catalog truth.
- Positive mock catalogs, including
  `scripts/lib/database-runtime-capability-test-fixture.mjs`, are generated
  from the same policy they exercise. They prove query normalization, exact
  comparison, wiring, and hostile-mutation rejection, but are not an
  independent live-catalog oracle.
- The dedicated identity split, replacement routines, additive `0070`
  authority, and `0071` legacy-ACL contraction remain Tasks 3-5.
- Gmail, NUC, Cloudflare, Drive, reboot, accessibility-device, and power-cut
  evidence requires real credentials, services, or hardware and is not
  claimed here.

## Safety attestation

No Task 2 command started, stopped, inspected through, or connected to Docker.
No command connected to, started, stopped, reconfigured, or probed the Windows
PostgreSQL service or port 5432. All executed gates were source-only,
mock-backed, TypeScript/Node, Git, or static validation.

## Independent review

Final current-byte specification and security reviews approved the candidate
with no corroborated Task 2 blockers. They verified the independent
closed-world observers, exact manifest/ledger binding, authentication
quarantine and activation ordering, OID/name and membership authority,
complete ACL rowsets, secret redaction, bounded child environments, and
Windows tree supervision.

Final scope review approved exactly 55 implementation paths and confirmed the
restore harness contains only the required identity changes. The evidence
reviewer's requested corrections are incorporated in this report. Final
staging must still contain exactly those 55 paths plus this report, with no
ignored patch/candidate/helper artifact.

Review approval does not convert deferred live PG17/PG18, external service,
hardware, or broad P3-2 privilege-narrowing work into completed evidence.
