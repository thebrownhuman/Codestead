# Revision Two: beginner games and resource efficiency

Date: 2026-10-06. Baseline: `7a0dda402f0a3486c85de75f2c5fe5bbd8654479`.

This revision preserves the previous request: find additional bugs, test the application, recommend mail tooling, and improve learning for complete beginners through meaningful interaction and coding games. It adds a resource-efficiency review for a self-hosted Intel NUC with approximately 32 GB RAM, a 1 TB drive, and around 20 concurrent learners. The CPU generation is unconfirmed. Learners should have free access; buying AI capacity is optional.

## Recommendation

Build **Robot Courier** first, then expand the same small engine into a **town that learners repair with code**. Give each mission one concept, a visible consequence, a useful response to mistakes, and an independent transfer question. Use existing React and SVG before adopting a game framework. Keep Piston for real code execution; the available evidence does not justify replacing it.

For resources, first remove avoidable synchronous work, perpetual timers, unnecessary downloads, and excessive background activity. Measure runner queueing and actual container use before reducing limits or combining workers. A large Compose memory limit is a ceiling, not proof that the service reserves or consumes that amount.

The application fixes below are implemented. The [playable three-mission prototype](prototypes/robot-courier.html) is a separate design artifact, not a published course or a production Python runtime. Future ideas are explicitly recommendations.

## Implemented and checked

| Finding | Trigger and prior behavior | Result in this revision |
| --- | --- | --- |
| Duplicate deterministic quest advancement | A second correct submission during the 700 ms transition could skip the next checkpoint. | A synchronous ownership guard blocks another request; the button stays locked until the single transition ends. |
| Abandoned quest work | Requests and delayed advancement could survive the quest component. | Unmount aborts the request and cancels the timer. A bank/skill identity change mounts fresh quest state, and a late aborted response is ignored. |
| Hint count exceeds the checker contract | Hint clicks incremented indefinitely; index 21 exceeds the API maximum of 20. | Manual hints stop at the available hint count, with the API bound retained. A missing authored hint permits one generic fallback hint. |
| Duplicate fallback reflection advancement | Repeated submissions during the 500 ms delay could skip a stage. | Only one transition can be scheduled; it is cancelled on unmount. |
| Fallback quest has no clear finished state | The last reflection displayed feedback but did not finish the interaction. | A completion screen and replay action explicitly preserve ungraded practice semantics. |
| Visualizer keeps waking after the last step | An interval kept firing although the step index could not advance. | A cancellable one-step timeout is scheduled only while another step exists. End controls are disabled, and no timer remains. |
| Expensive credential-label near-matches, prior N2 | An unbounded repeated-word prefix made ordinary prose scans approximately quadratic. | Match the credential suffix directly; preserve prefixes, quotes, and existing value/placeholder policies. Regression tests retain secret exclusion. |
| Git-free archive classification, prior F11 | Git's filesystem-boundary diagnostic caused six archive-scanning tests to fail. | Recognize the two specific no-repository diagnostics under a controlled locale. Corrupt Git metadata and unrelated failures still fail closed. |
| Production dependency advisories, prior F2 and its addendum | A fresh audit reported two high-severity advisories with compatible fixes. | Update only `source-map-js` 1.2.1 → 1.2.2 and `sharp` 0.35.4 → 0.35.5, including sharp's platform/libvips packages. Verify the installed tree, codec behavior, build, and fresh audit. |

Implementation: [quest](../../src/components/lesson/deterministic-logic-game.tsx), [workspace](../../src/components/lesson/lesson-workspace.tsx), [credential patterns](../../src/lib/security/credential-patterns.ts), and [Git file discovery](../../scripts/lib/repository-git-files.ts).

These fixes do not award mastery, XP, badges, or exam credit for a game, a reflection, or an animation. Bank identity reset uses skill ID and bank ID; replacing content under an unchanged identity should still be handled by publication/version identity if the application later supports live bank replacement. The dependency update preserves the direct dependency declarations and adds/removes no lockfile package paths. It does not by itself patch already deployed images, which need rebuilding and verification.

### Measured redaction improvement

