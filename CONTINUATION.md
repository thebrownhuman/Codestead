# Codestead continuation handoff

## Current superseding checkpoint - 2026-07-28 (Tasks 9-10 and final repository verification)

This section supersedes the older task and Git state below; the historical material remains for provenance.

- Active branch: `main`; this completion commit is based on pushed Task 9 checkpoint `4ce58ffdd74d3bf14889b7504398b2893416f443` and is intended to be pushed directly to `origin/main`.
- The repository-scoped Task 5-10 mail-authority lanes are complete for the current local/few-user scope: durable replay (`0067`), quarantine redaction/retention (`0068`), guarded exact-byte delivery (`0069`), CI/role/restore/rollback registration, live concurrency/deletion races, and the final release-gate repair pass.
- Native disposable PostgreSQL 17 and 18 verification passed for `0067`, `0068`, `0069`, restore-role boundaries, and the 25-case concurrency/deletion race matrix on each major. The post-audit `0064` harness also passed on both majors. Docker remained off; Windows PostgreSQL and port `5432` were not modified.
- Final audit repairs fail-close the repository secret/encoding walkers across tracked files, Git-free archives, generated-root exclusions, UTF-8/UTF-16 decoding, large-file streaming, malformed Git output, missing/nonregular tracked files, symlinks, nested `.git` components, and redacted finding paths. Focused scanner tests passed 93/93, both live scans passed, and an independent read-only re-review found no remaining scanner finding.
- Integration fault-injection now validates exact role/database topology before creating privileged pools or mutating data, routes every retention call through that boundary, applies finite pool/query/transaction/shutdown deadlines, and preserves primary failures through cleanup. Focused behavioral/static verification passed 87/87 after independent review.
- Database harness audit repairs pin the exact four `0067` quiescence cases, reject missing legacy/replay calls, and keep all fallible `0064` setup inside guaranteed cleanup. The `0064` registration and both role contracts passed, including native PostgreSQL 17/18 execution with no leaked process.
- The final uninterrupted `npm run check` passed in 535 seconds under Node 22.23.1: lint, typecheck, dependency/security/API/architecture gates, migration and role contracts through `0069`, restore/rollback and writer registration, auth tests, coverage, curriculum/content checks, evidence integrity, and the 95-page production build. Coverage was 80.73% statements, 75.04% branches, 80.98% functions, and 83.81% lines. Evidence integrity verified 81 Markdown files, 273 local links, 81 evidence JSON files, and 147 declared hashes.
- P3-2 remains explicitly deferred: guarded-delivery/outbox privileges are narrowed and verified, but broader historical app/ops CRUD surfaces outside this lane still require either technical narrowing or release-owner risk acceptance.
- The release audit remains intentionally non-green at 43 implemented, 70 partial, and 2 missing requirements. This checkpoint proves the completed repository lanes; it does not declare the whole product production-ready.
- Real Gmail delivery/OAuth, NUC runtime, Cloudflare, Google Drive restore, reboot, device accessibility, and supervised power-cut evidence still require the actual services/hardware and remain external and unproven.

## Current superseding checkpoint - 2026-07-27 (Task 8 final verification)

This section supersedes the older task and Git state below; the historical material remains for provenance.

- Active branch: `main`; the Task 8 completion commit is the commit containing this update, based on pushed checkpoint `6e69fa7` (`fix(db): canonicalize backup authority constraint`).
- Task 8 now fail-closes every reviewed 0062-0069 catalog phase on the exact PostgreSQL-major constraint digest, relation and column ACLs, worker/provider request surface, receipt topology, owner, routine, trigger, search-path, and `SECURITY DEFINER` contracts. A pre-0062 database with an existing `email_outbox` receives the same exact all-role ACL proof; a genuinely empty fresh database remains supported.
- Restricted-role boundary verification no longer reads the protected backup guard, while privileged bootstrap verification still proves its exact row state. Application-object discovery accepts only a public ordinary table on which app, worker, and ops all have the expected CRUD surface. Authenticated guarded-delivery probes run only after schema `USAGE`, and the worker expectation correctly permits `UPDATE` only on the two provider-request body columns while keeping the two release-marker columns database-owned.
- `test:database-role-boundaries` and `test:backup-status-mail-authority:contract` are now explicit `npm run check` and application-CI gates. The exact application-job projection, 0065 registration, 0069 registration, release/rollback capability contract, migration ledger, and writer inventory all pass.
- Local Node 22.23.1 evidence is green: focused role/backup/replay tests 98/98; registered database-role boundaries 50/50; backup-authority contract 7/7; role contracts through 0069; writer inventory 26/26 (`runtime:5:catalog:1:delegated:1`); restored-backup unit tests 25/25; restore-drill contract; typecheck; changed-file ESLint; and `git diff --check`.
- A disposable native WSL PostgreSQL 17 cycle passed all 12 phases: initial and replay bootstrap, negative probes, migration, reconciliation, restricted-role boundaries, and topology verification. The journal count was 70 and both topology fingerprints matched at `c0b5da14979490f8080b2325ae33731742cb88b77275add48756819ffc51b0aa`. Docker was unused; the random listener, temporary cluster, and processes were verified absent; permanent `17/main` remained down; port 5432 was untouched.
- The isolated UID-0 release behavioral harness passed all 45 exact-tree cases, and rollback passed all 42 exact-SHA cases using their private fake-Docker fixtures. The static 0069 release/rollback capability contract also passed 9/9. No live Docker daemon or external service was used.
- The current diff has not been rerun locally on PostgreSQL 18 because Windows PostgreSQL 18, Docker, and port 5432 were explicitly out of scope. The pushed native PG18 CI job must close that platform gate. Full `npm run check`, full lint/build, and broad release-audit repair remain Task 10 rather than being inferred from these bounded Task 8 gates.
- The next numbered lane is Task 9: execute the registered live concurrency/deletion race matrix. Task 10 then runs the complete release gates. P3-2 broad app/ops database privileges remain explicitly open/deferred for technical narrowing or release-specific risk acceptance.
- Real Gmail, NUC, Cloudflare, Google Drive, reboot, and supervised power-cut evidence remains external and unproven. Repository evidence does not make the product production-ready.

## Current superseding checkpoint - 2026-07-27 (Task 7)

