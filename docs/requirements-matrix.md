# Requirements Matrix

**Status:** Authoritative requirements ledger\
**Last updated:** 2026-07-12\
**Scope:** Product, curriculum platform, adaptive learning, AI, execution, projects, administration, privacy, security, operations, and quality

## 1. How to use this matrix

- **Priority:** `M` must, `S` should, `C` could.
- **State:** `Approved` reflects an explicit product decision; `Baseline` is the secure/product default adopted by these documents; `Open` requires owner confirmation before the named release gate.
- **Phase:** `FND` foundation, `CB` Core Beta, `VER` Core Verified, `ADV` Advanced Beta, `EXT` extensions.
- A requirement is complete only when its acceptance statement passes and the named evidence is attached to the release record. “Implemented” without evidence is not accepted.
- IDs are stable. If a requirement is retired, keep the row and mark it retired; do not reuse the ID.

## 2. Access, authentication, and authorization

| ID | P | Requirement | Acceptance criteria | Acceptance evidence | Phase / state |
|---|---|---|---|---|---|
| AUTH-001 | M | Access is request/approval gated; public self-registration is disabled. | Verified email can request once; admin can approve/reject; unapproved Google/password attempts cannot provision an account. | E2E pending/approve/reject/bypass suite; audit event. | FND / Approved |
| AUTH-002 | M | Approval uses a single-use expiring enrollment link; no generated password is emailed. | Token is random, stored hashed, expires within 24 h, is consumed atomically, and lets user choose Google or set a password. | Link expiry/replay/race tests; email snapshot proving no password. | FND / Baseline |
| AUTH-003 | M | Support Google and email/password through Better Auth with the Drizzle/PostgreSQL adapter inside Next.js. | Fixed base URL/exact callbacks/trusted origins; approved-enrollment hook blocks open/implicit signup; verified-email explicit linking; email verification; password reset revokes sessions; reviewed generated schema/migrations; no password visible to app/admin. | Google/local/link/reset/bypass E2E; Better Auth configuration and Drizzle migration review. | FND / Approved |
| AUTH-004 | M | Require TOTP MFA for learners and admins, including Google sign-in. | Enrollment verifies TOTP and recovery codes; custom Better Auth hooks gate OAuth/social sessions because its 2FA plugin does not do so by default; email OTP is not the independent factor; optional passkey remains a first factor unless separately approved. | Password/Google MFA-bypass E2E, recovery tests and lost-factor tabletop. | FND / Baseline preserving approved MFA |
| AUTH-005 | M | Enforce one active database-backed Better Auth browser-device session per account, remembered up to 30 days. | Multiple same-profile tabs work; an active device blocks a new browser family; normal logout or fresh-MFA/reasoned admin revocation releases it; expired/revoked families are archived token-free; the newly admitted device sends a notice; stateless-only sessions and separate `trustDevice` MFA bypass are disabled. | Concurrent-login, active-block, expiry/archive, logout, admin-revoke, new-device and post-revocation-TOTP tests. | FND / Approved |
| AUTH-006 | M | Learners can inspect/logout their current family and request help; admins can revoke sessions; sensitive actions require recent MFA. | Learner sees current/recent history and can logout; an authenticated lost-device request enters admin review; admin revoke/approve/reject requires fresh MFA, reason and audit; key/GitHub/security/export/delete actions reject stale MFA. | Ownership/revocation/request/recent-auth API and E2E matrix. | FND / Approved |
| AUTH-007 | M | Roles are learner and admin with deny-by-default object authorization. | Learner cannot read/write another learner's private resources; admin-only commands reject learner; every endpoint has an authorization test. | Cross-user/role test matrix and RLS tests. | FND / Approved |
| AUTH-008 | M | Admin learner view is read-only mentor view by default; no implicit impersonation. | Clicking profile never mints learner session or spends learner credentials; any future view-as is explicit, MFA-confirmed, reasoned, time-limited, bannered, and audited. | Mentor-view/view-as negative E2E; audit review. | FND / Baseline |
| AUTH-009 | M | Retain bounded login/logout/MFA/session security history. | User sees current/recent sessions; admin sees appropriate security events; no raw token/MFA secret; default raw retention 90 days. | Data inspection and retention-job report. | FND / Approved |

## 3. Onboarding and learner profile

| ID | P | Requirement | Acceptance criteria | Acceptance evidence | Phase / state |
|---|---|---|---|---|---|
| ONB-001 | M | Resumable onboarding captures minimum learning context. | Goal, timezone, availability, prior experience, preferred track/language, optional interests, and analogy preference save per step and resume. | New/beginner/advanced interrupted-flow E2E. | CB / Approved |
| ONB-002 | M | Collect an 18+ confirmation, not unnecessary DOB/legal identity. | Approval/enrollment cannot finish without confirmation; profile has no required DOB/legal-name field. | Schema/UI/privacy review. | FND / Baseline |
| ONB-003 | M | Disclose mentor visibility, external AI routing, server code execution, retention, and cohort opt-ins before learning. | Learner acknowledges versioned disclosure and can open details/settings; optional consent remains separately withdrawable. | Consent-version record and UX copy review. | CB / Baseline |
| ONB-004 | S | Interest analogies are optional and private by default. | Learner can select/edit/disable interests and choose analogy frequency; disabling stops interest context in future prompts. | Preference/context-assembly tests. | CB / Approved |

