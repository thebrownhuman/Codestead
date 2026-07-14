"use client";

import {
  AlertTriangle,
  ArrowLeft,
  BookOpenCheck,
  CheckCircle2,
  Clock3,
  FolderKanban,
  Gauge,
  HardDrive,
  MessageCircleMore,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import {
  formatBytes,
  formatDateTime,
  formatMinutes,
  formatPercent,
  formatRelativeTime,
  humanize,
  requestAdminJson,
} from "./admin-utils";
import styles from "./admin.module.css";
import { AdminCredentialManager } from "./admin-credential-manager";
import { AdminSessionControls } from "./admin-session-controls";
import { AdminDataLifecycleControls } from "./admin-data-lifecycle-controls";
import { AdminFallbackGrantManager } from "./admin-fallback-grant-manager";
import { AdminInactivityPreferenceManager } from "./admin-inactivity-preference-manager";
import { AdminMentorEvidenceReader } from "./admin-mentor-evidence-reader";
import { AdminPlanRevisionManager } from "./admin-plan-revision-manager";
import { AdminStorageQuotaManager } from "./admin-storage-quota-manager";
import { EmptyState, ErrorState, LoadingState, StatusPill } from "./status-pill";
import type { LearnerDetailData, StatusCount } from "./types";

function initials(name: string): string {
  return name.split(/\s+/).slice(0, 2).map((part) => part[0]?.toUpperCase()).join("") || "L";
}

function InlineCounts({ rows }: { readonly rows: readonly StatusCount[] }) {
  if (!rows.length) return <span className={styles.chip}>No records</span>;
  return <div className={styles.tagList}>{rows.map((row) => <span className={styles.chip} key={row.status}>{humanize(row.status)} · {row.count}</span>)}</div>;
}

export function LearnerDetail({ learnerId }: { readonly learnerId: string }) {
  const [data, setData] = useState<LearnerDetailData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async (signal?: AbortSignal) => {
    setRefreshing(true);
    setError(null);
    try {
      setData(await requestAdminJson<LearnerDetailData>(`/api/admin/dashboard/learners/${encodeURIComponent(learnerId)}`, { signal }));
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === "AbortError") return;
      setError(cause instanceof Error ? cause.message : "Unable to load learner data.");
    } finally {
      setRefreshing(false);
    }
  }, [learnerId]);

  useEffect(() => {
    const controller = new AbortController();
    void requestAdminJson<LearnerDetailData>(
      `/api/admin/dashboard/learners/${encodeURIComponent(learnerId)}`,
      { signal: controller.signal },
    )
      .then(setData)
      .catch((cause: unknown) => {
        if (cause instanceof DOMException && cause.name === "AbortError") return;
        setError(cause instanceof Error ? cause.message : "Unable to load learner data.");
      });
    return () => controller.abort();
  }, [learnerId]);

  if (!data && !error) return <LoadingState label="Loading learner mentor view" />;
  if (!data && error) return <ErrorState message={error} onRetry={() => void load()} />;
  if (!data) return null;

  const { learner } = data;
  return (
    <div className={styles.adminPage}>
      <div className={styles.headActions}>
        <Link className={styles.textLink} href="/admin"><ArrowLeft size={14} /> Back to operations</Link>
        <span>Updated {formatRelativeTime(data.generatedAt)}</span>
        <button className="button button-secondary" disabled={refreshing} onClick={() => void load()} type="button"><RefreshCw size={14} /> Refresh</button>
      </div>
      {error && <p className={styles.inlineError}>Showing the last successful snapshot. Refresh failed: {error}</p>}

      <section className={styles.detailHero}>
        <span className={styles.detailAvatar}>{initials(learner.name)}</span>
        <div className={styles.detailIdentity}>
          <span className={styles.eyebrow}>Mentor detail · public id {learner.publicId.slice(0, 8)}…</span>
          <h1>{learner.name}</h1>
          <span>{learner.email}</span>
          <div><StatusPill status={learner.status} /><span className={styles.chip}>{humanize(learner.level)}</span><span className={styles.chip}>{learner.emailVerified ? "email verified" : "email unverified"}</span><span className={styles.chip}>{learner.mfaEnabled ? "MFA enabled" : "MFA missing"}</span></div>
        </div>
        <div className={styles.detailMeta}><span>Joined {formatDateTime(learner.createdAt)}</span><span>Last meaningful activity {formatRelativeTime(learner.lastMeaningfulActivityAt)}</span><span>Onboarding {learner.onboardingCompletedAt ? formatRelativeTime(learner.onboardingCompletedAt) : "incomplete"}</span></div>
      </section>

      <section aria-label="Learner summary" className={styles.detailStats}>
        <article><strong>{formatPercent(data.mastery.averageScore)}</strong><span>Average mastery</span></article>
        <article><strong>{data.mastery.reviewDue}</strong><span>Reviews due</span></article>
        <article><strong>{formatPercent(data.attempts.passRate)}</strong><span>Attempt pass rate</span></article>
        <article><strong>{formatMinutes(data.sessions.completedMinutes)}</strong><span>Completed session time</span></article>
        <article><strong>{data.projects.total}</strong><span>Projects</span></article>
      </section>

      <section className={styles.detailGrid}>
        <article className={styles.panel}>
          <div className={styles.panelHead}><div><ShieldCheck size={18} /><span><strong>Profile and learning plan</strong><small>Preferences supplied during onboarding</small></span></div></div>
          <div className={styles.profileFacts}>
            <div className={styles.profileFact}><span>Preferred session</span><strong>{learner.preferredSessionMinutes ? `${learner.preferredSessionMinutes} minutes` : "Not set"}</strong></div>
            <div className={styles.profileFact}><span>Weekly goal</span><strong>{learner.weeklyGoalMinutes ? `${learner.weeklyGoalMinutes} minutes` : "Not set"}</strong></div>
            <div className={styles.profileFact}><span>Active auth sessions</span><strong>{data.operations.activeAuthSessions}</strong></div>
            <div className={styles.profileFact}><span>Last authenticated activity</span><strong>{formatRelativeTime(data.operations.lastSessionSeenAt)}</strong></div>
          </div>
          <div className={styles.tagList}>{learner.selectedTracks.length ? learner.selectedTracks.map((track) => <span className={styles.chip} key={track}>{humanize(track)}</span>) : <span className={styles.chip}>No tracks selected</span>}</div>
          {learner.learningGoals.length ? <div className={styles.eventList} style={{ marginTop: 10 }}>{learner.learningGoals.map((goal, index) => <div className={styles.eventRow} key={`${index}-${goal}`}><CheckCircle2 size={14} /><span><strong>{goal}</strong><small>Learner-stated goal</small></span></div>)}</div> : null}
        </article>

        <article className={styles.panel}>
          <div className={styles.panelHead}><div><BookOpenCheck size={18} /><span><strong>Enrollments</strong><small>Course versions and implementation context</small></span></div><span className="pill">{data.enrollments.length}</span></div>
          {data.enrollments.length ? <div className={styles.eventList}>{data.enrollments.map((item) => <div className={styles.eventRow} key={item.id}><BookOpenCheck size={15} /><span><strong>{item.course} · v{item.version}</strong><small>{item.implementationLanguage ?? "conceptual"} · started {formatRelativeTime(item.startedAt)}</small></span><StatusPill status={item.status} /></div>)}</div> : <EmptyState title="No enrollments" detail="This learner has not started a database-backed course version." />}
        </article>

        <AdminSessionControls learnerId={learnerId} />

        <AdminInactivityPreferenceManager learnerId={learnerId} />

        <AdminDataLifecycleControls learnerId={learnerId} />

        <AdminStorageQuotaManager
          initialQuotaBytes={data.operations.quotaBytes ?? 2 * 1024 ** 3}
          initialRowVersion={data.operations.quotaRowVersion}
          initialUsedBytes={data.operations.storageBytes}
          learnerId={learnerId}
        />

        <AdminFallbackGrantManager learnerId={learnerId} />

        <AdminPlanRevisionManager learnerId={learnerId} />

        <AdminMentorEvidenceReader key={learnerId} learnerId={learnerId} />

        <article className={`${styles.panel} ${styles.spanTwo}`}>
          <div className={styles.panelHead}><div><Gauge size={18} /><span><strong>Mastery evidence summary</strong><small>{data.mastery.total} concept contexts · {formatPercent(data.mastery.averageConfidence)} average confidence</small></span></div></div>
          <InlineCounts rows={data.mastery.statuses} />
          {data.mastery.recent.length ? <div className={styles.tableWrap} style={{ marginTop: 12 }}><table className={styles.dataTable}><thead><tr><th>Concept</th><th>Context</th><th>Status</th><th>Score</th><th>Confidence</th><th>Evidence</th><th>Review</th></tr></thead><tbody>{data.mastery.recent.map((item) => <tr key={`${item.concept}-${item.languageContext}`}><td><strong>{item.concept}</strong></td><td>{humanize(item.languageContext)}</td><td><StatusPill status={item.status} /></td><td>{formatPercent(item.score)}</td><td>{formatPercent(item.confidence)}</td><td>{formatRelativeTime(item.lastEvidenceAt)}</td><td>{formatRelativeTime(item.nextReviewAt)}</td></tr>)}</tbody></table></div> : <EmptyState title="No mastery evidence" detail="Mastery records appear only after valid learning evidence is recorded." />}
        </article>

        <article className={styles.panel}>
          <div className={styles.panelHead}><div><CheckCircle2 size={18} /><span><strong>Attempts</strong><small>{data.attempts.passed} passed of {data.attempts.total} · {formatPercent(data.attempts.averageScore)} average score</small></span></div></div>
          <InlineCounts rows={data.attempts.statuses} />
          {data.attempts.recent.length ? <div className={styles.eventList} style={{ marginTop: 11 }}>{data.attempts.recent.slice(0, 10).map((item) => <div className={styles.eventRow} key={item.id}>{item.infrastructureFailure ? <AlertTriangle size={15} /> : <CheckCircle2 size={15} />}<span><strong>{humanize(item.kind)} · {item.score === null ? "not scored" : formatPercent(item.score)}</strong><small>{formatRelativeTime(item.createdAt)} · {item.masteryAwarded ? "mastery awarded" : "no mastery award"}{item.corrected ? " · corrected result" : ""}</small></span><StatusPill status={item.status} /></div>)}</div> : <EmptyState title="No attempts" detail="Practice, diagnostic and assessment attempts will appear here without learner answers or code." />}
        </article>

        <article className={styles.panel}>
          <div className={styles.panelHead}><div><Clock3 size={18} /><span><strong>Learning sessions</strong><small>{data.sessions.active} active · {formatMinutes(data.sessions.plannedMinutes)} planned total</small></span></div></div>
          {data.sessions.recent.length ? <div className={styles.eventList}>{data.sessions.recent.slice(0, 10).map((item) => <div className={styles.eventRow} key={item.id}><Clock3 size={15} /><span><strong>{item.goal}</strong><small>{item.plannedMinutes} min plan · started {formatRelativeTime(item.startedAt)} · last activity {formatRelativeTime(item.lastActivityAt)}</small></span><StatusPill status={item.status} /></div>)}</div> : <EmptyState title="No learning sessions" detail="Meaningful learner sessions will appear here when planning begins." />}
        </article>

        <article className={styles.panel}>
          <div className={styles.panelHead}><div><MessageCircleMore size={18} /><span><strong>Tutor usage</strong><small>{data.chats.threads} threads · {data.chats.messages} messages</small></span></div></div>
          {data.chats.recent.length ? <div className={styles.eventList}>{data.chats.recent.map((thread) => <div className={styles.eventRow} key={thread.id}><MessageCircleMore size={15} /><span><strong>Tutor thread · {thread.id.slice(0, 8)}…</strong><small>{thread.messages} messages · updated {formatRelativeTime(thread.updatedAt)} · transcript not loaded</small></span><StatusPill status={thread.status} /></div>)}</div> : <EmptyState title="No tutor threads" detail="Only usage counts and thread state are shown; message content is never loaded here." />}
        </article>

        <article className={styles.panel}>
          <div className={styles.panelHead}><div><FolderKanban size={18} /><span><strong>Project summaries</strong><small>Titles and workflow state; PRDs and review findings omitted</small></span></div></div>
          {data.projects.recent.length ? <div className={styles.eventList}>{data.projects.recent.map((item) => <div className={styles.eventRow} key={item.id}><FolderKanban size={15} /><span><strong>{item.title}</strong><small>{humanize(item.visibility)} · {item.reviews} reviews · updated {formatRelativeTime(item.updatedAt)}</small></span><StatusPill status={item.status} /></div>)}</div> : <EmptyState title="No projects" detail="Learner projects will appear here after they are created." />}
        </article>

        <AdminCredentialManager
          credentials={data.credentials}
          key={`credential-${learnerId}`}
          learnerId={learnerId}
          onChanged={() => load()}
        />

        <article className={styles.panel}>
          <div className={styles.panelHead}><div><HardDrive size={18} /><span><strong>Storage, email and appeals</strong><small>Operational metadata without object names or email content</small></span></div></div>
          <div className={styles.profileFacts}>
            <div className={styles.profileFact}><span>Stored objects</span><strong>{data.operations.storageObjects}</strong></div>
            <div className={styles.profileFact}><span>Storage used</span><strong>{formatBytes(data.operations.storageBytes)}</strong></div>
            <div className={styles.profileFact}><span>Quota</span><strong>{data.operations.quotaPercent === null ? "Not configured" : formatPercent(data.operations.quotaPercent)}</strong></div>
            <div className={styles.profileFact}><span>Pending scans</span><strong>{data.operations.pendingScans}</strong></div>
          </div>
          <div style={{ marginTop: 12 }}><strong className={styles.eyebrow}>Email outbox</strong><InlineCounts rows={data.operations.emailStatuses} /></div>
          {data.appeals.length ? <div className={styles.eventList} style={{ marginTop: 12 }}>{data.appeals.map((item) => <div className={styles.eventRow} key={item.id}><AlertTriangle size={15} /><span><strong><Link href={`/admin/appeals?appeal=${item.id}`}>{humanize(item.target)} appeal</Link></strong><small>Opened {formatRelativeTime(item.createdAt)}{item.decidedAt ? ` · decided ${formatRelativeTime(item.decidedAt)}` : ""}</small></span><StatusPill status={item.status} /></div>)}</div> : null}
        </article>
      </section>

      <p className={styles.safeNotice}><ShieldCheck size={15} /> The default mentor summary excludes chat messages, assessment responses, source code, hidden tests, project PRDs/findings, object names and hashes, IP addresses, device hashes, audit reasons and all credential cryptographic fields. Private learning evidence appears only through the deliberate audited reader above; secrets, session/device data, hidden assessment evidence, and other learners remain excluded.</p>
    </div>
  );
}
