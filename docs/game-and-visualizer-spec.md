# Reusable Topic Game and Code Visualizer Specification

Status: implementation baseline\
Scope: desktop/laptop web experience; English text, interactive code, and diagrams; no required audio/video

## 1. Product boundary

The game creates repeated, meaningful practice. It is not the mastery authority. Progress persists independently for each learner, language, course version, and topic. Replays are unlimited, but identical/easy repetition cannot farm XP, evidence, streak credit, or leaderboard rank.

The visualizer is an inspectable execution aid for Learn and Practice. It is disabled in formal exams.

ID convention: every GVS requirement has acceptance ID GVS-NNN-AC1 at minimum. Multiple acceptance bullets are GVS-NNN-AC1, AC2, and so on in document order. Product and QA evidence shall cite both IDs.

## 2. Reusable game model

### GVS-001 — Per-topic and per-language state

Persist:

    {
      "learner_id": "u_123",
      "language_track": "java-21",
      "topic_id": "variables",
      "game_template_id": "stateful-workshop-v1",
      "game_state_version": "3",
      "current_stage": "INDEPENDENT",
      "completed_quest_ids": ["q1", "q2"],
      "best_variant_results": {},
      "xp_awarded_by_evidence_key": {},
      "last_checkpoint": {},
      "updated_at": "2026-07-12T10:00:00Z"
    }

Acceptance IDs GVS-001-AC1 through GVS-001-AC4:

- Python and Java progress do not overwrite one another.
- Re-entering a topic resumes its last state.
- A learner can replay a completed topic without resetting mastery or earning duplicate capped rewards.
- Curriculum/game migrations preserve or explicitly map prior progress.

### GVS-002 — Topic-game stages

    ORIENTATION
      -> GUIDED
      -> FADED
      -> INDEPENDENT
      -> TRANSFER
      -> EXAM_READY
      -> REPLAY

Stage transitions consume learning-model evidence:

- Assisted success may advance narrative/guided state.
- INDEPENDENT and TRANSFER require fresh A0 evidence.
- EXAM_READY requires learning-model gates.
- Only the formal assessment policy can create PASSED or MASTERED.

### GVS-003 — Reusable quest grammar

Every topic game should be expressible through reusable primitives:

- Inspect state.
- Predict next state/output.
- Select or reorder an operation.
- Fill a missing line.
- Repair a bug.
- Write a bounded function/program.
- Run public examples.
- Explain a state change.
- Transfer the behavior to a neutral scenario.

Theme and story are presentation layers. The underlying KC, rubric, state transition, and tests remain versioned and theme-independent.

### GVS-004 — Example game loop

For variables:

1. A workshop has labeled storage slots.
2. Learner predicts a slot’s value after an operation.
3. Learner arranges declaration/assignment lines.
4. Learner fixes an incorrect update.
5. Learner writes a neutral program that computes a total.
6. A new context confirms transfer.

The workshop may render as cooking, cars, robots, or neutral data only after an approved analogy mapping is selected.

## 3. XP and anti-farming

### GVS-010 — XP purpose

XP rewards engagement and meaningful first evidence. XP is not mastery probability, exam score, or proof of knowledge.

### GVS-011 — Award keys

An XP award shall use a unique evidence key such as:

    learner + language + topic + KC + activity_type
    + difficulty_band + independence_band + variant_family + period

Replaying the same key yields zero or sharply diminishing XP.

Default award rules:

- First completion of a new learning step: small XP.
- First clean A0 success at a higher evidence/difficulty band: larger XP.
- Due review completed meaningfully: small XP.
- Correction after remediation: recovery XP once.
- Exact replay, revealed answer, or repeated easy variant: no evidence XP.
- Time spent, compile count, rapid guessing, and failed attempts do not directly yield farmable XP.

### GVS-012 — Caps and abuse resistance

