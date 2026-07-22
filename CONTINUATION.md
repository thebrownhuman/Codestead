# Codestead continuation checkpoint

Date: 2026-07-22 (Asia/Kolkata)
Branch at wind-down: `main`
Base before this checkpoint: `90a441cf6cb76af07c8e8f97658d59bd55615ce8`
Status: resumable engineering checkpoint; **not a production release candidate**

## Why execution stopped

The user requested an immediate safe wind-down: no new feature work, finish active writes, stop agents, test completed work, document the exact state, and commit a resumable checkpoint. All active subagents stopped and reported that they own no remaining background process. Candidate #3 was rejected before wind-down because its clean checkout exposed six stale evidence hashes.

## Completed work

### Deterministic evidence publication

- Added `scripts/lib/deterministic-evidence.ts` and focused tests in `scripts/lib/deterministic-evidence-verifiers.test.ts`.
- Default and `--check` modes are read-only; only explicit `--apply` may publish evidence.
- Check mode pins reads to a file handle and verifies pre/post identity.
- Apply mode stages, syncs, renames, and verifies final file identity.
- Evidence targets must be direct `.json` children of the real `docs/evidence` directory; symlinks and hardlinks are rejected.
- Apply requires the explicit `trustedDirectory: "exclusive-writer"` contract. The runtime error documents that portable Node does not provide `openat`/`renameat` namespace isolation.
- Strict option parsing rejects unknown, duplicate, malformed, or out-of-range arguments.

The helper is integrated into all seven producers:

1. `scripts/verify-api-auth-surface.ts`
2. `scripts/verify-import-boundaries.ts`
3. `scripts/verify-ai-code-tasks.ts`
4. `scripts/verify-c-cpp-executable-tranche.ts`
5. `scripts/verify-dsa-language-parity.ts`
6. `scripts/verify-java-python-code-tasks.ts`
7. `scripts/verify-web-executable-tranche.ts`

`package.json` contains explicit read-only check commands and separate intentional apply commands. `docs/security-authorization-verification.md` documents the distinction.

Two independent reviews accepted this implementation with no remaining Critical or Important finding under the stated trusted-build-writer boundary.

### Source-worktree evidence repair

- Intentionally regenerated only the stale architecture and Web structure reports.
- Repaired 17 verifier-reported SHA-256 declarations across five manifests without weakening `scripts/verify-evidence-integrity.ts`.
- Source-worktree `evidence:verify` is currently green: 69 Markdown files, 268 local links, 81 evidence JSON files, 70 referenced paths, and 131 declared hashes.
- Two wrapped integrity runs proved 84 evidence-directory files unchanged by path, bytes, SHA-256, length, and mtime.

### Frozen candidate #3

The reviewed freeze script `C:\tmp\freeze-codestead-candidate-v2.ps1` (SHA-256 `7DF4898F7BA6595EA9EC445CC541369879BF751E44186141126F1BF2C5F6C70B`) created:

- Detached commit: `05031d25b19b963ccaca6817837ede8635c987d0`
- Tree: `7cff9370eee0309608e23a18d30e6ebda3cb89a5`
- Candidate path: `C:\Users\Shivansh\AppData\Local\Temp\learncoding-candidate-4d71dc45fc39472d849c5d1eff206756\repo`
- Audited paths: 701
- Generated artifacts excluded: 29
- Secret scan: passed
- Original HEAD, refs, and index were guarded against mutation during capture.

Candidate #3 is **rejected**, not releasable. See Known bugs below.

### Verification completed at wind-down

Using portable Node `v22.23.1` and npm `10.9.8`:

- `npm exec vitest run scripts/lib/deterministic-evidence-verifiers.test.ts --reporter=dot` — 10/10 passed.
- `npm run typecheck` — passed.
- ESLint over the helper, focused test, and seven producers — passed.
- `security:api-surface` — passed, evidence unchanged.
- `architecture:check` — passed, evidence unchanged.
- `ai-code:executable:check` — passed, evidence unchanged.
- `c-cpp:executable:check` — passed, evidence unchanged.
- `dsa:parity:check` — passed, evidence unchanged.
- `java-python:executable:check` — passed, evidence unchanged.
- `web:executable:check` — passed, evidence unchanged.
- Source-worktree `evidence:verify` — passed.
- Runner `typecheck` — passed.
- Runner Vitest — 96 passed, 1 skipped.
- Runner Node runtime-contract suite — 51 passed.
- Runner build — passed.
- Candidate #3 secret scan — passed.
- Candidate #3 `git diff --check` — passed.
- Git unmerged-index check — no conflicts.

