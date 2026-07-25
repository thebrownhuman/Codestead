export type MailDispatchDbQueryResult<
  Row extends Record<string, unknown> = Record<string, unknown>,
> = Readonly<{
  rows: Row[];
  rowCount?: number | null;
}>;

export interface MailDispatchDbClient {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<MailDispatchDbQueryResult<Row>>;
  release(destroy?: boolean): void;
}

export interface MailDispatchDbPool<
  Client extends MailDispatchDbClient = MailDispatchDbClient,
> {
  connect(): Promise<Client>;
}

export type MailDispatchDbDeadlinePhase =
  | "pool-acquire"
  | "pre-provider"
  | "post-init-arm"
  | "post-provider";

export type MailDispatchMonotonicNow = () => number;

const defaultMonotonicNow: MailDispatchMonotonicNow = () => performance.now();

function assertFiniteNow(value: number): number {
  if (!Number.isFinite(value)) {
    throw new Error("Mail dispatch monotonic clock is unavailable.");
  }
  return value;
}

export class MailDispatchDbDeadline {
  readonly phase: MailDispatchDbDeadlinePhase;
  readonly startedAtMs: number;
  readonly expiresAtMs: number;

  readonly #clock: {
    readonly now: MailDispatchMonotonicNow;
    lastObservedAtMs: number;
  };

  constructor(input: Readonly<{
    phase: MailDispatchDbDeadlinePhase;
    budgetMs: number;
    now?: MailDispatchMonotonicNow;
  }>, parent?: MailDispatchDbDeadline) {
    if (!Number.isSafeInteger(input.budgetMs) || input.budgetMs <= 0) {
      throw new Error(
        "Mail dispatch database deadline budget must be a positive safe integer.",
      );
    }
    this.phase = input.phase;
    if (parent) {
      this.#clock = parent.#clock;
      this.startedAtMs = parent.#readNow();
    } else {
      const now = input.now ?? defaultMonotonicNow;
      const startedAtMs = assertFiniteNow(now());
      this.#clock = { now, lastObservedAtMs: startedAtMs };
      this.startedAtMs = startedAtMs;
    }
    const requestedExpiry = this.startedAtMs + input.budgetMs;
    this.expiresAtMs = parent
      ? Math.min(parent.expiresAtMs, requestedExpiry)
      : requestedExpiry;
    if (
      !Number.isFinite(this.expiresAtMs)
      || Math.abs(this.expiresAtMs) > Number.MAX_SAFE_INTEGER
    ) {
      throw new Error("Mail dispatch database deadline is outside the safe range.");
    }
  }

  #readNow(): number {
    const observedAtMs = assertFiniteNow(this.#clock.now());
    this.#clock.lastObservedAtMs = Math.max(
      this.#clock.lastObservedAtMs,
      observedAtMs,
    );
    return this.#clock.lastObservedAtMs;
  }

  remainingMs(): number {
    return Math.max(0, this.expiresAtMs - this.#readNow());
  }

  isExpired(): boolean {
    return this.remainingMs() <= 0;
  }
}

export function createMailDispatchDbDeadline(
  input: ConstructorParameters<typeof MailDispatchDbDeadline>[0],
): MailDispatchDbDeadline {
  return new MailDispatchDbDeadline(input);
}

export function createCappedMailDispatchDbDeadline(input: Readonly<{
  parent: MailDispatchDbDeadline;
  budgetMs: number;
  phase?: MailDispatchDbDeadlinePhase;
}>): MailDispatchDbDeadline {
  if (!(input.parent instanceof MailDispatchDbDeadline)) {
    throw new Error("Mail dispatch parent database deadline is invalid.");
  }
  return new MailDispatchDbDeadline(
    {
      phase: input.phase ?? input.parent.phase,
      budgetMs: input.budgetMs,
    },
    input.parent,
  );
}
export class MailDispatchDbDeadlineExceededError extends Error {
  readonly code = "MAIL_DISPATCH_DB_DEADLINE_EXCEEDED" as const;
  readonly phase: MailDispatchDbDeadlinePhase;

  constructor(phase: MailDispatchDbDeadlinePhase) {
    super("Mail dispatch database operation exceeded its deadline.");
    this.name = "MailDispatchDbDeadlineExceededError";
    this.phase = phase;
  }
}

export class MailDispatchDbClientLease<
  Client extends MailDispatchDbClient = MailDispatchDbClient,
