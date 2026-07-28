# Codestead Production-Readiness Closure Implementation Plan

> **For Codex:** REQUIRED SUB-SKILL: Use `subagent-driven-development` to execute this plan one task at a time. Each task requires an implementer, test-first evidence, an independent task review, a checkpoint commit, and a direct push to `main` after acceptance.

**Goal:** Close every repository-scoped gap behind the 70 Partial and 2 Missing release-audit rows, narrow database authority to explicit capabilities, and produce truthful, candidate-bound tooling for the remaining Gmail, Drive, Cloudflare, NUC, KVM, device, reboot, and power-loss gates.

**Architecture:** Treat repository readiness and external proof as separate authorities. Repository code generates, validates, and binds evidence to an immutable release candidate; it never manufactures provider, hardware, human-review, policy, or physical-event evidence. PostgreSQL moves from blanket runtime CRUD to a closed-world capability manifest, dedicated service identities, exact ACL reconciliation, and owner-controlled destructive routines.

**Tech stack:** Next.js/TypeScript, Node.js, PostgreSQL 17 production plus PostgreSQL 18 compatibility, Drizzle SQL migrations, Vitest/Node test runner, Playwright, Bash/Python operations tooling, systemd, Docker Compose, KVM/libvirt, Gmail API, Cloudflare Tunnel, age, rclone/Google Drive.

## Global Constraints

- Work directly on `main` because the user explicitly required it; never create a feature branch or discard existing work.
- Treat `a1a4ea2da6c5648208b45825cdb4f430f47175a4` as the historical recovery baseline for this closure sequence, not as an instruction to rewind accepted work. Task 2A starts from clean current checkpoint `4a512706f6756582a1c8c20f644b6473a20b376d`; before each later task, record the exact HEAD and worktree status and report unexpected divergence.
- Keep laptop Docker off. Do not start, stop, connect to, reconfigure, or test against the Windows PostgreSQL service listening on port 5432.
- Only one implementation subagent may edit at a time. Read-only auditors may run concurrently. Each accepted task gets an independent diff-based review before the next implementation task.
- Use TDD: capture the focused failing test, implement the smallest complete fix, run the focused and adjacent gates, then commit. Never weaken a guard merely to make a stale test pass.
- Preserve the NUC’s existing containers, native services, Tailscale, host cloudflared, storage, firewall, and network configuration. No NUC mutation until an exact reviewed command and maintenance prerequisite are ready.
- Never request or print secret values. Interactive sudo passwords, OAuth credentials, age identities, rclone configuration, Cloudflare tunnel credentials, and recovery codes must remain outside chat and Git.
- PostgreSQL 17 is the production authority. PostgreSQL 18 is a compatibility and recovery-verification gate, not an implied production-version change.
- All owner-controlled routines must have an exact owner, fixed safe `search_path`, closed ACL, no PUBLIC execution, no grant option, bounded predicates, caller/capability authentication, and deterministic failure behavior.
- Unknown database objects, roles, columns, routines, evidence kinds, provider states, and future schema additions fail closed.
- No release-audit row moves to Implemented solely from prose, source regex, mocks, historical evidence, a URL, or a checksum that the artifact writer can rewrite. Evidence must be schema-valid, candidate-bound, current, and independently verifiable.
- Human curriculum review, owner policy choices, live provider/account state, physical-device behavior, controlled reboot, and supervised AC loss remain unproven until their real actors produce valid evidence.
- Do not invent percentages or ETAs. Record commands, pass/fail counts, commits, and exact blockers.

---

### Task 1: Repair the two stale Gmail CI contracts

**Files:**
- Modify: `infra/tests/gmail-request-timeout-config.test.mjs`
- Modify: `infra/tests/gmail-reconciliation-image.test.mjs`
- Modify only if the new behavioral contract exposes real drift: the corresponding Gmail runtime policy or runbook file
- Report: `.superpowers/sdd/2026-07-29-task-1-report.md`

