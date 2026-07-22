#!/usr/bin/python3
"""Behavioral orchestration contracts for complete recovery evidence."""

from __future__ import annotations

import hashlib
import importlib.util
import json
from pathlib import Path
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[2]
HELPER = ROOT / "infra" / "ops" / "recovery-evidence.py"
specification = importlib.util.spec_from_file_location("recovery_evidence_collection", HELPER)
if specification is None or specification.loader is None:
    raise AssertionError("production recovery-evidence helper is not importable")
helper = importlib.util.module_from_spec(specification)
specification.loader.exec_module(helper)

HEX_A = "a" * 64
HEX_C = "c" * 64
HEX_D = "d" * 64
HEX_E = "e" * 64
GIT = "1" * 40
GIT_TREE = "2" * 40
SERVICES = helper.PILOT_SERVICES


def canonical(value) -> bytes:
    return (json.dumps(value, separators=(",", ":"), sort_keys=True) + "\n").encode("ascii")


def healthy_recovery() -> bytes:
    value = {
        "appHealthy": True,
        "cloudflaredHealthy": True,
        "dockerHealthy": True,
        "elapsedSeconds": 41,
        "existingContainersExpected": 9,
        "existingContainersRunning": 9,
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
    }
    return canonical(value)


def inventory() -> bytes:
    return "".join(
        f"{service}\tlearncoding-{service}-1\tregistry.invalid/codestead/{service}@sha256:{'2' * 64}\tsha256:{'3' * 64}\n"
        for service in SERVICES
    ).encode("ascii")


def active_release(
    inventory_bytes: bytes, firewall_bytes: bytes, release_manifest: bytes, application_record: bytes
) -> bytes:
    return (
        "SCHEMA_VERSION=1\n"
        f"GIT_COMMIT={GIT}\n"
        f"GIT_TREE={GIT_TREE}\n"
        f"RELEASE_MANIFEST_SHA256={hashlib.sha256(release_manifest).hexdigest()}\n"
        f"APPLICATION_IMAGE_RECORD_SHA256={hashlib.sha256(application_record).hexdigest()}\n"
        "COMPOSE_PROJECT=learncoding\n"
        "COMPOSE_WORKDIR=/opt/learncoding\n"
        "PUBLIC_ORIGIN=https://pilot.example.test\n"
        f"MANAGED_INVENTORY_SHA256={hashlib.sha256(inventory_bytes).hexdigest()}\n"
        f"FIREWALL_POLICY_SHA256={hashlib.sha256(firewall_bytes).hexdigest()}\n"
        f"RUNNER_GUEST_RELEASE_SHA256={HEX_D}\n"
        f"RUNNER_RUNTIME_IMAGES_SHA256={HEX_E}\n"
    ).encode("ascii")


def container_inspection(service: str) -> bytes:
    return canonical(
        [
            {
                "Name": f"/learncoding-{service}-1",
                "Image": f"sha256:{'3' * 64}",
                "RestartCount": 0,
                "State": {"Running": True, "Status": "running", "Health": {"Status": "healthy"}},
                "Config": {
                    "Image": f"registry.invalid/codestead/{service}@sha256:{'2' * 64}",
                    "Labels": {
                        "com.centurylinklabs.watchtower.enable": "false",
                        "com.docker.compose.project": "learncoding",
                        "com.docker.compose.project.working_dir": "/opt/learncoding",
                        "com.docker.compose.service": service,
                    },
                },
            }
        ]
    )


