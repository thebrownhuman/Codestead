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
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import {
  openBrowserOutbox,
  type BrowserOutboxRepository,
} from "@/lib/browser-durability/indexed-db";
import {
  purgeBrowserRecoveryData,
  withBrowserRecoveryRepository,
} from "@/lib/browser-durability/lifecycle";
import { useDraftCacheNamespace } from "@/lib/drafts/browser-cache-context";
import type {
  ClientExamEventType,
  ExamRunnerResult,
  ExamSessionView,
} from "@/lib/exams/contracts";
import {
  isExamSessionView,
  useDurableExamOutbox,
  type ExamAnswerSaveState,
} from "@/lib/exams/use-durable-exam-outbox";
import { remainingExamSeconds, serverClockOffsetMs } from "@/app/api/exams/_lib/policy";

import styles from "./exams.module.css";

function timerLabel(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
}

const SAVE_STATE_COPY: Record<ExamAnswerSaveState, string> = {
  "saving-local": "Saving on this browser...",
  "saved-local": "Saved locally on this browser.",
  syncing: "Syncing to Codestead...",
  "offline-saved-local": "Saved locally; Codestead will retry.",
  "server-saved": "Saved to Codestead.",
  "local-save-error": "Could not save on this browser. Copy your answer before leaving.",
  conflict: "Needs attention: choose which answer to keep.",
};

const TERMINAL_RECOVERY_STATUSES = new Set<ExamSessionView["status"]>([
  "submitted",
  "expired",
  "graded",
  "under_review",
  "invalidated",
]);

const FINAL_SUBMIT_TIMEOUT_MS = 10_000;

function navigateWindow(destination: string) {
  window.location.assign(destination);
}

function abortableSubmitStep<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error("Submission could not be confirmed."));
  return new Promise<T>((resolve, reject) => {
    const aborted = () => reject(new Error("Submission could not be confirmed."));
    signal.addEventListener("abort", aborted, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener("abort", aborted);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", aborted);
        reject(error);
      },
    );
  });
}

async function boundedFinalSubmit(sessionId: string, controller: AbortController) {
  const timeout = setTimeout(() => controller.abort(), FINAL_SUBMIT_TIMEOUT_MS);
  try {
    const response = await abortableSubmitStep(fetch(`/api/exams/${sessionId}/submit`, {
      method: "POST",
      signal: controller.signal,
    }), controller.signal);
    if (response.status === 401 || response.status === 403) {
      return { response, body: undefined };
    }
    const body = await abortableSubmitStep(response.json() as Promise<unknown>, controller.signal);
    return { response, body };
  } finally {
    clearTimeout(timeout);
  }
}

function responseField(body: unknown, field: "exam" | "error"): unknown {
  return typeof body === "object" && body !== null && !Array.isArray(body)
    ? (body as Record<string, unknown>)[field]
    : undefined;
}

