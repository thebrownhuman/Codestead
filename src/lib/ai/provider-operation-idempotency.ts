import { createHash, randomUUID } from "node:crypto";
import { and, eq, gt, lte, sql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { providerOperationReceipt, user } from "@/lib/db/schema";
import { lockUserAuthority } from "@/lib/security/user-authority-lock";

export type ProviderOperationAction =
  | "tutor.post"
  | "credential.test"
  | "credential.replace";

export type ProviderOperationSafeResponse = Readonly<{
  status: number;
  body: Record<string, unknown>;
}>;

type ReceiptKey = Readonly<{
  ownerUserId: string;
  action: ProviderOperationAction;
  requestId: string;
  inputHash: string;
}>;

type StoredReceipt = Readonly<{
  inputHash: string;
  status: "processing" | "completed";
  responseStatus: number | null;
  responseBody: Record<string, unknown> | null;
  leaseId?: string;
  leaseVersion?: number;
  leaseExpiresAt?: Date;
}>;

export type ProviderOperationLeaseFence = Readonly<{
  leaseId: string;
  leaseVersion: number;
}>;

type AcquireResult =
  | Readonly<{ kind: "claimed"; lease: ProviderOperationLeaseFence }>
  | Readonly<{ kind: "processing" }>
  | Readonly<{ kind: "completed"; response: ProviderOperationSafeResponse }>;

export interface ProviderOperationReceiptStore {
  acquire(input: ReceiptKey): Promise<AcquireResult>;
  read(input: ReceiptKey): Promise<StoredReceipt | null>;
  complete(
    input: ReceiptKey,
    response: ProviderOperationSafeResponse,
    lease: ProviderOperationLeaseFence,
  ): Promise<void>;
  recoverExpired?(input: ReceiptKey, now?: Date): Promise<AcquireResult>;
}

export class ProviderOperationIdempotencyError extends Error {
  constructor(
    readonly code:
      | "IDEMPOTENCY_KEY_REUSED"
      | "IDEMPOTENCY_WAIT_TIMEOUT"
      | "IDEMPOTENCY_RECEIPT_UNAVAILABLE",
    message: string,
  ) {
    super(message);
    this.name = "ProviderOperationIdempotencyError";
  }
}

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Canonical provider-operation input contains a non-finite number.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  throw new TypeError("Canonical provider-operation input must contain only JSON values.");
}

/**
 * Hashes a canonical, key-sorted JSON projection. Callers must pass only the
 * fields that semantically define the operation and must sanitize learner text
 * before calling this function.
 */
export function canonicalProviderOperationHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function validateKey(input: ReceiptKey) {
  if (!input.ownerUserId || !/^[0-9a-f-]{36}$/i.test(input.requestId) || !/^[0-9a-f]{64}$/.test(input.inputHash)) {
    throw new ProviderOperationIdempotencyError(
      "IDEMPOTENCY_RECEIPT_UNAVAILABLE",
      "The provider-operation idempotency request is invalid.",
    );
  }
}

function completedResponse(receipt: StoredReceipt): ProviderOperationSafeResponse {
  if (receipt.status !== "completed" || receipt.responseStatus === null || receipt.responseBody === null) {
    throw new ProviderOperationIdempotencyError(
      "IDEMPOTENCY_RECEIPT_UNAVAILABLE",
      "The provider-operation receipt is incomplete.",
    );
  }
  return { status: receipt.responseStatus, body: receipt.responseBody };
}

function assertMatchingHash(receipt: StoredReceipt, inputHash: string) {
  if (receipt.inputHash !== inputHash) {
    throw new ProviderOperationIdempotencyError(
      "IDEMPOTENCY_KEY_REUSED",
      "This request ID was already used for different provider-operation input.",
    );
  }
}

