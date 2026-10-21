# Dependency & security audit — 2026-10-21

Scope: npm manifests, pinned risk exceptions, base-image pins. `npm audit` run in `node:22.23.1-bookworm` (no Docker socket mount) against `origin/main`.

## npm audit results

| Folder | `--omit=dev` | Full | CI coverage |
|---|---|---|---|
| `/` (root) | 0 | 5 high (dev only) | `npm audit --omit=dev --audit-level=moderate` + `scripts/audit-development-dependencies.mjs` (ci.yml:167-171) |
| `services/runner` | 0 | 0 | `npm audit --audit-level=high` (ci.yml:741, full tree) |

`services/interactive-runner` has no package.json. No other manifests in the repo.

Root full-tree findings, all one chain from GHSA-vfj7-8cjw-p6xm (`braces`, no patched release): `braces`, `micromatch`, `fast-glob`, `@next/eslint-plugin-next`, `eslint-config-next`. npm's suggested fix is `eslint-config-next@14.2.35` (semver-major downgrade, not a real fix). The dev-audit script passes today (exit 0) because every path resolves to that one excepted advisory.

## Findings

| Item | Risk | Deadline | Recommended fix | Effort |
|---|---|---|---|---|
| Dev exception GHSA-vfj7-8cjw-p6xm (`braces` via eslint-config-next) | Dev-only stack exhaustion. CI fails when the exception expires or if a new advisory appears in the chain | 2027-02-08 (exception `expiresAt`) | Watch for patched `braces`/`micromatch`; or move to an ESLint flat config that drops the `fast-glob` chain; re-evaluate before expiry | S–M |
| Unsigned local app-image risk acceptance (`infra/security/application-image-local-risk-acceptance.json`) | Re-approval needed; also re-triggers on any base-image/Dockerfile change | 2027-01-17 | Get registry keyless signing working, or renew the acceptance with an owner review in early January | M |
| `services/runner/Dockerfile` `node:22-bookworm-slim@sha256:a149cd71…` (pinned 2026-07-14, ~99 days) | Stale Debian packages; a Trivy HIGH would fail the runtime scan job | Now (over 90 days) | Re-pin to the current digest, re-record evidence | S (evidence hash change) |
| `infra/tests/backup-toolbox.Dockerfile` `docker:29-cli@sha256:862099ad…` (2026-07-14) | Stale Alpine/Go CVEs; test-only | Now | Re-pin | S |
| `infra/restore/restore-drill.compose.yaml` `postgres:17-bookworm@sha256:4f736ae2…` (2026-07-22) | Stale; restore drill only | Now | Re-pin to a current 17.x digest | S |
| `services/runner/runtime/images.env` `docker/dockerfile:1.7@sha256:a57df69d…` (2026-07-22) | Old BuildKit frontend; not usually scanned | Now | Bump to 1.x latest digest | S (evidence hash change) |
| Runtime bases in `images.env` (alpine 3.22/3.23, python 3.14-alpine3.23, node 22-alpine3.23) + root `Dockerfile` node 22.23.3-alpine3.23 (2026-09-24) | Will hit 90 days around 2026-12-23 | 2026-12-23 | Plan a re-pin batch in early December | S–M |
| GlitchTip stack (glitchtip 6.2.6, postgres 17.11, valkey 8.1; 2026-09-27) | Ops-only, no CI scan | 2026-12-26 | Re-pin with the December batch | S |
| `infra/piston/Dockerfile` `debian:trixie-slim` (2026-10-03) | Fresh | 2027-01-01 | None now | — |
| Test-fixture `expiresAt: 2026-10-17` (`scripts/app-images/*.test.mjs`) | Fixture data only, not a real exception. Check that the tests don't compare it to the real clock | — | Check, no action expected | XS |

Pin dates are the dates the pin last changed in git. The upstream image build may be older.

## CI-break status

Nothing is currently high or critical in a tree CI audits at that level: root prod = 0, runner full = 0, and the root dev highs are covered by an unexpired exception. The near-term CI risk is Trivy on the stale runner base image.