## 4. Curriculum and catalog

| ID | P | Requirement | Acceptance criteria | Acceptance evidence | Phase / state |
|---|---|---|---|---|---|
| CUR-001 | M | Core Beta includes Programming Foundations and beginner-to-independent-intermediate C, C++, Java, and Python. | Published scope/outcomes/prerequisites exist for each; no required node is an empty placeholder. | Coverage manifest and curriculum audit. | CB / Approved |
| CUR-002 | M | Core Beta includes comprehensive shared DSA with implementation and assessment parity in C, C++, Java, and Python. | Every required DSA concept has equivalent exercises/tests/mastery evidence in all four languages. | Cross-language parity report; example/test run. | CB / Baseline from prior scope; final owner confirmation required |
| CUR-003 | M | Core Beta includes HTML, accessible structure, CSS/responsive design, JavaScript/DOM/modules/async, and React through an intermediate SPA. | Track covers JSX, components, props, state, events, lists, forms, core hooks, data fetching, routing, basic tests, and one SPA; Next.js/Redux are excluded unless separately scoped. | Web scope manifest, accessibility audit, built sample SPA. | CB / Baseline from prior scope; final owner confirmation required |
| CUR-004 | M | Curriculum is a versioned prerequisite graph with explicit outcomes and critical skills. | Publication validator rejects cycles, missing prerequisites/outcomes, unresolved required variants, and invalid references. | DAG/schema validator report. | CB / Baseline |
| CUR-005 | M | Every lesson/activity is source-linked and versioned. | Authoritative sources, content version, owner/reviewer, and change history are queryable; published records are immutable. | Content manifest and publication audit. | CB / Approved intent |
| CUR-006 | M | Every required lesson includes objective, prerequisites, literal explanation, examples, misconceptions, checks, practice, remediation, mastery criteria, and sources. | Coverage validator reports 100% required fields/blocks. | Lesson completeness report. | CB / Baseline |
| CUR-007 | M | Code examples and assessments use pinned supported runtime versions and compile/run before publish. | Every example/test passes the declared image/toolchain or is intentionally expected to fail with validated diagnostic. | CI content-execution artifact by language/image digest. | CB / Baseline |
| CUR-008 | M | “Verified” requires evidence, not elapsed time. | Source coverage, 100% required-skill coverage, DAG/mastery review, code/test execution, language parity, web accessibility, documented exclusions, and admin approval all pass. | Signed publication evidence bundle. | VER / Baseline |
| CUR-009 | M | Missing promised topics are defects; new/out-of-scope topics become gated extension briefs. | Request is triaged, sourced, implemented, tested, audited, approved, and version-published; no live AI-generated course enters active plans. | Request-to-publication workflow test/audit. | CB / Approved intent |
| CUR-010 | S | Advanced C/C++/Java/Python and optional advanced web ship as separate gated tracks. | Verified intermediate prerequisites or audited admin override required. | Gate/override E2E. | ADV / Baseline |
| CUR-011 | C | Qt, NumPy/Pandas, Spring/Spring Boot, and later domains appear only as admin-approved “Coming Soon.” | Empty lessons are not navigable; status and scope brief visible without false completion promise. | Catalog-state test. | EXT / Baseline |

## 5. Lesson and adaptive learning

