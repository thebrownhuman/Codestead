#!/usr/bin/bash
set -Eeuo pipefail
umask 077

readonly PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

(( EUID == 0 )) || fail 'runner firewall behavior requires Linux root'
for command_name in ip nft python3 sha256sum; do
  command -v "$command_name" >/dev/null || fail "$command_name is required"
done

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
host_policy="$repo_root/infra/runner-vm/host-runner.nft"
guest_policy="$repo_root/infra/runner-vm/guest-runner.nft"
[[ -f "$host_policy" ]] || fail 'host runner policy is missing'
[[ -f "$guest_policy" ]] || fail 'guest runner policy is missing'

namespace="codestead-firewall-$$"
work="$(mktemp -d /tmp/codestead-firewall.XXXXXX)"
cleanup() {
  ip netns del "$namespace" >/dev/null 2>&1 || true
  [[ -d "$work" && ! -L "$work" && "$work" == /tmp/codestead-firewall.* ]] && rm -rf -- "$work"
}
trap cleanup EXIT HUP INT TERM

ip netns add "$namespace"
ip netns exec "$namespace" nft --check --file "$host_policy"
ip netns exec "$namespace" nft --file "$host_policy"
ip netns exec "$namespace" nft --numeric --stateless list table inet codestead_runner >"$work/first.rules"
ip netns exec "$namespace" nft --file "$host_policy"
ip netns exec "$namespace" nft --numeric --stateless list table inet codestead_runner >"$work/second.rules"
cmp -s -- "$work/first.rules" "$work/second.rules" || fail 'repeat apply changed the canonical host policy bytes'

ip netns exec "$namespace" nft --json list table inet codestead_runner >"$work/host.json"
HOST_RULESET="$work/host.json" /usr/bin/python3 - <<'PY'
import json
import os
from pathlib import Path

value = json.loads(Path(os.environ["HOST_RULESET"]).read_text(encoding="utf-8"))
objects = [entry for entry in value.get("nftables", []) if "metainfo" not in entry]
tables = [entry["table"] for entry in objects if "table" in entry]
chains = [entry["chain"] for entry in objects if "chain" in entry]
rules = [entry["rule"] for entry in objects if "rule" in entry]
if len(tables) != 1 or {key: tables[0].get(key) for key in ("family", "name")} != {
    "family": "inet", "name": "codestead_runner"
}:
    raise SystemExit("host table identity drifted")
if len(chains) != 1 or {key: chains[0].get(key) for key in ("family", "table", "name", "type", "hook", "prio", "policy")} != {
    "family": "inet", "table": "codestead_runner", "name": "forward", "type": "filter",
    "hook": "forward", "prio": 10, "policy": "accept",
}:
    raise SystemExit("host forward chain drifted")
if len(rules) != 5:
    raise SystemExit(f"host policy requires exactly four rules, observed {len(rules)}")
expressions = [rule.get("expr") for rule in rules]
serialized = [json.dumps(expr, separators=(",", ":"), sort_keys=True) for expr in expressions]
required = (
    ('"key":"iifname"', '"right":"cdst-run0"', '"right":"172.29.40.2"', '"right":"192.168.122.12"', '"right":4100', '"accept":null'),
    ('"key":"iifname"', '"right":"cdst-run0"', '"drop":null'),
    ('"right":"192.168.122.12"', '"right":4100', '"drop":null'),
    ('"key":"oifname"', '"right":"virbr0"', '"field":"dport"', '"right":4100', '"drop":null'),
    ('"key":"state"', '"established"', '"related"', '"accept":null'),
)
for index, fragments in enumerate(required):
    if not all(fragment in serialized[index] for fragment in fragments):
        raise SystemExit(f"host rule {index + 1} drifted: {serialized[index]}")
PY

ip netns exec "$namespace" nft --check --file "$guest_policy"
ip netns exec "$namespace" nft --file "$guest_policy"
ip netns exec "$namespace" nft --file "$guest_policy"
ip netns exec "$namespace" nft --numeric --stateless list table inet codestead_runner_guest >"$work/guest.rules"
grep -Fq 'policy drop' "$work/guest.rules" || fail 'guest input policy is not default-drop'
grep -Fq 'ip saddr 192.168.122.1 tcp dport 4100 accept' "$work/guest.rules" || fail 'guest API does not admit the exact host gateway'
grep -Fq 'ip saddr 172.29.40.2 tcp dport 4100 accept' "$work/guest.rules" || fail 'guest API does not admit the exact runner gateway source'
! grep -Eq 'ip6 .*dport 4100 .*accept' "$work/guest.rules" || fail 'guest policy exposes the API over IPv6'

unit="$repo_root/infra/systemd/learncoding-runner-firewall.service"
[[ -f "$unit" ]] || fail 'host firewall unit is missing'
for directive in \
  'User=root' \
  'Group=root' \
  'UMask=0077' \
  'NoNewPrivileges=true' \
  'CapabilityBoundingSet=CAP_NET_ADMIN' \
  'AmbientCapabilities=CAP_NET_ADMIN' \
  'PrivateDevices=true' \
  'PrivateTmp=true' \
  'ProtectClock=true' \
  'ProtectControlGroups=true' \
  'ProtectHome=true' \
  'ProtectKernelModules=true' \
  'ProtectKernelTunables=true' \
  'ProtectSystem=strict' \
  'RestrictAddressFamilies=AF_NETLINK AF_UNIX' \
  'RestrictNamespaces=true' \
  'RestrictRealtime=true' \
  'RestrictSUIDSGID=true' \
  'LockPersonality=true' \
  'MemoryDenyWriteExecute=true' \
  'SystemCallArchitectures=native'; do
  [[ "$(grep -Fxc -- "$directive" "$unit")" == 1 ]] || fail "firewall unit lacks exact sandbox directive: $directive"
done
! grep -Eq '^ExecStop=' "$unit" || fail 'stopping the firewall unit must not remove the fail-closed policy'
grep -Fxq 'ExecReload=/usr/sbin/nft --file /opt/learncoding/infra/runner-vm/host-runner.nft' "$unit" ||
  fail 'firewall unit lacks atomic idempotent reload'

printf '%s\n' 'runner-firewall-tests-ok'
