import { createServer, request as httpRequest } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REVIEWED_UPSTREAM = "http://192.168.122.12:4100";
const REVIEWED_LISTEN_HOST = "172.29.41.2";
const REVIEWED_LISTEN_PORT = 4100;
const MAX_REQUEST_BYTES = 2 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const UPSTREAM_TIMEOUT_MS = 15_000;
const GATEWAY_HEALTH_PATH = "/__codestead_runner_gateway_health";
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function exactPositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
  return value;
}

function validatedUpstream(value) {
  const upstream = value instanceof URL ? new URL(value.href) : new URL(value);
  if (
    upstream.protocol !== "http:" ||
    upstream.username ||
    upstream.password ||
    upstream.pathname !== "/" ||
    upstream.search ||
    upstream.hash
  ) {
    throw new TypeError("runner gateway upstream must be an origin-only HTTP URL");
  }
  return upstream;
}

function forwardHeaders(headers, host) {
  const forwarded = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined && !HOP_BY_HOP_HEADERS.has(name.toLowerCase())) {
      forwarded[name] = value;
    }
  }
  forwarded.host = host;
  forwarded.connection = "close";
  return forwarded;
}

function responseHeaders(headers) {
  const forwarded = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined && !HOP_BY_HOP_HEADERS.has(name.toLowerCase())) {
      forwarded[name] = value;
    }
  }
  forwarded.connection = "close";
  return forwarded;
}

function empty(response, statusCode) {
  if (response.headersSent || response.destroyed) return;
  response.writeHead(statusCode, {
    "cache-control": "no-store",
    "content-length": "0",
    connection: "close",
  });
  response.end();
}

function contentLength(request) {
  const raw = request.headers["content-length"];
  if (raw === undefined) return null;
  if (typeof raw !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(raw)) return Number.NaN;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) ? parsed : Number.NaN;
}

export function createRunnerGateway({
  upstream,
  maxRequestBytes = MAX_REQUEST_BYTES,
  maxResponseBytes = MAX_RESPONSE_BYTES,
  upstreamTimeoutMs = UPSTREAM_TIMEOUT_MS,
}) {
  const target = validatedUpstream(upstream);
  exactPositiveInteger(maxRequestBytes, "maxRequestBytes");
  exactPositiveInteger(maxResponseBytes, "maxResponseBytes");
  exactPositiveInteger(upstreamTimeoutMs, "upstreamTimeoutMs");

  return createServer((clientRequest, clientResponse) => {
    const method = clientRequest.method ?? "";
    const targetPath = clientRequest.url ?? "";
    if (method === "GET" && targetPath === GATEWAY_HEALTH_PATH) {
      clientResponse.writeHead(204, {
        "cache-control": "no-store",
        connection: "close",
      });
      clientResponse.end();
      return;
    }
    if (
      (method !== "GET" && method !== "POST") ||
      !targetPath.startsWith("/") ||
      targetPath.startsWith("//") ||
      /[\r\n]/u.test(targetPath)
    ) {
      clientRequest.resume();
      empty(clientResponse, 400);
      return;
    }

    const declaredLength = contentLength(clientRequest);
    if (
      Number.isNaN(declaredLength) ||
      (declaredLength !== null && declaredLength > maxRequestBytes)
    ) {
      clientRequest.resume();
      empty(clientResponse, 413);
      return;
    }

    let requestBytes = 0;
    let responseBytes = 0;
    let terminal = false;
    let activeUpstreamResponse;
    const upstreamRequest = httpRequest(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port,
        method,
        path: targetPath,
        headers: forwardHeaders(clientRequest.headers, target.host),
        agent: false,
      },
      (upstreamResponse) => {
        if (terminal) {
          upstreamResponse.destroy();
          return;
        }
        activeUpstreamResponse = upstreamResponse;
        clientResponse.writeHead(
          upstreamResponse.statusCode ?? 502,
          responseHeaders(upstreamResponse.headers),
        );
        upstreamResponse.on("data", (chunk) => {
          responseBytes += chunk.length;
          if (responseBytes > maxResponseBytes && !terminal) {
            terminal = true;
            upstreamResponse.destroy();
            clientResponse.destroy();
          }
        });
        upstreamResponse.once("aborted", () => failUpstream(502));
        upstreamResponse.once("error", () => failUpstream(502));
        upstreamResponse.once("end", () => {
          if (!terminal) terminal = true;
          activeUpstreamResponse = undefined;
        });
        upstreamResponse.pipe(clientResponse);
      },
    );

    const failUpstream = (statusCode) => {
      if (terminal) return;
      terminal = true;
      activeUpstreamResponse?.destroy();
      upstreamRequest.destroy();
      clientRequest.resume();
      if (clientResponse.headersSent) {
        clientResponse.destroy();
      } else {
        empty(clientResponse, statusCode);
      }
    };
    upstreamRequest.setTimeout(upstreamTimeoutMs, () => failUpstream(504));
    upstreamRequest.on("error", () => failUpstream(502));
    clientRequest.on("aborted", () => {
      terminal = true;
      upstreamRequest.destroy();
    });
    clientRequest.on("error", () => {
      terminal = true;
      upstreamRequest.destroy();
    });
    clientRequest.on("data", (chunk) => {
      if (terminal) return;
      requestBytes += chunk.length;
      if (requestBytes > maxRequestBytes) {
        failUpstream(413);
        return;
      }
      if (!upstreamRequest.write(chunk)) {
        clientRequest.pause();
        upstreamRequest.once("drain", () => clientRequest.resume());
      }
    });
    clientRequest.on("end", () => {
      if (!terminal) upstreamRequest.end();
    });
  });
}

function productionConfiguration(environment) {
  if (
    environment.RUNNER_GATEWAY_UPSTREAM !== REVIEWED_UPSTREAM ||
    environment.RUNNER_GATEWAY_LISTEN_HOST !== REVIEWED_LISTEN_HOST ||
    environment.RUNNER_GATEWAY_LISTEN_PORT !== String(REVIEWED_LISTEN_PORT)
  ) {
    throw new TypeError("unreviewed production runner gateway configuration");
  }
  return {
    upstream: new URL(REVIEWED_UPSTREAM),
    host: REVIEWED_LISTEN_HOST,
    port: REVIEWED_LISTEN_PORT,
  };
}

function isEntrypoint() {
  if (!process.argv[1]) return false;
  return path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
}

if (isEntrypoint()) {
  let configuration;
  try {
    configuration = productionConfiguration(process.env);
  } catch {
    process.stderr.write("runner gateway configuration rejected\n");
    process.exit(1);
  }
  const server = createRunnerGateway({ upstream: configuration.upstream });
  server.on("error", () => {
    process.stderr.write("runner gateway failed\n");
    process.exitCode = 1;
  });
  server.listen(configuration.port, configuration.host);

  const shutdown = () => {
    const deadline = setTimeout(() => server.closeAllConnections(), 5000);
    deadline.unref();
    server.close(() => {
      clearTimeout(deadline);
      process.exit();
    });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
