#!/usr/bin/bash
set -Eeuo pipefail
umask 077

readonly PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

(( EUID == 0 )) || fail 'runner packet tests require Linux root'
for command_name in ip nft python3 sysctl; do
  command -v "$command_name" >/dev/null || fail "$command_name is required"
done

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
command -v node >/dev/null || fail 'node is required'
command -v docker >/dev/null || fail 'docker is required'
node "$repo_root/infra/tests/runner-egress-gateway.test.mjs"
node "$repo_root/infra/tests/runner-route-topology.test.mjs"

host_policy="$repo_root/infra/runner-vm/host-runner.nft"
guest_policy="$repo_root/infra/runner-vm/guest-runner.nft"
[[ -f "$host_policy" && -f "$guest_policy" ]] || fail 'runner firewall policies are missing'

suffix="${BASHPID:-$$}"
fw="cfw-$suffix"
app="cap-$suffix"
guest="cgu-$suffix"
peer="cpe-$suffix"
evil="cev-$suffix"
namespaces=("$fw" "$app" "$guest" "$peer" "$evil")
server4_pid=
server6_pid=
wrong_port_pid=
peer_server_pid=
evil_server_pid=
work="$(mktemp -d /tmp/codestead-packet-test.XXXXXX)"

cleanup() {
  local status=$?
  trap - EXIT HUP INT TERM
  [[ -n "$server4_pid" ]] && kill "$server4_pid" >/dev/null 2>&1 || true
  [[ -n "$server6_pid" ]] && kill "$server6_pid" >/dev/null 2>&1 || true
  [[ -n "$wrong_port_pid" ]] && kill "$wrong_port_pid" >/dev/null 2>&1 || true
  [[ -n "$peer_server_pid" ]] && kill "$peer_server_pid" >/dev/null 2>&1 || true
  [[ -n "$evil_server_pid" ]] && kill "$evil_server_pid" >/dev/null 2>&1 || true
  for namespace in "${namespaces[@]}"; do
    ip netns del "$namespace" >/dev/null 2>&1 || true
  done
  [[ -d "$work" && ! -L "$work" && "$work" == /tmp/codestead-packet-test.* ]] && rm -rf -- "$work"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

cat >"$work/server.py" <<'PY'
import socket
import sys

family = socket.AF_INET6 if sys.argv[1] == "6" else socket.AF_INET
port = int(sys.argv[2]) if len(sys.argv) > 2 else 4100
address = ("::", port) if family == socket.AF_INET6 else ("0.0.0.0", port)
with socket.socket(family, socket.SOCK_STREAM) as server:
    if family == socket.AF_INET6:
        server.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 1)
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind(address)
    server.listen(16)
    while True:
        connection, _ = server.accept()
        with connection:
            connection.settimeout(2)
            if connection.recv(16) == b"ping":
                connection.sendall(b"pong")
PY

cat >"$work/client.py" <<'PY'
import socket
import sys

host = sys.argv[1]
family = socket.AF_INET6 if ":" in host else socket.AF_INET
port = int(sys.argv[2]) if len(sys.argv) > 2 else 4100
source = sys.argv[3] if len(sys.argv) > 3 else None
try:
    with socket.socket(family, socket.SOCK_STREAM) as client:
        client.settimeout(1.2)
        if source is not None:
            client.bind((source, 0))
        client.connect((host, port))
        client.sendall(b"ping")
        if client.recv(16) != b"pong":
            raise OSError("unexpected response")
except OSError:
    raise SystemExit(1)
PY
chmod 0555 "$work/server.py" "$work/client.py"

for namespace in "${namespaces[@]}"; do
  ip netns add "$namespace"
  ip -n "$namespace" link set lo up
done

ip link add cdst-run0 type veth peer name app0
ip link set cdst-run0 netns "$fw"
ip link set app0 netns "$app"

ip link add guestport type veth peer name guest0
ip link set guestport netns "$fw"
ip link set guest0 netns "$guest"

ip link add peerport type veth peer name peer0
ip link set peerport netns "$fw"
ip link set peer0 netns "$peer"

ip link add evil0 type veth peer name evilpeer
ip link set evil0 netns "$fw"
ip link set evilpeer netns "$evil"

ip -n "$fw" link add virbr0 type bridge
ip -n "$fw" link set virbr0 up
ip -n "$fw" link set guestport master virbr0
ip -n "$fw" link set peerport master virbr0
ip -n "$fw" link set guestport up
ip -n "$fw" link set peerport up

