import { createHash, createHmac } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  configuredRunnerClient,
  RunnerClient,
  RunnerIndeterminateError,
  RUNNER_HEALTH_TIMEOUT_MS,
  RUNNER_REQUEST_TIMEOUT_MS,
  runtimeByLanguage,
  serializeRunnerRequest,
  signRunnerRequest,
} from "../client";

const secret = "runner-client-test-secret-at-least-32-bytes";

function signedResponse(request: RequestInfo | URL, init: RequestInit | undefined, body: object, status = 200) {
  const raw = JSON.stringify(body);
  return signedRawResponse(init, raw, status);
}

function signedRawResponse(init: RequestInit | undefined, raw: string, status = 200) {
  const requestId = (init?.headers as Record<string, string>)["x-request-id"];
  const hash = createHash("sha256").update(raw).digest("hex");
  const signature = `sha256=${createHmac("sha256", secret).update(`${requestId}\n${status}\n${hash}`).digest("hex")}`;
  return new Response(raw, { status, headers: { "x-runner-response-signature": signature } });
}

const request = {
  submissionId: "sub-1",
  correlationId: "corr-1",
  language: "python" as const,
  runtimeVersion: runtimeByLanguage.python.version,
  mode: "RUN" as const,
  sourceFiles: [{ path: runtimeByLanguage.python.entrypoint, content: "print(1)" }],
  entrypoint: runtimeByLanguage.python.entrypoint,
};
const REQUEST_HASH = createHash("sha256").update(serializeRunnerRequest(request)).digest("hex");
const RUNNER_RESULT = {
  status: "ACCEPTED",
  imageDigest: "sha256:runner-image",
  runtimeVersion: runtimeByLanguage.python.version,
  compile: { status: "OK", stdout: "", stderr: "", exitCode: 0 },
  run: { stdout: "1\n", stderr: "", exitCode: 0, wallTimeMs: 3 },
  tests: [],
  totals: { passed: 0, failed: 0, total: 0 },
};
const testRequest = {
  ...request,
  mode: "TEST" as const,
  tests: [
    { id: "visible-1", visibility: "VISIBLE" as const, category: "functional", stdin: "", expectedStdout: "1\n", comparison: "EXACT" as const },
    { id: "hidden-1", visibility: "HIDDEN" as const, category: "edge", stdin: "", expectedStdout: "1\n", comparison: "TRIMMED" as const },
  ],
};

