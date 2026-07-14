"use client";

import { Lightbulb, LoaderCircle, Send } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import styles from "./product-pages.module.css";

const REQUEST_KINDS = new Set(["new-subject", "topic-extension", "content-defect"]);
const REQUEST_STATUSES = new Set(["pending", "approved", "rejected", "expired", "withdrawn"]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const INVALID_LIST_MESSAGE = "Your requests could not be read safely. Try again.";
const NETWORK_LIST_MESSAGE = "Requests are unavailable. Check your connection and try again.";
const REFRESH_WARNING = "The request was saved, but the latest list could not be refreshed. Your saved request remains shown below.";
const SUBMIT_FALLBACK = "The request could not be submitted. Try again.";
const SUBMIT_NETWORK_MESSAGE = "The request could not be submitted. Check your connection and try again.";
const INVALID_CONFIRMATION_MESSAGE = "The request may have been saved, but its confirmation could not be read. Try again to recover it.";

interface LearningRequestItem {
  readonly id: string;
  readonly kind: string;
  readonly subject: string;
  readonly details: string;
  readonly status: string;
  readonly decisionReason: string | null;
  readonly createdAt: string;
  readonly decidedAt: string | null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validDate(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && Number.isFinite(Date.parse(value));
}

function isLearningRequestItem(value: unknown): value is LearningRequestItem {
  if (!isObject(value)) return false;
  return typeof value.id === "string"
    && UUID_PATTERN.test(value.id)
    && typeof value.kind === "string"
    && REQUEST_KINDS.has(value.kind)
    && typeof value.subject === "string"
    && value.subject.trim().length >= 2
    && value.subject.length <= 120
    && typeof value.details === "string"
    && value.details.trim().length >= 10
    && value.details.length <= 2_000
    && typeof value.status === "string"
    && REQUEST_STATUSES.has(value.status)
    && (value.decisionReason === null || typeof value.decisionReason === "string")
    && validDate(value.createdAt)
    && (value.decidedAt === null || validDate(value.decidedAt));
}

function parseRequestList(value: unknown): readonly LearningRequestItem[] {
  if (!isObject(value) || !Array.isArray(value.requests) || !value.requests.every(isLearningRequestItem)) {
    throw new Error(INVALID_LIST_MESSAGE);
  }
  return value.requests;
}

function parseCreatedRequest(value: unknown): LearningRequestItem {
  if (!isObject(value) || !isLearningRequestItem(value.request)) {
    throw new Error(INVALID_CONFIRMATION_MESSAGE);
  }
  return value.request;
}

function apiError(value: unknown, fallback: string) {
  return isObject(value) && typeof value.error === "string" && value.error.trim()
    ? value.error
    : fallback;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function mergeRequests(
  serverItems: readonly LearningRequestItem[],
  visibleItems: readonly LearningRequestItem[],
) {
  const serverIds = new Set(serverItems.map((item) => item.id));
  return [...serverItems, ...visibleItems.filter((item) => !serverIds.has(item.id))];
}

export function LearningRequestsView() {
  const [items, setItems] = useState<readonly LearningRequestItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [hasResolvedList, setHasResolvedList] = useState(false);
  const [busy, setBusy] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ tone: "error" | "success"; text: string } | null>(null);
  const [subjectLength, setSubjectLength] = useState(0);
  const [detailsLength, setDetailsLength] = useState(0);
  const loadGeneration = useRef(0);
  const pendingRequest = useRef<{ readonly fingerprint: string; readonly requestId: string } | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    let response: Response;
    try {
      response = await fetch("/api/learning-requests", { cache: "no-store", signal });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      throw new Error(NETWORK_LIST_MESSAGE);
    }
    const body = await readJson(response);
    if (!response.ok) throw new Error(apiError(body, NETWORK_LIST_MESSAGE));
    return parseRequestList(body);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const generation = ++loadGeneration.current;
    void load(controller.signal)
      .then((requests) => {
        if (!controller.signal.aborted && generation === loadGeneration.current) {
          setItems(requests);
          setHasResolvedList(true);
          setListError(null);
        }
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted && generation === loadGeneration.current) {
          setListError(error instanceof Error ? error.message : NETWORK_LIST_MESSAGE);
        }
      })
      .finally(() => {
        if (!controller.signal.aborted && generation === loadGeneration.current) setLoading(false);
      });
    return () => controller.abort();
  }, [load]);

  const refreshList = useCallback(async (afterSave = false) => {
    const generation = ++loadGeneration.current;
    setRefreshing(true);
    setListError(null);
    try {
      const requests = await load();
      if (generation === loadGeneration.current) {
        setItems((visibleItems) => mergeRequests(requests, visibleItems));
        setHasResolvedList(true);
      }
    } catch (error) {
      if (generation === loadGeneration.current) {
        setListError(afterSave || hasResolvedList
          ? REFRESH_WARNING
          : error instanceof Error
            ? error.message
            : NETWORK_LIST_MESSAGE);
      }
    } finally {
      if (generation === loadGeneration.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [hasResolvedList, load]);

  function invalidatePendingRequest() {
    pendingRequest.current = null;
  }

  function retryIdentifier(input: { kind: string; subject: string; details: string }) {
    const fingerprint = JSON.stringify(input);
    if (pendingRequest.current?.fingerprint === fingerprint) return pendingRequest.current.requestId;
    const requestId = window.crypto.randomUUID();
    pendingRequest.current = { fingerprint, requestId };
    return requestId;
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const kind = String(data.get("kind") ?? "");
    const subject = String(data.get("subject") ?? "").trim();
    const details = String(data.get("details") ?? "").trim();
    if (subject.length < 2 || details.length < 10) {
      setFeedback({ tone: "error", text: "Add a subject of at least 2 characters and a description of at least 10 characters." });
      return;
    }

    const input = { kind, subject, details };
    const requestId = retryIdentifier(input);
    setBusy(true);
    setFeedback(null);
    try {
      const response = await fetch("/api/learning-requests", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ requestId, ...input }),
      });
      const body = await readJson(response);
      if (!response.ok) {
        setFeedback({ tone: "error", text: apiError(body, SUBMIT_FALLBACK) });
        return;
      }

      const created = parseCreatedRequest(body);
      ++loadGeneration.current;
      setItems((visibleItems) => [created, ...visibleItems.filter((item) => item.id !== created.id)]);
      setHasResolvedList(true);
      setLoading(false);
      setListError(null);
      pendingRequest.current = null;
      form.reset();
      setSubjectLength(0);
      setDetailsLength(0);
      setFeedback({ tone: "success", text: "Request sent to the administrator for curriculum review." });

      // Submission state ends when the durable POST result arrives. A list
      // refresh is deliberately independent so a slow read cannot lock or
      // erase the form and optimistic history entry.
      setBusy(false);
      void refreshList(true);
    } catch (error) {
      setFeedback({
        tone: "error",
        text: error instanceof Error && error.message === INVALID_CONFIRMATION_MESSAGE
          ? error.message
          : SUBMIT_NETWORK_MESSAGE,
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.page}>
      <header className={styles.pageHead}>
        <div><span className={styles.eyebrow}>Curriculum requests</span><h1>Ask for the next <span>useful thing.</span></h1><p>Request a new subject, extend an existing topic, or report a promised-content gap. AI never publishes a live course; the administrator reviews, sources, tests, and versions every accepted change.</p></div>
      </header>
      <section className={styles.requestLayout}>
        <form aria-labelledby="new-learning-request-title" className={`${styles.requestPanel} ${styles.requestForm} ${styles.form} card`} onSubmit={submit}>
          <div className={styles.requestPanelHead}><div><h2 id="new-learning-request-title">New request</h2><p>Tell the curriculum team what useful outcome is missing.</p></div></div>
          <label htmlFor="learning-request-kind"><span className={styles.requestLabel}>Request type <small>Required</small></span><select aria-describedby="learning-request-kind-help" aria-label="Request type" id="learning-request-kind" name="kind" defaultValue="topic-extension" onChange={invalidatePendingRequest} required><option value="topic-extension">Extend an existing topic</option><option value="new-subject">Add a new subject</option><option value="content-defect">Report missing promised content</option></select><small id="learning-request-kind-help">Choose the closest match; an administrator can refine the scope later.</small></label>
          <label htmlFor="learning-request-subject"><span className={styles.requestLabel}>Subject or topic <small>Required</small></span><input aria-describedby="learning-request-subject-help" aria-label="Subject or topic" id="learning-request-subject" name="subject" required minLength={2} maxLength={120} onChange={(event) => { invalidatePendingRequest(); setSubjectLength(event.currentTarget.value.length); }} placeholder="For example: High-performance computing" /><small className={styles.requestFieldMeta} id="learning-request-subject-help"><span>Use a short, specific title.</span><span>{subjectLength}/120</span></small></label>
          <label htmlFor="learning-request-details"><span className={styles.requestLabel}>What should the course cover? <small>Required</small></span><textarea aria-describedby="learning-request-details-help" aria-label="What should the course cover?" id="learning-request-details" name="details" required minLength={10} maxLength={2000} onChange={(event) => { invalidatePendingRequest(); setDetailsLength(event.currentTarget.value.length); }} placeholder="Describe the outcome you need, what you already know, and why it belongs in this course." /><small className={styles.requestFieldMeta} id="learning-request-details-help"><span>Include the desired outcome and why it matters.</span><span>{detailsLength}/2000</span></small></label>
          <div className={styles.requestSubmitRow}><button aria-busy={busy} className="button button-primary" disabled={busy} type="submit"><Send aria-hidden="true" size={16} /> {busy ? "Sending…" : "Send for review"}</button><small>Submitting creates a review request; it never publishes content automatically.</small></div>
          {feedback && <p className={feedback.tone === "error" ? styles.error : styles.success} role={feedback.tone === "error" ? "alert" : "status"}>{feedback.text}</p>}
        </form>
        <article aria-labelledby="learning-request-history-title" className={`${styles.requestPanel} ${styles.requestHistory} card`}>
          <div className={styles.requestPanelHead}><div><h2 id="learning-request-history-title">Your requests</h2><p>Track triage decisions without confusing acceptance with publication.</p></div>{!loading && <span className={`${styles.requestCount} pill`}>{items.length}</span>}</div>
          {loading
            ? <p aria-live="polite" className={styles.requestLoading}><LoaderCircle aria-hidden="true" size={16} /> Loading requests…</p>
            : <>
                {refreshing && <p aria-live="polite" className={styles.requestRefreshing}><LoaderCircle aria-hidden="true" size={15} /> Refreshing requests…</p>}
                {listError && <div className={styles.requestLoadError}><p role="alert">{listError}</p><button aria-busy={refreshing} className="button button-secondary" disabled={refreshing} onClick={() => void refreshList()} type="button">Try again</button></div>}
                {hasResolvedList && (items.length === 0
                  ? <div className={styles.requestEmpty}><Lightbulb aria-hidden="true" size={20} /><strong>No requests yet</strong><p>Your submitted curriculum ideas and their review status will appear here.</p></div>
                  : <ul className={styles.requestList}>{items.map((item) => <li className={styles.requestItem} key={item.id}><span aria-hidden="true" className={styles.providerMark}><Lightbulb size={17} /></span><div><div className={styles.requestItemHead}><strong>{item.subject}</strong><span className="pill">{item.status.replaceAll("-", " ")}</span></div><small>{item.kind.replaceAll("-", " ")} · <time dateTime={item.createdAt}>{new Date(item.createdAt).toLocaleDateString()}</time></small><p>{item.details}</p>{item.decisionReason && <p className={styles.requestDecision}><strong>Administrator note</strong>{item.decisionReason}</p>}</div></li>)}</ul>)}
              </>}
        </article>
      </section>
    </div>
  );
}
