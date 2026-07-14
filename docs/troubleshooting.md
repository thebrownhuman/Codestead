# Troubleshooting

Use this guide without pasting passwords, API keys, recovery codes, session tokens, raw private chat, hidden tests, or production database contents into tickets or conversations.

## Sign-in, MFA, and devices

- **Activation link rejected:** links are single-use, email-bound, and expire after 24 hours. Ask the administrator to approve a new request; never forward a link.
- **Another device is active:** sign out from the original browser profile. If it is lost, submit a revocation request and complete administrator identity confirmation.
- **TOTP fails:** confirm device time is automatic, use the current six-digit code, and try one unused recovery code. Lost-factor recovery is an administrator-assisted manual process in Launch 1.
- **Repeated redirect to onboarding:** complete profile disclosures, MFA, and a tested NVIDIA NIM credential. Check the status endpoint and application logs using request IDs, not secret values.

## Tutor and provider keys

- **Key test fails:** verify provider, expiry, quota, and allowed model access in the provider console. Replace rather than reveal the key.
- **Tutor unavailable:** authored learning remains available. Check current consent, enabled credential health, gateway timeout/rate-limit status, and provider incident information.
- **Exposed key:** revoke it at the provider immediately, add a replacement, audit reveal/use history, and scan source/logs/backups. Never reuse the exposed value.

## Code runner and exams

- **Queued:** Launch 1 supports two official executions. Keep the page open; the server-authoritative job remains queued.
- **Compile/runtime error:** Practice may offer bounded help; exams show only raw compiler/runtime messages. Hidden cases appear only as aggregate outcomes.
- **Infrastructure failure:** it must not count as a wrong answer. Preserve the job ID and retry after the runner health check recovers.
- **Exam disconnected:** reconnect to the same session; the deadline continues and the latest autosave is used. Request an equivalent re-exam after a material outage.

## Uploads and projects

- Files must be 50 MB or smaller and within the learner's 2 GB quota (administrator maximum 3 GB). Executables and unsafe archives are rejected.
- New uploads remain quarantined until the scanner marks them safe. Check clamd health and scanner leases if processing stalls.
- GitHub review accepts a canonical public repository URL and pins an exact commit. Private repositories are not supported in Launch 1.

## Deployment and operations

- Run `npm run typecheck`, `npm run test:coverage`, `npm run content:validate`, `npm run ai:eval -- --check`, `npm run audit:release`, and `npm run build` before deployment.
- Validate Compose with the reviewed production env file. A missing required image digest, public source URL, app origin, or private runner URL must fail closed.
- Apply migrations only to the intended PostgreSQL database and take a verified encrypted backup first.
- Use health checks and rotated logs for app, PostgreSQL, outbox, scanner, runner, Cloudflare, and backup jobs. Redact secret-bearing environment/configuration output.
- For recovery, follow [backup and restore](runbooks/backup-and-restore.md). Never email a backup archive or encryption key. A restore is unproven until a clean isolated drill succeeds.
- For suspected compromise, stop the affected boundary, preserve evidence, rotate credentials, and follow [incident response](runbooks/incident-response.md).
