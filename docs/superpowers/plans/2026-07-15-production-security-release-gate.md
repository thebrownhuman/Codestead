# Codestead Production Security Release-Gate Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to execute this plan task-by-task. Every finding repair uses superpowers:test-driven-development and receives a fresh independent review. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove that the exact Codestead release candidate is safe enough for the invite-only NUC pilot through reproducible static, dynamic, database, browser, runner, container, recovery, load, and chaos testing, and remediate every release-blocking finding before learner access is enabled.

**Architecture:** Audit the exact committed release candidate in layers, starting with non-mutating repository scans and manual trust-boundary review, then disposable local/Compose/KVM targets, and only then the dedicated Codestead NUC stack. Raw evidence stays in `.superpowers/security/${AUDIT_SHA}/`; a sanitized report tied to the exact commit records commands, hashes, findings, repairs, and external gates without credentials or private learner data.

**Tech Stack:** Next.js 16, React 19, TypeScript, Better Auth, Drizzle, PostgreSQL 17, Docker Compose 5, Playwright, Vitest, Semgrep, Gitleaks, Trivy, Bash, systemd, libvirt/KVM, age, rclone.

## Global Constraints

- The approved deployment source of truth is `docs/superpowers/specs/2026-07-14-nuc-production-deployment-design.md`.
- Authorized targets are this repository, disposable loopback test stacks, the dedicated Codestead KVM guest, and the dedicated Codestead NUC Compose project after deployment approval.
- Existing NUC services, containers, networks, host tunnel, reverse proxy, and data are out of scope and must not be scanned disruptively or modified.
- No denial-of-service, destructive query, destructive filesystem action, credential harvesting, persistence, lateral movement, or data exfiltration is permitted.
- Active tests use synthetic users and synthetic data. No real learner, provider, Gmail, Cloudflare, Google Drive, NVIDIA, or 21st.dev credential may enter evidence.
- Previously pasted credentials are treated as compromised and must never be reused.
- Pilot uploads remain disabled; ClamAV remains outside the default profile.
- Untrusted code executes only inside the dedicated KVM guest.
- A Critical or High finding blocks release. An exploitable Medium affecting authentication, authorization, secrets, runner isolation, backup recovery, or data integrity also blocks release until repaired and independently re-reviewed.
- Scanner output alone is not acceptance evidence. Authentication/authorization, input handling, crypto/key boundaries, runner isolation, and recovery require manual review and dynamic proof.
- External NUC, Cloudflare, Gmail, Drive, reboot, and physical-power claims remain unfinished until the exact action is observed and recorded.
- Security findings use only `Critical`, `High`, `Medium`, `Low`, and `Informational`. `Critical`/`Important`/`Minor` vocabulary is reserved for pre-execution plan review and is never used to classify a vulnerability or release risk.
- Only the designated Codestead product owner/NUC administrator, never the executing agent or a scanner, may accept a residual risk. An acceptance is valid only while its recorded review date has not expired.

## Rules of engagement and evidence contract

- Canonical candidate: the detached disposable `${AUDIT_CHECKOUT}` defined by the immutable candidate protocol; no audit command runs from the developer workspace.
- Raw output directory: `${EVIDENCE_ROOT}` in the original repository, physically outside the detached candidate checkout.
- Sanitized committed report: `docs/production-security-review.md`.
- Automated-command evidence records include `record_type=automated`, UTC start/end timestamps, full Git SHA and tree hash, exact argv and working directory, safety class, exact target identity, host/OS, tool and rules/database versions, exit status, stdout/stderr artifact paths, and SHA-256 for every raw artifact.
- Manual/external-observation evidence records include `record_type=manual`, observer, approver, maintenance/change-window ID, exact target/configuration identity, UTC start/end timestamps, expected result, observed result, redacted artifact path and SHA-256, status `PASS | FAIL | NOT_RUN | N/A`, and an invalidation rule. A manual record never receives a fabricated command or exit code.
- Evidence must redact cookies, authorization headers, email addresses, database URLs, tokens, provider keys, TOTP seeds, recovery codes, and backup identities.
- A finding includes ID, severity/CVSS, CWE/OWASP mapping, exact file/line or endpoint, safe reproduction, impact, repair, regression test, verification command, and status.
- Any command that could contact a non-loopback target requires a target assertion, one of the safety classes below, and explicit `*_ALLOW_REMOTE=1`; the default is refusal.
- Each accepted residual-risk record includes finding ID, accountable product owner, rationale, compensating controls, UTC approval date, UTC expiry/review date, and concrete reassessment triggers (dependency/image change, topology change, affected-code change, incident, or new exploit intelligence). Missing owner, expired approval, or a triggered-but-unreviewed acceptance blocks the pilot.

### Immutable candidate protocol

Before Task 1, execute the following from the repository root and save the output under the raw evidence directory:

```bash
set -euo pipefail
REPO_ROOT="$(git rev-parse --show-toplevel)"
AUDIT_SHA="$(git rev-parse HEAD)"
AUDIT_PARENT="$(cd "${REPO_ROOT}/.." && pwd)/.codestead-security-audit/${AUDIT_SHA}"
AUDIT_CHECKOUT="${AUDIT_PARENT}/candidate"
EVIDENCE_ROOT="${REPO_ROOT}/.superpowers/security/${AUDIT_SHA}"
mkdir -p "${AUDIT_PARENT}" "${EVIDENCE_ROOT}"
test ! -e "${AUDIT_CHECKOUT}"
git worktree add --detach "${AUDIT_CHECKOUT}" "${AUDIT_SHA}"
git -C "${AUDIT_CHECKOUT}" submodule update --init --recursive
test -z "$(git -C "${AUDIT_CHECKOUT}" status --porcelain=v1 --untracked-files=all)"
test -z "$(git -C "${AUDIT_CHECKOUT}" status --porcelain=v1 --untracked-files=all --ignored=matching)"
git -C "${AUDIT_CHECKOUT}" diff --quiet
git -C "${AUDIT_CHECKOUT}" diff --cached --quiet
test -z "$(git -C "${AUDIT_CHECKOUT}" submodule status --recursive | sed -n '/^[+-U]/p')"
git -C "${AUDIT_CHECKOUT}" rev-parse HEAD > "${EVIDENCE_ROOT}/candidate-commit.txt"
git -C "${AUDIT_CHECKOUT}" rev-parse 'HEAD^{tree}' > "${EVIDENCE_ROOT}/candidate-tree.txt"
git -C "${AUDIT_CHECKOUT}" ls-tree -r --full-tree HEAD > "${EVIDENCE_ROOT}/candidate-ls-tree.txt"
sha256sum "${AUDIT_CHECKOUT}/package-lock.json" "${AUDIT_CHECKOUT}/services/runner/package-lock.json" > "${EVIDENCE_ROOT}/lockfiles.sha256"
git -C "${AUDIT_CHECKOUT}" submodule status --recursive > "${EVIDENCE_ROOT}/submodules.txt"
```

