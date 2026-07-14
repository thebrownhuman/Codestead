# LearnCoding — Full Codebase Review

Date: 2026-07-13
Scope: entire repository (`src/app`, `src/components`, `src/lib` in full, `design-system/`, `services/runner`, `drizzle/` schema + migrations, `infra/`, Docker/Compose/CI, `scripts/`, `e2e/`, `integration/`, `evals/`, `content/`). Read-only review — no code was modified.

Method: eight parallel deep-read passes, each covering a cluster of the codebase, synthesized below.

## Overall verdict

This is an unusually mature, defensively-engineered codebase for its scale. Across ~222 findings total, **zero were rated Critical**, and the handful of High-severity items are concentrated in a few specific hot spots rather than spread evenly — the core authentication stack, the code-execution sandbox, the database schema, and the CI/infra hardening are all well above average. The weak points are: silent/incomplete error handling in several background jobs, a few real business-logic bugs in mastery/deletion logic, a broken admin-approval endpoint, missing indexes on some high-traffic tables, and a security "safety net" (auth-surface scanner, secret scanner, several unit tests) that checks source-code *text* rather than *runtime behavior* in a few places.

### Findings by severity and area

| Area | Critical | High | Medium | Low | Info | Total |
|---|---|---|---|---|---|---|
| Security & Auth (`src/lib/security`, auth flows) | 0 | 2 | 5 | 5 | 3 | 15 |
| Core domain logic 1 (db, domain, exams, curriculum, data-lifecycle, learning-service, appeals, corrections, drafts, admin-mentor/plan) | 0 | 5 | 22 | 33 | 16 | 76 |
| Core domain logic 2 (achievements, dashboard, games, notifications, performance, preferences, privacy, profile, projects, social, storage, ai, github, http, runner client) | 0 | 5 | 8 | 11 | 5 | 29 |
| App routes, API, components, design-system | 0 | 5 | 19 | 17 | 11 | 52 |
| Code-execution runner service (`services/runner`) | 0 | 0 | 4 | 3 | 3 | 10 |
| Infra, Docker, CI, ops scripts | 0 | 0 | 3 | 5 | 3 | 11 |
| DB schema & migrations | 0 | 2 | 6 | 5 | 4 | 17 |
| Tests & content validation | 0 | 1 | 3 | 4 | 4 | 12 |
| **Total** | **0** | **20** | **70** | **83** | **49** | **222** |

### Cross-cutting themes

1. **The automated safety net checks text, not behavior, in several places.** The IDOR/object-authorization matrix, the API-auth-surface scanner, and many `src/lib/security/__tests__` files verify that a string like `"requireAuth("` or `"authz.session.user.id"` appears in a route's source — not that the route actually enforces it at runtime. The repo's own secret scanner (`scan-secrets.ts`) also has far fewer detectors than the in-app redaction module (`sensitive-text.ts`) it should be reusing. None of this is exploited today, but it means `npm run check` passing gives more confidence than it should.
2. **Silent error swallowing in background/worker code.** Several high-stakes paths (dashboard loading, AI idempotency, assessment-correction audit writes, exam capability gates) catch exceptions and return a safe-looking default with zero logging — real production failures become invisible.
3. **A handful of genuine business-logic bugs**, concentrated in `data-lifecycle` (deletion/retention ordering and scoping) and `domain/mastery.ts` (stage regression logic), plus one broken admin-approval endpoint (session-revocation decisions always fail).
4. **Missing indexes** on several high-traffic foreign keys (`activity`, `attempt`, `learning_session_event`, `project_review`, `code_submission`) — a real future scaling risk, though schema hygiene (constraints, no destructive migrations, no raw SQL injection risk) is otherwise excellent.
5. **The code-execution sandbox (`services/runner`) is the standout component** — no High/Critical findings, genuinely well-hardened (per-run containers, `--network none`, digest-pinned images, HMAC-signed API, zero production dependencies).
6. **The Playwright e2e suite runs with `AUTH_REQUIRED=false`**, so no automated test — anywhere — drives a real browser through a real login and confirms the live server enforces auth end-to-end.

---

## 1. Security & Authentication

Reviewed: `src/lib/security/**`, `src/lib/admin-credentials/**`, Better Auth config, auth-flow API routes (invitations, access-requests, lost-device, two-factor, credentials, sessions), secret/env handling.

**0 Critical · 2 High · 5 Medium · 5 Low · 3 Info**

