import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  HmacAuthenticator,
  NonceStore,
  signRequest,
  signResponse,
} from "../auth.js";
import type { JobExecutor } from "../docker-executor.js";
import { createRunnerHttpServer } from "../http-server.js";
import { RunnerService } from "../service.js";
import type { RunnerResult } from "../types.js";
import {
  jobRequest,
  runnerResult,
  testConfig,
} from "./fixtures.js";

const secret = "test-secret-that-is-at-least-32-bytes-long";
const nowMs = 1_750_000_000_000;
let nonceCounter = 0;

class FakeJobExecutor implements JobExecutor {
  readonly calls: string[] = [];
  readonly #result: RunnerResult;

  constructor(result: RunnerResult = runnerResult()) {
    this.#result = result;
  }

  async execute(
    _job: Parameters<JobExecutor["execute"]>[0],
    requestHash: string,
  ): Promise<RunnerResult> {
    this.calls.push(requestHash);
    return { ...this.#result, requestHash };
  }
}

class HangingJobExecutor implements JobExecutor {
  readonly calls: string[] = [];

  async execute(
    _job: Parameters<JobExecutor["execute"]>[0],
    requestHash: string,
  ): Promise<RunnerResult> {
    this.calls.push(requestHash);
    return new Promise<RunnerResult>(() => undefined);
  }
}

const servers: ReturnType<typeof createRunnerHttpServer>[] = [];
const services: RunnerService[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => server.close(() => resolve())),
    ),
  );
  for (const service of services.splice(0)) {
    service.close();
  }
});

async function setup() {
  const config = testConfig({ sharedSecret: secret });
  const executor = new FakeJobExecutor();
  const service = new RunnerService(config, executor, {
    clock: () => nowMs,
    jobId: () => "job-fixed-1",
  });
  services.push(service);
  const auth = new HmacAuthenticator(
    secret,
    config.authMaxSkewSeconds,
    new NonceStore(config.nonceTtlSeconds),
  );
  const server = createRunnerHttpServer(
    config,
    service,
    auth,
    () => nowMs,
  );
  servers.push(server);
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    service,
    executor,
  };
}

function headers(
  method: string,
  path: string,
  body: string,
  additions: Record<string, string> = {},
): Record<string, string> {
  nonceCounter += 1;
  const timestamp = String(Math.floor(nowMs / 1_000));
  const nonce = `nonce_${String(nonceCounter).padStart(20, "0")}`;
  const requestId = additions["x-request-id"] ?? "request-fixed-1";
  const idempotencyKey = additions["x-idempotency-key"] ?? "";
  return {
    "x-runner-timestamp": timestamp,
    "x-runner-nonce": nonce,
    "x-runner-signature": signRequest(
      secret,
      method,
      path,
      timestamp,
      nonce,
      requestId,
      idempotencyKey,
      body,
    ),
    "x-request-id": requestId,
    ...additions,
  };
}

