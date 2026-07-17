#!/usr/bin/env python3
"""Native Linux acceptance tests for the managed-deadline stop capability."""

from __future__ import annotations

import os
import secrets
import shutil
import signal
import socket
import stat
import subprocess
import sys
import tempfile
import time
from pathlib import Path


if len(sys.argv) != 2:
    raise SystemExit("usage: managed-deadline-stop-channel-linux.py HELPER")
if not sys.platform.startswith("linux") or not Path("/proc/self/stat").is_file():
    raise SystemExit("native stop-channel tests require Linux /proc")

HELPER = Path(sys.argv[1]).resolve()
PYTHON = sys.executable
WAIT_SECONDS = 15.0
EXPECTED_STOP_CASES = (
    "stop-channel-normal",
    "stop-channel-term-ignoring",
    "stop-channel-lingering-descendant",
    "stop-channel-replacement",
    "stop-channel-connect-replacement-race",
    "stop-channel-requester-death",
    "stop-channel-wrong-nonce",
    "stop-channel-wrong-uid",
    "stop-channel-post-reap",
    "stop-channel-post-auth-control-hardlink",
    "stop-channel-post-auth-endpoint-hardlink",
    "stop-channel-post-auth-control-mode",
    "stop-channel-post-auth-endpoint-mode",
    "stop-channel-external-term-no-ack",
    "stop-channel-stale-pid-namespace-decoy",
    "stop-channel-ack-without-eof",
    "stop-channel-slow-peer-bound",
    "stop-channel-partial-ack",
    "stop-channel-oversize-ack",
    "stop-channel-late-clean-ack",
    "stop-channel-cleanup-no-ack",
    "stop-channel-setup-failure-cleanup",
    "stop-channel-opath-failure-preserves-ambiguity",
    "stop-channel-control-recovery-mode",
    "stop-channel-control-recovery-hardlink",
    "stop-channel-control-fifo-bound",
    "stop-channel-grace-budget",
    "stop-channel-server-deadline-within",
    "stop-channel-server-deadline-exhausted",
    "stop-channel-inherited-short-deadline",
    "stop-channel-endpoint-post-unlink-expiry",
    "stop-channel-control-post-unlink-expiry",
    "stop-channel-overlong-path",
)
EXECUTED_STOP_CASES: list[str] = []


def fail(message: str) -> "NoReturn":
    raise SystemExit(message)


def run_case(label: str, operation, *arguments) -> None:
    operation(*arguments)
    EXECUTED_STOP_CASES.append(label)


def proc_identity(pid: int) -> tuple[int, int, int]:
    raw = Path(f"/proc/{pid}/stat").read_text(encoding="ascii")
    fields = raw[raw.rfind(")") + 2 :].split()
    return pid, int(fields[2]), int(fields[19])


def wait_for(predicate, message: str, timeout: float = WAIT_SECONDS) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.01)
    fail(message)


def wait_process(process: subprocess.Popen[bytes], label: str) -> int:
    try:
        return process.wait(timeout=WAIT_SECONDS)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=5)
        fail(f"{label}: process did not exit inside the test bound")


def parse_control(path: Path) -> tuple[int, int, int, int, Path, str]:
    metadata = path.lstat()
    if (
        not stat.S_ISREG(metadata.st_mode)
        or stat.S_IMODE(metadata.st_mode) != 0o600
        or metadata.st_uid != os.getuid()
        or metadata.st_nlink != 1
    ):
        fail("managed control is not a mode-0600 regular file")
    payload = path.read_bytes()
    if not payload.endswith(b"\n") or payload.count(b"\n") != 1 or len(payload) > 512:
        fail("managed control is not one bounded newline-terminated record")
    fields = payload[:-1].decode("ascii").split("|")
    if len(fields) != 7 or fields[0] != "v1":
        fail("managed control version or field count is invalid")
    supervisor_pid, supervisor_start, guardian_pgid, guardian_start = (
        int(value) for value in fields[1:5]
    )
    endpoint_name, nonce = fields[5:]
    if (
        min(supervisor_pid, supervisor_start, guardian_pgid, guardian_start) <= 0
        or not endpoint_name
        or endpoint_name in {".", ".."}
        or "/" in endpoint_name
        or len(nonce) != 64
        or any(character not in "0123456789abcdef" for character in nonce)
    ):
        fail("managed control capability fields are invalid")
    endpoint = path.parent / endpoint_name
    endpoint_metadata = endpoint.lstat()
    if (
        not stat.S_ISSOCK(endpoint_metadata.st_mode)
        or stat.S_IMODE(endpoint_metadata.st_mode) != 0o600
        or endpoint_metadata.st_uid != os.getuid()
        or endpoint_metadata.st_nlink != 1
    ):
        fail("managed stop endpoint is not a same-UID mode-0600 socket")
    if not (
        endpoint_name.startswith(".managed-deadline-stop-")
        and endpoint_name.endswith(".sock")
        and len(endpoint_name) == len(".managed-deadline-stop-") + 32 + 5
    ):
        fail("managed stop endpoint name is not exact")
    live_supervisor = proc_identity(supervisor_pid)
    live_guardian = proc_identity(guardian_pgid)
    if (
        live_supervisor[2] != supervisor_start
        or live_guardian[1] != guardian_pgid
        or live_guardian[2] != guardian_start
    ):
        fail("managed control supervisor or retained guardian identity is stale")
    return (
        supervisor_pid,
        supervisor_start,
        guardian_pgid,
        guardian_start,
        endpoint,
        nonce,
    )


def request_stop(
    control: Path,
    request_timeout: float | None = None,
    expected: tuple[int, int, int, int] | None = None,
) -> subprocess.CompletedProcess[bytes]:
    if expected is None:
        metadata = control.lstat()
        fields = control.read_text(encoding="ascii").rstrip("\n").split("|")
        expected = (
            metadata.st_dev,
            metadata.st_ino,
            int(fields[1]),
            int(fields[2]),
        )
    command = [PYTHON, os.fspath(HELPER), "--request-stop", os.fspath(control)]
    command.extend(
        [
            "--expected-control-device",
            str(expected[0]),
            "--expected-control-inode",
            str(expected[1]),
            "--expected-supervisor-pid",
            str(expected[2]),
            "--expected-supervisor-start",
            str(expected[3]),
        ]
    )
    if request_timeout is not None:
        command.extend(["--request-timeout", str(request_timeout)])
    return subprocess.run(
        command,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
        timeout=WAIT_SECONDS,
    )


