# Administrator guide

Codestead has one administrator who also acts as the cohort mentor. Administrator access is powerful but does not impersonate a learner: mentor reads, plan changes, overrides, credential operations, appeal decisions, and publication actions remain administrator evidence and are audited.

## Before admitting learners

1. Complete the production checklist in [deployment.md](deployment.md) and every open manual gate in [release-audit.md](release-audit.md).
2. Run migrations, bootstrap exactly one administrator, enable TOTP MFA, and store recovery material offline.
3. Configure Gmail, Cloudflare Tunnel, the isolated runner VM, encrypted backups, and at least one tested restore target.
4. Publish only curriculum versions that have independent human review and a passing release-evidence bundle. Repository-authored content starts as AI-assisted, unreviewed draft content.
5. Verify the public source-code link required by the AGPL network-use notice.

## Admission and accounts

- Review access requests in the admin access queue. Approve only the intended adult email address; the application sends a single-use activation link and never emails a generated password.
- A learner creates their own password or links the approved Google identity, verifies email, enables TOTP, and completes mandatory NVIDIA NIM onboarding.
- Only one browser profile may be active per learner. Multiple tabs in that profile are allowed. A learner locked out of that profile may request a short-lived mailbox confirmation at `/lost-device`; the link proves mailbox control only and never signs in, resets a password, or resets MFA. Before approving, follow the [lost-device recovery procedure](runbooks/lost-device-recovery.md), independently confirm identity, enter the confirmation category in a non-sensitive reason, and complete fresh MFA. Never ask for the learner's password, authenticator seed, or recovery code.
- Revoke sessions and investigate security history from the learner detail page. Never request a learner password or recovery code.

## Mentoring and learning plans

- The learner detail page shows persisted roadmap, mastery, misconceptions, attempts, projects, sessions, providers, appeals, and operational state.
- The default mentor summary never loads raw chats, source code, exam answers, integrity metadata, project PRDs/findings, or AI summary text. Use the **Audited mentor evidence reader** only when a real mentoring purpose requires one category. Every page requires a selected purpose, a specific reason, fresh MFA, and a separate audit event; sanitized items are capped at 48 KiB before the ten-record/128 KiB page cap, never use URL query parameters, and clear from the browser after five minutes. A “safely shortened” notice means the item exceeded that display cap; continue with the next audited page when offered, because the server guarantees that a page advertising more records includes a usable cursor.
- Before opening private evidence, confirm nobody else can see the screen. Clear it immediately after use. The server excludes other learners, provider credentials, passwords/tokens, session/IP/device fields, hidden blueprints/tests, reference answers, runner image/request hashes, and individual hidden-test results. Do not copy raw evidence into tickets, email, external AI, or ordinary administrator notes.
- The `AI-generated weekly summaries` category reads only already-stored bounded weekly-summary text. It does not generate a new model response and exposes no provider/model/key metadata.
- Plan edits require fresh MFA and a meaningful reason. Preview the diff and prerequisite/downstream impact before applying it.
- Plan revisions are append-only and activate immediately. Reverting creates a new revision; it does not rewrite history. Future-scheduled activation is not supported in Launch 1.
- Prerequisite or mastery overrides must be explicit, evidence-linked, notified to the learner, and audited. Administrator actions never count as learner evidence.

## Appeals and integrity

- Treat focus, paste, fullscreen, and disconnect events as non-punitive review signals. AI analysis is advisory and never determines cheating or correctness.
- Decide appeals from the immutable original submission/runtime evidence, learner reasoning, expanded tests, and any non-binding AI analysis.
- A project-review appeal is bound to the stored commit SHA, analyzer version, and exact findings. Inspect that snapshot in the same queue; deciding it must not rewrite the original review or run repository code automatically.
- Record a reason and notify the learner. When the decision identifies a faulty deterministic exam test/form, continue in `/admin/assessment-corrections`: submit a human-reviewed new bundle version and exact pinned image digest, preview the hash-bound impacts, complete fresh MFA, and queue automatic regrading. Never edit the original score. See the [faulty assessment correction runbook](runbooks/assessment-corrections.md).

## Storage reconciliation

Run the aggregate dry-run job nightly and after any restore or import. Review only its redacted counts; filenames, hashes, storage keys, paths, and learner identities must never be copied into an administrator summary or ticket. Apply requires the exact versioned confirmation and is limited to fail-closed integrity status plus idempotent quota-ledger adjustments. It never deletes unknown files or changes learner quota. Follow the [storage reconciliation runbook](runbooks/storage-reconciliation.md).

## Curriculum governance

- Stage immutable manifest, lesson, and assessment-bank snapshots.
- Assign independent human review covering technical accuracy, sources, pedagogy, accessibility, security, examples, and answer/test oracles.
- Submit release evidence only after validators, runtime checks, accessibility review, declared exclusions, and review approvals are complete.
- Publish or promote through the admin curriculum workflow. Rollback moves the active pointer to a previously approved immutable version and appends a publication event.
- Never publish live AI output directly. Learner requests and missing-topic reports enter the authoring queue.

## Provider credentials and fallback

- Credentials are encrypted in PostgreSQL and masked normally. Testing, replacement, enable/disable, preference changes, deletion, or full reveal require the applicable authorization controls.
- Full reveal requires fresh MFA, a reason, an immutable audit event, and learner notification. Do not copy a revealed key into logs, tickets, chat, exports, or backups outside the encrypted database.
- Administrator-funded fallback is granted per learner, provider, exact enabled model, time window, token cap, rupee cap, and frozen input/output price snapshot. It is revocable, starts only after every eligible learner key fails, and requires current learner fallback plus provider-specific consent. Reconcile the local price snapshot against provider billing; the application never claims that an estimate is an invoice.

## Data, notifications, and operations

- Use lifecycle controls for bounded export, retention, administrator-only deletion, and truthful backup-expiry tracking.
- Email contains only non-sensitive notices; never attach backups, keys, raw code, chat, hidden tests, or private scores.
- Monitor database, outbox, upload scanner, runner queue, provider health, disk usage, backups, and audit-chain verification.
- Follow [incident response](runbooks/incident-response.md), [backup and restore](runbooks/backup-and-restore.md), [runner isolation](runbooks/runner-isolation.md), and [updates and rollback](runbooks/updates-and-rollback.md). Preserve evidence and rotate any exposed credential immediately.
