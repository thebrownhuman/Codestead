# Backend deployment-readiness audit

Audited revision: 73951e68a3307a9967589358c5646bd3a61c402c
Branch at audit start: main
Audit date: 2026-07-22
Disposition: REQUEST CHANGES

## Scope and method

This was a read-only static review of authentication, sessions, MFA, authorization, IDOR/CSRF, abuse controls, PostgreSQL schema and roles, migrations, transactions and idempotency, credentials and providers, mail and workers, runner signing/recovery, uploads/quarantine/scanning, retention/deletion/reconciliation, Compose hardening, secrets, health checks, and backup-key separation.

No tests, services, containers, databases, migrations, scanners, or backup jobs were run by the audit lane. Secret values were not inspected. All evidence refers to the exact audited Git object above, not later working-tree changes.

No P0 issue was found. The revision is not production-ready. Authentication, CSRF, password rotation, database-role containment, mail recovery, and retention affect the pilot. ClamAV and some file findings block only later full upload mode.

## Findings summary

| ID | Priority | Summary | Mode |
|---|---:|---|---|
| BE-AUTH-001 | P1 | Raw Better Auth routes bypass Codestead MFA/account-state policy | Pilot/full |
| BE-AUTH-002 | P1 | Bootstrap password rotation is not enforced | Pilot/full |
| BE-WEB-001 | P1 | Custom cookie mutations lack canonical Host/Origin enforcement | Pilot/full |
| BE-DB-001 | P1 | Runtime database roles receive universal table CRUD | Pilot/full |
| BE-MAIL-001 | P1 | Ambiguous mail delivery is retried and can duplicate | Pilot/full |
| BE-SCAN-001 | P1 | ClamAV parser has unrestricted egress and writable definitions | Full uploads |
| BE-RET-001 | P1 | Failed erasure work can be stranded indefinitely | Stored bytes |
| BE-MUT-001 | P2 | Credential mutations have unprotected failure windows | Pilot/full |
| BE-OPS-001 | P2 | Initial administrator bootstrap is not crash-resumable | First deployment |
| BE-MIG-001 | P2 | Applied historical migration hashes are not verified | Pilot/full |
| BE-DB-002 | P2 | Checksum-disabled PostgreSQL can pass release smoke | Pilot/full |
| BE-RET-002 | P2 | Retention can delete an object reclassified after selection | Stored bytes |
| BE-FILE-001 | P2 | Safe downloads do not verify stored digest at open | Full uploads |
| BE-FILE-002 | P2 | Multipart body is parsed before the 50 MB limit | Full uploads |
| BE-ABUSE-001 | P2 | Durable authenticated writes lack hard account/session quotas | Pilot/full |
| BE-AI-001 | P2 | Provider response bodies are buffered without a byte cap | Pilot/full |
| BE-UPLOAD-001 | P2 | Upload-enabled startup/smoke/reconciliation is incomplete | Full uploads |
| BE-RUNNER-001 | P3 | Runner nonce replay state is lost on restart | Pilot/full |
| BE-RECON-001 | P3 | Reconciliation observes mixed DB/filesystem state | Full uploads |
| BE-RECON-002 | P3 | Reconciliation reports are not power-loss durable | Full uploads |
| BE-ERR-001 | P3 | Unexpected errors may reach clients/logs verbatim | Pilot/full |
| BE-CSP-001 | P3 | Production CSP permits inline scripts | Pilot/full |
| BE-DB-003 | P3 | Backups use primary PostgreSQL authority | Pilot/full |

## P1 release blockers

### BE-AUTH-001 — Raw Better Auth routes bypass Codestead policy

- Evidence: src/lib/security/better-auth-management-policy.ts:6-11,30-38 denies only four routes and otherwise passes POST requests. src/app/api/auth/[...all]/route.ts:25-28 forwards them directly. Durable role/status/MFA checks live in src/lib/http/authz.ts:33-79. Better Auth 1.6.23 exposes sensitive token, link, refresh, and password operations.
- Impact: a valid but not application-MFA-authorized session can reach authentication-management operations without Codestead recent-MFA, durable status, audit, notification, or revocation policy.
- Required fix: replace the denylist with an exact method/path allowlist, disable unused dependency routes, and wrap required management operations with the application policy.
- Proving test: inventory every pinned dependency route; unclassified routes must fail. Each sensitive route must reject missing application MFA, pending/suspended accounts, and invalid method/path before the dependency handler.

### BE-AUTH-002 — Bootstrap password rotation can be falsely cleared

- Evidence: scripts/bootstrap-admin.ts:43-61 sets mustChangePassword:true. src/app/api/onboarding/complete/route.ts:21-53 does not check it and :56-64 clears it while activating. src/lib/http/authz.ts:43-58 does not enforce the flag. Existing onboarding tests activate after only the non-password prerequisites.
- Impact: the temporary bootstrap password can become the sole administrator's permanent password.
- Required fix: only a verified password-change transaction may clear the flag; revoke other sessions. Onboarding must require false rather than clearing it, and protected credential/admin operations should enforce it.
- Proving test: a fully prepared bootstrap admin with the flag true remains pending. Only the actual password-change path clears it and permits activation.

