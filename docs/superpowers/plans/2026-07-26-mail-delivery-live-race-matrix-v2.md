# Mail Delivery Live Race Matrix V2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove on disposable PostgreSQL 17 and PostgreSQL 18 that Codestead’s final mail-delivery authority permits at most one provider attempt, preserves exact replay/correlation evidence through transaction and process uncertainty, and serializes claim, reclaim, sweep, reconciliation, retention, and account deletion in every required lock order.

**Architecture:** Keep the existing pre-TX2 race suite as a baseline and add a separate guarded-TX2 suite. Both use one shared PostgreSQL race harness with dedicated controller, participant, and observer clients; exact catalog-observed gates replace timing. A launcher-owned run ID and exact role/database checks authorize destructive setup. Provider HTTP remains fake, while PostgreSQL, migrations, roles, source-authority writers, deletion, retention, sweeper, finalizer, reconciler, watchdog, and child-process failure boundaries are real.

**Tech Stack:** TypeScript, Vitest, Node.js 22.23.1, `pg`, Drizzle migrations, PostgreSQL advisory locks/CAS/xid8, Docker disposable PostgreSQL 17/18.

## Status and precedence

This V2 plan supersedes
`docs/superpowers/plans/2026-07-26-mail-delivery-live-race-matrix.md`.
The earlier plan remains preserved as audit history, but V2 controls wherever
the two differ.

This turn is design-only. Do not run Docker, PostgreSQL, services, or tests
while preparing the plan.

## Global constraints

- Do not modify `drizzle/0067_mail_outbox_durable_replay_authority.sql`, its producer inventory, its role/CI contracts, or any other Task 5-owned file.
- Implementation starts only after Tasks 5–8 freeze the final identity, retention, TX2, role, restore, and rollback interfaces.
- Task 5 row states remain exactly:
  `event-v1-native`, `event-v1-source-map`,
  `legacy-key-source-one-shot-v1`, `legacy-key-terminal-cas-v1`,
  `legacy-key-protocol-retired-v1`, `legacy-key-fresh-action-v1`, and
  `legacy-key-blocked-v1`.
- `delivery_hold_version = 'task7-v1'` is permanent provenance. Task 9 creates a Task 7 append-only release receipt through the reviewed routine and never clears, rewrites, or bypasses the hold.
- Identity/source-map coverage never authorizes delivery.
- The provider transport is fake. PostgreSQL, migrations, roles, transactions, advisory locks, row locks, CAS predicates, source revocation, deletion, redaction, sweep, finalization, reconciliation, and process death are real.
- The suite runs only through `tsx scripts/run-integration-tests.ts`. Direct `test:integration:vitest` execution must fail before connecting or truncating.
- Every role URL must parse as `postgresql:`, host `127.0.0.1`, one explicit common non-5432 port, database `learncoding_integration`, exact expected username, nonempty password, no fragment, and no unreviewed query options. Only the owner-assuming migrator URL may have `options=-c role=learncoding_owner`.
- Before destructive SQL, query and compare `current_database()`, `current_user`, `inet_server_addr()`, and `inet_server_port()` to the parsed URL.
- Use dedicated scenario pools. Do not run Task 9 through the owner-assuming global application pool.
- Each backend has a unique `application_name`:
  `codestead-mail-race:<run-id>:<case-id>:<actor>`.
- No sleep establishes ordering. Polling may yield, but only an explicit gate plus observed `pg_locks`, `pg_stat_activity`, and `pg_blocking_pids()` topology proves order.
- Every wait is bounded. Each scenario has a 40-second parent hard watchdog for containment only. Cleanup after an abort is bounded to 30 seconds.
- Each experiment injects one fault. A combined fault needs a separate case ID.
- PG17 runs first. PG18 runs second. They are never parallel.
- Test output/evidence must not contain addresses, recipient digests reversible to addresses, message bytes, URLs, tokens, tombstone keys, provider bodies, SQL values, passwords, or database URLs.
- Never claim this matrix proves live Gmail OAuth/send, NUC, Cloudflare, Drive, reboot, or AC-cut behavior.

## Dependency gate

Implementation may begin only when these reviewed interfaces exist:

1. Task 5: final 0067 seven-state replay schema, immutable replay-conflict fingerprint, exact producer coverage, permanent hold, and no hold promotion path.
2. Task 6: final 0068 redaction routine and exact quarantined-row eligibility predicate.
3. Task 7: opaque prepared-dispatch capability, durable TX1 arm, guarded TX2 that holds the aggregate authority lock through provider settlement and terminal COMMIT acknowledgement, exact-byte receipt, bounded OAuth/send deadlines, fail-stop watchdog, dedicated pool plan, one-shot uncertainty settlement, and append-only delivery-release authority.
4. Task 8: final worker/reconciler/application/ops/migrator roles, migration tail, restore verification, rollback contract, CI conventions, and reviewed ledger.

If an interface name changes before this gate freezes, update this plan and the
registration contract together. Do not add compatibility aliases for Task 9.

## File ownership

Create:

- `scripts/lib/postgres-race-harness.mjs`
- `scripts/lib/postgres-race-harness.d.mts`
- `scripts/lib/mail-delivery-race-cases.mjs`
- `scripts/lib/mail-delivery-race-cases.d.mts`
- `integration/helpers/mail-delivery-race-harness.ts`
- `integration/mail-dispatch-tx2-races.integration.test.ts`
- `integration/fixtures/mail-dispatch-race-worker.mjs`
- `scripts/run-mail-delivery-race-matrix.ts`
- `infra/tests/mail-delivery-race-matrix-registration.test.mjs`
- `docs/evidence/mail-delivery-race-matrix.schema.json`

Modify:

- `integration/mail-delivery-races.integration.test.ts`
- `src/lib/notifications/__tests__/mail-dispatch-hard-watchdog.test.ts`
- `src/lib/notifications/__tests__/gmail-reconciliation.test.ts`
- `scripts/lib/disposable-integration-runtime.ts`
- `scripts/run-integration-tests.ts`
- `scripts/__tests__/run-integration-tests-hardening-wiring.test.ts`
- `package.json`
- `.github/workflows/ci.yml`
- `infra/tests/backup-ci-registration.test.mjs`
- `CONTINUATION.md`
- `SESSION_STATE.md`

No Task 5 file is owned by this lane.

## Shared harness contract

### Launcher-owned destructive-test authority

`scripts/run-integration-tests.ts` passes a random 12-hex run ID generated for
the exact container:

```ts
type DisposableRaceAuthority = Readonly<{
  runId: string;
  port: number;
}>;
```

The minimal runtime environment adds only:

```ts
DISPOSABLE_INTEGRATION_RUN_ID: input.runId,
DISPOSABLE_INTEGRATION_PORT: String(input.port),
```

The test preflight uses this exact validator:

```ts
const RUN_ID = /^[0-9a-f]{12}$/u;

function parseRaceDatabaseUrl(
  value: string | undefined,
  expectedUser: string,
  expectedPort: number,
  allowOwnerAssumption = false,
): URL {
  if (typeof value !== "string") throw new Error("race_database_guard");
  const url = new URL(value);
  const options = [...url.searchParams.entries()];
  const expectedOptions = allowOwnerAssumption
    ? [["options", "-c role=learncoding_owner"]]
    : [];
  if (
    url.protocol !== "postgresql:"
    || url.hostname !== "127.0.0.1"
    || Number(url.port) !== expectedPort
    || expectedPort === 5432
    || url.pathname !== "/learncoding_integration"
    || url.username !== expectedUser
    || url.password.length === 0
    || url.hash !== ""
    || JSON.stringify(options) !== JSON.stringify(expectedOptions)
  ) {
    throw new Error("race_database_guard");
  }
  return url;
}
```

Before truncation, every dedicated pool proves:

```sql
select
  current_database() as database_name,
  current_user as role_name,
  inet_server_addr()::text as server_address,
  inet_server_port()::int as server_port
```

The result must equal the parsed URL. `INTEGRATION_TEST=1` alone is never
sufficient.

### Exact phase control

The shared harness exports:

```ts
export type RaceActor =
  | "controller"
  | "worker"
  | "reconciler"
  | "deletion"
  | "retention"
  | "observer";

export type TransactionPhase =
  | "claim"
  | "tx1"
  | "tx2"
  | "reconciliation"
  | "deletion-final"
  | "retention";

export type PhaseCommitFault = Readonly<{
  phase: TransactionPhase;
  backendPid: number;
  effect:
    | "rollback-before-ack"
    | "commit-ack-lost"
    | "terminal-statement-connection-loss";
}>;

export type BackendIdentity = Readonly<{
  pid: number;
  backendStart: string;
  applicationName: string;
  role: string;
}>;
```

Each scenario uses:

1. a controller session holding `pg_advisory_lock(namespace, gate)`;
2. one participant that reaches the reviewed phase and blocks on
   `pg_advisory_xact_lock(namespace, gate)`;
3. an observer that proves exact backend identities and lock topology;
4. controller release to select order.

The observer requires one exact row, not a waiter count:

```sql
select
  held.pid as blocker_pid,
  waiter.pid as waiter_pid,
  held.classid::bigint as classid,
  held.objid::bigint as objid,
  held.objsubid::int as objsubid,
  blocker.usename as blocker_role,
  blocker.application_name as blocker_application,
  waiter_activity.usename as waiter_role,
  waiter_activity.application_name as waiter_application,
  waiter.granted as waiter_granted,
  waiter_activity.wait_event_type,
  pg_catalog.pg_blocking_pids(waiter.pid) as blocking_pids
from pg_catalog.pg_locks held
join pg_catalog.pg_locks waiter
  on waiter.locktype = held.locktype
 and waiter.database is not distinct from held.database
 and waiter.classid is not distinct from held.classid
 and waiter.objid is not distinct from held.objid
 and waiter.objsubid is not distinct from held.objsubid
join pg_catalog.pg_stat_activity blocker on blocker.pid = held.pid
join pg_catalog.pg_stat_activity waiter_activity
  on waiter_activity.pid = waiter.pid
where held.pid = $1
  and waiter.pid = $2
  and held.locktype = 'advisory'
  and held.granted
  and not waiter.granted
```

