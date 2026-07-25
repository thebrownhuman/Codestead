import { inspect } from "node:util";

import { describe, expect, it } from "vitest";

import * as mailer from "../mailer";
import {
  FatalProviderTransportError,
  MailDeliveryError,
  classifyMailDeliveryError,
  fatalProviderTransportCode,
  isFatalProviderTransportError,
} from "../provider-dispatch-contract";

describe("public mailer contract", () => {
  it("exports only the fixed failure API and no raw preparation authority", () => {
    expect(
      Reflect.ownKeys(mailer)
        .filter((key): key is string => typeof key === "string")
        .sort(),
    ).toEqual([
      "MailDeliveryError",
      "classifyMailDeliveryError",
    ]);
    expect(JSON.stringify(mailer)).toBe("{}");
    for (const forbidden of [
      "authorizePreparedEmail",
      "captureMailTransportConfiguration",
      "dispatchBinding",
      "issueMaterializedGmailPreparation",
      "prepareEmail",
      "preparedEmailBindingMatches",
      "sendEmail",
      "sendPreparedEmail",
    ]) expect(mailer).not.toHaveProperty(forbidden);
  });

  it("uses fixed, non-enumerable delivery errors with canonical classifications", () => {
    const invalid = new MailDeliveryError("PROVIDER_OUTCOME_INVALID");
    expect(invalid.message).toBe("Mail provider operation failed.");
    expect(Object.keys(invalid)).toEqual([]);
    expect(Object.getOwnPropertyDescriptor(invalid, "name")?.enumerable)
      .toBe(false);
    expect(classifyMailDeliveryError(invalid)).toEqual({
      kind: "ambiguous",
      code: "PROVIDER_OUTCOME_INVALID",
    });
    expect(classifyMailDeliveryError(new Error("upstream-secret"))).toEqual({
      kind: "ambiguous",
      code: "PROVIDER_OUTCOME_UNKNOWN",
    });
  });

  it("never exposes upstream canaries through fixed delivery errors", () => {
    const canaries = [
      "22222222-2222-4222-8222-222222222222",
      "learner@example.test",
      "opaque-raw-payload-canary",
      "oauth-access-token-canary",
    ];
    const error = new MailDeliveryError("PROVIDER_OUTCOME_UNKNOWN");
    const exposed = `${JSON.stringify(error)}\n${inspect(error, {
      showHidden: true,
    })}`;
    for (const canary of canaries) expect(exposed).not.toContain(canary);
  });

  it("accepts only WeakMap-issued fatal errors, not name or prototype spoofs", () => {
    const fatal = new FatalProviderTransportError(
      "GMAIL_DELIVERY_TRANSPORT_UNSETTLED",
    );
    expect(fatal.message).toBe("Fatal provider transport failure.");
    expect(Object.keys(fatal)).toEqual([]);
    expect(isFatalProviderTransportError(fatal)).toBe(true);
    expect(fatalProviderTransportCode(fatal)).toBe(
      "GMAIL_DELIVERY_TRANSPORT_UNSETTLED",
    );

    const prototypeSpoof = Object.create(
      FatalProviderTransportError.prototype,
    ) as FatalProviderTransportError;
    const nameSpoof = Object.assign(new Error("spoof"), {
      name: "FatalProviderTransportError",
    });
    expect(isFatalProviderTransportError(prototypeSpoof)).toBe(false);
    expect(isFatalProviderTransportError(nameSpoof)).toBe(false);
  });
});