This section supersedes the older task and Git state below; the historical material remains for provenance.

- Active branch: `main`; the Task 7 completion commit is the commit containing this update, based on `d4bc135` (`feat(mail): add guarded delivery authority`).
- Task 7 composes the permanent `task7-v1` hold with an exact database-owned delivery-release receipt, atomically issues that receipt from all five physical producers and the delegated backup authority, and makes every claim, TX1, TX2, settlement, reconciliation, and sweep path revalidate it.
- Production mail now carries an opaque one-shot prepared-dispatch capability through bounded TX1 and guarded TX2. TX2 holds the scope advisory lock and checked-out database lease through the exact-byte provider call and terminal commit acknowledgement; commit-unknown and persistence-unknown outcomes fail closed into durable reconciliation instead of authorizing another send.
- Dedicated mail pools have bounded connection, query, statement, lock, idle-transaction, idle-client, and shutdown behavior. Checked-out and idle-client error lifecycles, late client acquisition, provider deadlines, hard-watchdog termination, Gmail evidence correlation, redacted reconciliation, and shutdown cleanup are covered by behavioral tests.
- Native PostgreSQL 18 verification passed with the sole output `mail_guarded_delivery_0069=PASS`. It exercised the raw 0069 migration, hostile ACL/catalog convergence, release authority, guarded runtime, exact-byte send, commit-ack uncertainty, reconciliation, redaction/deletion compatibility, and listener/PID-gated cleanup on a disposable non-5432 cluster. No listener, temp root, or PostgreSQL process remained.
- Repository verification passed: 955/955 broad mail/runtime Vitest tests, 29/29 repaired predecessor/successor contract tests, 26/26 authoritative writer-inventory tests (`runtime:5:catalog:1:delegated:1`), 13/13 static 0069 harness tests, typecheck, changed-file ESLint, and `git diff --check`.
- PostgreSQL 17 is not installed locally and was not claimed. Task 8 must register 0068/0069 in the journal/reviewed ledger, finish exact role/CI/restore/rollback integration, and run the registered PostgreSQL 17 and 18 gates. Task 9 remains the complete live race matrix; Task 10 remains the full release-gate run and repair pass; P3-2 broad database-privilege narrowing remains unresolved.
- Real Gmail, NUC, Cloudflare, Google Drive, reboot, and supervised power-cut evidence remains external and unproven. Repository evidence does not make the product production-ready.
## Current superseding checkpoint - 2026-07-27

This section supersedes the older task and Git state below; the historical material remains for provenance.

- Active branch: `main`; pushed Task 5 base: `4af6269a1540481038ca7fa3918e1ee71725cb95` (`feat(mail): complete durable replay authority`).
- Task 6 (`0068` quarantine redaction/retention authority) is the commit containing this update. It adds one classifier-driven retention predicate, an ops-only `SECURITY DEFINER` redactor, a narrow immutable-payload trigger carve-out, deterministic redaction, savepoint-isolated runtime orchestration, and durable replay-coverage checks before terminal deletion.
- The migration now rejects altered final-0067 hold/coverage routines by live-derived body and full-definition hashes, requires an unconditional `ENABLE ALWAYS` hold trigger, dynamically scrubs delegated routine ACLs, and finishes with an exact owner/security/search-path/ACL/payload-trigger catalog verifier.
- The native PostgreSQL 18.1 harness passed and proved real migrator-to-owner delegation, hostile ACL convergence, predecessor tamper rollback and clean retry, report-only behavior, oldest-then-ID batches of 1 and 2, protected replay/provider/claim evidence preservation, idempotent replay, direct delegated-owner denial, and exact listener/PID-gated cleanup. Its sole output was `mail_quarantine_redaction_0068=PASS`; stderr was empty; no disposable listener, process, or root remained.
- Focused verification passed under Node 22.23.1: 67/67 retention/redaction Vitest tests, 21/21 final-0067 migration tests, 40/40 final-0067 role-contract tests, 10/10 0068 harness-contract tests, repository typecheck, repository ESLint, static deployment validation, semantic Compose validation, and `git diff --check`.
- PostgreSQL 17 is not installed locally. The PG17 behavioral run, 0068 journal/reviewed-ledger registration, phase-68 role/catalog reconciliation, CI projection, restore/rollback registration, and correction of the stale shared 0067 coverage-routine digest remain explicit Task 8 gates. Do not describe 0068 as release-registered until those pass.
- The next repository lane is Task 7: production TX2/exact-byte dispatch runtime. After that, complete Task 8 integration gates, Task 9 races, Task 10 full release gates, and P3-2.
- Real Gmail, NUC, Cloudflare, Google Drive, reboot, and supervised power-cut evidence remains external and unproven. Repository evidence does not make the product production-ready.

## Current superseding checkpoint - 2026-07-25

This section supersedes the older Git/worktree and pending-migration state below. The older material is retained only as historical context.

- Active branch: `main`; the checkpoint base is `716567274ab1e50451404d9a035e524ee0deb64c` (Task 3).
- Only the primary worktree is registered. No subagent or project background process is active.
- Task 2 (`0064` ACL/CASCADE authority) is pushed at `f0ae9fc`.
- Task 3 (`0065` reviewed migration metadata) is pushed at `7165672`.
- Task 4 is the commit containing this section: migration `0066` and runtime integration bind the exact prepared provider bytes to an opaque correlation identifier and hashed dispatch evidence before provider authority is armed. Gmail reconciliation uses the durable tuple, worker/store finalization fences it, and production scripts use the prepared immutable payload.
- `0066` is contiguous in the Drizzle journal, has a generated snapshot, is frozen in the reviewed migration ledger, and is registered in package scripts and the PostgreSQL CI projection.
- Task 4 verification: 144/144 focused Vitest tests, 24/24 migration-ledger tests, 21/21 database-role tests, 5/5 `0066` role-contract tests, live PostgreSQL 17.10 and 18.1 catalog/backfill/ACL/transition/rollback/tamper harnesses, repository-wide typecheck and ESLint, architecture evidence (`822` files, `3366` imports, `0` violations), and a bounded 42-file changed-secret scan all passed under Node 22.23.1.
- The next repository lane is Task 5: `0067` durable replay authority. Then proceed through `0068` retention/redaction, production TX2/runtime, CI/restore/rollback completion, live concurrency/deletion races, full release gates, and P3-2.
- Real Gmail, NUC, Cloudflare, Google Drive, reboot, and supervised power-cut evidence remains external and unproven. Do not mark the product production-ready from repository tests alone.

