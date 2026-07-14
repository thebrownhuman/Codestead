# Codestead

**Build skills that stay.**

Codestead is a private, self-hosted adaptive learning studio for a small invited cohort. It combines authored curriculum, deterministic mastery rules, isolated multi-language code execution, formal exams, optional BYOK AI mentoring, and an administrator mentor console.

The repository is a **Core Beta implementation candidate**, not an approved learner-facing release and not a claim that the declared curriculum is editorially verified. Read [the release audit](docs/release-audit.md) before admitting real learners.

## Included

- Invite-only email/password and Google authentication design with mandatory TOTP, one active device family, recent-MFA gates, and role-aware APIs.
- Encrypted per-learner provider credentials for NVIDIA NIM and optional providers; secrets are masked by default and never committed.
- Twelve launch track manifests: foundations, C, C++, Java, Python, HTML, CSS, JavaScript, React, DSA, Git/tooling, and AI.
- Adaptive planning, diagnostic placement, mastery evidence, remediation, delayed review, DSA language switching, games, visualizers, and formal exams.
- A separate two-slot, HMAC-authenticated code-runner service for C, C++, Java, Python, and JavaScript.
- Admin mentoring, learner storage/quota, public GitHub static review, email outbox, encrypted backups, Cloudflare Tunnel deployment, and operations runbooks.

## Local verification

Use Node.js 22.22 or newer. Deployment is pinned to Node.js 22.23.1, which also satisfies React Router 8's runtime baseline. Docker is required for the production-shaped runner checks.

```bash
npm ci
npm run lint
npm run typecheck
npm run security:secrets
npm run security:api-surface
npm run architecture:check
npm run ai:eval -- --check
npm run test:auth-boundary
npm run test:coverage
npm run content:validate
npm run dsa:parity:check
npm run c-cpp:executable:check
npm run java-python:executable:check
npm run ai-code:executable:check
npm run web:executable:check
npm run audit:release
npm run build
```

Run the opt-in persistence/security suite against a fresh PostgreSQL 17
container (the container and its data are removed even when a test fails):

```bash
npm run test:integration
```

This suite refuses to target any database except its generated
`learncoding_integration` database. Set `INTEGRATION_POSTGRES_IMAGE` only when
testing a reviewed PostgreSQL-compatible image. Docker daemon access is
required; no real users, credentials, or production data are used.

Verify the isolated runner separately:

```bash
cd services/runner
npm ci
npm run typecheck
npm test
npm run build
npm run runtime:build
npm run runtime:test
```

`runtime:test` requires Docker and executes live compile/run, isolation, timeout,
output-cap, cleanup, and hidden-data-redaction contracts against the pinned
local runtime images. Image CVE scanning remains a separate release-host gate.

After `services/runner` has built the five pinned local runtime images, execute every authored code corpus against those exact images:

```bash
npm run dsa:parity:verify
npm run c-cpp:executable:verify
npm run java-python:executable:verify
npm run ai-code:executable:verify
npm run web:executable:verify
```

These runtime reports prove deterministic local execution only. They do not approve the still-unreviewed curriculum or replace production KVM, CVE, device, and accessibility evidence.

Browser smoke tests intentionally use demo mode and never weaken production authentication:

```bash
npx playwright install chromium firefox webkit
npm run test:e2e
```

## Local development

Copy `.env.example` to `.env`, replace every placeholder, and start PostgreSQL before exercising authenticated or persistence-backed journeys. `AUTH_REQUIRED=false` is permitted only for a local demo; production code fails closed and Compose forces authentication on.

```bash
npm run db:migrate
npm run bootstrap:admin
npm run dev
```

Never paste API keys into source, issues, screenshots, logs, commits, or support conversations. A key exposed in any chat must be revoked and replaced before use.

## Production

The reference target is an Ubuntu 24.04 Intel NUC behind outbound-only Cloudflare Tunnel, with PostgreSQL on an internal network and the hostile-code runner on a separate KVM VM. Start with [deployment.md](docs/deployment.md), then complete every linked runbook and the release blockers in [release-audit.md](docs/release-audit.md).

No production launch is approved until real secrets, pinned runner images, Gmail/Google/Cloudflare settings, backup restore, provider routing, isolation, load, browser, and accessibility drills have been completed on the target infrastructure.

## Product and engineering references

- [Product requirements](docs/PRD.md)
- [Requirements matrix](docs/requirements-matrix.md)
- [Architecture](docs/architecture.md)
- [Responsive wireframes](docs/wireframes.md)
- [Threat model](docs/threat-model.md)
- [Privacy data inventory](docs/privacy-data-inventory.md)
- [Learning model](docs/learning-model.md)
- [Assessment policy](docs/assessment-policy.md)
- [Curriculum coverage](docs/curriculum/coverage.md)
- [Web curriculum runtime evidence](docs/evidence/web-executable-runtime-2026-07-12.json)
- [Foundations/Java/Python curriculum runtime evidence](docs/evidence/java-python-executable-runtime-2026-07-12.json)
- [AI course code-lab runtime evidence](docs/evidence/ai-code-executable-runtime-2026-07-12.json)
- [Content authoring standard](docs/content-authoring-standard.md)
- [Deployment and runbooks](docs/deployment.md)
- [Load and capacity testing](docs/runbooks/load-testing.md)
- [Faulty assessment correction and regrading](docs/runbooks/assessment-corrections.md)
- [Administrator guide](docs/admin-guide.md)
- [Learner guide](docs/learner-guide.md)
- [AI provider onboarding](docs/provider-onboarding.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Dependency vulnerability disposition](docs/dependency-risk.md)

## Publication status

This project is licensed under [GNU Affero General Public License v3.0 only](LICENSE) (`AGPL-3.0-only`). It is the closest fit for a public learning platform because modified network deployments must offer their corresponding source to users.

The owner's deployment is intended to remain non-commercial. That intention is not an extra license restriction: OSI-defined open-source software cannot prohibit commercial use. Anyone redistributing or operating a modified version must follow the AGPL terms, including the network-source obligations and preservation of notices. This is a technical project choice, not legal advice.
