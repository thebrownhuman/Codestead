#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
helper="$repo_root/scripts/backup/run-managed-deadline.py"
backup_controller="$repo_root/scripts/backup/backup.sh"
stop_channel_gate="$repo_root/infra/tests/managed-deadline-stop-channel-linux.py"

github_escape() {
  local value="$1"
  value="${value//'%'/'%25'}"
  value="${value//$'\r'/'%0D'}"
  value="${value//$'\n'/'%0A'}"
  printf '%s' "$value"
}

emit_github_error() {
  local line="$1" message="$2"
  [[ "${GITHUB_ACTIONS:-}" == true ]] || return 0
  printf '::error file=infra/tests/managed-deadline-linux.test.sh,line=%s::%s\n' \
    "$line" "$(github_escape "$message")" >&2
}

fail() {
  local message="$1"
  emit_github_error "${BASH_LINENO[0]:-1}" "$message"
  printf '%s\n' "$message" >&2
  exit 1
}

report_unexpected_error() {
  local status=$? line="${BASH_LINENO[0]:-1}"
  trap - ERR
  emit_github_error "$line" \
    "managed-deadline Linux gate exited unexpectedly with status $status"
  exit "$status"
}

trap report_unexpected_error ERR

run_controller_stop_regression() (
  local mode="$1" fixture control drain_status=0 wait_calls=0 request_calls=0
  fixture="$(mktemp -d)"
  control="$fixture/monitor.control"
  trap 'rm -rf -- "$fixture"' EXIT
  printf control >"$control"
  managed_deadline=/managed-deadline-helper
  event_monitor_control="$control"
  event_monitor_pid=424242
  event_monitor_supervisor_start=434343
  event_monitor_control_device=444444
  event_monitor_control_inode=454545
  event_monitor_containment_proven=0
  readonly DEADLINE_EVENT_MONITOR_STOP_REQUEST_SECONDS=25

  remaining_seconds() {
    printf '%s\n' 7
  }
  python3() {
    ((request_calls += 1))
    [[ "$1" == "$managed_deadline" && "$2" == --request-stop \
      && "$3" == "$event_monitor_control" \
      && "$4" == --expected-control-device \
      && "$5" == "$event_monitor_control_device" \
      && "$6" == --expected-control-inode \
      && "$7" == "$event_monitor_control_inode" \
      && "$8" == --expected-supervisor-pid && "$9" == "$event_monitor_pid" \
      && "${10}" == --expected-supervisor-start \
      && "${11}" == "$event_monitor_supervisor_start" \
      && "${12}" == --request-timeout && "${13}" == 7 ]] || return 90
    [[ "$mode" != request-failure ]] || return 1
    [[ "$mode" == metadata-present ]] || rm -f -- "$event_monitor_control"
  }
  wait() {
    ((wait_calls += 1))
    [[ "$1" == "$event_monitor_pid" ]] || return 90
    [[ "$mode" != non143 ]] || return 125
    return 143
  }

  source <(/usr/bin/sed -n \
    '/^drain_event_monitor_group() {$/,/^}$/p' "$backup_controller")
  [[ "$(type -t drain_event_monitor_group)" == function ]] \
    || fail "production drain_event_monitor_group could not be loaded"
  drain_event_monitor_group || drain_status=$?

  case "$mode" in
    success)
      [[ "$drain_status" == 0 && "$event_monitor_containment_proven" == 1 \
        && "$request_calls" == 1 && "$wait_calls" == 1 ]] \
        || fail "protected stop success did not prove containment"
      ;;
    request-failure)
      [[ "$drain_status" == 1 && "$event_monitor_containment_proven" == 0 \
        && "$request_calls" == 1 && "$wait_calls" == 0 ]] \
        || fail "failed protected stop attempted wait or proved containment"
      ;;
    non143|metadata-present)
      [[ "$drain_status" == 1 && "$event_monitor_containment_proven" == 0 \
        && "$request_calls" == 1 && "$wait_calls" == 1 ]] \
        || fail "$mode protected stop incorrectly proved containment"
      ;;
    *) fail "unknown controller stop regression mode" ;;
  esac
)

run_controller_stop_regression success
run_controller_stop_regression request-failure
run_controller_stop_regression non143
run_controller_stop_regression metadata-present

if [[ "$(uname -s)" != Linux || ! -r /proc/self/stat ]]; then
  printf '%s\n' 'SKIP: managed-deadline acceptance requires Linux /proc' >&2
  exit 77
fi

[[ -f "$helper" && ! -L "$helper" ]] \
  || fail "managed-deadline helper is missing or unsafe"
command -v python3 >/dev/null || fail "python3 is unavailable"

managed_deadline_test_group="${MANAGED_DEADLINE_TEST_GROUP:-all}"
case "$managed_deadline_test_group" in
  all|run-fixed-deadline-command-substitution) ;;
  *) fail "unknown MANAGED_DEADLINE_TEST_GROUP: $managed_deadline_test_group" ;;
esac

run_fixed_deadline_command_substitution_regression() (
  local output status=0
  trap - ERR
  managed_deadline="$helper"
  source <(/usr/bin/sed -n \
    '/^run_fixed_deadline() {$/,/^}$/p' "$backup_controller")
  [[ "$(type -t run_fixed_deadline)" == function ]] \
    || fail "production run_fixed_deadline could not be loaded"

  output="$(run_fixed_deadline 5 1 \
    /usr/bin/printf '%s\n' command-substitution-ok)" || status=$?
  [[ "$status" == 0 && "$output" == command-substitution-ok ]] \
    || fail "production run_fixed_deadline failed under command substitution (status=$status)"

  status=0
  output="$(run_fixed_deadline 5 1 /bin/sh -c 'exit 73')" || status=$?
  [[ "$status" == 73 ]] \
    || fail "production run_fixed_deadline changed managed command status (status=$status)"
)

run_fixed_deadline_command_substitution_regression
if [[ "$managed_deadline_test_group" == run-fixed-deadline-command-substitution ]]; then
  echo "managed-deadline-run-fixed-deadline-command-substitution-tests-ok"
  exit 0
fi

umask 077
work="$(mktemp -d)"
chmod 0700 "$work"
trap 'rm -rf -- "$work"' EXIT

readonly STOP_CHANNEL_DIAGNOSTIC_BYTES=512
readonly STOP_CHANNEL_CAPTURE_BYTES=65536
readonly STOP_CHANNEL_DIAGNOSTIC_FALLBACK='no bounded native diagnostic available'
STOP_CHANNEL_STATUS=0
STOP_CHANNEL_OUTPUT_IDENTITY=''
STOP_CHANNEL_ERROR_IDENTITY=''
STOP_CHANNEL_STDOUT_EVIDENCE="$STOP_CHANNEL_DIAGNOSTIC_FALLBACK"
STOP_CHANNEL_DIAGNOSTIC="$STOP_CHANNEL_DIAGNOSTIC_FALLBACK"