Snapshot prepared on 2026-07-22 for transfer to a fresh Codex session. This is a deployment-readiness handoff, not a declaration that Codestead is production-ready.

## Authoritative sources

- Persistent goal objective: `C:\Users\Shivansh\.codex\attachments\a01b89d0-846d-468d-8545-1e65b2f61bc1\goal-objective.md`
- Approved design: `docs/superpowers/specs/2026-07-14-nuc-production-deployment-design.md`
- Release audit: `docs/release-audit.md`
- New audits: `FRONTEND_AUDIT.md`, `BACKEND_AUDIT.md`, and `QUALITY_AUDIT.md`

The approved goal is deployment-only. Do not expand product features or curriculum content unless a change is required for production safety.

## Project purpose and current architecture

Codestead is a private, self-hosted adaptive learning studio for a small invited cohort. It combines authored curriculum, deterministic mastery, isolated multi-language execution, formal exams, optional learner-funded AI mentoring, and an administrator mentor console.

The trusted application is a TypeScript/Next.js service using Better Auth, Drizzle, and PostgreSQL. Background workers handle mail, rewards, assessment regrades, exam finalization, practice recovery, project-review corrections, scanning, retention, and physical file erasure. A separate HMAC-authenticated runner executes C, C++, Java, Python, and JavaScript with exactly two concurrent jobs. Production is modeled with Docker Compose on an Ubuntu 24.04 NUC, an isolated KVM runner guest, an outbound-only dedicated Cloudflare Tunnel, file-backed secrets, and encrypted age/rclone backups.

There are two deployment modes:

- Pilot: `UPLOADS_ENABLED=false`; ClamAV and the scanner are absent, while the file-erasure worker remains enabled.
- Full: uploads require the explicit `uploads` Compose profile, a reviewed pinned ClamAV image, and additional promotion evidence.

The repository is a Core Beta implementation candidate. It is not an approved learner-facing release, and the curriculum is not claimed to be human-editorially verified.

## Original goal and expected final result

The active goal is to complete repository-achievable production readiness, safely deploy a reviewed exact commit to the user's Ubuntu NUC, preserve all existing NUC services, and produce truthful evidence for CI, browser, PostgreSQL, runner, Compose, backup/restore, rollback, reboot, load, and power-loss gates. External Cloudflare, Gmail, Google Drive, KVM, NUC, and physical power-cut evidence must never be fabricated.

The final intended result is a clean exact-SHA release candidate, pushed directly to `main`, with pinned images, fail-closed pilot configuration, safe secrets and database initialization, an isolated two-slot runner, encrypted restore-tested backups, bounded recovery behavior, and paste-ready operational commands. Learners and uploads must remain disabled until every applicable release gate passes.

## Git and worktree state

Primary repository: `C:\Users\Shivansh\Desktop\Projects\LearnCoding`

- Branch: `main`
- HEAD before this handoff checkpoint: `73951e68a3307a9967589358c5646bd3a61c402c`
- Subject: `checkpoint: preserve Codestead production release work`
- Remote: `git@github.com:thebrownhuman/Codestead.git`
- Before the handoff commit, `main` was one commit ahead of `origin/main`.

Do not delete the isolated worktrees. They contain stable commits and deliberately uncommitted RED test scaffolds.

| Worktree | Branch | State |
| --- | --- | --- |
| `C:\tmp\codestead-wt\auth` | `codex/fix-auth-security` | Clean; commit `e07899d66df7b348de421d02ae8ebf053914af64` |
| `C:\tmp\codestead-wt\backup` | `codex/fix-backup-policy` | Clean; commit `534577849bb56ea3782e4ba007d698837e7f0236` |
| `C:\tmp\codestead-wt\csrf` | `codex/fix-origin-csrf` | Clean; commit `590a242211559b6706ef8a2b84e22437243482e2` |
| `C:\tmp\codestead-wt\db` | `codex/fix-db-least-privilege` | Uncommitted RED tests; no implementation |
| `C:\tmp\codestead-wt\exam` | `codex/fix-exam-safety` | Clean; commit `adbd2635c1b95bb4c66363d02b7edb211183b54e` |
| `C:\tmp\codestead-wt\frontend` | `codex/fix-frontend-gates` | Clean baseline; work not started |
| `C:\tmp\codestead-wt\load` | `codex/fix-load-proof` | Clean baseline; work not started |
| `C:\tmp\codestead-wt\mail` | `codex/fix-mail-reliability` | Uncommitted RED tests; no implementation |
| `C:\tmp\codestead-wt\retention` | `codex/fix-retention-erasure` | Clean; commit `d673cf98608b70b648979e61ae7e35b211aa3ddb` |
| `C:\tmp\codestead-wt\rollback` | `codex/fix-rollback` | Uncommitted RED test and design plan; no implementation |
| `C:\tmp\codestead-wt\runner` | `codex/fix-runner-identity` | Clean baseline; investigation only |

## Work completed in the primary worktree

1. Three read-only audits were produced:
   - `FRONTEND_AUDIT.md`
   - `BACKEND_AUDIT.md`
   - `QUALITY_AUDIT.md`
2. Canonical-LF release evidence was repaired. Four active evidence manifests now contain the correct source-byte digests. `npm run evidence:verify` and the affected executable checks passed repeatedly under Node 22.23.1 without further mutation.
3. The Cloudflare installation runbook was corrected to install the reviewed absolute source `/opt/learncoding/infra/cloudflare/config.example.yml` to `/etc/learncoding/cloudflare/config.yml` as `root:root` mode `0640`. `infra/tests/validate-static.mjs` contains LF/CRLF-robust regression coverage. Independent review accepted this correction.
4. The database-secret ceremony was completed and repaired after independent review:
   - It creates five independent fixed-role passwords and six newline-free files.
   - It is initial-creation-only, takes a per-directory lock, refuses existing finals before generation, stages and validates the complete inventory, publishes with no-clobber same-filesystem hard links, and rolls back every published file on failure.
   - Production metadata remains directory `root:codestead-secrets` `0750` and files `root:codestead-secrets` `0440`.
   - Dynamic tests cover concurrent creators, existing-final refusal, injected pre-publication and mid-publication failures, cleanup, non-root rejection, exact modes, and a contained root-owned fixture.
