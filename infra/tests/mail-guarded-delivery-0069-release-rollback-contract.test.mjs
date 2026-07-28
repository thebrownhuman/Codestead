import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const release = readFileSync(
  path.join(repoRoot, "infra/ops/release-production.sh"),
  "utf8",
);
const rollback = readFileSync(
  path.join(repoRoot, "infra/ops/rollback-production.sh"),
  "utf8",
);
const releaseTest = readFileSync(
  path.join(repoRoot, "infra/tests/release-production.test.sh"),
  "utf8",
);
const rollbackTest = readFileSync(
  path.join(repoRoot, "infra/tests/rollback-production.test.sh"),
  "utf8",
);
const rollbackRunbook = readFileSync(
  path.join(repoRoot, "docs/runbooks/updates-and-rollback.md"),
  "utf8",
);
const recoveryEvidence = readFileSync(
  path.join(repoRoot, "infra/ops/recovery-evidence.py"),
  "utf8",
);
const recoveryEvidenceTest = readFileSync(
  path.join(repoRoot, "infra/tests/recovery-evidence-provenance.test.py"),
  "utf8",
);
const ciWorkflow = readFileSync(
  path.join(repoRoot, ".github/workflows/ci.yml"),
  "utf8",
);
const updateRunbook = readFileSync(
  path.join(repoRoot, "docs/runbooks/updates-and-rollback.md"),
  "utf8",
);
const deploymentGuide = readFileSync(
  path.join(repoRoot, "docs/deployment.md"),
  "utf8",
);
const capabilityPath =
  "infra/ops/mail-outbox-guarded-delivery-capability.env";
const capabilityAbsolutePath = path.join(repoRoot, capabilityPath);
const boundaryCommit = "7eeafd73c5d41ea49526d908165e0a7cefa92097";
const guardedDeliveryMigrations = [
  {
    path: "drizzle/0068_mail_outbox_quarantine_redaction_authority_v2.sql",
    mode: "100644",
    blob: "1188c910c5f89c902110349a1fc7564c6c9b1bfd",
    prefix: "mail_outbox_quarantine_redaction_migration",
  },
  {
    path: "drizzle/0069_mail_outbox_guarded_delivery_authority.sql",
    mode: "100644",
    blob: "a957b7b13445fee8174677c69e7cedb542d74eee",
    prefix: "mail_outbox_guarded_delivery_migration",
  },
];
const runtime =
  "guarded-prepared-dispatch-tx1-tx2-exact-byte-v1";
const authority =
  "append-only-task7-release-receipt-v1";
const privilege =
  "owner-app-worker-release-receipt-least-privilege-v1";
const expectedCapability = [
  "SCHEMA_VERSION=1",
  "OUTBOX_WORKER_MODE=fenced-postgres-v1",
  `GUARDED_DELIVERY_RUNTIME=${runtime}`,
  `DELIVERY_RELEASE_AUTHORITY=${authority}`,
  `GUARDED_DELIVERY_PRIVILEGE=${privilege}`,
  "",
].join("\n");

const shellArray = (source, name) => {
  const match = new RegExp(
    String.raw`(?:readonly|local) -a ${name}=\(\r?\n([\s\S]*?)\r?\n\s*\)`,
    "u",
  ).exec(source);
  assert.ok(match, `${name} is missing`);
  return match[1]
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
};
const pythonTuple = (source, name) => {
  const match = new RegExp(
    String.raw`${name}(?:: Final)? = \(\r?\n([\s\S]*?)\r?\n\)`,
    "u",
  ).exec(source);
  assert.ok(match, `${name} is missing`);
  return match[1]
    .split(/\r?\n/u)
    .map((line) => /^\s*"([^"]+)",\s*$/u.exec(line)?.[1])
    .filter(Boolean);
};


