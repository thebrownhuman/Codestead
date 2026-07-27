import { createHash } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  classifyMailDeliveryError,
  MailDeliveryError,
  prepareEmail,
  type MailAdapter,
  type MailProviderContext,
  type PreparedEmail,
} from "../mailer";

const PROVIDER_CONTEXT: MailProviderContext = Object.freeze({
  operationId: "22222222-2222-4222-8222-222222222222",
  messageId:
    "<codestead.outbox.v1.okd-aMXCHPuS1pgnjdYfjG17CU5nfw-6stQE23enb8Q@mail.codestead.invalid>",
});

function context(adapter: MailAdapter) {
  return Object.freeze({ ...PROVIDER_CONTEXT, adapter });
}

describe("notification preparation boundary", () => {
  beforeEach(() => {
    vi.stubEnv("MAIL_FROM", "Codestead <noreply@example.com>");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("exports preparation and error classification but no physical sender", async () => {
    const publicMailer = await import("../mailer");

    expect(Object.keys(publicMailer).sort()).toEqual([
      "MailDeliveryError",
      "classifyMailDeliveryError",
      "prepareEmail",
    ]);
    expect(publicMailer).not.toHaveProperty("sendEmail");
    expect(publicMailer).not.toHaveProperty("sendPreparedEmail");
  });

  it("classifies explicit pre-send failures and unknown failures", () => {
    expect(
      classifyMailDeliveryError(
        new MailDeliveryError("rejected", {
          kind: "definitely-rejected",
          code: "MAIL_PRE_SEND_REJECTED",
        }),
      ),
    ).toEqual({
      kind: "definitely-rejected",
      code: "MAIL_PRE_SEND_REJECTED",
    });
    expect(classifyMailDeliveryError(new Error("unknown"))).toEqual({
      kind: "ambiguous",
      code: "PROVIDER_OUTCOME_AMBIGUOUS",
    });
  });

  it.each([
    "https://backup.test/dump.sql",
    "https://backup.test/archive.tar",
    "https://backup.test/x.zip",
  ])("refuses to prepare backup archive reference %s", (url) => {
    const error = (() => {
      try {
        prepareEmail(
          {
            to: "admin@example.com",
            template: "backup-status",
            variables: { url },
          },
          context("console"),
        );
      } catch (caught) {
        return caught;
      }
      return null;
    })();

    expect(error).toBeInstanceOf(MailDeliveryError);
    expect((error as Error).message).toBe(
      "Backup archives may not be emailed.",
    );
    expect(classifyMailDeliveryError(error)).toEqual({
      kind: "definitely-rejected",
      code: "MAIL_PRE_SEND_REJECTED",
    });
  });

  it.each(["999", "25001", "1000.5", "10s"])(
    "rejects invalid Gmail request deadline %s during preparation",
    (timeout) => {
      vi.stubEnv("GMAIL_REQUEST_TIMEOUT_MS", timeout);
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      expect(() =>
        prepareEmail(
          {
            to: "learner@example.com",
            template: "invitation",
            variables: {},
          },
          context("gmail"),
        ),
      ).toThrow(
        "GMAIL_REQUEST_TIMEOUT_MS must be an integer from 1000 to 25000.",
      );
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("rejects header injection during preparation without provider I/O", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    expect(() =>
      prepareEmail(
        {
          to: "learner@example.com\r\nBcc: attacker@example.com",
          template: "invitation",
          variables: { url: "https://example.test/activate" },
        },
        context("gmail"),
      ),
    ).toThrow("Invalid To header");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requires the exact deterministic correlation message ID", () => {
    expect(() =>
      prepareEmail(
        {
          to: "learner@example.com",
          template: "invitation",
          variables: {},
        },
        Object.freeze({
          ...PROVIDER_CONTEXT,
          adapter: "gmail" as const,
          messageId: "<forged@mail.codestead.invalid>",
        }),
      ),
    ).toThrow("Invalid Message-ID header.");
  });

  it("prepares immutable Gmail bytes and exact TX1 evidence without sending", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const prepared = prepareEmail(
      {
        to: "learner@example.com",
        template: "invitation",
        variables: { url: "https://example.test/activate?token=one-time" },
      },
      context("gmail"),
    );

    expect(Object.isFrozen(prepared)).toBe(true);
    expect(Object.isFrozen(prepared.providerDispatch)).toBe(true);
    expect(prepared.adapter).toBe("gmail");
    if (prepared.adapter !== "gmail") {
      throw new Error("Expected Gmail preparation.");
    }
    expect(prepared.providerDispatch).toMatchObject({
      adapter: "gmail",
      dispatchBindingVersion: "gmail-raw-v1",
      providerCorrelationVersion: "opaque-sha256-v1",
      providerEvidenceVersion: "gmail-header-evidence-v1",
    });
    expect(prepared.providerDispatch.dispatchBindingSha256).toBe(
      createHash("sha256").update(prepared.rfc822, "utf8").digest("hex"),
    );
    expect(prepared.requestBodySha256).toBe(
      createHash("sha256").update(prepared.requestBody, "utf8").digest("hex"),
    );
    expect(prepared.requestBodyLength).toBe(
      Buffer.byteLength(prepared.requestBody, "utf8"),
    );
    expect(prepared.rfc822).toContain(
      `X-Codestead-Dispatch-Evidence: v1.${prepared.evidenceToken}`,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("freezes one exact UTF-8 provider request body for every adapter", () => {
    const preparedByAdapter: readonly PreparedEmail[] = [
      prepareEmail(
        {
          to: "learner@example.com",
          template: "invitation",
          variables: {
            name: "Asha \u{1F9EA}",
            url: "https://example.test/activate",
          },
        },
        context("gmail"),
      ),
      prepareEmail(
        {
          to: "learner@example.com",
          template: "invitation",
          variables: {
            name: "Asha \u{1F9EA}",
            url: "https://example.test/activate",
          },
        },
        context("console"),
      ),
    ];

    for (const prepared of preparedByAdapter) {
      expect(prepared.requestBodySha256).toBe(
        createHash("sha256").update(prepared.requestBody, "utf8").digest("hex"),
      );
      expect(prepared.requestBodyLength).toBe(
        Buffer.byteLength(prepared.requestBody, "utf8"),
      );
    }
    const consolePrepared = preparedByAdapter[1];
    expect(consolePrepared?.adapter).toBe("console");
    if (consolePrepared?.adapter !== "console") {
      throw new Error("Expected console preparation.");
    }
    expect(consolePrepared.requestBody).toBe(consolePrepared.eventBytes);
  });
});
