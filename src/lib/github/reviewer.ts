import { z } from "zod";

import { redactSensitiveText } from "@/lib/security/sensitive-text";
import { dynamicExecutionLines } from "./execution-analysis";

const repoSchema = z.object({
  private: z.boolean(),
  default_branch: z.string().min(1),
});
const commitSchema = z.object({
  sha: z.string().regex(/^[a-f0-9]{40}$/i),
  commit: z.object({ tree: z.object({ sha: z.string().regex(/^[a-f0-9]{40}$/i) }) }),
});
const treeSchema = z.object({
  truncated: z.boolean(),
  tree: z.array(z.object({
    path: z.string(),
    type: z.string(),
    size: z.number().optional(),
    sha: z.string(),
  })),
});
const blobSchema = z.object({ content: z.string(), encoding: z.literal("base64"), size: z.number() });

export const PROJECT_REVIEW_DEADLINE_MS = 60_000;
const MAX_FILE_BYTES = 256 * 1024;
// GitHub wraps base64 with whitespace and JSON metadata; bound the wire body
// separately, then enforce the decoded source limit before text analysis.
const MAX_BLOB_RESPONSE_BYTES = MAX_FILE_BYTES * 2 + 8192;
const MAX_API_RESPONSE_BYTES = 1024 * 1024;
const MAX_TREE_RESPONSE_BYTES = 16 * 1024 * 1024;
class ResponseTooLarge extends Error {}
class ReviewTimeLimit extends Error {}

async function boundedJson(response: Response, maximum: number, signal: AbortSignal): Promise<unknown> {
  if (!response.body) throw new Error("Missing GitHub response body.");
  const reader = response.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    const declared = Number(response.headers.get("content-length"));
    if (declared > maximum) throw new ResponseTooLarge();
    const chunks: Uint8Array[] = [];
    let length = 0;
    while (true) {
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      const { done, value } = await reader.read();
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      if (done) break;
      length += value.byteLength;
      if (length > maximum) throw new ResponseTooLarge();
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks, length).toString("utf8")) as unknown;
  } finally {
    signal.removeEventListener("abort", cancel);
    cancel();
    reader.releaseLock();
  }
}

function samplePriority(pathname: string) {
  const path = pathname.toLowerCase();
  if (/^(readme)(\.[^/]+)?$/.test(path)) return 0;
  if (isTestPath(path)) return 1;
  if (/(^|\/)(main|index|app|server)\.[^/]+$/.test(path)) return 2;
  return 3;
}
function isTestPath(path: string) {
  return /(^|\/)(test|tests|__tests__)(\/|\.)/.test(path) || /\.test\.[a-z]+$/.test(path);
}

const sourceExtensions = new Set([
  ".c", ".h", ".cpp", ".cc", ".hpp", ".java", ".py", ".js", ".mjs", ".ts", ".tsx",
  ".jsx", ".cjs", ".mts", ".cts", ".html", ".css", ".json", ".md", ".sql", ".yml", ".yaml", ".toml",
]);
const ignoredSegments = new Set(["node_modules", "vendor", "dist", "build", ".next", "coverage", ".git"]);

export interface ReviewFinding {
  origin?: "deterministic_static";
  ruleId?: string;
  severity: "info" | "warning" | "important";
  category: ProjectReviewCategory | string;
  path?: string;
  line?: number;
  message: string;
  evidence: string;
}

export const PROJECT_REVIEW_ANALYZER_VERSION = "static-review-v4";
export const PROJECT_REVIEW_RUBRIC_VERSION = "static-project-review-rubric-v3";

export const PROJECT_REVIEW_RUBRIC = Object.freeze([
  { id: "likely-bug", label: "Likely bugs", maximum: 25 },
  { id: "security", label: "Security", maximum: 25 },
  { id: "testing", label: "Testing", maximum: 20 },
  { id: "documentation", label: "Documentation", maximum: 15 },
  { id: "maintainability", label: "Maintainability", maximum: 15 },
] as const);

