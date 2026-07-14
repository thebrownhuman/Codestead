"use client";

import { Eye, Flame, Medal, RefreshCw, ShieldCheck, Sparkles, Trophy } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { CommunitySpaces } from "./community-spaces";
import styles from "./product-pages.module.css";

type VisibleProfile = {
  publicId: string;
  alias: string;
  bio?: string;
  streak?: number;
  masteredConcepts?: number;
  badges: Array<{ id: string; title: string; description: string; icon: string }>;
  projects: Array<{ id: string; title: string; summary: string; status: string }>;
};
type ScoreEntry = {
  rank: number; publicId: string; alias: string; totalPoints: number;
  components: Record<string, number>; counts: Record<string, number>;
};
type CommunityData = {
  profiles: VisibleProfile[];
  leaderboards: {
    formula: { version: string; components: Record<string, string>; excludedSignals: string[] };
    weekly: { period: { key: string }; entries: ScoreEntry[] };
    allTime: { period: { key: string }; entries: ScoreEntry[] };
  };
};
type Settings = {
  policyVersion: string;
  consent: { cohortProfile: boolean; leaderboard: boolean };
  live: boolean;
  profile: {
    alias: string; bio: string; isPublished: boolean; showBio: boolean;
    showStreak: boolean; showMasterySummary: boolean; rowVersion: number;
  };
  badges: Array<{ id: string; title: string; description: string; icon: string; selected: boolean }>;
  projects: Array<{ id: string; title: string; summary: string; status: string; selected: boolean }>;
  availableAggregates: { streak: number; masteredConcepts: number };
  livePreview: VisibleProfile | null;
  exclusionNotice: string;
};

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, headers: { "content-type": "application/json", ...init?.headers } });
  const body = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? "The cohort request failed safely.");
  return body;
}

