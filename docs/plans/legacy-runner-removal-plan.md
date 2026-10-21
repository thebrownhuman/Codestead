# Task 14 — PR6 legacy runner deletion plan

## Scope and baseline

Read-only planning, 13 October 2026. No repository source edits, commits, PRs, tags, deployments, or live service changes were made. This Markdown deliverable and scratch inspection files are outside the repository.

GitHub reads verified that `dik5678920-bot/Codestead:main` and `thebrownhuman/Codestead:main` already point to **`b361e6520644a4383a40fec8ea83b12d135956c5`** (tree `5601e26c187b09df1b2d1eff509ce47477caec44`). The fork therefore needs no remote sync mutation. The clean local `work` checkout remains at `5d6e211ea26710d66683bc9c8b928134945981b1`; Git fetch failed because the configured proxy was unreachable. GitHub comparison reports upstream ahead by 12 commits, behind by 0. The plan inspects local unchanged runner infrastructure plus upstream versions of CI, package scripts, import/dependency guards, the Piston plan, and changed evidence. It does **not** claim that the local checkout was updated. Re-run the inventory against the eventual PR6 base if main advances.

## Decisions required before deletion

1. Tag the reviewed final state **`legacy-runner-final`** before any deletion. Record its commit, runtime image manifest/config identities, package/release manifests, and evidence inventory. This task does not create the tag. A Git tag alone does not preserve registry images, VM state, backups, or secrets; retain those separately for the approved rollback window.
2. Meet the existing `docs/plans/piston-runner.md` prerequisite: a week on Piston without regressions **and no legacy-pinned attempt/correction/recheck lineage requiring execution**. The rollout flag is not proof: `src/lib/runner/exam-client.ts` selects by immutable runtime label and still calls legacy for non-Piston pins. Audit open exams, finalizations, rechecks, appeals/corrections, recoverable submissions, and published curriculum versions that can create new legacy work. Do not rewrite historical snapshots or silently execute them on Piston. Close or explicitly disposition remaining lineages under a separately reviewed policy; otherwise defer PR6.
3. Replace native-runtime curriculum verification and host/recovery assumptions before removing their implementations. Removing CI or selecting `--structure-only` is not equivalent to replacing runtime proof.
4. Separate historical evidence from current release authority. Preserve truthful historical records where appropriate; publish fresh Piston proof for current claims. Deliberately review every evidence deletion, validator change, and changed digest.

## 1. Deletion inventory and shared ownership

The complete tracked leaf-path inventory is in Appendix A. Directory entries below mean every tracked descendant, subject to the explicit shared exceptions. Generated `dist`, image outputs, logs, and local node_modules are not tracked deletion entries.

| Path | PR6 treatment and reason |
|---|---|
| `services/runner/` | Delete the native HTTP/HMAC service, async queue/idempotency journal, Docker executor, process executor/containment, local launcher, configs, package/lock files, Dockerfiles, runtime harness/build/scan/sign/record tooling, and their service tests **after extracting the shared files below**. This is the old implementation, not the Piston adapter. |
| `infra/runner-gateway/` | Delete the native VM egress proxy. Piston is reached directly over its internal Compose network. |
| `infra/runner-vm/` | Delete cloud-init, libvirt network/provisioner, host/guest nftables, guest installation, runner contract, release-tree/runtime-record verifiers. These implement the dedicated legacy VM boundary. Kata's micro-VM boundary must remain. |
| `infra/runner/` | Delete native service unit example and launcher. |
| `infra/env/runner.env.example` | Delete native guest endpoint/auth/queue/state/Docker/image configuration template. |
| `infra/systemd/learncoding-runner-firewall.service`, `infra/systemd/learncoding-runner-guest-firewall.service` | Delete native host/guest firewall units once dependencies and deployment procedures are updated. |
| `infra/tests/runner-egress-gateway.test.mjs`, `runner-egress-gateway-stream-failures.test.mjs`, `runner-firewall.test.sh`, `runner-firewall-packets.test.sh`, `runner-guest-installer.test.sh`, `runner-vm-provision.test.sh`, `runner-reconciliation.test.sh`, `runner-release-tree.test.py`, `runner-route-topology.test.mjs` | Delete native implementation/VM/gateway route contracts, with replacement Piston topology and isolation assertions in retained tests. Paths are under `infra/tests/`. |
| `infra/tests/fixtures/runner-route.compose.yaml` | Delete gateway-only route fixture; preserve the shared production topology fixture. |
| `scripts/smoke-local-runner.ts` | Delete native local HTTP/HMAC smoke harness; replace useful smoke behavior with Piston checks. |
| `docs/runbooks/runner-isolation.md`, `docs/superpowers/plans/2026-07-14-runner-nuc-rollout.md`, `docs/plans/curriculum-runtime-ci-diagnosis.md` | Legacy-only operational/CI documents: remove from active docs in PR6, with history available through the tag. Fix incoming links. Do not delete the whole plans or runbooks directories. |
| `src/lib/runner/__tests__/runner-isolation-runbook.test.ts` | Delete assertions for the retired native runbook. |
| `docs/evidence/container-security/runner/` | Remove the native five-image inventory, inspection/record, contract/executor reports, and language SBOM/Trivy reports after updating the current release gate and consumers. See evidence ledger. |

### Shared files that must survive (possibly relocated)

| Path | Who uses it / required action |
|---|---|
| **`services/runner/runtime/runtime-operations.mjs`** | **Shared supply-chain implementation** imported directly by `scripts/app-images/application-image-operations.mjs` and `scripts/app-images/manage-application-images.mjs`: SPDX validation, scanner environments/control bundles, OCI identity, provenance and signing validation. Extract needed functions to a neutral image-security module before deleting `services/runner`. Preserve fail-closed behavior; remove only native-only functions after a caller audit. |
| **`services/runner/runtime/schema/`** | Shared SPDX 2.3 schema, license and provenance; runtime-operations reads schema relative to itself and `scripts/app-images/application-image-operations.test.mjs` reads schema provenance directly. Relocate the directory, adjust both paths, preserve original schema bytes/license/provenance and its validation tests. |
| `services/runner/runtime/spdx-compatibility.test.mjs`, `scanner-evidence.test.mjs`, `runtime-provenance.test.mjs` | Review test cases and relocate coverage for shared schema/scanner/provenance functions; native image portions retire. Do not discard all tests just because their current parent directory is deleted. |
| `src/lib/runner/client.ts` | Piston imports shared request/response types, errors, timeout constants, canonical serialization and `isTrustedRunnerJob`; admission/recovery/exam callers use its contracts. Retain or extract these. Delete only `RunnerClient`, configured legacy factory, signing helpers, signed response/HTTP/async polling plumbing and legacy-only bounds that have no retained caller. Preserve stable request hashes and result binding checks. |
| `src/lib/runner/piston-client.ts`, `exam-client.ts`, `provider-config.ts`, `health.ts` | Piston adapter, immutable exam selection, UI limits/provider config and bounded inventory health check. Keep; remove legacy selection/probe branches and fail explicitly on unsupported historical pins. Change legacy defaults to a reviewed Piston-only config; no fallback. |
| `src/lib/runner/admission.ts`, `practice-dispatch.ts`, `practice-recovery.ts`, `practice-recovery-admin.ts`, `practice-request-cache.ts`, `presentation.ts` | App-owned admission, replay/recovery, caching and learner feedback used by Piston. Keep the admin resolve route and `scripts/process-practice-runner-recoveries.ts`, its worker service and integration tests. `runner` in a name is not evidence of exclusive native ownership. |
| `src/lib/runner/power-rehearsal-admin.ts`, `power-rehearsal-hold.ts`; `scripts/runner-power-rehearsal.ts`, `scripts/lib/runner-power-rehearsal-cli.ts`; `infra/ops/runner-power-rehearsal-control.sh` | Database-backed dispatch hold/release controls used by shared practice dispatch/recovery, not a VM launcher. Keep with their tests and operations-image COPY entries; adapt drill docs if native restart assumptions change. Do not strand armed/filled holds. |
| `src/app/api/code/run/**`, `src/app/api/exams/**`, `src/lib/assessment-corrections/**`, `src/lib/exams/**`, `src/lib/curriculum-publication/**`, `src/lib/learning-service/**` | Actual callers, grading, trusted results, publication and immutable version pins. Preserve behavior and all replay/fairness/hidden-test protections. Keep `src/lib/exams/piston-publication-pins.ts`, `piston-runtime-pins.json`, PR4b migration and hash contracts. |
| `src/lib/db/schema.ts`, `drizzle/**` | `runner_job`, code submissions, generation/fairness and rehearsal history are app state used by Piston. Keep historical migrations/snapshots/journal. Schema retirement is not implied by native code deletion. |
| `infra/piston/**`, `.github/workflows/piston-image.yml`, `docs/runbooks/piston-kata.md`, `docs/plans/piston-runner.md`, `piston-pr4b-hash-review.md`, `piston-idle-stop.md`, `scripts/piston-capacity.sh`, `load/piston-capacity*` | Piston build, locked downloads, containment/runtime proof, publication handoff/pins, Kata setup and capacity checks. Keep. Update historical native comparisons/rollout instructions where needed. |
| `scripts/verify-{c-cpp-executable-tranche,java-python-code-tasks,ai-code-tasks,web-executable-tranche,dsa-language-parity}.ts` | Curriculum correctness/coverage checks include native execution but also essential content/browser proof. Keep structure and browser checks, replace runtime execution/identity input with Piston. Do not delete these wholesale. |
| `scripts/pinned-curriculum-runtime.ts`, `scripts/curriculum-runtime-pins.json`, `scripts/sync-curriculum-runtime-pins.ts`, `scripts/lib/curriculum-runtime-pin-sync*`, `scripts/lib/local-runtime-identity*`, `local-runtime-config-authentication.test.ts`, `local-runtime-resolution.test.ts` | Native pin/executor/identity machinery still used by authoring generators and curriculum verifiers. **Conditional retirement** after migrating callers; split generic output normalization/identity verification and preserve equivalent Piston immutable-image checks. Authoring generators and assessment banks must remain; do not mass-rewrite historical legacy snapshots. |
| `scripts/app-images/**`, root `Dockerfile`, `compose.yaml`, `infra/docker/entrypoint.sh` | Current application image publication and multi-service deployment. Keep, edit only native dependencies and add Piston wiring to every retained execution worker. All seven application targets and independent security gates remain. |
| `infra/ops/{release-production,rollback-production,start-production-stack,smoke-production,redeploy-nuc,validate-runtime,install-systemd}.sh`, `package-release-tree.py`, `host-operations-compatibility.py`, `infra/release/production-executable-entrypoints.json` | Shared trusted release/install/rollback machinery contains mandatory native manifest/firewall/gateway checks. Keep and version the new release contract; remove native entries, not archive/permission/source-provenance checks. |
| `infra/ops/recovery-checker.py`, `recovery-evidence.py`, `capture-recovery-evidence.sh`, `scripts/backup/**`, `infra/systemd/learncoding-compose.service` | Shared power recovery/backup/service orchestration currently expects the gateway/VM/firewall/runtime identities. Replace these expectations with Piston/Kata requirements. Preserve credential redaction, archive integrity, atomic recovery evidence and backup authority. |
| `infra/ops/production-load-control.py`, `infra/runtime/**`, `scripts/lib/production-load-*`, `src/lib/performance/**`, `load/**`, production-load systemd units | Host load/fault/invariant proof still assumes runner VM identities/telemetry/restart. Retain the host load framework and unrelated-container safeguards; replace native-specific fault/telemetry schema and controller actions with reviewed Piston equivalents. Keep `/run/libvirt` and `/dev/kvm` denial rules where they protect untrusted control services. |
| `infra/tests/github-runner-context-registration.test.mjs`, its npm script and CI registration | GitHub Actions execution context, unrelated to the native code runner. Keep. The same applies to generic shell/worker/runtime tests whose names include runner/runtime. |

