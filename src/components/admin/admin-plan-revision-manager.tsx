"use client";

import { GitCompareArrows, History, ListRestart, Route } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { formatDateTime, humanize, requestAdminJson } from "./admin-utils";
import styles from "./admin.module.css";
import { EmptyState } from "./status-pill";

type RevisionSummary = {
  id: string;
  revision: number;
  parentId: string | null;
  source: string;
  reason: string;
  policyVersion: string;
  createdBy: string | null;
  itemCount: number;
  createdAt: string;
};

type EnrollmentHistory = {
  enrollmentId: string;
  status: string;
  implementationLanguage: string | null;
  courseSlug: string;
  courseTitle: string;
  courseVersion: string;
  latestRevision: number;
  revisions: RevisionSummary[];
};

type HistoryResponse = {
  policyVersion: string;
  enrollments: EnrollmentHistory[];
};

type PlanItem = {
  id: string;
  skillId: string;
  title: string;
  position: number;
  prerequisites: string[];
  adminRemediation?: Record<string, unknown>;
  adminOverride?: Record<string, unknown>;
};

type PlanPreview = {
  diff: {
    added: Array<{ id: string; title: string }>;
    removed: Array<{ id: string; title: string }>;
    moved: Array<{ id: string; title: string; fromPosition?: number; toPosition?: number }>;
    changed: Array<{ id: string; title: string }>;
  };
  impact: {
    canApply: boolean;
    prerequisiteViolations: Array<{
      itemId: string;
      itemTitle: string;
      prerequisiteSkillId: string;
      kind: string;
    }>;
    downstreamAffected: Array<{ skillId: string; title: string }>;
    overrideRequests: Array<{ itemId: string; mode: string; prerequisitesEnforced: true }>;
    evidencePreserved: true;
    masteryMutation: false;
    prerequisiteBypass: false;
  };
};

type DetailResponse = {
  enrollment: {
    id: string;
    courseTitle: string;
    courseVersion: string;
    implementationLanguage: string | null;
  };
  latestRevision: number;
  selected: RevisionSummary & { plan: PlanItem[] };
  comparisonToLatest: Omit<PlanPreview, "plan">;
  history: RevisionSummary[];
};

type OperationChoice =
  | "assign_remediation"
  | "move"
  | "remove"
  | "add"
  | "override_prioritize"
  | "override_defer"
  | "override_unlock_requested";

