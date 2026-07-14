# Beginner curriculum quality audit

**Audit date:** 2026-07-14\
**Contract:** `beginner-quality/1.0.0`\
**Scope:** all 476 authored lessons in the 12 Launch 1 courses\
**Publication effect:** none. Every lesson and assessment bank remains an AI-assisted, unreviewed draft.

## Outcome

The deterministic beginner-quality gate now passes all 476 authored lessons. The refresh added a plain starting point, an explicit prerequisite recap, a short guided check, and an actual next-skill transfer while preserving the existing source-linked technical statements, declared exclusions, draft stage, AI-assistance flag, and null reviewer.

This is a structural and semantic floor, not an editorial approval. Passing it means the required learning moves are present and lesson-specific; it does not prove that every explanation is the best possible explanation, that every example is culturally appropriate, or that a human has verified the underlying source claim.

## Contract measured by `content:validate`

| Learning need | Deterministic evidence required |
|---|---|
| Plain opening | A `Start here` section uses lesson-specific case and outcome language, stays bounded in length, and avoids a very long sentence. |
| Prerequisite orientation | A `Before you begin` section names every declared direct prerequisite, or states the course's assumed knowledge when no direct prerequisite exists. Duplicate labels are collapsed. |
| Mental model | A lesson-specific operational-model/rule/invariant section overlaps the canonical source claim and outcome instead of giving generic study advice. |
| Tiny concrete example | Every example has a concrete situation, at least three distinct steps, and an observable result. Coding runtimes additionally require both a code/data/markup/state-shaped artifact and an observable operation. |
| Worked trace | Trace steps are sequential, each explains the state change or decision, and the text alternative names every real focus plus the corresponding state/explanation. A generic instruction to “follow the trace” fails. |
| Misconception repair | At least one plausible mistaken belief is contrasted with a distinct explanatory correction. |
| Guided practice/check | The first check is short, scaffolded, names an actual worked example, and expects evidence containing that same example's situation and result. A prompt and answer key from different scenarios fail. |
| Retrieval and transfer | The recap states the outcome and boundary, contains at least two retrieval prompts, and names the actual next skill or the module checkpoint. |
| Anti-template safeguards | Long canonical rules cannot be pasted through three or more learner-facing blocks, and canonical sections are density-bounded. |

The gate deliberately combines bounded length checks with lesson-specific semantic checks. Word counts alone cannot satisfy the mental-model, prerequisite, example, misconception, or next-step rules.

## Exact before audit

The recorded baseline, taken before rewriting the lesson files, was:

- lessons audited: **476**
- passing: **0**
- failing: **476**
- `opening-missing`: **476**
- `prerequisite-recap-missing`: **476**
- `next-step-missing`: **476**
- `canonical-rule-repeated`: **474**
- `coding-example-not-concrete`: **16**
- `common-mistake-missing`: **1**

The final contract's mental-model rule was added while the rewrite was being built. The original source-seed structure already contained course-specific operational-model/rule/invariant sections, so that new rule did not require inventing or importing a technical claim.

| Course | Lessons failing before |
|---|---:|
| AI | 48 |
| C | 36 |
| C++ | 40 |
| CSS | 32 |
| DSA | 60 |
| Git tooling | 36 |
| HTML | 32 |
| Java | 40 |
| JavaScript | 40 |
| Programming foundations | 32 |
| Python | 40 |
| React | 40 |
| **Total** | **476** |

## Cross-field defect found and corrected

The first structural pass exposed an important limitation in its own audit. In `pf.state.variables`, the refreshed prompt said “worked example above,” the visible example was **Wallet balance update**, but the retained answer key described unrelated price values and a discount name. The same pass had also replaced each detailed trace alternative with a generic instruction to follow the visual trace.

The lesson was not patched by hand. Two cross-field rules were added to the shared contract and generator:

- `practice-example-mismatch` requires the prompt to name the actual first worked example and requires its hidden expected evidence to contain that example's real situation and result;
- `trace-text-alternative-mismatch` requires the alternative to name every actual trace-step focus and communicate the corresponding stored state/explanation.

