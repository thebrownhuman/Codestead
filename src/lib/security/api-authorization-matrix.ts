import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  auditApiSurface,
  extractExportedHttpOperations,
  normalizeSourceText,
  type ApiBoundary,
} from "./api-surface";

export type AuthorizationExpectation =
  | "allowed"
  | "authenticated"
  | "administrator"
  | "delegated-to-auth-provider";

export type ObjectAuthorizationMode =
  | "public-input"
  | "auth-provider"
  | "session-user"
  | "consent-projected-cohort"
  | "no-user-object"
  | "administrator-scope";

export type ApiAuthorizationMatrixRow = Readonly<{
  operation: string;
  file: string;
  route: string;
  method: string;
  boundary: ApiBoundary;
  anonymous: AuthorizationExpectation;
  learner: AuthorizationExpectation;
  admin: AuthorizationExpectation;
  objectAuthorization: ObjectAuthorizationMode;
  ownershipProof: string;
  operationSourceSha256: string;
}>;

const COHORT_SHARED_OPERATIONS = new Map<string, string>([
  ["GET /api/community", "listVisibleProfileOwners() + loadVisibleCohortProfile() consent projection"],
  ["GET /api/community/profiles/[publicId]", "loadVisibleCohortProfile(publicId) consent projection"],
]);

const NO_USER_OBJECT_OPERATIONS = new Map<string, Readonly<{ ownershipProof: string; anchor: string }>>([
  ["GET /api/code/run", {
    ownershipProof: "authenticated runner availability probe",
    anchor: "client.checkAvailability()",
  }],
  ["POST /api/onboarding/interests/preview", {
    ownershipProof: "stateless interest-category preview",
    anchor: "inferInterestCategory(",
  }],
]);

/**
 * Every authenticated operation not listed above is deliberately self-scoped.
 * Keeping this list explicit makes a new endpoint fail the security audit until
 * its object-authorization contract has been reviewed.
 */
const SESSION_USER_OPERATIONS = new Set([
  "POST /api/ai/reports",
  "POST /api/ai/tutor",
  "GET /api/ai/threads",
  "GET /api/ai/threads/[threadId]",
  "PATCH /api/ai/threads/[threadId]",
  "GET /api/battles",
  "POST /api/battles",
  "GET /api/battles/[battleId]",
  "POST /api/battles/[battleId]",
  "POST /api/code/run",
  "GET /api/career",
  "GET /api/certificates",
  "POST /api/certificates",
  "GET /api/drafts",
  "PUT /api/drafts",
  "GET /api/community/profile",
  "PATCH /api/community/profile",
  "GET /api/community/discussions",
  "POST /api/community/discussions",
  "DELETE /api/credentials/[id]",
  "PATCH /api/credentials/[id]",
  "GET /api/credentials",
  "POST /api/credentials",
  "POST /api/exams/[sessionId]/appeal/reply",
  "POST /api/exams/[sessionId]/appeal",
  "PUT /api/exams/[sessionId]/autosave",
  "POST /api/exams/[sessionId]/events",
  "POST /api/exams/[sessionId]/heartbeat",
  "GET /api/exams/[sessionId]",
  "POST /api/exams/[sessionId]/run",
  "POST /api/exams/[sessionId]/submit",
  "GET /api/exams",
  "POST /api/exams/rechecks/[recheckId]/start",
  "POST /api/exams/start",
  "DELETE /api/files/[id]",
  "GET /api/files/[id]",
  "GET /api/files",
  "POST /api/files",
  "POST /api/games/check",
  "GET /api/learning-requests",
  "POST /api/learning-requests",
  "POST /api/learning/attempts/[attemptId]/help",
  "POST /api/learning/attempts/[attemptId]/submit",
  "POST /api/learning/attempts",
  "GET /api/learning/daily-review",
  "POST /api/learning/daily-review",
  "POST /api/learning/daily-review/[sessionId]/items/[itemId]/attempt",
  "POST /api/learning/dsa/language",
  "GET /api/learning/next",
  "POST /api/learning/placement",
  "POST /api/learning/plans",
  "POST /api/learning/sessions/[sessionId]/events",
  "GET /api/learning/sessions/[sessionId]",
  "PATCH /api/learning/sessions/[sessionId]",
  "POST /api/learning/sessions",
  "GET /api/module-projects",
  "POST /api/module-projects",
  "POST /api/onboarding/complete",
  "POST /api/onboarding/profile",
  "GET /api/onboarding/status",
  "GET /api/notifications",
  "PATCH /api/notifications",
  "GET /api/notifications/preferences",
  "PATCH /api/notifications/preferences",
  "GET /api/portfolio",
  "PATCH /api/portfolio",
  "GET /api/privacy/consents",
  "POST /api/privacy/consents",
  "POST /api/projects/[id]/review",
  "POST /api/projects/[id]/reviews/[reviewId]/appeal",
  "GET /api/projects/[id]/revisions",
  "POST /api/projects/[id]/revisions",
  "GET /api/projects/[id]/revisions/[revisionId]",
  "GET /api/projects",
  "POST /api/projects",
  "POST /api/security/fresh-mfa",
  "POST /api/security/verify-backup-code",
  "GET /api/session-revocation-requests",
  "POST /api/session-revocation-requests",
  "DELETE /api/sessions/[id]",
  "DELETE /api/sessions",
  "GET /api/sessions",
  "GET /api/trophies",
]);

