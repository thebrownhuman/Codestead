# Rollback Runtime Contract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make release and standalone rollback share one versioned runtime-service inventory and make image-only rollback reject incompatible operations configuration before mutation while publishing truthful mixed-layer provenance.

**Architecture:** A strict tab-separated manifest under `infra/ops` is the only service inventory. Bash consumers validate its schema and derive image-restorable, managed, core, tunnel, mutator, and smoke-worker groups. Each completed release retains the manifest's operations/config compatibility version; rollback compares that retained version with the current reviewed manifest before creating quarantine or invoking Docker. Active state schema v2 separates restored image-release identity from the current compatible operations checkout and hashes.

**Tech Stack:** Bash 5, Docker Compose command contracts, Python 3 release/evidence tooling, Node static checks, shell fixture tests.

## Global Constraints

- Preserve the approved §14 image-only application rollback model; never restore an old tree or reverse SQL.
- Never pull or build during rollback, and never name unrelated host services in mutating commands.
- Keep `cloudflared` quarantined throughout any rollback mutation and clear quarantine only after internal and public smoke pass.
- A compatibility mismatch must fail before quarantine creation, tunnel stop, Compose `up`, smoke, pointer updates, or active-state publication.
- The canonical inventory contains ten image-restorable services, including `file-erasure-worker`, and eleven managed services, including retained `postgres`.
- Active evidence must not label current Compose, manifest, firewall, or runner identities as belonging to the restored image Git/tree.

---

### Task 1: Canonical runtime-service manifest

**Files:**
- Create: `infra/ops/runtime-services.tsv`
- Modify: `infra/tests/release-production.test.sh`
- Modify: `infra/tests/rollback-production.test.sh`
- Modify: `infra/tests/smoke-production.test.sh`
- Modify: `infra/tests/validate-static.mjs`

**Interfaces:**
- Consumes: exact service names from `compose.yaml`.
- Produces: metadata `SCHEMA_VERSION=1`, `OPERATIONS_CONFIG_COMPATIBILITY_VERSION=1`, and rows `service`, `image_policy`, `release_phase`, `rollback_phase`, `smoke_role`, `database_mutator`.

- [ ] Add failing tests that parse the manifest and require exactly ten `restore` rows, eleven managed rows, `file-erasure-worker` in restore/core/worker/mutator roles, and `postgres` in managed/retained/database roles.
- [ ] Run `bash infra/tests/release-production.test.sh`, `bash infra/tests/rollback-production.test.sh`, `bash infra/tests/smoke-production.test.sh`, and `node infra/tests/validate-static.mjs`; confirm failure because the manifest is absent and rollback still accepts only nine image services.
- [ ] Add the strict canonical TSV and migrate release, rollback, and smoke scripts to validate it and derive arrays without hard-coded service cases.
- [ ] Re-run the focused tests and confirm all manifest/inventory assertions pass.

### Task 2: Release compatibility capture

**Files:**
- Modify: `infra/ops/release-production.sh`
- Modify: `infra/tests/release-production.test.sh`

**Interfaces:**
- Consumes: validated current manifest metadata and its SHA-256.
- Produces: `operations-config.env` in each release record, binding the compatibility version to current operations Git/tree and current Compose/manifest/service-manifest/firewall/runner identities.

- [ ] Add failing release tests proving the successful record contains the compatibility receipt and that the generated ten-service rollback override includes `file-erasure-worker` in manifest order.
- [ ] Run the release shell test and confirm the new assertions fail for missing compatibility evidence.
- [ ] Record the reviewed operations receipt before mutation, derive capture/override/start/inventory lists from the service manifest, and publish schema-v2 active state with identical image and operations identity for a normal release.
- [ ] Re-run the release shell test and package/static checks.

### Task 3: Pre-mutation rollback compatibility and provenance

**Files:**
- Modify: `infra/ops/rollback-production.sh`
- Modify: `infra/tests/rollback-production.test.sh`

**Interfaces:**
- Consumes: previous completed release `operations-config.env`, current manifest compatibility version, current clean reviewed checkout identities, and the candidate's exact ten-service previous-image record.
- Produces: restored ten-service image set plus eleven-service managed inventory and schema-v2 active state with separate `IMAGE_*` and `OPERATIONS_*` provenance.

- [ ] Add failing rollback tests for exact ten-service success, missing and extra services rejected before `up`, compatibility-version mismatch rejected with no quarantine/Docker/smoke/state mutation, and same-version current checkout drift accepted with current operations hashes plus previous image Git/tree.
- [ ] Run the rollback test and confirm the intended failures.
- [ ] Move compatibility validation ahead of the first mutation, strictly parse all service evidence from the manifest, include the erasure worker in rollback core start/inventory, and write unambiguous schema-v2 state.
- [ ] Re-run rollback tests and inspect command order to confirm quarantine still precedes every mutating Docker action.

### Task 4: Evidence consumers and documentation

**Files:**
- Modify: `infra/ops/recovery-evidence.py`
- Modify: `src/lib/performance/load-report.ts`
- Modify: generated runtime bundle only through its repository build command if required by static tests
- Modify: focused tests for active-release and recovery evidence
- Modify: `docs/runbooks/updates-and-rollback.md`
- Modify: `docs/deployment.md`

**Interfaces:**
- Consumes: schema-v2 active state.
- Produces: consumer-visible previous image identity and current operations identity without a generic mixed `GIT_COMMIT` claim.

- [ ] Add/update tests that reject schema-v1 mixed provenance for newly written state and parse all schema-v2 identity fields exactly once in canonical order.
- [ ] Update consumers and run their focused test suites.
- [ ] Update operator documentation to explain compatibility-version review/bump rules and image-only rollback provenance.

### Task 5: Verification and commit

**Files:**
- Create outside repository: `C:\tmp\wt-rollback-contract-report.md`

- [ ] Run release, rollback, smoke, package, static, shell syntax, and all directly affected evidence-consumer tests from the clean worktree.
- [ ] Review `git diff --check`, the full diff, service counts, mutation ordering, and status.
- [ ] Commit only branch `codex/fix-rollback` and record status, commands/results, and commit SHA in the report.
