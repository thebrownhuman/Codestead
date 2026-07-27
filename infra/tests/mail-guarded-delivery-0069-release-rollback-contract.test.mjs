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