/**
 * Identifier-bearing learner operations need a stronger, operation-specific
 * anchor than merely mentioning the session user. These anchors bind the path
 * or body object to that authenticated user, directly or through a reviewed
 * service whose first/input user id is session-derived.
 */
const IDENTIFIER_OWNERSHIP_ANCHORS = new Map<string, string>([
  ["POST /api/ai/reports", "eq(modelCall.userId, authz.session.user.id)"],
  ["POST /api/ai/tutor", "eq(chatThread.userId, authz.session.user.id)"],
  ["GET /api/battles/[battleId]", "getBattle({ actorUserId: authz.session!.user.id, battleId })"],
  ["POST /api/battles/[battleId]", "actorUserId: authz.session!.user.id, battleId"],
  ["POST /api/certificates", "userId: authz.session!.user.id"],
  ["GET /api/community/discussions", "actorUserId: authz.session.user.id"],
  ["POST /api/community/discussions", "actorUserId: authz.session.user.id"],
  ["GET /api/ai/threads/[threadId]", "userId: authz.session.user.id"],
  ["PATCH /api/ai/threads/[threadId]", "userId: authz.session.user.id"],
  ["DELETE /api/credentials/[id]", "eq(providerCredential.userId, authz.session.user.id)"],
  ["PATCH /api/credentials/[id]", "eq(providerCredential.userId, authz.session.user.id)"],
  ["POST /api/exams/[sessionId]/appeal/reply", "userId: authz.session.user.id"],
  ["POST /api/exams/[sessionId]/appeal", "userId: authz.session.user.id"],
  ["PUT /api/exams/[sessionId]/autosave", "userId: authz.session.user.id"],
  ["POST /api/exams/[sessionId]/events", "userId: authz.session.user.id"],
  ["POST /api/exams/[sessionId]/heartbeat", "heartbeatExam(authz.session.user.id, sessionId)"],
  ["GET /api/exams/[sessionId]", "getExamSession(authz.session.user.id, sessionId)"],
  ["POST /api/exams/[sessionId]/run", "userId: authz.session.user.id"],
  ["POST /api/exams/[sessionId]/submit", "submitExam(authz.session.user.id, sessionId)"],
  ["POST /api/exams/rechecks/[recheckId]/start", "startMasteryRecheck(authz.session.user.id, recheckId"],
  ["DELETE /api/files/[id]", "ownerUserId: authz.session.user.id"],
  ["GET /api/files/[id]", "eq(storedObject.ownerUserId, authz.session.user.id)"],
  ["POST /api/learning/attempts/[attemptId]/help", "userId: authz.session.user.id"],
  ["POST /api/learning/attempts/[attemptId]/submit", "learningService.submitAttempt(authz.session.user.id, attemptId"],
  ["POST /api/learning/daily-review/[sessionId]/items/[itemId]/attempt", "authz.session.user.id,\n      params.sessionId"],
  ["POST /api/learning/sessions/[sessionId]/events", "userId: authz.session.user.id"],
  ["GET /api/learning/sessions/[sessionId]", "learningService.getSession(authz.session.user.id, sessionId)"],
  ["PATCH /api/learning/sessions/[sessionId]", "userId: authz.session.user.id"],
  ["POST /api/projects/[id]/review", "eq(project.userId, authz.session.user.id)"],
  ["POST /api/projects/[id]/reviews/[reviewId]/appeal", "userId: authz.session.user.id"],
  ["GET /api/projects/[id]/revisions", "userId: authz.session.user.id"],
  ["POST /api/projects/[id]/revisions", "userId: authz.session.user.id"],
  ["GET /api/projects/[id]/revisions/[revisionId]", "userId: authz.session.user.id"],
  ["PATCH /api/portfolio", "userId: authz.session.user.id"],
  ["POST /api/module-projects", "userId: authz.session!.user.id"],
  ["DELETE /api/sessions/[id]", "userId: authz.session.user.id"],
]);