### BE-WEB-001 — Custom cookie-authenticated APIs lack canonical request-origin enforcement

- Evidence: src/lib/auth.ts:43-52 applies trustedOrigins only within Better Auth. next.config.ts:39-54 adds response headers but no request guard. No middleware/proxy provides a global boundary. src/app/api/privacy/consents/route.ts:62-81,100-128 accepts arbitrary JSON media type and mutates without Origin/Host validation.
- Impact: a hostile sibling site can issue a credentialed simple text/plain POST carrying valid JSON. SameSite cookies can be sent; CORS prevents reading, not mutation.
- Required fix: centrally validate canonical Host/trusted forwarded host, exact Origin for browser cookie mutations, Sec-Fetch-Site defense, and expected content type. Define explicit policies for public and server-to-server routes.
- Proving test: every unsafe cookie route rejects sibling Origin, hostile Host/forwarded host, browser-shaped missing Origin, and text/plain JSON before parsing/service calls; exact-origin JSON remains valid.

### BE-DB-001 — All runtime database roles have unrestricted CRUD over all tables

- Evidence: scripts/bootstrap-database-roles.mjs:625-649 grants app, worker, and ops roles SELECT/INSERT/UPDATE/DELETE over all public tables and sequences; :676-693 repeats broad default grants. scripts/verify-database-role-boundaries.mjs positively verifies arbitrary-table CRUD. No production RLS policy was found.
- Impact: compromise of a narrow worker can read live sessions or provider ciphertext, change account/auth/audit state, mark malware safe, delete erasure work, or alter unrelated learners.
- Required fix: per-service credentials with exact table/column/operation grants, narrow transition functions where useful, denial of auth/session/credential/audit access, and row isolation or reviewed security-definer operations.
- Proving test: run a complete SET ROLE matrix. Every service's required operation succeeds, while sensitive/unrelated table CRUD and cross-user rows are denied or affect zero rows.

### BE-MAIL-001 — Ambiguous provider delivery can produce duplicate or post-deletion mail

- Evidence: scripts/process-outbox.ts:16-27 explicitly provides at-least-once recovery and requeues stale sending rows. Claims/settlement at :36-40,63-78 are not lease-fenced. Gmail is called before terminal DB commit at :58-66. src/lib/notifications/mailer.ts:75-86 returns a provider ID that is not durably reconciled. Account deletion may remove a row while a claimant still holds the message.
- Impact: accepted invitation, reset, or security mail can be retried after response loss/power failure. A paused claimant can send after account deletion.
- Required fix: fenced claims, durable provider-operation identity/state, provider reconciliation before retry, quarantine when ambiguity cannot be resolved, and deletion/dispatch serialization.
- Proving test: a fake provider records acceptance then loses the response. Restart after lease expiry and prove one delivery. Pause after claim, delete the account, resume, and prove no send.

### BE-SCAN-001 — ClamAV parsing has unrestricted egress and writable persistent definitions

- Evidence: compose.yaml:624-637 attaches clamd to signature-egress and a writable definitions volume. compose.yaml:951-956 defines a normal non-internal bridge without destination restriction. The runbook claims this path is for signature refresh.
- Impact: a parser compromise can exfiltrate the uploaded stream, reach host/LAN/Internet, and persistently poison definitions.
- Pilot disposition: uploads remain disabled, so this blocks full-mode promotion rather than the initial pilot.
- Required fix: use a separate freshclam updater with tightly allowlisted egress and RW definitions; mount definitions read-only into clamd, which receives only the internal scanner network.
- Proving test: clamd cannot reach host/LAN/public destinations or write definitions; scan-worker can reach clamd; updater can reach only approved signature endpoints.

### BE-RET-001 — Failed erasure work can be stranded across daily run IDs

- Evidence: src/lib/data-lifecycle/retention.ts:592-665 commits jobs and deletes metadata before unlink. src/lib/data-lifecycle/file-erasure.ts:112-140,217-299 drains only one lifecycleRunId. scripts/data-lifecycle.ts:35-45 derives a new daily key. infra/systemd/learncoding-retention.service:8-17 has no same-key recovery loop.
- Impact: a day-D unlink/fsync failure can leave deleted bytes indefinitely; day D+1 uses another run ID and cannot rediscover deleted metadata.
- Required fix: resume oldest pending erasure before new work, or make erasure a global durable drainer independent of lifecycle-run creation. Add bounded same-key service retries.
- Proving test: fail after the day-D metadata transaction, invoke the ordinary day-D+1 command, and prove the old bytes/jobs are removed and the original run completes.

## P2 important findings

### BE-MUT-001 — Provider-credential mutations are not atomic or retry-idempotent

Credential create/replace/delete in src/app/api/credentials and later audit/notification steps cross separate failure windows. Use a client operation UUID, durable receipt, compare-and-swap keyVersion, external validation before publication, and one transaction for credential state, preference, audit, and notification outbox. Failure injection followed by exact retry must produce one mutation/audit/notification.

### BE-OPS-001 — Administrator bootstrap is not crash-resumable

