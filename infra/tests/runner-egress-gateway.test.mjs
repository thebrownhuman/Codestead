import assert from "node:assert/strict";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "../..");
const gatewayPath = path.join(root, "infra/runner-gateway/server.mjs");
const gatewayUrl = pathToFileURL(gatewayPath).href;

test("gateway exists before its behavior is exercised", () => {
  assert.equal(existsSync(gatewayPath), true, "runner gateway implementation is missing");
});

test("gateway streams the exact runner request without logging or retaining secrets", async (context) => {
  if (!existsSync(gatewayPath)) return;
  const { createRunnerGateway } = await import(gatewayUrl);
  const observed = [];
  const upstream = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      observed.push({
        method: request.method,
        url: request.url,
        authorization: request.headers.authorization,
        connection: request.headers.connection,
        host: request.headers.host,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      response.writeHead(202, {
        "content-type": "application/json",
        connection: "close",
        "x-runner-request-id": "safe-request-id",
      });
      response.end('{"status":"accepted"}');
    });
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  context.after(() => upstream.close());
  const upstreamAddress = upstream.address();
  assert(upstreamAddress && typeof upstreamAddress === "object");

  const gateway = createRunnerGateway({
    upstream: new URL(`http://127.0.0.1:${upstreamAddress.port}`),
    maxRequestBytes: 2048,
    upstreamTimeoutMs: 2000,
  });
  gateway.listen(0, "127.0.0.1");
  await once(gateway, "listening");
  context.after(() => gateway.close());
  const gatewayAddress = gateway.address();
  assert(gatewayAddress && typeof gatewayAddress === "object");

  const response = await fetch(
    `http://127.0.0.1:${gatewayAddress.port}/v1/jobs`,
    {
      method: "POST",
      headers: {
        authorization: "Runner secret-material-must-not-be-logged",
        connection: "close",
        "content-type": "application/json",
        "x-codestead-request-id": "safe-request-id",
      },
      body: '{"language":"python"}',
    },
  );
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { status: "accepted" });
  assert.equal(response.headers.get("x-runner-request-id"), "safe-request-id");
  assert.deepEqual(observed, [
    {
      method: "POST",
      url: "/v1/jobs",
      authorization: "Runner secret-material-must-not-be-logged",
      connection: "close",
      host: `127.0.0.1:${upstreamAddress.port}`,
      body: '{"language":"python"}',
    },
  ]);
});

test("gateway rejects a declared oversized request before the runner", async (context) => {
  if (!existsSync(gatewayPath)) return;
  const { createRunnerGateway } = await import(gatewayUrl);
  let upstreamRequests = 0;
  const upstream = createServer((_request, response) => {
    upstreamRequests += 1;
    response.end();
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  context.after(() => upstream.close());
  const upstreamAddress = upstream.address();
  assert(upstreamAddress && typeof upstreamAddress === "object");

  const gateway = createRunnerGateway({
    upstream: new URL(`http://127.0.0.1:${upstreamAddress.port}`),
    maxRequestBytes: 16,
    upstreamTimeoutMs: 2000,
  });
  gateway.listen(0, "127.0.0.1");
  await once(gateway, "listening");
  context.after(() => gateway.close());
  const gatewayAddress = gateway.address();
  assert(gatewayAddress && typeof gatewayAddress === "object");
  const base = `http://127.0.0.1:${gatewayAddress.port}`;

  const oversized = await fetch(`${base}/v1/jobs`, {
    method: "POST",
    headers: { "content-length": "17" },
    body: "x".repeat(17),
  });
  assert.equal(oversized.status, 413);
  assert.equal(await oversized.text(), "");

  assert.equal(upstreamRequests, 0);
});

test("production entrypoint rejects every upstream except the reviewed KVM address", () => {
  if (!existsSync(gatewayPath)) return;
  const result = spawnSync(process.execPath, [gatewayPath], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      RUNNER_GATEWAY_UPSTREAM: "http://127.0.0.1:4100",
      RUNNER_GATEWAY_LISTEN_HOST: "127.0.0.1",
      RUNNER_GATEWAY_LISTEN_PORT: "0",
    },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /^runner gateway configuration rejected\n$/u);
  assert.equal(result.stdout, "");
});