### Cleanup completed

- Removed exactly 29 untracked `.rej`, `.orig`, and top-level `.patch` artifacts after verifying that every resolved target was a non-reparse-point file inside the workspace.
- No `git reset`, `git clean`, destructive checkout, host mutation, or laptop restart was performed.

## Architecture decisions retained

- Ubuntu NUC deployment remains Docker Compose based, with systemd/restart recovery and Cloudflare Tunnel ingress.
- PostgreSQL is the durable system of record. Runner execution remains isolated from the application host process.
- Client-side games remain separate from NUC code runners.
- Learner provider keys remain encrypted at rest; ordinary views reveal only the last four characters. Full reveal requires fresh MFA, reason, audit, and learner notification.
- Release evidence is fail-closed and must bind the exact release bytes.
- Evidence producer verification must never mutate tracked files.
- Evidence regeneration is an explicit administrator/build action.
- The evidence directory is treated as an exclusive-writer trusted build directory during apply.
- `.gitattributes` forces repository text, including TypeScript/TSX/JSON, to LF. Clean-checkout proof is authoritative; a green mixed-line-ending Windows worktree is insufficient.
- Generated conflict/review artifacts (`*.rej`, `*.orig`, and top-level `*.patch`) are excluded from candidates and commits.
- Browser, application, PostgreSQL, runner-runtime, infra, clean-checkout, CI, and external NUC evidence must all be proven against the same accepted candidate before release.

## Known bugs and failing tests

### Release blocker: clean-checkout evidence integrity

Candidate #3 `npm run evidence:verify` exits 1 with six stale declarations:

1. `docs/evidence/exm-003-006-008-reliability-2026-07-12.json`
   - Source: `src/app/api/exams/_lib/service.ts`
   - Declared: `893192f8964979c8421afb0998a3bb5c2f20aa2e846bd0bcddbcace070ff63ba`
   - Clean-checkout actual: `e11f966b69b96a65e62e5ab80eb9913986bbcd776b36e2171acd8caa5edc04a2`
2. `docs/evidence/project-review-correction-verification-2026-07-12.json`
   - Source: `src/lib/data-lifecycle/export.ts`
   - Declared: `824614e202e3ab06892ede41d371bc98e68cd5d1fadd5d315e7733fff36ceb13`
   - Clean-checkout actual: `e95fdfc268a2bc17742a1da6d21669dae5f4818ae6179c142b7a90f40434b3a4`
3. `docs/evidence/run-008-official-runner-fairness-2026-07-12.json` repeats both mappings above.
4. `docs/evidence/ses-004-dat-003-draft-sync-2026-07-12.json`
   - Source: `src/components/lesson/lesson-workspace.tsx`
   - Declared: `3068e1425f6351b0b53989470ddf83bb0ab67ce20e550e0ca1fd43427f80d287`
   - Clean-checkout actual: `a793afd7ddfae26fb9d2637e9317d9e82a8cb0df46184426fc686a10752b90ce`
5. The same SES/DAT manifest also references `src/lib/drafts/browser-cache.ts`:
   - Declared: `90c54820d1eb2de9ef9f7890851a6cc255140868057609fdc74154137c02a655`
   - Clean-checkout actual: `3ddd748388f383cff5c47b8280755eedca98731e2c2560e1f28d2a4f572d1a8c`

Diagnosis:

- Global Git configuration has `core.autocrlf=true`.
- `.gitattributes` explicitly sets `*.ts` and `*.tsx` to `text eol=lf`.
- Candidate #3 contains canonical LF bytes and exposes the six stale declarations.
- The original Windows worktree currently contains mixed CRLF/LF in the four referenced sources and therefore produces the older declared hashes. A root-worktree-only green verifier is misleading.

Do not release candidate #3. Normalize the four original-worktree sources to canonical LF, update exactly the six declarations above, and prove both the source worktree and a new clean checkout.

