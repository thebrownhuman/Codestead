"use client";

import { BellOff, Clock3 } from "lucide-react";
import { useCallback, useEffect, useState, type FormEvent } from "react";

import { formatDateTime, requestAdminJson } from "./admin-utils";
import styles from "./admin.module.css";
import { LoadingState } from "./status-pill";

type Preference = {
  learnerId: string;
  quietHoursEnabled: boolean;
  quietStartMinute: number;
  quietEndMinute: number;
  inactivityPausedUntil: string | null;
  rowVersion: number;
};

const durationOptions = [
  { value: 24, label: "24 hours" },
  { value: 72, label: "3 days" },
  { value: 168, label: "7 days" },
  { value: 720, label: "30 days" },
] as const;

function minuteLabel(value: number) {
  const hour = Math.floor(value / 60).toString().padStart(2, "0");
  const minute = (value % 60).toString().padStart(2, "0");
  return `${hour}:${minute}`;
}

export function AdminInactivityPreferenceManager({ learnerId }: { readonly learnerId: string }) {
  const [preference, setPreference] = useState<Preference | null>(null);
  const [durationHours, setDurationHours] = useState(72);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async (signal?: AbortSignal) => {
    setPreference(await requestAdminJson<Preference>(
      `/api/admin/learners/${encodeURIComponent(learnerId)}/inactivity-preference`,
      { signal },
    ));
  }, [learnerId]);

  useEffect(() => {
    const controller = new AbortController();
    void requestAdminJson<Preference>(
      `/api/admin/learners/${encodeURIComponent(learnerId)}/inactivity-preference`,
      { signal: controller.signal },
    )
      .then(setPreference)
      .catch((cause: unknown) => {
        if (cause instanceof DOMException && cause.name === "AbortError") return;
        setError(cause instanceof Error ? cause.message : "Unable to load reminder preferences.");
      });
    return () => controller.abort();
  }, [learnerId]);

  async function mutate(event: FormEvent, resume: boolean) {
    event.preventDefault();
    if (!preference) return;
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const result = await requestAdminJson<Preference & { warning?: string }>(
        `/api/admin/learners/${encodeURIComponent(learnerId)}/inactivity-preference`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            expectedVersion: preference.rowVersion,
            pausedUntil: resume ? null : new Date(Date.now() + durationHours * 60 * 60_000).toISOString(),
            reason,
          }),
        },
      );
      setPreference(result);
      setReason("");
      setMessage(result.warning ?? (resume ? "Inactivity reminders resumed." : "Inactivity reminders paused."));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to change reminder preferences.");
      await load().catch(() => undefined);
    } finally {
      setSaving(false);
    }
  }

  if (!preference && !error) return <LoadingState label="Loading inactivity reminder controls" />;
  const pausedUntil = preference?.inactivityPausedUntil ?? null;
  const paused = Boolean(pausedUntil);
  return (
    <article className={styles.panel}>
      <div className={styles.panelHead}>
        <div><BellOff size={18} /><span><strong>Inactivity reminders</strong><small>Disclosed 24h/72h policy and learner-local quiet hours</small></span></div>
      </div>
      {preference ? (
        <>
          <div className={styles.profileFacts}>
            <div className={styles.profileFact}><span>Status</span><strong>{paused ? "Temporarily paused" : "Active"}</strong></div>
            <div className={styles.profileFact}><span>Quiet hours</span><strong>{preference.quietHoursEnabled ? `${minuteLabel(preference.quietStartMinute)}–${minuteLabel(preference.quietEndMinute)}` : "Disabled"}</strong></div>
            <div className={styles.profileFact}><span>Pause ends</span><strong>{paused ? formatDateTime(pausedUntil) : "Not paused"}</strong></div>
            <div className={styles.profileFact}><span>Policy</span><strong>24h · 72h · then silence</strong></div>
          </div>
          <form className={styles.approveForm} onSubmit={(event) => void mutate(event, Boolean(paused))} style={{ marginTop: 12 }}>
            {!paused ? (
              <label>Pause duration
                <select disabled={saving} onChange={(event) => setDurationHours(Number(event.target.value))} value={durationHours}>
                  {durationOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>
              </label>
            ) : null}
            <label>{paused ? "Reason to resume" : "Reason for temporary pause"}
              <textarea disabled={saving} maxLength={500} minLength={8} onChange={(event) => setReason(event.target.value)} required value={reason} />
            </label>
            <button className="button button-secondary" disabled={saving || reason.trim().length < 8} type="submit">
              <Clock3 size={14} /> {saving ? "Saving…" : paused ? "Resume reminders" : "Pause reminders"}
            </button>
          </form>
        </>
      ) : null}
      {message ? <p className={styles.inlineSuccess}>{message}</p> : null}
      {error ? <p className={styles.inlineError}>{error}</p> : null}
      <p className={styles.safeNotice}>Fresh MFA, a reason, optimistic versioning, and audit are required. The reason is never emailed.</p>
    </article>
  );
}
