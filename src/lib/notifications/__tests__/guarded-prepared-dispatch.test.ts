import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { inspect } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

import * as publicGuardedDispatch from "../guarded-prepared-dispatch";
import * as publicMailer from "../mailer";
import {
  captureMailTransportConfiguration,
} from "../mailer-transport-internal";
import {
  createMaterializedDispatch,
  createStoreBoundPreparedDispatchChannel,
  materializedDispatchEnvelope,
  preparedDispatchStoreView,
  type MaterializedDispatch,
  type PreparedDispatchRuntimePlan,
} from "../prepared-dispatch-materialization";
import {
  FatalProviderTransportError,
  classifyMailDeliveryError,
  type CommittedPreparedDispatchReceipt,
} from "../provider-dispatch-contract";
import {
  dispatchEvidenceSha256,
  PROVIDER_EVIDENCE_VERSION,
} from "../dispatch-evidence";
import {
  outboxCorrelationToken,
  outboxMessageId,
  PROVIDER_CORRELATION_VERSION,
} from "../provider-correlation";
import { PostgresOutboxStore } from "../postgres-outbox-store";
import type { ProviderCallPermit } from "../outbox-worker";

const OPERATION_ID = "22222222-2222-4222-8222-222222222222";
const OUTBOX_ID = "11111111-1111-4111-8111-111111111111";
const RECIPIENT = "learner@example.test";
const RUNTIME_PLAN: PreparedDispatchRuntimePlan = Object.freeze({
  timeouts: Object.freeze({
    oauthDeadlineMs: 20_000,
    guardedSendDeadlineMs: 20_000,
    providerAbortSettlementMs: 5_000,
  }),
});

function startupConfiguration(adapter: "console" | "gmail") {
  if (adapter === "gmail") {
    vi.stubEnv("GMAIL_CLIENT_ID", "startup-client");
    vi.stubEnv("GMAIL_CLIENT_SECRET", "startup-client-secret");
    vi.stubEnv("GMAIL_REFRESH_TOKEN", "startup-refresh-secret");
  }
  return captureMailTransportConfiguration(adapter);
}

function materialize(
  adapter: "console" | "gmail",
  transportConfiguration = startupConfiguration(adapter),
  sequence = 2,
): MaterializedDispatch {
  const operationId = sequence === 2
    ? OPERATION_ID
    : "55555555-5555-4555-8555-555555555555";
  const outboxId = sequence === 2
    ? OUTBOX_ID
    : "66666666-6666-4666-8666-666666666666";
  return createMaterializedDispatch({
    source: {
      applicationUrl: "https://codestead.test",
      outboxId,
      operationId,
      claimToken: `claim-token-${sequence}`,
      claimOwner: "mail-worker:test",
      claimVersion: sequence,
      deliveryScopeKey: `a:learner-${sequence}`,
      recipient: sequence === 2 ? RECIPIENT : "other@example.test",
      template: "invitation",
      templateVersion: "1",
      variables: {
        name: "Learner",
        url: `https://codestead.test/invitations/${sequence}`,
      },
    },
    adapter,
    from: "Codestead <mail@codestead.test>",
    messageId: outboxMessageId(operationId),
    runtimePlan: RUNTIME_PLAN,
    transportConfiguration,
  });
}

type HarnessEntry = Readonly<{
  materialized: MaterializedDispatch;
  envelope: NonNullable<ReturnType<typeof materializedDispatchEnvelope>>;
  permit: ProviderCallPermit;
  receipt: CommittedPreparedDispatchReceipt;
  view: NonNullable<ReturnType<typeof preparedDispatchStoreView>>;
}>;

