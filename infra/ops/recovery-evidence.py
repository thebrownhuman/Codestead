#!/usr/bin/python3
"""Privileged, fail-closed recovery-evidence collection primitives.

The shell entry point starts this helper through a sealed environment.  This
module keeps byte parsing and append-only publication out of shell strings.
"""

from __future__ import annotations

import base64
import ctypes
import datetime
import errno
import fcntl
import hashlib
import json
import math
import os
from pathlib import Path, PurePosixPath
import re
import secrets
import selectors
import signal
import stat
import subprocess
import sys
import time
from typing import Final, NamedTuple


EVIDENCE_ROOT: Final = PurePosixPath("/var/lib/learncoding/recovery-evidence")
MAXIMUM_RECOVERY_BYTES: Final = 16_384
RECOVERY_HEALTH_FIELDS: Final = (
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
RECOVERY_KEYS: Final = frozenset(
    (*RECOVERY_HEALTH_FIELDS, "elapsedSeconds", "existingContainersExpected",
     "existingContainersRunning", "recovered", "schemaVersion", "timedOut")
)
EVENT_PATTERN: Final = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,80}")
AT_FDCWD: Final = -100
RENAME_NOREPLACE: Final = 1
RECOVERY_TARGET_SECONDS: Final = 900
RECOVERY_CLOCK_SKEW_SECONDS: Final = 5


class ContractError(RuntimeError):
    """A protected input or publication violated the release contract."""


class EvidenceTarget(NamedTuple):
    event_id: str
    phase: str
    root: Path
    json: Path
    checksum: Path
    lock: Path
    pre_json: Path
    pre_checksum: Path


def validate_destination(phase: str, raw: str) -> EvidenceTarget:
    if phase not in {"pre", "post"} or not isinstance(raw, str) or "\x00" in raw:
        raise ContractError("phase or destination is invalid")
    path = PurePosixPath(raw)
    if not path.is_absolute() or str(path) != raw or path.parent != EVIDENCE_ROOT:
        raise ContractError("destination must be one canonical file in the evidence root")
    suffix = f".{phase}.json"
    if not path.name.endswith(suffix):
        raise ContractError("phase and destination filename do not form one event pair")
    event_id = path.name[: -len(suffix)]
    if EVENT_PATTERN.fullmatch(event_id) is None:
        raise ContractError("evidence event identity is malformed")
    root = Path(str(EVIDENCE_ROOT))
    json_path = Path(raw)
    checksum = Path(f"{raw}.sha256")
    return EvidenceTarget(
        event_id=event_id,
        phase=phase,
        root=root,
        json=json_path,
        checksum=checksum,
        lock=root / f".{event_id}.lock",
        pre_json=root / f"{event_id}.pre.json",
        pre_checksum=root / f"{event_id}.pre.json.sha256",
    )


def _canonical_json(raw: bytes) -> dict[str, object]:
    if not raw or len(raw) > MAXIMUM_RECOVERY_BYTES or b"\x00" in raw or not raw.endswith(b"\n"):
        raise ContractError("recovery aggregate is missing, oversized, or non-canonical")
    try:
        text = raw.decode("ascii", "strict")
        value = json.loads(text)
    except (UnicodeError, json.JSONDecodeError) as error:
        raise ContractError("recovery aggregate is malformed") from error
    if not isinstance(value, dict):
        raise ContractError("recovery aggregate must be an object")
    canonical = json.dumps(value, separators=(",", ":"), sort_keys=True) + "\n"
    if canonical != text:
        raise ContractError("recovery aggregate bytes are not canonical")
    return value


def _canonical_nonnegative_integer(value: object, maximum: int) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and 0 <= value <= maximum


def parse_recovery_payload(raw: bytes) -> dict[str, object]:
    value = _canonical_json(raw)
    if frozenset(value) != RECOVERY_KEYS or value.get("schemaVersion") != 1:
        raise ContractError("recovery aggregate schema is invalid")
    if any(type(value.get(field)) is not bool for field in RECOVERY_HEALTH_FIELDS):
        raise ContractError("recovery aggregate health value is invalid")
    if type(value.get("recovered")) is not bool or type(value.get("timedOut")) is not bool:
        raise ContractError("recovery outcome is invalid")
    if not _canonical_nonnegative_integer(value.get("elapsedSeconds"), 900):
        raise ContractError("recovery elapsed time is invalid")
    expected = value.get("existingContainersExpected")
    running = value.get("existingContainersRunning")
    if not _canonical_nonnegative_integer(expected, 32) or not _canonical_nonnegative_integer(running, 32):
        raise ContractError("recovery container counts are invalid")
    healthy = (
        all(value[field] is True for field in RECOVERY_HEALTH_FIELDS)
        and expected > 0
        and running == expected
        and value["timedOut"] is False
    )
    if value["recovered"] is True and not healthy:
        raise ContractError("recovered=true is not supported by every health condition")
    return value


ACTIVE_RELEASE_KEYS: Final = (
    "SCHEMA_VERSION",
    "GIT_COMMIT",
    "GIT_TREE",
    "RELEASE_MANIFEST_SHA256",
    "APPLICATION_IMAGE_RECORD_SHA256",
    "COMPOSE_PROJECT",
    "COMPOSE_WORKDIR",
    "PUBLIC_ORIGIN",
    "MANAGED_INVENTORY_SHA256",
    "FIREWALL_POLICY_SHA256",
    "RUNNER_GUEST_RELEASE_SHA256",
    "RUNNER_RUNTIME_IMAGES_SHA256",
)
PILOT_SERVICES: Final = (
    "app",
    "cloudflared",
    "exam-finalization-worker",
    "mail-worker",
    "postgres",
    "practice-runner-recovery-worker",
    "project-review-correction-worker",
    "regrade-worker",
    "reward-worker",
    "runner-egress-gateway",
)
HEX_SHA256_PATTERN: Final = re.compile(r"[0-9a-f]{64}")
GIT_PATTERN: Final = re.compile(r"[0-9a-f]{40}(?:[0-9a-f]{24})?")
IMAGE_REFERENCE_PATTERN: Final = re.compile(r"[a-z0-9][a-z0-9./_-]{0,255}@sha256:[0-9a-f]{64}")
IMAGE_ID_PATTERN: Final = re.compile(r"sha256:[0-9a-f]{64}")
PUBLIC_ORIGIN_PATTERN: Final = re.compile(
    r"https://[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+"
)


class ActiveRelease(NamedTuple):
    git_commit: str
    git_tree: str
    release_manifest_sha256: str
    application_image_record_sha256: str
    compose_project: str
    compose_workdir: str
    public_origin: str
    managed_inventory_sha256: str
    firewall_policy_sha256: str
    runner_guest_release_sha256: str
    runner_runtime_images_sha256: str


def active_release_identity(active: ActiveRelease) -> dict[str, str]:
    return {
        "applicationImageRecordSha256": active.application_image_record_sha256,
        "composeProject": active.compose_project,
        "composeWorkdir": active.compose_workdir,
        "firewallPolicySha256": active.firewall_policy_sha256,
        "gitCommit": active.git_commit,
        "gitTree": active.git_tree,
        "inventorySha256": active.managed_inventory_sha256,
        "manifestSha256": active.release_manifest_sha256,
        "publicOrigin": active.public_origin,
        "runnerGuestReleaseSha256": active.runner_guest_release_sha256,
        "runnerRuntimeImagesSha256": active.runner_runtime_images_sha256,
    }


class ManagedContainer(NamedTuple):
    service: str
    container: str
    image_reference: str
    image_id: str


def _strict_ascii_lines(raw: bytes, *, maximum: int, description: str) -> list[str]:
    if not raw or len(raw) > maximum or b"\x00" in raw or b"\r" in raw or not raw.endswith(b"\n"):
        raise ContractError(f"{description} is missing, oversized, or non-canonical")
    try:
        text = raw.decode("ascii", "strict")
    except UnicodeError as error:
        raise ContractError(f"{description} is not ASCII") from error
    lines = text[:-1].split("\n")
    if any(not line for line in lines):
        raise ContractError(f"{description} contains an empty line")
    return lines