Tasks 1-7 read source only from `${AUDIT_CHECKOUT}`. A command that needs writable build/install output runs in a one-shot sandbox populated by `git -C "${AUDIT_CHECKOUT}" archive --format=tar HEAD`; the canonical checkout is mounted read-only and raw evidence is written only to `${EVIDENCE_ROOT}`. Before and after every task, require both empty-status assertions (including ignored paths), clean staged/unstaged diffs, clean submodules, `git rev-parse HEAD` and `HEAD^{tree}` equal to the recorded values, recomputed matching lockfile hashes, and byte-for-byte matching recursive submodule status. Any mismatch invalidates all evidence collected after the last clean assertion, stops the audit, and requires a new candidate checkout.

### Target safety classes

| Class | Permitted target and actions | Mandatory guard |
|---|---|---|
| `DISPOSABLE_ONLY` | Loopback/ephemeral database, container, temporary filesystem, dedicated rclone test prefix, or isolated libvirt network; fault injection, resource exhaustion, pruning, disk-full, process termination, and provider/tunnel outage simulation occur only here. | Record disposable resource IDs and cleanup command; refuse any production hostname, volume, database, Drive prefix, or LAN address. |
| `NUC_READ_ONLY` | Inventory, version, health, listener, configuration-render, metrics, log, SMART/NVMe, and unrelated-service baseline checks on the approved NUC. | Match the recorded host fingerprint; no restart, write, probe beyond owned endpoints, or configuration mutation. |
| `CODESTEAD_PROJECT_ONLY` | Start/recreate/stop or write synthetic data only inside the exact Codestead Compose project, Codestead volumes, dedicated tunnel, dedicated VM, and dedicated backup test prefix. | Assert Compose project name, Git/image identities, VM UUID/MAC, volume/root paths, fresh recovery-point ID, maintenance window, and pre/post unrelated-service inventory; abort if any unrelated identity changes. Never restart host Docker/libvirt or fill the host root filesystem. |
| `HUMAN_SUPERVISED` | Firmware inspection, credential/account policy review, controlled reboot, and the single approved physical AC-removal rehearsal. | Administrator performs the physical/account action; automation only prepares, observes, and collects evidence. Require written approval, maintenance window, fresh verified recovery point, abort/rollback plan, and post-action unrelated-service comparison. |

Runner denial fixtures target owned canary listeners in the isolated runner network, never actual LAN services. Disk-pressure tests use quota-backed loop devices or bounded temporary filesystems, never the NUC root disk. Backup retention/pruning uses a dedicated temporary local root and dedicated rclone prefix, never production recovery points.

### Verdict and external-gate model

Task 1 creates `${EVIDENCE_ROOT}/external-gates.csv` with these exact columns:

```text
gate_id,mandatory_when,owner,target_config_identity,status,artifact_sha256,observed_at_utc,invalidation_rule,notes
```

Allowed status values are `PASS`, `FAIL`, `NOT_RUN`, and `N/A`. `N/A` requires product-owner approval and a concrete configuration fact (for example, Google sign-in is disabled); it cannot be used for a mandatory pilot dependency. The ledger contains, at minimum, these rows:

| Gate ID | Mandatory condition | Required proof |
|---|---|---|
| `EXT-CREDENTIAL-REVOCATION` | Always | Every credential previously exposed in chat is revoked; fresh production credentials have new provider-side identifiers without recording values. |
| `EXT-CLOUDFLARE-ACCOUNT` | Always | Account MFA/recovery, least-privilege tunnel token scope, token rotation, DNS-change alerting, dedicated hostname/tunnel identity, and external origin/port scan. |
| `EXT-GMAIL-DNS-DELIVERY` | Gmail enabled (pilot default) | Gmail OAuth identity/scope, invitation delivery, SPF/DKIM/DMARC results, and bounce/suppression handling. |
| `EXT-GOOGLE-OAUTH` | Google sign-in enabled | Exact client/callback/origin, consent screen, minimal scopes, MFA/recovery, and real approved-user sign-in. |
| `EXT-NIM-PROVIDER` | AI tutor enabled | Production-authorized endpoint/model and terms record, live health/circuit-breaker/fallback test, consented destination, and approved quality canary; this resolves `TM-AI-009`. |
| `EXT-DRIVE-RESTORE` | Always | Drive account MFA/recovery/quota, dedicated prefix, upload, independent download, checksum/decrypt, isolated restore, and credential-recovery proof. |
| `EXT-KVM-NUC` | Always | Recorded NUC fingerprint, KVM guest identity/resources/private network/firewall, exact deployed SHA/images, and unrelated-service baseline. |
| `EXT-CONTROLLED-REBOOT` | Always | Reboot recovery and public readiness evidence with no unrelated-service regression. |
| `EXT-PHYSICAL-AC-LOSS` | Once before first invitation, then only under the invalidation rule below | Administrator-supervised power removal, automatic startup, acknowledged-marker preservation, exact-once reconciliation, and readiness within 15 minutes. |

The report emits two separate verdicts:

1. `REPOSITORY SECURITY VERDICT = PASS | FAIL`: may be `PASS` when all repository/disposable gates are complete and mandatory external rows are honestly `NOT_RUN`.
2. `PILOT RELEASE VERDICT = GO | HOLD`: is `GO` only when the repository verdict is `PASS`, every mandatory external row is `PASS`, no blocking finding remains, and every residual acceptance is current. Any mandatory `FAIL` or `NOT_RUN` forces `HOLD`; learner invitations and uploads remain disabled.

---

### Task 1: Freeze the candidate and map the attack surface

**Files:**
- Read: `docs/threat-model.md`
- Read: `docs/security-authorization-verification.md`
- Read: `docs/release-audit.md`
- Read: `src/lib/security/api-authorization-matrix.ts`
- Create at execution: `${EVIDENCE_ROOT}/scope.md`
- Create at completion: `docs/production-security-review.md`