function normalizeSafeResponse(response: ProviderOperationSafeResponse): ProviderOperationSafeResponse {
  if (!Number.isInteger(response.status) || response.status < 100 || response.status > 599) {
    throw new ProviderOperationIdempotencyError(
      "IDEMPOTENCY_RECEIPT_UNAVAILABLE",
      "The provider operation returned an invalid response status.",
    );
  }
  let encoded: string;
  try {
    encoded = JSON.stringify(response.body);
  } catch {
    throw new ProviderOperationIdempotencyError(
      "IDEMPOTENCY_RECEIPT_UNAVAILABLE",
      "The provider operation returned a response that cannot be stored safely.",
    );
  }
  if (!encoded || response.body === null || Array.isArray(response.body) || typeof response.body !== "object") {
    throw new ProviderOperationIdempotencyError(
      "IDEMPOTENCY_RECEIPT_UNAVAILABLE",
      "The provider operation must return a JSON object.",
    );
  }
  if (Buffer.byteLength(encoded, "utf8") > 262_144) {
    throw new ProviderOperationIdempotencyError(
      "IDEMPOTENCY_RECEIPT_UNAVAILABLE",
      "The provider operation response exceeds the durable replay limit.",
    );
  }
  return { status: response.status, body: JSON.parse(encoded) as Record<string, unknown> };
}

export class PostgresProviderOperationReceiptStore implements ProviderOperationReceiptStore {
  async acquire(input: ReceiptKey): Promise<AcquireResult> {
    validateKey(input);
    return db.transaction(async (tx) => {
      await lockUserAuthority(tx, input.ownerUserId);
      const [owner] = await tx
        .select({ status: user.status })
        .from(user)
        .where(eq(user.id, input.ownerUserId))
        .limit(1);
      if (owner?.status !== "active") {
        throw new ProviderOperationIdempotencyError(
          "IDEMPOTENCY_RECEIPT_UNAVAILABLE",
          "The provider-operation owner is unavailable.",
        );
      }
      const lease = { leaseId: randomUUID(), leaseVersion: 1 } as const;
      const leaseExpiresAt = new Date(Date.now() + 5 * 60_000);
      const [inserted] = await tx
        .insert(providerOperationReceipt)
        .values({
          ownerUserId: input.ownerUserId,
          action: input.action,
          requestId: input.requestId,
          inputHash: input.inputHash,
          leaseId: lease.leaseId,
          leaseVersion: lease.leaseVersion,
          leaseExpiresAt,
        })
        .onConflictDoNothing({
          target: [
            providerOperationReceipt.ownerUserId,
            providerOperationReceipt.action,
            providerOperationReceipt.requestId,
          ],
        })
        .returning({ id: providerOperationReceipt.id });
      if (inserted) return { kind: "claimed", lease };

      const receipt = await this.readWith(tx, input);
      if (!receipt) {
        throw new ProviderOperationIdempotencyError(
          "IDEMPOTENCY_RECEIPT_UNAVAILABLE",
          "The provider-operation receipt could not be resolved.",
        );
      }
      assertMatchingHash(receipt, input.inputHash);
      return receipt.status === "completed"
        ? { kind: "completed", response: completedResponse(receipt) }
        : { kind: "processing" };
    });
  }

  async read(input: ReceiptKey): Promise<StoredReceipt | null> {
    validateKey(input);
    return this.readWith(db, input);
  }

  private async readWith(
    database: Pick<typeof db, "select">,
    input: ReceiptKey,
  ): Promise<StoredReceipt | null> {
    const [receipt] = await database
      .select({
        inputHash: providerOperationReceipt.inputHash,
        status: providerOperationReceipt.status,
        responseStatus: providerOperationReceipt.responseStatus,
        responseBody: providerOperationReceipt.responseBody,
        leaseId: providerOperationReceipt.leaseId,
        leaseVersion: providerOperationReceipt.leaseVersion,
        leaseExpiresAt: providerOperationReceipt.leaseExpiresAt,
      })
      .from(providerOperationReceipt)
      .where(and(
        eq(providerOperationReceipt.ownerUserId, input.ownerUserId),
        eq(providerOperationReceipt.action, input.action),
        eq(providerOperationReceipt.requestId, input.requestId),
      ))
      .limit(1);
    if (!receipt) return null;
    if (receipt.status !== "processing" && receipt.status !== "completed") {
      throw new ProviderOperationIdempotencyError(
        "IDEMPOTENCY_RECEIPT_UNAVAILABLE",
        "The provider-operation receipt has an invalid state.",
      );
    }
    return { ...receipt, status: receipt.status };
  }

