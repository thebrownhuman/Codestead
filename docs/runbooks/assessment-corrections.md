# Faulty assessment correction and regrading

This runbook covers a reviewed deterministic exam test/form defect. It does not permit an AI model to change an answer oracle, hidden test, grade, or mastery state. The workflow is available at `/admin/assessment-corrections` and is protected by administrator authorization, fresh MFA, a reason, immutable target hashes, and audit events.

## Evidence and state model

- The original `attempt`, reserved result `response`, learner answers, form snapshot, code submissions, and runner jobs are never rewritten.
- `assessment_correction` binds an overturned appeal to one exact course/module/item/content version, faulty bundle version, and canonical grading-evidence hash. The reviewed replacement has a new bundle version, a pinned runtime image digest, canonical hash, and complete human checklist.
- `assessment_correction_impact` privately snapshots each exact affected attempt, form, latest answer revisions, and current official result. Four independent hashes protect the form, answer set, result, and complete snapshot. Near matches with a different test body/hash are excluded even when their display version is the same.
- `assessment_regrade_outcome` appends the corrected result, sanitized runner provenance, decision manifest, hashes, revision, and superseded outcome pointer. `assessment_attempt_effective_result` is only a mutable read projection to the newest append-only outcome.
- `assessment_mastery_adjustment` appends `award`, `revoke`, or `no_change` per skill/language facet. `assessment_mastery_projection_repair` then records whether that evidence was applied to one exact `concept_mastery` row or remains visibly unresolved/retryable. The existing module badge row is awarded/restored or has `revoked_at` set; its original award row remains preserved.
- Exam history/readiness, administrator attempt aggregates, and leaderboard exam evidence read `assessment_attempt_effective_result`; the raw `attempt` row remains immutable historical evidence. A corrected leaderboard event is dated by the effective projection update so a correction is not silently stranded in an already-closed weekly period.
- Database triggers reject updates to correction identity, impact snapshots, events, outcomes, and mastery adjustments.

## Operator workflow

1. Decide the learner appeal as `overturned` in `/admin/appeals`. Record the corrective action; do not manually edit a score.
2. Independently review the specification, expected outputs, visible/hidden edge coverage, and exact runner image digest. Store the evidence reference outside hidden-test payloads.
3. Open `/admin/assessment-corrections`. Enter the overturned appeal ID and exact item ID, then supply a new `runner-tests` bundle version, the reviewed test array, and the expected `sha256:<64 hex>` runtime image digest. Keep hidden coverage when the faulty version contained hidden tests.
4. Complete fresh MFA and create the correction. Check the affected count and per-attempt form/answer/result/snapshot hashes. The list/detail API never returns source code, original form bodies, or replacement hidden-test bodies.
5. Complete fresh MFA again and queue the correction. The dedicated `regrade-worker` leases jobs with `FOR UPDATE SKIP LOCKED`; the initial batch is capped at two.
6. Monitor the append-only timeline and mastery projection panel. `completed` means every captured impact has a superseding deterministic outcome **and every associated mastery projection repair is applied**. A pending repair keeps the correction `processing`; an unresolved repair keeps it `partially_failed`. The source appeal stays overturned/open in either case. The worker retries unresolved mappings daily after curriculum/enrollment repair. Never manually force an ambiguous mapping. A failed regrade job leaves original/effective evidence unchanged for that impact. Correct the runner/runtime incident, then queue eligible failed jobs again; at most three durable determinate failures are allowed. Worker lease recovery, capacity deferral, and indeterminate remote settlement do not consume that budget.
7. Confirm the learner received the generic `assessment-corrected` in-app/email notice. Scores and hidden tests are never included in email. The source appeal closes only after all impacts succeed and all mastery repairs are applied.

## Verification queries

Run these only through the root-owned operations path; do not paste result JSON or hidden-test bodies into tickets or logs.

```sql
select id, status, affected_count, row_version, created_at, completed_at
from assessment_correction
where id = :'correction_id';

select status, count(*)
from assessment_regrade_job
where correction_id = :'correction_id'
group by status;

select o.attempt_id, o.revision, o.original_result_hash,
       o.corrected_result_hash, o.runner_evidence_hash,
       m.effect, m.skill_id, m.language_context,
       p.status as projection_status, p.resolution_code,
       p.last_error_code as projection_error
from assessment_regrade_outcome o
join assessment_mastery_adjustment m on m.outcome_id = o.id
join assessment_mastery_projection_repair p on p.adjustment_id = m.id
where o.correction_id = :'correction_id'
order by o.created_at, m.skill_id;
```

