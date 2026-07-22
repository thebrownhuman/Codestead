#!/usr/bin/python3
"""Export reviewed Git bytes and image records into an exact release tree."""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
from typing import Final
from urllib.parse import urlsplit


MANIFEST_NAME: Final = "RELEASE.SHA256SUMS"
SHA256: Final = re.compile(r"^[a-f0-9]{64}$")
GIT_OBJECT_ID: Final = re.compile(r"^[a-f0-9]{40}(?:[a-f0-9]{24})?$")
MAX_APPLICATION_RECORD_BYTES: Final = 4 * 1024 * 1024
MAX_RUNTIME_RECORD_BYTES: Final = 64 * 1024
MAX_MANIFEST_BYTES: Final = 8 * 1024 * 1024
READ_SIZE: Final = 1024 * 1024
MAX_RECORD_AGE_SECONDS: Final = 24 * 60 * 60
OCI_DIGEST: Final = re.compile(r"^sha256:[a-f0-9]{64}$")
IMMUTABLE_REFERENCE: Final = re.compile(
    r"^[a-z0-9][a-z0-9./_-]{0,255}@sha256:[a-f0-9]{64}$"
)
RELEASE_ID: Final = re.compile(r"^[a-z0-9][a-z0-9._-]{0,127}$")
APPLICATION_TARGETS: Final = (
    ("runtime", "APP_RUNTIME_IMAGE"),
    ("tooling", "APP_TOOLING_IMAGE"),
    ("worker", "APP_WORKER_IMAGE"),
    ("regrade-worker", "APP_REGRADE_WORKER_IMAGE"),
    ("project-review-correction-worker", "APP_PROJECT_REVIEW_WORKER_IMAGE"),
    ("scanner-worker", "APP_SCANNER_WORKER_IMAGE"),
    ("operations", "APP_OPERATIONS_IMAGE"),
)
RUNTIME_LANGUAGES: Final = ("c", "cpp", "java", "python", "javascript")
GENERATED_OVERLAYS: Final = {
    "application_json": "dist/application-images/application-images.json",
    "application_env": "dist/application-images/application-images.env",
    "runtime_json": "services/runner/dist/runtime-images.json",
    "runtime_env": "services/runner/dist/runtime-images.env",
}
FORBIDDEN_ROOTS: Final = {
    ".git",
    ".next",
    ".superpowers",
    "backups",
    "coverage",
    "data",
    "dist",
    "node_modules",
    "out",
    "playwright-report",
    "test-artifacts",
    "test-results",
    "uploads",
}


class PackagingError(RuntimeError):
    """Raised when release inputs violate the packaging contract."""


def fail(message: str) -> None:
    raise PackagingError(message)


def trusted_git_executable() -> Path:
    candidate_text = "/usr/bin/git" if os.name == "posix" else shutil.which("git")
    if not candidate_text:
        fail("trusted Git executable is unavailable")
    try:
        candidate = Path(candidate_text).resolve(strict=True)
        info = candidate.stat()
    except OSError as error:
        raise PackagingError("trusted Git executable is unavailable") from error
    if not stat.S_ISREG(info.st_mode):
        fail("trusted Git executable must be a regular file")
    if os.name == "posix" and (info.st_uid != 0 or info.st_gid != 0 or info.st_mode & 0o022):
        fail("trusted Git executable ownership or mode is unsafe")
    return candidate


def git_environment(git: Path) -> dict[str, str]:
    environment = {
        "GIT_CONFIG_NOSYSTEM": "1",
        "GIT_CONFIG_GLOBAL": os.devnull,
        "GIT_OPTIONAL_LOCKS": "0",
        "GIT_NO_REPLACE_OBJECTS": "1",
        "LANG": "C",
        "LC_ALL": "C",
        "PATH": "/usr/bin:/bin" if os.name == "posix" else str(git.parent),
    }
    if os.name != "posix":
        for name in ("COMSPEC", "SYSTEMROOT", "WINDIR"):
            if os.environ.get(name):
                environment[name] = os.environ[name]
    return environment


