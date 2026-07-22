#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
PATH=/usr/bin:/bin
export PATH

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
bash_bin=/usr/bin/bash
env_bin=/usr/bin/env
sha256_bin=/usr/bin/sha256sum
perl_bin=/usr/bin/perl
node_bin=/usr/bin/node
checker="$repo_root/infra/ops/check-recovery.sh"
checker_helper="$repo_root/infra/ops/recovery-checker.py"
checker_baseline_module="$repo_root/infra/ops/existing_container_baseline.py"
checker_shebang='#!/usr/bin/env bash'
checker_reviewed_sha256='a686429336e44304b024b75adf3ab42b5a0f95a0a642bda5995e664e6c872668'
checker_helper_reviewed_sha256='6a41fedb360b27b9afd2cb8b8e2e82c470be65b2cf180c969b21104fb4c7eb52'
checker_baseline_module_reviewed_sha256='62be75b9e8be5f2b5baf002eb57133d152135ad95c3c3f952f22af317dc045d2'
tmp_base="$(cd /tmp && pwd -P)"
work="$(mktemp -d "$tmp_base/power-recovery-check.XXXXXX")"
work="$(cd "$work" && pwd -P)"
[[ ! -L "$work" && "$work" == "$tmp_base"/* ]] || {
  echo 'FAIL: recovery checker fixture escaped its verified temporary root' >&2
  exit 1
}
chmod 0700 "$work"
cleanup() {
  if [[ -n "${work:-}" && -d "$work" && ! -L "$work" && "$work" == "$tmp_base"/* ]]; then
    rm -rf -- "$work"
  fi
}
trap cleanup EXIT

if [[ ! -f "$checker" ]]; then
  echo 'power recovery checker contract failed:' >&2
  echo '- missing later-task production asset: infra/ops/check-recovery.sh' >&2
  exit 1
fi
if [[ ! -f "$checker_helper" ]]; then
  echo 'power recovery checker contract failed:' >&2
  echo '- missing descriptor-safe recovery checker helper: infra/ops/recovery-checker.py' >&2
  exit 1
fi
if [[ ! -f "$checker_baseline_module" ]]; then
  echo 'power recovery checker contract failed:' >&2
  echo '- missing protected container baseline module: infra/ops/existing_container_baseline.py' >&2
  exit 1
fi

if [[ "$(/usr/bin/uname -s 2>/dev/null || true)" != Linux ]]; then
  echo 'FAIL: authoritative recovery checker contract requires Linux Bubblewrap containment' >&2
  exit 1
fi

if (( EUID != 0 )); then
  if command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then
    cleanup
    trap - EXIT
    exec sudo -n "$bash_bin" "$repo_root/infra/tests/power-recovery-check.test.sh"
  fi
  echo 'FAIL: power recovery checker contract requires passwordless sudo for root-owned fixture metadata' >&2
  exit 1
fi

fail() {
  echo "FAIL: $*" >&2
  exit 1
}
[[ -f "$node_bin" && -x "$node_bin" ]] || fail 'fixed /usr/bin/node is required for recovery JSON validation'
python_bin=/usr/bin/python3
[[ -f "$python_bin" && -x "$python_bin" ]] || fail 'fixed /usr/bin/python3 is required for structural recovery validation'
[[ "$checker_helper_reviewed_sha256" =~ ^[0-9a-f]{64}$ ]] ||
  fail 'recovery checker helper reviewed SHA is not finalized'
checker_helper_digest_line="$("$sha256_bin" -- "$checker_helper")" ||
  fail 'could not hash the recovery checker helper'
[[ "${checker_helper_digest_line%% *}" == "$checker_helper_reviewed_sha256" ]] ||
  fail 'recovery checker helper bytes do not match the reviewed SHA'
[[ "$checker_baseline_module_reviewed_sha256" =~ ^[0-9a-f]{64}$ ]] ||
  fail 'container baseline module reviewed SHA is not finalized'
checker_baseline_module_digest_line="$("$sha256_bin" -- "$checker_baseline_module")" ||
  fail 'could not hash the container baseline module'
[[ "${checker_baseline_module_digest_line%% *}" == "$checker_baseline_module_reviewed_sha256" ]] ||
  fail 'container baseline module bytes do not match the reviewed SHA'
run_helper_unit_tests() {
  local staged_helper="$1"
  CHECKER_HELPER="$staged_helper" RECOVERY_HELPER_TEST_ROOT="$work/helper-unit" "$python_bin" - <<'PY'
import hashlib
import hmac
import importlib.util
import json
import os
import pathlib
import shutil
import stat
import sys

helper_path = pathlib.Path(os.environ["CHECKER_HELPER"])
sys.path.insert(0, str(helper_path.parent))
spec = importlib.util.spec_from_file_location("recovery_checker", helper_path)
assert spec is not None and spec.loader is not None
helper = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = helper
spec.loader.exec_module(helper)

expected = helper.EXPECTED_COMPOSE_SERVICES
assert list(expected.items()) == [
    ("postgres", "healthy"),
    ("app", "healthy"),
    ("runner-egress-gateway", "healthy"),
    ("mail-worker", "healthy"),
    ("reward-worker", "healthy"),
    ("regrade-worker", "healthy"),
    ("exam-finalization-worker", "healthy"),
    ("practice-runner-recovery-worker", "healthy"),
    ("project-review-correction-worker", "healthy"),
    ("file-erasure-worker", "healthy"),
    ("cloudflared", "healthy"),
]
def compose_line(service, *, project="learncoding", name=None, state="running", health=None, extra=None):
    value = {
        "ID": f"id-{service}",
        "Name": name or f"learncoding-{service}-1",
        "Project": project,
        "Service": service,
        "State": state,
        "Health": expected[service] if health is None else health,
    }
    if extra is not None:
        value["extra"] = extra
    return json.dumps(value, separators=(",", ":"))

valid_lines = [compose_line(service, extra={"untrusted": "ignored"}) for service in expected]
valid = ("\n".join(valid_lines) + "\n").encode()
helper.validate_compose_json_lines(valid)

invalid_compose = [
    b'{"nested":{"Project":"learncoding","Name":"learncoding-app-1","Service":"app","State":"running","Health":"healthy"}}\n',
    valid.replace(b'}\n', b',BROKEN}\n', 1),
    valid + compose_line("app").encode() + b"\n",
    valid.replace(b'"State":"running"', b'"State":"exited"', 1),
    valid.replace(b'"Service":"postgres"', b'"Service":"app"', 1),
    valid.replace(b'"Name":"learncoding-postgres-1"', b'"Name":"foreign-postgres-1"', 1),
    valid.replace(b'"Project":"learncoding"', b'"Project":"foreign"', 1),
    valid.replace(b'"Health":"healthy"', b'"Health":"unhealthy"', 1),
    valid.replace(b'"State":"running"', b'"NonFinite":NaN,"State":"running"', 1),
    valid_lines[0].replace('"Project":"learncoding"', '"Project":"learncoding","Project":"learncoding"').encode() + b"\n" + ("\n".join(valid_lines[1:]) + "\n").encode(),
    ("\n".join(valid_lines[:-1]) + "\n").encode(),
    valid + b'{"Project":"learncoding","Name":"learncoding-unexpected-1","Service":"unexpected","State":"running","Health":""}\n',
]
for candidate in invalid_compose:
    try:
        helper.validate_compose_json_lines(candidate)
    except helper.ContractError:
        pass
    else:
        raise AssertionError(f"compose mutant was accepted: {candidate[:80]!r}")

valid_services = ("\n".join(expected) + "\n").encode()
helper.validate_compose_services(valid_services)
for candidate in [
    valid_services + b"clamav\n",
    valid_services + next(iter(expected)).encode() + b"\n",
    ("\n".join(list(expected)[:-1]) + "\n").encode(),
    valid_services.replace(b"app\n", b"app\r\n", 1),
    b"app mail-worker\n",
]:
    try:
        helper.validate_compose_services(candidate)
    except helper.ContractError:
        pass
    else:
        raise AssertionError(f"Compose rendered-model mutant was accepted: {candidate!r}")

for candidate in [
    b'{"x":1e999}',
    b'{"x":-1e999}',
    b'{"nested":[0,{"x":1e999}]}',
    b'{"x":1e999999999999999999999999999999999999}',
    b'{"x":1.' + (b"0" * 1024) + b'}',
]:
    try:
        helper._json_loads_exact(candidate)
    except helper.ContractError:
        pass
    else:
        raise AssertionError(f"unbounded JSON number was accepted: {candidate[:80]!r}")
worker_payload = helper.encode_result(
    helper.result_payload(helper.ProbeState(), recovered=False, timed_out=False, elapsed=0)
)
overflowed_worker_payload = worker_payload.replace(b'"elapsedSeconds":0', b'"elapsedSeconds":1e999')
try:
    helper._validate_worker_payload(overflowed_worker_payload)
except helper.ContractError:
    pass
else:
    raise AssertionError("worker numeric overflow was accepted")

configuration = helper.parse_runtime_environment(
    b"APP_URL=https://pilot.example.test\n"
    b"RUNNER_BASE_URL=http://192.168.122.12:4100\n"
    b"LEARN_DATA_ROOT=/srv/codestead-data\n"
    b"UPLOADS_ENABLED=false\n"
    b"COMPOSE_PROFILES=\n"
)
assert configuration.public_url == "https://pilot.example.test/health/ready"
assert configuration.runner_base == "http://192.168.122.12:4100"
assert configuration.postgres_data == "/srv/codestead-data/postgres"
for candidate in [
    b"RUNNER_BASE_URL=http://192.168.122.12:4100\n",
    b"APP_URL=https://pilot.example.test\n",
    b"APP_URL=https://pilot.example.test\nAPP_URL=https://other.example.test\nRUNNER_BASE_URL=http://192.168.122.12:4100\n",
    b"APP_URL=http://pilot.example.test\nRUNNER_BASE_URL=http://192.168.122.12:4100\n",
    b"APP_URL=https://pilot.example.test/path\nRUNNER_BASE_URL=http://192.168.122.12:4100\n",
    b"APP_URL=https://pilot.example.test\nRUNNER_BASE_URL=http://10.20.0.12:4100\n",
    b"APP_URL=https://pilot.example.test\nRUNNER_BASE_URL=http://192.168.122.12:4100\nLEARN_DATA_ROOT=relative\n",
    b"APP_URL=https://pilot.example.test\nRUNNER_BASE_URL=http://192.168.122.12:4100\nUPLOADS_ENABLED=true\nCOMPOSE_PROFILES=\n",
    b"APP_URL=https://pilot.example.test\nRUNNER_BASE_URL=http://192.168.122.12:4100\nUPLOADS_ENABLED=false\nCOMPOSE_PROFILES=uploads\n",
    b"APP_URL=https://pilot.example.test\nRUNNER_BASE_URL=http://192.168.122.12:4100\nUPLOADS_ENABLED=false\nCOMPOSE_PROFILES=operations\n",
    b"APP_URL=https://pilot.example.test\nRUNNER_BASE_URL=http://192.168.122.12:4100\nUPLOADS_ENABLED=false\nCOMPOSE_PROFILES=*\n",
    b"APP_URL=https://pilot.example.test\nRUNNER_BASE_URL=http://192.168.122.12:4100\nUPLOADS_ENABLED=false\nCOMPOSE_PROFILES=\nCOMPOSE_PROFILES=\n",
    b"APP_URL=https://pilot.example.test\nRUNNER_BASE_URL=http://192.168.122.12:4100\nUPLOADS_ENABLED=false\nCOMPOSE_PROFILES= \n",
    b"APP_URL=https://pilot.example.test\nRUNNER_BASE_URL=http://192.168.122.12:4100\nUPLOADS_ENABLED=false\n",
    b"APP_URL=https://pilot.example.test\nRUNNER_BASE_URL=http://192.168.122.12:4100\nCOMPOSE_PROFILES=\n",
]:
    try:
        helper.parse_runtime_environment(candidate)
    except helper.ContractError:
        pass
    else:
        raise AssertionError(f"environment mutant was accepted: {candidate!r}")

csp = helper.EXPECTED_CONTENT_SECURITY_POLICY
public_headers = (
    "HTTP/2 200\r\n"
    "strict-transport-security: max-age=31536000\r\n"
    f"content-security-policy: {csp}\r\n"
    "x-content-type-options: nosniff\r\n"
    "cache-control: no-store\r\n"
    "content-type: application/json; charset=utf-8\r\n\r\n"
).encode()
helper.validate_public_response(200, public_headers, b'{"status":"ready"}')
for candidate in [
    public_headers.replace(b"\r\n", b"\n"),
    public_headers.replace(b"\r\n", b"\n", 1),
    public_headers.replace(b"\r\n", b"\r", 1),
    public_headers.replace(b"cache-control: no-store", b"cache-control: no\x01store"),
    public_headers + b"HTTP/1.1 200 OK\r\n\r\n",
    public_headers[:-2],
]:
    try:
        helper.validate_public_response(200, candidate, b'{"status":"ready"}')
    except helper.ContractError:
        pass
    else:
        raise AssertionError(f"malformed HTTP framing was accepted: {candidate[:80]!r}")
for status_code, headers, body in [
    (201, public_headers.replace(b" 200", b" 201", 1), b'{"status":"ready"}'),
    (200, public_headers, b'{"status":"ready"}\n'),
    (200, public_headers, b'{"status":"ready"}\x00'),
    (200, public_headers.replace(b"max-age=31536000", b"max-age=0"), b'{"status":"ready"}'),
    (200, public_headers.replace(b"max-age=31536000", b"max-age=999999999999"), b'{"status":"ready"}'),
    (200, public_headers.replace(csp.encode(), b"default-src 'self'"), b'{"status":"ready"}'),
    (200, public_headers.replace(b"application/json; charset=utf-8", b"application/jsonp"), b'{"status":"ready"}'),
    (200, public_headers.replace(b"charset=utf-8", b"charset=bad value"), b'{"status":"ready"}'),
    (200, public_headers.replace(b"charset=utf-8", b"charset=utf-8; CHARSET=\"utf-8\""), b'{"status":"ready"}'),
]:
    try:
        helper.validate_public_response(status_code, headers, body)
    except helper.ContractError:
        pass
    else:
        raise AssertionError("public HTTPS mutant was accepted")

secret = b"unit-test-runner-secret-at-least-32-bytes"
assert helper.normalize_runner_secret(secret + b"\n") == secret
for malformed_secret in (b"short\n", secret + b"\r\n", secret + b"\nembedded", b"\xff" * 32):
    try:
        helper.normalize_runner_secret(malformed_secret)
    except helper.ContractError:
        pass
    else:
        raise AssertionError("malformed runner secret was accepted")
challenge = "recovery-0123456789abcdef0123456789abcdef"
body = b'{"status":"ok","queueDepth":0,"activeJobs":0,"concurrency":2,"generatedAtEpoch":1784116800}'
body_hash = hashlib.sha256(body).hexdigest()
signature = "sha256=" + hmac.new(secret, f"{challenge}\n200\n{body_hash}".encode(), hashlib.sha256).hexdigest()
runner_headers = (
    "HTTP/1.1 200 OK\r\n"
    f"x-request-id: {challenge}\r\n"
    f"x-runner-response-signature: {signature}\r\n"
    "content-type: application/json; charset=utf-8\r\n"
    "cache-control: no-store\r\n"
    "x-content-type-options: nosniff\r\n\r\n"
).encode()
helper.validate_runner_response(200, runner_headers, body, challenge, secret, 1784116800, 1784116800)
runner_mutants = [
    (201, runner_headers.replace(b" 200", b" 201", 1), body, challenge, 1784116800, 1784116800),
    (200, runner_headers.replace(challenge.encode(), b"recovery-ffffffffffffffffffffffffffffffff", 1), body, challenge, 1784116800, 1784116800),
    (200, runner_headers, body + b"\n", challenge, 1784116800, 1784116800),
    (200, runner_headers, body + b"\x00", challenge, 1784116800, 1784116800),
    (200, runner_headers, body.replace(b'"concurrency":2', b'"concurrency":3'), challenge, 1784116800, 1784116800),
    (200, runner_headers, body.replace(b'"concurrency":2', b'"concurrency":22222222222222222222'), challenge, 1784116800, 1784116800),
    (200, runner_headers, body.replace(b"1784116800", b"1784116799"), challenge, 1784116800, 1784116800),
    (200, runner_headers, body, challenge, 1784116800, 1784116831),
]
for status_code, headers, candidate_body, supplied_challenge, started, now in runner_mutants:
    try:
        helper.validate_runner_response(status_code, headers, candidate_body, supplied_challenge, secret, started, now)
    except helper.ContractError:
        pass
    else:
        raise AssertionError("runner response mutant was accepted")

runner_gid_environment = "RECOVERY_CHECK_TEST_RUNNER_SECRET_GID"
os.environ.pop(runner_gid_environment, None)
assert helper._runner_secret_expected_gid(test_mode=False) == 2000
assert helper._runner_secret_expected_gid(test_mode=True) == 2000
os.environ[runner_gid_environment] = "65534"
assert helper._runner_secret_expected_gid(test_mode=True) == 65534
assert helper._runner_secret_expected_gid(test_mode=False) == 2000
for malformed_gid in ("-1", "2000", "065534", "65535", "65534x"):
    os.environ[runner_gid_environment] = malformed_gid
    try:
        helper._runner_secret_expected_gid(test_mode=True)
    except helper.ContractError:
        pass
    else:
        raise AssertionError(f"unsafe test runner-secret GID was accepted: {malformed_gid!r}")
    assert helper._runner_secret_expected_gid(test_mode=False) == 2000
os.environ.pop(runner_gid_environment, None)

root = pathlib.Path(os.environ["RECOVERY_HELPER_TEST_ROOT"])
shutil.rmtree(root, ignore_errors=True)
target = root / "etc" / "learncoding" / "protected"
target.parent.mkdir(parents=True, mode=0o700)
for parent in [root, root / "etc", root / "etc" / "learncoding"]:
    os.chmod(parent, 0o700)
target.write_bytes(b"reviewed-bytes")
os.chmod(target, 0o600)
os.chown(target, 0, 0)
assert helper.read_protected_file(str(root), "etc/learncoding/protected", 0, 0, 0o600, 64) == b"reviewed-bytes"

os.chmod(target.parent, 0o770)
try:
    helper.read_protected_file(str(root), "etc/learncoding/protected", 0, 0, 0o600, 64)
except helper.ContractError:
    pass
else:
    raise AssertionError("writable protected-file ancestor was accepted")
os.chmod(target.parent, 0o700)

backup = target.with_name("protected.original")
def swap_after_open():
    target.rename(backup)
    target.write_bytes(b"attacker-bytes")
    os.chmod(target, 0o600)
    os.chown(target, 0, 0)
assert helper.read_protected_file(
    str(root), "etc/learncoding/protected", 0, 0, 0o600, 64, _after_open=swap_after_open
) == b"reviewed-bytes"
target.unlink()
backup.rename(target)

retained = helper.open_protected_file(
    str(root), "etc/learncoding/protected", 0, 0, 0o600, 64
)
target.rename(backup)
target.write_bytes(b"attacker-bytes")
os.chmod(target, 0o600)
os.chown(target, 0, 0)
with open(retained.proc_path, "rb", buffering=0) as retained_stream:
    assert retained_stream.read() == b"reviewed-bytes"
try:
    retained.verify_current()
except helper.ContractError:
    pass
else:
    raise AssertionError("atomic protected-file replacement escaped final revalidation")
retained.close()
retained.close()
target.unlink()
backup.rename(target)

def mutate_in_place_after_open():
    target.write_bytes(b"mutated-bytes!")
    os.chmod(target, 0o600)
    os.chown(target, 0, 0)
try:
    helper.read_protected_file(
        str(root), "etc/learncoding/protected", 0, 0, 0o600, 64,
        _after_open=mutate_in_place_after_open,
    )
except helper.ContractError:
    pass
else:
    raise AssertionError("in-place protected-file race was accepted")
target.write_bytes(b"reviewed-bytes")
os.chmod(target, 0o600)
os.chown(target, 0, 0)

sealed = helper.open_protected_file(
    str(root), "etc/learncoding/protected", 0, 0, 0o600, 64
)
sealed.verify_current()
try:
    os.write(sealed.descriptor, b"x")
except OSError:
    pass
else:
    raise AssertionError("protected Compose snapshot is writable")
target.write_bytes(b"mutated-bytes!")
os.chmod(target, 0o600)
os.chown(target, 0, 0)
target.write_bytes(b"reviewed-bytes")
os.chmod(target, 0o600)
os.chown(target, 0, 0)
try:
    sealed.verify_current()
except helper.ContractError:
    pass
else:
    raise AssertionError("change-and-restore escaped final protected-file revalidation")
sealed.close()

real_close = helper.os.close
failed_once = False
def close_then_report_failure(descriptor):
    global failed_once
    real_close(descriptor)
    if not failed_once:
        failed_once = True
        raise OSError("injected close failure")
helper.os.close = close_then_report_failure
try:
    helper.read_protected_file(str(root), "etc/learncoding/protected", 0, 0, 0o600, 64)
except helper.ContractError:
    pass
else:
    raise AssertionError("protected descriptor cleanup failure was ignored")
finally:
    helper.os.close = real_close

real_parent = root / "real-parent"
real_parent.mkdir(mode=0o700)
(real_parent / "value").write_bytes(b"x")
os.chmod(real_parent / "value", 0o600)
(root / "symlink-parent").symlink_to(real_parent, target_is_directory=True)
try:
    helper.read_protected_file(str(root), "symlink-parent/value", 0, 0, 0o600, 64)
except helper.ContractError:
    pass
else:
    raise AssertionError("symlink protected-file ancestor was accepted")

valid_domain_xml = b"""<domain type='kvm'><name>codestead-runner</name><devices>
<interface type='network'><mac address='52:54:00:20:00:12'/>
<source network='default'/><model type='virtio'/><target dev='vnet0'/></interface>
</devices></domain>"""
helper.validate_runner_domain_xml(valid_domain_xml)
helper.validate_runner_domain_xml(
    valid_domain_xml.replace(b"<domain type='kvm'>", b"<domain type='kvm' id='7'>", 1),
    live=True,
)
for candidate in [
    valid_domain_xml.replace(b"type='kvm'", b"type='qemu'", 1),
    valid_domain_xml.replace(b" type='kvm'", b"", 1),
    valid_domain_xml.replace(b"type='kvm'", b"type='kvm' type='kvm'", 1),
    valid_domain_xml.replace(b"type='kvm'", b"type='kvm' emulator='unreviewed'", 1),
    valid_domain_xml.replace(b"type='network'", b"type='direct'", 1),
    valid_domain_xml.replace(b"type='network'", b"type='bridge'", 1),
    valid_domain_xml.replace(b"network='default'", b"network='other'", 1),
    valid_domain_xml.replace(b"type='virtio'", b"type='e1000'", 1),
    valid_domain_xml.replace(b"52:54:00:20:00:12", b"52:54:00:12:34:56", 1),
    valid_domain_xml.replace(b"</devices>", b"<hostdev mode='subsystem' type='pci'/></devices>", 1),
    valid_domain_xml.replace(b"</devices>", b"<interface type='network'><source network='default'/><model type='virtio'/></interface></devices>", 1),
    valid_domain_xml.replace(b"<source network='default'/>", b"<source network='default'/><source network='default'/>", 1),
    valid_domain_xml.replace(b"<domain type='kvm'>", b"<domain xmlns='urn:unreviewed' type='kvm'>", 1),
    b"<!DOCTYPE domain [<!ENTITY xxe SYSTEM 'file:///etc/shadow'>]>" + valid_domain_xml,
    b"<domain>",
    b"<domain>" + (b"x" * (helper.MAXIMUM_XML_BYTES + 1)) + b"</domain>",
]:
    try:
        helper.validate_runner_domain_xml(candidate)
    except helper.ContractError:
        pass
    else:
        raise AssertionError(f"runner domain XML mutant was accepted: {candidate!r}")
for candidate in [
    valid_domain_xml.replace(b"<domain type='kvm'>", b"<domain type='kvm' id='-1'>", 1),
    valid_domain_xml.replace(b"<domain type='kvm'>", b"<domain type='kvm' id='07'>", 1),
    valid_domain_xml.replace(b"<domain type='kvm'>", b"<domain type='kvm' id='4294967295'>", 1),
    valid_domain_xml.replace(b"<domain type='kvm'>", b"<domain type='kvm' id='7' emulator='unreviewed'>", 1),
]:
    try:
        helper.validate_runner_domain_xml(candidate, live=True)
    except helper.ContractError:
        pass
    else:
        raise AssertionError(f"runner live domain root mutant was accepted: {candidate!r}")

valid_network_xml = b"""<network><name>default</name><forward mode='nat'/><bridge name='virbr0'/>
<ip address='192.168.122.1' netmask='255.255.255.0'><dhcp>
<range start='192.168.122.2' end='192.168.122.254'/>
<host mac='52:54:00:20:00:12' name='codestead-runner' ip='192.168.122.12'/>
</dhcp></ip></network>"""
helper.validate_runner_network_xml(valid_network_xml)
helper.validate_runner_network_xml(
    valid_network_xml.replace(b"<network>", b"<network connections='1'>", 1),
    live=True,
)
helper.validate_runner_network_xml(
    valid_network_xml.replace(
        b"<host mac='52:54:00:20:00:12'",
        b"<host mac='52:54:00:20:00:13' name='unrelated' ip='192.168.122.13'/><host mac='52:54:00:20:00:12'",
        1,
    )
)
for candidate in [
    valid_network_xml.replace(b"<network>", b"<network ipv6='yes'>", 1),
    valid_network_xml.replace(b"<network>", b"<network trustGuestRxFilters='yes'>", 1),
    valid_network_xml.replace(b"<network>", b"<network connections='1'>", 1),
    valid_network_xml.replace(b"mode='nat'", b"mode='route'", 1),
    valid_network_xml.replace(b"mode='nat'", b"mode='bridge'", 1),
    valid_network_xml.replace(b"mode='nat'", b"mode='open'", 1),
    valid_network_xml.replace(b"<forward mode='nat'/>", b"", 1),
    valid_network_xml.replace(b"192.168.122.1", b"10.20.0.1", 1),
    valid_network_xml.replace(b"255.255.255.0", b"255.255.0.0", 1),
    valid_network_xml.replace(b"<dhcp>", b"<dhcp><host mac='52:54:00:20:00:13' name='other' ip='192.168.122.12'/>", 1),
    valid_network_xml.replace(
        b"<host mac='52:54:00:20:00:12' name='codestead-runner' ip='192.168.122.12'/>",
        b"<host mac='52:54:00:20:00:12' name='codestead-runner' ip='192.168.122.12'/><host mac='52:54:00:20:00:12' name='codestead-runner' ip='192.168.122.12'/>",
        1,
    ),
    valid_network_xml.replace(b"<host mac='52:54:00:20:00:12' name='codestead-runner' ip='192.168.122.12'/>", b"", 1),
    valid_network_xml.replace(b"</network>", b"<ip address='10.20.0.1' netmask='255.255.255.0'/></network>", 1),
    valid_network_xml.replace(b"<network>", b"<network xmlns='urn:unreviewed'>", 1),
    b"<!DOCTYPE network [<!ENTITY xxe SYSTEM 'file:///etc/shadow'>]>" + valid_network_xml,
    b"<network>",
]:
    try:
        helper.validate_runner_network_xml(candidate)
    except helper.ContractError:
        pass
    else:
        raise AssertionError(f"runner network XML mutant was accepted: {candidate!r}")
for candidate in [
    valid_network_xml.replace(b"<network>", b"<network connections='-1'>", 1),
    valid_network_xml.replace(b"<network>", b"<network connections='01'>", 1),
    valid_network_xml.replace(b"<network>", b"<network connections='4294967295'>", 1),
    valid_network_xml.replace(b"<network>", b"<network connections='1' ipv6='yes'>", 1),
    valid_network_xml.replace(b"<network>", b"<network connections='1' trustGuestRxFilters='yes'>", 1),
]:
    try:
        helper.validate_runner_network_xml(candidate, live=True)
    except helper.ContractError:
        pass
    else:
        raise AssertionError(f"runner live network root mutant was accepted: {candidate!r}")

# FIX3_FOCUSED_BEGIN
assert os.getpid() in helper._process_group_members(os.getpgrp())

class RetainedLeader:
    pid = 424242
    returncode = None
    wait_calls = 0

    def wait(self, timeout=None):
        self.wait_calls += 1
        self.returncode = -helper.signal.SIGKILL
        return self.returncode

real_kill_process_group = helper._kill_process_group
real_wait_without_reaping = helper._wait_without_reaping
real_process_group_members = helper._process_group_members
killpg_calls = []
helper._kill_process_group = lambda process: killpg_calls.append(
    (process.pid, helper.signal.SIGKILL)
)
helper._wait_without_reaping = lambda process, ends_at, deadline: None
helper._process_group_members = lambda pgid: {pgid, pgid + 1}
lingering = RetainedLeader()
started = helper.time.monotonic()
try:
    helper._terminate_and_reap(lingering, timeout_seconds=0.03)
except helper.ProbeError:
    pass
else:
    raise AssertionError("successful SIGKILL with a lingering process group was accepted")
assert helper.time.monotonic() - started < 0.5
assert lingering.wait_calls == 1
assert killpg_calls == [(lingering.pid, helper.signal.SIGKILL)]
try:
    helper._terminate_and_reap(lingering, timeout_seconds=0.03)
except helper.ProbeError:
    pass
else:
    raise AssertionError("failed process-group proof was retried after PGID reuse became possible")
assert lingering.wait_calls == 1
assert killpg_calls == [(lingering.pid, helper.signal.SIGKILL)]

scans = []
def disappearing_members(pgid):
    scans.append(pgid)
    return {pgid, pgid + 1} if len(scans) == 1 else {pgid}

helper._process_group_members = disappearing_members
disappearing = RetainedLeader()
assert helper._terminate_and_reap(disappearing, timeout_seconds=0.2) == -helper.signal.SIGKILL
assert disappearing.wait_calls == 1
assert scans == [disappearing.pid, disappearing.pid]
assert helper._terminate_and_reap(disappearing, timeout_seconds=0.2) == -helper.signal.SIGKILL
assert disappearing.wait_calls == 2
assert scans == [disappearing.pid, disappearing.pid]
assert killpg_calls == [
    (lingering.pid, helper.signal.SIGKILL),
    (disappearing.pid, helper.signal.SIGKILL),
]
helper._kill_process_group = real_kill_process_group
helper._wait_without_reaping = real_wait_without_reaping
helper._process_group_members = real_process_group_members

valid_payload = helper.result_payload(
    helper.ProbeState(), recovered=False, timed_out=False, elapsed=0
)
real_argv = helper.sys.argv
real_run_parent = helper._run_parent
real_block = helper._block_termination_signals
real_restore = helper._restore_signal_mask
real_inject = helper._inject_test_signal
real_signal = helper.signal.signal
real_sigpending = helper.signal.sigpending
real_write = helper.os.write
write_attempts = []
helper.sys.argv = [str(helper_path)]
helper._run_parent = lambda test_mode: (valid_payload, 0)
helper._block_termination_signals = lambda: set()
helper._restore_signal_mask = lambda mask: None
helper._inject_test_signal = lambda test_mode, phase: None
helper.signal.signal = lambda signum, handler: None
helper.signal.sigpending = lambda: set()
helper.os.write = lambda descriptor, value: write_attempts.append(bytes(value)) or 1
try:
    assert helper.main() != 0, "one-byte final JSON write was accepted as success"
finally:
    helper.sys.argv = real_argv
    helper._run_parent = real_run_parent
    helper._block_termination_signals = real_block
    helper._restore_signal_mask = real_restore
    helper._inject_test_signal = real_inject
    helper.signal.signal = real_signal
    helper.signal.sigpending = real_sigpending
    helper.os.write = real_write
assert len(write_attempts) == 1 and len(write_attempts[0]) > 1
# FIX3_FOCUSED_END

helper._termination_requested = False
helper._parent_signal(helper.signal.SIGTERM, None)
assert helper._termination_requested is True

clock_values = iter([100.0, 101.0, 99.0])
deadline = helper.Deadline(900, monotonic=lambda: next(clock_values))
assert deadline.elapsed_seconds() == 1
try:
    deadline.elapsed_seconds()
except helper.ContractError:
    pass
else:
    raise AssertionError("backward monotonic source was accepted")
PY
}

if grep -Eq 'RECOVERY_PUBLIC_URL|RUNNER_BASE_URL:-|RUNNER_SHARED_SECRET_FILE:-' "$checker"; then
  fail 'production recovery configuration must not accept ambient endpoint or secret-path overrides'
fi
grep -Fq "readonly production_env='/usr/bin/env'" "$checker" ||
  fail 'production recovery launch must pin /usr/bin/env'
grep -Fq 'launcher=("$production_env" -i HOME=/nonexistent LANG=C LC_ALL=C PATH=/usr/bin:/bin)' "$checker" ||
  fail 'production recovery launch must start from an exact empty environment'

source_manipulates_path() {
  local source="$1"
  local line
  local path_token_regex='(^|[^A-Za-z0-9_])PATH([^A-Za-z0-9_]|$)'

  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" =~ ^[[:space:]]*(#|$) ]] && continue
    [[ "$line" =~ $path_token_regex ]] && return 0
  done <"$source"
  return 1
}

render_path_sealed_copy() {
  local staged_source="$1" destination="$2" interpreter="$3" command_root="$4" command_name
  shift 4
  printf '#!%s\n' "$interpreter" >"$destination"
  if [[ -n "$command_root" ]]; then
    for command_name in "$@"; do
      [[ "$command_name" =~ ^[a-z][a-z0-9-]*$ ]] || return 1
      printf '%s() { %q/%s "$@"; }\n' "$command_name" "$command_root" "$command_name" >>"$destination"
    done
  fi
  printf '%s\n' 'PATH=' 'readonly PATH' >>"$destination"
  tail -n +2 "$staged_source" >>"$destination"
}

make_path_sealed_copy() {
  local staged_source="$1" destination="$2" interpreter="$3" expected_shebang="$4" expected_sha256="$5"
  local expected_file="$destination.expected" candidate="$destination.candidate" actual_sha256
  shift 5
  verify_exact_staged_shell_source "$staged_source" "$interpreter" "$expected_shebang" "$expected_sha256" || return 1
  rm -f -- "$expected_file" "$candidate" "$destination"
  render_path_sealed_copy "$staged_source" "$expected_file" "$interpreter" "${1:-}" "${@:2}" || return 1
  expected_transformed_sha256="$(sha256_file "$expected_file")" || return 1
  render_path_sealed_copy "$staged_source" "$candidate" "$interpreter" "${1:-}" "${@:2}" || return 1
  actual_sha256="$(sha256_file "$candidate")" || return 1
  [[ "$actual_sha256" == "$expected_transformed_sha256" ]] || return 1
  chmod 0500 "$candidate"
  mv -- "$candidate" "$destination"
  rm -f -- "$expected_file"
  verify_exact_staged_shell_source "$destination" "$interpreter" "#!$interpreter" "$expected_transformed_sha256"
}

sha256_file() {
  local source="$1"
  local digest_line
  local digest

  digest_line="$("$sha256_bin" -- "$source")" || return 1
  digest="${digest_line%% *}"
  [[ "$digest" =~ ^[0-9a-f]{64}$ ]] || return 1
  printf '%s' "$digest"
}

verify_exact_staged_shell_source() {
  local staged_source="$1"
  local interpreter="$2"
  local expected_shebang="$3"
  local expected_sha256="$4"
  local first_line
  local shebang_count=0
  local line
  local actual_sha256

  local metadata mode mode_value
  [[ -f "$staged_source" && ! -L "$staged_source" ]] || return 1
  metadata="$(/usr/bin/stat -L -c '%a' -- "$staged_source")" || return 1
  mode="${metadata##*:}"; [[ "$mode" =~ ^[0-7]{3,4}$ ]] || return 1; mode_value=$((8#$mode))
  (( (mode_value & 8#222) == 0 )) || return 1
  IFS= read -r first_line <"$staged_source" || return 1
  [[ "$first_line" == "$expected_shebang" && "$first_line" != *$'\r'* ]] || return 1
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" != *$'\r'* ]] || return 1
    [[ "$line" == '#!'* ]] && shebang_count=$((shebang_count + 1))
  done <"$staged_source"
  (( shebang_count == 1 )) || return 1
  [[ "$expected_sha256" =~ ^[0-9a-f]{64}$ ]] || return 1
  actual_sha256="$(sha256_file "$staged_source")" || return 1
  [[ "$actual_sha256" == "$expected_sha256" ]] || return 1
  "$interpreter" -n "$staged_source" >/dev/null 2>&1
}

initialize_source_stager() {
  source_stager="$source_staging_root/source-stager.pl"
  cat >"$source_stager" <<'PERL'
#!/usr/bin/perl
use strict;
use warnings;
use Fcntl qw(O_RDONLY O_WRONLY O_CREAT O_EXCL O_TRUNC O_NOFOLLOW SEEK_SET S_ISREG F_SETFD FD_CLOEXEC);

sub set_cloexec {
  my ($handle) = @_;
  fcntl($handle, F_SETFD, FD_CLOEXEC) or die "O_CLOEXEC setup failed: $!\n";
}

sub write_all {
  my ($handle, $bytes) = @_;
  my $offset = 0;
  while ($offset < length($bytes)) {
    my $written = syswrite($handle, $bytes, length($bytes) - $offset, $offset);
    die "write failed: $!\n" unless defined $written && $written > 0;
    $offset += $written;
  }
}

sub read_all {
  my ($handle) = @_;
  my $bytes = '';
  while (1) {
    my $count = sysread($handle, my $chunk, 65536);
    die "read failed: $!\n" unless defined $count;
    last if $count == 0;
    $bytes .= $chunk;
  }
  return $bytes;
}

sub copy_all {
  my ($input, $output) = @_;
  while (1) {
    my $count = sysread($input, my $chunk, 65536);
    die "read failed: $!\n" unless defined $count;
    last if $count == 0;
    write_all($output, $chunk);
  }
}

my ($source, $destination, $hook, $race_root) = @ARGV;
die "invalid arguments\n" unless defined $race_root && ($hook eq 'none' || $hook eq 'path-swap-restore' || $hook eq 'inplace-restore');
my $o_cloexec = eval { Fcntl::O_CLOEXEC() } || 0;
sysopen(my $input, $source, O_RDONLY | O_NOFOLLOW | $o_cloexec) or die "open source failed: $!\n";
set_cloexec($input);
# Perl stat(FILEHANDLE) is the exact-descriptor fstat identity check.
my @before = stat($input);
die "source is not regular\n" unless @before && S_ISREG($before[2]);
my @path_before = lstat($source);
die "source path identity changed\n" unless @path_before && S_ISREG($path_before[2]) && $path_before[0] == $before[0] && $path_before[1] == $before[1];
if ($hook ne 'none') {
  my $prefix = "$race_root/reviewed-source-";
  die "race hook escaped fixture\n" unless index($source, $prefix) == 0;
}
sysopen(my $output, $destination, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | $o_cloexec, 0400) or die "open stage failed: $!\n";
set_cloexec($output);
my ($backup, $original_bytes, $error);
eval {
  if ($hook eq 'path-swap-restore') {
    $backup = "$source.stage-race-backup";
    unlink($backup);
    rename($source, $backup) or die "rename source failed: $!\n";
    sysopen(my $attacker, $source, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0600) or die "create attacker failed: $!\n";
    set_cloexec($attacker);
    write_all($attacker, "#!/usr/bin/env bash\nprintf compromised >\"\$SOURCE_IDENTITY_SENTINEL\"\n");
    close($attacker) or die "close attacker failed: $!\n";
  } elsif ($hook eq 'inplace-restore') {
    $original_bytes = read_all($input);
    sysseek($input, 0, SEEK_SET) or die "seek source failed: $!\n";
    sysopen(my $mutator, $source, O_WRONLY | O_TRUNC | O_NOFOLLOW) or die "open mutator failed: $!\n";
    set_cloexec($mutator);
    write_all($mutator, "#!/usr/bin/env bash\nprintf compromised >\"\$SOURCE_IDENTITY_SENTINEL\"\n");
    close($mutator) or die "close mutator failed: $!\n";
  }
  copy_all($input, $output);
  close($output) or die "close stage failed: $!\n";
  1;
} or $error = $@ || "staging failed\n";

if ($hook eq 'path-swap-restore' && defined $backup && -e $backup) {
  unlink($source);
  rename($backup, $source) or $error ||= "restore rename failed: $!\n";
} elsif ($hook eq 'inplace-restore' && defined $original_bytes) {
  if (sysopen(my $restorer, $source, O_WRONLY | O_TRUNC | O_NOFOLLOW)) {
    set_cloexec($restorer);
    eval { write_all($restorer, $original_bytes); close($restorer) or die "close restorer failed: $!\n"; 1 } or $error ||= $@;
  } else {
    $error ||= "open restorer failed: $!\n";
  }
}

my @after = stat($input);
my @path_after = lstat($source);
for my $index (0, 1, 2, 3, 4, 5, 6, 7) {
  $error ||= "descriptor identity changed\n" unless @after && $after[$index] == $before[$index];
}
$error ||= "source path was not restored\n" unless @path_after && S_ISREG($path_after[2]) && $path_after[0] == $before[0] && $path_after[1] == $before[1];
close($input) or $error ||= "close source failed: $!\n";
if ($error) {
  unlink($destination);
  die $error;
}
chmod(0400, $destination) == 1 or die "chmod stage failed: $!\n";
PERL
  chmod 0500 "$source_stager"
  source_stager_sha256="$(sha256_file "$source_stager")" || return 1
  "$perl_bin" -c "$source_stager" >/dev/null 2>&1 || return 1
}

stage_live_source_once() {
  local live_source="$1" staged_source="$2" hook="${3:-none}"
  [[ "$staged_source" == "$source_staging_root"/* && ! -e "$staged_source" ]] || return 1
  [[ "$(sha256_file "$source_stager")" == "$source_stager_sha256" ]] || return 1
  "$perl_bin" "$source_stager" "$live_source" "$staged_source" "$hook" "$source_staging_root"
}

stage_and_make_path_sealed_copy() {
  local live_source="$1" destination="$2"
  local staged_source="$destination.source-stage"
  shift 2
  rm -f -- "$staged_source"
  stage_live_source_once "$live_source" "$staged_source" || return 1
  make_path_sealed_copy "$staged_source" "$destination" "$@"
}

assert_source_race_mutations() {
  local interpreter="$1" expected_shebang="$2"
  local safe_source="$source_staging_root/reviewed-source-race.sh"
  local staged_source="$source_staging_root/reviewed-source-race.stage.sh"
  local transformed="$source_staging_root/reviewed-source-race.transformed.sh"
  local sentinel="$source_staging_root/reviewed-source-race.sentinel"
  local safe_sha256
  printf '%s\n%s\n' "$expected_shebang" 'set -e' >"$safe_source"
  safe_sha256="$(sha256_file "$safe_source")" || return 1
  printf '%s' unchanged >"$sentinel"

  rm -f -- "$staged_source" "$transformed"
  stage_live_source_once "$safe_source" "$staged_source" path-swap-restore || return 1
  make_path_sealed_copy "$staged_source" "$transformed" "$interpreter" "$expected_shebang" "$safe_sha256" || return 1
  [[ "$(sha256_file "$safe_source")" == "$safe_sha256" && "$(<"$transformed")" != *compromised* ]] || return 1

  rm -f -- "$staged_source" "$transformed"
  stage_live_source_once "$safe_source" "$staged_source" inplace-restore || true
  if [[ -e "$staged_source" ]] && make_path_sealed_copy "$staged_source" "$transformed" "$interpreter" "$expected_shebang" "$safe_sha256"; then
    return 1
  fi
  [[ "$(sha256_file "$safe_source")" == "$safe_sha256" && ! -e "$transformed" && "$(<"$sentinel")" == unchanged ]]
}



source_staging_root="$work"
initialize_source_stager || fail 'could not initialize one-FD source stager'

assert_source_identity_mutations() {
  local interpreter="$1"
  local expected_shebang="$2"
  local safe_source="$work/reviewed-source-safe.sh"
  local mutated_source="$work/reviewed-source-mutated.sh"
  local transformed="$work/reviewed-source-transformed.sh"
  local sentinel="$work/reviewed-source.sentinel"
  local safe_sha256
  local label
  local mutation

  printf '%s\n%s\n' "$expected_shebang" 'set -e' >"$safe_source"
  safe_sha256="$(sha256_file "$safe_source")" || fail 'could not hash reviewed source mutation baseline'
  printf '%s' unchanged >"$sentinel"
  while IFS='|' read -r label mutation; do
    printf '%s\n%s\n%s\n%s\n' "$expected_shebang" 'set -e' "$mutation" \
      'printf reached >"$SOURCE_IDENTITY_SENTINEL"' >"$mutated_source"
    rm -f -- "$transformed"
    if stage_and_make_path_sealed_copy "$mutated_source" "$transformed" "$interpreter" "$expected_shebang" "$safe_sha256"; then
      fail "reviewed source identity accepted $label mutation"
    fi
    [[ ! -e "$transformed" && "$(<"$sentinel")" == unchanged ]] ||
      fail "reviewed source identity transformed or ran $label mutation"
  done <<'EOF'
dynamic-command-p|opt=-p; builtin command "$opt" -v cp
dynamic-hash-p|opt=-p; d=/usr/bin; hash "$opt" "$d/cp" cp
assembled-absolute|d=/usr/bin; target="$d/cp"; command -v "$target"
new-shell|d=/usr/bin; shell="$d/sh"; "$shell" -c 'command -v cp'
dynamic-source|verb=source; "$verb" "$DYNAMIC_HELPER"
dynamic-dot-source|verb=.; "$verb" "$DYNAMIC_HELPER"
dynamic-env|verb=env; "$verb" command -v cp
dynamic-builtin|verb=builtin; "$verb" command -p -v cp
dynamic-exec|verb=exec; "$verb" /usr/bin/sh -c 'command -v cp'
EOF

  printf '%s\n%s\n' '/usr/bin/cp -- "$SOURCE" "$DESTINATION"' 'set -e' >"$mutated_source"
  rm -f -- "$transformed"
  stage_and_make_path_sealed_copy "$mutated_source" "$transformed" "$interpreter" "$expected_shebang" "$safe_sha256" &&
    fail 'reviewed source identity accepted a line-1 absolute command'
  [[ ! -e "$transformed" && "$(<"$sentinel")" == unchanged ]] || fail 'line-1 mutation escaped verification'
  printf '%s\n%s\n%s\n' "$expected_shebang" "$expected_shebang" 'set -e' >"$mutated_source"
  stage_and_make_path_sealed_copy "$mutated_source" "$transformed" "$interpreter" "$expected_shebang" "$safe_sha256" &&
    fail 'reviewed source identity accepted duplicate shebangs'
  printf '%s\r\n%s\r\n' "$expected_shebang" 'set -e' >"$mutated_source"
  stage_and_make_path_sealed_copy "$mutated_source" "$transformed" "$interpreter" "$expected_shebang" "$safe_sha256" &&
    fail 'reviewed source identity accepted CRLF source'
  rm -f -- "$work/reviewed-source-symlink.sh"
  ln -s "$safe_source" "$work/reviewed-source-symlink.sh"
  if [[ -L "$work/reviewed-source-symlink.sh" ]]; then
    stage_and_make_path_sealed_copy "$work/reviewed-source-symlink.sh" "$transformed" "$interpreter" "$expected_shebang" "$safe_sha256" 2>/dev/null &&
      fail 'reviewed source identity accepted a symlink'
  fi
  rm -f -- "$work/reviewed-source-symlink.sh"
}

assert_path_mutation_defenses() {
  local interpreter="$1"
  local mutation_source="$work/path-mutation-source.sh"
  local sealed_mutation="$work/path-mutation-sealed.sh"
  local mutation_bin="$work/path-mutation-bin"
  local resolution="$work/path-mutation-resolution"
  local sentinel="$work/path-mutation-sentinel"
  local mutation
  local mutation_status
  local mutation_sha256

  mkdir -m 0700 "$mutation_bin"
  for mutation in \
    'PATH=/usr/bin:/bin' \
    'export PATH=/usr/bin:/bin' \
    'unset PATH' \
    'readonly PATH=/usr/bin:/bin'; do
    # command -v is a shell builtin; none of these probes executes cp.
    {
      printf '#!%s\n' "$interpreter"
      printf '%s\n' \
        'set -e' \
        "$mutation" \
        'command -v cp >"$PATH_MUTATION_RESOLUTION"' \
        'printf compromised >"$PATH_MUTATION_SENTINEL"'
    } >"$mutation_source"
    source_manipulates_path "$mutation_source" || fail "PATH static guard missed: $mutation"
    mutation_sha256="$(sha256_file "$mutation_source")" || fail 'could not hash PATH mutation source'
    rm -f -- "$sealed_mutation" "$resolution"
    stage_and_make_path_sealed_copy "$mutation_source" "$sealed_mutation" "$interpreter" "#!$interpreter" "$mutation_sha256" ||
      fail 'could not create reviewed PATH mutation copy'
    printf '%s' unchanged >"$sentinel"
    set +e
    "$env_bin" -i PATH="$mutation_bin" PATH_MUTATION_RESOLUTION="$resolution" \
      PATH_MUTATION_SENTINEL="$sentinel" "$interpreter" "$sealed_mutation" \
      >"$work/path-mutation.stdout" 2>"$work/path-mutation.stderr"
    mutation_status=$?
    set -e

    (( mutation_status != 0 )) || fail "same-interpreter PATH mutation unexpectedly succeeded: $mutation"
    [[ ! -e "$resolution" ]] || fail "PATH mutation resolved a host executable before rejection: $mutation"
    [[ "$(<"$sentinel")" == unchanged ]] || fail "PATH mutation reached the outside sentinel: $mutation"
  done
}

checker_stage="$work/check-recovery.reviewed.stage.sh"
stage_live_source_once "$checker" "$checker_stage" ||
  fail 'could not open the recovery checker exactly once with O_NOFOLLOW'
verify_exact_staged_shell_source "$checker_stage" "$bash_bin" "$checker_shebang" "$checker_reviewed_sha256" ||
  fail 'recovery checker staged identity, shebang, regular-file, LF, syntax, or SHA is not reviewed'
checker_helper_stage="$work/recovery-checker.reviewed.stage.py"
stage_live_source_once "$checker_helper" "$checker_helper_stage" ||
  fail 'could not open the recovery checker helper exactly once with O_NOFOLLOW'
[[ "$(sha256_file "$checker_helper_stage")" == "$checker_helper_reviewed_sha256" ]] ||
  fail 'recovery checker helper staged bytes are not reviewed'
checker_baseline_module_stage="$work/existing_container_baseline.py"
stage_live_source_once "$checker_baseline_module" "$checker_baseline_module_stage" ||
  fail 'could not open the container baseline module exactly once with O_NOFOLLOW'
[[ "$(sha256_file "$checker_baseline_module_stage")" == "$checker_baseline_module_reviewed_sha256" ]] ||
  fail 'container baseline module staged bytes are not reviewed'
IFS= read -r helper_first_line <"$checker_helper_stage" || fail 'recovery checker helper is empty'
[[ "$helper_first_line" == '#!/usr/bin/python3' ]] || fail 'recovery checker helper interpreter is not fixed'
! grep -q $'\r' "$checker_helper_stage" || fail 'recovery checker helper contains CRLF bytes'
"$python_bin" - "$checker_helper_stage" <<'PY' || fail 'recovery checker helper syntax is invalid'
import pathlib
import sys
compile(pathlib.Path(sys.argv[1]).read_bytes(), sys.argv[1], "exec")
PY
run_helper_unit_tests "$checker_helper_stage" || fail 'recovery checker helper unit contract failed'
assert_source_identity_mutations "$bash_bin" "$checker_shebang"
assert_source_race_mutations "$bash_bin" "$checker_shebang" || fail 'recovery checker source race defenses failed'
grep -Fq "readonly production_python='/usr/bin/python3'" "$checker_stage" ||
  fail 'recovery checker must use the fixed production Python interpreter'
grep -Fq 'PATH=/usr/bin:/bin' "$checker_stage" ||
  fail 'recovery checker must sanitize the production executable search path'
assert_path_mutation_defenses "$bash_bin"
checker_under_test="$work/check-recovery.sealed.sh"
fake_bin="$work/bin"
checker_fake_commands=(systemctl virsh docker curl sleep \
  journalctl findmnt smartctl mount umount nft ping nc wget dd truncate touch tee ln rsync sudo ssh scp socat)
make_path_sealed_copy "$checker_stage" "$checker_under_test" "$bash_bin" "$checker_shebang" "$checker_reviewed_sha256" \
  "$fake_bin" "${checker_fake_commands[@]}" || fail 'could not create reviewed recovery checker test copy'
grep -Fxq 'PATH=' "$checker_under_test" && grep -Fxq 'readonly PATH' "$checker_under_test" ||
  fail 'recovery checker test copy did not seal PATH before the SUT body'
checker_under_test_sha256="$(sha256_file "$checker_under_test")" || fail 'could not hash transformed recovery checker'
verify_exact_staged_shell_source "$checker_under_test" "$bash_bin" "#!$bash_bin" "$checker_under_test_sha256" ||
  fail 'transformed recovery checker identity is not verified'

if tail -n +2 "$checker_stage" | grep -Eq '/usr/bin/(docker|curl|virsh|systemctl|sleep)|/usr/local|/libexec'; then
  fail 'recovery checker wrapper bypasses the helper command-root policy'
fi
if tail -n +2 "$checker_stage" | grep -Eq 'command[[:space:]]+-p|enable[[:space:]]+-f|hash[[:space:]]+-p|/dev/(tcp|udp)/'; then
  fail 'recovery checker can bypass fake command lookup'
fi
unsafe_absolute_redirects="$(tail -n +2 "$checker_stage" | sed -E 's#(>>?&?|>\|)[[:space:]]*["'"'"']?/dev/null["'"'"']?([;&|)}[:space:]]|$)#\2#g' | grep -E '(>>?&?|>\|)[[:space:]]*["'"'"']?/' || true)"
if [[ -n "$unsafe_absolute_redirects" ]]; then
  fail 'recovery checker redirects output to an absolute path other than /dev/null'
fi
redirect_prefix_probe="$(printf '%s\n' 'printf unsafe >/dev/null.evil' | sed -E 's#(>>?&?|>\|)[[:space:]]*["'"'"']?/dev/null["'"'"']?([;&|)}[:space:]]|$)#\2#g' | grep -E '(>>?&?|>\|)[[:space:]]*["'"'"']?/' || true)"
[[ -n "$redirect_prefix_probe" ]] || fail 'recovery redirect guard accepted a /dev/null prefix sibling'
if tail -n +2 "$checker_stage" | grep -Eq '(^|[;&|()[:space:]])(env|sh|bash|dash|zsh)([;&|()[:space:]]|$)|(^|[;&|()[:space:]])(eval|source)([;&|()[:space:]]|$)|(^|[;&|()[:space:]])\.[[:space:]]+/'; then
  fail 'recovery checker can spawn or source an uninstrumented shell command'
fi
if tail -n +2 "$checker_stage" | grep -Eq '(^|[^<])<[[:space:]]*([^<(&]|$)'; then
  fail 'recovery checker contains an uninstrumented shell file read'
fi
grep -Fq 'RECOVERY_CHECK_TEST_ROOT' "$checker_stage" || fail 'recovery checker is missing the single narrow test-root seam'
grep -Fq '/etc/learncoding/existing-containers.txt' "$checker_stage" || fail 'recovery checker changed the protected production baseline path'
grep -Fq 'exec "${launcher[@]}" "$python" -B "$helper" "${helper_arguments[@]}"' "$checker_stage" ||
  fail 'recovery checker must atomically replace the shell with the Python supervisor'
grep -Fq "production_baseline_cache_dir='/opt/learncoding/infra/ops/__pycache__'" "$checker_stage" ||
  fail 'recovery checker must reject cached baseline helper bytecode'
grep -Fq 'existing_container_baseline.*.pyc' "$checker_stage" ||
  fail 'recovery checker must reject versioned baseline helper bytecode'
grep -Fq 'exec "$python" -B "$helper"' "$checker_stage" ||
  fail 'recovery checker must disable Python bytecode writes in test mode'
if grep -Eq '(^|[[:space:]])(&|wait|trap)([[:space:]]|$)|child_pid' "$checker_stage"; then
  fail 'recovery checker retains a background-child signal race'
fi

host_root="$work/host-root"
fake_bin="$work/bin"
state_root="$work/state"
events="$work/events.log"
diagnostic_file="$state_root/diagnostic"
scenario_file="$state_root/scenario"
clock_file="$state_root/clock"
runner_body_file="$state_root/runner-body"
runner_signature_file="$state_root/runner-signature"
runner_concurrency_body_file="$state_root/runner-concurrency-body"
runner_concurrency_signature_file="$state_root/runner-concurrency-signature"
runner_expired_body_file="$state_root/runner-expired-body"
runner_expired_signature_file="$state_root/runner-expired-signature"
curl_root="$state_root/curl"
descendant_sentinel="$curl_root/escaped-descendant"
baseline="$host_root/etc/learncoding/existing-containers.txt"
existing_alpha_inspection="$state_root/existing-alpha.inspect.json"
existing_bravo_inspection="$state_root/existing-bravo.inspect.json"
existing_bravo_stopped_inspection="$state_root/existing-bravo-stopped.inspect.json"
existing_bravo_id_drift_inspection="$state_root/existing-bravo-id-drift.inspect.json"
existing_bravo_image_drift_inspection="$state_root/existing-bravo-image-drift.inspect.json"
existing_bravo_config_drift_inspection="$state_root/existing-bravo-config-drift.inspect.json"
existing_bravo_restart_drift_inspection="$state_root/existing-bravo-restart-drift.inspect.json"
existing_bravo_health_drift_inspection="$state_root/existing-bravo-health-drift.inspect.json"
existing_bravo_paused_inspection="$state_root/existing-bravo-paused.inspect.json"
existing_bravo_restarting_inspection="$state_root/existing-bravo-restarting.inspect.json"
existing_bravo_dead_inspection="$state_root/existing-bravo-dead.inspect.json"
existing_bravo_status_drift_inspection="$state_root/existing-bravo-status-drift.inspect.json"
compose_env_path="$host_root/etc/learncoding/compose.env"
compose_file_path="$host_root/opt/learncoding/compose.yaml"
compose_env_reviewed="$state_root/compose.env.reviewed"
compose_file_reviewed="$state_root/compose.yaml.reviewed"
runner_secret_file="$host_root/etc/learncoding/secrets/runner_shared_secret"
postgres_sql="SELECT name, setting FROM pg_settings WHERE name IN ('data_checksums', 'fsync', 'synchronous_commit', 'full_page_writes');"
mkdir -m 0700 -p "$fake_bin" "$state_root" "$curl_root" "$host_root/etc/learncoding/secrets" \
  "$host_root/opt/learncoding"
: >"$diagnostic_file"
printf '%s' preflight >"$scenario_file"
chmod 0600 "$scenario_file"
chmod 0700 "$host_root" "$host_root/etc" "$host_root/etc/learncoding" \
  "$host_root/etc/learncoding/secrets" "$host_root/opt" "$host_root/opt/learncoding"
PYTHONDONTWRITEBYTECODE=1 "$python_bin" \
  "$repo_root/infra/tests/fixtures/create-existing-container-baseline.py" "$state_root" "$baseline"
chown 0:0 "$baseline"
chmod 0600 "$baseline"
printf '%s\n' \
  'APP_URL=https://pilot.example.test' \
  'RUNNER_BASE_URL=http://192.168.122.12:4100' \
  'LEARN_DATA_ROOT=/srv/learncoding' \
  'UPLOADS_ENABLED=false' \
  'COMPOSE_PROFILES=' >"$compose_env_path"
chown 0:0 "$compose_env_path"
chmod 0640 "$compose_env_path"
cp "$repo_root/compose.yaml" "$compose_file_path"
chown 0:0 "$compose_file_path"
chmod 0644 "$compose_file_path"
cp "$compose_env_path" "$compose_env_reviewed"
cp "$compose_file_path" "$compose_file_reviewed"
chmod 0400 "$compose_env_reviewed" "$compose_file_reviewed"

secret_canary='RECOVERY_SECRET_CANARY_0cbb4185_DO_NOT_PRINT'
learner_canary='RECOVERY_LEARNER_CANARY_learner@example.invalid'
source_canary='RECOVERY_SOURCE_CANARY_console_log_private'
stdin_canary='RECOVERY_STDIN_CANARY_32bc43ef'
http_body_canary='RECOVERY_HTTP_BODY_CANARY_00d1ce39'
http_header_canary='RECOVERY_HTTP_HEADER_CANARY_60a55377'
runner_output_canary='RECOVERY_RUNNER_OUTPUT_CANARY_9635fa2d'
runner_journal_canary='RECOVERY_RUNNER_JOURNAL_CANARY_9add3ec1'
raw_command_canary='RECOVERY_RAW_COMMAND_CANARY_e31db02f'
printf '%s\n' "fixture-runner-secret-at-least-32-bytes-$secret_canary" >"$runner_secret_file"
chown 0:2000 "$runner_secret_file"
chmod 0440 "$runner_secret_file"
printf '%s' '{"status":"ok","queueDepth":0,"activeJobs":0,"concurrency":2,"generatedAtEpoch":1784116800}' >"$runner_body_file"
printf '%s' '{"status":"ok","queueDepth":0,"activeJobs":0,"concurrency":3,"generatedAtEpoch":1784116800}' >"$runner_concurrency_body_file"
printf '%s' '{"status":"ok","queueDepth":0,"activeJobs":0,"concurrency":2,"generatedAtEpoch":1784116200}' >"$runner_expired_body_file"

sign_runner_body() {
  local body_file="$1"
  local signature_file="$2"
  RUNNER_SECRET_FILE="$runner_secret_file" RUNNER_BODY_FILE="$body_file" \
    "$node_bin" -e '
    const fs = require("node:fs");
    const { createHash, createHmac } = require("node:crypto");
    const secret = fs.readFileSync(process.env.RUNNER_SECRET_FILE, "utf8").replace(/\n+$/, "");
    const body = fs.readFileSync(process.env.RUNNER_BODY_FILE, "utf8");
    const hash = createHash("sha256").update(body).digest("hex");
    process.stdout.write(`sha256=${createHmac("sha256", secret).update(`recovery-health-fixture-0001\n200\n${hash}`).digest("hex")}`);
  ' >"$signature_file"
}
sign_runner_body "$runner_body_file" "$runner_signature_file"
sign_runner_body "$runner_concurrency_body_file" "$runner_concurrency_signature_file"
sign_runner_body "$runner_expired_body_file" "$runner_expired_signature_file"

printf '#!%s\n' "$bash_bin" >"$fake_bin/fake-recovery-command"
cat >>"$fake_bin/fake-recovery-command" <<'FAKE'
set -Eeuo pipefail
umask 077

command_name="${0##*/}"
{
  printf '%q' "$command_name"
  for argument in "$@"; do printf ' %q' "$argument"; done
  printf '\n'
} >>"$FAKE_EVENTS"

scenario="$(<"$FAKE_SCENARIO_FILE")"
clock="$(<"$FAKE_CLOCK_FILE")"
if [[ "${FAKE_DEADLINE_ACTIVE:-}" != 1 ]]; then
  exit 99
fi
[[ "${COMPOSE_PROFILES+x}" == x && -z "$COMPOSE_PROFILES" ]] || exit 99
for ambient_name in PGHOST PGPORT PGDATABASE PGUSER PSQLRC CURL_HOME DOCKER_HOST DOCKER_CONTEXT; do
  [[ -z "${!ambient_name:-}" ]] || exit 98
done
delayed=false
if [[ "$scenario" == delayed && "$clock" -lt 30 ]]; then delayed=true; fi

safe_under() {
  local root="$1"
  local candidate="$2"
  local relative
  local cursor
  local component
  local -a components=()
  [[ "$candidate" == "$root" || "$candidate" == "$root"/* ]] || return 1
  relative="${candidate#"$root"}"
  relative="${relative#/}"
  [[ "/$relative/" != *'/../'* && "/$relative/" != *'/./'* && "$relative" != *'//'* ]] || return 1
  cursor="$root"
  [[ ! -L "$cursor" ]] || return 1
  IFS='/' read -r -a components <<<"$relative"
  for component in "${components[@]}"; do
    [[ -n "$component" && "$component" != . && "$component" != .. ]] || return 1
    cursor="$cursor/$component"
    [[ ! -L "$cursor" ]] || return 1
  done
}

validate_compose_prefix() {
  [[ "$#" == 7 && "$1" == compose && "$2" == --env-file && \
    "$3" =~ ^/proc/[1-9][0-9]*/fd/[0-9]+$ && "$4" == -f && \
    "$5" =~ ^/proc/[1-9][0-9]*/fd/[0-9]+$ && "$3" != "$5" && \
    "$6" == --project-directory && "$7" == "$FAKE_PROJECT_DIRECTORY" ]] || return 1
  FAKE_ACTUAL_COMPOSE_ENV="$3" FAKE_ACTUAL_COMPOSE_FILE="$5" /usr/bin/python3 - <<'PY'
import fcntl
import os

for actual_name, canonical_name, reviewed_name in (
    ("FAKE_ACTUAL_COMPOSE_ENV", "FAKE_COMPOSE_ENV", "FAKE_COMPOSE_ENV_REVIEWED"),
    ("FAKE_ACTUAL_COMPOSE_FILE", "FAKE_COMPOSE_FILE", "FAKE_COMPOSE_FILE_REVIEWED"),
):
    actual = os.environ[actual_name]
    canonical = os.environ[canonical_name]
    reviewed = os.environ[reviewed_name]
    actual_stat = os.stat(actual)
    canonical_stat = os.stat(canonical)
    if (actual_stat.st_dev, actual_stat.st_ino) == (canonical_stat.st_dev, canonical_stat.st_ino):
        raise SystemExit(1)
    required = fcntl.F_SEAL_WRITE | fcntl.F_SEAL_GROW | fcntl.F_SEAL_SHRINK | fcntl.F_SEAL_SEAL
    descriptor = os.open(actual, os.O_RDONLY | os.O_CLOEXEC)
    try:
        if fcntl.fcntl(descriptor, fcntl.F_GET_SEALS) & required != required:
            raise SystemExit(1)
    finally:
        os.close(descriptor)
    with open(actual, "rb", buffering=0) as actual_stream, open(reviewed, "rb", buffering=0) as reviewed_stream:
        if actual_stream.read() != reviewed_stream.read():
            raise SystemExit(1)
PY
}

emit_compose_services() {
  local -a services=(postgres app runner-egress-gateway mail-worker reward-worker regrade-worker \
    exam-finalization-worker practice-runner-recovery-worker project-review-correction-worker \
    file-erasure-worker cloudflared)
  local service
  for service in "${services[@]}"; do
    [[ "$scenario" != compose-model-missing || "$service" != reward-worker ]] || continue
    printf '%s\n' "$service"
    [[ "$scenario" != compose-model-duplicate || "$service" != app ]] || printf '%s\n' "$service"
  done
  [[ "$scenario" != compose-model-extra ]] || printf '%s\n' future-worker
}

mutate_compose_canonical() {
  case "$scenario" in
    compose-env-inplace|compose-env-change-restore)
      FAKE_MUTATE_PATH="$FAKE_COMPOSE_ENV" FAKE_REVIEWED_PATH="$FAKE_COMPOSE_ENV_REVIEWED" \
        FAKE_RESTORE="$([[ "$scenario" == compose-env-change-restore ]] && printf 1 || printf 0)" \
        /usr/bin/python3 - <<'PY'
import os
path = os.environ["FAKE_MUTATE_PATH"]
reviewed = open(os.environ["FAKE_REVIEWED_PATH"], "rb").read()
with open(path, "wb", buffering=0) as stream:
    stream.write(reviewed + b"UPLOADS_ENABLED=true\n")
if os.environ["FAKE_RESTORE"] == "1":
    with open(path, "wb", buffering=0) as stream:
        stream.write(reviewed)
PY
      ;;
    compose-yaml-inplace|compose-yaml-change-restore)
      FAKE_MUTATE_PATH="$FAKE_COMPOSE_FILE" FAKE_REVIEWED_PATH="$FAKE_COMPOSE_FILE_REVIEWED" \
        FAKE_RESTORE="$([[ "$scenario" == compose-yaml-change-restore ]] && printf 1 || printf 0)" \
        /usr/bin/python3 - <<'PY'
