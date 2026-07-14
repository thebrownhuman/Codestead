"use client";

import { Award, RefreshCw, ShieldAlert } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import styles from "@/components/milestones/milestones.module.css";

type Certificate = {
  id: string;
  verificationId: string;
  learnerDisplayName: string;
  learnerEmail: string;
  courseTitle: string;
  courseVersion: string;
  policyVersion: string;
  issuedAt: string;
  status: "valid" | "revoked";
  revokedAt: string | null;
  revocationReason: string | null;
  verificationPath: string;
};

export function AdminCertificateManager() {
  const [certificates, setCertificates] = useState<Certificate[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    const response = await fetch("/api/admin/certificates", { cache: "no-store" });
    const body = await response.json() as { certificates?: Certificate[]; error?: string };
    if (!response.ok || !body.certificates) throw new Error(body.error ?? "CERTIFICATE_LOAD_FAILED");
    setCertificates(body.certificates);
  }, []);

  useEffect(() => {
    let active = true;
    void fetch("/api/admin/certificates", { cache: "no-store" })
      .then(async (response) => {
        const body = await response.json() as { certificates?: Certificate[]; error?: string };
        if (!response.ok || !body.certificates) throw new Error(body.error ?? "CERTIFICATE_LOAD_FAILED");
        if (active) setCertificates(body.certificates);
      })
      .catch((cause: unknown) => {
        if (active) setError(cause instanceof Error ? cause.message : "CERTIFICATE_LOAD_FAILED");
      });
    return () => { active = false; };
  }, []);

  async function revoke() {
    if (!selectedId || reason.trim().length < 8) {
      setError("Enter an administrative reason of at least 8 characters.");
      return;
    }
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const response = await fetch(`/api/admin/certificates/${selectedId}/revoke`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestId: crypto.randomUUID(), reason: reason.trim() }),
      });
      const body = await response.json() as { error?: string };
      if (!response.ok) throw new Error(body.error ?? "CERTIFICATE_REVOCATION_FAILED");
      await load();
      setSelectedId(null);
      setReason("");
      setMessage("Certificate revoked. Its public verifier now shows only the revoked state; the reason stays private.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "CERTIFICATE_REVOCATION_FAILED");
    } finally {
      setBusy(false);
    }
  }

  const validCount = certificates?.filter((certificate) => certificate.status === "valid").length ?? 0;
  return <div className={styles.page}>
    <header className={styles.hero}>
      <div>
        <span className={styles.eyebrow}>Certificate integrity desk</span>
        <h1>Revoke the proof, preserve the reason.</h1>
        <p>Certificates are immutable completion evidence. Revocation is a separate, reasoned administrator event; public verification never exposes the private reason.</p>
      </div>
      <div className={styles.heroActions}>
        <button className="button button-secondary" onClick={() => void load().catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "CERTIFICATE_LOAD_FAILED"))} type="button">
          <RefreshCw size={15} /> Refresh
        </button>
      </div>
    </header>
    <aside className={styles.notice}>
      <ShieldAlert size={19} />
      <span><strong>{validCount} valid</strong> of {certificates?.length ?? 0} issued certificates. Every revocation is idempotent, audit logged, and permanent for this certificate record.</span>
    </aside>
    <div aria-live="polite">{error ? <p className={styles.error}>{error}</p> : null}{message ? <p className={styles.success}>{message}</p> : null}</div>
    <section className={`${styles.panel} card`}>
      <div className={styles.panelHead}><div><h2>Issued evidence</h2><p>Learner identity is visible only in this administrator view.</p></div></div>
      {certificates === null ? <p>Loading certificates…</p> : certificates.length === 0 ? <div className={styles.empty}><div><span><Award size={28} /></span><h3>No certificates issued</h3><p>Eligible learners issue certificates from their own completion page.</p></div></div> : <div className={styles.certificateList}>
        {certificates.map((certificate) => <article className={`${styles.certificateCard} card`} data-status={certificate.status} key={certificate.id}>
          <span className={styles.seal}><Award size={25} /></span>
          <div>
            <h3>{certificate.courseTitle} · {certificate.courseVersion}</h3>
            <p>{certificate.learnerDisplayName} · {certificate.learnerEmail}</p>
            <small>Issued {new Date(certificate.issuedAt).toLocaleString()} · {certificate.status}</small>
            {certificate.revocationReason ? <small>Private reason: {certificate.revocationReason}</small> : null}
          </div>
          {certificate.status === "valid" ? <button className={`button button-secondary ${styles.revokeButton}`} onClick={() => { setSelectedId(certificate.id); setReason(""); setError(null); setMessage(null); }} type="button">Review revocation</button> : <a className="button button-secondary" href={certificate.verificationPath} rel="noreferrer" target="_blank">View public state</a>}
          {selectedId === certificate.id ? <div className={styles.revocationForm}>
            <label htmlFor={`reason-${certificate.id}`}>Private administrative reason</label>
            <textarea autoFocus id={`reason-${certificate.id}`} maxLength={1000} onChange={(event) => setReason(event.target.value)} placeholder="Describe the verified basis for revocation…" value={reason} />
            <p>This action cannot be undone. The public page will show “revoked” without this reason.</p>
            <div className={styles.actions}>
              <button className="button button-secondary" disabled={busy} onClick={() => { setSelectedId(null); setReason(""); }} type="button">Cancel</button>
              <button className={`button button-primary ${styles.revokeButton}`} disabled={busy || reason.trim().length < 8} onClick={() => void revoke()} type="button">{busy ? "Revoking…" : "Confirm permanent revocation"}</button>
            </div>
          </div> : null}
        </article>)}
      </div>}
    </section>
  </div>;
}
