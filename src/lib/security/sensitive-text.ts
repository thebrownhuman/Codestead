import {
  CREDENTIAL_VALUE_PATTERNS,
  redactCredentialAssignments,
} from "./credential-patterns";

const REDACTION = "[REDACTED]";

/** High-confidence credential shapes. Keep this list shared by every boundary
 * that projects learner-controlled text into AI, mentor, export, or logs. */
const CREDENTIAL_OR_HIDDEN_EVIDENCE_PATTERNS = [
  ...CREDENTIAL_VALUE_PATTERNS.map(({ expression }) => expression),
  /\b(?:hiddenTests?|referenceAnswer|expectedStdout|gradingKey|__exam_blueprint_v1__)\b\s*[:=]\s*\S+/gi,
] as const;

const SENSITIVE_VALUE_PATTERNS = [
  ...CREDENTIAL_OR_HIDDEN_EVIDENCE_PATTERNS,
  /\b(?:\d{1,3}\.){3}\d{1,3}\b/g,
  /\b(?:[0-9a-f]{1,4}:){2,7}[0-9a-f]{0,4}\b/gi,
] as const;

/** Detects unsafe provider/public projection material without ever returning
 * or logging the candidate value. Ordinary IP-address teaching examples are
 * intentionally excluded from this narrower boundary. */
export function containsCredentialOrHiddenEvidence(value: string) {
  for (const pattern of CREDENTIAL_OR_HIDDEN_EVIDENCE_PATTERNS) {
    pattern.lastIndex = 0;
    const matched = pattern.test(value);
    pattern.lastIndex = 0;
    if (matched) return true;
  }
  return redactCredentialAssignments(value, REDACTION).redacted;
}

/** Detects an exact credential supplied to a provider, including common
 * transport encodings. It deliberately returns only a boolean and must never
 * be used to construct an error or log message. */
export function containsExposedCredentialVariant(
  value: string,
  credentials: readonly string[],
) {
  for (const credential of credentials) {
    if (credential.length < 8) continue;
    const bytes = Buffer.from(credential, "utf8");
    const variants = new Set([
      credential,
      encodeURIComponent(credential),
      bytes.toString("base64"),
      bytes.toString("base64url"),
    ]);
    for (const variant of variants) {
      if (variant.length >= 8 && value.includes(variant)) return true;
    }
  }
  return false;
}

export function redactSensitiveText(value: string, maximum: number) {
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 1_000_000) {
    throw new Error("Sensitive-text maximum is invalid.");
  }
  let text = value.replaceAll("\0", "");
  let redacted = false;
  for (const pattern of SENSITIVE_VALUE_PATTERNS) {
    text = text.replace(pattern, () => {
      redacted = true;
      return REDACTION;
    });
  }
  const assignmentProjection = redactCredentialAssignments(text, REDACTION);
  text = assignmentProjection.text;
  redacted ||= assignmentProjection.redacted;
  const truncated = text.length > maximum;
  const marker = "\n\u2026[truncated]";
  return {
    text: truncated
      ? `${text.slice(0, Math.max(0, maximum - marker.length))}${marker.slice(0, maximum)}`.slice(0, maximum)
      : text,
    redacted,
    truncated,
  } as const;
}
