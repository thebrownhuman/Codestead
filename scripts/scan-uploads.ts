import path from "node:path";

import { pool } from "../src/lib/db/client";
import { ClamdClient } from "../src/lib/storage/clamd-client";
import { PostgresUploadScanRepository } from "../src/lib/storage/scan-repository";
import { processScanBatch } from "../src/lib/storage/upload-scanner";

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
const pollMs = integer("UPLOAD_SCAN_POLL_SECONDS", 10, 1, 300) * 1_000;
const batchSize = integer("UPLOAD_SCAN_BATCH_SIZE", 10, 1, 100);
const leaseMs = integer("UPLOAD_SCAN_LEASE_SECONDS", 180, 30, 900) * 1_000;
const maxAttempts = integer("UPLOAD_SCAN_MAX_ATTEMPTS", 8, 1, 100);
const retryBaseMs = integer("UPLOAD_SCAN_RETRY_BASE_SECONDS", 5, 1, 3600) * 1_000;
const retryMaximumMs = integer("UPLOAD_SCAN_RETRY_MAX_SECONDS", 900, 1, 86_400) * 1_000;
const clamdPort = integer("CLAMD_PORT", 3310, 1, 65_535);
const clamdTimeoutMs = integer("CLAMD_TIMEOUT_SECONDS", 120, 5, 600) * 1_000;
if (leaseMs <= clamdTimeoutMs + 10_000) throw new Error("UPLOAD_SCAN_LEASE_TOO_SHORT");
if (retryMaximumMs < retryBaseMs) throw new Error("UPLOAD_SCAN_RETRY_RANGE_INVALID");

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
  const repository = new PostgresUploadScanRepository();
  const scanner = new ClamdClient({
    host: process.env.CLAMD_HOST ?? "clamav",
    port: clamdPort,
    timeoutMs: clamdTimeoutMs,
  });

  console.info(JSON.stringify({ event: "upload.scanner_started", mode: once ? "once" : "continuous" }));
  do {
    const startedAt = Date.now();
    try {
      const summary = await processScanBatch({
        repository,
        scanner,
        root,
        batchSize,
        leaseMs,
        maxAttempts,
        retryBaseMs,
        retryMaximumMs,
      });
      console.info(JSON.stringify({
        event: "upload.scan_batch",
        ...summary,
        durationMs: Date.now() - startedAt,
      }));
      if (!once && summary.claimed === 0 && !stopping) await sleep(pollMs);
    } catch (error) {
      console.error(JSON.stringify({
        event: "upload.scan_worker_error",
        code: error instanceof Error ? "WORKER_CYCLE_FAILED" : "UNKNOWN",
      }));
      if (once) throw error;
      if (!stopping) await sleep(pollMs);
    }
  } while (!once && !stopping);
  console.info(JSON.stringify({ event: "upload.scanner_stopped" }));
}

main()
  .catch(() => { process.exitCode = 1; })
  .finally(() => pool.end());
