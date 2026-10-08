import { drizzle } from "drizzle-orm/node-postgres";
import type { PoolClient } from "pg";

import { pool } from "@/lib/db/client";

export async function* exportSnapshot<T>(
  produce: (client: PoolClient) => AsyncGenerator<T>,
): AsyncGenerator<T> {
  const client = await pool.connect();
  let enter!: () => void;
  let rejectEntry!: (error: unknown) => void;
  const entered = new Promise<void>((resolve, reject) => { enter = resolve; rejectEntry = reject; });
  let finish!: () => void;
  let abort!: (error: unknown) => void;
  const finished = new Promise<void>((resolve, reject) => { finish = resolve; abort = reject; });
  void finished.catch(() => undefined);
  // A checked-out pg client can emit a connection error while the consumer
  // pauses between chunks. Keep that error on the transaction failure path.
  const onClientError = (error: Error) => abort(error);
  client.on?.("error", onClientError);
  const transaction = drizzle(client).transaction(async () => {
    enter();
    await finished;
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
  void transaction.catch(rejectEntry);
  let completed = false;
  try {
    await entered;
    yield* produce(client);
    finish();
    await transaction;
    completed = true;
  } catch (error) {
    abort(error);
    await transaction.catch(() => undefined);
    throw error;
  } finally {
    if (!completed) {
      abort(new Error("Export stream canceled."));
      await transaction.catch(() => undefined);
    }
    client.off?.("error", onClientError);
    client.release(!completed);
  }
}
