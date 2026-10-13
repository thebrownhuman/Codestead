"use client";

import { Select } from "@/components/ui/select";

import Link from "next/link";
import { useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ModalDialog } from "@/components/ui/modal-dialog";
import { AI_PROVIDER_CATALOG } from "@/lib/ai/provider-catalog";
import { supportErrorCodeSchema, supportProviderSchema, type SupportRequestInput } from "@/lib/learning-requests/support-contract";
import styles from "./product-pages.module.css";
import { Field } from "../ui/field";

export function ContactAdminButton({ provider, errorCode, httpStatus }: { provider?: string; errorCode?: string | null; httpStatus?: number }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<"support-ai" | "support-other">("support-ai");
  const [chosenProvider, setChosenProvider] = useState(supportProviderSchema.safeParse(provider).success ? provider! : "");
  const [message, setMessage] = useState("");
  const [attach, setAttach] = useState(true);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const receipt = useRef<{ payload: string; id: string } | null>(null);
  const submitting = useRef(false);
  const safeCode = supportErrorCodeSchema.safeParse(errorCode);
  const safeStatus = Number.isInteger(httpStatus) && httpStatus! >= 100 && httpStatus! <= 599 ? httpStatus : undefined;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (submitting.current) return;
    const selected = supportProviderSchema.safeParse(chosenProvider);
    if (!message.trim() || message.trim().length > 1000 || (kind === "support-ai" && !selected.success)) { setError("Choose a provider and enter a message up to 1000 characters."); return; }
    const context = kind === "support-ai" && attach ? {
      provider: selected.data,
      ...(chosenProvider === provider && safeCode.success ? { errorCode: safeCode.data } : {}),
      ...(chosenProvider === provider && safeStatus ? { httpStatus: safeStatus } : {}),
    } : undefined;
    const payload = { kind, message: message.trim(), ...(kind === "support-ai" ? { provider: selected.data } : {}), ...(context ? { context } : {}) };
    const signature = JSON.stringify(payload);
    if (receipt.current?.payload !== signature) receipt.current = { payload: signature, id: crypto.randomUUID() };
    submitting.current = true;
    setBusy(true); setError(null);
    try {
      const response = await fetch("/api/learning-requests", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...payload, requestId: receipt.current.id } satisfies SupportRequestInput) });
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(body?.error ?? "The request could not be sent. Try again.");
      if (!body?.request?.id) throw new Error("The confirmation could not be read. Retry to recover your request.");
      receipt.current = null;
      setSent(true);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "The request could not be sent. Try again."); }
    finally { submitting.current = false; setBusy(false); }
  }

  return <>
    <button type="button" className="button button-secondary" onClick={() => { setOpen(true); setSent(false); setError(null); }}>Contact admin</button>
    {open && createPortal(<ModalDialog backdropClassName={styles.dialogBackdrop} dialogClassName={`${styles.dialog} card`} labelledBy={`${id}-title`} onClose={() => { if (!busy) setOpen(false); }}>
      <h2 id={`${id}-title`}>Contact admin</h2>
      {sent ? <div className={styles.formActions}><p role="status">Request sent. You can follow it in Requests.</p><Link href="/requests">View requests</Link><button type="button" className="button button-secondary" onClick={() => setOpen(false)}>Close</button></div> : <form className={styles.form} onSubmit={submit}>
        <p>Describe the problem. Do not include API keys, passwords, or prompt bodies. Limit: five requests per day, and one AI request per provider per day.</p>
        <Field id={`${id}-category`} label="Category"><Select id={`${id}-category`} value={kind} disabled={busy} onChange={(event) => setKind(event.target.value as typeof kind)}><option value="support-ai">AI model/key problem</option><option value="support-other">Other</option></Select></Field>
        {kind === "support-ai" && <Field id={`${id}-provider`} label="Provider" help="The provider selection identifies the issue and its daily limit."><Select id={`${id}-provider`} aria-describedby={`${id}-provider-help`} value={chosenProvider} disabled={busy} required onChange={(event) => setChosenProvider(event.target.value)}><option value="">Choose a provider</option>{AI_PROVIDER_CATALOG.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}<option value="custom_openai_compatible">Custom OpenAI compatible</option></Select></Field>}
        <Field id={`${id}-message`} label="Message"><textarea id={`${id}-message`} maxLength={1000} required disabled={busy} value={message} onChange={(event) => setMessage(event.target.value)} /></Field>
        {kind === "support-ai" && <label><input type="checkbox" checked={attach} disabled={busy} onChange={(event) => setAttach(event.target.checked)} /> Attach safe diagnostics (provider{chosenProvider === provider && safeCode.success ? `, ${safeCode.data}` : ""}{chosenProvider === provider && safeStatus ? `, HTTP ${safeStatus}` : ""})</label>}
        <div className={styles.formActions}>{error && <p className={styles.error} role="alert">{error}</p>}<button type="button" className="button button-secondary" disabled={busy} onClick={() => setOpen(false)}>Cancel</button><button type="submit" className="button button-primary" disabled={busy}>{busy ? "Sending…" : "Send request"}</button></div>
      </form>}
    </ModalDialog>, document.body)}
  </>;
}
