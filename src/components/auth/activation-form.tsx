"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { KeyRound } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import styles from "./auth.module.css";

export function ActivationForm() {
  const params = useSearchParams();
  const router = useRouter();
  const token = params.get("token") ?? "";
  const [email, setEmail] = useState<string | null>(null);
  const [state, setState] = useState<"checking" | "ready" | "invalid" | "sent">("checking");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submittingRef = useRef(false);

  useEffect(() => {
    fetch(`/api/invitations/validate?token=${encodeURIComponent(token)}`, { cache: "no-store" })
      .then(async (response) => {
        const body = (await response.json()) as { valid: boolean; email?: string };
        if (!response.ok || !body.valid || !body.email) throw new Error();
        setEmail(body.email);
        setState("ready");
      })
      .catch(() => setState("invalid"));
  }, [token]);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!email || submittingRef.current) return;
    const form = new FormData(event.currentTarget);
    if (form.get("password") !== form.get("confirm")) {
      setError("Passwords do not match.");
      return;
    }
    submittingRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/invitations/activate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          token,
          name: String(form.get("name")),
          password: String(form.get("password")),
        }),
      });
      const result = (await response.json()) as { error?: string };
      if (!response.ok) setError(result.error ?? "Account activation failed.");
      else setState("sent");
    } catch {
      setError("Account activation is temporarily unavailable. Check your connection and try again.");
    } finally {
      submittingRef.current = false;
      setBusy(false);
    }
  }

  if (state === "checking") return <p className={styles.notice}>Checking your single-use invitation…</p>;
  if (state === "invalid") return <div className={styles.form}><p className={styles.error} role="alert">This invitation is invalid, expired, or already used.</p><p className={styles.footLink}><Link href="/request-access">Request a new invitation</Link></p></div>;
  if (state === "sent") return <div className={styles.form}><p className={styles.success}>Your account is ready. Check your email to verify the address, then sign in.</p><button className="button button-primary" type="button" onClick={() => router.push("/login")}>Go to sign in</button></div>;

  return (
    <form className={styles.form} onSubmit={submit}>
      {error && <p className={styles.error} role="alert">{error}</p>}
      <p className={styles.notice}>Invitation for <strong>{email}</strong></p>
      <div className={styles.field}><label htmlFor="name">Display name</label><input id="name" name="name" autoComplete="name" required minLength={2} maxLength={80} /></div>
      <div className={styles.field}><label htmlFor="password">Create password</label><input id="password" name="password" type="password" autoComplete="new-password" required minLength={12} maxLength={128} /><small>Use at least 12 characters. A passphrase is ideal.</small></div>
      <div className={styles.field}><label htmlFor="confirm">Confirm password</label><input id="confirm" name="confirm" type="password" autoComplete="new-password" required minLength={12} /></div>
      <button className={`button button-primary ${styles.submit}`} disabled={busy} type="submit"><KeyRound size={18} /> {busy ? "Activating…" : "Activate account"}</button>
    </form>
  );
}
