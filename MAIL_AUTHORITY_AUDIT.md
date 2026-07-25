# Mail Delivery Authority — Read-Only Security & Release Audit

Auditor role: senior security / PostgreSQL-concurrency / reliability / release auditor.
Mode: **read-only, evidence-first.** No production code, tests, migrations, Git state, config, or
infrastructure was modified. The only artifact created is this file.

---

## 1. Executive verdict

**Recommendation: REJECT integration of the retention/0062 WIP branch, and DO NOT approve the mail
authority as a repository release candidate yet.** A clear conditional path exists (Section 12).

The release candidate (`codex/fix-mail-delivery-scope` @ `892e7c1`) contains a well-structured,
correctly fail-closed *claiming/fencing* core, but it carries:

- **One P1 functional defect that is live on the RC** — the scheduled retention job's privacy
  redaction is unconditionally rejected by the `0060` payload-immutability trigger, which both
  fails to redact recipient PII **and** wedges the entire daily retention transaction
  (cascading data-lifecycle outage). Uncaught by any running test.
- **One P1 provider-boundary TOCTOU** — the delivery-scope advisory lock is released at the
  `beginProviderCall` commit, and the physical Gmail send runs with no lock, no live DB re-check,
  and an unused `permit`; the exact payload actually sent is never bound to the authorized permit.
  This is precisely the "callback-shaped provider-dispatch guard" the brief flags as the intended,
  and still-missing, repair.
- **One P1 CI-integrity failure** — `infra/tests/backup-ci-registration.test.mjs` exits non-zero on
  this branch (reproduced), so the CI `backup-safety` job is red on every push; a clean-checkout
  exact-SHA CI proof (QA-REL-001) therefore does not currently exist.

The retention/0062 work needed to *complete* the feature lives only on the WIP branch
`codex/fix-retention-redaction-trigger`, which (a) **changed at least twice during this audit** and
is therefore a moving target, and (b) contains its own **P1-equivalent defect** (Finding 1: the
`0062` redaction can never select the canonical ambiguous-Gmail rows, so PII is retained
indefinitely and the backlog is hidden). Neither branch, in its current state, correctly implements
the unresolved-authority PII redaction the feature exists to provide.

No production-readiness claim is made. No percentages or ETAs are given. External evidence (Gmail,
NUC, Cloudflare, Drive, power-loss) remains entirely unproven (Section 14).

---

## 2. Exact audit snapshot and stability

Captured at audit start; primary re-confirmed at audit end.

### Primary repository (release candidate) — STABLE throughout
```
path   : C:\Users\Shivansh\Desktop\Projects\LearnCoding
branch : codex/fix-mail-delivery-scope  (== origin/codex/fix-mail-delivery-scope)
HEAD   : 892e7c1636702a309729c77a7a1c1bfe166df771  "fix(mail): ship reconciliation operator safely"
status : clean (no uncommitted changes) — verified at start AND end of audit
log    : 892e7c1 ship reconciliation operator safely
         9ec43e8 reconcile ambiguous Gmail deliveries
         6a0220b enforce live system authority at provider boundary
         371f8b5 require fenced outbox worker mode
         abe2a67 gate staged outbox store cutover
```

### Retention worktree — **NON-STABLE (moving target during the audit)**
```
path   : C:\tmp\codestead-wt\mail-deletion
branch : codex/fix-retention-redaction-trigger
HEAD   : a67c3a4a990e75097c1085c3cffe767ac1d858c7  "WIP: checkpoint pending retention review follow-ups" (EMPTY checkpoint)
committed substantive: 18b2366db1347d7328d1ae85d7ee285c0fae4e5d  "fix(retention): authorize fenced outbox redaction"
shared base: 9ec43e87cc786ea73c0cd4eed3e7b9638e2cde89
uncommitted: 8 modified + 2 untracked files (retention.ts, integration/role-boundary tests,
             run-integration-tests.ts, package.json, scripts/lib/disposable-integration-topology.ts[+test])
```

