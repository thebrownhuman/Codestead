"use client";

import { ClipboardCheck, ShieldAlert } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { useBrowserDurabilityNamespace } from "@/lib/browser-durability/context";
import { openBrowserOutbox } from "@/lib/browser-durability/indexed-db";
import {
  purgeBrowserRecoveryData,
  purgeDraftRecoveryData,
  withBrowserRecoveryRepository,
} from "@/lib/browser-durability/lifecycle";

import styles from "./app-shell.module.css";

type ExamCatalogResponse = {
  readonly exams?: readonly {
    readonly activeSessionId: string | null;
    readonly courseTitle: string;
    readonly moduleTitle: string;
  }[];
};

type ActiveExam = {
  sessionId: string;
  courseTitle: string;
  moduleTitle: string;
};

type LockState = {
  exam: ActiveExam;
  cleanup: "pending" | "ready" | "error";
};

type CatalogRefreshResult =
  | { kind: "available"; exam: ActiveExam | null }
  | { kind: "auth-denied" }
  | { kind: "unavailable" };

function navigateWindow(destination: string) {
  window.location.assign(destination);
}

function activeExamFromCatalog(body: unknown): ActiveExam | null | undefined {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return undefined;
  const exams = (body as ExamCatalogResponse).exams;
  if (!Array.isArray(exams)) return undefined;
  if (!exams.every((candidate) => (
    typeof candidate === "object"
    && candidate !== null
    && (candidate.activeSessionId === null || typeof candidate.activeSessionId === "string")
    && typeof candidate.courseTitle === "string"
    && typeof candidate.moduleTitle === "string"
  ))) return undefined;
  const exam = exams.find((candidate) => candidate.activeSessionId);
  return exam?.activeSessionId
    ? {
        sessionId: exam.activeSessionId,
        courseTitle: exam.courseTitle,
        moduleTitle: exam.moduleTitle,
      }
    : null;
}

