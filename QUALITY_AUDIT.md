# Quality, deployment, and recovery audit

Audited revision: 73951e68a3307a9967589358c5646bd3a61c402c
Branch at audit start: main
Audit date: 2026-07-22
Disposition: REQUEST CHANGES

## Scope and method

This was a read-only audit of CI and test configuration, coverage, dependencies, Docker/Compose/systemd topology, release and rollback automation, image provenance, runner integration, performance evidence, backups, restore, operations, and deployment runbooks.

No repository files were changed by the audit lane. No test, build, dependency install, online advisory scan, container, backup, restore, or external deployment command was executed. Historical artifacts were used only as diagnostics and are not promoted to current evidence. Findings refer to the exact audited Git object above.

No P0 issue was found. The revision is not release-ready. The infrastructure design is strongly fail-closed in many places, but the operator path and several recovery gates are internally contradictory.

## P1 release blockers

### QA-REL-001 — No complete accepted evidence is bound to the audited commit

- Evidence: docs/release-audit.md:8-30 and CONTINUATION.md record no accepted combined check, PostgreSQL, browser, runner-image, Linux infrastructure, clean-checkout build, or hosted-CI result for the checkpoint. docs/evidence/release-quality-gate-2026-07-12.json:515-523 labels itself historical/local.
- Impact: historical or partial output cannot prove the exact candidate.
- Required resolution: after repository fixes, freeze one clean exact-SHA candidate and retain immutable artifacts containing commit, tree, command/config, runtimes, expected inventory, results/skips, coverage, and image identities.
- Proving gate: reject dirty/mismatched/partial/stale evidence; retrieve a complete accepted run by exact SHA.

### QA-DEP-001 — Database-secret deployment instructions cannot pass preflight

- Evidence: docs/deployment.md:134-156 and infra/secrets/README.md:12-28 create only postgres_password and database_url. infra/ops/validate-runtime.sh:384-441 also requires database_bootstrap_url, database_migrator_url, database_worker_url, and database_ops_url. infra/ops/validate-database-secrets.mjs:8-13,25-112 enforces exact users, independent passwords, and raw-byte control-character rules. The runbook's openssl redirection adds a terminal newline that the validator rejects.
- Impact: paste-ready first deployment deterministically fails; using the superuser URL as a workaround defeats least privilege.
- Required fix: document safe creation of all five URLs with independent passwords and one consistent secret terminator policy.
- Proving gate: replay the exact documented commands in a disposable root-owned fixture, pass full preflight, bootstrap roles, and prove the positive/negative role matrix. Include newline, embedded-whitespace, duplicate-password, and wrong-user cases.

### QA-DEP-002 — Cloudflare installation instructions contradict the validator

- Evidence: docs/deployment.md:120-126 installs mode 0644; infra/ops/validate-runtime.sh:304-325 requires canonical root:root 0640; infra/tests/cloudflare-runtime-config.test.sh:100-104 proves 0644 rejection. The runbook also uses relative source paths without changing to /opt/learncoding.
- Impact: an operator following the runbook fails before startup.
- Required fix: install root:root 0640 using absolute reviewed paths or explicitly enter the checkout.
- Proving gate: run the fragment from a neutral directory and pass; mutations for 0644, hard link, symlink, wrong credential path/host/catch-all must fail.

### QA-RBK-001 — Standalone rollback rejects the artifact produced by release

- Evidence: infra/ops/release-production.sh:727-738 includes file-erasure-worker and :957-963 emits it in previous-runtime.override.yaml. infra/ops/rollback-production.sh:514-557 and :915-925 omit/reject it. infra/tests/rollback-production.test.sh:67-88 repeats the stale inventory.
- Impact: emergency rollback aborts after ingress quarantine, extending outage and failing to restore the erasure worker.
- Required fix: generate release, rollback, smoke, evidence, and tests from one canonical runtime-service manifest.
- Proving gate: feed an unchanged real release record to standalone rollback and prove every service identity, both smoke phases, and quarantine clearance.

### QA-RBK-002 — Rollback combines previous images with current configuration and mixed provenance

- Evidence: infra/ops/rollback-production.sh:874-939,988-992 uses the current Compose and operations scripts with an image-only previous override. :713-768 records previous Git/tree beside current manifest/firewall/runner artifacts. docs/runbooks/updates-and-rollback.md:82-95 runs from the current checkout.
- Impact: after command/env/mount/network/topology changes, old images may start under incompatible current configuration; active evidence can describe mixed versions.
- Required fix: retain and verify the complete previous release tree/configuration, or explicitly model and test a separate compatible host-operations provenance layer.
- Proving gate: change command, env, mount, network, and policy in a candidate. Rollback must reproduce previous configuration or fail before mutation, with consistent post-rollback provenance.

### QA-BKP-001 — Bulk offsite transfers have a two-minute total deadline