import os
path = os.environ["FAKE_MUTATE_PATH"]
reviewed = open(os.environ["FAKE_REVIEWED_PATH"], "rb").read()
with open(path, "wb", buffering=0) as stream:
    stream.write(reviewed + b"\n# unreviewed mutation\n")
if os.environ["FAKE_RESTORE"] == "1":
    with open(path, "wb", buffering=0) as stream:
        stream.write(reviewed)
PY
      ;;
  esac
}

emit_compose_status() {
  local service state health project name emitted_service ignored compose_object
  local -a services=(postgres app runner-egress-gateway mail-worker reward-worker regrade-worker \
    exam-finalization-worker practice-runner-recovery-worker project-review-correction-worker \
    file-erasure-worker cloudflared)
  for service in "${services[@]}"; do
    [[ "$scenario" != app-incomplete || "$service" != app ]] || continue
    [[ "$scenario" != file-erasure-incomplete || "$service" != file-erasure-worker ]] || continue
    [[ "$scenario" != worker-incomplete || "$service" != reward-worker ]] || continue
    [[ "$scenario" != cloudflared-incomplete || "$service" != cloudflared ]] || continue
    state=running
    health=
    project=learncoding
    name="learncoding-$service-1"
    emitted_service="$service"
    ignored=fixture
    case "$service" in
      postgres|app|runner-egress-gateway|mail-worker|reward-worker|regrade-worker|exam-finalization-worker|practice-runner-recovery-worker|project-review-correction-worker|file-erasure-worker|cloudflared) health=healthy ;;
    esac
    [[ "$scenario" != app-malformed || "$service" != app ]] || state=mystery
    [[ "$scenario" != worker-malformed || "$service" != mail-worker ]] || state=mystery
    [[ "$scenario" != worker-heartbeat-unhealthy || "$service" != mail-worker ]] || health=unhealthy
    [[ "$scenario" != cloudflared-malformed || "$service" != cloudflared ]] || state=mystery
    [[ "$scenario" != postgres-container-unhealthy || "$service" != postgres ]] || health=unhealthy
    [[ "$scenario" != app-wrong-project || "$service" != app ]] || project=foreign-project
    [[ "$scenario" != compose-wrong-name || "$service" != app ]] || name=learncoding-wrong-app-1
    [[ "$scenario" != compose-wrong-service || "$service" != app ]] || emitted_service=postgres
    case "$service" in
      app) ignored="$FAKE_LEARNER_CANARY" ;;
      mail-worker) ignored="$FAKE_SOURCE_CANARY" ;;
      cloudflared) ignored="$FAKE_RAW_COMMAND_CANARY" ;;
    esac
    compose_object="{\"ID\":\"0123456789ab\",\"Name\":\"$name\",\"Command\":\"/reviewed-entrypoint\",\"Project\":\"$project\",\"Service\":\"$emitted_service\",\"Ignored\":\"$ignored\",\"State\":\"$state\",\"ExitCode\":0,\"Health\":\"$health\",\"Publishers\":null}"
    if [[ "$scenario" == compose-nested && "$service" == app ]]; then
      printf '{"nested":%s}\n' "$compose_object"
    elif [[ "$scenario" == compose-malformed-json && "$service" == app ]]; then
      printf '%s,BROKEN}\n' "${compose_object%\}}"
    elif [[ "$scenario" == compose-duplicate-key && "$service" == app ]]; then
      printf '%s\n' "${compose_object/\"Project\":\"learncoding\"/\"Project\":\"learncoding\",\"Project\":\"learncoding\"}"
    elif [[ "$scenario" == compose-nonfinite && "$service" == app ]]; then
      printf '%s\n' "${compose_object/\"State\":\"running\"/\"NonFinite\":NaN,\"State\":\"running\"}"
    elif [[ "$scenario" == compose-numeric-overflow && "$service" == app ]]; then
      printf '%s\n' "${compose_object/\"State\":\"running\"/\"Overflow\":1e999,\"State\":\"running\"}"
    else
      printf '%s\n' "$compose_object"
    fi
    if [[ "$scenario" == app-duplicate && "$service" == app ]]; then printf '%s\n' "$compose_object"; fi
  done
  if [[ "$scenario" == compose-extra ]]; then
    printf '%s\n' '{"Project":"learncoding","Name":"learncoding-unexpected-1","Service":"unexpected","State":"running","Health":""}'
  elif [[ "$scenario" == compose-stopped-extra ]]; then
    printf '%s\n' '{"Project":"learncoding","Name":"learncoding-app-2","Service":"app","State":"exited","Health":""}'
  fi
}