- Daily XP cap per KC/variant family.
- Server awards XP idempotently.
- Client cannot submit an arbitrary XP amount.
- Reward is calculated from authoritative attempt events.
- Replayed variants must differ in more than cosmetic numbers to create a new evidence key.
- Leaderboards consume capped eligible XP or category achievements, never raw event totals.

Acceptance GVS-012-AC1: tests cover refresh/retry, concurrent completion, offline replay upload, seed manipulation, duplicate events, clock/timezone manipulation, and direct API calls.

### GVS-013 — Streaks

- A streak day requires one meaningful practice, review, challenge, project milestone, or exam event.
- Rapid empty actions and identical replay do not count.
- Timezone is server-stored per learner.
- Grace/freeze days are supported.
- Missing a day does not delete earned badges, XP, best streak, or mastered topics.
- Public display is optional and closed-cohort only.

## 4. Personalization and analogy

### GVS-020 — Optional presentation themes

- Free-text hobby is normalized to an approved domain and confirmed.
- The learner can switch to another confirmed interest or neutral at any time.
- Game logic and scoring never depend on a sensitive personal attribute.
- Unsupported or unsuitable input falls back to neutral.
- Canonical technical labels remain visible.
- “Where this analogy breaks” is accessible from every themed explanation.

### GVS-021 — Transfer requirement

Every themed quest chain shall end with an equivalent neutral or different-context task before its evidence can satisfy TRANSFER or EXAM_READY.

Acceptance GVS-021-AC1: completing only the hobby-skinned steps cannot satisfy the transfer gate.

## 5. Visualizer experience

### GVS-030 — Required controls

The MVP shall provide:

- Load/edit code.
- Provide declared standard input.
- Start/run.
- Step forward.
- Step backward using retained snapshots/replay where supported.
- Continue.
- Pause.
- Restart.
- Speed control for automatic stepping.
- Breakpoint or run-to-line if technically supported by the language adapter.
- Stop on trace/resource limit.

All controls must be keyboard operable and have text labels.

### GVS-031 — Required panels

- Source code with current-line highlight.
- Current/previous executed operation.
- Call stack and active frame.
- Local and global variables.
- Heap/object/reference/pointer view where relevant.
- Arrays/collections with indexes/keys.
- Standard input/output.
- Return values and exceptions.
- Plain-language “what changed” summary grounded in trace events.

A variable shall not always be rendered as a simple box when that would teach an incorrect reference/aliasing model.

### GVS-032 — Trace event contract

Language adapters shall emit implementation-equivalent events:

    {
      "trace_id": "tr_19",
      "sequence": 14,
      "language": "python-3.14",
      "event": "ASSIGN",
      "source": {"file": "main.py", "line": 4, "column": 1},
      "frame_id": "f_main",
      "changes": [
        {"name": "servings", "before": 2, "after": 4}
      ],
      "stdout_delta": "",
      "exception": null
    }

Required event classes where supported:

- Program/frame enter and exit.
- Line/statement.
- Declare/bind/assign.
- Read.
- Branch decision.
- Loop iteration.
- Function/method call and return.
- Object/array allocation.
- Field/index mutation.
- Standard input/output.
- Exception throw/catch/unhandled.

### GVS-033 — Backward stepping

Backward step may be implemented through:

- Immutable state snapshots.
- Event inversion where safe.
- Deterministic replay to the selected sequence.

The UI shall disclose when backward navigation is unavailable due to nondeterminism or unsupported runtime behavior.

## 6. Execution architecture

### GVS-040 — Client versus server

Preferred practice architecture:

- Browser/WASM or tightly sandboxed worker execution for responsive traces where feasible.
- Server fallback for unsupported languages/features.
- Server-side re-execution for every graded result.

Native execution directly on the learner’s computer is not the default because it creates environment, permission, security, and support inconsistencies. If later offered, it requires an explicit installer/security/update design.

### GVS-041 — Isolation and limits

