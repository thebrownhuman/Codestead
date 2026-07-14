"use client";

import { ArrowRight, CheckCircle2, RotateCcw, ShieldCheck } from "lucide-react";
import { useMemo, useState } from "react";

import type { AtomicSkill, LearnerAssessmentBank, LearnerAssessmentItem } from "@/lib/content";

import styles from "./lesson-workspace.module.css";

type CheckResult = {
  correct: boolean;
  feedback: string;
  hint: string | null;
  stageAdvance: boolean;
  authoritativeEvidence: false;
  notice: string;
};

function responseFor(
  item: LearnerAssessmentItem,
  selected: string[],
  gaps: Record<string, string>,
  text: string,
) {
  if (item.kind === "mcq") return { selectedOptionIds: selected };
  if (item.kind === "fill-gap") return { gaps };
  return { trace: text };
}

export function DeterministicLogicGame({
  skill,
  bank,
}: {
  readonly skill: AtomicSkill;
  readonly bank: LearnerAssessmentBank;
}) {
  const challenges = useMemo(
    () => bank.items.filter((item) => item.kind !== "code").slice(0, 3),
    [bank.items],
  );
  const [stage, setStage] = useState(0);
  const [selected, setSelected] = useState<string[]>([]);
  const [gaps, setGaps] = useState<Record<string, string>>({});
  const [text, setText] = useState("");
  const [hintIndex, setHintIndex] = useState(0);
  const [hint, setHint] = useState<string | null>(null);
  const [result, setResult] = useState<CheckResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [complete, setComplete] = useState(false);

  function clearResponse() {
    setSelected([]);
    setGaps({});
    setText("");
    setHintIndex(0);
    setHint(null);
    setResult(null);
  }

  function replay() {
    setStage(0);
    setComplete(false);
    clearResponse();
  }

  if (!challenges.length) {
    return <div className={styles.game}><h3>Quest is being prepared.</h3><p>This draft skill has no safe client-side deterministic challenge yet. Use the lesson or code lab; no fake completion is awarded.</p></div>;
  }
  if (complete) {
    return <div className={styles.game}>
      <div className={styles.gameScene}><span className={styles.gameBot}>B</span><span className={styles.gameGoal}>★</span></div>
      <span className={styles.eyebrow}>Logic quest complete</span>
      <h3>You restored every checkpoint for {skill.title}.</h3>
      <p>This replayable draft game is practice only. It awarded no mastery, badge, exam credit, leaderboard points, or XP.</p>
      <button className="button button-secondary" onClick={replay} type="button"><RotateCcw size={15} /> Replay without XP</button>
    </div>;
  }

  const item = challenges[stage]!;
  async function check() {
    setBusy(true);
    setResult(null);
    try {
      const response = await fetch("/api/games/check", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          skillId: skill.id,
          itemId: item.id,
          response: responseFor(item, selected, gaps, text),
          hintIndex,
          clientRequestId: crypto.randomUUID(),
        }),
      });
      const body = (await response.json().catch(() => ({}))) as CheckResult & { error?: string };
      if (!response.ok) throw new Error(body.error ?? "The deterministic checker is unavailable.");
      setResult(body);
      setHint(body.hint);
      if (body.stageAdvance) {
        window.setTimeout(() => {
          if (stage >= challenges.length - 1) setComplete(true);
          else {
            setStage((value) => value + 1);
            clearResponse();
          }
        }, 700);
      }
    } catch (error) {
      setResult({
        correct: false,
        feedback: error instanceof Error ? error.message : "The deterministic checker is unavailable.",
        hint: null,
        stageAdvance: false,
        authoritativeEvidence: false,
        notice: "No learning evidence was recorded.",
      });
    } finally {
      setBusy(false);
    }
  }

  function revealHint() {
    const next = item.hints[Math.min(hintIndex, Math.max(0, item.hints.length - 1))] ??
      "Return to the lesson outcome and trace one before-and-after state.";
    setHint(next);
    setHintIndex((value) => value + 1);
  }

  const responseReady = item.kind === "mcq"
    ? selected.length > 0
    : item.kind === "fill-gap"
      ? item.gaps.every((gap) => Boolean(gaps[gap.id]?.trim()))
      : Boolean(text.trim());

  return <div className={styles.game}>
    <div className={styles.gameScene}>
      <span className={styles.gameBot}>B</span>
      <div className={styles.gamePath}>{challenges.map((challenge, index) => <i className={index <= stage ? styles.gameActive : ""} key={challenge.id}>{index + 1}</i>)}</div>
      <span className={styles.gameGoal}>★</span>
    </div>
    <span className={styles.eyebrow}>Deterministic logic quest · stage {stage + 1} of {challenges.length}</span>
    <h3>{item.title}</h3>
    <p>{item.prompt}</p>
    {item.kind === "mcq" && <fieldset className={styles.gameChoices}><legend>Choose the best answer</legend>{item.options.map((option) => <label key={option.id}><input checked={selected.includes(option.id)} name={item.id} onChange={() => setSelected([option.id])} type="radio" /><span>{option.text}</span></label>)}</fieldset>}
    {item.kind === "fill-gap" && <div className={styles.gameGaps}><pre>{item.template}</pre>{item.gaps.map((gap) => <label key={gap.id}><span>{gap.label}</span><input onChange={(event) => setGaps((current) => ({ ...current, [gap.id]: event.target.value }))} value={gaps[gap.id] ?? ""} /></label>)}</div>}
    {item.kind === "trace" && <textarea aria-label="Trace response" onChange={(event) => setText(event.target.value)} placeholder="Type the trace or observable result…" value={text} />}
    <div className={styles.gameActions}>
      <button className="button button-primary" disabled={busy || !responseReady} onClick={() => void check()} type="button">{busy ? "Checking…" : "Run action"}<ArrowRight size={15} /></button>
      <button className="button button-ghost" disabled={busy} onClick={revealHint} type="button">Use a hint</button>
    </div>
    {hint && <p className={styles.gameHint}><strong>Hint:</strong> {hint}</p>}
    {result && <div aria-live="polite" className={styles.gameFeedback} role="status">{result.correct ? <CheckCircle2 size={16} /> : <ShieldCheck size={16} />}<span><strong>{result.correct ? "Checkpoint restored" : "Not yet"}</strong><small>{result.feedback}</small><small>{result.notice}</small></span></div>}
    <p className={styles.safeGameNotice}><ShieldCheck size={14} /> {bank.provenance.reviewRequired ? "AI-assisted draft awaiting human review." : "Reviewed practice."} The server checks answers; the browser cannot award mastery.</p>
  </div>;
}
