"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ENROLLMENT_DISCLOSURE_VERSION, RETENTION_DISCLOSURE } from "@/lib/privacy/disclosure-version";
import styles from "./product-pages.module.css";

export function DisclosureRenewal() {
  const router = useRouter();
  const requestId = useRef<string | null>(null);
  const [accepted, setAccepted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function renew() {
    if (!accepted || busy) return;
    requestId.current ??= crypto.randomUUID();
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/privacy/consents", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ requestId: requestId.current, policyVersion: ENROLLMENT_DISCLOSURE_VERSION,
          purpose: "retention_policy", decision: "accepted", renewDisclosures: true }) });
      if (!response.ok) throw new Error("Your acknowledgement could not be saved. Please try again.");
      router.refresh();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Your acknowledgement could not be saved.");
      setBusy(false);
    }
  }
  return <section className={`${styles.form} card`} aria-labelledby="retention-update-title">
    <h1 id="retention-update-title">What changed: your last 10 chats</h1>
    <p>{RETENTION_DISCLOSURE}</p>
    <p>Your existing provider choices, saved keys, and settings stay in place. Accept this update to resume AI access with the choices you previously accepted. Withdrawn choices stay withdrawn.</p>
    <label><span><input type="checkbox" checked={accepted} disabled={busy} onChange={(event) => setAccepted(event.target.checked)} /> I understand the 10-chat retention change and accept the updated disclosures.</span></label>
    {error && <p role="alert">{error}</p>}
    <button type="button" className="button button-primary" disabled={!accepted || busy} onClick={() => void renew()}>{busy ? "Saving acknowledgement…" : "Accept update and continue"}</button>
  </section>;
}
