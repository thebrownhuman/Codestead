/**
 * True when the value names a time zone the runtime can actually format with
 * (an IANA identifier such as "Asia/Kolkata"). A length check alone lets junk
 * through, which every later consumer then silently treats as UTC.
 */
export function isIanaTimezone(value: string): boolean {
  const timezone = value.trim();
  if (!timezone) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}