create_stop_channel_capture() {
  local path="$1"
  python3 - "$path" <<'PY'
import os
import stat
import sys

path = sys.argv[1]
flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW
if hasattr(os, "O_CLOEXEC"):
    flags |= os.O_CLOEXEC
descriptor = os.open(path, flags, 0o600)
try:
    os.fchmod(descriptor, 0o600)
    metadata = os.fstat(descriptor)
    if (
        not stat.S_ISREG(metadata.st_mode)
        or metadata.st_uid != os.getuid()
        or stat.S_IMODE(metadata.st_mode) != 0o600
        or metadata.st_nlink != 1
    ):
        raise SystemExit(91)
    print(f"{metadata.st_dev}:{metadata.st_ino}")
finally:
    os.close(descriptor)
PY
}

secure_read_stop_channel_capture() {
  local path="$1" retained_identity="$2" read_mode="$3"
  python3 - "$path" "$retained_identity" "$read_mode" "$work" \
    "$STOP_CHANNEL_DIAGNOSTIC_BYTES" "$STOP_CHANNEL_CAPTURE_BYTES" <<'PY'
import os
import re
import stat
import sys

path, identity_text, read_mode, work = sys.argv[1:5]
diagnostic_limit = int(sys.argv[5])
capture_limit = int(sys.argv[6])
device_text, inode_text = identity_text.split(":", 1)
expected_identity = (int(device_text), int(inode_text))
flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK
if hasattr(os, "O_CLOEXEC"):
    flags |= os.O_CLOEXEC


def safe_metadata(metadata):
    return not (
        not stat.S_ISREG(metadata.st_mode)
        or metadata.st_uid != os.getuid()
        or stat.S_IMODE(metadata.st_mode) != 0o600
        or metadata.st_nlink != 1
        or (metadata.st_dev, metadata.st_ino) != expected_identity
    )


def path_metadata_is_safe(metadata):
    return safe_metadata(metadata)


def read_bounded(descriptor, size):
    chunks = []
    remaining = size
    while remaining:
        chunk = os.read(descriptor, min(remaining, 8192))
        if not chunk:
            break
        chunks.append(chunk)
        remaining -= len(chunk)
    payload = b"".join(chunks)
    if len(payload) != size:
        raise SystemExit(92)
    return payload


def sanitize(text):
    text = text.replace(work, "<work>")
    text = re.sub(
        r"(?<![0-9a-f])(?:[0-9a-f]{64}|[0-9a-f]{32})(?![0-9a-f])",
        "<capability>",
        text,
    )
    text = text.replace("::", "\\x3a\\x3a")
    escaped = []
    for character in text:
        codepoint = ord(character)
        if character == "\r":
            escaped.append("\\r")
        elif character == "\n":
            escaped.append("\\n")
        elif character == "\0":
            escaped.append("\\0")
        elif character == "%":
            escaped.append("\\x25")
        elif codepoint < 0x20 or 0x7F <= codepoint <= 0x9F:
            escaped.append(f"\\x{codepoint:02x}")
        elif 0xD800 <= codepoint <= 0xDFFF:
            escaped.append(f"\\u{codepoint:04x}")
        else:
            escaped.append(character)
    return "".join(escaped)


def bounded(text):
    encoded = text.encode("utf-8", errors="backslashreplace")
    if len(encoded) <= diagnostic_limit:
        return encoded.decode("utf-8")
    marker = b"...[truncated]"
    prefix = encoded[: diagnostic_limit - len(marker)]
    while True:
        try:
            return prefix.decode("utf-8") + marker.decode("ascii")
        except UnicodeDecodeError as error:
            prefix = prefix[: error.start]


def validated_manifest(payload):
    if not payload.endswith(b"\n"):
        raise SystemExit(100)
    lines = payload[:-1].split(b"\n")
    if len(lines) != 34:
        raise SystemExit(101)
    case_prefix = b"managed-deadline-stop-channel-case-ok:"
    cases = lines[:33]
    if (
        any(not line.startswith(case_prefix) or len(line) == len(case_prefix) for line in cases)
        or len(set(cases)) != 33
        or lines[33] != b"managed-deadline-stop-channel-linux-tests-ok"
    ):
        raise SystemExit(102)
    return payload


descriptor = os.open(path, flags)
try:
    metadata = os.fstat(descriptor)
    try:
        path_metadata = os.lstat(path)
    except FileNotFoundError:
        raise SystemExit(93)
    if not safe_metadata(metadata) or not path_metadata_is_safe(path_metadata):
        raise SystemExit(94)
    if metadata.st_size > capture_limit:
        raise SystemExit(95)
    if read_mode == "verify":
        payload = b""
    else:
        payload = read_bounded(descriptor, metadata.st_size)
    after_metadata = os.fstat(descriptor)
    try:
        path_after = os.lstat(path)
    except FileNotFoundError:
        raise SystemExit(96)
    if (
        not safe_metadata(after_metadata)
        or not path_metadata_is_safe(path_after)
        or after_metadata.st_size != metadata.st_size
    ):
        raise SystemExit(97)
finally:
    os.close(descriptor)

if read_mode == "verify":
    raise SystemExit(0)
if read_mode == "raw":
    sys.stdout.buffer.write(payload)
    raise SystemExit(0)
if read_mode == "manifest":
    sys.stdout.buffer.write(validated_manifest(payload))
    raise SystemExit(0)
if read_mode != "line":
    raise SystemExit(98)
lines = payload.split(b"\n")
candidate = next((line for line in reversed(lines) if line.strip()), None)
if candidate is None:
    raise SystemExit(99)
text = candidate.decode("utf-8", errors="backslashreplace")
sys.stdout.write(bounded(sanitize(text)))
PY
}

run_stop_channel_gate() {
  local gate="$1" gate_helper="$2"
  local stop_channel_output="$3" stop_channel_error="$4"
  local stop_channel_status=0 capture_safe=1
  STOP_CHANNEL_OUTPUT_IDENTITY=''
  STOP_CHANNEL_ERROR_IDENTITY=''
  STOP_CHANNEL_STDOUT_EVIDENCE="$STOP_CHANNEL_DIAGNOSTIC_FALLBACK"
  STOP_CHANNEL_DIAGNOSTIC="$STOP_CHANNEL_DIAGNOSTIC_FALLBACK"
  if ! STOP_CHANNEL_OUTPUT_IDENTITY="$(create_stop_channel_capture \
    "$stop_channel_output")"; then
    STOP_CHANNEL_STATUS=125
    return 125
  fi
  if ! STOP_CHANNEL_ERROR_IDENTITY="$(create_stop_channel_capture \
    "$stop_channel_error")"; then
    STOP_CHANNEL_STATUS=125
    return 125
  fi
  if python3 "$gate" "$gate_helper" >"$stop_channel_output" \
    2>"$stop_channel_error"; then
    stop_channel_status=0
  else
    stop_channel_status=$?
  fi
  STOP_CHANNEL_STATUS="$stop_channel_status"
  secure_read_stop_channel_capture "$stop_channel_output" \
    "$STOP_CHANNEL_OUTPUT_IDENTITY" verify >/dev/null 2>&1 || capture_safe=0
  secure_read_stop_channel_capture "$stop_channel_error" \
    "$STOP_CHANNEL_ERROR_IDENTITY" verify >/dev/null 2>&1 || capture_safe=0
  if [[ "$capture_safe" == 1 ]]; then
    if ! STOP_CHANNEL_STDOUT_EVIDENCE="$(secure_read_stop_channel_capture \
      "$stop_channel_output" "$STOP_CHANNEL_OUTPUT_IDENTITY" line)"; then
      STOP_CHANNEL_STDOUT_EVIDENCE="$STOP_CHANNEL_DIAGNOSTIC_FALLBACK"
    fi
    if ! STOP_CHANNEL_DIAGNOSTIC="$(secure_read_stop_channel_capture \
      "$stop_channel_error" "$STOP_CHANNEL_ERROR_IDENTITY" line)"; then
      STOP_CHANNEL_DIAGNOSTIC="$STOP_CHANNEL_DIAGNOSTIC_FALLBACK"
    fi
  elif [[ "$stop_channel_status" == 0 ]]; then
    STOP_CHANNEL_STATUS=125
  fi
  return "$STOP_CHANNEL_STATUS"
}

