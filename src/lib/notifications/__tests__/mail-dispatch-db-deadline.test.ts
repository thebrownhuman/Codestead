// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  MailDispatchDbClientLease,
  MailDispatchDbDeadlineExceededError,
  connectMailDispatchDbWithin,
  createCappedMailDispatchDbDeadline,
  createMailDispatchDbDeadline,
  queryMailDispatchDbWithin,
  type MailDispatchDbClient,
  type MailDispatchDbQueryResult,
} from "../mail-dispatch-db-deadline";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function result<Row extends Record<string, unknown>>(
  rows: Row[] = [],
): MailDispatchDbQueryResult<Row> {
  return { rows };
}

type QueryImplementation = (
  text: string,
  values?: unknown[],
) => Promise<MailDispatchDbQueryResult>;

function client(query: QueryImplementation = async () => result()) {
  const release = vi.fn<(destroy?: boolean) => void>();
  const typedQuery: MailDispatchDbClient["query"] = <
    Row extends Record<string, unknown> = Record<string, unknown>,
  >(
    text: string,
    values?: unknown[],
  ) => query(text, values) as Promise<MailDispatchDbQueryResult<Row>>;
  return {
    client: { query: typedQuery, release } satisfies MailDispatchDbClient,
    release,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("mail dispatch database deadlines", () => {
  it("keeps one monotonic aggregate cutoff as time advances", () => {
    let now = 40;
    const deadline = createMailDispatchDbDeadline({
      phase: "pre-provider",
      budgetMs: 100,
      now: () => now,
    });

    expect(deadline.expiresAtMs).toBe(140);
    expect(deadline.remainingMs()).toBe(100);

    now = 105;
    expect(deadline.remainingMs()).toBe(35);

    now = 140;
    expect(deadline.remainingMs()).toBe(0);

    now = 180;
    expect(deadline.remainingMs()).toBe(0);
  });

  it("does not extend a deadline when an injected clock regresses", () => {
    let now = 20;
    const deadline = createMailDispatchDbDeadline({
      phase: "pre-provider",
      budgetMs: 100,
      now: () => now,
    });

    now = 70;
    expect(deadline.remainingMs()).toBe(50);

    now = 30;
    expect(deadline.remainingMs()).toBe(50);

    now = 80;
    expect(deadline.remainingMs()).toBe(40);
  });

  it("caps a child at the parent's absolute cutoff after time advances", () => {
    let now = 0;
    const parent = createMailDispatchDbDeadline({
      phase: "pre-provider",
      budgetMs: 100,
      now: () => now,
    });

    now = 25;
    expect(parent.remainingMs()).toBe(75);

    now = 90;
    const child = createCappedMailDispatchDbDeadline({
      parent,
      budgetMs: 50,
      phase: "post-provider",
    });

    expect(child.phase).toBe("post-provider");
    expect(child.startedAtMs).toBe(90);
    expect(child.expiresAtMs).toBe(parent.expiresAtMs);

    now = 95;
    expect(child.remainingMs()).toBe(5);
  });

  it("shares the parent's monotonic clamp when the clock rolls back", () => {
    let now = 0;
    const parent = createMailDispatchDbDeadline({
      phase: "pre-provider",
      budgetMs: 100,
      now: () => now,
    });

    now = 60;
    expect(parent.remainingMs()).toBe(40);

    now = 20;
    const child = createCappedMailDispatchDbDeadline({
      parent,
      budgetMs: 30,
    });
    expect(child.startedAtMs).toBe(60);
    expect(child.expiresAtMs).toBe(90);

    now = 80;
    expect(child.remainingMs()).toBe(10);

    now = 30;
    expect(parent.remainingMs()).toBe(20);
    expect(child.remainingMs()).toBe(10);
  });

  it("releases an owned client at most once", () => {
    const database = client();
    const lease = new MailDispatchDbClientLease(database.client);

    lease.release();
    lease.release();
    lease.destroy();

    expect(lease.isReleased).toBe(true);
    expect(database.release).toHaveBeenCalledTimes(1);
    expect(database.release).toHaveBeenCalledWith(false);
  });

  it("runs beforeDestroy synchronously before destructive release", () => {
    const order: string[] = [];
    const database = client();
    database.release.mockImplementation((destroy) => {
      order.push(`release:${String(destroy)}`);
    });
    const lease = new MailDispatchDbClientLease(database.client);

    lease.destroy(() => order.push("beforeDestroy"));
    lease.destroy(() => order.push("unexpected"));

    expect(order).toEqual(["beforeDestroy", "release:true"]);
  });

  it("bounds pool checkout and destroys a client delivered after timeout", async () => {
    vi.useFakeTimers();
    const connection = deferred<MailDispatchDbClient>();
    const late = client();
    const pending = connectMailDispatchDbWithin({
      pool: { connect: () => connection.promise },
      deadline: createMailDispatchDbDeadline({
        phase: "pool-acquire",
        budgetMs: 17,
      }),
    });
    const rejected = expect(pending).rejects.toBeInstanceOf(
      MailDispatchDbDeadlineExceededError,
    );

    await vi.advanceTimersByTimeAsync(17);
    await rejected;

    connection.resolve(late.client);
    await vi.runAllTimersAsync();

    expect(late.release).toHaveBeenCalledTimes(1);
    expect(late.release).toHaveBeenCalledWith(true);
  });

  it("destroys a checkout whose fulfillment handler observes an expired deadline", async () => {
    let now = 0;
    const connection = deferred<MailDispatchDbClient>();
    const late = client();
    const pending = connectMailDispatchDbWithin({
      pool: { connect: () => connection.promise },
      deadline: createMailDispatchDbDeadline({
        phase: "pool-acquire",
        budgetMs: 10,
        now: () => now,
      }),
    });

    now = 10;
    connection.resolve(late.client);

    await expect(pending).rejects.toBeInstanceOf(
      MailDispatchDbDeadlineExceededError,
    );
    expect(late.release).toHaveBeenCalledWith(true);
  });

  it("observes a pool rejection that arrives after the timeout", async () => {
    vi.useFakeTimers();
    const connection = deferred<MailDispatchDbClient>();
    const pending = connectMailDispatchDbWithin({
      pool: { connect: () => connection.promise },
      deadline: createMailDispatchDbDeadline({
        phase: "pool-acquire",
        budgetMs: 11,
      }),
    });
    const rejected = expect(pending).rejects.toBeInstanceOf(
      MailDispatchDbDeadlineExceededError,
    );

    await vi.advanceTimersByTimeAsync(11);
    await rejected;

    connection.reject(new Error("late pool failure"));
    await vi.runAllTimersAsync();
  });

  it("destroys an in-flight query at the cutoff and redacts its inputs", async () => {
    vi.useFakeTimers();
    const queryResult = deferred<MailDispatchDbQueryResult>();
    const database = client(() => queryResult.promise);
    const lease = new MailDispatchDbClientLease(database.client);
    const order: string[] = [];
    database.release.mockImplementation((destroy) => {
      order.push(`release:${String(destroy)}`);
    });
    const pending = queryMailDispatchDbWithin({
      lease,
      deadline: createMailDispatchDbDeadline({
        phase: "pre-provider",
        budgetMs: 13,
      }),
      text: "select 'sql-secret-canary'",
      values: ["value-secret-canary"],
      beforeDestroy: () => order.push("beforeDestroy"),
    });
    const caught = pending.catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(13);
    const error = await caught;

    expect(error).toBeInstanceOf(MailDispatchDbDeadlineExceededError);
    expect(String(error)).not.toContain("sql-secret-canary");
    expect(String(error)).not.toContain("value-secret-canary");
    expect(JSON.stringify(error)).not.toContain("sql-secret-canary");
    expect(JSON.stringify(error)).not.toContain("value-secret-canary");
    expect(order).toEqual(["beforeDestroy", "release:true"]);

    queryResult.resolve(result());
    await vi.runAllTimersAsync();
    expect(database.release).toHaveBeenCalledTimes(1);
  });

  it("observes a query rejection that arrives after destructive timeout", async () => {
    vi.useFakeTimers();
    const queryResult = deferred<MailDispatchDbQueryResult>();
    const database = client(() => queryResult.promise);
    const lease = new MailDispatchDbClientLease(database.client);
    const pending = queryMailDispatchDbWithin({
      lease,
      deadline: createMailDispatchDbDeadline({
        phase: "post-provider",
        budgetMs: 19,
      }),
      text: "select 1",
    });
    const rejected = expect(pending).rejects.toBeInstanceOf(
      MailDispatchDbDeadlineExceededError,
    );

    await vi.advanceTimersByTimeAsync(19);
    await rejected;

    queryResult.reject(new Error("late query failure"));
    await vi.runAllTimersAsync();
    expect(database.release).toHaveBeenCalledTimes(1);
  });

  it("rechecks the cutoff when a query fulfills before its timer callback", async () => {
    let now = 0;
    const queryResult = deferred<MailDispatchDbQueryResult>();
    const database = client(() => queryResult.promise);
    const lease = new MailDispatchDbClientLease(database.client);
    const pending = queryMailDispatchDbWithin({
      lease,
      deadline: createMailDispatchDbDeadline({
        phase: "pre-provider",
        budgetMs: 10,
        now: () => now,
      }),
      text: "select 1",
    });

    now = 10;
    queryResult.resolve(result());

    await expect(pending).rejects.toBeInstanceOf(
      MailDispatchDbDeadlineExceededError,
    );
    expect(database.release).toHaveBeenCalledWith(true);
  });

  it("rechecks the cutoff when a query rejects before its timer callback", async () => {
    let now = 0;
    const queryResult = deferred<MailDispatchDbQueryResult>();
    const database = client(() => queryResult.promise);
    const lease = new MailDispatchDbClientLease(database.client);
    const pending = queryMailDispatchDbWithin({
      lease,
      deadline: createMailDispatchDbDeadline({
        phase: "post-provider",
        budgetMs: 10,
        now: () => now,
      }),
      text: "select 1",
    });

    now = 10;
    queryResult.reject(new Error("database rejected too late"));

    await expect(pending).rejects.toBeInstanceOf(
      MailDispatchDbDeadlineExceededError,
    );
    expect(database.release).toHaveBeenCalledWith(true);
  });

  it("shares one aggregate cutoff across sequential queries", async () => {
    vi.useFakeTimers();
    const secondResult = deferred<MailDispatchDbQueryResult>();
    const query = vi
      .fn<QueryImplementation>()
      .mockResolvedValueOnce(result())
      .mockImplementationOnce(() => secondResult.promise);
    const database = client(query);
    const lease = new MailDispatchDbClientLease(database.client);
    const deadline = createMailDispatchDbDeadline({
      phase: "pre-provider",
      budgetMs: 100,
    });

    await queryMailDispatchDbWithin({ lease, deadline, text: "select 1" });
    await vi.advanceTimersByTimeAsync(60);

    const second = queryMailDispatchDbWithin({
      lease,
      deadline,
      text: "select 2",
    });
    const rejected = expect(second).rejects.toBeInstanceOf(
      MailDispatchDbDeadlineExceededError,
    );

    await vi.advanceTimersByTimeAsync(39);
    expect(database.release).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await rejected;
    expect(database.release).toHaveBeenCalledWith(true);
  });

  it("destroys a query at an earlier capped child cutoff", async () => {
    vi.useFakeTimers();
    const parent = createMailDispatchDbDeadline({
      phase: "pre-provider",
      budgetMs: 100,
    });
    await vi.advanceTimersByTimeAsync(10);
    const child = createCappedMailDispatchDbDeadline({
      parent,
      budgetMs: 25,
    });
    const queryResult = deferred<MailDispatchDbQueryResult>();
    const database = client(() => queryResult.promise);
    const lease = new MailDispatchDbClientLease(database.client);
    const pending = queryMailDispatchDbWithin({
      lease,
      deadline: child,
      text: "select 1",
    });
    const rejected = expect(pending).rejects.toBeInstanceOf(
      MailDispatchDbDeadlineExceededError,
    );

    expect(parent.expiresAtMs - parent.startedAtMs).toBe(100);
    expect(child.expiresAtMs - parent.startedAtMs).toBe(35);

    await vi.advanceTimersByTimeAsync(24);
    expect(database.release).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await rejected;
    expect(database.release).toHaveBeenCalledWith(true);
  });

  it("returns a query result that settles before the aggregate cutoff", async () => {
    const expected = result([{ value: 1 }]);
    const database = client(async () => expected);
    const lease = new MailDispatchDbClientLease(database.client);

    await expect(
      queryMailDispatchDbWithin({
        lease,
        deadline: createMailDispatchDbDeadline({
          phase: "post-provider",
          budgetMs: 50,
        }),
        text: "select 1 as value",
      }),
    ).resolves.toBe(expected);

    expect(database.release).not.toHaveBeenCalled();
  });
});
