import assert from "node:assert/strict";
import { createServer, connect as connectSocket } from "node:net";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);
const MAX_PROTOCOL_FRAME_BYTES = 16 * 1024 * 1024;
const CLOSE_TIMEOUT_MS = 5_000;

function boundedFrameLength(buffer, lengthOffset, extraBytes) {
  if (buffer.length - lengthOffset < 4) return null;
  const length = buffer.readInt32BE(lengthOffset);
  assert.ok(
    Number.isSafeInteger(length)
      && length >= 4
      && length <= MAX_PROTOCOL_FRAME_BYTES,
    "PostgreSQL proxy observed an invalid protocol frame length",
  );
  return length + extraBytes;
}

function exactSimpleQuery(frame) {
  if (frame[0] !== 0x51) return null;
  const payload = frame.subarray(5);
  if (
    payload.length < 2
    || payload[payload.length - 1] !== 0
    || payload.subarray(0, -1).includes(0)
  ) {
    return null;
  }
  return payload.subarray(0, -1).toString("utf8").trim().toLowerCase();
}

function commandCompleteTag(frame) {
  if (frame[0] !== 0x43) return null;
  const payload = frame.subarray(5);
  if (
    payload.length < 2
    || payload[payload.length - 1] !== 0
    || payload.subarray(0, -1).includes(0)
  ) {
    return null;
  }
  return payload.subarray(0, -1).toString("utf8");
}

function boundedClose(operation, timeoutMessage) {
  return Promise.race([
    operation,
    new Promise((_, reject) => {
      const timer = setTimeout(
        () => reject(new Error(timeoutMessage)),
        CLOSE_TIMEOUT_MS,
      );
      timer.unref?.();
    }),
  ]);
}

/**
 * Transparent loopback PostgreSQL proxy that can drop exactly one COMMIT
 * acknowledgement after the upstream server has completed that COMMIT.
 */
export async function createPostgresCommitAckLossProxy(input) {
  assert.ok(
    input
      && typeof input === "object"
      && LOOPBACK_HOSTS.has(input.targetHost)
      && Number.isSafeInteger(input.targetPort)
      && input.targetPort > 0
      && input.targetPort <= 65_535
      && input.targetPort !== 5432,
    "PostgreSQL race proxy requires an explicit non-5432 loopback target",
  );

  let armed = false;
  let acceptedConnections = 0;
  let droppedCommitAcknowledgements = 0;
  const sockets = new Set();
  const server = createServer((client) => {
    acceptedConnections += 1;
    const upstream = connectSocket({
      host: input.targetHost,
      port: input.targetPort,
    });
    sockets.add(client);
    sockets.add(upstream);

    let startupForwarded = false;
    let clientBuffer = Buffer.alloc(0);
    let serverBuffer = Buffer.alloc(0);
    let faultThisConnection = false;
    let closed = false;

    const destroyPair = () => {
      if (closed) return;
      closed = true;
      client.destroy();
      upstream.destroy();
    };
    const forget = (socket) => {
      sockets.delete(socket);
    };

    client.on("data", (chunk) => {
      if (closed) return;
      clientBuffer = Buffer.concat([clientBuffer, chunk]);
      let consumed = 0;

      if (!startupForwarded) {
        const startupBytes = boundedFrameLength(clientBuffer, 0, 0);
        if (startupBytes === null || clientBuffer.length < startupBytes) return;
        upstream.write(clientBuffer.subarray(0, startupBytes));
        consumed = startupBytes;
        startupForwarded = true;
      }

      while (clientBuffer.length - consumed >= 5) {
        const frameBytes = boundedFrameLength(clientBuffer, consumed + 1, 1);
        if (frameBytes === null || clientBuffer.length - consumed < frameBytes)
          break;
        const frame = clientBuffer.subarray(consumed, consumed + frameBytes);
        if (exactSimpleQuery(frame) === "commit" && armed) {
          armed = false;
          faultThisConnection = true;
        }
        upstream.write(frame);
        consumed += frameBytes;
      }
      clientBuffer = clientBuffer.subarray(consumed);
    });

    upstream.on("data", (chunk) => {
      if (closed) return;
      serverBuffer = Buffer.concat([serverBuffer, chunk]);
      let consumed = 0;
      while (serverBuffer.length - consumed >= 5) {
        const frameBytes = boundedFrameLength(serverBuffer, consumed + 1, 1);
        if (frameBytes === null || serverBuffer.length - consumed < frameBytes)
          break;
        const frame = serverBuffer.subarray(consumed, consumed + frameBytes);
        consumed += frameBytes;
        if (
          faultThisConnection
          && commandCompleteTag(frame) === "COMMIT"
        ) {
          droppedCommitAcknowledgements += 1;
          serverBuffer = Buffer.alloc(0);
          destroyPair();
          return;
        }
        client.write(frame);
      }
      serverBuffer = serverBuffer.subarray(consumed);
    });

    client.once("error", destroyPair);
    upstream.once("error", destroyPair);
    client.once("close", () => {
      forget(client);
      if (!closed) destroyPair();
    });
    upstream.once("close", () => {
      forget(upstream);
      if (!closed) destroyPair();
    });
  });

  server.on("error", () => {
    for (const socket of sockets) socket.destroy();
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address();
  assert.ok(
    address && typeof address === "object" && address.address === "127.0.0.1",
    "PostgreSQL race proxy failed to bind exact loopback",
  );

  return Object.freeze({
    host: "127.0.0.1",
    port: address.port,
    armNextCommitAckLoss() {
      assert.equal(armed, false, "PostgreSQL race proxy is already armed");
      armed = true;
    },
    snapshot() {
      return Object.freeze({
        acceptedConnections,
        armed,
        droppedCommitAcknowledgements,
        openSockets: sockets.size,
      });
    },
    async close() {
      armed = false;
      const serverClosed = new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
      const socketClosures = [...sockets].map((socket) =>
        new Promise((resolve) => {
          if (socket.closed) {
            sockets.delete(socket);
            resolve();
            return;
          }
          socket.once("close", () => {
            sockets.delete(socket);
            resolve();
          });
          socket.destroy();
        }),
      );
      await boundedClose(
        Promise.all([serverClosed, ...socketClosures]),
        "PostgreSQL race proxy close timed out",
      );
      assert.equal(sockets.size, 0, "PostgreSQL race proxy leaked sockets");
    },
  });
}