Require the expected `(classid,objid,objsubid)`, roles, application names,
`wait_event_type='Lock'`, and `blocking_pids = ARRAY[blocker_pid]`.

Fault injection is armed only after this topology is proven, applies only to
the exact `backendPid` and phase, and exposes `faultConsumed`. Every case
asserts `faultConsumed === true` exactly once.

### Provider recorder

Normalize the actual `BodyInit` bytes; never call `String(body)`:

```ts
async function requestBytes(
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Uint8Array> {
  if (input instanceof Request) {
    return new Uint8Array(await input.clone().arrayBuffer());
  }
  const body = init?.body;
  if (body === undefined || body === null) return new Uint8Array();
  if (typeof body === "string") return Buffer.from(body, "utf8");
  if (body instanceof URLSearchParams) {
    return Buffer.from(body.toString(), "utf8");
  }
  if (body instanceof ArrayBuffer) return new Uint8Array(body.slice(0));
  if (ArrayBuffer.isView(body)) {
    return new Uint8Array(
      body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
    );
  }
  throw new Error("unsupported_provider_body");
}
```

Record only:

```ts
export type ProviderAttemptEvidence = Readonly<{
  operationId: string;
  requestSha256: string;
  requestLength: number;
  startedAtCode: "provider_started";
  settledAs: "accepted" | "rejected" | "ambiguous" | "unsettled";
}>;
```

The recorder has independent OAuth and Gmail gates, observes `AbortSignal`,
supports synchronous completion from an abort listener, supports late 2xx,
and supports never settling. Raw bytes are hashed then discarded.

### Mandatory durable projection

Every case compares this projection before and after its fault:

```ts
export type MailRaceProjection = Readonly<{
  status: string;
  operationId: string;
  authorityVersion: string;
  authoritySha256: string | null;
  originalPayloadSha256: string;
  matchingOutboxRows: number;
  matchingAuthorityRows: number;
  deliveryHoldVersion: "task7-v1";
  releaseReceiptCount: number;
  claimVersion: number;
  claimTokenPresent: boolean;
  claimOwnerCode: "present" | "absent";
  leaseCode: "active" | "expired" | "absent";
  providerCallStarted: boolean;
  adapter: string | null;
  dispatchBindingVersion: string | null;
  dispatchBindingSha256: string | null;
  providerCorrelationVersion: string | null;
  providerEvidenceVersion: string | null;
  providerEvidenceSha256: string | null;
  providerMessageId: string | null;
  sentAtPresent: boolean;
  quarantinedAtPresent: boolean;
  lastErrorCode: string | null;
  oauthCalls: number;
  providerCalls: number;
  requestSha256: string | null;
  requestLength: number | null;
}>;
```

No projection contains an address, URL, payload, token, or raw provider body.
Every post-initiation case requires `matchingOutboxRows === 1`,
`matchingAuthorityRows === 1`, and `providerCalls <= 1`.

### Resource registry and cleanup

Each scenario owns one `ScenarioResources` registry:

```ts
export type ScenarioResources = Readonly<{
  registerGate: (release: () => void) => void;
  registerOperation: (operation: Promise<unknown>) => void;
  registerTransaction: (rollback: () => Promise<void>) => void;
  registerClient: (
    identity: BackendIdentity,
    close: (destroy: boolean) => Promise<void>,
  ) => void;
  registerChild: (pid: number, terminate: () => Promise<void>) => void;
  cleanup: () => Promise<void>;
}>;
```

`cleanup()` always:

1. releases/rejects every gate and provider promise;
2. awaits started operations with `Promise.allSettled`;
3. rolls back open controller/participant transactions;
4. destroys commit-uncertain clients and normally releases known clients;
5. waits for or terminates child process trees;
6. restores fetch, timers, signals, environment, and temporary roots;
7. terminates only sessions matching the exact disposable database and unique scenario `application_name`;
8. proves zero tagged `pg_stat_activity` sessions, advisory locks, and waiters;
9. proves `pg_stat_database.deadlocks` did not increase;
10. closes pools with a bounded deadline.

Crash cases never call cleanup hooks inside the killed child. The parent waits
for child exit, then uses a fresh pool to sweep or reconcile.

## Exact mandatory case inventory

There are exactly 40 cases per PostgreSQL major.

### Claim and TX1

