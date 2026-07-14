"use client";

import {
  Archive,
  Bot,
  BookOpen,
  BrainCircuit,
  History,
  MessageSquarePlus,
  RotateCcw,
  Send,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { MentorRecommendation } from "@/lib/ai/mentor-policy";

import { AiOutputReport } from "./ai-output-report";
import styles from "./product-pages.module.css";

type Message = {
  id: string;
  role: "user" | "assistant";
  content: string;
  callId?: string | null;
  provider?: string | null;
  model?: string | null;
  credentialSource?: string | null;
  contextManifest?: TutorContextManifest | null;
  createdAt?: string;
};

type TutorContextManifest = {
  promptVersion: string;
  contextPolicyVersion: string;
  included: string[];
  provenance: Record<string, string>;
  caps: Record<string, number>;
  explicitlyExcluded: string[];
};

type ThreadStatus = "active" | "archived";

type ThreadSummary = {
  id: string;
  title: string;
  status: ThreadStatus;
  messageCount: number;
  provider: string | null;
  model: string | null;
  credentialSource: string | null;
  createdAt: string;
  updatedAt: string;
};

type ThreadDetail = Pick<ThreadSummary, "id" | "title" | "status" | "createdAt" | "updatedAt">;

type ThreadListResponse = {
  threads: ThreadSummary[];
  nextCursor: string | null;
  error?: string;
};

type ThreadReadResponse = {
  thread: ThreadDetail;
  messages: Message[];
  nextCursor: string | null;
  error?: string;
};

const WELCOME: Message = {
  id: "authored-welcome",
  role: "assistant",
  content: "Hey buddy. I can see you are working on Python scalar values. Before we begin: what is the difference, in your words, between a value and the name bound to it?",
};

const NEW_THREAD_DRAFT_KEY = "__new_tutor_thread__";

type FailedSend = {
  content: string;
  draftKey: string;
  requestId: string;
};

function providerName(value: string | null | undefined) {
  if (!value) return null;
  return value.replaceAll("_", " ").replace(/\b\w/g, (character) => character.toUpperCase());
}

function credentialLabel(source: string | null | undefined) {
  if (source === "learner") return "your key";
  if (source === "admin_fallback") return "admin-funded fallback";
  return "credential source unavailable";
}

function messageProvenance(message: Pick<Message, "id" | "provider" | "model" | "credentialSource">) {
  if (message.id === WELCOME.id) return "Authored opening prompt · no provider call";
  const provider = providerName(message.provider);
  if (!provider && !message.model) return "Provider metadata unavailable · legacy or authored message";
  return `${provider ?? "Provider unavailable"} · ${message.model ?? "model unavailable"} · ${credentialLabel(message.credentialSource)}`;
}

function threadProvenance(thread: ThreadSummary) {
  const provider = providerName(thread.provider);
  if (!provider && !thread.model) return "No provider response yet";
  return `${provider ?? "Provider unavailable"} · ${thread.model ?? "model unavailable"} · ${credentialLabel(thread.credentialSource)}`;
}

function contextCategoryLabel(category: string) {
  const labels: Record<string, string> = {
    "learner_profile.goals_preferences": "Goals and learning preferences",
    "concept_mastery.current_skill": "Current-skill mastery and confidence",
    "mastery_evidence.active_misconceptions": "Active deterministic misconception tags",
    "email_outbox.latest_weekly_summary": "Latest stored weekly summary",
    "chat_message.selected_thread_tail": "Selected conversation's bounded tail",
    "curriculum.current_course_lesson": "Current authored course and lesson",
  };
  return labels[category] ?? category;
}

async function jsonBody<T>(response: Response): Promise<T> {
  return response.json().catch(() => ({})) as Promise<T>;
}

export function TutorView() {
  const [messages, setMessages] = useState<Message[]>([WELCOME]);
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [selectedThread, setSelectedThread] = useState<ThreadDetail | null>(null);
  const [openingThreadId, setOpeningThreadId] = useState<string | null>(null);
  const [threadCursor, setThreadCursor] = useState<string | null>(null);
  const [messageCursor, setMessageCursor] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [failedSend, setFailedSend] = useState<FailedSend | null>(null);
  const [busy, setBusy] = useState(false);
  const [historyBusy, setHistoryBusy] = useState(true);
  const [statusBusy, setStatusBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sanitizationNotice, setSanitizationNotice] = useState<string | null>(null);
  const [mentorRecommendation, setMentorRecommendation] = useState<MentorRecommendation | null>(null);
  const readSequence = useRef(0);

  const loadThreads = useCallback(async (
    cursor: string | null = null,
    append = false,
    foreground = true,
  ) => {
    // Yield before the loading transition so the mount effect does not cause
    // a synchronous cascading render; subsequent user-triggered calls still
    // expose the same bounded loading state.
    await Promise.resolve();
    if (foreground) setHistoryBusy(true);
    setError(null);
    try {
      const query = new URLSearchParams({ includeArchived: "true", limit: "20" });
      if (cursor) query.set("cursor", cursor);
      const response = await fetch(`/api/ai/threads?${query.toString()}`, {
        method: "GET",
        headers: { accept: "application/json" },
        cache: "no-store",
      });
      const body = await jsonBody<ThreadListResponse>(response);
      if (!response.ok) throw new Error(body.error ?? "Tutor history is unavailable.");
      setThreads((current) => {
        if (!append) return body.threads;
        const byId = new Map(current.map((thread) => [thread.id, thread]));
        for (const thread of body.threads) byId.set(thread.id, thread);
        return [...byId.values()];
      });
      setThreadCursor(body.nextCursor);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Tutor history is unavailable.");
    } finally {
      if (foreground) setHistoryBusy(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    const query = new URLSearchParams({ includeArchived: "true", limit: "20" });
    void fetch(`/api/ai/threads?${query.toString()}`, {
      method: "GET",
      headers: { accept: "application/json" },
      cache: "no-store",
    })
      .then(async (response) => ({ response, body: await jsonBody<ThreadListResponse>(response) }))
      .then(({ response, body }) => {
        if (!response.ok) throw new Error(body.error ?? "Tutor history is unavailable.");
        if (!active) return;
        setThreads(body.threads);
        setThreadCursor(body.nextCursor);
      })
      .catch((cause: unknown) => {
        if (active) setError(cause instanceof Error ? cause.message : "Tutor history is unavailable.");
      })
      .finally(() => {
        if (active) setHistoryBusy(false);
      });
    return () => {
      active = false;
    };
  }, []);

  async function openThread(thread: ThreadSummary) {
    // A second thread selection may supersede an in-flight thread read. Other
    // history work (initial/list pagination or older-message pagination) must
    // settle first because it does not represent a replaceable selection.
    if (busy || statusBusy || (historyBusy && openingThreadId === null)) return;
    const sequence = ++readSequence.current;
    setOpeningThreadId(thread.id);
    setHistoryBusy(true);
    setError(null);
    // The previous transcript may remain visible for continuity, but all
    // message/status actions are guarded until the selected read is
    // authoritative. The sequence check rejects any superseded response.
    try {
      const response = await fetch(`/api/ai/threads/${encodeURIComponent(thread.id)}?limit=100`, {
        method: "GET",
        headers: { accept: "application/json" },
        cache: "no-store",
      });
      const body = await jsonBody<ThreadReadResponse>(response);
      if (!response.ok) throw new Error(body.error ?? "That tutor thread is unavailable.");
      if (sequence !== readSequence.current) return;
      setSelectedThread(body.thread);
      setMessages(body.messages);
      setMessageCursor(body.nextCursor);
    } catch (cause) {
      if (sequence === readSequence.current) {
        setError(cause instanceof Error ? cause.message : "That tutor thread is unavailable.");
      }
    } finally {
      if (sequence === readSequence.current) {
        setOpeningThreadId(null);
        setHistoryBusy(false);
      }
    }
  }

  async function loadOlderMessages() {
    if (!selectedThread || !messageCursor || historyBusy) return;
    setHistoryBusy(true);
    setError(null);
    try {
      const query = new URLSearchParams({ limit: "100", cursor: messageCursor });
      const response = await fetch(`/api/ai/threads/${encodeURIComponent(selectedThread.id)}?${query.toString()}`, {
        method: "GET",
        headers: { accept: "application/json" },
        cache: "no-store",
      });
      const body = await jsonBody<ThreadReadResponse>(response);
      if (!response.ok) throw new Error(body.error ?? "Older messages are unavailable.");
      setSelectedThread(body.thread);
      setMessages((current) => {
        const seen = new Set(current.map((message) => message.id));
        return [...body.messages.filter((message) => !seen.has(message.id)), ...current];
      });
      setMessageCursor(body.nextCursor);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Older messages are unavailable.");
    } finally {
      setHistoryBusy(false);
    }
  }

  function startNewThread() {
    if (busy || historyBusy || statusBusy) return;
    readSequence.current += 1;
    setOpeningThreadId(null);
    setHistoryBusy(false);
    setSelectedThread(null);
    setMessages([WELCOME]);
    setMessageCursor(null);
    setError(null);
    setSanitizationNotice(null);
  }

  async function changeThreadStatus() {
    if (!selectedThread || statusBusy || busy || historyBusy) return;
    const nextStatus: ThreadStatus = selectedThread.status === "active" ? "archived" : "active";
    setStatusBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/ai/threads/${encodeURIComponent(selectedThread.id)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ status: nextStatus, expectedUpdatedAt: selectedThread.updatedAt }),
      });
      const body = await jsonBody<{
        thread?: { status: ThreadStatus; updatedAt: string; replayed: boolean };
        current?: { status: ThreadStatus; updatedAt: string };
        error?: string;
      }>(response);
      if (!response.ok || !body.thread) {
        if (response.status === 409 && body.current) {
          setSelectedThread((current) => current ? { ...current, ...body.current } : current);
          setThreads((current) => current.map((thread) => thread.id === selectedThread.id
            ? { ...thread, ...body.current }
            : thread));
        }
        throw new Error(body.error ?? "The thread status could not be changed.");
      }
      setSelectedThread((current) => current ? { ...current, status: body.thread!.status, updatedAt: body.thread!.updatedAt } : current);
      setThreads((current) => current.map((thread) => thread.id === selectedThread.id
        ? { ...thread, status: body.thread!.status, updatedAt: body.thread!.updatedAt }
        : thread));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The thread status could not be changed.");
    } finally {
      setStatusBusy(false);
    }
  }

  async function send() {
    const draftKey = openingThreadId ?? selectedThread?.id ?? NEW_THREAD_DRAFT_KEY;
    const value = drafts[draftKey] ?? "";
    const content = value.trim();
    if (!content || busy || historyBusy || statusBusy || openingThreadId || selectedThread?.status === "archived") return;
    const requestId = failedSend?.draftKey === draftKey && failedSend.content === content
      ? failedSend.requestId
      : crypto.randomUUID();
    const optimisticId = `local-user-${requestId}`;
    setMessages((items) => [...items, { id: optimisticId, role: "user", content }]);
    setDrafts((current) => ({ ...current, [draftKey]: "" }));
    setFailedSend(null);
    setBusy(true);
    setError(null);
    setSanitizationNotice(null);
    try {
      const requestInit: RequestInit = {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({
          requestId,
          courseId: "python",
          skillId: "python.values.scalars",
          message: content,
          ...(selectedThread ? { threadId: selectedThread.id } : {}),
        }),
      };
      let response: Response;
      try {
        response = await fetch("/api/ai/tutor", requestInit);
      } catch {
        // A transport failure can mean the server committed but the response
        // was lost. Retry once with the exact same UUID and payload so the
        // durable receipt replays instead of calling the provider again.
        response = await fetch("/api/ai/tutor", requestInit);
      }
      const body = await jsonBody<{
        content?: string;
        error?: string;
        code?: string;
        provider?: string;
        model?: string;
        source?: string;
        callId?: string;
        threadId?: string;
        thread?: { id: string; title: string; status: ThreadStatus; updatedAt: string };
        contextManifest?: TutorContextManifest;
        acceptedMessage?: string;
         messageSanitized?: boolean;
         mentorRecommendation?: MentorRecommendation;
       }>(response);
      if (!response.ok || !body.content || !body.threadId) {
        setMessages((items) => items.filter((message) => message.id !== optimisticId));
        if (body.code === "THREAD_ARCHIVED" && selectedThread) {
          setSelectedThread({ ...selectedThread, status: "archived" });
          setThreads((current) => current.map((thread) => thread.id === selectedThread.id
            ? { ...thread, status: "archived" }
            : thread));
        }
        throw new Error(body.error ?? "Codestead is unavailable. Use the authored lesson while the provider recovers.");
      }

      const assistant: Message = {
        id: body.callId ? `assistant-${body.callId}` : `local-assistant-${Date.now()}`,
        role: "assistant",
        content: body.content,
        callId: body.callId,
        provider: body.provider,
        model: body.model,
        credentialSource: body.source,
        contextManifest: body.contextManifest,
      };
      setMessages((items) => [
        ...items.map((message) => message.id === optimisticId
          ? { ...message, content: body.acceptedMessage ?? message.content }
          : message),
        assistant,
      ]);
      if (body.messageSanitized) {
        setSanitizationNotice("Sensitive-looking values were redacted before this message was sent or saved.");
      }
      if (body.mentorRecommendation) setMentorRecommendation(body.mentorRecommendation);
      if (body.thread) {
        setSelectedThread((current) => ({
          id: body.thread!.id,
          title: body.thread!.title,
          status: body.thread!.status,
          createdAt: current?.createdAt ?? body.thread!.updatedAt,
          updatedAt: body.thread!.updatedAt,
        }));
      }
      // Refreshing the conversation index does not change the active thread,
      // so it must not freeze a composer that is already safe to use.
      void loadThreads(null, false, false);
    } catch (cause) {
      setMessages((items) => items.filter((message) => message.id !== optimisticId));
      setDrafts((current) => ({
        ...current,
        [draftKey]: current[draftKey]?.trim() ? current[draftKey] : content,
      }));
      setFailedSend({ content, draftKey, requestId });
      const message = cause instanceof Error
        ? cause.message
        : "Codestead is offline. Your authored learning tools are still available.";
      setError(`${message} Your message was restored; send it again to retry safely.`);
    } finally {
      setBusy(false);
    }
  }

  const latestAssistant = useMemo(
    () => [...messages].reverse().find((message) => message.role === "assistant"),
    [messages],
  );
  const latestContextManifest = useMemo(
    () => [...messages].reverse().find((message) => message.contextManifest)?.contextManifest ?? null,
    [messages],
  );
  const provider = latestAssistant ? messageProvenance(latestAssistant) : "Provider chosen when you send";
  const archived = selectedThread?.status === "archived";
  const draftKey = openingThreadId ?? selectedThread?.id ?? NEW_THREAD_DRAFT_KEY;
  const value = drafts[draftKey] ?? "";
  const interactionLocked = busy || historyBusy || statusBusy || openingThreadId !== null;
  const threadSelectionLocked = busy || statusBusy || (historyBusy && openingThreadId === null);

  return (
    <div className={styles.page}>
      <header className={styles.pageHead}>
        <div>
          <span className={styles.eyebrow}>Course-grounded help</span>
          <h1>Codestead mentor.</h1>
          <p>A friendly tutor that sees bounded learning context, not your entire account. It can explain and coach; it cannot pass exams, set mastery, publish content, or run code.</p>
        </div>
        <span className="pill"><ShieldCheck size={14} /> Your key · bounded context</span>
      </header>

      {mentorRecommendation && <section
        aria-label="Personalized daily mentor challenge"
        className={`${styles.mentorRecommendation} card`}
      >
        {mentorRecommendation.state === "ready" ? <>
          <div className={styles.mentorRecommendationHead}>
            <span><BrainCircuit size={18} /></span>
            <div>
              <strong>Today&apos;s evidence-based challenge</strong>
              <small>{mentorRecommendation.policyVersion} · stored verified evidence only</small>
            </div>
            <span className="pill">{mentorRecommendation.dailyChallenge.targetMinutes} min</span>
          </div>
          <h2>{mentorRecommendation.dailyChallenge.skillTitle}</h2>
          <p>{mentorRecommendation.dailyChallenge.reasonText}</p>
          <p><strong>Try this:</strong> {mentorRecommendation.dailyChallenge.instruction}</p>
          <div className={styles.mentorSignals} aria-label="Evidence-derived learning signals">
            <span><small>Pace</small><strong>{mentorRecommendation.learningSignal.pace.replaceAll("_", " ")}</strong></span>
            <span><small>Confidence</small><strong>{mentorRecommendation.learningSignal.confidence.replaceAll("_", " ")}</strong></span>
            <span><small>Evidence window</small><strong>{mentorRecommendation.learningSignal.evidence.verifiedMasteryRows} mastery · {mentorRecommendation.learningSignal.evidence.verifiedRecentAttempts} attempts</strong></span>
          </div>
          <p>{mentorRecommendation.encouragement}</p>
          {mentorRecommendation.planSuggestion && <p className={styles.mentorPlanSuggestion}>
            <strong>Plan review suggestion:</strong> {mentorRecommendation.planSuggestion.reason} This is a suggestion for the administrator; no roadmap change was made.
          </p>}
          <details>
            <summary>Why this recommendation is bounded</summary>
            <p>{mentorRecommendation.authority.statement}</p>
            <p><strong>Explicitly excluded:</strong> {mentorRecommendation.contextPolicy.explicitlyExcluded.join(" · ")}</p>
          </details>
        </> : <>
          <div className={styles.mentorRecommendationHead}>
            <span><BrainCircuit size={18} /></span>
            <div><strong>Personalized challenge unavailable</strong><small>{mentorRecommendation.policyVersion}</small></div>
          </div>
          <p>{mentorRecommendation.message}</p>
          <small>No official roadmap change was made.</small>
        </>}
      </section>}

      <section className={`${styles.tutorLayout} card`}>
        <aside className={styles.tutorContext} aria-label="Tutor thread history and context">
          <div className={styles.threadHeading}>
            <span><History size={15} /><strong>Conversations</strong></span>
            <button type="button" className={styles.threadIconButton} disabled={interactionLocked} onClick={startNewThread} aria-label="Start a new conversation">
              <MessageSquarePlus size={16} />
            </button>
          </div>
          <ul className={styles.threadList} aria-label="Your tutor conversations" aria-busy={historyBusy}>
            {threads.map((thread) => (
              <li key={thread.id}>
                <button
                  type="button"
                  className={selectedThread?.id === thread.id || openingThreadId === thread.id ? styles.selectedThread : undefined}
                  aria-current={selectedThread?.id === thread.id ? "page" : undefined}
                  aria-busy={openingThreadId === thread.id || undefined}
                  disabled={threadSelectionLocked}
                  onClick={() => void openThread(thread)}
                >
                  <span><strong>{thread.title}</strong>{thread.status === "archived" && <em>Archived</em>}</span>
                  <small>{thread.messageCount} messages</small>
                  <small>{threadProvenance(thread)}</small>
                </button>
              </li>
            ))}
          </ul>
          {!historyBusy && threads.length === 0 && <p>No saved conversations yet.</p>}
          {threadCursor && (
            <button type="button" className="button button-secondary" disabled={historyBusy} onClick={() => void loadThreads(threadCursor, true)}>
              Load more conversations
            </button>
          )}

          <details className={styles.contextDetails}>
            <summary>Context sent this turn</summary>
            {latestContextManifest ? (
              <>
                <p>{latestContextManifest.contextPolicyVersion} · exact categories from the latest provider call</p>
                {latestContextManifest.included.map((category) => (
                  <div className={styles.contextItem} key={category}>
                    <span>{contextCategoryLabel(category)}</span>
                    <strong>{latestContextManifest.provenance[category] ?? "Server-reviewed bounded projection"}</strong>
                  </div>
                ))}
                <div className={styles.contextItem}>
                  <span>Hard caps</span>
                  <strong>{Object.entries(latestContextManifest.caps).map(([key, amount]) => `${key}: ${amount}`).join(" · ")}</strong>
                </div>
                <div className={styles.contextItem}>
                  <span>Explicitly excluded</span>
                  <strong>{latestContextManifest.explicitlyExcluded.join(" · ")}</strong>
                </div>
              </>
            ) : (
              <p>No provider call is selected yet. After a response, this panel shows the exact stored categories, provenance, and caps used for that call.</p>
            )}
          </details>
        </aside>

        <div className={styles.tutorChat}>
          <header className={styles.tutorChatHead}>
            <div className={styles.tutorIdentity}>
              <span><Bot size={19} /></span>
              <span><strong>{openingThreadId ? "Loading conversation…" : selectedThread?.title ?? "New conversation"}</strong><small>{provider}</small></span>
            </div>
            <div className={styles.threadActions}>
              {selectedThread && (
                <button type="button" className="button button-secondary" disabled={interactionLocked} onClick={() => void changeThreadStatus()}>
                  {archived ? <RotateCcw size={13} /> : <Archive size={13} />}
                  {statusBusy ? "Updating…" : archived ? "Reopen" : "Archive"}
                </button>
              )}
              <span className="pill"><Sparkles size={12} /> Friendly · Socratic</span>
            </div>
          </header>

          <div className={styles.messageList} aria-live="polite" aria-busy={busy || historyBusy}>
            {messageCursor && (
              <button type="button" className="button button-secondary" disabled={historyBusy} onClick={() => void loadOlderMessages()}>
                Load older messages
              </button>
            )}
            {!historyBusy && messages.length === 0 && <p className={styles.threadEmpty}>This conversation has no messages.</p>}
            {messages.map((message) => (
              <div className={message.role === "user" ? styles.learnerBubble : styles.assistantBubble} key={message.id}>
                <span>{message.content}</span>
                {message.role === "assistant" && <small className={styles.messageProvenance}>{messageProvenance(message)}</small>}
                {message.role === "assistant" && message.callId && <AiOutputReport callId={message.callId} />}
              </div>
            ))}
            {busy && <div className={styles.assistantBubble}>Thinking from the published course and your current evidence…</div>}
          </div>

          <div className={styles.composer}>
            {error && <p className={styles.composerError} role="alert">{error}</p>}
            {sanitizationNotice && <p className={styles.archiveNotice} role="status">{sanitizationNotice}</p>}
            {archived && <p className={styles.archiveNotice}>This thread is archived. Reopen it to continue, or start a new conversation.</p>}
            <textarea
              aria-label="Message Codestead"
              placeholder={archived ? "Reopen this thread to send a message." : "Ask why, request another example, or paste a compiler error…"}
              value={value}
              disabled={interactionLocked || archived}
              onChange={(event) => {
                const nextValue = event.target.value;
                setDrafts((current) => ({ ...current, [draftKey]: nextValue }));
                if (failedSend?.draftKey === draftKey && failedSend.content !== nextValue.trim()) {
                  setFailedSend(null);
                }
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void send();
                }
              }}
            />
            <button className="button button-primary" disabled={interactionLocked || archived || !value.trim()} onClick={() => void send()}>
              <Send size={16} /> Send
            </button>
          </div>
        </div>
      </section>

      <div className={styles.securityExplainer}>
        <span><strong><BookOpen size={13} /> Authored grounding</strong><small>The course version and skill sources anchor the explanation.</small></span>
        <span><strong><BrainCircuit size={13} /> Structured memory</strong><small>Relevant summaries and misconceptions, not a raw history dump.</small></span>
        <span><strong><ShieldCheck size={13} /> No authority</strong><small>Deterministic services own grading, mastery, code, and publication.</small></span>
      </div>
    </div>
  );
}
