import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { parseAssessmentBank, type AssessmentBank } from "@/lib/content";

export const PRACTICE_BANKS_DIRECTORY = "authored/practice-banks";

export async function loadBanksFrom(contentDir: string, directory: string): Promise<readonly AssessmentBank[]> {
  const absolute = path.join(contentDir, directory);
  const files = (await readdir(absolute)).filter((file) => file.endsWith(".json")).sort();
  return Promise.all(files.map(async (file) => {
    const relative = `${directory}/${file}`;
    return parseAssessmentBank(JSON.parse(await readFile(path.join(absolute, file), "utf8")), relative);
  }));
}
