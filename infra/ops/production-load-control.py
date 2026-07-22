#!/usr/bin/python3
"""Fail-closed client for the privileged Codestead production-load controller."""

from __future__ import annotations

from collections.abc import Callable, Sequence
from datetime import datetime, timezone
import json
import math
import os
import re
import socket
import stat
import struct
import sys
from typing import BinaryIO, Final, TextIO


SOCKET_PATH: Final = "/run/learncoding/codestead-production-load-test-control.sock"
MAXIMUM_MESSAGE_BYTES: Final = 64 * 1024
SOCKET_TIMEOUT_SECONDS: Final = 10.0
MAXIMUM_SAFE_INTEGER: Final = 9_007_199_254_740_991
EXPECTED_PROJECT: Final = "learncoding"
EXPECTED_REPOSITORY_ROOT: Final = "/opt/learncoding"
EXPECTED_RUNNER_STATE_ROOT: Final = "/var/lib/learncoding-runner"
EXPECTED_RUNNER_DOMAIN: Final = "codestead-runner"
EXPECTED_RUNNER_UNIT: Final = "learncoding-runner.service"
EXPECTED_RUNNER_MAC: Final = "52:54:00:20:00:12"
UUID_PATTERN: Final = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
)
TIMESTAMP_PATTERN: Final = re.compile(
    r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$"
)
SERVICE_TARGETS: Final = {
    "app_container_restart": "app",
    "email_worker_restart": "mail-worker",
    "assessment_regrade_worker_restart": "regrade-worker",
    "project_review_correction_worker_restart": "project-review-correction-worker",
    "exam_finalization_worker_restart": "exam-finalization-worker",
    "practice_recovery_worker_restart": "practice-runner-recovery-worker",
    "rewards_worker_restart": "reward-worker",
}
TEST_CONTROLS: Final = frozenset({
    "postgres_proxy_interruption",
    "tunnel_proxy_interruption",
    "fake_gmail_failure",
    "fake_ai_provider_failure",
    "fake_offsite_drive_failure",
    "quota_volume_near_full",
    "synthetic_stale_backup_alert",
})
FAULT_IDS: Final = frozenset({
    "runner_service_restart",
    *SERVICE_TARGETS,
    *TEST_CONTROLS,
})
MUTATION_FAULT_IDS: Final = frozenset({"runner_service_restart", *TEST_CONTROLS})
PHASES: Final = frozenset({"baseline", "recovery"})


class ContractError(RuntimeError):
    """A deliberately detail-free protocol or containment failure."""


Exchange = Callable[[bytes], bytes]


def canonical_json(value: object) -> bytes:
    try:
        encoded = json.dumps(
            value,
            allow_nan=False,
            ensure_ascii=True,
            separators=(",", ":"),
        ).encode("utf-8") + b"\n"
    except (TypeError, ValueError) as error:
        raise ContractError("invalid_message") from error
    if len(encoded) > MAXIMUM_MESSAGE_BYTES:
        raise ContractError("message_too_large")
    return encoded


def _exact_object(value: object, keys: tuple[str, ...]) -> dict[str, object]:
    if type(value) is not dict or tuple(value.keys()) != keys:
        raise ContractError("invalid_message")
    return value


def _number(value: object, minimum: float, maximum: float) -> int | float:
    if (
        type(value) not in (int, float)
        or not math.isfinite(value)
        or value < minimum
        or value > maximum
    ):
        raise ContractError("invalid_response")
    return value


def _integer(value: object) -> int:
    if type(value) is not int or value < 0 or value > MAXIMUM_SAFE_INTEGER:
        raise ContractError("invalid_response")
    return value


def _timestamp(value: object) -> str:
    if type(value) is not str or TIMESTAMP_PATTERN.fullmatch(value) is None:
        raise ContractError("invalid_response")
    try:
        parsed = datetime.strptime(value, "%Y-%m-%dT%H:%M:%S.%fZ").replace(
            tzinfo=timezone.utc
        )
    except ValueError as error:
        raise ContractError("invalid_response") from error
    if parsed.strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z" != value:
        raise ContractError("invalid_response")
    return value


