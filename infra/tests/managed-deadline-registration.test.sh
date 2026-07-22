#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
workflow="$repo_root/.github/workflows/ci.yml"
linux_gate="$repo_root/infra/tests/managed-deadline-linux.test.sh"
stop_channel_gate="$repo_root/infra/tests/managed-deadline-stop-channel-linux.py"
helper="$repo_root/scripts/backup/run-managed-deadline.py"
controller="$repo_root/scripts/backup/backup.sh"
publication_test="$repo_root/infra/tests/backup-publication.test.sh"
python_command=python3
command -v "$python_command" >/dev/null 2>&1 || python_command=python
command -v "$python_command" >/dev/null 2>&1 \
  || { printf '%s\n' 'python3/python is required for registration tests' >&2; exit 1; }

fail() {
  printf '%s\n' "$1" >&2
  exit 1
}

skip_output=""
cleanup_registration_artifacts() {
  [[ -z "$skip_output" ]] || rm -f -- "$skip_output"
}
trap cleanup_registration_artifacts EXIT

grep -Fq 'runs-on: ubuntu-24.04' "$workflow" \
  || fail "managed-deadline CI job is not pinned to Ubuntu 24.04"
grep -Fxq '      - run: bash infra/tests/managed-deadline-registration.test.sh' "$workflow" \
  || fail "managed-deadline registration gate is not registered in CI"
grep -Fxq '      - run: bash infra/tests/managed-deadline-linux.test.sh' "$workflow" \
  || fail "managed-deadline Linux gate is not registered as a blocking CI step"
grep -Fq 'exit 77' "$linux_gate" \
  || fail "managed-deadline Linux gate has no explicit non-Linux skip"
grep -Fq 'managed-deadline-linux-tests-ok' "$linux_gate" \
  || fail "managed-deadline Linux gate has no success sentinel"
grep -Fq 'BACKUP_PUBLICATION_TEST_GROUP=marker-writer-process-group' "$linux_gate" \
  || fail "managed-deadline Linux gate omits the real-helper marker controller case"
grep -Fq 'BACKUP_PUBLICATION_TEST_GROUP=migration-parser-deadline' "$linux_gate" \
  || fail "managed-deadline Linux gate omits the real-helper migration controller cases"
grep -Fq 'TEST_USE_REAL_MANAGED_DEADLINE=1' "$linux_gate" \
  || fail "managed-deadline controller cases do not select the production helper"
for required_case in guardian-readiness-timeout guardian-invalid-readiness \
  guardian-ready-without-setsid guardian-close-before-go \
  guardian-fixed-setup-delay setup-exhausted-before-go \
  supervisor-parent-death-armed supervisor-post-launch-oserror \
  parent-already-dead hostile-signal-timeout hostile-signal-orphan; do
  grep -Fq "$required_case" "$linux_gate" \
    || fail "managed-deadline Linux gate omits $required_case"
done
grep -Fq 'for nonfinite_case in duration grace' "$linux_gate" \
  || fail "managed-deadline Linux gate omits non-finite duration/grace cases"
node - "$linux_gate" <<'JS' \
  || fail "managed-deadline Linux gate has nounset-unsafe local initialization"
const fs = require('node:fs');

const linuxGate = fs.readFileSync(process.argv[2], 'utf8');
const targetFunctions = ['run_timeout_case', 'run_hostile_case'];

function functionBody(document, functionName) {
  const lines = document.split(/\r?\n/);
  const start = lines.indexOf(`${functionName}() {`);
  if (start < 0) {
    throw new Error(`could not find ${functionName}`);
  }
  const relativeEnd = lines.slice(start + 1).findIndex((line) => line === '}');
  if (relativeEnd < 0) {
    throw new Error(`could not find the end of ${functionName}`);
  }
  return { lines: lines.slice(start + 1, start + 1 + relativeEnd), start };
}

