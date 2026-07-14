import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RUNNER_IMAGE_KEYS = [
  "RUNNER_IMAGE_C",
  "RUNNER_IMAGE_CPP",
  "RUNNER_IMAGE_JAVA",
  "RUNNER_IMAGE_PYTHON",
  "RUNNER_IMAGE_JAVASCRIPT",
] as const;

const RUNNER_OPTION_KEYS = [
  "RUNNER_PORT",
  "RUNNER_MAX_CONCURRENCY",
  "RUNNER_MAX_QUEUE_DEPTH",
  "RUNNER_AUTH_MAX_SKEW_SECONDS",
  "RUNNER_NONCE_TTL_SECONDS",
  "RUNNER_IDEMPOTENCY_TTL_SECONDS",
  "RUNNER_IDEMPOTENCY_CAPACITY",
  "RUNNER_MAX_BODY_BYTES",
  "RUNNER_MAX_SOURCE_BYTES",
  "RUNNER_MAX_SOURCE_FILES",
  "RUNNER_MAX_TESTS",
  "RUNNER_DOCKER_BINARY",
] as const;

const HOST_ENV_KEYS = [
  "PATH",
  "SystemRoot",
  "WINDIR",
  "ComSpec",
  "PATHEXT",
  "TEMP",
  "TMP",
  "HOME",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "LANG",
  "LC_ALL",
  "DOCKER_HOST",
  "DOCKER_CONTEXT",
  "DOCKER_CONFIG",
  "DOCKER_TLS_VERIFY",
  "DOCKER_CERT_PATH",
] as const;

const OWNER_FILE = ".runner-local-owner";
const PROCESS_LOCK_FILE = ".runner-process.lock";
const LOOPBACK_HOST = "127.0.0.1";

type ParsedEnvironment = Record<string, string>;

export interface LocalRunnerOwnership {
  readonly lockFd: number;
  readonly release: () => void;
}

function decodeQuotedValue(value: string): string {
  if (value.length < 2) return value;
  const quote = value[0];
  if ((quote !== "\"" && quote !== "'") || value.at(-1) !== quote) return value;
  const inner = value.slice(1, -1);
  if (quote === "'") return inner;
  return inner.replace(/\\(n|r|t|"|\\)/g, (_match, escaped: string) => {
    switch (escaped) {
      case "n": return "\n";
      case "r": return "\r";
      case "t": return "\t";
      case "\"": return "\"";
      default: return "\\";
    }
  });
}

export function parseEnvText(content: string): ParsedEnvironment {
  const parsed: ParsedEnvironment = {};
  for (const [index, rawLine] of content.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const normalized = line.startsWith("export ") ? line.slice(7).trimStart() : line;
    const separator = normalized.indexOf("=");
    if (separator < 1) throw new Error(`Invalid environment assignment on line ${index + 1}.`);
    const name = normalized.slice(0, separator).trim();
    if (!/^[A-Z_][A-Z0-9_]*$/i.test(name)) {
      throw new Error(`Invalid environment name on line ${index + 1}.`);
    }
    parsed[name] = decodeQuotedValue(normalized.slice(separator + 1).trim());
  }
  return parsed;
}

function readEnvironmentFile(file: string): ParsedEnvironment {
  if (!existsSync(file)) return {};
  return parseEnvText(readFileSync(file, "utf8"));
}

function copyIfPresent(
  target: NodeJS.ProcessEnv,
  source: NodeJS.ProcessEnv | ParsedEnvironment,
  key: string,
): void {
  const value = source[key];
  if (value !== undefined && value !== "") target[key] = value;
}

export function buildLocalRunnerEnvironment(input: {
  inheritedEnv: NodeJS.ProcessEnv;
  rootEnv: ParsedEnvironment;
  imageEnv: ParsedEnvironment;
  stateRoot: string;
  tempRoot: string;
  lockFd: number;
}): NodeJS.ProcessEnv {
  const childEnv: NodeJS.ProcessEnv = {};
  for (const key of HOST_ENV_KEYS) copyIfPresent(childEnv, input.inheritedEnv, key);
  // Windows commonly exposes this entry as `Path`; normalize it without
  // copying the rest of the parent environment into the isolated service.
  if (!childEnv.PATH && input.inheritedEnv.Path) childEnv.PATH = input.inheritedEnv.Path;

  const secret = input.inheritedEnv.RUNNER_SHARED_SECRET
    ?? input.rootEnv.RUNNER_SHARED_SECRET;
  if (!secret || Buffer.byteLength(secret, "utf8") < 32) {
    throw new Error("Runner shared secret (RUNNER_SHARED_SECRET) must be set in the root .env and contain at least 32 bytes.");
  }
  childEnv.RUNNER_SHARED_SECRET = secret;
  childEnv.RUNNER_HOST = LOOPBACK_HOST;
  childEnv.RUNNER_STATE_ROOT = input.stateRoot;
  childEnv.RUNNER_TEMP_ROOT = input.tempRoot;
  childEnv.RUNNER_PROCESS_LOCK_HELD = "1";
  childEnv.RUNNER_PROCESS_LOCK_FD = String(input.lockFd);

  for (const key of RUNNER_OPTION_KEYS) {
    const value = input.inheritedEnv[key] ?? input.rootEnv[key];
    if (value !== undefined && value !== "") childEnv[key] = value;
  }
  childEnv.RUNNER_MAX_CONCURRENCY ??= "2";
  childEnv.RUNNER_PORT ??= "4100";

  for (const key of RUNNER_IMAGE_KEYS) {
    const value = input.inheritedEnv[key] ?? input.imageEnv[key];
    if (!value) throw new Error(`${key} is missing from dist/runtime-images.env.`);
    childEnv[key] = value;
  }
  return childEnv;
}