scripts/bootstrap-admin.ts commits signup before separate promotion; retry refuses the resulting learner. Use a durable bootstrap intent under the administration lock, allowing only exact authorized resume. Kill after signup and prove an exact rerun produces one admin and no orphan learner.

### BE-MIG-001 — Historical migration hashes are not validated

The pinned Drizzle migrator applies later timestamps but does not compare all applied historical hashes. Add a full ordered repository/database journal preflight rejecting hash, count, order, missing, extra, or duplicate drift before any mutation.

### BE-DB-002 — Checksum-disabled PostgreSQL can pass guarded startup

New-cluster init requests checksums, but validate-runtime.sh and smoke-production.sh check only fsync, synchronous_commit, and full_page_writes. Require data_checksums before ingress and document offline enable/rebuild.

### BE-RET-002 — Retention can delete an object reclassified after selection

Candidates are selected before the deletion transaction without row locking or predicate recheck. Select within the transaction using FOR UPDATE SKIP LOCKED and revalidate status/cutoff before enqueue/delete.

### BE-FILE-001 — Safe download does not revalidate stored digest

src/app/api/files/[id]/route.ts trusts scan_status=safe and streams the path. Equal-length replacement or corruption can bypass previous scanning. Use an immutable safe store or digest/inode verification before response streaming.

### BE-FILE-002 — Multipart limit occurs after request.formData()

src/app/api/files/route.ts parses the complete body before enforcing 50 MB. Add ingress/server aggregate ceilings and streaming per-part/total counters that abort early.

### BE-ABUSE-001 — Durable writes lack hard user/session quotas

Unique exam events and projects can create unbounded rows. Add persistent account/session rate limits, transactional row quotas, and a project idempotency key.

### BE-AI-001 — Provider response bodies are unbounded

src/lib/ai/providers.ts calls response.json() before any byte/schema-size cap. Reject oversized Content-Length and use a bounded chunk reader; cap arrays and text fields.

### BE-UPLOAD-001 — Full upload-mode promotion cannot pass guarded startup

start-production-stack includes clamd/scan-worker, but production smoke hard-codes pilot inventory and requires uploads false. No scheduled reconciliation timer/report path is present. Add mode-aware exact inventories, real health/lifecycle smoke, and scheduled reconciliation before full-mode promotion.

## P3 hardening

| ID | Finding | Required direction |
|---|---|---|
| BE-RUNNER-001 | Accepted runner nonces live only in memory and reset on restart. | Persist nonce expiry in the crash-safe journal or use a durable monotonic sequence; replay after authenticator recreation must fail. |
| BE-RECON-001 | Reconciliation uses separate autocommit reads and a changing filesystem. | Use one repeatable-read DB snapshot plus a generation/quiesce contract or safely age/recheck transient findings. |
| BE-RECON-002 | Reconciliation report write/rename lacks file and directory fsync and may replace a same-ID report. | Use no-replace, file sync, atomic publication, directory sync, and failure injection. |
| BE-ERR-001 | Raw unexpected Error messages/objects can reach responses or logs. | Stable public codes plus correlation IDs and a redacting structured logger; test secret canaries. |
| BE-CSP-001 | script-src includes unsafe-inline. | Move to nonce/hash authorization and prove unauthorized inline script is blocked. |
| BE-DB-003 | pg_dump uses the primary PostgreSQL authority. | Add a read-only backup role that can dump but cannot DML/DDL/manage roles. |

## Confirmed strengths

- Custom protected routes re-read durable status, role, and MFA; cookie-cache authority is disabled.
- One active session is database-enforced, and recent MFA re-reads the exact session/user.
- Static endpoint/IDOR matrices cover a large authenticated/admin surface.
- Existing application rate limits are PostgreSQL-backed, HMAC-keyed, and fail closed.
- Provider credentials use AES-256-GCM envelope encryption with scoped AAD.
- AI adapters use fixed HTTPS or hostname allowlists, disable redirects, and normalize errors.
- Runner requests bind method, path, time, nonce, request ID, idempotency key, and body hash; responses are signed.
- Runner jobs/idempotency state use crash-safe sync/rename/directory-sync publication.
- Migration execution uses a bounded PostgreSQL advisory lock; platform seed is rerunnable.
- New PostgreSQL clusters request checksums and strong WAL durability settings.
- Upload enablement is explicit and checked before body parsing; objects start pending and only safe objects are downloadable.
- Object publication and erasure use careful filesystem synchronization.
- Compose publishes no application ports and uses internal networks, file-backed secrets, bounded resources, and one-shot operations.
- Normal backups exclude the credential master key; recovery-kit material is separated.
- Liveness and database readiness are distinct and minimally disclosed.

## Unverified and external evidence

- No runtime security, database, browser, scanner, container, migration, backup, restore, or dependency test was executed by this audit lane.
- Cloudflare DNS/tunnel/canonical-host behavior, live PostgreSQL grants/settings, Gmail ambiguity, provider outages, real container identities/CVEs, KVM firewall/restart/load, scanner reachability/signatures, Drive restore, recovery media, reboot/AC-loss, alert delivery, and external penetration review remain unverified.
- Uploads must remain disabled until the full-mode findings and live promotion gates pass.
