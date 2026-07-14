# Overnight implementation decisions — 2026-07-14

This log records material autonomous decisions made while completing and hardening Codestead. Times use Asia/Kolkata. It is append-only for this implementation run; later corrections should add a new entry rather than rewriting the reason for an earlier decision.

## 01:03 — Preserve the existing modular-monolith architecture

- **Problem:** The requested product expansion spans learning, rewards, social, career, community, projects, notifications, and accessibility. A rewrite or premature service split would risk the mature security and evidence boundaries already present.
- **Decision:** Continue the existing Next.js/React/Drizzle/PostgreSQL modular monolith. Add capability-oriented domain modules and migrations only where durable state is required.
- **Alternatives considered:** Repository rewrite; new microservices for gamification/community; client-only state.
- **Reason:** The current architecture already has strong authorization, idempotency, audit, runner, lifecycle, and publication boundaries. The product is for a small private cohort, so a modular monolith is the least fragile choice.
- **Files affected:** No code change from this decision alone; it constrains all subsequent work.
- **Tests/evidence:** `npm run architecture:check` remains a mandatory release gate.
- **Remaining:** Reassess service extraction only after measured load or isolation evidence requires it.

## 01:08 — Keep the adult “code arcade field guide” visual identity

- **Problem:** The UI should be more colorful and fun, but generated recommendations suggested external Fira fonts, a mostly dark neon presentation, and a GSAP overlay transition that conflict with the established privacy, performance, accessibility, and adult-learning direction.
- **Decision:** Preserve the forest-and-paper base with cyan, violet, amber, and coral signal colors. Use system fonts, CSS-only 120/180/260 ms motion, and semantic light/dark/high-contrast tokens. Add energy at progress/checkpoint surfaces rather than turning every card into decoration.
- **Alternatives considered:** External Google Fonts; GSAP page overlays; child-oriented typography; dark-only neon UI.
- **Reason:** This keeps the interface distinctive and adult, avoids external font requests and a new animation dependency, maintains 200% text/reduced-motion support, and follows `design-system/learncoding/MASTER.md`.
- **Files affected:** Shell/global presentation workstream (in progress).
- **Tests/evidence:** Responsive, theme, reduced-motion, keyboard, and Axe/Playwright checks are required before acceptance.
- **Remaining:** Browser verification after the implementation workstreams merge.

## 01:11 — Split work by non-overlapping ownership

- **Problem:** The goal is broad and benefits from parallel implementation, but shared-file edits could corrupt migrations or overwrite UI work.
- **Decision:** Run three isolated workstreams: strict per-topic MCQ checkpoint; evidence-backed reward-ledger backend; shell-level UI/accessibility. The primary agent owns release evidence, integration, browser verification, and final integration.
- **Alternatives considered:** Serial implementation; agents editing broad feature areas without file boundaries.
- **Reason:** The split materially reduces elapsed time while keeping schema, lesson UI, and global shell ownership separate.
- **Files affected:** Agent-specific files only; no shared commit.
- **Tests/evidence:** Every workstream must report exact changed files and focused tests; the primary agent reruns global gates.
- **Remaining:** Integrate and independently review every result.

## 01:13 — Rewards must be derived from authoritative evidence

- **Problem:** XP, coins, levels, trophies, and challenges are motivating but can become fabricated or farmable if derived from page views, local games, or repeated practice.
- **Decision:** Use an append-only, idempotent, policy-versioned reward ledger keyed to authoritative evidence. Replays cannot award twice; corrections/revocations append compensating entries. Practice-only activity earns no unlimited official reward.
- **Alternatives considered:** Client-calculated totals; mutable balance columns; rewards for time/page views; decorative sample balances.
- **Reason:** This preserves the product's central truth contract and makes every total explainable and rebuildable.
- **Files affected:** Reward-ledger backend workstream (in progress).
- **Tests/evidence:** Cross-user, replay, concurrency, correction, deletion/export, and migration apply-twice tests are required.
- **Remaining:** UI celebration and spend semantics must use only committed ledger results; coins remain non-spendable until an honest purpose exists.