| ID | Single injected interleaving/fault | Required result |
| --- | --- | --- |
| CLAIM-01 | selected pending candidate changes before CAS | stale claimant returns `null`; winner fence unchanged |
| CLAIM-02 | two same-scope pending claimers | one claim, one `null`, one active lease, one attempt increment |
| CLAIM-03 | two same-scope expired pre-provider reclaimers | one generation increment; no second active row |
| CLAIM-04 | different-scope claimers while first holds its scope lock | second completes without waiting on first advisory key |
| CLAIM-05 | unresolved/quarantined earlier sibling | later sibling remains pending; zero provider calls |
| CLAIM-06 | blocked row and unreleased row | neither claims; direct hold mutation rejected |
| TX1-01 | source/account authority revoked after claim but before TX1 | lost/suppressed; no durable arm; zero provider calls |
| TX1-02 | TX1 rolls back before commit acknowledgement | no arm; zero calls; exact claim may retry TX1 |
| TX1-03 | TX1 commits but acknowledgement is lost | full arm survives; no capability reconstruction; zero calls |

### Guarded TX2 and deadlines

| ID | Single injected interleaving/fault | Required result |
| --- | --- | --- |
| TX2-01 | authority changes after TX1 receipt but before TX2 | TX2 revalidation loses; zero calls; arm retained for quarantine |
| TX2-02 | TX2 holds aggregate lock through accepted send and COMMIT ACK | one exact-byte call; exact provider ID; terminal sent |
| TX2-03 | provider definitely rejects inside TX2 | one call; terminal failed; later deletion may proceed |
| TX2-04 | provider returns a settled ambiguous result inside policy | one call; committed quarantined state; no resend |
| TX2-05 | provider abort never settles; fail-stop terminates worker | open TX2 rolls back; TX1 remains sending; fresh sweep quarantines |
| TX2-06 | provider accepts, then terminal UPDATE/client fails | one call; client destroyed; TX1 arm survives; reconciliation only |
| TX2-07 | provider accepts, TX2 rolls back before COMMIT ACK | one call; full TX1 tuple survives; explicit expiry/sweep if unprovable |
| TX2-08 | provider accepts, TX2 commits, acknowledgement is lost | one call; xid terminal + same barrier prove committed terminal row |
| TX2-09 | bytes/digest/correlation/identity/release/public result tampered | reject before provider/write; zero forged terminalization |
| DEADLINE-01 | OAuth deadline with late or synchronous-abort token success | zero Gmail calls; late token discarded; no TX2 |
| DEADLINE-02 | Gmail abort settles ambiguous or later resolves 2xx | one attempt; late 2xx never directly marks sent or triggers retry |

### Crash, sweep, and reconciliation

| ID | Single injected interleaving/fault | Required result |
| --- | --- | --- |
| CRASH-01 | child exits after TX1 COMMIT ACK, before send | zero calls; arm survives; fresh sweep quarantines; no permit rebuild |
| CRASH-02 | child exits after `SEND_STARTED` | at most one call; open TX2 rolls back; reconciliation only |
| CRASH-03 | child exits after `GMAIL_2XX_PARSED`, before TX2 COMMIT ACK | one call; arm survives; exact Gmail proof alone may finalize |
| SWEEP-01 | exact finalizer/reconciler owns scope lock first | sweeper changes zero rows; terminal result wins |
| SWEEP-02 | sweeper advances generation before late provider result | stale ordinary result loses; branded exact reconciliation alone may settle |
| SWEEP-03 | two reconcilers race one quarantined row | one applies; one lost/already-applied; zero sends |
| SWEEP-04 | reconciler and late worker disagree on provider ID | first durable identity remains; conflicting ID rejected |
| RECON-01 | exact lookup returns not found after rollback/crash | quarantine unchanged; zero sends |
| RECON-02 | lookup returns multiple/ambiguous matches | quarantine unchanged; zero sends |

### Deletion, retention, and capacity

| ID | Single injected interleaving/fault | Required result |
| --- | --- | --- |
| DEL-01 | TX2 owns account lock before deletion | TX2 commits terminal result; deletion waits, revalidates, then commits once |
| DEL-02 | deletion owns account lock before TX1 | deletion commits; TX1 revalidation loses; zero old-message calls; one notice |
| DEL-03 | deletion starts after durable TX1 arm exists | deletion fails before erasure with `PROVIDER_OPERATION_IN_PROGRESS` |
| DEL-04 | same deletion request finalizes twice | one lifecycle success, tombstone, notice, operation, and authority |
| DEL-05 | distinct deletion requests finalize together | one success; one bounded failed run; one tombstone and notice |
| DEL-06 | deletion final transaction rolls back | no leak; exact retry commits one notice |
| DEL-07 | deletion final commit succeeds but ACK is lost | retry replays committed tombstone; no new notice |
| DEL-08 | retention purges terminal deletion notice | replay returns report; never repairs or resends purged notice |
| RET-01 | redactor owns fence before late finalizer | PII stays redacted; late result cannot restore/send payload |
| RET-02 | finalizer owns fence before redactor | terminal evidence remains; redaction changes only authorized PII |
| CAP-01 | configured sends plus scheduler/maintenance/reconciler pressure | local pool stays `concurrency + 2`; excess work exits boundedly |

## Task 1: Harden destructive preflight and extract the shared race harness

**Files:**

