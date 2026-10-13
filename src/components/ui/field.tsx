import { cloneElement, type ReactElement, type ReactNode } from "react";
import styles from "./form.module.css";

export function Field({ id, label, help, error, children }: { id: string; label: string; help?: ReactNode; error?: string; children: ReactElement<{ id?: string; "aria-describedby"?: string; "aria-invalid"?: boolean }> }) {
  const describedBy = [...new Set([children.props["aria-describedby"], help ? `${id}-help` : null, error ? `${id}-error` : null].filter(Boolean))].join(" ") || undefined;
  return <div className={styles.field}>
    <label htmlFor={id}>{label}</label>
    {cloneElement(children, { id, "aria-describedby": describedBy, ...(error ? { "aria-invalid": true } : {}) })}
    {help && <small id={`${id}-help`}>{help}</small>}
    {error && <small className={styles.error} id={`${id}-error`} role="alert">{error}</small>}
  </div>;
}