| ID | P | Requirement | Acceptance criteria | Acceptance evidence | Phase / state |
|---|---|---|---|---|---|
| LES-001 | M | Use the loop explain → example → micro-check → guided practice → code/debug task → recap/next. | Every required concept follows the loop or has an approved documented exception. | Lesson structure coverage report; learner E2E. | CB / Approved |
| LES-002 | M | Literal technical explanation precedes optional analogy and reconnects analogy to exact semantics. | Analogy blocks are labelled, disableable, and never replace syntax/semantics/examples. | Content lint and human sample review. | CB / Approved |
| LES-003 | M | Provide progressive hints, alternate explanation, examples, “I don't know,” and content-report paths. | Hint ladder reveals progressively; solution reveal records remediation/non-mastery; no dead-end state. | UX/content E2E matrix. | CB / Approved |
| LES-004 | M | Show roadmap state and why each next action/lock exists. | Graph and accessible list show prerequisites, evidence status, due review, admin override, and recommendation reason. | Graph/list parity and reason tests. | CB / Approved |
| LES-005 | S | Games and visualizers run primarily in browser with accessible text/step equivalents. | Core interaction works without hover and with keyboard; visualizer never submits authoritative evidence directly. | A11y/manual report; tampered-client test. | CB / Approved |
| ADP-001 | M | Placement is evidence-based and adaptive; self-report does not prove mastery. | Beginner can start at beginning; diagnostic adapts and accepts “I don't know”; skipped concepts require sufficient evidence. | Golden placement scenarios. | CB / Approved |
| ADP-002 | M | Track mastery per concept, language context, confidence, critical criteria, misconceptions, and recency. | State is queryable/rebuildable from versioned evidence and never only a global beginner/intermediate label. | Event replay/property test. | CB / Approved |
| ADP-003 | M | Choose next activity deterministically from prerequisites, evidence, errors, review schedule, learner choice, and admin plan. | Same state/policy yields same recommendation/reason; model output cannot directly alter it. | Determinism/golden journey tests. | CB / Baseline |
| ADP-004 | M | Require conceptual and applied evidence for normal mastery and schedule spaced review. | Mastery policy defines evidence mix/critical criteria; due reviews surface and update after evidence. | Mastery/review policy tests. | CB / Approved intent |
| ADP-005 | M | Repeated misconceptions trigger targeted remediation and additional evidence. | Configured error pattern selects simpler explanation/example/practice; success advances; unresolved errors do not silently skip. | Misconception journey suite. | CB / Approved |
| ADP-006 | S | Admin plan edits are versioned, reasoned, reversible, and visible to learner. | Diff shows downstream prerequisite effects; old revision/evidence preserved; learner notified. | Plan diff/revision/notification E2E. | CB / Approved |

## 6. Assessment and exams

| ID | P | Requirement | Acceptance criteria | Acceptance evidence | Phase / state |
|---|---|---|---|---|---|
| ASM-001 | M | Support MCQ, trace/output, fill-gap, debugging, coding, project rubric, and short explanation. | Item schemas, author preview, save, grade, feedback, and accessibility work for every supported type. | Item-type contract/E2E suite. | CB / Approved |
| ASM-002 | M | Practice gives correctness, why, misconception feedback, hint/remediation, and retry/next action. | Deterministic result persists; feedback matches evidence; wrong attempts are not erased. | Golden item-feedback tests. | CB / Approved |
| ASM-003 | M | Deterministic graders/runners decide objective correctness; AI supplies bounded qualitative evidence only. | Removing/altering AI output cannot forge deterministic score/mastery; AI evidence is labelled/versioned. | Authority-boundary tests. | CB / Baseline |
| ASM-004 | M | Assessment variants/forms are versioned and equivalent against a blueprint. | Every form records blueprint/item versions, coverage, difficulty, critical clusters, and randomization seed. | Form-generation parity report. | CB / Baseline |
| ASM-005 | M | Infrastructure failures do not count as learner failures. | Runner/provider/server failure is separately classified; attempt can retry/resume without negative evidence. | Fault-injection tests. | CB / Baseline |
| EXM-001 | M | Exams use an immutable server-timed form with autosave and disclosed monitoring. | Preflight states duration, tools, thresholds, event list, disconnect and appeal policy; learner confirms before timer starts. | Exam preflight snapshot/E2E. | CB / Baseline |
| EXM-002 | M | Practice tutor/hints/docs/web/visualizer are disabled in exams; compile/run policy is explicit. | Forbidden endpoints reject exam context; hidden tests reveal no feedback before final submit. | Exam capability matrix. | CB / Baseline; compile/run details Open |
| EXM-003 | M | Server timer continues through disconnect; last server-confirmed save submits at expiry. | Clock manipulation fails; reconnect does not extend deadline; material infrastructure outage can yield equivalent re-exam by admin. | clock/offline/reconnect/expiry tests. | CB / Baseline; material threshold Open |
| EXM-004 | M | Default thresholds distinguish pass from mastery. | Below 80 or critical floor fails; 80–94 passes/unlocks without mastery; 95+ plus all critical criteria masters. Threshold policy is versioned. | Boundary/critical-criteria tests. | CB / Baseline; final owner confirmation required |
| EXM-005 | M | Compile failure affects the relevant program/item, not unrelated items; mandatory coding items must compile for mastery. | Scoring policy produces expected single-program and multi-item outcomes. | Scoring fixtures. | CB / Baseline |
| EXM-006 | M | Retakes use an equivalent new form after failed-cluster remediation and a versioned cooldown. | Same exact form not reused; eligibility enforced; prior evidence retained. | Retake E2E/parity evidence. | CB / Baseline; cooldown bands Open |
| EXM-007 | M | Integrity telemetry is limited and human reviewed. | Log only disclosed events; no camera/screen/raw keys/clipboard content; blur/paste never auto-fails; learner can respond/appeal. | Data/schema/decision-rule review. | CB / Baseline |
| EXM-008 | S | Provide a shorter mastery recheck for learners who pass at 80–94 after targeted practice. | Recheck covers unmet mastery criteria and cannot lower prior pass status absent misconduct/correction policy. | Recheck blueprint/journey test. | CB / Baseline; owner confirmation required |