def run_git(
    source: Path, arguments: list[str], *, binary: bool = False, git: Path | None = None,
) -> bytes | str:
    executable = git or trusted_git_executable()
    result = subprocess.run(
        [
            str(executable),
            "-c", "core.fsmonitor=false",
            "-c", f"core.hooksPath={os.devnull}",
            "-C", str(source),
            *arguments,
        ],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
        timeout=60,
        env=git_environment(executable),
    )
    if result.returncode != 0:
        detail = result.stderr.decode("utf-8", "replace").strip()
        fail(f"trusted Git command failed: {detail or result.returncode}")
    if binary:
        return result.stdout
    try:
        return result.stdout.decode("ascii").strip()
    except UnicodeDecodeError as error:
        raise PackagingError("trusted Git returned non-ASCII repository metadata") from error


def canonical_member(raw: bytes) -> str:
    try:
        member = raw.decode("utf-8", "strict")
    except UnicodeDecodeError as error:
        raise PackagingError("release paths must be canonical UTF-8") from error
    path = PurePosixPath(member)
    if (
        not member
        or member.startswith("/")
        or "\\" in member
        or any(ord(character) < 0x20 or ord(character) == 0x7F for character in member)
        or any(part in ("", ".", "..") for part in path.parts)
        or path.as_posix() != member
    ):
        fail("release source contains a non-canonical path")
    return member


def forbidden_path(member: str) -> bool:
    parts = PurePosixPath(member).parts
    name = parts[-1]
    if member == MANIFEST_NAME or parts[0] in FORBIDDEN_ROOTS or parts[0].startswith(".codex-"):
        return True
    if member == "public/monaco" or member.startswith("public/monaco/"):
        return True
    if member == "services/runner/dist" or member.startswith("services/runner/dist/"):
        return True
    if "__pycache__" in parts:
        return True
    if name == "next-env.d.ts" or name.endswith((".log", ".pem", ".key", ".pyc", ".pyo", ".tsbuildinfo")):
        return True
    if (name == ".env" or name.startswith(".env.")) and not name.endswith(".example"):
        return True
    return False


def tracked_members(source: Path, revision: str, git: Path | None = None) -> dict[str, int]:
    raw = run_git(
        source, ["ls-tree", "-rz", "--full-tree", revision], binary=True, git=git
    )
    assert isinstance(raw, bytes)
    members: dict[str, int] = {}
    for entry in raw.split(b"\0"):
        if not entry:
            continue
        try:
            metadata, raw_path = entry.split(b"\t", 1)
            mode_raw, object_type, _object_id = metadata.split(b" ", 2)
        except ValueError as error:
            raise PackagingError("trusted Git returned malformed tree metadata") from error
        member = canonical_member(raw_path)
        if object_type != b"blob" or mode_raw not in (b"100644", b"100755"):
            fail(f"release source contains unsupported Git member: {member}")
        if forbidden_path(member):
            fail(f"forbidden tracked release path: {member}")
        if member in members:
            fail("release source contains duplicate paths")
        members[member] = 0o755 if mode_raw == b"100755" else 0o644
    if not members:
        fail("release source Git tree is empty")
    return members


def read_safe_file(path: Path, label: str, maximum: int) -> bytes:
    try:
        before = path.lstat()
    except OSError as error:
        raise PackagingError(f"{label} is missing or inaccessible") from error
    if (
        not stat.S_ISREG(before.st_mode)
        or stat.S_ISLNK(before.st_mode)
        or before.st_nlink != 1
        or before.st_size < 1
        or before.st_size > maximum
        or (os.name == "posix" and before.st_mode & 0o022)
    ):
        fail(f"{label} metadata is unsafe")
    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(path, flags)
    except OSError as error:
        raise PackagingError(f"{label} cannot be opened safely") from error
    try:
        opened = os.fstat(descriptor)
        if (before.st_dev, before.st_ino, before.st_size) != (opened.st_dev, opened.st_ino, opened.st_size):
            fail(f"{label} changed before it was read")
        chunks: list[bytes] = []
        total = 0
        while True:
            block = os.read(descriptor, READ_SIZE)
            if not block:
                break
            total += len(block)
            if total > maximum:
                fail(f"{label} exceeds its size limit")
            chunks.append(block)
        after = os.fstat(descriptor)
        if (
            opened.st_dev,
            opened.st_ino,
            opened.st_size,
            opened.st_mtime_ns,
            opened.st_ctime_ns,
        ) != (
            after.st_dev,
            after.st_ino,
            after.st_size,
            after.st_mtime_ns,
            after.st_ctime_ns,
        ):
            fail(f"{label} changed while it was read")
        return b"".join(chunks)
    finally:
        os.close(descriptor)


