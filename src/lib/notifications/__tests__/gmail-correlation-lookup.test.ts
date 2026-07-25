import { createHash } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { findGmailMessageByMessageId } from "../mailer";
import type { ProviderPayloadSha256 } from "../prepared-dispatch";
import { outboxMessageId } from "../provider-correlation";

const OPERATION_ID = "22222222-2222-4222-8222-222222222222";
const MESSAGE_ID = outboxMessageId(OPERATION_ID);
const LEGACY_BINDING = Object.freeze({
  kind: "legacy-unbound" as const,
  bindingVersion: null,
  bindingSha256: null,
});

function exactBindingFor(rfc822: string) {
  return Object.freeze({
    kind: "exact-bound" as const,
    bindingVersion: "gmail-raw-v1" as const,
    bindingSha256: createHash("sha256")
      .update(rfc822, "utf8")
      .digest("hex") as ProviderPayloadSha256,
  });
}

function canonicalPaddedRaw(rfc822: string) {
  const unpadded = Buffer.from(rfc822, "utf8").toString("base64url");
  const remainder = unpadded.length % 4;
  const paddingLength = remainder === 0 ? 0 : 4 - remainder;
  return `${unpadded}${"=".repeat(paddingLength)}`;
}

function noncanonicalPaddedRaw(rfc822: string) {
  const unpadded = Buffer.from(rfc822, "utf8").toString("base64url");
  const canonicalPaddingLength = canonicalPaddedRaw(rfc822).length - unpadded.length;
  const wrongPaddingLength = canonicalPaddingLength === 1 ? 2 : 1;
  return `${unpadded}${"=".repeat(wrongPaddingLength)}`;
}

