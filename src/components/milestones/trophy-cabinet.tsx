"use client";

import { Award, ExternalLink, EyeOff, RefreshCw, ShieldCheck, Trophy } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import styles from "./milestones.module.css";

type TrophyItem = {
  id: string;
  kind: "course_completion" | "module_mastery";
  title: string;
  description: string;
  icon: string;
  earnedAt: string;
  status: "earned" | "revoked";
  visibility: "private" | "portfolio";
  evidenceLabel: string;
  verificationPath: string | null;
};
type Cabinet = {
  summary: { earned: number; revoked: number; shared: number };
  rewards: { coinsEnabled: false; coins: 0; notice: string };
  trophies: TrophyItem[];
};

export function TrophyCabinet() {
  const [cabinet, setCabinet] = useState<Cabinet | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const response = await fetch("/api/trophies", { cache: "no-store" });
      const body = await response.json() as { cabinet?: Cabinet; error?: string };
      if (!response.ok || !body.cabinet) throw new Error(body.error ?? "Trophies could not be loaded.");
      setCabinet(body.cabinet);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Trophies could not be loaded."); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void Promise.resolve().then(load); }, [load]);

  return <section className={styles.trophySection} aria-labelledby="trophy-cabinet-title">
    <header className={styles.trophyHero}>
      <div><span className={styles.eyebrow}>Your evidence shelf</span><h2 id="trophy-cabinet-title">Trophy cabinet</h2><p>A playful view of real course certificates and independent module-mastery badges. Nothing appears here merely for opening a page or replaying a project.</p></div>
      <button className="button button-secondary" disabled={loading} onClick={() => void load()} type="button"><RefreshCw size={15} /> Refresh</button>
    </header>
    <aside className={styles.notice}><ShieldCheck size={18} /><span>{cabinet?.rewards.notice ?? "Trophies mirror authoritative evidence; this view never creates rewards."} Coins stay disabled at 0 until a separate, reviewed economy exists.</span></aside>
    {error ? <p className={styles.error} role="alert">{error}</p> : null}
    {cabinet ? <div className={styles.trophyStats}>
      <article><Trophy size={18} /><strong>{cabinet.summary.earned}</strong><small>active trophies</small></article>
      <article><Award size={18} /><strong>{cabinet.summary.shared}</strong><small>shared by choice</small></article>
      <article><ShieldCheck size={18} /><strong>{cabinet.summary.revoked}</strong><small>revoked, still recorded</small></article>
    </div> : null}
    {loading ? <div className={`${styles.empty} card`}>Checking authoritative evidence…</div>
      : cabinet?.trophies.length ? <div className={styles.trophyGrid}>{cabinet.trophies.map((item) => <article className={`${styles.trophyCard} card`} data-status={item.status} key={item.id}>
        <span className={styles.trophySeal}>{item.kind === "course_completion" ? <Trophy /> : <Award />}</span>
        <div><small>{item.kind === "course_completion" ? "Course completion" : "Independent module mastery"}</small><h3>{item.title}</h3><p>{item.description}</p><span className={styles.evidenceTag}><ShieldCheck size={13} /> {item.evidenceLabel}</span></div>
        <footer><span>{item.status === "revoked" ? "Revoked" : item.visibility === "portfolio" ? "On public portfolio" : <><EyeOff size={13} /> Private</>}</span><time dateTime={item.earnedAt}>{new Date(item.earnedAt).toLocaleDateString()}</time></footer>
        {item.verificationPath ? <Link className="button button-secondary" href={item.verificationPath}><ExternalLink size={14} /> Verify</Link> : null}
      </article>)}</div>
        : <div className={`${styles.empty} card`}><div><span><Trophy /></span><h3>Your first real trophy is waiting</h3><p>Complete a verified course or pass a module mastery exam independently. Practice and projects help you prepare, but never mint proof by themselves.</p></div></div>}
    <div className={styles.trophyFooter}><p>Want to show selected active proof? Visibility is always opt-in and revoked evidence is never presented as valid.</p><Link className="button button-primary" href="/portfolio">Manage portfolio visibility</Link></div>
  </section>;
}
