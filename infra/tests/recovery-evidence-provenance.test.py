#!/usr/bin/python3
"""Provenance and health-binding contracts for recovery evidence."""

from __future__ import annotations

import hashlib
import importlib.util
import json
from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[2]
HELPER = ROOT / "infra" / "ops" / "recovery-evidence.py"
specification = importlib.util.spec_from_file_location("recovery_evidence", HELPER)
if specification is None or specification.loader is None:
    raise AssertionError("production recovery-evidence helper is not importable")
helper = importlib.util.module_from_spec(specification)
specification.loader.exec_module(helper)

HEX_A = "a" * 64
HEX_B = "b" * 64
HEX_C = "c" * 64
HEX_D = "d" * 64
HEX_E = "e" * 64
HEX_F = "f" * 64
GIT = "1" * 40
GIT_TREE = "2" * 40
CAPTURED_AT = "2026-07-19T12:00:00Z"


def backup_evidence() -> dict[str, str]:
    return {
        "archive": "learncoding-full-20260719T115900Z.tar.gz.age",
        "completedAtUtc": "20260719T115901Z",
        "sha256": "4" * 64,
    }


def active_release_bytes() -> bytes:
    return (
        "SCHEMA_VERSION=1\n"
        f"GIT_COMMIT={GIT}\n"
        f"GIT_TREE={GIT_TREE}\n"
        f"RELEASE_MANIFEST_SHA256={HEX_A}\n"
        f"APPLICATION_IMAGE_RECORD_SHA256={HEX_F}\n"
        "COMPOSE_PROJECT=learncoding\n"
        "COMPOSE_WORKDIR=/opt/learncoding\n"
        "PUBLIC_ORIGIN=https://pilot.example.test\n"
        f"MANAGED_INVENTORY_SHA256={HEX_B}\n"
        f"FIREWALL_POLICY_SHA256={HEX_C}\n"
        f"RUNNER_GUEST_RELEASE_SHA256={HEX_D}\n"
        f"RUNNER_RUNTIME_IMAGES_SHA256={HEX_E}\n"
    ).encode("ascii")


def active_release_identity() -> dict[str, str]:
    return {
        "applicationImageRecordSha256": HEX_F,
        "composeProject": "learncoding",
        "composeWorkdir": "/opt/learncoding",
        "firewallPolicySha256": HEX_C,
        "gitCommit": GIT,
        "gitTree": GIT_TREE,
        "inventorySha256": HEX_B,
        "manifestSha256": HEX_A,
        "publicOrigin": "https://pilot.example.test",
        "runnerGuestReleaseSha256": HEX_D,
        "runnerRuntimeImagesSha256": HEX_E,
    }


SERVICES = (
    "app",
    "cloudflared",
    "exam-finalization-worker",
    "mail-worker",
    "postgres",
    "practice-runner-recovery-worker",
    "project-review-correction-worker",
    "regrade-worker",
    "reward-worker",
    "runner-egress-gateway",
)


def inventory_bytes() -> bytes:
    return "".join(
        f"{service}\tlearncoding-{service}-1\tregistry.invalid/codestead/{service}@sha256:{'2' * 64}\tsha256:{'3' * 64}\n"
        for service in SERVICES
    ).encode("ascii")


