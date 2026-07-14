import Link from "next/link";
import {
  ArrowRight,
  BrainCircuit,
  CalendarClock,
  Flame,
  RotateCcw,
  ShieldCheck,
} from "lucide-react";

import type { AuthoritativeDashboardData } from "@/lib/dashboard/learner";

import { DailyReview } from "./daily-review";
import styles from "./product-pages.module.css";

export function ReviewQueue({
  admin = false,
  dashboard,
}: {
  readonly admin?: boolean;
  readonly dashboard?: AuthoritativeDashboardData;
}) {
  const visible = dashboard?.reviews ?? [];
  const dueCount = dashboard?.reviewsDueCount ?? visible.length;
  const firstHref = visible[0]?.href;
  if (admin) {
    return (
      <div className={styles.page}>
        <section className={`${styles.adminReviewCallout} card`}>
          <span>
            <strong>Looking for course editorial review?</strong>
            <small>This learner queue refreshes memory; it does not approve draft lessons or assessments.</small>
          </span>
          <Link className="button button-primary" href="/admin/curriculum">
            Open course review <ArrowRight size={14} />
          </Link>
        </section>
        <ReviewQueue dashboard={dashboard} />
      </div>
    );
  }
  return (
    <div className={styles.page}>
      <header className={styles.pageHead}>
        <div>
          <span className={styles.eyebrow}>Learner spaced retrieval</span>
          <h1>Review what is almost slipping.</h1>
          <p>This is your personal memory-practice queue. Curriculum editorial review is a separate administrator workflow.</p>
        </div>
        {dashboard ? (
          <Link className="button button-primary" href="#daily-review"><RotateCcw size={16} /> Start daily five</Link>
        ) : firstHref ? (
          <Link className="button button-primary" href={firstHref}><RotateCcw size={16} /> Start review</Link>
        ) : (
          <Link className="button button-secondary" href="/learn">Nothing due · return home</Link>
        )}
      </header>

      {!dashboard ? (
        <aside className={styles.previewNotice} aria-label="Review preview data">
          <strong>Review preview only</strong>
          <span>No learner is signed in, so no sample reviews or fabricated learning statistics are shown.</span>
        </aside>
      ) : null}

      <section className={styles.stats}>
        <article className={`${styles.stat} card`}><span><CalendarClock size={18} /></span><div><strong>{dueCount}</strong><small>skills due</small></div></article>
        <article className={`${styles.stat} card`}><span><BrainCircuit size={18} /></span><div><strong>{dashboard?.averageConfidencePercent ?? 0}%</strong><small>average confidence</small></div></article>
        <article className={`${styles.stat} card`}><span><Flame size={18} /></span><div><strong>{dashboard?.streak ?? 0} days</strong><small>retention streak</small></div></article>
        <article className={`${styles.stat} card`}><span><ShieldCheck size={18} /></span><div><strong>{dashboard?.masteryPercent ?? 0}%</strong><small>evidence-weighted mastery</small></div></article>
      </section>

      <DailyReview enabled={Boolean(dashboard)} />

      <section className={styles.reviewLayout}>
        <div className={styles.reviewList}>
          {visible.length ? visible.map((item) => (
            <article className={`${styles.reviewItem} card`} key={item.id}>
              <span className={styles.reviewRing} data-label={`${item.confidence}%`} style={{ "--value": `${item.confidence}%` } as React.CSSProperties} />
              <span><strong>{item.title}</strong><small>{item.course} · {item.due} · {item.reason}</small></span>
              <Link className="button button-secondary" href={item.href}>Review <ArrowRight size={14} /></Link>
            </article>
          )) : (
            <article className={`${styles.reviewItem} card`}><span><strong>No review is due.</strong><small>Your persisted spaced-repetition schedule is clear.</small></span></article>
          )}
        </div>
        <aside className={styles.sideStack}>
          <div className={`${styles.sideCard} card`}>
            <h3>How today was chosen</h3>
            <ul>
              <li>Confirmed misconceptions first</li>
              <li>Overdue memory checks next</li>
              <li>Lowest-confidence reviewed skills after that</li>
              <li>Exactly five distinct skills or an honest unavailable state</li>
            </ul>
          </div>
          <div className={`${styles.sideCard} card`}>
            <h3>Nothing is “lost”</h3>
            <p>A skill moving to needs-review preserves the old evidence. The new result simply changes what is useful to practice next.</p>
          </div>
        </aside>
      </section>
    </div>
  );
}
