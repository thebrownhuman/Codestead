#!/usr/bin/python3
"""Bounded, fail-closed implementation for check-recovery.sh.

Only the small shell wrapper is invoked by systemd.  This helper centralizes
the byte-sensitive and descriptor-sensitive work that is unsafe to express
with shell strings.
"""

from __future__ import annotations

import ctypes
import dataclasses
import decimal
import errno
import hashlib
import hmac
import ipaddress
import json
import os
import pathlib
import re
import secrets
import selectors
import signal
import stat
import subprocess
import sys
import time
import xml.etree.ElementTree as ElementTree
from collections.abc import Callable, Mapping, Sequence
from typing import Final

from existing_container_baseline import (
    MAXIMUM_BASELINE_BYTES,
    MAXIMUM_INSPECTION_BYTES,
    BaselineContractError,
    ContainerIdentity,
    inspection_matches_record,
    parse_baseline,
)

try:
    import fcntl
except ImportError:  # pragma: no cover - production is Linux-only
    fcntl = None  # type: ignore[assignment]


RECOVERY_LIMIT_SECONDS: Final = 900
RECOVERY_POLL_SECONDS: Final = 10
LOCAL_PROBE_SECONDS: Final = 2
HTTP_PROBE_SECONDS: Final = 12
MAXIMUM_COMMAND_BYTES: Final = 65_536
MAXIMUM_HTTP_BODY_BYTES: Final = 4_096
MAXIMUM_HTTP_HEADER_BYTES: Final = 16_384
MAXIMUM_STDERR_BYTES: Final = 4_096
EXPECTED_PROJECT: Final = "learncoding"
EXPECTED_RUNNER_BASE: Final = "http://192.168.122.12:4100"
EXPECTED_RUNNER_DOMAIN: Final = "codestead-runner"
EXPECTED_RUNNER_NETWORK: Final = "default"
EXPECTED_RUNNER_BRIDGE: Final = "virbr0"
EXPECTED_RUNNER_MAC: Final = "52:54:00:20:00:12"
EXPECTED_RUNNER_ADDRESS: Final = "192.168.122.12"
EXPECTED_RUNNER_GATEWAY: Final = "192.168.122.1"
EXPECTED_RUNNER_NETMASK: Final = "255.255.255.0"
EXPECTED_RUNNER_NETWORK_CIDR: Final = "192.168.122.0/24"
EXPECTED_RUNNER_DHCP_START: Final = "192.168.122.2"
EXPECTED_RUNNER_DHCP_END: Final = "192.168.122.254"
MAXIMUM_XML_BYTES: Final = 131_072
MAXIMUM_LIBVIRT_DERIVED_NUMBER: Final = 4_294_967_294
MAXIMUM_PROC_STAT_BYTES: Final = 4_096

# Approved pilot steady state excludes the optional ``uploads`` profile, so
# ClamAV and scan-worker are deliberately not part of this exact inventory.
EXPECTED_COMPOSE_SERVICES: Final[dict[str, str]] = {
    "postgres": "healthy",
    "app": "healthy",
    "runner-egress-gateway": "healthy",
    "mail-worker": "healthy",
    "reward-worker": "healthy",
    "regrade-worker": "healthy",
    "exam-finalization-worker": "healthy",
    "practice-runner-recovery-worker": "healthy",
    "project-review-correction-worker": "healthy",
    "file-erasure-worker": "healthy",
    "cloudflared": "healthy",
}

EXPECTED_CONTENT_SECURITY_POLICY: Final = "; ".join(
    (
        "default-src 'self'",
        "base-uri 'self'",
        "frame-ancestors 'none'",
        "object-src 'none'",
        "script-src 'self' 'unsafe-inline'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob:",
        "font-src 'self' data:",
        "connect-src 'self'",
        "worker-src 'self' blob:",
        "form-action 'self'",
        "upgrade-insecure-requests",
    )
)

POSTGRES_SQL: Final = (
    "SELECT name, setting FROM pg_settings WHERE name IN "
    "('data_checksums', 'fsync', 'synchronous_commit', 'full_page_writes');"
)
EXPECTED_POSTGRES_SETTINGS: Final = {
    "data_checksums": "on",
    "fsync": "on",
    "synchronous_commit": "on",
    "full_page_writes": "on",
}

BASELINE_RELATIVE: Final = "etc/learncoding/existing-containers.txt"
COMPOSE_ENV_RELATIVE: Final = "etc/learncoding/compose.env"
COMPOSE_FILE_RELATIVE: Final = "opt/learncoding/compose.yaml"
RUNNER_SECRET_RELATIVE: Final = "etc/learncoding/secrets/runner_shared_secret"

_NAME_PATTERN: Final = re.compile(rb"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}")
_HEADER_NAME_PATTERN: Final = re.compile(r"[!#$%&'*+.^_`|~0-9A-Za-z-]+")
_JSON_CONTENT_TYPE_PATTERN: Final = re.compile(
    r"application/json(?:[ \t]*;[ \t]*"
    r"[!#$%&'*+.^_`|~0-9A-Za-z-]+[ \t]*=[ \t]*"
    r'(?:[!#$%&\'*+.^_`|~0-9A-Za-z-]+|"(?:[\t !#-\[\]-~]|\\[\t !-~])*")'
    r")*[ \t]*",
    re.IGNORECASE,
)
_RUNNER_BODY_PATTERN: Final = re.compile(
    rb'\{"status":"ok","queueDepth":(0|[1-9][0-9]*),'
    rb'"activeJobs":(0|[1-9][0-9]*),"concurrency":(0|[1-9][0-9]*),'
    rb'"generatedAtEpoch":([0-9]{10})\}'
)
_REQUEST_ID_PATTERN: Final = re.compile(r"[A-Za-z0-9._:-]{8,128}")
_SIGNATURE_PATTERN: Final = re.compile(r"sha256=[0-9a-f]{64}")


class ContractError(RuntimeError):
    """A response or protected input violated the recovery contract."""


def _runner_secret_expected_gid(test_mode: bool) -> int:
    """Return the production GID or its one-ID-userns overflow representation."""

    if not test_mode:
        return 2000
    override = os.environ.get("RECOVERY_CHECK_TEST_RUNNER_SECRET_GID", "")
    if not override:
        return 2000
    if override != "65534":
        raise ContractError("test runner-secret GID is invalid")
    return 65534


class ProbeError(RuntimeError):
    """A bounded external probe failed without exposing its output."""


class GlobalTimeout(RuntimeError):
    """The monotonic recovery budget was exhausted."""


class TerminationRequested(RuntimeError):
    """The checker was interrupted by an operator or service manager."""


@dataclasses.dataclass(frozen=True)
class RuntimeConfiguration:
    public_url: str
    runner_base: str
    postgres_data: str


@dataclasses.dataclass(frozen=True)
class ProcessResult:
    returncode: int
    streams: Mapping[str, bytes]


@dataclasses.dataclass(frozen=True)
class HttpResponse:
    status: int
    headers: bytes
    body: bytes


@dataclasses.dataclass
class ProbeState:
    appHealthy: bool = False
    cloudflaredHealthy: bool = False
    dockerHealthy: bool = False
    firewallHealthy: bool = False
    libvirtHealthy: bool = False
    postgresDurable: bool = False
    postgresHealthy: bool = False
    publicHttpsHealthy: bool = False
    runnerHealthy: bool = False
    timersHealthy: bool = False
    workersHealthy: bool = False
    existing_expected: int = 0
    existing_running: int = 0

    def recovered(self) -> bool:
        return (
            self.appHealthy
            and self.cloudflaredHealthy
            and self.dockerHealthy
            and self.firewallHealthy
            and self.libvirtHealthy
            and self.postgresDurable
            and self.postgresHealthy
            and self.publicHttpsHealthy
            and self.runnerHealthy
            and self.timersHealthy
            and self.workersHealthy
            and self.existing_expected > 0
            and self.existing_running == self.existing_expected
        )


RESULT_HEALTH_FIELDS: Final = (
    "appHealthy",
    "cloudflaredHealthy",
    "dockerHealthy",
    "firewallHealthy",
    "libvirtHealthy",
    "postgresDurable",
    "postgresHealthy",
    "publicHttpsHealthy",
    "runnerHealthy",
    "timersHealthy",
    "workersHealthy",
)


def result_payload(
    state: ProbeState,
    *,
    recovered: bool,
    timed_out: bool,
    elapsed: int,
) -> dict[str, object]:
    bounded_elapsed = min(RECOVERY_LIMIT_SECONDS, max(0, int(elapsed)))
    return {
        "appHealthy": state.appHealthy,
        "cloudflaredHealthy": state.cloudflaredHealthy,
        "dockerHealthy": state.dockerHealthy,
        "elapsedSeconds": bounded_elapsed,
        "existingContainersExpected": state.existing_expected,
        "existingContainersRunning": min(
            state.existing_expected, state.existing_running
        ),
        "firewallHealthy": state.firewallHealthy,
        "libvirtHealthy": state.libvirtHealthy,
        "postgresDurable": state.postgresDurable,
        "postgresHealthy": state.postgresHealthy,
        "publicHttpsHealthy": state.publicHttpsHealthy,
        "recovered": recovered,
        "runnerHealthy": state.runnerHealthy,
        "schemaVersion": 1,
        "timedOut": timed_out,
        "timersHealthy": state.timersHealthy,
        "workersHealthy": state.workersHealthy,
    }


def encode_result(payload: Mapping[str, object]) -> bytes:
    return json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("ascii") + b"\n"


class Deadline:
    """Strictly nondecreasing monotonic deadline, injectable only by tests."""

    def __init__(
        self,
        limit_seconds: int,
        *,
        monotonic: Callable[[], float] = time.monotonic,
    ) -> None:
        if limit_seconds <= 0:
            raise ValueError("deadline must be positive")
        self._limit = float(limit_seconds)
        self._monotonic = monotonic
        self._started = float(monotonic())
        self._last = self._started

    def _now(self) -> float:
        current = float(self._monotonic())
        if current < self._last:
            raise ContractError("monotonic source moved backwards")
        self._last = current
        return current

    def elapsed(self) -> float:
        return max(0.0, self._now() - self._started)

    def elapsed_seconds(self) -> int:
        return min(int(self.elapsed()), int(self._limit))

    def remaining(self) -> float:
        return max(0.0, self._limit - self.elapsed())

    def check(self) -> None:
        if self.elapsed() >= self._limit:
            raise GlobalTimeout("global recovery deadline exhausted")


class FileMonotonicClock:
    """Test-only logical monotonic source driven by the sealed fake sleep."""

    def __init__(self, path: str) -> None:
        self._path = path

    def __call__(self) -> float:
        try:
            with open(self._path, "rb", buffering=0) as stream:
                raw = stream.read(33)
        except OSError as error:
            raise ContractError("test monotonic source unavailable") from error
        if len(raw) > 32 or re.fullmatch(rb"0|[1-9][0-9]{0,8}", raw) is None:
            raise ContractError("test monotonic source malformed")
        return float(int(raw))


