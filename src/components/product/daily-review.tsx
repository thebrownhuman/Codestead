"use client";

import Link from "next/link";
import {
  AlertTriangle,
  ArrowRight,
  BrainCircuit,
  Check,
  CheckCircle2,
  CircleDashed,
  LoaderCircle,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Target,
  XCircle,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { DailyReviewPayload } from "@/lib/daily-review/types";
import type {
  LearnerAttemptCreationPayload,
  LearnerPracticeSpecification,
} from "@/lib/learning-service/learner-activity";
import type { AttemptSubmissionResult } from "@/lib/learning-service/types";

import styles from "./daily-review.module.css";

type NetworkBody = { readonly error?: string; readonly code?: string };
type FocusTarget = "session" | "question" | "feedback" | "summary";

function answerFor(
  specification: LearnerPracticeSpecification,
  selected: readonly string[],
  gaps: Readonly<Record<string, string>>,
  text: string,
): Readonly<Record<string, unknown>> {
  if (specification.kind === "mcq") {
    return specification.multiple ? { selectedOptionIds: selected } : { value: selected[0] ?? "" };
  }
  if (specification.kind === "fill-gap") return { gaps };
  return { value: text };
}

function reasonLabel(reason: string): string {
  if (reason === "confirmed_misconception") return "Misconception check";
  if (reason === "overdue_review") return "Overdue review";
  return "Confidence builder";
}

function formatKind(kind: string): string {
  return kind.replaceAll("-", " ");
}

export function DailyReview({ enabled = true }: { readonly enabled?: boolean }) {
  const [payload, setPayload] = useState<DailyReviewPayload | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [gaps, setGaps] = useState<Record<string, string>>({});
  const [text, setText] = useState("");
  const [result, setResult] = useState<AttemptSubmissionResult | null>(null);
  const [focusTarget, setFocusTarget] = useState<FocusTarget | null>(null);
  const sessionStateRef = useRef<HTMLDivElement>(null);
  const questionRef = useRef<HTMLDivElement>(null);
  const feedbackRef = useRef<HTMLDivElement>(null);
  const summaryRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async () => {
    if (!enabled) return;
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/learning/daily-review", { cache: "no-store" });
      const body = await response.json().catch(() => ({})) as DailyReviewPayload & NetworkBody;
      if (!response.ok) throw new Error(body.error ?? "Daily review could not be loaded.");
      setPayload(body);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Daily review could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;
    let active = true;
    fetch("/api/learning/daily-review", { cache: "no-store" })
      .then(async (response) => {
        const body = await response.json().catch(() => ({})) as DailyReviewPayload & NetworkBody;
        if (!response.ok) throw new Error(body.error ?? "Daily review could not be loaded.");
        if (active) setPayload(body);
      })
      .catch((caught: unknown) => {
        if (active) setError(caught instanceof Error ? caught.message : "Daily review could not be loaded.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [enabled]);

  useEffect(() => {
    if (!focusTarget || busy || loading) return;
    const target = focusTarget === "session"
      ? sessionStateRef.current
      : focusTarget === "question"
        ? questionRef.current
        : focusTarget === "feedback"
          ? feedbackRef.current
          : summaryRef.current;
    if (!target) return;
    target.focus();
    setFocusTarget(null);
  }, [busy, focusTarget, loading, payload, result]);

  const session = payload?.session ?? null;
  const current = session?.items.find((item) => item.status === "pending") ?? null;
  const attempt = current?.attempt?.state === "ready" ? current.attempt : null;
  const specification = attempt?.activity?.specification ?? null;
  const answered = specification?.kind === "mcq"
    ? selected.length > 0
    : specification?.kind === "fill-gap"
      ? specification.gaps.every((gap) => Boolean(gaps[gap.id]?.trim()))
      : Boolean(text.trim());
  const progress = session?.questionCount === 5 ? session.completedCount * 20 : 0;
  const completedItems = useMemo(
    () => session?.items.filter((item) => item.status === "answered") ?? [],
    [session],
  );

  function clearAnswer() {
    setSelected([]);
    setGaps({});
    setText("");
    setResult(null);
    setError(null);
  }

  async function initialize() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/learning/daily-review", { method: "POST" });
      const body = await response.json().catch(() => ({})) as DailyReviewPayload & NetworkBody;
      if (!response.ok) throw new Error(body.error ?? "Today's review could not be prepared.");
      setPayload(body);
      setFocusTarget(body.session?.status === "completed" ? "summary" : "session");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Today's review could not be prepared.");
    } finally {
      setBusy(false);
    }
  }

  async function startQuestion() {
    if (!session || !current) return;
    setBusy(true);
    setError(null);
    clearAnswer();
    try {
      const response = await fetch(
        `/api/learning/daily-review/${encodeURIComponent(session.id)}/items/${encodeURIComponent(current.id)}/attempt`,
        { method: "POST" },
      );
      const body = await response.json().catch(() => ({})) as LearnerAttemptCreationPayload & NetworkBody;
      if (!response.ok) throw new Error(body.error ?? "The next reviewed question could not be opened.");
      if (body.state !== "ready" || !body.attempt || !body.activity) {
        throw new Error("This reserved question is no longer available. No answer was graded.");
      }
      setPayload((existing) => {
        if (!existing?.session) return existing;
        return {
          ...existing,
          session: {
            ...existing.session,
            items: existing.session.items.map((item) => item.id === current.id ? { ...item, attempt: body } : item),
          },
        } as DailyReviewPayload;
      });
      setFocusTarget("question");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The next question could not be opened.");
    } finally {
      setBusy(false);
    }
  }

  function toggleOption(optionId: string) {
    if (!specification) return;
    setSelected((currentSelection) => specification.multiple
      ? currentSelection.includes(optionId)
        ? currentSelection.filter((id) => id !== optionId)
        : [...currentSelection, optionId]
      : [optionId]);
  }

  async function submit() {
    if (!attempt?.attempt || !specification || busy || !answered) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/learning/attempts/${attempt.attempt.id}/submit`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          itemKey: specification.itemKey,
          responseRevision: 1,
          answer: answerFor(specification, selected, gaps, text),
          assistanceLevel: "A0",
          solutionRevealed: false,
        }),
      });
      const body = await response.json().catch(() => ({})) as AttemptSubmissionResult & NetworkBody;
      if (!response.ok) throw new Error(body.error ?? "Your answer could not be saved.");
      if (body.state !== "graded") {
        throw new Error("This answer could not be graded deterministically. It did not count toward review.");
      }
      setResult(body);
      setFocusTarget("feedback");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Your answer could not be saved.");
    } finally {
      setBusy(false);
    }
  }

  async function continueReview() {
    const nextTarget: FocusTarget = current?.position === 5 ? "summary" : "session";
    clearAnswer();
    await refresh();
    setFocusTarget(nextTarget);
  }

  if (!enabled) return null;

  return (
    <section className={styles.shell} id="daily-review" aria-labelledby="daily-review-title">
      <header className={styles.header}>
        <div className={styles.titleGroup}>
          <span className={styles.kicker}><Sparkles size={15} /> Daily five</span>
          <h2 id="daily-review-title">A short review built from what you learned</h2>
          <p>Five distinct, human-reviewed questions. Mistakes first, overdue memory checks next, then your lowest-confidence skills.</p>
        </div>
        <span className={styles.safety}><ShieldCheck size={16} /> Reviewed content only</span>
      </header>

      {loading && !payload && (
        <div className={styles.centerState} role="status">
          <LoaderCircle className={styles.spin} aria-hidden="true" />
          <strong>Checking today&apos;s learning history…</strong>
        </div>
      )}

      {error && (
        <div className={styles.error} role="alert">
          <AlertTriangle aria-hidden="true" />
          <span><strong>Review paused</strong><small>{error}</small></span>
          <button className="button button-secondary" onClick={() => void refresh()} disabled={loading || busy}>
            <RefreshCw size={15} /> Retry
          </button>
        </div>
      )}

      {!loading && payload?.state === "not_started" && (
        <div className={styles.launch}>
          <span className={styles.launchIcon}><BrainCircuit aria-hidden="true" /></span>
          <div>
            <strong>Ready for a five-question memory workout?</strong>
            <p>Today&apos;s set stays fixed after it is created, so refreshes and repeated clicks cannot swap your questions.</p>
          </div>
          <button className="button button-primary" onClick={() => void initialize()} disabled={busy}>
            {busy ? <LoaderCircle className={styles.spin} /> : <Target size={16} />}
            Build today&apos;s review
          </button>
        </div>
      )}

      {session?.status === "unavailable" && (
        <div className={styles.unavailable} ref={sessionStateRef} tabIndex={-1}>
          <AlertTriangle aria-hidden="true" />
          <div>
            <h3>Not enough reviewed questions yet</h3>
            <p>
              We found {session.availableItemCount} of the 5 distinct, previously learned skills required for a safe daily set.
              Draft or AI-only questions are never used to fill the gap.
            </p>
            <div className={styles.actions}>
              <button className="button button-secondary" onClick={() => void initialize()} disabled={busy}>
                <RefreshCw size={15} /> Check again
              </button>
              <Link className="button button-primary" href="/learn">Continue learning <ArrowRight size={15} /></Link>
              <Link className="button button-secondary" href="/requests">Report missing review content</Link>
            </div>
          </div>
        </div>
      )}

      {session && session.questionCount === 5 && session.status !== "completed" && current && (
        <div className={styles.reviewBody} ref={sessionStateRef} tabIndex={-1}>
          <div className={styles.progressHeader}>
            <div>
              <span>Question {current.position} of 5</span>
              <strong>{current.skillTitle}</strong>
              <small>{current.courseTitle} · {reasonLabel(current.priorityReason)}</small>
            </div>
            <span className={styles.confidence}>{current.confidencePercent}% confidence</span>
          </div>
          <div
            className={styles.progressTrack}
            role="progressbar"
            aria-label="Daily review completion"
            aria-valuemin={0}
            aria-valuemax={5}
            aria-valuenow={session.completedCount}
            aria-valuetext={`${session.completedCount} of 5 reviews completed`}
          >
            <i style={{ width: `${progress}%` }} />
          </div>
          <ol className={styles.steps} aria-label="Daily review progress">
            {session.items.map((item) => (
              <li key={item.id} data-state={item.status === "answered" ? "done" : item.id === current.id ? "current" : "waiting"}>
                {item.status === "answered" ? <Check size={14} /> : item.position}
                <span className="sr-only">Question {item.position}: {item.status}</span>
              </li>
            ))}
          </ol>

          {!attempt && (
            <div className={styles.questionLaunch}>
              <CircleDashed size={28} aria-hidden="true" />
              <div><strong>Your next question is reserved</strong><p>Opening it creates one idempotent quiz attempt. Repeated clicks cannot create duplicate evidence.</p></div>
              <button className="button button-primary" onClick={() => void startQuestion()} disabled={busy}>
                {busy ? <LoaderCircle className={styles.spin} /> : <ArrowRight size={16} />} Open question
              </button>
            </div>
          )}

          {attempt && specification && !result && (
            <div className={styles.questionCard} ref={questionRef} tabIndex={-1}>
              <div className={styles.questionMeta}>
                <span>{formatKind(specification.kind)}</span>
                <span>Independent review</span>
              </div>
              <h3>{specification.title}</h3>
              <p>{specification.prompt}</p>
              {specification.artifact.length > 0 && <pre>{specification.artifact.join("\n")}</pre>}
              {specification.template && <pre>{specification.template}</pre>}
              {specification.starterCode && <pre aria-label={`${specification.language ?? "Code"} starter code`}>{specification.starterCode}</pre>}

              {specification.kind === "mcq" && (
                <fieldset className={styles.choices} disabled={busy}>
                  <legend>{specification.multiple ? "Select every correct answer" : "Select one answer"}</legend>
                  {specification.options.map((option) => (
                    <label key={option.id} data-selected={selected.includes(option.id)}>
                      <input
                        type={specification.multiple ? "checkbox" : "radio"}
                        name={`daily-${current.id}`}
                        value={option.id}
                        checked={selected.includes(option.id)}
                        onChange={() => toggleOption(option.id)}
                      />
                      <span>{option.text}</span>
                    </label>
                  ))}
                </fieldset>
              )}
              {specification.kind === "fill-gap" && (
                <div className={styles.gaps}>
                  {specification.gaps.map((gap) => (
                    <label key={gap.id}>{gap.label}
                      <input value={gaps[gap.id] ?? ""} onChange={(event) => setGaps((values) => ({ ...values, [gap.id]: event.target.value }))} disabled={busy} />
                    </label>
                  ))}
                </div>
              )}
              {!["mcq", "fill-gap"].includes(specification.kind) && (
                <label className={styles.textAnswer}>
                  Your answer
                  <textarea value={text} onChange={(event) => setText(event.target.value)} rows={7} disabled={busy} />
                </label>
              )}
              <div className={styles.questionActions}>
                <Link href={current.href}>Review the lesson</Link>
                <button className="button button-primary" onClick={() => void submit()} disabled={!answered || busy}>
                  {busy ? <LoaderCircle className={styles.spin} /> : <CheckCircle2 size={16} />} Check answer
                </button>
              </div>
            </div>
          )}

          {result && (
            <div className={result.passed ? styles.correct : styles.incorrect} ref={feedbackRef} role="status" aria-live="polite" tabIndex={-1}>
              {result.passed ? <CheckCircle2 aria-hidden="true" /> : <XCircle aria-hidden="true" />}
              <div>
                <h3>{result.feedback?.headline ?? (result.passed ? "Correct" : "Not yet")}</h3>
                <p>{result.feedback?.why ?? "Your reviewed answer has been saved."}</p>
                {!result.passed && <small>This skill will stay visible in your targeted follow-up list.</small>}
                <button className="button button-primary" onClick={() => void continueReview()} disabled={loading}>
                  {current.position === 5 ? "See today’s summary" : "Next question"} <ArrowRight size={15} />
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {session?.status === "completed" && (
        <div className={styles.summary} ref={summaryRef} tabIndex={-1}>
          <div className={styles.summaryHero}>
            <span><CheckCircle2 aria-hidden="true" /></span>
            <div><strong>Daily five complete</strong><p>{completedItems.filter((item) => item.passed).length} of 5 correct. Every result is saved to your learning evidence.</p></div>
          </div>
          <div className={styles.summaryGrid}>
            {session.items.map((item) => (
              <article key={item.id} data-passed={item.passed === true}>
                {item.passed ? <CheckCircle2 size={18} /> : <Target size={18} />}
                <span><strong>{item.skillTitle}</strong><small>{item.passed ? "Secure today" : "Target for practice"}</small></span>
                <Link href={item.href}>{item.passed ? "Open" : "Practice"} <ArrowRight size={13} /></Link>
              </article>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
