#!/usr/bin/python3
"""Verify an immutable, manifest-complete Codestead runner release tree."""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import stat
import sys
from typing import Final, NamedTuple


MANIFEST_NAME: Final = "RELEASE.SHA256SUMS"
MAX_MANIFEST_BYTES: Final = 8 * 1024 * 1024
READ_SIZE: Final = 1024 * 1024


class ContractError(RuntimeError):
    """Raised when the release tree does not satisfy its security contract."""


class ReleaseIdentity(NamedTuple):
    manifest_sha256: str
    file_count: int


class _FileIdentity(NamedTuple):
    device: int
    inode: int
    mode: int
    uid: int
    gid: int
    links: int
    size: int
    mtime_ns: int
    ctime_ns: int
    digest: str


def _sha256_fd(fd: int, *, limit: int | None = None) -> tuple[str, bytes | None]:
    digest = hashlib.sha256()
    chunks: list[bytes] | None = [] if limit is not None else None
    total = 0
    while True:
        block = os.read(fd, READ_SIZE)
        if not block:
            break
        total += len(block)
        if limit is not None and total > limit:
            raise ContractError("release manifest exceeds its size limit")
        digest.update(block)
        if chunks is not None:
            chunks.append(block)
    return digest.hexdigest(), b"".join(chunks) if chunks is not None else None


def _validate_owner_and_mode(info: os.stat_result, *, regular: bool) -> None:
    if info.st_uid != 0 or info.st_gid != 0:
        raise ContractError("release members must be owned by root:root")
    if info.st_mode & 0o022:
        raise ContractError("release members must not be group- or world-writable")
    if regular and info.st_nlink != 1:
        raise ContractError("release files must have exactly one hard link")


def _open_regular(parent_fd: int, name: str) -> tuple[int, os.stat_result]:
    before = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
    if not stat.S_ISREG(before.st_mode):
        raise ContractError("release tree contains a non-regular file")
    _validate_owner_and_mode(before, regular=True)
    fd = os.open(name, os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW, dir_fd=parent_fd)
    after = os.fstat(fd)
    if (before.st_dev, before.st_ino, before.st_mode) != (after.st_dev, after.st_ino, after.st_mode):
        os.close(fd)
        raise ContractError("release file changed while it was opened")
    return fd, after


def _scan_directory(directory_fd: int, prefix: str, output: dict[str, _FileIdentity]) -> None:
    directory_before = os.fstat(directory_fd)
    if not stat.S_ISDIR(directory_before.st_mode):
        raise ContractError("release root contains a non-directory parent")
    _validate_owner_and_mode(directory_before, regular=False)

    names = sorted(os.listdir(directory_fd))
    for name in names:
        if not name or name in (".", "..") or "/" in name or "\x00" in name:
            raise ContractError("release tree contains a non-canonical member name")
        relative = f"{prefix}/{name}" if prefix else name
        info = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
        if stat.S_ISLNK(info.st_mode):
            raise ContractError("release tree must not contain symbolic links")
        if stat.S_ISDIR(info.st_mode):
            _validate_owner_and_mode(info, regular=False)
            child_fd = os.open(
                name,
                os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW | os.O_DIRECTORY,
                dir_fd=directory_fd,
            )
            try:
                child = os.fstat(child_fd)
                if (info.st_dev, info.st_ino) != (child.st_dev, child.st_ino):
                    raise ContractError("release directory changed while it was opened")
                _scan_directory(child_fd, relative, output)
            finally:
                os.close(child_fd)
            continue
        if not stat.S_ISREG(info.st_mode):
            raise ContractError("release tree contains a special file")

        fd, opened = _open_regular(directory_fd, name)
        try:
            digest, _ = _sha256_fd(fd)
            final = os.fstat(fd)
        finally:
            os.close(fd)
        if (
            opened.st_dev,
            opened.st_ino,
            opened.st_mode,
            opened.st_uid,
            opened.st_gid,
            opened.st_nlink,
            opened.st_size,
            opened.st_mtime_ns,
            opened.st_ctime_ns,
        ) != (
            final.st_dev,
            final.st_ino,
            final.st_mode,
            final.st_uid,
            final.st_gid,
            final.st_nlink,
            final.st_size,
            final.st_mtime_ns,
            final.st_ctime_ns,
        ):
            raise ContractError("release file changed while it was hashed")
        output[relative] = _FileIdentity(
            device=final.st_dev,
            inode=final.st_ino,
            mode=final.st_mode,
            uid=final.st_uid,
            gid=final.st_gid,
            links=final.st_nlink,
            size=final.st_size,
            mtime_ns=final.st_mtime_ns,
            ctime_ns=final.st_ctime_ns,
            digest=digest,
        )

    directory_after = os.fstat(directory_fd)
    if (
        directory_before.st_dev,
        directory_before.st_ino,
        directory_before.st_mode,
        directory_before.st_uid,
        directory_before.st_gid,
        directory_before.st_mtime_ns,
        directory_before.st_ctime_ns,
    ) != (
        directory_after.st_dev,
        directory_after.st_ino,
        directory_after.st_mode,
        directory_after.st_uid,
        directory_after.st_gid,
        directory_after.st_mtime_ns,
        directory_after.st_ctime_ns,
    ):
        raise ContractError("release directory changed while it was scanned")