function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function assertSafeRegularFile(file: string): void {
  if (!existsSync(file)) return;
  const stats = lstatSync(file);
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error(`Unsafe local runner path: ${file}`);
  }
}

export function acquireLocalRunnerOwnership(stateRoot: string): LocalRunnerOwnership {
  mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") chmodSync(stateRoot, 0o700);
  const ownerPath = path.join(stateRoot, OWNER_FILE);
  const lockPath = path.join(stateRoot, PROCESS_LOCK_FILE);
  assertSafeRegularFile(ownerPath);
  assertSafeRegularFile(lockPath);

  if (existsSync(ownerPath)) {
    let ownerPid = 0;
    try {
      const owner = JSON.parse(readFileSync(ownerPath, "utf8")) as { pid?: unknown };
      ownerPid = typeof owner.pid === "number" ? owner.pid : 0;
    } catch {
      ownerPid = 0;
    }
    if (processIsAlive(ownerPid)) {
      throw new Error(`A local runner launcher is already active (PID ${ownerPid}).`);
    }
    rmSync(ownerPath, { force: true });
  }

  writeFileSync(ownerPath, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  let lockFd: number | null = null;
  let released = false;
  try {
    lockFd = openSync(lockPath, "a+", 0o600);
    if (process.platform !== "win32") chmodSync(lockPath, 0o600);
  } catch (error) {
    rmSync(ownerPath, { force: true });
    throw error;
  }
  const release = () => {
    if (released) return;
    released = true;
    if (lockFd !== null) closeSync(lockFd);
    rmSync(ownerPath, { force: true });
  };
  return { lockFd, release };
}

function checkedDocker(
  dockerBinary: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): string {
  const result = spawnSync(dockerBinary, args, {
    encoding: "utf8",
    env,
    shell: false,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    const detail = result.error?.message ?? result.stderr.trim() ?? `exit ${result.status ?? "unknown"}`;
    throw new Error(`Docker readiness check failed: ${detail}`);
  }
  return result.stdout.trim();
}

function reconcileLocalDocker(env: NodeJS.ProcessEnv): void {
  const dockerBinary = env.RUNNER_DOCKER_BINARY ?? "docker";
  checkedDocker(dockerBinary, ["version", "--format", "{{.Server.Version}}"], env);
  for (const key of RUNNER_IMAGE_KEYS) {
    checkedDocker(dockerBinary, ["image", "inspect", env[key]!], env);
  }
  const stale = checkedDocker(dockerBinary, [
    "ps",
    "--all",
    "--quiet",
    "--filter",
    "label=io.learncoding.runner.job=true",
  ], env);
  for (const containerId of stale.split(/\r?\n/).filter(Boolean)) {
    if (!/^[a-f0-9]{12,64}$/i.test(containerId)) {
      throw new Error("Docker returned an invalid stale runner container id.");
    }
    checkedDocker(dockerBinary, ["rm", "--force", containerId], env);
  }
}

function attachShutdown(child: ChildProcess): () => void {
  let stopping = false;
  const stop = () => {
    if (stopping || child.exitCode !== null) return;
    stopping = true;
    child.kill("SIGTERM");
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  return () => {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  };
}

export async function startLocalRunner(): Promise<number> {
  const runnerRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const projectRoot = path.resolve(runnerRoot, "..", "..");
  const localRoot = path.join(runnerRoot, ".local");
  const stateRoot = path.join(localRoot, "state");
  const tempRoot = path.join(localRoot, "tmp");
  mkdirSync(tempRoot, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") chmodSync(tempRoot, 0o700);

  const ownership = acquireLocalRunnerOwnership(stateRoot);
  try {
    const env = buildLocalRunnerEnvironment({
      inheritedEnv: process.env,
      rootEnv: readEnvironmentFile(path.join(projectRoot, ".env")),
      imageEnv: readEnvironmentFile(path.join(runnerRoot, "dist", "runtime-images.env")),
      stateRoot,
      tempRoot,
      lockFd: 3,
    });
    reconcileLocalDocker(env);
    const entrypoint = path.join(runnerRoot, "dist", "index.js");
    if (!existsSync(entrypoint)) throw new Error("Runner build output is missing. Run npm run build first.");
    process.stdout.write(`Starting local-only isolated runner on 127.0.0.1:${env.RUNNER_PORT}...\n`);
    const child = spawn(process.execPath, [entrypoint], {
      cwd: runnerRoot,
      env,
      shell: false,
      windowsHide: true,
      stdio: ["inherit", "inherit", "inherit", ownership.lockFd],
    });
    const detachShutdown = attachShutdown(child);
    return await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => {
        detachShutdown();
        if (signal) process.stderr.write(`Local runner stopped by ${signal}.\n`);
        resolve(code ?? (signal ? 1 : 0));
      });
    });
  } finally {
    ownership.release();
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  startLocalRunner()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(`Local runner failed: ${error instanceof Error ? error.message : "unknown error"}\n`);
      process.exitCode = 1;
    });
}
