#!/usr/bin/python3.12
"""Root-only durable state authority for Codestead public ingress."""

from __future__ import annotations

import argparse
from dataclasses import dataclass
import os
from pathlib import Path
import re
import secrets
import stat
import sys


PRODUCTION_CONTROL_DIR = Path("/var/lib/learncoding/ingress-control")
QUARANTINE_NAME = "release-quarantine"
RECOVERY_STATE_NAME = "recovery-state.env"
EXHAUSTED_NAME = "recovery-exhausted"
QUARANTINE_BYTES = b"codestead-release-quarantine-v1\n"
EXHAUSTED_BYTES = b"codestead-ingress-recovery-exhausted-v1\n"
BACKOFF_SECONDS = (30, 60, 120, 240)
MAX_ATTEMPTS = 5
MAX_EPOCH = 9_223_372_036_854_775_807
STATE_PATTERN = re.compile(
    rb"schema=1\n"
    rb"failure_count=([1-4])\n"
    rb"incident_started_epoch=(0|[1-9][0-9]*)\n"
    rb"next_attempt_epoch=(0|[1-9][0-9]*)\n"
)


class ControlError(RuntimeError):
    """Raised when ingress control state cannot be trusted or persisted."""


@dataclass(frozen=True)
class RecoveryState:
    failure_count: int
    incident_started_epoch: int
    next_attempt_epoch: int


def _require_root() -> None:
    if os.geteuid() != 0:
        raise ControlError("ingress control requires root")


def _absolute_lexical(path: Path) -> Path:
    if not path.is_absolute():
        raise ControlError("control path must be absolute")
    return Path(os.path.abspath(os.path.normpath(os.fspath(path))))


def _assert_secure_directory(path: Path, *, exact_mode: int | None = None) -> None:
    try:
        metadata = os.lstat(path)
    except OSError as error:
        raise ControlError(f"control directory is unavailable: {path}") from error
    if not stat.S_ISDIR(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode):
        raise ControlError(f"control directory is not a real directory: {path}")
    if metadata.st_uid != 0 or metadata.st_gid != 0:
        raise ControlError(f"control directory must be owned by root:root: {path}")
    mode = stat.S_IMODE(metadata.st_mode)
    if exact_mode is not None and mode != exact_mode:
        raise ControlError(f"control directory must use mode {exact_mode:04o}: {path}")
    if mode & 0o022:
        raise ControlError(f"control directory ancestry must not be group/world writable: {path}")


def _validate_path_components(control: Path) -> None:
    control = _absolute_lexical(control)
    try:
        resolved = control.resolve(strict=True)
    except OSError as error:
        raise ControlError("control directory cannot be resolved") from error
    if resolved != control:
        raise ControlError("control directory must not contain symlink components")

    if control == PRODUCTION_CONTROL_DIR:
        current = Path("/")
        _assert_secure_directory(current)
        for component in control.parts[1:]:
            current /= component
            _assert_secure_directory(current, exact_mode=0o700 if current == control else None)
    else:
        boundary = control.parent
        _assert_secure_directory(boundary)
        _assert_secure_directory(control, exact_mode=0o700)


