"use client";

import { ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { ModalDialog } from "@/components/ui/modal-dialog";

import styles from "./admin.module.css";
import { registerStepUpPrompter } from "./step-up-request";

export function AdminStepUpDialog() {
  const [resolver, setResolver] = useState<((verified: boolean) => void) | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pendingRef = useRef<((verified: boolean) => void) | null>(null);
  const attempt = useRef(0);
  const verification = useRef<AbortController | null>(null);
  const dispose = useCallback(() => {
    attempt.current++;
    verification.current?.abort();
    pendingRef.current?.(false);
    pendingRef.current = null;
  }, []);

  useEffect(() => {
    const unregister = registerStepUpPrompter(() => new Promise<boolean>((resolve) => {
      pendingRef.current?.(false);
      verification.current?.abort();
      attempt.current++;
      pendingRef.current = resolve;
      setCode("");
      setError(null);
      setBusy(false);
      setResolver(() => resolve);
    }));
    return () => {
      dispose();
      unregister();
    };
  }, [dispose]);

  if (!resolver) return null;

  function close(verified: boolean) {
    attempt.current++;
    verification.current?.abort();
    pendingRef.current?.(verified);
    pendingRef.current = null;
    setResolver(null);
    setBusy(false);
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
    const owner = attempt.current;
    const controller = new AbortController();
    verification.current = controller;
    try {
      const response = await fetch("/api/security/fresh-mfa", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: value }),
        signal: controller.signal,
      });
      if (owner !== attempt.current) return;
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        if (owner !== attempt.current) return;
        setError(body?.error ?? "That code was not accepted.");
        return;
      }
      close(true);
    } catch {
      if (owner === attempt.current) setError("Verification is temporarily unavailable. Try again.");
    } finally {
      if (owner === attempt.current) setBusy(false);
    }
  }

  return (
    <ModalDialog asChild backdropClassName={styles.stepUpBackdrop} dialogClassName={styles.stepUpDialog} labelledBy="admin-step-up-title" onClose={() => close(false)}>
      <form onSubmit={(event) => void verify(event)}>
        <h2 id="admin-step-up-title"><ShieldCheck size={18} /> Confirm it&apos;s you</h2>
        <p>This action needs a fresh authenticator code. It then continues automatically.</p>
        <label>Authenticator code<input data-dialog-initial-focus autoComplete="one-time-code" inputMode="numeric" maxLength={6} value={code} onChange={(event) => setCode(event.target.value)} /></label>
        {error && <p className={styles.inlineError} role="alert">{error}</p>}
        <div className={styles.headActions}>
          <button className="button button-secondary" onClick={() => close(false)} type="button">Cancel</button>
          <button className="button button-primary" disabled={busy} type="submit">{busy ? "Verifying…" : "Verify and continue"}</button>
        </div>
      </form>
    </ModalDialog>
  );
}