def host_firewall() -> bytes:
    expressions = [
        [
            {"match": {"left": {"meta": {"key": "iifname"}}, "op": "==", "right": "cdst-run0"}},
            {"match": {"left": {"payload": {"field": "saddr", "protocol": "ip"}}, "op": "==", "right": "172.29.40.2"}},
            {"match": {"left": {"payload": {"field": "daddr", "protocol": "ip"}}, "op": "==", "right": "192.168.122.12"}},
            {"match": {"left": {"payload": {"field": "dport", "protocol": "tcp"}}, "op": "==", "right": 4100}},
            {"accept": None},
        ],
        [
            {"match": {"left": {"meta": {"key": "iifname"}}, "op": "==", "right": "cdst-run0"}},
            {"drop": None},
        ],
        [
            {"match": {"left": {"payload": {"field": "daddr", "protocol": "ip"}}, "op": "==", "right": "192.168.122.12"}},
            {"match": {"left": {"payload": {"field": "dport", "protocol": "tcp"}}, "op": "==", "right": 4100}},
            {"drop": None},
        ],
        [
            {"match": {"left": {"meta": {"key": "oifname"}}, "op": "==", "right": "virbr0"}},
            {"match": {"left": {"meta": {"key": "l4proto"}}, "op": "==", "right": "tcp"}},
            {"match": {"left": {"payload": {"field": "dport", "protocol": "tcp"}}, "op": "==", "right": 4100}},
            {"drop": None},
        ],
        [
            {"match": {"left": {"ct": {"key": "state"}}, "op": "in", "right": ["established", "related"]}},
            {"accept": None},
        ],
    ]
    values = [
        {"metainfo": {"json_schema_version": 1}},
        {"table": {"family": "inet", "name": "codestead_runner"}},
        {"chain": {"family": "inet", "hook": "forward", "name": "forward", "policy": "accept", "prio": 10, "table": "codestead_runner", "type": "filter"}},
    ]
    values.extend(
        {"rule": {"chain": "forward", "expr": expression, "family": "inet", "table": "codestead_runner"}}
        for expression in expressions
    )
    return canonical({"nftables": values})


def guest_firewall() -> bytes:
    rules = [
        [{"match": {"left": {"ct": {"key": "state"}}, "op": "in", "right": "invalid"}}, {"drop": None}],
        [{"match": {"left": {"meta": {"key": "iifname"}}, "op": "==", "right": "lo"}}, {"accept": None}],
        [{"match": {"left": {"ct": {"key": "state"}}, "op": "in", "right": ["established", "related"]}}, {"accept": None}],
        [{"match": {"left": {"payload": {"field": "saddr", "protocol": "ip"}}, "op": "==", "right": "192.168.122.1"}}, {"match": {"left": {"payload": {"field": "dport", "protocol": "tcp"}}, "op": "==", "right": 22}}, {"accept": None}],
        [{"match": {"left": {"payload": {"field": "saddr", "protocol": "ip"}}, "op": "==", "right": "192.168.122.1"}}, {"match": {"left": {"payload": {"field": "dport", "protocol": "tcp"}}, "op": "==", "right": 4100}}, {"accept": None}],
        [{"match": {"left": {"payload": {"field": "saddr", "protocol": "ip"}}, "op": "==", "right": "172.29.40.2"}}, {"match": {"left": {"payload": {"field": "dport", "protocol": "tcp"}}, "op": "==", "right": 4100}}, {"accept": None}],
    ]
    values = [
        {"metainfo": {"json_schema_version": 1}},
        {"table": {"family": "inet", "name": "codestead_runner_guest"}},
        {"chain": {"family": "inet", "hook": "input", "name": "input", "policy": "drop", "prio": 0, "table": "codestead_runner_guest", "type": "filter"}},
        {"chain": {"family": "inet", "hook": "output", "name": "output", "policy": "accept", "prio": 0, "table": "codestead_runner_guest", "type": "filter"}},
    ]
    values.extend(
        {"rule": {"chain": "input", "expr": expression, "family": "inet", "table": "codestead_runner_guest"}}
        for expression in rules
    )
    return canonical({"nftables": values})


def mount_evidence(target: str, source: str, options: str) -> bytes:
    return canonical(
        {
            "filesystems": [
                {"fstype": "ext4", "options": options, "source": source, "target": target}
            ]
        }
    )


def block_topology(source: str, disk: str) -> bytes:
    return canonical(
        {
            "blockdevices": [
                {
                    "children": [{"name": disk, "pkname": None, "type": "disk"}],
                    "name": source,
                    "pkname": disk,
                    "type": "part",
                }
            ]
        }
    )


def smart_evidence(device: str) -> bytes:
    return canonical(
        {
            "device": {"name": device, "protocol": "NVMe"},
            "nvme_smart_health_information_log": {"critical_warning": 0, "media_errors": 0},
            "serial_number": "must-not-be-published",
            "smart_status": {"passed": True},
        }
    )


