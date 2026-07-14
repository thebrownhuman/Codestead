import path from "node:path";
import type { RunnerConfig } from "./config.js";
import { RunnerError } from "./errors.js";
import {
  LANGUAGES,
  type Language,
  type ResolvedLimits,
  type RunnerJobRequest,
  type RunnerTestCase,
  type RuntimeSpec,
  type SourceFile,
} from "./types.js";

export interface ValidatedJob {
  readonly request: RunnerJobRequest;
  readonly limits: ResolvedLimits;
  readonly runtime: RuntimeSpec;
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SAFE_CATEGORY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SAFE_PATH = /^[A-Za-z0-9._/-]{1,128}$/;

function bad(message: string): never {
  throw new RunnerError("BAD_REQUEST", message, 400);
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    bad(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  name: string,
): void {
  const allow = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !allow.has(key));
  if (unknown.length > 0) {
    bad(`${name} contains unknown field(s): ${unknown.join(", ")}`);
  }
}

function string(
  value: unknown,
  name: string,
  maximumBytes: number,
  allowEmpty = false,
): string {
  if (typeof value !== "string") {
    bad(`${name} must be a string`);
  }
  if (!allowEmpty && value.trim() === "") {
    bad(`${name} must not be empty`);
  }
  if (Buffer.byteLength(value, "utf8") > maximumBytes) {
    bad(`${name} exceeds ${maximumBytes} bytes`);
  }
  return value;
}

function id(value: unknown, name: string): string {
  const parsed = string(value, name, 128);
  if (!SAFE_ID.test(parsed)) {
    bad(`${name} contains unsupported characters`);
  }
  return parsed;
}

function sourcePath(value: unknown, name: string): string {
  const parsed = string(value, name, 128);
  if (
    !SAFE_PATH.test(parsed) ||
    parsed.startsWith("/") ||
    parsed.includes("\\") ||
    parsed.split("/").some((segment) => segment === "." || segment === "..") ||
    path.posix.normalize(parsed) !== parsed
  ) {
    bad(`${name} must be a normalized safe relative path`);
  }
  return parsed;
}

function parseLanguage(value: unknown): Language {
  if (
    typeof value !== "string" ||
    !(LANGUAGES as readonly string[]).includes(value)
  ) {
    bad(`language must be one of: ${LANGUAGES.join(", ")}`);
  }
  return value as Language;
}

function parseSources(
  value: unknown,
  runtime: RuntimeSpec,
  config: RunnerConfig,
): readonly SourceFile[] {
  if (!Array.isArray(value) || value.length === 0) {
    bad("sourceFiles must be a non-empty array");
  }
  if (value.length > config.maxSourceFiles) {
    bad(`sourceFiles exceeds ${config.maxSourceFiles} files`);
  }

  let totalBytes = 0;
  const seen = new Set<string>();
  return value.map((item, index) => {
    const parsed = record(item, `sourceFiles[${index}]`);
    exactKeys(parsed, ["path", "content"], `sourceFiles[${index}]`);
    const filePath = sourcePath(
      parsed.path,
      `sourceFiles[${index}].path`,
    );
    if (seen.has(filePath)) {
      bad(`duplicate source path: ${filePath}`);
    }
    seen.add(filePath);
    const extension = path.posix.extname(filePath).toLowerCase();
    if (!runtime.allowedExtensions.includes(extension)) {
      bad(
        `source extension ${extension || "<none>"} is not allowed for ${runtime.language}`,
      );
    }
    const content = string(
      parsed.content,
      `sourceFiles[${index}].content`,
      config.maxSourceBytes,
      true,
    );
    totalBytes += Buffer.byteLength(content, "utf8");
    if (totalBytes > config.maxSourceBytes) {
      bad(`combined source exceeds ${config.maxSourceBytes} bytes`);
    }
    return { path: filePath, content };
  });
}

function parseTests(
  value: unknown,
  config: RunnerConfig,
): readonly RunnerTestCase[] {
  if (!Array.isArray(value) || value.length === 0) {
    bad("TEST mode requires at least one test");
  }
  if (value.length > config.maxTests) {
    bad(`tests exceeds ${config.maxTests} cases`);
  }
  const seen = new Set<string>();
  return value.map((item, index) => {
    const parsed = record(item, `tests[${index}]`);
    exactKeys(
      parsed,
      [
        "id",
        "visibility",
        "category",
        "stdin",
        "expectedStdout",
        "comparison",
      ],
      `tests[${index}]`,
    );
    const testId = id(parsed.id, `tests[${index}].id`);
    if (seen.has(testId)) {
      bad(`duplicate test id: ${testId}`);
    }
    seen.add(testId);
    if (parsed.visibility !== "VISIBLE" && parsed.visibility !== "HIDDEN") {
      bad(`tests[${index}].visibility is invalid`);
    }
    const category = string(
      parsed.category,
      `tests[${index}].category`,
      64,
    );
    if (!SAFE_CATEGORY.test(category)) {
      bad(`tests[${index}].category contains unsupported characters`);
    }
    const stdin = string(
      parsed.stdin,
      `tests[${index}].stdin`,
      config.maxBodyBytes,
      true,
    );
    const expectedStdout = string(
      parsed.expectedStdout,
      `tests[${index}].expectedStdout`,
      config.maxima.outputBytes,
      true,
    );
    if (parsed.comparison !== "EXACT" && parsed.comparison !== "TRIMMED") {
      bad(`tests[${index}].comparison is invalid`);
    }
    return {
      id: testId,
      visibility: parsed.visibility,
      category,
      stdin,
      expectedStdout,
      comparison: parsed.comparison,
    };
  });
}

function boundedNumber(
  value: unknown,
  name: string,
  fallback: number,
  maximum: number,
  integerOnly: boolean,
): number {
  if (value === undefined) {
    return fallback;
  }
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value <= 0 ||
    value > maximum ||
    (integerOnly && !Number.isInteger(value))
  ) {
    bad(`${name} must be positive and no greater than ${maximum}`);
  }
  return value;
}

