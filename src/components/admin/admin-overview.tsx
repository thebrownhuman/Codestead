"use client";

import {
  AlertTriangle,
  ArrowRight,
  BookOpenCheck,
  Bot,
  CheckCircle2,
  Clock3,
  Database,
  FolderKanban,
  Gauge,
  HardDrive,
  KeyRound,
  Mail,
  MessageCircleMore,
  RefreshCw,
  Server,
  ShieldCheck,
  Users,
} from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import {
  credentialTail,
  formatBytes,
  formatDateTime,
  formatMinutes,
  formatPercent,
  formatRelativeTime,
  humanize,
  percentage,
  requestAdminJson,
} from "./admin-utils";
import styles from "./admin.module.css";
import { EmptyState, ErrorState, LoadingState, StatusPill } from "./status-pill";
import type { AdminDashboardData, StatusCount } from "./types";

function initials(name: string): string {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("") || "L";
}

function StatusBars({ rows }: { readonly rows: readonly StatusCount[] }) {
  const maximum = Math.max(1, ...rows.map((row) => row.count));
  if (!rows.length) return <EmptyState title="No state recorded" detail="This queue has no rows yet." />;
  return (
    <div className={styles.statusBars}>
      {rows.map((row) => (
        <div className={styles.statusRow} key={row.status}>
          <span>{humanize(row.status)}</span>
          <div aria-hidden="true"><i style={{ width: `${percentage(row.count, maximum)}%` }} /></div>
          <strong>{row.count}</strong>
        </div>
      ))}
    </div>
  );
}

