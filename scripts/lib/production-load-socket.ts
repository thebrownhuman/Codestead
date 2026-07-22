import { lstat } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import path from "node:path";

import type {
  ProductionLoadControlOperation,
  ProductionLoadControlTransport,
} from "./production-load-control";

export type ProductionLoadSocketResponse = {
  readonly statusCode: number;
  readonly contentType: string;
  readonly body: unknown;
};

export type ProductionLoadSocketRequest = {
  readonly socketPath: string;
  readonly requestPath: "/v1/load-control";
  readonly body: string;
  readonly timeoutMs: number;
  readonly maxResponseBytes: number;
  readonly signal?: AbortSignal;
};

export type ProductionLoadSocketRequester = (
  input: ProductionLoadSocketRequest,
) => Promise<ProductionLoadSocketResponse>;

export type ProductionLoadSocketOptions = {
  readonly socketPath: string;
  readonly requester?: ProductionLoadSocketRequester;
  readonly verifySocket?: (socketPath: string) => Promise<void>;
};

const operations = new Set<ProductionLoadControlOperation>([
  "seed",
  "baseline",
  "sample",
  "runner_observation",
  "fault_reset",
  "fault_probe",
  "browser_journey",
  "fault_inject_release",
  "fault_invariants",
]);

function fail(code: string): never {
  throw new Error(`Production load socket failed: ${code}`);
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function timeoutFor(operation: ProductionLoadControlOperation): number {
  if (operation === "sample" || operation === "baseline"
    || operation === "runner_observation" || operation === "fault_probe"
    || operation === "fault_invariants") return 4_000;
  if (operation === "fault_inject_release") return 70_000;
  if (operation === "seed" || operation === "browser_journey") return 120_000;
  return 30_000;
}

async function verifyUnixSocket(socketPath: string): Promise<void> {
  const stat = await lstat(socketPath);
  if (stat.isSymbolicLink() || !stat.isSocket()) throw new Error("not_socket");
}

export const productionLoadSocketRequester: ProductionLoadSocketRequester = (input) => new Promise((resolve, reject) => {
  let settled = false;
  let abortListener: (() => void) | null = null;
  const cleanup = () => {
    if (input.signal && abortListener) {
      input.signal.removeEventListener("abort", abortListener);
      abortListener = null;
    }
  };
  const rejectStable = () => {
    if (settled) return;
    settled = true;
    cleanup();
    reject(new Error("socket_request_failed"));
  };
  const request = httpRequest({
    socketPath: input.socketPath,
    path: input.requestPath,
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "content-length": Buffer.byteLength(input.body, "utf8"),
    },
    agent: false,
  }, (response) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    response.on("data", (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > input.maxResponseBytes) {
        request.destroy(new Error("response_too_large"));
        return;
      }
      chunks.push(buffer);
    });
    response.on("end", () => {
      if (settled) return;
      let body: unknown;
      try {
        const decoded = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
        body = JSON.parse(decoded) as unknown;
      } catch {
        rejectStable();
        return;
      }
      settled = true;
      cleanup();
      resolve({
        statusCode: response.statusCode ?? 0,
        contentType: String(response.headers["content-type"] ?? ""),
        body,
      });
    });
    response.on("error", rejectStable);
  });
  request.setTimeout(input.timeoutMs, () => request.destroy(new Error("timeout")));
  request.on("error", rejectStable);
  if (input.signal) {
    if (input.signal.aborted) {
      request.destroy(new Error("aborted"));
      return;
    }
    abortListener = () => request.destroy(new Error("aborted"));
    input.signal.addEventListener("abort", abortListener, {
      once: true,
    });
  }
  request.end(input.body);
});

export function createProductionLoadSocketTransport(
  options: ProductionLoadSocketOptions,
): ProductionLoadControlTransport {
  if (!path.isAbsolute(options.socketPath)
    || /[\0\r\n]/.test(options.socketPath)
    || options.socketPath.length > 240) {
    fail("invalid_socket_path");
  }
  const socketPath = path.resolve(options.socketPath);
  const requester = options.requester ?? productionLoadSocketRequester;
  const verifySocket = options.verifySocket ?? verifyUnixSocket;

  return {
    async request(operation, payload, signal) {
      if (!operations.has(operation)) fail("invalid_operation");
      let body: string;
      try {
        body = JSON.stringify({ schemaVersion: 1, operation, payload });
      } catch {
        fail("invalid_request");
      }
      if (Buffer.byteLength(body, "utf8") > 1_048_576) fail("request_too_large");
      try {
        await verifySocket(socketPath);
      } catch {
        fail("unsafe_socket");
      }

      let response: ProductionLoadSocketResponse;
      try {
        response = await requester({
          socketPath,
          requestPath: "/v1/load-control",
          body,
          timeoutMs: timeoutFor(operation),
          maxResponseBytes: 1_048_576,
          ...(signal ? { signal } : {}),
        });
      } catch {
        fail("request_failed");
      }
      const envelope = record(response.body);
      if (response.statusCode !== 200
        || !/^application\/json(?:\s*;|$)/i.test(response.contentType)
        || !envelope
        || !exactKeys(envelope, ["schemaVersion", "ok", "result"])
        || envelope.schemaVersion !== 1
        || envelope.ok !== true) {
        fail("invalid_response");
      }
      return envelope.result;
    },
  };
}
