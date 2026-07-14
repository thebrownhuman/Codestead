import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig, parsePinnedImage } from "../config.js";
import { RunnerError } from "../errors.js";
import { IdempotencyStore } from "../idempotency.js";
import { FifoWorkQueue } from "../queue.js";

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe("two-concurrency FIFO queue", () => {
  it("starts two jobs and preserves FIFO for the next slot", async () => {
    const queue = new FifoWorkQueue<string>(2, 5);
    const first = deferred<string>();
    const second = deferred<string>();
    const third = deferred<string>();
    const starts: string[] = [];
    const one = queue.enqueue("one", () => first.promise, () => starts.push("one"));
    const two = queue.enqueue("two", () => second.promise, () => starts.push("two"));
    const three = queue.enqueue(
      "three",
      () => third.promise,
      () => starts.push("three"),
    );

    expect(one.position).toBe(1);
    expect(two.position).toBe(2);
    expect(three.position).toBe(3);
    await flush();
    expect(starts).toEqual(["one", "two"]);
    expect(queue.active).toBe(2);
    expect(queue.positionOf("three")).toBe(1);

    first.resolve("first done");
    await flush();
    expect(starts).toEqual(["one", "two", "three"]);
    second.resolve("second done");
    third.resolve("third done");
    await expect(one.completion).resolves.toBe("first done");
    await expect(two.completion).resolves.toBe("second done");
    await expect(three.completion).resolves.toBe("third done");
  });

  it("propagates work failures and frees the slot", async () => {
    const queue = new FifoWorkQueue<string>(2, 3);
    const failed = queue.enqueue("bad", async () => {
      throw new Error("failure");
    });
    await expect(failed.completion).rejects.toThrow("failure");
    await flush();
    expect(queue.active).toBe(0);
  });

  it("does not invoke work when the durable onStart hook fails", async () => {
    const queue = new FifoWorkQueue<string>(2, 3);
    let worked = false;
    const item = queue.enqueue(
      "not-started",
      async () => {
        worked = true;
        return "unexpected";
      },
      () => {
        throw new Error("journal write failed");
      },
    );
    await expect(item.completion).rejects.toThrow("journal write failed");
    expect(worked).toBe(false);
    expect(queue.active).toBe(0);
  });

  it("rejects work when active plus queued reaches capacity", async () => {
    const queue = new FifoWorkQueue<string>(2, 2);
    const one = deferred<string>();
    const two = deferred<string>();
    queue.enqueue("one", () => one.promise);
    queue.enqueue("two", () => two.promise);
    expect(() => queue.enqueue("three", async () => "three")).toThrowError(
      expect.objectContaining<Partial<RunnerError>>({
        code: "QUEUE_FULL",
      }),
    );
    one.resolve("one");
    two.resolve("two");
    await flush();
  });
});

describe("idempotency store", () => {
  it("returns the original value for the same key and hash", () => {
    const store = new IdempotencyStore<string>(1_000, 10);
    const first = store.getOrCreate(
      "idempotency-key-1",
      "hash-a",
      () => "job-1",
      0,
    );
    const second = store.getOrCreate(
      "idempotency-key-1",
      "hash-a",
      () => "job-2",
      1,
    );
    expect(first).toEqual({ value: "job-1", hit: false });
    expect(second).toEqual({ value: "job-1", hit: true });
  });

  it("rejects reusing a key for a different request", () => {
    const store = new IdempotencyStore<string>(1_000, 10);
    store.getOrCreate(
      "idempotency-key-1",
      "hash-a",
      () => "job-1",
      0,
    );
    expect(() =>
      store.getOrCreate(
        "idempotency-key-1",
        "hash-b",
        () => "job-2",
        1,
      ),
    ).toThrowError(
      expect.objectContaining<Partial<RunnerError>>({
        code: "IDEMPOTENCY_CONFLICT",
      }),
    );
  });

  it("expires records without evicting a live idempotency guarantee", () => {
    const store = new IdempotencyStore<string>(10, 1);
    store.getOrCreate("idempotency-key-1", "a", () => "one", 0);
    expect(() =>
      store.getOrCreate(
        "idempotency-key-2",
        "b",
        () => "two",
        1,
      ),
    ).toThrowError(
      expect.objectContaining<Partial<RunnerError>>({
        code: "INFRASTRUCTURE_ERROR",
      }),
    );
    expect(store.size).toBe(1);
    const recreated = store.getOrCreate(
      "idempotency-key-1",
      "c",
      () => "three",
      12,
    );
    expect(recreated).toEqual({ value: "three", hit: false });
  });
});

