import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "../..");
const read = (relative) => readFileSync(path.join(root, relative), "utf8");

test("fixture runtime is an on-demand default-deny non-root Docker dependency", () => {
  const unit = read("infra/systemd/learncoding-production-load-fixture-runtime.service");
  for (const fragment of [
    "Requires=docker.service",
    "StopWhenUnneeded=yes",
    "RefuseManualStart=yes",
    "ExecStartPre=/usr/bin/bash /opt/learncoding/infra/ops/validate-production-load-fixture-runtime.sh",
    "node:22.22.0-bookworm-slim@sha256:dd9d21971ec4395903fa6143c2b9267d048ae01ca6d3ea96f16cb30df6187d94",
    "--network none",
    "--read-only",
    "--user 65532:65532",
    "--cap-drop ALL",
    "--security-opt no-new-privileges:true",
    "--pids-limit 128",
    "--memory 256m",
    "--cpus 1",
    "--tmpfs /var/lib/learncoding-production-load-fixtures:rw,noexec,nosuid,nodev,size=32m,mode=0700,uid=65532,gid=65532",
    "/run/learncoding-production-load-fixtures:/run/learncoding-production-load-fixtures:rw",
    "production-load-fixture-runtime.mjs:/opt/codestead/production-load-fixture-runtime.mjs:ro",
    "production-load-network-attestation:/run/secrets/production_load_network_attestation:ro",
  ]) assert.match(unit, new RegExp(fragment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(unit, /--privileged|docker\.sock:|--network host|--cap-add/);
  assert.doesNotMatch(unit, /\[Install\]/);
});

test("root test-control requires the fixture runtime but receives no Docker socket", () => {
  const unit = read("infra/systemd/learncoding-production-load-test-control.service");
  assert.match(unit, /Requires=learncoding-compose\.service learncoding-production-load-fixture-runtime\.service/);
  assert.match(unit, /After=learncoding-compose\.service learncoding-production-load-fixture-runtime\.service/);
  assert.match(unit, /LOAD_FIXTURE_PROFILE=codestead-production-load-v1/);
  assert.match(unit, /LOAD_FIXTURE_APPROVED=1/);
  assert.match(unit, /LOAD_FIXTURE_ROOT=\/var\/lib\/learncoding-production-load-fixtures/);
  assert.match(unit, /LOAD_FIXTURE_RUNTIME_SOCKET=\/run\/learncoding-production-load-fixtures\/runtime\.sock/);
  assert.match(unit, /ReadWritePaths=\/run\/learncoding \/run\/learncoding-production-load-fixtures/);
  assert.match(unit, /-\/run\/docker\.sock/);
});

test("installer creates the fixed fixture identity, private socket parent, and attestation", () => {
  const users = read("infra/sysusers.d/learncoding-production-load.conf");
  const tmpfiles = read("infra/tmpfiles.d/learncoding-production-load.conf");
  const installer = read("infra/ops/install-systemd.sh");
  assert.match(users, /^u learncoding-load-fixture 65532 /m);
  assert.match(tmpfiles, /^d \/run\/learncoding-production-load-fixtures 0700 65532 65532 -$/m);
  assert.match(installer, /production-load-network-attestation/);
  assert.match(installer, /-m 0444/);
  assert.doesNotMatch(installer, /enable --now learncoding-production-load-fixture-runtime\.service/);
});
