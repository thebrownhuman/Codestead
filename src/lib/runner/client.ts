import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export type RunnerLanguage = "c" | "cpp" | "java" | "python" | "javascript";

export interface RunnerRequest {
  submissionId: string;
  correlationId: string;
  language: RunnerLanguage;
  runtimeVersion: string;
  mode: "COMPILE" | "RUN" | "TEST";
  sourceFiles: Array<{ path: string; content: string }>;
  entrypoint: string;
  stdin?: string;
  tests?: Array<{
    id: string;
    visibility: "VISIBLE" | "HIDDEN";
    category: string;
    stdin: string;
    expectedStdout: string;
    comparison: "EXACT" | "TRIMMED";
  }>;
  testBundleVersion?: string;
  limits?: {
    wallTimeMs?: number;
    memoryMb?: number;
    cpuCount?: number;
    pids?: number;
    outputBytes?: number;
    fileBytes?: number;
  };
}

export interface RunnerJobResponse {
  jobId: string;
  submissionId: string;
  correlationId: string;
  requestHash: string;
  state: "QUEUED" | "RUNNING" | "COMPLETED" | "FAILED";
  queuePosition: number | null;
  result?: {
    status: string;
    imageDigest: string;
    runtimeVersion: string;
    compile: { status: string; stdout: string; stderr: string; exitCode: number | null };
    run?: { stdout: string; stderr: string; exitCode: number | null; wallTimeMs: number };
    tests: Array<{ id: string; visibility: string; category: string; status: string; feedbackCode: string }>;
    totals: { passed: number; failed: number; total: number };
  };
  error?: { code: string; retryable: boolean };
}

export class RunnerClientError extends Error {
  constructor(
    public readonly code: string,
    public readonly retryable: boolean,
    public readonly status: number,
  ) {
    super(code);
    this.name = "RunnerClientError";
  }
}

export type RunnerIndeterminateCode =
  | "RUNNER_NETWORK_INDETERMINATE"
  | "RUNNER_REQUEST_INDETERMINATE"
  | "RUNNER_RESPONSE_UNTRUSTED"
  | "RUNNER_WAIT_INDETERMINATE";

export type RunnerAvailability =
  | {
      available: true;
      status: "available";
      queueDepth: number;
      activeJobs: number;
      concurrency: number;
    }
  | {
      available: false;
      status: "offline" | "unavailable";
      code: "RUNNER_OFFLINE" | "RUNNER_UNHEALTHY";
    };

/**
 * The request may already have reached the isolated runner. Callers must keep
 * the same local admission and remote idempotency key, then reconcile it; they
 * must not terminally fail the admission or start a fresh generation.
 */
export class RunnerIndeterminateError extends RunnerClientError {
  readonly indeterminate = true;

  constructor(
    code: RunnerIndeterminateCode,
    public readonly remoteJobId: string | null,
    cause?: unknown,
  ) {
    super(code, true, 504);
    this.name = "RunnerIndeterminateError";
    if (cause !== undefined) this.cause = cause;
  }
}

// This must remain comfortably below the official-admission stale-dispatch
// threshold. A request that has lost its database dispatch slot must never be
// allowed to return later and be treated as fresh evidence.
export const RUNNER_REQUEST_TIMEOUT_MS = 15_000;
export const RUNNER_HEALTH_TIMEOUT_MS = 2_000;
const MAX_RUNNER_REQUEST_TIMEOUT_MS = 60_000;
const DEFAULT_RUNNER_OUTPUT_BYTES = 65_536;
const MAX_RUNNER_OUTPUT_BYTES = 262_144;
const MAX_RUNNER_RESPONSE_BYTES = 2 * 1024 * 1024;