function channelHarness(
  materialized: readonly MaterializedDispatch[],
  runtimePlan: PreparedDispatchRuntimePlan = RUNTIME_PLAN,
) {
  const entries = materialized.map((item): HarnessEntry => {
    const envelope = materializedDispatchEnvelope(item);
    if (!envelope) throw new Error("Expected materialized envelope.");
    const view = preparedDispatchStoreView(envelope);
    if (!view) throw new Error("Expected prepared store view.");
    return Object.freeze({
      materialized: item,
      envelope,
      permit: Object.freeze({}) as ProviderCallPermit,
      receipt: Object.freeze({}) as CommittedPreparedDispatchReceipt,
      view,
    });
  });
  const activeReceipts = new Set(entries.map(({ receipt }) => receipt));
  let acceptedBinding: object | null = null;
  const store = new PostgresOutboxStore({
    connect: vi.fn(),
  } as never);
  Object.defineProperties(store, {
    acceptsPreparedDispatchChannelBinding: {
      configurable: true,
      value(binding: object) {
        return binding === acceptedBinding;
      },
    },
    consumeCommittedPreparedDispatchReceipt: {
      configurable: true,
      value(binding: object, receipt: CommittedPreparedDispatchReceipt) {
        if (binding !== acceptedBinding || !activeReceipts.delete(receipt)) {
          return null;
        }
        const entry = entries.find((candidate) => candidate.receipt === receipt);
        return entry
          ? Object.freeze({
              envelope: entry.envelope,
              permit: entry.permit,
              view: entry.view,
            })
          : null;
      },
    },
  });
  const channel = createStoreBoundPreparedDispatchChannel(store, runtimePlan);
  acceptedBinding = channel.binding;
  return { channel, entries, store };
}

