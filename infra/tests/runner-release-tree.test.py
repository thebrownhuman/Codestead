#!/usr/bin/python3
"""Behavioral tests for the exact runner release-tree verifier."""

from __future__ import annotations

import hashlib
import importlib.util
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import threading
import time
import unittest


ROOT = Path(__file__).resolve().parents[2]
VERIFIER = ROOT / "infra" / "runner-vm" / "verify-release-tree.py"


def load_verifier():
    if not VERIFIER.is_file():
        raise AssertionError("missing production verify-release-tree.py")
    specification = importlib.util.spec_from_file_location("verify_release_tree", VERIFIER)
    if specification is None or specification.loader is None:
        raise AssertionError("release-tree verifier is not importable")
    module = importlib.util.module_from_spec(specification)
    specification.loader.exec_module(module)
    return module


def file_digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def write_manifest(root: Path) -> str:
    members = sorted(
        path.relative_to(root).as_posix()
        for path in root.rglob("*")
        if path.is_file() and not path.is_symlink() and path.name != "RELEASE.SHA256SUMS"
    )
    manifest = "".join(f"{file_digest(root / member)}  {member}\n" for member in members)
    path = root / "RELEASE.SHA256SUMS"
    path.write_text(manifest, encoding="ascii", newline="\n")
    path.chmod(0o644)
    return file_digest(path)


class ReleaseTreeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        if os.geteuid() != 0:
            raise unittest.SkipTest("release ownership behavior requires Linux root")
        cls.verifier = load_verifier()

    def setUp(self) -> None:
        self.temporary = tempfile.mkdtemp(prefix="codestead-release-tree-")
        self.root = Path(self.temporary) / "release"
        (self.root / "infra" / "runner-vm").mkdir(parents=True, mode=0o755)
        (self.root / "services" / "runner" / "src").mkdir(parents=True, mode=0o755)
        (self.root / "package-lock.json").write_text('{"lockfileVersion":3}\n', encoding="ascii")
        (self.root / "services" / "runner" / "src" / "index.ts").write_text("export {};\n", encoding="ascii")
        (self.root / "infra" / "runner-vm" / "guest-runner.nft").write_text("table inet fixture {}\n", encoding="ascii")
        for path in self.root.rglob("*"):
            if path.is_dir():
                path.chmod(0o755)
            else:
                path.chmod(0o644)
            os.chown(path, 0, 0)
        os.chown(self.root, 0, 0)
        self.root.chmod(0o755)
        self.manifest_sha = write_manifest(self.root)

    def tearDown(self) -> None:
        shutil.rmtree(self.temporary)

    def verify(self) -> None:
        identity = self.verifier.verify_release_tree(self.root, self.manifest_sha)
        self.assertEqual(identity.manifest_sha256, self.manifest_sha)
        self.assertEqual(identity.file_count, 3)

    def test_exact_complete_tree_is_accepted(self) -> None:
        self.verify()

    def test_symlink_hardlink_extra_omitted_writable_and_wrong_owner_are_rejected(self) -> None:
        cases = {}

        def symlink() -> None:
            (self.root / "escape").symlink_to(self.root / "package-lock.json")

        def hardlink() -> None:
            os.link(self.root / "package-lock.json", self.root / "duplicate-lock")
            self.manifest_sha = write_manifest(self.root)

        def extra() -> None:
            (self.root / "extra.txt").write_text("extra\n", encoding="ascii")
            os.chown(self.root / "extra.txt", 0, 0)

        def omitted() -> None:
            lines = (self.root / "RELEASE.SHA256SUMS").read_text(encoding="ascii").splitlines()
            (self.root / "RELEASE.SHA256SUMS").write_text("\n".join(lines[:-1]) + "\n", encoding="ascii")
            self.manifest_sha = file_digest(self.root / "RELEASE.SHA256SUMS")

        def writable() -> None:
            (self.root / "package-lock.json").chmod(0o666)

        def wrong_owner() -> None:
            os.chown(self.root / "package-lock.json", 65534, 65534)

        cases.update(symlink=symlink, hardlink=hardlink, extra=extra, omitted=omitted, writable=writable, wrong_owner=wrong_owner)
        for label, mutate in cases.items():
            with self.subTest(label=label):
                self.tearDown()
                self.setUp()
                mutate()
                with self.assertRaises(self.verifier.ContractError):
                    self.verifier.verify_release_tree(self.root, self.manifest_sha)

    def test_concurrent_mutate_and_restore_is_rejected(self) -> None:
        large = self.root / "services" / "runner" / "large.fixture"
        large.write_bytes(b"A" * (32 * 1024 * 1024))
        large.chmod(0o644)
        os.chown(large, 0, 0)
        self.manifest_sha = write_manifest(self.root)
        stop = threading.Event()

        def mutate() -> None:
            while not stop.is_set():
                with large.open("r+b", buffering=0) as stream:
                    stream.write(b"B")
                    stream.flush()
                    os.fsync(stream.fileno())
                    stream.seek(0)
                    stream.write(b"A")
                    stream.flush()
                    os.fsync(stream.fileno())

        thread = threading.Thread(target=mutate, daemon=True)
        thread.start()
        time.sleep(0.02)
        try:
            with self.assertRaises(self.verifier.ContractError):
                self.verifier.verify_release_tree(self.root, self.manifest_sha)
        finally:
            stop.set()
            thread.join(timeout=2)

    def test_cli_rejects_noncanonical_manifest_digest(self) -> None:
        result = subprocess.run(
            ["/usr/bin/python3", str(VERIFIER), str(self.root), "A" * 64],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
            timeout=10,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stdout, b"")


if __name__ == "__main__":
    unittest.main(verbosity=2)
