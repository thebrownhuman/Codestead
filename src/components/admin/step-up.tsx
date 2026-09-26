"use client";

import { ShieldCheck } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import styles from "./admin.module.css";
import { registerStepUpPrompter } from "./step-up-request";

export function AdminStepUpDialog() {
  const [resolver, setResolver] = useState<((verified: boolean) => void) | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    registerStepUpPrompter(() => new Promise<boolean>((resolve) => {
      setCode("");
      setError(null);
      setResolver(() => resolve);
    }));
    return () => registerStepUpPrompter(null);
  }, []);

  useEffect(() => {
    if (resolver) inputRef.current?.focus();
  }, [resolver]);

  if (!resolver) return null;

  function close(verified: boolean) {
    resolver?.(verified);
    setResolver(null);
  }

  async function verify(event: React.FormEvent) {
    event.preventDefault();
    const value = code.replace(/\s/g, "");
    if (!/^\d{6}$/.test(value)) {
      setError("Enter the current six-digit code from your authenticator app.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/security/fresh-mfa", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: value }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        setError(body?.error ?? "That code was not accepted.");
        return;
      }
      close(true);
    } catch {
      setError("Verification is temporarily unavailable. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.stepUpBackdrop}>
      <form aria-labelledby="admin-step-up-title" aria-modal="true" className={styles.stepUpDialog} onKeyDown={(event) => { if (event.key === "Escape") close(false); }} onSubmit={(event) => void verify(event)} role="dialog">
        <h2 id="admin-step-up-title"><ShieldCheck size={18} /> Confirm it&apos;s you</h2>
        <p>This action needs a fresh authenticator code. It then continues automatically.</p>
        <label>Authenticator code<input ref={inputRef} autoComplete="one-time-code" inputMode="numeric" maxLength={6} value={code} onChange={(event) => setCode(event.target.value)} /></label>
        {error && <p className={styles.inlineError} role="alert">{error}</p>}
        <div className={styles.headActions}>
          <button className="button button-secondary" disabled={busy} onClick={() => close(false)} type="button">Cancel</button>
          <button className="button button-primary" disabled={busy} type="submit">{busy ? "Verifying…" : "Verify and continue"}</button>
        </div>
      </form>
    </div>
  );
}