On this cloud machine, Node 24.19.0 on an AMD EPYC 9V74 host, the same synthetic 65,536-character repeated-word input took approximately **5,881 ms before** and **1.17 ms in an isolated after-change run**. Five warmed after-change samples had a median of approximately **0.48 ms**. The output ceiling remained 4,000 characters. The original algorithm was measured before editing in this turn.

| Input characters | After-change median, five warmed samples |
| ---: | ---: |
| 2,000 | 0.032 ms |
| 4,000 | 0.035 ms |
| 8,000 | 0.062 ms |
| 16,000 | 0.116 ms |
| 32,000 | 0.231 ms |
| 65,536 | 0.478 ms |
| 131,072 | 1.194 ms |

This measures one problematic input family, not application throughput or a worst-case guarantee for every regular expression. Separate smoke measurements covered repeated credential-label near-matches and unterminated private-key headers; the latter still took about 49 ms for 56,000 characters. Input/work budgets remain useful for large provider/evidence projections. Do not extrapolate these timings to the Intel NUC without measuring it.

Raw evidence: [comparison](evidence/revision-two-redaction.json) and [additional families](evidence/revision-two-redaction-families.json).

### Existing content cache: measured before redesigning

A fresh `ContentRepository` loaded the 12 courses and 476 skills in approximately **397 ms**, with about **49 MiB additional heap** and **111 MiB additional RSS** at the sampled point. Twenty successive sets of cached skill/lesson/catalog lookups took approximately **0.59 ms total** in that process. This cloud-host probe ran during verification and includes neither PostgreSQL nor HTTP; allocations/RSS are point measurements, not permanent retained-memory guarantees.

The result supports preserving the existing cache. Cold runtime/duplicate process footprint deserves measurement, while replacing these small warm lookups is unlikely to be the first useful optimization. [Probe evidence](evidence/revision-two-content-runtime.json).

## Best game concepts

The ranking is a product/design judgment, not an experimentally established ranking. Favor concepts where understanding the code directly helps the learner accomplish the goal.

| Priority | Concept | Coding action and concept | Resource fit |
| --- | --- | --- | --- |
| 1 | Robot Courier | Plan movement, repair a loop, then write a different route. Sequences, loops, conditions, and later functions. | A small SVG grid and bounded event trace. No physics engine or live server tick. |
| 2 | Bug Detective | Compare expected and actual state, find one faulty instruction, and test a repair. | Mostly text and a trace; reuse the lesson/runner infrastructure. |
| 3 | Tiny Café | Calculate a receipt and change, check stock, then factor repeated work into a function. | Integer state and small cards. Strong connection to ordinary life. |
| 4 | Pixel Painter | Write loops that produce a pattern; later change a nested loop or a condition. | A bounded bitmap/SVG, for example a small fixed grid. Rendering stays in the browser. |
| 5 | Story Studio | Write branching dialogue or a function that selects a story response. | Text-first, with optional small illustrations. The learner can personalize the result. |
| 6 | Garden Keeper | Decide which plants need water using conditions and iterate over a collection. | Discrete state changes on Run, not a continuously simulated world. |
| 7 | Tiny Factory | Transform a sequence of items through functions: input, processing, output. | Reuse a bounded queue animation and actual trace events. |
| 8 | Data Detective | Search a small collection, filter records, and explain the selected result. | Curated local JSON; no new service. |
| 9 | Build a Tiny Website | Change real HTML/CSS, then add one interaction and keyboard support. | Existing code lab and an isolated preview. The result becomes a useful personal artifact. |
| 10 | Rhythm Builder | Use repetition to compose a short rhythm and then modify its pattern. | Optional browser audio with visual/text equivalents; no autoplay or streaming service. |

**Best longer-term experience: Repair the Town.** A learner restores a delivery route, café, garden, and workshop. Each location is a short mission using the same engine. Earlier programs become their own growing collection of creations. Progress comes from a demonstrated concept and a new problem, rather than accumulating clicks. Avoid making all locations compulsory: a learner should be able to choose an appealing context while meeting the same concept objective.

This is not a recommendation to build ten engines or a multiplayer world. Start with three courier missions and one independent exercise. Reuse the mechanics only after observing learners successfully use them.

### Three-mission prototype

