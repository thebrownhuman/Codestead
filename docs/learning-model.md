# Adaptive Learning Model

Status: implementation baseline\
Audience: product, curriculum, backend, frontend, QA, and mentor/admin teams

## 1. Purpose

This document defines how the platform places a learner, selects the next activity, records evidence, responds to errors, schedules review, and distinguishes lesson completion from durable mastery. It is designed for a closed cohort of at most ten learners, so the first release uses transparent rules and expert-set parameters rather than training a data-hungry recommendation model.

The curriculum is a versioned prerequisite graph. The AI may personalize wording and propose explanations, but the learning engine owns state transitions and the deterministic assessment system owns correctness.

ID convention: every LM requirement has acceptance ID LM-NNN-AC1 at minimum. Where an acceptance block contains multiple bullets, the bullets are LM-NNN-AC1, AC2, and so on in document order. QA evidence shall cite both the requirement and acceptance ID.

## 2. Core requirements

### LM-001 — Atomic knowledge graph

Every course shall be decomposed into atomic knowledge components (KCs). Each KC shall define prerequisites, language applicability, learning objectives, common misconceptions, assessment mappings, and versioned sources.

Acceptance IDs LM-001-AC1 through LM-001-AC3:

- A learner cannot be assigned a new KC whose required prerequisites are below the configured readiness state.
- A multi-skill exercise updates only KCs for which its rubric produces observable evidence.
- Shared concepts and language-specific facets are distinct. Python loop knowledge may seed a Java loop diagnostic, but cannot waive Java-specific evidence.

### LM-002 — Distinct progress states

The system shall use these states:

    UNSEEN
      -> DIAGNOSTIC
      -> LEARNING
      -> GUIDED_PRACTICE
      -> INDEPENDENT_PRACTICE
      -> EXAM_READY
      -> PASSED
      -> MASTERED
      -> REVIEW_DUE

Any active state may transition to REMEDIATION. MASTERED is an earned state; later forgetting creates REVIEW_DUE rather than deleting the achievement.

Acceptance IDs LM-002-AC1 through LM-002-AC4:

- Completing a lesson or game never directly creates PASSED or MASTERED.
- PASSED requires the formal assessment policy.
- MASTERED requires the formal mastery threshold and every critical-skill gate.
- State changes persist an explanation, triggering evidence IDs, policy version, actor, and timestamp.

### LM-003 — Evidence hierarchy

Evidence shall be classified as:

| Level | Evidence | Positive mastery use |
|---|---|---|
| E0 | Viewed explanation/video-equivalent text/diagram | None |
| E1 | Recognition or multiple choice | Supporting only |
| E2 | Recall, predict output, or trace state | Supporting |
| E3 | Completion, reorder/Parsons, or guided debugging | Provisional; assistance-sensitive |
| E4 | Independent implementation/application | Required for independent proficiency |
| E5 | Transfer, edge case, explanation, or debugging in a new context | Required for critical concepts |
| E6 | Delayed unassisted retrieval/application | Required before durable mastery eligibility |

Acceptance IDs LM-003-AC1 through LM-003-AC4:

- No KC becomes independently proficient from E0–E2 alone.
- Revealed solutions provide no positive assessment evidence.
- Hinted success records learning activity but cannot satisfy an unassisted gate.
- Confidence is stored for calibration and misconception prioritization, never treated as proof of correctness.

### LM-004 — Assistance accounting

Each attempt shall record assistance level:

| Level | Meaning | Mastery treatment |
|---|---|---|
| A0 | No hint, reveal, visualizer, or solution feedback | Qualifying |
| A1 | Conceptual cue | Learning evidence; non-qualifying by default |
| A2 | State/line/strategy cue | Non-qualifying |
| A3 | Pseudocode or partial code | Non-qualifying |
| A4 | Full solution or answer reveal | No positive assessment evidence |

An A1–A4 success shall be followed by a fresh equivalent A0 item before independent progress is inferred.

### LM-005 — Probabilistic signal with hard evidence gates

The engine may maintain a Bayesian Knowledge Tracing (BKT) probability per learner and KC. It is a scheduling signal, not the sole authority for mastery.

For an observed correct response:

    posterior = P(L) * (1 - slip)
                / (P(L) * (1 - slip) + (1 - P(L)) * guess)

For an observed incorrect response:

    posterior = P(L) * slip
                / (P(L) * slip + (1 - P(L)) * (1 - guess))

After a genuine learning opportunity:

    P(L next) = posterior + (1 - posterior) * learn

Initial implementation defaults are configurable and must be labeled as heuristics:

- BKT below 0.75: explanation/worked-example mode.
- 0.75–0.89: faded examples and independent practice.
- 0.90 or higher: eligible for an independent check.
- Guess probability varies by format; it shall not be identical for four-option MCQ and free-form code.
- A hinted success may apply a learning transition but is not recorded as an unassisted correct observation.

Acceptance IDs LM-005-AC1 through LM-005-AC4:

- Hard evidence gates can prevent mastery even when BKT exceeds 0.90.
- One wrong response is treated as a possible slip and triggers a confirming probe before demotion.
- Parameters and thresholds are policy-versioned and inspectable by an admin.
- The system does not fit learner-model parameters from the ten-person cohort without an explicit research review.

### LM-006 — Independent and durable readiness

EXAM_READY requires, per critical KC:

- At least two different A0 application attempts at E3 or higher.
- At least one A0 E4 implementation or equivalent constructed response.
- No solution reveal on the qualifying attempts.
- Confirmed remediation of any blocking misconception.

Formal PASSED and MASTERED rules are defined in assessment-policy.md. A mastery badge does not derive from BKT alone.

## 3. Diagnostic placement

### LM-010 — Onboarding profile

The learner profile shall collect:

- Name/display name.
- Chosen language and goal.
- Self-described experience by language and topic.
- Minutes available per session/week.
- English/readability preference and accessibility needs.
- Optional free-text hobbies/interests, normalized and confirmed before use.
- Preferred plain/analogy explanation setting.

Self-labels such as beginner, intermediate, and advanced choose the first diagnostic branch only.

### LM-011 — Short, low-stakes diagnostic

The initial diagnostic shall be ungraded and target 10–15 minutes. It shall combine:

- Code reading/output prediction.
- State tracing.
- Bug finding.
- Code completion or reorder.
- One small independent implementation for non-beginners.
- Targeted probes for skills the learner claims to know.

Branching rule:

- Two clean A0 successes on distinct evidence types may skip a prerequisite into EXAM_READY or the next diagnostic node.
- Conflicting evidence triggers a third probe.
- Claimed advanced knowledge requires explanation/trace, debugging, and implementation evidence; one MCQ cannot skip a topic.
- The learner may choose “teach me anyway” or “challenge this topic.”

Acceptance IDs LM-011-AC1 through LM-011-AC3:

- Diagnostic failure has no public score, XP loss, or leaderboard consequence.
- The generated plan lists why each starting topic was selected.
- Diagnostic items use the same pinned language/runtime version as instruction.

### LM-012 — Example: linked-list claim

A learner who claims strong linked-list knowledge receives:

1. Explain a head/tail or node-link invariant.
2. Trace insert/delete mutations.
3. Debug an empty/single-node/tail edge case.
4. Implement one operation without hints.

Failure on tail deletion opens only the relevant pointer/reference and invariant subskills unless broader evidence also fails.

## 4. Next-activity policy

### LM-020 — Priority order

At session start, the engine shall choose in this order:

1. Confirmed blocking misconception or active remediation.
2. Overdue review of a prerequisite used by the current goal.
3. The current goal’s weakest ready KC.
4. A new KC whose prerequisites are ready.
5. An optional challenge, project, or replay.

Within a normal session, due reviews should occupy about 30–40% at most unless the learner explicitly chooses review-only mode.

### LM-021 — Difficulty and activity selection

| Learner evidence | Default activity |
|---|---|
| No evidence / BKT under 0.55 | Canonical explanation and full worked example |
| Emerging / roughly 0.55–0.74 | Self-explanation, trace, and guided completion |
| Developing / roughly 0.75–0.89 | Faded example, Parsons/reorder, debugging |
| Ready check / 0.90+ without gates | Independent implementation and transfer |
| Repeated misconception | Alternate representation and targeted remediation |
| Mastered but due | Short mixed retrieval/application |

Activity selection shall not repeatedly serve an identical memorized item as new evidence.

### LM-022 — Session composition

A default 15–25 minute beginner session contains:

1. One low-stakes due review or warm-up.
2. One atomic objective.
3. Canonical explanation plus optional confirmed analogy.
4. Executable worked example.
5. Self-explanation/prediction.
6. Guided or faded practice.
7. One independent check.
8. Exit summary and next-review date.

For advanced learners, examples fade and problem-first activities become the default.

## 5. Error handling and remediation

### LM-030 — Error taxonomy

Attempts may attach one or more versioned misconception/error tags:

- Syntax/compiler usage.
- State tracing or mental-model error.
- Type/conversion error.
- Operator precedence.
- Control flow.
- Scope/lifetime.
- Reference/aliasing/pointer behavior.
- API/library misuse.
- Algorithm/invariant.
- Edge case.
- Complexity/performance.
- Accidental slip.

### LM-031 — Confirmation before remediation

- One incorrect response triggers explanatory feedback and a distinct confirming probe.
- Two independent items supporting the same misconception activate targeted remediation.
- A high-confidence wrong answer receives higher confirmation priority.
- Correct low-confidence evidence triggers one additional retrieval check rather than punishment.

### LM-032 — Hint ladder

The hint ladder is:

1. Restate goal and observed behavior.
2. Conceptual cue.
3. Identify relevant state, variable, line, or failed behavior category.
4. Strategy or pseudocode.
5. Partial code.
6. Full worked solution.

After level 6, the learner must self-explain the solution and solve a fresh isomorphic task. The solved/revealed item cannot establish mastery.

## 6. Review scheduling

### LM-040 — Initial schedule

The starting schedule is:

    later in the same session -> 1 day -> 3 days -> 7 days
    -> 14 days -> 30 days -> adaptive expansion

This is a product heuristic, not a universal optimum.

### LM-041 — Review update rules

- Clean A0 success: expand the interval.
- Correct with assistance: retain or only modestly expand.
- Confirmed failure: targeted remediation, then return near one day.
- Interleave already introduced skills; do not interleave several entirely new, easily confused constructs before initial acquisition.
- Prioritize by overdue risk, prerequisite centrality, active goal relevance, and repeated-error history.
- A later review failure creates REVIEW_DUE; it does not erase an earned badge.

Acceptance IDs LM-041-AC1 through LM-041-AC3:

- Review due dates are deterministic from stored evidence and policy version.
- Learners can see why a review was selected.
- Changing the scheduling policy does not silently rewrite historical evidence.

## 7. Cross-language transfer

### LM-050 — Shared concept and language facets

Each skill may have:

- A shared concept KC, such as iteration or function decomposition.
- Syntax KCs per language.
- Semantics KCs per language, such as Java reference behavior, Python name binding, or C pointer lifetime.
- Tooling KCs, such as compiler messages and test execution.

Prior mastery may raise the initial diagnostic prior for a related language, but language-specific gates remain mandatory.

## 8. Minimum data contract

An implementation-equivalent SkillState shall contain:

    {
      "learner_id": "u_123",
      "skill_id": "java.variables.assignment",
      "curriculum_version": "java-21-v1",
      "state": "INDEPENDENT_PRACTICE",
      "bkt_probability": 0.86,
      "qualifying_evidence_ids": ["att_81", "att_93"],
      "active_misconceptions": ["java.assignment_vs_comparison"],
      "last_unassisted_at": "2026-07-12T10:00:00Z",
      "next_review_at": "2026-07-15T10:00:00Z",
      "review_interval_days": 3,
      "policy_version": "lm-1"
    }

Every state transition shall produce an append-only event.

## 9. Implementation example

A beginner selects Java and confirms cooking as an interest.

- Diagnostic shows arithmetic knowledge but confusion between initialization and reassignment.
- The lesson defines assignment canonically and optionally maps variables to labeled preparation containers, explicitly warning that the model breaks for object references.
- The learner predicts output, explains reassignment, and completes a faded example.
- A cooking-themed quantity task is solved after a line-level hint: the game may advance, but mastery evidence remains assisted.
- A fresh neutral A0 implementation supplies E4 evidence.
- The next-day neutral trace supplies E6 evidence.
- The topic becomes exam-ready; only the formal exam can create PASSED or MASTERED.

## 10. Evidence base

- Benjamin Bloom, Learning for Mastery: https://eric.ed.gov/?id=ED053419
- Roediger and Karpicke, retrieval practice and delayed retention: https://pubmed.ncbi.nlm.nih.gov/16507066/
- Cepeda et al., spacing interval and retention horizon: https://pubmed.ncbi.nlm.nih.gov/19076480/
- Pavlik and Anderson, adaptive practice scheduling: https://pubmed.ncbi.nlm.nih.gov/18590367/
- Corbett and Anderson, Knowledge Tracing: https://doi.org/10.1007/BF01099821
- Kalyuga et al., expertise-reversal effect: https://doi.org/10.1207/S15326985EP3801_4
- Chi et al., self-explanation from worked examples: https://doi.org/10.1207/s15516709cog1302_1
- U.S. IES practice guide on spacing, worked examples, and quizzing: https://ies.ed.gov/ncee/wwc/PracticeGuide/1
