#!/usr/bin/env python3
"""Run one trusted command inside a Linux process group that is drained on exit."""

from __future__ import annotations

import argparse
import ctypes
import errno
import hmac
import math
import os
import secrets
import select
import signal
import socket
import stat
import struct
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import NoReturn


PR_SET_PDEATHSIG = 1
PR_SET_CHILD_SUBREAPER = 36
INTERNAL_FAILURE = 125
SKIP_UNSUPPORTED = 77
GROUP_PROOF_SECONDS = 5.0
READY_SECONDS = 5.0
FAULT_READY_SECONDS = 0.25
POLL_SECONDS = 0.01
GROUP_SCAN_SECONDS = 0.05
AF_UNIX_PATH_MAX = 108
STOP_REQUEST_SECONDS = 25.0
STOP_ACK_SLACK_SECONDS = 5.0
STOP_PEER_SECONDS = 1.0
STOP_CONTROL_MAX_BYTES = 512
STOP_REQUEST_MAX_BYTES = 96
STOP_ACK = b"STOPPED 143\n"
TEST_ENVIRONMENT_KEYS = (
    "MANAGED_DEADLINE_TESTING",
    "MANAGED_DEADLINE_TEST_FAULT",
    "MANAGED_DEADLINE_TEST_RECORD",
)
TEST_FAULTS = frozenset(
    {
        "guardian-readiness-timeout",
        "guardian-invalid-readiness",
        "guardian-ready-without-setsid",
        "guardian-record-valid-ready",
        "guardian-close-before-go",
        "guardian-fixed-setup-delay",
        "supervisor-parent-death-armed",
        "supervisor-post-launch-oserror",
        "supervisor-post-reap-pause",
        "request-after-connect-pause",
        "request-after-ack-pause",
        "supervisor-post-auth-pause",
        "supervisor-cleanup-deadline-within",
        "supervisor-cleanup-deadline-exhausted",
        "supervisor-endpoint-post-unlink-expiry",
        "supervisor-control-post-unlink-expiry",
        "stop-bind-failure",
        "stop-opath-failure",
        "stop-chmod-failure",
        "stop-lstat-failure",
        "stop-listen-failure",
        "control-fchmod-failure",
        "control-fstat-failure",
        "control-write-failure",
        "control-fsync-failure",
        "control-link-late-failure",
        "control-recovery-mode-failure",
        "control-recovery-hardlink-failure",
    }
)


class ContainmentError(RuntimeError):
    """Raised when process-group containment cannot be established."""


class WaitabilityLost(ContainmentError):
    """Raised when the retained guardian is no longer a waitable direct child."""


class DeadlineExpired(ContainmentError):
    """Raised when setup consumes the command's absolute deadline."""


class OwnedControlCleanupError(ContainmentError):
    """Raised when this supervisor cannot prove its control metadata removed."""


class OwnedEndpointCleanupError(ContainmentError):
    """Raised when this supervisor cannot prove its endpoint metadata removed."""


@dataclass(frozen=True)
class TestHooks:
    fault: str
    record: Path


@dataclass(frozen=True)
class Arguments:
    expected_parent_pid: int
    duration: float
    grace: float
    command: list[str]
    control_file: Path | None
    hooks: TestHooks | None


@dataclass(frozen=True)
class StopRequestArguments:
    control_file: Path
    timeout: float
    hooks: TestHooks | None
    expected_control_device: int | None
    expected_control_inode: int | None
    expected_supervisor_pid: int | None
    expected_supervisor_start: int | None


@dataclass(frozen=True)
class ProcessIdentity:
    pid: int
    pgid: int
    start_time: int
    state: str
    parent_pid: int


@dataclass(frozen=True)
class FileIdentity:
    device: int
    inode: int


@dataclass
class ControlOwnership:
    identity: FileIdentity
    descriptor: int


@dataclass(frozen=True)
class AuthenticatedStop:
    connection: socket.socket
    deadline: float


@dataclass(frozen=True)
class StopControlRecord:
    supervisor_pid: int
    supervisor_start: int
    guardian_pgid: int
    guardian_start: int
    endpoint_name: str
    nonce: str


@dataclass
class GroupSignalState:
    active: bool = True
    attempts_after_disable: int = 0


@dataclass
class StopChannel:
    listener: socket.socket
    endpoint: Path
    endpoint_identity: FileIdentity
    endpoint_descriptor: int
    nonce: str
    pending_connection: socket.socket | None = None
    pending_payload: bytearray | None = None
    pending_deadline: float = 0.0


def positive_pid(value: str) -> int:
    try:
        parsed = int(value, 10)
    except ValueError as error:
        raise argparse.ArgumentTypeError("PID must be a positive integer") from error
    if parsed <= 0:
        raise argparse.ArgumentTypeError("PID must be a positive integer")
    return parsed


def parse_test_hooks(parser: argparse.ArgumentParser) -> TestHooks | None:
    present = [key in os.environ for key in TEST_ENVIRONMENT_KEYS]
    if not any(present):
        return None
    if not all(present):
        parser.error("managed-deadline test hooks require all three guard variables")
    testing, fault, record_text = (
        os.environ[key] for key in TEST_ENVIRONMENT_KEYS
    )
    if testing != "1" or fault not in TEST_FAULTS:
        parser.error("managed-deadline test hooks are not explicitly guarded")
    record = Path(record_text)
    if not record.is_absolute():
        parser.error("MANAGED_DEADLINE_TEST_RECORD must be absolute")
    for key in TEST_ENVIRONMENT_KEYS:
        os.environ.pop(key, None)
    return TestHooks(fault=fault, record=record)


def positive_finite_seconds(value: str) -> float:
    try:
        parsed = float(value)
    except ValueError as error:
        raise argparse.ArgumentTypeError("timeout must be a positive number") from error
    if not math.isfinite(parsed) or parsed <= 0 or parsed > STOP_REQUEST_SECONDS:
        raise argparse.ArgumentTypeError(
            f"timeout must be positive and at most {STOP_REQUEST_SECONDS:g} seconds"
        )
    return parsed


def parse_arguments() -> Arguments | StopRequestArguments:
    parser = argparse.ArgumentParser(add_help=True)
    parser.add_argument("--request-stop", type=Path)
    parser.add_argument(
        "--request-timeout",
        type=positive_finite_seconds,
        default=STOP_REQUEST_SECONDS,
    )
    parser.add_argument("--expected-parent-pid", type=positive_pid)
    parser.add_argument("--expected-control-device", type=positive_pid)
    parser.add_argument("--expected-control-inode", type=positive_pid)
    parser.add_argument("--expected-supervisor-pid", type=positive_pid)
    parser.add_argument("--expected-supervisor-start", type=positive_pid)
    parser.add_argument("--control-file", type=Path)
    parser.add_argument("duration", nargs="?", type=float)
    parser.add_argument("grace", nargs="?", type=float)
    parser.add_argument("command", nargs=argparse.REMAINDER)
    namespace = parser.parse_args()
    if namespace.request_stop is not None:
        if (
            not namespace.request_stop.is_absolute()
            or namespace.expected_parent_pid is not None
            or namespace.control_file is not None
            or namespace.duration is not None
            or namespace.grace is not None
            or namespace.command
        ):
            parser.error(
                "--request-stop requires one absolute CONTROL_FILE and no supervisor arguments"
            )
        hooks = parse_test_hooks(parser)
        if hooks is not None and hooks.fault not in {
            "request-after-connect-pause",
            "request-after-ack-pause",
        }:
            parser.error("supervisor test hooks are invalid in request mode")
        expected_values = (
            namespace.expected_control_device,
            namespace.expected_control_inode,
            namespace.expected_supervisor_pid,
            namespace.expected_supervisor_start,
        )
        if any(value is not None for value in expected_values) and not all(
            value is not None for value in expected_values
        ):
            parser.error("expected control identity arguments must be supplied together")
        return StopRequestArguments(
            control_file=namespace.request_stop,
            timeout=namespace.request_timeout,
            hooks=hooks,
            expected_control_device=namespace.expected_control_device,
            expected_control_inode=namespace.expected_control_inode,
            expected_supervisor_pid=namespace.expected_supervisor_pid,
            expected_supervisor_start=namespace.expected_supervisor_start,
        )
    command = list(namespace.command)
    if command[:1] == ["--"]:
        command = command[1:]
    if (
        namespace.expected_parent_pid is None
        or namespace.expected_control_device is not None
        or namespace.expected_control_inode is not None
        or namespace.expected_supervisor_pid is not None
        or namespace.expected_supervisor_start is not None
        or namespace.request_timeout != STOP_REQUEST_SECONDS
        or not command
        or namespace.duration is None
        or namespace.grace is None
        or not math.isfinite(namespace.duration)
        or not math.isfinite(namespace.grace)
        or namespace.duration <= 0
        or namespace.grace <= 0
        or namespace.duration > 86_400
        or namespace.grace > 3_600
    ):
        parser.error("positive finite bounded duration, grace, and COMMAND are required")
    control_file = namespace.control_file
    if control_file is not None and not control_file.is_absolute():
        parser.error("--control-file must be absolute")
    if (
        control_file is not None
        and namespace.grace + GROUP_PROOF_SECONDS + STOP_ACK_SLACK_SECONDS
        > STOP_REQUEST_SECONDS
    ):
        parser.error(
            "control-enabled grace exceeds the protected stop request budget"
        )
    hooks = parse_test_hooks(parser)
    if hooks is not None and hooks.fault in {
        "request-after-connect-pause",
        "request-after-ack-pause",
    }:
        parser.error("request test hooks are invalid in supervisor mode")
    return Arguments(
        expected_parent_pid=namespace.expected_parent_pid,
        duration=namespace.duration,
        grace=namespace.grace,
        command=command,
        control_file=control_file,
        hooks=hooks,
    )


