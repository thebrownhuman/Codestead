# AI and Automated Evaluation Plan

Status: implementation baseline\
Scope: tutor generation, code feedback, knowledge-state recommendations, content generation, exam-integrity flags, and operational monitoring

ID convention: every AEP requirement has acceptance ID AEP-NNN-AC1 at minimum. Multiple acceptance bullets are AEP-NNN-AC1, AC2, and so on in document order. Evaluation reports shall cite both IDs.

## 1. Responsibility boundary

### AEP-001 — Deterministic authority

Deterministic or human-reviewed systems own:

- Curriculum graph and prerequisites.
- Published canonical facts and sources.
- Exact item prompts, constraints, rubrics, and test suites.
- Compilation, execution, and code-test results.
- Server time, autosaves, score arithmetic, pass thresholds, and badge issuance.
- Learning-state transitions under versioned rules.
- Appeal and integrity decisions.
- Admin overrides and audit history.

Acceptance AEP-001-AC1: disabling every AI provider still permits login-independent course browsing where allowed, practice against existing items, code judging, exam timing/grading, badge calculation, appeals submission, and admin review.

### AEP-002 — Permitted AI roles

AI may:

- Rephrase a vetted explanation to the learner’s reading level and buddy tone.
- Select or instantiate an approved analogy structure.
- Ask Socratic questions and generate policy-bounded hints.
- Summarize deterministic compiler/test evidence.
- Suggest a misconception tag with confidence.
- Recommend a next activity to the deterministic policy engine.
- Draft content/items for review.
- Produce a non-binding analysis of alternative code.
- Flag integrity events for human review.

AI output is always labeled by provenance internally, and high-impact decisions require deterministic gates or human approval.

### AEP-003 — Prohibited AI authority

AI shall not:

- Mark code correct contrary to the judge.
- Reject behaviorally correct alternative code because it differs from a reference.
- Create or modify a formal exam after its session begins.
- Award, revoke, or silently alter mastery.
- Decide cheating, punishment, access, accommodations, or appeals.
- Invent citations, language behavior, runtime results, or hidden tests.
- Treat learner confidence or self-description as demonstrated knowledge.

## 2. Grounded tutor pipeline

### AEP-010 — Retrieval and context

Tutor generation shall receive:

- Learner-visible profile fields needed for personalization.
- Current KC, objective, state, and assistance level.
- Versioned canonical content and authoritative source metadata.
- Approved analogy mapping if enabled.
- Deterministic attempt/compiler/test evidence.
- Allowed response action, such as explain, hint level 2, or summarize.

It shall not receive API secrets, unrelated learner records, hidden exam tests, or admin-only integrity notes.

### AEP-011 — Structured output

An implementation-equivalent tutor result shall be:

    {
      "action": "HINT",
      "skill_ids": ["java.variables.assignment"],
      "hint_level": 2,
      "message": "Look at which side of = is evaluated first...",
      "claims": [
        {
          "claim": "Java evaluates the right-hand expression before assignment.",
          "source_id": "jls-se21-assignment"
        }
      ],
      "analogy_id": null,
      "misconception_suggestion": {
        "tag": "assignment_equals_comparison",
        "confidence": 0.71
      },
      "uncertainty": [],
      "solution_leak": false
    }

Schema-invalid, ungrounded, out-of-level, or solution-leaking output is rejected or replaced by deterministic fallback content.

### AEP-012 — Uncertainty behavior

If the retrieved content does not support a factual claim, the tutor shall avoid the claim and state that it cannot verify it. It shall never fabricate a source.

## 3. Code evaluation

### AEP-020 — Judge pipeline

The authoritative sequence is:

1. Validate language/runtime and submission envelope.
2. Compile/parse in an isolated pinned environment.
3. Run visible/public tests.
4. Run hidden boundary and misconception-specific tests.
5. Run property/randomized tests where approved.
6. Run static/style/performance checks only when rubric-relevant.
7. Calculate deterministic criterion scores.
8. Provide the result evidence to AI for optional explanation.

AI never executes code mentally as the final oracle.

### AEP-021 — AI feedback constraints

AI code feedback shall:

- Cite the compiler diagnostic, failing behavior category, rubric criterion, or visible test evidence it explains.
- Avoid exposing a hidden input/expected output.
- Follow the configured hint level.
- Distinguish verified fact from likely diagnosis.
- Prefer the smallest useful cue over a full solution.
- Offer a fresh retry after a reveal.