export function AdminOverview() {
  const [data, setData] = useState<AdminDashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async (signal?: AbortSignal) => {
    setRefreshing(true);
    setError(null);
    try {
      setData(await requestAdminJson<AdminDashboardData>("/api/admin/dashboard", { signal }));
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === "AbortError") return;
      setError(cause instanceof Error ? cause.message : "Unable to load operations data.");
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void requestAdminJson<AdminDashboardData>("/api/admin/dashboard", {
      signal: controller.signal,
    })
      .then(setData)
      .catch((cause: unknown) => {
        if (cause instanceof DOMException && cause.name === "AbortError") return;
        setError(cause instanceof Error ? cause.message : "Unable to load operations data.");
      });
    return () => controller.abort();
  }, []);

  if (!data && !error) return <LoadingState />;
  if (!data && error) return <ErrorState message={error} onRetry={() => void load()} />;
  if (!data) return null;

  const authoredCoverage = percentage(data.content.authored.covered, data.content.authored.skills);
  const backup = data.operations.backup;
  const backupFresh = Boolean(
    backup.recorded &&
    backup.status === "succeeded" &&
    backup.ageSeconds !== null &&
    backup.ageSeconds <= 36 * 60 * 60,
  );
  const runnerBacklog = data.summary.runnerBacklog;

  return (
    <div className={styles.adminPage}>
      <section className={styles.pageHead}>
        <div>
          <span className={styles.eyebrow}>Private pilot · operations</span>
          <h1>Keep ten learners <span>moving safely.</span></h1>
          <p>Mentor signals, content readiness, provider health and infrastructure state—aggregated without exposing chat text, code, answers, session network data or credential material.</p>
        </div>
        <div className={styles.headActions}>
          <span>Updated {formatRelativeTime(data.generatedAt)}</span>
          <button className="button button-secondary" disabled={refreshing} onClick={() => void load()} type="button">
            <RefreshCw size={15} /> {refreshing ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      </section>

      {error && <div className={styles.inlineError} role="status">Showing the last successful snapshot. Refresh failed: {error}</div>}

      <section aria-label="Operations summary" className={styles.summaryGrid}>
        <article className={styles.summaryCard}><span><Users size={16} /> Learners</span><strong>{data.summary.learners}</strong><small>{data.summary.activeLearners} active accounts</small></article>
        <article className={styles.summaryCard}><span><Clock3 size={16} /> Active this week</span><strong>{data.summary.activeLast7Days}</strong><small>Meaningful learning activity</small></article>
        <article className={`${styles.summaryCard} ${data.summary.pendingAccessRequests ? styles.attentionCard : ""}`}><span><ShieldCheck size={16} /> Access requests</span><strong>{data.summary.pendingAccessRequests}</strong><small>Awaiting administrator review</small></article>
        <article className={styles.summaryCard}><span><Gauge size={16} /> Attempt pass rate</span><strong>{formatPercent(data.learning.passRate)}</strong><small>{data.learning.attempts} recorded attempts</small></article>
        <article className={`${styles.summaryCard} ${data.summary.openAppeals ? styles.attentionCard : ""}`}><span><AlertTriangle size={16} /> Open appeals</span><strong>{data.summary.openAppeals}</strong><small>Human decision required</small></article>
        <article className={`${styles.summaryCard} ${runnerBacklog ? styles.attentionCard : ""}`}><span><Server size={16} /> Runner backlog</span><strong>{runnerBacklog}</strong><small>Queued, leased or running</small></article>
      </section>

      <section className={styles.twoColumn} id="learners">
        <article className={`${styles.panel} ${styles.sectionAnchor}`}>
          <div className={styles.panelHead}>
            <div><Users size={18} /><span><strong>Learner mentor view</strong><small>Mastery, attempts and meaningful activity—not surveillance</small></span></div>
            <span className="pill">{data.learners.length} seats</span>
          </div>
          {data.learners.length ? (
            <div className={styles.tableWrap}>
              <table className={styles.dataTable}>
                <thead><tr><th>Learner</th><th>Status</th><th>Mastery</th><th>Attempts</th><th>Sessions</th><th>Last active</th><th /></tr></thead>
                <tbody>
                  {data.learners.map((learner) => (
                    <tr key={learner.publicId}>
                      <td><div className={styles.personCell}><span className={styles.avatar}>{initials(learner.name)}</span><span><strong>{learner.name}</strong><small>{learner.email}</small></span></div></td>
                      <td><StatusPill status={learner.status} /></td>
                      <td><div className={styles.metricCell}><span><strong>{formatPercent(learner.masteryAverage)}</strong><small>{learner.masteredSkills} mastered</small></span><div className={styles.microBar}><i style={{ width: `${learner.masteryAverage}%` }} /></div></div></td>
                      <td><div className={styles.metricCell}><strong>{learner.attempts}</strong><small>{formatPercent(learner.passRate)} passed</small></div></td>
                      <td><div className={styles.metricCell}><strong>{learner.sessions}</strong><small>{formatMinutes(learner.sessionMinutes)}</small></div></td>
                      <td>{formatRelativeTime(learner.lastMeaningfulActivityAt)}</td>
                      <td><Link className={styles.rowLink} href={`/admin/learners/${learner.publicId}`}>Open <ArrowRight size={13} /></Link></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : <EmptyState title="No learner accounts" detail="Approved and activated learner accounts will appear here." />}
        </article>

        <aside className={styles.panel}>
          <div className={styles.panelHead}><div><Gauge size={18} /><span><strong>Learning pulse</strong><small>Evidence-backed cohort totals</small></span></div></div>
          <div className={styles.pulseGrid}>
            <div className={styles.pulseMetric}><BookOpenCheck size={16} /><strong>{data.learning.masteredSkills}</strong><span>Mastered skill records</span></div>
            <div className={styles.pulseMetric}><AlertTriangle size={16} /><strong>{data.learning.reviewDue}</strong><span>Reviews due</span></div>
            <div className={styles.pulseMetric}><MessageCircleMore size={16} /><strong>{data.learning.chatThreads}</strong><span>Tutor threads · {data.learning.chatMessages} messages</span></div>
            <div className={styles.pulseMetric}><FolderKanban size={16} /><strong>{data.learning.projects}</strong><span>Learning projects</span></div>
          </div>
          <div className={styles.callout}>
            <div><strong>{data.summary.pendingAccessRequests ? `${data.summary.pendingAccessRequests} requests need review` : "Access queue is clear"}</strong><small>Approval requires fresh MFA and a recorded reason.</small></div>
            <Link href="/admin/access">Review <ArrowRight size={13} /></Link>
          </div>
        </aside>
      </section>

      <section className={styles.balancedColumns}>
        <article className={styles.panel}>
          <div className={styles.panelHead}><div><KeyRound size={18} /><span><strong>Provider and key status</strong><small>Allowlisted metadata only; never plaintext or ciphertext</small></span></div><span className="pill">{data.providers.credentials.length} keys</span></div>
          {data.providers.credentials.length ? <div className={styles.credentialList}>{data.providers.credentials.slice(0, 12).map((credential, index) => (
            <div className={styles.credentialRow} key={`${credential.ownerPublicId}-${credential.provider}-${credential.lastFour}-${index}`}>
              <KeyRound size={16} />
              <span><strong>{credential.ownerName} · {humanize(credential.provider)}</strong><small>{credential.failureCode ? `Code ${credential.failureCode} · ` : ""}used {formatRelativeTime(credential.lastUsedAt)}</small></span>
              <span><span className={styles.credentialTail}>{credentialTail(credential.lastFour)}</span><StatusPill status={credential.status} /></span>
            </div>
          ))}</div> : <EmptyState title="No provider credentials" detail="Learners have not configured provider keys yet." />}
          <div className={styles.safeNotice}><ShieldCheck size={15} /> This response never selects credential ciphertext, wrapped keys, IVs, tags or plaintext. Full key reveal is intentionally absent from this console.</div>
        </article>

        <article className={styles.panel}>
          <div className={styles.panelHead}><div><Bot size={18} /><span><strong>Provider routing policy</strong><small>Enabled operations and credential health</small></span></div></div>
          <StatusBars rows={data.providers.credentialStatusCounts} />
          <div className={styles.eventList} style={{ marginTop: 14 }}>
            {data.providers.policies.slice(0, 8).map((policy) => (
              <div className={styles.eventRow} key={`${policy.operation}-${policy.provider}-${policy.priority}`}>
                <Bot size={15} /><span><strong>{humanize(policy.operation)} · {humanize(policy.provider)}</strong><small>{policy.model} · priority {policy.priority} · {policy.timeoutMs} ms</small></span><StatusPill status={policy.enabled ? "active" : "disabled"} />
              </div>
            ))}
          </div>
          {!data.providers.policies.length && <EmptyState title="No routing policy" detail="AI operations remain unavailable until an administrator configures a policy." />}
        </article>
      </section>

      <section className={`${styles.twoColumn} ${styles.sectionAnchor}`} id="content">
        <article className={styles.panel}>
          <div className={styles.panelHead}><div><BookOpenCheck size={18} /><span><strong>Content publication coverage</strong><small>Authored manifest coverage and database publication state</small></span></div><Link href="/admin/curriculum">Open editorial queue <ArrowRight size={13} /></Link></div>
          <div className={styles.authoredCoverage}>
            <div className={styles.coverageRing} style={{ "--coverage": `${authoredCoverage}%` } as React.CSSProperties}><strong>{formatPercent(authoredCoverage)}</strong></div>
            <div><strong>{data.content.authored.courses} courses · {data.content.authored.modules} modules · {data.content.authored.skills} atomic skills</strong><span>{data.content.authored.covered} covered, {data.content.authored.partial} partial, {data.content.authored.planned} planned in the validated filesystem catalog.</span></div>
          </div>
          <StatusBars rows={data.content.authored.statuses} />
        </article>
        <article className={styles.panel}>
          <div className={styles.panelHead}><div><Database size={18} /><span><strong>Database publications</strong><small>Lesson blocks and activities available to runtime delivery</small></span></div></div>
          {data.content.publications.length ? <div className={styles.publicationList}>{data.content.publications.slice(0, 10).map((publication) => (
            <div className={styles.publicationRow} key={`${publication.courseSlug}-${publication.version}`}>
              <span><strong>{publication.title} · v{publication.version}</strong><span className={styles.publicationMeta}><i>{publication.modules} modules</i><i>{publication.lessons} lessons</i><i>{publication.blocks} blocks</i><i>{publication.activities} activities</i></span></span>
              <span><StatusPill status={publication.stage} /><small>{formatPercent(publication.coveragePercent)} publishable</small></span>
            </div>
          ))}</div> : <EmptyState title="No database publications" detail="Validated manifests exist, but no course versions have been published into runtime tables." />}
        </article>
      </section>

      <section className={styles.opsGrid} aria-label="Infrastructure operations">
        <article className={styles.opsCard}><div className={styles.opsCardHead}><Server size={17} /><span><strong>Code runner</strong><small>Sandbox job states</small></span></div><strong className={styles.opsBig}>{runnerBacklog} pending</strong><StatusBars rows={data.operations.runner.statuses} /><span className={styles.opsFoot}>Oldest queued: {formatRelativeTime(data.operations.runner.oldestQueuedAt)} · {data.operations.runner.recentFailures.length} recent failures</span></article>
        <article className={styles.opsCard}><div className={styles.opsCardHead}><RefreshCw size={17} /><span><strong>Background jobs</strong><small>Durable asynchronous work</small></span></div><StatusBars rows={data.operations.backgroundJobs.statuses} /><span className={styles.opsFoot}>{data.operations.backgroundJobs.recentFailures.length ? `${data.operations.backgroundJobs.recentFailures.length} recent failures · ${humanize(data.operations.backgroundJobs.recentFailures[0]?.type ?? "unknown")} · ${data.operations.backgroundJobs.recentFailures[0]?.errorCode ?? "no safe error code"}` : "No recent failed or timed-out jobs"}</span></article>
        <article className={styles.opsCard}><div className={styles.opsCardHead}><HardDrive size={17} /><span><strong>Storage and quota</strong><small>Active objects only</small></span></div><strong className={styles.opsBig}>{formatBytes(data.operations.storage.bytes)}</strong><div className={styles.metricCell}><span><small>{data.operations.storage.objects} objects</small><small>{data.operations.storage.quotaPercent === null ? "quota unset" : formatPercent(data.operations.storage.quotaPercent)}</small></span><div className={styles.microBar}><i style={{ width: `${data.operations.storage.quotaPercent ?? 0}%` }} /></div></div><span className={styles.opsFoot}>{data.operations.storage.pendingScans} scans pending · {formatBytes(data.operations.storage.ledgerBytes30Days)} ledger movement / 30d</span></article>
        <article className={styles.opsCard}><div className={styles.opsCardHead}><Mail size={17} /><span><strong>Email delivery</strong><small>Outbox state; recipients hidden here</small></span></div><StatusBars rows={data.operations.email.statuses} /><span className={styles.opsFoot}>Oldest pending: {formatRelativeTime(data.operations.email.oldestPendingAt)} · {data.operations.email.recentFailures.length} recent failures</span></article>
        <article className={`${styles.opsCard} ${backupFresh ? styles.backupGood : styles.backupMissing}`}><div className={styles.opsCardHead}>{backupFresh ? <CheckCircle2 size={17} /> : <AlertTriangle size={17} />}<span><strong>Backup health</strong><small>Recorded background jobs</small></span></div><strong className={styles.opsBig}>{backup.recorded ? humanize(backup.status) : "Not recorded"}</strong><StatusPill status={backup.status} /><span className={styles.opsFoot}>{backup.recorded ? `${humanize(backup.type ?? "backup")} · ${formatRelativeTime(backup.completedAt ?? backup.createdAt)}${backup.errorCode ? ` · ${backup.errorCode}` : ""}` : "No backup job has been recorded. Treat this as an operational gap."}</span></article>
      </section>

      <section className={styles.balancedColumns}>
        <article className={styles.panel}>
          <div className={styles.panelHead}><div><AlertTriangle size={18} /><span><strong>Appeals requiring human review</strong><small>Target and state only; submitted evidence remains out of this overview</small></span></div><Link href="/admin/appeals">Open queue <ArrowRight size={13} /></Link></div>
          {data.appeals.length ? <div className={styles.eventList}>{data.appeals.map((item) => (
            <div className={styles.eventRow} key={item.id}><AlertTriangle size={15} /><span><strong><Link href={`/admin/appeals?appeal=${item.id}`}>{item.learnerName}</Link> · {humanize(item.target)}</strong><small>Opened {formatRelativeTime(item.createdAt)}{item.decidedAt ? ` · decided ${formatRelativeTime(item.decidedAt)}` : ""}</small></span><StatusPill status={item.status} /></div>
          ))}</div> : <EmptyState title="No appeals" detail="Learner assessment or project appeals will appear here for human review." />}
        </article>

        <article className={styles.panel}>
          <div className={styles.panelHead}><div><ShieldCheck size={18} /><span><strong>Recent audit events</strong><small>Action metadata only; reasons and event metadata are omitted</small></span></div></div>
          {data.audit.length ? <div className={styles.auditList}>{data.audit.map((event) => (
            <div className={styles.auditItem} key={event.id}><i className={styles.auditMark} /><span><strong>{event.actorName} · {humanize(event.action)}</strong><small>{humanize(event.resourceType)}{event.resourceId ? ` · ${event.resourceId.slice(0, 8)}…` : ""} · {humanize(event.outcome)}</small></span><time dateTime={event.occurredAt}>{formatRelativeTime(event.occurredAt)}</time></div>
          ))}</div> : <EmptyState title="No audit events" detail="Privileged and security-relevant actions will appear here." />}
        </article>
      </section>

      <p className={styles.safeNotice}><ShieldCheck size={15} /> Snapshot generated {formatDateTime(data.generatedAt)}. Administrator APIs use explicit field allowlists and private no-store responses. This screen is intentionally operational: it does not provide credential reveal, impersonation, chat transcript, answer, source-code or hidden-test access.</p>
    </div>
  );
}