def _unique_object(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise ContractError("duplicate JSON key")
        result[key] = value
    return result


def _json_loads_exact(raw: bytes) -> object:
    def reject_nonfinite(_value: str) -> object:
        raise ContractError("non-finite JSON number")

    def parse_integer(value: str) -> int:
        if len(value) > 20 or re.fullmatch(r"-?(?:0|[1-9][0-9]*)", value) is None:
            raise ContractError("JSON integer is outside the bounded grammar")
        parsed = int(value)
        if parsed < -(2**63) or parsed > 2**63 - 1:
            raise ContractError("JSON integer exceeds the signed 64-bit contract")
        return parsed

    def parse_float(value: str) -> float:
        if len(value) > 128:
            raise ContractError("JSON decimal is oversized")
        match = re.fullmatch(
            r"-?(?P<integer>0|[1-9][0-9]*)\.(?P<fraction>[0-9]+)"
            r"(?:[eE](?P<exponent>[+-]?[0-9]+))?"
            r"|-?(?P<whole>0|[1-9][0-9]*)[eE](?P<whole_exponent>[+-]?[0-9]+)",
            value,
        )
        if match is None:
            raise ContractError("JSON decimal is malformed")
        digits = (match.group("integer") or match.group("whole") or "") + (
            match.group("fraction") or ""
        )
        exponent_text = match.group("exponent") or match.group("whole_exponent") or "0"
        if len(digits) > 100 or len(exponent_text.lstrip("+-")) > 4:
            raise ContractError("JSON decimal precision or exponent is oversized")
        exponent = int(exponent_text)
        if exponent < -308 or exponent > 308:
            raise ContractError("JSON decimal exponent is outside the finite contract")
        try:
            exact = decimal.Decimal(value)
            parsed = float(exact)
        except (decimal.InvalidOperation, OverflowError, ValueError) as error:
            raise ContractError("JSON decimal is invalid") from error
        if not exact.is_finite() or parsed == float("inf") or parsed == float("-inf"):
            raise ContractError("JSON decimal is non-finite")
        return parsed

    try:
        text = raw.decode("utf-8", "strict")
        return json.loads(
            text,
            object_pairs_hook=_unique_object,
            parse_constant=reject_nonfinite,
            parse_int=parse_integer,
            parse_float=parse_float,
        )
    except ContractError:
        raise
    except (UnicodeError, json.JSONDecodeError) as error:
        raise ContractError("malformed JSON") from error


def validate_compose_services(raw: bytes) -> None:
    if not raw or len(raw) > 4_096 or b"\x00" in raw or b"\r" in raw:
        raise ContractError("Compose rendered service list is malformed")
    if not raw.endswith(b"\n"):
        raise ContractError("Compose rendered service list is not line-terminated")
    lines = raw[:-1].split(b"\n")
    observed: set[str] = set()
    for line in lines:
        if re.fullmatch(rb"[a-z][a-z0-9-]{0,62}", line) is None:
            raise ContractError("Compose rendered service name is malformed")
        name = line.decode("ascii")
        if name in observed:
            raise ContractError("Compose rendered service list contains a duplicate")
        observed.add(name)
    if observed != set(EXPECTED_COMPOSE_SERVICES):
        raise ContractError("Compose rendered service model is not the pilot model")


def validate_compose_json_lines(raw: bytes) -> None:
    if not raw or len(raw) > MAXIMUM_COMMAND_BYTES or b"\x00" in raw:
        raise ContractError("invalid Compose response size")
    lines = raw.split(b"\n")
    if lines[-1] == b"":
        lines.pop()
    if len(lines) != len(EXPECTED_COMPOSE_SERVICES) or any(not line for line in lines):
        raise ContractError("Compose inventory is not exact")

    observed: dict[str, Mapping[str, object]] = {}
    for encoded_line in lines:
        if encoded_line.endswith(b"\r"):
            encoded_line = encoded_line[:-1]
        value = _json_loads_exact(encoded_line)
        if not isinstance(value, dict):
            raise ContractError("Compose line is not a root object")
        service = value.get("Service")
        if not isinstance(service, str) or service not in EXPECTED_COMPOSE_SERVICES:
            raise ContractError("unexpected Compose service")
        if service in observed:
            raise ContractError("duplicate Compose service")
        expected_name = f"{EXPECTED_PROJECT}-{service}-1"
        if (
            value.get("Project") != EXPECTED_PROJECT
            or value.get("Name") != expected_name
            or value.get("State") != "running"
            or value.get("Health") != EXPECTED_COMPOSE_SERVICES[service]
        ):
            raise ContractError("Compose service identity or health mismatch")
        observed[service] = value
    if set(observed) != set(EXPECTED_COMPOSE_SERVICES):
        raise ContractError("Compose inventory is incomplete")


def _strict_required_environment(raw: bytes) -> dict[str, str]:
    if len(raw) > 65_536 or b"\x00" in raw:
        raise ContractError("environment file is oversized or binary")
    try:
        text = raw.decode("utf-8", "strict")
    except UnicodeError as error:
        raise ContractError("environment file is not UTF-8") from error
    wanted = {
        "APP_URL",
        "RUNNER_BASE_URL",
        "LEARN_DATA_ROOT",
        "UPLOADS_ENABLED",
        "COMPOSE_PROFILES",
    }
    values: dict[str, str] = {}
    for raw_line in text.splitlines():
        if raw_line == "" or raw_line.startswith("#"):
            continue
        if "=" not in raw_line:
            continue
        key, value = raw_line.split("=", 1)
        if key not in wanted:
            continue
        if (
            key in values
            or value != value.strip()
            or (not value and key != "COMPOSE_PROFILES")
        ):
            raise ContractError("required environment value is duplicate or malformed")
        values[key] = value
    return values


def _safe_absolute_data_root(value: str) -> str:
    if (
        not value.startswith("/")
        or value == "/"
        or "//" in value
        or value.endswith("/")
        or any(part in ("", ".", "..") for part in value.split("/")[1:])
    ):
        raise ContractError("LEARN_DATA_ROOT is not a canonical absolute path")
    return value


def parse_runtime_environment(raw: bytes) -> RuntimeConfiguration:
    values = _strict_required_environment(raw)
    app_url = values.get("APP_URL")
    runner_base = values.get("RUNNER_BASE_URL")
    if app_url is None or runner_base is None:
        raise ContractError("required recovery environment is missing")
    if values.get("UPLOADS_ENABLED") != "false" or values.get("COMPOSE_PROFILES") != "":
        raise ContractError("optional Compose profiles are not explicitly disabled")
    if re.fullmatch(r"https://[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?", app_url) is None:
        raise ContractError("APP_URL must be an HTTPS origin")
    if runner_base != EXPECTED_RUNNER_BASE:
        raise ContractError("runner endpoint does not match approved topology")
    data_root = _safe_absolute_data_root(values.get("LEARN_DATA_ROOT", "/srv/learncoding"))
    return RuntimeConfiguration(
        public_url=f"{app_url}/health/ready",
        runner_base=runner_base,
        postgres_data=f"{data_root}/postgres",
    )


def _check_safe_directory(descriptor: int) -> None:
    metadata = os.fstat(descriptor)
    if (
        not stat.S_ISDIR(metadata.st_mode)
        or metadata.st_uid != 0
        or stat.S_IMODE(metadata.st_mode) & 0o022
    ):
        raise ContractError("protected-file ancestor is unsafe")


def _relative_components(relative: str) -> list[str]:
    if not relative or relative.startswith("/") or "\x00" in relative:
        raise ContractError("protected path is not relative")
    components = relative.split("/")
    if any(component in ("", ".", "..") for component in components):
        raise ContractError("protected path contains unsafe components")
    return components


_INOTIFY_MUTATION_MASK: Final = (
    0x00000002  # IN_MODIFY
    | 0x00000004  # IN_ATTRIB
    | 0x00000008  # IN_CLOSE_WRITE
    | 0x00000400  # IN_DELETE_SELF
    | 0x00000800  # IN_MOVE_SELF
    | 0x00004000  # IN_Q_OVERFLOW
    | 0x00008000  # IN_IGNORED
)


def _open_mutation_watch(descriptor: int) -> int:
    """Watch the opened inode so mutate-and-restore cannot evade revalidation."""

    if sys.platform != "linux" or descriptor < 0:
        raise ContractError("protected mutation watches require Linux")
    libc = ctypes.CDLL(None, use_errno=True)
    inotify_init1 = libc.inotify_init1
    inotify_init1.argtypes = [ctypes.c_int]
    inotify_init1.restype = ctypes.c_int
    inotify_add_watch = libc.inotify_add_watch
    inotify_add_watch.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_uint32]
    inotify_add_watch.restype = ctypes.c_int
    watch_descriptor = inotify_init1(os.O_CLOEXEC | os.O_NONBLOCK)
    if watch_descriptor < 0:
        error = ctypes.get_errno()
        raise ContractError("protected mutation watch could not be created") from OSError(error, os.strerror(error))
    try:
        watched_path = f"/proc/self/fd/{descriptor}".encode("ascii")
        if inotify_add_watch(watch_descriptor, watched_path, _INOTIFY_MUTATION_MASK) < 0:
            error = ctypes.get_errno()
            raise ContractError("protected inode could not be watched") from OSError(error, os.strerror(error))
        return watch_descriptor
    except BaseException:
        os.close(watch_descriptor)
        raise


def _mutation_watch_changed(watch_descriptor: int) -> bool:
    if watch_descriptor < 0:
        raise ContractError("protected mutation watch is closed")
    try:
        return bool(os.read(watch_descriptor, 65_536))
    except BlockingIOError:
        return False
    except OSError as error:
        raise ContractError("protected mutation watch could not be read") from error


@dataclasses.dataclass
class ProtectedFile:
    descriptor: int
    watch_descriptor: int
    data: bytes
    trusted_root: str
    relative: str
    expected_uid: int
    expected_gid: int
    expected_mode: int
    maximum_bytes: int
    source_identity: tuple[int, int, int, int, int, int, int, int]

    @property
    def proc_path(self) -> str:
        if self.descriptor < 0:
            raise ContractError("protected descriptor is closed")
        return f"/proc/{os.getpid()}/fd/{self.descriptor}"

    def close(self) -> None:
        failures: list[OSError] = []
        for field in ("descriptor", "watch_descriptor"):
            descriptor = getattr(self, field)
            if descriptor < 0:
                continue
            setattr(self, field, -1)
            try:
                os.close(descriptor)
            except OSError as error:
                failures.append(error)
        if failures:
            raise ContractError("protected descriptor cleanup failed") from failures[0]

    def verify_current(self) -> None:
        if _mutation_watch_changed(self.watch_descriptor):
            raise ContractError("protected canonical input was modified")
        current, descriptor, identity = _read_protected_file(
            self.trusted_root,
            self.relative,
            self.expected_uid,
            self.expected_gid,
            self.expected_mode,
            self.maximum_bytes,
            retain_descriptor=False,
        )
        if descriptor != -1 or identity != self.source_identity:
            raise ContractError("protected canonical input identity changed")
        if not hmac.compare_digest(hashlib.sha256(current).digest(), hashlib.sha256(self.data).digest()):
            raise ContractError("protected canonical input bytes changed")
        if _mutation_watch_changed(self.watch_descriptor):
            raise ContractError("protected canonical input was modified")


