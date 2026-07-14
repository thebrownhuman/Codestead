# Contributing

This project is currently optimized for a small private cohort. Changes should preserve deterministic learning evidence, strict tenant isolation, accessible non-AI fallbacks, and the runner trust boundary.

Before proposing a change:

1. Link it to a requirement ID or add a scoped product decision.
2. Add tests for success, denial, retry/idempotency, and cross-user behavior where relevant.
3. Run `npm run check`; it includes lint, types, secret/API/import-boundary checks, coverage, content/runtime structure gates, release-audit validation, and the production build.
4. Run `npm run test:integration` for persistence, authorization, idempotency, migration, retention, or lifecycle changes.
5. Run the runner's typecheck, tests, build, image build and runtime contracts for execution changes.
6. Update the threat model, schema migration, content source/version, runbook, or release audit when the change affects them.

Never commit secrets or learner data. Curriculum cannot be marked verified from an AI-generated draft: every required lesson, example, question form, hidden test, source, runtime, accessibility path, and publication artifact needs human review and reproducible evidence.
