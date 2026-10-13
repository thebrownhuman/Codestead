import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { pool } from "@/lib/db/client";
import { openExportSnapshot } from "@/lib/data-lifecycle/export-snapshot";

beforeEach(() => {
  if (process.env.INTEGRATION_TEST !== "1" || !/\/learncoding_integration(?:\?|$)/.test(process.env.DATABASE_URL ?? "")) {
    throw new Error("Export lock tests require the disposable integration database.");
  }
});
afterAll(async () => { await pool.end(); });

describe("PostgreSQL export locking and timeouts", () => {
  it("enforces one export per user across connections and releases after rollback and commit", async () => {
    const signal = AbortSignal.timeout(20_000);
    const first = await openExportSnapshot("bounded-export-pg-user", signal);
    try {
      await expect(openExportSnapshot("bounded-export-pg-user", signal))
        .rejects.toMatchObject({ code: "EXPORT_ALREADY_IN_PROGRESS" });
      const other = await openExportSnapshot("bounded-export-pg-other-user", signal);
      const otherRead = other.read(async function* () { yield "other user"; });
      expect((await otherRead.next()).value).toBe("other user");
      await otherRead.next();
      const read = first.read(async function* (client) {
        const result = await client.query(`select current_setting('statement_timeout') statement_timeout,
          current_setting('idle_in_transaction_session_timeout') idle_timeout,
          current_setting('transaction_isolation') isolation`);
        yield result.rows[0];
        throw new Error("forced export failure");
      });
      expect((await read.next()).value).toEqual({
        statement_timeout: "30s", idle_timeout: "30s", isolation: "repeatable read",
      });
      await expect(read.next()).rejects.toThrow("forced export failure");
      const retry = await openExportSnapshot("bounded-export-pg-user", signal);
      const retryRead = retry.read(async function* () { yield "retry"; });
      await retryRead.next();
      await retryRead.next();
      const afterCommit = await openExportSnapshot("bounded-export-pg-user", signal);
      const finalRead = afterCommit.read(async function* () { yield "after commit"; });
      await finalRead.next();
      await finalRead.next();
    } finally {
      first.cancel(new Error("Test cleanup"));
    }
  });

  it("releases a checked-out lock when its export is aborted without a consumer", async () => {
    const controller = new AbortController();
    const first = await openExportSnapshot("bounded-export-pg-abort", controller.signal);
    controller.abort(new Error("Export deadline reached"));
    // Wait until the server observes the terminated transaction's socket.
    let retry!: Awaited<ReturnType<typeof openExportSnapshot>>;
    await vi.waitFor(async () => {
      retry = await openExportSnapshot("bounded-export-pg-abort", AbortSignal.timeout(20_000));
    }, { timeout: 2_000, interval: 25 });
    const read = retry.read(async function* () { yield "retry after abort"; });
    await read.next();
    await read.next();
    first.cancel(new Error("Test cleanup"));
  });
});