def container_inspection(service: str) -> bytes:
    return json.dumps(
        [
            {
                "Name": f"/learncoding-{service}-1",
                "Image": f"sha256:{'3' * 64}",
                "RestartCount": 1,
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
        ],
        separators=(",", ":"),
        sort_keys=True,
    ).encode("ascii") + b"\n"


def firewall_json() -> bytes:
    return json.dumps(
        {
            "nftables": [
                {"metainfo": {"json_schema_version": 1, "version": "1.0.9"}},
                {"table": {"family": "inet", "handle": 1, "name": "codestead_runner"}},
                {
                    "chain": {
                        "family": "inet", "handle": 1, "hook": "forward", "name": "forward",
                        "policy": "accept", "prio": 10, "table": "codestead_runner", "type": "filter",
                    }
                },
                {
                    "rule": {
                        "chain": "forward", "family": "inet", "handle": 2, "table": "codestead_runner",
                        "expr": [
                            {"match": {"left": {"meta": {"key": "iifname"}}, "op": "==", "right": "cdst-run0"}},
                            {"match": {"left": {"payload": {"field": "saddr", "protocol": "ip"}}, "op": "==", "right": "172.29.40.2"}},
                            {"match": {"left": {"payload": {"field": "daddr", "protocol": "ip"}}, "op": "==", "right": "192.168.122.12"}},
                            {"match": {"left": {"payload": {"field": "dport", "protocol": "tcp"}}, "op": "==", "right": 4100}},
                            {"accept": None},
                        ],
                    }
                },
                {
                    "rule": {
                        "chain": "forward", "family": "inet", "handle": 3, "table": "codestead_runner",
                        "expr": [
                            {"match": {"left": {"meta": {"key": "iifname"}}, "op": "==", "right": "cdst-run0"}},
                            {"drop": None},
                        ],
                    }
                },
                {
                    "rule": {
                        "chain": "forward", "family": "inet", "handle": 4, "table": "codestead_runner",
                        "expr": [
                            {"match": {"left": {"payload": {"field": "daddr", "protocol": "ip"}}, "op": "==", "right": "192.168.122.12"}},
                            {"match": {"left": {"payload": {"field": "dport", "protocol": "tcp"}}, "op": "==", "right": 4100}},
                            {"drop": None},
                        ],
                    }
                },
                {
                    "rule": {
                        "chain": "forward", "family": "inet", "handle": 5, "table": "codestead_runner",
                        "expr": [
                            {"match": {"left": {"meta": {"key": "oifname"}}, "op": "==", "right": "virbr0"}},
                            {"match": {"left": {"meta": {"key": "l4proto"}}, "op": "==", "right": "tcp"}},
                            {"match": {"left": {"payload": {"field": "dport", "protocol": "tcp"}}, "op": "==", "right": 4100}},
                            {"drop": None},
                        ],
                    }
                },
                {
                    "rule": {
                        "chain": "forward", "family": "inet", "handle": 6, "table": "codestead_runner",
                        "expr": [
                            {"match": {"left": {"ct": {"key": "state"}}, "op": "in", "right": ["established", "related"]}},
                            {"accept": None},
                        ],
                    }
                },
            ]
        },
        separators=(",", ":"),
        sort_keys=True,
    ).encode("ascii") + b"\n"


class ActiveReleaseTests(unittest.TestCase):
    def test_exact_active_release_is_accepted(self) -> None:
        release = helper.parse_active_release(active_release_bytes())
        self.assertEqual(release.git_commit, GIT)
        self.assertEqual(release.git_tree, GIT_TREE)
        self.assertEqual(release.application_image_record_sha256, HEX_F)
        self.assertEqual(release.public_origin, "https://pilot.example.test")
        self.assertEqual(release.compose_workdir, "/opt/learncoding")

    def test_duplicate_unknown_or_noncanonical_release_field_is_rejected(self) -> None:
        for mutation in (
            active_release_bytes() + b"GIT_COMMIT=" + GIT.encode("ascii") + b"\n",
            active_release_bytes() + b"UNREVIEWED=value\n",
            active_release_bytes().replace(b"PUBLIC_ORIGIN=https://", b"PUBLIC_ORIGIN=http://"),
            active_release_bytes().replace(b"COMPOSE_PROJECT=learncoding", b"COMPOSE_PROJECT=other"),
        ):
            with self.subTest(mutation=mutation[-50:]):
                with self.assertRaises(helper.ContractError):
                    helper.parse_active_release(mutation)


class ManagedInventoryTests(unittest.TestCase):
    def test_inventory_binds_every_exact_pilot_container(self) -> None:
        raw = inventory_bytes()
        records = helper.parse_managed_inventory(raw, hashlib.sha256(raw).hexdigest())
        self.assertEqual(tuple(record.service for record in records), SERVICES)
        for record in records:
            observed = helper.validate_container_inspection(
                container_inspection(record.service), record, "learncoding", "/opt/learncoding"
            )
            self.assertTrue(observed["healthy"])

    def test_any_runtime_identity_or_compose_label_drift_is_rejected(self) -> None:
        raw = inventory_bytes()
        record = helper.parse_managed_inventory(raw, hashlib.sha256(raw).hexdigest())[0]
        baseline = container_inspection(record.service)
        for old, new in (
            (b'"Image":"sha256:', b'"Image":"sha256:9'),
            (b'"Running":true', b'"Running":false'),
            (b'"Status":"healthy"', b'"Status":"unhealthy"'),
            (b'"com.docker.compose.project":"learncoding"', b'"com.docker.compose.project":"other"'),
            (b'"com.docker.compose.project.working_dir":"/opt/learncoding"', b'"com.docker.compose.project.working_dir":"/tmp"'),
        ):
            candidate = baseline.replace(old, new, 1)
            with self.subTest(old=old):
                with self.assertRaises(helper.ContractError):
                    helper.validate_container_inspection(candidate, record, "learncoding", "/opt/learncoding")


class FirewallEvidenceTests(unittest.TestCase):
    def test_exact_active_host_policy_is_accepted(self) -> None:
        canonical = helper.validate_firewall_rules(firewall_json())
        self.assertEqual(canonical["ruleCount"], 5)

    def assert_firewall_rejected(self, value: dict[str, object]) -> None:
        with self.assertRaises(helper.ContractError):
            helper.validate_firewall_rules(
                (json.dumps(value, separators=(",", ":"), sort_keys=True) + "\n").encode("ascii")
            )

    def test_missing_exact_source_allow_is_rejected(self) -> None:
        value = json.loads(firewall_json())
        del value["nftables"][3]
        self.assert_firewall_rejected(value)

    def test_missing_same_interface_drop_is_rejected(self) -> None:
        value = json.loads(firewall_json())
        del value["nftables"][4]
        self.assert_firewall_rejected(value)

    def test_broad_runner_egress_source_is_rejected(self) -> None:
        value = json.loads(firewall_json())
        value["nftables"][3]["rule"]["expr"][1]["match"]["right"] = {
            "prefix": {"addr": "172.29.40.0", "len": 24}
        }
        self.assert_firewall_rejected(value)

    def test_reordered_rules_are_rejected(self) -> None:
        value = json.loads(firewall_json())
        value["nftables"][-1], value["nftables"][-2] = value["nftables"][-2], value["nftables"][-1]
        self.assert_firewall_rejected(value)

    def test_extra_rule_is_rejected(self) -> None:
        value = json.loads(firewall_json())
        value["nftables"].append(value["nftables"][-1])
        self.assert_firewall_rejected(value)


class PairBindingTests(unittest.TestCase):
    def test_post_binds_pre_checksum_event_release_and_prior_boot(self) -> None:
        target = helper.validate_destination(
            "post", "/var/lib/learncoding/recovery-evidence/power-20260719.post.json"
        )
        pre = (
            json.dumps(
                {
                    "backup": backup_evidence(),
                    "bootId": "11111111-2222-3333-4444-555555555555",
                    "capturedAtUtc": CAPTURED_AT,
                    "eventId": target.event_id,
                    "phase": "pre",
                    "release": active_release_identity(),
                    "schemaVersion": 2,
                },
                separators=(",", ":"),
                sort_keys=True,
            )
            + "\n"
        ).encode("ascii")
        digest = hashlib.sha256(pre).hexdigest()
        checksum = f"{digest}  {target.pre_json.name}\n".encode("ascii")
        self.assertEqual(
            helper.validate_pre_pair(
                target,
                pre,
                checksum,
                helper.parse_active_release(active_release_bytes()),
                "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
            ),
            (digest, backup_evidence()),
        )

    def test_same_boot_or_wrong_release_is_rejected(self) -> None:
        target = helper.validate_destination(
            "post", "/var/lib/learncoding/recovery-evidence/power-20260719.post.json"
        )
        active = helper.parse_active_release(active_release_bytes())
        pre = (
            json.dumps(
                {
                    "backup": backup_evidence(),
                    "bootId": "11111111-2222-3333-4444-555555555555",
                    "capturedAtUtc": CAPTURED_AT,
                    "eventId": target.event_id,
                    "phase": "pre",
                    "release": active_release_identity(),
                    "schemaVersion": 2,
                },
                separators=(",", ":"),
                sort_keys=True,
            )
            + "\n"
        ).encode("ascii")
        checksum = f"{hashlib.sha256(pre).hexdigest()}  {target.pre_json.name}\n".encode("ascii")
        with self.assertRaises(helper.ContractError):
            helper.validate_pre_pair(
                target,
                pre,
                checksum,
                active,
                "11111111-2222-3333-4444-555555555555",
            )

        noncanonical = pre[:-1] + b" \n"
        noncanonical_checksum = (
            f"{hashlib.sha256(noncanonical).hexdigest()}  {target.pre_json.name}\n".encode("ascii")
        )
        with self.assertRaises(helper.ContractError):
            helper.validate_pre_pair(
                target, noncanonical, noncanonical_checksum, active,
                "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
            )

        for field in active_release_identity():
            wrong_identity = active_release_identity()
            wrong_identity[field] = "tampered"
            wrong_pre = (
                json.dumps(
                    {
                        "backup": backup_evidence(),
                        "bootId": "11111111-2222-3333-4444-555555555555",
                        "capturedAtUtc": CAPTURED_AT,
                        "eventId": target.event_id,
                        "phase": "pre",
                        "release": wrong_identity,
                        "schemaVersion": 2,
                    },
                    separators=(",", ":"), sort_keys=True,
                ) + "\n"
            ).encode("ascii")
            wrong_checksum = (
                f"{hashlib.sha256(wrong_pre).hexdigest()}  {target.pre_json.name}\n".encode("ascii")
            )
            with self.subTest(field=field), self.assertRaises(helper.ContractError):
                helper.validate_pre_pair(
                    target,
                    wrong_pre,
                    wrong_checksum,
                    active,
                    "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
                )

    def test_missing_stale_or_future_backup_binding_is_rejected(self) -> None:
        target = helper.validate_destination(
            "post", "/var/lib/learncoding/recovery-evidence/power-20260719.post.json"
        )
        active = helper.parse_active_release(active_release_bytes())
        baseline = {
            "backup": backup_evidence(),
            "bootId": "11111111-2222-3333-4444-555555555555",
            "capturedAtUtc": CAPTURED_AT,
            "eventId": target.event_id,
            "phase": "pre",
            "release": active_release_identity(),
            "schemaVersion": 2,
        }
        candidates: list[dict[str, object]] = []
        missing_backup = dict(baseline)
        missing_backup.pop("backup")
        candidates.append(missing_backup)
        missing_capture = dict(baseline)
        missing_capture.pop("capturedAtUtc")
        candidates.append(missing_capture)
        stale = dict(baseline)
        stale["backup"] = {
            "archive": "learncoding-full-20260719T050000Z.tar.gz.age",
            "completedAtUtc": "20260719T050001Z",
            "sha256": "4" * 64,
        }
        candidates.append(stale)
        future = dict(baseline)
        future["backup"] = {
            "archive": "learncoding-full-20260719T121000Z.tar.gz.age",
            "completedAtUtc": "20260719T121001Z",
            "sha256": "4" * 64,
        }
        candidates.append(future)
        malformed_capture = dict(baseline)
        malformed_capture["capturedAtUtc"] = "2026-07-19 12:00:00Z"
        candidates.append(malformed_capture)

        for candidate in candidates:
            raw = (json.dumps(candidate, separators=(",", ":"), sort_keys=True) + "\n").encode("ascii")
            checksum = f"{hashlib.sha256(raw).hexdigest()}  {target.pre_json.name}\n".encode("ascii")
            with self.subTest(fields=tuple(sorted(candidate))):
                with self.assertRaises(helper.ContractError):
                    helper.validate_pre_pair(
                        target, raw, checksum, active,
                        "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
                    )


if __name__ == "__main__":
    unittest.main(verbosity=2)
