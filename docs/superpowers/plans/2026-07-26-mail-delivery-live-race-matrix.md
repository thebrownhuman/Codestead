# Mail Delivery Live Race Matrix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove, on disposable PostgreSQL 17 and PostgreSQL 18, that Codestead's final mail-delivery authority permits at most one authoritative provider attempt, preserves exact-byte and durable-correlation evidence across uncertainty, and serializes claim, reclaim, sweep, reconciliation, retention, and account deletion in both lock orders.

**Architecture:** Keep one deterministic Vitest integration suite over the real PostgreSQL store and real account-deletion/retention services, with a small reusable harness for query barriers, phase-aware commit faults, exact provider-call recording, and redacted evidence. Use real role-separated disposable databases and real migrations; replace only Gmail HTTP with an in-process recorder. Run the same case inventory sequentially on the pinned PostgreSQL 17 and PostgreSQL 18 images and bind the evidence to the exact Git tree.

**Tech Stack:** TypeScript, Vitest, `pg`, Drizzle migrations, PostgreSQL advisory locks/CAS/xid8, Node.js 22.23.1, Docker-based disposable integration harness.

## Global Constraints

- This plan may be prepared while Task 5 is active, but its source implementation starts only after Tasks 5 through 8 expose their final database and runtime contracts.
- Do not edit `drizzle/0067_mail_outbox_durable_replay_authority.sql`, any Task 5 producer, or any Task 5 role/CI file from this lane.
- Task 5 identity states remain exactly `event-v1-native`, `event-v1-source-map`, `legacy-key-source-one-shot-v1`, `legacy-key-terminal-cas-v1`, `legacy-key-protocol-retired-v1`, `legacy-key-fresh-action-v1`, and `legacy-key-blocked-v1`.
- `delivery_hold_version = 'task7-v1'` is permanent. Tests must create the Task 7 append-only release receipt through the reviewed authority path; they must never clear, rewrite, or bypass the hold.
- The provider transport is fake, but PostgreSQL, migrations, roles, transactions, advisory locks, CAS predicates, deletion, redaction, sweeper, finalizer, and reconciler are real.
- Never claim that this matrix proves live Gmail OAuth, Gmail delivery, NUC, Cloudflare, Drive, reboot, or power-loss behavior.
- Use the worker credential for claim/TX1/TX2/sweep, the reconciler credential for Gmail reconciliation, the ops credential for retention/deletion operations, and the owner/migrator credential only for fixture setup and catalog assertions.
- No sleeps are synchronization. Coordinate through explicit deferred gates, query hooks, backend PIDs, `pg_locks`, and bounded polling.
- Every wait is bounded. A timeout fails the case and releases every gate in `finally`.
- Every fault changes one variable only and has a scripted cleanup path under 30 seconds.
- PG17 and PG18 runs are sequential because the repository allows only one heavy database integration lane at a time.
- No test output or evidence contains email addresses, message bytes, URLs, tokens, secrets, tombstone keys, provider bodies, or raw database URLs.
- Production-primary PostgreSQL 17 must run before PostgreSQL 18.

---

## Current Evidence and Gaps

The current `integration/mail-delivery-races.integration.test.ts` already proves these real-PostgreSQL behaviors against the pre-Task-7 API:

- stale claim-candidate CAS revalidation;
- same-scope pending claimant competition;
- same-scope expired pre-provider reclaimer competition;
- null-lease and unresolved-quarantine scope blocking;
- TX1 rollback-before-commit and TX1 commit-acknowledgement loss;
- finalizer-before-sweeper and sweeper-before-finalizer;
- deletion blocked by unresolved provider state;
- deletion after definite rejection;
- provider-boundary-before-deletion and deletion-before-provider-boundary.

The reference-only commit `6f97c79e008727fcd19710c44cba6512ae7fa89c` adds useful runtime-pool and prepared-envelope adaptations, but its tree must not be applied. The preserved Task 7 tests add three important unit-level contracts:

- one TX2 connection and advisory lock survive through provider settlement and COMMIT acknowledgement;
- commit uncertainty waits for client end, terminal `xid8`, and reacquisition of the same advisory barrier;
- public/unissued sent finalization and tampered authority are rejected before a write.

The unapplied artifact `.superpowers/sdd/patches/t5-account-deleted-one-shot-races-red.patch` contributes five required account-deletion cases:

- two same-request finalizers;
- two distinct-request finalizers;
- rollback before the deletion final commit acknowledgement;
- deletion final-commit acknowledgement loss;
- no repair/re-enqueue after retention purges a terminal deletion notice.