- Create: `scripts/lib/postgres-race-harness.mjs`
- Create: `scripts/lib/postgres-race-harness.d.mts`
- Create: `integration/helpers/mail-delivery-race-harness.ts`
- Modify: `scripts/lib/disposable-integration-runtime.ts`
- Modify: `scripts/run-integration-tests.ts`
- Modify: `scripts/__tests__/run-integration-tests-hardening-wiring.test.ts`
- Modify: `integration/mail-delivery-races.integration.test.ts`

**Interfaces:**

- Consumes: disposable launcher role URLs and container run ID.
- Produces: validated dedicated pools, controller/participant/observer gates, exact lock evidence, phase-scoped faults, provider recorder, projections, resource registry.

- [ ] **Step 1: Write failing launcher-authority tests**

Assert the runtime environment contains exactly the generated 12-hex run ID
and port, raw Vitest lacks both, port 5432 is rejected, `localhost` is
rejected, role mismatch is rejected, and no truncate query occurs after any
failure.

- [ ] **Step 2: Run the focused hardening test red**

```powershell
npx.cmd vitest run scripts/__tests__/run-integration-tests-hardening-wiring.test.ts
```

Expected: failure naming the missing run-ID/port authority.

- [ ] **Step 3: Implement the minimal launcher authority**

Extend `buildDisposableIntegrationRuntimeEnvironment` with required `runId`
and `port` inputs and emit only the two variables specified above. Pass the
same suffix/port used by the exact disposable container.

- [ ] **Step 4: Write the shared harness tests**

Use a fake pool to prove exact URL rejection, exact backend projection,
phase/PID fault scoping, one-shot fault consumption, BodyInit byte fidelity,
resource cleanup ordering, and bounded pool close.

- [ ] **Step 5: Implement the shared harness**

Move the reusable `QueryPause`, `Rendezvous`, claim coordinator, client/pool
instrumentation, and cleanup into the shared `.mjs`; export exact types through
`.d.mts`; keep the integration helper as a thin typed adapter.

- [ ] **Step 6: Adapt baseline tests without changing outcomes**

Replace `assertDisposableDatabase`, count-only waiter checks, first-COMMIT
faults, and unbounded `pool.end()` with the new shared contracts. Put every
gate release in `finally`, including the deletion file-erasure gate.

- [ ] **Step 7: Run focused PG17 baseline and static gates**

```powershell
npm.cmd run test:integration -- integration/mail-delivery-races.integration.test.ts
npm.cmd run typecheck
npx.cmd eslint integration/mail-delivery-races.integration.test.ts integration/helpers/mail-delivery-race-harness.ts
```

Expected: pre-existing cases pass; zero tagged backends/locks remain.

- [ ] **Step 8: Commit**

```bash
git add scripts/lib/postgres-race-harness.mjs scripts/lib/postgres-race-harness.d.mts integration/helpers/mail-delivery-race-harness.ts scripts/lib/disposable-integration-runtime.ts scripts/run-integration-tests.ts scripts/__tests__/run-integration-tests-hardening-wiring.test.ts integration/mail-delivery-races.integration.test.ts
git commit -m "test(mail): harden deterministic PostgreSQL race harness"
```

## Task 2: Adapt claim/TX1 cases and permanent-hold fixtures

**Files:**

- Modify: `integration/mail-delivery-races.integration.test.ts`

**Interfaces:**

- Consumes: final Task 5 identity/hold, Task 7 release routine, shared harness.
- Produces: CLAIM-01–06 and TX1-01–03.

- [ ] **Step 1: Write final-authority fixture tests**

Fixture input is:

```ts
type RaceIdentityFixture = Readonly<{
  authorityVersion:
    | "event-v1-native"
    | "event-v1-source-map"
    | "legacy-key-blocked-v1";
  release: "released" | "held";
  scope: string;
}>;
```

Released fixtures call the reviewed Task 7 routine with exact outbox,
operation, authority, payload fingerprint, and release version. Held fixtures
omit the receipt. Neither updates `delivery_hold_version`.

- [ ] **Step 2: Run CLAIM-06 red**

Expected: incomplete composition currently claims a held/blocked row or lacks
the release routine. Provider count remains zero.

- [ ] **Step 3: Adapt CLAIM-01–06**

Use exact application names and lock coordinates. CLAIM-04 requires the second
scope to finish while the first controller gate is still closed.

- [ ] **Step 4: Adapt TX1-01–03**

TX1-03 compares the complete durable projection before and after ACK loss,
destroys the uncertain client, and proves no permit reconstruction.

- [ ] **Step 5: Run PG17 focused IDs**

Expected exactly once:

```text
CLAIM-01 CLAIM-02 CLAIM-03 CLAIM-04 CLAIM-05 CLAIM-06
TX1-01 TX1-02 TX1-03
```

- [ ] **Step 6: Commit**

```bash
git add integration/mail-delivery-races.integration.test.ts
git commit -m "test(mail): prove claim and TX1 authority races"
```

## Task 3: Implement guarded TX2 and deadline cases

**Files:**

- Create: `integration/mail-dispatch-tx2-races.integration.test.ts`
- Modify: `src/lib/notifications/__tests__/gmail-reconciliation.test.ts`

