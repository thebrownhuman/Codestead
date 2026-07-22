from __future__ import annotations

import importlib.util
import io
import json
from pathlib import Path
import stat
import sys
from types import SimpleNamespace
import unittest


SOURCE = Path(__file__).parents[1] / "ops" / "production-load-control.py"
SPEC = importlib.util.spec_from_file_location("production_load_control", SOURCE)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("production load control helper could not be loaded")
HELPER = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = HELPER
SPEC.loader.exec_module(HELPER)

VM_ID = "57b9ab11-f3a4-4ea8-a58e-e73d951f9d11"
VM_MAC = "52:54:00:20:00:12"
SERVICE_TARGETS = {
    "app_container_restart": "app",
    "email_worker_restart": "mail-worker",
    "assessment_regrade_worker_restart": "regrade-worker",
    "project_review_correction_worker_restart": "project-review-correction-worker",
    "exam_finalization_worker_restart": "exam-finalization-worker",
    "practice_recovery_worker_restart": "practice-runner-recovery-worker",
    "rewards_worker_restart": "reward-worker",
}
TEST_CONTROLS = (
    "postgres_proxy_interruption",
    "tunnel_proxy_interruption",
    "fake_gmail_failure",
    "fake_ai_provider_failure",
    "fake_offsite_drive_failure",
    "quota_volume_near_full",
    "synthetic_stale_backup_alert",
)
FAULT_IDS = ("runner_service_restart", *SERVICE_TARGETS, *TEST_CONTROLS)
MUTATION_FAULT_IDS = ("runner_service_restart", *TEST_CONTROLS)


def canonical(value: object) -> bytes:
    return (json.dumps(value, separators=(",", ":")) + "\n").encode("utf-8")


def common() -> list[str]:
    return [
        "--project", "learncoding",
        "--runner-vm-id", VM_ID,
        "--runner-vm-mac", VM_MAC,
    ]


def target_arguments(fault_id: str) -> list[str]:
    if fault_id in SERVICE_TARGETS:
        return ["compose-service", SERVICE_TARGETS[fault_id]]
    if fault_id == "runner_service_restart":
        return ["runner-service", "codestead-runner", "learncoding-runner.service"]
    return ["test-control", fault_id]


def target_object(fault_id: str) -> dict[str, object]:
    if fault_id in SERVICE_TARGETS:
        return {"kind": "compose-service", "service": SERVICE_TARGETS[fault_id]}
    if fault_id == "runner_service_restart":
        return {
            "kind": "runner-service",
            "domain": "codestead-runner",
            "unit": "learncoding-runner.service",
        }
    return {"kind": "test-control", "control": fault_id}


def mutation_arguments(operation: str, fault_id: str) -> list[str]:
    return [operation, fault_id, *target_arguments(fault_id), *common()]


def wrapper(result: object) -> bytes:
    return canonical({"ok": True, "result": result})


def identity(kind: int, mode: int, *, uid: int = 0, links: int = 1):
    return SimpleNamespace(
        st_mode=kind | mode,
        st_uid=uid,
        st_nlink=links,
        st_dev=7,
        st_ino=11,
    )


