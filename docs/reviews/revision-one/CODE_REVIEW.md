> Historical review of baseline `7a0dda402f0a3486c85de75f2c5fe5bbd8654479`, captured 2026-10-06. Read Revision Two for subsequent fixes and validation. Local evidence paths inside the archive document the original execution environment.

# Codestead: detailed code review and open-source replacement plan

Reviewed 2026-10-06. Repository: `dik5678920-bot/Codestead`, branch `main`, commit `7a0dda402f0a3486c85de75f2c5fe5bbd8654479`.

**Follow-up research:** [RESEARCH_ADDENDUM.md](RESEARCH_ADDENDUM.md) adds confirmed findings, rechecks all earlier conclusions, narrows runner exploitability claims, and supersedes the audit counts below with a later registry snapshot (seven high affected entries / three roots; production audit two). [NEW_LIBRARIES.md](NEW_LIBRARIES.md) adds upstream source/test research and isolated library comparisons. The earlier counts below remain dated evidence.

## Assessment

The architecture has several strong foundations: a modular Next.js application, PostgreSQL authority, Better Auth, explicit consent, server-side assessment evidence, an isolated execution service, durable browser queues, and unusually extensive tests for mail delivery and account deletion. Keep those foundations.

The biggest problems found are a reproducible runner-process crash, a release lock with newly reported high-severity dependency advisories, incomplete backup assurance, and several correctness/accessibility/privacy gaps. The best library migrations concern generic mechanisms: subprocesses, IndexedDB access, dialogs, resolved dependency analysis, provider protocols, and calendar arithmetic. The assessment, consent, revocation, deletion and delivery-authority rules remain application responsibilities.

This report separates **reproduced behavior**, **source-confirmed control gaps**, and **improvement recommendations**. P1 means address before relying on the affected production capability; P2 means a concrete defect or control gap to fix in a focused change; P3 means a lower-priority maintenance improvement. Conditional exposure is stated explicitly. No finding below claims a demonstrated production compromise.

The review inventories the major application, runner, data, browser, content, infrastructure, and CI boundaries. It does not certify every line or every production deployment behavior. Full authenticated browser journeys, actual language-container execution, live external-provider calls, a real R2 recovery, production load and host hardening were not executed here. The source tree and lockfiles were left unchanged; review probes are in ignored local files, and this report is outside the repository.

## Evidence and verification

| Check | Result and practical limit |
| --- | --- |
| Application install, typecheck, lint, production build | Passed during onboarding at this commit. Lint had two warnings. Host Node was 24.19.0; this does not prove compatibility with the production Node 22 image. |
| Application unit suite | 578 files: 572 passed, 2 failed, 4 skipped; 6,797 tests passed, 6 failed, 27 skipped. The six failures were Git archive-scanner portability failures, discussed in F11. |
| Affected scanner suites with `GIT_DISCOVERY_ACROSS_FILESYSTEM=1` | 50/50 passed. This is an environment workaround, not a source fix. |
| PostgreSQL integration suite | 51 files / 299 tests passed after the pinned PostgreSQL image was cached. Includes long mail-race tests. This did not run every separate infrastructure role/version matrix in CI. |
| Runner build/typecheck/tests | Passed: 97 Vitest tests plus 52 Node tests. Real runtime images were not built or exercised. |
| Auth-boundary sweep | Fresh review run: 2 files / 16 tests passed. These sweep registered handlers and anonymous rejection behavior using test fixtures/mocks; they are not proof of all cross-account authorization cases. |
| Content validation | Fresh review run passed: 12 launch tracks, 10 metadata-only roadmap tracks, 476 skills, 476 lessons, 476 question banks, schema/DAG/mapping/summary checks. This validates structure rather than all educational claims or live execution outcomes. |
| Import-boundary gate | Passed: 1,029 files, 4,387 imports, 10 documented exceptions, zero reported violations or stale exceptions. F10 shows why a passing result has limits. |
| Offline known-advisory gate | Passed. It checks specific historical esbuild/PostCSS conditions; it is not a general current vulnerability audit. |
| Live root lock audit | Failed: 21 high-severity affected package entries, arising from two advisory roots, not 21 independent vulnerabilities. Production-omit audit reported eight high affected entries. See F2. |
| Targeted review probes | Nine probes passed by asserting the defective behavior: two Piston cases, two monitoring cases, modal focus escape, confirmation unmount, step-up unmount, architecture bypasses, and project-review deductions. Passing these probes means the defects were reproduced. |
| Isolated subprocess reproduction | Node exited with an unhandled `write EPIPE` at process-executor.ts:114. See F1. |
| Browser smoke | Landing and courses pages worked with system Chromium; landing Axe scan reported zero violations. Full pinned Playwright browser installation was blocked by a CDN HTTP 403, so full E2E coverage is not claimed. |

Evidence files: [review probe results](probe-results.json), [full lock audit](evidence/audit-full.json), [production lock audit](evidence/audit-production.json), [runner crash log](evidence/runner-epipe.log), [library registry metadata](library-metadata.json), and [readable version/license table](LIBRARY_VERSIONS.md). Reproduction instructions are in [evidence/README.md](evidence/README.md).

Production TypeScript/TSX inventory, excluding `__tests__` paths and `.test.`/`.spec.` filenames: `src` has 558 files / 118,045 lines; runner source has 18 files / 4,764 lines; TypeScript scripts have 131 files / 36,113 lines. These counts describe scope, not a claim that every line received an equally deep audit. Shell/MJS/Python tooling adds substantial further operational code.

## Prioritized findings

### F1 — P1: early stdin closure can terminate the whole runner process

**Evidence: reproduced.** [process-executor.ts:114](../../../services/runner/src/process-executor.ts), [Docker invocation:375](../../../services/runner/src/docker-executor.ts).

`NodeProcessExecutor` handles errors on the ChildProcess but never handles errors on its stdin Socket. Writing 65,536 bytes to `/usr/bin/true`, which exits without reading stdin, emits `EPIPE` on that Socket. Node treats the unhandled stream event as fatal and exits. Rejecting/catching the outer promise does not catch an unhandled EventEmitter error. The Docker executor's `try/catch` therefore cannot contain this failure.