5. The main worktree's stable files prepared for the handoff checkpoint are:
   - `.github/workflows/ci.yml`
   - `BACKEND_AUDIT.md`
   - `FRONTEND_AUDIT.md`
   - `QUALITY_AUDIT.md`
   - `docs/deployment.md`
   - `docs/evidence/exm-003-006-008-reliability-2026-07-12.json`
   - `docs/evidence/project-review-correction-verification-2026-07-12.json`
   - `docs/evidence/run-008-official-runner-fairness-2026-07-12.json`
   - `docs/evidence/ses-004-dat-003-draft-sync-2026-07-12.json`
   - `docs/superpowers/specs/2026-07-14-nuc-production-deployment-design.md`
   - `infra/ops/create-database-secrets.sh`
   - `infra/secrets/README.md`
   - `infra/tests/database-secret-ceremony-atomic.test.sh`
   - `infra/tests/database-secret-ceremony.test.mjs`
   - `infra/tests/validate-static.mjs`

Detailed database-secret report: `C:\tmp\database-secret-ceremony-report.md`.

## Stable isolated commits not yet integrated

These commits passed their reported focused checks, but they have not been independently reviewed against the current main worktree and must not be called integrated or release-ready.

### Authentication boundary

Commit `e07899d66df7b348de421d02ae8ebf053914af64` on `codex/fix-auth-security` implements a default-deny Better Auth route policy and an app-owned forced-password-change flow. Typecheck, API-surface security, focused lint, and 126 focused/adjacent tests passed. Full CI and live-database tests were not run.

Changed areas: auth routes/configuration, onboarding completion, forced-password-change API and policy, authorization matrix/evidence, rate limiting, `package.json`, and `package-lock.json`.

Report: `C:\tmp\wt-auth-security-report.md`.

### Canonical Origin/CSRF boundary

Commit `590a242211559b6706ef8a2b84e22437243482e2` on `codex/fix-origin-csrf` adds a pure request-origin policy and Next proxy. Unsafe cookie-authenticated requests require exact `APP_URL` Origin; GET/HEAD/OPTIONS remain unaffected, and public no-cookie operations remain possible. Focused tests passed 43/43, auth-boundary tests passed 15/15, and typecheck, lint, API-surface, secret, encoding, and known-advisory gates passed.

Changed areas: `src/proxy.ts`, request-origin policy/tests, production-load HTTP helpers, and authenticated runtime verification.

Report: `C:\tmp\wt-csrf-origin-report.md`.

### Exam recovery and closed-book safety

Commit `adbd2635c1b95bb4c66363d02b7edb211183b54e` on `codex/fix-exam-safety` preserves mutation identity across recovered autosaves and fails closed while exam assistance state is unknown. Adjacent tests passed 81/81; typecheck and targeted ESLint passed.

Changed areas: durable exam outbox and exam-lockdown overlay plus their tests.

Report: `C:\tmp\wt-exam-safety-report.md`.

### Backup deadlines and freshness

Commit `534577849bb56ea3782e4ba007d698837e7f0236` on `codex/fix-backup-policy` separates 120-second control calls from size-derived bulk deadlines, enforces a strict four-hour service budget, changes offsite freshness to 30 hours, and polls hourly. Backup config, consistency, systemd, offsite recovery, shell syntax, and diff checks passed.

Changed areas: backup scripts, environment example, timers, tests, and backup/recovery documentation.

Report: `C:\tmp\wt-backup-policy-report.md`.

### File-erasure draining

Commit `d673cf98608b70b648979e61ae7e35b211aa3ddb` on `codex/fix-retention-erasure` implements global oldest-first `SKIP LOCKED` claiming across all operations, fenced completion, lifecycle-success retention, and failed/exhausted health across operations. Focused tests passed 13/13, adjacent lifecycle/deletion tests passed 69/69, targeted lint passed, and full typecheck passed.

Remaining in this lane: persisted oldest-retention checkpoint/stored-cutoff recovery and a real-PostgreSQL crash/object matrix.

Report: `C:\tmp\wt-retention-erasure-report.md`.

## Deliberately uncommitted partial work

Nothing is actively being modified. The following changes are intentionally preserved because they are RED tests or incomplete design work, not stable production fixes:

- Database lane `C:\tmp\codestead-wt\db`:
  - `infra/tests/database-least-privilege-static.test.mjs`
  - `scripts/__tests__/database-least-privilege.test.ts`
  - `src/lib/data-lifecycle/__tests__/deletion-runtime.test.ts`
  - Result: 4 Vitest failures with 31 passing; 3 static failures with 5 passing.
  - Report: `C:\tmp\wt-db-privileges-report.md`.
- Mail lane `C:\tmp\codestead-wt\mail`:
  - `src/lib/notifications/__tests__/mailer.test.ts`
  - `src/lib/notifications/__tests__/outbox-reliability-migration.test.ts`
  - Result: baseline 31/31 and PostgreSQL 2/2 passed; the new RED set has 5 expected failures.
  - Report: `C:\tmp\wt-mail-reliability-report.md`.
- Rollback lane `C:\tmp\codestead-wt\rollback`:
  - `infra/tests/rollback-production.test.sh`
  - `docs/superpowers/plans/2026-07-22-rollback-runtime-contract.md`
  - Result: the ten-service fixture fails as intended with `recorded runtime image evidence names an unexpected service`.
  - Report: `C:\tmp\wt-rollback-contract-report.md`.

Do not reset, clean, overwrite, commit as green, or remove these worktrees. Resume them from the preserved failing tests.

## Exact remaining tasks, ordered by priority

