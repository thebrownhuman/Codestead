"use client";

import { Laptop, ShieldAlert } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { formatDateTime, requestAdminJson } from "./admin-utils";
import styles from "./admin.module.css";
import { EmptyState, StatusPill } from "./status-pill";

type SessionView = {
  id: string;
  current: boolean;
  state: "active" | "expired" | "revoked";
  deviceLabel: string;
  lastSeenAt: string;
  expiresAt: string;
  endedAt: string | null;
};

type RequestView = {
  id: string;
  sessionId: string;
  reason: string;
  requestChannel?: "authenticated" | "email_proof";
  identityVerifiedAt?: string | null;
  status: string;
  decisionReason: string | null;
  createdAt: string;
};

type ResponseBody = {
  sessions: SessionView[];
  revocationRequests: RequestView[];
};

export function AdminSessionControls({ learnerId }: { readonly learnerId: string }) {
  const [data, setData] = useState<ResponseBody | null>(null);
  const [totp, setTotp] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    setData(await requestAdminJson<ResponseBody>(
      `/api/admin/learners/${encodeURIComponent(learnerId)}/sessions`,
    ));
  }, [learnerId]);

  useEffect(() => {
    const controller = new AbortController();
    void requestAdminJson<ResponseBody>(
      `/api/admin/learners/${encodeURIComponent(learnerId)}/sessions`,
      { signal: controller.signal },
    )
      .then(setData)
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setMessage(error instanceof Error ? error.message : "Session controls could not be loaded.");
      });
    return () => controller.abort();
  }, [learnerId]);

  async function assertFreshMfa() {
    if (!/^\d{6}$/.test(totp)) throw new Error("Enter the current six-digit authenticator code.");
    const response = await fetch("/api/security/fresh-mfa", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: totp }),
    });
    const body = (await response.json()) as { error?: string };
    if (!response.ok) throw new Error(body.error ?? "Fresh MFA verification failed.");
  }

  async function privilegedPost(url: string, body: Record<string, string>) {
    if (reason.trim().length < 8) throw new Error("Enter a specific reason of at least eight characters.");
    await assertFreshMfa();
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const result = (await response.json()) as { error?: string };
    if (!response.ok) throw new Error(result.error ?? "The session action failed.");
  }

  async function revoke(sessionId: string) {
    setBusy(true);
    setMessage(null);
    try {
      await privilegedPost(
        `/api/admin/learners/${encodeURIComponent(learnerId)}/sessions/${encodeURIComponent(sessionId)}/revoke`,
        { reason },
      );
      setMessage("Session revoked. The learner was notified.");
      setTotp("");
      setReason("");
      await load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "The session could not be revoked.");
    } finally {
      setBusy(false);
    }
  }

  async function decide(requestId: string, decision: "approved" | "rejected") {
    setBusy(true);
    setMessage(null);
    try {
      await privilegedPost(
        `/api/admin/session-revocation-requests/${encodeURIComponent(requestId)}/decision`,
        { decision, reason },
      );
      setMessage(`Revocation request ${decision}. The learner was notified.`);
      setTotp("");
      setReason("");
      await load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "The request could not be decided.");
    } finally {
      setBusy(false);
    }
  }

  const pending = data?.revocationRequests.filter((item) => item.status === "pending") ?? [];
  return (
    <article className={`${styles.panel} ${styles.spanTwo}`}>
      <div className={styles.panelHead}>
        <div><Laptop size={18} /><span><strong>Authentication sessions</strong><small>Active and recent browser profiles; token and network data are never returned</small></span></div>
        <span className="pill">{data?.sessions.filter((item) => item.state === "active").length ?? 0} active</span>
      </div>
      {message && <p aria-live="polite" className={styles.inlineSuccess}>{message}</p>}
      {data?.sessions.length ? (
        <div className={styles.eventList}>
          {data.sessions.map((item) => (
            <div className={styles.eventRow} key={item.id}>
              <Laptop size={15} />
              <span><strong>{item.deviceLabel}</strong><small>Last seen {formatDateTime(item.lastSeenAt)} · {item.endedAt ? `ended ${formatDateTime(item.endedAt)}` : `expires ${formatDateTime(item.expiresAt)}`}</small></span>
              {item.state === "active" ? <button className="button button-secondary" disabled={busy} onClick={() => void revoke(item.id)}>Revoke</button> : <StatusPill status={item.state} />}
            </div>
          ))}
        </div>
      ) : <EmptyState title="No authentication sessions" detail="No active or archived session metadata is available." />}

      {pending.length > 0 && <div className={styles.requestList} style={{ marginTop: 14 }}>
        {pending.map((item) => (
          <div className={styles.requestCard} key={item.id}>
            <div>
              <div className={styles.requestIdentity}><ShieldAlert size={17} /><div><strong>Lost-device revocation request</strong><small>Submitted {formatDateTime(item.createdAt)} · {item.requestChannel === "email_proof" ? `mailbox proof ${item.identityVerifiedAt ? "verified" : "incomplete"}` : "submitted from the active session"}</small></div></div>
              <p className={styles.requestReason}>{item.reason}</p>
            </div>
            <div className={styles.headActions}>
              <button className="button button-secondary" disabled={busy} onClick={() => void decide(item.id, "rejected")}>Reject</button>
              <button className="button button-primary" disabled={busy} onClick={() => void decide(item.id, "approved")}>Approve and revoke</button>
            </div>
          </div>
        ))}
      </div>}

      <div className={styles.approveForm} style={{ marginTop: 14 }}>
        <label>Current six-digit authenticator code<input autoComplete="one-time-code" inputMode="numeric" maxLength={6} onChange={(event) => setTotp(event.target.value.replace(/\D/g, ""))} pattern="[0-9]{6}" type="password" value={totp} /></label>
        <label>Recorded reason<textarea maxLength={500} minLength={8} onChange={(event) => setReason(event.target.value)} value={reason} /></label>
        <p className={styles.safeNotice}><ShieldAlert size={14} /> A mailbox link proves control of the approved email only. Confirm identity through the separate operator procedure; every revoke or decision also requires fresh MFA, a reason, a durable audit event, and learner notification.</p>
      </div>
    </article>
  );
}
