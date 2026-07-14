"use client";

import Link from "next/link";
import {
  AlertTriangle,
  CheckCircle2,
  HelpCircle,
  Lightbulb,
  LoaderCircle,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
} from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

import type {
  LearnerAttemptCreationPayload,
  LearnerPracticeSpecification,
} from "@/lib/learning-service/learner-activity";
import type { AssistanceLevel } from "@/lib/domain";
import type { AttemptSubmissionResult, PracticeHelpResult } from "@/lib/learning-service/types";

import styles from "./lesson-workspace.module.css";

type PanelState = "idle" | "loading" | "ready" | "submitting" | "graded" | "degraded";
type PracticePanelPurpose = "practice" | "checkpoint";

function idempotencyKey(purpose: PracticePanelPurpose) {
  const suffix = globalThis.crypto?.randomUUID?.()
    ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `${purpose}-${suffix}`;
}

function degradedMessage(
  purpose: PracticePanelPurpose,
  reason?: LearnerAttemptCreationPayload["reason"] | "network",
) {
  const checkpoint = purpose === "checkpoint";
  if (reason === "activity_unsupported") {
    return checkpoint
      ? "The current publication could not provide a safe reviewed MCQ for this checkpoint. Nothing was graded."
      : "A published activity exists, but its prompt format is not supported safely yet. Nothing was graded.";
  }
  if (reason === "publication_unavailable") {
    return checkpoint
      ? "This topic has no current reviewed publication for your enrollment yet. Draft questions cannot become checkpoint evidence."
      : "This skill has no active reviewed publication for your enrollment yet. Draft material cannot be graded.";
  }
  if (reason === "network") {
    return `${checkpoint ? "The checkpoint" : "Practice"} could not reach the server. Retry uses the same request key, so it cannot create a duplicate attempt.`;
  }
  return checkpoint
    ? "No independently human-reviewed MCQ from the current publication is available for this topic yet. Draft and AI-only questions remain excluded from official evidence."
    : "No reviewed, published practice activity is available for this skill yet. Draft questions remain excluded from official learning evidence.";
}

function responseAnswer(
  specification: LearnerPracticeSpecification,
  selected: readonly string[],
  gaps: Readonly<Record<string, string>>,
  text: string,
  unknown: boolean,
): Readonly<Record<string, unknown>> {
  if (unknown) return specification.kind === "fill-gap" ? { gaps: {} } : { value: "" };
  if (specification.kind === "mcq") {
    return specification.multiple ? { selectedOptionIds: selected } : { value: selected[0] ?? "" };
  }
  if (specification.kind === "fill-gap") return { gaps };
  return { value: text };
}

