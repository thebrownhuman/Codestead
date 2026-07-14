import Link from "next/link";
import {
  ArrowRight,
  BrainCircuit,
  CheckCircle2,
  ChevronDown,
  Clock3,
  Lock,
  Route,
  Sparkles,
  Target,
} from "lucide-react";
import type { CSSProperties } from "react";

import { RoadmapEmptyState } from "@/components/dashboard/roadmap-empty-state";
import type { CatalogTrackViewState, CourseManifest } from "@/lib/content";
import type { AuthoritativeDashboardData } from "@/lib/dashboard/learner";
import styles from "./product-pages.module.css";

const colors = ["#225e3d", "#326d68", "#7555a7", "#9a4529", "#14677f"];

function readableTrackName(trackId: string) {
  if (trackId.length <= 3) return trackId.toUpperCase();
  return trackId
    .split(/[-_]/u)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

export function RoadmapView({
  courses,
  dashboard,
  futureCatalog = [],
}: {
  courses: readonly CourseManifest[];
  dashboard?: AuthoritativeDashboardData;
  futureCatalog?: readonly CatalogTrackViewState[];
}) {
  const previewMode = !dashboard;
  const previewCourseIds = new Set<string>();
  const previewCourses = courses.filter((course) => {
    if (previewCourseIds.has(course.id)) return false;
    previewCourseIds.add(course.id);
    return true;
  });
  const roadmapCourses = dashboard
    ? dashboard.courses.map((authoritative) => ({
        id: authoritative.id,
        title: authoritative.title,
        authoritative,
        manifest: courses.find((course) => (
          course.id === authoritative.id && course.version === authoritative.contentVersion
        )),
      }))
    : previewCourses.map((manifest) => ({
        id: manifest.id,
        title: manifest.title,
        authoritative: undefined,
        manifest,
      }));
  const continueHref = dashboard?.next?.href ?? `/courses/${roadmapCourses[0]?.id ?? "programming-foundations"}`;
  const authoritativeEmpty = Boolean(
    dashboard && (dashboard.roadmap.state !== "ready" || roadmapCourses.length === 0),
  );
  const selectedTrackCount = dashboard?.roadmap.selectedTrackIds.length ?? 0;
  const trackTitleById = new Map<string, string>([
    ...futureCatalog.map((track) => [track.id, track.title] as const),
    ...courses.map((course) => [course.id, course.title] as const),
  ]);
  const selectedTrackNames = dashboard?.roadmap.selectedTrackIds.map(
    (trackId) => trackTitleById.get(trackId) ?? readableTrackName(trackId),
  ) ?? [];
  const journeyTotals = dashboard?.courses.filter((item) => item.progressState === "verified").reduce(
    (total, item) => ({ mastered: total.mastered + item.mastered, skills: total.skills + item.total }),
    { mastered: 0, skills: 0 },
  );
  const journeyProgress = journeyTotals?.skills
    ? Math.min(100, Math.max(0, Math.round((journeyTotals.mastered / journeyTotals.skills) * 100)))
    : 0;

  return (
    <div className={styles.page}>
      <header className={styles.pageHead}>
        <div>
          <span className={styles.eyebrow}>Adaptive learning plan</span>
          <h1>Your roadmap, with honest gates.</h1>
          <p>
            The sequence changes when evidence says you need review or can skip ahead. An
            administrator can edit the plan, but no edit rewrites your learning history.
          </p>
        </div>
        <div className={styles.headActions}>
          <Link className="button button-secondary" href="/requests">
            Request a change
          </Link>
          {dashboard && !authoritativeEmpty ? (
            <Link className="button button-primary" href={continueHref}>
              Continue plan <ArrowRight size={16} />
            </Link>
          ) : previewMode && roadmapCourses.length ? (
            <Link className="button button-primary" href={continueHref}>
              Browse first course <ArrowRight size={16} />
            </Link>
          ) : null}
        </div>
      </header>

      {previewMode ? (
        <aside className={styles.previewNotice} aria-label="Curriculum preview data">
          <strong>Curriculum preview only</strong>
          <span>No learner is signed in, so progress, mastery, streaks, and review counts remain at zero.</span>
        </aside>
      ) : null}

      <section className={styles.stats}>
        <article className={`${styles.stat} card`}>
          <span><Route size={18} /></span>
          <div><strong>{selectedTrackCount}</strong><small>selected tracks</small></div>
        </article>
        <article className={`${styles.stat} card`}>
          <span><Target size={18} /></span>
          <div><strong>{dashboard?.masteredSkills ?? 0}</strong><small>skills demonstrated</small></div>
        </article>
        <article className={`${styles.stat} card`}>
          <span><Clock3 size={18} /></span>
          <div>
            <strong>{dashboard?.meaningfulThisWeek ?? 0}</strong>
            <small>meaningful actions this week</small>
          </div>
        </article>
        <article className={`${styles.stat} card`}>
          <span><BrainCircuit size={18} /></span>
          <div><strong>{dashboard?.reviewsDueCount ?? 0}</strong><small>reviews due</small></div>
        </article>
      </section>

      <div className={styles.sectionTitle}>
        <div>
          <h2>Current learning path</h2>
          <p>Prerequisites are inserted even when you select an advanced destination.</p>
        </div>
        <span className="pill"><Sparkles size={13} /> Policy v1</span>
      </div>

      {!authoritativeEmpty ? (
        <section
          aria-label="Interactive course journey"
          className={styles.roadmap}
          style={{ "--journey-progress": `${journeyProgress}%` } as CSSProperties}
        >
          {roadmapCourses.map((entry, index) => {
            const { authoritative, manifest: course } = entry;
            const adminRevision = authoritative?.planRevision?.source.startsWith("admin")
              ? authoritative.planRevision
              : null;
            const locked = authoritative?.status === "planned";
            const progress = authoritative?.progress ?? 0;
            const progressAvailable = authoritative?.progressState === "verified";
            const state = locked ? "locked" : progressAvailable && progress >= 100 ? "completed" : progressAvailable && progress > 0 ? "current" : "ready";
            const modules = course?.modules ?? [];

            return (
            <article
              className={`${styles.roadmapCard} ${locked ? styles.locked : ""} card`}
              data-state={state}
              key={authoritative?.enrollmentId ?? `${entry.id}:${course?.version ?? "preview"}`}
              style={{ "--track-color": colors[index % colors.length] } as CSSProperties}
            >
              <span className={styles.trackIcon}>{entry.id.slice(0, 3).toUpperCase()}</span>
              <div className={styles.trackCopy}>
                <span>Stage {index + 1} · {authoritative?.stage ?? course?.status ?? "unavailable"}</span>
                <h3>{entry.title}</h3>
                {course ? (
                  <p>{modules.length} modules · {authoritative?.total ?? course.coverage_summary.total_skills} evidence-linked skills</p>
                ) : (
                  <p>Enrollment version {authoritative?.contentVersion} is not present in this curriculum snapshot.</p>
                )}
                {adminRevision ? (
                  <aside className={styles.adminPlanNotice} aria-label="Mentor plan update">
                    <strong>Mentor plan revision {adminRevision.revision}</strong>
                    <span>{adminRevision.reason}</span>
                    <small>Your evidence and prerequisite gates were preserved.</small>
                  </aside>
                ) : null}
              </div>
              {progressAvailable ? (
                <div
                  aria-label={`${entry.title} verified progress`}
                  aria-valuemax={100}
                  aria-valuemin={0}
                  aria-valuenow={progress}
                  className={styles.trackProgress}
                  role="progressbar"
                >
                  <span><b>{locked ? "Locked by prerequisites" : "Verified progress"}</b><b>{progress}%</b></span>
                  <div><i style={{ width: `${progress}%` }} /></div>
                </div>
              ) : (
                <div className={styles.trackProgress}>
                  <span><b>{previewMode ? "Preview data" : "Progress unavailable"}</b></span>
                  <small>{previewMode ? "No learner evidence is shown." : "An exact versioned manifest is required."}</small>
                </div>
              )}
              <div className={styles.trackActions}>
                {locked ? (
                  <span className={styles.gate}><Lock size={13} /> Pass prior required concepts</span>
                ) : (
                  <Link className="button button-secondary" href={`/courses/${entry.id}`}>
                    {previewMode ? "Preview course" : progressAvailable && progress ? "Resume" : "Open course status"}<ArrowRight size={14} />
                  </Link>
                )}
              </div>
              {course ? <details className={styles.levelExplorer}>
                <summary>
                  <span>Explore {modules.length} {modules.length === 1 ? "level" : "levels"}</span>
                  <ChevronDown aria-hidden="true" size={16} />
                </summary>
                <ol>
                  {modules.map((module, moduleIndex) => (
                    <li key={module.id}>
                      <span aria-hidden="true">{moduleIndex + 1}</span>
                      <div>
                        <strong>{module.title}</strong>
                        <small>
                          {(module.skills?.length ?? 0)} evidence-linked {(module.skills?.length ?? 0) === 1 ? "skill" : "skills"}
                          {module.required === false ? " · elective" : " · required"}
                        </small>
                      </div>
                    </li>
                  ))}
                </ol>
              </details> : null}
            </article>
            );
          })}
        </section>
      ) : dashboard ? (
        <section aria-label="Roadmap setup status" className={styles.roadmapEmptySection}>
          <RoadmapEmptyState roadmap={dashboard.roadmap} />
          {dashboard.roadmap.state === "awaiting_publication"
            && dashboard.roadmap.selectedTrackPreviews.length === 0
            && selectedTrackNames.length ? (
            <aside className={styles.awaitingTrackSummary} aria-label="Selected courses awaiting publication">
              <div>
                <strong>
                  {selectedTrackNames.length} selected {selectedTrackNames.length === 1 ? "course" : "courses"}
                </strong>
                <span>A reviewed beta or verified publication is required before a learning plan can begin.</span>
              </div>
              <ul>
                {selectedTrackNames.map((title, index) => (
                  <li key={`${dashboard.roadmap.selectedTrackIds[index]}-${title}`}>{title}</li>
                ))}
              </ul>
            </aside>
          ) : null}
        </section>
      ) : null}

      {futureCatalog.length ? (
        <>
          <div className={styles.sectionTitle}>
            <div>
              <h2>Coming Soon</h2>
              <p>Approved scope previews only. These tracks contain no lessons or exams yet.</p>
            </div>
            <span className="pill"><Lock size={13} /> Roadmap only</span>
          </div>
          <section className={styles.roadmap} aria-label="Coming Soon curriculum catalog">
            {futureCatalog.map((track, index) => (
              <article
                className={`${styles.roadmapCard} ${styles.locked} card`}
                data-access={track.access}
                key={track.id}
                style={{ "--track-color": colors[index % colors.length] } as CSSProperties}
              >
                <span className={styles.trackIcon}>{track.id.slice(0, 3).toUpperCase()}</span>
                <div className={styles.trackCopy}>
                  <span>Coming Soon · {track.release}</span>
                  <h3>{track.title}</h3>
                  <p>{track.scopeBrief}</p>
                  <small>
                    Prerequisite{track.prerequisites.length === 1 ? "" : "s"}: {track.prerequisites.join(" + ") || "none"}
                  </small>
                </div>
                <div className={styles.trackActions}>
                  <span className={styles.gate}><Lock size={13} /> {track.reason}</span>
                </div>
              </article>
            ))}
          </section>
        </>
      ) : null}

      <div className={`${styles.sideCard} card`}>
        <h3><CheckCircle2 size={15} /> What mastery means here</h3>
        <p>
          80% can unlock the next topic when all critical criteria pass. A 95%+ independent mastery
          exam awards the profile badge. Delayed reviews can move a skill back to “needs review”—that
          is healthy, not punishment.
        </p>
      </div>
    </div>
  );
}
