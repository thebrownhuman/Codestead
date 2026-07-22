#!/usr/bin/env python3
"""Linux/root publication tests for the protected existing-container baseline."""

from __future__ import annotations

import importlib.util
import os
import pathlib
import stat
import sys
import tempfile
import unittest
from unittest import mock


ROOT = pathlib.Path(__file__).resolve().parents[2]
OPS = ROOT / "infra" / "ops"
sys.path.insert(0, str(OPS))
SPEC = importlib.util.spec_from_file_location(
    "capture_existing_containers_linux", OPS / "capture-existing-containers.py"
)
if SPEC is None or SPEC.loader is None:  # pragma: no cover
    raise RuntimeError("unable to load capture command")
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


@unittest.skipUnless(sys.platform.startswith("linux") and os.geteuid() == 0, "requires Linux root")
class AtomicPublicationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="container-baseline-", dir="/tmp")
        self.root = pathlib.Path(self.temporary.name)
        self.parent = self.root / "etc" / "learncoding"
        self.lock_parent = self.root / "run" / "lock"
        self.parent.mkdir(parents=True, mode=0o750)
        self.lock_parent.mkdir(parents=True, mode=0o755)
        os.chown(self.parent, 0, 0)
        os.chmod(self.parent, 0o750)
        os.chown(self.lock_parent, 0, 0)
        os.chmod(self.lock_parent, 0o755)
        self.destination = self.parent / "existing-containers.txt"
        MODULE.DESTINATION = str(self.destination)
        MODULE.LOCK_PATH = str(self.lock_parent / "capture.lock")

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def test_initial_and_explicit_replacement_are_atomic_root_only_mode_0600(self) -> None:
        MODULE._atomic_publish(b'{"first":true}', replace=False)
        metadata = os.lstat(self.destination)
        self.assertTrue(stat.S_ISREG(metadata.st_mode))
        self.assertEqual((metadata.st_uid, metadata.st_gid, stat.S_IMODE(metadata.st_mode)), (0, 0, 0o600))
        self.assertEqual(self.destination.read_bytes(), b'{"first":true}')

        with self.assertRaises(MODULE.CaptureError):
            MODULE._atomic_publish(b'{"unexpected":true}', replace=False)
        self.assertEqual(self.destination.read_bytes(), b'{"first":true}')

        MODULE._atomic_publish(b'{"second":true}', replace=True)
        self.assertEqual(self.destination.read_bytes(), b'{"second":true}')
        self.assertEqual(stat.S_IMODE(os.lstat(self.destination).st_mode), 0o600)

    def test_rejects_symlink_destination_and_writable_parent(self) -> None:
        sentinel = self.root / "sentinel"
        sentinel.write_bytes(b"unchanged")
        self.destination.symlink_to(sentinel)
        with self.assertRaises(MODULE.CaptureError):
            MODULE._atomic_publish(b"replacement", replace=True)
        self.assertEqual(sentinel.read_bytes(), b"unchanged")
        self.destination.unlink()

        os.chmod(self.parent, 0o770)
        with self.assertRaises(MODULE.CaptureError):
            MODULE._atomic_publish(b"unsafe-parent", replace=False)
        self.assertFalse(self.destination.exists())

    def test_failed_rename_preserves_old_baseline_and_removes_temporary_file(self) -> None:
        MODULE._atomic_publish(b"reviewed", replace=False)
        with mock.patch.object(MODULE.os, "replace", side_effect=OSError("fixture failure")):
            with self.assertRaises(OSError):
                MODULE._atomic_publish(b"partial", replace=True)
        self.assertEqual(self.destination.read_bytes(), b"reviewed")
        self.assertEqual(
            [path.name for path in self.parent.iterdir() if ".tmp." in path.name], []
        )


if __name__ == "__main__":
    unittest.main()
