import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const validator = fs.readFileSync(path.join(root, "infra/ops/validate-runtime.sh"));
const harness = fs.readFileSync(path.join(root, "infra/tests/runtime-config.test.sh"), "utf8");
const actualSha256 = crypto.createHash("sha256").update(validator).digest("hex");
const reviewedSha256 = harness.match(/^validator_reviewed_sha256='([0-9a-f]{64})'$/mu)?.[1];

assert.equal(reviewedSha256, actualSha256, "runtime harness must pin the exact current validator SHA-256");
for (const [label, diagnostic] of [
  ["wrong-runner-client-subnet", "fatal: runner-client subnet must be exactly 172.29.41.0/24"],
  ["non-internal-runner-client", "fatal: runner-client network must be internal"],
  ["wrong-runner-gateway-stop-grace", "fatal: rendered runner gateway stop budget must be exactly fifteen seconds"],
]) {
  assert.ok(harness.includes(`make_fixture ${label}`), `runtime harness must retain the ${label} negative fixture`);
  assert.ok(harness.includes(diagnostic), `${label} must assert its exact fail-closed diagnostic`);
}
assert.match(
  harness,
  /fake_runner_client_internal='true'[\s\S]*?FAKE_RUNNER_CLIENT_INTERNAL="\$fake_runner_client_internal"/u,
  "runtime harness must propagate its runner-client internal-network fixture value",
);
assert.match(
  harness,
  /"    internal: \$FAKE_RUNNER_CLIENT_INTERNAL"/u,
  "fake Compose rendering must expose the mutable runner-client internal flag",
);

console.log("runtime-validator-harness-contract-tests-ok");