The core stack (`requireAuth`/`requireAdmin`, credential vault, audit hash-chain, rate limiter, lost-device/invitation flows) is disciplined: fail-closed rate limiting, AES-256-GCM with AAD binding, HMAC-based proofs, advisory locks against races, mandatory fresh-MFA on privileged actions, append-only hash-chained audit log.

**High**
- **H1 — IDOR/object-authorization matrix only checks that a string literal is present, not that access is actually denied.** `src/lib/security/api-authorization-matrix.ts:254-290`, consumed by `scripts/verify-api-auth-surface.ts`. The checker does `body.includes(expectedAnchor)` against a route's raw source text rather than invoking it as two different learners and asserting cross-user denial. Presented as "the complete static role/object-authorization matrix," this overstates its guarantee — only ~9 of ~90 authenticated routes have a real per-user integration test backing them. *Fix:* add a runtime harness that seeds two learners and asserts 403/404 on cross-user access, parallel to the genuinely behavioral `endpoint-auth-boundaries.test.ts`.
- **H2 — Repository secret scanner has far fewer detectors than the in-app redaction module it should reuse.** `src/lib/security/secret-canary.ts` (gates `npm run check`) recognizes only 5 credential shapes (Nvidia/OpenAI/Anthropic/Google keys, PEM). `sensitive-text.ts` already detects AWS keys, Slack tokens, Stripe keys, GitHub PATs, JWTs, and generic `password=` assignments — but isn't wired into the scan that gates commits. *Fix:* have `scan-secrets.ts` reuse `sensitive-text.ts`'s pattern list.

**Medium**
- Many "security boundary" unit tests assert on source-code substrings (`expect(source).toContain(...)`) rather than exercising real behavior — a refactor could break the actual protection while the test still passes.
- Production CSP still allows `script-src 'unsafe-inline'`, undercutting XSS protection despite an otherwise strong header set (HSTS, `frame-ancestors 'none'`, `object-src 'none'`).
- Three privileged admin routes (access-request approve/reject, session-revocation decision) skip `withRateLimit` entirely, unlike nearly every sibling admin-mutation route.
- `rateLimitIp()` collapses every anonymous client into one shared `"unavailable"` bucket if deployed without exactly the expected Cloudflare-Tunnel topology — an availability foot-gun for public endpoints (invitation activation, lost-device recovery).
- Better Auth's `allowPasswordless: true` on the two-factor plugin means disabling 2FA on an OAuth-only account requires no fresh-MFA re-verification, unlike the app's own custom routes.

**Low**
- Invitation activation uses a plain read-then-write check instead of the atomic `consumeInvitationByToken` helper that exists specifically to close this race (unused dead code).
- `GET /api/admin/fallback-grants` lacks rate limiting, inconsistent with its sibling `POST`.
- Lost-device recovery proof is placed in a URL hash fragment (good) but still ends up in the rendered email body, which some SMTP relays may log.
- The local `.env` file (correctly gitignored) contains every independent secret key together in one plaintext file — normal for dev, but worth keeping off cloud-synced folders.
- The "demo mode" auth-bypass check (`isApplicationAuthRequired()`) is duplicated across 5 page files instead of centralized — no live vulnerability (APIs always enforce auth independently) but a maintainability risk.

**Info:** unsalted SHA-256 for invitation tokens (safe only because tokens are 256-bit random — worth documenting the invariant); the authentication-boundary text-checker has the same "checks a string, not behavior" limitation as H1; several server-side link builders silently fall back to `http://localhost:3000` if `APP_URL` is unset.

**Not reached:** `src/app/api/admin/curriculum/**`, several learner-lifecycle admin routes, and DB-level verification of assumptions made above (e.g., confirming `user.email` has a unique constraint) — reasonable follow-up targets, particularly curriculum publish/rollback routes given their blast radius.

---

## 2. Core Domain Logic — Part 1

Reviewed: `src/lib/db`, `domain`, `exams`, `curriculum-publication`, `data-lifecycle`, `learning-service`, `learning-requests`, `appeals`, `assessment-corrections`, `drafts`, `admin-mentor`, `admin-plan`, `release` (~17,000 lines read in full).

**0 Critical · 5 High · 22 Medium · 33 Low · 16 Info**

