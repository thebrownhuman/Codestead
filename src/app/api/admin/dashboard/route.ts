import { getAdminDashboardData } from "./data";
import { adminJson, secureAdminResponse } from "./http";

import { requireAdmin } from "@/lib/http/authz";

export const dynamic = "force-dynamic";

export async function GET() {
  const authz = await requireAdmin();
  if (!authz.session) return secureAdminResponse(authz.response);

  try {
    return adminJson(await getAdminDashboardData());
  } catch (error) {
    console.error("Admin dashboard query failed", error);
    return adminJson({ error: "Operations data is temporarily unavailable." }, 503);
  }
}
