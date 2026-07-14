export type CredentialPattern = Readonly<{
  detector: string;
  expression: RegExp;
  /** A stricter repository form; null means runtime redaction only. */
  scanExpression?: RegExp | null;
}>;

/** High-confidence credential shapes shared by repository and text-boundary scans. */
export const CREDENTIAL_VALUE_PATTERNS: readonly CredentialPattern[] = [
  {
    detector: "21st-api-key",
    expression: /\b21st_sk_[A-Za-z0-9]{16,}\b/g,
    scanExpression: /\b21st_sk_[A-Za-z0-9]{32,}\b/g,
  },
  {
    detector: "nvidia-api-key",
    expression: /\bnvapi-[A-Za-z0-9_-]{16,}\b/g,
    scanExpression: /\bnvapi-[A-Za-z0-9_-]{32,}\b/g,
  },
  {
    detector: "sk-api-key",
    expression: /\bsk-(?:proj-|ant-|or-v1-)?[A-Za-z0-9_-]{16,}\b/g,
    scanExpression: /\bsk-(?:proj-|ant-|or-v1-)?[A-Za-z0-9_-]{32,}\b/g,
  },
  {
    detector: "stripe-live-key",
    expression: /\b(?:rk|sk)_live_[A-Za-z0-9]{16,}\b/g,
    scanExpression: /\b(?:rk|sk)_live_[A-Za-z0-9]{24,}\b/g,
  },
  {
    detector: "google-api-key",
    expression: /\bAIza[A-Za-z0-9_-]{20,}\b/g,
    scanExpression: /\bAIza[A-Za-z0-9_-]{32,}\b/g,
  },
  {
    detector: "github-token",
    expression: /\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_-]{16,}\b/g,
    scanExpression: /\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_-]{32,}\b/g,
  },
  {
    detector: "gitlab-token",
    expression: /\bglpat-[A-Za-z0-9_-]{16,}\b/g,
    scanExpression: /\bglpat-[A-Za-z0-9_-]{20,}\b/g,
  },
  {
    detector: "hugging-face-token",
    expression: /\bhf_[A-Za-z0-9]{16,}\b/g,
    scanExpression: /\bhf_[A-Za-z0-9]{24,}\b/g,
  },
  {
    detector: "npm-token",
    expression: /\bnpm_[A-Za-z0-9]{20,}\b/g,
    scanExpression: /\bnpm_[A-Za-z0-9]{32,}\b/g,
  },
  {
    detector: "aws-access-key",
    expression: /\b(?:AKIA|ASIA|AIDA|AROA|AIPA|ANPA|ANVA|ASCA)[A-Z0-9]{16}\b/g,
    scanExpression: /\b(?:AKIA|ASIA|AIDA|AROA|AIPA|ANPA|ANVA|ASCA)[A-Z0-9]{16}\b/g,
  },
  {
    detector: "slack-token",
    expression: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
    scanExpression: /\bxox[baprs]-[A-Za-z0-9-]{24,}\b/g,
  },
  {
    detector: "slack-app-token",
    expression: /\bxapp-[A-Za-z0-9-]{20,}\b/g,
    scanExpression: /\bxapp-[A-Za-z0-9-]{32,}\b/g,
  },
  {
    detector: "slack-webhook",
    expression: /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9_-]{6,}\/[A-Za-z0-9_-]{6,}\/[A-Za-z0-9_-]{12,}/gi,
    scanExpression: /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9_-]{6,}\/[A-Za-z0-9_-]{6,}\/[A-Za-z0-9_-]{24,}/gi,
  },
  {
    detector: "jwt",
    expression: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
    scanExpression: /\beyJ[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/g,
  },
  {
    detector: "authorization-value",
    expression: /\b(?:Bearer|Basic)\s+[A-Za-z0-9+/=._-]{12,}\b/gi,
    scanExpression: null,
  },
  {
    detector: "private-key",
    expression: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    scanExpression: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
  },
] as const;

