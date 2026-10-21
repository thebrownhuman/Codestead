import assert from "node:assert/strict";
import "./runtime-validator-piston-fixture.test.mjs";
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
  ["legacy-runner-gateway-service", "fatal: rendered Compose contains an unexpected service"],
  ["legacy-runner-client-url", "fatal: retired legacy runner configuration must not be rendered"],
  ["legacy-runner-client-network", "fatal: retired legacy runner networks must not be attached"],
  ["legacy-runner-egress-network", "fatal: retired legacy runner networks must not be rendered"],
]) {
  assert.ok(harness.includes(`make_fixture ${label}`), `runtime harness must retain the ${label} negative fixture`);
  assert.ok(harness.includes(diagnostic), `${label} must assert its exact fail-closed diagnostic`);
}
assert.match(
  harness,
  /make_fixture "mail-worker-stop-\$label"[\s\S]*?equality\|120s[\s\S]*?shorter\|119s[\s\S]*?longer\|136s/u,
  "runtime harness must retain equality, shorter, and longer mail-worker platform-stop mutations",
);
assert.ok(
  harness.includes(
    "fatal: rendered mail-worker platform stop budget must be exactly 135 seconds and strictly exceed the 120-second application stop policy",
  ),
  "mail-worker platform-stop mutations must assert the exact fail-closed diagnostic",
);
assert.match(
  harness,
  /fake_legacy_runner=none[\s\S]*?FAKE_LEGACY_RUNNER="\$fake_legacy_runner"/u,
  "runtime harness must propagate its retired legacy-runner fixture selector",
);

console.log("runtime-validator-harness-contract-tests-ok");
