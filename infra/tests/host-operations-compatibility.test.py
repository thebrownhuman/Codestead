from __future__ import annotations

import copy
import importlib.util
import os
from pathlib import Path
import subprocess
import sys
import unittest
from unittest import mock


ROOT = Path(__file__).resolve().parents[2]
HELPER_PATH = ROOT / "infra" / "ops" / "host-operations-compatibility.py"
spec = importlib.util.spec_from_file_location("host_operations_compatibility", HELPER_PATH)
if spec is None or spec.loader is None:
    raise RuntimeError("unable to load host operations compatibility helper")
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)


BASE_MODEL = {
    "services": {
        "app": {
            "image": "registry.example.test/codestead/runtime@sha256:" + "1" * 64,
            "command": ["node", "server.js"],
            "entrypoint": ["/usr/local/bin/entrypoint"],
            "environment": {
                "AUTH_REQUIRED": "true",
                "DATABASE_URL_FILE": "/run/secrets/database_app_url",
                "SECRET_VALUE": "must-not-enter-evidence",
                "UPLOADS_ENABLED": "false",
            },
            "volumes": [
                {
                    "type": "bind",
                    "source": "/srv/learncoding/app-data/objects",
                    "target": "/var/lib/learncoding/objects",
                    "read_only": False,
                }
            ],
            "networks": {
                "data": None,
                "frontend": {"interface_name": "frontend", "gw_priority": 100},
            },
            "secrets": [{"source": "database_app_url", "target": "database_app_url"}],
            "read_only": True,
            "cap_drop": ["ALL"],
            "security_opt": ["no-new-privileges:true"],
            "restart": "unless-stopped",
        },
        "cloudflared": {
            "image": "cloudflare/cloudflared@sha256:" + "2" * 64,
            "command": ["tunnel", "run"],
            "environment": {},
            "networks": {"frontend": None},
        },
        "postgres": {
            "image": "postgres@sha256:" + "3" * 64,
            "environment": {},
            "networks": {"data": None},
        },
    },
    "networks": {
        "data": {"internal": True},
        "frontend": {"driver": "bridge"},
    },
    "volumes": {},
    "secrets": {
        "database_app_url": {"file": "/etc/learncoding/secrets/database_app_url"},
    },
    "configs": {},
}

BASE_BLOBS = {
    "infra/ops/ingress-control.py": ("100644", b"ingress-v1\n"),
    "infra/ops/package-release-tree.py": ("100755", b"packager-v1\n"),
    "infra/ops/prepare-object-storage.mjs": ("100644", b"objects-v1\n"),
    "infra/ops/prepare-postgres-control-socket.sh": ("100755", b"postgres-v1\n"),
    "infra/ops/smoke-production.sh": ("100755", b"smoke-v1\n"),
    "infra/ops/validate-runtime.sh": ("100755", b"validate-v1\n"),
    "infra/runner-vm/host-runner.nft": ("100644", b"policy-v1\n"),
}


