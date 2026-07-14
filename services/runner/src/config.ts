import path from "node:path";
import { RunnerError } from "./errors.js";
import type {
  Language,
  ResolvedLimits,
  RuntimeSpec,
} from "./types.js";

export interface RunnerConfig {
  readonly host: string;
  readonly port: number;
  readonly sharedSecret: string;
  readonly authMaxSkewSeconds: number;
  readonly nonceTtlSeconds: number;
  readonly maxBodyBytes: number;
  readonly maxSourceBytes: number;
  readonly maxSourceFiles: number;
  readonly maxTests: number;
  readonly maxQueueDepth: number;
  readonly concurrency: 2;
  readonly idempotencyTtlMs: number;
  readonly idempotencyCapacity: number;
  readonly dockerBinary: string;
  readonly tempRoot: string;
  readonly stateRoot: string;
  readonly defaults: ResolvedLimits;
  readonly maxima: ResolvedLimits;
  readonly runtimes: Readonly<Record<Language, RuntimeSpec>>;
}

export const NATIVE_RUNTIME_VERSIONS = Object.freeze({
  c: "C23 / GCC 14.2.0",
  cpp: "C++20 / G++ 14.2.0",
});

const IMAGE_PATTERN =
  /^[a-z0-9][a-z0-9./:_-]*@sha256:[a-f0-9]{64}$/i;

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (value === undefined || value.trim() === "") {
    throw new RunnerError(
      "BAD_REQUEST",
      `missing required environment variable ${name}`,
      500,
    );
  }
  return value;
}

function integer(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = env[name];
  const value = raw === undefined ? fallback : Number(raw);
  if (
    !Number.isInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new RunnerError(
      "BAD_REQUEST",
      `${name} must be an integer from ${minimum} to ${maximum}`,
      500,
    );
  }
  return value;
}

export function parsePinnedImage(
  value: string,
  variableName: string,
): { image: string; digest: string } {
  if (!IMAGE_PATTERN.test(value)) {
    throw new RunnerError(
      "BAD_REQUEST",
      `${variableName} must be an OCI image pinned with @sha256:<64 hex>`,
      500,
    );
  }
  const marker = "@sha256:";
  const markerIndex = value.lastIndexOf(marker);
  return {
    image: value,
    digest: `sha256:${value.slice(markerIndex + marker.length)}`,
  };
}

function runtime(
  env: NodeJS.ProcessEnv,
  language: Language,
  version: string,
  imageVariable: string,
  extensions: readonly string[],
  defaultEntrypoint: string,
): RuntimeSpec {
  const pinned = parsePinnedImage(
    required(env, imageVariable),
    imageVariable,
  );
  return {
    language,
    version,
    image: pinned.image,
    imageDigest: pinned.digest,
    harnessPath: "/opt/runner/execute",
    allowedExtensions: extensions,
    defaultEntrypoint,
  };
}

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
): RunnerConfig {
  const sharedSecret = required(env, "RUNNER_SHARED_SECRET");
  if (Buffer.byteLength(sharedSecret, "utf8") < 32) {
    throw new RunnerError(
      "BAD_REQUEST",
      "RUNNER_SHARED_SECRET must contain at least 32 bytes",
      500,
    );
  }

  const concurrency = integer(
    env,
    "RUNNER_MAX_CONCURRENCY",
    2,
    2,
    2,
  ) as 2;
  const authMaxSkewSeconds = integer(
    env,
    "RUNNER_AUTH_MAX_SKEW_SECONDS",
    300,
    30,
    900,
  );
  const nonceTtlSeconds = integer(
    env,
    "RUNNER_NONCE_TTL_SECONDS",
    900,
    60,
    3_600,
  );
  const idempotencyTtlSeconds = integer(
    env,
    "RUNNER_IDEMPOTENCY_TTL_SECONDS",
    86_400,
    300,
    604_800,
  );
  const fullAcceptedSignatureLifetimeSeconds = authMaxSkewSeconds * 2;
  if (nonceTtlSeconds <= fullAcceptedSignatureLifetimeSeconds) {
    throw new RunnerError(
      "BAD_REQUEST",
      "RUNNER_NONCE_TTL_SECONDS must be greater than twice RUNNER_AUTH_MAX_SKEW_SECONDS",
      500,
    );
  }
  if (idempotencyTtlSeconds <= fullAcceptedSignatureLifetimeSeconds) {
    throw new RunnerError(
      "BAD_REQUEST",
      "RUNNER_IDEMPOTENCY_TTL_SECONDS must be greater than twice RUNNER_AUTH_MAX_SKEW_SECONDS",
      500,
    );
  }

  return {
    host: env.RUNNER_HOST ?? "0.0.0.0",
    port: integer(env, "RUNNER_PORT", 4100, 1, 65_535),
    sharedSecret,
    authMaxSkewSeconds,
    nonceTtlSeconds,
    maxBodyBytes: integer(
      env,
      "RUNNER_MAX_BODY_BYTES",
      1_048_576,
      1_024,
      4_194_304,
    ),
    maxSourceBytes: integer(
      env,
      "RUNNER_MAX_SOURCE_BYTES",
      131_072,
      1_024,
      1_048_576,
    ),
    maxSourceFiles: integer(
      env,
      "RUNNER_MAX_SOURCE_FILES",
      8,
      1,
      32,
    ),
    maxTests: integer(env, "RUNNER_MAX_TESTS", 50, 1, 100),
    maxQueueDepth: integer(
      env,
      "RUNNER_MAX_QUEUE_DEPTH",
      100,
      2,
      1_000,
    ),
    concurrency,
    idempotencyTtlMs: idempotencyTtlSeconds * 1_000,
    idempotencyCapacity: integer(
      env,
      "RUNNER_IDEMPOTENCY_CAPACITY",
      10_000,
      100,
      100_000,
    ),
    dockerBinary: env.RUNNER_DOCKER_BINARY ?? "docker",
    tempRoot: path.resolve(
      env.RUNNER_TEMP_ROOT ?? "/var/lib/learncoding-runner/tmp",
    ),
    stateRoot: path.resolve(
      env.RUNNER_STATE_ROOT ?? "/var/lib/learncoding-runner",
    ),
    defaults: {
      wallTimeMs: 5_000,
      memoryMb: 128,
      cpuCount: 0.5,
      pids: 32,
      outputBytes: 65_536,
      fileBytes: 16_777_216,
    },
    maxima: {
      wallTimeMs: 30_000,
      memoryMb: 512,
      cpuCount: 1,
      pids: 64,
      outputBytes: 262_144,
      fileBytes: 67_108_864,
    },
    runtimes: {
      c: runtime(
        env,
        "c",
        NATIVE_RUNTIME_VERSIONS.c,
        "RUNNER_IMAGE_C",
        [".c", ".h"],
        "main.c",
      ),
      cpp: runtime(
        env,
        "cpp",
        NATIVE_RUNTIME_VERSIONS.cpp,
        "RUNNER_IMAGE_CPP",
        [".cpp", ".cc", ".cxx", ".h", ".hpp"],
        "main.cpp",
      ),
      java: runtime(
        env,
        "java",
        "Java 21",
        "RUNNER_IMAGE_JAVA",
        [".java"],
        "Main.java",
      ),
      python: runtime(
        env,
        "python",
        "Python 3.14",
        "RUNNER_IMAGE_PYTHON",
        [".py"],
        "main.py",
      ),
      javascript: runtime(
        env,
        "javascript",
        "Node.js 22",
        "RUNNER_IMAGE_JAVASCRIPT",
        [".js", ".mjs"],
        "main.js",
      ),
    },
  };
}
