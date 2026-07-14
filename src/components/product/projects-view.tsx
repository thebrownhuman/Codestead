"use client";

import {
  FileText,
  FolderKanban,
  GitBranch as Github,
  Plus,
  Scale,
  Sparkles,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { ProjectRevisionDialog } from "./project-revision-dialog";
import { ModalDialog } from "@/components/ui/modal-dialog";
import styles from "./product-pages.module.css";

type ProjectReview = {
  id: string;
  commitSha: string;
  analyzerVersion: string;
  rubricVersion: string;
  analysisProvenance: Record<string, unknown>;
  findings: Array<Record<string, unknown>>;
  findingsHash: string | null;
  status: string;
  createdAt: string;
  qualityAssessment: ProjectReviewQualityAssessment | null;
  appeal: { id: string; status: string | null } | null;
  correction: {
    id: string;
    revision: number;
    status: string;
    sourceCommitSha: string;
    sourceFindingsHash: string;
    resultFindingsHash: string | null;
    projectionApplied: boolean | null;
    createdAt: string;
    completedAt: string | null;
  } | null;
};

type ProjectReviewQualityAssessment = {
  schemaVersion: 1;
  origin: "deterministic_static";
  scoringMethod: "bounded_deductions_v1";
  score: number;
  categories: Array<{
    id: "likely-bug" | "security" | "testing" | "documentation" | "maintainability";
    label: string;
    score: number;
    maximum: number;
    findingCount: number;
  }>;
  reviewedCommitSha: string;
  filesReviewed: number;
  findingsCapped: boolean;
  limitations: string[];
};

type Project = {
  id: string;
  title: string;
  summary: string;
  status: string;
  githubUrl?: string | null;
  updatedAt: string;
  prd?: {
    version?: string;
    track?: string;
    difficulty?: string;
    problem?: string;
    users?: string[];
    goals?: string[];
    nonGoals?: string[];
    milestones?: Array<{ id?: number; title: string; evidence?: string }>;
    acceptance?: string[];
  };
  reviews?: ProjectReview[];
  effectiveReview?: {
    sourceReviewId: string;
    correctionId: string | null;
    commitSha: string;
    analyzerVersion: string;
    rubricVersion: string;
    provenance: Record<string, unknown>;
    findings: Array<Record<string, unknown>>;
    findingsHash: string;
    revision: number;
    updatedAt: string;
    qualityAssessment: ProjectReviewQualityAssessment | null;
  } | null;
};

type AppealTarget = { projectId: string; reviewId: string; projectTitle: string };

const FINDING_CATEGORY_LABELS = {
  "likely-bug": "Likely bug",
  security: "Security",
  testing: "Testing",
  documentation: "Documentation",
  maintainability: "Maintainability",
} as const;

function deterministicFindingSummary(findings: Array<Record<string, unknown>>) {
  return findings.flatMap((finding) => {
    const category = typeof finding.category === "string" && Object.hasOwn(FINDING_CATEGORY_LABELS, finding.category)
      ? finding.category as keyof typeof FINDING_CATEGORY_LABELS
      : null;
    if (finding.origin !== "deterministic_static" || !category || typeof finding.message !== "string") return [];
    return [{
      category: FINDING_CATEGORY_LABELS[category],
      message: finding.message.slice(0, 500),
      path: typeof finding.path === "string" ? finding.path.slice(0, 300) : null,
      line: Number.isSafeInteger(finding.line) && Number(finding.line) > 0 ? Number(finding.line) : null,
    }];
  }).slice(0, 5);
}

export function ProjectsView() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [createDirty, setCreateDirty] = useState(false);
  const [appealTarget, setAppealTarget] = useState<AppealTarget | null>(null);
  const [selectedProject, setSelectedProject] = useState<Project | null>(null);
  const [revisionProject, setRevisionProject] = useState<Project | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [createBusy, setCreateBusy] = useState(false);
  const [appealError, setAppealError] = useState<string | null>(null);
  const [appealMessage, setAppealMessage] = useState<string | null>(null);
  const [appealBusy, setAppealBusy] = useState(false);
  const [appealDirty, setAppealDirty] = useState(false);
  const appealRequest = useRef<{ fingerprint: string; id: string } | null>(null);
  const createSubmitting = useRef(false);

  const loadProjects = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const response = await fetch("/api/projects", { cache: "no-store" });
      const body = (await response.json().catch(() => null)) as { projects?: Project[]; error?: string } | null;
      if (!response.ok || !body?.projects) {
        throw new Error(body?.error ?? "Projects could not be loaded.");
      }
      setProjects(body.projects);
    } catch (cause) {
      setLoadError(cause instanceof Error ? cause.message : "Projects could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void Promise.resolve().then(loadProjects);
  }, [loadProjects]);

  async function create(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (createSubmitting.current) return;
    createSubmitting.current = true;
    setCreateBusy(true);
    setError(null);
    const form = new FormData(event.currentTarget);
    try {
      const response = await fetch("/api/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: form.get("title"),
          summary: form.get("summary"),
          track: form.get("track"),
          difficulty: form.get("difficulty"),
        }),
      });
      const body = (await response.json().catch(() => null)) as { project?: Project; error?: string } | null;
      if (!response.ok || !body?.project) {
        setError(body?.error ?? "Project could not be created.");
        return;
      }
      setProjects((items) => [{ ...body.project!, reviews: [] }, ...items]);
      setCreateDirty(false);
      setOpen(false);
    } catch {
      setError("The project service could not be reached. Your brief is still in the form; try again.");
    } finally {
      createSubmitting.current = false;
      setCreateBusy(false);
    }
  }

  function openAppeal(target: AppealTarget) {
    appealRequest.current = null;
    setAppealError(null);
    setAppealMessage(null);
    setAppealDirty(false);
    setAppealTarget(target);
  }

  function openCreateDialog() {
    setError(null);
    setCreateDirty(false);
    setOpen(true);
  }

  function closeCreateDialog() {
    if (createBusy) return;
    if (createDirty && !window.confirm("Discard this unfinished project brief?")) return;
    setCreateDirty(false);
    setOpen(false);
  }

  function closeAppealDialog() {
    if (appealBusy) return;
    if (appealDirty && !window.confirm("Discard this unfinished appeal reason?")) return;
    setAppealDirty(false);
    setAppealTarget(null);
  }

  async function submitAppeal(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!appealTarget) return;
    const form = new FormData(event.currentTarget);
    const reason = String(form.get("reason") ?? "").trim();
    const fingerprint = `${appealTarget.projectId}:${appealTarget.reviewId}:${reason}`;
    if (appealRequest.current?.fingerprint !== fingerprint) {
      appealRequest.current = { fingerprint, id: crypto.randomUUID() };
    }
    setAppealBusy(true);
    setAppealError(null);
    try {
      const response = await fetch(
        `/api/projects/${appealTarget.projectId}/reviews/${appealTarget.reviewId}/appeal`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            clientRequestId: appealRequest.current.id,
            category: "project_finding",
            reason,
          }),
        },
      );
      const body = (await response.json().catch(() => null)) as { appealId?: string; error?: string } | null;
      if (!response.ok || !body?.appealId) {
        setAppealError(body?.error ?? "The appeal could not be submitted.");
        return;
      }
      setProjects((items) => items.map((item) => item.id === appealTarget.projectId
        ? {
            ...item,
            reviews: item.reviews?.map((review) => review.id === appealTarget.reviewId
              ? { ...review, appeal: { id: body.appealId!, status: "open" } }
              : review),
          }
        : item));
      setAppealTarget(null);
      setAppealDirty(false);
      setAppealMessage("Your appeal is in the administrator review queue. The original review remains unchanged.");
    } catch {
      setAppealError("The appeal service could not be reached. Your reason is still in the form; try again.");
    } finally {
      setAppealBusy(false);
    }
  }

  return (
    <div className={styles.page}>
      <header className={styles.pageHead}>
        <div>
          <span className={styles.eyebrow}>Build to transfer</span>
          <h1>Projects you still own.</h1>
          <p>Codestead can clarify a brief, milestones, tests, and review criteria. It will not hand you a finished portfolio project.</p>
        </div>
        <button className="button button-primary" onClick={openCreateDialog}><Plus size={16} /> New project brief</button>
      </header>

      {appealMessage && <p className={styles.success} role="status">{appealMessage}</p>}
      <section className={styles.stats}>
        <article className={`${styles.stat} card`}><span><FolderKanban size={18} /></span><div><strong>{projects.length}</strong><small>project briefs</small></div></article>
        <article className={`${styles.stat} card`}><span><FileText size={18} /></span><div><strong>{projects.reduce((sum, item) => sum + (item.prd?.milestones?.length ?? 0), 0)}</strong><small>defined milestones</small></div></article>
        <article className={`${styles.stat} card`}><span><Github size={18} /></span><div><strong>{projects.filter((item) => item.githubUrl).length}</strong><small>linked repositories</small></div></article>
        <article className={`${styles.stat} card`}><span><Sparkles size={18} /></span><div><strong>{projects.reduce((sum, item) => sum + (item.reviews?.length ?? 0), 0)}</strong><small>stored reviews</small></div></article>
      </section>

      {loading
        ? <div className={`${styles.empty} card`}>Loading projects...</div>
        : loadError
          ? <section className={`${styles.empty} card`} role="alert"><div><h2>Projects are temporarily unavailable</h2><p>{loadError}</p><button className="button button-secondary" onClick={() => void loadProjects()} type="button">Try again</button></div></section>
        : projects.length
          ? <section className={styles.projectGrid}>{projects.map((item) => (
              <article className={`${styles.projectCard} card`} key={item.id}>
                <div className={styles.projectTop}><span className={styles.projectIcon}><FolderKanban size={18} /></span><span className={styles.status}>{item.status}</span></div>
                <h3>{item.title}</h3>
                <p>{item.summary}</p>
                {item.effectiveReview && <p className={styles.fileSafety}>
                  <Sparkles size={14} /> Effective review v{item.effectiveReview.revision}: commit {item.effectiveReview.commitSha.slice(0, 12)}; {item.effectiveReview.findings.length} findings; {item.effectiveReview.correctionId ? "corrective re-analysis" : "original static review"}. No AI or repository execution.
                </p>}
                {item.effectiveReview?.qualityAssessment && <section
                  aria-label={`Deterministic code quality review for ${item.title}`}
                  className={styles.qualityReview}
                >
                  <div className={styles.qualityScore}>
                    <strong>{item.effectiveReview.qualityAssessment.score}<span>/100</span></strong>
                    <div>
                      <b>Static quality signal</b>
                      <small>Pinned to commit {item.effectiveReview.qualityAssessment.reviewedCommitSha.slice(0, 12)}. Deterministic rules only; not proof of correctness.</small>
                    </div>
                  </div>
                  <meter
                    aria-label={`Static quality score: ${item.effectiveReview.qualityAssessment.score} out of 100`}
                    max={100}
                    min={0}
                    value={item.effectiveReview.qualityAssessment.score}
                  />
                  <ul aria-label="Quality category breakdown" className={styles.qualityCategories}>
                    {item.effectiveReview.qualityAssessment.categories.map((category) => <li key={category.id}>
                      <span>{category.label}</span>
                      <strong>{category.score}/{category.maximum}</strong>
                      <small>{category.findingCount} {category.findingCount === 1 ? "finding" : "findings"}</small>
                    </li>)}
                  </ul>
                  {deterministicFindingSummary(item.effectiveReview.findings).length > 0 && <details>
                    <summary>Review findings and suggested improvements</summary>
                    <ul className={styles.qualityFindings}>
                      {deterministicFindingSummary(item.effectiveReview.findings).map((finding, index) => <li key={`${finding.category}-${finding.path ?? "repository"}-${finding.line ?? 0}-${index}`}>
                        <strong>{finding.category}</strong>
                        <span>{finding.message}</span>
                        {finding.path && <small>{finding.path}{finding.line ? `, line ${finding.line}` : ""}</small>}
                      </li>)}
                    </ul>
                  </details>}
                  <details>
                    <summary>What this score cannot prove</summary>
                    <ul>{item.effectiveReview.qualityAssessment.limitations.map((limitation) => <li key={limitation}>{limitation}</li>)}</ul>
                  </details>
                  <small>If a deterministic finding is wrong, use the Appeal review action below. A human administrator decides.</small>
                </section>}
                {item.reviews?.length ? <div className={styles.reviewList}>
                  {item.reviews.map((review) => <div className={styles.reviewRow} key={review.id}>
                    <div><strong>Original commit {review.commitSha.slice(0, 12)}</strong><small>{review.analyzerVersion} · {review.rubricVersion} · {review.findings.length} findings · {review.status}</small>
                      {review.correction && <small>Correction v{review.correction.revision}: {review.correction.status}{review.correction.projectionApplied === true ? " · effective" : review.correction.projectionApplied === false ? " · newer review remains effective" : ""}</small>}
                    </div>
                    {review.appeal
                      ? <span className={styles.status}>Appeal {review.appeal.status ?? "open"}</span>
                      : review.status === "complete" && <button className="button button-ghost" onClick={() => openAppeal({ projectId: item.id, reviewId: review.id, projectTitle: item.title })} type="button"><Scale size={14} /> Appeal review</button>}
                  </div>)}
                </div> : <p className={styles.reviewEmpty}>No stored repository reviews yet.</p>}
                <div className={styles.projectFooter}>
                  <span>{item.prd?.milestones?.length ?? 5} milestones</span>
                  <span className={styles.projectActions}>
                    <button aria-label={`Open revision history for ${item.title}`} className="button button-ghost" onClick={() => setRevisionProject(item)} type="button">Revisions</button>
                    <button aria-label={`Open PRD for ${item.title}`} className="button button-ghost" onClick={() => setSelectedProject(item)} type="button">Open PRD</button>
                  </span>
                </div>
              </article>
            ))}</section>
          : <section className={`${styles.empty} card`}><div><span><FolderKanban size={26} /></span><h2>Start with the problem, not code</h2><p>Create a short brief. The app will structure goals, non-goals, milestones, evidence, and acceptance checks.</p><button className="button button-primary" onClick={openCreateDialog}><Plus size={16} /> Create your first brief</button></div></section>}

      {open && <ModalDialog backdropClassName={styles.dialogBackdrop} dialogClassName={`${styles.dialog} card`} labelledBy="project-dialog-title" onClose={closeCreateDialog}>
          <div className={styles.dialogHead}><div><h2 id="project-dialog-title">Shape a project brief</h2><p>No implementation will be generated.</p></div><button className={styles.iconButton} aria-label="Close" data-dialog-initial-focus onClick={closeCreateDialog}><X size={17} /></button></div>
          {error && <p className={styles.error} role="alert">{error}</p>}
          <form className={styles.form} onChange={() => setCreateDirty(true)} onSubmit={create}>
            <label>Project title<input name="title" placeholder="Recipe inventory CLI" minLength={3} maxLength={100} required /></label>
            <label>Problem to solve<textarea name="summary" placeholder="Describe who needs it, what they need to accomplish, and why." minLength={20} maxLength={1000} required /></label>
            <label>Primary track<select name="track"><option>Python</option><option>C</option><option>C++</option><option>Java</option><option>JavaScript + React</option><option>AI foundations</option></select></label>
            <label>Ambition<select name="difficulty"><option value="starter">Starter · one focused workflow</option><option value="portfolio">Portfolio · polished and tested</option><option value="stretch">Stretch · multiple concepts and trade-offs</option></select></label>
            <button className="button button-primary" disabled={createBusy} type="submit"><FileText size={16} /> {createBusy ? "Creating brief…" : "Create PRD and milestones"}</button>
          </form>
      </ModalDialog>}

      {selectedProject && <ModalDialog backdropClassName={styles.dialogBackdrop} dialogClassName={`${styles.dialog} ${styles.prdDialog} card`} labelledBy="prd-dialog-title" onClose={() => setSelectedProject(null)}>
          <div className={styles.dialogHead}>
            <div><h2 id="prd-dialog-title">{selectedProject.title}</h2><p>Project brief · {selectedProject.prd?.track ?? "general"} · {selectedProject.prd?.difficulty ?? "learner selected"}</p></div>
            <button className={styles.iconButton} aria-label="Close project PRD" data-dialog-initial-focus onClick={() => setSelectedProject(null)} type="button"><X size={17} /></button>
          </div>
          <p className={styles.prdProblem}>{selectedProject.prd?.problem ?? selectedProject.summary}</p>
          <div className={styles.prdGrid}>
            <section><h3>Goals</h3><ul>{(selectedProject.prd?.goals ?? []).map((goal) => <li key={goal}>{goal}</li>)}</ul></section>
            <section><h3>Non-goals</h3><ul>{(selectedProject.prd?.nonGoals ?? []).map((goal) => <li key={goal}>{goal}</li>)}</ul></section>
          </div>
          <section className={styles.prdSection}>
            <h3>Milestones and evidence</h3>
            <ol>{(selectedProject.prd?.milestones ?? []).map((milestone, index) => <li key={`${milestone.id ?? index}-${milestone.title}`}><strong>{milestone.title}</strong>{milestone.evidence && <span>{milestone.evidence}</span>}</li>)}</ol>
          </section>
          <section className={styles.prdSection}>
            <h3>Acceptance checks</h3>
            <ul>{(selectedProject.prd?.acceptance ?? []).map((criterion) => <li key={criterion}>{criterion}</li>)}</ul>
          </section>
          <p className={styles.fileSafety}><Sparkles size={14} /> Codestead structures the brief and can offer small teaching examples, but it will not generate the finished project or paste-ready features.</p>
      </ModalDialog>}

      {revisionProject && <ProjectRevisionDialog
        onClose={() => setRevisionProject(null)}
        projectId={revisionProject.id}
        projectTitle={revisionProject.title}
      />}

      {appealTarget && <ModalDialog backdropClassName={styles.dialogBackdrop} dialogClassName={`${styles.dialog} card`} labelledBy="appeal-dialog-title" onClose={closeAppealDialog}>
          <div className={styles.dialogHead}><div><h2 id="appeal-dialog-title">Appeal stored review</h2><p>{appealTarget.projectTitle}. A human administrator decides. If overturned, the exact commit is re-analyzed with deterministic static rules; no AI or repository code execution is used.</p></div><button className={styles.iconButton} aria-label="Close appeal" data-dialog-initial-focus onClick={closeAppealDialog}><X size={17} /></button></div>
          {appealError && <p className={styles.error} role="alert">{appealError}</p>}
          <form className={styles.form} onChange={() => setAppealDirty(true)} onSubmit={submitAppeal}>
            <label>What finding should the administrator inspect?<textarea aria-label="Project review appeal reason" name="reason" minLength={20} maxLength={1000} required /></label>
            <small>The exact commit, analyzer version, and stored findings are preserved with your claim.</small>
            <button className="button button-primary" disabled={appealBusy} type="submit"><Scale size={16} /> {appealBusy ? "Submitting..." : "Submit appeal"}</button>
          </form>
      </ModalDialog>}
    </div>
  );
}