export type ProjectReviewCategory = (typeof PROJECT_REVIEW_RUBRIC)[number]["id"];

export const PROJECT_REVIEW_LIMITATIONS = Object.freeze([
  "This is a bounded static syntax and text-pattern review, not proof that the project is correct or secure.",
  "The reviewer does not clone, install dependencies, build, execute code, run tests, or make network calls from repository code.",
  "Up to 120 supported text files and 5 MB total are inspected, prioritizing README, tests, and entry points; each file is limited to 256 KB.",
  "Scores and findings are deterministic signals for the pinned commit; no model opinion is included.",
] as const);

export interface ProjectReviewQualityAssessment {
  readonly schemaVersion: 1;
  readonly origin: "deterministic_static";
  readonly scoringMethod: "bounded_deductions_v1";
  readonly score: number;
  readonly categories: readonly {
    id: ProjectReviewCategory;
    label: string;
    score: number;
    maximum: number;
    findingCount: number;
  }[];
  readonly reviewedCommitSha: string;
  readonly filesReviewed: number;
  readonly findingsCapped: boolean;
  readonly limitations: readonly string[];
}

export interface DeterministicProjectReviewProvenance {
  readonly schemaVersion: 1;
  readonly analysisMode: "deterministic_static";
  readonly aiUsed: false;
  readonly promptVersion: null;
  readonly provider: null;
  readonly model: null;
  readonly modelCallId: null;
  readonly rubricVersion: typeof PROJECT_REVIEW_RUBRIC_VERSION;
  readonly repositoryExecution: "none";
  readonly runnerTemplateId: null;
  readonly deterministicFindingsOnly: true;
  readonly modelOpinionsIncluded: false;
  readonly qualityAssessment?: ProjectReviewQualityAssessment;
}

export interface ProjectReviewResult {
  readonly repositoryUrl: string;
  readonly defaultBranch: string;
  readonly commitSha: string;
  readonly filesReviewed: number;
  readonly findings: ReviewFinding[];
  readonly qualityAssessment?: ProjectReviewQualityAssessment;
  readonly limitations?: readonly string[];
  readonly analyzerVersion: string;
  readonly rubricVersion: string;
  readonly provenance: DeterministicProjectReviewProvenance;
}

export const DETERMINISTIC_PROJECT_REVIEW_PROVENANCE = Object.freeze({
  schemaVersion: 1,
  analysisMode: "deterministic_static",
  aiUsed: false,
  promptVersion: null,
  provider: null,
  model: null,
  modelCallId: null,
  rubricVersion: PROJECT_REVIEW_RUBRIC_VERSION,
  repositoryExecution: "none",
  runnerTemplateId: null,
  deterministicFindingsOnly: true,
  modelOpinionsIncluded: false,
} satisfies DeterministicProjectReviewProvenance);

const qualityAssessmentSchema = z.object({
  schemaVersion: z.literal(1),
  origin: z.literal("deterministic_static"),
  scoringMethod: z.literal("bounded_deductions_v1"),
  score: z.number().int().min(0).max(100),
  categories: z.array(z.object({
    id: z.enum(PROJECT_REVIEW_RUBRIC.map((category) => category.id)),
    label: z.string(),
    score: z.number().int().min(0).max(100),
    maximum: z.number().int().min(1).max(100),
    findingCount: z.number().int().min(0).max(250),
  })).length(PROJECT_REVIEW_RUBRIC.length),
  reviewedCommitSha: z.string().regex(/^[a-f0-9]{40}$/),
  filesReviewed: z.number().int().min(0).max(120),
  findingsCapped: z.boolean(),
  limitations: z.array(z.string()),
}).passthrough();

const severityPenalty = { info: 2, warning: 6, important: 12 } as const;