def ensure_control_directory(control: Path) -> None:
    """Create a test control child or validate an existing production directory."""
    _require_root()
    control = _absolute_lexical(control)
    parent = control.parent
    _assert_secure_directory(parent)
    if not control.exists():
        try:
            os.mkdir(control, 0o700)
            os.chown(control, 0, 0)
            os.chmod(control, 0o700)
            parent_descriptor = os.open(parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            try:
                os.fsync(parent_descriptor)
            finally:
                os.close(parent_descriptor)
        except OSError as error:
            raise ControlError("unable to create ingress control directory") from error
    _validate_path_components(control)


def _assert_state_file(path: Path) -> os.stat_result:
    try:
        metadata = os.lstat(path)
    except OSError as error:
        raise ControlError(f"unable to inspect ingress control state: {path.name}") from error
    if not stat.S_ISREG(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode):
        raise ControlError(f"ingress control state must be a regular non-symlink: {path.name}")
    if metadata.st_uid != 0 or metadata.st_gid != 0:
        raise ControlError(f"ingress control state must be owned by root:root: {path.name}")
    if stat.S_IMODE(metadata.st_mode) != 0o600:
        raise ControlError(f"ingress control state must use mode 0600: {path.name}")
    if metadata.st_nlink != 1:
        raise ControlError(f"ingress control state must have exactly one link: {path.name}")
    return metadata


def _read_state_file(path: Path) -> bytes | None:
    try:
        _assert_state_file(path)
    except FileNotFoundError:
        return None
    except ControlError:
        if not path.exists() and not path.is_symlink():
            return None
        raise
    try:
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
        try:
            metadata = os.fstat(descriptor)
            lexical = os.lstat(path)
            if (metadata.st_dev, metadata.st_ino) != (lexical.st_dev, lexical.st_ino):
                raise ControlError(f"ingress control state changed during validation: {path.name}")
            payload = os.read(descriptor, 4097)
            if len(payload) > 4096 or os.read(descriptor, 1):
                raise ControlError(f"ingress control state is oversized: {path.name}")
            return payload
        finally:
            os.close(descriptor)
    except ControlError:
        raise
    except OSError as error:
        raise ControlError(f"unable to read ingress control state: {path.name}") from error


def _validate_exact_marker(control: Path, name: str, expected: bytes) -> bool:
    payload = _read_state_file(control / name)
    if payload is None:
        return False
    if payload != expected:
        raise ControlError(f"ingress control marker is malformed: {name}")
    return True


def _fsync_directory(control: Path) -> None:
    descriptor = os.open(control, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def _atomic_write(control: Path, name: str, payload: bytes) -> None:
    _validate_path_components(control)
    destination = control / name
    if destination.exists() or destination.is_symlink():
        _assert_state_file(destination)
    temporary = control / f".{name}.tmp.{os.getpid()}.{secrets.token_hex(8)}"
    descriptor = -1
    published = False
    try:
        descriptor = os.open(
            temporary,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
            0o600,
        )
        os.fchown(descriptor, 0, 0)
        os.fchmod(descriptor, 0o600)
        remaining = memoryview(payload)
        while remaining:
            written = os.write(descriptor, remaining)
            if written <= 0:
                raise OSError("short write")
            remaining = remaining[written:]
        os.fsync(descriptor)
        os.close(descriptor)
        descriptor = -1
        os.replace(temporary, destination)
        published = True
        _fsync_directory(control)
    except ControlError:
        raise
    except OSError as error:
        raise ControlError(f"unable to publish ingress control state: {name}") from error
    finally:
        if descriptor >= 0:
            os.close(descriptor)
        if not published:
            try:
                os.unlink(temporary)
            except FileNotFoundError:
                pass


def _durable_remove(control: Path, name: str, *, required: bool) -> None:
    _validate_path_components(control)
    target = control / name
    payload = _read_state_file(target)
    if payload is None:
        if required:
            raise ControlError(f"ingress control state is absent: {name}")
        return
    try:
        os.unlink(target)
        _fsync_directory(control)
    except OSError as error:
        raise ControlError(f"unable to remove ingress control state: {name}") from error


def create_release_quarantine(control: Path) -> None:
    _validate_path_components(control)
    if _validate_exact_marker(control, QUARANTINE_NAME, QUARANTINE_BYTES):
        return
    _atomic_write(control, QUARANTINE_NAME, QUARANTINE_BYTES)


def clear_release_quarantine(control: Path) -> None:
    if not _validate_exact_marker(control, QUARANTINE_NAME, QUARANTINE_BYTES):
        raise ControlError("release quarantine is absent")
    _durable_remove(control, QUARANTINE_NAME, required=True)


def read_recovery_state(control: Path) -> RecoveryState:
    payload = _read_state_file(control / RECOVERY_STATE_NAME)
    if payload is None:
        raise ControlError("recovery state is absent")
    match = STATE_PATTERN.fullmatch(payload)
    if match is None:
        raise ControlError("recovery state is malformed")
    count, incident, next_attempt = (int(value) for value in match.groups())
    if incident > MAX_EPOCH or next_attempt > MAX_EPOCH:
        raise ControlError("recovery state epoch is out of range")
    minimum_next = incident + sum(BACKOFF_SECONDS[:count])
    if next_attempt < minimum_next or next_attempt > MAX_EPOCH:
        raise ControlError("recovery state chronology is invalid")
    return RecoveryState(count, incident, next_attempt)


def _optional_recovery_state(control: Path) -> RecoveryState | None:
    if _read_state_file(control / RECOVERY_STATE_NAME) is None:
        return None
    return read_recovery_state(control)


def status(control: Path, now: int) -> str:
    _validate_now(now)
    _validate_path_components(control)
    quarantined = _validate_exact_marker(control, QUARANTINE_NAME, QUARANTINE_BYTES)
    exhausted = _validate_exact_marker(control, EXHAUSTED_NAME, EXHAUSTED_BYTES)
    state = _optional_recovery_state(control)
    if quarantined:
        return "release-quarantined"
    if exhausted:
        return "recovery-exhausted"
    if state is None:
        return "clear"
    if now < state.next_attempt_epoch:
        return f"recovery-wait:{state.next_attempt_epoch - now}"
    return f"recovery-ready:{state.failure_count}"


def _validate_now(now: int) -> None:
    if isinstance(now, bool) or now < 0 or now > MAX_EPOCH:
        raise ControlError("epoch must be a canonical non-negative integer")


def record_failure(control: Path, now: int) -> str:
    _validate_now(now)
    _validate_path_components(control)
    if _validate_exact_marker(control, QUARANTINE_NAME, QUARANTINE_BYTES):
        raise ControlError("release quarantine blocks recovery state mutation")
    if _validate_exact_marker(control, EXHAUSTED_NAME, EXHAUSTED_BYTES):
        raise ControlError("recovery is exhausted; explicit reset is required")
    previous = _optional_recovery_state(control)
    if previous is not None and now < previous.next_attempt_epoch:
        raise ControlError("recovery backoff has not elapsed")
    failure_count = 1 if previous is None else previous.failure_count + 1
    incident_started = now if previous is None else previous.incident_started_epoch
    if failure_count >= MAX_ATTEMPTS:
        _atomic_write(control, EXHAUSTED_NAME, EXHAUSTED_BYTES)
        return "recovery-exhausted"
    wait = BACKOFF_SECONDS[failure_count - 1]
    if now > MAX_EPOCH - wait:
        raise ControlError("recovery state epoch would overflow")
    next_attempt = now + wait
    payload = (
        f"schema=1\n"
        f"failure_count={failure_count}\n"
        f"incident_started_epoch={incident_started}\n"
        f"next_attempt_epoch={next_attempt}\n"
    ).encode("ascii")
    _atomic_write(control, RECOVERY_STATE_NAME, payload)
    return f"recovery-wait:{wait}"


def record_success(control: Path) -> None:
    _validate_path_components(control)
    if _validate_exact_marker(control, QUARANTINE_NAME, QUARANTINE_BYTES):
        raise ControlError("release quarantine blocks recovery success")
    if _validate_exact_marker(control, EXHAUSTED_NAME, EXHAUSTED_BYTES):
        raise ControlError("recovery exhaustion requires explicit reset")
    if _optional_recovery_state(control) is not None:
        _durable_remove(control, RECOVERY_STATE_NAME, required=True)


def reset_recovery(control: Path) -> None:
    _validate_path_components(control)
    _validate_exact_marker(control, QUARANTINE_NAME, QUARANTINE_BYTES)
    _validate_exact_marker(control, EXHAUSTED_NAME, EXHAUSTED_BYTES)
    _optional_recovery_state(control)
    _durable_remove(control, RECOVERY_STATE_NAME, required=False)
    _durable_remove(control, EXHAUSTED_NAME, required=False)


def resolve_control_directory(test_harness_root: str | None) -> Path:
    _require_root()
    if test_harness_root is None:
        control = PRODUCTION_CONTROL_DIR
        _validate_path_components(control)
        return control
    root = _absolute_lexical(Path(test_harness_root))
    try:
        resolved = root.resolve(strict=True)
    except OSError as error:
        raise ControlError("test harness root is unavailable") from error
    if resolved != root:
        raise ControlError("test harness root must not contain symlink components")
    metadata = os.lstat(root)
    if (
        not stat.S_ISDIR(metadata.st_mode)
        or stat.S_ISLNK(metadata.st_mode)
        or metadata.st_uid != 0
        or metadata.st_gid != 0
        or stat.S_IMODE(metadata.st_mode) != 0o700
    ):
        raise ControlError("test harness root must be root:root mode 0700")
    control = root / "control"
    ensure_control_directory(control)
    return control


def _epoch(value: str) -> int:
    if not re.fullmatch(r"0|[1-9][0-9]*", value):
        raise argparse.ArgumentTypeError("epoch must be a canonical non-negative integer")
    parsed = int(value)
    if parsed > MAX_EPOCH:
        raise argparse.ArgumentTypeError("epoch is out of range")
    return parsed


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--test-harness-root")
    commands = parser.add_subparsers(dest="command", required=True)
    status_parser = commands.add_parser("status")
    status_parser.add_argument("--now", required=True, type=_epoch)
    commands.add_parser("quarantine-create")
    commands.add_parser("quarantine-clear")
    failure_parser = commands.add_parser("record-failure")
    failure_parser.add_argument("--now", required=True, type=_epoch)
    commands.add_parser("record-success")
    commands.add_parser("reset-recovery")
    return parser


def main(arguments: list[str] | None = None) -> int:
    options = build_parser().parse_args(arguments)
    control = resolve_control_directory(options.test_harness_root)
    if options.command == "status":
        print(status(control, options.now))
    elif options.command == "quarantine-create":
        create_release_quarantine(control)
    elif options.command == "quarantine-clear":
        clear_release_quarantine(control)
    elif options.command == "record-failure":
        print(record_failure(control, options.now))
    elif options.command == "record-success":
        record_success(control)
    elif options.command == "reset-recovery":
        reset_recovery(control)
    else:  # pragma: no cover - argparse enforces the command set
        raise ControlError("unknown ingress control command")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except ControlError as error:
        print(f"fatal: {error}", file=sys.stderr)
        raise SystemExit(1) from None
