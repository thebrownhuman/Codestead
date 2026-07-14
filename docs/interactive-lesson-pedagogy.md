# Interactive beginner lesson design

**Product:** Codestead — Build skills that stay.\
**Status:** implementation contract, not a claim that draft curriculum is editorially approved\
**Audience:** adult beginners and returning learners who need concrete, low-jargon explanations without losing technical precision

## Why the lesson is a guided interaction

A long article can explain a topic correctly while still letting a beginner read passively and overestimate understanding. Codestead therefore presents each atomic skill as a short sequence of decisions and explanations. The learner predicts, observes, explains, and transfers the idea before seeing a recap. The complete authored reference remains available in a collapsed disclosure for accessibility, searching, and later review.

The sequence is:

1. **Goal and boundaries.** Say what the learner will be able to do, what is in scope, and what is deliberately postponed.
2. **Prediction before reveal.** Ask for an output or state prediction before the explanation is exposed.
3. **Plain English, then the precise model.** Start with observable behavior; introduce terminology only after the learner has a mental anchor.
4. **Worked example in small steps.** Show one state-changing step at a time and make the reason for that step explicit.
5. **Trace with a text alternative.** Pair any visual state table with a complete linear explanation; the visualization is a tool, not the evidence of learning.
6. **Misconception check.** Ask a plausible wrong choice and explain why it fails without awarding mastery.
7. **Fading practice.** Move from guided completion to near transfer and then far transfer. Hints are requested, recorded, and increasingly specific.
8. **Teach-back.** Require the learner to explain the rule in their own words before the supplied recap is revealed.
9. **Delayed retrieval.** Schedule an independent review from verified evidence; rereading alone does not clear a weak skill.

This is the implemented `InteractiveLessonFlow`. It is practice-only until the underlying item and lesson pass the normal human review and publication gates.

## Research basis and limits

The design combines several evidence-informed techniques; none is treated as a magic formula.

- **PRIMM (Predict, Run, Investigate, Modify, Make)** motivates prediction before execution and progressive movement from reading to writing. Sentance, Waite, and Kallia describe the approach through a sociocultural lens; this supports the interaction model but does not prove every PRIMM implementation will outperform every alternative. [Paper and DOI](https://doi.org/10.1080/08993408.2019.1608781)
- **Retrieval practice** supports asking learners to recall and explain rather than immediately reread. Roediger and Karpicke found delayed retention benefits in their experimental setting; Codestead applies the principle through bounded review scheduling and does not infer mastery from a single retrieval. [Paper and DOI](https://doi.org/10.1111/j.1467-9280.2006.01693.x)
- **Parsons-style completion** can reduce the mechanical burden of first code construction, but results are nuanced. Hou, Ericson, and Wang reported lower completion time without a statistically significant learning gain in one study; later work examines how effects vary with self-efficacy. Codestead uses completion as temporary scaffolding, never as a substitute for independent code. [ICER 2022 paper](https://doi.org/10.1145/3501385.3543977) and [NSF-hosted follow-up record](https://par.nsf.gov/biblio/10510497-understanding-effects-using-parsons-problems-scaffold-code-writing-students-varying-cs-self-efficacy-levels)
- **Subgoal labels** motivate naming the purpose of worked-example steps rather than presenting a wall of syntax. Evidence includes computing and worked-example studies, but transfer still needs to be tested independently. [STEM Education study](https://doi.org/10.1186/s40594-020-00222-7) and [Learning and Instruction paper](https://doi.org/10.1016/j.learninstruc.2015.12.002)
- **Guided self-explanation** motivates teach-back prompts. Programming studies report benefits from structured or Socratic prompts, but effect sizes depend on the learner, task, and comparison. Codestead therefore records the explanation as practice evidence and still requires deterministic assessments. [SIGCSE study](https://doi.org/10.1145/2676723.2677260) and [guided Socratic study](https://doi.org/10.1145/3408877.3432423)
- **Immediate, targeted feedback** motivates explaining the specific observable error and the next useful action. It does not justify revealing final solutions during formal assessment. [Adaptive immediate feedback study](https://eric.ed.gov/?id=EJ1344457)
- **Program visualization has mixed evidence.** Some work reports benefits for particular concepts, while other classroom evidence found no general advantage and possible effort-reduction effects. Codestead always provides a textual trace and asks the learner to predict or explain; merely watching an animation creates no mastery evidence. [Smith and Webb](https://doi.org/10.2190/N0VV-0P48-XJ9G-F8WV) and [Microsoft Research classroom evaluation](https://www.microsoft.com/en-us/research/publication/evaluating-feedback-tools-in-introductory-programming-classes/)

## Plain-language rules

- Use one new technical idea per atomic skill.
- Prefer a short sentence with a concrete subject and verb.
- Define a term immediately before it is needed, then use the correct term consistently.
- Show an observable input, state change, and result; do not say that code “just knows” or “thinks.”
- Name the failure boundary: what this model does not explain yet.
- Separate compiler/runtime facts from teaching metaphors.
- Treat an analogy as optional. State at least one place where it stops matching the program model.
- Never use “easy,” “obvious,” “just,” or ridicule in feedback.
- When an answer is wrong, preserve the attempt, identify the smallest misconception supported by evidence, and give one next action.
- Do not reveal a final answer during formal exams or turn AI output into official grading truth.

## Interaction and accessibility contract

- Every control is keyboard reachable and has a visible focus state and at least a 44-by-44 CSS-pixel target.
- Prediction and teach-back text remains in local component state unless a learner explicitly submits an authorized activity; scratch text is labelled non-durable.
- State diagrams have a complete linear text alternative that contains the same meaningful facts.
- Correctness is never communicated by color alone.
- Motion is short, functional, and removed under `prefers-reduced-motion` or the in-app reduced-motion setting.
- The layout must remain operable at 320 CSS pixels and 200% text scaling without horizontal page scrolling.
- A collapsed reference preserves access to every canonical section and source without forcing it into the first reading path.

## Authority and publication boundary

The interactive shell can present an authored draft, but it cannot make the draft true. A lesson remains labelled AI-assisted draft until an independent human reviewer approves its explanation, examples, boundaries, analogies, questions, code tests, sources, and accessibility. AI may offer an additional explanation from bounded context; it cannot publish content, receive hidden tests, award mastery, or silently adapt the official roadmap.

## Evaluation plan

For each pilot skill, collect only meaningful, consented events: prediction submitted, hint level requested, misconception choice, independent answer, teach-back submitted, and delayed-review result. Compare completion and delayed independent performance, not clicks or time-on-page alone. Review failure patterns with learners, check for vocabulary and analogy misconceptions, and revise the authored version through the normal publication workflow. No A/B result is allowed to override accessibility, privacy, or assessment validity.
