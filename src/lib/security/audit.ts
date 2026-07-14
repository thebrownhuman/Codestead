import { createHash } from "node:crypto";

const SECRET_KEY_PATTERN = /(api[_-]?key|secret|token|password|credential|authorization)/i;
const SECRET_VALUE_PATTERN = /\b(?:nvapi-|sk-|AIza|xox[baprs]-|gh[pousr]_)[A-Za-z0-9_\-]{8,}/;

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalize(object[key])}`)
    .join(",")}}`;
}

export function assertAuditMetadataSafe(metadata: Record<string, unknown>) {
  const visit = (value: unknown, key = "root") => {
    if (SECRET_KEY_PATTERN.test(key)) {
      throw new Error(`Secret-like audit metadata key is forbidden: ${key}`);
    }
    if (typeof value === "string" && SECRET_VALUE_PATTERN.test(value)) {
      throw new Error("Secret-like value is forbidden in audit metadata.");
    }
    if (Array.isArray(value)) value.forEach((entry) => visit(entry, key));
    else if (value && typeof value === "object") {
      for (const [childKey, child] of Object.entries(value)) visit(child, childKey);
    }
  };
  visit(metadata);
  return metadata;
}

export function hashAuditEvent(
  event: Record<string, unknown>,
  previousHash: string | null,
) {
  assertAuditMetadataSafe(
    (event.metadata as Record<string, unknown> | undefined) ?? {},
  );
  if (typeof event.reason === "string") {
    assertAuditMetadataSafe({ reason: event.reason });
  }
  return createHash("sha256")
    .update(previousHash ?? "GENESIS")
    .update("\n")
    .update(canonicalize(event))
    .digest("hex");
}

export function nextAuditTimestamp(
  previous: Date | null | undefined,
  nowMs = Date.now(),
) {
  return new Date(Math.max(nowMs, (previous?.getTime() ?? -1) + 1));
}
