"use client";

import { useRouter } from "next/navigation";
import { ShieldCheck } from "lucide-react";
import { useRef, useState } from "react";

import { authClient } from "@/lib/auth-client";
import styles from "./auth.module.css";

export function TwoFactorForm() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [useRecoveryCode, setUseRecoveryCode] = useState(false);
  const submittingRef = useRef(false);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submittingRef.current) return;
    submittingRef.current = true;
    setBusy(true);
    setError(null);
    const code = String(new FormData(event.currentTarget).get("code")).replace(/\s/g, "");
    try {
      const currentSessionVerification = await fetch(
        useRecoveryCode ? "/api/security/verify-backup-code" : "/api/security/fresh-mfa",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ code }),
        },
      );
      if (currentSessionVerification.ok) {
        const body = (await currentSessionVerification.json()) as { redirectTo?: string };
        router.push(body.redirectTo ?? "/learn");
        router.refresh();
        return;
      }
      if (currentSessionVerification.status !== 401) {
        const body = (await currentSessionVerification.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? "That code was not accepted.");
        return;
      }

      // Credential sign-in intentionally has no authenticated session until the
      // second factor succeeds, so the Better Auth pending-challenge path is the
      // only valid fallback after an explicit 401 above.
      const result = useRecoveryCode
        ? await authClient.twoFactor.verifyBackupCode({ code, trustDevice: false, disableSession: false })
        : await authClient.twoFactor.verifyTotp({ code, trustDevice: false });
      if (result.error) {
        setError(result.error.message ?? "That code was not accepted.");
        return;
      }
      if (useRecoveryCode) {
        // The single-use code has already been consumed. Better Auth's
        // server-side after-hook stamps the newly created session.
        router.push("/onboarding");
        router.refresh();
        return;
      }
      const stampedSession = await fetch("/api/security/fresh-mfa", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code }),
      });
      const stampedBody = (await stampedSession.json().catch(() => ({}))) as {
        error?: string;
        redirectTo?: string;
      };
      if (!stampedSession.ok) {
        setError(stampedBody.error ?? "MFA succeeded, but the session could not be secured. Try again.");
        return;
      }
      router.push(stampedBody.redirectTo ?? "/onboarding");
      router.refresh();
    } catch {
      setError("Verification is temporarily unavailable. Check your connection and try again.");
    } finally {
      submittingRef.current = false;
      setBusy(false);
    }
  }

  return (
    <form className={styles.form} onSubmit={submit}>
      {error && <p className={styles.error} role="alert">{error}</p>}
      <div className={styles.field}>
        <label htmlFor="code">{useRecoveryCode ? "Single-use recovery code" : "Authenticator code"}</label>
        <input className={styles.codeInput} id="code" name="code" inputMode={useRecoveryCode ? "text" : "numeric"} autoComplete="one-time-code" pattern={useRecoveryCode ? undefined : "[0-9]{6}"} maxLength={useRecoveryCode ? 100 : 6} autoFocus required aria-describedby="code-help" />
        <small id="code-help">{useRecoveryCode ? "Enter one of the recovery codes saved during setup. It is invalidated after use." : "Open your authenticator app and enter the current six-digit code."}</small>
      </div>
      <button className={`button button-primary ${styles.submit}`} disabled={busy} type="submit"><ShieldCheck size={18} /> {busy ? "Verifying…" : "Verify and continue"}</button>
      <button className={styles.footLink} disabled={busy} onClick={() => { setUseRecoveryCode((current) => !current); setError(null); }} type="button">{useRecoveryCode ? "Use authenticator code instead" : "Use a saved recovery code"}</button>
      <p className={styles.footLink}>No authenticator or recovery code? Ask the administrator to start the audited identity-recovery flow.</p>
    </form>
  );
}