case "$command_name" in
  sleep)
    [[ "$#" == 1 && "$1" =~ ^([1-9]|10)$ ]] || exit 64
    if [[ "$scenario" == delayed ]]; then
      next=$((clock + 10))
    elif [[ "$scenario" == permanent ]]; then
      next=900
    elif [[ "$scenario" == runner-replay ]]; then
      next=$((clock == 0 ? 40 : 900))
    elif [[ "$scenario" == clock-rewind ]]; then
      next=$((clock == 0 ? 10 : 5))
    else
      next=900
    fi
    (( next <= 900 )) || exit 98
    printf '%s' "$next" >"$FAKE_CLOCK_FILE"
    ;;
  systemctl)
    verb="${1:-}"
    unit="${2:-}"
    case "$verb" in
      is-active)
        [[ "$#" == 2 ]] || exit 64
        if [[ "$delayed" == true ]]; then exit 3; fi
        if [[ "$scenario" == permanent && "$unit" == learncoding-compose.service ]]; then exit 3; fi
        if [[ "$scenario" == clock-rewind && "$unit" == learncoding-compose.service ]]; then exit 3; fi
        if [[ "$scenario" == runner-replay && "$clock" -lt 40 && "$unit" == learncoding-compose.service ]]; then exit 3; fi
        if [[ "$scenario" == docker-down && "$unit" == docker.service ]]; then exit 3; fi
        if [[ "$scenario" == libvirt-down && "$unit" == libvirtd.service ]]; then exit 3; fi
        if [[ "$scenario" == firewall-down && "$unit" == learncoding-runner-firewall.service ]]; then exit 3; fi
        if [[ "$scenario" == timer-incomplete && "$unit" == *.timer ]]; then exit 3; fi
        if [[ "$scenario" == ingress-recovery-timer-disabled && "$unit" == learncoding-ingress-recovery.timer ]]; then exit 3; fi
        case "$unit" in
          docker.service|libvirtd.service|learncoding-runner-firewall.service|learncoding-compose.service|learncoding-backup.timer|learncoding-backup-check.timer|learncoding-offsite-sync.timer|learncoding-offsite-retention.timer|learncoding-restore-drill-reminder.timer|learncoding-retention.timer|learncoding-recovery-check.timer|learncoding-ingress-recovery.timer)
            printf '%s\n' active ;;
          *) exit 64 ;;
        esac
        ;;
      is-enabled)
        [[ "$#" == 2 ]] || exit 64
        if [[ "$scenario" == timer-incomplete && "$unit" == learncoding-retention.timer ]]; then printf '%s\n' disabled; exit 1; fi
        if [[ "$scenario" == timer-malformed && "$unit" == learncoding-retention.timer ]]; then printf '%s\n' 'enabled unexpected'; exit 0; fi
        if [[ "$scenario" == ingress-recovery-timer-disabled && "$unit" == learncoding-ingress-recovery.timer ]]; then printf '%s\n' disabled; exit 1; fi
        case "$unit" in
          learncoding-backup.timer|learncoding-backup-check.timer|learncoding-offsite-sync.timer|learncoding-offsite-retention.timer|learncoding-restore-drill-reminder.timer|learncoding-retention.timer|learncoding-recovery-check.timer|learncoding-ingress-recovery.timer)
            printf '%s\n' enabled ;;
          *) exit 64 ;;
        esac
        ;;
      show)
        [[ "$#" == 4 && "${3:-}" == --property=Persistent && "${4:-}" == --value && "$unit" == *.timer ]] || exit 64
        if [[ "$scenario" == timer-not-persistent && "$unit" == learncoding-retention.timer ]]; then
          printf '%s\n' no
        else
          printf '%s\n' yes
        fi
        ;;
      *) exit 64 ;;
    esac
    ;;
  virsh)
    if [[ "${1:-}" == --connect && "${2:-}" == qemu:///system ]]; then shift 2; fi
    case "${1:-}:${2:-}" in
      domstate:codestead-runner)
        [[ "$#" == 2 ]] || exit 64
        if [[ "$scenario" == runner-inactive || "$delayed" == true ]]; then printf '%s\n' 'shut off'; else printf '%s\n' running; fi
        ;;
      dominfo:codestead-runner)
        [[ "$#" == 2 ]] || exit 64
        autostart=enable
        persistent=yes
        [[ "$scenario" == runner-no-autostart ]] && autostart=disable
        [[ "$scenario" == runner-domain-not-persistent ]] && persistent=no
        printf '%s\n' 'Name: codestead-runner' "Autostart: $autostart" "Persistent: $persistent"
        ;;
      dumpxml:codestead-runner)
        [[ "$#" == 2 || ( "$#" == 3 && "$3" == --inactive ) ]] || exit 64
        domain_type=kvm
        domain_root_extra=
        interface_type=network
        interface_source=default
        interface_model=virtio
        interface_mac=52:54:00:20:00:12
        [[ "$scenario" == runner-domain-qemu ]] && domain_type=qemu
        [[ "$scenario" == runner-domain-extra-root ]] && domain_root_extra=" emulator='unreviewed'"
        [[ "$scenario" == runner-domain-direct ]] && interface_type=direct
        [[ "$scenario" == runner-domain-bridge ]] && interface_type=bridge
        [[ "$scenario" == runner-domain-wrong-network ]] && interface_source=foreign
        [[ "$scenario" == runner-domain-wrong-model ]] && interface_model=e1000
        [[ "$scenario" == runner-domain-wrong-mac ]] && interface_mac=52:54:00:12:34:56
        printf '%s' "<domain type='$domain_type'$domain_root_extra"
        if [[ "$#" == 2 ]]; then printf " id='7'"; fi
        printf '%s' "><name>codestead-runner</name><devices><interface type='$interface_type'><mac address='$interface_mac'/><source network='$interface_source'"
        if [[ "$#" == 2 ]]; then printf " bridge='virbr0'"; fi
        printf "/><model type='$interface_model'/><target dev='vnet0'/>"
        if [[ "$#" == 2 ]]; then printf "<link state='up'/>"; fi
        printf '%s' '</interface>'
        [[ "$scenario" != runner-domain-extra-interface ]] || printf '%s' "<interface type='network'><mac address='52:54:00:20:00:13'/><source network='default'/><model type='virtio'/></interface>"
        [[ "$scenario" != runner-domain-hostdev ]] || printf '%s' "<hostdev mode='subsystem' type='pci'/>"
        printf '%s\n' '</devices></domain>'
        ;;
      net-info:default)
        [[ "$#" == 2 ]] || exit 64
        active=yes
        autostart=yes
        persistent=yes
        [[ "$scenario" == runner-network-inactive ]] && active=no
        [[ "$scenario" == runner-network-no-autostart ]] && autostart=no
        [[ "$scenario" == runner-network-not-persistent ]] && persistent=no
        bridge=virbr0
        [[ "$scenario" == runner-network-wrong-bridge ]] && bridge=virbr9
        printf '%s\n' 'Name: default' "Bridge: $bridge" "Active: $active" "Autostart: $autostart" "Persistent: $persistent"
        ;;
      net-dumpxml:default)
        [[ "$#" == 2 || ( "$#" == 3 && "$3" == --inactive ) ]] || exit 64
        forward_mode=nat
        gateway=192.168.122.1
        netmask=255.255.255.0
        network_root_attributes=
        if [[ "$#" == 2 ]]; then network_root_attributes=" connections='1'"; fi
        [[ "$scenario" == runner-network-ipv6 ]] && network_root_attributes+=" ipv6='yes'"
        [[ "$scenario" == runner-network-trust-guest-rx-filters ]] && network_root_attributes+=" trustGuestRxFilters='yes'"
        [[ "$scenario" == runner-network-route ]] && forward_mode=route
        [[ "$scenario" == runner-network-bridge-forward ]] && forward_mode=bridge
        [[ "$scenario" == runner-network-open ]] && forward_mode=open
        [[ "$scenario" == runner-network-wrong-subnet ]] && gateway=10.20.0.1
        [[ "$scenario" == runner-network-wrong-netmask ]] && netmask=255.255.0.0
        printf "%s" "<network$network_root_attributes><name>default</name><forward mode='$forward_mode'/><bridge name='virbr0'/><ip address='$gateway' netmask='$netmask'><dhcp><range start='192.168.122.2' end='192.168.122.254'/>"
        [[ "$scenario" == runner-network-dhcp-missing ]] || printf '%s' "<host mac='52:54:00:20:00:12' name='codestead-runner' ip='192.168.122.12'/>"
        [[ "$scenario" != runner-network-dhcp-duplicate ]] || printf '%s' "<host mac='52:54:00:20:00:12' name='codestead-runner-duplicate' ip='192.168.122.13'/>"
        [[ "$scenario" != runner-network-dhcp-ip-conflict ]] || printf '%s' "<host mac='52:54:00:20:00:13' name='other' ip='192.168.122.12'/>"
        printf '%s' '</dhcp></ip>'
        [[ "$scenario" != runner-network-extra-ip ]] || printf '%s' "<ip address='10.20.0.1' netmask='255.255.255.0'/>"
        printf '%s\n' '</network>'
        ;;
      domiflist:codestead-runner)
        [[ "$#" == 2 ]] || exit 64
        interface_source=default
        [[ "$scenario" == runner-domain-wrong-network ]] && interface_source=foreign
        printf '%s\n' ' Interface   Type      Source    Model    MAC' \
          '--------------------------------------------------------------' \
          " vnet0       network   $interface_source   virtio   52:54:00:20:00:12"
        [[ "$scenario" != runner-domain-extra-direct ]] || printf '%s\n' \
          ' macvtap0    direct    eth0      virtio   52:54:00:20:00:13'
        ;;
      domifaddr:codestead-runner)
        [[ "$#" == 5 && "$3" == --source && "$4" == lease && "$5" == --full ]] || exit 64
        interface_address=192.168.122.12/24
        [[ "$scenario" == runner-domain-wrong-address ]] && interface_address=192.168.122.99/24
        printf '%s\n' ' Name       MAC address          Protocol     Address' \
          '-------------------------------------------------------------------------------' \
          " vnet0      52:54:00:20:00:12    ipv4         $interface_address"
        [[ "$scenario" != runner-domain-extra-address ]] || printf '%s\n' \
          ' vnet0      52:54:00:20:00:12    ipv6         2001:db8::12/64'
        ;;
      *) exit 64 ;;
    esac
    ;;
  docker)
    if [[ "$#" == 1 && "$1" == info ]]; then
      if [[ "$scenario" == leader-exits-child-holds-command ]]; then
        /usr/bin/python3 -c 'import os,time; pid=os.fork(); os._exit(0) if pid else (time.sleep(4), open(os.environ["FAKE_DESCENDANT_SENTINEL"], "w").write("escaped"))'
        exit 0
      fi
      if [[ "$scenario" == command-hang ]]; then
        if [[ "$clock" == 0 ]]; then while :; do :; done; fi
        exit 124
      fi
      [[ "$scenario" != command-error ]] || exit 73
      [[ "$delayed" == false && "$scenario" != docker-down ]] || exit 1
      if [[ "$scenario" == command-output-flood ]]; then printf '%100000s' ''; fi
      if [[ "$scenario" == command-stderr-flood ]]; then printf '%100000s' '' >&2; fi
      exit 0
    fi
    if [[ "$#" == 16 ]] && validate_compose_prefix "${@:1:7}" && \
      [[ "$8" == exec && "$9" == -T && "${10}" == postgres && "${11}" == pg_isready && \
      "${12}" == --host=/var/run/postgresql && "${13}" == --port=5432 && \
      "${14}" == --username=learncoding && "${15}" == --dbname=learncoding && \
      "${16}" == --timeout=1 ]]; then
      [[ "$scenario" != postgres-unhealthy && "$delayed" == false ]] || exit 1
      printf '%s\n' 'accepting connections'
      exit 0
    fi
    if [[ "$#" == 21 ]] && validate_compose_prefix "${@:1:7}" && \
      [[ "$8" == exec && "$9" == -T && "${10}" == postgres && "${11}" == psql && \
      "${12}" == -X && "${13}" == --host=/var/run/postgresql && "${14}" == --port=5432 && \
      "${15}" == --username=learncoding && "${16}" == --dbname=learncoding && \
      "${17}" == --no-align && "${18}" == --tuples-only && "${19}" == '--field-separator=|' && \
      "${20}" == --command && "${21}" == "$FAKE_POSTGRES_SQL" ]]; then
      case "$scenario" in
        postgres-checksums-off) printf '%s\n' 'data_checksums|off' 'fsync|on' 'synchronous_commit|on' 'full_page_writes|on' ;;
        postgres-fsync-off) printf '%s\n' 'data_checksums|on' 'fsync|off' 'synchronous_commit|on' 'full_page_writes|on' ;;
        postgres-sync-off) printf '%s\n' 'data_checksums|on' 'fsync|on' 'synchronous_commit|off' 'full_page_writes|on' ;;
        postgres-full-page-off) printf '%s\n' 'data_checksums|on' 'fsync|on' 'synchronous_commit|on' 'full_page_writes|off' ;;
        *) printf '%s\n' 'data_checksums|on' 'fsync|on' 'synchronous_commit|on' 'full_page_writes|on' ;;
      esac
      exit 0
    fi
    if [[ "$#" == 6 && "$1" == inspect && "$2" == --type && "$3" == container && \
      "$4" == learncoding-postgres-1 && "$5" == --format && "$6" == '{{json .Mounts}}' ]]; then
      mount_type=bind
      mount_source=/srv/learncoding/postgres
      mount_rw=true
      [[ "$scenario" == postgres-mount-type ]] && mount_type=volume
      [[ "$scenario" == postgres-mount-source ]] && mount_source=/srv/other/postgres
      [[ "$scenario" == postgres-mount-readonly ]] && mount_rw=false
      if [[ "$scenario" == postgres-mount-duplicate ]]; then
        printf '%s\n' '[{"Type":"bind","Source":"/srv/learncoding/postgres","Destination":"/var/lib/postgresql/data","RW":true},{"Type":"bind","Source":"/srv/learncoding/postgres","Destination":"/var/lib/postgresql/data","RW":true}]'
      else
        printf '[{"Type":"%s","Source":"%s","Destination":"/var/lib/postgresql/data","RW":%s}]\n' \
          "$mount_type" "$mount_source" "$mount_rw"
      fi
      exit 0
    fi
    if [[ "$#" == 9 ]] && validate_compose_prefix "${@:1:7}" && \
      [[ "$8" == config && "$9" == --services ]]; then
      mutate_compose_canonical
      emit_compose_services
      exit 0
    fi
    if [[ "$#" == 11 ]] && validate_compose_prefix "${@:1:7}" && \
      [[ "$8" == ps && "$9" == --all && "${10}" == --format && "${11}" == json ]]; then
      [[ "$delayed" == false ]] || exit 1
      emit_compose_status
      exit 0
    fi
    if [[ "$#" == 4 && "$1" == inspect && "$2" == --type && "$3" == container &&
      ( "$4" == legacy-alpha || "$4" == legacy-bravo ) ]]; then
      inspection_label="${4#legacy-}"
      if [[ "$inspection_label" == bravo ]]; then
        if [[ "$delayed" == true ]]; then
          inspection_label=bravo-stopped
        else
          case "$scenario" in
            existing-stopped) inspection_label=bravo-stopped ;;
            existing-id-drift) inspection_label=bravo-id-drift ;;
            existing-image-drift) inspection_label=bravo-image-drift ;;
            existing-config-drift) inspection_label=bravo-config-drift ;;
            existing-restart-drift) inspection_label=bravo-restart-drift ;;
            existing-health-drift) inspection_label=bravo-health-drift ;;
            existing-paused) inspection_label=bravo-paused ;;
            existing-restarting) inspection_label=bravo-restarting ;;
            existing-dead) inspection_label=bravo-dead ;;
            existing-status-drift) inspection_label=bravo-status-drift ;;
          esac
        fi
      fi
      inspection_path="$FAKE_STATE_ROOT/existing-$inspection_label.inspect.json"
      [[ -f "$inspection_path" && ! -L "$inspection_path" ]] || exit 64
      printf '%s' "$(<"$inspection_path")"
      exit 0
    fi
    if [[ "$#" == 3 && "$1" == ps && "$2" == --format && "$3" == '{{.Names}}' ]]; then
      [[ "$delayed" == false ]] || { printf '%s\n' legacy-alpha; exit 0; }
      printf '%s\n' legacy-alpha
      [[ "$scenario" == existing-stopped ]] || printf '%s\n' legacy-bravo
      printf '%s\n' learncoding-postgres learncoding-app learncoding-runner-egress-gateway learncoding-mail-worker learncoding-reward-worker \
        learncoding-regrade-worker learncoding-exam-finalization-worker learncoding-practice-runner-recovery-worker \
        learncoding-project-review-correction-worker learncoding-file-erasure-worker learncoding-cloudflared
      exit 0
    fi
    exit 64
    ;;
  curl)
    [[ "$#" == 27 || "$#" == 29 ]] || exit 64
    [[ "$1" == --disable && "$2" == --silent && "$3" == --show-error && \
      "$4" == --fail-with-body && "$5" == --globoff && "$6" == --noproxy && "$7" == '*' && \
      "$8" == --proto && ( "$9" == '=http' || "$9" == '=https' ) && \
      "${10}" == --connect-timeout && "${11}" == 5 && "${12}" == --max-time && \
      "${13}" == 10 && "${14}" == --max-filesize && "${15}" == 4096 && \
      "${16}" == --request && "${17}" == GET && "${18}" == --header && \
      "${19}" == 'accept-encoding: identity' ]] || exit 64
    request_id=
    index=20
    if [[ "$#" == 29 ]]; then
      [[ "${20}" == --header && "${21}" == 'x-request-id: '* ]] || exit 64
      request_id="${21#x-request-id: }"
      index=22
    fi
    output_flag="${!index}"; (( index += 1 )); output="${!index}"; (( index += 1 ))
    header_flag="${!index}"; (( index += 1 )); headers="${!index}"; (( index += 1 ))
    write_flag="${!index}"; (( index += 1 )); write_format="${!index}"; (( index += 1 ))
    url_flag="${!index}"; (( index += 1 )); url="${!index}"
    [[ "$output_flag" == --output && "$header_flag" == --dump-header && \
      "$write_flag" == --write-out && "$write_format" == '%{http_code}' && "$url_flag" == --url && \
      "$output" =~ ^/proc/self/fd/[0-9]+$ && "$headers" =~ ^/proc/self/fd/[0-9]+$ ]] || exit 64
    if [[ "$scenario" == leader-exits-child-holds-http && \
      "$url" == https://pilot.example.test/health/ready ]]; then
      /usr/bin/python3 -c 'import os,time; pid=os.fork(); os._exit(0) if pid else (time.sleep(4), open(os.environ["FAKE_DESCENDANT_SENTINEL"], "w").write("escaped"))'
      exit 0
    fi
    if [[ "$url" == https://pilot.example.test/health/ready ]]; then
      [[ "$9" == '=https' && -z "$request_id" ]] || exit 97
      [[ "$scenario" != public-fail && "$delayed" == false ]] || exit 22
    elif [[ "$url" == http://192.168.122.12:4100/healthz ]]; then
      [[ "$9" == '=http' && "$request_id" =~ ^recovery-[0-9a-f]{32}$ ]] || exit 97
    else
      exit 97
    fi
    FAKE_CURL_OUTPUT_FD="${output##*/}" FAKE_CURL_HEADER_FD="${headers##*/}" \
      FAKE_CURL_URL="$url" FAKE_CURL_REQUEST_ID="$request_id" /usr/bin/python3 - <<'PY'
import hashlib
import hmac
import os

scenario = open(os.environ["FAKE_SCENARIO_FILE"], encoding="ascii").read()
clock = int(open(os.environ["FAKE_CLOCK_FILE"], encoding="ascii").read())
url = os.environ["FAKE_CURL_URL"]
request_id = os.environ["FAKE_CURL_REQUEST_ID"]
body_fd = int(os.environ["FAKE_CURL_OUTPUT_FD"])
header_fd = int(os.environ["FAKE_CURL_HEADER_FD"])
status = 200

def write_all(descriptor, value):
    view = memoryview(value)
    while view:
        written = os.write(descriptor, view[:1024])
        view = view[written:]

if url.startswith("https://"):
    body = b'{"status":"ready"}'
    if scenario == "public-origin":
        body = b'{"status":"wrong-origin"}'
    elif scenario == "public-extra":
        body = b'{"status":"ready","ignored":true}'
    elif scenario == "public-body-lf":
        body += b"\n"
    elif scenario == "public-body-nul":
        body += b"\x00"
    elif scenario == "public-body-oversize":
        body = b"P" * 100_000
    if scenario == "public-status-201":
        status = 201
    csp = (
        "default-src 'self'; base-uri 'self'; frame-ancestors 'none'; object-src 'none'; "
        "script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; "
        "img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; "
        "worker-src 'self' blob:; form-action 'self'; upgrade-insecure-requests"
    )
    hsts = "max-age=31536000"
    content_type = "application/json; charset=utf-8"
    if scenario == "public-hsts-zero": hsts = "max-age=0"
    if scenario == "public-hsts-excess": hsts = "max-age=999999999"
    if scenario == "public-csp-wrong": csp = "default-src 'self'"
    if scenario == "public-content-type-jsonp": content_type = "application/jsonp"
    if scenario == "public-content-type-malformed": content_type = "application/json; charset=bad value"
    if scenario == "public-content-type-duplicate": content_type = 'application/json; charset=utf-8; CHARSET="utf-8"'
    if scenario == "public-headers":
        header = f"HTTP/2 {status}\r\nx-fixture-private: {os.environ['FAKE_HTTP_HEADER_CANARY']}\r\n\r\n".encode()
    else:
        header = (
            f"HTTP/2 {status}\r\n"
            f"strict-transport-security: {hsts}\r\n"
            f"content-security-policy: {csp}\r\n"
            "x-content-type-options: nosniff\r\n"
            "cache-control: no-store\r\n"
            f"content-type: {content_type}\r\n"
            f"x-fixture-private: {os.environ['FAKE_HTTP_HEADER_CANARY']}\r\n\r\n"
        ).encode()
    if scenario == "public-header-oversize":
        header = header[:-2] + b"x-oversized: " + b"H" * 100_000 + b"\r\n\r\n"
    if scenario == "public-header-lf": header = header.replace(b"\r\n", b"\n")
    if scenario == "public-header-mixed": header = header.replace(b"\r\n", b"\n", 1)
    if scenario == "public-header-control": header = header.replace(b"no-store", b"no\x01store")
    if scenario == "public-header-multiple": header += b"HTTP/1.1 200 OK\r\n\r\n"
    if scenario == "public-header-truncated": header = header[:-2]
else:
    generated = 1_784_116_800 + clock
    if scenario == "runner-expired": generated -= 600
    if scenario == "runner-before-invocation": generated = 1_784_116_799
    if scenario == "runner-replay": generated = 1_784_116_800
    concurrency = "2"
    if scenario == "runner-concurrency": concurrency = "3"
    if scenario == "runner-concurrency-length": concurrency = "2" * 40
    body = (
        f'{{"status":"ok","queueDepth":0,"activeJobs":0,"concurrency":{concurrency},'
        f'"generatedAtEpoch":{generated}}}'
    ).encode()
    if scenario == "runner-malformed": body = b"{malformed-json"
    if scenario == "runner-body-lf": body += b"\n"
    if scenario == "runner-body-nul": body += b"\x00"
    if scenario == "runner-body-oversize": body = b"R" * 100_000
    if scenario == "runner-status-201": status = 201
    returned_id = request_id
    if scenario == "runner-request-mismatch": returned_id = "recovery-ffffffffffffffffffffffffffffffff"
    secret = open(os.environ["FAKE_RUNNER_SECRET_FILE"], "rb").read().rstrip(b"\n")
    body_hash = hashlib.sha256(body).hexdigest()
    signed_status = 200 if scenario == "runner-status-201" else status
    signature = "sha256=" + hmac.new(
        secret, f"{request_id}\n{signed_status}\n{body_hash}".encode(), hashlib.sha256
    ).hexdigest()
    if scenario == "runner-tampered": signature = "sha256=" + "0" * 64
    signature_header = "" if scenario == "runner-unsigned" else f"x-runner-response-signature: {signature}\r\n"
    header = (
        f"HTTP/1.1 {status} OK\r\n"
        f"x-request-id: {returned_id}\r\n"
        f"{signature_header}"
        "content-type: application/json; charset=utf-8\r\n"
        "cache-control: no-store\r\n"
        "x-content-type-options: nosniff\r\n"
        f"x-runner-debug: {os.environ['FAKE_RUNNER_OUTPUT_CANARY']}\r\n\r\n"
    ).encode()
    if scenario == "runner-header-oversize":
        header = header[:-2] + b"x-oversized: " + b"H" * 100_000 + b"\r\n\r\n"

write_all(body_fd, body)
write_all(header_fd, header)
os.write(1, str(status).encode("ascii"))
PY
    ;;
  stat|realpath|readlink|cat)
    targets=()
    expect_format=false
    for argument in "$@"; do
      if [[ "$expect_format" == true ]]; then expect_format=false; continue; fi
      case "$argument" in -c|--format|--printf) expect_format=true ;; --|-e|-f|-m|-n|-q|-s|-v|--format=*|--printf=*) ;; -*) exit 64 ;; *) targets+=("$argument") ;; esac
    done
    [[ "$expect_format" == false && ${#targets[@]} == 1 ]] || exit 64
    for target in "${targets[@]}"; do
      safe_under "$FAKE_HOST_ROOT" "$target" || safe_under "$FAKE_STATE_ROOT" "$target" || exit 97
    done
    "/usr/bin/$command_name" "$@"
    ;;
  mktemp)
    mktemp_args=("$@")
    template="${!#}"
    safe_under "$FAKE_CURL_ROOT" "$template" || exit 97
    expect_tmpdir=false
    for argument in "${mktemp_args[@]:0:${#mktemp_args[@]}-1}"; do
      if [[ "$expect_tmpdir" == true ]]; then safe_under "$FAKE_CURL_ROOT" "$argument" || exit 97; expect_tmpdir=false; continue; fi
      case "$argument" in
        -d) ;;
        -p|--tmpdir) expect_tmpdir=true ;;
        --tmpdir=*) safe_under "$FAKE_CURL_ROOT" "${argument#*=}" || exit 97 ;;
        -*) exit 64 ;;
        *) exit 64 ;;
      esac
    done
    [[ "$expect_tmpdir" == false ]] || exit 64
    /usr/bin/mktemp "${mktemp_args[@]}"
    ;;
  rm)
    rm_args=("$@")
    rm_targets=()
    for argument in "${rm_args[@]}"; do case "$argument" in --|-f) ;; -*) exit 64 ;; *) rm_targets+=("$argument") ;; esac; done
    (( ${#rm_targets[@]} > 0 )) || exit 64
    for target in "${rm_targets[@]}"; do safe_under "$FAKE_CURL_ROOT" "$target" || exit 97; done
    /usr/bin/rm "${rm_args[@]}"
    ;;
  journalctl|findmnt|smartctl|mount|umount|nft|ping|nc|wget|dd|truncate|touch|tee|ln|rsync|sudo|ssh|scp|socat)
    printf '%s\n' "$FAKE_RUNNER_JOURNAL_CANARY" >&2
    exit 97
    ;;
  *) exit 64 ;;
esac
FAKE
chmod 0555 "$fake_bin/fake-recovery-command"
for command_name in systemctl virsh docker curl sleep \
  journalctl findmnt smartctl mount umount nft ping nc wget dd truncate touch tee ln rsync sudo ssh scp socat; do
  cp "$fake_bin/fake-recovery-command" "$fake_bin/$command_name"
done
chmod 0555 "$fake_bin"/*
fake_recovery_sha256="$(sha256_file "$fake_bin/fake-recovery-command")" || fail 'could not hash strict recovery fake command'
for command_name in "${checker_fake_commands[@]}"; do
  verify_exact_staged_shell_source "$fake_bin/$command_name" "$bash_bin" "#!$bash_bin" "$fake_recovery_sha256" ||
    fail "recovery fake command identity is not verified: $command_name"
done

outside_sentinel="$work/outside-fake-roots.sentinel"
printf '%s' 'outside-fixture-sentinel-unchanged' >"$outside_sentinel"
set +e
PATH="$fake_bin" "$fake_bin/cat" -- "$outside_sentinel" >"$work/outside-read.stdout" 2>"$work/outside-read.stderr"
outside_read_status=$?
PATH="$fake_bin" cp -- "$baseline" "$outside_sentinel" >"$work/outside-write.stdout" 2>"$work/outside-write.stderr"
outside_write_status=$?
PATH="$fake_bin" recovery-contract-unknown-command >"$work/outside-unknown.stdout" 2>"$work/outside-unknown.stderr"
outside_unknown_status=$?
set -e
(( outside_read_status != 0 && outside_write_status != 0 && outside_unknown_status != 0 )) ||
  fail 'fake-only recovery PATH allowed an unknown, outside read, or outside write command'
[[ "$(<"$outside_sentinel")" == 'outside-fixture-sentinel-unchanged' ]] ||
  fail 'outside-fixture recovery sentinel was modified'

verify_fixed_outer_binary() {
  local binary="$1"
  local regular_only="${2:-false}"
  local metadata owner group mode mode_value
  [[ "$binary" == /usr/bin/* && -f "$binary" && -x "$binary" ]] || return 1
  [[ "$regular_only" != true || ! -L "$binary" ]] || return 1
  metadata="$(/usr/bin/stat -L -c '%u:%g:%a' -- "$binary")" || return 1
  IFS=: read -r owner group mode <<<"$metadata"
  [[ "$owner" == 0 && "$group" == 0 && "$mode" =~ ^[0-7]{3,4}$ ]] || return 1
  mode_value=$((8#$mode))
  (( (mode_value & 8#022) == 0 ))
}

resource_limit_args=(
  --nproc=64:64 --nofile=128:128 --core=0:0 --cpu=30:30
  --as=536870912:536870912 --fsize=1048576:1048576
  --data=268435456:268435456 --stack=16777216:16777216 --rss=268435456:268435456
)

assert_exact_resource_limits() {
  local -a candidate=("$@")
  local -a expected=(
    --nproc=64:64 --nofile=128:128 --core=0:0 --cpu=30:30
    --as=536870912:536870912 --fsize=1048576:1048576
    --data=268435456:268435456 --stack=16777216:16777216 --rss=268435456:268435456
  )
  local index
  (( ${#candidate[@]} == ${#expected[@]} )) || return 1
  for index in "${!expected[@]}"; do
    [[ "${candidate[$index]}" == "${expected[$index]}" ]] || return 1
  done
}

assert_resource_limit_mutations() {
  local missing_label weakened_label target weakened token
  local -a candidate=()
  while IFS='|' read -r missing_label weakened_label target weakened; do
    candidate=(); for token in "${resource_limit_args[@]}"; do [[ "$token" == "$target" ]] || candidate+=("$token"); done
    ! assert_exact_resource_limits "${candidate[@]}" || fail "resource mutation gate accepted $missing_label"
    candidate=(); for token in "${resource_limit_args[@]}"; do [[ "$token" == "$target" ]] && candidate+=("$weakened") || candidate+=("$token"); done
    ! assert_exact_resource_limits "${candidate[@]}" || fail "resource mutation gate accepted $weakened_label"
  done <<'EOF'
missing-address-space-limit|weakened-address-space-limit|--as=536870912:536870912|--as=1073741824:1073741824
missing-file-size-limit|weakened-file-size-limit|--fsize=1048576:1048576|--fsize=2097152:2097152
missing-data-limit|weakened-data-limit|--data=268435456:268435456|--data=536870912:536870912
missing-stack-limit|weakened-stack-limit|--stack=16777216:16777216|--stack=33554432:33554432
missing-rss-limit|weakened-rss-limit|--rss=268435456:268435456|--rss=536870912:536870912
missing-process-count-limit|weakened-process-count-limit|--nproc=64:64|--nproc=128:128
missing-file-descriptor-limit|weakened-file-descriptor-limit|--nofile=128:128|--nofile=256:256
missing-core-limit|weakened-core-limit|--core=0:0|--core=1:1
missing-cpu-limit|weakened-cpu-limit|--cpu=30:30|--cpu=60:60
EOF
  candidate=("${resource_limit_args[@]}" "${resource_limit_args[0]}")
  ! assert_exact_resource_limits "${candidate[@]}" || fail 'resource mutation gate accepted duplicate-resource-limit'
}

verify_minimal_runtime_file() {
  local source="$1" metadata owner group mode mode_value
  [[ "$source" == /* && "$source" != *'/../'* && "$source" != */.. && -f "$source" && -r "$source" ]] || return 1
  metadata="$(/usr/bin/stat -L -c '%u:%g:%a' -- "$source")" || return 1
  IFS=: read -r owner group mode <<<"$metadata"
  [[ "$owner" == 0 && "$group" == 0 && "$mode" =~ ^[0-7]{3,4}$ ]] || return 1
  mode_value=$((8#$mode)); (( (mode_value & 8#022) == 0 ))
}

prepare_minimal_runtime_mounts() {
  local binary ldd_output line first second third dependency
  local -A seen=()
  minimal_runtime_mounts=()
  verify_fixed_outer_binary /usr/bin/ldd true || return 1
  for binary in "$@"; do
    verify_minimal_runtime_file "$binary" || return 1
    if [[ -z "${seen[$binary]:-}" ]]; then minimal_runtime_mounts+=(--ro-bind "$binary" "$binary"); seen["$binary"]=1; fi
    ldd_output="$(/usr/bin/ldd -- "$binary")" || return 1
    [[ "$ldd_output" != *'not found'* ]] || return 1
    while IFS= read -r line; do
      read -r first second third _ <<<"$line"; dependency=
      if [[ "${first:-}" == /* ]]; then dependency="$first"; elif [[ "${second:-}" == '=>' && "${third:-}" == /* ]]; then dependency="$third"; fi
      [[ -n "$dependency" ]] || continue
      verify_minimal_runtime_file "$dependency" || return 1
      if [[ -z "${seen[$dependency]:-}" ]]; then minimal_runtime_mounts+=(--ro-bind "$dependency" "$dependency"); seen["$dependency"]=1; fi
    done <<<"$ldd_output"
  done
}

assert_resource_limit_mutations
assert_exact_resource_limits "${resource_limit_args[@]}" || fail 'canonical resource-limit vector is not exact'

assert_containment_gate_mutations() {
  local sentinel="$work/containment-gate.sentinel"
  local rejected="$work/rejected-bwrap"
  local candidate="$work/containment-candidate"
  local status
  printf '%s' unchanged >"$sentinel"
  printf '#!%s\n%s\n' "$bash_bin" 'exit 77' >"$rejected"
  printf '#!%s\nprintf reached >%q\n' "$bash_bin" "$sentinel" >"$candidate"
  chmod 0700 "$rejected" "$candidate"
  verify_fixed_outer_binary "$work/missing-bwrap" true && fail 'missing Bubblewrap dependency was accepted'
  set +e
  "$env_bin" -i PATH= "$rejected" --unshare-user --unshare-pid --unshare-net -- "$candidate" >/dev/null 2>&1
  status=$?
  set -e
  [[ "$status" == 77 && "$(<"$sentinel")" == unchanged ]] ||
    fail 'rejected containment reached the recovery checker sentinel'
}

prepare_linux_containment() {
  local entry="$work/namespace-entry.sh"
  local outside="/tmp/learncoding-recovery-check-outside-$$"
  local binary probe_status preflight_ro_probes python_extension_output extension

  [[ "$(/usr/bin/uname -s 2>/dev/null || true)" == Linux && "$EUID" == 0 ]] ||
    fail 'authoritative recovery checker contract requires Ubuntu/Linux root with Bubblewrap user/mount/PID/network containment'
  for binary in /usr/bin/stat /usr/bin/uname /usr/bin/bash /usr/bin/env /usr/bin/sha256sum \
    /usr/bin/timeout /usr/bin/prlimit /usr/bin/setpriv /usr/bin/node /usr/bin/python3 /usr/bin/ldd /usr/bin/mktemp /usr/bin/rm; do
    verify_fixed_outer_binary "$binary" false || fail "containment dependency is not fixed root-owned and non-writable: $binary"
  done
  verify_fixed_outer_binary /usr/bin/bwrap true ||
    fail '/usr/bin/bwrap must be a regular root-owned non-writable authoritative test dependency'

  containment_probe_dir="$work/containment-output-probe"
  mkdir -m 0700 -p "$containment_probe_dir"
  {
    printf '%s\n' '#!/usr/bin/bash'
    printf 'readonly containment_probe_dir=%q\nreadonly containment_outside=%q\nreadonly containment_repo=%q\n' \
      "$containment_probe_dir" "$outside" "$repo_root"
    cat <<'EOF'
set -Eeuo pipefail
[[ "$EUID" == 0 && "$$" == 1 ]] || exit 90
assert_exact_resource_limit() {
  local label="$1" expected_soft="$2" expected_hard="$3" line remainder soft hard units found=0
  while IFS= read -r line; do
    [[ "$line" == "$label"* ]] || continue
    remainder="${line#"$label"}"; read -r soft hard units <<<"$remainder"
    [[ "$soft" == "$expected_soft" && "$hard" == "$expected_hard" ]] || exit 96
    found=$((found + 1))
  done </proc/self/limits
  [[ "$found" == 1 ]] || exit 96
}
assert_exact_resource_limit 'Max processes' 64 64
assert_exact_resource_limit 'Max open files' 128 128
assert_exact_resource_limit 'Max core file size' 0 0
assert_exact_resource_limit 'Max cpu time' 30 30
assert_exact_resource_limit 'Max address space' 536870912 536870912
assert_exact_resource_limit 'Max file size' 1048576 1048576
assert_exact_resource_limit 'Max data size' 268435456 268435456
assert_exact_resource_limit 'Max stack size' 16777216 16777216
assert_exact_resource_limit 'Max resident set' 268435456 268435456
capability_set_count=0 no_new_privs=
while IFS=$'\t ' read -r key value _; do
  case "$key" in
    CapEff:|CapPrm:|CapInh:|CapBnd:|CapAmb:) [[ "$value" =~ ^0+$ ]] || exit 91; capability_set_count=$((capability_set_count + 1)) ;;
    Groups:) [[ -z "${value:-}" ]] || exit 91 ;;
    NoNewPrivs:) no_new_privs="$value" ;;
  esac
done </proc/self/status
[[ "$capability_set_count" == 5 && "$no_new_privs" == 1 ]] || exit 91
interface_count=0
while IFS= read -r line; do
  case "$line" in *:*) interface="${line%%:*}"; interface="${interface//[[:space:]]/}"; [[ "$interface" == lo ]] || exit 92; interface_count=$((interface_count + 1)) ;; esac
done </proc/net/dev
[[ "$interface_count" == 1 ]] || exit 92
[[ ! -e /run/docker.sock && ! -e /run/libvirt/libvirt-sock && ! -e /dev/kvm ]] || exit 93
repo_fixture_mounted=0
[[ -e "$containment_repo" ]] && repo_fixture_mounted=1
for protected_root in /bin /sbin /usr/local /boot /sys /var /etc /home /root; do
  if (( repo_fixture_mounted == 1 )) && { [[ "$containment_repo" == "$protected_root" ]] || [[ "$containment_repo" == "$protected_root"/* ]]; }; then continue; fi
  [[ ! -e "$protected_root" ]] || exit 94
done
[[ ! -e /etc/learncoding && ! -e /var/lib/learncoding ]] || exit 94
[[ ! -e "$containment_repo/.env" && ! -e "$containment_repo/.git" ]] || exit 94
if { : >"$containment_outside"; } 2>/dev/null; then exit 95; fi
IFS=: read -r -a containment_ro_probe_paths <<<"${CONTAINMENT_RO_PROBES:-}"
for protected_path in "${containment_ro_probe_paths[@]}"; do
  [[ -n "$protected_path" && -e "$protected_path" ]] || exit 97
  if [[ -d "$protected_path" ]]; then
    if { : >"$protected_path/.namespace-ro-mutation"; } 2>/dev/null; then exit 97; fi
  elif { printf x >>"$protected_path"; } 2>/dev/null; then exit 97
  fi
done
: >"$containment_probe_dir/.namespace-write-probe"
if [[ "${CONTAINMENT_EXPECT_REGULAR_OUTPUTS:-0}" == 1 ]]; then [[ -f /proc/self/fd/1 && -f /proc/self/fd/2 ]] || exit 98; fi
exec "$@"
EOF
  } >"$entry"
  chmod 0500 "$entry"
  containment_entry="$entry"
  containment_entry_sha256="$(sha256_file "$entry")" || fail 'could not hash namespace entry'
  verify_exact_staged_shell_source "$entry" /usr/bin/bash '#!/usr/bin/bash' "$containment_entry_sha256" ||
    fail 'namespace entry identity is not verified'

  python_stdlib="$("$python_bin" -c 'import sysconfig; print(sysconfig.get_path("stdlib"))')" ||
    fail 'could not locate the fixed Python standard library'
  [[ "$python_stdlib" == /usr/lib/python3.* && -d "$python_stdlib" && ! -L "$python_stdlib" ]] ||
    fail 'Python standard library path is not fixed below /usr/lib'
  python_stdlib_metadata="$(/usr/bin/stat -c '%u:%g:%a' -- "$python_stdlib")" ||
    fail 'could not verify Python standard library metadata'
  IFS=: read -r python_stdlib_owner python_stdlib_group python_stdlib_mode <<<"$python_stdlib_metadata"
  [[ "$python_stdlib_owner" == 0 && "$python_stdlib_group" == 0 && "$python_stdlib_mode" =~ ^[0-7]{3,4}$ ]] ||
    fail 'Python standard library ownership is unsafe'
  (( (8#$python_stdlib_mode & 8#022) == 0 )) || fail 'Python standard library is group/world writable'
  python_extension_output="$(PYTHONPATH="$work" "$python_bin" -c 'import runpy, sys; from importlib.machinery import ExtensionFileLoader; runpy.run_path(sys.argv[1], run_name="_recovery_dependency_scan"); print("\n".join(sorted({module.__file__ for module in list(sys.modules.values()) if isinstance(getattr(module, "__loader__", None), ExtensionFileLoader) and isinstance(getattr(module, "__file__", None), str)})))' "$checker_helper_stage")" ||
    fail 'could not enumerate Python extension dependencies for the recovery checker'
  mapfile -t python_extension_modules <<<"$python_extension_output"
  (( ${#python_extension_modules[@]} > 0 )) || fail 'Python recovery runtime did not expose any extension modules'
  for extension in "${python_extension_modules[@]}"; do
    [[ "$extension" == "$python_stdlib"/* && -f "$extension" && ! -L "$extension" ]] ||
      fail 'Python recovery extension escaped the fixed standard library'
  done
  prepare_minimal_runtime_mounts /usr/bin/bash /usr/bin/python3 /usr/bin/timeout /usr/bin/setpriv "${python_extension_modules[@]}" ||
    fail 'could not assemble the minimal recovery-check runtime'
  containment_ro_mounts=(
    --ro-bind "$entry" "$entry"
    --ro-bind "$checker_under_test" "$checker_under_test"
    --ro-bind "$checker_helper_stage" "$checker_helper_stage"
    --ro-bind "$checker_baseline_module_stage" "$checker_baseline_module_stage"
    --ro-bind "$existing_alpha_inspection" "$existing_alpha_inspection"
    --ro-bind "$existing_bravo_inspection" "$existing_bravo_inspection"
    --ro-bind "$existing_bravo_stopped_inspection" "$existing_bravo_stopped_inspection"
    --ro-bind "$existing_bravo_id_drift_inspection" "$existing_bravo_id_drift_inspection"
    --ro-bind "$existing_bravo_image_drift_inspection" "$existing_bravo_image_drift_inspection"
    --ro-bind "$existing_bravo_config_drift_inspection" "$existing_bravo_config_drift_inspection"
    --ro-bind "$existing_bravo_restart_drift_inspection" "$existing_bravo_restart_drift_inspection"
    --ro-bind "$existing_bravo_health_drift_inspection" "$existing_bravo_health_drift_inspection"
    --ro-bind "$existing_bravo_paused_inspection" "$existing_bravo_paused_inspection"
    --ro-bind "$existing_bravo_restarting_inspection" "$existing_bravo_restarting_inspection"
    --ro-bind "$existing_bravo_dead_inspection" "$existing_bravo_dead_inspection"
    --ro-bind "$existing_bravo_status_drift_inspection" "$existing_bravo_status_drift_inspection"
    --ro-bind "$fake_bin" "$fake_bin"
    --ro-bind "$python_stdlib" "$python_stdlib"
    --ro-bind "$scenario_file" "$scenario_file"
    --ro-bind "$runner_body_file" "$runner_body_file"
    --ro-bind "$runner_signature_file" "$runner_signature_file"
    --ro-bind "$runner_concurrency_body_file" "$runner_concurrency_body_file"
    --ro-bind "$runner_concurrency_signature_file" "$runner_concurrency_signature_file"
    --ro-bind "$runner_expired_body_file" "$runner_expired_body_file"
    --ro-bind "$runner_expired_signature_file" "$runner_expired_signature_file"
    --ro-bind "$compose_env_reviewed" "$compose_env_reviewed"
    --ro-bind "$compose_file_reviewed" "$compose_file_reviewed"
    --ro-bind "$host_root/etc" "$host_root/etc"
    --ro-bind "$host_root/opt" "$host_root/opt"
  )
  containment_rw_mounts=(--bind "$containment_probe_dir" "$containment_probe_dir")
  recovery_execution_rw_mounts=(
    --bind "$clock_file" "$clock_file"
    --bind "$curl_root" "$curl_root"
    --bind "$events" "$events"
    --bind "$diagnostic_file" "$diagnostic_file"
  )
  recovery_compose_input_rw_mounts=(
    --bind "$compose_env_path" "$compose_env_path"
    --bind "$compose_file_path" "$compose_file_path"
  )
  containment_command=(
    /usr/bin/timeout --signal=KILL --kill-after=5s 45s
    /usr/bin/prlimit "${resource_limit_args[@]}" --
    /usr/bin/setpriv --clear-groups
    /usr/bin/bwrap --die-with-parent --new-session --unshare-user --uid 0 --gid 0
    --unshare-pid --unshare-net --unshare-ipc --unshare-uts --disable-userns
    --cap-drop ALL --as-pid-1
    --tmpfs /
    "${minimal_runtime_mounts[@]}"
    --perms 0700 --dir "$host_root" --dir "$host_root/etc/learncoding/secrets" \
    --dir "$host_root/opt/learncoding" --dir "$repo_root"
    "${containment_ro_mounts[@]}"
    "${containment_rw_mounts[@]}"
    --proc /proc --dev /dev --remount-ro / --chdir "$containment_probe_dir" --
    /usr/bin/setpriv --no-new-privs
    /usr/bin/bash "$entry"
  )
  preflight_ro_probes="$entry:$checker_under_test:$checker_helper_stage:$checker_baseline_module_stage:$fake_bin:$python_stdlib:$scenario_file:$runner_body_file:$runner_signature_file:$runner_concurrency_body_file:$runner_concurrency_signature_file:$runner_expired_body_file:$runner_expired_signature_file:$existing_alpha_inspection:$existing_bravo_inspection:$existing_bravo_stopped_inspection:$existing_bravo_id_drift_inspection:$existing_bravo_image_drift_inspection:$existing_bravo_config_drift_inspection:$existing_bravo_restart_drift_inspection:$existing_bravo_health_drift_inspection:$existing_bravo_paused_inspection:$existing_bravo_restarting_inspection:$existing_bravo_dead_inspection:$existing_bravo_status_drift_inspection:$compose_env_reviewed:$compose_file_reviewed:$host_root/etc:$host_root/opt"
  set +e
  /usr/bin/env -i PATH= HOME="$containment_probe_dir" CONTAINMENT_RO_PROBES="$preflight_ro_probes" \
    "${containment_command[@]}" /usr/bin/bash -c ':' >/dev/null 2>"$work/containment-preflight.stderr"
  probe_status=$?
  set -e
  if (( probe_status != 0 )); then
    while IFS= read -r diagnostic_line; do
      printf 'containment preflight: %s\n' "$diagnostic_line" >&2
    done <"$work/containment-preflight.stderr"
    fail 'Bubblewrap containment preflight or mandatory user namespace was rejected'
  fi
  [[ -f "$containment_probe_dir/.namespace-write-probe" && ! -e "$outside" ]] || fail 'containment did not prove fixture-only writes'
}

assert_recovery_execution_identity() {
  local command_name
  verify_exact_staged_shell_source "$checker_stage" "$bash_bin" "$checker_shebang" "$checker_reviewed_sha256" ||
    fail 'recovery checker source stage changed after transformation'
  verify_exact_staged_shell_source "$checker_under_test" "$bash_bin" "#!$bash_bin" "$checker_under_test_sha256" ||
    fail 'transformed recovery checker changed before execution'
  [[ "$(sha256_file "$checker_helper_stage")" == "$checker_helper_reviewed_sha256" ]] ||
    fail 'staged recovery checker helper changed before execution'
  [[ "$(sha256_file "$checker_baseline_module_stage")" == "$checker_baseline_module_reviewed_sha256" ]] ||
    fail 'staged container baseline module changed before execution'
  verify_exact_staged_shell_source "$containment_entry" /usr/bin/bash '#!/usr/bin/bash' "$containment_entry_sha256" ||
    fail 'namespace entry changed before recovery checker execution'
  for command_name in "${checker_fake_commands[@]}"; do
    verify_exact_staged_shell_source "$fake_bin/$command_name" "$bash_bin" "#!$bash_bin" "$fake_recovery_sha256" ||
      fail "recovery fake command changed before execution: $command_name"
  done
  verify_fixed_outer_binary /usr/bin/bwrap true || fail 'Bubblewrap changed before recovery checker execution'
  assert_exact_resource_limits "${resource_limit_args[@]}" || fail 'recovery resource-limit vector changed before execution'
  prepare_minimal_runtime_mounts /usr/bin/bash /usr/bin/python3 /usr/bin/timeout /usr/bin/setpriv "${python_extension_modules[@]}" ||
    fail 'recovery minimal runtime changed before execution'
}

assert_containment_gate_mutations
prepare_linux_containment

run_checker() {
  local scenario="$1"
  local prefix="$2"
  local token
  local watchdog_seconds=10
  local fake_signal_phase=
  local -a execution_containment=()
  local -a execution_rw_mounts=("${recovery_execution_rw_mounts[@]}")
  local -a checker_invocation=(/usr/bin/bash "$checker_under_test")
  local ro_probes="$containment_entry:$checker_under_test:$checker_helper_stage:$checker_baseline_module_stage:$fake_bin:$python_stdlib:$scenario_file:$runner_body_file:$runner_signature_file:$runner_concurrency_body_file:$runner_concurrency_signature_file:$runner_expired_body_file:$runner_expired_signature_file:$existing_alpha_inspection:$existing_bravo_inspection:$existing_bravo_stopped_inspection:$existing_bravo_id_drift_inspection:$existing_bravo_image_drift_inspection:$existing_bravo_config_drift_inspection:$existing_bravo_restart_drift_inspection:$existing_bravo_health_drift_inspection:$existing_bravo_paused_inspection:$existing_bravo_restarting_inspection:$existing_bravo_dead_inspection:$existing_bravo_status_drift_inspection:$compose_env_reviewed:$compose_file_reviewed:$host_root/etc:$host_root/opt"
  [[ "$scenario" != watchdog-hang ]] || watchdog_seconds=1
  if [[ "$scenario" == signal-hang ]]; then
    checker_invocation=(/usr/bin/timeout --foreground --signal=TERM --kill-after=5s 1s /usr/bin/bash "$checker_under_test")
  fi
  if [[ "$scenario" == leader-exits-child-holds-command || "$scenario" == leader-exits-child-holds-http ]]; then
    checker_invocation=(/usr/bin/python3 -c '
import os
import sys
import time

child_pid = os.fork()
if child_pid == 0:
    os.execv(sys.argv[1], sys.argv[1:])

child_status = None
while child_status is None:
    try:
        waited_pid, status = os.waitpid(-1, os.WNOHANG)
    except ChildProcessError:
        raise SystemExit(99)
    if waited_pid == 0:
        time.sleep(0.01)
    elif waited_pid == child_pid:
        child_status = status

observe_until = time.monotonic() + 5.0
while time.monotonic() < observe_until:
    try:
        while os.waitpid(-1, os.WNOHANG)[0] != 0:
            pass
    except ChildProcessError:
        pass
    time.sleep(0.01)

if os.WIFEXITED(child_status):
    raise SystemExit(os.WEXITSTATUS(child_status))
if os.WIFSIGNALED(child_status):
    raise SystemExit(128 + os.WTERMSIG(child_status))
raise SystemExit(98)
' /usr/bin/bash "$checker_under_test")
  fi
  case "$scenario" in
    signal-before-spawn) fake_signal_phase=before-spawn ;;
    signal-after-assignment) fake_signal_phase=after-assignment ;;
    signal-reading) fake_signal_phase=reading ;;
    signal-cleanup-repeated) fake_signal_phase=cleanup:repeated ;;
    signal-before-write) fake_signal_phase=before-write ;;
  esac
  case "$scenario" in
    compose-env-inplace|compose-env-change-restore|compose-yaml-inplace|compose-yaml-change-restore)
      execution_rw_mounts+=("${recovery_compose_input_rw_mounts[@]}") ;;
  esac
  printf '%s' "$scenario" >"$scenario_file"
  printf '%s' 0 >"$clock_file"
  rm -f -- "$descendant_sentinel"
  : >"$diagnostic_file"
  : >"$events"
  for token in "${containment_command[@]}"; do
    if [[ "$token" == --proc ]]; then execution_containment+=("${execution_rw_mounts[@]}"); fi
    execution_containment+=("$token")
  done
  set +e
  assert_recovery_execution_identity
  printf '%s' "$stdin_canary" | /usr/bin/env -i \
    HOME="$containment_probe_dir" \
    PATH= \
    CONTAINMENT_RO_PROBES="$ro_probes" \
    CONTAINMENT_EXPECT_REGULAR_OUTPUTS=1 \
    TMPDIR="$curl_root" \
    RECOVERY_CHECK_TEST_ROOT="$host_root" \
    RECOVERY_CHECK_TEST_HELPER="$checker_helper_stage" \
    RECOVERY_CHECK_TEST_RUNNER_SECRET_GID=65534 \
    RECOVERY_CHECK_TEST_COMMAND_ROOT="$fake_bin" \
    RECOVERY_CHECK_TEST_MONOTONIC_FILE="$clock_file" \
    RECOVERY_CHECK_TEST_EPOCH=1784116800 \
    RECOVERY_CHECK_TEST_WATCHDOG_SECONDS="$watchdog_seconds" \
    FAKE_SIGNAL_PHASE="$fake_signal_phase" \
    FAKE_HTTP_TIMEOUT_SECONDS=2 \
    RECOVERY_PUBLIC_URL='https://attacker.invalid/health/ready' \
    RUNNER_BASE_URL='http://203.0.113.99:9999' \
    RUNNER_SHARED_SECRET_FILE='/tmp/attacker-secret' \
    PGHOST='attacker.invalid' PGPORT=9999 PGDATABASE=attacker PGUSER=attacker \
    PSQLRC='/tmp/attacker-psqlrc' CURL_HOME='/tmp/attacker-curl' \
    DOCKER_HOST='tcp://attacker.invalid:2375' DOCKER_CONTEXT=attacker \
    COMPOSE_PROFILES='uploads,operations' \
    FAKE_EVENTS="$events" \
    FAKE_DIAGNOSTIC_FILE="$diagnostic_file" \
    FAKE_SCENARIO_FILE="$scenario_file" \
    FAKE_STATE_ROOT="$state_root" \
    FAKE_HOST_ROOT="$host_root" \
    FAKE_CURL_ROOT="$curl_root" \
    FAKE_DESCENDANT_SENTINEL="$descendant_sentinel" \
    FAKE_CLOCK_FILE="$clock_file" \
    FAKE_RUNNER_BODY_FILE="$runner_body_file" \
    FAKE_RUNNER_SIGNATURE_FILE="$runner_signature_file" \
    FAKE_RUNNER_CONCURRENCY_BODY_FILE="$runner_concurrency_body_file" \
    FAKE_RUNNER_CONCURRENCY_SIGNATURE_FILE="$runner_concurrency_signature_file" \
    FAKE_RUNNER_EXPIRED_BODY_FILE="$runner_expired_body_file" \
    FAKE_RUNNER_EXPIRED_SIGNATURE_FILE="$runner_expired_signature_file" \
    FAKE_RUNNER_SECRET_FILE="$runner_secret_file" \
    FAKE_HTTP_BODY_CANARY="$http_body_canary" \
    FAKE_HTTP_HEADER_CANARY="$http_header_canary" \
    FAKE_RUNNER_OUTPUT_CANARY="$runner_output_canary" \
    FAKE_RUNNER_JOURNAL_CANARY="$runner_journal_canary" \
    FAKE_RAW_COMMAND_CANARY="$raw_command_canary" \
    FAKE_LEARNER_CANARY="$learner_canary" \
    FAKE_SOURCE_CANARY="$source_canary" \
    FAKE_COMPOSE_ENV="$compose_env_path" \
    FAKE_COMPOSE_FILE="$compose_file_path" \
    FAKE_COMPOSE_ENV_REVIEWED="$compose_env_reviewed" \
    FAKE_COMPOSE_FILE_REVIEWED="$compose_file_reviewed" \
    FAKE_PROJECT_DIRECTORY="$host_root/opt/learncoding" \
    FAKE_POSTGRES_SQL="$postgres_sql" \
    "${execution_containment[@]}" "${checker_invocation[@]}" >"$prefix.stdout" 2>"$prefix.stderr"
  checker_status=$?
  set -e
  case "$scenario" in
    compose-env-inplace|compose-env-change-restore|compose-yaml-inplace|compose-yaml-change-restore)
      cp -- "$compose_env_reviewed" "$compose_env_path"
      cp -- "$compose_file_reviewed" "$compose_file_path"
      chown 0:0 "$compose_env_path" "$compose_file_path"
      chmod 0640 "$compose_env_path"
      chmod 0644 "$compose_file_path"
      ;;
  esac
  [[ "$(<"$outside_sentinel")" == 'outside-fixture-sentinel-unchanged' ]] ||
    fail 'recovery checker modified the outside-fixture sentinel'
  shopt -s nullglob dotglob
  recovery_temp_leftovers=("$curl_root"/*)
  shopt -u nullglob dotglob
  for recovery_temp_leftover in "${recovery_temp_leftovers[@]}"; do
    [[ "$recovery_temp_leftover" == "$descendant_sentinel" ]] ||
      fail "recovery checker left HTTP temporary files behind: $scenario"
  done
}

validate_json_contract() {
  local output_file="$1"
  local expected_recovered="$2"
  local expected_timeout="$3"
  local expected_elapsed="$4"
  local expected_health_map="$5"
  local expected_count="$6"
  local running_count="$7"
  local line_count node_status
  line_count="$(grep -cve '^[[:space:]]*$' "$output_file" || true)"
  [[ "$line_count" == 1 ]] || fail "checker must emit exactly one final JSON object: ${output_file##*/}"
  set +e
  EXPECTED_RECOVERED="$expected_recovered" EXPECTED_TIMEOUT="$expected_timeout" \
    EXPECTED_ELAPSED="$expected_elapsed" EXPECTED_HEALTH_MAP="$expected_health_map" \
    EXPECTED_COUNT="$expected_count" RUNNING_COUNT="$running_count" \
    OUTPUT_FILE="$output_file" "$node_bin" <<'NODE'
const fs = require("node:fs");
const allowed = [
  "appHealthy", "cloudflaredHealthy", "dockerHealthy", "elapsedSeconds",
  "existingContainersExpected", "existingContainersRunning", "firewallHealthy",
  "libvirtHealthy", "postgresDurable", "postgresHealthy", "publicHttpsHealthy",
  "recovered", "runnerHealthy", "schemaVersion", "timedOut", "timersHealthy", "workersHealthy",
].sort();
const value = JSON.parse(fs.readFileSync(process.env.OUTPUT_FILE, "utf8"));
if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(allowed)) process.exit(2);
if (value.schemaVersion !== 1) process.exit(3);
for (const key of allowed.filter((key) => key.endsWith("Healthy") || key === "postgresDurable" || key === "recovered" || key === "timedOut")) {
  if (typeof value[key] !== "boolean") process.exit(4);
}
for (const key of ["elapsedSeconds", "existingContainersExpected", "existingContainersRunning"]) {
  if (!Number.isSafeInteger(value[key]) || value[key] < 0) process.exit(5);
}
if (value.recovered !== (process.env.EXPECTED_RECOVERED === "true")) process.exit(6);
if (value.timedOut !== (process.env.EXPECTED_TIMEOUT === "true")) process.exit(7);
if (value.elapsedSeconds > 900) process.exit(8);
if (value.existingContainersRunning > value.existingContainersExpected) process.exit(9);
if (value.existingContainersExpected !== Number(process.env.EXPECTED_COUNT) ||
    value.existingContainersRunning !== Number(process.env.RUNNING_COUNT)) process.exit(10);
if (value.elapsedSeconds !== Number(process.env.EXPECTED_ELAPSED)) process.exit(11);
const healthKeys = allowed.filter((key) => key.endsWith("Healthy") || key === "postgresDurable");
const expectedHealth = Object.fromEntries((process.env.EXPECTED_HEALTH_MAP ?? "").split(",").filter(Boolean).map((entry) => {
  const [key, raw] = entry.split("=");
  if (raw !== "true" && raw !== "false") process.exit(12);
  return [key, raw === "true"];
}));
if (JSON.stringify(Object.keys(expectedHealth).sort()) !== JSON.stringify([...healthKeys].sort())) process.exit(13);
for (const key of healthKeys) {
  if (value[key] !== expectedHealth[key]) {
    console.error(`health mismatch ${key}: actual=${value[key]} expected=${expectedHealth[key]}`);
    process.exit(14);
  }
}
NODE
  node_status=$?
  set -e
  (( node_status == 0 )) || fail "JSON contract validation failed with status $node_status: ${output_file##*/}"
}

assert_private_result() {
  local prefix="$1"
  local canary
  local line command_name
  for canary in "$secret_canary" "$learner_canary" "$source_canary" "$stdin_canary" \
    "$http_body_canary" "$http_header_canary" "$runner_output_canary" "$runner_journal_canary" "$raw_command_canary"; do
    ! grep -Fq -- "$canary" "$prefix.stdout" || fail "checker leaked a canary to stdout: $canary"
    ! grep -Fq -- "$canary" "$prefix.stderr" || fail "checker leaked a canary to stderr: $canary"
    ! grep -Fq -- "$canary" "$events" || fail "fake event log captured private command data: $canary"
  done
  for private_name in legacy-alpha legacy-bravo; do
    ! grep -Fq -- "$private_name" "$prefix.stdout" || fail 'checker emitted a baseline container name'
    ! grep -Fq -- "$private_name" "$prefix.stderr" || fail 'checker echoed an unsafe baseline container name'
  done
  ! grep -Eq '/var/lib/learncoding-runner|journalctl[^\n]*learncoding-runner([[:space:].]|$)' "$events" ||
    fail 'checker attempted to inspect runner state or journal data'
  [[ ! -s "$prefix.stderr" ]] || fail "checker emitted progress or raw command output: $(<"$prefix.stderr")"
  while IFS= read -r line || [[ -n "$line" ]]; do
    command_name="${line%% *}"
    case "$command_name" in
      systemctl|virsh|docker|sleep) ;;
      curl) [[ "$line" == 'curl --disable '* ]] || fail 'curl did not disable ambient configuration first' ;;
      *) fail "recovery helper invoked an unreviewed command: $command_name" ;;
    esac
  done <"$events"
}