**Steps:**
1. Preserve the reproduced RED evidence: timeout test fails on removed `PROVIDER_LEASE_MS`; reconciliation test expects obsolete `beginProviderCall` fixture.
2. Derive timeout assertions from `mail-dispatch-runtime-policy.ts` and assert the current TX1/TX2/watchdog safety relationships rather than restoring a dead constant.
3. Replace the source-regex reconciliation fixture with the current guarded-dispatch/exact-byte operator contract and keep image-entrypoint/secret checks active rather than skipped accidentally.
4. Run both focused tests, the Compose/static registration gate that invokes them, typecheck, and targeted lint.
5. Commit only after pristine GREEN output and independent review.

### Task 2: Establish a closed-world database capability manifest

**Files:**
- Create: `scripts/database-runtime-capabilities.mjs`
- Create: `scripts/database-runtime-capabilities.test.mjs`
- Modify: `scripts/bootstrap-database-roles.mjs`
- Modify: `scripts/database-role-boundaries.test.mjs`
- Modify: `scripts/verify-database-role-boundaries.mjs`
- Modify: `infra/tests/database-least-privilege-static.test.mjs`

**Steps:**
1. Add RED tests proving the current blanket `GRANT ... ON ALL TABLES/SEQUENCES` and broad default ACLs are rejected.
2. Encode every managed database role, table/column grant, routine execution grant, type use, sequence use, owner, membership, and default ACL in one checked-in post-contract manifest. Separately encode the finite predecessor-compatibility allowance used only while `0070` is current; that allowance is not new grant authority and expires at `0071`.
3. Include all 127 public tables/1,489 public columns plus the Drizzle schema/table/sequence; require exact catalog equality and deny unknown objects by default.
4. Make bootstrap reconciliation and the standalone verifier consume the same manifest without circularly trusting generated SQL. Give both an explicit expand/prepare mode that reports but never revokes the named predecessor allowance, and a contracted mode that requires exact post-contract equality.
5. Add drift, grant-option, delegated-grant, PUBLIC, default-ACL, unknown-object, phase-transition, and idempotent-reconciliation tests.

### Task 3: Split shared runtime and operations database identities

**Files:**
- Modify: `compose.yaml`
- Modify: `infra/secrets/README.md`
- Modify: `infra/ops/create-database-secrets.sh`
- Modify: `infra/ops/validate-database-secrets.mjs`
- Modify: `scripts/bootstrap-database-roles.mjs`
- Modify: `scripts/verify-database-role-boundaries.mjs`
- Modify relevant worker/service entrypoints and focused tests

**Steps:**
1. Add failing secret/topology tests for dedicated roles rather than one union `learncoding_worker`/`learncoding_ops` credential.
2. Define narrowly scoped replacement identities for mail dispatch, rewards, regrade, exam finalization, practice recovery, project correction, storage scanning, file erasure, seed/catalog, admin bootstrap, storage reconciliation, retention reporting/apply, restore verification, dump, and restore loading in the Task 2 manifest and bootstrap topology. Task 3 defines and wires them; `0070` installs their additive database capabilities.
3. Keep `learncoding_owner` NOLOGIN and migrator membership SET-only; keep bootstrap authority one-shot.
4. Wire each replacement service to only its dedicated secret and prove unrelated credentials are absent from its environment, but do not revoke or disable predecessor identities or grants before the Task 5 cutover gate.
5. Add positive path and cross-role negative probes for every identity, plus candidate/image-bound predecessor and replacement compatibility probes consumed by `0070`, `0071`, deployment, and rollback tooling.

### Task 4: Add owner-controlled capabilities in `0070` (expand/prepare)

**Files:**
- Create: `drizzle/0070_p3_2_capability_expand_prepare.sql`
- Create: `drizzle/meta/0070_snapshot.json`
- Modify: `drizzle/meta/_journal.json` and the reviewed migration ledger so the accepted tail is `0069` → `0070`
- Modify: `src/lib/data-lifecycle/deletion.ts`
- Modify: `src/lib/data-lifecycle/retention.ts`
- Modify: `src/lib/data-lifecycle/file-erasure.ts`
- Modify: `src/lib/storage/reconciliation.ts`
- Modify: mail/outbox lifecycle code and corresponding integration tests

