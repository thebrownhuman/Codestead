#!/usr/bin/python3
"""Canonical, secret-free identity records for pre-existing NUC containers.

The protected baseline stores only container names, immutable image IDs,
restart/health requirements, and a SHA-256 digest of the reviewed Docker
configuration.  Raw environment values and other inspect data never leave
process memory.
"""

from __future__ import annotations

import dataclasses
import hashlib
import json
import re
from collections.abc import Iterable
from typing import Final


MAXIMUM_INSPECTION_BYTES: Final = 2_097_152
MAXIMUM_BASELINE_BYTES: Final = 65_536
SCHEMA_VERSION: Final = 2
_NAME_PATTERN: Final = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}")
_CONTAINER_ID_PATTERN: Final = re.compile(r"[0-9a-f]{64}")
_IMAGE_ID_PATTERN: Final = re.compile(r"sha256:[0-9a-f]{64}")
_DIGEST_PATTERN: Final = re.compile(r"[0-9a-f]{64}")
_RESTART_POLICIES: Final = frozenset({"always", "unless-stopped"})


class BaselineContractError(RuntimeError):
    """The protected baseline or Docker inspection violated its contract."""


@dataclasses.dataclass(frozen=True, slots=True)
class ContainerIdentity:
    name: str
    container_id: str
    image_id: str
    config_sha256: str
    restart_policy: str
    healthcheck_required: bool


def _reject_duplicate_key(pairs: list[tuple[str, object]]) -> dict[str, object]:
    value: dict[str, object] = {}
    for key, item in pairs:
        if key in value:
            raise BaselineContractError("JSON contains a duplicate key")
        value[key] = item
    return value


def _reject_constant(_value: str) -> object:
    raise BaselineContractError("JSON contains a non-finite number")


def _loads(raw: bytes, *, limit: int) -> object:
    if not raw or len(raw) > limit:
        raise BaselineContractError("JSON input size is invalid")
    try:
        text = raw.decode("utf-8", "strict")
        return json.loads(
            text,
            object_pairs_hook=_reject_duplicate_key,
            parse_constant=_reject_constant,
        )
    except (UnicodeError, json.JSONDecodeError) as error:
        raise BaselineContractError("JSON input is invalid") from error


def _canonical_bytes(value: object) -> bytes:
    try:
        return json.dumps(
            value,
            allow_nan=False,
            ensure_ascii=True,
            separators=(",", ":"),
            sort_keys=True,
        ).encode("ascii")
    except (TypeError, ValueError) as error:
        raise BaselineContractError("Docker inspection is not canonical JSON") from error


def _inspection_object(raw: bytes, *, expected_name: str) -> dict[str, object]:
    if _NAME_PATTERN.fullmatch(expected_name) is None:
        raise BaselineContractError("expected container name is invalid")
    document = _loads(raw, limit=MAXIMUM_INSPECTION_BYTES)
    if not isinstance(document, list) or len(document) != 1 or not isinstance(document[0], dict):
        raise BaselineContractError("Docker inspection must contain exactly one object")
    inspection = document[0]
    if inspection.get("Name") != f"/{expected_name}":
        raise BaselineContractError("Docker inspection name does not match")
    return inspection


def _configuration_projection(inspection: dict[str, object]) -> dict[str, object]:
    config = inspection.get("Config")
    host_config = inspection.get("HostConfig")
    mounts = inspection.get("Mounts")
    network_settings = inspection.get("NetworkSettings")
    if (
        not isinstance(config, dict)
        or not isinstance(host_config, dict)
        or not isinstance(mounts, list)
        or not isinstance(network_settings, dict)
        or not isinstance(network_settings.get("Networks"), dict)
    ):
        raise BaselineContractError("Docker inspection configuration is incomplete")

    # Runtime-assigned addresses and endpoint IDs may legitimately change when
    # Docker restarts.  Bind the declared network membership and its static
    # options while excluding those runtime observations.
    networks: dict[str, object] = {}
    for name, details in network_settings["Networks"].items():
        if not isinstance(name, str) or not isinstance(details, dict):
            raise BaselineContractError("Docker network inspection is invalid")
        networks[name] = {
            "Aliases": details.get("Aliases"),
            "DriverOpts": details.get("DriverOpts"),
            "IPAMConfig": details.get("IPAMConfig"),
        }

    return {
        "Args": inspection.get("Args"),
        "Config": config,
        "HostConfig": host_config,
        "Mounts": mounts,
        "Networks": networks,
        "Path": inspection.get("Path"),
    }