run_stop_channel_capture_regressions() {
  local fake_gate="$work/fake-stop-channel-capture-gate.py"
  local fake_helper="$work/fake-managed-deadline-helper.py"
  local fixture_mode fixture_status fixture_output fixture_error
  local diagnostic_bytes expected_output actual_output actual_error
  cat >"$fake_gate" <<'PY'
#!/usr/bin/env python3
import os
import pathlib
import socket
import sys

mode = sys.argv[1]
stderr_path = pathlib.Path(os.readlink("/proc/self/fd/2"))
work = stderr_path.parent
if mode == "failure":
    os.write(1, b"ignored stdout\nfinal bounded stdout\n")
    record = (
        "managed-deadline-stop-channel-case-failed:stop-channel-normal:"
        "RuntimeError:"
        f"{work}\r\0%0A::error title=forged::"
        f"{'a' * 32}:{'b' * 64}:" + "\u754c" * 400 + "\n"
    )
    os.write(2, b"ignored stderr\n" + record.encode("utf-8"))
    raise SystemExit(42)
if mode == "empty":
    raise SystemExit(42)
if mode in {
    "symlink",
    "hardlink",
    "wrong-mode",
    "wrong-inode",
    "fifo",
    "unix-socket",
}:
    os.write(2, b"metadata-secret-must-not-be-read\n")
    if mode == "symlink":
        target = stderr_path.with_suffix(".target")
        target.write_text("symlink-secret\n", encoding="ascii")
        os.chmod(target, 0o600)
        stderr_path.unlink()
        stderr_path.symlink_to(target)
    elif mode == "hardlink":
        os.link(stderr_path, stderr_path.with_suffix(".hardlink"))
    elif mode == "wrong-mode":
        os.chmod(stderr_path, 0o644)
    elif mode == "wrong-inode":
        stderr_path.unlink()
        descriptor = os.open(
            stderr_path,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
            0o600,
        )
        with os.fdopen(descriptor, "wb") as replacement:
            replacement.write(b"replacement-secret\n")
    elif mode == "fifo":
        stderr_path.unlink()
        os.mkfifo(stderr_path, 0o600)
    else:
        stderr_path.unlink()
        replacement = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            replacement.bind(os.fspath(stderr_path))
            os.chmod(stderr_path, 0o600)
        finally:
            replacement.close()
    raise SystemExit(42)
if mode == "success":
    for index in range(33):
        print(f"managed-deadline-stop-channel-case-ok:fixture-{index:02d}")
    print("managed-deadline-stop-channel-linux-tests-ok")
    raise SystemExit(0)
raise SystemExit(90)
PY
  chmod 0700 "$fake_gate"

  fixture_output="$work/capture-failure.output"
  fixture_error="$work/capture-failure.error"
  fixture_status=0
  if run_stop_channel_gate "$fake_gate" failure \
    "$fixture_output" "$fixture_error"; then
    fixture_status=0
  else
    fixture_status=$?
  fi
  [[ "$fixture_status" == 42 && "$STOP_CHANNEL_STATUS" == 42 ]] \
    || fail "stop-channel wrapper did not retain native exit 42"
  [[ "$STOP_CHANNEL_STDOUT_EVIDENCE" == 'final bounded stdout' \
    && "$STOP_CHANNEL_STDOUT_EVIDENCE" != *ignored* ]] \
    || fail "stop-channel wrapper did not select bounded final stdout evidence"
  [[ "$STOP_CHANNEL_DIAGNOSTIC" == \
      managed-deadline-stop-channel-case-failed:stop-channel-normal:RuntimeError:* \
    && "$STOP_CHANNEL_DIAGNOSTIC" != *ignored* \
    && "$STOP_CHANNEL_DIAGNOSTIC" == *'<work>'* \
    && "$STOP_CHANNEL_DIAGNOSTIC" == *'<capability>'* \
    && "$STOP_CHANNEL_DIAGNOSTIC" == *'\r'* \
    && "$STOP_CHANNEL_DIAGNOSTIC" == *'\0'* \
    && "$STOP_CHANNEL_DIAGNOSTIC" == *'\x25'* \
    && "$STOP_CHANNEL_DIAGNOSTIC" == *'\x3a\x3aerror'* \
    && "$STOP_CHANNEL_DIAGNOSTIC" == *'...[truncated]' \
    && "$STOP_CHANNEL_DIAGNOSTIC" != *'%'* \
    && "$STOP_CHANNEL_DIAGNOSTIC" != *'::error'* \
    && "$STOP_CHANNEL_DIAGNOSTIC" != *$'\r'* \
    && "$STOP_CHANNEL_DIAGNOSTIC" != *$'\n'* ]] \
    || fail "stop-channel wrapper did not bound and sanitize final stderr evidence"
  diagnostic_bytes="$(printf '%s' "$STOP_CHANNEL_DIAGNOSTIC" | wc -c | tr -d ' ')"
  [[ "$diagnostic_bytes" -le "$STOP_CHANNEL_DIAGNOSTIC_BYTES" ]] \
    || fail "stop-channel wrapper diagnostic exceeded its UTF-8 byte cap"

  fixture_output="$work/capture-empty.output"
  fixture_error="$work/capture-empty.error"
  fixture_status=0
  if run_stop_channel_gate "$fake_gate" empty \
    "$fixture_output" "$fixture_error"; then
    fixture_status=0
  else
    fixture_status=$?
  fi
  [[ "$fixture_status" == 42 \
    && "$STOP_CHANNEL_DIAGNOSTIC" == "$STOP_CHANNEL_DIAGNOSTIC_FALLBACK" ]] \
    || fail "stop-channel wrapper did not use its empty-stderr fallback"

  for fixture_mode in symlink hardlink wrong-mode wrong-inode fifo unix-socket; do
    fixture_output="$work/capture-$fixture_mode.output"
    fixture_error="$work/capture-$fixture_mode.error"
    fixture_status=0
    if run_stop_channel_gate "$fake_gate" "$fixture_mode" \
      "$fixture_output" "$fixture_error"; then
      fixture_status=0
    else
      fixture_status=$?
    fi
    [[ "$fixture_status" == 42 \
      && "$STOP_CHANNEL_DIAGNOSTIC" == "$STOP_CHANNEL_DIAGNOSTIC_FALLBACK" \
      && "$STOP_CHANNEL_DIAGNOSTIC" != *secret* ]] \
      || fail "stop-channel wrapper consumed unsafe $fixture_mode stderr"
  done

  local device_identity
  device_identity="$(python3 - <<'PY'
import os

metadata = os.stat("/dev/null")
print(f"{metadata.st_dev}:{metadata.st_ino}")
PY
)"
  if secure_read_stop_channel_capture /dev/null "$device_identity" verify \
    >/dev/null 2>&1; then
    fail "stop-channel secure reader accepted a device node"
  fi

  expected_output="$work/capture-success.expected"
  actual_output="$work/capture-success.actual"
  actual_error="$work/capture-success.actual-error"
  python3 "$fake_gate" success >"$expected_output"
  fixture_output="$work/capture-success.output"
  fixture_error="$work/capture-success.error"
  fixture_status=0
  if run_stop_channel_gate "$fake_gate" success \
    "$fixture_output" "$fixture_error"; then
    fixture_status=0
  else
    fixture_status=$?
  fi
  [[ "$fixture_status" == 0 && "$STOP_CHANNEL_STATUS" == 0 ]] \
    || fail "stop-channel wrapper changed a successful native status"
  secure_read_stop_channel_capture "$fixture_output" \
    "$STOP_CHANNEL_OUTPUT_IDENTITY" manifest >"$actual_output" \
    || fail "stop-channel wrapper could not stream verified success stdout"
  secure_read_stop_channel_capture "$fixture_error" \
    "$STOP_CHANNEL_ERROR_IDENTITY" raw >"$actual_error" \
    || fail "stop-channel wrapper could not stream verified success stderr"
  cmp -s -- "$expected_output" "$actual_output" \
    || fail "stop-channel wrapper changed successful native stdout bytes"
  [[ ! -s "$actual_error" \
    && "$(grep -Fc 'managed-deadline-stop-channel-case-ok:' \
      "$actual_output")" == 33 \
    && "$(grep -Fxc 'managed-deadline-stop-channel-linux-tests-ok' \
      "$actual_output")" == 1 \
    && "$(tail -n 1 "$actual_output")" == \
      managed-deadline-stop-channel-linux-tests-ok ]] \
    || fail "stop-channel wrapper changed the successful 33-case manifest or sentinel"

  local replacement_race_output="$work/capture-replacement-race.actual"
  python3 - "$fixture_output" <<'PY'