## 2. Reference edits required

Appendix B is a path/line index of explicit native configuration, identity, artifact and helper references outside the native source tree. Retained files in that index need edits only to their native portions; historical prose can instead be explicitly marked archived. This is a discovery index, not a blanket deletion list.

### Package scripts, dependencies and test entry points

- Remove root scripts `runner:local` and `runner:smoke`. Keep `runner:power-rehearsal` and `worker:practice-recovery` for their shared users. Remove the nested runner npm install/audit/commands by deleting its manifest.
- Keep and migrate `curriculum:runtime-pins:check`, `curriculum:runtime-pins:apply`, `dsa:parity:{generate,check,verify,structure:apply,evidence:apply}` and the `c-cpp`, `java-python`, `ai-code`, `web` `executable:*` scripts. These must continue to prove their curriculum; rename/repoint pin scripts if their native sync utility retires. Root `check` must keep executable structure, architecture, evidence, content, security and build gates.
- Root `package-lock.json` changes only for reviewed dependency changes. `ajv` remains needed by relocated image-security validation; `tsx` still runs application workers. Do not prune a package merely because the runner manifest also used it.
- Rewrite `src/lib/runner/__tests__/client.test.ts` into shared trust/serialization and Piston factory tests, removing native HMAC transport-only cases. Preserve `piston-client.test.ts` and migrate its direct imports of native executor/validation/fixtures. `scripts/lib/provider-parity-fixtures.ts` and exam/correction provider-parity tests currently instantiate the native executor and signed transport: retain outcome/grading/hidden-output/digest cases using fixed reviewed legacy baselines or Piston fixtures, then retire native comparison infrastructure.
- Preserve integration admission/recovery/assessment-correction and worker wiring tests; update native env/factory mocks. Remove references in otherwise unrelated GitHub reviewer/rewards/storage tests only where their fixture reads native files.

### CI

At upstream main, `.github/workflows/ci.yml` requires edits in:

| Job / section | Required change |
|---|---|
| `changes` | Remove the `runner` output and `runner-paths` filter. Migrate curriculum/image/infra filters so Piston and relocated shared security files still trigger all relevant checks. |
| `runner` | Delete native build/install/audit/runtime release job and `runner-runtime-release-evidence` upload. |
| `curriculum-runtime` | Replace native runtime build/inspect/scan/record and pins check with Piston evidence/identity gates; retain curriculum proof. |
| `curriculum-verify` | Replace native setup for all four executable groups. Retain browser installation/web verification and differing/regenerated candidate artifacts; candidates do not automatically become reviewed evidence. |
| `curriculum-dsa-parity`, `curriculum-dsa-parity-merge` | Replace native runtime setup and `services/runner/dist/dsa-parity-shards` artifact location. Preserve exact once-per-case coverage, shard identity consistency and full runtime verification. |
| `unit`, `infra-release`, `infra-host`, `production-topology`, `infra-recovery`, `infra-sandbox` | Remove only deleted runner contracts/shell globs/VM prerequisites. Update shared release/topology/recovery/load tests to require the Piston contract. Preserve backup/mail/host safeguards and their registration tests. |
| `application-images` | Keep independent build/security/publication gate; update relocated helper inputs and context identity. |
| `ci-ok` | Remove `runner` from `needs` and its `gate_of` case; keep fail-closed success/legitimate-skip semantics. Retain migrated curriculum jobs in `needs`. |

Keep `.github/workflows/piston-image.yml`; its `src/lib/runner/**` path filter remains valid. `.github/dependabot.yml`: remove only `/services/runner` npm ecosystem stanza. `scripts/audit-development-dependencies.test.mjs` currently asserts the separate native `npm audit --audit-level=high`; replace this retired-job expectation while retaining strict root production/dev audits, expiry policy and no-error-suppression checks. Update CI-registration tests indexed in Appendix B, especially backup/topology and shared image contracts.

### Compose, Docker and environment

- Delete Compose `runner-egress-gateway`, `runner-client`, `runner-egress`, gateway addresses/bridge, `runner_shared_secret` declaration and all consumer mounts. Remove app gateway `depends_on` and native network memberships.
- Keep app, `regrade-worker`, `exam-finalization-worker`, `practice-runner-recovery-worker`. These workers currently carry legacy endpoint/secret/client-network settings; wire their real Piston consumers to the internal Piston network with reviewed `PISTON_URL`/immutable `PISTON_IMAGE` and readiness/startup behavior. Do not assume app-only Piston configuration reaches workers.
- Keep `piston` service, internal network, Kata runtime, drop/add capability contract, job tmpfs bounds and networking disabled. Decide explicitly whether the optional profile/disabled image placeholder remains suitable for a Piston-only release. Missing profile/image must fail closed rather than start a broken release.
- Root Dockerfile: remove only `COPY infra/runner-gateway/server.mjs ./runner-gateway/server.mjs`. Keep practice-recovery and power-rehearsal COPY entries. Source changes alter application source/context/image identities even when unrelated target logic is unchanged.
- `infra/docker/entrypoint.sh`: remove legacy shared-secret requirement under `REQUIRE_APP_SECRETS`; preserve auth/lost-device/credential/deletion and database secrets validation. Keep generic `*_FILE` support.
- `.env.example`, `infra/env/compose.env.example`, `infra/secrets/README.md`: remove legacy endpoint/secret/concurrency examples and rotate/retire deployed legacy secrets only in the later approved decommission procedure. Audit client `RUNNER_BASE_URL`, `RUNNER_SHARED_SECRET`, `RUNNER_SHARED_SECRET_FILE`; gateway `RUNNER_GATEWAY_UPSTREAM`; VM/service `RUNNER_HOST`, `RUNNER_PORT`, queue/skew/nonce/idempotency/state/temp/Docker/image settings listed in Appendix C. Keep shared `RUNNER_*` error names and timeout constants, not env vars, where Piston still uses them.
- Keep `PISTON_*` controls and limits. Make `CODE_RUNNER_PROVIDER` Piston-only or remove it with every consumer updated, including publication/runtime selection/UI/health; never leave an absent value defaulting to legacy.
- `.dockerignore`, `.gitignore`, `eslint.config.mjs`, `tsconfig.json`: remove retired runner dist/ignore/exclude entries. `.gitleaks.toml` and `scripts/ci/gitleaks.test.mjs`: retire only exact allowlists/tests bound to deleted native fixtures; preserve scanning and remaining canary redaction contracts.

### Deployment, recovery and docs

- Update required-service allowlists, gateway route smoke tests, runner guest/runtime manifest checks, firewall installation and retained-gateway rollback transition records throughout release/start/rollback/redeploy/recovery/backup tools. Introduce a reviewed record/schema version for the post-PR6 release; retain explicit parsers for prior supported rollback records or deliberately disallow cross-version rollback with a documented recovery path. Never simply ignore missing old fields.
- `infra/systemd/learncoding-compose.service`: remove legacy firewall/libvirtd dependencies only after verifying remaining consumers; preserve network, Docker, storage and timeout/restart ordering. `infra/ops/install-systemd.sh`: stop installing/enabling retired runner firewall. Keep production-load recovery units, adapting their VM-specific dependencies/actions.
- `infra/release/production-executable-entrypoints.json`: remove runner VM/launcher entries; keep shared rehearsal controller. `scripts/verify-email-outbox-writer-inventory.mjs`: remove the native `cloud-init/meta-data` scanner exemption, without relaxing the writer inventory scan.
- Rewrite active `README.md`, `docs/deployment.md`, `docs/APP_STATUS.md`, `docs/runbooks/{firewall-and-network,incident-response,logs-and-monitoring,power-loss-recovery}.md`, `docs/practice-runner-verification.md`, `load/README.md`, `infra/secrets/README.md` for Piston/Kata and current recovery expectations. Review root audits/status/history documents and `docs/superpowers/**` references indexed below: keep history labeled as such or remove with incoming links fixed. `docs/plans/piston-runner.md` must remove the active “set flag to legacy” rollback instruction and link the final tag instead; keep truthful benchmark history.
- Search both Markdown links and literal paths/commands: `evidence:verify` checks links but inline code references may remain stale without being links.

### Import boundaries and runtime dev-dependency guard

- Keep `scripts/verify-import-boundaries.ts`, the upstream `scripts/lib/import-analysis.ts`, `scripts/lib/runtime-dependencies.ts` and their tests. Import analysis must keep type-erasure, relative/alias/re-export/transitive/Node checks and documented exceptions.
- `runtime-dependencies.ts` explicitly seeds `services/runner/src/index.ts`, reads `services/runner/package.json`, uses its dependency ownership, and discovers `infra/runner-gateway` paths in Docker/Compose. Remove exactly these retired roots/owner logic; retain app/instrumentation/proxy roots, deployed script discovery, worker scripts, repo-escape rejection and missing-source failures. Add/retain appropriate Piston deployment tooling manifest ownership if that code is newly included; do not scan it against the wrong root manifest.
- Both `scripts/lib/runtime-dependencies.test.ts` and `scripts/__tests__/verify-import-boundaries.test.ts` contain nested runner manifest fixtures. Replace these retired-root assertions with checks for remaining deployable roots and relocated modules. The guard's failure on importing dev-only or undeclared dependencies must remain demonstrable.
- Regenerate `architecture-import-boundaries-2026-07-12.json` only if checker output changes; there is no excuse to add a broad import exemption for relocated shared code.

## 3. Evidence and hash impact

