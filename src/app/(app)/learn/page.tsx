import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { AuthoritativeDashboard } from "@/components/dashboard/authoritative-dashboard";
import { LearnerDashboard } from "@/components/dashboard/learner-dashboard";
import { requireAuth } from "@/lib/http/authz";
import { ensureLearnerRoadmapInitialized, loadAuthoritativeDashboard } from "@/lib/dashboard/learner";
import { isApplicationAuthRequired } from "@/lib/security/runtime-policy";

export const metadata: Metadata = { title: "Learning home" };

export default async function LearnPage() {
  if (!isApplicationAuthRequired()) return <LearnerDashboard />;
  const authz = await requireAuth();
  if (!authz.session) redirect("/login");
  const initial = await loadAuthoritativeDashboard(authz.session.user.id, authz.session.user.name);
  const data = await ensureLearnerRoadmapInitialized(authz.session.user.id, authz.session.user.name, initial);
  return <AuthoritativeDashboard data={data} />;
}