def launch(
    root: Path,
    label: str,
    mode: str,
    *,
    hook: str = "",
    grace: float = 0.20,
) -> tuple[subprocess.Popen[bytes], Path, Path, Path, Path, tuple[int, int, int, int, Path, str]]:
    control = root / f"{label}.control"
    identities = root / f"{label}.identities"
    ready = root / f"{label}.ready"
    term_marker = root / f"{label}.term"
    hook_record = root / f"{label}.hook"
    environment = os.environ.copy()
    if hook:
        environment.update(
            MANAGED_DEADLINE_TESTING="1",
            MANAGED_DEADLINE_TEST_FAULT=hook,
            MANAGED_DEADLINE_TEST_RECORD=os.fspath(hook_record),
        )
    process = subprocess.Popen(
        [
            PYTHON,
            os.fspath(HELPER),
            "--expected-parent-pid",
            str(os.getpid()),
            "--control-file",
            os.fspath(control),
            "30",
            str(grace),
            "--",
            PYTHON,
            os.fspath(root / "managed-command.py"),
            mode,
            os.fspath(identities),
            os.fspath(ready),
            os.fspath(term_marker),
        ],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=environment,
    )

    def launched() -> bool:
        if process.poll() is not None:
            stdout, stderr = process.communicate()
            fail(
                f"{label}: supervisor exited before readiness ({process.returncode}): "
                f"{stdout!r} {stderr!r}"
            )
        return control.is_file() and ready.is_file() and identities.is_file()

    wait_for(launched, f"{label}: supervisor omitted control/command readiness")
    details = parse_control(control)
    if details[0] != process.pid:
        fail(f"{label}: control supervisor PID does not match the launched child")
    return process, control, identities, ready, term_marker, details


def assert_identities_absent(identity_path: Path, label: str) -> None:
    records = [
        tuple(int(value) for value in line.split("|"))
        for line in identity_path.read_text(encoding="ascii").splitlines()
        if line
    ]
    for pid, _pgid, start in records:
        try:
            _live_pid, _live_pgid, live_start = proc_identity(pid)
        except FileNotFoundError:
            continue
        if live_start == start:
            fail(f"{label}: retained process identity {pid}:{start}")
    for _pid, pgid, _start in records:
        for entry in Path("/proc").iterdir():
            if not entry.name.isdecimal():
                continue
            try:
                _candidate, live_pgid, live_start = proc_identity(int(entry.name))
            except FileNotFoundError:
                continue
            if live_pgid == pgid:
                fail(
                    f"{label}: retained PGID {pgid} member "
                    f"{entry.name}:{live_start}"
                )


def assert_guardian_identity_absent(
    pid: int, pgid: int, start: int, label: str
) -> None:
    try:
        _live_pid, _live_pgid, live_start = proc_identity(pid)
    except FileNotFoundError:
        pass
    else:
        if live_start == start:
            fail(f"{label}: setup guardian identity {pid}:{start} survived")
    for entry in Path("/proc").iterdir():
        if not entry.name.isdecimal():
            continue
        try:
            _candidate, live_pgid, live_start = proc_identity(int(entry.name))
        except FileNotFoundError:
            continue
        if live_pgid == pgid:
            fail(
                f"{label}: setup guardian PGID {pgid} retained "
                f"{entry.name}:{live_start}"
            )


def assert_stop_complete(
    process: subprocess.Popen[bytes],
    control: Path,
    identities: Path,
    endpoint: Path,
    label: str,
) -> None:
    status = wait_process(process, label)
    if status != 143:
        _stdout, stderr = process.communicate()
        fail(f"{label}: supervisor status was {status}, stderr={stderr!r}")
    if control.exists() or control.is_symlink() or endpoint.exists() or endpoint.is_symlink():
        fail(f"{label}: supervisor retained stop capability metadata")
    assert_identities_absent(identities, label)


def run_basic_stop_case(root: Path, label: str, mode: str) -> None:
    process, control, identities, _ready, _term, details = launch(root, label, mode)
    response = request_stop(control)
    if response.returncode != 0 or response.stdout:
        fail(
            f"{label}: stop requester failed ({response.returncode}): "
            f"{response.stdout!r} {response.stderr!r}"
        )
    assert_stop_complete(process, control, identities, details[4], label)


