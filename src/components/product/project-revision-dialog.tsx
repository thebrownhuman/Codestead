"use client";

import { Download, FileCheck2, GitCommitHorizontal, History, Plus, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { ModalDialog } from "@/components/ui/modal-dialog";

import styles from "./product-pages.module.css";

type RevisionFile = {
  objectId: string | null;
  originalName: string;
  mediaType: string;
  sizeBytes: number;
  sha256: string;
  available: boolean;
  downloadUrl: string | null;
};

type ProjectRevision = {
  id: string;
  projectId: string;
  sequence: number;
  changeSummary: string;
  reflection: string | null;
  createdAt: string;
  files: RevisionFile[];
};

type RevisionHistory = {
  latestSequence: number;
  revisions: ProjectRevision[];
  nextBeforeSequence: number | null;
};

type LibraryFile = {
  id: string;
  name: string;
  mediaType: string;
  sizeBytes: number;
  scanStatus: string;
  createdAt: string;
};

function formatBytes(bytes: number) {
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${bytes} B`;
}

function safeMessage(cause: unknown) {
  return cause instanceof Error ? cause.message : "Project revisions are temporarily unavailable.";
}

export function ProjectRevisionDialog({
  projectId,
  projectTitle,
  onClose,
}: Readonly<{
  projectId: string;
  projectTitle: string;
  onClose: () => void;
}>) {
  const [history, setHistory] = useState<RevisionHistory | null>(null);
  const [files, setFiles] = useState<LibraryFile[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [olderBusy, setOlderBusy] = useState(false);
  const requestRef = useRef<{ fingerprint: string; id: string } | null>(null);

  const readHistory = useCallback(async (beforeSequence?: number) => {
    const query = new URLSearchParams({ limit: "20" });
    if (beforeSequence) query.set("beforeSequence", String(beforeSequence));
    const response = await fetch(
      `/api/projects/${encodeURIComponent(projectId)}/revisions?${query}`,
      { cache: "no-store" },
    );
    const body = await response.json() as RevisionHistory & { error?: string };
    if (!response.ok) throw new Error(body.error ?? "Revision history could not be loaded.");
    return body;
  }, [projectId]);

  useEffect(() => {
    const controller = new AbortController();
    Promise.all([
      readHistory(),
      fetch("/api/files", { cache: "no-store", signal: controller.signal }).then(async (response) => {
        const body = await response.json() as { files?: LibraryFile[]; error?: string };
        if (!response.ok) throw new Error(body.error ?? "Project files could not be loaded.");
        return (body.files ?? []).filter((file) => file.scanStatus === "safe");
      }),
    ]).then(([revisionHistory, safeFiles]) => {
      setHistory(revisionHistory);
      setFiles(safeFiles);
    }).catch((cause: unknown) => {
      if (cause instanceof DOMException && cause.name === "AbortError") return;
      setError(safeMessage(cause));
    });
    return () => {
      controller.abort();
    };
  }, [readHistory]);

  function requestClose() {
    if (busy) return;
    if (dirty && !window.confirm("Discard this unfinished revision checkpoint?")) return;
    onClose();
  }

  async function createRevision(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!history) return;
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const changeSummary = String(form.get("changeSummary") ?? "").trim();
    const reflection = String(form.get("reflection") ?? "").trim();
    const fileIds = form.getAll("fileIds").map(String).sort();
    const fingerprint = JSON.stringify({
      projectId,
      expectedLatestRevision: history.latestSequence,
      changeSummary,
      reflection,
      fileIds,
    });
    if (requestRef.current?.fingerprint !== fingerprint) {
      requestRef.current = { fingerprint, id: crypto.randomUUID() };
    }
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/revisions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          clientRequestId: requestRef.current.id,
          expectedLatestRevision: history.latestSequence,
          changeSummary,
          reflection: reflection || null,
          fileIds,
        }),
      });
      const body = await response.json() as {
        revision?: ProjectRevision;
        duplicate?: boolean;
        error?: string;
        code?: string;
      };
      if (!response.ok || !body.revision) {
        if (body.code === "VERSION_CONFLICT") setHistory(await readHistory());
        throw new Error(body.error ?? "Project revision could not be saved.");
      }
      setHistory((current) => current ? {
        latestSequence: Math.max(current.latestSequence, body.revision!.sequence),
        revisions: [
          body.revision!,
          ...current.revisions.filter((revision) => revision.id !== body.revision!.id),
        ],
        nextBeforeSequence: current.nextBeforeSequence,
      } : current);
      requestRef.current = null;
      formElement.reset();
      setDirty(false);
      setMessage(body.duplicate
        ? `Revision ${body.revision.sequence} was already safely recorded.`
        : `Revision ${body.revision.sequence} was recorded.`);
    } catch (cause) {
      setError(safeMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function loadOlder() {
    if (!history?.nextBeforeSequence) return;
    setOlderBusy(true);
    setError(null);
    try {
      const older = await readHistory(history.nextBeforeSequence);
      setHistory((current) => current ? {
        ...current,
        revisions: [
          ...current.revisions,
          ...older.revisions.filter((item) => !current.revisions.some((existing) => existing.id === item.id)),
        ],
        nextBeforeSequence: older.nextBeforeSequence,
      } : older);
    } catch (cause) {
      setError(safeMessage(cause));
    } finally {
      setOlderBusy(false);
    }
  }

  return (
    <ModalDialog
      backdropClassName={styles.dialogBackdrop}
      describedBy="project-revisions-description"
      dialogClassName={`${styles.dialog} ${styles.revisionDialog} card`}
      labelledBy="project-revisions-title"
      onClose={requestClose}
    >
        <div className={styles.dialogHead}>
          <div>
            <h2 id="project-revisions-title">Revision history · {projectTitle}</h2>
            <p id="project-revisions-description">Record your own checkpoints and existing safety-approved files.</p>
          </div>
          <button aria-label="Close revision history" className={styles.iconButton} data-dialog-initial-focus onClick={requestClose} type="button"><X size={17} /></button>
        </div>

        <p className={styles.fileSafety}><FileCheck2 size={14} /> Association does not copy a file or consume quota again. It never sends file contents to Codestead, a runner, or repository review.</p>
        {error && <p className={styles.error} role="alert">{error}</p>}
        {message && <p className={styles.success} role="status">{message}</p>}

        <form className={`${styles.form} ${styles.revisionForm}`} onChange={() => setDirty(true)} onSubmit={createRevision}>
          <label>What changed?<textarea maxLength={1_000} minLength={10} name="changeSummary" placeholder="Describe the checkpoint in your own words." required /></label>
          <label>Reflection (optional)<textarea maxLength={4_000} name="reflection" placeholder="What did you learn, test, or decide next?" /></label>
          <fieldset className={styles.revisionFiles}>
            <legend>Associate existing safe files (optional)</legend>
            {files.length ? files.map((file) => (
              <label key={file.id}>
                <input name="fileIds" type="checkbox" value={file.id} />
                <span><strong>{file.name}</strong><small>{formatBytes(file.sizeBytes)} · safety scan passed</small></span>
              </label>
            )) : <p>No safety-approved files are available. Upload and scan a file in the library first.</p>}
          </fieldset>
          <button className="button button-primary" disabled={busy || !history} type="submit"><Plus size={15} /> {busy ? "Recording…" : "Record checkpoint"}</button>
        </form>

        <section aria-labelledby="revision-timeline-title" className={styles.revisionHistory}>
          <div className={styles.sectionTitle}><div><h3 id="revision-timeline-title">Append-only timeline</h3><p>{history ? `${history.latestSequence} recorded checkpoint${history.latestSequence === 1 ? "" : "s"}` : "Loading history…"}</p></div><History aria-hidden="true" size={19} /></div>
          {history?.revisions.length === 0 && <p className={styles.fileEmpty}>No checkpoints yet. Your first saved revision will be revision 1.</p>}
          {history?.revisions.map((revision) => (
            <article className={styles.revisionItem} key={revision.id}>
              <div className={styles.revisionHeading}>
                <h4><GitCommitHorizontal aria-hidden="true" size={15} /> Revision {revision.sequence}</h4>
                <time dateTime={revision.createdAt}>{new Date(revision.createdAt).toLocaleString()}</time>
              </div>
              <p>{revision.changeSummary}</p>
              {revision.reflection && <blockquote>{revision.reflection}</blockquote>}
              {revision.files.length > 0 && <ul>{revision.files.map((file, index) => (
                <li key={`${revision.id}-${index}-${file.sha256}`}>
                  <span><strong>{file.originalName}</strong><small>{formatBytes(file.sizeBytes)} · SHA-256 {file.sha256.slice(0, 12)}…</small></span>
                  {file.available && file.downloadUrl
                    ? <a className="button button-ghost" download href={file.downloadUrl}><Download size={13} /> Download</a>
                    : <span className={styles.status}>Historical metadata · file unavailable</span>}
                </li>
              ))}</ul>}
            </article>
          ))}
          {history?.nextBeforeSequence && <button className="button button-secondary" disabled={olderBusy} onClick={() => void loadOlder()} type="button">{olderBusy ? "Loading…" : "Load older revisions"}</button>}
        </section>
    </ModalDialog>
  );
}
