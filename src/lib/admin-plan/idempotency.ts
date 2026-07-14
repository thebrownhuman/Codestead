import { createHash } from "node:crypto";

import type { AdminPlanOperation } from "./plan-revisions";

type CommonPlanRequest = Readonly<{
  actorUserId: string;
  learnerPublicId: string;
  enrollmentId: string;
  expectedRevision: number;
  reason: string;
  effectiveAt: string;
  policyVersion: string;
}>;

export type AdminPlanIdempotencyInput =
  | (CommonPlanRequest & Readonly<{
      kind: "revise";
      operations: readonly AdminPlanOperation[];
    }>)
  | (CommonPlanRequest & Readonly<{
      kind: "revert";
      targetRevision: number;
    }>);

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Admin-plan idempotency input contains a non-finite number.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  throw new TypeError("Admin-plan idempotency input must contain only JSON values.");
}

/**
 * Binds a caller-supplied request UUID to every field that can change the
 * resulting immutable plan revision. The UUID itself is intentionally not
 * included: it is the lookup key for this digest.
 */
export function adminPlanRequestHash(input: AdminPlanIdempotencyInput): string {
  return createHash("sha256").update(canonicalJson(input), "utf8").digest("hex");
}
