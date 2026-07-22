import { createHash, randomBytes, randomUUID } from "node:crypto";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { createServer as createHttpsServer, type Server as HttpsServer } from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import AxeBuilder from "@axe-core/playwright";
import {
  chromium,
  devices,
  firefox,
  type Browser,
  type BrowserContext,
  type BrowserServer,
  type BrowserType,
  type Page,
  webkit,
} from "@playwright/test";
import { hashPassword } from "better-auth/crypto";
import {
  BLUEPRINT_RESPONSE_KEY,
  EXAM_POLICY_VERSION,
  type ExamFormSnapshot,
} from "../src/lib/exams/contracts";
import { EMERGENCY_EXAM_EVENT_PREFIX } from "../src/lib/browser-durability/emergency-events";
import { eq } from "drizzle-orm";
import pg from "pg";

const { Client } = pg;
const repoRoot = process.cwd();
const docker = process.platform === "win32" ? "docker.exe" : "docker";
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const npmCli = process.env.npm_execpath;
const startedAt = new Date().toISOString();
const runId = startedAt.replace(/[:.]/g, "-");
const suffix = randomBytes(6).toString("hex");
const containerName = `learncoding-auth-ui-${suffix}`;
const distDirName = ".next-e2e-auth-runtime";
const distDir = path.join(repoRoot, distDirName);
const objectStorageDir = path.join(repoRoot, `.tmp-auth-runtime-objects-${suffix}`);
const artifactDir = path.join(repoRoot, "test-artifacts", "authenticated-learn-runtime", runId);
const profileTempRoot = path.join(os.tmpdir(), "codestead-browser-durability-" + suffix);
const tlsDir = path.join(profileTempRoot, "tls");

let appProcess: ChildProcess | null = null;
let browser: Browser | null = null;
let appPool: pg.Pool | null = null;
let containerStarted = false;
let httpsProxy: HttpsServer | null = null;
type CleanupResults = Readonly<{
  browserServers: "closed" | "failed";
  temporaryProfileRoot: "removed" | "failed";
  applicationProcess: "stopped" | "failed";
  postgresPool: "closed" | "failed";
  httpsProxy: "stopped" | "not-started" | "failed";
  postgresContainer: "removed" | "not-started" | "failed";
  objectStorageDirectory: "removed" | "failed";
  buildDirectory: "removed" | "failed";
}>;
let cleanupPromise: Promise<CleanupResults> | null = null;

function commandEnvironment(overrides: Partial<NodeJS.ProcessEnv> = {}): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    NODE_ENV: process.env.NODE_ENV ?? "test",
  };
  for (const key of [
    "PATH",
    "Path",
    "PATHEXT",
    "SystemRoot",
    "SYSTEMROOT",
    "ComSpec",
    "COMSPEC",
    "TEMP",
    "TMP",
    "TMPDIR",
    "HOME",
    "USERPROFILE",
    "LOCALAPPDATA",
    "APPDATA",
    "PROGRAMFILES",
    "ProgramFiles",
    "LANG",
  ]) {
    if (process.env[key] !== undefined) environment[key] = process.env[key];
  }
  return { ...environment, ...overrides };
}

async function availablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Could not allocate a loopback port."));
        return;
      }
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

function resolveOpenSsl() {
  const candidates = process.env.OPENSSL_PATH ? [process.env.OPENSSL_PATH] : [];
  if (process.platform === "win32") {
    const programFiles = process.env.ProgramFiles ?? process.env.PROGRAMFILES ?? "C:\\Program Files";
    const localAppData = process.env.LOCALAPPDATA;
    candidates.push(
      path.join(programFiles, "Git", "usr", "bin", "openssl.exe"),
      path.join(programFiles, "Git", "mingw64", "bin", "openssl.exe"),
    );
    if (localAppData) candidates.push(path.join(localAppData, "Programs", "Git", "usr", "bin", "openssl.exe"));
    candidates.push("openssl.exe");
  } else {
    candidates.push("openssl");
  }

  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ["version"], {
      encoding: "utf8",
      env: commandEnvironment(),
      windowsHide: true,
    });
    if (probe.status === 0) return candidate;
  }
  throw new Error("OpenSSL is required to create the verifier's ephemeral HTTPS certificate.");
}

async function createEphemeralTlsCertificate() {
  await mkdir(tlsDir, { recursive: true });
  const keyPath = path.join(tlsDir, "loopback-key.pem");
  const certificatePath = path.join(tlsDir, "loopback-certificate.pem");
  const generated = spawnSync(resolveOpenSsl(), [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-sha256",
    "-nodes",
    "-days",
    "1",
    "-keyout",
    keyPath,
    "-out",
    certificatePath,
    "-subj",
    "/CN=127.0.0.1",
    "-addext",
    "subjectAltName=IP:127.0.0.1,DNS:localhost",
  ], {
    encoding: "utf8",
    env: commandEnvironment(),
    windowsHide: true,
  });
  if (generated.status !== 0) {
    throw new Error("OpenSSL could not create the verifier's ephemeral HTTPS certificate.");
  }
  const [key, cert] = await Promise.all([readFile(keyPath), readFile(certificatePath)]);
  return { key, cert };
}

async function startHttpsLoopbackProxy(input: { port: number; targetPort: number }) {
  const credentials = await createEphemeralTlsCertificate();
  const server = createHttpsServer(credentials, (request, response) => {
    const forwardedHost = request.headers.host ?? `127.0.0.1:${input.port}`;
    const upstream = httpRequest({
      hostname: "127.0.0.1",
      port: input.targetPort,
      path: request.url ?? "/",
      method: request.method,
      headers: {
        ...request.headers,
        host: `127.0.0.1:${input.targetPort}`,
        "x-forwarded-host": forwardedHost,
        "x-forwarded-proto": "https",
      },
    }, (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
      upstreamResponse.pipe(response);
    });
    upstream.once("error", () => {
      if (!response.headersSent) response.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
      response.end("Synthetic HTTPS proxy could not reach the local application.");
    });
    request.pipe(upstream);
  });
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(input.port, "127.0.0.1", () => {
      server.off("error", onError);
      resolve();
    });
  });
  return server;
}

async function stopHttpsLoopbackProxy(): Promise<CleanupResults["httpsProxy"]> {
  const server = httpsProxy;
  if (!server) return "not-started";
  httpsProxy = null;
  return new Promise((resolve) => {
    server.close((error) => resolve(error ? "failed" : "stopped"));
    server.closeAllConnections();
  });
}

function collectOutput(child: ChildProcess, sensitiveValues: readonly string[]) {
  let output = "";
  const append = (chunk: Buffer | string) => {
    output = `${output}${String(chunk)}`.slice(-16_384);
  };
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);
  return () => sensitiveValues.reduce(
    (safe, value) => value ? safe.replaceAll(value, "[redacted]") : safe,
    output,
  );
}

function runCommand(input: {
  command: string;
  args: readonly string[];
  env: NodeJS.ProcessEnv;
  sensitiveValues: readonly string[];
}) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(input.command, [...input.args], {
      cwd: repoRoot,
      env: input.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const output = collectOutput(child, input.sensitiveValues);
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(
        `${path.basename(input.command)} exited with ${code ?? signal ?? "unknown"}. ${output()}`.trim(),
      ));
    });
  });
}

async function waitForPostgres(connectionString: string) {
  const deadline = Date.now() + 60_000;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    const client = new Client({ connectionString, connectionTimeoutMillis: 1_000 });
    try {
      await client.connect();
      await client.query("select 1");
      await client.end();
      return;
    } catch (error) {
      lastError = error;
      await client.end().catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
  }
  throw new Error(`Disposable PostgreSQL did not become ready: ${String(lastError)}`);
}

async function waitForApplication(baseURL: string, childOutput: () => string) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (appProcess?.exitCode !== null) {
      throw new Error(`The isolated application exited before becoming ready. ${childOutput()}`.trim());
    }
    try {
      const response = await fetch(`${baseURL}/login`, { redirect: "manual" });
      if (response.status >= 200 && response.status < 500) return;
    } catch {
      // The isolated server is still compiling or binding its loopback port.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`The isolated application did not become ready. ${childOutput()}`.trim());
}

async function stopProcessTree(child: ChildProcess | null) {
  if (!child?.pid || child.exitCode !== null) return;
  if (process.platform === "win32") {
    spawnSync("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], {
      stdio: "ignore",
      windowsHide: true,
    });
    return;
  }
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  if (child.exitCode === null) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }
}

async function removeDirectoryWithEvidence(target: string): Promise<"removed" | "failed"> {
  try {
    await rm(target, { recursive: true, force: true });
  } catch {
    return "failed";
  }
  try {
    await access(target);
    return "failed";
  } catch {
    return "removed";
  }
}

function cleanup() {
  if (cleanupPromise) return cleanupPromise;
  cleanupPromise = (async () => {
    let browserServers: CleanupResults["browserServers"] = "closed";
    for (const profile of [...persistentProfiles]) {
      try {
        await profile.close();
      } catch {
        browserServers = "failed";
      }
    }
    try {
      await browser?.close();
    } catch {
      browserServers = "failed";
    }
    browser = null;
    const httpsProxyResult = await stopHttpsLoopbackProxy();
    const temporaryProfileRoot = await removeDirectoryWithEvidence(profileTempRoot);

    let applicationProcess: CleanupResults["applicationProcess"] = "stopped";
    try {
      await stopProcessTree(appProcess);
    } catch {
      applicationProcess = "failed";
    }
    appProcess = null;

    let postgresPool: CleanupResults["postgresPool"] = "closed";
    try {
      await appPool?.end();
    } catch {
      postgresPool = "failed";
    }
    appPool = null;

    let postgresContainer: CleanupResults["postgresContainer"] = "not-started";
    if (containerStarted) {
      const removed = spawnSync(docker, ["rm", "--force", containerName], {
        stdio: "ignore",
        windowsHide: true,
      });
      postgresContainer = removed.status === 0 ? "removed" : "failed";
      containerStarted = false;
    }
    const buildDirectory = await removeDirectoryWithEvidence(distDir);
    const objectStorageDirectory = await removeDirectoryWithEvidence(objectStorageDir);
    return {
      browserServers,
      temporaryProfileRoot,
      httpsProxy: httpsProxyResult,
      applicationProcess,
      postgresPool,
      postgresContainer,
      objectStorageDirectory,
      buildDirectory,
    };
  })();
  return cleanupPromise;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function runProvenance() {
  const git = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8",
    windowsHide: true,
  });
  const gitCommit = git.status === 0 ? git.stdout.trim() : "";
  assert(/^[0-9a-f]{40}$/i.test(gitCommit), "Git commit provenance was unavailable.");
  const playwright = spawnSync(
    process.execPath,
    ["-p", "require('@playwright/test/package.json').version"],
    {
      cwd: repoRoot,
      encoding: "utf8",
      windowsHide: true,
    },
  );
  const playwrightVersion = playwright.status === 0 ? playwright.stdout.trim() : "";
  assert(/^\d+\.\d+\.\d+/.test(playwrightVersion), "Playwright version provenance was unavailable.");
  return {
    gitCommit,
    nodeVersion: process.version,
    playwrightVersion,
    os: {
      platform: os.platform(),
      release: os.release(),
      architecture: os.arch(),
    },
  } as const;
}

const profileDefinitions = [
  { name: "chromium", browserTypeName: "chromium", deviceName: "Desktop Chrome", examApplicable: true },
  { name: "firefox", browserTypeName: "firefox", deviceName: "Desktop Firefox", examApplicable: true },
  { name: "webkit", browserTypeName: "webkit", deviceName: "Desktop Safari", examApplicable: true },
  { name: "tablet-safari", browserTypeName: "webkit", deviceName: "iPad Mini", examApplicable: true },
  { name: "small-mobile", browserTypeName: "webkit", deviceName: "iPhone SE", examApplicable: false },
  { name: "mobile-safari", browserTypeName: "webkit", deviceName: "iPhone 14", examApplicable: false },
] as const;

type ProfileDefinition = (typeof profileDefinitions)[number];
type BrowserTypeName = ProfileDefinition["browserTypeName"];

