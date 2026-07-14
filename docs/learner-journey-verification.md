# Persisted learner-journey verification

Date: 2026-07-12

This verification closes the previously disconnected local service path from a reviewed curriculum publication through adaptive learning and a formal assessment. It deliberately does not claim that the committed Launch 1 corpus is reviewed or publishable.

## Authority chain

The disposable PostgreSQL fixture is a one-skill subset of Programming Foundations. Its lesson and six deterministic constructed-response items carry explicit synthetic human-review metadata. The test then uses the real curriculum services to:

1. append attributable review decisions for the manifest, lesson, and complete item bank;
2. bind release evidence to the aggregate immutable artifact hash;
3. evaluate the publication gate and publish the candidate to beta;
4. select that exact version through `curriculum_publication_pointer` when creating the learner plan;
5. resolve learner activities only when `activity.specification.authoredItemId` identifies an exam-eligible item in the approved immutable bank;
6. admit the reviewed formal exam only after every required skill has persisted independent implementation, transfer, delayed-review, and misconception-clearance evidence.

The test also inserts an older beta version. Plan initialization must ignore it and use the pointer-selected version. This protects deterministic authority from database update order.

## Journey proved

[`integration/learner-journey.integration.test.ts`](../integration/learner-journey.integration.test.ts) proves, in one disposable database:

- completed onboarding profile fields feed a plan but the advanced self-label creates no mastery evidence;
- a diagnostic response is stored as E2 placement evidence and awards no mastery;
- lesson view/completion and learning-session lifecycle events persist;
- a server-issued hint remains A1 even when submission forges A0 and no-reveal claims;
- two distinct clean A0 failures confirm a blocking misconception and deterministic next action becomes `REMEDIATE`;
- two distinct clean constructed responses resolve remediation;
- E4 implementation-equivalent, E5 transfer, and E6 delayed checks satisfy the versioned hard gates;
- reviewed formal-exam admission is denied before readiness, then creates an immutable public-safe form, autosaves, grades to `MASTERED`, and creates the private evidence-linked badge;
- the scheduled one-day review becomes the deterministic next action, a clean review advances the schedule, and the normal session then reports no eligible activity;
- a normal goal containing the word `reviewed` remains balanced, while only the explicit persisted `reviewOnly: true` choice enables review-only policy.

[`integration/practice-learning.integration.test.ts`](../integration/practice-learning.integration.test.ts) remains the focused PostgreSQL concurrency/rollback suite for wrong, assisted, and revealed practice evidence. Its fixture is now bound to an explicitly reviewed authored item rather than relying only on beta row labels.

## Production fixes exercised

- [`src/lib/learning-service/drizzle-store.ts`](../src/lib/learning-service/drizzle-store.ts) selects new plans only from the immutable publication pointer and requires a reviewed authored-item binding before creating official attempts.
- [`src/lib/curriculum-publication/runtime.ts`](../src/lib/curriculum-publication/runtime.ts) reconstructs formal-exam content only from pointer-selected beta/verified artifacts whose immutable hashes, schemas, review state, human reviewer, item eligibility, and skill coverage verify.
- [`src/app/api/exams/_lib/service.ts`](../src/app/api/exams/_lib/service.ts) prefers that canonical publication, suppresses filesystem modules excluded by it, and rechecks persisted readiness inside serialized exam admission.
- Migration [`0028_cheerful_kang.sql`](../drizzle/0028_cheerful_kang.sql) stores the explicit review-only session choice. Free-text goals no longer alter adaptive policy.

## Commands

```powershell
npm.cmd run typecheck
npx.cmd eslint integration/learner-journey.integration.test.ts integration/practice-learning.integration.test.ts src/lib/learning-service src/lib/curriculum-publication/runtime.ts src/app/api/exams
npx.cmd vitest run src/lib/curriculum-publication/__tests__/runtime.test.ts src/lib/learning-service/__tests__/publication-binding.test.ts src/lib/learning-service/__tests__/service.test.ts src/lib/learning-service/__tests__/service-negative.test.ts src/app/api/learning/sessions/__tests__/route.test.ts src/app/api/exams/start/__tests__/route.test.ts src/app/api/exams/_lib/authored-blueprint.test.ts src/app/api/exams/_lib/policy.test.ts src/lib/learning-service/__tests__/evidence-engine.test.ts
npm.cmd run test:integration -- integration/learner-journey.integration.test.ts integration/practice-learning.integration.test.ts
```

The focused integration command applies the complete PostgreSQL migration chain twice before running the tests.

Result: migrations `0026` through `0028` and the complete preceding chain applied twice; the two focused PostgreSQL files passed 4/4 tests, and the final tightened fail-closed journey rerun passed 1/1. The focused unit/route selection passed 92/92 tests across nine files, typecheck and focused lint passed, the architecture scan reported 0 violations/0 stale exceptions, and a second schema generation reported no pending migration. The machine-readable result is [`persisted-learner-journey-2026-07-12.json`](evidence/persisted-learner-journey-2026-07-12.json).

## Audit impact and limits

This adds material automated evidence for LES-004, ADP-001, ADP-002, ADP-004, ADP-005, EXM-001, SES-002, CUR-008, and the already-implemented deterministic contracts in LES-003/ASM-002/EXM-004. Those partial IDs remain partial where browser, breadth, calibration, or real-corpus evidence is still absent.

Still open:

- an authenticated browser journey spanning access, interrupted onboarding, lesson UI, formal exam UI, and review UI;
- independent review and publication of the actual 476 lessons and 476 banks;
- a broad adaptive placement bank with “I don’t know,” advanced-claim branching, and golden scenarios;
- cross-course misconception/remediation breadth and review-interval calibration;
- formal failed-exam remediation/retake, reconnect/expiry worker, material-outage re-exam, and 80–94 shorter mastery-recheck journeys;
- production runner/KVM, provider, load, accessibility, and device evidence.