A guarded draft transformer was created at `C:\tmp\repair-codestead-canonical-lf-evidence.mjs` but was **never executed or syntax-checked** because wind-down began. Inspect it before use, or reimplement the exact repair with `apply_patch`.

### Gates with no accepted result

- Candidate #3 `npm run check` was interrupted after about 151 seconds when the candidate was rejected. It produced no pass/fail result.
- The PostgreSQL integration run was terminated when candidate #3 was rejected. It produced no accepted result.
- Browser candidate #3 roadmap diagnostic passed 20/20 across 10 repeats, but it is diagnostic only because the candidate is rejected.
- No focused access suite or full Playwright matrix ran on an accepted candidate.
- Runner Docker runtime build/inspect/test/scan/record was not completed in this wind-down.
- Linux-only infrastructure, topology, firewall, backup, restore, and power-loss CI gates remain unproven on an accepted candidate.
- Clean-checkout full application/build verification remains unproven.
- GitHub CI on the eventual checkpoint/release commit remains unproven.
- External NUC, Cloudflare, Gmail, Drive/offsite backup, and physical AC-loss recovery evidence remains unproven.
- Independent package-lock dependency provenance aggregation for candidate #3 was not completed.

## Files in the checkpoint

Before adding this document, the audited candidate contained 701 meaningful changed/new paths. The change spans these major areas:

- `.github/workflows`, Dockerfile, Compose, environment templates, systemd, tmpfiles, and sysusers.
- `infra/ops`, `infra/runtime`, `infra/runner`, `infra/runner-vm`, `infra/restore`, and infrastructure tests.
- PostgreSQL/Drizzle schema and migrations.
- Application APIs, authentication resilience, uploads/storage/data lifecycle, runner recovery, exams, dashboards, lesson UI, and browser durability.
- Curriculum/assessment banks and deterministic executable-course evidence.
- Backup, restore, rollback, ingress, production load, least-privilege database, and power-recovery plans/runbooks.
- Runner service and runtime image management.
- Release evidence and audit documents.

After this checkpoint commit, use these commands for the exact file list:

```powershell
git show --stat --oneline HEAD
git show --name-status --format= HEAD
```

Expected post-commit working state: no tracked or meaningful untracked source changes. Ignored `node_modules`, build/test output, the rejected temporary candidate, and diagnostic logs may remain outside the committed tree.

## Recommended next steps

1. Reconfirm `git status --short`, branch, HEAD, and no agent/test processes.
2. Inspect or recreate the exact six-digest repair. Normalize the four original source files to LF first; verify their SHA-256 values equal the clean-checkout actual hashes above.
3. Update only the six manifest declarations. Do not weaken or bypass `verify-evidence-integrity.ts`.
4. Run focused deterministic tests, typecheck, exact lint, all seven checks twice, and `evidence:verify` twice with hash/mtime non-mutation proof.
5. Freeze candidate #4 using the reviewed freeze script. Independently verify HEAD/tree/status, artifact exclusions, secrets, and clean-checkout evidence integrity before starting long gates.
6. Install exact root and runner lockfile dependencies with Node 22.23.1.
7. Run the full application check/build, PostgreSQL integration, runner static/runtime, infrastructure, browser, and clean-checkout gates against candidate #4.
8. Confirm the candidate remains clean after every gate.
9. Only after all local gates pass, commit/push the release candidate and inspect every GitHub Actions job.
10. Perform the external NUC/Cloudflare/Gmail/Drive/power-cycle checklist truthfully; do not substitute local simulations for external evidence.

## Agent and process shutdown record

- Browser agent: completed; zero owned Playwright/Next processes, zero listeners on diagnostic ports 64146 and 62662.
- Application-gate agent: completed; interrupted candidate #3 check and terminated only its exact orphaned Vitest PIDs; no owned processes remain.
- Exact-candidate reviewer: completed; no owned background process or pending command.
- Parent verification found zero candidate processes after excluding the inspection shell itself.
- All subagents were completed at wind-down; no new agent was launched after the stop request.

## Resumption rule

This checkpoint is intentionally honest: the completed deterministic-evidence work is tested, but the repository is not release-ready. Resume from the six canonical-LF evidence declarations, freeze candidate #4, and require requirement-by-requirement proof before using the words “ready” or “deployed.”
