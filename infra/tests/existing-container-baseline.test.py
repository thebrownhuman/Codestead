#!/usr/bin/env python3
"""Regression tests for the protected pre-existing container identity baseline."""

from __future__ import annotations

import importlib.util
import json
import pathlib
import sys
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[2]
MODULE_PATH = ROOT / "infra" / "ops" / "existing_container_baseline.py"
SPEC = importlib.util.spec_from_file_location("existing_container_baseline", MODULE_PATH)
if SPEC is None or SPEC.loader is None:  # pragma: no cover - import contract
    raise RuntimeError("unable to load existing-container baseline module")
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


def inspection(
    name: str = "portfolio",
    *,
    container_id: str = "b" * 64,
    image: str = "sha256:" + "a" * 64,
    running: bool = True,
    health: str | None = None,
    restart: str = "unless-stopped",
    status: str = "running",
    paused: bool = False,
    restarting: bool = False,
    dead: bool = False,
) -> bytes:
    healthcheck = None if health is None else {"Test": ["CMD", "true"], "Interval": 1_000_000_000}
    state: dict[str, object] = {
        "Status": status,
        "Running": running,
        "Paused": paused,
        "Restarting": restarting,
        "Dead": dead,
    }
    if health is not None:
        state["Health"] = {"Status": health, "FailingStreak": 0, "Log": []}
    value = [{
        "Id": container_id,
        "Name": f"/{name}",
        "Path": "/entrypoint",
        "Args": ["serve"],
        "Image": image,
        "Config": {
            "Cmd": ["serve"],
            "Entrypoint": ["/entrypoint"],
            "Env": ["PRIVATE_FIXTURE=value"],
            "Healthcheck": healthcheck,
            "Image": "example.invalid/app:reviewed",
            "Labels": {"owner": "existing"},
            "User": "1000:1000",
            "WorkingDir": "/app",
        },
        "HostConfig": {
            "NetworkMode": "bridge",
            "PortBindings": {"8080/tcp": [{"HostIp": "0.0.0.0", "HostPort": "8080"}]},
            "ReadonlyRootfs": True,
            "RestartPolicy": {"Name": restart, "MaximumRetryCount": 0},
        },
        "Mounts": [{"Type": "bind", "Source": "/srv/existing", "Destination": "/data", "Mode": "rw", "RW": True, "Propagation": "rprivate"}],
        "NetworkSettings": {"Networks": {"bridge": {"Aliases": None, "DriverOpts": None, "IPAMConfig": None}}},
        "State": state,
    }]
    return json.dumps(value, separators=(",", ":"), allow_nan=False).encode("utf-8")


class ExistingContainerBaselineTests(unittest.TestCase):
    def test_round_trip_binds_image_configuration_restart_and_health_contract(self) -> None:
        record = MODULE.identity_from_inspection(inspection(health="healthy"), expected_name="portfolio")
        encoded = MODULE.serialize_baseline([record])
        parsed = MODULE.parse_baseline(encoded)

        self.assertEqual(parsed, {"portfolio": record})
        self.assertTrue(MODULE.inspection_matches_record(inspection(health="healthy"), record))
        self.assertFalse(
            MODULE.inspection_matches_record(
                inspection(container_id="c" * 64, health="healthy"), record
            )
        )
        self.assertFalse(MODULE.inspection_matches_record(inspection(image="sha256:" + "c" * 64, health="healthy"), record))

        changed = json.loads(inspection(health="healthy"))
        changed[0]["Config"]["Cmd"] = ["different"]
        self.assertFalse(
            MODULE.inspection_matches_record(
                json.dumps(changed, separators=(",", ":")).encode(), record
            )
        )
        self.assertFalse(MODULE.inspection_matches_record(inspection(health="unhealthy"), record))
        self.assertFalse(MODULE.inspection_matches_record(inspection(running=False, health="healthy"), record))
        self.assertFalse(MODULE.inspection_matches_record(inspection(restart="no", health="healthy"), record))

    def test_rejects_paused_restarting_dead_or_non_running_status(self) -> None:
        for overrides in (
            {"paused": True},
            {"restarting": True},
            {"dead": True},
            {"status": "restarting"},
        ):
            with self.subTest(overrides=overrides):
                with self.assertRaises(MODULE.BaselineContractError):
                    MODULE.identity_from_inspection(
                        inspection(**overrides), expected_name="portfolio"
                    )

    def test_capture_rejects_non_restartable_or_unhealthy_container(self) -> None:
        with self.assertRaises(MODULE.BaselineContractError):
            MODULE.identity_from_inspection(inspection(restart="no"), expected_name="portfolio")
        with self.assertRaises(MODULE.BaselineContractError):
            MODULE.identity_from_inspection(inspection(health="unhealthy"), expected_name="portfolio")
        with self.assertRaises(MODULE.BaselineContractError):
            MODULE.identity_from_inspection(inspection(running=False), expected_name="portfolio")

    def test_baseline_is_canonical_strict_and_secret_free(self) -> None:
        record = MODULE.identity_from_inspection(inspection(), expected_name="portfolio")
        encoded = MODULE.serialize_baseline([record])
        self.assertNotIn(b"PRIVATE_FIXTURE", encoded)
        self.assertEqual(encoded, MODULE.serialize_baseline([record]))

        value = json.loads(encoded)
        self.assertEqual(value["schemaVersion"], 2)
        self.assertEqual(value["containers"][0]["containerId"], "b" * 64)
        value["unexpected"] = True
        with self.assertRaises(MODULE.BaselineContractError):
            MODULE.parse_baseline(json.dumps(value).encode())
        value = json.loads(encoded)
        value["containers"].append(value["containers"][0])
        with self.assertRaises(MODULE.BaselineContractError):
            MODULE.parse_baseline(json.dumps(value).encode())
        with self.assertRaises(MODULE.BaselineContractError):
            MODULE.parse_baseline(encoded + b"\n")


if __name__ == "__main__":
    unittest.main()
