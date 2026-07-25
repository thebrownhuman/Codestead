import { createHash } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  authorizePreparedEmail,
  classifyMailDeliveryError,
  dispatchBinding,
  prepareEmail,
  preparedEmailBindingMatches,
  sendPreparedEmail,
  type DispatchBinding,
  type MailDispatchAuthority,
  type PreparedEmailAuthorization,
} from "../mailer";
import { outboxMessageId } from "../provider-correlation";

const OPERATION_ID = "22222222-2222-4222-8222-222222222222";
const MESSAGE_ID = outboxMessageId(OPERATION_ID);
const OTHER_MESSAGE_ID = outboxMessageId("55555555-5555-4555-8555-555555555555");
const BOUNDARY_UUID = "33333333-3333-4333-8333-333333333333";
const AUTHORITY: MailDispatchAuthority = Object.freeze({
  id: "11111111-1111-4111-8111-111111111111",
  operationId: OPERATION_ID,
  claimToken: "44444444-4444-4444-8444-444444444444",
  claimOwner: "mail-worker:test",
  claimVersion: 7,
  deliveryScopeKey: "a:learner-1",
  recipient: "learner@example.test",
  template: "invitation",
  templateVersion: "1",
});

function gmailPreparation() {
  return {
    adapter: "gmail" as const,
    from: "Codestead <authority@codestead.test>",
    messageId: MESSAGE_ID,
    authority: AUTHORITY,
  };
}

