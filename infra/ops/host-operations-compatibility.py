#!/usr/bin/env python3
"""Compare host-operation semantics across two exact local Git trees.

The helper is always executed from the trusted current checkout. It reads the
candidate and application trees only with local Git object plumbing, renders
both Compose blobs with the same current Docker Compose parser and non-secret
environment fixture, and never imports or executes code from either tree.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
from typing import Mapping, NamedTuple


CONTRACT_VERSION = "host-operations-semantic-v1"
GIT_ID_PATTERN = re.compile(r"[0-9a-f]{40}(?:[0-9a-f]{24})?")
SHA256_PATTERN = re.compile(r"[0-9a-f]{64}")
MAXIMUM_BLOB_BYTES = 4 * 1024 * 1024
MAXIMUM_COMPOSE_BYTES = 16 * 1024 * 1024
COMPOSE_PATH = "compose.yaml"
COMPOSE_ENV_PATH = "infra/env/compose.env.example"
APPLICATION_IMAGE_SERVICES = frozenset(
    {
        "admin-bootstrap",
        "app",
        "backup-status-reporter",
        "database-boundary-verifier",
        "database-negative-probes",
        "database-role-bootstrap",
        "exam-finalization-worker",
        "file-erasure-worker",
        "lifecycle",
        "mail-worker",
        "migrate",
        "platform-seed",
        "practice-runner-recovery-worker",
        "project-review-correction-worker",
        "regrade-worker",
        "reward-worker",
        "runner-egress-gateway",
        "scan-worker",
    }
)

OPERATION_PATH_MODES: Mapping[str, str] = {
    "infra/ops/ingress-control.py": "100644",
    "infra/ops/package-release-tree.py": "100755",
    "infra/ops/prepare-object-storage.mjs": "100644",
    "infra/ops/prepare-postgres-control-socket.sh": "100755",
    "infra/ops/smoke-production.sh": "100755",
    "infra/ops/validate-runtime.sh": "100755",
    "infra/runner-vm/host-runner.nft": "100644",
}
TREE_PATH_MODES: Mapping[str, str] = {
    COMPOSE_PATH: "100644",
    COMPOSE_ENV_PATH: "100644",
    **OPERATION_PATH_MODES,
}


class CompatibilityError(RuntimeError):
    """An exact-tree or semantic host-operation contract was violated."""


class TreeContract(NamedTuple):
    commit: str
    tree: str
    sha256: str


def canonical_json_bytes(value: object) -> bytes:
    return (json.dumps(value, ensure_ascii=True, separators=(",", ":"), sort_keys=True) + "\n").encode("ascii")


SENSITIVE_ENVIRONMENT_NAME_PATTERN = re.compile(
    r"(?:^|_)(?:CREDENTIAL|CREDENTIALS|KEY|PASSWORD|SECRET|TOKEN)(?:_|$)"
)
SENSITIVE_ENVIRONMENT_EXACT_NAMES = frozenset({"DATABASE_URL", "SENTRY_DSN"})


def _is_sensitive_environment_name(name: str) -> bool:
    if name.endswith("_FILE"):
        return False
    return (
        name in SENSITIVE_ENVIRONMENT_EXACT_NAMES
        or SENSITIVE_ENVIRONMENT_NAME_PATTERN.search(name) is not None
    )


def _canonical_environment(value: object) -> dict[str, object]:
    if value is None:
        return {}
    if isinstance(value, dict):
        candidates = list(value.items())
    elif isinstance(value, list):
        candidates: list[tuple[str, object]] = []
        for item in value:
            if not isinstance(item, str):
                raise CompatibilityError("Compose environment is malformed")
            name, separator, raw_value = item.partition("=")
            if separator == "":
                raise CompatibilityError("Compose environment value is unresolved")
            candidates.append((name, raw_value))
    else:
        raise CompatibilityError("Compose environment is malformed")

    canonical: dict[str, object] = {}
    for name, environment_value in candidates:
        if not isinstance(name, str) or re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", name) is None:
            raise CompatibilityError("Compose environment name is malformed")
        if name in canonical:
            raise CompatibilityError("Compose environment name is duplicated")
        if _is_sensitive_environment_name(name):
            if environment_value is None:
                canonical[name] = "<sensitive-inherited>"
            elif environment_value == "":
                canonical[name] = "<sensitive-empty>"
            else:
                canonical[name] = "<sensitive-present>"
            continue
        if environment_value is None:
            raise CompatibilityError("Compose environment value is unresolved")
        canonical[name] = _canonical_value(environment_value)
    return canonical


def _canonical_value(value: object) -> object:
    if value is None or isinstance(value, (bool, int, float, str)):
        return value
    if isinstance(value, list):
        return [_canonical_value(item) for item in value]
    if isinstance(value, dict):
        normalized: dict[str, object] = {}
        for key in sorted(value):
            if not isinstance(key, str):
                raise CompatibilityError("Compose model contains a non-string key")
            normalized[key] = _canonical_value(value[key])
        return normalized
    raise CompatibilityError("Compose model contains an unsupported value")


def _canonical_secret_definitions(value: object) -> object:
    if value is None:
        return {}
    if not isinstance(value, dict):
        raise CompatibilityError("Compose secret definitions are malformed")
    result: dict[str, object] = {}
    for name in sorted(value):
        definition = value[name]
        if definition is None:
            result[name] = None
            continue
        if not isinstance(name, str) or not isinstance(definition, dict):
            raise CompatibilityError("Compose secret definition is malformed")
        sanitized = dict(definition)
        if "content" in sanitized:
            sanitized["content"] = "<inline-secret-content-present>"
        result[name] = _canonical_value(sanitized)
    return result


def canonical_semantic_surface(model: object) -> dict[str, object]:
    if not isinstance(model, dict):
        raise CompatibilityError("Compose model is not an object")
    services = model.get("services")
    if not isinstance(services, dict) or not services:
        raise CompatibilityError("Compose model has no services")

    canonical_services: dict[str, object] = {}
    for service_name in sorted(services):
        service = services[service_name]
        if not isinstance(service_name, str) or not isinstance(service, dict):
            raise CompatibilityError("Compose service is malformed")
        sanitized: dict[str, object] = {}
        for key in sorted(service):
            if key == "image" and service_name in APPLICATION_IMAGE_SERVICES:
                # Application artifacts are independently pinned and recorded.
                continue
            if key == "environment":
                sanitized["environment"] = _canonical_environment(service[key])
                continue
            sanitized[key] = _canonical_value(service[key])
        sanitized.setdefault("environment", {})
        canonical_services[service_name] = sanitized

    return {
        "services": canonical_services,
        "networks": _canonical_value(model.get("networks", {})),
        "volumes": _canonical_value(model.get("volumes", {})),
        "secrets": _canonical_secret_definitions(model.get("secrets", {})),
        "configs": _canonical_value(model.get("configs", {})),
    }


def contract_digest(
    compose_model: object,
    operation_blobs: Mapping[str, tuple[str, bytes]],
) -> str:
    if set(operation_blobs) != set(OPERATION_PATH_MODES):
        raise CompatibilityError("host operation blob inventory is incomplete")
    blob_records: list[dict[str, str]] = []
    for path in sorted(OPERATION_PATH_MODES):
        mode, content = operation_blobs[path]
        if mode != OPERATION_PATH_MODES[path] or not isinstance(content, bytes):
            raise CompatibilityError("host operation blob mode or content is invalid")
        blob_records.append(
            {
                "mode": mode,
                "path": path,
                "sha256": hashlib.sha256(content).hexdigest(),
            }
        )
    contract = {
        "schemaVersion": 1,
        "contractVersion": CONTRACT_VERSION,
        "compose": canonical_semantic_surface(compose_model),
        "operationBlobs": blob_records,
    }
    return hashlib.sha256(canonical_json_bytes(contract)).hexdigest()


def compatibility_evidence(
    *,
    host_commit: str,
    host_tree: str,
    application_commit: str,
    application_tree: str,
    contract_sha256: str,
) -> str:
    for value in (host_commit, host_tree, application_commit, application_tree):
        if GIT_ID_PATTERN.fullmatch(value) is None:
            raise CompatibilityError("Git provenance is malformed")
    if SHA256_PATTERN.fullmatch(contract_sha256) is None:
        raise CompatibilityError("host operations contract digest is malformed")
    return "\n".join(
        (
            "SCHEMA_VERSION=1",
            f"CONTRACT_VERSION={CONTRACT_VERSION}",
            f"HOST_OPERATIONS_GIT_COMMIT={host_commit}",
            f"HOST_OPERATIONS_GIT_TREE={host_tree}",
            f"APPLICATION_GIT_COMMIT={application_commit}",
            f"APPLICATION_GIT_TREE={application_tree}",
            f"HOST_OPERATIONS_CONTRACT_SHA256={contract_sha256}",
            "RESULT=compatible",
            "",
        )
    )


class GitTreeReader:
    def __init__(self, repo_root: Path, git_bin: Path) -> None:
        if not repo_root.is_absolute() or not git_bin.is_absolute():
            raise CompatibilityError("repository and Git paths must be absolute")
        self.repo_root = repo_root.resolve(strict=True)
        self.git_bin = git_bin.resolve(strict=True)
        if not self.repo_root.is_dir() or not self.git_bin.is_file():
            raise CompatibilityError("repository or Git command is unavailable")

    def _run(self, arguments: list[str]) -> bytes:
        environment = {
            "GIT_ATTR_NOSYSTEM": "1",
            "GIT_CONFIG_GLOBAL": os.devnull,
            "GIT_CONFIG_NOSYSTEM": "1",
            "GIT_CONFIG_SYSTEM": os.devnull,
            "GIT_GRAFT_FILE": os.devnull,
            "GIT_NO_LAZY_FETCH": "1",
            "GIT_NO_REPLACE_OBJECTS": "1",
            "GIT_OPTIONAL_LOCKS": "0",
            "GIT_TERMINAL_PROMPT": "0",
            "HOME": str(self.repo_root),
            "LANG": "C",
            "LC_ALL": "C",
            "PATH": "/usr/bin:/bin",
        }
        try:
            result = subprocess.run(
                [str(self.git_bin), "--no-replace-objects", "-C", str(self.repo_root), *arguments],
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                check=False,
                timeout=30,
                env=environment,
            )
        except (OSError, subprocess.TimeoutExpired) as error:
            raise CompatibilityError("local Git object plumbing failed") from error
        if result.returncode != 0:
            raise CompatibilityError("local Git object plumbing failed")
        return result.stdout

    def verify_commit_tree(self, commit: str, tree: str) -> None:
        if GIT_ID_PATTERN.fullmatch(commit) is None or GIT_ID_PATTERN.fullmatch(tree) is None:
            raise CompatibilityError("Git commit or tree identity is malformed")
        commit_type = self._run(["cat-file", "-t", commit]).decode("ascii", "strict").strip()
        tree_type = self._run(["cat-file", "-t", tree]).decode("ascii", "strict").strip()
        derived_tree = self._run(["rev-parse", "--verify", f"{commit}^{{tree}}"]).decode("ascii", "strict").strip()
        if commit_type != "commit" or tree_type != "tree" or derived_tree != tree:
            raise CompatibilityError("Git commit and tree provenance do not match")

    def read_blob(self, tree: str, path: str, expected_mode: str) -> tuple[str, bytes]:
        listing = self._run(["ls-tree", "-z", tree, "--", path])
        entries = [entry for entry in listing.split(b"\0") if entry]
        if len(entries) != 1 or b"\t" not in entries[0]:
            raise CompatibilityError("required host operation path is missing or ambiguous")
        header, encoded_path = entries[0].split(b"\t", 1)
        fields = header.split(b" ")
        try:
            actual_path = encoded_path.decode("utf-8", "strict")
            mode = fields[0].decode("ascii", "strict")
            object_type = fields[1].decode("ascii", "strict")
            object_id = fields[2].decode("ascii", "strict")
        except (IndexError, UnicodeError) as error:
            raise CompatibilityError("Git tree entry is malformed") from error
        if actual_path != path or mode != expected_mode or object_type != "blob" or GIT_ID_PATTERN.fullmatch(object_id) is None:
            raise CompatibilityError("host operation path is not the reviewed regular blob")
        size_text = self._run(["cat-file", "-s", object_id]).decode("ascii", "strict").strip()
        if not size_text.isdigit() or int(size_text) > MAXIMUM_BLOB_BYTES:
            raise CompatibilityError("host operation blob is oversized")
        content = self._run(["cat-file", "blob", object_id])
        if len(content) != int(size_text) or b"\0" in content:
            raise CompatibilityError("host operation blob is malformed")
        return mode, content


class ComposeRenderer:
    def __init__(self, docker_bin: Path) -> None:
        if not docker_bin.is_absolute():
            raise CompatibilityError("Docker path must be absolute")
        self.docker_bin = docker_bin.resolve(strict=True)
        if not self.docker_bin.is_file():
            raise CompatibilityError("Docker command is unavailable")

    def render(self, compose_blob: bytes, environment_blob: bytes) -> object:
        for content in (compose_blob, environment_blob):
            if not content or b"\0" in content or b"\r" in content:
                raise CompatibilityError("Compose compatibility input is malformed")
            try:
                content.decode("utf-8", "strict")
            except UnicodeError as error:
                raise CompatibilityError("Compose compatibility input is not UTF-8") from error
        with tempfile.TemporaryDirectory(prefix="codestead-host-operations-") as temporary:
            root = Path(temporary)
            compose_path = root / "compose.yaml"
            environment_path = root / "compose.env"
            docker_config = root / "docker-config"
            docker_config.mkdir(mode=0o700)
            compose_path.write_bytes(compose_blob)
            environment_path.write_bytes(environment_blob)
            compose_path.chmod(0o600)
            environment_path.chmod(0o600)
            environment = {
                "DOCKER_CONFIG": str(docker_config),
                "HOME": str(root),
                "LANG": "C",
                "LC_ALL": "C",
                "PATH": "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
            }
            arguments = [
                str(self.docker_bin),
                "--host",
                "unix:///var/run/docker.sock",
                "compose",
                "--env-file",
                str(environment_path),
                "-f",
                str(compose_path),
                "--profile",
                "*",
                "config",
                "--no-path-resolution",
                "--no-env-resolution",
                "--format",
                "json",
            ]
            try:
                result = subprocess.run(
                    arguments,
                    stdin=subprocess.DEVNULL,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.DEVNULL,
                    check=False,
                    timeout=30,
                    env=environment,
                )
            except (OSError, subprocess.TimeoutExpired) as error:
                raise CompatibilityError("current Docker Compose parser failed") from error
            if result.returncode != 0 or not result.stdout or len(result.stdout) > MAXIMUM_COMPOSE_BYTES:
                raise CompatibilityError("current Docker Compose parser rejected an exact tree")
            try:
                return json.loads(result.stdout.decode("utf-8", "strict"))
            except (UnicodeError, json.JSONDecodeError) as error:
                raise CompatibilityError("current Docker Compose parser returned malformed JSON") from error


def build_tree_contract(
    reader: GitTreeReader,
    renderer: ComposeRenderer,
    *,
    commit: str,
    tree: str,
) -> TreeContract:
    reader.verify_commit_tree(commit, tree)
    _, compose_blob = reader.read_blob(tree, COMPOSE_PATH, TREE_PATH_MODES[COMPOSE_PATH])
    _, environment_blob = reader.read_blob(tree, COMPOSE_ENV_PATH, TREE_PATH_MODES[COMPOSE_ENV_PATH])
    operation_blobs = {
        path: reader.read_blob(tree, path, expected_mode)
        for path, expected_mode in OPERATION_PATH_MODES.items()
    }
    compose_model = renderer.render(compose_blob, environment_blob)
    return TreeContract(commit, tree, contract_digest(compose_model, operation_blobs))


def _absolute_path(raw: str, label: str) -> Path:
    path = Path(raw)
    if not path.is_absolute():
        raise CompatibilityError(f"{label} must be absolute")
    return path


def parse_arguments(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", required=True)
    parser.add_argument("--git-bin", required=True)
    parser.add_argument("--docker-bin", required=True)
    parser.add_argument("--host-commit", required=True)
    parser.add_argument("--host-tree", required=True)
    parser.add_argument("--application-commit", required=True)
    parser.add_argument("--application-tree", required=True)
    return parser.parse_args(argv)


def main(argv: list[str]) -> int:
    try:
        arguments = parse_arguments(argv)
        reader = GitTreeReader(
            _absolute_path(arguments.repo_root, "repository root"),
            _absolute_path(arguments.git_bin, "Git command"),
        )
        renderer = ComposeRenderer(_absolute_path(arguments.docker_bin, "Docker command"))
        host = build_tree_contract(
            reader,
            renderer,
            commit=arguments.host_commit,
            tree=arguments.host_tree,
        )
        application = build_tree_contract(
            reader,
            renderer,
            commit=arguments.application_commit,
            tree=arguments.application_tree,
        )
        if host.sha256 != application.sha256:
            raise CompatibilityError(
                "host operations compatibility rejected command/environment/mount/network/policy drift"
            )
        sys.stdout.write(
            compatibility_evidence(
                host_commit=host.commit,
                host_tree=host.tree,
                application_commit=application.commit,
                application_tree=application.tree,
                contract_sha256=host.sha256,
            )
        )
        return 0
    except CompatibilityError as error:
        print(f"host operations compatibility error: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