**Interfaces:**

- Consumes: final Task 7 opaque prepared dispatch, TX1/TX2, deadlines, uncertainty settlement.
- Produces: TX2-01–09 and DEADLINE-01–02.

- [ ] **Step 1: Write TX2-01 red**

Commit a real source-authority change after TX1 receipt and before TX2.
TX2 must re-read account/system/source/row fences, return lost, issue zero
provider calls, and retain the arm for quarantine.

- [ ] **Step 2: Write TX2-02/03/04**

Pause at `SEND_STARTED`; prove the same TX2 backend and aggregate advisory key
remain held through provider settlement and COMMIT ACK. Table-drive accepted,
definite rejection, and settled ambiguity with exact final states.

- [ ] **Step 3: Write TX2-05 fail-stop**

Use a provider that observes abort but never settles. The parent watchdog kills
the worker, the open TX2 rolls back, a fresh reader sees the TX1 `sending`
projection, explicit lease expiry plus sweeper produces quarantine, and no
dispatch capability is reconstructed.

- [ ] **Step 4: Write TX2-06/07/08 transaction faults**

Arm faults only after exact phase/PID gates:

- terminal statement/client loss after 2xx;
- known TX2 rollback before ACK;
- COMMIT success with ACK loss.

Each makes one provider call. Rollback/connection loss leaves the complete TX1
tuple and no provider ID. ACK loss proves xid terminal and that barrier
acquisition was blocked until uncertain-client end.

- [ ] **Step 5: Write TX2-09 tamper negatives**

Mutate one field per subcase: exact bytes SHA, request length, operation ID,
scope, authority SHA, correlation SHA, evidence SHA, release receipt, provider
ID, and public sent result. Reject before provider or terminal write.

- [ ] **Step 6: Write DEADLINE-01/02**

Use a fake monotonic clock and controlled AbortSignal. Prove timer-before-work,
over-deadline synchronous token rejection, synchronous abort-listener token
success discard, settled ambiguous Gmail abort, late Gmail 2xx discard, and
never-settled fail-stop. Do not use elapsed wall time for ordering.

- [ ] **Step 7: Run focused unit and PG17 cases**

```powershell
npx.cmd vitest run src/lib/notifications/__tests__/gmail-reconciliation.test.ts
npm.cmd run test:integration -- integration/mail-dispatch-tx2-races.integration.test.ts
```

Expected TX2-01–09 and DEADLINE-01–02 exactly once.

- [ ] **Step 8: Commit**

```bash
git add integration/mail-dispatch-tx2-races.integration.test.ts src/lib/notifications/__tests__/gmail-reconciliation.test.ts
git commit -m "test(mail): prove guarded TX2 and deadline uncertainty"
```

## Task 4: Implement child-process crash, sweep, and reconciliation cases

**Files:**

- Create: `integration/fixtures/mail-dispatch-race-worker.mjs`
- Modify: `integration/mail-dispatch-tx2-races.integration.test.ts`
- Modify: `src/lib/notifications/__tests__/mail-dispatch-hard-watchdog.test.ts`
- Modify: `src/lib/notifications/__tests__/gmail-reconciliation.test.ts`

**Interfaces:**

- Consumes: exact-schema child IPC, parent watchdog, fresh pools, sweeper, reconciler.
- Produces: CRASH-01–03, SWEEP-01–04, RECON-01–02.

- [ ] **Step 1: Define exact IPC phases**

Child messages are versioned and contain only safe IDs:

```ts
type RaceChildMessage = Readonly<{
  version: 1;
  caseId: "CRASH-01" | "CRASH-02" | "CRASH-03";
  phase: "TX1_COMMITTED" | "SEND_STARTED" | "GMAIL_2XX_PARSED";
  backendPid: number;
  claimVersion: number;
}>;
```

Reject extra fields and never send bytes, URLs, recipients, tokens, SQL, or
raw errors over IPC.

- [ ] **Step 2: Implement CRASH-01–03**

Parent waits for the exact phase, terminates the whole child tree, waits for
exit, proves advisory locks released, and uses a fresh pool. CRASH-01 records
zero sends; CRASH-02 at most one; CRASH-03 exactly one. None retries delivery.

- [ ] **Step 3: Implement SWEEP-01–04**

Prove both lock orders with exact blocker/waiter evidence. SWEEP-02 includes a
real initiated provider promise resolving after the sweeper advances claim
generation; stale ordinary finalization must lose.

- [ ] **Step 4: Implement RECON-01/02**

Exact Gmail lookup not-found and multiple/ambiguous both leave quarantine and
durable evidence unchanged. Only one exact match under the same scope barrier
may finalize.

- [ ] **Step 5: Run focused tests**

```powershell
npx.cmd vitest run src/lib/notifications/__tests__/mail-dispatch-hard-watchdog.test.ts src/lib/notifications/__tests__/gmail-reconciliation.test.ts
npm.cmd run test:integration -- integration/mail-dispatch-tx2-races.integration.test.ts
```

