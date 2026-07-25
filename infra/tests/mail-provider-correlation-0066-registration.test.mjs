#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (relativePath) =>
  readFileSync(new URL(`../../${relativePath}`, import.meta.url), "utf8");

const packageManifest = JSON.parse(read("package.json"));
const workflow = read(".github/workflows/ci.yml");
const harness = read("infra/tests/mail-provider-correlation-0066.integration.mjs");
const scripts = packageManifest.scripts;
const registrationScript =
  "test:mail-provider-correlation-0066:registration";
const roleContractScript = "test:mail-provider-correlation-0066:roles";
const pg17Script = "test:mail-provider-correlation-0066:pg17";
const pg18Script = "test:mail-provider-correlation-0066:pg18";
const registrationCommand =
  "node infra/tests/mail-provider-correlation-0066-registration.test.mjs";
const roleContractCommand =
  "node --test infra/tests/mail-provider-correlation-0066-role-contract.test.mjs";
const harnessCommand =
  "node infra/tests/mail-provider-correlation-0066.integration.mjs";

assert.equal(scripts[registrationScript], registrationCommand);
assert.equal(scripts[roleContractScript], roleContractCommand);
assert.equal(scripts[pg17Script], harnessCommand);
assert.equal(scripts[pg18Script], harnessCommand);

const checkCommands = scripts.check.split(" && ");
for (const script of [registrationScript, roleContractScript]) {
  assert.equal(
    checkCommands.filter((command) => command === `npm run ${script}`).length,
    1,
    `npm run check must execute ${script} exactly once`,
  );
}

const postgresJob = workflow.match(
  /^  postgres-integration:\n([\s\S]*?)(?=^  [a-z][a-z0-9-]*:\n|(?![\s\S]))/mu,
)?.[0] ?? "";
const registrationLine = `      - run: npm run ${registrationScript}`;
const roleLine = `      - run: npm run ${roleContractScript}`;
const pg17Line =
  `      - run: POSTGRES_17_BIN=/usr/lib/postgresql/17/bin npm run ${pg17Script}`;
const pg18Line =
  `      - run: POSTGRES_18_BIN=/usr/lib/postgresql/18/bin npm run ${pg18Script}`;
for (const line of [registrationLine, roleLine, pg17Line, pg18Line]) {
  assert.equal(
    postgresJob.split(line).length,
    2,
    `PostgreSQL CI must execute exactly one step: ${line.trim()}`,
  );
}

const registration0065Index = postgresJob.indexOf(
  "      - run: npm run test:backup-status-mail-authority-0065:registration",
);
const registration0066Index = postgresJob.indexOf(registrationLine);
const role0064Index = postgresJob.indexOf(
  "      - run: npm run test:mail-dispatch-binding-0064:roles",
);
const role0066Index = postgresJob.indexOf(roleLine);
const liveIntegrationIndex = postgresJob.indexOf(
  "      - run: npm run test:integration",
);
const pg17BackupIndex = postgresJob.indexOf(
  "      - run: POSTGRES_17_BIN=/usr/lib/postgresql/17/bin npm run test:backup-status-mail-authority-0065",
);
const pg17Index = postgresJob.indexOf(pg17Line);
const pg18BackupIndex = postgresJob.indexOf(
  "      - run: POSTGRES_18_BIN=/usr/lib/postgresql/18/bin npm run test:backup-status-mail-authority-0065",
);
const pg18Index = postgresJob.indexOf(pg18Line);
assert.ok(registration0066Index > registration0065Index);
assert.ok(role0064Index > registration0066Index);
assert.ok(role0066Index > role0064Index);
assert.ok(liveIntegrationIndex > role0066Index);
assert.ok(pg17Index > pg17BackupIndex);
assert.ok(pg18Index > pg18BackupIndex);
assert.ok(pg18Index > pg17Index);

assert.match(harness, /POSTGRES_17_BIN/u);
assert.match(harness, /POSTGRES_18_BIN/u);
assert.match(harness, /mkdirSync\(socketDirectory\)/u);
assert.match(
  harness,
  /const socketOption =\s*process\.platform === "win32"\s*\?\s*""\s*:\s*` -k "\$\{socketDirectory\}"`;/u,
);
assert.doesNotMatch(
  harness,
  /(?:POSTGRES_16_BIN|postgresql-16|\/postgresql\/16\/bin)/u,
);

console.log("mail-provider-correlation-0066-registration-tests-ok");
