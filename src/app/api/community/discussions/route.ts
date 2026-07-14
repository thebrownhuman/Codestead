import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import {
  addCommunityGroupMember,
  CommunityError,
  createCommunityGroup,
  createCommunityPost,
  createCommunityReply,
  deleteCommunityContent,
  editCommunityContent,
  listCommunity,
  reportCommunityContent,
} from "@/lib/community/service";
import { requireAuth } from "@/lib/http/authz";
import { writeAuditEvent } from "@/lib/security/audit-writer";
import { withRateLimit } from "@/lib/security/rate-limit";

const headers = { "Cache-Control": "private, no-store, max-age=0", "X-Robots-Tag": "noindex, nofollow" };
const bodySchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("create_group"), requestId: z.uuid(), name: z.string(), description: z.string(), visibility: z.enum(["cohort", "members"]) }).strict(),
  z.object({ action: z.literal("add_member"), requestId: z.uuid(), groupId: z.uuid(), learnerPublicId: z.uuid() }).strict(),
  z.object({ action: z.literal("create_post"), requestId: z.uuid(), groupId: z.uuid(), kind: z.enum(["discussion", "help", "project_share"]), title: z.string(), body: z.string() }).strict(),
  z.object({ action: z.literal("reply"), requestId: z.uuid(), postId: z.uuid(), body: z.string() }).strict(),
  z.object({ action: z.literal("edit"), target: z.enum(["post", "reply"]), targetId: z.uuid(), expectedVersion: z.number().int().min(1), title: z.string().optional(), body: z.string() }).strict(),
  z.object({ action: z.literal("delete"), target: z.enum(["post", "reply"]), targetId: z.uuid(), expectedVersion: z.number().int().min(1) }).strict(),
  z.object({ action: z.literal("report"), target: z.enum(["post", "reply"]), targetId: z.uuid(), reason: z.enum(["harassment", "unsafe_code", "spam", "privacy", "other"]), details: z.string().nullable().optional() }).strict(),
]);

function errorResponse(error: unknown) {
  const code = error instanceof CommunityError ? error.code : "COMMUNITY_UNAVAILABLE";
  const status = code === "NOT_FOUND" || code === "FORBIDDEN"
    ? 404
    : code === "VERSION_CONFLICT" || code === "DUPLICATE_REPORT" || code === "IDEMPOTENCY_CONFLICT"
      ? 409
      : code === "INVALID_INPUT"
        ? 400
        : 503;
  const message = status === 404
    ? "That community item is unavailable."
    : code === "IDEMPOTENCY_CONFLICT"
      ? "This retry identifier was already used for different community content."
    : status === 409
      ? "This item changed. Refresh before trying again."
      : status === 400
        ? "Check the visible fields and try again."
        : "Community is temporarily unavailable. Try again.";
  return NextResponse.json({ error: message, code }, { status, headers });
}

export async function GET(request: NextRequest) {
  const authz = await requireAuth();
  if (!authz.session) return authz.response;
  return withRateLimit(
    { policy: "community_read_user", identity: { kind: "user", value: authz.session.user.id } },
    async () => {
      const groupId = request.nextUrl.searchParams.get("groupId");
      const cursor = request.nextUrl.searchParams.get("cursor");
      const parsedLimit = Number(request.nextUrl.searchParams.get("limit") ?? 20);
      if ((groupId && !z.uuid().safeParse(groupId).success) || !Number.isSafeInteger(parsedLimit)) {
        return NextResponse.json({ error: "Invalid community page." }, { status: 400, headers });
      }
      try {
        return NextResponse.json(await listCommunity({
          actorUserId: authz.session.user.id,
          groupId,
          cursor,
          limit: parsedLimit,
        }), { headers });
      } catch (error) {
        return errorResponse(error);
      }
    },
  );
}

export async function POST(request: NextRequest) {
  const authz = await requireAuth();
  if (!authz.session) return authz.response;
  const body = bodySchema.safeParse(await request.json().catch(() => null));
  if (!body.success) return NextResponse.json({ error: "Choose a valid community action." }, { status: 400, headers });
  const policy = body.data.action === "report" ? "community_report_user" : "community_write_user";
  return withRateLimit(
    { policy, identity: { kind: "user", value: authz.session.user.id } },
    async () => {
      let result: unknown;
      try {
        switch (body.data.action) {
          case "create_group": result = await createCommunityGroup({ actorUserId: authz.session.user.id, ...body.data }); break;
          case "add_member": result = await addCommunityGroupMember({ actorUserId: authz.session.user.id, ...body.data }); break;
          case "create_post": result = await createCommunityPost({ actorUserId: authz.session.user.id, ...body.data }); break;
          case "reply": result = await createCommunityReply({ actorUserId: authz.session.user.id, ...body.data }); break;
          case "edit": result = await editCommunityContent({ actorUserId: authz.session.user.id, ...body.data }); break;
          case "delete": result = await deleteCommunityContent({ actorUserId: authz.session.user.id, ...body.data }); break;
          case "report": result = await reportCommunityContent({ actorUserId: authz.session.user.id, ...body.data }); break;
        }
      } catch (error) {
        return errorResponse(error);
      }
      const completionAuditRecorded = await writeAuditEvent({
        actorUserId: authz.session.user.id,
        subjectUserId: authz.session.user.id,
        action: `community.${body.data.action}`,
        resourceType: "community",
        outcome: "success",
        metadata: { target: "target" in body.data ? body.data.target : null },
      }).then(() => true).catch(() => false);
      return NextResponse.json({
        result,
        completionAuditRecorded,
        ...(completionAuditRecorded ? {} : {
          warning: "The community action completed, but its audit needs operator reconciliation. Do not repeat the request.",
        }),
      }, { status: body.data.action.startsWith("create_") ? 201 : 200, headers });
    },
  );
}
