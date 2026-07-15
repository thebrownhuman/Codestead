# Dependency vulnerability disposition

**Review date:** 2026-07-15

**Lockfile:** `package-lock.json` in this working tree

**Release rule:** zero known Moderate-or-higher advisories in the application release lock. Low findings still require explicit review and documentation. CI runs the online audit at Moderate severity and an offline lock-specific gate for the two reviewed transitive paths.

## Current result

`npm audit --package-lock-only --json` completed against the npm registry with **0 known vulnerabilities**. A clean isolated `npm ci` from the exact manifest and lock also reported zero. `npm ls next postcss @esbuild-kit/core-utils esbuild --all` and `npm run security:dependencies:known` verify the exact paths below.

| Advisory | Patched installed path | Decision and proof |
| --- | --- | --- |
| [`GHSA-67mh-4wv8-2f99`](https://github.com/advisories/GHSA-67mh-4wv8-2f99) (`esbuild <=0.24.2`) | `drizzle-kit@0.31.10 -> @esbuild-kit/esm-loader -> @esbuild-kit/core-utils -> esbuild@0.25.12` | A narrow override deduplicates the chain to patched `0.25.12`; the vulnerable `0.18.20` copy and its platform packages are absent from the lock. An isolated install-script rebuild, esbuild TypeScript transform, and `drizzle-kit --version` smoke test passed. |
| [`GHSA-qx2v-qp2m-jg93`](https://github.com/advisories/GHSA-qx2v-qp2m-jg93) (`postcss <8.5.10`) | `next@16.2.10 -> postcss@8.5.19` | A narrow override deduplicates Next to patched `8.5.19`; the vulnerable `8.4.31` copy is absent from the lock. A regression probe confirmed the patched stringifier escapes a closing style tag. |

The remediation does not use `npm audit fix --force`. The offline verifier rejects missing or drifted overrides, malformed package versions, and any locked esbuild or PostCSS copy in either affected range. Its unit suite also proves both former vulnerable nested paths fail closed.

The exact `react-router@8.0.1` dependency requires Node `>=22.22.0`; the application manifest enforces that floor and the production image is pinned to Node 22.23.1. The Windows authoring host reports Node 22.18.0, so its checks are useful development evidence but not deployment-runtime compatibility evidence.

The full clean-checkout application build, standalone runtime inspection, SBOM generation, and image scan must be rerun from this changed lock before deployment acceptance. Prior image evidence is not reused as proof for the patched source tree. The runner has its own dependency and image gates.

## Verification performed for this remediation

- Clean isolated `npm ci --ignore-scripts`: zero known vulnerabilities.
- `npm audit --package-lock-only --json`: zero known vulnerabilities.
- `npm ls next postcss @esbuild-kit/core-utils esbuild --all`: every esbuild copy is at least `0.25.12`; every PostCSS copy is at least `8.5.17`.
- `npm rebuild esbuild` followed by a TypeScript transform: passed.
- `drizzle-kit --version`: `0.31.10`, passed with the patched esbuild override.
- PostCSS closing-style-tag escape regression: passed.
- Offline advisory verifier: 13/13 unit tests passed.
- TypeScript and targeted ESLint gates: passed.

These checks do not replace the final Node 22.23.1 clean-checkout build, Linux container build, SBOM, image scan, or NUC deployment gates.

## Recheck procedure

1. Run `npm ci`, `npm run security:dependencies:known`, `npm audit --audit-level=moderate`, and `npm ls next postcss @esbuild-kit/core-utils esbuild --all` from the release lockfile.
2. Fail the release on any advisory at Moderate or higher; do not silently convert a new finding into a waiver.
3. Prefer supported direct or upstream upgrades. Never use `--force` without a migration plan and the complete quality gate.
4. Rebuild every standalone target, generate SBOMs, and scan application and runner images with a current Trivy or Grype database on the Linux release host.
5. Record scanner version, database timestamp, image digest, result, exception owner, and review expiry in the release evidence bundle.

## Historical image evidence

The retained [application runtime SBOM](evidence/app-image-sbom-2026-07-12.spdx.json) and [application container inventory](evidence/final-container-image-inventory-2026-07-12.json) bind pre-override local images. The separate [runner inventory](evidence/container-security/runner/runner-inventory.json) is likewise historical. Their recorded scans reported zero High/Critical findings at their original database timestamp, but none of these artifacts proves the changed lock, a signed registry image, or a deployed NUC digest.

Fresh application and runner images, SBOMs, scans, signatures or attestations, exact NUC digest binding, and deployed-host rescanning remain required release gates.
