"use client";

import { Award, BadgeCheck, ExternalLink, RefreshCw, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import styles from "./milestones.module.css";

type Certificate = {
  id: string; verificationId: string; learnerDisplayName: string; courseTitle: string;
  courseVersion: string; issuedAt: string; status: "valid" | "revoked"; revokedAt: string | null;
  revocationReason: string | null; verificationPath: string;
};
type Candidate = {
  enrollmentId: string; courseTitle: string; courseVersion: string; enrollmentStatus: string;
  masteredConcepts: number; totalConcepts: number; eligible: boolean; alreadyIssued: boolean; reason: string;
};

export function CertificateManager() {
  const [certificates, setCertificates] = useState<Certificate[]>([]);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [loading, setLoading] = useState(true);
  const [issuing, setIssuing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/certificates", { cache: "no-store" });
      const body = await response.json() as { certificates?: Certificate[]; candidates?: Candidate[]; error?: string };
      if (!response.ok) throw new Error(body.error ?? "CERTIFICATE_LOAD_FAILED");
      setCertificates(body.certificates ?? []);
      setCandidates(body.candidates ?? []);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "CERTIFICATE_LOAD_FAILED");
    } finally { setLoading(false); }
  }, []);

  useEffect(() => {
    let active = true;
    void fetch("/api/certificates", { cache: "no-store" })
      .then(async (response) => {
        const body = await response.json() as { certificates?: Certificate[]; candidates?: Candidate[]; error?: string };
        if (!response.ok) throw new Error(body.error ?? "CERTIFICATE_LOAD_FAILED");
        if (!active) return;
        setCertificates(body.certificates ?? []);
        setCandidates(body.candidates ?? []);
      })
      .catch((loadError: unknown) => {
        if (active) setError(loadError instanceof Error ? loadError.message : "CERTIFICATE_LOAD_FAILED");
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  async function issue(enrollmentId: string) {
    setIssuing(enrollmentId);
    setError(null);
    setMessage(null);
    try {
      const response = await fetch("/api/certificates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestId: crypto.randomUUID(), enrollmentId }),
      });
      const body = await response.json() as { error?: string };
      if (!response.ok) throw new Error(body.error ?? "CERTIFICATE_ISSUE_FAILED");
      setMessage("Verified certificate issued. Its evidence snapshot is now immutable.");
      await load();
    } catch (issueError) {
      setError(issueError instanceof Error ? issueError.message : "CERTIFICATE_ISSUE_FAILED");
    } finally { setIssuing(null); }
  }

  return (
    <div className={styles.page}>
      <header className={styles.hero}>
        <div>
          <span className={styles.eyebrow}>Evidence-backed credentials</span>
          <h1>Proof you earned, not a participation PDF.</h1>
          <p>Certificates can be issued only for the current verified course version after completion and mastery evidence pass every gate.</p>
        </div>
        <div className={styles.heroActions}>
          <button className="button button-secondary" disabled={loading} onClick={() => void load()} type="button">
            <RefreshCw aria-hidden="true" size={16} /> Refresh evidence
          </button>
        </div>
      </header>
      <aside className={styles.notice}><ShieldCheck aria-hidden="true" size={19} /><span>The public verifier shows only your certificate display name, course, version, issue date, and validity. Scores and mastery details remain private.</span></aside>
      <div aria-live="polite">{error ? <p className={styles.error}>{error}</p> : null}{message ? <p className={styles.success}>{message}</p> : null}</div>

      <section className={`${styles.panel} card`}>
        <div className={styles.panelHead}><div><h2>Certificate checkpoints</h2><p>Each row explains exactly why issuance is available or blocked.</p></div></div>
        {loading ? <p>Checking authoritative evidence…</p> : candidates.length ? (
          <ul className={styles.collection}>
            {candidates.map((candidate) => (
              <li className={styles.collectionItem} key={candidate.enrollmentId}>
                <div>
                  <strong>{candidate.courseTitle} · {candidate.courseVersion}</strong>
                  <p>{candidate.reason}</p>
                  <small>{candidate.masteredConcepts}/{candidate.totalConcepts} covered concepts mastered with valid evidence</small>
                </div>
                <button className="button button-primary" disabled={!candidate.eligible || candidate.alreadyIssued || issuing === candidate.enrollmentId} onClick={() => void issue(candidate.enrollmentId)} type="button">
                  <Award aria-hidden="true" size={16} /> {candidate.alreadyIssued ? "Already issued" : issuing === candidate.enrollmentId ? "Issuing…" : "Issue certificate"}
                </button>
              </li>
            ))}
          </ul>
        ) : <p>No enrolled course is currently certificate-eligible.</p>}
      </section>

      <section aria-labelledby="issued-certificates-title" className={styles.certificateList}>
        <div className={styles.panelHead}><div><h2 id="issued-certificates-title">Issued certificates</h2><p>Verification IDs are opaque bearer links. Share them only when you want someone to verify the credential.</p></div></div>
        {!loading && !certificates.length ? (
          <div className={`${styles.empty} card`}><div><span><BadgeCheck aria-hidden="true" size={28} /></span><h2>No certificates yet.</h2><p>Finish a current verified course and its mastery gates first.</p></div></div>
        ) : certificates.map((certificate) => (
          <article className={`${styles.certificateCard} card`} key={certificate.id}>
            <span className={styles.seal}><BadgeCheck aria-hidden="true" size={25} /></span>
            <div>
              <h3>{certificate.courseTitle} · {certificate.courseVersion}</h3>
              <p>{certificate.learnerDisplayName} · issued {new Date(certificate.issuedAt).toLocaleDateString()} · {certificate.status}</p>
              <small className={styles.verificationId}>{certificate.verificationId}</small>
              {certificate.revocationReason ? <small>Private revocation reason: {certificate.revocationReason}</small> : null}
            </div>
            <Link className="button button-secondary" href={certificate.verificationPath} target="_blank">
              Verify / print <ExternalLink aria-hidden="true" size={15} />
            </Link>
          </article>
        ))}
      </section>
    </div>
  );
}
