"use client";

import { AlertTriangle, FileCheck2, Play, RefreshCw, ShieldCheck, Wrench } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { formatDateTime, humanize, requestAdminJson } from "./admin-utils";
import styles from "./admin.module.css";
import { StatusPill } from "./status-pill";

interface CorrectionSummary {
  readonly id: string;
  readonly sourceAppealId: string | null;
  readonly status: string;
  readonly defectKind: string;
  readonly courseId: string;
  readonly moduleId: string;
  readonly itemId: string;
  readonly contentVersion: string;
  readonly faultyBundleVersion: string;
  readonly replacementBundleVersion: string;
  readonly affectedCount: number;
  readonly rowVersion: number;
  readonly jobs: { readonly succeeded: number; readonly failed: number; readonly pending: number };
  readonly masteryRepairs: { readonly applied: number; readonly unresolved: number; readonly pending: number };
  readonly createdAt: string;
  readonly completedAt: string | null;
}

interface CorrectionDetail {
  readonly correction: {
    readonly id: string;
    readonly status: string;
    readonly rowVersion: number;
    readonly affectedCount: number;
    readonly target: {
      readonly courseId: string;
      readonly moduleId: string;
      readonly itemId: string;
      readonly skillId: string;
      readonly contentVersion: string;
      readonly faultyBundleVersion: string;
      readonly faultyEvidenceHash: string;
    };
    readonly replacement: {
      readonly bundleVersion: string;
      readonly evidenceHash: string;
      readonly reviewHash: string;
    };
  };
  readonly events: readonly {
    readonly id: string;
    readonly actorRole: string;
    readonly event: string;
    readonly reason: string;
    readonly evidenceHash: string;
    readonly occurredAt: string;
  }[];
  readonly impacts: readonly {
    readonly id: string;
    readonly attemptId: string;
    readonly learnerName: string;
    readonly formId: string;
    readonly jobStatus: string;
    readonly attemptCount: number;
    readonly hashes: {
      readonly form: string;
      readonly answers: string;
      readonly originalResult: string;
      readonly snapshot: string;
      readonly correctedResult: string | null;
    };
    readonly correctedResult: Record<string, unknown> | null;
  }[];
  readonly masteryRepairs: readonly {
    readonly id: string;
    readonly attemptId: string;
    readonly skillId: string;
    readonly languageContext: string;
    readonly effect: string;
    readonly status: string;
    readonly attemptCount: number;
    readonly errorCode: string | null;
    readonly resolutionCode: string | null;
    readonly appliedAt: string | null;
    readonly updatedAt: string;
  }[];
}

const replacementExample = JSON.stringify({
  kind: "runner-tests",
  bundleVersion: "reviewed-v2",
  runtimeImageDigest: `sha256:${"0".repeat(64)}`,
  tests: [{
    id: "visible-1",
    visibility: "VISIBLE",
    category: "functional",
    stdin: "",
    expectedStdout: "expected output\n",
    comparison: "EXACT",
    critical: true,
  }, {
    id: "hidden-1",
    visibility: "HIDDEN",
    category: "edge-case",
    stdin: "edge input\n",
    expectedStdout: "edge output\n",
    comparison: "TRIMMED",
    critical: true,
  }],
}, null, 2);

