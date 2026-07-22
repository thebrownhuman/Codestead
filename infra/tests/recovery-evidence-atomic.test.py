#!/usr/bin/python3
"""Crash, fsync, and concurrency contracts for evidence publication."""

from __future__ import annotations

import hashlib
import importlib.util
import multiprocessing
import os
from pathlib import Path
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[2]
HELPER = ROOT / "infra" / "ops" / "recovery-evidence.py"


def load_helper(name: str = "recovery_evidence_atomic"):
    specification = importlib.util.spec_from_file_location(name, HELPER)
    if specification is None or specification.loader is None:
        raise AssertionError("production recovery-evidence helper is not importable")
    module = importlib.util.module_from_spec(specification)
    specification.loader.exec_module(module)
    return module


def target_for(helper, root: Path):
    target = helper.validate_destination(
        "pre", "/var/lib/learncoding/recovery-evidence/power-atomic.pre.json"
    )
    return target._replace(
        root=root,
        json=root / target.json.name,
        checksum=root / target.checksum.name,
        lock=root / target.lock.name,
        pre_json=root / target.pre_json.name,
        pre_checksum=root / target.pre_checksum.name,
    )


def concurrent_publisher(root: str, payload: bytes, start, results) -> None:
    helper = load_helper(f"recovery_evidence_child_{os.getpid()}")
    target = target_for(helper, Path(root))
    start.wait()
    try:
        helper.publish_pair(target, payload)
    except helper.ContractError:
        results.put(False)
    else:
        results.put(True)


class AtomicEvidenceTests(unittest.TestCase):
    def setUp(self) -> None:
        if os.geteuid() != 0:
            self.skipTest("publication ownership behavior requires Linux root")
        self.helper = load_helper()
        self.temporary = tempfile.TemporaryDirectory(prefix="codestead-evidence-atomic-")
        self.root = Path(self.temporary.name)
        self.root.chmod(0o700)
        self.target = target_for(self.helper, self.root)
        self.payload = b'{"eventId":"power-atomic","schemaVersion":2}\n'

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def assert_committed(self) -> None:
        self.assertEqual(self.target.json.read_bytes(), self.payload)
        expected = f"{hashlib.sha256(self.payload).hexdigest()}  {self.target.json.name}\n".encode("ascii")
        self.assertEqual(self.target.checksum.read_bytes(), expected)

    def test_concurrent_publishers_have_one_append_only_winner(self) -> None:
        context = multiprocessing.get_context("fork")
        start = context.Event()
        results = context.Queue()
        processes = [
            context.Process(
                target=concurrent_publisher,
                args=(str(self.root), self.payload, start, results),
            )
            for _ in range(8)
        ]
        for process in processes:
            process.start()
        start.set()
        outcomes = [results.get(timeout=10) for _ in processes]
        for process in processes:
            process.join(timeout=10)
            self.assertEqual(process.exitcode, 0)
        self.assertEqual(outcomes.count(True), 1)
        self.assertEqual(outcomes.count(False), 7)
        self.assert_committed()

    def test_every_precommit_fsync_failure_leaves_no_commit_marker_and_can_retry(self) -> None:
        for failing_call in range(1, 5):
            with self.subTest(failing_call=failing_call):
                self.tearDown()
                self.setUp()
                real_fsync = self.helper.os.fsync
                calls = 0

                def injected(descriptor: int) -> None:
                    nonlocal calls
                    calls += 1
                    if calls == failing_call:
                        raise OSError("injected fsync failure")
                    real_fsync(descriptor)

                self.helper.os.fsync = injected
                try:
                    with self.assertRaises(self.helper.ContractError):
                        self.helper.publish_pair(self.target, self.payload)
                finally:
                    self.helper.os.fsync = real_fsync
                self.assertFalse(self.target.checksum.exists())
                self.helper.publish_pair(self.target, self.payload)
                self.assert_committed()

    def test_postcommit_directory_fsync_failure_preserves_one_valid_commit(self) -> None:
        real_fsync = self.helper.os.fsync
        calls = 0

        def injected(descriptor: int) -> None:
            nonlocal calls
            calls += 1
            if calls == 5:
                raise OSError("injected final directory fsync failure")
            real_fsync(descriptor)

        self.helper.os.fsync = injected
        try:
            with self.assertRaises(self.helper.ContractError):
                self.helper.publish_pair(self.target, self.payload)
        finally:
            self.helper.os.fsync = real_fsync
        self.assert_committed()
        with self.assertRaises(self.helper.ContractError):
            self.helper.publish_pair(self.target, self.payload)

    def test_second_rename_failure_recovers_only_validated_orphan(self) -> None:
        real_rename = self.helper._rename_noreplace
        calls = 0

        def injected(root_descriptor: int, source: str, destination: str) -> None:
            nonlocal calls
            calls += 1
            if calls == 2:
                raise self.helper.ContractError("injected checksum rename failure")
            real_rename(root_descriptor, source, destination)

        self.helper._rename_noreplace = injected
        try:
            with self.assertRaises(self.helper.ContractError):
                self.helper.publish_pair(self.target, self.payload)
        finally:
            self.helper._rename_noreplace = real_rename
        self.assertTrue(self.target.json.exists())
        self.assertFalse(self.target.checksum.exists())
        self.helper.publish_pair(self.target, self.payload)
        self.assert_committed()


if __name__ == "__main__":
    unittest.main(verbosity=2)
