import { createHash } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import type { PoolClient } from "pg";

import { pool } from "@/lib/db/client";
import { withinExportDeadline } from "./export-deadline";

export async function checkoutExportClient(signal: AbortSignal) {
  const connection = pool.connect();
  void connection.then((client) => {
    if (signal.aborted) client.release(true);
  }, () => undefined);
  const client = await withinExportDeadline(connection, signal);
  let released = false;
  const release = (destroy: boolean) => {
    if (released) return;
    released = true;
    signal.removeEventListener("abort", onAbort);
    client.off?.("error", onClientError);
    client.release(destroy);
  };
  const onAbort = () => release(true);
  const onClientError = () => release(true);
  signal.addEventListener("abort", onAbort, { once: true });
  client.on?.("error", onClientError);
  if (signal.aborted) { release(true); throw signal.reason; }
  return { client, release };
}

export async function openExportSnapshot(
  learnerId: string,
  signal: AbortSignal,
  lease?: Awaited<ReturnType<typeof checkoutExportClient>>,
) {
  // Only fixed hexadecimal text is interpolated into the dollar-quoted block.
  const lockKey = createHash("sha256").update(`data-export:${learnerId}`).digest("hex");
  const { client, release } = lease ?? await checkoutExportClient(signal);
  let enter!: () => void;
  let rejectEntry!: (error: unknown) => void;
  const entered = new Promise<void>((resolve, reject) => { enter = resolve; rejectEntry = reject; });
  let finish!: () => void;
  let abort!: (error: unknown) => void;
  const finished = new Promise<void>((resolve, reject) => { finish = resolve; abort = reject; });
  void finished.catch(() => undefined);
  // A checked-out pg client can emit a connection error while the consumer
  // pauses between chunks. Keep that error on the transaction failure path.
  const onAbort = () => { abort(signal.reason); release(true); };
  const onClientError = (error: Error) => { abort(error); release(true); };
  signal.addEventListener("abort", onAbort, { once: true });
  client.on?.("error", onClientError);
  const transaction = drizzle(client).transaction(async () => {
    await client.query("SET LOCAL statement_timeout = '30s'");
    await client.query("SET LOCAL idle_in_transaction_session_timeout = '30s'");
    // Raise a stable contention error without creating a schema object.
    await client.query(`DO $export_lock$ BEGIN
      IF NOT pg_try_advisory_lock(hashtextextended('data-export:${lockKey}', 0)) THEN
        RAISE EXCEPTION 'Export already in progress.' USING ERRCODE = '55P03';
      END IF;
    END; $export_lock$`);
    enter();
    await finished;
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
  void transaction.catch(rejectEntry);
  const detach = () => {
    signal.removeEventListener("abort", onAbort);
    client.off?.("error", onClientError);
  };
  try {
    await withinExportDeadline(entered, signal);
  } catch (error) {
    abort(error);
    await withinExportDeadline(transaction.catch(() => undefined), signal).catch(() => undefined);
    detach();
    release(true);
    if (error && typeof error === "object" && "code" in error && error.code === "55P03") {
      throw Object.assign(new Error("An export is already in progress for this user."), { code: "EXPORT_ALREADY_IN_PROGRESS" });
    }
    throw error;
  }
  return {
    async *read<T>(
      produce: (client: PoolClient) => AsyncGenerator<T>,
      complete?: (client: PoolClient) => Promise<void>,
    ): AsyncGenerator<T> {
      let completed = false;
      try {
        yield* produce(client);
        finish();
        await withinExportDeadline(transaction, signal);
        if (complete) await withinExportDeadline(complete(client), signal);
        await withinExportDeadline(client.query(
          "select pg_advisory_unlock(hashtextextended($1, 0))", [`data-export:${lockKey}`],
        ), signal);
        completed = true;
      } catch (error) {
        abort(error);
        await withinExportDeadline(transaction.catch(() => undefined), signal).catch(() => undefined);
        throw error;
      } finally {
        if (!completed) {
          abort(new Error("Export stream canceled."));
          await withinExportDeadline(transaction.catch(() => undefined), signal).catch(() => undefined);
        }
        detach();
        release(!completed);
      }
    },
    cancel(error: Error) { abort(error); release(true); detach(); },
  };
}
