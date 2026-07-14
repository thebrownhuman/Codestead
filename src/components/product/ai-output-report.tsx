"use client";

import { Flag, X } from "lucide-react";
import { useState } from "react";

import styles from "./product-pages.module.css";

export function AiOutputReport({ callId }: { callId: string }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError(null);
    const response = await fetch("/api/ai/reports", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        modelCallId: callId,
        category: form.get("category"),
        description: form.get("description"),
      }),
    });
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    setBusy(false);
    if (!response.ok) {
      setError(body.error ?? "The report could not be submitted.");
      return;
    }
    setSubmitted(true);
    setOpen(false);
  }

  if (submitted) return <small role="status">Reported for administrator review.</small>;
  if (!open) {
    return <button className="button button-ghost" onClick={() => setOpen(true)} type="button"><Flag size={13} /> Report this response</button>;
  }

  return (
    <form className={styles.form} onSubmit={submit}>
      <div className={styles.dialogHead}>
        <strong>Report this AI response</strong>
        <button aria-label="Cancel report" className={styles.iconButton} onClick={() => setOpen(false)} type="button"><X size={14} /></button>
      </div>
      {error && <p className={styles.error} role="alert">{error}</p>}
      <label>Problem category<select name="category" defaultValue="incorrect"><option value="incorrect">Incorrect or misleading</option><option value="harmful">Harmful or unsafe</option><option value="off-topic">Off topic</option><option value="privacy">Privacy concern</option><option value="other">Other</option></select></label>
      <label>What went wrong?<textarea name="description" required minLength={20} maxLength={2000} placeholder="Explain what Codestead said and why it should be reviewed." /></label>
      <small>The report preserves provider, model, prompt version, safe context manifest, and content hashes—not your API key.</small>
      <button className="button button-secondary" disabled={busy} type="submit">{busy ? "Submitting…" : "Submit report"}</button>
    </form>
  );
}
