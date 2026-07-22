#!/usr/bin/python3
"""Behavioral tests for deterministic production release-tree packaging."""

from __future__ import annotations

import hashlib
import importlib.util
import json
import os
from datetime import datetime, timezone
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest import mock


ROOT = Path(__file__).resolve().parents[2]
PACKAGER = ROOT / "infra" / "ops" / "package-release-tree.py"

APPLICATION_TARGETS = (
    ("runtime", "APP_RUNTIME_IMAGE"),
    ("tooling", "APP_TOOLING_IMAGE"),
    ("worker", "APP_WORKER_IMAGE"),
    ("regrade-worker", "APP_REGRADE_WORKER_IMAGE"),
    ("project-review-correction-worker", "APP_PROJECT_REVIEW_WORKER_IMAGE"),
    ("scanner-worker", "APP_SCANNER_WORKER_IMAGE"),
    ("operations", "APP_OPERATIONS_IMAGE"),
)
RUNTIME_LANGUAGES = ("c", "cpp", "java", "python", "javascript")


def run(
    command: list[str], *, cwd: Path, check: bool = True,
    environment: dict[str, str] | None = None,
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        command,
        cwd=cwd,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        check=check,
        timeout=30,
        env=environment,
    )


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def content_id(payload: dict[str, object]) -> str:
    encoded = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def load_packager():
    spec = importlib.util.spec_from_file_location("release_tree_packager", PACKAGER)
    if spec is None or spec.loader is None:
        raise AssertionError("release packager is not importable")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class ReleaseTreePackagingTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="codestead-release-package-")
        self.work = Path(self.temporary.name)
        self.source = self.work / "source"
        self.evidence = self.work / "evidence"
        self.source.mkdir()
        self.evidence.mkdir()

        run(["git", "init", "--quiet", "--initial-branch=main"], cwd=self.source)
        run(["git", "config", "user.name", "Codestead test"], cwd=self.source)
        run(["git", "config", "user.email", "codestead-test@example.invalid"], cwd=self.source)
        run(["git", "config", "core.autocrlf", "false"], cwd=self.source)
        run(
            ["git", "remote", "add", "origin", "https://github.com/example/codestead"],
            cwd=self.source,
        )

        (self.source / ".gitignore").write_text(
            "/RELEASE.SHA256SUMS\n/.env\n/node_modules\n/dist\n/services/runner/dist\n",
            encoding="ascii",
            newline="\n",
        )
        (self.source / "README.md").write_text("reviewed source\n", encoding="ascii")
        script = self.source / "infra" / "ops" / "deploy.sh"
        script.parent.mkdir(parents=True)
        script.write_text("#!/usr/bin/env bash\nexit 0\n", encoding="ascii", newline="\n")
        script.chmod(0o755)
        (self.source / "curriculum").mkdir()
        (self.source / "curriculum" / "lesson.json").write_text(
            '{"title":"Variables"}\n', encoding="ascii", newline="\n"
        )
        run(["git", "add", "."], cwd=self.source)
        run(["git", "commit", "--quiet", "-m", "reviewed release"], cwd=self.source)

        self.commit = run(["git", "rev-parse", "HEAD"], cwd=self.source).stdout.strip()
        self.tree = run(["git", "rev-parse", "HEAD^{tree}"], cwd=self.source).stdout.strip()
        generated_at = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
        archive = subprocess.run(
            ["git", "-C", str(self.source), "archive", "--format=tar", self.commit],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=True,
            timeout=30,
        ).stdout
        application_source = {
            "repository": "https://github.com/example/codestead",
            "revision": self.commit,
            "tree": self.tree,
            "contextSha256": hashlib.sha256(archive).hexdigest(),
        }
        application_records = []
        for index, (target, variable) in enumerate(APPLICATION_TARGETS, start=1):
            manifest = f"sha256:{index:064x}"
            application_records.append(
                {
                    "target": target,
                    "variable": variable,
                    "reference": f"registry.example/codestead/{target}@{manifest}",
                    "manifestDigest": manifest,
                    "configDigest": f"sha256:{index + 100:064x}",
                    "rootDigest": manifest,
                    "sourceRepository": application_source["repository"],
                    "sourceRevision": self.commit,
                }
            )
        application_payload = {
            "schemaVersion": 1,
            "generatedAt": generated_at,
            "release": "test",
            "local": True,
            "source": application_source,
            "records": application_records,
        }
        self.application_record_id = content_id(application_payload)
        application_document = {
            "schemaVersion": 1,
            "recordId": self.application_record_id,
            **{key: value for key, value in application_payload.items() if key != "schemaVersion"},
        }

        runtime_records = []
        for index, language in enumerate(RUNTIME_LANGUAGES, start=20):
            manifest = f"sha256:{index:064x}"
            runtime_records.append(
                {
                    "language": language,
                    "reference": f"registry.example/codestead/runner-{language}@{manifest}",
                    "manifestDigest": manifest,
                    "configDigest": f"sha256:{index + 100:064x}",
                    "rootDigest": manifest,
                }
            )
        runtime_payload = {
            "schemaVersion": 1,
            "release": "test",
            "local": True,
            "records": runtime_records,
        }
        self.runtime_record_id = content_id(runtime_payload)
        runtime_document = {
            "schemaVersion": 1,
            "recordId": self.runtime_record_id,
            **{key: value for key, value in runtime_payload.items() if key != "schemaVersion"},
        }

        self.application_json = self.evidence / "application-images.json"
        self.application_env = self.evidence / "application-images.env"
        self.runtime_json = self.evidence / "runtime-images.json"
        self.runtime_env = self.evidence / "runtime-images.env"
        self.application_json.write_text(
            json.dumps(
                application_document,
                indent=2,
            )
            + "\n",
            encoding="utf-8",
            newline="\n",
        )
        self.application_env.write_text(
            "# Generated by scripts/app-images/manage-application-images.mjs; do not hand-edit.\n"
            f"# application-image-record-id={self.application_record_id}\n"
            + "".join(
                f"{record['variable']}={record['reference']}\n" for record in application_records
            ),
            encoding="ascii",
            newline="\n",
        )
        self.runtime_json.write_text(
            json.dumps(
                runtime_document,
                indent=2,
            )
            + "\n",
            encoding="utf-8",
            newline="\n",
        )
        self.runtime_env.write_text(
            "# Generated by runtime/manage-images.mjs record; do not hand-edit.\n"
            f"# runtime-record-id={self.runtime_record_id}\n"
            + "".join(
                f"RUNNER_IMAGE_{record['language'].upper()}={record['reference']}\n"
                for record in runtime_records
            ),
            encoding="ascii",
            newline="\n",
        )

        # These local files must never enter a release package.
        (self.source / ".env").write_text("DATABASE_PASSWORD=do-not-package\n", encoding="ascii")
        (self.source / "node_modules").mkdir()
        (self.source / "node_modules" / "junk.js").write_text("junk\n", encoding="ascii")
        (self.source / "dist" / "application-images").mkdir(parents=True)
        (self.source / "dist" / "application-images" / "unreviewed.log").write_text(
            "junk\n", encoding="ascii"
        )

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def package(
        self, destination: Path, *, check: bool = True,
        environment: dict[str, str] | None = None,
    ) -> subprocess.CompletedProcess[str]:
        return run(
            [
                sys.executable,
                str(PACKAGER),
                "--source",
                str(self.source),
                "--destination",
                str(destination),
                "--application-image-json",
                str(self.application_json),
                "--application-image-env",
                str(self.application_env),
                "--application-image-record-sha256",
                sha256(self.application_json),
                "--runner-runtime-json",
                str(self.runtime_json),
                "--runner-runtime-env",
                str(self.runtime_env),
                "--runner-runtime-record-id",
                self.runtime_record_id,
            ],
            cwd=self.source,
            check=check,
            environment=environment,
        )

    def arguments(self, destination: Path):
        packager = load_packager()
        return packager, packager.parse_arguments(
            [
                "--source", str(self.source),
                "--destination", str(destination),
                "--application-image-json", str(self.application_json),
                "--application-image-env", str(self.application_env),
                "--application-image-record-sha256", sha256(self.application_json),
                "--runner-runtime-json", str(self.runtime_json),
                "--runner-runtime-env", str(self.runtime_env),
                "--runner-runtime-record-id", self.runtime_record_id,
            ]
        )

    def verify_manifest(self, *, check: bool = False) -> subprocess.CompletedProcess[str]:
        return run(
            [
                sys.executable,
                str(PACKAGER),
                "--verify-source-manifest",
                "--source", str(self.source),
                "--expected-commit", self.commit,
                "--expected-tree", self.tree,
                "--application-image-json", str(self.application_json),
                "--application-image-env", str(self.application_env),
                "--runner-runtime-json", str(self.runtime_json),
                "--runner-runtime-env", str(self.runtime_env),
            ],
            cwd=self.source,
            check=check,
        )

    def test_exact_head_and_reviewed_records_produce_one_deterministic_manifest(self) -> None:
        first = self.work / "release-one"
        second = self.work / "release-two"
        first_result = self.package(first)
        second_result = self.package(second)

        first_report = json.loads(first_result.stdout)
        second_report = json.loads(second_result.stdout)
        self.assertEqual(first_report["git_commit"], self.commit)
        self.assertEqual(first_report["git_tree"], self.tree)
        self.assertEqual(first_report["manifest_sha256"], second_report["manifest_sha256"])

        first_manifest = (first / "RELEASE.SHA256SUMS").read_bytes()
        self.assertEqual(first_manifest, (second / "RELEASE.SHA256SUMS").read_bytes())
        self.assertEqual(first_manifest, (self.source / "RELEASE.SHA256SUMS").read_bytes())
        self.assertNotIn(b"\r", first_manifest)
        self.assertTrue(first_manifest.endswith(b"\n"))

        members = {
            path.relative_to(first).as_posix()
            for path in first.rglob("*")
            if path.is_file()
        }
        expected = {
            ".gitignore",
            "README.md",
            "curriculum/lesson.json",
            "infra/ops/deploy.sh",
            "dist/application-images/application-images.json",
            "dist/application-images/application-images.env",
            "services/runner/dist/runtime-images.json",
            "services/runner/dist/runtime-images.env",
            "RELEASE.SHA256SUMS",
        }
        self.assertEqual(members, expected)
        self.assertFalse((first / ".git").exists())
        self.assertFalse((first / ".env").exists())
        self.assertFalse((first / "node_modules").exists())
        self.assertFalse((first / "dist" / "application-images" / "unreviewed.log").exists())

        records = first_manifest.decode("ascii").splitlines()
        paths = [record[66:] for record in records]
        self.assertEqual(paths, sorted(expected - {"RELEASE.SHA256SUMS"}))
        for record in records:
            self.assertEqual(record[64:66], "  ")
            digest, member = record.split("  ", 1)
            self.assertEqual(digest, sha256(first / member))

        if os.name == "posix":
            self.assertEqual(stat.S_IMODE((first / "infra" / "ops" / "deploy.sh").stat().st_mode), 0o755)
            self.assertEqual(stat.S_IMODE((first / "README.md").stat().st_mode), 0o644)

    def test_tracked_changes_are_rejected_without_publishing_partial_output(self) -> None:
        (self.source / "README.md").write_text("unreviewed change\n", encoding="ascii")
        destination = self.work / "dirty-release"
        result = self.package(destination, check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("tracked source differs from HEAD", result.stderr)
        self.assertFalse(destination.exists())

    def test_stale_application_record_binding_is_rejected(self) -> None:
        document = json.loads(self.application_json.read_text(encoding="utf-8"))
        document["source"]["tree"] = "d" * 40
        self.application_json.write_text(
            json.dumps(document, indent=2) + "\n", encoding="utf-8", newline="\n"
        )
        destination = self.work / "stale-release"
        result = self.package(destination, check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("application image record source does not match Git HEAD", result.stderr)
        self.assertFalse(destination.exists())

    def test_tracked_secret_or_generated_path_is_rejected(self) -> None:
        secret = self.source / "private.pem"
        secret.write_text("not-a-real-key\n", encoding="ascii")
        run(["git", "add", "private.pem"], cwd=self.source)
        run(["git", "commit", "--quiet", "-m", "unsafe fixture"], cwd=self.source)
        destination = self.work / "unsafe-release"
        result = self.package(destination, check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("forbidden tracked release path", result.stderr)
        self.assertFalse(destination.exists())

    def test_existing_destination_is_never_merged_or_overwritten(self) -> None:
        destination = self.work / "existing-release"
        destination.mkdir()
        sentinel = destination / "keep.txt"
        sentinel.write_text("keep\n", encoding="ascii")
        result = self.package(destination, check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("destination already exists", result.stderr)
        self.assertEqual(sentinel.read_text(encoding="ascii"), "keep\n")

    def test_noncanonical_runtime_environment_projection_is_rejected(self) -> None:
        with self.runtime_env.open("a", encoding="ascii", newline="\n") as stream:
            stream.write("UNREVIEWED_IMAGE=registry.example/escape:latest\n")
        destination = self.work / "invalid-runtime-projection"
        result = self.package(destination, check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("runtime image environment projection", result.stderr)
        self.assertFalse(destination.exists())

    def test_ambient_git_repository_selectors_are_ignored(self) -> None:
        other = self.work / "other-repository"
        other.mkdir()
        run(["git", "init", "--quiet", "--initial-branch=main"], cwd=other)
        run(["git", "config", "user.name", "Other test"], cwd=other)
        run(["git", "config", "user.email", "other@example.invalid"], cwd=other)
        (other / "README.md").write_text("other repository\n", encoding="ascii")
        run(["git", "add", "."], cwd=other)
        run(["git", "commit", "--quiet", "-m", "other"], cwd=other)
        environment = os.environ.copy()
        environment.update({"GIT_DIR": str(other / ".git"), "GIT_WORK_TREE": str(self.source)})
        destination = self.work / "sanitized-git-environment"
        result = self.package(destination, check=False, environment=environment)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["git_commit"], self.commit)

    def test_head_change_during_packaging_is_rejected_without_output(self) -> None:
        (self.source / "README.md").write_text("second reviewed source\n", encoding="ascii")
        run(["git", "add", "README.md"], cwd=self.source)
        run(["git", "commit", "--quiet", "-m", "second release"], cwd=self.source)
        second_commit = run(["git", "rev-parse", "HEAD"], cwd=self.source).stdout.strip()
        run(["git", "reset", "--hard", "--quiet", self.commit], cwd=self.source)

        packager, arguments = self.arguments(self.work / "raced-release")
        original = packager.tracked_members

        def move_head_after_inventory(*args, **kwargs):
            members = original(*args, **kwargs)
            run(["git", "reset", "--hard", "--quiet", second_commit], cwd=self.source)
            return members

        with mock.patch.object(packager, "tracked_members", side_effect=move_head_after_inventory):
            with self.assertRaises(packager.PackagingError):
                packager.package(arguments)
        self.assertFalse(arguments.destination.exists())
        self.assertFalse((self.source / "RELEASE.SHA256SUMS").exists())

    def test_destination_publication_failure_does_not_publish_source_manifest(self) -> None:
        packager, arguments = self.arguments(self.work / "rename-failure")
        with mock.patch.object(Path, "rename", side_effect=OSError("forced rename failure")):
            with self.assertRaises(OSError):
                packager.package(arguments)
        self.assertFalse(arguments.destination.exists())
        self.assertFalse((self.source / "RELEASE.SHA256SUMS").exists())

    def test_source_manifest_verifier_rejects_missing_extra_and_malformed_records(self) -> None:
        self.package(self.work / "verified-release")
        manifest_path = self.source / "RELEASE.SHA256SUMS"
        original = manifest_path.read_bytes()
        self.assertEqual(self.verify_manifest().returncode, 0)
        lines = original.splitlines(keepends=True)
        mutations = {
            "missing": b"".join(lines[1:]),
            "extra": original + (b"0" * 64) + b"  unlisted-release-member\n",
            "malformed": b"reviewed release manifest fixture\n",
        }
        for label, mutation in mutations.items():
            with self.subTest(label=label):
                manifest_path.write_bytes(mutation)
                result = self.verify_manifest(check=False)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("release manifest", result.stderr)
        manifest_path.write_bytes(original)

    def test_stale_canonical_application_record_is_rejected(self) -> None:
        document = json.loads(self.application_json.read_text(encoding="utf-8"))
        document["generatedAt"] = "2000-01-01T00:00:00Z"
        payload = {
            "schemaVersion": 1,
            "generatedAt": document["generatedAt"],
            "release": document["release"],
            "local": document["local"],
            "source": document["source"],
            "records": document["records"],
        }
        document["recordId"] = content_id(payload)
        self.application_json.write_text(
            json.dumps(document, indent=2) + "\n", encoding="utf-8", newline="\n"
        )
        env_lines = self.application_env.read_text(encoding="utf-8").splitlines()
        env_lines[1] = f"# application-image-record-id={document['recordId']}"
        self.application_env.write_text(
            "\n".join(env_lines) + "\n", encoding="utf-8", newline="\n"
        )
        result = self.package(self.work / "stale-record", check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("stale or from the future", result.stderr)


if __name__ == "__main__":
    unittest.main(verbosity=2)