const SUPPORTING_OWNER_CONTRACTS = [
  {
    file: "src/lib/battles/service.ts",
    purpose: "scope-visible battles, participant-bound submissions, and reviewed immutable challenge sources",
    anchors: [
      "battle.scope in ('cohort','weekly','monthly') or participant.user_id is not null",
      "if (!battle.participant) throw new BattleError(\"NOT_PARTICIPANT\")",
      "where id=$1 and user_id=$2 and activity_id=$3 and status='graded'",
      "reviewedAuthoredActivitySpecification(",
    ],
  },
  {
    file: "src/lib/community/service.ts",
    purpose: "closed-cohort group visibility and author-owned community mutations",
    anchors: [
      "g.visibility = 'cohort' or member.user_id is not null",
      "where id=$1 and author_user_id=$2",
      "consent.decision='accepted' and consent.policy_version=$2",
      "actor.role !== \"admin\" && group.member_role !== \"owner\"",
    ],
  },
  {
    file: "src/app/api/exams/_lib/service.ts",
    purpose: "exam sessions and answers",
    anchors: [
      "eq(examSession.id, sessionId), eq(examSession.userId, userId)",
      "eq(examSession.id, input.sessionId)",
      "eq(examSession.userId, input.userId)",
      "eq(examMasteryRecheck.id, recheckId), eq(examMasteryRecheck.userId, userId)",
    ],
  },
  {
    file: "src/lib/learning-service/drizzle-store.ts",
    purpose: "learning sessions and attempts",
    anchors: [
      "eq(learningSession.id, sessionId), eq(learningSession.userId, userId)",
      "eq(attempt.id, attemptId), eq(attempt.userId, userId), eq(enrollment.userId, userId)",
      "eq(practiceHelpEvent.userId, userId), eq(practiceHelpEvent.requestId, requestId)",
      "eq(attempt.helpStep, input.expectedStep)",
    ],
  },
  {
    file: "src/lib/daily-review/service.ts",
    purpose: "learner-local daily review sessions and items",
    anchors: [
      "where item.id = $1 and item.session_id = $2 and item.user_id = $3",
      "where session.id = $1 and session.user_id = $2",
      "where id = $3 and session_id = $4 and user_id = $5",
    ],
  },
  {
    file: "src/lib/appeals/project-review-service.ts",
    purpose: "project-review appeals",
    anchors: ["where pr.id = $1 and p.id = $2 and p.user_id = $3"],
  },
  {
    file: "src/lib/storage/file-deletion.ts",
    purpose: "owner-bound file tombstone, quota release, and durable erasure enqueue",
    anchors: [
      "where id = $1 and owner_user_id = $2",
      "where id = $1 and owner_user_id = $2 and deleted_at is null",
      "where user_id = $1 and idempotency_key = $2",
    ],
  },
  {
    file: "src/lib/projects/revision-service.ts",
    purpose: "learner-owned project revisions and file associations",
    anchors: [
      "select id from project where id = $1 and user_id = $2 for update",
      "where p.id = $1 and p.user_id = $2",
      "where revision.id = $1 and revision.project_id = $2 and p.user_id = $3",
      "where owner_user_id = $1",
    ],
  },
  {
    file: "src/lib/session-controls.ts",
    purpose: "learner session revocation",
    anchors: ["eq(session.id, input.sessionId), eq(session.userId, input.userId)"],
  },
  {
    file: "src/lib/certificates/service.ts",
    purpose: "learner-owned certificate candidates and immutable issuance",
    anchors: [
      "where enrollment.id=$2 and enrollment.user_id=$1",
      "where user_id=$1 and request_id=$2",
      "where certificate.id=$1 and certificate.user_id=$2",
      "where certificate.user_id=$1 order by certificate.issued_at desc,certificate.id",
    ],
  },
  {
    file: "src/lib/portfolio/service.ts",
    purpose: "learner-owned public portfolio selections and projection",
    anchors: [
      "select id,title,summary,status,github_url,updated_at from project",
      "select id from user_achievement where user_id=$1 and revoked_at is null and id=any($2::uuid[])",
      "where certificate.user_id=$1 and certificate.id=any($2::uuid[])",
      "select input_hash,event,resulting_version from public_portfolio_event",
    ],
  },
  {
    file: "src/lib/projects/module-project-service.ts",
    purpose: "exact-version learner-owned module-project eligibility and idempotent start",
    anchors: [
      "enrollment.course_version_id=version.id and enrollment.user_id=$1",
      "where user_id=$1 and request_id=$2",
      "where id=$1 and user_id=$2",
      "owned.user_id=$1 and owned.revoked_at is null",
    ],
  },
  {
    file: "src/lib/achievements/trophy-cabinet.ts",
    purpose: "learner-owned certificate and independent mastery trophy projection",
    anchors: [
      "where certificate.user_id=$1",
      "where owned.user_id=$1 and badge.rule_version=$2",
      "evidence_attempt.user_id=owned.user_id",
    ],
  },
  {
    file: "src/lib/social/profile-service.ts",
    purpose: "consent-projected cohort sharing",
    anchors: [
      "where cp.user_id = $1 and cp.is_published",
      "consent.decision = 'accepted' and consent.policy_version = $2",
      "where user_id = $1 and visibility = 'cohort'",
    ],
  },
  {
    file: "src/lib/ai/chat-lifecycle.ts",
    purpose: "learner-owned tutor thread history",
    anchors: [
      "where t.user_id = $1",
      "where id = $1 and user_id = $2 and status in ('active', 'archived')",
      "where id = $1 and user_id = $2 and status in ('active', 'archived')\n      for update",
      "where id = $1 and user_id = $2 returning status,updated_at",
    ],
  },
  {
    file: "src/lib/ai/tutor-memory.ts",
    purpose: "bounded learner-owned tutor structured memory",
    anchors: [
      "where cm.user_id = $1 and cm.concept_id = c.id",
      "where user_id = $1 and template = 'weekly-summary'",
      "where t.id = $1 and t.user_id = $2 and t.status = 'active'",
      "where user_id = $1 and enrollment_id = $2 and concept_id = $3",
    ],
  },
  {
    file: "src/lib/ai/provider-credential-outcome.ts",
    purpose: "provider-result credential snapshot CAS",
    anchors: [
      "eq(providerCredential.userId, input.snapshot.userId)",
      "eq(providerCredential.status, \"active\")",
      "eq(providerCredential.keyVersion, input.snapshot.keyVersion)",
      "eq(providerCredentialUpdatedAtToken, input.snapshot.updatedAtToken)",
    ],
  },
] as const;

