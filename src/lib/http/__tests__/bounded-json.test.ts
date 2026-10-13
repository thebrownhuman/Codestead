import { afterEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_JSON_BODY_MAX_BYTES, readBoundedBody, readBoundedJson } from "../bounded-json";

afterEach(() => vi.restoreAllMocks());

function request(body: string, headers?: HeadersInit) {
  return new Request("https://learn.test/api/example", { method: "POST", body, headers });
}

function streamed(chunks: Uint8Array[], headers?: HeadersInit) {
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      // Remain open: rejection must not wait for the rest of the body.
    },
    cancel,
  });
  const req = new Request("https://learn.test/api/example", {
    method: "POST", body, headers, duplex: "half",
  } as RequestInit);
  return { req, cancel };
}

describe("bounded JSON request bodies", () => {
  it("rejects declared oversized bytes without opening or parsing the body", async () => {
    const req = request('{}', { "content-length": "9".repeat(30) });
    const reader = vi.spyOn(req.body!, "getReader");
    const parse = vi.spyOn(JSON, "parse");
    const result = await readBoundedJson(req);
    expect(result.response?.status).toBe(413);
    expect(reader).not.toHaveBeenCalled();
    expect(parse.mock.calls.some(([value]) => value === '{}')).toBe(false);
  });

  it.each([undefined, "1", "invalid"])("counts streamed bytes despite Content-Length %s, cancels, and never parses oversized JSON", async (length) => {
    const { req, cancel } = streamed([new Uint8Array(4), new Uint8Array(5)], length ? { "content-length": length } : undefined);
    const parse = vi.spyOn(JSON, "parse");
    const result = await readBoundedJson(req, 8);
    expect(result.response?.status).toBe(413);
    expect(cancel).toHaveBeenCalledOnce();
    expect(parse.mock.calls.some(([value]) => typeof value === "string" && value.includes("\0"))).toBe(false);
    expect(req.body!.locked).toBe(false);
  });

  it("accepts exact byte limits and rejects one byte over", async () => {
    expect(await readBoundedJson(request('{}'), 2)).toEqual({ value: {}, response: null });
    expect((await readBoundedJson(request('{} '), 2)).response?.status).toBe(413);
  });

  it("counts UTF-8 bytes rather than characters", async () => {
    const text = '"é"';
    expect(text.length).toBe(3);
    expect((await readBoundedJson(request(text), 3)).response?.status).toBe(413);
    expect(await readBoundedJson(request(text), 4)).toEqual({ value: "é", response: null });
  });

  it.each(['{', '', 'true false'])("returns a 400 JSON error for malformed/empty JSON: %j", async (text) => {
    const result = await readBoundedJson(request(text));
    expect(result.value).toBeNull();
    expect(result.response?.status).toBe(400);
    expect(await result.response!.json()).toEqual({ error: "Invalid JSON request body." });
  });

  it("matches native JSON decoding for a BOM and preserves multi-byte text across chunks", async () => {
    const text = '\uFEFF{"text":"雪"}';
    expect(await readBoundedJson(request(text))).toEqual({ value: await request(text).json(), response: null });
    const bytes = new TextEncoder().encode(text);
    const body = new ReadableStream<Uint8Array>({ start(controller) {
      for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
      controller.close();
    } });
    const req = new Request("https://learn.test", { method: "POST", body, duplex: "half" } as RequestInit);
    expect(await readBoundedJson(req)).toEqual({ value: { text: "雪" }, response: null });
  });

  it("returns 400 for a transport failure and releases the reader", async () => {
    const req = new Request("https://learn.test", { method: "POST", body: new ReadableStream({ start(controller) { controller.error(new Error("transport")); } }), duplex: "half" } as RequestInit);
    expect((await readBoundedJson(req)).response?.status).toBe(400);
    expect(req.body!.locked).toBe(false);
  });

  it("rejects a cloned oversized stream without waiting for the unread original branch", async () => {
    const { req } = streamed([new Uint8Array(9)]);
    const result = await readBoundedJson(req.clone(), 8);
    expect(result.response?.status).toBe(413);
    await req.body!.cancel();
  });

  it("keeps an unconsumed original available after validating a bounded clone", async () => {
    const req = request('{"provider":"google"}');
    expect((await readBoundedJson(req.clone())).value).toEqual({ provider: "google" });
    expect(await req.json()).toEqual({ provider: "google" });
  });

  it("defaults to 64KiB and returns bytes for existing route-specific decoding", async () => {
    expect(DEFAULT_JSON_BODY_MAX_BYTES).toBe(65_536);
    const result = await readBoundedBody(request('{}'));
    expect(new TextDecoder().decode(result.value!)).toBe('{}');
    expect(result.response).toBeNull();
  });
});