**Steps:**
1. Starting from the accepted Task 2 manifest and Task 3 identity/probe contracts, add RED live-database harness cases proving app/ops/worker can currently overreach through raw DML.
2. Create `0070` immediately after `0069` as an additive expand/prepare migration: install the replacement roles, owner-controlled fixed-search-path SECURITY DEFINER routines, narrowly scoped grants, and compatibility probes for account deletion phases, bounded retention categories, mail redaction/deletion, file-erasure enqueue/claim/complete/fail/purge, and storage reconciliation.
3. Bind every destructive call to exact run/target/capability identifiers and advisory-lock/fence rules; make replay idempotent.
4. Close the implicit ACLs of objects newly created by `0070`, but retain every legacy direct/default ACL, shared identity, and grant required by the predecessor runtime. `0070` must not scrub, narrow, reassign, drop, or otherwise remove predecessor-required authority.
5. Refactor the replacement runtime to use the new capabilities instead of direct outbox DELETE or unnecessary full-payload SELECT, make startup attestation work with column-scoped reads, and resolve retention retry-key replay, restricted-FK blockers, wrong-type erasure conflicts, and competing eraser behavior with behavioral regressions.
6. On disposable, non-5432 PostgreSQL 17 and PostgreSQL 18 clusters, prove `0069` → `0070`, predecessor-runtime compatibility, replacement positive workflows, negative overreach, idempotent reconciliation/replay, and injected-failure rollback. Bind the passing records to the exact runtime candidate and image digests for Task 5; do not cut over or contract ACLs in Task 4.

### Task 5: Cut over and contract ACLs in `0071`

**Files:**
- Create: `drizzle/0071_p3_2_acl_contract_scrub.sql`
- Create: `drizzle/meta/0071_snapshot.json`
- Modify: capability manifest, bootstrap, verifier, migration journal, and reviewed migration ledger so the accepted tail is `0069` → `0070` → `0071`
- Modify: PG17/PG18 ACL integration harnesses
- Modify: release/rollback capability records and tests
- Modify: restore-role-boundary tests

**Steps:**
1. Before `0071` acquires a mutating lock or changes database/deployment state, require candidate-bound proof that `0070` is current, the replacement runtime is fully cut over, predecessor connections are drained, and the exact active and configured rollback images have known compatibility verdicts. Also require the Task 4 replacement-capability positive, negative, idempotence, and injected-failure rollback proofs to be PASS on both PostgreSQL 17 and PostgreSQL 18; reject missing, stale, unknown, mismatched, or incompatible evidence before mutation.
2. Create `0071` as the contract/scrub migration only: require the migrator session and owner effective role, acquire reviewed NOWAIT locks, scrub legacy direct/default ACLs and predecessor-only memberships, and grant exactly the post-contract manifest. `0071` must not introduce replacement roles, routines, grants, or probes deferred from `0070`.
3. Run bootstrap reconciliation twice in contracted mode and prove the exact catalog fingerprint is unchanged.
4. Re-run positive workflows and negative overreach probes per dedicated role on disposable PostgreSQL 17 and PostgreSQL 18 clusters, never local port 5432.
5. Prove atomic rollback of data, ownership, membership, ACL, default ACL, and routine authority after injected failures.
6. Declare `0071` forward-only. Deployment and rollback tooling must reject an unknown or incompatible predecessor/runtime image before database or deployment mutation; only an image proven live against the contracted manifest may be selected, and a rejection must never re-expand legacy ACLs.

### Task 6: Repair live restore and backup database authority

**Files:**
- Modify: `scripts/backup/backup.sh`
- Modify: `scripts/backup/restore.sh`
- Modify: `scripts/backup/restore-drill-isolated.sh`
- Modify: `scripts/verify-restored-backup.ts`
- Modify restore/deployment runbooks and focused tests

**Steps:**
1. Add RED tests showing one-URL restore cutover leaves service identities on the old database and restored ACLs unprepared.
2. Use the Task 3-defined least-privilege dump and ephemeral restore-loader identities in the backup and restore paths; do not expand backup reporter or use the bootstrap superuser for routine dump/restore.
3. Reconstruct ownership/ACLs through the complete-ledger restored-no-ACL path and atomically switch every service database URL.
4. Sanitize Docker authority/environment in root backup/restore units.
5. Prove PG17/PG18 restore, exact ACL topology, smoke, cleanup, and root-cause-preserving failures.

### Task 7: Add Gmail startup preflight and terminal delivery verification