function expectations(boundary: ApiBoundary) {
  if (boundary === "public") {
    return { anonymous: "allowed", learner: "allowed", admin: "allowed" } as const;
  }
  if (boundary === "auth-handler") {
    return {
      anonymous: "delegated-to-auth-provider",
      learner: "delegated-to-auth-provider",
      admin: "delegated-to-auth-provider",
    } as const;
  }
  if (boundary === "admin") {
    return { anonymous: "authenticated", learner: "administrator", admin: "allowed" } as const;
  }
  return { anonymous: "authenticated", learner: "allowed", admin: "allowed" } as const;
}

function operationContract(operation: string, boundary: ApiBoundary, body: string) {
  if (boundary === "public") {
    return { objectAuthorization: "public-input", ownershipProof: "validated public request" } as const;
  }
  if (boundary === "auth-handler") {
    return { objectAuthorization: "auth-provider", ownershipProof: "Better Auth session and account policy" } as const;
  }
  if (boundary === "admin") {
    return { objectAuthorization: "administrator-scope", ownershipProof: "requireAdmin() before request parsing or data access" } as const;
  }

  const cohortProof = COHORT_SHARED_OPERATIONS.get(operation);
  if (cohortProof) {
    const expectedAnchor = operation === "GET /api/community"
      ? "listVisibleProfileOwners()"
      : "loadVisibleCohortProfile((await params).publicId)";
    return body.includes(expectedAnchor)
      ? { objectAuthorization: "consent-projected-cohort", ownershipProof: cohortProof } as const
      : null;
  }
  const noObjectContract = NO_USER_OBJECT_OPERATIONS.get(operation);
  if (noObjectContract) {
    return body.includes(noObjectContract.anchor)
      ? { objectAuthorization: "no-user-object", ownershipProof: noObjectContract.ownershipProof } as const
      : null;
  }
  if (!SESSION_USER_OPERATIONS.has(operation)) return null;
  const strongerAnchor = IDENTIFIER_OWNERSHIP_ANCHORS.get(operation);
  const expectedAnchor = strongerAnchor ?? "authz.session.user.id";
  if (!body.includes(expectedAnchor)) return null;
  return {
    objectAuthorization: "session-user",
    ownershipProof: strongerAnchor
      ? `identifier bound by ${strongerAnchor}`
      : "all user context is derived from authz.session.user.id",
  } as const;
}

