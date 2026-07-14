"use client";

import Link from "next/link";
import { Send } from "lucide-react";
import { useRef, useState } from "react";

import styles from "./auth.module.css";

export function AccessRequestForm() {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const submittingRef = useRef(false);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submittingRef.current) return;
    submittingRef.current = true;
    setBusy(true);
    setMessage(null);
    setError(null);
    const form = new FormData(event.currentTarget);
    try {
      const response = await fetch("/api/access-requests", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: form.get("name"),
          email: form.get("email"),
          reason: form.get("reason"),
          adultConfirmed: form.get("adult") === "on",
        }),
      });
      const result = (await response.json()) as { error?: string; message?: string };
      if (!response.ok) setError(result.error ?? "Please check the form and try again.");
      else setMessage(result.message ?? "Request sent.");
    } catch {
      setError("Access requests are temporarily unavailable. Check your connection and try again.");
    } finally {
      submittingRef.current = false;
      setBusy(false);
    }
  }

  if (message) {
    return <div className={styles.form}><p className={styles.success}>{message}</p><p className={styles.footLink}>We will email you after review. <Link href="/login">Back to sign in</Link></p></div>;
  }

  return (
    <form className={styles.form} onSubmit={submit}>
      {error && <p className={styles.error} role="alert">{error}</p>}
      <div className={styles.field}><label htmlFor="name">Your name</label><input id="name" name="name" autoComplete="name" placeholder="What should Codestead call you?" required /></div>
      <div className={styles.field}><label htmlFor="email">Email address</label><input id="email" name="email" type="email" autoComplete="email" placeholder="you@example.com" required /></div>
      <div className={styles.field}><label htmlFor="reason">What would you like to learn? <small>(optional)</small></label><textarea id="reason" name="reason" maxLength={500} placeholder="For example: C++ for college, then DSA in C++." /></div>
      <label className={styles.check}><input name="adult" type="checkbox" required /> I confirm that I am 18 or older.</label>
      <button className={`button button-primary ${styles.submit}`} disabled={busy} type="submit"><Send size={17} /> {busy ? "Sending…" : "Send request"}</button>
      <p className={styles.footLink}>Already invited? <Link href="/login">Sign in</Link></p>
    </form>
  );
}
