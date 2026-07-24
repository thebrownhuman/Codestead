import { afterEach, describe, expect, it, vi } from "vitest";

import {
  authorizePreparedEmail,
  classifyMailDeliveryError,
  prepareEmail,
  preparedEmailBindingMatches,
  sendPreparedEmail,
  type MailDispatchAuthority,
  type PreparedEmailAuthorization,
} from "../mailer";

const MESSAGE_ID =
  "<codestead.outbox.22222222-2222-4222-8222-222222222222@mail.codestead.invalid>";
const BOUNDARY_UUID = "33333333-3333-4333-8333-333333333333";
const AUTHORITY: MailDispatchAuthority = Object.freeze({
  id: "11111111-1111-4111-8111-111111111111",
  operationId: "22222222-2222-4222-8222-222222222222",
  claimToken: "44444444-4444-4444-8444-444444444444",
  claimOwner: "mail-worker:test",
  claimVersion: 7,
});

function gmailPreparation() {
  return {
    adapter: "gmail" as const,
    from: "Codestead <authority@codestead.test>",
    messageId: MESSAGE_ID,
    authority: AUTHORITY,
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("prepared mail dispatch", () => {
  it("freezes one exact Gmail rendering, raw value, request body, and internal authority binding", () => {
    const randomUuid = vi
      .spyOn(crypto, "randomUUID")
      .mockReturnValue(BOUNDARY_UUID);
    const variables = {
      name: "<Learner>",
      url: "https://example.test/activate?token=single-use",
    };

    const prepared = prepareEmail({
      to: "learner@example.test",
      template: "invitation",
      variables,
    }, gmailPreparation());

    expect(randomUuid).toHaveBeenCalledOnce();
    expect(Object.isFrozen(prepared)).toBe(true);
    expect(prepared).toMatchObject({
      adapter: "gmail",
      bindingVersion: "gmail-raw-v1",
      messageId: MESSAGE_ID,
    });
    if (prepared.adapter !== "gmail") throw new Error("Expected Gmail preparation.");
    expect(prepared.bindingSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(prepared.raw).toBe(
      Buffer.from(prepared.rfc822, "utf8").toString("base64url"),
    );
    expect(prepared.requestBody).toBe(`{"raw":${JSON.stringify(prepared.raw)}}`);
    expect(prepared.rfc822).toContain(
      `boundary="learncoding-${BOUNDARY_UUID}"`,
    );
    expect(prepared.rfc822).toContain(
      "From: Codestead <authority@codestead.test>",
    );
    expect(prepared.rfc822).toContain("To: learner@example.test");
    expect(prepared.rfc822).toContain(`Message-ID: ${MESSAGE_ID}`);
    expect(prepared.rfc822).toContain("&lt;Learner&gt;");
    expect(preparedEmailBindingMatches(prepared, AUTHORITY)).toBe(true);

    const original = { ...prepared };
    variables.name = "Mutated after preparation";
    vi.stubEnv("MAIL_ADAPTER", "console");
    vi.stubEnv("MAIL_FROM", "Attacker <attacker@example.test>");
    expect(prepared).toEqual(original);
    expect(() => Object.assign(prepared, { requestBody: "tampered" })).toThrow();

    const changedByte = {
      ...prepared,
      rfc822: `${prepared.rfc822.slice(0, -1)}X`,
    };
    expect(preparedEmailBindingMatches(changedByte, AUTHORITY)).toBe(false);
  });

  it("submits the exact frozen Gmail body without rerendering, stringifying, or rereading adapter and sender", async () => {
    const randomUuid = vi
      .spyOn(crypto, "randomUUID")
      .mockReturnValue(BOUNDARY_UUID);
    const prepared = prepareEmail({
      to: "learner@example.test",
      template: "invitation",
      variables: { url: "https://example.test/activate?token=once" },
    }, gmailPreparation());
    if (prepared.adapter !== "gmail") throw new Error("Expected Gmail preparation.");
    const tokenResponse = new Response(
      '{"access_token":"oauth-access-secret"}',
      { status: 200 },
    );
    const sendResponse = new Response('{"id":"gmail-message-1"}', {
      status: 200,
    });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(tokenResponse)
      .mockResolvedValueOnce(sendResponse);
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("GMAIL_CLIENT_ID", "client");
    vi.stubEnv("GMAIL_CLIENT_SECRET", "client-secret");
    vi.stubEnv("GMAIL_REFRESH_TOKEN", "refresh-secret");
    vi.stubEnv("MAIL_ADAPTER", "console");
    vi.stubEnv("MAIL_FROM", "Attacker <attacker@example.test>");

    const stringify = vi.spyOn(JSON, "stringify");
    const authorization = await authorizePreparedEmail(prepared);
    await expect(
      sendPreparedEmail(prepared, AUTHORITY, authorization),
    ).resolves.toEqual({ providerId: "gmail-message-1" });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [, sendOptions] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(sendOptions.body).toBe(prepared.requestBody);
    expect(stringify).not.toHaveBeenCalled();
    expect(randomUuid).toHaveBeenCalledOnce();
    expect(prepared.rfc822).toContain(
      "From: Codestead <authority@codestead.test>",
    );
    expect(prepared.rfc822).not.toContain("attacker@example.test");
    expect(JSON.stringify(prepared)).not.toContain("oauth-access-secret");
    expect(JSON.stringify(prepared)).not.toContain("client-secret");
    expect(JSON.stringify(prepared)).not.toContain("refresh-secret");
  });

  it("rejects a runtime template outside the allowlist before creating any prepared artifact", () => {
    const randomUuid = vi
      .spyOn(crypto, "randomUUID")
      .mockReturnValue(BOUNDARY_UUID);

    expect(() => prepareEmail({
      to: "privacy-canary@example.test",
      template: 'weekly-summary","recipient":"privacy-canary' as never,
      variables: {},
    }, {
      adapter: "console",
      from: "unused@example.test",
      messageId: MESSAGE_ID,
      authority: AUTHORITY,
    })).toThrow("Invalid email template.");
    expect(randomUuid).not.toHaveBeenCalled();
  });

  it("rejects a runtime adapter outside the allowlist before rendering", () => {
    const randomUuid = vi
      .spyOn(crypto, "randomUUID")
      .mockReturnValue(BOUNDARY_UUID);

    expect(() => prepareEmail({
      to: "learner@example.test",
      template: "invitation",
      variables: {},
    }, {
      ...gmailPreparation(),
      adapter: "smtp" as never,
    })).toThrow("Invalid mail adapter.");
    expect(randomUuid).not.toHaveBeenCalled();
  });

  it("reserves five seconds of the 25-second provider budget for abort settlement", async () => {
    vi.spyOn(crypto, "randomUUID").mockReturnValue(BOUNDARY_UUID);
    const prepared = prepareEmail({
      to: "learner@example.test",
      template: "invitation",
      variables: {},
    }, gmailPreparation());
    vi.stubEnv("GMAIL_CLIENT_ID", "client");
    vi.stubEnv("GMAIL_CLIENT_SECRET", "secret");
    vi.stubEnv("GMAIL_REFRESH_TOKEN", "refresh");
    vi.stubEnv("GMAIL_REQUEST_TIMEOUT_MS", "25000");
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(
        '{"access_token":"oauth-access-secret"}',
        { status: 200 },
      ));
    vi.stubGlobal("fetch", fetchMock);

    await expect(authorizePreparedEmail(prepared)).resolves.toEqual({
      adapter: "gmail",
      accessToken: "oauth-access-secret",
      requestTimeoutMs: 20_000,
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it.each([
    {
      authorization: {
        adapter: "gmail",
        accessToken: "",
        requestTimeoutMs: 1_000,
      },
    },
    {
      authorization: {
        adapter: "gmail",
        accessToken: "oauth-access-secret",
        requestTimeoutMs: 0,
      },
    },
    {
      authorization: {
        adapter: "gmail",
        accessToken: "oauth-access-secret",
        requestTimeoutMs: 20_001,
      },
    },
  ] as const)("rejects malformed prepared Gmail authorization before fetch", async ({
    authorization,
  }) => {
    vi.spyOn(crypto, "randomUUID").mockReturnValue(BOUNDARY_UUID);
    const prepared = prepareEmail({
      to: "learner@example.test",
      template: "invitation",
      variables: {},
    }, gmailPreparation());
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const error = await sendPreparedEmail(
      prepared,
      AUTHORITY,
      authorization,
    ).catch((caught: unknown) => caught);

    expect(classifyMailDeliveryError(error)).toEqual({
      kind: "definitely-rejected",
      code: "MAIL_PRE_SEND_REJECTED",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a one-byte prepared-body mutation before any provider call", async () => {
    vi.spyOn(crypto, "randomUUID").mockReturnValue(BOUNDARY_UUID);
    const prepared = prepareEmail({
      to: "learner@example.test",
      template: "invitation",
      variables: {},
    }, gmailPreparation());
    if (prepared.adapter !== "gmail") throw new Error("Expected Gmail preparation.");
    const tampered = {
      ...prepared,
      requestBody: `${prepared.requestBody.slice(0, -1)}X`,
    };
    const authorization: PreparedEmailAuthorization = Object.freeze({
      adapter: "gmail",
      accessToken: "oauth-access-secret",
      requestTimeoutMs: 1_000,
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const error = await sendPreparedEmail(
      tampered,
      AUTHORITY,
      authorization,
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect(classifyMailDeliveryError(error)).toEqual({
      kind: "definitely-rejected",
      code: "PAYLOAD_DIGEST_MISMATCH",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("awaits Gmail fetch settlement after abort before reporting the bounded timeout", async () => {
    vi.useFakeTimers();
    vi.spyOn(crypto, "randomUUID").mockReturnValue(BOUNDARY_UUID);
    const prepared = prepareEmail({
      to: "learner@example.test",
      template: "invitation",
      variables: {},
    }, gmailPreparation());
    vi.stubEnv("GMAIL_CLIENT_ID", "client");
    vi.stubEnv("GMAIL_CLIENT_SECRET", "secret");
    vi.stubEnv("GMAIL_REFRESH_TOKEN", "refresh");
    vi.stubEnv("GMAIL_REQUEST_TIMEOUT_MS", "1000");
    let abortObserved = false;
    let settleAbortedFetch!: () => void;
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(
        '{"access_token":"oauth-access-secret"}',
        { status: 200 },
      ))
      .mockImplementationOnce((_url, init) => new Promise<Response>(
        (_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            abortObserved = true;
            settleAbortedFetch = () => reject(
              new DOMException("The request was aborted.", "AbortError"),
            );
          }, { once: true });
        },
      ));
    vi.stubGlobal("fetch", fetchMock);
    const authorization = await authorizePreparedEmail(prepared);

    let outcome: unknown = "pending";
    void sendPreparedEmail(prepared, AUTHORITY, authorization).then(
      (value) => { outcome = value; },
      (error: unknown) => { outcome = error; },
    );
    await vi.advanceTimersByTimeAsync(1_000);

    expect(abortObserved).toBe(true);
    expect(outcome).toBe("pending");

    settleAbortedFetch();
    await vi.advanceTimersByTimeAsync(0);
    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toBe(
      "Gmail delivery request timed out.",
    );
    expect(classifyMailDeliveryError(outcome)).toEqual({
      kind: "ambiguous",
      code: "GMAIL_DELIVERY_AMBIGUOUS",
    });
  });

  it("fails closed after a bounded reserve when an aborted Gmail fetch never settles", async () => {
    vi.useFakeTimers();
    vi.spyOn(crypto, "randomUUID").mockReturnValue(BOUNDARY_UUID);
    const prepared = prepareEmail({
      to: "learner@example.test",
      template: "invitation",
      variables: {},
    }, gmailPreparation());
    const authorization: PreparedEmailAuthorization = Object.freeze({
      adapter: "gmail",
      accessToken: "oauth-access-secret",
      requestTimeoutMs: 1_000,
    });
    const observed: { signal: AbortSignal | null } = { signal: null };
    const fetchMock = vi.fn<typeof fetch>((_url, init) => {
      observed.signal = init?.signal ?? null;
      return new Promise<Response>(() => undefined);
    });
    vi.stubGlobal("fetch", fetchMock);

    let outcome: unknown = "pending";
    void sendPreparedEmail(prepared, AUTHORITY, authorization).then(
      (value) => { outcome = value; },
      (error: unknown) => { outcome = error; },
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(observed.signal?.aborted).toBe(true);
    expect(outcome).toBe("pending");

    await vi.advanceTimersByTimeAsync(4_999);
    expect(outcome).toBe("pending");
    await vi.advanceTimersByTimeAsync(1);
    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toBe(
      "Gmail delivery request did not settle after abort.",
    );
    expect(classifyMailDeliveryError(outcome)).toEqual({
      kind: "ambiguous",
      code: "GMAIL_DELIVERY_AMBIGUOUS",
    });
  });

  it("drains an externally aborted Gmail fetch, discards its late success, and remains ambiguous", async () => {
    vi.useFakeTimers();
    vi.spyOn(crypto, "randomUUID").mockReturnValue(BOUNDARY_UUID);
    const prepared = prepareEmail({
      to: "learner@example.test",
      template: "invitation",
      variables: {},
    }, gmailPreparation());
    const authorization: PreparedEmailAuthorization = Object.freeze({
      adapter: "gmail",
      accessToken: "oauth-access-secret",
      requestTimeoutMs: 20_000,
    });
    const externalAbort = new AbortController();
    let resolveDelivery!: (response: Response) => void;
    const lateDelivery = new Promise<Response>((resolve) => {
      resolveDelivery = resolve;
    });
    const observed: { signal: AbortSignal | null } = { signal: null };
    const fetchMock = vi.fn<typeof fetch>((_url, init) => {
      observed.signal = init?.signal ?? null;
      return lateDelivery;
    });
    vi.stubGlobal("fetch", fetchMock);

    let outcome: unknown = "pending";
    void sendPreparedEmail(
      prepared,
      AUTHORITY,
      authorization,
      { signal: externalAbort.signal },
    ).then(
      (value) => { outcome = value; },
      (error: unknown) => { outcome = error; },
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledOnce();

    externalAbort.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(observed.signal?.aborted).toBe(true);
    expect(outcome).toBe("pending");

    resolveDelivery(new Response('{"id":"late-provider-success"}', {
      status: 200,
    }));
    await vi.advanceTimersByTimeAsync(0);
    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toBe(
      "Gmail delivery request aborted.",
    );
    expect(classifyMailDeliveryError(outcome)).toEqual({
      kind: "ambiguous",
      code: "GMAIL_DELIVERY_AMBIGUOUS",
    });
  });

  it("prepares one explicit safe console event and never logs recipient, authority, provider ID, or payload PII", async () => {
    const randomUuid = vi
      .spyOn(crypto, "randomUUID")
      .mockReturnValue(BOUNDARY_UUID);
    const prepared = prepareEmail({
      to: "privacy-canary@recipient.private.example",
      template: "account-deleted",
      variables: {
        backupRetentionUntil: "2026-08-22T00:00:00.000Z",
        tombstoneId: "tombstone-capability-log-canary",
        deletionRunId: "deletion-run-capability-log-canary",
        url: "https://example.test/final?token=bearer-token-log-canary",
        body: "private-final-notice-body-canary",
      },
    }, {
      adapter: "console",
      from: "unused@example.test",
      messageId: MESSAGE_ID,
      authority: AUTHORITY,
    });
    expect(prepared).toMatchObject({
      adapter: "console",
      bindingVersion: "console-json-v1",
      eventLine:
        '{"event":"email.console_delivery","template":"account-deleted"}',
      requestBody:
        '{"event":"email.console_delivery","template":"account-deleted"}',
    });
    if (prepared.adapter !== "console") {
      throw new Error("Expected console preparation.");
    }
    expect(Object.isFrozen(prepared)).toBe(true);
    expect(preparedEmailBindingMatches(prepared, AUTHORITY)).toBe(true);
    vi.stubEnv("MAIL_ADAPTER", "gmail");
    const log = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const authorization = await authorizePreparedEmail(prepared);

    await expect(
      sendPreparedEmail(prepared, AUTHORITY, authorization),
    ).resolves.toEqual({
      providerId: `console-${BOUNDARY_UUID}`,
    });

    expect(randomUuid).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledExactlyOnceWith(prepared.eventLine);
    const serialized = log.mock.calls.flat().join("\n");
    for (const sensitive of [
      "privacy-canary",
      AUTHORITY.id,
      AUTHORITY.operationId,
      AUTHORITY.claimToken,
      `console-${BOUNDARY_UUID}`,
      "tombstone-capability",
      "deletion-run-capability",
      "bearer-token",
      "private-final-notice",
    ]) {
      expect(serialized).not.toContain(sensitive);
    }
  });
});
