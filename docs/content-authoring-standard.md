# Curriculum and Content Authoring Standard

Status: implementation baseline\
Applies to: human-authored, imported, templated, and AI-assisted curriculum content

## 1. Principle

Content may be personalized dynamically; canonical facts, executable examples, rubrics, and correct answers must be versioned and validated before learner use. “Dynamic” means selecting the next vetted unit, parameterizing an approved item template, or rephrasing within grounded constraints—not inventing a language rule live.

ID convention: every CAS requirement has acceptance ID CAS-NNN-AC1 at minimum. Multiple acceptance bullets are CAS-NNN-AC1, AC2, and so on in document order. Validation evidence shall cite requirement and acceptance IDs.

## 2. Required content package

### CAS-001 — Knowledge component definition

Every KC shall contain:

- Stable KC ID.
- Human-readable title.
- Language/runtime/version applicability.
- Shared concept and language-specific facet IDs.
- Observable “learner can…” objective.
- Required and optional prerequisites.
- Scope and explicit non-scope.
- Canonical explanation.
- At least two executable examples.
- Common misconceptions/error tags.
- Lesson fragments and remediation fragments.
- Assessment-item mappings across evidence levels.
- Primary/authoritative source links.
- Author, reviewer, version, and status.

Acceptance CAS-001-AC1: schema validation rejects missing objectives, version/source metadata, examples, misconception mappings, or assessment coverage.

### CAS-002 — Granularity

A KC shall be small enough for targeted evidence and remediation but meaningful enough to represent a capability. “Addition operator” and “subtraction operator” may be micro-checks within numeric expressions; they need not become separate full courses unless their semantics materially differ.

Acceptance IDs CAS-002-AC1 through CAS-002-AC3:

- The objective can be demonstrated by a bounded task.
- Failure can map to a specific remediation unit.
- KCs do not combine unrelated prerequisites solely for authoring convenience.

### CAS-003 — Version pinning

All language content shall declare the supported runtime/specification version. Implementation-defined, version-sensitive, preview, deprecated, and undefined behavior shall be labeled.

Preferred source roots:

- Python Language Reference: https://docs.python.org/3/reference/index.html
- Python Standard Library: https://docs.python.org/3/library/index.html
- Java Language and VM Specifications: https://docs.oracle.com/javase/specs/index.html
- C WG14 document index: https://www.open-std.org/jtc1/sc22/wg14/www/
- C++ working draft repository: https://github.com/cplusplus/draft

## 3. Lesson structure

### CAS-010 — Micro-lesson template

Every beginner micro-lesson shall support:

1. One observable objective.
2. A prediction or prior-knowledge prompt.
3. Canonical plain-English explanation.
4. Optional confirmed-interest analogy.
5. Executable worked example.
6. State trace or diagram where useful.
7. Self-explanation prompt.
8. Faded/completion example.
9. Independent near-transfer check.
10. Feedback and remediation links.
11. Delayed-review item mapping.

Advanced variants may begin with a problem and make examples optional.

Acceptance IDs CAS-010-AC1 through CAS-010-AC4:

- The lesson can render with analogies disabled.
- The canonical explanation is sufficient without the analogy.
- Worked-example code and expected output pass automated validation.
- At least one assessment removes the personalized context.

### CAS-011 — Worked examples and fading

Examples shall include:

- Problem/goal.
- Starting state/input.
- Solution steps tied to concepts, not merely line narration.
- Executable final code.
- Expected output/state.
- At least one self-explanation question.
- A corresponding faded or independent variant.

Fading sequence:

    full solution -> missing reasoning/line -> code reorder/completion
    -> independent near transfer -> independent far transfer

## 4. Analogy standard

### CAS-020 — Optional, confirmed interests

Free-text interests shall be normalized to an approved domain and shown back for confirmation before use. A learner may store several interests, switch analogy, choose neutral, or disable analogy use.

Unsafe, overly sensitive, unfamiliar, or unsupported input falls back to neutral without inventing personal facts.

### CAS-021 — Analogy schema

Every approved analogy shall contain:

    {
      "analogy_id": "function.cooking.recipe.v1",
      "target_skill_id": "shared.functions",
      "source_domain": "cooking",
      "learner_familiarity_prompt": "Are recipes and cooking steps familiar to you?",
      "mappings": [
        {"source": "recipe", "target": "function definition"},
        {"source": "ingredients", "target": "parameters"},
        {"source": "prepared dish", "target": "return value"}
      ],
      "limitations": [
        "Functions can be called repeatedly or recursively.",
        "Some functions return no useful value.",
        "Changing external program state is a side effect, not an ingredient."
      ],
      "canonical_bridge": "A function is a named reusable computation...",
      "review_status": "approved"
    }

### CAS-022 — Analogy controls