Expected CRASH-01–03, SWEEP-01–04, and RECON-01–02 exactly once; no child,
tagged backend, lock, timer, signal, or provider promise remains.

- [ ] **Step 6: Commit**

```bash
git add integration/fixtures/mail-dispatch-race-worker.mjs integration/mail-dispatch-tx2-races.integration.test.ts src/lib/notifications/__tests__/mail-dispatch-hard-watchdog.test.ts src/lib/notifications/__tests__/gmail-reconciliation.test.ts
git commit -m "test(mail): prove crash sweep and reconciliation races"
```

## Task 5: Implement deletion, retention, and capacity cases

**Files:**

- Modify: `integration/mail-delivery-races.integration.test.ts`
- Modify: `integration/mail-dispatch-tx2-races.integration.test.ts`

**Interfaces:**

- Consumes: final account-deletion notice authority, 0068 redaction, guarded TX2, dedicated pools.
- Produces: DEL-01–08, RET-01–02, CAP-01.

- [ ] **Step 1: Implement DEL-01**

Pause the provider while TX2 owns the account lock. Prove deletion is the
exact waiter. Release provider, require terminal COMMIT ACK, then deletion
revalidates and commits exactly one tombstone/notice/authority.

- [ ] **Step 2: Implement DEL-02 at the correct pre-TX1 boundary**

Deletion owns the account lock before TX1. Start TX1, prove it waits, commit
deletion, then TX1 revalidates and loses. Zero old-message provider calls occur
and exactly one deletion notice exists. Do not stage deletion between TX1 and
TX2.

- [ ] **Step 3: Implement DEL-03 after durable arm**

Seed a committed TX1 arm and start deletion. It must fail before
`processFileErasures` with `PROVIDER_OPERATION_IN_PROGRESS`; learner and arm
remain unchanged.

- [ ] **Step 4: Implement DEL-04–08**

Recover only the account-deletion scenarios from
`.superpowers/sdd/patches/t5-account-deleted-one-shot-races-red.patch`.
Do not apply its unrelated changes. Preserve distinct-request semantics: one
succeeded run plus one bounded failed run, not one lifecycle run.

- [ ] **Step 5: Implement RET-01/02**

Use a row beyond the final 0068 cutoff and run both lock orders. Redaction never
removes replay/correlation/fence/operation evidence and never permits payload
restoration or send.

- [ ] **Step 6: Implement CAP-01**

Pause exactly the configured parallel sends. Assert local worker pool capacity
is `concurrency + 2`, scheduler and maintenance reserves each acquire once,
the separate reconciler reserve remains available, and excess work exits
through the bounded acquire policy without starting provider I/O.

- [ ] **Step 7: Run PG17 focused cases and 0068 harness**

```powershell
npm.cmd run test:integration -- integration/mail-delivery-races.integration.test.ts integration/mail-dispatch-tx2-races.integration.test.ts
npm.cmd run test:mail-retention-redaction-0068
```

Expected DEL-01–08, RET-01–02, and CAP-01 exactly once.

- [ ] **Step 8: Commit**

```bash
git add integration/mail-delivery-races.integration.test.ts integration/mail-dispatch-tx2-races.integration.test.ts
git commit -m "test(mail): prove deletion retention and capacity races"
```

## Task 6: Register PG17/PG18 and candidate-bound evidence

**Files:**

- Create: `scripts/lib/mail-delivery-race-cases.mjs`
- Create: `scripts/lib/mail-delivery-race-cases.d.mts`
- Create: `scripts/run-mail-delivery-race-matrix.ts`
- Create: `infra/tests/mail-delivery-race-matrix-registration.test.mjs`
- Create: `docs/evidence/mail-delivery-race-matrix.schema.json`
- Modify: `package.json`
- Modify: `.github/workflows/ci.yml`
- Modify: `infra/tests/backup-ci-registration.test.mjs`
- Modify: `CONTINUATION.md`
- Modify: `SESSION_STATE.md`

**Interfaces:**

- Consumes: exact 40-case inventory, pinned PostgreSQL image exports, both integration files.
- Produces: sequential major commands and one complete, PII-free evidence document per major.

- [ ] **Step 1: Export the exact inventory**

`MANDATORY_MAIL_RACE_CASE_IDS` is a frozen 40-element array in table order.
The registration test, test helper, runner, and JSON schema all consume that
single export.

- [ ] **Step 2: Write registration tests red**

Require:

```json
{
  "test:mail-delivery-races:registration": "node infra/tests/mail-delivery-race-matrix-registration.test.mjs",
  "test:mail-delivery-races:pg17": "tsx scripts/run-mail-delivery-race-matrix.ts --postgres-major 17",
  "test:mail-delivery-races:pg18": "tsx scripts/run-mail-delivery-race-matrix.ts --postgres-major 18",
  "test:mail-delivery-races": "npm run test:mail-delivery-races:pg17 && npm run test:mail-delivery-races:pg18"
}
```

Reject missing/duplicate IDs, PG18-before-PG17, parallel execution,
`continue-on-error`, skipped tests, unpinned images, direct Vitest execution,
and JSON reporters that serialize raw Vitest errors.