> {
  readonly client: Client;
  #released = false;

  constructor(client: Client) {
    this.client = client;
  }

  get isReleased(): boolean {
    return this.#released;
  }

  release(): void {
    this.#close(false);
  }

  destroy(beforeDestroy?: () => void): void {
    this.#close(true, beforeDestroy);
  }

  #close(destroy: boolean, beforeDestroy?: () => void): void {
    if (this.#released) return;
    this.#released = true;

    let callbackThrew = false;
    let callbackError: unknown;
    try {
      beforeDestroy?.();
    } catch (error) {
      callbackThrew = true;
      callbackError = error;
    }

    let releaseThrew = false;
    let releaseError: unknown;
    try {
      this.client.release(destroy);
    } catch (error) {
      releaseThrew = true;
      releaseError = error;
    }

    if (callbackThrew) throw callbackError;
    if (releaseThrew) throw releaseError;
  }
}

type SettleWithinDeadlineInput<T> = Readonly<{
  operation: Promise<T>;
  deadline: MailDispatchDbDeadline;
  onDeadline(): void;
  onLateFulfilled?(value: T): void;
}>;

function ignoreCleanupFailure(cleanup: () => void): void {
  try {
    cleanup();
  } catch {
    // Deadline errors deliberately remain redacted and authoritative.
  }
}

function settleWithinDeadline<T>(
  input: SettleWithinDeadlineInput<T>,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let finished = false;

    function clearTimer() {
      if (timer !== undefined) clearTimeout(timer);
    }
    function expire() {
      if (finished) return;
      finished = true;
      clearTimer();
      ignoreCleanupFailure(input.onDeadline);
      reject(new MailDispatchDbDeadlineExceededError(input.deadline.phase));
    }

    input.operation.then(
      (value) => {
        if (finished) {
          if (input.onLateFulfilled) {
            ignoreCleanupFailure(() => input.onLateFulfilled!(value));
          }
          return;
        }
        if (input.deadline.isExpired()) {
          expire();
          if (input.onLateFulfilled) {
            ignoreCleanupFailure(() => input.onLateFulfilled!(value));
          }
          return;
        }
        finished = true;
        clearTimer();
        resolve(value);
      },
      (error: unknown) => {
        if (finished) return;
        if (input.deadline.isExpired()) {
          expire();
          return;
        }
        finished = true;
        clearTimer();
        reject(error);
      },
    );

    const remainingMs = input.deadline.remainingMs();
    const timer = remainingMs > 0
      ? setTimeout(expire, Math.max(0, Math.floor(remainingMs)))
      : undefined;
    if (remainingMs <= 0) {
      expire();
    }
  });
}

function rejectExpired<T>(
  deadline: MailDispatchDbDeadline,
  onDeadline: () => void,
): Promise<T> {
  ignoreCleanupFailure(onDeadline);
  return Promise.reject(
    new MailDispatchDbDeadlineExceededError(deadline.phase),
  );
}

export function connectMailDispatchDbWithin<
  Client extends MailDispatchDbClient,
>(input: Readonly<{
  pool: MailDispatchDbPool<Client>;
  deadline: MailDispatchDbDeadline;
}>): Promise<MailDispatchDbClientLease<Client>> {
  if (input.deadline.isExpired()) {
    return rejectExpired(input.deadline, () => undefined);
  }

  let connection: Promise<Client>;
  try {
    connection = Promise.resolve(input.pool.connect());
  } catch (error) {
    if (input.deadline.isExpired()) {
      return rejectExpired(input.deadline, () => undefined);
    }
    return Promise.reject(error);
  }

  const leasedConnection = connection.then(
    (client) => new MailDispatchDbClientLease(client),
  );
  return settleWithinDeadline({
    operation: leasedConnection,
    deadline: input.deadline,
    onDeadline: () => undefined,
    onLateFulfilled: (lease) => lease.destroy(),
  });
}

export function queryMailDispatchDbWithin<
  Row extends Record<string, unknown> = Record<string, unknown>,
  Client extends MailDispatchDbClient = MailDispatchDbClient,
>(input: Readonly<{
  lease: MailDispatchDbClientLease<Client>;
  deadline: MailDispatchDbDeadline;
  text: string;
  values?: unknown[];
  beforeDestroy?: () => void;
}>): Promise<MailDispatchDbQueryResult<Row>> {
  if (input.lease.isReleased) {
    return Promise.reject(
      new Error("Mail dispatch database client lease is already released."),
    );
  }
  const destroy = () => input.lease.destroy(input.beforeDestroy);
  if (input.deadline.isExpired()) {
    return rejectExpired(input.deadline, destroy);
  }

  let query: Promise<MailDispatchDbQueryResult<Row>>;
  try {
    query = Promise.resolve(
      input.lease.client.query<Row>(input.text, input.values),
    );
  } catch (error) {
    if (input.deadline.isExpired()) {
      return rejectExpired(input.deadline, destroy);
    }
    return Promise.reject(error);
  }

  return settleWithinDeadline({
    operation: query,
    deadline: input.deadline,
    onDeadline: destroy,
  });
}
