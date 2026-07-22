import assert from "node:assert/strict";

import { assertProductionLoadDisposableNetworkSandbox } from
  "../../../scripts/lib/production-load-disposable-sandbox";

const sandbox = await assertProductionLoadDisposableNetworkSandbox();
assert.equal(JSON.stringify(sandbox).includes("127.0.0.1"), false);
assert.deepEqual(Object.keys(sandbox), ["postgres", "tunnel", "provider"]);
process.stdout.write(
  "production load disposable sandbox proof passed: fixed-identities default-deny non-root\n",
);