- [ ] **`DISPOSABLE_ONLY`:** Execute the immutable candidate protocol, then record `git rev-parse HEAD`, `git rev-parse 'HEAD^{tree}'`, `git status --porcelain=v1 --untracked-files=all`, staged/unstaged diffs, recursive submodule status, both lockfile hashes, `node --version`, `npm.cmd --version`, `docker version`, `docker compose version`, and operating-system details from `${AUDIT_CHECKOUT}`.
- [ ] **`DISPOSABLE_ONLY`:** Refuse to begin unless the detached checkout has empty porcelain output, clean staged/unstaged diffs, no `-`, `+`, or `U` recursive submodule state, exact recorded tree/lockfile hashes, and no pre-existing ignored build/dependency output. Regenerated authorization/import evidence becomes a new committed candidate and new SHA; it is never written into this checkout.
- [ ] **`DISPOSABLE_ONLY`:** Enumerate every `src/app/api/**/route.ts`, Better Auth endpoint, health endpoint, worker, database role, secret, volume, Compose service/profile/network, systemd unit/timer, Cloudflare ingress, runner RPC, backup destination, browser durability store, external provider, and operator-only action.
- [ ] **`DISPOSABLE_ONLY`:** Reconcile the enumeration against `src/lib/security/api-authorization-matrix.ts`, `docs/threat-model.md`, the deployment design, and every final Compose render. Any unclassified route, table, object type, secret, or trust crossing is a release-blocking finding.
- [ ] **`DISPOSABLE_ONLY`:** Write the rules of engagement, target classes, immutable candidate IDs, exact authorized disposable resource IDs, and refusal conditions into `${EVIDENCE_ROOT}/scope.md`; create the external-gate ledger with all required rows initialized to `NOT_RUN`.
- [ ] **`DISPOSABLE_ONLY`:** Re-run the candidate clean-state assertions after enumeration. A changed candidate file, new untracked path, submodule drift, or lockfile/tree mismatch invalidates the task rather than being normalized or ignored.

**Pass condition:** every externally reachable or privilege-crossing surface has an owner, actor set, data classification, expected denial behavior, and named verification command.

### Task 2: Run automated repository, dependency, secret, and IaC scans

**Files:**
- Read: `package.json`, `package-lock.json`, `services/runner/package-lock.json`
- Read: `Dockerfile`, `services/runner/Dockerfile`, `services/runner/runtime/Dockerfile`
- Read: `infra/docker-compose.production.yml`, `infra/systemd/**`, `infra/cloudflare/**`
- Test: `scripts/scan-secrets.ts`
- Test: `scripts/verify-api-auth-surface.ts`
- Test: `infra/tests/validate-static.mjs`
- Test: `infra/tests/validate-compose.mjs`

- [ ] **`DISPOSABLE_ONLY`:** Before installing anything, parse both lockfiles and fail unless every package has an integrity hash and every `resolved` URL is HTTPS on the approved `registry.npmjs.org` host; inventory Git/file dependencies, native addons, and every root/package lifecycle script into `${EVIDENCE_ROOT}/dependency-preinstall.json`. Run lockfile-only OSV/npm-advisory analysis without loading package code.
- [ ] **`DISPOSABLE_ONLY`:** Pin `NODE_AUDIT_IMAGE` and the audit egress-proxy image to identities matching `^.+@sha256:[0-9a-f]{64}$`. For each lockfile, populate an empty Docker volume from `git archive HEAD`, then run the first `npm ci --ignore-scripts` as UID/GID `65532:65532` in a disposable container with an empty synthetic home, no host bind mounts, no SSH/cloud/config mounts, no Docker/libvirt/KVM sockets/devices, all capabilities dropped, `no-new-privileges`, read-only container root, bounded PID/CPU/RAM/tmpfs, and no default/host network. Attach it only to a dedicated internal Docker network whose sole egress peer is the pinned proxy; the proxy allowlist permits DNS plus HTTPS to `registry.npmjs.org:443` and rejects every other host/port. Record the proxy configuration/hash and DNS/connection/rejection logs; any non-registry attempt fails the gate.
- [ ] **`DISPOSABLE_ONLY`:** From the script-disabled install, inventory and manually review all lifecycle scripts, executable package bins, native builds, and install-time downloads. Only after review, clone the volume/cache into a second one-shot container with `--network none` and run the full `npm ci --offline`; fail if it requests network or accesses a path/socket outside its disposable volumes. Repeat independently for the root and runner lockfiles, then destroy both volumes and containers.
- [ ] **`DISPOSABLE_ONLY`:** In fresh archive-derived sandboxes, run `npm.cmd run security:dependencies:known`, `npm.cmd audit --audit-level=moderate`, and `npm.cmd --prefix services/runner audit --omit=dev --audit-level=high`; audit network calls use the same pinned registry-only proxy/no-secret/no-socket boundary, and package execution is permitted only in the reviewed no-network lifecycle sandbox above.
- [ ] **`DISPOSABLE_ONLY`:** Run `npm.cmd run security:secrets`, `npm.cmd run security:encoding`, `npm.cmd run security:api-surface`, and `npm.cmd run architecture:check` against the immutable candidate or a fresh archive-derived sandbox.
- [ ] **`DISPOSABLE_ONLY`:** Run Gitleaks against the candidate tree and `--all` Git history; record Gitleaks binary hash/version/config hash and review every match rather than suppressing by filename.
- [ ] **`DISPOSABLE_ONLY`:** Run Semgrep `p/security-audit`, `p/owasp-top-ten`, and automatic TypeScript rules against `src`, `scripts`, and `services/runner/src`; save the resolved rules and their SHA-256 plus Semgrep version, registry identity, and retrieval timestamp so a remote ruleset change cannot silently alter evidence.
- [ ] **`DISPOSABLE_ONLY`:** Update and record Trivy vulnerability-database/Java-database metadata and hashes, then run filesystem vulnerability/secret/config scans against the exact committed tree. Run `node infra/tests/validate-static.mjs`, render every supported Compose profile, and run `node infra/tests/validate-compose.mjs` against each render.
- [ ] **`DISPOSABLE_ONLY`:** For every image and externally retrieved audit artifact, record registry/repository identity, digest, SBOM hash, builder/source provenance, and signature/attestation verification (`cosign verify`/`cosign verify-attestation` or the registry-native equivalent) where published. Absence or failed verification creates a named supply-chain residual risk requiring the accountable acceptance contract; a digest alone proves identity, not origin.
- [ ] **`DISPOSABLE_ONLY`:** Manually inspect scanner suppressions, exclusions, workflow permissions, unpinned actions/images, shell interpolation, unsafe downloads, broad mounts, published ports, capabilities, root users, mutable tags, debug flags, and secret-bearing build arguments. Re-run the canonical candidate clean-state assertions after all scans.

**Pass condition:** zero unresolved Critical/High dependency, secret, SAST, container, or IaC findings; every suppression has a narrow documented rationale and regression assertion; both installs obey the script-disabled-then-reviewed/no-network sequence; and every available signature/attestation plus scanner database/ruleset identity is captured. Missing provenance is an explicit owned residual risk, never an implicit pass.

### Task 3: Audit authentication, authorization, sessions, MFA, CSRF, and privileged ceremonies