def _read_protected_file(
    trusted_root: str,
    relative: str,
    expected_uid: int,
    expected_gid: int,
    expected_mode: int,
    maximum_bytes: int,
    *,
    retain_descriptor: bool,
    _after_open: Callable[[], None] | None = None,
) -> tuple[bytes, int, tuple[int, int, int, int, int, int, int, int]]:
    """Validate ancestors and read one O_NOFOLLOW descriptor byte-for-byte."""

    if (
        not os.path.isabs(trusted_root)
        or trusted_root != os.path.normpath(trusted_root)
        or maximum_bytes < 0
    ):
        raise ContractError("trusted root is invalid")
    components = _relative_components(relative)
    directory_flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
    file_flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC
    descriptors: list[int] = []
    retained_descriptor = -1
    try:
        try:
            current = os.open(trusted_root, directory_flags)
        except OSError as error:
            raise ContractError("trusted root could not be opened") from error
        descriptors.append(current)
        _check_safe_directory(current)
        for component in components[:-1]:
            try:
                current = os.open(component, directory_flags, dir_fd=current)
            except OSError as error:
                raise ContractError("protected-file ancestor could not be opened") from error
            descriptors.append(current)
            _check_safe_directory(current)
        try:
            file_descriptor = os.open(components[-1], file_flags, dir_fd=current)
        except OSError as error:
            raise ContractError("protected file could not be opened") from error
        descriptors.append(file_descriptor)
        before = os.fstat(file_descriptor)
        if (
            not stat.S_ISREG(before.st_mode)
            or before.st_uid != expected_uid
            or before.st_gid != expected_gid
            or stat.S_IMODE(before.st_mode) != expected_mode
            or before.st_size < 0
            or before.st_size > maximum_bytes
        ):
            raise ContractError("protected file metadata is invalid")

        def read_once() -> bytes:
            try:
                os.lseek(file_descriptor, 0, os.SEEK_SET)
            except OSError as error:
                raise ContractError("protected file could not be rewound") from error
            chunks: list[bytes] = []
            total = 0
            while True:
                chunk = os.read(
                    file_descriptor,
                    min(65_536, maximum_bytes + 1 - total),
                )
                if not chunk:
                    break
                chunks.append(chunk)
                total += len(chunk)
                if total > maximum_bytes:
                    raise ContractError("protected file exceeds its byte limit")
            return b"".join(chunks)

        stable_data = read_once()
        middle = os.fstat(file_descriptor)
        if _after_open is not None:
            _after_open()
        data = read_once()
        after = os.fstat(file_descriptor)
        identity_before = (
            before.st_dev,
            before.st_ino,
            before.st_mode,
            before.st_uid,
            before.st_gid,
            before.st_size,
            before.st_mtime_ns,
            before.st_ctime_ns,
        )
        identity_middle = (
            middle.st_dev,
            middle.st_ino,
            middle.st_mode,
            middle.st_uid,
            middle.st_gid,
            middle.st_size,
            middle.st_mtime_ns,
            middle.st_ctime_ns,
        )
        identity_after = (
            after.st_dev,
            after.st_ino,
            after.st_mode,
            after.st_uid,
            after.st_gid,
            after.st_size,
            after.st_mtime_ns,
            after.st_ctime_ns,
        )
        if (
            identity_middle[:6] != identity_before[:6]
            or identity_after[:6] != identity_before[:6]
            or len(stable_data) != before.st_size
            or len(data) != before.st_size
        ):
            raise ContractError("protected file changed while being read")
        if not hmac.compare_digest(
            hashlib.sha256(stable_data).digest(),
            hashlib.sha256(data).digest(),
        ):
            raise ContractError("protected file bytes changed while being read")
        if retain_descriptor:
            retained_descriptor = descriptors.pop()
        return data, retained_descriptor, identity_before
    finally:
        cleanup_failed = False
        for descriptor in reversed(descriptors):
            try:
                os.close(descriptor)
            except OSError:
                cleanup_failed = True
        if cleanup_failed:
            if retained_descriptor >= 0:
                try:
                    os.close(retained_descriptor)
                except OSError:
                    pass
                retained_descriptor = -1
            if sys.exc_info()[0] is None:
                raise ContractError("protected descriptor cleanup failed")


def read_protected_file(
    trusted_root: str,
    relative: str,
    expected_uid: int,
    expected_gid: int,
    expected_mode: int,
    maximum_bytes: int,
    *,
    _after_open: Callable[[], None] | None = None,
) -> bytes:
    data, descriptor, _identity = _read_protected_file(
        trusted_root,
        relative,
        expected_uid,
        expected_gid,
        expected_mode,
        maximum_bytes,
        retain_descriptor=False,
        _after_open=_after_open,
    )
    if descriptor != -1:
        raise ContractError("unexpected retained protected descriptor")
    return data


def open_protected_file(
    trusted_root: str,
    relative: str,
    expected_uid: int,
    expected_gid: int,
    expected_mode: int,
    maximum_bytes: int,
) -> ProtectedFile:
    data, descriptor, identity = _read_protected_file(
        trusted_root,
        relative,
        expected_uid,
        expected_gid,
        expected_mode,
        maximum_bytes,
        retain_descriptor=True,
    )
    if descriptor < 0:
        raise ContractError("protected descriptor was not retained")
    source_descriptor = descriptor
    watch_descriptor = -1
    snapshot_descriptor = -1
    try:
        if fcntl is None or not hasattr(os, "memfd_create"):
            raise ContractError("sealed protected snapshots require Linux memfd support")
        flags = getattr(os, "MFD_CLOEXEC", 0x0001) | getattr(os, "MFD_ALLOW_SEALING", 0x0002)
        snapshot_descriptor = os.memfd_create("recovery-compose-input", flags)
        watch_descriptor = _open_mutation_watch(source_descriptor)
        offset = 0
        while offset < len(data):
            written = os.write(snapshot_descriptor, data[offset:])
            if written <= 0:
                raise ContractError("protected snapshot write made no progress")
            offset += written
        os.lseek(snapshot_descriptor, 0, os.SEEK_SET)
        required_seals = (
            fcntl.F_SEAL_WRITE
            | fcntl.F_SEAL_GROW
            | fcntl.F_SEAL_SHRINK
            | fcntl.F_SEAL_SEAL
        )
        fcntl.fcntl(snapshot_descriptor, fcntl.F_ADD_SEALS, required_seals)
        if fcntl.fcntl(snapshot_descriptor, fcntl.F_GET_SEALS) & required_seals != required_seals:
            raise ContractError("protected snapshot seals are incomplete")
        try:
            os.close(source_descriptor)
        except OSError as error:
            raise ContractError("protected source descriptor cleanup failed") from error
        source_descriptor = -1
        protected = ProtectedFile(
            descriptor=snapshot_descriptor,
            watch_descriptor=watch_descriptor,
            data=data,
            trusted_root=trusted_root,
            relative=relative,
            expected_uid=expected_uid,
            expected_gid=expected_gid,
            expected_mode=expected_mode,
            maximum_bytes=maximum_bytes,
            source_identity=identity,
        )
        protected.verify_current()
        snapshot_descriptor = -1
        watch_descriptor = -1
        return protected
    finally:
        cleanup_failed = False
        for pending in (source_descriptor, snapshot_descriptor, watch_descriptor):
            if pending >= 0:
                try:
                    os.close(pending)
                except OSError:
                    cleanup_failed = True
        if cleanup_failed and sys.exc_info()[0] is None:
            raise ContractError("protected snapshot descriptor cleanup failed")


def _parse_http_headers(raw: bytes, expected_status: int) -> dict[str, str]:
    if not raw or len(raw) > MAXIMUM_HTTP_HEADER_BYTES or b"\x00" in raw:
        raise ContractError("HTTP headers are missing, oversized, or binary")
    if not raw.endswith(b"\r\n\r\n") or b"\r\n\r\n" in raw[:-4]:
        raise ContractError("HTTP response does not contain one exact CRLF header block")
    encoded_lines = raw[:-4].split(b"\r\n")
    if not encoded_lines or any(b"\r" in line or b"\n" in line for line in encoded_lines):
        raise ContractError("HTTP headers use malformed line endings")
    try:
        lines = [line.decode("iso-8859-1", "strict") for line in encoded_lines]
    except UnicodeError as error:
        raise ContractError("HTTP headers are malformed") from error
    if sum(line.startswith("HTTP/") for line in lines) != 1:
        raise ContractError("HTTP response must contain one status block")
    if any(ord(character) < 0x20 or ord(character) == 0x7F for character in lines[0]):
        raise ContractError("HTTP status line contains a control byte")
    status_match = re.fullmatch(
        r"HTTP/(?:1\.0|1\.1|2|3) ([0-9]{3})(?: [\x20-\x7e\x80-\xff]*)?",
        lines[0],
    )
    if status_match is None or int(status_match.group(1)) != expected_status:
        raise ContractError("captured HTTP status does not match headers")
    headers: dict[str, str] = {}
    for line in lines[1:]:
        if line == "":
            raise ContractError("HTTP response contains another header block")
        if line[:1] in (" ", "\t") or ":" not in line:
            raise ContractError("folded or malformed HTTP header")
        name, value = line.split(":", 1)
        if _HEADER_NAME_PATTERN.fullmatch(name) is None:
            raise ContractError("invalid HTTP header name")
        lowered = name.lower()
        if any(ord(character) < 0x20 or ord(character) == 0x7F for character in value):
            raise ContractError("HTTP header value contains a control byte")
        value = value.strip(" ")
        if not value or lowered in headers:
            raise ContractError("empty or duplicate HTTP header")
        headers[lowered] = value
    return headers


def _single_required_header(headers: Mapping[str, str], name: str) -> str:
    value = headers.get(name)
    if value is None:
        raise ContractError("required HTTP header is missing")
    return value


def _validate_json_content_type(value: str) -> None:
    if _JSON_CONTENT_TYPE_PATTERN.fullmatch(value) is None:
        raise ContractError("HTTP content-type is not exact syntactic JSON media type")
    parameters: set[str] = set()
    pieces: list[str] = []
    start = 0
    quoted = False
    escaped = False
    for index, character in enumerate(value):
        if escaped:
            escaped = False
        elif quoted and character == "\\":
            escaped = True
        elif character == '"':
            quoted = not quoted
        elif character == ";" and not quoted:
            pieces.append(value[start:index])
            start = index + 1
    pieces.append(value[start:])
    if pieces[0].strip().lower() != "application/json":
        raise ContractError("HTTP content-type base type is not JSON")
    for piece in pieces[1:]:
        name = piece.split("=", 1)[0].strip().lower()
        if name in parameters:
            raise ContractError("HTTP content-type repeats a media parameter")
        parameters.add(name)


def _validate_hsts(value: str) -> None:
    directives: dict[str, str | None] = {}
    for item in value.split(";"):
        item = item.strip()
        if not item:
            raise ContractError("empty HSTS directive")
        if "=" in item:
            name, directive_value = item.split("=", 1)
            name = name.lower()
            if not directive_value:
                raise ContractError("empty HSTS directive value")
        else:
            name, directive_value = item.lower(), None
        if name in directives:
            raise ContractError("duplicate HSTS directive")
        directives[name] = directive_value
    max_age = directives.get("max-age")
    if max_age is None or re.fullmatch(r"0|[1-9][0-9]{0,8}", max_age) is None:
        raise ContractError("HSTS max-age is missing or malformed")
    numeric = int(max_age)
    if numeric <= 0 or numeric > 63_072_000:
        raise ContractError("HSTS max-age is ineffective or excessive")


def validate_public_response(status: int, headers_raw: bytes, body: bytes) -> None:
    if status != 200 or body != b'{"status":"ready"}':
        raise ContractError("public readiness status or exact body is wrong")
    headers = _parse_http_headers(headers_raw, status)
    _validate_hsts(_single_required_header(headers, "strict-transport-security"))
    if (
        _single_required_header(headers, "content-security-policy")
        != EXPECTED_CONTENT_SECURITY_POLICY
    ):
        raise ContractError("content security policy does not match production")
    if _single_required_header(headers, "x-content-type-options").lower() != "nosniff":
        raise ContractError("nosniff header is missing")
    if _single_required_header(headers, "cache-control").lower() != "no-store":
        raise ContractError("readiness response is cacheable")
    _validate_json_content_type(_single_required_header(headers, "content-type"))


def normalize_runner_secret(raw: bytes) -> bytes:
    # infra/runner/run-runner.sh imports this file through command substitution,
    # whose documented shell behavior removes all terminal LF bytes.
    normalized = raw.rstrip(b"\n")
    if (
        len(normalized) < 32
        or len(normalized) > 256
        or any(byte in normalized for byte in (0, 10, 13))
    ):
        raise ContractError("runner secret bytes are invalid")
    try:
        normalized.decode("utf-8", "strict")
    except UnicodeError as error:
        raise ContractError("runner secret is not UTF-8") from error
    return normalized