export function ExamLockdownOverlay({
  enabled = true,
  navigate = navigateWindow,
}: {
  enabled?: boolean;
  navigate?: (destination: string) => void;
} = {}) {
  const pathname = usePathname();
  const namespace = useBrowserDurabilityNamespace();
  const [lockState, setLockState] = useState<LockState | null>(null);
  const [sessionBoundaryPending, setSessionBoundaryPending] = useState(false);
  const generationRef = useRef(0);
  const latestNamespaceRef = useRef(namespace);
  const observedKeyRef = useRef<string | null>(null);
  const sessionBoundaryRef = useRef(false);
  const resumeRef = useRef<HTMLAnchorElement>(null);

  useLayoutEffect(() => {
    if (latestNamespaceRef.current === namespace) return;
    latestNamespaceRef.current = namespace;
    generationRef.current += 1;
    observedKeyRef.current = null;
    sessionBoundaryRef.current = false;
    setSessionBoundaryPending(false);
    setLockState(null);
  }, [namespace]);

  const refresh = useCallback(async (signal?: AbortSignal): Promise<CatalogRefreshResult> => {
    const response = await fetch("/api/exams", { cache: "no-store", signal });
    if (response.status === 401 || response.status === 403) return { kind: "auth-denied" };
    if (!response.ok) return { kind: "unavailable" };
    const exam = activeExamFromCatalog(await response.json().catch(() => undefined));
    return exam === undefined
      ? { kind: "unavailable" }
      : { kind: "available", exam };
  }, []);

  const handleSessionDenial = useCallback(async () => {
    if (sessionBoundaryRef.current) return;
    sessionBoundaryRef.current = true;
    const generation = ++generationRef.current;
    setSessionBoundaryPending(true);
    try {
      await withBrowserRecoveryRepository(openBrowserOutbox, (repository) => (
        purgeBrowserRecoveryData({
          ...(namespace ? { namespace } : {}),
          repository,
          sessionStorage: window.sessionStorage,
          localStorage: window.localStorage,
        })
      ));
    } catch {
      // The anonymous login gate retries cleanup before exposing credentials.
    }
    if (generationRef.current === generation) navigate("/login");
  }, [namespace, navigate]);

  const prepareClosedBookEntry = useCallback(async (exam: ActiveExam) => {
    const generation = ++generationRef.current;
    setLockState({ exam, cleanup: "pending" });
    if (!namespace) {
      if (generationRef.current === generation) {
        setLockState({ exam, cleanup: "error" });
      }
      return;
    }

    try {
      await withBrowserRecoveryRepository(openBrowserOutbox, (repository) => (
        purgeDraftRecoveryData({
          namespace,
          repository,
          sessionStorage: window.sessionStorage,
        })
      ));
      if (generationRef.current === generation) {
        setLockState({ exam, cleanup: "ready" });
      }
    } catch {
      if (generationRef.current === generation) {
        setLockState({ exam, cleanup: "error" });
      }
    }
  }, [namespace]);

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    let cancelled = false;
    const check = () => {
      void refresh(controller.signal)
        .then((result) => {
          if (cancelled) return;
          if (result.kind === "unavailable") return;
          if (result.kind === "auth-denied") {
            void handleSessionDenial();
            return;
          }
          if (!result.exam) {
            observedKeyRef.current = null;
            generationRef.current += 1;
            setLockState(null);
            return;
          }
          const observedKey = `${namespace ?? "missing"}:${result.exam.sessionId}`;
          if (observedKeyRef.current === observedKey) return;
          observedKeyRef.current = observedKey;
          void prepareClosedBookEntry(result.exam);
        })
        .catch(() => undefined);
    };
    check();
    const interval = window.setInterval(check, 15_000);
    return () => {
      cancelled = true;
      generationRef.current += 1;
      controller.abort();
      window.clearInterval(interval);
    };
  }, [enabled, handleSessionDenial, namespace, prepareClosedBookEntry, refresh]);

  const active = lockState?.exam ?? null;
  const alreadyInExam = active && pathname === `/exams/${active.sessionId}`;
  useEffect(() => {
    if (active && !alreadyInExam) resumeRef.current?.focus();
  }, [active, alreadyInExam]);

  useLayoutEffect(() => {
    const locked = sessionBoundaryPending || Boolean(active && !alreadyInExam);
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
  }, [active, alreadyInExam, sessionBoundaryPending]);

  if (sessionBoundaryPending) {
    return (
      <div className={styles.examLockBackdrop} role="presentation">
        <section
          aria-describedby="session-boundary-description"
          aria-labelledby="session-boundary-title"
          aria-modal="true"
          className={styles.examLockDialog}
          role="alertdialog"
        >
          <span className={styles.examLockIcon}><ShieldAlert aria-hidden="true" size={28} /></span>
          <span className={styles.navLabel}>SESSION BOUNDARY</span>
          <h1 id="session-boundary-title">Session ended</h1>
          <p id="session-boundary-description">
            Codestead is clearing private browser recovery before returning to sign in.
          </p>
          <small>Redirecting to sign in...</small>
        </section>
      </div>
    );
  }

  if (!lockState || alreadyInExam) return null;

  if (lockState.cleanup !== "ready") {
    const failed = lockState.cleanup === "error";
    return (
      <div className={styles.examLockBackdrop} role="presentation">
        <section
          aria-describedby="active-exam-cleanup-description"
          aria-labelledby="active-exam-cleanup-title"
          aria-modal="true"
          className={styles.examLockDialog}
          role="alertdialog"
        >
          <span className={styles.examLockIcon}><ShieldAlert aria-hidden="true" size={28} /></span>
          <span className={styles.navLabel}>CLOSED-BOOK EXAM ACTIVE</span>
          <h1 id="active-exam-cleanup-title">
            {failed ? "Private browser cleanup needs retry" : "Preparing private exam recovery"}
          </h1>
          <p id="active-exam-cleanup-description">
            Ordinary learning remains locked while Codestead removes lesson drafts from this browser. Exam recovery is preserved.
          </p>
          {failed ? (
            <button
              className="button button-primary"
              onClick={() => { void prepareClosedBookEntry(lockState.exam); }}
              type="button"
            >
              Retry browser storage cleanup
            </button>
          ) : <small>Preparing private browser storage...</small>}
        </section>
      </div>
    );
  }

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
          {lockState.exam.courseTitle} - {lockState.exam.moduleTitle} is still timed. Lessons, Codestead, practice games, general code runs, files, and project work remain server-locked until it is submitted or finalized.
        </p>
        <Link className="button button-primary" href={`/exams/${lockState.exam.sessionId}`} ref={resumeRef}>
          <ClipboardCheck size={16} /> Resume timed exam
        </Link>
        <small>The server timer continues. This screen does not decide misconduct; navigation and focus evidence remains available for human review.</small>
      </section>
    </div>
  );
}
