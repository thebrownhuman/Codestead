import { humanize, statusTone } from "./admin-utils";
import styles from "./admin.module.css";

export function StatusPill({ status }: { readonly status: string }) {
  return (
    <span className={`${styles.statusPill} ${styles[`tone_${statusTone(status)}`]}`}>
      <i aria-hidden="true" /> {humanize(status)}
    </span>
  );
}

export function EmptyState({
  title,
  detail,
}: {
  readonly title: string;
  readonly detail: string;
}) {
  return <div className={styles.emptyState}><strong>{title}</strong><p>{detail}</p></div>;
}

export function LoadingState({ label = "Loading operations data" }: { readonly label?: string }) {
  return (
    <div className={styles.loadingState} role="status">
      <span aria-hidden="true" /><div><strong>{label}</strong><small>Querying the protected administrator view…</small></div>
    </div>
  );
}

export function ErrorState({
  message,
  onRetry,
}: {
  readonly message: string;
  readonly onRetry?: () => void;
}) {
  return (
    <div className={styles.errorState} role="alert">
      <div><strong>Operations view unavailable</strong><p>{message}</p></div>
      {onRetry && <button className="button button-secondary" onClick={onRetry} type="button">Try again</button>}
    </div>
  );
}