1. **Predict:** read three movement instructions, choose the stopping column/row, and inspect each move.
2. **Repair:** fix an off-by-one repeat count, predict again, and compare the resulting route with the destination.
3. **Build:** construct a new route around obstacles with progressively less assistance.

The prototype has keyboard-operable controls, textual coordinates and obstacle descriptions, backward/forward stepping, a responsive 320 px layout, and no perpetual animation. It allows at most eight command groups with repeat counts from one through six. Editing invalidates the previous run and requires another prediction.

It deliberately simulates a finite movement-command vocabulary. The displayed Python is a preview of the same commands, not proof that an arbitrary Python interpreter executed it. Production integration must use real runner output for Python semantics. The prototype stores no learner data and gives no official awards.

The three standalone files total approximately **15.3 KB raw**, or **5.5 KB when independently gzipped**, excluding HTTP overhead. This is a measured design-artifact size, not the production application's initial download size. [Size evidence](evidence/revision-two-prototype-size.json).

## How the production game should work

1. Store reviewed mission definitions as versioned local content: objective, initial world, supported actions, starter code, hints, expected outcomes, and a distinct transfer task.
2. Offer a worked program first; ask a prediction before running it. Move through code arrangement/completion, one meaningful edit, and independent writing.
3. Run real Python through the existing isolated runner. Supply a small reviewed `move`/world API and produce bounded structured events. Cap steps, output bytes, runtime, and mission dimensions using the actual runner contract.
4. Validate the returned event schema and mission identity. Render those events in the browser with SVG. Avoid claiming that an inferred animation is the actual execution of arbitrary learner code.
5. Tie each highlighted code location to the corresponding event. Backward steps restore snapshots from the validated trace; they do not rerun the server.
6. Let the learner change one thing and predict again. Feedback should identify an observable mistake: a boundary hit, wrong repeat count, unhandled condition, or incorrect value.
7. Finish with an unfamiliar map or a plain coding task using the same concept. Official evidence must follow the existing reviewed assessment/publication rules.

Use Piston on Run/Submit, not per animation frame. One submitted run produces a reusable trace. A game must function without an AI key; optional AI can explain a mistake, while deterministic evaluation remains the source of correctness.

A first real-code version needs dedicated runtime-contract tests before publication: mission API instrumentation, trace/output bounds, infinite loops, malformed events, changed mission versions, account/session ownership, retry/cancellation behavior, and runner results that fail before any valid trace is produced. The standalone prototype does not verify those production boundaries.

## Evidence for improving learning

The existing [pedagogy document](../interactive-lesson-pedagogy.md) already includes many sensible techniques. The beginner-content audit passing does not independently establish comprehension or learning gains.

