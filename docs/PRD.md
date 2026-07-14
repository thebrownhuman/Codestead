# Product Requirements Document: Adaptive Coding Tutor

**Status:** Authoritative pre-implementation PRD\
**Version:** 1.0-draft\
**Date:** 2026-07-12\
**Initial cohort:** Approximately ten approved adult learners in India and the United States\
**Requirements:** [requirements-matrix.md](requirements-matrix.md)

## 1. Executive summary

The product is a full-stack, adaptive coding-learning platform initially built for the owner's brother and a small invited cohort. It teaches complete, versioned learning tracks through short explanations, examples, checks, coding practice, exams, projects, spaced review, and an AI tutor that adapts language and analogies to the learner.

The central product is **not an unrestricted chatbot**. A trusted curriculum graph defines what exists, what depends on what, and what evidence demonstrates learning. Deterministic assessment and a reproducible server code runner decide objective correctness. The AI explains, hints, classifies likely misconceptions, critiques code, and helps review projects, but it cannot invent an active curriculum, see hidden tests, execute code, or independently decide mastery, publication, or appeals.

Core Beta is intended to include:

- Programming Foundations;
- C, C++, Java, and Python from complete beginner to independent intermediate learner;
- comprehensive shared DSA, implemented and assessed in the learner-selected one of those four languages;
- HTML, accessible page structure, CSS/responsive design, JavaScript/DOM/modules/asynchronous programming, and React through an intermediate single-page application;
- cross-cutting Git, debugging, testing, secure coding, code reading, and project planning.

The platform runs primarily on an owner-operated Ubuntu NUC. Cloudflare Tunnel supplies public HTTPS despite CGNAT; external providers supply AI, email, Google OAuth, GitHub access, and encrypted offsite backup. Learner code executes in a separate KVM security plane. The product is explicitly best-effort rather than highly available.

## 2. Problem

Beginning computer-science learners commonly face several linked problems:

- courses assume vocabulary they do not yet understand;
- explanations use one style even when the learner needs a concrete analogy or another example;
- a learner may call themselves intermediate without reliable evidence of which concepts are strong or weak;
- tutorials show syntax but provide too little deliberate practice, debugging, and review;
- normal compiler messages are intimidating and disconnected from the lesson;
- progress is represented as watched content rather than demonstrated competence;
- broad catalogs hide prerequisites and allow foundational gaps;
- generic AI chat may answer quickly but can hallucinate, reveal solutions prematurely, or skip systematic coverage;
- project feedback often arrives late or without reference to the learner's current level.

The immediate user need is a guided, patient path that can say: “Here is the idea in plain language; here is an analogy that fits you; here is the exact code; try one small thing; here is why it failed; now either review or move forward.”

## 3. Product vision

Enable a motivated beginner to become an independent intermediate programmer—and later advance—through an evidence-based personal roadmap that explains concepts clearly, makes practice safe, and never hides why the learner is moving forward or being asked to review.

### Product promise

For every promised required concept, the platform will provide:

1. explicit prerequisites and outcome;
2. a literal explanation in approachable language;
3. optional personalized analogies;
4. verified examples in the selected language/runtime;
5. small checks and guided practice;
6. debugging/coding application;
7. immediate, evidence-linked feedback and remediation;
8. mastery criteria and later review;
9. traceable sources and content version;
10. an appeal/report path when content, AI, or grading may be wrong.

“Complete” means complete against a published, bounded track version and outcome manifest. It does not mean every library, framework, language feature, or computer-science domain ever created.

## 4. Goals and non-goals

### Goals

- Move a true beginner from onboarding to a successful first code run quickly without sacrificing conceptual accuracy.
- Produce an individual concept-level roadmap from diagnostic and ongoing evidence (`ADP-*`).
- Teach Core Beta tracks without empty promised topics or unverified examples (`CUR-*`).
- Combine instruction and frequent low-stakes testing with clear remediation (`LES-*`, `ASM-*`).
- Provide authoritative LeetCode-style server execution for C/C++/Java/Python (`RUN-*`).
- Personalize explanation and project feedback using learner-controlled external AI providers (`AI-*`).
- Preserve resumable learning/chat/project context without treating raw history as unlimited prompt memory (`SES-*`).
- Give the admin a useful mentor/content/operator console with accountable actions (`ADM-*`).
- Make the product engaging through opt-in profiles, projects, achievements, streaks, and carefully designed leaderboards (`SOC-*`).
- Keep primary data local, recoverable, exportable, and protected (`DAT-*`, `NFR-*`).

