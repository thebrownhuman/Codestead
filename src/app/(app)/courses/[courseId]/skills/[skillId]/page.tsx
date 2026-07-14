import { notFound, redirect } from "next/navigation";

import { DsaLanguageRequired, LessonWorkspace } from "@/components/lesson/lesson-workspace";
import {
  createContentRepository,
  toLearnerAssessmentBank,
  toLearnerLessonPayload,
} from "@/lib/content";
import { requireAuth } from "@/lib/http/authz";
import { dsaRunnerLanguage } from "@/lib/learning-service/planner";
import { learningService } from "@/lib/learning-service/runtime";
import type { DsaLanguage } from "@/lib/learning-service/types";
import { isApplicationAuthRequired } from "@/lib/security/runtime-policy";

export default async function SkillPage({ params }: { params: Promise<{ courseId: string; skillId: string }> }) {
  const { courseId, skillId } = await params;
  const repository = createContentRepository();
  const course = await repository.getCourse(courseId);
  const location = await repository.getSkillLocation(decodeURIComponent(skillId));
  if (!course || !location || location.course.id !== course.id) notFound();

  let selectedDsaLanguage: DsaLanguage | undefined;
  if (course.id === "dsa") {
    if (isApplicationAuthRequired()) {
      const authz = await requireAuth();
      if (!authz.session) redirect("/login");
      selectedDsaLanguage = await learningService.getDsaImplementationLanguage(authz.session.user.id) ?? undefined;
      if (!selectedDsaLanguage) return <DsaLanguageRequired />;
    } else {
      // The unauthenticated catalog preview is the only place with a fixed DSA language.
      selectedDsaLanguage = "C++";
    }
  }

  const blueprint = await repository.compileLessonBlueprint(location.skill.id, {
    selectedLanguage: selectedDsaLanguage,
  });
  const authoredEntry = await repository.getAuthoredLesson(location.skill.id);
  const authoredLesson = authoredEntry
    ? toLearnerLessonPayload(authoredEntry, { allowUnpublishedPreview: true })
    : undefined;
  const authoredBanks = await repository.listAssessmentBanks({ skillId: location.skill.id });
  const assessmentBank = authoredBanks[0]
    ? toLearnerAssessmentBank(authoredBanks[0], { allowUnpublishedPreview: true })
    : undefined;
  const allSkills = course.modules.flatMap((module) => module.skills);
  const index = allSkills.findIndex((skill) => skill.id === location.skill.id);
  const previous = allSkills[index - 1];
  const next = allSkills[index + 1];
  return <LessonWorkspace blueprint={blueprint} authoredLesson={authoredLesson} assessmentBank={assessmentBank} skill={location.skill} courseTitle={course.title} moduleTitle={location.module.title} dsaRunnerLanguage={selectedDsaLanguage ? dsaRunnerLanguage(selectedDsaLanguage) : undefined} previousHref={previous ? `/courses/${course.id}/skills/${encodeURIComponent(previous.id)}` : undefined} nextHref={next ? `/courses/${course.id}/skills/${encodeURIComponent(next.id)}` : undefined} />;
}
