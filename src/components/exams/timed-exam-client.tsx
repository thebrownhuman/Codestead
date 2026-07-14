"use client";

import {
  AlertCircle,
  ArrowLeft,
  CheckCircle2,
  Clock3,
  Code2,
  Expand,
  FileWarning,
  LoaderCircle,
  Play,
  RotateCcw,
  Save,
  Send,
  ShieldCheck,
  TerminalSquare,
  Wifi,
  WifiOff,
} from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type {
  ClientExamEventType,
  ExamAnswer,
  ExamRunnerResult,
  ExamSessionView,
  PublicExamItem,
} from "@/lib/exams/contracts";
import { remainingExamSeconds, serverClockOffsetMs } from "@/app/api/exams/_lib/policy";

import styles from "./exams.module.css";

interface PendingEvent {
  readonly clientEventId: string;
  readonly type: ClientExamEventType;
  readonly metadata: Readonly<Record<string, unknown>>;
}

function timerLabel(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
}

function initialAnswers(exam: ExamSessionView): Record<string, ExamAnswer> {
  const values: Record<string, ExamAnswer> = {};
  for (const item of exam.form.items) {
    values[item.id] = exam.answers[item.id]?.answer ?? (
      item.kind === "code"
        ? { sourceCode: item.starterCode ?? "", language: item.language }
        : { text: "" }
    );
  }
  return values;
}

function sourceOutput(result: ExamRunnerResult): string {
  const stdout = result.run?.stdout ?? result.compile.stdout;
  const stderr = result.run?.stderr ?? result.compile.stderr;
  return [stdout, stderr].filter(Boolean).join("\n") || "Program completed with no output.";
}

function appealStatusCopy(appeal: NonNullable<ExamSessionView["appeal"]>): string {
  if (appeal.status === "needs_learner_input") return "The reviewer needs more information";
  if (appeal.status === "under_review" && appeal.decision === "needs_learner_input") return "Your reply was sent; human review has resumed";
  if (appeal.decision === "overturned") return "Appeal granted; corrective review is pending";
  if (appeal.decision === "upheld") return "Review complete; the original result was upheld";
  return "Appeal pending human review";
}