def _scan(root_fd: int) -> dict[str, _FileIdentity]:
    result: dict[str, _FileIdentity] = {}
    _scan_directory(root_fd, "", result)
    return result


def _parse_manifest(raw: bytes) -> dict[str, str]:
    try:
        text = raw.decode("ascii")
    except UnicodeDecodeError as error:
        raise ContractError("release manifest must be ASCII") from error
    if not text or not text.endswith("\n") or "\r" in text:
        raise ContractError("release manifest must use canonical LF-terminated records")

    parsed: dict[str, str] = {}
    prior = ""
    for line in text.splitlines():
        if len(line) < 67 or line[64:66] != "  ":
            raise ContractError("release manifest contains a malformed record")
        digest, member = line[:64], line[66:]
        if len(digest) != 64 or any(character not in "0123456789abcdef" for character in digest):
            raise ContractError("release manifest digests must be lowercase SHA-256")
        path = PurePosixPath(member)
        if (
            not member
            or member.startswith("/")
            or "\\" in member
            or any(ord(character) < 0x20 or ord(character) == 0x7F for character in member)
            or any(part in ("", ".", "..") for part in path.parts)
            or path.as_posix() != member
            or member == MANIFEST_NAME
        ):
            raise ContractError("release manifest contains an unsafe member path")
        if member <= prior or member in parsed:
            raise ContractError("release manifest records must be unique and sorted")
        parsed[member] = digest
        prior = member
    return parsed


def verify_release_tree(root: Path | str, expected_manifest_sha256: str) -> ReleaseIdentity:
    if (
        len(expected_manifest_sha256) != 64
        or any(character not in "0123456789abcdef" for character in expected_manifest_sha256)
    ):
        raise ContractError("expected manifest digest must be canonical lowercase SHA-256")

    root_path = Path(root)
    root_fd = os.open(root_path, os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW | os.O_DIRECTORY)
    try:
        manifest_fd, _ = _open_regular(root_fd, MANIFEST_NAME)
        try:
            actual_manifest_sha, raw_manifest = _sha256_fd(manifest_fd, limit=MAX_MANIFEST_BYTES)
            manifest_final = os.fstat(manifest_fd)
        finally:
            os.close(manifest_fd)
        if actual_manifest_sha != expected_manifest_sha256:
            raise ContractError("release manifest identity does not match the approved digest")
        if raw_manifest is None:
            raise ContractError("release manifest could not be read")
        expected = _parse_manifest(raw_manifest)

        first = _scan(root_fd)
        manifest_identity = first.pop(MANIFEST_NAME, None)
        if manifest_identity is None or manifest_identity.digest != actual_manifest_sha:
            raise ContractError("release manifest changed during verification")
        if set(first) != set(expected):
            raise ContractError("release manifest must describe the exact complete file tree")
        for member, digest in expected.items():
            if first[member].digest != digest:
                raise ContractError("release member checksum does not match its manifest")

        second = _scan(root_fd)
        second_manifest = second.pop(MANIFEST_NAME, None)
        if second_manifest != manifest_identity or second != first:
            raise ContractError("release tree changed during verification")
        return ReleaseIdentity(manifest_sha256=actual_manifest_sha, file_count=len(first))
    except OSError as error:
        raise ContractError("release tree cannot be verified safely") from error
    finally:
        os.close(root_fd)


def main(argv: list[str]) -> int:
    if len(argv) != 3:
        return 64
    try:
        identity = verify_release_tree(argv[1], argv[2])
    except ContractError as error:
        print(f"release verification failed: {error}", file=sys.stderr)
        return 1
    print(
        json.dumps(
            {"file_count": identity.file_count, "manifest_sha256": identity.manifest_sha256},
            sort_keys=True,
            separators=(",", ":"),
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
