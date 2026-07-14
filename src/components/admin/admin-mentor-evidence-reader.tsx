"use client";

import { Eye, ShieldAlert, ShieldCheck, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import type {
  MentorEvidenceCategory,
  MentorEvidencePurpose,
} from "@/lib/admin-mentor/contracts";

import { requestAdminJson } from "./admin-utils";
import styles from "./admin.module.css";

interface EvidenceResponse {
  readonly evidence: {
    readonly category: MentorEvidenceCategory;
    readonly items: readonly Record<string, unknown>[];
    readonly page: {
      readonly limit: number;
      readonly hasMore: boolean;
      readonly nextCursor: string | null;
    };
    readonly safeguards: {
      readonly responseBytes: number;
      readonly responseByteLimit: number;
      readonly perItemByteLimit: number;
      readonly truncatedItemCount: number;
      readonly hiddenAssessmentEvidenceIncluded: false;
      readonly credentialOrSessionEvidenceIncluded: false;
      readonly deviceOrIpEvidenceIncluded: false;
    };
  };
  readonly purpose: MentorEvidencePurpose;
  readonly autoClearSeconds: number;
}

interface RecoveryResolutionResponse {
  readonly resolution: {
    readonly runnerJobId: string;
    readonly status: "cancelled";
    readonly officialEvidenceChanged: false;
    readonly replayed: boolean;
  };
}

const CATEGORY_LABELS: Readonly<Record<MentorEvidenceCategory, string>> = {
  chats: "Tutor chats",
  code_submissions: "Code submissions",
  exams: "Exam answers, results, and integrity events",
  projects: "Project PRDs and review findings",
  ai_summaries: "AI-generated weekly summaries",
};

const PURPOSE_LABELS: Readonly<Record<MentorEvidencePurpose, string>> = {
  learning_support: "Learning support",
  progress_review: "Progress review",
  appeal_investigation: "Appeal investigation",
  curriculum_adjustment: "Curriculum adjustment",
  safety_review: "Safety review",
};

function publicEvidenceJson(value: Record<string, unknown>) {
  return JSON.stringify(value, null, 2);
}

const RECOVERY_ATTEMPT_PREFIX = "learncoding:practice-recovery-resolution:";

type RecoveryAttempt = Readonly<{
  requestId: string;
  runnerJobId: string;
  reason: string;
  isolatedRunnerRestarted: true;
  journalReconciled: true;
}>;

function loadRecoveryAttempt(runnerJobId: string): RecoveryAttempt | null {
  try {
    const raw = window.sessionStorage.getItem(`${RECOVERY_ATTEMPT_PREFIX}${runnerJobId}`);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<RecoveryAttempt>;
    if (
      value.runnerJobId !== runnerJobId
      || typeof value.requestId !== "string"
      || !/^[0-9a-f-]{36}$/i.test(value.requestId)
      || typeof value.reason !== "string"
      || value.reason.length < 20
      || value.isolatedRunnerRestarted !== true
      || value.journalReconciled !== true
    ) return null;
    return value as RecoveryAttempt;
  } catch {
    return null;
  }
}

function persistRecoveryAttempt(attempt: RecoveryAttempt) {
  window.sessionStorage.setItem(
    `${RECOVERY_ATTEMPT_PREFIX}${attempt.runnerJobId}`,
    JSON.stringify(attempt),
  );
}

export function AdminMentorEvidenceReader({ learnerId }: { readonly learnerId: string }) {
  const [category, setCategory] = useState<MentorEvidenceCategory>("chats");
  const [purpose, setPurpose] = useState<MentorEvidencePurpose>("learning_support");
  const [reason, setReason] = useState("");
  const [totp, setTotp] = useState("");
  const [result, setResult] = useState<EvidenceResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [selectedRecoveryJobId, setSelectedRecoveryJobId] = useState<string | null>(null);
  const [recoveryReason, setRecoveryReason] = useState("");
  const [recoveryTotp, setRecoveryTotp] = useState("");
  const [runnerRestarted, setRunnerRestarted] = useState(false);
  const [journalReconciled, setJournalReconciled] = useState(false);
  const [recoveryAttempt, setRecoveryAttempt] = useState<RecoveryAttempt | null>(null);

  const clearEvidence = useCallback((message?: string) => {
    setResult(null);
    setSelectedRecoveryJobId(null);
    setRecoveryAttempt(null);
    setRecoveryReason("");
    setRecoveryTotp("");
    setRunnerRestarted(false);
    setJournalReconciled(false);
    setNotice(message ?? null);
  }, []);

  useEffect(() => {
    if (!result) return;
    const timeout = window.setTimeout(
      () => clearEvidence("Sensitive learner evidence cleared automatically."),
      Math.min(300, Math.max(30, result.autoClearSeconds)) * 1_000,
    );
    return () => window.clearTimeout(timeout);
  }, [result, clearEvidence]);

  function changeScope(next: () => void) {
    next();
    clearEvidence();
    setError(null);
  }

  function selectQuarantinedPracticeRun(runnerJobId: string) {
    const saved = loadRecoveryAttempt(runnerJobId);
    setSelectedRecoveryJobId(runnerJobId);
    setRecoveryAttempt(saved);
    setRecoveryReason(saved?.reason ?? "");
    setRunnerRestarted(saved?.isolatedRunnerRestarted ?? false);
    setJournalReconciled(saved?.journalReconciled ?? false);
    setRecoveryTotp("");
    setError(null);
  }

  async function readEvidence(cursor?: string) {
    setError(null);
    setNotice(null);
    if (reason.trim().length < 20) {
      setError("Record a specific reason of at least 20 characters.");
      return;
    }
    if (!/^\d{6}$/.test(totp)) {
      setError("Enter the current six-digit authenticator code.");
      return;
    }
    setBusy(true);
    try {
      await requestAdminJson("/api/security/fresh-mfa", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: totp }),
      });
      const body = await requestAdminJson<EvidenceResponse>(
        `/api/admin/learners/${encodeURIComponent(learnerId)}/mentor-evidence`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            requestId: crypto.randomUUID(),
            category,
            purpose,
            reason: reason.trim(),
            limit: 5,
            ...(cursor ? { cursor } : {}),
          }),
        },
      );
      setResult((current) => cursor && current
        ? {
            ...body,
            evidence: {
              ...body.evidence,
              items: [...current.evidence.items, ...body.evidence.items],
            },
          }
        : body);
      setTotp("");
      setNotice("Read recorded in the audit log. Evidence will clear automatically in five minutes.");
    } catch (cause) {
      clearEvidence();
      setError(cause instanceof Error ? cause.message : "Mentor evidence could not be read safely.");
    } finally {
      setBusy(false);
    }
  }

  async function resolveQuarantinedPracticeRun() {
    setError(null);
    setNotice(null);
    if (!selectedRecoveryJobId) return;
    if (recoveryReason.trim().length < 20) {
      setError("Record a specific recovery reason of at least 20 characters.");
      return;
    }
    if (!/^\d{6}$/.test(recoveryTotp)) {
      setError("Enter the current six-digit authenticator code for this recovery action.");
      return;
    }
    if (!runnerRestarted || !journalReconciled) {
      setError("Confirm both isolated-runner restart and durable-journal reconciliation steps.");
      return;
    }
    const normalizedReason = recoveryReason.trim();
    if (recoveryAttempt && recoveryAttempt.reason !== normalizedReason) {
      setError("This recovery already crossed a request boundary. Retry the exact recorded reason or read fresh evidence after reconciliation.");
      return;
    }
    const attempt: RecoveryAttempt = recoveryAttempt ?? {
      requestId: crypto.randomUUID(),
      runnerJobId: selectedRecoveryJobId,
      reason: normalizedReason,
      isolatedRunnerRestarted: true,
      journalReconciled: true,
    };
    if (!recoveryAttempt) {
      try {
        persistRecoveryAttempt(attempt);
      } catch {
        setError("This browser could not retain the recovery request identity, so no privileged request was sent.");
        return;
      }
      setRecoveryAttempt(attempt);
    }
    setBusy(true);
    try {
      await requestAdminJson("/api/security/fresh-mfa", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: recoveryTotp }),
      });
      const resolved = await requestAdminJson<RecoveryResolutionResponse>(`/api/admin/runner-recovery/${encodeURIComponent(selectedRecoveryJobId)}/resolve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          requestId: attempt.requestId,
          reason: attempt.reason,
          isolatedRunnerRestarted: true,
          journalReconciled: true,
        }),
      });
      if (
        resolved.resolution?.runnerJobId !== selectedRecoveryJobId
        || resolved.resolution.status !== "cancelled"
        || resolved.resolution.officialEvidenceChanged !== false
        || typeof resolved.resolution.replayed !== "boolean"
      ) throw new Error("The recovery response identity or terminal status was invalid; retry the same recorded request.");
      setResult(null);
      setSelectedRecoveryJobId(null);
      setRecoveryReason("");
      setRecoveryTotp("");
      setRunnerRestarted(false);
      setJournalReconciled(false);
      setRecoveryAttempt(null);
      try {
        window.sessionStorage.removeItem(`${RECOVERY_ATTEMPT_PREFIX}${attempt.runnerJobId}`);
      } catch {
        // A stale same-ID record is safe: the server returns an idempotent replay.
      }
      setNotice("Quarantined practice run safely closed, audited, and reported to the learner. Read fresh code evidence to confirm.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The quarantined practice run could not be resolved safely.");
    } finally {
      setBusy(false);
    }
  }

  const displayedTruncatedItemCount = result?.evidence.items.filter(
    (item) => item.mentorPayloadTruncated === true,
  ).length ?? 0;
  const selectedRecoveryItem = result?.evidence.items.find(
    (item) => item.runnerJobId === selectedRecoveryJobId,
  );

  return (
    <article className={`${styles.panel} ${styles.spanTwo}`}>
      <div className={styles.panelHead}>
        <div><Eye size={18} /><span><strong>Audited mentor evidence reader</strong><small>Deliberate, bounded access only—every page requires fresh MFA, purpose, reason, and an audit event</small></span></div>
      </div>
      <p className={styles.safeNotice} role="alert"><ShieldAlert size={15} /> This area can display private learner-authored chats, code, answers, PRDs, and findings. Confirm nobody else can see your screen. Results are never cached and clear automatically after five minutes.</p>
      <div className={styles.appealDecisionForm}>
        <label>Evidence category<select aria-label="Mentor evidence category" value={category} onChange={(event) => changeScope(() => setCategory(event.target.value as MentorEvidenceCategory))}>{Object.entries(CATEGORY_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label>Mentoring purpose<select aria-label="Mentor evidence purpose" value={purpose} onChange={(event) => changeScope(() => setPurpose(event.target.value as MentorEvidencePurpose))}>{Object.entries(PURPOSE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label>Specific reason<textarea aria-label="Mentor evidence reason" maxLength={500} minLength={20} onChange={(event) => changeScope(() => setReason(event.target.value))} value={reason} /></label>
        <label>Current six-digit authenticator code<input aria-label="Mentor evidence authenticator code" autoComplete="one-time-code" inputMode="numeric" maxLength={6} onChange={(event) => setTotp(event.target.value.replace(/\D/g, ""))} type="password" value={totp} /></label>
        <div className={styles.headActions}>
          <button className="button button-primary" disabled={busy} onClick={() => void readEvidence()} type="button"><Eye size={15} /> {busy ? "Reading…" : "Read and audit evidence"}</button>
          <button className="button button-secondary" disabled={!result} onClick={() => clearEvidence("Sensitive learner evidence cleared.")} type="button"><Trash2 size={15} /> Clear now</button>
        </div>
      </div>
      {error && <p className={styles.inlineError} role="alert">{error}</p>}
      {notice && <p className={styles.inlineSuccess} role="status">{notice}</p>}
      {result && <section aria-label="Audited learner evidence results">
        <p className={styles.safeNotice}><ShieldAlert size={14} /> Hidden tests, blueprints, reference answers, provider credentials, passwords/tokens, IP/device data, and other learners are excluded by the server projection.</p>
        {displayedTruncatedItemCount > 0 && <p className={styles.safeNotice} role="status"><ShieldAlert size={14} /> {displayedTruncatedItemCount} evidence {displayedTruncatedItemCount === 1 ? "item was" : "items were"} safely shortened to the per-item display limit. {result.evidence.page.hasMore ? "Use the next audited page to continue reviewing remaining records." : "No following records were skipped by the item limit."}</p>}
        {result.evidence.page.hasMore && !result.evidence.page.nextCursor && <p className={styles.inlineError} role="alert">The server did not provide a safe continuation cursor. Clear this evidence and retry instead of skipping records.</p>}
        {result.evidence.items.length === 0
          ? <p className={styles.mutedText}>No stored evidence matched this bounded category page.</p>
          : <div className={styles.eventList}>{result.evidence.items.map((item, index) => {
              const runnerActive = ["queued", "leased", "running"].includes(String(item.runnerStatus));
              const submissionActive = ["queued", "leased", "running"].includes(String(item.submissionStatus));
              const activeQuarantine = result.evidence.category === "code_submissions"
                && ["server_compile", "server_run"].includes(String(item.submissionType))
                && item.recoveryState === "quarantined"
                && (runnerActive || submissionActive)
                && typeof item.runnerJobId === "string";
              const resolvedQuarantine = result.evidence.category === "code_submissions"
                && item.recoveryState === "quarantined"
                && !runnerActive
                && !submissionActive;
              return <div className={styles.eventRow} key={typeof item.id === "string" ? item.id : index}><Eye size={15} /><span><strong>{CATEGORY_LABELS[result.evidence.category]} · item {index + 1}</strong><pre aria-label={`${CATEGORY_LABELS[result.evidence.category]} evidence item ${index + 1}`} style={{ overflow: "auto", whiteSpace: "pre-wrap", wordBreak: "break-word", maxHeight: 360 }}>{publicEvidenceJson(item)}</pre>{activeQuarantine && <button className="button button-secondary" onClick={() => selectQuarantinedPracticeRun(item.runnerJobId as string)} type="button"><ShieldCheck size={14} /> Resolve quarantined practice run</button>}{resolvedQuarantine && <small>Quarantine is terminally resolved; no recovery action remains.</small>}</span></div>;
            })}</div>}
        {selectedRecoveryJobId && <div className={styles.appealDecisionForm} aria-label="Quarantined practice recovery resolution">
          <p className={styles.safeNotice}><ShieldAlert size={14} /> Before attesting, stop and restart the dedicated runner VM, then use the runner journal procedure to confirm there is no active copy for {typeof selectedRecoveryItem?.remoteRunnerJobId === "string" ? <>remote job <code>{selectedRecoveryItem.remoteRunnerJobId}</code></> : <>idempotency/request key <code>{String(selectedRecoveryItem?.runnerRequestId ?? "unavailable")}</code></>}. The trusted application host deliberately has no Docker socket and cannot perform these operator steps.</p>
          {recoveryAttempt && <p className={styles.safeNotice}>A prior network attempt exists. Its request ID and exact audited reason are locked so a lost response can be retried safely.</p>}
          <label>Recovery reason<textarea aria-label="Practice recovery resolution reason" disabled={Boolean(recoveryAttempt)} maxLength={500} minLength={20} value={recoveryReason} onChange={(event) => setRecoveryReason(event.target.value)} /></label>
          <label>Current six-digit authenticator code<input aria-label="Practice recovery authenticator code" autoComplete="one-time-code" inputMode="numeric" maxLength={6} type="password" value={recoveryTotp} onChange={(event) => setRecoveryTotp(event.target.value.replace(/\D/g, ""))} /></label>
          <label><input checked={runnerRestarted} disabled={Boolean(recoveryAttempt)} onChange={(event) => setRunnerRestarted(event.target.checked)} type="checkbox" /> I stopped and restarted the dedicated runner VM.</label>
          <label><input checked={journalReconciled} disabled={Boolean(recoveryAttempt)} onChange={(event) => setJournalReconciled(event.target.checked)} type="checkbox" /> I confirmed the durable journal has no active copy for the displayed remote job or idempotency key.</label>
          <div className={styles.headActions}><button className="button button-primary" disabled={busy} onClick={() => void resolveQuarantinedPracticeRun()} type="button">Resolve and audit</button><button className="button button-secondary" disabled={busy} onClick={() => setSelectedRecoveryJobId(null)} type="button">Cancel</button></div>
        </div>}
        {result.evidence.page.hasMore && result.evidence.page.nextCursor && <div className={styles.appealDecisionForm}><label>Authenticator code for next audited page<input aria-label="Mentor evidence next-page authenticator code" autoComplete="one-time-code" inputMode="numeric" maxLength={6} onChange={(event) => setTotp(event.target.value.replace(/\D/g, ""))} type="password" value={totp} /></label><button className="button button-secondary" disabled={busy} onClick={() => void readEvidence(result.evidence.page.nextCursor!)} type="button">Read next audited page</button></div>}
      </section>}
    </article>
  );
}
