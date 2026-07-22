#!/usr/bin/env python3
"""Create deterministic secret-canary container inspections for Linux recovery tests."""

from __future__ import annotations

import copy
import json
import pathlib
import sys


ROOT = pathlib.Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "infra" / "ops"))
from existing_container_baseline import identity_from_inspection, serialize_baseline  # noqa: E402


def inspection(name: str, image_character: str, *, healthcheck: bool = False) -> list[object]:
    state: dict[str, object] = {
        "Status": "running",
        "Running": True,
        "Paused": False,
        "Restarting": False,
        "Dead": False,
    }
    health = None
    if healthcheck:
        health = {"Test": ["CMD", "true"], "Interval": 1_000_000_000}
        state["Health"] = {"Status": "healthy", "FailingStreak": 0, "Log": []}
    return [{
        "Id": image_character * 64,
        "Name": f"/{name}",
        "Path": "/entrypoint",
        "Args": ["serve"],
        "Image": "sha256:" + image_character * 64,
        "Config": {
            "Cmd": ["serve"],
            "Entrypoint": ["/entrypoint"],
            "Env": ["PRIVATE_FIXTURE=value"],
            "Healthcheck": health,
            "Image": f"example.invalid/{name}:reviewed",
            "Labels": {"owner": "existing"},
            "User": "",
            "WorkingDir": "/app",
        },
        "HostConfig": {
            "NetworkMode": "bridge",
            "PortBindings": {},
            "ReadonlyRootfs": False,
            "RestartPolicy": {"Name": "unless-stopped", "MaximumRetryCount": 0},
        },
        "Mounts": [],
        "NetworkSettings": {"Networks": {"legacy-net": {"Aliases": None, "DriverOpts": None, "IPAMConfig": None}}},
        "State": state,
    }]


def encoded(value: object) -> bytes:
    return json.dumps(value, separators=(",", ":"), sort_keys=True).encode("ascii")


def main(arguments: list[str]) -> int:
    if len(arguments) != 2:
        raise SystemExit("usage: create-existing-container-baseline.py STATE_ROOT BASELINE")
    state_root = pathlib.Path(arguments[0])
    baseline = pathlib.Path(arguments[1])
    alpha = inspection("legacy-alpha", "a")
    bravo = inspection("legacy-bravo", "b", healthcheck=True)
    variants: dict[str, object] = {"alpha": alpha, "bravo": bravo}
    stopped = copy.deepcopy(bravo)
    stopped[0]["State"]["Running"] = False
    variants["bravo-stopped"] = stopped
    id_drift = copy.deepcopy(bravo)
    id_drift[0]["Id"] = "c" * 64
    variants["bravo-id-drift"] = id_drift
    image_drift = copy.deepcopy(bravo)
    image_drift[0]["Image"] = "sha256:" + "c" * 64
    variants["bravo-image-drift"] = image_drift
    config_drift = copy.deepcopy(bravo)
    config_drift[0]["Config"]["Cmd"] = ["unreviewed"]
    variants["bravo-config-drift"] = config_drift
    restart_drift = copy.deepcopy(bravo)
    restart_drift[0]["HostConfig"]["RestartPolicy"]["Name"] = "no"
    variants["bravo-restart-drift"] = restart_drift
    health_drift = copy.deepcopy(bravo)
    health_drift[0]["State"]["Health"]["Status"] = "unhealthy"
    variants["bravo-health-drift"] = health_drift
    paused = copy.deepcopy(bravo)
    paused[0]["State"]["Paused"] = True
    variants["bravo-paused"] = paused
    restarting = copy.deepcopy(bravo)
    restarting[0]["State"]["Restarting"] = True
    variants["bravo-restarting"] = restarting
    dead = copy.deepcopy(bravo)
    dead[0]["State"]["Dead"] = True
    variants["bravo-dead"] = dead
    status_drift = copy.deepcopy(bravo)
    status_drift[0]["State"]["Status"] = "restarting"
    variants["bravo-status-drift"] = status_drift

    documents: dict[str, bytes] = {}
    for label, value in variants.items():
        data = encoded(value)
        (state_root / f"existing-{label}.inspect.json").write_bytes(data)
        documents[label] = data
    records = [
        identity_from_inspection(documents["alpha"], expected_name="legacy-alpha"),
        identity_from_inspection(documents["bravo"], expected_name="legacy-bravo"),
    ]
    baseline.write_bytes(serialize_baseline(records))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
