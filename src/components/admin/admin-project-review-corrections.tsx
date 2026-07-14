"use client";

import { FileSearch, RefreshCw, ShieldCheck, Wrench } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { formatDateTime, humanize, requestAdminJson } from "./admin-utils";
import styles from "./admin.module.css";
import { StatusPill } from "./status-pill";

type CorrectionSummary = {
  id: string;
  projectId: string;
  projectTitle: string;
  userId: string;
  learnerName: string;
  sourceReviewId: string;
  sourceAppealId: string | null;
  revision: number;
  sourceCommitSha: string;
  status: string;
  attemptCount: number;
  lastErrorCode: string | null;
  deadLettered: boolean;
  deadLetteredAt: string | null;
  projectionApplied: boolean | null;
  createdAt: string;
  completedAt: string | null;
};

type CorrectionDetail = {
  correction: CorrectionSummary & {
    requestedBy: string;
    reason: string;
    sourceAnalyzerVersion: string;
    sourceRubricVersion: string;
    sourceProvenance: Record<string, unknown>;
    sourceFindingsHash: string;
    targetAnalyzerVersion: string;
    targetRubricVersion: string;
    resultFindings: Array<Record<string, unknown>> | null;
    resultFindingsHash: string | null;
    resultProvenance: Record<string, unknown> | null;
    evidence: Record<string, unknown> | null;
    evidenceHash: string | null;
    evidenceHashValid: boolean;
    startedAt: string | null;
  };
  timeline: Array<{
    id: string;
    actorRole: string;
    event: string;
    reason: string;
    evidenceHash: string;
    evidenceHashValid: boolean;
    occurredAt: string;
  }>;
};