expect_result() {
  local scenario="$1"
  local expected_status="$2"
  local expected_recovered="$3"
  local expected_timeout="$4"
  local expected_elapsed="$5"
  local expected_health_map="$6"
  local expected_count="$7"
  local running_count="$8"
  local prefix="$work/result-$scenario"
  run_checker "$scenario" "$prefix"
  report_unexpected_result() {
    local label="$1" file="$2" line
    [[ -f "$file" ]] || return 0
    while IFS= read -r line; do
      printf '%s %s: %s\n' "$scenario" "$label" "$line" >&2
    done <"$file"
  }
  if [[ "$expected_status" == zero ]]; then
    if (( checker_status != 0 )); then
      report_unexpected_result stderr "$prefix.stderr"
      report_unexpected_result stdout "$prefix.stdout"
      report_unexpected_result events "$events"
      report_unexpected_result diagnostic "$diagnostic_file"
      fail "$scenario returned $checker_status, expected zero"
    fi
  else
    if (( checker_status == 0 )); then
      report_unexpected_result stderr "$prefix.stderr"
      report_unexpected_result stdout "$prefix.stdout"
      report_unexpected_result events "$events"
      report_unexpected_result diagnostic "$diagnostic_file"
      fail "$scenario returned zero, expected nonzero"
    fi
  fi
  validate_json_contract "$prefix.stdout" "$expected_recovered" "$expected_timeout" "$expected_elapsed" \
    "$expected_health_map" "$expected_count" "$running_count"
  assert_private_result "$prefix"
}

