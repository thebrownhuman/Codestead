import { BadgeCheck, ShieldAlert, ShieldCheck } from "lucide-react";

import type { loadPublicCertificate } from "@/lib/certificates/service";

import { PrintCertificateButton } from "./print-certificate-button";
import styles from "./milestones.module.css";

type Certificate = Awaited<ReturnType<typeof loadPublicCertificate>>;

export function CertificateVerifier({ certificate }: { readonly certificate: Certificate }) {
  const valid = certificate.status === "valid";
  return (
    <main className={styles.verifier}>
      <article className={styles.certificateSheet} data-status={certificate.status}>
        <header>
          <span className={styles.eyebrow}>Codestead verified record</span>
          <span className={styles.status}>{valid ? <ShieldCheck aria-hidden="true" size={15} /> : <ShieldAlert aria-hidden="true" size={15} />}{certificate.status}</span>
        </header>
        <section className={styles.certificateBody}>
          <span className={styles.seal}><BadgeCheck aria-hidden="true" size={27} /></span>
          <p>This certifies that</p>
          <h1>{certificate.learnerDisplayName}</h1>
          <p>completed the verified mastery requirements for</p>
          <h2>{certificate.courseTitle}</h2>
          <p>Course version {certificate.courseVersion} · issued {new Date(certificate.issuedAt).toLocaleDateString()}</p>
          <p>{certificate.statement}</p>
        </section>
        <footer>
          <p>Verification ID<br />{certificate.verificationId}</p>
          <p>Status checked from the authoritative record<br />{certificate.revokedAt ? `Revoked ${new Date(certificate.revokedAt).toLocaleDateString()}` : "Valid"}</p>
        </footer>
      </article>
      <div className={styles.printButton}><PrintCertificateButton /></div>
    </main>
  );
}
