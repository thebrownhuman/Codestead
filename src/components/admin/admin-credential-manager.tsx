"use client";

import {
  Eye,
  EyeOff,
  FlaskConical,
  KeyRound,
  Power,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { AdminApiError, credentialTail, humanize, requestAdminJson } from "./admin-utils";
import styles from "./admin.module.css";
import { EmptyState, StatusPill } from "./status-pill";
import type { SafeCredentialSummary } from "./types";

type Operation = "reveal" | "test" | "replace" | "enable" | "disable" | "delete";

type RevealedCredential = Readonly<{
  credential: string;
  provider: string;
  expiresAt: number;
}>;

const REVEAL_LIFETIME_MS = 30_000;

export function AdminCredentialManager({
  learnerId,
  credentials,
  onChanged,
}: {
  readonly learnerId: string;
  readonly credentials: readonly SafeCredentialSummary[];
  readonly onChanged: () => Promise<void>;
}) {
  const [selectedId, setSelectedId] = useState(credentials[0]?.id ?? "");
  const [totp, setTotp] = useState("");
  const [reason, setReason] = useState("");
  const [replacementSecret, setReplacementSecret] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busyAction, setBusyAction] = useState<Operation | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [isError, setIsError] = useState(false);
  const [revealed, setRevealed] = useState<RevealedCredential | null>(null);
  const revealTimer = useRef<number | null>(null);

  const selected = useMemo(
    () => credentials.find((credential) => credential.id === selectedId) ?? credentials[0] ?? null,
    [credentials, selectedId],
  );

  const clearReveal = useCallback(() => {
    if (revealTimer.current !== null) {
      window.clearTimeout(revealTimer.current);
      revealTimer.current = null;
    }
    setRevealed(null);
  }, []);

  function selectCredential(credentialId: string) {
    clearReveal();
    setReplacementSecret("");
    setConfirmDelete(false);
    setSelectedId(credentialId);
  }

  useEffect(() => {
    return () => clearReveal();
  }, [clearReveal]);

  async function verifyFreshMfa() {
    if (!/^\d{6}$/.test(totp)) {
      throw new Error("Enter the current six-digit authenticator code.");
    }
    if (reason.trim().length < 8 || reason.trim().length > 500) {
      throw new Error("Record a specific reason of 8 to 500 characters.");
    }
    await requestAdminJson<{ ok: true }>("/api/security/fresh-mfa", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: totp }),
    });
  }

  async function runOperation(action: Operation) {
    setBusyAction(action);
    setMessage(null);
    setIsError(false);
    if (action !== "reveal") clearReveal();
    if (action !== "replace") setReplacementSecret("");
    try {
      if (!selected) throw new Error("Choose a learner credential first.");
      if (action === "replace" && (replacementSecret.trim().length < 8 || replacementSecret.trim().length > 4_096)) {
        throw new Error("Enter a replacement credential of 8 to 4,096 characters.");
      }
      if (action === "delete" && !confirmDelete) {
        throw new Error("Confirm that this credential should be permanently deleted.");
      }
      await verifyFreshMfa();

      if (action === "reveal") {
        const result = await requestAdminJson<{
          credential: string;
          provider: string;
        }>(`/api/admin/credentials/${encodeURIComponent(selected.id)}/reveal`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ reason: reason.trim() }),
        });
        const expiresAt = Date.now() + REVEAL_LIFETIME_MS;
        setRevealed({ credential: result.credential, provider: result.provider, expiresAt });
        revealTimer.current = window.setTimeout(clearReveal, REVEAL_LIFETIME_MS);
        setMessage("Credential revealed for 30 seconds. The access was audited and the learner was notified.");
      } else {
        const method = action === "delete" ? "DELETE" : "PATCH";
        const requestId = action === "test" || action === "replace" ? crypto.randomUUID() : undefined;
        const body = action === "delete"
          ? { learnerId, reason: reason.trim() }
          : {
              learnerId,
              reason: reason.trim(),
              action,
              ...(requestId ? { requestId } : {}),
              ...(action === "replace" ? { secret: replacementSecret.trim() } : {}),
            };
        const url = `/api/admin/credentials/${encodeURIComponent(selected.id)}`;
        const init = {
          method,
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        } satisfies RequestInit;
        let result: { status: string };
        try {
          result = await requestAdminJson<{ status: string }>(url, init);
        } catch (error) {
          if (!requestId || error instanceof AdminApiError) throw error;
          // Retry only an indeterminate transport failure. Reusing the UUID
          // makes the server replay a committed test/replacement safely.
          result = await requestAdminJson<{ status: string }>(url, init);
        }
        setMessage(
          action === "delete"
            ? "Credential deleted. The audit and required learner notifications were committed with the deletion."
            : `Credential ${humanize(action)} completed with status ${humanize(result.status)}. The learner was notified.`,
        );
        setReplacementSecret("");
        setConfirmDelete(false);
        await onChanged();
      }
      setTotp("");
      setReason("");
    } catch (error) {
      setIsError(true);
      setMessage(error instanceof Error ? error.message : "Credential operation could not be completed safely.");
    } finally {
      if (action === "replace") setReplacementSecret("");
      setBusyAction(null);
    }
  }

  return (
    <article className={`${styles.panel} ${styles.spanTwo}`}>
      <div className={styles.panelHead}>
        <div>
          <KeyRound size={18} />
          <span>
            <strong>Provider credential operations</strong>
            <small>Ordinary view: provider, state, and last four only</small>
          </span>
        </div>
        <span className="pill">{credentials.length}</span>
      </div>

      {message && (
        <p
          aria-live={isError ? "assertive" : "polite"}
          className={isError ? styles.inlineError : styles.inlineSuccess}
          role={isError ? "alert" : "status"}
        >
          {message}
        </p>
      )}

      {credentials.length ? (
        <div aria-label="Learner provider credentials" className={styles.credentialChoiceList}>
          {credentials.map((credential) => (
            <button
              aria-pressed={credential.id === selected?.id}
              className={`${styles.credentialChoice} ${credential.id === selected?.id ? styles.credentialChoiceActive : ""}`}
              key={credential.id}
              onClick={() => selectCredential(credential.id)}
              type="button"
            >
              <KeyRound aria-hidden="true" size={15} />
              <span>
                <strong>{humanize(credential.provider)}</strong>
                <small>{credential.failureCode ? `Code ${credential.failureCode} · ` : ""}last four {credential.lastFour}</small>
              </span>
              <span>
                <span className={styles.credentialTail}>{credentialTail(credential.lastFour)}</span>
                <StatusPill status={credential.status} />
              </span>
            </button>
          ))}
        </div>
      ) : <EmptyState title="No credentials" detail="This learner has not stored an AI provider credential." />}

      {selected && (
        <fieldset className={styles.credentialCeremony} disabled={busyAction !== null}>
          <legend>Fresh-MFA credential ceremony for {humanize(selected.provider)}</legend>
          <div className={styles.credentialFields}>
            <label>
              Current six-digit authenticator code
              <input
                autoComplete="one-time-code"
                inputMode="numeric"
                maxLength={6}
                onChange={(event) => setTotp(event.target.value.replace(/\D/g, ""))}
                pattern="[0-9]{6}"
                type="password"
                value={totp}
              />
            </label>
            <label>
              Recorded reason
              <textarea
                maxLength={500}
                minLength={8}
                onChange={(event) => setReason(event.target.value)}
                placeholder="Explain why this learner credential must be accessed or changed. Never paste a key here."
                value={reason}
              />
            </label>
            <label>
              Replacement credential (replace only)
              <input
                autoComplete="off"
                maxLength={4_096}
                minLength={8}
                onChange={(event) => setReplacementSecret(event.target.value)}
                spellCheck={false}
                type="password"
                value={replacementSecret}
              />
            </label>
          </div>

          <div className={styles.credentialActions}>
            <button className="button button-secondary" onClick={() => void runOperation("reveal")} type="button">
              <Eye size={14} /> {busyAction === "reveal" ? "Revealing…" : "Reveal for 30 seconds"}
            </button>
            <button className="button button-secondary" onClick={() => void runOperation("test")} type="button">
              <FlaskConical size={14} /> {busyAction === "test" ? "Testing…" : "Test credential"}
            </button>
            <button className="button button-secondary" onClick={() => void runOperation("replace")} type="button">
              <RefreshCw size={14} /> {busyAction === "replace" ? "Replacing…" : "Replace credential"}
            </button>
            <button
              className="button button-secondary"
              onClick={() => void runOperation(selected.status === "disabled" ? "enable" : "disable")}
              type="button"
            >
              <Power size={14} /> {selected.status === "disabled" ? "Enable credential" : "Disable credential"}
            </button>
          </div>

          <label className={styles.credentialDeleteConfirm}>
            <input checked={confirmDelete} onChange={(event) => setConfirmDelete(event.target.checked)} type="checkbox" />
            I confirm this learner credential should be permanently deleted.
          </label>
          <button className="button button-secondary" onClick={() => void runOperation("delete")} type="button">
            <Trash2 size={14} /> {busyAction === "delete" ? "Deleting…" : "Delete credential"}
          </button>
        </fieldset>
      )}

      {revealed && (
        <section aria-label="Temporarily revealed credential" className={styles.credentialReveal}>
          <div>
            <ShieldAlert aria-hidden="true" size={17} />
            <span>
              <strong>{humanize(revealed.provider)} plaintext — clears automatically in 30 seconds</strong>
              <small>Do not paste this value into the reason, chat, notes, logs, or screenshots.</small>
            </span>
          </div>
          <code data-sensitive="credential">{revealed.credential}</code>
          <button className="button button-secondary" onClick={clearReveal} type="button">
            <EyeOff size={14} /> Clear now
          </button>
        </section>
      )}

      <p className={styles.safeNotice}>
        <ShieldCheck size={14} /> Every operation requires a fresh authenticator assertion and a reason. Successful changes, their immutable audit event, and required learner notifications commit atomically. Plaintext exists only in this temporary in-memory reveal and is never stored in browser storage.
      </p>
    </article>
  );
}
