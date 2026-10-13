import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  query: vi.fn(), connect: vi.fn(), release: vi.fn(), statements: [] as string[],
  locks: new Set<string>(), failPage: false, hangPage: false,
}));
vi.mock("@/lib/db/client", () => ({ pool: { query: mocks.query, connect: mocks.connect } }));
import { createLearnerExport } from "../export";
import { EXPORT_DEADLINE_MS } from "../export-deadline";

let request = 0;
const input = () => ({
  learnerId: "bounded-learner", actorUserId: "admin",
  requestId: `81000000-0000-4000-8000-${String(++request).padStart(12, "0")}`,
});

describe("export runtime bounds", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.statements = [];
    mocks.locks.clear();
    mocks.failPage = mocks.hangPage = false;
    mocks.query.mockImplementation(async (sql: string) => ({
      rows: sql.includes("insert into data_lifecycle_run") ? [{ id: `run-${request}` }] : [],
    }));
    mocks.connect.mockImplementation(async () => {
      let held: string | undefined;
      return {
        query: async (statement: string | { text: string }) => {
          const sql = typeof statement === "string" ? statement : statement.text;
          mocks.statements.push(sql);
          if (sql.startsWith("DO $export_lock$")) {
            const key = /data-export:[^']+/.exec(sql)![0];
            if (mocks.locks.has(key)) throw Object.assign(new Error("busy"), { code: "55P03" });
            mocks.locks.add(key);
            held = key;
          }
          if (sql.includes("pg_advisory_unlock") && held) mocks.locks.delete(held);
          if (/\bas data\b/.test(sql)) {
            if (mocks.failPage) throw new Error("synthetic page failure");
            if (mocks.hangPage) return new Promise<never>(() => undefined);
          }
          if (sql.includes("insert into data_lifecycle_run") || sql.includes("update data_lifecycle_run")) {
            return mocks.query(sql);
          }
          return { rows: [] };
        },
        release: (destroy: boolean) => {
          if (destroy && held) mocks.locks.delete(held);
          mocks.release(destroy);
        },
        on: vi.fn(), off: vi.fn(),
      };
    });
  });
  afterEach(() => vi.useRealTimers());

  it("sets both 30-second local timeouts inside repeatable read before locking or reading", async () => {
    const exported = await createLearnerExport(input());
    await new Response(exported.stream).text();
    await exported.completion;
    expect(mocks.statements.filter((sql) => /^(begin|SET LOCAL)/.test(sql))).toEqual([
      "begin isolation level repeatable read read only",
      "SET LOCAL statement_timeout = '30s'",
      "SET LOCAL idle_in_transaction_session_timeout = '30s'",
    ]);
    expect(mocks.statements.findIndex((sql) => sql.includes("pg_try_advisory_lock")))
      .toBeGreaterThan(mocks.statements.indexOf("SET LOCAL idle_in_transaction_session_timeout = '30s'"));
  });

  it("rejects a concurrent export for the same user and releases the lock on finish", async () => {
    const first = await createLearnerExport(input());
    await expect(createLearnerExport(input())).rejects.toMatchObject({ code: "EXPORT_ALREADY_IN_PROGRESS" });
    await new Response(first.stream).text();
    await first.completion;
    const retry = await createLearnerExport(input());
    await new Response(retry.stream).text();
    await retry.completion;
    expect(mocks.locks.size).toBe(0);
  });

  it("releases the lock after a failed page and allows a new export", async () => {
    mocks.failPage = true;
    const failed = await createLearnerExport(input());
    const completion = expect(failed.completion).rejects.toThrow("synthetic page failure");
    await expect(new Response(failed.stream).blob()).rejects.toThrow("synthetic page failure");
    await completion;
    mocks.failPage = false;
    const retry = await createLearnerExport(input());
    await new Response(retry.stream).text();
    await retry.completion;
    expect(mocks.locks.size).toBe(0);
  });

  it("aborts a stuck export at 120 seconds, rejects the whole blob, and frees its lock", async () => {
    vi.useFakeTimers();
    mocks.hangPage = true;
    const exported = await createLearnerExport(input());
    const completion = expect(exported.completion).rejects.toMatchObject({ code: "EXPORT_DEADLINE_EXCEEDED" });
    const body = expect(new Response(exported.stream).blob()).rejects.toThrow(/120-second deadline/);
    await vi.advanceTimersByTimeAsync(EXPORT_DEADLINE_MS - 1);
    expect(mocks.locks.size).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await body;
    await completion;
    expect(mocks.release).toHaveBeenCalledWith(true);
    expect(mocks.locks.size).toBe(0);
    mocks.hangPage = false;
    const retry = await createLearnerExport(input());
    await new Response(retry.stream).text();
    await retry.completion;
  });

  it("expires and releases an export even if the consumer never reads", async () => {
    vi.useFakeTimers();
    const exported = await createLearnerExport(input());
    const completion = expect(exported.completion).rejects.toThrow(/deadline/);
    await vi.advanceTimersByTimeAsync(EXPORT_DEADLINE_MS);
    await completion;
    await expect(exported.stream.getReader().read()).rejects.toThrow(/deadline/);
    expect(mocks.locks.size).toBe(0);
    expect(mocks.release).toHaveBeenCalledTimes(1);
  });

  it("keeps the lock through finalization and aborts without a file if recording completion stalls", async () => {
    vi.useFakeTimers();
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes("insert into data_lifecycle_run")) return { rows: [{ id: `run-${request}` }] };
      if (sql.includes("status = 'succeeded'")) return new Promise<never>(() => undefined);
      return { rows: [] };
    });
    const exported = await createLearnerExport(input());
    const completion = expect(exported.completion).rejects.toThrow(/deadline/);
    const body = expect(new Response(exported.stream).blob()).rejects.toThrow(/deadline/);
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.statements).toContain("commit");
    await expect(createLearnerExport(input())).rejects.toMatchObject({ code: "EXPORT_ALREADY_IN_PROGRESS" });
    await vi.advanceTimersByTimeAsync(EXPORT_DEADLINE_MS);
    await body;
    await completion;
    expect(mocks.locks.size).toBe(0);
  });

  it("bounds initial registration and destroys its connection before opening a snapshot", async () => {
    vi.useFakeTimers();
    mocks.query.mockImplementation(() => new Promise<never>(() => undefined));
    const failure = expect(createLearnerExport(input())).rejects.toMatchObject({ code: "EXPORT_DEADLINE_EXCEEDED" });
    await vi.advanceTimersByTimeAsync(EXPORT_DEADLINE_MS);
    await failure;
    expect(mocks.statements.some((sql) => sql.startsWith("begin"))).toBe(false);
    expect(mocks.release).toHaveBeenCalledExactlyOnceWith(true);
  });

  it("destroys a connection arriving after the startup deadline", async () => {
    vi.useFakeTimers();
    let connect!: (client: { release: typeof mocks.release }) => void;
    mocks.connect.mockImplementation(() => new Promise((resolve) => { connect = resolve; }));
    const failure = expect(createLearnerExport(input())).rejects.toMatchObject({ code: "EXPORT_DEADLINE_EXCEEDED" });
    await vi.advanceTimersByTimeAsync(EXPORT_DEADLINE_MS);
    await failure;
    connect({ release: mocks.release });
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.release).toHaveBeenCalledExactlyOnceWith(true);
  });
});