The live matrix still needs:

- final Task 5 hold/release and blocked-row behavior;
- different-scope progress to prove locking is not global;
- actual guarded exact-byte provider invocation under a real TX2;
- TX2 rollback/commit-ack uncertainty with an exact provider-call count;
- reconciler/late-worker ordering;
- final Task 6 redaction ordering;
- Task 7 pool-capacity and timeout adoption;
- sequential PG17/PG18 registration and candidate-bound evidence.

## Dependency Gate

Implementation begins only when all of these interfaces are present and reviewed:

1. Task 5: final `0067` replay identity schema, exact state taxonomy, immutable conflict digest, and no direct hold bypass.
2. Task 6: final `0068` quarantined-row redaction routine and exact eligibility predicate.
3. Task 7: `beginProviderCall`, `dispatchAfterProviderBoundary`, `finishGuardedDispatchUnknown`, `finishAfterProvider`, `quarantineAbandoned`, guarded prepared-dispatch brands, hard-watchdog interface, dedicated pool inspection, and append-only delivery-release authority.
4. Task 8: final worker/reconciler/ops roles, migration tail, restore verifier, rollback contract, package/CI registration conventions, and reviewed migration ledger.

If a final name differs, adapt the imports once at the start of Task 1. Do not retain compatibility aliases merely for this test plan.

## File Ownership

- Create `integration/helpers/mail-delivery-race-harness.ts`: synchronization, instrumented pools, phase-aware faults, provider recorder, state projections, and evidence case IDs.
- Modify `integration/mail-delivery-races.integration.test.ts`: scenario setup and assertions only.
- Create `scripts/run-mail-delivery-race-matrix.ts`: sequential PG17/PG18 runner and evidence aggregation.
- Create `infra/tests/mail-delivery-race-matrix-registration.test.mjs`: exact package/CI/case-inventory registration contract.
- Modify `package.json`: focused registration and PG17/PG18/matrix commands.
- Modify `.github/workflows/ci.yml`: sequential focused PG17 then PG18 matrix steps in `postgres-integration`.
- Modify `infra/tests/backup-ci-registration.test.mjs`: project the exact new commands without weakening existing order guards.
- Create `docs/evidence/mail-delivery-race-matrix.schema.json`: strict, PII-free evidence schema.
- Update `CONTINUATION.md` and `SESSION_STATE.md` only after both majors pass on the frozen candidate.

No Task 5 source or migration file is owned by this lane.

## Mandatory Matrix