def _target_tokens(fault_id: str) -> tuple[str, ...]:
    service = SERVICE_TARGETS.get(fault_id)
    if service is not None:
        return "compose-service", service
    if fault_id == "runner_service_restart":
        return "runner-service", EXPECTED_RUNNER_DOMAIN, EXPECTED_RUNNER_UNIT
    if fault_id in TEST_CONTROLS:
        return "test-control", fault_id
    raise ContractError("invalid_arguments")


def _target_object(fault_id: str) -> dict[str, object]:
    service = SERVICE_TARGETS.get(fault_id)
    if service is not None:
        return {"kind": "compose-service", "service": service}
    if fault_id == "runner_service_restart":
        return {
            "kind": "runner-service",
            "domain": EXPECTED_RUNNER_DOMAIN,
            "unit": EXPECTED_RUNNER_UNIT,
        }
    if fault_id in TEST_CONTROLS:
        return {"kind": "test-control", "control": fault_id}
    raise ContractError("invalid_arguments")


def _identity(suffix: Sequence[str]) -> str:
    if (
        tuple(suffix[:2]) != ("--project", EXPECTED_PROJECT)
        or len(suffix) != 6
        or suffix[2] != "--runner-vm-id"
        or UUID_PATTERN.fullmatch(suffix[3]) is None
        or suffix[4] != "--runner-vm-mac"
        or suffix[5] != EXPECTED_RUNNER_MAC
    ):
        raise ContractError("invalid_arguments")
    return suffix[3]


def _fault_request(
    argv: Sequence[str],
    *,
    with_phase: bool,
    mutation: bool,
) -> tuple[str, dict[str, object]]:
    if len(argv) < 2 or argv[1] not in FAULT_IDS:
        raise ContractError("invalid_arguments")
    fault_id = argv[1]
    if mutation and fault_id not in MUTATION_FAULT_IDS:
        raise ContractError("invalid_arguments")
    target = _target_tokens(fault_id)
    target_end = 2 + len(target)
    if tuple(argv[2:target_end]) != target:
        raise ContractError("invalid_arguments")
    phase: str | None = None
    suffix_start = target_end
    if with_phase:
        if (
            len(argv) < target_end + 2
            or argv[target_end] != "--phase"
            or argv[target_end + 1] not in PHASES
        ):
            raise ContractError("invalid_arguments")
        phase = argv[target_end + 1]
        suffix_start += 2
    runner_vm_id = _identity(argv[suffix_start:])
    request: dict[str, object] = {
        "version": 1,
        "action": argv[0],
        "faultId": fault_id,
        "target": _target_object(fault_id),
    }
    if phase is not None:
        request["phase"] = phase
    request.update({
        "project": EXPECTED_PROJECT,
        "runnerVmId": runner_vm_id,
        "runnerVmMac": EXPECTED_RUNNER_MAC,
    })
    return argv[0], request