| Evidence | Removal / regeneration / retention decision |
|---|---|
| `docs/evidence/container-security/runner/**` | Delete all 16 native inventory/report/record/SBOM/Trivy files after consumer migration. Review the exact manifest in Appendix A. No Piston claim can reuse native runtime digests. |
| `docs/evidence/release-quality-gate-2026-07-12.json` | Mixed current/historical summary; currently references five native runner evidence JSON artifacts. Update release authority to new Piston runtime/isolation/curriculum evidence, or preserve the historical record and its referenced artifacts outside current authority under an explicitly reviewed archive design. Under the proposed deletion, remove/replace native summary fields and artifact pins together, with honest scope/date and fresh validation. Never change only hashes to imply rerun proof. |
| `docs/evidence/docker-release-runtime-verification-2026-07-12.json` | Mixed app images/backup/load/native abuse record. Keep historical app/backup portions; separate or replace retired `runnerReleaseContract`/native results. It is not exclusively native evidence. |
| `{c-cpp,java-python,ai-code,web}-executable-{structure,runtime}-2026-07-12.json` and `dsa-parity-{declaration,structure,runtime}-2026-07-12.json` | Keep curriculum proof, regenerate affected runtime/image/version/case evidence through migrated verifiers. Structure may also change with metadata/inspection replacement. Web includes browser/React/esbuild proof and must not be deleted as native-only. DSA declaration's four-language digests must bind reviewed Piston execution identity, not removed native image pins. |
| `docs/evidence/run-002-practice-runner-2026-07-12.json` | Shared practice/mastery/admission record with historical queue/native semantics; keep history and produce refreshed Piston behavior evidence if claimed current. Do not delete practice requirements. |
| `docs/evidence/run-008-official-runner-fairness-2026-07-12.json`, `exm-003-006-008-reliability-2026-07-12.json` | Keep anchored history and all source hashes unchanged. Both are anchored at `718666b84c99cde07fe33bcff9d91b755ff535b5`. Their contract test intentionally permits later source changes/removal, but requires anchor availability, honest note, 12/14 unique pins, and tamper rejection. Add new Piston fairness/reliability proof for current guarantees. |
| `docs/evidence/architecture-import-boundaries-2026-07-12.json` | Recompute deterministic output after code/guard changes; inspect diff and retain zero violations/no stale exceptions. |
| `docs/evidence/final-container-image-inventory-2026-07-12.json`, `container-security/app/**`, `app-image-sbom-2026-07-12.spdx.json`, tooling migration/load image proof | Shared application evidence. Keep historical bytes; new Dockerfile/source context requires a new reviewed seven-target image inventory, SBOM/scans/provenance/signatures and dependent proof as appropriate. The old final inventory explicitly excludes runner images. No deletion of app SBOMs is justified. |
| Other evidence, including auth/backup/provider settings | Preserve anchored source proof. See Appendix D for records binding edited sources or native artifacts. For unanchored current source/artifact hashes, regenerate honestly or explicitly anchor historical proof to verified existing bytes under review. Retain current-byte checking for immutable evidence artifacts. |

### Validators/contracts that must change deliberately

1. `scripts/lib/evidence-integrity.ts` / `scripts/verify-evidence-integrity.ts`: remove retired `services/runner/README.md` from Markdown roots; migrate the DSA declaration's `scripts/curriculum-runtime-pins.json` comparison if that file retires or changes schema. Keep repository traversal rejection, invalid hash/source declaration checks, missing-anchor and ancestor checks, immutable-artifact existence and exact hash checks, and auth-recovery's required outbox-worker pin.
2. `src/lib/release/__tests__/evidence-integrity.test.ts`: update DSA/current-artifact fixtures and expected contracts to the reviewed Piston format. Keep negative cases for a removed *required* artifact, wrong digest, malformed declaration, missing source/anchor and traversal. Do not add an “ignore missing runner paths” clause.
3. `src/lib/release/__tests__/runner-exam-evidence-anchor.test.ts`: retain its two historical records and removal/tamper/missing-anchor tests. No change is required merely because a working-tree source file is deleted. Full-history CI (`fetch-depth: 0` where evidence verification runs) remains necessary.
4. The five executable curriculum verifiers, `scripts/generate-dsa-language-parity.ts`, `scripts/lib/curriculum-verifier-immutable-reference.test.ts`, local image-identity/authentication/resolution tests and `src/lib/content/__tests__/{c-cpp-executable-tranche,java-python-authored-tranche,ai-authored-tranche,web-executable-tranche}.test.ts`: replace native image/harness assertions with immutable Piston identity/runtime/case-count checks; retain browser provenance and output/coverage semantics. Confirm exact file names in Appendix B before implementing.
5. Native `services/runner/runtime/*` release/scan/provenance contracts retire only for native products. Relocated shared scanner/SPDX/provenance tests and `scripts/app-images/*.test.mjs` must still reject invalid schemas, stale/mismatched identity, wrong subject/provenance and scanner failures.
6. `infra/tests/{validate-static,validate-compose}.mjs`, runtime-validator structure/harness/network tests, shared release-tree/host-compatibility/release/rollback/topology/recovery/backup CI contracts: replace mandatory native resources with positive Piston/Kata constraints and forbidden legacy route/service assertions. Keep image pin/source authority, least privilege, credentials, unrelated-container isolation and approved operation boundaries.

Hash chain: deleting/moving source changes the Git tree and build-context hash; Dockerfile changes produce new OCI manifest/config identities; new image identities require matching publication/scan/SBOM/signature records, release packaging and active/rollback records. Evidence artifact deletion breaks unanchored references even when a parent record has `sourceCommit`, because `docs/evidence/**` stays bound to current bytes. Historical source anchors can tolerate source deletion, not deletion of their required immutable evidence artifacts. Never replace a manifest digest with a config/image ID or a label-only assertion.

## 4. Risks and suggested order inside one PR6

Use **one PR**, as requested; 6a/6b/6c below are reviewable implementation stages/commit groups for the future author, not extra PRs or changes made by this task. The merged result must be coherent and fully checked.

| Stage | Work and exit condition |
|---|---|
| Pre-PR6 | Tag `legacy-runner-final`; archive necessary images/release/VM evidence; demonstrate stable Piston operation and zero executable legacy lineages/new publication sources. Agree post-delete rollback and evidence disposition. |
| 6a — remove routing prerequisites | Make default/config/health/publication Piston-only; fail safely for unsupported pins. Configure every actual worker consumer. Extract shared contracts and image-security/schema implementation. Migrate curriculum runtime and host recovery/load proof. Verify no retained import/required-artifact dependency on deletion set. |
| 6b — delete code + native CI | Delete Appendix A native paths, gateway service/networks/secrets/VM units, native CI job and filters, dependabot stanza and old release packaging roots. Update deployment/start/rollback/backup/load/systemd and all replacement contracts in the same stage. Preserve required `ci-ok` semantics. |
| 6c — evidence + documentation | Remove native evidence and update/rebuild affected current proof and artifact pins. Retain anchored historical records; fix links/commands and archive labels. Review a before/after evidence manifest and validator diff independently of regenerated hashes. Final diff contains no silently waived proof. |
| Final PR6 validation | Run typecheck/build, import/runtime dependency guards, relevant unit/integration grading/recovery/fairness tests, full curriculum Piston runtime+browser checks, Piston image/Kata containment/capacity proof, app-image/security/release/topology/rollback/backup/recovery/load contracts, then `evidence:verify` with full Git history. Use the project-required combined checks and review generated evidence; do not run apply mode blindly in CI to conceal a difference. |

Principal risks: immutable legacy work being stranded; Piston workers missing network/config; stable request hashes changing; loss of grading/hidden-test and replay guarantees; accidental deletion of shared SPDX/scanner security; breaking bootstrap/backup/recovery with old mandatory gateway records; rollback requiring deleted VM resources; weakening load/containment proof by removing native tests; stale docs causing unsafe host operations; deleting artifact pins from otherwise valid historical evidence. A tag gives source rollback, not a functioning legacy deployment. No live cleanup or registry/VM deletion belongs to this planning task.

## Appendix A — exact tracked retirement leaves

The entries below expand the native directories and exclusive individual paths. Shared extraction candidates are marked **MOVE shared implementation/coverage** instead of DELETE. Native helper retirement outside these directories remains conditional, as described above.

