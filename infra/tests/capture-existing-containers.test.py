#!/usr/bin/env python3
"""Tests for the root-only existing-container baseline capture command."""

from __future__ import annotations

import importlib.util
import json
import pathlib
import sys
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[2]
OPS = ROOT / "infra" / "ops"
sys.path.insert(0, str(OPS))
SPEC = importlib.util.spec_from_file_location(
    "capture_existing_containers", OPS / "capture-existing-containers.py"
)
if SPEC is None or SPEC.loader is None:  # pragma: no cover
    raise RuntimeError("unable to load capture command")
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


def inspection(name: str, container_id: str) -> bytes:
    value = [{
        "Id": container_id,
        "Name": f"/{name}",
        "Path": "/entrypoint",
        "Args": [],
        "Image": "sha256:" + "a" * 64,
        "Config": {"Cmd": [], "Entrypoint": ["/entrypoint"], "Env": ["SECRET=value"], "Healthcheck": None, "Image": "example/app:tag", "Labels": {}, "User": "", "WorkingDir": ""},
        "HostConfig": {"NetworkMode": "bridge", "PortBindings": {}, "ReadonlyRootfs": False, "RestartPolicy": {"Name": "unless-stopped", "MaximumRetryCount": 0}},
        "Mounts": [],
        "NetworkSettings": {"Networks": {"bridge": {"Aliases": None, "DriverOpts": None, "IPAMConfig": None}}},
        "State": {
            "Status": "running",
            "Running": True,
            "Paused": False,
            "Restarting": False,
            "Dead": False,
        },
    }]
    return json.dumps(value, separators=(",", ":")).encode()
def inventory(*entries: tuple[str, str]) -> bytes:
    return b"".join(
        f"{container_id}\t{name}\n".encode("ascii")
        for container_id, name in entries
    )




class CaptureTests(unittest.TestCase):
    def test_capture_uses_exact_names_and_inspects_each_running_container(self) -> None:
        calls: list[tuple[str, ...]] = []
        container_ids = {"email-service": "c" * 64, "portfolio": "d" * 64}
        listing = inventory(*((identifier, name) for name, identifier in container_ids.items()))

        def run(arguments: tuple[str, ...], _limit: int) -> bytes:
            calls.append(arguments)
            if arguments == (
                "ps",
                "--no-trunc",
                "--format",
                "{{.ID}}\t{{.Names}}",
            ):
                return listing
            if arguments[:3] == ("inspect", "--type", "container"):
                name = next(
                    name for name, identifier in container_ids.items() if identifier == arguments[3]
                )
                return inspection(name, arguments[3])
            raise AssertionError(arguments)

        records = MODULE.capture_records(run)
        self.assertEqual([record.name for record in records], ["email-service", "portfolio"])
        self.assertEqual(
            calls,
            [
                ("ps", "--no-trunc", "--format", "{{.ID}}\t{{.Names}}"),
                ("inspect", "--type", "container", "c" * 64),
                ("inspect", "--type", "container", "d" * 64),
                ("ps", "--no-trunc", "--format", "{{.ID}}\t{{.Names}}"),
            ],
        )

    def test_capture_rejects_empty_duplicate_malformed_or_codestead_inventory(self) -> None:
        container_id = b"c" * 64
        for listing in (
            b"",
            container_id + b"\tportfolio\n" + container_id + b"\tportfolio\n",
            container_id + b"\tbad name\n",
            container_id + b"\tlearncoding-app-1\n",
            b"short\tportfolio\n",
        ):
            with self.subTest(listing=listing):
                with self.assertRaises(MODULE.CaptureError):
                    MODULE.capture_records(lambda _arguments, _limit, value=listing: value)

    def test_capture_rejects_inventory_add_remove_or_recreation_during_capture(self) -> None:
        first = inventory(("c" * 64, "email-service"), ("d" * 64, "portfolio"))
        changed_snapshots = (
            inventory(
                ("c" * 64, "email-service"),
                ("d" * 64, "portfolio"),
                ("e" * 64, "roadmap-tracker"),
            ),
            inventory(("c" * 64, "email-service")),
            inventory(("e" * 64, "email-service"), ("d" * 64, "portfolio")),
        )
        for changed in changed_snapshots:
            with self.subTest(changed=changed):
                snapshots = iter((first, changed))
                inspection_names = iter(("email-service", "portfolio"))

                def run(arguments: tuple[str, ...], _limit: int) -> bytes:
                    if arguments[0] == "ps":
                        return next(snapshots)
                    if arguments[:3] == ("inspect", "--type", "container"):
                        return inspection(next(inspection_names), arguments[3])
                    raise AssertionError(arguments)

                with self.assertRaisesRegex(MODULE.CaptureError, "changed during capture"):
                    MODULE.capture_records(run)

    def test_capture_rejects_inspection_that_does_not_match_snapshot_id(self) -> None:
        listing = inventory(("c" * 64, "portfolio"))

        def run(arguments: tuple[str, ...], _limit: int) -> bytes:
            if arguments[0] == "ps":
                return listing
            return inspection("portfolio", "d" * 64)

        with self.assertRaisesRegex(MODULE.CaptureError, "container ID"):
            MODULE.capture_records(run)


if __name__ == "__main__":
    unittest.main()