## 7. Code execution

| ID | P | Requirement | Acceptance criteria | Acceptance evidence | Phase / state |
|---|---|---|---|---|---|
| RUN-001 | M | Authoritative C, C++, Java, and Python run in isolated server environments with published versions. | Submission records exact runtime image digest/compiler; results reproduce under retained/supported image. | Language parity/reproducibility suite. | FND/CB / Approved |
| RUN-002 | S | Browser quick-run may support visible practice only and is clearly non-authoritative. | UI labels preview; client-forged result cannot create attempts/evidence/mastery; server submit remains available. | Tampered-client/E2E. | CB / Approved; Python v1 scope Open |
| RUN-003 | M | Enforce per-job and global CPU, wall, memory, process, file, output, source, rate, and queue limits. | Fork bomb/loop/OOM/large output/archive/path fixtures are killed and host remains responsive. | Adversarial runner report. | FND / Baseline |
| RUN-004 | M | Run hostile jobs in a dedicated KVM VM, not trusted app Docker. | Job cannot reach host, DB, objects, home LAN, internet, metadata, secrets, or another job. | Network/secret/cross-job isolation suite. | FND / Baseline |
| RUN-005 | M | Hidden tests/harness/reference solutions remain server-only and absent from AI. | Browser/API/log/error/prompt inspection reveals no hidden data; learner-safe category feedback only. | Leakage snapshot/canary suite. | CB / Baseline |
| RUN-006 | M | Support explicit result states and durable asynchronous queue. | Queued/compile/run/accepted/wrong/runtime/timeout/memory/output/infra/cancel states render and survive navigation/restart. | State-machine/fault/restart E2E. | CB / Approved intent |
| RUN-007 | M | Use immutable submission/evidence for appeals and regrades. | Source hash, test/content/runtime version, outputs, limits and decision remain attributable; corrections append. | Appeal rerun and audit test. | CB / Approved |
| RUN-008 | S | Initial concurrency is one job per learner and two global, adjustable from measured capacity. | Load test keeps trusted API/DB within targets; queue applies backpressure. Official exam-final/correction work additionally admits at most one active job per learner atomically, with retry-safe busy/replay/release behavior that cannot turn capacity into learner failure. | Ten-user/two-run load artifact plus [`integration/runner-admission.integration.test.ts`](../integration/runner-admission.integration.test.ts). | FND / Baseline |

## 8. AI tutor, BYOK, routing, and memory

| ID | P | Requirement | Acceptance criteria | Acceptance evidence | Phase / state |
|---|---|---|---|---|---|
| AI-001 | M | Provide a provider-neutral gateway with NVIDIA NIM, OpenRouter, DeepSeek, Gemini, and OpenAI adapters as configured. | Product operations use one typed interface; provider-specific failures normalize; unsupported capability is rejected before call. | Provider contract tests. | CB / Approved; exact enabled models Open |
| AI-002 | M | NIM integration is mandatory, but production endpoint/license and routing semantics must be approved. | Production-authorized endpoint documented and health-tested; policy states first-choice/support-only/fail-closed behavior. | Contract/license decision and outage test. | FND release blocker / Open |
| AI-003 | M | Store multiple per-user BYOK credentials encrypted and masked by default. | AEAD ciphertext only in DB/backup; KEK separate; normal learner/admin views show last four/status only; add/test/replace/disable/delete require recent MFA; admin test/replace require owner/action-scoped UUID receipts with conflict-safe replay; full admin reveal requires fresh MFA, a non-empty reason, a dedicated non-idempotent no-store response, immutable audit, and immediate learner notification. | Dump/log/export/UI secret-canary tests plus reveal allow/deny/notification/audit E2E and provider-operation UUID replay/mismatch/concurrency tests. | FND / Approved |
| AI-004 | M | Route/fallback only through that learner's consented active keys or explicit capped admin fallback. | No cross-user key use; provider/data categories disclosed; provider used and cost attributed; authored fallback when none succeed. | Routing property/outage/budget tests. | CB / Approved intent |
| AI-005 | M | Tutor grounds answers in versioned curriculum and bounded learner context. | Context manifest identifies lesson, mastery/misconception, recent relevant messages/summaries, language/preferences; excludes email, secrets, hidden tests. | Captured-prompt privacy/provenance review. | CB / Approved |
| AI-006 | M | LLM cannot execute code, publish content, set mastery, finalize grades, or close appeals. | Direct model output cannot invoke those state transitions; tool/schema allowlist enforced. | Prompt-injection/authority tests. | CB / Baseline |
| AI-007 | M | Version prompts/models/context and gate changes through evals. | Each call records operation/provider/model/prompt/content/context policy; golden correctness/safety/leakage/style suite passes before change. | Eval run attached to release. | CB/VER / Baseline |
| AI-008 | M | Chat supports new/resume/archive and explicit context/provenance. | Threads persist; new thread uses structured memory/summaries without copying all raw messages; provider and answer source type visible. | Chat lifecycle/context E2E. | CB / Approved |
| AI-009 | M | AI unavailability or budget exhaustion does not block authored lessons or deterministic grading. | All providers disabled/outage still allows lesson, quiz, runner grade and saved progress; clear degraded state. | Chaos/fallback E2E. | CB / Baseline |
| AI-010 | M | Learner can flag incorrect/unsafe/too-advanced output and appeal official AI-supported claims. | Report preserves message, model/prompt/context/content versions and enters admin queue; model cannot adjudicate itself. | Report/appeal E2E. | CB / Approved |

