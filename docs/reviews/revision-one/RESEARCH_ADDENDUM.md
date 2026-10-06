> Historical review of baseline `7a0dda402f0a3486c85de75f2c5fe5bbd8654479`, captured 2026-10-06. Read Revision Two for subsequent fixes and validation. Local evidence paths inside the archive document the original execution environment.

# Codestead: deeper review, confirmations and new findings

Reviewed 2026-10-06, unchanged commit `7a0dda402f0a3486c85de75f2c5fe5bbd8654479`. This supplements the [original full review](CODE_REVIEW.md). The audit counts and qualifications below supersede the earlier snapshot where they differ. Application source, dependency declarations and lockfiles remain unchanged.

The strongest new application finding is an old consent-withdrawal replay that changes newly republished badge/project visibility. It was reproduced using the actual helper against disposable PostgreSQL. Further findings concern expensive credential redaction, Piston's requested wall-time contract, and a disagreement between the mandatory backup disclosure and the active retention command. Piston's output defect is now demonstrated at the normal deployment limit. The dependency re-check adds a newly published sharp advisory; source-map-js remediation was independently compared with the installed version.

The research adds 15 candidate-library metadata records to the original 46, retrieves 40 successful upstream source/documentation/test/advisory snapshots, and records nine unsuccessful source requests. These are distinct evidence sources, not claims that every package has been integrated or that upstream test suites were run. Seven focused library probes, one dependency-cruiser fixture, and a separate source-map version comparison were executed in an isolated lab. Full browser/provider/runtime-image/R2 recovery testing remains outside the demonstrated evidence.

## New review comments

### N1 — P2: a replayed consent withdrawal modifies later publication state

**Confirmed in real PostgreSQL with the actual application helper.** [profile-service.ts:281](../../../src/lib/social/profile-service.ts), [consent route:118](../../../src/app/api/privacy/consents/route.ts), [post-transaction cleanup:142](../../../src/app/api/privacy/consents/route.ts).

`withdrawCohortProfileForConsent` looks up its prior receipt, but updates every achievement and project to `private` before checking that receipt. Only the profile update, event and notification are guarded by `!prior.rows[0]`. The consent route uses `onConflictDoNothing`, then invokes this cleanup for withdrawal requests even when no new consent record was inserted.

The problematic sequence is:

1. Withdrawal R1 hides the cohort profile and selected records, recording an event.
2. The learner accepts a later consent and republishes, making selected badges/projects visible to the cohort.
3. An old R1 request is retried.
4. The helper returns `replayed: true` and leaves the profile published, but hides all badges/projects again.

The reproduction calls the actual helper before and after SQL simulating the subsequent successful publication. It asserts the receipt replay, published profile and changed child-record visibility. The fixture uses five minimal tables on PostgreSQL 17; it does not run production migrations/role grants or the full authenticated route. Route invocation of the helper on replay is source-confirmed. This is an own-account correctness defect; no cross-account or anonymous exploit is claimed.

**Fix:** make a prior receipt return before any visibility mutation. Also bind cleanup to the withdrawal's consent generation/current authority: a first cleanup delayed until after a later grant must not undo that newer publication. Merely guarding the two updates with `!prior` does not close the delayed-first-execution race. Perform the consent/projection transition under one consistent authority boundary, or dispatch a durable, generation-bound cleanup command. Keep the domain rules; a generic idempotency package cannot infer which publication an old withdrawal may affect.

**Acceptance:** old withdrawal replay after re-consent/republication changes no current state; a current withdrawal still hides all intended projections; delayed first cleanup, concurrent publication, account deletion and duplicate requests preserve authority and append-only history.

Evidence: [test source](research/evidence/round2-db.test.ts), [database result](research/db-probe-results.json), [disposable harness](research/run-disposable-db-probe.py).

### N2 — P2: credential redaction has expensive near-match behavior before output truncation

**Measured in isolated processes.** [credential label expression:92](../../../src/lib/security/credential-patterns.ts), [redactSensitiveText:57](../../../src/lib/security/sensitive-text.ts).

The label expression allows arbitrarily many word/separator prefixes before a credential keyword. On ordinary repeated words that never complete the credential label, the global search repeatedly explores those prefixes. `redactSensitiveText(value, 4000)` processes the entire input before applying its 4,000-character output cap. The cap therefore does not bound redaction work.

