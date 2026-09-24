import { CourseCatalog } from "@/components/courses/course-catalog";
import { createContentRepository } from "@/lib/content";
import { listPublishedCourseStages } from "@/lib/curriculum-publication/runtime";

export default async function CoursesPage() {
  const [courses, publishedStages] = await Promise.all([
    createContentRepository().listCourses({ status: ["beta", "verified"] }),
    listPublishedCourseStages().catch(() => new Map<string, "beta" | "verified">()),
  ]);
  return (
    <CourseCatalog
      courses={courses.map((course) => ({ ...course, status: publishedStages.get(course.id) ?? course.status }))}
    />
  );
}
