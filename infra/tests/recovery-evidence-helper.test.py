#!/usr/bin/python3
"""Behavioral contracts for the privileged recovery-evidence helper."""

from __future__ import annotations

import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[2]
HELPER = ROOT / "infra" / "ops" / "recovery-evidence.py"


def load_helper():
    if not HELPER.is_file():
        raise AssertionError("missing production recovery-evidence.py helper")
    specification = importlib.util.spec_from_file_location("recovery_evidence", HELPER)
    if specification is None or specification.loader is None:
        raise AssertionError("production recovery-evidence helper is not importable")
    module = importlib.util.module_from_spec(specification)
    specification.loader.exec_module(module)
    return module


def healthy_recovery_payload() -> bytes:
    return (
        json.dumps(
            {
                "appHealthy": True,
                "cloudflaredHealthy": True,
                "dockerHealthy": True,
                "elapsedSeconds": 42,
                "existingContainersExpected": 5,
                "existingContainersRunning": 5,
                "firewallHealthy": True,
                "libvirtHealthy": True,
                "postgresDurable": True,
                "postgresHealthy": True,
                "publicHttpsHealthy": True,
                "recovered": True,
                "runnerHealthy": True,
                "schemaVersion": 1,
                "timedOut": False,
                "timersHealthy": True,
                "workersHealthy": True,
            },
            separators=(",", ":"),
            sort_keys=True,
        )
        + "\n"
    ).encode("ascii")


class DestinationContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.helper = load_helper()

    def test_production_root_anchor_accepts_exact_event_path(self) -> None:
        target = self.helper.validate_destination(
            "pre", "/var/lib/learncoding/recovery-evidence/power-20260719.pre.json"
        )
        self.assertEqual(target.event_id, "power-20260719")
        self.assertEqual(target.root, Path("/var/lib/learncoding/recovery-evidence"))
        self.assertEqual(target.json.name, "power-20260719.pre.json")
        self.assertEqual(target.checksum.name, "power-20260719.pre.json.sha256")

    def test_phase_and_filename_must_form_one_pair(self) -> None:
        with self.assertRaises(self.helper.ContractError):
            self.helper.validate_destination(
                "post", "/var/lib/learncoding/recovery-evidence/power-20260719.pre.json"
            )
        with self.assertRaises(self.helper.ContractError):
            self.helper.validate_destination(
                "pre", "/var/lib/learncoding/recovery-evidence/../escape.pre.json"
            )


class RecoveryAggregateTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.helper = load_helper()

    def test_exact_healthy_checker_result_is_accepted(self) -> None:
        value = self.helper.parse_recovery_payload(healthy_recovery_payload())
        self.assertTrue(value["recovered"])
        self.assertEqual(value["elapsedSeconds"], 42)

    def test_every_negative_health_condition_blocks_recovered(self) -> None:
        baseline = json.loads(healthy_recovery_payload())
        health_fields = [name for name in baseline if name.endswith("Healthy") or name == "postgresDurable"]
        for field in health_fields:
            with self.subTest(field=field):
                candidate = dict(baseline)
                candidate[field] = False
                candidate["recovered"] = True
                with self.assertRaises(self.helper.ContractError):
                    self.helper.parse_recovery_payload(
                        (json.dumps(candidate, separators=(",", ":"), sort_keys=True) + "\n").encode("ascii")
                    )

    def test_container_count_drift_blocks_recovered(self) -> None:
        candidate = json.loads(healthy_recovery_payload())
        candidate["existingContainersRunning"] = 4
        with self.assertRaises(self.helper.ContractError):
            self.helper.parse_recovery_payload(
                (json.dumps(candidate, separators=(",", ":"), sort_keys=True) + "\n").encode("ascii")
            )


class AtomicPublicationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.helper = load_helper()

    def test_publication_is_append_only_and_checksum_commits_exact_json(self) -> None:
        if os.geteuid() != 0:
            self.skipTest("production ownership contract requires Linux root")
        with tempfile.TemporaryDirectory(prefix="codestead-evidence-") as directory:
            root = Path(directory)
            root.chmod(0o700)
            target = self.helper.validate_destination(
                "pre", "/var/lib/learncoding/recovery-evidence/power-20260719.pre.json"
            )
            target = target._replace(
                root=root,
                json=root / target.json.name,
                checksum=root / target.checksum.name,
                lock=root / target.lock.name,
            )
            payload = b'{"schemaVersion":2}\n'
            self.helper.publish_pair(target, payload)
            self.assertEqual(target.json.read_bytes(), payload)
            digest, name = target.checksum.read_text(encoding="ascii").rstrip("\n").split("  ")
            self.assertEqual(digest, self.helper.hashlib.sha256(payload).hexdigest())
            self.assertEqual(name, target.json.name)
            with self.assertRaises(self.helper.ContractError):
                self.helper.publish_pair(target, b'{"schemaVersion":3}\n')


if __name__ == "__main__":
    unittest.main(verbosity=2)