This cluster is unusually disciplined — heavy, mostly-consistent use of `pg_advisory_xact_lock`, `SELECT ... FOR UPDATE`, optimistic `row_version` concurrency, and idempotency-key replay guards across the highest-stakes paths (exam re-exam grants, curriculum publication, account deletion, appeal decisions, worker job claiming). No TODO/FIXME/HACK comments were found anywhere in scope.

**High**
- **H1 — `domain/mastery.ts`: a `PASSED` skill never reacts to subsequent independent failures.** `deriveActiveStage` correctly demotes `MASTERED` skills to `REVIEW_DUE` on independent failure, but the very next branch for `PASSED` skills has no equivalent check — a learner regressing on a passed-but-not-mastered skill is never routed to review, and any UI/analytics keyed on `stage` reports "PASSED" indefinitely.
- **H2 — `data-lifecycle/deletion.ts`: physical file erasure happens before the DB deletion transaction, not atomically with it.** If the ~50-table transaction later rolls back, the files are already permanently gone from disk while the DB rows still claim they exist.
- **H3 — `data-lifecycle/deletion.ts`: an orphaned-corrections cleanup query has no learner filter at all.** `delete from assessment_correction c where not exists (...)` runs with an empty parameter list — it can sweep up and mis-attribute unrelated corrections system-wide during a single learner's deletion run.
- **H4 — `learning-service/drizzle-store.ts`: several check-then-insert paths lack `onConflictDoNothing`,** unlike the rest of the file. Concurrent retries (double-submit, double-tap) throw raw unique-constraint violations that surface as generic 503s instead of idempotent success.
- **H5 — `admin-plan/notifications.ts`: non-transactional, asymmetrically-idempotent dual writes.** An in-app notification insert (no idempotency key) and an email enqueue (deduped) run via `Promise.all` outside a shared transaction — a retry after partial failure creates duplicate in-app notifications.

**Medium (22 total — selected highlights)**
- `db/client.ts` silently falls back to hardcoded local dev DB credentials if `DATABASE_URL` is unset, instead of failing fast in production.
- `curriculum-publication/hash.ts` uses locale-dependent `localeCompare` sorting to build a content-integrity hash — non-reproducible across environments with different ICU data, risking false `CONTENT_HASH_MISMATCH` gate failures.
- `data-lifecycle/retention.ts` has the same file-before-DB-row ordering issue as H2, plus unbounded `count(*)` scans on every retention run and an invisible `chat_thread` cleanup count.
- `data-lifecycle/deletion.ts` cascade-delete ordering causes a reported row count of `0` for `practice_help_event` even though rows were genuinely deleted via cascade — misleading for a compliance-facing deletion report.
- `assessment-corrections/worker.ts`: a failure-handler (`markFailure`) can itself throw uncaught and abort an entire batch of unrelated jobs; audit-write failures are silently swallowed with no logging.
- `assessment-corrections/mastery-repair.ts`: structurally-unresolvable repairs retry once a day forever with no cap or escalation — a student's incorrect mastery award could persist indefinitely without alerting anyone.
- `appeals/admin-service.ts`: overturned exam appeals have no automatic correction-creation trigger (project-review appeals do), relying entirely on a manual admin follow-up.
- `admin-plan/service.ts`: idempotency replay is scoped by enrollment while the insert uses a global PK — a reused `requestId` across two enrollments collides on the primary key.
- `admin-plan/service.ts`: a hardcoded 500-revision history window makes older plan revisions silently unreachable.

**Low (33) / Info (16):** dead code (`src/lib/release` has no production source; unused exported interfaces in `learning-service/types.ts`), duplicated `assertAdmin`/UUID-regex helpers across files, 32-bit vs 64-bit advisory-lock hash inconsistency, an insecure dev-fallback cache-namespace secret gated only on exact `NODE_ENV === "production"` (any other value silently uses the weak default), several overly large (150-230 line) functions combining locking/validation/persistence/side-effects in one body. Full list with file:line references is in the source sub-report.

**Not fully reviewed:** `src/lib/db/schema.ts`'s non-exam/mastery table definitions (see DB Schema section below for the dedicated pass), `sensitive-text.ts`/`audit-writer.ts`/`notifications/outbox.ts` (read only for cross-reference context).

---

## 3. Core Domain Logic — Part 2

Reviewed: `src/lib/achievements`, `dashboard`, `games`, `notifications`, `performance`, `preferences`, `privacy`, `profile`, `projects`, `social`, `storage`, `ai`, `github`, `http`, `runner` (client side).

