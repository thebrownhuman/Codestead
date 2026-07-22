#!/usr/bin/env python3
"""Adversarial tests for persistent ingress quarantine and recovery state."""

from __future__ import annotations

import importlib.util
import os
from pathlib import Path
import stat
import sys
import tempfile
import unittest
from unittest import mock


ROOT = Path(__file__).resolve().parents[2]
HELPER = ROOT / "infra" / "ops" / "ingress-control.py"


def load_helper():
    specification = importlib.util.spec_from_file_location("ingress_control", HELPER)
    if specification is None or specification.loader is None:
        raise AssertionError("ingress-control helper is not importable")
    module = importlib.util.module_from_spec(specification)
    sys.modules[specification.name] = module
    specification.loader.exec_module(module)
    return module


@unittest.skipUnless(sys.platform.startswith("linux") and os.geteuid() == 0, "requires Linux root")
class IngressControlTests(unittest.TestCase):
    def setUp(self) -> None:
        self.helper = load_helper()
        self.temporary = tempfile.TemporaryDirectory(prefix="codestead-ingress-control-", dir="/tmp")
        self.root = Path(self.temporary.name)
        os.chown(self.root, 0, 0)
        os.chmod(self.root, 0o700)
        self.control = self.root / "control"
        self.helper.ensure_control_directory(self.control)

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def test_quarantine_is_exact_root_only_and_idempotent(self) -> None:
        self.helper.create_release_quarantine(self.control)
        self.helper.create_release_quarantine(self.control)
        marker = self.control / "release-quarantine"
        metadata = os.lstat(marker)
        self.assertEqual(marker.read_bytes(), b"codestead-release-quarantine-v1\n")
        self.assertTrue(stat.S_ISREG(metadata.st_mode))
        self.assertEqual((metadata.st_uid, metadata.st_gid), (0, 0))
        self.assertEqual(stat.S_IMODE(metadata.st_mode), 0o600)
        self.assertEqual(metadata.st_nlink, 1)
        self.assertEqual(self.helper.status(self.control, 100), "release-quarantined")

    def test_clear_quarantine_rejects_forged_marker(self) -> None:
        marker = self.control / "release-quarantine"
        marker.write_bytes(b"forged\n")
        os.chown(marker, 0, 0)
        os.chmod(marker, 0o600)
        with self.assertRaises(self.helper.ControlError):
            self.helper.clear_release_quarantine(self.control)
        self.assertTrue(marker.exists())

    def test_reset_recovery_never_clears_release_quarantine(self) -> None:
        self.helper.record_failure(self.control, 100)
        self.helper.create_release_quarantine(self.control)
        self.helper.reset_recovery(self.control)
        self.assertTrue((self.control / "release-quarantine").exists())
        self.assertFalse((self.control / "recovery-state.env").exists())

    def test_recovery_backoff_and_fifth_failure_exhaustion(self) -> None:
        expected = ((100, 1, 130), (130, 2, 190), (190, 3, 310), (310, 4, 550))
        for now, count, next_epoch in expected:
            result = self.helper.record_failure(self.control, now)
            self.assertEqual(result, f"recovery-wait:{self.helper.BACKOFF_SECONDS[count - 1]}")
            state = self.helper.read_recovery_state(self.control)
            self.assertEqual((state.failure_count, state.incident_started_epoch, state.next_attempt_epoch), (count, 100, next_epoch))

        self.assertEqual(self.helper.record_failure(self.control, 550), "recovery-exhausted")
        self.assertEqual(self.helper.status(self.control, 1000), "recovery-exhausted")
        with self.assertRaises(self.helper.ControlError):
            self.helper.record_success(self.control)
        self.helper.reset_recovery(self.control)
        self.assertEqual(self.helper.status(self.control, 1000), "clear")

    def test_status_reports_wait_and_ready(self) -> None:
        self.helper.record_failure(self.control, 100)
        self.assertEqual(self.helper.status(self.control, 101), "recovery-wait:29")
        self.assertEqual(self.helper.status(self.control, 130), "recovery-ready:1")

    def test_success_clears_non_exhausted_state_durably(self) -> None:
        self.helper.record_failure(self.control, 100)
        self.helper.record_success(self.control)
        self.assertFalse((self.control / "recovery-state.env").exists())
        self.assertEqual(self.helper.status(self.control, 200), "clear")

    def test_malformed_and_stale_state_fail_closed(self) -> None:
        state = self.control / "recovery-state.env"
        bad_payloads = (
            b"schema=2\nfailure_count=1\nincident_started_epoch=100\nnext_attempt_epoch=130\n",
            b"schema=1\nfailure_count=-1\nincident_started_epoch=100\nnext_attempt_epoch=130\n",
            b"schema=1\nfailure_count=1\nincident_started_epoch=100\nnext_attempt_epoch=130\nextra=1\n",
            b"schema=1\r\nfailure_count=1\r\nincident_started_epoch=100\r\nnext_attempt_epoch=130\r\n",
        )
        for payload in bad_payloads:
            with self.subTest(payload=payload):
                state.write_bytes(payload)
                os.chown(state, 0, 0)
                os.chmod(state, 0o600)
                with self.assertRaises(self.helper.ControlError):
                    self.helper.status(self.control, 200)

    def test_symlink_hardlink_and_wrong_mode_fail_closed(self) -> None:
        state = self.control / "recovery-state.env"
        sentinel = self.root / "sentinel"
        sentinel.write_bytes(b"unchanged")
        state.symlink_to(sentinel)
        with self.assertRaises(self.helper.ControlError):
            self.helper.status(self.control, 200)
        state.unlink()

        self.helper.record_failure(self.control, 100)
        hardlink = self.root / "hardlink"
        os.link(state, hardlink)
        with self.assertRaises(self.helper.ControlError):
            self.helper.status(self.control, 200)
        hardlink.unlink()
        os.chmod(state, 0o640)
        with self.assertRaises(self.helper.ControlError):
            self.helper.status(self.control, 200)

    def test_wrong_owner_and_writable_ancestor_fail_closed(self) -> None:
        self.helper.record_failure(self.control, 100)
        state = self.control / "recovery-state.env"
        os.chown(state, 1, 1)
        with self.assertRaises(self.helper.ControlError):
            self.helper.status(self.control, 200)
        os.chown(state, 0, 0)
        os.chmod(self.root, 0o770)
        with self.assertRaises(self.helper.ControlError):
            self.helper.status(self.control, 200)

    def test_atomic_replace_failure_preserves_previous_state_and_removes_temp(self) -> None:
        self.helper.record_failure(self.control, 100)
        before = (self.control / "recovery-state.env").read_bytes()
        with mock.patch.object(self.helper.os, "replace", side_effect=OSError("injected rename failure")):
            with self.assertRaises(self.helper.ControlError):
                self.helper.record_failure(self.control, 130)
        self.assertEqual((self.control / "recovery-state.env").read_bytes(), before)
        self.assertEqual([path.name for path in self.control.iterdir() if path.name.startswith(".recovery-state.env.tmp.")], [])


if __name__ == "__main__":
    unittest.main(verbosity=2)