import os
import pathlib
import sys

path = pathlib.Path(sys.argv[1])
path.replace(path.with_suffix(".retained"))
descriptor = os.open(
    path,
    os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
    0o600,
)
with os.fdopen(descriptor, "wb") as output:
    for index in range(33):
        output.write(
            f"managed-deadline-stop-channel-case-ok:replacement-{index:02d}\n".encode(
                "ascii"
            )
        )
    output.write(b"managed-deadline-stop-channel-linux-tests-ok\n")
PY
  if secure_read_stop_channel_capture "$fixture_output" \
    "$STOP_CHANNEL_OUTPUT_IDENTITY" manifest >"$replacement_race_output" 2>/dev/null; then
    fail "stop-channel manifest reader accepted a post-verification path replacement"
  fi
  [[ ! -s "$replacement_race_output" ]] \
    || fail "stop-channel manifest reader emitted replacement-race bytes"

  cat >"$fake_helper" <<'PY'
#!/usr/bin/env python3
import os

os.write(
    2,
    b"fake helper failed\n%0A::error title=forged::" + b"c" * 800 + b"\n",
)
raise SystemExit(125)
PY
  chmod 0700 "$fake_helper"
  fixture_output="$work/native-attribution.output"
  fixture_error="$work/native-attribution.error"
  fixture_status=0
  if run_stop_channel_gate "$stop_channel_gate" "$fake_helper" \
    "$fixture_output" "$fixture_error"; then
    fixture_status=0
  else
    fixture_status=$?
  fi
  [[ "$fixture_status" != 0 \
    && "$STOP_CHANNEL_DIAGNOSTIC" == \
      managed-deadline-stop-channel-case-failed:stop-channel-normal:StopChannelFailure:* \
    && "$STOP_CHANNEL_DIAGNOSTIC" != *'%'* \
    && "$STOP_CHANNEL_DIAGNOSTIC" != *'::error'* ]] \
    || fail "real native gate omitted bounded stop-channel-normal attribution"
  secure_read_stop_channel_capture "$fixture_error" \
    "$STOP_CHANNEL_ERROR_IDENTITY" raw >"$work/native-attribution.inspected" \
    || fail "real native gate diagnostic capture became unsafe"
  [[ "$(grep -Fc 'managed-deadline-stop-channel-case-failed:' \
      "$work/native-attribution.inspected")" == 1 \
    && "$(grep -Fc 'managed-deadline-stop-channel-case-ok:' \
      "$fixture_output")" == 0 \
    && "$(grep -Fc 'managed-deadline-stop-channel-linux-tests-ok' \
      "$fixture_output")" == 0 ]] \
    || fail "failed real native gate emitted duplicate attribution or success evidence"

  local diagnostic_launcher="$work/native-diagnostic-launcher.py"
  local expected_status expected_type expected_message diagnostic_prefix
  cat >"$diagnostic_launcher" <<'PY'
#!/usr/bin/env python3
import os
import sys

native_gate, mode = sys.argv[1].rsplit("|", 1)
os.execv(
    sys.executable,
    [sys.executable, native_gate, "--diagnostic-subprocess", mode],
)
PY
  chmod 0700 "$diagnostic_launcher"
  while IFS='|' read -r fixture_mode expected_status expected_type expected_message; do
    fixture_output="$work/native-diagnostic-$fixture_mode.output"
    fixture_error="$work/native-diagnostic-$fixture_mode.error"
    fixture_status=0
    if run_stop_channel_gate "$diagnostic_launcher" \
      "$stop_channel_gate|$fixture_mode" "$fixture_output" "$fixture_error"; then
      fixture_status=0
    else
      fixture_status=$?
    fi
    diagnostic_prefix="managed-deadline-stop-channel-case-failed:stop-channel-normal:$expected_type:"
    [[ "$fixture_status" == "$expected_status" \
      && "$STOP_CHANNEL_STATUS" == "$expected_status" \
      && ! -s "$fixture_output" \
      && "$STOP_CHANNEL_DIAGNOSTIC" == "$diagnostic_prefix$expected_message" \
      && "$STOP_CHANNEL_DIAGNOSTIC" != *Traceback* \
      && "$STOP_CHANNEL_DIAGNOSTIC" != *'%'* \
      && "$STOP_CHANNEL_DIAGNOSTIC" != *'::error'* ]] \
      || fail "native wrapper displaced the $fixture_mode status or diagnostic"
    secure_read_stop_channel_capture "$fixture_error" \
      "$STOP_CHANNEL_ERROR_IDENTITY" raw >"$work/native-diagnostic-$fixture_mode.inspected" \
      || fail "native wrapper $fixture_mode diagnostic capture became unsafe"
    [[ "$(grep -Fc 'managed-deadline-stop-channel-case-failed:' \
        "$work/native-diagnostic-$fixture_mode.inspected")" == 1 \
      && "$(wc -l <"$work/native-diagnostic-$fixture_mode.inspected" | tr -d ' ')" == 1 ]] \
      || fail "native wrapper emitted duplicate $fixture_mode diagnostics"
  done <<'EOF'
