import { readBoundedJson } from "@/lib/http/bounded-json";
import { NextRequest } from "next/server";
import { z } from "zod";

import { adminJson, secureAdminResponse } from "@/app/api/admin/dashboard/http";
import { CurriculumAdminError, generateCurriculumReleaseEvidence } from "@/lib/curriculum-publication/admin-service";
import { generateReleaseEvidenceRequestSchema } from "@/lib/curriculum-publication/contracts";
import { requireAdmin } from "@/lib/http/authz";
import { writeAuditEvent } from "@/lib/security/audit-writer";
import { withRateLimit } from "@/lib/security/rate-limit";

import { authorizeCurriculumAdmin, curriculumErrorStatus } from "../../../authorization";

const schema = generateReleaseEvidenceRequestSchema;

export async function POST(request: NextRequest, { params }: { params: Promise<{ versionId: string }> }) {
  const authz = await requireAdmin();
  if (!authz.session) return secureAdminResponse(authz.response);
  return withRateLimit({ policy: "curriculum_mutation_admin", identity: { kind: "user", value: authz.session.user.id } }, async () => {
    const { versionId } = await params;
    const jsonBody = await readBoundedJson(request);
    if (jsonBody.response?.status === 413) return secureAdminResponse(jsonBody.response);
    const body = schema.safeParse(jsonBody.value);
    if (!z.uuid().safeParse(versionId).success || !body.success) return adminJson({ error: "Version, expected content hash, request id, reason, and explicit acknowledgement of checks not run are required. Client reports and acknowledgement identity/time are not accepted." }, 400);
    const gate = await authorizeCurriculumAdmin({ actorUserId: authz.session.user.id, sessionId: authz.session.session.id, actorRole: authz.account.role, reason: body.data.reason, action: "curriculum.publish" });
    if (!gate.allowed) return adminJson({ error: gate.code }, 403);
    await writeAuditEvent({ actorUserId: authz.session.user.id, action: "curriculum.evidence", resourceType: "course_version", resourceId: versionId, reason: body.data.reason, outcome: "allowed", metadata: { phase: "pre_mutation", expectedVersion: body.data.expectedVersion, expectedContentHash: body.data.expectedContentHash, notRunReason: body.data.notRunReason } });
    try {
      const report = await generateCurriculumReleaseEvidence({ actorUserId: authz.session.user.id, courseVersionId: versionId, ...body.data });
      await writeAuditEvent({ actorUserId: authz.session.user.id, action: "curriculum.evidence", resourceType: "course_version", resourceId: versionId, reason: body.data.reason, outcome: "success", metadata: { evidenceVersion: report.evidenceVersion, publicationRevision: report.publicationRevision, replayed: report.replayed, notRunReports: report.notRunReports } });
      return adminJson({ report });
    } catch (error) {
      const code = error instanceof CurriculumAdminError ? error.code : "EVIDENCE_FAILED";
      await writeAuditEvent({ actorUserId: authz.session.user.id, action: "curriculum.evidence", resourceType: "course_version", resourceId: versionId, reason: body.data.reason, outcome: "failure", metadata: { code } });
      return adminJson({ error: code }, curriculumErrorStatus(code));
    }
  });
}
