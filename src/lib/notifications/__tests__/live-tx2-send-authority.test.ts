import { afterEach, describe, expect, it, vi } from "vitest";

import {
  authorizePreparedEmail,
  captureMailTransportConfiguration,
  capturePreparedMailTransportPlan,
  discardPreparedEmailAuthorization,
  sendPreparedEmail,
} from "../mailer-transport-internal";
import { prepareEmail } from "../prepared-dispatch";
import {
  fatalProviderTransportCode,
  isFatalProviderTransportError,
} from "../provider-dispatch-contract";
import { outboxMessageId } from "../provider-correlation";
import type {
  MailDispatchAuthority,
  SourceAuthoritySha256,
} from "../prepared-dispatch";

const OPERATION_ID = "22222222-2222-4222-8222-222222222222";
const AUTHORITY: MailDispatchAuthority = Object.freeze({
  id: "11111111-1111-4111-8111-111111111111",
  operationId: OPERATION_ID,
  claimToken: "44444444-4444-4444-8444-444444444444",
  claimOwner: "mail-worker:test",
  claimVersion: 7,
  deliveryScopeKey: "a:learner-1",
  sourceAuthoritySha256: "a".repeat(64) as SourceAuthoritySha256,
  recipient: "learner@example.test",
  template: "invitation",
  templateVersion: "1",
});
const TRANSPORT_TIMING = Object.freeze({
  oauthDeadlineMs: 20_000,
  guardedSendDeadlineMs: 20_000,
  providerAbortSettlementMs: 5_000,
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("live TX2 physical-send authority", () => {
  it("rejects a forged live-TX2 seal before console output or authorization consumption", async () => {
    const prepared = prepareEmail(
      {
        to: AUTHORITY.recipient,
        template: AUTHORITY.template,
        templateVersion: AUTHORITY.templateVersion,
        variables: {
          name: "Learner",
          url: "https://example.test/invitations/2",
        },
      },
      {
        adapter: "console",
        from: "unused@example.test",
        messageId: outboxMessageId(OPERATION_ID),
        authority: AUTHORITY,
      },
    );
    const authorization = await authorizePreparedEmail(
      prepared,
      AUTHORITY,
      capturePreparedMailTransportPlan(
        "console",
        TRANSPORT_TIMING,
        captureMailTransportConfiguration("console"),
      ),
    );
    const write = vi.spyOn(process.stdout, "write");

    const error = await sendPreparedEmail(
      Object.freeze({}),
      Object.freeze({}),
      authorization,
    ).catch((caught: unknown) => caught);

    expect(isFatalProviderTransportError(error)).toBe(true);
    if (!isFatalProviderTransportError(error)) {
      throw new Error("Expected a fatal provider transport error.");
    }
    expect(fatalProviderTransportCode(error)).toBe("PROVIDER_TRANSPORT_FATAL");
    expect(write).not.toHaveBeenCalled();
    expect(discardPreparedEmailAuthorization(authorization)).toBe(true);
  });
});
