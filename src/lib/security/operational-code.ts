function readErrorField(
  candidate: unknown,
  field: "cause" | "code" | "name",
): unknown {
  if (
    (typeof candidate !== "object" || candidate === null)
    && typeof candidate !== "function"
  ) {
    return undefined;
  }
  try {
    return Reflect.get(candidate, field);
  } catch {
    return undefined;
  }
}

/**
 * Returns only an exact member of a caller-owned finite code set.
 *
 * Error fields are untrusted: a UUID, token, recipient, provider identifier,
 * or MIME fragment can be shaped like a syntactically valid "code". Callers
 * therefore own the semantic allowlist and provide their own fixed fallback.
 */
export function allowlistedOperationalErrorCode<const Code extends string>(
  error: unknown,
  allowedCodes: ReadonlySet<Code>,
): Code | null {
  const cause = readErrorField(error, "cause");
  const candidates = cause === error ? [error] : [error, cause];
  for (const candidate of candidates) {
    for (const field of ["name", "code"] as const) {
      const value = readErrorField(candidate, field);
      if (
        typeof value === "string"
        && allowedCodes.has(value as Code)
      ) {
        return value as Code;
      }
    }
  }
  return null;
}