function ExamResultPanel({ exam, onRefresh }: { exam: ExamSessionView; onRefresh: () => Promise<void> }) {
  const result = exam.result;
  const [appealOpen, setAppealOpen] = useState(false);
  const [category, setCategory] = useState<"scoring" | "technical" | "integrity" | "accessibility">("scoring");
  const [reason, setReason] = useState("");
  const [reply, setReply] = useState("");
  const [sending, setSending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const replyRequestRef = useRef<{ message: string; id: string } | null>(null);

  async function appeal() {
    if (reason.trim().length < 20) {
      setMessage("Please give at least 20 characters so a reviewer has useful context.");
      return;
    }
    setSending(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/exams/${exam.sessionId}/appeal`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ clientRequestId: crypto.randomUUID(), category, reason }),
      });
      const body = await response.json() as { error?: string };
      if (!response.ok) throw new Error(body.error ?? "Appeal could not be submitted.");
      setMessage("Appeal submitted. The result is now queued for review.");
      setAppealOpen(false);
      await onRefresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Appeal could not be submitted.");
    } finally {
      setSending(false);
    }
  }

  async function sendAppealReply() {
    const normalized = reply.trim();
    if (normalized.length < 20) {
      setMessage("Please give at least 20 characters so the reviewer has useful context.");
      return;
    }
    if (replyRequestRef.current?.message !== normalized) {
      replyRequestRef.current = { message: normalized, id: crypto.randomUUID() };
    }
    setSending(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/exams/${exam.sessionId}/appeal/reply`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          clientRequestId: replyRequestRef.current.id,
          message: normalized,
        }),
      });
      const body = await response.json() as { error?: string; duplicate?: boolean };
      if (!response.ok) throw new Error(body.error ?? "Your appeal reply could not be submitted.");
      setMessage(body.duplicate ? "Your reply was already recorded safely." : "Your reply was sent. Human review has resumed.");
      setReply("");
      replyRequestRef.current = null;
      await onRefresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Your appeal reply could not be submitted.");
    } finally {
      setSending(false);
    }
  }

  if (!result) {
    return (
      <div className={styles.resultPage}>
        <LoaderCircle className={styles.spin} />
        <h1>Finalization is in progress</h1>
        <p>The server has stopped accepting changes and is completing available deterministic checks.</p>
        <button className="button button-secondary" onClick={() => void onRefresh()}>Refresh status</button>
      </div>
    );
  }
  const pending = result.gradingStatus === "pending-review";
  return (
    <div className={styles.resultPage}>
      <Link className={styles.backLink} href="/exams"><ArrowLeft size={16} /> All exams</Link>
      <div className={`${styles.resultCard} card`}>
        <span className={pending ? styles.pendingIcon : styles.passedIcon}>
          {pending ? <FileWarning size={30} /> : <CheckCircle2 size={30} />}
        </span>
        <span className={styles.eyebrow}>{exam.form.courseTitle} · {exam.form.moduleTitle}</span>
        <h1>{pending ? "Submitted for review" : result.outcome.replaceAll("_", " ").toLocaleLowerCase()}</h1>
        {pending ? (
          <p>
            This form contains {result.pendingReviewItemIds.length} question{result.pendingReviewItemIds.length === 1 ? "" : "s"}
            {" "}without reviewed answer or test evidence. No official numeric score was invented.
          </p>
        ) : (
          <div className={styles.officialScore}>
            <strong>{Math.round(result.officialScorePercent ?? 0)}%</strong>
            <span>{result.earnedPoints} of {result.possiblePoints} points</span>
          </div>
        )}
        {exam.form.purpose === "mastery-recheck" && (
          <div className={styles.remediationBox}>
            <strong>Prior pass protected</strong>
            <p>This shorter form can add mastery evidence, but its result cannot replace or lower the passing exam that scheduled it.</p>
          </div>
        )}
        <div className={styles.resultMeta}>
          <span><Clock3 size={15} /> Finalized {new Date(result.finalizedAt).toLocaleString()}</span>
          <span><ShieldCheck size={15} /> {result.finalizedBy === "deadline" ? "Server deadline" : "Learner submission"}</span>
          {result.infrastructureFailure && <span><AlertCircle size={15} /> Technical incident flagged</span>}
        </div>
        {result.remediation.required && (
          <div className={styles.remediationBox}>
            <strong>Remediation required before retake</strong>
            <p>Review these targets, complete fresh practice, then attest completion when the cooldown opens.</p>
            <ul>{result.remediation.targets.map((target) => <li key={target}>{target}</li>)}</ul>
          </div>
        )}
        {exam.retake && !exam.retake.eligible && exam.retake.nextEligibleAt && (
          <p className={styles.cooldown}>Retake opens {new Date(exam.retake.nextEligibleAt).toLocaleString()}.</p>
        )}
        {!exam.appealSubmitted && !appealOpen && (
          <button className="button button-secondary" type="button" onClick={() => setAppealOpen(true)}>
            Request a review
          </button>
        )}
        {exam.appeal && (
          <div className={styles.appealState} role="status">
            <CheckCircle2 size={15} />
            <span>
              <strong>{appealStatusCopy(exam.appeal)}</strong>
              {exam.appeal.decisionReason && <small>{exam.appeal.decisionReason}</small>}
            </span>
          </div>
        )}
        {exam.appealSubmitted && !exam.appeal && <p className={styles.appealState}><CheckCircle2 size={15} /> Appeal pending human review</p>}
        {exam.appeal?.status === "needs_learner_input" && (
          <div className={styles.appealForm}>
            <label>
              <span>Your response to the reviewer</span>
              <textarea
                maxLength={2_000}
                minLength={20}
                onChange={(event) => {
                  setReply(event.target.value);
                  replyRequestRef.current = null;
                }}
                value={reply}
              />
            </label>
            <div><button className="button button-primary" disabled={sending} onClick={() => void sendAppealReply()} type="button">{sending ? "Sending…" : "Send response"}</button></div>
          </div>
        )}
        {appealOpen && (
          <div className={styles.appealForm}>
            <label><span>Review category</span><select value={category} onChange={(event) => setCategory(event.target.value as typeof category)}><option value="scoring">Scoring</option><option value="technical">Technical incident</option><option value="integrity">Integrity record</option><option value="accessibility">Accessibility</option></select></label>
            <label><span>What should the reviewer inspect?</span><textarea value={reason} onChange={(event) => setReason(event.target.value)} maxLength={1_000} /></label>
            <div><button className="button button-primary" disabled={sending} onClick={() => void appeal()}>{sending ? "Submitting…" : "Submit appeal"}</button><button className="button button-ghost" disabled={sending} onClick={() => setAppealOpen(false)}>Cancel</button></div>
          </div>
        )}
        {message && <p className={styles.resultMessage} role="status">{message}</p>}
      </div>
    </div>
  );
}