health_keys=(
  appHealthy cloudflaredHealthy dockerHealthy firewallHealthy libvirtHealthy postgresDurable
  postgresHealthy publicHttpsHealthy runnerHealthy timersHealthy workersHealthy
)
health_map_with_false() {
  local false_keys=",${1:-},"
  local key
  local separator=
  for key in "${health_keys[@]}"; do
    printf '%s%s=%s' "$separator" "$key" "$([[ "$false_keys" == *",$key,"* ]] && printf false || printf true)"
    separator=,
  done
}
all_true_health_map="$(health_map_with_false '')"
all_false_health_map='appHealthy=false,cloudflaredHealthy=false,dockerHealthy=false,firewallHealthy=false,libvirtHealthy=false,postgresDurable=false,postgresHealthy=false,publicHttpsHealthy=false,runnerHealthy=false,timersHealthy=false,workersHealthy=false'

expect_result immediate zero true false 0 "$all_true_health_map" 2 2
for timer in \
  learncoding-backup.timer learncoding-backup-check.timer \
  learncoding-offsite-sync.timer learncoding-offsite-retention.timer \
  learncoding-restore-drill-reminder.timer \
  learncoding-retention.timer learncoding-recovery-check.timer; do
  grep -Fxq "systemctl is-active $timer" "$events" || fail "recovery checker did not require active $timer"
  grep -Fxq "systemctl is-enabled $timer" "$events" || fail "recovery checker did not require enabled $timer"