def linux_supported() -> bool:
    return sys.platform.startswith("linux") and Path("/proc/self/stat").is_file()


libc = ctypes.CDLL(None, use_errno=True)


def prctl(option: int, value: int) -> None:
    if libc.prctl(option, value, 0, 0, 0) != 0:
        error_number = ctypes.get_errno()
        raise OSError(error_number, os.strerror(error_number))


def normalized_wait_status(status: int) -> int:
    if os.WIFEXITED(status):
        return os.WEXITSTATUS(status)
    if os.WIFSIGNALED(status):
        return min(255, 128 + os.WTERMSIG(status))
    return INTERNAL_FAILURE


def proc_identity(pid: int) -> ProcessIdentity:
    raw = Path(f"/proc/{pid}/stat").read_text(encoding="ascii")
    closing = raw.rfind(")")
    if closing < 0:
        raise ContainmentError(f"invalid /proc stat record for PID {pid}")
    fields = raw[closing + 2 :].split()
    if len(fields) < 20:
        raise ContainmentError(f"short /proc stat record for PID {pid}")
    return ProcessIdentity(
        pid=pid,
        state=fields[0],
        parent_pid=int(fields[1]),
        pgid=int(fields[2]),
        start_time=int(fields[19]),
    )


def group_members(pgid: int, guardian_pid: int) -> list[ProcessIdentity]:
    members: list[ProcessIdentity] = []
    try:
        proc_entries = list(Path("/proc").iterdir())
    except OSError as error:
        raise ContainmentError("cannot enumerate /proc for process-group proof") from error
    for entry in proc_entries:
        if not entry.name.isdecimal():
            continue
        pid = int(entry.name)
        if pid == guardian_pid:
            continue
        try:
            identity = proc_identity(pid)
        except FileNotFoundError:
            continue
        except (OSError, ValueError, ContainmentError) as error:
            raise ContainmentError(
                f"cannot inspect PID {pid} during process-group proof"
            ) from error
        if identity.pgid == pgid:
            members.append(identity)
    return members


def process_ignores_signal(pid: int, signal_number: int) -> bool:
    status_text = Path(f"/proc/{pid}/status").read_text(encoding="ascii")
    ignored_line = next(
        (line for line in status_text.splitlines() if line.startswith("SigIgn:")),
        None,
    )
    if ignored_line is None:
        raise ContainmentError(f"PID {pid} has no SigIgn status")
    ignored_mask = int(ignored_line.split()[1], 16)
    return bool(ignored_mask & (1 << (signal_number - 1)))


def write_all(descriptor: int, payload: bytes) -> None:
    while payload:
        try:
            written = os.write(descriptor, payload)
        except InterruptedError:
            continue
        if written <= 0:
            raise OSError("short write")
        payload = payload[written:]


def fsync_directory(directory: Path) -> None:
    descriptor = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def inject_setup_fault(
    hooks: TestHooks | None,
    fault: str,
    guardian_identity: ProcessIdentity,
) -> None:
    if hooks is None or hooks.fault != fault:
        return
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    descriptor = os.open(hooks.record, flags, 0o600)
    try:
        os.fchmod(descriptor, 0o600)
        metadata = os.fstat(descriptor)
        if (
            not stat.S_ISREG(metadata.st_mode)
            or metadata.st_uid != os.getuid()
            or stat.S_IMODE(metadata.st_mode) != 0o600
            or metadata.st_nlink != 1
        ):
            raise ContainmentError("managed-deadline setup fault record is unsafe")
        write_all(
            descriptor,
            (
                f"{fault}|{guardian_identity.pid}|{guardian_identity.pgid}|"
                f"{guardian_identity.start_time}\n"
            ).encode("ascii"),
        )
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    fsync_directory(hooks.record.parent)
    raise OSError(f"injected {fault}")


def lstat_identity(path: Path) -> FileIdentity:
    metadata = path.lstat()
    if not stat.S_ISREG(metadata.st_mode):
        raise ContainmentError(f"{path} is not a regular file")
    return FileIdentity(metadata.st_dev, metadata.st_ino)


def same_file_identity(path: Path, expected: FileIdentity) -> bool:
    try:
        actual = lstat_identity(path)
    except (FileNotFoundError, OSError, ContainmentError):
        return False
    return actual == expected


def validate_stop_directory(directory: Path) -> None:
    try:
        metadata = directory.lstat()
        resolved = directory.resolve(strict=True)
    except (FileNotFoundError, OSError) as error:
        raise ContainmentError("managed-deadline stop directory is unavailable") from error
    if (
        not stat.S_ISDIR(metadata.st_mode)
        or resolved != directory
        or metadata.st_uid != os.getuid()
        or stat.S_IMODE(metadata.st_mode) != 0o700
    ):
        raise ContainmentError(
            "managed-deadline stop directory must be canonical, same-UID, and mode 0700"
        )


def lstat_socket_identity(path: Path) -> FileIdentity:
    metadata = path.lstat()
    if (
        not stat.S_ISSOCK(metadata.st_mode)
        or metadata.st_uid != os.getuid()
        or stat.S_IMODE(metadata.st_mode) != 0o600
        or metadata.st_nlink != 1
    ):
        raise ContainmentError(
            "managed-deadline stop endpoint is not a same-UID mode-0600 socket"
        )
    return FileIdentity(metadata.st_dev, metadata.st_ino)


def same_socket_identity(path: Path, expected: FileIdentity) -> bool:
    try:
        return lstat_socket_identity(path) == expected
    except (FileNotFoundError, OSError, ContainmentError):
        return False


def create_stop_channel(
    control_file: Path,
    hooks: TestHooks | None,
    guardian_identity: ProcessIdentity,
) -> StopChannel:
    validate_stop_directory(control_file.parent)
    token = secrets.token_hex(16)
    endpoint = control_file.parent / f".managed-deadline-stop-{token}.sock"
    encoded_endpoint = os.fsencode(endpoint)
    if b"\0" in encoded_endpoint or len(encoded_endpoint) >= AF_UNIX_PATH_MAX:
        raise ContainmentError("managed-deadline AF_UNIX endpoint path is too long")
    listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    endpoint_identity: FileIdentity | None = None
    endpoint_descriptor = -1
    expected_endpoint_mode: int | None = None
    try:
        previous_umask = os.umask(0o177)
        try:
            inject_setup_fault(hooks, "stop-bind-failure", guardian_identity)
            listener.bind(os.fspath(endpoint))
        finally:
            os.umask(previous_umask)
        inject_setup_fault(hooks, "stop-opath-failure", guardian_identity)
        try:
            endpoint_descriptor = os.open(
                endpoint,
                os.O_PATH | os.O_NOFOLLOW | os.O_CLOEXEC,
            )
        except BaseException as retained_open_error:
            raise OwnedEndpointCleanupError(
                "bound endpoint cannot be removed without a retained O_PATH identity"
            ) from retained_open_error
        raw_metadata = os.fstat(endpoint_descriptor)
        if (
            not stat.S_ISSOCK(raw_metadata.st_mode)
            or raw_metadata.st_uid != os.getuid()
            or raw_metadata.st_nlink != 1
        ):
            raise ContainmentError("bound managed-deadline endpoint identity is unsafe")
        endpoint_identity = FileIdentity(raw_metadata.st_dev, raw_metadata.st_ino)
        expected_endpoint_mode = 0o600
        if stat.S_IMODE(raw_metadata.st_mode) != expected_endpoint_mode:
            raise ContainmentError("bound managed-deadline endpoint mode is not 0600")
        inject_setup_fault(hooks, "stop-chmod-failure", guardian_identity)
        os.chmod(endpoint, 0o600, follow_symlinks=False)
        expected_endpoint_mode = 0o600
        inject_setup_fault(hooks, "stop-lstat-failure", guardian_identity)
        if lstat_socket_identity(endpoint) != endpoint_identity:
            raise ContainmentError("managed-deadline endpoint identity changed during setup")
        inject_setup_fault(hooks, "stop-listen-failure", guardian_identity)
        listener.listen(4)
        listener.setblocking(False)
        channel = StopChannel(
            listener=listener,
            endpoint=endpoint,
            endpoint_identity=endpoint_identity,
            endpoint_descriptor=endpoint_descriptor,
            nonce=secrets.token_hex(32),
        )
        endpoint_descriptor = -1
        return channel
    except BaseException as setup_error:
        listener.close()
        try:
            if endpoint_descriptor >= 0:
                retained = os.fstat(endpoint_descriptor)
                named = endpoint.lstat()
                if (
                    endpoint_identity is None
                    or FileIdentity(retained.st_dev, retained.st_ino)
                    != endpoint_identity
                    or FileIdentity(named.st_dev, named.st_ino)
                    != endpoint_identity
                    or not stat.S_ISSOCK(retained.st_mode)
                    or not stat.S_ISSOCK(named.st_mode)
                    or retained.st_uid != os.getuid()
                    or named.st_uid != os.getuid()
                    or retained.st_nlink != 1
                    or named.st_nlink != 1
                    or expected_endpoint_mode is None
                    or stat.S_IMODE(retained.st_mode) != expected_endpoint_mode
                    or stat.S_IMODE(named.st_mode) != expected_endpoint_mode
                ):
                    raise ContainmentError(
                        "failed endpoint setup lost its retained identity"
                    )
                os.unlink(endpoint)
                fsync_directory(endpoint.parent)
                prove_path_absent(endpoint)
                if os.fstat(endpoint_descriptor).st_nlink != 0:
                    raise ContainmentError(
                        "failed endpoint setup retained an unproved alias"
                    )
        finally:
            if endpoint_descriptor >= 0:
                os.close(endpoint_descriptor)
        raise