test("release and rollback share the complete reviewed runtime inventories", () => {
  const restorable = [
    "app",
    "runner-egress-gateway",
    "mail-worker",
    "reward-worker",
    "regrade-worker",
    "exam-finalization-worker",
    "file-erasure-worker",
    "practice-runner-recovery-worker",
    "project-review-correction-worker",
    "cloudflared",
  ];
  const managed = [
    "app",
    "cloudflared",
    "exam-finalization-worker",
    "file-erasure-worker",
    "mail-worker",
    "postgres",
    "practice-runner-recovery-worker",
    "project-review-correction-worker",
    "regrade-worker",
    "reward-worker",
    "runner-egress-gateway",
  ];
  const internalStart = [
    "app",
    "mail-worker",
    "reward-worker",
    "regrade-worker",
    "exam-finalization-worker",
    "file-erasure-worker",
    "practice-runner-recovery-worker",
    "project-review-correction-worker",
    "runner-egress-gateway",
  ];

  assert.deepEqual(
    shellArray(release, "restorable_runtime_services"),
    restorable,
  );
  assert.deepEqual(shellArray(rollback, "restorable_services"), restorable);
  assert.deepEqual(shellArray(release, "managed_runtime_services"), managed);
  assert.deepEqual(shellArray(rollback, "managed_runtime_services"), managed);
  assert.deepEqual(
    pythonTuple(recoveryEvidence, "PILOT_SERVICES"),
    managed,
  );
  assert.deepEqual(
    pythonTuple(recoveryEvidenceTest, "SERVICES"),
    managed,
  );
  assert.deepEqual(shellArray(release, "previous_core"), internalStart);
  assert.deepEqual(shellArray(rollback, "previous_core"), internalStart);
  assert.match(
    rollbackTest,
    /expected_rollback_services=\([\s\S]*?\bfile-erasure-worker\b[\s\S]*?\)/u,
    "rollback release-record fixture must require file-erasure-worker",
  );
});
test("rollback authenticates PostgreSQL before mutation and uniformly rechecks it after restore", () => {
  const compatibilityGate = rollback.indexOf(
    'verify_host_operations_compatibility "$rollback_host_commit" "$rollback_host_tree"',
  );
  const postgresGate = rollback.indexOf("\nauthenticate_current_postgres_runtime\n");
  const localImageInspection = rollback.indexOf(
    'image_id="$(run_bounded "${docker_cli[@]}" image inspect',
    postgresGate,
  );
  const coreStart = rollback.indexOf(
    'run_bounded "${previous_compose[@]}" up -d --no-build',
    postgresGate,
  );
  const postCoreRecheck = rollback.indexOf(
    "\n  record_rollback_runtime_state",
    coreStart,
  );

  assert.ok(compatibilityGate >= 0, "host compatibility gate is missing");
  assert.ok(postgresGate > compatibilityGate, "PostgreSQL authentication must follow host compatibility");
  assert.ok(localImageInspection > postgresGate, "PostgreSQL authentication must precede rollback image inspection");
  assert.ok(coreStart > localImageInspection, "PostgreSQL authentication must precede rollback core mutation");
  assert.ok(postCoreRecheck > coreStart, "restored runtime must be reinspected after core start");
  assert.match(rollback, /configured_postgres_image="\$\(compose_postgres_image\)"/u);
  assert.match(rollback, /managed-containers\.\$\{inventory_sha\}\.tsv/u);
  assert.match(rollback, /inventory_sha_after.*inventory_sha_before/su);
  assert.match(rollback, /active_sha_before.*rollback_finalization_active_sha/su);
  assert.match(
    rollback,
    /inventory_path="\$record_real\/rollback-managed-containers\.tsv"[\s\S]*rollback_finalization_inventory_sha" == "\$inventory_sha/u,
  );
  assert.match(rollback, /record_rollback_runtime_state\(\)[\s\S]*\[a-z0-9\.\/_:-\]/u);
  assert.match(rollback, /inspected_image" == "\$authenticated_postgres_image/su);
  assert.match(
    rollback,
    /reviewed_images\[postgres\]="\$authenticated_postgres_image"[\s\S]*reviewed_identities\[postgres\]="\$authenticated_postgres_identity"/u,
  );

  const recordStart = rollback.indexOf("record_rollback_runtime_state() {");
  const recordEnd = rollback.indexOf("\n}\n", recordStart) + 3;
  const recordRuntime = rollback.slice(recordStart, recordEnd);
  assert.doesNotMatch(recordRuntime, /service" == postgres/u);
  assert.match(
    recordRuntime,
    /"\$image" == "\$\{reviewed_images\[\$service\]\}"[\s\S]*"\$identity" == "\$\{reviewed_identities\[\$service\]\}"/u,
  );
  assert.match(
    rollbackTest,
    /write_current_runtime_state "\$candidate_commit" "\$candidate_tree"/u,
  );
  assert.match(rollbackTest, /postgres:17-bookworm@sha256:/u);
});
test("host operations compatibility is semantic, versioned, provenance-split, and pre-mutation", () => {
  const helperPath = "infra/ops/host-operations-compatibility.py";
  for (const [label, source] of [
    ["release", release],
    ["rollback", rollback],
  ]) {
    assert.match(
      source,
      new RegExp(
        String.raw`readonly host_operations_compatibility_helper="?\$repo_root/${helperPath}"?`,
        "u",
      ),
      `${label} must use the trusted current compatibility helper`,
    );
    assert.match(source, /verify_host_operations_compatibility\(\) \{/u);
    for (const argument of [
      "--repo-root",
      "--git-bin",
      "--docker-bin",
      "--host-commit",
      "--host-tree",
      "--application-commit",
      "--application-tree",
    ]) {
      assert.match(source, new RegExp(argument, "u"));
    }
    for (const field of [
      "SCHEMA_VERSION=2",
      "APPLICATION_GIT_COMMIT",
      "APPLICATION_GIT_TREE",
      "HOST_OPERATIONS_GIT_COMMIT",
      "HOST_OPERATIONS_GIT_TREE",
      "HOST_OPERATIONS_CONTRACT_VERSION",
      "HOST_OPERATIONS_CONTRACT_SHA256",
    ]) {
      assert.match(source, new RegExp(field, "u"));
    }
  }

  const releaseGate = release.indexOf(
    'verify_host_operations_compatibility "$release_commit" "$release_tree"',
  );
  const releasePull = release.indexOf(
    'run_bounded "${docker_cli[@]}" pull "$image"',
  );
  const releaseStorageMutation = release.indexOf(
    '"$prepare_postgres_script"',
    release.indexOf('current_stage="prepare-postgres-storage"'),
  );
  assert.notEqual(releaseGate, -1, "release compatibility gate is missing");
  assert.ok(
    releaseGate < releasePull && releaseGate < releaseStorageMutation,
    "release must bind host/application trees before pull or host storage mutation",
  );

  const rollbackGate = rollback.indexOf(
    'verify_host_operations_compatibility "$rollback_host_commit" "$rollback_host_tree"',
  );
  const rollbackBoundaryGates = [
    "verify_legacy_mail_outbox_contract_lineage",
    "verify_dispatch_binding_rollback_contract",
    "verify_guarded_delivery_rollback_contract",
  ];
  for (const boundaryGate of rollbackBoundaryGates) {
    assert.ok(
      rollback.lastIndexOf(boundaryGate) < rollbackGate,
      `${boundaryGate} must diagnose forward-only boundaries before host compatibility`,
    );
  }

  const rollbackImageInspect = rollback.indexOf(
    'image_id="$(run_bounded "${docker_cli[@]}" image inspect',
  );
  const rollbackStart = rollback.indexOf(
    'run_bounded "${previous_compose[@]}" up -d',
  );
  assert.notEqual(rollbackGate, -1, "rollback compatibility gate is missing");
  assert.ok(
    rollbackGate < rollbackImageInspect && rollbackGate < rollbackStart,
    "rollback must bind host/application trees before image or container mutation",
  );

  for (const field of [
    '"APPLICATION_GIT_COMMIT"',
    '"APPLICATION_GIT_TREE"',
    '"HOST_OPERATIONS_GIT_COMMIT"',
    '"HOST_OPERATIONS_GIT_TREE"',
    '"HOST_OPERATIONS_CONTRACT_VERSION"',
    '"HOST_OPERATIONS_CONTRACT_SHA256"',
  ]) {
    assert.match(recoveryEvidence, new RegExp(field, "u"));
  }
  assert.match(recoveryEvidence, /values\["SCHEMA_VERSION"\] != "2"/u);
  assert.match(
    release,
    /previous_release_id" != none[\s\S]+previous_runtime_compatible" == true[\s\S]+previous-runtime-host-operations-compatibility\.env/u,
    "a rollback-capable release must attest even a legacy predecessor before mutation",
  );
  assert.match(
    rollbackRunbook,
    /one-time active-release schema-v2 transition[\s\S]+host-operations compatibility evidence/u,
    "the fail-closed legacy predecessor transition must be documented",
  );
});

test("rollback finalization is durable, idempotent, and resumable at every commit boundary", () => {
  for (const contract of [
    /load_rollback_finalization_intent\(\) \{/u,
    /begin_rollback_finalization\(\) \{/u,
    /record_rollback_execution_once\(\) \{/u,
    /rollback-finalization\.env/u,
    /FINALIZATION_ID_SHA256/u,
    /RUNTIME_ACTIVE_SHA256/u,
    /RUNTIME_INVENTORY_SHA256/u,
  ]) {
    assert.match(rollback, contract);
  }

  const begin = rollback.indexOf("begin_rollback_finalization");
  const active = rollback.lastIndexOf("publish_rollback_runtime_state");
  const current = rollback.lastIndexOf(
    'write_release_pointer "$current_pointer"',
  );
  const latest = rollback.lastIndexOf(
    'write_release_pointer "$latest_candidate_pointer"',
  );
  const audit = rollback.lastIndexOf("record_rollback_execution_once");
  const clear = rollback.lastIndexOf("run_ingress_control quarantine-clear");
  assert.ok(
    begin !== -1 &&
      begin < active &&
      active < current &&
      current < latest &&
      latest < audit &&
      audit < clear,
    "rollback finalization boundaries must follow the durable intent in commit order",
  );

  for (const scenario of [
    "finalization-active-fsync-failure",
    "finalization-current-pointer-fsync-failure",
    "finalization-latest-pointer-fsync-failure",
    "finalization-audit-temp-fsync-failure",
    "finalization-audit-fsync-failure",
    "finalization-quarantine-clear-failure",
  ]) {
    assert.match(
      rollbackTest,
      new RegExp(`run_rollback ${scenario} --schema-backward-compatible`, "u"),
      `${scenario} must have a behavioral resume proof`,
    );
  }
  assert.match(rollbackTest, /assert_finalization_runtime_reverified "completed finalization replay"/u);
  assert.match(rollbackTest, /did not rerun both rollback smoke phases in order/u);
  assert.match(rollbackTest, /did not reinspect restored service/u);
  assert.match(rollbackTest, /duplicated its rollback execution audit/u);
  assert.equal(rollback.includes("\r"), false, "rollback production script contains CR bytes");
  assert.equal(rollbackTest.includes("\r"), false, "rollback behavioral harness contains CR bytes");
});

test("0069 capability is one canonical checked-in regular Git blob", () => {
  assert.equal(
    existsSync(capabilityAbsolutePath),
    true,
    "0069 capability manifest is missing",
  );
  const capability = readFileSync(capabilityAbsolutePath, "utf8");
  assert.equal(capability, expectedCapability);
  const blob = execFileSync(
    "git",
    ["hash-object", "--", capabilityPath],
    { cwd: repoRoot, encoding: "utf8" },
  ).trim();
  assert.match(blob, /^[0-9a-f]{40}$/u);
  for (const consumer of [release, rollback]) {
    assert.match(
      consumer,
      new RegExp(
        String.raw`readonly mail_outbox_guarded_delivery_boundary_commit=${boundaryCommit}`,
        "u",
      ),
    );
    assert.match(
      consumer,
      new RegExp(
        String.raw`readonly mail_outbox_guarded_delivery_capability_path=${capabilityPath}`,
        "u",
      ),
    );
    assert.match(
      consumer,
      new RegExp(
        String.raw`readonly mail_outbox_guarded_delivery_capability_blob=${blob}`,
        "u",
      ),
    );
    assert.match(
      consumer,
      new RegExp(
        String.raw`0069_mail_outbox_guarded_delivery_authority\|${boundaryCommit}\|${capabilityPath}\|100644\|${blob}`,
        "u",
      ),
    );
  }
});

test("release and rollback bind exact 0068 and 0069 migration blobs before capability or image work", () => {
  const consumers = [
    {
      label: "release",
      source: release,
      nextFunction: "derive_guarded_delivery_candidate_capability",
    },
    {
      label: "rollback",
      source: rollback,
      nextFunction: "verify_dispatch_binding_rollback_contract",
    },
  ];

  for (const { label, source, nextFunction } of consumers) {
    assert.match(
      source,
      new RegExp(
        String.raw`readonly mail_outbox_guarded_delivery_boundary_commit=${boundaryCommit}`,
        "u",
      ),
      `${label} must preserve the reviewed historical 0069 boundary commit`,
    );
    for (const migration of guardedDeliveryMigrations) {
      assert.match(
        source,
        new RegExp(
          String.raw`readonly ${migration.prefix}_path=${migration.path}`,
          "u",
        ),
        `${label} must pin ${migration.path}`,
      );
      assert.match(
        source,
        new RegExp(
          String.raw`readonly ${migration.prefix}_mode=${migration.mode}`,
          "u",
        ),
        `${label} must pin ${migration.path} as a regular Git blob`,
      );
      assert.match(
        source,
        new RegExp(
          String.raw`readonly ${migration.prefix}_blob=${migration.blob}`,
          "u",
        ),
        `${label} must pin the exact reviewed blob for ${migration.path}`,
      );
    }
    assert.match(
      source,
      /verify_exact_guarded_delivery_migration_blob\(\) \{[\s\S]*?local tree="\$1" label="\$2" expected_path="\$3" expected_mode="\$4" expected_blob="\$5"[\s\S]*?run_local_evidence_git ls-tree "\$tree" -- "\$expected_path"[\s\S]*?"\$mode" == "\$expected_mode"[\s\S]*?"\$object_type" == blob[\s\S]*?"\$object_id" == "\$expected_blob"[\s\S]*?"\$entry_path" == "\$expected_path"[\s\S]*?\n\}/u,
      `${label} must expose one generic exact migration-blob verifier`,
    );
    const loaderStart = source.indexOf(
      "\nload_guarded_delivery_capability() {\n",
    );
    const loaderEnd = source.indexOf(`\n${nextFunction}() {\n`, loaderStart);
    assert.notEqual(loaderStart, -1, `${label} capability loader is missing`);
    assert.notEqual(loaderEnd, -1, `${label} capability loader is unbounded`);
    const loader = source.slice(loaderStart, loaderEnd);
    const capabilityLookup = loader.indexOf(
      'run_local_evidence_git ls-tree "$expected_tree" -- \\\n    "$mail_outbox_guarded_delivery_capability_path"',
    );
    assert.notEqual(
      capabilityLookup,
      -1,
      `${label} capability blob lookup is missing`,
    );
    for (const migration of guardedDeliveryMigrations) {
      const call = [
        'verify_exact_guarded_delivery_migration_blob "$expected_tree" "$label"',
        ` "$${migration.prefix}_path"`,
        ` "$${migration.prefix}_mode"`,
        ` "$${migration.prefix}_blob"`,
      ].join("");
      const callIndex = loader.indexOf(call);
      assert.notEqual(callIndex, -1, `${label} is missing ${call}`);
      assert.ok(
        callIndex < capabilityLookup,
        `${label} must verify ${migration.path} before capability work`,
      );
    }
  }
});

test("--mail-store-cutover requires the previous exact guarded tuple after derivation", () => {
  const previousDerivation = release.indexOf(
    "\nderive_guarded_delivery_previous_capability\n",
  );
  const exactCutoverGate = release.indexOf(
    'if [[ "$mail_store_cutover" == true \\\n  && ( "$previous_guarded_delivery_runtime" != "$guarded_delivery_runtime_contract" \\\n    || "$previous_delivery_release_authority" != "$delivery_release_authority_contract" \\\n    || "$previous_guarded_delivery_privilege" != "$guarded_delivery_privilege_contract" ) ]]; then',
  );
  assert.notEqual(
    previousDerivation,
    -1,
    "previous guarded capability derivation is missing",
  );
  assert.notEqual(
    exactCutoverGate,
    -1,
    "mail-store cutover must fail closed without the previous exact guarded tuple",
  );
  assert.ok(
    previousDerivation < exactCutoverGate,
    "mail-store cutover must validate the previous tuple after deriving it",
  );
});

test("release binds source and previous 0069 trees and writes V4 evidence", () => {
  assert.match(
    release,
    /load_guarded_delivery_capability "\$release_commit" "\$release_tree" "source image"/u,
  );
  assert.match(
    release,
    /load_guarded_delivery_capability "\$previous_git_commit" "\$previous_git_tree" "previous image"/u,
  );
  assert.match(release, /mail_outbox_contract_schema_version=4/u);
  for (const key of [
    "GUARDED_DELIVERY_RUNTIME",
    "DELIVERY_RELEASE_AUTHORITY",
    "GUARDED_DELIVERY_PRIVILEGE",
    "PREVIOUS_GUARDED_DELIVERY_RUNTIME",
    "PREVIOUS_DELIVERY_RELEASE_AUTHORITY",
    "PREVIOUS_GUARDED_DELIVERY_PRIVILEGE",
  ]) {
    assert.match(release, new RegExp(`printf '${key}=%s\\\\n'`, "u"));
  }
  assert.match(
    release,
    /0069_mail_outbox_guarded_delivery_authority is forward-only/u,
  );
  assert.doesNotMatch(
    release,
    /0067_mail_outbox_durable_replay_authority requires an approved Task 7 delivery receipt capability/u,
  );
});

test("rollback parses V4 and verifies both exact 0069 image trees", () => {
  assert.match(rollback, /SCHEMA_VERSION=4/u);
  assert.match(
    rollback,
    /verify_guarded_delivery_rollback_contract/u,
  );
  assert.match(
    rollback,
    /load_guarded_delivery_capability "\$record_git_commit" "\$record_git_tree" "source image"/u,
  );
  assert.match(
    rollback,
    /load_guarded_delivery_capability "\$previous_git_commit" "\$previous_git_tree" "previous image"/u,
  );
  assert.match(
    rollback,
    /0069_mail_outbox_guarded_delivery_authority is forward-only/u,
  );
  assert.doesNotMatch(
    rollback,
    /deny_unapproved_mail_outbox_durable_replay_tree/u,
  );
});
test("behavioral fixtures and operator guidance use the 0069 capability gate", () => {
  for (const scenario of [
    "guarded-delivery-capability-missing",
    "guarded-delivery-exact",
    "guarded-delivery-exact-compatible-second",
    "guarded-delivery-capability-tampered",
  ]) {
    assert.match(releaseTest, new RegExp(scenario, "u"));
  }
  assert.match(
    releaseTest,
    /\|\| "\$\{FAKE_SCENARIO:-\}" == "guarded-delivery-exact-compatible-second"[\s\S]*?printf 'old-deployed-%s-container\\n' "\$service"/u,
    "second release fixture must report the first reviewed deployment as running",
  );
  for (const scenario of [
    "guarded-delivery-exact-compatible",
    "guarded-delivery-capability-missing",
    "guarded-delivery-capability-tampered",
    "guarded-delivery-previous-capability-missing",
    "guarded-delivery-previous-capability-tampered",
  ]) {
    assert.match(rollbackTest, new RegExp(scenario, "u"));
  }
  assert.doesNotMatch(
    rollbackTest,
    /rollback denies exact 0067 source and target trees/u,
  );
  assert.match(
    updateRunbook,
    /`0069_mail_outbox_guarded_delivery_authority` is a third forward-only authority boundary/u,
  );
  assert.match(
    deploymentGuide,
    /V4 evidence binds the guarded TX1\/TX2 exact-byte runtime/u,
  );
});
test("release validates the candidate 0069 capability before previous-contract work", () => {
  const durableQuarantine = release.indexOf(
    '\nrun_ingress_control quarantine-create || fatal "unable to create durable release quarantine"',
  );
  const immediateIngressStop = release.indexOf(
    "\nquarantine_tunnel_early || quarantine_tunnel_early || {",
  );
  const candidateGate = release.indexOf(
    "\nderive_guarded_delivery_candidate_capability\n",
  );
  const firstNonQuarantineDocker = release.indexOf(
    '\ncandidate_output="$(run_bounded "${compose[@]}" --profile operations config --images)"',
  );
  const previousContract = release.indexOf(
    '\nif [[ "$previous_release_id" != none ]]; then\n  previous_mail_contract=',
  );
  const previousGate = release.indexOf(
    "\nderive_guarded_delivery_previous_capability\n",
  );
  assert.notEqual(durableQuarantine, -1, "durable quarantine is missing");
  assert.notEqual(immediateIngressStop, -1, "immediate ingress stop is missing");
  assert.notEqual(candidateGate, -1, "candidate capability gate is missing");
  assert.notEqual(
    firstNonQuarantineDocker,
    -1,
    "first non-quarantine Docker inventory is missing",
  );
  assert.notEqual(previousContract, -1, "previous contract parser is missing");
  assert.notEqual(previousGate, -1, "previous capability gate is missing");
  assert.ok(
    durableQuarantine < immediateIngressStop,
    "durable quarantine must precede the immediate cloudflared stop",
  );
  assert.ok(
    immediateIngressStop < candidateGate,
    "immediate cloudflared stop must precede candidate capability validation",
  );
  assert.ok(
    candidateGate < firstNonQuarantineDocker,
    "candidate capability validation must precede non-quarantine Docker work",
  );
  assert.ok(
    candidateGate < previousContract,
    "candidate capability gate must precede previous-contract processing",
  );
  assert.ok(
    previousGate > previousContract,
    "previous capability compatibility must follow previous-contract processing",
  );
  assert.match(
    release,
    /if \(\( mail_outbox_contract_schema_version < 3 \)\); then\n    mail_outbox_contract_schema_version=3\n  fi/u,
    "later 0064 derivation must not downgrade candidate V4 evidence",
  );
});
test("rollback verifies both 0069 trees before local image inspection", () => {
  const guardedGate = rollback.indexOf(
    "\nverify_guarded_delivery_rollback_contract\n",
  );
  const firstImageInspect = rollback.indexOf(
    '\n  image_id="$(run_bounded "${docker_cli[@]}" image inspect',
  );
  assert.notEqual(guardedGate, -1, "guarded rollback verifier call is missing");
  assert.notEqual(firstImageInspect, -1, "rollback image inspection is missing");
  assert.ok(
    guardedGate < firstImageInspect,
    "both guarded capability trees must be verified before image inspection",
  );
});
test("root CI release and rollback harnesses use one private exact Git trust file", () => {
  for (const command of [
    'sudo -n env "PATH=$PATH" bash infra/tests/release-production.test.sh',
    'sudo -n env "PATH=$PATH" bash infra/tests/rollback-production.test.sh',
  ]) {
    assert.match(ciWorkflow, new RegExp(command.replaceAll("$", "\\$"), "u"));
  }

  for (const [label, source] of [
    ["release", releaseTest],
    ["rollback", rollbackTest],
  ]) {
    const workCreate = source.indexOf('work="$(mktemp -d)"');
    const cleanupTrap = source.indexOf(`trap 'rm -rf "$work"' EXIT`);
    const privateConfig = source.indexOf(
      'source_git_config="$work/source-git.config"',
    );
    const repositoryTrust = source.indexOf(
      'git config --file "$source_git_config" --add safe.directory "$repo_root"',
    );
    const firstSourceAccess = source.indexOf(
      'git -C "$repo_root" rev-parse --path-format=absolute --git-common-dir',
    );
    const gitDirectoryTrust = source.indexOf(
      'git config --file "$source_git_config" --add safe.directory "$source_git_dir"',
    );
    assert.notEqual(workCreate, -1, `${label} harness lacks a temporary root`);
    assert.notEqual(cleanupTrap, -1, `${label} harness lacks automatic cleanup`);
    assert.notEqual(privateConfig, -1, `${label} harness lacks a private Git config`);
    assert.notEqual(repositoryTrust, -1, `${label} harness lacks repository trust`);
    assert.notEqual(firstSourceAccess, -1, `${label} source Git access is missing`);
    assert.notEqual(gitDirectoryTrust, -1, `${label} harness lacks Git-directory trust`);
    assert.ok(
      workCreate < cleanupTrap && cleanupTrap < privateConfig,
      `${label} cleanup must be armed before creating Git trust state`,
    );
    assert.ok(
      repositoryTrust < firstSourceAccess && firstSourceAccess < gitDirectoryTrust,
      `${label} must trust the repository before resolving and then trust its exact Git directory`,
    );
    assert.match(source, /\[\[ "\$EUID" == 0 \]\]/u);
    assert.match(
      source,
      /\[\[ "\$\(stat -c '%u:%a' -- "\$work"\)" == "0:700" \]\]/u,
    );
    assert.match(
      source,
      /\[\[ "\$\(stat -c '%u:%a' -- "\$source_git_config"\)" == "0:600" \]\]/u,
    );
    assert.match(source, /export GIT_CONFIG_GLOBAL="\$source_git_config"/u);
    assert.match(source, /export GIT_CONFIG_NOSYSTEM=1/u);
    assert.match(
      source,
      /"\$\{#source_safe_directories\[@\]\}" == 2[\s\S]*?"\$\{source_safe_directories\[0\]\}" == "\$repo_root"[\s\S]*?"\$\{source_safe_directories\[1\]\}" == "\$source_git_dir"/u,
    );
    assert.doesNotMatch(
      source,
      /safe\.directory(?:=|\s+)["']?\*/u,
      `${label} harness must never trust wildcard Git ownership`,
    );
  }
});