## 01:14 — Re-establish runtime evidence after the machine restart

- **Problem:** The laptop restart invalidated assumptions about running servers, Docker, and prior in-memory test state.
- **Decision:** Treat all processes as stopped, restart Docker Desktop only as a local test prerequisite, and rerun disposable PostgreSQL evidence instead of relying on pre-restart process state.
- **Alternatives considered:** Trust the previous test output; skip database validation.
- **Reason:** Source is durable, but runtime state is not. Fresh execution is the only honest post-restart evidence.
- **Files affected:** None.
- **Tests/evidence:** Seven PostgreSQL integration files passed **71/71** after the full migration chain applied twice.
- **Remaining:** Full integration suite, production build, and browser matrix still require fresh final runs after all edits land.

## 01:16 — Defer evidence-hash edits until schema work settles

- **Problem:** Nine evidence hashes are stale from already-tested legitimate lifecycle/schema/lesson changes. A concurrent reward migration may legitimately change the schema and journal again.
- **Decision:** Rerun the applicable 71-test PostgreSQL batch now, but update the evidence documents only after schema work completes, using final file hashes and explicit revalidation metadata.
- **Alternatives considered:** Patch the known hashes immediately; remove hash declarations; weaken the verifier.
- **Reason:** Patching early would make the records stale again; removing hashes would weaken the evidence gate.
- **Files affected:** Four evidence JSON records will be updated after final schema state.
- **Tests/evidence:** `npm run evidence:verify` currently reports exactly nine expected stale hashes across 190 links and 127 declarations; no other integrity issue is hidden.
- **Remaining:** Update final hashes, record current migration/test scope, rerun `npm run evidence:verify`.

## 01:27 — Preserve early malware-scanner verdicts

- **Problem:** ClamAV may return a terminal infected response and close its socket while a large upload is still being streamed. The following write failure could replace that authoritative verdict with a generic retryable infrastructure error.
- **Decision:** Race each framed write against the scanner response and prefer any complete response already received. Keep malformed or missing responses fail-closed.
- **Alternatives considered:** Retry every early close as an availability error; buffer the entire upload before scanning.
- **Reason:** An infected verdict must never be hidden, and buffering learner files would weaken bounded-memory streaming.
- **Files affected:** `src/lib/storage/clamd-client.ts`, `src/lib/storage/__tests__/upload-scanner.test.ts`.
- **Tests/evidence:** The storage scanner suite passes 23/23 runnable tests (one platform-specific test skipped); targeted ESLint passes. A real socket test now closes during upload after returning `FOUND` and the client preserves `infected`.
- **Remaining:** Final full-suite and production-runtime gates.

## 04:06 — Adopt Codestead as the public brand and mentor identity

- **Problem:** The repository and interface still used the working name LearnCoding and the generic label Buddy even after the owner selected a permanent identity.
- **Decision:** Use **Codestead** as the public product and AI mentor name, with **Build skills that stay.** as the tagline. Keep friendly “buddy-style” language as a tone, not as a second brand. Preserve operational identifiers such as existing database names, service paths, and migration history unless a separate migration justifies changing them.
- **Alternatives considered:** Rename every operational identifier immediately; keep separate product and assistant brands; leave the working name in emails and certificates.
- **Reason:** One learner-facing name reduces confusion while avoiding a risky, cosmetic infrastructure migration. The tagline describes the evidence-and-retention learning promise without claiming unreviewed content is mastered.
- **Files affected:** Metadata, navigation, authentication, onboarding, tutor surfaces, emails, certificates, documentation, Compose defaults, and package identity.
- **Tests/evidence:** Static brand scan, notification tests, production build, and real browser metadata/navigation checks are required.
- **Remaining:** Existing host paths and database/service identifiers intentionally retain `learncoding`; this is operational compatibility, not unfinished branding.

