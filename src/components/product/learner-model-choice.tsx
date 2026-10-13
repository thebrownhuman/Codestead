"use client";
import { useCallback, useEffect, useState } from "react";
import type { learnerModelSettings } from "@/lib/ai/learner-model-choice";

type Settings = ReturnType<typeof learnerModelSettings>;
export function LearnerModelChoice() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const refresh = useCallback((signal?: AbortSignal) => {
    return Promise.resolve()
      .then(() => fetch("/api/settings/ai-model", { cache: "no-store", signal }))
      .then(async (response) => {
        const body = await response.json() as Settings;
        if (!response.ok || !Array.isArray(body.models)) throw new Error();
        if (signal?.aborted) return;
        setSettings(body); setKey(body.selectedKey ?? ""); setError(null);
      })
      .catch(() => {
        if (!signal?.aborted) setError("AI model settings could not be loaded. Try again.");
      });
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    return () => controller.abort();
  }, [refresh]);
  async function save() {
    setBusy(true); setError(null); setSaved(false);
    try {
      const response = await fetch("/api/settings/ai-model", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: key || null }) });
      const body = await response.json() as Settings & { error?: string };
      if (!response.ok || !Array.isArray(body.models)) throw new Error(body.error ?? "AI model preference could not be saved.");
      setSettings(body); setKey(body.selectedKey ?? ""); setSaved(true);
    } catch (failure) { setError(failure instanceof Error ? failure.message : "AI model preference could not be saved."); }
    finally { setBusy(false); }
  }
  return <section aria-label="AI model preference">
    <h2>AI model</h2>
    <p>Choose an administrator-enabled model for your tutor and mentor. Your daily platform allowance stays the same. Your own keys and provider consent still apply.</p>
    {settings?.unavailable && <p role="status">Your saved model is no longer enabled. The administrator default is being used.</p>}
    {error && <p>{error}</p>}
    {!settings && <button type="button" className="button button-secondary" onClick={() => void refresh()}>Reload AI models</button>}
    <label>Preferred AI model<select disabled={!settings || busy} value={key} onChange={(event) => { setKey(event.target.value); setSaved(false); }}>
      <option value="">Use default{settings?.defaultModel ? ` — ${settings.defaultModel.name} (${settings.defaultModel.provider})` : ""}</option>
      {settings?.models.map((model) => <option key={model.key} value={model.key}>{model.name} ({model.provider})</option>)}
    </select></label>
    <button type="button" className="button button-secondary" disabled={!settings || busy} onClick={() => void save()}>{busy ? "Saving model…" : "Save model preference"}</button>
    {saved && <p role="status">AI model preference saved.</p>}
  </section>;
}