def validate_runner_response(
    status: int,
    headers_raw: bytes,
    body: bytes,
    challenge: str,
    secret: bytes,
    invocation_epoch: int,
    current_epoch: int,
) -> None:
    if status != 200 or len(body) > MAXIMUM_HTTP_BODY_BYTES or b"\x00" in body:
        raise ContractError("runner health status or body is invalid")
    match = _RUNNER_BODY_PATTERN.fullmatch(body)
    if match is None:
        raise ContractError("runner health body is not the exact envelope")
    queue_raw, active_raw, concurrency_raw, generated_raw = match.groups()
    if len(queue_raw) > 9 or len(active_raw) > 9 or len(concurrency_raw) > 2:
        raise ContractError("runner numeric field is too long")
    queue = int(queue_raw)
    active = int(active_raw)
    concurrency = int(concurrency_raw)
    generated = int(generated_raw)
    if queue < 0 or active < 0 or concurrency != 2 or active > concurrency:
        raise ContractError("runner two-slot health values are invalid")
    if (
        generated < invocation_epoch
        or generated > current_epoch + 30
        or current_epoch - generated > 30
    ):
        raise ContractError("runner health response is stale or future-dated")
    if _REQUEST_ID_PATTERN.fullmatch(challenge) is None:
        raise ContractError("checker request challenge is malformed")
    headers = _parse_http_headers(headers_raw, status)
    returned_id = _single_required_header(headers, "x-request-id")
    supplied_signature = _single_required_header(headers, "x-runner-response-signature")
    if returned_id != challenge or _SIGNATURE_PATTERN.fullmatch(supplied_signature) is None:
        raise ContractError("runner challenge or signature is invalid")
    _validate_json_content_type(_single_required_header(headers, "content-type"))
    if _single_required_header(headers, "cache-control").lower() != "no-store":
        raise ContractError("runner health is cacheable")
    if _single_required_header(headers, "x-content-type-options").lower() != "nosniff":
        raise ContractError("runner health lacks nosniff")
    body_hash = hashlib.sha256(body).hexdigest()
    canonical = f"{challenge}\n{status}\n{body_hash}".encode("ascii")
    expected = "sha256=" + hmac.new(secret, canonical, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(supplied_signature, expected):
        raise ContractError("runner response signature does not match exact bytes")


def _bounded_xml_root(raw: bytes, expected_root: str) -> ElementTree.Element:
    if (
        not raw
        or len(raw) > MAXIMUM_XML_BYTES
        or b"\x00" in raw
        or b"<!DOCTYPE" in raw.upper()
        or b"<!ENTITY" in raw.upper()
    ):
        raise ContractError("libvirt XML is missing, oversized, or unsafe")
    try:
        text = raw.decode("utf-8", "strict")
        root = ElementTree.fromstring(text)
    except (UnicodeError, ElementTree.ParseError) as error:
        raise ContractError("libvirt XML is malformed") from error
    for element in root.iter():
        if "{" in element.tag or ":" in element.tag:
            raise ContractError("libvirt XML namespaces are not allowed")
        if any("{" in name or ":" in name for name in element.attrib):
            raise ContractError("libvirt XML namespaced attributes are not allowed")
        if element.tail is not None and element.tail.strip():
            raise ContractError("libvirt XML contains unexpected structural text")
    if root.tag != expected_root:
        raise ContractError("libvirt XML root is unexpected")
    return root


def _exact_direct_children(parent: ElementTree.Element, name: str, count: int = 1) -> list[ElementTree.Element]:
    found = [child for child in parent if child.tag == name]
    if len(found) != count:
        raise ContractError(f"libvirt XML requires exactly {count} {name} element(s)")
    return found


def _empty_element(element: ElementTree.Element) -> None:
    if list(element) or (element.text is not None and element.text.strip()):
        raise ContractError("libvirt XML leaf element is not empty")


def _validate_libvirt_derived_number(value: str, label: str) -> None:
    if (
        re.fullmatch(r"(?:0|[1-9][0-9]{0,9})", value) is None
        or int(value) > MAXIMUM_LIBVIRT_DERIVED_NUMBER
    ):
        raise ContractError(f"libvirt live {label} is malformed")


def validate_runner_domain_xml(raw: bytes, *, live: bool = False) -> None:
    root = _bounded_xml_root(raw, "domain")
    root_attributes = dict(root.attrib)
    if root_attributes.pop("type", None) != "kvm":
        raise ContractError("runner domain virtualization type is not KVM")
    live_id = root_attributes.pop("id", None) if live else None
    if live_id is not None:
        _validate_libvirt_derived_number(live_id, "domain id")
    if root_attributes:
        raise ContractError("runner domain root has unreviewed attributes")
    names = _exact_direct_children(root, "name")
    if names[0].text != EXPECTED_RUNNER_DOMAIN or list(names[0]):
        raise ContractError("runner domain XML name is wrong")
    devices = _exact_direct_children(root, "devices")
    if devices[0].text is not None and devices[0].text.strip():
        raise ContractError("runner domain devices contain structural text")
    if root.findall(".//hostdev"):
        raise ContractError("runner domain contains a forbidden host device")
    interfaces = devices[0].findall("interface")
    if len(interfaces) != 1 or len(root.findall(".//interface")) != 1:
        raise ContractError("runner domain must have exactly one interface")
    interface = interfaces[0]
    if interface.text is not None and interface.text.strip():
        raise ContractError("runner domain interface contains structural text")
    if interface.attrib != {"type": "network"}:
        raise ContractError("runner domain interface type is not exact")
    allowed_children = {"mac", "source", "model", "target"}
    if live:
        allowed_children.update({"link", "alias", "address"})
    if any(child.tag not in allowed_children for child in interface):
        raise ContractError("runner domain interface has an unreviewed child")
    mac = _exact_direct_children(interface, "mac")[0]
    source = _exact_direct_children(interface, "source")[0]
    model = _exact_direct_children(interface, "model")[0]
    for leaf in (mac, source, model):
        _empty_element(leaf)
    if mac.attrib != {"address": EXPECTED_RUNNER_MAC}:
        raise ContractError("runner domain MAC is wrong")
    source_attributes = dict(source.attrib)
    if source_attributes.pop("network", None) != EXPECTED_RUNNER_NETWORK:
        raise ContractError("runner domain source network is wrong")
    if live:
        bridge = source_attributes.pop("bridge", EXPECTED_RUNNER_BRIDGE)
        if bridge != EXPECTED_RUNNER_BRIDGE:
            raise ContractError("runner live bridge is wrong")
        port_id = source_attributes.pop("portid", None)
        if port_id is not None and re.fullmatch(
            r"[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}",
            port_id,
            re.IGNORECASE,
        ) is None:
            raise ContractError("runner live port identity is malformed")
    if source_attributes:
        raise ContractError("runner domain source has unreviewed attributes")
    if model.attrib != {"type": "virtio"}:
        raise ContractError("runner domain interface model is wrong")
    targets = interface.findall("target")
    if len(targets) > 1:
        raise ContractError("runner domain contains duplicate interface targets")
    if targets:
        _empty_element(targets[0])
        if set(targets[0].attrib) != {"dev"} or re.fullmatch(
            r"vnet[0-9]+", targets[0].attrib["dev"]
        ) is None:
            raise ContractError("runner interface target is malformed")
    links = interface.findall("link")
    if len(links) > 1 or (links and links[0].attrib != {"state": "up"}):
        raise ContractError("runner live interface link is not up")
    for derived_name in ("link", "alias", "address"):
        derived = interface.findall(derived_name)
        if len(derived) > 1:
            raise ContractError("runner live interface derived state is duplicated")
        if derived:
            _empty_element(derived[0])


def validate_runner_network_xml(raw: bytes, *, live: bool = False) -> None:
    root = _bounded_xml_root(raw, "network")
    root_attributes = dict(root.attrib)
    live_connections = root_attributes.pop("connections", None) if live else None
    if live_connections is not None:
        _validate_libvirt_derived_number(live_connections, "network connections")
    if root_attributes:
        raise ContractError("runner network root has unreviewed attributes")
    if root.text is not None and root.text.strip():
        raise ContractError("runner network contains structural text")
    allowed_root = {"name", "uuid", "forward", "bridge", "ip"}
    if any(child.tag not in allowed_root for child in root):
        raise ContractError("runner network contains an unreviewed top-level feature")
    name = _exact_direct_children(root, "name")[0]
    if name.text != EXPECTED_RUNNER_NETWORK or list(name):
        raise ContractError("runner network name is wrong")
    uuids = root.findall("uuid")
    if len(uuids) > 1 or (
        uuids
        and re.fullmatch(
            r"[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}",
            uuids[0].text or "",
            re.IGNORECASE,
        )
        is None
    ):
        raise ContractError("runner network UUID is malformed")
    forward = _exact_direct_children(root, "forward")[0]
    if forward.attrib != {"mode": "nat"}:
        raise ContractError("runner network forwarding is not exact NAT")
    if list(forward) or (forward.text is not None and forward.text.strip()):
        raise ContractError("runner network NAT contains an unreviewed policy")
    bridge = _exact_direct_children(root, "bridge")[0]
    bridge_attributes = dict(bridge.attrib)
    if bridge_attributes.pop("name", None) != EXPECTED_RUNNER_BRIDGE:
        raise ContractError("runner network bridge is wrong")
    if bridge_attributes.pop("stp", "on") != "on" or bridge_attributes.pop("delay", "0") != "0":
        raise ContractError("runner network bridge behavior is wrong")
    if bridge_attributes:
        raise ContractError("runner network bridge has unreviewed attributes")
    _empty_element(bridge)
    ips = root.findall("ip")
    if len(ips) != 1:
        raise ContractError("runner network must have one IPv4 parent")
    ip_parent = ips[0]
    if ip_parent.text is not None and ip_parent.text.strip():
        raise ContractError("runner network IP parent contains structural text")
    if ip_parent.attrib != {
        "address": EXPECTED_RUNNER_GATEWAY,
        "netmask": EXPECTED_RUNNER_NETMASK,
    }:
        raise ContractError("runner network gateway or subnet is wrong")
    if any(child.tag != "dhcp" for child in ip_parent):
        raise ContractError("runner network IP parent has an unreviewed child")
    dhcp = _exact_direct_children(ip_parent, "dhcp")[0]
    if dhcp.text is not None and dhcp.text.strip():
        raise ContractError("runner DHCP contains structural text")
    if any(child.tag not in {"range", "host"} for child in dhcp):
        raise ContractError("runner DHCP contains an unreviewed child")
    subnet = ipaddress.ip_network(EXPECTED_RUNNER_NETWORK_CIDR)
    ranges: set[tuple[str, str]] = set()
    numeric_ranges: list[tuple[ipaddress.IPv4Address, ipaddress.IPv4Address]] = []
    for range_element in dhcp.findall("range"):
        _empty_element(range_element)
        if set(range_element.attrib) != {"start", "end"}:
            raise ContractError("runner DHCP range is malformed")
        try:
            start = ipaddress.ip_address(range_element.attrib["start"])
            end = ipaddress.ip_address(range_element.attrib["end"])
        except ValueError as error:
            raise ContractError("runner DHCP range address is malformed") from error
        if (
            start not in subnet
            or end not in subnet
            or start > end
            or start in (subnet.network_address, subnet.broadcast_address)
            or end in (subnet.network_address, subnet.broadcast_address)
        ):
            raise ContractError("runner DHCP range is outside the approved subnet")
        identity = (str(start), str(end))
        if identity in ranges:
            raise ContractError("runner DHCP range is duplicated")
        ranges.add(identity)
        numeric_ranges.append((start, end))
    numeric_ranges.sort()
    if any(
        current_start <= previous_end
        for (_previous_start, previous_end), (current_start, _current_end) in zip(
            numeric_ranges, numeric_ranges[1:]
        )
    ):
        raise ContractError("runner DHCP ranges overlap")
    if (EXPECTED_RUNNER_DHCP_START, EXPECTED_RUNNER_DHCP_END) not in ranges:
        raise ContractError("runner DHCP approved range is missing")
    runner_reservations = 0
    observed_macs: set[str] = set()
    observed_names: set[str] = set()
    observed_addresses: set[str] = set()
    for host in dhcp.findall("host"):
        _empty_element(host)
        if set(host.attrib) != {"mac", "name", "ip"}:
            raise ContractError("runner DHCP host is malformed")
        mac = host.attrib["mac"].lower()
        name_value = host.attrib["name"]
        address = host.attrib["ip"]
        if re.fullmatch(r"(?:[0-9a-f]{2}:){5}[0-9a-f]{2}", mac) is None:
            raise ContractError("runner DHCP MAC is malformed")
        if re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}", name_value) is None:
            raise ContractError("runner DHCP host name is malformed")
        try:
            parsed_address = ipaddress.ip_address(address)
        except ValueError as error:
            raise ContractError("runner DHCP host address is malformed") from error
        if parsed_address not in subnet or parsed_address in (
            subnet.network_address,
            subnet.broadcast_address,
            ipaddress.ip_address(EXPECTED_RUNNER_GATEWAY),
        ):
            raise ContractError("runner DHCP host is outside the approved subnet")
        if mac in observed_macs or name_value in observed_names or address in observed_addresses:
            raise ContractError("runner DHCP identity is duplicated")
        observed_macs.add(mac)
        observed_names.add(name_value)
        observed_addresses.add(address)
        matches_any_runner_identity = (
            mac == EXPECTED_RUNNER_MAC
            or name_value == EXPECTED_RUNNER_DOMAIN
            or address == EXPECTED_RUNNER_ADDRESS
        )
        if matches_any_runner_identity:
            if (mac, name_value, address) != (
                EXPECTED_RUNNER_MAC,
                EXPECTED_RUNNER_DOMAIN,
                EXPECTED_RUNNER_ADDRESS,
            ):
                raise ContractError("runner DHCP identity conflicts with its reservation")
            runner_reservations += 1
    if runner_reservations != 1:
        raise ContractError("runner DHCP reservation is missing or duplicated")


