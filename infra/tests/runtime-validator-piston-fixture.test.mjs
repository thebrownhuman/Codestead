import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";

// Exercise the approved validator's actual shell, without reimplementing its
// rules or replacing the mandatory root/Bubblewrap runtime harness.
const source = readFileSync(new URL("../ops/validate-runtime.sh", import.meta.url), "utf8");
function section(start, end) {
  const first = source.indexOf(start);
  assert.ok(first >= 0 && source.indexOf(start, first + 1) < 0, `unique section: ${start}`);
  const last = source.indexOf(end, first);
  assert.ok(last > first, `closed section: ${start}`);
  return source.slice(first, last);
}
const imageRule = section("image_is_digest_pinned() {", "\nvalidate_postgres_image_identity() {");
const providerRule = section('case "${CODE_RUNNER_PROVIDER:-piston}" in', "\nraw_secrets_dir=");
const clientRule = section("is_runner_client() {", "\nwhile IFS= read -r line; do");
const fieldRules = section(
  '    if [[ "$line" =~ ^[[:space:]]{6}CODE_RUNNER_PROVIDER:',
  '    if [[ "$line" =~ ^[[:space:]]{6}(-[[:space:]]+runner-egress',
);
const requiredFields = section(
  "# Every execution consumer must use the reviewed internal backend and digest.",
  '[[ "$piston_network_internal_seen" == true ]]',
);
const clients = ["app", "regrade-worker", "exam-finalization-worker", "practice-runner-recovery-worker"];
const image = `codestead-piston@sha256:${"a".repeat(64)}`;
function validate({ provider = "piston", profile = true, pinnedImage = image, missing, extra, wrongProvider } = {}) {
  const rendered = [...clients, ...(extra ? [extra] : [])].flatMap((name) => [
    `  ${name}:`,
    ...(missing === `${name}:provider` ? [] : [`      CODE_RUNNER_PROVIDER: ${wrongProvider === name ? "legacy" : "piston"}`]),
    ...(missing === `${name}:url` ? [] : ["      PISTON_URL: http://piston:2000"]),
    ...(missing === `${name}:image` ? [] : [`      PISTON_IMAGE: ${image}`]),
    ...(missing === `${name}:network` ? [] : ["      - piston"]),
  ]).join("\n") + "\n";
  const shell = `set -euo pipefail
fatal() { printf '%s\\n' "$*" >&2; exit 1; }
${imageRule}
${clientRule}
${providerRule}
declare -A rendered_piston_members=() rendered_piston_urls=() rendered_piston_images=() rendered_piston_providers=()
current_service=
while IFS= read -r line; do
  if [[ "$line" =~ ^[[:space:]]{2}([a-z0-9-]+):$ ]]; then current_service="\${BASH_REMATCH[1]}"; continue; fi
${fieldRules}
done
${requiredFields}`;
  const env = { ...process.env, profile_piston: String(profile), PISTON_IMAGE: pinnedImage };
  if (provider === undefined || provider === null) delete env.CODE_RUNNER_PROVIDER;
  else env.CODE_RUNNER_PROVIDER = provider;
  const result = spawnSync("bash", ["-c", shell], { env, input: rendered, encoding: "utf8", timeout: 5_000 });
  if (result.error) throw result.error;
  return result;
}

test("exactly four Piston consumers pass; unset and empty provider resolve to Piston", () => {
  for (const provider of ["piston", null, ""]) assert.equal(validate({ provider }).status, 0);
});
test("legacy and every other explicit provider fail", () => {
  for (const provider of ["legacy", "judge0", "firecracker", "PISTON", " piston"])
    assert.notEqual(validate({ provider }).status, 0, provider);
});
test("a fifth Piston consumer fails the approved allowlist", () => {
  assert.notEqual(validate({ extra: "mail-worker" }).status, 0);
});
for (const name of clients) {
  for (const field of ["url", "image", "provider", "network"]) {
    test(`${name} missing ${field} fails validation`, () => {
      assert.notEqual(validate({ missing: `${name}:${field}` }).status, 0);
    });
  }
  test(`${name} cannot render a legacy provider`, () => {
    assert.notEqual(validate({ wrongProvider: name }).status, 0);
  });
  test(`${name} requires the Piston deployment profile`, () => {
    assert.notEqual(validate({ profile: false }).status, 0);
  });
}
test("Piston images without a full manifest SHA-256 pin fail", () => {
  for (const pinnedImage of ["", "codestead-piston:latest", "codestead-piston@sha256:short"])
    assert.notEqual(validate({ pinnedImage }).status, 0);
});