ip -n "$fw" address add 172.29.40.1/24 dev cdst-run0
ip -n "$app" address add 172.29.40.2/24 dev app0
ip -n "$fw" address add 192.168.122.1/24 dev virbr0
ip -n "$guest" address add 192.168.122.12/24 dev guest0
ip -n "$app" address add 172.29.40.3/24 dev app0
ip -n "$peer" address add 192.168.122.13/24 dev peer0
ip -n "$fw" address add 10.55.0.1/24 dev evil0
ip -n "$evil" address add 10.55.0.2/24 dev evilpeer

ip -n "$fw" -6 address add fd29::1/64 dev cdst-run0
ip -n "$app" -6 address add fd29::2/64 dev app0
ip -n "$fw" -6 address add fd12::1/64 dev virbr0
ip -n "$guest" -6 address add fd12::12/64 dev guest0

for endpoint in \
  "$fw:cdst-run0" "$app:app0" "$guest:guest0" "$peer:peer0" "$fw:evil0" "$evil:evilpeer"; do
  namespace="${endpoint%%:*}"
  interface="${endpoint#*:}"
  ip -n "$namespace" link set "$interface" up
done

ip -n "$app" route add default via 172.29.40.1
ip -n "$guest" route add default via 192.168.122.1
ip -n "$evil" route add default via 10.55.0.1
ip -n "$app" -6 route add default via fd29::1
ip -n "$guest" -6 route add default via fd12::1
ip netns exec "$fw" sysctl -q -w net.ipv4.ip_forward=1 >/dev/null
ip netns exec "$fw" sysctl -q -w net.ipv6.conf.all.forwarding=1 >/dev/null

ip netns exec "$fw" nft --file "$host_policy"
ip netns exec "$guest" nft --file "$guest_policy"

ip netns exec "$guest" python3 "$work/server.py" 4 &
server4_pid=$!
ip netns exec "$guest" python3 "$work/server.py" 6 &
server6_pid=$!
ip netns exec "$guest" python3 "$work/server.py" 4 4200 &
wrong_port_pid=$!
ip netns exec "$peer" python3 "$work/server.py" 4 &
peer_server_pid=$!
ip netns exec "$evil" python3 "$work/server.py" 4 &
evil_server_pid=$!

for _ in {1..30}; do
  if ip netns exec "$fw" python3 "$work/client.py" 192.168.122.12; then
    ready=1
    break
  fi
  sleep 0.1
done
[[ "${ready:-0}" == 1 ]] || fail 'the guest test server did not become reachable from the exact host gateway'

for endpoint in 'guest 4200' 'peer 4100' 'evil 4100'; do
  read -r namespace_role port <<<"$endpoint"
  namespace="${!namespace_role}"
  ready=0
  for _ in {1..30}; do
    if ip netns exec "$namespace" python3 "$work/client.py" 127.0.0.1 "$port"; then
      ready=1
      break
    fi
    sleep 0.1
  done
  [[ "$ready" == 1 ]] || fail "negative-control server did not become reachable in $namespace_role on port $port"
done

ip netns exec "$app" python3 "$work/client.py" 192.168.122.12 ||
  fail 'the exact runner gateway source could not reach the runner API'
if ip netns exec "$app" python3 "$work/client.py" 192.168.122.12 4100 172.29.40.3; then
  fail 'a same-interface non-gateway source reached the runner API'
fi
if ip netns exec "$app" python3 "$work/client.py" 192.168.122.13; then
  fail 'the runner gateway reached a different guest destination'
fi
if ip netns exec "$app" python3 "$work/client.py" 192.168.122.12 4200; then
  fail 'the runner gateway reached an unreviewed guest port'
fi
if ip netns exec "$app" python3 "$work/client.py" 10.55.0.2; then
  fail 'the runner gateway reached a routed LAN or internet destination'
fi
if ip netns exec "$peer" python3 "$work/client.py" 192.168.122.12; then
  fail 'a peer guest reached the runner API directly'
fi
if ip netns exec "$evil" python3 "$work/client.py" 192.168.122.12; then
  fail 'an untrusted routed IPv4 client reached the runner API'
fi
if ip netns exec "$app" python3 "$work/client.py" fd12::12; then
  fail 'the runner gateway reached the runner API over an unreviewed IPv6 path'
fi

printf '%s\n' 'runner-firewall-packet-tests-ok'
