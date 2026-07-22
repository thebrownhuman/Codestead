import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { load as parse } from "js-yaml";

const composePath = new URL("../../compose.yaml", import.meta.url);
const composeUnitPath = new URL(
  "../systemd/learncoding-compose.service",
  import.meta.url,
);
const preparePath = new URL(
  "../ops/prepare-postgres-control-socket.sh",
  import.meta.url,
);
const guardedStartPath = new URL(
  "../ops/start-production-stack.sh",
  import.meta.url,
);

test("PostgreSQL exposes no host port and adds only the fixed root-restricted Unix socket", async () => {
  const compose = parse(await readFile(composePath, "utf8"));
  const postgres = compose.services.postgres;

  assert.equal(postgres.ports, undefined);
  assert.deepEqual(
    postgres.command.slice(-4),
    [
      "-c",
      "unix_socket_directories=/run/learncoding-postgres",
      "-c",
      "unix_socket_permissions=0700",
    ],
  );
  assert.ok(postgres.volumes.some((volume) =>
    volume?.type === "bind"
      && volume.source === "/run/learncoding-postgres"
      && volume.target === "/run/learncoding-postgres"
      && volume.read_only !== true));

  for (const [name, service] of Object.entries(compose.services)) {
    if (name === "postgres") continue;
    assert.equal(
      Boolean(service.volumes?.some((volume) =>
        typeof volume === "object"
          && (volume.source === "/run/learncoding-postgres"
            || volume.target === "/run/learncoding-postgres"))),
      false,
      `${name} must not receive the PostgreSQL control socket`,
    );
  }
});

test("guarded boot prepares the fixed socket directory before internal Compose start", async () => {
  const [unit, helper, guardedStart] = await Promise.all([
    readFile(composeUnitPath, "utf8"),
    readFile(preparePath, "utf8"),
    readFile(guardedStartPath, "utf8"),
  ]);

  assert.match(
    unit,
    /^ExecStart=\/usr\/bin\/env PATH=\/usr\/sbin:\/usr\/bin:\/sbin:\/bin \/usr\/bin\/bash \/opt\/learncoding\/infra\/ops\/start-production-stack\.sh --startup-wait 600$/m,
  );
  assert.doesNotMatch(unit, /^ExecStartPre=/m);
  assert.match(guardedStart, /readonly postgres_preparer="\$repo_root\/infra\/ops\/prepare-postgres-control-socket\.sh"/u);
  const stopIngress = guardedStart.indexOf(
    "quarantine_public_ingress || fatal 'unable to quarantine public ingress'",
  );
  const confirmIngressStopped = guardedStart.indexOf(
    "stop_compose_tunnel || fatal 'unable to confirm Compose ingress quarantine'",
  );
  const preflight = guardedStart.indexOf(
    'run_with_deadline 120 "$bash_bin" "$validator" --pre-privileged',
  );
  const prepare = guardedStart.indexOf(
    'run_with_deadline 120 "$bash_bin" "$postgres_preparer"',
  );
  const prepareObjects = guardedStart.indexOf(
    "NODE_OPTIONS='' run_with_deadline 120 \"$node_bin\" \"$object_preparer\"",
  );
  const fullValidation = guardedStart.indexOf(
    'run_with_deadline 120 "$bash_bin" "$validator" ||',
  );
  const internalStart = guardedStart.indexOf(
    'up -d --no-build --pull never --no-deps "${selected_internal_services[@]}"',
  );
  assert.ok(
    stopIngress >= 0 &&
      stopIngress < confirmIngressStopped &&
      confirmIngressStopped < preflight,
  );
  assert.ok(preflight < prepareObjects && prepareObjects < prepare);
  assert.ok(prepare < fullValidation && fullValidation < internalStart);
  assert.match(helper, /socket_root="\/run\/learncoding-postgres"/);
  assert.match(helper, /expected_uid="\$\{POSTGRES_UID:\?POSTGRES_UID is required\}"/);
  assert.match(helper, /expected_gid="\$\{POSTGRES_GID:\?POSTGRES_GID is required\}"/);
  assert.match(helper, /0700/);
  assert.match(helper, /-L/);
  assert.match(helper, /stat/);
  assert.doesNotMatch(helper, /^\s*(?:rm|rmdir)\s/mu);
  assert.doesNotMatch(helper, /^\s*chmod\s+0?7[1-7][0-7]\b/mu);
});