**Working-tree fingerprint (sha256 of `git diff` + untracked WIP file contents):**
`94b5cdec…` (T0) → `c9749233…` (T1) → `4cde024c…` (T2). The uncommitted WIP changed **at least
twice** while the audit ran. Per the brief's rule, **the uncommitted WIP audit is marked invalid as
final evidence.** All retention/0062 conclusions below are pinned to the **committed `18b2366`**
(the `a67c3a4` checkpoint shares `18b2366`'s tree). Where a WIP-only file is discussed
(`disposable-integration-topology.ts`), it is explicitly labelled WIP and cannot count as release
evidence.

### Worktree inventory (from `git worktree list --porcelain`)
30 worktrees present (auth, backup, csrf, db, exam, frontend, load, mail*, rollback, runner, retention,
plus several `test-artifacts/codex-worktrees/*`). Only the primary and `mail-deletion` are in scope.

---

## 3. Scope reviewed and paths deliberately excluded

**Reviewed (in-scope, on `892e7c1` unless noted):** `src/lib/notifications/{outbox-worker,postgres-outbox-store,mailer}.ts`;
`scripts/{process-outbox,reconcile-gmail-outbox,data-lifecycle,bootstrap-database-roles.mjs,migrate-production.mjs,run-integration-tests}.ts/.mjs`;
`scripts/database-role-boundaries.test.mjs`, `scripts/verify-database-role-boundaries.mjs`,
`scripts/__tests__/database-least-privilege.test.ts`; `src/lib/data-lifecycle/{retention,deletion,file-erasure}.ts`;
`src/lib/db/{schema,client}.ts`; `drizzle/0057…0061` + `drizzle/meta/_journal.json` (and committed `0062` on `18b2366`);
`integration/{postgres,mail-delivery-races}.integration.test.ts`; `infra/tests/{mail-delivery-scope-0059*,mail-payload-immutability-0060*,database-least-privilege*,gmail-*,release-production.test.sh,rollback-production.test.sh,backup-ci-registration.test.mjs}`;
`Dockerfile`, `compose.yaml`, `infra/docker/entrypoint.sh`, `infra/ops/{release,rollback}-production.sh`,
`.github/workflows/ci.yml`, `package.json`, `vitest.config.ts`, `vitest.integration.config.ts`;
authoritative docs (goal-objective, CONTINUATION, SESSION_STATE, data-lifecycle runbook, deployment).

**Notable existence facts on the RC:** `src/lib/notifications/types.ts` **does not exist** (types are
inlined in `outbox-worker.ts`); `scripts/lib/disposable-integration-topology.ts` and its test **do not
exist on the RC** (WIP-only, uncommitted); `drizzle/0062*` **does not exist on the RC** (only on `18b2366`);
**no `AGENTS.md`** exists anywhere in the repository (`git ls-files` empty).

**Excluded (per brief):** `node_modules/`, `.next/`, `coverage/`, `test-results/`, `test-artifacts/*`
(except frozen WIP snapshots used as evidence), `.git` object internals, unrelated worktrees, frontend/UI,
curriculum/content, runner/KVM internals, AI mentoring, rewards/exams/projects/practice (except mail writers),
general backup implementation (except restore/0062 interaction), and historical plans unrelated to mail authority.

---

## 4. Architecture / invariant map

```
enqueue (app, MAIL_ADAPTER=outbox) ──► email_outbox row  (payload columns immutable after insert, 0060)
                                              │
worker (compose: mail-worker, OUTBOX_WORKER_MODE=fenced-postgres-v1)
  process-outbox.ts → PostgresOutboxStore + processOutboxBatch
      claimNext ──(per-scope advisory lock + CAS on claim_version + sibling-active guard)──► status='sending'
        materialize (delivery-variables.ts → bearer links materialized in-memory)
        beginProviderCall ──[TXN: lock scope, revalidate authority, set provider_call_started]──► COMMIT (LOCK RELEASED)
        provider.send ───────── NO LOCK, NO DB RE-READ, permit UNUSED ──► mailer.sendEmail → fetch(Gmail)   ◄── Finding 2/3/C2
        finishAfterProvider ──[TXN: re-lock, fence match]──► sent | quarantined | failed  (nulls claim/owner/lease)
      quarantineAbandoned (sweep: status='sending', lease<now-30s) → 'quarantined' (KEEPS lease)
  reconcile-gmail-outbox.ts → finalizeGmailReconciliation (quarantined→sent, durable receipt)

data-lifecycle.ts → runRetention (lifecycle service, daily)
  TXN: session-history delete → stale-revocation expire → REDACT unresolved authority (UPDATE to_email/variables)
       → terminal email delete (excludes unresolved) → backup-eligibility           ◄── RC-1 (0060 trigger rejects REDACT → wedge)
  0062 (WIP only): SECURITY DEFINER redact_unresolved_email_outbox_authority(ops-only) + trigger carve-out ◄── Finding 1

Roles: owner(NOLOGIN)→migrator(SET ROLE); app/worker/ops LOGIN. Worker email_outbox = SELECT + INSERT(10 cols)
       + UPDATE(14 non-payload cols); no payload UPDATE, no DELETE (0061, catalog-verified).
```

**Delivery-scope keys:** account mail `a:<user_id>` (canonical user-authority advisory lock,
`user-authority-lock.ts`); system mail `s:<operation_id>` (operation-scoped lock); terminal unresolved
legacy `o:<operation_id>`.

---

## 5. Findings sorted by severity

Severity legend: P0 critical, P1 high, P2 medium, P3 low. Class: **VD**=verified defect,
**DiD**=defense-in-depth, **TG**=test/evidence gap, **EXT**=external-only blocker, **FP**=false positive.

### P1-A — `[VD]` RC retention redaction is rejected by the 0060 immutability trigger → PII never redacted **and** the entire retention job wedges
- **Files:** `src/lib/data-lifecycle/retention.ts:615-633` (redaction `UPDATE`), `:522` (BEGIN), `:672` (COMMIT), `:673-675` (`catch{ rollback; throw }`); `drizzle/0060_mail_outbox_payload_immutability.sql:9-33` (function raises `23514` on any `to_email`/`variables` change), `:36-46` (`BEFORE UPDATE OF … to_email … variables`). Trigger has **no role carve-out** on the RC.
- **Invariant violated:** E (remove expired recipient/template PII from unresolved authority while preserving reconciliation evidence) and the documented 30-day terminal-record policy.
- **Failure sequence (independently reproduced by reading source + confirming test coverage gap):**
  1. An ambiguous Gmail send (or thrown send) maps to `exit=quarantined` (`outbox-worker.ts:343-360`); `finishAfterProvider` writes `status='quarantined'`, `provider_call_started` set, `provider_message_id=NULL` (`postgres-outbox-store.ts:1433-1471`).
  2. 30+ days later `runRetention` reaches the redaction `UPDATE email_outbox SET to_email='redacted+…', variables='{}'` at `retention.ts:615`.
  3. The `0060` `BEFORE UPDATE OF to_email,variables` trigger fires and `RAISE EXCEPTION … ERRCODE '23514'`.
  4. `retention.ts:674` `rollback; throw` — the **entire** first retention transaction (session-history delete `:562-607`, redaction, terminal email delete `:641-654`, backup-eligibility `:656-665`) rolls back; the exception propagates out of `runRetention` before the object-erasure transaction (`:679`) is even reached.
  5. Because the terminal delete explicitly *excludes* unresolved-authority rows (`:645-649`), the offending row persists and re-throws every subsequent run → **permanent wedge** until code fix.
- **Evidence of reachability:** the whole feature exists because "Gmail delivery can be duplicated after an ambiguous provider result" (CONTINUATION.md:339); ambiguous → quarantined-unresolved rows are expected in normal operation. **No running test catches this:** `retention-runtime.test.ts:100` mocks `@/lib/db/client` (no real trigger); `outbox-retention-privacy.test.ts` asserts SQL *text*; the live-PG retention test `integration/postgres.integration.test.ts:1962-2059` inserts only `status:'sent'`/`'failed'` emails (never a `quarantined` row with `provider_call_started`), so the redaction `UPDATE` matches **zero rows** and the trigger never fires (verified: `git grep provider_call_started|quarantined|unresolvedEmailDeliveryAuthority|'redacted+' integration/postgres.integration.test.ts` → no matches); the dedicated `infra/tests/mail-payload-immutability-0060.integration.mjs` is **orphaned from CI** (see P2-C).
- **Impact:** (1) privacy/retention control fails — recipient email + template variables on unresolved-authority mail retained indefinitely (GDPR-relevant); (2) cascading data-lifecycle outage — chat/code/AI-ledger/session-history purge and object erasure all stop once one eligible row exists.
- **Minimal safe remediation (do not apply — audit only):** either integrate `0062` **and** route `retention.ts` redaction through the ops-only `redact_unresolved_email_outbox_authority(cutoff, batch)` (running as `learncoding_ops`) — but only after Finding 1 is fixed — or, as an interim, give the `0060` trigger a narrow redaction carve-out on the RC so the inline `UPDATE` can set `to_email`/`variables` for exactly the unresolved-authority shape.
- **Exact regression test:** real-PG integration (0057–0061 applied): insert `status='quarantined'`, `provider_call_started` set, `provider_message_id=NULL`, `adapter='gmail'`, account scope, `updated_at` 31 days old; run `runRetention({dryRun:false})`; assert it does **not** throw `23514`, that `to_email`/`variables` are redacted, and that `categories.unresolvedEmailDeliveryAuthority.transitioned>=1`. Fails on the RC today.
- **Confidence:** High. Assumption: retention runs in production (confirmed — `learncoding-retention.timer` daily, data-lifecycle runbook) and no other live-PG test exercises the redaction of an eligible row (confirmed by grep).

### P1-B — `[VD]` No live fence at the physical Gmail send; delivery-scope lock released before send; `permit` unused; sent payload not bound to permit (Findings 2 + 3 + C2)
- **Files:** `src/lib/notifications/postgres-outbox-store.ts:1155` (`beginProviderCall` opens a txn), `:1156` (`lockFenceScope(…, true)` — `pg_advisory_xact_lock`, transaction-scoped), `:1254-1286` (sets `provider_call_started`), commit at the `transaction()` helper (`~:449`) **releases the lock**; `src/lib/notifications/outbox-worker.ts:309` (`beginProviderCall`) then `:338-342` (`provider.send(materialized.message, {permit,…})` — no lock, no txn, no DB re-read); `scripts/process-outbox.ts:195-216` (provider adapter threads `permit` but never uses it); `src/lib/notifications/mailer.ts:328-334` (physical `fetch(.../messages/send)` with no `email_outbox` re-check).
- **Invariant violated:** B ("No worker may start a Gmail request after its permit is stale, quarantined, revoked, redacted, or expired"; provider boundary must hold serialization/authority through the bounded call) and C (exact payload/digest bound to the permit).
- **Failure sequence:** claim → `beginProviderCall` validates authority atomically **and commits (lock released)** → worker calls `provider.send` unlocked → OAuth (`mailer.ts:318`, ≤25 s) + send `fetch` run with no live fence. During that unlocked window another actor (account deletion acquiring the same user-authority lock; ops action) can revoke authority, yet the in-flight send still delivers. The `ProviderCallPermit` (`outbox-worker.ts:18-29`) carries **no payload/digest**; the boundary validated the *stored* `variables`, but delivery transmits *materialized* variables (`delivery-variables.ts:13-22`, e.g. bearer recovery links) never bound to the permit — so a fenced-at-boundary check does not cover what is actually sent.
- **Evidence of reachability:** `beginProviderCall` and `finishAfterProvider` each hold the lock in their own txn (`:1156`, `:1395`), but **nothing holds a lock across `provider.send`** — grep/trace confirms no `pg_advisory_xact_lock` or transaction spans the send. `integration/mail-delivery-races.integration.test.ts` exercises `beginProviderCall`-boundary races but never asserts a fence at the physical send (no such test exists).
- **Impact:** an account-scoped bearer-link email (recovery / lost-device / verification) can be delivered *after* the authorizing state was revoked or the lease expired; the "at-least-once" design tolerates duplicate sends, but here the delivered content is unbounded by any live authority check. Combined with Agent-D's E6 note (the worker claims pending rows by outbox state, not user status), a mail enqueued pre-deletion can dispatch in the deletion window.
- **Minimal safe remediation:** implement the callback-shaped provider-dispatch guard the brief describes — run the physical send inside a transaction that (a) holds the delivery-scope advisory lock, (b) re-reads `email_outbox` and re-validates the fence (`status='sending' AND provider_call_started IS NOT NULL AND lease_expires_at>now()` + full claim fence) immediately before invoking the send callback, (c) never invokes the callback if the fence is lost, (d) binds a payload digest into the permit and re-checks it, (e) preserves the existing late-result persistence/reconciliation. The ≤25 s bounded send fits comfortably under the 300 s provider lease.
- **Exact regression test:** integration test — claim + `beginProviderCall`; from a second connection expire the lease and `quarantineAbandoned`; assert the provider callback is **not** invoked / a fenced re-check returns "lost" and no network send occurs.
- **Confidence:** High (structural; corroborated by independent read of `outbox-worker.ts` and `postgres-outbox-store.ts`). Note: because the system is at-least-once by explicit design, the *duplicate-send* aspect is partly inherent; the *defect* is the total absence of any live re-validation / lock-holding / payload-binding at the send site, and the missing test.

### P1-C — `[VD]` `backup-ci-registration.test.mjs` fails on this branch → CI `backup-safety` job is red on every push
- **Files:** `infra/tests/backup-ci-registration.test.mjs:515-600` (`expectedApplicationRuns`), `:822-836` (`postgres-integration` contract), enforced `:989-996`; `.github/workflows/ci.yml:274` runs it as the first `backup-safety` step; `ci.yml:54` (actual `database-secret-ceremony` step the projection omits), `ci.yml:379,384-409` (mail-scope-0059 + PG18 steps the projection omits).
- **Invariant violated:** G (the registration test must project the *exact* current CI command list; every security test must actually run).
- **Reproduced (read-only):** `node --test infra/tests/backup-ci-registration.test.mjs` → `not ok 1 … fail 1 (exitCode 1)`. Root cause: the branch added `database-secret-ceremony` to the `application` job and the mail-scope-0059 registration + "Install PostgreSQL 18" + PG18 harness steps to `postgres-integration`, but never updated this projection, so `actual !== expected` and the guard throws. This also makes the two registration guards (`backup-ci-registration` vs `mail-delivery-scope-0059-registration.test.mjs`) mutually contradictory.
- **Impact:** no green clean-checkout CI exists at `892e7c1`; QA-REL-001 (exact-SHA clean CI evidence) cannot be satisfied. Release-blocking for candidate status.
- **Remediation:** add `node --test infra/tests/database-secret-ceremony.test.mjs` to `expectedApplicationRuns` (after `validate-static.mjs`) and extend the `postgres-integration` contract to include the mail-scope registration, the PG18 install step, and the PG18 harness run. Self-testing once fixed.
- **Confidence:** High (deterministically reproduced).

### P2-A — `[TG]` Negative role-boundary GRANT probes rely on a `42501` throw PostgreSQL does not raise for object grants (Finding 6)
- **Files:** `scripts/verify-database-role-boundaries.mjs:134-146` (`expectInsufficientPrivilege` — success ⇒ `fail()`, else requires `code==='42501'`), `:280-284` (`grant select on table <t> to <role>` probe); `scripts/database-role-boundaries.test.mjs:146-157` (mock fabricates the `42501` throw); `compose.yaml:168` (`database-boundary-verifier --require-application-objects`).
- **Invariant violated:** F (ACL boundary must be *proven* by catalog state, not assumed) — matches known finding 6.
- **Failure sequence:** for an object-privilege `GRANT` by a role lacking grant option, real PostgreSQL emits `WARNING: no privileges were granted` and the statement **succeeds** (no `42501`). So (1) against a real server the probe's `client.query(grant…)` resolves → `fail()` fires → the `database-boundary-verifier` release stage would itself break; (2) the unit test hides this because the mock throws `42501`; (3) no test runs this probe against a real server (`release-production.test.sh:449` stubs it; `database-least-privilege-integration.mjs` never calls it). Membership grants (`grant <role> to <role>`) *do* raise `42501`, so those probes are fine.
- **Impact:** false assurance — "runtime roles cannot re-grant table privileges" is not actually proven; a real `WITH GRANT OPTION` regression could pass unnoticed, and the one wiring that would exercise it for real would fail rather than pass.
- **Remediation:** replace the throw-based object-grant probe with a catalog assertion (`has_table_privilege` / `aclexplode` before/after, assert `is_grantable=false` and no new grantee); keep throw-based probes only for statements PG genuinely errors on (create role/table, set role, alter owner, membership grant).
- **Regression test:** real-PG test — as `learncoding_app`, `GRANT SELECT ON public.lesson TO learncoding_worker`, capture the notice, then assert via catalog that `learncoding_worker` gained no new/grantable privilege.
- **Confidence:** High on PG semantics; Medium on live pipeline impact (could not run `--require-application-objects` under the read-only constraint).

### P2-B — `[TG]` `scripts/database-role-boundaries.test.mjs` is orphaned from CI (Finding 7)
- **Files:** `scripts/database-role-boundaries.test.mjs` (whole file); absent from `package.json` scripts and `.github/workflows/ci.yml`.
- **Evidence:** repo-wide `grep "database-role-boundaries\.test"` → matches only the file's own internal import lines; `grep role-boundaries .github/workflows/ci.yml` → none. Independently confirmed by coordinator.
- **Impact:** the only behavioral proof of the restricted-role model (EXPLAIN INSERT/UPDATE/DELETE positive/negative probes, exact worker column allow-lists, "no payload column updatable", advisory-lock/fail-closed behavior, credential redaction) never executes.
- **Remediation:** add `"test:database-role-boundaries": "node --test scripts/database-role-boundaries.test.mjs"` and a CI step in the `application` job; mirror it into the `backup-ci-registration` projection (P1-C).
- **Confidence:** High.

### P2-C — `[TG]` `infra/tests/mail-payload-immutability-0060.integration.mjs` is orphaned from CI (Finding 8b) — the live test that would catch P1-A does not run
- **Files:** `infra/tests/mail-payload-immutability-0060.integration.mjs`; absent from `package.json`, `ci.yml`, and `validate-compose.mjs` spawns (unlike its `gmail-*` siblings).
- **Impact:** live-DB enforcement of `0060` immutability is untested in CI; its unit counterpart only inspects SQL/journal text. Directly enables P1-A to ship unnoticed.
- **Remediation:** register `test:mail-payload-immutability-0060` and run it in `postgres-integration`; extend both registration projections.
- **Confidence:** High.

### P2-D — `[VD/TG]` Integration runner (RC) leaks: DB password in `docker run` argv + full `process.env` passthrough to child processes (Finding 9, RC portion)
- **Files:** `scripts/run-integration-tests.ts:141` (`` `POSTGRES_PASSWORD=${password}` `` in `docker run` argv), `:22` (`env: options.env ?? process.env`), `:124-154` (docker + `testEnv` inherit full `process.env`).
- **Invariant violated:** G (child environments must not inherit arbitrary TOKEN/SECRET/KEY/CREDENTIAL, cloud, proxy, or alternate DB values; secrets must not leak via argv/metadata).
- **Impact:** the (ephemeral) DB password is visible via `ps`/`/proc/<pid>/cmdline`, and any ambient `AWS_*`/`*_TOKEN`/`*_SECRET`/`HTTP(S)_PROXY`/alternate `DATABASE_URL` flow into a third-party postgres image and the vitest child (exfiltration/SSRF surface on CI). Bounded by the disposable, loopback-only container, hence P2 not P1.
- **Remediation:** build the child env from a strict **allowlist** (`PATH`, `HOME`, `SystemRoot`/`TEMP`, `npm_execpath`, explicit `POSTGRES_*`/`DATABASE_*`/`NODE_ENV`), and pass the password name-only via `--env POSTGRES_PASSWORD` (WIP already does the name-only argv fix). Note: `docker inspect` still exposes the value for the container lifetime.
- **Regression test:** set `AWS_SECRET_ACCESS_KEY`/`GITHUB_TOKEN`/`HTTP_PROXY`/`DATABASE_URL` in `process.env`; assert the env handed to `spawn` for both `docker run` and vitest contains none of them and no argv element contains the raw password.
- **Confidence:** High.

### P2-E — `[TG]` Mail-worker payload-mutation-authority invariant is proven in CI only by source-regex (Finding G5)
- **Files:** `infra/tests/database-least-privilege-static.test.mjs:145-157` (regex over `bootstrap-database-roles.mjs` + `0061`); the behavioral proofs (`database-role-boundaries.test.mjs`, `mail-payload-immutability-0060.integration.mjs`) are both orphaned (P2-B, P2-C); the always-on `database-least-privilege-integration.sh` has zero `email_outbox`/worker/payload coverage.
- **Impact:** a privilege regression that preserves the SQL text shape (or drifts only at the live-DB layer) passes CI. Do not treat the regex test as proof of the authorization guarantee.
- **Remediation:** re-register the behavioral/live-DB proofs (P2-B, P2-C).
- **Confidence:** High.

### P3 findings (defense-in-depth / low)
- **P3-1 `[DiD]` Rollback allows `fenced-postgres-v1 → legacy-direct-v1` worker-mode regression** (`infra/ops/rollback-production.sh:466-472`). Fails closed against the forward-only `0060`/`0061` schema (old direct-payload runtime hits the immutability trigger / revoked privilege), but the operator may still assert `--schema-backward-compatible`. Store-cutover forward-only *is* enforced (`:473-479`) and tested; worker-mode monotonicity is not. Remediation: add a worker-mode forward-only `fatal` mirroring the store-cutover block + a rollback test case. Reachability of a real legacy-direct predecessor with complete modern evidence requires external deploy-history.
- **P3-2 `[DiD]` All three runtime roles receive uniform table-wide `SELECT/INSERT/UPDATE/DELETE`; only worker×`email_outbox` is narrowed** (`bootstrap-database-roles.mjs:713-714, 763-768, 973-984`). On the RC `learncoding_ops` retains full DML (incl. DELETE + payload) on `email_outbox`. Intentional, catalog-verified; a least-privilege smell to narrow later (corroborated by BACKEND_AUDIT.md:69).
- **P3-3 `[DiD]` Spurious `PoolShutdownTimeoutError` on a clean pool close** (`scripts/process-outbox.ts:107-110`) — after `pool.end()` wins the race, a `performance.now()>=deadline` re-check can still throw + `process.exit(1)` on an already-closed pool. Cosmetic exit status only.
- **P3-4 `[DiD]` `migrate-production.mjs:219-234` cleanup can overwrite the primary migration error** with a `RESET ROLE`/re-verify cleanup error (no resource leak; lock still released via backend destroy + `pool.end()`). Attach cleanup failure as `cause` instead of overwriting.
- **P3-5 `[DiD]` Latent PG18 harness risk** — `run-integration-tests.ts:135` mounts tmpfs at `/var/lib/postgresql/data` and cleanup uses `docker rm --force` without `--volumes`; harmless while the repo pins **PostgreSQL 17** (default PGDATA matches), but if `INTEGRATION_POSTGRES_IMAGE` is bumped to PG18 (versioned PGDATA `/var/lib/postgresql/18/docker`) the tmpfs becomes a no-op and an anonymous volume can leak. Pin `--env PGDATA=/var/lib/postgresql/data` and add `--volumes`.
- **P3-6 `[DiD/EXT]` `0061` references `learncoding_worker`** (`REVOKE … FROM learncoding_worker`) — a bootstrap that replays migrations before provisioning roles fails; roles are provisioned out-of-band, so this is an implicit ordering dependency (low/external).
- **P3-7 `[DiD]` Privilege reconciliation runs before `migrate`; `email_outbox` column grants apply only if the table pre-exists** (`bootstrap-database-roles.mjs:763-768`). A same-release schema change that first creates/extends a granted column cannot land its column grant in that release (the post-migration boundary verifier fails closed). Behaviorally safe, mail-privilege-scoped.

---

## 6. Verification of every known lead

| # | Lead | Verdict | Evidence |
|---|------|---------|----------|
| 1 | Ambiguous Gmail completion nulls lease; `0062` requires non-null expired lease → PII retained, backlog hidden | **CONFIRMED — WIP-only defect** | `postgres-outbox-store.ts:1444-1446` nulls `claim_token/owner/lease_expires_at` on quarantine; `18b2366:0062` redaction requires `lease_expires_at IS NOT NULL AND <= now()`; only `quarantineAbandoned` (`:1548-1568`) leaves lease non-null. Reporting count uses the same predicate ⇒ un-redacted state uncounted. (Independently confirmed by coordinator read of both.) |
| 2 | Abandoned rows retain expired permit; worker paused after `beginProviderCall` resumes with in-memory plaintext and no live fence at Gmail call | **CONFIRMED (RC) → P1-B** | `outbox-worker.ts:309→338`; lock released at `beginProviderCall` commit; `mailer.ts:328` send has no DB re-read; `permit` unused (`process-outbox.ts:195-216`). |
| 3 | Intended repair = callback-shaped provider-dispatch guard (lock, revalidate, hold through send, skip on fence-loss, preserve late persistence) | **CONFIRMED ABSENT → P1-B** | No lock/txn spans `provider.send`; guard does not exist; late-result persistence (C3) *is* preserved correctly. |
| 4 | Disposable integration omitted role-boundary verification around both migrations; required order bootstrap→boundary(false)→migrate→reconcile→boundary(true)→topology | **CONFIRMED gap on RC; implemented only on WIP** | RC `run-integration-tests.ts:155-163` runs migrate×2 + vitest as a single superuser `DATABASE_URL` — no bootstrap/boundary/topology. WIP `scripts/lib/disposable-integration-topology.ts:37-53` implements the exact order (but is uncommitted/moving). |
| 5 | Ordinary integration used migrator + SET ROLE owner for `runRetention` though `0062` requires `session_user=learncoding_ops` | **WIP-scoped / RC has no role separation** | RC integration uses a single superuser URL (no SET ROLE owner path at all). The `session_user=ops` requirement exists only on `18b2366:0062`. This is a WIP harness concern on a moving branch. |
| 6 | PG may accept GRANT-without-grant-option as warning/no-op; probe must prove catalog state | **CONFIRMED → P2-A** | `verify-database-role-boundaries.mjs:134-146,280-284` throw-based; mock fabricates the throw; no real-server run. |
| 7 | `database-role-boundaries.test.mjs` orphaned from CI | **CONFIRMED → P2-B** | Not in `package.json`/`ci.yml` (coordinator-verified grep). |
| 8 | `backup-ci-registration.test.mjs` has stale exact-workflow projections | **CONFIRMED and worse → P1-C** | Reproduced: test exits 1 (hard CI failure), not a silent stale pass. Missing `database-secret-ceremony` + mail-scope-0059/PG18 steps. |
| 8 (sub) | Hardcoded journal count 63 / migration-tail brittleness | **FALSE POSITIVE** | Journal has 62 entries (idx 0–61, last `0061`); all journal assertions are tag-scoped/derived (`.find(tag==='0058_…')` etc.); no `63`/length-equality assertion exists. |
| 9 | Integration runner inherits ambient secrets / exposes PG password via metadata | **CONFIRMED → P2-D** | RC: password in `docker run` argv (`:141`) + full `process.env` passthrough (`:22,124-154`). WIP adds a partial (denylist) fix. `docker inspect` residual remains. |
| 10 | PG18 default PGDATA bypasses `/var/lib/postgresql/data` tmpfs | **FALSE POSITIVE as stated** | Repo pins PostgreSQL **17** everywhere (`postgres:17-alpine@sha256:742f…`); tmpfs is effective. Latent only under a PG18 image override (P3-5). |
| 11 | Rollback stage handling / 0062 forward-only compatibility incomplete | **PARTIALLY CONFIRMED → P3-1** | Rollback ordering/allowlist/digest-binding are correct and tested; no false schema-compat claim; store-cutover forward-only enforced. Gap: worker-mode regression not blocked. `0062` is absent from the RC and referenced by no release/rollback script. |

---

## 7. Concurrency / state matrix

| Scenario | Outcome | Fails closed? | Evidence |
|---|---|---|---|
| Two claimers, same row | one wins | **Yes** | per-scope `pg_try_advisory_xact_lock` (`postgres-outbox-store.ts:1064`) + CAS `claim_version=$3` (`:1079`) + sibling-active `NOT EXISTS` (`:1103-1123`) |
| Expired-lease reclaimer vs post-boundary row | not reclaimed | **Yes** | reclaim requires `provider_call_started IS NULL` (`:1027-1033, 1094-1101`) |
| Sweeper (`quarantineAbandoned`) vs in-flight send | send still persists via fence match; no double-send | **Yes** | sweep needs `lease<now-30s` under lock (`:1535,1546`); `finishAfterProvider(sent)` still matches `status in ('sending','quarantined')` (`:1419`) |
| Finalizer (reconciliation) vs worker terminalize | second misses fence → "lost" | **Yes** | `finalizeGmailReconciliation` re-observes + re-locks (`:932-976`) |
| Two claimers vs deletion (pending row) | claim blocked by shared user-authority lock | **Yes** at claim | account lock `user-authority:<id>` shared by store + deletion |
| **Worker send vs authority revocation, after `beginProviderCall`** | **send proceeds unlocked; email may deliver post-revocation** | **NO** | **P1-B** — lock released at `beginProviderCall` commit; no live fence at `mailer.ts:328` |
| Late result of a genuinely-started send | persisted idempotently; no new send | **Yes** | `finishAfterProvider` "already-applied" (`:1487-1517`); `finalizeGmailReconciliation` authorizes no new call |
| Ambiguous → quarantined-unresolved → retention redaction (RC) | **transaction throws `23514`, all retention rolls back** | fails **wrong** (wedge) | **P1-A** — `retention.ts:615` vs `0060` trigger |
| Ambiguous → quarantined-unresolved → `0062` redaction (WIP) | row never selected (lease NULL); PII kept | fails **open (silent)** | **Finding 1** — `18b2366:0062` lease predicate |
| Partial/malformed claim fence | rejected; surfaced as claim-lost/persistence-unknown | **Yes** | `postgres-outbox-store.ts:821-822` throws on token/owner XOR; unit-level |
| Migrator + `SET ROLE owner` vs ops-only redaction (WIP) | rejected `42501` | **Yes (by construction)** | `18b2366:0062` `session_user<>'learncoding_ops'` guard + `session_user` immutable across SET ROLE (`migrate-production.mjs:214`) |

---

## 8. Missing or weak tests

- **No test** asserts a fence at the physical Gmail send (P1-B) — `mail-delivery-races.integration.test.ts` stops at the `beginProviderCall` boundary.
- **No running test** exercises retention redaction of an actual quarantined-unresolved row against real PG (P1-A) — mock-based unit test + source-string assertions + a live-PG test that inserts no eligible row.
- **`mail-payload-immutability-0060.integration.mjs` orphaned** (P2-C) — no live `0060` enforcement in CI.
- **`database-role-boundaries.test.mjs` orphaned** (P2-B) — no behavioral role-boundary coverage in CI.
- **Object-grant negative probe is behaviorally wrong and only mock-tested** (P2-A).
- **Mail-worker payload authority proven only by source-regex in CI** (P2-E).
- WIP retention redaction has no test that inserts a lease-NULL quarantined row and asserts it is redacted+counted (Finding 1).

---

## 9. CI / package registration gaps

| Test | package script? | In `ci.yml`? | Note |
|---|---|---|---|
| `scripts/database-role-boundaries.test.mjs` | **No** | **No** | orphaned (P2-B) |
| `infra/tests/mail-payload-immutability-0060.integration.mjs` | **No** | **No** | orphaned (P2-C) |
| `infra/tests/backup-ci-registration.test.mjs` | yes | yes (`backup-safety` first step) | **fails / exits 1** (P1-C) |
| `scripts/__tests__/database-least-privilege.test.ts` | yes (`test:coverage`) | yes (`ci.yml:40`) | runs |
| `src/lib/notifications/__tests__/*` | yes (`test:coverage`) | yes | runs |
| `infra/tests/mail-delivery-scope-0059-registration.test.mjs` | yes | yes (`ci.yml:379`) | runs |
| `infra/tests/mail-delivery-scope-0059.integration.mjs` | yes | yes (`ci.yml:409`, PG18) | runs |
| `integration/mail-delivery-races.integration.test.ts` | yes (`test:integration`) | yes (`ci.yml:380`) | runs |
| `infra/tests/gmail-*-config.test.mjs` | indirect (`validate-compose`) | yes (`ci.yml:106`) | fail-closed |
| `infra/tests/database-least-privilege-static.test.mjs` | — | yes (`ci.yml:55`) | regex-only for worker payload (P2-E) |

Journal-count assumption: **no brittle global count exists** (62 entries; tag-scoped assertions) — the "hardcoded 63" lead is a false positive.

---

## 10. Release / rollback compatibility verdict

- **Ordering (H1):** correct and fail-fast — `session-fence → database-role-bootstrap → database-negative-probes → migrate → platform-seed → [admin-bootstrap] → database-boundary-verifier(--require-application-objects) → pilot`. The "two bootstrap calls" is a pre-commit + post-commit `verifyInvariants` pair inside `bootstrap-database-roles.mjs` (`:1385,:1390`), plus the boundary verifier running twice (pre/post migration). `set -Eeuo pipefail` + fail-closed trap enforce order. Verified.
- **Rollback allowlist (H2):** the failed-stage `case` (`rollback-production.sh:740-748`) gates correctly and cannot be bypassed (`status.env` is root-owned, not-writable, required complete). Verified.
- **Schema-compat claims (H3):** rollback never reverses migrations and makes no false compatibility claim; store-cutover is forward-only and tested. **Gap:** worker-mode `fenced→legacy-direct` regression is not blocked (P3-1) — fails closed but is operator-assertable.
- **Image evidence (H4):** rollback starts exactly the previous completed release's recorded+verified digests (triple-checked; postgres exempt by design). Verified.
- **Release gating (H5):** gates on in-tree manifest self-consistency + root-filesystem trust; **no external SHA/branch/CI attestation is required** (`RELEASE_GIT_COMMIT` is forbidden). Repo-provable; trust boundary is host FS ownership (external).
- **Overall:** the release/rollback *mechanics* are sound, but **release readiness is not provable** because CI is red at this SHA (P1-C) and the RC carries P1-A/P1-B. `0062` is absent from the RC, so a *combined* mail+retention release candidate does not exist in stable, correct form.

---

## 11. Repository gate matrix

**Proven (repository evidence):** production runs `PostgresOutboxStore`+`processOutboxBatch` (A1); no legacy direct send path (A2); bounded OAuth/send deadlines applied (A3); shutdown drains in-flight + closes pool (A4); logs redacted (A5); claim/lease/version/operation/scope fencing fails closed (B1–B3); late-result persistence never re-sends (C3); receipt/reconciliation durability (C4); payload immutability enforced (D2); delivery-scope constraints complete, no NULL-scope stranding (D1, D3); worker minimum privilege — no payload UPDATE/DELETE (D5, F2); connection-identity assertions for bootstrap/migrator/roles (F1); direct ops login enforced (F5); resource cleanup, no leaks (F6); integration tests don't weaken prod checks (F7); release ordering/fail-fast (H1); rollback allowlist + digest binding (H2, H4); store-cutover forward-only (H3).

**Failed (verified defect on RC):** retention redaction wedged by `0060` trigger + PII not redacted (P1-A); provider-boundary TOCTOU / no live send fence / permit not payload-bound (P1-B); `backup-ci-registration` red → no green CI at SHA (P1-C).

**Unproven (test/evidence gaps):** behavioral role-boundary probes (P2-A/B), live `0060` immutability (P2-C), provider-send fence behavior (no test, P1-B), payload↔permit binding (C2), worker payload authority behaviorally (P2-E).

**External-only:** live Gmail OAuth/send/reconciliation; NUC runtime; Cloudflare tunnel/Access; Google Drive; controlled reboot / physical AC-cut / hardware.

**WIP-only (must not be integrated as-is; branch is moving):** `0062` redaction lease-predicate defect (Finding 1); WIP integration-harness role identity (Finding 5); WIP env-sanitizer denylist (Finding 9 residual); `disposable-integration-topology.ts` (correct order, but uncommitted/unstable).

---

## 12. Minimal remediation order (respecting dependencies)

1. **P1-C first** (unblocks a green CI so subsequent fixes are verifiable): update `backup-ci-registration.test.mjs` projections (`application` +`database-secret-ceremony`; `postgres-integration` +mail-scope-0059/PG18).
2. **P2-B + P2-C** (register the behavioral + live-DB tests) — these must exist *before* fixing P1-A/P1-B so the fixes are provable; add both to CI and to the (now-fixed) registration projection.
3. **P1-A** (retention redaction vs `0060`): decide the redaction authority model (RC carve-out, or integrate a *fixed* `0062` — see step 5). Add the P1-A regression test; confirm it goes red→green.
4. **P1-B** (provider-boundary guard): implement the lock-holding, live-revalidating, payload-digest-bound dispatch guard; add the paused-worker/expired-lease send-suppression integration test.
5. **Finding 1** (retention branch): fix the `0062` redaction/trigger/count predicates to accept lease-NULL rows **before** any consideration of integrating that branch; re-audit against a *stable committed* SHA (the WIP was moving during this audit).
6. **P2-A** (catalog-based GRANT probe) and **P2-D** (allowlist child env + name-only password).
7. **P3-1** (rollback worker-mode forward-only) and remaining P3 hardening.

---

## 13. Exact focused commands to verify each repair (Node 22.23.1)

```powershell
$env:Path='C:\tmp\node-v22.23.1-win-x64;' + $env:Path
```
- P1-C: `node --test infra/tests/backup-ci-registration.test.mjs`  (must exit 0)
- P2-B: `node --test scripts/database-role-boundaries.test.mjs`
- P1-A (unit/typed): `npm.cmd test -- src/lib/data-lifecycle/__tests__/retention-runtime.test.ts src/lib/notifications/__tests__/outbox-retention-redaction-migration.test.ts`
- P1-A / P2-C (live DB — gated, one heavy DB run at a time): the `mail-payload-immutability-0060` + retention-redaction integration against disposable PG17 via `scripts/run-integration-tests.ts` (only after static gate identifies it).
- P1-B: new `integration/mail-delivery-races.integration.test.ts` case asserting no send after fence loss (`npm.cmd run test:integration`).
- P2-A: `node --test infra/tests/database-least-privilege-static.test.mjs` + a new real-PG GRANT-no-op catalog assertion.
- Store/worker units: `npm.cmd test -- src/lib/notifications/__tests__/outbox-worker.test.ts src/lib/notifications/__tests__/postgres-outbox-store.test.ts scripts/__tests__/database-least-privilege.test.ts`
- `npm.cmd run typecheck`

Do not run Docker/live PostgreSQL until the static gate identifies the exact required test; never run more than one heavy DB/Docker command at once.

---

## 14. External evidence still required (unproven — must not be fabricated)

- **Real Gmail OAuth / send / reconciliation** against live Google (delivery, ambiguous-result handling, receipt durability).
- **NUC runtime** (Ubuntu 24.04, Docker Compose boot/restart/persistence, worker drain under SIGTERM).
- **Cloudflare** dedicated tunnel + Access policy reaching `app:3000`.
- **Google Drive** offsite backup/restore round-trip.
- **Reboot / supervised physical AC-cut / hardware** recovery (no UPS ⇒ last unpersisted write cannot be guaranteed).

---

## 15. Final recommendation

- **Reject integration** of the retention branch `codex/fix-retention-redaction-trigger` (Finding 1 P1-equivalent; branch was a moving target during the audit and cannot be presented as final evidence).
- **Do not approve** `codex/fix-mail-delivery-scope` @ `892e7c1` as a repository release candidate in its current state: it carries **P1-A** (retention wedge + PII non-redaction), **P1-B** (provider-boundary TOCTOU / no live send fence), and **P1-C** (red CI at SHA), plus P2 test/evidence gaps.
- **Conditional path to approval:** complete remediation steps 1–4 and 6 of Section 12, land the behavioral + live-DB regression tests (P2-B/P2-C), obtain a green clean-checkout CI at the exact integrated SHA, and — only if retention is to be shipped — integrate a **fixed** `0062` (Finding 1) re-audited from a stable commit. External NUC/Gmail/Cloudflare/Drive/power evidence remains separately required and unproven.

No production-readiness claim is made. Items marked unproven or external remain explicitly unproven.

---

### Appendix — audit method

8 top-level, non-nested, read-only subagents (runtime wiring; store/provider fencing; migrations;
retention/deletion; roles/ACLs; tests/CI; release/rollback; Docker/PG18 harness) with the coordinator
performing independent cross-verification of the pivotal claims (0062 SQL, `finishAfterProvider` lease
nulling, `0060` trigger, RC retention wedge reachability, `backup-ci-registration` failure) and
deduplication. Static/read-only inspection only; the single command executed was
`node --test infra/tests/backup-ci-registration.test.mjs` (read-only) plus read-only `git`/`sha256sum`.
No Docker or live PostgreSQL was run.