- [ ] **Step 3: Implement the sequential runner**

Accept only major `17` or `18`; select only
`POSTGRES_17_INTEGRATION_IMAGE` or `POSTGRES_18_INTEGRATION_IMAGE`; invoke:

```text
tsx scripts/run-integration-tests.ts integration/mail-delivery-races.integration.test.ts integration/mail-dispatch-tx2-races.integration.test.ts
```

Successful cases append code-only NDJSON records to a launcher-provided path
under `dist/mail-delivery-races`. Do not use Vitest’s JSON reporter. The runner
rejects partial, duplicate, unknown, or out-of-order case sets.

- [ ] **Step 4: Bind evidence to this repository’s Git format**

This repository uses `sha1`. Evidence is:

```ts
type MailRaceEvidence = Readonly<{
  schemaVersion: 1;
  gitObjectFormat: "sha1";
  commit: string;
  tree: string;
  nodeVersion: "22.23.1";
  postgresMajor: 17 | 18;
  postgresServerVersion: string;
  image: string;
  migrationTail: string;
  cases: readonly Readonly<{
    id: string;
    status: "pass";
  }>[];
}>;
```

`commit` and `tree` must match `^[0-9a-f]{40}$`. Reject a dirty candidate for
release evidence. Local dirty runs may execute but cannot emit an accepted
evidence file.

- [ ] **Step 5: Add the strict JSON schema**

Use `additionalProperties: false` at every object level, exact 40-ID enum,
exact count, unique IDs, SHA-1 patterns, exact image enum, and matching
PostgreSQL major/server version. No free-form error, log, message, URL, SQL,
recipient, token, or database field exists.

- [ ] **Step 6: Register sequential CI**

In `postgres-integration`, after final migration/role registration and before
the broad release gate:

```yaml
- run: npm run test:mail-delivery-races:registration
- run: npm run test:mail-delivery-races:pg17
- run: npm run test:mail-delivery-races:pg18
- name: Upload mail delivery race evidence
  uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4.6.2
  if: success()
  with:
    name: mail-delivery-race-evidence
    path: dist/mail-delivery-races/**
    if-no-files-found: error
    retention-days: 14
```

The meta-projection requires the same exact step set and order.

- [ ] **Step 7: Run registration, PG17, then PG18**

```powershell
npm.cmd run test:mail-delivery-races:registration
npm.cmd run test:mail-delivery-races:pg17
npm.cmd run test:mail-delivery-races:pg18
```

Expected: 40/40 cases once per major, schema-valid evidence, exact container
cleanup, and no generated listener.

- [ ] **Step 8: Run adjacent release gates**

```powershell
npm.cmd run typecheck
npm.cmd run lint
npm.cmd run build
npm.cmd test
git diff --check
```

Also run the final Task 5 role gate, Task 6 registration, Task 8 restore gate,
and exact-SHA rollback gate under their frozen package command names.

- [ ] **Step 9: Update handoff truthfully and commit**

Record exact commit/tree, server versions, images, 40-case counts, commands,
and evidence paths. State explicitly that live Gmail and external
hardware/service evidence remain unproven.

```bash
git add scripts/lib/mail-delivery-race-cases.mjs scripts/lib/mail-delivery-race-cases.d.mts scripts/run-mail-delivery-race-matrix.ts infra/tests/mail-delivery-race-matrix-registration.test.mjs docs/evidence/mail-delivery-race-matrix.schema.json package.json .github/workflows/ci.yml infra/tests/backup-ci-registration.test.mjs CONTINUATION.md SESSION_STATE.md
git commit -m "test(mail): gate forty live races on PostgreSQL 17 and 18"
```

## Completion audit

Task 9 is complete only when current-state evidence proves all of the
following:

- all 40 case IDs pass exactly once on the same frozen candidate on PG17 and PG18;
- every post-initiation case proves one outbox row, one replay authority, and at most one provider attempt;
- TX1 rollback/ACK loss, terminal statement loss, TX2 rollback/ACK loss, and three child crash points have exact durable projections;
- both lock orders pass for finalizer/sweeper, deletion/provider authority, and redactor/finalizer;
- deletion-before-send is tested before TX1, while deletion after durable TX1 correctly fails closed;
- not-found, ambiguous, and conflicting Gmail reconciliation cannot rewrite quarantine;
- OAuth/Gmail deadline and late-success paths cannot start or repeat delivery outside their authority;
- exact lock coordinates, blocker/waiter identities, barrier release, xid terminal state, and deadlock invariants are recorded without sensitive data;
- every scenario proves zero leaked gates, promises, children, clients, tagged sessions, advisory locks, and waiters;
- the same exact inventory is registered in package scripts, CI, and the evidence schema;
- handoff separates repository proof from external Gmail/NUC/Cloudflare/Drive/reboot/AC-cut evidence.

Any missing case, skipped major, dirty release evidence, leaked resource,
unbounded wait, source-regex/mock substitution, or sensitive artifact blocks
Task 9 completion.
