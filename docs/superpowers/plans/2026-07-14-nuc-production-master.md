# Codestead NUC Production Master Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to execute the linked plans task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce, verify, and deploy a recoverable Codestead private pilot on the existing Ubuntu NUC without changing unrelated host services.

**Architecture:** Four focused plans own trusted runtime, browser durability, backup/recovery, and the isolated KVM runner plus NUC rollout. They execute sequentially where files overlap, while each task follows test-first red/green/refactor and receives an independent task review.

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

## Execution Order

- [ ] Runtime Tasks 1-6: fail-closed pilot, migration/operations, profiles, secrets, health, retention/boot.
- [ ] Browser Tasks 1-6: IndexedDB substrate, draft recovery, exam receipts/outbox, purge, browser crash proof.
- [ ] Backup Tasks 1-6: secure primitives, consistent publication, offsite proof, recovery kit, restore drill, schedules.
- [ ] Runner Tasks 1-6: regression contracts, VM/network, guest/firewall, durability, startup monitor, evidence/runbook.
- [ ] Runtime Task 7, Browser Task 7, Backup Task 7, Runner Task 7: focused and complete repository verification.
- [ ] Runner Task 8: same-NUC deployment, rollback rehearsal, controlled reboot, and supervised AC-loss evidence.
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
| Separate credential recovery kit | Backup Task 4 |
| Isolated offsite restore drill and RPO/RTO | Backup Task 5 |
| Persistent backup/offsite schedules | Backup Task 6 |
| 4-vCPU/8-GiB/100-GiB isolated KVM runner | Runner Tasks 1-3 |
| Two jobs, runtime isolation, private firewall | Runner Tasks 2-3 |
| PostgreSQL durability and stop budgets | Runner Task 4 |
| Automatic boot, VM/container/timer recovery | Runner Task 5 |
| Reboot/power-cut evidence and 15-minute target | Runner Tasks 6 and 8 |
| Exact install/update/rollback/disaster commands | Runner Tasks 6 and 8 plus all three operational runbooks |

## Completion Evidence

The goal remains active until automated gates pass from the final committed tree and external-only items are either observed or explicitly reported as unfinished. The final audit records command, timestamp, exit status, test counts, Git commit, image identities, backup ID, restore result, and NUC evidence for every acceptance criterion.
