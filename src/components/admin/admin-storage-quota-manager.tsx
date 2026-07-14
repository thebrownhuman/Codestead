"use client";

import { HardDrive, ShieldCheck } from "lucide-react";
import { useState } from "react";

import { formatBytes } from "./admin-utils";
import styles from "./admin.module.css";

const GIB = 1024 ** 3;
const OPTIONS = [2, 2.25, 2.5, 2.75, 3] as const;

type QuotaResponse = {
  usedBytes?: number;
  quotaBytes?: number;
  rowVersion?: number;
  warning?: string;
  error?: string;
};

export function AdminStorageQuotaManager({
  learnerId,
  initialUsedBytes,
  initialQuotaBytes,
  initialRowVersion,
}: {
  readonly learnerId: string;
  readonly initialUsedBytes: number;
  readonly initialQuotaBytes: number;
  readonly initialRowVersion: number;
}) {
  const [usedBytes, setUsedBytes] = useState(initialUsedBytes);
  const [quotaBytes, setQuotaBytes] = useState(initialQuotaBytes);
  const [rowVersion, setRowVersion] = useState(initialRowVersion);
  const [selectedGiB, setSelectedGiB] = useState(String(initialQuotaBytes / GIB));
  const [totp, setTotp] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [messageIsError, setMessageIsError] = useState(false);

  async function changeQuota() {
    setBusy(true);
    setMessage(null);
    setMessageIsError(false);
    try {
      if (!/^\d{6}$/.test(totp)) throw new Error("Enter the current six-digit authenticator code.");
      if (reason.trim().length < 8) throw new Error("Record a specific reason of at least eight characters.");
      const requestedBytes = Math.round(Number(selectedGiB) * GIB);
      if (!Number.isSafeInteger(requestedBytes) || requestedBytes < 2 * GIB || requestedBytes > 3 * GIB) {
        throw new Error("Choose a quota from 2 GiB through 3 GiB.");
      }
      const mfaResponse = await fetch("/api/security/fresh-mfa", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: totp }),
      });
      const mfaBody = (await mfaResponse.json()) as { error?: string };
      if (!mfaResponse.ok) throw new Error(mfaBody.error ?? "Fresh MFA verification failed.");
      const response = await fetch(
        `/api/admin/learners/${encodeURIComponent(learnerId)}/storage-quota`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            requestId: crypto.randomUUID(),
            expectedRowVersion: rowVersion,
            quotaBytes: requestedBytes,
            reason,
          }),
        },
      );
      const body = (await response.json()) as QuotaResponse;
      if (!response.ok || body.quotaBytes === undefined || body.rowVersion === undefined) {
        throw new Error(body.error ?? "Storage quota could not be changed.");
      }
      setQuotaBytes(body.quotaBytes);
      setUsedBytes(body.usedBytes ?? usedBytes);
      setRowVersion(body.rowVersion);
      setSelectedGiB(String(body.quotaBytes / GIB));
      setTotp("");
      setMessage(`Storage quota changed to ${formatBytes(body.quotaBytes)}.${body.warning ? ` ${body.warning}` : " The learner was notified."}`);
    } catch (error) {
      setMessageIsError(true);
      setMessage(error instanceof Error ? error.message : "Storage quota could not be changed.");
    } finally {
      setBusy(false);
    }
  }

  const usedPercent = quotaBytes > 0 ? Math.min(100, (usedBytes / quotaBytes) * 100) : 0;
  const currentGiB = quotaBytes / GIB;
  const hasCurrentOption = OPTIONS.some((value) => value === currentGiB);
  return (
    <article className={styles.panel}>
      <div className={styles.panelHead}>
        <div><HardDrive size={18} /><span><strong>Learner storage quota</strong><small>2 GiB default · adjustable up to 3 GiB</small></span></div>
      </div>
      {message && (
        <p
          aria-live={messageIsError ? "assertive" : "polite"}
          className={messageIsError ? styles.inlineError : styles.inlineSuccess}
          role={messageIsError ? "alert" : "status"}
        >
          {message}
        </p>
      )}
      <div className={styles.profileFacts}>
        <div className={styles.profileFact}><span>Used</span><strong>{formatBytes(usedBytes)}</strong></div>
        <div className={styles.profileFact}><span>Current limit</span><strong>{formatBytes(quotaBytes)}</strong></div>
        <div className={styles.profileFact}><span>Usage</span><strong>{usedPercent.toFixed(1)}%</strong></div>
        <div className={styles.profileFact}><span>Revision</span><strong>{rowVersion}</strong></div>
      </div>
      <div className={styles.approveForm} style={{ marginTop: 12 }}>
        <label>
          New quota
          <select onChange={(event) => setSelectedGiB(event.target.value)} value={selectedGiB}>
            {!hasCurrentOption && <option value={String(currentGiB)}>{currentGiB.toFixed(2)} GiB · current</option>}
            {OPTIONS.map((value) => <option key={value} value={String(value)}>{value.toFixed(2)} GiB</option>)}
          </select>
        </label>
        <label>
          Current six-digit authenticator code
          <input
            autoComplete="one-time-code"
            inputMode="numeric"
            maxLength={6}
            onChange={(event) => setTotp(event.target.value.replace(/\D/g, ""))}
            pattern="[0-9]{6}"
            type="password"
            value={totp}
          />
        </label>
        <label>
          Recorded reason
          <textarea maxLength={500} minLength={8} onChange={(event) => setReason(event.target.value)} value={reason} />
        </label>
        <button className="button button-secondary" disabled={busy} onClick={() => void changeQuota()} type="button">
          <HardDrive size={14} /> Change quota
        </button>
        <p className={styles.safeNotice}><ShieldCheck size={14} /> Fresh MFA, optimistic concurrency, an immutable audit event, and a learner notice protect every change. A limit cannot be reduced below current usage.</p>
      </div>
    </article>
  );
}