## 9. Sessions, projects, social, and administration

| ID | P | Requirement | Acceptance criteria | Acceptance evidence | Phase / state |
|---|---|---|---|---|---|
| SES-001 | M | Model auth sessions, learning sessions, chat threads, and exams separately. | New/end/archive in one domain does not reset another; identifiers and lifecycle states are distinct. | Schema/state-machine tests. | FND/CB / Approved |
| SES-002 | M | Learning sessions can start, resume, end, and become inactive without losing plan/mastery. | Last server-confirmed activity/draft resumes; new focused session shares durable state; multi-tab conflicts are explicit. | Resume/restart/conflict E2E. | CB / Approved |
| SES-003 | M | “Complete learner context” is structured, source-linked, bounded, and deletable. | Mastery, misconceptions, goals, projects, summaries and recent messages have provenance/retention; raw history is not blindly prompted. | Context manifest/delete test. | CB / Baseline |
| SES-004 | S | Browser cache may preserve drafts/offline lessons but is never the only durable copy. | Cache can be cleared/evicted without losing server-synced work; revoked session reauthenticates before sync. | [`learner-drafts.integration.test.ts`](../integration/learner-drafts.integration.test.ts), [`code-lab-draft-sync.test.tsx`](../src/components/lesson/__tests__/code-lab-draft-sync.test.tsx), and SES-004/DAT-003 evidence. No installable PWA/service worker or cold offline launch is promised. | CB / Implemented locally; deployed browser proof Open |
| PRJ-001 | M | Learners can create/save projects under a durable quota. | Project revisions/files persist, quota updates atomically, and unsupported files are rejected. | Quota/upload/revision tests. | CB / Approved |
| PRJ-002 | M | Review public GitHub repository URLs at an immutable commit SHA. | Validate owner/repo/ref; record SHA; isolate checkout; findings link to exact revision. | Public-repo E2E/reproducibility. | CB / Approved |
| PRJ-003 | S | Private repositories use a read-only selected-repository GitHub App, never PATs. | Minimal permission manifest; uninstall/revoke; tokens encrypted/redacted. | GitHub permission/security review. | CB or later / Baseline; launch scope Open |
| PRJ-004 | M | Static analysis is default; arbitrary hooks/Actions/install/build commands do not auto-run. | Malicious repository cannot execute during default review; approved build templates are explicit and sandboxed/no-network. | Malicious-repo suite. | CB / Baseline |
| PRJ-005 | M | Project/GitHub/AI review findings are evidence-linked and appealable. | Finding records analyzer/model/prompt/commit/file-line versions; learner can dispute; correction appends. | Review/appeal E2E. | CB / Approved |
| SOC-001 | M | Cohort profiles are field-level opt-in with alias-only secure default. | Preview matches another learner's view; email, exact activity, failures, raw code/chat and provider data never public. | Visibility matrix tests. | CB / Approved |
| SOC-002 | S | Support badges, streaks, mastery, selected projects, and optional leaderboard. | Achievements derive from authoritative evidence; learner can hide/leave without losing private record. | Award/revoke/visibility tests. | CB / Approved |
| SOC-003 | S | Leaderboard avoids rewarding spam, speed, hours, submissions, or token spend. | Versioned formula uses capped mastery/review/project milestones; score explainable and abuse-tested. | Formula property/abuse report. | CB / Baseline; formula Open |
| ADM-001 | M | Admin sees actionable learner mastery, attempts, code, chats, projects, sessions, appeals, and quota for mentoring under disclosure. | Sensitive raw detail requires deliberate action/purpose and is audited; cohort views remain separate. | Admin authorization/read-audit tests. | CB / Approved visibility with Baseline safeguards |
| ADM-002 | M | Admin can version/edit learning plans and assign remediation. | Diff/reason/downstream impact shown; old revision retained; learner notified; no evidence rewrite. | Plan-edit E2E/audit. | CB / Approved |
| ADM-003 | M | Admin can draft/review/verify/publish/rollback versioned curriculum. | Publish gate cannot be bypassed; rollback changes catalog pointer, not history. | Publication authorization/workflow tests. | CB/VER / Approved intent |
| ADM-004 | M | Admin can review appeals and AI/content/project reports with immutable evidence. | Decision requires rationale; rerun/regrade versions explicit; learner notified; corrective evidence appended. | Appeal fixture suite. | CB / Approved |
| ADM-005 | M | Admin manages users/sessions/roles without seeing passwords, MFA secrets, or recovery codes; provider-key plaintext is available only through the explicitly approved controlled-reveal ceremony. | Ordinary endpoints/fields never contain plaintext secrets; provider reveal alone requires fresh MFA, reason, no-store response, audit and learner notification; all privileged changes require recent MFA and audit. | Admin API/UI/schema secret tests plus controlled-reveal E2E. | FND / Approved |
| ADM-006 | M | Admin monitors provider cost/health, runner/jobs, storage, email, backups, security, and content verification. | Unknown/failing states not green; alerts link to runbook/evidence. | Dashboard data/alert test. | FND/CB / Approved intent |
| ADM-007 | M | All privileged changes and sensitive reads are actor/subject/reason audited. | Audit contains actor, subject, action, resource, outcome, time, correlation, safe diff/hash; no secret. | Audit coverage/reconciliation report. | FND / Baseline |

