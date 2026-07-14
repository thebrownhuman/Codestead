"use client";

import {
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  Code2,
  FileSearch,
  RefreshCw,
  Scale,
  ShieldCheck,
  Wrench,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";

import type { ExamResult, PublicExamForm } from "@/lib/exams/contracts";

import { formatDateTime, humanize, requestAdminJson } from "./admin-utils";
import styles from "./admin.module.css";
import { StatusPill } from "./status-pill";

type AppealDecision = "needs_learner_input" | "upheld" | "overturned";

interface AppealSummary {
  readonly id: string;
  readonly learnerName: string;
  readonly learnerPublicId: string;
  readonly category: string;
  readonly reason: string;
  readonly status: string;
  readonly decision: string | null;
  readonly target: "exam_attempt" | "project_review";
  readonly rowVersion: number;
  readonly createdAt: string;
}

interface AppealDetail {
  readonly appeal: AppealSummary & {
    readonly userId: string;
    readonly learnerEmail: string;
    readonly decisionReason: string | null;
    readonly evidenceHash: string;
    readonly evidenceHashValid: boolean;
    readonly evidence: Record<string, unknown>;
    readonly updatedAt: string;
    readonly decidedAt: string | null;
  };
  readonly target: {
    readonly attemptId: string | null;
    readonly attemptKind: string | null;
    readonly attemptStatus: string | null;
    readonly score: number | null;
    readonly passed: boolean | null;
    readonly policyVersion: string | null;
    readonly contentVersion: string | null;
    readonly examSessionId: string | null;
    readonly examStatus: string | null;
    readonly integrityReviewState: string | null;
    readonly projectReviewId: string | null;
    readonly projectId: string | null;
    readonly projectTitle: string | null;
    readonly reviewCommitSha: string | null;
    readonly reviewAnalyzerVersion: string | null;
    readonly reviewRubricVersion: string | null;
    readonly reviewProvenance: Record<string, unknown> | null;
    readonly reviewFindingsHash: string | null;
    readonly reviewStatus: string | null;
  };
  readonly projectCorrection: {
    readonly id: string;
    readonly status: string | null;
    readonly revision: number;
    readonly reason: string | null;
    readonly sourceFindingsHash: string | null;
    readonly resultFindingsHash: string | null;
    readonly evidence: Record<string, unknown> | null;
    readonly evidenceHash: string | null;
    readonly evidenceHashValid: boolean;
    readonly projectionApplied: boolean | null;
    readonly attemptCount: number;
    readonly lastErrorCode: string | null;
    readonly completedAt: string | null;
    readonly timeline: readonly {
      readonly id: string;
      readonly actorRole: string;
      readonly event: string;
      readonly reason: string;
      readonly evidence: Record<string, unknown>;
      readonly evidenceHash: string;
      readonly evidenceHashValid: boolean;
      readonly occurredAt: string;
    }[];
  } | null;
  readonly publicForm: PublicExamForm | null;
  readonly originalResult: ExamResult | null;
  readonly answers: readonly {
    readonly itemId: string;
    readonly revision: number;
    readonly answer: Record<string, unknown>;
    readonly source: string;
    readonly savedAt: string;
  }[];
  readonly codeSubmissions: readonly {
    readonly id: string;
    readonly language: string;
    readonly sourceCode: string;
    readonly sourceTruncated: boolean;
    readonly sourceHash: string;
    readonly runtimeImageDigest: string;
    readonly status: string;
    readonly createdAt: string;
  }[];
  readonly integrityEvents: readonly {
    readonly id: string;
    readonly type: string;
    readonly metadata: Record<string, unknown>;
    readonly occurredAt: string;
  }[];
  readonly timeline: readonly {
    readonly id: string;
    readonly actorRole: string;
    readonly event: string;
    readonly reason: string;
    readonly evidence: Record<string, unknown>;
    readonly occurredAt: string;
  }[];
}

function readableJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export function AdminAppealQueue({
  initialAppealId,
}: {
  readonly initialAppealId: string | null;
}) {
  const [scope, setScope] = useState<"actionable" | "all">("actionable");
  const [appeals, setAppeals] = useState<readonly AppealSummary[] | null>(null);
  const [selectedId, setSelectedId] = useState(initialAppealId);
  const [detail, setDetail] = useState<AppealDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [decision, setDecision] = useState<AppealDecision>("upheld");
  const [reason, setReason] = useState("");
  const [correctiveAction, setCorrectiveAction] = useState("");
  const [totp, setTotp] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [messageIsError, setMessageIsError] = useState(false);
  const requestRef = useRef<{ fingerprint: string; id: string } | null>(null);

  const loadAppeals = useCallback(async (signal?: AbortSignal) => {
    setError(null);
    try {
      const body = await requestAdminJson<{ appeals: readonly AppealSummary[] }>(
        `/api/admin/appeals?scope=${scope}`,
        { signal },
      );
      setAppeals(body.appeals);
      setSelectedId((current) => current ?? body.appeals[0]?.id ?? null);
    } catch (loadError) {
      if (signal?.aborted) return;
      setError(loadError instanceof Error ? loadError.message : "The appeal queue could not be loaded.");
    }
  }, [scope]);

  useEffect(() => {
    const controller = new AbortController();
    void requestAdminJson<{ appeals: readonly AppealSummary[] }>(
      `/api/admin/appeals?scope=${scope}`,
      { signal: controller.signal },
    ).then((body) => {
      setAppeals(body.appeals);
      setSelectedId((current) => current ?? body.appeals[0]?.id ?? null);
    }).catch((loadError: unknown) => {
      if (!controller.signal.aborted) setError(loadError instanceof Error ? loadError.message : "The appeal queue could not be loaded.");
    });
    return () => controller.abort();
  }, [scope]);

  useEffect(() => {
    if (!selectedId) return;
    const controller = new AbortController();
    void requestAdminJson<{ detail: AppealDetail }>(
      `/api/admin/appeals/${encodeURIComponent(selectedId)}`,
      { signal: controller.signal },
    ).then((body) => {
      setDetail(body.detail);
      setReason("");
      setCorrectiveAction("");
      setMessage(null);
      requestRef.current = null;
    }).catch((loadError: unknown) => {
      if (!controller.signal.aborted) setError(loadError instanceof Error ? loadError.message : "Appeal evidence could not be loaded.");
    });
    return () => controller.abort();
  }, [selectedId]);

  function changeDecision(next: AppealDecision) {
    setDecision(next);
    requestRef.current = null;
  }

  async function decide() {
    if (!detail) return;
    setMessage(null);
    setMessageIsError(false);
    if (!/^\d{6}$/.test(totp)) {
      setMessageIsError(true);
      setMessage("Enter the current six-digit authenticator code.");
      return;
    }
    if (reason.trim().length < 20) {
      setMessageIsError(true);
      setMessage("Record a specific decision reason of at least 20 characters.");
      return;
    }
    if (decision === "overturned" && correctiveAction.trim().length < 20) {
      setMessageIsError(true);
      setMessage("Record the corrective action before overturning the result.");
      return;
    }
    const fingerprint = JSON.stringify({
      appealId: detail.appeal.id,
      rowVersion: detail.appeal.rowVersion,
      decision,
      reason: reason.trim(),
      correctiveAction: correctiveAction.trim(),
    });
    if (requestRef.current?.fingerprint !== fingerprint) {
      requestRef.current = { fingerprint, id: crypto.randomUUID() };
    }
    setSubmitting(true);
    try {
      await requestAdminJson("/api/security/fresh-mfa", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: totp }),
      });
      const body = await requestAdminJson<{
        report: {
          decision: AppealDecision;
          replayed: boolean;
          correctionPending: boolean;
          projectReviewCorrectionId?: string | null;
          projectReviewCorrectionStatus?: string | null;
        };
        projectReanalysis?: { processed: boolean; succeeded?: boolean; errorCode?: string } | null;
        completionAuditRecorded: boolean;
        warning?: string;
      }>(`/api/admin/appeals/${encodeURIComponent(detail.appeal.id)}/decision`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          requestId: requestRef.current.id,
          expectedVersion: detail.appeal.rowVersion,
          decision,
          reason: reason.trim(),
          ...(decision === "overturned" ? { correctiveAction: correctiveAction.trim() } : {}),
        }),
      });
      setMessageIsError(body.completionAuditRecorded === false);
      setMessage(
        `${humanize(body.report.decision)} recorded${body.report.replayed ? " (safe replay)" : ""}. The learner was notified.${body.report.projectReviewCorrectionId && body.projectReanalysis?.succeeded ? " Deterministic static re-analysis completed; the immutable correction and effective projection were recorded." : body.report.correctionPending ? " Corrective review remains pending; the original result was not silently changed." : ""}${body.warning ? ` ${body.warning}` : ""}`,
      );
      setTotp("");
      requestRef.current = null;
      const refreshed = await requestAdminJson<{ detail: AppealDetail }>(
        `/api/admin/appeals/${encodeURIComponent(detail.appeal.id)}`,
      );
      setDetail(refreshed.detail);
      await loadAppeals();
    } catch (submitError) {
      setMessageIsError(true);
      setMessage(submitError instanceof Error ? submitError.message : "The appeal decision failed safely.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className={styles.adminPage}>
      <header className={styles.pageHead}>
        <div>
          <span className={styles.eyebrow}>Human adjudication</span>
          <h1>Evidence <span>appeals</span></h1>
          <p>Review the learner&apos;s immutable assessment or project-review evidence before recording a versioned human decision.</p>
        </div>
        <div className={styles.headActions}>
          <label className={styles.compactField}>Queue
            <select aria-label="Appeal queue scope" onChange={(event) => setScope(event.target.value as typeof scope)} value={scope}>
              <option value="actionable">Needs action</option>
              <option value="all">All appeals</option>
            </select>
          </label>
          <button aria-label="Refresh appeals" className="button button-secondary" onClick={() => void loadAppeals()} type="button"><RefreshCw size={14} /> Refresh</button>
        </div>
      </header>

      {error && <p className={styles.inlineError} role="alert">{error}</p>}
      <div className={styles.appealWorkspace}>
        <aside aria-label="Appeal queue" className={styles.appealQueue}>
          <div className={styles.panelHead}><div><Scale size={18} /><span><strong>Review queue</strong><small>{appeals?.length ?? 0} visible</small></span></div></div>
          {appeals === null ? <p className={styles.mutedText}>Loading appeals…</p> : appeals.length === 0 ? <p className={styles.mutedText}>No appeals match this queue.</p> : appeals.map((item) => (
            <button
              aria-current={selectedId === item.id ? "true" : undefined}
              className={`${styles.appealQueueItem} ${selectedId === item.id ? styles.appealQueueItemActive : ""}`}
              key={item.id}
              onClick={() => setSelectedId(item.id)}
              type="button"
            >
              <span><strong>{item.learnerName}</strong><small>{humanize(item.category)} · {formatDateTime(item.createdAt)}</small></span>
              <StatusPill status={item.status} />
              <p>{item.reason}</p>
              <ChevronRight aria-hidden="true" size={15} />
            </button>
          ))}
        </aside>

        <section aria-busy={Boolean(selectedId && detail?.appeal.id !== selectedId)} aria-label="Appeal evidence and decision" className={styles.appealDetail}>
          {selectedId && detail?.appeal.id !== selectedId && <div className={styles.loadingState}><span /><div><strong>Loading audited evidence</strong><small>This read is recorded.</small></div></div>}
          {!selectedId && !detail && <div className={styles.emptyState}><FileSearch size={22} /><strong>Select an appeal</strong><p>Choose a learner claim from the review queue.</p></div>}
          {detail?.appeal.id === selectedId && (
            <>
              <article className={styles.panel}>
                <div className={styles.panelHead}><div><AlertTriangle size={18} /><span><strong>{detail.appeal.learnerName}</strong><small>{detail.appeal.learnerEmail} · version {detail.appeal.rowVersion}</small></span></div><StatusPill status={detail.appeal.status} /></div>
                <blockquote className={styles.appealClaim}>{detail.appeal.reason}</blockquote>
                <div className={styles.appealFacts}>
                  <span><small>Category</small><strong>{humanize(detail.appeal.category)}</strong></span>
                  {detail.target.projectReviewId ? <>
                    <span><small>Project</small><strong>{detail.target.projectTitle ?? "Stored project"}</strong></span>
                    <span><small>Commit</small><strong>{detail.target.reviewCommitSha?.slice(0, 12) ?? "Unknown"}</strong></span>
                    <span><small>Review state</small><strong>{humanize(detail.target.reviewStatus ?? "unknown")}</strong></span>
                  </> : <>
                    <span><small>Attempt</small><strong>{detail.target.attemptKind ? humanize(detail.target.attemptKind) : "Not linked"}</strong></span>
                    <span><small>Original score</small><strong>{detail.target.score ?? "Pending"}</strong></span>
                    <span><small>Exam state</small><strong>{humanize(detail.target.examStatus ?? detail.target.attemptStatus ?? "unknown")}</strong></span>
                  </>}
                </div>
                <p className={detail.appeal.evidenceHashValid ? styles.hashGood : styles.hashBad}>
                  {detail.appeal.evidenceHashValid ? <ShieldCheck size={14} /> : <AlertTriangle size={14} />}
                  Evidence hash {detail.appeal.evidenceHashValid ? "verified" : "does not match"}: <code>{detail.appeal.evidenceHash}</code>
                </p>
                {detail.appeal.decisionReason && <p className={styles.safeNotice}><Scale size={14} /> Previous recorded reason: {detail.appeal.decisionReason}</p>}
                {detail.appeal.decision === "overturned" && detail.target.attemptId && <p className={styles.safeNotice}><Wrench size={14} /> A faulty deterministic test/form must be repaired through the append-only workflow. <Link href={`/admin/assessment-corrections?appeal=${encodeURIComponent(detail.appeal.id)}`}>Create or review correction</Link></p>}
              </article>

              {detail.target.projectReviewId && <article className={styles.panel}>
                <div className={styles.panelHead}><div><FileSearch size={18} /><span><strong>Original project-review evidence</strong><small>Commit, analyzer {detail.target.reviewAnalyzerVersion ?? "unknown"}, rubric {detail.target.reviewRubricVersion ?? "unknown"}; the original remains immutable</small></span></div></div>
                <details className={styles.evidenceDisclosure} open><summary>Stored findings and immutable provenance</summary><pre>{readableJson(detail.appeal.evidence)}</pre></details>
              </article>}

              {detail.projectCorrection && <article className={styles.panel}>
                <div className={styles.panelHead}><div><Wrench size={18} /><span><strong>Corrective static re-analysis</strong><small>Version {detail.projectCorrection.revision} · no AI or repository execution</small></span></div><StatusPill status={detail.projectCorrection.status ?? "unknown"} /></div>
                <p className={detail.projectCorrection.evidenceHash === null || detail.projectCorrection.evidenceHashValid ? styles.hashGood : styles.hashBad}><ShieldCheck size={14} /> Evidence {detail.projectCorrection.evidenceHash === null ? "pending" : detail.projectCorrection.evidenceHashValid ? "hash verified" : "hash invalid"}; effective projection {detail.projectCorrection.projectionApplied === null ? "pending" : detail.projectCorrection.projectionApplied ? "updated" : "left on a newer review"}.</p>
                {detail.projectCorrection.lastErrorCode && <p className={styles.inlineError}>Failed safely: {humanize(detail.projectCorrection.lastErrorCode)}. The original and effective review were not changed.</p>}
                <details className={styles.evidenceDisclosure}><summary>Correction evidence and append-only timeline</summary><pre>{readableJson({ evidence: detail.projectCorrection.evidence, timeline: detail.projectCorrection.timeline })}</pre></details>
                <Link className="button button-secondary" href={`/admin/project-review-corrections?correction=${encodeURIComponent(detail.projectCorrection.id)}`}>Open correction operations</Link>
              </article>}

              {!detail.target.projectReviewId && <article className={styles.panel}>
                <div className={styles.panelHead}><div><FileSearch size={18} /><span><strong>Original assessment evidence</strong><small>Public question form only; hidden grading evidence is withheld</small></span></div></div>
                {detail.publicForm?.items.map((item) => (
                  <details className={styles.evidenceDisclosure} key={item.id}>
                    <summary>{item.title || item.id}</summary>
                    <p>{item.prompt}</p>
                    {detail.answers.filter((answer) => answer.itemId === item.id).map((answer) => <pre key={`${answer.itemId}-${answer.revision}`}>{readableJson(answer.answer)}</pre>)}
                  </details>
                )) ?? <p className={styles.mutedText}>No assessment form was attached.</p>}
                {detail.originalResult && <details className={styles.evidenceDisclosure}><summary>Original deterministic result</summary><pre>{readableJson(detail.originalResult)}</pre></details>}
              </article>}

              {detail.codeSubmissions.length > 0 && <article className={styles.panel}>
                <div className={styles.panelHead}><div><Code2 size={18} /><span><strong>Submitted source</strong><small>Runtime image digests bind the execution environment</small></span></div></div>
                {detail.codeSubmissions.map((submission) => <details className={styles.evidenceDisclosure} key={submission.id}><summary>{submission.language} · {humanize(submission.status)}</summary><small>Source hash {submission.sourceHash} · runtime {submission.runtimeImageDigest}{submission.sourceTruncated ? " · display truncated" : ""}</small><pre>{submission.sourceCode}</pre></details>)}
              </article>}

              <article className={styles.panel}>
                <div className={styles.panelHead}><div><Scale size={18} /><span><strong>Append-only appeal timeline</strong><small>Submissions and decisions cannot be overwritten</small></span></div></div>
                <ol className={styles.appealTimeline}>{detail.timeline.map((entry) => <li key={entry.id}><span><strong>{humanize(entry.event)}</strong><small>{entry.actorRole} · {formatDateTime(entry.occurredAt)}</small></span><p>{entry.reason}</p></li>)}</ol>
              </article>

              {(["open", "under_review", "needs_learner_input"] as const).includes(detail.appeal.status as "open") && <article className={styles.panel}>
                <div className={styles.panelHead}><div><ShieldCheck size={18} /><span><strong>Record human decision</strong><small>Fresh MFA, rationale, target binding, version check, audit and learner notice are required</small></span></div></div>
                {message && <p className={messageIsError ? styles.inlineError : styles.inlineSuccess} role={messageIsError ? "alert" : "status"}>{message}</p>}
                <div className={styles.appealDecisionForm}>
                  <fieldset><legend>Decision</legend>{(["upheld", "needs_learner_input", "overturned"] as const).map((value) => <label key={value}><input checked={decision === value} name="appeal-decision" onChange={() => changeDecision(value)} type="radio" /> {humanize(value)}</label>)}</fieldset>
                  <label>Recorded decision reason<textarea maxLength={2000} minLength={20} onChange={(event) => { setReason(event.target.value); requestRef.current = null; }} value={reason} /></label>
                  {decision === "overturned" && <label>Required corrective action<textarea maxLength={2000} minLength={20} onChange={(event) => { setCorrectiveAction(event.target.value); requestRef.current = null; }} value={correctiveAction} /><small>The original result stays preserved. This instruction creates a pending corrective review.</small></label>}
                  <label>Current six-digit authenticator code<input autoComplete="one-time-code" inputMode="numeric" maxLength={6} onChange={(event) => setTotp(event.target.value.replace(/\D/g, ""))} type="password" value={totp} /></label>
                  <button className="button button-primary" disabled={submitting || !detail.appeal.evidenceHashValid} onClick={() => void decide()} type="button"><CheckCircle2 size={15} /> {submitting ? "Recording…" : "Record decision and notify learner"}</button>
                  {!detail.appeal.evidenceHashValid && <p className={styles.inlineError} role="alert">Decision disabled because the immutable evidence hash failed verification.</p>}
                </div>
              </article>}
              {message && !(["open", "under_review", "needs_learner_input"] as const).includes(detail.appeal.status as "open") && <p className={messageIsError ? styles.inlineError : styles.inlineSuccess} role={messageIsError ? "alert" : "status"}>{message}</p>}
            </>
          )}
        </section>
      </div>
    </main>
  );
}
