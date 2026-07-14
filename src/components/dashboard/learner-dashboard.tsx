import Link from "next/link";
import {
  ArrowRight,
  BookOpenCheck,
  BrainCircuit,
  CalendarClock,
  ChevronRight,
  CirclePlay,
  Clock3,
  Flame,
  Gauge,
  MessageCircleMore,
  Sparkles,
  Target,
  Trophy,
  Zap
} from "lucide-react";
import { community, courses, learner, reviews, weeklyActivity } from "@/lib/demo-data";
import styles from "./learner-dashboard.module.css";

const maxActivity = Math.max(...weeklyActivity);

export function LearnerDashboard() {
  return (
    <div className={styles.dashboard}>
      <section className={styles.greeting}>
        <div>
          <span className={styles.eyebrow}>SUNDAY · YOUR LEARNING HOME</span>
          <h1>Good evening, {learner.firstName}. <span>Ready for one good step?</span></h1>
          <p>Your roadmap found a 22-minute session that balances a weak spot with something new.</p>
        </div>
        <div className={styles.greetingMeta}>
          <span><Flame size={17} /> <strong>{learner.streak} days</strong> streak</span>
          <span><Clock3 size={17} /> <strong>{learner.weeklyMinutes} min</strong> this week</span>
        </div>
      </section>

      <section className={styles.primaryGrid}>
        <article className={styles.continueCard}>
          <div className={styles.continueTop}>
            <span className={styles.courseGlyph}>PY</span>
            <span className={styles.livePill}><i /> RECOMMENDED NEXT</span>
            <span className={styles.duration}><Clock3 size={14} /> 22 min</span>
          </div>
          <div className={styles.continueCopy}>
            <span>PYTHON · STRINGS</span>
            <h2>Transforming text without losing your place</h2>
            <p>Start with a quick review of indexing, then build a small recipe formatter using slices and methods.</p>
          </div>
          <div className={styles.sessionPlan}>
            <span><b>1</b><i>Review</i><small>3 min</small></span>
            <em />
            <span><b>2</b><i>Learn</i><small>6 min</small></span>
            <em />
            <span><b>3</b><i>Practice</i><small>8 min</small></span>
            <em />
            <span><b>4</b><i>Challenge</i><small>5 min</small></span>
          </div>
          <div className={styles.continueActions}>
            <Link className="button button-primary" href="/courses/python/skills/string-transformations">
              <CirclePlay size={18} fill="currentColor" /> Continue learning
            </Link>
            <button className="button button-ghost" type="button">Choose something else</button>
          </div>
          <div className={styles.continueDecoration}><span>&quot;hello&quot;</span><span>[1:4]</span><span>.upper()</span></div>
        </article>

        <aside className={`${styles.reviewCard} card`}>
          <div className={styles.cardTitle}>
            <div><CalendarClock size={19} /><span><strong>Review queue</strong><small>Built for retention</small></span></div>
            <span className={styles.countPill}>{reviews.length}</span>
          </div>
          <div className={styles.reviewList}>
            {reviews.map((review) => (
              <Link href={`/review/${review.id}`} key={review.id}>
                <span className={styles.reviewDot} style={{ "--confidence": `${review.confidence}%` } as React.CSSProperties} />
                <span><strong>{review.title}</strong><small>{review.course} · {review.due}</small></span>
                <ChevronRight size={15} />
              </Link>
            ))}
          </div>
          <Link className={styles.reviewAll} href="/review">Review all due skills <ArrowRight size={15} /></Link>
        </aside>
      </section>

      <section className={styles.statsGrid} aria-label="Learning summary">
        <article className="card"><span className={styles.statIcon}><Target size={19} /></span><div><strong>{learner.mastery}%</strong><small>Current mastery</small></div><em>+6% this month</em></article>
        <article className="card"><span className={styles.statIcon}><BookOpenCheck size={19} /></span><div><strong>28</strong><small>Skills demonstrated</small></div><em>4 review due</em></article>
        <article className="card"><span className={styles.statIcon}><Zap size={19} /></span><div><strong>{learner.xp.toLocaleString()}</strong><small>Verified XP</small></div><em>Level {learner.level}</em></article>
        <article className="card"><span className={styles.statIcon}><Gauge size={19} /></span><div><strong>74%</strong><small>Independent attempts</small></div><em>Healthy range</em></article>
      </section>

      <section className={styles.sectionBlock}>
        <div className={styles.sectionTitle}>
          <div><span>YOUR ROADMAP</span><h2>Courses in motion</h2></div>
          <Link href="/roadmap">Open full roadmap <ArrowRight size={15} /></Link>
        </div>
        <div className={styles.courseGrid}>
          {courses.map((course) => (
            <article className={`${styles.courseCard} ${styles[course.accent]} card`} key={course.id}>
              <div className={styles.courseHeader}><span>{course.shortCode}</span><i>{course.status.replace("_", " ")}</i></div>
              <h3>{course.title}</h3>
              <p>{course.description}</p>
              <div className={styles.courseProgress}>
                <div><span>Progress</span><strong>{course.progress}%</strong></div>
                <div className={styles.progressTrack}><span style={{ width: `${course.progress}%` }} /></div>
                <small>{course.mastered} of {course.total} skills mastered</small>
              </div>
              <Link href={`/courses/${course.id}`}>
                <span><small>Next</small><strong>{course.nextSkill}</strong></span><ArrowRight size={17} />
              </Link>
            </article>
          ))}
        </div>
      </section>

      <section className={styles.lowerGrid}>
        <article className={`${styles.activityCard} card`}>
          <div className={styles.cardTitle}><div><Trophy size={19} /><span><strong>Learning rhythm</strong><small>Meaningful minutes, not app-open time</small></span></div><span className="pill">THIS WEEK</span></div>
          <div className={styles.activityChart}>
            {weeklyActivity.map((value, index) => (
              <div key={index}><span style={{ height: `${Math.max(12, (value / maxActivity) * 100)}%` }}><b>{value}</b></span><small>{["M", "T", "W", "T", "F", "S", "S"][index]}</small></div>
            ))}
          </div>
          <p><Sparkles size={15} /> You retain more after sessions between 20 and 35 minutes. Today&apos;s plan matches that pattern.</p>
        </article>

        <article className={`${styles.communityCard} card`}>
          <div className={styles.cardTitle}><div><Trophy size={19} /><span><strong>Cohort highlights</strong><small>Private weekly leaderboard</small></span></div><Link href="/community">View all</Link></div>
          <div className={styles.communityList}>
            {community.map((person) => (
              <div className={person.current ? styles.currentPerson : ""} key={person.name}>
                <b>#{person.rank}</b><span className={styles.personAvatar}>{person.initials}</span><span><strong>{person.name}{person.current && " (you)"}</strong><small>{person.highlight}</small></span><span className={styles.personScore}><strong>{person.xp}</strong><small>{person.streak} day streak</small></span>
              </div>
            ))}
          </div>
        </article>
      </section>

      <button aria-label="Ask Codestead, grounded in your current lesson" className={styles.tutorButton} type="button"><BrainCircuit size={21} /><span><strong>Ask Codestead</strong><small>Your friendly, course-grounded mentor</small></span><MessageCircleMore size={17} /></button>
    </div>
  );
}
