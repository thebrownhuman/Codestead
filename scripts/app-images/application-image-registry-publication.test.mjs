import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  APPLICATION_IMAGE_TARGETS,
  runApplicationRegistryPublication,
} from "./application-image-operations.mjs";

const sourceRepository = "https://github.com/thebrownhuman/Codestead";
const sourceRevision = "a".repeat(40);
const digest = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

function extractExactPublishStepBlocks(workflow) {
  const normalized = workflow.replaceAll("\r\n", "\n");
  const stepsMarker = "    steps:\n";
  assert.equal(normalized.split(stepsMarker).length - 1, 1);
  const stepsStart = normalized.indexOf(stepsMarker) + stepsMarker.length;
  const stepsTail = normalized.slice(stepsStart).trimEnd();
  const blocks = stepsTail.split(/(?=^      - )/m);
  assert.ok(blocks.every((block) => block.startsWith("      - ")));
  return blocks.map((block) => block.trimEnd());
}

function identities() {
  return APPLICATION_IMAGE_TARGETS.map(({ target, variable, repository }) => {
    const manifestDigest = digest(`${target}:manifest`);
    return {
      target,
      variable,
      reference: `ghcr.io/thebrownhuman/codestead/${repository}@${manifestDigest}`,
      manifestDigest,
      configDigest: digest(`${target}:config`),
      rootDigest: digest(`${target}:root`),
      sourceRepository,
      sourceRevision,
    };
  });
}

test("privileged registry publication job has an exact closed-world executable step contract", () => {
  const workflow = readFileSync(
    new URL("../../.github/workflows/application-image-registry-release.yml", import.meta.url),
    "utf8",
  );

  assert.deepEqual(extractExactPublishStepBlocks(workflow), [
    `      - name: Require main-branch publication
        run: |
          set -Eeuo pipefail
          if [[ "$GITHUB_REF" != refs/heads/main ]]; then
            echo "Application image publication is restricted to refs/heads/main." >&2
            exit 1
          fi`,
    `      - uses: actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0 # v7.0.0
        with:
          persist-credentials: false`,
    `      - name: Initialize the runner-local cache path
        run: |
          set -Eeuo pipefail
          printf 'APP_IMAGE_TRIVY_CACHE_DIR=%s/application-image-trivy-cache\\n' "$RUNNER_TEMP" >> "$GITHUB_ENV"`,
    `      - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0
        with:
          node-version: 22.23.1
          cache: npm`,
    "      - run: npm ci",
    `      - name: Set up Docker with containerd image store
        uses: docker/setup-docker-action@6d7cfa65f60a9dda7b46e5513fa982536f3c9877 # v5.3.0
        with:
          daemon-config: |
            {
              "features": {
                "containerd-snapshotter": true
              }
            }`,
    `      - name: Authenticate to GHCR
        uses: docker/login-action@5e57cd118135c172c3672efd75eb46360885c0ef # v3.6.0
        with:
          registry: ghcr.io
          username: \${{ github.actor }}
          password: \${{ secrets.GITHUB_TOKEN }}`,
    `      - name: Install ORAS
        uses: oras-project/setup-oras@22ce207df3b08e061f537244349aac6ae1d214f6 # v1
        with:
          version: 1.3.0`,
    `      - name: Install Cosign
        uses: sigstore/cosign-installer@7e8b541eb2e61bf99390e1afd4be13a184e9ebc5 # v3.10.1
        with:
          cosign-release: v3.0.2`,
    `      - uses: aquasecurity/setup-trivy@3fb12ec12f41e471780db15c232d5dd185dcb514 # v0.2.6
        with:
          version: 0.69.3`,
    "      - run: npm run app-images:test",
    "      - run: npm run app-images:build",
    "      - run: npm run app-images:inspect",
    "      - run: npm run app-images:sign",
    "      - run: trivy image --cache-dir \"$APP_IMAGE_TRIVY_CACHE_DIR\" --download-db-only",
    "      - run: trivy image --cache-dir \"$APP_IMAGE_TRIVY_CACHE_DIR\" --download-java-db-only",
    "      - run: npm run app-images:scan",
    "      - run: npm run app-images:record",
    `      - name: Upload application image registry evidence
        uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4.6.2
        if: always()
        with:
          name: application-image-registry-\${{ inputs.release }}
          path: |
            dist/application-images/application-inspection.json
            dist/application-images/application-signing.json
            dist/application-images/application-images.env
            dist/application-images/application-images.json
            dist/application-images/application-security/**
            dist/application-images/.application-security.failed-*/**
          if-no-files-found: warn
          include-hidden-files: true
          retention-days: 30`,
  ]);
});

test("runbook makes the protected environment authoritative and requires captured policy evidence", () => {
  const runbook = readFileSync(
    new URL("../../docs/runbooks/application-image-registry-release.md", import.meta.url),
    "utf8",
  );

  assert.match(runbook, /choose \*\*selected branches and\s+tags\*\*/i);
  assert.match(runbook, /allow only `main`/i);
  assert.match(runbook, /authoritative external\s+authorization boundary/i);
  assert.match(
    runbook,
    /capture\s+(?:the\s+)?(?:environment\s+)?settings or API response as evidence before approving/i,
  );
  assert.match(runbook, /defense in depth/i);
  assert.match(runbook, /do not prove that the\s+environment policy is configured/i);
});