| ID | Interleaving or fault | Required final invariant |
| --- | --- | --- |
| CLAIM-01 | selected pending candidate changes before CAS | stale claimant returns `null`; winner's fence is unchanged |
| CLAIM-02 | two pending claimers, same account scope | one claim; one `null`; one active lease; one attempt increment |
| CLAIM-03 | two expired pre-provider reclaimers, same scope | one reclaimer; one generation increment; no second active row |
| CLAIM-04 | two pending claimers, different scopes | both claim without waiting on one another's advisory key |
| CLAIM-05 | earlier unresolved/quarantined sibling in same scope | later sibling stays pending and provider is not invoked |
| CLAIM-06 | Task 5 blocked row and Task 7 unreleased row | neither can claim; direct hold mutation is rejected |
| TX1-01 | authority revoked after claim, before TX1 | suppression/loss; zero provider calls |
| TX1-02 | TX1 rolls back before commit acknowledgement | no durable arm; zero provider calls; exact claim may retry TX1 |
| TX1-03 | TX1 commits and acknowledgement is lost | durable arm remains; zero provider calls; no permit reconstruction or TX1 replay |
| TX2-01 | provider promise paused after final live fence | one TX2 client holds the exact scope lock and source/outbox locks; deletion and sweep wait or skip |
| TX2-02 | provider accepts and TX2 commits | one exact-byte call; one provider ID; exact terminal receipt; no retry |
| TX2-03 | provider definitely rejects and TX2 commits | one call; terminal failed state; deletion can subsequently proceed |
| TX2-04 | provider result is ambiguous or times out | one call; unresolved/quarantined state; no automatic resend |
| TX2-05 | provider accepts, TX2 rolls back before commit acknowledgement | one call; TX1 arm survives; only branded/database reconciliation may settle |
| TX2-06 | provider accepts, TX2 commits, acknowledgement is lost | one call; destroy client; terminal xid8 and advisory cleanup barrier observed; one-shot uncertainty settlement |
| TX2-07 | tampered envelope, digest, correlation, identity, or public sent result | reject before provider invocation or write; zero forged terminalization |
| SWEEP-01 | terminal finalizer/reconciler gets scope lock first | sweeper changes zero rows; exact terminal result wins |
| SWEEP-02 | sweeper gets scope lock first | successor quarantine fence is preserved; late result cannot rewrite unrelated evidence |
| SWEEP-03 | two reconcilers race the same quarantined row | one applies; the other reports already-applied/lost; no provider send |
| SWEEP-04 | reconciler and late worker provide conflicting provider IDs | existing durable identity wins; conflicting identity never overwrites it |
| DEL-01 | TX2 gets account lock before deletion | provider call and terminal commit finish before deletion; deletion then revalidates and commits once |
| DEL-02 | deletion gets account lock before TX2 | deletion commits; TX2 revalidation fails; zero old-message provider calls; one capability-bound deletion notice |
| DEL-03 | unresolved quarantined provider state exists | deletion fails before physical erasure with `PROVIDER_OPERATION_IN_PROGRESS` |
| DEL-04 | same deletion request finalizes twice | one tombstone, one lifecycle success, one outbox operation, one identity-authority row |
| DEL-05 | distinct deletion requests finalize together | one success; one bounded failed lifecycle run; one notice |
| DEL-06 | deletion final transaction rolls back | no tombstone/notice/authority leak; exact retry commits one notice |
| DEL-07 | deletion final commit succeeds but acknowledgement is lost | exact retry replays the committed tombstone; no new notice |
| DEL-08 | terminal deletion notice is later purged by retention | replay returns tombstone report and never repairs or resends the purged row |
| RET-01 | redactor obtains scope/fence before late finalizer | PII remains redacted; late result cannot restore or send payload |
| RET-02 | finalizer obtains scope/fence before redactor | exact terminal evidence persists; later redaction removes only the authorized PII fields |
| CAP-01 | maximum configured parallel sends plus scheduler/maintenance/reconciler pressure | pool remains within `concurrency + 2` locally and declared server reserve; every wait ends within policy |

## Task 1: Freeze the Final Runtime Contract and Harness Boundary

**Files:**

- Create: `integration/helpers/mail-delivery-race-harness.ts`
- Modify: `integration/mail-delivery-races.integration.test.ts`
- Test: `integration/mail-delivery-races.integration.test.ts`

**Interfaces:**

- Consumes: final Task 5 identity/release rows, final Task 6 redaction routine, final Task 7 store/watchdog contracts, and final Task 8 role URLs.
- Produces: `RaceBarrier`, `QueryPause`, `Rendezvous`, `InstrumentedOutboxPool`, `PhaseCommitFault`, `RecordingGmailTransport`, `waitForAdvisoryWaiters`, `readMailRaceState`, and `recordRacePass`.

- [ ] **Step 1: Write an import/contract test that fails until the final APIs are present**

Add a top-level `describe("mail race contract prerequisites", ...)` that asserts:

```ts
expect(typeof store.claimNext).toBe("function");
expect(typeof store.beginProviderCall).toBe("function");
expect(typeof store.dispatchAfterProviderBoundary).toBe("function");
expect(typeof store.finishGuardedDispatchUnknown).toBe("function");
expect(typeof store.finishAfterProvider).toBe("function");
expect(typeof store.quarantineAbandoned).toBe("function");
expect(runtimePlan.pool.maximumConnections).toBe(
  runtimePlan.dispatch.concurrency
    + runtimePlan.pool.localReserves.totalConnections,
);
expect(runtimePlan.pool.localReserves.totalConnections).toBe(2);
```

Also query `information_schema.columns` and the Task 7 release relation/routine. Assert that the permanent hold exists, no ordinary worker role can update it, and no claim is possible without a valid append-only release receipt.

- [ ] **Step 2: Run the focused test and verify it is red on an incomplete composition**

Run:

```powershell
npm.cmd run test:integration -- integration/mail-delivery-races.integration.test.ts
```

Expected before Tasks 5 through 8 finish: a bounded prerequisite failure naming the missing final interface or relation. It must not start a provider call.

- [ ] **Step 3: Extract deterministic harness code without changing behavior**

Move the existing `deferred`, `within`, `QueryPause`, `Rendezvous`, `InstrumentedClient`, `InstrumentedPool`, and advisory-wait inspection into the helper file. Replace the current unqualified commit fault with a phase-aware fault:

```ts
export type TransactionPhase =
  | "claim"
  | "tx1"
  | "tx2"
  | "reconciliation"
  | "deletion-final"
  | "retention";

export type PhaseCommitFault = Readonly<{
  phase: TransactionPhase;
  effect: "rollback-before-ack" | "commit-ack-lost";
}>;

type ClientPhaseState = {
  phase: TransactionPhase | null;
  faultConsumed: boolean;
};
```

Classify a phase only after observing its unique reviewed statement:

```ts
if (sql.includes("provider_call_started") && sql.includes("dispatch_binding_sha256")) {
  state.phase = "tx1";
}
if (sql.includes("pg_current_xact_id()") || sql.includes("pg_current_xact_id_if_assigned()")) {
  state.phase = "tx2";
}
if (sql.startsWith("insert into public.account_deletion_tombstone")
  || sql.startsWith("insert into account_deletion_tombstone")) {
  state.phase = "deletion-final";
}
```

On `COMMIT`, consume the fault only when `state.phase === fault.phase`. Preserve the existing semantics: rollback then throw for `rollback-before-ack`; commit then throw for `commit-ack-lost`.

- [ ] **Step 4: Add a safe exact provider recorder**

The recorder distinguishes OAuth and Gmail send calls, records only digests/IDs in evidence, and exposes gates for deterministic interleavings:

```ts
export type RecordedProviderCall = Readonly<{
  operationId: string;
  messageId: string;
  requestSha256: string;
  requestLength: number;
}>;

export class RecordingGmailTransport {
  readonly entered = deferred();
  readonly release = deferred();
  readonly calls: RecordedProviderCall[] = [];

  constructor(
    private readonly outcome:
      | { kind: "accepted"; providerMessageId: string }
      | { kind: "definitely-rejected"; code: string }
      | { kind: "ambiguous"; code: string },
  ) {}

  fetch = async (url: string | URL | Request, init?: RequestInit) => {
    const target = String(url);
    if (target === "https://oauth2.googleapis.com/token") {
      return new Response('{"access_token":"fixture-access"}', { status: 200 });
    }
    if (target !== "https://gmail.googleapis.com/gmail/v1/users/me/messages/send") {
      throw new Error("Unexpected provider endpoint.");
    }
    const bytes = Buffer.from(String(init?.body ?? ""), "utf8");
    this.calls.push(Object.freeze({
      operationId: "resolved-from-issued-test-envelope",
      messageId: "resolved-from-issued-test-envelope",
      requestSha256: createHash("sha256").update(bytes).digest("hex"),
      requestLength: bytes.length,
    }));
    this.entered.resolve();
    await this.release.promise;
    if (this.outcome.kind === "accepted") {
      return new Response(
        JSON.stringify({ id: this.outcome.providerMessageId }),
        { status: 200 },
      );
    }
    if (this.outcome.kind === "definitely-rejected") {
      return new Response(
        JSON.stringify({ error: { code: 400, status: this.outcome.code } }),
        { status: 400 },
      );
    }
    throw new TypeError(this.outcome.code);
  };
}
```

Resolve `operationId` and `messageId` from the module-issued envelope through a test-only safe projection; do not parse or log the raw RFC message.

- [ ] **Step 5: Run the existing race cases after extraction**

Run the PG17 focused command. Expected: every pre-existing case passes with unchanged assertions. Then run `npm run typecheck` and targeted ESLint for the two files.

- [ ] **Step 6: Commit the harness extraction**

```bash
git add integration/helpers/mail-delivery-race-harness.ts integration/mail-delivery-races.integration.test.ts
git commit -m "test(mail): extract deterministic live race harness"
```

## Task 2: Claim, Reclaim, Hold, and TX1 Matrix

**Files:**

- Modify: `integration/mail-delivery-races.integration.test.ts`
- Test: `integration/mail-delivery-races.integration.test.ts`

**Interfaces:**

- Consumes: `InstrumentedOutboxPool`, final Task 5 identity/release helpers, and final Task 7 `claimNext`/`beginProviderCall`.
- Produces: passing cases CLAIM-01 through CLAIM-06 and TX1-01 through TX1-03.

- [ ] **Step 1: Adapt fixtures to final Task 5 and Task 7 authority**

Create rows through a helper that inserts:

```ts
type RaceIdentityFixture = Readonly<{
  authorityVersion: "event-v1-native" | "event-v1-source-map" | "legacy-key-blocked-v1";
  release: "released" | "held";
  scope: string;
}>;
```

