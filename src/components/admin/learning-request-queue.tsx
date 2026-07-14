"use client";

import { BookPlus, CheckCircle2, RefreshCw, XCircle } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { formatDateTime, requestAdminJson } from "./admin-utils";
import styles from "./admin.module.css";
import { EmptyState, ErrorState, LoadingState, StatusPill } from "./status-pill";

interface AdminLearningRequest {
  readonly id: string;
  readonly learnerName: string;
  readonly learnerEmail: string;
  readonly kind: string;
  readonly subject: string;
  readonly details: string;
  readonly status: string;
  readonly decisionReason: string | null;
  readonly createdAt: string;
  readonly decidedAt: string | null;
}

export function AdminLearningRequestQueue() {
  const [items, setItems] = useState<readonly AdminLearningRequest[] | null>(null);
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const body = await requestAdminJson<{ requests: readonly AdminLearningRequest[] }>("/api/admin/learning-requests");
    setItems(body.requests);
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/admin/learning-requests", { cache: "no-store" })
      .then(async (response) => {
        const body = await response.json() as { requests?: readonly AdminLearningRequest[]; error?: string };
        if (!response.ok) throw new Error(body.error ?? "Curriculum requests are unavailable.");
        return body.requests ?? [];
      })
      .then((requests) => { if (!cancelled) setItems(requests); })
      .catch((cause: unknown) => { if (!cancelled) setError(cause instanceof Error ? cause.message : "Curriculum requests are unavailable."); });
    return () => { cancelled = true; };
  }, []);

  async function decide(id: string, decision: "approved" | "rejected") {
    const reason = reasons[id]?.trim() ?? "";
    if (reason.length < 8) {
      setError("Enter a specific decision reason of at least 8 characters.");
      return;
    }
    setBusy(id);
    setError(null);
    try {
      await requestAdminJson(`/api/admin/learning-requests/${encodeURIComponent(id)}/decision`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision, reason }),
      });
      await load();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Decision failed.";
      setError(message === "FRESH_MFA_REQUIRED" ? "Verify fresh MFA before deciding a curriculum request." : message);
    } finally {
      setBusy(null);
    }
  }

  if (!items && !error) return <LoadingState label="Loading curriculum requests" />;
  if (!items && error) return <ErrorState message={error} onRetry={() => void load()} />;
  if (!items) return null;
  const pending = items.filter((item) => item.status === "pending");
  const decided = items.filter((item) => item.status !== "pending");

  return (
    <div className={styles.adminPage}>
      <section className={styles.pageHead}><div><span className={styles.eyebrow}>Versioned curriculum governance</span><h1>Review learner <span>content requests.</span></h1><p>Approval accepts the request into sourcing and implementation; it never publishes a generated live course. Publication remains a separate tested, reviewed, versioned gate.</p></div><button className="button button-secondary" onClick={() => void load()}><RefreshCw size={14} /> Refresh</button></section>
      {error && <p className={styles.inlineError} role="alert">{error}</p>}
      <section className={styles.panel}>
        <div className={styles.panelHead}><div><BookPlus size={18} /><span><strong>Pending triage</strong><small>New subjects, extensions, and content defects</small></span></div><span className="pill">{pending.length} waiting</span></div>
        {pending.length === 0 ? <EmptyState title="No requests need triage" detail="Learner curriculum requests will appear here." /> : <div className={styles.requestList}>{pending.map((item) => <article className={styles.requestCard} key={item.id}><div><strong>{item.subject}</strong><small>{item.kind.replaceAll("-", " ")} · {item.learnerName} · {item.learnerEmail} · {formatDateTime(item.createdAt)}</small><p className={styles.requestReason}>{item.details}</p></div><div className={styles.approveForm}><label htmlFor={`learning-reason-${item.id}`}>Decision reason</label><textarea id={`learning-reason-${item.id}`} maxLength={500} value={reasons[item.id] ?? ""} onChange={(event) => setReasons((current) => ({ ...current, [item.id]: event.target.value }))} /><div className={styles.headActions}><button className="button button-secondary" disabled={busy === item.id} onClick={() => void decide(item.id, "rejected")}><XCircle size={14} /> Reject</button><button className="button button-primary" disabled={busy === item.id} onClick={() => void decide(item.id, "approved")}><CheckCircle2 size={14} /> Accept for planning</button></div></div></article>)}</div>}
      </section>
      <section className={styles.panel}>
        <div className={styles.panelHead}><div><BookPlus size={18} /><span><strong>Recent decisions</strong><small>Approval is not publication</small></span></div></div>
        {decided.length === 0 ? <EmptyState title="No decisions yet" detail="Reviewed requests retain the recorded reason." /> : <div className={styles.tableWrap}><table className={styles.dataTable}><thead><tr><th>Subject</th><th>Learner</th><th>Status</th><th>Decision</th><th>Reason</th></tr></thead><tbody>{decided.map((item) => <tr key={item.id}><td>{item.subject}</td><td>{item.learnerName}</td><td><StatusPill status={item.status} /></td><td>{formatDateTime(item.decidedAt)}</td><td>{item.decisionReason}</td></tr>)}</tbody></table></div>}
      </section>
    </div>
  );
}
