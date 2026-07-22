#!/usr/bin/env python3
"""CLI and fail-closed edge tests for ingress-control.py."""

from __future__ import annotations

import importlib.util
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest import mock


ROOT = Path(__file__).resolve().parents[2]
HELPER = ROOT / "infra" / "ops" / "ingress-control.py"


def load_helper():
    specification = importlib.util.spec_from_file_location("ingress_control_cli", HELPER)
    if specification is None or specification.loader is None:
        raise AssertionError("ingress-control helper is not importable")
    module = importlib.util.module_from_spec(specification)
    sys.modules[specification.name] = module
    specification.loader.exec_module(module)
    return module


@unittest.skipUnless(sys.platform.startswith("linux") and os.geteuid() == 0, "authoritative wrapper requires Linux root")
class IngressControlCliTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="codestead-ingress-cli-", dir="/tmp")
        self.root = Path(self.temporary.name)
        os.chown(self.root, 0, 0)
        os.chmod(self.root, 0o700)

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def run_cli(self, *arguments: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, str(HELPER), "--test-harness-root", str(self.root), *arguments],
            check=False,
            capture_output=True,
            text=True,
            env={"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LANG": "C", "LC_ALL": "C"},
        )

    def test_cli_emits_only_canonical_status_tokens(self) -> None:
        result = self.run_cli("status", "--now", "100")
        self.assertEqual((result.returncode, result.stdout, result.stderr), (0, "clear\n", ""))
        self.assertEqual(self.run_cli("record-failure", "--now", "100").stdout, "recovery-wait:30\n")
        self.assertEqual(self.run_cli("status", "--now", "101").stdout, "recovery-wait:29\n")
        self.assertEqual(self.run_cli("status", "--now", "130").stdout, "recovery-ready:1\n")

    def test_cli_quarantine_blocks_recovery_mutation(self) -> None:
        self.assertEqual(self.run_cli("quarantine-create").returncode, 0)
        blocked = self.run_cli("record-failure", "--now", "100")
        self.assertNotEqual(blocked.returncode, 0)
        self.assertEqual(blocked.stdout, "")
        self.assertIn("release quarantine", blocked.stderr)

    def test_cli_reset_preserves_release_quarantine(self) -> None:
        self.assertEqual(self.run_cli("record-failure", "--now", "100").returncode, 0)
        self.assertEqual(self.run_cli("quarantine-create").returncode, 0)
        self.assertEqual(self.run_cli("reset-recovery").returncode, 0)
        self.assertEqual(self.run_cli("status", "--now", "200").stdout, "release-quarantined\n")

    def test_test_harness_must_be_absolute_root_owned_mode_0700(self) -> None:
        os.chmod(self.root, 0o750)
        result = self.run_cli("status", "--now", "100")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("mode 0700", result.stderr)

    def test_production_cli_rejects_non_root_before_touching_default_path(self) -> None:
        helper = load_helper()
        with mock.patch.object(helper.os, "geteuid", return_value=1000):
            with self.assertRaises(helper.ControlError):
                helper.resolve_control_directory(None)

    def test_forged_exhausted_marker_fails_closed(self) -> None:
        helper = load_helper()
        control = self.root / "control"
        helper.ensure_control_directory(control)
        exhausted = control / "recovery-exhausted"
        exhausted.write_bytes(b"forged\n")
        os.chown(exhausted, 0, 0)
        os.chmod(exhausted, 0o600)
        with self.assertRaises(helper.ControlError):
            helper.status(control, 100)

    def test_quarantine_rejects_symlink_hardlink_and_wrong_metadata(self) -> None:
        helper = load_helper()
        control = self.root / "control"
        helper.ensure_control_directory(control)
        marker = control / "release-quarantine"
        sentinel = self.root / "sentinel"
        sentinel.write_bytes(b"codestead-release-quarantine-v1\n")
        marker.symlink_to(sentinel)
        with self.assertRaises(helper.ControlError):
            helper.status(control, 100)
        marker.unlink()

        helper.create_release_quarantine(control)
        linked = self.root / "linked"
        os.link(marker, linked)
        with self.assertRaises(helper.ControlError):
            helper.status(control, 100)
        linked.unlink()
        os.chmod(marker, 0o640)
        with self.assertRaises(helper.ControlError):
            helper.status(control, 100)
        os.chmod(marker, 0o600)
        os.chown(marker, 1, 1)
        with self.assertRaises(helper.ControlError):
            helper.status(control, 100)

    def test_cross_field_recovery_state_is_rejected(self) -> None:
        helper = load_helper()
        control = self.root / "control"
        helper.ensure_control_directory(control)
        state = control / "recovery-state.env"
        state.write_bytes(b"schema=1\nfailure_count=3\nincident_started_epoch=100\nnext_attempt_epoch=101\n")
        os.chown(state, 0, 0)
        os.chmod(state, 0o600)
        with self.assertRaises(helper.ControlError):
            helper.status(control, 200)

    def test_write_and_fsync_failures_never_publish_a_partial_state(self) -> None:
        helper = load_helper()
        control = self.root / "control"
        helper.ensure_control_directory(control)
        for attribute in ("write", "fsync"):
            with self.subTest(attribute=attribute):
                with mock.patch.object(helper.os, attribute, side_effect=OSError("injected failure")):
                    with self.assertRaises(helper.ControlError):
                        helper.record_failure(control, 100)
                self.assertFalse((control / "recovery-state.env").exists())
                self.assertEqual([entry for entry in control.iterdir() if entry.name.startswith(".recovery-state.env.tmp.")], [])


if __name__ == "__main__":
    unittest.main(verbosity=2)