def _kill_process_group(process: subprocess.Popen[bytes]) -> None:
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except ProcessLookupError:
        return
    except OSError as error:
        raise ProbeError("probe process group could not be terminated") from error


def _process_group_members(process_group: int) -> set[int]:
    """Return every visible Linux process in one group, failing closed on ambiguity."""

    if process_group <= 0:
        raise ProbeError("probe process group identity is invalid")
    members: set[int] = set()
    try:
        process_entries = os.scandir("/proc")
    except OSError as error:
        raise ProbeError("Linux process-group inspection is unavailable") from error
    with process_entries:
        for entry in process_entries:
            if not entry.name.isascii() or not entry.name.isdecimal():
                continue
            process_id = int(entry.name)
            descriptor = -1
            try:
                descriptor = os.open(
                    f"/proc/{entry.name}/stat",
                    os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC,
                )
                chunks: list[bytes] = []
                total = 0
                while True:
                    chunk = os.read(
                        descriptor,
                        min(1_024, MAXIMUM_PROC_STAT_BYTES + 1 - total),
                    )
                    if not chunk:
                        break
                    chunks.append(chunk)
                    total += len(chunk)
                    if total > MAXIMUM_PROC_STAT_BYTES:
                        raise ProbeError("Linux process metadata exceeded its byte cap")
                raw = b"".join(chunks)
            except OSError as error:
                if error.errno in (errno.ENOENT, errno.ESRCH):
                    continue
                raise ProbeError("Linux process metadata could not be inspected") from error
            finally:
                if descriptor >= 0:
                    try:
                        os.close(descriptor)
                    except OSError as error:
                        raise ProbeError("Linux process metadata cleanup failed") from error
            closing = raw.rfind(b") ")
            prefix = f"{process_id} (".encode("ascii")
            if closing < len(prefix) or not raw.startswith(prefix):
                raise ProbeError("Linux process metadata is malformed")
            fields = raw[closing + 2 :].split()
            if len(fields) < 3 or not fields[2].isascii() or not fields[2].isdigit():
                raise ProbeError("Linux process group metadata is malformed")
            if int(fields[2]) == process_group:
                members.add(process_id)
    return members


def _wait_without_reaping(
    process: subprocess.Popen[bytes],
    ends_at: float,
    deadline: Deadline | None,
) -> None:
    """Observe leader exit while retaining its PID/PGID against reuse."""

    if not hasattr(os, "waitid"):
        raise ProbeError("non-reaping process supervision is unavailable")
    options = os.WEXITED | os.WNOHANG | os.WNOWAIT
    while True:
        if deadline is not None:
            deadline.check()
        try:
            observed = os.waitid(os.P_PID, process.pid, options)
        except ChildProcessError as error:
            raise ProbeError("probe leader was reaped before group cleanup") from error
        if observed is not None:
            return
        remaining = ends_at - time.monotonic()
        if remaining <= 0:
            raise ProbeError("probe did not exit after closing output")
        time.sleep(min(remaining, 0.01))


def _terminate_and_reap(
    process: subprocess.Popen[bytes], *, timeout_seconds: float = 1.0
) -> int:
    """Kill once and prove the retained leader is the group's last member."""

    if timeout_seconds <= 0:
        raise ProbeError("probe group cleanup has no remaining time")
    if getattr(process, "_recovery_group_cleanup_failed", False):
        raise ProbeError("probe process-group disappearance was not proved")
    if getattr(process, "_recovery_group_disappearance_proved", False):
        try:
            return process.wait(timeout=timeout_seconds)
        except (OSError, subprocess.TimeoutExpired) as error:
            raise ProbeError("probe leader could not be reaped after group cleanup") from error
    ends_at = time.monotonic() + timeout_seconds
    if not getattr(process, "_recovery_group_terminated", False):
        _kill_process_group(process)
        setattr(process, "_recovery_group_terminated", True)
    try:
        _wait_without_reaping(process, ends_at, None)
        while True:
            members = _process_group_members(process.pid)
            remaining = ends_at - time.monotonic()
            if remaining < 0:
                raise ProbeError("probe process group did not disappear within its bound")
            if members == {process.pid}:
                break
            if process.pid not in members:
                raise ProbeError("retained probe leader disappeared before group proof")
            if remaining == 0:
                raise ProbeError("probe process group did not disappear within its bound")
            time.sleep(min(remaining, 0.01))
    except ProbeError:
        setattr(process, "_recovery_group_cleanup_failed", True)
        try:
            process.wait(timeout=max(0.0, ends_at - time.monotonic()))
        except (OSError, subprocess.TimeoutExpired) as error:
            raise ProbeError("probe leader could not be reaped after failed group proof") from error
        raise
    setattr(process, "_recovery_group_disappearance_proved", True)
    try:
        return process.wait(timeout=max(0.0, ends_at - time.monotonic()))
    except (OSError, subprocess.TimeoutExpired) as error:
        raise ProbeError("probe leader could not be reaped after group cleanup") from error


def _capture_process(
    argv: Sequence[str],
    *,
    environment: Mapping[str, str],
    timeout_seconds: float,
    deadline: Deadline | None,
    stream_descriptors: Mapping[str, tuple[int, int]],
    pass_fds: Sequence[int] = (),
) -> ProcessResult:
    """Capture trusted probes and kill their dedicated group before reaping.

    Probe binaries are root-owned, non-writable host dependencies.  Their
    descendants must remain in the inherited session/process group; deliberate
    ``setsid`` escape by a compromised trusted binary is outside this local
    supervisor boundary and remains contained by the systemd service cgroup.
    """

    if timeout_seconds <= 0:
        raise ProbeError("probe has no remaining time")
    output: dict[str, bytearray] = {
        name: bytearray() for name in stream_descriptors
    }
    selector = selectors.DefaultSelector()
    process: subprocess.Popen[bytes] | None = None
    try:
        process = subprocess.Popen(
            list(argv),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE if "stdout" in stream_descriptors else subprocess.DEVNULL,
            stderr=subprocess.PIPE if "stderr" in stream_descriptors else subprocess.DEVNULL,
            env=dict(environment),
            close_fds=True,
            pass_fds=tuple(pass_fds),
            start_new_session=True,
        )
        actual_descriptors: dict[str, tuple[int, int]] = dict(stream_descriptors)
        if "stdout" in actual_descriptors:
            assert process.stdout is not None
            actual_descriptors["stdout"] = (
                process.stdout.fileno(),
                actual_descriptors["stdout"][1],
            )
        if "stderr" in actual_descriptors:
            assert process.stderr is not None
            actual_descriptors["stderr"] = (
                process.stderr.fileno(),
                actual_descriptors["stderr"][1],
            )
        for name, (descriptor, _cap) in actual_descriptors.items():
            os.set_blocking(descriptor, False)
            selector.register(descriptor, selectors.EVENT_READ, name)
        ends_at = time.monotonic() + timeout_seconds
        while selector.get_map():
            if deadline is not None:
                deadline.check()
            remaining = ends_at - time.monotonic()
            if remaining <= 0:
                raise ProbeError("probe timed out")
            events = selector.select(min(remaining, 0.1))
            for key, _mask in events:
                name = str(key.data)
                cap = actual_descriptors[name][1]
                try:
                    chunk = os.read(key.fd, min(65_536, cap + 1 - len(output[name])))
                except BlockingIOError:
                    continue
                if not chunk:
                    selector.unregister(key.fd)
                    continue
                output[name].extend(chunk)
                if len(output[name]) > cap:
                    raise ProbeError("probe output exceeded its byte cap")
        _wait_without_reaping(process, ends_at, deadline)
        returncode = _terminate_and_reap(process)
        if deadline is not None:
            deadline.check()
        return ProcessResult(
            returncode=returncode,
            streams={name: bytes(value) for name, value in output.items()},
        )
    except GlobalTimeout:
        raise
    except (OSError, subprocess.SubprocessError, ProbeError) as error:
        if isinstance(error, ProbeError):
            raise
        raise ProbeError("probe execution failed") from error
    finally:
        active_error = sys.exc_info()[0] is not None
        selector.close()
        if process is not None:
            try:
                _terminate_and_reap(process)
            except ProbeError:
                if not active_error:
                    raise
            if process.stdout is not None:
                process.stdout.close()
            if process.stderr is not None:
                process.stderr.close()


