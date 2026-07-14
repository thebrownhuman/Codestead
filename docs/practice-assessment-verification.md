# Practice assessment verification

This verification closes the learner-facing practice flow declared by LES-003 and the deterministic practice-assessment behavior declared by ASM-002. Practice is available from a lesson's **Practice** tab and is bound to the signed-in learner and selected skill.

## Learner experience

- Reviewed, published activities render as deterministic multiple choice, fill-gap, trace, code-completion, or short-answer practice. Unsupported or unreviewed activities fail closed.
- Learners can answer, choose **I don't know**, request one progressive help step at a time, submit, inspect deterministic feedback and remediation, and retry with a fresh unlimited attempt.
- Help progresses through reviewed hints, an alternate explanation, a worked example, and finally the solution when those steps exist. The creation response exposes only step counts; it never sends the help text, answer key, grader, remediation key, reference solution, or hidden tests in advance.
- Revealing the solution requires a fresh attempt before independent evidence can be earned. A learner cannot regain independent credit by forging `assistanceLevel: A0` or `solutionRevealed: false` in the submit request.
- Ready, degraded, loading, submitting, graded, and help-exhausted states are announced accessibly. Keyboard operation, responsive layout, reduced-motion styling, retry/next actions, and content-problem links are present. Content feedback routes to `/requests?kind=missing_topic&skillId=<skill>`.

## Server authority

`POST /api/learning/attempts/[attemptId]/help` is an authenticated, owner-bound capability boundary. Each request uses a UUID receipt, takes request and attempt locks, assigns the next sequential help step, persists the attempt's maximum assistance/reveal state plus an append-only `practice_help_event`, and only then returns the reviewed help content. Same-request replay is idempotent; request reuse across attempts conflicts; concurrent requests cannot allocate the same step; receipt failure rolls the attempt update back.

Attempt submission ignores client help claims in both directions and evaluates with the durable server state. Only beta or verified course and lesson content can resolve to a learner attempt. The learner projection is a strict allowlist, and placement uses the same projection, so draft answer banks, private notes, graders, hidden tests, feedback keys, and reference solutions are not serialized.

Migration `0023_huge_sharon_ventura` adds durable assistance state and the append-only help receipt table. The disposable PostgreSQL integration runner applied the complete migration chain twice successfully, and a subsequent schema generation reported no changes.

## Reproduce the evidence

Focused unit, route, and component suite:

```powershell
npx.cmd vitest run src/lib/learning-service/__tests__/learner-activity.test.ts src/lib/learning-service/__tests__/evidence-engine.test.ts src/lib/learning-service/__tests__/service.test.ts src/lib/learning-service/__tests__/service-negative.test.ts src/app/api/learning/attempts/__tests__/route.test.ts src/app/api/learning/placement/__tests__/route.test.ts "src/app/api/learning/attempts/[attemptId]/help/__tests__/route.test.ts" src/components/lesson/__tests__/practice-panel.test.tsx src/components/lesson/__tests__/authored-lesson.test.tsx src/components/lesson/__tests__/lesson-workspace-interactions.test.tsx
```

Result: 10 files and 80 tests passed.

PostgreSQL integration suite:

```powershell
npm.cmd run test:integration
```

Result: 19 files and 87 tests passed against a disposable PostgreSQL 17 container, including forged-claim rejection, owner binding, idempotent replay, concurrent allocation, and transaction rollback.

Compiled browser journey:

```powershell
npx.cmd playwright test e2e/practice.spec.ts
```

Result: one Chromium journey passed. It exercised the compiled lesson workspace and strict client request/response behavior with deterministic network fixtures; no external credentials were used.

Machine-readable evidence is in [`docs/evidence/asm-002-les-003-practice-2026-07-12.json`](evidence/asm-002-les-003-practice-2026-07-12.json).

## Deliberate limit

The current 476 authored activity banks remain draft, unreviewed, and exam-ineligible. The engine therefore correctly exposes no real pilot activity from those banks until a human review/materialization step publishes each item as beta or verified. Synthetic reviewed fixtures prove the complete engine, database, API, and browser behavior without weakening that publication boundary.
