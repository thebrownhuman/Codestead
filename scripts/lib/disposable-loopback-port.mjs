import net from "node:net";

import { disposableIntegrationFailure } from
  "./disposable-integration-error.mjs";

const DISPOSABLE_LOOPBACK_HOST = "127.0.0.1";
const KERNEL_ASSIGNED_PORT = 0;
const POSTGRES_HOST_PORT = 5432;
const MAXIMUM_ALLOCATION_ATTEMPTS = 8;
const ALLOCATION_FAILURE_CODE =
  "disposable_loopback_port_allocation_failed";

/**
 * @typedef {Readonly<{
 *   close: () => Promise<void>,
 *   port: number,
 * }>} DisposableLoopbackListener
 */

/**
 * @callback OpenDisposableLoopbackListener
 * @param {Readonly<{host: string, port: number}>} input
 * @returns {Promise<DisposableLoopbackListener>}
 */

/**
 * @returns {
 *   import("./disposable-integration-error.mjs").DisposableIntegrationLifecycleError
 * }
 */
function allocationFailure() {
  return disposableIntegrationFailure(ALLOCATION_FAILURE_CODE);
}

/**
 * @returns {never}
 */
function fail() {
  throw allocationFailure();
}

/**
 * @param {import("node:net").Server} server
 * @returns {Promise<void>}
 */
function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(allocationFailure());
        return;
      }
      resolve();
    });
  });
}

/**
 * @type {OpenDisposableLoopbackListener}
 */
const openLoopbackListener = (input) => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.unref();
  server.once("error", () => {
    reject(allocationFailure());
  });
  server.listen(input.port, input.host, () => {
    const address = server.address();
    if (
      !address
      || typeof address === "string"
      || address.address !== DISPOSABLE_LOOPBACK_HOST
    ) {
      void closeServer(server).then(
        () => reject(allocationFailure()),
        () => reject(allocationFailure()),
      );
      return;
    }
    resolve({
      port: address.port,
      close: () => closeServer(server),
    });
  });
});

/**
 * Allocate a kernel-assigned IPv4 loopback port that is safe to publish
 * for a disposable PostgreSQL container.
 *
 * @param {Readonly<{
 *   openListener?: OpenDisposableLoopbackListener,
 * }>} [input]
 * @returns {Promise<number>}
 */
export async function allocateDisposableLoopbackPort(input = {}) {
  const openListener = input.openListener ?? openLoopbackListener;
  for (
    let attempt = 0;
    attempt < MAXIMUM_ALLOCATION_ATTEMPTS;
    attempt += 1
  ) {
    /** @type {DisposableLoopbackListener} */
    let listener;
    try {
      listener = await openListener({
        host: DISPOSABLE_LOOPBACK_HOST,
        port: KERNEL_ASSIGNED_PORT,
      });
      await listener.close();
    } catch {
      fail();
    }
    if (
      !Number.isSafeInteger(listener.port)
      || listener.port <= 0
      || listener.port > 65_535
    ) {
      fail();
    }
    if (listener.port === POSTGRES_HOST_PORT) continue;
    return listener.port;
  }
  fail();
}
