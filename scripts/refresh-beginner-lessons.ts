import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { AuthoredLesson } from "../src/lib/content/authored-types";
import {
  applyBeginnerQualityTemplate,
  auditBeginnerLessonQuality,
  createBeginnerQualityContext,
} from "../src/lib/content/beginner-quality";
import type { CourseManifest } from "../src/lib/content/types";

const root = process.cwd();
const contentRoot = path.join(root, "content");
const lessonRoot = path.join(contentRoot, "authored", "lessons");

async function loadCourses() {
  const files = (await readdir(path.join(contentRoot, "courses")))
    .filter((file) => file.endsWith(".json"))
    .sort();
  const courses = await Promise.all(files.map(async (file) =>
    JSON.parse(await readFile(path.join(contentRoot, "courses", file), "utf8")) as CourseManifest,
  ));
  return new Map(courses.map((course) => [course.id, course]));
}

function assertDraftProvenance(lesson: AuthoredLesson) {
  if (
    lesson.publication.stage !== "draft" ||
    !lesson.publication.aiAssisted ||
    lesson.publication.author.kind !== "ai-assisted" ||
    lesson.publication.reviewer !== null
  ) {
    throw new Error(`Refusing to rewrite non-draft or reviewed lesson ${lesson.skillId}.`);
  }
}

async function main() {
  const apply = process.argv.includes("--apply");
  const courses = await loadCourses();
  const files = (await readdir(lessonRoot)).filter((file) => file.endsWith(".json")).sort();
  let changed = 0;

  for (const file of files) {
    const filePath = path.join(lessonRoot, file);
    const lesson = JSON.parse(await readFile(filePath, "utf8")) as AuthoredLesson;
    assertDraftProvenance(lesson);
    const course = courses.get(lesson.courseId);
    const courseModule = course?.modules.find((candidate) => candidate.id === lesson.moduleId);
    const skill = courseModule?.skills.find((candidate) => candidate.id === lesson.skillId);
    if (!course || !courseModule || !skill) throw new Error(`Missing manifest context for ${lesson.skillId}.`);
    const context = createBeginnerQualityContext(course, courseModule, skill);
    const refreshed = applyBeginnerQualityTemplate(lesson, context);

    if (
      JSON.stringify(refreshed.sources) !== JSON.stringify(lesson.sources) ||
      JSON.stringify(refreshed.scope.excludes) !== JSON.stringify(lesson.scope.excludes) ||
      refreshed.canonicalExplanation.summary !== lesson.canonicalExplanation.summary ||
      refreshed.publication.stage !== lesson.publication.stage ||
      refreshed.publication.aiAssisted !== lesson.publication.aiAssisted ||
      refreshed.publication.reviewer !== lesson.publication.reviewer
    ) {
      throw new Error(`Beginner refresh changed protected provenance or technical boundaries for ${lesson.skillId}.`);
    }
    const issues = auditBeginnerLessonQuality(refreshed, context);
    if (issues.length > 0) {
      throw new Error(`${lesson.skillId} still fails beginner quality: ${issues.map((issue) => issue.code).join(", ")}.`);
    }
    const serialized = `${JSON.stringify(refreshed, null, 2)}\n`;
    if (serialized !== `${JSON.stringify(lesson, null, 2)}\n`) {
      changed += 1;
      if (apply) await writeFile(filePath, serialized, "utf8");
    }
  }

  console.log(`${apply ? "Refreshed" : "Would refresh"} ${changed}/${files.length} AI-assisted draft lessons; protected sources, boundaries, stage, and reviewer state were unchanged.`);
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