function gmailFetch() {
  return vi.fn<typeof fetch>(async (url) => (
    String(url) === "https://oauth2.googleapis.com/token"
      ? new Response('{"access_token":"oauth-access-token"}', { status: 200 })
      : new Response('{"id":"gmail-provider-id"}', { status: 200 })
  ));
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("exact-byte prepared-dispatch wrapper", () => {
  it("keeps every public capability handle truly empty and removes raw preparation/auth/send exports", () => {
    const materialized = materialize("gmail");
    const envelope = materializedDispatchEnvelope(materialized)!;
    const view = preparedDispatchStoreView(envelope)!;

    for (const handle of [materialized, envelope, view]) {
      expect(Object.isFrozen(handle)).toBe(true);
      expect(Reflect.ownKeys(handle)).toEqual([]);
      expect(Object.getOwnPropertyDescriptors(handle)).toEqual({});
      expect({ ...handle }).toEqual({});
      expect(JSON.stringify(handle)).toBe("{}");
      expect(inspect(handle, { showHidden: true })).not.toContain(RECIPIENT);
      expect(inspect(handle, { showHidden: true })).not.toContain(OPERATION_ID);
    }
    expect(
      Reflect.ownKeys(publicMailer)
        .filter((key): key is string => typeof key === "string")
        .sort(),
    ).toEqual(["MailDeliveryError", "classifyMailDeliveryError"]);
    expect(JSON.stringify(publicMailer)).toBe("{}");
    for (const name of [
      "authorizeCommittedPreparedDispatch",
      "authorizePreparedEmail",
      "consumeMaterializedGmailPreparation",
      "createStoreBoundPreparedDispatchChannel",
      "dispatchBinding",
      "dispatchGuardedPrepared",
      "issueMaterializedGmailPreparation",
      "prepareEmail",
      "preparedEmailBindingMatches",
      "sendEmail",
      "sendPreparedEmail",
    ]) {
      expect(publicGuardedDispatch).not.toHaveProperty(name);
      expect(publicMailer).not.toHaveProperty(name);
    }
  });

  it("restricts the one-shot Gmail preparation capability to the trusted production importer", () => {
    const workspaceDirectory = process.cwd();
    const guardedNames = [
      "consumeMaterializedGmailPreparation",
      "issueMaterializedGmailPreparation",
    ];
    const pending = [
      join(workspaceDirectory, "scripts"),
      join(workspaceDirectory, "src"),
    ];
    const productionFiles: string[] = [];
    while (pending.length > 0) {
      const directory = pending.pop()!;
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== "__tests__") pending.push(path);
        } else if (
          entry.isFile()
          && /\.[cm]?[jt]s$/u.test(entry.name)
          && !/\.(?:spec|test|typecheck)\.[cm]?[jt]s$/u.test(entry.name)
        ) {
          productionFiles.push(path);
        }
      }
    }
    const productionImporters = productionFiles
      .filter((path) => !path.endsWith(
        join("notifications", "prepared-dispatch.ts"),
      ))
      .filter((path) => {
        const source = readFileSync(path, "utf8");
        return guardedNames.some((name) => source.includes(name));
      })
      .map((path) => relative(workspaceDirectory, path).replaceAll("\\", "/"))
      .sort();

    expect(productionImporters).toEqual([
      "src/lib/notifications/prepared-dispatch-materialization.ts",
    ]);
  });

  it("generates exactly one canonical random evidence header and binds its final bytes and digest", async () => {
    const fetchMock = gmailFetch();
    vi.stubGlobal("fetch", fetchMock);
    const { channel, entries } = channelHarness([materialize("gmail")]);
    const [entry] = entries;
    const inspection = channel.inspect(entry!.view)!;

    expect(inspection.binding.bindingVersion).toBe("gmail-raw-v1");
    expect(inspection.providerCorrelationVersion).toBe(
      PROVIDER_CORRELATION_VERSION,
    );
    expect(inspection.providerEvidenceVersion).toBe(
      PROVIDER_EVIDENCE_VERSION,
    );
    expect(inspection.providerEvidenceSha256).toMatch(/^[0-9a-f]{64}$/u);

    const guarded = await channel.authorize(entry!.receipt);
    expect(Reflect.ownKeys(guarded)).toEqual([]);
    expect(Object.getOwnPropertyDescriptors(guarded)).toEqual({});
    const result = await channel.dispatch(
      entry!.permit,
      guarded,
      new AbortController().signal,
    );
    expect(result).toEqual({
      kind: "sent",
      providerMessageId: "gmail-provider-id",
    });
    expect(Object.isFrozen(result)).toBe(true);

    const [, sendOptions] = fetchMock.mock.calls[1] as [string, RequestInit];
    const requestBody = String(sendOptions.body);
    const raw = (JSON.parse(requestBody) as { raw: string }).raw;
    const rfc822 = Buffer.from(raw, "base64url").toString("utf8");
    const evidenceHeaders = rfc822.split("\r\n").filter((line) => (
      /^x-codestead-dispatch-evidence:/iu.test(line)
    ));
    expect(evidenceHeaders).toHaveLength(1);
    const match = evidenceHeaders[0]!.match(
      /^X-Codestead-Dispatch-Evidence: v1\.([A-Za-z0-9_-]{43})$/u,
    );
    expect(match).not.toBeNull();
    const evidenceToken = match![1]!;
    expect(Buffer.from(evidenceToken, "base64url")).toHaveLength(32);
    expect(Buffer.from(evidenceToken, "base64url").toString("base64url"))
      .toBe(evidenceToken);
    expect(inspection.binding.bindingSha256).toBe(
      createHash("sha256").update(rfc822, "utf8").digest("hex"),
    );
    expect(inspection.providerEvidenceSha256).toBe(dispatchEvidenceSha256({
      operationId: OPERATION_ID,
      providerCorrelationVersion: PROVIDER_CORRELATION_VERSION,
      providerCorrelationToken: outboxCorrelationToken(OPERATION_ID),
      dispatchBindingVersion: "gmail-raw-v1",
      adapterPayloadSha256: inspection.binding.bindingSha256,
      providerEvidenceVersion: PROVIDER_EVIDENCE_VERSION,
      evidenceToken,
    }));
    expect(JSON.stringify({ materialized: entry!.materialized, inspection }))
      .not.toContain(evidenceToken);
  });

  it("keeps console evidence null and emits only its frozen safe event", async () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const { channel, entries } = channelHarness([materialize("console")]);
    const [entry] = entries;
    const inspection = channel.inspect(entry!.view)!;
    expect(inspection.binding.bindingVersion).toBe("console-json-v1");
    expect(inspection.providerEvidenceVersion).toBeNull();
    expect(inspection.providerEvidenceSha256).toBeNull();

    const guarded = await channel.authorize(entry!.receipt);
    await expect(channel.dispatch(
      entry!.permit,
      guarded,
      new AbortController().signal,
    )).resolves.toMatchObject({ kind: "sent" });
    expect(write).toHaveBeenCalledOnce();
    expect(String(write.mock.calls[0]![0])).toBe(
      '{"event":"email.console_delivery","template":"invitation"}\n',
    );
  });

  it("rejects fake, duplicate, invalid, and replayed channel authority before OAuth", async () => {
    expect(() => createStoreBoundPreparedDispatchChannel(
      {} as PostgresOutboxStore,
      RUNTIME_PLAN,
    )).toThrow("Prepared dispatch channel owner is invalid.");
    const fetchMock = gmailFetch();
    vi.stubGlobal("fetch", fetchMock);
    const { channel, entries, store } = channelHarness([materialize("gmail")]);
    expect(() => createStoreBoundPreparedDispatchChannel(
      store,
      RUNTIME_PLAN,
    )).toThrow("Prepared dispatch channel owner is invalid.");

    await expect(channel.authorize(
      Object.freeze({}) as CommittedPreparedDispatchReceipt,
    )).rejects.toThrow("Committed prepared dispatch receipt is invalid.");
    expect(fetchMock).not.toHaveBeenCalled();

    await channel.authorize(entries[0]!.receipt);
    expect(fetchMock).toHaveBeenCalledOnce();
    fetchMock.mockClear();
    await expect(channel.authorize(entries[0]!.receipt))
      .rejects.toThrow("Committed prepared dispatch receipt is invalid.");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("burns a committed receipt and envelope before OAuth on the first stop gate", async () => {
    const fetchMock = gmailFetch();
    vi.stubGlobal("fetch", fetchMock);
    const { channel, entries } = channelHarness([materialize("gmail")]);
    const [entry] = entries;

    expect(channel.discardReceipt(entry!.permit, entry!.receipt)).toBe(true);
    expect(channel.discardReceipt(entry!.permit, entry!.receipt)).toBe(false);
    await expect(channel.authorize(entry!.receipt))
      .rejects.toThrow("Committed prepared dispatch receipt is invalid.");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(preparedDispatchStoreView(entry!.envelope)).toBeNull();
  });
  it("binds every guard to the exact permit and burns it without send on stop", async () => {
    const configuration = startupConfiguration("gmail");
    const fetchMock = gmailFetch();
    vi.stubGlobal("fetch", fetchMock);
    const { channel, entries } = channelHarness([
      materialize("gmail", configuration, 2),
      materialize("gmail", configuration, 5),
    ]);
    const guardA = await channel.authorize(entries[0]!.receipt);
    const guardB = await channel.authorize(entries[1]!.receipt);
    fetchMock.mockClear();

    await expect(channel.dispatch(
      entries[1]!.permit,
      guardA,
      new AbortController().signal,
    )).rejects.toThrow("Guarded prepared dispatch is invalid or already used.");
    expect(fetchMock).not.toHaveBeenCalled();

    await expect(channel.dispatch(
      entries[0]!.permit,
      guardA,
      new AbortController().signal,
    )).resolves.toMatchObject({ kind: "sent" });
    expect(fetchMock).toHaveBeenCalledOnce();
    fetchMock.mockClear();

    expect(channel.discardGuard(entries[1]!.permit, guardB)).toBe(true);
    expect(channel.discardGuard(entries[1]!.permit, guardB)).toBe(false);
    await expect(channel.dispatch(
      entries[1]!.permit,
      guardB,
      new AbortController().signal,
    )).rejects.toThrow("Guarded prepared dispatch is invalid or already used.");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses startup-captured credentials after ambient environment mutation", async () => {
    vi.stubEnv("GMAIL_CLIENT_ID", "original-client");
    vi.stubEnv("GMAIL_CLIENT_SECRET", "original-secret");
    vi.stubEnv("GMAIL_REFRESH_TOKEN", "original-refresh");
    const configuration = captureMailTransportConfiguration("gmail");
    vi.stubEnv("GMAIL_CLIENT_ID", "attacker-client");
    vi.stubEnv("GMAIL_CLIENT_SECRET", "attacker-secret");
    vi.stubEnv("GMAIL_REFRESH_TOKEN", "attacker-refresh");
    const fetchMock = gmailFetch();
    vi.stubGlobal("fetch", fetchMock);
    const { channel, entries } = channelHarness([
      materialize("gmail", configuration),
    ]);

    await channel.authorize(entries[0]!.receipt);
    const [, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = String(options.body);
    expect(body).toContain("client_id=original-client");
    expect(body).toContain("client_secret=original-secret");
    expect(body).toContain("refresh_token=original-refresh");
    expect(body).not.toContain("attacker");
  });

  it.each([
    ["non-string", { id: 42 }],
    ["whitespace", { id: " gmail-id " }],
    ["blank", { id: "" }],
    ["oversize", { id: "x".repeat(513) }],
  ])("quarantines an invalid resolved provider result (%s)", async (
    _case,
    body,
  ) => {
    const fetchMock = vi.fn<typeof fetch>(async (url) => (
      String(url) === "https://oauth2.googleapis.com/token"
        ? new Response('{"access_token":"oauth-access-token"}', { status: 200 })
        : { ok: true, json: async () => body } as Response
    ));
    vi.stubGlobal("fetch", fetchMock);
    const { channel, entries } = channelHarness([materialize("gmail")]);
    const guarded = await channel.authorize(entries[0]!.receipt);
    await expect(channel.dispatch(
      entries[0]!.permit,
      guarded,
      new AbortController().signal,
    )).resolves.toEqual({
      kind: "quarantined",
      code: "PROVIDER_OUTCOME_INVALID",
    });
  });

  it("rejects a throwing provider-id accessor without invoking it", async () => {
    let reads = 0;
    const body = {};
    Object.defineProperty(body, "id", {
      enumerable: true,
      get() {
        reads += 1;
        throw new Error("recipient-and-raw-canary");
      },
    });
    const fetchMock = vi.fn<typeof fetch>(async (url) => (
      String(url) === "https://oauth2.googleapis.com/token"
        ? new Response('{"access_token":"oauth-access-token"}', { status: 200 })
        : { ok: true, json: async () => body } as Response
    ));
    vi.stubGlobal("fetch", fetchMock);
    const { channel, entries } = channelHarness([materialize("gmail")]);
    const guarded = await channel.authorize(entries[0]!.receipt);
    const outcome = await channel.dispatch(
      entries[0]!.permit,
      guarded,
      new AbortController().signal,
    );
    expect(outcome).toEqual({
      kind: "quarantined",
      code: "PROVIDER_OUTCOME_INVALID",
    });
    expect(reads).toBe(0);
    expect(inspect(outcome, { showHidden: true })).not.toContain("canary");
  });

  it("classifies generic settled rejection as UNKNOWN and preserves Fatal identity", async () => {
    const secretError = new Error(
      `${OPERATION_ID}:${RECIPIENT}:${Buffer.from(OPERATION_ID).toString("base64url")}`,
    );
    let sendFailure: unknown = secretError;
    const fetchMock = vi.fn<typeof fetch>(async (url) => {
      if (String(url) === "https://oauth2.googleapis.com/token") {
        return new Response('{"access_token":"oauth-access-token"}', { status: 200 });
      }
      throw sendFailure;
    });
    vi.stubGlobal("fetch", fetchMock);
    const first = channelHarness([materialize("gmail")]);
    const guarded = await first.channel.authorize(first.entries[0]!.receipt);
    const outcome = await first.channel.dispatch(
      first.entries[0]!.permit,
      guarded,
      new AbortController().signal,
    );
    expect(outcome).toEqual({
      kind: "quarantined",
      code: "PROVIDER_OUTCOME_UNKNOWN",
    });
    const exposed = `${JSON.stringify(outcome)}\n${inspect(outcome, { showHidden: true })}`;
    expect(exposed).not.toContain(OPERATION_ID);
    expect(exposed).not.toContain(RECIPIENT);

    const fatal = new FatalProviderTransportError("PROVIDER_TRANSPORT_FATAL");
    sendFailure = fatal;
    const second = channelHarness([materialize("gmail")]);
    const fatalGuard = await second.channel.authorize(second.entries[0]!.receipt);
    await expect(second.channel.dispatch(
      second.entries[0]!.permit,
      fatalGuard,
      new AbortController().signal,
    )).rejects.toBe(fatal);

    for (const spoof of [
      Object.create(FatalProviderTransportError.prototype),
      Object.assign(new Error("spoof"), {
        name: "FatalProviderTransportError",
      }),
    ]) {
      sendFailure = spoof;
      const spoofed = channelHarness([materialize("gmail")]);
      const spoofedGuard = await spoofed.channel.authorize(
        spoofed.entries[0]!.receipt,
      );
      await expect(spoofed.channel.dispatch(
        spoofed.entries[0]!.permit,
        spoofedGuard,
        new AbortController().signal,
      )).resolves.toEqual({
        kind: "quarantined",
        code: "PROVIDER_OUTCOME_UNKNOWN",
      });
    }
  });

  it("arms the OAuth timer before fetch and discards synchronous abort-listener success", async () => {
    vi.useFakeTimers();
    let timerWasArmed = false;
    const fetchMock = vi.fn<typeof fetch>((_url, init) => {
      timerWasArmed = vi.getTimerCount() > 0;
      return new Promise<Response>((resolve) => {
        init?.signal?.addEventListener("abort", () => {
          resolve(new Response('{"access_token":"late-token"}', { status: 200 }));
        }, { once: true });
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const { channel, entries } = channelHarness([materialize("gmail")]);
    let outcome: unknown = "pending";
    void channel.authorize(entries[0]!.receipt).then(
      (value) => { outcome = value; },
      (error: unknown) => { outcome = error; },
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(timerWasArmed).toBe(true);
    await vi.advanceTimersByTimeAsync(14_999);
    expect(outcome).toBe("pending");
    await vi.advanceTimersByTimeAsync(1);
    expect(outcome).toBeInstanceOf(Error);
    expect(classifyMailDeliveryError(outcome)).toEqual({
      kind: "definitely-rejected",
      code: "GMAIL_OAUTH_FAILED",
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("rejects synchronous invocation completion beyond the monotonic cutoff before timer delivery", async () => {
    let monotonicNow = 0;
    vi.spyOn(performance, "now").mockImplementation(() => monotonicNow);
    const fetchMock = vi.fn<typeof fetch>(() => {
      monotonicNow = 15_001;
      return Promise.resolve(new Response(
        '{"access_token":"over-deadline-token"}',
        { status: 200 },
      ));
    });
    vi.stubGlobal("fetch", fetchMock);
    const { channel, entries } = channelHarness([materialize("gmail")]);

    const error = await channel.authorize(entries[0]!.receipt)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(classifyMailDeliveryError(error)).toEqual({
      kind: "definitely-rejected",
      code: "GMAIL_OAUTH_FAILED",
    });
  });

  it("discards a delivery success resolved synchronously by external abort", async () => {
    const fetchMock = gmailFetch();
    vi.stubGlobal("fetch", fetchMock);
    const { channel, entries } = channelHarness([materialize("gmail")]);
    const guarded = await channel.authorize(entries[0]!.receipt);
    const externalAbort = new AbortController();
    fetchMock.mockImplementation((_url, init) => new Promise<Response>((resolve) => {
      init?.signal?.addEventListener("abort", () => {
        resolve(new Response('{"id":"must-not-be-accepted"}', { status: 200 }));
      }, { once: true });
    }));

    const delivery = channel.dispatch(
      entries[0]!.permit,
      guarded,
      externalAbort.signal,
    );
    externalAbort.abort();
    await expect(delivery).resolves.toEqual({
      kind: "quarantined",
      code: "GMAIL_DELIVERY_AMBIGUOUS",
    });
  });
});