class ControlAllowlistTests(unittest.TestCase):
    def test_both_mutations_map_only_runner_and_seven_test_controls(self) -> None:
        for operation in ("reset", "inject-and-release"):
            for fault_id in MUTATION_FAULT_IDS:
                with self.subTest(operation=operation, fault_id=fault_id):
                    requests: list[bytes] = []

                    def exchange(request: bytes) -> bytes:
                        requests.append(request)
                        return wrapper(None)

                    output = HELPER.execute(
                        mutation_arguments(operation, fault_id),
                        exchange,
                    )

                    self.assertEqual(output, b"")
                    self.assertEqual(requests, [canonical({
                        "version": 1,
                        "action": operation,
                        "faultId": fault_id,
                        "target": target_object(fault_id),
                        "project": "learncoding",
                        "runnerVmId": VM_ID,
                        "runnerVmMac": VM_MAC,
                    })])
                    self.assertNotRegex(
                        requests[0].decode("ascii"),
                        r"docker|libvirt|systemctl|https?:|cookie|password|authorization",
                    )

    def test_probes_map_all_fifteen_faults_to_exact_owned_targets(self) -> None:
        result = {"componentHealthy": True, "alertOrDeadLetterVisible": False}
        for fault_id in FAULT_IDS:
            with self.subTest(fault_id=fault_id):
                requests: list[bytes] = []

                def exchange(request: bytes) -> bytes:
                    requests.append(request)
                    return wrapper(result)

                output = HELPER.execute(
                    [
                        "probe",
                        fault_id,
                        *target_arguments(fault_id),
                        "--phase",
                        "baseline",
                        *common(),
                    ],
                    exchange,
                )

                self.assertEqual(output, canonical(result))
                self.assertEqual(requests, [canonical({
                    "version": 1,
                    "action": "probe",
                    "faultId": fault_id,
                    "target": target_object(fault_id),
                    "phase": "baseline",
                    "project": "learncoding",
                    "runnerVmId": VM_ID,
                    "runnerVmMac": VM_MAC,
                })])

    def test_service_mutations_are_not_part_of_the_control_helper_surface(self) -> None:
        for fault_id in SERVICE_TARGETS:
            with self.subTest(fault_id=fault_id):
                with self.assertRaises(HELPER.ContractError):
                    HELPER.execute(mutation_arguments("reset", fault_id), lambda _request: wrapper(None))

    def test_status_and_telemetry_operations_use_exact_bounded_protocols(self) -> None:
        cases = (
            (
                [
                    "isolation-status",
                    "--project", "learncoding",
                    "--repository-root", "/opt/learncoding",
                    "--runner-state-root", "/var/lib/learncoding-runner",
                    "--runner-vm-id", VM_ID,
                    "--runner-vm-mac", VM_MAC,
                ],
                {
                    "version": 1,
                    "action": "isolation-status",
                    "project": "learncoding",
                    "repositoryRoot": "/opt/learncoding",
                    "runnerStateRoot": "/var/lib/learncoding-runner",
                    "runnerVmId": VM_ID,
                    "runnerVmMac": VM_MAC,
                },
                {"maintenanceWindowApproved": True, "freshRecoveryPoint": True},
            ),
            (
                ["host-telemetry", "--project", "learncoding"],
                {"version": 1, "action": "host-telemetry", "project": "learncoding"},
                {
                    "hostCpuPercent": 12.5,
                    "availableMemoryBytes": 1024,
                    "rootFreeFraction": 0.5,
                    "rootFreeBytes": 2048,
                    "diskReadBytes": 3,
                    "diskWriteBytes": 4,
                    "temperatureCelsius": 51.0,
                    "oomKills": 0,
                    "thermalThrottleIncrements": 0,
                },
            ),
            (
                [
                    "runner-vm-telemetry",
                    "--runner-domain", "codestead-runner",
                    "--runner-vm-id", VM_ID,
                    "--runner-vm-mac", VM_MAC,
                ],
                {
                    "version": 1,
                    "action": "runner-vm-telemetry",
                    "runnerDomain": "codestead-runner",
                    "runnerVmId": VM_ID,
                    "runnerVmMac": VM_MAC,
                },
                {"runnerVmCpuPercent": 9.5, "runnerVmAvailableMemoryBytes": 4096},
            ),
        )
        for argv, expected_request, result in cases:
            with self.subTest(action=argv[0]):
                requests: list[bytes] = []

                def exchange(request: bytes) -> bytes:
                    requests.append(request)
                    return wrapper(result)

                output = HELPER.execute(argv, exchange)

                self.assertEqual(requests, [canonical(expected_request)])
                self.assertEqual(output, canonical(result))

    def test_probe_and_invariant_operations_preserve_only_exact_evidence(self) -> None:
        probe_arguments = [
            "probe", "quota_volume_near_full",
            "test-control", "quota_volume_near_full",
            "--phase", "recovery",
            *common(),
        ]
        probe_result = {"componentHealthy": True, "alertOrDeadLetterVisible": False}
        probe_requests: list[bytes] = []
        probe_output = HELPER.execute(
            probe_arguments,
            lambda request: probe_requests.append(request) or wrapper(probe_result),
        )
        self.assertEqual(probe_requests, [canonical({
            "version": 1,
            "action": "probe",
            "faultId": "quota_volume_near_full",
            "target": target_object("quota_volume_near_full"),
            "phase": "recovery",
            "project": "learncoding",
            "runnerVmId": VM_ID,
            "runnerVmMac": VM_MAC,
        })])
        self.assertEqual(probe_output, canonical(probe_result))

        invariant_arguments = [
            "invariant-evidence", "app_container_restart",
            "compose-service", "app",
            *common(),
        ]
        invariant_result = {
            "observedAt": "2026-07-20T12:00:00.000Z",
            "acknowledgedMutationFailures": 0,
            "runnerMaxConcurrentJobs": 2,
            "secretLeakFindings": 0,
        }
        invariant_requests: list[bytes] = []
        invariant_output = HELPER.execute(
            invariant_arguments,
            lambda request: invariant_requests.append(request) or wrapper(invariant_result),
        )
        self.assertEqual(invariant_requests, [canonical({
            "version": 1,
            "action": "invariant-evidence",
            "faultId": "app_container_restart",
            "target": target_object("app_container_restart"),
            "project": "learncoding",
            "runnerVmId": VM_ID,
            "runnerVmMac": VM_MAC,
        })])
        self.assertEqual(invariant_output, canonical(invariant_result))

    def test_invalid_identity_target_phase_or_extra_arguments_fail_before_io(self) -> None:
        base = mutation_arguments("inject-and-release", "app_container_restart")
        invalid = (
            [*base[:-1], "52:54:00:00:00:01"],
            [*base[:-5], "other", *base[-4:]],
            [*base[:-3], "not-a-uuid", *base[-2:]],
            [base[0], base[1], "compose-service", "postgres", *base[4:]],
            [*base, "--extra"],
            mutation_arguments("inject-and-release", "unknown_fault"),
            [
                "probe", "app_container_restart", "compose-service", "app",
                "--phase", "during", *common(),
            ],
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

    def test_malformed_noncanonical_oversized_or_secret_bearing_response_is_rejected(self) -> None:
        argv = ["host-telemetry", "--project", "learncoding"]
        valid = {
            "hostCpuPercent": 12.5,
            "availableMemoryBytes": 1024,
            "rootFreeFraction": 0.5,
            "rootFreeBytes": 2048,
            "diskReadBytes": 3,
            "diskWriteBytes": 4,
            "temperatureCelsius": 51.0,
            "oomKills": 0,
            "thermalThrottleIncrements": 0,
        }
        malformed = (
            b"not-json\n",
            b'{"ok": true, "result": null}\n',
            canonical({"ok": True, "result": {**valid, "logs": "secret-bearing"}}),
            canonical({"ok": True, "result": {**valid, "hostCpuPercent": 101}}),
            canonical({"ok": False, "result": valid}),
            b"a" * (HELPER.MAXIMUM_MESSAGE_BYTES + 1),
        )
        for raw in malformed:
            with self.subTest(raw=raw[:80]):
                with self.assertRaises(HELPER.ContractError):
                    HELPER.execute(argv, lambda _request, raw=raw: raw)

    def test_main_redacts_transport_exception(self) -> None:
        stdout = io.BytesIO()
        stderr = io.StringIO()

        def exchange(_request: bytes) -> bytes:
            raise RuntimeError("authorization=provider-secret-token")

        status = HELPER.main(
            ["host-telemetry", "--project", "learncoding"],
            exchange,
            stdout,
            stderr,
        )

        self.assertEqual(status, 70)
        self.assertEqual(stdout.getvalue(), b"")
        self.assertEqual(stderr.getvalue(), "production-load-control: failed\n")
        self.assertNotRegex(stderr.getvalue(), r"authorization|provider|secret|token")

    def test_socket_path_requires_root_owned_nonwritable_chain_and_root_only_socket(self) -> None:
        safe = {
            "/run": identity(stat.S_IFDIR, 0o755, links=4),
            "/run/learncoding": identity(stat.S_IFDIR, 0o700, links=2),
            HELPER.SOCKET_PATH: identity(stat.S_IFSOCK, 0o600),
        }
        self.assertEqual(HELPER.validate_socket_path(lambda target: safe[target]), (7, 11))

        for paths in (
            {**safe, "/run/learncoding": identity(stat.S_IFLNK, 0o777)},
            {**safe, "/run/learncoding": identity(stat.S_IFDIR, 0o777)},
            {**safe, HELPER.SOCKET_PATH: identity(stat.S_IFSOCK, 0o600, uid=1000)},
            {**safe, HELPER.SOCKET_PATH: identity(stat.S_IFSOCK, 0o660)},
            {**safe, HELPER.SOCKET_PATH: identity(stat.S_IFSOCK, 0o600, links=2)},
        ):
            with self.subTest(paths=paths):
                with self.assertRaises(HELPER.ContractError):
                    HELPER.validate_socket_path(lambda target, paths=paths: paths[target])


if __name__ == "__main__":
    unittest.main()
