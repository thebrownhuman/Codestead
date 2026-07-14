# Career guidance, certificates, and public portfolios

**Implementation snapshot:** 2026-07-14\
**Database baseline:** migrations `0047_odd_drax.sql` and forward correction `0050_public_portfolio_selection_guard_fix.sql`\
**Retention policy:** `2026-07-14.v4`\
**Learner export schema:** `14`

## Product boundary

These features turn authoritative learning evidence into optional next-step guidance and learner-controlled proof. They do not use an LLM to decide completion, infer market demand, issue credentials, or publish private learner data.

- Career recommendations are administrator-authored. Prerequisites must point to current verified course versions. Ranking is deterministic from the learner's completed enrollment, mastered concepts, and valid evidence.
- Market context is optional. A published claim requires a public HTTPS source, region, observation time, administrator review time, future expiry, and reviewing administrator. Expired context is hidden rather than silently refreshed or presented as current.
- A certificate can issue only for an active learner who completed the current verified version, whose release evidence and reviewed artifact set are complete, and whose covered concepts have valid mastery evidence. The application and a PostgreSQL trigger enforce the same critical gate.
- Issue evidence is immutable. Concurrent calls serialize on the enrollment, one certificate exists per enrollment, and a content-free receipt makes a repeated request safe.
- Revocation is a separate, append-only administrator event with a bounded private reason. The public verifier exposes only the revoked state and time.
- A public portfolio is off by default. Publishing requires an explicit disclosure confirmation. Projects, achievements, and certificates are owner-bound and current; project links must be canonical public `https://github.com/owner/repository` URLs.
- Public pages are strict projections. They exclude email, scores, attempts, activity, study time, code, chat, provider/key data, evidence hashes, internal IDs, administrator actors, and private revocation reasons.

## Surfaces

Learner routes:

- `/career` — evidence-based next-technology cards and dated market context.
- `/certificates` — eligibility explanations, issue action, owned certificates, and verifier links.
- `/portfolio` — private configuration, exact disclosure text, selection, preview link, publish/withdraw.

Administrator routes:

- `/admin/career` — draft, review, publish, and retire career cards.
- `/admin/certificates` — inspect issued records and append a permanent reasoned revocation.

Public routes:

- `/verify/[verificationId]` — bounded valid/revoked certificate state.
- `/p/[slug]` — only the live learner-selected portfolio projection.

## Lifecycle

Learner export schema 16 includes private portfolio settings/history/selections, immutable published-project snapshots, certificate issue evidence, private revocation reason, content-free certificate operation history, and safe module-project assignment/start provenance. It excludes operation input hashes and all secrets.

Policy v4 retains certificate and public-portfolio records until administrator account deletion. Deletion first removes public selections and consent history, then certificate receipts/revocations/certificates, before achievements, projects, mastery evidence, and enrollments. This ordering is explicit even where database cascades exist. Career cards are product-governance content, not learner records; retiring preserves their history for reproducibility.

## Verification evidence

- Focused unit tests cover market provenance, canonical GitHub selection, route authentication and IDOR-shaped bodies, eligibility failure, idempotent issuance, administrator-only revocation, public allowlists, component disclosure, deletion order, retention classification, and migration integrity.
- The API authorization matrix explicitly registers the learner career/certificate/portfolio operations and service ownership anchors; administrator operations remain behind `requireAdmin`.
- Migration 0047 creates composite owner keys before dependent foreign keys, database issue/selection/authority guards, unique replay/concurrency constraints, and append-only history triggers. Migration 0050 safely replaces the original shared portfolio-selection trigger with table-specific project, achievement, and certificate guards so an existing database upgrades without rewriting migration history.
- A disposable PostgreSQL full-chain migration includes the original 0047 state followed by the 0050 forward correction; an immediate second migration is expected to be a no-op. The integration suite exercises all three corrected portfolio guards against that upgraded schema.

Live learner evidence, human-authored career cards, print/browser behavior, and public-route presentation still require pilot-environment verification. A local pass never claims real market accuracy or production deployment evidence.
