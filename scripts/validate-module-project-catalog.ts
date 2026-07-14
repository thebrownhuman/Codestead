import path from "node:path";

import { FileSystemContentLoader } from "../src/lib/content/loader";
import {
  buildModuleProjectCatalog,
  validateModuleProjectCatalog,
} from "../src/lib/projects/module-project-catalog";

async function main() {
  const snapshot = await new FileSystemContentLoader({
    contentRoot: path.join(process.cwd(), "content"),
  }).loadSnapshot();
  const report = validateModuleProjectCatalog(snapshot, buildModuleProjectCatalog(snapshot));
  console.log(
    `Module project catalog valid: ${report.templateCount} required-module briefs across ${report.courseCount} launch courses.`,
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Module project catalog validation failed.");
  process.exitCode = 1;
});
