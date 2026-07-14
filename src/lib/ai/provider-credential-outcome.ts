import { and, eq, sql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { providerCredential } from "@/lib/db/schema";

import type { ProviderError } from "./types";

export type ProviderCredentialSnapshot = Readonly<{
  id: string;
  userId: string;
  keyVersion: number;
  updatedAtToken: string;
}>;

/** Exact microsecond-preserving token; JavaScript Date would lose PostgreSQL
 * precision and make a legitimate snapshot fail closed on every update. */
export const providerCredentialUpdatedAtToken = sql<string>`
  to_char(${providerCredential.updatedAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
`;

export type ProviderCredentialOutcome =
  | { readonly kind: "success" }
  | { readonly kind: "failure"; readonly code: ProviderError["code"] };

/**
 * Records provider health only if the exact active credential snapshot used
 * for the call still exists. A concurrent disable/replacement/test wins; this
 * function never re-enables a row or writes through a changed key version.
 */
export async function recordProviderCredentialOutcome(input: {
  readonly snapshot: ProviderCredentialSnapshot;
  readonly outcome: ProviderCredentialOutcome;
  readonly now?: Date;
}) {
  const now = input.now ?? new Date();
  if (!Number.isFinite(now.getTime())) throw new Error("Credential outcome timestamp is invalid.");
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(input.snapshot.updatedAtToken)) {
    throw new Error("Credential snapshot timestamp token is invalid.");
  }
  const failureStatus = input.outcome.kind === "failure"
    ? input.outcome.code === "AUTHENTICATION"
      ? "invalid" as const
      : input.outcome.code === "RATE_LIMIT"
        ? "rate_limited" as const
        : null
    : null;
  const updated = await db
    .update(providerCredential)
    .set(input.outcome.kind === "success"
      ? {
          lastUsedAt: now,
          failureCode: null,
          updatedAt: now,
        }
      : {
          ...(failureStatus ? { status: failureStatus } : {}),
          failureCode: input.outcome.code,
          updatedAt: now,
        })
    .where(and(
      eq(providerCredential.id, input.snapshot.id),
      eq(providerCredential.userId, input.snapshot.userId),
      eq(providerCredential.status, "active"),
      eq(providerCredential.keyVersion, input.snapshot.keyVersion),
      eq(providerCredentialUpdatedAtToken, input.snapshot.updatedAtToken),
    ))
    .returning({ id: providerCredential.id });
  return { applied: updated.length === 1 } as const;
}