def canonical_json(raw: bytes, label: str) -> dict[str, object]:
    try:
        text = raw.decode("utf-8", "strict")
        document = json.loads(text)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise PackagingError(f"{label} is not canonical UTF-8 JSON") from error
    if not isinstance(document, dict) or "\r" in text or "\0" in text:
        fail(f"{label} is not canonical UTF-8 JSON")
    if text != json.dumps(document, ensure_ascii=False, indent=2) + "\n":
        fail(f"{label} does not use canonical JSON bytes")
    return document


def canonical_text(raw: bytes, label: str) -> str:
    try:
        text = raw.decode("utf-8", "strict")
    except UnicodeDecodeError as error:
        raise PackagingError(f"{label} is not canonical UTF-8 text") from error
    if not text.endswith("\n") or "\r" in text or "\0" in text:
        fail(f"{label} is not canonical LF-terminated text")
    return text


def exact_keys(value: object, expected: tuple[str, ...]) -> bool:
    return isinstance(value, dict) and set(value) == set(expected)


def compact_json(value: object) -> bytes:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def normalize_repository(value: str) -> str:
    normalized = value.strip()
    scp = re.fullmatch(r"git@([^:]+):(.+)", normalized)
    if scp:
        normalized = f"https://{scp.group(1)}/{scp.group(2)}"
    ssh = re.fullmatch(r"ssh://git@([^/]+)/(.+)", normalized)
    if ssh:
        normalized = f"https://{ssh.group(1)}/{ssh.group(2)}"
    normalized = re.sub(r"\.git$", "", normalized)
    normalized = normalized.removesuffix("/")
    try:
        parsed = urlsplit(normalized)
    except ValueError as error:
        raise PackagingError("application source repository is not canonical") from error
    if (
        parsed.scheme != "https"
        or not parsed.netloc
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
        or parsed.path in ("", "/")
        or parsed.path.endswith("/")
        or parsed.geturl() != normalized
    ):
        fail("application source repository is not canonical")
    return normalized