### Non-goals for Core Beta

- public anonymous or self-service registration;
- commercial course marketplace or instructor revenue features;
- native iOS/Android/desktop apps;
- a lockdown/proctored exam client;
- camera, microphone, screen recording, raw keystroke, or clipboard-content surveillance;
- unrestricted web/package access from learner programs;
- local LLM/NIM inference on the current NUC;
- live AI-created courses entering active plans without human/source/verification publication;
- guaranteed high availability or formal SLA;
- native toolchain execution on learner laptops;
- certificates recognized by schools/employers;
- social direct messaging or public profiles outside the approved cohort;
- Next.js, Redux, Qt, NumPy/Pandas, Spring/Spring Boot, cloud/HPC/data-science tracks unless they enter a later approved scope.

## 5. Users and roles

### Learner

An approved adult, likely a computer-science student or early coding learner, using laptop/desktop and sometimes iOS. They may be a true beginner, have fragmented prior knowledge, or be intermediate in selected concepts. They want concrete progress, not an unstructured catalog.

Key jobs:

- understand a concept in language that makes sense to me;
- practice without fear of damaging my computer;
- know exactly why code is right/wrong;
- avoid repeating what I demonstrably know without skipping hidden gaps;
- resume where I stopped;
- build and receive useful project/GitHub feedback;
- see and control what my cohort, mentor, and AI providers receive;
- challenge incorrect content, AI, or grading.

### Administrator/mentor

The owner/operator who approves users, mentors learners, edits plans, reviews appeals, curates/publishes curriculum, and operates local infrastructure.

Key jobs:

- see who is stuck and why;
- intervene without destroying the learner's evidence/history;
- publish only complete, verified content;
- understand AI and runner health/cost;
- handle access, recovery, reports, and appeals safely;
- prove backups can restore the platform.

Admin access never includes passwords or MFA/recovery secrets. Ordinary views expose only provider metadata and last four; the sole plaintext BYOK path is an explicit fresh-MFA reveal with reason, no-store response, audit event, and learner notification. The ordinary learner profile opens a read-only mentor perspective, not impersonation (`AUTH-008`, `ADM-005`).

## 6. Product principles and policies

### 6.1 Curriculum authority

- Published curriculum is the teaching source of truth.
- Content is immutable by version; changes publish a new version.
- Required code examples and tests run before publication.
- AI can draft offline for an author, but cannot publish or inject live course material.
- A missing promised topic is a defect. A new library/domain is an extension proposal (`CUR-009`).

### 6.2 Evidence and mastery

- Self-report changes diagnostic depth but is not evidence.
- Objective correctness is deterministic where possible.
- Concept mastery normally requires both conceptual and applied evidence.
- Evidence records exact policy, content, item, test, runtime, and grader versions.
- Default thresholds: below 80 fails/remediates; 80–94 passes/unlocks; 95+ plus all critical criteria masters. This remains a versioned, owner-confirmed policy (`EXM-004`).
- Wrong attempts remain visible evidence and feed remediation; they do not delete prior success.
- Spaced review checks retention after initial success.

### 6.3 AI authority

AI may explain, analogize, hint, summarize, classify a likely misconception, create bounded practice variants, provide rubric evidence, and review code/projects. It may not:

- execute code;
- access hidden tests/reference solutions;
- directly set scores/mastery;
- publish curriculum;
- change a plan without a deterministic/admin command;
- determine cheating;
- close an appeal about itself.

### 6.4 Privacy and adult mentoring

The cohort is adult-only at launch. The learner is told before onboarding that the admin is also a mentor with broad educational visibility. Raw chat/code access is purposeful and audited, not casually expanded. Cohort visibility and admin inactivity copies remain separate controls. No ads, targeted marketing, geolocation, contacts, or cross-user messaging are planned.

