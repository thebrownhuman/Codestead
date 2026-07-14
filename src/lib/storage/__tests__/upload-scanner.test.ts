import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import net from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ClamdClient, parseClamdResponse } from "../clamd-client";
import {
  processScanBatch,
  resolveStoredObjectPath,
  retryDelayMs,
  scanStoredObject,
  type ScanLease,
  type UploadScanRepository,
  UploadScanError,
} from "../upload-scanner";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(content = "print('safe')\n") {
  const root = await mkdtemp(path.join(tmpdir(), "learncoding-scan-"));
  roots.push(root);
  const owner = "learner_1";
  const id = randomUUID();
  const directory = path.join(root, owner);
  await mkdir(directory);
  const bytes = Buffer.from(content);
  await writeFile(path.join(directory, id), bytes);
  const lease: ScanLease = {
    id,
    storageKey: `${owner}/${id}`,
    sizeBytes: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    leaseToken: randomUUID(),
    attempt: 1,
  };
  return { root, lease, bytes };
}

function consumingScanner(verdict: "clean" | "infected") {
  return {
    async scan(stream: AsyncIterable<Uint8Array>) {
      for await (const _chunk of stream) void _chunk;
      return verdict;
    },
  } as const;
}

describe("ClamAV response handling", () => {
  it("maps clean and infected replies without exposing the signature", () => {
    expect(parseClamdResponse("stream: OK\0")).toBe("clean");
    expect(parseClamdResponse("stream: Eicar-Signature FOUND\0")).toBe("infected");
  });

  it.each(["stream: ERROR\0", "garbage", ""])("rejects protocol response %j", (reply) => {
    expect(() => parseClamdResponse(reply)).toThrowError(
      expect.objectContaining({ code: "scanner_protocol", retryable: true }),
    );
  });

  async function fakeClamd(reply: string) {
    let receivedResolve!: (value: Buffer) => void;
    const received = new Promise<Buffer>((resolve) => { receivedResolve = resolve; });
    const server = net.createServer((socket) => {
      let pending = Buffer.alloc(0);
      const payload: Buffer[] = [];
      let commandRead = false;
      socket.on("data", (value: Buffer) => {
        pending = Buffer.concat([pending, value]);
        if (!commandRead) {
          if (pending.byteLength < 10) return;
          expect(pending.subarray(0, 10).toString("ascii")).toBe("zINSTREAM\0");
          pending = pending.subarray(10);
          commandRead = true;
        }
        while (pending.byteLength >= 4) {
          const length = pending.readUInt32BE(0);
          if (length === 0) {
            pending = pending.subarray(4);
            receivedResolve(Buffer.concat(payload));
            socket.end(`${reply}\0`);
            return;
          }
          if (pending.byteLength < 4 + length) return;
          payload.push(pending.subarray(4, 4 + length));
          pending = pending.subarray(4 + length);
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("TEST_SERVER_ADDRESS");
    return {
      port: address.port,
      received,
      close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
    };
  }

  it("frames INSTREAM chunks and handles a clean clamd round trip", async () => {
    const server = await fakeClamd("stream: OK");
    try {
      const client = new ClamdClient({ host: "127.0.0.1", port: server.port, timeoutMs: 2_000, chunkBytes: 3 });
      const verdict = await client.scan((async function* () {
        yield Buffer.from("hello");
        yield Buffer.from(" world");
      })());
      expect(verdict).toBe("clean");
      await expect(server.received).resolves.toEqual(Buffer.from("hello world"));
    } finally {
      await server.close();
    }
  });

  it("handles infected and malformed clamd round trips fail-closed", async () => {
    for (const [reply, outcome] of [
      ["stream: Test-Signature FOUND", "infected"],
      ["stream: ERROR", "scanner_protocol"],
    ] as const) {
      const server = await fakeClamd(reply);
      try {
        const client = new ClamdClient({ host: "127.0.0.1", port: server.port, timeoutMs: 2_000 });
        const result = client.scan((async function* () { yield Buffer.from("fixture"); })());
        if (outcome === "infected") await expect(result).resolves.toBe("infected");
        else await expect(result).rejects.toMatchObject({ code: outcome });
      } finally {
        await server.close();
      }
    }
  });

  it("preserves an early infected verdict when clamd closes during the upload", async () => {
    const server = net.createServer((socket) => {
      let bytes = 0;
      socket.on("data", (chunk: Buffer) => {
        bytes += chunk.byteLength;
        if (bytes >= 15) socket.end("stream: Early-Signature FOUND\0");
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("TEST_SERVER_ADDRESS");
    try {
      const client = new ClamdClient({
        host: "127.0.0.1",
        port: address.port,
        timeoutMs: 2_000,
        chunkBytes: 3,
      });
      await expect(client.scan((async function* () {
        yield Buffer.from("first payload");
        await new Promise((resolve) => setTimeout(resolve, 25));
        yield Buffer.alloc(256 * 1024, 1);
      })())).resolves.toBe("infected");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});

describe("safe object resolution and scanning", () => {
  it("streams a regular object, verifies its size and digest, and returns clean", async () => {
    const { root, lease } = await fixture();
    await expect(scanStoredObject(root, lease, consumingScanner("clean"))).resolves.toBe("clean");
  });

  it("returns the infected verdict only after consuming and hashing the object", async () => {
    const { root, lease } = await fixture("EICAR fixture placeholder");
    await expect(scanStoredObject(root, lease, consumingScanner("infected"))).resolves.toBe("infected");
  });

  it("preserves a composed early ClamAV infected verdict without misclassifying a short read", async () => {
    const { root, lease } = await fixture("EICAR-like-test-bytes-".repeat(32_768));
    const server = net.createServer((socket) => {
      let bytes = 0;
      let responded = false;
      socket.on("data", (chunk: Buffer) => {
        bytes += chunk.byteLength;
        if (bytes >= 24 && !responded) {
          responded = true;
          socket.write("stream: Early-Signature FOUND\0");
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("TEST_SERVER_ADDRESS");
    try {
      const scanner = new ClamdClient({
        host: "127.0.0.1",
        port: address.port,
        timeoutMs: 2_000,
        chunkBytes: 8,
      });
      await expect(scanStoredObject(root, lease, scanner)).resolves.toBe("infected");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it.each([
    "../etc/passwd",
    "learner_1/../secret",
    "/absolute/object",
    "learner_1\\object",
    `learner_1/${randomUUID()}/extra`,
    "owner.with.dot/00000000-0000-4000-8000-000000000000",
  ])("rejects an untrusted storage key: %s", async (storageKey) => {
    const root = path.resolve(tmpdir());
    expect(() => resolveStoredObjectPath(root, storageKey)).toThrowError(
      expect.objectContaining({ code: "path_invalid", retryable: false }),
    );
  });

  it("fails closed when bytes change after the database digest was recorded", async () => {
    const { root, lease } = await fixture();
    await expect(scanStoredObject(root, { ...lease, sha256: "0".repeat(64) }, consumingScanner("clean")))
      .rejects.toMatchObject({ code: "file_changed", retryable: false });
  });

  it("fails closed when the stored file is absent", async () => {
    const { root, lease } = await fixture();
    await rm(path.join(root, lease.storageKey));
    await expect(scanStoredObject(root, lease, consumingScanner("clean")))
      .rejects.toMatchObject({ code: "file_missing", retryable: false });
  });

  it.runIf(process.platform !== "win32")("does not follow a final-component symlink", async () => {
    const { root, lease } = await fixture();
    const original = path.join(root, lease.storageKey);
    const target = `${original}.target`;
    await writeFile(target, "different");
    await rm(original);
    await symlink(target, original);
    await expect(scanStoredObject(root, lease, consumingScanner("clean")))
      .rejects.toMatchObject({ code: "path_invalid", retryable: false });
  });

  it("treats scanner transport failures as retryable", async () => {
    const { root, lease } = await fixture();
    await expect(scanStoredObject(root, lease, { scan: async () => { throw new Error("socket"); } }))
      .rejects.toMatchObject({ code: "scanner_unavailable", retryable: true });
  });
});

describe("leased scan batch state machine", () => {
  async function repository(lease: ScanLease, complete = true) {
    const finish = vi.fn(async () => complete);
    const fail = vi.fn(async () => complete);
    return {
      value: {
        claimBatch: vi.fn(async () => [lease]),
        complete: finish,
        fail,
      } satisfies UploadScanRepository,
      finish,
      fail,
    };
  }

  it("commits clean and infected results through lease-checked completion", async () => {
    for (const verdict of ["clean", "infected"] as const) {
      const { root, lease } = await fixture(verdict);
      const store = await repository(lease);
      const summary = await processScanBatch({ repository: store.value, root, scanner: consumingScanner(verdict) });
      expect(store.finish).toHaveBeenCalledWith(lease, verdict, expect.any(Date));
      expect(summary).toMatchObject({ claimed: 1, [verdict]: 1, retrying: 0, failedClosed: 0 });
    }
  });

  it("schedules scanner outages with bounded exponential retry", async () => {
    const { root, lease } = await fixture();
    const store = await repository({ ...lease, attempt: 3 });
    const clock = new Date("2026-07-12T00:00:00.000Z");
    const summary = await processScanBatch({
      repository: store.value,
      root,
      scanner: { scan: async () => { throw new UploadScanError("scanner_unavailable", true); } },
      now: () => clock,
      retryBaseMs: 1_000,
    });
    expect(store.fail).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      code: "scanner_unavailable",
      terminal: false,
      retryAt: new Date(clock.getTime() + 4_000),
    }));
    expect(summary.retrying).toBe(1);
  });

  it("makes permanent file errors and exhausted retries terminal", async () => {
    const missing = await fixture();
    await rm(path.join(missing.root, missing.lease.storageKey));
    const missingStore = await repository(missing.lease);
    await processScanBatch({ repository: missingStore.value, root: missing.root, scanner: consumingScanner("clean") });
    expect(missingStore.fail).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      code: "file_missing", terminal: true,
    }));

    const unavailable = await fixture();
    const exhaustedStore = await repository({ ...unavailable.lease, attempt: 8 });
    await processScanBatch({
      repository: exhaustedStore.value,
      root: unavailable.root,
      scanner: { scan: async () => { throw new Error("down"); } },
      maxAttempts: 8,
    });
    expect(exhaustedStore.fail).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ terminal: true }));
  });

  it("records a lost lease instead of overwriting another worker", async () => {
    const { root, lease } = await fixture();
    const store = await repository(lease, false);
    const summary = await processScanBatch({ repository: store.value, root, scanner: consumingScanner("clean") });
    expect(summary).toMatchObject({ clean: 0, leaseLost: 1 });
  });

  it("bounds exponential backoff", () => {
    expect(retryDelayMs(1, 1_000, 5_000)).toBe(1_000);
    expect(retryDelayMs(4, 1_000, 5_000)).toBe(5_000);
    expect(retryDelayMs(999, 1_000, 5_000)).toBe(5_000);
  });
});