For automated proof, run `npm run test:integration`. The disposable PostgreSQL suite verifies migration replay, exact-scope exclusion, request replay/mismatch, concurrent leases, process crashes both before and after runner admission, same-generation/idempotency reconciliation beyond the third lease, complete mixed-runtime form regrading, canonical Python `conceptual` and DSA `dsa:<language>` projection, durable unresolved mapping and completion gating, effective administrator/leaderboard consumers, original-mastery badge/result revocation behavior, fail-closed 501-impact overflow, determinate exhausted-retry rejection, notification/outbox creation, original-row preservation, and append-only trigger rejection.

## Failure and recovery

- `RUNNER_INFRASTRUCTURE_FAILURE`: the runner was unavailable, returned incomplete evidence, or its image digest did not exactly match the reviewed digest. No official outcome is appended. Repair the reviewed runtime deployment; never substitute a tag or silently accept another digest.
- `EXAM_EVIDENCE_MISSING`: an immutable snapshot/hash no longer verifies or the form is not fully deterministic. Preserve the incident, stop processing, and investigate storage/database integrity.
- `WRITE_CONFLICT`: a different correction became effective after impact capture. Create a new correction preview against the now-current result; do not force the stale chain.
- Every expired worker lease is requeued with the same `runner_request_generation`; recovery never creates a fresh runner identity and an exact-expiry boundary is reclaimable. `attempt_count` is a monotonic lease-fencing generation, not the retry budget. The separate three-failure budget is the append-only count of `regrade_failed` events for that exact job. A queue request with three determinate failures fails with `RETRY_LIMIT_EXHAUSTED`; it never creates a queued correction with zero runnable work.
- `AFFECTED_ATTEMPT_LIMIT_EXCEEDED`: one correction may capture at most 500 immutable impacts. Detection runs in the same repeatable-read transaction and rolls the entire create request back; split or narrow the reviewed defect scope before retrying.
- `EXACT_MAPPING_NOT_FOUND` or `EXACT_MAPPING_AMBIGUOUS`: the official corrected result and badge projection remain effective, while concept mastery stays explicitly unresolved and prevents correction completion/appeal closure. Materialize or repair the exact course version, module/lesson-concept link, learner enrollment, and implementation language; the worker retries the projection after 24 hours.
- `ORIGINAL_MASTERY_PROJECTION_REQUIRES_REBUILD`: the corrected effective result and module badge are revoked, but a historic original `MASTERED` result predating correction-owned concept provenance cannot be safely subtracted from `concept_mastery`. The repair remains unresolved until a reviewed evidence rebuild is available; it is never marked applied as a no-op.
- `INTERVENING_MASTERY_EVIDENCE`: a later learning event changed the concept row after a correction-owned award. The correction evidence is revoked, but the worker refuses to overwrite the newer aggregate. Rebuild that concept from its valid evidence under a reviewed repair procedure, then retry.
- Re-running the same request ID with the same payload is safe; reusing it with different evidence fails.

## Current boundaries

- Automatic correction currently covers formal exam/retake items whose immutable blueprint uses server-side `runner-tests`. Standalone practice submissions, project reviews, exact-answer questions, and pending human-review items need separate corrective workflows.
- Mixed-language/multi-image forms use each item's pinned runtime version and image digest; only the corrected target receives the reviewed replacement digest. Missing per-item runtime pins fail closed.
- Most PostgreSQL cases use a deterministic fake executor for orchestration, while crash reconciliation cases exercise the configured signed runner client with a deterministic signed fake transport and prove identical request bodies/idempotency keys. The general runner contract has separate live-container tests, but a deployed correction still requires a release-host drill against the isolated runner VM.
- The replacement editor is structured JSON for the single administrator. A future authoring UI may improve ergonomics but must preserve the same review/hash gates.
- Corrected mastery is projected to `concept_mastery` only when course slug, parsed course version, module/lesson-concept link, skill slug, learner enrollment, and the canonical language context resolve to exactly one row. Non-DSA courses use `conceptual`; DSA uses `dsa:<normalized implementation language>` and must match the enrollment implementation. Missing or ambiguous mappings remain durable `unresolved` repairs rather than guessed writes. A revoke automatically rolls back only a correction-owned projection with no intervening row version; it never erases independent mastery evidence. Historic original mastery without correction-owned concept provenance remains explicitly unresolved under `ORIGINAL_MASTERY_PROJECTION_REQUIRES_REBUILD` while its corrected effective result and module badge are still revoked.
