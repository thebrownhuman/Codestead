/**
 * True when the value names a time zone the runtime can actually format with
 * (an IANA identifier such as "Asia/Kolkata"). A length check alone lets junk
 * through, which every later consumer then silently treats as UTC.
 *
 * Bare numeric offsets ("+05:30", "-0800") are rejected even though Intl
 * accepts them: Intl reads "+05:30" as UTC+05:30, but Postgres AT TIME ZONE
 * reads a bare offset with the POSIX sign (UTC-05:30). A stored offset would
 * make SQL day boundaries and JS day keys disagree by hours. IANA names all
 * start with a letter ("Etc/GMT+5" means the same thing to both).
 */
export function isIanaTimezone(value: string): boolean {
  const timezone = value.trim();
  if (!/^[A-Za-z]/.test(timezone)) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

/**
 * The trimmed zone when it is a valid IANA name, otherwise "UTC". For values
 * read back from storage, where an old or corrupt row must not crash a worker
 * or reach SQL as an offset with the wrong sign.
 */
export function resolveIanaTimezone(value: string | null | undefined): string {
  const timezone = value?.trim() ?? "";
  return isIanaTimezone(timezone) ? timezone : "UTC";
}
