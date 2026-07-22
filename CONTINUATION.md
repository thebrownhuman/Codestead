# Codestead continuation handoff

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
