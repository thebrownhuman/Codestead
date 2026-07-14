"use client";

import {
  BadgeCheck,
  BookOpenCheck,
  CheckCircle2,
  ChevronRight,
  FlaskConical,
  FolderKanban,
  LockKeyhole,
  RefreshCw,
  Rocket,
  Search,
  ShieldCheck,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import styles from "./module-projects.module.css";

type Brief = {
  templateKey: string;
  publicationStatus: string;
  moduleTitle: string;
  laymanScenario: string;
  problem: string;
  artifact: string;
  learnerRole: string;
  prerequisiteSkillIds: string[];
  demonstratedOutcomes: string[];
  milestones: Array<{ title: string; purpose: string; evidence: string }>;
  acceptanceChecks: Array<{ id: string; given: string; when: string; then: string }>;
  reflectionPrompts: string[];
  stretchGoals: string[];
  editorialNotice: string;
  awardNotice: string;
};

type ModuleProject = {
  templateId: string;
  courseId: string;
  courseTitle: string;
  courseVersion: string;
  moduleId: string;
  title: string;
  stage: string;
  state: "started" | "retired" | "draft" | "locked" | "plan_locked" | "mastery_locked" | "ready";
  reason: string;
  directAwardPolicy: "none";
  brief: Brief;
  project: { id: string; status: string; updatedAt: string | null } | null;
};

const stateLabel: Record<ModuleProject["state"], string> = {
  started: "Started",
  ready: "Ready to build",
  mastery_locked: "Mastery exam needed",
  plan_locked: "Plan skills needed",
  draft: "Editorial draft",
  retired: "Retired",
  locked: "Locked",
};

function ProjectDetails({ item }: { item: ModuleProject }) {
  return <div className={styles.briefBody}>
    <section className={styles.scenario}>
      <span><BookOpenCheck size={18} aria-hidden="true" /></span>
      <div><strong>Picture it in real life</strong><p>{item.brief.laymanScenario}</p></div>
    </section>
    <div className={styles.briefGrid}>
      <section><h4>Your mission</h4><p>{item.brief.problem}</p><p><strong>Build:</strong> {item.brief.artifact}</p></section>
      <section><h4>Why this proves learning</h4><ul>{item.brief.demonstratedOutcomes.map((outcome) => <li key={outcome}>{outcome}</li>)}</ul></section>
    </div>
    <section><h4>Build it in small wins</h4><ol className={styles.milestones}>{item.brief.milestones.map((milestone, index) => <li key={milestone.title}><span>{index + 1}</span><div><strong>{milestone.title}</strong><p>{milestone.purpose}</p><small>Show: {milestone.evidence}</small></div></li>)}</ol></section>
    <section><h4>Acceptance checks</h4><div className={styles.checkGrid}>{item.brief.acceptanceChecks.map((check) => <article key={check.id} data-check={check.id}><strong>{check.id}</strong><p><b>Given</b> {check.given}</p><p><b>When</b> {check.when}</p><p><b>Then</b> {check.then}</p></article>)}</div></section>
    <div className={styles.briefGrid}>
      <section><h4>Reflect before review</h4><ul>{item.brief.reflectionPrompts.map((prompt) => <li key={prompt}>{prompt}</li>)}</ul></section>
      <section><h4>Optional stretch</h4><ul>{item.brief.stretchGoals.map((goal) => <li key={goal}>{goal}</li>)}</ul></section>
    </div>
    <p className={styles.integrityNote}><ShieldCheck size={15} aria-hidden="true" /> {item.brief.awardNotice}</p>
  </div>;
}

export function ModuleProjectStudio() {
  const [items, setItems] = useState<ModuleProject[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [course, setCourse] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [starting, setStarting] = useState<string | null>(null);
  const requestIds = useRef(new Map<string, string>());

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const response = await fetch("/api/module-projects", { cache: "no-store" });
      const body = await response.json() as { projects?: ModuleProject[]; error?: string };
      if (!response.ok || !body.projects) throw new Error(body.error ?? "Module projects could not be loaded.");
      setItems(body.projects);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Module projects could not be loaded.");
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { void Promise.resolve().then(load); }, [load]);

  const courses = useMemo(() => [...new Map(items.map((item) => [item.courseId, item.courseTitle])).entries()]
    .sort((left, right) => left[1].localeCompare(right[1])), [items]);
  const visible = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return items.filter((item) => (!course || item.courseId === course)
      && (!needle || [item.title, item.courseTitle, item.brief.moduleTitle, item.brief.problem]
        .some((value) => value.toLocaleLowerCase().includes(needle))));
  }, [course, items, query]);

  async function start(item: ModuleProject) {
    let requestId = requestIds.current.get(item.templateId);
    if (!requestId) { requestId = crypto.randomUUID(); requestIds.current.set(item.templateId, requestId); }
    setStarting(item.templateId); setError(null);
    try {
      const response = await fetch("/api/module-projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestId, templateId: item.templateId }),
      });
      const body = await response.json() as { result?: { project: ModuleProject["project"] }; error?: string };
      if (!response.ok || !body.result?.project) throw new Error(body.error ?? "Project could not be started.");
      requestIds.current.delete(item.templateId);
      setItems((current) => current.map((entry) => entry.templateId === item.templateId
        ? { ...entry, state: "started", reason: "Your learner-owned project already exists.", project: body.result!.project }
        : entry));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Project could not be started.");
    } finally { setStarting(null); }
  }

  return <section className={styles.studio} aria-labelledby="module-project-title">
    <header className={styles.hero}>
      <div><span className={styles.eyebrow}>Learn it, then build it</span><h2 id="module-project-title">Module project arcade</h2><p>Each major module ends with a small, real-world build. No copied solution—just a friendly mission, checkpoints, edge cases, and evidence you can explain.</p></div>
      <div className={styles.heroBadge}><Rocket size={22} aria-hidden="true" /><span><strong>{items.filter((item) => item.state === "ready").length}</strong> ready now</span></div>
    </header>
    <aside className={styles.safeNotice}><ShieldCheck size={18} aria-hidden="true" /><span><strong>Evidence first.</strong> Projects unlock only after the exact module is in your plan and its independent mastery exam is passed. Starting or replaying never awards XP, coins, badges, or mastery.</span></aside>
    <div className={styles.controls}>
      <label><Search size={16} aria-hidden="true" /><span className="sr-only">Search module projects</span><input type="search" placeholder="Search a mission or module" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
      <label><span className="sr-only">Filter by course</span><select value={course} onChange={(event) => setCourse(event.target.value)}><option value="">All enrolled courses</option>{courses.map(([id, title]) => <option key={id} value={id}>{title}</option>)}</select></label>
      <button className="button button-secondary" disabled={loading} onClick={() => void load()} type="button"><RefreshCw size={15} aria-hidden="true" /> Refresh</button>
    </div>
    {error ? <p className={styles.error} role="alert">{error}</p> : null}
    {loading ? <div className={`${styles.empty} card`}>Loading your exact course-version projects…</div>
      : visible.length ? <div className={styles.projectList}>{visible.map((item) => {
        const isOpen = expanded === item.templateId;
        const locked = item.state !== "ready" && item.state !== "started";
        return <article className={`${styles.projectCard} card`} data-state={item.state} key={item.templateId}>
          <div className={styles.projectSummary}>
            <span className={styles.projectIcon}>{item.state === "ready" ? <FlaskConical /> : item.state === "started" ? <CheckCircle2 /> : <LockKeyhole />}</span>
            <div className={styles.projectIdentity}><span>{item.courseTitle} · v{item.courseVersion} · {item.brief.moduleTitle}</span><h3>{item.title}</h3><p>{item.brief.problem}</p><small>{item.reason}</small></div>
            <span className={styles.statePill} data-state={item.state}>{stateLabel[item.state]}</span>
          </div>
          <div className={styles.cardActions}>
            <button className="button button-secondary" aria-expanded={isOpen} onClick={() => setExpanded(isOpen ? null : item.templateId)} type="button">{isOpen ? "Hide brief" : "Open brief"}<ChevronRight size={15} aria-hidden="true" /></button>
            {item.state === "started" && item.project ? <a className="button button-primary" href={`/projects#${item.project.id}`}><FolderKanban size={15} /> Open project</a>
              : <button className="button button-primary" disabled={locked || starting === item.templateId} onClick={() => void start(item)} type="button"><BadgeCheck size={15} />{starting === item.templateId ? "Starting…" : "Start after mastery"}</button>}
          </div>
          {isOpen ? <ProjectDetails item={item} /> : null}
        </article>;
      })}</div> : <div className={`${styles.empty} card`}>No module projects match this view. Enroll in a published course, then refresh.</div>}
  </section>;
}
