import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  REVIEWED_MIGRATION_LEDGER,
  REVIEWED_MIGRATION_LEDGER_SHA256,
  reviewedMigrationLedgerSha256,
} from "./lib/reviewed-migration-ledger.mjs";

// Rebind an operator-reviewed correction to the latest migration only.
// Never rewrite historical SQL hashes or register new ledger entries here.
const apply = process.argv.includes("--apply");
if (!apply && !process.argv.includes("--check")) throw new Error("Use --apply or --check");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => readFile(path.join(root, file), "utf8");
const digest = (value) => createHash("sha256").update(value.replaceAll("\r\n", "\n")).digest("hex");
const entries = REVIEWED_MIGRATION_LEDGER.map((entry) => ({ ...entry }));
for (const entry of entries) {
  const actual = digest(await read(`drizzle/${entry.tag}.sql`));
  if (entry.idx !== entries.at(-1).idx && actual !== entry.sqlSha256) {
    throw new Error("Historical migration changed; reviewed replay is required");
  }
  entry.sqlSha256 = actual;
}
const tail = entries.at(-1);
const ledgerDigest = reviewedMigrationLedgerSha256(entries);
const file = "scripts/lib/reviewed-migration-ledger.mjs";
let source = await read(file);
const pattern = new RegExp(`((?:"tag"|tag)\\s*:\\s*"${tail.tag}",\\s*(?:"breakpoints"|breakpoints)\\s*:\\s*(?:true|false),\\s*(?:"sqlSha256"|sqlSha256)\\s*:\\s*)"[a-f0-9]{64}"`);
if (!pattern.test(source)) throw new Error("Latest reviewed migration entry is unavailable");
source = source.replace(pattern, `$1"${tail.sqlSha256}"`).replaceAll(REVIEWED_MIGRATION_LEDGER_SHA256, ledgerDigest);
const projections = ["scripts/backup/common.sh", "infra/tests/recovery-evidence-verifier.test.sh", "infra/tests/restore-drill-reminder.test.sh", "docs/reviewed-migration-inventory-pins.md"];
let changed = false;
async function output(target, next) {
  if ((await read(target)) === next) return;
  changed = true;
  if (apply) await writeFile(path.join(root, target), next);
  else console.error(`Stale reviewed migration hash: ${target}`);
}
await output(file, source);
for (const projection of projections) {
  await output(projection, (await read(projection)).replaceAll(REVIEWED_MIGRATION_LEDGER_SHA256, ledgerDigest));
}
if (!apply && changed) process.exitCode = 1;