export function scoreDeterministicProjectReview(input: {
  findings: readonly ReviewFinding[];
  commitSha: string;
  filesReviewed: number;
  findingsCapped?: boolean;
  limitations?: readonly string[];
}): ProjectReviewQualityAssessment {
  if (!/^[a-f0-9]{40}$/i.test(input.commitSha)) throw new Error("A pinned 40-character commit is required for scoring.");
  if (!Number.isSafeInteger(input.filesReviewed) || input.filesReviewed < 0 || input.filesReviewed > 120) {
    throw new Error("Reviewed file count is outside the bounded reviewer limit.");
  }
  const categories = PROJECT_REVIEW_RUBRIC.map((rubric) => {
    const categoryFindings = input.findings.filter((finding) => finding.category === rubric.id);
    const deductions = categoryFindings.reduce(
      (total, finding) => total + severityPenalty[finding.severity],
      0,
    );
    return {
      id: rubric.id,
      label: rubric.label,
      score: Math.max(0, rubric.maximum - deductions),
      maximum: rubric.maximum,
      findingCount: categoryFindings.length,
    };
  });
  return {
    schemaVersion: 1,
    origin: "deterministic_static",
    scoringMethod: "bounded_deductions_v1",
    score: categories.reduce((total, category) => total + category.score, 0),
    categories,
    reviewedCommitSha: input.commitSha.toLowerCase(),
    filesReviewed: input.filesReviewed,
    findingsCapped: input.findingsCapped ?? false,
    limitations: input.limitations ?? PROJECT_REVIEW_LIMITATIONS,
  };
}

/** Projects untrusted persisted provenance into a fixed, accessible shape. */
export function projectReviewQualityAssessment(value: unknown): ProjectReviewQualityAssessment | null {
  const parsed = qualityAssessmentSchema.safeParse(
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>).qualityAssessment
      : null,
  );
  if (!parsed.success) return null;
  const byId = new Map(parsed.data.categories.map((category) => [category.id, category]));
  const categories = PROJECT_REVIEW_RUBRIC.map((rubric) => {
    const persisted = byId.get(rubric.id);
    if (!persisted || persisted.maximum !== rubric.maximum || persisted.score > rubric.maximum) return null;
    return {
      id: rubric.id,
      label: rubric.label,
      score: persisted.score,
      maximum: rubric.maximum,
      findingCount: persisted.findingCount,
    };
  });
  if (categories.some((category) => category === null)) return null;
  const safeCategories = categories as ProjectReviewQualityAssessment["categories"];
  const calculated = safeCategories.reduce((total, category) => total + category.score, 0);
  if (calculated !== parsed.data.score) return null;
  return {
    schemaVersion: 1,
    origin: "deterministic_static",
    scoringMethod: "bounded_deductions_v1",
    score: calculated,
    categories: safeCategories,
    reviewedCommitSha: parsed.data.reviewedCommitSha,
    filesReviewed: parsed.data.filesReviewed,
    findingsCapped: parsed.data.findingsCapped,
    limitations: parsed.data.limitations,
  };
}

export function parsePublicGitHubUrl(value: string) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "github.com") {
    throw new Error("Only https://github.com public repository URLs are accepted.");
  }
  const parts = url.pathname.replace(/\.git$/, "").split("/").filter(Boolean);
  if (parts.length !== 2 || !parts.every((part) => /^[A-Za-z0-9_.-]{1,100}$/.test(part))) {
    throw new Error("Provide a repository URL in the form https://github.com/owner/repository.");
  }
  return { owner: parts[0], repo: parts[1], canonicalUrl: `https://github.com/${parts[0]}/${parts[1]}` };
}

function extension(pathname: string) {
  const last = pathname.split("/").pop() ?? "";
  const index = last.lastIndexOf(".");
  return index >= 0 ? last.slice(index).toLowerCase() : "";
}

function shouldRead(pathname: string, size: number) {
  const segments = pathname.split("/");
  return (
    size > 0 &&
    size <= MAX_FILE_BYTES &&
    !segments.some((segment) => ignoredSegments.has(segment)) &&
    (sourceExtensions.has(extension(pathname)) || ["README", "LICENSE", "Makefile", "Dockerfile"].includes(segments.at(-1) ?? ""))
  );
}