### 6.5 Server truth and local preview

Games and visualizers run in-browser. Browser Python quick-run may be added, but browser/WASM results are practice preview only. Official server submission uses a declared pinned runtime and hidden tests. This avoids presenting WASM/Pyodide behavior as identical to CPython/GCC/OpenJDK.

## 7. End-to-end learner journey

### 7.1 Access and security (`AUTH-*`)

1. Visitor reads scope/privacy and requests access with verified email, display name, brief optional reason, and 18+ confirmation.
2. Admin approves or rejects.
3. Approval sends a single-use 24-hour enrollment link. No password is generated or emailed.
4. Learner chooses Google or sets an email/password through Better Auth in the Next.js application.
5. Learner enrolls and verifies TOTP and stores recovery codes. Better Auth's Google/social completion is custom-gated through TOTP because its two-factor plugin does not enforce 2FA on social sign-in by default. A passkey may later be offered as a first factor, not as an unreviewed replacement for MFA.
6. One database-backed browser-device session may remain active for up to 30 days; new-device login replaces it after MFA and sends a notice.
7. Learner can inspect recent history and logout the current browser family. A new family is blocked while one is active; lost-device access is restored only after an authenticated request or out-of-band identity confirmation and fresh-MFA/reasoned admin revocation.

### 7.2 Onboarding and placement (`ONB-*`, `ADP-001`)

The learner supplies goal, timezone, time availability, experience, selected track/language, and optional interests/analogy preference. The product discloses mentor visibility, external AI routing, sandbox execution, retention, and cohort controls.

They can start from the beginning or take an adaptive diagnostic. “I don't know” is valid. The result is a proposed roadmap with evidence and a learner challenge/review option.

### 7.3 Daily learning (`LES-*`, `ADP-*`, `SES-*`)

Home prioritizes an active session, due review, current concept, mentor remediation, or project. Every recommendation says why. A lesson progresses through explanation, example, check, practice, code/debug, recap, and next action. The learner can ask for simpler language, an interest analogy, another example, progressive hint, tutor chat, or content report.

The learner can end and later resume a session without losing durable plan/mastery. A new focused session does not create a fresh learning identity. Chat threads can independently start/resume/archive while using bounded structured memory.

### 7.4 Assessment and execution (`ASM-*`, `EXM-*`, `RUN-*`)

Practice items explain correctness and remediation immediately. Server code states distinguish compilation, runtime, wrong answer, timeout, resource limit, and infrastructure failure. Infrastructure failure does not penalize the learner.

Exams disclose timing, allowed tools, thresholds, event logging, disconnect and appeal policies. Tutor/hints/docs/web/visualizer are disabled. The server clock and last confirmed autosave are authoritative. Focus/paste signals are human-review evidence only, never automatic guilt.

### 7.5 Projects and social (`PRJ-*`, `SOC-*`)

Learners create/upload projects or link a public GitHub repository at an immutable SHA. Static review is isolated. Private GitHub, if enabled, uses a selected-repository read-only GitHub App, never PATs. Findings are tied to exact files/tools/models and are appealable.

Cohort profiles are alias-only by default. Learners separately opt into discoverability, badges, streak, mastery, projects, and leaderboard. Leaderboards reward capped mastery/review/project outcomes, not speed, hours, attempts, or AI spending.

### 7.6 Appeals (`RUN-007`, `AI-010`, `PRJ-005`, `DAT-007`)

Official code results, assessment/exam decisions, AI correctness claims, project findings, and plan decisions expose an appeal/report path. The system freezes exact evidence versions. Admin decisions require rationale; overturned results append corrective evidence and recompute downstream state without erasing history.

## 8. Functional requirements by capability

This section summarizes product behavior; [requirements-matrix.md](requirements-matrix.md) contains the testable contract.

### Identity and account

- Request/approval gate, Google and password, MFA/recovery, one active remembered browser family, current-device logout, and audited administrator revocation (`AUTH-001`–`AUTH-009`).
- Versioned consent/disclosure and 18+ confirmation (`ONB-002`, `ONB-003`).
- Security history, export/delete, and credential/integration controls.