## 10. Notifications, data lifecycle, and backup

| ID | P | Requirement | Acceptance criteria | Acceptance evidence | Phase / state |
|---|---|---|---|---|---|
| NOT-001 | M | Send a first learner inactivity reminder after exactly 24 hours and a final learner reminder after exactly 72 hours without meaningful learning activity. | Login alone does not reset; activity closes the episode; after the final reminder the system stays silent until meaningful activity and a future episode; IANA timezone/quiet hours respected. | Boundary/scheduler/idempotency/timezone/reactivation tests. | CB / Approved |
| NOT-002 | M | Send one separate generic admin-mentor notice with the first learner notice under a disclosed cohort policy. | Enrollment records policy acknowledgment; the admin gets at most one notice/episode; no score, mistakes, code, chat, provider detail, key, or raw hours; an admin can temporarily pause reminders with fresh MFA, reason and audit. | Template/privacy/disclosure/episode/pause tests. | CB / Approved |
| NOT-003 | M | Send security, appeal, credential and operational notifications separately. | New device, credential change, recovery, appeal status, backup failure use appropriate non-sensitive templates and dedupe. | Template/event mapping tests. | FND/CB / Baseline |
| NOT-004 | M | Use transactional email with SPF/DKIM/DMARC and durable outbox; never email backup archives. | Retry/bounce/suppression works; backups only send status/checksum; no archive/key attachment. | DNS/provider check; outbox fault tests; template scan. | FND / Baseline; provider Open |
| DAT-001 | M | Apply category-specific long retention, export, deletion and backup-expiry behavior. | Policy covers progress, raw chat/code, official evidence, AI metadata, security/exam events, audit, notifications, temp objects and backups. | Retention-policy version and job report. | FND / Approved long retention; exact durations partly Open |
| DAT-002 | M | Default durable learner quota is 2 GB, admin-adjustable to 3 GB. | Atomic reserve/finalize/release; UI breakdown; temp/build/shared curriculum excluded; uploads stop safely at limit. | Quota ledger/reconciliation/fill tests. | CB / Approved |
| DAT-003 | M | Browser storage is cache, not authoritative storage or backup. | Eviction/device change does not remove server-synced work; UI distinguishes local/remote; offline sync is idempotent. | Unit/API/component/real-PostgreSQL draft tests and [`docs/evidence/ses-004-dat-003-draft-sync-2026-07-12.json`](evidence/ses-004-dat-003-draft-sync-2026-07-12.json). | CB / Implemented locally; warm-session offline only |
| DAT-004 | M | Nightly encrypted local backup and weekly encrypted offsite copy retain 7 daily/4 weekly/12 monthly. | Database, identity/config, objects, content/evidence restore; backup key separate; integrity checked; quarterly clean restore. | Backup logs and signed restore report. | FND / Approved |
| DAT-005 | M | Full local backup target is at least 1 TB; 32 GB USB is not treated as complete backup. | Capacity report proves retention headroom; 32 GB optional emergency DB/config only; alerts at 70/85/95%. | Storage procurement/capacity/alert evidence. | FND / Baseline |
| DAT-006 | M | Google Drive offsite uses dedicated account, client-side encryption, adequate paid quota, and no bidirectional sync. | Upload is encrypted/checksummed; MFA/recovery configured; Drive quota alert; restore works without Google seeing plaintext. | Account/config review and offsite restore. | FND / Baseline; paid capacity/owner Open |
| DAT-007 | M | Appeals and official decisions retain immutable reproducibility evidence. | Exact content/question/test/runtime/model/prompt/policy/commit versions and hashes are linked; correction supersedes. | Sample appeal replay. | CB / Approved |
| DAT-008 | M | Store UTC and render/schedule with IANA timezone. | India/US DST and quiet-hour test cases pass; timezone change does not rewrite prior event dates. | timezone test suite. | FND / Approved |