1. Independently review and integrate the five stable isolated commits one at a time. Resolve overlaps against the handoff checkpoint, rerun each focused suite, and only then run the combined gates. Suggested review order: auth, Origin/CSRF, exam, retention, backup.
2. Complete database authorization (`BE-DB-001`). An ACL-only patch is insufficient. Introduce a shared exact authorization manifest; distinct per-service credentials/capabilities; full catalog reconciliation including column ACLs/default ACLs/routines/RLS; reviewed narrow `SECURITY DEFINER` transitions; server-authenticated transaction identity; deny-by-default tests; and corrected release ordering after migration. Resume from the RED database worktree.
3. Complete ambiguous Gmail delivery and deletion serialization (`BE-MAIL-001`). Add claimed/quarantined states, lease owner/generation fencing, a durable pre-provider boundary, nonempty provider IDs, no retry after ambiguity, and account-deletion locking. Resume from the RED mail worktree.
4. Complete rollback (`QA-RBK-001` and `QA-RBK-002`) while preserving the approved image-only rollback model. Add the canonical service manifest including `file-erasure-worker`, honest candidate/previous provenance, and a fail-before-mutation configuration/runtime compatibility check. Resume from the RED rollback worktree.
5. Complete the retained production load proof (`QA-LOAD-001`) so accepted evidence performs authenticated application work rather than recording 307 redirects. The clean `load` worktree is reserved.
6. Bind live runner guest/image identity to the exact candidate record (`QA-RUN-001`) and run the adversarial and two-slot evidence. Investigation is in `C:\tmp\wt-runner-identity-report.md`; the runner worktree is clean.
7. Finish remaining frontend/auth/accessibility P1s: Google-only approved enrollment, verification resend, lost-factor recovery, access-decision fresh-MFA recovery, completed-onboarding recovery, manual TOTP key display, shared focus visibility, and modal focus containment. The clean `frontend` worktree is reserved.
8. Close remaining audit P1s or explicitly scope them:
   - `BE-SCAN-001` blocks full uploads mode, not the uploads-disabled pilot. Full mode requires a safe freshclam/clamd topology and reviewed egress.
   - `QA-REL-001` requires accepted exact-SHA clean-checkout evidence for the final integrated commit.
9. Review the P2/P3 findings in all three audit documents. Do not silently downgrade them; either fix, explicitly defer with scope/owner/risk, or prove the finding false.
10. Run the full clean-checkout release matrix only after integration: lint, typecheck, unit/coverage, auth-boundary, PostgreSQL integration, authenticated browser tests, curriculum/runtime checks, runner tests, production Compose boot/restart/persistence, security scans, build, rollback, backup/restore, and ten simulated learners with two concurrent runner jobs.
11. Push the reviewed exact commit directly to `main`, then deploy only that commit to the NUC using `infra/ops/release-production.sh` and the commands in `docs/deployment.md`.
12. Collect external evidence on the actual NUC: KVM guest/autostart, dedicated tunnel and Access policy, Gmail/Google/Drive credentials, encrypted offsite restore, controlled reboot, and supervised physical AC-cut recovery. Keep learners and uploads disabled until these pass.

## DB-ACL/P3-2 broad runtime-role risk - OPEN / DEFERRED

**Accountable owner:** `@thebrownhuman / DB-ACL/P3-2 DRI`

This finding is explicitly **OPEN / DEFERRED**, not green. In the expected final 0065/0066 composition there are 125 public tables and 1,471 columns. The scoped mail-authority pass protects the two new backup-authority tables and their nine columns from both `learncoding_app` and `learncoding_ops`, but both roles retain table-level `SELECT`, `INSERT`, `UPDATE`, and `DELETE` on the other 123 tables. Those table grants confer effective `SELECT`, `INSERT`, and `UPDATE` on 1,462 of 1,471 columns.

The three 0066 provider-correlation columns are on `email_outbox`, one of those 123 broadly granted tables. Column-level `REVOKE` statements do not override the table-level grants, so this handoff does **not** claim that app or ops is denied those columns by ACL. Database triggers enforce the reviewed mail transition rules, but trigger enforcement is not least-privilege role separation.

Owner default privileges also grant the same broad CRUD set to future public tables. Unless a future migration and post-migration privilege reconciliation explicitly carve a new table out, it joins the broad app/ops surface. Production has no row-level-security mitigation for either the current exposure or that future-default-grant risk.

Narrowing these two roles is unsafe in a mail-only pass. The application role directly drives Better Auth persistence and broad learner export and account-deletion workflows. The operations credential is shared by lifecycle, seed, administrator-bootstrap, and restore-verification services. A safe change therefore requires a full-system capability inventory, additional service credentials, release ordering, and positive and negative PostgreSQL behavior proofs; trimming grants from the mail path alone could break authentication, export, deletion, recovery, or bootstrap behavior while appearing secure in a narrow test.

Mail-worker and backup-reporter column/routine narrowing are separate controls. Completing either one does **not** close the broad `learncoding_app` / `learncoding_ops` risk.

**Target milestone:** post-mail-authority database privilege-separation hardening, before production pilot or learner-facing release exposure.

Before this finding can be closed, all ten acceptance gates must pass:

1. A checked-in role/table/column/routine manifest replaces both current and default blanket grants.
2. Every public object is classified as granted or explicitly denied; unknown future objects receive no runtime privileges.
3. PostgreSQL 18 fresh-install and upgrade paths pass bootstrap → migrate → reconcile twice, with exact `aclexplode`/column/routine/default-ACL comparison and no grant options.
4. Live positive gates cover auth signup/verification/login/reset/2FA/logout, admin bootstrap, seed replay, learner export, account deletion, retention dry/apply/replay, and every outbox producer.
5. Negative live probes prove:
   - app cannot mutate outbox state/payload or perform raw deletion;
   - ops cannot perform arbitrary user/evidence/outbox DML;
   - backup reporter cannot read tables;
   - no login can grant privileges, assume owner, or access another role's objects.
6. Live mail races cover purge vs worker/reconciler and deletion vs provider boundary in both lock orders.
7. Compose/restore/service-secret tests prove each container receives only its credential.
8. Writer inventory includes `scripts/backup/common.sh`, and that writer no longer uses the PostgreSQL superuser.
9. Exact-SHA rollback refuses privilege-contract regression.
10. Real deployment credential provisioning/rotation evidence exists; repository tests alone cannot prove the new secrets were installed correctly.

Production release requires either completion of all ten gates or explicit written, release-specific risk acceptance from `@thebrownhuman / DB-ACL/P3-2 DRI`. Any acceptance must identify the exact candidate SHA, expiry, compensating controls, and follow-up milestone. It is a temporary release decision and is never technical completion of P3-2. No external credential deployment or rotation has been performed or proven by this documentation change.

