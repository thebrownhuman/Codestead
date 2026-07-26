import assert from "node:assert/strict";

const postgresCiProjectionExtensionBrand = Symbol(
  "postgres-ci-projection-extension",
);

const postgresCiProjectionContractBrand = Symbol(
  "postgres-ci-projection-contract",
);

export const postgresCiRuntimePolicy = Object.freeze({
  runner: "ubuntu-24.04",
  baselineTimeoutMinutes: 20,
  maximumTimeoutMinutes: 35,
  livePg17IntegrationCommand: "npm run test:integration",
  installCommand:
    "sudo apt-get install --yes --no-install-recommends postgresql-17 postgresql-18",
  dockerPg17Image:
    "postgres:17-bookworm@sha256:4f736ae292687621d4be0d499ffd024a36bd2ee7d8ca6f2ccd4c800f047b394",
  dockerPg17IntegrationCommand:
    "CODESTEAD_DISPOSABLE_HOST=1 bash infra/tests/database-least-privilege-integration.sh",
  productionMajor: 17,
  targetedMajor: 18,
});

function freezeScriptList(values) {
  return Object.freeze([...values]);
}

function validateScriptList(values, label, { registration }) {
  assert.ok(Array.isArray(values), `${label} must be an array`);
  const scripts = values.map((value, index) => {
    assert.equal(typeof value, "string", `${label}[${index}] must be a string`);
    assert.match(
      value,
      /^test:[a-z0-9][a-z0-9:-]*$/u,
      `${label}[${index}] must be an npm test script name`,
    );
    if (registration) {
      assert.match(
        value,
        /:registration$/u,
        `${label}[${index}] must be a registration script`,
      );
    } else {
      assert.doesNotMatch(
        value,
        /:registration$/u,
        `${label}[${index}] must be a live harness script`,
      );
    }
    return value;
  });
  assert.equal(
    new Set(scripts).size,
    scripts.length,
    `${label} must not contain duplicates`,
  );
  return freezeScriptList(scripts);
}

function freezePostgresCiProjectionContract({
  registrationScripts,
  productionPg17Scripts,
  targetedPg18Scripts,
  extensionIds,
  timeoutMinutes,
  restoreExtensionId,
}) {
  return Object.freeze({
    [postgresCiProjectionContractBrand]: true,
    registrationScripts: freezeScriptList(registrationScripts),
    productionPg17Scripts: freezeScriptList(productionPg17Scripts),
    targetedPg18Scripts: freezeScriptList(targetedPg18Scripts),
    extensionIds: freezeScriptList(extensionIds),
    timeoutMinutes,
    restoreExtensionId,
  });
}

function appendUnique(target, additions, label) {
  for (const addition of additions) {
    assert.ok(
      !target.includes(addition),
      `duplicate PostgreSQL CI ${label}: ${addition}`,
    );
    target.push(addition);
  }
}

export function definePostgresCiProjectionExtension({
  id,
  registrationScripts = [],
  productionPg17Scripts = [],
  targetedPg18Scripts = [],
  minimumTimeoutMinutes = null,
  kind = "gate",
}) {
  assert.equal(typeof id, "string", "extension id must be a string");
  assert.match(
    id,
    /^[a-z0-9][a-z0-9-]*$/u,
    "extension id must be a lowercase kebab-case identifier",
  );
  assert.ok(
    kind === "gate" || kind === "restore",
    `${id}.kind must be "gate" or "restore"`,
  );
  assert.ok(
    minimumTimeoutMinutes === null || Number.isInteger(minimumTimeoutMinutes),
    `${id}.minimumTimeoutMinutes must be an integer or null`,
  );
  if (kind === "restore") {
    assert.equal(
      minimumTimeoutMinutes,
      postgresCiRuntimePolicy.maximumTimeoutMinutes,
      "the dedicated restore extension must set the PostgreSQL CI timeout to exactly 35",
    );
  } else {
    assert.ok(
      minimumTimeoutMinutes === null ||
        minimumTimeoutMinutes ===
          postgresCiRuntimePolicy.baselineTimeoutMinutes,
      "only the dedicated restore extension may raise the PostgreSQL CI timeout",
    );
  }
  return Object.freeze({
    [postgresCiProjectionExtensionBrand]: true,
    id,
    kind,
    registrationScripts: validateScriptList(
      registrationScripts,
      `${id}.registrationScripts`,
      { registration: true },
    ),
    productionPg17Scripts: validateScriptList(
      productionPg17Scripts,
      `${id}.productionPg17Scripts`,
      { registration: false },
    ),
    targetedPg18Scripts: validateScriptList(
      targetedPg18Scripts,
      `${id}.targetedPg18Scripts`,
      { registration: false },
    ),
    minimumTimeoutMinutes,
  });
}

