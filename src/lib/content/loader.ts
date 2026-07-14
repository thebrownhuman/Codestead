import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { parseAssessmentBank, parseAuthoredLesson } from "./authored-schema";
import { validateContentSet } from "./integrity";
import { parseContentCatalog, parseCourseManifest, parseRoadmapTrackManifest } from "./schema";
import type { AssessmentBank, AuthoredContentSet, AuthoredLesson } from "./authored-types";
import type {
  ContentCatalog,
  ContentSnapshot,
  CourseManifest,
  RoadmapTrackManifest,
} from "./types";

export class ContentFileError extends Error {
  readonly filePath: string;

  constructor(filePath: string, message: string, cause?: unknown) {
    super(`${message}: ${filePath}`, { cause });
    this.name = "ContentFileError";
    this.filePath = filePath;
  }
}

export interface FileSystemContentLoaderOptions {
  readonly contentRoot?: string;
  readonly now?: () => number;
}

function defaultContentRoot(): string {
  // Content is copied beside the standalone server by the production image.
  return path.join(/* turbopackIgnore: true */ process.cwd(), "content");
}

function toCatalogPath(fileName: string): string {
  return `courses/${fileName.replaceAll("\\", "/")}`;
}

function toRoadmapPath(fileName: string): string {
  return `roadmap/${fileName.replaceAll("\\", "/")}`;
}

export class FileSystemContentLoader {
  readonly contentRoot: string;
  private readonly now: () => number;
  private catalogPromise?: Promise<ContentCatalog>;
  private readonly manifestPromises = new Map<string, Promise<CourseManifest>>();
  private readonly roadmapManifestPromises = new Map<string, Promise<RoadmapTrackManifest>>();
  private snapshotPromise?: Promise<ContentSnapshot>;
  private authoredContentPromise?: Promise<AuthoredContentSet>;

  constructor(options: FileSystemContentLoaderOptions = {}) {
    this.contentRoot = path.resolve(/* turbopackIgnore: true */ options.contentRoot ?? defaultContentRoot());
    this.now = options.now ?? Date.now;
  }

  clearCache(): void {
    this.catalogPromise = undefined;
    this.manifestPromises.clear();
    this.roadmapManifestPromises.clear();
    this.snapshotPromise = undefined;
    this.authoredContentPromise = undefined;
  }

  loadCatalog(): Promise<ContentCatalog> {
    if (!this.catalogPromise) {
      const promise = this.readJson("catalog.json").then((value) =>
        parseContentCatalog(value, "content/catalog.json"),
      );
      this.catalogPromise = promise.catch((error) => {
        this.catalogPromise = undefined;
        throw error;
      });
    }
    return this.catalogPromise;
  }

  loadCourseManifest(manifestPath: string): Promise<CourseManifest> {
    const normalized = manifestPath.replaceAll("\\", "/");
    const cached = this.manifestPromises.get(normalized);
    if (cached) return cached;

    const promise = this.readJson(normalized).then((value) =>
      parseCourseManifest(value, `content/${normalized}`),
    );
    const guarded = promise.catch((error) => {
      this.manifestPromises.delete(normalized);
      throw error;
    });
    this.manifestPromises.set(normalized, guarded);
    return guarded;
  }

  loadRoadmapTrackManifest(manifestPath: string): Promise<RoadmapTrackManifest> {
    const normalized = manifestPath.replaceAll("\\", "/");
    const cached = this.roadmapManifestPromises.get(normalized);
    if (cached) return cached;

    const promise = this.readJson(normalized).then((value) =>
      parseRoadmapTrackManifest(value, `content/${normalized}`),
    );
    const guarded = promise.catch((error) => {
      this.roadmapManifestPromises.delete(normalized);
      throw error;
    });
    this.roadmapManifestPromises.set(normalized, guarded);
    return guarded;
  }

  loadAuthoredLesson(lessonPath: string): Promise<AuthoredLesson> {
    const normalized = lessonPath.replaceAll("\\", "/");
    return this.readJson(normalized).then((value) =>
      parseAuthoredLesson(value, `content/${normalized}`),
    );
  }

  loadAssessmentBank(bankPath: string): Promise<AssessmentBank> {
    const normalized = bankPath.replaceAll("\\", "/");
    return this.readJson(normalized).then((value) =>
      parseAssessmentBank(value, `content/${normalized}`),
    );
  }

  loadAuthoredContentSet(): Promise<AuthoredContentSet> {
    if (!this.authoredContentPromise) {
      const promise = this.readAuthoredContentSet();
      this.authoredContentPromise = promise.catch((error) => {
        this.authoredContentPromise = undefined;
        throw error;
      });
    }
    return this.authoredContentPromise;
  }

  loadSnapshot(): Promise<ContentSnapshot> {
    if (!this.snapshotPromise) {
      const promise = this.readSnapshot();
      this.snapshotPromise = promise.catch((error) => {
        this.snapshotPromise = undefined;
        throw error;
      });
    }
    return this.snapshotPromise;
  }

