import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
const workflow = readFileSync(".github/workflows/ci.yml", "utf8");
const backupProjection = readFileSync(
  "infra/tests/backup-ci-registration.test.mjs",
  "utf8",
);

const command = "npm run test:mail-writer-inventory";
const exactPackageCommand = [
  "node --test infra/tests/mail-writer-inventory.test.mjs",
  "infra/tests/mail-writer-inventory-shell.test.mjs",
  "infra/tests/mail-writer-inventory-registration.test.mjs",
  "&& node infra/tests/mail-writer-inventory.mjs",
].join(" ");

function exactOccurrences(source, needle) {
  return source.split(needle).length - 1;
}

test("registers the complete mail writer inventory gate as an exact package command", () => {
  assert.equal(
    packageJson.scripts["test:mail-writer-inventory"],
    exactPackageCommand,
  );
  assert.equal(
    packageJson.scripts.check.split(` && ${command}`).length - 1,
    1,
    "the aggregate check must invoke the inventory exactly once",
  );
});

test("runs the mail writer inventory exactly once in the application CI job", () => {
  const applicationStart = workflow.indexOf("  application:");
  const nextJob = workflow.indexOf("\n  production-topology:", applicationStart);
  assert.notEqual(applicationStart, -1);
  assert.notEqual(nextJob, -1);
  const applicationJob = workflow.slice(applicationStart, nextJob);
  assert.equal(
    exactOccurrences(applicationJob, `      - run: ${command}`),
    1,
  );
  assert.equal(
    exactOccurrences(workflow, `      - run: ${command}`),
    1,
    "the guard must not be duplicated in a weaker or unrelated CI job",
  );
});

test("keeps the exact application-step projection synchronized", () => {
  assert.equal(
    exactOccurrences(backupProjection, `  "${command}",`),
    1,
  );
});