## 11. Non-functional requirements

| ID | P | Requirement | Acceptance criteria | Acceptance evidence | Phase / state |
|---|---|---|---|---|---|
| NFR-SEC-001 | M | Public traffic enters only through Cloudflare Tunnel; no router port forwards/direct origin exposure. | External scan finds only intended hostname; DB, runner, SSH, hypervisor, objects unreachable; origin trusts forwarded headers only from tunnel. | External scan/network-policy report. | FND / Approved |
| NFR-SEC-002 | M | Hostile code/repositories are separated by KVM and strict no-egress/no-secret policy. | Threat-model runner gate passes before every image/runner upgrade. | Adversarial sandbox report. | FND / Baseline |
| NFR-SEC-003 | M | Secure web baseline includes TLS, secure cookies, CSRF, CSP, input validation, output encoding, safe Markdown, SSRF allowlists, and rate limits. | OWASP-focused automated/manual suite passes; no Critical/High unresolved finding. | Security test/report. | FND / Baseline |
| NFR-SEC-004 | M | Secrets are scoped, encrypted, rotated, redacted, and absent from source/artifacts/logs. | Secret scan clean; rotation drill; canary absent from logs/exports/backups/UI. | CI and drill evidence. | FND / Baseline |
| NFR-PRV-001 | M | Minimize external context and cohort/email exposure; no ads, location, contacts, public chat, or covert monitoring. | Data inventory maps every field to purpose/recipient/retention; prohibited fields/features absent. | Privacy review/data map. | FND/CB / Baseline |
| NFR-PRV-002 | M | Consent/visibility/provider-routing withdrawals affect future processing promptly. | New calls/projections/notifications stop after withdrawal; historical lawful evidence follows retention. | Withdrawal propagation tests. | CB / Baseline |
| NFR-PERF-001 | M | Support ten active learners and two concurrent authoritative runs on the NUC. | Load test meets p95 targets without OOM, thermal/resource starvation or corrupt state. | Repeatable load/thermal report. | FND/CB / Approved scale |
| NFR-PERF-002 | S | Normal origin API p95 <750 ms; quiz p95 <1 s; typical code result p95 <8 s; tutor first token p95 <5 s when dependencies healthy. | Staging-like load run reports percentiles and excludes/labels external outage. | Performance report. | CB / Baseline |
| NFR-REL-001 | M | AI/GitHub/email/runner failures are isolated and work is durably retried or clearly degraded. | Fault injection shows no lost progress/duplicate official decision; dead-letter visible; tutor and administrator credential test/replace use durable owner/action/request UUID receipts so exact/concurrent/lost-response retries cannot duplicate provider or mutation effects. | Chaos/idempotency report, including [`integration/provider-operation-idempotency.integration.test.ts`](../integration/provider-operation-idempotency.integration.test.ts). | FND/CB / Provider-call slice implemented locally; broader chaos/dead-letter evidence remains |
| NFR-REL-002 | M | Best-effort local hosting has 24-hour RPO and 8–24-hour best-effort RTO. | Restore drill meets objective or release records exception. | Restore report. | FND / Approved baseline |
| NFR-REL-003 | S | Operate without a UPS under the approved best-effort pilot risk, while documenting that BIOS/Docker restart is not durability. | Risk acceptance recorded; BIOS auto-power recovery, durable DB/filesystem, external alert, backup, and safe boot/recovery drill pass; UPS remains recommended. | Operations risk record and recovery drill. | FND / Approved risk acceptance |
| NFR-OPS-001 | M | Patch supported Ubuntu/identity/database/runtime/dependencies and pin production artifacts. | Update policy, inventory, vulnerability scan, staged upgrade test. | Monthly/ release report. | FND / Baseline |
| NFR-OPS-002 | M | Structured observability redacts sensitive data and covers health, disk, DB, runner, providers, auth, email, quota, content and backup. | Dashboards/alerts fire in injected conditions; log canary scan clean. | Monitoring acceptance report. | FND / Baseline |
| NFR-OPS-003 | M | Services restart with dependency health checks; disk/log/temp cleanup and capacity alerts prevent silent exhaustion. | Reboot and disk-fill drills; backup age/free-space alert delivered. | Ops drill report. | FND / Baseline |
| NFR-A11Y-001 | M | Core flows meet WCAG-oriented keyboard, screen-reader, zoom, contrast, focus and non-hover requirements. | Automated checks plus manual keyboard, screen-reader, 200% zoom, 320 px and iOS Safari report; no blocker. | Accessibility report. | CB/VER / Baseline |
| NFR-A11Y-002 | M | Roadmaps/visualizers/editors provide equivalent accessible representations and status. | Graph has list; animation has step text/reduced motion; editor has focus escape and announced results. | Manual task-completion report. | CB / Baseline |
| NFR-COMP-001 | M | Responsive web supports current major desktop OS browsers and iOS Safari. | Browser matrix covers Chrome/Edge/Firefox/Safari desktop where available and iOS Safari; core task completion passes. | Compatibility report. | CB / Approved |
| NFR-MAINT-001 | M | Domains, schemas, APIs, policies and content are versioned and testable without microservice complexity. | Architectural boundaries/import rules, migration tests, typed contracts and ADR review pass. | Architecture conformance report. | FND / Baseline |