**Files:**
- Read: `src/lib/auth.ts`
- Read: `src/lib/http/authz.ts`
- Read: `src/lib/security/**`
- Read: `src/app/api/**/route.ts`
- Test: `src/lib/security/__tests__/**`
- Test: `src/app/api/**/__tests__/*.test.ts`
- Test: `e2e/access.spec.ts`
- Test: `e2e/admin-credentials.spec.ts`
- Add only when a gap is proven: focused route, integration, or Playwright regression tests beside the affected boundary

- [ ] **`DISPOSABLE_ONLY`:** Run `npm.cmd run test:auth-boundary` in a fresh archive-derived no-secret sandbox and require all endpoint matrix rows to be current and passing.
- [ ] **`DISPOSABLE_ONLY`:** Manually review every route for authentication, role, active-account/MFA status, fresh-MFA/reason checks, object ownership, cohort visibility, state-changing method, CSRF/origin protection, rate limiting, idempotency, audit logging, and bounded error output.
- [ ] **`DISPOSABLE_ONLY`:** Exercise anonymous, pending, learner A, learner B, stale-MFA admin, and fresh-MFA admin identities against every endpoint; verify anonymous/other-user/admin-only denials and no private response-body differences that enable enumeration.
- [ ] **`DISPOSABLE_ONLY`:** Test invitation single-use/expiry/concurrency, password reset, Google first-account creation denial, mandatory TOTP, recovery-code one-use, lost-device flow, one-device enforcement, session replay/revocation, 30-day expiry, and cross-tab logout.
- [ ] **`DISPOSABLE_ONLY`:** Test CSRF and origin/header spoofing on every state-changing cookie-authenticated route.
- [ ] **`DISPOSABLE_ONLY`:** Test IDOR by replacing every user, session, credential, thread, project, exam, appeal, certificate, plan, request, and file identifier with another synthetic user’s ID.
- [ ] **`DISPOSABLE_ONLY`:** Test mass assignment and content-type confusion using unexpected admin/owner/status/quota fields, duplicate JSON keys, empty bodies, oversized bodies, malformed UTF-8, and non-JSON bodies.
- [ ] **`DISPOSABLE_ONLY`:** Test privileged provider-key reveal: ordinary masking, fresh MFA, reason, immutable audit event, learner notification, no-store response, no logs/export leakage, and exact denial after freshness expires.

**Pass condition:** the full actor/resource matrix denies every unauthorized combination, privileged ceremonies are attributable and non-replayable, and no auth result depends on an unreadable response body or client claim.

### Task 4: Audit injection, SSRF, XSS, files, AI boundaries, and sensitive-output handling

**Files:**
- Read: all request schemas and route handlers under `src/app/api`
- Read: `src/lib/ai/**`, `src/lib/storage/**`, `src/lib/security/sensitive-text.ts`
- Read: `src/lib/security/credential-vault.ts`, `src/lib/security/lost-device-recovery.ts`, `src/lib/auth.ts`, `services/runner/src/auth.ts`, `scripts/backup/create-credential-probe.ts`
- Test: affected route/unit/integration files
- Test when the sub-gate is absent or incomplete: `src/lib/security/__tests__/crypto-boundary.test.ts`, `integration/crypto-boundary.integration.test.ts`
- Add only when a gap is proven: a minimal regression fixture beside the vulnerable parser or sink

- [ ] **`DISPOSABLE_ONLY`:** Search for raw SQL fragments, dynamic identifiers, `dangerouslySetInnerHTML`, URL fetches, shell/process execution, filesystem joins, archive extraction, deserialization, redirects, log interpolation, and unbounded regex/input loops.
- [ ] **`DISPOSABLE_ONLY`:** Safely test SQL/NoSQL-style metacharacters, HTML/SVG/script payloads, path traversal/encoded traversal, CRLF, template injection, command separators, prototype pollution keys, and oversized nested JSON against disposable endpoints.
- [ ] **`DISPOSABLE_ONLY`:** Test every server-side URL consumer against owned loopback canaries that emulate link-local, RFC1918, IPv6-local, alternate-IP, redirect, DNS-rebinding, and unsupported-scheme cases; never contact a real metadata, LAN, or unrelated-service endpoint.
- [ ] **`DISPOSABLE_ONLY`:** Verify CSP/security headers, React output encoding, redirect allowlists, download `Content-Disposition`, MIME sniffing controls, and absence of internal stacks/SQL/schema/hidden-test/provider detail in errors.
- [ ] **`DISPOSABLE_ONLY`:** Verify uploads fail closed while `UPLOADS_ENABLED=false`, scanner services are absent from the default profile, and file routes cannot be used for traversal, quota bypass, MIME spoofing, cross-user access, or executable delivery.
- [ ] **`DISPOSABLE_ONLY`:** Run prompt-injection and data-exfiltration canaries through tutor/project-review inputs; verify hidden tests, other-user context, keys, email/legal identity, and administrator fallback credentials never enter provider payloads or model-visible errors.

#### Crypto/key-boundary sub-gate

- [ ] **`DISPOSABLE_ONLY`:** Create `${EVIDENCE_ROOT}/crypto-key-boundaries.json`. Inventory password hashing, Better Auth signing/session material, invitation/reset/recovery tokens, TOTP/backup codes, lost-device proof, deletion tombstone authentication, provider-credential AES-GCM envelope encryption, runner HMAC, backup `age` recipient/identity, credential recovery probe, and every configured secret. Each entry records primitive/algorithm, approved library and version, key owner, entropy/source, storage boundary, consumers, purpose/AAD schema, ciphertext/token version, rotation path, recovery path, and forbidden co-residents.
- [ ] **`DISPOSABLE_ONLY`:** Manually trace each primitive from generation through storage/use/rotation/deletion. Require Better Auth’s reviewed scrypt configuration (or a separately approved replacement), unique password salts, bounded rehash behavior, ≥256-bit random invitation/reset/recovery tokens stored only as hashes, AES-GCM with CSPRNG-unique nonces and owner/purpose/version AAD, and timing-safe MAC/token comparison. Fail on custom cryptographic construction, non-CSPRNG material, nonce reuse risk, unauthenticated ciphertext, plaintext token storage, ordinary string equality, plaintext/key logging, or one key serving two security domains.
- [ ] **`DISPOSABLE_ONLY`:** Run deterministic negative fixtures that flip each header/ciphertext/tag bit class, truncate every envelope boundary, substitute learner owner/purpose/AAD, substitute unknown/old/new key versions, replay an authenticated runner request, reuse a one-time invitation/reset/recovery token, and present tokens immediately before/at/after expiry. Every case must fail closed without a distinguishable plaintext, oracle, partial mutation, or secret-bearing log.
- [ ] **`DISPOSABLE_ONLY`:** Generate at least 100,000 envelopes/tokens with a fixed test harness that records only nonce/token hashes; require 100,000 unique nonces/tokens, documented CSPRNG use, and no deterministic nonce derived from owner/time/counter alone. This collision regression supplements, rather than replaces, source review.
- [ ] **`DISPOSABLE_ONLY`:** Rotate each versioned test key from version N to N+1; require new writes use N+1, authorized old records decrypt only while N remains configured, wrong-version records fail, and rewrap does not alter owner/purpose/AAD. Restore an encrypted backup plus separately held recovery identity into the isolated drill stack and decrypt only the known credential probe.
- [ ] **`DISPOSABLE_ONLY`:** Compare SHA-256 fingerprints, never secret bytes, for Better Auth secret, credential KEK, lost-device/deletion keys, runner secret, backup recipient/identity, and recovery-kit material; require all security-domain fingerprints to differ and verify the credential KEK/backup identity are excluded from database/normal backup payloads as designed.