def close_pending_stop_peer(channel: StopChannel) -> None:
    if channel.pending_connection is not None:
        try:
            channel.pending_connection.close()
        except OSError:
            pass
    channel.pending_connection = None
    channel.pending_payload = None
    channel.pending_deadline = 0.0


def remove_owned_stop_endpoint(
    channel: StopChannel | None,
    deadline: float | None = None,
    hooks: TestHooks | None = None,
) -> None:
    if channel is None:
        return
    close_pending_stop_peer(channel)
    channel.listener.close()
    try:
        retained = os.fstat(channel.endpoint_descriptor)
        if (
            FileIdentity(retained.st_dev, retained.st_ino)
            != channel.endpoint_identity
            or not stat.S_ISSOCK(retained.st_mode)
            or retained.st_uid != os.getuid()
            or stat.S_IMODE(retained.st_mode) != 0o600
            or retained.st_nlink != 1
            or not same_socket_identity(channel.endpoint, channel.endpoint_identity)
        ):
            raise ContainmentError("owned managed-deadline stop endpoint was replaced")
        if (
            hooks is not None
            and hooks.fault == "supervisor-endpoint-post-unlink-expiry"
        ):
            os.link(channel.endpoint, hooks.record, follow_symlinks=False)
        os.unlink(channel.endpoint)
        fsync_directory(channel.endpoint.parent)
        prove_path_absent(channel.endpoint)
        if (
            deadline is not None
            and hooks is not None
            and hooks.fault == "supervisor-endpoint-post-unlink-expiry"
        ):
            time.sleep(max(0.0, deadline - time.monotonic()) + POLL_SECONDS)
        if os.fstat(channel.endpoint_descriptor).st_nlink != 0:
            raise ContainmentError("managed-deadline stop endpoint retained an alias")
    finally:
        os.close(channel.endpoint_descriptor)


def prove_path_absent(path: Path) -> None:
    try:
        path.lstat()
    except FileNotFoundError:
        return
    except OSError as error:
        raise ContainmentError(f"cannot prove {path} absent: {error}") from error
    raise ContainmentError(f"cannot prove {path} absent: directory entry still exists")


def retained_control_metadata(
    descriptor: int,
    identity: FileIdentity,
    expected_links: int,
) -> os.stat_result:
    metadata = os.fstat(descriptor)
    if (
        FileIdentity(metadata.st_dev, metadata.st_ino) != identity
        or not stat.S_ISREG(metadata.st_mode)
        or metadata.st_uid != os.getuid()
        or stat.S_IMODE(metadata.st_mode) != 0o600
        or metadata.st_nlink != expected_links
    ):
        raise ContainmentError(
            "retained managed-deadline control metadata or link count changed"
        )
    return metadata


def named_control_matches(
    path: Path,
    identity: FileIdentity,
    expected_links: int,
) -> bool:
    try:
        metadata = path.lstat()
    except FileNotFoundError:
        return False
    named_identity = FileIdentity(metadata.st_dev, metadata.st_ino)
    if named_identity != identity:
        return False
    if (
        not stat.S_ISREG(metadata.st_mode)
        or metadata.st_uid != os.getuid()
        or stat.S_IMODE(metadata.st_mode) != 0o600
        or metadata.st_nlink != expected_links
    ):
        raise ContainmentError(
            f"owned managed-deadline control name {path} has unsafe metadata"
        )
    return True


