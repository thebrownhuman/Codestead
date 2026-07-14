"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRight, BookOpenCheck, LoaderCircle, RefreshCw } from "lucide-react";
import { useRef, useState } from "react";

import type { AuthoritativeDashboardData } from "@/lib/dashboard/learner";
import styles from "./learner-dashboard.module.css";

type RoadmapProjection = AuthoritativeDashboardData["roadmap"];

const INITIALIZATION_ERROR =
  "Your roadmap could not be created. Retry uses the same safe request ID.";

function publicationCount(roadmap: RoadmapProjection) {
  return roadmap.unavailableTrackIds.length || roadmap.selectedTrackIds.length;
}

function safeErrorMessage(raw: string) {
  if (!raw.trim()) return INITIALIZATION_ERROR;
  try {
    const value = JSON.parse(raw) as unknown;
    if (value && typeof value === "object" && "error" in value) {
      const error = (value as { error?: unknown }).error;
      if (typeof error === "string" && error.trim().length > 0 && error.trim().length <= 300) {
        return error.trim();
      }
    }
  } catch {
    // Non-JSON upstream responses are intentionally replaced with safe copy.
  }
  return INITIALIZATION_ERROR;
}

export function RoadmapEmptyState({ roadmap }: { readonly roadmap: RoadmapProjection }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pendingRef = useRef(false);
  const requestKeyRef = useRef<string | null>(null);

  async function initializePlans() {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    setError(null);

    try {
      if (!requestKeyRef.current) {
        if (typeof globalThis.crypto?.randomUUID !== "function") {
          throw new Error("Secure request identifiers are unavailable.");
        }
        requestKeyRef.current = globalThis.crypto.randomUUID();
      }
      const response = await fetch("/api/learning/plans", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ idempotencyKey: requestKeyRef.current }),
      });
      if (response.ok) {
        // A successful mutation is authoritative even when its optional response
        // body is empty or malformed. Refresh the server projection in all cases.
        router.refresh();
        return;
      }
      const raw = await response.text().catch(() => "");
      setError(safeErrorMessage(raw));
    } catch {
      setError(INITIALIZATION_ERROR);
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  }

  const count = publicationCount(roadmap);
  const publicationSubject = count === 1 ? "One selected course is" : `${count || "Your"} selected courses are`;
  const state = roadmap.state === "ready" ? "unavailable" : roadmap.state;
  const content = {
    no_tracks: {
      title: "No courses selected yet",
      detail: "Explore the curriculum catalog. A saved roadmap is created only after a track is selected and reviewed content is published.",
    },
    awaiting_publication: {
      title: "Selected courses are awaiting publication",
      detail: `${publicationSubject} waiting for a reviewed beta or verified publication. No roadmap has been created yet.`,
    },
    initialization_required: {
      title: "Your roadmap is ready to create",
      detail: "Your selected courses are available, but no saved learning plan exists yet. Create it once; no progress will be invented.",
    },
    unavailable: {
      title: "Roadmap status is temporarily unavailable",
      detail: "We could not verify your saved learning plans right now. Your progress has not been changed.",
    },
  }[state];

  return (
    <article
      aria-labelledby="roadmap-empty-title"
      aria-describedby="roadmap-empty-detail"
      className={`${styles.roadmapEmpty} card`}
      data-roadmap-state={state}
    >
      <span aria-hidden="true" className={styles.roadmapEmptyIcon}>
        <BookOpenCheck size={22} />
      </span>
      <div className={styles.roadmapEmptyCopy}>
        <h3 id="roadmap-empty-title">{content.title}</h3>
        <p id="roadmap-empty-detail">{content.detail}</p>
      </div>
      <div className={styles.roadmapEmptyAction}>
        {state === "initialization_required" ? (
          <button
            aria-busy={pending}
            aria-describedby={error ? "roadmap-initialization-error" : undefined}
            className="button button-secondary"
            disabled={pending}
            id="roadmap-create-action"
            onClick={() => void initializePlans()}
            type="button"
          >
            {pending ? <LoaderCircle aria-hidden="true" className={styles.spin} size={17} /> : <BookOpenCheck aria-hidden="true" size={17} />}
            {pending ? "Creating roadmap..." : "Create my roadmap"}
          </button>
        ) : state === "unavailable" ? (
          <button className="button button-secondary" id="roadmap-retry-action" onClick={() => router.refresh()} type="button">
            <RefreshCw aria-hidden="true" size={17} /> Try again
          </button>
        ) : (
          <Link className="button button-secondary" href="/courses">
            {state === "no_tracks" ? "View course catalog" : "View curriculum previews"}
            <ArrowRight aria-hidden="true" size={17} />
          </Link>
        )}
      </div>
      {error ? <p className={styles.roadmapEmptyError} id="roadmap-initialization-error" role="alert">{error}</p> : null}
      {state === "awaiting_publication" && roadmap.selectedTrackPreviews.length ? (
        <section
          aria-labelledby="selected-curriculum-previews-title"
          className={styles.roadmapPreviewSection}
        >
          <div className={styles.roadmapPreviewHeading}>
            <h4 id="selected-curriculum-previews-title">Selected curriculum previews</h4>
            <p>Browse the declared scope while editorial review is still in progress.</p>
          </div>
          <ul className={styles.roadmapPreviewGrid}>
            {roadmap.selectedTrackPreviews.map((preview) => (
              <li key={preview.id}>
                <article className={styles.roadmapPreviewCard}>
                  <div className={styles.roadmapPreviewStatus}>
                    <span>{preview.publicationReady ? "Reviewed publication ready" : "Awaiting human review"}</span>
                  </div>
                  <h5>{preview.title}</h5>
                  <p>{preview.summary}</p>
                  <dl className={styles.roadmapPreviewMeta}>
                    <div><dt>Modules</dt><dd>{preview.moduleCount}</dd></div>
                    <div><dt>Skills</dt><dd>{preview.skillCount}</dd></div>
                  </dl>
                  <p className={styles.roadmapPreviewNotice}>
                    Preview only. It cannot award progress, mastery, badges, or exam credit before publication.
                  </p>
                  {preview.href ? (
                    <Link className={styles.roadmapPreviewLink} href={preview.href}>
                      Preview curriculum <ArrowRight aria-hidden="true" size={16} />
                    </Link>
                  ) : (
                    <span className={styles.roadmapPreviewUnavailable}>Curriculum preview unavailable</span>
                  )}
                </article>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </article>
  );
}