describe("runner configuration", () => {
  it("requires full OCI digest references", () => {
    const digest = "a".repeat(64);
    expect(
      parsePinnedImage(
        `registry.test/runtime@sha256:${digest}`,
        "IMAGE",
      ),
    ).toEqual({
      image: `registry.test/runtime@sha256:${digest}`,
      digest: `sha256:${digest}`,
    });
    expect(() => parsePinnedImage("runtime:latest", "IMAGE")).toThrow(
      /pinned/,
    );
  });

  it("loads exactly the five allowlisted runtimes and concurrency two", () => {
    const env: NodeJS.ProcessEnv = {
      RUNNER_SHARED_SECRET: "s".repeat(32),
      RUNNER_IMAGE_C: `r/c@sha256:${"a".repeat(64)}`,
      RUNNER_IMAGE_CPP: `r/cpp@sha256:${"b".repeat(64)}`,
      RUNNER_IMAGE_JAVA: `r/java@sha256:${"c".repeat(64)}`,
      RUNNER_IMAGE_PYTHON: `r/python@sha256:${"d".repeat(64)}`,
      RUNNER_IMAGE_JAVASCRIPT: `r/js@sha256:${"e".repeat(64)}`,
    };
    const config = loadConfig(env);
    expect(config.concurrency).toBe(2);
    expect(config.stateRoot).toBe(
      path.resolve("/var/lib/learncoding-runner"),
    );
    expect(config.tempRoot).toBe(
      path.resolve("/var/lib/learncoding-runner/tmp"),
    );
    expect(Object.keys(config.runtimes).sort()).toEqual([
      "c",
      "cpp",
      "java",
      "javascript",
      "python",
    ]);
  });

  it("supports an explicit runner-local state root", () => {
    const env: NodeJS.ProcessEnv = {
      RUNNER_SHARED_SECRET: "s".repeat(32),
      RUNNER_STATE_ROOT: "./private-runner-state",
      RUNNER_IMAGE_C: `r/c@sha256:${"a".repeat(64)}`,
      RUNNER_IMAGE_CPP: `r/cpp@sha256:${"b".repeat(64)}`,
      RUNNER_IMAGE_JAVA: `r/java@sha256:${"c".repeat(64)}`,
      RUNNER_IMAGE_PYTHON: `r/python@sha256:${"d".repeat(64)}`,
      RUNNER_IMAGE_JAVASCRIPT: `r/js@sha256:${"e".repeat(64)}`,
    };
    expect(loadConfig(env).stateRoot).toBe(
      path.resolve("./private-runner-state"),
    );
  });

  it("rejects weak secrets and concurrency drift", () => {
    const images: NodeJS.ProcessEnv = {
      RUNNER_IMAGE_C: `r/c@sha256:${"a".repeat(64)}`,
      RUNNER_IMAGE_CPP: `r/cpp@sha256:${"b".repeat(64)}`,
      RUNNER_IMAGE_JAVA: `r/java@sha256:${"c".repeat(64)}`,
      RUNNER_IMAGE_PYTHON: `r/python@sha256:${"d".repeat(64)}`,
      RUNNER_IMAGE_JAVASCRIPT: `r/js@sha256:${"e".repeat(64)}`,
    };
    expect(() =>
      loadConfig({ ...images, RUNNER_SHARED_SECRET: "short" }),
    ).toThrow(/32 bytes/);
    expect(() =>
      loadConfig({
        ...images,
        RUNNER_SHARED_SECRET: "s".repeat(32),
        RUNNER_MAX_CONCURRENCY: "3",
      }),
    ).toThrow(/2 to 2/);
  });

  it("rejects nonce or idempotency retention that does not outlive the full signed-request window", () => {
    const base: NodeJS.ProcessEnv = {
      RUNNER_SHARED_SECRET: "s".repeat(32),
      RUNNER_IMAGE_C: `r/c@sha256:${"a".repeat(64)}`,
      RUNNER_IMAGE_CPP: `r/cpp@sha256:${"b".repeat(64)}`,
      RUNNER_IMAGE_JAVA: `r/java@sha256:${"c".repeat(64)}`,
      RUNNER_IMAGE_PYTHON: `r/python@sha256:${"d".repeat(64)}`,
      RUNNER_IMAGE_JAVASCRIPT: `r/js@sha256:${"e".repeat(64)}`,
      RUNNER_AUTH_MAX_SKEW_SECONDS: "300",
      RUNNER_NONCE_TTL_SECONDS: "601",
      RUNNER_IDEMPOTENCY_TTL_SECONDS: "601",
    };
    expect(loadConfig(base)).toMatchObject({
      authMaxSkewSeconds: 300,
      nonceTtlSeconds: 601,
      idempotencyTtlMs: 601_000,
    });
    expect(() => loadConfig({ ...base, RUNNER_NONCE_TTL_SECONDS: "600" }))
      .toThrow(/NONCE_TTL_SECONDS must be greater than twice/i);
    expect(() => loadConfig({ ...base, RUNNER_IDEMPOTENCY_TTL_SECONDS: "600" }))
      .toThrow(/IDEMPOTENCY_TTL_SECONDS must be greater than twice/i);
    expect(() => loadConfig({
      ...base,
      RUNNER_AUTH_MAX_SKEW_SECONDS: "900",
      RUNNER_NONCE_TTL_SECONDS: "1800",
      RUNNER_IDEMPOTENCY_TTL_SECONDS: "1800",
    })).toThrow(/must be greater than twice/i);
  });
});
