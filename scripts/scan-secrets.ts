import { scanRepositoryForSecrets } from "./lib/repository-secret-scan";

const root = process.cwd();

async function main() {
  const findings = await scanRepositoryForSecrets(root);
  if (findings.length > 0) {
    for (const finding of findings) {
      // Deliberately report metadata only, never the matched secret.
      console.error(`${finding.path}:${finding.line} [${finding.detector}] possible secret`);
    }
    console.error(`Secret scan failed with ${findings.length} redacted finding(s).`);
    process.exitCode = 1;
  } else {
    console.log("Secret scan passed: no recognized plaintext credential canaries found.");
  }
}

void main().catch(() => {
  console.error("Secret scan could not complete.");
  process.exitCode = 1;
});
