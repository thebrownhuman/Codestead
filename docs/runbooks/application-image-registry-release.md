# Application image registry release

This runbook publishes the exact seven Codestead application images, signs and
attests their immutable digests, verifies the resulting keyless identities,
scans the same digests, and only then emits the Compose image record.

## Preferred GitHub release

1. Protect the `application-image-registry` environment and require an
   administrator approval.
2. Run **Application image registry release** from the Actions tab on the
   reviewed `main` commit.
3. Enter a unique release such as `20260719T120000Z-90a441c`.
4. Download the `application-image-registry-<release>` artifact.
5. Verify that it contains `application-signing.json`, the seven-target
   security manifest, and the matching canonical JSON/env record.

The workflow grants only `contents: read`, `packages: write`, and
`id-token: write`. The last permission supplies the short-lived Sigstore
identity; no Cosign private key is stored.

## Equivalent operator commands

Run these from a clean checkout of the exact commit. Do not substitute a tag
for `git rev-parse HEAD`, and never paste tokens into shell history.

```bash
export APP_IMAGE_PUSH=1
export APP_IMAGE_RELEASE="20260719T120000Z-$(git rev-parse --short=8 HEAD)"
export APP_IMAGE_REGISTRY="ghcr.io/thebrownhuman/codestead"
export APP_IMAGE_SOURCE_REPOSITORY="https://github.com/thebrownhuman/Codestead"
export APP_IMAGE_SOURCE_REVISION="$(git rev-parse HEAD)"
export APP_IMAGE_COSIGN_CERTIFICATE_IDENTITY="https://github.com/thebrownhuman/Codestead/.github/workflows/application-image-registry-release.yml@refs/heads/main"
export APP_IMAGE_COSIGN_CERTIFICATE_OIDC_ISSUER="https://token.actions.githubusercontent.com"
export APP_IMAGE_TRIVY_CACHE_DIR="$HOME/.cache/codestead-application-trivy"

npm ci
npm run app-images:test
npm run app-images:build
npm run app-images:inspect
npm run app-images:sign
trivy image --cache-dir "$APP_IMAGE_TRIVY_CACHE_DIR" --download-db-only
trivy image --cache-dir "$APP_IMAGE_TRIVY_CACHE_DIR" --download-java-db-only
npm run app-images:scan
npm run app-images:record
```

`app-images:sign` resolves all seven registry identities, signs each immutable
child-manifest digest, writes a SLSA v0.2 predicate extracted from the matching
BuildKit attestation, verifies the exact certificate identity and issuer, and
re-resolves every tag before publishing `application-signing.json`.
`app-images:scan` independently verifies those signatures and attestations
again while producing the release security evidence. `app-images:record`
re-resolves all digests once more before atomically committing the JSON record.

## Fail-closed rules

- Never run registry signing with a dirty checkout.
- `APP_IMAGE_SOURCE_REPOSITORY`, `APP_IMAGE_SOURCE_REVISION`, and any GitHub
  source declarations must equal the independently derived origin and HEAD.
- The images are built from the exact bytes of `git archive --format=tar HEAD`;
  generated `next-env.d.ts`, `public/monaco`, `dist`, and `uploads`
  bytes cannot enter that archive.
- A partial signature set, moved tag, missing BuildKit predicate, failed
  verification, stale scanner database, or HIGH/CRITICAL finding prevents the
  canonical image record from being published.
- Local unsigned evidence is acceptable only while the versioned
  `infra/security/application-image-local-risk-acceptance.json` approval is
  active. Registry releases never use that exception.

A green local test does not prove that GHCR publication, GitHub OIDC, Sigstore,
or the NUC deployment succeeded. Preserve the real workflow run URL, uploaded
evidence artifact, deployed record digest, and NUC smoke/recovery evidence for
the release decision.
