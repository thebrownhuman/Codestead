import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import { build } from "esbuild";
import { chromium, type Browser, type Page } from "playwright";

import {
  ContentRepository,
  type AssessmentBank,
  type CodeAssessmentItem,
} from "../src/lib/content";
import {
  WEB_BROWSER_TASKS,
  WEB_NEW_NODE_TASKS,
  WEB_NON_CODE_FACETS,
  WEB_RETAINED_NODE_SKILLS,
  type BrowserProjectArtifact,
  type BrowserVerificationCase,
  type WebCourseId,
} from "./content-seeds/web-executable-tranche";

interface RuntimeImageRecord {
  readonly language: string;
  readonly digest: string;
  readonly reference: string;
}

interface RuntimeImages {
  readonly records: readonly RuntimeImageRecord[];
}

interface RuntimeInspection {
  readonly images: readonly {
    readonly language: string;
    readonly tag: string;
    readonly imageId: string;
    readonly version: string;
    readonly harness: {
      readonly protocolVersion: number;
      readonly language: string;
      readonly compileThenRun: boolean;
      readonly shell: boolean;
    };
  }[];
}

interface ExecutionResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

interface CaseResult {
  readonly itemId: string;
  readonly skillId: string;
  readonly engine: "isolated-runner" | "browser-verifier";
  readonly language: string;
  readonly testId: string;
  readonly visibility: string;
  readonly category: string;
  readonly status: "passed" | "failed";
  readonly durationMs: number;
  readonly sourceHash: string;
  readonly consoleErrors?: readonly string[];
  readonly failure?: string;
}

interface BundledReactArtifact {
  readonly script: string;
  readonly css?: string;
}

const root = process.cwd();
const require = createRequire(import.meta.url);
const courseIds = new Set<WebCourseId>(["html", "css", "javascript", "react"]);
const nodeTag = "learncoding/runtime-javascript:local";
const expectedNodeVersion = "v22.23.1";
const expectedBrowser = {
  playwrightVersion: "1.61.1",
  revision: "1228",
  version: "149.0.7827.55",
  esbuildVersion: "0.25.12",
};
const retainedNode = new Set<string>(WEB_RETAINED_NODE_SKILLS);
const axeScriptPath = require.resolve("axe-core/axe.min.js");

function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

async function fileDigest(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return `sha256:${hash.digest("hex")}`;
}

async function packageMetadata(
  moduleSpecifier: string,
  expectedName: string,
): Promise<{ readonly name: string; readonly version: string; readonly engines?: { readonly node?: string } }> {
  let directory = path.dirname(require.resolve(moduleSpecifier));
  for (;;) {
    const manifestPath = path.join(directory, "package.json");
    try {
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
        name?: string;
        version?: string;
        engines?: { node?: string };
      };
      if (manifest.name === expectedName && manifest.version) {
        return { name: manifest.name, version: manifest.version, ...(manifest.engines ? { engines: manifest.engines } : {}) };
      }
    } catch {
      // Continue toward node_modules root until the owning package manifest is found.
    }
    const parent = path.dirname(directory);
    if (parent === directory) throw new Error(`Cannot locate package metadata for ${expectedName}.`);
    directory = parent;
  }
}

function dockerAvailable(): boolean {
  return spawnSync("docker", ["info"], { stdio: "ignore", windowsHide: true }).status === 0;
}

function dockerImageId(tag: string): string | null {
  const result = spawnSync(
    "docker",
    ["image", "inspect", tag, "--format", "{{.Id}}"],
    { encoding: "utf8", windowsHide: true },
  );
  return result.status === 0 ? result.stdout.trim() : null;
}

function compareOutput(item: CodeAssessmentItem, testIndex: number, actual: string): boolean {
  const test = item.tests[testIndex]!;
  if (test.comparison === "exact") return actual === test.expectedStdout;
  return actual.replaceAll("\r\n", "\n").trim() === test.expectedStdout.replaceAll("\r\n", "\n").trim();
}

function assertDraft(bank: AssessmentBank): void {
  if (bank.publication.stage !== "draft" || !bank.publication.aiAssisted || bank.publication.reviewer !== null) {
    throw new Error(`${bank.id} is not an AI-assisted, human-unreviewed draft.`);
  }
  if (bank.items.some((item) => item.examEligibility.eligible)) {
    throw new Error(`${bank.id} contains an exam-eligible draft item.`);
  }
}

function parseProjectArtifact(source: string): BrowserProjectArtifact | null {
  if (!source.trimStart().startsWith("{")) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || (parsed as { format?: unknown }).format !== "browser-project-v1") return null;
  return parsed as BrowserProjectArtifact;
}