  async complete(
    input: ReceiptKey,
    response: ProviderOperationSafeResponse,
    lease: ProviderOperationLeaseFence,
  ): Promise<void> {
    validateKey(input);
    if (!/^[0-9a-f-]{36}$/i.test(lease.leaseId) || !Number.isSafeInteger(lease.leaseVersion) || lease.leaseVersion < 1) {
      throw new ProviderOperationIdempotencyError(
        "IDEMPOTENCY_RECEIPT_UNAVAILABLE",
        "The provider-operation lease fence is invalid.",
      );
    }
    const normalized = normalizeSafeResponse(response);
    const completedAt = new Date();
    const [updated] = await db
      .update(providerOperationReceipt)
      .set({
        status: "completed",
        responseStatus: normalized.status,
        responseBody: normalized.body,
        completedAt,
        updatedAt: completedAt,
      })
      .where(and(
        eq(providerOperationReceipt.ownerUserId, input.ownerUserId),
        eq(providerOperationReceipt.action, input.action),
        eq(providerOperationReceipt.requestId, input.requestId),
        eq(providerOperationReceipt.inputHash, input.inputHash),
        eq(providerOperationReceipt.status, "processing"),
        eq(providerOperationReceipt.leaseId, lease.leaseId),
        eq(providerOperationReceipt.leaseVersion, lease.leaseVersion),
        gt(providerOperationReceipt.leaseExpiresAt, completedAt),
      ))
      .returning({ id: providerOperationReceipt.id });
    if (updated) return;

    const receipt = await this.read(input);
    if (!receipt) {
      throw new ProviderOperationIdempotencyError(
        "IDEMPOTENCY_RECEIPT_UNAVAILABLE",
        "The provider-operation receipt disappeared before completion.",
      );
    }
    assertMatchingHash(receipt, input.inputHash);
    const stored = completedResponse(receipt);
    if (stored.status !== normalized.status || canonicalJson(stored.body) !== canonicalJson(normalized.body)) {
      throw new ProviderOperationIdempotencyError(
        "IDEMPOTENCY_RECEIPT_UNAVAILABLE",
        "The provider-operation receipt was completed with a different response.",
      );
    }
  }

  async recoverExpired(input: ReceiptKey, now = new Date()): Promise<AcquireResult> {
    validateKey(input);
    const safeResponse = indeterminateResponse(input.action);
    return db.transaction(async (tx) => {
      const [receipt] = await tx
        .select({
          inputHash: providerOperationReceipt.inputHash,
          status: providerOperationReceipt.status,
          responseStatus: providerOperationReceipt.responseStatus,
          responseBody: providerOperationReceipt.responseBody,
          leaseId: providerOperationReceipt.leaseId,
          leaseVersion: providerOperationReceipt.leaseVersion,
          leaseExpiresAt: providerOperationReceipt.leaseExpiresAt,
        })
        .from(providerOperationReceipt)
        .where(and(
          eq(providerOperationReceipt.ownerUserId, input.ownerUserId),
          eq(providerOperationReceipt.action, input.action),
          eq(providerOperationReceipt.requestId, input.requestId),
        ))
        .limit(1)
        .for("update");
      if (!receipt) {
        throw new ProviderOperationIdempotencyError(
          "IDEMPOTENCY_RECEIPT_UNAVAILABLE",
          "The provider-operation receipt disappeared during lease recovery.",
        );
      }
      assertMatchingHash(receipt as StoredReceipt, input.inputHash);
      if (receipt.status === "completed") {
        return { kind: "completed", response: completedResponse(receipt as StoredReceipt) };
      }
      if (receipt.status !== "processing") {
        throw new ProviderOperationIdempotencyError(
          "IDEMPOTENCY_RECEIPT_UNAVAILABLE",
          "The provider-operation receipt has an invalid state.",
        );
      }
      if (!receipt.leaseId || !receipt.leaseVersion || !receipt.leaseExpiresAt) {
        throw new ProviderOperationIdempotencyError(
          "IDEMPOTENCY_RECEIPT_UNAVAILABLE",
          "The provider-operation receipt lease is incomplete.",
        );
      }
      if (receipt.leaseExpiresAt > now) return { kind: "processing" };
      const normalized = normalizeSafeResponse(safeResponse);
      const [recovered] = await tx
        .update(providerOperationReceipt)
        .set({
          status: "completed",
          responseStatus: normalized.status,
          responseBody: normalized.body,
          completedAt: now,
          leaseId: randomUUID(),
          leaseVersion: sql`${providerOperationReceipt.leaseVersion} + 1`,
          leaseExpiresAt: now,
          updatedAt: now,
        })
        .where(and(
          eq(providerOperationReceipt.ownerUserId, input.ownerUserId),
          eq(providerOperationReceipt.action, input.action),
          eq(providerOperationReceipt.requestId, input.requestId),
          eq(providerOperationReceipt.inputHash, input.inputHash),
          eq(providerOperationReceipt.status, "processing"),
          eq(providerOperationReceipt.leaseId, receipt.leaseId),
          eq(providerOperationReceipt.leaseVersion, receipt.leaseVersion),
          lte(providerOperationReceipt.leaseExpiresAt, now),
        ))
        .returning({ id: providerOperationReceipt.id });
      if (!recovered) {
        throw new ProviderOperationIdempotencyError(
          "IDEMPOTENCY_RECEIPT_UNAVAILABLE",
          "The provider-operation lease could not be fenced safely.",
        );
      }
      return { kind: "completed", response: normalized };
    });
  }
}

