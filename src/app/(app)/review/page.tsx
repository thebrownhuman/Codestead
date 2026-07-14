import { redirect } from "next/navigation";
import { ReviewQueue } from "@/components/product/review-queue";
import { loadAuthoritativeDashboard } from "@/lib/dashboard/learner";
import { requireAuth } from "@/lib/http/authz";
import { isApplicationAuthRequired } from "@/lib/security/runtime-policy";

export default async function ReviewPage() {
  if (!isApplicationAuthRequired()) return <ReviewQueue admin />;
  const authz = await requireAuth();
  if (!authz.session) redirect("/login");
  const dashboard = await loadAuthoritativeDashboard(authz.session.user.id, authz.session.user.name);
  return <ReviewQueue admin={authz.account.role === "admin"} dashboard={dashboard} />;
}
