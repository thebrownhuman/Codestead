import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import type { AuthoredLesson } from "../src/lib/content/authored-types";
import {
  auditBeginnerLessonQuality,
  createBeginnerQualityContext,
  type BeginnerQualityIssueCode,
} from "../src/lib/content/beginner-quality";
import type { CourseManifest } from "../src/lib/content/types";

const root = process.cwd();
const contentRoot = path.join(root, "content");

async function loadCourses() {
  const files = (await readdir(path.join(contentRoot, "courses")))
    .filter((file) => file.endsWith(".json"))
    .sort();
  const courses = await Promise.all(files.map(async (file) =>
    JSON.parse(await readFile(path.join(contentRoot, "courses", file), "utf8")) as CourseManifest,
  ));
  return new Map(courses.map((course) => [course.id, course]));
}

async function main() {
  const courses = await loadCourses();
  const files = (await readdir(path.join(contentRoot, "authored", "lessons")))
    .filter((file) => file.endsWith(".json"))
    .sort();
  const issueCounts = new Map<BeginnerQualityIssueCode, number>();
  const courseFailures = new Map<string, number>();
  const details: Array<{ skillId: string; courseId: string; issues: readonly string[] }> = [];
  let failingLessons = 0;

  for (const file of files) {
    const lesson = JSON.parse(
      await readFile(path.join(contentRoot, "authored", "lessons", file), "utf8"),
    ) as AuthoredLesson;
    const course = courses.get(lesson.courseId);
    const courseModule = course?.modules.find((candidate) => candidate.id === lesson.moduleId);
    const skill = courseModule?.skills.find((candidate) => candidate.id === lesson.skillId);
    if (!course || !courseModule || !skill) throw new Error(`Missing manifest context for ${lesson.skillId}.`);
    const issues = auditBeginnerLessonQuality(
      lesson,
      createBeginnerQualityContext(course, courseModule, skill),
    );
    if (issues.length > 0) {
      failingLessons += 1;
      courseFailures.set(lesson.courseId, (courseFailures.get(lesson.courseId) ?? 0) + 1);
      details.push({
        skillId: lesson.skillId,
        courseId: lesson.courseId,
        issues: issues.map((issue) => issue.code),
      });
    }
    for (const issue of issues) issueCounts.set(issue.code, (issueCounts.get(issue.code) ?? 0) + 1);
  }

  const result = {
    totalLessons: files.length,
    passingLessons: files.length - failingLessons,
    failingLessons,
    issueOccurrences: Object.fromEntries([...issueCounts].sort(([left], [right]) => left.localeCompare(right))),
    failingLessonsByCourse: Object.fromEntries([...courseFailures].sort(([left], [right]) => left.localeCompare(right))),
    ...(process.argv.includes("--details") ? { details } : {}),
  };
  if (process.argv.includes("--json")) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`Beginner-quality audit: ${result.passingLessons}/${result.totalLessons} lessons pass; ${result.failingLessons} fail.`);
    for (const [code, count] of Object.entries(result.issueOccurrences)) console.log(`- ${code}: ${count}`);
  }
  if (process.argv.includes("--fail-on-issues") && failingLessons > 0) process.exitCode = 1;
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