function selectedProfiles() {
  const configured = process.env.BROWSER_DURABILITY_PROFILES?.trim();
  if (!configured) return [...profileDefinitions];
  const names = [...new Set(configured.split(",").map((value) => value.trim()).filter(Boolean))];
  assert(names.length > 0, "BROWSER_DURABILITY_PROFILES selected no profiles.");
  const known = new Set(profileDefinitions.map((profile) => profile.name));
  for (const name of names) {
    assert(known.has(name as ProfileDefinition["name"]), "Unknown browser durability profile: " + name + ".");
  }
  return profileDefinitions.filter((profile) => names.includes(profile.name));
}

function browserTypeFor(name: BrowserTypeName): BrowserType {
  if (name === "chromium") return chromium;
  if (name === "firefox") return firefox;
  return webkit;
}

type PersistentLaunchServerOptions =
  NonNullable<Parameters<BrowserType["launchPersistentContext"]>[1]> & Readonly<{
    _userDataDir: string;
    artifactsDir: string;
    headless: true;
    _sharedBrowser: true;
  }>;

type BrowserServerWithPersistentDirectory = BrowserServer & Readonly<{
  _userDataDirForTest?: string;
}>;

type ProcessTransition = Readonly<{
  oldPid: number;
  newPid: number;
  terminationMode: "BrowserServer.kill";
}>;

async function bounded<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timeout: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(label + " timed out.")), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

class KillablePersistentProfile {
  private server: BrowserServer | null = null;
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private currentPid: number | null = null;

  constructor(
    readonly name: string,
    private readonly browserType: BrowserType,
    private readonly baseURL: string,
    private readonly profileRoot: string,
    readonly artifactDirectory: string,
    private readonly contextOptions: NonNullable<
      Parameters<BrowserType["launchPersistentContext"]>[1]
    >,
  ) {}

  async open() {
    assert(!this.server && !this.browser && !this.context, "Persistent profile is already open.");
    await mkdir(this.profileRoot, { recursive: true });
    const diagnosticsDir = path.join(this.artifactDirectory, "playwright");
    await mkdir(diagnosticsDir, { recursive: true });
    const launchPersistentServer = this.browserType.launchServer as unknown as (
      options: PersistentLaunchServerOptions,
    ) => Promise<BrowserServer>;
    let server: BrowserServer;
    try {
      server = await launchPersistentServer.call(this.browserType, {
        ...this.contextOptions,
        _userDataDir: this.profileRoot,
        _sharedBrowser: true,
        artifactsDir: diagnosticsDir,
        baseURL: this.baseURL,
        headless: true,
      });
    } catch (error) {
      throw new Error(
        "PERSISTENT_CRASH_LAUNCH_UNSUPPORTED: " +
        (error instanceof Error ? error.message : String(error)),
      );
    }
    const reportedProfile = (server as BrowserServerWithPersistentDirectory)
      ._userDataDirForTest;
    if (!reportedProfile || path.resolve(reportedProfile) !== path.resolve(this.profileRoot)) {
      await server.kill().catch(() => undefined);
      throw new Error("PERSISTENT_CRASH_LAUNCH_UNSUPPORTED: Playwright did not bind the requested user-data directory.");
    }
    const browser = await this.browserType.connect(server.wsEndpoint());
    const contexts = browser.contexts();
    if (contexts.length !== 1) {
      await browser.close().catch(() => undefined);
      await server.kill().catch(() => undefined);
      throw new Error("PERSISTENT_CRASH_LAUNCH_UNSUPPORTED: the default persistent context was unavailable.");
    }
    const process = server.process();
    const pid = process?.pid;
    if (!pid || !Number.isSafeInteger(pid)) {
      await browser.close().catch(() => undefined);
      await server.kill().catch(() => undefined);
      throw new Error("PERSISTENT_CRASH_LAUNCH_UNSUPPORTED: the owned browser PID was unavailable.");
    }
    this.server = server;
    this.browser = browser;
    this.context = contexts[0] ?? null;
    this.currentPid = pid;
    persistentProfiles.add(this);
    return this;
  }

  getContext() {
    assert(this.context, "Persistent browser context is unavailable.");
    return this.context;
  }

  getBrowserVersion() {
    assert(this.browser, "Persistent browser is unavailable.");
    return this.browser.version();
  }

  get pid() {
    assert(this.currentPid, "Persistent browser PID is unavailable.");
    return this.currentPid;
  }

  private async forceKill() {
    const server = this.server;
    const browser = this.browser;
    assert(server && browser && this.context && this.currentPid, "Persistent browser is not open.");
    const oldPid = this.currentPid;
    const process = server.process();
    const exited = process.exitCode !== null
      ? Promise.resolve()
      : new Promise<void>((resolve) => process.once("exit", () => resolve()));
    const disconnected = browser.isConnected()
      ? new Promise<void>((resolve) => browser.once("disconnected", () => resolve()))
      : Promise.resolve();
    await server.kill();
    await bounded(Promise.all([exited, disconnected]).then(() => undefined), 15_000, "Owned browser termination");
    this.server = null;
    this.browser = null;
    this.context = null;
    this.currentPid = null;
    return oldPid;
  }

  async crashAndReopen(): Promise<ProcessTransition> {
    const oldPid = await this.forceKill();
    await this.open();
    const newPid = this.pid;
    assert(newPid !== oldPid, "Persistent browser relaunch reused the terminated PID.");
    return {
      oldPid,
      newPid,
      terminationMode: "BrowserServer.kill",
    };
  }

  async checkpointAuthenticationAndReopen() {
    const context = this.context;
    const browser = this.browser;
    const server = this.server;
    const oldPid = this.currentPid;
    assert(context && browser && server && oldPid, "Persistent browser is not open.");
    this.context = null;
    this.browser = null;
    this.server = null;
    this.currentPid = null;
    await context.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
    await server.close().catch(() => undefined);
    await this.open();
    assert(this.pid !== oldPid, "Authentication checkpoint reused the closed browser PID.");
  }

  async close() {
    const context = this.context;
    const browser = this.browser;
    const server = this.server;
    this.context = null;
    this.browser = null;
    this.server = null;
    this.currentPid = null;
    await context?.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
    await server?.close().catch(() => undefined);
    await rm(this.profileRoot, { recursive: true, force: true }).catch(() => undefined);
    persistentProfiles.delete(this);
  }
}

const persistentProfiles = new Set<KillablePersistentProfile>();
type DraftMutationBody = Readonly<{
  kind: "code";
  courseId: string;
  skillId: string;
  language: string;
  content: string;
  expectedRowVersion: number;
  requestId: string;
}>;

