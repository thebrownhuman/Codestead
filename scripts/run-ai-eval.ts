import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  evaluateOfflineGoldenSuite,
  loadOfflineGoldenSuite,
} from "../src/lib/ai/evaluation/offline-gate";

function argumentValue(name: string) {
  const prefix = `${name}=`;
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
}

function validDate(value: string) {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== value
  ) {
    throw new Error("Evaluation date must use YYYY-MM-DD.");
  }
  return value;
}

async function main() {
  const checkOnly = process.argv.includes("--check");
  const evaluationDate = validDate(argumentValue("--date") ?? new Date().toISOString().slice(0, 10));
  const suite = await loadOfflineGoldenSuite(argumentValue("--fixture"));
  const report = evaluateOfflineGoldenSuite(suite, evaluationDate);
  const output = path.resolve(
    argumentValue("--output") ??
      path.join("docs", "evidence", `ai-eval-offline-${evaluationDate}.json`),
  );

  if (!checkOnly) {
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }

  const { cases, checks } = report.summary;
  console.log(
    `AI-007 offline contract eval ${report.summary.verdict}: ${cases.passed}/${cases.total} cases and ${checks.passed}/${checks.total} checks passed; 0 external provider calls; production model quality evidence=false${checkOnly ? "." : `; report=${path.relative(process.cwd(), output)}.`}`,
  );
  if (report.summary.verdict !== "pass") process.exitCode = 1;
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Offline AI evaluation failed.");
  process.exitCode = 1;
});
