# ADR-0001: Local-first modular platform with an isolated execution plane

- **Status:** Accepted as the implementation baseline; listed policy decisions remain open
- **Date:** 2026-07-12
- **Owners:** Product owner and platform administrator
- **Related:** [PRD](../PRD.md), [architecture](../architecture.md), [threat model](../threat-model.md), [data model](../data-model.md)

## Context

The product is an adaptive coding tutor for an invite-only cohort of approximately ten adult learners. Its proposed Core Beta teaches C, C++, Java, Python, shared DSA, and a bounded HTML/CSS/JavaScript/React web track; it personalizes explanations using external AI, executes hostile learner code, reviews GitHub projects, retains detailed learning history, and remains usable from India and the United States. Final Core Beta breadth is still an owner confirmation, not a license to publish empty topics.

The owner has an Intel NUC with an 11th-generation i7, 32 GB RAM, 1 TB storage, Ubuntu 24.04 LTS, and a 400 Mbps CGNAT internet connection. The owner prefers primary application data to stay local, accepts best-effort availability, and plans Cloudflare Tunnel because no public IP is available. There is currently no UPS. Ten learners may each retain 2 GB by default, adjustable to 3 GB.

Identity must support administrator-approved access, Google, email/password, MFA, a 30-day remembered database-backed session, and one active browser-device session. Learners and administrators need separate roles. An administrator is a mentor with broad learning visibility, but implicit impersonation and ordinary plaintext provider-key display are unsafe. The owner-approved exception is a dedicated fresh-MFA reveal ceremony with reason, audit, no-store response, and learner notification.

AI is external. Learners can provide multiple NVIDIA/OpenRouter/DeepSeek/Gemini/OpenAI credentials; NVIDIA NIM support is mandatory, though its exact routing meaning and production endpoint remain unresolved. Authoritative code behavior should resemble an online judge: a documented server runtime decides results. Browser games, visualization, and optional quick runs may save server resources, but cannot grade hidden tests.

## Decision drivers

1. Strong isolation of arbitrary code and untrusted repositories.
2. Low operational complexity appropriate to ten users and one primary operator.
3. Local ownership of durable learner data.
4. Reproducible grading and appeal evidence.
5. Provider portability and per-user BYOK without secret disclosure.
6. Continued learning when an AI provider is unavailable.
7. Support for CGNAT ingress and best-effort home hosting.
8. Versioned, auditable curriculum and mastery decisions.
9. A path to move individual components to managed infrastructure without rewriting the product domains.

## Decision

### 1. Use a modular monolith for the trusted product

Build one Next.js/TypeScript web/backend codebase organized into explicit domain modules, using Drizzle ORM and committed Drizzle migrations for application and Better Auth persistence:

- access and identity projection;
- learner profile/onboarding;
- curriculum and publication;
- learning plans and adaptive mastery;
- assessment/exams;
- code submissions;
- AI gateway and learner memory;
- projects/GitHub review;
- social/achievements;
- notifications;
- admin/audit/appeals;
- data lifecycle and quota.

A separate worker process uses the same domain packages for durable jobs. PostgreSQL is the transactional source of truth. Large user-owned artifacts use private local object storage with PostgreSQL metadata. Postgres-backed jobs/outbox are sufficient at this scale; Redis and distributed messaging are not initial dependencies.

### 2. Self-host the trusted plane, but acknowledge external processors

Run the Next.js web app (including Better Auth), worker, PostgreSQL, and object storage on the NUC. Expose only the web/auth routes through outbound Cloudflare Tunnel. No router port forwarding is permitted. Administrative access uses a separate management VPN.

Cloudflare, Google identity federation, transactional email, external AI providers, GitHub, and encrypted Google Drive backup process some data outside the NUC. “Local-first” therefore means the authoritative application database and durable learner objects are local, not that all traffic and copies remain on-premises.

### 3. Use Better Auth with Drizzle/PostgreSQL inside Next.js

Use Better Auth's Drizzle adapter against PostgreSQL. Better Auth handles email/password, Google OAuth, email verification/reset, database-backed cookie sessions, session listing/revocation, and the approved two-factor/passkey plugins. Keep authentication routes within the Next.js deployment rather than adding a separate identity service. Require TOTP plus recovery codes as the initial second factor. Because Better Auth does not gate OAuth/social or passkey sign-in with its two-factor plugin by default, add and test a custom hook that prevents a Google-created session from becoming product-usable until TOTP succeeds. Passkey may be an optional first factor later; it is not silently treated as satisfying the product's MFA requirement. The application owns request-access approval, learner/admin roles, mentor authorization, one-active-session enforcement, fresh-MFA gating, and the security/audit projection. Approval sends an expiring one-time set-up link; generated passwords are never emailed.

