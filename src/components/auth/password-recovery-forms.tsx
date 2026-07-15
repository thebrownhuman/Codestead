"use client";

import Link from "next/link";
import { KeyRound, Mail } from "lucide-react";
import { useCallback, useRef, useState } from "react";

import { authClient } from "@/lib/auth-client";
import { openBrowserOutbox } from "@/lib/browser-durability/indexed-db";
import { purgeBrowserRecoveryData } from "@/lib/browser-durability/lifecycle";
import styles from "./auth.module.css";

export function ForgotPasswordForm() {
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submittingRef = useRef(false);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submittingRef.current) return;
    submittingRef.current = true;
    setBusy(true);
    setError(null);
    const form = new FormData(event.currentTarget);
    try {
      const result = await authClient.requestPasswordReset({
        email: String(form.get("email")),
        redirectTo: `${window.location.origin}/reset-password`,
      });
      if (result.error) {
        setError("Password recovery is temporarily unavailable. Please try again or contact the administrator.");
        return;
      }
      setSent(true);
    } catch {
      setError("Password recovery is temporarily unavailable. Please try again or contact the administrator.");
    } finally {
      submittingRef.current = false;
      setBusy(false);
    }
  }

  if (sent) {
    return (
      <div className={styles.form} role="status">
        <p className={styles.success}>If that approved account exists, a single-use reset link has been emailed.</p>
        <p className={styles.footLink}>The same message is shown for unknown addresses. <Link href="/login">Back to sign in</Link></p>
      </div>
    );
  }

  return (
    <form className={styles.form} onSubmit={submit}>
      {error && <p className={styles.error} role="alert">{error}</p>}
      <div className={styles.field}>
        <label htmlFor="recovery-email">Email address</label>
        <input id="recovery-email" name="email" type="email" autoComplete="email" required />
      </div>
      <button className={`button button-primary ${styles.submit}`} disabled={busy} type="submit">
        <Mail size={17} /> {busy ? "Requesting…" : "Email a reset link"}
      </button>
      <p className={styles.footLink}><Link href="/login">Return to sign in</Link></p>
    </form>
  );
}

export function ResetPasswordForm({ token, invalid }: { token?: string; invalid?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [complete, setComplete] = useState(false);
  const [cleanupState, setCleanupState] = useState<"idle" | "cleaning" | "ready" | "failed">("idle");
  const [error, setError] = useState<string | null>(
    invalid || !token ? "This reset link is invalid or expired. Request a new link." : null,
  );
  const submittingRef = useRef(false);

  const cleanRevokedSessionRecovery = useCallback(async () => {
    setCleanupState("cleaning");
    let repository: Awaited<ReturnType<typeof openBrowserOutbox>> | null = null;
    try {
      repository = await openBrowserOutbox();
      await purgeBrowserRecoveryData({
        sessionStorage: window.sessionStorage,
        localStorage: window.localStorage,
        repository,
      });
      setCleanupState("ready");
    } catch {
      setCleanupState("failed");
    } finally {
      repository?.close();
    }
  }, []);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!token || submittingRef.current) return;
    const form = new FormData(event.currentTarget);
    const password = String(form.get("password"));
    const confirmation = String(form.get("confirmation"));
    if (password !== confirmation) {
      setError("The two passwords do not match.");
      return;
    }
    submittingRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const result = await authClient.resetPassword({ newPassword: password, token });
      if (result.error) {
        setError("The reset link is invalid, expired, or already used. Request a new one.");
        return;
      }
      setComplete(true);
      void cleanRevokedSessionRecovery();
    } catch {
      setError("The reset link is invalid, expired, or already used. Request a new one.");
    } finally {
      submittingRef.current = false;
      setBusy(false);
    }
  }

  if (complete) {
    return (
      <div className={styles.form} role={cleanupState === "failed" ? "alert" : "status"}>
        <p className={styles.success}>Password changed. Existing sessions have been revoked.</p>
        {cleanupState === "cleaning" && <p>Cleaning private browser recovery storage...</p>}
        {cleanupState === "failed" && (
          <>
            <p>Password changed and sessions were revoked, but browser cleanup still needs to finish before sign-in.</p>
            <button className="button button-secondary" onClick={() => void cleanRevokedSessionRecovery()} type="button">Retry browser storage cleanup</button>
          </>
        )}
        {cleanupState === "ready" && <Link className="button button-primary" href="/login">Sign in again</Link>}
      </div>
    );
  }

  return (
    <form className={styles.form} onSubmit={submit}>
      {error && <p className={styles.error} role="alert">{error}</p>}
      <div className={styles.field}>
        <label htmlFor="new-password">New password</label>
        <input id="new-password" name="password" type="password" autoComplete="new-password" minLength={12} maxLength={128} required disabled={!token} />
      </div>
      <div className={styles.field}>
        <label htmlFor="confirm-password">Confirm new password</label>
        <input id="confirm-password" name="confirmation" type="password" autoComplete="new-password" minLength={12} maxLength={128} required disabled={!token} />
      </div>
      <button className={`button button-primary ${styles.submit}`} disabled={busy || !token} type="submit">
        <KeyRound size={17} /> {busy ? "Changing…" : "Change password"}
      </button>
      {!token && <p className={styles.footLink}><Link href="/forgot-password">Request another reset link</Link></p>}
    </form>
  );
}