| Path | Action | Why |
|---|---|---|
| `docs/evidence/container-security/runner/runner-inventory.json` | DELETE | native five-image security/runtime evidence |
| `docs/evidence/container-security/runner/runtime-contract-report.json` | DELETE | native five-image security/runtime evidence |
| `docs/evidence/container-security/runner/runtime-executor-report.json` | DELETE | native five-image security/runtime evidence |
| `docs/evidence/container-security/runner/runtime-images.env` | DELETE | native five-image security/runtime evidence |
| `docs/evidence/container-security/runner/runtime-images.json` | DELETE | native five-image security/runtime evidence |
| `docs/evidence/container-security/runner/runtime-inspection.json` | DELETE | native five-image security/runtime evidence |
| `docs/evidence/container-security/runner/runtime-security/c.spdx.json` | DELETE | native five-image security/runtime evidence |
| `docs/evidence/container-security/runner/runtime-security/c.trivy.json` | DELETE | native five-image security/runtime evidence |
| `docs/evidence/container-security/runner/runtime-security/cpp.spdx.json` | DELETE | native five-image security/runtime evidence |
| `docs/evidence/container-security/runner/runtime-security/cpp.trivy.json` | DELETE | native five-image security/runtime evidence |
| `docs/evidence/container-security/runner/runtime-security/java.spdx.json` | DELETE | native five-image security/runtime evidence |
| `docs/evidence/container-security/runner/runtime-security/java.trivy.json` | DELETE | native five-image security/runtime evidence |
| `docs/evidence/container-security/runner/runtime-security/javascript.spdx.json` | DELETE | native five-image security/runtime evidence |
| `docs/evidence/container-security/runner/runtime-security/javascript.trivy.json` | DELETE | native five-image security/runtime evidence |
| `docs/evidence/container-security/runner/runtime-security/python.spdx.json` | DELETE | native five-image security/runtime evidence |
| `docs/evidence/container-security/runner/runtime-security/python.trivy.json` | DELETE | native five-image security/runtime evidence |
| `docs/plans/curriculum-runtime-ci-diagnosis.md` | DELETE | native runtime CI diagnosis |
| `docs/runbooks/runner-isolation.md` | DELETE | native isolation operations |
| `docs/superpowers/plans/2026-07-14-runner-nuc-rollout.md` | DELETE | native rollout instructions |
| `infra/env/runner.env.example` | DELETE | native guest configuration |
| `infra/runner-gateway/server.mjs` | DELETE | native VM gateway |
| `infra/runner-vm/cloud-init/meta-data` | DELETE | native VM provision/isolation/release contract |
| `infra/runner-vm/cloud-init/user-data.template` | DELETE | native VM provision/isolation/release contract |
| `infra/runner-vm/codestead-runner-network.xml` | DELETE | native VM provision/isolation/release contract |
| `infra/runner-vm/codestead_runner_provision.py` | DELETE | native VM provision/isolation/release contract |
| `infra/runner-vm/guest-runner.nft` | DELETE | native VM provision/isolation/release contract |
| `infra/runner-vm/host-runner.nft` | DELETE | native VM provision/isolation/release contract |
| `infra/runner-vm/install-guest.sh` | DELETE | native VM provision/isolation/release contract |
| `infra/runner-vm/provision-host.sh` | DELETE | native VM provision/isolation/release contract |
| `infra/runner-vm/runner-contract.json` | DELETE | native VM provision/isolation/release contract |
| `infra/runner-vm/verify-release-tree.py` | DELETE | native VM provision/isolation/release contract |
| `infra/runner-vm/verify-runtime-record.mjs` | DELETE | native VM provision/isolation/release contract |
| `infra/runner/learncoding-runner.service.example` | DELETE | native service launch |
| `infra/runner/run-runner.sh` | DELETE | native service launch |
| `infra/systemd/learncoding-runner-firewall.service` | DELETE | native host firewall |
| `infra/systemd/learncoding-runner-guest-firewall.service` | DELETE | native guest firewall |
| `infra/tests/fixtures/runner-route.compose.yaml` | DELETE | native gateway route fixture |
| `infra/tests/runner-egress-gateway-stream-failures.test.mjs` | DELETE | native gateway/VM/release topology contract |
| `infra/tests/runner-egress-gateway.test.mjs` | DELETE | native gateway/VM/release topology contract |
| `infra/tests/runner-firewall-packets.test.sh` | DELETE | native gateway/VM/release topology contract |
| `infra/tests/runner-firewall.test.sh` | DELETE | native gateway/VM/release topology contract |
| `infra/tests/runner-guest-installer.test.sh` | DELETE | native gateway/VM/release topology contract |
| `infra/tests/runner-reconciliation.test.sh` | DELETE | native gateway/VM/release topology contract |
| `infra/tests/runner-release-tree.test.py` | DELETE | native gateway/VM/release topology contract |
| `infra/tests/runner-route-topology.test.mjs` | DELETE | native gateway/VM/release topology contract |
| `infra/tests/runner-vm-provision.test.sh` | DELETE | native gateway/VM/release topology contract |
| `scripts/smoke-local-runner.ts` | DELETE | native local HTTP/HMAC smoke |
| `services/runner/.dockerignore` | DELETE | native service/runtime implementation or its build/test/config assets |
| `services/runner/.env.example` | DELETE | native service/runtime implementation or its build/test/config assets |
| `services/runner/.gitignore` | DELETE | native service/runtime implementation or its build/test/config assets |
| `services/runner/Dockerfile` | DELETE | native service/runtime implementation or its build/test/config assets |
| `services/runner/README.md` | DELETE | native service/runtime implementation or its build/test/config assets |
| `services/runner/package-lock.json` | DELETE | native service/runtime implementation or its build/test/config assets |
| `services/runner/package.json` | DELETE | native service/runtime implementation or its build/test/config assets |
| `services/runner/runtime/.dockerignore` | DELETE | native service/runtime implementation or its build/test/config assets |
| `services/runner/runtime/Dockerfile` | DELETE | native service/runtime implementation or its build/test/config assets |
| `services/runner/runtime/README.md` | DELETE | native service/runtime implementation or its build/test/config assets |
| `services/runner/runtime/harness.c` | DELETE | native service/runtime implementation or its build/test/config assets |
| `services/runner/runtime/images.env` | DELETE | native service/runtime implementation or its build/test/config assets |
| `services/runner/runtime/manage-images.mjs` | DELETE | native service/runtime implementation or its build/test/config assets |
| `services/runner/runtime/manage-images.test.mjs` | DELETE | native service/runtime implementation or its build/test/config assets |
| `services/runner/runtime/release-gate-contracts.test.mjs` | DELETE | native service/runtime implementation or its build/test/config assets |
| `services/runner/runtime/runtime-build-inputs.test.mjs` | DELETE | native service/runtime implementation or its build/test/config assets |
| `services/runner/runtime/runtime-operations.mjs` | MOVE shared implementation/coverage | application-image scanner/SPDX/OCI/provenance users |
| `services/runner/runtime/runtime-provenance.test.mjs` | MOVE shared implementation/coverage | shared provenance coverage to split |
| `services/runner/runtime/runtime-record-publication.test.mjs` | DELETE | native service/runtime implementation or its build/test/config assets |
| `services/runner/runtime/scanner-evidence.test.mjs` | MOVE shared implementation/coverage | shared scanner coverage to split |
| `services/runner/runtime/schema/LICENSE.spdx-spec.txt` | MOVE shared implementation/coverage | shared application-image SPDX schema/license/provenance |
| `services/runner/runtime/schema/spdx-2.3.schema.json` | MOVE shared implementation/coverage | shared application-image SPDX schema/license/provenance |
| `services/runner/runtime/schema/spdx-2.3.schema.provenance.json` | MOVE shared implementation/coverage | shared application-image SPDX schema/license/provenance |
| `services/runner/runtime/spdx-compatibility.test.mjs` | MOVE shared implementation/coverage | shared SPDX coverage |
| `services/runner/runtime/test-runner-executor.mjs` | DELETE | native service/runtime implementation or its build/test/config assets |
| `services/runner/runtime/test-runtime-images.mjs` | DELETE | native service/runtime implementation or its build/test/config assets |
| `services/runner/src/__tests__/auth.test.ts` | DELETE | native service/runtime implementation or its build/test/config assets |
| `services/runner/src/__tests__/docker-executor.test.ts` | DELETE | native service/runtime implementation or its build/test/config assets |
| `services/runner/src/__tests__/fixtures.ts` | DELETE | native service/runtime implementation or its build/test/config assets |
| `services/runner/src/__tests__/http-service.test.ts` | DELETE | native service/runtime implementation or its build/test/config assets |
| `services/runner/src/__tests__/local-launcher-runtime-record.test.ts` | DELETE | native service/runtime implementation or its build/test/config assets |
| `services/runner/src/__tests__/local-launcher.test.ts` | DELETE | native service/runtime implementation or its build/test/config assets |
| `services/runner/src/__tests__/process-lock.test.ts` | DELETE | native service/runtime implementation or its build/test/config assets |
| `services/runner/src/__tests__/queue-idempotency-config.test.ts` | DELETE | native service/runtime implementation or its build/test/config assets |
| `services/runner/src/__tests__/runtime-assets.test.ts` | DELETE | native service/runtime implementation or its build/test/config assets |
| `services/runner/src/__tests__/state-journal.test.ts` | DELETE | native service/runtime implementation or its build/test/config assets |
| `services/runner/src/__tests__/validation-normalize.test.ts` | DELETE | native service/runtime implementation or its build/test/config assets |
| `services/runner/src/auth.ts` | DELETE | native service/runtime implementation or its build/test/config assets |
| `services/runner/src/config.ts` | DELETE | native service/runtime implementation or its build/test/config assets |
| `services/runner/src/docker-executor.ts` | DELETE | native service/runtime implementation or its build/test/config assets |
| `services/runner/src/errors.ts` | DELETE | native service/runtime implementation or its build/test/config assets |
| `services/runner/src/http-server.ts` | DELETE | native service/runtime implementation or its build/test/config assets |
| `services/runner/src/idempotency.ts` | DELETE | native service/runtime implementation or its build/test/config assets |
| `services/runner/src/index.ts` | DELETE | native service/runtime implementation or its build/test/config assets |
| `services/runner/src/local-launcher.ts` | DELETE | native service/runtime implementation or its build/test/config assets |
| `services/runner/src/metrics.ts` | DELETE | native service/runtime implementation or its build/test/config assets |
| `services/runner/src/normalize.ts` | DELETE | native service/runtime implementation or its build/test/config assets |
| `services/runner/src/process-executor.ts` | DELETE | native service/runtime implementation or its build/test/config assets |
| `services/runner/src/process-lock.ts` | DELETE | native service/runtime implementation or its build/test/config assets |
| `services/runner/src/queue.ts` | DELETE | native service/runtime implementation or its build/test/config assets |
| `services/runner/src/service.ts` | DELETE | native service/runtime implementation or its build/test/config assets |
| `services/runner/src/state-journal.ts` | DELETE | native service/runtime implementation or its build/test/config assets |
| `services/runner/src/temp-root.ts` | DELETE | native service/runtime implementation or its build/test/config assets |
| `services/runner/src/types.ts` | DELETE | native service/runtime implementation or its build/test/config assets |
| `services/runner/src/validation.ts` | DELETE | native service/runtime implementation or its build/test/config assets |
| `services/runner/tsconfig.build.json` | DELETE | native service/runtime implementation or its build/test/config assets |
| `services/runner/tsconfig.json` | DELETE | native service/runtime implementation or its build/test/config assets |
| `services/runner/vitest.config.ts` | DELETE | native service/runtime implementation or its build/test/config assets |
| `src/lib/runner/__tests__/runner-isolation-runbook.test.ts` | DELETE | retired native runbook contract |

Expanded inventory: 106 tracked leaves; 7 extraction/coverage candidates, 99 deletion candidates. Test extraction may retain only the shared cases.

## Appendix B — complete explicit reference index

Line numbers use the fetched upstream version where available; otherwise the unchanged local file. Excludes native trees being removed, their evidence subtree, binary/font files and package-lock blobs. Includes native VM telemetry/containment and runtime helper identities as well as direct paths. Each retained row requires semantic review, not automatic deletion. Records and historical commands are deliberately included.