## 12. Release evidence checklist

### Foundation gate

- approved architecture/ADR, threat model, data model, and open-decision record;
- tunnel/network external scan;
- auth/MFA/session/recovery evidence;
- BYOK no-reveal/encryption evidence;
- isolated runner adversarial evidence;
- backup plus clean restore evidence;
- monitoring/reboot/disk-fill evidence;
- production NIM and email decisions.

### Core Beta gate

- curriculum coverage and runtime parity evidence for every promised Core Beta track;
- learner journeys from access through onboarding, placement, lesson, assessment, code, mastery/review, chat, project, appeal, and admin mentoring;
- ten-user/two-run performance evidence;
- privacy/visibility/retention/quota evidence;
- accessibility/browser compatibility report;
- AI golden eval and all-provider-outage fallback;
- documented Beta exclusions and no empty promised topics.

### Core Verified gate

- all `CUR-008` verification evidence;
- resolved content defects and coverage gaps;
- pilot learning/correctness metrics and qualitative review;
- no unresolved Critical/High security defect;
- restored production-like snapshot and reviewed operations runbooks.

## 13. Open decisions register

| Decision | Blocking gate | Safe default if owner delegates |
|---|---|---|
| Meaning and licensed production endpoint of “NIM mandatory” | Foundation | NIM adapter required and preferred when valid, but authored/consented-provider fallback remains available. |
| Exact runtime versions/standards | Core Beta content authoring | Current supported LTS/stable images pinned once and never described as generic “latest.” |
| Optional passkey first-factor and admin recovery proof | Foundation | TOTP remains mandatory for password and Google; recovery codes; manual recovery requires verified-channel evidence and audit. |
| Transactional email provider/domain | Foundation | Provider adapter with SPF/DKIM/DMARC; no direct residential SMTP. |
| Browser Python Quick Run | Core Beta | Defer; server Run/Grade first, games/visualizers client-side. |
| Private GitHub and build execution at launch | Core Beta | Public static review first; private GitHub App/build later. |
| 80–94 unlock and shorter mastery recheck | Core Beta assessment policy | Unlock next topic, assign targeted practice and shorter mastery recheck. |
| Exam compile/run feedback, disconnect threshold, cooldowns | Core Beta exam policy | Allow compiler/run on learner input; hidden tests only final; material outage >60 s or 10%; 1 h/6 h/24 h cooldown bands. |
| Leaderboard formula/default | Core Beta social | Off by default; capped mastery/review/project milestones only. |
| Raw chat/code and official evidence retention | Foundation privacy | 12 months raw; durable structured summaries; official evidence account life/24 months after completion pending approval. |
| Google Drive capacity/account owner | Foundation backup | Dedicated MFA account, at least 200 GB initially, increase from measured repository growth. |

## 14. External authoritative references

- [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/)
- [Better Auth Drizzle adapter](https://better-auth.com/docs/adapters/drizzle), [database schema](https://better-auth.com/docs/concepts/database), [session management](https://better-auth.com/docs/concepts/session-management), [security](https://better-auth.com/docs/reference/security), and [two-factor plugin](https://better-auth.com/docs/plugins/2fa)
- [NVIDIA NIM LLM API](https://docs.nvidia.com/nim/large-language-models/latest/api-reference.html)
- [NVIDIA NIM deployment/access guidance](https://docs.api.nvidia.com/nim/re/docs/run-anywhere)
- [Judge0 CE API](https://ce.judge0.com/)
- [Docker rootless mode](https://docs.docker.com/engine/security/rootless/) and [seccomp](https://docs.docker.com/engine/security/seccomp/)
- [PostgreSQL Backup and Restore](https://www.postgresql.org/docs/current/backup.html)
- [Google storage behavior](https://support.google.com/drive/answer/9312312?hl=en)
- [OWASP ASVS](https://owasp.org/www-project-application-security-verification-standard/)
- [WCAG overview](https://www.w3.org/WAI/standards-guidelines/wcag/)
