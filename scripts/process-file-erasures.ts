import path from "node:path";

import { pool } from "../src/lib/db/client";
import { processUserFileErasures } from "../src/lib/data-lifecycle/file-erasure";
import { createWorkerHealthReporter } from "./lib/worker-health";

let healthReporter: ReturnType<typeof createWorkerHealthReporter> | undefined;

function integer(name: string, fallback: number, minimum: number, maximum: number) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name}_INVALID`);
  }
  return value;
}

function objectRoot() {
  const configured = process.env.OBJECT_STORAGE_PATH ?? "/var/lib/learncoding/objects";
  if (!path.isAbsolute(configured)) throw new Error("OBJECT_STORAGE_PATH_INVALID");
  return path.resolve(configured);
}

const once = process.argv.includes("--once");
const pollMs = integer("FILE_ERASURE_POLL_SECONDS", 10, 1, 300) * 1_000;
const batchSize = integer("FILE_ERASURE_BATCH_SIZE", 25, 1, 100);
const leaseMs = integer("FILE_ERASURE_LEASE_SECONDS", 300, 30, 900) * 1_000;

let stopping = false;
process.once("SIGTERM", () => { stopping = true; });
process.once("SIGINT", () => { stopping = true; });

function sleep(milliseconds: number) {
  return new Promise<void>((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      process.off("SIGTERM", finish);
      process.off("SIGINT", finish);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    process.once("SIGTERM", finish);
    process.once("SIGINT", finish);
  });
}

async function main() {
  const root = objectRoot();
  healthReporter = createWorkerHealthReporter({ worker: "file-erasure-worker" });
  console.info(JSON.stringify({ event: "storage.user_file_erasure_worker_started", mode: once ? "once" : "continuous" }));
  do {
    const startedAt = Date.now();
    try {
      const summary = await processUserFileErasures({
        objectStorageRoot: root,
        limit: batchSize,
        leaseMs,
      });
      console.info(JSON.stringify({
        event: "storage.user_file_erasure_batch",
        ...summary,
        durationMs: Date.now() - startedAt,
      }));
      if (summary.exhausted > 0) {
        console.error(JSON.stringify({
          event: "storage.user_file_erasure_backlog_exhausted",
          exhausted: summary.exhausted,
        }));
      }
      if (summary.failed > 0 || summary.exhausted > 0) {
        const error = new Error("FILE_ERASURE_BACKLOG_UNHEALTHY");
        error.name = "FileErasureBacklogUnhealthyError";
        throw error;
      }
      healthReporter.success();
      if (!once && summary.processed === 0 && !stopping) await sleep(pollMs);
    } catch (error) {
      healthReporter.retry(error);
      console.error(JSON.stringify({
        event: "storage.user_file_erasure_worker_error",
        code: error instanceof Error ? error.name : "UNKNOWN",
      }));
      if (once || healthReporter.consecutiveFailures > 2) throw error;
      if (!stopping) await sleep(pollMs);
    }
  } while (!once && !stopping);
  console.info(JSON.stringify({ event: "storage.user_file_erasure_worker_stopped" }));
}

main()
  .catch((error) => {
    healthReporter?.terminalFailure(error);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