| File | Lines | Disposition |
|---|---|---|
| `.dockerignore` | 40 | KEEP; remove/migrate native portions and preserve shared checks |
| `.env.example` | 47, 48 | KEEP; remove/migrate native portions and preserve shared checks |
| `.github/dependabot.yml` | 18 | KEEP; remove/migrate native portions and preserve shared checks |
| `.github/workflows/ci.yml` | 57, 62, 181, 391, 398, 697, 710, 748, 749, 750, 751, 752, 916, 928, 930, 932, 945, 947, 955, 956, 957, 958, 959, 1015, 1027, 1029, 1105, 1117, 1119, 1125, 1149 | KEEP; remove/migrate native portions and preserve shared checks |
| `.gitignore` | 15 | KEEP; remove/migrate native portions and preserve shared checks |
| `.gitleaks.toml` | 181, 192 | KEEP; remove/migrate native portions and preserve shared checks |
| `CONTINUATION.md` | 414 | Rewrite active guidance or label/archive historical references |
| `Dockerfile` | 137 | KEEP; remove/migrate native portions and preserve shared checks |
| `LearnCoding-Code-Review.md` | 4, 20, 32, 127, 163 | Rewrite active guidance or label/archive historical references |
| `QUALITY_AUDIT.md` | 76 | Rewrite active guidance or label/archive historical references |
| `README.md` | 64, 77 | Rewrite active guidance or label/archive historical references |
| `compose.yaml` | 323, 324, 348, 362, 371, 372, 390, 399, 400, 401, 403, 404, 406, 407, 546, 547, 560, 570, 571, 599, 600, 613, 623, 624, 651, 652, 665, 675, 676, 1116, 1124, 1184, 1185 | KEEP; remove/migrate native portions and preserve shared checks |
| `docs/APP_STATUS.md` | 18 | Rewrite active guidance or label/archive historical references |
| `docs/admin-guide.md` | 60 | Rewrite active guidance or label/archive historical references |
| `docs/dependency-risk.md` | 47 | Rewrite active guidance or label/archive historical references |
| `docs/deployment.md` | 12, 16, 151, 161, 263, 287, 396, 398, 411 | Rewrite active guidance or label/archive historical references |
| `docs/evidence/release-quality-gate-2026-07-12.json` | 170, 174, 178, 182, 186, 480 | Evidence disposition (section 3 / Appendix D) |
| `docs/plans/curriculum-runtime-ci-diagnosis.md` | 21 | DELETE exclusive path (Appendix A) |
| `docs/plans/piston-runner.md` | 12, 13, 84, 175, 252 | Rewrite active guidance or label/archive historical references |
| `docs/release-audit.md` | 43, 60, 61, 227 | Rewrite active guidance or label/archive historical references |
| `docs/runbooks/firewall-and-network.md` | 37, 39, 45, 46, 50, 51 | Rewrite active guidance or label/archive historical references |
| `docs/runbooks/incident-response.md` | 27 | Rewrite active guidance or label/archive historical references |
| `docs/runbooks/logs-and-monitoring.md` | 18 | Rewrite active guidance or label/archive historical references |
| `docs/runbooks/power-loss-recovery.md` | 9, 25, 26, 30, 37, 69 | Rewrite active guidance or label/archive historical references |
| `docs/runbooks/runner-isolation.md` | 5, 18, 20, 22, 30, 33, 37, 38, 63, 73, 74, 84, 93, 98, 103, 115, 116, 118, 150, 151, 156, 160, 164, 170, 191, 193, 195, 212, 215, 220, 222, 228, 251, 253, 260, 263, 264, 265, 270, 272, 274, 278, 312, 313, 314, 315, 318, 342, 365, 366, 374, 419, 424, 426, 427, 488 | DELETE exclusive path (Appendix A) |
| `docs/runbooks/updates-and-rollback.md` | 118 | Rewrite active guidance or label/archive historical references |
| `docs/superpowers/plans/2026-07-14-nuc-runtime-deployment.md` | 451 | Rewrite active guidance or label/archive historical references |
| `docs/superpowers/plans/2026-07-14-runner-nuc-rollout.md` | 33, 34, 35, 36, 37, 38, 40, 72, 85, 116, 117, 118, 119, 124, 133, 166, 167, 168, 175, 176, 177, 178, 180, 182, 186, 194, 198, 204, 205, 206, 207, 215, 216, 217, 218, 219, 248, 265, 322, 323, 357, 458, 459, 480, 481, 482, 492, 539, 541, 544, 551, 552, 564 | DELETE exclusive path (Appendix A) |
| `docs/superpowers/plans/2026-07-15-production-security-release-gate.md` | 62, 130, 131, 141, 144, 180, 247, 248, 249, 250, 251, 316 | Rewrite active guidance or label/archive historical references |
| `docs/superpowers/plans/2026-07-20-ingress-quarantine-recovery.md` | 112, 323 | Rewrite active guidance or label/archive historical references |
| `docs/superpowers/specs/2026-07-14-nuc-production-deployment-design.md` | 168 | Rewrite active guidance or label/archive historical references |
| `eslint.config.mjs` | 21 | KEEP; remove/migrate native portions and preserve shared checks |
| `infra/docker/entrypoint.sh` | 61, 119, 129 | KEEP; remove/migrate native portions and preserve shared checks |
| `infra/env/compose.env.example` | 36 | KEEP; remove/migrate native portions and preserve shared checks |
| `infra/env/runner.env.example` | 5, 11, 12 | DELETE exclusive path (Appendix A) |
| `infra/ops/host-operations-compatibility.py` | 49, 61 | KEEP; remove/migrate native portions and preserve shared checks |
| `infra/ops/install-systemd.sh` | 32 | KEEP; remove/migrate native portions and preserve shared checks |
| `infra/ops/package-release-tree.py` | 49, 50, 165 | KEEP; remove/migrate native portions and preserve shared checks |
| `infra/ops/production-load-browser-journey.py` | 21 | KEEP; remove/migrate native portions and preserve shared checks |
| `infra/ops/production-load-control.py` | 25, 26, 27, 54, 58, 125, 126, 136, 138, 186, 197, 198, 232, 233, 252, 253, 324, 326, 327 | KEEP; remove/migrate native portions and preserve shared checks |
| `infra/ops/recovery-checker.py` | 58, 63, 77, 119, 452, 491, 992, 1226, 1294, 2312 | KEEP; remove/migrate native portions and preserve shared checks |
| `infra/ops/recovery-evidence.py` | 173, 492, 525, 531, 1172, 1184, 1311 | KEEP; remove/migrate native portions and preserve shared checks |
| `infra/ops/redeploy-nuc.sh` | 134 | KEEP; remove/migrate native portions and preserve shared checks |
| `infra/ops/release-production.sh` | 381, 382, 383, 1537, 1558, 1579, 1794, 1815, 1828, 1836, 1847, 1851, 1852, 1888, 2663 | KEEP; remove/migrate native portions and preserve shared checks |
| `infra/ops/rollback-production.sh` | 293, 294, 295, 947, 1000, 1021, 1032, 1042, 1053, 1056, 1057, 1074, 1091, 1094, 1095 | KEEP; remove/migrate native portions and preserve shared checks |
| `infra/ops/smoke-production.sh` | 77, 89, 407, 411, 415 | KEEP; remove/migrate native portions and preserve shared checks |
| `infra/ops/start-production-stack.sh` | 285 | KEEP; remove/migrate native portions and preserve shared checks |
| `infra/ops/validate-runtime.sh` | 433, 511, 617, 624, 694, 695, 696, 701, 702, 708, 709, 710, 712, 738, 739, 743, 768, 770, 775, 788, 790, 794, 801, 832, 833, 835, 849, 850, 851, 852, 853, 854, 881 | KEEP; remove/migrate native portions and preserve shared checks |
| `infra/release/production-executable-entrypoints.json` | 25, 26, 27, 28, 29, 30 | KEEP; remove/migrate native portions and preserve shared checks |
| `infra/runtime/production-load-fixture-runtime.mjs` | 76, 1107, 1216, 1220, 1221, 1306, 1307, 1308, 1311, 1312, 1313 | KEEP; remove/migrate native portions and preserve shared checks |
| `infra/runtime/production-load-test-control-service.mjs` | 5339, 5386, 5437, 5458, 5503, 5772, 5773, 5774, 5790, 5913, 5931, 5967, 5968, 5970, 6168, 6169, 6170, 6368, 6370, 6371, 6441, 6446, 6447, 6518, 6519, 6521, 6541, 6546, 6571, 6572, 6585, 6621, 6622, 6623, 6631, 6632, 6633, 6641, 6643, 6676, 6694, 7234, 7276, 7277 | KEEP; remove/migrate native portions and preserve shared checks |
| `infra/secrets/README.md` | 26 | Rewrite active guidance or label/archive historical references |
| `infra/systemd/learncoding-compose.service` | 4, 5 | KEEP; remove/migrate native portions and preserve shared checks |
| `infra/systemd/learncoding-runner-firewall.service` | 3, 13, 14, 15 | DELETE exclusive path (Appendix A) |
| `infra/systemd/learncoding-runner-guest-firewall.service` | 3, 5, 13, 14, 15 | DELETE exclusive path (Appendix A) |
| `infra/tests/backup-ci-registration.test.mjs` | 889, 892, 897, 1011, 1068, 1073, 1246, 1285, 1286, 1287, 1288, 1289, 1546, 1551, 1882, 1893, 1979, 1982, 1984, 1986, 1990, 1992, 2034, 2037, 2039, 2087, 2090, 2092, 2098, 2120, 3066, 3067 | KEEP; remove/migrate native portions and preserve shared checks |
| `infra/tests/backup-production-e2e.test.sh` | 12, 15, 826, 894 | KEEP; remove/migrate native portions and preserve shared checks |
| `infra/tests/backup-publication.test.sh` | 971, 1612, 2338 | KEEP; remove/migrate native portions and preserve shared checks |
| `infra/tests/fixtures/create-release-tree-fixture.py` | 147, 148 | KEEP; remove/migrate native portions and preserve shared checks |
| `infra/tests/fixtures/production-topology.compose.yaml` | 110, 113, 118, 119, 121, 122, 209, 217 | KEEP; remove/migrate native portions and preserve shared checks |
| `infra/tests/fixtures/run-production-load-peer-credentials-proof.ts` | 92, 93 | KEEP; remove/migrate native portions and preserve shared checks |
| `infra/tests/fixtures/runner-route.compose.yaml` | 23, 24, 26, 29, 30, 32, 33, 45, 46, 54, 55, 57, 58, 74, 82 | DELETE exclusive path (Appendix A) |
| `infra/tests/host-operations-compatibility.test.py` | 82, 149 | KEEP; remove/migrate native portions and preserve shared checks |
| `infra/tests/mail-guarded-delivery-0069-release-rollback-contract.test.mjs` | 112, 133, 144 | KEEP; remove/migrate native portions and preserve shared checks |
| `infra/tests/power-recovery-check.test.sh` | 110, 201, 210, 212, 213, 214, 215, 216, 217, 218, 219, 220, 221, 222, 223, 224, 456, 505, 531, 532, 535, 674, 1133, 1148, 1273, 1320, 1335, 1414, 1418, 1448, 1452, 1458, 1460, 1477, 1513, 1514, 1520, 1530, 1641, 2267, 2268, 2396, 2616, 2620, 2623, 2626, 2629, 2641, 2645 | KEEP; remove/migrate native portions and preserve shared checks |
| `infra/tests/production-topology-ci-registration.test.mjs` | 101, 139, 147, 174, 181, 182, 220, 229 | KEEP; remove/migrate native portions and preserve shared checks |
| `infra/tests/production-topology-hardening.test.mjs` | 50 | KEEP; remove/migrate native portions and preserve shared checks |
| `infra/tests/production-topology.test.sh` | 238, 268, 285, 286, 360, 388, 392, 735, 757, 785 | KEEP; remove/migrate native portions and preserve shared checks |
| `infra/tests/recovery-evidence-collection.test.py` | 266, 267, 268, 269, 271, 346 | KEEP; remove/migrate native portions and preserve shared checks |
| `infra/tests/recovery-evidence-main.test.sh` | 30, 65, 183, 187, 195, 233 | KEEP; remove/migrate native portions and preserve shared checks |
| `infra/tests/recovery-evidence-provenance.test.py` | 95 | KEEP; remove/migrate native portions and preserve shared checks |
| `infra/tests/redeploy-nuc.test.sh` | 205, 223 | KEEP; remove/migrate native portions and preserve shared checks |
| `infra/tests/release-production.test.sh` | 137, 160, 177, 409, 443, 469, 502, 552, 557, 572, 1297, 1298, 1866, 1889, 1900, 1901, 1952, 1989, 2505, 2511, 2517 | KEEP; remove/migrate native portions and preserve shared checks |
| `infra/tests/release-tree-packaging.test.py` | 93, 328, 329 | KEEP; remove/migrate native portions and preserve shared checks |
| `infra/tests/rollback-production.test.sh` | 54, 69, 86, 453, 698, 724, 726, 756, 763, 770, 838, 839, 927, 1088, 1106, 2733, 2743, 2744, 2852, 2856, 2862, 2865, 2880, 2907 | KEEP; remove/migrate native portions and preserve shared checks |
| `infra/tests/runner-egress-gateway-stream-failures.test.mjs` | 9 | DELETE exclusive path (Appendix A) |
| `infra/tests/runner-egress-gateway.test.mjs` | 11, 131, 132, 133 | DELETE exclusive path (Appendix A) |
| `infra/tests/runner-firewall-packets.test.sh` | 21, 24, 25 | DELETE exclusive path (Appendix A) |
| `infra/tests/runner-firewall.test.sh` | 19, 20, 85, 112 | DELETE exclusive path (Appendix A) |
| `infra/tests/runner-guest-installer.test.sh` | 17, 18, 19, 20, 21, 34, 35, 37, 46, 47, 48, 49, 50, 52, 54, 55, 91, 97, 98, 116, 120, 121, 235, 277, 337, 338, 359, 360, 412, 467, 468, 470 | DELETE exclusive path (Appendix A) |
| `infra/tests/runner-reconciliation.test.sh` | 13, 16, 396, 411, 426, 459, 469, 480, 698, 1008, 1026, 1027, 1028, 1031, 1033, 1034, 1036, 1074, 1117, 1118, 1151, 1177, 1197, 1212, 1290, 1298, 1306, 1316, 1326, 1337, 1344, 1353, 1358, 1374, 1382, 1390, 1398, 1414, 1443, 1446, 1468, 1478, 1480, 1490 | DELETE exclusive path (Appendix A) |
| `infra/tests/runner-route-topology.test.mjs` | 66, 103, 105, 108, 119, 121, 124, 127, 150, 166, 170, 187, 192, 193, 212 | DELETE exclusive path (Appendix A) |
| `infra/tests/runner-vm-provision.test.sh` | 11, 12, 13, 14, 15, 16, 99, 106, 107, 135, 182, 193, 198, 200, 206, 223, 224, 249, 265, 270, 311, 314, 315, 322, 411, 427, 436, 437, 559, 563, 856, 1297, 1374, 1389, 1390, 1396, 1397, 1398, 1399, 1418, 1443, 1495 | DELETE exclusive path (Appendix A) |
| `infra/tests/runtime-config.test.sh` | 623, 787, 792, 828, 831, 861, 862, 863, 865, 870, 872, 874, 875, 877, 878, 879, 882, 888, 1160, 1176, 1692, 2008, 2011, 2012, 2014, 2017, 2018, 2035, 2045, 2046, 2051, 2052, 2054, 2058, 2062, 2066 | KEEP; remove/migrate native portions and preserve shared checks |
| `infra/tests/runtime-validator-harness-contract.test.mjs` | 15, 16, 36, 41 | KEEP; remove/migrate native portions and preserve shared checks |
| `infra/tests/runtime-validator-network-fixture.test.sh` | 9, 19, 20, 23, 24, 58, 59, 60, 61, 65, 71, 100, 101, 104, 105, 108, 109, 112, 113 | KEEP; remove/migrate native portions and preserve shared checks |
| `infra/tests/runtime-validator-structure.test.mjs` | 34, 37, 41, 44 | KEEP; remove/migrate native portions and preserve shared checks |
| `infra/tests/smoke-production.test.sh` | 42, 46, 50, 54, 58, 66, 78, 81, 84, 87, 119, 123, 125, 127, 262, 265, 359 | KEEP; remove/migrate native portions and preserve shared checks |
| `infra/tests/start-production-stack-adversarial.test.sh` | 277 | KEEP; remove/migrate native portions and preserve shared checks |
| `infra/tests/start-production-stack.test.sh` | 155 | KEEP; remove/migrate native portions and preserve shared checks |
| `infra/tests/systemd-recovery.test.sh` | 22, 599, 602, 1001, 1377, 1399 | KEEP; remove/migrate native portions and preserve shared checks |
| `infra/tests/test_production_load_browser_journey.py` | 22 | KEEP; remove/migrate native portions and preserve shared checks |
| `infra/tests/test_production_load_control.py` | 41, 42, 60, 61, 68, 70, 71, 72, 118, 119, 156, 157, 173, 182, 183, 184, 206, 213, 214, 215, 217, 253, 254, 280, 281 | KEEP; remove/migrate native portions and preserve shared checks |
| `infra/tests/validate-compose.mjs` | 49, 311, 314, 315, 316, 317, 339, 340, 360, 363, 366, 368, 371, 374, 377, 378, 381, 385, 387, 390, 398, 400, 409, 413, 415, 422, 423, 424, 425, 426, 429, 466, 477, 478, 479, 512, 591, 592 | KEEP; remove/migrate native portions and preserve shared checks |
| `infra/tests/validate-static.mjs` | 158, 160, 161, 197, 202, 203, 204, 205, 206, 207, 208, 209, 210, 212, 213, 214, 215, 287, 442, 508, 518, 519, 693, 696, 754, 755, 757, 778, 779, 965, 972, 1293, 1431, 1484, 1485, 1487, 1520, 1538, 1710, 1743, 1747, 1751, 1763, 1883, 1886, 1944, 1960, 1963, 1964, 1987, 1995, 2160, 2209, 2210, 2216, 2222, 2225, 2226, 2230, 2231, 2235, 2238, 2241, 2244, 2246, 2256, 2257 | KEEP; remove/migrate native portions and preserve shared checks |
| `integration/assessment-correction.integration.test.ts` | 54, 492, 1565, 1566, 1568, 1569, 1707, 1708, 1709, 1710, 1732, 1733, 1734, 1735, 1824, 1825, 1826, 1827 | KEEP; remove/migrate native portions and preserve shared checks |
| `load/README.md` | 22, 23, 24, 25 | Rewrite active guidance or label/archive historical references |
| `package.json` | 13, 89, 90 | KEEP; remove/migrate native portions and preserve shared checks |
| `scripts/__tests__/verify-import-boundaries.test.ts` | 199, 200, 201, 204 | KEEP; remove/migrate native portions and preserve shared checks |
| `scripts/app-images/application-image-operations.mjs` | 11 | KEEP; remove/migrate native portions and preserve shared checks |
| `scripts/app-images/application-image-operations.test.mjs` | 383 | KEEP; remove/migrate native portions and preserve shared checks |
| `scripts/app-images/manage-application-images.mjs` | 31 | KEEP; remove/migrate native portions and preserve shared checks |
| `scripts/apply-c-cpp-executable-tranche.ts` | 29 | KEEP; remove/migrate native portions and preserve shared checks |
| `scripts/apply-web-executable-tranche.ts` | 210 | KEEP; remove/migrate native portions and preserve shared checks |
| `scripts/backup/backup.sh` | 22 | KEEP; remove/migrate native portions and preserve shared checks |
| `scripts/backup/verify-archive.sh` | 278 | KEEP; remove/migrate native portions and preserve shared checks |
| `scripts/ci/gitleaks.test.mjs` | 14 | KEEP; remove/migrate native portions and preserve shared checks |
| `scripts/generate-authored-ai-tranche.ts` | 12 | KEEP; remove/migrate native portions and preserve shared checks |
| `scripts/generate-authored-java-python-tranche.ts` | 23 | KEEP; remove/migrate native portions and preserve shared checks |
| `scripts/generate-dsa-language-parity.ts` | 70 | KEEP; remove/migrate native portions and preserve shared checks |
| `scripts/lib/curriculum-runtime-pin-sync.ts` | 1 | KEEP; remove/migrate native portions and preserve shared checks |
| `scripts/lib/curriculum-verifier-immutable-reference.test.ts` | 13 | KEEP; remove/migrate native portions and preserve shared checks |
| `scripts/lib/evidence-integrity.ts` | 79 | KEEP; remove/migrate native portions and preserve shared checks |
| `scripts/lib/local-runtime-config-authentication.test.ts` | 8, 16, 112, 115, 124, 143, 144 | KEEP; remove/migrate native portions and preserve shared checks |
| `scripts/lib/local-runtime-identity.test.ts` | 8 | KEEP; remove/migrate native portions and preserve shared checks |
| `scripts/lib/local-runtime-resolution.test.ts` | 7, 13, 67, 70, 74 | KEEP; remove/migrate native portions and preserve shared checks |
| `scripts/lib/production-load-cli.test.ts` | 55 | KEEP; remove/migrate native portions and preserve shared checks |
| `scripts/lib/production-load-config.test.ts` | 38 | KEEP; remove/migrate native portions and preserve shared checks |
| `scripts/lib/production-load-config.ts` | 19, 95, 96, 97, 114 | KEEP; remove/migrate native portions and preserve shared checks |
| `scripts/lib/production-load-control-service.test.ts` | 68, 76, 93, 94, 96, 139 | KEEP; remove/migrate native portions and preserve shared checks |
| `scripts/lib/production-load-control-service.ts` | 130, 131, 133, 193, 211, 233, 243, 253, 369, 385, 396, 406 | KEEP; remove/migrate native portions and preserve shared checks |
| `scripts/lib/production-load-control.test.ts` | 29, 30 | KEEP; remove/migrate native portions and preserve shared checks |
| `scripts/lib/production-load-control.ts` | 126, 127, 150, 151 | KEEP; remove/migrate native portions and preserve shared checks |
| `scripts/lib/production-load-disposable-runtime.test.ts` | 24, 141, 142 | KEEP; remove/migrate native portions and preserve shared checks |
| `scripts/lib/production-load-disposable-runtime.ts` | 159 | KEEP; remove/migrate native portions and preserve shared checks |
| `scripts/lib/production-load-evidence.test.ts` | 36, 65 | KEEP; remove/migrate native portions and preserve shared checks |
| `scripts/lib/production-load-fault-journal.test.ts` | 63, 72, 80, 82, 117, 179, 247, 429 | KEEP; remove/migrate native portions and preserve shared checks |
| `scripts/lib/production-load-fault-journal.ts` | 25, 34, 81, 87, 151, 322, 323, 334, 352, 460 | KEEP; remove/migrate native portions and preserve shared checks |
| `scripts/lib/production-load-faults.test.ts` | 94, 125, 126, 149, 170 | KEEP; remove/migrate native portions and preserve shared checks |
| `scripts/lib/production-load-fixture-operations.test.ts` | 26, 172, 183, 185, 279, 282, 299 | KEEP; remove/migrate native portions and preserve shared checks |
| `scripts/lib/production-load-fixture-operations.ts` | 175, 176, 177, 179, 180, 258, 261 | KEEP; remove/migrate native portions and preserve shared checks |
| `scripts/lib/production-load-fixture-runtime.test.ts` | 29, 64, 65, 66, 108, 109, 171, 172, 173, 175, 176, 179, 218, 219 | KEEP; remove/migrate native portions and preserve shared checks |
| `scripts/lib/production-load-fixture-runtime.ts` | 64, 65, 66, 69, 70, 197, 198, 199 | KEEP; remove/migrate native portions and preserve shared checks |
| `scripts/lib/production-load-fixture-server.test.ts` | 30, 63, 64, 65 | KEEP; remove/migrate native portions and preserve shared checks |
| `scripts/lib/production-load-fixture-server.ts` | 19, 155, 159, 160, 251, 252, 253, 256, 257, 258 | KEEP; remove/migrate native portions and preserve shared checks |
| `scripts/lib/production-load-host-cancellation.test.ts` | 29, 43, 108, 109, 111 | KEEP; remove/migrate native portions and preserve shared checks |
| `scripts/lib/production-load-host-isolation.test.ts` | 18, 19, 21, 38, 44, 48, 93, 94, 164 | KEEP; remove/migrate native portions and preserve shared checks |
| `scripts/lib/production-load-host.test.ts` | 72, 73, 74, 81, 85, 96, 106, 155, 156, 158, 174, 175, 177, 187, 196, 206, 216, 226 | KEEP; remove/migrate native portions and preserve shared checks |
| `scripts/lib/production-load-host.ts` | 42, 43, 57, 66, 111, 214, 223, 276, 277, 279, 280, 282, 283, 284, 285, 529, 530, 536, 546, 547, 559, 562, 601, 602, 612, 613, 643, 644, 656, 659, 671, 706, 718, 719, 762, 767, 768, 770, 799, 802 | KEEP; remove/migrate native portions and preserve shared checks |
| `scripts/lib/production-load-http-accounting.test.ts` | 69, 70 | KEEP; remove/migrate native portions and preserve shared checks |
| `scripts/lib/production-load-http.test.ts` | 50, 51 | KEEP; remove/migrate native portions and preserve shared checks |
| `scripts/lib/production-load-journaled-system-cancellation.test.ts` | 24 | KEEP; remove/migrate native portions and preserve shared checks |
| `scripts/lib/production-load-journaled-system.test.ts` | 40, 41, 42, 49, 53, 69, 111, 120 | KEEP; remove/migrate native portions and preserve shared checks |
| `scripts/lib/production-load-journaled-system.ts` | 58, 60, 76, 83, 101, 103, 104, 110, 111, 119, 120, 123, 124, 127, 128, 146, 147, 170, 171, 174, 176 | KEEP; remove/migrate native portions and preserve shared checks |
| `scripts/lib/production-load-linux-backend.test.ts` | 54, 55, 106, 110, 268, 269, 271, 280, 284, 316, 353, 354, 391, 396, 424, 432, 433, 488, 576 | KEEP; remove/migrate native portions and preserve shared checks |
| `scripts/lib/production-load-linux-backend.ts` | 56, 57, 59, 130, 262, 263, 281, 282, 412, 415, 416, 556, 561, 593, 623, 624, 643, 644, 664, 665, 668, 670, 689, 690, 718, 722, 756 | KEEP; remove/migrate native portions and preserve shared checks |
| `scripts/lib/production-load-orchestrator.test.ts` | 51 | KEEP; remove/migrate native portions and preserve shared checks |
| `scripts/lib/production-load-orchestrator.ts` | 119 | KEEP; remove/migrate native portions and preserve shared checks |
| `scripts/lib/production-load-reporting.test.ts` | 80, 81, 136 | KEEP; remove/migrate native portions and preserve shared checks |
| `scripts/lib/production-load-run-manifest.test.ts` | 34, 44, 63 | KEEP; remove/migrate native portions and preserve shared checks |
| `scripts/lib/production-load-run-manifest.ts` | 16, 52, 70, 126, 128, 130 | KEEP; remove/migrate native portions and preserve shared checks |
| `scripts/lib/production-load-socket.test.ts` | 30, 41 | KEEP; remove/migrate native portions and preserve shared checks |
| `scripts/lib/production-load-terminal-evidence.test.ts` | 40 | KEEP; remove/migrate native portions and preserve shared checks |
| `scripts/lib/production-load-test-control-server.test.ts` | 32, 33, 43, 44, 104, 105, 134, 135, 143, 144, 297, 298, 347, 348, 355, 356, 358, 365, 370, 372, 374, 375, 378, 387, 415, 416, 424, 425, 433, 434, 441, 442, 444, 449, 450, 452, 457, 458, 460, 467, 468, 470, 479, 489, 522, 566, 575, 576, 577, 578, 599, 600, 605, 606, 610, 611, 615, 674, 675 | KEEP; remove/migrate native portions and preserve shared checks |
| `scripts/lib/production-load-test-control-server.ts` | 17, 18, 20, 43, 49, 62, 72, 73, 80, 81, 89, 90, 99, 100, 121, 122, 173, 174, 189, 230, 235, 236, 241, 244, 245, 261, 262, 270, 271, 316, 317, 318, 348, 349 | KEEP; remove/migrate native portions and preserve shared checks |
| `scripts/lib/production-load-test-control-service.test.ts` | 62, 95, 158, 159 | KEEP; remove/migrate native portions and preserve shared checks |
| `scripts/lib/production-load-test-control-service.ts` | 150, 197, 198 | KEEP; remove/migrate native portions and preserve shared checks |
| `scripts/lib/production-load-workload.test.ts` | 33, 34, 175, 176 | KEEP; remove/migrate native portions and preserve shared checks |
| `scripts/lib/provider-parity-fixtures.ts` | 8, 9, 10, 47, 48 | KEEP; remove/migrate native portions and preserve shared checks |
| `scripts/pinned-curriculum-runtime.ts` | 72 | KEEP; remove/migrate native portions and preserve shared checks |
| `scripts/smoke-local-runner.ts` | 10, 13, 14, 15 | DELETE exclusive path (Appendix A) |
| `scripts/sync-curriculum-runtime-pins.ts` | 12, 50, 51, 52 | KEEP; remove/migrate native portions and preserve shared checks |
| `scripts/verify-ai-code-tasks.ts` | 11, 19, 91 | KEEP; remove/migrate native portions and preserve shared checks |
| `scripts/verify-authenticated-learn-runtime.ts` | 2417, 2419 | KEEP; remove/migrate native portions and preserve shared checks |
| `scripts/verify-c-cpp-executable-tranche.ts` | 22, 153, 212, 323 | KEEP; remove/migrate native portions and preserve shared checks |
| `scripts/verify-dsa-language-parity.ts` | 19, 133, 219 | KEEP; remove/migrate native portions and preserve shared checks |
| `scripts/verify-email-outbox-writer-inventory.mjs` | 171 | KEEP; remove/migrate native portions and preserve shared checks |
| `scripts/verify-java-python-code-tasks.ts` | 17, 26, 136 | KEEP; remove/migrate native portions and preserve shared checks |
| `scripts/verify-web-executable-tranche.ts` | 31, 270, 527, 659 | KEEP; remove/migrate native portions and preserve shared checks |
| `src/app/api/exams/_lib/piston-publication.test.ts` | 17 | KEEP; remove/migrate native portions and preserve shared checks |
| `src/app/api/exams/_lib/provider-parity.test.ts` | 102 | KEEP; remove/migrate native portions and preserve shared checks |
| `src/lib/assessment-corrections/__tests__/provider-parity.test.ts` | 55 | KEEP; remove/migrate native portions and preserve shared checks |
| `src/lib/content/__tests__/c-cpp-executable-tranche.test.ts` | 69 | KEEP; remove/migrate native portions and preserve shared checks |
| `src/lib/github/__tests__/reviewer.test.ts` | 27 | KEEP; remove/migrate native portions and preserve shared checks |
| `src/lib/performance/__tests__/load-report.test.ts` | 23, 219, 220, 256, 257, 296, 297, 393, 504, 505, 725, 740, 753, 768, 808, 825, 835 | KEEP; remove/migrate native portions and preserve shared checks |
| `src/lib/performance/load-report.ts` | 70, 111, 162, 220, 246, 294, 369, 370, 413, 414, 415, 416 | KEEP; remove/migrate native portions and preserve shared checks |
| `src/lib/release/__tests__/evidence-integrity.test.ts` | 15 | KEEP; remove/migrate native portions and preserve shared checks |
| `src/lib/rewards/__tests__/worker-wiring.test.ts` | 44, 49 | KEEP; remove/migrate native portions and preserve shared checks |
| `src/lib/runner/__tests__/client.test.ts` | 16, 515, 516, 519, 520 | KEEP; remove/migrate native portions and preserve shared checks |
| `src/lib/runner/__tests__/piston-client.test.ts` | 14, 15, 16, 403, 404, 419, 420 | KEEP; remove/migrate native portions and preserve shared checks |
| `src/lib/runner/__tests__/runner-isolation-runbook.test.ts` | 6, 71, 73 | DELETE exclusive path (Appendix A) |
| `src/lib/runner/client.ts` | 359, 572, 573 | KEEP; remove/migrate native portions and preserve shared checks |
| `src/lib/storage/__tests__/object-root-provisioning-wiring.test.ts` | 91 | KEEP; remove/migrate native portions and preserve shared checks |
| `tsconfig.json` | 44 | KEEP; remove/migrate native portions and preserve shared checks |
| `scripts/lib/runtime-dependencies.ts` | 47, 72, 91 | KEEP; remove/migrate native portions and preserve shared checks |
| `scripts/lib/runtime-dependencies.test.ts` | 29, 31, 36, 61, 62, 65, 66 | KEEP; remove/migrate native portions and preserve shared checks |