function parseLimits(
  value: unknown,
  config: RunnerConfig,
): ResolvedLimits {
  const parsed =
    value === undefined ? {} : record(value, "limits");
  exactKeys(
    parsed,
    [
      "wallTimeMs",
      "memoryMb",
      "cpuCount",
      "pids",
      "outputBytes",
      "fileBytes",
    ],
    "limits",
  );
  return {
    wallTimeMs: boundedNumber(
      parsed.wallTimeMs,
      "limits.wallTimeMs",
      config.defaults.wallTimeMs,
      config.maxima.wallTimeMs,
      true,
    ),
    memoryMb: boundedNumber(
      parsed.memoryMb,
      "limits.memoryMb",
      config.defaults.memoryMb,
      config.maxima.memoryMb,
      true,
    ),
    cpuCount: boundedNumber(
      parsed.cpuCount,
      "limits.cpuCount",
      config.defaults.cpuCount,
      config.maxima.cpuCount,
      false,
    ),
    pids: boundedNumber(
      parsed.pids,
      "limits.pids",
      config.defaults.pids,
      config.maxima.pids,
      true,
    ),
    outputBytes: boundedNumber(
      parsed.outputBytes,
      "limits.outputBytes",
      config.defaults.outputBytes,
      config.maxima.outputBytes,
      true,
    ),
    fileBytes: boundedNumber(
      parsed.fileBytes,
      "limits.fileBytes",
      config.defaults.fileBytes,
      config.maxima.fileBytes,
      true,
    ),
  };
}

export function validateJobRequest(
  value: unknown,
  config: RunnerConfig,
): ValidatedJob {
  const parsed = record(value, "request");
  exactKeys(
    parsed,
    [
      "submissionId",
      "correlationId",
      "language",
      "runtimeVersion",
      "mode",
      "sourceFiles",
      "entrypoint",
      "stdin",
      "tests",
      "testBundleVersion",
      "limits",
    ],
    "request",
  );

  const language = parseLanguage(parsed.language);
  const runtime = config.runtimes[language];
  const runtimeVersion = string(
    parsed.runtimeVersion,
    "runtimeVersion",
    128,
  );
  if (runtimeVersion !== runtime.version) {
    bad(
      `runtimeVersion must equal the configured version: ${runtime.version}`,
    );
  }
  if (
    parsed.mode !== "COMPILE" &&
    parsed.mode !== "RUN" &&
    parsed.mode !== "TEST"
  ) {
    bad("mode must be COMPILE, RUN, or TEST");
  }

  const sourceFiles = parseSources(parsed.sourceFiles, runtime, config);
  const entrypoint = sourcePath(parsed.entrypoint, "entrypoint");
  if (!sourceFiles.some((file) => file.path === entrypoint)) {
    bad("entrypoint must reference a submitted source file");
  }

  if (parsed.mode === "COMPILE" && (parsed.stdin !== undefined || parsed.tests !== undefined)) {
    bad("COMPILE mode does not accept stdin or tests");
  }
  if (parsed.mode === "RUN" && parsed.tests !== undefined) {
    bad("RUN mode does not accept tests");
  }
  if (parsed.mode === "TEST" && parsed.stdin !== undefined) {
    bad("TEST mode does not accept top-level stdin");
  }

  const tests =
    parsed.mode === "TEST" ? parseTests(parsed.tests, config) : undefined;
  const testBundleVersion =
    parsed.testBundleVersion === undefined
      ? undefined
      : id(parsed.testBundleVersion, "testBundleVersion");
  if (parsed.mode === "TEST" && testBundleVersion === undefined) {
    bad("TEST mode requires testBundleVersion");
  }

  const request: RunnerJobRequest = {
    submissionId: id(parsed.submissionId, "submissionId"),
    correlationId: id(parsed.correlationId, "correlationId"),
    language,
    runtimeVersion,
    mode: parsed.mode,
    sourceFiles,
    entrypoint,
    ...(parsed.mode === "RUN"
      ? {
          stdin: string(
            parsed.stdin ?? "",
            "stdin",
            config.maxBodyBytes,
            true,
          ),
        }
      : {}),
    ...(tests === undefined ? {} : { tests }),
    ...(testBundleVersion === undefined ? {} : { testBundleVersion }),
    ...(parsed.limits === undefined
      ? {}
      : {
          limits:
            parsed.limits as NonNullable<RunnerJobRequest["limits"]>,
        }),
  };

  return {
    request,
    limits: parseLimits(parsed.limits, config),
    runtime,
  };
}