def _request(argv: Sequence[str]) -> tuple[str, dict[str, object]]:
    if not argv or any(
        type(item) is not str
        or not item
        or len(item) > 1024
        or "\x00" in item
        for item in argv
    ):
        raise ContractError("invalid_arguments")
    action = argv[0]
    if action == "isolation-status":
        if (
            len(argv) != 11
            or tuple(argv[1:7]) != (
                "--project", EXPECTED_PROJECT,
                "--repository-root", EXPECTED_REPOSITORY_ROOT,
                "--runner-state-root", EXPECTED_RUNNER_STATE_ROOT,
            )
            or argv[7] != "--runner-vm-id"
            or UUID_PATTERN.fullmatch(argv[8]) is None
            or tuple(argv[9:]) != ("--runner-vm-mac", EXPECTED_RUNNER_MAC)
        ):
            raise ContractError("invalid_arguments")
        return action, {
            "version": 1,
            "action": action,
            "project": EXPECTED_PROJECT,
            "repositoryRoot": EXPECTED_REPOSITORY_ROOT,
            "runnerStateRoot": EXPECTED_RUNNER_STATE_ROOT,
            "runnerVmId": argv[8],
            "runnerVmMac": EXPECTED_RUNNER_MAC,
        }
    if action == "host-telemetry":
        if tuple(argv) != ("host-telemetry", "--project", EXPECTED_PROJECT):
            raise ContractError("invalid_arguments")
        return action, {"version": 1, "action": action, "project": EXPECTED_PROJECT}
    if action == "runner-vm-telemetry":
        if (
            len(argv) != 7
            or tuple(argv[1:3]) != ("--runner-domain", EXPECTED_RUNNER_DOMAIN)
            or argv[3] != "--runner-vm-id"
            or UUID_PATTERN.fullmatch(argv[4]) is None
            or tuple(argv[5:]) != ("--runner-vm-mac", EXPECTED_RUNNER_MAC)
        ):
            raise ContractError("invalid_arguments")
        return action, {
            "version": 1,
            "action": action,
            "runnerDomain": EXPECTED_RUNNER_DOMAIN,
            "runnerVmId": argv[4],
            "runnerVmMac": EXPECTED_RUNNER_MAC,
        }
    if action in ("reset", "inject-and-release"):
        return _fault_request(argv, with_phase=False, mutation=True)
    if action == "probe":
        return _fault_request(argv, with_phase=True, mutation=False)
    if action == "invariant-evidence":
        return _fault_request(argv, with_phase=False, mutation=False)
    raise ContractError("invalid_arguments")


def _parse_wrapper(raw: bytes) -> object:
    if type(raw) is not bytes or not raw or len(raw) > MAXIMUM_MESSAGE_BYTES:
        raise ContractError("invalid_response")
    try:
        text = raw.decode("utf-8", errors="strict")
    except UnicodeDecodeError as error:
        raise ContractError("invalid_response") from error
    if "\x00" in text or "\r" in text or not text.endswith("\n"):
        raise ContractError("invalid_response")
    try:
        value = json.loads(text)
    except (json.JSONDecodeError, RecursionError) as error:
        raise ContractError("invalid_response") from error
    if canonical_json(value) != raw:
        raise ContractError("invalid_response")
    wrapper = _exact_object(value, ("ok", "result"))
    if wrapper["ok"] is not True:
        raise ContractError("invalid_response")
    return wrapper["result"]


def _validated_result(action: str, result: object) -> bytes:
    if action in ("reset", "inject-and-release"):
        if result is not None:
            raise ContractError("invalid_response")
        return b""
    if action == "isolation-status":
        value = _exact_object(
            result,
            ("maintenanceWindowApproved", "freshRecoveryPoint"),
        )
        if (
            type(value["maintenanceWindowApproved"]) is not bool
            or type(value["freshRecoveryPoint"]) is not bool
        ):
            raise ContractError("invalid_response")
    elif action == "host-telemetry":
        value = _exact_object(result, (
            "hostCpuPercent",
            "availableMemoryBytes",
            "rootFreeFraction",
            "rootFreeBytes",
            "diskReadBytes",
            "diskWriteBytes",
            "temperatureCelsius",
            "oomKills",
            "thermalThrottleIncrements",
        ))
        _number(value["hostCpuPercent"], 0, 100)
        _integer(value["availableMemoryBytes"])
        _number(value["rootFreeFraction"], 0, 1)
        _integer(value["rootFreeBytes"])
        _integer(value["diskReadBytes"])
        _integer(value["diskWriteBytes"])
        _number(value["temperatureCelsius"], -100, 200)
        _integer(value["oomKills"])
        _integer(value["thermalThrottleIncrements"])
    elif action == "runner-vm-telemetry":
        value = _exact_object(
            result,
            ("runnerVmCpuPercent", "runnerVmAvailableMemoryBytes"),
        )
        _number(value["runnerVmCpuPercent"], 0, 100)
        _integer(value["runnerVmAvailableMemoryBytes"])
    elif action == "probe":
        value = _exact_object(
            result,
            ("componentHealthy", "alertOrDeadLetterVisible"),
        )
        if (
            type(value["componentHealthy"]) is not bool
            or type(value["alertOrDeadLetterVisible"]) is not bool
        ):
            raise ContractError("invalid_response")
    elif action == "invariant-evidence":
        value = _exact_object(result, (
            "observedAt",
            "acknowledgedMutationFailures",
            "runnerMaxConcurrentJobs",
            "secretLeakFindings",
        ))
        _timestamp(value["observedAt"])
        _integer(value["acknowledgedMutationFailures"])
        _integer(value["runnerMaxConcurrentJobs"])
        _integer(value["secretLeakFindings"])
    else:
        raise ContractError("invalid_response")
    return canonical_json(value)