def parse_active_release(raw: bytes) -> ActiveRelease:
    lines = _strict_ascii_lines(raw, maximum=16_384, description="active release manifest")
    if len(lines) != len(ACTIVE_RELEASE_KEYS):
        raise ContractError("active release manifest field count is invalid")
    values: dict[str, str] = {}
    for expected_key, line in zip(ACTIVE_RELEASE_KEYS, lines, strict=True):
        if "=" not in line:
            raise ContractError("active release manifest line is malformed")
        key, value = line.split("=", 1)
        if key != expected_key or not value or value != value.strip() or key in values:
            raise ContractError("active release manifest order or value is invalid")
        values[key] = value
    if (
        values["SCHEMA_VERSION"] != "1"
        or GIT_PATTERN.fullmatch(values["GIT_COMMIT"]) is None
        or GIT_PATTERN.fullmatch(values["GIT_TREE"]) is None
    ):
        raise ContractError("active release identity is invalid")
    for key in (
        "RELEASE_MANIFEST_SHA256",
        "APPLICATION_IMAGE_RECORD_SHA256",
        "MANAGED_INVENTORY_SHA256",
        "FIREWALL_POLICY_SHA256",
        "RUNNER_GUEST_RELEASE_SHA256",
        "RUNNER_RUNTIME_IMAGES_SHA256",
    ):
        if HEX_SHA256_PATTERN.fullmatch(values[key]) is None:
            raise ContractError("active release digest is invalid")
    if values["COMPOSE_PROJECT"] != "learncoding" or values["COMPOSE_WORKDIR"] != "/opt/learncoding":
        raise ContractError("active Compose identity is invalid")
    if PUBLIC_ORIGIN_PATTERN.fullmatch(values["PUBLIC_ORIGIN"]) is None:
        raise ContractError("active public origin is invalid")
    return ActiveRelease(
        git_commit=values["GIT_COMMIT"],
        git_tree=values["GIT_TREE"],
        release_manifest_sha256=values["RELEASE_MANIFEST_SHA256"],
        application_image_record_sha256=values["APPLICATION_IMAGE_RECORD_SHA256"],
        compose_project=values["COMPOSE_PROJECT"],
        compose_workdir=values["COMPOSE_WORKDIR"],
        public_origin=values["PUBLIC_ORIGIN"],
        managed_inventory_sha256=values["MANAGED_INVENTORY_SHA256"],
        firewall_policy_sha256=values["FIREWALL_POLICY_SHA256"],
        runner_guest_release_sha256=values["RUNNER_GUEST_RELEASE_SHA256"],
        runner_runtime_images_sha256=values["RUNNER_RUNTIME_IMAGES_SHA256"],
    )


def parse_managed_inventory(raw: bytes, expected_sha256: str) -> tuple[ManagedContainer, ...]:
    if HEX_SHA256_PATTERN.fullmatch(expected_sha256) is None or not hashlib.sha256(raw).hexdigest() == expected_sha256:
        raise ContractError("managed inventory digest does not match the active release")
    lines = _strict_ascii_lines(raw, maximum=65_536, description="managed inventory")
    if len(lines) != len(PILOT_SERVICES):
        raise ContractError("managed inventory count is invalid")
    records: list[ManagedContainer] = []
    for expected_service, line in zip(PILOT_SERVICES, lines, strict=True):
        fields = line.split("\t")
        if len(fields) != 4:
            raise ContractError("managed inventory row is malformed")
        service, container, image_reference, image_id = fields
        if (
            service != expected_service
            or container != f"learncoding-{service}-1"
            or IMAGE_REFERENCE_PATTERN.fullmatch(image_reference) is None
            or IMAGE_ID_PATTERN.fullmatch(image_id) is None
        ):
            raise ContractError("managed inventory identity is invalid")
        records.append(ManagedContainer(service, container, image_reference, image_id))
    return tuple(records)


def validate_container_inspection(
    raw: bytes,
    record: ManagedContainer,
    compose_project: str,
    compose_workdir: str,
) -> dict[str, object]:
    if not raw or len(raw) > 262_144 or b"\x00" in raw:
        raise ContractError("container inspection is missing or oversized")
    try:
        value = json.loads(raw.decode("utf-8", "strict"))
    except (UnicodeError, json.JSONDecodeError) as error:
        raise ContractError("container inspection is malformed") from error
    if not isinstance(value, list) or len(value) != 1 or not isinstance(value[0], dict):
        raise ContractError("container inspection cardinality is invalid")
    item = value[0]
    state = item.get("State")
    configuration = item.get("Config")
    if not isinstance(state, dict) or not isinstance(configuration, dict):
        raise ContractError("container state or configuration is missing")
    labels = configuration.get("Labels")
    health = state.get("Health")
    if not isinstance(labels, dict) or not isinstance(health, dict):
        raise ContractError("container labels or health are missing")
    expected_labels = {
        "com.centurylinklabs.watchtower.enable": "false",
        "com.docker.compose.project": compose_project,
        "com.docker.compose.project.working_dir": compose_workdir,
        "com.docker.compose.service": record.service,
    }
    if any(labels.get(key) != expected for key, expected in expected_labels.items()):
        raise ContractError("container Compose or update identity drifted")
    restart_count = item.get("RestartCount")
    if (
        item.get("Name") != f"/{record.container}"
        or item.get("Image") != record.image_id
        or configuration.get("Image") != record.image_reference
        or state.get("Running") is not True
        or state.get("Status") != "running"
        or health.get("Status") != "healthy"
        or not _canonical_nonnegative_integer(restart_count, 1_000_000)
    ):
        raise ContractError("container runtime identity or health drifted")
    return {
        "container": record.container,
        "healthy": True,
        "imageId": record.image_id,
        "imageReference": record.image_reference,
        "restartCount": restart_count,
        "service": record.service,
    }


def _match(left: object, right: object, *, operation: str = "==") -> dict[str, object]:
    return {"match": {"left": left, "op": operation, "right": right}}


def _payload(protocol: str, field: str) -> dict[str, object]:
    return {"payload": {"field": field, "protocol": protocol}}


def _meta(key: str) -> dict[str, object]:
    return {"meta": {"key": key}}


def validate_firewall_rules(raw: bytes) -> dict[str, object]:
    if not raw or len(raw) > 262_144 or b"\x00" in raw:
        raise ContractError("active firewall rules are missing or oversized")
    try:
        value = json.loads(raw.decode("utf-8", "strict"))
    except (UnicodeError, json.JSONDecodeError) as error:
        raise ContractError("active firewall rules are malformed") from error
    entries = value.get("nftables") if isinstance(value, dict) else None
    if not isinstance(entries, list):
        raise ContractError("active firewall envelope is invalid")
    objects = [entry for entry in entries if isinstance(entry, dict) and "metainfo" not in entry]
    tables = [entry["table"] for entry in objects if set(entry) == {"table"} and isinstance(entry["table"], dict)]
    chains = [entry["chain"] for entry in objects if set(entry) == {"chain"} and isinstance(entry["chain"], dict)]
    rules = [entry["rule"] for entry in objects if set(entry) == {"rule"} and isinstance(entry["rule"], dict)]
    if len(tables) != 1 or len(chains) != 1 or len(rules) != 5 or len(objects) != 7:
        raise ContractError("active firewall object inventory drifted")
    table = {key: value for key, value in tables[0].items() if key != "handle"}
    chain = {key: value for key, value in chains[0].items() if key != "handle"}
    if table != {"family": "inet", "name": "codestead_runner"}:
        raise ContractError("active firewall table identity drifted")
    if chain != {
        "family": "inet",
        "hook": "forward",
        "name": "forward",
        "policy": "accept",
        "prio": 10,
        "table": "codestead_runner",
        "type": "filter",
    }:
        raise ContractError("active firewall chain identity drifted")
    expected_expressions = [
        [
            _match(_meta("iifname"), "cdst-run0"),
            _match(_payload("ip", "saddr"), "172.29.40.2"),
            _match(_payload("ip", "daddr"), "192.168.122.12"),
            _match(_payload("tcp", "dport"), 4100),
            {"accept": None},
        ],
        [
            _match(_meta("iifname"), "cdst-run0"),
            {"drop": None},
        ],
        [
            _match(_payload("ip", "daddr"), "192.168.122.12"),
            _match(_payload("tcp", "dport"), 4100),
            {"drop": None},
        ],
        [
            _match(_meta("oifname"), "virbr0"),
            _match(_meta("l4proto"), "tcp"),
            _match(_payload("tcp", "dport"), 4100),
            {"drop": None},
        ],
        [
            _match({"ct": {"key": "state"}}, ["established", "related"], operation="in"),
            {"accept": None},
        ],
    ]
    for rule, expected in zip(rules, expected_expressions, strict=True):
        identity = {key: value for key, value in rule.items() if key != "handle" and key != "expr"}
        if identity != {"chain": "forward", "family": "inet", "table": "codestead_runner"} or rule.get("expr") != expected:
            raise ContractError("active firewall rule identity or ordering drifted")
    canonical = json.dumps(expected_expressions, separators=(",", ":"), sort_keys=True).encode("ascii")
    return {"policySha256": hashlib.sha256(canonical).hexdigest(), "ruleCount": 5}


