"use client";

import { Select } from "@/components/ui/select";

import { useCallback, useEffect, useState } from "react";
import { decodeSupportDetails } from "@/lib/learning-requests/support-contract";
import { formatDateTime, requestAdminJson } from "./admin-utils";
import { EmptyState, ErrorState, LoadingState } from "./status-pill";
import styles from "./admin.module.css";

type SupportRequest = {
  id: string; kind: string; subject: string; details: string; status: string;
  learnerName: string; learnerEmail: string; createdAt: string;
  decidedAt: string | null; decisionReason: string | null;
};

export function AdminSupportRequestQueue() {
  const [status, setStatus] = useState("open");
  const [items, setItems] = useState<SupportRequest[] | null>(null);
  const [replies, setReplies] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const url = `/api/admin/learning-requests?queue=support&status=${status}`;
  const load = useCallback(async () => {
    const body = await requestAdminJson<{ requests: SupportRequest[] }>(url);
    setItems(body.requests); setError(null);
  }, [url]);
  useEffect(() => {
    let cancelled = false;
    requestAdminJson<{ requests: SupportRequest[] }>(url)
      .then((body) => { if (!cancelled) { setItems(body.requests); setError(null); } })
      .catch((cause) => { if (!cancelled) setError(cause instanceof Error ? cause.message : "Requests are unavailable."); });
    return () => { cancelled = true; };
  }, [url]);
  async function markFixed(id: string) {
    if (busy) return;
    setBusy(id); setError(null);
    try {
      await requestAdminJson(`/api/admin/learning-requests/${encodeURIComponent(id)}/decision`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ decision: "fixed", reply: replies[id]?.trim() ?? "" }) });
      await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "The request could not be marked fixed."); }
    finally { setBusy(null); }
  }
  return <section className={styles.adminPage} aria-labelledby="support-queue-title">
    <div className={styles.pageHead}><div><h1 id="support-queue-title">Requests</h1><p>Review learner support requests and mark problems fixed. The learner receives a notification and email.</p></div><button type="button" className="button button-secondary" onClick={() => void load().catch((cause) => setError(cause instanceof Error ? cause.message : "Requests are unavailable."))}>Refresh requests</button></div>
    <label htmlFor="support-status">Request status</label><Select id="support-status" value={status} disabled={busy !== null} onChange={(event) => { setItems(null); setError(null); setStatus(event.target.value); }}><option value="open">Open</option><option value="resolved">Resolved</option></Select>
    {error && <ErrorState message={error} onRetry={() => void load().catch((cause) => setError(cause instanceof Error ? cause.message : "Requests are unavailable."))} />}
    {!items && !error && <LoadingState label="Loading requests" />}
    {items?.length === 0 && <EmptyState title="No requests" detail={`There are no ${status} support requests.`} />}
    <div className={styles.requestList}>{items?.map((item) => {
      const details = decodeSupportDetails(item.details);
      return <article key={item.id} className={styles.requestCard}><div><h2>{item.subject}</h2><small>{item.learnerName} · {item.learnerEmail} · {formatDateTime(item.createdAt)}</small><p className={styles.requestReason}>{details?.message ?? "Request details are unavailable."}</p>
        {details?.context && <p>Diagnostics: {Object.values(details.context).join(" · ")}</p>}
        {item.status === "pending" ? <div className={styles.approveForm}><label htmlFor={`support-reply-${item.id}`}>Optional reply</label><textarea id={`support-reply-${item.id}`} maxLength={500} value={replies[item.id] ?? ""} disabled={busy !== null} onChange={(event) => setReplies((current) => ({ ...current, [item.id]: event.target.value }))} /><button type="button" className="button button-primary" disabled={busy !== null} onClick={() => void markFixed(item.id)}>{busy === item.id ? "Saving…" : "Mark fixed"}</button></div> : <><p>Resolved {formatDateTime(item.decidedAt)}</p>{item.decisionReason && <p>Administrator reply: {item.decisionReason}</p>}</>}
      </div></article>;
    })}</div>
  </section>;
}