## 04:12 — Replace the first-reading wall with an evidence-informed lesson flow

- **Problem:** Even technically complete lesson drafts were presented as long reading pages and were not sufficiently interactive for a true beginner.
- **Decision:** Present each authored skill through predict, reveal, worked steps, trace, misconception check, fading practice, teach-back, and delayed retrieval. Keep the complete canonical reference collapsed and accessible. Treat analogies as optional and always disclose their limits.
- **Alternatives considered:** Shorten the content and discard detail; rely on an AI chat; add passive animation; leave all sections expanded.
- **Reason:** Active prediction and explanation make misunderstanding visible, while the collapsed reference preserves completeness. Research supports these ingredients with important limits, documented in [interactive beginner lesson design](interactive-lesson-pedagogy.md); deterministic assessment remains the authority.
- **Files affected:** `src/components/lesson/interactive-lesson-flow.tsx`, its styles/tests, and authored lesson integration.
- **Tests/evidence:** Component interaction tests cover ordering, reveal gates, analogy limits, fading practice, teach-back, and the non-authoritative scratchpad label. Responsive/reduced-motion/browser checks remain mandatory.
- **Remaining:** The 476 generated lessons still require independent human editorial review. The interaction design does not self-approve their content.

## 04:54 — Redact explicit multi-word credential labels conservatively

- **Problem:** A mentor evidence summary containing `access token=<long value>` could escape the shared redactor because credential labels only allowed underscore or hyphen separators and long single-alphabet tokens failed the entropy class gate.
- **Decision:** Recognize whitespace-separated credential labels and redact any non-placeholder runtime assignment of at least 16 characters. Keep the stricter multi-class/entropy policy for repository scanning so ordinary source prose does not create noisy false alarms.
- **Alternatives considered:** Add one special-case regular expression in the mentor reader; redact every occurrence of the word “token”; lower the repository scanner threshold globally.
- **Reason:** One shared privacy boundary prevents route-specific drift. Runtime projections should prefer a benign false positive over leaking a labelled secret, while source scanning still needs useful precision.
- **Files affected:** `src/lib/security/credential-patterns.ts`, `src/lib/security/__tests__/sensitive-text.test.ts`.
- **Tests/evidence:** Shared redaction unit tests pass 19/19; the real PostgreSQL mentor-evidence batch passes.
- **Remaining:** No known runtime credential-label gap remains; the final secret and full test gates still run after all edits settle.

## 04:59 — Keep misconception remediation inside the reviewed-content boundary

- **Problem:** The persisted learner-journey fixture placed answers and misconception probes in mutable activity JSON, but the hardened runtime correctly replaces that JSON with the immutable human-reviewed assessment item.
- **Decision:** Add optional private misconception mappings to eligible reviewed single-answer MCQ and trace items. Validate them strictly, remove them from learner assessment projections, and derive runtime grading/remediation only from the reviewed bank.
- **Alternatives considered:** Trust activity JSON for misconception tags; weaken the journey assertions; infer a misconception from arbitrary wrong answers.
- **Reason:** Misconception-first teaching remains testable without letting a mutable database row replace a reviewed answer oracle or expose wrong-answer mappings to learners.
- **Files affected:** Authored content types/schema/projection, assessment-bank JSON schema, publication binding and tests, and the synthetic learner-journey fixture.
- **Tests/evidence:** Publication/content tests pass 13/13, all 476 content packages validate, and the canonical disposable-PostgreSQL journey passes with migrations applied twice.
- **Remaining:** The committed draft banks remain unreviewed; this schema capability never turns an AI-authored mapping into official evidence by itself.

## 05:03 — Wire honest route states into the framework boundaries