def validate_pre_pair(
    target: EvidenceTarget,
    pre_json: bytes,
    pre_checksum: bytes,
    active_release: ActiveRelease,
    current_boot_id: str,
) -> tuple[str, dict[str, object]]:
    if target.phase != "post" or not isinstance(active_release, ActiveRelease):
        raise ContractError("post evidence pair input is invalid")
    if not pre_json or len(pre_json) > 1_048_576 or b"\x00" in pre_json or not pre_json.endswith(b"\n"):
        raise ContractError("pre evidence bytes are invalid")
    digest = hashlib.sha256(pre_json).hexdigest()
    expected_checksum = f"{digest}  {target.pre_json.name}\n".encode("ascii")
    if pre_checksum != expected_checksum:
        raise ContractError("pre evidence checksum does not bind the exact bytes")
    try:
        text = pre_json.decode("ascii", "strict")
        value = json.loads(text)
    except (UnicodeError, json.JSONDecodeError) as error:
        raise ContractError("pre evidence JSON is malformed") from error
    if json.dumps(value, separators=(",", ":"), sort_keys=True) + "\n" != text:
        raise ContractError("pre evidence JSON bytes are not canonical")
    release = value.get("release") if isinstance(value, dict) else None
    pre_backup = validate_backup_value(value.get("backup")) if isinstance(value, dict) else None
    pre_captured = value.get("capturedAtUtc") if isinstance(value, dict) else None
    if (
        value.get("schemaVersion") != 2
        or value.get("phase") != "pre"
        or value.get("eventId") != target.event_id
        or release != active_release_identity(active_release)
        or not isinstance(pre_captured, str)
        or value.get("bootId") == current_boot_id
        or re.fullmatch(r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}", str(value.get("bootId"))) is None
    ):
        raise ContractError("pre evidence does not bind this post event, release, and prior boot")
    validate_backup_freshness(pre_backup, pre_captured)
    return digest, pre_backup

RUNTIME_STATE_ROOT: Final = Path("/etc/learncoding")
ACTIVE_RELEASE_PATH: Final = RUNTIME_STATE_ROOT / "active-release.env"
RELEASE_MANIFEST_PATH: Final = Path("/opt/learncoding/RELEASE.SHA256SUMS")
FIREWALL_POLICY_PATH: Final = Path("/opt/learncoding/infra/runner-vm/host-runner.nft")


def managed_inventory_path(active: ActiveRelease) -> Path:
    if not isinstance(active, ActiveRelease) or HEX_SHA256_PATTERN.fullmatch(active.managed_inventory_sha256) is None:
        raise ContractError("managed inventory identity is invalid")
    return RUNTIME_STATE_ROOT / f"managed-containers.{active.managed_inventory_sha256}.tsv"


def application_image_record_path(active: ActiveRelease) -> Path:
    if (
        not isinstance(active, ActiveRelease)
        or HEX_SHA256_PATTERN.fullmatch(active.application_image_record_sha256) is None
    ):
        raise ContractError("application image record identity is invalid")
    return RUNTIME_STATE_ROOT / f"application-images.{active.application_image_record_sha256}.json"
BOOT_ID_PATH: Final = Path("/proc/sys/kernel/random/boot_id")
UPTIME_PATH: Final = Path("/proc/uptime")
BACKUP_MARKER_PATH: Final = Path("/mnt/learncoding-backups/state/local-last-success.env")
BACKUP_FULL_ROOT: Final = Path("/mnt/learncoding-backups/full")
BACKUP_FRESHNESS_SECONDS: Final = 6 * 60 * 60
BACKUP_FUTURE_SKEW_SECONDS: Final = 5 * 60
RECOVERY_COMMAND: Final = ("/opt/learncoding/infra/ops/check-recovery.sh",)
SMOKE_COMMAND: Final = ("/opt/learncoding/infra/ops/smoke-production.sh", "--phase", "full")
HOST_FIREWALL_COMMAND: Final = ("/usr/sbin/nft", "--json", "list", "table", "inet", "codestead_runner")
APPLICATION_MOUNT_COMMAND: Final = (
    "/usr/bin/findmnt", "--json", "--output", "TARGET,SOURCE,FSTYPE,OPTIONS", "--target", "/srv/learncoding",
)
BACKUP_MOUNT_COMMAND: Final = (
    "/usr/bin/findmnt", "--json", "--output", "TARGET,SOURCE,FSTYPE,OPTIONS", "--target", "/mnt/learncoding-backups",
)
FAILED_UNITS_COMMAND: Final = ("/usr/bin/systemctl", "--failed", "--no-legend", "--plain")
RUNNER_ADDRESS_COMMAND: Final = (
    "/usr/bin/virsh", "domifaddr", "codestead-runner", "--source", "agent", "--full",
)
GUEST_RELEASE_IDENTITY_COMMAND: Final = (
    "/usr/bin/sha256sum", "/opt/learncoding/RELEASE.SHA256SUMS",
)
GUEST_RUNTIME_IDENTITY_COMMAND: Final = (
    "/usr/bin/sha256sum", "/opt/learncoding/services/runner/dist/runtime-images.env",
)
GUEST_FIREWALL_COMMAND: Final = (
    "/usr/sbin/nft", "--json", "list", "table", "inet", "codestead_runner_guest",
)
REQUIRED_TIMERS: Final = (
    "learncoding-backup.timer",
    "learncoding-backup-check.timer",
    "learncoding-offsite-sync.timer",
    "learncoding-offsite-retention.timer",
    "learncoding-retention.timer",
    "learncoding-recovery-check.timer",
)
RUNNER_MAC: Final = "52:54:00:20:00:12"
RUNNER_ADDRESS: Final = "192.168.122.12/24"
SEALED_COMMAND_ENVIRONMENT: Final = {
    "HOME": "/nonexistent",
    "LANG": "C",
    "LC_ALL": "C",
    "PATH": "/usr/sbin:/usr/bin:/sbin:/bin",
    "PYTHONHASHSEED": "0",
}
HOST_EXECUTABLES: Final = frozenset(
    {
        "/opt/learncoding/infra/ops/check-recovery.sh",
        "/opt/learncoding/infra/ops/smoke-production.sh",
        "/usr/bin/docker",
        "/usr/bin/findmnt",
        "/usr/bin/lsblk",
        "/usr/bin/systemctl",
        "/usr/bin/virsh",
        "/usr/sbin/nft",
        "/usr/sbin/smartctl",
    }
)
GUEST_EXECUTABLES: Final = frozenset({"/usr/bin/sha256sum", "/usr/bin/systemctl", "/usr/sbin/nft"})


def container_inspect_command(container: str) -> tuple[str, ...]:
    if re.fullmatch(r"learncoding-[a-z0-9-]{1,80}-1", container) is None:
        raise ContractError("managed container name is invalid")
    return ("/usr/bin/docker", "inspect", "--type", "container", container)


def systemctl_command(operation: str, unit: str) -> tuple[str, ...]:
    if operation not in {"is-active", "is-enabled"} or re.fullmatch(r"learncoding-[a-z0-9-]+\.(?:service|timer)", unit) is None:
        raise ContractError("systemd evidence request is invalid")
    return ("/usr/bin/systemctl", operation, unit)


def _kill_process(process: subprocess.Popen[bytes]) -> None:
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    process.wait()


