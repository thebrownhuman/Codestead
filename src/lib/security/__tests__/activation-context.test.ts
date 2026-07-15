import { describe, expect, it } from "vitest";

import {
  currentActivationAuthorization,
  currentBootstrapAuthorization,
  runAuthorizedActivation,
  runAuthorizedBootstrap,
} from "../activation-context";

describe("invitation activation context", () => {
  it("is scoped to the authorized asynchronous signup operation", async () => {
    expect(currentActivationAuthorization()).toBeNull();
    const consumedAt = new Date("2029-12-31T23:00:00.000Z");
    await runAuthorizedActivation(
      { invitationId: "invite-1", email: " Learner@Example.COM ", consumedAt },
      async () => {
        await Promise.resolve();
        expect(currentActivationAuthorization()).toEqual({
          invitationId: "invite-1",
          email: "learner@example.com",
          consumedAt: consumedAt.toISOString(),
        });
      },
    );
    expect(currentActivationAuthorization()).toBeNull();
  });

  it("does not expose bootstrap authorization outside its operation", async () => {
    expect(currentBootstrapAuthorization()).toBeNull();
    await runAuthorizedBootstrap(" Admin@Example.com ", async () => {
      await Promise.resolve();
      expect(currentBootstrapAuthorization()).toBe("admin@example.com");
    });
    expect(currentBootstrapAuthorization()).toBeNull();
  });
});