For the synthetic input consisting of repeated `a `, the measured helper times on Node 24.19.0 were:

| Input characters | Redaction time | Returned characters |
| ---: | ---: | ---: |
| 2,000 | 6.1 ms | 2,000 |
| 4,000 | 22.7 ms | 4,000 |
| 8,000 | 84.9 ms | 4,000 |
| 16,000 | 351.7 ms | 4,000 |
| 32,000 | 1,477.9 ms | 4,000 |
| 65,536 | 5,847.2 ms | 4,000 |
| 131,072 | Did not finish within an eight-second subprocess deadline | Not obtained |

These measurements support approximately quadratic growth for this input family, rather than a fixed worst-case timing guarantee. A synchronous helper blocks its Node event loop while running.

**Reachability qualification:** the tutor route bounds a message to 8,000 characters at [route.ts:69](../../../src/app/api/ai/tutor/route.ts). The administrator source-code reader uses SQL `left(...,16001)` before redaction at [evidence-reader.ts:226](../../../src/lib/admin-mentor/evidence-reader.ts); exam-answer SQL also prebounds code at [line 342](../../../src/lib/admin-mentor/evidence-reader.ts). Those paths do not establish the 131,072-character single-string case. Repeated bounded rows can still accumulate work, and shared structured-evidence projections need their input budgets audited. The structured projection already limits depth, arrays and object entries; an output-byte cap applied later cannot independently cap string-processing cost. No end-to-end public-route outage was reproduced.

**Fix:** redesign label scanning to have bounded work, using a linear scanner or a tightly bounded prefix rather than the unlimited repeated-word prefix. Define and enforce input/work budgets before expensive processing. If clipping before redaction, handle secrets crossing the cut safely; rejecting or dropping an oversized value is safer than emitting a partially inspected secret. An asynchronous timeout around synchronous regex execution cannot interrupt it.

RE2 can help only after the expressions are rewritten: the existing assignment regex uses negative lookbehind, which RE2 rejects. The isolated RE2-WASM probe verifies that incompatibility. Native `re2@1.27.0` also brings native installation and a narrower Node support range. `re2-wasm@1.0.2` was last published in 2021; successful execution here is not evidence of current maintenance.

**Acceptance:** adversarial near-matches across every intended maximum, many records per request and credential-boundary cases show bounded processing, retained secret exclusion and acceptable latency on the actual production Node image.

Evidence: [benchmark measurements](research/redaction-benchmark.json), [benchmark source](research/evidence/redaction-benchmark.ts).

### N3 — P2: Piston applies the requested wall budget to each execution rather than the whole job

**Source-confirmed and demonstrated with a controlled clock/mock transport.** [Piston deadline:229](../../../src/lib/runner/piston-client.ts), [call limits:244](../../../src/lib/runner/piston-client.ts), [legacy job deadline:126](../../../services/runner/src/docker-executor.ts), [remaining legacy budget:360](../../../services/runner/src/docker-executor.ts).

The legacy executor creates a deadline from `startedAt + job.limits.wallTimeMs` and passes remaining time to subsequent stages. Piston instead creates a whole-operation deadline using the client's transport timeout, normally 15 seconds. It gives each checker/test call the full requested `run_timeout`, capped at 3,000 ms, and separately gives each compilation 10,000 ms. Multiple tests therefore do not consume one shared requested wall budget.

The probe requests a ten-millisecond job limit and supplies three four-millisecond successful stages: one checker and two tests. All calls receive the full ten-millisecond run limit, and the adapter accepts after twelve milliseconds of simulated work. This proves adapter behavior and backend-contract divergence, not a measured live Piston runtime. For compiled languages Piston recompiles on test calls, which also needs explicit accounting.

**Existing protections verified:** Piston does have a whole-operation transport deadline. A negative-control probe advances beyond 15 seconds and the next call fails with `PISTON_TIMEOUT`. Deployment also caps compile memory at 512 MiB and run memory at 256 MiB at [compose.yaml:1091](../../../compose.yaml). Claims of unlimited operation time or unbounded compile memory would be incorrect.

**Fix:** explicitly decide whether `wallTimeMs` denotes a job-wide or per-stage budget. To preserve the legacy contract, share one requested deadline across compile and tests, clamp stage limits to remaining work, and keep the separate network/transport deadline. Version and disclose an intentional contract change; do not silently reinterpret persisted assessment requests.