const CREDENTIAL_LABEL_SOURCE = String.raw`(?:aws[\s_-]?secret[\s_-]?access[\s_-]?key|(?:[a-z0-9]+[\s_-]+)*(?:api[\s_-]?key|secret|token|password|passphrase))`;
const CREDENTIAL_ASSIGNMENT_SOURCE = String.raw`(?<![A-Za-z0-9_])(?<label>${CREDENTIAL_LABEL_SOURCE})(?![A-Za-z0-9_])["']?\s*[:=]\s*(?:"(?<doubleQuoted>[^"\r\n]{1,512})"|'(?<singleQuoted>[^'\r\n]{1,512})'|\`(?<backtickQuoted>[^\`\r\n]{1,512})\`|(?<bare>[^\s,;#}\]"'\`\r\n]{1,512}))`;

const PLACEHOLDER_WORDS = new Set([
  "changeme",
  "dummy",
  "example",
  "fake",
  "fixture",
  "integration",
  "local",
  "masked",
  "never",
  "placeholder",
  "redacted",
  "replace",
  "replacement",
  "replaceme",
  "sample",
  "sentinel",
  "runner",
  "test",
  "testing",
  "todo",
]);

function assignmentExpression() {
  return new RegExp(CREDENTIAL_ASSIGNMENT_SOURCE, "gim");
}

function normalizedLabel(label: string) {
  return label.toLowerCase().replace(/[\s-]+/g, "_");
}

function isPasswordLabel(label: string) {
  const normalized = normalizedLabel(label);
  return normalized.endsWith("password") || normalized.endsWith("passphrase");
}

function isReferenceOrPlaceholder(rawValue: string) {
  const value = rawValue.trim();
  const lower = value.toLowerCase();
  if (
    value.length === 0 ||
    lower === "null" ||
    lower === "none" ||
    lower === "undefined" ||
    lower === "password" ||
    lower === "secret" ||
    lower === "token" ||
    lower.startsWith("<") ||
    lower.startsWith("${") ||
    lower.startsWith("$(") ||
    lower.startsWith("process.env") ||
    lower.startsWith("import.meta.env") ||
    lower.startsWith("deno.env") ||
    lower.startsWith("os.getenv") ||
    lower.startsWith("env(") ||
    lower.startsWith("getenv(") ||
    lower.startsWith("get_config(") ||
    lower.startsWith("config(") ||
    lower.startsWith("secret(") ||
    lower.startsWith("secrets.") ||
    lower.startsWith("vault.") ||
    lower.startsWith("keyring.") ||
    lower.startsWith("sha1:") ||
    lower.startsWith("sha256:") ||
    lower.startsWith("sha384:") ||
    lower.startsWith("sha512:") ||
    lower.startsWith("sha1-") ||
    lower.startsWith("sha256-") ||
    lower.startsWith("sha384-") ||
    lower.startsWith("sha512-")
  ) {
    return true;
  }

  if (/[()]/.test(value) || value.includes("?.") || value.includes("=>")) {
    return true;
  }

  const compact = lower.replace(/[^a-z0-9]+/g, "");
  if (
    compact.startsWith("your") ||
    compact.startsWith("notareal") ||
    compact.includes("abcdefghijklmnopqrstuvwxyz") ||
    compact.includes("qwertyuiop") ||
    compact.includes("0123456789") ||
    /^(.)\1{7,}$/.test(compact) ||
    /^(?:[0-9a-f]{32}|[0-9a-f]{40}|[0-9a-f]{64}|[0-9a-f]{96}|[0-9a-f]{128})$/i.test(compact)
  ) {
    return true;
  }

  if (
    /^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)+$/.test(value) ||
    (/^[a-z][a-z_]+$/i.test(value) && /(?:api_?key|secret|token|password)/i.test(value))
  ) {
    return true;
  }

  const words = lower.split(/[^a-z0-9]+/).filter(Boolean);
  return words.some((word) => PLACEHOLDER_WORDS.has(word));
}

function shannonEntropy(value: string) {
  const frequencies = new Map<string, number>();
  for (const character of value) {
    frequencies.set(character, (frequencies.get(character) ?? 0) + 1);
  }
  let entropy = 0;
  for (const count of frequencies.values()) {
    const probability = count / value.length;
    entropy -= probability * Math.log2(probability);
  }
  return entropy;
}