def run_bounded(command: tuple[str, ...], timeout_seconds: int, maximum_bytes: int) -> bytes:
    if (
        not command
        or command[0] not in HOST_EXECUTABLES
        or not all(isinstance(part, str) and part and "\x00" not in part for part in command)
        or not isinstance(timeout_seconds, int)
        or not 1 <= timeout_seconds <= 900
        or not isinstance(maximum_bytes, int)
        or not 1 <= maximum_bytes <= 1_048_576
    ):
        raise ContractError("bounded command contract is invalid")
    try:
        process = subprocess.Popen(
            command,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            cwd="/",
            env=SEALED_COMMAND_ENVIRONMENT,
            close_fds=True,
            start_new_session=True,
        )
    except OSError as error:
        raise ContractError("a required evidence command could not start") from error
    if process.stdout is None or process.stderr is None:
        _kill_process(process)
        raise ContractError("a required evidence command has no bounded pipes")
    selector = selectors.DefaultSelector()
    selector.register(process.stdout, selectors.EVENT_READ, "stdout")
    selector.register(process.stderr, selectors.EVENT_READ, "stderr")
    output = bytearray()
    observed = 0
    deadline = time.monotonic() + timeout_seconds
    try:
        while selector.get_map():
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                _kill_process(process)
                raise ContractError("an evidence command exceeded its deadline")
            events = selector.select(min(remaining, 0.25))
            if not events and process.poll() is not None:
                events = [(key, selectors.EVENT_READ) for key in selector.get_map().values()]
            for key, _ in events:
                chunk = os.read(key.fd, 65_536)
                if not chunk:
                    selector.unregister(key.fileobj)
                    continue
                observed += len(chunk)
                if observed > maximum_bytes:
                    _kill_process(process)
                    raise ContractError("an evidence command exceeded its output cap")
                if key.data == "stdout":
                    output.extend(chunk)
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            _kill_process(process)
            raise ContractError("an evidence command exceeded its deadline")
        status = process.wait(timeout=remaining)
    except subprocess.TimeoutExpired as error:
        _kill_process(process)
        raise ContractError("an evidence command exceeded its deadline") from error
    finally:
        selector.close()
    if status != 0:
        raise ContractError("a required evidence command failed")
    return bytes(output)


def read_protected(path: Path, maximum_bytes: int) -> bytes:
    if not path.is_absolute() or not 1 <= maximum_bytes <= 1_048_576:
        raise ContractError("protected read contract is invalid")
    try:
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
        before = os.fstat(descriptor)
        if (
            not stat.S_ISREG(before.st_mode)
            or before.st_uid != 0
            or before.st_gid != 0
            or before.st_nlink != 1
            or before.st_mode & 0o022
            or before.st_size > maximum_bytes
        ):
            raise ContractError("a protected evidence input is unsafe")
        chunks: list[bytes] = []
        observed = 0
        while True:
            chunk = os.read(descriptor, min(65_536, maximum_bytes + 1 - observed))
            if not chunk:
                break
            chunks.append(chunk)
            observed += len(chunk)
            if observed > maximum_bytes:
                raise ContractError("a protected evidence input exceeds its cap")
        after = os.fstat(descriptor)
    except OSError as error:
        raise ContractError("a protected evidence input could not be read") from error
    finally:
        if "descriptor" in locals():
            os.close(descriptor)
    identity = lambda value: (
        value.st_dev, value.st_ino, value.st_mode, value.st_uid, value.st_gid,
        value.st_nlink, value.st_size, value.st_mtime_ns, value.st_ctime_ns,
    )
    if identity(before) != identity(after):
        raise ContractError("a protected evidence input changed while read")
    return b"".join(chunks)


def hash_protected_sha256(path: Path) -> str:
    if not path.is_absolute():
        raise ContractError("protected archive path is invalid")
    try:
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
        before = os.fstat(descriptor)
        if (
            not stat.S_ISREG(before.st_mode)
            or before.st_uid != 0
            or before.st_gid != 0
            or before.st_nlink != 1
            or before.st_mode & 0o7777 != 0o600
            or not 1 <= before.st_size <= 1_099_511_627_776
        ):
            raise ContractError("protected archive metadata is unsafe")
        digest = hashlib.sha256()
        while True:
            chunk = os.read(descriptor, 1_048_576)
            if not chunk:
                break
            digest.update(chunk)
        after = os.fstat(descriptor)
    except OSError as error:
        raise ContractError("protected archive could not be hashed") from error
    finally:
        if "descriptor" in locals():
            os.close(descriptor)
    identity = lambda value: (
        value.st_dev, value.st_ino, value.st_mode, value.st_uid, value.st_gid,
        value.st_nlink, value.st_size, value.st_mtime_ns, value.st_ctime_ns,
    )
    if identity(before) != identity(after):
        raise ContractError("protected archive changed while hashed")
    return digest.hexdigest()


def parse_uptime(raw: bytes) -> int:
    match = re.fullmatch(rb"([0-9]{1,9})\.[0-9]{2} [0-9]{1,9}\.[0-9]{2}\n", raw)
    if match is None:
        raise ContractError("host uptime is malformed")
    uptime = int(match.group(1))
    if uptime > 315_576_000:
        raise ContractError("host uptime is outside the evidence bound")
    return uptime


def parse_backup_marker(raw: bytes) -> dict[str, object]:
    lines = _strict_ascii_lines(raw, maximum=512, description="local backup marker")
    if len(lines) != 3:
        raise ContractError("local backup marker field count is invalid")
    expected = ("SUCCESS_ARCHIVE=", "SUCCESS_COMPLETED_UTC=", "SUCCESS_SHA256=")
    if any(not line.startswith(prefix) for line, prefix in zip(lines, expected, strict=True)):
        raise ContractError("local backup marker order is invalid")
    archive = lines[0][len(expected[0]):]
    completed = lines[1][len(expected[1]):]
    digest = lines[2][len(expected[2]):]
    if re.fullmatch(r"learncoding-full-[0-9]{8}T[0-9]{6}Z\.tar\.gz\.age", archive) is None:
        raise ContractError("local backup archive identity is invalid")
    try:
        parsed = datetime.datetime.strptime(completed, "%Y%m%dT%H%M%SZ")
    except ValueError as error:
        raise ContractError("local backup completion time is invalid") from error
    if parsed.strftime("%Y%m%dT%H%M%SZ") != completed or HEX_SHA256_PATTERN.fullmatch(digest) is None:
        raise ContractError("local backup marker value is invalid")
    return {"archive": archive, "completedAtUtc": completed, "sha256": digest}


def validate_backup_value(value: object) -> dict[str, object]:
    if not isinstance(value, dict) or set(value) != {"archive", "completedAtUtc", "sha256"}:
        raise ContractError("backup evidence shape is invalid")
    archive = value.get("archive")
    completed = value.get("completedAtUtc")
    digest = value.get("sha256")
    if (
        not isinstance(archive, str)
        or re.fullmatch(r"learncoding-full-[0-9]{8}T[0-9]{6}Z\.tar\.gz\.age", archive) is None
        or not isinstance(completed, str)
        or not isinstance(digest, str)
        or HEX_SHA256_PATTERN.fullmatch(digest) is None
    ):
        raise ContractError("backup evidence value is invalid")
    _parse_compact_utc(completed, "backup completion")
    _backup_snapshot_time(archive)
    return {"archive": archive, "completedAtUtc": completed, "sha256": digest}


def _parse_compact_utc(value: str, description: str) -> datetime.datetime:
    try:
        parsed = datetime.datetime.strptime(value, "%Y%m%dT%H%M%SZ").replace(
            tzinfo=datetime.timezone.utc
        )
    except (TypeError, ValueError) as error:
        raise ContractError(f"{description} time is invalid") from error
    if parsed.strftime("%Y%m%dT%H%M%SZ") != value:
        raise ContractError(f"{description} time is not canonical")
    return parsed


def _parse_captured_utc(value: str) -> datetime.datetime:
    try:
        parsed = datetime.datetime.strptime(value, "%Y-%m-%dT%H:%M:%SZ").replace(
            tzinfo=datetime.timezone.utc
        )
    except (TypeError, ValueError) as error:
        raise ContractError("capture time is invalid") from error
    if parsed.strftime("%Y-%m-%dT%H:%M:%SZ") != value:
        raise ContractError("capture time is not canonical UTC")
    return parsed


