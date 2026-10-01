# Codestead — Engineering Audit and Open-Source Adoption Options

- Audit date: 2026-10-01
- Branch audited: `main` at commit `5ffe8623dd9d1701a86aa954457fb5300c924c09`
- Audience: the architect (and any Claude session helping them) deciding what to fix and what to adopt
- Out of scope by owner request: the Piston runner integration (still being implemented)
- Nothing in the repository was changed. This file is the only output.

How to read this file:

- Part A: what was checked and how
- Part B: bugs and risks, each with evidence, reproduction, impact and a suggested fix
- Part C: claims from the first audit pass that turned out wrong after re-verification
- Part D: areas reviewed and found healthy (no rework needed)
- Part E: open-source options by area, with alternatives, licenses, justification and trade-offs
- Part F: whole self-hostable open-source applications worth considering
- Part G: decision table and a phased roadmap
- Part H: verification log (commands, scratch tests, files inspected)

Evidence labels used throughout:

- **Confirmed by test**: reproduced with a test that was run, then deleted
- **Confirmed by code/config**: the defect is visible directly in the source or deployment config
- **Found by reading**: follows from reading the code path end to end; not executed
- **Policy question**: not a defect; a product decision is needed

---

## Part A — Scope and method

### A.1 What was executed

| Check | Command | Result |
|---|---|---|
| Install | `npm ci` | OK (693 packages) |
| Typecheck | `npm run typecheck` (`tsc --noEmit`) | 0 errors |
| Lint | `npm run lint` | 0 errors, 2 warnings (unused var in a test; stale eslint-disable in `src/components/shell/app-shell.tsx:243`) |
| Unit tests | `npx vitest run --maxWorkers=4` | 517 files: 513 passed, 4 skipped. 5,946 tests: 5,928 passed, 18 skipped, 0 failed. ~290 s |
| Production build | `npm run build` | Passed, no warnings |

### A.2 What was not executed

- `npm run test:integration`, the `infra/tests/*.integration.mjs` suites, and `npm run test:e2e` (Playwright). These need a Docker daemon, which was not available in the audit environment.
- Load tests, backup/restore drills, and runner runtime tests (they need the target infrastructure).

### A.3 What was read

- About 440,000 lines of TypeScript/JavaScript across `src`, `scripts`, `infra`, `services`, `integration`, `e2e`.
- All 125 API route files under `src/app/api` were enumerated. Every learner route that takes an object ID was traced to its query to check owner scoping.
- Deep reads: auth config (`src/lib/auth.ts`), authorization helpers (`src/lib/http/authz.ts`), Better Auth endpoint allowlist, rate limiter, learning service, exam engine (`src/app/api/exams/_lib/service.ts`, ~2,900 lines), exam client, storage and upload pipeline, ClamAV client, account deletion (cross-checked against all 125 tables), credential vault, AI tutor route and provider code, GitHub reviewer, error-monitoring tunnel, mailer MIME builder, DB client, worker entry points, legacy runner Docker isolation, CI workflows, Dockerfile, `compose.yaml`.
- Library behaviour was checked against the installed source in `node_modules` (Better Auth v1.6.23) and against upstream ClamAV configuration files, not from memory.

### A.4 Size of the custom subsystems (for the replacement discussion)

| Subsystem | Location | Lines |
|---|---|---|
| Mail outbox, dispatch, reconciliation (non-test) | `src/lib/notifications/*.ts` | ~17,100 |
| Mail outbox unit tests | `src/lib/notifications/__tests__` | ~23,600 |
| Mail migration/role/integration harnesses (0059–0069) | `infra/tests/mail-*`, `infra/tests/backup-status-mail-*` | ~42,900 |
| Production load-test harness | `scripts/lib/production-load*`, `infra/runtime/production-load*`, `scripts/load-*.ts` | ~28,500 |
| Backup scripts | `scripts/backup/*` | ~9,600 (`backup.sh` alone: 1,856) |
| Database role/capability bootstrap and verification | `scripts/bootstrap-database-roles.mjs` + 3 siblings | ~17,000 |
| Disposable integration DB harness | `scripts/run-integration-tests.ts` | 648 |
| Secret scanner | `scripts/scan-secrets.ts` + `scripts/lib/repository-secret-scan.ts` | 230 |

Every one of those lines has to be kept correct by the team. Several have mature, widely-tested open-source equivalents (Part E).

---

## Part B — Bugs and risks

Severity scale: **High** = security or data loss reachable today; **Medium** = integrity, correctness or availability issue with a realistic trigger; **Low** = hardening or edge case.

No High-severity issue was found outside Piston.

### B.1 Practice answers can be probed without penalty after grading — Medium — Confirmed by test

**Where:** `src/lib/learning-service/service.ts:460-482` (`submitAttempt`, the `context.attempt.status === "graded"` branch).

**What happens:**

1. A learner submits a practice attempt and it is graded (say, failed).
2. They call `POST /api/learning/attempts/{attemptId}/submit` again with a different answer and a new `responseRevision`.
3. The graded branch re-evaluates the **new** answer with `evaluateAuthoredActivity`.
4. If the new answer's pass/fail matches the stored result, the response includes full feedback for the new answer ("Not yet", misconception tags, remediation). If it differs (i.e. the new answer is correct when the stored one failed), `feedback` is `null`.
5. Nothing is recorded: the branch returns before `insertResponseIfAbsent`, evidence, or mastery writes.

So `feedback !== null` means "this answer is wrong" and `feedback === null` means "this answer is right". The learner gets unlimited free grading.

**Why it matters:** variant selection (`src/lib/learning-service/drizzle-store.ts`, `resolveActivity`) picks deterministically from a small pool of activities per skill. A skill with one activity always repeats it. A learner can find the right answer on a dead attempt, then start a fresh attempt on the same item and earn mastery evidence with it. That undermines the mastery and adaptive-planning data the product is built on.

**Reproduction (run during the audit, then deleted):**