- **Problem:** A polished route-state component existed, but Next.js had no root `loading`, `error`, or `not-found` boundary, so slow or failed server routes could still fall through to framework defaults.
- **Decision:** Reuse the shared Codestead route-state component for all three root boundaries. Errors expose only an optional opaque digest, preserve persisted-evidence wording, and offer retry/home actions.
- **Alternatives considered:** Duplicate states on every page; expose exception text for debugging; leave the framework defaults.
- **Reason:** A root boundary immediately covers public and authenticated routes, remains keyboard/reduced-motion/forced-colour safe, and avoids leaking internal errors.
- **Files affected:** `src/app/loading.tsx`, `src/app/error.tsx`, `src/app/not-found.tsx`, route-state wiring test.
- **Tests/evidence:** Route-state component/wiring tests pass 5/5 and targeted ESLint passes.
- **Remaining:** Final production-browser checks must exercise loading, retry, and missing-route rendering.

## 05:05 — Make the authenticated browser smoke a production-runtime test

- **Problem:** The repository had a valuable synthetic real-login browser harness, but it launched a development server and was not exposed as an npm command.
- **Decision:** Give it a first-class `test:browser:auth` command, build into an isolated temporary Next.js output directory, start in production mode, sign in a synthetic learner against disposable PostgreSQL, and clean up every temporary resource.
- **Alternatives considered:** Rely only on `AUTH_REQUIRED=false` Playwright tests; use a real learner account; test an anonymous redirect only.
- **Reason:** This closes the most important review gap without touching production data or credentials and proves real browser cookies, auth-required rendering, responsive layout, overflow, and Axe checks together.
- **Files affected:** `package.json`, `scripts/verify-authenticated-learn-runtime.ts`.
- **Tests/evidence:** Targeted ESLint passes. The final isolated production run remains pending until concurrent source edits stop.
- **Remaining:** Record the generated artifact path and exact browser result after the final run.

## 05:14 — Reject secret-like learner content before any durable side effect

- **Problem:** Tutor, request, report, community, portfolio, and project text can cross persistence, audit, hashing, export, or external-provider boundaries. Route-specific regular expressions would drift and could still leak a credential or hidden grading evidence through error text or a provider echo.
- **Decision:** Apply the shared sensitive-text boundary before replay lookup, hashing, persistence, export, or provider delivery. Provider output is also compared in memory against safe encodings of every candidate credential used for routing and is discarded with a non-echoing authored error if it reproduces one.
- **Alternatives considered:** Rely on log redaction; scan only learner input; sanitize after persistence; record the offending value for debugging.
- **Reason:** Preventing a secret from becoming durable is safer than trying to find every later projection. Boolean comparison preserves diagnosis without retaining the candidate.
- **Files affected:** Shared sensitive-text utilities plus tutor, learning-request, AI-report, community, portfolio, and project mutation routes and tests.
- **Tests/evidence:** Focused unit/route batches passed, the repository secret scan is a final gate, and the full disposable-PostgreSQL suite passed 192/192.
- **Remaining:** Operational keys pasted into chat must be revoked by their owner; no repository test can revoke an external credential.

## 05:19 — Make every privileged mutation fail closed before commit and truthful after commit

- **Problem:** A mutation that commits and then fails to write its completion audit must not tell the operator that nothing happened, because retrying that response can cause confusion or duplicate intent. Conversely, a mutation must not proceed when its required pre-audit cannot be established.
- **Decision:** Require fresh MFA, a reason, rate limits, and a fail-closed pre-audit for privileged certificate, career, community, module-project, credential, and session actions. If completion auditing fails after a successful transaction, return the committed result with a warning and correlation identifier instead of a false failure.
- **Alternatives considered:** Audit only after commit; roll back an already committed business transaction; hide audit degradation; let generic administrator authority bypass fresh MFA.
- **Reason:** This preserves both authorization and factual API semantics. Operators can reconcile an explicit degraded-audit warning without replaying a completed action.
- **Files affected:** Privileged administrator routes, mutation services, shared rate policies, and adversarial route/integration tests.
- **Tests/evidence:** Independent regression batches passed 147 tests with one intentional platform skip; the full PostgreSQL suite passed 192/192 with migrations applied twice.
- **Remaining:** Production alert routing for degraded audit writes is a deployment task.

