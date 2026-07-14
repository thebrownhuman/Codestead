import { redirect } from "next/navigation";

import { CareerGuidanceView } from "@/components/milestones/career-guidance-view";
import { listLearnerCareerRecommendations } from "@/lib/career/service";
import { requireAuth } from "@/lib/http/authz";
import { isApplicationAuthRequired } from "@/lib/security/runtime-policy";

export const dynamic = "force-dynamic";

export default async function CareerPage() {
  if (!isApplicationAuthRequired()) {
    return <CareerGuidanceView guidance={{ available: false, recommendations: [], basis: "Demo mode has no persisted learner evidence.", emptyMessage: "Sign in to view reviewed guidance based on your own evidence." }} />;
  }
  const authz = await requireAuth();
  if (!authz.session) redirect("/login?next=%2Fcareer");
  return <CareerGuidanceView guidance={await listLearnerCareerRecommendations(authz.session.user.id)} />;
}
