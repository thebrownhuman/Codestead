import { createHash } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  findGmailMessageByMessageId,
} from "../gmail-correlation-lookup";

const MESSAGE_ID =
  "<codestead.outbox.22222222-2222-4222-8222-222222222222@mail.codestead.invalid>";
const OPAQUE_MESSAGE_ID =
  "<codestead.outbox.v1.okd-aMXCHPuS1pgnjdYfjG17CU5nfw-6stQE23enb8Q@mail.codestead.invalid>";
const EVIDENCE_TOKEN = "A".repeat(43);
const EVIDENCE_SHA256 =
  "6889a4e92ed4f994f2f039da46e2a9d482c8162d1ef9cc1050664b965a7c9d80";
const LEGACY_UNBOUND_AUTHORITY = {
  kind: "legacy-unbound-v0" as const,
};

function lookup() {
  return findGmailMessageByMessageId({
    messageId: MESSAGE_ID,
    authority: LEGACY_UNBOUND_AUTHORITY,
  });
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

    await expect(lookup()).resolves.toEqual({
      kind: "matched",
      providerMessageId: "gmail-1",
      proof: { kind: "legacy-discovery-v0" },
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

    await expect(lookup()).resolves.toEqual({ kind });
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

    await expect(lookup()).resolves.toEqual({
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

    await expect(lookup()).resolves.toEqual({
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

    await expect(lookup()).resolves.toEqual({
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

    await expect(lookup()).resolves.toEqual({
      kind: "ambiguous",
    });
  });

  it("authorizes class B only when decoded Gmail RAW bytes match the persisted SHA", async () => {
    const raw = Buffer.from(
      `Message-ID: ${MESSAGE_ID}\r\nSubject: legacy\r\n\r\nbody`,
      "utf8",
    );
    const adapterPayloadSha256 = createHash("sha256").update(raw).digest("hex");
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        access_token: "access",
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        messages: [{ id: "gmail-bound" }],
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: "gmail-bound",
        labelIds: ["SENT"],
        raw: raw.toString("base64url"),
      }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(findGmailMessageByMessageId({
      messageId: MESSAGE_ID,
      authority: {
        kind: "legacy-raw-bound-v1",
        adapterPayloadSha256,
      },
    })).resolves.toEqual({
      kind: "matched",
      providerMessageId: "gmail-bound",
      proof: { kind: "raw-sha256-v1", adapterPayloadSha256 },
    });
    const rawUrl = new URL(String(fetchMock.mock.calls[2]![0]));
    expect(rawUrl.searchParams.get("format")).toBe("raw");
    expect(rawUrl.searchParams.has("metadataHeaders")).toBe(false);
  });

  it("keeps class B unresolved on a RAW digest mismatch", async () => {
    const raw = Buffer.from(
      `Message-ID: ${MESSAGE_ID}\r\n\r\nbody`,
      "utf8",
    );
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        access_token: "access",
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        messages: [{ id: "gmail-bound" }],
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: "gmail-bound",
        labelIds: ["SENT"],
        raw: raw.toString("base64url"),
      }), { status: 200 })));

    await expect(findGmailMessageByMessageId({
      messageId: MESSAGE_ID,
      authority: {
        kind: "legacy-raw-bound-v1",
        adapterPayloadSha256: "b".repeat(64),
      },
    })).resolves.toEqual({ kind: "ambiguous" });
  });

  it("authorizes class C only with the exact authenticated evidence header", async () => {
    const raw = Buffer.from([
      `Message-ID: ${OPAQUE_MESSAGE_ID}`,
      `X-Codestead-Dispatch-Evidence: v1.${EVIDENCE_TOKEN}`,
      "Subject: opaque",
      "",
      "body",
    ].join("\r\n"), "utf8");
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        access_token: "access",
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        messages: [{ id: "gmail-opaque" }],
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: "gmail-opaque",
        labelIds: ["SENT"],
        raw: raw.toString("base64url"),
      }), { status: 200 })));

    await expect(findGmailMessageByMessageId({
      messageId: OPAQUE_MESSAGE_ID,
      authority: {
        kind: "opaque-header-v1",
        operationId: "22222222-2222-4222-8222-222222222222",
        adapterPayloadSha256: "b".repeat(64),
        providerEvidenceSha256: EVIDENCE_SHA256,
      },
    })).resolves.toEqual({
      kind: "matched",
      providerMessageId: "gmail-opaque",
      proof: {
        kind: "header-evidence-v1",
        providerEvidenceSha256: EVIDENCE_SHA256,
      },
    });
  });

  it.each([
    { label: "missing", evidenceLines: [] },
    {
      label: "duplicated",
      evidenceLines: [
        `X-Codestead-Dispatch-Evidence: v1.${EVIDENCE_TOKEN}`,
        `x-codestead-dispatch-evidence: v1.${EVIDENCE_TOKEN}`,
      ],
    },
    {
      label: "folded",
      evidenceLines: [
        "X-Codestead-Dispatch-Evidence: v1.",
        ` ${EVIDENCE_TOKEN}`,
      ],
    },
    {
      label: "malformed",
      evidenceLines: [
        "X-Codestead-Dispatch-Evidence: v1.not-canonical",
      ],
    },
  ])("keeps class C unresolved for $label evidence", async ({
    evidenceLines,
  }) => {
    const raw = Buffer.from([
      `Message-ID: ${OPAQUE_MESSAGE_ID}`,
      ...evidenceLines,
      "",
      "body",
    ].join("\r\n"), "utf8");
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        access_token: "access",
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        messages: [{ id: "gmail-opaque" }],
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: "gmail-opaque",
        labelIds: ["SENT"],
        raw: raw.toString("base64url"),
      }), { status: 200 })));

    await expect(findGmailMessageByMessageId({
      messageId: OPAQUE_MESSAGE_ID,
      authority: {
        kind: "opaque-header-v1",
        operationId: "22222222-2222-4222-8222-222222222222",
        adapterPayloadSha256: "b".repeat(64),
        providerEvidenceSha256: EVIDENCE_SHA256,
      },
    })).resolves.toEqual({ kind: "ambiguous" });
  });

  it.each(["list", "metadata"] as const)(
    "bounds $stage response parsing and drains the aborted fetch before returning",
    async (stage) => {
      vi.useFakeTimers();
      vi.stubEnv("GMAIL_REQUEST_TIMEOUT_MS", "1000");
      let abortObserved = false;
      let settleBody!: () => void;
      const fetchMock = vi.fn<typeof fetch>()
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
      fetchMock.mockImplementationOnce((_url, init) => Promise.resolve({
        ok: true,
        json: vi.fn(() => new Promise<unknown>((resolve) => {
          init?.signal?.addEventListener("abort", () => {
            abortObserved = true;
            settleBody = () => resolve(stage === "list"
              ? { messages: [] }
              : {
                id: "gmail-1",
                labelIds: ["SENT"],
                payload: {
                  headers: [{ name: "Message-ID", value: MESSAGE_ID }],
                },
              });
          }, { once: true });
        })),
      } as unknown as Response));
      vi.stubGlobal("fetch", fetchMock);

      let outcome: unknown = "pending";
      void lookup().then(
        (result) => { outcome = result; },
        (error) => { outcome = error; },
      );
      for (let index = 0; index < 40; index += 1) await Promise.resolve();
      expect(fetchMock).toHaveBeenCalledTimes(stage === "list" ? 2 : 3);

      await vi.advanceTimersByTimeAsync(1_001);
      expect(abortObserved).toBe(true);
      expect(outcome).toBe("pending");

      settleBody();
      await vi.advanceTimersByTimeAsync(0);
      expect(outcome).toBeInstanceOf(Error);
      expect((outcome as Error).message).toContain("reconciliation request timed out");
    },
  );
});