describe("runner client", () => {
  it("serializes equivalent request objects to identical restart-safe wire bytes", () => {
    const reordered = {
      entrypoint: request.entrypoint,
      sourceFiles: [{ content: "print(1)", path: request.sourceFiles[0]!.path }],
      mode: request.mode,
      runtimeVersion: request.runtimeVersion,
      language: request.language,
      correlationId: request.correlationId,
      submissionId: request.submissionId,
      stdin: undefined,
    };
    expect(serializeRunnerRequest(reordered)).toBe(serializeRunnerRequest(request));
    expect(serializeRunnerRequest(request)).toBe(
      '{"correlationId":"corr-1","entrypoint":"main.py","language":"python","mode":"RUN","runtimeVersion":"Python 3.14","sourceFiles":[{"content":"print(1)","path":"main.py"}],"submissionId":"sub-1"}',
    );
  });

  it("matches the shared client/server HMAC-v2 contract vector", () => {
    expect(
      signRunnerRequest(
        "runner-signature-contract-secret-32-bytes",
        "POST",
        "/v1/jobs",
        "1750000000",
        "nonce_abcdefghijklmnop",
        "request-contract-0001",
        "idempotency-contract-0001",
        '{"hello":"world"}',
      ),
    ).toBe(
      "sha256=6e66a3f44c830bf8f4a3ad660a36d1791dca9367eea79d5bfd2e4b4677895064",
    );
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("signs the exact request and verifies the response", async () => {
    const fetchMock = vi.fn((request, init) => Promise.resolve(signedResponse(request, init, {
      jobId: "job-1", submissionId: "sub-1", correlationId: "corr-1", requestHash: REQUEST_HASH, state: "COMPLETED", queuePosition: null, result: RUNNER_RESULT,
    })));
    const client = new RunnerClient("http://runner:4100", secret, fetchMock as typeof fetch);
    const result = await client.submit(request, "idem-1");
    expect(result.state).toBe("COMPLETED");
    const headers = fetchMock.mock.calls[0][1]?.headers as Record<string, string>;
    expect(headers["x-runner-signature"]).toMatch(/^sha256=[a-f0-9]{64}$/);
    expect(headers["x-runner-signature"]).toBe(
      signRunnerRequest(
        secret,
        "POST",
        "/v1/jobs",
        headers["x-runner-timestamp"]!,
        headers["x-runner-nonce"]!,
        headers["x-request-id"]!,
        "idem-1",
        serializeRunnerRequest(request),
      ),
    );
  });

  it("rejects an unsigned or tampered runner response", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ state: "COMPLETED" }), { status: 200 }));
    const client = new RunnerClient("http://runner:4100", secret, fetchMock);
    await expect(client.submit(request, "idem-1")).rejects.toMatchObject({
      name: "RunnerIndeterminateError",
      code: "RUNNER_RESPONSE_UNTRUSTED",
      indeterminate: true,
      remoteJobId: null,
    } satisfies Partial<RunnerIndeterminateError>);
  });

  it("rejects signed output that exceeds the submitted output budget", async () => {
    const fetchMock = vi.fn((requestInfo, init) => Promise.resolve(signedResponse(requestInfo, init, {
      jobId: "job-output-bound",
      submissionId: request.submissionId,
      correlationId: request.correlationId,
      requestHash: REQUEST_HASH,
      state: "COMPLETED",
      queuePosition: null,
      result: {
        ...RUNNER_RESULT,
        compile: { ...RUNNER_RESULT.compile, stdout: "x".repeat(65_537) },
      },
    })));

    await expect(new RunnerClient("http://runner:4100", secret, fetchMock as typeof fetch)
      .submit(request, "idem-output-bound")).rejects.toMatchObject({
        code: "RUNNER_RESPONSE_UNTRUSTED",
        indeterminate: true,
      });
  });

  it("rejects an oversized signed response body before parsing it", async () => {
    const fetchMock = vi.fn((requestInfo, init) => Promise.resolve(signedResponse(requestInfo, init, {
      jobId: "job-body-bound",
      submissionId: request.submissionId,
      correlationId: request.correlationId,
      requestHash: REQUEST_HASH,
      state: "COMPLETED",
      queuePosition: null,
      result: RUNNER_RESULT,
      padding: "x".repeat(2 * 1024 * 1024),
    })));

    await expect(new RunnerClient("http://runner:4100", secret, fetchMock as typeof fetch)
      .submit(request, "idem-body-bound")).rejects.toMatchObject({
        code: "RUNNER_RESPONSE_UNTRUSTED",
        indeterminate: true,
      });
  });

  it("rejects both same-length tampered signatures and malformed signed JSON", async () => {
    const sameLengthTamper = vi.fn((_request: RequestInfo | URL, init?: RequestInit) => {
      const response = signedResponse(_request, init, { state: "COMPLETED" });
      response.headers.set("x-runner-response-signature", `sha256=${"0".repeat(64)}`);
      return Promise.resolve(response);
    });
    await expect(new RunnerClient("http://runner:4100", secret, sameLengthTamper).submit(request, "idem-1"))
      .rejects.toMatchObject({ code: "RUNNER_RESPONSE_UNTRUSTED", remoteJobId: null });

    const malformed = vi.fn((_request: RequestInfo | URL, init?: RequestInit) =>
      Promise.resolve(signedRawResponse(init, "not-json")));
    await expect(new RunnerClient("http://runner:4100", secret, malformed).submit(request, "idem-2"))
      .rejects.toMatchObject({ code: "RUNNER_RESPONSE_UNTRUSTED", remoteJobId: null });
  });

  it("keeps an explicit signed pre-admission queue rejection determinate", async () => {
    const fetchMock = vi.fn((requestInfo, init) => Promise.resolve(signedResponse(
      requestInfo,
      init,
      { error: { code: "QUEUE_FULL", retryable: true } },
      429,
    )));
    const client = new RunnerClient("http://runner:4100/", secret, fetchMock as typeof fetch);

    await expect(client.submit(request, "idem-error")).rejects.toMatchObject({
      name: "RunnerClientError",
      code: "QUEUE_FULL",
      retryable: true,
      status: 429,
    });
    expect(client.baseUrl).toBe("http://runner:4100");
  });

  it("treats a signed POST 5xx as indeterminate because the job may already exist", async () => {
    const fetchMock = vi.fn((requestInfo, init) => Promise.resolve(signedResponse(requestInfo, init, {}, 500)));
    const client = new RunnerClient("http://runner:4100", secret, fetchMock as typeof fetch);

    await expect(client.submit(request, "idem-post-500")).rejects.toMatchObject({
      name: "RunnerIndeterminateError",
      code: "RUNNER_REQUEST_INDETERMINATE",
      remoteJobId: null,
    });
  });

  it.each([404, 500])("treats a signed GET %s for a known job as indeterminate", async (status) => {
    const fetchMock = vi.fn((requestInfo, init) => Promise.resolve(signedResponse(
      requestInfo,
      init,
      { error: { code: status === 404 ? "NOT_FOUND" : "INFRASTRUCTURE_ERROR", retryable: true } },
      status,
    )));
    const client = new RunnerClient("http://runner:4100", secret, fetchMock as typeof fetch);

    await expect(client.get("known-remote-job", request)).rejects.toMatchObject({
      code: "RUNNER_REQUEST_INDETERMINATE",
      remoteJobId: "known-remote-job",
      indeterminate: true,
    });
  });

  it.each([
    { submissionId: "cross-submission" },
    { correlationId: "cross-correlation" },
    { requestHash: "f".repeat(64) },
    { state: "UNKNOWN" },
    { queuePosition: -1 },
    { result: undefined },
    { state: "FAILED" },
    { state: "FAILED", result: undefined },
  ])("rejects a signed malformed or cross-bound POST response: %j", async (override) => {
    const fetchMock = vi.fn((requestInfo, init) => Promise.resolve(signedResponse(requestInfo, init, {
      jobId: "job-bound",
      submissionId: request.submissionId,
      correlationId: request.correlationId,
      requestHash: REQUEST_HASH,
      state: "COMPLETED",
      queuePosition: null,
      result: RUNNER_RESULT,
      ...override,
    })));
    const client = new RunnerClient("http://runner:4100", secret, fetchMock as typeof fetch);

    await expect(client.submit(request, "idem-cross-bound")).rejects.toMatchObject({
      code: "RUNNER_RESPONSE_UNTRUSTED",
      remoteJobId: null,
      indeterminate: true,
    });
  });

  it("rejects a signed GET response for a different job id", async () => {
    const fetchMock = vi.fn((requestInfo, init) => Promise.resolve(signedResponse(requestInfo, init, {
      jobId: "different-job",
      submissionId: request.submissionId,
      correlationId: request.correlationId,
      requestHash: REQUEST_HASH,
      state: "COMPLETED",
      queuePosition: null,
      result: RUNNER_RESULT,
    })));
    const client = new RunnerClient("http://runner:4100", secret, fetchMock as typeof fetch);

    await expect(client.get("expected-job", request)).rejects.toMatchObject({
      code: "RUNNER_RESPONSE_UNTRUSTED",
      remoteJobId: "expected-job",
    });
  });

  it.each([
    {
      tests: [{ id: "visible-1", visibility: "VISIBLE", category: "functional", status: "PASSED", feedbackCode: "OK" }],
      totals: { passed: 1, failed: 0, total: 1 },
    },
    {
      tests: [
        { id: "visible-1", visibility: "VISIBLE", category: "functional", status: "PASSED", feedbackCode: "OK" },
        { id: "visible-1", visibility: "VISIBLE", category: "functional", status: "PASSED", feedbackCode: "OK" },
      ],
      totals: { passed: 2, failed: 0, total: 2 },
    },
    {
      tests: [
        { id: "visible-1", visibility: "HIDDEN", category: "functional", status: "PASSED", feedbackCode: "OK" },
        { id: "hidden-1", visibility: "HIDDEN", category: "edge", status: "PASSED", feedbackCode: "OK" },
      ],
      totals: { passed: 2, failed: 0, total: 2 },
    },
  ])("rejects incomplete, duplicate, or cross-bound signed TEST results: %j", async (manifest) => {
    const requestHash = createHash("sha256").update(serializeRunnerRequest(testRequest)).digest("hex");
    const fetchMock = vi.fn((requestInfo, init) => Promise.resolve(signedResponse(requestInfo, init, {
      jobId: "test-job",
      submissionId: testRequest.submissionId,
      correlationId: testRequest.correlationId,
      requestHash,
      state: "COMPLETED",
      queuePosition: null,
      result: { ...RUNNER_RESULT, ...manifest },
    })));

    await expect(new RunnerClient("http://runner:4100", secret, fetchMock as typeof fetch)
      .submit(testRequest, "idem-test-manifest")).rejects.toMatchObject({
        code: "RUNNER_RESPONSE_UNTRUSTED",
        indeterminate: true,
      });
  });

  it("accepts a complete TEST manifest bound to the submitted cases", async () => {
    const requestHash = createHash("sha256").update(serializeRunnerRequest(testRequest)).digest("hex");
    const tests = testRequest.tests.map((test) => ({
      id: test.id,
      visibility: test.visibility,
      category: test.category,
      status: "PASSED",
      feedbackCode: "OK",
    }));
    const fetchMock = vi.fn((requestInfo, init) => Promise.resolve(signedResponse(requestInfo, init, {
      jobId: "test-job-complete",
      submissionId: testRequest.submissionId,
      correlationId: testRequest.correlationId,
      requestHash,
      state: "COMPLETED",
      queuePosition: null,
      result: { ...RUNNER_RESULT, tests, totals: { passed: 2, failed: 0, total: 2 } },
    })));

    await expect(new RunnerClient("http://runner:4100", secret, fetchMock as typeof fetch)
      .submit(testRequest, "idem-test-complete")).resolves.toMatchObject({ state: "COMPLETED" });
  });

  it("resumes an immutable known job with GET and never submits again", async () => {
    const fetchMock = vi.fn((requestInfo, init) => Promise.resolve(signedResponse(requestInfo, init, {
      jobId: "known-job",
      submissionId: request.submissionId,
      correlationId: request.correlationId,
      requestHash: REQUEST_HASH,
      state: "COMPLETED",
      queuePosition: null,
      result: RUNNER_RESULT,
    })));
    const client = new RunnerClient("http://runner:4100", secret, fetchMock as typeof fetch);

    await expect(client.waitForJob("known-job", request)).resolves.toMatchObject({ jobId: "known-job" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("http://runner:4100/v1/jobs/known-job");
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: "GET", body: undefined });
  });

  it("polls queued and running jobs until a terminal result", async () => {
    const states = ["QUEUED", "RUNNING", "COMPLETED"] as const;
    const fetchMock = vi.fn((requestInfo, init) => {
      const state = states[Math.min(fetchMock.mock.calls.length - 1, states.length - 1)];
      return Promise.resolve(signedResponse(requestInfo, init, {
        jobId: "job-1",
        submissionId: "sub-1",
        correlationId: "corr-1",
        requestHash: REQUEST_HASH,
        state,
        queuePosition: state === "QUEUED" ? 1 : null,
        ...(state === "COMPLETED" ? { result: RUNNER_RESULT } : {}),
      }));
    });
    const client = new RunnerClient("http://runner:4100", secret, fetchMock as typeof fetch);

    const result = await client.submitAndWait(request, "idem-poll", { pollMs: 0, timeoutMs: 1_000 });

    expect(result.state).toBe("COMPLETED");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[1][0]).toBe("http://runner:4100/v1/jobs/job-1");
    expect(fetchMock.mock.calls[1][1]).toEqual(expect.objectContaining({ method: "GET", body: undefined }));
  });

  it("applies default wait options and fails closed once the deadline is exhausted", async () => {
    const completedFetch = vi.fn((requestInfo, init) => Promise.resolve(signedResponse(requestInfo, init, {
      jobId: "job-done",
      submissionId: "sub-1",
      correlationId: "corr-1",
      requestHash: REQUEST_HASH,
      state: "COMPLETED",
      queuePosition: null,
      result: RUNNER_RESULT,
    })));
    await expect(new RunnerClient("http://runner:4100", secret, completedFetch as typeof fetch)
      .submitAndWait(request, "idem-defaults")).resolves.toMatchObject({ state: "COMPLETED" });

    const queuedFetch = vi.fn((requestInfo, init) => Promise.resolve(signedResponse(requestInfo, init, {
      jobId: "job-queued",
      submissionId: "sub-1",
      correlationId: "corr-1",
      requestHash: REQUEST_HASH,
      state: "QUEUED",
      queuePosition: 2,
    })));
    await expect(new RunnerClient("http://runner:4100", secret, queuedFetch as typeof fetch)
      .submitAndWait(request, "idem-timeout", { timeoutMs: -1 })).rejects.toMatchObject({
        code: "RUNNER_WAIT_INDETERMINATE",
        remoteJobId: "job-queued",
        indeterminate: true,
      });
    expect(queuedFetch).toHaveBeenCalledTimes(1);
  });

  it("aborts a hung signed request well before stale dispatch reconciliation", async () => {
    let observedSignal: AbortSignal | null = null;
    const fetchMock = vi.fn((_request: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        observedSignal = init?.signal ?? null;
        if (!observedSignal) return reject(new Error("missing abort signal"));
        observedSignal.addEventListener("abort", () => reject(observedSignal?.reason), { once: true });
      }));
    const client = new RunnerClient("http://runner:4100", secret, fetchMock as typeof fetch, 5);

    await expect(client.submit(request, "idem-hung")).rejects.toMatchObject({
      name: "RunnerIndeterminateError",
      code: "RUNNER_REQUEST_INDETERMINATE",
      retryable: true,
      status: 504,
      remoteJobId: null,
    } satisfies Partial<RunnerIndeterminateError>);
    expect((observedSignal as AbortSignal | null)?.aborted).toBe(true);
    expect(RUNNER_REQUEST_TIMEOUT_MS).toBeLessThan(120_000);
  });

  it("carries the known remote job id when polling becomes indeterminate", async () => {
    const fetchMock = vi.fn((_request: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      }));
    const client = new RunnerClient("http://runner:4100", secret, fetchMock as typeof fetch, 5);

    await expect(client.get("known-job-7")).rejects.toMatchObject({
      code: "RUNNER_REQUEST_INDETERMINATE",
      remoteJobId: "known-job-7",
      indeterminate: true,
    });
  });

  it("checks the unauthenticated minimal health contract without crossing the dispatch boundary", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      status: "ok",
      queueDepth: 1,
      activeJobs: 1,
      concurrency: 2,
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const client = new RunnerClient("http://runner:4100", secret, fetchMock);

    await expect(client.checkAvailability()).resolves.toEqual({
      available: true,
      status: "available",
      queueDepth: 1,
      activeJobs: 1,
      concurrency: 2,
    });
    expect(fetchMock).toHaveBeenCalledWith("http://runner:4100/healthz", expect.objectContaining({
      method: "GET",
      redirect: "error",
      cache: "no-store",
      signal: expect.any(AbortSignal),
    }));
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init).not.toHaveProperty("body");
    expect(init).not.toHaveProperty("headers");
    expect(RUNNER_HEALTH_TIMEOUT_MS).toBeLessThan(RUNNER_REQUEST_TIMEOUT_MS);
  });

  it("reports a definite offline state when the non-dispatching health request cannot connect", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("connect ECONNREFUSED"));
    const client = new RunnerClient("http://runner:4100", secret, fetchMock);

    await expect(client.checkAvailability()).resolves.toEqual({
      available: false,
      status: "offline",
      code: "RUNNER_OFFLINE",
    });
  });

  it.each([
    ["an HTTP failure", new Response("unhealthy", { status: 503 })],
    ["invalid JSON", new Response("not-json", { status: 200 })],
    ["an invalid health shape", new Response(JSON.stringify({
      status: "ok",
      queueDepth: -1,
      activeJobs: 0,
      concurrency: 2,
    }), { status: 200 })],
  ])("reports unavailable for %s", async (_label, response) => {
    const client = new RunnerClient(
      "http://runner:4100",
      secret,
      vi.fn().mockResolvedValue(response),
    );

    await expect(client.checkAvailability()).resolves.toEqual({
      available: false,
      status: "unavailable",
      code: "RUNNER_UNHEALTHY",
    });
  });

  it("validates job identifiers and configuration before making a request", async () => {
    expect(() => new RunnerClient("http://runner:4100", "too-short")).toThrow(/at least 32/i);
    expect(() => new RunnerClient("http://runner:4100", secret, fetch, 120_000)).toThrow(/timeout/i);
    const client = new RunnerClient("http://runner:4100", secret, vi.fn() as unknown as typeof fetch);
    await expect(client.get("unsafe/job?id=1")).rejects.toThrow(/invalid runner job id/i);

    vi.stubEnv("RUNNER_BASE_URL", "");
    vi.stubEnv("RUNNER_SHARED_SECRET", "");
    expect(() => configuredRunnerClient()).toThrow(/not configured/i);

    vi.stubEnv("RUNNER_BASE_URL", "http://runner:4100/");
    vi.stubEnv("RUNNER_SHARED_SECRET", secret);
    expect(configuredRunnerClient()).toMatchObject({ baseUrl: "http://runner:4100" });
  });
});