Acceptance IDs AEP-021-AC1 through AEP-021-AC3:

- A hidden-test redaction suite finds no secret values in feedback.
- A hint-leak suite verifies levels 1–4 do not contain a complete target solution.
- Known valid alternative solutions are not described as wrong.

### AEP-022 — Alternative code and appeals

When a learner selects “My code is also correct,” AI may compare code with the behavioral specification and deterministic results. Its report is advisory and includes:

- Claimed equivalence.
- Relevant explicit constraints.
- Failing/passing evidence.
- Possible missing tests/spec ambiguity.
- Confidence and reasons.

Admin resolves the appeal under assessment-policy.md. Accepted defects become regression cases.

## 4. Content generation and validation

### AEP-030 — Draft-only generation

AI-generated lessons, examples, analogies, questions, tests, rubrics, and reference solutions enter DRAFT. They do not become learner-visible canonical content until the automated and human gates in content-authoring-standard.md pass.

### AEP-031 — Generation provenance

Store:

- Model/provider/version.
- System and task prompt versions.
- Retrieved source/content IDs and versions.
- Input policy state.
- Raw structured output.
- Validator outcomes.
- Reviewer/action.
- Published content/version, if any.

### AEP-032 — Generated code validation

All generated complete code shall compile/run in the target pinned environment. Reference solutions must pass; known wrong solutions must fail; test suites must be inspected for overfitting and hidden-answer leakage.

## 5. Evaluation program

### AEP-040 — Golden evaluation sets

Maintain versioned, access-controlled datasets:

1. Factuality: language semantics and library behavior grounded in official sources.
2. Pedagogy: explanation clarity by beginner/intermediate/advanced state.
3. Hint discipline: six hint levels and solution-leak traps.
4. Misconceptions: labeled novice errors with acceptable diagnoses.
5. Code feedback: compiler/runtime/test cases and valid alternatives.
6. Analogy: approved mappings, limitations, and unsafe/unfamiliar interests.
7. Prompt injection: instructions embedded in learner text, code comments, strings, and compiler output.
8. Privacy: attempts to expose another learner, hidden tests, admin notes, or secrets.
9. Integrity review: benign and suspicious event patterns with a required “human review” outcome.
10. Fairness/accessibility: names, dialects, verbosity preferences, and accommodations that must not change correctness decisions.

Golden sets must include C, C++, Java, and Python for every released capability.

### AEP-041 — Offline metrics

Measure:

- Grounded factual claim precision.
- Citation/source-ID validity.
- Executable-code pass rate.
- Correct handling of valid alternative solutions.
- Misconception classification precision/recall, with abstention.
- Hint-level adherence and full-solution leakage.
- Hidden-test leakage.
- Unsupported certainty rate.
- Structured-output validity.
- Harmful/bias/privacy/security policy violations.
- Deterministic-result contradiction rate.
- Human reviewer usefulness rating.

### AEP-042 — Initial release gates

Before learner-facing release, the evaluated configuration shall meet:

- 100% structured-output validity after retry/fallback.
- 100% citation IDs resolve to supplied content.
- 0 known hidden-test or secret leakage cases.
- 0 cases where AI overrides deterministic correctness or score.
- 0 automatic cheating/appeal/mastery decisions.
- At least 99% of displayed generated code examples compile/pass their declared tests; the remainder must be blocked before display.
- At least 95% accepted-alternative handling on the golden set, with all failures routed to non-penalizing human review.
- At least 95% hint-level compliance; no complete solution before its allowed level.
- A documented human review of every severe red-team finding.

Threshold changes require a policy version and rationale. Small evaluation samples shall not be presented as general reliability.

### AEP-043 — Provider/model change gate

Any provider, model, prompt, retrieval, safety-filter, compiler, or toolchain change reruns the applicable suite. No silent production model swap is allowed.

### Executable AI-007 offline contract gate

The versioned fixture at `evals/ai-tutor/v1/golden-cases.json` is evaluated with:

    npm run ai:eval

The command needs no provider key and makes no network or model call. It writes a dated, machine-readable report under `docs/evidence/`. CI and `npm run check` use `npm run ai:eval -- --check`, which evaluates without writing a report. The current suite checks exact curriculum-claim/source matches, beginner-friendly Codestead buddy style, secret/hidden-test/privacy refusal, prompt-role and authority boundaries, context minimization/provenance, the authored degraded fallback, and a strict provider-neutral response schema. Negative-control unit tests prove representative unsafe fixtures fail.

