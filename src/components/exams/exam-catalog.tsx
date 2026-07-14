"use client";

import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Clock3,
  FileCheck2,
  Laptop2,
  LoaderCircle,
  RotateCcw,
  ShieldCheck,
  Tablet,
  X,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import { ModalDialog } from "@/components/ui/modal-dialog";
import type { ExamCatalogEntry } from "@/lib/exams/contracts";

import styles from "./exams.module.css";

function deviceSupported(): boolean {
  if (typeof window === "undefined") return true;
  const phone = /iPhone|iPod|Windows Phone|Android[^\n]*Mobile/i.test(navigator.userAgent);
  return window.innerWidth >= 768 && !phone;
}

function readinessLabel(readiness: ExamCatalogEntry["readiness"]): string {
  return {
    available: "Ready to start",
    resume: "In progress",
    "pending-review": "Pending review",
    passed: "Passed",
    mastered: "Mastered",
    remediation: "Remediation first",
  }[readiness];
}

function retakeMessage(entry: ExamCatalogEntry): string | null {
  if (entry.retake.eligible || entry.retake.reason === "first-attempt") return null;
  if (entry.retake.reason === "cooldown" && entry.retake.nextEligibleAt) {
    return `Retake opens ${new Date(entry.retake.nextEligibleAt).toLocaleString()}`;
  }
  if (entry.retake.reason === "remediation-required") return "Complete the assigned remediation. Verified learning evidence unlocks the retake automatically.";
  if (entry.retake.reason === "pending-review") return "A new form opens after the current submission is reviewed.";
  if (entry.retake.reason === "already-mastered") return "Mastery has already been awarded for this module.";
  return null;
}

