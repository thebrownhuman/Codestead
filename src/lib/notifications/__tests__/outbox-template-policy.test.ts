import { beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const execute = vi.fn(async (_statement: unknown) => {
    void _statement;
  });
  const values = vi.fn((_row: unknown) => {
    void _row;
  });
  return { execute, values };
});

vi.mock("@/lib/db/client", () => ({ db: { execute: mocks.execute } }));

import {
  enqueueEmail,
  type AccountEmailTemplate,
  type EnqueueEmailInput,
} from "../outbox";
import { capturedOutboxRow } from "./outbox-sql-test-support";

describe("generic outbox template policy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.execute.mockImplementation(async (statement) => {
      mocks.values(capturedOutboxRow(statement));
    });
  });

  it("does not type specialized inactivity templates as generic account mail", () => {
    expectTypeOf<"inactivity-reminder">().not.toMatchTypeOf<AccountEmailTemplate>();
    expectTypeOf<"inactivity-reminder-followup">().not.toMatchTypeOf<AccountEmailTemplate>();
    expectTypeOf<"inactivity-admin-notice">().not.toMatchTypeOf<AccountEmailTemplate>();
  });

  it.each([
    "inactivity-reminder",
    "inactivity-reminder-followup",
    "inactivity-admin-notice",
  ] as const)("rejects a runtime-bypassed specialized %s enqueue", async (template) => {
    const bypassedInput = {
      to: "learner@example.test",
      template,
      variables: {},
      userId: "learner-1",
      idempotencySeed: "unsafe-generic-inactivity",
    } as unknown as EnqueueEmailInput;

    await expect(enqueueEmail(bypassedInput)).rejects.toThrow(
      "requires its specialized producer",
    );
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("derives the exact reviewed version instead of relying on a writer literal", async () => {
    await enqueueEmail({
      to: "learner@example.test",
      template: "credential-changed",
      variables: {},
      userId: "learner-1",
      idempotencySeed: "credential-change-1",
    });

    expect(mocks.values).toHaveBeenCalledWith(
      expect.objectContaining({ templateVersion: "1" }),
    );
  });
});