export function AdminAssessmentCorrections({ initialAppealId = "" }: { readonly initialAppealId?: string }) {
  const [scope, setScope] = useState<"open" | "all">("open");
  const [corrections, setCorrections] = useState<readonly CorrectionSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<CorrectionDetail | null>(null);
  const [appealId, setAppealId] = useState(initialAppealId);
  const [itemId, setItemId] = useState("");
  const [defectKind, setDefectKind] = useState("faulty_test");
  const [reason, setReason] = useState("");
  const [evidenceRef, setEvidenceRef] = useState("");
  const [reviewNote, setReviewNote] = useState("");
  const [replacementJson, setReplacementJson] = useState(replacementExample);
  const [queueReason, setQueueReason] = useState("");
  const [totp, setTotp] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef<{ fingerprint: string; id: string } | null>(null);

  const load = useCallback(async () => {
    const body = await requestAdminJson<{ corrections: readonly CorrectionSummary[] }>(
      `/api/admin/assessment-corrections?scope=${scope}`,
    );
    setCorrections(body.corrections);
    setSelectedId((current) => current ?? body.corrections[0]?.id ?? null);
  }, [scope]);

  useEffect(() => {
    const controller = new AbortController();
    void requestAdminJson<{ corrections: readonly CorrectionSummary[] }>(
      `/api/admin/assessment-corrections?scope=${scope}`,
      { signal: controller.signal },
    ).then((body) => {
      setCorrections(body.corrections);
      setSelectedId((current) => current ?? body.corrections[0]?.id ?? null);
    }).catch((cause: unknown) => {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Correction queue could not be loaded.");
    });
    return () => controller.abort();
  }, [scope]);

  useEffect(() => {
    if (!selectedId) return;
    const controller = new AbortController();
    void requestAdminJson<{ detail: CorrectionDetail }>(
      `/api/admin/assessment-corrections/${encodeURIComponent(selectedId)}`,
      { signal: controller.signal },
    ).then((body) => setDetail(body.detail)).catch((cause: unknown) => {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Correction evidence could not be loaded.");
    });
    return () => controller.abort();
  }, [selectedId]);

  async function freshMfa() {
    if (!/^\d{6}$/.test(totp)) throw new Error("Enter the current six-digit authenticator code.");
    await requestAdminJson("/api/security/fresh-mfa", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: totp }),
    });
  }

  async function createCorrection() {
    setMessage(null);
    setError(null);
    let replacementEvidence: unknown;
    try {
      replacementEvidence = JSON.parse(replacementJson);
    } catch {
      setError("Replacement evidence must be valid JSON.");
      return;
    }
    const payload = {
      appealId: appealId.trim(),
      itemId: itemId.trim(),
      defectKind,
      reason: reason.trim(),
      replacementEvidence,
      review: {
        reviewerKind: "human",
        specificationClarified: true,
        expectedOutputsReviewed: true,
        hiddenTestCoverageReviewed: true,
        pinnedRuntimeReviewed: true,
        evidenceRef: evidenceRef.trim(),
        note: reviewNote.trim(),
      },
    };
    const fingerprint = JSON.stringify(payload);
    if (requestRef.current?.fingerprint !== fingerprint) {
      requestRef.current = { fingerprint, id: crypto.randomUUID() };
    }
    setBusy(true);
    try {
      await freshMfa();
      const body = await requestAdminJson<{
        report: { readonly id: string; readonly affectedCount: number };
      }>("/api/admin/assessment-corrections", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ requestId: requestRef.current.id, ...payload }),
      });
      setMessage(`Reviewed correction created. ${body.report.affectedCount} exact attempt${body.report.affectedCount === 1 ? "" : "s"} will be regraded after you queue it.`);
      setSelectedId(body.report.id);
      setTotp("");
      requestRef.current = null;
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Correction creation failed safely.");
    } finally {
      setBusy(false);
    }
  }

  async function queueCorrection() {
    if (!detail) return;
    setMessage(null);
    setError(null);
    if (queueReason.trim().length < 20) {
      setError("Record a queue reason of at least 20 characters.");
      return;
    }
    setBusy(true);
    try {
      await freshMfa();
      await requestAdminJson(`/api/admin/assessment-corrections/${encodeURIComponent(detail.correction.id)}/queue`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          requestId: crypto.randomUUID(),
          expectedVersion: detail.correction.rowVersion,
          reason: queueReason.trim(),
        }),
      });
      setMessage("Automatic deterministic regrading is queued. The isolated regrade worker will process at most two jobs per batch.");
      setTotp("");
      setQueueReason("");
      await load();
      const refreshed = await requestAdminJson<{ detail: CorrectionDetail }>(
        `/api/admin/assessment-corrections/${encodeURIComponent(detail.correction.id)}`,
      );
      setDetail(refreshed.detail);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Correction queueing failed safely.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className={styles.adminPage}>
      <header className={styles.pageHead}>
        <div><span className={styles.eyebrow}>Immutable grading repair</span><h1>Assessment <span>corrections</span></h1><p>Bind a human-reviewed replacement to an overturned appeal, preview every exact affected form, and append superseding deterministic results.</p></div>
        <div className={styles.headActions}>
          <label className={styles.compactField}>Queue<select aria-label="Correction queue scope" value={scope} onChange={(event) => setScope(event.target.value as typeof scope)}><option value="open">Open</option><option value="all">All</option></select></label>
          <button className="button button-secondary" onClick={() => void load()} type="button"><RefreshCw size={14} /> Refresh</button>
        </div>
      </header>
      {error && <p className={styles.inlineError} role="alert">{error}</p>}
      {message && <p className={styles.inlineSuccess} role="status">{message}</p>}

      <article className={styles.panel}>
        <div className={styles.panelHead}><div><Wrench size={18} /><span><strong>Review a replacement</strong><small>Fresh MFA and human review evidence required; hidden tests never appear in list/detail responses</small></span></div></div>
        <div className={styles.appealDecisionForm}>
          <label>Overturned appeal ID<input aria-label="Overturned appeal ID" value={appealId} onChange={(event) => { setAppealId(event.target.value); requestRef.current = null; }} /></label>
          <label>Exact exam item ID<input aria-label="Exact exam item ID" value={itemId} onChange={(event) => { setItemId(event.target.value); requestRef.current = null; }} /></label>
          <label>Defect kind<select aria-label="Defect kind" value={defectKind} onChange={(event) => setDefectKind(event.target.value)}><option value="faulty_test">Faulty test</option><option value="ambiguous_oracle">Ambiguous oracle</option><option value="runtime_defect">Runtime defect</option></select></label>
          <label>Recorded correction reason<textarea aria-label="Recorded correction reason" maxLength={2000} minLength={20} value={reason} onChange={(event) => { setReason(event.target.value); requestRef.current = null; }} /></label>
          <label>Human review evidence reference<input aria-label="Human review evidence reference" value={evidenceRef} onChange={(event) => setEvidenceRef(event.target.value)} /></label>
          <label>Human review note<textarea aria-label="Human review note" maxLength={2000} minLength={20} value={reviewNote} onChange={(event) => setReviewNote(event.target.value)} /></label>
          <label>Reviewed replacement test evidence JSON<textarea aria-label="Reviewed replacement test evidence JSON" spellCheck={false} rows={18} value={replacementJson} onChange={(event) => { setReplacementJson(event.target.value); requestRef.current = null; }} /><small>Use a new bundle version and the exact digest returned by the pinned runner image. Keep at least one hidden test when the faulty version had hidden coverage.</small></label>
          <label>Current six-digit authenticator code<input aria-label="Correction authenticator code" autoComplete="one-time-code" inputMode="numeric" maxLength={6} type="password" value={totp} onChange={(event) => setTotp(event.target.value.replace(/\D/g, ""))} /></label>
          <button className="button button-primary" disabled={busy} onClick={() => void createCorrection()} type="button"><ShieldCheck size={15} /> {busy ? "Recording…" : "Preview impact and record correction"}</button>
        </div>
      </article>

      <div className={styles.appealWorkspace}>
        <aside aria-label="Assessment correction queue" className={styles.appealQueue}>
          <div className={styles.panelHead}><div><AlertTriangle size={18} /><span><strong>Correction queue</strong><small>{corrections.length} visible</small></span></div></div>
          {corrections.length === 0 ? <p className={styles.mutedText}>No corrections match this view.</p> : corrections.map((item) => <button aria-current={selectedId === item.id ? "true" : undefined} className={`${styles.appealQueueItem} ${selectedId === item.id ? styles.appealQueueItemActive : ""}`} key={item.id} onClick={() => setSelectedId(item.id)} type="button"><span><strong>{item.itemId}</strong><small>{item.faultyBundleVersion} → {item.replacementBundleVersion}</small></span><StatusPill status={item.status} /><p>{item.affectedCount} affected · {item.jobs.succeeded} corrected · {item.jobs.failed} failed · {item.masteryRepairs?.unresolved ?? 0} projection alerts</p></button>)}
        </aside>
        <section aria-label="Correction impact and evidence" className={styles.appealDetail}>
          {!detail && <p className={styles.mutedText}>Select a correction to inspect its immutable impact manifest.</p>}
          {detail && <>
            <article className={styles.panel}>
              <div className={styles.panelHead}><div><FileCheck2 size={18} /><span><strong>{detail.correction.target.itemId}</strong><small>{detail.correction.target.courseId} · {detail.correction.target.contentVersion}</small></span></div><StatusPill status={detail.correction.status} /></div>
              <p>Faulty bundle <code>{detail.correction.target.faultyBundleVersion}</code> → reviewed bundle <code>{detail.correction.replacement.bundleVersion}</code></p>
              <p className={styles.hashGood}><ShieldCheck size={14} /> Faulty evidence <code>{detail.correction.target.faultyEvidenceHash}</code></p>
              <p className={styles.hashGood}><ShieldCheck size={14} /> Replacement evidence <code>{detail.correction.replacement.evidenceHash}</code></p>
              {detail.correction.status === "reviewed" && <div className={styles.appealDecisionForm}><label>Queue reason<textarea aria-label="Correction queue reason" minLength={20} maxLength={2000} value={queueReason} onChange={(event) => setQueueReason(event.target.value)} /></label><label>Current six-digit authenticator code<input aria-label="Queue correction authenticator code" autoComplete="one-time-code" inputMode="numeric" maxLength={6} type="password" value={totp} onChange={(event) => setTotp(event.target.value.replace(/\D/g, ""))} /></label><button className="button button-primary" disabled={busy} onClick={() => void queueCorrection()} type="button"><Play size={15} /> Queue all exact impacts</button></div>}
            </article>
            <article className={styles.panel}>
              <div className={styles.panelHead}><div><FileCheck2 size={18} /><span><strong>Affected attempts</strong><small>Only hashes, learner label, status, and corrected outcome are exposed here</small></span></div></div>
              <div className={styles.eventList}>{detail.impacts.map((impact) => <div className={styles.eventRow} key={impact.id}><FileCheck2 size={15} /><span><strong>{impact.learnerName} · {humanize(impact.jobStatus)}</strong><small>Form {impact.formId} · snapshot {impact.hashes.snapshot.slice(0, 16)}…{impact.correctedResult ? ` · ${(impact.correctedResult.outcome as string | undefined) ?? "corrected"}` : ""}</small></span><StatusPill status={impact.jobStatus} /></div>)}</div>
            </article>
            <article className={styles.panel}>
              <div className={styles.panelHead}><div><Wrench size={18} /><span><strong>Mastery projection repairs</strong><small>Exact course, version, module, concept, language, and enrollment mapping is required before concept mastery changes</small></span></div></div>
              {(detail.masteryRepairs ?? []).length === 0 ? <p className={styles.mutedText}>No mastery projection work has been created yet.</p> : <div className={styles.eventList}>{(detail.masteryRepairs ?? []).map((repair) => <div className={styles.eventRow} key={repair.id}><Wrench size={15} /><span><strong>{repair.skillId} · {humanize(repair.effect)}</strong><small>{repair.resolutionCode ? humanize(repair.resolutionCode) : repair.errorCode ? humanize(repair.errorCode) : "Awaiting projection"} · {repair.attemptCount} attempt{repair.attemptCount === 1 ? "" : "s"}</small></span><StatusPill status={repair.status} /></div>)}</div>}
            </article>
            <article className={styles.panel}>
              <div className={styles.panelHead}><div><ShieldCheck size={18} /><span><strong>Append-only timeline</strong><small>Original submissions, forms, results, and hidden tests are never rewritten</small></span></div></div>
              <ol className={styles.appealTimeline}>{detail.events.map((event) => <li key={event.id}><span><strong>{humanize(event.event)}</strong><small>{event.actorRole} · {formatDateTime(event.occurredAt)}</small></span><p>{event.reason}</p></li>)}</ol>
            </article>
          </>}
        </section>
      </div>
    </main>
  );
}