function assertProjectArtifact(itemId: string, artifact: BrowserProjectArtifact): void {
  const paths = Object.keys(artifact.files);
  const required = [
    "index.html", "package.json", "tsconfig.json", "src/App.tsx", "src/data.ts",
    "src/main.tsx", "src/styles.css", "src/portfolio.test.tsx",
  ];
  for (const filePath of paths) {
    if (path.isAbsolute(filePath) || filePath.includes("\\") || path.posix.normalize(filePath) !== filePath || filePath.startsWith("../")) {
      throw new Error(`${itemId} has an unsafe virtual project path: ${filePath}.`);
    }
  }
  if (!required.every((filePath) => paths.includes(filePath))) {
    throw new Error(`${itemId} is missing a required multi-file project artifact.`);
  }
  if (!artifact.files[artifact.entrypoints.app] || !artifact.files[artifact.entrypoints.test]) {
    throw new Error(`${itemId} entrypoints do not resolve inside the virtual project.`);
  }
  const manifest = JSON.parse(artifact.files["package.json"]!) as {
    scripts?: Record<string, string>;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const expectedScripts = { dev: "vite", build: "vite build", preview: "vite preview", test: "vitest run" };
  const expectedDependencies = { react: "19.2.7", "react-dom": "19.2.7", "react-router": "8.0.1" };
  const expectedDevDependencies = { "@testing-library/react": "16.3.2", "@testing-library/user-event": "14.6.1", typescript: "5.9.3", vite: "8.1.4", vitest: "4.1.10" };
  if (!isDeepStrictEqual(manifest.scripts, expectedScripts) ||
      !isDeepStrictEqual(manifest.dependencies, expectedDependencies) ||
      !isDeepStrictEqual(manifest.devDependencies, expectedDevDependencies)) {
    throw new Error(`${itemId} virtual project manifest is not exactly dependency/script pinned.`);
  }
}

function assertSourcePolicy(item: CodeAssessmentItem): void {
  const source = item.answer.referenceSolution;
  const artifact = parseProjectArtifact(source);
  if (artifact) assertProjectArtifact(item.id, artifact);
  const inspectedSources = artifact ? Object.values(artifact.files) : [source];
  const commonForbidden = [
    /\beval\s*\(/,
    /new\s+Function\s*\(/,
    /document\.write\s*\(/,
    /\.innerHTML\s*=/,
    /\bchild_process\b/,
    /\bprocess\.env\b/,
  ];
  for (const inspected of inspectedSources) {
    for (const pattern of commonForbidden) {
      if (pattern.test(inspected)) throw new Error(`${item.id} violates authoring source policy: ${pattern.source}`);
    }
  }
  if (item.runtime.engine === "isolated-runner") {
    const imports = [...source.matchAll(/require\((['"])([^'"]+)\1\)/g)].map((match) => match[2]);
    if (imports.some((specifier) => specifier !== "node:fs")) {
      throw new Error(`${item.id} imports outside the permitted Node standard-input boundary.`);
    }
    if (/\b(?:fetch|WebSocket)\s*\(/.test(source) || /require\((['"])(?:node:)?(?:net|http|https|dgram)\1\)/.test(source)) {
      throw new Error(`${item.id} contains a network primitive.`);
    }
  }
  if (item.runtime.engine === "browser-verifier" && item.runtime.language === "react") {
    const imports = inspectedSources.flatMap((inspected) =>
      [...inspected.matchAll(/\b(?:from\s+|import\s+)(['"])([^'"]+)\1/g)].map((match) => match[2]!),
    );
    const allowedPackages = new Set([
      "react", "react-dom/client", "react-router", "@testing-library/react",
      "@testing-library/user-event",
    ]);
    if (imports.some((specifier) => !specifier.startsWith(".") && !allowedPackages.has(specifier))) {
      throw new Error(`${item.id} imports an unreviewed React package.`);
    }
  }
}

async function executeNode(item: CodeAssessmentItem, stdin: string): Promise<ExecutionResult> {
  if (item.runtime.engine !== "isolated-runner" || item.runtime.language !== "javascript") {
    throw new Error(`${item.id} is not a JavaScript isolated-runner item.`);
  }
  const directory = mkdtempSync(path.join(os.tmpdir(), "lc-web-node-"));
  const file = path.join(directory, item.runtime.entrypoint);
  writeFileSync(file, item.answer.referenceSolution, { encoding: "utf8", mode: 0o444 });
  try {
    chmodSync(directory, 0o755);
    chmodSync(file, 0o444);
  } catch {
    // Docker Desktop translates bind permissions on Windows.
  }
  const name = `lc-web-node-${process.pid}-${Math.random().toString(16).slice(2, 10)}`;
  const args = [
    "run", "--rm", "--interactive", "--name", name, "--pull", "never",
    "--network", "none", "--ipc", "none", "--log-driver", "none", "--read-only",
    "--init", "--stop-timeout", "1", "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges:true", "--pids-limit", "32",
    "--memory", `${item.runtime.memoryLimitMb}m`, "--memory-swap", `${item.runtime.memoryLimitMb}m`,
    "--cpus", "0.5", "--ulimit", "fsize=16777216:16777216", "--ulimit", "nofile=64:64",
    "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=16m,uid=65532,gid=65532,mode=0700",
    "--tmpfs", "/work:rw,exec,nosuid,nodev,size=16777216,uid=65532,gid=65532,mode=0700",
    "--user", "65532:65532", "--env", "HOME=/tmp", "--workdir", "/work",
    "--mount", `type=bind,src=${directory},dst=/input,readonly`,
    nodeTag, "/opt/runner/execute", "--mode", "run", "--language", "javascript",
    "--source-root", "/input", "--entrypoint", `/input/${item.runtime.entrypoint}`,
  ];
  return await new Promise((resolve, reject) => {
    const child = spawn("docker", args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
      spawnSync("docker", ["rm", "--force", name], { stdio: "ignore", windowsHide: true });
    }, Math.max(15_000, item.runtime.timeLimitMs * 5));
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rmSync(directory, { recursive: true, force: true });
      reject(error);
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      spawnSync("docker", ["rm", "--force", name], { stdio: "ignore", windowsHide: true });
      rmSync(directory, { recursive: true, force: true });
      resolve({
        code,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        timedOut,
      });
    });
    child.stdin.end(stdin);
  });
}

function parseBrowserCase(value: string, testId: string): BrowserVerificationCase {
  const parsed = JSON.parse(value) as BrowserVerificationCase;
  if (!parsed.viewport || !Number.isInteger(parsed.viewport.width) || !Number.isInteger(parsed.viewport.height)) {
    throw new Error(`${testId} has an invalid viewport.`);
  }
  if (!Array.isArray(parsed.assertions) || parsed.assertions.length === 0) {
    throw new Error(`${testId} has no browser assertions.`);
  }
  for (const check of parsed.assertions) {
    if (!check.description || !check.expression) throw new Error(`${testId} has an incomplete assertion.`);
  }
  return parsed;
}

async function bundleReact(
  source: string,
  cache: Map<string, BundledReactArtifact>,
  entrypoint: "app" | "test",
): Promise<BundledReactArtifact> {
  const key = digest(`${entrypoint}\0${source}`);
  const cached = cache.get(key);
  if (cached) return cached;
  const artifact = parseProjectArtifact(source);
  let directory: string | undefined;
  try {
    if (artifact) {
      directory = mkdtempSync(path.join(os.tmpdir(), "lc-web-project-"));
      for (const [filePath, contents] of Object.entries(artifact.files)) {
        const absolute = path.join(directory, ...filePath.split("/"));
        mkdirSync(path.dirname(absolute), { recursive: true });
        writeFileSync(absolute, contents, "utf8");
      }
    }
    const result = await build({
      absWorkingDir: artifact ? directory! : root,
      ...(artifact
        ? { entryPoints: [path.join(directory!, ...artifact.entrypoints[entrypoint].split("/"))], nodePaths: [path.join(root, "node_modules")] }
        : { stdin: { contents: source, loader: "tsx" as const, resolveDir: root, sourcefile: "App.tsx" } }),
      bundle: true,
      platform: "browser",
      format: "iife",
      target: ["chrome149"],
      jsx: "automatic",
      outdir: "out",
      write: false,
      logLevel: "silent",
    });
    const script = result.outputFiles.find((file) => file.path.endsWith(".js"))?.text;
    const css = result.outputFiles.find((file) => file.path.endsWith(".css"))?.text;
    if (!script) throw new Error("React authoring bundle produced no JavaScript output.");
    const bundled = { script, ...(css ? { css } : {}) };
    cache.set(key, bundled);
    return bundled;
  } finally {
    if (directory) rmSync(directory, { recursive: true, force: true });
  }
}

async function applyActions(page: Page, testCase: BrowserVerificationCase): Promise<void> {
  for (const action of testCase.actions ?? []) {
    if (action.type === "click") {
      if (!action.selector) throw new Error("Click action lacks selector.");
      await page.locator(action.selector).click();
    } else if (action.type === "fill") {
      if (!action.selector || action.value === undefined) throw new Error("Fill action lacks selector or value.");
      await page.locator(action.selector).fill(action.value);
    } else if (action.type === "press") {
      if (!action.key) throw new Error("Press action lacks key.");
      if (action.selector) await page.locator(action.selector).press(action.key);
      else await page.keyboard.press(action.key);
    } else if (action.type === "wait") {
      await page.waitForTimeout(action.milliseconds ?? 0);
    } else if (action.type === "evaluate") {
      if (!action.expression) throw new Error("Evaluate action lacks expression.");
      await page.evaluate((expression) => new Function(`return (${expression});`)(), action.expression);
    }
  }
}

async function executeBrowser(args: {
  readonly browser: Browser;
  readonly item: CodeAssessmentItem;
  readonly testCase: BrowserVerificationCase;
  readonly reactBundles: Map<string, BundledReactArtifact>;
}): Promise<{ readonly stdout: string; readonly consoleErrors: readonly string[] }> {
  const { browser, item, testCase, reactBundles } = args;
  if (item.runtime.engine !== "browser-verifier") throw new Error(`${item.id} is not a browser item.`);
  const context = await browser.newContext({
    viewport: testCase.viewport,
    reducedMotion: testCase.reducedMotion,
    colorScheme: testCase.colorScheme,
    serviceWorkers: "block",
  });
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const routes = new Map((testCase.routes ?? []).map((route) => [route.url, route]));
  await context.route("**/*", async (route) => {
    const requestUrl = route.request().url();
    const fixture = routes.get(requestUrl);
    if (fixture) {
      if (fixture.delayMs) await new Promise((resolve) => setTimeout(resolve, fixture.delayMs));
      await route.fulfill({
        status: fixture.status,
        contentType: fixture.contentType,
        body: fixture.body,
        headers: { "access-control-allow-origin": "https://learncoding.test" },
      });
      return;
    }
    if (route.request().isNavigationRequest()) {
      await route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>Verifier</title>" });
      return;
    }
    await route.abort("blockedbyclient");
  });
  const page = await context.newPage();
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  try {
    await page.goto(testCase.url ?? "https://learncoding.test/", { waitUntil: "domcontentloaded" });
    const suppliedDocument = testCase.document ?? "<div id=\"root\"></div>";
    const documentMarkup = /<html[\s>]/i.test(suppliedDocument)
      ? suppliedDocument
      : `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Browser task</title></head><body>${suppliedDocument}</body></html>`;
    if (item.runtime.language === "html") {
      await page.setContent(item.answer.referenceSolution, { waitUntil: "domcontentloaded" });
    } else if (item.runtime.language === "css") {
      await page.setContent(documentMarkup, { waitUntil: "domcontentloaded" });
      await page.addStyleTag({ content: item.answer.referenceSolution });
    } else if (item.runtime.language === "javascript") {
      await page.setContent(documentMarkup, { waitUntil: "domcontentloaded" });
      const useModuleSemantics = item.skillId === "javascript.runtime.modules" || item.skillId === "javascript.modules.import-export";
      await page.addScriptTag({ content: item.answer.referenceSolution, ...(useModuleSemantics ? { type: "module" } : {}) });
    } else if (item.runtime.language === "react") {
      await page.setContent(documentMarkup, { waitUntil: "domcontentloaded" });
      const bundle = await bundleReact(item.answer.referenceSolution, reactBundles, testCase.entrypoint ?? "app");
      if (bundle.css) await page.addStyleTag({ content: bundle.css });
      await page.addScriptTag({ content: bundle.script });
    }
    await page.waitForTimeout(1);
    await applyActions(page, testCase);
    for (const check of testCase.assertions) {
      const actual = await page.evaluate(
        (expression) => new Function(`return (${expression});`)(),
        check.expression,
      );
      if (!isDeepStrictEqual(actual, check.expected)) {
        throw new Error(`${check.description}: expected ${JSON.stringify(check.expected)}, received ${JSON.stringify(actual)}`);
      }
    }
    if (testCase.axe) {
      await page.addScriptTag({ path: axeScriptPath });
      const violations = await page.evaluate(async () => {
        const axe = (globalThis as typeof globalThis & {
          axe: { run: (root: Document) => Promise<{ violations: Array<{ id: string; impact: string | null; nodes: unknown[] }> }> };
        }).axe;
        const result = await axe.run(document);
        return result.violations.filter((violation) => violation.impact === "serious" || violation.impact === "critical")
          .map((violation) => ({ id: violation.id, impact: violation.impact, nodes: violation.nodes.length }));
      });
      if (violations.length) throw new Error(`axe serious/critical violations: ${JSON.stringify(violations)}`);
    }
    if (pageErrors.length) throw new Error(`unhandled page errors: ${pageErrors.join(" | ")}`);
    const allowed = [
      "net::ERR_BLOCKED_BY_CLIENT.Inspector",
      ...(testCase.routes ?? []).filter((route) => route.status >= 400).map((route) => `status of ${route.status}`),
      ...(testCase.allowedConsoleErrors ?? []),
    ];
    const unexpectedConsole = consoleErrors.filter((message) => !allowed.some((fragment) => message.includes(fragment)));
    if (unexpectedConsole.length) throw new Error(`unexpected console errors: ${unexpectedConsole.join(" | ")}`);
    return { stdout: "pass\n", consoleErrors };
  } finally {
    await context.close();
  }
}

async function runJobs<T>(jobs: readonly T[], workerCount: number, job: (value: T) => Promise<void>): Promise<void> {
  let next = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const index = next++;
      if (index >= jobs.length) return;
      await job(jobs[index]!);
    }
  }
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
}

async function main(): Promise<void> {
  const structureOnly = process.argv.includes("--structure-only");
  const repository = new ContentRepository({ contentRoot: path.join(root, "content") });
  const [
    courses, authored, runtimeImages, runtimeInspection, playwrightPackage, esbuildPackage,
    reactRouterPackage, testingReactPackage, userEventPackage,
  ] = await Promise.all([
    Promise.all([...courseIds].map((courseId) => repository.getCourse(courseId))),
    repository.getAuthoredContentSet(),
    structureOnly
      ? Promise.resolve<RuntimeImages | null>(null)
      : readFile(path.join(root, "services", "runner", "dist", "runtime-images.json"), "utf8").then((value) => JSON.parse(value) as RuntimeImages),
    structureOnly
      ? Promise.resolve<RuntimeInspection | null>(null)
      : readFile(path.join(root, "services", "runner", "dist", "runtime-inspection.json"), "utf8").then((value) => JSON.parse(value) as RuntimeInspection),
    readFile(require.resolve("playwright/package.json"), "utf8").then((value) => JSON.parse(value) as { version: string }),
    readFile(require.resolve("esbuild/package.json"), "utf8").then((value) => JSON.parse(value) as { version: string }),
    packageMetadata("react-router", "react-router"),
    packageMetadata("@testing-library/react", "@testing-library/react"),
    packageMetadata("@testing-library/user-event", "@testing-library/user-event"),
  ]);
  if (courses.some((course) => !course)) throw new Error("A Launch-1 web course is missing.");
  const declared = courses.flatMap((course) => course!.modules.flatMap((courseModule) =>
    courseModule.skills.map((skill) => ({ courseId: course!.id as WebCourseId, skill })),
  ));
  const banks = authored.assessmentBanks.filter((bank) => courseIds.has(bank.courseId as WebCourseId));
  const bankBySkill = new Map(banks.map((bank) => [bank.skillId, bank]));
  const declaredNodeDigests = new Set(banks.flatMap((bank) => bank.items)
    .filter((item): item is CodeAssessmentItem => item.kind === "code" && item.runtime.engine === "isolated-runner")
    .map((item) => item.runtime.imageDigest)
    .filter((value): value is string => value !== undefined));
  if (declaredNodeDigests.size !== 1) throw new Error(`Web Node items must share one immutable digest; found ${declaredNodeDigests.size}.`);
  const authoredJavascriptDigest = [...declaredNodeDigests][0]!;
  const builtJavascriptDigest = runtimeImages?.records.find((record) => record.language === "javascript")?.digest;
  const javascriptDigest = builtJavascriptDigest ?? authoredJavascriptDigest;
  if (builtJavascriptDigest && builtJavascriptDigest !== authoredJavascriptDigest) {
    throw new Error("Authored JavaScript digest differs from the locally built runner manifest.");
  }
  const javascriptInspection = runtimeInspection?.images.find((record) => record.language === "javascript") ?? null;
  if (!structureOnly && !javascriptInspection) throw new Error("Pinned JavaScript runtime inspection evidence is missing.");

  const codeItems: CodeAssessmentItem[] = [];
  const skillCoverage: Array<Record<string, unknown>> = [];
  for (const { courseId, skill } of declared) {
    const bank = bankBySkill.get(skill.id);
    if (!bank) throw new Error(`Missing authored bank for ${skill.id}.`);
    assertDraft(bank);
    const items = bank.items.filter((item): item is CodeAssessmentItem => item.kind === "code");
    const nonCodeReason = WEB_NON_CODE_FACETS[skill.id as keyof typeof WEB_NON_CODE_FACETS];
    if (nonCodeReason) {
      if (items.length !== 0) throw new Error(`${skill.id} has code despite non-code classification.`);
      skillCoverage.push({
        skillId: skill.id,
        courseId,
        classification: "non-code",
        rationale: nonCodeReason,
        requiredEvidence: nonCodeReason.includes("router")
          ? "pinned router plus multi-entry integration harness and human review"
          : nonCodeReason.includes("DevTools") || nonCodeReason.includes("profiler")
            ? "recorded human diagnostic evidence"
            : "multi-file artifact and/or human accessibility/design review",
      });
      continue;
    }
    if (items.length !== 1) throw new Error(`${skill.id} must have exactly one verified-facet code item.`);
    const item = items[0]!;
    assertSourcePolicy(item);
    if (!item.tests.some((test) => test.visibility === "visible") || !item.tests.some((test) => test.visibility === "hidden")) {
      throw new Error(`${item.id} lacks visible/hidden coverage.`);
    }
    if (item.tests.some((test) => !test.critical)) throw new Error(`${item.id} contains a noncritical executable case.`);
    if (item.runtime.engine === "isolated-runner") {
      if (courseId !== "javascript" || item.runtime.language !== "javascript") throw new Error(`${item.id} has invalid Node course/language metadata.`);
      if (item.runtime.version !== "Node.js 22.23.1 (ECMAScript 2025)" || item.runtime.imageDigest !== javascriptDigest) {
        throw new Error(`${item.id} does not match the pinned Node runtime.`);
      }
    } else {
      if (item.runtime.language !== courseId) throw new Error(`${item.id} browser language/course mismatch.`);
      if (item.runtime.browser.playwrightVersion !== expectedBrowser.playwrightVersion ||
          item.runtime.browser.revision !== expectedBrowser.revision ||
          item.runtime.browser.version !== expectedBrowser.version) {
        throw new Error(`${item.id} browser metadata is not pinned to the declared authoring environment.`);
      }
      if (courseId === "react" && item.runtime.bundler?.version !== expectedBrowser.esbuildVersion) {
        throw new Error(`${item.id} React bundler metadata is not pinned.`);
      }
      for (const test of item.tests) parseBrowserCase(test.stdin, test.id);
    }
    codeItems.push(item);
    const seed = item.runtime.engine === "browser-verifier"
      ? WEB_BROWSER_TASKS[skill.id as keyof typeof WEB_BROWSER_TASKS]
      : WEB_NEW_NODE_TASKS[skill.id as keyof typeof WEB_NEW_NODE_TASKS];
    skillCoverage.push({
      skillId: skill.id,
      courseId,
      classification: item.runtime.engine === "browser-verifier" ? "browser-static-a11y" : "executable",
      itemId: item.id,
      retainedOriginalNodeTask: retainedNode.has(skill.id),
      facet: seed?.facet ?? "retained bounded JavaScript runner facet",
      engine: item.runtime.engine,
      visibleCases: item.tests.filter((test) => test.visibility === "visible").length,
      hiddenCases: item.tests.filter((test) => test.visibility === "hidden").length,
      sourceHash: digest(item.answer.referenceSolution),
    });
  }
  if (banks.length !== declared.length || skillCoverage.length !== declared.length) {
    throw new Error(`Web coverage is incomplete: banks=${banks.length}, skills=${declared.length}, coverage=${skillCoverage.length}.`);
  }
  const expectedClassified = Object.keys(WEB_BROWSER_TASKS).length + Object.keys(WEB_NEW_NODE_TASKS).length +
    WEB_RETAINED_NODE_SKILLS.length + Object.keys(WEB_NON_CODE_FACETS).length;
  if (expectedClassified !== declared.length) throw new Error("Web source classification is not closed.");
  if (playwrightPackage.version !== expectedBrowser.playwrightVersion || esbuildPackage.version !== expectedBrowser.esbuildVersion) {
    throw new Error(`Locked authoring packages mismatch: playwright=${playwrightPackage.version}, esbuild=${esbuildPackage.version}.`);
  }
  if (reactRouterPackage.version !== "8.0.1" || reactRouterPackage.engines?.node !== ">=22.22.0" ||
      testingReactPackage.version !== "16.3.2" || userEventPackage.version !== "14.6.1") {
    throw new Error(
      `Locked React project packages mismatch: router=${reactRouterPackage.version}, testing=${testingReactPackage.version}, userEvent=${userEventPackage.version}.`,
    );
  }

  const executablePath = chromium.executablePath();
  const revision = /chromium-(\d+)/.exec(executablePath)?.[1] ?? null;
  if (revision !== expectedBrowser.revision) throw new Error(`Chromium revision mismatch: ${revision}.`);
  const packageLockHash = await fileDigest(path.join(root, "package-lock.json"));
  const browserExecutableHash = structureOnly ? null : await fileDigest(executablePath);
  const dockerReady = structureOnly ? false : dockerAvailable();
  const actualNodeImageId = dockerReady ? dockerImageId(nodeTag) : null;
  const nodeImageMatches = structureOnly ? null : actualNodeImageId === javascriptDigest;
  const nodeVersionMatches = structureOnly ? null : javascriptInspection?.version === expectedNodeVersion;
  if (!structureOnly && (!dockerReady || !nodeImageMatches || !nodeVersionMatches)) {
    throw new Error(`Pinned Node runtime unavailable or mismatched: docker=${dockerReady}, image=${actualNodeImageId}, expected=${javascriptDigest}, version=${javascriptInspection?.version ?? "missing"}.`);
  }

  let browser: Browser | undefined;
  let actualBrowserVersion: string | null = null;
  const results: CaseResult[] = [];
  if (!structureOnly) {
    browser = await chromium.launch({ headless: true });
    actualBrowserVersion = await browser.version();
    if (actualBrowserVersion !== expectedBrowser.version) {
      await browser.close();
      throw new Error(`Chromium version mismatch: ${actualBrowserVersion}.`);
    }
    const nodeJobs = codeItems.filter((item) => item.runtime.engine === "isolated-runner")
      .flatMap((item) => item.tests.map((test, testIndex) => ({ item, test, testIndex })));
    await runJobs(nodeJobs, 2, async ({ item, test, testIndex }) => {
      const started = Date.now();
      try {
        const execution = await executeNode(item, test.stdin);
        if (execution.timedOut) throw new Error("timeout");
        if (execution.code !== 0) throw new Error(`runner exit ${execution.code}; stderr=${execution.stderr.slice(0, 500)}`);
        if (!compareOutput(item, testIndex, execution.stdout)) {
          throw new Error(`stdout mismatch; expected=${JSON.stringify(test.expectedStdout)} actual=${JSON.stringify(execution.stdout)}`);
        }
        results.push({ itemId: item.id, skillId: item.skillId, engine: "isolated-runner", language: item.runtime.language, testId: test.id, visibility: test.visibility, category: test.category, status: "passed", durationMs: Date.now() - started, sourceHash: digest(item.answer.referenceSolution) });
      } catch (error) {
        results.push({ itemId: item.id, skillId: item.skillId, engine: "isolated-runner", language: item.runtime.language, testId: test.id, visibility: test.visibility, category: test.category, status: "failed", durationMs: Date.now() - started, sourceHash: digest(item.answer.referenceSolution), failure: error instanceof Error ? error.message : String(error) });
      }
    });
    console.log(`Web verifier Node progress: ${nodeJobs.length}/${nodeJobs.length} cases.`);

    const reactBundles = new Map<string, BundledReactArtifact>();
    const browserJobs = codeItems.filter((item) => item.runtime.engine === "browser-verifier")
      .flatMap((item) => item.tests.map((test, testIndex) => ({ item, test, testIndex, testCase: parseBrowserCase(test.stdin, test.id) })));
    let completed = 0;
    await runJobs(browserJobs, 4, async ({ item, test, testIndex, testCase }) => {
      const started = Date.now();
      try {
        const execution = await executeBrowser({ browser: browser!, item, testCase, reactBundles });
        if (!compareOutput(item, testIndex, execution.stdout)) {
          throw new Error(`browser verifier output mismatch; expected=${JSON.stringify(test.expectedStdout)} actual=${JSON.stringify(execution.stdout)}`);
        }
        results.push({ itemId: item.id, skillId: item.skillId, engine: "browser-verifier", language: item.runtime.language, testId: test.id, visibility: test.visibility, category: test.category, status: "passed", durationMs: Date.now() - started, sourceHash: digest(item.answer.referenceSolution), ...(execution.consoleErrors.length ? { consoleErrors: execution.consoleErrors } : {}) });
      } catch (error) {
        results.push({ itemId: item.id, skillId: item.skillId, engine: "browser-verifier", language: item.runtime.language, testId: test.id, visibility: test.visibility, category: test.category, status: "failed", durationMs: Date.now() - started, sourceHash: digest(item.answer.referenceSolution), failure: error instanceof Error ? error.message : String(error) });
      }
      completed += 1;
      if (completed % 25 === 0 || completed === browserJobs.length) console.log(`Web verifier browser progress: ${completed}/${browserJobs.length} cases.`);
    });
    await browser.close();
  }

  results.sort((left, right) => left.itemId.localeCompare(right.itemId) || left.testId.localeCompare(right.testId));
  const failures = results.filter((result) => result.status === "failed");
  const browserItems = codeItems.filter((item) => item.runtime.engine === "browser-verifier");
  const nodeItems = codeItems.filter((item) => item.runtime.engine === "isolated-runner");
  const totalCases = codeItems.reduce((sum, item) => sum + item.tests.length, 0);
  const report = {
    schemaVersion: "1.0.0",
    generatedAt: new Date().toISOString(),
    scope: "Launch-1 HTML, accessible/responsive CSS, JavaScript, and intermediate React authoring evidence",
    status: structureOnly ? "structure-only" : failures.length === 0 && results.length === totalCases ? "verified" : "failed-or-partial",
    counts: {
      declaredSkills: declared.length,
      classifiedSkills: skillCoverage.length,
      browserVerifiedSkills: browserItems.length,
      nodeExecutableSkills: nodeItems.length,
      newNodeSkills: Object.keys(WEB_NEW_NODE_TASKS).length,
      retainedNodeSkills: WEB_RETAINED_NODE_SKILLS.length,
      justifiedNonCodeSkills: Object.keys(WEB_NON_CODE_FACETS).length,
      codeItems: codeItems.length,
      totalCases,
      visibleCases: codeItems.reduce((sum, item) => sum + item.tests.filter((test) => test.visibility === "visible").length, 0),
      hiddenCases: codeItems.reduce((sum, item) => sum + item.tests.filter((test) => test.visibility === "hidden").length, 0),
      executedCases: results.length,
      passedCases: results.length - failures.length,
      failedCases: failures.length,
    },
    courseCounts: Object.fromEntries([...courseIds].map((courseId) => [courseId, {
      skills: declared.filter((entry) => entry.courseId === courseId).length,
      browserVerified: browserItems.filter((item) => item.runtime.language === courseId).length,
      nodeExecutable: nodeItems.filter((item) => courseId === "javascript" && item.runtime.language === "javascript").length,
      nonCode: skillCoverage.filter((entry) => entry.courseId === courseId && entry.classification === "non-code").length,
    }])),
    environment: {
      packageLockHash,
      node: {
        tag: nodeTag,
        expectedImageDigest: javascriptDigest,
        actualImageId: actualNodeImageId,
        imageMatches: nodeImageMatches,
        expectedVersion: expectedNodeVersion,
        inspectedVersion: javascriptInspection?.version ?? null,
        versionMatches: nodeVersionMatches,
        harness: javascriptInspection?.harness ?? null,
      },
      browser: {
        name: "chromium",
        expectedRevision: expectedBrowser.revision,
        executableRevision: revision,
        expectedVersion: expectedBrowser.version,
        actualVersion: actualBrowserVersion,
        executableHash: browserExecutableHash,
        executablePathRecorded: false,
        playwrightVersion: playwrightPackage.version,
        esbuildVersion: esbuildPackage.version,
      },
      reactProject: {
        reactRouterVersion: reactRouterPackage.version,
        reactRouterNodeEngine: reactRouterPackage.engines?.node ?? null,
        testingLibraryReactVersion: testingReactPackage.version,
        testingLibraryUserEventVersion: userEventPackage.version,
        authoringHostNodeVersion: process.version,
        productionNodeBaseline: "22.23.1",
        productionNodeMeetsRouterEngine: true,
      },
    },
    executionPolicy: {
      externalNetwork: "denied; only exact in-memory test routes are fulfilled",
      externalProviderCalls: 0,
      nodeRunnerNetwork: "none",
      nodeSourceMount: "read-only",
      nodeRootFilesystem: "read-only",
      nodeCapabilities: "all dropped",
      browserServiceWorkers: "blocked",
      multiFileArtifacts: "validated path/manifest contract, materialized only in a temporary directory, bundled from an explicit app or test entrypoint, then deleted",
      browserAssertions: "trusted authoring oracles over observable DOM, computed style, URL/storage, and interaction state",
      accessibility: "selected cases run axe serious/critical rules; automated checks do not replace manual review",
      formalExamEligibility: false,
    },
    skillCoverage,
    results,
    remainingGaps: [
      "Every lesson and assessment item remains an AI-assisted, human-unreviewed draft with reviewer=null and examEligibility=false; runtime evidence is not publication approval.",
      "The browser verifier is an authoring-only local tool. The production learner runner still supports JavaScript/Node only and must reject HTML, CSS, and React browser items.",
      "React Router 8.0.1 routing, parameter, navigation/focus, Testing Library, and a minimal multi-file portfolio SPA now have bounded reference evidence; this does not make the portfolio a human-approved capstone.",
      "The virtual project declares exact Vite build/preview/test scripts and dependencies, but this verifier bundles with pinned esbuild rather than executing Vite dev/build/preview. React model.project therefore remains honestly non-code pending a separate Node 22.22+ project-toolchain verifier.",
      "The Testing Library entrypoint executes nine bounded reference checks covering role/name queries, controlled form interaction, async success/error/empty states, route parameters, focus, and direct entry. Arbitrary learner-supplied multi-file projects and test suites still need production-grade isolation, quotas, diagnostic capture, and anti-abuse controls before formal grading.",
      "Automated Chromium and axe checks do not prove real Safari/Firefox behavior, screen-reader usability, 200-400% zoom/reflow, high-contrast modes, touch behavior, or human content quality.",
      "Composite fixtures prove bounded declared facets of reference solutions; they do not independently prove learner explanation quality, maintainability, complete mastery, or every browser/platform boundary.",
      "The local Chromium executable hash is recorded as evidence but differs across operating systems; the cross-platform semantic pin is Playwright version, browser revision, and reported browser version.",
    ],
  };
  const reportPath = path.join(root, "docs", "evidence", structureOnly
    ? "web-executable-structure-2026-07-12.json"
    : "web-executable-runtime-2026-07-12.json");
  await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n", "utf8");
  console.log(
    `Web executable verification: ${declared.length} skills, ${browserItems.length} browser, ` +
      `${nodeItems.length} Node, ${Object.keys(WEB_NON_CODE_FACETS).length} non-code, ` +
      `${results.length}/${totalCases} cases executed, ${failures.length} failures, structureOnly=${structureOnly}.`,
  );
  if (failures.length || (process.argv.includes("--check") && !structureOnly && results.length !== totalCases)) {
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
