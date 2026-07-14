import { once } from "node:events";
import net from "node:net";

import {
  type ScanVerdict,
  type StreamScanner,
  UploadScanError,
} from "./upload-scanner";

const COMMAND = Buffer.from("zINSTREAM\0", "ascii");
const TERMINATOR = Buffer.alloc(4);
const MAX_CLAMD_RESPONSE_BYTES = 4 * 1024;
const DEFAULT_CHUNK_BYTES = 64 * 1024;

export function parseClamdResponse(response: string): ScanVerdict {
  const normalized = response.replace(/\0+$/g, "").trim();
  if (/^stream:\s+OK$/i.test(normalized)) return "clean";
  if (/^stream:\s+.+\s+FOUND$/i.test(normalized)) return "infected";
  throw new UploadScanError("scanner_protocol", true);
}

async function write(socket: net.Socket, bytes: Uint8Array) {
  if (!socket.write(bytes)) await once(socket, "drain");
}

export class ClamdClient implements StreamScanner {
  private readonly host: string;
  private readonly port: number;
  private readonly timeoutMs: number;
  private readonly chunkBytes: number;

  constructor(input: { host: string; port?: number; timeoutMs?: number; chunkBytes?: number }) {
    if (!input.host || input.host.length > 253) throw new Error("CLAMD_HOST is invalid.");
    this.host = input.host;
    this.port = input.port ?? 3310;
    this.timeoutMs = input.timeoutMs ?? 120_000;
    this.chunkBytes = Math.max(1, Math.min(1024 * 1024, input.chunkBytes ?? DEFAULT_CHUNK_BYTES));
  }

  async scan(stream: AsyncIterable<Uint8Array>): Promise<ScanVerdict> {
    const socket = net.createConnection({ host: this.host, port: this.port });
    socket.setNoDelay(true);
    socket.setTimeout(this.timeoutMs);
    const onTimeout = () => socket.destroy(new Error("CLAMD_TIMEOUT"));
    socket.on("timeout", onTimeout);

    try {
      await once(socket, "connect");
      let responseBytes = 0;
      const response: Buffer[] = [];
      const responsePromise = new Promise<string>((resolve, reject) => {
        socket.on("data", (chunk: Buffer) => {
          responseBytes += chunk.byteLength;
          if (responseBytes > MAX_CLAMD_RESPONSE_BYTES) {
            socket.destroy(new Error("CLAMD_RESPONSE_TOO_LARGE"));
            return;
          }
          response.push(chunk);
          if (chunk.includes(0)) {
            resolve(Buffer.concat(response).toString("utf8"));
            socket.destroy();
          }
        });
        socket.once("error", reject);
        socket.once("end", () => {
          if (response.length > 0) resolve(Buffer.concat(response).toString("utf8"));
          else reject(new Error("CLAMD_EMPTY_RESPONSE"));
        });
      });
      // A socket can fail while the input iterator is still producing. Attach
      // the rejection handler immediately; the original promise is awaited
      // after the terminator is sent.
      void responsePromise.catch(() => undefined);
      const responseRace = responsePromise.then((value) => ({ response: value }));
      const writeOrResponse = async (bytes: Uint8Array): Promise<string | null> => {
        try {
          const outcome = await Promise.race([
            write(socket, bytes).then(() => null),
            responseRace,
          ]);
          return outcome?.response ?? null;
        } catch (writeError) {
          // clamd is allowed to return a terminal verdict and close the socket
          // before the client has finished uploading. Preserve that verdict
          // instead of replacing it with the resulting socket-write failure.
          try {
            return await responsePromise;
          } catch {
            throw writeError;
          }
        }
      };

      let earlyResponse = await writeOrResponse(COMMAND);
      upload: for await (const value of stream) {
        if (earlyResponse !== null) break;
        const bytes = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
        for (let offset = 0; offset < bytes.byteLength; offset += this.chunkBytes) {
          const chunk = bytes.subarray(offset, Math.min(bytes.byteLength, offset + this.chunkBytes));
          const header = Buffer.allocUnsafe(4);
          header.writeUInt32BE(chunk.byteLength);
          earlyResponse = await writeOrResponse(header);
          if (earlyResponse !== null) break upload;
          earlyResponse = await writeOrResponse(chunk);
          if (earlyResponse !== null) break upload;
        }
      }
      if (earlyResponse === null) earlyResponse = await writeOrResponse(TERMINATOR);
      return parseClamdResponse(earlyResponse ?? await responsePromise);
    } catch (error) {
      if (error instanceof UploadScanError) throw error;
      throw new UploadScanError("scanner_unavailable", true, { cause: error });
    } finally {
      socket.off("timeout", onTimeout);
      socket.destroy();
    }
  }
}
