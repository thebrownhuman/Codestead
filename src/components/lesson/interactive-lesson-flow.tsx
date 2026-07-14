"use client";

import {
  ArrowRight,
  BookOpenCheck,
  Brain,
  Check,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  Eye,
  Footprints,
  Lightbulb,
  RefreshCw,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

import type { AuthoredLesson, AuthoredPracticePrompt } from "@/lib/content";

import styles from "./interactive-lesson-flow.module.css";

const MIN_SCRATCHPAD_LENGTH = 12;

type PracticeRung = Readonly<{
  answerLabel: string;
  heading: string;
  nextLabel: string;
  practice: AuthoredPracticePrompt;
  shortLabel: string;
}>;

function enoughToContinue(value: string) {
  return value.trim().length >= MIN_SCRATCHPAD_LENGTH;
}

function stateSummary(state: Readonly<Record<string, string>>) {
  const entries = Object.entries(state);
  return entries.length > 0
    ? entries.map(([name, value]) => `${name} = ${value}`).join("; ")
    : "No named state changes at this step.";
}

export function InteractiveLessonFlow({ lesson }: { readonly lesson: AuthoredLesson }) {
  const predictionStatusId = useId();
  const misconceptionFeedbackId = useId();
  const predictionInputRef = useRef<HTMLTextAreaElement>(null);
  const [prediction, setPrediction] = useState("");
  const [predictionRevealed, setPredictionRevealed] = useState(false);
  const [exampleIndex, setExampleIndex] = useState(0);
  const [workedStep, setWorkedStep] = useState(0);
  const [traceStep, setTraceStep] = useState(0);
  const [misconceptionChoice, setMisconceptionChoice] = useState<"belief" | "correction" | null>(null);
  const [practiceRung, setPracticeRung] = useState(0);
  const [practiceAnswers, setPracticeAnswers] = useState(["", "", ""]);
  const [visibleHints, setVisibleHints] = useState([0, 0, 0]);
  const [ladderComplete, setLadderComplete] = useState(false);
  const [teachBack, setTeachBack] = useState("");
  const [recapRevealed, setRecapRevealed] = useState(false);

  // Browsers preserve text entered into server-rendered fields before React
  // hydrates. Recover that value once handlers attach so the adjacent action
  // reflects what the learner can already see instead of remaining disabled.
  useEffect(() => {
    const preHydrationPrediction = predictionInputRef.current?.value ?? "";
    if (preHydrationPrediction) setPrediction(preHydrationPrediction);
  }, []);

  const example = lesson.examples[exampleIndex]!;
  const firstTrace = lesson.trace.steps[0]!;
  const misconception = lesson.misconceptions[0]!;
  const practiceRungs: readonly PracticeRung[] = [
    {
      answerLabel: "Your guided-practice answer",
      heading: "Rung 1 · Guided",
      nextLabel: "Continue to near transfer",
      practice: lesson.practice.faded,
      shortLabel: "Guided",
    },
    {
      answerLabel: "Your similar-problem answer",
      heading: "Rung 2 · Similar problem",
      nextLabel: "Continue to a new context",
      practice: lesson.practice.nearTransfer,
      shortLabel: "Similar",
    },
    {
      answerLabel: "Your new-context answer",
      heading: "Rung 3 · New context",
      nextLabel: "Finish the practice ladder",
      practice: lesson.practice.farTransfer,
      shortLabel: "Transfer",
    },
  ];
  const activePractice = practiceRungs[practiceRung]!;

  function chooseExample(index: number) {
    setExampleIndex(index);
    setWorkedStep(0);
  }

  function moveWorkedStep(offset: number) {
    setWorkedStep((current) => Math.min(
      example.walkthrough.length - 1,
      Math.max(0, current + offset),
    ));
  }

  function updatePracticeAnswer(value: string) {
    setPracticeAnswers((answers) => answers.map((answer, index) => (
      index === practiceRung ? value : answer
    )));
  }

  function revealHint() {
    setVisibleHints((counts) => counts.map((count, index) => (
      index === practiceRung
        ? Math.min(activePractice.practice.scaffold.length, count + 1)
        : count
    )));
  }

  function advancePractice() {
    if (!enoughToContinue(practiceAnswers[practiceRung]!)) return;
    if (practiceRung < practiceRungs.length - 1) {
      setPracticeRung((current) => current + 1);
      return;
    }
    setLadderComplete(true);
  }

  return <div className={styles.flow}>
    <div className={styles.safetyNote} role="note">
      <ShieldCheck aria-hidden="true" size={19} />
      <div>
        <strong>Learning scratchpad</strong>
        <p>Scratchpad responses stay in this tab. They are not submitted, graded, or used for mastery, XP, badges, or exams.</p>
      </div>
    </div>

    <section aria-labelledby="prediction-title" className={`${styles.stage} ${styles.predictionStage}`} id="predict">
      <header className={styles.stageHeader}>
        <span>01</span>
        <div><small>Predict before reading</small><h2 id="prediction-title">What do you think the computer will do?</h2></div>
        <Brain aria-hidden="true" size={24} />
      </header>
      <p className={styles.stageLead}>Do not worry about being right. A prediction gives your brain something concrete to compare with the real execution.</p>
      <pre className={styles.codeArtifact}>{lesson.trace.artifact.join("\n")}</pre>
      <label className={styles.answerField}>
        <span>Your prediction</span>
        <textarea
          aria-describedby={predictionStatusId}
          onInput={(event) => {
            setPrediction(event.currentTarget.value);
            setPredictionRevealed(false);
          }}
          ref={predictionInputRef}
          placeholder="In plain English: first this happens, then…"
          value={prediction}
        />
      </label>
      <div className={styles.actionRow}>
        <button
          className={styles.primaryAction}
          disabled={!enoughToContinue(prediction)}
          onClick={() => setPredictionRevealed(true)}
          type="button"
        ><Eye aria-hidden="true" size={17} /> Reveal the first step</button>
        <small id={predictionStatusId}>Write one complete thought ({MIN_SCRATCHPAD_LENGTH}+ characters) to compare it with the trace.</small>
      </div>
      {predictionRevealed && <div aria-live="polite" className={styles.reveal} role="status">
        <Check aria-hidden="true" size={18} />
        <div>
          <strong>Prediction saved locally. Now compare, do not score yourself.</strong>
          <h3>Step 1: {firstTrace.focus}</h3>
          <p>{firstTrace.explanation}</p>
          <code>{stateSummary(firstTrace.state)}</code>
        </div>
      </div>}
    </section>

    <section aria-labelledby="canonical-explanation" className={styles.stage} id="explain">
      <header className={styles.stageHeader}>
        <span>02</span>
        <div><small>Build the mental model</small><h2 id="canonical-explanation">The buddy version, then the precise version</h2></div>
        <BookOpenCheck aria-hidden="true" size={24} />
      </header>
      <div className={styles.plainCard}>
        <span>Plain English</span>
        <p>{lesson.canonicalExplanation.summary}</p>
      </div>
      <div className={styles.explanationGrid}>{lesson.canonicalExplanation.sections.map((section, index) => <article key={section.heading}>
        <b>{String(index + 1).padStart(2, "0")}</b>
        <div><h3>{section.heading}</h3><p>{section.body}</p></div>
      </article>)}</div>
      <details className={styles.boundaryDisclosure}>
        <summary>See exactly what this lesson does and does not cover</summary>
        <div className={styles.boundaryGrid}>
          <div><h3>Learn now</h3><ul>{lesson.scope.includes.map((item) => <li key={item}>{item}</li>)}</ul></div>
          <div><h3>Save for later</h3><ul>{lesson.scope.excludes.map((item) => <li key={item}>{item}</li>)}</ul></div>
        </div>
      </details>
      <div className={styles.analogyCard}>
        <Sparkles aria-hidden="true" size={20} />
        <div>
          <span>Optional analogy</span>
          <p>{lesson.analogy.example}</p>
          <details><summary>Where this analogy stops being accurate</summary><ul>{lesson.analogy.limitations.map((limit) => <li key={limit}>{limit}</li>)}</ul></details>
        </div>
      </div>
    </section>

    <section aria-labelledby="worked-examples-heading" className={styles.stage} id="worked-examples">
      <header className={styles.stageHeader}>
        <span>03</span>
        <div><small>Follow one solved path</small><h2 id="worked-examples-heading">Worked example, one small step at a time</h2></div>
        <Footprints aria-hidden="true" size={24} />
      </header>
      <div aria-label="Choose a worked example" className={styles.segmented} role="group">
        {lesson.examples.map((candidate, index) => <button
          aria-pressed={exampleIndex === index}
          key={candidate.id}
          onClick={() => chooseExample(index)}
          type="button"
        >Example {index + 1}: {candidate.title}</button>)}
      </div>
      <div className={styles.workedCard}>
        <div><small>Situation</small><p>{example.situation}</p></div>
        <div aria-live="polite" className={styles.workedStep}>
          <span>Step {workedStep + 1} of {example.walkthrough.length}</span>
          <p>{example.walkthrough[workedStep]}</p>
        </div>
        <div className={styles.stepControls}>
          <button aria-label="Previous worked step" disabled={workedStep === 0} onClick={() => moveWorkedStep(-1)} type="button"><ChevronLeft aria-hidden="true" size={18} /> Previous</button>
          <button aria-label="Next worked step" disabled={workedStep === example.walkthrough.length - 1} onClick={() => moveWorkedStep(1)} type="button">Next <ChevronRight aria-hidden="true" size={18} /></button>
        </div>
        {workedStep === example.walkthrough.length - 1 && <div className={styles.resultStrip}><Check aria-hidden="true" size={17} /><strong>Result:</strong> {example.result}</div>}
      </div>
    </section>

    <section aria-labelledby="trace-heading" className={styles.stage} id="trace">
      <header className={styles.stageHeader}>
        <span>04</span>
        <div><small>Open the black box</small><h2 id="trace-heading">Watch state change, not just lines move</h2></div>
        <RefreshCw aria-hidden="true" size={24} />
      </header>
      <pre className={styles.codeArtifact}>{lesson.trace.artifact.join("\n")}</pre>
      <div aria-live="polite" className={styles.traceCard}>
        <div className={styles.traceProgress}><span style={{ width: `${((traceStep + 1) / lesson.trace.steps.length) * 100}%` }} /></div>
        <small>Machine step {traceStep + 1} of {lesson.trace.steps.length}</small>
        <h3>{lesson.trace.steps[traceStep]!.focus}</h3>
        <p>{lesson.trace.steps[traceStep]!.explanation}</p>
        <dl>{Object.entries(lesson.trace.steps[traceStep]!.state).map(([name, value]) => <div key={name}><dt>{name}</dt><dd>{value}</dd></div>)}</dl>
      </div>
      <div className={styles.stepControls}>
        <button disabled={traceStep === 0} onClick={() => setTraceStep((current) => current - 1)} type="button"><ChevronLeft aria-hidden="true" size={18} /> Back</button>
        <button disabled={traceStep === lesson.trace.steps.length - 1} onClick={() => setTraceStep((current) => current + 1)} type="button">Next state <ChevronRight aria-hidden="true" size={18} /></button>
      </div>
      <details className={styles.textAlternative}><summary>Read the whole trace as text</summary><p>{lesson.trace.textAlternative}</p></details>
    </section>

    <section aria-labelledby="misconceptions-heading" className={styles.stage} id="misconceptions">
      <header className={styles.stageHeader}>
        <span>05</span>
        <div><small>Catch the tempting mistake</small><h2 id="misconceptions-heading">Which mental model will survive a new problem?</h2></div>
        <CircleHelp aria-hidden="true" size={24} />
      </header>
      <p className={styles.stageLead}>{misconception.diagnosticPrompt}</p>
      <div aria-describedby={misconceptionFeedbackId} className={styles.choiceGrid}>
        <button aria-pressed={misconceptionChoice === "belief"} onClick={() => setMisconceptionChoice("belief")} type="button">
          <small>Tempting shortcut</small>{misconception.mistakenBelief}
        </button>
        <button aria-pressed={misconceptionChoice === "correction"} aria-label="Choose the precise explanation" onClick={() => setMisconceptionChoice("correction")} type="button">
          <small>Precise explanation</small>{misconception.correction}
        </button>
      </div>
      <div aria-live="polite" className={styles.feedback} id={misconceptionFeedbackId}>
        {misconceptionChoice === null && <p>Choose one, then the lesson will explain the consequence.</p>}
        {misconceptionChoice === "belief" && <p><Lightbulb aria-hidden="true" size={18} /><span><strong>That shortcut breaks at the boundary.</strong> {misconception.correction}</span></p>}
        {misconceptionChoice === "correction" && <p><Check aria-hidden="true" size={18} /><span><strong>That is the safer mental model.</strong> {misconception.correction}</span></p>}
        {misconceptionChoice !== null && <small>This is a practice-only check; it creates no official evidence.</small>}
      </div>
    </section>

    <section aria-labelledby="transfer-practice-heading" className={styles.stage} id="transfer-practice">
      <header className={styles.stageHeader}>
        <span>06</span>
        <div><small>Remove support gradually</small><h2 id="transfer-practice-heading">Practice ladder: guided → similar → new</h2></div>
        <ArrowRight aria-hidden="true" size={24} />
      </header>
      <ol aria-label="Practice ladder progress" className={styles.ladderProgress}>
        {practiceRungs.map((rung, index) => <li data-active={index === practiceRung} data-complete={index < practiceRung || ladderComplete} key={rung.shortLabel}><span>{index < practiceRung || ladderComplete ? <Check aria-hidden="true" size={14} /> : index + 1}</span>{rung.shortLabel}</li>)}
      </ol>
      <div className={styles.practiceCard}>
        <h3>{activePractice.heading}</h3>
        <p>{activePractice.practice.prompt}</p>
        <label className={styles.answerField}>
          <span>{activePractice.answerLabel}</span>
          <textarea onChange={(event) => updatePracticeAnswer(event.target.value)} placeholder="Write your reasoning, pseudocode, or small code idea…" value={practiceAnswers[practiceRung]} />
        </label>
        <div className={styles.hintStack}>
          {activePractice.practice.scaffold.slice(0, visibleHints[practiceRung]).map((hint, index) => <p key={hint}><Lightbulb aria-hidden="true" size={16} /><span><strong>Hint {index + 1}:</strong> {hint}</span></p>)}
        </div>
        <div className={styles.actionRow}>
          <button disabled={visibleHints[practiceRung] >= activePractice.practice.scaffold.length} onClick={revealHint} type="button"><Lightbulb aria-hidden="true" size={17} /> Show one hint</button>
          <button className={styles.primaryAction} disabled={!enoughToContinue(practiceAnswers[practiceRung]!)} onClick={advancePractice} type="button">{activePractice.nextLabel} <ArrowRight aria-hidden="true" size={17} /></button>
        </div>
        <details className={styles.selfCheck}><summary>When you are done, use this evidence checklist</summary><ul>{activePractice.practice.expectedEvidence.map((item) => <li key={item}>{item}</li>)}</ul></details>
      </div>
      {ladderComplete && <div aria-live="polite" className={styles.completionNote} role="status"><Check aria-hidden="true" size={18} /><span><strong>Practice ladder complete in this tab.</strong> Use the published checkpoint for official evidence when a human-reviewed item is available.</span></div>}
    </section>

    <section aria-labelledby="remediation-heading" className={styles.stage} id="remediation">
      <header className={styles.stageHeader}>
        <span>07</span>
        <div><small>If it still feels fuzzy</small><h2 id="remediation-heading">One smaller retry</h2></div>
        <Lightbulb aria-hidden="true" size={24} />
      </header>
      <div className={styles.remediationGrid}>{lesson.remediation.map((branch) => <article key={branch.misconceptionId}><p>{branch.explanation}</p><strong>Try this next</strong><p>{branch.retryPrompt}</p></article>)}</div>
    </section>

    <section aria-labelledby="recap-heading" className={`${styles.stage} ${styles.retrievalStage}`} id="recap">
      <header className={styles.stageHeader}>
        <span>08</span>
        <div><small>Close the lesson, then retrieve</small><h2 id="recap-heading">Teach it back without copying</h2></div>
        <Brain aria-hidden="true" size={24} />
      </header>
      <blockquote>{lesson.recap.retrievalPrompts[0]}</blockquote>
      <label className={styles.answerField}>
        <span>Teach it back in your own words</span>
        <textarea onChange={(event) => { setTeachBack(event.target.value); setRecapRevealed(false); }} placeholder="Imagine you are explaining this to a friend…" value={teachBack} />
      </label>
      <button className={styles.primaryAction} disabled={!enoughToContinue(teachBack)} onClick={() => setRecapRevealed(true)} type="button"><Eye aria-hidden="true" size={17} /> Compare with the recap</button>
      {recapRevealed && <div aria-live="polite" className={styles.reveal}>
        <Check aria-hidden="true" size={18} />
        <div><strong>Authored recap</strong><p>{lesson.recap.summary}</p><small>This is reflection, not a correctness grade.</small></div>
      </div>}
      <details className={styles.retrievalMore}><summary>Two more retrieval prompts for later</summary><ul>{lesson.recap.retrievalPrompts.slice(1).map((prompt) => <li key={prompt}>{prompt}</li>)}</ul><p><strong>Next review:</strong> {lesson.recap.nextReviewPrompt}</p></details>
    </section>

    <section aria-labelledby="source-provenance-heading" className={`${styles.stage} ${styles.sources}`} id="source-provenance">
      <header className={styles.stageHeader}>
        <span>09</span>
        <div><small>Know where claims came from</small><h2 id="source-provenance-heading">Sources and review status</h2></div>
        <ShieldCheck aria-hidden="true" size={24} />
      </header>
      <div>{lesson.sources.map((source) => <article key={`${source.sourceRef}:${source.locator}`}><strong>{source.sourceRef}</strong><small>{source.locator}</small><p>{source.claim}</p></article>)}</div>
    </section>
  </div>;
}
