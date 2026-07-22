import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, request as httpRequest } from "node:http";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "../..");
const gatewayUrl = pathToFileURL(path.join(root, "infra/runner-gateway/server.mjs")).href;

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address === "object");
  return address.port;
}

function closeServer(server) {
  server.closeAllConnections();
  return new Promise((resolve) => server.close(resolve));
}

function observePrematureClose(url, deadlineMs) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    let settled = false;
    let request;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      resolve({ ...result, elapsedMs: Date.now() - startedAt });
    };
    const deadline = setTimeout(() => {
      request?.destroy();
      reject(new Error(`gateway downstream remained open beyond ${deadlineMs}ms`));
    }, deadlineMs);

    request = httpRequest(url, { agent: false }, (response) => {
      const chunks = [];
      let ended = false;
      response.on("data", (chunk) => chunks.push(chunk));
      response.once("end", () => {
        ended = true;
        finish({ event: "end", statusCode: response.statusCode, body: Buffer.concat(chunks) });
      });
      response.once("aborted", () =>
        finish({ event: "aborted", statusCode: response.statusCode, body: Buffer.concat(chunks) }),
      );
      response.once("error", () =>
        finish({ event: "error", statusCode: response.statusCode, body: Buffer.concat(chunks) }),
      );
      response.once("close", () => {
        if (!ended) {
          finish({ event: "close", statusCode: response.statusCode, body: Buffer.concat(chunks) });
        }
      });
    });
    request.once("error", (error) => {
      if (!settled) reject(error);
    });
    request.end();
  });
}

for (const mode of ["stall", "reset"]) {
  test(`gateway closes a downstream response when the upstream ${mode}s after headers`, async (context) => {
    const { createRunnerGateway } = await import(gatewayUrl);
    const upstream = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/plain", connection: "close" });
      response.write("safe-prefix");
      if (mode === "reset") setImmediate(() => response.socket?.destroy());
    });
    const upstreamPort = await listen(upstream);
    context.after(() => closeServer(upstream));

    const gateway = createRunnerGateway({
      upstream: new URL(`http://127.0.0.1:${upstreamPort}`),
      upstreamTimeoutMs: 75,
    });
    const gatewayPort = await listen(gateway);
    context.after(() => closeServer(gateway));

    const result = await observePrematureClose(`http://127.0.0.1:${gatewayPort}/v1/jobs`, 1000);
    assert.equal(result.statusCode, 200, "the test must exercise failure after upstream headers");
    assert.notEqual(result.event, "end", "a partial upstream response must never look complete");
    assert.equal(result.body.toString("utf8"), "safe-prefix", "the gateway must not append diagnostic data");
    assert.ok(result.elapsedMs < 1000, `downstream close took ${result.elapsedMs}ms`);
  });
}
