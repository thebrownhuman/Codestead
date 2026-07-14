import Link from "next/link";
import { CheckCircle2, LockKeyhole, Sparkles } from "lucide-react";

import { BrandMark } from "@/components/brand-mark";
import styles from "./auth.module.css";

export function AuthShell({
  eyebrow,
  title,
  description,
  children,
}: {
  eyebrow: string;
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <main className={styles.authPage} id="main-content" tabIndex={-1}>
      <section className={styles.storyPanel} aria-label="Codestead promise">
        <Link href="/" aria-label="Codestead home"><BrandMark /></Link>
        <div className={styles.storyCopy}>
          <span className={styles.storyEyebrow}><Sparkles size={15} /> A mentor that remembers how you learn</span>
          <h1>Build skills<br /><em>that stay.</em></h1>
          <p>Learn through explanations, runnable practice, visual models, and honest feedback that adapts to your evidence.</p>
          <div className={styles.promiseList}>
            <span><CheckCircle2 size={18} /><span><strong>Authored curriculum first</strong><small>Your course still works if AI is unavailable.</small></span></span>
            <span><CheckCircle2 size={18} /><span><strong>Practice before answers</strong><small>Hints protect the work that makes learning stick.</small></span></span>
            <span><CheckCircle2 size={18} /><span><strong>Private, invite-only cohort</strong><small>Your code and mistakes are never public by default.</small></span></span>
          </div>
        </div>
        <p className={styles.storyFoot}><LockKeyhole size={14} /> Self-hosted on your private learning server</p>
      </section>
      <section className={styles.formPanel}>
        <div className={styles.mobileBrand}><BrandMark /></div>
        <div className={styles.formCard}>
          <span className={styles.eyebrow}>{eyebrow}</span>
          <h2>{title}</h2>
          <p className={styles.description}>{description}</p>
          {children}
        </div>
        <p className={styles.privacyLine}>By continuing, you agree to the cohort privacy and acceptable-use rules.</p>
      </section>
    </main>
  );
}