function ActiveExam({ initialExam, onRefresh }: { initialExam: ExamSessionView; onRefresh: () => Promise<void> }) {
  const [exam, setExam] = useState(initialExam);
  const [activeIndex, setActiveIndex] = useState(0);
  const [answers, setAnswers] = useState<Record<string, ExamAnswer>>(() => initialAnswers(initialExam));
  const [remaining, setRemaining] = useState(() => remainingExamSeconds(
    initialExam.serverDeadlineAt,
    Date.now(),
    serverClockOffsetMs(initialExam.serverNow, Date.now()),
  ));
  const [saveState, setSaveState] = useState<"saved" | "saving" | "unsaved" | "offline">("saved");
  const [online, setOnline] = useState(() => typeof navigator === "undefined" || navigator.onLine);
  const [submitting, setSubmitting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [runState, setRunState] = useState<Record<string, { busy: boolean; label?: string; output?: string }>>({});
  const [stdin, setStdin] = useState<Record<string, string>>({});
  const answersRef = useRef(answers);
  const revisionsRef = useRef<Record<string, number>>(
    Object.fromEntries(Object.entries(initialExam.answers).map(([key, value]) => [key, value.revision])),
  );
  const dirtyRef = useRef(new Set<string>());
  const timersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const chainsRef = useRef(new Map<string, Promise<void>>());
  const clockOffsetRef = useRef(serverClockOffsetMs(initialExam.serverNow, Date.now()));
  const queuedEventsRef = useRef<PendingEvent[]>([]);
  const expiryStartedRef = useRef(false);
  const activeItem = exam.form.items[activeIndex]!;
  const active = exam.status === "active";

  const postEvent = useCallback(async (event: PendingEvent) => {
    try {
      const response = await fetch(`/api/exams/${initialExam.sessionId}/events`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(event),
        keepalive: true,
      });
      if (!response.ok) throw new Error("event rejected");
    } catch {
      if (!queuedEventsRef.current.some((queued) => queued.clientEventId === event.clientEventId)) {
        queuedEventsRef.current.push(event);
      }
    }
  }, [initialExam.sessionId]);

  const logEvent = useCallback((type: ClientExamEventType, metadata: Readonly<Record<string, unknown>> = {}) => {
    const event: PendingEvent = { clientEventId: crypto.randomUUID(), type, metadata };
    if (!navigator.onLine) queuedEventsRef.current.push(event);
    else void postEvent(event);
  }, [postEvent]);

  const performSave = useCallback(async (itemId: string) => {
    if (!dirtyRef.current.has(itemId)) return;
    setSaveState("saving");
    const sent = answersRef.current[itemId] ?? {};
    let baseRevision = revisionsRef.current[itemId] ?? 0;
    for (let attemptNumber = 0; attemptNumber < 2; attemptNumber += 1) {
      try {
        const response = await fetch(`/api/exams/${initialExam.sessionId}/autosave`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ itemId, baseRevision, answer: sent }),
        });
        const body = await response.json() as {
          saved?: { revision: number };
          code?: string;
          currentRevision?: number;
          error?: string;
        };
        if (response.status === 409 && body.code === "AUTOSAVE_REVISION_CONFLICT" && typeof body.currentRevision === "number") {
          baseRevision = body.currentRevision;
          revisionsRef.current[itemId] = baseRevision;
          continue;
        }
        if (!response.ok || !body.saved) throw new Error(body.error ?? "Autosave failed.");
        revisionsRef.current[itemId] = body.saved.revision;
        if (JSON.stringify(answersRef.current[itemId] ?? {}) === JSON.stringify(sent)) {
          dirtyRef.current.delete(itemId);
        }
        setSaveState(dirtyRef.current.size === 0 ? "saved" : "unsaved");
        return;
      } catch {
        setSaveState(navigator.onLine ? "unsaved" : "offline");
        return;
      }
    }
    setSaveState("unsaved");
  }, [initialExam.sessionId]);

  const queueSave = useCallback((itemId: string): Promise<void> => {
    const prior = chainsRef.current.get(itemId) ?? Promise.resolve();
    const next = prior.catch(() => undefined).then(() => performSave(itemId));
    chainsRef.current.set(itemId, next);
    return next;
  }, [performSave]);

  const flushAll = useCallback(async () => {
    for (const timer of timersRef.current.values()) clearTimeout(timer);
    timersRef.current.clear();
    await Promise.all([...dirtyRef.current].map((itemId) => queueSave(itemId)));
  }, [queueSave]);

  function updateAnswer(item: PublicExamItem, value: string) {
    const next: ExamAnswer = item.kind === "code"
      ? { sourceCode: value, language: item.language }
      : { text: value };
    const updated = { ...answersRef.current, [item.id]: next };
    answersRef.current = updated;
    setAnswers(updated);
    dirtyRef.current.add(item.id);
    setSaveState("unsaved");
    const existingTimer = timersRef.current.get(item.id);
    if (existingTimer) clearTimeout(existingTimer);
    timersRef.current.set(item.id, setTimeout(() => {
      timersRef.current.delete(item.id);
      void queueSave(item.id);
    }, 1_000));
  }

  const submit = useCallback(async (deadline: boolean) => {
    if (submitting || (!deadline && !window.confirm("Submit this exam? You cannot change answers afterward."))) return;
    setSubmitting(true);
    setNotice(deadline ? "The server deadline has arrived. Finalizing the latest successful autosaves…" : "Saving and finalizing…");
    await flushAll();
    try {
      const response = await fetch(`/api/exams/${initialExam.sessionId}/submit`, { method: "POST" });
      const body = await response.json() as { exam?: ExamSessionView; error?: string };
      if (!response.ok || !body.exam) throw new Error(body.error ?? "Finalization is still pending.");
      setExam(body.exam);
      setNotice(null);
      await onRefresh();
    } catch (error) {
      setNotice(
        deadline
          ? "You appear offline. The server deadline still applies and will finalize the latest autosave when contact resumes."
          : error instanceof Error ? error.message : "Submission could not be confirmed.",
      );
    } finally {
      setSubmitting(false);
    }
  }, [flushAll, initialExam.sessionId, onRefresh, submitting]);

  useEffect(() => {
    if (!active) return;
    const interval = setInterval(() => {
      const seconds = remainingExamSeconds(exam.serverDeadlineAt, Date.now(), clockOffsetRef.current);
      setRemaining(seconds);
      if (seconds === 0 && !expiryStartedRef.current) {
        expiryStartedRef.current = true;
        void submit(true);
      }
    }, 500);
    return () => clearInterval(interval);
  }, [active, exam.serverDeadlineAt, submit]);

  useEffect(() => {
    if (!active) return;
    const interval = setInterval(() => {
      void fetch(`/api/exams/${initialExam.sessionId}/heartbeat`, { method: "POST" })
        .then(async (response) => {
          const body = await response.json() as {
            status?: ExamSessionView["status"];
            serverNow?: string;
            serverDeadlineAt?: string;
          };
          if (!response.ok) throw new Error("heartbeat rejected");
          if (body.serverNow) clockOffsetRef.current = serverClockOffsetMs(body.serverNow, Date.now());
          if (body.status && body.status !== "active") await onRefresh();
        })
        .catch(() => setOnline(false));
    }, 15_000);
    return () => clearInterval(interval);
  }, [active, initialExam.sessionId, onRefresh]);

  useEffect(() => {
    const flushQueued = () => {
      setOnline(true);
      const queued = queuedEventsRef.current.splice(0);
      queued.forEach((event) => void postEvent(event));
      logEvent("connection_restored", { online: true });
      void flushAll();
    };
    const offline = () => {
      setOnline(false);
      logEvent("connection_lost", { online: false });
    };
    const blur = () => logEvent("window_blur", { target: "window" });
    const focus = () => logEvent("window_focus", { target: "window" });
    const visibility = () => logEvent(
      document.visibilityState === "hidden" ? "visibility_hidden" : "visibility_visible",
      { visibilityState: document.visibilityState },
    );
    const fullscreen = () => logEvent(
      document.fullscreenElement ? "fullscreen_enter" : "fullscreen_exit",
      { fullscreen: Boolean(document.fullscreenElement) },
    );
    const beforeUnload = () => {
      const event: PendingEvent = {
        clientEventId: crypto.randomUUID(),
        type: "navigation_attempt",
        metadata: { reason: "beforeunload" },
      };
      navigator.sendBeacon(
        `/api/exams/${initialExam.sessionId}/events`,
        new Blob([JSON.stringify(event)], { type: "application/json" }),
      );
    };
    window.addEventListener("online", flushQueued);
    window.addEventListener("offline", offline);
    window.addEventListener("blur", blur);
    window.addEventListener("focus", focus);
    window.addEventListener("beforeunload", beforeUnload);
    document.addEventListener("visibilitychange", visibility);
    document.addEventListener("fullscreenchange", fullscreen);
    return () => {
      window.removeEventListener("online", flushQueued);
      window.removeEventListener("offline", offline);
      window.removeEventListener("blur", blur);
      window.removeEventListener("focus", focus);
      window.removeEventListener("beforeunload", beforeUnload);
      document.removeEventListener("visibilitychange", visibility);
      document.removeEventListener("fullscreenchange", fullscreen);
    };
  }, [flushAll, initialExam.sessionId, logEvent, postEvent]);

  useEffect(() => {
    const timers = timersRef.current;
    const interval = setInterval(() => void flushAll(), 10_000);
    return () => {
      clearInterval(interval);
      for (const timer of timers.values()) clearTimeout(timer);
    };
  }, [flushAll]);

  async function execute(mode: "COMPILE" | "RUN") {
    if (activeItem.kind !== "code") return;
    setRunState((current) => ({ ...current, [activeItem.id]: { busy: true, label: mode } }));
    await queueSave(activeItem.id);
    try {
      const response = await fetch(`/api/exams/${exam.sessionId}/run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          itemId: activeItem.id,
          sourceCode: answersRef.current[activeItem.id]?.sourceCode ?? "",
          stdin: stdin[activeItem.id] ?? "",
          mode,
          clientRequestId: crypto.randomUUID(),
        }),
      });
      const body = await response.json() as { result?: ExamRunnerResult; error?: string };
      if (!response.ok || !body.result) throw new Error(body.error ?? "Runner did not return a result.");
      setRunState((current) => ({
        ...current,
        [activeItem.id]: { busy: false, label: body.result!.status, output: sourceOutput(body.result!) },
      }));
    } catch (error) {
      setRunState((current) => ({
        ...current,
        [activeItem.id]: { busy: false, label: "INFRASTRUCTURE_ERROR", output: error instanceof Error ? error.message : "Runner unavailable." },
      }));
    }
  }

  if (exam.status !== "active") return <ExamResultPanel exam={exam} onRefresh={onRefresh} />;
  const answeredCount = exam.form.items.filter((item) => {
    const answer = answers[item.id];
    return item.kind === "code" ? Boolean(answer?.sourceCode?.trim()) : Boolean(answer?.text?.trim());
  }).length;
  const output = runState[activeItem.id];
  return (
    <div className={styles.examWorkspace}>
      <header className={styles.examHeader}>
        <Link href="/exams" onClick={() => logEvent("navigation_attempt", { target: "/exams" })}><ArrowLeft size={16} /> Exams</Link>
        <div className={styles.examIdentity}><span>{exam.form.purpose === "mastery-recheck" ? "Targeted mastery recheck" : exam.form.courseTitle}</span><strong>{exam.form.moduleTitle}</strong></div>
        <div className={`${styles.timer} ${remaining <= 60 ? styles.timerUrgent : ""}`} aria-live="polite"><Clock3 size={18} /><span><small>Server time left</small><strong>{timerLabel(remaining)}</strong></span></div>
        <div className={styles.connection}>{online ? <Wifi size={16} /> : <WifiOff size={16} />}<span>{online ? "Connected" : "Offline"}</span></div>
        <div className={styles.saveState} data-state={saveState}><Save size={15} /> {saveState}</div>
      </header>
      <div className={styles.examBody}>
        <aside className={styles.questionNav}>
          <span>QUESTIONS</span>
          <div className={styles.questionProgress}><strong>{answeredCount}/{exam.form.items.length}</strong><small>answered locally</small><i><b style={{ width: `${(answeredCount / exam.form.items.length) * 100}%` }} /></i></div>
          {exam.form.items.map((item, index) => {
            const answer = answers[item.id];
            const answered = item.kind === "code" ? Boolean(answer?.sourceCode?.trim()) : Boolean(answer?.text?.trim());
            return <button className={index === activeIndex ? styles.activeQuestion : ""} key={item.id} onClick={() => setActiveIndex(index)}><b>{answered ? <CheckCircle2 size={14} /> : index + 1}</b><span><strong>{item.title}</strong><small>{item.kind === "code" ? item.language?.toUpperCase() : "Written response"}</small></span></button>;
          })}
          <div className={styles.noAssistance}><ShieldCheck size={16} /><span><strong>Independent mode</strong><small>Tutor and notes are unavailable.</small></span></div>
        </aside>
        <main className={styles.questionArea}>
          <div className={styles.questionTopline}><span>Question {activeIndex + 1} of {exam.form.items.length}</span><i>{activeItem.points} points</i><i>{activeItem.verificationAvailable ? "Deterministic evidence" : "Review required"}</i></div>
          <h1>{activeItem.title}</h1>
          <p className={styles.questionPrompt}>{activeItem.prompt}</p>
          {activeItem.kind === "short-answer" ? (
            <label className={styles.answerField}>
              <span>Your response</span>
              <textarea
                value={answers[activeItem.id]?.text ?? ""}
                onChange={(event) => updateAnswer(activeItem, event.target.value)}
                onPaste={(event) => logEvent("paste", { itemId: activeItem.id, pastedCharacters: event.clipboardData.getData("text").length })}
                placeholder="Explain the outcome, then include an example and a boundary case…"
                autoFocus
              />
            </label>
          ) : (
            <div className={styles.codeQuestion}>
              <div className={styles.codeToolbar}><span><Code2 size={15} /> {activeItem.language?.toUpperCase()}</span><div><button onClick={() => updateAnswer(activeItem, activeItem.starterCode ?? "")}><RotateCcw size={14} /> Reset</button><button onClick={() => void document.documentElement.requestFullscreen()}><Expand size={14} /> Fullscreen</button><button disabled={output?.busy} onClick={() => void execute("COMPILE")}><TerminalSquare size={14} /> Compile</button><button className={styles.runButton} disabled={output?.busy} onClick={() => void execute("RUN")}><Play size={14} /> Run</button></div></div>
              <textarea
                className={styles.codeEditor}
                aria-label="Source code"
                spellCheck={false}
                value={answers[activeItem.id]?.sourceCode ?? ""}
                onChange={(event) => updateAnswer(activeItem, event.target.value)}
                onPaste={(event) => logEvent("paste", { itemId: activeItem.id, pastedCharacters: event.clipboardData.getData("text").length })}
              />
              <label className={styles.stdinField}><span>Standard input (optional)</span><textarea value={stdin[activeItem.id] ?? ""} onChange={(event) => setStdin((current) => ({ ...current, [activeItem.id]: event.target.value }))} /></label>
              <div className={styles.runnerOutput}><span><TerminalSquare size={14} /> Raw runner output {output?.label && <i>{output.label}</i>}</span><pre>{output?.busy ? "Running in the isolated container…" : output?.output ?? "Compile or run to inspect unassisted output."}</pre></div>
            </div>
          )}
          {notice && <div className={styles.workspaceNotice} role="status"><AlertCircle size={17} /> {notice}</div>}
          <footer className={styles.questionActions}>
            <button className="button button-secondary" disabled={activeIndex === 0} onClick={() => setActiveIndex((value) => Math.max(0, value - 1))}>Previous</button>
            {activeIndex < exam.form.items.length - 1
              ? <button className="button button-primary" onClick={() => setActiveIndex((value) => value + 1)}>Save & next</button>
              : <button className="button button-primary" disabled={submitting} onClick={() => void submit(false)}>{submitting ? <LoaderCircle className={styles.spin} size={16} /> : <Send size={16} />} Submit final</button>}
          </footer>
        </main>
      </div>
    </div>
  );
}

export function TimedExamClient({ sessionId }: { sessionId: string }) {
  const [exam, setExam] = useState<ExamSessionView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch(`/api/exams/${sessionId}`, { cache: "no-store" });
      const body = await response.json() as { exam?: ExamSessionView; error?: string };
      if (!response.ok || !body.exam) throw new Error(body.error ?? "Exam session could not be loaded.");
      setExam(body.exam);
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Exam session could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    const timeout = setTimeout(() => void load(), 0);
    return () => clearTimeout(timeout);
  }, [load]);
  const stableKey = useMemo(() => exam
    ? `${exam.sessionId}:${exam.status}:${exam.result?.finalizedAt ?? "active"}:${exam.appeal?.status ?? "none"}:${exam.appeal?.updatedAt ?? "none"}`
    : "loading", [exam]);
  if (loading) return <div className={styles.loading}><LoaderCircle className={styles.spin} /> Restoring immutable exam form…</div>;
  if (error || !exam) return <div className={styles.loadError}><AlertCircle size={24} /><h1>Exam unavailable</h1><p>{error}</p><Link className="button button-secondary" href="/exams">Return to exams</Link></div>;
  return <ActiveExam key={stableKey} initialExam={exam} onRefresh={load} />;
}
