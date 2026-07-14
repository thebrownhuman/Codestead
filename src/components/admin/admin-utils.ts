export type StatusTone = "good" | "warning" | "danger" | "neutral" | "info";

const GOOD_STATUSES = new Set([
  "active",
  "approved",
  "complete",
  "completed",
  "graded",
  "mastered",
  "proficient",
  "sent",
  "succeeded",
  "verified",
]);
const WARNING_STATUSES = new Set([
  "beta",
  "draft",
  "in_progress",
  "leased",
  "learning",
  "needs_review",
  "pending",
  "pending_validation",
  "practicing",
  "queued",
  "rate_limited",
  "running",
  "sending",
  "submitted",
  "under_review",
]);
const DANGER_STATUSES = new Set([
  "cancelled",
  "disabled",
  "expired",
  "failed",
  "invalid",
  "invalidated",
  "open",
  "rejected",
  "revoked",
  "suspended",
  "timed_out",
]);

export function statusTone(status: string): StatusTone {
  const normalized = status.toLocaleLowerCase("en-US");
  if (GOOD_STATUSES.has(normalized)) return "good";
  if (WARNING_STATUSES.has(normalized)) return "warning";
  if (DANGER_STATUSES.has(normalized)) return "danger";
  if (normalized === "unseen" || normalized === "retired") return "neutral";
  return "info";
}

export function humanize(value: string): string {
  return value.replaceAll("_", " ").replaceAll("-", " ");
}

export function percentage(numerator: number, denominator: number): number {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return 0;
  return Math.round(Math.max(0, Math.min(100, (numerator / denominator) * 100)) * 10) / 10;
}

export function formatPercent(value: number): string {
  const finite = Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0;
  return `${Number.isInteger(finite) ? finite : finite.toFixed(1)}%`;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"] as const;
  const exponent = Math.max(
    0,
    Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1),
  );
  const value = bytes / 1024 ** exponent;
  const digits = value >= 10 || exponent === 0 ? 0 : 1;
  return `${value.toFixed(digits)} ${units[exponent]}`;
}

export function formatMinutes(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes <= 0) return "0 min";
  if (minutes < 60) return `${Math.round(minutes)} min`;
  const hours = Math.floor(minutes / 60);
  const remainder = Math.round(minutes % 60);
  return remainder ? `${hours}h ${remainder}m` : `${hours}h`;
}

export function safeLastFour(value: string): string {
  return /^[A-Za-z0-9_-]{4}$/.test(value) ? value : "????";
}

export function credentialTail(value: string): string {
  return `•••• ${safeLastFour(value)}`;
}

export function safeOperationalCode(value: string | null | undefined): string | null {
  if (!value) return null;
  return /^[A-Za-z0-9_.:-]{1,64}$/.test(value) ? value : "REDACTED";
}

export function formatDateTime(value: string | null): string {
  if (!value) return "Not recorded";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Invalid date";
  return new Intl.DateTimeFormat("en-IN", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

export function formatRelativeTime(value: string | null, now = Date.now()): string {
  if (!value) return "never";
  const timestamp = new Date(value).getTime();
  if (Number.isNaN(timestamp)) return "unknown";
  const seconds = Math.round((timestamp - now) / 1_000);
  const absolute = Math.abs(seconds);
  const formatter = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  if (absolute < 60) return formatter.format(seconds, "second");
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return formatter.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return formatter.format(hours, "hour");
  const days = Math.round(hours / 24);
  return formatter.format(days, "day");
}

export class AdminApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "AdminApiError";
    this.status = status;
  }
}

export async function requestAdminJson<T>(
  input: string,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(input, {
    ...init,
    cache: "no-store",
    headers: {
      Accept: "application/json",
      ...init?.headers,
    },
  });
  const body = (await response.json().catch(() => null)) as { error?: string } | null;
  if (!response.ok) {
    throw new AdminApiError(body?.error ?? "The administrator service did not respond.", response.status);
  }
  return body as T;
}