The helper is used to send learner stdin to Docker CLI invocations. A failing or early-closing CLI supplies the relevant condition. The isolated helper crash is demonstrated; a complete learner-to-Docker exploitation path was not exercised here.

**Fix:** attach stdin error handling before writing; classify expected early closure separately from infrastructure errors; settle exactly once; clear timers; preserve container cleanup. Consider replacing the generic spawn lifecycle with Execa, while retaining the runner's combined stdout/stderr byte cap, deadline, provenance, queue admission and explicit Docker cleanup. A process library cannot make hostile code safe.

**Acceptance:** isolated subprocess tests for early closure, command-not-found, timeout during write, output flooding and failed Docker startup must leave the runner alive and all containers removed. Assert a structured result/rejection rather than a process-level crash.

### F2 — P1 release gate: the current application lock fails its dependency policy

**Evidence: live registry audit.** [dependency policy](../../../docs/dependency-risk.md), [CI online audit](../../../.github/workflows/ci.yml).

The fresh full lock audit reports 21 high affected entries. The two underlying advisories are:

| Installed dependency | Advisory | Affected range | Remediation status observed |
| --- | --- | --- | --- |
| `source-map-js@1.2.1` | [GHSA-68fv-2mgg-jv7q](https://github.com/advisories/GHSA-68fv-2mgg-jv7q): event-loop denial of service through indexed source-map section offsets | `>=1.0.0 <1.2.2` | Registry has `1.2.2`. Update the transitive path in a controlled lock change and verify all copies. |
| `braces@3.0.3` | [GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm): stack exhaustion with deeply nested patterns | `<=3.0.3` | Registry latest was also `3.0.3`; there was no patched latest version to recommend blindly. Track an upstream fix, remove the path where feasible, or apply a reviewed patch. |

Observed paths include `source-map-js` under PostCSS/css-tree/magicast and `braces` under micromatch/fast-glob/Next ESLint tooling. The production-omit report lists eight high entries through dependency/peer relationships. That count does not prove eight independently exploitable runtime paths. No application route feeding attacker-controlled indexed maps or nested globs into the vulnerable functions was demonstrated.

The older zero-vulnerability result is dated historical evidence. The offline historical-advisory verifier still passes, and the existing online CI audit should catch relevant production advisories; this report is not alleging there is no online gate. However, CI uses `--omit=dev` while the documented release rule speaks about the application release lock. Clarify whether build/authoring dependencies are governed by a separate mandatory gate.

**Fix:** update the source-map path; handle braces through an actual upstream remediation or reviewed patch; refresh the dated disposition; run both production and build-time audits; rebuild and scan current images. Do not use `npm audit fix --force`, and do not fabricate a patched braces version. Registry audit severity is dependency evidence; runtime reachability needs separate analysis.

**Acceptance:** exact lock paths verified; the applicable release policy satisfied; fresh application/runner SBOM and scanner evidence tied to rebuilt digests; any exception explicitly bounded and dated.

### F3 — P1 when uploaded data exists: a missing object directory can still produce a healthy backup result

**Evidence: source and existing hermetic test.** [restic-backup.sh:52](../../../scripts/backup/restic-backup.sh), [existing no-uploads test](../../../infra/tests/restic-backup.test.sh), [restore test:75](../../../scripts/backup/restic-restore-test.sh), [active runbook](../../../docs/runbooks/backups-r2.md).

The active Restic script backs up only the database when the objects directory is absent **or a symlink**, then can mark the whole run successful. The log says this is the uploads-disabled case, but the branch does not inspect `UPLOADS_ENABLED` or the database's object references. A wrong data-root configuration or lost object directory is therefore indistinguishable from an intentionally unused feature.

The monthly restore test restores the database and verifies positive migration/table counts. It neither restores the objects nor checks hashes, schema/release compatibility, application access boundaries, credential decryptability or recovery handling for delivery authority. It can mark the restore test successful while uploaded-file recovery is broken. Its hermetic tests stub Docker, so their passing results are not a real Restic/PostgreSQL/R2 recovery.

This is a production recovery assurance gap; no actual lost production backup was observed. If uploads are disabled and no referenced files exist, database-only backup is a valid intentional mode.

**Fix:** record an explicit expected backup scope, fail closed if expected object storage is missing/unsafe, and reconcile the snapshot's live object metadata with a checksum manifest. Extend the active restore drill to the actual app plus files and authority checks. Retain Restic: the open-source migration has already been implemented. The two parked CI jobs belong to the older age/Drive path; add an active Restic recovery gate rather than assuming those jobs test R2.

**Acceptance:** missing-directory and wrong-root faults fail when file data is expected; every live object referenced by the recovered DB exists with the recorded hash; a clean isolated application starts and passes ownership/secret/recovery smoke checks; repository credentials and the separate vault master key have an independently tested recovery procedure.

### F4 — P2: database and object backups do not share a consistent recovery point

**Evidence: source-confirmed race window.** [database dump](../../../scripts/backup/restic-backup.sh), [later live object scan](../../../scripts/backup/restic-backup.sh), [normal file deletion](../../../src/lib/storage/file-deletion.ts).

The script dumps PostgreSQL first, then Restic reads the live object directory. The backup lock is documented as a mail-cutover fence; it does not stop ordinary application/file-erasure writes. If an object is live at the dump snapshot and is deleted before Restic reads it, the backup DB references bytes absent from that recovery set. Newer unreferenced objects are an easier reconciliation case; missing older referenced bytes cannot be reconstructed.

Restic provides repository integrity, encryption and snapshots of the files it reads. It cannot provide an atomic snapshot across an earlier `pg_dump` and a separately changing directory. This sequence was inspected, not reproduced against a live production writer.

**Fix:** choose a recoverable consistency strategy: briefly fence all relevant writes and physical erasures while creating a filesystem snapshot, or pin immutable objects referenced by the dump until the backup completes. Record the DB snapshot, release/schema version, object manifest and exact Restic snapshot ID as one recovery set. Use the same ID when restoring DB and uploads.

**Acceptance:** race a user deletion/account erasure with a real backup and prove all recovered live references are resolvable; separately prove deleted data remains subject to the documented backup-retention policy. Do not bypass application erasure guarantees to simplify backups.

### F5 — P2: the browser monitoring tunnel forwards unsanitized event data

**Evidence: two reproduced cases.** [envelope-tunnel.ts:36](../../../src/lib/observability/envelope-tunnel.ts), [route](../../../src/app/api/monitoring/envelope/route.ts), [fingerprint field](../../../src/lib/observability/error-monitoring.ts).

The tunnel authenticates and rate limits requests, bounds them to 256 KiB, validates envelope shape/item type, and rewrites the DSN. It does not scrub the parsed event before forwarding the original payload lines. A syntactically valid event containing a synthetic email and an Authorization header passes through unchanged. Separately, `scrubEvent` retains arbitrary fingerprint strings; a synthetic Bearer sentinel survives that utility.

Normal browser SDK `beforeSend` behavior reduces exposure, but a client-controlled privacy boundary cannot enforce the server's advertised secret/PII exclusion. This is a forwarding/sanitization defect, not a demonstrated ability to read another user's credentials. Monitoring must be configured for external forwarding to occur.

**Fix:** validate and rebuild each event on the server using the allowlisted scrubber; scrub or reject fingerprint/logger/SDK metadata strings as appropriate; drop user objects, request headers/bodies and unknown fields. Recalculate envelope item lengths after rewriting. Maintain caps and rate limits. Keep the Sentry SDK; no replacement library alone guarantees the application-specific privacy policy.

**Acceptance:** canaries in every accepted event field, envelope header and nested payload are absent from the final outbound bytes; valid scrubbed events remain ingestible; malformed or unsupported envelopes are rejected.

### F6 — P2: Piston TEST grading compares truncated display output and ignores output-limit state

**Evidence: two reproduced cases with a mocked Piston transport.** [piston-client.ts:308](../../../src/lib/runner/piston-client.ts), [budget logic:137](../../../src/lib/runner/piston-client.ts).

TEST mode creates a fresh budget per test, truncates stdout, then compares the truncated string to the expected answer. It never uses `testBudget.truncated` to set `OUTPUT_LIMIT`. With `outputBytes:16`, output longer than that is converted to an empty string because the truncation marker will not fit. A test whose expected stdout is empty is then marked `PASSED`, and the job is `ACCEPTED`, despite nonempty wrong raw output.

Hidden-test stderr is not passed through the budget at all. A test with expected stdout `ok`, actual stdout `ok`, stderr of 100 bytes and a 16-byte cap is accepted. Fresh per-test budgets also differ from the legacy executor's job-wide budget. The default legacy provider and normal larger caps narrow immediate exposure; these probes do not establish cheating against a currently published exam. They do establish backend contract violations.

**Fix:** compare semantic raw output independently of its display projection; account for stdout/stderr and compile/test stages under the intended job-wide limit; classify limit exhaustion before `PASSED`. Preserve hidden-output omission in user responses.

**Acceptance:** backend parity tests at tiny/boundary/default budgets, multibyte cuts, hidden stderr, multiple tests, compile output, timeout/limit precedence, and wrong output that resembles a truncation marker. No truncated output may produce a successful grade.

### F7 — P2: confirmation and step-up promises survive unmount without settling

**Evidence: two reproduced cases.** [use-confirm.tsx:30](../../../src/components/ui/use-confirm.tsx), [global pending step-up](../../../src/components/admin/step-up-request.ts), [unregister cleanup](../../../src/components/admin/step-up.tsx).

`useConfirm` resolves a replaced prompt and an explicitly settled prompt, but has no unmount cleanup. Awaiting code can remain suspended after its host disappears. More seriously, the step-up coordinator stores a global pending promise; unregistering the dialog does not resolve or invalidate it. After a new prompter mounts, a later `withStepUp` call can reuse the old unresolved promise and never continue until the page reloads.

**Fix:** provide explicit cancellation/unmount settlement, clear a pending prompt only if its identity/generation still owns the slot, and cancel pending verification requests. Resolve abandoned confirmations as false. Dialog primitives help accessibility but do not fix this promise ownership problem automatically.

**Acceptance:** pending prompt unmount, logout, admin-frame removal/remount, parallel callers, verification races and React Strict Mode must settle every caller exactly once without authorizing an abandoned action.

### F8 — P2: modal focus containment depends on where the component is mounted

**Evidence: reproduced nested-modal focus escape.** [modal-dialog.tsx:47](../../../src/components/ui/modal-dialog.tsx), [tab handling](../../../src/components/ui/modal-dialog.tsx), [separate admin step-up form](../../../src/components/admin/step-up.tsx).

The shared modal marks only its immediate parent's other children inert. Content outside that parent remains interactive. The keyboard trap only wraps when focus is already at the first/last control; it does not contain focus that moves outside. In the reproduction, a button outside the immediate modal parent can retain focus and has no inert ancestor. The administrator step-up implements another standalone `aria-modal` form without the shared containment logic.

This affects keyboard/screen-reader usability and reliable dialog interaction. It is not a server authorization bypass. The clean landing-page Axe scan does not cover these mounted dialog states.

**Replace:** use Radix Dialog or React Aria Components Dialog/Modal as one common primitive, including the admin step-up, and preserve the app's visual design. Test portals, focus restoration, nested overlays, scroll locking, labels/descriptions and Escape/cancel policy. Fix F7 separately.

### F9 — P2: PR changes to important database writers can skip every PostgreSQL integration job

**Evidence: workflow source.** [database path filter](../../../.github/workflows/ci.yml), [conditional integration job](../../../.github/workflows/ci.yml), [accepted filtered skip](../../../.github/workflows/ci.yml).

The filter covers database/notification code and six named service files, but omits whole directories containing other DB writers and transaction policies. Examples include `src/lib/security/session-takeover.ts`, `src/lib/ai/provider-operation-idempotency.ts`, `src/lib/data-lifecycle/**`, `src/lib/storage/**`, `src/lib/rewards/**`, and exam API implementation. A PR that changes only such a file and leaves tests/config untouched can set the database gate false, skip all integration shards/mail races, and have that skip accepted by the aggregate gate.

Unconditional static/unit gates still run, and non-PR events enable the database gate. This is a pre-merge real-database coverage gap, not proof that no tests run or that a specific bad PR merged.

**Fix:** initially gate database integration on `src/**` and migration/runtime tooling. If selective execution is needed later, derive it from a resolved dependency graph and test the filter against the inventory of SQL/Drizzle writers. Keep the existing paths-filter library; expanding correct configuration is simpler than building another filter framework.

**Acceptance:** representative isolated PR changes to every persistence/security boundary select the real-database gate, and the aggregate job rejects unexpected skips.

### F10 — P2: the architecture checker can be bypassed by equivalent import syntax

**Evidence: reproduced by executing the actual rule functions extracted from the checked-in script.** [verify-import-boundaries.ts:44](../../../scripts/verify-import-boundaries.ts), [directive check:67](../../../scripts/verify-import-boundaries.ts).

The rules compare raw `@/...` strings rather than resolved files. A domain import of `@/lib/db/client` is rejected, while the equivalent `../db/client` is accepted. The client-module rule checks whether source text literally starts with `"use client"`; a valid leading comment before the directive causes `node:fs` to escape that rule. The checker does not traverse a client module's dependencies to find a server runtime import in another file.

This is an enforcement gap; no actual production secret bundled into the browser was demonstrated. Next build/module rules can catch some runtime incompatibilities, but they do not enforce all these architectural policies.

**Replace:** dependency-cruiser with TypeScript/Next resolution and explicit forbidden rules, or a maintained resolved ESLint boundaries configuration. Add Next's `server-only` marker to genuinely server-only entry points as a second guard, with compatible test aliases. Parse directives from the AST when required. Keep narrowly reviewed exceptions, stale-exception checks and deterministic evidence.

**Acceptance:** alias/relative/re-export/dynamic-import paths, leading comments, client transitive dependencies and mixed extension cases are tested. Existing ten exceptions have an explicit extraction/removal plan.

### F11 — P2: archive scanning depends on one exact Git error message

**Evidence: six unit failures in this environment, followed by a passing environment workaround.** [repository-git-files.ts:100](../../../scripts/lib/repository-git-files.ts).

Archive fallback recognizes exit code 128 only if stderr exactly equals the canonical English no-repository line. Git's filesystem-boundary case produces different/additional wording, so a valid non-Git archive can cause scanning to throw. This accounted for the six unit failures during onboarding. `GIT_DISCOVERY_ACROSS_FILESYSTEM=1` changes discovery behavior and makes the affected 50 tests pass; it does not repair the classifier.

**Fix:** detect the repository/archive context robustly and classify known no-repository cases under a controlled locale. Preserve fail-closed behavior for corrupt metadata, unexpected permissions and unrelated Git failures. Do not treat every exit code 128 as a safe archive, and do not introduce simple-git just to keep parsing stderr.

**Acceptance:** real checkout, plain archive, mount boundary, localized stderr, nested checkout and corrupt/inaccessible `.git` cases give the intended result without excluding sensitive untracked archive content.

### F12 — P2: the repository reviewer penalizes files outside its inspection sample

**Evidence: reproduced.** [first-120 selection](../../../src/lib/github/reviewer.ts), [README/test deductions](../../../src/lib/github/reviewer.ts).

The reviewer loads the full tree but chooses only the first 120 eligible blobs. It then derives missing-README and missing-tests findings from `seenPaths`, which contains only downloaded sample files. A tree with 120 earlier eligible files followed by a real `README.md` and `tests/example.test.ts` receives both deductions. The resulting deterministic score is lower despite those files existing.

The limitations correctly disclose the sample size and warn that pattern analysis is not proof of security. They do not make a false absence deduction fair. This matters because quality scores are persisted as review evidence and can enter learner-facing project decisions.

**Fix:** determine repository-level path existence from the full bounded tree; reserve inspection slots for important documentation/config/test samples; distinguish absent, present-but-unread and inspected states. Version the analyzer/rubric change and use the existing correction mechanism for affected evidence instead of silently overwriting history.

**Acceptance:** tree-order and sample-boundary tests do not alter existence deductions; capped/partial reviews visibly disclose uncertainty; corrected review provenance stays append-only.

### F13 — P2: GitHub review bounds bytes selected for source analysis, but not total request work

**Evidence: source inspection.** [body parsing](../../../src/lib/github/reviewer.ts), [sequential blob fetch](../../../src/lib/github/reviewer.ts), [authenticated route](../../../src/app/api/projects/[id]/review/route.ts).

Each request has a 15-second deadline, but there is no whole-review deadline. Up to 120 blob requests run sequentially after metadata/commit/tree requests. Repeated near-deadline responses can occupy one review request for roughly 30 minutes. The 5 MiB selected-source cap is applied after parsing the full recursive tree; response JSON/base64 bytes are not bounded before buffering/parsing. GitHub itself imposes limits, so this is not a claim of unlimited arbitrary-host fetches. Authentication, ownership and a five-per-hour user budget also limit abuse, but rate limits do not cap simultaneous in-flight work across users.

**Fix:** one operation deadline, bounded response readers for every API response, actual decoded-size verification, cancellation propagation and a small global concurrency limit. Octokit can replace protocol plumbing; its default pagination/retry behavior must be constrained. `p-queue` or `p-limit` can govern concurrency without changing review ownership or evidence.

**Acceptance:** slow tree/blob responses, huge responses, upstream rate limiting, disconnects and simultaneous users complete/fail within explicit wall-time and memory/concurrency budgets, with no partial review persisted as complete.

## Other improvements and design decisions

These are recommendations rather than additional demonstrated security vulnerabilities.

1. **Bound JSON before parsing.** Several routes call `request.json()` and then validate maximum string/array lengths with Zod. Some sensitive routes already use bounded readers, including monitoring and AI-model administration. Apply a consistent bounded reader to other substantial JSON endpoints. Handle chunked bodies, malformed JSON, body timeout and 413/400 semantics. Do not claim the deployed app is universally unbounded: Next and ingress may also impose limits, and their effective production configuration was not exercised.
2. **Make export streaming demand-driven and state its consistency contract.** [export.ts:972](../../../src/lib/data-lifecycle/export.ts) performs all page queries/enqueues in async `start`, independent of consumer demand. The 20 MiB/10,000-record maximum bounds buffering, but backpressure is not used. Independent offset pages also do not provide one PostgreSQL MVCC snapshot under concurrent edits/deletions. Prefer `pull`/cancellation plus keyset pages, or a carefully bounded snapshot/cursor where point-in-time consistency is required. A library is optional; the authorization, redaction, footer and audit contract must remain.
3. **Avoid full-history dashboard reads as retention grows.** [learner.ts:619](../../../src/lib/dashboard/learner.ts) and [attempt history:630](../../../src/lib/dashboard/learner.ts) load all matching completion/attempt history for activity projections. This is plausible at the small pilot scale, but grows with account lifetime. Use indexed aggregates and bounded recent activity for weekly totals, and a dedicated streak projection/reconciliation query. Measure with `EXPLAIN (ANALYZE, BUFFERS)` and realistic history before adding infrastructure.
4. **Treat AI SDK migration as a protocol change.** [providers.ts](../../../src/lib/ai/providers.ts) hand-builds OpenAI-compatible/Anthropic requests and parses responses. Official SDKs can reduce compatibility drift, but preserve conservative budget reservations, explicit model selection, request idempotency, credential status, consent and no blind retry after an ambiguous provider response. The existing custom-provider transport has public-address validation, DNS pinning, TLS host validation, redirect rejection and body caps. Keep those when replacing its transport. Known-provider native fetch paths should also have explicit response-byte bounds; a deadline alone does not cap memory.
5. **Standardize calendar operations.** Reminder, reward, inactivity and dashboard paths use local-day/IANA-timezone rules. Adopt one calendar utility backed by Luxon or Temporal rather than scattering more arithmetic. Keep elapsed-time deadlines in monotonic/UTC time; do not turn exam deadlines into local-calendar calculations. Include DST, month/year rollover and timezone-change tests.
6. **Version and consolidate canonicalization.** [appeal hashing](../../../src/lib/appeals/evidence.ts) and [social hashing](../../../src/lib/social/hash.ts) use different canonicalization semantics (`sort()` versus locale comparison, different undefined handling). A maintained canonical-JSON implementation can support new protocol versions. First define the allowed JSON domain and rejection behavior; preserve old hashes and replay compatibility. A hash format change is an evidence migration, not a tidy refactor.
7. **Reduce giant hooks/services by responsibility.** Durable exam outbox (~2,402 lines), draft hook (~1,177), exam service (~2,928), PostgreSQL outbox store (~4,840), schema (~4,493), retention (~1,636), deletion (~1,203), and restore tooling contain substantial coupling. Extract protocol/state transitions, storage adapters, projections and orchestration behind existing tested boundaries. Splitting files alone does not reduce complexity or prove safer behavior. XState may help make browser transitions explicit; it is not durable storage or a substitute for server authority.
8. **Update operational/security documents from current policy.** [architecture.md:175](../../../docs/architecture.md) describes disabled trusted-device bypass and short MFA windows. [privileged-access.ts](../../../src/lib/security/privileged-access.ts) explicitly records the 2026-09-26 owner decision: administrator freshness 24 hours, learner self-service valid for the MFA-completed session, and trusted sign-in device for 24 hours. Do not label that authorized policy a coding regression; document its tradeoff and align runbooks/tests. Similarly align Node versions, dependency dispositions, active Restic backup instructions and architecture exception counts. Preserve dated historical evidence instead of rewriting it as current proof.
9. **Unify runtime compatibility.** The cloud validation used Node 24, CI generally pins 22.23.1, the application Dockerfile pins 22.23.3, and runner manifest accepts Node >=20.9.0. Explicitly choose supported runtime versions and validate the actual release image. Execa 10 and several current SDKs require Node >=22; installing latest versions without resolving the runner floor creates a compatibility problem.
10. **Strengthen meaningful fault/property tests.** The test volume is valuable, but the defects above survived it. Add state/ownership properties for durable replay, namespace clearing, prompt lifecycle, deletion versus delivery, quotas and backend grading parity. `fast-check` can explore legal/illegal event sequences. Use MSW for UI HTTP behavior where it reduces brittle hand mocks. Keep real PostgreSQL role/concurrency tests; mocks cannot prove transactions, grants, locks or serialization. Testcontainers can simplify disposable lifecycle only if it preserves ownership/cleanup safeguards.
11. **Separate educational signals from code correctness.** The reviewer flags any `exec(` as dynamic evaluation, including benign regex `.exec()` calls, and text patterns can match comments/strings. A real parser/AST analysis or isolated Semgrep rules would improve precision; CodeQL may be appropriate in CI, subject to its licensing/use terms. Keep analyzer versions, limitations and correction/regrade provenance. Continue structural curriculum gates, but add sampled human instructional review and executable language parity before promising content correctness.
12. **Instrument operationally useful signals safely.** Track runner crashes/queue latency, outbox ambiguous states and age, DB pool saturation, draft/exam replay lag, erasure backlog, backup freshness and actual restore results. OpenTelemetry and Pino can standardize instrumentation/log structure if operationally useful, but privacy allowlists and low-cardinality labels remain mandatory. Never attach source code, credentials, hidden tests or learner IDs as broad telemetry payloads.

## Open-source replacement matrix

Package names below identify concrete candidates, not a proposal to install everything. Registry metadata for 46 packages was captured in the evidence file. Latest versions are observations, not versions proven compatible here. For each adopted library, pin a reviewed compatible release, inspect its advisories/license/transitive surface, and run the specific behavior tests. Maintenance/popularity and a published test suite do not guarantee suitability for this application's guarantees.

| Area / current code | Recommended library or tool | Decision and scope | Contract that must survive |
| --- | --- | --- | --- |
| Generic runner subprocess lifecycle, `process-executor.ts` | [Execa](https://github.com/sindresorhus/execa) | **High-value replacement after F1.** Use argument arrays and streaming/bounded collection. Current Execa 10 needs Node >=22; reconcile runner support. | Combined byte cap, kill/cleanup, wall deadline, no shell interpolation, infrastructure classification. |
| Custom modal, alert and MFA dialogs | [Radix Dialog](https://www.radix-ui.com/primitives/docs/components/dialog) or [React Aria Components](https://react-spectrum.adobe.com/react-aria/components.html) | **High-value replacement. Choose one**, shared by all dialogs. | Cancel policy, labels, focus restoration, nested overlays, scroll behavior; separately settle promises. |
| Raw IndexedDB transaction/cursor plumbing, `browser-durability/indexed-db.ts` | [idb](https://github.com/jakearchibald/idb) | **High-value small replacement.** Dexie is an alternative if richer indexed queries become necessary; do not add both. | Wait for transaction completion, not request success; owner namespaces, tombstones, atomic compaction, quota/error behavior. |
| Complex browser exam/draft orchestration | [XState](https://stately.ai/docs/xstate) | **Conditional**: model explicit transitions incrementally; extract pure reducer tests first. | Durable IDB records, server revisions, session/owner fences, retry rules, clock authority. |
| Ordinary settings/admin network state | [TanStack Query](https://tanstack.com/query/latest) | **Conditional** for repeated cache/fetch/retry/UI state. Keep critical submission queues separate. | User-scoped keys and logout purge; no automatic non-idempotent retries; no cached secrets or hidden evidence. |
| Repeated form state | [React Hook Form](https://react-hook-form.com/) + [Zod resolvers](https://github.com/react-hook-form/resolvers) | **Selective** adoption for complex onboarding/settings/admin forms. Small forms may remain plain React. | Server Zod validation and authorization remain authoritative; focus/errors accessible; no sensitive persistence. |
| Import graph checker | [dependency-cruiser](https://github.com/sverweij/dependency-cruiser) | **High-value replacement** for raw specifier matching; configure TypeScript aliases and Next client/server policy. | Explicit exceptions, stale checks, deterministic output, transitive forbidden edges. |
| Dependency/entry-point cleanup | [Knip](https://knip.dev/) | **Useful analysis**, not an automatic delete operation. Configure scripts, tests, dynamic imports and authored runtime dependencies. | Curriculum-only packages and CLI entry points remain registered; validate before removing dependencies. |
| OpenAI/Anthropic protocol adapters | [OpenAI SDK](https://github.com/openai/openai-node), [Anthropic SDK](https://github.com/anthropics/anthropic-sdk-typescript); [AI SDK](https://ai-sdk.dev/) as an alternative | **Selective** protocol replacement. Choose direct SDKs for a thin adapter or a unified layer if it earns its complexity. | Custom pinned transport, explicit retries, conservative cost settlement, consent, provider selection and safe errors. |
| SSRF address classification | [ipaddr.js](https://github.com/whitequark/ipaddr.js) | **Good parsing/subnet utility**; maintain the application's public-address policy and IANA range review. | DNS results validated and pinned into the actual TLS connection; redirects blocked; host/SNI verification retained. |
| HTTP connection/response plumbing | [Undici](https://undici.nodejs.org/) | **Conditional** after proving pinned lookup/redirect/decompression/byte-limit semantics. Native fetch is already Undici-backed in Node. | A generic fetch client is not an SSRF defense; explicit deadlines and byte bounds remain. |
| GitHub request construction/types | [Octokit](https://github.com/octokit/rest.js) | **Good replacement** for protocol maintenance after F12/F13 bounds are defined. | Exact commit pinning, no repository execution, bounded fetch, total deadline, controlled pagination/retries. |
| In-memory runner/reviewer concurrency | [p-queue](https://github.com/sindresorhus/p-queue) | **Conditional** for generic concurrency/backpressure; a small queue may be cheaper to keep. | Admission limits, fairness, durable idempotency and journal state are separate; no duplicate jobs after restart. |
| Retry helpers | [p-retry](https://github.com/sindresorhus/p-retry) | **Only for operations proven safe to repeat.** | No blind AI/email retry after uncertain external effects; respect abort/deadline and Retry-After. |
| Generic PostgreSQL jobs and periodic work | [pg-boss](https://github.com/timgit/pg-boss) or [Graphile Worker](https://worker.graphile.org/) | **Conditional; choose one** for ordinary noncritical jobs/scheduling if it meaningfully reduces tooling. No Redis requirement. | Least-privilege schema/roles, account lifecycle fences, receipt semantics and backup/recovery integration. |
| Critical mail delivery-authority state machine | Existing PostgreSQL fenced outbox | **Keep its domain protocol.** A generic queue may dispatch eligible work but cannot replace the whole state machine. | Consent/source revocation, deletion capability, sealed bytes, lease/generation checks, ambiguous-call reconciliation. |
| RFC822/MIME construction, `prepared-dispatch.ts` | [Nodemailer MailComposer](https://nodemailer.com/extras/mailcomposer/) | **Conditional**, useful for internationalized headers/attachments. Current simple templates may not justify migration yet. Use compilation rather than a second delivery path. | Compile once, persist/hash exact raw bytes, stable Message-ID/correlation headers; no send-time regeneration. |
| Gmail OAuth refresh/auth protocol | [google-auth-library](https://github.com/googleapis/google-auth-library-nodejs) | **Conditional** for protocol maintenance. Gmail sending stays inside guarded dispatch. | Narrow scopes, safe key handling, frozen send body, no automatic ambiguous-send retry. |
| Rich email template authoring | [React Email](https://react.email/) | **Optional** if template complexity warrants it; no reason to replace short stable templates now. | Generic privacy-safe content, template versions, deterministic materialized delivery bytes. |
| Incoming MIME parsing | [mailparser](https://nodemailer.com/extras/mailparser/) | **Defer** unless raw MIME reconciliation becomes required. Existing structured Gmail header inspection does not justify it alone. | Bounded parsing and no retention of arbitrary mail bodies. |
| Active encrypted off-site backup repository | [Restic](https://restic.net/) | **Already adopted. Keep and finish operational assurance**, including real restore tests. Do not build another custom archive repository. | DB/object consistency, object manifests, vault-key escrow, restore authority safety, retention/deletion policy. |
| Lower-RPO PostgreSQL recovery | [pgBackRest](https://pgbackrest.org/) | **Future conditional option** if daily dumps cannot meet RPO; not an automatic replacement for the current small pilot. | WAL lifecycle and restore validation; uploaded files still require coordinated recovery. |
| Multipart upload framing | Busboy | **Already reused; keep.** | Body/file caps, filename/path policy, authorization, quotas, quarantine and durable publish. |
| File signature maintenance | [file-type](https://github.com/sindresorhus/file-type) | **Optional** helper for MIME/signature classification; not malware protection or proof a document is safe. | Existing allowlist, ClamAV/quarantine and object ownership checks. |
| Durable object filesystem publishing | Existing fsync/no-replace/pinned-directory implementation | **Keep the durability/security layer.** fs-extra or a convenience uploader is not equivalent. | No symlink escape, durable directory sync, receipt/tombstone ordering, safe physical erasure. |
| Future S3-compatible object backend | [AWS SDK S3](https://github.com/aws/aws-sdk-js-v3) | **Conditional architecture migration**, only if scale/operations demand it. | Object receipts, checksums, consistency, erasure and backup contracts must be redesigned and validated. |
| Timezone/calendar arithmetic | [Luxon](https://moment.github.io/luxon/) or [Temporal polyfill](https://github.com/js-temporal/temporal-polyfill) | **Good shared utility; choose one.** date-fns is a lighter alternative where its timezone approach fits. | Learner-local quiet hours/reward periods; UTC/monotonic exam deadlines; DST and timezone changes. |
| Canonical evidence serialization | [json-canonicalize](https://github.com/snowyu/json-canonicalize.ts) | **Conditional new protocol version**, never rewrite existing evidence hashes casually. | Explicit JSON domain, deterministic encoding, compatibility with historical receipts/signatures. |
| Curriculum search scoring | [MiniSearch](https://lucaong.github.io/minisearch/) | **Good replacement if better tokenization/prefix ranking is needed.** Fuse.js is an alternative for fuzzy substring search; choose from relevance fixtures. | Published-content filtering, stable IDs, deterministic relevance and bounded bundle/index size. |
| Code highlighting | [Refractor](https://github.com/wooorm/refractor) or [Shiki](https://shiki.style/) | **Replace regex highlighting when language fidelity matters.** Refractor suits a limited client grammar set; server-side Shiki can avoid a large client bundle. | Escape code, no raw HTML injection, CSP, language allowlist and bundle budget. |
| Markdown rendering | react-markdown + remark-gfm | **Already appropriate; keep.** | Continue excluding raw HTML and unsafe links; do not add rehype-raw as a cosmetic shortcut. |
| Learning scheduling/mastery | Existing domain policy; [ts-fsrs](https://github.com/open-spaced-repetition/ts-fsrs) only for a deliberate scheduling experiment | **Keep current learning semantics.** An FSRS adoption is a product/research change, not a utility refactor. | Calibration, policy versioning, historical evidence, regrade/recommendation rules and learner outcomes. |
| Database/query/migrations | Drizzle + pg | **Already appropriate; keep.** Optional [pg-query-stream](https://github.com/brianc/node-postgres/tree/master/packages/pg-query-stream) for a bounded cursor/export adapter. | Transactions, owner predicates, immutable constraints, custom role grants and explicit migration ledger. |
| Authentication / breached-password / MFA primitives | Better Auth and its reviewed plugins | **Already reused; keep.** Avoid a second auth framework or home-grown password hashing/token parser. | Invitations, one-device policy, status re-read, MFA completion, takeover, audits and revocation. |
| API rate limiting | rate-limiter-flexible with Postgres adapter | **Already adopted. Keep the policy wrapper.** | HMAC identities, fail-closed sensitive endpoints, per-policy budgets, trusted ingress identity and global caps. |
| Runner HTTP router/validation | [Fastify](https://fastify.dev/) | **Conditional** if manual HTTP lifecycle becomes a maintenance burden; not necessary merely to add a framework. | Exact bytes for HMAC, request-size/deadline caps, nonce/idempotency handling and stable response schemas. |
| Runner DTO validation | Ajv already in runner; Zod already in app | **Reuse existing validators**, share a versioned schema rather than handwritten divergent response checks. | Exact allowed statuses, request/test binding, provenance, totals consistency and hidden-field projections. |
| Logging/telemetry | [Pino](https://getpino.io/), [OpenTelemetry](https://opentelemetry.io/docs/languages/js/) | **Conditional** for standard structured signals. Existing Sentry SDK remains suitable after F5. | Server-side privacy filtering, safe attributes, cardinality caps and operation/trace rather than secret-bearing identifiers. |
| Property and HTTP fixture testing | [fast-check](https://fast-check.dev/), [MSW](https://mswjs.io/) | **High-value targeted additions** at state-machine/network boundaries. | Real DB tests remain; properties express invariants rather than duplicating implementation. |
| Disposable integration lifecycle | [Testcontainers](https://testcontainers.com/guides/getting-started-with-testcontainers-for-nodejs/) | **Conditional** for simpler harness pieces; current safety/role setup is specialized. | Never touch pre-existing containers/data; pinned images; scoped cleanup; real least-privilege tests. |
| Static security analysis | [Semgrep](https://semgrep.dev/) and existing Gitleaks; CodeQL where licensing permits | **Useful complementary checks.** Run repository analysis without executing learner hooks/code in the trusted app. | Bounded isolated analysis, analyzer/rule versions, safe findings, false-positive handling and correction history. |
| Load/browser/accessibility tests | Existing k6, Playwright, Testing Library, Axe | **Already suitable; use the current tools more deeply.** | Authenticated critical journeys, real runner parity, keyboard/dialog states, load budgets and safe test-host controls. |

Most registry candidates above advertise MIT, Apache-2.0 or ISC licenses; retained audit dependencies also include BSD-3-Clause. The project is AGPL-3.0-only. Preserve copyright/notices and inspect the exact adopted version's complete license/transitive requirements. External services such as R2 are not open-source libraries; swapping an SDK does not change the service's licensing or data-processing terms. Library metadata alone is not a legal review.

## Coverage by subsystem

| Aspect | Reviewed boundaries / strengths | Required follow-up or practical limit |
| --- | --- | --- |
| Architecture and maintainability | Modular monolith fits a small invited cohort; deterministic domain separation; explicit authority and provenance; documented exceptions. | Fix F10; extract giant orchestration modules by contract; avoid an unsolicited microservices/Kubernetes rewrite. |
| Auth, sessions, MFA, recovery | Better Auth adapter/plugins, database-backed sessions, restricted admin policy, one-device/takeover logic, recent-MFA policy, breached-password hook, safe authorization helpers. | Align authorized 24h/session-long policy documentation; authenticated concurrent-login/recovery browser coverage remains needed. No login bypass is claimed here. |
| Authorization and API surface | Registered endpoint/auth tests, object-owner predicates in sampled transaction paths, privileged reason/MFA/audit ceremonies, closed-book capabilities. | Extend negative cross-owner/deleted-user/stale-session cases to important routes; bounded JSON before parsing; full live route matrix not executed. |
| Credentials and cryptography | Node crypto AES-256-GCM envelope encryption, per-record keys, context binding, masked projections and controlled reveal; source comments acknowledge JS string erasure limits. | Test rotation/rewrapping/escrow on recovery; keep standard crypto, do not add a crypto library without a concrete gap. Secret values were not inspected. |
| AI and external HTTP | Policy-driven providers, conservative reservations, consent and fallback grants, durable request replay, safe errors, pinned custom-provider DNS/TLS transport. | Protocol SDK scope only; no blind retries; response caps; genuine provider contract/cost tests were not run. Prompt and learning-quality review remains distinct from transport correctness. |
| Exams and practice | Server-owned forms/tests/scoring, durable answers/outbox, runner evidence binding, explicit integrity/correction/regrade handling. | Fix Piston parity; test offline/reload/session-loss journeys with real images; a custom domain service remains necessary. |
| Runner isolation and runtime | HMAC request/response handling, limits, queue/journal, Docker lifecycle, pinned runtime provenance; deployment separates hostile execution from trusted app/KVM. | F1; actual VM/runtime isolation not exercised. Retain no-network, capability/resource controls and versioned templates. A JavaScript VM or process library is not a sandbox. |
| Browser durability | IDB transaction-completion semantics, owner namespace clearing, tombstones, emergency events and revision-aware replay. | idb/XState can simplify mechanics; retain authority/commit invariants. Browser storage can still be evicted and is not a backup. |
| Database and migrations | Drizzle schema, parameterized pg queries in sampled services, owner locks/receipts, immutable projection rules and dedicated least-privilege tests. | F9 real-DB PR selection; query-plan/load evidence; production migration/role grants must be exercised separately. No SQL injection demonstrated. |
| Learning, curriculum, corrections | Structured authored content, DAG/schema gates, explicit lesson-completion authority, mastery/evidence policy and versioned correction workflows. | Human pedagogy review and live executable parity; keep business rules. F12 review-score fairness and analyzer versioning. |
| Notifications and background work | Extensive fenced outbox/source authority, sealed payloads, watchdogs, revocation/erasure handling and ambiguity reconciliation; real DB mail races passed. | Preserve external-effect uncertainty; no queue can promise exactly-once email by itself. Simplify generic scheduling separately from guarded delivery. |
| Files, uploads and malware checks | Busboy caps, quota receipts, owner-derived paths, quarantine/ClamAV, pinned-directory durable publish and physical-erasure jobs. | Stream large uploads if measured memory pressure justifies it; caps already exist. F3/F4 recovery consistency; live scanner/backend tests remain needed. |
| Privacy, lifecycle and exports | Explicit consent history/live joins, optional projection withdrawal, safe-field exports, staged deletion and durable file-erasure completion. | F5 outbound monitoring sanitization; export demand/snapshot contract; retention and recovery of deleted data must be considered together. |
| Social, portfolio, certificates, rewards, battles/career | Consent/status-filtered social projections, owner-scoped changes, row versions, append-only evidence, reward reconciliation, revocable publication/certificates. | Maintain latest-consent reads and correction/withdrawal propagation; no demonstrated cross-user disclosure from sampled paths. These domain rules are not generic CRUD replacements. |
| UI, forms, accessibility, editor | React/Next, Monaco, safe Markdown, loading/error states, structural tests and landing Axe baseline. | F7/F8; admin/offline/error/keyboard/screen-reader journeys; conditional form/query/highlighting tools; landing-only scans are insufficient. |
| Performance and capacity | Small-cohort scope, admission/output/upload/export caps, load-test tooling and bounded projection machinery. | Whole GitHub deadline/concurrency, dashboard history, export backpressure, DB contention and concurrent upload peak memory. No full production-capacity result claimed. |
| Observability | SDK initialization defaults, attempted event allowlists, bounded tunnel and safe dashboard error classes. | F5; operational signals for ambiguous delivery, erasure and recovery; validate final outbound bytes. |
| Backup, release and host operations | Active Restic/R2 encrypted repository, pinned images, systemd timers/freshness alerts, historical isolated recovery tooling, Docker hardening/release evidence controls. | F3/F4; actual active recovery gate. Update old runbooks while keeping historical evidence. No real host/R2/release-image recovery was performed. |
| CI, dependencies and supply chain | Pinned action SHAs, lock installs, sharded tests, online audit, secret/encoding scans, architecture/content/evidence gates, image scan/provenance tooling. | F2/F9/F10/F11; current exact-image evidence, clear build-time audit policy, real active backup tests and effective gate selection. |

## Recommended order of work

1. **Correctness and recovery first:** contain stdin EPIPE; resolve the current lock advisories under the release policy; make active backup scope fail closed and add a genuine restore drill; fix monitoring outbound sanitization and Piston grading. These should be focused changes with defect-specific evidence.
2. **Close interaction and gate gaps:** fix prompt cancellation, replace all modal primitives, repair Git archive detection, broaden database CI selection, and replace the raw import checker with resolved dependency rules. Fix repository-level review deductions and version/reconcile affected evidence.
3. **Reduce maintenance work incrementally:** introduce idb behind the existing repository interface; select provider SDK adapters with retries disabled; standardize calendar helpers; bound GitHub work; extract large browser/service responsibilities. Keep one library per problem and measure bundle/runtime effects.
4. **Only then reconsider larger infrastructure:** a generic Postgres job tool, object backend migration, WAL backups or a new learning scheduler need a separately justified operational/product objective. They are not prerequisites for fixing the defects above.

For every migration, preserve old durable records/hash formats where required, define the specific behavior being delegated, add the invariants the library does not supply, and prove rollback. The goal is less generic infrastructure code with equally strong or stronger application guarantees.