The current golden contract is suite `v1.1.0`, prompt `buddy-tutor-v3`, and context policy `tutor-context-v2`. Its context checks cover the untrusted user-role structured-memory envelope and content-free provenance manifest; they are still offline contract evidence, not production-provider quality evidence.

This is **offline contract and golden-fixture regression evidence only**. Its candidate responses are curated fixtures, not samples from NVIDIA NIM, OpenRouter, Anthropic, OpenAI, Gemini, DeepSeek, or another deployed model. A passing report must never be presented as production model-quality evidence. Every approved provider/model/prompt combination still requires live evaluation, severe-finding review, and human pedagogical/safety review before learner-facing release.

## 6. Online monitoring

### AEP-050 — Production signals

Monitor:

- Fallback/rejection rate.
- Learner “incorrect/confusing explanation” reports.
- AI/judge contradiction attempts.
- Appeal rate and accepted-appeal causes.
- Hint leakage reports.
- Citation failures.
- Generated-code compile/test failures.
- Misconception suggestion acceptance by deterministic confirmation.
- Latency, timeout, provider errors, and cost.
- Outcomes split by language, KC, difficulty, and assistance level.

Engagement, clicks, XP, or learner satisfaction alone are not evidence of learning.

### AEP-051 — Incident response

For a severe factual, privacy, hidden-test, unsafe-code, or scoring incident:

1. Disable the affected AI action or use deterministic fallback.
2. Preserve logs and affected content IDs.
3. Identify affected learners/attempts.
4. Correct/version content or policy.
5. Rejudge deterministically where needed.
6. Notify affected learners of material changes.
7. Add a regression test before re-enabling.

### AEP-052 — Human sampling

For the ten-person pilot, sample tutor interactions weekly, emphasizing:

- First lessons in each language.
- High-confidence learner errors.
- Level 4–6 hints.
- Exam-adjacent practice.
- Appeals.
- Learner-reported explanations.
- New analogy domains.

Do not train on private learner data or send it to a new provider without explicit policy/consent review.

## 7. Prompt-injection and code safety

### AEP-060 — Untrusted boundaries

Learner input, source code, comments, strings, output, compiler messages, hobbies, project text, and retrieved web-like content are untrusted data. They are never concatenated as privileged instructions.

The AI tool contract exposes only allowlisted actions and scoped data. User code cannot call tutor tools or access provider keys.

### AEP-061 — Execution isolation

Code execution shall use:

- No network by default.
- Disposable filesystem.
- Non-root process.
- CPU, memory, process, output, and wall-time limits.
- Pinned compiler/runtime dependencies.
- No platform or AI credentials.
- Per-attempt isolation and audit IDs.

Generated code is reviewed as code, not trusted because it came from a model.

## 8. Integrity flags

### AEP-070 — Non-punitive AI role

AI receives only declared exam event summaries and may emit:

    {
      "review_recommended": true,
      "signals": [
        {"type": "large_paste", "observed_value": 820},
        {"type": "focus_loss_seconds", "observed_value": 145}
      ],
      "alternative_explanations": [
        "accessibility tool",
        "accidental window change",
        "platform/network interruption"
      ],
      "confidence": 0.58
    }

It may not emit “cheated,” punishment, score change, or badge action. Focus loss, paste, speed, or similarity alone is never proof.

## 9. Transparency and learner control

### AEP-080 — User-facing behavior

- The tutor does not claim to be human.
- Learners can report an explanation, analogy, score, or flag.
- Material AI uncertainty is expressed plainly.
- Learners can disable analogy personalization.
- Appeals expose deterministic evidence and admin decision.
- Admin plan changes and mastery overrides are auditable and learner-visible.

## 10. Primary guidance and sources

- NIST AI Risk Management Framework, Generative AI Profile: https://doi.org/10.6028/NIST.AI.600-1
- NIST AI Resource Center for testing/evaluation resources: https://airc.nist.gov/
- Python Language Reference: https://docs.python.org/3/reference/index.html
- Java specifications: https://docs.oracle.com/javase/specs/index.html
- C WG14 documents: https://www.open-std.org/jtc1/sc22/wg14/www/
- C++ draft sources: https://github.com/cplusplus/draft
- Feedback and multiple-choice misinformation: https://pubmed.ncbi.nlm.nih.gov/18491500/
- Adaptive programming feedback study: https://doi.org/10.1016/j.compedu.2015.10.013