- No network.
- Disposable virtual filesystem.
- No provider/platform secrets.
- CPU, memory, process, output, and wall-time limits.
- Trace-event cap.
- Recursion/loop/resource warning.
- Pinned runtime adapter.
- Stop control remains responsive.

### GVS-042 — Semantic accuracy

- Trace semantics shall match the pinned judge runtime.
- Unsupported behavior produces an explicit message, not a fabricated state.
- Undefined or implementation-dependent C/C++ behavior stops with a warning.
- The first MVP may exclude threads/concurrency, native libraries, reflection-heavy behavior, subprocesses, file/network I/O, and advanced runtime metaprogramming.
- Every adapter has golden traces tested against actual runtime outputs.

## 7. Tutor integration

### GVS-050 — Evidence boundary

- Opening or stepping through a visualization is E0 exposure.
- Answering trace/prediction prompts before stepping may create E2 evidence.
- A solution reached after using the visualizer is assisted unless the item explicitly treats visualization as the target skill.
- A fresh no-visualizer task is required for independent mastery evidence.

### GVS-051 — AI explanation

AI may verbalize the structured trace but cannot invent an event. Each statement must reference event sequence IDs or canonical content. If AI is unavailable, deterministic event labels remain usable.

## 8. Exam boundary

### GVS-060 — Disabled visualizer

Formal exam payloads shall not include visualizer controls, trace data, analogy content, hints, or tutor endpoints. Compile/Run remain available under assessment-policy.md, but only raw compiler/runtime/public-example output is returned before final submission.

Acceptance IDs GVS-060-AC1 through GVS-060-AC3:

- Exam authorization cannot call trace endpoints.
- Cached practice traces are not embedded in exam data.
- The server enforces the restriction; hiding UI alone is insufficient.

## 9. Accessibility and UX

### GVS-070 — Text and diagram access

- All diagram state has an equivalent ordered text representation.
- Color is not the only indication of change.
- Current line, before/after value, error, and focus are announced to assistive technology.
- Keyboard focus order follows source, controls, stack, variables, heap, and output.
- Motion/auto-step can be paused and reduced.
- Large traces support search/filter without losing the ordered event list.

### GVS-071 — Cognitive-load controls

- Default beginner view shows only panels relevant to the current objective.
- Advanced panels can be expanded.
- Changed values are highlighted temporarily and listed in text.
- The learner can replay a step and ask for the configured hint ladder.
- Theme visuals cannot obscure code, state, or controls.

## 10. Observability and acceptance

### GVS-080 — Product telemetry

Record:

- Quest start/completion and evidence key.
- Hint and reveal level.
- Variant/seed and outcome.
- Visualizer start/stop, steps, limits, and unsupported events.
- State migration.
- XP award decision/reason.

Do not treat step count or time in the visualizer as learning success.

### GVS-081 — MVP acceptance scenario

Given a Java learner in variables:

1. The learner opens the confirmed cooking theme.
2. Guided success after a hint advances the narrative but records A2.
3. Replay grants no duplicate evidence XP.
4. A fresh independent neutral variant records A0/E4.
5. The visualizer correctly shows declaration and reassignment.
6. Reference-oriented content does not reuse the misleading primitive-value box model without a limitation.
7. EXAM_READY appears only after the learning-model gates.
8. Starting an exam disables all visualizer/tutor/analogy endpoints.
9. Server grading and XP remain correct after refresh and duplicate event delivery.

## 11. Evidence and sources

- Personalized interest contexts: https://doi.org/10.1037/a0031882
- Analogical comparison and transfer: https://doi.org/10.1037/0022-0663.95.2.393
- Worked examples and self-explanation: https://doi.org/10.1207/s15516709cog1302_1
- Adaptive Parsons problems for code-writing scaffolding: https://doi.org/10.1145/3501385.3543977
- Expertise-reversal effect and fading guidance: https://doi.org/10.1207/S15326985EP3801_4
- NIST guidance for generated-code review and AI testing: https://doi.org/10.6028/NIST.AI.600-1
