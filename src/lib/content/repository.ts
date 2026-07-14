import { ContentGraph } from "./graph";
import { validateAuthoredContentSet } from "./authored";
import { validateContentSet } from "./integrity";
import {
  compileAuthoredFallbackLessonBlueprint,
  type LessonBlueprintCompilerOptions,
} from "./lesson-blueprint";
import {
  FileSystemContentLoader,
  type FileSystemContentLoaderOptions,
} from "./loader";
import type {
  AssessmentBank,
  AuthoredContentSet,
  AuthoredLesson,
} from "./authored-types";
import type {
  AtomicSkill,
  AuthoredFallbackLessonBlueprint,
  CatalogTrack,
  ContentCatalog,
  ContentIndex,
  ContentListOptions,
  ContentSearchKind,
  ContentSearchOptions,
  ContentSearchResult,
  ContentSnapshot,
  CourseManifest,
  CourseModule,
  CourseStatus,
  RoadmapTrackManifest,
  SkillLocation,
} from "./types";

interface ContentRuntime {
  readonly snapshot: ContentSnapshot;
  readonly index: ContentIndex;
  readonly graph: ContentGraph;
  readonly authored: AuthoredContentSet;
}

export interface ContentRepositoryOptions extends FileSystemContentLoaderOptions {
  readonly loader?: FileSystemContentLoader;
}

interface SearchDocument {
  readonly ordinal: number;
  readonly kind: ContentSearchKind;
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly courseId: string;
  readonly moduleId?: string;
  readonly status: CourseStatus;
  readonly fields: Readonly<Record<string, string>>;
}

interface ScoredSearchResult {
  readonly result: ContentSearchResult;
  readonly ordinal: number;
}

const ALL_SEARCH_KINDS: readonly ContentSearchKind[] = ["course", "module", "skill"];

function statusMatches(
  actual: CourseStatus,
  expected?: CourseStatus | readonly CourseStatus[],
): boolean {
  if (!expected) return true;
  return typeof expected === "string" ? actual === expected : expected.includes(actual);
}

function normalizeSearchText(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("en-US").trim();
}