function safeFindingPath(pathname: string) {
  return redactSensitiveText(pathname.replace(/[\r\n\t]/g, " "), 300).text;
}

function finding(
  input: Omit<ReviewFinding, "origin">,
): ReviewFinding {
  return { origin: "deterministic_static", ...input };
}

function analyzeFile(pathname: string, text: string): ReviewFinding[] {
  const findings: ReviewFinding[] = [];
  const lines = text.split(/\r?\n/);
  const safePath = safeFindingPath(pathname);
  const executionLines = new Set(dynamicExecutionLines(pathname, text));
  const secretPatterns = [
    /\b(?:nvapi-|sk-|gh[pousr]_)[A-Za-z0-9_-]{12,}/,
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
    /(?:api[_-]?key|secret|password)\s*[:=]\s*["'][^"']{8,}["']/i,
  ];
  lines.forEach((line, index) => {
    if (secretPatterns.some((pattern) => pattern.test(line))) {
      findings.push(finding({
        ruleId: "security.possible-secret",
        severity: "important",
        category: "security",
        path: safePath,
        line: index + 1,
        message: "A possible credential is committed. Revoke it, remove it from history, and use environment configuration.",
        evidence: "Pattern match only; the matched value is deliberately not stored.",
      }));
    }
    if (/\b(TODO|FIXME|HACK)\b/.test(line)) {
      findings.push(finding({ ruleId: "maintainability.unfinished-marker", severity: "info", category: "maintainability", path: safePath, line: index + 1, message: "Review this unfinished-work marker before calling the project complete.", evidence: "TODO/FIXME/HACK marker" }));
    }
    if (/except\s*:\s*(?:#.*)?$/.test(line) || /catch\s*\([^)]*\)\s*\{\s*\}/.test(line)) {
      findings.push(finding({ ruleId: "likely-bug.swallowed-error", severity: "warning", category: "likely-bug", path: safePath, line: index + 1, message: "A broad or empty exception handler can hide failures; handle the expected error and preserve context.", evidence: "Broad/empty handler structure" }));
    }
    if (executionLines.has(index + 1)) {
      findings.push(finding({ ruleId: "security.dynamic-code-evaluation", severity: "warning", category: "security", path: safePath, line: index + 1, message: "Dynamic code evaluation can turn untrusted text into executable code. Remove it or constrain input with a reviewed parser and strict allowlist.", evidence: "Dynamic evaluation call structure; arguments are deliberately not stored." }));
    }
  });
  if (lines.length > 600) {
    findings.push(finding({ ruleId: "maintainability.large-file", severity: "warning", category: "maintainability", path: safePath, message: "This source file is large enough to make responsibilities and tests harder to isolate.", evidence: `${lines.length} lines` }));
  }
  return findings;
}

async function reviewPublicRepositoryReference(
  repositoryUrl: string,
  commitReference: string | null,
  fetchImpl: typeof fetch = fetch,
): Promise<ProjectReviewResult> {
  const { owner, repo, canonicalUrl } = parsePublicGitHubUrl(repositoryUrl);
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "x-github-api-version": "2026-03-10",
    "user-agent": "Codestead-Static-Review",
  };
  const token = process.env.GITHUB_TOKEN?.trim();
  if (token) headers.authorization = `Bearer ${token}`;
  const deadline = Date.now() + PROJECT_REVIEW_DEADLINE_MS;
  const request = async (pathname: string, maximum = MAX_API_RESPONSE_BYTES) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new ReviewTimeLimit();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Math.min(15_000, remaining));
    const unavailable = () => {
      // Never propagate fetch/body exceptions or attach their cause: either may
      // contain request headers, including the optional GitHub credential.
      if (Date.now() >= deadline) return new ReviewTimeLimit();
      const error = new Error("GitHub is temporarily unavailable. Please try again later.");
      if (controller.signal.aborted) error.name = "AbortError";
      return error;
    };
    try {
      let response: Response;
      try {
        response = await fetchImpl(`https://api.github.com${pathname}`, {
          headers,
          signal: controller.signal,
          redirect: "error",
          cache: "no-store",
        });
      } catch {
        throw unavailable();
      }
      if (!response.ok) {
        let rateLimited = response.status === 429;
        if (response.status === 403) {
          rateLimited = response.headers.get("x-ratelimit-remaining") === "0"
            || response.headers.has("retry-after");
          if (!rateLimited) {
            // GitHub also reports secondary limits as 403 with a JSON message.
            // Inspect it only for classification; never expose or log the body.
            const body: unknown = await boundedJson(response, MAX_API_RESPONSE_BYTES, controller.signal).catch(() => null);
            if (controller.signal.aborted) throw unavailable();
            const message = body && typeof body === "object" && "message" in body ? body.message : null;
            rateLimited = typeof message === "string" && /rate limit|abuse detection/i.test(message);
          }
        }
        void response.body?.cancel().catch(() => undefined);
        if (rateLimited) throw new Error("GitHub review is temporarily rate limited. Please try again later.");
        if (response.status === 401) throw new Error("GitHub authentication failed. Ask an administrator to check the GitHub review token.");
        if (response.status === 403) throw new Error("GitHub denied access to this public repository. Ask an administrator to check the GitHub review configuration.");
        if (response.status === 404) throw new Error("GitHub repository or pinned commit was not found. Check that the repository is public and the requested commit still exists.");
        if (response.status >= 500) throw unavailable();
        throw new Error(`GitHub API returned ${response.status}.`);
      }
      try {
        return await boundedJson(response, maximum, controller.signal);
      } catch (error) {
        if (error instanceof ResponseTooLarge) throw error;
        throw unavailable();
      }
    } finally {
      clearTimeout(timeout);
    }
  };

  const metadata = repoSchema.parse(await request(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`));
  if (metadata.private) throw new Error("Private repositories require the future read-only GitHub App flow.");
  const requestedCommit = commitReference ?? metadata.default_branch;
  const commit = commitSchema.parse(
    await request(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${encodeURIComponent(requestedCommit)}`),
  );
  if (commitReference && commit.sha.toLowerCase() !== commitReference.toLowerCase()) {
    throw new Error("GitHub did not return the exact pinned commit requested for corrective review.");
  }
  const findings: ReviewFinding[] = [];
  const limitations: string[] = [...PROJECT_REVIEW_LIMITATIONS];
  let filesReviewed = 0;
  let tree: z.infer<typeof treeSchema> | null = null;
  try {
    tree = treeSchema.parse(
      await request(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees/${commit.commit.tree.sha}?recursive=1`, MAX_TREE_RESPONSE_BYTES),
    );
    if (tree.truncated) limitations.push("README/tests existence is unknown because the GitHub tree is truncated; no missing-file deductions are applied.");
    const eligible = tree.tree.filter((entry) => entry.type === "blob" && shouldRead(entry.path, entry.size ?? 0));
    const prioritized = eligible.sort((a, b) => samplePriority(a.path) - samplePriority(b.path));
    // Reserve a representative of each key-file category, even when tests
    // alone would fill all 120 slots; keep ordering stable within categories.
    const reserved = [0, 1, 2].flatMap((priority) => {
      const entry = prioritized.find((candidate) => samplePriority(candidate.path) === priority);
      return entry ? [entry] : [];
    });
    const reservedEntries = new Set(reserved);
    const blobs = [...reserved, ...prioritized.filter((entry) => !reservedEntries.has(entry))].slice(0, 120);
    if (blobs.reduce((sum, entry) => sum + (entry.size ?? 0), 0) > 5 * 1024 * 1024) {
      throw new Error("Selected source exceeds the 5 MB static-review limit.");
    }
    if (tree.tree.some((entry) => entry.type === "blob" && (entry.size ?? 0) > MAX_FILE_BYTES)) {
      limitations.push("Skipped files exceeding the 256 KB file limit in the tree listing.");
    }
    for (const entry of blobs) {
      let blob: z.infer<typeof blobSchema>;
      try {
        blob = blobSchema.parse(
          await request(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/blobs/${entry.sha}`, MAX_BLOB_RESPONSE_BYTES),
        );
      } catch (error) {
        if (!(error instanceof ResponseTooLarge)) throw error;
        limitations.push(`Skipped ${entry.path}: response exceeds the bounded envelope for a 256 KB file.`);
        continue;
      }
      const bytes = Buffer.from(blob.content.replace(/\s/g, ""), "base64");
      if (blob.size > MAX_FILE_BYTES || bytes.byteLength > MAX_FILE_BYTES) {
        limitations.push(`Skipped ${entry.path}: exceeds the 256 KB file limit.`);
        continue;
      }
      const text = bytes.toString("utf8");
      if (text.includes("\u0000")) continue;
      filesReviewed++;
      findings.push(...analyzeFile(entry.path, text));
    }
  } catch (error) {
    if (!(error instanceof ReviewTimeLimit)) throw error;
    limitations.push("incomplete: time limit (60 seconds); only completed files were analyzed.");
    if (!tree) limitations.push("README/tests existence is unknown because the full tree was not received; no missing-file deductions are applied.");
  }
  if (tree && !tree.truncated) {
    const paths = tree.tree.filter((entry) => entry.type === "blob").map((entry) => entry.path.toLowerCase());
    if (!paths.some((path) => path === "readme.md" || path === "readme")) {
      findings.push(finding({ ruleId: "documentation.missing-readme", severity: "warning", category: "documentation", message: "Add a README that explains the problem, setup, usage, tests, and known limitations.", evidence: "No root README in full repository tree" }));
    }
    if (!paths.some(isTestPath)) {
      findings.push(finding({ ruleId: "testing.missing-tests", severity: "warning", category: "testing", message: "No test files were found in the full repository tree. Add repeatable normal, boundary, and failure checks.", evidence: "No conventional test path in full repository tree" }));
    }
  }
  const boundedFindings = findings.slice(0, 250);
  const qualityAssessment = scoreDeterministicProjectReview({
    findings: boundedFindings,
    commitSha: commit.sha,
    filesReviewed,
    findingsCapped: findings.length > boundedFindings.length,
    limitations,
  });
  return {
    repositoryUrl: canonicalUrl,
    defaultBranch: metadata.default_branch,
    commitSha: commit.sha.toLowerCase(),
    filesReviewed,
    findings: boundedFindings,
    qualityAssessment,
    limitations,
    analyzerVersion: PROJECT_REVIEW_ANALYZER_VERSION,
    rubricVersion: PROJECT_REVIEW_RUBRIC_VERSION,
    provenance: {
      ...DETERMINISTIC_PROJECT_REVIEW_PROVENANCE,
      qualityAssessment,
    },
  };
}

export async function reviewPublicRepository(
  repositoryUrl: string,
  fetchImpl: typeof fetch = fetch,
) {
  return reviewPublicRepositoryReference(repositoryUrl, null, fetchImpl);
}

/**
 * Re-runs the static reviewer against the exact commit preserved by an
 * original review. This code only reads GitHub metadata/tree/blob endpoints;
 * it never clones, installs, builds, runs hooks, or submits repository code to
 * a runner. Any future executable analysis must be a separate approved runner
 * template and cannot be smuggled through this correction path.
 */
export async function reviewPublicRepositoryAtCommit(
  repositoryUrl: string,
  commitSha: string,
  fetchImpl: typeof fetch = fetch,
) {
  if (!/^[a-f0-9]{40}$/i.test(commitSha)) {
    throw new Error("Corrective review requires an exact 40-character Git commit SHA.");
  }
  return reviewPublicRepositoryReference(repositoryUrl, commitSha.toLowerCase(), fetchImpl);
}
