import Link from "next/link";
import {
  ArrowRight,
  BookOpenCheck,
  CalendarClock,
  CheckCircle2,
  CirclePlay,
  Flame,
  Gauge,
  Gem,
  ShieldCheck,
  Sparkles,
  Target,
  Trophy,
  Wrench,
  Zap,
} from "lucide-react";

import type { AuthoritativeDashboardData } from "@/lib/dashboard/learner";
import styles from "./learner-dashboard.module.css";
import { RoadmapEmptyState } from "./roadmap-empty-state";

const courseThemes = ["green", "blue", "violet", "orange", "gold"] as const;

export function AuthoritativeDashboard({ data }: { data: AuthoritativeDashboardData }) {
  const maxActivity = Math.max(1, ...data.weeklyActivity);
  const effectiveRoadmapState = !data.courses.length && data.roadmap.state === "ready"
    ? "unavailable"
    : data.roadmap.state;
  const noNextStep = {
    ready: {
      title: "No next step is ready yet.",
      detail: "Your saved roadmap is available, but no next action could be verified. Open it to review the current gates.",
      href: "/roadmap",
      action: "Open roadmap",
    },
    no_tracks: {
      title: "No courses are selected.",
      detail: "Explore the curriculum catalog first. A roadmap is created only after a track is selected and reviewed content is published.",
      href: "/courses",
      action: "View course catalog",
    },
    awaiting_publication: {
      title: "Your selected courses are awaiting publication.",
      detail: "No reviewed beta or verified publication is available for them yet, so no learning plan has been created.",
      href: "/courses",
      action: "View curriculum previews",
    },
    initialization_required: {
      title: "Create your saved learning plan.",
      detail: "Your selected courses are published, but no saved roadmap exists yet. Create it from the verified setup below.",
      href: "#roadmap-create-action",
      action: "Create roadmap below",
    },
    unavailable: {
      title: "Roadmap status is temporarily unavailable.",
      detail: "We could not verify your saved plan right now. Your progress has not been changed.",
      href: "#roadmap-retry-action",
      action: "Try again below",
    },
  }[effectiveRoadmapState];

  return (
    <div className={styles.dashboard}>
      <section className={styles.greeting}>
        <div>
          <span className={styles.eyebrow}>YOUR LEARNING COMMAND CENTER</span>
          <h1>Welcome back, {data.firstName}. <span>One good step levels up your understanding.</span></h1>
          <p>
            {data.degraded
              ? "Some recommendations are temporarily unavailable; your saved evidence is unchanged."
              : "Every signal comes from saved learning evidence—never decorative progress."}
          </p>
        </div>
        <div className={styles.greetingMeta} aria-label="Current learning momentum">
          <span><Flame size={17} /> <strong>{data.streak} days</strong> streak</span>
          <span><CheckCircle2 size={17} /> <strong>{data.completedLessons}</strong> lessons finished</span>
        </div>
      </section>

      <section className={styles.primaryGrid} aria-label="Today's learning quest">
        <article className={styles.continueCard}>
          <div className={styles.continueTop}>
            <span className={styles.livePill}><i /> TODAY&apos;S EVIDENCE-BASED QUEST</span>
            <span className={styles.questMarker}><Sparkles size={13} /> NEXT</span>
          </div>
          <div className={styles.continueCopy}>
            {data.next ? (
              <>
                <span>{data.next.course}</span>
                <h2>{data.next.title}</h2>
                <p>{data.next.reason}</p>
              </>
            ) : (
              <>
                <span>PLAN STATUS</span>
                <h2>{noNextStep.title}</h2>
                <p>{noNextStep.detail}</p>
              </>
            )}
          </div>
          <div className={styles.questLoop} aria-label="Recommended learning loop">
            <span><b>1</b><i>Learn</i></span><em />
            <span><b>2</b><i>Practice</i></span><em />
            <span><b>3</b><i>Prove it</i></span>
          </div>
          <div className={styles.continueActions}>
            {data.next ? (
              <Link className="button button-primary" href={data.next.href}>
                <CirclePlay aria-hidden="true" size={18} /> Start this quest
              </Link>
            ) : noNextStep.href.startsWith("#") ? (
              <a className="button button-primary" href={noNextStep.href}>{noNextStep.action}</a>
            ) : (
              <Link className="button button-primary" href={noNextStep.href}>{noNextStep.action}</Link>
            )}
            {data.next ? <Link className="button button-ghost" href="/roadmap">See the full path</Link> : null}
          </div>
          <div aria-hidden="true" className={styles.continueDecoration}>
            <span>{"{ learn }"}</span><span>{"[ practice ]"}</span><span>{"< build />"}</span>
          </div>
        </article>

        <aside className={`${styles.reviewCard} card`}>
          <div className={styles.cardTitle}>
            <div><CalendarClock size={19} /><span><strong>Daily skill refresh</strong><small>Spaced practice from saved evidence</small></span></div>
            <span className={styles.countPill}>{data.reviewsDueCount}</span>
          </div>
          <div className={styles.reviewList}>
            {data.reviews.length ? data.reviews.slice(0, 4).map((review) => (
              <Link href={review.href} key={review.id}>
                <span className={styles.reviewDot} style={{ "--confidence": `${review.confidence}%` } as React.CSSProperties} aria-hidden="true" />
                <span><strong>{review.title}</strong><small>{review.course} · {review.due}</small></span>
                <ArrowRight size={15} />
              </Link>
            )) : <div className={styles.reviewClear}><CheckCircle2 size={21} /><strong>You are clear for now.</strong><small>New reviews appear only when the stored schedule says they are useful.</small></div>}
          </div>
          <Link className={styles.reviewAll} href="/review">
            Open daily five <ArrowRight size={15} />
          </Link>
        </aside>
      </section>

      <section className={styles.statsGrid} aria-label="Learning summary">
        <article className="card" data-tone="cyan"><span className={styles.statIcon}><Target size={19} /></span><div><strong>{data.masteryPercent}%</strong><small>Evidence-weighted mastery</small></div></article>
        <article className="card" data-tone="violet"><span className={styles.statIcon}><BookOpenCheck size={19} /></span><div><strong>{data.completedLessons}</strong><small>Distinct lessons completed</small></div></article>
        <article className="card" data-tone="amber"><span className={styles.statIcon}><Gauge size={19} /></span><div><strong>{data.averageConfidencePercent}%</strong><small>Average confidence</small></div></article>
        <article className="card" data-tone="coral"><span className={styles.statIcon}><CalendarClock size={19} /></span><div><strong>{data.reviewsDueCount}</strong><small>Reviews due today</small></div></article>
      </section>

      <section aria-labelledby="reward-progress-heading" className={styles.rewardSection}>
        <div className={styles.sectionTitle}>
          <div><span>EVIDENCE REWARDS</span><h2 id="reward-progress-heading">Level progress and challenges</h2></div>
        </div>
        {data.rewards ? (
          <div className={styles.rewardGrid}>
            <article className={`${styles.levelCard} card`}>
              <div className={styles.rewardHeading}>
                <span><Zap aria-hidden="true" size={20} /></span>
                <div><small>Current level</small><strong>Level {data.rewards.level.level}</strong></div>
                <b>{data.rewards.totalXp.toLocaleString()} XP</b>
              </div>
              <progress
                aria-label={`${data.rewards.level.xpIntoLevel} of ${data.rewards.level.xpIntoLevel + data.rewards.level.xpToNextLevel} XP toward the next level`}
                max={Math.max(1, data.rewards.level.xpIntoLevel + data.rewards.level.xpToNextLevel)}
                value={data.rewards.level.xpIntoLevel}
              />
              <p>{data.rewards.level.xpToNextLevel > 0
                ? `${data.rewards.level.xpToNextLevel.toLocaleString()} XP to Level ${data.rewards.level.level + 1}.`
                : "Maximum level reached under the current published level policy."}</p>
              <small>XP comes only from unreversed, independently verified evidence.</small>
            </article>
            {([data.rewards.challenges.weekly, data.rewards.challenges.monthly] as const).map((challenge) => (
              <article className={`${styles.challengeCard} card`} key={challenge.id}>
                <div className={styles.rewardHeading}>
                  <span><Trophy aria-hidden="true" size={20} /></span>
                  <div><small>{challenge.kind} challenge</small><strong>{challenge.title}</strong></div>
                  <b>{challenge.progressPercent}%</b>
                </div>
                <progress
                  aria-label={`${challenge.earnedXp} of ${challenge.targetXp} XP for the ${challenge.kind} challenge`}
                  max={challenge.targetXp}
                  value={challenge.earnedXp}
                />
                <p>{challenge.earnedXp.toLocaleString()} / {challenge.targetXp.toLocaleString()} XP · {challenge.qualifyingRewards} qualifying reward{challenge.qualifyingRewards === 1 ? "" : "s"}</p>
                <small>{challenge.period.startLocalDate} to {challenge.period.endLocalDateExclusive} · {challenge.period.timezone}</small>
              </article>
            ))}
            <aside className={styles.coinPolicy}>
              <Gem aria-hidden="true" size={18} />
              <div><strong>Coins are not enabled</strong><small>{data.rewards.coins.policyNote}</small></div>
            </aside>
          </div>
        ) : (
          <div className={`${styles.rewardUnavailable} card`} role="status">
            <Gauge aria-hidden="true" size={20} />
            <div><strong>Reward progress is temporarily unavailable.</strong><small>No XP, level, challenge, or coin value has been guessed.</small></div>
          </div>
        )}
      </section>

      <section aria-labelledby="learning-plans-heading" className={styles.sectionBlock}>
        <div className={styles.sectionTitle}>
          <div><span>YOUR QUEST MAP</span><h2 id="learning-plans-heading">Your learning plans</h2></div>
          {data.courses.length ? <Link href="/roadmap">Open full roadmap <ArrowRight aria-hidden="true" size={15} /></Link> : null}
        </div>
        {data.courses.length ? (
          <div className={styles.courseGrid}>
            {data.courses.map((item, index) => (
              <article className={`${styles.courseCard} ${styles[courseThemes[index % courseThemes.length]]} card`} key={item.enrollmentId}>
                <div className={styles.courseHeader}>
                  <span>{item.id.slice(0, 3).toUpperCase()}</span>
                  <span className={styles.courseStatuses}><i>{item.status} path</i><i>{item.stage} curriculum</i></span>
                </div>
                <h3>{item.title}</h3>
                <div className={styles.courseProgress}>
                  {item.progressState === "verified" ? (
                    <>
                      <div><span>Verified path fill</span><strong>{item.progress}%</strong></div>
                      <div className={styles.progressTrack}><span style={{ width: `${item.progress}%` }} /></div>
                      <small>{item.mastered} of {item.total} skills proficient or mastered</small>
                    </>
                  ) : (
                    <>
                      <div><span>Progress unavailable</span><strong>—</strong></div>
                      <small>Course version {item.contentVersion} is not available in this curriculum snapshot.</small>
                    </>
                  )}
                </div>
                <Link href={`/courses/${item.id}`}><span><small>Continue</small><strong>Open course path</strong></span><ArrowRight aria-hidden="true" size={17} /></Link>
              </article>
            ))}
          </div>
        ) : <RoadmapEmptyState roadmap={data.roadmap} />}
      </section>

      <section className={styles.signalGrid} aria-labelledby="skill-signals-heading">
        <div className={styles.sectionTitle}>
          <div><span>SKILL RADAR</span><h2 id="skill-signals-heading">What to celebrate and tune up</h2></div>
          <Link href="/review">Open skill refresh <ArrowRight aria-hidden="true" size={15} /></Link>
        </div>
        <article className={`${styles.signalCard} ${styles.strongSignal} card`}>
          <div className={styles.signalHeading}><span><Trophy size={19} /></span><div><strong>Strong signals</strong><small>Proficient or mastered with stored evidence</small></div></div>
          {data.strongTopics.length ? <ul>{data.strongTopics.map((topic) => <li key={topic.id}><span><CheckCircle2 size={14} /> {topic.title}</span><strong>{topic.confidence}% confidence</strong></li>)}</ul> : <p>Complete assessed work to reveal your strongest topics.</p>}
        </article>
        <article className={`${styles.signalCard} ${styles.reviewSignal} card`}>
          <div className={styles.signalHeading}><span><Wrench size={19} /></span><div><strong>Next tune-ups</strong><small>Only topics with prior evidence can appear here</small></div></div>
          {data.needsReviewTopics.length ? <ul>{data.needsReviewTopics.map((topic) => <li key={topic.id}><span><Gauge size={14} /> {topic.title}</span><strong>{topic.reason}</strong></li>)}</ul> : <p>No evidenced topic currently needs a tune-up.</p>}
        </article>
      </section>

      <section className={styles.lowerGrid}>
        <article className={`${styles.activityCard} card`}>
          <div className={styles.cardTitle}><div><Gauge size={19} /><span><strong>Meaningful activity</strong><small>Completions and submissions—not app-open time</small></span></div><span className="pill">LAST 7 UTC DAYS</span></div>
          <div className={styles.activityChart} aria-label={`${data.meaningfulThisWeek} meaningful actions in the last seven UTC days`}>
            {data.weeklyActivity.map((value, index) => <div key={index}><span style={{ height: `${Math.max(8, (value / maxActivity) * 100)}%` }}><b>{value}</b></span><small>{["1", "2", "3", "4", "5", "6", "7"][index]}</small></div>)}
          </div>
        </article>
        <article className={`${styles.communityCard} card`}>
          <div className={styles.cardTitle}><div><ShieldCheck size={19} /><span><strong>Friendly competition, private by default</strong><small>Opt-in cohort profiles and evidence-backed rankings</small></span></div></div>
          <p>Community rankings and profiles stay hidden until you explicitly opt in. Raw code, failures, chat, email, and provider data never appear on the leaderboard.</p>
          <Link className="button button-secondary" href="/community"><Trophy size={16} /> Explore the cohort</Link>
        </article>
      </section>
    </div>
  );
}
