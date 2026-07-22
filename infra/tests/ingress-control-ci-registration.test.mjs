import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const workflow = readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");

assert.match(
  workflow,
  /shellcheck --severity=warning[^\n]*infra\/tests\/ingress-control-linux\.test\.sh/u,
  "CI must shellcheck the root ingress-control authority wrapper",
);
assert.match(
  workflow,
  /- run: sudo -n bash infra\/tests\/ingress-control-linux\.test\.sh/u,
  "CI must run the ingress-control authority suite under non-interactive root",
);

for (const harness of [
  "infra/tests/start-production-stack.test.sh",
  "infra/tests/start-production-stack-adversarial.test.sh",
]) {
  const escaped = harness.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  assert.match(
    workflow,
    new RegExp(`shellcheck --severity=warning[^\\n]*${escaped}`, "u"),
    `CI must shellcheck ${harness}`,
  );
  assert.match(
    workflow,
    new RegExp(`- run: sudo -n bash ${escaped}`, "u"),
    `CI must run ${harness} under non-interactive root`,
  );
}

console.log("ingress-control-ci-registration-tests-ok");