**0 Critical · 5 High · 8 Medium · 11 Low · 5 Info**

No TODO/FIXME/HACK markers found anywhere in scope. Storage, AI, and privacy modules show solid security fundamentals (proper locking, TOCTOU guards, path-traversal defense, prompt-injection delimiting, fail-closed consent logic) — remaining issues are mostly reliability/maintainability gaps rather than exploitable holes.

**High**
- **H1 — ClamAV streaming scan can mask its own verdict.** `src/lib/storage/clamd-client.ts:47-93` — clamd can reply and close the socket mid-upload before the client finishes streaming; the resulting write failure is caught by the outer catch and replaces the real scan verdict with a generic retryable error. Legitimate large uploads can permanently fail scanning and become undownloadable.
- **H2 — AI idempotency receipts get stuck "processing" on execution failure.** `src/lib/ai/provider-operation-idempotency.ts:410-416` — `execute()` isn't wrapped in try/catch, so a deterministic, immediate failure (all providers exhausted) leaves the receipt claimed-but-incomplete until lease expiry, turning an instant failure into a multi-minute client-facing hang on retry.
- **H3 — `loadAuthoritativeDashboard` swallows all internal errors with zero logging.** `src/lib/dashboard/learner.ts:74,222-236` — real production failures (DB outage, schema mismatch) look identical to "learner has no data yet," with no telemetry at all.
- **H4 — Inactivity-reminder scheduler holds `FOR UPDATE` locks on every active learner row for the whole batch run.** `src/lib/notifications/inactivity.ts:152-377` — locks aren't released per-candidate, so any concurrent write to those user rows blocks until the scheduler finishes; a background cron job becomes a system-wide write stall as the learner base grows.
- **H5 — Leaderboard scoring is an unbounded per-owner N+1.** `src/lib/social/leaderboard-service.ts:214-219` — fires `2N` concurrent full transactions (~8 sequential round trips each) instead of batching, risking connection-pool exhaustion for any moderately sized cohort.

**Medium**
- AI router requires an exact model-string echo from providers, discarding valid responses that echo a versioned model id (e.g. `gpt-4o-2024-08-06`) and potentially over-charging budget for the resulting self-inflicted failure.
- `credential-validation.ts` mislabels a transient DB-write failure (after a successful provider call) as an invalid credential.
- Runner-recovery error classification collapses two distinct error branches to the same "indeterminate" outcome, so permanently-invalid dispatches retry forever instead of routing to quarantine.
- Runner client enforces no size bound on stdout/stderr from the sandbox response, despite every dispatch declaring an `outputBytes` limit meant to bound exactly this.
- GitHub reviewer makes up to ~123 sequential unauthenticated API calls per review with no rate-limit awareness, discarding all progress on a single failure.
- The "meaningful activity" business rule is duplicated as two independent literal lists (dashboard vs. learning-service) with nothing enforcing they stay in sync.
- `profile-service.ts` issues 8-12 sequential independent queries with no `Promise.all` batching.

**Low/Info:** no independent field validation in `reserveStoredObject` (relies entirely on caller); duplicated hand-rolled UUID regexes across 4+ files with inconsistent version constraints; several 130-230 line functions combining multiple concerns; secret-detection patterns in the GitHub reviewer are non-exhaustive (same class of gap as security H2). Positive notes: storage upload path (quota locking, TOCTOU, path-traversal defense), `privacy/consent.ts` (fail-closed, no path treats absent consent as granted), and the `ai` module's idempotency/locking/prompt-injection-delimiting discipline were all found solid.

**Not fully reviewed:** `scripts/process-outbox.ts` (actual email-send worker), `services/runner` itself (covered separately below), API route call sites (only skimmed to confirm library assumptions).

---

## 4. App Routes, API, Components, Design System

Reviewed: `src/app/**` (218 files — pages + API routes), `src/components/**` (110 files), `design-system/`.

**0 Critical · 5 High · 19 Medium · 17 Low · 11 Info**

The API route layer (exams, code execution, files, credentials) is unusually well engineered — consistent `requireAuth`/`requireAdmin` gating, strict Zod validation, `withRateLimit`, advisory locks/`SERIALIZABLE` transactions, idempotency keys, curated error responses. No SQL injection, no path traversal, no client-side-only exam enforcement of consequence, and no `dangerouslySetInnerHTML`/`eval` anywhere in the component tree.

