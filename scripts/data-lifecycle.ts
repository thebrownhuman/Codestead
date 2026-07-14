import { backupExpiryReport } from "@/lib/data-lifecycle/deletion";
import {
  RETENTION_POLICY_VERSION,
} from "@/lib/data-lifecycle/policy";
import { runRetention } from "@/lib/data-lifecycle/retention";

function valueAfter(args: string[], flag: string) {
  const index = args.indexOf(flag);
  return index < 0 ? undefined : args[index + 1];
}

function usage(): never {
  throw new Error(
    "Usage:\n" +
    "  npm run lifecycle -- retention --dry-run [--idempotency-key KEY] [--batch-size N]\n" +
    `  npm run lifecycle -- retention --apply --confirm ${RETENTION_POLICY_VERSION} [--idempotency-key KEY] [--batch-size N]\n` +
    "  npm run lifecycle -- backup-expiry-report",
  );
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];
  if (command === "backup-expiry-report") {
    process.stdout.write(`${JSON.stringify(await backupExpiryReport(), null, 2)}\n`);
    return;
  }
  if (command !== "retention") usage();
  const dryRun = args.includes("--dry-run");
  const apply = args.includes("--apply");
  if (dryRun === apply) usage();
  if (apply && valueAfter(args, "--confirm") !== RETENTION_POLICY_VERSION) {
    throw new Error(`Apply requires --confirm ${RETENTION_POLICY_VERSION}.`);
  }
  const now = new Date();
  const mode = dryRun ? "dry-run" : "apply";
  const date = now.toISOString().slice(0, 10);
  const idempotencyKey = valueAfter(args, "--idempotency-key") ??
    `retention:${RETENTION_POLICY_VERSION}:${date}:${mode}`;
  const configuredBatch = valueAfter(args, "--batch-size");
  const report = await runRetention({
    idempotencyKey,
    dryRun,
    ...(configuredBatch ? { batchSize: Number(configuredBatch) } : {}),
    now,
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : "Data lifecycle command failed."}\n`);
  process.exitCode = 1;
});