For a released row, invoke the reviewed Task 7 release routine with the exact outbox ID, operation ID, identity authority digest, payload/conflict digest, and release version. For a held row, do not create that receipt. Never update `delivery_hold_version`.

- [ ] **Step 2: Preserve CLAIM-01, CLAIM-02, CLAIM-03, and CLAIM-05**

Keep the existing stale-CAS, same-scope pending, same-scope expired, null-lease, and unresolved-quarantine tests. Strengthen final projections to assert:

```ts
expect(state.providerCallCount).toBe(0);
expect(state.activeScopeCount).toBeLessThanOrEqual(1);
expect(state.identityAuthorityVersion).toBe(expectedIdentityState);
expect(state.deliveryHoldVersion).toBe("task7-v1");
expect(state.releaseReceiptCount).toBe(expectedReleaseReceiptCount);
```

- [ ] **Step 3: Add CLAIM-04 different-scope progress**

Pause the first account's claimant after it obtains its advisory lock. Start the second account's claimant and require it to finish before releasing the first gate. Assert two distinct signed advisory keys, two claims, and no waiter relationship in `pg_locks`.

- [ ] **Step 4: Add CLAIM-06 held and blocked rows**

Seed one `event-v1-native` row with no release receipt and one `legacy-key-blocked-v1` row. Assert both return `null` from `claimNext`. Attempt the direct hold update as the worker role and require SQLSTATE `42501` or the reviewed trigger constraint. Assert no provider call and no row mutation.

- [ ] **Step 5: Add TX1-01 authority revocation**

Claim and materialize a real revocable account template. Revoke its source authority in a separate committed transaction before TX1. Call `beginProviderCall` and assert `suppressed` or `lost` according to the final contract, a bounded non-sensitive code, zero provider calls, and no committed provider-start tuple.

- [ ] **Step 6: Adapt TX1-02 and TX1-03 to phase-aware commit faults**

For TX1 rollback, assert the exact claim can attempt TX1 again because no arm committed. For TX1 acknowledgement loss, assert the durable tuple exists, the same TX1 call cannot reconstruct a permit, claim/reclaim is blocked, and the provider recorder remains empty.

- [ ] **Step 7: Run the focused PG17 suite**

Expected case IDs:

```text
CLAIM-01 CLAIM-02 CLAIM-03 CLAIM-04 CLAIM-05 CLAIM-06
TX1-01 TX1-02 TX1-03
```

Every ID must pass once and only once.

- [ ] **Step 8: Commit the pre-provider matrix**

```bash
git add integration/mail-delivery-races.integration.test.ts
git commit -m "test(mail): prove claim and TX1 races on PostgreSQL"
```

## Task 3: Guarded Exact-Byte TX2 and Pool Matrix

**Files:**

- Modify: `integration/mail-delivery-races.integration.test.ts`
- Test: `integration/mail-delivery-races.integration.test.ts`
- Test: `src/lib/notifications/__tests__/guarded-outbox-dispatch.test.ts`

**Interfaces:**

- Consumes: final Task 7 guarded dispatch, prepared envelope, runtime inspection, watchdog, and uncertainty capability.
- Produces: TX2-01 through TX2-07 and CAP-01.

- [ ] **Step 1: Write TX2-01 as a real PostgreSQL lock-retention test**

Start a guarded dispatch and pause the Gmail recorder after synchronous request initiation. Using the TX2 backend PID:

```sql
select count(*)::int
from pg_locks
where pid = $1
  and granted
  and locktype in ('advisory', 'relation', 'tuple', 'transactionid');
```

Start deletion and sweeper contenders. Require deletion to appear as an advisory waiter and the nonblocking sweeper to report zero. Assert the TX2 client has not released and no terminal row is visible before the provider gate opens.

- [ ] **Step 2: Add TX2-02 exact accepted send**

Before opening the provider gate, compare the recorder's SHA-256 and length to the committed Task 4/Task 7 dispatch receipt. After opening it, assert one call, one Gmail ID, exact terminal row, COMMIT acknowledgement, client release, watchdog disarm, and zero claim/retry eligibility.

- [ ] **Step 3: Add TX2-03 and TX2-04 outcome classification**

Use one definite HTTP rejection and one ambiguous transport failure. Assert exactly one physical call in each case. Definite rejection becomes terminal failed and allows deletion. Ambiguity becomes unresolved/quarantined and blocks claim, sibling scope work, and deletion.

- [ ] **Step 4: Add TX2-05 known rollback after provider acceptance**