Index contains 186 files. Also review provider selection (`CODE_RUNNER_PROVIDER`), legacy snapshot eligibility, and Piston-only defaults in section 2; these are semantic dependencies beyond native path literals.

## Appendix C — exact native env-name discovery

These names occur in tracked native implementation/configuration/ops files. Distinguish deployment env reads from same-named constants when editing. Native publication tool `RUNTIME_*` controls retire with its tooling; retain generic image-security acceptance logic when shared. Piston controls remain.

```text
RUNNER_ADMIN_SSH_PUBLIC_KEY_FILE
RUNNER_AUTH_MAX_SKEW_SECONDS
RUNNER_BASE_IMAGE_PATH
RUNNER_BASE_IMAGE_SHA256
RUNNER_BASE_URL
RUNNER_BUILDX_PACKAGE_VERSION
RUNNER_COMPOSE_PACKAGE_VERSION
RUNNER_CONTAINERD_PACKAGE_VERSION
RUNNER_DOCKER_BINARY
RUNNER_DOCKER_CE_PACKAGE_VERSION
RUNNER_DOCKER_CLI_PACKAGE_VERSION
RUNNER_DOCKER_KEY_SHA256
RUNNER_GATEWAY_LISTEN_HOST
RUNNER_GATEWAY_LISTEN_PORT
RUNNER_GATEWAY_UPSTREAM
RUNNER_GRYPE_ARCHIVE_SHA256
RUNNER_GRYPE_VERSION
RUNNER_HOST
RUNNER_IDEMPOTENCY_CAPACITY
RUNNER_IDEMPOTENCY_TTL_SECONDS
RUNNER_IMAGE_
RUNNER_IMAGE_C
RUNNER_IMAGE_CPP
RUNNER_IMAGE_JAVA
RUNNER_IMAGE_JAVASCRIPT
RUNNER_IMAGE_KEYS
RUNNER_IMAGE_PYTHON
RUNNER_MAX_BODY_BYTES
RUNNER_MAX_CONCURRENCY
RUNNER_MAX_QUEUE_DEPTH
RUNNER_MAX_SOURCE_BYTES
RUNNER_MAX_SOURCE_FILES
RUNNER_MAX_TESTS
RUNNER_NODEJS_PACKAGE_VERSION
RUNNER_NODESOURCE_KEY_SHA256
RUNNER_NONCE_TTL_SECONDS
RUNNER_OPTION_KEYS
RUNNER_PORT
RUNNER_PROCESS_LOCK_FD
RUNNER_PROCESS_LOCK_HELD
RUNNER_RELEASE_MANIFEST_SHA256
RUNNER_RESTART_RECOVERED
RUNNER_SHARED_SECRET
RUNNER_SHARED_SECRET_FILE
RUNNER_STATE_ROOT
RUNNER_SYFT_ARCHIVE_SHA256
RUNNER_SYFT_VERSION
RUNNER_TEMP_ROOT
RUNNER_TEST_IMAGE_C
RUNNER_TEST_IMAGE_CPP
RUNNER_TEST_IMAGE_JAVA
RUNNER_TEST_IMAGE_JAVASCRIPT
RUNNER_TEST_IMAGE_PYTHON
RUNNER_TRIVY_ARCHIVE_SHA256
RUNNER_TRIVY_VERSION
RUNTIME_BASE_
RUNTIME_BASE_C
RUNTIME_BASE_CPP
RUNTIME_BASE_JAVA
RUNTIME_BASE_JAVASCRIPT
RUNTIME_BASE_PYTHON
RUNTIME_COSIGN_CERTIFICATE_IDENTITY
RUNTIME_COSIGN_CERTIFICATE_OIDC_ISSUER
RUNTIME_DEPENDENCY_OF
RUNTIME_ERROR
RUNTIME_IMAGE
RUNTIME_LOCAL_RISK_ACCEPTANCE
RUNTIME_PACKAGES
RUNTIME_PACKAGES_
RUNTIME_PACKAGES_C
RUNTIME_PACKAGES_CPP
RUNTIME_PACKAGES_JAVA
RUNTIME_PUSH
RUNTIME_RECORD_LANGUAGES
RUNTIME_RECORD_LOCAL
RUNTIME_RELEASE
RUNTIME_REPOSITORY
RUNTIME_SOURCE_DATE_EPOCH
RUNTIME_SOURCE_REPOSITORY
RUNTIME_SOURCE_REVISION
RUNTIME_TRIVY_CACHE_DIR
```

