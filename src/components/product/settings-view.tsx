"use client";

import { Accessibility, Bell, BrainCircuit, KeyRound, Laptop, Plus, Shield, ShieldCheck, Trash2, UserRound, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

import {
  applyAccessibilityPreferences,
  getAccessibilityPreferencesSnapshot,
  getServerAccessibilityPreferencesSnapshot,
  persistAndApplyAccessibilityPreference,
  subscribeToAccessibilityPreferences,
  type AccessibilityPreferences,
  type CodeEditorFontPreference,
  type InterfaceThemePreference,
  type MotionPreference,
  type TextSizePreference,
} from "@/lib/preferences/accessibility-preferences";
import { ModalDialog } from "@/components/ui/modal-dialog";

import styles from "./product-pages.module.css";
import { DeviceSessionsPanel } from "./device-sessions-panel";
import { PrivacyConsentPanel } from "./privacy-consent-panel";
import { NotificationPreferencesPanel } from "./notification-preferences-panel";

type Credential = { id: string; provider: string; label: string; lastFour: string; status: string; isPreferred: boolean; routingConsented: boolean; lastValidatedAt?: string | null };
const tabs = [
  ["profile", "Profile", UserRound], ["ai", "AI providers", BrainCircuit], ["security", "Security", Shield],
  ["privacy", "Privacy & consent", ShieldCheck], ["accessibility", "Accessibility", Accessibility],
  ["notifications", "Notifications", Bell], ["device", "Approved device", Laptop],
] as const;
export type SettingsTab = (typeof tabs)[number][0];

const subscribeToHydration = () => () => {};
const getHydratedSnapshot = () => true;
const getServerHydratedSnapshot = () => false;

export function SettingsView({ initialTab = "ai" }: { initialTab?: SettingsTab }) {
  const [tab, setTab] = useState<SettingsTab>(initialTab);
  const [credentials, setCredentials] = useState<Credential[]>([]);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [mfaCode, setMfaCode] = useState("");
  const [mfaFresh, setMfaFresh] = useState(false);
  const [replaceTarget, setReplaceTarget] = useState<Credential | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Credential | null>(null);
  const [credentialLoadState, setCredentialLoadState] = useState<"loading" | "ready" | "error">("loading");
  const [credentialLoadError, setCredentialLoadError] = useState<string | null>(null);
  const accessibilityPreferences = useSyncExternalStore(
    subscribeToAccessibilityPreferences,
    getAccessibilityPreferencesSnapshot,
    getServerAccessibilityPreferencesSnapshot,
  );
  const accessibilityControlsReady = useSyncExternalStore(
    subscribeToHydration,
    getHydratedSnapshot,
    getServerHydratedSnapshot,
  );
  const mutationRef = useRef(false);
  const settingsTabRefs = useRef<Partial<Record<SettingsTab, HTMLButtonElement | null>>>({});

  function handleSettingsTabKeyDown(event: React.KeyboardEvent<HTMLButtonElement>, current: SettingsTab) {
    if (!["ArrowDown", "ArrowUp", "ArrowRight", "ArrowLeft", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const currentIndex = tabs.findIndex(([id]) => id === current);
    const nextIndex = event.key === "Home"
      ? 0
      : event.key === "End"
        ? tabs.length - 1
        : (currentIndex + (["ArrowDown", "ArrowRight"].includes(event.key) ? 1 : -1) + tabs.length) % tabs.length;
    const next = tabs[nextIndex]![0];
    setTab(next);
    queueMicrotask(() => settingsTabRefs.current[next]?.focus());
  }

  const refresh = useCallback(async ({ signal, showLoading = true }: { signal?: AbortSignal; showLoading?: boolean } = {}) => {
    if (showLoading) setCredentialLoadState("loading");
    setCredentialLoadError(null);
    let responseError: string | null = null;
    try {
      const response = await fetch("/api/credentials", { cache: "no-store", signal });
      const body = (await response.json().catch(() => ({}))) as { credentials?: Credential[]; error?: string };
      if (!response.ok || !Array.isArray(body.credentials)) {
        responseError = body.error ?? "The provider list could not be loaded.";
        throw new Error(responseError);
      }
      if (signal?.aborted) return false;
      setCredentials(body.credentials);
      setCredentialLoadState("ready");
      return true;
    } catch {
      if (signal?.aborted) return false;
      setCredentialLoadState("error");
      setCredentialLoadError(
        responseError ?? "AI providers could not be loaded. Check your connection and try again.",
      );
      return false;
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    queueMicrotask(() => {
      if (!controller.signal.aborted) void refresh({ signal: controller.signal, showLoading: false });
    });
    return () => controller.abort();
  }, [refresh]);

  useEffect(() => {
    applyAccessibilityPreferences(accessibilityPreferences);
  }, [accessibilityPreferences]);

  async function verifyMfa({ clearOnSuccess = false }: { clearOnSuccess?: boolean } = {}) {
    if (mfaFresh) return true;
    const code = mfaCode.replace(/\s/g, "");
    if (!/^\d{6}$/.test(code)) {
      setError("Enter the current six-digit authenticator code before changing a provider.");
      return false;
    }
    try {
      const response = await fetch("/api/security/fresh-mfa", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code }),
      });
      const body = (await response.json().catch(() => ({}))) as { error?: string; validUntil?: string };
      if (!response.ok) {
        setError(body.error ?? "The authenticator code was not accepted.");
        return false;
      }
      if (clearOnSuccess) setMfaCode("");
      setMfaFresh(true);
      return true;
    } catch {
      setError("Authenticator verification is temporarily unavailable. Check your connection and try again.");
      return false;
    }
  }

  async function verifyMfaFromPanel() {
    if (mutationRef.current) return;
    mutationRef.current = true;
    setBusy(true);
    setError(null);
    try {
      await verifyMfa({ clearOnSuccess: true });
    } catch {
      setError("Authenticator verification is temporarily unavailable. Check your connection and try again.");
    } finally {
      mutationRef.current = false;
      setBusy(false);
    }
  }

  async function add(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (mutationRef.current) return;
    mutationRef.current = true;
    const form = new FormData(event.currentTarget);
    const target = replaceTarget;
    setBusy(true);
    setError(null);
    try {
      if (!(await verifyMfa())) return;
      if (!target) {
        if (form.get("providerConsent") !== "on") {
          setError("Confirm this provider's data-routing disclosure before storing its key.");
          return;
        }
        const provider = String(form.get("provider") ?? "");
        const consentResponse = await fetch("/api/privacy/consents", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            requestId: crypto.randomUUID(),
            purpose: `provider:${provider}`,
            decision: "accepted",
            policyVersion: "enrollment-disclosure-2026-07-12.v2",
          }),
        });
        if (!consentResponse.ok) {
          const consentBody = (await consentResponse.json().catch(() => ({}))) as { error?: string };
          setError(consentBody.error ?? "Provider consent could not be recorded.");
          return;
        }
      }
      const response = await fetch(
        target ? `/api/credentials/${target.id}` : "/api/credentials",
        {
          method: target ? "PATCH" : "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(
            target
              ? { action: "replace", secret: form.get("secret") }
              : { provider: form.get("provider"), label: form.get("label"), secret: form.get("secret"), preferred: form.get("preferred") === "on" },
          ),
        },
      );
      const body = (await response.json().catch(() => ({}))) as { error?: string; code?: string };
      if (!response.ok) {
        if (body.code === "FRESH_MFA_REQUIRED") setMfaFresh(false);
        setError(body.error ?? "The credential could not be stored.");
        return;
      }
      setMfaCode("");
      setOpen(false);
      setReplaceTarget(null);
      await refresh({ showLoading: false });
    } catch {
      setError(target ? "The credential could not be replaced. Check your connection and try again." : "The credential could not be stored. Check your connection and try again.");
    } finally {
      mutationRef.current = false;
      setBusy(false);
    }
  }

  async function action(id: string, value: "prefer" | "disable" | "enable" | "test") {
    if (mutationRef.current) return;
    mutationRef.current = true;
    setBusy(true);
    setError(null);
    try {
      if (!(await verifyMfa())) return;
      const response = await fetch(`/api/credentials/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: value }) });
      const body = (await response.json().catch(() => ({}))) as { error?: string; code?: string };
      if (!response.ok) {
        if (body.code === "FRESH_MFA_REQUIRED") setMfaFresh(false);
        setError(body.error ?? "The credential could not be changed.");
        return;
      }
      setMfaCode("");
      await refresh({ showLoading: false });
    } catch {
      setError("The credential could not be changed. Check your connection and try again.");
    } finally {
      mutationRef.current = false;
      setBusy(false);
    }
  }

  async function remove(target: Credential) {
    if (mutationRef.current) return;
    mutationRef.current = true;
    setBusy(true);
    setError(null);
    try {
      if (!(await verifyMfa())) return;
      const response = await fetch(`/api/credentials/${target.id}`, { method: "DELETE" });
      const body = (await response.json().catch(() => ({}))) as { error?: string; code?: string };
      if (!response.ok) {
        if (body.code === "FRESH_MFA_REQUIRED") setMfaFresh(false);
        setError(body.error ?? "The credential could not be deleted.");
        return;
      }
      setMfaCode("");
      setDeleteTarget(null);
      await refresh({ showLoading: false });
    } catch {
      setError("The credential could not be deleted. Check your connection and try again.");
    } finally {
      mutationRef.current = false;
      setBusy(false);
    }
  }

  function closeProviderDialog() {
    if (busy || mutationRef.current) return;
    setOpen(false);
    setReplaceTarget(null);
  }

  function closeDeleteDialog() {
    if (busy || mutationRef.current) return;
    setError(null);
    setDeleteTarget(null);
  }

  function aiProvidersPanel() {
    return <>
      <div className={styles.sectionTitle}>
        <div>
          <h2>Your AI providers</h2>
          <p>NVIDIA NIM is required. Add more providers for automatic failover; the app chooses the model.</p>
        </div>
        <button
          className="button button-primary"
          disabled={busy}
          onClick={() => {
            setError(null);
            setReplaceTarget(null);
            setOpen(true);
          }}
          type="button"
        >
          <Plus size={15} /> Add provider
        </button>
      </div>
      {error && !deleteTarget && !open && <p className={styles.error} role="alert">{error}</p>}
      <div className={styles.sideCard}>
        <h3>Verify before changing a key</h3>
        <p>{mfaFresh ? "Authenticator verified for this short security window." : "Enter a current authenticator code. Verification remains valid for up to five minutes."}</p>
        <label>
          Six-digit code
          <input
            aria-label="Authenticator code for provider changes"
            autoComplete="one-time-code"
            disabled={busy}
            inputMode="numeric"
            maxLength={6}
            onChange={(event) => setMfaCode(event.target.value)}
            pattern="[0-9]{6}"
            placeholder="000000"
            value={mfaCode}
          />
        </label>
        <button className="button button-secondary" disabled={busy || mfaFresh} onClick={() => void verifyMfaFromPanel()} type="button">
          <Shield size={15} /> {mfaFresh ? "Verified" : busy ? "Verifying…" : "Verify authenticator"}
        </button>
      </div>

      <div className={styles.credentialList} aria-busy={credentialLoadState === "loading" || busy}>
        {credentialLoadState === "loading" && (
          <div className={`${styles.empty} card`} role="status">
            <div><span><KeyRound size={23} /></span><h2>Loading AI providers…</h2><p>Checking encrypted credential metadata and routing status.</p></div>
          </div>
        )}
        {credentialLoadState === "error" && (
          <div className={`${styles.empty} card`} role="alert">
            <div>
              <span><KeyRound size={23} /></span>
              <h2>AI providers could not be loaded</h2>
              <p>{credentialLoadError}</p>
              <button className="button button-secondary" disabled={busy} onClick={() => void refresh()} type="button">Try again</button>
            </div>
          </div>
        )}
        {credentialLoadState === "ready" && credentials.map((item) => (
          <div className={styles.credential} key={item.id}>
            <span className={styles.providerMark}>{item.provider === "nvidia_nim" ? "NV" : item.provider.slice(0, 2).toUpperCase()}</span>
            <span>
              <strong>{item.label} {item.isPreferred && <i className="pill">preferred</i>}</strong>
              <small>{item.provider.replaceAll("_", " ")} · •••• {item.lastFour} · {item.status} · {item.routingConsented ? "routing allowed" : "routing withdrawn"}</small>
            </span>
            <div className={styles.credentialActions}>
              <button disabled={busy || !item.routingConsented} onClick={() => void action(item.id, "test")} type="button">Test</button>
              <button disabled={busy} onClick={() => { setError(null); setReplaceTarget(item); setOpen(true); }} type="button">Replace</button>
              {!item.isPreferred && <button disabled={busy || !item.routingConsented} onClick={() => void action(item.id, "prefer")} type="button">Prefer</button>}
              <button disabled={busy || (!item.routingConsented && item.status === "disabled")} onClick={() => void action(item.id, item.status === "disabled" ? "enable" : "disable")} type="button">{item.status === "disabled" ? "Enable" : "Disable"}</button>
              <button aria-label={`Delete ${item.label}`} disabled={busy} onClick={() => { setError(null); setDeleteTarget(item); }} type="button"><Trash2 size={13} /></button>
            </div>
          </div>
        ))}
        {credentialLoadState === "ready" && credentials.length === 0 && (
          <div className={`${styles.empty} card`}>
            <div><span><KeyRound size={23} /></span><h2>No AI providers yet</h2><p>Add your NVIDIA NIM key. It is encrypted before storage and never returned by this page.</p></div>
          </div>
        )}
      </div>
      <div className={styles.securityExplainer}>
        <span><strong>Normal view</strong><small>Provider, validity, use time, last four, and routing-consent state only.</small></span>
        <span><strong>Admin reveal</strong><small>Fresh MFA, reason, audit event, and learner notification every time.</small></span>
        <span><strong>Outage behavior</strong><small>Authored lessons, runner grading, exams, and progress remain usable.</small></span>
      </div>
    </>;
  }

  function updateAccessibilityPreference<K extends keyof AccessibilityPreferences>(
    key: K,
    value: AccessibilityPreferences[K],
  ) {
    persistAndApplyAccessibilityPreference(key, value);
  }

  function accessibilityPanel() {
    return <>
      <h2>Accessibility and comfort</h2>
      <p>Saved automatically on this device and applied before each page is shown.</p>
      <div className={styles.form}>
        <label>
          Text size
          <select
            aria-label="Text size"
            aria-describedby="text-size-help"
            disabled={!accessibilityControlsReady}
            onChange={(event) => updateAccessibilityPreference("textSize", event.target.value as TextSizePreference)}
            value={accessibilityPreferences.textSize}
          >
            <option value="100">Default · 100%</option>
            <option value="115">Large · 115%</option>
            <option value="130">Extra large · 130%</option>
            <option value="150">Very large · 150%</option>
            <option value="200">Maximum · 200%</option>
          </select>
          <small id="text-size-help">Scales the complete interface without disabling browser zoom.</small>
        </label>
        <label>
          Motion
          <select
            aria-label="Motion"
            disabled={!accessibilityControlsReady}
            onChange={(event) => updateAccessibilityPreference("motion", event.target.value as MotionPreference)}
            value={accessibilityPreferences.motion}
          >
            <option value="system">Follow system</option>
            <option value="reduce">Reduce motion</option>
            <option value="normal">Allow subtle motion</option>
          </select>
        </label>
        <label>
          Interface theme and contrast
          <select
            aria-label="Interface theme and contrast"
            disabled={!accessibilityControlsReady}
            onChange={(event) => updateAccessibilityPreference("interfaceTheme", event.target.value as InterfaceThemePreference)}
            value={accessibilityPreferences.interfaceTheme}
          >
            <option value="system">Follow system theme</option>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
            <option value="contrast">High contrast</option>
          </select>
        </label>
        <label>
          Code editor font
          <select
            aria-label="Code editor font"
            disabled={!accessibilityControlsReady}
            onChange={(event) => updateAccessibilityPreference("codeEditorFont", event.target.value as CodeEditorFontPreference)}
            value={accessibilityPreferences.codeEditorFont}
          >
            <option value="13">13px</option>
            <option value="14">14px</option>
            <option value="16">16px</option>
            <option value="18">18px</option>
          </select>
        </label>
      </div>
      <div className={styles.securityExplainer}>
        <span><strong>Keyboard complete</strong><small>All core actions have visible focus and no hover-only meaning.</small></span>
        <span><strong>Color safe</strong><small>Status always includes text, shape, or icon.</small></span>
        <span><strong>Equivalent views</strong><small>Graphs and visualizers include linear text representations.</small></span>
      </div>
    </>;
  }

  function content() {
    if (tab === "ai") return aiProvidersPanel();
    if (tab === "accessibility") return accessibilityPanel();
    if (tab === "security") return <><h2>Security</h2><p>Multi-factor authentication is required for every account.</p><div className={styles.sideCard}><h3>Authenticator</h3><p>Enabled. Fresh verification is required before sensitive administrator actions.</p><button aria-describedby="recovery-guidance-status" className="button button-secondary" disabled>View recovery guidance</button><small id="recovery-guidance-status">Coming soon. Contact the administrator if recovery help is needed now.</small></div><div className={styles.sideCard}><h3>Password</h3><p>Changing your password revokes other sessions and keeps the current approved-device policy.</p><button aria-describedby="password-change-status" className="button button-secondary" disabled>Change password</button><small id="password-change-status">Coming soon. Password changes are currently handled by the administrator.</small></div></>;
    if (tab === "privacy") return <PrivacyConsentPanel />;
    if (tab === "device") return <DeviceSessionsPanel />;
    if (tab === "notifications") return <NotificationPreferencesPanel />;
    return <><h2>Learning profile</h2><p>Your public cohort profile never includes email, failures, raw code, chat, or provider data.</p><div className={styles.form}><label>Display name<input defaultValue="Aarav Rao" /></label><label>Bio<textarea defaultValue="Learning Python and DSA one honest step at a time." /></label><label>Analogy preference<select><option>When helpful</option><option>Frequent</option><option>Neutral only</option></select></label><label>Public cohort fields<select><option>Alias, selected badges, streak, projects</option><option>Alias only</option><option>Hidden profile</option></select></label><button className="button button-primary">Save profile</button></div></>;
  }

  return (
    <div className={styles.page}>
      <header className={styles.pageHead}>
        <div>
          <span className={styles.eyebrow}>Your controls</span>
          <h1>Settings and privacy.</h1>
          <p>Control learning preferences, provider access, cohort visibility, accessibility, and the one approved device.</p>
        </div>
      </header>
      <section className={styles.settingsLayout}>
        <nav aria-label="Settings sections" aria-orientation="vertical" className={`${styles.settingsNav} card`} role="tablist">
          {tabs.map(([id,label,Icon]) => <button
            aria-controls="settings-tab-panel"
            aria-selected={tab === id}
            className={tab === id ? styles.activeSetting : ""}
            id={`settings-tab-${id}`}
            key={id}
            onClick={() => setTab(id)}
            onKeyDown={(event) => handleSettingsTabKeyDown(event, id)}
            ref={(node) => { settingsTabRefs.current[id] = node; }}
            role="tab"
            tabIndex={tab === id ? 0 : -1}
            type="button"
          ><Icon aria-hidden="true" size={16} /> {label}</button>)}
        </nav>
        <article aria-labelledby={`settings-tab-${tab}`} className={`${styles.settingsPanel} card`} id="settings-tab-panel" role="tabpanel" tabIndex={0}>{content()}</article>
      </section>
      {open && (
        <ModalDialog
          backdropClassName={styles.dialogBackdrop}
          dialogClassName={`${styles.dialog} card`}
          labelledBy="provider-title"
          onClose={closeProviderDialog}
        >
            <div className={styles.dialogHead}>
              <div>
                <h2 id="provider-title">{replaceTarget ? `Replace ${replaceTarget.label}` : "Add an AI provider"}</h2>
                <p>{replaceTarget ? "The old key is replaced by a new encrypted envelope after validation." : "The administrator chooses models and provider order."}</p>
              </div>
              <button className={styles.iconButton} aria-label="Close" data-dialog-initial-focus disabled={busy} onClick={closeProviderDialog}><X size={17} /></button>
            </div>
            {error && <p className={styles.error} role="alert">{error}</p>}
            <form className={styles.form} onSubmit={add}>
              {!replaceTarget && <>
                <label>Provider<select name="provider"><option value="nvidia_nim">NVIDIA NIM</option><option value="openrouter">OpenRouter</option><option value="google">Google Gemini</option><option value="openai">OpenAI</option><option value="anthropic">Anthropic</option><option value="deepseek">DeepSeek</option></select></label>
                <label>Label<input name="label" placeholder="My personal key" required minLength={2} /></label>
              </>}
              <label>{replaceTarget ? "New API key" : "API key"}<input name="secret" type="password" autoComplete="off" placeholder="Paste once" required minLength={8} /><small>Never paste a key you have already exposed publicly; rotate it first.</small></label>
              {!replaceTarget && <label><span><input name="providerConsent" required type="checkbox" /> I allow future tutor requests to send the disclosed bounded lesson context, relevant chat, preferences, and code I choose to discuss to this provider. Email, keys, hidden tests, and other learners are excluded.</span><small>This choice is versioned and can be withdrawn in privacy settings without deleting the stored encrypted key.</small></label>}
              {!replaceTarget && <label><span><input name="preferred" type="checkbox" /> Prefer this provider when healthy</span></label>}
              <button className="button button-primary" disabled={busy} type="submit">{busy ? "Encrypting and validating…" : replaceTarget ? "Replace encrypted key" : "Store encrypted key"}</button>
            </form>
        </ModalDialog>
      )}
      {deleteTarget && (
        <ModalDialog
          backdropClassName={styles.dialogBackdrop}
          describedBy="delete-provider-description"
          dialogClassName={`${styles.dialog} card`}
          labelledBy="delete-provider-title"
          onClose={closeDeleteDialog}
        >
            <div className={styles.dialogHead}>
              <div>
                <h2 id="delete-provider-title">Delete {deleteTarget.label}?</h2>
                <p id="delete-provider-description">This removes the encrypted key ending in {deleteTarget.lastFour}. Tutor routing can no longer use this provider until a new key is added.</p>
              </div>
            </div>
            {error && <p className={styles.error} role="alert">{error}</p>}
            <div className={styles.credentialActions}>
              <button
                className="button button-secondary"
                data-dialog-initial-focus
                disabled={busy}
                onClick={closeDeleteDialog}
                type="button"
              >
                Cancel
              </button>
              <button className="button button-primary" disabled={busy} onClick={() => void remove(deleteTarget)} type="button">
                <Trash2 size={15} /> {busy ? "Deleting…" : `Delete ${deleteTarget.label}`}
              </button>
            </div>
        </ModalDialog>
      )}
    </div>
  );
}