| Technique | Product application | Evidence and qualification |
| --- | --- | --- |
| PRIMM | Predict, run, investigate, modify, and make. Let beginners start by reading a program before facing a blank editor. | [Sentance, Waite, and Kallia](https://doi.org/10.1080/08993408.2019.1608781). Supports an instructional approach, not a universal guarantee for every implementation. |
| Retrieval practice | Return after a delay and solve a new short task without immediately showing the previous solution. | [Roediger and Karpicke](https://doi.org/10.1111/j.1467-9280.2006.01693.x). Delayed-retention evidence from the reported experimental setting; programming transfer requires its own evaluation. |
| Parsons problems | Temporarily arrange/indent code before independently writing it. | [Hou, Ericson, and Wang](https://doi.org/10.1145/3501385.3543977). Lower completion time did not imply a statistically significant learning improvement in that study. |
| Named subgoals | Show the purpose of each step: calculate, check, update, return. | [Subgoal-label study](https://doi.org/10.1186/s40594-020-00222-7). Helps make solution structure explicit; transfer remains a separate outcome. |
| Guided explanation | Ask why a particular instruction changes the state, rather than asking for a long generic summary. | Computing studies linked in the existing pedagogy document support structured prompts; an explanation's character count cannot establish correctness. |
| Active visualization | Make a prediction, then explain the discrepancy after stepping through an execution. | Visualization evidence is mixed. Attractive playback alone is not evidence that the learner can code independently. |

Primary publication sites returned access denials in this environment. These are established references already documented in the project, not newly fetched full-paper conclusions. Official upstream library/project documentation was accessible; its availability is not evidence of educational effectiveness.

### Evaluate the game with the actual audience

- Observe five genuine first-time learners using the first mission. Record where terminology, navigation, prediction, or error recovery blocks them.
- With a small cohort, counterbalance two comparable lesson formats and account for prior knowledge. Check an unassisted new task immediately and again after one and seven days.
- Measure success on the new task, hint dependence, frustration, abandonment, and return behavior. Completion time, satisfaction, and number of clicks answer different questions from learning.
- Treat results from around 20 learners as exploratory. Report raw counts and observed uncertainty; do not claim general superiority from a small experiment.
- Collect only the needed events under the existing consent/data lifecycle policy. Free learners should receive the full deterministic lesson and game flow.

## Resource optimization plan

### Apply first

| Area | Concrete next action | Expected benefit and verification |
| --- | --- | --- |
| Main-thread synchronous work | Keep the credential-label fix; audit budgets for large structured evidence before projection. | Removes a measured event-loop stall. Benchmark the actual production Node image and remaining input families. |
| Browser activity | Keep terminal visualizer timer cleanup; pause decorative mentor activity when hidden and respect reduced motion changes. | Fewer wakeups and less battery/CPU work on learner devices. Measure timers and browser traces rather than promise server savings. |
| Initial downloads | Keep Monaco lazy-loaded. Measure what an ordinary Lesson visit requests before further splitting tutor, code-lab, or game modules. | Less bandwidth and client parsing. Compare per-route transferred/compressed bytes and hydration cost. Total build chunks are not the bytes every learner downloads. |
| Static assets | Verify production compression and immutable caching for hashed assets. Version the currently unversioned `/monaco/vs` URLs before assigning long immutable caching to them. | Reuses downloads across visits and learners without pinning an old editor after an upgrade. Check real headers and cache behavior at the deployed proxy. |
| Content runtime | Retain the shared immutable repository already implemented. Measure cold validation, heap use, and first-request latency. Consider a validated release artifact if cold work is material. | Avoid repeated validation/IO. A release artifact must include schema/content hashes and be rejected when stale. Never share private learner responses through this cache. |
| Execution queue | Measure waiting time separately from compile/run time; retain the current two-slot policy until load evidence supports another setting. | Controls burst CPU/RAM and gives learners honest queue feedback. Twenty connected learners do not imply twenty simultaneous compiler jobs. |
| Idle worker queries | Record process RSS, idle queries, and pool occupancy for every active worker before tuning polling. | Makes the actual idle footprint visible. Aggregate SQL/load measurements before changing schedules or heartbeat deadlines. |
| Upload services | If uploads are disabled, do not enable the optional upload/scanner profile. If uploads are enabled, retain the required scan boundary. | Avoids an unnecessary service. The ClamAV container has a 4 GB limit; this is not a measurement of its actual usage. |

### Conditional changes after measurements

**Connection pools:** the shared pool defaults to ten connections per process. Inspect all process pools together; actual connections are established on demand. Smaller worker pools may be appropriate, but the deployment must explicitly expose the setting, and transaction/lease requirements must be tested. Avoid exhausting PostgreSQL while maintaining headroom for administration and recovery. Do not add PgBouncer simply because the application has twenty users.

**Worker processes:** multiple Node workers can duplicate module heaps. Consider sharing startup/runtime infrastructure for ordinary jobs, but preserve the separate role and authority boundaries of mail, grading, deletion, scanning, and backup operations. Combining processes indiscriminately would widen privileges and couple failures. PostgreSQL LISTEN/NOTIFY can be a wake-up hint for noncritical jobs; retain a durable table and periodic reconciliation because notifications are not a durable queue.

**Editor:** measure Monaco's actual transfer and client memory. A basic editor option may benefit weak devices; CodeMirror is a conditional alternative if Monaco capabilities are not used. This primarily affects learner devices and network traffic, not a twentyfold multiplication of server-side editor memory.

**Execution runtime:** keep only the language packages the enabled curriculum needs, within the reviewed runtime/image process. Warm common language runtimes and cache immutable toolchain assets where the isolation design permits it. Never reuse an old accepted result as fresh official evidence merely to save execution time.

**Storage:** inventory database, object data, runtime packages/images, logs, and backup retention separately. Prune only unreferenced reviewed artifacts through explicit retention rules. Preserve reliable DB/object recovery, filesystem headroom, account erasure, and backup disclosures. Do not shrink safety data to improve a disk chart.

**AI:** keep curated lessons and deterministic games useful without providers. Reuse safe public lesson context and bounded local examples; avoid generating every game turn through an LLM. Free provider quotas and external latency are not controlled by the NUC. Mandatory progress must not require learner spending.

**Visual design:** use one restrained spacing/typography system, small reusable SVG assets, clear focus states, readable feedback, and optional short animations tied to learner actions. A heavier rendering engine does not establish a better-looking interface. Preserve text scaling, keyboard use, touch targets, reduced motion, and text equivalents while refining the artwork.

**Development/test resources:** the stable unit run spent approximately 41% of tracked time creating jsdom environments, including for server/library tests. Consider separate Node and browser test projects after classifying their actual DOM dependencies. Preserve isolation, globals cleanup, and coverage. A wholesale switch to a shared environment would be a correctness tradeoff rather than a proven optimization.

### Measure on the NUC before calling it optimized

Use the existing controlled load harness and k6 workflow on an authorized test deployment. Record idle and peak container RSS/CPU, PostgreSQL connections/query latency, web request latency, runner queue/service time, disk IO/headroom, and browser asset transfer. Test an ordinary 20-learner browsing/review session separately from a burst of simultaneous Run requests. Repeat with a cold and warm application/runtime.

Define acceptable latency and queue feedback, then change one resource setting at a time. Keep recovery and grading checks in the experiment. The cloud tests in this revision do not establish a new NUC concurrency capacity.

## Open-source tools: adopt selectively

| Tool/project | Decision | Why and limits |
| --- | --- | --- |
| Existing React + SVG | First game implementation | Already installed. Sufficient for a small discrete grid, cards, and traces. |
| Blockly, Apache-2.0 | Optional initial block interface | Useful for lowering syntax burden. Keep a deliberate transition to text and independent coding; measure its browser cost. |
| dnd-kit, MIT | Optional Parsons interaction | Use accessible reorder controls; ordinary move-up/down buttons may suffice for the first version. |
| Phaser, MIT | Later, only for richer 2D requirements | Useful game framework, but introduces unnecessary weight for the first grid prototype. |
| Hedy | Study staged syntax and beginner design | Upstream describes a gradual programming language. The current source license is EUPL-1.2. This is a separate project, not a small drop-in JavaScript dependency. |
| js-parsons, MIT | Study its task format and feedback | Upstream documents code arrangement and indentation tasks. Verify current maintenance, dependencies, accessibility, and React integration before adoption. |
| CodeCombat | Reference architecture and interaction | Code is MIT; upstream explicitly states the hosted levels are not open source. Do not assume that its levels/art/content can be imported with the code license. |
| ts-fsrs | Optional review-scheduling experiment | It can schedule retrieval; it cannot decide whether a skill was mastered or replace publication/assessment authority. Compare with the current review policy before migrating. |
| Pyodide | Optional future browser Python practice | Can move some practice computation to the learner device, but adds download/device cost and a runtime-parity question. Keep official server assessment under the existing runner. |

Official sources: [Blockly](https://github.com/google/blockly), [Phaser](https://github.com/phaserjs/phaser), [Hedy](https://github.com/hedyorg/hedy), [js-parsons](https://github.com/js-parsons/js-parsons), [CodeCombat](https://github.com/codecombat/codecombat), and [ts-fsrs](https://github.com/open-spaced-repetition/ts-fsrs). [Captured fetch index](evidence/revision-two-source-index.json) distinguishes successful reads from failed URLs. No new runtime dependency was added in this revision.

## Mail recommendation, revisited

Use Nodemailer for standards-compliant composition and Mailpit for development capture. The active code already supports Gmail dispatch, retry fencing, stable prepared content, consent/deletion handling, and uncertain external outcomes. Preserve those application guarantees.

An isolated offline test of **Nodemailer 10.0.15, MIT-0** verified MIME alternatives, Unicode header/body encoding, the supplied message ID, and a custom evidence header. Six assertions passed. No email delivery was attempted. Two independent builds produced different MIME bytes: compose once and persist the exact prepared bytes used by the sealed dispatch/retry contract.

Adopting the composer still requires a reviewed asynchronous preparation integration; the current authoritative preparation API is synchronous. A prototype showing encoded bytes does not prove compatibility with the outbox's full authority lifecycle. If SMTP is added, its provider acceptance/reconciliation behavior also needs a dedicated adapter; a Message-ID alone does not guarantee exactly-once delivery.

Mailpit should be a local/admin development tool with forwarding disabled unless deliberately configured. React Email remains optional if templates grow complicated. A full public mail server is a separate deliverability/operations decision, not a prerequisite for a free learner experience.

## Verification and remaining scope

| Check | Final result |
| --- | --- |
| Full unit suite, patched installed tree | 6,816 passed; 27 skipped; 574 test files passed and four skipped |
| Separate auth-boundary gate | 16 passed |
| Selected disposable PostgreSQL journeys | 33 passed; bootstrap/role harness also passed 86 checks |
| Selected application browser journeys | 14 passed; one mobile-only case skipped in the desktop run |
| Prototype browser checks | Eight passed across desktop and 320 px mobile widths |
| Production build and type check | Passed; existing Edge-runtime `process.exit` build warning remains |
| Lint | Zero errors; two existing warnings |
| Content validation and beginner audit | All 476 lessons/skills/banks validate; 476/476 beginner checks pass |
| Architecture, credential-canary, and encoding checks | Passed; architecture has zero violations and ten documented exceptions |
| Production dependency audit | Zero vulnerabilities after the compatible patches |
| Development-inclusive dependency audit | Five high entries in the single `braces` advisory dependency chain remain |
| Native/source-map compatibility and offline mail composition | Seven and six assertions passed respectively; no mail delivered |

Final command results are recorded in [verification](evidence/revision-two-verification.json). The verification distinguishes the initial archive-scanner failures from the subsequent fixed runs, unit tests from PostgreSQL integration, mocked provider/runner responses from live execution, and system Chromium from the pinned Playwright browser matrix.

The [Revision One archive](revision-one/README.md) remains the source for older findings. This pass fixes F11, the credential-label near-match cause of N2, and the audited production `source-map-js`/`sharp` paths. It does not claim to fix every previous runner, backup, monitoring, consent, architecture-checker, dependency, or GitHub-review issue. The full development audit still reports the `braces` advisory through the Next ESLint/fast-glob chain; the registry suggests an incompatible downgrade to eslint-config-next 14.2.35 rather than a compatible patch. Do not force that downgrade into a Next 16 project or pretend the build-tool advisory has disappeared. In particular, previously demonstrated Piston output-limit/grading and whole-job timeout discrepancies still need their own backend parity fixes before relying on those contracts. Backup/object recovery assurance remains high priority.

Some proposed risks were checked and deliberately not inflated: the current first-three-item quest content did not contain multi-answer MCQs, and the current trace quest's prompt already includes its artifact context. The radio-only UI and absent separate artifact rendering are limitations for future content, not demonstrated impossible current questions.

No production NUC load, live provider delivery, live external LLM, real R2 restore, pinned cross-browser matrix, or new learner outcome trial is claimed here. Passing automated accessibility checks does not replace manual keyboard/screen-reader testing. This is a broad, evidence-backed iteration, not a certification that every possible defect is absent.

## Fork and upstream PR workflow

The configured origin is `dik5678920-bot/Codestead`. The verified upstream Git repository is `thebrownhuman/Codestead`. Both `main` heads matched the baseline before this work. Changes are pushed explicitly to the fork's `main`; an upstream PR is a request for review and does not itself merge or modify upstream `main`.

The intended PR has base `thebrownhuman/Codestead:main` and head `dik5678920-bot/Codestead:main`. Further pushes to that head update an open PR. For future independent work, create a dedicated branch to keep unrelated changes out of the PR.

The prepared PR description is [upstream PR text](upstream-pr.md). GitHub API access was denied during this session; the final chat reports whether creation succeeded and supplies the direct comparison link if it remains blocked. Git pushes and GitHub API permissions are separate capabilities.
