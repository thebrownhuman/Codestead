#!/usr/bin/python3
"""Fail-closed client for synthetic production-load browser journeys."""

from __future__ import annotations

from collections.abc import Callable, Sequence
import json
import os
import socket
import stat
import struct
import sys
from typing import BinaryIO, Final, TextIO


SOCKET_PATH: Final = "/run/learncoding/codestead-production-load-test-control.sock"
MAXIMUM_MESSAGE_BYTES: Final = 64 * 1024
SOCKET_TIMEOUT_SECONDS: Final = 10.0
EXPECTED_PROJECT: Final = "learncoding"
FAULT_IDS: Final = frozenset({
    "runner_service_restart",
    "app_container_restart",
    "email_worker_restart",
    "assessment_regrade_worker_restart",
    "project_review_correction_worker_restart",
    "exam_finalization_worker_restart",
    "practice_recovery_worker_restart",
    "rewards_worker_restart",
    "postgres_proxy_interruption",
    "tunnel_proxy_interruption",
    "fake_gmail_failure",
    "fake_ai_provider_failure",
    "fake_offsite_drive_failure",
    "quota_volume_near_full",
    "synthetic_stale_backup_alert",
})
STAGES: Final = frozenset({"steady", "recovered"})


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


def _parse_response(raw: bytes, fault_id: str, stage: str) -> bytes:
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
    result = _exact_object(wrapper["result"], ("ok", "faultId", "stage"))
    if (
        result["ok"] is not True
        or result["faultId"] != fault_id
        or result["stage"] != stage
    ):
        raise ContractError("invalid_response")
    return canonical_json(result)


def _validated_arguments(argv: Sequence[str]) -> tuple[str, str]:
    if (
        len(argv) != 6
        or any(type(item) is not str for item in argv)
        or argv[0] != "--fault-id"
        or argv[2] != "--stage"
        or argv[4] != "--project"
        or argv[1] not in FAULT_IDS
        or argv[3] not in STAGES
        or argv[5] != EXPECTED_PROJECT
    ):
        raise ContractError("invalid_arguments")
    return argv[1], argv[3]


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
    fault_id, stage = _validated_arguments(argv)
    request = canonical_json({
        "version": 1,
        "action": "browser-journey",
        "faultId": fault_id,
        "stage": stage,
        "project": EXPECTED_PROJECT,
    })
    return _parse_response(exchange(request), fault_id, stage)


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
            errors.write("production-load-browser-journey: failed\n")
            errors.flush()
        except Exception:
            pass
        return 70
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
