import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { requireAuth } from "@/lib/http/authz";
import { loadOwnPublicPortfolioSettings, PublicPortfolioError, updatePublicPortfolio } from "@/lib/portfolio/service";
import { writeAuditEvent } from "@/lib/security/audit-writer";
import { withRateLimit } from "@/lib/security/rate-limit";

const noStore = { "Cache-Control": "private, no-store, max-age=0", "X-Robots-Tag": "noindex, nofollow" };
const updateSchema = z.object({
  requestId: z.uuid(),
  expectedVersion: z.number().int().min(0),
  slug: z.string().trim().regex(/^[a-z0-9][a-z0-9-]{2,39}$/),
  displayName: z.string().trim().min(1).max(120),
  headline: z.string().trim().min(10).max(180),
  about: z.string().trim().max(1_200).nullable(),
  publish: z.boolean(),
  confirmPublicDisclosure: z.boolean(),
  selectedProjectIds: z.array(z.uuid()).max(50),
  selectedAchievementIds: z.array(z.uuid()).max(50),
  selectedCertificateIds: z.array(z.uuid()).max(50),
}).strict();

function status(code: string) {
  if (code === "NOT_FOUND") return 404;
  if (["INVALID_REQUEST", "INVALID_SELECTION", "DISCLOSURE_CONFIRMATION_REQUIRED"].includes(code)) return 400;
  return 409;
}

export async function GET() {
  const authz = await requireAuth();
  if (!authz.session) return authz.response;
  return NextResponse.json({ settings: await loadOwnPublicPortfolioSettings(authz.session.user.id) }, { headers: noStore });
}

export async function PATCH(request: NextRequest) {
  const authz = await requireAuth();
  if (!authz.session) return authz.response;
  return withRateLimit(
    { policy: "portfolio_mutation_user", identity: { kind: "user", value: authz.session.user.id } },
    async () => {
      const parsed = updateSchema.safeParse(await request.json().catch(() => null));
      if (!parsed.success) return NextResponse.json({ error: "INVALID_REQUEST" }, { status: 400, headers: noStore });
      const auditMetadata = {
        publish: parsed.data.publish,
        expectedVersion: parsed.data.expectedVersion,
        projectCount: parsed.data.selectedProjectIds.length,
        achievementCount: parsed.data.selectedAchievementIds.length,
        certificateCount: parsed.data.selectedCertificateIds.length,
      };
      try {
        await writeAuditEvent({
          actorUserId: authz.session.user.id,
          subjectUserId: authz.session.user.id,
          action: "public_portfolio.update",
          resourceType: "public_portfolio",
          resourceId: authz.session.user.id,
          outcome: "allowed",
          correlationId: parsed.data.requestId,
          metadata: { ...auditMetadata, phase: "pre_mutation" },
        });
      } catch {
        return NextResponse.json(
          { error: "Portfolio mutation protection is temporarily unavailable." },
          { status: 503, headers: noStore },
        );
      }
      try {
        const result = await updatePublicPortfolio({ userId: authz.session.user.id, ...parsed.data });
        const completionAuditRecorded = await writeAuditEvent({
          actorUserId: authz.session.user.id,
          subjectUserId: authz.session.user.id,
          action: `public_portfolio.${result.event}`,
          resourceType: "public_portfolio",
          resourceId: authz.session.user.id,
          outcome: "success",
          correlationId: parsed.data.requestId,
          metadata: { ...auditMetadata, rowVersion: result.rowVersion, replayed: result.replayed },
        }).then(() => true).catch(() => false);
        const settingsResult = await loadOwnPublicPortfolioSettings(authz.session.user.id)
          .then((settings) => ({ settings, warning: null as string | null }))
          .catch(() => ({
            settings: null,
            warning: "The portfolio change completed, but refreshed private settings are temporarily unavailable.",
          }));
        const warnings = [
          ...(completionAuditRecorded ? [] : ["The portfolio change completed, but its completion audit needs reconciliation. Do not repeat the request."]),
          ...(settingsResult.warning ? [settingsResult.warning] : []),
        ];
        return NextResponse.json({
          result,
          settings: settingsResult.settings,
          completionAuditRecorded,
          ...(warnings.length ? { warning: warnings.join(" ") } : {}),
        }, { headers: noStore });
      } catch (error) {
        const code = error instanceof PublicPortfolioError ? error.code : "PORTFOLIO_UPDATE_FAILED";
        await writeAuditEvent({
          actorUserId: authz.session.user.id,
          subjectUserId: authz.session.user.id,
          action: "public_portfolio.update",
          resourceType: "public_portfolio",
          resourceId: authz.session.user.id,
          outcome: "failure",
          correlationId: parsed.data.requestId,
          metadata: { ...auditMetadata, errorCode: code },
        }).catch(() => undefined);
        return NextResponse.json({ error: code }, { status: status(code), headers: noStore });
      }
    },
  );
}