**Pass condition:** all untrusted input reaches typed validation and safe sinks, all remote destinations are consented/allowlisted, secret/private/hidden material is absent from client/provider/logs/errors, and the crypto/key sub-gate proves approved libraries, CSPRNG uniqueness, fail-closed authentication, one-use/expiry/replay binding, versioned rotation/recovery, purpose/owner AAD binding, and key separation without exposing key or plaintext bytes.

### Task 5: Audit PostgreSQL authorization, concurrency, integrity, recovery, and performance

**Files:**
- Read: `src/db/schema.ts`, `src/db/migrations/**`, `drizzle/**`
- Read: `src/lib/db/**`
- Test: `integration/*.integration.test.ts`
- Test runner: `scripts/run-integration-tests.ts`
- Add only when a gap is proven: `integration/security-boundary.integration.test.ts`

- [ ] **`DISPOSABLE_ONLY`:** Start the disposable digest-pinned PostgreSQL 17 integration container and run migrations twice.
- [ ] **`DISPOSABLE_ONLY`:** Run `npm.cmd run test:integration` with a fresh database and require every real-engine test to pass.
- [ ] **`DISPOSABLE_ONLY`:** Inspect database roles/grants so the app cannot migrate/administer, the migration role is not used at runtime, backup access is read-only where applicable, and auth/credential/audit tables are not broadly exposed.
- [ ] **`DISPOSABLE_ONLY`:** Produce `${EVIDENCE_ROOT}/postgres-private-table-rls.json` by reconciling every table/entity classified private in the schema, API authorization matrix, and threat model with `pg_class`, `pg_namespace`, `pg_roles`, `information_schema.role_table_grants`, and `pg_policies`. Record table owner, `relrowsecurity`, `relforcerowsecurity`, every policy command/role/USING/WITH CHECK expression, `PUBLIC` grants, runtime-role grants, and `rolbypassrls`.
- [ ] **`DISPOSABLE_ONLY`:** Fail if any private table is absent from the inventory, RLS is disabled, a required SELECT/INSERT/UPDATE/DELETE command has no policy, `PUBLIC` has access, the runtime role owns a protected table or has `BYPASSRLS`, or a policy trusts an identity value that an HTTP/database client can set without a server-authenticated transaction binding. If the candidate intentionally lacks RLS, record a release-blocking finding; application route predicates are not equivalent evidence.
- [ ] **`DISPOSABLE_ONLY`:** Under `SET ROLE` for the real runtime role with `row_security=on`, seed learner A, learner B, administrator, and cohort-visible controls. In separate transactions bound through the production identity-context mechanism, directly attempt SELECT/INSERT/UPDATE/DELETE from learner A against learner B rows for every private table/command; require zero returned/affected unauthorized rows, unchanged row hashes/counts after denial, and successful same-owner/admin operations only where the matrix permits them. Repeat with missing, stale, malformed, and client-forged identity context.
- [ ] **`DISPOSABLE_ONLY`:** Inspect every raw SQL call for parameters, identifier allowlists, transaction boundaries, isolation level, lock ordering, bounded retries, uniqueness, foreign keys, check constraints, and tenant/owner predicates.
- [ ] **`DISPOSABLE_ONLY`:** Run concurrent invitation claim, session/device claim, idempotency receipt, exam finalization, reward/mastery, provider budget, backup marker, and worker lease races at least 100 times each against PostgreSQL.
- [ ] **`DISPOSABLE_ONLY`:** Inject transaction aborts and connection loss before/after each durable effect; require no duplicate official result, reward, debit, notification, invitation, or submission.
- [ ] **`DISPOSABLE_ONLY`:** Use `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` on the highest-volume learner/admin/worker queries with representative synthetic data; record sequential scans, lock waits, row estimates, and p95 latency.
- [ ] **`DISPOSABLE_ONLY`:** Verify backup/restore preserves constraints, ownership, RLS enable/force flags and policies, extensions, migration journal, encrypted credential bytes, audit history, and sequence values without exposing plaintext secrets.

**Pass condition:** least-privilege non-owning/non-`BYPASSRLS` runtime roles, complete forced RLS coverage for every private table/command, direct cross-user denial with unchanged state, parameterized access, invariant-preserving concurrency, idempotent recovery, clean real-engine tests, and no release-blocking query/lock behavior at pilot scale.

### Task 6: Audit browser durability and cross-user storage isolation

**Files:**
- Read: `src/lib/browser-durability/**`
- Read: `src/lib/drafts/**`
- Read: `src/lib/exams/use-durable-exam-outbox.ts`
- Test: the Browser Tasks 1–6 unit/component matrix
- Test: `e2e/assurance.spec.ts`, `e2e/practice.spec.ts`, and the persistent-profile crash/relaunch specification from Browser Task 6

- [ ] **`DISPOSABLE_ONLY`:** Run the complete browser durability unit/component matrix with fake timers disabled for race-sensitive cases and repeat each concurrency regression in fresh processes.
- [ ] **`DISPOSABLE_ONLY`:** Run Chromium, Firefox, WebKit, tablet Safari, and mobile Safari Playwright projects from a clean built application.
- [ ] **`DISPOSABLE_ONLY`:** Use a real disposable persistent Chromium profile to prove lesson drafts and exam answers survive process kill/reopen and synchronize exactly once.
- [ ] **`DISPOSABLE_ONLY`:** Test logout, revoke-all, password reset, 401/403, closed-book 423, terminal exam, user switch, namespace switch, multiple tabs, delayed BroadcastChannel messages, quota failure, IndexedDB-open failure, transaction abort, stale response, and crash during tombstone compaction.
- [ ] **`DISPOSABLE_ONLY`:** Verify learner A data cannot appear after learner B signs in on the same browser profile and terminal/denial cleanup cannot erase or lock the newly selected namespace.
- [ ] **`DISPOSABLE_ONLY`:** Inspect IndexedDB, localStorage, sessionStorage, Cache Storage, service workers, browser logs, and network traces for tokens, provider keys, hidden tests, other-user records, and stale recoverable data.