function responseError(body: unknown, fallback: string): string {
  const error = responseField(body, "error");
  return typeof error === "string" && error.length > 0 ? error : fallback;
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

function ExamResultPanel({
  exam,
  onAuthDenial,
  onRefresh,
}: {
  exam: ExamSessionView;
  onAuthDenial: () => Promise<void>;
  onRefresh: () => Promise<boolean>;
}) {
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
      if (response.status === 401 || response.status === 403) {
        await onAuthDenial();
        return;
      }
      const body = await response.json().catch(() => ({})) as { error?: string };
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
      if (response.status === 401 || response.status === 403) {
        await onAuthDenial();
        return;
      }
      const body = await response.json().catch(() => ({})) as { error?: string; duplicate?: boolean };
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

type DurableOutbox = ReturnType<typeof useDurableExamOutbox>;

function ActiveExam({
  exam,
  outbox,
  onAuthDenial,
  onRefresh,
  onSession,
}: {
  exam: ExamSessionView;
  outbox: DurableOutbox;
  onAuthDenial: () => Promise<void>;
  onRefresh: () => Promise<boolean>;
  onSession: (exam: ExamSessionView) => void;
}) {
  const [activeIndex, setActiveIndex] = useState(0);
  const [remaining, setRemaining] = useState(() => remainingExamSeconds(
    exam.serverDeadlineAt,
    Date.now(),
    serverClockOffsetMs(exam.serverNow, Date.now()),
  ));
  const [online, setOnline] = useState(() => typeof navigator === "undefined" || navigator.onLine);
  const [submitting, setSubmitting] = useState(false);
  const [submitRecoveryPending, setSubmitRecoveryPending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [localPersistenceNotice, setLocalPersistenceNotice] = useState<{
    itemId: string;
    sequence: number;
    message: string;
  } | null>(null);
  const [runState, setRunState] = useState<Record<string, { busy: boolean; label?: string; output?: string }>>({});
  const [runSyncInProgress, setRunSyncInProgress] = useState(false);
  const [stdin, setStdin] = useState<Record<string, string>>({});
  const clockOffsetRef = useRef(serverClockOffsetMs(exam.serverNow, Date.now()));
  const expiryStartedRef = useRef(false);
  const answerWriteSequenceRef = useRef(new Map<string, number>());
  const submitAbortControllerRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);
  const activeItem = exam.form.items[activeIndex]!;
  const conflict = outbox.conflicts[activeItem.id];
  const resolvingConflict = outbox.resolvingConflicts[activeItem.id] === true;
  const controlsClosed = submitting || runSyncInProgress || remaining === 0;
  const recordOutboxEvent = outbox.recordEvent;
  const updateOutboxAnswer = outbox.updateAnswer;
  const flushOutbox = outbox.flush;
  const purgeOutbox = outbox.purge;
  const prepareUnloadEvent = outbox.prepareUnloadEvent;

  const logEvent = useCallback((
    type: ClientExamEventType,
    metadata: Record<string, unknown> = {},
  ) => {
    void recordOutboxEvent(type, metadata).catch(() => undefined);
  }, [recordOutboxEvent]);

  const updateAnswer = useCallback((itemId: string, value: string) => {
    const sequence = (answerWriteSequenceRef.current.get(itemId) ?? 0) + 1;
    answerWriteSequenceRef.current.set(itemId, sequence);
    void updateOutboxAnswer(itemId, value).then(() => {
      if (!mountedRef.current || answerWriteSequenceRef.current.get(itemId) !== sequence) return;
      setLocalPersistenceNotice((current) => current?.itemId === itemId
        && current.sequence < sequence
        ? null
        : current);
    }).catch(() => {
      if (!mountedRef.current || answerWriteSequenceRef.current.get(itemId) !== sequence) return;
      setLocalPersistenceNotice({
        itemId,
        sequence,
        message: "This edit did not reach browser recovery. Try again or copy it before leaving.",
      });
    });
  }, [updateOutboxAnswer]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      submitAbortControllerRef.current?.abort();
    };
  }, []);

  const submit = useCallback(async (deadline: boolean) => {
    if (
      submitting
      || submitRecoveryPending
      || (!deadline && !window.confirm("Submit this exam? You cannot change answers afterward."))
    ) return;
    setSubmitting(true);
    setNotice(deadline
      ? "The server deadline has arrived. Finalizing the latest successful autosaves..."
      : "Saving and finalizing...");
    if (!deadline) {
      try {
        await flushOutbox();
      } catch {
        if (!mountedRef.current) return;
        setNotice("Submission was not confirmed. Your answer remains saved locally when browser recovery succeeded; Codestead must acknowledge it before submission.");
        setSubmitting(false);
        return;
      }
    }
    if (!mountedRef.current) return;
    const submitController = new AbortController();
    submitAbortControllerRef.current = submitController;
    try {
      const { response, body } = await boundedFinalSubmit(exam.sessionId, submitController);
      if (response.status === 401 || response.status === 403) {
        await onAuthDenial();
        return;
      }
      const submittedExam = responseField(body, "exam");
      if (
        !response.ok
        || !isExamSessionView(submittedExam, exam.sessionId)
        || !TERMINAL_RECOVERY_STATUSES.has(submittedExam.status)
      ) throw new Error(responseError(body, "Finalization is still pending."));
      await purgeOutbox();
      setNotice(null);
      onSession(submittedExam);
      void onRefresh();
    } catch (error) {
      if (!mountedRef.current) return;
      setNotice(deadline
        ? "You appear offline. The server deadline still applies and will finalize the latest autosave when contact resumes."
        : error instanceof Error ? error.message : "Submission could not be confirmed.");
      setSubmitRecoveryPending(true);
      void onRefresh().then((active) => {
        if (mountedRef.current && active) setSubmitRecoveryPending(false);
      }).catch(() => undefined);
    } finally {
      if (submitAbortControllerRef.current === submitController) {
        submitAbortControllerRef.current = null;
      }
      if (mountedRef.current) setSubmitting(false);
    }
  }, [exam.sessionId, flushOutbox, onAuthDenial, onRefresh, onSession, purgeOutbox, submitRecoveryPending, submitting]);

  useEffect(() => {
    const interval = setInterval(() => {
      const seconds = remainingExamSeconds(
        exam.serverDeadlineAt,
        Date.now(),
        clockOffsetRef.current,
      );
      setRemaining(seconds);
      if (
        seconds === 0
        && !expiryStartedRef.current
        && !submitting
        && !submitRecoveryPending
      ) {
        expiryStartedRef.current = true;
        void submit(true);
      }
    }, 500);
    return () => clearInterval(interval);
  }, [exam.serverDeadlineAt, submit, submitRecoveryPending, submitting]);

  useEffect(() => {
    const interval = setInterval(() => {
      void fetch(`/api/exams/${exam.sessionId}/heartbeat`, { method: "POST" })
        .then(async (response) => {
          if (response.status === 401 || response.status === 403) {
            await onAuthDenial();
            return;
          }
          const body = await response.json().catch(() => ({})) as {
            status?: ExamSessionView["status"];
            serverNow?: string;
          };
          if (!response.ok) throw new Error("heartbeat rejected");
          setOnline(true);
          if (body.serverNow) clockOffsetRef.current = serverClockOffsetMs(body.serverNow, Date.now());
          if (body.status && body.status !== "active") await onRefresh();
        })
        .catch(() => setOnline(false));
    }, 15_000);
    return () => clearInterval(interval);
  }, [exam.sessionId, onAuthDenial, onRefresh]);

  useEffect(() => {
    if (outbox.issue?.kind === "server-closure") void onRefresh();
  }, [onRefresh, outbox.issue]);

  useEffect(() => {
    const restored = () => {
      setOnline(true);
      logEvent("connection_restored", { online: true });
    };
    const lost = () => {
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
      const record = prepareUnloadEvent({ reason: "beforeunload" });
      if (!record) return;
      try {
        navigator.sendBeacon(
          `/api/exams/${exam.sessionId}/events`,
          new Blob([JSON.stringify({
            clientEventId: record.clientEventId,
            type: record.payload.eventType,
            metadata: record.payload.metadata,
          })], { type: "application/json" }),
        );
      } catch {
        // The emergency copy remains available for the next safe repository open.
      }
    };
    window.addEventListener("online", restored);
    window.addEventListener("offline", lost);
    window.addEventListener("blur", blur);
    window.addEventListener("focus", focus);
    window.addEventListener("beforeunload", beforeUnload);
    document.addEventListener("visibilitychange", visibility);
    document.addEventListener("fullscreenchange", fullscreen);
    return () => {
      window.removeEventListener("online", restored);
      window.removeEventListener("offline", lost);
      window.removeEventListener("blur", blur);
      window.removeEventListener("focus", focus);
      window.removeEventListener("beforeunload", beforeUnload);
      document.removeEventListener("visibilitychange", visibility);
      document.removeEventListener("fullscreenchange", fullscreen);
    };
  }, [exam.sessionId, logEvent, prepareUnloadEvent]);

  async function execute(mode: "COMPILE" | "RUN") {
    if (activeItem.kind !== "code" || controlsClosed || runState[activeItem.id]?.busy) return;
    const itemId = activeItem.id;
    const sourceCode = outbox.answers[itemId] ?? "";
    const standardInput = stdin[itemId] ?? "";
    setRunState((current) => ({ ...current, [itemId]: { busy: true, label: mode } }));
    setRunSyncInProgress(true);
    try {
      await outbox.flush();
    } catch {
      if (!mountedRef.current) return;
      setRunState((current) => ({
        ...current,
        [itemId]: {
          busy: false,
          label: "NOT_SYNCHRONIZED",
          output: "Codestead could not synchronize the answer. Retry before running or compiling.",
        },
      }));
      return;
    } finally {
      if (mountedRef.current) setRunSyncInProgress(false);
    }
    if (!mountedRef.current) return;
    if (remainingExamSeconds(
      exam.serverDeadlineAt,
      Date.now(),
      clockOffsetRef.current,
    ) === 0) {
      setRunState((current) => ({
        ...current,
        [itemId]: {
          busy: false,
          label: "DEADLINE_CLOSED",
          output: "The server deadline closed runner admission after synchronization.",
        },
      }));
      return;
    }
    try {
      const response = await fetch(`/api/exams/${exam.sessionId}/run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          itemId,
          sourceCode,
          stdin: standardInput,
          mode,
          clientRequestId: crypto.randomUUID(),
        }),
      });
      if (response.status === 401 || response.status === 403) {
        await onAuthDenial();
        return;
      }
      const body = await response.json().catch(() => ({})) as { result?: ExamRunnerResult; error?: string };
      if (!response.ok || !body.result) throw new Error(body.error ?? "Runner did not return a result.");
      if (!mountedRef.current) return;
      setRunState((current) => ({
        ...current,
        [itemId]: {
          busy: false,
          label: body.result!.status,
          output: sourceOutput(body.result!),
        },
      }));
    } catch (error) {
      if (!mountedRef.current) return;
      setRunState((current) => ({
        ...current,
        [itemId]: {
          busy: false,
          label: "INFRASTRUCTURE_ERROR",
          output: error instanceof Error ? error.message : "Runner unavailable.",
        },
      }));
    }
  }

  async function retryAnswers() {
    setNotice(null);
    const ownedNotice = localPersistenceNotice;
    try {
      await outbox.flush();
      if (!mountedRef.current) return;
      setLocalPersistenceNotice((current) => ownedNotice !== null
        && current?.itemId === ownedNotice.itemId
        && current.sequence === ownedNotice.sequence
        ? null
        : current);
    } catch {
      if (!mountedRef.current) return;
      setNotice("Codestead still could not acknowledge every locally saved answer.");
    }
  }

  async function chooseConflict(choice: "keep-local" | "use-server") {
    setNotice(null);
    try {
      await outbox.resolveConflict(activeItem.id, choice);
    } catch {
      setNotice("The recovered answer changed or could not be updated safely. Review both copies again.");
    }
  }

  const answeredCount = exam.form.items.filter((item) =>
    Boolean(outbox.answers[item.id]?.trim())
  ).length;
  const output = runState[activeItem.id];
  return (
    <div className={styles.examWorkspace}>
      <header className={styles.examHeader}>
        <Link href="/exams" onClick={() => logEvent("navigation_attempt", { target: "/exams" })}><ArrowLeft size={16} /> Exams</Link>
        <div className={styles.examIdentity}><span>{exam.form.purpose === "mastery-recheck" ? "Targeted mastery recheck" : exam.form.courseTitle}</span><strong>{exam.form.moduleTitle}</strong></div>
        <div className={`${styles.timer} ${remaining <= 60 ? styles.timerUrgent : ""}`} aria-live="polite"><Clock3 size={18} /><span><small>Server time left</small><strong>{timerLabel(remaining)}</strong></span></div>
        <div className={styles.connection}>{online ? <Wifi size={16} /> : <WifiOff size={16} />}<span>{online ? "Connected" : "Offline"}</span></div>
      </header>
      <div className={styles.examBody}>
        <aside className={styles.questionNav}>
          <span>QUESTIONS</span>
          <div className={styles.questionProgress}><strong>{answeredCount}/{exam.form.items.length}</strong><small>answered locally</small><i><b style={{ width: `${(answeredCount / exam.form.items.length) * 100}%` }} /></i></div>
          {exam.form.items.map((item, index) => {
            const answered = Boolean(outbox.answers[item.id]?.trim());
            const itemConflict = outbox.conflicts[item.id];
            return (
              <button
                aria-label={`${item.title}${itemConflict ? " (answer conflict)" : ""}`}
                className={index === activeIndex ? styles.activeQuestion : ""}
                disabled={controlsClosed}
                key={item.id}
                onClick={() => setActiveIndex(index)}
              >
                <b>{answered ? <CheckCircle2 size={14} /> : index + 1}</b>
                <span><strong>{item.title}</strong><small>{itemConflict ? "Answer conflict" : item.kind === "code" ? item.language?.toUpperCase() : "Written response"}</small></span>
              </button>
            );
          })}
          <div className={styles.noAssistance}><ShieldCheck size={16} /><span><strong>Independent mode</strong><small>Tutor and notes are unavailable.</small></span></div>
        </aside>
        <main className={styles.questionArea}>
          <div
            aria-atomic="true"
            aria-live="polite"
            className={styles.questionTopline}
            data-durability-status="true"
            data-state={outbox.saveState}
            role="status"
          >
            <Save size={15} /> <span>{SAVE_STATE_COPY[outbox.saveState]}</span>
          </div>
          <div className={styles.questionTopline}><span>Question {activeIndex + 1} of {exam.form.items.length}</span><i>{activeItem.points} points</i><i>{activeItem.verificationAvailable ? "Deterministic evidence" : "Review required"}</i></div>
          <h1>{activeItem.title}</h1>
          <p className={styles.questionPrompt}>{activeItem.prompt}</p>
          {conflict ? (
            <div className={styles.appealForm}>
              <label><span>Recovered answer</span><textarea readOnly value={conflict.localAnswer} /></label>
              <label><span>Codestead answer</span><textarea readOnly value={conflict.serverAnswer} /></label>
              <div>
                <button className="button button-primary" disabled={controlsClosed || resolvingConflict} type="button" onClick={() => void chooseConflict("keep-local")}>Keep recovered answer</button>
                <button className="button button-secondary" disabled={controlsClosed || resolvingConflict} type="button" onClick={() => void chooseConflict("use-server")}>Use server answer</button>
              </div>
            </div>
          ) : activeItem.kind === "short-answer" ? (
            <label className={styles.answerField}>
              <span>Your response</span>
              <textarea
                autoFocus
                disabled={controlsClosed}
                maxLength={32_000}
                value={outbox.answers[activeItem.id] ?? ""}
                onChange={(event) => updateAnswer(activeItem.id, event.target.value)}
                onPaste={(event) => logEvent("paste", { itemId: activeItem.id, pastedCharacters: event.clipboardData.getData("text").length })}
                placeholder="Explain the outcome, then include an example and a boundary case..."
              />
            </label>
          ) : (
            <div className={styles.codeQuestion}>
              <div className={styles.codeToolbar}>
                <span><Code2 size={15} /> {activeItem.language?.toUpperCase()}</span>
                <div>
                  <button disabled={controlsClosed} onClick={() => updateAnswer(activeItem.id, activeItem.starterCode ?? "")}><RotateCcw size={14} /> Reset</button>
                  <button onClick={() => void document.documentElement.requestFullscreen()}><Expand size={14} /> Fullscreen</button>
                  <button disabled={controlsClosed || output?.busy} onClick={() => void execute("COMPILE")}><TerminalSquare size={14} /> Compile</button>
                  <button className={styles.runButton} disabled={controlsClosed || output?.busy} onClick={() => void execute("RUN")}><Play size={14} /> Run</button>
                </div>
              </div>
              <textarea
                aria-label="Source code"
                className={styles.codeEditor}
                disabled={controlsClosed}
                maxLength={131_072}
                spellCheck={false}
                value={outbox.answers[activeItem.id] ?? ""}
                onChange={(event) => updateAnswer(activeItem.id, event.target.value)}
                onPaste={(event) => logEvent("paste", { itemId: activeItem.id, pastedCharacters: event.clipboardData.getData("text").length })}
              />
              <label className={styles.stdinField}><span>Standard input (optional)</span><textarea disabled={controlsClosed} value={stdin[activeItem.id] ?? ""} onChange={(event) => setStdin((current) => ({ ...current, [activeItem.id]: event.target.value }))} /></label>
              <div className={styles.runnerOutput}><span><TerminalSquare size={14} /> Raw runner output {output?.label && <i>{output.label}</i>}</span><pre>{output?.busy ? "Running in the isolated container..." : output?.output ?? "Compile or run to inspect unassisted output."}</pre></div>
            </div>
          )}
          {outbox.issue && <div className={styles.workspaceNotice} role="alert"><AlertCircle size={17} /> {outbox.issue.message}</div>}
          {localPersistenceNotice && <div className={styles.workspaceNotice} role="status"><AlertCircle size={17} /> {localPersistenceNotice.message}</div>}
          {notice && <div className={styles.workspaceNotice} role="status"><AlertCircle size={17} /> {notice}</div>}
          {(outbox.saveState === "local-save-error" || outbox.saveState === "offline-saved-local") && (
            <button className="button button-secondary" type="button" disabled={controlsClosed} onClick={() => void retryAnswers()}>Retry now</button>
          )}
          <footer className={styles.questionActions}>
            <button className="button button-secondary" disabled={controlsClosed || activeIndex === 0} onClick={() => setActiveIndex((value) => Math.max(0, value - 1))}>Previous</button>
            {activeIndex < exam.form.items.length - 1
              ? <button className="button button-primary" disabled={controlsClosed} onClick={() => setActiveIndex((value) => value + 1)}>Save & next</button>
              : <button className="button button-primary" disabled={controlsClosed || submitRecoveryPending} onClick={() => void submit(false)}>{submitting ? <LoaderCircle className={styles.spin} size={16} /> : <Send size={16} />} Submit final</button>}
          </footer>
        </main>
      </div>
    </div>
  );
}

function DurableExam({
  exam,
  namespace,
  repository,
  onAuthDenial,
  onRefresh,
  onRetryRecovery,
  onSession,
}: {
  exam: ExamSessionView;
  namespace: string;
  repository: BrowserOutboxRepository;
  onAuthDenial: () => Promise<void>;
  onRefresh: () => Promise<boolean>;
  onRetryRecovery: () => void;
  onSession: (exam: ExamSessionView) => void;
}) {
  const outbox = useDurableExamOutbox({ namespace, session: exam, repository });
  const terminal = TERMINAL_RECOVERY_STATUSES.has(exam.status);
  const [cleanupComplete, setCleanupComplete] = useState(false);
  const [cleanupError, setCleanupError] = useState<string | null>(null);
  const purgeOutbox = outbox.purge;

  const cleanup = useCallback(async () => {
    setCleanupError(null);
    try {
      await purgeOutbox();
      setCleanupComplete(true);
    } catch {
      setCleanupError("Codestead could not finish clearing this exam's browser recovery. Retry cleanup before viewing the result.");
    }
  }, [purgeOutbox]);

  useEffect(() => {
    if (!terminal || !outbox.hydrated || cleanupComplete || cleanupError !== null) return;
    const timeout = setTimeout(() => void cleanup(), 0);
    return () => clearTimeout(timeout);
  }, [cleanup, cleanupComplete, cleanupError, outbox.hydrated, terminal]);

  if (terminal) {
    if (!cleanupComplete) {
      return (
        <div className={styles.loading}>
          <LoaderCircle className={styles.spin} /> Finalizing browser recovery before showing the result...
          {cleanupError && <><span role="alert">{cleanupError}</span><button className="button button-secondary" type="button" onClick={() => void cleanup()}>Retry cleanup</button></>}
        </div>
      );
    }
    return <ExamResultPanel exam={exam} onAuthDenial={onAuthDenial} onRefresh={onRefresh} />;
  }
  if (exam.status !== "active") {
    return (
      <div className={styles.resultPage}>
        <LoaderCircle className={styles.spin} />
        <h1>Exam is not active</h1>
        <p>This exam is paused or scheduled. Exam recovery is preserved; a paused closed-book session also removes ordinary lesson drafts.</p>
        <button className="button button-secondary" type="button" onClick={() => void onRefresh()}>Refresh status</button>
      </div>
    );
  }
  if (!outbox.hydrated) {
    return <div className={styles.loading}><LoaderCircle className={styles.spin} /> Restoring answers saved on this browser...</div>;
  }
  if (
    outbox.issue?.kind === "event-recovery"
    && outbox.issue.message.startsWith("Could not restore browser recovery")
  ) {
    return (
      <div className={styles.loadError}>
        <AlertCircle size={24} />
        <h1>Exam recovery unavailable</h1>
        <p>{outbox.issue.message} Copy your answer from another safe source before leaving.</p>
        <button className="button button-secondary" onClick={onRetryRecovery} type="button">
          Retry browser storage cleanup
        </button>
      </div>
    );
  }
  return (
    <ActiveExam
      exam={exam}
      onAuthDenial={onAuthDenial}
      onRefresh={onRefresh}
      onSession={onSession}
      outbox={outbox}
    />
  );
}

function ExamRepositoryBoundary({
  exam,
  namespace,
  onAuthDenial,
  onRefresh,
  onSession,
}: {
  exam: ExamSessionView;
  namespace: string;
  onAuthDenial: () => Promise<void>;
  onRefresh: () => Promise<boolean>;
  onSession: (exam: ExamSessionView) => void;
}) {
  const [repository, setRepository] = useState<BrowserOutboxRepository | null>(null);
  const [repositoryError, setRepositoryError] = useState(false);
  const [repositoryAttempt, setRepositoryAttempt] = useState(0);
  const [recoveryAttempt, setRecoveryAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let opened: BrowserOutboxRepository | null = null;
    void openBrowserOutbox().then((next) => {
      if (cancelled) {
        next.close();
        return;
      }
      opened = next;
      setRepository(next);
    }).catch(() => {
      if (!cancelled) setRepositoryError(true);
    });
    return () => {
      cancelled = true;
      opened?.close();
    };
  }, [exam.sessionId, namespace, repositoryAttempt]);

  if (repositoryError) {
    return (
      <div className={styles.loadError}>
        <AlertCircle size={24} />
        <h1>Exam recovery unavailable</h1>
        <p>Codestead could not open private browser recovery for this exam. Editable controls remain disabled.</p>
        <button
          className="button button-secondary"
          onClick={() => {
            setRepositoryError(false);
            setRepository(null);
            setRepositoryAttempt((value) => value + 1);
          }}
          type="button"
        >
          Retry browser storage cleanup
        </button>
      </div>
    );
  }
  if (!repository) {
    return (
      <div className={styles.loading}>
        <LoaderCircle className={styles.spin} /> {TERMINAL_RECOVERY_STATUSES.has(exam.status)
          ? "Finalizing browser recovery before showing the result..."
          : "Restoring answers saved on this browser..."}
      </div>
    );
  }
  return (
    <DurableExam
      exam={exam}
      key={`${exam.sessionId}:${recoveryAttempt}`}
      namespace={namespace}
      onAuthDenial={onAuthDenial}
      onRefresh={onRefresh}
      onRetryRecovery={() => setRecoveryAttempt((value) => value + 1)}
      onSession={onSession}
      repository={repository}
    />
  );
}
export function TimedExamClient({
  sessionId,
  navigate = navigateWindow,
}: {
  sessionId: string;
  navigate?: (destination: string) => void;
}) {
  const namespace = useDraftCacheNamespace();
  const latestNamespaceRef = useRef(namespace);
  useLayoutEffect(() => {
    latestNamespaceRef.current = namespace;
  }, [namespace]);
  const [exam, setExam] = useState<ExamSessionView | null>(null);
  const [loading, setLoading] = useState(true);
  const [redirecting, setRedirecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loadedExamRef = useRef<ExamSessionView | null>(null);
  const authBoundaryRef = useRef<{
    namespace: string | null;
    promise: Promise<void>;
  } | null>(null);

  const acceptExam = useCallback((nextExam: ExamSessionView) => {
    loadedExamRef.current = nextExam;
    setExam(nextExam);
  }, []);

  const handleAuthDenial = useCallback(() => {
    const capturedNamespace = namespace;
    const current = authBoundaryRef.current;
    if (current?.namespace === capturedNamespace) return current.promise;
    const promise = (async () => {
      try {
        await withBrowserRecoveryRepository(openBrowserOutbox, (repository) => (
          purgeBrowserRecoveryData({
            ...(capturedNamespace ? { namespace: capturedNamespace } : {}),
            sessionStorage: window.sessionStorage,
            localStorage: window.localStorage,
            repository,
          })
        ));
      } catch {
        // The anonymous login gate retries cleanup before exposing credentials.
      }
      if (latestNamespaceRef.current === capturedNamespace) {
        setRedirecting(true);
        navigate("/login");
      }
    })();
    authBoundaryRef.current = { namespace: capturedNamespace, promise };
    return promise;
  }, [namespace, navigate]);

  const load = useCallback(async () => {
    try {
      const response = await fetch(`/api/exams/${sessionId}`, { cache: "no-store" });
      if (response.status === 401 || response.status === 403) {
        await handleAuthDenial();
        return false;
      }
      const body: unknown = await response.json().catch(() => undefined);
      const loadedExam = responseField(body, "exam");
      if (!response.ok || !isExamSessionView(loadedExam, sessionId)) {
        throw new Error(responseError(body, "Exam session could not be loaded."));
      }
      acceptExam(loadedExam);
      setError(null);
      return loadedExam.status === "active";
    } catch (loadError) {
      if (loadedExamRef.current === null) {
        setError(loadError instanceof Error ? loadError.message : "Exam session could not be loaded.");
      }
      return false;
    } finally {
      setLoading(false);
    }
  }, [acceptExam, handleAuthDenial, sessionId]);

  useEffect(() => {
    const timeout = setTimeout(() => void load(), 0);
    return () => clearTimeout(timeout);
  }, [load]);
  const stableKey = useMemo(() => exam
    ? `${exam.sessionId}:${exam.status}:${exam.result?.finalizedAt ?? "active"}:${exam.appeal?.status ?? "none"}:${exam.appeal?.updatedAt ?? "none"}`
    : "loading", [exam]);
  if (redirecting) return <div className={styles.loading}><LoaderCircle className={styles.spin} /> Redirecting to sign in...</div>;
  if (loading) return <div className={styles.loading}><LoaderCircle className={styles.spin} /> Restoring immutable exam form...</div>;
  if (error || !exam) return <div className={styles.loadError}><AlertCircle size={24} /><h1>Exam unavailable</h1><p>{error}</p><Link className="button button-secondary" href="/exams">Return to exams</Link></div>;
  if (namespace === null) {
    if (TERMINAL_RECOVERY_STATUSES.has(exam.status)) {
      return <ExamResultPanel exam={exam} onAuthDenial={handleAuthDenial} onRefresh={load} />;
    }
    return (
      <div className={styles.loadError}>
        <AlertCircle size={24} />
        <h1>Exam recovery unavailable</h1>
        <p>Private browser recovery is not available for this authenticated exam. Editable controls remain disabled.</p>
        <Link className="button button-secondary" href="/exams">Return to exams</Link>
      </div>
    );
  }
  return (
    <ExamRepositoryBoundary
      exam={exam}
      key={stableKey}
      namespace={namespace}
      onAuthDenial={handleAuthDenial}
      onRefresh={load}
      onSession={acceptExam}
    />
  );
}