runtime-error|1|RuntimeError|runtime failure\n\x250A\x3a\x3aerror title=forged\x3a\x3a
string-system-exit|1|SystemExit|string exit\n\x250A\x3a\x3aerror title=forged\x3a\x3a
keyboard-interrupt|130|KeyboardInterrupt|keyboard interrupt\n\x3a\x3awarning\x3a\x3aforged
numeric-system-exit|73|SystemExit|73
EOF
}

run_stop_channel_capture_regressions

assert_mode_0600() {
  local path="$1" label="$2"
  [[ -f "$path" && ! -L "$path" && "$(stat -c '%a' -- "$path")" == 600 ]] \
    || fail "$label is not a mode-0600 regular file"
}

assert_identity_absent() {
  local identity_file="$1" label="$2"
  python3 - "$identity_file" "$label" <<'PY'
import pathlib
import sys

identity_path = pathlib.Path(sys.argv[1])
label = sys.argv[2]
pid_text, pgid_text, start_text = identity_path.read_text(encoding="ascii").strip().split("|")
pid = int(pid_text)
pgid = int(pgid_text)
start = int(start_text)

def identity(candidate: int):
    raw = pathlib.Path(f"/proc/{candidate}/stat").read_text(encoding="ascii")
    fields = raw[raw.rfind(")") + 2 :].split()
    return int(fields[2]), int(fields[19])

try:
    live_pgid, live_start = identity(pid)
except FileNotFoundError:
    pass
else:
    if live_start == start:
        raise SystemExit(f"{label}: recorded PID {pid} remains in PGID {live_pgid}")

for entry in pathlib.Path("/proc").iterdir():
    if not entry.name.isdecimal():
        continue
    try:
        live_pgid, live_start = identity(int(entry.name))
    except FileNotFoundError:
        continue
    if live_pgid == pgid:
        raise SystemExit(
            f"{label}: PGID {pgid} still contains PID {entry.name} start {live_start}"
        )
PY
}

assert_process_identity_absent() {
  local identity_file="$1" label="$2"
  python3 - "$identity_file" "$label" <<'PY'
import pathlib
import sys

identity_path = pathlib.Path(sys.argv[1])
label = sys.argv[2]
pid_text, _pgid_text, start_text = identity_path.read_text(
    encoding="ascii"
).strip().split("|")
pid = int(pid_text)
start = int(start_text)

try:
    raw = pathlib.Path(f"/proc/{pid}/stat").read_text(encoding="ascii")
except FileNotFoundError:
    raise SystemExit(0)
fields = raw[raw.rfind(")") + 2 :].split()
live_start = int(fields[19])
if live_start == start:
    raise SystemExit(f"{label}: recorded PID {pid} start {start} remains live")
PY
}

assert_record_relation() {
  local identity_file="$1" expected="$2" label="$3"
  python3 - "$identity_file" "$expected" "$label" <<'PY'
import pathlib
import sys

pid, pgid, start = (
    int(value)
    for value in pathlib.Path(sys.argv[1]).read_text(encoding="ascii").strip().split("|")
)
expected = sys.argv[2]
label = sys.argv[3]
if pid <= 0 or pgid <= 0 or start <= 0:
    raise SystemExit(f"{label}: invalid identity record")
if expected == "different" and pid == pgid:
    raise SystemExit(f"{label}: setup guardian unexpectedly became a group leader")
if expected == "equal" and pid != pgid:
    raise SystemExit(f"{label}: verified guardian is not its group leader")
PY
}

cat >"$work/stubborn.sh" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
record="$1"
ready="$2"
release="$3"
late_effect="$4"
trap '' TERM
python3 - "$BASHPID" "$record" <<'PY'
import os
import pathlib
import sys

pid = int(sys.argv[1])
raw = pathlib.Path(f"/proc/{pid}/stat").read_text(encoding="ascii")
fields = raw[raw.rfind(")") + 2 :].split()
path = pathlib.Path(sys.argv[2])
descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
with os.fdopen(descriptor, "w", encoding="ascii") as output:
    output.write(f"{pid}|{int(fields[2])}|{int(fields[19])}\n")
PY
printf '%s\n' ready >"$ready"
while [[ ! -e "$release" ]]; do
  sleep 0.02
done
printf '%s\n' late >"$late_effect"
while :; do sleep 1; done
EOF
chmod 0755 "$work/stubborn.sh"

run_timeout_case() {
  local label="$1" mode="$2"
  local record="$work/$label.identity"
  local ready="$work/$label.ready" release="$work/$label.release"
  local late_effect="$work/$label.late" status=0
  if [[ "$mode" == descendant ]]; then
    python3 "$helper" --expected-parent-pid "$BASHPID" 1 0.20 -- bash -c '
      "$1" "$2" "$3" "$4" "$5" &
      wait "$!"
    ' _ "$work/stubborn.sh" "$record" "$ready" "$release" "$late_effect" \
      || status=$?
  else
    python3 "$helper" --expected-parent-pid "$BASHPID" 1 0.20 -- \
      "$work/stubborn.sh" "$record" "$ready" "$release" "$late_effect" \
      || status=$?
  fi
  [[ "$status" == 124 && -s "$record" && -s "$ready" ]] \
    || fail "$label did not return timeout status with ready identity (status=$status)"
  assert_identity_absent "$record" "$label"
  : >"$release"
  sleep 0.5
  [[ ! -e "$late_effect" ]] || fail "$label produced a post-deadline late effect"
}

run_timeout_case term-ignoring-descendant descendant
run_timeout_case term-ignoring-producer producer

setup_budget_record="$work/setup-budget.identity"
setup_budget_ready="$work/setup-budget.ready"
setup_budget_effect="$work/setup-budget.effect"
setup_budget_status=0
setup_budget_started="$(date +%s%N)"
MANAGED_DEADLINE_TESTING=1 \
  MANAGED_DEADLINE_TEST_FAULT=guardian-fixed-setup-delay \
  MANAGED_DEADLINE_TEST_RECORD="$setup_budget_record" \
  python3 "$helper" --expected-parent-pid "$BASHPID" 1.20 0.10 -- bash -c '
    printf ready >"$1"
    sleep 0.90
    printf effect >"$2"
  ' _ "$setup_budget_ready" "$setup_budget_effect" || setup_budget_status=$?
setup_budget_finished="$(date +%s%N)"
[[ "$setup_budget_status" == 124 && -s "$setup_budget_record" \
  && -s "$setup_budget_ready" && ! -e "$setup_budget_effect" ]] \
  || fail "guardian setup latency was excluded from the absolute deadline"
python3 - "$setup_budget_started" "$setup_budget_finished" <<'PY'
import sys

elapsed = (int(sys.argv[2]) - int(sys.argv[1])) / 1_000_000_000
if elapsed > 2.00:
    raise SystemExit(f"absolute setup-budget case exceeded its bound: {elapsed:.3f}s")
PY
assert_identity_absent "$setup_budget_record" setup-budget

setup_exhausted_record="$work/setup-exhausted-before-go.identity"
setup_exhausted_control="$work/setup-exhausted-before-go.control"
setup_exhausted_effect="$work/setup-exhausted-before-go.effect"
setup_exhausted_status=0
setup_exhausted_started="$(date +%s%N)"
MANAGED_DEADLINE_TESTING=1 \
  MANAGED_DEADLINE_TEST_FAULT=guardian-fixed-setup-delay \
  MANAGED_DEADLINE_TEST_RECORD="$setup_exhausted_record" \
  python3 "$helper" --expected-parent-pid "$BASHPID" \
    --control-file "$setup_exhausted_control" 0.25 0.10 -- \
    bash -c 'printf effect >"$1"' _ "$setup_exhausted_effect" \
    || setup_exhausted_status=$?