def parse_utc_timestamp(value: object) -> datetime:
    if not isinstance(value, str) or not re.fullmatch(
        r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z", value
    ):
        fail("application image record timestamp is not canonical")
    try:
        return datetime.strptime(value, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    except ValueError as error:
        raise PackagingError("application image record timestamp is not canonical") from error


def validate_image_identity(
    record: object, *, expected_keys: tuple[str, ...], local: bool,
) -> dict[str, object]:
    if not exact_keys(record, expected_keys):
        fail("image record contains missing or unreviewed fields")
    assert isinstance(record, dict)
    reference = record.get("reference")
    manifest = record.get("manifestDigest")
    config = record.get("configDigest")
    root = record.get("rootDigest")
    if (
        not isinstance(reference, str)
        or not IMMUTABLE_REFERENCE.fullmatch(reference)
        or not isinstance(manifest, str)
        or not OCI_DIGEST.fullmatch(manifest)
        or not reference.endswith(f"@{manifest}")
        or not isinstance(config, str)
        or not OCI_DIGEST.fullmatch(config)
        or config == manifest
        or not isinstance(root, str)
        or not OCI_DIGEST.fullmatch(root)
        or (local and root != manifest)
    ):
        fail("image record contains a non-canonical deployable identity")
    return record


def validate_records(
    *, commit: str, tree: str, repository: str, context_sha256: str,
    application_json: bytes, application_env: bytes,
    expected_application_sha256: str, runtime_json: bytes, runtime_env: bytes,
    expected_runtime_record_id: str, validated_at: datetime | None = None,
) -> None:
    if not SHA256.fullmatch(expected_application_sha256):
        fail("application image record SHA-256 must be canonical lowercase hexadecimal")
    if hashlib.sha256(application_json).hexdigest() != expected_application_sha256:
        fail("application image record does not match its reviewed SHA-256")
    application = canonical_json(application_json, "application image JSON record")
    source = application.get("source")
    if (
        application.get("schemaVersion") != 1
        or not exact_keys(
            application,
            ("schemaVersion", "recordId", "generatedAt", "release", "local", "source", "records"),
        )
        or not exact_keys(source, ("repository", "revision", "tree", "contextSha256"))
        or not isinstance(source, dict)
        or source.get("repository") != repository
        or source.get("revision") != commit
        or source.get("tree") != tree
        or source.get("contextSha256") != context_sha256
    ):
        fail("application image record source does not match Git HEAD")
    generated_at = parse_utc_timestamp(application.get("generatedAt"))
    now = validated_at or datetime.now(timezone.utc)
    age = (now - generated_at).total_seconds()
    if age < 0 or age > MAX_RECORD_AGE_SECONDS:
        fail("application image record is stale or from the future")
    release = application.get("release")
    local = application.get("local")
    raw_records = application.get("records")
    if (
        not isinstance(application.get("recordId"), str)
        or not SHA256.fullmatch(application["recordId"])
        or not isinstance(release, str)
        or not RELEASE_ID.fullmatch(release)
        or not isinstance(local, bool)
        or not isinstance(raw_records, list)
        or len(raw_records) != len(APPLICATION_TARGETS)
    ):
        fail("application image record has a non-canonical schema")
    records: list[dict[str, object]] = []
    seen_references: set[str] = set()
    seen_manifests: set[str] = set()
    seen_configs: set[str] = set()
    for index, (target, variable) in enumerate(APPLICATION_TARGETS):
        record = validate_image_identity(
            raw_records[index],
            expected_keys=(
                "target", "variable", "reference", "manifestDigest", "configDigest",
                "rootDigest", "sourceRepository", "sourceRevision",
            ),
            local=local,
        )
        if (
            record.get("target") != target
            or record.get("variable") != variable
            or record.get("sourceRepository") != repository
            or record.get("sourceRevision") != commit
        ):
            fail("application image record target or source binding is invalid")
        reference = str(record["reference"])
        manifest = str(record["manifestDigest"])
        config = str(record["configDigest"])
        if reference in seen_references or manifest in seen_manifests or config in seen_configs:
            fail("application image record contains a duplicate deployable identity")
        seen_references.add(reference)
        seen_manifests.add(manifest)
        seen_configs.add(config)
        records.append(record)
    application_payload = {
        "schemaVersion": 1,
        "generatedAt": application["generatedAt"],
        "release": release,
        "local": local,
        "source": source,
        "records": records,
    }
    application_id = hashlib.sha256(compact_json(application_payload)).hexdigest()
    expected_application = {
        "schemaVersion": 1,
        "recordId": application_id,
        "generatedAt": application["generatedAt"],
        "release": release,
        "local": local,
        "source": source,
        "records": records,
    }
    if application != expected_application or application_json != (
        json.dumps(expected_application, ensure_ascii=False, indent=2) + "\n"
    ).encode("utf-8"):
        fail("application image record does not match its canonical record id")
    expected_application_env = (
        "# Generated by scripts/app-images/manage-application-images.mjs; do not hand-edit.\n"
        f"# application-image-record-id={application_id}\n"
        + "".join(f"{record['variable']}={record['reference']}\n" for record in records)
    ).encode("utf-8")
    if application_env != expected_application_env:
        fail("application image environment projection does not match its canonical record id")

    if not SHA256.fullmatch(expected_runtime_record_id):
        fail("runner runtime record id must be canonical lowercase hexadecimal")
    runtime = canonical_json(runtime_json, "runner runtime JSON record")
    raw_runtime_records = runtime.get("records")
    runtime_local = runtime.get("local")
    runtime_release = runtime.get("release")
    if (
        not exact_keys(runtime, ("schemaVersion", "recordId", "release", "local", "records"))
        or runtime.get("schemaVersion") != 1
        or not isinstance(runtime_release, str)
        or not RELEASE_ID.fullmatch(runtime_release)
        or not isinstance(runtime_local, bool)
        or not isinstance(raw_runtime_records, list)
        or len(raw_runtime_records) != len(RUNTIME_LANGUAGES)
    ):
        fail("runner runtime image record has a non-canonical schema")
    runtime_records: list[dict[str, object]] = []
    for index, language in enumerate(RUNTIME_LANGUAGES):
        record = validate_image_identity(
            raw_runtime_records[index],
            expected_keys=("language", "reference", "manifestDigest", "configDigest", "rootDigest"),
            local=runtime_local,
        )
        if record.get("language") != language:
            fail("runner runtime image record language order is invalid")
        runtime_records.append(record)
    runtime_payload = {
        "schemaVersion": 1,
        "release": runtime_release,
        "local": runtime_local,
        "records": runtime_records,
    }
    runtime_id = hashlib.sha256(compact_json(runtime_payload)).hexdigest()
    expected_runtime = {
        "schemaVersion": 1,
        "recordId": runtime_id,
        "release": runtime_release,
        "local": runtime_local,
        "records": runtime_records,
    }
    if (
        runtime_id != expected_runtime_record_id
        or runtime != expected_runtime
        or runtime_json != (
            json.dumps(expected_runtime, ensure_ascii=False, indent=2) + "\n"
        ).encode("utf-8")
    ):
        fail("runner runtime JSON record does not match its canonical record id")
    expected_runtime_env = (
        "# Generated by runtime/manage-images.mjs record; do not hand-edit.\n"
        f"# runtime-record-id={runtime_id}\n"
        + "".join(
            f"RUNNER_IMAGE_{record['language'].upper()}={record['reference']}\n"
            for record in runtime_records
        )
    ).encode("utf-8")
    if runtime_env != expected_runtime_env:
        fail("runtime image environment projection does not match its canonical record id")


def ensure_directory(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)
    path.chmod(0o755)


def write_file(path: Path, content: bytes, mode: int) -> None:
    ensure_directory(path.parent)
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, mode)
    try:
        with os.fdopen(descriptor, "wb", closefd=False) as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
    finally:
        os.close(descriptor)
    path.chmod(mode)