function initials(alias: string) {
  return alias.split(/[._-]/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join("") || "L";
}

export function CommunityView() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [community, setCommunity] = useState<CommunityData | null>(null);
  const [period, setPeriod] = useState<"weekly" | "allTime">("weekly");
  const [alias, setAlias] = useState("");
  const [bio, setBio] = useState("");
  const [showBio, setShowBio] = useState(false);
  const [showStreak, setShowStreak] = useState(false);
  const [showMastery, setShowMastery] = useState(false);
  const [badges, setBadges] = useState<string[]>([]);
  const [projects, setProjects] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const applySettings = useCallback((next: Settings) => {
    setSettings(next);
    setAlias(next.profile.alias);
    setBio(next.profile.bio);
    setShowBio(next.profile.showBio);
    setShowStreak(next.profile.showStreak);
    setShowMastery(next.profile.showMasterySummary);
    setBadges(next.badges.filter((item) => item.selected).map((item) => item.id));
    setProjects(next.projects.filter((item) => item.selected).map((item) => item.id));
  }, []);
  const load = useCallback(async () => {
    setError(null);
    const [own, cohort] = await Promise.all([
      json<{ settings: Settings }>("/api/community/profile"),
      json<CommunityData>("/api/community"),
    ]);
    applySettings(own.settings);
    setCommunity(cohort);
  }, [applySettings]);
  useEffect(() => {
    let active = true;
    void Promise.all([
      json<{ settings: Settings }>("/api/community/profile"),
      json<CommunityData>("/api/community"),
    ]).then(([own, cohort]) => {
      if (!active) return;
      applySettings(own.settings);
      setCommunity(cohort);
    }).catch((cause: unknown) => {
      if (active) setError(cause instanceof Error ? cause.message : "Community unavailable.");
    });
    return () => { active = false; };
  }, [applySettings]);

  async function consent(purpose: "cohort_profile" | "leaderboard", decision: "accepted" | "withdrawn") {
    if (!settings) return;
    setBusy(true); setError(null); setNotice(null);
    try {
      await json("/api/privacy/consents", { method: "POST", body: JSON.stringify({ requestId: crypto.randomUUID(), purpose, decision, policyVersion: settings.policyVersion }) });
      await load();
      setNotice(decision === "accepted" ? "Consent recorded. Publication remains a separate choice." : "Sharing withdrawn without deleting private evidence.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Consent change failed."); }
    finally { setBusy(false); }
  }

  async function save(publish: boolean) {
    if (!settings) return;
    setBusy(true); setError(null); setNotice(null);
    try {
      const result = await json<{ settings: Settings }>("/api/community/profile", {
        method: "PATCH",
        body: JSON.stringify({
          requestId: crypto.randomUUID(), expectedVersion: settings.profile.rowVersion,
          alias, bio: bio || null, showBio, showStreak, showMasterySummary: showMastery,
          publish, selectedAchievementIds: badges, selectedProjectIds: projects,
        }),
      });
      applySettings(result.settings);
      const cohort = await json<CommunityData>("/api/community");
      setCommunity(cohort);
      setNotice(publish ? "Your exact preview is now visible to the closed cohort." : "Profile saved privately and removed from every cohort view.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Profile change failed safely."); }
    finally { setBusy(false); }
  }

  const draftPreview = useMemo<VisibleProfile | null>(() => settings ? ({
    publicId: "preview",
    alias,
    ...(showBio && bio ? { bio } : {}),
    ...(showStreak ? { streak: settings.availableAggregates.streak } : {}),
    ...(showMastery ? { masteredConcepts: settings.availableAggregates.masteredConcepts } : {}),
    badges: settings.badges.filter((item) => badges.includes(item.id)).map(({ id, title, description, icon }) => ({ id, title, description, icon })),
    projects: settings.projects.filter((item) => projects.includes(item.id)).map(({ id, title, summary, status }) => ({ id, title, summary, status })),
  }) : null, [alias, badges, bio, projects, settings, showBio, showMastery, showStreak]);
  const preview = settings?.livePreview ?? draftPreview;
  const board = community?.leaderboards[period];

  if (!settings || !community) return <div className={styles.page}><div className={`${styles.empty} card`}><div><RefreshCw size={24} /><h2>Loading the private cohort</h2><p>No profile is exposed while this view is loading.</p>{error && <p className={styles.error} role="alert">{error}</p>}</div></div></div>;

  return <div className={styles.page}>
    <header className={styles.pageHead}><div><span className={styles.eyebrow}>Private closed cohort</span><h1>See growth, not surveillance.</h1><p>Nothing appears until current cohort consent and explicit publication both exist. Alias is the only default field.</p></div><button type="button" className="button button-secondary" onClick={() => void load()} disabled={busy}><RefreshCw size={15} /> Refresh evidence</button></header>
    {error && <p className={styles.error} role="alert">{error}</p>}{notice && <p className={styles.success} role="status">{notice}</p>}
    <section className={styles.stats}><article className={`${styles.stat} card`}><span><Trophy size={18} /></span><div><strong>{community.profiles.length}</strong><small>explicitly visible aliases</small></div></article><article className={`${styles.stat} card`}><span><Medal size={18} /></span><div><strong>{community.profiles.reduce((sum, item) => sum + item.badges.length, 0)}</strong><small>selected visible badges</small></div></article><article className={`${styles.stat} card`}><span><Sparkles size={18} /></span><div><strong>{community.profiles.reduce((sum, item) => sum + item.projects.length, 0)}</strong><small>selected visible projects</small></div></article><article className={`${styles.stat} card`}><span><ShieldCheck size={18} /></span><div><strong>{settings.live ? "Visible" : "Private"}</strong><small>your current projection</small></div></article></section>
    <section className={styles.communityGrid}>
      <article className={`${styles.leaderboard} card`}><div className={styles.sectionTitle} style={{ padding: "16px" }}><div><h2>Evidence-backed leaderboard</h2><p>{community.leaderboards.formula.version}; no speed, hours, submissions, hints, replays, or AI spend.</p></div><select aria-label="Leaderboard period" value={period} onChange={(event) => setPeriod(event.target.value as typeof period)}><option value="weekly">This week</option><option value="allTime">All time</option></select></div>{board?.entries.length ? board.entries.map((person) => <div className={styles.leaderRow} key={person.publicId}><b>#{person.rank}</b><span className={styles.avatar}>{initials(person.alias)}</span><span><strong>{person.alias}</strong><small>{person.components.newMastery ?? 0} mastery · {person.components.projects ?? 0} projects · {person.components.consistency ?? 0} consistency</small></span><span className={styles.leaderScore}><strong>{person.totalPoints} pts</strong><small>capped {period === "weekly" ? "weekly" : "all-time"} evidence</small></span></div>) : <div className={styles.empty}><div><ShieldCheck size={24} /><h2>No opted-in entries</h2><p>Private scores and non-published profiles never appear as placeholders.</p></div></div>}</article>
      <aside className={styles.sideStack}>
        <article className={`${styles.profileCard} card`}><div className={styles.profileTop}><span className={styles.avatar}>{initials(preview?.alias ?? alias)}</span><span><strong>{preview?.alias ?? alias}</strong><small>{settings.live ? "Exact live cohort preview" : "Private draft preview—not visible"}</small></span></div>{preview?.bio && <p>{preview.bio}</p>}<div className={styles.badges}>{preview?.badges.map((badge) => <span className={styles.badge} key={badge.id}><Medal size={13} /> {badge.title}</span>)}{preview?.streak !== undefined && <span className={styles.badge}><Flame size={13} /> {preview.streak}-day streak</span>}{preview?.masteredConcepts !== undefined && <span className={styles.badge}><Trophy size={13} /> {preview.masteredConcepts} mastered concepts</span>}</div>{preview?.projects.map((project) => <div className={styles.privacy} key={project.id}><Sparkles size={14} /> <span><strong>{project.title}</strong><br />{project.summary}</span></div>)}<div className={styles.privacy}><ShieldCheck size={15} /> {settings.exclusionNotice}</div></article>
        <article className={`${styles.sideCard} card`}><h3>Formula boundaries</h3><ul>{Object.values(community.leaderboards.formula.components).map((line) => <li key={line}>{line}</li>)}</ul></article>
      </aside>
    </section>
    <section className={`${styles.settingsPanel} card`}><div className={styles.sectionTitle}><div><h2>My cohort projection</h2><p>Edit and preview privately, then publish deliberately.</p></div><span className="pill">{settings.live ? "Live" : "Not visible"}</span></div>
      <div className={styles.privacyNotice}><strong>Two independent gates</strong><span>Cohort consent: {settings.consent.cohortProfile ? "current" : "off"}. Explicit publication: {settings.live ? "current and consent-bound" : "off"}. Reaccepting consent never silently republishes an old profile.</span></div>
      <div className={styles.headActions}>{!settings.consent.cohortProfile && <button type="button" className="button button-secondary" disabled={busy} onClick={() => void consent("cohort_profile", "accepted")}>Enable cohort consent</button>}{settings.consent.cohortProfile && <button type="button" className="button button-secondary" disabled={busy} onClick={() => void consent("cohort_profile", "withdrawn")}>Withdraw cohort consent</button>}{settings.consent.cohortProfile && !settings.consent.leaderboard && <button type="button" className="button button-secondary" disabled={busy} onClick={() => void consent("leaderboard", "accepted")}>Join leaderboard</button>}{settings.consent.leaderboard && <button type="button" className="button button-secondary" disabled={busy} onClick={() => void consent("leaderboard", "withdrawn")}>Leave leaderboard</button>}</div>
      <div className={styles.form}><label>Public alias<input value={alias} maxLength={30} pattern="[A-Za-z0-9][A-Za-z0-9._-]{2,29}" onChange={(event) => setAlias(event.target.value)} /><small>No real name is copied automatically.</small></label><label>Optional bio<textarea value={bio} maxLength={280} onChange={(event) => setBio(event.target.value)} /></label><fieldset className={styles.consentSection}><legend>Optional aggregate fields</legend><label className={styles.consentRow}><input type="checkbox" checked={showBio} onChange={(event) => setShowBio(event.target.checked)} /><span><strong>Show bio</strong><small>Off by default.</small></span></label><label className={styles.consentRow}><input type="checkbox" checked={showStreak} onChange={(event) => setShowStreak(event.target.checked)} /><span><strong>Show streak count</strong><small>No dates or exact activity are exposed.</small></span></label><label className={styles.consentRow}><input type="checkbox" checked={showMastery} onChange={(event) => setShowMastery(event.target.checked)} /><span><strong>Show mastered-concept count</strong><small>No score, attempt, failure, or evidence detail is exposed.</small></span></label></fieldset><fieldset className={styles.consentSection}><legend>Selected badges</legend>{settings.badges.length ? settings.badges.map((badge) => <label className={styles.consentRow} key={badge.id}><input type="checkbox" checked={badges.includes(badge.id)} onChange={(event) => setBadges((current) => event.target.checked ? [...current, badge.id] : current.filter((id) => id !== badge.id))} /><span><strong>{badge.title}</strong><small>{badge.description}</small></span></label>) : <p>No authoritative badges are available yet.</p>}</fieldset><fieldset className={styles.consentSection}><legend>Selected projects</legend>{settings.projects.length ? settings.projects.map((project) => <label className={styles.consentRow} key={project.id}><input type="checkbox" checked={projects.includes(project.id)} onChange={(event) => setProjects((current) => event.target.checked ? [...current, project.id] : current.filter((id) => id !== project.id))} /><span><strong>{project.title}</strong><small>{project.summary}</small></span></label>) : <p>No projects are available yet.</p>}</fieldset><div className={styles.headActions}><button type="button" className="button button-secondary" disabled={busy} onClick={() => void save(false)}>{settings.live ? "Withdraw and save privately" : "Save private draft"}</button><button type="button" className="button button-primary" disabled={busy || !settings.consent.cohortProfile} onClick={() => void save(true)}><Eye size={15} /> {settings.live ? "Update published preview" : "Publish exact preview"}</button></div></div>
    </section>
    <CommunitySpaces people={community.profiles.map(({ publicId, alias: profileAlias }) => ({ publicId, alias: profileAlias }))} />
  </div>;
}

/** Kept as an explicit fail-closed rendering for auth/bootstrap failures and tests. */
export function CommunityUnavailable() {
  return <div className={styles.page}><header className={styles.pageHead}><div><span className={styles.eyebrow}>Private cohort · secure default</span><h1>Community sharing is not enabled yet.</h1><p>No learner appears without current consent and explicit profile publication.</p></div></header></div>;
}
