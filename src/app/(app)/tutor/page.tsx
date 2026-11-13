import { redirect } from "next/navigation";
import { TutorView, type TutorLessonContext } from "@/components/product/tutor-view";
import { createContentRepository } from "@/lib/content";
import { requireAuth } from "@/lib/http/authz";
import { learningService } from "@/lib/learning-service/runtime";
import { isApplicationAuthRequired } from "@/lib/security/runtime-policy";

async function currentLesson(userId: string): Promise<TutorLessonContext | null> {
  try {
    const next = await learningService.recommendNext(userId);
    if (!next.action?.skillId) return null;
    const location = await createContentRepository().getSkillLocation(next.action.skillId);
    if (!location) return null;
    return { courseId: location.course.id, skillId: location.skill.id, title: location.skill.title };
  } catch {
    // The mentor chat still works without lesson context.
    return null;
  }
}

export default async function TutorPage() {
  if (!isApplicationAuthRequired()) return <TutorView />;
  const authz = await requireAuth();
  if (!authz.session) redirect("/login");
  return <TutorView lesson={await currentLesson(authz.session.user.id)} />;
}