def run_endpoint_replacement_case(root: Path) -> None:
    label = "stop-channel-replacement"
    process, control, identities, _ready, _term, details = launch(
        root, label, "ignore"
    )
    endpoint = details[4]
    saved_endpoint = endpoint.with_name(f"{endpoint.name}.owned")
    endpoint.rename(saved_endpoint)
    decoy_ready = root / f"{label}.decoy-ready"
    decoy_received = root / f"{label}.decoy-received"
    decoy = subprocess.Popen(
        [
            PYTHON,
            os.fspath(root / "decoy-server.py"),
            os.fspath(endpoint),
            os.fspath(decoy_ready),
            os.fspath(decoy_received),
        ],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    try:
        wait_for(
            lambda: decoy_ready.is_file() and endpoint.exists(),
            f"{label}: decoy endpoint did not become ready",
        )
        rejected = request_stop(control)
        if rejected.returncode == 0:
            fail(f"{label}: requester trusted a replaced endpoint")
        wait_for(
            decoy_received.is_file,
            f"{label}: replacement decoy omitted its receive observation",
        )
        if decoy_received.read_bytes() != b"EMPTY\n":
            fail(f"{label}: requester leaked authenticated payload to a decoy")
        if decoy.poll() is not None:
            fail(f"{label}: replaced-endpoint decoy did not remain alive")
        if process.poll() is not None:
            fail(f"{label}: replacement failure stopped the real supervisor")
    finally:
        decoy.terminate()
        wait_process(decoy, f"{label}-decoy")
        if endpoint.exists() or endpoint.is_symlink():
            endpoint.unlink()
        saved_endpoint.rename(endpoint)
    accepted = request_stop(control)
    if accepted.returncode != 0:
        fail(f"{label}: restored owned endpoint did not stop the supervisor")
    assert_stop_complete(process, control, identities, endpoint, label)


def run_connect_replacement_race_case(root: Path) -> None:
    label = "stop-channel-connect-replacement-race"
    process, control, identities, _ready, _term, details = launch(
        root, label, "ignore"
    )
    endpoint = details[4]
    barrier = root / f"{label}.barrier"
    environment = os.environ.copy()
    environment.update(
        MANAGED_DEADLINE_TESTING="1",
        MANAGED_DEADLINE_TEST_FAULT="request-after-connect-pause",
        MANAGED_DEADLINE_TEST_RECORD=os.fspath(barrier),
    )
    requester = subprocess.Popen(
        [
            PYTHON,
            os.fspath(HELPER),
            "--request-stop",
            os.fspath(control),
            "--request-timeout",
            "3",
        ],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=environment,
    )
    wait_for(
        barrier.is_file,
        f"{label}: requester omitted the guarded post-connect barrier",
    )
    saved_endpoint = endpoint.with_name(f"{endpoint.name}.owned")
    endpoint.rename(saved_endpoint)
    decoy = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    decoy.bind(os.fspath(endpoint))
    os.chmod(endpoint, 0o600)
    decoy.listen(1)
    try:
        requester_status = wait_process(requester, f"{label}-requester")
        if requester_status == 0:
            fail(f"{label}: requester accepted a post-connect endpoint replacement")
        if process.poll() is not None:
            fail(f"{label}: rejected replacement stopped the real supervisor")
    finally:
        decoy.close()
        endpoint.unlink(missing_ok=True)
        saved_endpoint.rename(endpoint)
    accepted = request_stop(control)
    if accepted.returncode != 0:
        fail(f"{label}: restored endpoint did not accept a valid stop")
    assert_stop_complete(process, control, identities, endpoint, label)


def run_requester_death_case(root: Path) -> None:
    label = "stop-channel-requester-death"
    process, control, identities, _ready, term_marker, details = launch(
        root, label, "mark-and-ignore", hook="supervisor-post-auth-pause"
    )
    hook_record = root / f"{label}.hook"
    requester = subprocess.Popen(
        [PYTHON, os.fspath(HELPER), "--request-stop", os.fspath(control)],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    wait_for(
        hook_record.is_file,
        f"{label}: supervisor omitted the guarded post-auth requester-death barrier",
    )
    if requester.poll() is not None:
        fail(f"{label}: requester exited before the post-auth death injection")
    requester.kill()
    requester_status = wait_process(requester, f"{label}-requester")
    if requester_status == 0:
        fail(f"{label}: killed requester reported a successful acknowledgement")
    wait_for(term_marker.is_file, f"{label}: authenticated stop did not reach TERM")
    assert_stop_complete(process, control, identities, details[4], label)


def run_wrong_nonce_case(root: Path) -> None:
    label = "stop-channel-wrong-nonce"
    process, control, identities, _ready, _term, details = launch(
        root, label, "ignore"
    )
    client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    client.settimeout(2)
    client.connect(os.fspath(details[4]))
    wrong_nonce = "0" * 64 if details[5] != "0" * 64 else "f" * 64
    request_deadline = time.monotonic_ns() + 2_000_000_000
    client.sendall(f"STOP {wrong_nonce} {request_deadline}\n".encode("ascii"))
    try:
        response = client.recv(512)
    except TimeoutError:
        fail(f"{label}: supervisor left an unauthenticated peer open")
    finally:
        client.close()
    if response:
        fail(f"{label}: supervisor acknowledged an invalid nonce")
    if process.poll() is not None:
        fail(f"{label}: invalid nonce stopped the supervisor")
    accepted = request_stop(control)
    if accepted.returncode != 0:
        fail(f"{label}: valid request failed after nonce rejection")
    assert_stop_complete(process, control, identities, details[4], label)


def run_wrong_uid_case(root: Path) -> None:
    label = "stop-channel-wrong-uid"
    process, control, identities, _ready, _term, details = launch(
        root, label, "ignore"
    )
    connector = (
        "import os,socket,sys;"
        "s=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);"
        "s.settimeout(2);s.connect(sys.argv[1]);"
        "s.sendall(sys.argv[2].encode('ascii'));"
        "data=s.recv(512);"
        "sys.stdout.write('NOACK\\n' if data == b'' else data.hex()+'\\n')"
    )
    root.chmod(0o711)
    os.chmod(details[4], 0o666)
    if os.geteuid() == 0 and shutil.which("runuser") is not None:
        command = ["runuser", "-u", "nobody", "--", PYTHON, "-c", connector]
    elif shutil.which("sudo") is not None:
        command = ["sudo", "-n", "-u", "nobody", PYTHON, "-c", connector]
    else:
        fail(f"{label}: neither root/runuser nor passwordless sudo is available")
    request_deadline = time.monotonic_ns() + 5_000_000_000
    command.extend(
        [os.fspath(details[4]), f"STOP {details[5]} {request_deadline}\n"]
    )
    rejected = subprocess.run(
        command,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
        timeout=5,
    )
    os.chmod(details[4], 0o600)
    root.chmod(0o700)
    if rejected.returncode != 0 or rejected.stdout != b"NOACK\n":
        fail(
            f"{label}: raw cross-UID peer was not rejected by server credentials "
            f"({rejected.returncode}, {rejected.stdout!r}, {rejected.stderr!r})"
        )
    if process.poll() is not None:
        fail(f"{label}: cross-UID request stopped the supervisor")
    accepted = request_stop(control)
    if accepted.returncode != 0:
        fail(f"{label}: valid same-UID request failed after rejection")
    assert_stop_complete(process, control, identities, details[4], label)


def run_post_reap_case(root: Path) -> None:
    label = "stop-channel-post-reap"
    process, control, identities, _ready, _term, details = launch(
        root, label, "ignore", hook="supervisor-post-reap-pause"
    )
    hook_record = root / f"{label}.hook"
    signal_proof = hook_record.with_suffix(".signal-proof")
    requester = subprocess.Popen(
        [PYTHON, os.fspath(HELPER), "--request-stop", os.fspath(control)],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    wait_for(
        hook_record.is_file,
        f"{label}: supervisor did not expose the guarded post-reap window",
    )
    try:
        proc_identity(details[2])
    except FileNotFoundError:
        pass
    else:
        fail(f"{label}: guardian remained visible at the post-reap hook")
    os.kill(process.pid, signal.SIGTERM)
    requester_status = wait_process(requester, f"{label}-requester")
    if requester_status != 0:
        _stdout, stderr = requester.communicate()
        fail(f"{label}: post-reap interruption broke ACK: {stderr!r}")
    if not signal_proof.is_file():
        fail(f"{label}: guarded signal primitive omitted its zero-attempt proof")
    assert_stop_complete(process, control, identities, details[4], label)


def run_post_auth_metadata_mutation_case(
    root: Path, label: str, target: str, mutation: str
) -> None:
    process, control, identities, _ready, _term, details = launch(
        root, label, "ignore", hook="supervisor-post-auth-pause"
    )
    hook_record = root / f"{label}.hook"
    requester = subprocess.Popen(
        [PYTHON, os.fspath(HELPER), "--request-stop", os.fspath(control)],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    wait_for(
        hook_record.is_file,
        f"{label}: supervisor omitted the guarded post-auth barrier",
    )
    target_path = control if target == "control" else details[4]
    alias = target_path.with_name(f"{target_path.name}.alias")
    if mutation == "hardlink":
        os.link(target_path, alias)
    elif mutation == "mode":
        os.chmod(target_path, 0o640)
    else:
        fail(f"{label}: unknown mutation")
    requester_status = wait_process(requester, f"{label}-requester")
    if requester_status == 0:
        fail(f"{label}: requester accepted insecure post-auth metadata")
    supervisor_status = wait_process(process, label)
    if supervisor_status != 125:
        fail(f"{label}: metadata mutation returned {supervisor_status}, not 125")
    assert_identities_absent(identities, label)
    if not target_path.exists() or (mutation == "hardlink" and not alias.exists()):
        fail(f"{label}: cleanup removed an ambiguous hard-link alias")
    for path in (alias, control, details[4]):
        path.unlink(missing_ok=True)


def run_external_term_no_ack_case(root: Path) -> None:
    label = "stop-channel-external-term-no-ack"
    process, control, identities, _ready, _term, details = launch(
        root, label, "ignore"
    )
    peer = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    peer.settimeout(5)
    peer.connect(os.fspath(details[4]))
    peer.sendall(b"STOP ")
    os.kill(process.pid, signal.SIGTERM)
    response = bytearray()
    while True:
        chunk = peer.recv(128)
        if not chunk:
            break
        response.extend(chunk)
    peer.close()
    if response:
        fail(f"{label}: external TERM produced a stop acknowledgement")
    status = wait_process(process, label)
    if status != 143:
        fail(f"{label}: external TERM returned {status}, not 143")
    if control.exists() or details[4].exists():
        fail(f"{label}: external TERM retained owned stop metadata")
    assert_identities_absent(identities, label)


def run_setup_failure_cleanup_case(root: Path) -> None:
    label = "stop-channel-setup-failure-cleanup"
    faults = (
        "stop-bind-failure",
        "stop-chmod-failure",
        "stop-lstat-failure",
        "stop-listen-failure",
        "control-write-failure",
        "control-fsync-failure",
        "control-fchmod-failure",
        "control-fstat-failure",
        "control-link-late-failure",
    )
    for fault in faults:
        case_root = root / fault
        case_root.mkdir(mode=0o700)
        control = case_root / "monitor.control"
        effect = case_root / "command.effect"
        environment = os.environ.copy()
        environment.update(
            MANAGED_DEADLINE_TESTING="1",
            MANAGED_DEADLINE_TEST_FAULT=fault,
            MANAGED_DEADLINE_TEST_RECORD=os.fspath(case_root / "hook.record"),
        )
        result = subprocess.run(
            [
                PYTHON,
                os.fspath(HELPER),
                "--expected-parent-pid",
                str(os.getpid()),
                "--control-file",
                os.fspath(control),
                "5",
                "0.20",
                "--",
                "/bin/sh",
                "-c",
                'printf effect >"$1"',
                "_",
                os.fspath(effect),
            ],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=environment,
            check=False,
            timeout=WAIT_SECONDS,
        )
        leftovers = [
            path
            for path in case_root.iterdir()
            if path.name not in {"hook.record"}
        ]
        if result.returncode != 125 or effect.exists() or leftovers:
            fail(
                f"{label}: {fault} leaked an artifact or reached GO "
                f"({result.returncode}, {[path.name for path in leftovers]}, "
                f"{result.stderr!r})"
            )
        record = case_root / "hook.record"
        if not record.is_file():
            fail(f"{label}: {fault} did not prove exact fault-stage reach")
        fields = record.read_text(encoding="ascii").rstrip("\n").split("|")
        if (
            len(fields) != 4
            or fields[0] != fault
            or any(not value.isdecimal() or int(value) <= 0 for value in fields[1:])
        ):
            fail(f"{label}: {fault} emitted an invalid reach/guardian record")
        guardian_pid, guardian_pgid, guardian_start = (
            int(value) for value in fields[1:]
        )
        assert_guardian_identity_absent(
            guardian_pid, guardian_pgid, guardian_start, f"{label}-{fault}"
        )


def run_control_publication_recovery_case(
    root: Path, label: str, fault: str, mutation: str
) -> None:
    case_root = root / label
    case_root.mkdir(mode=0o700)
    control = case_root / "monitor.control"
    effect = case_root / "command.effect"
    hook_record = case_root / "hook.record"
    environment = os.environ.copy()
    environment.update(
        MANAGED_DEADLINE_TESTING="1",
        MANAGED_DEADLINE_TEST_FAULT=fault,
        MANAGED_DEADLINE_TEST_RECORD=os.fspath(hook_record),
    )
    result = subprocess.run(
        [
            PYTHON,
            os.fspath(HELPER),
            "--expected-parent-pid",
            str(os.getpid()),
            "--control-file",
            os.fspath(control),
            "5",
            "0.20",
            "--",
            "/bin/sh",
            "-c",
            'printf effect >"$1"',
            "_",
            os.fspath(effect),
        ],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=environment,
        check=False,
        timeout=WAIT_SECONDS,
    )
    temporary_controls = list(case_root.glob(".monitor.control.tmp.*"))
    owned_paths = [control, *temporary_controls]
    if mutation == "hardlink":
        owned_paths.append(hook_record)
    elif mutation == "mode":
        if not hook_record.is_file():
            fail(f"{label}: mode mutation did not prove fault-stage reach")
    else:
        fail(f"{label}: unknown recovery mutation")
    if result.returncode != 125 or effect.exists() or len(temporary_controls) != 1:
        fail(
            f"{label}: publication recovery did not fail before GO with one temp "
            f"({result.returncode}, {result.stderr!r})"
        )
    if b"cleanup was not proved" not in result.stderr:
        fail(f"{label}: unsafe publication recovery was not reported fail-closed")
    if any(not path.exists() for path in owned_paths):
        fail(f"{label}: ambiguous publication inode names were silently removed")
    control_fields = control.read_text(encoding="ascii").rstrip("\n").split("|")
    if (
        len(control_fields) != 7
        or not control_fields[3].isdecimal()
        or not control_fields[4].isdecimal()
    ):
        fail(f"{label}: preserved control omitted guardian identity")
    guardian_pgid = int(control_fields[3])
    guardian_start = int(control_fields[4])
    assert_guardian_identity_absent(
        guardian_pgid, guardian_pgid, guardian_start, label
    )
    if list(case_root.glob(".managed-deadline-stop-*.sock")):
        fail(f"{label}: publication recovery retained the owned stop endpoint")
    metadata = [path.lstat() for path in owned_paths]
    identities = {(item.st_dev, item.st_ino) for item in metadata}
    expected_links = 3 if mutation == "hardlink" else 2
    expected_mode = 0o600 if mutation == "hardlink" else 0o640
    if (
        len(identities) != 1
        or any(not stat.S_ISREG(item.st_mode) for item in metadata)
        or any(item.st_uid != os.getuid() for item in metadata)
        or any(stat.S_IMODE(item.st_mode) != expected_mode for item in metadata[:2])
        or any(item.st_nlink != expected_links for item in metadata[:2])
    ):
        fail(f"{label}: preserved publication metadata is not exact")
    for path in owned_paths:
        path.unlink(missing_ok=True)
    if mutation == "mode":
        hook_record.unlink(missing_ok=True)


def run_endpoint_opath_failure_case(root: Path) -> None:
    label = "stop-channel-opath-failure-preserves-ambiguity"
    case_root = root / label
    case_root.mkdir(mode=0o700)
    control = case_root / "monitor.control"
    effect = case_root / "command.effect"
    hook_record = case_root / "hook.record"
    environment = os.environ.copy()
    environment.update(
        MANAGED_DEADLINE_TESTING="1",
        MANAGED_DEADLINE_TEST_FAULT="stop-opath-failure",
        MANAGED_DEADLINE_TEST_RECORD=os.fspath(hook_record),
    )
    result = subprocess.run(
        [
            PYTHON,
            os.fspath(HELPER),
            "--expected-parent-pid",
            str(os.getpid()),
            "--control-file",
            os.fspath(control),
            "5",
            "0.20",
            "--",
            "/bin/sh",
            "-c",
            'printf effect >"$1"',
            "_",
            os.fspath(effect),
        ],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=environment,
        check=False,
        timeout=WAIT_SECONDS,
    )
    endpoints = list(case_root.glob(".managed-deadline-stop-*.sock"))
    if result.returncode != 125 or effect.exists() or control.exists() or len(endpoints) != 1:
        fail(
            f"{label}: O_PATH failure did not preserve exactly one pre-GO socket "
            f"({result.returncode}, {result.stderr!r})"
        )
    endpoint_metadata = endpoints[0].lstat()
    if (
        not stat.S_ISSOCK(endpoint_metadata.st_mode)
        or endpoint_metadata.st_uid != os.getuid()
        or stat.S_IMODE(endpoint_metadata.st_mode) != 0o600
        or endpoint_metadata.st_nlink != 1
    ):
        fail(f"{label}: preserved bound endpoint metadata is not exact")
    fields = hook_record.read_text(encoding="ascii").rstrip("\n").split("|")
    if len(fields) != 4 or fields[0] != "stop-opath-failure":
        fail(f"{label}: O_PATH fault omitted exact reach/guardian evidence")
    guardian_pid, guardian_pgid, guardian_start = (int(value) for value in fields[1:])
    assert_guardian_identity_absent(
        guardian_pid, guardian_pgid, guardian_start, label
    )
    endpoints[0].unlink()
    hook_record.unlink()


def run_control_fifo_bound_case(root: Path) -> None:
    label = "stop-channel-control-fifo-bound"
    control = root / f"{label}.control"
    os.mkfifo(control, 0o600)
    started = time.monotonic()
    try:
        result = subprocess.run(
            [
                PYTHON,
                os.fspath(HELPER),
                "--request-stop",
                os.fspath(control),
                "--request-timeout",
                "1",
            ],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
            timeout=3,
        )
    except subprocess.TimeoutExpired:
        fail(f"{label}: requester blocked opening a hostile FIFO")
    finally:
        control.unlink(missing_ok=True)
    if result.returncode == 0 or time.monotonic() - started > 2:
        fail(f"{label}: hostile FIFO was not rejected inside the request deadline")


def run_grace_budget_case(root: Path) -> None:
    label = "stop-channel-grace-budget"
    control = root / f"{label}.control"
    effect = root / f"{label}.effect"
    result = subprocess.run(
        [
            PYTHON,
            os.fspath(HELPER),
            "--expected-parent-pid",
            str(os.getpid()),
            "--control-file",
            os.fspath(control),
            "5",
            "16",
            "--",
            "/bin/sh",
            "-c",
            'printf effect >"$1"',
            "_",
            os.fspath(effect),
        ],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
        timeout=5,
    )
    if result.returncode == 0 or control.exists() or effect.exists():
        fail(f"{label}: oversized control grace reached publication or GO")


def run_server_deadline_case(root: Path, label: str, hook: str, succeeds: bool) -> None:
    process, control, identities, _ready, _term, details = launch(
        root, label, "ignore", hook=hook
    )
    started = time.monotonic()
    response = request_stop(control, 2)
    status = wait_process(process, label)
    elapsed = time.monotonic() - started
    if elapsed > 2.75:
        fail(f"{label}: inherited two-second deadline took {elapsed:.3f}s")
    if succeeds:
        if response.returncode != 0 or status != 143:
            fail(f"{label}: within-deadline stop failed ({response.returncode}, {status})")
        if control.exists() or details[4].exists():
            fail(f"{label}: within-deadline stop retained metadata")
    else:
        if response.returncode == 0 or status != 125:
            fail(f"{label}: exhausted deadline acknowledged ({response.returncode}, {status})")
        if control.exists() or details[4].exists():
            fail(f"{label}: expired ACK eligibility skipped owned metadata cleanup")
    assert_identities_absent(identities, label)


def run_inherited_short_deadline_case(root: Path) -> None:
    label = "stop-channel-inherited-short-deadline"
    process, control, identities, _ready, _term, details = launch(
        root,
        label,
        "ignore",
        hook="supervisor-post-auth-pause",
        grace=5.0,
    )
    started = time.monotonic()
    response = request_stop(control, 0.25)
    status = wait_process(process, label)
    elapsed = time.monotonic() - started
    if response.returncode == 0 or status != 125:
        fail(
            f"{label}: short inherited deadline was acknowledged "
            f"({response.returncode}, {status})"
        )
    if elapsed >= 1.5:
        fail(f"{label}: inherited deadline did not cap group teardown ({elapsed:.3f}s)")
    if control.exists() or details[4].exists():
        fail(f"{label}: expired stop retained owned capability metadata")
    assert_identities_absent(identities, label)


def run_post_unlink_expiry_alias_case(
    root: Path, label: str, hook: str, target_name: str
) -> None:
    process, control, identities, _ready, _term, details = launch(
        root, label, "ignore", hook=hook
    )
    endpoint = details[4]
    target = control if target_name == "control" else endpoint
    original = target.lstat()
    alias = root / f"{label}.hook"
    response = request_stop(control, 0.75)
    status = wait_process(process, label)
    _stdout, stderr = process.communicate()
    if response.returncode == 0 or status != 125:
        fail(
            f"{label}: post-unlink expiry was acknowledged "
            f"({response.returncode}, {status})"
        )
    if b"retained an alias" not in stderr:
        fail(f"{label}: retained-fd alias proof was skipped: {stderr!r}")
    if not alias.exists():
        fail(f"{label}: ambiguous post-unlink alias was silently removed")
    alias_metadata = alias.lstat()
    if (alias_metadata.st_dev, alias_metadata.st_ino) != (
        original.st_dev,
        original.st_ino,
    ):
        fail(f"{label}: preserved alias does not retain the attacked inode")
    if control.exists() or endpoint.exists():
        fail(f"{label}: owned published names survived fail-closed cleanup")
    assert_identities_absent(identities, label)
    alias.unlink()


def run_stale_namespace_decoy_case(root: Path) -> None:
    label = "stop-channel-stale-pid-namespace-decoy"
    # PID 1 is the canonical namespace-local identity.  A stale record from a
    # different namespace must not cause this namespace's unrelated PID 1 to be
    # signaled or its same-UID endpoint to be contacted.
    pid_one_before = proc_identity(1)
    endpoint = root / ".managed-deadline-stop-22222222222222222222222222222222.sock"
    control = root / f"{label}.control"
    server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    server.bind(os.fspath(endpoint))
    os.chmod(endpoint, 0o600)
    server.listen(1)
    server.settimeout(0.20)
    stale_start = pid_one_before[2] + 1
    payload = (
        f"v1|1|{stale_start}|1|{stale_start}|{endpoint.name}|"
        f"{secrets.token_hex(32)}\n"
    )
    descriptor = os.open(
        control,
        os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC | os.O_NOFOLLOW,
        0o600,
    )
    try:
        os.write(descriptor, payload.encode("ascii"))
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    try:
        rejected = request_stop(control, 2)
        if rejected.returncode == 0:
            fail(f"{label}: requester accepted stale namespace-local PID metadata")
        try:
            connection, _address = server.accept()
        except TimeoutError:
            pass
        else:
            connection.close()
            fail(f"{label}: requester contacted a stale-metadata decoy endpoint")
        if proc_identity(1) != pid_one_before:
            fail(f"{label}: unrelated PID 1 identity changed")
    finally:
        server.close()
        endpoint.unlink(missing_ok=True)
        control.unlink(missing_ok=True)


def run_fake_peer_bound_case(root: Path, label: str, mode: str) -> None:
    control = root / f"{label}.control"
    ready = root / f"{label}.ready"
    received = root / f"{label}.received"
    endpoint = root / ".managed-deadline-stop-11111111111111111111111111111111.sock"
    server = subprocess.Popen(
        [
            PYTHON,
            os.fspath(root / "fake-stop-server.py"),
            mode,
            os.fspath(control),
            os.fspath(ready),
            os.fspath(received),
        ],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    try:
        wait_for(
            lambda: ready.is_file() and control.is_file(),
            f"{label}: fake authenticated peer omitted readiness",
        )
        started = time.monotonic()
        rejected = request_stop(control, 2)
        elapsed = time.monotonic() - started
        if rejected.returncode == 0:
            fail(f"{label}: requester accepted an incomplete peer response")
        if elapsed > 2.75:
            fail(f"{label}: requester exceeded its bound ({elapsed:.3f}s)")
        if server.poll() is not None:
            fail(f"{label}: fake peer did not remain alive for the bounded check")
        if not received.is_file():
            fail(f"{label}: fake peer did not prove request receipt")
        request = received.read_bytes()
        fields = control.read_text(encoding="ascii").rstrip("\n").split("|")
        parts = request[:-1].split(b" ") if request.endswith(b"\n") else []
        if (
            len(fields) != 7
            or len(parts) != 3
            or parts[0] != b"STOP"
            or parts[1] != fields[6].encode("ascii")
            or not parts[2].isdecimal()
        ):
            fail(f"{label}: requester did not send the exact authenticated frame")
        if not control.is_file() or not endpoint.exists():
            fail(f"{label}: fake peer removed capability paths before teardown")
    finally:
        server.terminate()
        wait_process(server, f"{label}-server")
        for path in (
            control,
            endpoint,
        ):
            path.unlink(missing_ok=True)


def run_late_clean_ack_case(root: Path) -> None:
    label = "stop-channel-late-clean-ack"
    control = root / f"{label}.control"
    ready = root / f"{label}.ready"
    barrier = root / f"{label}.barrier"
    received = root / f"{label}.received"
    server = subprocess.Popen(
        [
            PYTHON,
            os.fspath(root / "fake-stop-server.py"),
            "late-clean-ack",
            os.fspath(control),
            os.fspath(ready),
            os.fspath(received),
        ],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    try:
        wait_for(
            lambda: ready.is_file() and control.is_file(),
            f"{label}: fake authenticated peer omitted readiness",
        )
        environment = os.environ.copy()
        environment.update(
            MANAGED_DEADLINE_TESTING="1",
            MANAGED_DEADLINE_TEST_FAULT="request-after-ack-pause",
            MANAGED_DEADLINE_TEST_RECORD=os.fspath(barrier),
        )
        started = time.monotonic()
        requester = subprocess.run(
            [
                PYTHON,
                os.fspath(HELPER),
                "--request-stop",
                os.fspath(control),
                "--request-timeout",
                "0.30",
            ],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=environment,
            check=False,
            timeout=3,
        )
        elapsed = time.monotonic() - started
        if elapsed > 1.05:
            fail(f"{label}: 0.30s ACK/absence deadline took {elapsed:.3f}s")
        if not barrier.is_file():
            fail(f"{label}: requester omitted the guarded post-ACK barrier")
        if not received.is_file():
            fail(f"{label}: fake authenticated peer omitted request receipt")
        if requester.returncode == 0:
            fail(f"{label}: requester extended its deadline for absence proofs")
    finally:
        server.terminate()
        wait_process(server, f"{label}-server")
        for path in (
            control,
            root / ".managed-deadline-stop-11111111111111111111111111111111.sock",
        ):
            path.unlink(missing_ok=True)


def run_cleanup_no_ack_case(root: Path) -> None:
    label = "stop-channel-cleanup-no-ack"
    process, control, identities, _ready, _term, details = launch(
        root, label, "ignore"
    )
    owned_control = control.with_name(f"{control.name}.owned")
    payload = control.read_bytes()
    control.rename(owned_control)
    descriptor = os.open(
        control,
        os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC | os.O_NOFOLLOW,
        0o600,
    )
    try:
        os.write(descriptor, payload)
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    rejected = request_stop(control, 2)
    if rejected.returncode == 0:
        fail(f"{label}: requester accepted ACK despite control cleanup failure")
    wait_for(
        lambda: all(
            not Path(f"/proc/{line.split('|', 1)[0]}").exists()
            for line in identities.read_text(encoding="ascii").splitlines()
            if line
        ),
        f"{label}: cleanup failure did not drain the managed group",
    )
    supervisor_status = wait_process(process, label)
    if supervisor_status != 125:
        fail(f"{label}: post-reap cleanup failure returned {supervisor_status}, not 125")
    if not control.is_file() or not owned_control.is_file():
        fail(f"{label}: ambiguous control identities were not preserved")
    if details[4].exists() or details[4].is_symlink():
        fail(f"{label}: owned endpoint remained after successful endpoint cleanup")
    control.unlink(missing_ok=True)
    owned_control.unlink(missing_ok=True)
    details[4].unlink(missing_ok=True)
    assert_identities_absent(identities, label)


def run_overlong_path_case(root: Path) -> None:
    label = "stop-channel-overlong-path"
    long_parent = root
    while len(os.fsencode(long_parent)) < 100:
        long_parent /= "path-segment-0123456789"
    long_parent.mkdir(parents=True)
    control = long_parent / "monitor.control"
    effect = root / f"{label}.effect"
    process = subprocess.run(
        [
            PYTHON,
            os.fspath(HELPER),
            "--expected-parent-pid",
            str(os.getpid()),
            "--control-file",
            os.fspath(control),
            "5",
            "0.20",
            "--",
            "/bin/sh",
            "-c",
            'printf effect >"$1"',
            "_",
            os.fspath(effect),
        ],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
        timeout=WAIT_SECONDS,
    )
    if process.returncode != 125 or effect.exists() or control.exists():
        fail(
            f"{label}: overlong endpoint was not rejected before bind/GO "
            f"({process.returncode}, {process.stderr!r})"
        )
    if list(long_parent.glob("*.sock")):
        fail(f"{label}: overlong endpoint left a socket entry")


with tempfile.TemporaryDirectory(prefix="managed-deadline-stop-") as temporary:
    root = Path(temporary)
    (root / "managed-command.py").write_text(
        """#!/usr/bin/env python3
import os
import pathlib
import signal
import sys
import time

mode, identities_text, ready_text, term_text = sys.argv[1:]
identities = pathlib.Path(identities_text)
ready = pathlib.Path(ready_text)
term = pathlib.Path(term_text)

def identity(pid):
    raw = pathlib.Path(f\"/proc/{pid}/stat\").read_text(encoding=\"ascii\")
    fields = raw[raw.rfind(\")\") + 2:].split()
    return f\"{pid}|{int(fields[2])}|{int(fields[19])}\"

def mark_and_ignore(_signum, _frame):
    term.write_text(\"term\\n\", encoding=\"ascii\")

if mode in {\"ignore\", \"linger\"}:
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
elif mode == \"mark-and-ignore\":
    signal.signal(signal.SIGTERM, mark_and_ignore)

records = [identity(os.getpid())]
if mode == \"linger\":
    child_ready = ready.with_suffix(\".child\")
    child_pid = os.fork()
    if child_pid == 0:
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        child_ready.write_text(\"ready\\n\", encoding=\"ascii\")
        while True:
            time.sleep(1)
    deadline = time.monotonic() + 5
    while not child_ready.is_file():
        if time.monotonic() >= deadline:
            raise SystemExit(90)
        time.sleep(0.01)
    records.append(identity(child_pid))

identities.write_text(\"\\n\".join(records) + \"\\n\", encoding=\"ascii\")
ready.write_text(\"ready\\n\", encoding=\"ascii\")
while True:
    time.sleep(1)
""",
        encoding="utf-8",
    )
    (root / "decoy-server.py").write_text(
        """#!/usr/bin/env python3
import os
import pathlib
import socket
import sys
import time

endpoint = pathlib.Path(sys.argv[1])
ready = pathlib.Path(sys.argv[2])
received = pathlib.Path(sys.argv[3])
server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
server.bind(os.fspath(endpoint))
os.chmod(endpoint, 0o600)
server.listen(1)
ready.write_text(\"ready\\n\", encoding=\"ascii\")
connection, _address = server.accept()
connection.settimeout(1)
try:
    payload = connection.recv(512)
except TimeoutError:
    payload = b\"\"
received.write_bytes(b\"EMPTY\\n\" if not payload else payload.hex().encode(\"ascii\") + b\"\\n\")
while True:
    time.sleep(1)
""",
        encoding="utf-8",
    )
    (root / "fake-stop-server.py").write_text(
        """#!/usr/bin/env python3
import os
import pathlib
import secrets
import socket
import stat
import sys
import time

mode = sys.argv[1]
control = pathlib.Path(sys.argv[2])
ready = pathlib.Path(sys.argv[3])
received = pathlib.Path(sys.argv[4])
endpoint = control.parent / \".managed-deadline-stop-11111111111111111111111111111111.sock\"
raw = pathlib.Path(f\"/proc/{os.getpid()}/stat\").read_text(encoding=\"ascii\")
fields = raw[raw.rfind(\")\") + 2:].split()
start = int(fields[19])
server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
server.bind(os.fspath(endpoint))
os.chmod(endpoint, 0o600)
server.listen(1)
nonce = secrets.token_hex(32)
payload = (
    f\"v1|{os.getpid()}|{start}|{os.getpid()}|{start}|{endpoint.name}|\"
    f\"{nonce}\\n\"
).encode(\"ascii\")
descriptor = os.open(
    control,
    os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC | os.O_NOFOLLOW,
    0o600,
)
with os.fdopen(descriptor, \"wb\") as output:
    output.write(payload)
    output.flush()
    os.fsync(output.fileno())
ready.write_text(\"ready\\n\", encoding=\"ascii\")
connection, _address = server.accept()
request = connection.recv(512)
parts = request[:-1].split(b\" \") if request.endswith(b\"\\n\") else []
if (
    len(parts) != 3
    or parts[0] != b\"STOP\"
    or parts[1] != nonce.encode(\"ascii\")
    or not parts[2].isdigit()
):
    raise SystemExit(91)
received.write_bytes(request)
if mode == \"ack-without-eof\":
    connection.sendall(b\"STOPPED 143\\n\")
elif mode == \"partial-ack\":
    connection.sendall(b\"STOPPED \" )
    connection.close()
elif mode == \"oversize-ack\":
    connection.sendall(b\"STOPPED 143\\nX\")
    connection.close()
elif mode == \"late-clean-ack\":
    control.unlink()
    endpoint.unlink()
    connection.sendall(b\"STOPPED 143\\n\")
    connection.close()
while True:
    time.sleep(1)
""",
        encoding="utf-8",
    )

    run_case("stop-channel-normal", run_basic_stop_case, root, "stop-channel-normal", "normal")
    run_case(
        "stop-channel-term-ignoring",
        run_basic_stop_case,
        root,
        "stop-channel-term-ignoring",
        "ignore",
    )
    run_case(
        "stop-channel-lingering-descendant",
        run_basic_stop_case,
        root,
        "stop-channel-lingering-descendant",
        "linger",
    )
    run_case("stop-channel-replacement", run_endpoint_replacement_case, root)
    run_case(
        "stop-channel-connect-replacement-race",
        run_connect_replacement_race_case,
        root,
    )
    run_case("stop-channel-requester-death", run_requester_death_case, root)
    run_case("stop-channel-wrong-nonce", run_wrong_nonce_case, root)
    run_case("stop-channel-wrong-uid", run_wrong_uid_case, root)
    run_case("stop-channel-post-reap", run_post_reap_case, root)
    run_case(
        "stop-channel-post-auth-control-hardlink",
        run_post_auth_metadata_mutation_case,
        root, "stop-channel-post-auth-control-hardlink", "control", "hardlink"
    )
    run_case(
        "stop-channel-post-auth-endpoint-hardlink",
        run_post_auth_metadata_mutation_case,
        root, "stop-channel-post-auth-endpoint-hardlink", "endpoint", "hardlink"
    )
    run_case(
        "stop-channel-post-auth-control-mode",
        run_post_auth_metadata_mutation_case,
        root, "stop-channel-post-auth-control-mode", "control", "mode"
    )
    run_case(
        "stop-channel-post-auth-endpoint-mode",
        run_post_auth_metadata_mutation_case,
        root, "stop-channel-post-auth-endpoint-mode", "endpoint", "mode"
    )
    run_case(
        "stop-channel-external-term-no-ack", run_external_term_no_ack_case, root
    )
    run_case(
        "stop-channel-stale-pid-namespace-decoy",
        run_stale_namespace_decoy_case,
        root,
    )
    run_case(
        "stop-channel-ack-without-eof",
        run_fake_peer_bound_case,
        root, "stop-channel-ack-without-eof", "ack-without-eof"
    )
    run_case(
        "stop-channel-slow-peer-bound",
        run_fake_peer_bound_case,
        root,
        "stop-channel-slow-peer-bound",
        "slow",
    )
    run_case(
        "stop-channel-partial-ack",
        run_fake_peer_bound_case,
        root,
        "stop-channel-partial-ack",
        "partial-ack",
    )
    run_case(
        "stop-channel-oversize-ack",
        run_fake_peer_bound_case,
        root,
        "stop-channel-oversize-ack",
        "oversize-ack",
    )
    run_case("stop-channel-late-clean-ack", run_late_clean_ack_case, root)
    run_case("stop-channel-cleanup-no-ack", run_cleanup_no_ack_case, root)
    run_case(
        "stop-channel-setup-failure-cleanup",
        run_setup_failure_cleanup_case,
        root,
    )
    run_case(
        "stop-channel-opath-failure-preserves-ambiguity",
        run_endpoint_opath_failure_case,
        root,
    )
    run_case(
        "stop-channel-control-recovery-mode",
        run_control_publication_recovery_case,
        root,
        "stop-channel-control-recovery-mode",
        "control-recovery-mode-failure",
        "mode",
    )
    run_case(
        "stop-channel-control-recovery-hardlink",
        run_control_publication_recovery_case,
        root,
        "stop-channel-control-recovery-hardlink",
        "control-recovery-hardlink-failure",
        "hardlink",
    )
    run_case(
        "stop-channel-control-fifo-bound", run_control_fifo_bound_case, root
    )
    run_case("stop-channel-grace-budget", run_grace_budget_case, root)
    run_case(
        "stop-channel-server-deadline-within",
        run_server_deadline_case,
        root,
        "stop-channel-server-deadline-within",
        "supervisor-cleanup-deadline-within",
        True,
    )
    run_case(
        "stop-channel-server-deadline-exhausted",
        run_server_deadline_case,
        root,
        "stop-channel-server-deadline-exhausted",
        "supervisor-cleanup-deadline-exhausted",
        False,
    )
    run_case(
        "stop-channel-inherited-short-deadline",
        run_inherited_short_deadline_case,
        root,
    )
    run_case(
        "stop-channel-endpoint-post-unlink-expiry",
        run_post_unlink_expiry_alias_case,
        root,
        "stop-channel-endpoint-post-unlink-expiry",
        "supervisor-endpoint-post-unlink-expiry",
        "endpoint",
    )
    run_case(
        "stop-channel-control-post-unlink-expiry",
        run_post_unlink_expiry_alias_case,
        root,
        "stop-channel-control-post-unlink-expiry",
        "supervisor-control-post-unlink-expiry",
        "control",
    )
    run_case("stop-channel-overlong-path", run_overlong_path_case, root)

if EXECUTED_STOP_CASES != list(EXPECTED_STOP_CASES):
    fail(
        "managed-deadline stop-channel executed-case manifest mismatch: "
        f"{EXECUTED_STOP_CASES!r}"
    )
for completed_case in EXECUTED_STOP_CASES:
    print(f"managed-deadline-stop-channel-case-ok:{completed_case}")
print("managed-deadline-stop-channel-linux-tests-ok")