class RecoveryChecker:
    def __init__(self, *, test_mode: bool) -> None:
        self.test_mode = test_mode
        self.trusted_root = os.environ.get("RECOVERY_CHECK_TEST_ROOT", "/") if test_mode else "/"
        self.command_root = (
            os.environ.get("RECOVERY_CHECK_TEST_COMMAND_ROOT", "")
            if test_mode
            else "/usr/bin"
        )
        if not self.command_root or not os.path.isabs(self.command_root):
            raise ContractError("command root is invalid")
        command_root_metadata = os.stat(self.command_root, follow_symlinks=False)
        if (
            not stat.S_ISDIR(command_root_metadata.st_mode)
            or command_root_metadata.st_uid != 0
            or stat.S_IMODE(command_root_metadata.st_mode) & 0o022
        ):
            raise ContractError("command root is not trusted")
        if test_mode:
            clock_path = os.environ.get("RECOVERY_CHECK_TEST_MONOTONIC_FILE", "")
            if not clock_path:
                raise ContractError("test monotonic source is missing")
            monotonic: Callable[[], float] = FileMonotonicClock(clock_path)
            epoch_raw = os.environ.get("RECOVERY_CHECK_TEST_EPOCH", "")
            if re.fullmatch(r"[0-9]{10}", epoch_raw) is None:
                raise ContractError("test epoch is invalid")
            self.invocation_epoch = int(epoch_raw)
            self._epoch_base = self.invocation_epoch
        else:
            monotonic = time.monotonic
            self.invocation_epoch = int(time.time())
            self._epoch_base = 0
        self.deadline = Deadline(RECOVERY_LIMIT_SECONDS, monotonic=monotonic)
        self.environment = self._command_environment()
        self.configuration: RuntimeConfiguration | None = None
        self.expected_containers: dict[str, ContainerIdentity] = {}
        self._compose_environment: ProtectedFile | None = None
        self._compose_definition: ProtectedFile | None = None
        self._runner_secret_gid = _runner_secret_expected_gid(test_mode)
        self._last_challenge = ""

    def _command_environment(self) -> dict[str, str]:
        environment = {
            "HOME": "/nonexistent",
            "LANG": "C",
            "LC_ALL": "C",
            "PATH": "/usr/bin:/bin",
            "DOCKER_CONFIG": "/nonexistent",
            "COMPOSE_PROFILES": "",
            "PYTHONDONTWRITEBYTECODE": "1",
            "XDG_CONFIG_HOME": "/nonexistent",
        }
        if self.test_mode:
            for name, value in os.environ.items():
                if name.startswith("FAKE_"):
                    environment[name] = value
            environment["FAKE_DEADLINE_ACTIVE"] = "1"
        return environment

    def _command(self, name: str) -> str:
        if re.fullmatch(r"[a-z][a-z0-9-]*", name) is None:
            raise ContractError("command name is invalid")
        candidate = os.path.join(self.command_root, name)
        try:
            metadata = os.stat(candidate)
        except OSError as error:
            raise ProbeError("required command is unavailable") from error
        if (
            not stat.S_ISREG(metadata.st_mode)
            or metadata.st_uid != 0
            or stat.S_IMODE(metadata.st_mode) & 0o022
            or not os.access(candidate, os.X_OK)
        ):
            raise ProbeError("required command is not trusted")
        return candidate

    def _run(
        self,
        name: str,
        arguments: Sequence[str],
        *,
        cap: int = MAXIMUM_COMMAND_BYTES,
        timeout_seconds: int = LOCAL_PROBE_SECONDS,
    ) -> bytes:
        remaining = self.deadline.remaining()
        if remaining <= 0:
            raise GlobalTimeout("global recovery deadline exhausted")
        result = _capture_process(
            (self._command(name), *arguments),
            environment=self.environment,
            timeout_seconds=min(float(timeout_seconds), remaining),
            deadline=self.deadline,
            stream_descriptors={
                "stdout": (-1, cap),
                "stderr": (-1, MAXIMUM_STDERR_BYTES),
            },
        )
        if result.returncode != 0:
            raise ProbeError("probe returned nonzero")
        return result.streams["stdout"]

    def _compose_arguments(self) -> tuple[str, ...]:
        if self._compose_environment is None or self._compose_definition is None:
            raise ContractError("protected Compose inputs are not loaded")
        return (
            "compose",
            "--env-file",
            self._compose_environment.proc_path,
            "-f",
            self._compose_definition.proc_path,
            "--project-directory",
            self._rooted("opt/learncoding"),
        )

    def _rooted(self, relative: str) -> str:
        return str(pathlib.PurePosixPath(self.trusted_root) / relative)

    def _now_epoch(self) -> int:
        if self.test_mode:
            return self._epoch_base + self.deadline.elapsed_seconds()
        return int(time.time())

    def load_inputs(self) -> ProbeState:
        if self._compose_environment is not None or self._compose_definition is not None:
            raise ContractError("protected recovery inputs were loaded twice")
        state = ProbeState()
        environment_file: ProtectedFile | None = None
        compose_file: ProtectedFile | None = None
        try:
            baseline = read_protected_file(
                self.trusted_root,
                BASELINE_RELATIVE,
                0,
                0,
                0o600,
                MAXIMUM_BASELINE_BYTES,
            )
            environment_file = open_protected_file(
                self.trusted_root, COMPOSE_ENV_RELATIVE, 0, 0, 0o640, 65_536
            )
            compose_file = open_protected_file(
                self.trusted_root,
                COMPOSE_FILE_RELATIVE,
                0,
                0,
                0o644,
                2_097_152,
            )
            normalize_runner_secret(
                read_protected_file(
                    self.trusted_root,
                    RUNNER_SECRET_RELATIVE,
                    0,
                    self._runner_secret_gid,
                    0o440,
                    256,
                )
            )
            configuration = parse_runtime_environment(environment_file.data)
            try:
                identities = parse_baseline(baseline)
            except BaselineContractError as error:
                raise ContractError("protected container baseline is invalid") from error
            self.configuration = configuration
            self.expected_containers = identities
            self._compose_environment = environment_file
            self._compose_definition = compose_file
            environment_file = None
            compose_file = None
            state.existing_expected = len(identities)
            return state
        finally:
            cleanup_failed = False
            for protected in (environment_file, compose_file):
                if protected is not None:
                    try:
                        protected.close()
                    except ContractError:
                        cleanup_failed = True
            if cleanup_failed and sys.exc_info()[0] is None:
                raise ContractError("protected input cleanup failed")

    def close(self) -> None:
        cleanup_failed = False
        for protected in (self._compose_environment, self._compose_definition):
            if protected is not None:
                try:
                    protected.close()
                except ContractError:
                    cleanup_failed = True
        self._compose_environment = None
        self._compose_definition = None
        if cleanup_failed:
            raise ProbeError("protected recovery input cleanup failed")

    def verify_compose_inputs_current(self) -> None:
        if self._compose_environment is None or self._compose_definition is None:
            raise ContractError("protected Compose inputs are not loaded")
        self._compose_environment.verify_current()
        self._compose_definition.verify_current()

    def _systemctl_value(self, *arguments: str) -> str:
        raw = self._run("systemctl", arguments, cap=256)
        try:
            value = raw.decode("ascii", "strict")
        except UnicodeError as error:
            raise ContractError("systemctl output is not ASCII") from error
        if not value.endswith("\n") or "\n" in value[:-1] or "\r" in value:
            raise ContractError("systemctl output is not one exact line")
        return value[:-1]

    def _unit_active(self, unit: str) -> bool:
        try:
            return self._systemctl_value("is-active", unit) == "active"
        except (ContractError, ProbeError):
            return False

    def _compose_inventory(self) -> bool:
        try:
            rendered = self._run(
                "docker",
                (*self._compose_arguments(), "config", "--services"),
                cap=4_096,
            )
            validate_compose_services(rendered)
            raw = self._run(
                "docker",
                (*self._compose_arguments(), "ps", "--all", "--format", "json"),
                cap=MAXIMUM_COMMAND_BYTES,
            )
            validate_compose_json_lines(raw)
            return True
        except (ContractError, ProbeError):
            return False

    def _postgres_ready(self) -> bool:
        try:
            self._run(
                "docker",
                (
                    *self._compose_arguments(),
                    "exec",
                    "-T",
                    "postgres",
                    "pg_isready",
                    "--host=/var/run/postgresql",
                    "--port=5432",
                    "--username=learncoding",
                    "--dbname=learncoding",
                    "--timeout=1",
                ),
                cap=1_024,
            )
            return True
        except (ContractError, ProbeError):
            return False

    def _postgres_settings(self) -> bool:
        try:
            raw = self._run(
                "docker",
                (
                    *self._compose_arguments(),
                    "exec",
                    "-T",
                    "postgres",
                    "psql",
                    "-X",
                    "--host=/var/run/postgresql",
                    "--port=5432",
                    "--username=learncoding",
                    "--dbname=learncoding",
                    "--no-align",
                    "--tuples-only",
                    "--field-separator=|",
                    "--command",
                    POSTGRES_SQL,
                ),
                cap=4_096,
            )
            settings: dict[str, str] = {}
            lines = raw.split(b"\n")
            if lines and lines[-1] == b"":
                lines.pop()
            for line in lines:
                pieces = line.split(b"|")
                if len(pieces) != 2:
                    raise ContractError("PostgreSQL setting row is malformed")
                name = pieces[0].decode("ascii", "strict")
                value = pieces[1].decode("ascii", "strict")
                if name not in EXPECTED_POSTGRES_SETTINGS or name in settings:
                    raise ContractError("PostgreSQL setting row is unexpected")
                settings[name] = value
            return settings == EXPECTED_POSTGRES_SETTINGS
        except (ContractError, ProbeError, UnicodeError):
            return False

    def _postgres_mount(self) -> bool:
        assert self.configuration is not None
        try:
            raw = self._run(
                "docker",
                (
                    "inspect",
                    "--type",
                    "container",
                    "learncoding-postgres-1",
                    "--format",
                    "{{json .Mounts}}",
                ),
                cap=16_384,
            )
            if raw.endswith(b"\n"):
                raw = raw[:-1]
            value = _json_loads_exact(raw)
            if not isinstance(value, list):
                return False
            matches = 0
            for mount in value:
                if not isinstance(mount, dict):
                    return False
                if mount.get("Destination") == "/var/lib/postgresql/data":
                    if (
                        mount.get("Type") != "bind"
                        or mount.get("Source") != self.configuration.postgres_data
                        or mount.get("RW") is not True
                    ):
                        return False
                    matches += 1
            return matches == 1
        except (ContractError, ProbeError):
            return False

    def _postgres_durable(self) -> bool:
        return self._postgres_settings() and self._postgres_mount()

    def _existing_containers(self) -> int:
        matches = 0
        for name, record in self.expected_containers.items():
            try:
                raw = self._run(
                    "docker",
                    ("inspect", "--type", "container", name),
                    cap=MAXIMUM_INSPECTION_BYTES,
                )
                if inspection_matches_record(raw, record):
                    matches += 1
            except (ContractError, ProbeError):
                continue
        return matches

    @staticmethod
    def _single_fields(raw: bytes, expected: Mapping[str, str]) -> bool:
        try:
            text = raw.decode("ascii", "strict")
        except UnicodeError:
            return False
        found: dict[str, str] = {}
        for line in text.splitlines():
            if ":" not in line:
                continue
            label, value = line.split(":", 1)
            if label in expected:
                if label in found:
                    return False
                found[label] = value.strip()
        return found == dict(expected)

    def _runner_topology(self) -> bool:
        try:
            domain_state = self._run(
                "virsh",
                ("--connect", "qemu:///system", "domstate", EXPECTED_RUNNER_DOMAIN),
                cap=256,
            )
            if domain_state != b"running\n":
                return False
            domain_info = self._run(
                "virsh",
                ("--connect", "qemu:///system", "dominfo", EXPECTED_RUNNER_DOMAIN),
                cap=4_096,
            )
            if not self._single_fields(
                domain_info,
                {
                    "Name": EXPECTED_RUNNER_DOMAIN,
                    "Autostart": "enable",
                    "Persistent": "yes",
                },
            ):
                return False
            inactive_domain_xml = self._run(
                "virsh",
                (
                    "--connect",
                    "qemu:///system",
                    "dumpxml",
                    EXPECTED_RUNNER_DOMAIN,
                    "--inactive",
                ),
                cap=MAXIMUM_XML_BYTES,
            )
            live_domain_xml = self._run(
                "virsh",
                ("--connect", "qemu:///system", "dumpxml", EXPECTED_RUNNER_DOMAIN),
                cap=MAXIMUM_XML_BYTES,
            )
            validate_runner_domain_xml(inactive_domain_xml)
            validate_runner_domain_xml(live_domain_xml, live=True)
            network_info = self._run(
                "virsh",
                ("--connect", "qemu:///system", "net-info", EXPECTED_RUNNER_NETWORK),
                cap=4_096,
            )
            if not self._single_fields(
                network_info,
                {
                    "Name": EXPECTED_RUNNER_NETWORK,
                    "Bridge": EXPECTED_RUNNER_BRIDGE,
                    "Active": "yes",
                    "Autostart": "yes",
                    "Persistent": "yes",
                },
            ):
                return False
            inactive_network_xml = self._run(
                "virsh",
                (
                    "--connect",
                    "qemu:///system",
                    "net-dumpxml",
                    EXPECTED_RUNNER_NETWORK,
                    "--inactive",
                ),
                cap=MAXIMUM_XML_BYTES,
            )
            live_network_xml = self._run(
                "virsh",
                (
                    "--connect",
                    "qemu:///system",
                    "net-dumpxml",
                    EXPECTED_RUNNER_NETWORK,
                ),
                cap=MAXIMUM_XML_BYTES,
            )
            validate_runner_network_xml(inactive_network_xml)
            validate_runner_network_xml(live_network_xml, live=True)
            interface_list = self._run(
                "virsh",
                ("--connect", "qemu:///system", "domiflist", EXPECTED_RUNNER_DOMAIN),
                cap=4_096,
            )
            interface_rows = []
            for line in interface_list.decode("ascii", "strict").splitlines():
                stripped = line.strip()
                if (
                    not stripped
                    or re.fullmatch(r"Interface\s+Type\s+Source\s+Model\s+MAC", stripped)
                    or set(stripped) == {"-"}
                ):
                    continue
                interface_rows.append(stripped.split())
            if (
                len(interface_rows) != 1
                or len(interface_rows[0]) != 5
                or interface_rows[0][1:4]
                != ["network", EXPECTED_RUNNER_NETWORK, "virtio"]
                or interface_rows[0][4] != EXPECTED_RUNNER_MAC
                or re.fullmatch(r"vnet[0-9]+", interface_rows[0][0]) is None
            ):
                return False
            address_list = self._run(
                "virsh",
                (
                    "--connect",
                    "qemu:///system",
                    "domifaddr",
                    EXPECTED_RUNNER_DOMAIN,
                    "--source",
                    "lease",
                    "--full",
                ),
                cap=4_096,
            )
            address_rows = []
            for line in address_list.decode("ascii", "strict").splitlines():
                stripped = line.strip()
                if (
                    not stripped
                    or re.fullmatch(
                        r"Name\s+MAC address\s+Protocol\s+Address", stripped
                    )
                    or set(stripped) == {"-"}
                ):
                    continue
                address_rows.append(stripped.split())
            return (
                len(address_rows) == 1
                and len(address_rows[0]) == 4
                and address_rows[0][0] == interface_rows[0][0]
                and address_rows[0][1] == interface_rows[0][4]
                and address_rows[0][2] == "ipv4"
                and address_rows[0][3] == f"{EXPECTED_RUNNER_ADDRESS}/24"
            )
        except (ContractError, ProbeError, UnicodeError):
            return False

    def _http(self, url: str, challenge: str | None = None) -> HttpResponse:
        body_read = body_write = header_read = header_write = -1
        process: subprocess.Popen[bytes] | None = None
        cleanup_failed = False
        try:
            body_read, body_write = os.pipe2(os.O_CLOEXEC)
            header_read, header_write = os.pipe2(os.O_CLOEXEC)
            os.set_inheritable(body_write, True)
            os.set_inheritable(header_write, True)
            protocol = "=https" if url.startswith("https://") else "=http"
            arguments = [
                self._command("curl"),
                "--disable",
                "--silent",
                "--show-error",
                "--fail-with-body",
                "--globoff",
                "--noproxy",
                "*",
                "--proto",
                protocol,
                "--connect-timeout",
                "5",
                "--max-time",
                "10",
                "--max-filesize",
                str(MAXIMUM_HTTP_BODY_BYTES),
                "--request",
                "GET",
                "--header",
                "accept-encoding: identity",
            ]
            if challenge is not None:
                arguments.extend(("--header", f"x-request-id: {challenge}"))
            arguments.extend(
                (
                    "--output",
                    f"/proc/self/fd/{body_write}",
                    "--dump-header",
                    f"/proc/self/fd/{header_write}",
                    "--write-out",
                    "%{http_code}",
                    "--url",
                    url,
                )
            )
            remaining = self.deadline.remaining()
            if remaining <= 0:
                raise GlobalTimeout("global recovery deadline exhausted")
            process = subprocess.Popen(
                arguments,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                env=dict(self.environment),
                close_fds=True,
                pass_fds=(body_write, header_write),
                start_new_session=True,
            )
            os.close(body_write)
            body_write = -1
            os.close(header_write)
            header_write = -1
            assert process.stdout is not None and process.stderr is not None
            probe_seconds = HTTP_PROBE_SECONDS
            if self.test_mode:
                test_timeout = os.environ.get("FAKE_HTTP_TIMEOUT_SECONDS")
                if test_timeout is not None:
                    if re.fullmatch(r"[1-2]", test_timeout) is None:
                        raise ContractError("test HTTP timeout is invalid")
                    probe_seconds = int(test_timeout)
            result = self._capture_existing_process(
                process,
                {
                    "stdout": (process.stdout.fileno(), 3),
                    "stderr": (process.stderr.fileno(), MAXIMUM_STDERR_BYTES),
                    "body": (body_read, MAXIMUM_HTTP_BODY_BYTES),
                    "headers": (header_read, MAXIMUM_HTTP_HEADER_BYTES),
                },
                min(float(probe_seconds), remaining),
            )
            os.close(body_read)
            body_read = -1
            os.close(header_read)
            header_read = -1
            if result.returncode != 0:
                raise ProbeError("HTTP probe returned nonzero")
            status_raw = result.streams["stdout"]
            if re.fullmatch(rb"[0-9]{3}", status_raw) is None:
                raise ContractError("curl status output is malformed")
            return HttpResponse(
                status=int(status_raw),
                headers=result.streams["headers"],
                body=result.streams["body"],
            )
        finally:
            if process is not None:
                try:
                    _terminate_and_reap(process)
                except ProbeError:
                    cleanup_failed = True
                if process.stdout is not None:
                    try:
                        process.stdout.close()
                    except OSError:
                        cleanup_failed = True
                if process.stderr is not None:
                    try:
                        process.stderr.close()
                    except OSError:
                        cleanup_failed = True
            for descriptor in (body_read, body_write, header_read, header_write):
                if descriptor >= 0:
                    try:
                        os.close(descriptor)
                    except OSError:
                        cleanup_failed = True
            if cleanup_failed and sys.exc_info()[0] is None:
                raise ProbeError("HTTP resource cleanup failed")

    def _capture_existing_process(
        self,
        process: subprocess.Popen[bytes],
        streams: Mapping[str, tuple[int, int]],
        timeout_seconds: float,
    ) -> ProcessResult:
        selector = selectors.DefaultSelector()
        output = {name: bytearray() for name in streams}
        try:
            for name, (descriptor, _cap) in streams.items():
                os.set_blocking(descriptor, False)
                selector.register(descriptor, selectors.EVENT_READ, name)
            ends_at = time.monotonic() + timeout_seconds
            while selector.get_map():
                self.deadline.check()
                remaining = ends_at - time.monotonic()
                if remaining <= 0:
                    raise ProbeError("HTTP probe timed out")
                events = selector.select(min(remaining, 0.1))
                for key, _mask in events:
                    name = str(key.data)
                    cap = streams[name][1]
                    try:
                        chunk = os.read(key.fd, min(65_536, cap + 1 - len(output[name])))
                    except BlockingIOError:
                        continue
                    if not chunk:
                        selector.unregister(key.fd)
                        continue
                    output[name].extend(chunk)
                    if len(output[name]) > cap:
                        raise ProbeError("HTTP stream exceeded its in-flight byte cap")
            _wait_without_reaping(process, ends_at, self.deadline)
            returncode = _terminate_and_reap(process)
            self.deadline.check()
            return ProcessResult(
                returncode=returncode,
                streams={name: bytes(value) for name, value in output.items()},
            )
        except (OSError, ProbeError):
            raise
        finally:
            active_error = sys.exc_info()[0] is not None
            selector.close()
            try:
                _terminate_and_reap(process)
            except ProbeError:
                if not active_error:
                    raise

    def _public_https(self) -> bool:
        assert self.configuration is not None
        try:
            response = self._http(self.configuration.public_url)
            validate_public_response(response.status, response.headers, response.body)
            return True
        except (ContractError, ProbeError):
            return False

    def _runner_http(self) -> bool:
        assert self.configuration is not None
        try:
            secret = normalize_runner_secret(
                read_protected_file(
                    self.trusted_root,
                    RUNNER_SECRET_RELATIVE,
                    0,
                    self._runner_secret_gid,
                    0o440,
                    256,
                )
            )
            challenge = "recovery-" + secrets.token_hex(16)
            if challenge == self._last_challenge:
                raise ContractError("runner challenge was reused")
            self._last_challenge = challenge
            response = self._http(f"{self.configuration.runner_base}/healthz", challenge)
            validate_runner_response(
                response.status,
                response.headers,
                response.body,
                challenge,
                secret,
                self.invocation_epoch,
                self._now_epoch(),
            )
            return True
        except (ContractError, ProbeError, UnicodeError):
            return False

    def _timers(self) -> bool:
        units = (
            "learncoding-backup.timer",
            "learncoding-backup-check.timer",
            "learncoding-offsite-sync.timer",
            "learncoding-offsite-retention.timer",
            "learncoding-restore-drill-reminder.timer",
            "learncoding-retention.timer",
            "learncoding-recovery-check.timer",
            "learncoding-ingress-recovery.timer",
        )
        try:
            for unit in units:
                if self._systemctl_value("is-active", unit) != "active":
                    return False
                if self._systemctl_value("is-enabled", unit) != "enabled":
                    return False
                if (
                    self._systemctl_value(
                        "show", unit, "--property=Persistent", "--value"
                    )
                    != "yes"
                ):
                    return False
            return True
        except (ContractError, ProbeError):
            return False

    def poll(self, baseline_state: ProbeState) -> ProbeState:
        state = ProbeState(existing_expected=baseline_state.existing_expected)
        state.dockerHealthy = self._unit_active("docker.service")
        if state.dockerHealthy:
            try:
                self._run("docker", ("info",), cap=16_384)
            except (ContractError, ProbeError):
                state.dockerHealthy = False
        state.libvirtHealthy = self._unit_active("libvirtd.service")
        state.firewallHealthy = self._unit_active("learncoding-runner-firewall.service")
        compose_ok = self._compose_inventory()
        state.postgresHealthy = compose_ok and self._postgres_ready()
        state.postgresDurable = compose_ok and self._postgres_durable()
        state.appHealthy = (
            compose_ok and self._unit_active("learncoding-compose.service")
        )
        state.workersHealthy = compose_ok
        state.cloudflaredHealthy = compose_ok
        state.publicHttpsHealthy = self._public_https()
        state.runnerHealthy = (
            state.libvirtHealthy
            and self._runner_topology()
            and self._runner_http()
        )
        state.timersHealthy = self._timers()
        state.existing_running = self._existing_containers()
        self.deadline.check()
        return state

    def sleep_poll(self) -> None:
        remaining = self.deadline.remaining()
        if remaining <= 0:
            raise GlobalTimeout("global recovery deadline exhausted")
        seconds = min(RECOVERY_POLL_SECONDS, max(1, int(remaining)))
        self._run(
            "sleep",
            (str(seconds),),
            cap=0,
            timeout_seconds=min(seconds + 1, int(remaining) + 1),
        )