## 05:23 — Snapshot the exact public portfolio projection

- **Problem:** Publishing a live pointer to an editable project would let later private edits silently alter the public portfolio without a new consent event, and legacy/corrupt rows could project secret-like text.
- **Decision:** Publish an immutable, versioned, owner-bound project snapshot. Public reads consume only that snapshot and fail closed if it is missing, corrupt, or secret-like. Snapshot rows participate in export, deletion, retention inventory, and an immutable database trigger.
- **Alternatives considered:** Resolve the latest project on every public request; copy only a project identifier; sanitize legacy content at render time.
- **Reason:** Explicit publication should approve an exact public representation, not all future private edits. Database immutability keeps that promise below the route layer.
- **Files affected:** Portfolio service/routes, schema and migration `0052`, privacy inventory/export/deletion, tests.
- **Tests/evidence:** Career/certificate/portfolio and lifecycle PostgreSQL tests passed; migrations `0000`–`0052` applied twice.
- **Remaining:** Public responsive/print browser verification remains in the final browser matrix.

## 05:27 — Let an explicit reminder opt-out win every race

- **Problem:** A worker could select an eligible reminder and dispatch it while the learner was opting out, turning an apparently successful preference change into an unwanted message.
- **Decision:** Keep every learning reminder explicit-off by default, recheck eligibility and evidence inside the dispatch transaction, and serialize preference and dispatch rows so an opt-out wins. Persist idempotent receipts and lifecycle-aware history rather than trusting an in-memory batch.
- **Alternatives considered:** Best-effort preflight checks; default-on reminders; sending then marking the preference; deleting moderation/dispatch history wholesale with the account.
- **Reason:** Consent must remain authoritative at the moment of dispatch. Durable receipts prevent duplicate sends and make export/deletion behavior explainable.
- **Files affected:** Smart-reminder service/worker, preference routes, lifecycle/export schema, and PostgreSQL tests.
- **Tests/evidence:** Reminder, lifecycle, and concurrency tests pass in the 192-test full integration suite.
- **Remaining:** Before an opted-in cohort exceeds 500, add a persistent rotating keyset cursor so fixed-size batches cannot starve later users. Gmail delivery remains external.

## 05:31 — Require explicit retirement before editing a published career card

- **Problem:** Treating `save` as a generic upsert allowed a currently published career card to be changed without the separately authorized retirement transition.
- **Decision:** Reject `save` for a published card. An administrator must perform the fresh-MFA, reasoned `retire` transition before editing and republishing a new reviewed version.
- **Alternatives considered:** Implicitly retire on save; permit in-place published edits; infer retirement from an empty field.
- **Reason:** Learners should never see an unreviewed mutation under a previously published identity, and the audit log should name the operator's real intent.
- **Files affected:** Career service/route and unit/PostgreSQL regressions.
- **Tests/evidence:** Career unit/route tests and the career-certificate-portfolio PostgreSQL suite pass.
- **Remaining:** Human-authored career cards and current market sources are still required before a real claim is published.

## 05:35 — Treat community deletion and retries as durable semantics

- **Problem:** Restoring an author-deleted post, accepting duplicate browser retries as new operations, or losing moderation history after account deletion would make community state misleading.
- **Decision:** Scrub author-deleted content irreversibly, reject restore, assign stable request UUID receipts to mutations, keep moderation history with privacy-safe tombstones, and use accessible tabs plus explicit retry/error states in the client.
- **Alternatives considered:** Soft-delete with restore; random request IDs per retry; erase all moderation evidence; optimistic UI without reconciliation.
- **Reason:** A small private community still needs predictable deletion, retry, and safety semantics. Stable idempotency prevents network retries from becoming duplicate posts or reports.
- **Files affected:** Community services/routes/UI, lifecycle/export logic, schema migration, and unit/PostgreSQL tests.
- **Tests/evidence:** Community/battle integration and focused accessibility/security tests pass.
- **Remaining:** Direct messages, public forums, live chat, and synchronous battles remain explicitly outside asynchronous v1.