def validate_post_recovery_timing(
    power_restored_at_utc: object,
    public_ready_at_utc: object,
    *,
    captured_at_utc: str,
    uptime_at_capture_seconds: int,
) -> dict[str, object]:
    """Validate operator observations without claiming to verify a physical cut."""
    if not isinstance(power_restored_at_utc, str) or not isinstance(public_ready_at_utc, str):
        raise ContractError("post evidence requires both operator-observed UTC timestamps")
    if not _canonical_nonnegative_integer(uptime_at_capture_seconds, 315_576_900):
        raise ContractError("post evidence uptime is invalid")
    captured = _parse_captured_utc(captured_at_utc)
    restored = _parse_captured_utc(power_restored_at_utc)
    ready = _parse_captured_utc(public_ready_at_utc)
    if restored > captured or ready > captured:
        raise ContractError("operator-observed recovery time is future-dated")
    readiness_seconds = int((ready - restored).total_seconds())
    if readiness_seconds < 0:
        raise ContractError("public readiness precedes power restoration")
    if readiness_seconds > RECOVERY_TARGET_SECONDS:
        raise ContractError("public readiness exceeded the recovery target")
    kernel_started = captured - datetime.timedelta(seconds=uptime_at_capture_seconds)
    if (restored - kernel_started).total_seconds() > RECOVERY_CLOCK_SKEW_SECONDS:
        raise ContractError("power restoration follows kernel start; observation or clock is inconsistent")
    if (kernel_started - ready).total_seconds() > RECOVERY_CLOCK_SKEW_SECONDS:
        raise ContractError("public readiness precedes kernel start; observation or clock is inconsistent")
    return {
        "collectorVerifiedPhysicalPowerCycle": False,
        "operatorObservedPowerRestoredAtUtc": power_restored_at_utc,
        "operatorObservedPublicReadyAtUtc": public_ready_at_utc,
        "publicReadinessSecondsFromPowerRestoration": readiness_seconds,
        "targetSeconds": RECOVERY_TARGET_SECONDS,
    }


def _backup_snapshot_time(archive: str) -> datetime.datetime:
    value = archive[len("learncoding-full-"):-len(".tar.gz.age")]
    return _parse_compact_utc(value, "backup snapshot")


def validate_backup_freshness(backup: dict[str, object], captured_at: str) -> None:
    backup = validate_backup_value(backup)
    archive = backup["archive"]
    completed = backup["completedAtUtc"]
    if not isinstance(archive, str) or not isinstance(completed, str):
        raise ContractError("backup evidence identity is invalid")
    snapshot_time = _backup_snapshot_time(archive)
    completed_time = _parse_compact_utc(completed, "backup completion")
    capture_time = _parse_captured_utc(captured_at)
    if completed_time < snapshot_time:
        raise ContractError("backup completion precedes its snapshot")
    for observed in (snapshot_time, completed_time):
        delta = (capture_time - observed).total_seconds()
        if delta < -BACKUP_FUTURE_SKEW_SECONDS or delta > BACKUP_FRESHNESS_SECONDS:
            raise ContractError("backup evidence is stale or future-dated")


def observe_backup_recovery_point(read_file, hash_file) -> tuple[dict[str, object], bytes]:
    marker_raw = read_file(BACKUP_MARKER_PATH, 512)
    backup = parse_backup_marker(marker_raw)
    archive = backup["archive"]
    digest = backup["sha256"]
    if not isinstance(archive, str) or not isinstance(digest, str):
        raise ContractError("backup marker identity is invalid")
    archive_path = BACKUP_FULL_ROOT / archive
    sidecar_path = Path(f"{archive_path}.sha256")
    sidecar = read_file(sidecar_path, 256)
    if sidecar != f"{digest}  {archive}\n".encode("ascii"):
        raise ContractError("backup checksum sidecar does not bind the marker")
    if hash_file(archive_path) != digest:
        raise ContractError("backup archive digest does not bind the marker")
    return backup, marker_raw


def require_backup_advancement(pre: dict[str, object], post: dict[str, object]) -> None:
    pre = validate_backup_value(pre)
    post = validate_backup_value(post)
    pre_archive = pre["archive"]
    post_archive = post["archive"]
    pre_completed = pre["completedAtUtc"]
    post_completed = post["completedAtUtc"]
    if not all(isinstance(value, str) for value in (pre_archive, post_archive, pre_completed, post_completed)):
        raise ContractError("backup advancement identity is invalid")
    if (
        _backup_snapshot_time(post_archive) <= _backup_snapshot_time(pre_archive)
        or _parse_compact_utc(post_completed, "post backup completion")
        <= _parse_compact_utc(pre_completed, "pre backup completion")
    ):
        raise ContractError("post recovery evidence did not prove a newer backup")


def _bounded_json_object(raw: bytes, description: str, maximum: int = 262_144) -> dict[str, object]:
    if not raw or len(raw) > maximum or b"\x00" in raw:
        raise ContractError(f"{description} is missing or oversized")
    try:
        value = json.loads(raw.decode("utf-8", "strict"))
    except (UnicodeError, json.JSONDecodeError) as error:
        raise ContractError(f"{description} is malformed") from error
    if not isinstance(value, dict):
        raise ContractError(f"{description} must be an object")
    return value


def _valid_device_path(value: object) -> bool:
    if not isinstance(value, str) or re.fullmatch(r"/dev/[A-Za-z0-9._+/-]{1,127}", value) is None:
        return False
    path = PurePosixPath(value)
    return str(path) == value and ".." not in path.parts and "." not in path.parts


def parse_mount(raw: bytes, observed_target: str, *, hardened: bool) -> dict[str, object]:
    if observed_target not in {"/srv/learncoding", "/mnt/learncoding-backups"}:
        raise ContractError("mount observation target is invalid")
    value = _bounded_json_object(raw, "mount evidence")
    if set(value) != {"filesystems"} or not isinstance(value["filesystems"], list) or len(value["filesystems"]) != 1:
        raise ContractError("mount evidence cardinality is invalid")
    filesystem = value["filesystems"][0]
    required = {"fstype", "options", "source", "target"}
    if not isinstance(filesystem, dict) or set(filesystem) != required:
        raise ContractError("mount evidence fields are invalid")
    target = filesystem["target"]
    source = filesystem["source"]
    fstype = filesystem["fstype"]
    options = filesystem["options"]
    if (
        not isinstance(target, str)
        or not target.startswith("/")
        or str(PurePosixPath(target)) != target
        or not _valid_device_path(source)
        or not isinstance(fstype, str)
        or re.fullmatch(r"[A-Za-z0-9._+-]{1,32}", fstype) is None
        or not isinstance(options, str)
        or len(options) > 1024
    ):
        raise ContractError("mount evidence value is invalid")
    option_values = options.split(",")
    if not option_values or any(re.fullmatch(r"[A-Za-z0-9._=:+-]{1,128}", item) is None for item in option_values):
        raise ContractError("mount options are malformed")
    target_contains_observation = target == "/" or observed_target == target or observed_target.startswith(f"{target.rstrip('/')}/")
    if not target_contains_observation:
        raise ContractError("mount target does not contain the observed path")
    if hardened and (target != observed_target or not {"rw", "nodev", "nosuid", "noexec"}.issubset(option_values)):
        raise ContractError("backup mount hardening drifted")
    return {
        "fstype": fstype,
        "observedFor": observed_target,
        "options": options,
        "source": source,
        "target": target,
    }


def lsblk_command(source: str) -> tuple[str, ...]:
    if not _valid_device_path(source):
        raise ContractError("block-device source is invalid")
    return ("/usr/bin/lsblk", "--json", "--paths", "--output", "NAME,TYPE,PKNAME", "--inverse", source)


PHYSICAL_DEVICE_PATTERN: Final = re.compile(
    r"/dev/(?:nvme[0-9]+n[0-9]+|sd[a-z]+|vd[a-z]+|xvd[a-z]+|mmcblk[0-9]+)"
)