**Acceptance:** real backend parity for multiple tests, slow compilation, checkers, transport overhead, requested limits smaller than deployment limits, timeout precedence and cancellation cleanup.

Evidence: [five Piston probes](research/evidence/round2-piston.test.ts), [results](research/piston-probe-results.json).

### N4 — P2 policy consistency: mandatory backup disclosures disagree with the active retention command

**Directly confirmed in source.** [onboarding-wizard.tsx:640](../../../src/components/onboarding/onboarding-wizard.tsx), [disclosure definition:65](../../../src/lib/privacy/consent.ts), [active retention command:70](../../../scripts/backup/restic-backup.sh), [active runbook:10](../../../docs/runbooks/backups-r2.md).

Both the mandatory onboarding text and `ENROLLMENT_DISCLOSURES` specify **7 daily / 4 weekly / 12 monthly** backup retention. The active Restic command and runbook specify **7 daily / 4 weekly / 6 monthly**. This is an observable disagreement between the acknowledged policy and configured recovery retention.

Restic's calendar buckets and overlapping retention rules do not mean every snapshot disappears at an exact six- or twelve-month instant. This finding concerns inconsistent declared/configured policy. It does not prove a legal violation, a lost backup, or that retaining more personal data is the correct remedy.

**Fix:** choose the intended policy using the existing owner/product decision process, align the implementation and all current disclosure surfaces, and version the disclosure when its meaning changes. Generate or validate these values from one policy definition. Preserve historical acknowledgment records. Do not automatically increase retention merely to match old text.

**Acceptance:** current user text, policy version, operational command, restore expectations and account-deletion explanation all describe the same chosen schedule; a drift check catches future disagreements.

## Stronger confirmation of F6 at deployment defaults

