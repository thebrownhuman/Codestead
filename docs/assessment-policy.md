# Assessment, Examination, Integrity, and Appeals Policy

Status: implementation baseline\
Dependencies: learning-model.md and content-authoring-standard.md

## 1. Policy intent

Practice is unlimited and forgiving. Formal exams are finite, versioned demonstrations under declared conditions. Game progress, lesson completion, exam passing, and mastery badges are deliberately separate.

The code judge and item rubrics determine correctness. AI may explain results and flag cases for review, but it may not unilaterally fail a learner, declare cheating, reject an alternative solution, or award mastery.

ID convention: every AP requirement has acceptance ID AP-NNN-AC1 at minimum. Where an acceptance block contains multiple bullets, the bullets are AP-NNN-AC1, AC2, and so on in document order. QA evidence shall cite both IDs.

## 2. Assessment modes

### AP-001 — Learn mode

- Unlimited attempts, hints, neutral/interest analogies, visualizer, compiler/run tools, explanations, and eventual solution reveal.
- Revealed or assisted work cannot establish independent mastery evidence.
- After reveal, the system serves a fresh equivalent task.

Acceptance AP-001-AC1: the attempt record includes assistance level and cannot be selected as formal qualifying evidence.

### AP-002 — Practice mode

- Unlimited fresh variants.
- Hints and visualizer are optional and recorded. Creation responses expose only help-availability counts; they never send unrevealed hints, alternate examples, solutions, graders, answers, or hidden tests.
- Each progressive-help request is owner-bound and idempotent. The server locks the attempt, persists the next step and maximum assistance/reveal state, and only then returns that single step.
- Submission assistance and solution-reveal state come from the durable attempt/help ledger. Client claims are ignored, so requesting help and later forging `A0`/`solutionRevealed=false` cannot create independent evidence.
- Immediate explanatory feedback is provided after an attempt.
- Exact repeated items provide replay value but diminishing/no XP and no additional independent evidence.

### AP-003 — Challenge mode

- No solution reveal before submission.
- Compiler/run tools and public examples are available.
- A0 results may establish independent E3–E5 evidence.
- Challenge remains low stakes and has no public failure score.

### AP-004 — Formal exam mode

Formal exams are closed-book:

- No tutor, hints, analogy, visualizer, internal documentation, external web, or solution feedback.
- Compile and Run are allowed against learner-provided input and declared public examples.
- Raw compiler/runtime output is allowed.
- Hidden tests and rubric feedback are withheld until final submission/expiry.
- Final grading is repeated server-side in the pinned environment.

This default measures programming—including compile/test/debug—rather than typo-free syntax recall. Changing the tool allowlist requires a new policy version displayed before exam start.

## 3. Micro-assessments

### AP-010 — Micro-check format

A normal micro-assessment shall contain 1–3 items and target three minutes or less. It is untimed unless the objective is explicitly fluency under time.

Across a lesson, items shall rotate among recognition, predict/trace, debugging, completion/reorder, independent code, explanation, and transfer.

Acceptance IDs AP-010-AC1 through AP-010-AC4:

- Multiple-choice alone cannot qualify a KC for EXAM_READY.
- Feedback states whether the answer is correct, cites the observed evidence, explains why, and offers a repair/retry.
- Incorrect distractors are explicitly corrected.
- A second item confirms a suspected misconception before remediation/demotion.

### AP-011 — Unlimited attempts without evidence farming

- Attempts are unlimited.
- Qualifying attempts use different parameter seeds or item variants.
- A solution reveal invalidates only that item as positive evidence, not future attempts.
- Assistance is never hidden from the learner or admin.
- Repeating an identical easy item cannot repeatedly increase XP, BKT, readiness gates, or leaderboard score.

## 4. Exam eligibility and construction

### AP-020 — Eligibility

A learner is exam-ready only when:

- Every required KC has been introduced.
- Every critical KC has at least one recent A0 independent success.
- Blocking misconceptions have completed targeted remediation.
- At least one delayed review has occurred after initial instruction.
- The learner can see the blueprint, time limit, allowed tools, pass/mastery policy, disconnection rule, and integrity logging notice.

### AP-021 — Blueprint

Default topic-exam weighting:

- 20% trace, predict, or debug.
- 30% boilerplate/missing-line/completion.
- 50% independent code.

Each form shall map every scored part to KCs and rubric criteria. About 20% of slots may target previously weak subskills, while total duration and intended difficulty stay equivalent across learners.

Acceptance IDs AP-021-AC1 through AP-021-AC4:

- A form-generation test proves all required KCs have coverage.
- Two retake forms use different item/seed combinations but the same blueprint and tolerances.
- Hidden tests include normal, boundary, empty/minimal where applicable, and misconception-specific cases.
- Constraints such as “must use a loop” are scored only when explicitly stated as an objective and in the prompt.

### AP-022 — Duration defaults

- Micro-topic exam: 5–10 minutes.
- Topic exam: 15–30 minutes.
- Module exam: 30–60 minutes.
- Capstone: 60–90 minutes.
- Up to two hours requires an explicit capstone rationale, break/accommodation policy, and admin approval.

Approved accommodations may alter time without changing badge meaning; the accommodation itself is private.

## 5. Scoring, passing, and mastery

### AP-030 — Deterministic scoring dimensions

Code questions may score:

- Functional correctness.
- Required concept/constraint.
- Edge-case robustness.
- Readability/style.
- Explanation/trace.
- Complexity only when stated as an objective.

Alternative valid algorithms shall receive full functional credit unless a technique constraint is explicit. Style may not override functional correctness unless style is an objective with a published rubric.

### AP-031 — Pass and mastery thresholds

Policy defaults:

- Below 80% overall or below 70% in any critical cluster: NOT_PASSED.
- 80–94% overall with at least 70% in every critical cluster: PASSED; topic completion may unlock the next topic, but no mastery badge.
- 95% or higher, every critical cluster satisfied, and all mandatory compilation/test gates satisfied: MASTERED and mastery badge awarded.

These are product policy thresholds, not universal learning-science constants.

Acceptance IDs AP-031-AC1 through AP-031-AC3:

- The result shows overall score and criterion-level evidence privately.
- Public profiles show badges, not failed attempts or private numeric scores.
- A score from an assisted practice attempt cannot be inserted into an exam result.

### AP-032 — Compilation behavior

- A single-project exam cannot pass when its final program does not compile.
- In a multi-question exam, a compilation failure removes functional-correctness credit for that independent item; it does not invalidate unrelated items.
- A 95+ mastery result requires every mandatory coding item to compile and satisfy its critical tests.
- Structural partial credit, if offered, follows a deterministic rubric and cannot invent functional credit.

### AP-033 — 80–94 mastery path

After PASSED without mastery:

- Unlock the next topic by default.
- Assign targeted practice for missed or low-confidence criteria.
- Offer a shorter mastery recheck covering only the unproven critical criteria plus one transfer item.
- The recheck is an exam and follows the same timer/integrity rules.

The admin may configure “mastery required to unlock,” but it must be declared per course and cannot change mid-attempt.

## 6. Server-authoritative exam lifecycle

### AP-040 — Exam session

The server shall create:

    {
      "exam_session_id": "exs_42",
      "learner_id": "u_123",
      "blueprint_version": "java.variables.final-v1",
      "form_id": "form_7",
      "seed": "signed-server-seed",
      "runtime": "java-21",
      "starts_at": "2026-07-12T10:00:00Z",
      "deadline_at": "2026-07-12T10:20:00Z",
      "time_allowance_seconds": 1200,
      "allowed_tools": ["compile", "run_public"],
      "policy_version": "ap-1"
    }

The client clock is display-only. The server decides start, deadline, accepted saves, expiry, and final submission.

### AP-041 — Autosave and expiry

- Autosave after meaningful edits and at a short heartbeat interval.
- Every save is idempotent, versioned, server-timestamped, and acknowledged.
- Reconnection restores server-calculated remaining time and last acknowledged content.
- At expiry, the server grades the last acknowledged save.
- A late client request cannot extend the server deadline.

Acceptance AP-041-AC1: tests shall cover clock manipulation, duplicate saves, out-of-order saves, browser refresh, client crash, reconnect before and after deadline, and retrying final submission.

### AP-042 — Disconnection policy

The server timer continues during disconnects. Pausing automatically would be exploitable.

A material platform/network incident is:

- More than 60 seconds or 10% of exam duration, whichever is greater; or
- A verified server-side incident that prevented saves/runs.

The learner may request an incident review. The admin may issue an equivalent re-exam or a documented time accommodation; the system does not silently modify the completed form.

### AP-043 — Retakes

- Retakes use a different equivalent form.
- Failed critical clusters receive remediation first.
- Default maximum cooldown: 1 hour for 5–10 minute exams, 6 hours for 11–30 minute exams, and 24 hours for longer exams.
- Eventual retakes are unlimited; identical-answer brute force is prevented by variants and withheld hidden tests.
- An accepted technical incident re-exam may waive cooldown and is not labeled an academic failure.

## 7. Integrity monitoring and its limits

### AP-050 — Declared exam events

The system may record:

- Exam start/end and policy acknowledgement.
- Question navigation.
- Autosave versions.
- Compile/run/submit events and outputs.
- Focus loss/return and fullscreen exit.
- Paste event time and character count, not clipboard contents by default.
- Disconnect/reconnect.
- Client/server errors.

“Log every action” shall not mean covert raw keystroke capture, camera, microphone, full-screen recording, or collecting unrelated clipboard content.

### AP-051 — Browser enforcement limit

A normal web application cannot reliably prevent another application, device, virtual desktop, or phone. Fullscreen and focus events are deterrence/evidence only.

- A focus loss produces a neutral warning and event.
- Focus loss alone never auto-submits, auto-fails, or proves cheating.
- True device lockdown is a separate native-client project and requires explicit privacy/accessibility review.

### AP-052 — AI integrity review

AI may flag patterns such as repeated long focus loss, large pasted solutions, implausible timing, or strong similarity, but:

- A flag includes observable evidence and uncertainty.
- AI never assigns guilt or punishment.
- Admin performs human review.
- Learner can provide an explanation and appeal.
- Exam content, disability/accommodation, and learner identity shall not be used as hidden behavioral stereotypes.

Default event retention is 90 days, configurable by an explicit data policy.

## 8. Appeals and alternative correct code

### AP-060 — Learner appeal

Every code result shall expose “My code is also correct” with categories:

- Valid alternative implementation.
- Ambiguous specification.
- Faulty/missing test.
- Runtime/environment issue.
- Scoring/rubric error.
- Other.

An appeal preserves the original source, form/seed, runtime, specification version, tests/results, timestamps, and learner explanation.

### AP-061 — Resolution workflow

1. Re-run in the original pinned server environment.
2. Run approved expanded/property tests where available.
3. AI may create a non-binding analysis referencing the specification and deterministic evidence.
4. Admin accepts, rejects with reason, or requests clarification.
5. Exam result and badge remain PENDING_REVIEW when the appeal could change them.
6. Decision and actor are appended to the audit log.

### AP-062 — Correcting a platform defect

If an appeal reveals a faulty test, ambiguous specification, or runtime defect:

- Add a regression test.
- Version the item/specification.
- Find every affected submission.
- Rejudge them deterministically.
- Notify affected learners of material result changes.
- Preserve prior and corrected results in the audit history.

The formal-exam deterministic implementation is documented in [`runbooks/assessment-corrections.md`](runbooks/assessment-corrections.md). It binds an overturned appeal to exact form/test hashes, requires a human-reviewed new bundle and pinned image digest, previews affected attempts, leases at most two regrades per batch, reruns the complete form, appends a superseding result/mastery effect, updates effective exam/admin/leaderboard and badge projections, and applies concept mastery only through an exact, row-version-guarded enrollment mapping. Missing, ambiguous, or intervening-evidence cases remain visible and retryable instead of being guessed. Learners are notified without exposing scores or tests in email. Practice/project/non-deterministic correction boundaries remain explicit in that runbook.

## 9. Admin-as-mentor

### AP-070 — Mentor visibility

The admin may see private skill evidence, attempts, hint dependency, misconceptions, submissions, exam events, incidents, and appeals when that visibility is disclosed to learners.

The admin may:

- Assign remediation or reorder a plan.
- Schedule/reschedule exams.
- Grant documented accommodations.
- Invalidate a technically compromised exam.
- Resolve appeals.
- Review generated content.

Manual mastery override requires a reason, evidence reference, learner-visible notice, and audit event. Impersonating the learner is not permitted.

## 10. Quality acceptance suite

Before exam release:

- Every form compiles/runs in the pinned environment.
- Reference and accepted alternative solutions pass.
- Known wrong/misconception solutions fail the intended tests.
- Score totals and critical-cluster thresholds are mechanically checked.
- Timer, autosave, expiry, retry, and reconnect integration tests pass.
- No hidden answer/test is sent to the browser.
- AI unavailability cannot prevent deterministic grading.
- Appeals can rejudge all affected attempts without mutating original evidence.

## 11. Evidence and authoritative references

- Retrieval practice: https://pubmed.ncbi.nlm.nih.gov/16507066/
- Corrective feedback in multiple-choice testing: https://pubmed.ncbi.nlm.nih.gov/18491500/
- Mastery learning foundations: https://eric.ed.gov/?id=ED053419
- Modular mastery learning in introductory programming: https://pmc.ncbi.nlm.nih.gov/articles/PMC10018628/
- Adaptive Parsons scaffolding: https://doi.org/10.1145/3501385.3543977
- NIST Generative AI Profile, including confabulation, provenance, and generated-code review: https://doi.org/10.6028/NIST.AI.600-1