describe("HTTP runner service", () => {
  it("serves an exact minimal unauthenticated health envelope", async () => {
    const { baseUrl, service } = await setup();
    const response = await fetch(`${baseUrl}/healthz`, {
      headers: { "x-request-id": "health-request-0001" },
    });
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toBe(
      `{"status":"ok","queueDepth":0,"activeJobs":0,"concurrency":2,"generatedAtEpoch":${Math.floor(nowMs / 1_000)}}`,
    );
    expect(JSON.parse(body)).toEqual({
      status: "ok",
      queueDepth: 0,
      activeJobs: 0,
      concurrency: 2,
      generatedAtEpoch: Math.floor(nowMs / 1_000),
    });
    expect(body).not.toContain(secret);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(service.metrics.authFailures).toBe(0);
  });

  it("signs health deterministically over request ID, status, and body", async () => {
    const { baseUrl } = await setup();
    const requestId = "health-request-0002";

    const first = await fetch(`${baseUrl}/healthz`, {
      headers: { "x-request-id": requestId },
    });
    const firstBody = await first.text();
    const firstSignature = first.headers.get("x-runner-response-signature");
    const second = await fetch(`${baseUrl}/healthz`, {
      headers: { "x-request-id": requestId },
    });
    const secondBody = await second.text();
    const secondSignature = second.headers.get("x-runner-response-signature");

    expect(first.status).toBe(200);
    expect(first.headers.get("x-request-id")).toBe(requestId);
    expect(firstBody).toBe(secondBody);
    expect(firstSignature).toBe(secondSignature);
    expect(firstSignature).toBe(
      signResponse(secret, requestId, 200, firstBody),
    );
    expect(firstSignature).not.toBe(
      signResponse(secret, "health-request-mutated", 200, firstBody),
    );
    expect(firstSignature).not.toBe(
      signResponse(secret, requestId, 503, firstBody),
    );
    expect(firstSignature).not.toBe(
      signResponse(secret, requestId, 200, `${firstBody} `),
    );
  });

  it("rejects unsigned job submission", async () => {
    const { baseUrl, service } = await setup();
    const response = await fetch(`${baseUrl}/v1/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(jobRequest()),
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      error: { code: "AUTH_REQUIRED" },
    });
    expect(service.metrics.authFailures).toBe(1);
  });

  it("rejects key-only mutation before duplicate execution", async () => {
    const { baseUrl, executor } = await setup();
    const body = JSON.stringify(jobRequest());
    const signed = headers("POST", "/v1/jobs", body, {
      "content-type": "application/json",
      "x-idempotency-key": "idempotency-original-0001",
    });
    signed["x-idempotency-key"] = "idempotency-mutated-0001";
    const response = await fetch(`${baseUrl}/v1/jobs`, {
      method: "POST",
      headers: signed,
      body,
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      error: { code: "AUTH_INVALID" },
    });
    expect(executor.calls).toHaveLength(0);
  });

  it("submits once, signs the response, and returns idempotent replay", async () => {
    const { baseUrl, executor } = await setup();
    const body = JSON.stringify(jobRequest());
    const additions = {
      "content-type": "application/json",
      "x-idempotency-key": "idempotency-key-0001",
    };
    const first = await fetch(`${baseUrl}/v1/jobs`, {
      method: "POST",
      headers: headers("POST", "/v1/jobs", body, additions),
      body,
    });
    expect(first.status).toBe(202);
    const firstText = await first.text();
    const requestId = first.headers.get("x-request-id")!;
    expect(first.headers.get("x-runner-response-signature")).toBe(
      signResponse(secret, requestId, 202, firstText),
    );
    const firstBody = JSON.parse(firstText) as { jobId: string };
    expect(firstBody.jobId).toBe("job-fixed-1");

    const second = await fetch(`${baseUrl}/v1/jobs`, {
      method: "POST",
      headers: headers("POST", "/v1/jobs", body, additions),
      body,
    });
    expect(second.status).toBe(200);
    expect((await second.json()) as { jobId: string }).toMatchObject({
      jobId: "job-fixed-1",
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(executor.calls).toHaveLength(1);
  });

  it("rejects an exact captured POST throughout the full future-to-past signature window", async () => {
    let clockMs = nowMs;
    const config = testConfig({
      sharedSecret: secret,
      authMaxSkewSeconds: 300,
      nonceTtlSeconds: 601,
      idempotencyTtlMs: 601_000,
    });
    const executor = new FakeJobExecutor();
    const service = new RunnerService(config, executor, {
      clock: () => clockMs,
      jobId: () => "job-full-window-1",
    });
    services.push(service);
    const auth = new HmacAuthenticator(
      secret,
      config.authMaxSkewSeconds,
      new NonceStore(config.nonceTtlSeconds),
    );
    const server = createRunnerHttpServer(config, service, auth, () => clockMs);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const body = JSON.stringify(jobRequest());
    const timestamp = String(Math.floor((nowMs + 300_000) / 1_000));
    const nonce = "nonce_full_window_000001";
    const requestId = "request-full-window-1";
    const idempotencyKey = "idempotency-full-window-0001";
    const capturedHeaders = {
      "content-type": "application/json",
      "x-runner-timestamp": timestamp,
      "x-runner-nonce": nonce,
      "x-request-id": requestId,
      "x-idempotency-key": idempotencyKey,
      "x-runner-signature": signRequest(
        secret,
        "POST",
        "/v1/jobs",
        timestamp,
        nonce,
        requestId,
        idempotencyKey,
        body,
      ),
    };

    const first = await fetch(`${baseUrl}/v1/jobs`, {
      method: "POST",
      headers: capturedHeaders,
      body,
    });
    expect(first.status).toBe(202);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(executor.calls).toHaveLength(1);

    clockMs = nowMs + 600_000;
    const replay = await fetch(`${baseUrl}/v1/jobs`, {
      method: "POST",
      headers: capturedHeaders,
      body,
    });
    expect(replay.status).toBe(409);
    expect(await replay.json()).toMatchObject({ error: { code: "AUTH_REPLAY" } });
    expect(executor.calls).toHaveLength(1);
  });

  it("rejects idempotency key reuse for changed body", async () => {
    const { baseUrl } = await setup();
    const additions = {
      "content-type": "application/json",
      "x-idempotency-key": "idempotency-key-0002",
    };
    const firstBody = JSON.stringify(jobRequest());
    await fetch(`${baseUrl}/v1/jobs`, {
      method: "POST",
      headers: headers("POST", "/v1/jobs", firstBody, additions),
      body: firstBody,
    });
    const changedBody = JSON.stringify(
      jobRequest("python", { submissionId: "submission-2" }),
    );
    const conflict = await fetch(`${baseUrl}/v1/jobs`, {
      method: "POST",
      headers: headers("POST", "/v1/jobs", changedBody, additions),
      body: changedBody,
    });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({
      error: { code: "IDEMPOTENCY_CONFLICT" },
    });
  });

  it("recovers a crashed running job for signed GET and POST replay", async () => {
    const config = testConfig({ sharedSecret: secret });
    const firstExecutor = new HangingJobExecutor();
    const firstService = new RunnerService(config, firstExecutor, {
      clock: () => nowMs,
      jobId: () => "job-restart-1",
    });
    services.push(firstService);
    const firstServer = createRunnerHttpServer(
      config,
      firstService,
      new HmacAuthenticator(secret, 300, new NonceStore(600)),
      () => nowMs,
    );
    servers.push(firstServer);
    await new Promise<void>((resolve) =>
      firstServer.listen(0, "127.0.0.1", () => resolve()),
    );
    const firstAddress = firstServer.address() as AddressInfo;
    const firstUrl = `http://127.0.0.1:${firstAddress.port}`;
    const body = JSON.stringify(jobRequest());
    const additions = {
      "content-type": "application/json",
      "x-idempotency-key": "idempotency-restart-0001",
    };
    const submitted = await fetch(`${firstUrl}/v1/jobs`, {
      method: "POST",
      headers: headers("POST", "/v1/jobs", body, additions),
      body,
    });
    expect(submitted.status).toBe(202);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(firstService.getJob("job-restart-1")?.state).toBe("RUNNING");
    expect(firstExecutor.calls).toHaveLength(1);

    await new Promise<void>((resolve) => firstServer.close(() => resolve()));
    firstService.close();

    const replacementExecutor = new FakeJobExecutor();
    const replacementConfig = {
      ...config,
      runtimes: {
        ...config.runtimes,
        python: {
          ...config.runtimes.python,
          version: "Python 3.15",
        },
      },
    };
    const replacementService = new RunnerService(
      replacementConfig,
      replacementExecutor,
      { clock: () => nowMs },
    );
    services.push(replacementService);
    const replacementServer = createRunnerHttpServer(
      replacementConfig,
      replacementService,
      new HmacAuthenticator(secret, 300, new NonceStore(600)),
      () => nowMs,
    );
    servers.push(replacementServer);
    await new Promise<void>((resolve) =>
      replacementServer.listen(0, "127.0.0.1", () => resolve()),
    );
    const replacementAddress = replacementServer.address() as AddressInfo;
    const replacementUrl = `http://127.0.0.1:${replacementAddress.port}`;

    const getPath = "/v1/jobs/job-restart-1";
    const recovered = await fetch(`${replacementUrl}${getPath}`, {
      headers: headers("GET", getPath, ""),
    });
    expect(recovered.status).toBe(200);
    const recoveredText = await recovered.text();
    const recoveredRequestId = recovered.headers.get("x-request-id")!;
    expect(recovered.headers.get("x-runner-response-signature")).toBe(
      signResponse(secret, recoveredRequestId, 200, recoveredText),
    );
    expect(JSON.parse(recoveredText)).toMatchObject({
      jobId: "job-restart-1",
      submissionId: "submission-1",
      correlationId: "correlation-1",
      state: "FAILED",
      error: {
        code: "RUNNER_RESTART_RECOVERED",
        retryable: true,
      },
    });

    const replay = await fetch(`${replacementUrl}/v1/jobs`, {
      method: "POST",
      headers: headers("POST", "/v1/jobs", body, additions),
      body,
    });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({
      jobId: "job-restart-1",
      state: "FAILED",
    });
    expect(replacementExecutor.calls).toHaveLength(0);

    const changedBody = JSON.stringify(
      jobRequest("python", { correlationId: "correlation-changed" }),
    );
    const conflict = await fetch(`${replacementUrl}/v1/jobs`, {
      method: "POST",
      headers: headers("POST", "/v1/jobs", changedBody, additions),
      body: changedBody,
    });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({
      error: { code: "IDEMPOTENCY_CONFLICT" },
    });
  });

  it("retrieves completed jobs without exposing submitted source", async () => {
    const { baseUrl } = await setup();
    const body = JSON.stringify(jobRequest());
    await fetch(`${baseUrl}/v1/jobs`, {
      method: "POST",
      headers: headers("POST", "/v1/jobs", body, {
        "content-type": "application/json",
        "x-idempotency-key": "idempotency-key-0003",
      }),
      body,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    const path = "/v1/jobs/job-fixed-1";
    const response = await fetch(`${baseUrl}${path}`, {
      headers: headers("GET", path, ""),
    });
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(JSON.parse(text)).toMatchObject({
      state: "COMPLETED",
      result: { status: "ACCEPTED" },
    });
    expect(text).not.toContain("learner source");
  });

  it("requires authentication for Prometheus metrics", async () => {
    const { baseUrl } = await setup();
    expect((await fetch(`${baseUrl}/metrics`)).status).toBe(401);
    const response = await fetch(`${baseUrl}/metrics`, {
      headers: headers("GET", "/metrics", ""),
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("runner_queue_depth");
  });

  it("rejects query parameters before routing", async () => {
    const { baseUrl } = await setup();
    const response = await fetch(`${baseUrl}/healthz?verbose=true`);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: "BAD_REQUEST" },
    });
  });
});