**Pass condition:** acknowledged local records survive their documented crash boundary exactly once, authority boundaries prevent resurrection, and cross-user/browser storage leakage is zero.

### Task 7: Audit runner VM, job API, sandbox escape, and resource abuse

**Files:**
- Read: `services/runner/src/**`
- Read: `services/runner/runtime/**`
- Read: `infra/runner/**`, `infra/runner-vm/**`, `infra/tests/runner-*.test.sh`
- Test: `services/runner/src/__tests__/**`
- Test: `services/runner/runtime/test-runner-executor.mjs`

- [ ] **`DISPOSABLE_ONLY`:** Run runner typecheck, unit tests, build, runtime image build/inspection, and exact runtime contract tests in an archive-derived sandbox.
- [ ] **`DISPOSABLE_ONLY`:** Provision the disposable KVM guest with 4 vCPU, 8 GiB RAM, 100 GiB qcow2, isolated private NAT, stable address, and exactly two global job slots; record the dedicated network/VM UUIDs and cleanup commands before starting it.
- [ ] **`DISPOSABLE_ONLY`:** Verify the runner shares only its dedicated HMAC secret with the trusted plane and cannot read app/database/provider/backup/tunnel/Gmail/Cloudflare secrets.
- [ ] **`DISPOSABLE_ONLY`:** Execute safe fixtures for path traversal, symlink/hard-link races, mount escape, proc/sys/dev access, Docker/libvirt/KVM socket access, namespace escape, setuid/capability abuse, debugger/ptrace, cross-job files, PID leakage, and output/harness forgery.
- [ ] **`DISPOSABLE_ONLY`:** Bind owned canary listeners representing internet, LAN, metadata, database, NUC-host, and unrelated-service destinations only inside the isolated test network. Require every job connection to those canaries to fail while the app-to-runner route remains functional; do not probe any real LAN, metadata, host, or unrelated-service address.
- [ ] **`DISPOSABLE_ONLY`:** Execute fork bomb, process churn, infinite CPU, memory pressure, quota-backed disk/file growth, file-descriptor exhaustion, huge stdout/stderr, source-size, timeout, signal, and crash fixtures; require bounded kill/reap and continued disposable app/database health. Abort rather than spill pressure outside the guest/loopback resource envelope.
- [ ] **`DISPOSABLE_ONLY`:** Verify request HMAC, timestamp/replay window, payload binding, idempotency mismatch denial, queue fairness, one job per user, exactly two concurrent jobs, and safe reconciliation after runner restart/lost response.
- [ ] **`DISPOSABLE_ONLY`:** Inspect every runtime image with Trivy, record scanner DB identity, generate SBOMs tied to exact deployed digests, and verify any published signature/attestation and builder/source provenance. Zero Critical/High findings are permitted; unavailable provenance follows the owned residual-risk contract.

**Pass condition:** hostile learner code remains inside the guest/job boundary, all resources are bounded, two-slot fairness holds, and no secret/network/cross-job/host access is observed.

### Task 8: Audit production containers, secrets, tunnel, host exposure, and restart policy

**Files:**
- Read: `infra/docker-compose.production.yml`
- Read: `infra/env/*.example`
- Read: `infra/systemd/**`
- Read: `infra/cloudflare/**`
- Test: `infra/tests/validate-static.mjs`, `infra/tests/validate-compose.mjs`, production-smoke and systemd recovery tests

- [ ] **`DISPOSABLE_ONLY`:** Render the exact pilot profile with generated non-secret test values and require no published host ports, no scanner service, immutable digests, Watchtower opt-out, non-root users, dropped capabilities, no-new-privileges, read-only roots where supported, resource limits, health checks, bounded restart policy, and rotated logs.
- [ ] **`NUC_READ_ONLY`:** After matching the approved host fingerprint, verify every Codestead secret file has the exact owner/group/mode and only the dedicated container-readable group can read it. **`CODESTEAD_PROJECT_ONLY`:** Use synthetic canaries to inspect Codestead images, environment metadata, container inspect output, process lists, logs, crash output, and backup payloads; never print a real secret value.
- [ ] **`DISPOSABLE_ONLY`:** Scan every exact app/worker/tooling/runner image with Trivy, save scanner DB identity, and generate SBOM/inventory evidence tied to the final digest. Verify available registry signatures/attestations and record repository, builder, and source provenance; missing provenance follows the owned residual-risk contract.
- [ ] **`NUC_READ_ONLY`:** Verify the dedicated Codestead tunnel configuration routes only the recorded Codestead hostname to the internal service and that the pre/post inventory of the existing host tunnel, nginx, containers, networks, and ports is byte-for-byte unchanged.
- [ ] **`CODESTEAD_PROJECT_ONLY`:** From an approved external vantage, scan only the recorded Codestead hostname and owned public IP exposure set. Verify intended HTTPS works and direct origin, SSH, 3000, 4100, 5432, Docker, libvirt, and runner ports are not publicly reachable; refuse CIDR expansion, LAN scanning, or unrelated hostnames.
- [ ] **`NUC_READ_ONLY`:** Verify enablement, dependency ordering, pinned-image/no-build/no-pull boot commands, VM autostart metadata, and persistent timer configuration. **`CODESTEAD_PROJECT_ONLY`:** Recreate/restart only Codestead services and the dedicated runner service/VM during the maintenance window; never restart host Docker/libvirt. The full host startup chain is proved only by the controlled reboot and one-time AC gate in Task 9.
- [ ] **`HUMAN_SUPERVISED`:** Execute and update the manual records for `EXT-CREDENTIAL-REVOCATION`, `EXT-CLOUDFLARE-ACCOUNT`, `EXT-GMAIL-DNS-DELIVERY`, conditional `EXT-GOOGLE-OAUTH`, `EXT-NIM-PROVIDER`, and `EXT-KVM-NUC`. This includes provider-side revocation/new credential identifiers; Cloudflare MFA/recovery/token scope/rotation/DNS alerts; Gmail scope plus invitation, SPF/DKIM/DMARC, bounce/suppression proof; exact Google callback/origin and approved-user MFA flow when enabled; NIM endpoint/model/terms, live health/circuit-breaker/fallback/quality canary; and exact NUC/VM identities. Evidence records only redacted account/config identifiers and hashes, never credential values. Unobserved mandatory checks remain `NOT_RUN` and force pilot `HOLD`.

**Pass condition:** the trusted plane has least privilege, exact secret access, zero unintended origin exposure, immutable deployment identity, and automatic bounded recovery without affecting unrelated services.

### Task 9: Audit backup, restore, rollback, reboot, and power-loss behavior