## 05:39 — Make Codestead content branding mechanically enforceable

- **Problem:** Public lesson text and generator seeds still contained the working name after the product became Codestead, so future regeneration could reintroduce it.
- **Decision:** Replace public authored/generator references, preserve only compatibility identifiers such as `learncoding.local` and existing protocol labels, and add a brand-drift check to `npm run check`.
- **Alternatives considered:** Manual search before release; rename every database/protocol identifier; accept mixed branding in draft content.
- **Reason:** A deterministic gate prevents regressions without a risky cosmetic infrastructure migration.
- **Files affected:** 15 content files, two seed generators, runner/admin display metadata, `scripts/verify-content-brand.ts`, and package scripts.
- **Tests/evidence:** The scanner reports zero prohibited public references; all 476 lessons and 476 assessment banks validate.
- **Remaining:** Historical evidence retains the exact old labels it observed and must not be rewritten as if a prior scan saw Codestead.

## 05:48 — Rebuild release truth from the final schema, not stale prose

- **Problem:** Feature status understated implemented checkpoints, rewards, trophies, module projects, mentor context, and portfolio snapshots, while 20 evidence hashes no longer matched legitimately changed files.
- **Decision:** Reconcile status against current code and current tests; revalidate each declared evidence link after the schema settles; never delete hash declarations or silently relabel historical evidence as current.
- **Alternatives considered:** Blindly replace hashes; weaken the evidence verifier; keep stale counts; claim the old 71-test affected batch as the final suite.
- **Reason:** Release documentation is part of the product's evidence contract. It must distinguish implemented local behavior, human-content blocks, and external deployment work.
- **Files affected:** Feature status, security authorization inventory, release audit, evidence declarations, and this decision log.
- **Tests/evidence:** Migrations `0000`–`0052` applied twice and all 192 tests across 35 integration files passed; independent original-high regressions passed 147 with one intentional platform skip.
- **Remaining:** Complete the global quality gate, production real-auth/cross-browser runs, final evidence verification, and independent no-P0/P1 review before push.

## 12:46 — Keep accessibility controls inert until hydration owns them

- **Problem:** Firefox and WebKit could activate the first server-rendered accessibility select a few milliseconds before React attached its handler. The visual select changed, then controlled state restored the default, so the 200% text preference appeared not to persist.
- **Decision:** Render all four preference selects disabled in server HTML and enable them from a hydration-aware external-store snapshot. Keep individual preference writes atomic by merging against local storage at mutation time rather than a potentially stale React render.
- **Alternatives considered:** Add an arbitrary test delay; make the selects uncontrolled; write each preference into a separate key; ignore the non-Chromium failure.
- **Reason:** Users must never interact with a control before its durable handler exists. The hydration gate fixes the real race without timing assumptions, while atomic merging prevents consecutive native select events from losing a prior value.
- **Files affected:** `src/components/product/settings-view.tsx`, `src/components/shell/interface-theme-menu.tsx`, `src/lib/preferences/accessibility-preferences.ts` and focused tests.
- **Tests/evidence:** 22 focused unit/component checks, lint and typecheck passed; the real Firefox persistence/reload Playwright regression passed.
- **Remaining:** The full Firefox project plus WebKit/tablet/mobile reruns require browser-process permission; physical assistive-technology checks remain external.

## 13:04 — Make migration contracts forward-compatible

- **Problem:** The portfolio migration contract asserted that migration `0052` must remain the last journal entry, so the legitimate forward-only `0053_community_moderation_idempotency` migration broke the unit gate even though the complete PostgreSQL suite passed.
- **Decision:** Assert that migration `0052` exists at its exact index and tag without forbidding later migrations.
- **Alternatives considered:** Delete the portfolio contract; renumber `0053`; keep changing the expected “last” migration after every new migration.
- **Reason:** A migration contract should prove its own immutable journal identity, not freeze the repository against future forward migrations.
- **Files affected:** `src/lib/portfolio/__tests__/migration-contract.test.ts`.
- **Tests/evidence:** Both `0052` and `0053` migration contracts pass; the full disposable PostgreSQL suite passes 193/193 after the chain applies twice.
- **Remaining:** None for this contract.