export function ExamCatalog() {
  const router = useRouter();
  const [exams, setExams] = useState<readonly ExamCatalogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [courseFilter, setCourseFilter] = useState("all");
  const [selected, setSelected] = useState<ExamCatalogEntry | null>(null);
  const [selectedMode, setSelectedMode] = useState<"exam" | "mastery-recheck">("exam");
  const [integrityAccepted, setIntegrityAccepted] = useState(false);
  const [readinessAccepted, setReadinessAccepted] = useState(false);
  const [starting, setStarting] = useState(false);
  const [supported, setSupported] = useState(true);

  useEffect(() => {
    const update = () => setSupported(deviceSupported());
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const response = await fetch("/api/exams", { cache: "no-store" });
        const body = await response.json() as { exams?: readonly ExamCatalogEntry[]; error?: string };
        if (!response.ok) throw new Error(body.error ?? "Could not load exams.");
        if (!cancelled) setExams(body.exams ?? []);
      } catch (loadError) {
        if (!cancelled) setError(loadError instanceof Error ? loadError.message : "Could not load exams.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => { cancelled = true; };
  }, []);

  const courses = useMemo(() => {
    const byId = new Map<string, string>();
    exams.forEach((entry) => byId.set(entry.courseId, entry.courseTitle));
    return [...byId].sort((left, right) => left[1].localeCompare(right[1]));
  }, [exams]);
  const visible = courseFilter === "all"
    ? exams
    : exams.filter((entry) => entry.courseId === courseFilter);

  function openStart(entry: ExamCatalogEntry, mode: "exam" | "mastery-recheck" = "exam") {
    setSelected(entry);
    setSelectedMode(mode);
    setIntegrityAccepted(false);
    setReadinessAccepted(false);
    setError(null);
  }

  function closeStart() {
    if (starting) return;
    setSelected(null);
  }

  async function start() {
    if (!selected || starting) return;
    setStarting(true);
    setError(null);
    try {
      const response = await fetch(
        selectedMode === "mastery-recheck" && selected.masteryRecheck
          ? `/api/exams/rechecks/${selected.masteryRecheck.id}/start`
          : "/api/exams/start",
        {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          moduleId: selected.moduleId,
          integrityDisclosureAccepted: integrityAccepted,
          readinessAcknowledged: readinessAccepted,
          device: {
            viewportWidth: window.innerWidth,
            viewportHeight: window.innerHeight,
            userAgent: navigator.userAgent,
          },
        }),
      });
      const body = await response.json() as {
        exam?: { sessionId: string };
        error?: string;
        sessionId?: string;
      };
      if (!response.ok) {
        if (body.sessionId) router.push(`/exams/${body.sessionId}`);
        throw new Error(body.error ?? "The exam could not be started.");
      }
      if (!body.exam) throw new Error("The exam session was not returned.");
      router.push(`/exams/${body.exam.sessionId}`);
    } catch (startError) {
      setError(startError instanceof Error ? startError.message : "The exam could not be started.");
      setStarting(false);
    }
  }

  return (
    <div className={styles.catalogPage}>
      <section className={styles.catalogHero}>
        <div>
          <span className={styles.eyebrow}>Independent evidence</span>
          <h1>Formal module exams</h1>
          <p>
            Timed, server-controlled forms cover every declared skill in a module. Compile and run are
            available, while Tutor and lesson notes stay outside the exam.
          </p>
        </div>
        <div className={styles.heroPrinciples}>
          <span><ShieldCheck size={18} /><b>Server deadline</b><small>Closing the tab never pauses time.</small></span>
          <span><FileCheck2 size={18} /><b>Evidence-safe grading</b><small>No oracle means pending review, not a guessed score.</small></span>
          <span><RotateCcw size={18} /><b>Equivalent retakes</b><small>Cooldown and remediation rules are enforced.</small></span>
        </div>
      </section>

      {!supported && (
        <div className={styles.deviceGate} role="alert">
          <AlertTriangle size={20} />
          <div><strong>Use a desktop or tablet to start.</strong><span>Phone layouts can browse readiness, but the server will not start the exam clock.</span></div>
        </div>
      )}

      <div className={styles.catalogToolbar}>
        <div><strong>{visible.length}</strong><span>module exams</span></div>
        <label>
          <span>Course</span>
          <select value={courseFilter} onChange={(event) => setCourseFilter(event.target.value)}>
            <option value="all">All courses</option>
            {courses.map(([id, title]) => <option value={id} key={id}>{title}</option>)}
          </select>
        </label>
      </div>

      {loading && <div className={styles.loading}><LoaderCircle className={styles.spin} /> Loading exam readiness…</div>}
      {!loading && error && !selected && <div className={styles.inlineError} role="alert">{error}</div>}
      {!loading && !error && visible.length === 0 && <div className={styles.empty}>No module exams match this course.</div>}

      <section className={styles.examGrid} aria-label="Module exams">
        {visible.map((entry) => {
          const restriction = retakeMessage(entry);
          const recheckAvailable = entry.masteryRecheck?.status === "available";
          const canOpen = entry.activeSessionId !== null || entry.retake.eligible || recheckAvailable;
          return (
            <article className={`${styles.examCard} card`} key={entry.moduleId}>
              <div className={styles.examCardTop}>
                <span>{entry.courseTitle}</span>
                <i data-state={entry.readiness}>{readinessLabel(entry.readiness)}</i>
              </div>
              <h2>{entry.moduleTitle}</h2>
              <p>{entry.summary}</p>
              <div className={styles.examFacts}>
                <span><FileCheck2 size={14} /> {entry.skillCount} skill questions</span>
                <span><Clock3 size={14} /> {entry.durationMinutes} minutes</span>
              </div>
              {entry.latestResult?.gradingStatus === "graded" && (
                <div className={styles.latestScore}>
                  <strong>{Math.round(entry.latestResult.officialScorePercent ?? 0)}%</strong>
                  <span>{entry.latestResult.outcome.replaceAll("_", " ").toLocaleLowerCase()}</span>
                </div>
              )}
              {restriction && <small className={styles.restriction}>{restriction}</small>}
              {entry.masteryRecheck?.status === "scheduled" && (
                <small className={styles.restriction}>
                  Targeted mastery recheck opens {new Date(entry.masteryRecheck.dueAt).toLocaleString()}. Your pass is protected.
                </small>
              )}
              {entry.masteryRecheck?.status === "completed" && (
                <small className={styles.restriction}>Targeted mastery recheck completed; the earlier passing result remains protected.</small>
              )}
              {entry.activeSessionId ? (
                <Link className="button button-primary" href={`/exams/${entry.activeSessionId}`}>
                  Resume timed exam <ArrowRight size={16} />
                </Link>
              ) : recheckAvailable ? (
                <button
                  className="button button-primary"
                  type="button"
                  disabled={!supported}
                  onClick={() => openStart(entry, "mastery-recheck")}
                >
                  Start targeted mastery recheck <ArrowRight size={16} />
                </button>
              ) : (
                <button
                  className="button button-primary"
                  type="button"
                  disabled={!supported || !canOpen}
                  onClick={() => openStart(entry)}
                >
                  {entry.latestResult ? "Start eligible retake" : "Review and start"} <ArrowRight size={16} />
                </button>
              )}
            </article>
          );
        })}
      </section>

      {selected && (
        <ModalDialog
          backdropClassName={styles.modalBackdrop}
          dialogClassName={styles.startModal}
          labelledBy="start-title"
          onClose={closeStart}
        >
            <button className={styles.closeButton} aria-label="Close" data-dialog-initial-focus disabled={starting} onClick={closeStart}><X size={18} /></button>
            <span className={styles.eyebrow}>{selectedMode === "mastery-recheck" ? "Protected prior pass" : "Before the server clock starts"}</span>
            <h2 id="start-title">{selected.moduleTitle}</h2>
            <div className={styles.startFacts}>
              <span><Clock3 size={18} /><b>{selectedMode === "mastery-recheck" ? selected.masteryRecheck?.durationMinutes : selected.durationMinutes} minutes</b><small>Server-authoritative deadline</small></span>
              <span><Laptop2 size={18} /><Tablet size={18} /><b>Desktop or tablet</b><small>Phones cannot start</small></span>
            </div>
            <div className={styles.disclosure}>
              <ShieldCheck size={20} />
              <div>
                <strong>Integrity event disclosure</strong>
                <p>We record focus/blur, tab visibility, paste character count, fullscreen, navigation, and connection events. We do not capture clipboard contents, keys, camera, microphone, or screen contents. Signals are for review and never alter a score automatically.</p>
              </div>
            </div>
            <label className={styles.confirmRow}>
              <input type="checkbox" checked={integrityAccepted} onChange={(event) => setIntegrityAccepted(event.target.checked)} />
              <span>I understand and accept the integrity event disclosure.</span>
            </label>
            <label className={styles.confirmRow}>
              <input type="checkbox" checked={readinessAccepted} onChange={(event) => setReadinessAccepted(event.target.checked)} />
              <span>I am ready to work independently. The timer continues through disconnects and my latest successful autosave is used at expiry.</span>
            </label>
            {error && <div className={styles.inlineError} role="alert">{error}</div>}
            <button
              className="button button-primary"
              type="button"
              disabled={
                starting || !supported || !integrityAccepted || !readinessAccepted
              }
              onClick={() => void start()}
            >
              {starting ? <><LoaderCircle className={styles.spin} size={17} /> Creating secure form…</> : <>{selectedMode === "mastery-recheck" ? "Start mastery recheck" : "Start exam now"} <ArrowRight size={17} /></>}
            </button>
            <p className={styles.startWarning}><CheckCircle2 size={14} /> {selectedMode === "mastery-recheck" ? "Only unmet mastery targets are rechecked; a lower result cannot replace your prior pass." : "A unique equivalent form is saved before navigation."}</p>
        </ModalDialog>
      )}
    </div>
  );
}
