import { RunnerError } from "./errors.js";

interface StoredIdempotencyRecord<T> {
  readonly requestHash: string;
  readonly value: T;
  readonly expiresAtMs: number;
}

export interface IdempotencyRecord<T> extends StoredIdempotencyRecord<T> {
  readonly key: string;
}

export interface IdempotencyResult<T> {
  readonly value: T;
  readonly hit: boolean;
}

export class IdempotencyStore<T> {
  readonly #records = new Map<string, StoredIdempotencyRecord<T>>();
  readonly #ttlMs: number;
  readonly #capacity: number;

  constructor(ttlMs: number, capacity: number) {
    if (!Number.isInteger(ttlMs) || ttlMs <= 0) {
      throw new RangeError("idempotency TTL must be a positive integer");
    }
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new RangeError(
        "idempotency capacity must be a positive integer",
      );
    }
    this.#ttlMs = ttlMs;
    this.#capacity = capacity;
  }

  getOrCreate(
    key: string,
    requestHash: string,
    create: () => T,
    nowMs: number,
    pruneExpired = true,
  ): IdempotencyResult<T> {
    const existing = this.lookup(
      key,
      requestHash,
      nowMs,
      pruneExpired,
    );
    if (existing !== undefined) {
      return existing;
    }

    if (this.#records.size >= this.#capacity) {
      throw new RunnerError(
        "INFRASTRUCTURE_ERROR",
        "idempotency store is at capacity",
        503,
        true,
      );
    }
    const value = create();
    this.#records.set(key, {
      requestHash,
      value,
      expiresAtMs: nowMs + this.#ttlMs,
    });
    return { value, hit: false };
  }

  lookup(
    key: string,
    requestHash: string,
    nowMs: number,
    pruneExpired = true,
  ): IdempotencyResult<T> | undefined {
    if (!/^[A-Za-z0-9._:-]{16,200}$/.test(key)) {
      throw new RunnerError(
        "BAD_REQUEST",
        "idempotency key is invalid",
        400,
      );
    }
    if (pruneExpired) {
      this.prune(nowMs);
    }
    const existing = this.#records.get(key);
    if (existing !== undefined) {
      if (existing.requestHash !== requestHash) {
        throw new RunnerError(
          "IDEMPOTENCY_CONFLICT",
          "idempotency key was already used for a different request",
          409,
        );
      }
      return { value: existing.value, hit: true };
    }
    return undefined;
  }

  prune(nowMs: number): void {
    for (const [key, record] of this.#records) {
      if (record.expiresAtMs <= nowMs) {
        this.#records.delete(key);
      }
    }
  }

  restore(records: readonly IdempotencyRecord<T>[]): void {
    if (records.length > this.#capacity) {
      throw new RunnerError(
        "INFRASTRUCTURE_ERROR",
        "persisted idempotency records exceed configured capacity",
        500,
        true,
      );
    }
    this.#records.clear();
    for (const record of records) {
      if (this.#records.has(record.key)) {
        throw new RunnerError(
          "INFRASTRUCTURE_ERROR",
          "persisted idempotency keys must be unique",
          500,
          true,
        );
      }
      this.#records.set(record.key, {
        requestHash: record.requestHash,
        value: record.value,
        expiresAtMs: record.expiresAtMs,
      });
    }
  }

  delete(key: string): void {
    this.#records.delete(key);
  }

  snapshot(): readonly IdempotencyRecord<T>[] {
    return [...this.#records].map(([key, record]) => ({
      key,
      requestHash: record.requestHash,
      value: record.value,
      expiresAtMs: record.expiresAtMs,
    }));
  }

  get size(): number {
    return this.#records.size;
  }
}