function indeterminateResponse(action: ProviderOperationAction): ProviderOperationSafeResponse {
  return action === "tutor.post"
    ? {
        status: 503,
        body: {
          error: "Codestead is unavailable right now. Your authored lesson and deterministic practice are still available. You can keep learning while AI recovers.",
          code: "PROVIDER_OPERATION_INDETERMINATE",
          degraded: true,
        },
      }
    : {
        status: 503,
        body: {
          error: "The earlier provider operation has an unknown outcome and was not executed again.",
          code: "PROVIDER_OPERATION_INDETERMINATE",
          retryable: false,
        },
      };
}

const defaultStore = new PostgresProviderOperationReceiptStore();

export async function executeProviderOperationIdempotently(input: ReceiptKey & {
  execute: () => Promise<ProviderOperationSafeResponse>;
  store?: ProviderOperationReceiptStore;
  waitTimeoutMs?: number;
  pollIntervalMs?: number;
  delay?: (milliseconds: number) => Promise<void>;
}): Promise<ProviderOperationSafeResponse & { replayed: boolean }> {
  validateKey(input);
  const store = input.store ?? defaultStore;
  const acquired = await store.acquire(input);
  if (acquired.kind === "completed") return { ...acquired.response, replayed: true };

  if (acquired.kind === "claimed") {
    let rawResponse: ProviderOperationSafeResponse;
    try {
      rawResponse = await input.execute();
    } catch {
      // The callback may have failed before dispatch or after an external
      // provider accepted a request. Never re-run that ambiguous operation
      // under the same key. Persist a content-free terminal response so an
      // immediate retry does not wait for the five-minute lease to expire.
      const terminal = normalizeSafeResponse(indeterminateResponse(input.action));
      await store.complete(input, terminal, acquired.lease);
      return { ...terminal, replayed: false };
    }
    let response: ProviderOperationSafeResponse;
    try {
      response = normalizeSafeResponse(rawResponse);
    } catch (error) {
      // A malformed internal response is a programmer/configuration defect,
      // so the first caller still receives the typed validation error. The
      // durable receipt is nevertheless terminalized to prevent a retry loop.
      await store.complete(
        input,
        normalizeSafeResponse(indeterminateResponse(input.action)),
        acquired.lease,
      );
      throw error;
    }
    // Completion precedes the HTTP return, so a lost response can be replayed
    // without another provider call or another set of application side effects.
    await store.complete(input, response, acquired.lease);
    return { ...response, replayed: false };
  }

  const waitTimeoutMs = input.waitTimeoutMs ?? 180_000;
  const pollIntervalMs = input.pollIntervalMs ?? 50;
  const delay = input.delay ?? ((milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const deadline = Date.now() + waitTimeoutMs;
  while (Date.now() <= deadline) {
    const recovered = await store.recoverExpired?.(input);
    if (recovered?.kind === "completed") {
      return { ...recovered.response, replayed: true };
    }
    const receipt = await store.read(input);
    if (!receipt) {
      throw new ProviderOperationIdempotencyError(
        "IDEMPOTENCY_RECEIPT_UNAVAILABLE",
        "The provider-operation receipt disappeared while waiting.",
      );
    }
    assertMatchingHash(receipt, input.inputHash);
    if (receipt.status === "completed") return { ...completedResponse(receipt), replayed: true };
    await delay(pollIntervalMs);
  }
  const recovered = await store.recoverExpired?.(input);
  if (recovered?.kind === "completed") return { ...recovered.response, replayed: true };
  throw new ProviderOperationIdempotencyError(
    "IDEMPOTENCY_WAIT_TIMEOUT",
    "The original provider operation is still in progress. Retry this same request ID shortly.",
  );
}
