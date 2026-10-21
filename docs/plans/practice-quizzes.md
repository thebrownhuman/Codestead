# Practice quizzes per module: plan

Status: design only, no code yet. Builds on `docs/plans/owner-course-exams.md` ("practice quizzes first").
Beta rule: simplicity first. Quizzes are low-stakes, retries are unlimited, and they are not exams.

## 1. What a quiz is
- **One quiz per module.** It covers every skill in the module, with one item per skill. Modules
  with fewer than 3 skills get up to 2 items per skill, and the quiz is capped at 10 items.
- **Items live in the existing assessment banks** (`content/authored/assessment-banks/*.json`), but
  a quiz uses only items explicitly marked **practice-only**.
- **Exam integrity (hard rule).** Learners must never see an item that is, or could later become,
  exam-eligible. Otherwise they memorize exam answers. So the plan is:
  - **Explicit pool marker.** Add an optional item field `pool: "exam" | "practice"` to the
    authored schema (`src/lib/content/authored-schema.ts`), defaulting to `"exam"`. A missing field
    means exam pool, so existing items never leak into quizzes.
  - **Disjoint pools, enforced by the schema.** The schema refuses `pool: "practice"` together with
    `examEligibility.eligible = true`. `isExamEligibleItem` also returns false for practice items,
    so the exam blueprint can never pick them, even after the owner approves a bank.
  - **Server-side filter.** The practice selector accepts only `pool === "practice"` items, and the
    check runs at selection time on the server (never trusted from the client). Draft items, or
    items that merely aren't eligible yet, are **not** enough, because a draft can be approved later.
  - **Content check.** A new `npm run test:practice-pool` validator scans all banks. It fails if any
    practice item is exam-eligible, or if any item id or item hash appears in both pools (no copies
    of an exam item renamed as practice).
  - **Authoring.** Practice items are new items written into the same banks (no "promote a draft to
    practice" path). In v1 the owner authors or approves a small practice set per module. Modules
    without practice items show the empty state.
- The human-approval rule for exams is unchanged.
- **Item kinds in v1:**
  - `mcq` and exact-answer short items are checked instantly on the server.
  - Code items run through the existing runner (`src/lib/runner`, `/api/run` path) only when
    `INTERACTIVE_RUNNER_ENABLED` is on. Otherwise they are hidden from the quiz.
  - Items that need human grading are excluded.
- **Selection:** reuse the deterministic selector idea from `src/app/api/exams/_lib/blueprint.ts`
  (seeded pick). The seed is `(userId, moduleId, attemptNumber)`, so each retry gets a reshuffled
  set while staying reproducible for debugging. No new selector logic beyond a thin practice wrapper.

## 2. Where it appears
- At the end of each module's lesson list on the course page, as a "Practice quiz" card that shows
  the best score and the number of tries.
- It is labelled **"Practice, not certified"** everywhere. It does not lock or unlock any content.

## 3. Scoring and retries
- Score = points earned / points possible, using each item's `points` from the bank.
- Feedback is shown per item right after submit: correct or incorrect, plus the bank's
  explanation/rationale where it exists.
- Unlimited retries, no cooldown, no timer.
- Best score and latest score are both shown. Pass mark display: 70% gets a "nice work" badge only
  (cosmetic, nothing is stored as a pass).

## 4. Progress and mastery
- **No mastery impact.** Nothing is written to `mastery_evidence` or `concept_mastery`, no exam
  session is created, and certificates are unaffected. This avoids any appeal or regrade surface.
- **Progress:** the module card shows "quiz tried / best %". This is display only and does not
  feed course completion %.
- Later (out of scope): a low-weight `practice` evidence signal for daily review scheduling.

## 5. Storage
Reuse what exists, and add one small table.
- **`attempt` (existing)** with `kind = 'quiz'` (the enum value already exists). It reuses
  `attemptNumber`, `status` (`in_progress` → `graded`), `score`, `contentVersion`,
  `policyVersion = 'practice-quiz-v1'`, `startedAt`/`submittedAt`/`gradedAt`. `passed` and
  `masteryAwarded` stay null/false. `activityId` is null; module scope is stored in the new table.
- **New `practice_quiz_item` table** (migration `0076_practice_quiz_items.sql`):
  `id uuid pk`, `attempt_id uuid → attempt (cascade)`, `course_id`, `module_id`, `skill_id`,
  `item_id`, `item_hash`, `position int`, `response jsonb null`, `correct boolean null`,
  `points_earned real`, `points_possible real`, `created_at`, `answered_at`.
  It gets a unique index on `(attempt_id, position)` and an index on `(attempt_id)`. It enforces a
  `response` size check (≤ 16 KB) like other jsonb columns.
- Migration number: current main's latest is `0073`. `0074` (mail role, PR #203) and `0075`
  (passkeys) are reserved, so this plan uses **0076**. Rebase and renumber if main moves.
- Register the migration in the migration ledger plus role-boundary tests
  (`test:migration-ledger`, `test:database-role-boundaries`). The app role gets select/insert/update
  on `practice_quiz_item` only.

**What's new vs reused**

| Reused | New |
| --- | --- |
| Assessment banks + authored schema | `pool` item field, exam-guard, `test:practice-pool` validator; practice selector wrapper (`src/lib/practice-quiz/select.ts`) |
| Seeded selection approach (blueprint) | `practice_quiz_item` table + migration 0076 |
| `attempt` table (`kind='quiz'`) | Practice grader wrapper (MCQ/exact only, then runner) |
| Exact-answer matcher, runner client | 3 API routes, quiz UI, feature flag |
| Session auth helpers | — |

## 6. Anti-gaming (minimal for beta)
- Answer keys never leave the server. The start response contains prompts/options only.
- Grading is server-side only, and the response is accepted once per item per attempt.
- At most one `in_progress` quiz attempt per user per module (starting again abandons the old one,
  setting its status to `cancelled`).
- Rate limits, using the existing flexible limiter (migration `0071`), are keyed by user id and
  return 429 with `Retry-After`:
  - **Attempt creation** (`start`): 10 per user per module per 10 minutes, and 60 per user per day
    across all modules. This stops scraping the practice pool by re-rolling seeds.
  - **Submit:** 30 per user per minute.
  - **Read routes** (resume/summary): 120 per user per minute.
- Exam-answer leakage is prevented by pool separation (section 1), not by limits.
- Copying answers across retries is fine: it's practice. There is no proctoring and no timer.

## 7. API routes (all session-owner authz)
All routes need a signed-in session. The attempt must belong to `session.user.id`, otherwise the
route returns 404 (not 403, so attempts can't be probed). The course must be visible to the user
(enrolled, or beta/published). Every route returns 404 when the flag is off.

| Route | Purpose |
| --- | --- |
| `POST /api/practice-quizzes/start` `{courseId, moduleId}` | Creates the attempt plus items and returns prompts. 409 if the module has no usable items. |
| `GET /api/practice-quizzes/[attemptId]` | Resume: items, saved responses, status. |
| `POST /api/practice-quizzes/[attemptId]/submit` `{responses[]}` | Grades and returns per-item feedback plus the score. It is idempotent on a graded attempt (returns the stored result). |
| `GET /api/practice-quizzes/summary?course_id=` | Best/latest score per module for the course page. |

Code items use the existing `/api/run` path to test-run before submit. Submit grades through the
runner on the server.

## 8. UI screens and states
- **Module quiz card** (course page). States: loading skeleton; no items ("Practice coming soon"
  with the card hidden when the flag is off); never tried; tried (best %, tries); error (retry link).
- **Quiz page** `/courses/[courseId]/modules/[moduleId]/practice`:
  - Loading: skeleton for the item list.
  - Empty: "No practice items for this module yet" plus a back link.
  - Error (start failed, 5xx, rate limited): a friendly message from `error.message` plus a Retry
    button.
  - In progress: one scrollable form, MCQ radios, short text inputs, and a code editor
    (existing editor component) for code items. Submit is disabled while sending.
  - Success/results: score banner, per-item correct/incorrect with explanation, and "Try again"
    (new attempt) plus "Back to module" buttons.
- A11y: labelled inputs, focus moves to the results heading after submit, result is not shown by
  colour only, and touch targets are ≥ 44px.

## 9. Tests
- **Unit:** selector (determinism, retry reshuffle, excludes pending-review/code-when-runner-off,
  caps), grader (MCQ, exact-answer, partial points), and answer keys stripped from DTOs.
- **Route:** authz (no session → 401; other user's attempt → 404), flag off → 404, start/resume/
  submit happy path, idempotent submit, a second start cancels the old in_progress attempt, 409 on
  an empty module.
- **DB:** migration ledger + role-boundary tests updated, and a cascade delete of attempt removes
  items.
- **Exam integrity:**
  - The schema rejects `pool: "practice"` combined with `eligible: true`.
  - `isExamEligibleItem` returns false for practice items.
  - The selector never returns an exam-pool item, including draft or approved items.
  - The exam blueprint never returns a practice item.
  - `test:practice-pool` fails on a fixture bank with an item id or hash shared across pools.
- **Rate limits:** the 11th start in 10 minutes returns 429.
- **Invariant:** a quiz submit writes **no** rows to `mastery_evidence`, `concept_mastery`, or
  `exam_session` (explicit test).
- **UI:** component tests for each state, plus one Playwright smoke test (start → answer → results
  → retry).

## 10. Rollout
- Flag `PRACTICE_QUIZZES_ENABLED` (env, default off, matching the `INTERACTIVE_RUNNER_ENABLED`
  style). When it is off, routes return 404 and the UI hides.
- Enable on the homelab beta first, watch error logs and rate-limit hits for a few days, then
  default on.
- Rollback: flip the flag off. The table stays (additive, harmless).

## 11. PR slices
1. **`feat(practice-quiz): schema`**: migration `0076` + Drizzle table + ledger/role-boundary
   tests. No behaviour change.
2. **`feat(practice-quiz): pool + selector + grader`**:
   - The `pool` field in the authored schema, the `isExamEligibleItem` guard, and the
     `test:practice-pool` validator, wired into CI.
   - `src/lib/practice-quiz/*` pure functions with unit tests (MCQ/exact only).
   - A first small set of owner-approved practice items for one module.
3. **`feat(practice-quiz): API`**: the 4 routes behind the flag, with authz, rate limit, and route
   tests including the no-mastery invariant.
4. **`feat(practice-quiz): UI`**: module card + quiz page with all states, component tests, and the
   Playwright smoke test.
5. **`feat(practice-quiz): code items`** (optional): runner-graded code items when the runner is
   enabled.

## Open questions for owner
- Show the correct answer on a wrong MCQ, or only the explanation? (Plan: explanation + correct option.)
- Should quiz completion count toward course completion % later? (Plan: no for beta.)