export const canonicalPostgresCiProjectionContract =
  freezePostgresCiProjectionContract({
    registrationScripts: [
      "test:mail-delivery-scope-0059:registration",
      "test:mail-payload-immutability-0060:registration",
      "test:mail-retention-redaction-0063:registration",
    ],
    productionPg17Scripts: ["test:mail-retention-redaction-0063"],
    targetedPg18Scripts: [
      "test:mail-delivery-scope-0059",
      "test:mail-payload-immutability-0060",
      "test:mail-retention-redaction-0063",
    ],
    extensionIds: [],
    timeoutMinutes: postgresCiRuntimePolicy.baselineTimeoutMinutes,
    restoreExtensionId: null,
  });

export function composeCanonicalPostgresCiProjectionContract(...extensions) {
  const registrationScripts = [
    ...canonicalPostgresCiProjectionContract.registrationScripts,
  ];
  const productionPg17Scripts = [
    ...canonicalPostgresCiProjectionContract.productionPg17Scripts,
  ];
  const targetedPg18Scripts = [
    ...canonicalPostgresCiProjectionContract.targetedPg18Scripts,
  ];
  const extensionIds = new Set();
  let timeoutMinutes = canonicalPostgresCiProjectionContract.timeoutMinutes;
  let restoreExtensionId = null;

  for (const extension of extensions) {
    assert.equal(
      extension?.[postgresCiProjectionExtensionBrand],
      true,
      "extensions must be created by definePostgresCiProjectionExtension",
    );
    assert.ok(
      !extensionIds.has(extension.id),
      `duplicate PostgreSQL CI extension id: ${extension.id}`,
    );
    extensionIds.add(extension.id);
    if (extension.kind === "restore") {
      assert.equal(
        restoreExtensionId,
        null,
        "the PostgreSQL CI contract may contain only one restore extension",
      );
      restoreExtensionId = extension.id;
    }
    if (extension.minimumTimeoutMinutes !== null) {
      timeoutMinutes = Math.max(
        timeoutMinutes,
        extension.minimumTimeoutMinutes,
      );
    }
    appendUnique(
      registrationScripts,
      extension.registrationScripts,
      "registration script",
    );
    appendUnique(
      productionPg17Scripts,
      extension.productionPg17Scripts,
      "PostgreSQL 17 script",
    );
    appendUnique(
      targetedPg18Scripts,
      extension.targetedPg18Scripts,
      "PostgreSQL 18 script",
    );
  }

  return freezePostgresCiProjectionContract({
    registrationScripts,
    productionPg17Scripts,
    targetedPg18Scripts,
    extensionIds: [...extensionIds],
    timeoutMinutes,
    restoreExtensionId,
  });
}

function assertCanonicalContract(contract) {
  assert.equal(
    contract?.[postgresCiProjectionContractBrand],
    true,
    "the projection contract must come from the canonical composer",
  );
}

export function projectPostgresCiProjectionContract(
  contract = canonicalPostgresCiProjectionContract,
) {
  assertCanonicalContract(contract);
  const {
    runner,
    livePg17IntegrationCommand,
    dockerPg17Image,
    dockerPg17IntegrationCommand,
    installCommand,
    productionMajor,
    targetedMajor,
  } = postgresCiRuntimePolicy;
  const runtimeLine = (major, script) =>
    `      - run: POSTGRES_${major}_BIN=/usr/lib/postgresql/${major}/bin npm run ${script}`;

  return Object.freeze({
    runnerLine: `    runs-on: ${runner}`,
    timeoutLine: `    timeout-minutes: ${contract.timeoutMinutes}`,
    registrationLines: freezeScriptList(
      contract.registrationScripts.map(
        (script) => `      - run: npm run ${script}`,
      ),
    ),
    livePg17IntegrationLine:
      `      - run: ${livePg17IntegrationCommand}`,
    dockerPg17PullLine: `      - run: docker pull ${dockerPg17Image}`,
    dockerPg17IntegrationLine: `      - run: ${dockerPg17IntegrationCommand}`,
    installLine: `          ${installCommand}`,
    productionPg17Lines: freezeScriptList(
      contract.productionPg17Scripts.map((script) =>
        runtimeLine(productionMajor, script),
      ),
    ),
    targetedPg18Lines: freezeScriptList(
      contract.targetedPg18Scripts.map((script) =>
        runtimeLine(targetedMajor, script),
      ),
    ),
  });
}

function extractRegistrationEntries(postgresProjection) {
  return [
    ...postgresProjection.matchAll(
      /^      - run: npm run (test:[a-z0-9][a-z0-9:-]*:registration)$/gmu,
    ),
  ].map((match) => ({
    script: match[1],
    index: match.index,
  }));
}