Arm a `PhaseCommitFault` for `tx2/rollback-before-ack`. The provider recorder returns an accepted ID. Assert:

```ts
expect(recorder.calls).toHaveLength(1);
expect(await store.claimNext(nextClaim)).toBeNull();
expect(await store.beginProviderCall(originalClaim, originalBoundary)).toEqual({ kind: "lost" });
```

Settle only through the module-issued uncertainty/reconciliation capability. A second use of that capability returns `null` or `already-applied` without another provider call.

- [ ] **Step 5: Add TX2-06 commit acknowledgement loss**

Arm `tx2/commit-ack-lost`. Require the implementation to:

1. destroy the uncertain TX2 client;
2. observe its `end`;
3. query `pg_xact_status($1::xid8)` until terminal;
4. obtain the same advisory barrier on a control client;
5. issue a one-shot uncertainty capability;
6. reconcile the already-committed terminal state.

Assert one provider call, one durable provider ID, one terminal row, one successful uncertainty read, and no usable second read.

- [ ] **Step 6: Add TX2-07 tamper and public-finalization negatives**

Clone/tamper each of these separately: exact bytes digest, provider correlation, operation ID, delivery scope, identity authority digest, release receipt, and provider ID. Each subcase must fail before provider invocation or terminal write. Direct public `finishAfterProvider(... sent ...)` must throw the final bounded authority error.

- [ ] **Step 7: Add CAP-01 live capacity proof**

Use the configured `maximumParallelSends` and pause all provider recorders. Assert the mail-worker pool has exactly `concurrency + 2` capacity, the scheduler and maintenance reserves can each acquire once, and the separate reconciler reserve remains available at the declared PostgreSQL server capacity. Start one excess dispatch and assert it exits through the bounded pool-acquire policy without opening a provider request.

- [ ] **Step 8: Run focused unit tests and PG17**

Run:

```powershell
npx.cmd vitest run src/lib/notifications/__tests__/guarded-outbox-dispatch.test.ts
npm.cmd run test:integration -- integration/mail-delivery-races.integration.test.ts
```

Expected: TX2-01 through TX2-07 and CAP-01 pass; no watchdog child remains; no database client remains checked out.

- [ ] **Step 9: Commit the guarded TX2 matrix**

```bash
git add integration/mail-delivery-races.integration.test.ts src/lib/notifications/__tests__/guarded-outbox-dispatch.test.ts
git commit -m "test(mail): prove guarded exact-byte TX2 races"
```

## Task 4: Sweeper, Finalizer, and Reconciler Matrix

**Files:**

- Modify: `integration/mail-delivery-races.integration.test.ts`
- Test: `integration/mail-delivery-races.integration.test.ts`

**Interfaces:**

- Consumes: final Task 7 sweeper/reconciler and branded late-result authority.
- Produces: SWEEP-01 through SWEEP-04.

- [ ] **Step 1: Adapt both existing lock-order cases**

Replace public sent finalization with the final module-issued guarded uncertainty or Gmail reconciliation fence. In both directions, confirm the contender is truly waiting/skipping by backend PID and advisory key before releasing the winner.

- [ ] **Step 2: Add two-reconciler competition**

Seed one exact unresolved quarantined row with durable correlation/evidence. Pause both reconcilers after candidate selection, release them together, and assert one terminal transition. The other result may be `already-applied` or `lost`, but it must not issue a provider send or change the durable provider ID.

- [ ] **Step 3: Add conflicting-identity ordering**

Run two subcases:

1. late worker exact provider ID first, reconciler same ID second;
2. reconciler exact provider ID first, late worker conflicting ID second.

The equal identity is idempotent. The conflicting identity is rejected and leaves the first durable identity unchanged.

- [ ] **Step 4: Run PG17 focused cases**

Expected case IDs:

```text
SWEEP-01 SWEEP-02 SWEEP-03 SWEEP-04
```

Assert zero physical provider sends in all four cases.

- [ ] **Step 5: Commit the terminal-authority matrix**

```bash
git add integration/mail-delivery-races.integration.test.ts
git commit -m "test(mail): prove sweep and reconciliation races"
```

## Task 5: Deletion and Retention Matrix

**Files:**

- Modify: `integration/mail-delivery-races.integration.test.ts`
- Test: `integration/mail-delivery-races.integration.test.ts`

**Interfaces:**

- Consumes: final Task 5 deletion-notice identity, final Task 6 redaction, final Task 7 TX2, real `deleteLearnerAccount`, and real `runRetention`.
- Produces: DEL-01 through DEL-08 and RET-01 through RET-02.

