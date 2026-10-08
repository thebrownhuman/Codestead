"use client";

import { useId, useRef, useState, type ReactNode } from "react";
import { parseRunnerProblems, type RunnerProblem } from "./runner-problems";
import styles from "./runner-panel.module.css";

const tabs = ["Output", "Problems", "Input"] as const;

export function RunnerPanel({ output, input, stderr, onJump, resetKey = "" }: {
  output: ReactNode; input: ReactNode; stderr: string; resetKey?: string; onJump(problem: RunnerProblem): void;
}) {
  const id = useId();
  const [selection, setSelection] = useState({ index: 0, resetKey });
  const active = selection.resetKey === resetKey ? selection.index : 0;
  const setActive = (index: number) => setSelection({ index, resetKey });
  const buttons = useRef<Array<HTMLButtonElement | null>>([]);
  const problems = parseRunnerProblems(stderr);
  const panels = [output, active === 1 ? <div key="problems" className={styles.problems}>
    {problems.length === 0 ? <p>No recognized problems. See Output for the full log.</p> : problems.map((problem, index) =>
      <button key={index} type="button" onClick={() => onJump(problem)}>
        <span>{problem.file}:{problem.line}:{problem.column}</span> {problem.message}
      </button>)}
  </div> : null, input];
  return <div className={styles.panel}>
    <div role="tablist" aria-label="Runner panel" className={styles.tabs}>
      {tabs.map((name, index) => <button key={name} ref={button => { buttons.current[index] = button; }}
        type="button" role="tab" id={`${id}-tab-${index}`} aria-controls={`${id}-panel-${index}`}
        aria-selected={active === index} tabIndex={active === index ? 0 : -1}
        onClick={() => setActive(index)} onKeyDown={event => {
          const next = event.key === "ArrowRight" ? (index + 1) % tabs.length
            : event.key === "ArrowLeft" ? (index + tabs.length - 1) % tabs.length
            : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : null;
          if (next !== null) { event.preventDefault(); setActive(next); buttons.current[next]?.focus(); }
        }}>{name}{name === "Problems" && problems.length > 0 ? ` (${problems.length})` : ""}</button>)}
      <button type="button" role="tab" disabled aria-selected={false} tabIndex={-1}>Terminal <small>(coming soon)</small></button>
    </div>
    {panels.map((content, index) => <div key={index} role="tabpanel" id={`${id}-panel-${index}`}
      aria-labelledby={`${id}-tab-${index}`} hidden={active !== index} tabIndex={0}>{content}</div>)}
  </div>;
}
