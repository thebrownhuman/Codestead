import net, { type Server } from "node:net";

import { disposableIntegrationFailure } from
  "./disposable-integration-error";

const DISPOSABLE_LOOPBACK_HOST = "127.0.0.1";
const KERNEL_ASSIGNED_PORT = 0;
const POSTGRES_HOST_PORT = 5432;
const MAXIMUM_ALLOCATION_ATTEMPTS = 8;

export type DisposableLoopbackListener = Readonly<{
  close: () => Promise<void>;
  port: number;
}>;

export type OpenDisposableLoopbackListener = (
  input: Readonly<{
    host: string;
    port: number;
  }>,
) => Promise<DisposableLoopbackListener>;

function fail(): never {
  throw disposableIntegrationFailure(
    "disposable_loopback_port_allocation_failed",
  );
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(disposableIntegrationFailure(
          "disposable_loopback_port_allocation_failed",
        ));
        return;
      }
      resolve();
    });
  });
}

async function openLoopbackListener(
  input: Readonly<{ host: string; port: number }>,
): Promise<DisposableLoopbackListener> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", () => {
      reject(disposableIntegrationFailure(
        "disposable_loopback_port_allocation_failed",
      ));
    });
    server.listen(input.port, input.host, () => {
      const address = server.address();
      if (
        !address
        || typeof address === "string"
        || address.address !== DISPOSABLE_LOOPBACK_HOST
      ) {
        void closeServer(server).then(
          () => reject(disposableIntegrationFailure(
            "disposable_loopback_port_allocation_failed",
          )),
          () => reject(disposableIntegrationFailure(
            "disposable_loopback_port_allocation_failed",
          )),
        );
        return;
      }
      resolve({
        port: address.port,
        close: () => closeServer(server),
      });
    });
  });
}

export async function allocateDisposableLoopbackPort(
  input: Readonly<{
    openListener?: OpenDisposableLoopbackListener;
  }> = {},
): Promise<number> {
  const openListener = input.openListener ?? openLoopbackListener;
  for (
    let attempt = 0;
    attempt < MAXIMUM_ALLOCATION_ATTEMPTS;
    attempt += 1
  ) {
    let listener: DisposableLoopbackListener;
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
