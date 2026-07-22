from __future__ import annotations

import importlib.util
import io
import json
from pathlib import Path
import stat
import sys
from types import SimpleNamespace
import unittest


SOURCE = Path(__file__).parents[1] / "ops" / "production-load-browser-journey.py"
SPEC = importlib.util.spec_from_file_location("production_load_browser_journey", SOURCE)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("browser journey helper could not be loaded")
HELPER = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = HELPER
SPEC.loader.exec_module(HELPER)

FAULT_IDS = (
    "runner_service_restart",
    "app_container_restart",
    "email_worker_restart",
    "assessment_regrade_worker_restart",
    "project_review_correction_worker_restart",
    "exam_finalization_worker_restart",
    "practice_recovery_worker_restart",
    "rewards_worker_restart",
    "postgres_proxy_interruption",
    "tunnel_proxy_interruption",
    "fake_gmail_failure",
    "fake_ai_provider_failure",
    "fake_offsite_drive_failure",
    "quota_volume_near_full",
    "synthetic_stale_backup_alert",
)


def arguments(fault_id: str, stage: str = "steady") -> list[str]:
    return [
        "--fault-id",
        fault_id,
        "--stage",
        stage,
        "--project",
        "learncoding",
    ]


def canonical(value: object) -> bytes:
    return (json.dumps(value, separators=(",", ":")) + "\n").encode("utf-8")


def response(fault_id: str, stage: str) -> bytes:
    return canonical({
        "ok": True,
        "result": {"ok": True, "faultId": fault_id, "stage": stage},
    })


def identity(kind: int, mode: int, *, uid: int = 0, links: int = 1):
    return SimpleNamespace(
        st_mode=kind | mode,
        st_uid=uid,
        st_nlink=links,
        st_dev=7,
        st_ino=11,
    )


class BrowserJourneyProtocolTests(unittest.TestCase):
    def test_all_fifteen_faults_use_one_exact_synthetic_request(self) -> None:
        for fault_id in FAULT_IDS:
            with self.subTest(fault_id=fault_id):
                requests: list[bytes] = []

                def exchange(request: bytes) -> bytes:
                    requests.append(request)
                    return response(fault_id, "recovered")

                output = HELPER.execute(arguments(fault_id, "recovered"), exchange)

                self.assertEqual(
                    requests,
                    [canonical({
                        "version": 1,
                        "action": "browser-journey",
                        "faultId": fault_id,
                        "stage": "recovered",
                        "project": "learncoding",
                    })],
                )
                self.assertEqual(
                    output,
                    canonical({"ok": True, "faultId": fault_id, "stage": "recovered"}),
                )
                self.assertNotRegex(requests[0].decode("ascii"), r"https?:|cookie|token|password|authorization")

    def test_invalid_or_reordered_arguments_fail_before_exchange(self) -> None:
        invalid = (
            arguments("not-a-fault"),
            arguments(FAULT_IDS[0], "during"),
            [*arguments(FAULT_IDS[0])[:-1], "other"],
            [*arguments(FAULT_IDS[0]), "--extra"],
            ["--stage", "steady", "--fault-id", FAULT_IDS[0], "--project", "learncoding"],
            arguments(FAULT_IDS[0])[:-1],
        )
        for argv in invalid:
            with self.subTest(argv=argv):
                called = False

                def exchange(_request: bytes) -> bytes:
                    nonlocal called
                    called = True
                    return b""

                with self.assertRaises(HELPER.ContractError):
                    HELPER.execute(argv, exchange)
                self.assertFalse(called)

    def test_malformed_noncanonical_oversized_or_mismatched_response_is_rejected(self) -> None:
        fault_id = FAULT_IDS[0]
        malformed = (
            b"not-json\n",
            b'{"ok": true, "result": null}\n',
            canonical({"ok": True, "result": {"ok": True, "faultId": fault_id, "stage": "steady"}, "extra": 1}),
            canonical({"ok": True, "result": {"ok": True, "faultId": fault_id, "stage": "steady", "logs": "secret"}}),
            canonical({"ok": True, "result": {"ok": True, "faultId": FAULT_IDS[1], "stage": "steady"}}),
            canonical({"ok": False, "result": {"ok": True, "faultId": fault_id, "stage": "steady"}}),
            b"\xff\n",
            b"a" * (HELPER.MAXIMUM_MESSAGE_BYTES + 1),
        )
        for raw in malformed:
            with self.subTest(raw=raw[:80]):
                with self.assertRaises(HELPER.ContractError):
                    HELPER.execute(arguments(fault_id), lambda _request, raw=raw: raw)

    def test_main_redacts_transport_exception_and_emits_no_stdout(self) -> None:
        stdout = io.BytesIO()
        stderr = io.StringIO()

        def exchange(_request: bytes) -> bytes:
            raise RuntimeError("cookie=provider-secret-token")

        status = HELPER.main(arguments(FAULT_IDS[0]), exchange, stdout, stderr)

        self.assertEqual(status, 70)
        self.assertEqual(stdout.getvalue(), b"")
        self.assertEqual(stderr.getvalue(), "production-load-browser-journey: failed\n")
        self.assertNotRegex(stderr.getvalue(), r"cookie|provider|secret|token")

    def test_socket_path_requires_trusted_parents_and_root_only_socket(self) -> None:
        safe = {
            "/run": identity(stat.S_IFDIR, 0o755, links=4),
            "/run/learncoding": identity(stat.S_IFDIR, 0o700, links=2),
            HELPER.SOCKET_PATH: identity(stat.S_IFSOCK, 0o600),
        }

        result = HELPER.validate_socket_path(lambda target: safe[target])
        self.assertEqual(result, (7, 11))

        unsafe_cases = (
            {**safe, "/run/learncoding": identity(stat.S_IFLNK, 0o777)},
            {**safe, "/run/learncoding": identity(stat.S_IFDIR, 0o777)},
            {**safe, HELPER.SOCKET_PATH: identity(stat.S_IFSOCK, 0o600, uid=1000)},
            {**safe, HELPER.SOCKET_PATH: identity(stat.S_IFSOCK, 0o660)},
            {**safe, HELPER.SOCKET_PATH: identity(stat.S_IFSOCK, 0o600, links=2)},
        )
        for paths in unsafe_cases:
            with self.subTest(paths=paths):
                with self.assertRaises(HELPER.ContractError):
                    HELPER.validate_socket_path(lambda target, paths=paths: paths[target])


if __name__ == "__main__":
    unittest.main()