def identity_from_inspection(raw: bytes, *, expected_name: str) -> ContainerIdentity:
    """Return the reviewed identity, rejecting a non-recoverable container."""

    inspection = _inspection_object(raw, expected_name=expected_name)
    container_id = inspection.get("Id")
    image_id = inspection.get("Image")
    state = inspection.get("State")
    host_config = inspection.get("HostConfig")
    config = inspection.get("Config")
    if (
        not isinstance(container_id, str)
        or _CONTAINER_ID_PATTERN.fullmatch(container_id) is None
    ):
        raise BaselineContractError("Docker container ID is not an immutable SHA-256 ID")
    if not isinstance(image_id, str) or _IMAGE_ID_PATTERN.fullmatch(image_id) is None:
        raise BaselineContractError("Docker image ID is not an immutable SHA-256 ID")
    if (
        not isinstance(state, dict)
        or state.get("Status") != "running"
        or state.get("Running") is not True
        or state.get("Paused") is not False
        or state.get("Restarting") is not False
        or state.get("Dead") is not False
    ):
        raise BaselineContractError("container is not stably running")
    if not isinstance(host_config, dict) or not isinstance(config, dict):
        raise BaselineContractError("Docker inspection configuration is incomplete")
    restart = host_config.get("RestartPolicy")
    if not isinstance(restart, dict) or restart.get("Name") not in _RESTART_POLICIES:
        raise BaselineContractError("container does not have an approved restart policy")
    restart_policy = restart["Name"]
    if not isinstance(restart_policy, str):  # narrowed for static type checkers
        raise BaselineContractError("container restart policy is invalid")

    healthcheck = config.get("Healthcheck")
    healthcheck_required = healthcheck is not None
    if healthcheck_required:
        if (
            not isinstance(healthcheck, dict)
            or not isinstance(healthcheck.get("Test"), list)
            or not healthcheck["Test"]
            or not all(isinstance(item, str) and item for item in healthcheck["Test"])
        ):
            raise BaselineContractError("container healthcheck configuration is invalid")
        health = state.get("Health")
        if not isinstance(health, dict) or health.get("Status") != "healthy":
            raise BaselineContractError("container healthcheck is not healthy")

    projection = _configuration_projection(inspection)
    config_sha256 = hashlib.sha256(_canonical_bytes(projection)).hexdigest()
    return ContainerIdentity(
        name=expected_name,
        container_id=container_id,
        image_id=image_id,
        config_sha256=config_sha256,
        restart_policy=restart_policy,
        healthcheck_required=healthcheck_required,
    )


def inspection_matches_record(raw: bytes, record: ContainerIdentity) -> bool:
    """Return true only for the same running, healthy reviewed identity."""

    try:
        return identity_from_inspection(raw, expected_name=record.name) == record
    except BaselineContractError:
        return False


def _record_value(record: ContainerIdentity) -> dict[str, object]:
    return {
        "containerId": record.container_id,
        "configSha256": record.config_sha256,
        "healthcheckRequired": record.healthcheck_required,
        "imageId": record.image_id,
        "name": record.name,
        "restartPolicy": record.restart_policy,
    }


def serialize_baseline(records: Iterable[ContainerIdentity]) -> bytes:
    ordered = sorted(records, key=lambda item: item.name)
    if not ordered or len({record.name for record in ordered}) != len(ordered):
        raise BaselineContractError("baseline must contain unique container records")
    for record in ordered:
        if (
            _NAME_PATTERN.fullmatch(record.name) is None
            or _CONTAINER_ID_PATTERN.fullmatch(record.container_id) is None
            or _IMAGE_ID_PATTERN.fullmatch(record.image_id) is None
            or _DIGEST_PATTERN.fullmatch(record.config_sha256) is None
            or record.restart_policy not in _RESTART_POLICIES
            or not isinstance(record.healthcheck_required, bool)
        ):
            raise BaselineContractError("baseline record is invalid")
    encoded = _canonical_bytes(
        {"containers": [_record_value(record) for record in ordered], "schemaVersion": SCHEMA_VERSION}
    )
    if len(encoded) > MAXIMUM_BASELINE_BYTES:
        raise BaselineContractError("baseline is too large")
    return encoded


def parse_baseline(raw: bytes) -> dict[str, ContainerIdentity]:
    value = _loads(raw, limit=MAXIMUM_BASELINE_BYTES)
    if not isinstance(value, dict) or set(value) != {"containers", "schemaVersion"}:
        raise BaselineContractError("baseline object has unexpected fields")
    if value.get("schemaVersion") != SCHEMA_VERSION or isinstance(value.get("schemaVersion"), bool):
        raise BaselineContractError("baseline schema version is invalid")
    containers = value.get("containers")
    if not isinstance(containers, list) or not containers:
        raise BaselineContractError("baseline container inventory is empty")
    records: list[ContainerIdentity] = []
    for item in containers:
        if not isinstance(item, dict) or set(item) != {
            "containerId",
            "configSha256",
            "healthcheckRequired",
            "imageId",
            "name",
            "restartPolicy",
        }:
            raise BaselineContractError("baseline record has unexpected fields")
        record = ContainerIdentity(
            name=item.get("name") if isinstance(item.get("name"), str) else "",
            container_id=(
                item.get("containerId") if isinstance(item.get("containerId"), str) else ""
            ),
            image_id=item.get("imageId") if isinstance(item.get("imageId"), str) else "",
            config_sha256=(
                item.get("configSha256") if isinstance(item.get("configSha256"), str) else ""
            ),
            restart_policy=(
                item.get("restartPolicy") if isinstance(item.get("restartPolicy"), str) else ""
            ),
            healthcheck_required=item.get("healthcheckRequired"),
        )
        records.append(record)
    encoded = serialize_baseline(records)
    if encoded != raw:
        raise BaselineContractError("baseline is not in canonical form")
    return {record.name: record for record in records}
