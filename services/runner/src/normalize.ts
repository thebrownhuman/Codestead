import type { ProcessResult } from "./process-executor.js";
import type {
  NormalizedTestResult,
  OutputComparison,
  RunnerTestCase,
} from "./types.js";

export type ProcessClassification =
  | "OK"
  | "COMPILE_ERROR"
  | "RUNTIME_ERROR"
  | "TIMEOUT"
  | "MEMORY_LIMIT"
  | "OUTPUT_LIMIT"
  | "INFRASTRUCTURE_ERROR";

export function sanitizeOutput(
  value: string,
  workspacePath: string,
  maximumBytes: number,
): string {
  let sanitized = value
    .replaceAll(workspacePath, "<workspace>")
    .replaceAll("/input", "<workspace>")
    .replaceAll("\u0000", "");
  const bytes = Buffer.from(sanitized, "utf8");
  if (bytes.length > maximumBytes) {
    sanitized =
      bytes.subarray(0, maximumBytes).toString("utf8") +
      "\n<output truncated>";
  }
  return sanitized;
}

export function normalizeOutput(
  value: string,
  comparison: OutputComparison,
): string {
  const lines = value.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  if (comparison === "EXACT") {
    return lines;
  }
  return lines
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trim();
}

export function classifyProcess(
  result: ProcessResult,
  phase: "COMPILE" | "RUN",
): ProcessClassification {
  if (result.timedOut) {
    return "TIMEOUT";
  }
  if (result.outputLimitExceeded) {
    return "OUTPUT_LIMIT";
  }
  if (result.exitCode === 0) {
    return "OK";
  }
  if (result.exitCode === 137) {
    return "MEMORY_LIMIT";
  }
  if (
    result.exitCode === 125 ||
    result.exitCode === 126 ||
    result.exitCode === 127 ||
    result.exitCode === null
  ) {
    return "INFRASTRUCTURE_ERROR";
  }
  return phase === "COMPILE" ? "COMPILE_ERROR" : "RUNTIME_ERROR";
}

function feedbackCode(
  status: NormalizedTestResult["status"],
  hidden: boolean,
): string {
  const prefix = hidden ? "HIDDEN_" : "VISIBLE_";
  switch (status) {
    case "PASSED":
      return `${prefix}PASS`;
    case "FAILED":
      return `${prefix}WRONG_ANSWER`;
    case "RUNTIME_ERROR":
      return `${prefix}RUNTIME_ERROR`;
    case "TIMEOUT":
      return `${prefix}TIMEOUT`;
    case "MEMORY_LIMIT":
      return `${prefix}MEMORY_LIMIT`;
    case "OUTPUT_LIMIT":
      return `${prefix}OUTPUT_LIMIT`;
    case "INFRASTRUCTURE_ERROR":
      return "INFRASTRUCTURE_ERROR";
  }
}

export function normalizeTestResult(
  test: RunnerTestCase,
  process: ProcessResult,
  workspacePath: string,
  maximumOutputBytes: number,
): NormalizedTestResult {
  const classification = classifyProcess(process, "RUN");
  const actual = sanitizeOutput(
    process.stdout,
    workspacePath,
    maximumOutputBytes,
  );
  const expected = sanitizeOutput(
    test.expectedStdout,
    workspacePath,
    maximumOutputBytes,
  );
  const passed =
    classification === "OK" &&
    normalizeOutput(actual, test.comparison) ===
      normalizeOutput(expected, test.comparison);
  const status: NormalizedTestResult["status"] =
    classification === "OK"
      ? passed
        ? "PASSED"
        : "FAILED"
      : classification === "COMPILE_ERROR"
        ? "INFRASTRUCTURE_ERROR"
        : classification;
  const base = {
    id: test.id,
    visibility: test.visibility,
    category: test.category,
    status,
    feedbackCode: feedbackCode(status, test.visibility === "HIDDEN"),
    exitCode: process.exitCode,
    wallTimeMs: process.wallTimeMs,
  } as const;

  if (test.visibility === "HIDDEN") {
    return base;
  }

  return {
    ...base,
    actualStdout: actual,
    expectedStdout: expected,
    stderr: sanitizeOutput(
      process.stderr,
      workspacePath,
      maximumOutputBytes,
    ),
  };
}