setup_exhausted_finished="$(date +%s%N)"
[[ "$setup_exhausted_status" == 124 && -s "$setup_exhausted_record" \
  && ! -e "$setup_exhausted_control" && ! -e "$setup_exhausted_effect" ]] \
  || fail "setup-exhausted-before-go launched a command or retained control metadata"
python3 - "$setup_exhausted_started" "$setup_exhausted_finished" <<'PY'
import sys

elapsed = (int(sys.argv[2]) - int(sys.argv[1])) / 1_000_000_000
if elapsed > 1.25:
    raise SystemExit(f"setup-exhausted-before-go exceeded its bound: {elapsed:.3f}s")
PY
assert_mode_0600 "$setup_exhausted_record" setup-exhausted-before-go-record
assert_record_relation "$setup_exhausted_record" equal setup-exhausted-before-go
assert_identity_absent "$setup_exhausted_record" setup-exhausted-before-go

orphan_record="$work/normal-exit-orphan.identity"
orphan_ready="$work/normal-exit-orphan.ready"
orphan_release="$work/normal-exit-orphan.release"
orphan_late="$work/normal-exit-orphan.late"
orphan_status=0
python3 "$helper" --expected-parent-pid "$BASHPID" 5 0.20 -- bash -c '
  "$1" "$2" "$3" "$4" "$5" &
  exit 0
' _ "$work/stubborn.sh" "$orphan_record" "$orphan_ready" \
  "$orphan_release" "$orphan_late" || orphan_status=$?
[[ "$orphan_status" == 125 && -s "$orphan_record" && -s "$orphan_ready" ]] \
  || fail "normal-exit orphan was not reported as containment failure (status=$orphan_status)"
assert_identity_absent "$orphan_record" normal-exit-orphan
: >"$orphan_release"
sleep 0.5
[[ ! -e "$orphan_late" ]] || fail "normal-exit orphan produced a late effect"

for setup_fault in guardian-readiness-timeout guardian-invalid-readiness \
  guardian-ready-without-setsid; do
  setup_record="$work/$setup_fault.identity"
  setup_control="$work/$setup_fault.control"
  setup_effect="$work/$setup_fault.effect"
  setup_status=0
  setup_started=$SECONDS
  MANAGED_DEADLINE_TESTING=1 \
    MANAGED_DEADLINE_TEST_FAULT="$setup_fault" \
    MANAGED_DEADLINE_TEST_RECORD="$setup_record" \
    python3 "$helper" --expected-parent-pid "$BASHPID" \
      --control-file "$setup_control" 5 0.20 -- \
      bash -c 'printf effect >"$1"' _ "$setup_effect" || setup_status=$?
  ((SECONDS - setup_started < 5)) || fail "$setup_fault did not return in a bound"
  [[ "$setup_status" == 125 && -s "$setup_record" \
    && ! -e "$setup_control" && ! -e "$setup_effect" ]] \
    || fail "$setup_fault did not fail safely before command/control effect"
  assert_mode_0600 "$setup_record" "$setup_fault record"
  assert_record_relation "$setup_record" different "$setup_fault"
  assert_process_identity_absent "$setup_record" "$setup_fault"
done
kill -0 "$$" 2>/dev/null || fail "setup fault killed the calling test group"

control_record="$work/control-publication.identity"
control_file="$work/preexisting.control"
control_before="$work/preexisting.before"
control_effect="$work/control-publication.effect"
printf '%s\n' preserve-existing-control >"$control_file"
cp -- "$control_file" "$control_before"
control_status=0
control_publication_started="$(date +%s%N)"
MANAGED_DEADLINE_TESTING=1 \
  MANAGED_DEADLINE_TEST_FAULT=guardian-record-valid-ready \
  MANAGED_DEADLINE_TEST_RECORD="$control_record" \
  python3 "$helper" --expected-parent-pid "$BASHPID" \
    --control-file "$control_file" 5 0.20 -- \
    bash -c 'printf effect >"$1"' _ "$control_effect" || control_status=$?
control_publication_finished="$(date +%s%N)"
[[ "$control_status" == 125 && -s "$control_record" && ! -e "$control_effect" ]] \
  || fail "pre-existing control publication did not fail before command launch"
python3 - "$control_publication_started" "$control_publication_finished" <<'PY'
import sys

elapsed = (int(sys.argv[2]) - int(sys.argv[1])) / 1_000_000_000
if elapsed > 3.00:
    raise SystemExit(
        f"pre-existing control publication exceeded its bound: {elapsed:.3f}s"
    )
PY
cmp -s -- "$control_before" "$control_file" \
  || fail "pre-existing control file changed during publication failure"
assert_record_relation "$control_record" equal control-publication
assert_identity_absent "$control_record" control-publication

go_record="$work/go-failure.identity"
go_control="$work/go-failure.control"
go_effect="$work/go-failure.effect"
go_status=0
MANAGED_DEADLINE_TESTING=1 \
  MANAGED_DEADLINE_TEST_FAULT=guardian-close-before-go \
  MANAGED_DEADLINE_TEST_RECORD="$go_record" \
  python3 "$helper" --expected-parent-pid "$BASHPID" \
    --control-file "$go_control" 5 0.20 -- \
    bash -c 'printf effect >"$1"' _ "$go_effect" || go_status=$?
[[ "$go_status" == 125 && -s "$go_record" \
  && ! -e "$go_control" && ! -e "$go_effect" ]] \
  || fail "GO/launch-ACK failure did not remove owned control metadata"
assert_record_relation "$go_record" equal go-failure
assert_identity_absent "$go_record" go-failure

already_dead_status="$work/parent-already-dead.status"
already_dead_effect="$work/parent-already-dead.effect"
already_dead_control="$work/parent-already-dead.control"
python3 - "$helper" "$already_dead_status" "$already_dead_effect" \
  "$already_dead_control" <<'PY'
import ctypes
import os
import pathlib
import sys

helper, status_path, effect_path, control_path = sys.argv[1:]
libc = ctypes.CDLL(None, use_errno=True)
if libc.prctl(36, 1, 0, 0, 0) != 0:
    raise OSError(ctypes.get_errno(), "PR_SET_CHILD_SUBREAPER")
launcher = os.fork()
if launcher == 0:
    read_fd, write_fd = os.pipe()
    expected_parent = os.getpid()
    child = os.fork()
    if child == 0:
        os.close(write_fd)
        os.read(read_fd, 1)
        os.close(read_fd)
        os.execv(
            sys.executable,
            [
                sys.executable,
                helper,
                "--expected-parent-pid",
                str(expected_parent),
                "--control-file",
                control_path,
                "5",
                "0.2",
                "--",
                "bash",
                "-c",
                f"printf effect >{effect_path!r}",
            ],
        )
    os.close(read_fd)
    os._exit(0)