done
expect_result delayed zero true false 30 "$all_true_health_map" 2 2
[[ "$(<"$clock_file")" == 30 ]] || fail 'delayed recovery did not use the virtual monotonic clock'

command_hang_started=$SECONDS
expect_result command-hang nonzero false true 900 "$(health_map_with_false dockerHealthy)" 2 2
command_hang_duration=$((SECONDS - command_hang_started))
(( command_hang_duration >= 1 && command_hang_duration < 8 )) || fail 'hung command escaped its independent per-call deadline'
grep -Fxq 'docker info' "$events" || fail 'hung Docker probe was not exercised'
command_error_started=$SECONDS
expect_result command-error nonzero false true 900 "$(health_map_with_false dockerHealthy)" 2 2
command_error_duration=$((SECONDS - command_error_started))
(( command_error_duration < command_hang_duration )) || fail 'ordinary child failure was misclassified as a timeout'
expect_result command-output-flood nonzero false true 900 "$(health_map_with_false dockerHealthy)" 2 2
expect_result command-stderr-flood nonzero false true 900 "$(health_map_with_false dockerHealthy)" 2 2

expect_result leader-exits-child-holds-command nonzero false true 900 "$(health_map_with_false dockerHealthy)" 2 2
[[ ! -e "$descendant_sentinel" ]] || fail 'exited command leader left a pipe-holding descendant alive'
expect_result leader-exits-child-holds-http nonzero false true 900 "$(health_map_with_false publicHttpsHealthy)" 2 2
[[ ! -e "$descendant_sentinel" ]] || fail 'exited HTTP leader left a pipe-holding descendant alive'