class FixtureHost:
    def __init__(self) -> None:
        self.release_manifest = b"release-manifest\n"
        self.firewall_source = b"reviewed-firewall-source\n"
        self.application_record = b'{"canonical":"application-image-record"}\n'
        self.inventory = inventory()
        self.backup_archive = "learncoding-full-20260719T120000Z.tar.gz.age"
        self.backup_bytes = b"encrypted-recovery-point-fixture\n"
        self.backup_digest = hashlib.sha256(self.backup_bytes).hexdigest()
        self.backup_path = helper.BACKUP_FULL_ROOT / self.backup_archive
        active_bytes = active_release(
            self.inventory, self.firewall_source, self.release_manifest, self.application_record
        )
        self.active = helper.parse_active_release(active_bytes)
        self.files = {
            helper.ACTIVE_RELEASE_PATH: active_bytes,
            helper.managed_inventory_path(self.active): self.inventory,
            helper.RELEASE_MANIFEST_PATH: self.release_manifest,
            helper.application_image_record_path(self.active): self.application_record,
            helper.FIREWALL_POLICY_PATH: self.firewall_source,
            Path("/opt/learncoding/dist/application-images/application-images.json"): (
                b'{"stale-checkout-record":true}\n'
            ),
            helper.BOOT_ID_PATH: b"aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee\n",
            helper.UPTIME_PATH: b"3723.14 100.00\n",
            helper.BACKUP_MARKER_PATH: (
                f"SUCCESS_ARCHIVE={self.backup_archive}\n".encode("ascii")
                + b"SUCCESS_COMPLETED_UTC=20260719T120021Z\n"
                + f"SUCCESS_SHA256={self.backup_digest}\n".encode("ascii")
            ),
            self.backup_path: self.backup_bytes,
            Path(f"{self.backup_path}.sha256"): f"{self.backup_digest}  {self.backup_archive}\n".encode("ascii"),
        }
        self.commands = {
            helper.RECOVERY_COMMAND: healthy_recovery(),
            helper.SMOKE_COMMAND: b"smoke-ok\n",
            helper.HOST_FIREWALL_COMMAND: host_firewall(),
            helper.FAILED_UNITS_COMMAND: b"",
            helper.RUNNER_ADDRESS_COMMAND: b" vnet0  52:54:00:20:00:12  ipv4  192.168.122.12/24\n",
            helper.APPLICATION_MOUNT_COMMAND: mount_evidence("/", "/dev/nvme0n1p2", "rw,relatime"),
            helper.BACKUP_MOUNT_COMMAND: mount_evidence(
                "/mnt/learncoding-backups", "/dev/sdb1", "rw,nodev,nosuid,noexec"
            ),
            helper.lsblk_command("/dev/nvme0n1p2"): block_topology("/dev/nvme0n1p2", "/dev/nvme0n1"),
            helper.lsblk_command("/dev/sdb1"): block_topology("/dev/sdb1", "/dev/sdb"),
            helper.smartctl_command("/dev/nvme0n1"): smart_evidence("/dev/nvme0n1"),
            helper.smartctl_command("/dev/sdb"): smart_evidence("/dev/sdb"),
        }
        for service in SERVICES:
            self.commands[helper.container_inspect_command(f"learncoding-{service}-1")] = container_inspection(service)
        for timer in helper.REQUIRED_TIMERS:
            self.commands[helper.systemctl_command("is-enabled", timer)] = b"enabled\n"
            self.commands[helper.systemctl_command("is-active", timer)] = b"active\n"
        self.guest_commands = {
            helper.systemctl_command("is-enabled", "learncoding-runner.service"): b"enabled\n",
            helper.systemctl_command("is-active", "learncoding-runner.service"): b"active\n",
            helper.systemctl_command("is-enabled", "learncoding-runner-guest-firewall.service"): b"enabled\n",
            helper.systemctl_command("is-active", "learncoding-runner-guest-firewall.service"): b"active\n",
            helper.GUEST_RELEASE_IDENTITY_COMMAND: f"{HEX_D}  /opt/learncoding/RELEASE.SHA256SUMS\n".encode("ascii"),
            helper.GUEST_RUNTIME_IDENTITY_COMMAND: f"{HEX_E}  /opt/learncoding/services/runner/dist/runtime-images.env\n".encode("ascii"),
            helper.GUEST_FIREWALL_COMMAND: guest_firewall(),
        }
        self.executed = []
        self.guest_executed = []

    def read(self, path: Path, maximum: int) -> bytes:
        if path not in self.files:
            raise helper.ContractError("fixture protected input is missing")
        value = self.files[path]
        if len(value) > maximum:
            raise helper.ContractError("fixture read cap exceeded")
        return value

    def hash(self, path: Path) -> str:
        return hashlib.sha256(self.files[path]).hexdigest()

    def execute(self, command, timeout_seconds: int, maximum_bytes: int) -> bytes:
        self.executed.append((command, timeout_seconds, maximum_bytes))
        value = self.commands[command]
        if isinstance(value, Exception):
            raise value
        return value

    def guest_execute(self, command, timeout_seconds: int, maximum_bytes: int) -> bytes:
        self.guest_executed.append((command, timeout_seconds, maximum_bytes))
        value = self.guest_commands[command]
        if isinstance(value, Exception):
            raise value
        return value


