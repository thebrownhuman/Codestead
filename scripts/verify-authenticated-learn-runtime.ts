import { randomBytes, randomUUID } from "node:crypto";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";

import AxeBuilder from "@axe-core/playwright";
import { chromium, type Browser, type Page } from "@playwright/test";
import { hashPassword } from "better-auth/crypto";
import { eq } from "drizzle-orm";
import pg from "pg";

const { Client } = pg;
const repoRoot = process.cwd();
const docker = process.platform === "win32" ? "docker.exe" : "docker";
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const npmCli = process.env.npm_execpath;
const runId = new Date().toISOString().replace(/[:.]/g, "-");
const suffix = randomBytes(6).toString("hex");
const containerName = `learncoding-auth-ui-${suffix}`;
const distDirName = ".next-e2e-auth-runtime";
const distDir = path.join(repoRoot, distDirName);
const objectStorageDir = path.join(repoRoot, `.tmp-auth-runtime-objects-${suffix}`);
const artifactDir = path.join(repoRoot, "test-artifacts", "authenticated-learn-runtime", runId);

let appProcess: ChildProcess | null = null;
let browser: Browser | null = null;
let appPool: { end(): Promise<void> } | null = null;
let containerStarted = false;
let cleanupPromise: Promise<void> | null = null;

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

function cleanup() {
  if (cleanupPromise) return cleanupPromise;
  cleanupPromise = (async () => {
    await browser?.close().catch(() => undefined);
    browser = null;
    await stopProcessTree(appProcess);
    appProcess = null;
    await appPool?.end().catch(() => undefined);
    appPool = null;
    if (containerStarted) {
      spawnSync(docker, ["rm", "--force", containerName], {
        stdio: "ignore",
        windowsHide: true,
      });
      containerStarted = false;
    }
    await rm(distDir, { recursive: true, force: true }).catch(() => undefined);
    await rm(objectStorageDir, { recursive: true, force: true }).catch(() => undefined);
  })();
  return cleanupPromise;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function verifyViewport(page: Page, input: {
  name: "desktop" | "mobile-375";
  width: number;
  height: number;
}) {
  await page.setViewportSize({ width: input.width, height: input.height });
  await page.goto("/learn", { waitUntil: "networkidle" });

  assert(new URL(page.url()).pathname === "/learn", `Expected /learn, received ${new URL(page.url()).pathname}.`);
  await page.getByRole("heading", { name: /Welcome back, Synthetic/i }).waitFor();
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
    `${input.name} document overflowed by ${geometry.documentWidth - geometry.viewportWidth}px.`,
  );
  assert(geometry.roadmapLeft >= -1, `${input.name} roadmap escaped the left viewport edge.`);
  assert(geometry.roadmapRight <= geometry.viewportWidth + 1, `${input.name} roadmap escaped the right viewport edge.`);

  const controls = roadmap.locator("a[href], button:not(:disabled)");
  const controlCount = await controls.count();
  assert(controlCount > 0, `${input.name} roadmap exposed no actionable control.`);
  const controlSizes: Array<{ label: string; width: number; height: number }> = [];
  for (let index = 0; index < controlCount; index += 1) {
    const control = controls.nth(index);
    if (!await control.isVisible()) continue;
    const box = await control.boundingBox();
    const label = (await control.getAttribute("aria-label")) ?? (await control.textContent())?.trim() ?? "control";
    assert(box, `${input.name} action ${label} has no measurable box.`);
    controlSizes.push({ label: label.slice(0, 80), width: box.width, height: box.height });
    assert(box.width >= 44, `${input.name} action ${label} is only ${box.width}px wide.`);
    assert(box.height >= 44, `${input.name} action ${label} is only ${box.height}px tall.`);
  }
  assert(controlSizes.length > 0, `${input.name} roadmap exposed no visible actionable control.`);

  const accessibility = await new AxeBuilder({ page })
    .include('[data-roadmap-state="awaiting_publication"]')
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  assert(
    accessibility.violations.length === 0,
    `${input.name} roadmap has Axe violations: ${accessibility.violations.map((item) => item.id).join(", ")}`,
  );

  const screenshot = path.join(artifactDir, `${input.name}.png`);
  await page.screenshot({ path: screenshot, fullPage: true });
  return {
    viewport: { width: input.width, height: input.height },
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
  const databasePassword = randomBytes(24).toString("base64url");
  const authSecret = randomBytes(48).toString("base64url");
  const isolatedKey = randomBytes(48).toString("base64url");
  const credentialMasterKey = randomBytes(32).toString("base64");
  const syntheticPassword = randomBytes(24).toString("base64url");
  const databaseURL = `postgresql://learncoding_ui:${databasePassword}@127.0.0.1:${databasePort}/learncoding_integration`;
  const baseURL = `http://127.0.0.1:${applicationPort}`;
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
  const learnerId = `synthetic-runtime-${randomUUID()}`;
  const email = `synthetic-runtime-${suffix}@example.invalid`;
  await db.insert(schema.user).values({
    id: learnerId,
    name: "Synthetic Runtime Learner",
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
    password: await hashPassword(syntheticPassword),
  });

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
    String(applicationPort),
  ], {
    cwd: repoRoot,
    detached: process.platform !== "win32",
    env: { ...commonEnvironment, NODE_ENV: "production" },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const appOutput = collectOutput(appProcess, sensitiveValues);
  await waitForApplication(baseURL, appOutput);

  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ baseURL });
  const signIn = await context.request.post(`${baseURL}/api/auth/sign-in/email`, {
    data: { email, password: syntheticPassword, rememberMe: false },
    headers: { origin: baseURL, "user-agent": "Codestead synthetic authenticated UI verification" },
  });
  assert(signIn.ok(), `Synthetic sign-in failed with HTTP ${signIn.status()}.`);
  const [activeSession] = await db
    .select({ id: schema.session.id })
    .from(schema.session)
    .where(eq(schema.session.userId, learnerId))
    .limit(1);
  assert(activeSession, "Synthetic sign-in did not create an active session.");
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

  const page = await context.newPage();
  const desktop = await verifyViewport(page, { name: "desktop", width: 1440, height: 1000 });
  const mobile = await verifyViewport(page, { name: "mobile-375", width: 375, height: 812 });
  await context.close();

  const result = {
    status: "passed",
    mode: "auth-required-disposable-synthetic",
    route: "/learn",
    roadmapState: "awaiting_publication",
    checks: { desktop, mobile },
  } as const;
  await writeFile(path.join(artifactDir, "result.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");
  console.info(JSON.stringify({
    event: "authenticated_learn_runtime.passed",
    artifactDirectory: path.relative(repoRoot, artifactDir).replaceAll("\\", "/"),
    viewports: 2,
    axeViolations: 0,
    overflowFailures: 0,
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
    await mkdir(artifactDir, { recursive: true });
    await writeFile(path.join(artifactDir, "result.json"), `${JSON.stringify({
      status: "failed",
      error: message.slice(0, 2_000),
    }, null, 2)}\n`, "utf8");
    console.error(JSON.stringify({ event: "authenticated_learn_runtime.failed", error: message.slice(0, 500) }));
    process.exitCode = 1;
  })
  .finally(cleanup);
