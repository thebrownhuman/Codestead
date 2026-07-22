import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../ops/validate-runtime.sh", import.meta.url), "utf8");

assert.match(
  source,
  /case "\$\{UPLOADS_ENABLED:-\}" in[\s\S]*?true\)[\s\S]*?"\$\{COMPOSE_PROFILES:-\}" == uploads[\s\S]*?false\)[\s\S]*?-z "\$\{COMPOSE_PROFILES:-\}"[\s\S]*?UPLOADS_ENABLED must be literal true or false/u,
  "ambient profiles must be exactly uploads when enabled and empty when disabled",
);
assert.doesNotMatch(
  source,
  /profile_is_enabled/u,
  "substring/list profile matching could authorize operations during ordinary boot",
);
assert.match(
  source,
  /if \[\[ "\$service" == cloudflared \]\]; then[\s\S]*?"\$\{rendered_restarts\[\$service\]:-\}" == on-failure:5[\s\S]*?elif is_long_running_service "\$service"; then[\s\S]*?== unless-stopped/u,
  "cloudflared must be the sole exact restart-policy exception",
);
assert.match(
  source,
  /psql --host=\/run\/learncoding-postgres[\s\S]*?--no-psqlrc --quiet --no-align --tuples-only/u,
  "the bounded PostgreSQL probe must ignore psqlrc and use canonical quiet output",
);

console.log("runtime-validator-ingress-policy-tests-ok");