function PracticePanelState({
  skillId,
  draftPreviewCount = 0,
  purpose,
}: {
  readonly skillId: string;
  readonly draftPreviewCount?: number;
  readonly purpose: PracticePanelPurpose;
}) {
  const checkpoint = purpose === "checkpoint";
  const titleId = useId();
  const questionHeadingRef = useRef<HTMLHeadingElement>(null);
  const degradedHeadingRef = useRef<HTMLHeadingElement>(null);
  const resultHeadingRef = useRef<HTMLHeadingElement>(null);
  const [state, setState] = useState<PanelState>("idle");
  const [requestKey, setRequestKey] = useState<string | null>(null);
  const [creation, setCreation] = useState<LearnerAttemptCreationPayload | null>(null);
  const [degradedReason, setDegradedReason] = useState<LearnerAttemptCreationPayload["reason"] | "network">();
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [gaps, setGaps] = useState<Record<string, string>>({});
  const [text, setText] = useState("");
  const [revealedHelp, setRevealedHelp] = useState<PracticeHelpResult[]>([]);
  const [helpRequestId, setHelpRequestId] = useState<string | null>(null);
  const [helpBusy, setHelpBusy] = useState(false);
  const [helpExhausted, setHelpExhausted] = useState(false);
  const [result, setResult] = useState<AttemptSubmissionResult | null>(null);

  useEffect(() => {
    if (state === "ready") questionHeadingRef.current?.focus();
    if (state === "graded") resultHeadingRef.current?.focus();
    if (state === "degraded") degradedHeadingRef.current?.focus();
  }, [state]);

  function clearResponse() {
    setSelected([]);
    setGaps({});
    setText("");
    setRevealedHelp([]);
    setHelpRequestId(null);
    setHelpExhausted(false);
    setResult(null);
    setError(null);
  }

  async function createAttempt(fresh: boolean) {
    const key = fresh || !requestKey ? idempotencyKey(purpose) : requestKey;
    setRequestKey(key);
    setState("loading");
    setError(null);
    if (fresh) clearResponse();
    try {
      const response = await fetch("/api/learning/attempts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ idempotencyKey: key, skillId, kind: checkpoint ? "quiz" : "practice" }),
      });
      const body = await response.json().catch(() => ({})) as LearnerAttemptCreationPayload & { error?: string };
      if (!response.ok) {
        setError(body.error ?? "Practice could not start.");
        setDegradedReason("network");
        setState("degraded");
        return;
      }
      setCreation(body);
      if (body.state !== "ready" || !body.attempt || !body.activity) {
        setDegradedReason(body.reason ?? "activity_unavailable");
        setState("degraded");
        return;
      }
      setState("ready");
    } catch {
      setDegradedReason("network");
      setState("degraded");
    }
  }

  const specification = creation?.activity?.specification;
  const attempt = creation?.attempt;
  const answered = specification?.kind === "mcq"
    ? selected.length > 0
    : specification?.kind === "fill-gap"
      ? specification.gaps.every((gap) => Boolean(gaps[gap.id]?.trim()))
      : Boolean(text.trim());

  async function submit(options: { unknown?: boolean } = {}) {
    if (!specification || !attempt || state === "submitting") return;
    setState("submitting");
    setError(null);
    try {
      const response = await fetch(`/api/learning/attempts/${attempt.id}/submit`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          itemKey: specification.itemKey,
          responseRevision: 1,
          answer: responseAnswer(specification, selected, gaps, text, Boolean(options.unknown)),
          // These legacy claims are intentionally non-authoritative. The server
          // derives both values from the durable per-attempt help ledger.
          assistanceLevel: "A0" satisfies AssistanceLevel,
          solutionRevealed: false,
        }),
      });
      const body = await response.json().catch(() => ({})) as AttemptSubmissionResult & { error?: string };
      if (!response.ok) {
        setError(body.error ?? "Your response could not be saved. Retry this same attempt.");
        setState("ready");
        return;
      }
      setResult(body);
      setState("graded");
    } catch {
      setError("Your response could not reach the server. Retry keeps the same attempt and response revision.");
      setState("ready");
    }
  }

  async function revealNextHelp() {
    if (!attempt || helpBusy) return;
    const requestId = helpRequestId ?? globalThis.crypto.randomUUID();
    setHelpRequestId(requestId);
    setHelpBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/learning/attempts/${attempt.id}/help`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ requestId }),
      });
      const body = await response.json().catch(() => ({})) as PracticeHelpResult & { error?: string };
      if (!response.ok) {
        setError(body.error ?? "The next help step could not be saved. Retry safely.");
        return;
      }
      setHelpRequestId(null);
      if (body.state === "ready" && body.help) {
        setRevealedHelp((current) => current.some((item) => item.helpStep === body.helpStep) ? current : [...current, body]);
      } else if (body.state === "exhausted") {
        setHelpExhausted(true);
        setError("No more reviewed help steps are available. Submit your answer or start a fresh attempt.");
      }
    } catch {
      setError("The help step could not reach the server. Retry uses the same request id.");
    } finally {
      setHelpBusy(false);
    }
  }

  function toggleOption(optionId: string) {
    if (!specification) return;
    setSelected((current) => specification.multiple
      ? current.includes(optionId)
        ? current.filter((id) => id !== optionId)
        : [...current, optionId]
      : [optionId]);
  }

  return (
    <section className={styles.practicePanel} aria-labelledby={titleId} data-purpose={purpose}>
      <span aria-atomic="true" aria-live="polite" className="sr-only" role="status">
        {state === "loading"
          ? `Selecting a reviewed ${checkpoint ? "checkpoint" : "practice activity"}.`
          : state === "ready"
            ? `${checkpoint ? "Checkpoint" : "Practice question"} ready.`
            : ""}
      </span>
      <header className={styles.practicePanelHeader}>
        <div>
          <span>{checkpoint ? "Official topic checkpoint" : "Persisted practice"}</span>
          <h2 id={titleId}>{checkpoint ? "One reviewed MCQ for this topic" : "Check this skill with reviewed evidence"}</h2>
          <p>{checkpoint
            ? "The server selects one independently human-reviewed MCQ from your current publication and grades it deterministically. Retry as often as you need; repeated submissions are applied only once."
            : "Answers are graded deterministically on the server. Hints and reveals are recorded, and assisted work never awards mastery."}</p>
        </div>
        <ShieldCheck aria-hidden="true" />
      </header>

      {state === "idle" && (
        <div className={styles.practiceEmpty}>
          <p>{checkpoint
            ? "Answer a short checkpoint now, or return whenever you want another attempt. Only a published MCQ reviewed by a person can appear here."
            : "Start an unlimited fresh attempt. Only an activity from your active beta or verified enrollment can be selected."}</p>
          {draftPreviewCount > 0 && <small>{draftPreviewCount} draft preview item{draftPreviewCount === 1 ? " is" : "s are"} intentionally excluded until independent human review and publication.</small>}
          <button className="button button-primary" onClick={() => void createAttempt(true)}>
            <HelpCircle size={16} /> {checkpoint ? "Start checkpoint" : "Start practice"}
          </button>
        </div>
      )}

      {state === "loading" && <p className={styles.practiceLoading}><LoaderCircle className={styles.spin} /> Selecting a reviewed {checkpoint ? "MCQ" : "activity"}…</p>}

      {state === "degraded" && (
        <div className={styles.practiceDegraded} role="status">
          <AlertTriangle aria-hidden="true" />
          <div>
            <h3 ref={degradedHeadingRef} tabIndex={-1}>{checkpoint ? "Checkpoint is not available yet" : "Practice is not available yet"}</h3>
            <p>{degradedMessage(purpose, degradedReason)}</p>
            {error && <p>{error}</p>}
            <div className={styles.practiceActions}>
              <button className="button button-secondary" onClick={() => void createAttempt(false)}><RefreshCw size={15} /> Retry safely</button>
              <Link className="button button-secondary" href={`/requests?kind=missing_topic&skillId=${encodeURIComponent(skillId)}`}>Report a content problem</Link>
            </div>
          </div>
        </div>
      )}

      {specification && (state === "ready" || state === "submitting" || state === "graded") && (
        <div className={styles.practiceQuestion}>
          <div className={styles.practiceQuestionMeta}>
            <span>{checkpoint ? "official MCQ" : specification.kind.replaceAll("-", " ")}</span>
            <span>Attempt {attempt?.attemptNumber}</span>
            <span>{creation?.activity?.courseVersion}</span>
          </div>
          <h3 ref={questionHeadingRef} tabIndex={-1}>{specification.title}</h3>
          <p>{specification.prompt}</p>

          {specification.artifact.length > 0 && <pre className={styles.practiceArtifact}>{specification.artifact.join("\n")}</pre>}
          {specification.template && <pre className={styles.practiceArtifact}>{specification.template}</pre>}
          {specification.starterCode && <pre className={styles.practiceArtifact} aria-label={`${specification.language ?? "Code"} starter code`}>{specification.starterCode}</pre>}

          {specification.kind === "mcq" && (
            <fieldset className={styles.practiceChoices} disabled={state !== "ready"}>
              <legend>{specification.multiple ? "Select every correct answer" : "Select one answer"}</legend>
              {specification.options.map((option) => <label key={option.id}>
                <input
                  type={specification.multiple ? "checkbox" : "radio"}
                  name={`practice-${attempt?.id}`}
                  checked={selected.includes(option.id)}
                  onChange={() => toggleOption(option.id)}
                />
                <span>{option.text}</span>
              </label>)}
            </fieldset>
          )}

          {specification.kind === "fill-gap" && (
            <div className={styles.practiceGaps}>
              {specification.gaps.map((gap) => <label key={gap.id}>
                <span>{gap.label}</span>
                <input
                  disabled={state !== "ready"}
                  value={gaps[gap.id] ?? ""}
                  onChange={(event) => setGaps((current) => ({ ...current, [gap.id]: event.target.value }))}
                />
              </label>)}
            </div>
          )}

          {!["mcq", "fill-gap"].includes(specification.kind) && (
            <label className={styles.practiceTextAnswer}>
              <span>{specification.kind === "code-completion" ? "Your completed code" : "Your answer"}</span>
              <textarea
                disabled={state !== "ready"}
                value={text}
                onChange={(event) => setText(event.target.value)}
                spellCheck={specification.kind !== "code-completion"}
              />
            </label>
          )}

          {!checkpoint && state !== "graded" && specification.help.totalSteps > 0 && (
            <div className={styles.hintLadder} aria-label="Progressive help">
              {revealedHelp.map((entry) => entry.help && <p key={entry.helpStep}><Lightbulb size={15} /><span><strong>{entry.help.kind === "hint" ? `Hint ${entry.helpStep}` : entry.help.kind === "alternate" ? "Another way to think about it" : entry.help.kind === "example" ? "Worked example" : "Recorded solution reveal"}</strong>{entry.help.answer && <code>{entry.help.answer}</code>}{entry.help.content}</span></p>)}
              <div className={styles.practiceActions}>
                {!helpExhausted && revealedHelp.length < specification.help.totalSteps && <button className="button button-secondary" disabled={state !== "ready" || helpBusy} onClick={() => void revealNextHelp()}>{helpBusy ? "Saving help…" : specification.help.hasSolution && revealedHelp.length === specification.help.totalSteps - 1 ? "Reveal solution and record help" : "Show next help"}</button>}
                {revealedHelp.some((entry) => entry.requiresFreshAttempt) && <button className="button button-secondary" onClick={() => void createAttempt(true)}><RotateCcw size={15} /> Start a fresh attempt</button>}
              </div>
            </div>
          )}

          {error && <p className={styles.practiceError} role="alert">{error}</p>}

          {state !== "graded" && (
            <div className={styles.practiceSubmitRow}>
              <button className="button button-primary" disabled={!answered || state !== "ready"} onClick={() => void submit()}>
                {state === "submitting" ? <LoaderCircle className={styles.spin} size={16} /> : <CheckCircle2 size={16} />} Check answer
              </button>
              <button className="button button-secondary" disabled={state !== "ready"} onClick={() => void submit({ unknown: true })}>I don’t know</button>
              <Link href={`/requests?kind=missing_topic&skillId=${encodeURIComponent(skillId)}`}>Report a content problem</Link>
            </div>
          )}

          {state === "graded" && result && (
            <div className={styles.practiceResult} data-correct={result.feedback?.correct ?? false} role="status" aria-live="polite">
              {result.feedback?.correct ? <CheckCircle2 aria-hidden="true" /> : <RotateCcw aria-hidden="true" />}
              <div>
                <h3 ref={resultHeadingRef} tabIndex={-1}>{result.feedback?.headline ?? (result.state === "degraded" ? "Result unavailable" : "Response saved")}</h3>
                {result.feedback ? <>
                  <p>{result.feedback.why}</p>
                  <small>{checkpoint
                    ? "Your checkpoint response was saved as deterministic official evidence. Replaying this submission cannot duplicate it."
                    : result.feedback.independent ? "Independent practice evidence saved." : "Assisted practice evidence saved; it cannot prove mastery."}</small>
                  {result.feedback.remediation.map((item) => <article key={item.tag}>
                    <strong>Review: {item.tag.replaceAll(/[._-]/g, " ")}</strong>
                    <p>{item.explanation}</p>
                    <p><b>Retry focus:</b> {item.retryPrompt}</p>
                  </article>)}
                  {result.feedback.solution && <article>
                    <strong>Recorded solution reveal</strong>
                    <pre>{result.feedback.solution.answer}</pre>
                    <p>{result.feedback.solution.explanation}</p>
                  </article>}
                </> : <p>The server saved the response but could not produce safe deterministic feedback. Start a fresh attempt after the activity is repaired.</p>}
                <div className={styles.practiceActions}>
                  <button className="button button-primary" onClick={() => void createAttempt(true)}><RotateCcw size={15} /> {checkpoint ? "Try another checkpoint" : "Try a fresh question"}</button>
                  <Link className="button button-secondary" href={`/requests?kind=missing_topic&skillId=${encodeURIComponent(skillId)}`}>Report feedback mismatch</Link>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

/** A key boundary discards all response/assistance state when navigation reuses
 * the lesson shell for another skill, without synchronously resetting effects. */
export function PracticePanel(props: {
  readonly skillId: string;
  readonly draftPreviewCount?: number;
  readonly purpose?: PracticePanelPurpose;
}) {
  const purpose = props.purpose ?? "practice";
  return <PracticePanelState key={`${props.skillId}:${purpose}`} {...props} purpose={purpose} />;
}
