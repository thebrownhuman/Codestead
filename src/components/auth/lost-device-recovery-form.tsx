"use client";

import Link from "next/link";
import { MailCheck, ShieldAlert } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import styles from "./auth.module.css";

export function LostDeviceRecoveryForm() {
  const initialFragmentProof = useRef<string | null>(
    typeof window === "undefined"
      ? null
      : new URLSearchParams(window.location.hash.slice(1)).get("proof"),
  );
  const [proof, setProof] = useState<string | null>(null);
  const [fragmentChecked, setFragmentChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [complete, setComplete] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const submittingRef = useRef(false);

  useEffect(() => {
    // The ref survives React development Strict Mode's effect replay. Reading
    // the fragment again after the first replay cleared history would lose the
    // only copy of the bearer proof.
    const candidate = initialFragmentProof.current;
    if (candidate) {
      // Remove the bearer from browser history and future same-origin
      // referrers before the learner enters any request details.
      window.history.replaceState(null, "", "/lost-device");
    }
    let mounted = true;
    queueMicrotask(() => {
      if (!mounted) return;
      setProof(candidate);
      setFragmentChecked(true);
    });
    return () => {
      mounted = false;
    };
  }, []);

  async function requestProof(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submittingRef.current) return;
    submittingRef.current = true;
    setBusy(true);
    setMessage(null);
    const form = new FormData(event.currentTarget);
    try {
      const response = await fetch("/api/lost-device/request", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: form.get("email") }),
      });
      const body = (await response.json()) as { error?: string; message?: string };
      if (!response.ok) {
        setMessage(body.error ?? "Device recovery is temporarily unavailable.");
        return;
      }
      setComplete(true);
      setMessage(
        body.message ??
          "If an eligible account exists, a short-lived confirmation link has been emailed.",
      );
    } catch {
      setMessage("Device recovery is temporarily unavailable. Check your connection and try again.");
    } finally {
      submittingRef.current = false;
      setBusy(false);
    }
  }

  async function verifyProof(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!proof || submittingRef.current) return;
    submittingRef.current = true;
    setBusy(true);
    setMessage(null);
    const form = new FormData(event.currentTarget);
    try {
      const response = await fetch("/api/lost-device/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ proof, reason: form.get("reason") }),
      });
      const body = (await response.json()) as { error?: string; message?: string };
      if (!response.ok) {
        setMessage(body.error ?? "The confirmation link could not be accepted.");
        return;
      }
      setProof(null);
      setComplete(true);
      setMessage(
        body.message ??
          "Mailbox control was confirmed. Administrator identity review is still required.",
      );
    } catch {
      setMessage("The confirmation link could not be accepted. Check your connection and try again.");
    } finally {
      submittingRef.current = false;
      setBusy(false);
    }
  }

  if (!fragmentChecked) {
    return <div className={styles.form} role="status">Checking the confirmation link…</div>;
  }

  if (complete) {
    return (
      <div className={styles.form} role="status">
        <p className={styles.success}>{message}</p>
        <p className={styles.footLink}>
          This process never signs you in or changes a password. <Link href="/login">Return to sign in</Link>
        </p>
      </div>
    );
  }

  if (proof) {
    return (
      <form className={styles.form} onSubmit={verifyProof}>
        {message && <p className={styles.error} role="alert">{message}</p>}
        <p>
          <MailCheck size={17} aria-hidden="true" /> The email link proves mailbox control only. Describe which device was lost; the administrator must separately confirm your identity before revoking it.
        </p>
        <div className={styles.field}>
          <label htmlFor="lost-device-reason">Why can you no longer use the approved browser profile?</label>
          <textarea
            id="lost-device-reason"
            name="reason"
            minLength={12}
            maxLength={500}
            autoComplete="off"
            required
          />
        </div>
        <button className={`button button-primary ${styles.submit}`} disabled={busy} type="submit">
          <ShieldAlert size={17} /> {busy ? "Confirming…" : "Confirm and request review"}
        </button>
      </form>
    );
  }

  return (
    <form className={styles.form} onSubmit={requestProof}>
      {message && <p className={styles.error} role="alert">{message}</p>}
      <div className={styles.field}>
        <label htmlFor="lost-device-email">Approved account email</label>
        <input
          id="lost-device-email"
          name="email"
          type="email"
          autoComplete="email"
          required
        />
      </div>
      <button className={`button button-primary ${styles.submit}`} disabled={busy} type="submit">
        <MailCheck size={17} /> {busy ? "Requesting…" : "Email a confirmation link"}
      </button>
      <p className={styles.footLink}>
        The response is identical for unknown and ineligible addresses. <Link href="/login">Return to sign in</Link>
      </p>
    </form>
  );
}
