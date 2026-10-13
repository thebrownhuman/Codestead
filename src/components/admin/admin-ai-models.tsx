"use client";
import { Select } from "@/components/ui/select";

import { useCallback, useEffect, useState } from "react";
import { ModalDialog } from "@/components/ui/modal-dialog";
import { PasswordInput } from "@/components/ui/password-input";
import { withStepUp } from "./step-up-request";
import styles from "./admin-ai-models.module.css";

type ProviderSetting = { provider: string; label: string; baseUrl: string; version: number; hasPlatformKey: boolean; model: string; priority: number; verification: string; verifiedAt?: string | null; source: string };
type Model = { id: string; name: string; free: boolean };
type TestReply = { content: string; latencyMs: number; httpStatus: number; proof: string; reportedModel: string; reasoningDetected?: boolean };
type PlatformUsage = { count: number; date: string; dailyLimit: number };
async function responseBody(response: Response) {
  try {
    const body = await response.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error();
    return body;
  } catch {
    throw new Error(`AI model service returned a non-JSON response (HTTP ${response.status}). Try again.`);
  }
}
async function fetchSettings(): Promise<{ providers: ProviderSetting[]; platformUsage?: PlatformUsage }> {
  const response = await fetch("/api/admin/ai-models", { cache: "no-store" });
  const body = await responseBody(response);
  if (!response.ok || !Array.isArray(body.providers)) throw new Error("AI model settings could not be loaded.");
  return body;
}
async function post(command: Record<string, unknown>) {
  const response = await withStepUp(() => fetch("/api/admin/ai-models", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(command) }));
  const body = await responseBody(response);
  if (!response.ok) throw new Error(`${body.error ?? "Operation failed"}${body.httpStatus ? ` (HTTP ${body.httpStatus})` : ""}`);
  return body;
}
function ProviderCard({ setting, reload }: { setting: ProviderSetting; reload: () => Promise<void> }) {
  const [baseUrl, setBaseUrl] = useState(setting.baseUrl);
  const [platformKey, setPlatformKey] = useState("");
  const [removeKey, setRemoveKey] = useState(false);
  const [model, setModel] = useState(setting.model);
  const [priority, setPriority] = useState(setting.priority);
  const [verification, setVerification] = useState("untested");
  const [models, setModels] = useState<Model[]>([]);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [chatOpen, setChatOpen] = useState(false);
  const [message, setMessage] = useState("hi");
  const [reply, setReply] = useState<TestReply | null>(null);
  const dirtyConnection = baseUrl !== setting.baseUrl || Boolean(platformKey) || removeKey;
  const canVerify = Boolean(reply && !dirtyConnection);
  const publicList = ["openrouter", "nvidia_nim"].includes(setting.provider);
  function chooseModel(value: string) { setModel(value); setReply(null); setVerification("untested"); setNotice(null); }
  const commandBase = { provider: setting.provider, version: setting.version };
  async function run(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true); setError(null); setNotice(null);
    try { await action(); } catch (failure) { setError(failure instanceof Error ? failure.message : "Operation failed."); }
    finally { setBusy(false); }
  }
  return <article className={styles.card}>
    <header><h2>{setting.label}</h2><small>Current default: {setting.model || "Not configured"} · {setting.verification} · {setting.source === "admin" ? "Administrator saved" : "Environment or built-in default"}</small></header>
    <fieldset disabled={busy} className={styles.fields}>
      <label>HTTPS base URL<input type="url" value={baseUrl} onChange={(event) => { setBaseUrl(event.target.value); setReply(null); setVerification("untested"); }} required /></label>
      <label>Platform API key<PasswordInput value={platformKey} autoComplete="off" onChange={(event) => setPlatformKey(event.target.value)} placeholder={setting.hasPlatformKey ? "Stored securely; enter a replacement" : "Optional; enables platform AI for learners"} /></label>
      {setting.hasPlatformKey && <label><span><input type="checkbox" checked={removeKey} onChange={(event) => setRemoveKey(event.target.checked)} /> Remove stored platform key</span></label>}
      <small>Learners without their own key for this provider can use the platform key within their daily allowance, with the saved default model and their routing consent. Changing the endpoint requires replacing or removing its stored key. Save connection edits before loading or testing.</small>
      <div className={styles.actions}><button className="button button-secondary" type="button" disabled={!dirtyConnection || !baseUrl || (removeKey && Boolean(platformKey))} onClick={() => void run(async () => {
        await post({ ...commandBase, action: "configure", baseUrl, ...(platformKey ? { platformKey } : {}), ...(removeKey ? { removeKey } : {}) });
        setPlatformKey(""); setReply(null); await reload();
      })}>Save connection</button></div>
      <div className={styles.actions}>
        <button className="button button-secondary" type="button" disabled={dirtyConnection || (!setting.hasPlatformKey && !publicList) || !baseUrl} onClick={() => void run(async () => {
          const body = await post({ ...commandBase, action: "load" }); setModels(body.models); setNotice(`Loaded ${body.models.length} models.`);
        })}>Load models</button>
        <button className="button button-secondary" type="button" disabled={dirtyConnection || !setting.hasPlatformKey || !model} onClick={() => { setChatOpen(true); setError(null); }}>Test</button>
      </div>
      {models.length > 0 && <><label>Search models<input type="search" value={query} onChange={(event) => setQuery(event.target.value)} /></label><div className={styles.list}>{models.filter((entry) => `${entry.id} ${entry.name}`.toLowerCase().includes(query.toLowerCase())).map((entry) => <button type="button" key={entry.id} onClick={() => chooseModel(entry.id)}><span>{entry.id}</span>{entry.free && <span className={styles.free}>Free</span>}</button>)}</div></>}
      <label>Model ID<input value={model} maxLength={200} onChange={(event) => chooseModel(event.target.value)} placeholder="Choose a listed model or type its ID" /></label>
      <label>Failover priority<input type="number" min={1} max={100} value={priority} onChange={(event) => setPriority(Number(event.target.value))} /></label>
      <small>Lower numbers are tried first among available learner credentials. Defaults use your saved model, then the provider tutor environment override, then the built-in fallback.</small>
      <label>Save status<Select value={verification} onChange={(event) => setVerification(event.target.value)}><option value="untested">Untested</option><option value="verified" disabled={!canVerify}>Verified</option></Select></label>
      <small>Verified requires a successful test of this model and saved connection within the last 10 minutes. You can save a typed ID as untested without a platform key.</small>
      <div className={styles.actions}>
      {!chatOpen && error && <p role="alert" className={styles.error}>{error}</p>}
      {notice && <p role="status" className={styles.notice}>{notice}</p>}
      <button className="button button-primary" type="button" disabled={dirtyConnection || !model.trim() || !baseUrl || !Number.isInteger(priority) || priority < 1 || priority > 100} onClick={() => void run(async () => {
        await post({ ...commandBase, action: "save", model, priority, verification, ...(verification === "verified" && reply ? { proof: reply.proof, reportedModel: reply.reportedModel } : {}) });
        await reload();
      })}>Save default model</button></div>
    </fieldset>
    {chatOpen && <ModalDialog backdropClassName={styles.backdrop} dialogClassName={styles.dialog} labelledBy={`test-${setting.provider}`} onClose={() => { if (!busy) setChatOpen(false); }}>
      <h2 id={`test-${setting.provider}`}>Test {setting.label}: {model}</h2>
      <p>This sends your test message using the stored platform key. It does not include learner data.</p>
      <form className={styles.fields} onSubmit={(event) => { event.preventDefault(); void run(async () => {
        setReply(null); setVerification("untested");
        const result: TestReply = await post({ ...commandBase, action: "test", model, message }); setReply(result);
      }); }}>
        <label>Test message<textarea data-dialog-initial-focus value={message} maxLength={4000} required onChange={(event) => setMessage(event.target.value)} disabled={busy} /></label>
        <button className="button button-primary" type="submit" disabled={busy || !message.trim()}>{busy ? "Testing…" : "Send test message"}</button>
      </form>
      {reply && <div aria-live="polite"><p>HTTP {reply.httpStatus} · {reply.latencyMs} ms</p>{reply.reasoningDetected && <p role="alert">This model returns reasoning text</p>}<p className={styles.reply}>{reply.content}</p></div>}
      {error && <p role="alert" className={styles.error}>{error}</p>}
      <button className="button button-secondary" type="button" disabled={busy} onClick={() => setChatOpen(false)}>Close test</button>
    </ModalDialog>}
  </article>;
}
export function AdminAiModels() {
  const [usage, setUsage] = useState<PlatformUsage | null>(null);
  const [settings, setSettings] = useState<ProviderSetting[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const reload = useCallback(async () => {
    const body = await fetchSettings(); setSettings(body.providers); setUsage(body.platformUsage ?? null); setError(null);
  }, []);
  useEffect(() => {
    let active = true;
    fetchSettings().then((body) => { if (active) { setSettings(body.providers); setUsage(body.platformUsage ?? null); setError(null); } })
      .catch((failure) => { if (active) setError(failure instanceof Error ? failure.message : "AI model settings could not be loaded."); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);
  return <div className={styles.page}><header><h1>AI models</h1><p>Choose the app-wide model and failover order for each provider. Platform keys enable AI for learners without their own key.</p></header>
    {usage && <p aria-live="polite">{usage.count} platform requests today · {usage.date} (UTC). {usage.dailyLimit} per user per UTC day. Counts admitted requests, including provider failures.</p>}
    {loading && <p role="status">Loading AI model settings…</p>}
    {error && <div role="alert"><p>{error}</p><button className="button button-secondary" onClick={() => void reload().catch((failure) => setError(failure instanceof Error ? failure.message : "AI model settings could not be loaded."))} type="button">Retry</button></div>}
    <div className={styles.grid}>{settings.map((setting) => <ProviderCard key={`${setting.provider}:${setting.version}:${setting.model}:${setting.priority}:${setting.verification}`} setting={setting} reload={reload} />)}</div>
  </div>;
}