test("registry publication signs and attests all seven frozen digests before re-resolution and completion", () => {
  const frozen = identities();
  const events = [];
  const result = runApplicationRegistryPublication({
    targets: APPLICATION_IMAGE_TARGETS,
    resolveIdentity: (target) => structuredClone(frozen.find((item) => item.target === target)),
    preparePredicate: (identity) => {
      events.push(["predicate", identity.target, identity.reference]);
      return {
        predicateText: `{"target":"${identity.target}"}\n`,
        buildkitStatementText: `{"target":"${identity.target}"}\n`,
      };
    },
    signIdentity: ({ identity }) => events.push(["sign", identity.target, identity.reference]),
    attestIdentity: ({ identity, predicateText }) => {
      events.push(["attest", identity.target, identity.reference, predicateText]);
    },
    verifyIdentity: ({ identity }) => {
      events.push(["verify", identity.target, identity.reference]);
      return { target: identity.target, verified: true };
    },
    recheckIdentity: (identity) => {
      events.push(["recheck", identity.target, identity.reference]);
      return structuredClone(identity);
    },
    finalize: ({ identities: published, records }) => {
      events.push(["finalize", published.length, records.length]);
      return { complete: true, records };
    },
  });

  assert.equal(result.complete, true);
  assert.equal(result.records.length, 7);
  for (const identity of frozen) {
    const sequence = events
      .filter((event) => event[1] === identity.target)
      .map((event) => event[0]);
    assert.deepEqual(sequence, ["predicate", "sign", "attest", "verify", "recheck"]);
    assert.ok(events
      .filter((event) => event[1] === identity.target)
      .every((event) => !event[2] || event[2] === identity.reference));
  }
  assert.deepEqual(events.at(-1), ["finalize", 7, 7]);
});

test("registry publication never finalizes when a tag moves after signing", () => {
  const frozen = identities();
  let finalized = false;
  assert.throws(() => runApplicationRegistryPublication({
    targets: APPLICATION_IMAGE_TARGETS,
    resolveIdentity: (target) => structuredClone(frozen.find((item) => item.target === target)),
    preparePredicate: () => ({ predicateText: "{}\n", buildkitStatementText: "{}\n" }),
    signIdentity: () => {},
    attestIdentity: () => {},
    verifyIdentity: ({ identity }) => ({ target: identity.target, verified: true }),
    recheckIdentity: (identity) => identity.target === "runtime"
      ? { ...identity, manifestDigest: digest("moved") }
      : structuredClone(identity),
    finalize: () => {
      finalized = true;
      return { complete: true };
    },
  }), /changed|moved|runtime/i);
  assert.equal(finalized, false);
});

test("manager, package scripts, workflow, and runbook expose the digest-frozen sign/attest phase", () => {
  const manager = readFileSync(new URL("./manage-application-images.mjs", import.meta.url), "utf8");
  const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
  const workflow = readFileSync(
    new URL("../../.github/workflows/application-image-registry-release.yml", import.meta.url),
    "utf8",
  );
  const runbook = readFileSync(
    new URL("../../docs/runbooks/application-image-registry-release.md", import.meta.url),
    "utf8",
  );

  assert.match(manager, /"sign", "--yes"/);
  assert.match(manager, /"attest", "--yes", "--type", "slsaprovenance02", "--predicate"/);
  assert.match(manager, /runApplicationRegistryPublication/);
  assert.equal(pkg.scripts["app-images:sign"], "node scripts/app-images/manage-application-images.mjs sign");
  assert.match(workflow, /id-token:\s*write/);
  assert.match(workflow, /packages:\s*write/);
  const checkoutIndex = workflow.indexOf("actions/checkout@");
  const mainRefGuard = [
    "      - name: Require main-branch publication",
    "        run: |",
    "          set -Eeuo pipefail",
    "          if [[ \"$GITHUB_REF\" != refs/heads/main ]]; then",
    "            echo \"Application image publication is restricted to refs/heads/main.\" >&2",
    "            exit 1",
    "          fi",
  ].join("\n");
  const mainRefGuardIndex = workflow.indexOf(mainRefGuard);
  const buildIndex = workflow.indexOf("npm run app-images:build");
  assert.ok(checkoutIndex >= 0);
  assert.ok(mainRefGuardIndex >= 0);
  assert.ok(mainRefGuardIndex < checkoutIndex);
  assert.ok(buildIndex > mainRefGuardIndex);
  assert.equal(workflow.split(mainRefGuard).length - 1, 1);
  assert.match(workflow, /npm run app-images:build[\s\S]*npm run app-images:inspect[\s\S]*npm run app-images:sign[\s\S]*npm run app-images:scan[\s\S]*npm run app-images:record/);
  assert.match(runbook, /npm run app-images:sign/);
  assert.match(runbook, /APP_IMAGE_COSIGN_CERTIFICATE_IDENTITY/);
});