class CollectionTests(unittest.TestCase):
    def target(self, phase: str = "pre"):
        return helper.validate_destination(
            phase, f"/var/lib/learncoding/recovery-evidence/power-collection.{phase}.json"
        )

    def test_complete_healthy_evidence_is_release_bound_and_elapsed_after_all_checks(self) -> None:
        host = FixtureHost()
        times = iter((100.1, 165.2))
        payload = helper.collect_snapshot(
            self.target(),
            read_file=host.read,
            hash_file=host.hash,
            execute=host.execute,
            guest_execute=host.guest_execute,
            monotonic=lambda: next(times),
            captured_at=lambda: "2026-07-19T12:00:00Z",
        )
        value = json.loads(payload)
        self.assertEqual(value["schemaVersion"], 2)
        self.assertEqual(
            helper.REQUIRED_TIMERS,
            (
                "learncoding-backup.timer", "learncoding-backup-check.timer",
                "learncoding-offsite-sync.timer", "learncoding-offsite-retention.timer",
                "learncoding-retention.timer", "learncoding-recovery-check.timer",
            ),
        )
        self.assertEqual(value["collectionElapsedSeconds"], 66)
        self.assertEqual(value["release"]["gitCommit"], GIT)
        self.assertEqual(value["release"]["gitTree"], GIT_TREE)
        self.assertEqual(
            value["release"]["applicationImageRecordSha256"], hashlib.sha256(host.application_record).hexdigest()
        )
        self.assertEqual(value["release"]["publicOrigin"], "https://pilot.example.test")
        self.assertIn("runner-egress-gateway", helper.PILOT_SERVICES)
        self.assertEqual(len(value["containers"]), 10)
        self.assertTrue(value["runner"]["representativeJobPassed"])
        self.assertEqual(value["runner"]["guestReleaseSha256"], HEX_D)
        self.assertEqual(value["runner"]["runtimeImagesSha256"], HEX_E)
        self.assertEqual(value["runner"]["address"], "192.168.122.12/24")
        self.assertEqual(set(value["timers"]), set(helper.REQUIRED_TIMERS))
        self.assertEqual(value["failedSystemdUnits"], 0)
        self.assertTrue(value["recovery"]["workersHealthy"])
        self.assertEqual(value["host"]["uptimeSeconds"], 3723)
        self.assertEqual(
            value["backup"],
            {
                "archive": "learncoding-full-20260719T120000Z.tar.gz.age",
                "completedAtUtc": "20260719T120021Z",
                "sha256": host.backup_digest,
            },
        )
        self.assertEqual(value["filesystems"]["application"]["source"], "/dev/nvme0n1p2")
        self.assertEqual(value["filesystems"]["backup"]["target"], "/mnt/learncoding-backups")
        self.assertEqual(len(value["smart"]), 2)
        self.assertTrue(all(item["healthy"] for item in value["smart"]))
        self.assertNotIn("must-not-be-published", payload.decode("ascii"))
        self.assertEqual(
            value["postgres"],
            {
                "checksums": True,
                "durability": {"fsync": "on", "fullPageWrites": "on", "synchronousCommit": "on"},
                "healthy": True,
            },
        )
        self.assertEqual(
            value["virtualization"],
            {"domainActive": True, "domainAutostart": True, "networkActive": True, "networkAutostart": True},
        )
        self.assertNotIn("recoveryTiming", value)

    def test_post_recovery_timing_binds_manual_observations_and_the_900_second_target(self) -> None:
        timing = helper.validate_post_recovery_timing(
            "2026-07-19T11:58:00Z",
            "2026-07-19T12:13:00Z",
            captured_at_utc="2026-07-19T12:13:10Z",
            uptime_at_capture_seconds=890,
        )

        self.assertEqual(
            timing,
            {
                "collectorVerifiedPhysicalPowerCycle": False,
                "operatorObservedPowerRestoredAtUtc": "2026-07-19T11:58:00Z",
                "operatorObservedPublicReadyAtUtc": "2026-07-19T12:13:00Z",
                "publicReadinessSecondsFromPowerRestoration": 900,
                "targetSeconds": 900,
            },
        )

    def test_post_recovery_timing_rejects_missing_future_skewed_reversed_and_late_values(self) -> None:
        cases = {
            "missing-restoration": (None, "2026-07-19T12:05:00Z", "2026-07-19T12:06:00Z", 360),
            "missing-readiness": ("2026-07-19T12:00:00Z", None, "2026-07-19T12:06:00Z", 360),
            "non-canonical": ("2026-07-19 12:00:00Z", "2026-07-19T12:05:00Z", "2026-07-19T12:06:00Z", 360),
            "future-restoration": ("2026-07-19T12:07:00Z", "2026-07-19T12:07:00Z", "2026-07-19T12:06:00Z", 360),
            "future-readiness": ("2026-07-19T12:00:00Z", "2026-07-19T12:07:00Z", "2026-07-19T12:06:00Z", 360),
            "readiness-before-restoration": ("2026-07-19T12:01:00Z", "2026-07-19T12:00:59Z", "2026-07-19T12:06:00Z", 300),
            "late": ("2026-07-19T12:00:00Z", "2026-07-19T12:15:01Z", "2026-07-19T12:16:00Z", 960),
            # At capture the kernel has been up since 12:00:00, so an observed
            # firmware power-on at 12:00:10 is inconsistent rather than proof.
            "clock-skew": ("2026-07-19T12:00:10Z", "2026-07-19T12:05:00Z", "2026-07-19T12:06:00Z", 360),
        }
        for label, (restored, ready, captured, uptime) in cases.items():
            with self.subTest(label=label), self.assertRaises(helper.ContractError):
                helper.validate_post_recovery_timing(
                    restored,
                    ready,
                    captured_at_utc=captured,
                    uptime_at_capture_seconds=uptime,
                )

    def test_cli_rejects_unknown_phase_and_wrong_phase_arity(self) -> None:
        invalid_argv = (
            ["recovery-evidence.py", "unknown"],
            ["recovery-evidence.py", "unknown", "/tmp/evidence.json"],
            ["recovery-evidence.py", "pre", "/tmp/evidence.json", "unexpected"],
            ["recovery-evidence.py", "post", "/tmp/evidence.json"],
        )
        for argv in invalid_argv:
            with self.subTest(argv=argv), patch.object(helper.sys, "argv", argv):
                self.assertEqual(helper.main(), 64)

    def test_every_independent_runtime_drift_blocks_publication_payload(self) -> None:
        mutations = {
            "recovery": lambda host: host.commands.__setitem__(helper.RECOVERY_COMMAND, helper.ContractError("recovery failed")),
            "smoke": lambda host: host.commands.__setitem__(helper.SMOKE_COMMAND, helper.ContractError("smoke failed")),
            "container": lambda host: host.commands.__setitem__(helper.container_inspect_command("learncoding-app-1"), container_inspection("app").replace(b'"healthy"', b'"unhealthy"')),
            "host-firewall": lambda host: host.commands.__setitem__(helper.HOST_FIREWALL_COMMAND, b'{"nftables":[]}\n'),
            "application-image-record": lambda host: host.files.__setitem__(
                helper.application_image_record_path(host.active), b'{"changed":true}\n'
            ),
            "managed-inventory": lambda host: host.files.__setitem__(
                helper.managed_inventory_path(host.active), host.inventory + b"tampered\n"
            ),
            "timer": lambda host: host.commands.__setitem__(helper.systemctl_command("is-enabled", helper.REQUIRED_TIMERS[0]), b"disabled\n"),
            "failed-unit": lambda host: host.commands.__setitem__(helper.FAILED_UNITS_COMMAND, b"failed.service loaded failed failed\n"),
            "address": lambda host: host.commands.__setitem__(helper.RUNNER_ADDRESS_COMMAND, b" vnet0  52:54:00:20:00:12  ipv4  192.168.122.99/24\n"),
            "backup-marker": lambda host: host.files.__setitem__(helper.BACKUP_MARKER_PATH, b"invalid\n"),
            "backup-mount": lambda host: host.commands.__setitem__(
                helper.BACKUP_MOUNT_COMMAND,
                mount_evidence("/mnt/learncoding-backups", "/dev/sdb1", "rw,nodev,nosuid"),
            ),
            "block-topology": lambda host: host.commands.__setitem__(
                helper.lsblk_command("/dev/nvme0n1p2"), b'{"blockdevices":[]}\n'
            ),
            "same-physical-disk": lambda host: host.commands.__setitem__(
                helper.lsblk_command("/dev/sdb1"),
                b'{"blockdevices":[{"name":"/dev/sdb1","pkname":"/dev/nvme0n1","type":"part"},{"name":"/dev/nvme0n1","pkname":null,"type":"disk"}]}\n',
            ),
            "smart": lambda host: host.commands.__setitem__(
                helper.smartctl_command("/dev/nvme0n1"),
                smart_evidence("/dev/nvme0n1").replace(b'"media_errors":0', b'"media_errors":1'),
            ),
            "guest-release": lambda host: host.guest_commands.__setitem__(helper.GUEST_RELEASE_IDENTITY_COMMAND, f"{HEX_C}  /opt/learncoding/RELEASE.SHA256SUMS\n".encode("ascii")),
            "guest-firewall": lambda host: host.guest_commands.__setitem__(helper.GUEST_FIREWALL_COMMAND, b'{"nftables":[]}\n'),
        }
        for label, mutate in mutations.items():
            with self.subTest(label=label):
                host = FixtureHost()
                mutate(host)
                with self.assertRaises(helper.ContractError):
                    helper.collect_snapshot(
                        self.target(),
                        read_file=host.read,
                        hash_file=host.hash,
                        execute=host.execute,
                        guest_execute=host.guest_execute,
                        monotonic=lambda: 100.0,
                        captured_at=lambda: "2026-07-19T12:00:00Z",
                    )

    def test_post_requires_exact_prior_boot_pair_for_same_event_and_release(self) -> None:
        host = FixtureHost()
        target = self.target("post")
        host.files[helper.UPTIME_PATH] = b"55.14 100.00\n"
        release = helper.parse_active_release(host.files[helper.ACTIVE_RELEASE_PATH])
        pre = canonical(
            {
                "backup": {
                    "archive": "learncoding-full-20260719T115800Z.tar.gz.age",
                    "completedAtUtc": "20260719T115821Z",
                    "sha256": "5" * 64,
                },
                "bootId": "11111111-2222-3333-4444-555555555555",
                "capturedAtUtc": "2026-07-19T11:59:00Z",
                "eventId": target.event_id,
                "phase": "pre",
                "release": helper.active_release_identity(release),
                "schemaVersion": 2,
            }
        )
        host.files[target.pre_json] = pre
        host.files[target.pre_checksum] = f"{hashlib.sha256(pre).hexdigest()}  {target.pre_json.name}\n".encode("ascii")
        payload = helper.collect_snapshot(
            target,
            "2026-07-19T11:59:01Z",
            "2026-07-19T11:59:50Z",
            read_file=host.read,
            hash_file=host.hash,
            execute=host.execute,
            guest_execute=host.guest_execute,
            monotonic=lambda: 100.0,
            captured_at=lambda: "2026-07-19T12:00:00Z",
        )
        value = json.loads(payload)
        self.assertEqual(value["preEvidenceSha256"], hashlib.sha256(pre).hexdigest())
        self.assertEqual(
            value["recoveryTiming"],
            {
                "collectorVerifiedPhysicalPowerCycle": False,
                "operatorObservedPowerRestoredAtUtc": "2026-07-19T11:59:01Z",
                "operatorObservedPublicReadyAtUtc": "2026-07-19T11:59:50Z",
                "publicReadinessSecondsFromPowerRestoration": 49,
                "targetSeconds": 900,
            },
        )
        host.files[target.pre_checksum] = b"0" * 64 + b"  wrong.pre.json\n"
        with self.assertRaises(helper.ContractError):
            helper.collect_snapshot(
                target,
                "2026-07-19T11:59:01Z",
                "2026-07-19T11:59:50Z",
                read_file=host.read,
                hash_file=host.hash,
                execute=host.execute,
                guest_execute=host.guest_execute,
                monotonic=lambda: 100.0,
                captured_at=lambda: "2026-07-19T12:00:00Z",
            )

    def test_backup_artifact_freshness_advancement_and_stability_are_fail_closed(self) -> None:
        def collect(host: FixtureHost, captured: str = "2026-07-19T12:00:00Z") -> None:
            helper.collect_snapshot(
                self.target(), read_file=host.read, hash_file=host.hash,
                execute=host.execute, guest_execute=host.guest_execute,
                monotonic=lambda: 100.0, captured_at=lambda: captured,
            )

        stale = FixtureHost()
        with self.assertRaises(helper.ContractError):
            collect(stale, "2026-07-19T20:00:00Z")

        orphan = FixtureHost()
        del orphan.files[Path(f"{orphan.backup_path}.sha256")]
        with self.assertRaises(helper.ContractError):
            collect(orphan)

        mismatched = FixtureHost()
        mismatched.files[Path(f"{mismatched.backup_path}.sha256")] = (
            f"{'0' * 64}  {mismatched.backup_archive}\n".encode("ascii")
        )
        with self.assertRaises(helper.ContractError):
            collect(mismatched)

        future = FixtureHost()
        future_name = "learncoding-full-20260719T130000Z.tar.gz.age"
        future_path = helper.BACKUP_FULL_ROOT / future_name
        future.files[future_path] = future.backup_bytes
        future.files[Path(f"{future_path}.sha256")] = (
            f"{future.backup_digest}  {future_name}\n".encode("ascii")
        )
        future.files[helper.BACKUP_MARKER_PATH] = (
            f"SUCCESS_ARCHIVE={future_name}\n"
            "SUCCESS_COMPLETED_UTC=20260719T130021Z\n"
            f"SUCCESS_SHA256={future.backup_digest}\n"
        ).encode("ascii")
        with self.assertRaises(helper.ContractError):
            collect(future)

        concurrent = FixtureHost()
        original_read = concurrent.read
        marker_reads = 0
        def changing_read(path: Path, maximum: int) -> bytes:
            nonlocal marker_reads
            value = original_read(path, maximum)
            if path == helper.BACKUP_MARKER_PATH:
                marker_reads += 1
                if marker_reads == 2:
                    return value.replace(b"SUCCESS_COMPLETED_UTC=20260719T120021Z", b"SUCCESS_COMPLETED_UTC=20260719T120022Z")
            return value
        with self.assertRaises(helper.ContractError):
            helper.collect_snapshot(
                self.target(), read_file=changing_read, hash_file=concurrent.hash,
                execute=concurrent.execute, guest_execute=concurrent.guest_execute,
                monotonic=lambda: 100.0, captured_at=lambda: "2026-07-19T12:00:00Z",
            )

        unchanged = FixtureHost()
        target = self.target("post")
        unchanged.files[helper.UPTIME_PATH] = b"55.14 100.00\n"
        release = helper.parse_active_release(unchanged.files[helper.ACTIVE_RELEASE_PATH])
        pre = canonical({
            "backup": helper.parse_backup_marker(unchanged.files[helper.BACKUP_MARKER_PATH]),
            "bootId": "11111111-2222-3333-4444-555555555555",
            "capturedAtUtc": "2026-07-19T12:00:00Z",
            "eventId": target.event_id, "phase": "pre",
            "release": helper.active_release_identity(release), "schemaVersion": 2,
        })
        unchanged.files[target.pre_json] = pre
        unchanged.files[target.pre_checksum] = f"{hashlib.sha256(pre).hexdigest()}  {target.pre_json.name}\n".encode("ascii")
        with self.assertRaises(helper.ContractError):
            helper.collect_snapshot(
                target, "2026-07-19T11:59:01Z", "2026-07-19T11:59:50Z",
                read_file=unchanged.read, hash_file=unchanged.hash,
                execute=unchanged.execute, guest_execute=unchanged.guest_execute,
                monotonic=lambda: 100.0, captured_at=lambda: "2026-07-19T12:00:00Z",
            )


if __name__ == "__main__":
    unittest.main(verbosity=2)
