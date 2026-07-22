#!/usr/bin/python3
"""Strict, privacy-safe storage and backup evidence contracts."""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[2]
HELPER = ROOT / "infra" / "ops" / "recovery-evidence.py"
specification = importlib.util.spec_from_file_location("recovery_evidence_storage_health", HELPER)
if specification is None or specification.loader is None:
    raise AssertionError("production recovery-evidence helper is not importable")
helper = importlib.util.module_from_spec(specification)
specification.loader.exec_module(helper)


def canonical(value: object) -> bytes:
    return (json.dumps(value, separators=(",", ":"), sort_keys=True) + "\n").encode("ascii")


class StorageHealthTests(unittest.TestCase):
    def test_uptime_and_backup_marker_are_exact_and_canonical(self) -> None:
        self.assertEqual(helper.parse_uptime(b"3723.14 100.00\n"), 3723)
        marker = (
            b"SUCCESS_ARCHIVE=learncoding-full-20260719T120000Z.tar.gz.age\n"
            b"SUCCESS_COMPLETED_UTC=20260719T120021Z\n"
            + f"SUCCESS_SHA256={'a' * 64}\n".encode("ascii")
        )
        self.assertEqual(
            helper.parse_backup_marker(marker),
            {
                "archive": "learncoding-full-20260719T120000Z.tar.gz.age",
                "completedAtUtc": "20260719T120021Z",
                "sha256": "a" * 64,
            },
        )
        for invalid in (
            b"3723.14 100.00",
            b"nan 100.00\n",
            b"-1.0 100.00\n",
            marker + b"EXTRA=true\n",
            marker.replace(b"20260719T120021Z", b"20260231T120021Z"),
            marker + b"\0",
        ):
            with self.subTest(invalid=invalid[:32]):
                parser = helper.parse_uptime if invalid.startswith((b"3723", b"nan", b"-1")) else helper.parse_backup_marker
                with self.assertRaises(helper.ContractError):
                    parser(invalid)

    def test_findmnt_and_lsblk_bind_smart_to_the_observed_physical_device(self) -> None:
        application = canonical(
            {
                "filesystems": [
                    {
                        "fstype": "ext4",
                        "options": "rw,relatime,errors=remount-ro",
                        "source": "/dev/nvme0n1p2",
                        "target": "/",
                    }
                ]
            }
        )
        backup = canonical(
            {
                "filesystems": [
                    {
                        "fstype": "ext4",
                        "options": "rw,nodev,nosuid,noexec",
                        "source": "/dev/sdb1",
                        "target": "/mnt/learncoding-backups",
                    }
                ]
            }
        )
        application_mount = helper.parse_mount(application, "/srv/learncoding", hardened=False)
        backup_mount = helper.parse_mount(backup, "/mnt/learncoding-backups", hardened=True)
        self.assertEqual(application_mount["source"], "/dev/nvme0n1p2")
        self.assertEqual(backup_mount["target"], "/mnt/learncoding-backups")
        topology = canonical(
            {
                "blockdevices": [
                    {
                        "children": [
                            {"name": "/dev/nvme0n1", "pkname": None, "type": "disk"}
                        ],
                        "name": "/dev/nvme0n1p2",
                        "pkname": "/dev/nvme0n1",
                        "type": "part",
                    }
                ]
            }
        )
        self.assertEqual(helper.parse_lsblk_device(topology, "/dev/nvme0n1p2"), "/dev/nvme0n1")
        self.assertEqual(
            helper.lsblk_command("/dev/nvme0n1p2"),
            ("/usr/bin/lsblk", "--json", "--paths", "--output", "NAME,TYPE,PKNAME", "--inverse", "/dev/nvme0n1p2"),
        )
        self.assertEqual(
            helper.smartctl_command("/dev/nvme0n1"),
            ("/usr/sbin/smartctl", "--json=c", "--health", "--attributes", "/dev/nvme0n1"),
        )
        for invalid in (
            application.replace(b'"source":"/dev/nvme0n1p2"', b'"source":"overlay"'),
            backup.replace(b"rw,nodev,nosuid,noexec", b"rw,nodev,nosuid"),
            backup.replace(b'"target":"/mnt/learncoding-backups"', b'"target":"/mnt/other"'),
        ):
            with self.subTest(invalid=invalid[:80]):
                with self.assertRaises(helper.ContractError):
                    helper.parse_mount(invalid, "/mnt/learncoding-backups", hardened=True)

    def test_smart_summary_omits_identity_and_fails_closed_on_any_error(self) -> None:
        healthy = canonical(
            {
                "device": {"name": "/dev/nvme0n1", "protocol": "NVMe"},
                "model_name": "private-model-canary",
                "nvme_smart_health_information_log": {
                    "critical_warning": 0,
                    "media_errors": 0,
                },
                "serial_number": "private-serial-canary",
                "smart_status": {"passed": True},
            }
        )
        result = helper.parse_smart_summary(healthy, "/dev/nvme0n1")
        self.assertEqual(
            result,
            {"criticalWarnings": 0, "deviceClass": "nvme", "healthy": True, "mediaErrors": 0},
        )
        self.assertNotIn("private", json.dumps(result))
        for mutation in (
            healthy.replace(b'"passed":true', b'"passed":false'),
            healthy.replace(b'"critical_warning":0', b'"critical_warning":1'),
            healthy.replace(b'"media_errors":0', b'"media_errors":2'),
            healthy.replace(b'"name":"/dev/nvme0n1"', b'"name":"/dev/sda"'),
            b'{"smart_status":{"passed":true}}\n',
        ):
            with self.subTest(mutation=mutation[:80]):
                with self.assertRaises(helper.ContractError):
                    helper.parse_smart_summary(mutation, "/dev/nvme0n1")


if __name__ == "__main__":
    unittest.main(verbosity=2)