- Evidence: infra/env/backup.env.example:26-27 sets RCLONE_OPERATION_TIMEOUT_SECONDS=120. scripts/backup/common.sh:450-463 applies it to every rclone operation, including complete upload/readback/download in offsite-sync.sh:52-68 and fetch-offsite.sh:93-105. Systemd permits four hours.
- Impact: realistic production archives can never complete over slower links.
- Required fix: separate short metadata-operation deadlines from size/bandwidth-aware bulk-transfer deadlines, while retaining idle/progress bounds and the service budget.
- Proving gate: upload, read back, download, decrypt, and restore a production-sized archive over the worst supported link. Timeout injection must publish no success pointer and must alert.

### QA-BKP-002 — Daily offsite sync cannot satisfy a six-hour freshness threshold

- Evidence: infra/env/backup.env.example enables MAX_OFFSITE_AGE_HOURS=6. learncoding-offsite-sync.timer runs daily, while learncoding-backup-check.timer checks every six hours. check-backups.sh:180-197 marks data older than six hours critical.
- Impact: healthy operation reports critical staleness for much of every day.
- Required fix: either publish at least every six hours or set freshness to daily cadence plus jitter and worst-case runtime. Keep RPO distinct from polling frequency.
- Proving gate: simulate 48 hours; healthy daily publication remains green and one genuinely missed publication alerts within policy.

### QA-LOAD-001 — Retained load proof measures redirects instead of application work

- Evidence: scripts/load-projection-smoke.ts:42-58 uses manual redirects, cancels bodies, and accepts 2xx/3xx. :90-109 gates only error rate and p95. docs/evidence/load-smoke-final-app-5df2dd02e136-20260713.json records protected routes passing with 307.
- Impact: the result measures neither authenticated rendering, response transfer, DB work, browser hydration, runner latency/queueing, nor NUC resources.
- Required fix: authenticated fixtures, expected final route/status/body, consumed responses, browser metrics, runner lanes, and exact commit/tree/image/runtime provenance.
- Proving gate: protected scenarios end at asserted content and report p50/p95/p99 plus NUC resource/thermal data for ten simulated learners and two runner jobs.

### QA-RUN-001 — Live runner guest identity is not bound to the candidate record

- Evidence: infra/ops/release-production.sh:1138-1161 retains a host record, but infra/ops/smoke-production.sh:342-350 accepts any syntactically valid job digest. services/runner/src/service.ts:248-262 health does not report the runtime-record identity; job digest comes from guest configuration.
- Impact: a stale but functional guest can pass readiness before ingress opens.
- Required fix: expose a non-secret canonical/signed record ID and exact runtime identities from the guest; compare them before tunnel startup.
- Proving gate: a stale functional guest fails internal readiness and leaves ingress quarantined; exact candidate runtime passes.

## P2 material issues

| ID | Finding | Required direction |
|---|---|---|
| QA-COV-001 | Root coverage has thresholds but no production-source include set, so never-imported files disappear from the denominator. | Define explicit production inclusion/exclusions or a separate source-inventory gate; an unimported fixture must appear at 0%. |
| QA-COV-002 | Runner coverage thresholds exist but npm/CI never enables coverage and has no source include set. | Run coverage in CI, retain the artifact, and make uncovered runner source fail. |
| QA-SUP-001 | Registry mutation occurs before main/CI/label uniqueness/sign/scan acceptance. Digest-pinned records mitigate deployment, so this is P2 rather than three P1s. | Fail before login/push unless exact main SHA has required CI; enforce label uniqueness; use candidate namespace and signed promotion bundle. |
| QA-EVD-001 | Fixed output filenames allow partial runs to overwrite final-looking artifacts; CI does not retain root/Postgres/browser reports. | Use SHA/job/attempt-scoped output, upload with always(), and advance an accepted pointer only after inventory validation. |
| QA-PERF-001 | Every authenticated tab polls a mutating/heavy exam catalog every 15 seconds. | Add a lightweight indexed active-session endpoint, eliminate idle writes, and use visibility-aware backoff/push plus single-flight. |
| QA-IMG-001 | Tooling/workers copy the full Next/React/browser production dependency graph. | Split workspaces/lockfiles or bundle minimal externals; enforce image-size and SBOM allowlists. |
| QA-BKP-003 | Backup health check uses a nonblocking shared lock, so a healthy long backup can trigger a critical alert. | Bounded wait or neutral in-progress state; alert only after a stuck bound. |
| QA-OPS-001 | Paste-ready backup runbook omits learncoding-restore-drill-reminder.timer. | Make installer authoritative or list/verify the exact complete timer set. |
| QA-UPL-001 | Upload-enabled release/smoke/shutdown/rollback inventories omit ClamAV/scan-worker semantics. | Keep disabled for pilot; add profile-aware lifecycle and complete full-mode proof before promotion. |

## P3 hardening and reproducibility

