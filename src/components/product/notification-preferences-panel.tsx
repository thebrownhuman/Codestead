"use client";

import { BellRing, Clock3, MailCheck, RefreshCw, ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import styles from "./product-pages.module.css";

type Preferences = {
  dailyStudyEnabled: boolean;
  revisionEnabled: boolean;
  goalEnabled: boolean;
  challengeEnabled: boolean;
  weeklySummaryEnabled: boolean;
  learningEmailEnabled: boolean;
  timezone: string;
  dailyStudyMinute: number;
  revisionMinute: number;
  quietHoursEnabled: boolean;
  quietStartMinute: number;
  quietEndMinute: number;
  rowVersion: number;
};

function minuteToTime(value: number) {
  const hours = Math.floor(value / 60).toString().padStart(2, "0");
  const minutes = (value % 60).toString().padStart(2, "0");
  return `${hours}:${minutes}`;
}

function timeToMinute(value: string) {
  const [hours, minutes] = value.split(":").map(Number);
  return hours * 60 + minutes;
}

export function NotificationPreferencesPanel() {
  const [preferences, setPreferences] = useState<Preferences | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "saving" | "error">("loading");
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    setState("loading");
    setMessage(null);
    try {
      const response = await fetch("/api/notifications/preferences", { cache: "no-store", signal });
      const body = (await response.json().catch(() => ({}))) as { preferences?: Preferences; error?: string };
      if (!response.ok || !body.preferences) throw new Error(body.error ?? "load failed");
      if (signal?.aborted) return;
      setPreferences(body.preferences);
      setState("ready");
    } catch {
      if (signal?.aborted) return;
      setState("error");
      setMessage("Reminder preferences could not be loaded. Check your connection and try again.");
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    queueMicrotask(() => {
      if (!controller.signal.aborted) void load(controller.signal);
    });
    return () => controller.abort();
  }, [load]);

  function update<K extends keyof Preferences>(key: K, value: Preferences[K]) {
    setPreferences((current) => current ? { ...current, [key]: value } : current);
    setMessage(null);
  }

  async function save() {
    if (!preferences || state === "saving") return;
    setState("saving");
    setMessage(null);
    try {
      const response = await fetch("/api/notifications/preferences", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...preferences,
          rowVersion: undefined,
          expectedVersion: preferences.rowVersion,
        }),
      });
      const body = (await response.json().catch(() => ({}))) as {
        preferences?: Preferences;
        error?: string;
        warning?: string | null;
      };
      if (response.status === 409) {
        await load();
        setMessage("These settings changed in another tab. The newest version has been reloaded.");
        return;
      }
      if (!response.ok || !body.preferences) throw new Error(body.error ?? "save failed");
      setPreferences(body.preferences);
      setState("ready");
      setMessage(body.warning ?? "Reminder preferences saved.");
    } catch {
      setState("error");
      setMessage("Reminder preferences were not saved. Your previous settings remain active.");
    }
  }

  if (state === "loading" && !preferences) {
    return <div className={styles.sideCard} role="status"><h3>Loading reminder preferences…</h3><p>Checking your schedule and delivery choices.</p></div>;
  }
  if (!preferences) {
    return <div className={styles.sideCard} role="alert"><h3>Reminder settings are unavailable</h3><p>{message}</p><button className="button button-secondary" onClick={() => void load()} type="button"><RefreshCw size={15} /> Try again</button></div>;
  }

  return <>
    <div className={styles.sectionTitle}><div><h2>Smart reminders</h2><p>Choose useful nudges. Opening the app alone never counts as learning, and one saved reminder receipt prevents duplicates.</p></div><button className="button button-primary" disabled={state === "saving"} onClick={() => void save()} type="button">{state === "saving" ? "Saving…" : "Save reminders"}</button></div>
    {message && <p className={state === "error" ? styles.error : styles.safeNotice} role={state === "error" ? "alert" : "status"}>{message}</p>}
    <div className={styles.form}>
      <label><span><input checked={preferences.dailyStudyEnabled} onChange={(event) => update("dailyStudyEnabled", event.target.checked)} type="checkbox" /> Daily study nudge</span><small>Sent only when that local day has no meaningful learning activity.</small></label>
      <label><span><input checked={preferences.revisionEnabled} onChange={(event) => update("revisionEnabled", event.target.checked)} type="checkbox" /> Due-review reminder</span><small>Prioritizes due and low-confidence concepts instead of asking you to reread everything.</small></label>
      <label><span><input checked={preferences.goalEnabled} onChange={(event) => update("goalEnabled", event.target.checked)} type="checkbox" /> Weekly goal check-in</span><small>A private prompt to compare the coming week with your active learning plan.</small></label>
      <label><span><input checked={preferences.challengeEnabled} onChange={(event) => update("challengeEnabled", event.target.checked)} type="checkbox" /> Upcoming challenge reminder</span><small>Sent only when you joined a scheduled coding challenge that has not started.</small></label>
      <label><span><input checked={preferences.weeklySummaryEnabled} onChange={(event) => update("weeklySummaryEnabled", event.target.checked)} type="checkbox" /> Weekly progress summary</span><small>Uses evidence-backed progress; it never invents study time, XP, or mastery.</small></label>
      <label><span><input checked={preferences.learningEmailEnabled} onChange={(event) => update("learningEmailEnabled", event.target.checked)} type="checkbox" /> Also send learning reminders by email</span><small>In-app reminders remain available. Security messages are mandatory and independent of this choice.</small></label>
      <label>Time zone<input list="reminder-timezones" maxLength={100} onChange={(event) => update("timezone", event.target.value)} value={preferences.timezone} /><datalist id="reminder-timezones"><option value="Asia/Kolkata" /><option value="America/New_York" /><option value="America/Chicago" /><option value="America/Denver" /><option value="America/Los_Angeles" /><option value="UTC" /></datalist><small>Use an IANA name such as Asia/Kolkata or America/New_York.</small></label>
      <label>Daily study time<input onChange={(event) => update("dailyStudyMinute", timeToMinute(event.target.value))} type="time" value={minuteToTime(preferences.dailyStudyMinute)} /></label>
      <label>Revision time<input onChange={(event) => update("revisionMinute", timeToMinute(event.target.value))} type="time" value={minuteToTime(preferences.revisionMinute)} /></label>
      <label><span><input checked={preferences.quietHoursEnabled} onChange={(event) => update("quietHoursEnabled", event.target.checked)} type="checkbox" /> Quiet hours</span><small>Learning reminders wait until quiet hours end. Security notifications are never delayed.</small></label>
      {preferences.quietHoursEnabled && <div className={styles.securityExplainer}><label>Quiet from<input onChange={(event) => update("quietStartMinute", timeToMinute(event.target.value))} type="time" value={minuteToTime(preferences.quietStartMinute)} /></label><label>Quiet until<input onChange={(event) => update("quietEndMinute", timeToMinute(event.target.value))} type="time" value={minuteToTime(preferences.quietEndMinute)} /></label></div>}
    </div>
    <div className={styles.securityExplainer}>
      <span><BellRing size={16} /><strong>Bounded</strong><small>At most one receipt per reminder kind and local period.</small></span>
      <span><Clock3 size={16} /><strong>Local time</strong><small>Your selected time zone controls study and quiet hours.</small></span>
      <span><MailCheck size={16} /><strong>Private email</strong><small>Email contains a generic nudge, never scores, code, mistakes, or keys.</small></span>
      <span><ShieldCheck size={16} /><strong>Security stays on</strong><small>Credential and device warnings cannot be disabled.</small></span>
    </div>
  </>;
}