expect_result watchdog-hang nonzero false true 900 "$all_false_health_map" 0 0
expect_result signal-hang nonzero false false 0 "$all_false_health_map" 0 0
for signal_phase in signal-before-spawn signal-after-assignment signal-reading signal-cleanup-repeated signal-before-write; do
  expect_result "$signal_phase" nonzero false false 0 "$all_false_health_map" 0 0
done
expect_result clock-rewind nonzero false false 0 "$all_false_health_map" 0 0

for compose_race in compose-env-inplace compose-env-change-restore compose-yaml-inplace compose-yaml-change-restore; do
  expect_result "$compose_race" nonzero false false 0 "$all_false_health_map" 0 0
done

expect_result permanent nonzero false true 900 "$(health_map_with_false appHealthy)" 2 2
[[ "$(<"$clock_file")" == 900 ]] || fail 'permanent failure did not stop exactly at the 900-second bound'
last_sleep="$(grep '^sleep ' "$events" | tail -n 1)"
[[ "$last_sleep" == 'sleep 10' ]] || fail 'permanent failure used an unexpected polling sleep'

compose_failure_fields='appHealthy,cloudflaredHealthy,postgresDurable,postgresHealthy,workersHealthy'
for scenario in \
  docker-down libvirt-down firewall-down public-fail public-headers public-origin public-extra \
  public-body-lf public-body-nul public-body-oversize public-header-oversize public-status-201 \
  public-header-lf public-header-mixed public-header-control public-header-multiple public-header-truncated \
  public-hsts-zero public-hsts-excess public-csp-wrong public-content-type-jsonp \
  public-content-type-malformed public-content-type-duplicate existing-stopped \
  existing-id-drift existing-image-drift existing-config-drift existing-restart-drift \
  existing-health-drift existing-paused existing-restarting existing-dead existing-status-drift \
  runner-inactive runner-no-autostart runner-network-inactive runner-network-no-autostart \
  runner-network-wrong-bridge runner-network-not-persistent runner-network-route \
  runner-network-bridge-forward runner-network-open runner-network-ipv6 runner-network-trust-guest-rx-filters \
  runner-network-wrong-subnet runner-network-wrong-netmask runner-network-dhcp-missing \
  runner-network-dhcp-duplicate runner-network-dhcp-ip-conflict runner-network-extra-ip \
  runner-domain-not-persistent runner-domain-wrong-network runner-domain-wrong-address \
  runner-domain-direct runner-domain-bridge runner-domain-wrong-model runner-domain-wrong-mac \
  runner-domain-qemu runner-domain-extra-root \
  runner-domain-extra-interface runner-domain-extra-direct runner-domain-extra-address runner-domain-hostdev \
  runner-malformed runner-unsigned runner-expired runner-before-invocation runner-tampered \
  runner-concurrency runner-concurrency-length runner-request-mismatch runner-status-201 runner-replay \
  runner-body-lf runner-body-nul runner-body-oversize runner-header-oversize \
  postgres-unhealthy postgres-checksums-off postgres-fsync-off postgres-sync-off postgres-full-page-off \
  postgres-mount-type postgres-mount-source postgres-mount-readonly postgres-mount-duplicate \
  postgres-container-unhealthy file-erasure-incomplete app-incomplete app-malformed app-wrong-project app-duplicate \
  worker-incomplete worker-malformed worker-heartbeat-unhealthy cloudflared-incomplete cloudflared-malformed \
  compose-malformed-json compose-nested compose-duplicate-key compose-nonfinite compose-numeric-overflow compose-extra compose-stopped-extra \
  compose-model-missing compose-model-duplicate compose-model-extra \
  compose-wrong-name compose-wrong-service timer-incomplete timer-malformed timer-not-persistent ingress-recovery-timer-disabled; do
  expected_false=
  case "$scenario" in
    docker-down) expected_false=dockerHealthy ;;
    libvirt-down) expected_false='libvirtHealthy,runnerHealthy' ;;
    firewall-down) expected_false=firewallHealthy ;;
    public-*) expected_false=publicHttpsHealthy ;;
    runner-*) expected_false=runnerHealthy ;;
    postgres-unhealthy) expected_false=postgresHealthy ;;
    postgres-container-unhealthy) expected_false="$compose_failure_fields" ;;
    postgres-*) expected_false=postgresDurable ;;
    app-*|worker-*|file-erasure-*|cloudflared-*|compose-*) expected_false="$compose_failure_fields" ;;
    timer-*|ingress-recovery-timer-disabled) expected_false=timersHealthy ;;
  esac
  expected_count=2
  running_count=2
  [[ "$scenario" != existing-* ]] || running_count=1
  expect_result "$scenario" nonzero false true 900 "$(health_map_with_false "$expected_false")" \
    "$expected_count" "$running_count"
  if [[ "$scenario" == runner-replay ]]; then
    challenge_count="$(grep -Eo 'recovery-[0-9a-f]{32}' "$events" | sort -u | wc -l)"
    (( challenge_count >= 2 )) || fail 'runner probes reused the checker-generated request challenge'
  fi