Before the second regeneration, the expanded audit produced this exact result:

- lessons audited: **476**
- passing: **0**
- failing: **476**
- `practice-example-mismatch`: **476**
- `trace-text-alternative-mismatch`: **476**

After deterministic regeneration, `pf.state.variables` now asks about **Wallet balance update**, its expected evidence contains the wallet situation and the successive values 500, 380, and 430, and its trace alternative describes the separate four-step `tickets` state trace instead of pretending that the visual is self-explanatory.

## Exact after audit

`npm run content:beginner-audit -- --json --fail-on-issues` reports:

- lessons audited: **476**
- passing: **476**
- failing: **0**
- issue occurrences: **0**
- courses with a failing lesson: **0**

`npm run content:beginner-refresh` immediately after the applied refresh reports **0/476** files would change. That is the idempotency check for the generated structure.

Seven cross-domain samples were then checked directly, in addition to the all-file audit:

| Sample | Named-example prompt | Expected evidence contains exact situation and result | Text alternative covers every trace focus |
|---|---:|---:|---:|
| C pointers — `c.pointers.address` | Yes | Yes | Yes (3 steps) |
| Python loops — `python.control.iteration` | Yes | Yes | Yes (3 steps) |
| Java OOP — `java.objects.class` | Yes | Yes | Yes (3 steps) |
| JavaScript async — `javascript.async.promises` | Yes | Yes | Yes (3 steps) |
| React state — `react.state.use-state` | Yes | Yes | Yes (3 steps) |
| DSA graph traversal — `dsa.graphs.bfs-dfs` | Yes | Yes | Yes (4 steps) |
| AI retrieval augmentation — `ai.generative.embeddings-rag` | Yes | Yes | Yes (3 steps) |

The authored inventory after the rewrite is:

- **476** lessons and **952** worked examples;
- **476** assessment banks and **1,386** assessment items;
- **476** MCQ items and **500** code items;
- **476/476** lessons still at `stage: draft`, AI-assisted, with no reviewer;
- **476/476** assessment banks still at `stage: draft`, with no reviewer;
- **0** exam-eligible items.

## Safeguards applied during regeneration

The refresh script refuses to touch a lesson that is reviewed, non-draft, or not marked AI-assisted. For every changed lesson it verifies that these values are byte-for-byte equivalent at the data level before and after transformation:

- source references, locators, and claims;
- declared `scope.excludes` technical boundaries;
- canonical explanation summary;
- publication stage;
- AI-assistance flag;
- reviewer state.

All six authored-content generators now call the same beginner-quality template, so later regeneration cannot silently restore the old dense structure. The generators still derive content only from the existing course manifests and source-linked teaching seeds.

## Human editorial work still required

Before any lesson or assessment is published, independent humans still need to complete all of the following:

1. Verify every source locator and technical claim against the named authoritative source and its stated version/date.
2. Review every lesson for technical accuracy, beginner pedagogy, accessibility, cultural clarity, and course-to-course consistency.
3. Read every worked example as a learner would; replace repetitive or unnatural situations while preserving the source boundary and deterministic trace.
4. Compile/run and inspect each applicable code task in the pinned runtime, including visible and hidden tests, error paths, and explanation quality.
5. Review assessment equivalence, distractors, rubrics, hints, and misconceptions before setting any item exam-eligible.
6. Confirm prerequisite order and next-skill transitions with the complete course journey, not only a single lesson file.
7. Manually check rendered lesson pages at keyboard-only, reduced-motion, high-contrast, 200% zoom, narrow mobile, tablet, and desktop sizes.
8. Commission a separate research/editorial pass for new examples, diagrams, hobby analogies, and current ecosystem guidance. This deterministic refresh introduced no external market-demand claim, live-provider output, or unsupported technical fact.

Until that work is complete, the truthful learner-facing status remains **AI-assisted draft / no human editorial review yet**. A passing beginner-quality audit must never be used as a substitute for publication approval.

## Reproduction commands

```powershell
npm run content:beginner-audit -- --json --fail-on-issues
npm run content:beginner-refresh
npm run content:validate
npm run typecheck
```