function dependentLocalInitializers(document, functionName) {
  const body = functionBody(document, functionName);
  const diagnostics = [];
  for (const [offset, line] of body.lines.entries()) {
    if (!/^\s*local(?:\s|$)/.test(line)) {
      continue;
    }
    const initialized = new Set();
    const assignments = line.matchAll(
      /\b([A-Za-z_][A-Za-z0-9_]*)=("[^"]*"|'[^']*'|[^\s]+)/g,
    );
    for (const assignment of assignments) {
      const [, variable, rawValue] = assignment;
      const expandableValue = rawValue.replace(/'[^']*'/g, '');
      const references = Array.from(
        expandableValue.matchAll(
          /\$(?:\{([A-Za-z_][A-Za-z0-9_]*)|([A-Za-z_][A-Za-z0-9_]*))/g,
        ),
        (match) => match[1] || match[2],
      );
      for (const reference of references) {
        if (initialized.has(reference)) {
          diagnostics.push({
            functionName,
            line: body.start + offset + 2,
            variable,
            reference,
          });
        }
      }
      initialized.add(variable);
    }
  }
  return diagnostics;
}

const actualDiagnostics = targetFunctions.flatMap((functionName) =>
  dependentLocalInitializers(linuxGate, functionName),
);
if (actualDiagnostics.length > 0) {
  for (const diagnostic of actualDiagnostics) {
    console.error(
      `${diagnostic.functionName}:${diagnostic.line}: local ${diagnostic.variable} `
        + `references earlier ${diagnostic.reference} in the same declaration`,
    );
  }
  process.exit(1);
}

function replaceExactly(document, needle, replacement, label) {
  const pieces = document.split(needle);
  if (pieces.length !== 2) {
    throw new Error(`mutation fixture expected exactly one ${label}`);
  }
  return `${pieces[0]}${replacement}${pieces[1]}`;
}

for (const functionName of targetFunctions) {
  const safePrefix = `${functionName}() {\n`
    + '  local label="$1" mode="$2"\n'
    + '  local record="$work/$label.identity"';
  const unsafePrefix = `${functionName}() {\n`
    + '  local label="$1" mode="$2" record="$work/$label.identity"';
  const mutated = replaceExactly(
    linuxGate,
    safePrefix,
    unsafePrefix,
    `${functionName} split declaration`,
  );
  const mutationDiagnostics = dependentLocalInitializers(mutated, functionName);
  if (mutationDiagnostics.length !== 1
      || mutationDiagnostics[0].variable !== 'record'
      || mutationDiagnostics[0].reference !== 'label') {
    throw new Error(
      `${functionName} mutation fixture did not restore and reject the bad declaration`,
    );
  }
}
JS
grep -Fq 'TEST_RESUME_ABSENT_IDENTITY' "$publication_test" \
  || fail "controller fixtures do not assert group absence at fake resume"
grep -Fq 'TEST_MARKER_DESCENDANT_READY' "$publication_test" \
  && grep -Fq 'TEST_MIGRATION_PARSER_READY' "$publication_test" \
  && grep -Fq 'TEST_MIGRATION_PRODUCER_READY' "$publication_test" \
  || fail "controller fixtures do not bind readiness after exact identity capture"
if grep -Fq 'kill -KILL "$pid"' "$publication_test"; then
  fail "controller test still signals a PID without exact identity retention"
fi
[[ "$(grep -Fc 'assert_process_identity_absent' "$linux_gate" || true)" -ge 3 ]] \
  || fail "pre-setsid Linux cases still require unrelated caller-group disappearance"

grep -Fq -- '--expected-parent-pid' "$helper" \
  && grep -Fq 'math.isfinite' "$helper" \
  && grep -Fq 'launch_ack' "$helper" \
  && grep -Fq 'WaitabilityLost' "$helper" \
  || fail "managed-deadline helper omits a setup/launch/waitability blocker repair"
for fault in guardian-readiness-timeout guardian-invalid-readiness \
  guardian-ready-without-setsid guardian-record-valid-ready \
  guardian-close-before-go guardian-fixed-setup-delay supervisor-parent-death-armed \
  supervisor-post-launch-oserror; do
  grep -Fq "$fault" "$helper" \
    || fail "managed-deadline helper omits guarded fault $fault"
done
grep -Fq 'MANAGED_DEADLINE_TESTING' "$helper" \
  && grep -Fq 'MANAGED_DEADLINE_TEST_FAULT' "$helper" \
  && grep -Fq 'MANAGED_DEADLINE_TEST_RECORD' "$helper" \
  && grep -Fq 'O_NOFOLLOW' "$helper" \
  || fail "managed-deadline helper lacks the triple-guarded secure hook contract"
grep -Fq 'pthread_sigmask' "$helper" \
  && grep -Fq 'signal.SIGCHLD,' "$helper" \
  && grep -Fq 'signal.SIGPIPE,' "$helper" \
  && grep -Fq 'signal.signal(signal_number, signal.SIG_DFL)' "$helper" \
  || fail "managed-deadline helper does not normalize inherited signal state"
grep -Fq 'absolute_deadline' "$helper" \
  && grep -Fq 'supervision_started' "$helper" \
  || fail "managed-deadline helper excludes setup latency from its deadline"
grep -Fq 'for nonfinite_value in nan inf' "$linux_gate" \
  || fail "managed-deadline Linux gate omits behavioral NaN/Inf coverage"
grep -Fq '^MANAGED_DEADLINE_TEST(ING|_(FAULT|RECORD))=' "$linux_gate" \
  || fail "managed-deadline hook-strip test does not name all three guard variables"
grep -Fq 'setup_budget_ready=' "$linux_gate" \
  && grep -Fq -- '-s "$setup_budget_ready"' "$linux_gate" \
  || fail "partial setup-budget case does not prove command launch before timeout"
grep -Fq 'control_publication_started=' "$linux_gate" \
  && grep -Fq 'pre-existing control publication exceeded its bound' "$linux_gate" \
  || fail "pre-existing control publication failure has no bounded-return proof"
grep -Fq 'os.fchmod' "$helper" \
  && grep -Fq 'stat.S_IMODE' "$helper" \
  && grep -Fq 'assert_mode_0600 "$monitor_control"' "$linux_gate" \
  || fail "managed-deadline helper does not prove exact mode-0600 metadata"
grep -Fq 'cleanup_stop_metadata' "$helper" \
  && grep -Fq 'remove_owned_stop_endpoint' "$helper" \
  && grep -Fq 'remove_owned_control' "$helper" \
  && grep -Fq 'prove_path_absent' "$helper" \
  && grep -Fq 'metadata cleanup failed' "$helper" \
  || fail "post-GO stop metadata cleanup is not identity-safe and fail-closed"
grep -Fq 'fail_closed' "$helper" \
  || fail "managed-deadline helper has no non-returning containment failure path"
grep -Fq -- '--request-stop' "$helper" \
  && grep -Fq 'socket.AF_UNIX' "$helper" \
  && grep -Fq 'socket.SOCK_STREAM' "$helper" \
  && grep -Fq 'socket.SO_PEERCRED' "$helper" \
  && grep -Fq 'secrets.token_hex' "$helper" \
  && grep -Fq 'hmac.compare_digest' "$helper" \
  || fail "managed-deadline helper omits the authenticated AF_UNIX stop channel"
grep -Fq 'endpoint_identity_before' "$helper" \
  && grep -Fq 'endpoint_identity_after' "$helper" \
  && grep -Fq 'AF_UNIX_PATH_MAX' "$helper" \
  || fail "managed-deadline requester omits endpoint replacement or path-length proof"
grep -Fq 'server_stop_deadline' "$helper" \
  && grep -Fq 'endpoint_descriptor' "$helper" \
  && grep -Fq 'st_nlink != 1' "$helper" \
  && grep -Fq 'retained_control_metadata' "$helper" \
  && grep -Fq 'named_control_matches' "$helper" \
  && grep -Fq 'retained_control_metadata(descriptor, temporary_identity, 0)' "$helper" \
  || fail "managed-deadline server omits bounded teardown or retained single-link ownership"
grep -Fq 'STOPPED 143' "$helper" \
  && grep -Fq 'disable_termination_handlers' "$helper" \
  && grep -Fq 'authenticated_stop' "$helper" \
  && grep -Fq 'response_eof' "$helper" \
  || fail "managed-deadline stop acknowledgement is not ordered after non-signaling teardown"
grep -Fq 'GROUP_SCAN_SECONDS' "$helper" \
  && grep -Fq 'next_group_scan' "$helper" \
  || fail "managed-deadline process-group proof has no bounded scan cadence"
"$python_command" - "$helper" <<'PY' \
  || fail "managed-deadline process-group race classification regressed"
import importlib.util
import pathlib
import sys
import tempfile

helper_path = pathlib.Path(sys.argv[1])


def load_helper(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise SystemExit("cannot load managed-deadline helper")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def install_proc_fixture(module, first_error):
    real_path = module.Path

    class Entry:
        def __init__(self, name):
            self.name = name

    class ProcRoot:
        def iterdir(self):
            return [Entry("101"), Entry("102"), Entry("self")]

    def fake_path(value):
        return ProcRoot() if value == "/proc" else real_path(value)

    def fake_identity(pid):
        if pid == 101:
            raise first_error
        return module.ProcessIdentity(
            pid=pid, state="S", parent_pid=1, pgid=77, start_time=1234
        )

    module.Path = fake_path
    module.proc_identity = fake_identity


helper = load_helper(helper_path, "managed_deadline_group_members_base")
install_proc_fixture(helper, ProcessLookupError("vanished"))
members = helper.group_members(77, 999)
if [identity.pid for identity in members] != [102]:
    raise SystemExit("ProcessLookupError was not treated as a vanished /proc entry")

helper = load_helper(helper_path, "managed_deadline_group_members_permission")
install_proc_fixture(helper, PermissionError("denied"))
try:
    helper.group_members(77, 999)
except helper.ContainmentError as error:
    if not isinstance(error.__cause__, PermissionError):
        raise SystemExit("PermissionError lost its fail-closed cause")
else:
    raise SystemExit("PermissionError was incorrectly treated as process disappearance")

source = helper_path.read_text(encoding="utf-8")
needle = "        except (FileNotFoundError, ProcessLookupError):\n"
replacement = "        except FileNotFoundError:\n"
if source.count(needle) != 1:
    raise SystemExit("ProcessLookupError mutation anchor is missing or ambiguous")
with tempfile.TemporaryDirectory() as work:
    mutant_path = pathlib.Path(work) / "run-managed-deadline-mutant.py"
    mutant_path.write_text(source.replace(needle, replacement), encoding="utf-8")
    mutant = load_helper(mutant_path, "managed_deadline_group_members_mutant")
    install_proc_fixture(mutant, ProcessLookupError("vanished"))
    try:
        mutant.group_members(77, 999)
    except mutant.ContainmentError as error:
        if not isinstance(error.__cause__, ProcessLookupError):
            raise SystemExit("mutant failed for the wrong reason")
    else:
        raise SystemExit("ProcessLookupError catch-removal mutation survived")
PY
node - "$publication_test" <<'JS' \
  || fail "real-helper configured runtime cleanup registration regressed"
const fs = require("node:fs");
const source = fs.readFileSync(process.argv[2], "utf8");
const required = [
  "    printf '%s\\n' \"$work/runtime\"",
  'assert_case_protected_roots_empty "$label failure" "$case_root"',
  'assert_case_protected_roots_empty "real controller success" "$quiesce_success_case"',
  'assert_case_protected_roots_empty "marker writer deadline failure" "$marker_group_case"',
  'assert_case_protected_roots_empty "migration parser deadline failure" "$migration_deadline_case"',
  'assert_case_protected_roots_empty "migration producer deadline failure" "$migration_producer_case"',
];
for (const fragment of required) {
  if (source.split(fragment).length !== 2) {
    throw new Error(`configured runtime cleanup fragment is missing or ambiguous: ${fragment}`);
  }
}
JS
node - "$helper" <<'JS' \
  || fail "managed-deadline signal block/parent check does not guard publication and GO"
const fs = require('node:fs');
const body = fs.readFileSync(process.argv[2], 'utf8')
  .split('def supervise(arguments: Arguments) -> int:', 2)[1];
const block = body.indexOf('signal.pthread_sigmask(\n            signal.SIG_BLOCK');
const publication = body.indexOf('control_ownership = publish_control_file(');
const prePublicationDeadline = body.indexOf(
  'if time.monotonic() >= absolute_deadline:', block
);
const parentCheck = body.indexOf(
  'if os.getppid() != arguments.expected_parent_pid:', block
);
const go = body.indexOf('write_all(go_write, b"GO\\n")');
if (!(block >= 0 && block < prePublicationDeadline
    && prePublicationDeadline < publication && publication < parentCheck
    && parentCheck < go)) {
  process.exit(1);
}
JS

expected_parent_count="$(grep -Fc -- '--expected-parent-pid' "$controller" || true)"
[[ "$expected_parent_count" -ge 2 ]] \
  || fail "backup controller does not bind every helper launch to local BASHPID"
grep -Fq 'event_monitor_expected_parent_pid="$BASHPID"' "$controller" \
  && grep -Fq -- '--expected-parent-pid "$event_monitor_expected_parent_pid"' "$controller" \
  && grep -Fq 'monitor_expected_parent_pid="$BASHPID"' "$linux_gate" \
  && grep -Fq -- '--expected-parent-pid "$monitor_expected_parent_pid"' "$linux_gate" \
  || fail "background helper launch does not capture its parent BASHPID before async expansion"
grep -Fq 'event_monitor_containment_proven' "$controller" \
  && grep -Fq 'drain_event_monitor_group' "$controller" \
  || fail "backup controller omits bounded monitor containment state"
grep -Fq -- '--request-stop "$event_monitor_control"' "$controller" \
  || fail "backup controller does not use the protected supervisor stop channel"
grep -Fq -- '--expected-control-device "$event_monitor_control_device"' "$controller" \
  && grep -Fq -- '--expected-control-inode "$event_monitor_control_inode"' "$controller" \
  && grep -Fq -- '--expected-supervisor-start "$event_monitor_supervisor_start"' "$controller" \
  || fail "backup controller does not retain the original stop capability identity"
if grep -Eq '^[[:space:]]*(builtin[[:space:]]+)?kill[[:space:]]' "$controller"; then
  fail "backup controller retains a numeric process-signal site"
fi
if grep -Fq 'rm -f -- "$event_monitor_control"' "$controller"; then
  fail "backup controller unlinks supervisor-owned stop metadata"
fi
for stop_case in stop-channel-normal stop-channel-term-ignoring \
  stop-channel-lingering-descendant stop-channel-replacement \
  stop-channel-requester-death stop-channel-post-reap \
  stop-channel-stale-pid-namespace-decoy stop-channel-overlong-path \
  stop-channel-wrong-nonce stop-channel-ack-without-eof \
  stop-channel-cleanup-no-ack stop-channel-slow-peer-bound \
  stop-channel-wrong-uid stop-channel-connect-replacement-race \
  stop-channel-post-auth-control-hardlink \
  stop-channel-post-auth-endpoint-hardlink \
  stop-channel-post-auth-control-mode \
  stop-channel-post-auth-endpoint-mode \
  stop-channel-external-term-no-ack stop-channel-setup-failure-cleanup \
  stop-channel-control-fifo-bound stop-channel-late-clean-ack \
  stop-channel-grace-budget stop-channel-server-deadline-within \
  stop-channel-server-deadline-exhausted stop-channel-partial-ack \
  stop-channel-oversize-ack stop-channel-inherited-short-deadline \
  stop-channel-endpoint-post-unlink-expiry \
  stop-channel-control-post-unlink-expiry; do
  grep -Fq "$stop_case" "$stop_channel_gate" \
    || fail "managed-deadline Linux gate omits $stop_case"
done
"$python_command" - "$stop_channel_gate" <<'PY' \
  || fail "managed-deadline request-frame bytes validator contract failed"
import ast
import copy
import pathlib
import sys

source_path = pathlib.Path(sys.argv[1])
module = ast.parse(source_path.read_text(encoding="utf-8"), filename=str(source_path))
function = next(
    node
    for node in module.body
    if isinstance(node, ast.FunctionDef) and node.name == "run_fake_peer_bound_case"
)


def request_frame_nodes(candidate_function):
    parts_candidates = [
        node
        for node in ast.walk(candidate_function)
        if isinstance(node, ast.Assign)
        and any(
            isinstance(target, ast.Name) and target.id == "parts"
            for target in node.targets
        )
    ]
    if len(parts_candidates) != 1:
        raise SystemExit(
            "request-frame AST selector expected exactly one parts assignment, "
            f"found {len(parts_candidates)}"
        )
    frame_guard_candidates = [
        node
        for node in ast.walk(candidate_function)
        if isinstance(node, ast.If)
        and any(
            isinstance(candidate, ast.Constant)
            and candidate.value == ": requester did not send the exact authenticated frame"
            for candidate in ast.walk(node)
        )
    ]
    if len(frame_guard_candidates) != 1:
        raise SystemExit(
            "request-frame AST selector expected exactly one frame guard, "
            f"found {len(frame_guard_candidates)}"
        )
    return parts_candidates[0], frame_guard_candidates[0]


parts_assignment, frame_guard = request_frame_nodes(function)


class RejectedFrame(Exception):
    pass


def fail(message):
    raise RejectedFrame(message)


validator = ast.FunctionDef(
    name="accepts_request_frame",
    args=ast.arguments(
        posonlyargs=[],
        args=[ast.arg(arg="request"), ast.arg(arg="fields")],
        kwonlyargs=[],
        kw_defaults=[],
        defaults=[],
    ),
    body=[
        ast.Assign(
            targets=[ast.Name(id="label", ctx=ast.Store())],
            value=ast.Constant(value="request-frame-fixture"),
        ),
        copy.deepcopy(parts_assignment),
        copy.deepcopy(frame_guard),
        ast.Return(value=ast.Constant(value=True)),
    ],
    decorator_list=[],
)
unit = ast.Module(body=[validator], type_ignores=[])
ast.fix_missing_locations(unit)
namespace = {"fail": fail}
exec(compile(unit, str(source_path), "exec"), namespace)
accepts_request_frame = namespace["accepts_request_frame"]

nonce = "ab" * 32
fields = ["v1", "1", "2", "3", "4", ".managed-stop.sock", nonce]
valid = (
    ("zero", f"STOP {nonce} 0\n".encode("ascii")),
    ("leading-zero", f"STOP {nonce} 000123\n".encode("ascii")),
    ("positive", f"STOP {nonce} 123456789\n".encode("ascii")),
)
for label, candidate in valid:
    if accepts_request_frame(candidate, fields) is not True:
        raise SystemExit(f"request-frame validator rejected valid {label} decimal")

invalid = (
    ("malformed-command", f"START {nonce} 123\n".encode("ascii")),
    ("malformed-nonce", b"STOP " + b"cd" * 32 + b" 123\n"),
    ("empty-frame", b""),
    ("empty-deadline", f"STOP {nonce} \n".encode("ascii")),
    ("positive-sign", f"STOP {nonce} +123\n".encode("ascii")),
    ("negative-sign", f"STOP {nonce} -123\n".encode("ascii")),
    ("alphabetic-deadline", f"STOP {nonce} abc\n".encode("ascii")),
    ("mixed-alphanumeric-deadline", f"STOP {nonce} 12a3\n".encode("ascii")),
    ("non-ascii", f"STOP {nonce} ".encode("ascii") + b"\xff\n"),
    ("leading-whitespace", f" STOP {nonce} 123\n".encode("ascii")),
    ("double-whitespace", f"STOP  {nonce} 123\n".encode("ascii")),
    ("tab-whitespace", f"STOP\t{nonce} 123\n".encode("ascii")),
    ("missing-newline", f"STOP {nonce} 123".encode("ascii")),
    ("extra-field", f"STOP {nonce} 123 extra\n".encode("ascii")),
)
for label, candidate in invalid:
    try:
        accepts_request_frame(candidate, fields)
    except RejectedFrame:
        continue
    raise SystemExit(f"request-frame validator accepted {label}: {candidate!r}")

selection_mutations = (
    (
        "parts assignment",
        parts_assignment,
        "request-frame AST selector expected exactly one parts assignment, found 2",
    ),
    (
        "frame guard",
        frame_guard,
        "request-frame AST selector expected exactly one frame guard, found 2",
    ),
)
for label, duplicate, expected in selection_mutations:
    mutated_function = copy.deepcopy(function)
    mutated_function.body.append(copy.deepcopy(duplicate))
    try:
        request_frame_nodes(mutated_function)
    except SystemExit as error:
        if str(error) != expected:
            raise SystemExit(
                f"request-frame duplicate {label} produced the wrong structural error: "
                f"{error}"
            ) from error
        continue
    raise SystemExit(f"request-frame selector accepted duplicate {label}")
PY
"$python_command" - "$stop_channel_gate" <<'PY' \
  || fail "managed-deadline stop-channel case diagnostic contract failed"
import ast
import contextlib
import io
import os
import pathlib
import subprocess
import tempfile
import sys

source_path = pathlib.Path(sys.argv[1])
source = source_path.read_text(encoding="utf-8")
module = ast.parse(source, filename=str(source_path))
required_functions = {
    "_bounded_diagnostic",
    "_sanitize_diagnostic",
    "_stop_case_failure_record",
    "fail",
    "run_case",
}
required_classes = {"StopChannelFailure"}
required_assignments = {
    "ACTIVE_STOP_CASE_LABEL",
    "DIAGNOSTIC_LIMIT_BYTES",
    "DIAGNOSTIC_TRUNCATION_MARKER",
    "EXPECTED_STOP_CASES",
    "EXECUTED_STOP_CASES",
    "PRIVATE_WORK_ROOT",
}
selected = []
found_functions = set()
found_classes = set()
found_assignments = set()
for node in module.body:
    if isinstance(node, (ast.Import, ast.ImportFrom)):
        selected.append(node)
    elif isinstance(node, ast.FunctionDef) and node.name in required_functions:
        selected.append(node)
        found_functions.add(node.name)
    elif isinstance(node, ast.ClassDef) and node.name in required_classes:
        selected.append(node)
        found_classes.add(node.name)
    elif isinstance(node, (ast.Assign, ast.AnnAssign)):
        targets = node.targets if isinstance(node, ast.Assign) else [node.target]
        names = {target.id for target in targets if isinstance(target, ast.Name)}
        if names & required_assignments:
            selected.append(node)
            found_assignments.update(names & required_assignments)
missing = sorted(
    (required_functions - found_functions)
    | (required_classes - found_classes)
    | (required_assignments - found_assignments)
)
if missing:
    raise SystemExit(f"diagnostic unit could not load: {missing!r}")

namespace = {"__name__": "managed_deadline_stop_channel_diagnostic_unit"}
ast.fix_missing_locations(module)
unit = ast.Module(body=selected, type_ignores=[])
ast.fix_missing_locations(unit)
exec(compile(unit, str(source_path), "exec"), namespace)

run_case = namespace["run_case"]
fail_operation = namespace["fail"]
executed = namespace["EXECUTED_STOP_CASES"]
capability_32 = "a" * 32
capability_64 = "b" * 64
with tempfile.TemporaryDirectory(prefix="managed-deadline-diagnostic-unit-") as work:
    namespace["PRIVATE_WORK_ROOT"] = pathlib.Path(work)
    message = (
        f"{work}\r\n\0%\x1b::error title=forged::{capability_32}:"
        f"{capability_64}:stop-channel-overlong-path:" + "\u754c" * 400
    )
    original = RuntimeError(message)

    def explode():
        raise original

    stderr = io.StringIO()
    propagated = None
    try:
        with contextlib.redirect_stderr(stderr):
            run_case("stop-channel-normal", explode)
    except BaseException as error:
        propagated = error
    if propagated is not original:
        raise SystemExit("run_case did not re-raise the original exception object")
    if executed:
        raise SystemExit("failed run_case appended an executed-case marker")
    physical = stderr.getvalue()
    if not physical.endswith("\n") or physical.count("\n") != 1:
        raise SystemExit("run_case failure diagnostic is not exactly one physical line")
    record = physical[:-1]
    expected_prefix = (
        "managed-deadline-stop-channel-case-failed:"
        "stop-channel-normal:RuntimeError:"
    )
    if not record.startswith(expected_prefix):
        raise SystemExit(f"run_case failure diagnostic has wrong attribution: {record!r}")
    if len(record.encode("utf-8")) > 512:
        raise SystemExit("run_case failure diagnostic exceeds 512 UTF-8 bytes")
    forbidden = (
        work,
        capability_32,
        capability_64,
        "%",
        "::error",
        "\r",
        "\0",
        "\x1b",
        "Traceback",
    )
    if any(value in record for value in forbidden):
        raise SystemExit(f"run_case diagnostic leaked unsafe material: {record!r}")
    required = (
        "<work>",
        "<capability>",
        "\\r",
        "\\n",
        "\\0",
        "\\x1b",
        "\\x25",
        "\\x3a\\x3aerror",
        "...[truncated]",
    )
    if any(value not in record for value in required):
        raise SystemExit(f"run_case diagnostic omitted sanitization evidence: {record!r}")

    interrupt = KeyboardInterrupt("interrupt\n::warning::forged")

    def interrupt_operation():
        raise interrupt

    stderr = io.StringIO()
    propagated = None
    try:
        with contextlib.redirect_stderr(stderr):
            run_case("stop-channel-normal", interrupt_operation)
    except BaseException as error:
        propagated = error
    if propagated is not interrupt or stderr.getvalue().count("\n") != 1:
        raise SystemExit("run_case does not preserve BaseException failures")
    if ":stop-channel-normal:KeyboardInterrupt:" not in stderr.getvalue():
        raise SystemExit("run_case BaseException diagnostic has wrong type or label")

    stderr = io.StringIO()
    with contextlib.redirect_stderr(stderr):
        run_case("stop-channel-normal", lambda: None)
    if stderr.getvalue() or executed != ["stop-channel-normal"]:
        raise SystemExit("run_case changed successful execution behavior")

    outside_failure = None
    try:
        fail_operation("outside-run-case failure")
    except SystemExit as error:
        outside_failure = error
    if type(outside_failure) is not SystemExit or outside_failure.code != "outside-run-case failure":
        raise SystemExit("fail suppressed or converted a failure outside run_case")

    executed.clear()
    stderr = io.StringIO()
    propagated = None
    try:
        with contextlib.redirect_stderr(stderr):
            run_case(
                "stop-channel-normal",
                lambda: fail_operation("inside-run-case failure"),
            )
    except BaseException as error:
        propagated = error
    if type(propagated).__name__ != "StopChannelFailure" or propagated.code != 1:
        raise SystemExit("in-case fail did not preserve status 1 without duplicate output")
    if ":stop-channel-normal:StopChannelFailure:inside-run-case failure" not in stderr.getvalue():
        raise SystemExit("in-case fail omitted its labelled diagnostic message")
    if namespace["ACTIVE_STOP_CASE_LABEL"] is not None:
        raise SystemExit("run_case retained active attribution state after failure")

    class WriteFailure:
        def write(self, _payload):
            raise OSError("diagnostic write failed")

        def flush(self):
            raise AssertionError("flush must not run after write failure")

    class FlushFailure:
        def write(self, payload):
            return len(payload)

        def flush(self):
            raise OSError("diagnostic flush failed")

    failure_factories = (
        lambda: RuntimeError("runtime emission failure"),
        lambda: SystemExit("string emission failure"),
        lambda: KeyboardInterrupt("keyboard emission failure"),
        lambda: SystemExit(73),
    )
    for failure_stream in (WriteFailure(), FlushFailure()):
        for failure_factory in failure_factories:
            original = failure_factory()

            def emission_failure():
                raise original

            executed.clear()
            previous_stderr = sys.stderr
            propagated = None
            try:
                sys.stderr = failure_stream
                try:
                    run_case("stop-channel-normal", emission_failure)
                except BaseException as error:
                    propagated = error
            finally:
                sys.stderr = previous_stderr
            if (
                propagated is not original
                or namespace["ACTIVE_STOP_CASE_LABEL"] is not None
                or executed
            ):
                raise SystemExit(
                    "diagnostic write/flush failure displaced the original exception/status"
                )

subprocess_cases = (
    (
        "runtime-error",
        1,
        "RuntimeError",
        r"runtime failure\n\x250A\x3a\x3aerror title=forged\x3a\x3a",
    ),
    (
        "string-system-exit",
        1,
        "SystemExit",
        r"string exit\n\x250A\x3a\x3aerror title=forged\x3a\x3a",
    ),
    (
        "keyboard-interrupt",
        130,
        "KeyboardInterrupt",
        r"keyboard interrupt\n\x3a\x3awarning\x3a\x3aforged",
    ),
    ("numeric-system-exit", 73, "SystemExit", "73"),
)
for mode, expected_status, expected_type, expected_message in subprocess_cases:
    process = subprocess.run(
        [sys.executable, str(source_path), "--diagnostic-subprocess", mode],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
        timeout=10,
    )
    if process.returncode != expected_status or process.stdout:
        raise SystemExit(
            f"diagnostic subprocess {mode} changed status/stdout: "
            f"{process.returncode}, {process.stdout!r}"
        )
    if not process.stderr.endswith(b"\n") or process.stderr.count(b"\n") != 1:
        raise SystemExit(
            f"diagnostic subprocess {mode} emitted displaced output: {process.stderr!r}"
        )
    record = process.stderr[:-1]
    expected_prefix = (
        "managed-deadline-stop-channel-case-failed:"
        f"stop-channel-normal:{expected_type}:"
    ).encode("ascii")
    if record != expected_prefix + expected_message.encode("ascii") or len(record) > 512:
        raise SystemExit(
            f"diagnostic subprocess {mode} lost bounded case attribution: {record!r}"
        )
    if b"Traceback" in record or b"::error" in record or b"%" in record:
        raise SystemExit(
            f"diagnostic subprocess {mode} retained unsafe default output: {record!r}"
        )

spoofed_environment = os.environ.copy()
spoofed_environment["MANAGED_DEADLINE_STOP_CHANNEL_INNER"] = (
    f"999999:{os.getpid()}:" + "00" * 32
)
spoofed = subprocess.run(
    [sys.executable, str(source_path), "--diagnostic-subprocess", "runtime-error"],
    stdin=subprocess.DEVNULL,
    stdout=subprocess.PIPE,
    stderr=subprocess.PIPE,
    env=spoofed_environment,
    check=False,
    timeout=10,
)
if (
    spoofed.returncode != 1
    or spoofed.stdout
    or spoofed.stderr.count(b"\n") != 1
    or b"Traceback" in spoofed.stderr
    or not spoofed.stderr.startswith(
        b"managed-deadline-stop-channel-case-failed:stop-channel-normal:RuntimeError:"
    )
):
    raise SystemExit("caller-controlled environment bypassed the diagnostic boundary")

with tempfile.TemporaryDirectory(prefix="managed-deadline-boundary-stderr-") as work:
    read_only_path = pathlib.Path(work) / "read-only-stderr"
    read_only_path.write_bytes(b"")
    with read_only_path.open("rb") as read_only_stderr:
        emission_failure = subprocess.run(
            [
                sys.executable,
                str(source_path),
                "--diagnostic-subprocess",
                "numeric-system-exit",
            ],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=read_only_stderr,
            check=False,
            timeout=10,
        )
if emission_failure.returncode != 73 or emission_failure.stdout:
    raise SystemExit(
        "process-boundary stderr failure displaced numeric SystemExit status 73"
    )
PY
"$python_command" - "$stop_channel_gate" <<'PY' \
  || fail "managed-deadline diagnostic semantic mutations were not rejected"
import ast
import contextlib
import io
import pathlib
import subprocess
import sys
import tempfile

source_path = pathlib.Path(sys.argv[1])
source = source_path.read_text(encoding="utf-8")
required_functions = {
    "_bounded_diagnostic",
    "_sanitize_diagnostic",
    "_stop_case_failure_record",
    "fail",
    "run_case",
}
required_classes = {"StopChannelFailure"}
required_assignments = {
    "ACTIVE_STOP_CASE_LABEL",
    "DIAGNOSTIC_LIMIT_BYTES",
    "DIAGNOSTIC_TRUNCATION_MARKER",
    "EXPECTED_STOP_CASES",
    "EXECUTED_STOP_CASES",
    "PRIVATE_WORK_ROOT",
}


def load_unit(candidate):
    module = ast.parse(candidate, filename=str(source_path))
    selected = []
    found_functions = set()
    found_classes = set()
    found_assignments = set()
    for node in module.body:
        if isinstance(node, (ast.Import, ast.ImportFrom)):
            selected.append(node)
        elif isinstance(node, ast.FunctionDef) and node.name in required_functions:
            selected.append(node)
            found_functions.add(node.name)
        elif isinstance(node, ast.ClassDef) and node.name in required_classes:
            selected.append(node)
            found_classes.add(node.name)
        elif isinstance(node, (ast.Assign, ast.AnnAssign)):
            targets = node.targets if isinstance(node, ast.Assign) else [node.target]
            names = {target.id for target in targets if isinstance(target, ast.Name)}
            if names & required_assignments:
                selected.append(node)
                found_assignments.update(names & required_assignments)
    if (
        found_functions != required_functions
        or found_classes != required_classes
        or found_assignments != required_assignments
    ):
        raise ValueError("mutated diagnostic unit is incomplete")
    unit = ast.Module(body=selected, type_ignores=[])
    ast.fix_missing_locations(unit)
    namespace = {"__name__": "managed_deadline_mutated_diagnostic_unit"}
    exec(compile(unit, str(source_path), "exec"), namespace)
    return namespace


def unit_accepts(candidate):
    try:
        namespace = load_unit(candidate)
    except (SyntaxError, ValueError):
        return False
    run_case = namespace["run_case"]
    original = RuntimeError(
        "unsafe\n%0A::error title=forged::" + "a" * 32 + ":" + "b" * 64 + "\u754c" * 400
    )

    def explode():
        raise original

    stderr = io.StringIO()
    propagated = None
    try:
        with contextlib.redirect_stderr(stderr):
            run_case("stop-channel-normal", explode)
    except BaseException as error:
        propagated = error
    physical = stderr.getvalue()
    if propagated is not original or physical.count("\n") != 1:
        return False
    record = physical[:-1]
    if (
        not record.startswith(
            "managed-deadline-stop-channel-case-failed:stop-channel-normal:RuntimeError:"
        )
        or len(record.encode("utf-8")) > 512
        or any(value in record for value in ("%", "::error", "a" * 32, "b" * 64))
        or not record.endswith("...[truncated]")
        or namespace["EXECUTED_STOP_CASES"]
        or namespace["ACTIVE_STOP_CASE_LABEL"] is not None
    ):
        return False

    class WriteFailure:
        def write(self, _payload):
            raise OSError("mutated emission failure")

        def flush(self):
            raise AssertionError("flush must not follow failed write")

    emission_original = SystemExit(73)

    def emission_failure():
        raise emission_original

    previous_stderr = sys.stderr
    propagated = None
    try:
        sys.stderr = WriteFailure()
        try:
            run_case("stop-channel-normal", emission_failure)
        except BaseException as error:
            propagated = error
    finally:
        sys.stderr = previous_stderr
    return (
        propagated is emission_original
        and namespace["ACTIVE_STOP_CASE_LABEL"] is None
        and not namespace["EXECUTED_STOP_CASES"]
    )


def replace_once(candidate, needle, replacement, label):
    if candidate.count(needle) != 1:
        raise SystemExit(f"semantic mutation expected one {label} site")
    return candidate.replace(needle, replacement, 1)


if not unit_accepts(source):
    raise SystemExit("original diagnostic unit failed semantic acceptance")

unit_mutations = (
    (
        "active case attribution",
        "            record = _stop_case_failure_record(label, error)",
        "            if False:\n"
        "                record = _stop_case_failure_record(label, error)\n"
        '            record = _stop_case_failure_record("stop-channel-term-ignoring", error)',
    ),
    (
        "diagnostic byte cap",
        "    return _bounded_diagnostic(record)",
        "    if False:\n"
        "        return _bounded_diagnostic(record)\n"
        "    return record",
    ),
    (
        "workflow escaping",
        r'    text = text.replace("::", "\\x3a\\x3a")',
        "    if False:\n"
        r'        text = text.replace("::", "\\x3a\\x3a")',
    ),
    (
        "bare original re-raise",
        "            raise\n    finally:\n        ACTIVE_STOP_CASE_LABEL = previous_label",
        "            if False:\n"
        "                raise\n"
        '            raise RuntimeError("mutated replacement")\n'
        "    finally:\n"
        "        ACTIVE_STOP_CASE_LABEL = previous_label",
    ),
    (
        "best-effort diagnostic emission",
        "            except BaseException:\n"
        "                pass\n"
        "            raise",
        "            except BaseException:\n"
        "                if False:\n"
        "                    pass\n"
        "                raise\n"
        "            raise",
    ),
)
for label, needle, replacement in unit_mutations:
    mutated = replace_once(source, needle, replacement, label)
    if unit_accepts(mutated):
        raise SystemExit(f"semantic dead-code mutation survived: {label}")


def subprocess_accepts(path):
    process = subprocess.run(
        [sys.executable, str(path), "--diagnostic-subprocess", "runtime-error"],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
        timeout=10,
    )
    return (
        process.returncode == 1
        and not process.stdout
        and process.stderr.count(b"\n") == 1
        and process.stderr.startswith(
            b"managed-deadline-stop-channel-case-failed:stop-channel-normal:RuntimeError:"
        )
        and b"Traceback" not in process.stderr
    )


boundary_mutations = (
    (
        "boundary diagnostic selection",
        "        if len(failure_records) == 1:\n"
        "            diagnostic = failure_records[0]",
        "        if False and len(failure_records) == 1:\n"
        "            diagnostic = failure_records[0]",
    ),
    (
        "authenticated boundary entry",
        "if not _consume_process_boundary_capability():\n"
        "    _run_process_boundary()",
        "if False:\n"
        "    _ = _consume_process_boundary_capability()\n"
        "if False:\n"
        "    _run_process_boundary()",
    ),
)
with tempfile.TemporaryDirectory(prefix="managed-deadline-diagnostic-mutants-") as work:
    for index, (label, needle, replacement) in enumerate(boundary_mutations):
        mutated = replace_once(source, needle, replacement, label)
        mutant_path = pathlib.Path(work) / f"mutant-{index}.py"
        mutant_path.write_text(mutated, encoding="utf-8")
        if subprocess_accepts(mutant_path):
            raise SystemExit(f"semantic dead-code mutation survived: {label}")

    emission_mutant = replace_once(
        source,
        "    except BaseException:\n"
        "        pass\n"
        "    raise SystemExit(status)",
        "    except BaseException:\n"
        "        if False:\n"
        "            pass\n"
        "        raise\n"
        "    raise SystemExit(status)",
        "boundary best-effort emission",
    )
    emission_mutant_path = pathlib.Path(work) / "mutant-boundary-emission.py"
    emission_mutant_path.write_text(emission_mutant, encoding="utf-8")
    read_only_path = pathlib.Path(work) / "read-only-stderr"
    read_only_path.write_bytes(b"")
    with read_only_path.open("rb") as read_only_stderr:
        process = subprocess.run(
            [
                sys.executable,
                str(emission_mutant_path),
                "--diagnostic-subprocess",
                "numeric-system-exit",
            ],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=read_only_stderr,
            check=False,
            timeout=10,
        )
    if process.returncode == 73:
        raise SystemExit(
            "semantic dead-code mutation survived: boundary best-effort emission"
        )

    diagnostic_dispatch = (
        "if DIAGNOSTIC_SUBPROCESS_MODE is not None:\n"
        "    _run_diagnostic_subprocess_case(DIAGNOSTIC_SUBPROCESS_MODE)"
    )
    ambiguous_dispatch = (
        'if DIAGNOSTIC_SUBPROCESS_MODE == "ambiguous-keyboard-records":\n'
        "    sys.stderr.write(\n"
        '        "managed-deadline-stop-channel-case-failed:stop-channel-normal:"\n'
        '        "KeyboardInterrupt:ambiguous\\n"\n'
        '        "managed-deadline-stop-channel-case-failed:stop-channel-normal:"\n'
        '        "SystemExit:73\\n"\n'
        "    )\n"
        "    sys.stderr.flush()\n"
        "    raise SystemExit(73)\n"
        "if DIAGNOSTIC_SUBPROCESS_MODE is not None:\n"
        "    _run_diagnostic_subprocess_case(DIAGNOSTIC_SUBPROCESS_MODE)"
    )
    ambiguous_source = replace_once(
        source,
        diagnostic_dispatch,
        ambiguous_dispatch,
        "ambiguous KeyboardInterrupt dispatch",
    )
    ambiguous_path = pathlib.Path(work) / "ambiguous-keyboard.py"
    ambiguous_path.write_text(ambiguous_source, encoding="utf-8")
    ambiguous = subprocess.run(
        [
            sys.executable,
            str(ambiguous_path),
            "--diagnostic-subprocess",
            "ambiguous-keyboard-records",
        ],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
        timeout=10,
    )
    if ambiguous.returncode != 73 or ambiguous.stdout:
        raise SystemExit(
            "ambiguous KeyboardInterrupt records changed numeric child status 73"
        )

    unique_interrupt_check = (
        '    if len(failure_records) == 1 and b":KeyboardInterrupt:" '
        "in failure_records[0]:\n"
        "        status = 130"
    )
    nonunique_interrupt_check = (
        '    if False and len(failure_records) == 1 and b":KeyboardInterrupt:" '
        "in failure_records[0]:\n"
        "        status = 130\n"
        '    elif failure_records and b":KeyboardInterrupt:" in failure_records[0]:\n'
        "        status = 130"
    )
    ambiguous_status_mutant = replace_once(
        ambiguous_source,
        unique_interrupt_check,
        nonunique_interrupt_check,
        "unique KeyboardInterrupt status derivation",
    )
    ambiguous_status_path = pathlib.Path(work) / "ambiguous-keyboard-mutant.py"
    ambiguous_status_path.write_text(ambiguous_status_mutant, encoding="utf-8")
    ambiguous_mutant = subprocess.run(
        [
            sys.executable,
            str(ambiguous_status_path),
            "--diagnostic-subprocess",
            "ambiguous-keyboard-records",
        ],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
        timeout=10,
    )
    if ambiguous_mutant.returncode == 73:
        raise SystemExit(
            "semantic dead-code mutation survived: unique KeyboardInterrupt status"
        )
PY
node - "$linux_gate" "$stop_channel_gate" <<'JS' \
  || fail "managed-deadline stop-channel diagnostic mutations are not rejected"
const fs = require('node:fs');

const linuxGate = fs.readFileSync(process.argv[2], 'utf8');
const nativeGate = fs.readFileSync(process.argv[3], 'utf8');

const linuxRequirements = [
  'STOP_CHANNEL_DIAGNOSTIC_BYTES=512',
  '2>"$stop_channel_error"',
  'stop_channel_status=$?',
  'os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW',
  'no bounded native diagnostic available',
  'validated_manifest(payload)',
  '"$STOP_CHANNEL_OUTPUT_IDENTITY" manifest',
  'os.mkfifo(stderr_path, 0o600)',
  'socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)',
  'secure_read_stop_channel_capture /dev/null',
  'path.replace(path.with_suffix(".retained"))',
  'native-diagnostic-launcher.py',
];
const readerRequirements = [
  'not stat.S_ISREG(metadata.st_mode)',
  'metadata.st_uid != os.getuid()',
  'stat.S_IMODE(metadata.st_mode) != 0o600',
  'metadata.st_nlink != 1',
  '(metadata.st_dev, metadata.st_ino) != expected_identity',
];
const nativeRequirements = [
  'except BaseException as error:',
  'managed-deadline-stop-channel-case-failed:{label}',
  'sys.stderr.write(record + "\\n")',
  'text.replace("::", "\\\\x3a\\\\x3a")',
  'character == "%"',
  'raise\n',
];

function accepts(linuxDocument, nativeDocument) {
  const readerParts = linuxDocument.split('secure_read_stop_channel_capture() {');
  const reader = readerParts.length === 2
    ? readerParts[1].split('\n}\n\nrun_stop_channel_gate() {', 1)[0]
    : '';
  return linuxRequirements.every((needle) => linuxDocument.includes(needle))
    && readerRequirements.every((needle) => reader.includes(needle))
    && nativeRequirements.every((needle) => nativeDocument.includes(needle))
    && !linuxDocument.includes('cat -- "$stop_channel_output"')
    && !linuxDocument.includes('if ! python3 "$stop_channel_gate" "$helper"');
}

function replaceInReader(document, needle, replacement, label) {
  const startToken = 'secure_read_stop_channel_capture() {';
  const endToken = '\n}\n\nrun_stop_channel_gate() {';
  const start = document.indexOf(startToken);
  const end = document.indexOf(endToken, start);
  if (start < 0 || end < 0) {
    throw new Error('mutation fixture could not isolate secure capture reader');
  }
  const prefix = document.slice(0, start);
  const reader = document.slice(start, end);
  const suffix = document.slice(end);
  return prefix + replaceExactly(reader, needle, replacement, label) + suffix;
}

if (!accepts(linuxGate, nativeGate)) {
  throw new Error('diagnostic acceptance source is incomplete');
}

function replaceExactly(document, needle, replacement, label) {
  const pieces = document.split(needle);
  if (pieces.length !== 2) {
    throw new Error(`mutation fixture expected exactly one ${label}`);
  }
  return `${pieces[0]}${replacement}${pieces[1]}`;
}

const mutations = [
  ['stderr capture', 'linux', '2>"$stop_channel_error"'],
  ['active case label', 'native', 'managed-deadline-stop-channel-case-failed:{label}'],
  ['diagnostic byte cap', 'linux', 'STOP_CHANNEL_DIAGNOSTIC_BYTES=512'],
  ['control and workflow escaping', 'native', 'text.replace("::", "\\\\x3a\\\\x3a")'],
  ['capture file type', 'reader', 'not stat.S_ISREG(metadata.st_mode)'],
  ['capture file owner', 'reader', 'metadata.st_uid != os.getuid()'],
  ['capture file mode', 'reader', 'stat.S_IMODE(metadata.st_mode) != 0o600'],
  ['capture file link count', 'reader', 'metadata.st_nlink != 1'],
  ['retained device and inode', 'reader', '(metadata.st_dev, metadata.st_ino) != expected_identity'],
  ['unsafe diagnostic fallback', 'linux', 'no bounded native diagnostic available'],
];

for (const [label, target, needle] of mutations) {
  let mutatedLinux = linuxGate;
  if (target === 'linux') {
    mutatedLinux = replaceExactly(linuxGate, needle, `MUTATED_${label}`, label);
  } else if (target === 'reader') {
    mutatedLinux = replaceInReader(linuxGate, needle, `MUTATED_${label}`, label);
  }
  const mutatedNative = target === 'native'
    ? replaceExactly(nativeGate, needle, `MUTATED_${label}`, label)
    : nativeGate;
  if (accepts(mutatedLinux, mutatedNative)) {
    throw new Error(`diagnostic mutation survived: ${label}`);
  }
}
JS
"$python_command" - "$linux_gate" <<'PY' \
  || fail "managed-deadline secure capture semantic contract failed"
import ast
import os
import pathlib
import stat
import sys
import types

document = pathlib.Path(sys.argv[1]).read_text(encoding="utf-8")
section = document.split("secure_read_stop_channel_capture() {", 1)[1]
reader_source = section.split("<<'PY'\n", 1)[1].split("\nPY\n}", 1)[0]


def assigned_flag_names(source):
    module = ast.parse(source)
    assignment = next(
        node
        for node in module.body
        if isinstance(node, ast.Assign)
        and any(isinstance(target, ast.Name) and target.id == "flags" for target in node.targets)
    )
    return {
        node.attr
        for node in ast.walk(assignment.value)
        if isinstance(node, ast.Attribute)
        and isinstance(node.value, ast.Name)
        and node.value.id == "os"
    }, assignment.lineno, module


def metadata_predicate(source):
    module = ast.parse(source)
    function = next(
        node
        for node in module.body
        if isinstance(node, ast.FunctionDef) and node.name == "safe_metadata"
    )
    unit = ast.Module(body=[function], type_ignores=[])
    ast.fix_missing_locations(unit)
    fake_os = types.SimpleNamespace(getuid=lambda: 1000)
    namespace = {
        "expected_identity": (11, 22),
        "os": fake_os,
        "stat": stat,
    }
    exec(compile(unit, "<secure-reader-predicate>", "exec"), namespace)
    return namespace["safe_metadata"]


def manifest_validator(source):
    module = ast.parse(source)
    function = next(
        node
        for node in module.body
        if isinstance(node, ast.FunctionDef) and node.name == "validated_manifest"
    )
    unit = ast.Module(body=[function], type_ignores=[])
    ast.fix_missing_locations(unit)
    namespace = {}
    exec(compile(unit, "<secure-manifest-validator>", "exec"), namespace)
    return namespace["validated_manifest"]


def accepts(source):
    try:
        flag_names, assignment_line, module = assigned_flag_names(source)
        predicate = metadata_predicate(source)
        validate_manifest = manifest_validator(source)
    except (StopIteration, SyntaxError):
        return False
    open_calls = [
        node
        for node in ast.walk(module)
        if isinstance(node, ast.Call)
        and isinstance(node.func, ast.Attribute)
        and isinstance(node.func.value, ast.Name)
        and node.func.value.id == "os"
        and node.func.attr == "open"
        and len(node.args) >= 2
        and isinstance(node.args[1], ast.Name)
        and node.args[1].id == "flags"
    ]
    if flag_names != {"O_RDONLY", "O_NOFOLLOW", "O_NONBLOCK"}:
        return False
    if not open_calls or any(call.lineno <= assignment_line for call in open_calls):
        return False
    valid = types.SimpleNamespace(
        st_mode=stat.S_IFREG | 0o600,
        st_uid=1000,
        st_nlink=1,
        st_dev=11,
        st_ino=22,
    )
    invalid = (
        types.SimpleNamespace(**{**vars(valid), "st_mode": stat.S_IFCHR | 0o600}),
        types.SimpleNamespace(**{**vars(valid), "st_uid": 1001}),
        types.SimpleNamespace(**{**vars(valid), "st_mode": stat.S_IFREG | 0o644}),
        types.SimpleNamespace(**{**vars(valid), "st_nlink": 2}),
        types.SimpleNamespace(**{**vars(valid), "st_ino": 23}),
    )
    if not predicate(valid) or any(predicate(candidate) for candidate in invalid):
        return False
    valid_manifest = b"".join(
        f"managed-deadline-stop-channel-case-ok:fixture-{index:02d}\n".encode("ascii")
        for index in range(33)
    ) + b"managed-deadline-stop-channel-linux-tests-ok\n"
    if validate_manifest(valid_manifest) != valid_manifest:
        return False
    invalid_manifests = (
        valid_manifest.replace(b"fixture-32\n", b"fixture-31\n", 1),
        valid_manifest.split(b"\n", 1)[1],
        valid_manifest.replace(
            b"managed-deadline-stop-channel-linux-tests-ok\n",
            b"wrong-sentinel\n",
        ),
        valid_manifest + b"extra\n",
    )
    for candidate in invalid_manifests:
        try:
            validate_manifest(candidate)
        except SystemExit:
            continue
        return False
    return True


if not accepts(reader_source):
    raise SystemExit("secure reader flags or metadata predicate are semantically unsafe")

mutations = (
    (
        "nonblocking open",
        "flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK",
        "flags = os.O_RDONLY | os.O_NOFOLLOW\nif False:\n    _ = os.O_NONBLOCK",
    ),
    (
        "regular file",
        "not stat.S_ISREG(metadata.st_mode)",
        "(False and not stat.S_ISREG(metadata.st_mode))",
    ),
    (
        "same uid",
        "metadata.st_uid != os.getuid()",
        "(False and metadata.st_uid != os.getuid())",
    ),
    (
        "mode 0600",
        "stat.S_IMODE(metadata.st_mode) != 0o600",
        "(False and stat.S_IMODE(metadata.st_mode) != 0o600)",
    ),
    (
        "single link",
        "metadata.st_nlink != 1",
        "(False and metadata.st_nlink != 1)",
    ),
    (
        "retained identity",
        "(metadata.st_dev, metadata.st_ino) != expected_identity",
        "(False and (metadata.st_dev, metadata.st_ino) != expected_identity)",
    ),
    (
        "manifest line count",
        "if len(lines) != 34:",
        "if False and len(lines) != 34:",
    ),
    (
        "manifest case uniqueness",
        "or len(set(cases)) != 33",
        "or (False and len(set(cases)) != 33)",
    ),
    (
        "manifest final sentinel",
        'or lines[33] != b"managed-deadline-stop-channel-linux-tests-ok"',
        'or (False and lines[33] != b"managed-deadline-stop-channel-linux-tests-ok")',
    ),
)
for label, needle, replacement in mutations:
    if reader_source.count(needle) != 1:
        raise SystemExit(f"semantic mutation expected one {label} site")
    mutated = reader_source.replace(needle, replacement, 1)
    if accepts(mutated):
        raise SystemExit(f"semantic dead-code mutation survived: {label}")

runtime_section = document.split(
    'stop_channel_output="$work/stop-channel.output"', 1
)[1].split('real_controller_stop_reached=', 1)[0]
if not (
    '"$STOP_CHANNEL_OUTPUT_IDENTITY" manifest' in runtime_section
    and 'grep ' not in runtime_section
    and 'tail ' not in runtime_section
    and 'sort ' not in runtime_section
):
    raise SystemExit(
        "native success manifest is not validated through one descriptor-anchored read"
    )
PY
grep -Fq 'stop-channel-opath-failure-preserves-ambiguity' "$stop_channel_gate" \
  && grep -Fq 'stop-opath-failure' "$stop_channel_gate" \
  && grep -Fq 'stop-opath-failure' "$helper" \
  || fail "managed-deadline O_PATH acquisition failure is not behaviorally covered"
for recovery_case in stop-channel-control-recovery-mode \
  stop-channel-control-recovery-hardlink; do
  grep -Fq "$recovery_case" "$stop_channel_gate" \
    || fail "managed-deadline Linux gate omits $recovery_case"
done
for recovery_fault in control-recovery-mode-failure \
  control-recovery-hardlink-failure; do
  grep -Fq "$recovery_fault" "$helper" \
    && grep -Fq "$recovery_fault" "$stop_channel_gate" \
    || fail "managed-deadline publication recovery omits $recovery_fault"
done
for deadline_fault in supervisor-endpoint-post-unlink-expiry \
  supervisor-control-post-unlink-expiry; do
  grep -Fq "$deadline_fault" "$helper" \
    && grep -Fq "$deadline_fault" "$stop_channel_gate" \
    || fail "managed-deadline retained-link proof omits $deadline_fault"
done
node - "$helper" <<'JS' \
  || fail "managed-deadline endpoint setup can unlink without a retained O_PATH identity"
const fs = require('node:fs');
const body = fs.readFileSync(process.argv[2], 'utf8')
  .split('def create_stop_channel(', 2)[1]
  .split('\ndef close_pending_stop_peer(', 1)[0];
const bind = body.indexOf('listener.bind(');
const retainedOpen = body.indexOf('os.open(', bind);
const unsafeFallback = body.indexOf('elif bound:');
if (!(bind >= 0 && retainedOpen > bind && unsafeFallback < 0)) {
  process.exit(1);
}
JS
node - "$publication_test" <<'JS' \
  || fail "real managed-deadline publication tests route stop requests through the fake adapter"
const fs = require('node:fs');
const body = fs.readFileSync(process.argv[2], 'utf8')
  .split("cat >\"$work/bin/python3\" <<'EOF'", 2)[1]
  .split('\nEOF', 1)[0];
const requestBranch = body.indexOf('if [[ "${1:-}" == --request-stop ]]');
const realRequest = body.indexOf(
  'TEST_USE_REAL_MANAGED_DEADLINE:-0', requestBranch
);
const realExec = body.indexOf(
  'exec /usr/bin/python3 "$helper_path" "$@"', realRequest
);
const fakeRequestFile = body.indexOf('$helper_control_file.request', requestBranch);
if (!(requestBranch >= 0 && realRequest > requestBranch
    && realExec > realRequest && realExec < fakeRequestFile)) {
  process.exit(1);
}
JS
grep -Fq 'run_stop_channel_gate "$stop_channel_gate" "$helper"' "$linux_gate" \
  && grep -Fq 'managed-deadline-stop-channel-linux-tests-ok' "$linux_gate" \
  && grep -Fq 'managed-deadline-stop-channel-case-ok:' "$linux_gate" \
  && grep -Fq '"$STOP_CHANNEL_OUTPUT_IDENTITY" manifest' "$linux_gate" \
  && grep -Fq 'EXECUTED_STOP_CASES != list(EXPECTED_STOP_CASES)' "$stop_channel_gate" \
  || fail "managed-deadline Linux gate does not prove complete native acceptance"
for setup_fault in stop-bind-failure stop-chmod-failure stop-lstat-failure \
  stop-listen-failure control-write-failure control-fsync-failure \
  control-fchmod-failure control-fstat-failure control-link-late-failure; do
  grep -Fq "$setup_fault" "$helper" \
    && grep -Fq "$setup_fault" "$stop_channel_gate" \
    || fail "managed-deadline setup cleanup omits $setup_fault"
done
grep -Fq 'pipe_count="${line//[!|]/}"' "$controller" \
  && grep -Fq '(${#pipe_count} == 7)' "$controller" \
  || fail "Docker event parser does not require exactly eight fields"
grep -Fq 'strict-event-record' "$publication_test" \
  || fail "strict event-record regression is not registered"

if grep -R -n -E 'MANAGED_DEADLINE_TEST(ING|_FAULT|_RECORD)' \
  "$repo_root/infra/systemd" "$repo_root/infra/env" >/dev/null 2>&1; then
  fail "managed-deadline test hook leaked into deployed systemd/env files"
fi

if [[ "$(uname -s)" != Linux || ! -r /proc/self/stat ]]; then
  skip_output="$repo_root/.managed-deadline-skip.$BASHPID"
  skip_status=0
  bash "$linux_gate" >"$skip_output" 2>&1 || skip_status=$?
  [[ "$skip_status" == 77 ]] \
    || fail "non-Linux managed-deadline gate did not return skip 77"
  grep -Fq 'SKIP: managed-deadline acceptance requires Linux /proc' "$skip_output" \
    || fail "non-Linux managed-deadline gate omitted its explicit skip diagnostic"
  if grep -Fq 'managed-deadline-linux-tests-ok' "$skip_output"; then
    fail "non-Linux managed-deadline gate printed an OK sentinel"
  fi
  rm -f -- "$skip_output"
fi

echo "managed-deadline-registration-tests-ok"
