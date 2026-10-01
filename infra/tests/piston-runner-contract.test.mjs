import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "../..");
const read = (relative) => readFileSync(path.join(root, relative), "utf8");

const PISTON_IMAGE =
  "ghcr.io/engineer-man/piston@sha256:2f66b7456189c4d713aa986d98eccd0b6ee16d26c7ec5f21b30e942756fd127a";
const PACKAGES = {
  "gcc/10.2.0": "a3ffa0672b992ee772217c64080671f5a4ee1250fea19ac2c8d5205a5682bdb3",
  "java/15.0.2": "f695d4ae1a8c783a9bcdd31f23795a980d938e50260254cf6a95560622c092f7",
  "python/3.12.0": "abc40b3231fc7e713799da2cd79844545c72b3904a4d2ffcc28c4d133ed21d0b",
};

test("piston files exist", () => {
  for (const file of [
    "infra/piston/Dockerfile",
    "infra/piston/compose.yaml",
    "infra/piston/guest-piston.nft",
    "infra/piston/install-piston-guest.sh",
  ]) {
    assert.equal(existsSync(path.join(root, file)), true, `${file} is missing`);
  }
});

test("image pins the reviewed Piston digest and checksum-verifies every baked package", () => {
  const dockerfile = read("infra/piston/Dockerfile");
  assert.match(dockerfile, new RegExp(`^FROM ${PISTON_IMAGE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "m"));
  for (const [pkg, sha] of Object.entries(PACKAGES)) {
    assert.ok(dockerfile.includes(pkg.replace("/", " ")), `${pkg} is not baked`);
    assert.ok(dockerfile.includes(sha), `${pkg} checksum is not pinned`);
  }
  assert.match(dockerfile, /sha256sum -c/);
  assert.doesNotMatch(dockerfile, /:latest\b/);
});

test("guest compose keeps limits explicit and has no host mounts", () => {
  const compose = read("infra/piston/compose.yaml");
  const required = {
    PISTON_RUN_MEMORY_LIMIT: "268435456",
    PISTON_COMPILE_MEMORY_LIMIT: "536870912",
    PISTON_MAX_CONCURRENT_JOBS: "4",
    PISTON_OUTPUT_MAX_SIZE: "65536",
    PISTON_DISABLE_NETWORKING: "true",
    PISTON_MAX_PROCESS_COUNT: "32",
    PISTON_RUN_TIMEOUT: "3000",
    PISTON_COMPILE_TIMEOUT: "10000",
  };
  for (const [key, value] of Object.entries(required)) {
    assert.match(compose, new RegExp(`${key}: "${value}"`), `${key} must be ${value}`);
  }
  assert.match(compose, /PISTON_BIND_ADDRESS: "0\.0\.0\.0:4100"/, "Piston must listen on the reviewed runner port 4100");
  assert.match(compose, /network_mode: host/, "published ports would bypass the guest input/output chains");
  assert.doesNotMatch(compose, /^\s*ports:/m);
  assert.doesNotMatch(compose, /^\s*volumes:/m, "no host or named volumes");
  assert.doesNotMatch(compose, /docker\.sock/);
  assert.match(compose, /pull_policy: never/);
});

test("guest firewall denies all egress except replies and DHCP, and limits ingress to the gateway", () => {
  const rules = read("infra/piston/guest-piston.nft");
  assert.match(rules, /chain output \{ type filter hook output priority filter; policy drop; \}/);
  assert.match(rules, /chain input \{ type filter hook input priority filter; policy drop; \}/);
  assert.match(rules, /output ct state established,related accept/);
  assert.match(rules, /input ip saddr 172\.29\.40\.2 tcp dport 4100 accept/);
  assert.doesNotMatch(rules, /output .*tcp dport (80|443|53)/);
  assert.doesNotMatch(rules, /output .*udp dport 53/);
  assert.match(rules, /chain forward \{ type filter hook forward priority filter; policy drop; \}/);
});

test("installer loads a pre-built image and never pulls from the network", () => {
  const installer = read("infra/piston/install-piston-guest.sh");
  assert.match(installer, /^#!\/usr\/bin\/bash/);
  assert.match(installer, /docker load/);
  assert.match(installer, /sha256sum/);
  assert.doesNotMatch(installer, /docker (pull|compose pull)/);
  assert.match(installer, /nft -c -f/, "firewall syntax is checked before it is applied");
});