def export_head(
    source: Path, destination: Path, expected: dict[str, int], revision: str,
    git: Path | None = None,
) -> None:
    executable = git or trusted_git_executable()
    process = subprocess.Popen(
        [
            str(executable),
            "-c", "core.fsmonitor=false",
            "-c", f"core.hooksPath={os.devnull}",
            "-C", str(source),
            "archive", "--format=tar", revision,
        ],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=git_environment(executable),
    )
    assert process.stdout is not None
    extracted: set[str] = set()
    try:
        with tarfile.open(fileobj=process.stdout, mode="r|") as archive:
            for entry in archive:
                member = canonical_member(entry.name.encode("utf-8", "strict"))
                target = destination.joinpath(*PurePosixPath(member).parts)
                if entry.isdir():
                    ensure_directory(target)
                    continue
                if not entry.isfile() or member not in expected or member in extracted:
                    fail(f"Git archive contains an unexpected member: {member}")
                source_file = archive.extractfile(entry)
                if source_file is None:
                    fail(f"Git archive member cannot be read: {member}")
                write_file(target, source_file.read(), expected[member])
                extracted.add(member)
    except Exception:
        process.kill()
        process.communicate(timeout=10)
        raise
    error = process.stderr.read().decode("utf-8", "replace").strip() if process.stderr else ""
    if process.wait(timeout=30) != 0:
        fail(f"Git archive failed: {error or process.returncode}")
    if process.stdout:
        process.stdout.close()
    if process.stderr:
        process.stderr.close()
    if extracted != set(expected):
        fail("Git archive does not match the complete pinned Git tree")


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(READ_SIZE), b""):
            digest.update(block)
    return digest.hexdigest()


