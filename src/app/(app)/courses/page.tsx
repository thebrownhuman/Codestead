import { CourseCatalog } from "@/components/courses/course-catalog";
import { createContentRepository } from "@/lib/content";

export default async function CoursesPage() {
  const courses = await createContentRepository().listCourses({ status: ["beta", "verified"] });
  return <CourseCatalog courses={courses} />;
}