function extractRuntimeEntries(postgresProjection) {
  return [
    ...postgresProjection.matchAll(
      /^      - run: POSTGRES_(\d+)_BIN=\/usr\/lib\/postgresql\/(\d+)\/bin npm run (test:[a-z0-9][a-z0-9:-]*)$/gmu,
    ),
  ].map((match) => ({
    environmentMajor: Number.parseInt(match[1], 10),
    binaryMajor: Number.parseInt(match[2], 10),
    script: match[3],
    index: match.index,
  }));
}

function assertExactCiScriptList(
  actual,
  expected,
  message,
  { allowReviewedSuffix },
) {
  assert.equal(
    new Set(actual).size,
    actual.length,
    `${message}: scripts must not be duplicated`,
  );
  if (!allowReviewedSuffix) {
    assert.deepEqual(actual, expected, message);
    return;
  }
  assert.ok(
    actual.length >= expected.length,
    `${message}: the historical prefix must not be truncated`,
  );
  assert.deepEqual(
    actual.slice(0, expected.length),
    expected,
    `${message}: the historical prefix must remain exact and ordered`,
  );
  const expectedVersions = expected.map((script) => {
    const match = script.match(/-(\d{4})(?::|$)/u);
    assert.ok(match, `${message}: historical script has no migration version`);
    return Number.parseInt(match[1], 10);
  });
  let lastVersion = Math.max(...expectedVersions);
  for (const script of actual.slice(expected.length)) {
    const match = script.match(/-(\d{4})(?::|$)/u);
    assert.ok(match, `${message}: suffix script has no migration version`);
    const version = Number.parseInt(match[1], 10);
    assert.ok(
      version > lastVersion,
      `${message}: suffix migrations must be strictly later and ordered`,
    );
    lastVersion = version;
  }
}
function assertCanonicalPostgresInstallAndRuntimeMajors(
  postgresProjection,
  contract,
  { allowReviewedSuffix },
) {
  const { productionMajor, targetedMajor } = postgresCiRuntimePolicy;
  const expected = projectPostgresCiProjectionContract(contract);
  const livePg17IntegrationLines =
    postgresProjection.match(
      /^      - run: npm run test:integration$/gmu,
    ) ?? [];
  assert.deepEqual(
    livePg17IntegrationLines,
    [expected.livePg17IntegrationLine],
    "the live PostgreSQL 17 integration gate must appear exactly once",
  );
  const dockerPostgresPullLines =
    postgresProjection.match(/^      - run: docker pull postgres:\S+$/gmu) ??
    [];
  assert.deepEqual(
    dockerPostgresPullLines,
    [expected.dockerPg17PullLine],
    "the pinned Docker PostgreSQL 17 integration image must appear exactly once",
  );
  const dockerPg17IntegrationLines =
    postgresProjection.match(
      /^      - run: CODESTEAD_DISPOSABLE_HOST=1 bash infra\/tests\/database-least-privilege-integration\.sh$/gmu,
    ) ?? [];
  assert.deepEqual(
    dockerPg17IntegrationLines,
    [expected.dockerPg17IntegrationLine],
    "the disposable Docker PostgreSQL 17 integration gate must appear exactly once",
  );
  assert.doesNotMatch(
    postgresProjection,
    /(?:postgresql-16|POSTGRES_16_BIN|\/postgresql\/16\/bin|\bpostgres:16(?!\d))/iu,
    "PostgreSQL 16 must not appear in the canonical CI matrix",
  );

  const installLines =
    postgresProjection.match(
      /^          sudo apt-get install --yes --no-install-recommends postgresql-\d+(?: postgresql-\d+)*$/gmu,
    ) ?? [];
  assert.deepEqual(
    installLines,
    [expected.installLine],
    "the canonical install must contain exactly PostgreSQL 17 and PostgreSQL 18 once",
  );
  const liveIntegrationIndex = postgresProjection.indexOf(
    expected.livePg17IntegrationLine,
  );
  const dockerPullIndex = postgresProjection.indexOf(
    expected.dockerPg17PullLine,
  );
  const dockerIntegrationIndex = postgresProjection.indexOf(
    expected.dockerPg17IntegrationLine,
  );
  const installIndex = postgresProjection.indexOf(expected.installLine);
  assert.ok(
    liveIntegrationIndex >= 0 && dockerPullIndex > liveIntegrationIndex,
    "the live PostgreSQL 17 integration gate must precede the pinned Docker PostgreSQL 17 pull",
  );
  assert.ok(
    dockerPullIndex >= 0 && dockerIntegrationIndex > dockerPullIndex,
    "the Docker PostgreSQL 17 pull must precede its integration gate",
  );
  assert.ok(
    installIndex > dockerIntegrationIndex,
    "the Docker PostgreSQL 17 integration gate must precede the PostgreSQL runtime installation",
  );

  const runtimeEntries = extractRuntimeEntries(postgresProjection);
  for (const entry of runtimeEntries) {
    assert.equal(
      entry.environmentMajor,
      entry.binaryMajor,
      "PostgreSQL runtime major must match its binary directory major",
    );
    assert.ok(
      entry.environmentMajor === productionMajor ||
        entry.environmentMajor === targetedMajor,
      `unsupported PostgreSQL runtime major: ${entry.environmentMajor}`,
    );
  }

  const productionEntries = runtimeEntries.filter(
    (entry) => entry.environmentMajor === productionMajor,
  );
  const targetedEntries = runtimeEntries.filter(
    (entry) => entry.environmentMajor === targetedMajor,
  );
  assertExactCiScriptList(
    productionEntries.map((entry) => entry.script),
    contract.productionPg17Scripts,
    "PostgreSQL 17 scripts must match the exact composed contract",
    { allowReviewedSuffix },
  );
  assertExactCiScriptList(
    targetedEntries.map((entry) => entry.script),
    contract.targetedPg18Scripts,
    "PostgreSQL 18 scripts must match the exact composed contract",
    { allowReviewedSuffix },
  );

  const firstProductionIndex = productionEntries.at(0)?.index ?? -1;
  const lastProductionIndex = productionEntries.at(-1)?.index ?? -1;
  const firstTargetedIndex = targetedEntries.at(0)?.index ?? -1;
  assert.ok(
    firstProductionIndex > installIndex,
    "PostgreSQL 17 harnesses must run after the canonical installation",
  );
  assert.ok(
    firstTargetedIndex > lastProductionIndex,
    "PostgreSQL 17 harnesses must run before PostgreSQL 18 harnesses",
  );
  assert.doesNotMatch(
    postgresProjection.slice(firstProductionIndex, firstTargetedIndex),
    /(?:&|parallel|concurrently)\s+/iu,
    "PostgreSQL 17 and PostgreSQL 18 harnesses must remain sequential",
  );
}

