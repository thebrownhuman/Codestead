import { describe, expect, it } from "vitest";

import {
  accountDeletionNoticeBinding,
  ACCOUNT_DELETION_NOTICE_TEMPLATE,
  ACCOUNT_DELETION_NOTICE_TEMPLATE_VERSION,
} from "../deletion-notice-capability";

const secret = "deletion-notice-test-secret-with-more-than-32-bytes";
const variables = {
  backupRetentionUntil: "2027-07-12T00:00:00.000Z",
  tombstoneId: "44444444-4444-4444-8444-444444444444",
  deletionRunId: "55555555-5555-4555-8555-555555555555",
};

describe("account deletion notice capability", () => {
  it("uses a normalized recipient HMAC and canonical payload digest", () => {
    const first = accountDeletionNoticeBinding({
      recipient: " LEARNER@Example.Test ",
      variables,
      secret,
    });
    const reordered = accountDeletionNoticeBinding({
      recipient: "learner@example.test",
      variables: {
        deletionRunId: variables.deletionRunId,
        tombstoneId: variables.tombstoneId,
        backupRetentionUntil: variables.backupRetentionUntil,
      },
      secret,
    });

    expect(first).toEqual(reordered);
    expect(first.recipientHmacSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(first.payloadSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(first.recipientHmacSha256).not.toContain("learner@example.test");
    const anotherTombstone = accountDeletionNoticeBinding({
      recipient: "learner@example.test",
      variables: { ...variables, tombstoneId: "77777777-7777-4777-8777-777777777777" },
      secret,
    });
    expect(anotherTombstone.recipientHmacSha256).not.toBe(first.recipientHmacSha256);
  });

  it("binds every rendered payload field and the template contract", () => {
    const baseline = accountDeletionNoticeBinding({ recipient: "learner@example.test", variables, secret });
    const changed = accountDeletionNoticeBinding({
      recipient: "learner@example.test",
      variables: { ...variables, deletionRunId: "66666666-6666-4666-8666-666666666666" },
      secret,
    });

    expect(changed.payloadSha256).not.toBe(baseline.payloadSha256);
    expect(ACCOUNT_DELETION_NOTICE_TEMPLATE).toBe("account-deleted");
    expect(ACCOUNT_DELETION_NOTICE_TEMPLATE_VERSION).toBe("1");
  });
});
