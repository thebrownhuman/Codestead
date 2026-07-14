import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { AdminFrame } from "@/components/admin/admin-frame";
import { requireAdmin } from "@/lib/http/authz";
import { isApplicationAuthRequired } from "@/lib/security/runtime-policy";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  robots: { index: false, follow: false, noarchive: true },
};

export default async function AdminLayout({ children }: { readonly children: React.ReactNode }) {
  if (!isApplicationAuthRequired()) {
    return <AdminFrame adminName="Demo administrator">{children}</AdminFrame>;
  }
  const authz = await requireAdmin();
  if (!authz.session) {
    redirect(authz.response.status === 401 ? "/login?next=%2Fadmin" : "/learn");
  }
  return <AdminFrame adminName={authz.session.user.name}>{children}</AdminFrame>;
}