def parse_lsblk_device(raw: bytes, source: str) -> str:
    if not _valid_device_path(source):
        raise ContractError("block-device source is invalid")
    value = _bounded_json_object(raw, "block topology")
    roots = value.get("blockdevices")
    if set(value) != {"blockdevices"} or not isinstance(roots, list) or not roots:
        raise ContractError("block topology envelope is invalid")
    observed_source = False
    disks: list[str] = []

    def visit(node: object) -> None:
        nonlocal observed_source
        if not isinstance(node, dict) or not {"name", "type", "pkname"}.issubset(node) or not set(node).issubset({"name", "type", "pkname", "children"}):
            raise ContractError("block topology node is invalid")
        name = node["name"]
        kind = node["type"]
        parent = node["pkname"]
        if not _valid_device_path(name) or not isinstance(kind, str) or parent is not None and not _valid_device_path(parent):
            raise ContractError("block topology identity is invalid")
        if name == source:
            observed_source = True
        if kind == "disk":
            if PHYSICAL_DEVICE_PATTERN.fullmatch(name) is None:
                raise ContractError("physical SMART device is unsupported")
            disks.append(name)
        children = node.get("children", [])
        if not isinstance(children, list):
            raise ContractError("block topology children are invalid")
        for child in children:
            visit(child)

    for root in roots:
        visit(root)
    if not observed_source or len(set(disks)) != 1:
        raise ContractError("block topology does not bind one physical device")
    return disks[0]


def smartctl_command(device: str) -> tuple[str, ...]:
    if PHYSICAL_DEVICE_PATTERN.fullmatch(device) is None:
        raise ContractError("physical SMART device is unsupported")
    return ("/usr/sbin/smartctl", "--json=c", "--health", "--attributes", device)


def parse_smart_summary(raw: bytes, expected_device: str) -> dict[str, object]:
    if PHYSICAL_DEVICE_PATTERN.fullmatch(expected_device) is None:
        raise ContractError("physical SMART device is unsupported")
    value = _bounded_json_object(raw, "SMART evidence")
    device = value.get("device")
    status = value.get("smart_status")
    if not isinstance(device, dict) or device.get("name") != expected_device or not isinstance(status, dict) or status.get("passed") is not True:
        raise ContractError("SMART device identity or health failed")
    nvme = value.get("nvme_smart_health_information_log")
    if isinstance(nvme, dict):
        critical = nvme.get("critical_warning")
        media = nvme.get("media_errors")
        device_class = "nvme"
    else:
        attributes = value.get("ata_smart_attributes")
        table = attributes.get("table") if isinstance(attributes, dict) else None
        if not isinstance(table, list):
            raise ContractError("SMART error counters are missing")
        counters: dict[int, int] = {}
        for item in table:
            if not isinstance(item, dict) or not isinstance(item.get("id"), int):
                raise ContractError("SMART attribute is malformed")
            identifier = item["id"]
            if identifier not in {5, 187, 197, 198}:
                continue
            raw_value = item.get("raw")
            counter = raw_value.get("value") if isinstance(raw_value, dict) else None
            if not isinstance(counter, int) or isinstance(counter, bool) or counter < 0 or counter > 1_000_000_000 or identifier in counters:
                raise ContractError("SMART attribute counter is invalid")
            counters[identifier] = counter
        if not counters:
            raise ContractError("SMART media-error attributes are missing")
        critical = 0
        media = sum(counters.values())
        device_class = "ata"
    if (
        not isinstance(critical, int)
        or isinstance(critical, bool)
        or not 0 <= critical <= 255
        or not isinstance(media, int)
        or isinstance(media, bool)
        or not 0 <= media <= 1_000_000_000
        or critical != 0
        or media != 0
    ):
        raise ContractError("SMART reports a storage health error")
    return {"criticalWarnings": critical, "deviceClass": device_class, "healthy": True, "mediaErrors": media}


def _parse_exact_state(raw: bytes, expected: bytes, description: str) -> None:
    if raw != expected:
        raise ContractError(f"{description} is not exact")


def _parse_digest_output(raw: bytes, expected_path: str) -> str:
    if len(raw) != 64 + 2 + len(expected_path) + 1 or not raw.endswith(b"\n"):
        raise ContractError("guest digest output is malformed")
    try:
        digest, path = raw[:-1].decode("ascii", "strict").split("  ", 1)
    except (UnicodeError, ValueError) as error:
        raise ContractError("guest digest output is malformed") from error
    if HEX_SHA256_PATTERN.fullmatch(digest) is None or path != expected_path:
        raise ContractError("guest digest identity is invalid")
    return digest


def _parse_runner_address(raw: bytes) -> str:
    if not raw or len(raw) > 65_536 or b"\x00" in raw:
        raise ContractError("runner address evidence is missing or oversized")
    try:
        text = raw.decode("ascii", "strict")
    except UnicodeError as error:
        raise ContractError("runner address evidence is malformed") from error
    records = re.findall(
        r"(?m)^\s*\S+\s+([0-9a-f:]{17})\s+ipv4\s+([0-9.]+/[0-9]+)\s*$",
        text,
    )
    if records != [(RUNNER_MAC, RUNNER_ADDRESS)]:
        raise ContractError("runner stable address identity drifted")
    return RUNNER_ADDRESS


def validate_guest_firewall_rules(raw: bytes) -> dict[str, object]:
    if not raw or len(raw) > 262_144 or b"\x00" in raw:
        raise ContractError("guest firewall evidence is missing or oversized")
    try:
        value = json.loads(raw.decode("utf-8", "strict"))
    except (UnicodeError, json.JSONDecodeError) as error:
        raise ContractError("guest firewall evidence is malformed") from error
    entries = value.get("nftables") if isinstance(value, dict) else None
    if not isinstance(entries, list):
        raise ContractError("guest firewall envelope is invalid")
    objects = [entry for entry in entries if isinstance(entry, dict) and "metainfo" not in entry]
    tables = [entry["table"] for entry in objects if set(entry) == {"table"} and isinstance(entry["table"], dict)]
    chains = [entry["chain"] for entry in objects if set(entry) == {"chain"} and isinstance(entry["chain"], dict)]
    rules = [entry["rule"] for entry in objects if set(entry) == {"rule"} and isinstance(entry["rule"], dict)]
    if len(tables) != 1 or len(chains) != 2 or len(rules) != 6 or len(objects) != 9:
        raise ContractError("guest firewall object inventory drifted")
    table = {key: item for key, item in tables[0].items() if key != "handle"}
    normalized_chains = [
        {key: item for key, item in chain.items() if key != "handle"}
        for chain in chains
    ]
    if table != {"family": "inet", "name": "codestead_runner_guest"} or normalized_chains != [
        {"family": "inet", "hook": "input", "name": "input", "policy": "drop", "prio": 0,
         "table": "codestead_runner_guest", "type": "filter"},
        {"family": "inet", "hook": "output", "name": "output", "policy": "accept", "prio": 0,
         "table": "codestead_runner_guest", "type": "filter"},
    ]:
        raise ContractError("guest firewall table or chain identity drifted")
    expected = [
        [_match({"ct": {"key": "state"}}, "invalid", operation="in"), {"drop": None}],
        [_match(_meta("iifname"), "lo"), {"accept": None}],
        [_match({"ct": {"key": "state"}}, ["established", "related"], operation="in"), {"accept": None}],
        [_match(_payload("ip", "saddr"), "192.168.122.1"), _match(_payload("tcp", "dport"), 22), {"accept": None}],
        [_match(_payload("ip", "saddr"), "192.168.122.1"), _match(_payload("tcp", "dport"), 4100), {"accept": None}],
        [_match(_payload("ip", "saddr"), "172.29.40.2"),
         _match(_payload("tcp", "dport"), 4100), {"accept": None}],
    ]
    for rule, expression in zip(rules, expected, strict=True):
        identity = {key: item for key, item in rule.items() if key not in {"handle", "expr"}}
        if identity != {"chain": "input", "family": "inet", "table": "codestead_runner_guest"} or rule.get("expr") != expression:
            raise ContractError("guest firewall rule identity or ordering drifted")
    canonical = json.dumps(expected, separators=(",", ":"), sort_keys=True).encode("ascii")
    return {"policySha256": hashlib.sha256(canonical).hexdigest(), "ruleCount": 6}


def _decode_agent_response(raw: bytes) -> dict[str, object]:
    if not raw or len(raw) > 262_144 or b"\x00" in raw:
        raise ContractError("guest-agent response is missing or oversized")
    try:
        value = json.loads(raw.decode("utf-8", "strict"))
    except (UnicodeError, json.JSONDecodeError) as error:
        raise ContractError("guest-agent response is malformed") from error
    if not isinstance(value, dict) or set(value) != {"return"} or not isinstance(value["return"], dict):
        raise ContractError("guest-agent response envelope is invalid")
    return value["return"]


