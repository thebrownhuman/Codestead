"use client";

import { Laptop, LogOut, RefreshCcw, ShieldAlert } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { useBrowserDurabilityNamespace } from "@/lib/browser-durability/context";
import { openBrowserOutbox } from "@/lib/browser-durability/indexed-db";
import {
  purgeBrowserRecoveryData,
  withBrowserRecoveryRepository,
} from "@/lib/browser-durability/lifecycle";
import styles from "./product-pages.module.css";

type SessionView = {
  id: string;
  current: boolean;
  state: "active" | "expired" | "revoked";
  deviceLabel: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  endedAt: string | null;
  endReason: string | null;
};

type RevocationRequestView = {
  id: string;
  sessionId: string;
  reason: string;
  status: string;
  decisionReason: string | null;
  createdAt: string;
  decidedAt: string | null;
};

function time(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

const defaultNavigate = (destination: string) => window.location.assign(destination);

function isAuthorizationDenial(response: Response) {
  return response.status === 401 || response.status === 403;
}

export function DeviceSessionsPanel({
  navigate = defaultNavigate,
}: {
  navigate?: (destination: string) => void;
} = {}) {
  const browserDurabilityNamespace = useBrowserDurabilityNamespace();
  const [sessions, setSessions] = useState<SessionView[]>([]);
  const [requests, setRequests] = useState<RevocationRequestView[]>([]);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">("loading");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const mutationRef = useRef(false);
  const authorizationDenialRef = useRef(new Set<number>());
  const generationRef = useRef(0);
  const latestNamespaceRef = useRef(browserDurabilityNamespace);
  useLayoutEffect(() => {
    if (latestNamespaceRef.current !== browserDurabilityNamespace) {
      latestNamespaceRef.current = browserDurabilityNamespace;
      generationRef.current += 1;
    }
  }, [browserDurabilityNamespace]);

  const handleAuthorizationDenial = useCallback(async (
    namespace: string | null,
    generation: number,
  ) => {
    if (authorizationDenialRef.current.has(generation)) return;
    authorizationDenialRef.current.add(generation);
    try {
      await withBrowserRecoveryRepository(openBrowserOutbox, (repository) => (
        purgeBrowserRecoveryData({
          ...(namespace ? { namespace } : {}),
          sessionStorage: window.sessionStorage,
          localStorage: window.localStorage,
          repository,
        })
      ));
    } catch {
      // The durable boundary is published before best-effort cleanup. The
      // anonymous gate retries cleanup before accepting new credentials.
    } finally {
      if (generationRef.current === generation
        && latestNamespaceRef.current === namespace) {
        navigate("/login?reason=session-expired");
      }
    }
  }, [navigate]);

  const load = useCallback(async ({ signal, showLoading = true }: { signal?: AbortSignal; showLoading?: boolean } = {}) => {
    const namespace = browserDurabilityNamespace;
    const generation = generationRef.current;
    if (showLoading) setLoadState("loading");
    setLoadError(null);
    try {
      const response = await fetch("/api/sessions", { cache: "no-store", signal });
      if (isAuthorizationDenial(response)) {
        await handleAuthorizationDenial(namespace, generation);
        return false;
      }
      const body = (await response.json().catch(() => ({}))) as {
        sessions?: SessionView[];
        revocationRequests?: RevocationRequestView[];
        error?: string;
      };
      if (!response.ok) throw new Error(body.error ?? "Sessions could not be loaded.");
      if (signal?.aborted) return false;
      setSessions(body.sessions ?? []);
      setRequests(body.revocationRequests ?? []);
      setLoadState("ready");
      return true;
    } catch (error: unknown) {
      if (signal?.aborted || (error instanceof DOMException && error.name === "AbortError")) return false;
      setLoadState("error");
      setLoadError(error instanceof Error ? error.message : "Sessions could not be loaded.");
      return false;
    }
  }, [browserDurabilityNamespace, handleAuthorizationDenial]);

  useEffect(() => {
    const controller = new AbortController();
    queueMicrotask(() => {
      if (!controller.signal.aborted) void load({ signal: controller.signal, showLoading: false });
      });
    return () => controller.abort();
  }, [load]);

  async function logout(scope: "all" | "others") {
    if (mutationRef.current) return;
    const confirmed = window.confirm(
      scope === "all"
        ? "Sign out every session, including this approved device?"
        : "End every other signed-in session? Your current approved device will stay signed in.",
    );
    if (!confirmed) return;
    mutationRef.current = true;
    setBusy(true);
    setMutationError(null);
    setStatusMessage(null);
    const generation = generationRef.current;
    const namespace = browserDurabilityNamespace;
    try {
      const response = await fetch("/api/sessions", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scope }),
      });
      if (isAuthorizationDenial(response)) {
        await handleAuthorizationDenial(namespace, generation);
        return;
      }
      const body = (await response.json().catch(() => ({}))) as { error?: string; revokedCount?: number };
      if (!response.ok) throw new Error(body.error ?? "Sessions could not be ended.");
      if (scope === "all") {
        if (generationRef.current !== generation
          || latestNamespaceRef.current !== namespace) return;
        try {
          if (generationRef.current !== generation
            || latestNamespaceRef.current !== namespace) return;
          await withBrowserRecoveryRepository(openBrowserOutbox, (repository) => (
            purgeBrowserRecoveryData({
              ...(namespace ? { namespace } : {}),
              sessionStorage: window.sessionStorage,
              localStorage: window.localStorage,
              repository,
            })
          ));
        } catch {
          // The server already ended this session. The anonymous login gate
          // retries global cleanup before exposing credentials.
        }
        if (generationRef.current === generation
          && latestNamespaceRef.current === namespace) {
          navigate("/login?reason=signed-out");
        }
        return;
      }
      setStatusMessage(`${body.revokedCount ?? 0} other session(s) ended.`);
      await load({ showLoading: false });
    } catch (error: unknown) {
      setMutationError(error instanceof Error ? error.message : "Sessions could not be ended.");
    } finally {
      mutationRef.current = false;
      setBusy(false);
    }
  }

  async function requestRevocation(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (mutationRef.current) return;
    const current = sessions.find((item) => item.current && item.state === "active");
    if (!current) {
      setMutationError("No current active approved-device session is available to revoke.");
      return;
    }
    mutationRef.current = true;
    setBusy(true);
    setMutationError(null);
    setStatusMessage(null);
    const namespace = browserDurabilityNamespace;
    const generation = generationRef.current;
    try {
      const response = await fetch("/api/session-revocation-requests", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId: current.id, reason }),
      });
      if (isAuthorizationDenial(response)) {
        await handleAuthorizationDenial(namespace, generation);
        return;
      }
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) throw new Error(body.error ?? "The revocation request could not be sent.");
      setReason("");
      setStatusMessage("The administrator has been notified. Keep this browser available until identity confirmation is complete.");
      await load({ showLoading: false });
    } catch (error: unknown) {
      setMutationError(error instanceof Error ? error.message : "The revocation request could not be sent.");
    } finally {
      mutationRef.current = false;
      setBusy(false);
    }
  }

  const pending = requests.some((item) => item.status === "pending");
  const currentActive = sessions.some((item) => item.current && item.state === "active");

  return (
    <>
      <div className={styles.sectionTitle}>
        <div>
          <h2>Approved device and sessions</h2>
          <p>One browser profile can be active. Multiple tabs in that profile share one session.</p>
        </div>
        <button className="button button-secondary" disabled={busy || loadState === "loading"} onClick={() => void load()} type="button">
          <RefreshCcw size={15} /> {loadState === "loading" ? "Refreshing…" : "Refresh"}
        </button>
      </div>
      {loadState === "loading" && sessions.length === 0 && <p role="status">Loading approved-device sessions…</p>}
      {loadState === "error" && (
        <div className={styles.sideCard} role="alert">
          <strong>Approved-device sessions could not be loaded</strong>
          <p>{loadError}</p>
          <button className="button button-secondary" disabled={busy} onClick={() => void load()} type="button">
            <RefreshCcw size={15} /> Retry loading sessions
          </button>
        </div>
      )}
      {mutationError && <p className={styles.error} role="alert">{mutationError}</p>}
      {statusMessage && <p role="status">{statusMessage}</p>}
      <div aria-busy={loadState === "loading" || busy} className={styles.credentialList}>
        {sessions.length ? sessions.map((item) => (
          <div className={styles.credential} key={item.id}>
            <span className={styles.providerMark}><Laptop size={18} /></span>
            <span>
              <strong>{item.deviceLabel} {item.current && <i className="pill">current</i>}</strong>
              <small>
                {item.state} · last seen {time(item.lastSeenAt)}
                {item.endedAt ? ` · ended ${time(item.endedAt)}` : ` · expires ${time(item.expiresAt)}`}
              </small>
            </span>
            <span className="pill">{item.state}</span>
          </div>
        )) : loadState === "ready" ? <p>No session history is available.</p> : null}
      </div>
      <div className={styles.credentialActions}>
        <button className="button button-secondary" disabled={busy || loadState !== "ready" || sessions.length === 0} onClick={() => void logout("others")} type="button">
          <LogOut size={15} /> End other sessions
        </button>
        <button className="button button-secondary" disabled={busy || loadState !== "ready" || !currentActive} onClick={() => void logout("all")} type="button">
          <LogOut size={15} /> Sign out everywhere
        </button>
      </div>
      <form aria-busy={busy} className={styles.sideCard} onSubmit={requestRevocation}>
        <h3><ShieldAlert size={16} /> Lost or retiring this browser profile?</h3>
        <p>Request administrator-assisted revocation. The administrator must confirm your identity; submitting this form does not silently unlock another device.</p>
        <label>
          Why should this device be revoked?
          <textarea
            disabled={busy || pending || loadState !== "ready" || !currentActive}
            minLength={12}
            maxLength={500}
            onChange={(event) => setReason(event.target.value)}
            required
            value={reason}
          />
        </label>
        <button className="button button-secondary" disabled={busy || pending || loadState !== "ready" || !currentActive} type="submit">
          {pending ? "Request pending" : busy ? "Sending request…" : "Request administrator revocation"}
        </button>
        {!currentActive && loadState === "ready" && <small>No current active approved device is available for this request.</small>}
      </form>
      {requests.length > 0 && (
        <div className={styles.sideCard}>
          <h3>Revocation request history</h3>
          {requests.map((item) => (
            <p key={item.id}>
              <strong>{item.status}</strong> · {time(item.createdAt)} · {item.decisionReason ?? item.reason}
            </p>
          ))}
        </div>
      )}
    </>
  );
}
