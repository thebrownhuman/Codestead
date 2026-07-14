export function hasPostgresErrorCode(error: unknown, code: string): boolean {
  const seen = new Set<object>();
  let current = error;
  while (typeof current === "object" && current !== null && !seen.has(current)) {
    seen.add(current);
    const candidate = current as { readonly code?: unknown; readonly cause?: unknown };
    if (candidate.code === code) return true;
    current = candidate.cause;
  }
  return false;
}
