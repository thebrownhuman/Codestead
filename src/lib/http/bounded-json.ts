import { NextResponse } from "next/server";

export const DEFAULT_JSON_BODY_MAX_BYTES = 64 * 1024;

type BodyResult =
  | { value: Uint8Array; response: null }
  | { value: null; response: NextResponse };

function bodyError(status: 400 | 413) {
  return {
    value: null,
    response: NextResponse.json(
      { error: status === 413 ? "Request body is too large." : "Invalid JSON request body." },
      { status, headers: { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" } },
    ),
  };
}

// Shared stream reader extracted from the admin AI-model route. The byte count,
// rather than the declared Content-Length, is authoritative for streamed bodies.
export async function readBoundedBody(request: Request, maxBytes = DEFAULT_JSON_BODY_MAX_BYTES): Promise<BodyResult> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new RangeError("Invalid body byte limit.");
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    reader = request.body?.getReader();
    if (!reader) return { value: new Uint8Array(), response: null };
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > maxBytes) {
        // A cloned request tees the stream. Awaiting cancellation can deadlock
        // until the other branch is consumed, so cancellation is non-blocking.
        void reader.cancel().catch(() => undefined);
        return bodyError(413);
      }
      chunks.push(next.value);
    }
    return { value: Buffer.concat(chunks, bytes), response: null };
  } finally {
    reader?.releaseLock();
  }
}

export async function readBoundedJson(request: Request, maxBytes = DEFAULT_JSON_BODY_MAX_BYTES): Promise<{ value: unknown; response: NextResponse | null }> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new RangeError("Invalid body byte limit.");
  const declared = request.headers.get("content-length");
  if (declared !== null && /^\d+$/.test(declared) && BigInt(declared) > BigInt(maxBytes)) {
    void request.body?.cancel().catch(() => undefined);
    return bodyError(413);
  }
  try {
    const result = await readBoundedBody(request, maxBytes);
    if (result.response) return result;
    return { value: JSON.parse(new TextDecoder().decode(result.value)), response: null };
  } catch {
    return bodyError(400);
  }
}
