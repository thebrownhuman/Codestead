import { ArrowUpRight, CheckCircle2, CircleDashed, Compass, LockKeyhole, Route, ShieldCheck } from "lucide-react";

import type { listLearnerCareerRecommendations } from "@/lib/career/service";

import styles from "./milestones.module.css";

type CareerGuidance = Awaited<ReturnType<typeof listLearnerCareerRecommendations>>;

const readinessIcon = {
  ready: CheckCircle2,
  building: CircleDashed,
  explore: Compass,
  locked: LockKeyhole,
} as const;

export function CareerGuidanceView({ guidance }: { readonly guidance: CareerGuidance }) {
  return (
    <div className={styles.page}>
      <header className={styles.hero}>
        <div>
          <span className={styles.eyebrow}>Verified next steps</span>
          <h1>Career trails, without the crystal ball.</h1>
          <p>
            Explore administrator-reviewed paths. Readiness comes only from your current verified
            enrollments and mastery evidence; market notes expire instead of quietly going stale.
          </p>
        </div>
      </header>

      <aside className={styles.notice}>
        <ShieldCheck aria-hidden="true" size={19} />
        <span><strong>How this is ranked:</strong> {guidance.basis}</span>
      </aside>

      {!guidance.available ? (
        <section className={`${styles.empty} card`}>
          <div>
            <span><Route aria-hidden="true" size={28} /></span>
            <h2>Reviewed trails are still being mapped.</h2>
            <p>{guidance.emptyMessage}</p>
          </div>
        </section>
      ) : (
        <section aria-label="Career recommendations" className={styles.trail}>
          {guidance.recommendations.map((card) => {
            const Icon = readinessIcon[card.readiness as keyof typeof readinessIcon] ?? Compass;
            return (
              <article className={`${styles.careerCard} card`} data-readiness={card.readiness} key={card.id}>
                <div className={styles.careerTop}>
                  <div>
                    <div className={styles.routeLabel}><Route aria-hidden="true" size={14} /><span>{card.path}</span> / {card.technology}</div>
                    <h2>{card.title}</h2>
                  </div>
                  <span className={styles.status}><Icon aria-hidden="true" size={14} /> {card.readiness}</span>
                </div>
                <p>{card.summary}</p>
                <div className={styles.careerGrid}>
                  <section className={styles.careerSection}>
                    <h3>Evidence checkpoint</h3>
                    <p>{card.readinessReason}</p>
                    {card.prerequisiteEvidence.length ? (
                      <ul className={styles.evidenceList}>
                        {card.prerequisiteEvidence.map((item) => (
                          <li key={item.courseId}>
                            {item.satisfied ? <CheckCircle2 aria-hidden="true" size={16} /> : <CircleDashed aria-hidden="true" size={16} />}
                            <div>
                              <strong>{item.courseTitle}{item.version ? ` · ${item.version}` : ""}</strong>
                              <small>{item.rationale}</small>
                            </div>
                            <b>{item.masteredConcepts}/{item.totalConcepts}</b>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </section>
                  <section className={styles.careerSection}>
                    <h3>Where this can lead</h3>
                    <p>{card.futureScope}</p>
                    {card.market ? (
                      <>
                        <h3>Time-bounded market note · {card.market.region}</h3>
                        <p>{card.market.claim}</p>
                        <a className={styles.marketSource} href={card.market.sourceUrl} rel="noreferrer" target="_blank">
                          Review source <ArrowUpRight aria-hidden="true" size={15} />
                        </a>
                        <small>Observed {new Date(card.market.observedAt).toLocaleDateString()} · reviewed {new Date(card.market.reviewedAt).toLocaleDateString()} · expires {new Date(card.market.expiresAt).toLocaleDateString()}</small>
                      </>
                    ) : card.marketNotice ? <p>{card.marketNotice}</p> : <p>No market-demand claim is published for this path.</p>}
                  </section>
                </div>
              </article>
            );
          })}
        </section>
      )}
    </div>
  );
}