function oneReadObject<T extends object>(source: T) {
  const reads = new Map<keyof T, number>();
  const target: Record<PropertyKey, unknown> = {};
  for (const key of Object.keys(source) as (keyof T)[]) {
    Object.defineProperty(target, key, {
      enumerable: true,
      get() {
        const count = (reads.get(key) ?? 0) + 1;
        reads.set(key, count);
        if (count > 1) {
          throw new Error(`Scalar ${String(key)} was read more than once.`);
        }
        return source[key];
      },
    });
  }
  return {
    value: target as T,
    assertEachReadOnce() {
      expect([...reads.values()]).toEqual(
        Object.keys(source).map(() => 1),
      );
    },
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
      templateVersion: "1",
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
    const expectedPayloadSha256 = createHash("sha256")
      .update(prepared.rfc822, "utf8")
      .digest("hex");
    expect(prepared.bindingSha256).toBe(expectedPayloadSha256);
    const binding = dispatchBinding(prepared);
    expect(Object.isFrozen(binding)).toBe(true);
    expect(Object.keys(binding)).toEqual([
      "bindingVersion",
      "bindingSha256",
    ]);
    expect(binding).toEqual({
      bindingVersion: "gmail-raw-v1",
      bindingSha256: expectedPayloadSha256,
    });
    expect(prepared.authorityBindingVersion).toBe("prepared-authority-v1");
    expect(prepared.authorityBindingSha256).toMatch(/^[0-9a-f]{64}$/);
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

  it.each([
    ["recipient", { to: "other@example.test" }, {}],
    ["template", { template: "access-rejected" as const }, {}],
    ["template version", { templateVersion: "2" }, {}],
    ["operation Message-ID", {}, { messageId: OTHER_MESSAGE_ID }],
  ])("rejects an authoritative %s mismatch before rendering", (
    _field,
    inputOverride,
    contextOverride,
  ) => {
    const randomUuid = vi
      .spyOn(crypto, "randomUUID")
      .mockReturnValue(BOUNDARY_UUID);

    expect(() => prepareEmail({
      to: "learner@example.test",
      template: "invitation",
      templateVersion: "1",
      variables: {},
      ...inputOverride,
    }, {
      ...gmailPreparation(),
      ...contextOverride,
    })).toThrow(/authority|Message-ID|version/i);
    expect(randomUuid).not.toHaveBeenCalled();
  });

  it.each([
    ["delivery scope", { deliveryScopeKey: "a:other" }],
    ["recipient", { recipient: "other@example.test" }],
    ["template", { template: "access-rejected" as const }],
    ["template version", { templateVersion: "2" }],
  ])("binds the exact authoritative %s into the digest", (
    _field,
    authorityOverride,
  ) => {
    vi.spyOn(crypto, "randomUUID").mockReturnValue(BOUNDARY_UUID);
    const prepared = prepareEmail({
      to: "learner@example.test",
      template: "invitation",
      templateVersion: "1",
      variables: {},
    }, gmailPreparation());

    expect(preparedEmailBindingMatches(prepared, {
      ...AUTHORITY,
      ...authorityOverride,
    })).toBe(false);
  });

  it("rejects the removed exam-result template before rendering", () => {
    const randomUuid = vi
      .spyOn(crypto, "randomUUID")
      .mockReturnValue(BOUNDARY_UUID);

    expect(() => prepareEmail({
      to: "learner@example.test",
      template: "exam-result" as never,
      templateVersion: "1",
      variables: {},
    }, {
      ...gmailPreparation(),
      authority: {
        ...AUTHORITY,
        template: "exam-result" as never,
      },
    })).toThrow("Invalid email template.");
    expect(randomUuid).not.toHaveBeenCalled();
  });

  it("submits the exact frozen Gmail body without rerendering, stringifying, or rereading adapter and sender", async () => {
    const randomUuid = vi
      .spyOn(crypto, "randomUUID")
      .mockReturnValue(BOUNDARY_UUID);
    const prepared = prepareEmail({
      to: "learner@example.test",
      template: "invitation",
      templateVersion: "1",
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
    const authorization = await authorizePreparedEmail(prepared, AUTHORITY);
    await expect(
      sendPreparedEmail(authorization),
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

  it("rejects mutated dispatch evidence before OAuth or delivery in the public sequence", async () => {
    vi.spyOn(crypto, "randomUUID").mockReturnValue(BOUNDARY_UUID);
    const original = prepareEmail({
      to: "learner@example.test",
      template: "invitation",
      templateVersion: "1",
      variables: {},
    }, gmailPreparation());
    if (original.adapter !== "gmail") throw new Error("Expected Gmail preparation.");
    const mutatedPrepared = {
      ...original,
      requestBody: '{"raw":"mutated-before-authorization"}',
      rfc822: `${original.rfc822}\r\nmutated-before-authorization`,
      bindingSha256:
        "0".repeat(64) as typeof original.bindingSha256,
      authorityBindingSha256:
        "f".repeat(64) as typeof original.authorityBindingSha256,
    };
    const mutatedAuthority: MailDispatchAuthority = {
      ...AUTHORITY,
      deliveryScopeKey: "a:other-learner",
      recipient: "other@example.test",
      template: "access-rejected",
      templateVersion: "1",
    };
    vi.stubEnv("GMAIL_CLIENT_ID", "client");
    vi.stubEnv("GMAIL_CLIENT_SECRET", "client-secret");
    vi.stubEnv("GMAIL_REFRESH_TOKEN", "refresh-secret");
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response('{"access_token":"must-not-be-requested"}', {
        status: 200,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const error = await (async () => {
      const authorization = await authorizePreparedEmail(
        mutatedPrepared,
        mutatedAuthority,
      );
      return sendPreparedEmail(authorization);
    })().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(classifyMailDeliveryError(error)).toEqual({
      kind: "definitely-rejected",
      code: "PAYLOAD_DIGEST_MISMATCH",
    });
    const requestedUrls = fetchMock.mock.calls.map(([url]) => String(url));
    expect(requestedUrls.filter((url) =>
      url === "https://oauth2.googleapis.com/token"
    )).toHaveLength(0);
    expect(requestedUrls.filter((url) =>
      url.endsWith("/gmail/v1/users/me/messages/send")
    )).toHaveLength(0);
  });
  it("uses only entry snapshots when callers mutate inputs while OAuth is in flight", async () => {
    vi.spyOn(crypto, "randomUUID").mockReturnValue(BOUNDARY_UUID);
    const original = prepareEmail({
      to: "learner@example.test",
      template: "invitation",
      templateVersion: "1",
      variables: {},
    }, gmailPreparation());
    if (original.adapter !== "gmail") throw new Error("Expected Gmail preparation.");
    const mutablePrepared = { ...original };
    const mutableAuthority = { ...AUTHORITY };
    vi.stubEnv("GMAIL_CLIENT_ID", "client");
    vi.stubEnv("GMAIL_CLIENT_SECRET", "client-secret");
    vi.stubEnv("GMAIL_REFRESH_TOKEN", "refresh-secret");
    let resolveToken!: (response: Response) => void;
    const tokenResponse = new Promise<Response>((resolve) => {
      resolveToken = resolve;
    });
    const fetchMock = vi.fn<typeof fetch>()
      .mockImplementationOnce(() => tokenResponse)
      .mockResolvedValueOnce(
        new Response('{"id":"gmail-snapshotted"}', { status: 200 }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const authorizationPromise = authorizePreparedEmail(
      mutablePrepared,
      mutableAuthority,
    );
    Object.assign(mutablePrepared, {
      adapter: "console",
      bindingVersion: "console-json-v1",
      bindingSha256: "0".repeat(64),
      messageId: OTHER_MESSAGE_ID,
      authorityBindingVersion: "prepared-authority-v1-mutated",
      authorityBindingSha256: "f".repeat(64),
      rfc822: "mutated-rfc822",
      raw: "mutated-raw",
      requestBody: '{"raw":"mutated"}',
    });
    Object.assign(mutableAuthority, {
      id: "mutated-id",
      operationId: "mutated-operation",
      claimToken: "mutated-token",
      claimOwner: "mutated-owner",
      claimVersion: 99,
      deliveryScopeKey: "a:mutated",
      recipient: "mutated@example.test",
      template: "access-rejected",
      templateVersion: "99",
    });
    resolveToken(new Response(
      '{"access_token":"original-oauth-token"}',
      { status: 200 },
    ));
    const authorization = await authorizationPromise;
    const delivery = sendPreparedEmail(authorization);

    await expect(delivery).resolves.toEqual({
      providerId: "gmail-snapshotted",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [, options] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(options.body).toBe(original.requestBody);
    expect(options.headers).toEqual({
      authorization: "Bearer original-oauth-token",
      "content-type": "application/json",
    });
  });

  it("reads every caller-supplied prepared and authority scalar exactly once at authorization entry", async () => {
    vi.spyOn(crypto, "randomUUID").mockReturnValue(BOUNDARY_UUID);
    const original = prepareEmail({
      to: "learner@example.test",
      template: "invitation",
      templateVersion: "1",
      variables: {},
    }, gmailPreparation());
    if (original.adapter !== "gmail") throw new Error("Expected Gmail preparation.");
    const prepared = oneReadObject(original);
    const authority = oneReadObject(AUTHORITY);
    vi.stubEnv("GMAIL_CLIENT_ID", "client");
    vi.stubEnv("GMAIL_CLIENT_SECRET", "client-secret");
    vi.stubEnv("GMAIL_REFRESH_TOKEN", "refresh-secret");
    vi.stubGlobal("fetch", vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(
        '{"access_token":"oauth-access-secret"}',
        { status: 200 },
      ))
      .mockResolvedValueOnce(
        new Response('{"id":"gmail-read-once"}', { status: 200 }),
      ));

    const authorization = await authorizePreparedEmail(
      prepared.value,
      authority.value,
    );
    await expect(sendPreparedEmail(authorization))
      .resolves.toEqual({ providerId: "gmail-read-once" });

    prepared.assertEachReadOnce();
    authority.assertEachReadOnce();
  });

  it("rejects a runtime template outside the allowlist before creating any prepared artifact", () => {
    const randomUuid = vi
      .spyOn(crypto, "randomUUID")
      .mockReturnValue(BOUNDARY_UUID);

    expect(() => prepareEmail({
      to: "privacy-canary@example.test",
      template: 'weekly-summary","recipient":"privacy-canary' as never,
      templateVersion: "1",
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
      templateVersion: "1",
      variables: {},
    }, {
      ...gmailPreparation(),
      adapter: "smtp" as never,
    })).toThrow("Invalid mail adapter.");
    expect(randomUuid).not.toHaveBeenCalled();
  });

  it("reserves five seconds of the 25-second provider budget for abort settlement", async () => {
    vi.useFakeTimers();
    vi.spyOn(crypto, "randomUUID").mockReturnValue(BOUNDARY_UUID);
    const prepared = prepareEmail({
      to: "learner@example.test",
      template: "invitation",
      templateVersion: "1",
      variables: {},
    }, gmailPreparation());
    vi.stubEnv("GMAIL_CLIENT_ID", "client");
    vi.stubEnv("GMAIL_CLIENT_SECRET", "secret");
    vi.stubEnv("GMAIL_REFRESH_TOKEN", "refresh");
    vi.stubEnv("GMAIL_REQUEST_TIMEOUT_MS", "25000");
    let abortObserved = false;
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(
        '{"access_token":"oauth-access-secret"}',
        { status: 200 },
      ))
      .mockImplementationOnce((_url, init) => new Promise<Response>(
        (_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            abortObserved = true;
            reject(new DOMException(
              "The request was aborted.",
              "AbortError",
            ));
          }, { once: true });
        },
      ));
    vi.stubGlobal("fetch", fetchMock);

    const authorization = await authorizePreparedEmail(prepared, AUTHORITY);
    let outcome: unknown = "pending";
    void sendPreparedEmail(authorization).then(
      (value) => { outcome = value; },
      (error: unknown) => { outcome = error; },
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(19_999);
    expect(abortObserved).toBe(false);
    expect(outcome).toBe("pending");
    await vi.advanceTimersByTimeAsync(1);

    expect(abortObserved).toBe(true);
    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toBe(
      "Gmail delivery request timed out.",
    );
    expect(classifyMailDeliveryError(outcome)).toEqual({
      kind: "ambiguous",
      code: "GMAIL_DELIVERY_AMBIGUOUS",
    });
  });

  it("fails fatally when OAuth ignores abort and never reaches Gmail delivery", async () => {
    vi.useFakeTimers();
    vi.spyOn(crypto, "randomUUID").mockReturnValue(BOUNDARY_UUID);
    const prepared = prepareEmail({
      to: "learner@example.test",
      template: "invitation",
      templateVersion: "1",
      variables: {},
    }, gmailPreparation());
    vi.stubEnv("GMAIL_CLIENT_ID", "client");
    vi.stubEnv("GMAIL_CLIENT_SECRET", "client-secret");
    vi.stubEnv("GMAIL_REFRESH_TOKEN", "refresh-secret");
    vi.stubEnv("GMAIL_REQUEST_TIMEOUT_MS", "1000");
    const observed: { signal: AbortSignal | null } = { signal: null };
    const fetchMock = vi.fn<typeof fetch>((_url, init) => {
      observed.signal = init?.signal ?? null;
      return new Promise<Response>(() => undefined);
    });
    vi.stubGlobal("fetch", fetchMock);

    let outcome: unknown = "pending";
    void authorizePreparedEmail(prepared, AUTHORITY).then(
      (value) => { outcome = value; },
      (error: unknown) => { outcome = error; },
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "https://oauth2.googleapis.com/token",
    );

    await vi.advanceTimersByTimeAsync(1_000);
    expect(observed.signal?.aborted).toBe(true);
    expect(outcome).toBe("pending");

    await vi.advanceTimersByTimeAsync(4_999);
    expect(outcome).toBe("pending");
    await vi.advanceTimersByTimeAsync(1);
    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toBe(
      "Gmail OAuth request did not settle after abort.",
    );
    expect(classifyMailDeliveryError(outcome)).toEqual({
      kind: "fatal",
      code: "GMAIL_OAUTH_TRANSPORT_UNSETTLED",
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls.some(([url]) => (
      String(url).endsWith("/gmail/v1/users/me/messages/send")
    ))).toBe(false);
  });

  it("issues a secret-free one-shot handle that clones cannot replay or rebind", async () => {
    vi.spyOn(crypto, "randomUUID").mockReturnValue(BOUNDARY_UUID);
    const bearerUrl =
      "https://example.test/activate?token=opaque-handle-bearer-canary";
    const preparedA = prepareEmail({
      to: "learner@example.test",
      template: "invitation",
      templateVersion: "1",
      variables: { url: bearerUrl },
    }, gmailPreparation());
    if (preparedA.adapter !== "gmail") {
      throw new Error("Expected Gmail preparation.");
    }
    const authorityB: MailDispatchAuthority = Object.freeze({
      ...AUTHORITY,
      id: "66666666-6666-4666-8666-666666666666",
      operationId: "55555555-5555-4555-8555-555555555555",
      claimToken: "77777777-7777-4777-8777-777777777777",
      deliveryScopeKey: "a:other-learner",
      recipient: "other-learner@example.test",
    });
    const preparedB = prepareEmail({
      to: authorityB.recipient,
      template: authorityB.template,
      templateVersion: authorityB.templateVersion,
      variables: { url: "https://example.test/activate?token=other" },
    }, {
      ...gmailPreparation(),
      messageId: OTHER_MESSAGE_ID,
      authority: authorityB,
    });
    vi.stubEnv("GMAIL_CLIENT_ID", "client");
    vi.stubEnv("GMAIL_CLIENT_SECRET", "client-secret");
    vi.stubEnv("GMAIL_REFRESH_TOKEN", "refresh-secret");
    const accessToken = "oauth-opaque-handle-secret";
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(
        `{"access_token":"${accessToken}"}`,
        { status: 200 },
      ))
      .mockResolvedValueOnce(new Response(
        '{"id":"gmail-original-dispatch"}',
        { status: 200 },
      ));
    vi.stubGlobal("fetch", fetchMock);
    const authorization = await authorizePreparedEmail(
      preparedA,
      AUTHORITY,
    );

    expect(Object.isFrozen(authorization)).toBe(true);
    expect(Reflect.ownKeys(authorization)).toEqual([]);
    expect(Object.getOwnPropertyDescriptors(authorization)).toEqual({});
    expect(JSON.stringify(authorization)).toBe("{}");
    expect(String(authorization)).toBe("[object Object]");
    const exposed = [
      JSON.stringify(authorization),
      String(authorization),
      Reflect.ownKeys(authorization).join(","),
    ].join("\n");
    for (const secret of [
      accessToken,
      AUTHORITY.recipient,
      AUTHORITY.claimToken,
      bearerUrl,
      preparedA.requestBody,
    ]) {
      expect(exposed).not.toContain(secret);
    }

    const spreadClone = Object.freeze({
      ...authorization,
    }) as unknown as PreparedEmailAuthorization;
    const reboundClone = Object.freeze({
      ...authorization,
      adapter: "gmail",
      prepared: preparedB,
      authority: authorityB,
      accessToken,
      requestTimeoutMs: 1_000,
    }) as unknown as PreparedEmailAuthorization;
    fetchMock.mockClear();

    const cloneError = await sendPreparedEmail(spreadClone)
      .catch((caught: unknown) => caught);
    expect(classifyMailDeliveryError(cloneError)).toEqual({
      kind: "definitely-rejected",
      code: "MAIL_PRE_SEND_REJECTED",
    });
    expect(fetchMock).not.toHaveBeenCalled();

    await expect(sendPreparedEmail(authorization)).resolves.toEqual({
      providerId: "gmail-original-dispatch",
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    fetchMock.mockClear();

    const reboundError = await sendPreparedEmail(reboundClone)
      .catch((caught: unknown) => caught);
    const replayError = await sendPreparedEmail(authorization)
      .catch((caught: unknown) => caught);
    for (const error of [reboundError, replayError]) {
      expect(classifyMailDeliveryError(error)).toEqual({
        kind: "definitely-rejected",
        code: "MAIL_PRE_SEND_REJECTED",
      });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a one-byte prepared-body mutation before any provider call", async () => {
    vi.spyOn(crypto, "randomUUID").mockReturnValue(BOUNDARY_UUID);
    const prepared = prepareEmail({
      to: "learner@example.test",
      template: "invitation",
      templateVersion: "1",
      variables: {},
    }, gmailPreparation());
    if (prepared.adapter !== "gmail") throw new Error("Expected Gmail preparation.");
    const tampered = {
      ...prepared,
      requestBody: `${prepared.requestBody.slice(0, -1)}X`,
    };
    vi.stubEnv("GMAIL_CLIENT_ID", "client");
    vi.stubEnv("GMAIL_CLIENT_SECRET", "client-secret");
    vi.stubEnv("GMAIL_REFRESH_TOKEN", "refresh-secret");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const error = await authorizePreparedEmail(
      tampered,
      AUTHORITY,
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
      templateVersion: "1",
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
    const authorization = await authorizePreparedEmail(prepared, AUTHORITY);

    let outcome: unknown = "pending";
    void sendPreparedEmail(authorization).then(
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
      templateVersion: "1",
      variables: {},
    }, gmailPreparation());
    vi.stubEnv("GMAIL_CLIENT_ID", "client");
    vi.stubEnv("GMAIL_CLIENT_SECRET", "client-secret");
    vi.stubEnv("GMAIL_REFRESH_TOKEN", "refresh-secret");
    vi.stubEnv("GMAIL_REQUEST_TIMEOUT_MS", "1000");
    const observed: { signal: AbortSignal | null } = { signal: null };
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(
        '{"access_token":"oauth-access-secret"}',
        { status: 200 },
      ))
      .mockImplementationOnce((_url, init) => {
        observed.signal = init?.signal ?? null;
        return new Promise<Response>(() => undefined);
      });
    vi.stubGlobal("fetch", fetchMock);
    const authorization = await authorizePreparedEmail(prepared, AUTHORITY);
    fetchMock.mockClear();

    let outcome: unknown = "pending";
    void sendPreparedEmail(authorization).then(
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
      kind: "fatal",
      code: "GMAIL_DELIVERY_TRANSPORT_UNSETTLED",
    });
  });

  it("does not invoke the delivery callback for a pre-aborted signal", async () => {
    vi.spyOn(crypto, "randomUUID").mockReturnValue(BOUNDARY_UUID);
    const prepared = prepareEmail({
      to: "learner@example.test",
      template: "invitation",
      templateVersion: "1",
      variables: {},
    }, gmailPreparation());
    vi.stubEnv("GMAIL_CLIENT_ID", "client");
    vi.stubEnv("GMAIL_CLIENT_SECRET", "client-secret");
    vi.stubEnv("GMAIL_REFRESH_TOKEN", "refresh-secret");
    vi.stubEnv("GMAIL_REQUEST_TIMEOUT_MS", "1000");
    const externalAbort = new AbortController();
    externalAbort.abort();
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response('{"access_token":"oauth-access-secret"}', {
        status: 200,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const authorization = await authorizePreparedEmail(prepared, AUTHORITY);
    fetchMock.mockClear();

    const error = await sendPreparedEmail(
      authorization,
      { signal: externalAbort.signal },
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      "Gmail delivery request aborted.",
    );
    expect(classifyMailDeliveryError(error)).toEqual({
      kind: "ambiguous",
      code: "GMAIL_DELIVERY_AMBIGUOUS",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("drains an externally aborted Gmail fetch, discards its late success, and remains ambiguous", async () => {
    vi.useFakeTimers();
    vi.spyOn(crypto, "randomUUID").mockReturnValue(BOUNDARY_UUID);
    const prepared = prepareEmail({
      to: "learner@example.test",
      template: "invitation",
      templateVersion: "1",
      variables: {},
    }, gmailPreparation());
    vi.stubEnv("GMAIL_CLIENT_ID", "client");
    vi.stubEnv("GMAIL_CLIENT_SECRET", "client-secret");
    vi.stubEnv("GMAIL_REFRESH_TOKEN", "refresh-secret");
    vi.stubEnv("GMAIL_REQUEST_TIMEOUT_MS", "20000");
    const externalAbort = new AbortController();
    let resolveDelivery!: (response: Response) => void;
    const lateDelivery = new Promise<Response>((resolve) => {
      resolveDelivery = resolve;
    });
    const observed: { signal: AbortSignal | null } = { signal: null };
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(
        '{"access_token":"oauth-access-secret"}',
        { status: 200 },
      ))
      .mockImplementationOnce((_url, init) => {
        observed.signal = init?.signal ?? null;
        return lateDelivery;
      });
    vi.stubGlobal("fetch", fetchMock);
    const authorization = await authorizePreparedEmail(prepared, AUTHORITY);
    fetchMock.mockClear();

    let outcome: unknown = "pending";
    void sendPreparedEmail(
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
    const deletionAuthority: MailDispatchAuthority = Object.freeze({
      ...AUTHORITY,
      recipient: "privacy-canary@recipient.private.example",
      template: "account-deleted",
    });
    const prepared = prepareEmail({
      to: "privacy-canary@recipient.private.example",
      template: "account-deleted",
      templateVersion: "1",
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
      authority: deletionAuthority,
    });
    expect(prepared).toMatchObject({
      adapter: "console",
      bindingVersion: "console-json-v1",
      eventLine:
        '{"event":"email.console_delivery","template":"account-deleted"}',
      eventBytes:
        '{"event":"email.console_delivery","template":"account-deleted"}\n',
      requestBody:
        '{"event":"email.console_delivery","template":"account-deleted"}\n',
    });
    if (prepared.adapter !== "console") {
      throw new Error("Expected console preparation.");
    }
    expect(Object.isFrozen(prepared)).toBe(true);
    expect(preparedEmailBindingMatches(prepared, deletionAuthority)).toBe(true);
    vi.stubEnv("MAIL_ADAPTER", "gmail");
    const write = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    const expectedPayloadSha256 = createHash("sha256")
      .update(prepared.eventBytes, "utf8")
      .digest("hex");
    expect(prepared.bindingSha256).toBe(expectedPayloadSha256);
    const binding = dispatchBinding(prepared);
    expect(Object.isFrozen(binding)).toBe(true);
    expect(binding).toEqual({
      bindingVersion: "console-json-v1",
      bindingSha256: expectedPayloadSha256,
    });
    expect(prepared.eventLine).not.toMatch(/[\r\n]/);
    expect(prepared.eventBytes).toBe(`${prepared.eventLine}\n`);
    expect(prepared.eventBytes.endsWith("\n\n")).toBe(false);
    expect(prepared.authorityBindingVersion).toBe("prepared-authority-v1");
    expect(prepared.authorityBindingSha256).toMatch(/^[0-9a-f]{64}$/);
    const invalidDispatchBinding: DispatchBinding = {
      bindingVersion: prepared.bindingVersion,
      // @ts-expect-error Authority seals cannot authorize provider bytes.
      bindingSha256: prepared.authorityBindingSha256,
    };
    expect(invalidDispatchBinding.bindingSha256).not.toBe(
      binding.bindingSha256,
    );
    const authorization = await authorizePreparedEmail(
      prepared,
      deletionAuthority,
    );

    await expect(
      sendPreparedEmail(authorization),
    ).resolves.toEqual({
      providerId: `console-${BOUNDARY_UUID}`,
    });

    expect(randomUuid).toHaveBeenCalledOnce();
    expect(write).toHaveBeenCalledExactlyOnceWith(prepared.eventBytes);
    const emittedBytes = Buffer.concat(write.mock.calls.map(([chunk]) => (
      typeof chunk === "string"
        ? Buffer.from(chunk, "utf8")
        : Buffer.from(chunk)
    )));
    expect(emittedBytes).toEqual(Buffer.from(prepared.eventBytes, "utf8"));
    expect(emittedBytes.at(-1)).toBe(0x0a);
    const serialized = emittedBytes.toString("utf8");
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
