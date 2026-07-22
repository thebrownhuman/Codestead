# API authorization verification

The source authorization inventory covers every exported API operation rather than a sample. The current generated snapshot contains 154 operations in 120 route files:

| Boundary | Operations | Executable denial check |
|---|---:|---|
| Reviewed public allowlist | 5 | Static exact allowlist and mandatory rate limit |
| Better Auth catch-all | 2 | Delegated provider boundary; generic admin permissions denied separately |
| Authenticated learner/self | 87 | Endpoint sweep verifies that the handler calls `requireAuth` before request work |
| Administrator | 60 | Endpoint sweep verifies that the handler calls `requireAdmin` before request work |

This is a static source inventory, not a claim that every owner boundary has been executed with two real users. It records 83 operations whose user context comes from the authenticated session, 36 identifier-bearing ownership contracts, and 16 supporting-service ownership-proof entries. The two consent-projected cohort reads, `GET /api/community` and `GET /api/community/profiles/[publicId]`, deliberately expose only the social-profile projection. The authenticated runner-availability probe and interest preview do not read an owned user object.

The generic Better Auth administrator surface stays fail-closed. Both learner and admin roles are executable-tested against every permission in Better Auth's default `user` and `session` statements; all are denied. Sensitive administrator work uses application-owned routes with the required MFA, reason, audit, and notification contracts.

Run the checks with:

```powershell
npm.cmd run security:api-surface
npm.cmd run security:api-surface:apply
npm.cmd run test:auth-boundary
npx.cmd vitest run src/lib/security/__tests__/api-surface.test.ts src/lib/security/__tests__/api-authorization-matrix.test.ts src/lib/security/__tests__/better-auth-admin-policy.test.ts src/lib/http/__tests__/authz.test.ts
npm.cmd run test:integration -- integration/runtime-authorization.integration.test.ts
```

The final command creates and destroys a disposable PostgreSQL container and therefore requires an available Docker daemon; it refuses any database whose name is not `learncoding_integration`.

The generated evidence is [`docs/evidence/api-authorization-matrix-2026-07-12.json`](evidence/api-authorization-matrix-2026-07-12.json). The dated suffix is a stable artifact name, not proof of freshness. `npm.cmd run security:api-surface` verifies the committed bytes without rewriting them; `npm.cmd run security:api-surface:apply` is the intentional regeneration command. Source hashes make reviewed route or supporting-service changes visible on the next check.

The endpoint boundary sweep has a separate mandatory Vitest configuration because it imports every route module only to exercise its early authorization exit. The same gate now also executes the real `requireAuth`/`requireAdmin` decision logic, including durable account status, per-session MFA and fresh database role checks. Counting every transitively imported service as uncovered unit code would make the coverage denominator describe module discovery rather than unit behavior. `npm run check` and CI run `test:auth-boundary` explicitly before the unchanged unit-coverage gate; no threshold is lowered and the security test is never skipped in release verification.

The measured [coverage-separation evidence](evidence/auth-boundary-coverage-separation-2026-07-12.json) records earlier test universes and is historical. Its counts, and earlier 104-file/127-operation release-audit counts, are not the current inventory and are not automatically updated by this document.

## Behavioral cross-owner coverage

[`integration/runtime-authorization.integration.test.ts`](../integration/runtime-authorization.integration.test.ts) invokes real route handlers and production repositories/services against disposable PostgreSQL with two seeded learners. The harness stubs the authentication result to select a seeded learner and bypasses rate-limit and recent-MFA setup already covered by separate suites; the ownership repositories, services, and database writes remain real. It asserts both the response and unchanged database state.

The following 11 operations have this route-level two-owner coverage:

| Resource | Behaviorally covered operations | Cross-owner assertion |
|---|---|---|
| Drafts | `GET /api/drafts`, `PUT /api/drafts` | Learner A reads only A's draft; B's idempotency receipt cannot mutate either draft (`409`) |
| Files | `GET /api/files/[id]`, `DELETE /api/files/[id]` | B's object is hidden (`404`), remains undeleted, and no quota release is written |
| Provider credentials | `PATCH /api/credentials/[id]`, `DELETE /api/credentials/[id]` | B's credential is hidden (`404`) and remains active |
| Learning attempts | `POST /api/learning/attempts/[attemptId]/submit`, `POST /api/learning/attempts/[attemptId]/help` | B's attempt is hidden (`404`); no answer/help evidence is created |
| Projects | `GET /api/projects` | Only A's private project is returned |
| Project revisions | `GET /api/projects/[id]/revisions`, `POST /api/projects/[id]/revisions` | B's project is hidden (`404`) and no revision is created |

