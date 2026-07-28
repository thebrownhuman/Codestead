import { scanRepositoryForMojibake } from "./lib/repository-encoding-scan";

const ROOT = process.cwd();

async function main() {
  const failures = await scanRepositoryForMojibake(ROOT);

  if (failures.length > 0) {
    console.error(`Mojibake/replacement characters found in ${failures.length} location(s):`);
    for (const failure of failures.slice(0, 100)) console.error(`- ${failure}`);
    if (failures.length > 100) console.error(`- …and ${failures.length - 100} more`);
    process.exitCode = 1;
  } else {
    console.log("Repository encoding scan passed: no common UTF-8 mojibake or replacement characters found.");
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Repository encoding scan failed.");
  process.exitCode = 1;
});
