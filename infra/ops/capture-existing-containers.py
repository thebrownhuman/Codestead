#!/usr/bin/python3
"""Atomically capture the reviewed identity of pre-existing NUC containers."""

from __future__ import annotations

import os
import pathlib
import re
import secrets
import signal
import stat
import subprocess
import sys
from collections.abc import Callable
from typing import Final

sys.dont_write_bytecode = True

from existing_container_baseline import (
    MAXIMUM_INSPECTION_BYTES,
    BaselineContractError,
    ContainerIdentity,
    identity_from_inspection,
    serialize_baseline,
)

try:
    import fcntl
except ImportError:  # pragma: no cover - production is Linux-only
    fcntl = None  # type: ignore[assignment]


DOCKER: Final = "/usr/bin/docker"
DESTINATION: Final = "/etc/learncoding/existing-containers.txt"
LOCK_PATH: Final = "/run/lock/learncoding-existing-containers.lock"
MAXIMUM_LIST_BYTES: Final = 16_384
MAXIMUM_CONTAINERS: Final = 128
_NAME_PATTERN: Final = re.compile(rb"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}")
_CONTAINER_ID_PATTERN: Final = re.compile(rb"[0-9a-f]{64}")


class CaptureError(RuntimeError):
    """The existing-container inventory could not be captured safely."""


Runner = Callable[[tuple[str, ...], int], bytes]


def _inventory_snapshot(run: Runner) -> dict[str, str]:
    raw = run(
        ("ps", "--no-trunc", "--format", "{{.ID}}\t{{.Names}}"),
        MAXIMUM_LIST_BYTES,
    )
    lines = raw.split(b"\n")
    if lines and lines[-1] == b"":
        lines.pop()
    if not lines or len(lines) > MAXIMUM_CONTAINERS:
        raise CaptureError("running container inventory is empty or excessive")
    snapshot: dict[str, str] = {}
    identifiers: set[str] = set()
    for encoded in lines:
        pieces = encoded.split(b"\t")
        if (
            len(pieces) != 2
            or _CONTAINER_ID_PATTERN.fullmatch(pieces[0]) is None
            or _NAME_PATTERN.fullmatch(pieces[1]) is None
        ):
            raise CaptureError("running container inventory is malformed")
        container_id = pieces[0].decode("ascii")
        name = pieces[1].decode("ascii")
        if name in snapshot or container_id in identifiers:
            raise CaptureError("running container inventory contains a duplicate")
        if name.startswith("learncoding-"):
            raise CaptureError("Codestead must be stopped before baseline capture")
        snapshot[name] = container_id
        identifiers.add(container_id)
    return snapshot


def capture_records(run: Runner) -> list[ContainerIdentity]:
    """Capture a stable ID/name snapshot without returning raw configuration."""

    initial = _inventory_snapshot(run)
    records: list[ContainerIdentity] = []
    for name, container_id in sorted(initial.items()):
        try:
            raw_inspection = run(
                ("inspect", "--type", "container", container_id),
                MAXIMUM_INSPECTION_BYTES,
            )
            record = identity_from_inspection(raw_inspection, expected_name=name)
            if record.container_id != container_id:
                raise CaptureError("Docker inspection container ID changed during capture")
            records.append(record)
        except BaselineContractError as error:
            raise CaptureError("a running container is not safely restartable and healthy") from error
    if _inventory_snapshot(run) != initial:
        raise CaptureError("running container inventory changed during capture")
    return records