**High**
- **H1 — Broken approval logic for session-revocation requests.** `src/app/api/admin/session-revocation-requests/[id]/decision/route.ts:~127` — the "approved" branch revokes the learner's session (real side effect) but then guards its own row update with `WHERE status = 'approved'`, when the row is still `'pending'` at that point. Every approval attempt revokes the session, then fails the update, returns a false 409 to the admin, and never writes the success audit event — the request stays stuck pending indefinitely.
- **H2 — Almost no route-level `loading.tsx`/`error.tsx`/`not-found.tsx` outside `/admin`.** Routes like `learn`, `roadmap`, `review`, `courses/[courseId]` do real server-side data fetching with no Suspense fallback and no error boundary; failures/slow loads fall through to Next's default unstyled pages.
- **H3 — A demo/fake-data dashboard is reachable in production behind a single boolean flag.** `src/app/(app)/learn/page.tsx` + `src/components/dashboard/learner-dashboard.tsx` — if `isApplicationAuthRequired()` is ever misconfigured, real users could see fabricated mastery/XP/leaderboard data, directly contradicting the platform's "never invent progress" premise.
- **H4 — The design-system spec document is completely stale.** `design-system/learncoding/MASTER.md` describes a dark glassmorphism/Comic-Neue/GSAP theme that has nothing to do with the shipped forest-green/Inter design tokens in `globals.css` — actively misleading for anyone using it as a reference.
- **H5 — Custom tab/mode-switchers lack ARIA tab semantics.** `settings-view.tsx`, `lesson-workspace.tsx` mode navigation — zero `role="tab"`/`aria-selected` usage anywhere in `src/components`, a WCAG 4.1.2 gap on two central UI surfaces.

**Medium (19 total — selected highlights)**
- Five admin mutation endpoints (access-request approve/reject, learning-request decision, session-revocation decision, learner-session revoke) are missing rate limiting that every comparable sibling route has.
- A plan-revision preview endpoint bypasses the privileged-action gate (fresh MFA + reason + audit) that every other comparably sensitive per-learner read enforces.
- Generic `instanceof Error` fallbacks in three assessment-correction routes forward raw exception messages to the admin client instead of using the module's own typed-error pattern.
- Post-commit side effects (email/audit) in three admin approval routes aren't wrapped in try/catch, so a downstream failure surfaces as an opaque 500 after the mutation already committed.
- `POST /api/projects` and `POST /api/onboarding/profile` have no rate limiting, unlike every sibling mutation endpoint.
- Recurring mojibake ("Activating…") in user-facing copy across 3 components — one is locked in by a test that asserts on the *broken* string.
- Heavy duplicated fetch/loading/cancellation logic across 11+ admin components, using three different cancellation idioms in the same folder.
- `timed-exam-client.tsx` re-renders the entire exam workspace (including the full question-nav list) on every keystroke — real typing-latency risk in a timed, high-stakes context.
- `window.confirm()` used for destructive-action confirmation in three places instead of the app's own accessible `ModalDialog`.

**Low/Info:** unvalidated `learnerId` query/path params causing ungraceful 500s instead of clean 400s in a few routes; no pagination on `GET /api/projects`/`GET /api/community`; dead code (`consumeInvitationByToken` unused, duplicating the real consumption path); silent error swallowing with no logging in several route catch-alls; heading-hierarchy skips and missing skip-link focus target on a couple of pages; inconsistent `Cache-Control: no-store` header application across admin routes.

