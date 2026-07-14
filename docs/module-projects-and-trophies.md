# Module projects and evidence trophies

**Implementation version:** `2026-07-14.v1`\
**Project template version:** `module-project-2026-07-14.v1`\
**Start policy:** `module-project-start-2026-07-14.v1`\
**Trophy presentation policy:** `evidence-trophy-cabinet-2026-07-14.v1`

## What is implemented

- Every one of the 119 required modules in the 12 Launch 1 course manifests has one deterministic, solution-free practical brief.
- Each brief is bound to an exact course slug, course version, module key, source course content hash, template version, and project content hash.
- Briefs use a layman scenario, a learner role, five small milestones, normal/boundary/failure acceptance checks, reflection prompts, and optional stretch goals. They provide no finished code.
- Synchronization always creates immutable `draft` templates. AI-assisted or generated content is never published by synchronization.
- An active administrator must use fresh MFA and record a reason before a template can move `draft -> beta`, `beta -> verified`, or an active stage to `retired`.
- Publication additionally requires the exact current course pointer, matching course content hash, release evidence, at least one artifact, and no unapproved artifacts. Verified project templates require a verified course version.
- A learner can start a project only when the exact course version is active/completed, every project prerequisite skill occurs in the latest exact-version plan, and an owner-bound independent module-mastery attempt is graded, passed, at least 95%, `A0`, solution-unrevealed, and backed by the exact versioned mastery rule.
- Start is owner-bound and idempotent. Reusing a request ID with a different payload fails. Different request IDs reuse the one owner/template project rather than duplicating it.
- Assignment content, template identity, content hash, start stage, PRD snapshot, and provenance cannot be rewritten after start. Ordinary project progress may continue after later template retirement or evidence revocation.
- Starting, viewing, replaying, or completing a module project never directly awards XP, coins, mastery, a badge, a trophy, or a certificate.

## Trophy cabinet truth model

The trophy cabinet is a read-only presentation. It includes only:

1. an already-issued course certificate, with a live `earned` or `revoked` state; or
2. an exact `exam-mastery-v1` learner achievement whose evidence resolves to the same learner's graded independent attempt with the required rule, score, assistance, and solution state.

Invalid, mismatched, assisted, ungraded, under-threshold, or owner-mismatched achievement rows are omitted. Revoked evidence remains visible to its owner as revoked, never as valid. Public visibility appears only when the learner explicitly selected the evidence and the public portfolio is currently published. Coins are deliberately disabled and reported as zero.

## Administrator workflow

1. Stage the course catalog with `npm run curriculum:stage` or the administrator curriculum screen.
2. Synchronize project drafts with `npm run projects:catalog:sync`, the normal seed command, or `/admin/module-projects` after fresh MFA.
3. Open `/admin/module-projects`, inspect the complete learner-facing brief and exact content hash, enter the authenticator code and a specific reason, then approve beta.
4. Promote to verified only after the underlying course is verified. Retire obsolete templates rather than editing their content.

The public API never accepts a learner ID for project starts. The session owner is the only owner authority. Administrator transition endpoints are role-, fresh-MFA-, rate-limit-, expected-version-, reason-, and audit-gated.

## Learner workflow

The Projects page shows a filterable module-project arcade with explicit states:

- `Editorial draft` — not learner-ready;
- `Plan skills needed` — exact plan prerequisites are incomplete;
- `Mastery exam needed` — plan is ready but independent evidence is missing;
- `Ready to build` — all gates pass;
- `Started` — the learner-owned project and immutable assignment snapshot exist;
- `Retired` — the template or course pointer is no longer current.

Opening a brief shows the plain-language scenario, mission, outcomes, milestones, evidence, acceptance checks, reflection, stretch work, and the no-direct-award notice. The Certificates page shows the evidence trophy cabinet and links to learner-controlled portfolio visibility.

## Persistence, export, and deletion

- `module_project_template` and `module_project_template_event` are product governance records retained with versioned curriculum.
- `module_project_start_receipt` contains owner/template/project IDs, an opaque request ID, canonical input hash, and time. It contains no code, answer, provider key, prompt/response, hidden test, session/device data, or reward amount.
- Learner export schema 16 includes project assignment provenance and safe start history, but explicitly excludes the internal input hash.
- Account deletion removes public selections, then module-project start receipts before projects. Templates and governance history remain product content and contain no learner assignment body.

## Verification evidence

- `npm run projects:catalog:validate` checks complete 119/119 coverage and content integrity.
- Unit tests cover deterministic hashes, duplicate/stale/reward-bearing catalog rejection, exact plan matching, draft/retired/mastery states, trophy evidence filtering, revocation, zero coins, route owner binding, export redaction, and deletion order.
- `integration/module-projects-trophies.integration.test.ts` applies to real PostgreSQL and covers direct draft-publish bypass, publication replay, cross-owner denial, missing mastery, exact independent mastery, project/start replay, duplicate prevention, assignment tamper rejection, zero reward-ledger writes, trophy evidence, and revocation.
- The disposable integration runner applies the complete migration chain twice before executing these scenarios.

## Honest limitations

- The catalog is comprehensive against the declared Launch 1 manifests, not every possible future technology or framework. New scope requires a new reviewed course/module version.
- A project brief teaches transfer and planning; it does not automatically judge a finished repository. Repository review remains a separate explicit, static-review workflow.
- Browser screenshots and production deployment evidence remain separate release gates. No UI can make unreviewed curriculum accurate by itself.
