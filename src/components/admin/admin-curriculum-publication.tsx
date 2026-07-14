"use client";

import { AlertTriangle, BookOpenCheck, CheckCircle2, FileSearch, RefreshCw, ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { REVIEW_DIMENSIONS, type CurriculumReviewChecklist } from "@/lib/curriculum-publication/contracts";

import { humanize, requestAdminJson } from "./admin-utils";
import styles from "./admin.module.css";
import { StatusPill } from "./status-pill";

type Candidate = {
  id: string; courseId: string; courseSlug: string; title: string; version: string; stage: string;
  publicationRevision: number; contentHash: string; artifactCount: number; aiAssistedCount: number;
  approvedCount: number; unreviewedCount: number; evidenceVersion: number | null;
  pointerVersion: number | null; isCurrent: boolean;
};
type Artifact = {
  id: string; artifactKey: string; artifactType: string; sourcePath: string; publicationStage: string;
  aiAssisted: boolean; reviewStatus: string; rowVersion: number;
};
type ReviewQueueItem = Artifact & {
  courseVersionId: string; courseSlug: string; courseTitle: string; courseVersion: string; courseStage: string;
};
type ReviewQueue = {
  total: number; courseCount: number;
  statusCounts: Array<{ status: string; count: number }>;
  courseCounts: Array<{ courseVersionId: string; courseSlug: string; courseTitle: string; courseVersion: string; count: number }>;
  items: ReviewQueueItem[];
};
type Detail = {
  artifact: Artifact & {
    courseVersionId: string; content: Record<string, unknown>; contentHash: string;
    contentHashValid: boolean; expectedReviewItemIds: string[]; embeddedHumanApproval: boolean;
  };
  timeline: Array<{ id: string; reviewerName: string; decision: string; reason: string }>;
};
type Gate = { allowed: boolean; issues: Array<{ code: string; artifactKey?: string; message: string }>; reportHash: string };

const emptyPart = { passed: false, evidenceRef: "", note: "" };
const emptyReviewQueue: ReviewQueue = { total: 0, courseCount: 0, statusCounts: [], courseCounts: [], items: [] };
const REVIEW_QUEUE_PAGE_SIZE = 25;
function emptyChecklist(): CurriculumReviewChecklist {
  return Object.fromEntries(REVIEW_DIMENSIONS.map((name) => [name, { ...emptyPart }])) as unknown as CurriculumReviewChecklist;
}

export function AdminCurriculumPublication() {
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [reviewQueue, setReviewQueue] = useState<ReviewQueue>(emptyReviewQueue);
  const [queueCourse, setQueueCourse] = useState("");
  const [queueStatus, setQueueStatus] = useState("");
  const [queueSearch, setQueueSearch] = useState("");
  const [queuePage, setQueuePage] = useState(1);
  const [versionId, setVersionId] = useState<string | null>(null);
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [artifactId, setArtifactId] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [artifactsLoading, setArtifactsLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [checklist, setChecklist] = useState<CurriculumReviewChecklist>(emptyChecklist);
  const [reviewedItems, setReviewedItems] = useState<string[]>([]);
  const [decision, setDecision] = useState<"approved" | "changes_requested" | "rejected">("changes_requested");
  const [targetStage, setTargetStage] = useState<"beta" | "verified">("beta");
  const [releaseEvidence, setReleaseEvidence] = useState("");
  const [rollbackTarget, setRollbackTarget] = useState("");
  const [gate, setGate] = useState<Gate | null>(null);
  const [totp, setTotp] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef<{ fingerprint: string; id: string } | null>(null);
  const artifactListRequestRef = useRef(0);
  const detailRequestRef = useRef(0);

  const loadCurriculum = useCallback(async () => {
    const body = await requestAdminJson<{ candidates: Candidate[]; reviewQueue: ReviewQueue }>("/api/admin/curriculum");
    setCandidates(body.candidates);
    setReviewQueue(body.reviewQueue);
    const firstQueued = body.reviewQueue.items[0];
    setVersionId((current) => current ?? firstQueued?.courseVersionId ?? body.candidates[0]?.id ?? null);
    setArtifactId((current) => current ?? firstQueued?.id ?? null);
  }, []);
  const loadArtifacts = useCallback(async (selectedVersionId: string) => {
    const requestNumber = ++artifactListRequestRef.current;
    await Promise.resolve();
    setArtifactsLoading(true);
    try {
      const body = await requestAdminJson<{ artifacts: Artifact[] }>(`/api/admin/curriculum/versions/${selectedVersionId}/artifacts`);
      if (requestNumber !== artifactListRequestRef.current) return;
      setArtifacts(body.artifacts);
      if (!body.artifacts.length) {
        detailRequestRef.current += 1;
        setDetail(null);
        setDetailLoading(false);
      }
      setArtifactId((current) => current && body.artifacts.some((artifact) => artifact.id === current)
        ? current
        : body.artifacts[0]?.id ?? null);
    } finally {
      if (requestNumber === artifactListRequestRef.current) setArtifactsLoading(false);
    }
  }, []);
  const loadDetail = useCallback(async (selectedArtifactId: string) => {
    const requestNumber = ++detailRequestRef.current;
    await Promise.resolve();
    setDetailLoading(true);
    setDetail(null);
    setChecklist(emptyChecklist());
    setReviewedItems([]);
    try {
      const body = await requestAdminJson<{ detail: Detail }>(`/api/admin/curriculum/artifacts/${selectedArtifactId}`);
      if (requestNumber !== detailRequestRef.current) return;
      setDetail(body.detail);
    } finally {
      if (requestNumber === detailRequestRef.current) setDetailLoading(false);
    }
  }, []);
  const refreshSelection = useCallback(async () => {
    await Promise.all([
      versionId ? loadArtifacts(versionId) : Promise.resolve(),
      artifactId ? loadDetail(artifactId) : Promise.resolve(),
    ]);
  }, [artifactId, loadArtifacts, loadDetail, versionId]);
  useEffect(() => {
    void requestAdminJson<{ candidates: Candidate[]; reviewQueue: ReviewQueue }>("/api/admin/curriculum")
      .then((body) => {
        setCandidates(body.candidates);
        setReviewQueue(body.reviewQueue);
        const firstQueued = body.reviewQueue.items[0];
        setVersionId(firstQueued?.courseVersionId ?? body.candidates[0]?.id ?? null);
        setArtifactId(firstQueued?.id ?? null);
      })
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "Curriculum queue failed."));
  }, []);
  useEffect(() => {
    if (!versionId) return;
    void Promise.resolve().then(() => loadArtifacts(versionId))
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "Artifact queue failed."));
  }, [loadArtifacts, versionId]);
  useEffect(() => {
    if (!artifactId) {
      detailRequestRef.current += 1;
      return;
    }
    void Promise.resolve().then(() => loadDetail(artifactId))
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "Artifact evidence failed."));
  }, [artifactId, loadDetail]);
  const candidate = candidates.find((item) => item.id === versionId) ?? null;
  const filteredReviewItems = useMemo(() => {
    const search = queueSearch.trim().toLocaleLowerCase();
    return reviewQueue.items.filter((item) => {
      if (queueCourse && item.courseVersionId !== queueCourse) return false;
      if (queueStatus && item.reviewStatus !== queueStatus) return false;
      if (!search) return true;
      return [
        item.artifactKey,
        item.courseTitle,
        item.courseSlug,
        item.courseVersion,
        item.artifactType,
        item.sourcePath,
        item.reviewStatus,
      ].some((value) => value.toLocaleLowerCase().includes(search));
    });
  }, [queueCourse, queueSearch, queueStatus, reviewQueue.items]);
  const queuePageCount = Math.max(1, Math.ceil(filteredReviewItems.length / REVIEW_QUEUE_PAGE_SIZE));
  const safeQueuePage = Math.min(queuePage, queuePageCount);
  const queuePageStart = (safeQueuePage - 1) * REVIEW_QUEUE_PAGE_SIZE;
  const visibleReviewItems = filteredReviewItems.slice(queuePageStart, queuePageStart + REVIEW_QUEUE_PAGE_SIZE);
  const visibleRangeStart = filteredReviewItems.length ? queuePageStart + 1 : 0;
  const visibleRangeEnd = Math.min(queuePageStart + REVIEW_QUEUE_PAGE_SIZE, filteredReviewItems.length);
  function idFor(fingerprint: string) {
    if (requestRef.current?.fingerprint !== fingerprint) requestRef.current = { fingerprint, id: crypto.randomUUID() };
    return requestRef.current.id;
  }
  async function mfa() {
    if (!/^\d{6}$/.test(totp)) throw new Error("Enter the current six-digit authenticator code.");
    if (reason.trim().length < 20) throw new Error("Record a specific reason of at least 20 characters.");
    await requestAdminJson("/api/security/fresh-mfa", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: totp }) });
  }
  async function mutation(action: () => Promise<unknown>, success: string) {
    setBusy(true); setError(null); setNotice(null);
    try { await mfa(); await action(); requestRef.current = null; setTotp(""); setGate(null); setNotice(success); await Promise.all([loadCurriculum(), refreshSelection()]); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Operation failed safely."); }
    finally { setBusy(false); }
  }
  async function stage() {
    const fingerprint = `stage:${reason.trim()}`;
    await mutation(() => requestAdminJson("/api/admin/curriculum/stage", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ requestId: idFor(fingerprint), reason: reason.trim() }) }), "Filesystem content staged as immutable drafts; nothing was approved.");
  }
  async function review() {
    if (!detail || detailLoading || detail.artifact.id !== artifactId) return;
    const payload = { expectedVersion: detail.artifact.rowVersion, decision, checklist, reviewedItemIds: reviewedItems, reason: reason.trim() };
    const fingerprint = JSON.stringify({ artifactId: detail.artifact.id, ...payload });
    await mutation(() => requestAdminJson(`/api/admin/curriculum/artifacts/${detail.artifact.id}/review`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ requestId: idFor(fingerprint), ...payload }) }), "Human review evidence appended without rewriting content.");
  }
  async function runGate() {
    if (!candidate) return;
    setBusy(true); setError(null);
    try { setGate((await requestAdminJson<{ gate: Gate }>(`/api/admin/curriculum/versions/${candidate.id}/gate?target=${targetStage}`)).gate); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Gate failed."); }
    finally { setBusy(false); }
  }
  async function appendEvidence() {
    if (!candidate) return;
    let evidence: unknown;
    try { evidence = JSON.parse(releaseEvidence); } catch { setError("Release evidence must be valid JSON."); return; }
    const payload = { expectedVersion: candidate.publicationRevision, evidence, reason: reason.trim() };
    const fingerprint = JSON.stringify({ versionId: candidate.id, ...payload });
    await mutation(() => requestAdminJson(`/api/admin/curriculum/versions/${candidate.id}/evidence`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ requestId: idFor(fingerprint), ...payload }) }), "Signed release evidence appended; publication still requires a new gate pass.");
  }
  async function publish() {
    if (!candidate) return;
    const payload = { expectedVersion: candidate.publicationRevision, targetStage, reason: reason.trim() };
    const fingerprint = JSON.stringify({ versionId: candidate.id, ...payload });
    await mutation(() => requestAdminJson(`/api/admin/curriculum/versions/${candidate.id}/publish`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ requestId: idFor(fingerprint), ...payload }) }), `Published ${targetStage}; the catalog pointer advanced atomically.`);
  }
  async function rollback() {
    if (!candidate?.pointerVersion || !rollbackTarget) return;
    const payload = { targetCourseVersionId: rollbackTarget, expectedPointerVersion: candidate.pointerVersion, reason: reason.trim() };
    const fingerprint = JSON.stringify({ courseId: candidate.courseId, ...payload });
    await mutation(() => requestAdminJson(`/api/admin/curriculum/courses/${candidate.courseId}/rollback`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ requestId: idFor(fingerprint), ...payload }) }), "Catalog pointer rolled back; history and enrolled evidence were preserved.");
  }
  async function retire() {
    if (!candidate || candidate.isCurrent) return;
    const payload = { expectedVersion: candidate.publicationRevision, reason: reason.trim() };
    const fingerprint = JSON.stringify({ versionId: candidate.id, action: "retire", ...payload });
    await mutation(() => requestAdminJson(`/api/admin/curriculum/versions/${candidate.id}/retire`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ requestId: idFor(fingerprint), ...payload }) }), "Non-current curriculum version retired; its immutable history was preserved.");
  }

  return <main className={styles.adminPage}>
    <header className={styles.pageHead}><div><span className={styles.eyebrow}>Human editorial control</span><h1>Course <span>review &amp; publication</span></h1><p>{reviewQueue.total} staged artifacts need review across {reviewQueue.courseCount} course versions. Approval remains a human, MFA-protected decision.</p></div><div className={styles.headActions}><button type="button" className="button button-secondary" onClick={() => void loadCurriculum()}><RefreshCw size={14} /> Refresh</button><button type="button" className="button button-primary" disabled={busy} onClick={() => void stage()}><BookOpenCheck size={14} /> Stage drafts</button></div></header>
    <p className={styles.safeNotice}><ShieldCheck size={14} /> AI-assisted files remain draft and exam-ineligible. Staging never approves, publishes, or rewrites them.</p>
    {error && <p className={styles.inlineError} role="alert">{error}</p>}{notice && <p className={styles.inlineSuccess} role="status">{notice}</p>}
    <div className={styles.curriculumAuth}><label>Curriculum authenticator code<input aria-label="Curriculum authenticator code" inputMode="numeric" maxLength={6} type="password" value={totp} onChange={(event) => setTotp(event.target.value.replace(/\D/g, ""))} /></label><label>Recorded reason<textarea value={reason} maxLength={500} onChange={(event) => { setReason(event.target.value); requestRef.current = null; }} /></label></div>
    <section className={styles.panel} aria-labelledby="editorial-review-queue-title">
      <div className={styles.panelHead}><div><FileSearch size={18} /><span><strong id="editorial-review-queue-title">Editorial review queue</strong><small>All staged artifacts without approval, across every active course version</small></span></div><span className="pill">{reviewQueue.total} outstanding across {reviewQueue.courseCount} courses</span></div>
      <div className={styles.curriculumQueueSummary}>{reviewQueue.statusCounts.map((item) => <span className="pill" key={item.status}>{item.count} {humanize(item.status)}</span>)}</div>
      <div className={styles.curriculumQueueControls}>
        <label className={styles.curriculumQueueFilter}>Search<input aria-label="Search editorial queue" type="search" value={queueSearch} onChange={(event) => { setQueueSearch(event.target.value); setQueuePage(1); }} placeholder="Artifact, course, type, or path" /></label>
        <label className={styles.curriculumQueueFilter}>Course<select aria-label="Filter editorial queue by course" value={queueCourse} onChange={(event) => { setQueueCourse(event.target.value); setQueuePage(1); }}><option value="">All courses</option>{reviewQueue.courseCounts.map((item) => <option key={item.courseVersionId} value={item.courseVersionId}>{item.courseTitle} v{item.courseVersion} ({item.count})</option>)}</select></label>
        <label className={styles.curriculumQueueFilter}>Status<select aria-label="Filter editorial queue by status" value={queueStatus} onChange={(event) => { setQueueStatus(event.target.value); setQueuePage(1); }}><option value="">All outstanding statuses</option>{reviewQueue.statusCounts.map((item) => <option key={item.status} value={item.status}>{humanize(item.status)} ({item.count})</option>)}</select></label>
      </div>
      <div className={styles.curriculumReviewQueue} aria-label="Outstanding curriculum artifacts">
        {visibleReviewItems.map((item) => <button className={`${styles.curriculumArtifact} ${item.id === artifactId ? styles.curriculumArtifactActive : ""}`} key={item.id} onClick={() => { setGate(null); setVersionId(item.courseVersionId); setArtifactId(item.id); }} type="button"><span><strong>{item.artifactKey}</strong><small>{item.courseTitle} v{item.courseVersion} · {humanize(item.artifactType)} · {item.sourcePath}</small></span><StatusPill status={item.reviewStatus} /></button>)}
        {!visibleReviewItems.length && <p>{reviewQueue.total ? "No artifacts match these filters." : "No staged artifacts need editorial review."}</p>}
      </div>
      <div className={styles.curriculumQueueFooter}>
        <p className={styles.mutedText} role="status" aria-live="polite" aria-atomic="true">Showing {visibleRangeStart}–{visibleRangeEnd} of {filteredReviewItems.length} matching artifacts ({reviewQueue.total} total). Page {safeQueuePage} of {queuePageCount}.</p>
        <nav className={styles.curriculumQueuePagination} aria-label="Editorial review queue pages">
          <button type="button" className="button button-secondary" disabled={safeQueuePage === 1} onClick={() => setQueuePage(Math.max(1, safeQueuePage - 1))}>Previous</button>
          <span aria-hidden="true">{safeQueuePage} / {queuePageCount}</span>
          <button type="button" className="button button-secondary" disabled={safeQueuePage === queuePageCount} onClick={() => setQueuePage(Math.min(queuePageCount, safeQueuePage + 1))}>Next</button>
        </nav>
      </div>
      <small className={styles.mutedText}>Select any artifact to open its immutable evidence and review controls below.</small>
    </section>
    <div className={styles.appealWorkspace}>
      <aside className={styles.appealQueue} aria-label="Curriculum candidates">{candidates.length ? candidates.map((item) => <button type="button" className={`${styles.appealQueueItem} ${item.id === versionId ? styles.appealQueueItemActive : ""}`} key={item.id} onClick={() => { setGate(null); setVersionId(item.id); }}><span><strong>{item.title} v{item.version}</strong><small>{item.approvedCount}/{item.artifactCount} reviewed · {item.aiAssistedCount} AI-assisted</small></span><StatusPill status={item.stage} /><p>{item.isCurrent ? "Current catalog pointer" : `Publication revision ${item.publicationRevision}`}</p></button>) : <p>No staged candidates.</p>}</aside>
      <section className={styles.appealDetail}>
        {candidate && <article className={styles.panel}><div className={styles.panelHead}><div><BookOpenCheck size={18} /><span><strong>{candidate.courseSlug} · {candidate.contentHash.slice(0, 12)}…</strong><small>{candidate.unreviewedCount} unreviewed · release evidence {candidate.evidenceVersion ?? "missing"}</small></span></div><StatusPill status={candidate.stage} /></div><div className={styles.headActions}><select aria-label="Publication target" value={targetStage} onChange={(event) => { setGate(null); setTargetStage(event.target.value as typeof targetStage); }}><option value="beta">Beta</option><option value="verified">Verified</option></select><button type="button" className="button button-secondary" onClick={() => void runGate()}>Run gate</button><button type="button" className="button button-primary" disabled={!gate?.allowed || busy} onClick={() => void publish()}>Publish {targetStage}</button>{!candidate.isCurrent && candidate.stage !== "retired" && <button type="button" className="button button-secondary" disabled={busy} onClick={() => void retire()}>Retire version</button>}</div>{gate && <div className={gate.allowed ? styles.inlineSuccess : styles.inlineError}><strong>{gate.allowed ? "Gate passed" : `${gate.issues.length} blockers`}</strong>{gate.issues.slice(0, 15).map((item) => <p key={`${item.code}-${item.artifactKey ?? ""}`}>{item.code}: {item.message}</p>)}</div>}<label className={styles.curriculumJson}>Release evidence JSON<textarea value={releaseEvidence} onChange={(event) => setReleaseEvidence(event.target.value)} placeholder='{"schemaVersion":1,...}' /></label><button type="button" className="button button-secondary" onClick={() => void appendEvidence()}>Append release evidence</button>{candidate.isCurrent && <div className={styles.headActions}><select aria-label="Rollback target" value={rollbackTarget} onChange={(event) => setRollbackTarget(event.target.value)}><option value="">Select prior version</option>{candidates.filter((item) => item.courseId === candidate.courseId && item.id !== candidate.id && ["beta", "verified"].includes(item.stage)).map((item) => <option key={item.id} value={item.id}>v{item.version}</option>)}</select><button type="button" className="button button-secondary" disabled={!rollbackTarget} onClick={() => void rollback()}>Rollback pointer</button></div>}</article>}
        {(artifactsLoading || detailLoading) && <p role="status">Loading the selected curriculum evidence…</p>}
        <div className={styles.balancedColumns}><article className={styles.panel}><div className={styles.panelHead}><div><FileSearch size={18} /><span><strong>Artifacts</strong><small>Immutable review queue</small></span></div></div>{artifacts.map((item) => <button className={styles.curriculumArtifact} key={item.id} onClick={() => setArtifactId(item.id)}><span><strong>{item.artifactKey}</strong><small>{humanize(item.artifactType)} · {item.sourcePath}</small></span><StatusPill status={item.reviewStatus} /></button>)}</article>
        <article className={styles.panel}>{detail ? <><div className={styles.panelHead}><div><FileSearch size={18} /><span><strong>{detail.artifact.artifactKey}</strong><small>v{detail.artifact.rowVersion} · {detail.artifact.contentHashValid ? "hash verified" : "HASH FAILED"}</small></span></div><StatusPill status={detail.artifact.publicationStage} /></div>{detail.artifact.aiAssisted && <p className={styles.safeNotice}><AlertTriangle size={14} /> AI-assisted draft. Approval stays blocked until the authored file contains human-approved metadata and every bank item is exam-eligible.</p>}<details className={styles.evidenceDisclosure}><summary>Content, provenance, and answer-oracle evidence</summary><pre>{JSON.stringify(detail.artifact.content, null, 2)}</pre></details><fieldset className={styles.curriculumChecklist}><legend>Seven-dimension human checklist</legend>{REVIEW_DIMENSIONS.map((name) => <div key={name}><label><input type="checkbox" checked={checklist[name].passed} onChange={(event) => setChecklist((current) => ({ ...current, [name]: { ...current[name], passed: event.target.checked } }))} /> {humanize(name)}</label><input aria-label={`${name} evidence reference`} placeholder="Evidence reference" value={checklist[name].evidenceRef} onChange={(event) => setChecklist((current) => ({ ...current, [name]: { ...current[name], evidenceRef: event.target.value } }))} /><input aria-label={`${name} review note`} placeholder="Specific review note" value={checklist[name].note} onChange={(event) => setChecklist((current) => ({ ...current, [name]: { ...current[name], note: event.target.value } }))} /></div>)}</fieldset><fieldset className={styles.curriculumItems}><legend>Every item must be reviewed</legend>{detail.artifact.expectedReviewItemIds.map((item) => <label key={item}><input type="checkbox" checked={reviewedItems.includes(item)} onChange={(event) => setReviewedItems((current) => event.target.checked ? [...current, item] : current.filter((value) => value !== item))} /> {item}</label>)}</fieldset><label className={styles.curriculumJson}>Decision<select value={decision} onChange={(event) => setDecision(event.target.value as typeof decision)}><option value="changes_requested">Changes requested</option><option value="rejected">Rejected</option><option value="approved">Approved</option></select></label><button className="button button-primary" disabled={busy || !detail.artifact.contentHashValid} onClick={() => void review()}><CheckCircle2 size={14} /> Append review</button>{detail.timeline.map((event) => <p className={styles.safeNotice} key={event.id}>{event.reviewerName} · {humanize(event.decision)} · {event.reason}</p>)}</> : <p>Select an artifact.</p>}</article></div>
      </section>
    </div>
  </main>;
}
