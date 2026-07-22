import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const validatorPath = path.join(root, "infra/ops/validate-runtime.sh");
const source = fs.readFileSync(validatorPath, "utf8");
const lines = source.split("\n");

function uniqueLineIndex(fragment) {
  const matches = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].includes(fragment)) matches.push(index);
  }
  assert.equal(matches.length, 1, `expected one validator line containing ${JSON.stringify(fragment)}`);
  return matches[0];
}

function matchingFiIndex(startIndex) {
  let depth = 0;
  for (let index = startIndex; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (/^if\b.*\bthen$/u.test(line)) depth += 1;
    if (line === "fi") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  assert.fail(`unterminated shell if beginning on validator line ${startIndex + 1}`);
}

const runnerEgressIndex = uniqueLineIndex(
  'if [[ "$current_section" == networks && "$current_network" == runner-egress ]]; then',
);
const runnerClientIndex = uniqueLineIndex(
  'if [[ "$current_section" == networks && "$current_network" == runner-client ]]; then',
);
assert.ok(
  matchingFiIndex(runnerEgressIndex) < runnerClientIndex,
  "runner-client parsing must be a sibling after the complete runner-egress parser, never nested inside it",
);

const gatewayGraceIndex = uniqueLineIndex('rendered_stop_periods[runner-egress-gateway]');
const postStartIndex = uniqueLineIndex('if [[ "$post_start" == true ]]; then');
const postgresStartIndex = uniqueLineIndex('postgres_settings="$(');
const postgresEndIndex = uniqueLineIndex(')" || fatal "bounded live PostgreSQL durability probe failed"');

assert.ok(
  gatewayGraceIndex < postStartIndex && postStartIndex < postgresStartIndex,
  "runner gateway stop-grace validation must finish before the post-start PostgreSQL probe begins",
);
assert.ok(postgresEndIndex > postgresStartIndex, "PostgreSQL probe command substitution must close after it opens");

const postgresCommandBody = lines.slice(postgresStartIndex + 1, postgresEndIndex).join("\n");
assert.equal(
  postgresCommandBody,
  [
    '    "$timeout_bin" 30s "$resolved_docker_bin" compose --env-file "$compose_env" \\',
    '      -f "$repo_root/compose.yaml" exec -T postgres psql --host=/run/learncoding-postgres \\',
    '      --username="${POSTGRES_USER:-learncoding}" --dbname="${POSTGRES_DB:-learncoding}" \\',
    '      --no-psqlrc --quiet --no-align --tuples-only \'--field-separator=|\' \\',
    '      --command "$postgres_probe_sql"',
  ].join("\n"),
  "post-start PostgreSQL probe must contain only the canonical continued Docker Compose argv",
);

assert.match(
  source,
  /if \[\[ "\$validation_mode" == operations \]\]; then\s+render_command\+=\(--profile operations\)\s+fi/u,
  "operations validation must render the operations Compose profile explicitly",
);
for (const service of [
  "database-role-bootstrap",
  "database-negative-probes",
  "database-boundary-verifier",
  "migrate",
  "lifecycle",
  "platform-seed",
  "admin-bootstrap",
]) {
  assert.match(source, new RegExp(`\\b${service}\\b`, "u"), `validator must recognize ${service}`);
}
assert.match(
  source,
  /case "\$\{REQUIRE_BOOTSTRAP_ADMIN_SECRET:-false\}" in[\s\S]*?true\)[\s\S]*?require_nonempty_secret bootstrap_admin_password[\s\S]*?false\)[\s\S]*?bootstrap_admin_password must be absent unless explicitly required[\s\S]*?literal true or false/u,
  "bootstrap secret validation must be controlled by one strict explicit boolean",
);
assert.match(
  source,
  /if \[\[ "\$pre_privileged" == true \]\]; then[\s\S]*?prepare-object-storage\.mjs[\s\S]*?prepare-postgres-control-socket\.sh[\s\S]*?validate_postgres_image_identity[\s\S]*?pre-privileged runtime validation passed/u,
  "pre-privileged validation must authenticate both preparers and the pinned PostgreSQL identity",
);

console.log("runtime-validator-structure-tests-ok");