export async function auditApiAuthorizationMatrix(root: string) {
  const surface = await auditApiSurface(root);
  const errors = [...surface.errors];
  const rows: ApiAuthorizationMatrixRow[] = [];

  for (const entry of surface.entries) {
    const source = normalizeSourceText(await readFile(path.resolve(root, entry.file), "utf8"));
    const operations = extractExportedHttpOperations(source, entry.file);
    for (const method of entry.methods) {
      const operation = `${method} ${entry.route}`;
      const body = operations.get(method) ?? "";
      const contract = operationContract(operation, entry.boundary, body);
      if (!contract) {
        errors.push(`${entry.file}#${method}: object-authorization contract is missing or its reviewed ownership anchor changed.`);
        continue;
      }
      rows.push({
        operation,
        file: entry.file,
        route: entry.route,
        method,
        boundary: entry.boundary,
        ...expectations(entry.boundary),
        ...contract,
        operationSourceSha256: createHash("sha256").update(body).digest("hex"),
      });
    }
  }

  const reviewedAuthenticated = new Set([
    ...SESSION_USER_OPERATIONS,
    ...COHORT_SHARED_OPERATIONS.keys(),
    ...NO_USER_OBJECT_OPERATIONS.keys(),
  ]);
  const actualAuthenticated = new Set(rows
    .filter((row) => row.boundary === "authenticated")
    .map((row) => row.operation));
  for (const operation of reviewedAuthenticated) {
    if (!actualAuthenticated.has(operation)) {
      errors.push(`${operation}: reviewed authenticated operation is missing from the current API surface.`);
    }
  }

  const supportingOwnershipProofs = [];
  for (const contract of SUPPORTING_OWNER_CONTRACTS) {
    const source = normalizeSourceText(await readFile(path.resolve(root, contract.file), "utf8"));
    const missing = contract.anchors.filter((anchor) => !source.includes(anchor));
    if (missing.length > 0) {
      errors.push(`${contract.file}: supporting ${contract.purpose} ownership contract changed (${missing.length} anchor(s) missing).`);
    }
    supportingOwnershipProofs.push({
      file: contract.file,
      purpose: contract.purpose,
      anchors: contract.anchors.length,
      sourceSha256: createHash("sha256").update(source).digest("hex"),
    });
  }

  const modeCounts = rows.reduce<Partial<Record<ObjectAuthorizationMode, number>>>((counts, row) => {
    counts[row.objectAuthorization] = (counts[row.objectAuthorization] ?? 0) + 1;
    return counts;
  }, {});
  return {
    schemaVersion: 1,
    files: surface.files,
    operations: surface.operations,
    matrixRows: rows.length,
    boundaryCounts: surface.boundaryCounts,
    objectAuthorizationCounts: modeCounts,
    identifierOwnershipContracts: IDENTIFIER_OWNERSHIP_ANCHORS.size,
    supportingOwnershipProofs,
    errors,
    rows,
  } as const;
}