os.waitpid(launcher, 0)
adopted, status = os.waitpid(-1, 0)
if os.WIFEXITED(status):
    normalized = os.WEXITSTATUS(status)
elif os.WIFSIGNALED(status):
    normalized = 128 + os.WTERMSIG(status)
else:
    normalized = 255
pathlib.Path(status_path).write_text(f"{normalized}\n", encoding="ascii")
PY
[[ "$(<"$already_dead_status")" == 125 \
  && ! -e "$already_dead_effect" && ! -e "$already_dead_control" ]] \
  || fail "parent-already-dead helper did not reject before guardian creation"

armed_record="$work/parent-death-armed.identity"
armed_status="$work/parent-death-armed.status"
armed_effect="$work/parent-death-armed.effect"
armed_control="$work/parent-death-armed.control"
python3 - "$helper" "$armed_record" "$armed_status" "$armed_effect" \
  "$armed_control" <<'PY'
import ctypes
import os
import pathlib
import sys
import time

helper, record_path, status_path, effect_path, control_path = sys.argv[1:]
libc = ctypes.CDLL(None, use_errno=True)
if libc.prctl(36, 1, 0, 0, 0) != 0:
    raise OSError(ctypes.get_errno(), "PR_SET_CHILD_SUBREAPER")
launcher = os.fork()
if launcher == 0:
    expected_parent = os.getpid()
    child = os.fork()
    if child == 0:
        environment = os.environ.copy()
        environment.update(
            MANAGED_DEADLINE_TESTING="1",
            MANAGED_DEADLINE_TEST_FAULT="supervisor-parent-death-armed",
            MANAGED_DEADLINE_TEST_RECORD=record_path,
        )
        os.execve(
            sys.executable,
            [
                sys.executable,
                helper,
                "--expected-parent-pid",
                str(expected_parent),
                "--control-file",
                control_path,
                "30",
                "0.2",
                "--",
                "bash",
                "-c",
                f"printf effect >{effect_path!r}",
            ],
            environment,
        )
    deadline = time.monotonic() + 5
    while not pathlib.Path(record_path).is_file():
        if time.monotonic() >= deadline:
            os._exit(91)
        time.sleep(0.01)
    os._exit(0)
launcher_pid, launcher_status = os.waitpid(launcher, 0)
if not os.WIFEXITED(launcher_status) or os.WEXITSTATUS(launcher_status) != 0:
    raise SystemExit("parent-death launcher did not observe the armed record")
adopted, status = os.waitpid(-1, 0)
if os.WIFSIGNALED(status):
    result = f"signal:{os.WTERMSIG(status)}\n"
elif os.WIFEXITED(status):
    result = f"exit:{os.WEXITSTATUS(status)}\n"
else:
    result = "unknown\n"
pathlib.Path(status_path).write_text(result, encoding="ascii")
PY
[[ "$(<"$armed_status")" == signal:15 && -s "$armed_record" \
  && ! -e "$armed_effect" && ! -e "$armed_control" ]] \
  || fail "armed parent death was not a raw SIGTERM before guardian/control/command"
assert_process_identity_absent "$armed_record" parent-death-armed

post_record="$work/post-launch-oserror.identity"
post_ready="$work/post-launch-oserror.ready"
post_release="$work/post-launch-oserror.release"
post_late="$work/post-launch-oserror.late"
post_status=0
MANAGED_DEADLINE_TESTING=1 \
  MANAGED_DEADLINE_TEST_FAULT=supervisor-post-launch-oserror \
  MANAGED_DEADLINE_TEST_RECORD="$post_record" \
  python3 "$helper" --expected-parent-pid "$BASHPID" 30 0.20 -- bash -c '
    trap "" TERM
    printf ready >"$1"
    while [[ ! -e "$2" ]]; do sleep 0.02; done
    printf late >"$3"
    while :; do sleep 1; done
  ' _ "$post_ready" "$post_release" "$post_late" || post_status=$?
[[ "$post_status" == 125 && -s "$post_record" && -s "$post_ready" ]] \
  || fail "post-launch OSError did not return 125 after command readiness"
assert_identity_absent "$post_record" post-launch-oserror
: >"$post_release"
sleep 0.5
[[ ! -e "$post_late" ]] || fail "post-launch OSError allowed a late effect"

run_hostile_case() {
  local label="$1" mode="$2"
  local record="$work/$label.identity"
  local ready="$work/$label.ready" release="$work/$label.release"
  local late="$work/$label.late" status=0
  python3 - "$helper" "$BASHPID" "$mode" "$work/stubborn.sh" \
    "$record" "$ready" "$release" "$late" <<'PY' || status=$?
import os
import signal
import sys

helper, expected_parent, mode, stubborn, record, ready, release, late = sys.argv[1:]
signal.signal(signal.SIGCHLD, signal.SIG_IGN)
signal.pthread_sigmask(
    signal.SIG_BLOCK, {signal.SIGTERM, signal.SIGUSR1, signal.SIGCHLD}
)
if mode == "timeout":
    command = [stubborn, record, ready, release, late]
    duration = "1"
else:
    command = [
        "bash",
        "-c",
        '"$1" "$2" "$3" "$4" "$5" & exit 0',
        "_",
        stubborn,
        record,
        ready,
        release,
        late,
    ]
    duration = "5"
os.execv(
    sys.executable,
    [
        sys.executable,
        helper,
        "--expected-parent-pid",
        expected_parent,
        duration,
        "0.2",
        "--",
        *command,
    ],
)
PY
  expected_status=124
  [[ "$mode" != orphan ]] || expected_status=125
  [[ "$status" == "$expected_status" && -s "$record" && -s "$ready" ]] \
    || fail "$label failed under inherited hostile signal state (status=$status)"
  assert_identity_absent "$record" "$label"
  : >"$release"
  sleep 0.5
  [[ ! -e "$late" ]] || fail "$label produced a hostile-state late effect"
}

run_hostile_case hostile-signal-timeout timeout
run_hostile_case hostile-signal-orphan orphan

for nonfinite_value in nan inf; do
  for nonfinite_case in duration grace; do
    nonfinite_effect="$work/nonfinite-$nonfinite_value-$nonfinite_case.effect"
    nonfinite_status=0
    duration=1
    grace=0.2
    [[ "$nonfinite_case" != duration ]] || duration="$nonfinite_value"
    [[ "$nonfinite_case" != grace ]] || grace="$nonfinite_value"
    python3 "$helper" --expected-parent-pid "$BASHPID" \
      "$duration" "$grace" -- bash -c 'printf effect >"$1"' \
      _ "$nonfinite_effect" >/dev/null 2>&1 || nonfinite_status=$?
    [[ "$nonfinite_status" == 2 && ! -e "$nonfinite_effect" ]] \
      || fail "non-finite $nonfinite_value $nonfinite_case was not rejected"
  done
done

partial_effect="$work/partial-hook.effect"
partial_status=0
MANAGED_DEADLINE_TESTING=1 \
  python3 "$helper" --expected-parent-pid "$BASHPID" 1 0.2 -- \
  bash -c 'printf effect >"$1"' _ "$partial_effect" \
  >/dev/null 2>&1 || partial_status=$?
[[ "$partial_status" == 2 && ! -e "$partial_effect" ]] \
  || fail "partial test-hook environment was not rejected"