Use database-backed Better Auth sessions rather than stateless-only cookies so revocation is immediate. Enforce one active session/device family per account, including admins, through reviewed Better Auth hooks/commands plus a database uniqueness/transaction policy. A new browser-device login is blocked while another family is active; normal logout releases the current family, while a lost-device revocation request requires administrator identity confirmation and approval. Administrators can revoke any family. A session may remain remembered for 30 days, but Better Auth's independent `trustDevice` MFA-bypass option is disabled; a new login after logout/revocation must complete TOTP. A short freshness window and recorded recent MFA remain mandatory for sensitive operations.

Generate the Better Auth Drizzle schema with the official CLI, commit it, review plugin-added fields/tables, and apply it through Drizzle migrations. Do not run unreviewed automatic production schema mutation. Keep the versioned `BETTER_AUTH_SECRET` outside PostgreSQL/backups and rotate it through Better Auth's supported multi-secret mechanism. Better Auth uses scrypt for password hashing by default; any custom hash configuration requires a separate compatibility/security review.

### 4. Place hostile execution in a separate KVM VM

Do not execute learner code or repository builds in the trusted Docker daemon. Use a dedicated KVM VM with its own firewall and disposable containers, initially through Judge0 CE or a narrowly equivalent runner. Deny internet, home-LAN, host, database, object-store, and secret access during execution. Pin runtime image digests and record them with every authoritative result.

Browser visualizers and games are local. Optional browser quick-run is explicitly non-authoritative. Hidden tests, exams, mastery evidence, and appeals always use the server runner.

### 5. Add a provider-neutral AI gateway with controlled BYOK

Expose product operations, not provider-specific calls, to domain code. Include adapters for NVIDIA NIM/OpenAI-compatible APIs and other approved providers. Route only through a learner's active, consented keys or an explicitly consented/capped admin fallback. If all providers fail, authored curriculum and deterministic grading remain available.

Encrypt provider keys with application-level envelope encryption. Learners never receive stored plaintext after entry, and ordinary administrator projections show only the last four. The explicitly approved administrator reveal ceremony requires fresh MFA and a reason, returns through a no-store response, records an immutable audit event, notifies the learner, and never places plaintext in logs, analytics, RAG, exports or backups. Administrators may also validate, disable, replace, or delete a credential under the applicable controls. The key-encryption key remains outside PostgreSQL and its backups.

### 6. Use structured learner memory before vector retrieval

Persist mastery, evidence, misconception tags, goals, preferences, project state, recent activity, and versioned chat summaries. Build prompt context from those records plus trusted lesson blocks. Do not inject all raw historical messages and do not create a learner-data vector index until an evaluated retrieval requirement justifies it.

### 7. Back up locally nightly and offsite weekly

Use encrypted, deduplicating backups to a 1–2 TB USB/NAS target with seven daily, four weekly, and twelve monthly restore points. Copy the already encrypted repository weekly to a dedicated, sufficiently provisioned Google Drive account. Do not email backup files. Test restoration quarterly.

## Alternatives considered

### Fully managed public-cloud application

**Advantages:** better availability, managed backups, less dependence on home power/ISP.\
**Rejected for the baseline because:** the owner explicitly prefers local primary storage and already has suitable hardware. The architecture keeps clean boundaries so this option remains a migration path.

### One Docker Compose stack including the code runner

**Advantages:** simplest deployment and lowest resource overhead.\
**Rejected because:** a kernel/container escape, Docker-socket error, bad mount, or network-policy mistake could expose identity, provider keys, backups, and the home LAN. Small user count does not reduce this impact.

### Microservices and a distributed queue

**Advantages:** independent scaling and fault containment.\
**Rejected initially because:** ten users do not justify deployment, tracing, schema, retry, and operational complexity. The runner and identity system already have security-driven boundaries.

### Fully browser-side compiler and storage

**Advantages:** low NUC CPU use and offline responsiveness.\
**Rejected as authoritative because:** browser/WASM runtimes differ from CPython/GCC/OpenJDK, storage is evictable and device-specific, hidden tests cannot remain secret, and results are client-tamperable.

### Native companion agent on every learner laptop

**Advantages:** native compiler behavior and reduced server use.\
**Rejected because:** it adds cross-platform installation, updater/code-signing, local arbitrary-execution, support, and environment-consistency risk. It is not required for ten users.

### A separate standalone identity service

**Advantages:** mature standalone identity boundary, broad administration UI, and extensive federation features.\
**Rejected for this deployment because:** it adds a JVM service, separate upgrade/schema/backup surface, and unnecessary operational weight for ten users when Better Auth can remain inside the chosen Next.js/Drizzle stack. Reconsider if enterprise federation or organizational identity requirements grow.

