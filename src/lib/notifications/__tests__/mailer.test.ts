import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  classifyMailDeliveryError,
  sendEmail as deliverEmail,
  type MailProviderContext,
  type OutgoingEmail,
} from "../mailer";

const PROVIDER_CONTEXT: MailProviderContext = {
  messageId:
    "<codestead.outbox.22222222-2222-4222-8222-222222222222@mail.codestead.invalid>",
};

function sendEmail(input: OutgoingEmail, context = PROVIDER_CONTEXT) {
  return deliverEmail(input, context);
}

describe("notification delivery privacy", () => {
  beforeEach(() => {
    vi.stubEnv("MAIL_ADAPTER", "console");
    vi.stubEnv("MAIL_FROM", "Codestead <noreply@example.com>");
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("console delivery logs allowlisted metadata only, never capability IDs, recipient, token, or body", async () => {
    const write = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    const recipient = "privacy-canary@recipient.private.example";
    const tombstoneId = "tombstone-capability-log-canary";
    const deletionRunId = "deletion-run-capability-log-canary";
    const token = "bearer-token-log-canary";
    const body = "private-final-notice-body-canary";

    await sendEmail({
      to: recipient,
      template: "account-deleted",
      variables: {
        backupRetentionUntil: "2026-08-22T00:00:00.000Z",
        tombstoneId,
        deletionRunId,
        url: `https://example.test/final?token=${token}`,
        body,
      },
    });

    const expected =
      '{"event":"email.console_delivery","template":"account-deleted"}\n';
    expect(write).toHaveBeenCalledExactlyOnceWith(expected);
    const emittedBytes = Buffer.concat(write.mock.calls.map(([chunk]) => (
      typeof chunk === "string"
        ? Buffer.from(chunk, "utf8")
        : Buffer.from(chunk)
    )));
    expect(emittedBytes).toEqual(Buffer.from(expected, "utf8"));
    expect(emittedBytes.at(-1)).toBe(0x0a);
    expect(emittedBytes.at(-2)).not.toBe(0x0a);
    const entry = JSON.parse(emittedBytes.subarray(0, -1).toString("utf8"));
    expect(entry).toEqual({
      event: "email.console_delivery",
      template: "account-deleted",
    });
    const serialized = emittedBytes.toString("utf8");
    expect(serialized).toContain("email.console_delivery");
    for (const sensitive of [recipient, "recipient.private.example", tombstoneId, deletionRunId, token, body]) {
      expect(serialized).not.toContain(sensitive);
    }
  });

  it.each(["https://backup.test/dump.sql", "https://backup.test/archive.tar", "https://backup.test/x.zip"])(
    "refuses to email backup archive reference %s",
    async (url) => {
      await expect(sendEmail({
        to: "admin@example.com", template: "backup-status", variables: { url },
      })).rejects.toThrow("Backup archives may not be emailed");
    },
  );

  it("rejects unknown delivery adapters rather than silently falling back", async () => {
    vi.stubEnv("MAIL_ADAPTER", "smtp-ish");
    const error = await sendEmail({
      to: "learner@example.com", template: "weekly-summary", variables: {},
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("MAIL_ADAPTER must be either console or gmail");
    expect(classifyMailDeliveryError(error)).toEqual({
      kind: "definitely-rejected",
      code: "MAIL_PRE_SEND_REJECTED",
    });
  });

  it.each(["999", "25001", "1000.5", "10s"])(
    "rejects unsafe Gmail request timeout configuration %s before any network call",
    async (timeout) => {
      vi.stubEnv("MAIL_ADAPTER", "gmail");
      vi.stubEnv("GMAIL_CLIENT_ID", "client");
      vi.stubEnv("GMAIL_CLIENT_SECRET", "secret");
      vi.stubEnv("GMAIL_REFRESH_TOKEN", "refresh");
      vi.stubEnv("GMAIL_REQUEST_TIMEOUT_MS", timeout);
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      await expect(sendEmail({
        to: "learner@example.com",
        template: "invitation",
        variables: {},
      })).rejects.toThrow(
        "GMAIL_REQUEST_TIMEOUT_MS must be an integer from 1000 to 25000.",
      );
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("rejects header injection before contacting OAuth or Gmail", async () => {
    vi.stubEnv("MAIL_ADAPTER", "gmail");
    vi.stubEnv("GMAIL_CLIENT_ID", "client");
    vi.stubEnv("GMAIL_CLIENT_SECRET", "secret");
    vi.stubEnv("GMAIL_REFRESH_TOKEN", "refresh");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(sendEmail({
      to: "learner@example.com\r\nBcc: attacker@example.com",
      template: "invitation",
      variables: { url: "https://example.test/activate" },
    })).rejects.toThrow("Invalid To header");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requires deterministic correlation context before Gmail OAuth", async () => {
    vi.stubEnv("MAIL_ADAPTER", "gmail");
    vi.stubEnv("GMAIL_CLIENT_ID", "client");
    vi.stubEnv("GMAIL_CLIENT_SECRET", "secret");
    vi.stubEnv("GMAIL_REFRESH_TOKEN", "refresh");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(deliverEmail({
      to: "learner@example.com",
      template: "invitation",
      variables: {},
    }, undefined as never)).rejects.toThrow("Invalid Message-ID header.");
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("aborts OAuth at the deadline, drains its settlement, and ignores the late response", async () => {
    vi.useFakeTimers();
    vi.stubEnv("MAIL_ADAPTER", "gmail");
    vi.stubEnv("GMAIL_CLIENT_ID", "client");
    vi.stubEnv("GMAIL_CLIENT_SECRET", "secret");
    vi.stubEnv("GMAIL_REFRESH_TOKEN", "refresh");
    vi.stubEnv("GMAIL_REQUEST_TIMEOUT_MS", "1000");
    let resolveOAuth!: (response: Response) => void;
    const lateOAuth = new Promise<Response>((resolve) => {
      resolveOAuth = resolve;
    });
    let abortObserved = false;
    const fetchMock = vi.fn<typeof fetch>((_url, init) => {
      init?.signal?.addEventListener("abort", () => {
        abortObserved = true;
      }, { once: true });
      return lateOAuth;
    });
    vi.stubGlobal("fetch", fetchMock);

    const pending = sendEmail({
      to: "learner@example.com",
      template: "invitation",
      variables: {},
    });
    let outcome: unknown = "pending";
    void pending.then(
      (value) => { outcome = value; },
      (error: unknown) => { outcome = error; },
    );

    await vi.advanceTimersByTimeAsync(1_000);
    expect(abortObserved).toBe(true);
    expect(outcome).toBe("pending");
    const signal = (fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)?.signal;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal?.aborted).toBe(true);

    resolveOAuth(new Response(JSON.stringify({ access_token: "late-token" }), { status: 200 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toBe("Gmail OAuth request timed out.");
    expect(classifyMailDeliveryError(outcome)).toEqual({
      kind: "definitely-rejected",
      code: "GMAIL_OAUTH_FAILED",
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("aborts Gmail delivery at the deadline, drains its settlement, and ignores the late response", async () => {
    vi.useFakeTimers();
    vi.stubEnv("MAIL_ADAPTER", "gmail");
    vi.stubEnv("GMAIL_CLIENT_ID", "client");
    vi.stubEnv("GMAIL_CLIENT_SECRET", "secret");
    vi.stubEnv("GMAIL_REFRESH_TOKEN", "refresh");
    vi.stubEnv("GMAIL_REQUEST_TIMEOUT_MS", "1000");
    let resolveDelivery!: (response: Response) => void;
    const lateDelivery = new Promise<Response>((resolve) => {
      resolveDelivery = resolve;
    });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "access" }), { status: 200 }))
      .mockImplementationOnce((_url, init: RequestInit | undefined) => {
        init?.signal?.addEventListener("abort", () => {
          abortObserved = true;
        }, { once: true });
        return lateDelivery;
      });
    let abortObserved = false;
    vi.stubGlobal("fetch", fetchMock);

    const pending = sendEmail({
      to: "learner@example.com",
      template: "invitation",
      variables: {},
    });
    let outcome: unknown = "pending";
    void pending.then(
      (value) => { outcome = value; },
      (error: unknown) => { outcome = error; },
    );

    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(abortObserved).toBe(true);
    expect(outcome).toBe("pending");
    const signal = (fetchMock.mock.calls[1]?.[1] as RequestInit | undefined)?.signal;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal?.aborted).toBe(true);

    resolveDelivery(new Response(JSON.stringify({ id: "late-id" }), { status: 200 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toBe("Gmail delivery request timed out.");
    expect(classifyMailDeliveryError(outcome)).toEqual({
      kind: "ambiguous",
      code: "GMAIL_DELIVERY_AMBIGUOUS",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("builds a multipart Gmail message and keeps OAuth credentials out of the MIME body", async () => {
    vi.stubEnv("MAIL_ADAPTER", "gmail");
    vi.stubEnv("GMAIL_CLIENT_ID", "client-id");
    vi.stubEnv("GMAIL_CLIENT_SECRET", "client-secret");
    vi.stubEnv("GMAIL_REFRESH_TOKEN", "refresh-secret");
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "access-secret" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "gmail-message-1" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(sendEmail({
      to: "learner@example.com",
      template: "invitation",
      variables: { name: "<Learner>", url: "https://example.test/activate?token=one-time" },
    }, {
      messageId: "<codestead.outbox.22222222-2222-4222-8222-222222222222@mail.codestead.invalid>",
    })).resolves.toEqual({ providerId: "gmail-message-1" });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [sendUrl, sendOptions] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(sendUrl).toBe("https://gmail.googleapis.com/gmail/v1/users/me/messages/send");
    expect((sendOptions.headers as Record<string, string>).authorization).toBe("Bearer access-secret");
    const raw = (JSON.parse(String(sendOptions.body)) as { raw: string }).raw;
    const mime = Buffer.from(raw, "base64url").toString("utf8");
    expect(mime).toContain("Content-Type: multipart/alternative");
    expect(mime).toContain(
      "Message-ID: <codestead.outbox.22222222-2222-4222-8222-222222222222@mail.codestead.invalid>",
    );
    expect(mime).toContain("&lt;Learner&gt;");
    expect(mime).toContain("one-time");
    expect(mime).not.toContain("client-secret");
    expect(mime).not.toContain("refresh-secret");
    expect(mime).not.toContain("access-secret");
  });

  it("does not expose Gmail response bodies in delivery errors", async () => {
    vi.stubEnv("MAIL_ADAPTER", "gmail");
    vi.stubEnv("GMAIL_CLIENT_ID", "client");
    vi.stubEnv("GMAIL_CLIENT_SECRET", "secret");
    vi.stubEnv("GMAIL_REFRESH_TOKEN", "refresh");
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "access" }), { status: 200 }))
      .mockResolvedValueOnce(new Response("provider echoed private email content", { status: 500 })));
    const error = await sendEmail({
      to: "learner@example.com", template: "invitation", variables: {},
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("Gmail delivery failed (500).");
    expect((error as Error).message).not.toContain("provider echoed private email content");
    expect(classifyMailDeliveryError(error)).toEqual({
      kind: "ambiguous",
      code: "GMAIL_DELIVERY_AMBIGUOUS",
    });
  });

  it.each([
    { body: {}, description: "missing" },
    { body: { id: "" }, description: "empty" },
    { body: { id: "   " }, description: "blank" },
  ])("rejects a Gmail 2xx response with a $description message ID", async ({ body }) => {
    vi.stubEnv("MAIL_ADAPTER", "gmail");
    vi.stubEnv("GMAIL_CLIENT_ID", "client");
    vi.stubEnv("GMAIL_CLIENT_SECRET", "secret");
    vi.stubEnv("GMAIL_REFRESH_TOKEN", "refresh");
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "access" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(body), { status: 200 })));

    await expect(sendEmail({
      to: "learner@example.com", template: "invitation", variables: {},
    })).rejects.toThrow("Gmail delivery returned no message ID.");
  });
});
