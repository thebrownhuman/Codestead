"use client";

import { KeyRound, ShieldAlert, WalletCards } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { credentialTail, formatDateTime, humanize, requestAdminJson } from "./admin-utils";
import styles from "./admin.module.css";
import { EmptyState, StatusPill } from "./status-pill";

type CredentialView = {
  id: string;
  provider: string;
  label: string;
  lastFour: string;
};

type GrantView = {
  id: string;
  learnerId: string;
  credentialId: string;
  model: string;
  tokenBudget: number;
  tokensUsed: number;
  rupeeBudgetPaise: number;
  rupeesUsedPaise: number;
  inputPaisePerMillionTokens: number;
  outputPaisePerMillionTokens: number;
  startsAt: string;
  expiresAt: string;
  revokedAt: string | null;
  provider: string;
  credentialLastFour: string;
};

type ResponseBody = {
  grants: GrantView[];
  availableCredentials: CredentialView[];
  availableModels: Array<{ provider: string; model: string }>;
  learnerConsent: {
    adminFallbackAi: boolean;
    providers: Record<string, boolean>;
  } | null;
};

function tomorrowLocal(): string {
  const tomorrow = new Date(Date.now() + 24 * 60 * 60_000);
  const local = new Date(tomorrow.getTime() - tomorrow.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function grantState(grant: GrantView): "active" | "spent" | "expired" | "revoked" {
  if (grant.revokedAt) return "revoked";
  if (
    grant.tokensUsed >= grant.tokenBudget ||
    grant.rupeesUsedPaise >= grant.rupeeBudgetPaise
  ) return "spent";
  if (new Date(grant.expiresAt).getTime() <= Date.now()) return "expired";
  return "active";
}

function rupeesToPaise(value: string) {
  const match = /^(\d{1,7})(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!match) return null;
  const paise = Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
  return Number.isSafeInteger(paise) ? paise : null;
}

export function AdminFallbackGrantManager({ learnerId }: { readonly learnerId: string }) {
  const [data, setData] = useState<ResponseBody | null>(null);
  const [credentialId, setCredentialId] = useState("");
  const [model, setModel] = useState("");
  const [tokenBudget, setTokenBudget] = useState("50000");
  const [rupeeBudget, setRupeeBudget] = useState("500");
  const [inputRate, setInputRate] = useState("100");
  const [outputRate, setOutputRate] = useState("200");
  const [expiresAt, setExpiresAt] = useState(tomorrowLocal);
  const [totp, setTotp] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [isError, setIsError] = useState(false);
  const pendingCreate = useRef<{ fingerprint: string; requestId: string } | null>(null);
  const pendingRevocations = useRef(new Map<string, { reason: string; requestId: string }>());

  const load = useCallback(async (signal?: AbortSignal) => {
    const result = await requestAdminJson<ResponseBody>(
      `/api/admin/fallback-grants?learnerId=${encodeURIComponent(learnerId)}`,
      { signal },
    );
    setData(result);
    const firstCredential = result.availableCredentials[0];
    setCredentialId(firstCredential?.id ?? "");
    setModel(result.availableModels.find((item) => item.provider === firstCredential?.provider)?.model ?? "");
  }, [learnerId]);

  useEffect(() => {
    const controller = new AbortController();
    void requestAdminJson<ResponseBody>(
      `/api/admin/fallback-grants?learnerId=${encodeURIComponent(learnerId)}`,
      { signal: controller.signal },
    )
      .then((result) => {
        setData(result);
        const firstCredential = result.availableCredentials[0];
        setCredentialId(firstCredential?.id ?? "");
        setModel(result.availableModels.find((item) => item.provider === firstCredential?.provider)?.model ?? "");
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setIsError(true);
        setMessage(error instanceof Error ? error.message : "Fallback grants could not be loaded.");
      });
    return () => controller.abort();
  }, [learnerId, load]);

  const activeCount = useMemo(
    () => data?.grants.filter((grant) => grantState(grant) === "active").length ?? 0,
    [data],
  );

  async function assertFreshMfa() {
    if (!/^\d{6}$/.test(totp)) throw new Error("Enter the current six-digit authenticator code.");
    if (reason.trim().length < 8) throw new Error("Record a specific reason of at least eight characters.");
    const response = await fetch("/api/security/fresh-mfa", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: totp }),
    });
    const body = (await response.json()) as { error?: string };
    if (!response.ok) throw new Error(body.error ?? "Fresh MFA verification failed.");
  }

  async function createGrant() {
    setBusy(true);
    setMessage(null);
    setIsError(false);
    try {
      if (!credentialId) throw new Error("Add and validate an administrator AI credential first.");
      if (!model) throw new Error("Choose an enabled tutor model for the selected provider.");
      const parsedBudget = Number(tokenBudget);
      if (!Number.isInteger(parsedBudget) || parsedBudget < 100 || parsedBudget > 10_000_000) {
        throw new Error("Token budget must be a whole number from 100 to 10,000,000.");
      }
      const parsedRupeeBudget = rupeesToPaise(rupeeBudget);
      const parsedInputRate = rupeesToPaise(inputRate);
      const parsedOutputRate = rupeesToPaise(outputRate);
      if (parsedRupeeBudget === null || parsedRupeeBudget < 100 || parsedRupeeBudget > 10_000_000) {
        throw new Error("Rupee budget must be from INR 1.00 to INR 100,000.00.");
      }
      if (
        parsedInputRate === null || parsedInputRate < 1 || parsedInputRate > 100_000_000 ||
        parsedOutputRate === null || parsedOutputRate < 1 || parsedOutputRate > 100_000_000
      ) {
        throw new Error("Pricing must be from INR 0.01 to INR 1,000,000.00 per million tokens.");
      }
      const expiry = new Date(expiresAt);
      if (Number.isNaN(expiry.getTime())) throw new Error("Choose a valid expiry date and time.");
      await assertFreshMfa();
      const command = {
        learnerId,
        credentialId,
        model,
        tokenBudget: parsedBudget,
        rupeeBudgetPaise: parsedRupeeBudget,
        inputPaisePerMillionTokens: parsedInputRate,
        outputPaisePerMillionTokens: parsedOutputRate,
        expiresAt: expiry.toISOString(),
        reason,
      };
      const fingerprint = JSON.stringify(command);
      const requestId = pendingCreate.current?.fingerprint === fingerprint
        ? pendingCreate.current.requestId
        : crypto.randomUUID();
      pendingCreate.current = { fingerprint, requestId };
      const response = await fetch("/api/admin/fallback-grants", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...command, requestId }),
      });
      const body = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(body.error ?? "Fallback access could not be granted.");
      pendingCreate.current = null;
      setMessage("Capped fallback access granted. The learner was notified.");
      setTotp("");
      setReason("");
      await load();
    } catch (error) {
      setIsError(true);
      setMessage(error instanceof Error ? error.message : "Fallback access could not be granted.");
    } finally {
      setBusy(false);
    }
  }

  async function revokeGrant(grantId: string) {
    setBusy(true);
    setMessage(null);
    setIsError(false);
    try {
      await assertFreshMfa();
      const pending = pendingRevocations.current.get(grantId);
      const requestId = pending?.reason === reason ? pending.requestId : crypto.randomUUID();
      pendingRevocations.current.set(grantId, { reason, requestId });
      const response = await fetch(
        `/api/admin/fallback-grants/${encodeURIComponent(grantId)}/revoke`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ reason, requestId }),
        },
      );
      const body = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(body.error ?? "Fallback access could not be revoked.");
      pendingRevocations.current.delete(grantId);
      setMessage("Fallback access revoked. The learner was notified.");
      setTotp("");
      setReason("");
      await load();
    } catch (error) {
      setIsError(true);
      setMessage(error instanceof Error ? error.message : "Fallback access could not be revoked.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className={`${styles.panel} ${styles.spanTwo}`}>
      <div className={styles.panelHead}>
        <div><WalletCards size={18} /><span><strong>Administrator-funded AI fallback</strong><small>Per learner and model, token and rupee capped, time limited and manually revocable</small></span></div>
        <span className="pill">{activeCount} active</span>
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

      {data?.grants.length ? (
        <div className={styles.eventList}>
          {data.grants.map((grant) => {
            const state = grantState(grant);
            return (
              <div className={styles.eventRow} key={grant.id}>
                <KeyRound size={15} />
                <span>
                  <strong>{humanize(grant.provider)} · {grant.model} {credentialTail(grant.credentialLastFour)}</strong>
                  <small>{grant.tokensUsed.toLocaleString()} / {grant.tokenBudget.toLocaleString()} tokens · INR {(grant.rupeesUsedPaise / 100).toFixed(2)} / INR {(grant.rupeeBudgetPaise / 100).toFixed(2)} · expires {formatDateTime(grant.expiresAt)}</small>
                </span>
                {state === "active" ? (
                  <button className="button button-secondary" disabled={busy} onClick={() => void revokeGrant(grant.id)} type="button">Revoke</button>
                ) : <StatusPill status={state} />}
              </div>
            );
          })}
        </div>
      ) : <EmptyState title="No fallback grants" detail="No administrator-funded AI access has been issued to this learner." />}

      <div className={styles.approveForm} style={{ marginTop: 14 }}>
        <label>
          Administrator credential
          <select onChange={(event) => {
            const nextId = event.target.value;
            const provider = data?.availableCredentials.find((item) => item.id === nextId)?.provider;
            setCredentialId(nextId);
            setModel(data?.availableModels.find((item) => item.provider === provider)?.model ?? "");
          }} value={credentialId}>
            <option value="">Choose an active credential</option>
            {data?.availableCredentials.map((credential) => (
              <option disabled={data.learnerConsent?.providers[credential.provider] !== true} key={credential.id} value={credential.id}>{humanize(credential.provider)} · {credential.label} · {credentialTail(credential.lastFour)}{data.learnerConsent?.providers[credential.provider] === true ? "" : " · learner consent required"}</option>
            ))}
          </select>
        </label>
        <label>
          Enabled tutor model
          <select onChange={(event) => setModel(event.target.value)} value={model}>
            <option value="">Choose a model</option>
            {data?.availableModels
              .filter((item) => item.provider === data.availableCredentials.find((credential) => credential.id === credentialId)?.provider)
              .map((item) => <option key={`${item.provider}:${item.model}`} value={item.model}>{item.model}</option>)}
          </select>
        </label>
        <label>
          Maximum tokens
          <input inputMode="numeric" max={10_000_000} min={100} onChange={(event) => setTokenBudget(event.target.value)} step={100} type="number" value={tokenBudget} />
        </label>
        <label>
          Maximum spend (INR)
          <input inputMode="decimal" max="100000" min="1" onChange={(event) => setRupeeBudget(event.target.value)} step="0.01" type="number" value={rupeeBudget} />
        </label>
        <label>
          Input price (INR per million tokens)
          <input inputMode="decimal" max="1000000" min="0.01" onChange={(event) => setInputRate(event.target.value)} step="0.01" type="number" value={inputRate} />
        </label>
        <label>
          Output price (INR per million tokens)
          <input inputMode="decimal" max="1000000" min="0.01" onChange={(event) => setOutputRate(event.target.value)} step="0.01" type="number" value={outputRate} />
        </label>
        <label>
          Expires at
          <input min={new Date().toISOString().slice(0, 16)} onChange={(event) => setExpiresAt(event.target.value)} type="datetime-local" value={expiresAt} />
        </label>
        <label>
          Current six-digit authenticator code
          <input autoComplete="one-time-code" inputMode="numeric" maxLength={6} onChange={(event) => setTotp(event.target.value.replace(/\D/g, ""))} pattern="[0-9]{6}" type="password" value={totp} />
        </label>
        <label>
          Recorded reason
          <textarea maxLength={500} minLength={8} onChange={(event) => setReason(event.target.value)} value={reason} />
        </label>
        {data?.learnerConsent?.adminFallbackAi === false && <p className={styles.inlineError}>This learner has not opted in to administrator-funded AI fallback. They must enable it in privacy settings first.</p>}
        <button className="button button-primary" disabled={busy || !credentialId || !model || data?.learnerConsent?.adminFallbackAi !== true || data.learnerConsent.providers[data.availableCredentials.find((credential) => credential.id === credentialId)?.provider ?? ""] !== true} onClick={() => void createGrant()} type="button">Grant capped fallback</button>
        <p className={styles.safeNotice}><ShieldAlert size={14} /> Pricing is frozen into this grant for hard local accounting. Creating or revoking access requires fresh MFA and a reason. Every action is audited and sent to the learner; secret key material is never returned here.</p>
      </div>
    </article>
  );
}