### Raw application-managed passwords and sessions without an auth framework

**Advantages:** fewer services.\
**Rejected because:** Google OAuth, password hashing/reset, MFA, recovery, cookies, CSRF/origin checks, and session revocation are specialized identity concerns. Better Auth supplies maintained primitives and a reviewed Drizzle schema; product-specific approval/role/session policy remains application code.

### Plaintext or admin-revealable BYOK

**Advantages:** easy support and recovery.\
**Rejected because:** an admin-session, XSS, audit-log, screenshot, or UI compromise would expose every learner's provider account. Replacement is supported; recovery is deliberately not.

### NVIDIA NIM self-hosted on the NUC

**Advantages:** local inference and data control.\
**Rejected because:** the NUC specification has no suitable NVIDIA GPU and production licensing/operations would be disproportionate. NIM is integrated as an external adapter.

## Consequences

### Positive

- Product domains remain easy to develop and transact consistently.
- The highest-risk workload has a meaningful host/network boundary.
- A provider outage does not prevent deterministic learning.
- Exact content, prompt, test, and runtime versions make appeals reproducible.
- Primary learner data remains locally controlled.
- The system can later move web, database, objects, runner, or identity independently.

### Negative

- The owner operates PostgreSQL, the Better Auth/Next.js identity configuration, the runner VM, backups, patching, monitoring, and incident response.
- Cloudflare, email, OAuth, AI, GitHub, and Drive mean the product is not fully on-premises.
- No UPS and one NUC/SSD/router create unavoidable availability and hardware-loss risk.
- A separate VM consumes memory and adds networking complexity.
- One-active-device policy will generate support requests and needs custom enforcement around identity sessions.
- Better Auth, its plugins, generated Drizzle schema, and custom approval/one-session hooks require pinned versions, migration review, and regression testing.
- A local object store plus long retention needs disciplined quota and backup-capacity monitoring.

## Guardrails

The following changes require a new ADR or explicit amendment:

- running hostile code in the trusted plane;
- allowing learner code unrestricted network access;
- exposing plaintext provider credentials outside the controlled fresh-MFA reveal ceremony;
- permitting an LLM to publish curriculum, receive hidden tests, or make unreviewable mastery/appeal decisions;
- enabling implicit admin impersonation;
- making browser quick-run authoritative;
- using emailed generated passwords;
- removing the offsite encrypted backup or restore testing;
- exposing the NUC through router port forwarding rather than the approved ingress boundary.

## Validation required before pilot

1. Restore a clean environment from local and offsite backups.
2. Run sandbox escape/DoS/network/secret-access adversarial tests.
3. Demonstrate Better Auth Google and password enrollment, MFA recovery, new-device replacement, session freshness, and learner/admin revocation.
4. Demonstrate that BYOK never appears in responses, logs, database dumps without ciphertext, admin screens, or backups without encryption.
5. Compile and run representative C, C++, Java, and Python exercises with recorded image digests.
6. Simulate NIM and all-provider failure and confirm authored learning/grading remain operational.
7. Verify Cloudflare is the only public path and runner/database/management networks are unreachable externally.
8. Load-test ten learners and two concurrent authoritative runs without starving PostgreSQL or the web app.

## Open follow-up decisions

- Exact production NIM endpoint, license, and routing requirement.
- Transactional email provider.
- Required MFA choices and recovery proof.
- Public-only versus private GitHub scope in the first release.
- Exact language/runtime versions.
- The owner has accepted no UPS and best-effort availability for the initial pilot; operations must retain the risk record and revisit after outage/restore evidence.
- Google Drive paid capacity and recovery owner.

## References

- [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/)
- [Better Auth Drizzle adapter](https://better-auth.com/docs/adapters/drizzle)
- [Better Auth database schema](https://better-auth.com/docs/concepts/database)
- [Better Auth session management](https://better-auth.com/docs/concepts/session-management)
- [Better Auth security](https://better-auth.com/docs/reference/security)
- [Better Auth two-factor plugin](https://better-auth.com/docs/plugins/2fa)
- [NVIDIA NIM LLM API](https://docs.nvidia.com/nim/large-language-models/latest/api-reference.html)
- [NVIDIA NIM access and production licensing](https://docs.api.nvidia.com/nim/re/docs/run-anywhere)
- [Judge0 CE API](https://ce.judge0.com/)
- [Docker rootless mode](https://docs.docker.com/engine/security/rootless/)
- [PostgreSQL Backup and Restore](https://www.postgresql.org/docs/current/backup.html)
