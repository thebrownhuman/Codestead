import { verifyEvidenceIntegrity } from "./lib/evidence-integrity";

async function main() {
  const report = await verifyEvidenceIntegrity({ root: process.cwd() });
  if (report.issues.length) {
    for (const issue of report.issues) {
      console.error(`${issue.kind} ${issue.source}: ${issue.detail}`);
    }
    console.error(
      `Evidence integrity failed: ${report.issues.length} issue(s); ` +
      `${report.markdown.links} Markdown links and ${report.evidence.hashes} declared hashes checked.`,
    );
    process.exit(1);
  }
  console.log(
    `Evidence integrity verified: ${report.markdown.files} Markdown files, ${report.markdown.links} local links, ` +
    `${report.evidence.files} evidence JSON files, ${report.evidence.paths} referenced paths, ` +
    `${report.evidence.hashes} declared hashes.`,
  );
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
