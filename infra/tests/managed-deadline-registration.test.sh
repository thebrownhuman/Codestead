#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
workflow="$repo_root/.github/workflows/ci.yml"
linux_gate="$repo_root/infra/tests/managed-deadline-linux.test.sh"
stop_channel_gate="$repo_root/infra/tests/managed-deadline-stop-channel-linux.py"
helper="$repo_root/scripts/backup/run-managed-deadline.py"
controller="$repo_root/scripts/backup/backup.sh"
publication_test="$repo_root/infra/tests/backup-publication.test.sh"

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
grep -Fq 'python3 "$stop_channel_gate" "$helper"' "$linux_gate" \
  && grep -Fq 'managed-deadline-stop-channel-linux-tests-ok' "$linux_gate" \
  && grep -Fq 'managed-deadline-stop-channel-case-ok:' "$linux_gate" \
  && grep -Fq 'stop_channel_unique_count' "$linux_gate" \
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