  private resolveInsideContent(relativePath: string): string {
    if (path.isAbsolute(relativePath)) {
      throw new ContentFileError(relativePath, "Absolute content paths are not allowed");
    }
    const resolved = path.resolve(this.contentRoot, relativePath);
    const relative = path.relative(this.contentRoot, resolved);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new ContentFileError(relativePath, "Content path escapes the configured root");
    }
    return resolved;
  }

  private async readJson(relativePath: string): Promise<unknown> {
    const absolutePath = this.resolveInsideContent(relativePath);
    let text: string;
    try {
      text = await readFile(/* turbopackIgnore: true */ absolutePath, "utf8");
    } catch (error) {
      throw new ContentFileError(absolutePath, "Unable to read content file", error);
    }
    try {
      return JSON.parse(text) as unknown;
    } catch (error) {
      throw new ContentFileError(absolutePath, "Content file is not valid JSON", error);
    }
  }

  private async jsonFilesIn(relativeDirectory: string): Promise<readonly string[]> {
    const absoluteDirectory = this.resolveInsideContent(relativeDirectory);
    try {
      return (await readdir(/* turbopackIgnore: true */ absoluteDirectory))
        .filter((fileName) => fileName.endsWith(".json"))
        .sort()
        .map((fileName) => `${relativeDirectory}/${fileName}`);
    } catch (error) {
      throw new ContentFileError(
        absoluteDirectory,
        "Unable to enumerate authored content",
        error,
      );
    }
  }

  private async readAuthoredContentSet(): Promise<AuthoredContentSet> {
    const [lessonPaths, bankPaths] = await Promise.all([
      this.jsonFilesIn("authored/lessons"),
      this.jsonFilesIn("authored/assessment-banks"),
    ]);
    const [lessons, assessmentBanks] = await Promise.all([
      Promise.all(lessonPaths.map((lessonPath) => this.loadAuthoredLesson(lessonPath))),
      Promise.all(bankPaths.map((bankPath) => this.loadAssessmentBank(bankPath))),
    ]);
    return {
      lessons: Object.freeze(lessons),
      assessmentBanks: Object.freeze(assessmentBanks),
    };
  }

  private async readSnapshot(): Promise<ContentSnapshot> {
    const catalog = await this.loadCatalog();
    const manifestPaths: Record<string, string> = {};
    const roadmapManifestPaths: Record<string, string> = {};
    const courses = await Promise.all(
      catalog.tracks.filter((track) => track.manifest_kind === "course").map(async (track) => {
        manifestPaths[track.id] = track.manifest;
        const course = await this.loadCourseManifest(track.manifest);
        if (course.id !== track.id) {
          throw new ContentFileError(
            track.manifest,
            `Catalog track '${track.id}' loaded manifest id '${course.id}'`,
          );
        }
        return course;
      }),
    );
    const roadmapTracks = await Promise.all(
      catalog.tracks.filter((track) => track.manifest_kind === "roadmap").map(async (track) => {
        roadmapManifestPaths[track.id] = track.manifest;
        const roadmap = await this.loadRoadmapTrackManifest(track.manifest);
        if (roadmap.id !== track.id) {
          throw new ContentFileError(
            track.manifest,
            `Catalog roadmap track '${track.id}' loaded manifest id '${roadmap.id}'`,
          );
        }
        return roadmap;
      }),
    );

    let discoveredManifestPaths: string[];
    let discoveredRoadmapManifestPaths: string[];
    try {
      discoveredManifestPaths = (await readdir(/* turbopackIgnore: true */ this.resolveInsideContent("courses")))
        .filter((fileName) => fileName.endsWith(".json"))
        .map(toCatalogPath)
        .sort();
    } catch (error) {
      throw new ContentFileError(
        this.resolveInsideContent("courses"),
        "Unable to enumerate course manifests",
        error,
      );
    }

    try {
      discoveredRoadmapManifestPaths = (await readdir(/* turbopackIgnore: true */ this.resolveInsideContent("roadmap")))
        .filter((fileName) => fileName.endsWith(".json"))
        .map(toRoadmapPath)
        .sort();
    } catch (error) {
      throw new ContentFileError(
        this.resolveInsideContent("roadmap"),
        "Unable to enumerate roadmap manifests",
        error,
      );
    }

    validateContentSet(catalog, courses, {
      manifestPaths,
      discoveredManifestPaths,
      roadmapManifests: roadmapTracks,
      roadmapManifestPaths,
      discoveredRoadmapManifestPaths,
    });

    return Object.freeze({
      contentRoot: this.contentRoot,
      catalog,
      courses: Object.freeze([...courses]),
      manifestPaths: Object.freeze({ ...manifestPaths }),
      roadmapTracks: Object.freeze([...roadmapTracks]),
      roadmapManifestPaths: Object.freeze({ ...roadmapManifestPaths }),
      loadedAtMs: this.now(),
    });
  }
}