**Files:**
- Read: `scripts/backup/**`
- Read: `infra/systemd/learncoding-backup*`
- Test: `infra/tests/backup-*.test.sh`, `infra/tests/restore-*.test.sh`, `infra/tests/emergency-backup-atomicity.test.sh`
- Test: power/recovery checklists and evidence collectors from the deployment plans

- [ ] **`DISPOSABLE_ONLY`:** Run every backup publication, retention, emergency, path-safety, consistency, offsite, and restore test on Ubuntu with real GNU permissions, `flock`, `age`, Docker, and fsync/rename semantics using temporary local roots and a dedicated rclone test prefix.
- [ ] **`DISPOSABLE_ONLY`:** Create a production-like encrypted backup, verify schemas/checksums before publication, upload to the dedicated rclone test prefix, download independently, decrypt with the separately protected test identity, and restore into an isolated clean stack.
- [ ] **`DISPOSABLE_ONLY`:** Prove 7 daily/4 weekly/12 monthly retention, protected-success-marker behavior, no plaintext archive, no co-located master key, and no deletion outside the temporary backup root. Never point a retention/pruning fixture at production recovery points.
- [ ] **`DISPOSABLE_ONLY`:** Inject failures at quiesce, dump, object capture, encryption, verification, each rename/fsync, marker publication, offsite transfer, pruning, resume, and restore; require either the old valid point or the new fully valid point, never a partial published point. Connection loss, quota/full-disk, and pruning faults use fake endpoints and quota-backed temporary filesystems.
- [ ] **`CODESTEAD_PROJECT_ONLY`:** Match the NUC fingerprint and Codestead project/VM/volume identities, capture an unrelated-service inventory, require a fresh verified recovery point, and rehearse update rollback/database compatibility using the exact previous pinned images. Recreate only Codestead services; do not restart Docker/libvirt or alter existing services.
- [ ] **`HUMAN_SUPERVISED`:** Independently download the encrypted production recovery point from Drive, then restore it only into isolated PostgreSQL/application-data roots. Define measured RPO as `restore-point snapshot UTC` to `declared incident UTC` and require RPO ≤24 hours. Define RTO as `administrator issues restore start approval` to `isolated restored application passes identity/schema/object/evidence/audit/credential-probe smoke` and require RTO ≤4 hours. Record Drive account MFA/recovery/quota and the complete upload/download/checksum/decrypt/restore evidence in `EXT-DRIVE-RESTORE`. A missed threshold is `FAIL`, not a narrative concern.
- [ ] **`HUMAN_SUPERVISED`:** After Tasks 1-8, Task 9’s disposable/restore/rollback phases, and Task 10 pass for the frozen external-test candidate, perform one controlled NUC reboot. Require ≥8 GiB available host memory and ≥15% free root capacity before/after, unchanged unrelated-service inventory, every Codestead dependency/VM/container/timer/tunnel recovered, no duplicate authoritative effect, and public HTTPS ready within 15 minutes measured from the first successful firmware power-on timestamp; update `EXT-CONTROLLED-REBOOT` with the manual record and artifact hashes.
- [ ] **`HUMAN_SUPERVISED`:** Make the initial physical AC-loss rehearsal the final mandatory gate before invitations: all other mandatory external-gate rows must be `PASS`, the exact Git SHA/tree/image/config/VM/firmware/storage identities must be frozen, a same-day verified recovery point must exist, and the administrator must approve the maintenance window and physically remove/restore power. Automation may prepare acknowledged draft/progress/audit/mail/job/browser markers and collect evidence, but may not trigger power removal.
- [ ] **`HUMAN_SUPERVISED`:** After AC restoration, require public readiness within 15 minutes, ≥8 GiB available host memory, ≥15% free root capacity, unchanged unrelated-service inventory, PostgreSQL/filesystem/SMART health, preservation of every acknowledged server/browser marker, exactly-once ambiguous-request/job/mail/reward reconciliation, persistent timers resumed, and an immediate verified encrypted backup. Update `EXT-PHYSICAL-AC-LOSS` with observer/approver/window, exact identities, measurements, redacted artifact hashes, and invalidation rule. Any discrepancy is `FAIL` and keeps invitations disabled.
- [ ] **`DISPOSABLE_ONLY` / `CODESTEAD_PROJECT_ONLY`:** After any repair following the rehearsal, rerun the complete non-destructive matrix and every affected external row on the new SHA. Repeat physical AC only if startup ordering, persistence/durability, PostgreSQL/storage, browser outbox, backup publication, runner recovery, VM autostart, systemd/Compose recovery, or tunnel recovery changed **and** the administrator explicitly approves another rehearsal. Otherwise preserve the one-time evidence only with a signed product-owner plus independent-reviewer change-impact record that names changed files/config, explains why the AC invariant is unaffected, and requires a new controlled reboot. A missing impact record invalidates `EXT-PHYSICAL-AC-LOSS` to `NOT_RUN`.
- [ ] **`HUMAN_SUPERVISED`:** Record the no-UPS limitation: the final keystroke before local persistence, an unacknowledged request, and hardware writes falsely reported durable cannot be guaranteed.

**Pass condition:** the independently downloaded encrypted point meets RPO ≤24 hours and RTO ≤4 hours, rollback is proven without touching unrelated services, the controlled reboot passes, and the one-time administrator-supervised AC gate preserves acknowledged state/exact-once effects and restores public readiness within 15 minutes. The AC evidence is valid only under its recorded invalidation rule.

### Task 10: Run ten-learner load, failure injection, and operational-security checks

**Files:**
- Read: `scripts/load-smoke.ts`
- Read: runner queue/admission/metrics implementation
- Test harness: `scripts/load-smoke.ts` must implement the exact authenticated synthetic workload and redacted JSON evidence contract below; any missing capability is a release-blocking gap repaired test-first in Task 11