type Deferred<T> = Readonly<{
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}>;

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function requestJsonObject(request: { postDataJSON(): unknown }) {
  try {
    const candidate = request.postDataJSON();
    return candidate !== null && typeof candidate === "object" && !Array.isArray(candidate)
      ? candidate as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function isUuid(value: unknown): value is string {
  return typeof value === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function requireDraftMutationBody(
  value: unknown,
  marker: string,
  expectedRowVersion = 0,
): DraftMutationBody {
  assert(value !== null && typeof value === "object" && !Array.isArray(value), "Draft PUT body was not an object.");
  const body = value as Record<string, unknown>;
  const expectedFields = [
    "content",
    "courseId",
    "expectedRowVersion",
    "kind",
    "language",
    "requestId",
    "skillId",
  ].sort().join(",");
  assert(Object.keys(body).sort().join(",") === expectedFields, "Draft PUT body fields changed unexpectedly.");
  assert(body.kind === "code", "Draft PUT kind was not code.");
  assert(body.courseId === "python", "Draft PUT course was not python.");
  assert(body.skillId === "free-playground", "Draft PUT skill was not free-playground.");
  assert(body.language === "python", "Draft PUT language was not python.");
  assert(body.content === marker, "Draft PUT did not contain the synthetic marker.");
  assert(
    body.expectedRowVersion === expectedRowVersion,
    "Draft PUT did not start at expected row version " + String(expectedRowVersion) + ".",
  );
  assert(isUuid(body.requestId), "Draft PUT requestId was not a UUID.");
  return body as DraftMutationBody;
}

async function setMonacoValue(page: Page, value: string) {
  const editorSurface = page.locator(".monaco-editor").first();
  await editorSurface.waitFor({ state: "visible" });
  const accessibleEditor = page.locator('[aria-label="Practice source code editor"]');
  await accessibleEditor.first().waitFor({ state: "attached" });
  assert(await accessibleEditor.count() === 1, "Monaco did not expose exactly one labelled practice editor.");
  await page.waitForFunction(() => {
    const monacoGlobal = globalThis as typeof globalThis & {
      monaco?: { editor?: { getModels?: () => Array<{ setValue(value: string): void }> } };
    };
    return monacoGlobal.monaco?.editor?.getModels?.().length === 1;
  });
  await page.evaluate((expected) => {
    const monacoGlobal = globalThis as typeof globalThis & {
      monaco?: { editor?: { getModels?: () => Array<{ setValue(value: string): void }> } };
    };
    const models = monacoGlobal.monaco?.editor?.getModels?.() ?? [];
    if (models.length !== 1) throw new Error("Monaco did not expose exactly one practice model.");
    models[0]!.setValue(expected);
  }, value);
}

async function monacoContains(page: Page, marker: string) {
  await page.locator(".monaco-editor").first().waitFor({ state: "visible" });
  const accessibleEditor = page.locator('[aria-label="Practice source code editor"]');
  await accessibleEditor.first().waitFor({ state: "attached" });
  assert(await accessibleEditor.count() === 1, "Monaco did not expose exactly one labelled practice editor after reopen.");
  return page.evaluate((expected) => {
    const monacoGlobal = globalThis as typeof globalThis & {
      monaco?: { editor?: { getModels?: () => Array<{ getValue(): string }> } };
    };
    if (monacoGlobal.monaco?.editor?.getModels?.()
      .some((model) => model.getValue().includes(expected))) return true;
    const textbox = document.querySelector<HTMLTextAreaElement>(
      '[aria-label="Practice source code editor"]',
    );
    const rendered = document.querySelector(".monaco-editor .view-lines");
    return textbox?.value.includes(expected) || rendered?.textContent?.includes(expected) || false;
  }, marker);
}

async function waitForDraftStatus(page: Page, status: string) {
  await page.locator('[data-draft-status="' + status + '"]').waitFor({
    state: "visible",
    timeout: 15_000,
  });
}

async function assertCommittedDraft(input: {
  learnerId: string;
  marker: string;
  requestId: string;
}) {
  assert(appPool, "Application PostgreSQL pool is unavailable.");
  const draft = await appPool.query<{
    id: string;
    content: string;
    row_version: string | number;
  }>([
    "select id, content, row_version",
    "from learner_draft",
    "where user_id = $1",
    "and kind = 'code'",
    "and course_id = 'python'",
    "and skill_id = 'free-playground'",
    "and language = 'python'",
  ].join(" "), [input.learnerId]);
  assert(draft.rowCount === 1, "Expected one authoritative draft row, received " + String(draft.rowCount ?? 0) + ".");
  assert(draft.rows[0]?.content === input.marker, "Authoritative draft marker did not match.");
  assert(Number(draft.rows[0]?.row_version) === 1, "Authoritative draft row version was not 1.");
  const receipts = await appPool.query<{
    request_id: string;
    expected_row_version: string | number;
    resulting_row_version: string | number;
  }>([
    "select m.request_id, m.expected_row_version, m.resulting_row_version",
    "from learner_draft_mutation m",
    "join learner_draft d on d.id = m.draft_id",
    "where d.user_id = $1",
    "and d.kind = 'code'",
    "and d.course_id = 'python'",
    "and d.skill_id = 'free-playground'",
    "and d.language = 'python'",
  ].join(" "), [input.learnerId]);
  assert(receipts.rowCount === 1, "Expected one authoritative draft receipt, received " + String(receipts.rowCount ?? 0) + ".");
  assert(receipts.rows[0]?.request_id === input.requestId, "Authoritative draft receipt requestId changed.");
  assert(Number(receipts.rows[0]?.expected_row_version) === 0, "Draft receipt expected version was not 0.");
  assert(Number(receipts.rows[0]?.resulting_row_version) === 1, "Draft receipt resulting version was not 1.");
  return {
    markerHash: sha256(input.marker),
    rowCount: draft.rowCount,
    rowVersion: Number(draft.rows[0]?.row_version),
    receiptCount: receipts.rowCount,
  };
}

async function signInSyntheticContext(context: BrowserContext, input: {
  baseURL: string;
  email: string;
  password: string;
}) {
  const canonicalOrigin = new URL(input.baseURL).origin;
  const signIn = await context.request.post(canonicalOrigin + "/api/auth/sign-in/email", {
    data: { email: input.email, password: input.password, rememberMe: true },
    headers: {
      origin: canonicalOrigin,
      "user-agent": "Codestead synthetic authenticated durability verification",
    },
  });
  assert(signIn.ok(), "Synthetic sign-in failed with HTTP " + String(signIn.status()) + ".");
  // Nothing is retained or copied across relaunches; this flushes the authenticated
  // request jar into the same browser profile before its setup-only clean checkpoint.
  const authenticatedCookies = (await context.request.storageState()).cookies;
  assert(authenticatedCookies.length > 0, "Synthetic sign-in did not populate the browser-context cookie jar.");
  await context.addCookies(authenticatedCookies);
}
type ExamAnswerMutationBody = Readonly<{
  clientMutationId: string;
  itemId: string;
  baseRevision: number;
  answer: Readonly<{ text: string }>;
}>;

type ExamEventMutationBody = Readonly<{
  clientEventId: string;
  type: "window_blur";
  metadata: Readonly<{ target: "window" }>;
}>;

type SyntheticExam = Readonly<{
  attemptId: string;
  sessionId: string;
  itemId: string;
}>;

function requireExamAnswerMutationBody(
  value: unknown,
  expected: { itemId: string; answer: string; baseRevision?: number },
): ExamAnswerMutationBody {
  assert(value !== null && typeof value === "object" && !Array.isArray(value), "Exam autosave body was not an object.");
  const body = value as Record<string, unknown>;
  assert(
    Object.keys(body).sort().join(",") === "answer,baseRevision,clientMutationId,itemId",
    "Exam autosave body fields changed unexpectedly.",
  );
  assert(isUuid(body.clientMutationId), "Exam autosave clientMutationId was not a UUID.");
  assert(body.itemId === expected.itemId, "Exam autosave item changed.");
  assert(
    body.baseRevision === (expected.baseRevision ?? 0),
    "Exam autosave did not start at expected revision " + String(expected.baseRevision ?? 0) + ".",
  );
  assert(body.answer !== null && typeof body.answer === "object" && !Array.isArray(body.answer), "Exam answer was not an object.");
  const answer = body.answer as Record<string, unknown>;
  assert(Object.keys(answer).join(",") === "text", "Short-answer autosave fields changed unexpectedly.");
  assert(answer.text === expected.answer, "Exam autosave answer changed.");
  return body as ExamAnswerMutationBody;
}

function requireExamEventMutationBody(value: unknown): ExamEventMutationBody {
  assert(value !== null && typeof value === "object" && !Array.isArray(value), "Exam event body was not an object.");
  const body = value as Record<string, unknown>;
  assert(
    Object.keys(body).sort().join(",") === "clientEventId,metadata,type",
    "Exam event body fields changed unexpectedly.",
  );
  assert(isUuid(body.clientEventId), "Exam clientEventId was not a UUID.");
  assert(body.type === "window_blur", "Exam event type was not the targeted window_blur.");
  assert(body.metadata !== null && typeof body.metadata === "object" && !Array.isArray(body.metadata), "Exam event metadata was not an object.");
  const metadata = body.metadata as Record<string, unknown>;
  assert(
    Object.keys(metadata).join(",") === "target" && metadata.target === "window",
    "Exam event metadata was not the targeted window blur.",
  );
  return body as ExamEventMutationBody;
}

async function assertExamAnswerCommitted(input: {
  attemptId: string;
  sessionId: string;
  itemId: string;
  clientMutationId: string;
  answer: string;
}) {
  assert(appPool, "Application PostgreSQL pool is unavailable.");
  const answers = await appPool.query<{
    revision: number;
    answer: Record<string, unknown>;
    saved_at: Date;
  }>([
    "select revision, answer, saved_at",
    "from response",
    "where attempt_id = $1 and item_key = $2",
    "and item_key <> $3",
  ].join(" "), [input.attemptId, input.itemId, BLUEPRINT_RESPONSE_KEY]);
  assert(answers.rowCount === 1, "Expected one authoritative exam answer, received " + String(answers.rowCount ?? 0) + ".");
  assert(Number(answers.rows[0]?.revision) === 1, "Authoritative exam answer revision was not 1.");
  assert(answers.rows[0]?.answer?.text === input.answer, "Authoritative exam answer marker did not match.");
  const receipts = await appPool.query<{
    client_mutation_id: string;
    item_key: string;
    expected_revision: number;
    resulting_revision: number;
    resulting_saved_at: Date;
  }>([
    "select client_mutation_id, item_key, expected_revision, resulting_revision, resulting_saved_at",
    "from exam_autosave_mutation",
    "where exam_session_id = $1 and client_mutation_id = $2",
  ].join(" "), [input.sessionId, input.clientMutationId]);
  assert(receipts.rowCount === 1, "Expected one exam autosave receipt, received " + String(receipts.rowCount ?? 0) + ".");
  const receipt = receipts.rows[0];
  assert(receipt?.item_key === input.itemId, "Exam autosave receipt item changed.");
  assert(Number(receipt?.expected_revision) === 0, "Exam autosave receipt expected revision was not 0.");
  assert(Number(receipt?.resulting_revision) === 1, "Exam autosave receipt resulting revision was not 1.");
  const savedAt = answers.rows[0]?.saved_at;
  const receiptSavedAt = receipt?.resulting_saved_at;
  assert(savedAt instanceof Date && receiptSavedAt instanceof Date, "Exam autosave timestamps were unavailable.");
  assert(savedAt.getTime() === receiptSavedAt.getTime(), "Exam answer and receipt savedAt values diverged.");
  return {
    answerHash: sha256(input.answer),
    answerRowCount: answers.rowCount,
    answerRevision: Number(answers.rows[0]?.revision),
    receiptCount: receipts.rowCount,
    savedAt: savedAt.toISOString(),
  };
}

async function assertExamEventCommitted(input: {
  sessionId: string;
  clientEventId: string;
}) {
  assert(appPool, "Application PostgreSQL pool is unavailable.");
  const events = await appPool.query<{
    client_event_id: string;
    type: string;
    metadata: Record<string, unknown>;
  }>([
    "select client_event_id, type, metadata",
    "from exam_event",
    "where exam_session_id = $1 and client_event_id = $2",
  ].join(" "), [input.sessionId, input.clientEventId]);
  assert(events.rowCount === 1, "Expected one authoritative exam event, received " + String(events.rowCount ?? 0) + ".");
  assert(events.rows[0]?.type === "window_blur", "Authoritative exam event type changed.");
  assert(events.rows[0]?.metadata?.target === "window", "Authoritative exam event metadata changed.");
  return {
    eventRowCount: events.rowCount,
    clientEventIdHash: sha256(input.clientEventId),
  };
}

async function waitForExamSaveState(page: Page, state: string) {
  await page.locator('[data-durability-status="true"][data-state="' + state + '"]').waitFor({
    state: "visible",
    timeout: 15_000,
  });
}
async function startExamSaveStateObservation(page: Page) {
  await page.evaluate(() => {
    const root = globalThis as typeof globalThis & {
      __task6ExamSaveStates?: string[];
      __task6ExamSaveObserver?: MutationObserver;
    };
    root.__task6ExamSaveObserver?.disconnect();
    const status = document.querySelector<HTMLElement>('[data-durability-status="true"]');
    if (!status) throw new Error("Exam durability status was not rendered.");
    root.__task6ExamSaveStates = [status.dataset.state ?? ""];
    const observer = new MutationObserver(() => {
      const state = status.dataset.state;
      if (state && !root.__task6ExamSaveStates?.includes(state)) {
        root.__task6ExamSaveStates?.push(state);
      }
    });
    observer.observe(status, { attributes: true, attributeFilter: ["data-state"] });
    root.__task6ExamSaveObserver = observer;
  });
}

async function waitForObservedExamSaveState(page: Page, state: string) {
  await page.waitForFunction((expected) => {
    const root = globalThis as typeof globalThis & {
      __task6ExamSaveStates?: string[];
    };
    return root.__task6ExamSaveStates?.includes(expected) === true;
  }, state, { timeout: 15_000 });
}

async function waitForExamEditor(page: Page, input: { artifactDirectory: string; scenario: string }) {
  const editor = page.getByLabel("Your response");
  try {
    await editor.waitFor({ state: "visible" });
    return editor;
  } catch (error) {
    let sessionStatus: number | null = null;
    let sessionPresent = false;
    try {
      const response = await page.request.get("/api/auth/get-session");
      sessionStatus = response.status();
      const payload = await response.json().catch(() => null) as Record<string, unknown> | null;
      sessionPresent = Boolean(payload?.session);
    } catch {
      // Navigation diagnostics remain useful when the session probe itself fails.
    }
    const rendered = await page.evaluate(() => ({
      title: document.title,
      bodyText: document.body?.innerText.slice(0, 4_000) ?? "",
      readyState: document.readyState,
    }));
    const cookies = (await page.context().cookies()).map((cookie) => ({
      nameHash: sha256(cookie.name),
      domain: cookie.domain,
      path: cookie.path,
      secure: cookie.secure,
      sameSite: cookie.sameSite,
      persistent: cookie.expires > 0,
    }));
    const diagnosticFile = path.join(input.artifactDirectory, input.scenario + "-diagnostic.json");
    const screenshotFile = path.join(input.artifactDirectory, input.scenario + "-diagnostic.png");
    await page.screenshot({ path: screenshotFile, fullPage: true }).catch(() => undefined);
    await writeFile(diagnosticFile, JSON.stringify({
      scenario: input.scenario,
      url: page.url(),
      sessionStatus,
      sessionPresent,
      cookies,
      ...rendered,
    }, null, 2) + "\n", "utf8");
    throw new Error(
      input.scenario + " did not render the exam editor; diagnostics: "
      + path.relative(repoRoot, diagnosticFile).replaceAll("\\", "/") + ". "
      + (error instanceof Error ? error.message : String(error)),
    );
  }
}


async function runExamAnswerCrash(input: {
  baseURL: string;
  profile: KillablePersistentProfile;
  exam: SyntheticExam;
}) {
  const context = input.profile.getContext();
  const traceBeforeCrash = path.join(input.profile.artifactDirectory, "trace-exam-before-crash.zip");
  await context.tracing.start({ screenshots: true, snapshots: true, sources: false });
  const page = await context.newPage();
  const answerMarker = "synthetic exam answer " + suffix + " " + input.profile.name;
  const committed = deferred<{
    body: ExamAnswerMutationBody;
    bodyHash: string;
    upstreamStatus: number;
    savedAt: string;
  }>();
  let captured = false;
  await context.route("**/api/exams/" + input.exam.sessionId + "/autosave", async (route) => {
    const request = route.request();
    if (request.method() !== "PUT" || captured) {
      await route.continue();
      return;
    }
    captured = true;
    try {
      const rawBody = request.postData();
      assert(rawBody, "Exam autosave request body was unavailable.");
      const body = requireExamAnswerMutationBody(request.postDataJSON(), {
        itemId: input.exam.itemId,
        answer: answerMarker,
      });
      const upstream = await route.fetch();
      assert(upstream.ok(), "Exam autosave upstream PUT failed with HTTP " + String(upstream.status()) + ".");
      const result = await upstream.json() as Record<string, unknown>;
      const saved = result.saved as Record<string, unknown> | undefined;
      assert(saved?.clientMutationId === body.clientMutationId, "Exam autosave response changed the mutation identifier.");
      assert(saved?.replayed === false, "First exam autosave was unexpectedly replayed.");
      assert(saved?.revision === 1, "First exam autosave did not report revision 1.");
      assert(typeof saved?.savedAt === "string", "First exam autosave omitted savedAt.");
      committed.resolve({
        body,
        bodyHash: sha256(rawBody),
        upstreamStatus: upstream.status(),
        savedAt: saved.savedAt,
      });
      await route.abort("failed");
    } catch (error) {
      committed.reject(error);
      await route.abort("failed").catch(() => undefined);
    }
  });

  await page.goto("/exams/" + input.exam.sessionId, { waitUntil: "domcontentloaded" });
  const editor = await waitForExamEditor(page, {
    artifactDirectory: input.profile.artifactDirectory,
    scenario: "exam-answer-before-crash",
  });
  await waitForExamSaveState(page, "server-saved");
  await startExamSaveStateObservation(page);
  await editor.fill(answerMarker);
  await waitForObservedExamSaveState(page, "saving-local");
  await waitForObservedExamSaveState(page, "saved-local");
  const commit = await bounded(committed.promise, 15_000, "Initial exam autosave response-loss commit");
  await waitForExamSaveState(page, "offline-saved-local");
  const beforeDatabase = await assertExamAnswerCommitted({
    attemptId: input.exam.attemptId,
    sessionId: input.exam.sessionId,
    itemId: input.exam.itemId,
    clientMutationId: commit.body.clientMutationId,
    answer: answerMarker,
  });
  assert(beforeDatabase.savedAt === commit.savedAt, "Exam autosave response and PostgreSQL savedAt values diverged.");
  const beforeScreenshot = path.join(input.profile.artifactDirectory, "exam-answer-before-crash.png");
  await page.screenshot({ path: beforeScreenshot, fullPage: true });
  await context.tracing.stop({ path: traceBeforeCrash });

  const processTransition = await input.profile.crashAndReopen();
  const reopened = input.profile.getContext();
  const traceAfterReopen = path.join(input.profile.artifactDirectory, "trace-exam-after-reopen.zip");
  await reopened.tracing.start({ screenshots: true, snapshots: true, sources: false });
  const replayObserved = deferred<{
    upstreamStatus: number;
    replayed: true;
  }>();
  let replayCaptured = false;
  await reopened.route("**/api/exams/" + input.exam.sessionId + "/autosave", async (route) => {
    const request = route.request();
    if (request.method() !== "PUT" || replayCaptured) {
      await route.continue();
      return;
    }
    replayCaptured = true;
    try {
      const rawBody = request.postData();
      assert(rawBody, "Recovered exam autosave request body was unavailable.");
      const body = requireExamAnswerMutationBody(request.postDataJSON(), {
        itemId: input.exam.itemId,
        answer: answerMarker,
      });
      assert(rawBody === JSON.stringify(commit.body), "Recovered exam autosave body was not byte-equivalent.");
      assert(sha256(rawBody) === commit.bodyHash, "Recovered exam autosave body hash changed.");
      assert(body.clientMutationId === commit.body.clientMutationId, "Recovered exam autosave changed clientMutationId.");
      const upstream = await route.fetch();
      assert(upstream.ok(), "Recovered exam autosave PUT failed with HTTP " + String(upstream.status()) + ".");
      const result = await upstream.json() as Record<string, unknown>;
      const saved = result.saved as Record<string, unknown> | undefined;
      assert(saved?.clientMutationId === body.clientMutationId, "Recovered exam autosave response changed clientMutationId.");
      assert(saved?.replayed === true, "Recovered exam autosave was not reported as a replay.");
      assert(saved?.revision === 1, "Recovered exam autosave changed revision.");
      assert(saved?.savedAt === commit.savedAt, "Recovered exam autosave changed savedAt.");
      replayObserved.resolve({ upstreamStatus: upstream.status(), replayed: true });
      await route.fulfill({ response: upstream });
    } catch (error) {
      replayObserved.reject(error);
      await route.abort("failed").catch(() => undefined);
    }
  });
  const reopenedPage = await reopened.newPage();
  await reopenedPage.goto("/exams/" + input.exam.sessionId, { waitUntil: "domcontentloaded" });
  const reopenedEditor = await waitForExamEditor(reopenedPage, {
    artifactDirectory: input.profile.artifactDirectory,
    scenario: "exam-answer-after-reopen",
  });
  const replay = await bounded(replayObserved.promise, 15_000, "Recovered exam autosave stable-ID replay");
  await waitForExamSaveState(reopenedPage, "server-saved");
  assert(await reopenedEditor.inputValue() === answerMarker, "Recovered exam answer was not rendered.");
  const afterDatabase = await assertExamAnswerCommitted({
    attemptId: input.exam.attemptId,
    sessionId: input.exam.sessionId,
    itemId: input.exam.itemId,
    clientMutationId: commit.body.clientMutationId,
    answer: answerMarker,
  });
  assert(afterDatabase.answerRowCount === beforeDatabase.answerRowCount, "Exam autosave replay created another answer row.");
  assert(afterDatabase.receiptCount === beforeDatabase.receiptCount, "Exam autosave replay created another receipt.");
  assert(afterDatabase.answerRevision === beforeDatabase.answerRevision, "Exam autosave replay incremented the revision.");
  assert(afterDatabase.savedAt === beforeDatabase.savedAt, "Exam autosave replay changed savedAt.");
  const afterScreenshot = path.join(input.profile.artifactDirectory, "exam-answer-after-reopen.png");
  await reopenedPage.screenshot({ path: afterScreenshot, fullPage: true });
  await reopened.tracing.stop({ path: traceAfterReopen });
  await reopened.unrouteAll({ behavior: "wait" });
  await reopenedPage.close();
  return {
    status: "passed",
    localAckObserved: true,
    originalRequestCount: 1,
    replayRequestCount: 1,
    beforeDatabase,
    afterDatabase,
    clientMutationIdHash: sha256(commit.body.clientMutationId),
    requestBodyHash: commit.bodyHash,
    originalUpstreamStatus: commit.upstreamStatus,
    replayUpstreamStatus: replay.upstreamStatus,
    processTransition,
    screenshots: {
      beforeCrash: path.relative(repoRoot, beforeScreenshot).replaceAll("\\", "/"),
      afterReopen: path.relative(repoRoot, afterScreenshot).replaceAll("\\", "/"),
    },
    traces: {
      beforeCrash: path.relative(repoRoot, traceBeforeCrash).replaceAll("\\", "/"),
      afterReopen: path.relative(repoRoot, traceAfterReopen).replaceAll("\\", "/"),
    },
  };
}

async function runExamEventCrash(input: {
  profile: KillablePersistentProfile;
  exam: SyntheticExam;
}) {
  const context = input.profile.getContext();
  const page = await context.newPage();
  const committed = deferred<{
    body: ExamEventMutationBody;
    bodyHash: string;
    upstreamStatus: number;
  }>();
  let captured = false;
  await context.route("**/api/exams/" + input.exam.sessionId + "/events", async (route) => {
    const request = route.request();
    if (request.method() !== "POST") {
      await route.continue();
      return;
    }
    let candidate: unknown;
    try {
      candidate = request.postDataJSON();
    } catch {
      await route.continue();
      return;
    }
    const record = candidate as Record<string, unknown> | null;
    const metadata = record?.metadata as Record<string, unknown> | undefined;
    if (captured || record?.type !== "window_blur" || metadata?.target !== "window") {
      await route.continue();
      return;
    }
    captured = true;
    try {
      const rawBody = request.postData();
      assert(rawBody, "Exam event request body was unavailable.");
      const body = requireExamEventMutationBody(candidate);
      const upstream = await route.fetch();
      assert(upstream.ok(), "Exam event upstream POST failed with HTTP " + String(upstream.status()) + ".");
      const result = await upstream.json() as Record<string, unknown>;
      assert(result.accepted === true && result.duplicate === false, "First exam event acknowledgement was invalid.");
      committed.resolve({
        body,
        bodyHash: sha256(rawBody),
        upstreamStatus: upstream.status(),
      });
      await route.abort("failed");
    } catch (error) {
      committed.reject(error);
      await route.abort("failed").catch(() => undefined);
    }
  });

  await page.goto("/exams/" + input.exam.sessionId, { waitUntil: "domcontentloaded" });
  await waitForExamEditor(page, {
    artifactDirectory: input.profile.artifactDirectory,
    scenario: "exam-event-before-crash",
  });
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  const commit = await bounded(committed.promise, 15_000, "Initial exam event response-loss commit");
  await page.getByText("An integrity event remains queued for browser recovery.", { exact: true })
    .waitFor({ state: "visible", timeout: 15_000 });
  const beforeDatabase = await assertExamEventCommitted({
    sessionId: input.exam.sessionId,
    clientEventId: commit.body.clientEventId,
  });

  const processTransition = await input.profile.crashAndReopen();
  const reopened = input.profile.getContext();
  const replayObserved = deferred<{
    upstreamStatus: number;
    duplicate: true;
  }>();
  let replayCaptured = false;
  await reopened.route("**/api/exams/" + input.exam.sessionId + "/events", async (route) => {
    const request = route.request();
    if (request.method() !== "POST") {
      await route.continue();
      return;
    }
    let candidate: unknown;
    try {
      candidate = request.postDataJSON();
    } catch {
      await route.continue();
      return;
    }
    const record = candidate as Record<string, unknown> | null;
    if (record?.clientEventId !== commit.body.clientEventId) {
      await route.continue();
      return;
    }
    assert(!replayCaptured, "Recovered exam event was sent more than once before acknowledgement.");
    replayCaptured = true;
    try {
      const rawBody = request.postData();
      assert(rawBody, "Recovered exam event request body was unavailable.");
      const body = requireExamEventMutationBody(candidate);
      assert(rawBody === JSON.stringify(commit.body), "Recovered exam event body was not byte-equivalent.");
      assert(sha256(rawBody) === commit.bodyHash, "Recovered exam event body hash changed.");
      assert(body.clientEventId === commit.body.clientEventId, "Recovered exam event changed clientEventId.");
      const upstream = await route.fetch();
      assert(upstream.ok(), "Recovered exam event POST failed with HTTP " + String(upstream.status()) + ".");
      const result = await upstream.json() as Record<string, unknown>;
      assert(result.accepted === true && result.duplicate === true, "Recovered exam event was not acknowledged as duplicate.");
      replayObserved.resolve({ upstreamStatus: upstream.status(), duplicate: true });
      await route.fulfill({ response: upstream });
    } catch (error) {
      replayObserved.reject(error);
      await route.abort("failed").catch(() => undefined);
    }
  });
  const reopenedPage = await reopened.newPage();
  await reopenedPage.goto("/exams/" + input.exam.sessionId, { waitUntil: "domcontentloaded" });
  await waitForExamEditor(reopenedPage, {
    artifactDirectory: input.profile.artifactDirectory,
    scenario: "exam-event-after-reopen",
  });
  const replay = await bounded(replayObserved.promise, 15_000, "Recovered exam event stable-ID replay");
  const afterDatabase = await assertExamEventCommitted({
    sessionId: input.exam.sessionId,
    clientEventId: commit.body.clientEventId,
  });
  assert(afterDatabase.eventRowCount === beforeDatabase.eventRowCount, "Exam event replay created another row.");
  await reopened.unrouteAll({ behavior: "wait" });
  await reopenedPage.close();
  return {
    status: "passed",
    localAckObserved: true,
    originalRequestCount: 1,
    replayRequestCount: 1,
    beforeDatabase,
    afterDatabase,
    clientEventIdHash: sha256(commit.body.clientEventId),
    requestBodyHash: commit.bodyHash,
    originalUpstreamStatus: commit.upstreamStatus,
    replayUpstreamStatus: replay.upstreamStatus,
    processTransition,
  };
}

async function runPersistentDraftCrash(input: {
  baseURL: string;
  profile: KillablePersistentProfile;
  learnerId: string;
}) {
  const context = input.profile.getContext();
  const traceBeforeCrash = path.join(input.profile.artifactDirectory, "trace-draft-before-crash.zip");
  await context.tracing.start({ screenshots: true, snapshots: true, sources: false });
  const page = await context.newPage();
  const marker = "synthetic_draft_" + suffix + "_" + input.profile.name + " = 1";
  const committed = deferred<{
    body: DraftMutationBody;
    upstreamStatus: number;
    cacheNamespace: string;
  }>();
  let firstPut = true;
  let preCrashRetryCount = 0;
  let captureTargetMutation = false;
  await context.route("**/api/drafts", async (route) => {
    const request = route.request();
    if (request.method() !== "PUT") {
      await route.continue();
      return;
    }
    if (!captureTargetMutation) {
      await route.continue();
      return;
    }
    if (!firstPut) {
      preCrashRetryCount += 1;
      await route.continue();
      return;
    }
    firstPut = false;
    try {
      const body = requireDraftMutationBody(request.postDataJSON(), marker);
      const upstream = await route.fetch();
      assert(upstream.ok(), "Draft upstream PUT failed with HTTP " + String(upstream.status()) + ".");
      const response = await upstream.json() as Record<string, unknown>;
      assert(response.replayed === false, "First draft commit was unexpectedly replayed.");
      assert(response.committedRowVersion === 1, "First draft commit did not report row version 1.");
      assert(typeof response.cacheNamespace === "string", "First draft commit omitted its cache namespace.");
      committed.resolve({
        body,
        upstreamStatus: upstream.status(),
        cacheNamespace: response.cacheNamespace,
      });
      await route.abort("failed");
    } catch (error) {
      committed.reject(error);
      await route.abort("failed").catch(() => undefined);
    }
  });
  await page.goto("/playground", { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "Code lab." }).waitFor();
  await page.getByRole("combobox", { name: "Runner language" }).waitFor();
  await waitForDraftStatus(page, "synced");
  captureTargetMutation = true;
  await setMonacoValue(page, marker);
  await waitForDraftStatus(page, "saved-local");
  const beforeScreenshot = path.join(input.profile.artifactDirectory, "draft-before-crash.png");
  await page.screenshot({ path: beforeScreenshot, fullPage: true });
  const commit = await bounded(committed.promise, 15_000, "Initial draft response-loss commit");
  const [beforeDatabase] = await Promise.all([
    assertCommittedDraft({
      learnerId: input.learnerId,
      marker,
      requestId: commit.body.requestId,
    }),
    waitForDraftStatus(page, "offline-saved-local"),
  ]);
  assert(preCrashRetryCount === 0, "Draft retried before the controlled browser-process kill boundary.");
  await context.tracing.stop({ path: traceBeforeCrash });
  const processTransition = await input.profile.crashAndReopen();
  const reopened = input.profile.getContext();
  const traceAfterReopen = path.join(input.profile.artifactDirectory, "trace-draft-after-reopen.zip");
  await reopened.tracing.start({ screenshots: true, snapshots: true, sources: false });
  const heldGet = deferred<void>();
  const releaseGet = deferred<void>();
  const retryObserved = deferred<{
    body: DraftMutationBody;
    upstreamStatus: number;
    replayed: true;
  }>();
  let getHeld = false;
  let retryCaptured = false;
  await reopened.route("**/api/drafts*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname !== "/api/drafts") {
      await route.continue();
      return;
    }
    if (request.method() === "GET" && !getHeld) {
      getHeld = true;
      heldGet.resolve(undefined);
      await releaseGet.promise;
      await route.continue();
      return;
    }
    if (request.method() !== "PUT" || retryCaptured) {
      await route.continue();
      return;
    }
    retryCaptured = true;
    try {
      const body = requireDraftMutationBody(request.postDataJSON(), marker);
      const fields = Object.keys(commit.body) as Array<keyof DraftMutationBody>;
      for (const field of fields) {
        assert(body[field] === commit.body[field], "Recovered draft PUT changed field " + field + ".");
      }
      const upstream = await route.fetch();
      assert(upstream.ok(), "Recovered draft PUT failed with HTTP " + String(upstream.status()) + ".");
      const response = await upstream.json() as Record<string, unknown>;
      assert(response.replayed === true, "Recovered draft PUT was not reported as a replay.");
      assert(response.committedRowVersion === 1, "Recovered draft replay changed the committed row version.");
      retryObserved.resolve({ body, upstreamStatus: upstream.status(), replayed: true });
      await route.fulfill({ response: upstream });
    } catch (error) {
      retryObserved.reject(error);
      await route.abort("failed").catch(() => undefined);
    }
  });
  const reopenedPage = await reopened.newPage();
  await reopenedPage.goto("/playground", { waitUntil: "domcontentloaded" });
  await bounded(heldGet.promise, 15_000, "Held authoritative draft GET");
  await reopenedPage.getByRole("heading", { name: "Code lab." }).waitFor();
  await reopenedPage.waitForFunction((expected) => {
    const monacoGlobal = globalThis as typeof globalThis & {
      monaco?: { editor?: { getModels?: () => Array<{ getValue(): string }> } };
    };
    if (monacoGlobal.monaco?.editor?.getModels?.()
      .some((model) => model.getValue().includes(expected))) return true;
    const textbox = document.querySelector<HTMLTextAreaElement>(
      '[aria-label="Practice source code editor"]',
    );
    const rendered = document.querySelector(".monaco-editor .view-lines");
    return textbox?.value.includes(expected) || rendered?.textContent?.includes(expected);
  }, marker, { timeout: 15_000 });
  assert(
    await monacoContains(reopenedPage, marker),
    "Recovered draft marker was missing before the held authoritative GET was released after relaunch.",
  );
  releaseGet.resolve(undefined);
  const retry = await bounded(retryObserved.promise, 15_000, "Recovered stable-ID draft replay");
  await waitForDraftStatus(reopenedPage, "synced");
  const afterDatabase = await assertCommittedDraft({
    learnerId: input.learnerId,
    marker,
    requestId: commit.body.requestId,
  });
  assert(afterDatabase.rowCount === beforeDatabase.rowCount, "Draft replay created another authoritative row.");
  assert(afterDatabase.receiptCount === beforeDatabase.receiptCount, "Draft replay created another receipt.");
  assert(afterDatabase.rowVersion === beforeDatabase.rowVersion, "Draft replay incremented the row version.");
  const afterScreenshot = path.join(input.profile.artifactDirectory, "draft-after-reopen.png");
  await reopenedPage.screenshot({ path: afterScreenshot, fullPage: true });
  await reopened.tracing.stop({ path: traceAfterReopen });
  await reopened.unrouteAll({ behavior: "wait" });
  await reopenedPage.close();
  return {
    status: "passed",
    localAckObserved: true,
    originalRequestCount: 1,
    replayRequestCount: 1,
    beforeDatabase,
    afterDatabase,
    requestIdHash: sha256(retry.body.requestId),
    originalUpstreamStatus: commit.upstreamStatus,
    replayUpstreamStatus: retry.upstreamStatus,
    processTransition,
    screenshots: {
      beforeCrash: path.relative(repoRoot, beforeScreenshot).replaceAll("\\", "/"),
      afterReopen: path.relative(repoRoot, afterScreenshot).replaceAll("\\", "/"),
    },
    traces: {
      beforeCrash: path.relative(repoRoot, traceBeforeCrash).replaceAll("\\", "/"),
      afterReopen: path.relative(repoRoot, traceAfterReopen).replaceAll("\\", "/"),
    },
  };
}

type BrowserRecoveryCounts = Readonly<{
  indexedDbEntries: number;
  emergencyLocalStorageKeys: number;
}>;

async function countBrowserRecoveryData(page: Page): Promise<BrowserRecoveryCounts> {
  return page.evaluate(async ({ databaseName, storeName, emergencyPrefix }) => {
    const indexedDbEntries = await new Promise<number>((resolve, reject) => {
      const openRequest = indexedDB.open(databaseName);
      openRequest.onerror = () => reject(openRequest.error ?? new Error("Browser outbox could not be opened."));
      openRequest.onblocked = () => reject(new Error("Browser outbox open was blocked."));
      openRequest.onupgradeneeded = () => {
        openRequest.transaction?.abort();
        reject(new Error("Browser outbox database was missing during the purge oracle."));
      };
      openRequest.onsuccess = () => {
        const database = openRequest.result;
        if (!database.objectStoreNames.contains(storeName)) {
          database.close();
          reject(new Error("Browser outbox store was missing during the purge oracle."));
          return;
        }
        const transaction = database.transaction(storeName, "readonly");
        const countRequest = transaction.objectStore(storeName).count();
        countRequest.onerror = () => reject(countRequest.error ?? new Error("Browser outbox count failed."));
        countRequest.onsuccess = () => {
          const count = countRequest.result;
          transaction.oncomplete = () => {
            database.close();
            resolve(count);
          };
        };
        transaction.onerror = () => {
          database.close();
          reject(transaction.error ?? new Error("Browser outbox count transaction failed."));
        };
        transaction.onabort = transaction.onerror;
      };
    });
    let emergencyLocalStorageKeys = 0;
    for (let index = 0; index < localStorage.length; index += 1) {
      if (localStorage.key(index)?.startsWith(emergencyPrefix)) emergencyLocalStorageKeys += 1;
    }
    return { indexedDbEntries, emergencyLocalStorageKeys };
  }, {
    databaseName: "codestead-browser-outbox-v1",
    storeName: "entries",
    emergencyPrefix: EMERGENCY_EXAM_EVENT_PREFIX,
  });
}

async function assertLocalOnlyDraftAbsent(input: {
  learnerId: string;
  marker: string;
  requestId: string;
}) {
  assert(appPool, "Application PostgreSQL pool is unavailable.");
  const [drafts, receipts] = await Promise.all([
    appPool.query<{ count: string }>([
      "select count(*)::text as count from learner_draft",
      "where user_id = $1 and kind = 'code' and course_id = 'python'",
      "and skill_id = 'free-playground' and language = 'python' and content = $2",
    ].join(" "), [input.learnerId, input.marker]),
    appPool.query<{ count: string }>(
      "select count(*)::text as count from learner_draft_mutation where request_id = $1",
      [input.requestId],
    ),
  ]);
  const draftCount = Number(drafts.rows[0]?.count ?? -1);
  const receiptCount = Number(receipts.rows[0]?.count ?? -1);
  assert(draftCount === 0, "The local-only draft marker reached PostgreSQL.");
  assert(receiptCount === 0, "The local-only draft receipt reached PostgreSQL.");
  return { draftCount, receiptCount };
}

async function assertLocalOnlyExamAbsent(input: {
  attemptId: string;
  sessionId: string;
  itemId: string;
  answer: string;
  clientMutationId: string;
  clientEventId: string;
}) {
  assert(appPool, "Application PostgreSQL pool is unavailable.");
  const [answers, receipts, events] = await Promise.all([
    appPool.query<{ count: string }>([
      "select count(*)::text as count from response",
      "where attempt_id = $1 and item_key = $2 and item_key <> $3",
      "and answer ->> 'text' = $4",
    ].join(" "), [input.attemptId, input.itemId, BLUEPRINT_RESPONSE_KEY, input.answer]),
    appPool.query<{ count: string }>([
      "select count(*)::text as count from exam_autosave_mutation",
      "where exam_session_id = $1 and client_mutation_id = $2",
    ].join(" "), [input.sessionId, input.clientMutationId]),
    appPool.query<{ count: string }>([
      "select count(*)::text as count from exam_event",
      "where exam_session_id = $1 and client_event_id = $2",
    ].join(" "), [input.sessionId, input.clientEventId]),
  ]);
  const answerCount = Number(answers.rows[0]?.count ?? -1);
  const receiptCount = Number(receipts.rows[0]?.count ?? -1);
  const eventCount = Number(events.rows[0]?.count ?? -1);
  assert(answerCount === 0, "The local-only exam answer reached PostgreSQL.");
  assert(receiptCount === 0, "The local-only exam autosave receipt reached PostgreSQL.");
  assert(eventCount === 0, "The local-only exam event reached PostgreSQL.");
  return { answerCount, receiptCount, eventCount };
}

async function runSignOutPurge(input: {
  baseURL: string;
  profile: KillablePersistentProfile;
  learnerId: string;
  exam?: SyntheticExam;
}) {
  const context = input.profile.getContext();
  const page = await context.newPage();
  const draftMarker = "synthetic_local_only_draft_" + suffix + "_" + input.profile.name;
  const draftCaptured = deferred<{ body: DraftMutationBody; bodyHash: string }>();
  let draftIdentity: { body: DraftMutationBody; bodyHash: string } | null = null;
  let draftAbortCount = 0;
  let examAnswerMarker: string | null = null;
  let examAnswerIdentity: { body: ExamAnswerMutationBody; bodyHash: string } | null = null;
  let examEventIdentity: { body: ExamEventMutationBody; bodyHash: string } | null = null;
  let examAnswerAbortCount = 0;
  let examEventAbortCount = 0;
  let eventArmed = false;
  let examDatabaseBeforeLogout: Record<string, number> | null = null;

  if (input.exam) {
    const exam = input.exam;
    examAnswerMarker = "synthetic local only exam answer " + suffix + " " + input.profile.name;
    const expectedAnswerMarker = examAnswerMarker;
    const answerCaptured = deferred<{ body: ExamAnswerMutationBody; bodyHash: string }>();
    const eventCaptured = deferred<{ body: ExamEventMutationBody; bodyHash: string }>();
    await context.route("**/api/exams/" + exam.sessionId + "/autosave", async (route) => {
      const request = route.request();
      if (request.method() !== "PUT") {
        await route.continue();
        return;
      }
      const candidate = requestJsonObject(request);
      if (!candidate) {
        await route.continue();
        return;
      }
      const answer = candidate.answer as Record<string, unknown> | undefined;
      if (candidate.itemId !== exam.itemId || answer?.text !== expectedAnswerMarker) {
        await route.continue();
        return;
      }
      const rawBody = request.postData();
      assert(rawBody, "Local-only exam autosave body was unavailable.");
      const body = requireExamAnswerMutationBody(candidate, {
        itemId: exam.itemId,
        answer: expectedAnswerMarker,
        baseRevision: 1,
      });
      const bodyHash = sha256(rawBody);
      if (examAnswerIdentity) {
        assert(body.clientMutationId === examAnswerIdentity.body.clientMutationId, "Local-only exam autosave retry changed mutation ID.");
        assert(bodyHash === examAnswerIdentity.bodyHash, "Local-only exam autosave retry changed its body.");
      } else {
        examAnswerIdentity = { body, bodyHash };
        answerCaptured.resolve(examAnswerIdentity);
      }
      examAnswerAbortCount += 1;
      await route.abort("failed");
    });
    await context.route("**/api/exams/" + exam.sessionId + "/events", async (route) => {
      const request = route.request();
      if (request.method() !== "POST") {
        await route.continue();
        return;
      }
      const candidate = requestJsonObject(request);
      if (!candidate) {
        await route.continue();
        return;
      }
      const metadata = candidate.metadata as Record<string, unknown> | undefined;
      const matchesTarget = candidate.type === "window_blur" && metadata?.target === "window";
      if ((!eventArmed && !examEventIdentity) || !matchesTarget) {
        await route.continue();
        return;
      }
      const rawBody = request.postData();
      assert(rawBody, "Local-only exam event body was unavailable.");
      const body = requireExamEventMutationBody(candidate);
      const bodyHash = sha256(rawBody);
      if (examEventIdentity) {
        assert(body.clientEventId === examEventIdentity.body.clientEventId, "Local-only exam event retry changed event ID.");
        assert(bodyHash === examEventIdentity.bodyHash, "Local-only exam event retry changed its body.");
      } else {
        examEventIdentity = { body, bodyHash };
        eventCaptured.resolve(examEventIdentity);
      }
      examEventAbortCount += 1;
      await route.abort("failed");
    });

    await page.goto("/exams/" + exam.sessionId, { waitUntil: "domcontentloaded" });
    const editor = await waitForExamEditor(page, {
      artifactDirectory: input.profile.artifactDirectory,
      scenario: "purge-exam-local-only",
    });
    await waitForExamSaveState(page, "server-saved");
    await startExamSaveStateObservation(page);
    await editor.fill(expectedAnswerMarker);
    await waitForObservedExamSaveState(page, "saving-local");
    await waitForObservedExamSaveState(page, "saved-local");
    examAnswerIdentity = await bounded(answerCaptured.promise, 15_000, "Local-only exam autosave capture");
    await waitForExamSaveState(page, "offline-saved-local");
    eventArmed = true;
    await page.evaluate(() => window.dispatchEvent(new Event("blur")));
    examEventIdentity = await bounded(eventCaptured.promise, 15_000, "Local-only exam event capture");
    await page.getByText("An integrity event remains queued for browser recovery.", { exact: true })
      .waitFor({ state: "visible", timeout: 15_000 });
    examDatabaseBeforeLogout = await assertLocalOnlyExamAbsent({
      attemptId: exam.attemptId,
      sessionId: exam.sessionId,
      itemId: exam.itemId,
      answer: expectedAnswerMarker,
      clientMutationId: examAnswerIdentity.body.clientMutationId,
      clientEventId: examEventIdentity.body.clientEventId,
    });
    assert(appPool, "Application PostgreSQL pool is unavailable.");
    const closedSession = await appPool.query([
      "update exam_session set status = 'submitted', updated_at = now()",
      "where id = $1 and user_id = $2 and status = 'active'",
    ].join(" "), [exam.sessionId, input.learnerId]);
    const closedAttempt = await appPool.query([
      "update attempt set status = 'submitted', submitted_at = now(), updated_at = now()",
      "where id = $1 and user_id = $2 and status = 'in_progress'",
    ].join(" "), [exam.attemptId, input.learnerId]);
    assert(closedSession.rowCount === 1 && closedAttempt.rowCount === 1, "Synthetic exam could not be closed for the purge scenario.");
  }

  await context.route("**/api/drafts", async (route) => {
    const request = route.request();
    if (request.method() !== "PUT") {
      await route.continue();
      return;
    }
    const candidate = requestJsonObject(request);
    if (!candidate) {
      await route.continue();
      return;
    }
    if (candidate.content !== draftMarker) {
      await route.continue();
      return;
    }
    const rawBody = request.postData();
    assert(rawBody, "Local-only draft body was unavailable.");
    const body = requireDraftMutationBody(candidate, draftMarker, 1);
    const bodyHash = sha256(rawBody);
    if (draftIdentity) {
      assert(body.requestId === draftIdentity.body.requestId, "Local-only draft retry changed request ID.");
      assert(bodyHash === draftIdentity.bodyHash, "Local-only draft retry changed its body.");
    } else {
      draftIdentity = { body, bodyHash };
      draftCaptured.resolve(draftIdentity);
    }
    draftAbortCount += 1;
    await route.abort("failed");
  });

  await page.goto("/playground", { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "Code lab." }).waitFor();
  await waitForDraftStatus(page, "synced");
  await setMonacoValue(page, draftMarker);
  await waitForDraftStatus(page, "saved-local");
  draftIdentity = await bounded(draftCaptured.promise, 15_000, "Local-only draft capture");
  await waitForDraftStatus(page, "offline-saved-local");
  const draftDatabaseBeforeLogout = await assertLocalOnlyDraftAbsent({
    learnerId: input.learnerId,
    marker: draftMarker,
    requestId: draftIdentity.body.requestId,
  });
  const beforeSignOut = await countBrowserRecoveryData(page);
  const minimumExpectedEntries = input.exam ? 3 : 1;
  assert(beforeSignOut.indexedDbEntries >= minimumExpectedEntries, "Purge negative control did not contain the expected local-only records.");

  const signOutResponse = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === "/api/auth/sign-out" && response.request().method() === "POST";
  });
  const accountButton = page.locator('button[aria-haspopup="menu"][aria-controls="profile-menu"]');
  await accountButton.waitFor({ state: "visible" });
  assert(await accountButton.count() === 1, "Expected one accessible account-menu button.");
  await accountButton.click();
  const accountMenu = page.getByRole("menu", { name: "Account menu" });
  await accountMenu.waitFor({ state: "visible" });
  await accountMenu.getByRole("menuitem", { name: "Sign out" }).click();
  const authoritativeSignOut = await bounded(signOutResponse, 15_000, "Authoritative sign-out response");
  assert(authoritativeSignOut.ok(), "Authoritative sign-out failed with HTTP " + String(authoritativeSignOut.status()) + ".");
  await page.getByLabel("Email address").waitFor({ state: "visible", timeout: 15_000 });
  const afterSignOut = await countBrowserRecoveryData(page);
  assert(afterSignOut.indexedDbEntries === 0, "Sign-out left browser outbox records behind.");
  assert(afterSignOut.emergencyLocalStorageKeys === 0, "Sign-out left emergency exam event records behind.");

  const processTransition = await input.profile.crashAndReopen();
  const reopened = input.profile.getContext();
  const sessionCheckHeld = deferred<void>();
  const releaseSessionCheck = deferred<void>();
  let held = false;
  await reopened.route("**/api/auth/get-session*", async (route) => {
    if (held || route.request().method() !== "GET") {
      await route.continue();
      return;
    }
    held = true;
    sessionCheckHeld.resolve(undefined);
    await releaseSessionCheck.promise;
    await route.continue();
  });
  const reopenedPage = await reopened.newPage();
  await reopenedPage.goto("/login", { waitUntil: "domcontentloaded" });
  await bounded(sessionCheckHeld.promise, 15_000, "Anonymous login session gate");
  await reopenedPage.getByRole("status").filter({ hasText: "Checking this browser's session..." })
    .waitFor({ state: "visible", timeout: 15_000 });
  assert(await reopenedPage.getByLabel("Email address").count() === 0, "Credentials appeared before the anonymous cleanup gate completed.");
  releaseSessionCheck.resolve(undefined);
  await reopenedPage.getByLabel("Email address").waitFor({ state: "visible", timeout: 15_000 });
  const afterReopen = await countBrowserRecoveryData(reopenedPage);
  assert(afterReopen.indexedDbEntries === 0, "Browser reopen restored purged outbox records.");
  assert(afterReopen.emergencyLocalStorageKeys === 0, "Browser reopen restored purged emergency records.");

  await reopenedPage.goto("/playground", { waitUntil: "domcontentloaded" });
  await reopenedPage.waitForURL((url) => url.pathname === "/login", { timeout: 15_000 });
  await reopenedPage.getByLabel("Email address").waitFor({ state: "visible", timeout: 15_000 });
  const anonymousBody = await reopenedPage.locator("body").innerText();
  assert(!anonymousBody.includes(draftMarker), "Anonymous playground redirect exposed the local-only draft marker.");
  let examOwnerDenialStatus: number | null = null;
  if (input.exam && examAnswerMarker) {
    const denial = await reopened.request.get(input.baseURL + "/api/exams/" + input.exam.sessionId, {
      failOnStatusCode: false,
    });
    examOwnerDenialStatus = denial.status();
    assert([401, 403].includes(examOwnerDenialStatus), "Anonymous exam request did not enforce owner-bound denial.");
    const denialBody = await denial.text();
    assert(!denialBody.includes(examAnswerMarker), "Anonymous exam denial exposed the local-only answer marker.");
  }
  const screenshot = path.join(input.profile.artifactDirectory, "purge-after-reopen.png");
  await reopenedPage.screenshot({ path: screenshot, fullPage: true });
  const draftDatabaseAfterReopen = await assertLocalOnlyDraftAbsent({
    learnerId: input.learnerId,
    marker: draftMarker,
    requestId: draftIdentity.body.requestId,
  });
  let examDatabaseAfterReopen: Record<string, number> | null = null;
  if (input.exam && examAnswerMarker && examAnswerIdentity && examEventIdentity) {
    examDatabaseAfterReopen = await assertLocalOnlyExamAbsent({
      attemptId: input.exam.attemptId,
      sessionId: input.exam.sessionId,
      itemId: input.exam.itemId,
      answer: examAnswerMarker,
      clientMutationId: examAnswerIdentity.body.clientMutationId,
      clientEventId: examEventIdentity.body.clientEventId,
    });
  }
  await reopened.unrouteAll({ behavior: "wait" });
  await reopenedPage.close();
  return {
    status: "passed",
    localAckObserved: true,
    draftRequestIdHash: sha256(draftIdentity.body.requestId),
    draftBodyHash: draftIdentity.bodyHash,
    examMutationIdHash: examAnswerIdentity ? sha256(examAnswerIdentity.body.clientMutationId) : null,
    examAnswerBodyHash: examAnswerIdentity?.bodyHash ?? null,
    examEventIdHash: examEventIdentity ? sha256(examEventIdentity.body.clientEventId) : null,
    examEventBodyHash: examEventIdentity?.bodyHash ?? null,
    noUpstreamAbortCounts: {
      draft: draftAbortCount,
      examAnswer: examAnswerAbortCount,
      examEvent: examEventAbortCount,
    },
    databaseBeforeLogout: { draft: draftDatabaseBeforeLogout, exam: examDatabaseBeforeLogout },
    databaseAfterReopen: { draft: draftDatabaseAfterReopen, exam: examDatabaseAfterReopen },
    counts: { beforeSignOut, afterSignOut, afterReopen },
    serverSignOutStatus: authoritativeSignOut.status(),
    protectedPlaygroundPath: new URL(reopenedPage.url()).pathname,
    examOwnerDenialStatus,
    processTransition,
    screenshot: path.relative(repoRoot, screenshot).replaceAll("\\", "/"),
  };
}