done
EXISTING_STOPPED_FILE="$work/result-existing-stopped.stdout" "$node_bin" <<'NODE'
const fs = require("node:fs");
const value = JSON.parse(fs.readFileSync(process.env.EXISTING_STOPPED_FILE, "utf8"));
if (value.existingContainersExpected !== 2 || value.existingContainersRunning !== 1) process.exit(1);
NODE

cp "$baseline" "$work/baseline.saved"
chmod 0644 "$baseline"
expect_result baseline-mode nonzero false false 0 "$all_false_health_map" 0 0
cp "$work/baseline.saved" "$baseline"
chown 0:0 "$baseline"
chmod 0600 "$baseline"

printf '%s\n' 'invalid name with spaces' >"$baseline"
chmod 0600 "$baseline"
expect_result baseline-malformed nonzero false false 0 "$all_false_health_map" 0 0
cp "$work/baseline.saved" "$baseline"
chown 0:0 "$baseline"
chmod 0600 "$baseline"

mv "$baseline" "$baseline.real"
ln -s "$baseline.real" "$baseline"
expect_result baseline-symlink nonzero false false 0 "$all_false_health_map" 0 0
rm -- "$baseline"
mv "$baseline.real" "$baseline"

chown 65534:65534 "$baseline"
expect_result baseline-owner nonzero false false 0 "$all_false_health_map" 0 0
chown 0:0 "$baseline"
chmod 0600 "$baseline"

chmod 0770 "$host_root/etc/learncoding"
expect_result protected-parent-writable nonzero false false 0 "$all_false_health_map" 0 0
chmod 0700 "$host_root/etc/learncoding"

chown 65534:0 "$host_root/etc/learncoding"
chmod 0755 "$host_root/etc/learncoding"
expect_result protected-parent-owner nonzero false false 0 "$all_false_health_map" 0 0
chown 0:0 "$host_root/etc/learncoding"
chmod 0700 "$host_root/etc/learncoding"

mv "$host_root/etc/learncoding" "$host_root/etc/learncoding.real"
ln -s "$host_root/etc/learncoding.real" "$host_root/etc/learncoding"
expect_result protected-parent-symlink nonzero false false 0 "$all_false_health_map" 0 0
rm -- "$host_root/etc/learncoding"
mv "$host_root/etc/learncoding.real" "$host_root/etc/learncoding"

mv "$host_root/etc/learncoding" "$host_root/etc/learncoding.real"
printf '%s' not-a-directory >"$host_root/etc/learncoding"
chmod 0600 "$host_root/etc/learncoding"
expect_result protected-parent-nondirectory nonzero false false 0 "$all_false_health_map" 0 0
rm -- "$host_root/etc/learncoding"
mv "$host_root/etc/learncoding.real" "$host_root/etc/learncoding"

cp "$compose_env_path" "$work/compose-env.saved"
printf '%s\n' 'RUNNER_BASE_URL=http://192.168.122.12:4100' >"$compose_env_path"
chmod 0640 "$compose_env_path"
expect_result compose-env-missing-app nonzero false false 0 "$all_false_health_map" 0 0
printf '%s\n' 'APP_URL=https://pilot.example.test' 'APP_URL=https://duplicate.example.test' \
  'RUNNER_BASE_URL=http://192.168.122.12:4100' >"$compose_env_path"
expect_result compose-env-duplicate-app nonzero false false 0 "$all_false_health_map" 0 0
printf '%s\n' 'APP_URL=http://pilot.example.test' \
  'RUNNER_BASE_URL=http://192.168.122.12:4100' >"$compose_env_path"
expect_result compose-env-malformed-app nonzero false false 0 "$all_false_health_map" 0 0
printf '%s\n' 'APP_URL=https://pilot.example.test' \
  'RUNNER_BASE_URL=http://10.20.0.12:4100' >"$compose_env_path"
expect_result compose-env-wrong-runner nonzero false false 0 "$all_false_health_map" 0 0
printf '%s\n' 'APP_URL=https://pilot.example.test' \
  'RUNNER_BASE_URL=http://192.168.122.12:4100' \
  'UPLOADS_ENABLED=false' 'COMPOSE_PROFILES=' >"$compose_env_path"
cp "$compose_env_path" "$compose_env_reviewed"
chmod 0400 "$compose_env_reviewed"
expect_result compose-env-default-data-root zero true false 0 "$all_true_health_map" 2 2
cp "$work/compose-env.saved" "$compose_env_path"
cp "$work/compose-env.saved" "$compose_env_reviewed"
chown 0:0 "$compose_env_path"
chmod 0640 "$compose_env_path"
chmod 0400 "$compose_env_reviewed"

printf '%s\n' 'APP_URL=https://pilot.example.test' \
  'RUNNER_BASE_URL=http://192.168.122.12:4100' 'UPLOADS_ENABLED=true' \
  'COMPOSE_PROFILES=' >"$compose_env_path"
expect_result compose-env-uploads-enabled nonzero false false 0 "$all_false_health_map" 0 0
printf '%s\n' 'APP_URL=https://pilot.example.test' \
  'RUNNER_BASE_URL=http://192.168.122.12:4100' 'UPLOADS_ENABLED=false' \
  'COMPOSE_PROFILES=uploads,operations' >"$compose_env_path"
expect_result compose-env-active-profiles nonzero false false 0 "$all_false_health_map" 0 0

chmod 0644 "$compose_env_path"
expect_result compose-env-mode nonzero false false 0 "$all_false_health_map" 0 0
cp "$work/compose-env.saved" "$compose_env_path"
chown 0:0 "$compose_env_path"
chmod 0640 "$compose_env_path"

chown 0:65534 "$compose_env_path"
expect_result compose-env-group nonzero false false 0 "$all_false_health_map" 0 0
chown 0:0 "$compose_env_path"
chmod 0640 "$compose_env_path"

mv "$compose_env_path" "$compose_env_path.real"
ln -s "$compose_env_path.real" "$compose_env_path"
expect_result compose-env-symlink nonzero false false 0 "$all_false_health_map" 0 0
rm -- "$compose_env_path"
mv "$compose_env_path.real" "$compose_env_path"

mv "$compose_env_path" "$compose_env_path.real"
mkdir "$compose_env_path"
expect_result compose-env-nonregular nonzero false false 0 "$all_false_health_map" 0 0
rmdir "$compose_env_path"
mv "$compose_env_path.real" "$compose_env_path"

cp "$compose_file_path" "$work/compose-file.saved"
chmod 0664 "$compose_file_path"
expect_result compose-file-mode nonzero false false 0 "$all_false_health_map" 0 0
cp "$work/compose-file.saved" "$compose_file_path"
chown 0:0 "$compose_file_path"
chmod 0644 "$compose_file_path"

chown 0:65534 "$compose_file_path"
expect_result compose-file-group nonzero false false 0 "$all_false_health_map" 0 0
chown 0:0 "$compose_file_path"
chmod 0644 "$compose_file_path"

mv "$compose_file_path" "$compose_file_path.real"
ln -s "$compose_file_path.real" "$compose_file_path"
expect_result compose-file-symlink nonzero false false 0 "$all_false_health_map" 0 0
rm -- "$compose_file_path"
mv "$compose_file_path.real" "$compose_file_path"

mv "$compose_file_path" "$compose_file_path.real"
mkdir "$compose_file_path"
expect_result compose-file-nonregular nonzero false false 0 "$all_false_health_map" 0 0
rmdir "$compose_file_path"
mv "$compose_file_path.real" "$compose_file_path"

cp "$runner_secret_file" "$work/runner-secret.saved"
chown 0:0 "$runner_secret_file"
expect_result runner-secret-group nonzero false false 0 "$all_false_health_map" 0 0
cp "$work/runner-secret.saved" "$runner_secret_file"
chown 0:2000 "$runner_secret_file"
chmod 0440 "$runner_secret_file"

chmod 0400 "$runner_secret_file"
expect_result runner-secret-mode nonzero false false 0 "$all_false_health_map" 0 0
cp "$work/runner-secret.saved" "$runner_secret_file"
chown 0:2000 "$runner_secret_file"
chmod 0440 "$runner_secret_file"

mv "$runner_secret_file" "$runner_secret_file.real"
ln -s "$runner_secret_file.real" "$runner_secret_file"
expect_result runner-secret-symlink nonzero false false 0 "$all_false_health_map" 0 0
rm -- "$runner_secret_file"
mv "$runner_secret_file.real" "$runner_secret_file"

mv "$runner_secret_file" "$runner_secret_file.real"
mkdir "$runner_secret_file"
expect_result runner-secret-nonregular nonzero false false 0 "$all_false_health_map" 0 0
rmdir "$runner_secret_file"
mv "$runner_secret_file.real" "$runner_secret_file"

echo 'power-recovery-check-tests-ok'