class HostOperationsCompatibilityTests(unittest.TestCase):
    def digest(self, model=BASE_MODEL, blobs=BASE_BLOBS):
        return helper.contract_digest(model, blobs)

    def test_sensitive_environment_values_are_redacted_but_policy_values_are_bound(self):
        changed_secret = copy.deepcopy(BASE_MODEL)
        changed_secret["services"]["app"]["environment"]["SECRET_VALUE"] = "different-secret"
        self.assertEqual(self.digest(), self.digest(changed_secret))
        surface = helper.canonical_semantic_surface(BASE_MODEL)
        serialized = helper.canonical_json_bytes(surface)
        self.assertNotIn(b"must-not-enter-evidence", serialized)
        self.assertEqual(
            surface["services"]["app"]["environment"]["SECRET_VALUE"],
            "<sensitive-present>",
        )

        for name, changed_value in (
            ("AUTH_REQUIRED", "false"),
            ("UPLOADS_ENABLED", "true"),
            ("DATABASE_URL_FILE", "/run/secrets/different_database_url"),
        ):
            with self.subTest(name=name):
                changed_policy = copy.deepcopy(BASE_MODEL)
                changed_policy["services"]["app"]["environment"][name] = changed_value
                self.assertNotEqual(self.digest(), self.digest(changed_policy))

        changed_name = copy.deepcopy(BASE_MODEL)
        changed_name["services"]["app"]["environment"]["NEW_AUTHORITY"] = "ignored-value"
        self.assertNotEqual(self.digest(), self.digest(changed_name))

    def test_command_drift_changes_the_contract(self):
        changed = copy.deepcopy(BASE_MODEL)
        changed["services"]["app"]["command"] = ["node", "unsafe.js"]
        self.assertNotEqual(self.digest(), self.digest(changed))

    def test_separately_recorded_application_image_drift_is_excluded(self):
        changed = copy.deepcopy(BASE_MODEL)
        changed["services"]["app"]["image"] = (
            "registry.example.test/codestead/runtime@sha256:" + "9" * 64
        )
        self.assertEqual(self.digest(), self.digest(changed))

    def test_infrastructure_image_drift_changes_the_contract(self):
        for service in ("postgres", "cloudflared"):
            with self.subTest(service=service):
                changed = copy.deepcopy(BASE_MODEL)
                changed["services"][service]["image"] = (
                    f"example.invalid/{service}@sha256:" + "8" * 64
                )
                self.assertNotEqual(self.digest(), self.digest(changed))

    def test_mount_drift_changes_the_contract(self):
        changed = copy.deepcopy(BASE_MODEL)
        changed["services"]["app"]["volumes"][0]["source"] = "/"
        self.assertNotEqual(self.digest(), self.digest(changed))

    def test_network_drift_changes_the_contract(self):
        changed = copy.deepcopy(BASE_MODEL)
        changed["networks"]["data"]["internal"] = False
        self.assertNotEqual(self.digest(), self.digest(changed))

    def test_policy_drift_changes_the_contract(self):
        changed = dict(BASE_BLOBS)
        changed["infra/runner-vm/host-runner.nft"] = ("100644", b"policy-v2\n")
        self.assertNotEqual(self.digest(), self.digest(BASE_MODEL, changed))

    def test_operation_mode_and_bytes_are_bound(self):
        changed_mode = dict(BASE_BLOBS)
        changed_mode["infra/ops/smoke-production.sh"] = ("100644", b"smoke-v1\n")
        with self.assertRaises(helper.CompatibilityError):
            self.digest(BASE_MODEL, changed_mode)
        changed_bytes = dict(BASE_BLOBS)
        changed_bytes["infra/ops/smoke-production.sh"] = ("100755", b"smoke-v2\n")
        self.assertNotEqual(self.digest(), self.digest(BASE_MODEL, changed_bytes))

    def test_evidence_separates_host_and_application_provenance(self):
        evidence = helper.compatibility_evidence(
            host_commit="1" * 40,
            host_tree="2" * 40,
            application_commit="3" * 40,
            application_tree="4" * 40,
            contract_sha256="5" * 64,
        )
        self.assertEqual(
            evidence,
            "\n".join(
                (
                    "SCHEMA_VERSION=1",
                    f"CONTRACT_VERSION={helper.CONTRACT_VERSION}",
                    f"HOST_OPERATIONS_GIT_COMMIT={'1' * 40}",
                    f"HOST_OPERATIONS_GIT_TREE={'2' * 40}",
                    f"APPLICATION_GIT_COMMIT={'3' * 40}",
                    f"APPLICATION_GIT_TREE={'4' * 40}",
                    f"HOST_OPERATIONS_CONTRACT_SHA256={'5' * 64}",
                    "RESULT=compatible",
                    "",
                )
            ),
        )

    def test_git_plumbing_uses_a_minimal_non_redirectable_environment(self):
        captured: dict[str, object] = {}

        def fake_run(arguments, **kwargs):
            captured["arguments"] = arguments
            captured["environment"] = kwargs["env"]
            return subprocess.CompletedProcess(arguments, 0, stdout=b"ok\n", stderr=b"")

        poison = {
            "GIT_DIR": "/attacker/repository",
            "GIT_OBJECT_DIRECTORY": "/attacker/objects",
            "GIT_ALTERNATE_OBJECT_DIRECTORIES": "/attacker/alternates",
            "GIT_CONFIG_GLOBAL": "/attacker/config",
            "GIT_CONFIG_COUNT": "1",
            "GIT_CONFIG_KEY_0": "credential.helper",
            "GIT_CONFIG_VALUE_0": "!exfiltrate-secret",
            "UNRELATED_SECRET": "must-not-be-forwarded",
        }
        with mock.patch.dict(os.environ, poison, clear=False), mock.patch.object(
            helper.subprocess, "run", fake_run
        ):
            reader = helper.GitTreeReader(ROOT, Path(sys.executable))
            self.assertEqual(reader._run(["cat-file", "-t", "1" * 40]), b"ok\n")

        environment = captured["environment"]
        self.assertIsInstance(environment, dict)
        assert isinstance(environment, dict)
        for key in poison:
            if key != "GIT_CONFIG_GLOBAL":
                self.assertNotIn(key, environment)
        self.assertEqual(environment["GIT_CONFIG_NOSYSTEM"], "1")
        self.assertEqual(environment["GIT_CONFIG_GLOBAL"], os.devnull)
        self.assertEqual(environment["GIT_NO_LAZY_FETCH"], "1")
        self.assertIn("--no-replace-objects", captured["arguments"])

    def test_compose_renderer_disables_path_and_env_file_resolution(self):
        calls: list[list[str]] = []
        rendered = helper.canonical_json_bytes(BASE_MODEL)

        def fake_run(arguments, **kwargs):
            calls.append(arguments)
            return subprocess.CompletedProcess(arguments, 0, stdout=rendered, stderr=b"")

        with mock.patch.object(helper.subprocess, "run", fake_run):
            renderer = helper.ComposeRenderer(Path(sys.executable))
            first = renderer.render(
                b"services:\n  app:\n    image: example.invalid/app\n", b"A=one\n"
            )
            second = renderer.render(
                b"services:\n  app:\n    image: example.invalid/app\n", b"A=one\n"
            )

        self.assertEqual(first, second)
        self.assertEqual(len(calls), 2)
        for arguments in calls:
            self.assertIn("--no-path-resolution", arguments)
            self.assertIn("--no-env-resolution", arguments)
            self.assertEqual(arguments[-2:], ["--format", "json"])
        self.assertNotEqual(
            calls[0][calls[0].index("-f") + 1], calls[1][calls[1].index("-f") + 1]
        )

    def test_git_tree_reader_rejects_symlinks_submodules_and_tree_mismatch(self):
        reader = helper.GitTreeReader(ROOT, Path(sys.executable))
        object_id = "a" * 40
        path = "infra/ops/smoke-production.sh"
        for listing in (
            f"120000 blob {object_id}\t{path}\0".encode(),
            f"160000 commit {object_id}\t{path}\0".encode(),
        ):
            with self.subTest(listing=listing[:6]), mock.patch.object(
                reader, "_run", return_value=listing
            ):
                with self.assertRaises(helper.CompatibilityError):
                    reader.read_blob("b" * 40, path, "100755")
        with mock.patch.object(
            reader,
            "_run",
            side_effect=(b"commit\n", b"tree\n", ("c" * 40 + "\n").encode()),
        ):
            with self.assertRaises(helper.CompatibilityError):
                reader.verify_commit_tree("d" * 40, "e" * 40)


if __name__ == "__main__":
    unittest.main()