async function verifyProfileLanding(page: Page, input: {
  profileName: string;
  viewport: { width: number; height: number };
  artifactDirectory: string;
}) {
  const actualViewport = page.viewportSize();
  assert(actualViewport, input.profileName + " profile did not expose its configured viewport.");
  assert(
    actualViewport.width === input.viewport.width && actualViewport.height === input.viewport.height,
    input.profileName + " profile changed the locked device viewport.",
  );
  const screenshot = path.join(input.artifactDirectory, "landing.png");
  const runtimeErrors: string[] = [];
  page.on("pageerror", (error) => runtimeErrors.push(error.message.slice(0, 1_000)));
  page.on("console", (message) => {
    if (message.type() === "error") runtimeErrors.push(message.text().slice(0, 1_000));
  });
  const navigationResponse = await page.goto("/learn", { waitUntil: "networkidle" });
  await page.screenshot({ path: screenshot, fullPage: true });

  assert(new URL(page.url()).pathname === "/learn", `Expected /learn, received ${new URL(page.url()).pathname}.`);
  try {
    await page.getByRole("heading", { name: /Welcome back, Synthetic/i }).waitFor();
  } catch (error) {
    const diagnostics = await page.evaluate(() => ({
      title: document.title,
      bodyText: document.body?.innerText.slice(0, 4_000) ?? "",
      htmlPrefix: document.documentElement.outerHTML.slice(0, 4_000),
      readyState: document.readyState,
      userAgent: navigator.userAgent,
    }));
    const diagnosticFile = path.join(input.artifactDirectory, "landing-diagnostic.json");
    await writeFile(diagnosticFile, JSON.stringify({
      profile: input.profileName,
      url: page.url(),
      navigationStatus: navigationResponse?.status() ?? null,
      runtimeErrors,
      ...diagnostics,
    }, null, 2) + "\n", "utf8");
    throw new Error(
      input.profileName + " authenticated landing did not render; diagnostics: "
      + path.relative(repoRoot, diagnosticFile).replaceAll("\\", "/") + ". "
      + (error instanceof Error ? error.message : String(error)),
    );
  }
  await page.getByRole("heading", { name: "Your selected courses are awaiting publication." }).waitFor();
  await page.getByRole("heading", { name: "Selected courses are awaiting publication", exact: true }).waitFor();
  await page.getByRole("heading", { name: "Selected curriculum previews" }).waitFor();
  await page.getByRole("heading", { name: "Python: Beginner to Intermediate", exact: true }).waitFor();

  const roadmap = page.locator('[data-roadmap-state="awaiting_publication"]');
  await roadmap.waitFor();
  assert(await roadmap.count() === 1, "Expected exactly one awaiting-publication roadmap state.");
  assert(!await page.getByText("Aarav Rao", { exact: true }).count(), "Demo learner data appeared in auth-required mode.");

  const geometry = await page.evaluate(() => {
    const root = document.documentElement;
    const roadmapElement = document.querySelector<HTMLElement>('[data-roadmap-state="awaiting_publication"]');
    if (!roadmapElement) throw new Error("Roadmap state was not rendered.");
    const box = roadmapElement.getBoundingClientRect();
    return {
      documentWidth: root.scrollWidth,
      viewportWidth: root.clientWidth,
      roadmapLeft: box.left,
      roadmapRight: box.right,
    };
  });
  assert(
    geometry.documentWidth <= geometry.viewportWidth + 1,
    `${input.profileName} document overflowed by ${geometry.documentWidth - geometry.viewportWidth}px.`,
  );
  assert(geometry.roadmapLeft >= -1, `${input.profileName} roadmap escaped the left viewport edge.`);
  assert(geometry.roadmapRight <= geometry.viewportWidth + 1, `${input.profileName} roadmap escaped the right viewport edge.`);

  const controls = roadmap.locator("a[href], button:not(:disabled)");
  const controlCount = await controls.count();
  assert(controlCount > 0, `${input.profileName} roadmap exposed no actionable control.`);
  const controlSizes: Array<{ label: string; width: number; height: number }> = [];
  for (let index = 0; index < controlCount; index += 1) {
    const control = controls.nth(index);
    if (!await control.isVisible()) continue;
    const box = await control.boundingBox();
    const label = (await control.getAttribute("aria-label")) ?? (await control.textContent())?.trim() ?? "control";
    assert(box, `${input.profileName} action ${label} has no measurable box.`);
    controlSizes.push({ label: label.slice(0, 80), width: box.width, height: box.height });
    assert(box.width >= 44, `${input.profileName} action ${label} is only ${box.width}px wide.`);
    assert(box.height >= 44, `${input.profileName} action ${label} is only ${box.height}px tall.`);
  }
  assert(controlSizes.length > 0, `${input.profileName} roadmap exposed no visible actionable control.`);

  const accessibility = await new AxeBuilder({ page })
    .include('[data-roadmap-state="awaiting_publication"]')
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  assert(
    accessibility.violations.length === 0,
    `${input.profileName} roadmap has Axe violations: ${accessibility.violations.map((item) => item.id).join(", ")}`,
  );

  await page.screenshot({ path: screenshot, fullPage: true });
  return {
    viewport: actualViewport,
    screenshot: path.relative(repoRoot, screenshot).replaceAll("\\", "/"),
    controls: controlSizes,
    axeViolations: 0,
    overflowPixels: Math.max(0, geometry.documentWidth - geometry.viewportWidth),
  };
}
async function main() {
  await mkdir(artifactDir, { recursive: true });
  // A stable, predeclared dist directory prevents Next from appending a new
  // random generated-types path to tsconfig.json after every verification.
  // It is always rebuilt from an empty local cache and removed in cleanup.
  await rm(distDir, { recursive: true, force: true });
  const dockerCheck = spawnSync(docker, ["version", "--format", "{{.Server.Version}}"], {
    encoding: "utf8",
    env: commandEnvironment(),
    windowsHide: true,
  });
  if (dockerCheck.status !== 0) {
    throw new Error("Docker is required for the disposable authenticated UI verification, but its daemon is unavailable.");
  }

  const databasePort = await availablePort();
  let applicationPort = await availablePort();
  while (applicationPort === databasePort) applicationPort = await availablePort();
  let upstreamApplicationPort = await availablePort();
  while ([databasePort, applicationPort].includes(upstreamApplicationPort)) upstreamApplicationPort = await availablePort();
  const databasePassword = randomBytes(24).toString("base64url");
  const authSecret = randomBytes(48).toString("base64url");
  const isolatedKey = randomBytes(48).toString("base64url");
  const credentialMasterKey = randomBytes(32).toString("base64");
  const syntheticPassword = randomBytes(24).toString("base64url");
  const databaseURL = `postgresql://learncoding_ui:${databasePassword}@127.0.0.1:${databasePort}/learncoding_integration`;
  const baseURL = `https://127.0.0.1:${applicationPort}`;
  const upstreamApplicationURL = `http://127.0.0.1:${upstreamApplicationPort}`;
  const sensitiveValues = [
    databasePassword,
    authSecret,
    isolatedKey,
    credentialMasterKey,
    syntheticPassword,
    databaseURL,
  ];
  const commonEnvironment = commandEnvironment({
    ANTHROPIC_API_KEY: "",
    APP_NAME: "Codestead Synthetic Runtime",
    APP_URL: baseURL,
    AUTH_REQUIRED: "true",
    BETTER_AUTH_SECRET: authSecret,
    BOOTSTRAP_ADMIN_EMAIL: "",
    BOOTSTRAP_ADMIN_NAME: "Synthetic Runtime Administrator",
    BOOTSTRAP_ADMIN_PASSWORD: "",
    CLAMD_HOST: "127.0.0.1",
    CLAMD_PORT: "1",
    CREDENTIAL_MASTER_KEY: credentialMasterKey,
    CUSTOM_OPENAI_ALLOWED_HOSTS: "",
    CUSTOM_OPENAI_BASE_URL: "",
    DATABASE_POOL_SIZE: "8",
    DATABASE_URL: databaseURL,
    DEEPSEEK_API_KEY: "",
    DELETION_TOMBSTONE_KEY: isolatedKey,
    GEMINI_API_KEY: "",
    GITHUB_TOKEN: "",
    GMAIL_CLIENT_ID: "",
    GMAIL_CLIENT_SECRET: "",
    GMAIL_REFRESH_TOKEN: "",
    GOOGLE_API_KEY: "",
    GOOGLE_CLIENT_ID: "",
    GOOGLE_CLIENT_SECRET: "",
    GOOGLE_DRIVE_CLIENT_ID: "",
    GOOGLE_DRIVE_CLIENT_SECRET: "",
    GOOGLE_DRIVE_FOLDER_ID: "",
    GOOGLE_DRIVE_REFRESH_TOKEN: "",
    GROQ_API_KEY: "",
    INTEGRATION_TEST: "1",
    LEARNCODING_NEXT_DIST_DIR: distDirName,
    LOG_LEVEL: "error",
    LOST_DEVICE_PROOF_KEY: isolatedKey,
    MAIL_ADAPTER: "console",
    MAIL_FROM: "Codestead Synthetic Runtime <noreply@example.invalid>",
    NEXT_PUBLIC_APP_URL: baseURL,
    NEXT_TELEMETRY_DISABLED: "1",
    NVIDIA_API_KEY: "",
    NVIDIA_NIM_API_KEY: "",
    OBJECT_STORAGE_PATH: objectStorageDir,
    OPENAI_API_KEY: "",
    OPENROUTER_API_KEY: "",
    RATE_LIMIT_HASH_KEY: isolatedKey,
    RATE_LIMIT_OVERRIDES_JSON: "",
    RATE_LIMIT_TRUSTED_IP_HEADER: "",
    RUNNER_BASE_URL: "http://127.0.0.1:1",
    RUNNER_MAX_CONCURRENCY: "1",
    RUNNER_SHARED_SECRET: isolatedKey,
    SENTRY_DSN: "",
    SOURCE_CODE_URL: "",
  });

  const image = process.env.INTEGRATION_POSTGRES_IMAGE
    ?? "postgres:17-alpine@sha256:742f40ea20b9ff2ff31db5458d127452988a2164df9e17441e191f3b72252193";
  const started = spawnSync(docker, [
    "run",
    "--detach",
    "--rm",
    "--name",
    containerName,
    "--label",
    "com.learncoding.purpose=disposable-authenticated-ui-test",
    "--publish",
    `127.0.0.1:${databasePort}:5432`,
    "--tmpfs",
    "/var/lib/postgresql/data:rw,nosuid,nodev,size=512m",
    "--env",
    "POSTGRES_DB=learncoding_integration",
    "--env",
    "POSTGRES_USER=learncoding_ui",
    "--env",
    "POSTGRES_PASSWORD",
    image,
  ], {
    encoding: "utf8",
    env: { ...commandEnvironment(), POSTGRES_PASSWORD: databasePassword },
    windowsHide: true,
  });
  if (started.status !== 0) throw new Error("The disposable PostgreSQL container could not be started.");
  containerStarted = true;
  await waitForPostgres(databaseURL);
  await runCommand({
    command: npmCli ? process.execPath : npm,
    args: npmCli ? [npmCli, "run", "db:migrate"] : ["run", "db:migrate"],
    env: { ...commonEnvironment, NODE_ENV: "test" },
    sensitiveValues,
  });

  Object.assign(process.env, {
    BETTER_AUTH_SECRET: authSecret,
    DATABASE_POOL_SIZE: "4",
    DATABASE_URL: databaseURL,
    INTEGRATION_TEST: "1",
    NODE_ENV: "test",
  });
  const [{ db, pool }, schema] = await Promise.all([
    import("../src/lib/db/client"),
    import("../src/lib/db/schema"),
  ]);
  appPool = pool;


  await runCommand({
    command: npmCli ? process.execPath : npm,
    args: npmCli ? [npmCli, "run", "build"] : ["run", "build"],
    env: { ...commonEnvironment, NODE_ENV: "production" },
    sensitiveValues,
  });

  appProcess = spawn(process.execPath, [
    path.join(repoRoot, "node_modules", "next", "dist", "bin", "next"),
    "start",
    "--hostname",
    "127.0.0.1",
    "--port",
    String(upstreamApplicationPort),
  ], {
    cwd: repoRoot,
    detached: process.platform !== "win32",
    env: { ...commonEnvironment, NODE_ENV: "production" },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const appOutput = collectOutput(appProcess, sensitiveValues);
  await waitForApplication(upstreamApplicationURL, appOutput);
  httpsProxy = await startHttpsLoopbackProxy({ port: applicationPort, targetPort: upstreamApplicationPort });

  const requestedProfiles = selectedProfiles();
  const selectedProfileNames = requestedProfiles.map((profile) => profile.name);
  const profileResults: Array<Record<string, unknown>> = [];
  const passwordHash = await hashPassword(syntheticPassword);

  const provenance = runProvenance();
  for (const definition of requestedProfiles) {
    const profileStartedAt = new Date();
    const profileArtifactDirectory = path.join(artifactDir, "profiles", definition.name);
    await mkdir(profileArtifactDirectory, { recursive: true });
    const learnerId = `synthetic-runtime-${definition.name}-${randomUUID()}`;
    const email = `synthetic-runtime-${definition.name}-${suffix}@example.invalid`;
    await db.insert(schema.user).values({
      id: learnerId,
      name: `Synthetic ${definition.name} Learner`,
      email,
      emailVerified: true,
      status: "active",
      mustChangePassword: false,
      adultConfirmedAt: new Date(),
    });
    await db.insert(schema.learnerProfile).values({
      userId: learnerId,
      selectedTracks: ["python"],
      onboardingStep: "complete",
      onboardingCompletedAt: new Date(),
    });
    await db.insert(schema.account).values({
      id: `synthetic-credential-${randomUUID()}`,
      accountId: learnerId,
      providerId: "credential",
      userId: learnerId,
      password: passwordHash,
    });

    const descriptor = devices[definition.deviceName];
    assert(descriptor, "Playwright device descriptor is unavailable: " + definition.deviceName + ".");
    const { defaultBrowserType, ...deviceOptions } = descriptor;
    assert(
      defaultBrowserType === definition.browserTypeName,
      definition.deviceName + " changed its locked browser type.",
    );
    assert(deviceOptions.viewport, definition.deviceName + " did not expose a locked viewport.");
    const profile = new KillablePersistentProfile(
      definition.name,
      browserTypeFor(definition.browserTypeName),
      baseURL,
      path.join(profileTempRoot, definition.name),
      profileArtifactDirectory,
      { ...deviceOptions, ignoreHTTPSErrors: true },
    );
    await profile.open();
    try {
      let context = profile.getContext();
      const browserVersionBefore = profile.getBrowserVersion();
      await signInSyntheticContext(context, {
        baseURL,
        email,
        password: syntheticPassword,
      });
      const [activeSession] = await db
        .select({ id: schema.session.id })
        .from(schema.session)
        .where(eq(schema.session.userId, learnerId))
        .limit(1);
      assert(activeSession, definition.name + " sign-in did not create an active session.");
      await db.transaction(async (transaction) => {
        await transaction
          .update(schema.user)
          .set({ twoFactorEnabled: true })
          .where(eq(schema.user.id, learnerId));
        await transaction
          .update(schema.session)
          .set({ mfaVerifiedAt: new Date() })
          .where(eq(schema.session.id, activeSession.id));
      });
      await profile.checkpointAuthenticationAndReopen();
      context = profile.getContext();
      const durableSessionCookies = await context.cookies();
      assert(durableSessionCookies.length > 0, definition.name + " did not restore its durable authentication cookie.");

      const landingPage = await context.newPage();
      const landing = await verifyProfileLanding(landingPage, {
        profileName: definition.name,
        viewport: deviceOptions.viewport,
        artifactDirectory: profileArtifactDirectory,
      });
      await landingPage.close();
      const draft = await runPersistentDraftCrash({
        baseURL,
        profile,
        learnerId,
      });
      let examEvidence: Record<string, unknown>;
      let exam: SyntheticExam | undefined;
      if (definition.examApplicable) {
        exam = {
          attemptId: randomUUID(),
          sessionId: randomUUID(),
          itemId: "synthetic-short-answer",
        };
        const generatedAt = new Date();
        const deadline = new Date(generatedAt.getTime() + (2 * 60 * 60 * 1_000));
        const form: ExamFormSnapshot = {
          schemaVersion: 1,
          purpose: "formal-exam",
          formId: "synthetic-form-" + randomUUID(),
          seed: "synthetic-seed-" + suffix + "-" + definition.name,
          courseId: "synthetic-browser-durability",
          courseTitle: "Synthetic Browser Durability",
          moduleId: "synthetic-response-loss",
          moduleTitle: "Response-loss recovery",
          contentVersion: "synthetic-v1",
          policyVersion: EXAM_POLICY_VERSION,
          durationMinutes: 120,
          generatedAt: generatedAt.toISOString(),
          instructions: ["Synthetic internal browser recovery verification."],
          integrityDisclosure: {
            version: "synthetic-v1",
            summary: "Synthetic integrity events are recorded for this internal verifier.",
            capturedEvents: ["window blur"],
            notCaptured: ["screen contents"],
          },
          items: [{
            id: exam.itemId,
            skillId: "synthetic.browser-durability",
            clusterId: "synthetic-response-loss",
            title: "Synthetic recovery response",
            prompt: "Enter the synthetic browser-recovery marker.",
            kind: "short-answer",
            points: 1,
            critical: false,
            gradingEvidence: {
              kind: "pending-review",
              reason: "Synthetic response-loss verification is not learner assessment evidence.",
            },
          }],
        };
        await db.insert(schema.attempt).values({
          id: exam.attemptId,
          userId: learnerId,
          kind: "exam",
          status: "in_progress",
          policyVersion: EXAM_POLICY_VERSION,
          contentVersion: "synthetic-v1",
          startedAt: generatedAt,
        });
        await db.insert(schema.examSession).values({
          id: exam.sessionId,
          attemptId: exam.attemptId,
          userId: learnerId,
          status: "active",
          serverStartedAt: generatedAt,
          serverDeadlineAt: deadline,
          lastHeartbeatAt: generatedAt,
        });
        await db.insert(schema.response).values({
          attemptId: exam.attemptId,
          itemKey: BLUEPRINT_RESPONSE_KEY,
          revision: 1,
          answer: { snapshot: form } as unknown as Record<string, unknown>,
          source: "server",
          savedAt: generatedAt,
        });
        const answer = await runExamAnswerCrash({
          baseURL,
          profile,
          exam,
        });
        const event = await runExamEventCrash({
          profile,
          exam,
        });
        examEvidence = {
          applicable: true,
          status: "passed",
          sessionIdHash: sha256(exam.sessionId),
          answer,
          event,
        };
      } else {
        examEvidence = {
          applicable: false,
          status: "not-applicable",
          reason: "Formal programming exams are intentionally blocked below tablet width.",
        };
      }
      const purge = await runSignOutPurge({
        baseURL,
        profile,
        learnerId,
        ...(exam ? { exam } : {}),
      });
      const browserVersionAfter = profile.getBrowserVersion();
      assert(browserVersionAfter === browserVersionBefore, definition.name + " browser version changed across relaunch.");
      const profileFinishedAt = new Date();
      const profileResult = {
        schemaVersion: 1,
        mode: "production-auth-required-disposable-synthetic",
        ...provenance,
        startedAt: profileStartedAt.toISOString(),
        finishedAt: profileFinishedAt.toISOString(),
        durationMs: profileFinishedAt.getTime() - profileStartedAt.getTime(),
        selectedProfileFilter: process.env.BROWSER_DURABILITY_PROFILES?.trim() || null,
        profile: definition.name,
        browserType: definition.browserTypeName,
        browserVersion: browserVersionAfter,
        device: definition.deviceName,
        viewport: deviceOptions.viewport,
        exam: examEvidence,
        landing,
        draft,
        purge,
      } as const;
      await writeFile(
        path.join(profileArtifactDirectory, "summary.json"),
        `${JSON.stringify(profileResult, null, 2)}\n`,
        "utf8",
      );
      profileResults.push(profileResult);
    } finally {
      await profile.close();
    }
  }

  const cleanupResults = await cleanup();
  assert(!Object.values(cleanupResults).includes("failed"), "Verifier cleanup did not remove every owned resource.");
  const finishedAt = new Date();
  const result = {
    schemaVersion: 1,
    status: "passed",
    mode: "production-auth-required-disposable-synthetic",
    selectedProfileFilter: process.env.BROWSER_DURABILITY_PROFILES?.trim() || null,
    selectedProfiles: selectedProfileNames,
    fullMatrix: selectedProfileNames.length === profileDefinitions.length,
    startedAt,
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - Date.parse(startedAt),
    ...provenance,
    cleanup: cleanupResults,
    claimBoundary: "Controlled Playwright browser process kill/relaunch against the same temporary profile while the application and PostgreSQL stayed online. This is not host power-loss evidence and did not exercise the NUC startup chain.",
    profiles: profileResults,
  } as const;
  await writeFile(path.join(artifactDir, "result.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");
  console.info(JSON.stringify({
    event: "authenticated_learn_runtime.passed",
    artifactDirectory: path.relative(repoRoot, artifactDir).replaceAll("\\", "/"),
    selectedProfiles: selectedProfileNames,
    fullMatrix: result.fullMatrix,
  }));
}

process.once("SIGINT", () => {
  void cleanup().finally(() => process.exit(130));
});
process.once("SIGTERM", () => {
  void cleanup().finally(() => process.exit(143));
});

main()
  .catch(async (error) => {
    const message = error instanceof Error ? error.message : String(error);
    const cleanupResults = await cleanup();
    const finishedAt = new Date();
    let provenance: Record<string, unknown> = {};
    try {
      provenance = runProvenance();
    } catch {
      // Failure evidence remains useful even if repository provenance is unavailable.
    }
    await mkdir(artifactDir, { recursive: true });
    await writeFile(path.join(artifactDir, "result.json"), `${JSON.stringify({
      schemaVersion: 1,
      status: "failed",
      mode: "production-auth-required-disposable-synthetic",
      selectedProfileFilter: process.env.BROWSER_DURABILITY_PROFILES?.trim() || null,
      startedAt,
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt.getTime() - Date.parse(startedAt),
      ...provenance,
      claimBoundary: "Controlled Playwright browser process kill/relaunch against the same temporary profile while the application and PostgreSQL stayed online. This is not host power-loss evidence and did not exercise the NUC startup chain.",
      cleanup: cleanupResults,
      error: message.slice(0, 2_000),
    }, null, 2)}\n`, "utf8");
    console.error(JSON.stringify({ event: "authenticated_learn_runtime.failed", error: message.slice(0, 500) }));
    process.exitCode = 1;
  })
  .finally(cleanup);