Additional repository/service integration suites exercise ownership for learning sessions/attempts, exam autosaves, learner drafts, project revisions and review appeals, chat lifecycle, daily review, tutor memory, auth recovery, module projects, certificates and portfolios, and community groups and battles. Those tests are useful supporting evidence, but they are not counted as route-level coverage above.

The following 76 authenticated operations still lack the same two-learner route/real-service PostgreSQL harness. Compact forms such as `GET|POST /path` denote two separate exported operations:

- AI and code: `POST /api/ai/reports`, `GET|PATCH /api/ai/threads/[threadId]`, `GET /api/ai/threads`, `POST /api/ai/tutor`, and `GET|POST /api/code/run`.
- Battles, career, and achievements: `GET|POST /api/battles`, `GET|POST /api/battles/[battleId]`, `GET /api/career`, `GET|POST /api/certificates`, and `GET /api/trophies`.
- Community/profile: `GET|POST /api/community/discussions`, `GET|PATCH /api/community/profile`, `GET /api/community`, and `GET /api/community/profiles/[publicId]`.
- Provider credentials and files: `GET|POST /api/credentials`, `GET|POST /api/files`.
- Exams: `GET /api/exams`, `POST /api/exams/start`, `GET /api/exams/[sessionId]`, `PUT /api/exams/[sessionId]/autosave`, `POST /api/exams/[sessionId]/events`, `POST /api/exams/[sessionId]/heartbeat`, `POST /api/exams/[sessionId]/run`, `POST /api/exams/[sessionId]/submit`, `POST /api/exams/[sessionId]/appeal`, `POST /api/exams/[sessionId]/appeal/reply`, and `POST /api/exams/rechecks/[recheckId]/start`.
- Learning: `GET|POST /api/learning-requests`, `POST /api/learning/attempts`, `GET|POST /api/learning/daily-review`, `POST /api/learning/daily-review/[sessionId]/items/[itemId]/attempt`, `POST /api/learning/dsa/language`, `GET /api/learning/next`, `POST /api/learning/placement`, `POST /api/learning/plans`, `GET|PATCH /api/learning/sessions/[sessionId]`, `POST /api/learning/sessions/[sessionId]/events`, and `POST /api/learning/sessions`.
- Projects, games, and module projects: `POST /api/projects`, `GET /api/projects/[id]/revisions/[revisionId]`, `POST /api/projects/[id]/review`, `POST /api/projects/[id]/reviews/[reviewId]/appeal`, `POST /api/games/check`, and `GET|POST /api/module-projects`.
- Notifications: `GET|PATCH /api/notifications`, and `GET|PATCH /api/notifications/preferences`.
- Onboarding, portfolio, and privacy: `POST /api/onboarding/complete`, `POST /api/onboarding/interests/preview`, `POST /api/onboarding/profile`, `GET /api/onboarding/status`, `GET|PATCH /api/portfolio`, and `GET|POST /api/privacy/consents`.
- Security and sessions: `POST /api/security/fresh-mfa`, `POST /api/security/verify-backup-code`, `GET|POST /api/session-revocation-requests`, `DELETE /api/sessions/[id]`, and `GET|DELETE /api/sessions`.

This remaining list is deliberately explicit. A static ownership anchor or a mocked guard invocation must not be described as runtime IDOR proof.

## Deliberate limits

- PostgreSQL row-level security is not present. Current isolation is enforced at the application/query layer, so AUTH-007 remains Partial against its defense-in-depth requirement.
- The representative PostgreSQL harness supplies the session-derived learner identity directly; it does not create real Better Auth cookies. These checks do not send signed learner/admin cookies through a deployed Cloudflare Tunnel, reverse proxy, Next.js server, and PostgreSQL instance. A deployment penetration run is still required.
- Better Auth's permission objects are exercised locally, but its catch-all HTTP handler is not tested end to end with real role-bearing sessions.
- The source inventory must be rerun whenever a route, ownership service, or Better Auth policy changes. The behavioral list must be updated only when an actual two-owner route/service test is added.
