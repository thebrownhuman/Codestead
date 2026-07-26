import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  MAIL_IDEMPOTENCY_AUTHORITY_VERSION,
  accountMailEventIdempotencyKey,
  systemMailEventIdempotencyKey,
} from "../idempotency-authority";

type GoldenVector = Readonly<{
  accountInput: Readonly<{
    eventId: string;
    template: "weekly-summary";
    userId: string;
  }>;
  authorityVersion: "event-v1-native";
  domain: "mail-event-v1";
  eventId: string;
  scope: string;
  separatorCodePoint: 31;
  sha256: string;
  template: "weekly-summary";
}>;

const golden = JSON.parse(
  readFileSync(
    resolve(
      process.cwd(),
      "infra",
      "tests",
      "fixtures",
      "mail-event-v1-golden-vector.json",
    ),
    "utf8",
  ),
) as GoldenVector;

describe("mail event idempotency authority", () => {
  it("matches the literal vector shared with the live SQL harness", () => {
    expect(golden.authorityVersion).toBe(MAIL_IDEMPOTENCY_AUTHORITY_VERSION);
    expect(golden.accountInput).toEqual({
      eventId: golden.eventId,
      template: golden.template,
      userId: golden.scope.slice(2),
    });
    expect(golden.separatorCodePoint).toBe(0x1f);
    expect(
      createHash("sha256")
        .update(
          [
            golden.domain,
            golden.template,
            golden.scope,
            golden.eventId,
          ].join(String.fromCodePoint(golden.separatorCodePoint)),
          "utf8",
        )
        .digest("hex"),
    ).toBe(golden.sha256);
    expect(accountMailEventIdempotencyKey(golden.accountInput)).toBe(
      golden.sha256,
    );
  });
  it.each([
    [
      "delimiter collision",
      "11111111-1111-4111-8111-111111111111:requester",
      "22222222-2222-4222-8222-222222222222",
    ],
    [
      "UUID case alias",
      "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA",
      "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    ],
  ])(
    "rejects noncanonical system identities (%s)",
    (_case, sourceId, audienceId) => {
      expect(() =>
        systemMailEventIdempotencyKey({
          eventId: "access-request-approved",
          producer: "access-request-approved",
          template: "invitation",
          sourceId,
          audienceId,
        }),
      ).toThrow("System source ID must be a canonical lowercase UUID.");
    },
  );

  it.each([
    [
      "delimiter collision",
      "22222222-2222-4222-8222-222222222222:admin",
    ],
    [
      "UUID case alias",
      "BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB",
    ],
  ])(
    "rejects noncanonical system audiences (%s)",
    (_case, audienceId) => {
      expect(() =>
        systemMailEventIdempotencyKey({
          eventId: "access-request-approved",
          producer: "access-request-approved",
          template: "invitation",
          sourceId: "11111111-1111-4111-8111-111111111111",
          audienceId,
        }),
      ).toThrow("System audience ID must be a canonical lowercase UUID.");
    },
  );

  it("rejects producers outside the fixed system producer domain", () => {
    const unregisteredProducer = "access-request-approved:forged";
    expect(() =>
      systemMailEventIdempotencyKey({
        eventId: "access-request-approved",
        producer: unregisteredProducer as "access-request-approved",
        template: "invitation",
        sourceId: "11111111-1111-4111-8111-111111111111",
        audienceId: "22222222-2222-4222-8222-222222222222",
      }),
    ).toThrow("System producer is not registered.");
  });
});