def build_manifest(root: Path) -> bytes:
    members: list[str] = []
    for directory, directory_names, file_names in os.walk(root, followlinks=False):
        directory_names.sort()
        file_names.sort()
        parent = Path(directory)
        for name in directory_names:
            if (parent / name).is_symlink():
                fail("release package contains a symbolic-link directory")
        for name in file_names:
            candidate = parent / name
            relative = candidate.relative_to(root).as_posix()
            canonical_member(relative.encode("utf-8", "strict"))
            info = candidate.lstat()
            if not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode) or info.st_nlink != 1:
                fail(f"release package contains an unsafe file: {relative}")
            if relative != MANIFEST_NAME:
                members.append(relative)
    members.sort()
    return "".join(f"{file_sha256(root / member)}  {member}\n" for member in members).encode("ascii")


def publish_source_manifest(source: Path, manifest: bytes, git: Path | None = None) -> None:
    executable = git or trusted_git_executable()
    ignored = subprocess.run(
        [
            str(executable),
            "-c", "core.fsmonitor=false",
            "-c", f"core.hooksPath={os.devnull}",
            "-C", str(source),
            "check-ignore", "--quiet", "--", MANIFEST_NAME,
        ],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        check=False,
        timeout=10,
        env=git_environment(executable),
    )
    if ignored.returncode != 0:
        fail(f"/{MANIFEST_NAME} must be ignored before publishing release evidence")
    target = source / MANIFEST_NAME
    if target.exists() or target.is_symlink():
        info = target.lstat()
        if not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode) or info.st_nlink != 1:
            fail("existing source release manifest is unsafe")
    temporary = source / f".{MANIFEST_NAME}.{os.getpid()}.tmp"
    if temporary.exists() or temporary.is_symlink():
        fail("source manifest temporary path already exists")
    try:
        write_file(temporary, manifest, 0o644)
        os.replace(temporary, target)
    finally:
        if temporary.exists():
            temporary.unlink()


