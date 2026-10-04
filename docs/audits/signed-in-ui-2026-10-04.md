# Signed-in UI audit — 2026-10-04

Base: `origin/main` at `47a14e5` (includes #134 and #137). Source audit, not a live browser/prod verification.

Scanned 117 non-test TSX files under `src/components/**` and `src/app/(app)/**` with TypeScript JSX traversal and targeted searches for inert buttons, form handling, literal/default data, demo imports, TODO/placeholder copy, and navigation targets. Reviewed 34 forms, 41 buttons without their own click handler, 12 default-value controls, and 119 JSX links. Matched static internal link destinations against 168 page/API route files, then reviewed navigation arrays and dynamic route producers. Route existence cannot establish that every database-dependent destination has a record or every external link is live.

## Confirmed signed-in findings

P1 = user-facing broken; P2 = misleading/incomplete user-facing surface; P3 = cosmetic. Explicitly disclosed unavailable features below are placeholders, not concealed working controls.

| File:line | What's fake or unwired | User impact | Severity | Suggested fix |
| --- | --- | --- | --- | --- |
| `src/components/onboarding/onboarding-wizard.tsx:621` | Real onboarding form uses the example identity “Aarav Rao” as its name placeholder. Its actual value is the account/draft name, not fake saved data. | Demo identity appears during real account setup. | P3 cosmetic | **Fixed here:** use “Your name”; retain saved account/draft values and submit handling. |
| `src/components/shell/app-shell.tsx:405` | Search-shaped shell surface is a disabled div with “Search · coming soon”; no search input or action. | Course search is unavailable from the signed-in navigation. Explicitly disclosed. | P2 incomplete placeholder | Implement bounded catalog search or remove the search affordance until available. |
| `src/components/product/settings-view.tsx:461` | “View recovery guidance” is a permanently disabled button with “Coming soon.” | Users cannot open guidance here; only administrator contact is offered. Explicitly disclosed. | P2 incomplete placeholder | Link to accurate recovery instructions and the existing recovery flow; keep MFA/recovery authorization intact. |
| `src/components/product/settings-view.tsx:461` | “Change password” is permanently disabled and has no action. | Signed-in users cannot change their password from this settings surface; administrator handling is stated. | P2 incomplete placeholder | Add a real authenticated password-change flow with verification, session revocation, and success/failure feedback. |
| `src/app/(app)/playground/page.tsx:7` | Unconditional “5 sec quick-run wall limit” and two-slot NUC copy describe the legacy runner regardless of selected backend. | Under `CODE_RUNNER_PROVIDER=piston`, the UI promises 5 seconds although execution is capped at 3 seconds. | P2 misleading | Derive runner capability copy from the selected backend; `src/lib/runner/piston-client.ts:36` and `:236` enforce the 3-second cap. |

No confirmed P1 was found in the currently shipped rendering paths. P1/P2 behavior is unchanged by this PR.

## Latent fallback findings — not currently exposed by shipped content

Read-only repository traversal loaded all 12 courses / 476 skills and found zero skills missing an authored lesson and zero missing an active (non-retired) assessment bank. The skill page selects the authored workspace when a lesson exists (`src/app/(app)/courses/[courseId]/skills/[skillId]/page.tsx:40`; `src/components/lesson/lesson-workspace.tsx:1078`). These paths need attention before content can activate them; they are not counted as confirmed current signed-in defects.

| File:line | What's fake or unwired | User impact if activated | Severity if activated | Suggested fix |
| --- | --- | --- | --- | --- |
| `src/components/lesson/lesson-workspace.tsx:158` | Blueprint “Use my confirmed interests” button has no click handler. | Clicking cannot apply an analogy. | P1 user-facing broken | Wire to confirmed interests and bounded analogy generation, or omit the control. |
| `src/components/lesson/lesson-workspace.tsx:173` | Missing-trace fallback uses a fixed `[4, 7]` counting example for every topic. | Unrelated sample state looks like the current skill's visualizer. | P2 misleading | Label a generic example explicitly or show trace-unavailable state until a reviewed topic trace exists. |
| `src/components/lesson/lesson-workspace.tsx:198` | Fallback game says “Evidence captured” after a length check; text remains only in component state and is cleared on the next stage. | Learner may believe evidence was saved when it was not. | P2 misleading | Disclose local scratchpad behavior or persist evidence through the authoritative practice flow. |

## Cleared candidates

- All 34 forms have `onSubmit`; handlerless form buttons submit those forms. No handlerless `type="button"` control exists inside them.
- Settings Profile now loads and PATCHes `/api/settings/profile`, displays current values, and handles Save/errors (`src/components/product/profile-settings-panel.tsx:17`, `:42`, `:54`). #134's static mock is gone.
- Demo dashboard names, counts, inert actions, and `demo-data` import are behind `!isApplicationAuthRequired()` (`src/app/(app)/learn/page.tsx:12`). Production always requires auth (`src/lib/security/runtime-policy.ts:9`). Real learners get `AuthoritativeDashboard` and session identity (`src/app/(app)/layout.tsx:28`). AppShell's default example identity is overridden by that layout.
- The shell focus-guard buttons use `onFocus` intentionally. Security buttons are explicitly disabled, not active no-op controls.
- Remaining input defaults are saved learner/draft values or editable configuration defaults (session length, battle duration, filter/category); no other fake name/bio/stat default was found. The competition-key date is labeled example input, not a claimed event date.
- Authored lesson practice/recap explicitly identifies local reflection rather than an official grade. Authenticated statistics/recommendations trace to server data; empty states do not populate demo rows.
- No missing static internal route, lorem ipsum, or TODO screen was confirmed. Dynamic record existence and external URLs were not network-verified.
- The Code Lab language selector has five options, and the legacy runner enforces two slots / 5-second practice limits; those numbers are configuration facts, not fabricated learner statistics. The backend-specific timeout discrepancy is listed above.

## B.14 verdict: YES — replaced by #123

The bespoke PostgreSQL counter implementation is replaced by `rate-limiter-flexible`; intentional fixed-window semantics and PostgreSQL storage remain.

- `src/lib/security/rate-limit.ts:5` imports `RateLimiterPostgres` / `RateLimiterRes`; `:242` constructs the library store for `api_rate_limit`; `:256` consumes through the library's atomic counter; `:301` installs it as the default production store.
- No old `PostgresRateLimitStore` class or `api_rate_limit_window` runtime reference remains under non-test `src`. The wrapper only preserves HMAC scope/epoch bucket keys, reset headers, fail-closed behavior, and bounded cleanup.
- `drizzle/0071_rate_limiter_flexible.sql:3` locks the old table, `:14` copies counters, and `:21` drops it. `src/lib/db/schema.ts:4454` defines the new key/points/expiry layout.
- `src/lib/security/__tests__/rate-limit.test.ts:226` exercises the library-generated atomic upsert. `integration/postgres.integration.test.ts:1207` covers PostgreSQL enforcement/restarts; `integration/rate-limit-migration.integration.test.ts:9` checks the old table is absent. Integration sources were inspected, not executed against a database in this audit.
- GitHub PR #123 is merged (2026-10-03 UTC). This source verdict does not independently establish which migration/binary is running in production.

## Scope and validation

Only P3 placeholder text and its regression assertions are changed. The regression first failed on `placeholder="Aarav Rao"` before the one-line correction. No logging, migration, evidence record, or hash changes. #137's provider catalog/env override behavior is untouched. No platform-key serving/free quota behavior is introduced; model-loading/testing scope needs no implementation for this audit.

Validation result: 37 onboarding/rate-limiter unit tests pass; affected-file ESLint passes. Evidence integrity passes: 99 Markdown files, 85 evidence JSON files, and 289 unchanged declared hashes.
