import { NextResponse } from "next/server";

import { listAdminCertificates } from "@/lib/certificates/service";
import { requireAdmin } from "@/lib/http/authz";

const noStore = {
  "Cache-Control": "private, no-store, max-age=0",
  "X-Robots-Tag": "noindex, nofollow",
};

export async function GET() {
  const authz = await requireAdmin();
  if (!authz.session) return authz.response;
  return NextResponse.json(
    { certificates: await listAdminCertificates() },
    { headers: noStore },
  );
}