export const runtimeByLanguage: Record<RunnerLanguage, { version: string; entrypoint: string }> = {
  c: { version: "C23 / GCC 14.2.0", entrypoint: "main.c" },
  cpp: { version: "C++20 / G++ 14.2.0", entrypoint: "main.cpp" },
  java: { version: "Java 21", entrypoint: "Main.java" },
  python: { version: "Python 3.14", entrypoint: "main.py" },
  javascript: { version: "Node.js 22", entrypoint: "main.js" },
};

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) {
    return `[${value.map((item) => item === undefined ? "null" : canonicalJson(item)).join(",")}]`;
  }
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .filter((key) => object[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
      .join(",")}}`;
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error("Runner requests must contain JSON values only.");
  return serialized;
}

/** Stable wire bytes make a persisted request replay hash-identical after a process restart. */
export function serializeRunnerRequest(request: RunnerRequest): string {
  return canonicalJson(request);
}

export function signRunnerRequest(
  secret: string,
  method: string,
  path: string,
  timestamp: string,
  nonce: string,
  requestId: string,
  idempotencyKey: string,
  body: string,
) {
  const canonical = [
    "LEARNCODING-RUNNER-HMAC-V2",
    method.toUpperCase(),
    path,
    timestamp,
    nonce,
    requestId,
    idempotencyKey,
    sha256(body),
  ].join("\n");
  return `sha256=${createHmac("sha256", secret).update(canonical).digest("hex")}`;
}

function responseSignature(secret: string, requestId: string, status: number, body: string) {
  return `sha256=${createHmac("sha256", secret)
    .update([requestId, String(status), sha256(body)].join("\n"))
    .digest("hex")}`;
}

function safeEqual(left: string, right: string) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

type ExpectedRunnerBinding = Readonly<{
  jobId?: string;
  submissionId?: string;
  correlationId?: string;
  requestHash?: string;
  outputBytes?: number;
  tests?: ReadonlyArray<Readonly<{ id: string; visibility: string; category: string }>>;
}>;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function validRunnerResult(value: unknown, outputBytes = MAX_RUNNER_OUTPUT_BYTES) {
  if (value === undefined) return false;
  const result = record(value);
  const compile = record(result?.compile);
  const totals = record(result?.totals);
  const run = result?.run === undefined ? null : record(result.run);
  if (
    !result
    || typeof result.status !== "string"
    || typeof result.imageDigest !== "string"
    || typeof result.runtimeVersion !== "string"
    || !compile
    || typeof compile.status !== "string"
    || typeof compile.stdout !== "string"
    || typeof compile.stderr !== "string"
    || !(compile.exitCode === null || Number.isSafeInteger(compile.exitCode))
    || !Array.isArray(result.tests)
    || !totals
    || !Number.isSafeInteger(totals.passed)
    || !Number.isSafeInteger(totals.failed)
    || !Number.isSafeInteger(totals.total)
    || Number(totals.passed) < 0
    || Number(totals.failed) < 0
    || Number(totals.total) < 0
    || Number(totals.passed) + Number(totals.failed) !== Number(totals.total)
  ) return false;
  if (result.run !== undefined && (
    !run
    || typeof run.stdout !== "string"
    || typeof run.stderr !== "string"
    || !(run.exitCode === null || Number.isSafeInteger(run.exitCode))
    || typeof run.wallTimeMs !== "number"
    || !Number.isFinite(run.wallTimeMs)
    || run.wallTimeMs < 0
  )) return false;
  const outputSize = Buffer.byteLength(String(compile.stdout), "utf8")
    + Buffer.byteLength(String(compile.stderr), "utf8")
    + (run
      ? Buffer.byteLength(String(run.stdout), "utf8") + Buffer.byteLength(String(run.stderr), "utf8")
      : 0);
  if (!Number.isSafeInteger(outputBytes) || outputBytes < 1 || outputSize > outputBytes) return false;
  return result.tests.every((candidate) => {
    const test = record(candidate);
    return Boolean(test)
      && typeof test!.id === "string"
      && typeof test!.visibility === "string"
      && typeof test!.category === "string"
      && typeof test!.status === "string"
      && typeof test!.feedbackCode === "string";
  });
}

function validRunnerJob(value: unknown, expected: ExpectedRunnerBinding): value is RunnerJobResponse {
  const job = record(value);
  if (!job) return false;
  if (
    typeof job.jobId !== "string"
    || !/^[A-Za-z0-9._:-]{1,128}$/.test(job.jobId)
    || typeof job.submissionId !== "string"
    || typeof job.correlationId !== "string"
    || typeof job.requestHash !== "string"
    || !/^[0-9a-f]{64}$/.test(job.requestHash)
    || !["QUEUED", "RUNNING", "COMPLETED", "FAILED"].includes(String(job.state))
    || !(job.queuePosition === null
      || (Number.isSafeInteger(job.queuePosition) && Number(job.queuePosition) >= 0))
  ) return false;
  const error = job.error === undefined ? null : record(job.error);
  const validError = Boolean(error)
    && typeof error!.code === "string"
    && typeof error!.retryable === "boolean";
  if (job.state === "COMPLETED" && (!validRunnerResult(job.result, expected.outputBytes) || job.error !== undefined)) return false;
  if (job.state === "FAILED" && (job.result !== undefined || !validError)) return false;
  if ((job.state === "QUEUED" || job.state === "RUNNING")
    && (job.result !== undefined || job.error !== undefined)) return false;
  if (job.state !== "QUEUED" && job.queuePosition !== null) return false;
  if (job.state === "COMPLETED" && expected.tests !== undefined) {
    const result = record(job.result)!;
    const actualTests = result.tests as unknown[];
    if (actualTests.length !== expected.tests.length) return false;
    const actualById = new Map<string, Record<string, unknown>>();
    for (const candidate of actualTests) {
      const test = record(candidate);
      if (!test || typeof test.id !== "string" || actualById.has(test.id)) return false;
      actualById.set(test.id, test);
    }
    for (const expectedTest of expected.tests) {
      const actual = actualById.get(expectedTest.id);
      if (
        !actual
        || actual.visibility !== expectedTest.visibility
        || actual.category !== expectedTest.category
      ) return false;
    }
    const totals = record(result.totals)!;
    if (totals.total !== expected.tests.length) return false;
  }
  if (expected.jobId !== undefined && job.jobId !== expected.jobId) return false;
  if (expected.submissionId !== undefined && job.submissionId !== expected.submissionId) return false;
  if (expected.correlationId !== undefined && job.correlationId !== expected.correlationId) return false;
  if (expected.requestHash !== undefined && job.requestHash !== expected.requestHash) return false;
  return true;
}

function bindingForRequest(request: RunnerRequest): ExpectedRunnerBinding {
  const requestedOutputBytes = request.limits?.outputBytes ?? DEFAULT_RUNNER_OUTPUT_BYTES;
  return {
    submissionId: request.submissionId,
    correlationId: request.correlationId,
    requestHash: sha256(serializeRunnerRequest(request)),
    outputBytes: Number.isSafeInteger(requestedOutputBytes)
      ? Math.max(1, Math.min(requestedOutputBytes, MAX_RUNNER_OUTPUT_BYTES))
      : DEFAULT_RUNNER_OUTPUT_BYTES,
    tests: request.mode === "TEST"
      ? (request.tests ?? []).map((test) => ({
          id: test.id,
          visibility: test.visibility,
          category: test.category,
        }))
      : [],
  };
}

async function readBoundedRunnerResponse(response: Response): Promise<string> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    const length = Number(declaredLength);
    if (!Number.isSafeInteger(length) || length < 0 || length > MAX_RUNNER_RESPONSE_BYTES) {
      throw new Error("Runner response length is invalid or exceeds the client limit.");
    }
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RUNNER_RESPONSE_BYTES) {
        await reader.cancel("Runner response exceeds the client limit.");
        throw new Error("Runner response exceeds the client limit.");
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

export class RunnerClient {
  readonly baseUrl: string;
  constructor(
    baseUrl: string,
    private readonly secret: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly requestTimeoutMs = RUNNER_REQUEST_TIMEOUT_MS,
  ) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    if (secret.length < 32) throw new Error("RUNNER_SHARED_SECRET must be at least 32 characters.");
    if (
      !Number.isSafeInteger(requestTimeoutMs)
      || requestTimeoutMs < 1
      || requestTimeoutMs > MAX_RUNNER_REQUEST_TIMEOUT_MS
    ) throw new Error("Runner request timeout must be between 1 and 60000 milliseconds.");
  }

  async submit(request: RunnerRequest, idempotencyKey: string) {
    const body = serializeRunnerRequest(request);
    return this.request("POST", "/v1/jobs", body, {
      "content-type": "application/json",
      "x-idempotency-key": idempotencyKey,
    }, null, bindingForRequest(request));
  }

  /**
   * Checks the runner before crossing the code-dispatch boundary. Unlike a
   * failed POST, a failed GET /healthz can never mean learner code ran, so the
   * application may safely report a definite offline state.
   */
  async checkAvailability(): Promise<RunnerAvailability> {
    const timeoutSignal = AbortSignal.timeout(
      Math.min(this.requestTimeoutMs, RUNNER_HEALTH_TIMEOUT_MS),
    );
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/healthz`, {
        method: "GET",
        redirect: "error",
        cache: "no-store",
        signal: timeoutSignal,
      });
    } catch {
      return {
        available: false,
        status: "offline",
        code: "RUNNER_OFFLINE",
      };
    }
    if (!response.ok) {
      return {
        available: false,
        status: "unavailable",
        code: "RUNNER_UNHEALTHY",
      };
    }
    let health: unknown;
    try {
      health = await response.json();
    } catch {
      return {
        available: false,
        status: "unavailable",
        code: "RUNNER_UNHEALTHY",
      };
    }
    const value = record(health);
    if (
      !value
      || value.status !== "ok"
      || !Number.isSafeInteger(value.queueDepth)
      || Number(value.queueDepth) < 0
      || !Number.isSafeInteger(value.activeJobs)
      || Number(value.activeJobs) < 0
      || !Number.isSafeInteger(value.concurrency)
      || Number(value.concurrency) < 1
    ) {
      return {
        available: false,
        status: "unavailable",
        code: "RUNNER_UNHEALTHY",
      };
    }
    return {
      available: true,
      status: "available",
      queueDepth: Number(value.queueDepth),
      activeJobs: Number(value.activeJobs),
      concurrency: Number(value.concurrency),
    };
  }

  async get(jobId: string, request?: RunnerRequest) {
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(jobId)) throw new Error("Invalid runner job id.");
    return this.request("GET", `/v1/jobs/${jobId}`, "", {}, jobId, {
      ...(request ? bindingForRequest(request) : {}),
      jobId,
    });
  }

  async submitAndWait(
    request: RunnerRequest,
    idempotencyKey: string,
    options: { timeoutMs?: number; pollMs?: number } = {},
  ) {
    const job = await this.submit(request, idempotencyKey);
    return this.waitFrom(job, request, options);
  }

  async waitForJob(
    jobId: string,
    request: RunnerRequest,
    options: { timeoutMs?: number; pollMs?: number } = {},
  ) {
    const job = await this.get(jobId, request);
    return this.waitFrom(job, request, options);
  }

  async waitFrom(
    initialJob: RunnerJobResponse,
    request: RunnerRequest,
    options: { timeoutMs?: number; pollMs?: number } = {},
  ) {
    const binding = bindingForRequest(request);
    if (!validRunnerJob(initialJob, binding)) {
      throw new RunnerIndeterminateError("RUNNER_RESPONSE_UNTRUSTED", null);
    }
    let job = initialJob;
    const deadline = Date.now() + (options.timeoutMs ?? 40_000);
    while (job.state === "QUEUED" || job.state === "RUNNING") {
      if (Date.now() >= deadline) {
        throw new RunnerIndeterminateError("RUNNER_WAIT_INDETERMINATE", job.jobId);
      }
      await new Promise((resolve) => setTimeout(resolve, options.pollMs ?? 300));
      job = await this.get(job.jobId, request);
    }
    return job;
  }

  private async request(
    method: "GET" | "POST",
    path: string,
    body: string,
    extraHeaders: Record<string, string> = {},
    knownRemoteJobId: string | null = null,
    expectedBinding: ExpectedRunnerBinding = {},
  ): Promise<RunnerJobResponse> {
    const timestamp = String(Math.floor(Date.now() / 1_000));
    const nonce = randomBytes(18).toString("base64url");
    const requestId = crypto.randomUUID();
    const idempotencyKey = extraHeaders["x-idempotency-key"] ?? "";
    const timeoutSignal = AbortSignal.timeout(this.requestTimeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: {
          ...extraHeaders,
          "x-runner-timestamp": timestamp,
          "x-runner-nonce": nonce,
          "x-runner-signature": signRunnerRequest(
            this.secret,
            method,
            path,
            timestamp,
            nonce,
            requestId,
            idempotencyKey,
            body,
          ),
          "x-request-id": requestId,
        },
        body: method === "POST" ? body : undefined,
        redirect: "error",
        cache: "no-store",
        signal: timeoutSignal,
      });
    } catch (error) {
      throw new RunnerIndeterminateError(
        timeoutSignal.aborted ? "RUNNER_REQUEST_INDETERMINATE" : "RUNNER_NETWORK_INDETERMINATE",
        knownRemoteJobId,
        error,
      );
    }
    let raw: string;
    try {
      raw = await readBoundedRunnerResponse(response);
    } catch (error) {
      throw new RunnerIndeterminateError("RUNNER_RESPONSE_UNTRUSTED", knownRemoteJobId, error);
    }
    const receivedSignature = response.headers.get("x-runner-response-signature") ?? "";
    const expectedSignature = responseSignature(this.secret, requestId, response.status, raw);
    if (!safeEqual(receivedSignature, expectedSignature)) {
      throw new RunnerIndeterminateError("RUNNER_RESPONSE_UNTRUSTED", knownRemoteJobId);
    }
    let parsed: RunnerJobResponse & { error?: { code?: string; retryable?: boolean } };
    try {
      parsed = JSON.parse(raw) as RunnerJobResponse & { error?: { code?: string; retryable?: boolean } };
    } catch (error) {
      throw new RunnerIndeterminateError("RUNNER_RESPONSE_UNTRUSTED", knownRemoteJobId, error);
    }
    if (!response.ok) {
      if (knownRemoteJobId !== null) {
        throw new RunnerIndeterminateError("RUNNER_REQUEST_INDETERMINATE", knownRemoteJobId);
      }
      if (method === "POST" && response.status >= 500) {
        throw new RunnerIndeterminateError("RUNNER_REQUEST_INDETERMINATE", knownRemoteJobId);
      }
      throw new RunnerClientError(
        parsed.error?.code ?? `RUNNER_HTTP_${response.status}`,
        parsed.error?.retryable === true,
        response.status,
      );
    }
    if (!validRunnerJob(parsed, expectedBinding)) {
      throw new RunnerIndeterminateError("RUNNER_RESPONSE_UNTRUSTED", knownRemoteJobId);
    }
    return parsed;
  }
}

export function configuredRunnerClient() {
  const url = process.env.RUNNER_BASE_URL;
  const secret = process.env.RUNNER_SHARED_SECRET;
  if (!url || !secret) throw new Error("Runner is not configured.");
  return new RunnerClient(url, secret);
}
