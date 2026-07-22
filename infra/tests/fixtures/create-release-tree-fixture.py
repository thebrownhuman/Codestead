#!/usr/bin/python3
"""Generate canonical release overlays and a real manifest for shell tests."""

from __future__ import annotations

import argparse
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path
import subprocess
import sys


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


def run(command: list[str], *, cwd: Path | None = None, binary: bool = False):
    return subprocess.run(
        command,
        cwd=cwd,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=not binary,
        check=True,
        timeout=30,
    ).stdout


def content_id(payload: dict[str, object]) -> str:
    encoded = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode()
    return hashlib.sha256(encoded).hexdigest()


def write_json(path: Path, document: dict[str, object]) -> bytes:
    data = (json.dumps(document, indent=2) + "\n").encode()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return data


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--packager", type=Path, required=True)
    parser.add_argument("--destination", type=Path, required=True)
    arguments = parser.parse_args(argv)

    source = arguments.source.resolve(strict=True)
    commit = run(["git", "rev-parse", "--verify", "HEAD^{commit}"], cwd=source).strip()
    tree = run(["git", "rev-parse", "--verify", f"{commit}^{{tree}}"], cwd=source).strip()
    repository = run(["git", "config", "--get", "remote.origin.url"], cwd=source).strip()
    archive = run(
        ["git", "archive", "--format=tar", commit], cwd=source, binary=True
    )
    generated_at = (
        datetime.now(timezone.utc)
        .replace(microsecond=0)
        .isoformat()
        .replace("+00:00", "Z")
    )

    application_records = []
    for index, (target, variable) in enumerate(APPLICATION_TARGETS, start=1):
        manifest = f"sha256:{index:064x}"
        application_records.append(
            {
                "target": target,
                "variable": variable,
                "reference": (
                    f"registry.example.test/codestead/image{index}@{manifest}"
                ),
                "manifestDigest": manifest,
                "configDigest": f"sha256:{index + 100:064x}",
                "rootDigest": manifest,
                "sourceRepository": repository,
                "sourceRevision": commit,
            }
        )
    application_payload = {
        "schemaVersion": 1,
        "generatedAt": generated_at,
        "release": "test",
        "local": True,
        "source": {
            "repository": repository,
            "revision": commit,
            "tree": tree,
            "contextSha256": hashlib.sha256(archive).hexdigest(),
        },
        "records": application_records,
    }
    application_id = content_id(application_payload)
    application_document = {
        "schemaVersion": 1,
        "recordId": application_id,
        **{
            key: value
            for key, value in application_payload.items()
            if key != "schemaVersion"
        },
    }

    runtime_records = []
    for index, language in enumerate(RUNTIME_LANGUAGES, start=20):
        manifest = f"sha256:{index:064x}"
        runtime_records.append(
            {
                "language": language,
                "reference": (
                    f"registry.example.test/codestead/runner-{language}@{manifest}"
                ),
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
    runtime_id = content_id(runtime_payload)
    runtime_document = {
        "schemaVersion": 1,
        "recordId": runtime_id,
        **{
            key: value
            for key, value in runtime_payload.items()
            if key != "schemaVersion"
        },
    }

    application_json = source / "dist/application-images/application-images.json"
    application_env = source / "dist/application-images/application-images.env"
    runtime_json = source / "services/runner/dist/runtime-images.json"
    runtime_env = source / "services/runner/dist/runtime-images.env"
    application_bytes = write_json(application_json, application_document)
    application_env.write_text(
        "# Generated by scripts/app-images/manage-application-images.mjs; do not hand-edit.\n"
        f"# application-image-record-id={application_id}\n"
        + "".join(
            f"{record['variable']}={record['reference']}\n"
            for record in application_records
        ),
        encoding="ascii",
        newline="\n",
    )
    write_json(runtime_json, runtime_document)
    runtime_env.write_text(
        "# Generated by runtime/manage-images.mjs record; do not hand-edit.\n"
        f"# runtime-record-id={runtime_id}\n"
        + "".join(
            f"RUNNER_IMAGE_{record['language'].upper()}={record['reference']}\n"
            for record in runtime_records
        ),
        encoding="ascii",
        newline="\n",
    )

    completed = subprocess.run(
        [
            sys.executable,
            str(arguments.packager.resolve(strict=True)),
            "--source",
            str(source),
            "--destination",
            str(arguments.destination),
            "--application-image-json",
            str(application_json),
            "--application-image-env",
            str(application_env),
            "--application-image-record-sha256",
            hashlib.sha256(application_bytes).hexdigest(),
            "--runner-runtime-json",
            str(runtime_json),
            "--runner-runtime-env",
            str(runtime_env),
            "--runner-runtime-record-id",
            runtime_id,
        ],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        check=False,
        timeout=30,
    )
    if completed.returncode != 0:
        print(completed.stderr, file=sys.stderr, end="")
        return completed.returncode
    print(completed.stdout, end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