- [ ] **`HUMAN_SUPERVISED`:** Before any load is generated, write `${EVIDENCE_ROOT}/load-gate-decision.json` and obtain product-owner approval. The immutable decision records the exact SHA/images/NUC/VM/data-set IDs and these fixed thresholds: normal-window HTTP 5xx+timeout rate ≤0.5%; zero failed acknowledged authoritative mutations; non-runner API p95 ≤2,000 ms and p99 ≤5,000 ms; runner admission p95 ≤2,000 ms; runner queue wait p95 ≤60 seconds and maximum ≤120 seconds; injected-component health ≤5 minutes after fault release; queued work drained ≤10 minutes; alert/dead-letter visible ≤60 seconds; PostgreSQL connections <80% of `max_connections`; PostgreSQL lock-wait p95 ≤1,000 ms; zero deadlocks/OOM kills/thermal-throttle increments; ≥8 GiB available host memory; ≥15% free root capacity; and temperature <90°C. These latency/error/queue thresholds are absent from the approved design, so missing owner approval is a decision blocker and leaves the load gate `NOT_RUN`; thresholds cannot be loosened after execution begins without a new decision artifact and complete rerun.
- [ ] **`CODESTEAD_PROJECT_ONLY`:** Seed exactly ten synthetic learner accounts, 30 synthetic lessons, 50 review/quiz prompts (five per learner), 100 initial draft records (ten per learner), and no real email/provider key. Run a deterministic seed-20260715 schedule: during the 10-minute warm-up add one learner per minute using the sustained action loop; during the 60-minute sustained phase run all ten learners; during the 10-minute cool-down stop new code submissions and remove one active learner per minute while accepted queues drain. During each sustained minute every learner performs two lesson reads, one dashboard/progress read, one alternating review/quiz completion, two idempotent draft/exam autosaves, and every third minute one representative queued code job. Expected sustained totals are 1,200 lesson reads, 600 dashboard reads, 600 review/quiz completions, 1,200 autosaves, and 200 code jobs.
- [ ] **`NUC_READ_ONLY`:** Sample every five seconds and record p50/p95/p99, HTTP errors/timeouts, queue depth/wait/running slots, CPU, available RAM, root free capacity, disk I/O, PostgreSQL connections/deadlocks/locks, VM CPU/RAM, temperature, thermal-throttle counters, OOM events, and unrelated-service health. **Abort immediately** on two consecutive samples below 8 GiB available memory or 15% root free capacity, any temperature sample ≥90°C, any OOM kill, any new thermal-throttle event, a third concurrent runner job, or any unrelated-service health regression.
- [ ] **`DISPOSABLE_ONLY`:** Run this ordered fault matrix against disposable databases, quota-backed filesystems, fake endpoints, and an isolated runner network: runner service restart; app restart; each worker restart; PostgreSQL connection-proxy interruption; tunnel-proxy interruption; fake Gmail failure; fake AI-provider failure; fake offsite/Drive failure; quota-backed disk-near-full alert; and synthetic stale-backup alert. Each case has two minutes of healthy baseline, at most 60 seconds of fault, five minutes for bounded recovery, and two minutes for invariant checks before the next clean reset.
- [ ] **`CODESTEAD_PROJECT_ONLY`:** During the approved NUC window, repeat only project-scoped runner-service, app-container, and worker-container restart cases plus PostgreSQL/provider/tunnel/offsite interruption through Codestead-owned test proxies/fake adapters. Simulate disk-near-full only in a quota-backed Codestead test volume and stale backup by a synthetic marker. Never restart host Docker/libvirt, stop the real host tunnel, contact a real provider during outage injection, prune production Drive data, or consume host root capacity.
- [ ] **`CODESTEAD_PROJECT_ONLY`:** Verify bounded backpressure, exactly two runner jobs, no silent data loss, no duplicate official effects, no unbounded retries, no secret-bearing logs, alerts/dead letters within 60 seconds, component recovery within five minutes, queue drain within ten minutes, and all signed-off latency/error/resource thresholds. Run the full authenticated browser journey during steady state and after each recovery class.

**Pass condition:** the fixed 10/60/10-minute workload and fault windows meet every pre-approved numeric threshold, exactly two runner slots are enforced, ≥8 GiB memory and ≥15% root capacity remain available, no thermal/OOM abort fires, failures degrade truthfully, and recovery neither corrupts nor duplicates authoritative state. Missing pre-run SLO approval, an aborted run, or a threshold miss is `FAIL`/`NOT_RUN`, never a discretionary pass.

### Task 11: Remediate findings and produce the final independent release verdict

**Files:**
- Modify only the exact source/test files implicated by confirmed findings
- Update: `docs/production-security-review.md`
- Update: `docs/release-audit.md` only with evidence tied to the final commit

- [ ] **`DISPOSABLE_ONLY`:** For each confirmed finding, write a deterministic failing regression before production changes and capture RED output tied to the affected candidate SHA.
- [ ] **`DISPOSABLE_ONLY`:** Implement the smallest complete fix that restores the intended security invariant; do not weaken the requirement to satisfy an existing test.
- [ ] **`DISPOSABLE_ONLY`:** Run focused GREEN, adjacent regressions, the owning subsystem suite, and the complete immutable-candidate release matrix. Commit each coherent repair directly to `main`, generate an exact diff review package, and obtain a fresh independent spec/security review. `Critical`, `High`, and release-blocking `Medium` findings repeat the repair/re-review loop until clean.
- [ ] **`DISPOSABLE_ONLY`:** Close every Task 1-7 blocking finding first, create a new immutable detached checkout for the resulting SHA, and obtain an independent internal-candidate verdict before authorizing Task 8 or any NUC mutation. Evidence from an earlier SHA is historical and cannot clear the new candidate.
- [ ] **`DISPOSABLE_ONLY` / `CODESTEAD_PROJECT_ONLY`:** For the final committed SHA, rerun Tasks 1-8, the non-physical backup/restore/rollback/reboot portions of Task 9, and Task 10 plus every external row invalidated by the change. Do **not** unconditionally repeat physical AC; apply Task 9’s explicit invalidation/change-impact rule.
- [ ] **`DISPOSABLE_ONLY`:** For every accepted residual, verify the accountable product-owner record contains finding ID, rationale, compensating controls, approval/expiry dates, and reassessment triggers. The executing agent cannot self-accept. Missing, expired, or triggered acceptance leaves the finding unresolved.
- [ ] **`DISPOSABLE_ONLY`:** Produce the sanitized report using the security-reviewer format: executive summary; `Critical/High/Medium/Low/Informational` counts; exact candidate/tree/lockfile/image scope; tools, scanner databases, remote rulesets, signatures/attestations and provenance; detailed findings/remediation; automated and manual evidence tables; residual-risk approvals; full external-gate ledger; and separate repository/pilot verdicts.
- [ ] **`HUMAN_SUPERVISED`:** Require zero unresolved Critical/High, zero release-blocking Medium, a current accountable acceptance for every remaining non-blocking residual, `REPOSITORY SECURITY VERDICT = PASS`, and every mandatory external-gate row `PASS` before setting `PILOT RELEASE VERDICT = GO` or enabling learner invitations. Uploads remain disabled in pilot regardless. Any mandatory `FAIL` or `NOT_RUN` forces `PILOT RELEASE VERDICT = HOLD`.

**Final pass condition:** the exact pushed `main` commit has a clean independent repository-security verdict and complete evidence for every automated requirement. The production pilot is `GO` only when the same commit/config/images have `PASS` for all mandatory Cloudflare, Gmail/DNS, enabled Google OAuth, NIM/provider, Drive/restore, KVM/NUC, reboot, and one-time AC-loss rows; otherwise the truthful terminal state is repository `PASS` with pilot `HOLD`, never a production-ready claim.
