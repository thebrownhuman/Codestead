import { redirect } from "next/navigation";
import { RoadmapView } from "@/components/product/roadmap-view";
import { buildRoadmapCatalogViewStates, createContentRepository } from "@/lib/content";
import { loadAuthoritativeDashboard } from "@/lib/dashboard/learner";
import { requireAuth } from "@/lib/http/authz";
import { isApplicationAuthRequired } from "@/lib/security/runtime-policy";

export default async function RoadmapPage() {
  const repository = createContentRepository();
  const [snapshot, graph] = await Promise.all([repository.getSnapshot(), repository.getGraph()]);
  if (isApplicationAuthRequired()) {
    const authz = await requireAuth();
    if (!authz.session) redirect("/login");
    const dashboard = await loadAuthoritativeDashboard(authz.session.user.id, authz.session.user.name);
    const enrolled = await Promise.all(dashboard.courses.map((item) => repository.getCourse(item.id)));
    const completed = dashboard.courses.filter((course) => course.progress >= 100).map((course) => course.id);
    return (
      <RoadmapView
        courses={enrolled.filter((item) => item !== undefined)}
        dashboard={dashboard}
        futureCatalog={buildRoadmapCatalogViewStates(snapshot, graph, completed)}
      />
    );
  }
  const courses = await Promise.all(["programming-foundations", "python", "git-tooling", "dsa", "ai"].map((id) => repository.getCourse(id)));
  return (
    <RoadmapView
      courses={courses.filter((course) => course !== undefined)}
      futureCatalog={buildRoadmapCatalogViewStates(snapshot, graph, [])}
    />
  );
}