## Appendix D — evidence binding and native-claim ledger

This expands JSON evidence records whose keys/values bind edited runner/deployment/image/curriculum sources, retired artifacts, or explicitly claim native runtime/queue behavior. Anchors refer to historical source bytes; evidence artifact references always require retained current artifacts. Unrelated evidence is outside the deletion set. No hashes were regenerated in this task.

| Evidence record | Source anchor | Relevant bindings / claims | Planned treatment |
|---|---|---|---|
| `docs/evidence/ai-code-executable-runtime-2026-07-12.json` | none | `imageEvidence` | MIGRATE/REGENERATE affected curriculum runtime/structure/identity evidence; retain semantic/browser proof. |
| `docs/evidence/ai-code-executable-structure-2026-07-12.json` | none | `imageEvidence` | MIGRATE/REGENERATE affected curriculum runtime/structure/identity evidence; retain semantic/browser proof. |
| `docs/evidence/ai-provider-settings-ci-pins-2026-10-01.json` | `eff3228fecdea158833b224275b5c49b9d1d921c` | `Dockerfile`<br>`scripts/verify-database-runtime-capabilities.mjs`<br>`scripts/verify-database-runtime-capabilities.test.mjs`<br>`scripts/verify-restored-backup-authority.test.ts`<br>`scripts/verify-restored-backup.test.ts`<br>`scripts/verify-restored-backup.ts` | KEEP historical source pins; new current proof separately. Artifact references still bind current bytes. |
| `docs/evidence/ai-provider-settings-migrator-schema-2026-10-01.json` | `eff3228fecdea158833b224275b5c49b9d1d921c` | `scripts/verify-database-runtime-capabilities.test.mjs` | KEEP historical source pins; new current proof separately. Artifact references still bind current bytes. |
| `docs/evidence/auth-recovery-verification-2026-07-12.json` | `a5e5b1838b0f0ff48e54af4ed1789af70d2d07d5` | `compose.yaml` | KEEP historical source pins; new current proof separately. Artifact references still bind current bytes. |
| `docs/evidence/backup-status-outbox-2026-07-12.json` | `247ce38d62cce6ae97cee04e162c9d25e85f5b8e` | `compose.yaml`<br>`node --test scripts/backup/enqueue-backup-status.test.mjs scripts/verify-backup-status-mail-authority.test.mjs`<br>`scripts/verify-backup-status-mail-authority.mjs`<br>`scripts/verify-backup-status-mail-authority.test.mjs`<br>`scripts/verify-database-role-boundaries.mjs` | KEEP historical source pins; new current proof separately. Artifact references still bind current bytes. |
| `docs/evidence/c-cpp-executable-runtime-2026-07-12.json` | none | `imageEvidence` | MIGRATE/REGENERATE affected curriculum runtime/structure/identity evidence; retain semantic/browser proof. |
| `docs/evidence/c-cpp-executable-structure-2026-07-12.json` | none | `imageEvidence` | MIGRATE/REGENERATE affected curriculum runtime/structure/identity evidence; retain semantic/browser proof. |
| `docs/evidence/docker-release-runtime-verification-2026-07-12.json` | none | `runnerReleaseContract` | KEEP mixed historical app/backup proof; separate/replace native claims. |
| `docs/evidence/dsa-parity-declaration-2026-07-12.json` | none | `runtimeDigests` | MIGRATE/REGENERATE affected curriculum runtime/structure/identity evidence; retain semantic/browser proof. |
| `docs/evidence/dsa-parity-runtime-2026-07-12.json` | none | `imageEvidence` | MIGRATE/REGENERATE affected curriculum runtime/structure/identity evidence; retain semantic/browser proof. |
| `docs/evidence/dsa-parity-structure-2026-07-12.json` | none | `imageEvidence` | MIGRATE/REGENERATE affected curriculum runtime/structure/identity evidence; retain semantic/browser proof. |
| `docs/evidence/exm-003-006-008-reliability-2026-07-12.json` | `718666b84c99cde07fe33bcff9d91b755ff535b5` | `src/lib/runner/admission.ts`<br>`src/lib/runner/client.ts` | KEEP historical source pins; new current proof separately. Artifact references still bind current bytes. |
| `docs/evidence/java-python-executable-runtime-2026-07-12.json` | none | `imageEvidence` | MIGRATE/REGENERATE affected curriculum runtime/structure/identity evidence; retain semantic/browser proof. |
| `docs/evidence/java-python-executable-structure-2026-07-12.json` | none | `imageEvidence` | MIGRATE/REGENERATE affected curriculum runtime/structure/identity evidence; retain semantic/browser proof. |
| `docs/evidence/release-quality-gate-2026-07-12.json` | none | `docs/evidence/container-security/runner/runner-inventory.json`<br>`docs/evidence/container-security/runner/runtime-contract-report.json`<br>`docs/evidence/container-security/runner/runtime-executor-report.json`<br>`docs/evidence/container-security/runner/runtime-images.json`<br>`docs/evidence/container-security/runner/runtime-inspection.json`<br>`runnerVerification` | REVIEW/REGENERATE current summary; replace removed native artifact references and scope. |
| `docs/evidence/run-002-practice-runner-2026-07-12.json` | none | `queueEvidence` | KEEP historical practice proof; fresh Piston queue/recovery proof for current claims. |
| `docs/evidence/run-008-official-runner-fairness-2026-07-12.json` | `718666b84c99cde07fe33bcff9d91b755ff535b5` | `npx vitest run src/lib/runner/__tests__/admission.test.ts src/lib/runner/__tests__/client.test.ts src/app/api/code/run/__tests__/route.test.ts --maxWorkers=1`<br>`src/lib/runner/admission.ts`<br>`src/lib/runner/client.ts` | KEEP historical source pins; new current proof separately. Artifact references still bind current bytes. |

## Inspection limitations and completion

The inventory covers tracked native trees and references on the stated baseline; upstream comparison did not change the native trees. Current versions of new runtime dependency guards were fetched explicitly. Local checkout synchronization was unavailable, but remote fork/upstream equality was verified through GitHub. No live database/VM/registry audit was performed, so the zero-legacy-lineage and rollout prerequisites remain future release gates, not assertions of this report. No tests or evidence apply commands were run: this task changes no application code, and some contract tests create fixture commits or manipulate host services. Final repository status was checked clean. Stop after delivering this file.
