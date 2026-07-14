"use client";

import { ClipboardCheck, ShieldAlert } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import styles from "./app-shell.module.css";

type ExamCatalogResponse = {
  readonly exams?: readonly {
    readonly activeSessionId: string | null;
    readonly courseTitle: string;
    readonly moduleTitle: string;
  }[];
};

export function ExamLockdownOverlay() {
  const pathname = usePathname();
  const [active, setActive] = useState<{
    sessionId: string;
    courseTitle: string;
    moduleTitle: string;
  } | null>(null);
  const resumeRef = useRef<HTMLAnchorElement>(null);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    const response = await fetch("/api/exams", { cache: "no-store", signal });
    if (!response.ok) return null;
    const body = (await response.json()) as ExamCatalogResponse;
    const exam = body.exams?.find((candidate) => candidate.activeSessionId);
    return exam?.activeSessionId
      ? {
          sessionId: exam.activeSessionId,
          courseTitle: exam.courseTitle,
          moduleTitle: exam.moduleTitle,
        }
      : null;
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    const check = () => {
      void refresh(controller.signal)
        .then((result) => { if (!cancelled) setActive(result); })
        .catch(() => undefined);
    };
    check();
    const interval = window.setInterval(check, 15_000);
    return () => {
      cancelled = true;
      controller.abort();
      window.clearInterval(interval);
    };
  }, [refresh]);

  const alreadyInExam = active && pathname === `/exams/${active.sessionId}`;
  useEffect(() => {
    if (active && !alreadyInExam) resumeRef.current?.focus();
  }, [active, alreadyInExam]);

  useEffect(() => {
    const locked = Boolean(active && !alreadyInExam);
    const regions = [
      document.getElementById("app-sidebar"),
      document.getElementById("app-content-column"),
    ].filter((region): region is HTMLElement => Boolean(region));
    for (const region of regions) {
      if (locked) {
        region.setAttribute("inert", "");
        region.setAttribute("aria-hidden", "true");
      } else {
        region.removeAttribute("inert");
        region.removeAttribute("aria-hidden");
      }
    }
    return () => {
      for (const region of regions) {
        region.removeAttribute("inert");
        region.removeAttribute("aria-hidden");
      }
    };
  }, [active, alreadyInExam]);

  if (!active || alreadyInExam) return null;
  return (
    <div className={styles.examLockBackdrop} role="presentation">
      <section
        aria-describedby="active-exam-lock-description"
        aria-labelledby="active-exam-lock-title"
        aria-modal="true"
        className={styles.examLockDialog}
        role="alertdialog"
      >
        <span className={styles.examLockIcon}><ShieldAlert aria-hidden="true" size={28} /></span>
        <span className={styles.navLabel}>CLOSED-BOOK EXAM ACTIVE</span>
        <h1 id="active-exam-lock-title">Return to your exam workspace</h1>
        <p id="active-exam-lock-description">
          {active.courseTitle} · {active.moduleTitle} is still timed. Lessons, Codestead, practice games, general code runs, files, and project work remain server-locked until it is submitted or finalized.
        </p>
        <Link className="button button-primary" href={`/exams/${active.sessionId}`} ref={resumeRef}>
          <ClipboardCheck size={16} /> Resume timed exam
        </Link>
        <small>The server timer continues. This screen does not decide misconduct; navigation and focus evidence remains available for human review.</small>
      </section>
    </div>
  );
}