**Files:**
- Modify: `scripts/process-outbox.ts`
- Modify: `src/lib/notifications/mailer-transport-internal.ts`
- Modify: `src/lib/notifications/gmail-oauth-scopes.ts`
- Create: read-only terminal Gmail verification module/CLI and tests
- Update: Gmail runbooks

**Steps:**
1. Add RED tests for missing/extra actual OAuth grants, placeholder sender, mailbox/alias mismatch, and timeout-policy drift.
2. At startup, validate declared and provider-observed least-privilege scopes, mailbox identity, authorized From address, and current timeout authority without sending mail.
3. Add a read-only exact-one terminal verifier that checks a sent row against one Gmail SENT raw message and emits only digests/booleans.
4. Keep ambiguous outcomes quarantined and never authorize resend.
5. Add redaction/canary tests proving provider bodies, message bytes, addresses, tokens, IDs, and URLs never enter output.

### Task 8: Implement durable bounce/complaint suppression and DNS readiness

**Files:**
- Create: schema migration and Drizzle schema for delivery events/suppressions
- Create: DSN/bounce parser, ingestion worker, DNS validator, evidence schema, and tests
- Modify: provider-boundary pre-send authority and Compose/systemd/CI registration

**Steps:**
1. Add RED parser, replay, forged-event, cross-address, concurrency, and provider-boundary suppression tests.
2. Persist source-bound delivery events and active suppression with exact message/operation/recipient binding.
3. Require suppression lookup inside the provider authority boundary; a suppressed address cannot reach Gmail.
4. Validate SPF, DKIM selector/key, DMARC policy, From/envelope alignment, and received-message alignment into a redacted candidate-bound report.
5. Document and test the live canary sequence; do not mark it PASS without real Gmail and DNS evidence.

### Task 9: Close onboarding privacy and profile gaps

**Files:**
- Modify: onboarding schema/migration/API/UI/tests
- Modify: `src/lib/ai/context.ts`
- Modify: AI tutor route/context tests
- Add: authenticated Playwright onboarding journeys

**Steps:**
1. Reproduce that neutral/disabled mode still serializes confirmed interests.
2. Fail closed by excluding interests from provider context in neutral/disabled modes; add table-driven subsequent-call regressions.
3. Add per-language experience, detailed availability, accessibility needs, and append-only interest correction history.
4. Prove interrupted new, beginner, advanced, neutral, edit, and resume journeys with persisted data.

### Task 10: Close learning, adaptation, assessment, and runner repository gaps

**Files:** relevant roadmap, planner, evidence, mastery/review, exam policy, runner recovery/UI, integration and Playwright suites.

**Steps:**
1. Add authenticated graph/list parity across prerequisite, evidence, review, override, lock, and recommendation states.
2. Add “I don’t know,” beginner/advanced claims, diagnostic variants, and golden scenarios.
3. Add property-based projection rebuild/correction replay and scheduling calibration report.
4. Add integrated provider/server/runner failure matrix proving retry/resume and unchanged evidence.
5. Add cancellation/result rendering plus navigation/app/runner restart browser recovery.

### Task 11: Close AI report, session lifecycle, memory, and admin-audit gaps

**Files:** AI report/adjudication code, session lifecycle worker/timer, tutor memory/context, audit manifest and reconciliation tests.

**Steps:**
1. Add immutable raw AI-output version retrieval/replay and linked specialized adjudication/correction state.
2. Add a 30-minute inactivity transition worker with multi-tab/restart proof.
3. Add versioned thread/skill summaries, selected-project context, and delete-to-context E2E.
4. Add a complete sensitive-read/privileged-action audit manifest and static/runtime reconciliation artifact.

### Task 12: Close architecture/import-boundary maintainability gaps

**Files:** `src/lib/admin/**`, `src/lib/exams/**`, import-boundary verifier, typed API contracts, migration/rollback tests.

**Steps:**
1. Convert the ten documented admin/exam boundary violations into focused failing tests.
2. Extract stable public interfaces without widening cross-domain imports.
3. Add typed external API contracts and migration upgrade/rollback coverage.
4. Regenerate candidate-bound architecture evidence.

### Task 13: Complete repository-side auth and identity precursors

**Files:** invitation/mailbox proof, Google activation/linking, recovery/MFA audit events, API ownership/RLS matrix, auth Playwright suites.

