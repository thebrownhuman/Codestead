"use client";

import { AlertTriangle } from "lucide-react";
import { useCallback, useRef, useState } from "react";

import { ModalDialog } from "./modal-dialog";
import styles from "./confirm-dialog.module.css";

export type ConfirmOptions = {
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Tints the confirm button for a destructive action (e.g. discard, delete, publish). */
  destructive?: boolean;
};

type PendingConfirm = ConfirmOptions & { resolve: (value: boolean) => void };

const TITLE_ID = "confirm-dialog-title";
const DESCRIPTION_ID = "confirm-dialog-description";

/**
 * Replaces window.confirm with the app's accessible ModalDialog (styled,
 * Escape closes, focus trapped and restored). Render the returned
 * `confirmDialog` once near the component's JSX root, then `await
 * confirm({ title, description })` anywhere a window.confirm call used to
 * block synchronously — it resolves to true/false instead.
 */
export function useConfirm() {
  const [pending, setPending] = useState<PendingConfirm | null>(null);
  const pendingRef = useRef<PendingConfirm | null>(null);

  const confirm = useCallback((options: ConfirmOptions) => {
    return new Promise<boolean>((resolve) => {
      // An abandoned prior prompt resolves false rather than hanging forever.
      pendingRef.current?.resolve(false);
      const next = { ...options, resolve };
      pendingRef.current = next;
      setPending(next);
    });
  }, []);

  const settle = useCallback((value: boolean) => {
    pendingRef.current?.resolve(value);
    pendingRef.current = null;
    setPending(null);
  }, []);

  const confirmDialog = pending ? (
    <ModalDialog
      backdropClassName={styles.backdrop}
      describedBy={pending.description ? DESCRIPTION_ID : undefined}
      dialogClassName={styles.dialog}
      labelledBy={TITLE_ID}
      onClose={() => settle(false)}
      role="alertdialog"
    >
      <span aria-hidden="true" className={styles.icon}><AlertTriangle size={20} /></span>
      <div className={styles.copy}>
        <h2 id={TITLE_ID}>{pending.title}</h2>
        {pending.description && <p id={DESCRIPTION_ID}>{pending.description}</p>}
      </div>
      <div className={styles.actions}>
        <button className="button button-secondary" data-dialog-initial-focus onClick={() => settle(false)} type="button">
          {pending.cancelLabel ?? "Cancel"}
        </button>
        <button
          className={`button button-primary ${pending.destructive ? styles.confirmDanger : ""}`}
          onClick={() => settle(true)}
          type="button"
        >
          {pending.confirmLabel ?? "Confirm"}
        </button>
      </div>
    </ModalDialog>
  ) : null;

  return { confirm, confirmDialog };
}