**Areas confirmed clean:** exam integrity (SERIALIZABLE transactions, idempotency, evidence re-validation), code execution dispatch (HMAC-signed, server-enforced resource limits the client can't influence), file upload/download (magic-byte verification, quarantine, path-traversal defense), credentials (envelope-encrypted, MFA-gated, never in response bodies), the AI prompt-injection defense, and the `ModalDialog`/exam-lockdown-overlay accessibility implementations.

---

## 5. Code-Execution Runner Service (`services/runner`)

The single highest-stakes security surface in the codebase — it executes untrusted, learner-submitted code.

**0 Critical · 0 High · 4 Medium · 3 Low · 3 Info**

This is an unusually well-hardened implementation: per-run ephemeral Docker containers with `--network none`, `--ipc none`, `--cap-drop ALL`, `--security-opt no-new-privileges:true`, read-only rootfs, fixed non-root UID, cgroup memory/CPU/pids/ulimit caps, `noexec`/`nosuid`/`nodev` tmpfs mounts, digest-pinned images, no shell-string injection anywhere (all `spawn(..., { shell: false })` with argv arrays), HMAC-signed + nonce-replay-protected API auth, and zero production npm dependencies. No sandbox-escape or injection bugs were found.

**Medium**
- Isolation relies solely on Docker/runc namespaces + cgroups + the default seccomp profile — no second layer (gVisor/Kata/Firecracker), so a runc/kernel container-escape CVE would compromise the host directly.
- The runner's own Node process needs Docker-socket access (root-equivalent); an RCE in the runner's own request-handling code — not the sandboxed code — would grant full host compromise.
- All concurrently-running jobs share one fixed UID/GID with world-readable temp files; a container escape could let one student's job read another's concurrently-running source code.
- No per-submitter/tenant quota on the job queue — one caller can fill the shared 100-slot FIFO queue and starve every other student.

**Low:** the nonce store can't distinguish "capacity full" from "actual replay" under sustained load, misclassifying legitimate requests as `AUTH_REPLAY`; no explicit HTTP server timeouts configured; unauthenticated `/healthz` discloses queue/concurrency state (minor, standard practice).

**Info:** `RUNNER_MAX_CONCURRENCY` is hardcoded to 2 despite looking configurable; tmpfs sizing counts against the container memory cgroup (correctness note, not a bug); zero production dependencies is a genuine positive worth naming.

---

## 6. Infra, Docker, CI, Ops Scripts

Reviewed: `Dockerfile`(s), `compose.yaml`, `.github/workflows/ci.yml`, `infra/**`, `scripts/**`.

**0 Critical · 0 High · 3 Medium · 5 Low · 3 Info**

This is an unusually mature self-hosted deployment: hardened Compose services, atomic checksummed backup/restore/retention with heavy shell test coverage, digest-pinned images, self-validating CI that enforces the hardening invariants stay true.

**Medium**
- `postgres` is the one Compose service exempted from `cap_drop: ALL` (codified as an intentional exception in `validate-compose.mjs`), leaving it with Docker's full default capability set — more privileged than the clamav container that handles untrusted uploads.
- CI only `docker build`s 2 of 7 Dockerfile stages (`runtime`, `regrade-worker`); `tooling`, `worker`, `scanner-worker`, and `project-review-correction-worker` are never actually built in CI — a broken `COPY`/syntax error in those stages would only surface at deploy time.
- `learncoding-compose.service` (the systemd unit that starts the whole stack as root) has none of the hardening directives (`NoNewPrivileges`, `ProtectHome`, etc.) present on every sibling unit.

**Low:** the runtime-image CVE/SBOM scan is intentionally never run in CI (by design, since it needs an offline vulnerability DB) — an operator must remember to run it manually before every release, with nothing automated backstopping that; the retention "confirm" version string is duplicated verbatim across three files with no enforced sync; a CLI script (`data-lifecycle.ts --batch-size`) doesn't validate its numeric input; `alert.sh` reads a config value with `sed` independent of the ownership/mode checks the rest of the toolchain enforces; Dockerfile build-args are interpolated unquoted into `apk add` (safe today only because an upstream script validates them first).

**Info:** several root-owned systemd units could add low-cost extra sandboxing directives; an empty `*_FILE` secret is silently treated as "unset" rather than an error; the project-root `.env` is correctly gitignored/dockerignored (recommend confirming it was never accidentally committed to git history).

---

## 7. Database Schema & Migrations

Reviewed: `src/lib/db/schema.ts` (~2,776 lines), all 42 migration files, `drizzle.config.ts`.

**0 Critical · 2 High · 6 Medium · 5 Low · 4 Info**

An unusually mature, defensively-engineered schema: extensive CHECK constraints, partial unique indexes for "at most one active row" invariants, append-only/immutability triggers, and careful backfill-then-constrain migration patterns. No destructive `DROP TABLE`/`DROP COLUMN`/blind `RENAME` anywhere in 42 migrations; no `sql.raw(` usage anywhere in `src/`, so no SQL-injection-prone raw string concatenation was found; the migration journal matches the file list exactly.

**High**
- The `activity` table has zero secondary indexes across all 42 migrations despite two FK columns (`lesson_id` cascade, `concept_id`) — any per-lesson lookup or cascade delete from `lesson` does a full scan.
- Several core child tables never got an index on their main FK: `learning_session_event.session_id`, `attempt.activity_id`/`enrollment_id`, `project_review.project_id`, `code_submission.attempt_id`/`activity_id`/`test_bundle_id` — confirmed by grepping every migration.

**Medium:** `test_bundle.activity_id` also unindexed; inconsistent `onDelete` cascade policy for FKs to `user.id` (roughly half the user-owned tables cascade, half restrict, with no documented rule — likely intentional given the deletion-lifecycle machinery, but undocumented); `enrollment.course_version_id` and `model_call.credential_id` FKs unindexed; Better-Auth-owned tables use nullable booleans/integers inconsistent with the rest of the schema's strict NOT-NULL convention; no migrations use `CREATE INDEX CONCURRENTLY` (a structural limitation of the drizzle-kit single-transaction workflow, fine at current scale).

**Low/Info:** a reverse-lookup FK (`prerequisite.to_concept_id`) and `emailOutbox.userId` lack indexes; two structurally similar "correction from appeal" tables use different `onDelete` behavior with no apparent reason; a single-admin uniqueness constraint may be an intentional design choice worth confirming; migration history shows the team actively tightening its own immutability triggers over time (a genuine positive); `drizzle.config.ts` embeds a default local dev credential as a fallback (dev-tooling only, low risk).

---

## 8. Tests & Content Validation

Reviewed: `e2e/**`, `integration/**`, `evals/**`, vitest/Playwright configs, `content/**` (sampled), `scripts/validate-content.ts`.

**0 Critical · 1 High · 3 Medium · 4 Low · 4 Info**

The suite is unusually disciplined for its scale: integration tests run against a real disposable Postgres container with mandatory truncation isolation, exam grading/mastery/finalization logic is thoroughly covered against a real database, and content schemas are strict (required answer keys/rubrics/tests) backed by a real Docker-execution CI job. No disabled tests (`.only`/unconditional `.skip`) or genuine TODO/FIXME markers were found anywhere.

**High**
- The entire Playwright e2e suite runs against a dev server with `AUTH_REQUIRED=false`. No e2e test ever does a real login or lets a real browser session hit the actual auth/RBAC enforcement — "protected" pages are reached directly with API responses stubbed via `page.route`. Only manual testing or production would catch a real end-to-end auth regression.

**Medium**
- `src/lib/security/__tests__/endpoint-auth-boundaries.test.ts` mocks `requireAuth`/`requireAdmin` themselves — it proves every route *calls* the guard, never that the guard itself correctly authenticates (compounding the High finding above).
- `npm run check` (the local "everything's validated" gate) only runs `--structure-only` content checks; it never actually executes reference solutions in Docker locally — that only happens in separate CI jobs, which is fine at the CI level but misleading given the script's name.
- The AI tutor eval suite has only 16 cases and is explicitly offline-only (honestly disclosed, but it's the sole "AI eval" artifact, so live model-quality regressions have zero automated coverage).

**Low/Info:** a hardcoded `page.waitForTimeout(100)` is a minor flaky-test risk in one e2e file; Playwright's fixed retry count could mask genuine flakiness without visibility; `validate-content.ts` doesn't itself cross-check hash/parity consistency for future course types without a bespoke verify script (narrow gap); `vitest.auth-boundary.config.ts` being a separate config is confirmed to be deliberate, documented design, not an oversight.

---

## Recommended priority order

1. Fix the broken session-revocation approval endpoint (app-components H1) — a genuinely broken admin security workflow today.
2. Add real behavioral coverage for authentication/authorization (an e2e real-login test, plus a runtime IDOR harness) rather than relying on source-text checks — this is the review's single biggest "unknown unknown" risk.
3. Fix the two `data-lifecycle/deletion.ts` bugs (file/DB atomicity, unscoped correction cleanup) — deletion correctness is high-stakes and user-facing (GDPR-adjacent).
4. Add indexes on the identified high-traffic foreign keys before they become a production performance problem.
5. Add logging to the silent-failure catch blocks identified across dashboard, AI idempotency, and assessment-correction worker code — these are currently invisible to operators.
6. Broaden the secret scanner to match `sensitive-text.ts`'s detector coverage.
7. Everything else (missing rate limits, mojibake text, oversized components, accessibility gaps, infra hardening nits) is lower-urgency cleanup, well-documented above for whenever there's bandwidth.
