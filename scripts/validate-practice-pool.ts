import path from "node:path";

import { loadBanksFrom, PRACTICE_BANKS_DIRECTORY } from "../src/lib/practice-quiz/load";
import { validatePracticePools } from "../src/lib/practice-quiz/pool";

const contentDir = path.resolve(process.cwd(), "content");

async function main(): Promise<void> {
  const [examBanks, practiceBanks] = await Promise.all([
    loadBanksFrom(contentDir, "authored/assessment-banks"),
    loadBanksFrom(contentDir, PRACTICE_BANKS_DIRECTORY),
  ]);
  const issues = validatePracticePools({ examBanks, practiceBanks });
  if (issues.length > 0) {
    for (const issue of issues) console.error(issue);
    console.error(`Practice pool check failed with ${issues.length} issue(s).`);
    process.exitCode = 1;
    return;
  }
  const itemCount = practiceBanks.reduce((total, bank) => total + bank.items.length, 0);
  console.log(`Practice pool OK: ${itemCount} practice item(s), disjoint from ${examBanks.length} exam bank(s).`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