## Important architecture and implementation decisions

- Use Node 22.23.1 for release evidence. The system Node 22.18.0 is below the repository's evidence baseline; the local reviewed toolchain is `C:\tmp\node-v22.23.1-win-x64`.
- Pilot mode is uploads-disabled. Do not make ClamAV a pilot blocker and do not enable the `uploads` profile accidentally.
- No Codestead host ports are published in production. The dedicated Cloudflare Tunnel reaches `http://app:3000` over the internal network. Do not alter the user's existing host tunnel, reverse proxy, containers, or networks.
- The hostile-code runner remains a separate KVM guest with two slots and only the runner shared secret. Do not move trusted application secrets into it.
- Database secrets are file-backed, fixed-role, distinct, newline-free, initial-creation-only, and never printed. Never rotate them by rerunning the creation script over an existing inventory.
- Auth HTTP exposure is default-deny. Preserve only the reviewed minimum Better Auth routes; management/session/account/token/signup/link routes remain denied.
- Unsafe cookie-authenticated mutations require exact canonical Origin. Do not trust `Host` as a substitute.
- Backup policy decision: 120-second control timeout; minimum bulk rate 4 MiB/s; 600-second overhead per bulk leg; four-hour service budget; 600-second reserve; 30-hour maximum offsite age; hourly freshness polling.
- Rollback remains image-only by approved design. Do not claim source/config rollback without changing and reviewing that design.
- Database least privilege must be capability-based and server-authenticated. Client-set custom GUCs alone are not a trustworthy RLS identity.
- Evidence is exact-byte and exact-SHA bound. Never regenerate, reformat, or weaken a manifest merely to make a gate pass.
- A NUC without a UPS cannot guarantee the final keystroke before local persistence or an unacknowledged request. State this truthfully.
- Credentials previously pasted into chat, including NVIDIA NIM and 21st.dev keys, are compromised for this project and must be revoked; never reuse them.

## Known bugs and unresolved release blockers

The audit documents are the complete finding records. Current P1 status is:

- Frontend: exam recovery/closed-book fixes exist on an unintegrated branch. Google enrollment, verification resend, lost MFA recovery, fresh-MFA access recovery, onboarding recovery, manual TOTP setup, focus visibility, and modal focus containment remain open.
- Backend: auth route/password fixes, Origin enforcement, and partial retention fixes exist on unintegrated branches. Database least privilege and ambiguous mail delivery remain open. ClamAV topology remains a full-mode blocker.
- Quality/deployment: evidence digest repair, database-secret instructions, and Cloudflare instructions are fixed in the primary checkpoint. Backup fixes exist on an unintegrated branch. Rollback, retained load proof, candidate-bound runner identity, and final exact-SHA evidence remain open.

Important P2 examples still open include provider-credential mutation atomicity, crash-resumable admin bootstrap, historical migration hashes, PostgreSQL checksums, retention reclassification races, stored-digest download validation, streaming upload limits, durable per-user quotas, bounded AI responses, and full upload-mode promotion. See the audit files for exact acceptance criteria.

## Test state

### Passing evidence

- Primary main-worktree database-secret suite: 10/10.
- Existing database-secret validator: 7/7.
- Existing least-privilege static suite: 6/6.
- Contained WSL root fixture: exact root/group/modes passed.
- Static deployment validator, secret scan, focused ESLint, Bash syntax, ShellCheck, and `git diff --check`: passed after the atomic ceremony repair.
- Evidence verifier and affected executable checks: passed twice under Node 22.23.1 without mutation.
- Cloudflare static regression: passed; independent review accepted it.
- Auth branch: typecheck, 126 focused/adjacent tests, focused ESLint, and API-surface security passed.
- Origin/CSRF branch: 43 focused plus 15 auth-boundary tests; typecheck/lint/security gates passed.
- Exam branch: 81 adjacent tests; typecheck and targeted ESLint passed.
- Backup branch: backup config/consistency/systemd/offsite recovery, Bash syntax, and diff check passed.
- Retention branch: 13 focused plus 69 adjacent tests; typecheck and targeted lint passed.

### Intentionally failing evidence

- Database RED worktree: 4 Vitest failures and 3 static failures.
- Mail RED worktree: 5 expected failures.
- Rollback RED worktree: 1 expected contract failure.

### Not yet run or not yet accepted

- Full `npm run check` on the integrated candidate.
- Clean-checkout CI at the final SHA.
- Full PostgreSQL integration matrix after integration.
- Full authenticated browser matrix and accessibility evidence.
- Production Compose boot/restart/persistence and rollback at the final SHA.
- Full runner runtime/adversarial/CVE suite at the final SHA.
- Retained ten-learner/two-runner load evidence.
- Real NUC deployment, KVM, Cloudflare, Gmail, Google Drive, restore, reboot, and physical power-cut evidence.

## Install, start, build, and test commands

On Windows, use the exact release Node toolchain before evidence commands:

```powershell
$env:Path='C:\tmp\node-v22.23.1-win-x64;' + $env:Path
node --version
npm --version
npm ci
```

Local development requires a populated `.env`, PostgreSQL, and migration/bootstrap setup:

```powershell
Copy-Item .env.example .env
npm run db:migrate
npm run bootstrap:admin
npm run dev
```

Do not use demo auth settings as production evidence.

Core verification:

```powershell
npm run lint
npm run typecheck
npm run test
npm run test:auth-boundary
npm run test:integration
npm run test:e2e
npm run evidence:verify
npm run build
npm run check
```

Runner verification:

```powershell
Set-Location services\runner
npm ci
npm run typecheck
npm test
npm run build
npm run runtime:build
npm run runtime:test
```

Current focused main-worktree handoff checks:

```powershell
node --test infra/tests/database-secret-ceremony.test.mjs
node infra/tests/validate-static.mjs
npm run security:secrets
git diff --check
```

Production release entrypoint on the NUC, only after exact-SHA review and all preflight steps in `docs/deployment.md`:

```bash
sudo REPO_ROOT=/opt/learncoding \
  COMPOSE_ENV_FILE=/etc/learncoding/compose.env \
  COMPOSE_FILE_PATH=/opt/learncoding/compose.yaml \
  bash /opt/learncoding/infra/ops/release-production.sh --acquire-images --bootstrap-admin
```

