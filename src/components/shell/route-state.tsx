import Link from "next/link";
import { CircleAlert, Home, LoaderCircle, Signpost } from "lucide-react";

import styles from "./route-state.module.css";

type RouteStateVariant = "loading" | "error" | "not-found";

const icons = {
  loading: LoaderCircle,
  error: CircleAlert,
  "not-found": Signpost,
} as const;

export function RouteState({
  variant,
  eyebrow,
  title,
  description,
  detail,
  action,
  standalone = false,
}: {
  variant: RouteStateVariant;
  eyebrow: string;
  title: string;
  description: string;
  detail?: string;
  action?: React.ReactNode;
  standalone?: boolean;
}) {
  const Icon = icons[variant];
  const isLoading = variant === "loading";

  return (
    <section
      aria-busy={isLoading || undefined}
      aria-labelledby="route-state-title"
      aria-live={isLoading ? "polite" : undefined}
      className={`${styles.frame} ${standalone ? styles.standalone : ""}`}
      data-route-state={variant}
      role={variant === "error" ? "alert" : variant === "not-found" ? "region" : "status"}
    >
      <div className={`${styles.card} card`}>
        <div aria-hidden="true" className={styles.signalRail}>
          <span /><span /><span /><span />
        </div>
        <span aria-hidden="true" className={`${styles.icon} ${styles[variant]}`}>
          <Icon className={isLoading ? styles.spinner : undefined} size={27} strokeWidth={2.1} />
        </span>
        <div className={styles.copy}>
          <span className={styles.eyebrow}>{eyebrow}</span>
          <h1 id="route-state-title">{title}</h1>
          <p>{description}</p>
          {detail && <small>{detail}</small>}
        </div>
        {isLoading && (
          <div aria-hidden="true" className={styles.skeleton}>
            <span /><span /><span />
          </div>
        )}
        {action && <div className={styles.actions}>{action}</div>}
      </div>
    </section>
  );
}

export function ReturnHomeLink({ label = "Return to learning home" }: { label?: string }) {
  return (
    <Link className="button button-secondary" href="/learn">
      <Home aria-hidden="true" size={17} />
      {label}
    </Link>
  );
}
