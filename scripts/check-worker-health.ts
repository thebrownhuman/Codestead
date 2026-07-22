import { checkWorkerHealthFile } from "./lib/worker-health";

function boundedInteger(name: string, minimum: number, maximum: number) {
  const raw = process.env[name];
  if (!raw || !/^[1-9][0-9]*$/.test(raw)) throw new Error(`${name}_INVALID`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name}_INVALID`);
  }
  return value;
}

async function main() {
  if (process.argv.length !== 2) throw new Error("WORKER_HEALTH_ARGUMENTS_INVALID");
  const expectedWorker = process.env.WORKER_HEALTH_ID;
  if (!expectedWorker) throw new Error("WORKER_HEALTH_ID_MISSING");
  const maxAgeSeconds = boundedInteger("WORKER_HEALTH_MAX_AGE_SECONDS", 5, 3_600);
  const maxFailures = boundedInteger("WORKER_HEALTH_MAX_FAILURES", 1, 10);
  await checkWorkerHealthFile({
    path: "/tmp/codestead-worker-health/status.json",
    expectedWorker,
    maxAgeMs: maxAgeSeconds * 1_000,
    maxConsecutiveFailures: maxFailures,
  });
}

main().catch(() => {
  console.error("worker health check failed");
  process.exitCode = 1;
});
