"use client";

import { Download, FileUp, HardDrive, ShieldCheck, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import styles from "./product-pages.module.css";

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

type StoredFile = {
  readonly id: string;
  readonly name: string;
  readonly mediaType: string;
  readonly sizeBytes: number;
  readonly scanStatus: string;
  readonly createdAt: string;
};

type FileLibraryResponse = {
  readonly files: readonly StoredFile[];
  readonly uploadsEnabled: boolean;
  readonly quota: { readonly usedBytes: number; readonly limitBytes: number };
};

function formatBytes(bytes: number) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${bytes} B`;
}

export function FileLibrary() {
  const [library, setLibrary] = useState<FileLibraryResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const uploadRequestRef = useRef<{ file: File; key: string } | null>(null);

  const fetchLibrary = useCallback(async (signal?: AbortSignal) => {
    const response = await fetch("/api/files", { cache: "no-store", signal });
    const body = (await response.json()) as FileLibraryResponse & { error?: string };
    if (!response.ok) throw new Error(body.error ?? "Stored files are temporarily unavailable.");
    return body;
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void fetchLibrary(controller.signal)
      .then(setLibrary)
      .catch((cause: unknown) => {
        if (cause instanceof DOMException && cause.name === "AbortError") return;
        setError(cause instanceof Error ? cause.message : "Stored files are temporarily unavailable.");
      });
    return () => controller.abort();
  }, [fetchLibrary]);

  async function upload() {
    const file = inputRef.current?.files?.[0];
    setError(null);
    setMessage(null);
    if (!file) {
      setError("Choose one supported file first.");
      return;
    }
    if (file.size <= 0 || file.size > MAX_UPLOAD_BYTES) {
      setError("Files must be between 1 byte and 50 MB.");
      return;
    }
    setBusy(true);
    try {
      if (uploadRequestRef.current?.file !== file) {
        uploadRequestRef.current = { file, key: globalThis.crypto.randomUUID() };
      }
      const form = new FormData();
      form.set("file", file);
      const response = await fetch("/api/files", {
        method: "POST",
        headers: { "Idempotency-Key": uploadRequestRef.current.key },
        body: form,
      });
      const body = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(body.error ?? "The file could not be stored.");
      uploadRequestRef.current = null;
      if (inputRef.current) inputRef.current.value = "";
      setLibrary(await fetchLibrary());
      setMessage("File stored in quarantine. Download becomes available only after the safety scan passes.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The file could not be stored.");
    } finally {
      setBusy(false);
    }
  }

  async function remove(fileId: string) {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const response = await fetch(`/api/files/${encodeURIComponent(fileId)}`, { method: "DELETE" });
      if (!response.ok) {
        const body = (await response.json()) as { code?: string; error?: string };
        if (body.code === "FILE_DELETE_COMMIT_AMBIGUOUS") {
          throw new Error("Deletion outcome is uncertain. Retry deleting this same file.");
        }
        throw new Error(body.error ?? "The file could not be deleted.");
      }
      setPendingDelete(null);
      setLibrary(await fetchLibrary());
      setMessage("File hidden, its quota released, and physical deletion scheduled for durable erasure.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The file could not be deleted.");
    } finally {
      setBusy(false);
    }
  }

  const usedBytes = library?.quota.usedBytes ?? 0;
  const limitBytes = library?.quota.limitBytes ?? 2 * 1024 ** 3;
  const percent = limitBytes > 0 ? Math.min(100, (usedBytes / limitBytes) * 100) : 0;
  return (
    <section aria-labelledby="file-library-title" className={`${styles.fileLibrary} card`}>
      <div className={styles.sectionTitle}>
        <div>
          <h2 id="file-library-title">Project file library</h2>
          <p>Source, text, PDF, and safe image formats · 50 MB per file</p>
        </div>
        <HardDrive aria-hidden="true" size={20} />
      </div>
      <div className={styles.quotaSummary}>
        <span><strong>{formatBytes(usedBytes)}</strong> used of {formatBytes(limitBytes)}</span>
        <span>{percent.toFixed(1)}%</span>
        <progress aria-label="Storage quota used" max={limitBytes} value={usedBytes}>{percent.toFixed(1)}%</progress>
      </div>
      {error && <p className={styles.error} role="alert">{error}</p>}
      {message && <p aria-live="polite" className={styles.success} role="status">{message}</p>}
      {library?.uploadsEnabled ? (
        <>
          <div className={styles.fileUploadRow}>
            <label>
              <span className="sr-only">Choose a project file</span>
              <input
                accept=".c,.h,.cpp,.cc,.cxx,.hpp,.java,.py,.pyi,.js,.mjs,.ts,.tsx,.jsx,.html,.css,.json,.md,.txt,.csv,.sql,.pdf,.png,.jpg,.jpeg,.gif,.webp"
                disabled={busy}
                onChange={() => { uploadRequestRef.current = null; }}
                ref={inputRef}
                type="file"
              />
            </label>
            <button className="button button-secondary" disabled={busy} onClick={() => void upload()} type="button">
              <FileUp size={15} /> Upload
            </button>
          </div>
          <p className={styles.fileSafety}><ShieldCheck size={14} /> Executables and archives are rejected. Files remain quarantined until the isolated malware scanner marks them safe.</p>
        </>
      ) : (
        <p className={styles.fileSafety}>
          <ShieldCheck size={14} />
          Uploads are disabled during the private pilot. Existing safe files remain available.
        </p>
      )}
      {!library ? (
        <p className={styles.fileEmpty}>Loading private file metadata…</p>
      ) : library.files.length === 0 ? (
        <p className={styles.fileEmpty}>No project files stored yet.</p>
      ) : (
        <ul className={styles.fileList}>
          {library.files.map((file) => (
            <li key={file.id}>
              <span><strong>{file.name}</strong><small>{formatBytes(file.sizeBytes)} · {file.scanStatus.replaceAll("_", " ")}</small></span>
              <span className={styles.fileActions}>
                {file.scanStatus === "safe" ? (
                  <a className="button button-ghost" download href={`/api/files/${encodeURIComponent(file.id)}`}><Download size={14} /> Download</a>
                ) : <span className={styles.status}>Not downloadable</span>}
                {pendingDelete === file.id ? (
                  <>
                    <button className="button button-secondary" disabled={busy} onClick={() => void remove(file.id)} type="button">Confirm delete</button>
                    <button className="button button-ghost" disabled={busy} onClick={() => setPendingDelete(null)} type="button">Cancel</button>
                  </>
                ) : (
                  <button aria-label={`Delete ${file.name}`} className="button button-ghost" disabled={busy} onClick={() => setPendingDelete(file.id)} type="button"><Trash2 size={14} /> Delete</button>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
