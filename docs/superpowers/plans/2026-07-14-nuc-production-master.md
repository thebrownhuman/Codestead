# Codestead NUC Production Master Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to execute the linked plans task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce, verify, and deploy a recoverable Codestead private pilot on the existing Ubuntu NUC without changing unrelated host services.

**Architecture:** Five focused plans own trusted runtime, browser durability, backup/recovery, the isolated KVM runner/NUC rollout, and the final security release gate. They execute sequentially where files overlap, while each task follows test-first red/green/refactor and receives an independent task review.

**Tech Stack:** Next.js 16, React 19, TypeScript, PostgreSQL 17, Docker Compose 5, Bash, systemd, age, rclone, libvirt/KVM, cloud-init, nftables, Vitest, Playwright.

## Global Constraints

- The approved source of truth is `docs/superpowers/specs/2026-07-14-nuc-production-deployment-design.md`.
- Work directly on `main` and push `main`; the user explicitly requested no pull request.
- Pilot uploads stay disabled and ClamAV remains outside the default profile.
- Existing NUC services, ports, networks, host tunnel, and data are never changed by Codestead automation.
- No secret is committed, printed, copied into an image, or taken from credentials previously pasted into chat.
- Untrusted code runs only inside the dedicated KVM guest.
- No completion claim is made for Cloudflare, Gmail, Google Drive, NUC, reboot, or AC-loss evidence until that exact external action has been observed.
- Acknowledged server writes and browser records marked saved locally must survive their documented crash boundaries; no guarantee covers a keystroke before local persistence or an unacknowledged request.

---

## Plans

1. `docs/superpowers/plans/2026-07-14-nuc-runtime-deployment.md`
2. `docs/superpowers/plans/2026-07-14-browser-power-durability.md`
3. `docs/superpowers/plans/2026-07-14-backup-recovery.md`
4. `docs/superpowers/plans/2026-07-14-runner-nuc-rollout.md`
5. `docs/superpowers/plans/2026-07-15-production-security-release-gate.md`

## Execution Order

- [ ] Runtime Tasks 1-6: fail-closed pilot, migration/operations, profiles, secrets, health, retention/boot.
- [ ] Browser Tasks 1-6: IndexedDB substrate, draft recovery, exam receipts/outbox, purge, browser crash proof.
- [ ] Backup Tasks 1-6 plus 3A: secure primitives, consistent publication, daily offsite proof, fail-closed remote retention, recovery kit, restore drill, schedules.
- [ ] Runner Tasks 1-6: regression contracts, VM/network, guest/firewall, durability, startup monitor, evidence/runbook.
- [ ] Runtime Task 7, Browser Task 7, Backup Task 7, Runner Task 7: focused and complete repository verification.
- [ ] Security Tasks 1-7: create the immutable detached candidate, run dependency lifecycle work only in the no-secret/no-socket script-disabled-then-reviewed sandbox, and complete repository, crypto, auth/API/RLS/PostgreSQL/browser/runner review on disposable targets.
- [ ] Security Task 11 internal loop: repair and independently re-review every Task 1-7 release blocker, then freeze a new externally testable SHA; no NUC mutation starts before this internal verdict is clean.
- [ ] Runner Task 8 non-physical phases: same-NUC Codestead-project deployment and rollback using the frozen candidate. Its AC checklist is prepared here but executed once by the final Security Task 9 gate.
- [ ] Security Task 8, Task 9 non-physical phases, and Task 10: verify deployed container/tunnel/secret/provenance boundaries, offsite restore and rollback, then the pre-approved 10/60/10-minute ten-learner/two-slot load/fault matrix using target-class safeguards.
- [ ] Security Task 11 external loop: repair/re-review any deployed finding, create a new candidate, rerun the complete non-destructive matrix and invalidated external rows, and apply the AC-evidence invalidation rule.
- [ ] Security Task 9 final sequence: after every other mandatory external row is `PASS`, perform the controlled reboot and then the single administrator-supervised AC-loss rehearsal as the last pre-invitation gate. Repeat physical AC only for an invalidating durability/startup change with explicit administrator approval.
- [ ] Security Task 11 final verdict: emit separate repository `PASS | FAIL` and pilot `GO | HOLD` decisions; any mandatory external `NOT_RUN` or `FAIL` keeps the pilot on `HOLD`.
- [ ] Requirement-by-requirement completion audit against the approved design and saved goal objective.

