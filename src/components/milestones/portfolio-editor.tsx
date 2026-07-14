"use client";

import { BadgeCheck, ExternalLink, GitBranch as Github, RefreshCw, ShieldCheck, UserRoundCheck } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import styles from "./milestones.module.css";

type Choice = { id: string; title: string; selected: boolean; summary?: string; status?: string; githubUrl?: string; description?: string; icon?: string; version?: string };
type Settings = {
  profile: { slug: string; displayName: string; headline: string; about: string; isPublished: boolean; rowVersion: number };
  projects: Choice[]; achievements: Choice[]; certificates: Choice[]; disclosure: string;
};

function errorMessage(code: string) {
  const messages: Record<string, string> = {
    DISCLOSURE_CONFIRMATION_REQUIRED: "Confirm the public disclosure before publishing.",
    INVALID_SELECTION: "One selected item is not yours, is revoked, or lacks a valid public GitHub repository link.",
    VERSION_CONFLICT: "This portfolio changed in another tab. Refresh before saving again.",
    SLUG_TAKEN: "That public URL is already in use. Choose another slug.",
  };
  return messages[code] ?? code;
}

export function PortfolioEditor() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [slug, setSlug] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [headline, setHeadline] = useState("");
  const [about, setAbout] = useState("");
  const [projects, setProjects] = useState<string[]>([]);
  const [achievements, setAchievements] = useState<string[]>([]);
  const [certificates, setCertificates] = useState<string[]>([]);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const apply = useCallback((next: Settings) => {
    setSettings(next);
    setSlug(next.profile.slug);
    setDisplayName(next.profile.displayName);
    setHeadline(next.profile.headline);
    setAbout(next.profile.about);
    setProjects(next.projects.filter((item) => item.selected).map((item) => item.id));
    setAchievements(next.achievements.filter((item) => item.selected).map((item) => item.id));
    setCertificates(next.certificates.filter((item) => item.selected).map((item) => item.id));
    setConfirmed(false);
  }, []);

  const load = useCallback(async () => {
    setError(null);
    const response = await fetch("/api/portfolio", { cache: "no-store" });
    const body = await response.json() as { settings?: Settings; error?: string };
    if (!response.ok || !body.settings) throw new Error(body.error ?? "PORTFOLIO_LOAD_FAILED");
    apply(body.settings);
  }, [apply]);

  useEffect(() => {
    let active = true;
    void fetch("/api/portfolio", { cache: "no-store" })
      .then(async (response) => {
        const body = await response.json() as { settings?: Settings; error?: string };
        if (!response.ok || !body.settings) throw new Error(body.error ?? "PORTFOLIO_LOAD_FAILED");
        if (active) apply(body.settings);
      })
      .catch((cause: unknown) => { if (active) setError(cause instanceof Error ? cause.message : "PORTFOLIO_LOAD_FAILED"); });
    return () => { active = false; };
  }, [apply]);

  function toggle(values: string[], id: string, setter: (next: string[]) => void) {
    setter(values.includes(id) ? values.filter((value) => value !== id) : [...values, id]);
  }

  async function save(publish: boolean) {
    if (!settings) return;
    setBusy(true); setError(null); setMessage(null);
    try {
      const response = await fetch("/api/portfolio", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          requestId: crypto.randomUUID(), expectedVersion: settings.profile.rowVersion,
          slug, displayName, headline, about: about.trim() || null, publish,
          confirmPublicDisclosure: publish && confirmed,
          selectedProjectIds: projects, selectedAchievementIds: achievements,
          selectedCertificateIds: certificates,
        }),
      });
      const body = await response.json() as { settings?: Settings; error?: string };
      if (!response.ok || !body.settings) throw new Error(body.error ?? "PORTFOLIO_UPDATE_FAILED");
      apply(body.settings);
      setMessage(publish ? "Portfolio published. Only the selected projection is public." : settings.profile.isPublished ? "Portfolio withdrawn immediately." : "Private portfolio draft saved.");
    } catch (cause) {
      setError(errorMessage(cause instanceof Error ? cause.message : "PORTFOLIO_UPDATE_FAILED"));
    } finally { setBusy(false); }
  }

  return (
    <div className={styles.page}>
      <header className={styles.hero}>
        <div><span className={styles.eyebrow}>Opt-in public portfolio</span><h1>Share the proof you choose. Nothing else.</h1><p>Build a resume-ready public page from owner-bound projects, achievements, and verified certificates. Withdraw it at any time.</p></div>
        <div className={styles.heroActions}>
          {settings?.profile.isPublished ? <Link className="button button-secondary" href={`/p/${settings.profile.slug}`} target="_blank">View public page <ExternalLink aria-hidden="true" size={15} /></Link> : null}
          <button className="button button-secondary" disabled={busy} onClick={() => void load().catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "PORTFOLIO_LOAD_FAILED"))} type="button"><RefreshCw aria-hidden="true" size={15} /> Refresh</button>
        </div>
      </header>
      <aside className={styles.notice}><ShieldCheck aria-hidden="true" size={19} /><span><strong>Public allowlist:</strong> {settings?.disclosure ?? "Loading the exact disclosure…"}</span></aside>
      <div aria-live="polite">{error ? <p className={styles.error}>{error}</p> : null}{message ? <p className={styles.success}>{message}</p> : null}</div>
      {!settings ? <section className={`${styles.empty} card`}><div><span><UserRoundCheck aria-hidden="true" size={28} /></span><h2>Loading your private portfolio controls…</h2></div></section> : (
        <div className={styles.grid}>
          <section className={`${styles.panel} card`}>
            <div className={styles.panelHead}><div><h2>Public introduction</h2><p>Use a display name; your account email is never copied here.</p></div><span className={styles.status}>{settings.profile.isPublished ? "public" : "private"}</span></div>
            <div className={styles.form}>
              <label>Public URL slug<input autoCapitalize="none" maxLength={40} onChange={(event) => setSlug(event.target.value.toLowerCase())} pattern="[a-z0-9][a-z0-9-]{2,39}" required value={slug} /><small>/p/{slug || "your-slug"}</small></label>
              <label>Display name<input maxLength={120} onChange={(event) => setDisplayName(event.target.value)} required value={displayName} /></label>
              <label>Headline<input maxLength={180} minLength={10} onChange={(event) => setHeadline(event.target.value)} required value={headline} /></label>
              <label>About<textarea maxLength={1200} onChange={(event) => setAbout(event.target.value)} value={about} /><small>{about.length}/1200 characters</small></label>
            </div>
          </section>
          <section className={`${styles.panel} card`}>
            <div className={styles.panelHead}><div><h2>Selected proof</h2><p>Selections are checked against your owner ID on every save.</p></div></div>
            <fieldset className={styles.checkList}>
              <legend><Github aria-hidden="true" size={14} /> Projects with valid GitHub links</legend>
              {settings.projects.length ? settings.projects.map((item) => <label className={styles.checkRow} key={item.id}><input checked={projects.includes(item.id)} onChange={() => toggle(projects,item.id,setProjects)} type="checkbox" /><span><strong>{item.title}</strong><small>{item.status} · {item.githubUrl}</small></span></label>) : <small>No project has a valid github.com owner/repository link yet.</small>}
            </fieldset>
            <fieldset className={styles.checkList}>
              <legend><BadgeCheck aria-hidden="true" size={14} /> Current achievements</legend>
              {settings.achievements.length ? settings.achievements.map((item) => <label className={styles.checkRow} key={item.id}><input checked={achievements.includes(item.id)} onChange={() => toggle(achievements,item.id,setAchievements)} type="checkbox" /><span><strong>{item.title}</strong><small>{item.description}</small></span></label>) : <small>No current achievement is available.</small>}
            </fieldset>
            <fieldset className={styles.checkList}>
              <legend><ShieldCheck aria-hidden="true" size={14} /> Valid certificates</legend>
              {settings.certificates.length ? settings.certificates.map((item) => <label className={styles.checkRow} key={item.id}><input checked={certificates.includes(item.id)} onChange={() => toggle(certificates,item.id,setCertificates)} type="checkbox" /><span><strong>{item.title}</strong><small>Version {item.version}</small></span></label>) : <small>No valid certificate is available.</small>}
            </fieldset>
          </section>
        </div>
      )}
      {settings ? <section className={`${styles.panel} card`}>
        <label className={styles.disclosure}><input checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} type="checkbox" /><span><strong>I understand this creates a public web page.</strong><small>{settings.disclosure}</small></span></label>
        <div className={styles.actions}>
          <button className="button button-secondary" disabled={busy} onClick={() => void save(false)} type="button">{settings.profile.isPublished ? "Withdraw public page" : "Save private draft"}</button>
          <button className="button button-primary" disabled={busy || !confirmed} onClick={() => void save(true)} type="button">{busy ? "Saving…" : settings.profile.isPublished ? "Update public page" : "Publish selected proof"}</button>
        </div>
      </section> : null}
    </div>
  );
}