describe("bounded Gmail correlation lookup", () => {
  beforeEach(() => {
    vi.stubEnv("GMAIL_CLIENT_ID", "client");
    vi.stubEnv("GMAIL_CLIENT_SECRET", "secret");
    vi.stubEnv("GMAIL_REFRESH_TOKEN", "refresh");
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("searches at most two messages and verifies the sole match's Message-ID metadata", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "access" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ messages: [{ id: "gmail-1" }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: "gmail-1",
        labelIds: ["SENT"],
        payload: {
          headers: [{ name: "Message-ID", value: MESSAGE_ID }],
        },
      }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(findGmailMessageByMessageId(MESSAGE_ID, LEGACY_BINDING)).resolves.toEqual({
      kind: "matched",
      providerMessageId: "gmail-1",
      bindingEvidence: LEGACY_BINDING,
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const listUrl = new URL(String(fetchMock.mock.calls[1]![0]));
    expect(listUrl.pathname).toBe("/gmail/v1/users/me/messages");
    expect(listUrl.searchParams.get("maxResults")).toBe("2");
    expect(listUrl.searchParams.get("q")).toBe(
      `rfc822msgid:${MESSAGE_ID}`,
    );
    expect(listUrl.searchParams.getAll("labelIds")).toEqual(["SENT"]);
    const metadataUrl = new URL(String(fetchMock.mock.calls[2]![0]));
    expect(metadataUrl.pathname).toBe("/gmail/v1/users/me/messages/gmail-1");
    expect(metadataUrl.searchParams.get("format")).toBe("metadata");
    expect(metadataUrl.searchParams.getAll("metadataHeaders")).toEqual(["Message-ID"]);
  });

  it.each([
    { messages: [], kind: "not-found" },
    { messages: [{ id: "gmail-1" }, { id: "gmail-2" }], kind: "ambiguous" },
  ] as const)("does not fetch metadata for a $kind search", async ({ messages, kind }) => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "access" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ messages }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(findGmailMessageByMessageId(MESSAGE_ID, LEGACY_BINDING)).resolves.toEqual({ kind });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    {
      body: { messages: "malformed" },
      label: "malformed message collection",
    },
    {
      body: { messages: [], nextPageToken: "next-page" },
      label: "paginated zero-result response",
    },
    {
      body: { messages: [], nextPageToken: "" },
      label: "defined empty page token",
    },
  ] as const)("treats a $label as ambiguous", async ({ body }) => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "access" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(body), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(findGmailMessageByMessageId(MESSAGE_ID, LEGACY_BINDING)).resolves.toEqual({
      kind: "ambiguous",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("treats mismatched metadata as ambiguous and never returns its provider ID", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "access" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ messages: [{ id: "gmail-wrong" }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: "gmail-wrong",
        payload: {
          headers: [{ name: "Message-ID", value: "<different@example.invalid>" }],
        },
      }), { status: 200 })));

    await expect(findGmailMessageByMessageId(MESSAGE_ID, LEGACY_BINDING)).resolves.toEqual({
      kind: "ambiguous",
    });
  });

  it("keeps a matching Message-ID ambiguous when the message is not SENT", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "access" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ messages: [{ id: "gmail-incoming" }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: "gmail-incoming",
        labelIds: ["INBOX"],
        payload: {
          headers: [{ name: "Message-ID", value: MESSAGE_ID }],
        },
      }), { status: 200 })));

    await expect(findGmailMessageByMessageId(MESSAGE_ID, LEGACY_BINDING)).resolves.toEqual({
      kind: "ambiguous",
    });
  });

  it("requires labelIds to be an actual array before accepting a SENT match", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "access" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ messages: [{ id: "gmail-shaped" }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: "gmail-shaped",
        labelIds: "SENT",
        payload: {
          headers: [{ name: "Message-ID", value: MESSAGE_ID }],
        },
      }), { status: 200 })));

    await expect(findGmailMessageByMessageId(MESSAGE_ID, LEGACY_BINDING)).resolves.toEqual({
      kind: "ambiguous",
    });
  });

  it("verifies exact Gmail raw RFC822 bytes before returning bound evidence", async () => {
    const rfc822 = [
      "From: Codestead <noreply@example.test>",
      "To: learner@example.test",
      `Message-ID: ${MESSAGE_ID}`,
      "Subject: Exact bound recovery",
      "",
      "Bound body",
    ].join("\r\n");
    const binding = exactBindingFor(rfc822);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ access_token: "access" }),
        { status: 200 },
      ))
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ messages: [{ id: "gmail-bound" }] }),
        { status: 200 },
      ))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: "gmail-bound",
        labelIds: ["SENT"],
        raw: Buffer.from(rfc822, "utf8").toString("base64url"),
      }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      findGmailMessageByMessageId(MESSAGE_ID, binding),
    ).resolves.toEqual({
      kind: "matched",
      providerMessageId: "gmail-bound",
      bindingEvidence: binding,
    });
    const rawUrl = new URL(String(fetchMock.mock.calls[2]![0]));
    expect(rawUrl.searchParams.get("format")).toBe("raw");
    expect(rawUrl.searchParams.has("metadataHeaders")).toBe(false);
  });

  it("accepts canonical terminal padding for the exact RFC822 bytes", async () => {
    const rfc822 = `Message-ID: ${MESSAGE_ID}\r\n\r\nExpected`;
    const binding = exactBindingFor(rfc822);
    const paddedRaw = canonicalPaddedRaw(rfc822);
    expect(paddedRaw).toMatch(/={1,2}$/u);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ access_token: "access" }),
        { status: 200 },
      ))
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ messages: [{ id: "gmail-padded" }] }),
        { status: 200 },
      ))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: "gmail-padded",
        labelIds: ["SENT"],
        raw: paddedRaw,
      }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      findGmailMessageByMessageId(MESSAGE_ID, binding),
    ).resolves.toEqual({
      kind: "matched",
      providerMessageId: "gmail-padded",
      bindingEvidence: binding,
    });
  });

  it("keeps a same-Message-ID different-body Gmail result ambiguous", async () => {
    const expectedRfc822 = `Message-ID: ${MESSAGE_ID}\r\n\r\nExpected`;
    const observedRfc822 = `Message-ID: ${MESSAGE_ID}\r\n\r\nExpectee`;
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ access_token: "access" }),
        { status: 200 },
      ))
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ messages: [{ id: "gmail-conflict" }] }),
        { status: 200 },
      ))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: "gmail-conflict",
        labelIds: ["SENT"],
        raw: Buffer.from(observedRfc822, "utf8").toString("base64url"),
      }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(findGmailMessageByMessageId(
      MESSAGE_ID,
      exactBindingFor(expectedRfc822),
    )).resolves.toEqual({ kind: "ambiguous" });
  });

  it.each([
    ["trailing whitespace", (rfc822: string) => ({ raw: `${canonicalPaddedRaw(rfc822)} ` })],
    ["interior padding", (rfc822: string) => ({
      raw: Buffer.from(rfc822, "utf8").toString("base64url").replace(/^(.{4})/u, "$1="),
    })],
    ["excess padding", (rfc822: string) => ({ raw: `${canonicalPaddedRaw(rfc822)}=` })],
    ["invalid base64url alphabet", (_rfc822: string) => ({ raw: "AA+A" })],
    ["noncanonical padding count", (rfc822: string) => ({
      raw: noncanonicalPaddedRaw(rfc822),
    })],
    ["invalid UTF-8", (_rfc822: string) => ({ raw: Buffer.from([0xff]).toString("base64url") })],
    ["wrong provider ID", (_rfc822: string) => ({ id: "gmail-other" })],
    ["missing SENT label", (_rfc822: string) => ({ labelIds: ["INBOX"] })],
  ] as const)("rejects exact raw evidence with %s", async (_label, overrideFor) => {
    const rfc822 = `Message-ID: ${MESSAGE_ID}\r\n\r\nExpected`;
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ access_token: "access" }),
        { status: 200 },
      ))
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ messages: [{ id: "gmail-bound" }] }),
        { status: 200 },
      ))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: "gmail-bound",
        labelIds: ["SENT"],
        raw: Buffer.from(rfc822, "utf8").toString("base64url"),
        ...overrideFor(rfc822),
      }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(findGmailMessageByMessageId(
      MESSAGE_ID,
      exactBindingFor(rfc822),
    )).resolves.toEqual({ kind: "ambiguous" });
  });

  it.each(["list", "metadata", "raw"] as const)(
    "bounds $stage response body parsing with the reconciliation deadline",
    async (stage) => {
      vi.useFakeTimers();
      vi.stubEnv("GMAIL_REQUEST_TIMEOUT_MS", "1000");
      const rfc822 = [
        `Message-ID: ${MESSAGE_ID}`,
        "Subject: timeout",
        "",
        "body",
      ].join("\r\n");
      const binding =
        stage === "raw" ? exactBindingFor(rfc822) : LEGACY_BINDING;
      const stalledResponse = {
        ok: true,
        json: vi.fn(() => new Promise<never>(() => undefined)),
      } as unknown as Response;
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(new Response(
          JSON.stringify({ access_token: "access" }),
          { status: 200 },
        ));
      if (stage !== "list") {
        fetchMock.mockResolvedValueOnce({
          ok: true,
          json: vi.fn(async () => ({ messages: [{ id: "gmail-1" }] })),
        } as unknown as Response);
      }
      fetchMock.mockResolvedValueOnce(stalledResponse);
      vi.stubGlobal("fetch", fetchMock);

      let outcome: unknown;
      void findGmailMessageByMessageId(MESSAGE_ID, binding).then(
        (result) => { outcome = result; },
        (error) => { outcome = error; },
      );
      for (let index = 0; index < 20; index += 1) await Promise.resolve();
      expect(fetchMock).toHaveBeenCalledTimes(stage === "list" ? 2 : 3);

      await vi.advanceTimersByTimeAsync(1_001);
      await Promise.resolve();
      const requestIndex = stage === "list" ? 1 : 2;
      const signal = (fetchMock.mock.calls[requestIndex]![1] as RequestInit).signal;
      expect(signal).toBeInstanceOf(AbortSignal);
      expect(signal?.aborted).toBe(true);
      expect(outcome).toBeUndefined();

      await vi.advanceTimersByTimeAsync(5_000);
      expect(outcome).toBeInstanceOf(Error);
      expect((outcome as Error).message).toBe(
        "Gmail reconciliation request did not settle after abort.",
      );
    },
  );
});