def run_guest_bounded(command: tuple[str, ...], timeout_seconds: int, maximum_bytes: int) -> bytes:
    if (
        not command
        or command[0] not in GUEST_EXECUTABLES
        or not all(isinstance(part, str) and part and "\x00" not in part for part in command)
        or not 1 <= timeout_seconds <= 120
        or not 1 <= maximum_bytes <= 262_144
    ):
        raise ContractError("guest evidence command contract is invalid")
    request = json.dumps(
        {
            "arguments": {"arg": list(command[1:]), "capture-output": True, "path": command[0]},
            "execute": "guest-exec",
        },
        separators=(",", ":"),
        sort_keys=True,
    )
    started = _decode_agent_response(
        run_bounded(("/usr/bin/virsh", "qemu-agent-command", "codestead-runner", request), 15, 65_536)
    )
    if set(started) != {"pid"} or not _canonical_nonnegative_integer(started.get("pid"), 2_147_483_647):
        raise ContractError("guest-agent did not return one process identity")
    deadline = time.monotonic() + timeout_seconds
    while time.monotonic() < deadline:
        status_request = json.dumps(
            {"arguments": {"pid": started["pid"]}, "execute": "guest-exec-status"},
            separators=(",", ":"),
            sort_keys=True,
        )
        status = _decode_agent_response(
            run_bounded(("/usr/bin/virsh", "qemu-agent-command", "codestead-runner", status_request), 15, maximum_bytes)
        )
        if status.get("exited") is not True:
            time.sleep(0.1)
            continue
        if status.get("exitcode") != 0 or status.get("out-truncated") is True or status.get("err-truncated") is True:
            raise ContractError("guest evidence command failed or was truncated")
        try:
            output = base64.b64decode(status.get("out-data", ""), validate=True)
            error_output = base64.b64decode(status.get("err-data", ""), validate=True)
        except (ValueError, TypeError) as error:
            raise ContractError("guest-agent output is not canonical base64") from error
        if error_output or len(output) + len(error_output) > maximum_bytes:
            raise ContractError("guest evidence command emitted error or excessive output")
        return output
    raise ContractError("guest evidence command exceeded its deadline")


def collect_snapshot(
    target: EvidenceTarget,
    power_restored_at_utc: object = None,
    public_ready_at_utc: object = None,
    *,
    read_file=read_protected,
    hash_file=hash_protected_sha256,
    execute=run_bounded,
    guest_execute=run_guest_bounded,
    monotonic=time.monotonic,
    captured_at=lambda: datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
) -> bytes:
    if target.phase == "pre" and (power_restored_at_utc is not None or public_ready_at_utc is not None):
        raise ContractError("pre evidence must not contain post-recovery observations")
    if target.phase == "post" and (
        not isinstance(power_restored_at_utc, str) or not isinstance(public_ready_at_utc, str)
    ):
        raise ContractError("post evidence requires both operator-observed UTC timestamps")
    started = monotonic()
    active = parse_active_release(read_file(ACTIVE_RELEASE_PATH, 16_384))
    release_manifest = read_file(RELEASE_MANIFEST_PATH, 1_048_576)
    application_image_record = read_file(application_image_record_path(active), 1_048_576)
    firewall_source = read_file(FIREWALL_POLICY_PATH, 262_144)
    inventory_raw = read_file(managed_inventory_path(active), 65_536)
    if hashlib.sha256(release_manifest).hexdigest() != active.release_manifest_sha256:
        raise ContractError("active release manifest identity drifted")
    if hashlib.sha256(application_image_record).hexdigest() != active.application_image_record_sha256:
        raise ContractError("active application image record identity drifted")
    if hashlib.sha256(firewall_source).hexdigest() != active.firewall_policy_sha256:
        raise ContractError("active firewall source identity drifted")
    records = parse_managed_inventory(inventory_raw, active.managed_inventory_sha256)

    boot_raw = read_file(BOOT_ID_PATH, 64)
    try:
        boot_id = boot_raw.decode("ascii", "strict").rstrip("\n")
    except UnicodeError as error:
        raise ContractError("boot identity is malformed") from error
    if boot_raw != f"{boot_id}\n".encode("ascii") or re.fullmatch(
        r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}", boot_id
    ) is None:
        raise ContractError("boot identity is malformed")
    uptime_seconds = parse_uptime(read_file(UPTIME_PATH, 128))
    backup, backup_marker_before = observe_backup_recovery_point(read_file, hash_file)
    filesystems = {
        "application": parse_mount(
            execute(APPLICATION_MOUNT_COMMAND, 15, 65_536), "/srv/learncoding", hardened=False
        ),
        "backup": parse_mount(
            execute(BACKUP_MOUNT_COMMAND, 15, 65_536), "/mnt/learncoding-backups", hardened=True
        ),
    }
    smart_by_device: dict[str, dict[str, object]] = {}
    device_by_role: dict[str, str] = {}
    for role in ("application", "backup"):
        source = filesystems[role]["source"]
        if not isinstance(source, str):
            raise ContractError("mount source is invalid")
        device = parse_lsblk_device(execute(lsblk_command(source), 15, 65_536), source)
        device_by_role[role] = device
        if device not in smart_by_device:
            summary = parse_smart_summary(
                execute(smartctl_command(device), 60, 262_144), device
            )
            summary["roles"] = []
            smart_by_device[device] = summary
        roles = smart_by_device[device]["roles"]
        if not isinstance(roles, list):
            raise ContractError("SMART role aggregation is invalid")
        roles.append(role)
    if device_by_role.get("application") == device_by_role.get("backup"):
        raise ContractError("application data and local backup share one physical device")
    smart = [smart_by_device[device] for device in sorted(smart_by_device)]

    pre_digest: str | None = None
    pre_backup: dict[str, object] | None = None
    if target.phase == "post":
        pre_digest, pre_backup = validate_pre_pair(
            target,
            read_file(target.pre_json, 1_048_576),
            read_file(target.pre_checksum, 256),
            active,
            boot_id,
        )

    recovery = parse_recovery_payload(execute(RECOVERY_COMMAND, 660, MAXIMUM_RECOVERY_BYTES))
    if recovery["recovered"] is not True:
        raise ContractError("recovery checker did not prove a healthy recovered state")
    execute(SMOKE_COMMAND, 660, 16_384)

    containers = [
        validate_container_inspection(
            execute(container_inspect_command(record.container), 30, 262_144),
            record,
            active.compose_project,
            active.compose_workdir,
        )
        for record in records
    ]
    host_firewall = validate_firewall_rules(execute(HOST_FIREWALL_COMMAND, 30, 262_144))

    timers: dict[str, dict[str, bool]] = {}
    for timer in REQUIRED_TIMERS:
        _parse_exact_state(execute(systemctl_command("is-enabled", timer), 15, 4_096), b"enabled\n", timer)
        _parse_exact_state(execute(systemctl_command("is-active", timer), 15, 4_096), b"active\n", timer)
        timers[timer] = {"active": True, "enabled": True}
    if execute(FAILED_UNITS_COMMAND, 15, 65_536) != b"":
        raise ContractError("systemd reports failed units")
    address = _parse_runner_address(execute(RUNNER_ADDRESS_COMMAND, 30, 65_536))

    for unit in ("learncoding-runner.service", "learncoding-runner-guest-firewall.service"):
        _parse_exact_state(guest_execute(systemctl_command("is-enabled", unit), 30, 4_096), b"enabled\n", unit)
        _parse_exact_state(guest_execute(systemctl_command("is-active", unit), 30, 4_096), b"active\n", unit)
    guest_release = _parse_digest_output(
        guest_execute(GUEST_RELEASE_IDENTITY_COMMAND, 30, 4_096), GUEST_RELEASE_IDENTITY_COMMAND[1]
    )
    runtime_images = _parse_digest_output(
        guest_execute(GUEST_RUNTIME_IDENTITY_COMMAND, 30, 4_096), GUEST_RUNTIME_IDENTITY_COMMAND[1]
    )
    if guest_release != active.runner_guest_release_sha256 or runtime_images != active.runner_runtime_images_sha256:
        raise ContractError("runner guest or runtime release identity drifted")
    guest_firewall = validate_guest_firewall_rules(guest_execute(GUEST_FIREWALL_COMMAND, 30, 262_144))

    backup_after, backup_marker_after = observe_backup_recovery_point(read_file, hash_file)
    if backup_marker_after != backup_marker_before or backup_after != backup:
        raise ContractError("backup recovery point changed during evidence collection")
    elapsed = math.ceil(monotonic() - started)
    if not _canonical_nonnegative_integer(elapsed, 900):
        raise ContractError("complete evidence collection exceeded its deadline")
    captured = captured_at()
    if re.fullmatch(r"[0-9]{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]Z", captured) is None:
        raise ContractError("capture time is not canonical UTC")
    validate_backup_freshness(backup, captured)
    recovery_timing: dict[str, object] | None = None
    if target.phase == "post":
        recovery_timing = validate_post_recovery_timing(
            power_restored_at_utc,
            public_ready_at_utc,
            captured_at_utc=captured,
            uptime_at_capture_seconds=uptime_seconds + elapsed,
        )
    if pre_backup is not None:
        require_backup_advancement(pre_backup, backup)
    value: dict[str, object] = {
        "backup": backup,
        "bootId": boot_id,
        "capturedAtUtc": captured,
        "collectionElapsedSeconds": elapsed,
        "containers": containers,
        "filesystems": filesystems,
        "host": {"uptimeSeconds": uptime_seconds},
        "eventId": target.event_id,
        "failedSystemdUnits": 0,
        "firewall": {
            "guest": guest_firewall,
            "host": host_firewall,
            "sourceSha256": active.firewall_policy_sha256,
        },
        "phase": target.phase,
        "postgres": {
            "checksums": True,
            "durability": {
                "fsync": "on",
                "fullPageWrites": "on",
                "synchronousCommit": "on",
            },
            "healthy": True,
        },
        "recovery": recovery,
        "release": active_release_identity(active),
        "runner": {
            "address": address,
            "firewallActive": True,
            "firewallEnabled": True,
            "guestReleaseSha256": guest_release,
            "representativeJobPassed": True,
            "runtimeImagesSha256": runtime_images,
            "serviceActive": True,
            "serviceEnabled": True,
        },
        "schemaVersion": 2,
        "smart": smart,
        "timers": timers,
        "virtualization": {
            "domainActive": True,
            "domainAutostart": True,
            "networkActive": True,
            "networkAutostart": True,
        },
    }
    if pre_digest is not None:
        value["preEvidenceSha256"] = pre_digest
    if recovery_timing is not None:
        value["recoveryTiming"] = recovery_timing
    return (json.dumps(value, separators=(",", ":"), sort_keys=True) + "\n").encode("ascii")