### Catalog and authoring

- Versioned catalog, prerequisite DAG, complete lesson schema, authoritative citations, language variants, code/test verification, draft/review/publish/rollback (`CUR-*`, `ADM-003`).
- Beta and Verified are visible release stages; “Coming Soon” cannot expose empty lessons.

### Adaptive engine

- Concept-level diagnostic, mastery, confidence, critical criteria, misconception state, plan revisions, review schedule, deterministic next-action reason (`ADP-*`).
- Admin overrides are reasoned and visible.

### Learning UI

- Home, roadmap graph/list, lesson shell, editor/visualizer, practice/exam modes, chat, project, cohort, settings, appeals, and admin (`LES-*`, `SES-*`, `NFR-A11Y-*`).
- Responsive on current desktop platforms and iOS Safari.

### AI and BYOK

- NVIDIA NIM/OpenAI-compatible and other configured adapters (`AI-001`, `AI-002`).
- Multiple per-user encrypted keys; last-four-only ordinary views; controlled admin reveal only after fresh MFA, reason, audit and learner notification; owner consent/budgets/fallback; optional admin fallback with explicit consent (`AI-003`, `AI-004`).
- Grounded context, typed outputs, eval gate, model/prompt/content provenance, canonical fallback (`AI-005`–`AI-010`).

### Runner

- Separate KVM execution plane, pinned images, strict limits/no network/no secrets, async states, hidden-test protection, immutable appeal evidence (`RUN-*`).
- Initial one job/learner and two global concurrency.

### Admin

- Access requests/users/sessions; learner mentoring and plan edits; content publication; appeals/reviews; provider cost/health; runner/jobs; email; quotas; backups; audit (`ADM-*`).
- No secret reveal or implicit impersonation.

### Notifications and data

- One generic 24-hour inactivity email to the learner and one generic mentor notice to the admin, then one final generic learner reminder at 72 hours; the episode stays silent after that until meaningful activity closes it. Learner-local timezone/quiet hours, an audited temporary pause, and enrollment disclosure apply (`NOT-001`, `NOT-002`).
- Security, appeal, backup and operational notices through durable outbox; no backup email attachments (`NOT-003`, `NOT-004`).
- 2 GB learner quota, long category-specific retention, export/delete, nightly local/weekly offsite encrypted backup with 7/4/12 recovery points (`DAT-*`).

## 9. Curriculum release scope

### Core Beta

“From complete beginner to independent intermediate learner.”

Required tracks:

- Programming Foundations;
- C: beginner to intermediate;
- C++: beginner to intermediate;
- Java: beginner to intermediate;
- Python: beginner to intermediate;
- comprehensive DSA with full implementation/assessment parity in those four languages;
- HTML and accessible page structure;
- CSS, responsive layout, and modern styling;
- JavaScript language, DOM, modules, and asynchronous programming;
- React: JSX, components, props, state, events, lists, forms, core hooks, data fetching, routing, basic testing, and one intermediate SPA;
- cross-cutting Git, debugging, testing, secure coding, code reading, and project planning.

“Beta” means pedagogically usable and complete against the promised manifest, not knowingly missing graduation/prerequisite content. It may still await the full verification evidence and pilot proof required for Verified.

### Core Verified

Promotion requires `CUR-008`: source coverage, 100% skill coverage, prerequisite/mastery review, all code/test execution, assessment parity, web accessibility review, exclusions/runtime versions, admin approval, and resolved release-blocking defects.

### Advanced Beta

- advanced C;
- advanced modern C++;
- advanced Java/JVM;
- advanced Python;
- optional advanced web/React;
- advanced algorithms outside the approved DSA core.

Access requires verified intermediate prerequisites or audited admin override.

### Extensions / Coming Soon

Qt, NumPy/Pandas, Spring/Spring Boot, and later learner-requested frameworks/domains appear only after an approved curriculum brief. “Coming Soon” communicates roadmap status; it does not generate or unlock empty lessons.

