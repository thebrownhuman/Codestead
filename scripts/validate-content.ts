import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import { createContentRepository } from "../src/lib/content/repository";
import type { AuthoredLesson } from "../src/lib/content/authored-types";
import {
  auditBeginnerLessonQuality,
  createBeginnerQualityContext,
} from "../src/lib/content/beginner-quality";
import type { CourseManifest } from "../src/lib/content/types";

type Manifest = CourseManifest;

type Catalog = {
  version: string;
  release: string;
  tracks: Array<{
    id: string;
    manifest: string;
    manifest_kind: "course" | "roadmap";
    status: Manifest["status"];
    release: string;
    prerequisites: string[];
  }>;
};

type RoadmapManifest = {
  id: string;
  status: "coming-soon";
  release: string;
  prerequisites: string[];
  publication: {
    learner_content_available: false;
    authored_lessons: 0;
    assessment_banks: 0;
    exam_eligible_items: 0;
    requires_separate_verified_release: true;
  };
};

const root = process.cwd();
const contentDir = path.join(root, "content");
const errors: string[] = [];

function report(message: string) {
  errors.push(message);
}

function findCycles(graph: Map<string, readonly string[]>) {
  const state = new Map<string, "visiting" | "visited">();
  const stack: string[] = [];

  const visit = (node: string) => {
    if (state.get(node) === "visited") return;
    if (state.get(node) === "visiting") {
      const start = stack.indexOf(node);
      report(`Prerequisite cycle: ${[...stack.slice(start), node].join(" -> ")}`);
      return;
    }
    state.set(node, "visiting");
    stack.push(node);
    for (const prerequisite of graph.get(node) ?? []) {
      if (graph.has(prerequisite)) visit(prerequisite);
    }
    stack.pop();
    state.set(node, "visited");
  };

  graph.forEach((_, node) => visit(node));
}