**Steps:**
1. Add pre-queue mailbox proof and fail-closed activation/linking contracts.
2. Add verified-email explicit linking and complete login/MFA/OAuth security-event capture.
3. Extend two-owner/RLS coverage to every API operation and Better Auth catch-all.
4. Keep live Google/Gmail/cookie proof external until configured credentials and exact origins exist.

### Task 14: Complete repository-side assessment, correction, and admin lifecycle precursors

**Files:** assessment flow/UI, practice correction, AI/content correction, account lifecycle/admin interfaces, health probes, integration/Playwright tests.

**Steps:**
1. Add debugging/project-rubric/short-explanation flows and practice correction.
2. Unify AI/content correction and add immutable learner-to-admin linkage.
3. Add suspend/reactivate/role lifecycle and exact audit/credential boundaries.
4. Add provider/runner/Gmail/backup health states with unknown-state handling and runbook links.

### Task 15: Add candidate-bound release and external-evidence authority

**Files:**
- Create: release-candidate derivation, external evidence schema/policy/index, validators, tests
- Modify: release-audit and evidence-integrity logic
- Modify: `package.json` and CI registration

**Steps:**
1. Add RED tests proving historical, free-form, URL-only, self-checksummed, dirty-tree, wrong-candidate, unknown-kind, and NOT_RUN evidence cannot close a row.
2. Derive origin/commit/tree/archive/lockfile/submodule/dirty receipts and pre/post no-drift proof.
3. Support closed evidence kinds with independent hashes/signatures and exact invalidation inputs.
4. Require every Implemented claim to resolve to current valid evidence.

### Task 16: Complete runner and application supply-chain release binding

**Files:** runner image tooling/workflow/records, app image operations, release-tree packager, deployment verifier, workflow contract tests.

**Steps:**
1. Add clean-source and persistent build-input receipts for runner images.
2. Add digest-frozen runner Cosign sign/attest/verify and registry workflow.
3. Bind app and runner inspection, SBOM, Trivy DB/results, signing, attestation, and candidate receipt into terminal release bundles.
4. Require a complete unprivileged candidate gate before privileged publication; reject existing immutable tags.
5. Keep actual registry/OIDC/transparency publication external until GitHub executes it.

### Task 17: Add measured secret-canary, key rotation, and OWASP gates

**Files:** production load evidence, credential keyring/vault/rotation CLI, restore verifier, security harness/policy/report validator, CI.

**Steps:**
1. Replace hardcoded zero leak counts with measured scanning across images, logs, exports, backups, UI, and reports; inject one leak per surface in tests.
2. Add multi-version keyring, dry-run/apply rewrap, concurrency fence, resume/idempotency, rollback, and count-only output.
3. Add pinned repository security tools and schema-validated review output; never prewrite PASS.
4. Keep public-origin/manual OWASP and provider credential revocation external.

### Task 18: Make Drive backup/restore evidence trustworthy

**Files:** backup/restore scripts, systemd units, recovery-kit code, retention code, evidence verifier, runbooks, focused tests.

**Steps:**
1. Replace self-checksum-only restore reports with canonical v3 detached-signature evidence and pinned signer authority.
2. Prove backup, recovery-kit, and evidence-signing recipients are distinct and that the identity recovered from the kit decrypts the selected offsite archive.
3. Move Docker-bind staging out of `PrivateTmp` paths and size restore storage from measured data.
4. Enforce Drive backend/account/root identity, quota, 70/85/95 plus reserve/growth limits, dry-run retention, old restore-point selection, and exact-object safety.
5. Split unit installation from commissioning; timers cannot enable before signed prerequisites and delivered alert proof.

### Task 19: Make NUC/Cloudflare commissioning evidence executable

**Files:** external-gate ledger/schema, Cloudflare desired-state manifest/validator, host inventory collectors, runtime/recovery validators, runbooks/tests.

**Steps:**
1. Resolve Cloudflare Access versus `/health/ready` with a tested narrow bypass or service-token design.
2. Validate desired DNS/tunnel/Access/account posture offline and bind sanitized exports to the candidate.
3. Add read-only host/native-service/listener/network/firewall/router evidence schemas; verify live nftables/UFW state and service enablement.
4. Preserve native services as well as Docker containers across release/reboot.
5. Add route-disable/restore, credential-rotation, exhaustion-reset, and forwarded-header provenance tests.