def parse_arguments(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--verify-source-manifest", action="store_true")
    parser.add_argument("--source", required=True, type=Path)
    parser.add_argument("--destination", type=Path)
    parser.add_argument("--expected-commit")
    parser.add_argument("--expected-tree")
    parser.add_argument("--application-image-json", required=True, type=Path)
    parser.add_argument("--application-image-env", required=True, type=Path)
    parser.add_argument("--application-image-record-sha256")
    parser.add_argument("--runner-runtime-json", required=True, type=Path)
    parser.add_argument("--runner-runtime-env", required=True, type=Path)
    parser.add_argument("--runner-runtime-record-id")
    arguments = parser.parse_args(argv)
    if arguments.verify_source_manifest:
        if (
            arguments.destination is not None
            or not GIT_OBJECT_ID.fullmatch(arguments.expected_commit or "")
            or not GIT_OBJECT_ID.fullmatch(arguments.expected_tree or "")
        ):
            parser.error(
                "manifest verification requires --expected-commit and --expected-tree "
                "and does not accept --destination"
            )
    elif (
        arguments.destination is None
        or not SHA256.fullmatch(arguments.application_image_record_sha256 or "")
        or not SHA256.fullmatch(arguments.runner_runtime_record_id or "")
        or arguments.expected_commit is not None
        or arguments.expected_tree is not None
    ):
        parser.error(
            "packaging requires --destination, --application-image-record-sha256, "
            "and --runner-runtime-record-id"
        )
    return arguments


def assert_source_unchanged(
    source: Path, commit: str, repository: str, git: Path,
) -> None:
    current = str(run_git(source, ["rev-parse", "--verify", "HEAD^{commit}"], git=git))
    if current != commit:
        fail("source Git HEAD changed during release packaging")
    if str(run_git(source, ["status", "--porcelain=v1", "--untracked-files=no"], git=git)):
        fail("tracked source changed during release packaging")
    current_repository = normalize_repository(
        str(run_git(source, ["config", "--get", "remote.origin.url"], git=git))
    )
    if current_repository != repository:
        fail("source Git repository identity changed during release packaging")


def verify_source_manifest(arguments: argparse.Namespace) -> dict[str, object]:
    git = trusted_git_executable()
    source = arguments.source.resolve(strict=True)
    if not source.is_dir() or arguments.source.is_symlink():
        fail("source must be one real Git worktree directory")
    top = Path(str(run_git(source, ["rev-parse", "--show-toplevel"], git=git))).resolve(strict=True)
    if top != source:
        fail("source must be the exact Git worktree root")
    commit = str(run_git(source, ["rev-parse", "--verify", "HEAD^{commit}"], git=git))
    tree = str(run_git(source, ["rev-parse", "--verify", f"{commit}^{{tree}}"], git=git))
    if commit != arguments.expected_commit or tree != arguments.expected_tree:
        fail("release manifest source does not match the expected Git commit and tree")
    repository = normalize_repository(
        str(run_git(source, ["config", "--get", "remote.origin.url"], git=git))
    )
    if str(run_git(source, ["status", "--porcelain=v1", "--untracked-files=no"], git=git)):
        fail("tracked source differs from HEAD")
    members = tracked_members(source, commit, git)
    archive = run_git(source, ["archive", "--format=tar", commit], binary=True, git=git)
    assert isinstance(archive, bytes)
    evidence = {
        "application_json": read_safe_file(arguments.application_image_json.resolve(strict=True), "application image JSON record", MAX_APPLICATION_RECORD_BYTES),
        "application_env": read_safe_file(arguments.application_image_env.resolve(strict=True), "application image env record", MAX_APPLICATION_RECORD_BYTES),
        "runtime_json": read_safe_file(arguments.runner_runtime_json.resolve(strict=True), "runner runtime JSON record", MAX_RUNTIME_RECORD_BYTES),
        "runtime_env": read_safe_file(arguments.runner_runtime_env.resolve(strict=True), "runner runtime env record", MAX_RUNTIME_RECORD_BYTES),
    }
    runtime_document = canonical_json(evidence["runtime_json"], "runner runtime JSON record")
    runtime_id = runtime_document.get("recordId")
    if not isinstance(runtime_id, str):
        fail("runner runtime record id is missing")
    validate_records(
        commit=commit,
        tree=tree,
        repository=repository,
        context_sha256=hashlib.sha256(archive).hexdigest(),
        application_json=evidence["application_json"],
        application_env=evidence["application_env"],
        expected_application_sha256=hashlib.sha256(evidence["application_json"]).hexdigest(),
        runtime_json=evidence["runtime_json"],
        runtime_env=evidence["runtime_env"],
        expected_runtime_record_id=runtime_id,
    )
    temporary = Path(tempfile.mkdtemp(prefix=".codestead-manifest-verify-"))
    try:
        temporary.chmod(0o755)
        export_head(source, temporary, members, commit, git)
        for key, relative in GENERATED_OVERLAYS.items():
            write_file(temporary.joinpath(*PurePosixPath(relative).parts), evidence[key], 0o644)
        expected_manifest = build_manifest(temporary)
        actual_manifest = read_safe_file(
            source / MANIFEST_NAME, "release manifest", MAX_MANIFEST_BYTES
        )
        if actual_manifest != expected_manifest:
            fail("release manifest does not describe the exact pinned Git tree and overlays")
        assert_source_unchanged(source, commit, repository, git)
    finally:
        shutil.rmtree(temporary)
    return {
        "file_count": len(expected_manifest.decode("ascii").splitlines()),
        "git_commit": commit,
        "git_tree": tree,
        "manifest_sha256": hashlib.sha256(expected_manifest).hexdigest(),
    }


def package(arguments: argparse.Namespace) -> dict[str, object]:
    git = trusted_git_executable()
    source = arguments.source.resolve(strict=True)
    if not source.is_dir() or arguments.source.is_symlink():
        fail("source must be one real Git worktree directory")
    destination_parent = arguments.destination.parent.resolve(strict=True)
    destination = destination_parent / arguments.destination.name
    if destination.exists() or destination.is_symlink():
        fail("destination already exists; release packages are never merged or overwritten")
    try:
        destination.relative_to(source)
    except ValueError:
        pass
    else:
        fail("destination must be outside the source worktree")
    top = Path(str(run_git(source, ["rev-parse", "--show-toplevel"], git=git))).resolve(strict=True)
    if top != source:
        fail("source must be the exact Git worktree root")
    commit = str(run_git(source, ["rev-parse", "--verify", "HEAD^{commit}"], git=git))
    if not GIT_OBJECT_ID.fullmatch(commit):
        fail("Git HEAD commit identity is not canonical")
    tree = str(run_git(source, ["rev-parse", "--verify", f"{commit}^{{tree}}"], git=git))
    if not GIT_OBJECT_ID.fullmatch(tree):
        fail("Git HEAD tree identity is not canonical")
    repository = normalize_repository(
        str(run_git(source, ["config", "--get", "remote.origin.url"], git=git))
    )
    if str(run_git(source, ["status", "--porcelain=v1", "--untracked-files=no"], git=git)):
        fail("tracked source differs from HEAD")
    members = tracked_members(source, commit, git)
    archive = run_git(source, ["archive", "--format=tar", commit], binary=True, git=git)
    assert isinstance(archive, bytes)
    context_sha256 = hashlib.sha256(archive).hexdigest()
    evidence = {
        "application_json": read_safe_file(arguments.application_image_json.resolve(strict=True), "application image JSON record", MAX_APPLICATION_RECORD_BYTES),
        "application_env": read_safe_file(arguments.application_image_env.resolve(strict=True), "application image env record", MAX_APPLICATION_RECORD_BYTES),
        "runtime_json": read_safe_file(arguments.runner_runtime_json.resolve(strict=True), "runner runtime JSON record", MAX_RUNTIME_RECORD_BYTES),
        "runtime_env": read_safe_file(arguments.runner_runtime_env.resolve(strict=True), "runner runtime env record", MAX_RUNTIME_RECORD_BYTES),
    }
    validate_records(
        commit=commit, tree=tree, repository=repository, context_sha256=context_sha256,
        application_json=evidence["application_json"],
        application_env=evidence["application_env"],
        expected_application_sha256=arguments.application_image_record_sha256,
        runtime_json=evidence["runtime_json"], runtime_env=evidence["runtime_env"],
        expected_runtime_record_id=arguments.runner_runtime_record_id,
    )
    temporary = Path(tempfile.mkdtemp(prefix=f".{destination.name}.tmp-", dir=destination_parent))
    destination_published = False
    try:
        temporary.chmod(0o755)
        export_head(source, temporary, members, commit, git)
        for key, relative in GENERATED_OVERLAYS.items():
            write_file(temporary.joinpath(*PurePosixPath(relative).parts), evidence[key], 0o644)
        manifest = build_manifest(temporary)
        write_file(temporary / MANIFEST_NAME, manifest, 0o644)
        if build_manifest(temporary) != manifest:
            fail("release package changed while its manifest was finalized")
        manifest_sha256 = hashlib.sha256(manifest).hexdigest()
        assert_source_unchanged(source, commit, repository, git)
        if destination.exists() or destination.is_symlink():
            fail("destination appeared while the release package was being built")
        temporary.rename(destination)
        destination_published = True
        assert_source_unchanged(source, commit, repository, git)
        publish_source_manifest(source, manifest, git)
    except Exception:
        if temporary.exists():
            shutil.rmtree(temporary)
        if destination_published and destination.exists():
            shutil.rmtree(destination)
        raise
    return {
        "destination": str(destination),
        "file_count": len(manifest.decode("ascii").splitlines()),
        "git_commit": commit,
        "git_tree": tree,
        "manifest_sha256": manifest_sha256,
    }


def main(argv: list[str]) -> int:
    try:
        arguments = parse_arguments(argv)
        report = (
            verify_source_manifest(arguments)
            if arguments.verify_source_manifest
            else package(arguments)
        )
    except (PackagingError, OSError, subprocess.SubprocessError, tarfile.TarError) as error:
        print(f"release packaging failed: {error}", file=sys.stderr)
        return 1
    print(json.dumps(report, sort_keys=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
