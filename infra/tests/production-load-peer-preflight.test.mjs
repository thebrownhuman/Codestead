import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const validator = await readFile(
  new URL("../ops/validate-production-load-host-runtime.sh", import.meta.url),
  "utf8",
);
const unit = await readFile(
  new URL("../systemd/learncoding-production-load-test-control.service", import.meta.url),
  "utf8",
);

assert.match(validator, /readonly python_bin=\/usr\/bin\/python3\.12/);
assert.match(
  validator,
  /readonly peer_credential_helper=\/opt\/learncoding\/infra\/ops\/production-load-peer-credentials\.py/,
);
assert.match(validator, /secure_mode "\$python_bin" executable/);
assert.match(validator, /secure_mode "\$peer_credential_helper" file/);
assert.ok(validator.includes('[[ "$python_version" =~ ^Python\\ 3\\.12\\.[0-9]+$ ]]'));
assert.match(validator, /ast\.parse/);

assert.match(unit, /^ConditionFileIsExecutable=\/usr\/bin\/python3\.12$/m);
assert.match(
  unit,
  /^AssertPathExists=\/opt\/learncoding\/infra\/ops\/production-load-peer-credentials\.py$/m,
);

console.log("production load peer-credential preflight contract passed");
