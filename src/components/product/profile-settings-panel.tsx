"use client";
import { Select } from "@/components/ui/select";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { LearningProfile } from "@/lib/preferences/profile-settings-values";
import styles from "./product-pages.module.css";
import formStyles from "../ui/form.module.css";
import { Field } from "../ui/field";
export function ProfileSettingsPanel() {
  const router = useRouter();
  const [profile, setProfile] = useState<LearningProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [interests, setInterests] = useState<string[] | null>(null);
  const [interestsError, setInterestsError] = useState(false);
  const mutation = useRef(false);
  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true); setError(null); setSuccess(false);
    try {
      const response = await fetch("/api/settings/profile", { cache: "no-store", signal });
      const body = await response.json();
      if (!response.ok || !body.profile) throw new Error(body.error ?? "Profile unavailable.");
      if (!signal?.aborted) setProfile(body.profile);
    } catch (error) { if (!signal?.aborted) setError(error instanceof Error ? error.message : "Profile unavailable."); }
    finally { if (!signal?.aborted) setLoading(false); }
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    queueMicrotask(() => { if (!controller.signal.aborted) void load(controller.signal); });
    return () => controller.abort();
  }, [load]);
  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/onboarding/status", { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("Interests unavailable");
        const body = await response.json();
        const saved = body.profile?.analogyInterests ?? [];
        if (!Array.isArray(saved)) throw new Error("Interests unavailable");
        if (!controller.signal.aborted) setInterests(saved.flatMap((item: unknown) => {
          if (typeof item === "string") return [item];
          if (item && typeof item === "object" && "label" in item && typeof item.label === "string") return [item.label];
          return [];
        }));
      }).catch(() => { if (!controller.signal.aborted) setInterestsError(true); });
    return () => controller.abort();
  }, []);
  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!profile || mutation.current) return;
    const name = profile.name.trim();
    if (!name || name.length > 120) { setError("Display name must be 1–120 characters."); return; }
    mutation.current = true; setBusy(true); setError(null); setSuccess(false);
    try {
      const values = {
        name, bio: profile.bio.trim(), analogyFrequency: profile.analogyFrequency,
        cohortVisibility: profile.cohortVisibility,
        profileVersion: profile.profileVersion, cohortVersion: profile.cohortVersion,
        requestId: crypto.randomUUID(),
      };
      const response = await fetch("/api/settings/profile", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(values) });
      const body = await response.json();
      if (!response.ok || !body.profile) throw new Error(body.error ?? "Profile could not be saved.");
      setProfile(body.profile); setSuccess(true); router.refresh();
    } catch (error) { setError(error instanceof Error ? error.message : "Profile could not be saved."); }
    finally { mutation.current = false; setBusy(false); }
  }
  return <><h2>Learning profile</h2><p>Your name and learning bio are private. Cohort sharing uses your alias and explicitly selected fields.</p>
    {loading ? <p role="status">Loading profile…</p> : null}
    {error && !profile ? <p role="alert">{error}</p> : null}
    {!loading && !profile ? <button className="button button-secondary" onClick={() => void load()}>Retry profile</button> : null}
    {!loading && profile ? <form className={styles.form} onSubmit={save}>
      <fieldset disabled={busy} className={styles.profileFields}>
        <section role="group" aria-labelledby="profile-identity" className={formStyles.section}>
          <h3 id="profile-identity">Identity</h3>
          <span className={formStyles.avatar} aria-label="Profile initials">{profile.name.trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase() || "?"}</span>
          <Field id="profile-name" label="Display name"><input id="profile-name" value={profile.name} required maxLength={120} onChange={(event) => { setSuccess(false); setProfile({ ...profile, name: event.target.value }); }} /></Field>
          <Field id="profile-bio" label="Bio" help={<>Private learning bio, up to 280 characters. <span>{profile.bio.length}/280</span></>}><textarea id="profile-bio" aria-describedby="profile-bio-help" value={profile.bio} maxLength={280} onChange={(event) => { setSuccess(false); setProfile({ ...profile, bio: event.target.value }); }} /></Field>
        </section>
        <section role="group" aria-labelledby="profile-learning" className={formStyles.section}>
          <h3 id="profile-learning">Learning</h3>
          <Field id="profile-analogy" label="Analogy preference"><Select id="profile-analogy" value={profile.analogyFrequency} onChange={(event) => { setSuccess(false); setProfile({ ...profile, analogyFrequency: event.target.value as LearningProfile["analogyFrequency"] }); }}><option value="helpful">When helpful</option><option value="frequent">Frequent</option><option value="neutral">Neutral only</option></Select></Field>
          <div><h4>Interests</h4><p>Saved during onboarding · read-only</p>{interestsError ? <p>Interests could not be loaded.</p> : interests === null ? <p>Loading interests…</p> : interests.length ? <ul className={formStyles.interests}>{interests.map((interest, index) => <li key={`${interest}-${index}`}>{interest}</li>)}</ul> : <p>No saved interests.</p>}</div>
        </section>
        <section role="group" aria-labelledby="profile-community" className={formStyles.section}>
          <h3 id="profile-community">Community</h3>
          <Field id="profile-cohort" label="Public cohort fields" help={<>{profile.cohortAlias ? `Cohort alias: ${profile.cohortAlias}. ` : ""}Select badges and projects in Community. Accept cohort sharing in Privacy &amp; consent before publishing.</>}><Select id="profile-cohort" aria-describedby="profile-cohort-help" value={profile.cohortVisibility} onChange={(event) => { setSuccess(false); setProfile({ ...profile, cohortVisibility: event.target.value as LearningProfile["cohortVisibility"] }); }}><option value="selected" disabled={!profile.cohortConsent}>Alias, selected badges, streak, projects</option><option value="alias" disabled={!profile.cohortConsent}>Alias only</option><option value="hidden">Hidden profile</option></Select></Field>
        </section>
        <div className={formStyles.actions}>
          {error ? <p className={formStyles.error} role="alert">{error}</p> : success ? <p className={formStyles.success} role="status"><span>Saved</span> · <span>Profile saved.</span></p> : null}
          {error ? <button className="button button-secondary" type="button" onClick={() => void load()}>Reload profile</button> : null}
          <button className="button button-primary" type="submit">{busy ? "Saving profile…" : "Save profile"}</button>
        </div>
      </fieldset>
    </form> : null}
  </>;
}