def _write_test_diagnostic(test_mode: bool, error: BaseException) -> None:
    if not test_mode:
        return
    destination = os.environ.get("FAKE_DIAGNOSTIC_FILE", "")
    if not destination or not os.path.isabs(destination):
        return
    message = f"{type(error).__name__}:{error}".encode("utf-8", "replace")[:1_024]
    descriptor = -1
    try:
        descriptor = os.open(
            destination,
            os.O_WRONLY | os.O_TRUNC | os.O_CLOEXEC | os.O_NOFOLLOW,
        )
        metadata = os.fstat(descriptor)
        if not stat.S_ISREG(metadata.st_mode):
            return
        os.write(descriptor, message)
        os.fsync(descriptor)
    except OSError:
        return
    finally:
        if descriptor >= 0:
            try:
                os.close(descriptor)
            except OSError:
                pass


def _worker_result(test_mode: bool) -> tuple[dict[str, object], int]:
    state = ProbeState()
    checker: RecoveryChecker | None = None
    outcome = result_payload(
        state, recovered=False, timed_out=False, elapsed=0
    ), 1
    try:
        checker = RecoveryChecker(test_mode=test_mode)
        if test_mode:
            scenario_file = os.environ.get("FAKE_SCENARIO_FILE", "")
            try:
                scenario = pathlib.Path(scenario_file).read_text(encoding="ascii")
            except OSError:
                scenario = ""
            if scenario in ("watchdog-hang", "signal-hang"):
                while True:
                    signal.pause()
        state = checker.load_inputs()
        while True:
            state = checker.poll(state)
            elapsed = checker.deadline.elapsed_seconds()
            if state.recovered():
                checker.verify_compose_inputs_current()
                outcome = result_payload(
                    state, recovered=True, timed_out=False, elapsed=elapsed
                ), 0
                break
            checker.deadline.check()
            checker.sleep_poll()
    except GlobalTimeout:
        outcome = result_payload(
            state,
            recovered=False,
            timed_out=True,
            elapsed=RECOVERY_LIMIT_SECONDS,
        ), 1
    except (ContractError, ProbeError, OSError, ValueError) as error:
        _write_test_diagnostic(test_mode, error)
        elapsed = 0
        if checker is not None:
            try:
                elapsed = checker.deadline.elapsed_seconds()
            except (ContractError, GlobalTimeout):
                elapsed = 0
        outcome = result_payload(
            ProbeState(), recovered=False, timed_out=False, elapsed=elapsed
        ), 1
    finally:
        if checker is not None:
            try:
                checker.close()
            except (ContractError, ProbeError, OSError):
                outcome = result_payload(
                    ProbeState(), recovered=False, timed_out=False, elapsed=0
                ), 1
    return outcome


