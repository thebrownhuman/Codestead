import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { findGmailMessageByMessageId } from "../mailer";

const MESSAGE_ID =
  "<codestead.outbox.22222222-2222-4222-8222-222222222222@mail.codestead.invalid>";

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

    await expect(findGmailMessageByMessageId(MESSAGE_ID)).resolves.toEqual({
      kind: "matched",
      providerMessageId: "gmail-1",
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

    await expect(findGmailMessageByMessageId(MESSAGE_ID)).resolves.toEqual({ kind });
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

    await expect(findGmailMessageByMessageId(MESSAGE_ID)).resolves.toEqual({
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

    await expect(findGmailMessageByMessageId(MESSAGE_ID)).resolves.toEqual({
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

    await expect(findGmailMessageByMessageId(MESSAGE_ID)).resolves.toEqual({
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

    await expect(findGmailMessageByMessageId(MESSAGE_ID)).resolves.toEqual({
      kind: "ambiguous",
    });
  });

  it.each(["list", "metadata"] as const)(
    "bounds $stage response body parsing with the reconciliation deadline",
    async (stage) => {
      vi.useFakeTimers();
      vi.stubEnv("GMAIL_REQUEST_TIMEOUT_MS", "1000");
      const stalledResponse = {
        ok: true,
        json: vi.fn(() => new Promise<never>(() => undefined)),
      } as unknown as Response;
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(new Response(
          JSON.stringify({ access_token: "access" }),
          { status: 200 },
        ));
      if (stage === "metadata") {
        fetchMock.mockResolvedValueOnce({
          ok: true,
          json: vi.fn(async () => ({ messages: [{ id: "gmail-1" }] })),
        } as unknown as Response);
      }
      fetchMock.mockResolvedValueOnce(stalledResponse);
      vi.stubGlobal("fetch", fetchMock);

      let outcome: unknown;
      void findGmailMessageByMessageId(MESSAGE_ID).then(
        (result) => { outcome = result; },
        (error) => { outcome = error; },
      );
      for (let index = 0; index < 20; index += 1) await Promise.resolve();
      expect(fetchMock).toHaveBeenCalledTimes(stage === "list" ? 2 : 3);

      await vi.advanceTimersByTimeAsync(1_001);
      await Promise.resolve();

      expect(outcome).toBeInstanceOf(Error);
      expect((outcome as Error).message).toContain("reconciliation request timed out");
    },
  );
});
