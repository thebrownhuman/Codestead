"use client";

import {
  ArrowLeft,
  CheckCircle2,
  Clock3,
  Mail,
  RefreshCw,
  ShieldCheck,
  UserCheck,
  XCircle,
} from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import {
  formatDateTime,
  formatRelativeTime,
  humanize,
  requestAdminJson,
} from "./admin-utils";
import styles from "./admin.module.css";
import { EmptyState, ErrorState, LoadingState, StatusPill } from "./status-pill";
import type { AccessRequestQueueData } from "./types";

interface ApprovalResponse {
  readonly ok: boolean;
  readonly expiresAt: string;
}

interface RejectionResponse {
  readonly ok: boolean;
}

export function AccessRequestQueue() {
  const [data, setData] = useState<AccessRequestQueueData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [submittingId, setSubmittingId] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    setError(null);
    try {
      setData(await requestAdminJson<AccessRequestQueueData>("/api/admin/access-requests", { signal }));
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === "AbortError") return;
      setError(cause instanceof Error ? cause.message : "Unable to load access requests.");
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void requestAdminJson<AccessRequestQueueData>("/api/admin/access-requests", {
      signal: controller.signal,
    })
      .then(setData)
      .catch((cause: unknown) => {
        if (cause instanceof DOMException && cause.name === "AbortError") return;
        setError(cause instanceof Error ? cause.message : "Unable to load access requests.");
      });
    return () => controller.abort();
  }, []);

  async function approve(requestId: string) {
    const reason = reasons[requestId]?.trim() ?? "";
    if (reason.length < 8) {
      setActionMessage("Add a specific review reason of at least 8 characters before approval.");
      return;
    }
    setSubmittingId(requestId);
    setActionMessage(null);
    try {
      const result = await requestAdminJson<ApprovalResponse>(
        `/api/admin/access-requests/${encodeURIComponent(requestId)}/approve`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reason }),
        },
      );
      setReasons((current) => ({ ...current, [requestId]: "" }));
      setActionMessage(`Invitation queued. It expires ${formatDateTime(result.expiresAt)}.`);
      await load();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Approval failed.";
      setActionMessage(
        message === "FRESH_MFA_REQUIRED"
          ? "Fresh MFA verification is required before an invitation can be issued."
          : message,
      );
    } finally {
      setSubmittingId(null);
    }
  }

  async function reject(requestId: string) {
    const reason = reasons[requestId]?.trim() ?? "";
    if (reason.length < 8) {
      setActionMessage("Add a specific review reason of at least 8 characters before rejection.");
      return;
    }
    setSubmittingId(requestId);
    setActionMessage(null);
    try {
      await requestAdminJson<RejectionResponse>(
        `/api/admin/access-requests/${encodeURIComponent(requestId)}/reject`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reason }),
        },
      );
      setReasons((current) => ({ ...current, [requestId]: "" }));
      setActionMessage("Request rejected and the applicant was notified.");
      await load();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Rejection failed.";
      setActionMessage(
        message === "FRESH_MFA_REQUIRED"
          ? "Fresh MFA verification is required before an access request can be rejected."
          : message,
      );
    } finally {
      setSubmittingId(null);
    }
  }

  if (!data && !error) return <LoadingState label="Loading access-request queue" />;
  if (!data && error) return <ErrorState message={error} onRetry={() => void load()} />;
  if (!data) return null;

  return (
    <div className={styles.adminPage}>
      <section className={styles.pageHead}>
        <div>
          <Link className={styles.textLink} href="/admin"><ArrowLeft size={14} /> Operations overview</Link>
          <span className={styles.eyebrow}>Invitation gate · administrator decision</span>
          <h1>Review learning <span>seat requests.</span></h1>
          <p>Read only what is needed to decide access. Approval or rejection requires a fresh MFA session and a durable review reason; approval creates a single-use, 24-hour invitation and audit event.</p>
        </div>
        <div className={styles.headActions}><span>Updated {formatRelativeTime(data.generatedAt)}</span><button className="button button-secondary" onClick={() => void load()} type="button"><RefreshCw size={14} /> Refresh</button></div>
      </section>

      {error && <p className={styles.inlineError}>Showing the last successful queue. Refresh failed: {error}</p>}
      {actionMessage && <p className={actionMessage.startsWith("Invitation") || actionMessage.startsWith("Request rejected") ? styles.inlineSuccess : styles.inlineError} role="status">{actionMessage}</p>}

      <section className={styles.summaryGrid} aria-label="Access request state counts">
        {data.statusCounts.length ? data.statusCounts.map((row) => <article className={styles.summaryCard} key={row.status}><span><UserCheck size={16} /> {humanize(row.status)}</span><strong>{row.count}</strong><small>Requests in this state</small></article>) : <article className={styles.summaryCard}><span><UserCheck size={16} /> Total requests</span><strong>0</strong><small>No requests recorded</small></article>}
      </section>

      <section className={styles.panel}>
        <div className={styles.panelHead}><div><Clock3 size={18} /><span><strong>Pending review</strong><small>Oldest requests appear first</small></span></div><span className="pill">{data.pending.length} waiting</span></div>
        {data.pending.length ? <div className={styles.requestList}>{data.pending.map((item) => (
          <article className={styles.requestCard} key={item.id}>
            <div>
              <div className={styles.requestIdentity}><span className={styles.avatar}>{item.name.slice(0, 2).toUpperCase()}</span><div><strong>{item.name}</strong><a href={`mailto:${item.email}`}><Mail size={12} /> {item.email}</a><small>Requested {formatRelativeTime(item.createdAt)} · adult confirmation {item.adultConfirmedAt ? "recorded" : "missing"} · email {item.emailVerifiedAt ? "verified" : "not verified"}</small></div></div>
              <p className={styles.requestReason}>{item.reason?.trim() || "No reason was supplied with this request."}</p>
            </div>
            <div className={styles.approveForm}>
              <label htmlFor={`reason-${item.id}`}>Administrator review reason</label>
              <textarea id={`reason-${item.id}`} maxLength={500} onChange={(event) => setReasons((current) => ({ ...current, [item.id]: event.target.value }))} placeholder="Why is this learner appropriate for the private pilot?" value={reasons[item.id] ?? ""} />
              <div className={styles.headActions}>
                <button className="button button-secondary" disabled={submittingId === item.id} onClick={() => void reject(item.id)} type="button"><XCircle size={14} /> Reject</button>
                <button className="button button-primary" disabled={submittingId === item.id || !item.adultConfirmedAt} onClick={() => void approve(item.id)} type="button"><CheckCircle2 size={14} /> {submittingId === item.id ? "Working…" : "Approve and invite"}</button>
              </div>
            </div>
          </article>
        ))}</div> : <EmptyState title="Access queue is clear" detail="New private-pilot requests will appear here. Nothing needs approval right now." />}
      </section>

      <section className={styles.panel}>
        <div className={styles.panelHead}><div><UserCheck size={18} /><span><strong>Recent decisions</strong><small>Request metadata and recorded decision reason</small></span></div></div>
        {data.recent.length ? <div className={styles.tableWrap}><table className={styles.dataTable}><thead><tr><th>Requester</th><th>Status</th><th>Requested</th><th>Decided</th><th>Decision reason</th></tr></thead><tbody>{data.recent.map((item) => <tr key={item.id}><td><div className={styles.personCell}><span className={styles.avatar}>{item.name.slice(0, 2).toUpperCase()}</span><span><strong>{item.name}</strong><small>{item.email}</small></span></div></td><td><StatusPill status={item.status} /></td><td>{formatDateTime(item.createdAt)}</td><td>{formatDateTime(item.decidedAt)}</td><td>{item.decisionReason || "Not recorded"}</td></tr>)}</tbody></table></div> : <EmptyState title="No decisions yet" detail="Approved, rejected, expired and withdrawn requests will be retained here." />}
      </section>

      <p className={styles.safeNotice}><ShieldCheck size={15} /> This queue is a protected, no-store administrator view. It exposes applicant identity and stated reason only because both are required for the access decision; every decision remains MFA-gated and audited.</p>
    </div>
  );
}