- Canonical terms appear beside or immediately after the analogy.
- “Where this analogy breaks” is mandatory.
- Assessments progressively remove the analogy.
- The same analogy shall not hide language-specific differences.
- No demographic, cultural, or hobby stereotype may be inferred.
- An analogy cannot introduce a claim absent from the canonical content.
- At least one neutral example exists for every objective.

Acceptance CAS-022-AC1: disabling analogy leaves a complete, coherent lesson and no broken assessment references.

Interest-based contexts have shown benefits in some learning settings, particularly for struggling learners, but this is not direct proof for every programming topic: https://doi.org/10.1037/a0031882. Comparing examples can help learners abstract a transferable schema: https://doi.org/10.1037/0022-0663.95.2.393.

## 5. Examples and code

### CAS-030 — Executable examples

Every displayed code sample shall declare:

- Language/runtime.
- Complete versus intentionally partial status.
- Input assumptions.
- Expected output or state trace.
- Compile/run command used in validation.
- Timeout/resource class.

Acceptance IDs CAS-030-AC1 through CAS-030-AC4:

- Complete samples compile/run successfully.
- Intentionally invalid examples fail with the expected diagnostic class.
- Output is compared using an explicit normalization/tolerance policy.
- Examples do not use network, secrets, filesystem access, or nondeterminism unless those are the stated objective and sandboxed.

### CAS-031 — Multiple valid solutions

Authoring shall distinguish:

- Behavioral specification.
- Required technique constraints.
- Style guidance.
- Performance constraints.

A solution that meets the behavioral specification shall not be rejected for differing from the reference implementation unless the prompt explicitly requires a technique or complexity bound.

Each code item should include:

- One canonical reference.
- At least one structurally different accepted solution where feasible.
- Known misconception solutions expected to fail.
- Visible examples.
- Hidden boundary/edge tests.
- Property tests where appropriate.

### CAS-031A — Web authoring verifier boundary

Web artifacts use one of two explicit runtime engines:

- `isolated-runner` is the production-shaped, digest-pinned runner for bounded standard-input/standard-output JavaScript tasks.
- `browser-verifier` is an authoring-only HTML/CSS/JavaScript/React reference checker using an exact Playwright/browser revision. It must never be sent to the official untrusted-code runner or selected for a formal exam.

Browser test contracts encode viewport and preference state, bounded user actions, and trusted observable assertions. External networking is denied; exact response fixtures are fulfilled in memory. Selected items add axe serious/critical checks, but automation never substitutes for keyboard, screen-reader, zoom/reflow, contrast-mode, touch, or human semantic review. React bundling and any router/test dependencies must be version-pinned and recorded. A browser item remains `examEligibility.eligible: false` until a production browser-artifact isolation design, independent human review, and publication gate all succeed.

A `browser-project-v1` reference may contain multiple relative files only when every normalized path stays inside the temporary artifact root, application and test entrypoints resolve inside the manifest, scripts and dependencies are exact-version pinned, imports are allowlisted, external networking remains denied, and the verifier deletes the materialized tree after each bundle. Passing the app and Testing Library entrypoints proves only the declared bounded journeys. It does not prove that Vite dev/build/preview commands ran, that arbitrary learner projects are safely isolated, or that a human approved the project as portfolio quality.

### CAS-032 — Visual traces

Traceable examples shall define expected events for:

- Current source line.
- Stack frame/function.
- Locals/globals.
- Heap/object/reference changes where relevant.
- Input/output.
- Return/exception.

Undefined or implementation-dependent C/C++ behavior shall stop or warn rather than display a falsely authoritative trace.

## 6. Assessment-item standard

### CAS-040 — Item schema

An item shall include:

- Stable item and version ID.
- Prompt and declared constraints.
- Language/runtime.
- KC-to-rubric mapping.
- Evidence level E1–E6.
- Difficulty band and intended learner state.
- Variant/template parameters and seed rules.
- Correct answer/reference solution.
- Accepted alternatives or behavioral oracle.
- Misconception distractors/known wrong solutions.
- Hint ladder.
- Feedback for correct and common incorrect responses.
- Visible and hidden tests.
- Estimated duration.
- Exam eligibility flag.

### CAS-041 — Distractors and feedback

Multiple-choice distractors shall correspond to documented misconceptions, not arbitrary confusion. Feedback shall explicitly correct selected false alternatives.

### CAS-042 — Variant equivalence

Parameterization shall preserve:

- Target KCs.
- Required reasoning steps.
- Intended difficulty range.
- Time expectation.
- Test coverage and scoring totals.

Acceptance CAS-042-AC1: generated variants are statically validated and sample-executed before entering an exam pool.

## 7. Misconception and remediation authoring

### CAS-050 — Misconception record

Each misconception shall define:

- Observable error patterns.
- Concepts it may be confused with.
- A confirming probe distinct from the triggering item.
- Correct mental model.
- Alternate representation, such as diagram or trace.
- Worked remediation example.
- Near-transfer retry.
- Far-transfer/delayed item.

### CAS-051 — Hint ladder content

Every independent coding item shall support, where applicable:

1. Goal/behavior restatement.
2. Conceptual cue.
3. State, variable, line, or failing behavior category.
4. Strategy/pseudocode.
5. Partial code.
6. Full worked solution and explanation.

Hints must not accidentally reveal hidden tests, secrets, or the final code before their declared level.

## 8. Content validation pipeline

### CAS-060 — Status lifecycle

    DRAFT -> SOURCE_REVIEWED -> TECH_VALIDATED
      -> PEDAGOGY_REVIEWED -> APPROVED -> PUBLISHED
      -> DEPRECATED/RETIRED

AI-generated or AI-modified canonical content begins at DRAFT. It cannot self-approve.

### CAS-061 — Automated gates

Required automated checks:

- Schema and stable-ID validation.
- Dependency graph is acyclic or has an explicitly supported loop.
- Source URLs and version fields present.
- All complete examples compile/run in pinned environments.
- Reference and accepted-alternative solutions pass.
- Known wrong solutions fail relevant tests.
- Test and score totals reconcile.
- Variant generation remains within declared constraints.
- No hidden solution/test is included in learner-visible payloads.
- No secrets or unsupported network/filesystem operations.
- Accessibility lint for headings, labels, keyboard flow, and diagram alternatives.

### CAS-062 — Human gates

A reviewer verifies:

- Factual alignment with cited specifications.
- Objective, explanation, examples, practice, and rubric alignment.
- Beginner readability and buddy tone without condescension.
- Analogy mapping and explicit limitations.
- Misconception feedback does not reinforce the misconception.
- No single “magic” implementation is treated as the only correct answer.
- Cultural and accessibility review.
- Exam difficulty/coverage equivalence.

### CAS-063 — Change control

Material changes to semantics, prompt constraints, answers, tests, rubric, or runtime create a new content version. Published attempts retain their original version references.

A corrected defect triggers:

- Regression test.
- Affected-attempt search.
- Deterministic rejudging where outcomes may change.
- Learner notification for material changes.

## 9. Implementation-ready example

    skill_id: java.variables.assignment
    runtime: java-21
    objective: "Given a short Java program, declare, initialize, and reassign an int variable and predict its value."
    prerequisites:
      - shared.numeric_literals
    canonical_definition: "Assignment stores the evaluated right-hand value in the variable named on the left."
    analogy_ids:
      - variable.cooking.labeled_container.v1
    analogy_limit: "The container model becomes incomplete for object references and aliasing."
    examples:
      - id: java.variables.assignment.ex1
        code: "int servings = 2; servings = 4;"
        expected_state:
          servings: 4
    misconceptions:
      - assignment_is_permanent
      - assignment_equals_comparison
    qualifying_items:
      - java.variables.assignment.trace.v2
      - java.variables.assignment.code.v4
    delayed_items:
      - java.variables.assignment.transfer.v1
    sources:
      - https://docs.oracle.com/javase/specs/

## 10. Implemented authored-content contract

The executable baseline lives in:

- `content/schema/authored-lesson.schema.json` and `src/lib/content/authored-schema.ts` for complete lesson records.
- `content/schema/assessment-bank.schema.json` and `src/lib/content/authored-types.ts` for deterministic MCQ, trace, fill-gap, and code items.
- `content/authored/` for versioned entries. Programming Foundations, Git/tooling, C, C++, Java, Python, HTML, CSS, JavaScript, React, and DSA now have one lesson/bank record per declared skill. All remain `draft`, declare AI assistance, have no reviewer, and are not formal-exam eligible. At this tranche boundary, 428 of 476 skills have complete draft records; the 48 AI-track skills still require them.

`npm run content:validate` applies JSON Schema, semantic validation, and atomic-skill/source/version mapping. Learner assessment projection removes answers, rubrics, feedback, private notes, and hidden tests. A formal exam receives deterministic grading evidence only when both the bank and item are explicitly exam eligible and the bank has an attributable human reviewer in `approved` or `published` state; all other skills remain `pending-review`.

## 11. Evidence base

- Self-explanation research: https://doi.org/10.1207/s15516709cog1302_1
- Faded worked examples and metacognitive scaffolding in programming: https://doi.org/10.1177/07356331231174454
- Worked examples in introductory programming: https://doi.org/10.22369/issn.2153-4136/6/1/1
- Adaptive Parsons scaffolding: https://doi.org/10.1145/3501385.3543977
- Corrective feedback and false multiple-choice knowledge: https://pubmed.ncbi.nlm.nih.gov/18491500/
- NIST guidance on grounding, provenance, testing, and citation verification: https://doi.org/10.6028/NIST.AI.600-1