function searchTokens(query: string): readonly string[] {
  return [...new Set(normalizeSearchText(query).split(/[^\p{L}\p{N}+#.-]+/u).filter(Boolean))];
}

function scoreDocument(
  document: SearchDocument,
  normalizedQuery: string,
  tokens: readonly string[],
): ContentSearchResult | undefined {
  const normalizedFields = Object.entries(document.fields).map(([name, value]) => [
    name,
    normalizeSearchText(value),
  ] as const);
  const matchedFields = new Set<string>();
  let score = 0;

  for (const [field, value] of normalizedFields) {
    const weight =
      field === "title" ? 120 : field === "id" ? 100 : field === "outcomes" ? 55 : 45;
    if (value === normalizedQuery) {
      score += weight * 8;
      matchedFields.add(field);
      continue;
    }
    if (value.includes(normalizedQuery)) {
      score += weight * 3;
      matchedFields.add(field);
    }
    let tokenMatches = 0;
    for (const token of tokens) {
      if (value.includes(token)) tokenMatches += 1;
    }
    if (tokenMatches) {
      score += weight * tokenMatches;
      matchedFields.add(field);
    }
  }

  if (!score) return undefined;
  return {
    kind: document.kind,
    id: document.id,
    title: document.title,
    summary: document.summary,
    courseId: document.courseId,
    ...(document.moduleId ? { moduleId: document.moduleId } : {}),
    score,
    matchedFields: [...matchedFields],
  };
}

/**
 * Read-only facade over the authored curriculum filesystem. The repository owns
 * one validated in-memory snapshot until clearCache() is called.
 */
export class ContentRepository {
  readonly loader: FileSystemContentLoader;
  private runtimePromise?: Promise<ContentRuntime>;
  private searchDocuments?: readonly SearchDocument[];

  constructor(options: ContentRepositoryOptions = {}) {
    this.loader =
      options.loader ??
      new FileSystemContentLoader({ contentRoot: options.contentRoot, now: options.now });
  }

  clearCache(): void {
    this.loader.clearCache();
    this.runtimePromise = undefined;
    this.searchDocuments = undefined;
  }

  async getSnapshot(): Promise<ContentSnapshot> {
    return (await this.getRuntime()).snapshot;
  }

  async getIndex(): Promise<ContentIndex> {
    return (await this.getRuntime()).index;
  }

  async getGraph(): Promise<ContentGraph> {
    return (await this.getRuntime()).graph;
  }

  async getAuthoredContentSet(): Promise<AuthoredContentSet> {
    return (await this.getRuntime()).authored;
  }

  async getAuthoredLesson(skillId: string): Promise<AuthoredLesson | undefined> {
    return (await this.getRuntime()).authored.lessons.find((lesson) => lesson.skillId === skillId);
  }

  async listAssessmentBanks(options: {
    readonly skillId?: string;
    readonly moduleId?: string;
    readonly includeRetired?: boolean;
  } = {}): Promise<readonly AssessmentBank[]> {
    return (await this.getRuntime()).authored.assessmentBanks.filter((bank) =>
      (!options.skillId || bank.skillId === options.skillId) &&
      (!options.moduleId || bank.moduleId === options.moduleId) &&
      (options.includeRetired || bank.publication.stage !== "retired"),
    );
  }

  async getCatalog(): Promise<ContentCatalog> {
    return (await this.getRuntime()).snapshot.catalog;
  }

  async listTracks(options: ContentListOptions = {}): Promise<readonly CatalogTrack[]> {
    const { catalog } = (await this.getRuntime()).snapshot;
    return catalog.tracks.filter(
      (track) =>
        statusMatches(track.status, options.status) &&
        (!options.release || track.release === options.release) &&
        (!options.category || track.category === options.category),
    );
  }

  async getTrack(trackId: string): Promise<CatalogTrack | undefined> {
    const { catalog } = (await this.getRuntime()).snapshot;
    return catalog.tracks.find((track) => track.id === trackId);
  }

  async getRoadmapTrack(trackId: string): Promise<RoadmapTrackManifest | undefined> {
    return (await this.getRuntime()).snapshot.roadmapTracks.find((track) => track.id === trackId);
  }

  async listCourses(options: ContentListOptions = {}): Promise<readonly CourseManifest[]> {
    const runtime = await this.getRuntime();
    const allowedTrackIds = new Set(
      runtime.snapshot.catalog.tracks
        .filter(
          (track) =>
            statusMatches(track.status, options.status) &&
            (!options.release || track.release === options.release) &&
            (!options.category || track.category === options.category),
        )
        .map((track) => track.id),
    );
    return runtime.snapshot.courses.filter((course) => allowedTrackIds.has(course.id));
  }

  async getCourse(courseId: string): Promise<CourseManifest | undefined> {
    return (await this.getRuntime()).index.courseById.get(courseId);
  }

  async getModule(moduleId: string): Promise<CourseModule | undefined> {
    return (await this.getRuntime()).index.moduleById.get(moduleId);
  }

  async getSkill(skillId: string): Promise<AtomicSkill | undefined> {
    return (await this.getRuntime()).index.skillById.get(skillId);
  }

  async getSkillLocation(skillId: string): Promise<SkillLocation | undefined> {
    return (await this.getRuntime()).index.skillLocationById.get(skillId);
  }

  async compileLessonBlueprint(
    skillId: string,
    options: LessonBlueprintCompilerOptions = {},
  ): Promise<AuthoredFallbackLessonBlueprint> {
    return compileAuthoredFallbackLessonBlueprint(
      (await this.getRuntime()).index,
      skillId,
      options,
    );
  }

  async search(
    query: string,
    options: ContentSearchOptions = {},
  ): Promise<readonly ContentSearchResult[]> {
    const normalizedQuery = normalizeSearchText(query);
    const tokens = searchTokens(query);
    if (!normalizedQuery || !tokens.length || options.limit === 0) return [];

    const runtime = await this.getRuntime();
    const kinds = new Set(options.kinds ?? ALL_SEARCH_KINDS);
    const courseIds = options.courseIds ? new Set(options.courseIds) : undefined;
    const documents = this.searchDocuments ?? this.buildSearchDocuments(runtime);
    this.searchDocuments = documents;

    const scored: ScoredSearchResult[] = [];
    for (const document of documents) {
      if (!kinds.has(document.kind)) continue;
      if (courseIds && !courseIds.has(document.courseId)) continue;
      if (!statusMatches(document.status, options.status)) continue;
      const result = scoreDocument(document, normalizedQuery, tokens);
      if (result) scored.push({ result, ordinal: document.ordinal });
    }

    scored.sort(
      (left, right) =>
        right.result.score - left.result.score ||
        left.ordinal - right.ordinal ||
        left.result.id.localeCompare(right.result.id),
    );
    const limit = Math.max(0, Math.floor(options.limit ?? 25));
    return scored.slice(0, limit).map(({ result }) => result);
  }

  private getRuntime(): Promise<ContentRuntime> {
    if (!this.runtimePromise) {
      const promise = Promise.all([
        this.loader.loadSnapshot(),
        this.loader.loadAuthoredContentSet(),
      ]).then(([snapshot, authoredContent]) => {
        const index = validateContentSet(snapshot.catalog, snapshot.courses, {
          manifestPaths: snapshot.manifestPaths,
          roadmapManifests: snapshot.roadmapTracks,
          roadmapManifestPaths: snapshot.roadmapManifestPaths,
        });
        const authored = validateAuthoredContentSet(authoredContent, index);
        return { snapshot, index, graph: new ContentGraph(snapshot.catalog, index), authored };
      });
      this.runtimePromise = promise.catch((error) => {
        this.runtimePromise = undefined;
        this.searchDocuments = undefined;
        throw error;
      });
    }
    return this.runtimePromise;
  }

  private buildSearchDocuments(runtime: ContentRuntime): readonly SearchDocument[] {
    const documents: SearchDocument[] = [];
    let ordinal = 0;
    for (const course of runtime.snapshot.courses) {
      documents.push({
        ordinal: ordinal++,
        kind: "course",
        id: course.id,
        title: course.title,
        summary: course.summary,
        courseId: course.id,
        status: course.status,
        fields: {
          id: course.id,
          title: course.title,
          summary: course.summary,
          scope: [...course.scope.includes, ...course.exit_outcomes].join(" "),
        },
      });
      for (const courseModule of course.modules) {
        documents.push({
          ordinal: ordinal++,
          kind: "module",
          id: courseModule.id,
          title: courseModule.title,
          summary: courseModule.description,
          courseId: course.id,
          moduleId: courseModule.id,
          status: course.status,
          fields: {
            id: courseModule.id,
            title: courseModule.title,
            summary: courseModule.description,
          },
        });
        for (const skill of courseModule.skills) {
          documents.push({
            ordinal: ordinal++,
            kind: "skill",
            id: skill.id,
            title: skill.title,
            summary: skill.description,
            courseId: course.id,
            moduleId: courseModule.id,
            status: course.status,
            fields: {
              id: skill.id,
              title: skill.title,
              summary: skill.description,
              outcomes: skill.outcomes.join(" "),
            },
          });
        }
      }
    }
    return documents;
  }
}

let defaultRepository: ContentRepository | undefined;

/**
 * Returns the process-wide repository for the immutable deployed curriculum.
 *
 * Request handlers call this factory frequently. Constructing a repository per
 * request would reread and revalidate every authored lesson and assessment bank
 * because each instance owns its own cache. Callers that provide an explicit
 * content root or loader still receive an isolated repository, which keeps
 * authoring tools and tests independent from the production snapshot.
 */
export function createContentRepository(
  options?: ContentRepositoryOptions,
): ContentRepository {
  if (options !== undefined) return new ContentRepository(options);
  defaultRepository ??= new ContentRepository();
  return defaultRepository;
}
