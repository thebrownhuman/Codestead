import { randomUUID } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import {
  HmacAuthenticator,
  sha256Hex,
} from "./auth.js";
import type { RunnerConfig } from "./config.js";
import { RunnerError } from "./errors.js";
import type { RunnerService } from "./service.js";

const IDEMPOTENCY_KEY = "x-idempotency-key";
const REQUEST_ID = "x-request-id";
const RESPONSE_SIGNATURE = "x-runner-response-signature";

function header(
  request: IncomingMessage,
  name: string,
  required = true,
): string | undefined {
  const value = request.headers[name];
  if (typeof value !== "string" || value.trim() === "") {
    if (required) {
      throw new RunnerError(
        "BAD_REQUEST",
        `missing header ${name}`,
        400,
      );
    }
    return undefined;
  }
  return value;
}

async function readBody(
  request: IncomingMessage,
  maximumBytes: number,
): Promise<Buffer> {
  const declared = request.headers["content-length"];
  if (
    typeof declared === "string" &&
    Number.isFinite(Number(declared)) &&
    Number(declared) > maximumBytes
  ) {
    throw new RunnerError(
      "BODY_TOO_LARGE",
      "request body is too large",
      413,
    );
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const rawChunk of request) {
    const chunk = Buffer.isBuffer(rawChunk)
      ? rawChunk
      : Buffer.from(rawChunk);
    total += chunk.length;
    if (total > maximumBytes) {
      throw new RunnerError(
        "BODY_TOO_LARGE",
        "request body is too large",
        413,
      );
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function safeRequestId(value: string | undefined): string {
  return value !== undefined && /^[A-Za-z0-9._:-]{8,128}$/.test(value)
    ? value
    : randomUUID();
}

function send(
  response: ServerResponse,
  statusCode: number,
  body: string,
  contentType: string,
  requestId: string,
  authenticator?: HmacAuthenticator,
): void {
  response.statusCode = statusCode;
  response.setHeader("content-type", contentType);
  response.setHeader("cache-control", "no-store");
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader(REQUEST_ID, requestId);
  if (authenticator !== undefined) {
    response.setHeader(
      RESPONSE_SIGNATURE,
      authenticator.signResponse(requestId, statusCode, body),
    );
  }
  response.end(body);
}

function json(
  response: ServerResponse,
  statusCode: number,
  value: unknown,
  requestId: string,
  authenticator?: HmacAuthenticator,
): void {
  send(
    response,
    statusCode,
    JSON.stringify(value),
    "application/json; charset=utf-8",
    requestId,
    authenticator,
  );
}

function parseJson(body: Buffer): unknown {
  try {
    return JSON.parse(body.toString("utf8")) as unknown;
  } catch {
    throw new RunnerError(
      "BAD_REQUEST",
      "request body must be valid JSON",
      400,
    );
  }
}

export function createRunnerHttpServer(
  config: RunnerConfig,
  service: RunnerService,
  authenticator: HmacAuthenticator,
  clock: () => number = Date.now,
): Server {
  return createServer(async (request, response) => {
    const requestId = safeRequestId(
      header(request, REQUEST_ID, false),
    );
    let authenticated = false;
    try {
      const url = new URL(
        request.url ?? "/",
        "http://runner.internal",
      );
      if (url.search !== "") {
        throw new RunnerError(
          "BAD_REQUEST",
          "query parameters are not supported",
          400,
        );
      }
      const method = request.method ?? "GET";
      const body = await readBody(request, config.maxBodyBytes);

      if (method === "GET" && url.pathname === "/healthz") {
        json(response, 200, service.health(), requestId);
        return;
      }

      try {
        authenticator.verify({
          method,
          path: url.pathname,
          headers: request.headers,
          body,
          nowMs: clock(),
        });
        authenticated = true;
      } catch (error) {
        service.metrics.authFailures += 1;
        throw error;
      }

      if (method === "GET" && url.pathname === "/metrics") {
        send(
          response,
          200,
          service.metrics.render(
            service.queueDepth,
            service.activeJobs,
            clock(),
          ),
          "text/plain; version=0.0.4; charset=utf-8",
          requestId,
          authenticator,
        );
        return;
      }

      if (method === "POST" && url.pathname === "/v1/jobs") {
        const contentType = request.headers["content-type"];
        if (
          typeof contentType !== "string" ||
          !contentType.toLowerCase().startsWith("application/json")
        ) {
          throw new RunnerError(
            "BAD_REQUEST",
            "content-type must be application/json",
            415,
          );
        }
        const idempotencyKey = header(request, IDEMPOTENCY_KEY);
        const submitted = service.submit(
          parseJson(body),
          idempotencyKey!,
          sha256Hex(body),
        );
        json(
          response,
          submitted.idempotencyHit ? 200 : 202,
          submitted.job,
          requestId,
          authenticator,
        );
        return;
      }

      const jobMatch = /^\/v1\/jobs\/([A-Za-z0-9._:-]{1,128})$/.exec(
        url.pathname,
      );
      if (method === "GET" && jobMatch !== null) {
        const jobId = jobMatch[1]!;
        const job = service.getJob(jobId);
        if (job === undefined) {
          throw new RunnerError(
            "NOT_FOUND",
            "job was not found",
            404,
          );
        }
        json(response, 200, job, requestId, authenticator);
        return;
      }

      throw new RunnerError("NOT_FOUND", "route was not found", 404);
    } catch (error) {
      const runnerError =
        error instanceof RunnerError
          ? error
          : new RunnerError(
              "INFRASTRUCTURE_ERROR",
              "internal runner failure",
              500,
              true,
            );
      json(
        response,
        runnerError.httpStatus,
        {
          error: {
            code: runnerError.code,
            retryable: runnerError.retryable,
          },
          requestId,
        },
        requestId,
        authenticated ? authenticator : undefined,
      );
    }
  });
}