def _docker_runner(arguments: tuple[str, ...], limit: int) -> bytes:
    try:
        metadata = os.lstat(DOCKER)
    except OSError as error:
        raise CaptureError("reviewed Docker client is unavailable") from error
    if (
        not stat.S_ISREG(metadata.st_mode)
        or metadata.st_uid != 0
        or stat.S_IMODE(metadata.st_mode) & 0o022
        or not metadata.st_mode & stat.S_IXUSR
    ):
        raise CaptureError("reviewed Docker client is not trusted")
    try:
        result = subprocess.run(
            (DOCKER, *arguments),
            check=False,
            close_fds=True,
            cwd="/",
            env={
                "DOCKER_CONFIG": "/nonexistent",
                "HOME": "/nonexistent",
                "LANG": "C",
                "LC_ALL": "C",
                "PATH": "/usr/bin:/bin",
                "XDG_CONFIG_HOME": "/nonexistent",
            },
            input=b"",
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            timeout=15,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        raise CaptureError("bounded Docker inspection failed") from error
    if result.returncode != 0 or len(result.stdout) > limit:
        raise CaptureError("bounded Docker inspection failed")
    return result.stdout


def _open_lock() -> int:
    flags = os.O_RDWR | os.O_CREAT | os.O_CLOEXEC
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    descriptor = os.open(LOCK_PATH, flags, 0o600)
    metadata = os.fstat(descriptor)
    if not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != 0 or metadata.st_gid != 0:
        os.close(descriptor)
        raise CaptureError("capture lock is not trusted")
    os.fchmod(descriptor, 0o600)
    if fcntl is None:
        os.close(descriptor)
        raise CaptureError("POSIX file locking is unavailable")
    fcntl.flock(descriptor, fcntl.LOCK_EX)
    return descriptor


def _validate_destination_parent() -> int:
    parent = pathlib.PurePosixPath(DESTINATION).parent
    flags = os.O_RDONLY | os.O_CLOEXEC
    if hasattr(os, "O_DIRECTORY"):
        flags |= os.O_DIRECTORY
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    descriptor = os.open(str(parent), flags)
    metadata = os.fstat(descriptor)
    if (
        not stat.S_ISDIR(metadata.st_mode)
        or metadata.st_uid != 0
        or metadata.st_gid != 0
        or stat.S_IMODE(metadata.st_mode) & 0o022
    ):
        os.close(descriptor)
        raise CaptureError("baseline parent directory is not trusted")
    return descriptor


def _validate_existing(parent_fd: int, *, replace: bool) -> None:
    name = pathlib.PurePosixPath(DESTINATION).name
    try:
        metadata = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
    except FileNotFoundError:
        return
    if not replace:
        raise CaptureError("baseline already exists; use --replace in a reviewed maintenance window")
    if (
        not stat.S_ISREG(metadata.st_mode)
        or metadata.st_uid != 0
        or metadata.st_gid != 0
        or stat.S_IMODE(metadata.st_mode) != 0o600
    ):
        raise CaptureError("existing baseline is not a protected regular file")


def _atomic_publish(payload: bytes, *, replace: bool) -> None:
    if os.geteuid() != 0:
        raise CaptureError("baseline capture must run as root")
    lock_fd = _open_lock()
    parent_fd = -1
    temporary = ""
    try:
        parent_fd = _validate_destination_parent()
        _validate_existing(parent_fd, replace=replace)
        destination_name = pathlib.PurePosixPath(DESTINATION).name
        temporary = f".{destination_name}.tmp.{os.getpid()}.{secrets.token_hex(8)}"
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC
        if hasattr(os, "O_NOFOLLOW"):
            flags |= os.O_NOFOLLOW
        temporary_fd = os.open(temporary, flags, 0o600, dir_fd=parent_fd)
        try:
            os.fchmod(temporary_fd, 0o600)
            os.fchown(temporary_fd, 0, 0)
            view = memoryview(payload)
            while view:
                written = os.write(temporary_fd, view)
                if written <= 0:
                    raise CaptureError("baseline publication made no progress")
                view = view[written:]
            os.fsync(temporary_fd)
        finally:
            os.close(temporary_fd)
        # Revalidate under the process-wide lock immediately before mutation.
        _validate_existing(parent_fd, replace=replace)
        os.replace(temporary, destination_name, src_dir_fd=parent_fd, dst_dir_fd=parent_fd)
        temporary = ""
        os.fsync(parent_fd)
    finally:
        if temporary and parent_fd >= 0:
            try:
                os.unlink(temporary, dir_fd=parent_fd)
            except FileNotFoundError:
                pass
        if parent_fd >= 0:
            os.close(parent_fd)
        os.close(lock_fd)


def main(arguments: list[str]) -> int:
    if arguments not in ([], ["--replace"]):
        raise CaptureError("usage: capture-existing-containers.py [--replace]")
    replace = arguments == ["--replace"]
    records = capture_records(_docker_runner)
    payload = serialize_baseline(records)
    _atomic_publish(payload, replace=replace)
    print(f"capturedExistingContainers={len(records)}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main(sys.argv[1:]))
    except (CaptureError, BaselineContractError) as error:
        print(f"existing-container-baseline-error: {error}", file=sys.stderr)
        raise SystemExit(1)
