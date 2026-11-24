import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  captureException: vi.fn(), init: vi.fn(), isInitialized: vi.fn(), sdkLoaded: vi.fn(),
  query: vi.fn(), end: vi.fn(), drizzle: vi.fn(), created: vi.fn(),
}));

vi.mock("pg", async () => {
  const { EventEmitter } = await import("node:events");
  return { Pool: class extends EventEmitter {
    query = mocks.query;
    end = mocks.end;
    constructor(configuration: unknown) { super(); mocks.created(configuration); }
  } };
});
vi.mock("drizzle-orm/node-postgres", () => ({ drizzle: mocks.drizzle }));
vi.mock("../schema", () => ({}));
vi.mock("@sentry/node", () => {
  mocks.sdkLoaded();
  return { captureException: mocks.captureException, init: mocks.init, isInitialized: mocks.isInitialized };
});

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  vi.stubGlobal("learnCodingPool", undefined);
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("NEXT_RUNTIME", "");
  vi.stubEnv("SENTRY_DSN", "");
  mocks.isInitialized.mockReturnValue(true);
  mocks.query.mockResolvedValue({ rows: [{ value: 42 }] });
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("main database pool idle errors", () => {
  it.each(["test", "production"])("handles an idle-client error without exiting or closing the %s pool", async (environment) => {
    vi.stubEnv("NODE_ENV", environment);
    const exit = vi.spyOn(process, "exit").mockImplementation(() => { throw new Error("Unexpected exit"); });
    const { pool } = await import("../client");
    const error = Object.assign(new Error("Postgres connection dropped"), { code: "57P01" });

    expect(() => pool.emit("error", error)).not.toThrow();
    expect(exit).not.toHaveBeenCalled();
    expect(mocks.end).not.toHaveBeenCalled();
    await expect(pool.query("select 42 as value")).resolves.toEqual({ rows: [{ value: 42 }] });
  });

  it("logs and reports only safe error details, never the raw error or idle client", async () => {
    vi.stubEnv("SENTRY_DSN", "https://key@errors.example.test/2");
    const { pool } = await import("../client");
    expect(mocks.sdkLoaded).not.toHaveBeenCalled();
    const error = Object.assign(new Error("password=private-password postgresql://dbuser:private-password@db.test/app SQL private-learner-answer"), {
      code: "ECONNRESET", detail: "private-detail", cause: new Error("private-cause"),
    });
    expect(() => pool.emit("error", error, { connectionParameters: { password: "private-client-secret" } })).not.toThrow();
    await vi.waitFor(() => expect(mocks.captureException).toHaveBeenCalledOnce());

    expect(console.error).toHaveBeenCalledExactlyOnceWith(JSON.stringify({ event: "database.pool_error", code: "ECONNRESET" }));
    const [reported, context] = mocks.captureException.mock.calls[0]!;
    expect(reported).toBeInstanceOf(Error);
    expect(reported).not.toBe(error);
    expect(reported.message).toBe("Database pool idle client error (ECONNRESET).");
    expect(reported).not.toHaveProperty("cause");
    expect(context).toEqual({ level: "error", tags: { code: "DATABASE_POOL_ERROR" } });
    expect(JSON.stringify([vi.mocked(console.error).mock.calls, reported, reported.stack, context])).not.toMatch(/private-|postgresql:|dbuser/);
    expect(mocks.init).not.toHaveBeenCalled();
  });

  it("initializes unconfigured worker monitoring with the existing privacy policy", async () => {
    vi.stubEnv("SENTRY_DSN", "https://key@errors.example.test/2");
    vi.stubEnv("SENTRY_RELEASE", "pool-error-release");
    mocks.isInitialized.mockReturnValue(false);
    const { pool } = await import("../client");
    expect(() => pool.emit("error", Object.assign(new Error("secret"), { code: "08006" }))).not.toThrow();
    await vi.waitFor(() => expect(mocks.captureException).toHaveBeenCalledOnce());
    expect(mocks.init).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      sendDefaultPii: false, maxBreadcrumbs: 0, defaultIntegrations: false, tracesSampleRate: 0,
      release: "pool-error-release", initialScope: { tags: { runtime: "worker" } }, beforeSend: expect.any(Function),
    }));
  });

  it.each(["", "not-a-dsn"])("keeps monitoring disabled for DSN %j while still handling and logging errors", async (dsn) => {
    vi.stubEnv("SENTRY_DSN", dsn);
    const { pool } = await import("../client");
    expect(() => pool.emit("error", new Error("private-message"))).not.toThrow();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(console.error).toHaveBeenCalledOnce();
    expect(mocks.sdkLoaded).not.toHaveBeenCalled();
    expect(mocks.captureException).not.toHaveBeenCalled();
  });

  it("reuses the development pool without accumulating error listeners", async () => {
    const first = await import("../client");
    const otherListener = vi.fn();
    first.pool.on("error", otherListener);
    vi.resetModules();
    const second = await import("../client");
    expect(second.pool).toBe(first.pool);
    expect(mocks.created).toHaveBeenCalledOnce();
    expect(second.pool.listenerCount("error")).toBe(2);
    expect(() => second.pool.emit("error", new Error("idle error"))).not.toThrow();
    expect(console.error).toHaveBeenCalledOnce();
    expect(otherListener).toHaveBeenCalledOnce();
  });

  it("does not let logging or Sentry failures turn an idle error into an uncaught error", async () => {
    vi.stubEnv("SENTRY_DSN", "https://key@errors.example.test/2");
    vi.mocked(console.error).mockImplementation(() => { throw new Error("log sink failed"); });
    mocks.captureException.mockImplementation(() => { throw new Error("SDK failed"); });
    const { pool } = await import("../client");
    expect(() => pool.emit("error", new Error("idle error"))).not.toThrow();
    await vi.waitFor(() => expect(mocks.captureException).toHaveBeenCalledOnce());
  });

  it.each(["password=private-secret", "PRIVATE_SECRET", undefined])("omits an unrecognized error code %j", async (code) => {
    const { pool } = await import("../client");
    expect(() => pool.emit("error", Object.assign(new Error("private-message"), { code }))).not.toThrow();
    expect(console.error).toHaveBeenCalledExactlyOnceWith(JSON.stringify({ event: "database.pool_error", code: "UNKNOWN" }));
  });
});

describe("main database pool size", () => {
  it.each([
    [undefined, 10], ["4", 4], ["abc", 10], ["", 10], ["0", 10], ["-3", 10], ["2.5", 10], ["Infinity", 10],
  ])("DATABASE_POOL_SIZE=%s gives max %s, never NaN or a non-positive size", async (value, expected) => {
    if (value !== undefined) vi.stubEnv("DATABASE_POOL_SIZE", value);
    else vi.stubEnv("DATABASE_POOL_SIZE", undefined as unknown as string);
    await import("../client");
    expect(mocks.created).toHaveBeenCalledWith(expect.objectContaining({ max: expected }));
  });
});
