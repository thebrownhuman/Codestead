from __future__ import annotations

import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import unittest


ROOT = Path(__file__).resolve().parents[2]
HELPER = ROOT / "infra" / "ops" / "production-load-peer-credentials.py"


class ProductionLoadPeerCredentialHelperTests(unittest.TestCase):
    def test_rejects_arguments_without_emitting_details(self) -> None:
        result = subprocess.run(
            [sys.executable, str(HELPER), "unexpected"],
            stdin=subprocess.DEVNULL,
            capture_output=True,
            check=False,
            timeout=5,
        )
        self.assertEqual(result.returncode, 70)
        self.assertEqual(result.stdout, b"")
        self.assertEqual(result.stderr, b"")

    def test_rejects_a_non_socket_descriptor_without_emitting_details(self) -> None:
        result = subprocess.run(
            [sys.executable, str(HELPER)],
            stdin=subprocess.DEVNULL,
            capture_output=True,
            check=False,
            timeout=5,
        )
        self.assertEqual(result.returncode, 70)
        self.assertEqual(result.stdout, b"")
        self.assertEqual(result.stderr, b"")

    @unittest.skipUnless(
        sys.platform.startswith("linux") and hasattr(socket, "SO_PEERCRED"),
        "Linux SO_PEERCRED is required",
    )
    def test_reports_the_kernel_authenticated_unix_peer_canonically(self) -> None:
        parent, inherited = socket.socketpair(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            result = subprocess.run(
                [sys.executable, str(HELPER)],
                stdin=inherited,
                capture_output=True,
                check=False,
                timeout=5,
            )
        finally:
            inherited.close()
            parent.close()

        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stderr, b"")
        payload = json.loads(result.stdout)
        self.assertEqual(list(payload), ["pid", "uid", "gid"])
        self.assertIsInstance(payload["pid"], int)
        self.assertGreater(payload["pid"], 0)
        self.assertEqual(payload["uid"], os.getuid())
        self.assertEqual(payload["gid"], os.getgid())
        expected = (
            f'{{"pid":{payload["pid"]},"uid":{os.getuid()},"gid":{os.getgid()}}}\n'
        ).encode("ascii")
        self.assertEqual(result.stdout, expected)


if __name__ == "__main__":
    unittest.main()
