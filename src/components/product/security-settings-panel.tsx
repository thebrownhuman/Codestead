"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { PasswordInput } from "@/components/ui/password-input";
import styles from "./product-pages.module.css";
import formStyles from "../ui/form.module.css";
import { Field } from "../ui/field";

async function readPasswordStatus(signal?: AbortSignal): Promise<boolean> {
  const response = await fetch("/api/security/password-status", { cache: "no-store", signal });
  const body = await response.json();
  if (!response.ok || typeof body.hasPassword !== "boolean") throw new Error("Invalid status");
  return body.hasPassword;
}

export function SecuritySettingsPanel() {
  const [hasPassword, setHasPassword] = useState<boolean | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [open, setOpen] = useState(false);
  const [recoveryOpen, setRecoveryOpen] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const mutation = useRef(false);
  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const value = await readPasswordStatus(signal);
      if (!signal?.aborted) { setHasPassword(value); setLoadError(false); }
    } catch { if (!signal?.aborted) setLoadError(true); }
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    void readPasswordStatus(controller.signal).then((value) => {
      if (!controller.signal.aborted) { setHasPassword(value); setLoadError(false); }
    }).catch(() => { if (!controller.signal.aborted) setLoadError(true); });
    return () => controller.abort();
  }, []);
  function clearSecrets() { setCurrentPassword(""); setNewPassword(""); setConfirmation(""); }
  async function submit(event: React.FormEvent) {
    event.preventDefault(); if (mutation.current) return;
    if (newPassword !== confirmation) { setError("New passwords must match."); return; }
    mutation.current = true; setBusy(true); setError(null); setMessage(null);
    try {
      const response = await fetch("/api/security/change-password", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ currentPassword, newPassword }) });
      const body = await response.json();
      if (!response.ok || body.ok !== true) throw new Error(typeof body.error === "string" ? body.error : "Password change could not be completed.");
      setOpen(false); setMessage("Password changed. Other sessions were revoked.");
    } catch (failure) { setError(failure instanceof Error ? failure.message : "Password change could not be completed."); }
    finally { clearSecrets(); mutation.current = false; setBusy(false); }
  }
  return <><h2>Security</h2><p>Multi-factor authentication is required for every account.</p>
    <section className={styles.sideCard}><h3>Authenticator</h3><p>Use your authenticator when signing in on an untrusted device.</p>
      <button className="button button-secondary" aria-expanded={recoveryOpen} aria-controls="mfa-recovery-guidance" onClick={() => setRecoveryOpen(!recoveryOpen)}>View recovery guidance</button>
      {recoveryOpen && <div id="mfa-recovery-guidance"><h4>MFA recovery</h4><p>Use one of the backup codes saved during authenticator setup if you cannot access your authenticator. Choose the recovery-code option at sign-in. Each code can be used only once.</p><p>Keep backup codes private. Never include them or passwords in a support request.</p></div>}
    </section>
    <section className={styles.sideCard}><h3>Password</h3>
      {loadError ? <><p role="alert">Account security settings could not be loaded.</p><button className="button button-secondary" onClick={() => void load()}>Try again</button></>
        : hasPassword === null ? <p role="status">Loading account security settings…</p>
        : !hasPassword ? <p>Signed in with Google; manage your password at Google.</p>
        : <><p>Changing your password revokes other sessions. Enter your current password to verify this sensitive action.</p>
          {!open && <div className={formStyles.actions}>{message && <p role="status">{message}</p>}<button className="button button-secondary" onClick={() => { setError(null); setMessage(null); setOpen(true); }}>Change password</button></div>}
          {open && <form className={styles.form} onSubmit={submit}>
            <Field id="current-password" label="Current password"><PasswordInput id="current-password" autoComplete="current-password" required maxLength={128} value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} disabled={busy} /></Field>
            <Field id="new-password" label="New password" help="Use 12 to 128 characters. Compromised passwords are rejected."><PasswordInput id="new-password" aria-describedby="new-password-help" autoComplete="new-password" required minLength={12} maxLength={128} value={newPassword} onChange={(event) => setNewPassword(event.target.value)} disabled={busy} /></Field>
            <Field id="confirm-new-password" label="Confirm new password"><PasswordInput id="confirm-new-password" autoComplete="new-password" required minLength={12} maxLength={128} value={confirmation} onChange={(event) => setConfirmation(event.target.value)} disabled={busy} /></Field>
            <div className={formStyles.actions}>
            {error && <p className={formStyles.error} role="alert">{error}</p>}
            <button type="submit" className="button button-primary" disabled={busy}>{busy ? "Saving…" : "Save password"}</button>
            <button type="button" className="button button-secondary" disabled={busy} onClick={() => { clearSecrets(); setError(null); setOpen(false); }}>Cancel</button>
            </div>
          </form>}</>}
    </section></>;
}