### Task 20: Add controlled-reboot and recovery integrity evidence

**Files:** dedicated reboot pre/post collector/verifier, recovery checker/evidence collector, systemd tests, runbooks.

**Steps:**
1. Add a distinct append-only controlled-reboot schema; do not reuse the physical-cut collector.
2. Bind boot IDs, 900-second timing, candidate/images, native and container inventory, firewall, service enablement, backup state, alerts, and unrelated-service parity.
3. Add bounded filesystem/I/O error evidence and database integrity probes.
4. Require external alert delivery rather than optional journald-only success.
5. Keep the human reboot and physical AC-cut observations external.

### Task 21: Wire real KVM/load telemetry and exact-two-job proof

**Files:** production load service/control protocol/backend, privileged host/guest telemetry provider, runner image workflow, evidence/report tests.

**Steps:**
1. Reproduce the P0 fixture path that always returns `external_*_telemetry_required`.
2. Route production only to a strictly validated privileged telemetry provider; fixture faults remain synthetic-only.
3. Bind 4 vCPU, 8192 MiB, 100 GiB, private networking, two running jobs, third queued, thermal/OOM/disk/RAM thresholds, and app/DB responsiveness to evidence.
4. Persist exact candidate-bound load/browser artifacts; keep real NUC/KVM execution external.

### Task 22: Add accessibility and native-device evidence workflow

**Files:** Playwright/authenticated verifier, accessibility evidence schema/validator, CI artifact handling, affected UI/tests.

**Steps:**
1. Persist automated browser/auth reports with exact candidate/release binding.
2. Add two simultaneous learner profiles and real runner-state journeys rather than an unreachable runner/concurrency-one fixture.
3. Fix every automated keyboard/focus/label/contrast/responsive/status/graph-list defect found.
4. Provide strict manual evidence slots for Edge, native Safari, physical iOS Safari, screen readers, 200% zoom, 320px, and reduced motion; do not fabricate results.

### Task 23: Run repository release gates and repair failures

**Files:** only files implicated by reproducible failures; update evidence/handoff documents after facts change.

**Steps:**
1. Run focused gates first, then typecheck, lint, build, full unit/integration suites, static/semantic validators, security checks, and exact evidence verification.
2. On disposable isolated infrastructure only, run PG17 then PG18 migration/ACL/restore/race gates; keep Windows port 5432 untouched.
3. Build/scan/sign only through the approved release pipeline when Docker/registry prerequisites exist.
4. Independently review the complete `a1a4ea2..HEAD` diff and fix every Critical/Important finding.

### Task 24: Commission external services and physical evidence

**Files:** private evidence vault plus sanitized candidate-bound index; no secret material in the repository.

**Steps:**
1. Resolve the ten owner decisions: lost-factor authority, curriculum scope, cooldowns, NIM terms/models, private GitHub scope, Drive ownership/quota, privacy basis, and no-UPS/encrypted-boot risk.
2. Obtain independent human review and publication of all curriculum and assessment content.
3. Configure and prove Gmail/Google OAuth/DNS, NIM, GitHub, Drive, Cloudflare, and alert delivery.
4. Deploy the exact signed candidate to the preserved NUC/KVM, then run isolation, load, chaos, restore, rollback, accessibility, and device campaigns.
5. Perform controlled reboot first. Perform one supervised AC cut last with operator/observer evidence. Any missing or failed external gate keeps release status HOLD.

### Task 25: Final audit, handoff, commit, and direct push

**Files:**
- Modify: `docs/release-audit.md`
- Modify: `docs/requirements-matrix.md`
- Modify: `docs/feature-status.md`
- Modify: `CONTINUATION.md`
- Modify: `SESSION_STATE.md`
- Modify: `.superpowers/sdd/progress.md`

**Steps:**
1. Recalculate every requirement from evidence authority, not implementation optimism.
2. State separately: repository release candidate, locally verified application, externally deployed system, and operationally/physically proven system.
3. List every unproven external or owner/human item with the exact next action.
4. Verify clean worktree, exact local/remote main SHA, final gates, and no secret leakage.
5. Commit and push accepted work directly to `origin/main`.
