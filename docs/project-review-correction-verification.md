# Project-review corrective re-analysis verification

Verified on 2026-07-12. This report covers the locally automatable correction gaps in PRJ-005, DAT-007, ADM-004, and RUN-007.

## Implemented authority chain

1. Every stored project review binds the exact public GitHub commit SHA, analyzer version, rubric version, findings hash, explicit provenance, and—when AI-assisted—the exact `model_call_id`. The configured reviewer declares `deterministic_static`, `aiUsed: false`, null prompt/model fields, `repositoryExecution: none`, and no runner template. Correction intake and completion reject provenance whose rubric does not match the authoritative stored/result rubric, and a non-null model-call binding cannot later be cleared.
2. A learner appeal snapshots and hashes the original review, including its rubric, provenance, and findings hash. A fresh-MFA administrator overturn, or the separate fresh-MFA defective-review action, atomically appends a versioned correction row and hashed queue event. A correction's non-null source-appeal binding cannot later be cleared.
3. HTTP handlers only queue work. A separately deployed `project-review-correction-worker` polls the durable PostgreSQL queue, leases work with `FOR UPDATE SKIP LOCKED`, and resolves the exact preserved SHA through bounded GitHub metadata/tree/blob requests. It never clones, installs, builds, invokes hooks, executes repository code, or sends repository code to a runner or AI provider.
4. The worker appends result findings, result provenance, canonical evidence hashes, and timeline events. Every settlement compares both the worker identity and the monotonically increasing attempt generation. An expired same-host attempt therefore cannot settle after recovery/reclaim, even if the replacement uses the same worker label. Expired leases append failure evidence and notify administrators before eligible work is reclaimed. Three failed attempts produce visible dead-letter state; an exhausted correction cannot be silently retried and requires a newly reviewed correction version.
5. `project_review_effective` is a replaceable read projection, not source evidence. Only the authoritative review/correction writers can mutate it. A correction advances it only while its source review remains current; otherwise the correction is preserved with `projectionApplied: false` and cannot overwrite a newer review.
6. Queue and retry request IDs are exact-replay safe and reject changed-payload reuse. Project advisory locks, unique version constraints, worker leases, bounded attempts, and projection locks cover concurrency. Failure leaves the effective review unchanged.
7. Original reviews, completed correction evidence, and correction events reject mutation or ordinary deletion. The account-deletion transaction explicitly authorizes and orders correction, appeal, and project removal so provenance cannot be erased through a foreign-key shortcut.
8. Learner export includes the original review, corrections, correction events, and effective projection with bounded findings, hashes, and provenance while excluding worker/admin identities. Correction evidence is projected through an explicit allowlist: the stored administrator ID is removed, the canonical hash of the persisted correction reason remains, and the export states that its redacted evidence cannot reproduce the unredacted evidence hash. Learners receive queue/completion notices; administrators receive failure/dead-letter notices. The administrator UI exposes provenance, evidence-hash validity, projection outcome, retry state, dead-letter state, and the append-only timeline.

Migration [`0030_goofy_roxanne_simpson.sql`](../drizzle/0030_goofy_roxanne_simpson.sql) adds the provenance columns, correction ledger, event timeline, effective projection, constraints, and immutability triggers. Migration [`0031_easy_deathstrike.sql`](../drizzle/0031_easy_deathstrike.sql) adds retry/dead-letter state, provenance-preserving foreign keys, authorized-deletion guards, and authoritative projection-write guards. Migration [`0033_project_review_ledger_fencing.sql`](../drizzle/0033_project_review_ledger_fencing.sql) closes the nullable model-call/source-appeal immutability loopholes; attempt-generation fencing is enforced by the worker service.

## Verification results

- `NODE_OPTIONS=--throw-deprecation` focused Vitest: **15 files, 81 tests passed**.
- Disposable PostgreSQL: the complete migration chain applied twice; [`project-review-correction.integration.test.ts`](../integration/project-review-correction.integration.test.ts) passed **5/5 tests in 1.76 s**.
- Full `npm.cmd run typecheck`: passed.
- Focused ESLint over the changed correction, lifecycle, route, worker, UI, and integration files: passed.
- The reviewed privacy inventory still names all **90** declared PostgreSQL tables.

The PostgreSQL tests cover human overturn linkage, exact-SHA/no-AI/no-execution provenance, non-null model-call and source-appeal immutability, original preservation, effective supersession, concurrent single leasing, same-host stale-attempt fencing after expiry/reclaim, exact and mismatched replay, non-admin rejection, evidence/event hash validation, ordinary update/delete rejection, authorized account-deletion ordering, learner-export administrator-ID canary/redaction, safe analyzer failure, explicit retry, interrupted-worker lease recovery, bounded dead-lettering, administrator notice, and stale-correction suppression.

Machine-readable evidence: [`project-review-correction-verification-2026-07-12.json`](evidence/project-review-correction-verification-2026-07-12.json).

## Honest remaining limits

- No authenticated browser journey has exercised the entire learner appeal → fresh-MFA administrator overturn → durable worker → GitHub re-analysis → learner notification path against a live public repository.
- The crash/reclaim/dead-letter proof uses disposable PostgreSQL fault simulation, not a deployed multi-process worker interruption drill.
- Launch 1 still intentionally rejects private repositories; the future read-only GitHub App is tracked under PRJ-003.
- Static analysis has no approved build/run templates. Any future executable review requires a separately reviewed runner template and sandbox evidence.
- Standalone practice/code-submission correction, unified AI/content report adjudication, concept-probability replay, and the deployed-runner RUN-007 correction drill remain open.