def publish_control_file(
    path: Path,
    supervisor_identity: ProcessIdentity,
    guardian_identity: ProcessIdentity,
    stop_channel: StopChannel,
    hooks: TestHooks | None,
) -> ControlOwnership:
    temporary = path.with_name(f".{path.name}.tmp.{supervisor_identity.pid}")
    descriptor = -1
    temporary_identity: FileIdentity | None = None
    try:
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC
        if hasattr(os, "O_NOFOLLOW"):
            flags |= os.O_NOFOLLOW
        previous_umask = os.umask(0o177)
        try:
            descriptor = os.open(temporary, flags, 0o600)
        finally:
            os.umask(previous_umask)
        created_metadata = os.fstat(descriptor)
        temporary_identity = FileIdentity(
            created_metadata.st_dev, created_metadata.st_ino
        )
        retained_control_metadata(descriptor, temporary_identity, 1)
        inject_setup_fault(hooks, "control-fchmod-failure", guardian_identity)
        os.fchmod(descriptor, 0o600)
        inject_setup_fault(hooks, "control-fstat-failure", guardian_identity)
        retained_control_metadata(descriptor, temporary_identity, 1)
        payload = (
            f"v1|{supervisor_identity.pid}|{supervisor_identity.start_time}|"
            f"{guardian_identity.pgid}|{guardian_identity.start_time}|"
            f"{stop_channel.endpoint.name}|{stop_channel.nonce}\n"
        ).encode("ascii")
        if len(payload) > STOP_CONTROL_MAX_BYTES:
            raise ContainmentError("managed-deadline control record exceeds its bound")
        if hooks is not None and hooks.fault == "control-write-failure":
            write_all(descriptor, payload[: max(1, len(payload) // 2)])
            inject_setup_fault(hooks, "control-write-failure", guardian_identity)
        write_all(descriptor, payload)
        inject_setup_fault(hooks, "control-fsync-failure", guardian_identity)
        os.fsync(descriptor)
        os.link(temporary, path, follow_symlinks=False)
        if hooks is not None and hooks.fault == "control-recovery-mode-failure":
            write_test_record(hooks.record, supervisor_identity.pid)
            os.chmod(temporary, 0o640, follow_symlinks=False)
            raise OSError("injected control recovery mode failure")
        if hooks is not None and hooks.fault == "control-recovery-hardlink-failure":
            os.link(temporary, hooks.record, follow_symlinks=False)
            raise OSError("injected control recovery hardlink failure")
        inject_setup_fault(hooks, "control-link-late-failure", guardian_identity)
        fsync_directory(path.parent)
        os.unlink(temporary)
        fsync_directory(path.parent)
        prove_path_absent(temporary)
        retained_control_metadata(descriptor, temporary_identity, 1)
        final_identity = secure_control_identity(path)
        if final_identity != temporary_identity:
            raise ContainmentError("managed-deadline control publication identity changed")
        retained_control_metadata(descriptor, temporary_identity, 1)
        ownership = ControlOwnership(final_identity, descriptor)
        descriptor = -1
        return ownership
    except BaseException as publication_error:
        cleanup_error: BaseException | None = None
        try:
            if descriptor >= 0 and temporary_identity is not None:
                retained = os.fstat(descriptor)
                retained_links = retained.st_nlink
                retained_control_metadata(
                    descriptor, temporary_identity, retained_links
                )
                owned_names: list[Path] = []
                for candidate in (temporary, path):
                    if named_control_matches(
                        candidate, temporary_identity, retained_links
                    ):
                        owned_names.append(candidate)
                if retained_links != len(owned_names):
                    raise ContainmentError(
                        "retained managed-deadline control has an unproved alias"
                    )
                remaining_links = retained_links
                for candidate in owned_names:
                    if not named_control_matches(
                        candidate, temporary_identity, remaining_links
                    ):
                        raise ContainmentError(
                            "owned managed-deadline control name changed during cleanup"
                        )
                    os.unlink(candidate)
                    fsync_directory(candidate.parent)
                    prove_path_absent(candidate)
                    remaining_links -= 1
                    retained_control_metadata(
                        descriptor, temporary_identity, remaining_links
                    )
                retained_control_metadata(descriptor, temporary_identity, 0)
        except BaseException as recovery_error:
            cleanup_error = recovery_error
        finally:
            if descriptor >= 0:
                try:
                    os.close(descriptor)
                except OSError:
                    pass
        if cleanup_error is not None:
            raise OwnedControlCleanupError(
                "managed-deadline control publication failed and owned control "
                f"cleanup was not proved: {publication_error}; {cleanup_error}"
            ) from cleanup_error
        raise


def remove_owned_control(
    path: Path | None,
    ownership: ControlOwnership | None,
    deadline: float | None = None,
    hooks: TestHooks | None = None,
) -> None:
    if path is None or ownership is None:
        return
    try:
        retained = os.fstat(ownership.descriptor)
        if (
            FileIdentity(retained.st_dev, retained.st_ino) != ownership.identity
            or not stat.S_ISREG(retained.st_mode)
            or retained.st_uid != os.getuid()
            or stat.S_IMODE(retained.st_mode) != 0o600
            or retained.st_nlink != 1
            or secure_control_identity(path) != ownership.identity
        ):
            raise ContainmentError("owned managed-deadline control identity was replaced")
        if (
            hooks is not None
            and hooks.fault == "supervisor-control-post-unlink-expiry"
        ):
            os.link(path, hooks.record, follow_symlinks=False)
        os.unlink(path)
        fsync_directory(path.parent)
        prove_path_absent(path)
        if (
            deadline is not None
            and hooks is not None
            and hooks.fault == "supervisor-control-post-unlink-expiry"
        ):
            time.sleep(max(0.0, deadline - time.monotonic()) + POLL_SECONDS)
        if os.fstat(ownership.descriptor).st_nlink != 0:
            raise ContainmentError("managed-deadline control retained an alias")
    finally:
        os.close(ownership.descriptor)


def secure_control_identity(path: Path) -> FileIdentity:
    metadata = path.lstat()
    if (
        not stat.S_ISREG(metadata.st_mode)
        or metadata.st_uid != os.getuid()
        or stat.S_IMODE(metadata.st_mode) != 0o600
        or metadata.st_nlink != 1
    ):
        raise ContainmentError(
            "managed-deadline control is not a same-UID mode-0600 single-link file"
        )
    return FileIdentity(metadata.st_dev, metadata.st_ino)


def read_stop_control(
    path: Path, deadline: float
) -> tuple[StopControlRecord, FileIdentity]:
    validate_stop_directory(path.parent)
    remaining_before(deadline)
    flags = os.O_RDONLY | os.O_CLOEXEC | os.O_NONBLOCK
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    descriptor = os.open(path, flags)
    try:
        metadata = os.fstat(descriptor)
        if (
            not stat.S_ISREG(metadata.st_mode)
            or metadata.st_uid != os.getuid()
            or stat.S_IMODE(metadata.st_mode) != 0o600
            or metadata.st_nlink != 1
        ):
            raise ContainmentError("managed-deadline control metadata is unsafe")
        identity = FileIdentity(metadata.st_dev, metadata.st_ino)
        payload = bytearray()
        while len(payload) <= STOP_CONTROL_MAX_BYTES:
            remaining_before(deadline)
            chunk = os.read(descriptor, STOP_CONTROL_MAX_BYTES + 1 - len(payload))
            if not chunk:
                break
            payload.extend(chunk)
    finally:
        os.close(descriptor)
    if len(payload) > STOP_CONTROL_MAX_BYTES:
        raise ContainmentError("managed-deadline control record exceeds its bound")
    if payload.count(b"\n") != 1 or not payload.endswith(b"\n"):
        raise ContainmentError(
            "managed-deadline control must be one newline-terminated record"
        )
    if secure_control_identity(path) != identity:
        raise ContainmentError("managed-deadline control identity changed while reading")
    try:
        fields = payload[:-1].decode("ascii").split("|")
    except UnicodeDecodeError as error:
        raise ContainmentError("managed-deadline control is not ASCII") from error
    if len(fields) != 7 or fields[0] != "v1":
        raise ContainmentError("managed-deadline control version or fields are invalid")
    integer_fields = fields[1:5]
    if any(not value.isdecimal() or int(value) <= 0 for value in integer_fields):
        raise ContainmentError("managed-deadline control identities are invalid")
    endpoint_name, nonce = fields[5:]
    endpoint_prefix = ".managed-deadline-stop-"
    endpoint_suffix = ".sock"
    endpoint_token = endpoint_name[
        len(endpoint_prefix) : -len(endpoint_suffix)
    ]
    if (
        not endpoint_name.startswith(endpoint_prefix)
        or not endpoint_name.endswith(endpoint_suffix)
        or len(endpoint_token) != 32
        or any(character not in "0123456789abcdef" for character in endpoint_token)
        or len(nonce) != 64
        or any(character not in "0123456789abcdef" for character in nonce)
    ):
        raise ContainmentError("managed-deadline control capability is invalid")
    record = StopControlRecord(
        supervisor_pid=int(fields[1]),
        supervisor_start=int(fields[2]),
        guardian_pgid=int(fields[3]),
        guardian_start=int(fields[4]),
        endpoint_name=endpoint_name,
        nonce=nonce,
    )
    remaining_before(deadline)
    return record, identity


def remaining_before(deadline: float) -> float:
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise ContainmentError("managed-deadline stop request timed out")
    return remaining


def connect_stop_endpoint(
    endpoint: Path, deadline: float
) -> tuple[socket.socket, FileIdentity]:
    endpoint_identity_before = lstat_socket_identity(endpoint)
    client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    client.setblocking(False)
    try:
        result = client.connect_ex(os.fspath(endpoint))
        if result not in (0, errno.EINPROGRESS, errno.EAGAIN, errno.EWOULDBLOCK):
            raise OSError(result, os.strerror(result))
        if result != 0:
            _readable, writable, exceptional = select.select(
                [], [client], [client], remaining_before(deadline)
            )
            if exceptional or not writable:
                raise ContainmentError("managed-deadline stop endpoint connect failed")
            socket_error = client.getsockopt(socket.SOL_SOCKET, socket.SO_ERROR)
            if socket_error:
                raise OSError(socket_error, os.strerror(socket_error))
        return client, endpoint_identity_before
    except BaseException:
        client.close()
        raise


def send_socket_payload(client: socket.socket, payload: bytes, deadline: float) -> None:
    offset = 0
    while offset < len(payload):
        _readable, writable, exceptional = select.select(
            [], [client], [client], remaining_before(deadline)
        )
        if exceptional or not writable:
            raise ContainmentError("managed-deadline stop request send failed")
        try:
            written = client.send(payload[offset:])
        except BlockingIOError:
            continue
        if written <= 0:
            raise ContainmentError("managed-deadline stop request send was short")
        offset += written


def read_stop_ack(client: socket.socket, deadline: float) -> None:
    response = bytearray()
    response_eof = False
    while not response_eof:
        readable, _writable, exceptional = select.select(
            [client], [], [client], remaining_before(deadline)
        )
        if exceptional or not readable:
            raise ContainmentError("managed-deadline stop acknowledgement failed")
        try:
            chunk = client.recv(len(STOP_ACK) + 1 - len(response))
        except BlockingIOError:
            continue
        if not chunk:
            response_eof = True
            break
        response.extend(chunk)
        if len(response) > len(STOP_ACK):
            raise ContainmentError("managed-deadline stop acknowledgement is oversized")
    if bytes(response) != STOP_ACK or not response_eof:
        raise ContainmentError("managed-deadline stop acknowledgement is invalid")


def request_stop(arguments: StopRequestArguments) -> int:
    deadline = time.monotonic() + arguments.timeout
    client: socket.socket | None = None
    try:
        record, control_identity = read_stop_control(arguments.control_file, deadline)
        if arguments.expected_control_device is not None:
            expected_identity = FileIdentity(
                arguments.expected_control_device,
                arguments.expected_control_inode or 0,
            )
            if (
                control_identity != expected_identity
                or record.supervisor_pid != arguments.expected_supervisor_pid
                or record.supervisor_start != arguments.expected_supervisor_start
            ):
                raise ContainmentError(
                    "managed-deadline control differs from the retained controller identity"
                )
        remaining_before(deadline)
        supervisor = proc_identity(record.supervisor_pid)
        if (
            supervisor.start_time != record.supervisor_start
            or supervisor.state == "Z"
        ):
            raise ContainmentError("managed-deadline supervisor identity is stale")
        endpoint = arguments.control_file.parent / record.endpoint_name
        client, endpoint_identity = connect_stop_endpoint(endpoint, deadline)
        peer_credentials = client.getsockopt(
            socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize("3i")
        )
        peer_pid, peer_uid, _peer_gid = struct.unpack("3i", peer_credentials)
        peer_identity = proc_identity(peer_pid)
        if (
            peer_uid != os.getuid()
            or peer_pid != record.supervisor_pid
            or peer_identity.start_time != record.supervisor_start
            or peer_identity.state == "Z"
        ):
            raise ContainmentError("managed-deadline stop peer identity is invalid")
        if (
            arguments.hooks is not None
            and arguments.hooks.fault == "request-after-connect-pause"
        ):
            write_test_record(arguments.hooks.record, os.getpid())
            time.sleep(0.5)
        endpoint_identity_after = lstat_socket_identity(endpoint)
        if endpoint_identity_after != endpoint_identity:
            raise ContainmentError(
                "managed-deadline stop endpoint identity changed during connect"
            )
        if secure_control_identity(arguments.control_file) != control_identity:
            raise ContainmentError(
                "managed-deadline control identity changed during connect"
            )
        if lstat_socket_identity(endpoint) != endpoint_identity_after:
            raise ContainmentError(
                "managed-deadline stop endpoint identity changed after connect"
            )
        request_deadline_ns = int(deadline * 1_000_000_000)
        request = f"STOP {record.nonce} {request_deadline_ns}\n".encode("ascii")
        if len(request) > STOP_REQUEST_MAX_BYTES:
            raise ContainmentError("managed-deadline stop request exceeds its bound")
        send_socket_payload(client, request, deadline)
        read_stop_ack(client, deadline)
        if (
            arguments.hooks is not None
            and arguments.hooks.fault == "request-after-ack-pause"
        ):
            write_test_record(arguments.hooks.record, os.getpid())
            time.sleep(0.5)
        remaining_before(deadline)
        prove_path_absent(arguments.control_file)
        prove_path_absent(endpoint)
        remaining_before(deadline)
        return 0
    except (ContainmentError, FileNotFoundError, OSError, ValueError) as error:
        print(f"managed deadline stop request failed: {error}", file=sys.stderr)
        return INTERNAL_FAILURE
    finally:
        if client is not None:
            client.close()


def write_test_record(path: Path, pid: int) -> None:
    identity = proc_identity(pid)
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    descriptor = os.open(path, flags, 0o600)
    try:
        os.fchmod(descriptor, 0o600)
        if stat.S_IMODE(os.fstat(descriptor).st_mode) != 0o600:
            raise ContainmentError("managed-deadline test record mode is not 0600")
        write_all(
            descriptor,
            f"{identity.pid}|{identity.pgid}|{identity.start_time}\n".encode(
                "ascii"
            ),
        )
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    fsync_directory(path.parent)


def read_bounded_pipe(descriptor: int, timeout_seconds: float) -> bytes:
    deadline = time.monotonic() + timeout_seconds
    payload = bytearray()
    while len(payload) <= 128:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return bytes(payload)
        ready, _, _ = select.select([descriptor], [], [], remaining)
        if not ready:
            return bytes(payload)
        try:
            chunk = os.read(descriptor, 128 - len(payload))
        except InterruptedError:
            continue
        if not chunk:
            return bytes(payload)
        payload.extend(chunk)
        if payload.endswith(b"\n"):
            return bytes(payload)
    return bytes(payload)


def guardian_parent_died(_signum: int, _frame: object) -> NoReturn:
    try:
        if os.getpgrp() == os.getpid():
            try:
                os.killpg(os.getpgrp(), signal.SIGKILL)
            except BaseException:
                pass
    finally:
        os._exit(INTERNAL_FAILURE)


def normalize_setup_signals() -> None:
    for signal_number in (
        signal.SIGTERM,
        signal.SIGCHLD,
        signal.SIGINT,
        signal.SIGHUP,
    ):
        signal.signal(signal_number, signal.SIG_DFL)
    signal.signal(signal.SIGPIPE, signal.SIG_IGN)
    signal.pthread_sigmask(
        signal.SIG_UNBLOCK,
        {
            signal.SIGTERM,
            signal.SIGUSR1,
            signal.SIGCHLD,
            signal.SIGINT,
            signal.SIGHUP,
        },
    )


def reset_command_signals() -> None:
    for signal_number in (
        signal.SIGTERM,
        signal.SIGINT,
        signal.SIGHUP,
        signal.SIGQUIT,
        signal.SIGUSR1,
        signal.SIGUSR2,
        signal.SIGCHLD,
        signal.SIGPIPE,
    ):
        signal.signal(signal_number, signal.SIG_DFL)
    signal.pthread_sigmask(signal.SIG_SETMASK, set())


def exec_command(command: list[str]) -> NoReturn:
    reset_command_signals()
    try:
        prctl(PR_SET_PDEATHSIG, signal.SIGKILL)
        os.execvp(command[0], command)
    except FileNotFoundError:
        os._exit(127)
    except (OSError, ValueError):
        os._exit(126)


def reap_nonblocking() -> bool:
    """Reap exited adopted children; return True while any child remains."""
    while True:
        try:
            child_pid, _status = os.waitpid(-1, os.WNOHANG)
        except ChildProcessError:
            return False
        except InterruptedError:
            continue
        if child_pid == 0:
            return True


def guardian(
    command: list[str],
    supervisor_pid: int,
    ready_descriptor: int,
    linger_descriptor: int,
    go_descriptor: int,
    launch_ack_descriptor: int,
    hooks: TestHooks | None,
) -> NoReturn:
    if os.getppid() != supervisor_pid:
        os._exit(INTERNAL_FAILURE)
    signal.signal(signal.SIGUSR1, guardian_parent_died)
    prctl(PR_SET_PDEATHSIG, signal.SIGUSR1)
    if os.getppid() != supervisor_pid:
        guardian_parent_died(signal.SIGUSR1, None)

    fault = hooks.fault if hooks is not None else ""
    if fault in {
        "guardian-readiness-timeout",
        "guardian-invalid-readiness",
        "guardian-ready-without-setsid",
    }:
        write_test_record(hooks.record, os.getpid())
        if fault == "guardian-readiness-timeout":
            while True:
                time.sleep(60)
        payload = (
            b"INVALID\n"
            if fault == "guardian-invalid-readiness"
            else f"READY|{os.getpid()}\n".encode("ascii")
        )
        write_all(ready_descriptor, payload)
        os.close(ready_descriptor)
        while True:
            time.sleep(60)

    os.setsid()
    signal.signal(signal.SIGTERM, lambda _signum, _frame: None)
    signal.signal(signal.SIGINT, lambda _signum, _frame: None)
    signal.signal(signal.SIGHUP, lambda _signum, _frame: None)
    prctl(PR_SET_CHILD_SUBREAPER, 1)
    if os.getppid() != supervisor_pid:
        guardian_parent_died(signal.SIGUSR1, None)
    if hooks is not None and fault in {
        "guardian-record-valid-ready",
        "guardian-close-before-go",
        "guardian-fixed-setup-delay",
    }:
        write_test_record(hooks.record, os.getpid())
    if fault == "guardian-fixed-setup-delay":
        time.sleep(0.5)
    write_all(ready_descriptor, f"READY|{os.getpid()}\n".encode("ascii"))
    os.close(ready_descriptor)
    if fault == "guardian-close-before-go":
        os.close(go_descriptor)
        os.close(launch_ack_descriptor)
        while True:
            time.sleep(60)

    launch_payload = read_bounded_pipe(go_descriptor, READY_SECONDS)
    os.close(go_descriptor)
    if launch_payload != b"GO\n":
        os._exit(INTERNAL_FAILURE)

    command_pid = os.fork()
    if command_pid == 0:
        os.close(linger_descriptor)
        os.close(launch_ack_descriptor)
        exec_command(command)

    write_all(
        launch_ack_descriptor, f"LAUNCHED|{command_pid}\n".encode("ascii")
    )
    os.close(launch_ack_descriptor)
    direct_status: int | None = None
    while direct_status is None:
        try:
            child_pid, status_value = os.waitpid(-1, 0)
        except InterruptedError:
            continue
        except ChildProcessError:
            os._exit(INTERNAL_FAILURE)
        if child_pid == command_pid:
            direct_status = normalized_wait_status(status_value)

    if not reap_nonblocking():
        os.close(linger_descriptor)
        os._exit(direct_status)

    write_all(linger_descriptor, b"LINGER\n")
    os.close(linger_descriptor)
    while True:
        try:
            os.waitpid(-1, 0)
        except InterruptedError:
            continue
        except ChildProcessError:
            os._exit(INTERNAL_FAILURE)


def waitid_nowait(pid: int) -> os.waitid_result | None:
    try:
        return os.waitid(os.P_PID, pid, os.WEXITED | os.WNOHANG | os.WNOWAIT)
    except ChildProcessError as error:
        raise WaitabilityLost(f"guardian PID {pid} is no longer waitable") from error


def guardian_return_code(result: os.waitid_result) -> int:
    if result.si_code == os.CLD_EXITED:
        return int(result.si_status)
    if result.si_code in (os.CLD_KILLED, os.CLD_DUMPED):
        return min(255, 128 + int(result.si_status))
    return INTERNAL_FAILURE


def send_group_signal(
    pgid: int, signal_number: int, signal_state: GroupSignalState
) -> None:
    if not signal_state.active:
        signal_state.attempts_after_disable += 1
        raise ContainmentError(
            "managed process-group signal attempted after non-signaling transition"
        )
    try:
        os.kill(-pgid, signal_number)
    except ProcessLookupError:
        pass


def disable_termination_handlers(signal_state: GroupSignalState) -> None:
    termination_signals = {signal.SIGTERM, signal.SIGINT, signal.SIGHUP}
    signal.pthread_sigmask(signal.SIG_BLOCK, termination_signals)
    signal_state.active = False
    for signal_number in termination_signals:
        signal.signal(signal_number, signal.SIG_IGN)


def poll_stop_channel(channel: StopChannel) -> AuthenticatedStop | None:
    now = time.monotonic()
    if (
        channel.pending_connection is not None
        and now >= channel.pending_deadline
    ):
        close_pending_stop_peer(channel)

    if channel.pending_connection is None:
        while True:
            try:
                connection, _address = channel.listener.accept()
            except BlockingIOError:
                break
            connection.setblocking(False)
            try:
                credentials = connection.getsockopt(
                    socket.SOL_SOCKET,
                    socket.SO_PEERCRED,
                    struct.calcsize("3i"),
                )
                peer_pid, peer_uid, _peer_gid = struct.unpack("3i", credentials)
                peer_identity = proc_identity(peer_pid)
                if peer_uid != os.getuid() or peer_identity.state == "Z":
                    connection.close()
                    continue
            except (ContainmentError, FileNotFoundError, OSError, ValueError):
                connection.close()
                continue
            channel.pending_connection = connection
            channel.pending_payload = bytearray()
            channel.pending_deadline = time.monotonic() + STOP_PEER_SECONDS
            break

    connection = channel.pending_connection
    if connection is None:
        return None
    try:
        chunk = connection.recv(
            STOP_REQUEST_MAX_BYTES + 1 - len(channel.pending_payload or b"")
        )
    except BlockingIOError:
        return None
    except OSError:
        close_pending_stop_peer(channel)
        return None
    if not chunk:
        close_pending_stop_peer(channel)
        return None
    assert channel.pending_payload is not None
    channel.pending_payload.extend(chunk)
    payload = bytes(channel.pending_payload)
    if len(payload) > STOP_REQUEST_MAX_BYTES:
        close_pending_stop_peer(channel)
        return None
    if not payload.endswith(b"\n"):
        if len(payload) == STOP_REQUEST_MAX_BYTES:
            close_pending_stop_peer(channel)
        return None
    try:
        verb, supplied_nonce, deadline_text = payload[:-1].decode("ascii").split(" ")
    except (UnicodeDecodeError, ValueError):
        close_pending_stop_peer(channel)
        return None
    if (
        verb != "STOP"
        or not hmac.compare_digest(supplied_nonce, channel.nonce)
        or not deadline_text.isdecimal()
        or len(deadline_text) > 20
    ):
        close_pending_stop_peer(channel)
        return None
    deadline_ns = int(deadline_text)
    now_ns = time.monotonic_ns()
    if (
        deadline_ns <= now_ns
        or deadline_ns > now_ns + int(STOP_REQUEST_SECONDS * 1_000_000_000)
    ):
        close_pending_stop_peer(channel)
        return None
    authenticated_connection = connection
    channel.pending_connection = None
    channel.pending_payload = None
    channel.pending_deadline = 0.0
    return AuthenticatedStop(
        connection=authenticated_connection,
        deadline=deadline_ns / 1_000_000_000,
    )


def cleanup_stop_metadata(
    channel: StopChannel | None,
    control_file: Path | None,
    control_ownership: ControlOwnership | None,
    deadline: float | None = None,
    hooks: TestHooks | None = None,
) -> None:
    errors: list[str] = []
    try:
        remove_owned_stop_endpoint(channel, deadline, hooks)
    except (ContainmentError, OSError) as error:
        errors.append(str(error))
    try:
        remove_owned_control(control_file, control_ownership, deadline, hooks)
    except (ContainmentError, OSError) as error:
        errors.append(str(error))
    if errors:
        raise ContainmentError("; ".join(errors))


def acknowledge_stop_and_exit(
    connection: socket.socket, server_stop_deadline: float
) -> NoReturn:
    try:
        timeout = min(
            STOP_ACK_SLACK_SECONDS, remaining_before(server_stop_deadline)
        )
        connection.setblocking(True)
        connection.settimeout(timeout)
        connection.sendall(STOP_ACK)
    except (BrokenPipeError, ConnectionResetError):
        os._exit(143)
    except (ContainmentError, OSError):
        connection.close()
        os._exit(INTERNAL_FAILURE)
    os._exit(143)


def reap_guardian(pid: int) -> None:
    while True:
        try:
            waited_pid, _status = os.waitpid(pid, 0)
        except InterruptedError:
            continue
        except ChildProcessError as error:
            raise WaitabilityLost(
                f"guardian PID {pid} lost waitability during reap"
            ) from error
        if waited_pid == pid:
            return


def kill_unverified_guardian(pid: int) -> None:
    try:
        result = waitid_nowait(pid)
    except WaitabilityLost as error:
        raise ContainmentError(
            "unverified guardian lost waitability; numeric PID was not signaled"
        ) from error
    if result is None:
        try:
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    deadline = time.monotonic() + READY_SECONDS
    while time.monotonic() < deadline:
        try:
            result = waitid_nowait(pid)
        except WaitabilityLost as error:
            raise ContainmentError(
                "unverified guardian lost waitability after direct termination"
            ) from error
        if result is not None:
            reap_guardian(pid)
            return
        time.sleep(POLL_SECONDS)
    raise ContainmentError(f"setup guardian PID {pid} could not be reaped")


def fail_closed(
    message: str, pgid: int | None = None, signal_identity_safe: bool = False
) -> NoReturn:
    try:
        print(f"managed deadline containment failure: {message}", file=sys.stderr)
    except BaseException:
        pass
    for signal_number in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        try:
            signal.signal(signal_number, signal.SIG_IGN)
        except BaseException:
            pass
    while True:
        if signal_identity_safe and pgid is not None:
            try:
                os.kill(-pgid, signal.SIGKILL)
            except BaseException:
                pass
        try:
            time.sleep(1.0)
        except BaseException:
            continue


def prove_and_reap(
    guardian_pid: int,
    pgid: int,
    proof_deadline: float,
    post_go: bool,
    signal_state: GroupSignalState,
) -> None:
    members: list[ProcessIdentity] = []
    next_group_scan = 0.0
    while True:
        try:
            result = waitid_nowait(guardian_pid)
        except WaitabilityLost as error:
            if post_go:
                fail_closed(str(error), signal_identity_safe=False)
            raise ContainmentError(str(error)) from error
        now = time.monotonic()
        if result is not None and (now >= next_group_scan or now >= proof_deadline):
            try:
                members = group_members(pgid, guardian_pid)
            except ContainmentError as error:
                if post_go:
                    fail_closed(str(error), pgid, signal_identity_safe=True)
                raise
            next_group_scan = time.monotonic() + GROUP_SCAN_SECONDS
            if not members:
                disable_termination_handlers(signal_state)
                try:
                    reap_guardian(guardian_pid)
                except WaitabilityLost as error:
                    if post_go:
                        fail_closed(str(error), signal_identity_safe=False)
                    raise ContainmentError(str(error)) from error
                return
        if time.monotonic() >= proof_deadline:
            identities = ",".join(
                f"{member.pid}:{member.start_time}" for member in members
            )
            if result is None:
                message = f"guardian {guardian_pid} did not exit during group drain"
            else:
                message = f"process group {pgid} did not drain ({identities})"
            if post_go:
                fail_closed(message, pgid, signal_identity_safe=True)
            raise ContainmentError(message)
        time.sleep(POLL_SECONDS)


def drain_verified_group(
    guardian_pid: int,
    pgid: int,
    grace: float,
    post_go: bool,
    signal_state: GroupSignalState,
) -> None:
    try:
        initial_result = waitid_nowait(guardian_pid)
    except WaitabilityLost as error:
        if post_go:
            fail_closed(str(error), signal_identity_safe=False)
        raise ContainmentError(str(error)) from error
    if initial_result is not None:
        try:
            initial_members = group_members(pgid, guardian_pid)
        except ContainmentError as error:
            if post_go:
                fail_closed(str(error), pgid, signal_identity_safe=True)
            raise
        if not initial_members:
            prove_and_reap(
                guardian_pid,
                pgid,
                time.monotonic() + GROUP_PROOF_SECONDS,
                post_go,
                signal_state,
            )
            return
    try:
        send_group_signal(pgid, signal.SIGTERM, signal_state)
    except BaseException as error:
        if post_go:
            fail_closed(f"TERM signaling failed: {error}", pgid, True)
        raise ContainmentError("verified setup group TERM failed") from error
    term_deadline = time.monotonic() + grace
    next_group_scan = 0.0
    while True:
        try:
            result = waitid_nowait(guardian_pid)
        except WaitabilityLost as error:
            if post_go:
                fail_closed(str(error), signal_identity_safe=False)
            raise ContainmentError(str(error)) from error
        now = time.monotonic()
        if result is not None and now >= next_group_scan:
            try:
                members = group_members(pgid, guardian_pid)
            except ContainmentError as error:
                if post_go:
                    fail_closed(str(error), pgid, True)
                raise
            next_group_scan = time.monotonic() + GROUP_SCAN_SECONDS
            if not members:
                prove_and_reap(
                    guardian_pid,
                    pgid,
                    time.monotonic() + GROUP_PROOF_SECONDS,
                    post_go,
                    signal_state,
                )
                return
        if time.monotonic() >= term_deadline:
            break
        time.sleep(POLL_SECONDS)
    try:
        send_group_signal(pgid, signal.SIGKILL, signal_state)
    except BaseException as error:
        if post_go:
            fail_closed(f"KILL signaling failed: {error}", pgid, True)
        raise ContainmentError("verified setup group KILL failed") from error
    prove_and_reap(
        guardian_pid,
        pgid,
        time.monotonic() + GROUP_PROOF_SECONDS,
        post_go,
        signal_state,
    )


def monitor_launched_group(
    arguments: Arguments,
    guardian_pid: int,
    pgid: int,
    linger_descriptor: int,
    absolute_deadline: float,
    stop_channel: StopChannel | None,
    control_ownership: ControlOwnership | None,
    signal_state: GroupSignalState,
) -> int:
    termination_reason: int | None = None
    term_sent_at = 0.0
    kill_sent_at = 0.0
    term_sent = False
    kill_sent = False
    linger_observed = False
    members: list[ProcessIdentity] = []
    next_group_scan = 0.0
    authenticated_stop = False
    ack_eligible = False
    authenticated_connection: socket.socket | None = None
    server_stop_deadline: float | None = None

    def request_interruption(signum: int, _frame: object) -> None:
        nonlocal termination_reason
        if signal_state.active and termination_reason is None:
            termination_reason = min(255, 128 + signum)

    def finish_group(return_code: int) -> int:
        nonlocal ack_eligible, authenticated_connection, server_stop_deadline
        prove_and_reap(
            guardian_pid,
            pgid,
            time.monotonic() + GROUP_PROOF_SECONDS,
            post_go=True,
            signal_state=signal_state,
        )
        if (
            authenticated_stop
            and server_stop_deadline is not None
            and time.monotonic() >= server_stop_deadline
        ):
            ack_eligible = False
        os.close(linger_descriptor)
        if (
            arguments.hooks is not None
            and arguments.hooks.fault == "supervisor-post-reap-pause"
        ):
            write_test_record(arguments.hooks.record, os.getpid())
            time.sleep(0.5)
            if signal_state.attempts_after_disable != 0:
                raise ContainmentError(
                    "post-reap hook observed a forbidden process-group signal"
                )
            write_test_record(
                arguments.hooks.record.with_suffix(".signal-proof"), os.getpid()
            )
        if authenticated_stop and arguments.hooks is not None:
            if arguments.hooks.fault == "supervisor-cleanup-deadline-within":
                time.sleep(0.1)
            elif arguments.hooks.fault == "supervisor-cleanup-deadline-exhausted":
                assert server_stop_deadline is not None
                time.sleep(
                    max(0.0, server_stop_deadline - time.monotonic())
                    + POLL_SECONDS
                )
        if (
            authenticated_stop
            and server_stop_deadline is not None
            and time.monotonic() >= server_stop_deadline
        ):
            ack_eligible = False
        if termination_reason is not None:
            return_code = termination_reason
        try:
            cleanup_stop_metadata(
                stop_channel,
                arguments.control_file,
                control_ownership,
                server_stop_deadline if authenticated_stop else None,
                arguments.hooks,
            )
        except (ContainmentError, OSError) as cleanup_error:
            if authenticated_connection is not None:
                authenticated_connection.close()
                authenticated_connection = None
            print(
                f"managed deadline stop metadata cleanup failed: {cleanup_error}",
                file=sys.stderr,
            )
            return INTERNAL_FAILURE
        if (
            authenticated_stop
            and server_stop_deadline is not None
            and time.monotonic() >= server_stop_deadline
        ):
            ack_eligible = False
        if authenticated_stop:
            if (
                authenticated_connection is None
                or return_code != 143
                or server_stop_deadline is None
                or not ack_eligible
            ):
                if authenticated_connection is not None:
                    authenticated_connection.close()
                print(
                    "managed deadline authenticated stop lost its acknowledgement state",
                    file=sys.stderr,
                )
                return INTERNAL_FAILURE
            acknowledge_stop_and_exit(
                authenticated_connection, server_stop_deadline
            )
        return return_code

    for signal_number in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(signal_number, request_interruption)
    signal.pthread_sigmask(
        signal.SIG_UNBLOCK, {signal.SIGTERM, signal.SIGINT, signal.SIGHUP}
    )
    if os.getppid() != arguments.expected_parent_pid:
        request_interruption(signal.SIGTERM, None)

    while True:
        if termination_reason is None and stop_channel is not None:
            try:
                accepted_stop = poll_stop_channel(stop_channel)
            except (ContainmentError, OSError, ValueError) as channel_error:
                print(
                    f"managed deadline stop channel failed: {channel_error}",
                    file=sys.stderr,
                )
                termination_reason = INTERNAL_FAILURE
            else:
                if accepted_stop is not None:
                    authenticated_stop = True
                    ack_eligible = True
                    authenticated_connection = accepted_stop.connection
                    server_stop_deadline = accepted_stop.deadline
                    if (
                        arguments.hooks is not None
                        and arguments.hooks.fault == "supervisor-post-auth-pause"
                    ):
                        write_test_record(arguments.hooks.record, os.getpid())
                        time.sleep(0.5)
                    termination_reason = 143
        try:
            linger_payload = os.read(linger_descriptor, 128)
        except BlockingIOError:
            linger_payload = b""
        if linger_payload:
            linger_observed = True
        try:
            result = waitid_nowait(guardian_pid)
        except WaitabilityLost as error:
            fail_closed(str(error), signal_identity_safe=False)

        now = time.monotonic()
        if (
            authenticated_stop
            and server_stop_deadline is not None
            and now >= server_stop_deadline
        ):
            ack_eligible = False
        if termination_reason is None and linger_observed:
            termination_reason = INTERNAL_FAILURE
        elif termination_reason is None and now >= absolute_deadline:
            termination_reason = 124

        if termination_reason is not None and not term_sent:
            term_sent_at = now
            send_group_signal(pgid, signal.SIGTERM, signal_state)
            term_sent = True

        if termination_reason is None and result is None:
            time.sleep(POLL_SECONDS)
            continue

        members_current = False
        if result is not None and now >= next_group_scan:
            try:
                members = group_members(pgid, guardian_pid)
            except ContainmentError as error:
                fail_closed(str(error), pgid, signal_identity_safe=True)
            members_current = True
            next_group_scan = time.monotonic() + GROUP_SCAN_SECONDS
            now = time.monotonic()

        if termination_reason is None and result is not None:
            if not members_current:
                time.sleep(POLL_SECONDS)
                continue
            if members:
                termination_reason = INTERNAL_FAILURE
                term_sent_at = now
                send_group_signal(pgid, signal.SIGTERM, signal_state)
                term_sent = True
            else:
                return_code = guardian_return_code(result)
                return finish_group(return_code)

        if termination_reason is not None:
            now = time.monotonic()
            if not term_sent:
                term_sent_at = now
                send_group_signal(pgid, signal.SIGTERM, signal_state)
                term_sent = True
            term_deadline = term_sent_at + arguments.grace
            if authenticated_stop and server_stop_deadline is not None:
                reserved_teardown = GROUP_PROOF_SECONDS + STOP_ACK_SLACK_SECONDS
                term_deadline = min(
                    term_deadline,
                    max(term_sent_at, server_stop_deadline - reserved_teardown),
                )
            if not kill_sent and now >= term_deadline:
                send_group_signal(pgid, signal.SIGKILL, signal_state)
                kill_sent = True
                kill_sent_at = time.monotonic()
            if result is not None and members_current and not members:
                return finish_group(termination_reason)
            now = time.monotonic()
            kill_proof_deadline = kill_sent_at + GROUP_PROOF_SECONDS
            if kill_sent and now >= kill_proof_deadline:
                if result is not None:
                    try:
                        members = group_members(pgid, guardian_pid)
                    except ContainmentError as error:
                        fail_closed(str(error), pgid, signal_identity_safe=True)
                    if not members:
                        return finish_group(termination_reason)
                identities = ",".join(
                    f"{member.pid}:{member.start_time}" for member in members
                )
                detail = (
                    f"process group {pgid} survived KILL ({identities})"
                    if result is not None
                    else f"guardian {guardian_pid} survived group KILL"
                )
                fail_closed(
                    detail,
                    pgid,
                    signal_identity_safe=True,
                )
        time.sleep(POLL_SECONDS)


def supervise(arguments: Arguments) -> int:
    supervision_started = time.monotonic()
    absolute_deadline = supervision_started + arguments.duration
    if os.getppid() != arguments.expected_parent_pid:
        raise ContainmentError("supervisor expected parent was already absent")
    normalize_setup_signals()
    prctl(PR_SET_PDEATHSIG, signal.SIGTERM)
    if os.getppid() != arguments.expected_parent_pid:
        raise ContainmentError("supervisor parent exited while arming parent death")
    supervisor_identity = proc_identity(os.getpid())
    if (
        arguments.hooks is not None
        and arguments.hooks.fault == "supervisor-parent-death-armed"
    ):
        write_test_record(arguments.hooks.record, os.getpid())
        while True:
            time.sleep(60)

    ready_read, ready_write = os.pipe2(os.O_CLOEXEC)
    linger_read, linger_write = os.pipe2(os.O_CLOEXEC | os.O_NONBLOCK)
    go_read, go_write = os.pipe2(os.O_CLOEXEC)
    launch_ack_read, launch_ack_write = os.pipe2(os.O_CLOEXEC)
    supervisor_pid = os.getpid()
    guardian_pid = os.fork()
    if guardian_pid == 0:
        os.close(ready_read)
        os.close(linger_read)
        os.close(go_write)
        os.close(launch_ack_read)
        try:
            guardian(
                arguments.command,
                supervisor_pid,
                ready_write,
                linger_write,
                go_read,
                launch_ack_write,
                arguments.hooks,
            )
        except BaseException:
            os._exit(INTERNAL_FAILURE)

    os.close(ready_write)
    os.close(linger_write)
    os.close(go_read)
    os.close(launch_ack_write)
    verified = False
    launch_possible = False
    control_ownership: ControlOwnership | None = None
    stop_channel: StopChannel | None = None
    signal_state = GroupSignalState()
    pgid = 0
    try:
        if (
            arguments.hooks is not None
            and arguments.hooks.fault == "guardian-readiness-timeout"
        ):
            record_deadline = time.monotonic() + READY_SECONDS
            while not arguments.hooks.record.is_file():
                if waitid_nowait(guardian_pid) is not None:
                    raise ContainmentError(
                        "readiness-timeout guardian exited before its test record"
                    )
                if time.monotonic() >= record_deadline:
                    raise ContainmentError(
                        "readiness-timeout guardian omitted its test record"
                    )
                time.sleep(POLL_SECONDS)
        ready_seconds = (
            FAULT_READY_SECONDS
            if arguments.hooks is not None
            and arguments.hooks.fault == "guardian-readiness-timeout"
            else READY_SECONDS
        )
        ready_seconds = min(ready_seconds, absolute_deadline - time.monotonic())
        if ready_seconds <= 0:
            raise DeadlineExpired("absolute deadline expired before guardian readiness")
        ready_payload = read_bounded_pipe(ready_read, ready_seconds)
        os.close(ready_read)
        ready_read = -1
        if ready_payload != f"READY|{guardian_pid}\n".encode("ascii"):
            if time.monotonic() >= absolute_deadline:
                raise DeadlineExpired(
                    "absolute deadline expired while awaiting guardian readiness"
                )
            raise ContainmentError("guardian readiness was invalid or timed out")
        guardian_identity = proc_identity(guardian_pid)
        pgid = guardian_identity.pgid
        if pgid != guardian_pid:
            raise ContainmentError(
                "guardian did not establish a dedicated process group"
            )
        if waitid_nowait(guardian_pid) is not None:
            raise ContainmentError("guardian exited before control verification")
        verified = True
        signal.pthread_sigmask(
            signal.SIG_BLOCK, {signal.SIGTERM, signal.SIGINT, signal.SIGHUP}
        )
        if time.monotonic() >= absolute_deadline:
            raise DeadlineExpired("absolute deadline expired before control publication")
        if arguments.control_file is not None:
            stop_channel = create_stop_channel(
                arguments.control_file, arguments.hooks, guardian_identity
            )
            control_ownership = publish_control_file(
                arguments.control_file,
                supervisor_identity,
                guardian_identity,
                stop_channel,
                arguments.hooks,
            )

        if time.monotonic() >= absolute_deadline:
            raise DeadlineExpired("absolute deadline expired before guardian GO")
        if os.getppid() != arguments.expected_parent_pid:
            raise ContainmentError("supervisor parent exited before guardian GO")
        if signal.sigpending().intersection(
            {signal.SIGTERM, signal.SIGINT, signal.SIGHUP}
        ):
            raise ContainmentError("supervisor interruption was pending before guardian GO")
        launch_possible = True
        write_all(go_write, b"GO\n")
        os.close(go_write)
        go_write = -1
        launch_ack_seconds = min(
            READY_SECONDS, absolute_deadline - time.monotonic()
        )
        if launch_ack_seconds <= 0:
            raise DeadlineExpired("absolute deadline expired before launch ACK")
        launch_ack = read_bounded_pipe(launch_ack_read, launch_ack_seconds)
        os.close(launch_ack_read)
        launch_ack_read = -1
        if not launch_ack.startswith(b"LAUNCHED|") or not launch_ack.endswith(b"\n"):
            if time.monotonic() >= absolute_deadline:
                raise DeadlineExpired(
                    "absolute deadline expired while awaiting launch ACK"
                )
            raise ContainmentError("guardian launch acknowledgment was invalid")
        command_pid_text = launch_ack[len(b"LAUNCHED|") : -1].decode("ascii")
        if not command_pid_text.isdecimal() or int(command_pid_text) <= 0:
            raise ContainmentError("guardian launch acknowledgment PID was invalid")
        command_pid = int(command_pid_text)
        if (
            arguments.hooks is not None
            and arguments.hooks.fault == "supervisor-post-launch-oserror"
        ):
            hook_deadline = time.monotonic() + READY_SECONDS
            while True:
                identity = proc_identity(command_pid)
                if identity.pgid != pgid:
                    raise ContainmentError(
                        "post-launch test command escaped the verified group"
                    )
                if process_ignores_signal(command_pid, signal.SIGTERM):
                    break
                if time.monotonic() >= hook_deadline:
                    raise ContainmentError(
                        "post-launch test command did not arm TERM ignore"
                    )
                time.sleep(POLL_SECONDS)
            write_test_record(arguments.hooks.record, command_pid)
            raise OSError("injected supervisor post-launch OSError")
        return monitor_launched_group(
            arguments,
            guardian_pid,
            pgid,
            linger_read,
            absolute_deadline,
            stop_channel,
            control_ownership,
            signal_state,
        )
    except BaseException as error:
        for descriptor in (ready_read, go_write, launch_ack_read):
            if descriptor >= 0:
                try:
                    os.close(descriptor)
                except OSError:
                    pass
        if not verified:
            try:
                kill_unverified_guardian(guardian_pid)
            except ContainmentError as cleanup_error:
                raise ContainmentError(
                    f"{error}; unverified guardian cleanup failed: {cleanup_error}"
                ) from cleanup_error
            if isinstance(error, DeadlineExpired):
                return 124
            if isinstance(error, (KeyboardInterrupt, SystemExit)):
                return INTERNAL_FAILURE
            raise
        post_go = launch_possible
        try:
            drain_verified_group(
                guardian_pid,
                pgid,
                arguments.grace,
                post_go=post_go,
                signal_state=signal_state,
            )
        except BaseException as cleanup_error:
            if post_go:
                fail_closed(
                    f"post-GO exception drain failed: {cleanup_error}",
                    pgid,
                    signal_identity_safe=not isinstance(
                        cleanup_error, WaitabilityLost
                    ),
                )
            if isinstance(
                error, (OwnedControlCleanupError, OwnedEndpointCleanupError)
            ):
                fail_closed(
                    "owned capability cleanup failed and verified setup drain "
                    f"was not proved: {error}; {cleanup_error}",
                    signal_identity_safe=False,
                )
            raise ContainmentError(
                f"{error}; verified setup cleanup failed: {cleanup_error}"
            ) from cleanup_error
        try:
            cleanup_stop_metadata(
                stop_channel, arguments.control_file, control_ownership
            )
        except BaseException as cleanup_error:
            print(
                f"managed deadline metadata cleanup failed: {cleanup_error}",
                file=sys.stderr,
            )
            return INTERNAL_FAILURE
        if post_go:
            print(f"managed deadline post-GO failure: {error}", file=sys.stderr)
            return 124 if isinstance(error, DeadlineExpired) else INTERNAL_FAILURE
        if isinstance(error, DeadlineExpired):
            return 124
        if isinstance(error, (KeyboardInterrupt, SystemExit)):
            return INTERNAL_FAILURE
        raise


def main() -> int:
    if not linux_supported():
        print("SKIP: managed deadlines require Linux /proc", file=sys.stderr)
        return SKIP_UNSUPPORTED
    arguments = parse_arguments()
    try:
        if isinstance(arguments, StopRequestArguments):
            return request_stop(arguments)
        return supervise(arguments)
    except (ContainmentError, OSError, ValueError) as error:
        print(f"managed deadline setup failed: {error}", file=sys.stderr)
        return INTERNAL_FAILURE


if __name__ == "__main__":
    raise SystemExit(main())
