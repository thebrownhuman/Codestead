"use client";

import { Download, ShieldAlert, Trash2 } from "lucide-react";
import { useState } from "react";

import styles from "./admin.module.css";

type DeletionReport = {
  tombstoneId: string;
  backupStatus: string;
  backupRetentionUntil: string;
  backupNotice: string;
};

export function AdminDataLifecycleControls({ learnerId }: { readonly learnerId: string }) {
  const [totp, setTotp] = useState("");
  const [reason, setReason] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [messageIsError, setMessageIsError] = useState(false);

  async function freshMfa() {
    if (!/^\d{6}$/.test(totp)) throw new Error("Enter the current six-digit authenticator code.");
    if (reason.trim().length < 8) throw new Error("Record a specific reason of at least eight characters.");
    const response = await fetch("/api/security/fresh-mfa", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: totp }),
    });
    const body = (await response.json()) as { error?: string };
    if (!response.ok) throw new Error(body.error ?? "Fresh MFA verification failed.");
  }

  async function exportData() {
    setBusy(true);
    setMessage(null);
    setMessageIsError(false);
    try {
      await freshMfa();
      const response = await fetch(
        `/api/admin/learners/${encodeURIComponent(learnerId)}/data-export`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ requestId: crypto.randomUUID(), reason }),
        },
      );
      if (!response.ok) {
        const body = (await response.json()) as { error?: string };
        throw new Error(body.error ?? "The export could not be created.");
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "codestead-export.ndjson";
      anchor.click();
      URL.revokeObjectURL(url);
      setMessage("Bounded NDJSON export completed. The action was audited.");
      setTotp("");
    } catch (error) {
      setMessageIsError(true);
      setMessage(error instanceof Error ? error.message : "The export failed.");
    } finally {
      setBusy(false);
    }
  }

  async function deleteAccount() {
    if (confirmation !== "DELETE") {
      setMessageIsError(true);
      setMessage("Type DELETE exactly before account deletion.");
      return;
    }
    setBusy(true);
    setMessage(null);
    setMessageIsError(false);
    try {
      await freshMfa();
      const response = await fetch(
        `/api/admin/learners/${encodeURIComponent(learnerId)}/delete-account`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            requestId: crypto.randomUUID(),
            confirmation,
            reason,
          }),
        },
      );
      const body = (await response.json()) as {
        error?: string;
        report?: DeletionReport;
        completionAuditRecorded?: boolean;
        warning?: string;
      };
      if (!response.ok || !body.report) throw new Error(body.error ?? "Account deletion failed.");
      if (body.completionAuditRecorded === false) setMessageIsError(true);
      setMessage(
        `Primary data deleted. Encrypted backups are not claimed erased; earliest conservative expiry is ${new Date(body.report.backupRetentionUntil).toLocaleDateString()}.${body.warning ? ` ${body.warning}` : ""}`,
      );
      setTotp("");
      setConfirmation("");
    } catch (error) {
      setMessageIsError(true);
      setMessage(error instanceof Error ? error.message : "Account deletion failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className={`${styles.panel} ${styles.spanTwo}`}>
      <div className={styles.panelHead}>
        <div><ShieldAlert size={18} /><span><strong>Data export and account deletion</strong><small>Administrator-only · fresh MFA · reason · audit · learner notice</small></span></div>
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
      <div className={styles.approveForm}>
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
        <div className={styles.headActions}>
          <button className="button button-secondary" disabled={busy} onClick={() => void exportData()} type="button">
            <Download size={14} /> Export bounded NDJSON
          </button>
        </div>
        <div className={styles.safeNotice}>
          <ShieldAlert size={14} /> Export excludes credentials, passwords, MFA/recovery values, session tokens, IP/device fingerprints, hidden tests, other users and backups.
        </div>
        <label>
          Type DELETE for irreversible primary-store deletion
          <input autoComplete="off" onChange={(event) => setConfirmation(event.target.value)} value={confirmation} />
        </label>
        <button className="button button-secondary" disabled={busy || confirmation !== "DELETE"} onClick={() => void deleteAccount()} type="button">
          <Trash2 size={14} /> Delete learner account
        </button>
        <p className={styles.safeNotice}>
          <ShieldAlert size={14} /> Deletion creates a pseudonymous tombstone. Existing encrypted restore points age out under 7 daily / 4 weekly / 12 monthly retention; this action does not claim immediate backup erasure.
        </p>
      </div>
    </article>
  );
}