def _write_all(descriptor: int, payload: bytes) -> None:
    offset = 0
    while offset < len(payload):
        written = os.write(descriptor, payload[offset:])
        if written <= 0:
            raise ContractError("evidence write made no progress")
        offset += written


def _rename_noreplace(root_descriptor: int, source: str, destination: str) -> None:
    libc = ctypes.CDLL(None, use_errno=True)
    renameat2 = getattr(libc, "renameat2", None)
    if renameat2 is None:
        raise ContractError("renameat2 is required for no-replace publication")
    renameat2.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    renameat2.restype = ctypes.c_int
    if renameat2(
        root_descriptor,
        source.encode("ascii"),
        root_descriptor,
        destination.encode("ascii"),
        RENAME_NOREPLACE,
    ) != 0:
        error = ctypes.get_errno()
        if error == errno.EEXIST:
            raise ContractError("evidence destination already exists")
        raise ContractError("atomic evidence publication failed") from OSError(error, os.strerror(error))


def _safe_root_descriptor(path: Path) -> int:
    try:
        descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
    except OSError as error:
        raise ContractError("evidence root is missing or unsafe") from error
    metadata = os.fstat(descriptor)
    if (
        not stat.S_ISDIR(metadata.st_mode)
        or metadata.st_uid != 0
        or metadata.st_gid != 0
        or stat.S_IMODE(metadata.st_mode) != 0o700
    ):
        os.close(descriptor)
        raise ContractError("evidence root must be root:root mode 0700")
    return descriptor


def _safe_existing_regular(root_descriptor: int, name: str) -> os.stat_result | None:
    try:
        metadata = os.stat(name, dir_fd=root_descriptor, follow_symlinks=False)
    except FileNotFoundError:
        return None
    if (
        not stat.S_ISREG(metadata.st_mode)
        or metadata.st_uid != 0
        or metadata.st_gid != 0
        or stat.S_IMODE(metadata.st_mode) != 0o600
        or metadata.st_nlink != 1
    ):
        raise ContractError("an evidence publication path is unsafe")
    return metadata


def publish_pair(target: EvidenceTarget, payload: bytes) -> None:
    """Publish JSON and its commit-sidecar without replacement.

    The checksum sidecar is the commit record.  A crash after JSON publication
    but before sidecar publication leaves an uncommitted root-owned orphan; a
    later holder of the same event lock removes only that validated orphan and
    retries.  A complete pair is immutable and always rejected on replay.
    """

    if not payload or len(payload) > 1_048_576 or b"\x00" in payload or not payload.endswith(b"\n"):
        raise ContractError("evidence payload is missing, oversized, or non-canonical")
    root_descriptor = _safe_root_descriptor(target.root)
    lock_descriptor = -1
    temporary_names: list[str] = []
    try:
        lock_descriptor = os.open(
            target.lock.name,
            os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_CLOEXEC,
            0o600,
            dir_fd=root_descriptor,
        )
        lock_metadata = os.fstat(lock_descriptor)
        if (
            not stat.S_ISREG(lock_metadata.st_mode)
            or lock_metadata.st_uid != 0
            or lock_metadata.st_gid != 0
            or stat.S_IMODE(lock_metadata.st_mode) != 0o600
            or lock_metadata.st_nlink != 1
        ):
            raise ContractError("evidence event lock is unsafe")
        try:
            fcntl.flock(lock_descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise ContractError("another collector owns this evidence event") from error

        json_metadata = _safe_existing_regular(root_descriptor, target.json.name)
        checksum_metadata = _safe_existing_regular(root_descriptor, target.checksum.name)
        if checksum_metadata is not None:
            if json_metadata is None:
                raise ContractError("committed checksum exists without its JSON")
            raise ContractError("evidence pair is append-only and already committed")
        if json_metadata is not None:
            os.unlink(target.json.name, dir_fd=root_descriptor)
            os.fsync(root_descriptor)

        digest = hashlib.sha256(payload).hexdigest()
        checksum = f"{digest}  {target.json.name}\n".encode("ascii")
        nonce = secrets.token_hex(16)
        json_temporary = f".{target.json.name}.{nonce}.tmp"
        checksum_temporary = f".{target.checksum.name}.{nonce}.tmp"
        temporary_names.extend((json_temporary, checksum_temporary))
        for name, content in ((json_temporary, payload), (checksum_temporary, checksum)):
            descriptor = os.open(
                name,
                os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
                0o600,
                dir_fd=root_descriptor,
            )
            try:
                _write_all(descriptor, content)
                os.fsync(descriptor)
            finally:
                os.close(descriptor)
        os.fsync(root_descriptor)
        _rename_noreplace(root_descriptor, json_temporary, target.json.name)
        temporary_names.remove(json_temporary)
        os.fsync(root_descriptor)
        _rename_noreplace(root_descriptor, checksum_temporary, target.checksum.name)
        temporary_names.remove(checksum_temporary)
        os.fsync(root_descriptor)
    except OSError as error:
        raise ContractError("evidence publication failed") from error
    finally:
        for name in temporary_names:
            try:
                os.unlink(name, dir_fd=root_descriptor)
            except FileNotFoundError:
                pass
        if lock_descriptor >= 0:
            os.close(lock_descriptor)
        os.close(root_descriptor)


def main() -> int:
    if len(sys.argv) < 2:
        return 64
    phase = sys.argv[1]
    if phase == "pre":
        if len(sys.argv) != 3:
            return 64
    elif phase == "post":
        if len(sys.argv) != 5:
            return 64
    else:
        return 64
    target = validate_destination(phase, sys.argv[2])
    payload = collect_snapshot(
        target,
        power_restored_at_utc=sys.argv[3] if phase == "post" else None,
        public_ready_at_utc=sys.argv[4] if phase == "post" else None,
    )
    publish_pair(target, payload)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except ContractError:
        raise SystemExit(1)
