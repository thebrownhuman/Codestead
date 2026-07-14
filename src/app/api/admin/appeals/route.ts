import { NextRequest } from "next/server";

import { adminJson, secureAdminResponse } from "@/app/api/admin/dashboard/http";
import { listAdminAppeals } from "@/lib/appeals/admin-service";
import { requireAdmin } from "@/lib/http/authz";

export async function GET(request: NextRequest) {
  const authz = await requireAdmin();
  if (!authz.session) return secureAdminResponse(authz.response);
  const scope = request.nextUrl.searchParams.get("scope") === "all" ? "all" : "actionable";
  return adminJson({ appeals: await listAdminAppeals({ scope }) });
}