Omit `--bootstrap-admin` after the initial release. Never run the transaction against a developer worktree or moving branch.

## Required environment variables and secret files

Never put values in this document. Local variable names are defined in `.env.example`:

- Core/auth: `APP_URL`, `NEXT_PUBLIC_APP_URL`, `SOURCE_CODE_URL`, `APP_NAME`, `NODE_ENV`, `AUTH_REQUIRED`, `DATABASE_URL`, `BETTER_AUTH_SECRET`, `RATE_LIMIT_HASH_KEY`, `RATE_LIMIT_TRUSTED_IP_HEADER`, `RATE_LIMIT_OVERRIDES_JSON`, `LOST_DEVICE_PROOF_KEY`, `DELETION_TOMBSTONE_KEY`, `CREDENTIAL_MASTER_KEY`.
- Initial admin/OAuth: `BOOTSTRAP_ADMIN_EMAIL`, `BOOTSTRAP_ADMIN_NAME`, `BOOTSTRAP_ADMIN_PASSWORD`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`.
- AI: `NVIDIA_NIM_VALIDATION_MODEL`, `NVIDIA_NIM_TUTOR_MODEL`, `CUSTOM_OPENAI_BASE_URL`, `CUSTOM_OPENAI_ALLOWED_HOSTS`.
- Runner/storage/uploads: `RUNNER_BASE_URL`, `RUNNER_SHARED_SECRET`, `RUNNER_MAX_CONCURRENCY`, `OBJECT_STORAGE_PATH`, `CLAMD_HOST`, `CLAMD_PORT`, `CLAMD_TIMEOUT_SECONDS`, `UPLOAD_SCAN_POLL_SECONDS`, `UPLOAD_SCAN_BATCH_SIZE`, `UPLOAD_SCAN_LEASE_SECONDS`, `UPLOAD_SCAN_MAX_ATTEMPTS`, `UPLOAD_SCAN_RETRY_BASE_SECONDS`, `UPLOAD_SCAN_RETRY_MAX_SECONDS`.
- Mail/backup/operations: `MAIL_ADAPTER`, `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REFRESH_TOKEN`, `MAIL_FROM`, `GOOGLE_DRIVE_CLIENT_ID`, `GOOGLE_DRIVE_CLIENT_SECRET`, `GOOGLE_DRIVE_REFRESH_TOKEN`, `GOOGLE_DRIVE_FOLDER_ID`, `LOG_LEVEL`, `SENTRY_DSN`, `GITHUB_TOKEN`.

Production non-secret configuration names are in `infra/env/compose.env.example`; backup names are in `infra/env/backup.env.example`. The required file-backed secret inventory and metadata are authoritative in `infra/secrets/README.md`. Do not expose or copy secret values into Git, commands, logs, reports, or chat.

## Services, ports, databases, and background processes

At the handoff snapshot on the Windows development machine:

- No project Node/npm/Vitest/Playwright process was running.
- No Docker container was running, including no Compose project container.
- A separate local `postgres` process was listening on port 5432. It was not started or stopped during handoff and must not be assumed to contain disposable data.
- No development web port was listening among 3000, 3001, 3002, 4000, 8080, or 8085.
- All Codex subagents exited; no agent remains active.

Production Compose defines the trusted PostgreSQL/app/bootstrap/migration/verifier services, runner egress gateway, mail/reward/regrade/exam/practice/project workers, file-erasure and lifecycle services, platform/admin seed services, Cloudflare, and opt-in ClamAV/scanner services. The exact model is in `compose.yaml` and must be rendered only with reviewed production environment and secret files.

Last user-reported NUC baseline, not freshly verified in this handoff: `192.168.68.114`, Ubuntu 24.04.4, Docker 29.6.1, Compose 5.3.1, cloudflared 2026.7.1, and Tailscale 1.98.8. The user's existing `portfolio`, `email-service`, `watchtower`, `roadmap-tracker`, and `my-nginx` containers were healthy after reboot. Do not alter them or treat this old report as current release evidence.

## Pending migrations, installations, and external setup

- No new migration was created in the main worktree or partial lanes. Database least privilege and mail reliability are expected to require a reviewed next migration, likely after current migration `0056`; do not invent or renumber it without inspecting the journal.
- The final integrated application migration has not been applied to production.
- The exact Node 22.23.1 development toolchain exists under `C:\tmp`; do not rely on system Node 22.18.0 for release evidence.
- NUC KVM guest provisioning, production image acquisition, age/rclone configuration, fresh external credentials, Cloudflare Access, Gmail, Google Drive, and supervised recovery evidence remain pending or unverified.

## Security, performance, and data-loss risks

- Runtime database roles currently have overly broad CRUD and cannot be considered least privilege.
- Gmail delivery can be duplicated after an ambiguous provider result and can race account deletion.
- Current rollback proof does not safely cover the full service manifest or previous configuration provenance.
- Retained load evidence can accept redirects instead of authenticated work.
- Runner evidence is not yet bound to the exact candidate/guest identity.
- Full uploads mode has unresolved ClamAV topology and promotion issues; keep it disabled.
- External backup/restore and physical-power evidence is absent.
- Without a UPS, an acknowledged locally persisted write can be protected, but the final unpersisted keystroke or unacknowledged request cannot be guaranteed.
- Stable isolated branches have not been combined; integration conflicts or regressions remain possible.
- The RED worktrees are valuable test scaffolds. Removing worktrees or running destructive Git commands would lose uncommitted work.

## Features and invariants that must not be changed

- Do not expand curriculum/content or add product features during this deployment goal.
- Do not enable uploads or learner invitations before the pilot gates pass.
- Do not weaken authentication, mandatory MFA, one-device policy, exact Origin checks, secret masking/encryption, evidence hashing, hidden-test secrecy, runner isolation, or closed-book exam behavior.
- Do not alter the user's existing NUC tunnel, containers, networks, reverse proxy, or restart behavior.
- Do not reuse any API key pasted in chat.
- Do not publish host ports, run learner code on the trusted app host, or place application secrets in the runner guest.
- Do not claim curriculum editorial verification, production readiness, or external evidence without proof.
- Do not reset, clean, discard, overwrite, or delete user changes or isolated worktrees.

## Recommended next-session workstreams

1. Coordinator/integration reviewer: independently inspect and integrate the five clean commits, one at a time.
2. Database authorization: resume the RED database worktree and implement the manifest/capability/RLS design.
3. Mail reliability: resume the RED mail worktree and implement provider-boundary fencing and deletion serialization.
4. Rollback/recovery: resume the RED rollback worktree, then independently review backup integration.
5. Evidence lane: complete authenticated load and candidate-bound runner proof.
6. Frontend/auth/accessibility: close the remaining P1 flows without expanding product scope.
7. Final verification: clean checkout, full CI/test matrix, Compose/recovery rehearsal, then exact-SHA NUC rollout.

Agents may parallelize isolated worktrees, but one coordinator must own integration, review every returned diff, and keep `main` free of partial RED work.

## Exact first actions for the new coordinating agent

1. Read this file, `SESSION_STATE.md`, the persistent goal objective, the approved deployment design, and all three audit documents completely.
2. Run `git status --short --branch`, `git log -3 --oneline`, and `git worktree list --porcelain`. Confirm the handoff commit exists and that the three partial worktrees still contain the exact uncommitted files listed above.
3. Set Node 22.23.1 on `PATH`; run only `git diff --check`, `node infra/tests/validate-static.mjs`, and the focused database-secret suite to validate the checkpoint before changing anything.
4. Independently review commit `e07899d...`; if accepted, integrate it into `main`, run its focused checks, and then repeat for CSRF, exam, retention, and backup. Do not merge all five blindly.
5. Preserve the RED database/mail/rollback diffs and resume implementation from their reports. Do not replace their tests with weaker assertions.
6. Update this handoff after every accepted integration and keep unsupported production claims blocked.

## Superseding Task 8 checkpoint — 2026-07-28

This section supersedes older Task 8 status statements above. The working branch is
`main`; its pre-checkpoint base is `cb91a86cc1a2`. Docker and the pre-existing
Windows PostgreSQL service/port 5432 were not started, stopped, or modified.

Task 8's repository-scoped CI/roles/capabilities/restore/rollback core is complete
in the current commit candidate:

- restore bootstrap now pins one target session and one maintenance session,
  proves same-instance authority with an unguessable `pg_stat_activity`
  application-name nonce, restores the previous marker, and preserves cleanup
  failures after acknowledged re-enable;
- PostgreSQL advisory locks were explicitly rejected for the cross-database
  identity proof because they are database-scoped;
- the host-operations compatibility digest binds non-secret environment values
  while redacting secret contents and failing closed on malformed or unresolved
  entries;
- restore failure diagnostics are bounded and redact URLs and named secret
  values;
- production release and rollback simulations both finish with their exact
  success markers.

Verified evidence for this candidate:

- native disposable PostgreSQL 17.10 restore-role proof: PASS;
- native disposable PostgreSQL 18.1 restore-role proof: PASS;
- database least-privilege behavior: 47/47;
- database role-boundary suite: 76/76;
- restore role-boundary harness: 45/45;
- host-operations compatibility: 12/12;
- migration role contracts: 0064 4/4, 0066 5/5, 0067 41/41, 0068 4/4,
  and 0069 5/5;
- full root-owned release simulation: `release-production-tests-ok`;
- full root-owned rollback simulation: `rollback-production-tests-ok`;
- full repository lint, TypeScript typecheck, and production build: PASS;
- tracked/unignored commit-candidate secret scan: 2,834 files, zero findings;
- `git diff --check`: PASS (line-ending normalization warnings only).

Explicitly deferred, not silently green:

- P3-2 broad `learncoding_app`/`learncoding_ops` CRUD remains open. It is
  deferred for the user's local/few-user scope, is not technical completion,
  and must be narrowed or accepted against an exact SHA before any production
  or learner-facing deployment;
- signal-cleanup race hardening, Windows DACL proof, and an outer lifecycle
  deadline for the disposable restore harness remain Task 10 defense-in-depth
  work;
- live Gmail, NUC, Cloudflare, Google Drive, reboot, and supervised power-cut
  evidence still requires the real services/hardware and remains unproven.

After this checkpoint is pushed, the next repository task is Task 9's complete
live concurrency/deletion race execution, followed by Task 10's clean-checkout
release matrix and repair of any final failures.

## Superseding Task 9 core-race checkpoint - 2026-07-28

This section supersedes the Task 9 next-step statement immediately above for the
user-approved local/few-user scope. The checkpoint base is
`7eb10c0e8b7a3993db03869b2f6c39144f458c64` on `main`.

The competing-claimer regression now proves the exact authoritative row rather
than accepting an aggregate false green:

- `CLAIM-02` proves one pending row wins and its same-scope sibling remains
  pending and unleased;
- `CLAIM-03` proves the specifically expired row is reclaimed, its fence
  advances exactly once, its attempt count becomes two, its owner/token are
  replaced, and the untouched sibling remains pending and unleased.

Live native disposable evidence:

- PostgreSQL 17.10: 25/25 focused mail/deletion races passed in 454.19 seconds;
- PostgreSQL 18.1: 25/25 focused mail/deletion races passed in 452.52 seconds;
- covered competing pending claimers, competing expired reclaimers, provider
  boundary rollback and commit-ack uncertainty, exact guarded-dispatch
  boundary text, both finalizer/sweeper lock orders, definite-rejection
  recovery, both provider/deletion orders, deletion lifecycle serialization,
  notice deduplication/retry, and tombstone replay after final-commit
  acknowledgement loss;
- both native clusters used private random non-5432 loopback ports, then
  stopped with zero remaining process, listener, or disposable root;
- Docker, the Windows PostgreSQL service, and port 5432 were not touched.

Scope boundary, deliberately not reported as green:

- the older production-certification design's dedicated 40-case/66-leaf
  reporter, crash-child, protocol-proxy, and paired evidence framework is not
  implemented;
- that larger production-grade framework remains deferred under the user's
  local/few-user scope and would be required before claiming full
  production-scale race certification;
- external Gmail and device/service evidence remains unproven.

The next repository task is Task 10: run the complete clean-checkout release
matrix, repair any failures, and preserve the same explicit scope boundary.