## Coverage Matrix

| Approved requirement | Authoritative implementation plan |
|---|---|
| Current CI and Compose failure | Runtime Tasks 3 and 7 |
| Secret GID, exact modes, full inventory | Runtime Task 4 |
| Advisory-locked migration, seed, admin bootstrap | Runtime Tasks 2-3 |
| Uploads-off pilot and optional scanner | Runtime Tasks 1 and 3 |
| Liveness, DB readiness, worker/tunnel smoke | Runtime Task 5 |
| Immutable images, Watchtower opt-out, retention | Runtime Tasks 3 and 6 |
| Browser-durable lesson drafts | Browser Tasks 1-2 |
| Exactly-once exam answer/event recovery | Browser Tasks 3-4 |
| Logout, revocation, finalization purge | Browser Task 5 |
| Browser crash/reopen evidence | Browser Task 6 |
| Consistent encrypted backup publication | Backup Tasks 1-2 |
| Google Drive upload/download verification | Backup Task 3 |
| Google Drive 7 daily/4 weekly/12 monthly retention | Backup Task 3A and Task 6 |
| Separate credential recovery kit | Backup Task 4 |
| Isolated offsite restore drill and RPO/RTO | Backup Task 5 |
| Persistent backup/offsite schedules | Backup Task 6 |
| 4-vCPU/8-GiB/100-GiB isolated KVM runner | Runner Tasks 1-3 |
| Two jobs, runtime isolation, private firewall | Runner Tasks 2-3 |
| PostgreSQL durability and stop budgets | Runner Task 4 |
| Automatic boot, VM/container/timer recovery | Runner Task 5 |
| Reboot/power-cut evidence and 15-minute target | Runner Tasks 6 and 8 |
| Exact install/update/rollback/disaster commands | Runner Tasks 6 and 8 plus all three operational runbooks |
| Static/dependency/secret/container/IaC security audit | Security Tasks 1-2 and 8 |
| Immutable detached candidate and candidate-change invalidation | Security Tasks 1-2 and 11 |
| Isolated dependency lifecycle execution and supply-chain provenance | Security Tasks 2 and 8 |
| Auth/API/IDOR/CSRF/injection/SSRF manual and dynamic audit | Security Tasks 3-4 |
| Cryptographic primitive/key separation, tamper, rotation, and recovery audit | Security Task 4 crypto/key sub-gate |
| PostgreSQL RLS/privilege/concurrency/integrity/performance audit | Security Task 5 |
| Browser cross-user and crash-boundary adversarial audit | Security Task 6 |
| Runner escape/network/resource-abuse audit | Security Task 7 |
| Disposable-only/project-only/NUC-read-only/human-supervised safety envelopes | Security Rules of Engagement and Tasks 1-10 |
| Backup/rollback, RPO ≤24h, RTO ≤4h, reboot and one-time power-loss audit | Security Task 9 |
| Ten-learner/two-slot fixed-duration load, thresholds, aborts, and failure injection | Security Task 10 |
| Cloudflare/Gmail/OAuth/NIM/Drive/KVM/reboot/AC external gate ledger | Security Verdict Model and Tasks 8-11 |
| Finding remediation, accountable residual acceptance, and separate repository/pilot verdicts | Security Task 11 |

## Completion Evidence

The goal remains active until automated gates pass from the final committed tree and every mandatory external row is `PASS`. Automated records contain exact argv, safety class, candidate/tree identity, timestamps, versions/ruleset/database identities, exit status, and artifact hashes; manual records contain observer/approver, target, window, expected/observed result, status, artifact hash, and invalidation rule. The final audit also records image provenance/signatures, backup ID, measured RPO/RTO, load thresholds/results, restore/reboot/AC evidence, and accountable residual-risk approvals. Repository proof may be complete while external rows are `NOT_RUN`, but that state is explicitly `PILOT RELEASE VERDICT = HOLD` and cannot enable invitations.