```ts
// src/lib/learning-service/__tests__/zz-audit-oracle.test.ts (scratch)
import { describe, expect, it, vi } from "vitest";
import type { LearningStore, LearningTransaction } from "../store";
import { LearningService } from "../service";
import type { AttemptContext } from "../types";

const NOW = new Date("2026-07-12T12:00:00.000Z");
const USER_ID = "learner-1";
function graded(): AttemptContext {
  return {
    activity: {
      activityId: "20000000-0000-4000-8000-000000000001", activitySlug: "x", activityType: "quiz",
      specification: { grading: { kind: "exact", acceptedAnswers: ["42"] } },
      skillId: "python.variables.assignment", conceptId: "30000000-0000-4000-8000-000000000001",
      enrollmentId: "40000000-0000-4000-8000-000000000001", courseVersion: "1.0.0", trackId: "python",
      implementationLanguage: null, languageContext: "conceptual",
    },
    attempt: {
      id: "50000000-0000-4000-8000-000000000001", userId: USER_ID,
      activityId: "20000000-0000-4000-8000-000000000001", enrollmentId: "40000000-0000-4000-8000-000000000001",
      kind: "practice", attemptNumber: 1, status: "graded", policyVersion: "adaptive-learning-v1",
      contentVersion: "1.0.0", score: 0, passed: false, masteryAwarded: false, infrastructureFailure: false,
      assistanceLevel: "A0", solutionRevealed: false, helpStep: 0, startedAt: NOW, submittedAt: NOW, gradedAt: NOW,
    },
  } as AttemptContext;
}
describe("graded attempt resubmission", () => {
  it("distinguishes correct from incorrect answers without recording anything", async () => {
    const insertResponseIfAbsent = vi.fn();
    const tx = { lockAttemptSubmissionUser: vi.fn(async () => undefined),
      getAttempt: vi.fn(async () => graded()), insertResponseIfAbsent } as unknown as LearningTransaction;
    const store: LearningStore = { transaction: (work) => work(tx) };
    const service = new LearningService({ store, now: () => NOW });
    const probe = (value: string, revision: number) => service.submitAttempt(USER_ID, graded().attempt.id, {
      itemKey: "main", responseRevision: revision, answer: { value },
      assistanceLevel: "A0", solutionRevealed: false, submittedAt: NOW });
    const wrong = await probe("41", 2);
    const right = await probe("42", 3);
    expect(wrong.feedback).not.toBeNull();   // passed
    expect(right.feedback).toBeNull();       // passed
    expect(insertResponseIfAbsent).not.toHaveBeenCalled(); // passed
  });
});
```

Observed output: wrong answer → `{"correct":false,"headline":"Not yet",...}`; right answer → `null`.

**Suggested fix:** in the graded branch, never evaluate the incoming answer. Return the stored result only. If replay feedback is wanted, rebuild it from the **stored** response for that attempt, or return `feedback: null` unconditionally. Add a regression test like the one above, asserting identical responses for any resubmitted answer.

---

### B.2 Learners can suppress their own exam integrity events — Medium — Confirmed by code

**Where:**

- Client events route: `src/app/api/exams/[sessionId]/events/route.ts:11`. `clientEventId` must only match `^[A-Za-z0-9._:-]+$`, 16–200 characters, so colons and arbitrary prefixes are allowed.
- `recordExamEvent`: `src/app/api/exams/_lib/service.ts:1465`. It inserts into `exam_event` with `onConflictDoNothing` on `(exam_session_id, client_event_id)`. It does not check the session is still active.
- Server-written events use the **same table, same unique key, same column**, also with `onConflictDoNothing`, and predictable IDs:
  - `src/lib/exams/capability-gate.ts:51` → `blocked-capability:<capability>:<minuteBucket>` (minute bucket = `floor(Date.now()/60000)`, predictable)
  - `service.ts:1954` → `execution:<clientRequestId>` (the learner chooses `clientRequestId`)
  - `service.ts:1445` → `server-disconnect:<prevHeartbeatMs>:<nowMs>`
  - `service.ts:2362` → `runner-failure:<itemId>:<revision>` / `runner-capacity:...`
  - `service.ts:2717` → `appeal:<clientRequestId>`

**Attack:**

1. During an exam, the learner posts events with IDs like `blocked-capability:ai_tutor:29640000` … `29640060` (the next 60 minutes) and `execution:<uuid they will later use>`, using any allowed client event type.
2. Later, when they try the AI tutor (blocked, correctly) or run code, the server's integrity event insert hits the existing row and is silently dropped.
3. The access is still blocked. What's lost is the **evidence**: reviewers never see the blocked-capability attempts or the run records.

**Impact:** exam integrity review and appeals rely on these records. A learner can quietly erase the trail of attempts to use forbidden tools.

**Suggested fix (any one is enough; the first is the smallest):**

- Require client event IDs to be UUIDs (`z.string().uuid()`). The browser already generates them with `crypto.randomUUID()` (`src/lib/exams/use-durable-exam-outbox.ts:793`), so no client change is needed.
- Or prefix every client ID server-side (`client:<id>`) so the namespaces cannot collide.
- Also reject `recordExamEvent` when the session is not `active` / `paused_by_system`.

---

### B.3 Last unsaved exam edits are dropped at the deadline — Medium — Found by reading

**Where:**

- Client auto-submit: `src/components/exams/timed-exam-client.tsx:463-480`. A 500 ms interval sees `seconds === 0` and calls `submit(true)`. Inside `submit`, `flushOutbox()` (line 419) sends pending autosaves **after** time is already zero.
- Answers are debounced 1,000 ms (`EXAM_ANSWER_DEBOUNCE_MS`, `src/lib/exams/use-durable-exam-outbox.ts:43`) and retried at 1/2/5/10/30 s.
- Server: `autosaveExamAnswer` rejects with `EXAM_EXPIRED` if `hasDeadlinePassed(serverDeadlineAt, now)` (`service.ts:1306`). `hasDeadlinePassed` is `deadline <= now` with no grace (`src/app/api/exams/_lib/policy.ts:129-131`). On expiry it finalizes the exam with the previous revision.

**Impact:** the final ~1–2 seconds of typing, and any autosave stuck in retry on a flaky connection, are lost. A learner who answers in the last seconds loses that answer. It's a fairness issue and a likely source of appeals.

**Suggested fix (pick one):**

- Client: start the final flush N seconds before the deadline (e.g. at 5 s remaining), then submit at 0.
- Server: accept autosaves that arrive within a small grace window (e.g. 5–10 s) after the deadline, stamped with server receipt time. Finalization waits for that window. Record that the grace was used.
- Add a test that simulates an autosave in flight across the deadline.

---

### B.4 GitHub project reviews will exhaust the anonymous API limit in production — Medium — Confirmed by config

**Where:**

- `src/lib/github/reviewer.ts:303` sends `Authorization` only if `process.env.GITHUB_TOKEN` is set.
- `GITHUB_TOKEN` appears only in `.env.example:96`. It is **not** passed to the `app` service in `compose.yaml` (searched; no match).
- Per review the code calls: repo metadata (1) + commit (1) + tree (1) + one blob call per selected file (up to 120) = up to ~123 calls, sequentially.

**Impact:** GitHub allows 60 unauthenticated REST calls per hour per IP. One review of a medium repo uses the whole hourly quota; reviews after that fail with `GitHub API returned 403`. The per-user rate limit (`github_review_user`, 5/hour) doesn't help, because the GitHub quota is shared across the server's IP.

**Suggested fix:**

1. Pass a fine-grained, read-only, public-repo-only token to the app as a Docker secret.
2. Fetch one archive per review instead of per-file blobs: `GET /repos/{owner}/{repo}/tarball/{sha}` or `zipball` (1 call), streamed with a size cap. Or use the GraphQL API to fetch many blobs in one query.
3. Use Octokit with `@octokit/plugin-throttling` and `@octokit/plugin-retry` so rate-limit responses are handled (Part E.10).

---

### B.5 Community discussions and battles stay open during closed-book exams — Policy question

**Where:** routes that call the closed-book gate (`requireAuth({ closedBookCapability })` or `gateClosedBookCapability`): AI tutor, code run, games, files, projects, learning workspace. Routes that do **not**: `src/app/api/community/*`, `src/app/api/battles/*`, plus portfolio, career, trophies and certificates (mostly harmless).