def _validate_worker_payload(raw: bytes) -> dict[str, object]:
    if not raw.endswith(b"\n") or raw.count(b"\n") != 1 or len(raw) > 2_048:
        raise ContractError("worker did not return one bounded aggregate")
    value = _json_loads_exact(raw[:-1])
    if not isinstance(value, dict):
        raise ContractError("worker aggregate is not an object")
    expected_keys = {
        *RESULT_HEALTH_FIELDS,
        "elapsedSeconds",
        "existingContainersExpected",
        "existingContainersRunning",
        "recovered",
        "schemaVersion",
        "timedOut",
    }
    if set(value) != expected_keys or value.get("schemaVersion") != 1:
        raise ContractError("worker aggregate schema is invalid")
    for name in (*RESULT_HEALTH_FIELDS, "recovered", "timedOut"):
        if type(value.get(name)) is not bool:
            raise ContractError("worker aggregate boolean is invalid")
    for name in (
        "elapsedSeconds",
        "existingContainersExpected",
        "existingContainersRunning",
    ):
        numeric = value.get(name)
        if type(numeric) is not int or numeric < 0:
            raise ContractError("worker aggregate count is invalid")
    if value["elapsedSeconds"] > RECOVERY_LIMIT_SECONDS:
        raise ContractError("worker aggregate exceeded global deadline")
    if value["existingContainersRunning"] > value["existingContainersExpected"]:
        raise ContractError("worker aggregate container counts are invalid")
    return value


def _minimal_worker_environment(test_mode: bool) -> dict[str, str]:
    environment = {
        "HOME": "/nonexistent",
        "LANG": "C",
        "LC_ALL": "C",
        "PATH": "/usr/bin:/bin",
        "PYTHONDONTWRITEBYTECODE": "1",
    }
    if test_mode:
        allowed_exact = {
            "RECOVERY_CHECK_TEST_ROOT",
            "RECOVERY_CHECK_TEST_COMMAND_ROOT",
            "RECOVERY_CHECK_TEST_MONOTONIC_FILE",
            "RECOVERY_CHECK_TEST_EPOCH",
            "RECOVERY_CHECK_TEST_RUNNER_SECRET_GID",
            "RECOVERY_CHECK_TEST_WATCHDOG_SECONDS",
        }
        for name, value in os.environ.items():
            if name in allowed_exact or name.startswith("FAKE_"):
                environment[name] = value
    return environment


_TERMINATION_SIGNALS: Final = frozenset(
    (signal.SIGINT, signal.SIGTERM, getattr(signal, "SIGHUP", signal.SIGTERM))
)
_parent_child: subprocess.Popen[bytes] | None = None
_termination_requested = False


def _parent_signal(_signum: int, _frame: object) -> None:
    global _termination_requested
    _termination_requested = True


def _block_termination_signals() -> set[signal.Signals]:
    if not hasattr(signal, "pthread_sigmask"):
        raise ContractError("race-safe signal masking is unavailable")
    return signal.pthread_sigmask(signal.SIG_BLOCK, _TERMINATION_SIGNALS)


def _restore_signal_mask(previous: set[signal.Signals]) -> None:
    signal.pthread_sigmask(signal.SIG_SETMASK, previous)


def _check_termination_requested() -> None:
    if _termination_requested:
        raise TerminationRequested("recovery checker interrupted")


def _inject_test_signal(test_mode: bool, phase: str) -> None:
    if not test_mode:
        return
    configured = os.environ.get("FAKE_SIGNAL_PHASE")
    if configured not in (phase, f"{phase}:repeated"):
        return
    os.kill(os.getpid(), signal.SIGTERM)
    if configured.endswith(":repeated"):
        os.kill(os.getpid(), getattr(signal, "SIGHUP", signal.SIGTERM))


def _run_parent(test_mode: bool) -> tuple[dict[str, object], int]:
    global _parent_child
    fallback_state = ProbeState()
    fallback = result_payload(
        fallback_state, recovered=False, timed_out=False, elapsed=0
    ), 1
    outcome = fallback
    watchdog_seconds = RECOVERY_LIMIT_SECONDS
    if test_mode:
        override = os.environ.get("RECOVERY_CHECK_TEST_WATCHDOG_SECONDS")
        if override is not None:
            if re.fullmatch(r"[1-9][0-9]?", override) is None:
                return fallback
            watchdog_seconds = int(override)
    for signum in _TERMINATION_SIGNALS:
        signal.signal(signum, _parent_signal)
    actual_deadline = Deadline(watchdog_seconds)
    spawn_mask = _block_termination_signals()
    try:
        _inject_test_signal(test_mode, "before-spawn")
        try:
            _parent_child = subprocess.Popen(
                (
                    sys.executable,
                    os.path.abspath(__file__),
                    "--worker",
                    *(("--test-mode",) if test_mode else ()),
                ),
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                env=_minimal_worker_environment(test_mode),
                close_fds=True,
                start_new_session=True,
            )
            _inject_test_signal(test_mode, "after-assignment")
        finally:
            _restore_signal_mask(spawn_mask)
        _check_termination_requested()
        assert _parent_child.stdout is not None and _parent_child.stderr is not None
        selector = selectors.DefaultSelector()
        output = {"stdout": bytearray(), "stderr": bytearray()}
        streams = {
            "stdout": (_parent_child.stdout.fileno(), 2_048),
            "stderr": (_parent_child.stderr.fileno(), MAXIMUM_STDERR_BYTES),
        }
        reading_signal_injected = False
        try:
            for name, (descriptor, _cap) in streams.items():
                os.set_blocking(descriptor, False)
                selector.register(descriptor, selectors.EVENT_READ, name)
            while selector.get_map():
                _check_termination_requested()
                if not reading_signal_injected:
                    _inject_test_signal(test_mode, "reading")
                    reading_signal_injected = True
                    _check_termination_requested()
                if actual_deadline.remaining() <= 0:
                    raise GlobalTimeout("independent hard watchdog expired")
                events = selector.select(min(actual_deadline.remaining(), 0.1))
                for key, _mask in events:
                    name = str(key.data)
                    cap = streams[name][1]
                    try:
                        chunk = os.read(key.fd, min(4_096, cap + 1 - len(output[name])))
                    except BlockingIOError:
                        continue
                    if not chunk:
                        selector.unregister(key.fd)
                        continue
                    output[name].extend(chunk)
                    if len(output[name]) > cap:
                        raise ContractError("worker output exceeded its cap")
            _wait_without_reaping(
                _parent_child,
                time.monotonic() + max(0.01, actual_deadline.remaining()),
                actual_deadline,
            )
            returncode = _terminate_and_reap(_parent_child)
        finally:
            selector.close()
        _check_termination_requested()
        payload = _validate_worker_payload(bytes(output["stdout"]))
        if output["stderr"]:
            if test_mode:
                diagnostic = bytes(output["stderr"][:1_024]).decode(
                    "utf-8", "replace"
                )
                _write_test_diagnostic(
                    True, ContractError(f"worker stderr: {diagnostic}")
                )
            raise ContractError("worker emitted diagnostics")
        outcome = payload, 0 if returncode == 0 and payload["recovered"] is True else 1
    except GlobalTimeout:
        outcome = result_payload(
            fallback_state,
            recovered=False,
            timed_out=True,
            elapsed=RECOVERY_LIMIT_SECONDS,
        ), 1
    except (ContractError, OSError, subprocess.SubprocessError, TerminationRequested):
        outcome = fallback
    finally:
        cleanup_mask = _block_termination_signals()
        cleanup_failed = False
        try:
            _inject_test_signal(test_mode, "cleanup")
            if _parent_child is not None:
                try:
                    _terminate_and_reap(_parent_child)
                except ProbeError:
                    cleanup_failed = True
                if _parent_child.stdout is not None:
                    try:
                        _parent_child.stdout.close()
                    except OSError:
                        cleanup_failed = True
                if _parent_child.stderr is not None:
                    try:
                        _parent_child.stderr.close()
                    except OSError:
                        cleanup_failed = True
            _parent_child = None
        finally:
            _restore_signal_mask(cleanup_mask)
        if cleanup_failed:
            outcome = fallback
    if _termination_requested:
        return fallback
    return outcome


def main() -> int:
    global _termination_requested
    _termination_requested = False
    initial_mask = _block_termination_signals()
    for signum in _TERMINATION_SIGNALS:
        signal.signal(signum, _parent_signal)
    _restore_signal_mask(initial_mask)
    arguments = sys.argv[1:]
    test_mode = "--test-mode" in arguments
    if arguments and arguments[0] == "--worker":
        test_mode = arguments[1:] == ["--test-mode"]
        if arguments[1:] not in ([], ["--test-mode"]):
            payload, status_code = result_payload(
                ProbeState(), recovered=False, timed_out=False, elapsed=0
            ), 1
        else:
            payload, status_code = _worker_result(test_mode)
    elif arguments in ([], ["--test-mode"]):
        payload, status_code = _run_parent(arguments == ["--test-mode"])
    else:
        payload, status_code = result_payload(
            ProbeState(), recovered=False, timed_out=False, elapsed=0
        ), 1
    commit_mask = _block_termination_signals()
    try:
        _inject_test_signal(test_mode, "before-write")
        pending = signal.sigpending() if hasattr(signal, "sigpending") else set()
        if _termination_requested or pending.intersection(_TERMINATION_SIGNALS):
            payload, status_code = result_payload(
                ProbeState(), recovered=False, timed_out=False, elapsed=0
            ), 1
        for signum in _TERMINATION_SIGNALS:
            signal.signal(signum, signal.SIG_IGN)
        encoded = encode_result(payload)
        if os.write(sys.stdout.fileno(), encoded) != len(encoded):
            return 1
    except OSError:
        return 1
    finally:
        # The process exits immediately after the single aggregate write.  Keeping
        # termination signals blocked closes the final-JSON commit race.
        del commit_mask
    return status_code


if __name__ == "__main__":
    raise SystemExit(main())