| ID | Finding | Direction |
|---|---|---|
| QA-NODE-001 | Node 22 deployment typechecks with Node 26 types; runner support/runtime/type versions also diverge. | Pin types to deployed major and test every advertised minimum. |
| QA-TOOL-001 | Docker/BuildKit and some apt tools float; container scans depend on source activity; audit severities differ. | Pin/allowlist tools, schedule scans, and use owned time-bounded exceptions. |
| QA-CACHE-001 | tsbuildinfo is ignored by Git but included in Docker context. | Add *.tsbuildinfo to .dockerignore and prove a no-source typecheck preserves context/cache identity. |
| QA-BUNDLE-001 | QR library is eagerly loaded; Monaco public assets use an unversioned path without proven immutable caching. | Lazy-load QR; version Monaco URLs by package/content digest and verify cache headers. |
| QA-DOC-001 | Pilot learner count, internal product name, and a cloudflared restart exception are inconsistent across docs/config. | Align launch-critical literals and add documentation/config contract tests. |

## Requirement-to-evidence status

| Requirement area | Status at audited revision | Remaining proof |
|---|---|---|
| Exact source / clean checkout | Blocked | One accepted complete exact-SHA run |
| Independent CI jobs | Structurally implemented | Hosted exact-SHA execution and retained outputs |
| Unit/service coverage | Partial | Complete source denominator and accepted artifact |
| Runner coverage | Blocked | Enable coverage and include production source |
| Auth/API boundary | Strong static foundation | Runtime matrix plus backend audit blockers |
| PostgreSQL integration | Structurally present | Accepted disposable DB run |
| Database least privilege | Operationally blocked | Correct secret runbook and live negative probes |
| Immutable images | Partial/strong digest design | Main/CI promotion and signed scan/provenance binding |
| Compose hardening | Strong static design | Exact pinned-Compose target-host run |
| App readiness | Structurally implemented | Target-host DB failure/recovery proof |
| Runner/KVM | Partial | Live identity binding and adversarial guest evidence |
| Cloudflare | Operationally blocked | Correct runbook plus external DNS/tunnel/direct-path proof |
| Backup/offsite/restore | Blocked | Timing fixes plus production Drive restore/RPO/RTO |
| Systemd/power recovery | Partial | Real reboot and supervised AC-loss evidence |
| Emergency rollback | Blocked | Inventory/config fixes and target rehearsal |
| Pilot uploads disabled | Structurally implemented | Full mode remains separate and blocked |
| Gmail/OAuth | External | Live OAuth, delivery, retry/outage and mail-domain evidence |
| Performance/capacity | Blocked | Authenticated target-host load and thermal/resource proof |
| Accessibility/devices | Partial | Exact-SHA matrix and manual assistive/physical-device proof |
| Curriculum release | Manual/external | Independent human approval and exam eligibility |

## Confirmed strengths

- Compose uses digest-pinned images, no published application/database/runner ports, internal networks, non-root users, read-only roots, dropped capabilities, PID/resource limits, and bounded logs.
- Public ingress is fail-closed: internal services and smoke precede tunnel start, and failures preserve durable quarantine.
- Liveness and database-backed readiness are separated.
- CI jobs are independent, so one red lane does not structurally skip PostgreSQL, runner, curriculum, authenticated-browser, or browser jobs.
- GitHub actions are full-SHA pinned; checkout credentials are not persisted; npm lockfiles and npm ci are used.
- Image construction binds repository, commit, tree, archive, platform, and immutable OCI identities.
- Backup publication encrypts, checksums, reads back bytes, attests an immutable point, and publishes its pointer last.
- Rollback forbids pull/build, verifies recorded image identities, quarantines ingress early, and requires smoke before reopening.
- Runner traffic is isolated behind a secretless fixed-network gateway and a dedicated KVM guest design.
- Historical evidence is candidly labelled historical/local rather than claimed as current production proof.

## Unverified and external gates

- No complete clean-checkout check, lint/typecheck/coverage/build, disposable PostgreSQL, full browser, authenticated durability, online advisory, image/SBOM/scan/sign, Linux infrastructure, backup/restore, or power-recovery command was run by this audit lane.
- Actual NUC Docker/Compose/systemd behavior, disk/SMART/temperature, firmware AC recovery, KVM isolation, Cloudflare account/DNS/tunnel, Gmail/Google OAuth and SPF/DKIM/DMARC, production-sized Drive restore, recovery media, alerts, external security review, physical accessibility/device checks, and curriculum approval remain external.
- Any previously exposed credential must be revoked and regenerated; this report did not inspect or reuse it.

## Release decision

Do not deploy this revision to learners. Fix the pilot-relevant P1 items, prove each fix with focused tests, freeze one exact candidate, run the complete automated matrix, and then perform the explicitly external NUC, Cloudflare, Gmail, Drive, restore, reboot, and supervised power-loss gates.