async function main() {
  const schema = JSON.parse(
    await readFile(path.join(contentDir, "schema", "course.schema.json"), "utf8"),
  ) as object;
  const catalog = JSON.parse(
    await readFile(path.join(contentDir, "catalog.json"), "utf8"),
  ) as Catalog;

  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  const validate = ajv.compile(schema);
  const authoredLessonSchema = JSON.parse(
    await readFile(path.join(contentDir, "schema", "authored-lesson.schema.json"), "utf8"),
  ) as object;
  const assessmentBankSchema = JSON.parse(
    await readFile(path.join(contentDir, "schema", "assessment-bank.schema.json"), "utf8"),
  ) as object;
  const validateAuthoredLesson = ajv.compile(authoredLessonSchema);
  const validateAssessmentBank = ajv.compile(assessmentBankSchema);
  const roadmapTrackSchema = JSON.parse(
    await readFile(path.join(contentDir, "schema", "roadmap-track.schema.json"), "utf8"),
  ) as object;
  const validateRoadmapTrack = ajv.compile(roadmapTrackSchema);

  const files = (await readdir(path.join(contentDir, "courses")))
    .filter((file) => file.endsWith(".json"))
    .sort();
  const manifests = new Map<string, Manifest>();
  const manifestFiles = new Map<string, string>();
  const roadmapManifests = new Map<string, RoadmapManifest>();
  const roadmapManifestFiles = new Map<string, string>();

  for (const file of files) {
    const relative = `courses/${file}`;
    const value: unknown = JSON.parse(
      await readFile(path.join(contentDir, "courses", file), "utf8"),
    );
    if (!validate(value)) {
      for (const issue of validate.errors ?? []) {
        report(`${relative}${issue.instancePath || "/"}: ${issue.message}`);
      }
      continue;
    }
    const manifest = value as Manifest;
    if (manifests.has(manifest.id)) report(`Duplicate course id: ${manifest.id}`);
    manifests.set(manifest.id, manifest);
    manifestFiles.set(manifest.id, relative);
  }

  const roadmapFiles = (await readdir(path.join(contentDir, "roadmap")))
    .filter((file) => file.endsWith(".json"))
    .sort();
  for (const file of roadmapFiles) {
    const relative = `roadmap/${file}`;
    const value: unknown = JSON.parse(
      await readFile(path.join(contentDir, "roadmap", file), "utf8"),
    );
    if (!validateRoadmapTrack(value)) {
      for (const issue of validateRoadmapTrack.errors ?? []) {
        report(`${relative}${issue.instancePath || "/"}: ${issue.message}`);
      }
      continue;
    }
    const roadmap = value as RoadmapManifest;
    if (roadmapManifests.has(roadmap.id)) report(`Duplicate roadmap id: ${roadmap.id}`);
    roadmapManifests.set(roadmap.id, roadmap);
    roadmapManifestFiles.set(roadmap.id, relative);
  }

  const catalogIds = new Set(catalog.tracks.map((track) => track.id));
  for (const track of catalog.tracks) {
    if (track.manifest_kind === "roadmap") {
      const roadmap = roadmapManifests.get(track.id);
      if (!roadmap) {
        report(`Catalog roadmap track ${track.id} has no valid roadmap manifest.`);
        continue;
      }
      if (roadmapManifestFiles.get(track.id) !== track.manifest) {
        report(`${track.id}: catalog roadmap path does not match the discovered file.`);
      }
      if (roadmap.status !== track.status || roadmap.release !== track.release) {
        report(`${track.id}: catalog status/release differs from the roadmap manifest.`);
      }
      if (roadmap.prerequisites.join("\u0000") !== track.prerequisites.join("\u0000")) {
        report(`${track.id}: catalog prerequisites differ from the roadmap manifest.`);
      }
      continue;
    }
    const manifest = manifests.get(track.id);
    if (!manifest) {
      report(`Catalog track ${track.id} has no valid manifest.`);
      continue;
    }
    if (manifestFiles.get(track.id) !== track.manifest) {
      report(`${track.id}: catalog manifest path does not match the discovered file.`);
    }
    if (manifest.status !== track.status) {
      report(`${track.id}: catalog status ${track.status} != manifest status ${manifest.status}.`);
    }
    if (manifest.release !== track.release) {
      report(`${track.id}: catalog and manifest release differ.`);
    }
    for (const expression of track.prerequisites) {
      const alternatives = expression.split("|");
      if (!alternatives.some((candidate) => catalogIds.has(candidate))) {
        report(`${track.id}: prerequisite expression '${expression}' names no catalog track.`);
      }
    }
  }

  for (const id of manifests.keys()) {
    const track = catalog.tracks.find((candidate) => candidate.id === id);
    if (!track || track.manifest_kind !== "course") {
      report(`Manifest ${id} is not declared as a course in catalog.json.`);
    }
  }
  for (const id of roadmapManifests.keys()) {
    const track = catalog.tracks.find((candidate) => candidate.id === id);
    if (!track || track.manifest_kind !== "roadmap") {
      report(`Roadmap manifest ${id} is not declared as a roadmap in catalog.json.`);
    }
  }

  const globalNodes = new Set<string>();
  for (const manifest of manifests.values()) {
    for (const courseModule of manifest.modules) {
      if (globalNodes.has(courseModule.id)) report(`Duplicate curriculum node id: ${courseModule.id}`);
      globalNodes.add(courseModule.id);
      for (const skill of courseModule.skills) {
        if (globalNodes.has(skill.id)) report(`Duplicate curriculum node id: ${skill.id}`);
        globalNodes.add(skill.id);
      }
    }
  }

  const graph = new Map<string, readonly string[]>();
  let skills = 0;
  for (const manifest of manifests.values()) {
    const sourceIds = new Set(manifest.authoritative_sources.map((source) => source.id));
    const courseSkills = manifest.modules.flatMap((module) => module.skills);
    skills += courseSkills.length;
    const counts = {
      required_skills: courseSkills.filter((skill) => skill.status === "required").length,
      elective_skills: courseSkills.filter((skill) => skill.status === "elective").length,
      total_skills: courseSkills.length,
      covered: courseSkills.filter((skill) => skill.coverage_status === "covered").length,
      partial: courseSkills.filter((skill) => skill.coverage_status === "partial").length,
      planned: courseSkills.filter((skill) => skill.coverage_status === "planned").length,
    };
    for (const [key, value] of Object.entries(counts)) {
      if (manifest.coverage_summary[key as keyof typeof counts] !== value) {
        report(`${manifest.id}: coverage_summary.${key} is stale (declared ${manifest.coverage_summary[key as keyof typeof counts]}, calculated ${value}).`);
      }
    }
    if (["beta", "verified"].includes(manifest.status) && (counts.partial || counts.planned)) {
      report(`${manifest.id}: ${manifest.status} courses cannot contain partial/planned skills.`);
    }

    for (const courseModule of manifest.modules) {
      graph.set(courseModule.id, courseModule.prerequisites);
      for (const prerequisite of courseModule.prerequisites) {
        if (!globalNodes.has(prerequisite)) {
          report(`${courseModule.id}: unknown prerequisite ${prerequisite}.`);
        }
      }
      for (const skill of courseModule.skills) {
        graph.set(skill.id, skill.prerequisites);
        for (const sourceRef of skill.source_refs) {
          if (!sourceIds.has(sourceRef)) report(`${skill.id}: unknown source ref ${sourceRef}.`);
        }
        for (const prerequisite of skill.prerequisites) {
          if (!globalNodes.has(prerequisite)) {
            report(`${skill.id}: unknown prerequisite ${prerequisite}.`);
          }
        }
      }
    }
  }

  findCycles(graph);

  for (const [directory, validator] of [
    ["authored/lessons", validateAuthoredLesson],
    ["authored/assessment-banks", validateAssessmentBank],
  ] as const) {
    const authoredFiles = (await readdir(path.join(contentDir, directory)))
      .filter((file) => file.endsWith(".json"))
      .sort();
    for (const file of authoredFiles) {
      const relative = `${directory}/${file}`;
      const value: unknown = JSON.parse(await readFile(path.join(contentDir, relative), "utf8"));
      const valid = validator(value);
      if (!valid) {
        for (const issue of validator.errors ?? []) {
          report(`${relative}${issue.instancePath || "/"}: ${issue.message}`);
        }
      } else if (directory === "authored/lessons") {
        const lesson = value as AuthoredLesson;
        const course = manifests.get(lesson.courseId);
        const courseModule = course?.modules.find((candidate) => candidate.id === lesson.moduleId);
        const skill = courseModule?.skills.find((candidate) => candidate.id === lesson.skillId);
        if (!course || !courseModule || !skill) {
          report(`${relative}: missing course/module/skill context for beginner-quality validation.`);
          continue;
        }
        const qualityIssues = auditBeginnerLessonQuality(
          lesson,
          createBeginnerQualityContext(course, courseModule, skill),
        );
        for (const issue of qualityIssues) {
          report(`${relative}: beginner-quality[${issue.code}] ${issue.message}`);
        }
      }
    }
  }

  let authoredCounts = { lessons: 0, banks: 0 };
  if (errors.length === 0) {
    try {
      const authored = await createContentRepository({ contentRoot: contentDir })
        .getAuthoredContentSet();
      authoredCounts = {
        lessons: authored.lessons.length,
        banks: authored.assessmentBanks.length,
      };
    } catch (error) {
      report(error instanceof Error ? error.message : "Unknown authored content integrity error.");
    }
  }

  if (errors.length) {
    console.error(`Curriculum validation failed with ${errors.length} issue(s):`);
    errors.forEach((error) => console.error(`- ${error}`));
    process.exitCode = 1;
    return;
  }

  console.log(
    `Curriculum valid: ${manifests.size} Launch 1 course tracks, ${roadmapManifests.size} metadata-only roadmap entries, ${skills} declared skills, ${authoredCounts.lessons} authored lessons, ${authoredCounts.banks} deterministic assessment banks; prerequisite DAG, schemas, mappings, and coverage summaries verified.`,
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