The original 16-byte grading probes remain reproduced, but the new cases remove reliance on that unusually small cap. The pinned Piston commit in [image-inputs.lock.json:7](../../../infra/piston/image-inputs.lock.json) is `de2b365ac759670a3a0d13ea208a0869a92c7e64`. Its upstream [job implementation](https://github.com/engineer-man/piston/blob/de2b365ac759670a3a0d13ea208a0869a92c7e64/api/src/job.js) checks stdout and stderr separately. The deployment sets each stream maximum to 65,536 at [compose.yaml:1094](../../../compose.yaml).

Three additional mock-transport cases pass by asserting defective adapter behavior:

| Input within upstream per-stream bounds | Adapter result | Contract problem |
| --- | --- | --- |
| Hidden test: stdout `ok`, stderr 65,536 bytes; expected `ok` | `PASSED`, job `ACCEPTED` | Combined output is 65,538 bytes; hidden stderr never consumes the application budget. |
| Same streams for a visible test | `PASSED`, job `ACCEPTED`, displayed stderr has truncation marker | Stderr consumes/truncates budget only after test status is computed; exhaustion does not change that status. |
| Two tests, each stdout 40,000 bytes matching its expected output | Two passes, job `ACCEPTED` | 80,000 bytes exceed the default job budget because each test creates a fresh budget. |

The expected outputs in the two-test fixture are 40,000-byte synthetic strings. This demonstrates adapter semantics, not the contents of a published exam. All three cases are below the adapter's 2 MiB response cap. Live runtime images were not exercised. Backend parity and the separation of grading output from display output remain the recommended fix.

## Updated dependency findings and independent checks

The unchanged root lock now reports **seven high affected package entries across three advisory roots**. The production-omit report now has **two high affected entries**, sharp and source-map-js. The earlier 21/eight counts are historical registry snapshots; advisory propagation changed, and a third root was published during this review. Package-entry counts are not independent vulnerability counts.

| Package in the reviewed tree | Published advisory and current disposition | Independent evidence / exposure limit |
| --- | --- | --- |
| `source-map-js@1.2.1` | [GHSA-68fv-2mgg-jv7q](https://github.com/advisories/GHSA-68fv-2mgg-jv7q), CVE-2026-93749; fixed in `1.2.2` | A tiny indexed map with a very large line offset caused installed `1.2.1` to exhaust a disposable Node process's 128 MiB heap. Lab `1.2.2` rejected the same offset in about 0.2 ms. No application endpoint accepting attacker-controlled indexed maps was demonstrated. |
| `braces@3.0.3` | [GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm), CVE-2026-93687; no patched version in the retrieved affected-range record | Advisory source and affected version verified. Initial balanced single-literal nested patterns up to 9,999 characters did not independently reproduce stack failure on this Node 24 runtime; 10,001 characters were rejected by its existing length guard. These particular cases do not disprove the advisory or validate all pattern shapes. No application exploit established. |
| `sharp@0.35.4`, via Next `16.3.6` | Newly published [GHSA-wq5f-xc86-pv6w](https://github.com/advisories/GHSA-wq5f-xc86-pv6w); patched `0.35.5` is available | Published record describes a librsvg memory vulnerability and possible RCE under specific glibc/Linux/runtime conditions. No decoding exploit was attempted. The current Next Image use is a generated QR with `unoptimized`; uploads exclude SVG. No malicious SVG decoding path was demonstrated. |

For sharp, the published remediation is `sharp@0.35.5`, providing librsvg 2.63.2; globally installed librsvg must also be considered where used. Verify compatible Next dependency resolution and the exact rebuilt platform binaries rather than adding an unrelated image framework. The upstream SVG-blocking workaround requires control of the actual decoder instance; a random app-level import does not prove Next's optimizer is protected. The deployed image's libc and runtime hardening were not independently inspected here.

The advisory records were retrieved directly from GitHub's reviewed advisory database. Direct GitHub advisory API requests were blocked, but the official raw database sources were accessible; all successful bodies are retained with hashes. This is now stronger than relying only on npm's titles. The source-map comparison runs inside a separately capped child process, not inside the application. A failed initial evidence-collection attempt was corrected before the final stored comparison; no application dependency was changed.

Evidence: [full audit](research/audit-recheck.json), [production audit](research/audit-production-recheck.json), [source-map comparison](research/source-map-probe-results.json), [published advisory source index](research/upstream/source-index.json).

## Confirmation matrix for all earlier findings

| Earlier finding | Current conclusion | Confidence and important qualification |
| --- | --- | --- |
| F1 stdin EPIPE | Helper crash confirmed; production-impact priority remains conditional | `/usr/bin/true` reproduction demonstrates an unhandled stdin stream error. A real Docker missing-image attempt with 131,072 input bytes returned exit 125 normally and did **not** crash. Do not call this a demonstrated learner-to-Docker denial of service. Practice stdin also has a smaller route bound. |
| F2 dependency gate | Confirmed, with updated counts and a new sharp root | Three official advisory records retrieved; source-map installed/patched behavior independently compared. Affected dependency is distinct from reachable exploitation. |
| F3 missing-upload backup assurance | Source-confirmed; conditional on file data being expected | The branch treats missing or symlink objects as DB-only scope. Existing hermetic tests permit absent uploads. No live R2 loss/restore was demonstrated. Restic cannot infer application-required object scope. |
| F4 DB/object backup consistency | Source-confirmed race window | DB dump precedes live file scan; no common object-erasure fence. Upstream backup documentation supports the filesystem-consistency concern. Not a reproduced production race. |
| F5 monitoring privacy | Both original probes reproduced again | Raw tunnel event data and utility fingerprint strings retain synthetic canaries. External forwarding must be configured; no other user's credentials were accessed. |
| F6 Piston grading/output budgets | Original two probes plus three default-budget cases reproduced | Upstream per-stream contract checked at the pinned commit. Live containers/published exam exploit not tested. Existing transport deadline and memory caps are acknowledged. |
| F7 prompt unmount | Both original probes reproduced again | Confirmation and global step-up promises remain unresolved across the tested unmount/registration sequence; missing cleanup corroborates the short observation interval. No MFA bypass claimed. |
| F8 modal focus | Original nested-parent probe reproduced again | Focus can remain outside the dialog's isolated parent. No new authenticated browser/screen-reader run performed; upstream replacement source inspected. |
| F9 PostgreSQL PR selection | Workflow defect remains source-confirmed | Representative persistence directories remain outside the selective filter. Unconditional unit/static tests still run; no bad merged PR demonstrated. |
| F10 architecture enforcement | Both equivalent-syntax bypasses reproduced again | Actual extracted rule functions accept relative paths/leading-comment client syntax. Dependency-cruiser resolves the relative-import fixture and reports its violation. No leaked production browser secret demonstrated. |
| F11 Git archive fallback | Prior environment failures and source remain valid | Six earlier failures/50-test workaround result reused at the same commit; no unnecessary full rerun. Different stderr from a mount boundary defeats the exact-message classifier. |
| F12 repository sample deductions | Original full-tree/sample-boundary probe reproduced again | README/tests present beyond the inspected sample still receive missing-file deductions. Mock upstream transport; actual reviewer function executed. |
| F13 GitHub review total work | Source-confirmed | Per-request timeout is distinct from a total review deadline. Authentication/ownership/rate limits remain. No 30-minute load experiment or live GitHub call made. |

Original probes: **9/9 rechecked**. New Piston probes: **5/5**, including one negative control proving the transport deadline. PostgreSQL replay probe: **1/1**. A passing defect probe means the described bad behavior occurred; it is not a fix or a general health check.

## Hypotheses rejected or narrowed in this pass

- **Disabling production authentication through `AUTH_REQUIRED=false`: rejected.** [runtime-policy.ts:9](../../../src/lib/security/runtime-policy.ts) forces authentication in production. Local demo behavior is separate.
- **Forging official exam grades solely through inconsistent result totals: not established.** [runner-replay-policy.ts:71](../../../src/app/api/exams/_lib/runner-replay-policy.ts) reconciles totals with actual test statuses. Tightening the shared DTO is still useful, but the existing exam authority check prevents the proposed simple totals inconsistency.
- **Unlimited Piston duration or compile memory: rejected.** Its independent operation deadline and Compose memory cap exist. N3 concerns a different requested-budget contract.
- **A simple failed Docker startup demonstrates F1 end to end: rejected by the new test.** The actual CLI returned normally. The helper error handler still needs repair.
- **The redaction output cap protects its processing cost: rejected by timing.** Conversely, attributing the 131,072-character timing directly to the prebounded administrator code reader would overstate that path.
- **Duplicate community reports necessarily poison a transaction: rejected on source inspection.** That helper is not executing the insert inside an explicit transaction, so the guessed failed-transaction recovery issue does not apply.
- **All publication helpers share N1's replay mutation: not established.** Cohort-profile updates, portfolio mutation/withdrawal and career-card mutations check prior receipts before their principal state changes in the inspected paths. N1 is specific to the consent-withdrawal cleanup and its authority timing.
- **RE2, Execa or a queue is a direct substitute for the whole current mechanism: rejected by library contracts/probes.** Their boundaries and missing application guarantees are detailed in the library research.

## Evidence-backed library decisions

The [new library research](NEW_LIBRARIES.md) gives concrete mappings, versions, maintenance signals, compatibility constraints and migration acceptance criteria. The highest-value existing candidates remain Execa, idb, a common Radix/React Aria dialog, and dependency-cruiser. New targeted candidates include Radix Alert Dialog/Dropdown Menu, Floating UI, Adobe's calendar package, p-limit, Zod-backed OpenAPI generation and pg instrumentation. Choose alternatives by the specific responsibility; adding all candidates is not the recommendation.

The isolated lab audit currently reports zero known vulnerabilities in that lab's lock. That says nothing about future advisories, application integration or a dependency's semantic correctness. Latest registry versions are research snapshots; exact versions and transitive licenses must be reviewed when a migration is actually proposed. Several packages were released very recently, so a latest-version lookup is not a substitute for adoption/version selection.

## Recommended work sequence

1. Repair consent replay/generation ownership; eliminate pathological redaction work; correct Piston grading and budget semantics. Add narrowly targeted regression evidence for each invariant.
2. Resolve the current dependency policy failures, verifying installed versus patched paths and rebuilding the actual release artifacts. Treat source-map, sharp and braces separately.
3. Make backup scope/recovery assurance explicit and align the chosen retention disclosure; test actual restored files and authority behavior in an isolated recovery drill.
4. Repair monitoring scrubbing and promise cleanup, then adopt one common modal/confirmation primitive. Expand database CI selection and resolved architecture enforcement.
5. Migrate generic mechanisms incrementally: subprocess lifecycle, IDB adapter, bounded GitHub protocol/concurrency, shared calendar utility. Keep consent, grading, delivery uncertainty, erasure and durable evidence rules under application control.

This review has broad source coverage and focused confirmations. It does not certify that every line or every deployment behavior is defect-free. All added evidence, exact reproduction instructions and primary-source snapshots are included in the research bundle; root source and lockfile status remains clean.