**Risk:** a learner mid-exam can post the exam question in community discussions and get answers from classmates. Battles evaluate authored activities, so leakage there is lower but not zero.

**Decision needed:** should `community_write`, `community_read` (discussions) and `battles` be added as closed-book capabilities? If yes, it's a small change: add the capability to `ClosedBookCapability` in `src/lib/exams/capability-gate.ts` and pass it in those routes.

---

### B.6 Main database pool has no error listener — Medium — Confirmed by code

**Where:** `src/lib/db/client.ts:17-24` creates `new Pool(...)` and never calls `pool.on("error", ...)`. Searched the whole repo: only the mail pool has a listener (`src/lib/notifications/mail-dispatch-pool.ts:39`, with a comment explaining exactly this risk).

**Impact:** node-postgres emits `error` on the pool when an **idle** client's connection drops (Postgres restart, failover, network reset, `idle_session_timeout`). With no listener, Node treats it as an unhandled `error` event and the process exits. That hits the Next.js app and every worker that imports this pool (rewards, regrade, exam finalization, practice recovery, project-review corrections, file erasure, scan worker, lifecycle). Docker `restart: unless-stopped` brings them back, but in-flight requests fail and an exam submit can error.

**Also missing:** no default `statement_timeout` / `idle_in_transaction_session_timeout` on the app pool (only the mail path sets them, with `SET LOCAL`). A stuck query can hold a connection from the pool of 10 indefinitely.