export function AdminProjectReviewCorrections() {
  const [scope, setScope] = useState<"actionable" | "all">("actionable");
  const [corrections, setCorrections] = useState<CorrectionSummary[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<CorrectionDetail | null>(null);
  const [sourceReviewId, setSourceReviewId] = useState("");
  const [reason, setReason] = useState("");
  const [totp, setTotp] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef<{ fingerprint: string; id: string } | null>(null);

  const load = useCallback(async () => {
    const body = await requestAdminJson<{ corrections: CorrectionSummary[] }>(
      `/api/admin/project-review-corrections?scope=${scope}`,
    );
    setCorrections(body.corrections);
    setSelectedId((current) => current ?? body.corrections[0]?.id ?? null);
  }, [scope]);

  useEffect(() => {
    const controller = new AbortController();
    void requestAdminJson<{ corrections: CorrectionSummary[] }>(
      `/api/admin/project-review-corrections?scope=${scope}`,
      { signal: controller.signal },
    ).then((body) => {
      setCorrections(body.corrections);
      setSelectedId((current) => current ?? body.corrections[0]?.id ?? null);
    }).catch((loadError: unknown) => {
      if (!controller.signal.aborted) setError(
        loadError instanceof Error ? loadError.message : "Corrections could not be loaded.",
      );
    });
    return () => controller.abort();
  }, [scope]);

  useEffect(() => {
    if (!selectedId) {
      return;
    }
    const controller = new AbortController();
    void requestAdminJson<{ detail: CorrectionDetail }>(
      `/api/admin/project-review-corrections/${encodeURIComponent(selectedId)}`,
      { signal: controller.signal },
    ).then((body) => setDetail(body.detail)).catch((loadError: unknown) => {
      if (!controller.signal.aborted) setError(
        loadError instanceof Error ? loadError.message : "Correction evidence could not be loaded.",
      );
    });
    return () => controller.abort();
  }, [selectedId]);

  async function verifyMfa() {
    if (!/^\d{6}$/.test(totp)) throw new Error("Enter the current six-digit authenticator code.");
    await requestAdminJson("/api/security/fresh-mfa", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: totp }),
    });
  }

  async function queueCorrection(event: React.FormEvent) {
    event.preventDefault();
    const trimmedReason = reason.trim();
    const fingerprint = `${sourceReviewId}:${trimmedReason}`;
    if (requestRef.current?.fingerprint !== fingerprint) {
      requestRef.current = { fingerprint, id: crypto.randomUUID() };
    }
    setBusy(true);
    setMessage(null);
    setError(null);
    try {
      await verifyMfa();
      const body = await requestAdminJson<{
        correction: CorrectionSummary;
        execution: { state: string; worker: string };
      }>("/api/admin/project-review-corrections", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          requestId: requestRef.current.id,
          sourceReviewId,
          reason: trimmedReason,
        }),
      });
      setSelectedId(body.correction.id);
      setMessage(`Correction was durably queued for ${body.execution.worker}. The original and effective reviews remain unchanged until verified worker completion.`);
      setTotp("");
      requestRef.current = null;
      await load();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Correction could not be queued.");
    } finally {
      setBusy(false);
    }
  }

  async function retry() {
    if (!detail) return;
    setBusy(true);
    setMessage(null);
    setError(null);
    try {
      await verifyMfa();
      const retryReason = `Retry deterministic static re-analysis after reviewed failure ${detail.correction.lastErrorCode ?? "state"}.`;
      const body = await requestAdminJson<{
        report: { status: string; duplicate: boolean };
        execution: { state: string; worker: string };
      }>(
        `/api/admin/project-review-corrections/${encodeURIComponent(detail.correction.id)}/run`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ requestId: crypto.randomUUID(), reason: retryReason }),
        },
      );
      setMessage(`Retry ${body.report.duplicate ? "was already" : "is now"} durably queued for ${body.execution.worker}.`);
      setTotp("");
      const refreshed = await requestAdminJson<{ detail: CorrectionDetail }>(
        `/api/admin/project-review-corrections/${encodeURIComponent(detail.correction.id)}`,
      );
      setDetail(refreshed.detail);
      await load();
    } catch (retryError) {
      setError(retryError instanceof Error ? retryError.message : "Correction retry failed safely.");
    } finally {
      setBusy(false);
    }
  }

  return <main className={styles.adminPage}>
    <header className={styles.pageHead}>
      <div><span className={styles.eyebrow}>Append-only evidence</span><h1>Project review <span>corrections</span></h1><p>Re-analyze the exact pinned commit with static rules. Original findings remain immutable; no AI or repository execution is permitted.</p></div>
      <div className={styles.headActions}>
        <label className={styles.compactField}>Queue<select aria-label="Correction queue scope" onChange={(event) => setScope(event.target.value as typeof scope)} value={scope}><option value="actionable">Needs action</option><option value="all">All</option></select></label>
        <button aria-label="Refresh corrections" className="button button-secondary" onClick={() => void load()} type="button"><RefreshCw size={14} /> Refresh</button>
      </div>
    </header>
    {error && <p className={styles.inlineError} role="alert">{error}</p>}
    {message && <p className={styles.inlineSuccess} role="status">{message}</p>}
    <article className={styles.panel}>
      <div className={styles.panelHead}><div><Wrench size={18} /><span><strong>Record a defective review</strong><small>Fresh MFA, reason, exact review id, audit and learner notice are required</small></span></div></div>
      <form className={styles.appealDecisionForm} onSubmit={queueCorrection}>
        <label>Source review id<input onChange={(event) => { setSourceReviewId(event.target.value); requestRef.current = null; }} required type="text" value={sourceReviewId} /></label>
        <label>Correction reason<textarea maxLength={500} minLength={20} onChange={(event) => { setReason(event.target.value); requestRef.current = null; }} required value={reason} /></label>
        <label>Current six-digit authenticator code<input autoComplete="one-time-code" inputMode="numeric" maxLength={6} onChange={(event) => setTotp(event.target.value.replace(/\D/g, ""))} type="password" value={totp} /></label>
        <button className="button button-primary" disabled={busy} type="submit"><ShieldCheck size={15} /> Queue static correction</button>
      </form>
    </article>
    <div className={styles.appealWorkspace}>
      <aside aria-label="Project review correction queue" className={styles.appealQueue}>
        <div className={styles.panelHead}><div><FileSearch size={18} /><span><strong>Correction queue</strong><small>{corrections?.length ?? 0} visible</small></span></div></div>
        {corrections?.map((item) => <button aria-current={selectedId === item.id ? "true" : undefined} className={`${styles.appealQueueItem} ${selectedId === item.id ? styles.appealQueueItemActive : ""}`} key={item.id} onClick={() => setSelectedId(item.id)} type="button"><span><strong>{item.projectTitle}</strong><small>{item.learnerName} · revision {item.revision}</small></span><StatusPill status={item.status} /><p>Commit {item.sourceCommitSha.slice(0, 12)} · {formatDateTime(item.createdAt)}</p></button>)}
        {corrections?.length === 0 && <p className={styles.mutedText}>No corrections match this queue.</p>}
      </aside>
      <section aria-label="Project correction evidence" className={styles.appealDetail}>
        {detail ? <>
          <article className={styles.panel}><div className={styles.panelHead}><div><ShieldCheck size={18} /><span><strong>{detail.correction.projectTitle}</strong><small>Correction v{detail.correction.revision} · {detail.correction.learnerName}</small></span></div><StatusPill status={detail.correction.status} /></div><p>{detail.correction.reason}</p><p className={detail.correction.evidenceHashValid ? styles.hashGood : styles.mutedText}>Evidence {detail.correction.evidenceHash ? detail.correction.evidenceHashValid ? "hash verified" : "hash invalid" : "pending"}. Projection {detail.correction.projectionApplied === null ? "pending" : detail.correction.projectionApplied ? "updated" : "preserved newer review"}.</p>{detail.correction.deadLettered && <p className={styles.inlineError} role="alert">Dead-lettered after {detail.correction.attemptCount} attempts. Create a newly reviewed correction version; this evidence cannot be silently retried.</p>}<details className={styles.evidenceDisclosure}><summary>Static provenance and evidence</summary><pre>{JSON.stringify({ source: detail.correction.sourceProvenance, result: detail.correction.resultProvenance, evidence: detail.correction.evidence }, null, 2)}</pre></details>{detail.correction.status === "failed" && !detail.correction.deadLettered && <button className="button button-secondary" disabled={busy} onClick={() => void retry()} type="button"><RefreshCw size={14} /> Queue retry</button>}</article>
          <article className={styles.panel}><div className={styles.panelHead}><div><FileSearch size={18} /><span><strong>Append-only timeline</strong><small>Every event carries a verified evidence hash</small></span></div></div><ol className={styles.appealTimeline}>{detail.timeline.map((entry) => <li key={entry.id}><span><strong>{humanize(entry.event)}</strong><small>{entry.actorRole} · {formatDateTime(entry.occurredAt)} · {entry.evidenceHashValid ? "verified" : "invalid"}</small></span><p>{entry.reason}</p></li>)}</ol></article>
        </> : <div className={styles.emptyState}><FileSearch size={22} /><strong>Select a correction</strong><p>Inspect source provenance, result evidence and projection outcome.</p></div>}
      </section>
    </div>
  </main>;
}