## 13:14 — Preserve the branch-coverage threshold with boundary behavior

- **Problem:** The hydration safety work moved global branch coverage from 75.08% to 74.89%; the first boundary-test tranche raised it to 74.99%, one branch below the fixed 75% gate.
- **Decision:** Keep the 75% threshold unchanged and add behavior tests for unavailable storage, server rendering without browser globals, document-less helpers, storage-event filtering, durable editor-font fallback, blocked storage access and retryable administrator errors.
- **Alternatives considered:** Lower or round the threshold; exclude the preference module; add vacuous assertions.
- **Reason:** These are real defensive paths in privacy/accessibility code and an administrator recovery surface. Exercising them improves confidence instead of gaming the metric.
- **Files affected:** Preference and administrator state component tests only.
- **Tests/evidence:** 624/624 suites pass; 2,349 tests pass with 1 intentional skip and 0 failures. Coverage is 83.13% statements, 75.00% branches, 81.07% functions and 86.62% lines.
- **Remaining:** None for the coverage gate.

## 13:18 — Record browser and network boundaries as blockers, never passes

- **Problem:** The scoped five-project Playwright command could not receive approval because the Codex permission stream disconnected. Separately, a fresh runner-image rebuild and GitHub SSH probe could not resolve their external hosts.
- **Decision:** Retain exact successful local evidence, record the unexecuted or externally blocked checks explicitly, and never relabel historical browser or cached-image results as current fresh proof. Do not bypass process permissions, use pasted API keys, or weaken the browser matrix.
- **Alternatives considered:** Run the browser command through an indirect process; claim the focused Firefox result represents all engines; silently reuse old browser evidence; force a network-dependent rebuild or push.
- **Reason:** Environment failures are not product failures, but they also are not passes. A release record must preserve that distinction.
- **Files affected:** `docs/feature-status.md`, `docs/release-audit.md`, evidence revalidation metadata and this log.
- **Tests/evidence:** Current-source Chromium passes 60 tests with 3 intentional skips; focused Firefox persistence/reload passes; runner cached-image contracts pass 17/17 and real executor checks pass 4/4; production build generates 92 pages. A scoped source review reports no P0/P1 defects; this is not the signed OWASP or deployment review still required for release.
- **Remaining:** Rerun the full Firefox, WebKit, tablet/mobile and production-auth browser suites after explicit process permission; retry fresh Docker image acquisition and GitHub push when DNS is available.

## 13:36 — Close evidence drift without rewriting history

- **Problem:** Legitimate source and documentation changes produced a chronological sequence of 9, then 20, then 27 stale declarations. Leaving the earlier log entries unresolved could make a reader think those hashes still fail.
- **Decision:** Refresh only active declarations after source/document freeze, preserve every replaced value under `supersededDigests`, and leave the earlier counts as dated history. Re-run the entire aggregate gate before recording closure.
- **Alternatives considered:** Delete historical digests; weaken the verifier; rewrite earlier decisions; report every changed path as a new evidence document.
- **Reason:** The active evidence must match the current artifact while prior evidence remains auditable and cannot masquerade as current proof.
- **Files affected:** Seven evidence JSON records, `docs/feature-status.md`, `docs/release-audit.md` and this log.
- **Tests/evidence:** `npm run check` is green. Evidence integrity verifies 58 Markdown files, 262 local links, 80 JSON records, 66 referenced paths and 127 declared hashes. Release audit, secret and encoding gates also pass.
- **Remaining:** Evidence drift is closed. Browser/deployment/human-review blockers remain explicitly separate.