**Suggested fix:** add the same listener as `mail-dispatch-pool.ts:39` (log a code, don't rethrow). Set `statement_timeout` (e.g. 15 s) and `idle_in_transaction_session_timeout` (e.g. 30 s) through the `options` connection parameter or per database role (`ALTER ROLE ... SET`).

---

### B.7 Better Auth's built-in rate limiter is in-memory — Low — Confirmed by library source

**Where:** `src/lib/auth.ts:180-189`: `rateLimit: { enabled, window, max, customRules }` with no `storage`. In the installed Better Auth (`node_modules/better-auth/dist/context/create-context.mjs:174`) storage defaults to `"memory"` when there's no `secondaryStorage`.

**Impact:** the sign-in (8/min), sign-up and TOTP-verify (6/min) budgets reset on every restart and are per process. Your own Postgres limiter does not wrap these Better Auth endpoints.

**Note:** IP spoofing is **not** a problem here. See Part C.1.

**Suggested fix:**

- Set `rateLimit.storage: "database"`. Better Auth supports `"memory" | "database" | "secondary-storage"`; the database option needs its `rateLimit` table added through a Drizzle migration.
- Set `advanced.ipAddress.ipAddressHeaders: ["cf-connecting-ip"]` so Better Auth uses the same trusted header as your own limiter (`src/lib/security/rate-limit.ts`, `RATE_LIMIT_TRUSTED_IP_HEADER`).

---

### B.8 Hand-built MIME email does not follow the email format rules — Low/Medium — Confirmed by code

**Where:** `src/lib/notifications/mailer.ts:145-176` (`mimeMessage`), `src/lib/notifications/templates.ts:111`.

**Defects:**

- `Subject:` is written raw. Non-ASCII characters (titles, names, the em dash used in templates) are not RFC 2047 encoded.
- Bodies are declared `Content-Transfer-Encoding: 8bit` but contain bare `\n` line endings (template text uses `\n`), mixed with the `\r\n` used for headers. RFC 5322 requires CRLF.
- No line folding: an HTML line longer than 998 octets violates RFC 5322 and some relays will reject or rewrap it.
- No `Date:` header (Gmail adds one, but other transports won't).

**Impact:** garbled subjects in some clients; possible rejection or mangling if the transport changes from the Gmail API.

**Suggested fix:** build the message with Nodemailer's `MailComposer` (`nodemailer/lib/mail-composer`). It handles RFC 2047, quoted-printable or base64 bodies, folding and `Date`. You can keep the Gmail API transport: compose with MailComposer, base64url the output, and send through the existing Gmail call. See Part E.1.

---

### B.9 Missing `APP_URL` silently falls back to localhost — Low/Medium — Confirmed by code

**Where:** `APP_URL` is read in 22 files, mostly as `process.env.APP_URL ?? "http://localhost:3000"`. That includes Better Auth `baseURL` (`src/lib/auth.ts:77`) and `trustedOrigins` (`:84`). Only `src/lib/notifications/inactivity.ts:128` validates it.

**Impact:** a deployment missing `APP_URL` starts normally but sends password-reset and verification emails with `http://localhost:3000` links and rejects real origins.

**Suggested fix:** one environment schema validated at boot, failing fast in production (Part E.7, `@t3-oss/env-nextjs` or a zod schema in `instrumentation.ts`). Remove the per-call fallbacks.

---

### B.10 CSP allows inline scripts — Low — Confirmed by code

**Where:** `next.config.ts:18` (`script-src 'self' 'unsafe-inline'`).

**Impact:** if any XSS ever lands, the CSP won't stop it. Today no raw HTML is rendered (Part D), so this is defence in depth.

**Suggested fix:** the Next.js nonce pattern. Generate a per-request nonce in `src/proxy.ts` (currently only matches `/api/*`; extend the matcher to pages), set `script-src 'self' 'nonce-…' 'strict-dynamic'`, and pass the nonce to the two inline scripts (`src/app/layout.tsx:51`, `src/components/landing/landing-page.tsx:27`). Note: nonces force dynamic rendering of pages.

---

### B.11 Uploads are read fully into memory before the size check — Low — Confirmed by code

**Where:** `src/app/api/files/route.ts:96` calls `request.formData()` before checking `upload.size`.

**Impact:** an authenticated learner can send a body up to Cloudflare's request cap (100 MB on Free/Pro plans) and Node buffers all of it, possibly twice. Rate limit is 10/hour per user, so this is a memory spike, not a sustained DoS.

**Suggested fix:** reject early on `Content-Length > MAX_UPLOAD_BYTES + multipart overhead`, or stream-parse with `busboy` (MIT) and enforce the limit while streaming.

---

### B.12 Error-monitoring relay has no rate limit and accepts pre-MFA sessions — Low — Confirmed by code

**Where:** `src/app/api/monitoring/envelope/route.ts:22`. `requireAuth({ allowPending: true, allowPasswordChange: true, allowMfaChallenge: true })`, no `withRateLimit`, and `request.text()` is read before the size check when `Content-Length` is absent.

**Impact:** anyone with a learner's password (without TOTP) can flood your GlitchTip project. The target is fixed (no SSRF; Part D).

**Suggested fix:** add a per-user/per-IP `withRateLimit` policy (e.g. 30/min) and a bounded body read.

---

### B.13 No breached-password check — Low — Confirmed by code

**Where:** `src/lib/auth.ts:92` (`minPasswordLength: 12`); invitation activation `src/app/api/invitations/activate/route.ts`.

**Suggested fix:** enable Better Auth's bundled `haveIBeenPwned` plugin (present in the installed version: `node_modules/better-auth/dist/plugins/haveibeenpwned`). It uses the k-anonymity range API, so only a 5-character hash prefix leaves the server. MFA is mandatory, so this is low priority.

---

### B.14 Postgres-backed custom rate limiter: fixed windows — Low — Confirmed by code

**Where:** `src/lib/security/rate-limit.ts:231` uses fixed windows (`floor(now / window)`). `configuredPolicies()` re-parses `RATE_LIMIT_OVERRIDES_JSON` on every request (`:186`).

**Impact:** a client can send up to 2× the limit around a window boundary. JSON parsing per request is wasted work.

**Suggested fix:** sliding window or token bucket (Part E.3, `rate-limiter-flexible`); cache the parsed overrides at module load.

---

### B.15 ClamAV `/tmp` is small for 50 MB uploads — Low — Found by reading (see C.2)

**Where:** `compose.yaml` `clamav` service: `/tmp` tmpfs is 64 MB. `MAX_UPLOAD_BYTES` = 50 MB (`src/lib/storage/policy.ts:5`). clamd spools INSTREAM data to its temporary directory and unpacks archives there.

**Impact:** a 50 MB archive, or two large concurrent scans, can fill `/tmp`. The scan fails and is retried up to 8 times with backoff (`src/lib/storage/upload-scanner.ts:210`) before failing terminally. Also, clamd's `INSTREAM size limit exceeded` reply is parsed as a retryable protocol error (`parseClamdResponse` in `src/lib/storage/clamd-client.ts`) rather than a permanent rejection.

**Suggested fix:** raise the tmpfs to ~256 MB (or mount a small volume); treat `size limit exceeded` as terminal; add a test with a >`StreamMaxLength` stream.

---

### B.16 Lint nits — Trivial

- `src/app/api/credentials/__tests__/route.test.ts:14`: unused `_condition`.
- `src/components/shell/app-shell.tsx:243`: unused `eslint-disable` directive.

---

## Part C — Corrections to the first audit pass

These were stated in the first chat report and were wrong or overstated. They are corrected here after checking real library code.

### C.1 "Better Auth rate limit can be bypassed by spoofing X-Forwarded-For" — WRONG

Checked `node_modules/@better-auth/core/dist/utils/ip.mjs` (`getIPFromHeader`, `getIp`) in v1.6.23:

- With no `trustedProxies`, a header with more than one IP returns `null` (`if (forwardedIps.length !== 1) return null`).
- When no IP resolves, the limiter uses a single shared per-path bucket (`node_modules/better-auth/dist/api/rate-limiter/index.mjs:281-287`).
- Behind Cloudflare, a client-supplied `X-Forwarded-For` gets the real IP appended. The header then has two values, so the attacker lands in the **shared, stricter** bucket. That is not a bypass.

What remains is B.7 (in-memory storage). Downgraded to Low.

### C.2 "ClamAV rejects uploads over 25 MB" — WRONG

Upstream `clamd.conf.sample` (Cisco-Talos/clamav `main`) documents `StreamMaxLength` as `Default: 100M`. The official Docker image (`Cisco-Talos/clamav-docker`, 1.4 alpine Dockerfile) does not override it. 50 MB uploads fit. What remains is B.15 (`/tmp` sizing and error classification). Downgraded to Low.

### C.3 "Main DB pool can crash the process" — RE-CONFIRMED

See B.6. The repo's own mail pool comment (`src/lib/notifications/mail-dispatch-pool.ts:39-42`) describes the same failure mode.

---

## Part D — Reviewed and found healthy

No change recommended for these. Listed so the architect knows they were looked at.

- **Authorization helpers** (`src/lib/http/authz.ts`): every protected request re-reads the user row (status, role, MFA, forced password change). Cookie cache is disabled. `requireAdmin` builds on `requireAuth`.
- **Object ownership**: every learner route under `src/app/api` that takes an ID passes `session.user.id` down. Spot-traced files, attempts, exams, threads, projects, sessions and credentials all filter by owner in SQL.
- **Better Auth surface** (`src/app/api/auth/[...all]/route.ts`, `src/lib/security/better-auth-management-policy.ts`): allowlist only (get-session, verify-email, Google callback, sign-in/out, password reset, TOTP verify, backup code). `update-user`, direct sign-up and other management endpoints are refused.
- **Invite-only sign-up**: enforced in the `databaseHooks.user.create.before` hook (`src/lib/auth.ts:254+`). An account can only be created inside an authorized activation context with a consumed, unexpired invite.
- **Lost-device recovery**: one-time, expiring proof, rate limited per IP and per proof, then admin approval.
- **Admin credential reveal**: admin + recent MFA + reason + rate limit + audit event.
- **Data export** (`src/lib/data-lifecycle/export.ts`): excludes password hashes, OAuth tokens, MFA secrets, provider credentials.
- **Account deletion** (`src/lib/data-lifecycle/deletion.ts`): cross-checked all 125 tables in `src/lib/db/schema.ts`. Every learner-linked table is deleted directly or through `ON DELETE CASCADE` from a deleted parent. Tables not named are admin-authored (curriculum, career cards) or deliberately retained (audit events). The user row is pseudonymized; backups are honestly reported as expiring by retention.
- **File storage** (`src/lib/storage/durable-object-store.ts`): realpath pinning, `O_NOFOLLOW`, `/proc/self/fd` checks, owner-segment validation. Downloads are owner-scoped and blocked until the scan passes; the filename is sanitized in `Content-Disposition`.
- **Upload quota**: per-user advisory lock serializes concurrent uploads.
- **Rewards**: unique indexes on reward ledger, achievements and reconciliation jobs prevent double awards; `FOR UPDATE SKIP LOCKED` in the worker.
- **Credential vault** (`src/lib/security/credential-vault.ts`): envelope encryption with AES-256-GCM, a random data key and IVs, and the key wrapped with a master key.
- **AI tutor route**: thread ownership, closed-book gate, consent checks, per-minute and per-day limits inside an idempotent provider-operation receipt, provider error bodies never forwarded.
- **Markdown rendering**: `react-markdown` without `rehype-raw`; no raw HTML; CSP `img-src 'self' data: blob:` blocks image-based exfiltration from model output.
- **Error-monitoring tunnel**: fixed server-side target, envelope rewritten with the server DSN (no SSRF). Only rate limiting is missing (B.12).
- **GitHub URL parsing**: https + `github.com` only, two path segments, WHATWG normalization removes dot segments, `redirect: "error"`.
- **Legacy code runner** (`services/runner/src/docker-executor.ts`): `--network none`, `--read-only`, `--cap-drop ALL`, `no-new-privileges`, pids/memory/cpu/ulimit caps, tmpfs with `noexec` on `/tmp`, non-root uid 65532, read-only bind of input, normalized relative paths, HMAC-signed requests with nonce replay protection.
- **CI** (`.github/workflows`): top-level `permissions` read-only; only the manual image-release workflow gets `packages: write` / `id-token: write`; actions are pinned by SHA; Trivy, Syft, Grype, cosign/SLSA evidence and Dependabot are present.
- **Containers**: final images run as `USER node`; `.dockerignore` excludes `.env*`, keys and secrets.
- **Frontend browser storage**: only UI preferences in `localStorage`; drafts in `sessionStorage`, cleared on sign-out and account switch.

---

## Part E — Open-source options by area

For each area: what exists today, the options (with a recommendation first), license, and why. Licenses and project status are from the auditor's knowledge as of the audit date and **were not re-fetched from each project page**. Confirm license and maintenance status at adoption time.

General selection rules used:

- Prefer libraries that run on infrastructure you already have (Postgres, Docker, Node 22). Every new server is something to operate.
- Prefer permissive licenses (MIT, Apache-2.0, BSD, ISC) for code linked into the app. Codestead is AGPL-3.0, so AGPL dependencies are license-compatible, but permissive keeps options open.
- Standalone tools (k6, Grafana, restic) don't link into the app, so their license doesn't affect Codestead's.
- Scale: a small invite-only cohort (~20 learners) on one NUC. Pick the simplest tool that's well tested, not the most scalable.

### E.1 Background jobs, workers, scheduling, email — highest impact

**Today:**

- A custom transactional email outbox with prepared dispatch, provider correlation, Gmail reconciliation, guarded delivery, watchdog child processes and DB-level role contracts. About 17k lines of source, 23.6k lines of unit tests, 43k lines of infra harness tests, and eleven migrations (0059–0069) dedicated to mail authority.
- Nine separate worker entry points, each a hand-written polling loop with its own lease logic, mostly in separate containers: `process-outbox`, `process-rewards`, `process-assessment-regrades`, `process-exam-finalizations`, `process-practice-runner-recoveries`, `process-project-review-corrections`, `process-file-erasures`, `scan-uploads`, `data-lifecycle`.
- Retention, backup checks and restore-drill reminders are systemd timers.

**Why change:** this is the single largest maintenance surface in the repo, and the hardest to reason about. Exactly-once email is impossible in general; every mature system settles for at-least-once delivery plus an idempotent provider key or a Message-ID dedupe, which this code already approximates with much more machinery. A tested job queue gives retries, backoff, leasing, dead-lettering, cron, singleton jobs and observability in one place.

| Option | License | Runs on | Strengths | Trade-offs | Fit |
|---|---|---|---|---|---|
| **pg-boss** (recommended) | MIT | Existing Postgres | Queues, retries with backoff, expiration, dead-letter, cron schedules, singleton/throttled jobs, `SKIP LOCKED`; transactional enqueue (job inserted in the same transaction as business data) | No official web UI; polling-based (fine at this scale) | Excellent: zero new infra, enqueue inside existing Drizzle transactions |
| **Graphile Worker** | MIT | Existing Postgres | Very fast (LISTEN/NOTIFY), cron, job keys for de-duplication, `add_job()` callable from SQL/triggers | Fewer queue-management features than pg-boss; SQL-function oriented | Excellent alternative; strong if you like enqueuing from SQL |
| BullMQ (+ Bull Board UI) | MIT | Redis/Valkey | Mature, great UI, rate limiting, flows | Adds Redis, a second source of truth; enqueue is not transactional with Postgres | Not recommended here |
| Temporal | MIT | Temporal server + DB | Durable workflows, great for long multi-step processes | Heavy to operate | Overkill |
| Inngest / Trigger.dev (self-host) | Inngest server: SSPL (not OSI); Trigger.dev: Apache-2.0 | Their own server | Nice DX, step functions | Another service; Inngest server license is not OSI open source | Not recommended |

**Email composition and sending:**

| Option | License | Role | Why |
|---|---|---|---|
| **Nodemailer** (recommended) | MIT-0 | MIME composition (MailComposer) and SMTP/OAuth2 transport | The de-facto Node mail library; fixes B.8; supports Gmail OAuth2 SMTP or composing for the Gmail API |
| React Email | MIT | Templates as React components rendered to HTML + text | Replaces hand-written template strings; previewable |
| MJML | MIT | Responsive HTML email markup | Alternative to React Email |
| Mailpit | MIT | Local SMTP catch-all with a web UI and API | Use in dev and integration tests instead of the console adapter; assert on real MIME |

**Recommended shape:**

1. Business code enqueues `send-email` with a deterministic job key (`singletonKey` / `jobKey`) in the same transaction as the event. That replaces the outbox insert.
2. One worker process runs all queues: email, rewards, regrades, exam finalization, practice recovery, project-review corrections, file erasure, upload scans, retention (as a cron job).
3. The email handler composes with Nodemailer MailComposer, sends via Gmail API or SMTP, and records the provider message ID. Retries use backoff. The `Message-ID` header stays deterministic (as today) so duplicates are detectable.
4. Keep the existing idempotency and audit tables you actually need. Delete the guarded-delivery, watchdog and replay machinery once the queue is proven.

**What could be deleted:** most of `src/lib/notifications` (keep templates, preferences, the notification center), the associated `infra/tests/mail-*` harnesses, and the worker loops in `scripts/process-*.ts`. Several worker containers in `compose.yaml` could collapse into one.

**Migration risk:** medium. Run both paths in parallel for one queue (e.g. rewards) first, then email last.

---

### E.2 Secret scanning

**Today:** `scripts/scan-secrets.ts` + `scripts/lib/repository-secret-scan.ts` (230 lines of pattern matching over the working tree only).

| Option | License | Why |
|---|---|---|
| **gitleaks** (recommended) | MIT | Hundreds of maintained rules, scans **git history** as well as the tree, SARIF output, pre-commit hook, GitHub Action |
| TruffleHog | AGPL-3.0 | Can **verify** whether a found credential is live; heavier |
| GitHub secret scanning + push protection | Free for public repos | Blocks pushes containing known token formats at the server |

Justification: a 230-line regex list will never match the coverage of a dedicated, community-maintained ruleset, and it doesn't look at history, where most leaks live. Keep the custom scanner only for project-specific canaries (`src/lib/security/secret-canary.ts`), or express them as gitleaks custom rules.

### E.3 Rate limiting

**Today:** custom fixed-window limiter in Postgres (`src/lib/security/rate-limit.ts`) plus Better Auth's in-memory limiter.

| Option | License | Why |
|---|---|---|
| **rate-limiter-flexible** (recommended) | ISC | Mature; Postgres store available; sliding/fixed windows, block durations, insurance (fallback) limiter, consume-multiple-keys; fixes B.14 |
| Better Auth `rateLimit.storage: "database"` | MIT | Fixes B.7 with config only |
| Cloudflare WAF rate limiting rules | Free tier has limited rules | Edge-level protection for sign-in and invite endpoints; stops traffic before the NUC |

Justification: the custom limiter is actually decent. The main reason to switch is to stop maintaining it and to get sliding windows and blocking. If the team prefers to keep it, just apply the B.14 fixes.

### E.4 Static analysis (SAST) and supply chain

**Today:** ESLint, `npm audit`, Dependabot, Trivy, Syft/Grype, cosign evidence, and a custom `verify-known-dependency-advisories.ts`. **No code-level security scanner.**

| Option | License | Why |
|---|---|---|
| **Semgrep Community Edition** (recommended) | Engine LGPL-2.1; community rules under the Semgrep Rules License (free to use, not OSI) | Fast, TypeScript/React/Next rules, custom rules in YAML (e.g. "every route under src/app/api must call requireAuth or be allowlisted"; could replace part of `verify-api-auth-surface.ts`) |
| CodeQL (GitHub code scanning) | Free for public repos; CLI not OSI open source | Deep data-flow analysis for JS/TS; zero setup on GitHub |
| **OSV-Scanner** | Apache-2.0 | Lockfile scanning against the OSV database; could replace `verify-known-dependency-advisories.ts` |
| **OpenSSF Scorecard** | Apache-2.0 | Scores repo security practices (pinned actions, branch protection, token permissions) |
| **zizmor** | MIT | Security linter for GitHub Actions workflows (template injection, excessive permissions) |
| **actionlint** | MIT | Correctness linter for workflow YAML |
| eslint-plugin-security | Apache-2.0 | Cheap extra ESLint rules (non-literal regexp, child_process usage) |
| Knip | ISC | Finds unused files, exports and dependencies; valuable in a 440k-line repo |

### E.5 Password policy and account security

| Option | License | Why |
|---|---|---|
| **Better Auth `haveIBeenPwned` plugin** (recommended) | MIT | Already installed; blocks known-breached passwords via k-anonymity (B.13) |
| zxcvbn-ts | MIT | Password strength meter for the activation and change-password UI |
| Better Auth `passkey` plugin (WebAuthn) | MIT | Phishing-resistant second factor; could later replace TOTP for some users |

### E.6 Content Security Policy

| Option | License | Why |
|---|---|---|
| **Next.js nonce-based CSP via `proxy.ts`** (recommended) | — (framework feature) | Removes `'unsafe-inline'` for scripts (B.10) |
| `@nosecone/next` (Arcjet Nosecone) | Apache-2.0 | Prebuilt secure-headers and CSP helper for Next.js |

### E.7 Configuration and environment validation

**Today:** scattered `process.env` reads with fallbacks (B.9); some validated ad hoc.

| Option | License | Why |
|---|---|---|
| **@t3-oss/env-nextjs** (recommended) | MIT | zod schema for server/client env, fails the build or boot on missing or invalid values, type-safe access |
| envalid | MIT | Lightweight alternative |
| A single zod schema in `src/instrumentation.ts` | MIT (zod already used) | No new dependency |

### E.8 Testing and quality

| Area | Today | Option | License | Why |
|---|---|---|---|---|
| Disposable Postgres for integration tests | `scripts/run-integration-tests.ts` (648 lines, incl. Windows-specific logic) | **Testcontainers for Node** (`@testcontainers/postgresql`) | MIT | Starts and stops containers per suite with automatic cleanup (Ryuk); widely used; removes OS-specific harness code |
| Load testing | ~28,500 lines of custom production-load harness | **Grafana k6** | AGPL-3.0 (standalone binary) | Scripted scenarios in JS, thresholds as pass/fail gates, a browser module for real journeys, JSON/Prometheus output |
| | | Artillery | MPL-2.0 | Node-native alternative; Playwright engine for browser journeys |
| | | Locust | MIT | Python alternative |
| Architecture boundaries | `scripts/verify-import-boundaries.ts` | **dependency-cruiser** | MIT | Rules as config, graph output, editor feedback |
| | | eslint-plugin-boundaries | MIT | Boundaries as ESLint errors |
| Mutation testing (are the 5,928 tests actually asserting?) | none | Stryker Mutator | Apache-2.0 | Useful on the critical modules: grading, exam finalization, rate limiting, authz |
| Property-based testing | none | fast-check | MIT | Ideal for evaluators, normalizers, schedulers (e.g. would likely have caught B.1 as an invariant: "resubmitting a graded attempt never changes the response") |
| API contract tests | route tests | Pact JS | MIT | Only if a separate frontend or mobile client appears; low priority |
| Accessibility | `@axe-core/playwright` already | Lighthouse CI | Apache-2.0 | Performance and a11y budgets per PR |
| Email in tests | console adapter | Mailpit | MIT | Assert on real rendered MIME (would catch B.8) |

### E.9 Operations: backups, logs, metrics, uptime, secrets

**Backups today:** `scripts/backup/*` (~9,600 lines of Bash/TS) doing dumps, `age` encryption, offsite sync, retention and restore drills, plus systemd timers.

| Option | License | What it does | Why |
|---|---|---|---|
| **pgBackRest** (recommended for Postgres) | MIT | Full/differential/incremental backups, WAL archiving, **point-in-time recovery**, parallelism, encryption, S3/Azure/GCS/SFTP repos, `verify` and restore commands | PITR means losing minutes instead of up to a day; it's the standard for serious Postgres |
| WAL-G | Apache-2.0 | WAL archiving and base backups to object storage, PITR, encryption | Simpler than pgBackRest; good alternative |
| Barman | GPL-3.0 | Backup and recovery manager from EDB | Also mature |
| **restic** (recommended for files) | BSD-2-Clause | Deduplicated, encrypted snapshots of the upload store and configs to local/S3/B2/SFTP; `check` and `restore` | Replaces the file side of the custom scripts |
| BorgBackup + borgmatic | BSD-3-Clause / GPL-3.0 | Same idea; borgmatic adds DB hooks and retention policy config | Alternative |
| Kopia | Apache-2.0 | restic-like, with a UI | Alternative |

Keep `age` for any artifact you still produce by hand; restic and pgBackRest encrypt natively.

**Logging, metrics, tracing, alerting:**

| Option | License | Why |
|---|---|---|
| **pino** (recommended) | MIT | Structured JSON logs with levels and built-in `redact` paths (passwords, tokens, emails) instead of ad-hoc `console.info(JSON.stringify(...))` |
| OpenTelemetry JS SDK | Apache-2.0 | Traces and metrics from Next.js, pg, fetch; vendor-neutral |
| Prometheus + node_exporter + postgres_exporter | Apache-2.0 | Metrics for host, DB, app; the runner already has a `metrics.ts` |
| Grafana | AGPL-3.0 | Dashboards and alerting |
| Grafana Loki or VictoriaLogs | AGPL-3.0 / Apache-2.0 | Log storage and search |
| GlitchTip (already used) | MIT | Keep for errors |
| PgHero | MIT | Postgres health dashboard (slow queries, bloat, index usage) |
| pgBadger | PostgreSQL License | Log-based Postgres performance reports |

**Uptime and job heartbeats:**

| Option | License | Why |
|---|---|---|
| **Uptime Kuma** | MIT | Self-hosted HTTP/TCP/DB checks, notifications (email, Telegram, ntfy) |
| **Healthchecks.io** (self-hosted) | BSD-3-Clause | Dead-man's switch for cron and worker jobs: alerts when a backup, retention run or worker heartbeat **doesn't** happen. Fits the `worker-health` reporter and `learncoding-backup-check` timer |
| Gatus | Apache-2.0 | Config-as-code status checks |
| ntfy | Apache-2.0 / GPL-2.0 | Push notifications to your phone from scripts and alerts; could replace parts of `infra/ops/alert.sh` |

**Secrets management:**

| Option | License | Why |
|---|---|---|
| **SOPS + age** | MPL-2.0 / BSD-3 | Encrypted secrets committed to the repo, decrypted at deploy; you already use `age` |
| Infisical (self-hosted) | MIT core | Secrets UI, rotation, audit log |
| OpenBao | MPL-2.0 | Open-source Vault fork; heavy for this scale |

### E.10 Application libraries

| Area | Today | Option | License | Why |
|---|---|---|---|---|
| AI providers | Hand-rolled fetch for OpenAI, Anthropic, OpenRouter, NVIDIA NIM (`src/lib/ai/providers.ts`); no streaming; `response.json()` unbounded | **Vercel AI SDK** (`ai` + `@ai-sdk/openai`, `@ai-sdk/anthropic`, `@ai-sdk/openai-compatible`) | Apache-2.0 | One interface, streaming to the browser (tutor answers appear as they generate), structured output with zod, retries, abort, token usage; keep your own credential vault and policy routing on top |
| | | Official provider SDKs (`openai`, `@anthropic-ai/sdk`) | Apache-2.0 / MIT | If you prefer one SDK per provider |
| AI evals | `scripts/run-ai-eval.ts` | promptfoo | MIT | Declarative eval suites, regression across models and providers, CI-friendly |
| GitHub API | Hand-rolled fetch (`src/lib/github/reviewer.ts`) | **Octokit** (`@octokit/rest` + `@octokit/plugin-throttling` + `@octokit/plugin-retry`) | MIT | Handles primary and secondary rate limits and retries; typed endpoints; fixes the operational half of B.4 |
| Email MIME | Hand-built (`mailer.ts`) | **Nodemailer MailComposer** | MIT-0 | See E.1 and B.8 |
| Multipart upload parsing | `request.formData()` | busboy | MIT | Streaming parse with limits (B.11) |
| Resumable uploads | none | tus (`tusd` server, Uppy client) | MIT | Only if large uploads on flaky connections become a problem |
| Object storage | Custom hardened filesystem store | Keep. Optional: SeaweedFS (Apache-2.0) or Garage (AGPL-3.0) | — | The custom store is solid (Part D). Note: MinIO's community edition changed its distribution and admin-UI scope in 2025, so check current status before choosing it |
| Malware scanning | Custom clamd client | Keep (it's small and correct). Optional: `clamscan` npm | MIT | Low value in switching; fix B.15 instead |
| Markdown | react-markdown + remark-gfm | Keep. Add `rehype-sanitize` (MIT) only if raw HTML is ever enabled | MIT | Already safe |
| Feature flags (e.g. `CODE_RUNNER_PROVIDER`, `UPLOADS_ENABLED`) | env vars | OpenFeature SDK + Unleash (Apache-2.0) or Flagsmith (BSD-3) or GrowthBook (MIT) | — | Optional; env flags are fine at this scale |
| Date/timezone handling | `Intl` | Temporal polyfill (`@js-temporal/polyfill`) or date-fns-tz (MIT) | — | Only if timezone bugs show up in reminders or streaks |
| Spaced repetition | Custom scheduler | ts-fsrs (MIT): FSRS algorithm, used by Anki | MIT | Well-researched scheduling; worth evaluating against the custom review scheduler |
| Database role management | ~17,000 lines of bootstrap/verify scripts | Declarative roles in migrations; pgTAP (PostgreSQL License) to test grants | — | pgTAP expresses "role X can/cannot do Y" as SQL tests, much shorter than custom harnesses |

### E.11 Code execution (for completeness only — Piston is excluded)

No recommendation. For the record: Judge0 (GPL-3.0) and Piston (MIT) are the main open-source judges; gVisor (Apache-2.0) and Kata Containers (Apache-2.0) are sandbox runtimes. The current legacy runner is well isolated (Part D).

---

## Part F — Self-hostable open-source applications

Whole products that could take over a subsystem. Each line says whether it fits a ~20-user, single-NUC deployment.

| Application | License | Replaces / adds | Fit |
|---|---|---|---|
| Uptime Kuma | MIT | External uptime and status page | Good: tiny, one container |
| Healthchecks.io | BSD-3 | Missed-job alerting for backups, timers, workers | Good |
| Grafana + Prometheus + Loki | AGPL/Apache | Dashboards, metrics, logs | Medium: three services; consider only if the current logging is insufficient |
| GlitchTip | MIT | Error tracking | Already in use; keep |
| Mailpit | MIT | Dev/test SMTP catcher | Good (dev/test only) |
| ntfy | Apache-2.0 / GPL-2.0 | Push alerts to phones | Good |
| Infisical | MIT core | Secrets management | Optional |
| Unleash / Flagsmith / GrowthBook | Apache / BSD / MIT | Feature flags | Optional |
| Umami or Plausible CE | MIT / AGPL-3.0 | Privacy-friendly product analytics (which lessons people finish) | Optional; check against the privacy inventory |
| Listmonk | AGPL-3.0 | Newsletters/bulk mail | Not needed (transactional only) |
| Postal | MIT | Self-hosted mail server | Not recommended (deliverability burden); keep Gmail or use a transactional provider |
| Authentik / Keycloak / Zitadel | MIT-ish / Apache / Apache | Identity provider | Not recommended; Better Auth already fits |
| Discourse | GPL-2.0 | Community discussions | Optional: only if community features grow beyond the current custom module |
| Judge0 | GPL-3.0 | Code execution | Out of scope (Piston) |

---

## Part G — Decision table and phased roadmap

### G.1 Decision table

Effort: S = under a day, M = a few days, L = a week or more.

| # | Item | Type | Effort | Risk removed | What it lets you delete | Recommendation |
|---|---|---|---|---|---|---|
| 1 | B.1 graded-attempt probing | Bug fix | S | Mastery integrity | — | Do now |
| 2 | B.6 pool error listener + timeouts | Bug fix | S | App/worker crashes on DB blips | — | Do now |
| 3 | B.2 exam event ID namespace | Bug fix | S | Exam integrity evidence | — | Do now |
| 4 | B.3 deadline grace / early flush | Bug fix | S–M | Lost final answers, appeals | — | Do now |
| 5 | B.4 GitHub token + archive download | Bug fix | S–M | Reviews failing at scale | Per-blob loop | Do now |
| 6 | B.5 closed-book scope | Policy | S | Exam leakage via community | — | Decide |
| 7 | B.7 Better Auth DB rate-limit storage | Config | S | Limits reset on restart | — | Do soon |
| 8 | B.9 env validation (`@t3-oss/env-nextjs`) | Library | S | Silent misconfiguration | 22 fallback sites | Do soon |
| 9 | gitleaks + Semgrep/CodeQL + OSV-Scanner + zizmor | Tooling | S | Leaks, code-level vulns | Custom secret scanner, advisory script | Do soon |
| 10 | B.13 haveIBeenPwned plugin | Config | S | Weak passwords | — | Do soon |
| 11 | pino logging | Library | M | Leaky or inconsistent logs | Ad-hoc JSON logging | Do soon |
| 12 | Healthchecks.io + Uptime Kuma | App | S | Silent job/backup failures | Parts of alert scripts | Do soon |
| 13 | pg-boss (or Graphile Worker) for workers | Library | M–L | Bespoke polling and lease bugs | 9 worker loops, several containers | Plan |
| 14 | pg-boss + Nodemailer for email | Library | L | Mail subsystem complexity, B.8 | Most of `src/lib/notifications`, mail harnesses, 0059–0069 machinery | Plan |
| 15 | pgBackRest/WAL-G + restic | Tooling | M | Data loss window (PITR), script bugs | Most of `scripts/backup` | Plan |
| 16 | Testcontainers | Library | S–M | Flaky custom harness | `run-integration-tests.ts` | Plan |
| 17 | k6 | Tooling | M | Load-test maintenance | ~28k lines of production-load harness | Plan |
| 18 | Vercel AI SDK | Library | M | Provider drift, no streaming | Most of `providers.ts` | Plan |
| 19 | Nonce CSP (B.10) | Hardening | M | XSS impact | — | Plan |
| 20 | dependency-cruiser, Knip, Stryker, fast-check | Tooling | S each | Architecture drift, dead code, weak tests | `verify-import-boundaries.ts` | Optional |
| 21 | pgTAP for DB role tests | Tooling | M | Role-script maintenance | Parts of the ~17k-line role scripts | Optional |

### G.2 Phased roadmap

**Phase 0 — bug fixes (about one week).** Items 1–7 and 10. All small and local. Each lands with a regression test. Gate: unit tests green, plus a targeted integration test for B.2/B.3 on a Docker host.

**Phase 1 — cheap guardrails (about one week).** Items 8, 9, 11, 12. They mostly add tooling to CI and config. Gate: CI runs gitleaks, Semgrep and OSV on every PR; boot fails on a missing `APP_URL`.

**Phase 2 — job queue (two to three weeks).** Item 13 first, one queue at a time:

1. Introduce pg-boss alongside the existing loops. Move **rewards reconciliation** (lowest risk) and verify parity.
2. Move regrades, project-review corrections, file erasure and upload scans.
3. Move exam finalization and practice recovery (highest stakes) with extra tests.
4. Move retention and backup checks from systemd timers to pg-boss cron, or keep systemd plus Healthchecks pings.

Gate per queue: same outcomes on a replayed dataset; job failure alerts wired.

**Phase 3 — email on the queue (two to three weeks).** Item 14. Run the new path in shadow mode (compose and log, don't send), compare, then cut over per template. Gate: Mailpit-based MIME assertions in CI; deliverability check on real Gmail.

**Phase 4 — operations (one to two weeks).** Items 15–17. pgBackRest/WAL-G with a monthly PITR restore drill (rehearsed, timed); restic for uploads; Testcontainers; k6 scenarios replacing the custom harness. Gate: a documented, timed restore to a point in time.

**Phase 5 — optional.** Items 18–21 as capacity allows.

### G.3 Open questions for the architect

1. Closed-book scope (B.5): should community and battles be blocked during exams?
2. Is a minutes-level recovery point (PITR) worth adopting pgBackRest/WAL-G, or is daily-dump RPO acceptable for this cohort?
3. pg-boss or Graphile Worker? Both fit. pg-boss has more queue features; Graphile Worker is faster and lets triggers enqueue jobs.
4. Is the mail subsystem's exactly-once machinery required by a real compliance need? If not, at-least-once delivery with dedupe on a queue is the standard trade-off.
5. Should the AI tutor stream responses? It affects whether the Vercel AI SDK is worth it now.

---

## Part H — Verification log

### H.1 Commands run

```
git fetch origin main && git checkout origin/main      # 5ffe8623dd9d1701a86aa954457fb5300c924c09
npm ci --no-audit --no-fund                             # 693 packages
npm run typecheck                                       # EXIT 0
npm run lint                                            # 0 errors, 2 warnings
npx vitest run --maxWorkers=4                           # 513/517 files passed (4 skipped); 5,928 tests passed, 18 skipped
npm run build                                           # EXIT 0
```

### H.2 Scratch tests (written, run, deleted; working tree left clean)

- `src/lib/learning-service/__tests__/zz-audit-oracle.test.ts`: reproduces B.1 (full source in B.1). Result: passed, showing the defect.
- A Piston timing test was drafted and then stopped at the owner's request. Piston is out of scope.

### H.3 Library and upstream checks

- Better Auth v1.6.23 IP resolution: `node_modules/@better-auth/core/dist/utils/ip.mjs` (`getIPFromHeader`, `getIp`). Shows the multi-value `X-Forwarded-For` → `null` behaviour (C.1).
- Better Auth rate-limit storage: `node_modules/better-auth/dist/context/create-context.mjs:174` (default `memory`); `node_modules/@better-auth/core/dist/types/init-options.d.mts` (`storage?: "memory" | "database" | "secondary-storage"`).
- Better Auth unresolved-IP fallback: `node_modules/better-auth/dist/api/rate-limiter/index.mjs:281-287`.
- Better Auth HIBP plugin present: `node_modules/better-auth/dist/plugins/haveibeenpwned`.
- ClamAV `StreamMaxLength` default 100M: `https://raw.githubusercontent.com/Cisco-Talos/clamav/main/etc/clamd.conf.sample` (line ~179); official image does not override it: `https://raw.githubusercontent.com/Cisco-Talos/clamav-docker/main/clamav/1.4/alpine/Dockerfile`.

### H.4 Key files referenced

- `src/lib/learning-service/service.ts:439-560` (submitAttempt), `src/lib/learning-service/learner-activity.ts:317-346` (practiceFeedbackFor), `src/lib/learning-service/drizzle-store.ts:704-860` (resolveActivity)
- `src/app/api/exams/_lib/service.ts` (autosave 1221-1381, heartbeat 1383-1463, recordExamEvent 1465-1486, finalizeExam 2270+, appeal 2510+), `src/app/api/exams/_lib/policy.ts:129`, `src/app/api/exams/[sessionId]/events/route.ts`, `src/lib/exams/capability-gate.ts`, `src/components/exams/timed-exam-client.tsx:400-482`, `src/lib/exams/use-durable-exam-outbox.ts:40-43, 789-836`
- `src/lib/github/reviewer.ts:217-360`, `compose.yaml` (app service 285-368), `.env.example:96`
- `src/lib/db/client.ts`, `src/lib/notifications/mail-dispatch-pool.ts:39`
- `src/lib/auth.ts` (77-92, 180-189, 254-330), `src/app/api/auth/[...all]/route.ts`, `src/lib/security/better-auth-management-policy.ts`
- `src/lib/notifications/mailer.ts:108-176`, `src/lib/notifications/templates.ts:111`
- `src/lib/security/rate-limit.ts`, `next.config.ts`, `src/proxy.ts`
- `src/app/api/files/route.ts:83-112`, `src/app/api/files/[id]/route.ts`, `src/lib/storage/*`
- `src/app/api/monitoring/envelope/route.ts`, `src/lib/observability/envelope-tunnel.ts`
- `src/lib/data-lifecycle/deletion.ts`, `src/lib/db/schema.ts`
- `services/runner/src/docker-executor.ts:283-420`, `services/runner/src/validation.ts`, `services/runner/src/auth.ts`
- `.github/workflows/ci.yml`, `.github/workflows/application-image-registry-release.yml`, `Dockerfile`, `.dockerignore`
