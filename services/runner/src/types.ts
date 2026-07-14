export const LANGUAGES = [
  "c",
  "cpp",
  "java",
  "python",
  "javascript",
] as const;

export type Language = (typeof LANGUAGES)[number];
export type ExecutionMode = "COMPILE" | "RUN" | "TEST";
export type TestVisibility = "VISIBLE" | "HIDDEN";
export type OutputComparison = "EXACT" | "TRIMMED";

export interface SourceFile {
  readonly path: string;
  readonly content: string;
}

export interface RunnerTestCase {
  readonly id: string;
  readonly visibility: TestVisibility;
  readonly category: string;
  readonly stdin: string;
  readonly expectedStdout: string;
  readonly comparison: OutputComparison;
}

export interface RequestedLimits {
  readonly wallTimeMs?: number;
  readonly memoryMb?: number;
  readonly cpuCount?: number;
  readonly pids?: number;
  readonly outputBytes?: number;
  readonly fileBytes?: number;
}

export interface ResolvedLimits {
  readonly wallTimeMs: number;
  readonly memoryMb: number;
  readonly cpuCount: number;
  readonly pids: number;
  readonly outputBytes: number;
  readonly fileBytes: number;
}

export interface RunnerJobRequest {
  readonly submissionId: string;
  readonly correlationId: string;
  readonly language: Language;
  readonly runtimeVersion: string;
  readonly mode: ExecutionMode;
  readonly sourceFiles: readonly SourceFile[];
  readonly entrypoint: string;
  readonly stdin?: string;
  readonly tests?: readonly RunnerTestCase[];
  readonly testBundleVersion?: string;
  readonly limits?: RequestedLimits;
}

export type NormalizedStatus =
  | "COMPILE_ONLY"
  | "ACCEPTED"
  | "WRONG_ANSWER"
  | "COMPILE_ERROR"
  | "RUNTIME_ERROR"
  | "TIMEOUT"
  | "MEMORY_LIMIT"
  | "OUTPUT_LIMIT"
  | "INFRASTRUCTURE_ERROR";

export interface CompileResult {
  readonly status:
    | "OK"
    | "COMPILE_ERROR"
    | "TIMEOUT"
    | "MEMORY_LIMIT"
    | "OUTPUT_LIMIT"
    | "INFRASTRUCTURE_ERROR";
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly wallTimeMs: number;
}

export interface NormalizedTestResult {
  readonly id: string;
  readonly visibility: TestVisibility;
  readonly category: string;
  readonly status:
    | "PASSED"
    | "FAILED"
    | "RUNTIME_ERROR"
    | "TIMEOUT"
    | "MEMORY_LIMIT"
    | "OUTPUT_LIMIT"
    | "INFRASTRUCTURE_ERROR";
  readonly feedbackCode: string;
  readonly exitCode: number | null;
  readonly wallTimeMs: number;
  readonly actualStdout?: string;
  readonly expectedStdout?: string;
  readonly stderr?: string;
}

export interface RunnerResult {
  readonly status: NormalizedStatus;
  readonly requestHash: string;
  readonly sourceHash: string;
  readonly runtimeVersion: string;
  readonly imageDigest: string;
  readonly testBundleVersion?: string;
  readonly compile: CompileResult;
  readonly run?: {
    readonly exitCode: number | null;
    readonly stdout: string;
    readonly stderr: string;
    readonly wallTimeMs: number;
  };
  readonly tests: readonly NormalizedTestResult[];
  readonly totals: {
    readonly passed: number;
    readonly failed: number;
    readonly total: number;
  };
  readonly startedAt: string;
  readonly finishedAt: string;
}

export type JobState =
  | "QUEUED"
  | "RUNNING"
  | "COMPLETED"
  | "FAILED";

export interface PublicJobRecord {
  readonly jobId: string;
  readonly submissionId: string;
  readonly correlationId: string;
  readonly requestHash: string;
  readonly state: JobState;
  readonly queuePosition: number | null;
  readonly createdAt: string;
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly result?: RunnerResult;
  readonly error?: {
    readonly code: string;
    readonly retryable: boolean;
  };
}

export interface RuntimeSpec {
  readonly language: Language;
  readonly version: string;
  readonly image: string;
  readonly imageDigest: string;
  readonly harnessPath: string;
  readonly allowedExtensions: readonly string[];
  readonly defaultEntrypoint: string;
}