function characterClassCount(value: string) {
  return [/[a-z]/.test(value), /[A-Z]/.test(value), /\d/.test(value), /[^A-Za-z0-9]/.test(value)].filter(
    Boolean,
  ).length;
}

function isCredentialConfigurationPath(filePath?: string) {
  if (!filePath) return false;
  const normalized = filePath.toLowerCase().replaceAll("\\", "/");
  const name = normalized.split("/").at(-1) ?? normalized;
  const extension = name.includes(".") ? (name.split(".").at(-1) ?? "") : "";
  const configurationExtension = new Set([
    "conf",
    "config",
    "env",
    "ini",
    "json",
    "properties",
    "toml",
    "yaml",
    "yml",
  ]).has(extension);
  return (
    name === ".env" ||
    name.startsWith(".env.") ||
    configurationExtension ||
    (extension === "" && /(?:credential|secret|config|settings|properties)/.test(name))
  );
}

function isLikelyCredentialAssignment(
  label: string,
  rawValue: string,
  mode: "repository" | "runtime",
  filePath?: string,
) {
  const value = rawValue.trim();
  if (isReferenceOrPlaceholder(value)) return false;

  if (mode === "runtime" && isPasswordLabel(label)) {
    return value.length >= 6;
  }

  // Runtime evidence is already attached to an explicit credential label.
  // Prefer a conservative redaction false-positive over exposing a long,
  // single-alphabet token (a valid shape used by several internal systems).
  if (mode === "runtime" && value.length >= 16) {
    return true;
  }

  if (/\s/.test(value) || /[\u0000-\u001f\u007f]/.test(value)) return false;
  const configurationFile = isCredentialConfigurationPath(filePath);
  const minimumLength = mode === "runtime" ? 16 : configurationFile ? 20 : 24;
  const minimumClasses = mode === "runtime" || configurationFile ? 2 : 3;
  const minimumEntropy = mode === "runtime" ? 2.8 : configurationFile ? 3.25 : 3.6;
  return (
    value.length >= minimumLength &&
    characterClassCount(value) >= minimumClasses &&
    shannonEntropy(value) >= minimumEntropy
  );
}

function assignmentDetector(label: string) {
  const normalized = normalizedLabel(label);
  if (normalized === "aws_secret_access_key") return "aws-secret-access-key-assignment";
  if (isPasswordLabel(label)) return "password-assignment";
  return "credential-assignment";
}

/** Returns detector names only; the candidate credential is deliberately omitted. */
export function findCredentialAssignmentDetectors(line: string, filePath?: string) {
  const detectors = new Set<string>();
  for (const match of line.matchAll(assignmentExpression())) {
    const groups = match.groups;
    const label = groups?.label;
    const value =
      groups?.doubleQuoted ?? groups?.singleQuoted ?? groups?.backtickQuoted ?? groups?.bare;
    if (label && value && isLikelyCredentialAssignment(label, value, "repository", filePath)) {
      detectors.add(assignmentDetector(label));
    }
  }
  return [...detectors];
}

/** Redacts literal credential assignments while preserving their labels and quoting. */
export function redactCredentialAssignments(text: string, replacement: string) {
  let redacted = false;
  const value = text.replace(assignmentExpression(), (full, ...arguments_: unknown[]) => {
    const groups = arguments_.at(-1) as Record<string, string | undefined> | undefined;
    const label = groups?.label;
    const candidate =
      groups?.doubleQuoted ?? groups?.singleQuoted ?? groups?.backtickQuoted ?? groups?.bare;
    if (!label || !candidate || !isLikelyCredentialAssignment(label, candidate, "runtime")) {
      return full;
    }
    const offset = full.lastIndexOf(candidate);
    if (offset < 0) return full;
    redacted = true;
    return `${full.slice(0, offset)}${replacement}${full.slice(offset + candidate.length)}`;
  });
  return { text: value, redacted } as const;
}
