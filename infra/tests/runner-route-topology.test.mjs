import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";

const root = path.resolve(import.meta.dirname, "../..");
const fixture = path.join(root, "infra/tests/fixtures/runner-route.compose.yaml");
const image =
  "busybox@sha256:222ad6d973c0d198014546a65cd02c5fdedcc172123c5b4c2bf0af636550bd94";
const suffix = randomBytes(5).toString("hex");
const project = `codestead-route-${suffix}`;
const bridge = `cdstrt${suffix.slice(0, 8)}`;
const environment = {
  ...process.env,
  ROUTE_TEST_PROJECT: project,
  ROUTE_TEST_BRIDGE: bridge,
};
let composeStarted = false;

function run(command, args, { allowFailure = false, input } = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    env: environment,
    input,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (!allowFailure && result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed (${result.status}): ${(
        result.stderr || result.stdout
      ).trim()}`,
    );
  }
  return result;
}

function docker(...args) {
  return run("docker", args);
}

function compose(...args) {
  return docker("compose", "-f", fixture, ...args);
}

function invariant(value, message) {
  if (!value) throw new Error(message);
}

function route(service, destination) {
  return compose(
    "exec",
    "-T",
    service,
    "ip",
    "-4",
    "route",
    "get",
    destination,
  ).stdout.trim();
}

function desiredRunnerRoute(value, source) {
  return (
    /^192\.168\.122\.12 via 172\.29\.40\.1 dev runner-egress /u.test(value) &&
    new RegExp(`(?:^| )src ${source}(?: |$)`, "u").test(value)
  );
}

function cleanup() {
  if (composeStarted) {
    compose("down", "--remove-orphans", "--timeout", "1");
    composeStarted = false;
  }
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    try {
      cleanup();
    } finally {
      process.kill(process.pid, signal);
    }
  });
}

try {
  const server = JSON.parse(docker("info", "--format", "{{json .}}").stdout);
  invariant(server.OSType === "linux", "runner route topology requires a Linux Docker engine");

  const imageAvailable = run("docker", ["image", "inspect", image], { allowFailure: true });
  if (imageAvailable.status !== 0) {
    docker("pull", image);
  }

  const rendered = JSON.parse(compose("config", "--format", "json").stdout);
  invariant(
    rendered.services?.app?.networks?.frontend?.gw_priority === 100,
    "fixture app must preserve frontend as its default/provider egress",
  );
  invariant(
    rendered.services?.["runner-egress-gateway"]?.networks?.["runner-egress"]
      ?.gw_priority === 100,
    "fixture gateway must select runner-egress as its default route",
  );
  invariant(
    rendered.networks?.["runner-egress"]?.driver_opts?.[
      "com.docker.network.bridge.name"
    ] === bridge,
    "fixture runner bridge name did not render exactly",
  );

  composeStarted = true;
  compose("up", "--detach", "--wait", "--wait-timeout", "30");

  const appToGateway = route("app", "172.29.41.2");
  invariant(
    /^172\.29\.41\.2 dev runner-client /u.test(appToGateway) &&
      /(?:^| )src 172\.29\.41\.[0-9]+(?: |$)/u.test(appToGateway),
    `app did not use runner-client for the gateway: ${appToGateway}`,
  );

  const gatewayToRunner = route("runner-egress-gateway", "192.168.122.12");
  invariant(
    desiredRunnerRoute(gatewayToRunner, "172.29.40.2"),
    `gateway did not use its reviewed runner-egress source: ${gatewayToRunner}`,
  );

  const legacyRoute = route("legacy-direct-app", "192.168.122.12");
  invariant(
    !desiredRunnerRoute(legacyRoute, "172.29.40.2") &&
      / dev frontend /u.test(legacyRoute),
    `legacy direct attachment unexpectedly satisfied the route contract: ${legacyRoute}`,
  );

  const wrongPriorityRoute = route("wrong-priority-gateway", "192.168.122.12");
  invariant(
    !desiredRunnerRoute(wrongPriorityRoute, "172.29.40.3") &&
      / dev frontend /u.test(wrongPriorityRoute),
    `wrong gateway priority unexpectedly satisfied the route contract: ${wrongPriorityRoute}`,
  );

  const gatewayContainer = docker(
    "compose",
    "-f",
    fixture,
    "ps",
    "--quiet",
    "runner-egress-gateway",
  ).stdout.trim();
  invariant(gatewayContainer.length > 0, "gateway container identity is missing");
  const gatewayInspect = JSON.parse(docker("inspect", gatewayContainer).stdout)[0];
  invariant(
    JSON.stringify(gatewayInspect.HostConfig?.CapDrop ?? []) === JSON.stringify(["ALL"]),
    "gateway route fixture retained Linux capabilities",
  );
  invariant(
    (gatewayInspect.HostConfig?.SecurityOpt ?? []).some((value) =>
      value === "no-new-privileges" || value === "no-new-privileges:true"
    ),
    "gateway route fixture omitted no-new-privileges",
  );

  const routeNetwork = JSON.parse(
    docker("network", "inspect", `${project}_runner-egress`).stdout,
  )[0];
  invariant(
    routeNetwork.Options?.["com.docker.network.bridge.name"] === bridge,
    "Docker did not create the requested runner-egress host bridge",
  );
  const hostBridge = docker(
    "run",
    "--rm",
    "--network",
    "host",
    "--read-only",
    "--cap-drop",
    "ALL",
    image,
    "ip",
    "link",
    "show",
    "dev",
    bridge,
  ).stdout;
  invariant(hostBridge.includes(bridge), "runner-egress bridge is absent from the Docker host namespace");

  process.stdout.write(
    JSON.stringify({
      status: "pass",
      appGatewayInterface: "runner-client",
      gatewayRunnerInterface: "runner-egress",
      gatewayRunnerSource: "172.29.40.2",
      hostBridge: bridge,
      legacyDirectAttachmentRejected: true,
      wrongPriorityRejected: true,
    }) + "\n",
  );
} finally {
  cleanup();
  const leftovers = docker(
    "ps",
    "--all",
    "--quiet",
    "--filter",
    `label=com.docker.compose.project=${project}`,
  ).stdout.trim();
  invariant(leftovers === "", "disposable route containers survived cleanup");
  const leftoverNetwork = run(
    "docker",
    ["network", "inspect", `${project}_runner-egress`],
    { allowFailure: true },
  );
  invariant(leftoverNetwork.status !== 0, "disposable route network survived cleanup");
}
