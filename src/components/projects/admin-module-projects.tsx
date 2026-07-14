"use client";

import { BookOpenCheck, CheckCircle2, FileSearch, RefreshCw, ShieldCheck, UploadCloud } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import styles from "./module-projects.module.css";

type Template = {
  id: string;
  courseId: string;
  courseTitle: string;
  courseVersion: string;
  courseStage: string;
  moduleId: string;
  title: string;
  stage: "draft" | "beta" | "verified" | "retired";
  contentHash: string;
  rowVersion: number;
  reviewedAt: string | null;
  publishedAt: string | null;
};

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...init });
  const body = await response.json().catch(() => null) as (T & { error?: string }) | null;
  if (!response.ok || !body) throw new Error(body?.error ?? "Request failed safely.");
  return body;
}

export function AdminModuleProjects() {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [query, setQuery] = useState("");
  const [stage, setStage] = useState("");
  const [totp, setTotp] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const requestRef = useRef<{ fingerprint: string; id: string } | null>(null);

  const load = useCallback(async () => {
    const body = await json<{ templates: Template[] }>("/api/admin/module-projects");
    setTemplates(body.templates);
  }, []);
  useEffect(() => { void Promise.resolve().then(load).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "Load failed.")); }, [load]);

  const visible = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return templates.filter((item) => (!stage || item.stage === stage)
      && (!needle || [item.title, item.courseTitle, item.moduleId].some((value) => value.toLocaleLowerCase().includes(needle))));
  }, [query, stage, templates]);

  function requestId(fingerprint: string) {
    if (requestRef.current?.fingerprint !== fingerprint) requestRef.current = { fingerprint, id: crypto.randomUUID() };
    return requestRef.current.id;
  }

  async function authorize() {
    if (!/^\d{6}$/.test(totp)) throw new Error("Enter the current six-digit authenticator code.");
    if (reason.trim().length < 20) throw new Error("Record a specific review reason of at least 20 characters.");
    await json("/api/security/fresh-mfa", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: totp }) });
  }

  async function mutate(fingerprint: string, operation: () => Promise<unknown>, success: string) {
    setBusy(fingerprint); setError(null); setNotice(null);
    try {
      await authorize();
      await operation();
      requestRef.current = null; setTotp(""); setNotice(success); await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Operation failed safely."); }
    finally { setBusy(null); }
  }

  async function sync() {
    const fingerprint = `sync:${reason.trim()}`;
    await mutate(fingerprint, () => json("/api/admin/module-projects", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requestId: requestId(fingerprint), reason: reason.trim() }),
    }), "Exact course-version project drafts synchronized. Nothing was approved automatically.");
  }

  async function decide(item: Template, targetStage: "beta" | "verified" | "retired") {
    const fingerprint = `${item.id}:${item.rowVersion}:${targetStage}:${reason.trim()}`;
    await mutate(fingerprint, () => json(`/api/admin/module-projects/${item.id}/decision`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requestId: requestId(fingerprint), targetStage, expectedVersion: item.rowVersion, reason: reason.trim() }),
    }), `Project template moved to ${targetStage}; immutable evidence was appended.`);
  }

  return <main className={styles.adminStudio}>
    <header className={styles.hero}>
      <div><span className={styles.eyebrow}>Human project publication</span><h1>Module project review</h1><p>Every generated brief begins as a draft. Review the learner scenario, milestones, normal/boundary/failure checks, and solution-free promise before learners can see it as ready.</p></div>
      <button className="button button-secondary" onClick={() => void load()} type="button"><RefreshCw size={15} /> Refresh</button>
    </header>
    <p className={styles.safeNotice}><ShieldCheck size={17} /><span>Promotion is MFA-protected, version-checked, and bound to the exact current course publication. A template cannot award mastery, badges, XP, coins, or certificates.</span></p>
    {error ? <p className={styles.error} role="alert">{error}</p> : null}{notice ? <p className={styles.success} role="status">{notice}</p> : null}
    <section className={`${styles.adminAuth} card`}>
      <label>Authenticator code<input aria-label="Module project authenticator code" inputMode="numeric" maxLength={6} type="password" value={totp} onChange={(event) => setTotp(event.target.value.replace(/\D/g, ""))} /></label>
      <label>Recorded editorial reason<textarea maxLength={500} value={reason} onChange={(event) => { setReason(event.target.value); requestRef.current = null; }} placeholder="What evidence did you inspect, and why is this decision safe?" /></label>
      <button className="button button-primary" disabled={Boolean(busy)} onClick={() => void sync()} type="button"><UploadCloud size={15} /> Sync immutable drafts</button>
    </section>
    <div className={styles.controls}>
      <label><FileSearch size={16} /><span className="sr-only">Search project templates</span><input type="search" placeholder="Search course, module, or title" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
      <label><span className="sr-only">Filter project template stage</span><select value={stage} onChange={(event) => setStage(event.target.value)}><option value="">All stages</option><option value="draft">Draft</option><option value="beta">Beta</option><option value="verified">Verified</option><option value="retired">Retired</option></select></label>
      <span className={styles.queueCount}>{visible.length} / {templates.length}</span>
    </div>
    <div className={styles.adminList}>{visible.map((item) => <article className="card" key={item.id}>
      <span className={styles.projectIcon}>{item.stage === "verified" ? <CheckCircle2 /> : <BookOpenCheck />}</span>
      <div><small>{item.courseTitle} v{item.courseVersion} · course {item.courseStage} · {item.moduleId}</small><h2>{item.title}</h2><code>{item.contentHash.slice(0, 16)}… · revision {item.rowVersion}</code></div>
      <span className={styles.statePill}>{item.stage}</span>
      <div className={styles.cardActions}>
        {item.stage === "draft" ? <button className="button button-primary" disabled={Boolean(busy)} onClick={() => void decide(item, "beta")} type="button">Approve beta</button> : null}
        {item.stage === "beta" ? <button className="button button-primary" disabled={Boolean(busy)} onClick={() => void decide(item, "verified")} type="button">Promote verified</button> : null}
        {item.stage !== "retired" ? <button className="button button-secondary" disabled={Boolean(busy)} onClick={() => void decide(item, "retired")} type="button">Retire</button> : null}
      </div>
    </article>)}</div>
  </main>;
}