export function assertPostgresCiProjectionContract(
  postgresProjection,
  contract = canonicalPostgresCiProjectionContract,
  { allowReviewedSuffix = false } = {},
) {
  assert.equal(typeof allowReviewedSuffix, "boolean");
  const expected = projectPostgresCiProjectionContract(contract);
  assert.deepEqual(
    postgresProjection.match(/^    runs-on: .+$/gmu) ?? [],
    [expected.runnerLine],
    "the PostgreSQL CI runner must match the canonical policy",
  );
  assert.deepEqual(
    postgresProjection.match(/^    timeout-minutes: \d+$/gmu) ?? [],
    [expected.timeoutLine],
    "timeout-minutes must match the single canonical PostgreSQL CI policy",
  );
  assert.doesNotMatch(
    postgresProjection,
    /^    (?:if|needs):/mu,
    "the PostgreSQL integration job must remain an unconditional independent gate",
  );
  assert.doesNotMatch(
    postgresProjection,
    /continue-on-error:/u,
    "the PostgreSQL integration job must never become advisory",
  );

  const registrationEntries = extractRegistrationEntries(postgresProjection);
  assertExactCiScriptList(
    registrationEntries.map((entry) => entry.script),
    contract.registrationScripts,
    "PostgreSQL CI registration scripts must match the exact composed contract",
    { allowReviewedSuffix },
  );

  assertCanonicalPostgresInstallAndRuntimeMajors(
    postgresProjection,
    contract,
    { allowReviewedSuffix },
  );

  const installIndex = postgresProjection.indexOf(expected.installLine);
  const lastRegistrationIndex = registrationEntries.at(-1)?.index ?? -1;
  assert.ok(
    lastRegistrationIndex >= 0 && installIndex > lastRegistrationIndex,
    "all PostgreSQL registration scripts must run before installation",
  );
}

export const mailRetentionRedaction0063CiContract = Object.freeze({
  registrationScript: "test:mail-retention-redaction-0063:registration",
  harnessScript: "test:mail-retention-redaction-0063",
  registrationCommand:
    "node infra/tests/mail-retention-redaction-0063-registration.test.mjs",
  harnessCommand:
    "node infra/tests/mail-retention-redaction-0063.integration.mjs",
  pg17Command:
    "POSTGRES_17_BIN=/usr/lib/postgresql/17/bin npm run test:mail-retention-redaction-0063",
  pg18Command:
    "POSTGRES_18_BIN=/usr/lib/postgresql/18/bin npm run test:mail-retention-redaction-0063",
});