function immediateLocal() {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

export function AdminPlanRevisionManager({ learnerId }: { readonly learnerId: string }) {
  const [history, setHistory] = useState<HistoryResponse | null>(null);
  const [enrollmentId, setEnrollmentId] = useState("");
  const [detail, setDetail] = useState<DetailResponse | null>(null);
  const [operationType, setOperationType] = useState<OperationChoice>("assign_remediation");
  const [itemId, setItemId] = useState("");
  const [toPosition, setToPosition] = useState("1");
  const [sourceRevision, setSourceRevision] = useState("");
  const [sourceItems, setSourceItems] = useState<PlanItem[]>([]);
  const [note, setNote] = useState("");
  const [reason, setReason] = useState("");
  const [totp, setTotp] = useState("");
  const [effectiveAt, setEffectiveAt] = useState(immediateLocal);
  const [preview, setPreview] = useState<PlanPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [isError, setIsError] = useState(false);

  const historyUrl = `/api/admin/learners/${encodeURIComponent(learnerId)}/plans`;

  useEffect(() => {
    const controller = new AbortController();
    requestAdminJson<HistoryResponse>(historyUrl, { signal: controller.signal })
      .then((result) => {
        setHistory(result);
        setEnrollmentId((current) => current || result.enrollments[0]?.enrollmentId || "");
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setIsError(true);
        setMessage(errorMessage(error, "Learning-plan history could not be loaded."));
      });
    return () => controller.abort();
  }, [historyUrl]);

  useEffect(() => {
    if (!enrollmentId) return;
    const controller = new AbortController();
    requestAdminJson<DetailResponse>(`${historyUrl}/${encodeURIComponent(enrollmentId)}`, {
      signal: controller.signal,
    })
      .then((result) => {
        setDetail(result);
        setItemId(result.selected.plan[0]?.id ?? "");
        setPreview(null);
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setIsError(true);
        setMessage(errorMessage(error, "Learning-plan detail could not be loaded."));
      });
    return () => controller.abort();
  }, [enrollmentId, historyUrl]);

  const selectedEnrollment = useMemo(
    () => history?.enrollments.find((item) => item.enrollmentId === enrollmentId) ?? null,
    [enrollmentId, history],
  );
  const viewingLatest = detail?.selected.revision === detail?.latestRevision;

  async function loadHistoryAndLatest() {
    const result = await requestAdminJson<HistoryResponse>(historyUrl);
    setHistory(result);
    const selected = result.enrollments.find((item) => item.enrollmentId === enrollmentId)
      ?? result.enrollments[0];
    if (!selected) {
      setEnrollmentId("");
      setDetail(null);
      return;
    }
    setEnrollmentId(selected.enrollmentId);
    const latest = await requestAdminJson<DetailResponse>(
      `${historyUrl}/${encodeURIComponent(selected.enrollmentId)}`,
    );
    setDetail(latest);
    setItemId(latest.selected.plan[0]?.id ?? "");
  }

  async function viewRevision(revision?: number) {
    if (!enrollmentId) return;
    setBusy(true);
    setMessage(null);
    setIsError(false);
    try {
      const suffix = revision ? `?revision=${revision}` : "";
      const result = await requestAdminJson<DetailResponse>(
        `${historyUrl}/${encodeURIComponent(enrollmentId)}${suffix}`,
      );
      setDetail(result);
      setItemId(result.selected.plan[0]?.id ?? "");
      setPreview(null);
    } catch (error) {
      setIsError(true);
      setMessage(errorMessage(error, "The selected revision could not be loaded."));
    } finally {
      setBusy(false);
    }
  }

  async function chooseSourceRevision(value: string) {
    setSourceRevision(value);
    setSourceItems([]);
    setItemId("");
    setPreview(null);
    if (!value || !enrollmentId) return;
    try {
      const source = await requestAdminJson<DetailResponse>(
        `${historyUrl}/${encodeURIComponent(enrollmentId)}?revision=${Number(value)}`,
      );
      const currentIds = new Set(detail?.selected.plan.map((item) => item.id) ?? []);
      const available = source.selected.plan.filter((item) => !currentIds.has(item.id));
      setSourceItems(available);
      setItemId(available[0]?.id ?? "");
    } catch (error) {
      setIsError(true);
      setMessage(errorMessage(error, "The source revision could not be loaded."));
    }
  }

  function operation() {
    if (!itemId) throw new Error("Choose a plan item.");
    if (operationType === "add") {
      const revision = Number(sourceRevision);
      if (!Number.isInteger(revision) || revision < 1) throw new Error("Choose a source revision.");
      return { type: "add" as const, itemId, fromRevision: revision };
    }
    if (operationType === "move") {
      const position = Number(toPosition);
      if (!Number.isInteger(position) || position < 1) throw new Error("Choose a valid destination position.");
      return { type: "move" as const, itemId, toPosition: position };
    }
    if (operationType === "remove") return { type: "remove" as const, itemId };
    if (note.trim().length < 8) throw new Error("Record an operation note of at least eight characters.");
    if (operationType === "assign_remediation") {
      return { type: "assign_remediation" as const, itemId, note };
    }
    return {
      type: "set_override" as const,
      itemId,
      mode: operationType.replace("override_", "") as "prioritize" | "defer" | "unlock_requested",
      note,
    };
  }

  function mutationBody(previewOnly: boolean) {
    if (!detail || !viewingLatest) throw new Error("Return to the latest revision before editing.");
    if (reason.trim().length < 8) throw new Error("Record a specific reason of at least eight characters.");
    const date = new Date(effectiveAt);
    if (!Number.isFinite(date.getTime())) throw new Error("Choose a valid immediate effective time.");
    return {
      requestId: crypto.randomUUID(),
      expectedRevision: detail.latestRevision,
      reason,
      effectiveAt: date.toISOString(),
      previewOnly,
      operations: [operation()],
    };
  }

  async function previewChange() {
    setBusy(true);
    setMessage(null);
    setIsError(false);
    try {
      const body = mutationBody(true);
      const response = await requestAdminJson<{ preview: PlanPreview }>(
        `${historyUrl}/${encodeURIComponent(enrollmentId)}/revisions`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      setPreview(response.preview);
      setMessage(response.preview.impact.canApply
        ? "Preview ready. Review every downstream effect before saving."
        : "This change cannot be saved because prerequisite gates would be violated.");
      setIsError(!response.preview.impact.canApply);
    } catch (error) {
      setIsError(true);
      setMessage(errorMessage(error, "The plan preview could not be generated."));
    } finally {
      setBusy(false);
    }
  }

  async function verifyMfa() {
    if (!/^\d{6}$/.test(totp)) throw new Error("Enter the current six-digit authenticator code.");
    const response = await fetch("/api/security/fresh-mfa", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: totp }),
    });
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    if (!response.ok) throw new Error(body.error ?? "Fresh MFA verification failed.");
  }

  async function saveChange() {
    setBusy(true);
    setMessage(null);
    setIsError(false);
    try {
      if (!preview?.impact.canApply) throw new Error("Generate a valid impact preview before saving.");
      await verifyMfa();
      const body = mutationBody(false);
      await requestAdminJson(
        `${historyUrl}/${encodeURIComponent(enrollmentId)}/revisions`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      await loadHistoryAndLatest();
      setTotp("");
      setReason("");
      setNote("");
      setPreview(null);
      setMessage("A new append-only plan revision was saved, audited, and sent to the learner.");
    } catch (error) {
      setIsError(true);
      setMessage(errorMessage(error, "The plan revision could not be saved."));
    } finally {
      setBusy(false);
    }
  }

  async function revertTo(revision: number) {
    setBusy(true);
    setMessage(null);
    setIsError(false);
    try {
      if (!detail) throw new Error("Load the latest plan first.");
      if (reason.trim().length < 8) throw new Error("Record a specific revert reason of at least eight characters.");
      await verifyMfa();
      const date = new Date(effectiveAt);
      await requestAdminJson(
        `${historyUrl}/${encodeURIComponent(enrollmentId)}/revert`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            requestId: crypto.randomUUID(),
            expectedRevision: detail.latestRevision,
            targetRevision: revision,
            reason,
            effectiveAt: date.toISOString(),
          }),
        },
      );
      await loadHistoryAndLatest();
      setTotp("");
      setReason("");
      setPreview(null);
      setMessage(`Revision ${revision} was restored as a new append-only revision. The learner was notified.`);
    } catch (error) {
      setIsError(true);
      setMessage(errorMessage(error, "The plan could not be reverted."));
    } finally {
      setBusy(false);
    }
  }

  function resetPreview() {
    setPreview(null);
    setMessage(null);
  }

  return (
    <article className={`${styles.panel} ${styles.spanTwo}`}>
      <div className={styles.panelHead}>
        <div><Route size={18} /><span><strong>Versioned learning plan</strong><small>Append-only mentor edits with prerequisite impact review</small></span></div>
        <span className="pill">{selectedEnrollment ? `revision ${selectedEnrollment.latestRevision}` : "no plan"}</span>
      </div>

      {message && <p aria-live={isError ? "assertive" : "polite"} className={isError ? styles.inlineError : styles.inlineSuccess} role={isError ? "alert" : "status"}>{message}</p>}

      {!history ? <p className={styles.mutedText}>Loading plan history…</p> : history.enrollments.length === 0 ? (
        <EmptyState title="No persisted plans" detail="A versioned plan appears after enrollment and placement planning." />
      ) : (
        <>
          <label className={styles.compactField}>
            Enrollment
            <select disabled={busy} onChange={(event) => setEnrollmentId(event.target.value)} value={enrollmentId}>
              {history.enrollments.map((item) => <option key={item.enrollmentId} value={item.enrollmentId}>{item.courseTitle} v{item.courseVersion} · {humanize(item.status)}</option>)}
            </select>
          </label>

          {detail && (
            <div className={styles.planWorkspace}>
              <section aria-labelledby="plan-items-heading" className={styles.planItems}>
                <div className={styles.panelHead}>
                  <div><GitCompareArrows size={16} /><span><strong id="plan-items-heading">Revision {detail.selected.revision} items</strong><small>{detail.selected.itemCount} items · {humanize(detail.selected.source)}</small></span></div>
                  {!viewingLatest && <button className="button button-secondary" disabled={busy} onClick={() => void viewRevision()} type="button">Return to latest</button>}
                </div>
                <ol>
                  {detail.selected.plan.map((item) => (
                    <li key={item.id}>
                      <span><strong>{item.title}</strong><small>{item.skillId} · {item.prerequisites.length ? `${item.prerequisites.length} prerequisite(s)` : "no prerequisites"}</small></span>
                      <span>{item.adminRemediation ? "remediation" : item.adminOverride ? "admin directive" : "standard"}</span>
                    </li>
                  ))}
                </ol>
              </section>

              <section aria-labelledby="plan-history-heading" className={styles.planHistory}>
                <h3 id="plan-history-heading"><History size={15} /> Revision history</h3>
                {detail.history.map((revision) => (
                  <div className={styles.planHistoryRow} key={revision.id}>
                    <span><strong>Revision {revision.revision}</strong><small>{formatDateTime(revision.createdAt)} · {humanize(revision.source)} · {revision.reason}</small></span>
                    <span>
                      <button disabled={busy} onClick={() => void viewRevision(revision.revision)} type="button">View</button>
                      {revision.revision !== detail.latestRevision && <button disabled={busy} onClick={() => void viewRevision(revision.revision)} type="button">Review &amp; revert</button>}
                    </span>
                  </div>
                ))}
              </section>
            </div>
          )}

          {detail && viewingLatest && (
            <div className={styles.planEditor}>
              <div className={styles.panelHead}><div><ListRestart size={16} /><span><strong>Propose one safe operation</strong><small>Preview is mandatory; changes never set mastery or disable prerequisite gates</small></span></div></div>
              <div className={styles.approveForm}>
                <label>
                  Operation
                  <select onChange={(event) => { setOperationType(event.target.value as OperationChoice); setItemId(""); resetPreview(); }} value={operationType}>
                    <option value="assign_remediation">Assign remediation</option>
                    <option value="move">Reorder item</option>
                    <option value="remove">Remove item</option>
                    <option value="add">Restore item from history</option>
                    <option value="override_prioritize">Prioritize directive</option>
                    <option value="override_defer">Defer directive</option>
                    <option value="override_unlock_requested">Record unlock request (gates enforced)</option>
                  </select>
                </label>
                {operationType === "add" && <label>Source revision<select onChange={(event) => void chooseSourceRevision(event.target.value)} value={sourceRevision}><option value="">Choose a revision</option>{detail.history.filter((revision) => revision.revision !== detail.latestRevision).map((revision) => <option key={revision.id} value={revision.revision}>Revision {revision.revision}</option>)}</select></label>}
                <label>
                  Plan item
                  <select onChange={(event) => { setItemId(event.target.value); resetPreview(); }} value={itemId}>
                    <option value="">Choose an item</option>
                    {(operationType === "add" ? sourceItems : detail.selected.plan).map((item) => <option key={item.id} value={item.id}>{item.position + 1}. {item.title}</option>)}
                  </select>
                </label>
                {operationType === "move" && <label>New position<input min={1} max={detail.selected.plan.length} onChange={(event) => { setToPosition(event.target.value); resetPreview(); }} type="number" value={toPosition} /></label>}
                {(operationType === "assign_remediation" || operationType.startsWith("override_")) && <label>Operation note<textarea maxLength={500} minLength={8} onChange={(event) => { setNote(event.target.value); resetPreview(); }} value={note} /></label>}
                <label>Effective immediately at<input max={immediateLocal()} onChange={(event) => { setEffectiveAt(event.target.value); resetPreview(); }} type="datetime-local" value={effectiveAt} /></label>
                <label>Recorded reason<textarea maxLength={500} minLength={8} onChange={(event) => { setReason(event.target.value); resetPreview(); }} value={reason} /></label>
                <label>Current six-digit authenticator code<input autoComplete="one-time-code" inputMode="numeric" maxLength={6} onChange={(event) => setTotp(event.target.value.replace(/\D/g, ""))} pattern="[0-9]{6}" type="password" value={totp} /></label>
                <div className={styles.planActions}>
                  <button className="button button-secondary" disabled={busy} onClick={() => void previewChange()} type="button">Preview diff and impact</button>
                  <button className="button button-primary" disabled={busy || preview?.impact.canApply !== true} onClick={() => void saveChange()} type="button">Save new revision</button>
                </div>
              </div>

              {preview && (
                <section aria-labelledby="plan-impact-heading" className={styles.planImpact}>
                  <h3 id="plan-impact-heading">Prerequisite and downstream impact</h3>
                  <div><span>Added <strong>{preview.diff.added.length}</strong></span><span>Removed <strong>{preview.diff.removed.length}</strong></span><span>Moved <strong>{preview.diff.moved.length}</strong></span><span>Directives <strong>{preview.diff.changed.length}</strong></span></div>
                  {preview.impact.prerequisiteViolations.length > 0 && <ul>{preview.impact.prerequisiteViolations.map((item) => <li key={`${item.itemId}:${item.prerequisiteSkillId}`}>{item.itemTitle}: {humanize(item.kind)} prerequisite {item.prerequisiteSkillId}</li>)}</ul>}
                  {preview.impact.downstreamAffected.length > 0 && <p>Downstream affected: {preview.impact.downstreamAffected.map((item) => item.title).join(", ")}.</p>}
                  <p><strong>Invariant:</strong> evidence is preserved, mastery is unchanged, and prerequisite bypass remains disabled.</p>
                </section>
              )}
              <p className={styles.safeNotice}>Future scheduled activation is intentionally unavailable until a persisted activation pointer exists. Every save/revert requires fresh MFA, a reason, an audit event, and learner notification.</p>
            </div>
          )}
          {detail && !viewingLatest && (
            <section aria-labelledby="revert-impact-heading" className={styles.planEditor}>
              <div className={styles.planImpact}>
                <h3 id="revert-impact-heading">Revert diff and downstream impact</h3>
                <div>
                  <span>Added <strong>{detail.comparisonToLatest.diff.added.length}</strong></span>
                  <span>Removed <strong>{detail.comparisonToLatest.diff.removed.length}</strong></span>
                  <span>Moved <strong>{detail.comparisonToLatest.diff.moved.length}</strong></span>
                  <span>Directives <strong>{detail.comparisonToLatest.diff.changed.length}</strong></span>
                </div>
                {detail.comparisonToLatest.impact.prerequisiteViolations.length > 0 && <ul>{detail.comparisonToLatest.impact.prerequisiteViolations.map((item) => <li key={`${item.itemId}:${item.prerequisiteSkillId}`}>{item.itemTitle}: {humanize(item.kind)} prerequisite {item.prerequisiteSkillId}</li>)}</ul>}
                {detail.comparisonToLatest.impact.downstreamAffected.length > 0 && <p>Downstream affected: {detail.comparisonToLatest.impact.downstreamAffected.map((item) => item.title).join(", ")}.</p>}
                <p><strong>Invariant:</strong> the historical snapshot is copied into a new revision; evidence and mastery remain unchanged, and prerequisite bypass remains disabled.</p>
              </div>
              <div className={styles.approveForm}>
                <label>Effective immediately at<input max={immediateLocal()} onChange={(event) => setEffectiveAt(event.target.value)} type="datetime-local" value={effectiveAt} /></label>
                <label>Recorded reason<textarea maxLength={500} minLength={8} onChange={(event) => setReason(event.target.value)} value={reason} /></label>
                <label>Current six-digit authenticator code<input autoComplete="one-time-code" inputMode="numeric" maxLength={6} onChange={(event) => setTotp(event.target.value.replace(/\D/g, ""))} pattern="[0-9]{6}" type="password" value={totp} /></label>
                <button className="button button-primary" disabled={busy || !detail.comparisonToLatest.impact.canApply} onClick={() => void revertTo(detail.selected.revision)} type="button">Revert revision {detail.selected.revision} as new</button>
              </div>
            </section>
          )}
        </>
      )}
    </article>
  );
}