unguarded_record="$work/unguarded-hook.identity"
unguarded_effect="$work/unguarded-hook.effect"
unguarded_status=0
MANAGED_DEADLINE_TEST_FAULT=guardian-record-valid-ready \
  MANAGED_DEADLINE_TEST_RECORD="$unguarded_record" \
  python3 "$helper" --expected-parent-pid "$BASHPID" 1 0.2 -- \
  bash -c 'printf effect >"$1"' _ "$unguarded_effect" \
  >/dev/null 2>&1 || unguarded_status=$?
[[ "$unguarded_status" == 2 && ! -e "$unguarded_record" \
  && ! -e "$unguarded_effect" ]] \
  || fail "unguarded test-hook environment was not rejected"

strip_record="$work/strip-hook.identity"
strip_effect="$work/strip-hook.effect"
strip_status=0
MANAGED_DEADLINE_TESTING=1 \
  MANAGED_DEADLINE_TEST_FAULT=guardian-record-valid-ready \
  MANAGED_DEADLINE_TEST_RECORD="$strip_record" \
  python3 "$helper" --expected-parent-pid "$BASHPID" 5 0.2 -- bash -c '
    if env | grep -Eq "^MANAGED_DEADLINE_TEST(ING|_(FAULT|RECORD))="; then exit 90; fi
    printf stripped >"$1"
  ' _ "$strip_effect" || strip_status=$?
[[ "$strip_status" == 0 && "$(<"$strip_effect")" == stripped ]] \
  || fail "guarded test variables reached the managed command"
assert_identity_absent "$strip_record" stripped-hook-command

existing_record="$work/existing-hook-record"
existing_before="$work/existing-hook-record.before"
existing_effect="$work/existing-hook-record.effect"
printf '%s\n' preserve-record >"$existing_record"
cp -- "$existing_record" "$existing_before"
existing_status=0
MANAGED_DEADLINE_TESTING=1 \
  MANAGED_DEADLINE_TEST_FAULT=guardian-record-valid-ready \
  MANAGED_DEADLINE_TEST_RECORD="$existing_record" \
  python3 "$helper" --expected-parent-pid "$BASHPID" 5 0.2 -- \
  bash -c 'printf effect >"$1"' _ "$existing_effect" || existing_status=$?
[[ "$existing_status" == 125 && ! -e "$existing_effect" ]] \
  || fail "pre-existing test record did not fail closed"
cmp -s -- "$existing_before" "$existing_record" \
  || fail "pre-existing test record was modified"

monitor_control="$work/monitor.control"
monitor_record="$work/monitor-command.identity"
monitor_ready="$work/monitor-command.ready"
monitor_release="$work/monitor-command.release"
monitor_late="$work/monitor-command.late"
monitor_expected_parent_pid="$BASHPID"
python3 "$helper" --expected-parent-pid "$monitor_expected_parent_pid" \
  --control-file "$monitor_control" 30 0.20 -- \
  "$work/stubborn.sh" "$monitor_record" "$monitor_ready" \
  "$monitor_release" "$monitor_late" &
monitor_supervisor=$!
for _ in $(seq 1 500); do
  [[ -s "$monitor_control" && -s "$monitor_ready" ]] && break
  kill -0 "$monitor_supervisor" 2>/dev/null \
    || fail "managed monitor exited before readiness"
  sleep 0.01
done
[[ -s "$monitor_control" && -s "$monitor_record" && -s "$monitor_ready" ]] \
  || fail "managed monitor omitted control or command readiness"
assert_mode_0600 "$monitor_control" "managed monitor control"
IFS='|' read -r control_version control_supervisor control_supervisor_start \
  control_pgid control_guardian_start control_endpoint control_nonce \
  control_extra <"$monitor_control"
[[ -z "${control_extra:-}" && "$control_version" == v1 \
  && "$control_supervisor" == "$monitor_supervisor" \
  && "$control_supervisor_start" =~ ^[1-9][0-9]*$ \
  && "$control_pgid" =~ ^[1-9][0-9]*$ \
  && "$control_guardian_start" =~ ^[1-9][0-9]*$ \
  && "$control_endpoint" =~ ^[.]managed-deadline-stop-[0-9a-f]{32}[.]sock$ \
  && "$control_nonce" =~ ^[0-9a-f]{64}$ ]] \
  || fail "managed monitor control identity is invalid"
python3 "$helper" --request-stop "$monitor_control" \
  || fail "managed monitor protected stop request failed"
monitor_status=0
wait "$monitor_supervisor" || monitor_status=$?
[[ "$monitor_status" == 143 ]] \
  || fail "managed monitor did not return authenticated stop status"
[[ ! -e "$monitor_control" && ! -e "$(dirname "$monitor_control")/$control_endpoint" ]] \
  || fail "managed monitor retained stop metadata after acknowledgement"
assert_identity_absent "$monitor_record" managed-monitor-command
printf '%s|%s|%s\n' "$control_pgid" "$control_pgid" \
  "$control_guardian_start" >"$work/monitor-guardian.identity"
assert_identity_absent "$work/monitor-guardian.identity" managed-monitor-guardian
: >"$monitor_release"
sleep 0.5
[[ ! -e "$monitor_late" ]] || fail "managed monitor command produced a late effect"

stop_channel_output="$work/stop-channel.output"
stop_channel_error="$work/stop-channel.error"
stop_channel_status=0
if run_stop_channel_gate "$stop_channel_gate" "$helper" \
  "$stop_channel_output" "$stop_channel_error"; then
  stop_channel_status=0
else
  stop_channel_status=$?
fi
if [[ "$stop_channel_status" != 0 ]]; then
  printf 'native stop-channel bounded stdout evidence: %s\n' \
    "$STOP_CHANNEL_STDOUT_EVIDENCE" >&2
  fail "native stop-channel acceptance failed (status=$stop_channel_status): $STOP_CHANNEL_DIAGNOSTIC"
fi
secure_read_stop_channel_capture "$stop_channel_output" \
  "$STOP_CHANNEL_OUTPUT_IDENTITY" manifest \
  || fail "native stop-channel stdout capture became unsafe"
secure_read_stop_channel_capture "$stop_channel_error" \
  "$STOP_CHANNEL_ERROR_IDENTITY" raw >&2 \
  || fail "native stop-channel stderr capture became unsafe"

real_controller_stop_reached="$work/real-controller-stop.reached"
TEST_USE_REAL_MANAGED_DEADLINE=1 \
  TEST_REAL_STOP_REQUEST_REACHED="$real_controller_stop_reached" \
  BACKUP_PUBLICATION_TEST_GROUP=quiesce-event-lifecycle \
  bash "$repo_root/infra/tests/backup-publication.test.sh"
[[ -s "$real_controller_stop_reached" ]] \
  || fail "real backup controller omitted protected stop-request execution"

TEST_USE_REAL_MANAGED_DEADLINE=1 \
  BACKUP_PUBLICATION_TEST_GROUP=marker-writer-process-group \
  bash "$repo_root/infra/tests/backup-publication.test.sh"
TEST_USE_REAL_MANAGED_DEADLINE=1 \
  BACKUP_PUBLICATION_TEST_GROUP=migration-parser-deadline \
  bash "$repo_root/infra/tests/backup-publication.test.sh"

echo "managed-deadline-linux-tests-ok"