## 10. Technical and operational product constraints

- Primary trusted deployment is the Ubuntu NUC specified in [architecture.md](architecture.md).
- Cloudflare Tunnel is the only public ingress because the connection has no public IP. Cloudflare documents the daemon as initiating outbound-only connections suitable for origins without a public routable address ([official documentation](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/)).
- Better Auth is integrated into Next.js through its Drizzle PostgreSQL adapter, and Drizzle is the application ORM/migration layer. Its official documentation covers generated database schema, email/password and Google/social flows, database-backed session listing/revocation/freshness, OAuth state/PKCE, secure cookies, and two-factor/passkey plugins ([Drizzle adapter](https://better-auth.com/docs/adapters/drizzle), [sessions](https://better-auth.com/docs/concepts/session-management), [security](https://better-auth.com/docs/reference/security), [plugins](https://better-auth.com/docs/plugins)). Product-specific approval, learner/admin roles, one-active-session, fresh-MFA, and audit rules remain application-owned.
- Authoritative untrusted execution runs outside the trusted Docker plane. Judge0 documents language execution and bounded resource configuration, but the application adds a separate VM/network boundary ([Judge0 CE](https://ce.judge0.com/)).
- NVIDIA NIM exposes OpenAI-compatible APIs, supporting a gateway adapter ([NIM API](https://docs.nvidia.com/nim/large-language-models/latest/api-reference.html)). The production endpoint/license must be resolved because NVIDIA distinguishes prototyping/development access from production use ([NIM access guidance](https://docs.api.nvidia.com/nim/re/docs/run-anywhere)).
- PostgreSQL and learner objects are backed up nightly to local USB/NAS and weekly offsite. PostgreSQL documents logical backup/restore tools but a successful restore drill, not file existence, is the product acceptance evidence ([PostgreSQL backup documentation](https://www.postgresql.org/docs/current/backup.html)).
- A free Google account's 15 GB is shared across Drive/Gmail/Photos and is insufficient for the intended full backup; a dedicated paid account and client-side encryption are required ([Google storage documentation](https://support.google.com/drive/answer/9312312?hl=en)).
- A 32 GB USB is not the full backup target; a 1–2 TB local target is the baseline.
- No UPS means explicitly accepted best-effort availability and elevated power-loss risk until one is added.

## 11. Data and privacy requirements

### Data categories

- identity/security projection;
- profile, goals, interests, preferences and consent;
- curriculum/content/version/source evidence;
- plans, learning sessions, attempts, mastery, misconceptions, review schedule;
- chat, model-call metadata/summaries and bounded artifacts;
- code submissions/results, exams/events, projects/GitHub reviews;
- cohort profile/achievements;
- admin/support/appeal/audit;
- quota, notification, operational and backup metadata.

### Baseline retention

- progress/mastery/projects/achievements: account life;
- raw ordinary chat/code: 12 months, with durable structured summaries/official evidence as policy permits;
- security and disclosed exam behavior events: 90 days unless held for incident/appeal;
- provider-call metadata: 12 months, raw prompt/response minimized/shorter;
- admin audit: 12–24 months;
- temporary runner/repository artifacts: hours to seven days unless pinned as evidence;
- backup retention: seven daily, four weekly, twelve monthly.

The owner requested long retention; final category durations remain a release decision. Learners can export/delete according to policy. Deletion copy must explain the time for encrypted backup copies to age out.

### External recipients

- Cloudflare: public request path;
- Google: OAuth identity and separately encrypted Drive backup;
- selected AI providers: consented bounded lesson/chat/code/project context;
- transactional email provider: email and non-sensitive template payload;
- GitHub: repository access selected by learner;
- no advertising/data-broker recipients.

## 12. Success metrics

For a cohort of ten, percentages alone are misleading. Report both counts and individual journeys.

### Learning outcomes

- median time from onboarding completion to first successful official code run;
- number of learners completing first required module and first project;
- concept pass/mastery rates by concept and language;
- diagnostic skip followed by remediation rate (false-skip signal);
- misconception recurrence after remediation;
- due-review completion and retained-mastery rate;
- ratio of solution reveal to independent successful attempt;
- project rubric improvement between revisions;
- learner-reported clarity/confidence for sampled lessons.

### Product quality

- content error reports per 100 completed activities and resolution time;
- verified code-example/test pass rate (target 100% for published required content);
- AI incorrect/unsafe report rate and upheld rate;
- provider schema/fallback/unavailable rate;
- runner infrastructure failure and reproducibility rate;
- appeals per decision type and overturn rate;
- onboarding/lesson/exam/project drop-off points;
- accessibility blocker count.

### Operations and cost

- p95 normal API, code result, and first-token latency against `NFR-PERF-*`;
- runner queue depth, thermal throttling and resource-limit kills;
- AI cost/token/request by learner, task and completed concept;
- disk/quota growth and forecast;
- backup success age, offsite copy age and restore-test result;
- auth/MFA recovery/new-device/security events;
- email delivery/bounce and duplicate inactivity reminder rate.

### Initial pilot exit criteria

Core Beta may enter broader use only when:

- all ten approved users can access, secure, and revoke accounts;
- at least three representative learners complete onboarding → lesson → code → assessment → review without operator database intervention;
- promised content manifest has no required empty node and all examples/tests pass;
- no Critical/High unresolved security issue;
- BYOK, runner isolation, and provider-outage gates pass;
- a clean restore succeeds;
- learner qualitative feedback identifies no systemic blocker;
- actual monthly infrastructure/AI/resource use is within the owner-approved budget.

## 13. Delivery roadmap

### Phase 0: Decisions and learning specification

- Resolve NIM production meaning/endpoint, runtime versions, MFA/recovery, email provider, retention, UPS/risk, Drive capacity, exam policy, private GitHub and quick-run scope.
- Finalize curriculum manifests and representative lessons across programming, DSA and web.
- Build threat/eval/coverage test fixtures.

**Exit:** All Foundation-open decisions in the requirements matrix have owners and evidence plans.

### Phase 1: Platform foundation

- NUC hardening, tunnel, management path, Next.js with Better Auth/Drizzle, PostgreSQL, objects, worker/outbox, telemetry, backup/restore.
- Request/approval, Google/password/MFA, sessions/revocation.
- Admin access/users/system and audit.
- Isolated runner VM with one representative task per language.
- Credential vault/provider contract skeleton.

**Exit:** Foundation security/restore/runner/auth gates pass.

### Phase 2: End-to-end learning vertical slice

- Onboarding/placement, roadmap, lesson shell, quiz, code submission, mastery, review, chat, admin plan/content, appeal.
- Use a narrow representative concept set before multiplying content.

**Exit:** Golden beginner/intermediate journeys pass and replay deterministically.

### Phase 3: Core Beta breadth

- Complete/publish all promised language, DSA, web and cross-cutting manifests.
- Projects/public GitHub, social/achievements, notifications, exams, quota/data controls.
- Provider adapters/evals and optional approved quick-run.

**Exit:** Core Beta gate in the requirements matrix passes; invite-only pilot begins.

### Phase 4: Core Verified

- Run pilot, resolve content/product defects, complete coverage/parity/accessibility/security/restore evidence.

**Exit:** `CUR-008` and Verified gate pass; publish immutable verified version.

### Phase 5: Advanced and extensions

- Advanced tracks, then approved Qt/NumPy-Pandas/Spring and future domains through the same publication gates.

## 14. Dependencies

- domain and Cloudflare account/tunnel;
- supported patched Ubuntu host and KVM virtualization;
- local backup disk/NAS (1–2 TB recommended), dedicated paid Google Drive/One account, separate recovery key;
- Google OAuth application;
- transactional email account/domain DNS;
- production-authorized NVIDIA NIM access and other chosen provider accounts;
- GitHub App if private repositories are included;
- curriculum authors/reviewer/admin availability;
- pinned compiler/interpreter images;
- approved privacy, retention, exam, social and cost policies.

## 15. Key risks and mitigations

| Risk | Impact | Mitigation / product response |
|---|---|---|
| Four languages + DSA parity + web at Core Beta is too broad for high quality | Delayed launch or shallow/incomplete content | Vertical-slice platform first; bounded manifests; no empty promised nodes; Beta still requires pedagogical completeness; verification evidence. |
| NUC/ISP/router/power single point of failure | Outage and possible data loss | Best-effort copy, external monitor, BIOS/service restart, durable DB, UPS recommendation, local/offsite backup and restore. |
| Admin is a single high-privilege operator | Broad privacy/integrity impact if compromised | Strong MFA, shorter/recent-auth, no key/password reveal, audited reads/actions, optional future second approval. |
| User code/repository escapes | Host/home network/secret compromise | Separate KVM VM, no egress/trusted routes/mounts/secrets, strict resource limits and adversarial tests. |
| BYOK leaks | Learner provider account/cost compromise | Non-revealable envelope encryption, scoped capped keys, redaction, recent MFA, rotation/delete, canary tests. |
| External AI is wrong or unavailable | Learning harm or blocked tutor | Canonical curriculum, deterministic grading, typed gateway, evals, provenance, reports/appeals, authored fallback. |
| NIM trial/licensing unsuitable | Production interruption/compliance risk | Resolve production service before pilot; adapter/fallback; no dependency on local inference. |
| Long retention exceeds disk/backup or increases breach harm | Outage/data exposure | 2 GB quota, category retention, summaries, temp cleanup, 1–2 TB dedup target, paid offsite, alerts/export/delete. |
| Gamification discourages learners or rewards abuse | Poor learning behavior | Optional, alias/private defaults, mastery/review/project measures, caps and explainable formula. |
| Exam telemetry is treated as proof | False accusation/privacy harm | Limited disclosed events, no invasive capture, human review, learner response/appeal. |

The detailed risk register is [threat-model.md](threat-model.md).

## 16. Acceptance and governance

- Every release selects requirement rows and attaches the specified acceptance evidence.
- Product owner accepts product-policy decisions; admin/platform owner accepts operational risk; curriculum reviewer accepts content evidence; security review accepts threat gates.
- An unresolved `Open` Foundation/Core Beta requirement cannot silently become “not applicable.” It needs a decision, deferral with scope change, or explicit risk acceptance.
- Model, prompt, runtime, mastery policy, exam policy, content and schema changes follow versioned migration/release records.
- A learner-facing promise changes only with a corresponding catalog/requirements version and migration plan.

## 17. Decisions required before implementation lock

1. Define exactly what “NIM mandatory” means and identify the authorized production endpoint/license.
2. Confirm Core Beta's full DSA parity and HTML/CSS/JavaScript/React scope.
3. Select exact CPython, GCC/G++/standard, and OpenJDK versions.
4. Approve whether optional passkey first-factor support is in Core Beta and define manual recovery proof; TOTP remains the required second factor for password and Google.
5. Select the transactional email provider and sending domain; learner and admin inactivity notices are already an approved disclosed cohort policy.
6. Confirm 80–94 unlock/recheck, exam compile/run feedback, material outage threshold, and cooldown bands.
7. Decide whether Python browser Quick Run is in Core Beta.
8. Decide public-only versus private GitHub and whether any approved build/dependency access ships.
9. Approve raw/official evidence retention durations.
10. Preserve the approved no-UPS/best-effort risk in the operations record and revisit after pilot evidence; it is no longer an unstated availability assumption.
11. Approve dedicated Google account owner/capacity and 1–2 TB local target.
12. Approve leaderboard formula and secure default-off participation.

## 18. Document map

- [Requirements matrix](requirements-matrix.md) — testable IDs and acceptance evidence.
- [Architecture](architecture.md) — components, boundaries, flows, deployment and operations.
- [Threat model](threat-model.md) — assets, threats, controls, residual risks and security gates.
- [Data model](data-model.md) — PostgreSQL schemas, entities, integrity, RLS, retention and backup coverage.
- [UX flows](ux-flows.md) — route, learner/admin journeys, states, copy and accessibility contract.
- [ADR-0001](adr/0001-platform-architecture.md) — chosen platform architecture, rejected alternatives and consequences.