def validate_socket_path(
    inspect: Callable[[str], os.stat_result] = os.lstat,
) -> tuple[int, int]:
    try:
        run_identity = inspect("/run")
        parent_identity = inspect("/run/learncoding")
        socket_identity = inspect(SOCKET_PATH)
    except OSError as error:
        raise ContractError("unsafe_socket") from error
    for identity in (run_identity, parent_identity):
        mode = stat.S_IMODE(identity.st_mode)
        if (
            not stat.S_ISDIR(identity.st_mode)
            or identity.st_uid != 0
            or identity.st_nlink < 1
            or mode & 0o022
            or not mode & 0o100
        ):
            raise ContractError("unsafe_socket")
    if (
        not stat.S_ISSOCK(socket_identity.st_mode)
        or socket_identity.st_uid != 0
        or socket_identity.st_nlink != 1
        or stat.S_IMODE(socket_identity.st_mode) != 0o600
        or socket_identity.st_dev < 0
        or socket_identity.st_ino <= 0
    ):
        raise ContractError("unsafe_socket")
    return socket_identity.st_dev, socket_identity.st_ino


def socket_exchange(request: bytes) -> bytes:
    if type(request) is not bytes or not request or len(request) > MAXIMUM_MESSAGE_BYTES:
        raise ContractError("invalid_request")
    before = validate_socket_path()
    if not hasattr(socket, "SO_PEERCRED"):
        raise ContractError("peer_identity_unavailable")
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
            client.settimeout(SOCKET_TIMEOUT_SECONDS)
            client.connect(SOCKET_PATH)
            if validate_socket_path() != before:
                raise ContractError("unsafe_socket")
            peer = client.getsockopt(
                socket.SOL_SOCKET,
                socket.SO_PEERCRED,
                struct.calcsize("3i"),
            )
            _pid, uid, _gid = struct.unpack("3i", peer)
            if uid != 0:
                raise ContractError("unsafe_peer")
            client.sendall(request)
            client.shutdown(socket.SHUT_WR)
            chunks: list[bytes] = []
            total = 0
            while True:
                chunk = client.recv(min(8192, MAXIMUM_MESSAGE_BYTES + 1 - total))
                if not chunk:
                    break
                total += len(chunk)
                if total > MAXIMUM_MESSAGE_BYTES:
                    raise ContractError("response_too_large")
                chunks.append(chunk)
    except (OSError, struct.error) as error:
        raise ContractError("exchange_failed") from error
    return b"".join(chunks)


def execute(argv: Sequence[str], exchange: Exchange = socket_exchange) -> bytes:
    action, request = _request(tuple(argv))
    raw = exchange(canonical_json(request))
    return _validated_result(action, _parse_wrapper(raw))


def main(
    argv: Sequence[str] | None = None,
    exchange: Exchange = socket_exchange,
    stdout: BinaryIO | None = None,
    stderr: TextIO | None = None,
) -> int:
    arguments = tuple(sys.argv[1:] if argv is None else argv)
    output = sys.stdout.buffer if stdout is None else stdout
    errors = sys.stderr if stderr is None else stderr
    try:
        message = execute(arguments, exchange)
        output.write(message)
        output.flush()
    except Exception:
        try:
            errors.write("production-load-control: failed\n")
            errors.flush()
        except Exception:
            pass
        return 70
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