- [ ] **Step 1: Rewrite DEL-01 around the live TX2, not TX1**

Pause the provider recorder while TX2 owns the account lock. Start deletion and prove it waits. Release the provider, require terminal commit, then require deletion to revalidate and commit. Assert the old row was sent before deletion, then removed by deletion, and exactly one capability-bound `account-deleted` row was created.

- [ ] **Step 2: Rewrite DEL-02 with deletion first**

Pause deletion after it owns the account advisory lock and before final commit. Start TX2 and prove it waits. Release deletion, then assert TX2 returns `lost`/suppressed without invoking the provider. Validate the exact tombstone/run/report/outbox-operation linkage:

```ts
expect(tombstone.report.runId).toBe(run.id);
expect(tombstone.report.deletionNotice.outboxId).toBe(notice.id);
expect(tombstone.report.deletionNotice.operationId).toBe(notice.operationId);
expect(notice.variables.deletionRunId).toBe(run.id);
expect(notice.variables.tombstoneId).toBe(tombstone.id);
expect(authority.idempotencySha256).toBe(expectedStableEventDigest);
```

- [ ] **Step 3: Preserve DEL-03 unresolved-state blocking**

Assert the failure occurs before `processFileErasures`, the learner remains active, and the unresolved provider tuple remains unchanged.

- [ ] **Step 4: Fold the five account-deletion artifact cases as DEL-04 through DEL-08**

Use the phase-aware deletion-final commit fault. Do not copy its Windows ACL changes or any unrelated transfer content. Assert exact counts for tombstone, lifecycle run, outbox operation, identity authority, and report binding in every case.

- [ ] **Step 5: Add RET-01 and RET-02**

Use a row beyond the final `0068` cutoff. Run the redactor and late terminal authority in both lock orders. Assert that redaction never removes correlation/fence/operation evidence and never allows recipient/template/variables to reappear. Finalizer-first may preserve terminal state; redactor-first must prevent any payload-dependent send.

- [ ] **Step 6: Run deletion/retention focused PG17 cases**

Expected case IDs:

```text
DEL-01 DEL-02 DEL-03 DEL-04 DEL-05 DEL-06 DEL-07 DEL-08
RET-01 RET-02
```

Also run the final `0068` live migration/redaction harness. Both must pass in the same final schema.

- [ ] **Step 7: Commit the deletion and retention matrix**

```bash
git add integration/mail-delivery-races.integration.test.ts
git commit -m "test(mail): prove deletion and retention lock orders"
```

## Task 6: PG17/PG18 Registration and Candidate-Bound Evidence

**Files:**

- Create: `scripts/run-mail-delivery-race-matrix.ts`
- Create: `infra/tests/mail-delivery-race-matrix-registration.test.mjs`
- Create: `docs/evidence/mail-delivery-race-matrix.schema.json`
- Modify: `package.json`
- Modify: `.github/workflows/ci.yml`
- Modify: `infra/tests/backup-ci-registration.test.mjs`
- Modify: `CONTINUATION.md`
- Modify: `SESSION_STATE.md`

**Interfaces:**

- Consumes: the complete mandatory case inventory and pinned images exported by `scripts/lib/disposable-postgres-container.ts`.
- Produces: sequential commands and one strict evidence document containing candidate identity, PostgreSQL versions, case IDs, and pass/fail state without payload data.

- [ ] **Step 1: Write the failing registration contract**

Require exact package commands:

```json
{
  "test:mail-delivery-races:registration": "node infra/tests/mail-delivery-race-matrix-registration.test.mjs",
  "test:mail-delivery-races:pg17": "tsx scripts/run-mail-delivery-race-matrix.ts --postgres-major 17",
  "test:mail-delivery-races:pg18": "tsx scripts/run-mail-delivery-race-matrix.ts --postgres-major 18",
  "test:mail-delivery-races": "npm run test:mail-delivery-races:pg17 && npm run test:mail-delivery-races:pg18"
}
```

The registration test must parse the matrix table from this plan or consume an exported exact case inventory and assert every ID appears once. It must reject PG18-before-PG17 order, unpinned images, skipped tests, `continue-on-error`, and parallel execution.

- [ ] **Step 2: Run the registration contract red**

Run:

```powershell
node.exe infra/tests/mail-delivery-race-matrix-registration.test.mjs
```

Expected: failure naming the first missing exact command or CI step.

- [ ] **Step 3: Implement the sequential major runner**

The runner accepts only `17` or `18`, resolves the exact pinned image constant, invokes:

```text
tsx scripts/run-integration-tests.ts integration/mail-delivery-races.integration.test.ts
```

with `INTEGRATION_POSTGRES_IMAGE` set in the child environment, and refuses an ambient evidence destination outside `dist/mail-delivery-races`. It records:

```ts
type MailRaceEvidence = Readonly<{
  schemaVersion: 1;
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

Reject a dirty candidate when producing release evidence. Local development may run tests on a dirty tree, but it must not emit an accepted release artifact.

- [ ] **Step 4: Add the strict evidence schema**

Set `additionalProperties: false` at every object level. Require the exact mandatory case enum, 64-hex commit/tree fields, PostgreSQL major/server version agreement, and no fields capable of carrying raw messages, emails, URLs, database URLs, tokens, or secrets.

- [ ] **Step 5: Register sequential CI**

In `postgres-integration`, after final migration/role registration and before the broad release gate, add:

```yaml
- run: npm run test:mail-delivery-races:registration
- run: npm run test:mail-delivery-races:pg17
- run: npm run test:mail-delivery-races:pg18
- name: Upload mail delivery race evidence
  uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4.6.2
  if: always()
  with:
    name: mail-delivery-race-evidence
    path: dist/mail-delivery-races/**
    if-no-files-found: error
    retention-days: 14
```

Keep the two runs sequential and within the job timeout. Update the meta-projection to require the same exact step set.

- [ ] **Step 6: Run registration and both majors**

Run PG17 first, then PG18. Docker must be running only for this execution step. Expected: every mandatory ID passes once on each major, evidence validates, and containers/temporary databases are removed.

- [ ] **Step 7: Run adjacent release gates**

Run:

```powershell
npm.cmd run test:mail-delivery-races:registration
npm.cmd run test:mail-durable-replay-0067:roles
npm.cmd run test:mail-retention-redaction-0068:registration
npm.cmd run typecheck
npm.cmd run lint
git diff --check
```

Use the actual final `0068` command name if Task 8 established a different reviewed name; update the plan and registration test together.

- [ ] **Step 8: Update the handoff truthfully**

Record the exact commit/tree, PG17 and PG18 server versions, case count, commands, evidence paths, and any failure. State explicitly that live Gmail and external hardware/service evidence remain unproven.

- [ ] **Step 9: Commit the registration and evidence gate**

```bash
git add scripts/run-mail-delivery-race-matrix.ts infra/tests/mail-delivery-race-matrix-registration.test.mjs docs/evidence/mail-delivery-race-matrix.schema.json package.json .github/workflows/ci.yml infra/tests/backup-ci-registration.test.mjs CONTINUATION.md SESSION_STATE.md
git commit -m "test(mail): gate live races on PostgreSQL 17 and 18"
```

## Safety and Cleanup

Before every live run:

1. Verify Docker is available and no project integration container is already running.
2. Verify free disk, RAM, CPU, and the disposable harness's loopback-only port.
3. Confirm every database URL selects `learncoding_integration`.
4. Confirm worker, reconciler, ops, and migrator URLs share host/port/database but have distinct users.
5. Confirm the provider recorder is installed before a dispatch can start.

After every case:

1. Release all deferred gates in `finally`.
2. Disarm and close the watchdog.
3. Destroy uncertain clients; normally release known-safe clients.
4. Remove temporary object-storage roots.
5. Assert the mail pool reports zero checked-out clients.

After every major:

1. Terminate remaining child processes through the disposable harness controller.
2. Remove only the exact generated container.
3. Verify no generated database listener remains.
4. Validate the evidence schema.

## Completion Gate

Task 9 is complete only when:

- all mandatory IDs pass on the final composed tree on PostgreSQL 17 and PostgreSQL 18;
- the same case inventory is registered in package scripts and CI;
- Task 5 permanent holds and append-only releases are exercised without bypass;
- one physical provider attempt is proven for every post-initiation uncertainty case;
- both lock orders pass for sweeper/finalizer, reconciler/worker, deletion/TX2, and redactor/finalizer;
- deletion one-shot lineage is exact across tombstone, lifecycle run, report, outbox operation, and identity authority;
- no evidence contains payload, recipient, URL, credential, token, or database secret;
- the handoff separates repository proof from external Gmail/NUC/Cloudflare/Drive/power evidence.

Failure of any case blocks the repository release candidate. It does not authorize weakening an assertion, skipping a PostgreSQL major, or substituting source-regex/mock evidence for the live transaction proof.
